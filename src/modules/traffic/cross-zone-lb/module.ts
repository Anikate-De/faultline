import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 12_000;
const TARGET_CAPACITY_RPS = 2_000;
const RESPONSE_KB = 8;

const params = [
  {
    id: "crossZone",
    label: "Target group cross-zone (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Distribution",
    help: "1 pools all healthy targets across both Availability Zones. 0 keeps each load balancer node on the targets in its own zone. On an ALB this models the target group override.",
    format: "count" as const,
  },
  {
    id: "azATargets",
    label: "Targets in AZ A",
    min: 1,
    max: 10,
    step: 1,
    value: 6,
    unit: "",
    group: "Topology",
    help: "Healthy registered targets in Availability Zone A. Each target has an illustrative capacity of 2,000 rps.",
    format: "count" as const,
  },
  {
    id: "azBTargets",
    label: "Targets in AZ B",
    min: 1,
    max: 10,
    step: 1,
    value: 2,
    unit: "",
    group: "Topology",
    help: "Healthy registered targets in Availability Zone B. Unequal target counts are common after a partial deploy or scale-in.",
    format: "count" as const,
  },
  {
    id: "azAShare",
    label: "Client traffic resolved to AZ A",
    min: 20,
    max: 80,
    step: 5,
    value: 50,
    unit: "%",
    group: "Traffic",
    help: "Share of clients whose DNS answer points at the AZ A load balancer nodes. With cross-zone off, this share cannot use AZ B capacity.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  cross: boolean;
  a: number;
  b: number;
  share: number;
  rateA: number;
  rateB: number;
  perTargetA: number;
  perTargetB: number;
  utilA: number;
  utilB: number;
  maxUtil: number;
  servedA: number;
  servedB: number;
  served: number;
  errors: number;
  imbalance: number;
  stranded: number;
  crossShare: number;
  crossDataGb: number;
  p99: number;
}

function compute(p: Params): State {
  const cross = num(p, "crossZone", 1) >= 0.5;
  const a = Math.min(10, Math.max(1, Math.round(num(p, "azATargets", 6))));
  const b = Math.min(10, Math.max(1, Math.round(num(p, "azBTargets", 2))));
  const share = clamp(num(p, "azAShare", 50) / 100, 0, 1);
  const rateA = TOTAL_RPS * share;
  const rateB = TOTAL_RPS - rateA;
  const perTargetA = cross ? TOTAL_RPS / (a + b) : rateA / a;
  const perTargetB = cross ? TOTAL_RPS / (a + b) : rateB / b;
  const utilA = clamp((perTargetA / TARGET_CAPACITY_RPS) * 100, 0, 100);
  const utilB = clamp((perTargetB / TARGET_CAPACITY_RPS) * 100, 0, 100);
  const maxUtil = Math.max(utilA, utilB);
  const servedA = Math.min(rateA, a * TARGET_CAPACITY_RPS);
  const servedB = Math.min(rateB, b * TARGET_CAPACITY_RPS);
  const served = cross ? Math.min(TOTAL_RPS, (a + b) * TARGET_CAPACITY_RPS) : servedA + servedB;
  const errors = clamp(((TOTAL_RPS - served) / TOTAL_RPS) * 100, 0, 100);
  const imbalance = Math.abs(utilA - utilB);
  const stranded = !cross && errors > 0 ? clamp(((a * TARGET_CAPACITY_RPS - servedA) / (a * TARGET_CAPACITY_RPS)) * 100, 0, 100) : 0;
  const crossShare = cross ? clamp((share * b + (1 - share) * a) / (a + b), 0, 1) : 0;
  const crossDataGb = (TOTAL_RPS * crossShare * 3_600 * RESPONSE_KB) / (1024 * 1024);
  const queueing = maxUtil > 85 ? (maxUtil - 85) * 3 : 0;
  const p99 = Math.min(5_000, 10 + crossShare * 2 + queueing);
  return {
    cross,
    a,
    b,
    share,
    rateA,
    rateB,
    perTargetA,
    perTargetB,
    utilA,
    utilB,
    maxUtil,
    servedA,
    servedB,
    served,
    errors,
    imbalance,
    stranded,
    crossShare,
    crossDataGb,
    p99,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number): SimFrame {
  const s = compute(p);
  const clientHealth: Health = s.errors >= 5 ? "crit" : s.errors >= 0.5 ? "warn" : "ok";
  const albHealth: Health =
    s.errors >= 5 || s.maxUtil >= 95 ? "crit" : s.maxUtil >= 85 || s.imbalance >= 20 ? "warn" : "ok";
  const azHealth = (util: number): Health => (util >= 95 ? "crit" : util >= 85 ? "warn" : "ok");
  const aHealth = azHealth(s.utilA);
  const bHealth = azHealth(s.utilB);
  const azADetail = `${s.a} targets in AZ A. ${s.cross ? "The zone pools all targets across both zones." : "Zone A nodes use only zone A targets."} Utilization is ${s.utilA.toFixed(0)}% of the illustrative 2,000 rps per target.`;
  const azBDetail = `${s.b} targets in AZ B. ${s.cross ? "The zone pools all targets across both zones." : "Zone B nodes use only zone B targets."} Utilization is ${s.utilB.toFixed(0)}% of the illustrative 2,000 rps per target.`;
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: TOTAL_RPS,
        sublabel: `${(s.share * 100).toFixed(0)}% / ${((1 - s.share) * 100).toFixed(0)}% split`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Load balancer",
        kind: "lb",
        health: albHealth,
        throughput: s.served,
        sublabel: s.cross ? "cross-zone on" : "cross-zone off",
        detail: s.cross
          ? `Each load balancer node can choose any healthy target in either zone. About ${(s.crossShare * 100).toFixed(0)}% of requests cross an Availability Zone boundary.`
          : "Each load balancer node chooses only from targets in its own zone. Zone A capacity cannot absorb zone B demand.",
        meta: { view: "flow" },
      },
      {
        id: "az-a",
        label: "AZ A targets",
        kind: "service",
        health: aHealth,
        utilization: clamp(s.utilA / 100),
        throughput: s.cross ? TOTAL_RPS * (s.a / (s.a + s.b)) : s.servedA,
        sublabel: `${s.a} targets · ${s.utilA.toFixed(0)}%`,
        detail: azADetail,
        meta: { view: "flow" },
      },
      {
        id: "az-b",
        label: "AZ B targets",
        kind: "service",
        health: bHealth,
        utilization: clamp(s.utilB / 100),
        throughput: s.cross ? TOTAL_RPS * (s.b / (s.a + s.b)) : s.servedB,
        sublabel: `${s.b} targets · ${s.utilB.toFixed(0)}%`,
        detail: azBDetail,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", 1, clientHealth),
      edge("alb-a", "alb", "az-a", s.cross ? s.a / (s.a + s.b) : s.servedA / TOTAL_RPS, aHealth),
      edge("alb-b", "alb", "az-b", s.cross ? s.b / (s.a + s.b) : s.servedB / TOTAL_RPS, bHealth),
    ],
    metrics: [
      metric("max-target-util", "Busiest target utilization", s.maxUtil, "%", 85, 95, "percent"),
      metric("az-a-util", "AZ A target utilization", s.utilA, "%", 85, 95, "percent"),
      metric("az-b-util", "AZ B target utilization", s.utilB, "%", 85, 95, "percent"),
      metric("imbalance", "Zone utilization gap", s.imbalance, " pts", 20, 40, "number"),
      metric("overload-5xx", "Capacity failures", s.errors, "%", 0.5, 5, "percent"),
      metric("stranded", "Stranded capacity", s.stranded, "%", 20, 40, "percent"),
      metric("cross-zone-share", "Cross-zone requests", s.crossShare * 100, "%", undefined, undefined, "percent"),
      metric("cross-zone-data", "Cross-zone data", s.crossDataGb, " GB/h", undefined, undefined, "number"),
      metric("p99", "End-to-end p99", s.p99, "ms", 25, 60, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      crossZone: s.cross ? 1 : 0,
      a: s.a,
      b: s.b,
    },
    summary: `Cross-zone ${s.cross ? "on" : "off"}: AZ A ${s.utilA.toFixed(0)}%, AZ B ${s.utilB.toFixed(0)}%; ${s.errors.toFixed(0)}% capacity failures; ${formatCount(s.crossDataGb)} GB/h cross-zone.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value =
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
        Math.sin(index / 2.1) * amplitude;
      const bounded = item.format === "percent" ? Math.min(100, value) : value;
      return Math.max(0, bounded);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "max-target-util",
    metricId: "max-target-util",
    warn: 85,
    crit: 95,
    title: "One zone's targets are saturated",
    cause:
      "The load balancer node is sending more demand to a zone than that zone's targets can serve. With cross-zone off, the node cannot use idle capacity in the other zone; with cross-zone on, the whole fleet may simply be short of capacity.",
    fix:
      "Turn on cross-zone balancing for the target group if zonal isolation is not required, or add targets in the saturated zone. Verify that the other zone has spare capacity before shifting traffic.",
    checkFirst: [
      "Compare request count per target group and Availability Zone.",
      "Check the target group cross-zone attribute and the load balancer default.",
      "Confirm the healthy target count in each zone; a partial failure can create the same skew.",
    ],
  },
  {
    id: "imbalance",
    metricId: "imbalance",
    warn: 20,
    crit: 40,
    title: "Traffic is not balanced across zones",
    cause:
      "Client DNS resolution, target counts, or the cross-zone setting are concentrating demand in one zone. This is a distribution problem, not necessarily a capacity problem.",
    fix:
      "First decide whether zonal isolation is intentional. If it is, size each zone for its own share. If it is not, enable cross-zone balancing and verify target health in both zones.",
    checkFirst: [
      "Check the cross-zone setting at the load balancer and target group levels.",
      "Compare target counts and healthy counts per zone.",
      "Check whether clients or DNS are biased toward one zone.",
    ],
  },
  {
    id: "overload-5xx",
    metricId: "overload-5xx",
    warn: 0.5,
    crit: 5,
    title: "Requests are failing because one zone is out of capacity",
    cause:
      "Demand sent to a zone exceeds its local target capacity. With cross-zone off, idle capacity in the other zone is unusable; with cross-zone on, the total fleet capacity is insufficient.",
    fix:
      "Pool capacity with cross-zone balancing or add targets. Do not add load balancer nodes; they do not add target capacity.",
    checkFirst: [
      "Read per-zone target utilization and healthy counts.",
      "Check whether failures are confined to clients resolved to one zone.",
      "Confirm the target group capacity assumption.",
    ],
  },
  {
    id: "stranded",
    metricId: "stranded",
    warn: 20,
    crit: 40,
    title: "Capacity is stranded in the idle zone",
    cause:
      "Zone A has idle targets while zone B is overloaded because cross-zone balancing is off. The total fleet has enough capacity, but the load balancer cannot pool it.",
    fix:
      "Enable cross-zone balancing if the design does not require strict zonal isolation. If isolation is required, move capacity or traffic between zones deliberately.",
    checkFirst: [
      "Compare total healthy capacity with total demand.",
      "Check whether the underloaded zone's targets are healthy and reachable.",
      "Confirm the cross-zone setting before adding more targets.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const crossZoneLbModel: SimModel = {
  id: "traffic-cross-zone-lb",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const s = compute(p);
    const next = buildFrame(p, seed);
    const previousCross = Number(frame.flags.crossZone ?? -1);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (previousCross >= 0 && (s.cross ? 1 : 0) !== previousCross) {
      pushEvent(next, {
        id: "cross-zone-change",
        at: frame.t,
        severity: "info",
        title: s.cross ? "Cross-zone balancing enabled" : "Cross-zone balancing disabled",
        detail: s.cross
          ? "Each load balancer node can now choose healthy targets in both zones. Expect cross-AZ data transfer and a more even distribution."
          : "Each load balancer node is now limited to targets in its own zone. Zone capacity is no longer pooled.",
        nodeId: "alb",
      });
    }
    if (s.maxUtil >= 95 && frame.flags.zoneSaturated !== 1) {
      pushEvent(next, {
        id: "zone-saturated",
        at: frame.t,
        severity: "crit",
        title: "A zone's targets are saturated",
        detail: `AZ A is at ${s.utilA.toFixed(0)}% and AZ B is at ${s.utilB.toFixed(0)}%. ${s.stranded > 0 ? `${s.stranded.toFixed(0)}% of AZ A capacity is stranded while AZ B overloads.` : "The fleet is short of capacity in the busy zone."}`,
        nodeId: s.utilB >= s.utilA ? "az-b" : "az-a",
        metricId: "max-target-util",
      });
      next.flags.zoneSaturated = 1;
    } else if (s.maxUtil < 95) {
      next.flags.zoneSaturated = 0;
    }
    next.flags.crossZone = s.cross ? 1 : 0;
    next.flags.a = s.a;
    next.flags.b = s.b;
    next.summary = `Cross-zone ${s.cross ? "on" : "off"}: AZ A ${s.utilA.toFixed(0)}%, AZ B ${s.utilB.toFixed(0)}%; ${s.errors.toFixed(0)}% capacity failures; ${formatCount(s.crossDataGb)} GB/h cross-zone.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const s = compute(p);
    const items: string[] = [];
    items.push(
      `AZ A has ${s.a} targets at ${s.utilA.toFixed(0)}%; AZ B has ${s.b} targets at ${s.utilB.toFixed(0)}%.`,
    );
    items.push(
      s.cross
        ? `Cross-zone is on, so all ${s.a + s.b} targets are pooled. The zone utilization gap is ${s.imbalance.toFixed(0)} points.`
        : `Cross-zone is off, so each zone can use only its own targets. The zone utilization gap is ${s.imbalance.toFixed(0)} points.`,
    );
    if (s.stranded > 0) {
      items.push(`${s.stranded.toFixed(0)}% of AZ A capacity is idle while AZ B is out of capacity.`);
    }
    if (s.cross) {
      items.push(
        `About ${(s.crossShare * 100).toFixed(0)}% of requests cross zones, producing an illustrative ${formatCount(s.crossDataGb)} GB/h of cross-AZ data.`,
      );
    } else {
      items.push("Keeping traffic in-zone avoids cross-AZ transfer, but it requires enough capacity in every zone.");
    }
    if (s.errors > 0) {
      items.push(`${s.errors.toFixed(0)}% of requests cannot be served with the current per-zone capacity.`);
    }
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
    label: "Pooled capacity",
    description: "Cross-zone on with uneven target counts; every target carries an even share.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Zonal skew",
    description: "Cross-zone off, more clients in AZ A, and AZ B near its warning line.",
    tone: "warn",
    params: defaults({ crossZone: 0, azATargets: 6, azBTargets: 3, azAShare: 55 }),
  },
  {
    id: "failure",
    label: "Stranded capacity",
    description: "Cross-zone off with two AZ B targets and half the clients on each zone.",
    tone: "crit",
    params: defaults({ crossZone: 0, azATargets: 6, azBTargets: 2, azAShare: 50 }),
  },
  {
    id: "recovery",
    label: "Pooled recovery",
    description: "Cross-zone on with an even four-and-four target layout.",
    tone: "ok",
    params: defaults({ crossZone: 1, azATargets: 4, azBTargets: 4, azAShare: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-zonal-skew",
  title: "Predict where the overload lands",
  simId: "cross-zone-lb",
  question:
    "Six healthy targets sit in AZ A and two in AZ B. Cross-zone balancing is off. Clients split evenly across the two zones. Which zone saturates first?",
  prediction: {
    options: [
      { id: "az-b", label: "AZ B, because its two targets must serve half the requests." },
      { id: "az-a", label: "AZ A, because it has more targets and therefore more traffic." },
      { id: "both", label: "Both zones saturate at the same time because the load balancer splits evenly." },
      { id: "neither", label: "Neither; the load balancer uses all eight targets regardless of zone." },
    ],
    correctOptionId: "az-b",
    explanation:
      "With cross-zone off, each load balancer node sends traffic only to the targets in its own Availability Zone. Half the requests go to the AZ B node, which can use only two targets; the AZ A node has six targets for the other half. The total fleet has enough capacity, but the zones cannot pool it. Cross-zone balancing is what lets the AZ A targets absorb the AZ B overflow.",
  },
  setup: defaults({ crossZone: 0, azATargets: 6, azBTargets: 2, azAShare: 50 }),
  runFor: 10,
  observe: [
    "AZ A targets run at 50% while AZ B targets hit their capacity ceiling.",
    "The zone utilization gap is 50 points and 16.7% of requests fail.",
    "Cross-zone request share and cross-zone data are both zero.",
    "The load balancer is healthy; the setting, not the target health, causes the skew.",
  ],
  explain:
    "The load balancer node in each zone is doing exactly what the setting says. Off means local targets only, so the target count per zone must match the traffic share per zone. The total capacity is adequate: six targets at 50% leave 6,000 rps of headroom, but that headroom is in the wrong zone.",
  fix: defaults({ crossZone: 1, azATargets: 6, azBTargets: 2, azAShare: 50 }),
  debrief:
    "With cross-zone on, all eight targets are pooled and each runs at 75%. Capacity failures stop. The tradeoff is cross-AZ traffic: at 12,000 rps with an 8 KB illustrative response, about 165 GB/h crosses a zone boundary. Check the data-transfer bill and the latency budget before declaring this free.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cross-zone load balancing controls whether a load balancer node can send traffic to targets in every enabled Availability Zone or only to targets in its own zone. A zone is an isolated failure domain inside a Region. With cross-zone on, idle capacity in one zone can absorb demand from another. With cross-zone off, each zone must have enough target capacity for the traffic its load balancer nodes receive.",
  },
  {
    type: "p",
    text: "The setting differs by service. An Application Load Balancer (ALB) has cross-zone load balancing always enabled at the load balancer level and cannot disable it, but a target group can override the setting to off. A Network Load Balancer (NLB) has cross-zone disabled by default; enabling it pools capacity and incurs cross-AZ data-transfer charges. For both, the target group setting determines the behavior of traffic sent to that target group.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, DNS answer, load balancer node in one zone, targets. The DNS answer decides which zone's load balancer node a client reaches. The cross-zone setting decides which targets that node may use. Those are two separate distribution decisions, which is why a skew can survive a healthy target group.",
  },
  {
    type: "compare",
    leftTitle: "Cross-zone on",
    rightTitle: "Cross-zone off",
    rows: [
      { label: "Target selection", left: "Any healthy target in any enabled zone", right: "Only targets in the node's zone" },
      { label: "Capacity pooling", left: "Idle capacity in one zone can serve another", right: "Each zone must be sized for its own share" },
      { label: "Data transfer", left: "Cross-AZ traffic may be charged", right: "Traffic stays in-zone" },
      { label: "Failure domain", left: "A zone failure shifts load to the remaining zones", right: "A zone failure can strand its traffic" },
      { label: "Stickiness and Lambda", left: "Supported", right: "ALB stickiness and Lambda targets are not supported with it off" },
    ],
  },
  {
    type: "p",
    text: "Zonal isolation is a legitimate design goal. Keeping traffic in-zone can reduce latency and data-transfer cost, and it prevents one zone's failure from affecting another. The cost is that every zone needs enough capacity for its own traffic plus a failure margin. If the target counts or the client split are uneven, one zone saturates while the other idles.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Per-zone target utilization and the utilization gap between zones.",
      "Capacity failures and stranded capacity in the idle zone.",
      "Cross-zone request share and an illustrative cross-zone data rate.",
      "The load balancer node detail, which states whether the target group pools zones.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with pooled capacity. Switch cross-zone off with six targets in AZ A and two in AZ B and watch AZ B saturate while AZ A idles. Then turn cross-zone back on and compare the data-transfer cost. Change the client split last; it is a separate distribution decision.",
  },
  {
    type: "table",
    headers: ["Situation", "Cross-zone choice", "Why"],
    rows: [
      ["Uneven target counts across zones", "On", "Pool capacity instead of forcing each zone to match its share" ],
      ["Strict zonal isolation or latency control", "Off", "Keep traffic in-zone and size each zone independently" ],
      ["NLB with cross-AZ cost sensitivity", "Off by default", "Avoid cross-AZ data charges; verify per-zone capacity" ],
      ["ALB target group with a zonal target skew", "On (the default)", "The ALB pools zones unless the target group overrides it" ],
    ],
  },
  { type: "sim", simId: "cross-zone-lb" },
  { type: "experiment", experimentId: "predict-zonal-skew" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With cross-zone off, the AZ B node could use only its two targets while the AZ A node had six. Half the clients landed in each zone, so AZ B ran out of capacity and AZ A kept half its capacity idle. Turning cross-zone on let all eight targets serve the whole request rate, and both zones settled at 75%.",
  },
  {
    type: "p",
    text: "The load balancer was healthy the whole time. The failure was a distribution setting, not a target health problem or a load balancer capacity problem. The next tradeoff is cost: cross-zone traffic is not free on every service, and the model shows the data rate rising when the setting is on.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ALB: `RequestCount` and `TargetResponseTime` by Availability Zone and target group; `HealthyHostCount` per zone; `ProcessedBytes` for traffic volume.",
      "NLB: `ActiveFlowCount`, `NewFlowCount`, and `ProcessedBytes` per Availability Zone; cross-zone data-transfer charges when the setting is on.",
      "Target group: the `load_balancing.cross_zone.enabled` attribute, plus the load balancer default it inherits or overrides.",
      "DNS: which zonal load balancer addresses clients receive and how long they cache them.",
      "Target health: a partial zone failure can look like a cross-zone skew even when the setting is correct.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check per-zone target counts and healthy counts before changing the cross-zone setting. If one zone has fewer healthy targets, fix health first. If both zones are healthy and the traffic share matches the target share, the setting is probably intentional; if not, compare the target group attribute with the load balancer default.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the load balancer type and its default: ALB at the load balancer level is always on; NLB is off by default.",
      "Read the target group cross-zone attribute and whether it overrides the load balancer setting.",
      "Compare target counts, healthy counts, and request counts by zone.",
      "If capacity is stranded, enable cross-zone for the target group and verify the data-transfer budget.",
      "If isolation is required, add capacity or shift traffic so each zone can serve its own share.",
      "Recheck per-zone utilization, capacity failures, and latency after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cross-zone pooling improves balance and availability but can add cross-AZ latency and data-transfer charges.",
      "Cross-zone off keeps traffic local and isolates failure domains, but every zone must be sized for its own peak and a zone failure strands its traffic.",
      "Uneven target counts are common after partial deploys; pooling hides the imbalance until the next failure.",
      "Sticky sessions and Lambda targets are not supported on ALB target groups with cross-zone off.",
      "Target group health thresholds apply per zone when cross-zone is off, so a zone with too few healthy targets can trigger DNS or routing failover.",
      "The setting is not a substitute for target capacity; it only changes which targets a node may use.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "one-zone-most-traffic",
    question:
      "Two Availability Zones have healthy targets, but one zone receives most of the traffic. What do you check, and what setting could explain it?",
    difficulty: 2,
    hints: [
      "Target health is not the only reason for a skew.",
      "Cross-zone can be set at the target group and the load balancer.",
    ],
    answer:
      "I would compare request counts, target counts, and healthy target counts by zone. If both zones are healthy and the traffic split matches the target split, I would check the cross-zone setting. An NLB has cross-zone off by default; an ALB is always on at the load balancer level, but a target group can override it to off. With cross-zone off, each node uses only local targets, so a zone with fewer targets or a larger client share saturates first. I would also check DNS behavior, because the client-to-zone split is a separate decision from the target-selection setting.",
    followUps: [
      "How would you prove the skew is not a health-check problem?",
      "What changes if the load balancer is an ALB instead of an NLB?",
      "Which metric would you alert on?",
    ],
    redFlags: [
      "Starts by adding targets without checking the setting.",
      "Assumes ALB cross-zone can be disabled at the load balancer level.",
      "Ignores DNS and client distribution.",
    ],
    rubric: [
      "Separates client-to-zone distribution from target selection.",
      "Names the cross-zone attribute and the service default.",
      "Checks per-zone healthy counts.",
      "States the capacity consequence.",
    ],
  },
  {
    id: "why-not-always",
    question:
      "Why would a team deliberately turn cross-zone balancing off?",
    difficulty: 3,
    hints: [
      "Cross-AZ traffic has a cost and a latency.",
      "Zonal isolation is a failure-domain choice.",
    ],
    answer:
      "A team might keep cross-zone off to hold traffic inside a zone for latency and data-transfer cost, or to preserve a strict zonal failure domain so a problem in one zone does not spread. That only works if each zone has enough target capacity for its own traffic and a failure margin. The tradeoff is that uneven target counts or a zone failure can strand capacity, and some features, such as ALB stickiness or Lambda targets, are not supported with cross-zone off. The decision should follow the availability and cost requirements, not a default.",
    followUps: [
      "How would you size each zone for a zonal failure?",
      "What happens to sticky sessions when cross-zone is off?",
      "When would cross-AZ latency be acceptable?",
    ],
    redFlags: [
      "Assumes off is always cheaper or always safer.",
      "Ignores per-zone capacity requirements.",
      "Forgets feature limitations.",
    ],
    rubric: [
      "Names cost and latency.",
      "Explains zonal isolation.",
      "Requires per-zone capacity.",
      "Mentions feature limitations.",
    ],
  },
  {
    id: "az-failure-off",
    question:
      "Cross-zone is off and one Availability Zone loses all of its targets. What happens to clients resolved to that zone, and how do you design for it?",
    difficulty: 3,
    hints: [
      "The node in the failed zone has no local healthy targets.",
      "DNS and target group health thresholds can move traffic.",
    ],
    answer:
      "The load balancer node in the failed zone has no healthy local targets. The target group's health thresholds can mark the zone unhealthy in DNS, and clients that resolve again can move to the healthy zone, but clients with a cached address may keep failing until the TTL expires. The surviving zone must have enough capacity for the shifted traffic. I would set the target group health thresholds deliberately, keep the DNS TTL short enough for the failover objective, and size each zone so the remaining zone can carry the load during a zonal failure. If that is too expensive, cross-zone on is the simpler availability choice.",
    followUps: [
      "Which target group health metric shows the DNS failover?",
      "How does client DNS caching change the recovery time?",
      "What would you check before trusting a single-zone failover test?",
    ],
    redFlags: [
      "Assumes traffic moves instantly.",
      "Ignores cached DNS answers.",
      "Sizes the surviving zone for normal load only.",
    ],
    rubric: [
      "Explains the empty-zone behavior.",
      "Names DNS failover and TTL.",
      "Requires surviving-zone capacity.",
      "Connects the design to the availability objective.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The cross-zone setting is recorded at both the load balancer and target group levels.",
      "Dashboards show request count and healthy host count by Availability Zone.",
      "Each zone is sized for its own traffic share if cross-zone is off.",
      "The cross-AZ data-transfer budget is known for the services that pool zones.",
      "Target group health thresholds and DNS TTL are set for the failover objective.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare per-zone request counts with per-zone target counts.",
      "Check the target group cross-zone attribute before adding capacity.",
      "Distinguish a health failure from a distribution skew.",
      "Check stranded capacity in the idle zone.",
      "Record the setting change and the resulting cross-zone data rate.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify both zones carry the intended share at peak.",
      "Re-run a zone-failure test with the chosen setting.",
      "Review the data-transfer bill after enabling cross-zone.",
      "Document why the setting differs from the service default.",
    ],
  },
];

const references = [
  {
    title: "Edit target group attributes for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "ALB cross-zone behavior, target group override, stickiness, and target group health settings.",
  },
  {
    title: "Edit target group attributes for your Network Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "NLB cross-zone default, enablement, and cross-AZ data-transfer charges.",
  },
  {
    title: "Target groups for your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target group health thresholds and their per-zone behavior when cross-zone is off.",
  },
  {
    title: "CloudWatch metrics for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Per-Availability-Zone request, healthy host, and target metrics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cross-zone-lb": {
      model: crossZoneLbModel,
      presets,
      instructions:
        "Start pooled. Switch cross-zone off and watch AZ B saturate while AZ A idles. Turn it back on and compare cross-zone data. Change the client split last to separate DNS distribution from target selection.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Twelve thousand requests per second, 2,000 rps per target, and 8 KB per response are teaching values, not AWS limits or guarantees. AWS documents the cross-zone defaults and data-transfer charges; the exact distribution depends on client DNS and target health.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-alb-target-groups", "traffic-alb-health-checks", "case-aws-network-2021"],
};
