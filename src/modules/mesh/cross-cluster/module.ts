import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAPACITY_A = 18_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 8_000,
    max: 40_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Demand",
    help: "Requests per second reaching the service, split evenly between the two clusters before any failover shift.",
    format: "rps" as const,
  },
  {
    id: "failoverShift",
    label: "Failover share",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Failover",
    help: "Share of Cluster A's traffic forced to Cluster B. This is a routing decision, not a capacity grant.",
    format: "percent" as const,
  },
  {
    id: "remoteCapacity",
    label: "Remote cluster capacity",
    min: 6_000,
    max: 30_000,
    step: 1_000,
    value: 18_000,
    unit: " rps",
    group: "Capacity",
    help: "Teaching capacity of Cluster B. Cluster A has a fixed 18,000 rps teaching capacity in this model.",
    format: "rps" as const,
  },
  {
    id: "crossLatency",
    label: "Cross-cluster latency",
    min: 5,
    max: 120,
    step: 5,
    value: 35,
    unit: " ms",
    group: "Network",
    help: "Added round-trip time for a request served by the remote cluster. Local requests do not pay it.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Outcome {
  requestRate: number;
  shift: number;
  remoteCapacity: number;
  crossLatency: number;
  aDemand: number;
  bDemand: number;
  aUtil: number;
  bUtil: number;
  aShortfall: number;
  bShortfall: number;
  capacityShortfall: number;
  errorRate: number;
  crossShare: number;
  p99: number;
  localShare: number;
}

