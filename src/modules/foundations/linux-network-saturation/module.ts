import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TCP_LOSS_FACTOR = 1.22;
const MSS_BITS_MBPS = (1_460 * 8) / 1_000_000;

const params = [
  {
    id: "offeredMbps",
    label: "Offered load",
    min: 10,
    max: 10_000,
    step: 10,
    value: 600,
    unit: " Mbps",
    group: "Traffic",
    help: "Traffic the application wants to send before the path limits it.",
    format: "number" as const,
  },
  {
    id: "linkMbps",
    label: "Link capacity",
    min: 100,
    max: 10_000,
    step: 100,
    value: 1_000,
    unit: " Mbps",
    group: "Path",
    help: "Provisioned bandwidth of the bottleneck link.",
    format: "number" as const,
  },
  {
    id: "lossPercent",
    label: "Packet loss",
    min: 0,
    max: 10,
    step: 0.1,
    value: 0.1,
    unit: "%",
    group: "Path",
    help: "Packets dropped somewhere on the path. TCP treats loss as congestion and reduces its sending rate.",
    format: "percent" as const,
  },
  {
    id: "rttMs",
    label: "Round-trip time",
    min: 1,
    max: 200,
    step: 1,
    value: 30,
    unit: "ms",
    group: "Path",
    help: "Propagation and queueing delay. Longer RTT slows congestion-window growth and recovery.",
    format: "ms" as const,
  },
  {
    id: "nicDrainMbps",
    label: "NIC drain capacity",
    min: 100,
    max: 10_000,
    step: 100,
    value: 1_000,
    unit: " Mbps",
    group: "Host",
    help: "Rate the host NIC and its queues can drain. Below this, packets drop at the NIC even when the link has spare capacity.",
    format: "number" as const,
  },
  {
    id: "flows",
    label: "Concurrent TCP flows",
    min: 1,
    max: 256,
    step: 1,
    value: 80,
    unit: "",
    group: "Traffic",
    help: "Flows sharing the path. TCP congestion control is per flow; aggregate capacity is the per-flow estimate times this count.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  offered: number;
  link: number;
  lossPercent: number;
  rtt: number;
  nicDrain: number;
  flows: number;
  perFlowCap: number;
  tcpCap: number;
  achievable: number;
  retransPct: number;
  sendTraffic: number;
  carried: number;
  util: number;
  nicDropPct: number;
  linkOverflowPct: number;
  goodput: number;
  goodputLoss: number;
  p99: number;
}

function compute(p: Params): Computed {
  const offered = Math.max(1, num(p, "offeredMbps", 600));
  const link = Math.max(1, num(p, "linkMbps", 1_000));
  const lossPercent = clamp(num(p, "lossPercent", 0.1), 0, 10);
  const rtt = Math.max(1, num(p, "rttMs", 30));
  const nicDrain = Math.max(1, num(p, "nicDrainMbps", 1_000));
  const flows = Math.max(1, Math.round(num(p, "flows", 80)));
  const loss = lossPercent / 100;
  const perFlowCap =
    loss <= 0.0001
      ? Math.min(link, link / flows)
      : Math.min(link, (TCP_LOSS_FACTOR * MSS_BITS_MBPS) / (rtt / 1_000) / Math.sqrt(loss));
  const tcpCap = perFlowCap * flows;
  const achievable = Math.min(offered, tcpCap);
  let retransPct = Math.min(30, lossPercent * 1.5);
  let nicInput = achievable * (1 + retransPct / 100);
  let nicDropPct = Math.max(0, (nicInput - nicDrain) / Math.max(1, nicInput)) * 100;
  let pathInput = nicInput * (1 - nicDropPct / 100);
  let linkOverflowPct = Math.max(0, (pathInput - link) / Math.max(1, pathInput)) * 100;
  retransPct = Math.min(30, lossPercent * 1.5 + nicDropPct * 0.5 + linkOverflowPct * 0.5);
  nicInput = achievable * (1 + retransPct / 100);
  nicDropPct = Math.max(0, (nicInput - nicDrain) / Math.max(1, nicInput)) * 100;
  pathInput = nicInput * (1 - nicDropPct / 100);
  linkOverflowPct = Math.max(0, (pathInput - link) / Math.max(1, pathInput)) * 100;
  const carried = Math.min(link, pathInput);
  const util = (carried / link) * 100;
  const goodput = Math.min(carried, achievable) * (1 - nicDropPct / 200);
  const goodputLoss = Math.max(0, ((offered - goodput) / offered) * 100);
  const p99 =
    rtt +
    (25 * (util / 100) ** 4) / Math.max(0.02, 1 - util / 100) +
    300 * Math.min(1, lossPercent / 2) +
    nicDropPct * 5 +
    linkOverflowPct * 5;
  return {
    offered,
    link,
    lossPercent,
    rtt,
    nicDrain,
    flows,
    perFlowCap,
    tcpCap,
    achievable,
    retransPct,
    sendTraffic: nicInput,
    carried,
    util,
    nicDropPct,
    linkOverflowPct,
    goodput,
    goodputLoss,
    p99: Math.min(5_000, p99),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.6);
  const seeds: [string, number, number][] = [
    ["goodput-loss", values.goodputLoss, 0.2],
    ["retransmit-rate", values.retransPct, 0.05],
    ["read-p99", values.p99, 0.4],
    ["link-util", values.util, 0.3],
    ["packet-loss", values.lossPercent, 0.02],
    ["nic-drops", values.nicDropPct, 0.02],
    ["link-overflow", values.linkOverflowPct, 0.02],
    ["goodput", values.goodput, 2],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const linkHealth = healthFor(values.util, 80, 95);
  const dropHealth = healthFor(values.nicDropPct, 0.1, 1);
  const latencyHealth = healthFor(values.p99, 100, 300);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: `${values.offered.toFixed(0)} Mbps offered`,
        meta: { view: "flow" },
      },
      {
        id: "nic",
        label: "Host NIC",
        kind: "service",
        health: dropHealth,
        utilization: clamp(values.sendTraffic / values.nicDrain),
        sublabel: `${values.nicDropPct.toFixed(2)}% drain drops`,
        detail: `NIC drain capacity ${values.nicDrain.toFixed(0)} Mbps. Incoming ${values.sendTraffic.toFixed(0)} Mbps, so ${values.nicDropPct.toFixed(2)}% drops here.`,
        meta: { view: "flow" },
      },
      {
        id: "path",
        label: "Bottleneck link",
        kind: "external",
        health: values.lossPercent >= 2 ? "crit" : linkHealth,
        utilization: clamp(values.util / 100),
        sublabel: `${values.link.toFixed(0)} Mbps, ${values.lossPercent.toFixed(1)}% loss`,
        detail: `Carried ${values.carried.toFixed(0)} Mbps, goodput ${values.goodput.toFixed(0)} Mbps, retransmits ${values.retransPct.toFixed(1)}%, link overflow ${values.linkOverflowPct.toFixed(2)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service",
        kind: "service",
        health: latencyHealth,
        utilization: clamp(values.goodput / values.link),
        sublabel: `${values.goodput.toFixed(0)} Mbps goodput`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-nic", "client", "nic", clamp(values.sendTraffic / values.nicDrain), dropHealth),
      edge("nic-path", "nic", "path", clamp(values.util / 100), linkHealth),
      edge("path-service", "path", "service", clamp(values.goodput / values.link), latencyHealth),
    ],
    metrics: [
      metric("goodput-loss", "Goodput loss", values.goodputLoss, "%", 20, 50, "percent"),
      metric("retransmit-rate", "Retransmit rate", values.retransPct, "%", 1, 3, "percent"),
      metric("read-p99", "Request p99", values.p99, "ms", 100, 300, "ms"),
      metric("link-util", "Link utilization", values.util, "%", 80, 95, "percent"),
      metric("packet-loss", "Packet loss", values.lossPercent, "%", 0.5, 2, "percent"),
      metric("nic-drops", "NIC drain drops", values.nicDropPct, "%", 0.1, 1, "percent"),
      metric("link-overflow", "Link overflow drops", values.linkOverflowPct, "%", undefined, undefined, "percent"),
      metric("goodput", "Goodput", values.goodput, " Mbps", undefined, undefined, "number"),
      metric("tcp-cap", "TCP aggregate estimate", values.tcpCap, " Mbps", undefined, undefined, "number"),
      metric("per-flow-cap", "Per-flow TCP estimate", values.perFlowCap, " Mbps", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.goodput.toFixed(0)} Mbps goodput of ${values.offered.toFixed(0)} offered; link ${values.util.toFixed(0)}%; NIC drain drops ${values.nicDropPct.toFixed(2)}%; retransmits ${values.retransPct.toFixed(1)}%; p99 ${values.p99.toFixed(0)}ms.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "goodput-loss",
    metricId: "goodput-loss",
    warn: 20,
    crit: 50,
    title: "Goodput is collapsing below the offered load",
    cause:
      "The path cannot carry the offered traffic. The cause may be a full link, packet loss that forces TCP to reduce its congestion window, or NIC drain drops that trigger the same response.",
    fix: "Check link utilization, loss, NIC drain drops, and link overflow in that order. If the link has spare capacity but loss is high, adding bandwidth will not help; fix the lossy path or the NIC drain rate.",
    checkFirst: [
      "Compare offered load with link utilization and goodput.",
      "Check retransmits and packet loss separately.",
      "Check whether the bottleneck is a single flow or all traffic.",
    ],
  },
  {
    id: "retransmit-rate",
    metricId: "retransmit-rate",
    warn: 1,
    crit: 3,
    title: "TCP is retransmitting a large share of segments",
    cause:
      "Packets are being lost or the receiver is not acknowledging them. Retransmissions consume capacity and signal congestion to TCP, which lowers the sending rate.",
    fix: "Find where the loss occurs: NIC drain, path, or receiver. Check NIC drain drops, link overflow, interface errors, and `ss -ti` retransmit counters. A lossy path needs loss remediation, not a bigger pipe.",
    checkFirst: [
      "Check `netstat -s` and `ss -ti` for retransmits and timeouts.",
      "Check NIC drain drops and errors with `ethtool -S`.",
      "Check whether one path, source, or flow dominates the loss.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 100,
    crit: 300,
    title: "Network latency is above the request SLO",
    cause:
      "Queueing at the bottleneck, retransmission timeouts, or a long RTT adds to every request. Loss costs more than the lost packet because TCP waits for a timeout or recovery.",
    fix: "Reduce queueing and loss before tuning application timeouts. Check RTT, retransmits, and link utilization together.",
    checkFirst: [
      "Check RTT and retransmits per connection with `ss -ti`.",
      "Check link utilization, link overflow drops, and NIC drain drops.",
      "Check whether the latency is one-way or round-trip.",
    ],
  },
  {
    id: "link-util",
    metricId: "link-util",
    warn: 80,
    crit: 95,
    title: "The link is close to its bandwidth limit",
    cause:
      "Traffic is arriving faster than the bottleneck link can serialize it. Queueing delay rises, and packets may be dropped when the link queue overflows.",
    fix: "Add bandwidth, shape or prioritize traffic, or move bulk transfers off the link. Confirm that the link is the bottleneck before adding capacity.",
    checkFirst: [
      "Compare utilization on both directions and at each hop.",
      "Check link overflow drops and backlog with `tc -s qdisc`.",
      "Check whether a bulk transfer started recently.",
    ],
  },
  {
    id: "packet-loss",
    metricId: "packet-loss",
    warn: 0.5,
    crit: 2,
    title: "Packet loss is above the path budget",
    cause:
      "Loss can come from congestion, a faulty link, a policer, or a saturated receive queue. TCP cannot distinguish these causes; it only sees missing acknowledgements.",
    fix: "Localize the loss before changing capacity. Check interface errors, policer counters, and per-hop drops. A clean link with high loss points to a queue or a policer, not bandwidth.",
    checkFirst: [
      "Check NIC errors and drain drops at both ends.",
      "Check policer and qdisc statistics.",
      "Check whether loss is bursty or steady.",
    ],
  },
  {
    id: "link-overflow",
    metricId: "link-overflow",
    warn: 0.1,
    crit: 1,
    title: "The bottleneck link is overflowing",
    cause:
      "Offered traffic plus retransmits exceeds the rate the link can serialize. The link queue overflows and drops packets, which TCP then treats as congestion.",
    fix: "Add bandwidth, shape or prioritize traffic, or reduce demand. This is distinct from NIC drain drops, which occur on the host even when the link has spare capacity.",
    checkFirst: [
      "Compare offered load plus retransmits with link capacity.",
      "Check link overflow drops and backlog with `tc -s qdisc`.",
      "Check whether one bulk flow or all traffic is filling the link.",
    ],
  },
  {
    id: "nic-drops",
    metricId: "nic-drops",
    warn: 0.1,
    crit: 1,
    title: "The NIC drain path is dropping packets",
    cause:
      "The host NIC and its queues cannot drain packets as fast as they arrive. This can happen below the link's nominal rate when interrupts, CPU affinity, queue count, or the configured drain capacity is too low.",
    fix: "Check NIC drain capacity, queue size, RSS/RPS distribution, and CPU pressure on the receive path. A larger queue can absorb bursts but adds latency; fix the drain rate first.",
    checkFirst: [
      "Check the NIC drain capacity and `ethtool -S` dropped and missed counters.",
      "Check `/proc/net/dev` drops per interface.",
      "Check whether one CPU or queue is handling most of the traffic.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const linuxNetworkSaturationModel: SimModel = {
  id: "foundations-linux-network-saturation",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    }
    const jitter = rng.between(-0.05, 0.05);
    next.metrics = next.metrics.map((item) =>
      item.id === "read-p99" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.retransPct >= 3 && frame.flags.lossEvent !== 1) {
      pushEvent(next, {
        id: "lossy-path",
        at: frame.t,
        severity: "crit",
        title: "Loss is capping TCP below the link rate",
        detail: `${values.lossPercent.toFixed(1)}% loss and ${values.retransPct.toFixed(1)}% retransmits hold goodput to ${values.goodput.toFixed(0)} Mbps while the link is only ${values.util.toFixed(0)}% utilized. The path has spare bandwidth and too much loss.`,
        nodeId: "path",
        metricId: "retransmit-rate",
      });
      next.flags.lossEvent = 1;
    }
    if (values.retransPct < 1) next.flags.lossEvent = 0;
    next.flags.paramsKey = key;
    next.summary = `${values.goodput.toFixed(0)} Mbps goodput of ${values.offered.toFixed(0)} offered; link ${values.util.toFixed(0)}%; NIC drain drops ${values.nicDropPct.toFixed(2)}%; retransmits ${values.retransPct.toFixed(1)}%; p99 ${values.p99.toFixed(0)}ms.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The link carries ${values.carried.toFixed(0)} of ${values.link.toFixed(0)} Mbps (${values.util.toFixed(0)}%), but goodput is only ${values.goodput.toFixed(0)} Mbps. Utilization alone does not explain the gap.`,
      `Packet loss is ${values.lossPercent.toFixed(1)}% and retransmits are ${values.retransPct.toFixed(1)}%. TCP reduces its congestion window on loss, so a lossy path can be slow while bandwidth is idle.`,
      `NIC drain drops are ${values.nicDropPct.toFixed(2)}%; link overflow drops are ${values.linkOverflowPct.toFixed(2)}%. Loss is the end-to-end symptom, so check both host drain and link capacity.`,
      `The TCP estimate is ${values.perFlowCap.toFixed(2)} Mbps per flow across ${values.flows} flows (${values.tcpCap.toFixed(0)} Mbps aggregate) at ${values.rtt.toFixed(0)}ms RTT. A larger pipe does not raise per-flow capacity; loss and RTT do.`,
    ];
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A lightly loaded link with a clean path.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The link is busy but not full; latency is starting to climb.",
    tone: "warn",
    params: defaults({ offeredMbps: 850, linkMbps: 1_000, lossPercent: 0.2, rttMs: 30 }),
  },
  {
    id: "failure",
    label: "Lossy path",
    description: "3% loss caps TCP at a fraction of the link while bandwidth sits idle.",
    tone: "crit",
    params: defaults({ offeredMbps: 900, linkMbps: 1_000, lossPercent: 3, rttMs: 40 }),
  },
  {
    id: "recovery",
    label: "Clean path",
    description: "Loss and RTT fall; goodput returns to the offered load.",
    tone: "ok",
    params: defaults({ offeredMbps: 500, linkMbps: 1_000, lossPercent: 0.05, rttMs: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-network-cause",
  title: "Predict why goodput is low with a quiet link",
  simId: "linux-network",
  question:
    "A service offers 900 Mbps on a 1 Gbps link. Goodput is about 165 Mbps, link utilization is about 17%, and NIC drain drops are zero. What explains the gap?",
  prediction: {
    options: [
      { id: "link", label: "The link is saturated and needs more bandwidth" },
      { id: "loss", label: "Packet loss and RTT are limiting TCP's congestion window" },
      { id: "drops", label: "NIC drain drops are discarding the traffic" },
      { id: "dns", label: "DNS resolution is slow" },
    ],
    correctOptionId: "loss",
    explanation:
      "The link has spare capacity and NIC drain drops are zero, so bandwidth is not the limit. At 3% loss and a 40ms RTT, the per-flow TCP estimate is about 2.1 Mbps; across 80 flows that is about 165 Mbps aggregate. TCP repeatedly reduces each congestion window and cannot fill the pipe. The retransmit rate and loss counters explain the gap; a bigger link would not change the per-flow congestion-window math.",
  },
  setup: defaults({ offeredMbps: 900, linkMbps: 1_000, lossPercent: 3, rttMs: 40 }),
  runFor: 20,
  observe: [
    "Link utilization stays near 17% while retransmits and packet loss are high.",
    "Goodput is about 165 Mbps, a small fraction of the 900 Mbps offered.",
    "NIC drain drops remain near zero; the loss is on the path, not the host queue.",
    "Lowering loss restores goodput without adding bandwidth.",
  ],
  explain:
    "TCP treats packet loss as a congestion signal and reduces each flow's congestion window. Recovery takes round trips, so per-flow throughput is sensitive to both loss and RTT; aggregate throughput is roughly per-flow capacity times the number of flows. A path can therefore be slow while the link is mostly idle. Check loss and retransmits before concluding that the pipe is full; check NIC drain drops separately to see whether the host queue is the source.",
  fix: defaults({ offeredMbps: 700, linkMbps: 1_000, lossPercent: 0.05, rttMs: 40 }),
  debrief:
    "Reducing loss restores goodput while the link remains the same size. The residual latency comes from RTT and moderate utilization, not retransmission timeouts. In production, the fix would be to localize the loss: interface errors, a policer, a congested queue, or a faulty path. Adding bandwidth would have spent money without touching the per-flow congestion-window math.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Network saturation has several distinct shapes. A full pipe is bandwidth-bound: the link is carrying near its capacity, queues build, and latency rises. A lossy path is different: packets are dropped somewhere, TCP reduces its congestion window, and goodput falls even though the link has spare capacity. NIC drain drops are a third shape: the host cannot move packets into or out of its queues fast enough, often because of CPU affinity, interrupt distribution, or a drain rate below the arrival rate. Link overflow drops are a fourth: the offered rate plus retransmits exceeds what the link can serialize.",
  },
  {
    type: "p",
    text: "TCP uses loss as a congestion signal. When a segment is not acknowledged, the sender retransmits and reduces its sending rate, then grows the window again over subsequent round trips. Congestion control is per flow, so aggregate throughput is roughly per-flow capacity times the number of flows. The result is that throughput depends on loss, RTT, and flow count, not only on the nominal link rate. A 1 Gbps link with high loss can deliver a small fraction of that rate while remaining mostly idle.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "What it does", "Pressure signal"],
    rows: [
      ["Application socket", "Queues bytes for TCP", "Send buffer and application write rate"],
      ["TCP", "Adjusts the congestion window on loss and RTT", "Retransmits and RTT"],
      ["NIC queue", "Drains packets from the host", "NIC drain drops, missed packets, and CPU pressure"],
      ["Bottleneck link", "Serializes packets at the path rate", "Link utilization, loss, and queueing delay"],
    ],
  },
  {
    type: "p",
    text: "The path is application socket, TCP send buffer, NIC transmit queue, bottleneck link, and the receiver. The bottleneck may be a router, a policer, a wireless link, or the receiver's queue. TCP sees only acknowledgements and timeouts, so it cannot tell a congested link from a faulty cable. That is why the operator must check loss, retransmits, NIC drain drops, and link overflow drops separately.",
  },
  {
    type: "p",
    text: "This model is illustrative. The TCP estimate uses the common square-root approximation with a teaching constant, MSS bits, RTT, loss, and an explicit flow count; it is a per-flow estimate multiplied by the flow count, not a protocol simulator. Queueing and timeout penalties are simplified. The lesson is the direction of the effects: loss and RTT reduce per-flow throughput, link utilization shows whether bandwidth is the limit, and NIC drain drops show whether the host queue is the source.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Goodput and goodput loss: useful bytes delivered versus what the application offered.",
      "Link utilization: whether the bottleneck is actually full.",
      "Packet loss and retransmit rate: whether TCP is backing off.",
      "NIC drain drops and link overflow drops: whether the host queue or the link is the problem.",
      "Request p99: the latency consequence of queueing and retransmission timeouts.",
    ],
  },
  {
    type: "table",
    headers: ["Signal", "Likely cause", "First fix to consider"],
    rows: [
      ["Link utilization near 100%", "Bandwidth-bound path", "Add bandwidth or move bulk traffic"],
      ["Loss high, utilization low", "Lossy path or policer", "Localize and fix the loss"],
      ["NIC drain drops high, link idle", "Host queue or CPU drain", "Fix RSS, queue size, drain rate, or CPU pressure"],
      ["Link overflow drops high", "Offered rate exceeds link capacity", "Add bandwidth, shape, or reduce demand"],
      ["Retransmits high, loss low", "Receiver or ACK path", "Check both directions and the peer"],
      ["p99 high, utilization moderate", "Queueing or bufferbloat", "Reduce queue or shape traffic"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Raise offered load until the link is busy, then add packet loss without changing the link. Compare link utilization with goodput and retransmits. Apply Lossy path and watch the link stay quiet while goodput collapses. Lower NIC drain capacity separately to see host-side drops at low link utilization. Then clean the path and confirm that goodput returns without more bandwidth.",
  },
  { type: "sim", simId: "linux-network" },
  { type: "experiment", experimentId: "predict-network-cause" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The offered load was below the link rate, but TCP could not fill the link because packets were being lost. Each loss reduced the congestion window, and recovery took round trips. Goodput fell to about 165 Mbps while utilization stayed near 17%. NIC drain drops were zero; the loss was on the path.",
  },
  {
    type: "p",
    text: "Cleaning the path restored goodput without changing the link capacity. That is the difference between a full pipe and a lossy path: the full pipe needs more bandwidth or less demand, while the lossy path needs the loss localized and removed. NIC drain drops would have pointed at the host queue; link overflow drops would have pointed at the link.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`ss -ti` per connection: retransmits, RTT, congestion window, and bytes in flight.",
      "`netstat -s` or `nstat`: retransmitted segments, timeouts, and out-of-order packets.",
      "`/proc/net/dev` and `ethtool -S`: interface drops, missed packets, and errors.",
      "`tc -s qdisc`: backlog, drops, and overlimits on the bottleneck queue.",
      "Cloud or network metrics: link utilization, packet loss, and per-path latency.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare link utilization with goodput. If utilization is high, the pipe is full. If utilization is low and loss or retransmits are high, the path is lossy. If NIC drain drops are high while the link is idle, the host queue or drain path is the problem; link overflow drops point at the link itself.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Establish whether the bottleneck is bandwidth, loss, or the host queue.",
      "For a full link, add capacity, shape bulk traffic, or reduce demand.",
      "For a lossy path, localize the loss by hop or direction before changing capacity.",
      "For NIC drain drops, check RSS/RPS, queue size, drain capacity, interrupt affinity, and CPU pressure. For link overflow drops, add bandwidth or shape traffic.",
      "Re-test goodput, retransmits, and p99 together; a bandwidth increase that leaves loss in place is not a fix.",
      "Record the path and the failure mode for the next incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More bandwidth fixes a full pipe and wastes money on a lossy path.",
      "A larger NIC queue absorbs bursts and increases latency for every packet behind the burst.",
      "Aggressive retransmission can improve recovery and add load to an already congested path.",
      "Traffic shaping protects latency-sensitive traffic and can reduce total throughput.",
      "Loss remediation may be outside your infrastructure; the fallback is to route around the bad path or reduce sensitivity to it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "full-vs-lossy",
    question:
      "Throughput is 200 Mbps on a 1 Gbps link and latency is rising. How do you tell a full pipe from a lossy path?",
    difficulty: 2,
    hints: [
      "Link utilization answers whether the pipe is full.",
      "Retransmits and loss answer whether TCP is backing off.",
    ],
    answer:
      "I would compare link utilization with goodput and check retransmits and loss. If utilization is near the link rate, the pipe is full and queueing explains the latency. If utilization is low while retransmits and loss are high, TCP is backing off on a lossy path. I would also check NIC drain drops and link overflow drops separately. The fixes differ: capacity or shaping for a full pipe, loss localization for a lossy path, and drain or CPU tuning for NIC drops.",
    followUps: [
      "Which command would you run first on the host?",
      "What if utilization is high and loss is also high?",
      "How does RTT change the diagnosis?",
    ],
    redFlags: [
      "Adds bandwidth without checking loss.",
      "Uses latency alone as proof of saturation.",
      "Ignores NIC counters.",
    ],
    rubric: [
      "Separates utilization from loss.",
      "Names retransmits as the TCP signal.",
      "Checks NIC drain and link overflow drops separately.",
      "Matches the fix to the failure mode.",
    ],
  },
  {
    id: "retransmit-read",
    question:
      "`ss -ti` shows a high retransmit count on one connection but the link is only 30% utilized. What do you check next?",
    difficulty: 3,
    hints: [
      "One connection can be limited by its own congestion window.",
      "Check both directions and the peer.",
    ],
    answer:
      "I would check the path for that connection: RTT, loss, and whether the retransmits are timeouts or fast retransmits. I would check the receiver's NIC and queue counters, and whether the loss is isolated to one direction or one peer. If the link is lightly utilized overall but one flow is retransmitting, the problem may be a policer, a wireless segment, or a receiver queue rather than the link capacity. I would also check whether the connection is long-lived and whether the congestion window is small.",
    followUps: [
      "How would you determine whether the loss is upstream or downstream?",
      "What would a high retransmit count with a low RTT suggest?",
      "How would you test a different path?",
    ],
    redFlags: [
      "Assumes the link is fine because utilization is low.",
      "Blames the application without checking the path.",
      "Ignores the receiver.",
    ],
    rubric: [
      "Localizes loss by direction and peer.",
      "Distinguishes timeout from fast retransmit.",
      "Checks receiver queues.",
      "Considers path policy.",
    ],
  },
  {
    id: "nic-drops",
    question:
      "A host shows NIC drain drops while the link is at 40% utilization. How can that happen, and what do you change?",
    difficulty: 3,
    hints: [
      "The link rate is not the same as the host's drain rate.",
      "Check RSS, interrupts, and queue size.",
    ],
    answer:
      "The host can fail to drain its receive queue even when the link has capacity. Causes include a single queue receiving most of the traffic, interrupts or softirq work pinned to one CPU, a queue that is too small for a burst, or a CPU that is busy elsewhere. I would check `ethtool -S` drops and missed counters, `/proc/net/dev`, RSS/RPS configuration, and CPU pressure on the receive path. Increasing the queue can absorb a burst but adds latency; fixing the drain rate is the durable change.",
    followUps: [
      "How would you verify RSS is distributing traffic?",
      "When would a larger queue be the right fix?",
      "How does this differ from packet loss on the path?",
    ],
    redFlags: [
      "Says drops are impossible below 100% utilization.",
      "Only increases the queue size.",
      "Ignores CPU affinity.",
    ],
    rubric: [
      "Explains host drain limits.",
      "Names RSS and CPU checks.",
      "Distinguishes drops from path loss.",
      "States the latency tradeoff.",
    ],
  },
  {
    id: "bandwidth-upgrade",
    question:
      "A team wants to upgrade a 1 Gbps link to 10 Gbps because p99 is high. What would you check before approving it?",
    difficulty: 3,
    hints: [
      "p99 can come from loss, queueing, or the receiver.",
      "The bottleneck may not be the link.",
    ],
    answer:
      "I would check whether the link is actually the bottleneck: utilization, link overflow drops, retransmits, loss, and RTT. If utilization is low and loss is high, a bigger link will not help. If the receiver's NIC drain or CPU is the limit, the upgrade may move the bottleneck rather than remove it. I would also check whether the latency is queueing from a burst, a policer, or an application-level timeout. Approve the upgrade only when the evidence points to bandwidth as the binding constraint.",
    followUps: [
      "What evidence would justify the upgrade?",
      "How would you phase the rollout?",
      "What would you measure afterward?",
    ],
    redFlags: [
      "Approves the upgrade on p99 alone.",
      "Ignores the receiver.",
      "Confuses loss with congestion.",
    ],
    rubric: [
      "Checks utilization, loss, and drops.",
      "Considers the receiver.",
      "Requires evidence of a bandwidth limit.",
      "Defines post-change measurement.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show link utilization, goodput, retransmits, packet loss, NIC drain drops, and link overflow drops separately.",
      "Per-connection RTT and retransmits are available with `ss -ti`.",
      "NIC queue and RSS configuration is documented for high-traffic hosts.",
      "Bulk transfers have a bandwidth budget or a separate path.",
      "The path's loss and latency SLOs are written down.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare link utilization with goodput before adding bandwidth.",
      "Check retransmits and loss, not just latency.",
      "Check NIC drain drops to see whether the host queue is the source; check link overflow drops for the link.",
      "Localize loss by direction, peer, and hop.",
      "Watch p99 and goodput together after any change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record whether the cause was bandwidth, loss, or host queueing.",
      "Fix the path or the queue rather than only increasing capacity.",
      "Add a loss or retransmit alert if the incident was invisible.",
      "Re-test the path at peak with the new configuration.",
    ],
  },
];

const references = [
  {
    title: "IP sysctl",
    url: "https://docs.kernel.org/networking/ip-sysctl.html",
    publisher: "Linux kernel documentation",
    kind: "docs" as const,
    note: "TCP retransmission, congestion control, and queue settings.",
  },
  {
    title: "ss(8)",
    url: "https://man7.org/linux/man-pages/man8/ss.8.html",
    publisher: "Linux man-pages",
    kind: "docs" as const,
    note: "Per-socket retransmits, RTT, congestion window, and queue state.",
  },
  {
    title: "Optimizing TCP for high WAN throughput while preserving low latency",
    url: "https://blog.cloudflare.com/optimizing-tcp-for-high-throughput-and-low-latency/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "How TCP congestion control and buffering affect throughput and latency.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "linux-network": {
      model: linuxNetworkSaturationModel,
      presets,
      instructions:
        "Start healthy, then add packet loss without changing the link. Compare link utilization with goodput and retransmits; a lossy path is slow while the pipe is idle.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The per-flow TCP estimate uses MSS bits, RTT, loss, and a teaching constant, then scales by the flow count. NIC drain and link overflow are independent teaching capacities.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-linux-disk-io",
    "foundations-conntrack",
    "foundations-tls-handshake",
  ],
};