function compute(p: Params): Outcome {
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const shift = clamp(num(p, "failoverShift", 0), 0, 100);
  const remoteCapacity = Math.max(1, num(p, "remoteCapacity", 18_000));
  const crossLatency = Math.max(0, num(p, "crossLatency", 35));
  const localShare = 1 - shift / 100;
  const aDemand = (requestRate / 2) * localShare;
  const bDemand = requestRate / 2 + (requestRate / 2) * (shift / 100);
  const aUtil = aDemand / CAPACITY_A;
  const bUtil = bDemand / remoteCapacity;
  const aShortfall = Math.max(0, aDemand - CAPACITY_A);
  const bShortfall = Math.max(0, bDemand - remoteCapacity);
  const capacityShortfall = ((aShortfall + bShortfall) / requestRate) * 100;
  const maxUtil = Math.max(aUtil, bUtil);
  const p99 = Math.min(
    5_000,
    25 + crossLatency * (shift / 100) + 900 * Math.max(0, maxUtil - 0.85) ** 2 + 1_800 * Math.max(0, maxUtil - 1),
  );
  return {
    requestRate,
    shift,
    remoteCapacity,
    crossLatency,
    aDemand,
    bDemand,
    aUtil,
    bUtil,
    aShortfall,
    bShortfall,
    capacityShortfall,
    errorRate: capacityShortfall,
    crossShare: shift,
    p99,
    localShare,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(o: Outcome, seed: number): SimFrame {
  const clientHealth = healthFor(o.errorRate, 1, 5);
  const aHealth = o.aShortfall > 0 ? "crit" : healthFor(o.aUtil * 100, 85, 95);
  const bHealth = o.bShortfall > 0 ? "crit" : healthFor(o.bUtil * 100, 85, 95);
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: o.requestRate,
        sublabel: `${fmt(o.requestRate)} rps`,
        meta: { view: "flow" },
      },
      {
        id: "cluster-a",
        label: "Cluster A · east",
        kind: "mesh",
        role: "zone",
        health: aHealth,
        utilization: clamp(o.aUtil),
        throughput: o.aDemand,
        capacity: CAPACITY_A,
        sublabel: `${Math.round(o.aUtil * 100)}% load · ${fmt(o.aDemand)} rps`,
        detail: `Local cluster. Teaching capacity ${fmt(CAPACITY_A)} rps. It serves ${Math.round(o.localShare * 100)}% of its half of demand. A shortfall of ${fmt(o.aShortfall)} rps is not visible to the remote cluster until routing changes.`,
        meta: { view: "flow" },
      },
      {
        id: "service-a",
        label: "Checkout · east",
        kind: "service",
        health: aHealth,
        utilization: clamp(o.aUtil),
        throughput: o.aDemand,
        sublabel: "local endpoints",
        meta: { view: "flow" },
      },
      {
        id: "cluster-b",
        label: "Cluster B · west",
        kind: "mesh",
        role: "zone",
        health: bHealth,
        utilization: clamp(o.bUtil),
        throughput: o.bDemand,
        capacity: o.remoteCapacity,
        sublabel: `${Math.round(o.bUtil * 100)}% load · ${fmt(o.bDemand)} rps`,
        detail: `Remote cluster. Teaching capacity ${fmt(o.remoteCapacity)} rps. It receives ${Math.round(o.shift)}% of Cluster A's traffic ${o.shift > 0 ? "in addition to its own" : "when failover is active"}. Remote discovery does not add capacity.`,
        meta: { view: "flow" },
      },
      {
        id: "service-b",
        label: "Checkout · west",
        kind: "service",
        health: bHealth,
        utilization: clamp(o.bUtil),
        throughput: o.bDemand,
        sublabel: "remote endpoints",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-a", "clients", "cluster-a", o.aDemand / o.requestRate, clientHealth),
      edge("clients-b", "clients", "cluster-b", o.shift > 0 ? o.bDemand / o.requestRate : 0, clientHealth),
      edge("a-service", "cluster-a", "service-a", 1, aHealth),
      edge("b-service", "cluster-b", "service-b", 1, bHealth),
      edge("a-discovery", "cluster-a", "cluster-b", 0.1, "ok", "remote discovery"),
    ],
    metrics: [
      metric("remote-util", "Remote cluster load", o.bUtil * 100, "%", 75, 90, "percent"),
      metric("error-rate", "Failed requests", o.errorRate, "%", 1, 5, "percent"),
      metric("p99", "End-to-end p99", o.p99, "ms", 250, 500, "ms"),
      metric("cross-share", "Cross-cluster traffic", o.crossShare, "%", 40, 70, "percent"),
      metric("capacity-shortfall", "Capacity shortfall", o.capacityShortfall, "%", 5, 20, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      shift: o.shift,
      rate: o.requestRate,
      remoteCap: o.remoteCapacity,
      remoteUtil: o.bUtil,
      err: o.errorRate,
      paramsKey: "",
    },
    summary: `${Math.round(o.shift)}% shifted; Cluster A at ${Math.round(o.aUtil * 100)}%, Cluster B at ${Math.round(o.bUtil * 100)}%; ${o.errorRate.toFixed(1)}% errors; p99 ${Math.round(o.p99)}ms.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.01 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.99 + 0.02 * Math.sin((index + (seed % 5)) / 2.6)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "remote-util",
    metricId: "remote-util",
    warn: 75,
    crit: 90,
    title: "The remote cluster is carrying more than its safe load",
    cause:
      "Failover shifted traffic without checking the remote cluster's headroom. Cluster B now serves its own demand plus the shifted share, so a routing change became a capacity incident.",
    fix:
      "Cap the failover share at the remote cluster's free capacity, and leave enough headroom for its own peak. Prefer partial failover or load shedding over sending everything to the survivor.",
    checkFirst: [
      "Compare the remote cluster's request rate with its measured safe capacity, not its provisioned maximum.",
      "Check whether the failover policy shifts a fixed share or all traffic from the failed cluster.",
      "Check the remote cluster's own baseline load before the failover.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Cross-cluster failover is failing requests",
    cause:
      "The surviving clusters cannot serve the shifted demand. Discovery made the remote service reachable, but reachability does not guarantee capacity, correct locality, or a healthy endpoint.",
    fix:
      "Reduce the failover share or restore capacity in the local cluster. Keep total demand within the sum of serving capacity after the shift, and test the failover at peak, not at average.",
    checkFirst: [
      "Compare total demand with total healthy capacity before and after the shift.",
      "Check whether the remote cluster is rejecting connections or queueing them.",
      "Check whether only shifted requests fail or local requests fail too.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 250,
    crit: 500,
    title: "Cross-cluster latency breached the user budget",
    cause:
      "A growing share of requests is served across clusters, each paying the inter-cluster round trip. Saturation on the remote side adds queueing on top of the network cost.",
    fix:
      "Keep traffic local while local capacity is healthy, shift only the overflow, and size the remote path for the latency budget rather than only for availability.",
    checkFirst: [
      "Split latency by local and remote upstream cluster.",
      "Compare the cross-cluster share with the latency change.",
      "Check remote queueing and connection pool saturation.",
    ],
  },
  {
    id: "cross-share",
    metricId: "cross-share",
    warn: 40,
    crit: 70,
    title: "Most traffic is leaving its local cluster",
    cause:
      "The failover share is high, or locality preference is not keeping healthy local endpoints in use. Cross-cluster traffic pays latency and often egress cost even when local capacity exists.",
    fix:
      "Lower the failover share, restore local capacity, and verify that the load balancer prefers local endpoints while they are healthy.",
    checkFirst: [
      "Check whether local endpoints are healthy and under their capacity.",
      "Check the failover policy for a fixed 100% shift.",
      "Check whether a recent rollout changed locality or priority settings.",
    ],
  },
];

export const crossClusterModel: SimModel = {
  id: "cross-cluster",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const o = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(o, seed);
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
    const jitter = rng.between(-0.012, 0.012);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(1, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const prevShift = Number(frame.flags.shift ?? 0);
    const prevErr = Number(frame.flags.err ?? 0);
    const prevRemoteUtil = Number(frame.flags.remoteUtil ?? 0);
    if (o.shift > 0 && prevShift === 0) {
      pushEvent(next, {
        id: "failover-shift",
        at: frame.t,
        severity: o.bUtil >= 1 ? "warn" : "info",
        title: "Traffic shifted to the remote cluster",
        detail: `${Math.round(o.shift)}% of Cluster A's traffic now targets Cluster B. Remote load is ${Math.round(o.bUtil * 100)}% of its teaching capacity.`,
        nodeId: "cluster-b",
        metricId: "cross-share",
      });
    }
    if (o.bUtil >= 1 && prevRemoteUtil < 1) {
      pushEvent(next, {
        id: "remote-overloaded",
        at: frame.t,
        severity: "crit",
        title: "Remote cluster is over capacity",
        detail: `Cluster B receives ${fmt(o.bDemand)} rps against ${fmt(o.remoteCapacity)} rps of teaching capacity. The mesh can discover the endpoints; it cannot create headroom.`,
        nodeId: "cluster-b",
        metricId: "remote-util",
      });
    }
    if (o.shift === 0 && prevShift > 0) {
      pushEvent(next, {
        id: "failover-return",
        at: frame.t,
        severity: "info",
        title: "Traffic returned to the local cluster",
        detail: "Failover share is zero. Verify that local endpoints have capacity before declaring recovery.",
        nodeId: "cluster-a",
      });
    }
    if (o.errorRate >= 5 && prevErr < 5) {
      pushEvent(next, {
        id: "cross-cluster-errors",
        at: frame.t,
        severity: "crit",
        title: "Cross-cluster failover is failing requests",
        detail: `${o.errorRate.toFixed(1)}% of requests fail. Total demand is ${fmt(o.requestRate)} rps; the shortfall is ${fmt(o.aShortfall + o.bShortfall)} rps across both clusters.`,
        nodeId: "clients",
        metricId: "error-rate",
      });
    }
    if (o.errorRate < 1 && prevErr >= 1) {
      pushEvent(next, {
        id: "cross-cluster-recovered",
        at: frame.t,
        severity: "info",
        title: "Cross-cluster requests are succeeding",
        detail: "Both clusters are inside their teaching capacity. Confirm that latency and cost are also back inside budget.",
        nodeId: "clients",
      });
    }
    next.summary = `${Math.round(o.shift)}% shifted; Cluster A at ${Math.round(o.aUtil * 100)}%, Cluster B at ${Math.round(o.bUtil * 100)}%; ${o.errorRate.toFixed(1)}% errors; p99 ${Math.round(o.p99)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const o = compute(p);
    return [
      `Cluster A receives ${fmt(o.aDemand)} rps and Cluster B receives ${fmt(o.bDemand)} rps. A failover shift moves demand; it does not add capacity to the remote cluster.`,
      `Remote load is ${Math.round(o.bUtil * 100)}% of ${fmt(o.remoteCapacity)} rps. Local load is ${Math.round(o.aUtil * 100)}% of ${fmt(CAPACITY_A)} rps. Capacity shortfall is ${o.capacityShortfall.toFixed(1)}%.`,
      `Cross-cluster share is ${Math.round(o.shift)}%. The illustrative p99 is ${Math.round(o.p99)}ms, including ${Math.round(o.crossLatency)}ms of added round-trip time for every remote request.`,
      "A global control plane distributes remote service endpoints to every zone. That makes the service discoverable; Envoy's locality, priority, and failover settings decide whether a request actually stays local.",
      "Failover is safest as a partial shift sized to remote headroom. Sending 100% of a failed cluster's traffic to one survivor turns a cluster failure into a capacity failure.",
    ];
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
    description: "16,000 rps split evenly. Both clusters are below 50% of capacity and no traffic crosses clusters.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "30,000 rps split evenly. Both clusters are near their warning line, but requests still succeed locally.",
    tone: "warn",
    params: defaults({ requestRate: 30_000, failoverShift: 0, remoteCapacity: 18_000 }),
  },
  {
    id: "failure",
    label: "Full failover",
    description: "A 28,000 rps service shifts all of Cluster A's traffic to a 10,000 rps remote cluster. The remote cluster collapses.",
    tone: "crit",
    params: defaults({ requestRate: 28_000, failoverShift: 100, remoteCapacity: 10_000 }),
  },
  {
    id: "partial",
    label: "Partial failover",
    description: "Half of Cluster A's traffic moves to a 14,000 rps remote cluster. Local load is fine; the remote side is not.",
    tone: "warn",
    params: defaults({ requestRate: 28_000, failoverShift: 50, remoteCapacity: 14_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "18,000 rps, no failover, and 20,000 rps available remotely. Both clusters have headroom.",
    tone: "ok",
    params: defaults({ requestRate: 18_000, failoverShift: 0, remoteCapacity: 20_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-remote-capacity",
  title: "Predict what failover does to the survivor",
  simId: "cross-cluster",
  question:
    "Both clusters serve 10,000 rps of a 20,000 rps service. Cluster A fails and the failover policy sends 100% of its traffic to Cluster B, which also has 18,000 rps of capacity. What happens?",
  prediction: {
    options: [
      { id: "fits", label: "Cluster B absorbs the traffic because 20,000 rps is close to its 18,000 rps capacity" },
      { id: "overload", label: "Cluster B must serve 20,000 rps and is over capacity, so requests fail or queue" },
      { id: "local", label: "Clients keep using their local endpoints because locality preference overrides the failover" },
      { id: "discovery", label: "Remote discovery adds capacity automatically, so total capacity becomes 36,000 rps" },
    ],
    correctOptionId: "overload",
    explanation:
      "Cluster B was already serving its own 10,000 rps. Moving all of Cluster A's 10,000 rps gives it 20,000 rps against 18,000 rps of teaching capacity. A mesh discovers endpoints across clusters; it does not pool idle capacity into a shared budget. Failover has to be sized to the survivor's free headroom.",
  },
  setup: defaults({ requestRate: 20_000, failoverShift: 100, remoteCapacity: 18_000 }),
  runFor: 40,
  observe: [
    "Cluster A drops to zero while Cluster B rises to 20,000 rps.",
    "Remote cluster load crosses 100% and the capacity shortfall appears as failed requests.",
    "End-to-end p99 rises with cross-cluster latency and remote queueing.",
    "Local discovery still works; the remote endpoints are reachable but saturated.",
  ],
  explain:
    "The mesh knows that Checkout exists in both clusters. The global control plane distributes both endpoint sets, and the failover policy chooses the remote set. None of that adds CPU, connections, or headroom. At 20,000 rps, Cluster B is 2,000 rps over its teaching capacity, so the failover turns a local outage into a shared one. A partial shift, or a local degraded response, would keep the survivor inside its limit.",
  fix: defaults({ requestRate: 20_000, failoverShift: 40, remoteCapacity: 18_000 }),
  debrief:
    "At a 40% shift, Cluster B receives 14,000 rps and stays below its 18,000 rps capacity, while Cluster A still serves 6,000 rps. The cost is that Cluster A's remaining traffic is still at risk if the failure is hard. That is the core tradeoff: failover protects availability only when the survivor has room, and partial failover accepts some local failure to protect the whole.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A cross-cluster mesh lets a service in one cluster or zone call a service in another without a separate load balancer, DNS record, or client library. A global control plane distributes remote endpoints to the local data plane proxies, and those proxies apply locality, priority, and failover policy to choose an endpoint. Kuma calls the deployment model multi-zone: a global control plane, one control plane per zone, and zone ingress and egress for cross-zone traffic.",
  },
  {
    type: "p",
    text: "Discovery and capacity are separate properties. Discovery answers whether a proxy has an address for a remote endpoint. Capacity answers whether that endpoint can serve one more request. A failover policy can make the first true and the second false at the same time, which is why a failover that looks correct in a diagram can overload the cluster that survives.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, local Envoy, local service, and, when policy allows, remote Envoy and remote service. The local proxy makes the routing decision. The global control plane supplies the remote endpoint set; the zone control planes keep local state. Cross-zone traffic normally passes through a zone ingress and zone egress, so the network path is explicit and can be observed separately from the application path.",
  },
  {
    type: "table",
    headers: ["Layer", "What it knows", "What it cannot do"],
    rows: [
      ["Global control plane", "Every zone's services and endpoints", "Create capacity in a zone"],
      ["Zone control plane", "Local data plane proxies and policies", "Guarantee that a remote zone is healthy"],
      ["Local Envoy", "Endpoint health, locality, priority, load", "Know the remote cluster's queue depth unless it is reported"],
      ["Remote Envoy", "Its own upstream pools and health", "Absorb demand above its capacity"],
      ["Application", "Its own errors and latency", "See requests that failed before reaching it"],
    ],
  },
  {
    type: "p",
    text: "Locality preference is the first control. While local endpoints are healthy and have room, Envoy should keep traffic local. Failover is the second control: when the local set is unavailable or over capacity, traffic moves to a lower priority or another zone. Both controls are useful; neither one checks the survivor's headroom for you.",
  },
  {
    type: "compare",
    leftTitle: "Local-first with partial failover",
    rightTitle: "Full failover to one survivor",
    rows: [
      { label: "Normal latency", left: "Local round trip", right: "Local round trip until failure" },
      { label: "Survivor load", left: "Sized to free headroom", right: "Own load plus all failed-cluster load" },
      { label: "Failure behavior", left: "Some requests fail locally; the survivor stays healthy", right: "A cluster failure becomes a cross-cluster capacity failure" },
      { label: "Cost", left: "Lower cross-zone egress", right: "High cross-zone egress and queueing" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Two clusters, each with its own Envoy and Checkout service, plus a remote discovery edge.",
      "A failover share that moves demand from Cluster A to Cluster B without changing total demand.",
      "Remote cluster load, failed requests, p99, cross-cluster share, and capacity shortfall.",
      "A fixed 18,000 rps teaching capacity for Cluster A and an adjustable teaching capacity for Cluster B.",
      "An event when the remote cluster crosses capacity, and another when failover starts failing requests.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Raise the request rate to Peak and watch both clusters approach their warning line without crossing it. Apply Full failover and read remote load before reading errors. Then apply Partial failover and compare the error rate with the cross-cluster share. Use Recovery to confirm that returning traffic locally clears the incident.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Teaching values",
    body: "Cluster capacities, latency, and the error curve are illustrative teaching values, not Kuma defaults or provider limits. The behavior they show, discovery without capacity and failover without headroom checks, is the production pattern to look for.",
  },
  { type: "sim", simId: "cross-cluster" },
  { type: "experiment", experimentId: "predict-remote-capacity" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Cluster A failed or was drained, and the failover policy moved its traffic to Cluster B. The mesh discovered the remote Checkout endpoints, so the request path existed. Cluster B then had to serve its own demand plus the shifted demand. With a full shift it crossed its teaching capacity, queueing rose, and requests failed even though every endpoint was reachable.",
  },
  {
    type: "p",
    text: "The partial failover preset showed the same mechanism at a smaller scale. Cluster A kept some traffic, Cluster B took the rest, and the remote side crossed its warning or critical line depending on the share. The lesson is not that failover is wrong. It is that the failover share is a capacity decision and must be sized against the survivor's free headroom.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy cluster stats per upstream cluster: `upstream_rq_total`, `upstream_rq_5xx`, `upstream_cx_connect_fail`, and `upstream_rq_pending_overflow`.",
      "The same cluster name can exist in both zones. Always read the zone or cluster tag with the metric, not the service name alone.",
      "Kuma data plane and service inventory showing which zone owns each endpoint, plus zone ingress and egress traffic.",
      "Cross-zone latency split by source and destination zone; a rising share shows the failover is not staying local.",
      "Cost and egress metrics by zone pair. Cross-cluster traffic is often billed and always adds a round trip.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare total demand with the survivor's free capacity before changing any routing. Check whether the failover shifts a fixed share or everything. Check whether the remote cluster's own peak is included. Then check whether the failure is a capacity shortfall or a reachability problem; they have different fixes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the full shift. Cap failover at the survivor's measured free capacity, or fail over in stages.",
      "Keep local capacity available for as long as possible, and shed non-critical traffic before shifting it.",
      "Add remote headroom only after confirming that the bottleneck is capacity, not a health check, policy, or network path.",
      "Set locality preference so healthy local endpoints are used first, and verify the failover behavior at peak demand.",
      "Add a degraded response for traffic that cannot be served locally or remotely.",
      "Re-run the failure with the same policies, quotas, and autoscaling limits you expect during an incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Full failover gives the simplest routing rule and the worst capacity outcome. Partial failover protects the survivor but leaves some local requests at risk.",
      "Keeping traffic local reduces latency and egress cost but concentrates risk in one zone.",
      "Cross-cluster capacity is not free. Paying for idle headroom in every zone is the cost of surviving a zone loss without degrading.",
      "Remote discovery makes failover fast, which can also make an overload fast. The control plane cannot enforce the survivor's capacity limit.",
      "A degraded response is often cheaper than cross-cluster failover, but it requires a product decision about which requests can be shed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "failover-capacity",
    question:
      "A cluster fails and the mesh shifts all traffic to the other cluster. Latency and errors rise there. What do you check first, and what would you change?",
    difficulty: 4,
    hints: [
      "Separate discovery from capacity.",
      "The survivor was already serving its own traffic.",
    ],
    answer:
      "I would compare the survivor's request rate with its measured safe capacity, including its own baseline load, before touching the mesh. If the shifted demand puts it above capacity, the failover rule is the problem, not the remote service. I would cap the shift at the survivor's free headroom, keep as much traffic local as possible, and shed non-critical traffic. Then I would check whether the remote cluster is queueing or rejecting connections, and whether locality preference is still keeping healthy local endpoints in use. Full failover is only safe when the survivor can absorb the entire failed cluster's peak.",
    followUps: [
      "How would you calculate a safe failover share?",
      "What would you do if neither cluster has enough headroom?",
      "Which metric tells you the remote cluster is queueing rather than failing fast?",
    ],
    redFlags: [
      "Assumes remote discovery adds capacity.",
      "Moves 100% of traffic without checking the survivor.",
      "Adds capacity before checking the failover policy.",
    ],
    rubric: [
      "Separates reachability from capacity.",
      "Uses the survivor's baseline load.",
      "Names a partial shift or load shedding.",
      "Checks queueing and locality.",
    ],
  },
  {
    id: "locality-preference",
    question:
      "Cross-zone traffic and cost rise after a mesh rollout, but error rates are flat. What changed, and how do you confirm it?",
    difficulty: 3,
    hints: [
      "Flat errors do not mean flat routing.",
      "Look at the share of requests served by remote endpoints.",
    ],
    answer:
      "The likely change is locality preference or priority configuration: the proxy stopped preferring local endpoints, or local endpoints were marked unhealthy or over capacity, so traffic spilled to another zone. I would split request rate by source zone and upstream zone, then compare the cross-zone share with the rollout time. I would check the mesh load balancing policy, locality-aware settings, and endpoint health in the local zone. If local endpoints are healthy and under capacity, restoring local preference should bring the share down without changing error rates.",
    followUps: [
      "What would make local endpoints look unhealthy?",
      "How would you measure the cost per zone pair?",
      "When would you intentionally keep cross-zone traffic?",
    ],
    redFlags: [
      "Treats flat errors as proof that routing is unchanged.",
      "Changes capacity before checking locality.",
      "Ignores zone tags on metrics.",
    ],
    rubric: [
      "Names locality preference or priority.",
      "Splits traffic by zone pair.",
      "Checks local endpoint health.",
      "Connects routing to cost.",
    ],
  },
  {
    id: "multi-zone-discovery",
    question:
      "How does a multi-zone mesh make a service in another zone discoverable, and what does that not guarantee?",
    difficulty: 3,
    hints: [
      "There is a global control plane and a per-zone control plane.",
      "Discovery is about addresses, not resources.",
    ],
    answer:
      "The global control plane distributes service and endpoint information to the zone control planes, which configure the local data plane proxies. A proxy then has a remote endpoint set it can route to, often through a zone ingress. That guarantees the proxy knows an address; it does not guarantee that the remote zone has capacity, that the network path meets the latency budget, or that the remote policy allows the request. Those are separate checks: capacity, path, and authorization.",
    followUps: [
      "What role does zone ingress play?",
      "How would you test discovery without testing capacity?",
      "What happens when the global control plane is unavailable?",
    ],
    redFlags: [
      "Says discovery automatically load balances across clusters.",
      "Ignores zone ingress and egress.",
      "Confuses endpoint presence with endpoint health.",
    ],
    rubric: [
      "Names global and zone control planes.",
      "Explains endpoint distribution.",
      "Lists capacity, path, and policy as separate concerns.",
      "Mentions zone ingress.",
    ],
  },
  {
    id: "failover-test",
    question:
      "How would you test cross-cluster failover before relying on it?",
    difficulty: 4,
    hints: [
      "Test at peak, not average.",
      "Test the survivor's own failure modes too.",
    ],
    answer:
      "I would run the failover at peak demand with the same policies, quotas, and autoscaling limits as production. I would measure the survivor's load, queue depth, error rate, and p99, and verify that the shift stops at a safe share. I would also fail the global control plane path, the zone ingress, and one remote endpoint set, because those are separate dependencies. Finally I would test the return path: when the failed cluster comes back, traffic must move back without a second overload or a flush of stale connections.",
    followUps: [
      "What would you assert in the test?",
      "How would you test partial failover?",
      "What could make the return path fail?",
    ],
    redFlags: [
      "Tests failover at average load.",
      "Checks only that endpoints are reachable.",
      "Ignores the failback path.",
    ],
    rubric: [
      "Tests at peak.",
      "Measures survivor capacity and latency.",
      "Tests control plane and ingress separately.",
      "Includes failback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every cross-cluster service has a measured safe capacity per zone and a documented failover share.",
      "The failover share is sized to the survivor's free headroom at peak, not to average load.",
      "Locality preference is enabled and tested while local endpoints are healthy.",
      "Zone ingress and egress capacity is included in the failover calculation.",
      "Dashboards split request rate, errors, and latency by source zone and upstream zone.",
      "A degraded response or load-shedding path exists for traffic that cannot be served locally or remotely.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare total demand with total healthy capacity before changing routing.",
      "Check whether the failover shifted a fixed share or all traffic.",
      "Check the survivor's own baseline load and queue depth.",
      "Reduce the failover share or shed non-critical traffic before adding capacity.",
      "Watch cross-zone latency and egress cost as the share changes.",
      "Record the routing change and the time it took effect.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Return traffic in stages and verify the local cluster is stable.",
      "Re-run the failover at peak with the same policies and limits.",
      "Review whether the survivor's capacity matches the documented failover share.",
      "Check for stale remote endpoints after the failed cluster returns.",
      "Document the availability and cost tradeoff that was accepted.",
    ],
  },
];

const references = [
  {
    title: "Kuma multi-zone deployment",
    url: "https://kuma.io/docs/latest/production/deployment/multi-zone/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Global and zone control planes, zone ingress and egress, and cross-zone service discovery.",
  },
  {
    title: "Envoy locality weighted load balancing",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/locality_weight",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "How locality weights and priorities decide whether traffic stays local or fails over.",
  },
  {
    title: "Kuma locality-aware load balancing",
    url: "https://kuma.io/docs/latest/policies/locality-aware/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Keeping traffic in a zone while endpoints are healthy, with spillover as health degrades.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cross-cluster": {
      model: crossClusterModel,
      presets,
      instructions:
        "Start Healthy, then apply Peak and Full failover. Read remote cluster load before failed requests. Compare Partial failover and Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Cluster capacities, latency, and the error curve are teaching values, not Kuma defaults or provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-locality", "mesh-failover", "mesh-traffic-splitting", "reliability-multi-region", "traffic-zonal-isolation"],
};
