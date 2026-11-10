import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOSTS = 20;
const HOST_CAPACITY = 600;
const TOTAL_CAPACITY = HOSTS * HOST_CAPACITY;
const MAX_RATE = 20_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: MAX_RATE,
    step: 250,
    value: 9_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests entering the cluster. There are 20 endpoints, each with an illustrative capacity of 600 rps.",
    format: "rps" as const,
  },
  {
    id: "failingEndpoints",
    label: "Failing endpoints",
    min: 0,
    max: 10,
    step: 1,
    value: 0,
    unit: "",
    group: "Fault",
    help: "Endpoints that return errors on every request. The remaining endpoints are healthy until the cluster is overloaded.",
    format: "count" as const,
  },
  {
    id: "consecutiveErrors",
    label: "Consecutive errors",
    min: 1,
    max: 10,
    step: 1,
    value: 5,
    unit: "",
    group: "Detector",
    help: "Errors in a row before a host is ejected. A lower value reacts faster and mistakes normal blips for bad hosts.",
    format: "count" as const,
  },
  {
    id: "maxEjectionPercent",
    label: "Max ejection percent",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Detector",
    help: "Cap on the share of endpoints that may be ejected at once. Kuma ejects at least one host even at a low cap.",
    format: "percent" as const,
  },
  {
    id: "baseEjectionTime",
    label: "Base ejection time",
    min: 5,
    max: 120,
    step: 5,
    value: 30,
    unit: " s",
    group: "Detector",
    help: "How long an ejected host stays out. Repeated ejections multiply this base time in Envoy.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rate: number;
  failing: number;
  consecutive: number;
  maxPct: number;
  baseTime: number;
  ejected: number;
  active: number;
  capacity: number;
  overload: number;
  badActive: number;
  goodActive: number;
  badShare: number;
  errorRate: number;
  capacityLoss: number;
  ejectedPct: number;
  p99: number;
  maxEjected: number;
  pressure: number;
}

function stateFor(p: Params, ejected: number, dt: number): Computed {
  const rate = Math.max(1, Math.round(num(p, "requestRate", 9_000)));
  const failing = Math.max(0, Math.round(num(p, "failingEndpoints", 0)));
  const consecutive = Math.max(1, Math.round(num(p, "consecutiveErrors", 5)));
  const maxPct = clamp(num(p, "maxEjectionPercent", 10), 0, 100);
  const baseTime = Math.max(1, num(p, "baseEjectionTime", 30));
  const maxEjected = Math.max(1, Math.round((HOSTS * maxPct) / 100));
  const activeBefore = clamp(HOSTS - ejected, 0, HOSTS);
  const capacityBefore = activeBefore * HOST_CAPACITY;
  const overloadBefore = rate > capacityBefore ? (rate - capacityBefore) / Math.max(1, rate) : 0;
  const badBefore = clamp(failing - ejected, 0, activeBefore);
  const goodBefore = activeBefore - badBefore;
  const pressure = ((badBefore + goodBefore * overloadBefore) * 2.5) / consecutive;
  const returns = ejected / baseTime;
  const nextEjected = clamp(ejected + (pressure - returns) * dt, 0, Math.min(HOSTS, maxEjected));
  const active = clamp(HOSTS - nextEjected, 0, HOSTS);
  const capacity = active * HOST_CAPACITY;
  const overload = rate > capacity ? (rate - capacity) / Math.max(1, rate) : 0;
  const badActive = clamp(failing - nextEjected, 0, active);
  const goodActive = active - badActive;
  const badShare = active > 0 ? badActive / active : 1;
  const errorRate = active > 0 ? badShare + (1 - badShare) * overload : 1;
  return {
    rate,
    failing,
    consecutive,
    maxPct,
    baseTime,
    ejected: nextEjected,
    active,
    capacity,
    overload,
    badActive,
    goodActive,
    badShare,
    errorRate: errorRate * 100,
    capacityLoss: 100 - (capacity / TOTAL_CAPACITY) * 100,
    ejectedPct: (nextEjected / HOSTS) * 100,
    p99: 120 + overload * 1_500 + badShare * 250,
    maxEjected,
    pressure,
  };
}

function healthFor(pct: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (pct >= crit) return "crit";
  if (pct >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const errorHealth = healthFor(c.errorRate, 2, 8);
  const poolHealth = healthFor(c.capacityLoss, 15, 30);
  const badRps = c.rate * c.badShare;
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: errorHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `${c.rate.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge Envoy",
        kind: "mesh",
        health: errorHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: "outlier detection",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: errorHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `${c.failing} failing of ${HOSTS}`,
        meta: { view: "flow" },
      },
      {
        id: "pool",
        label: "Endpoint pool",
        kind: "mesh",
        health: poolHealth,
        utilization: c.active / HOSTS,
        throughput: c.rate * (1 - c.errorRate / 100),
        sublabel: `${c.active.toFixed(1)} active · ${c.ejected.toFixed(1)} ejected`,
        detail: `${c.ejected.toFixed(1)} of ${HOSTS} hosts ejected. Remaining capacity ${Math.round(c.capacity).toLocaleString()} of ${TOTAL_CAPACITY.toLocaleString()} rps. Ejection cap ${c.maxEjected} hosts.`,
        meta: { view: "flow" },
      },
      {
        id: "bad",
        label: "Failing endpoints",
        kind: "service",
        health: c.badActive > 0 ? "crit" : "ok",
        utilization: clamp(c.badActive / HOSTS),
        throughput: badRps,
        sublabel: `${c.badActive.toFixed(1)} serving errors`,
        meta: { view: "flow" },
      },
      {
        id: "good",
        label: "Healthy endpoints",
        kind: "service",
        health: c.overload > 0.05 ? "crit" : c.overload > 0 ? "warn" : "ok",
        utilization: clamp(c.goodActive / HOSTS),
        throughput: c.rate * (1 - c.badShare),
        sublabel: c.overload > 0 ? `${Math.round(c.overload * 100)}% over capacity` : "within capacity",
        detail: `Healthy hosts return errors only when the remaining capacity is below demand. Overload is ${(c.overload * 100).toFixed(1)}% of requests.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-edge", "clients", "edge", c.rate / MAX_RATE, errorHealth),
      edge("edge-checkout", "edge", "checkout", c.rate / MAX_RATE, errorHealth),
      edge("checkout-pool", "checkout", "pool", c.rate / MAX_RATE, poolHealth),
      edge("pool-bad", "pool", "bad", c.rate / MAX_RATE, c.badActive > 0 ? "crit" : "ok"),
      edge("pool-good", "pool", "good", c.rate / MAX_RATE, errorHealth),
    ],
    metrics: [
      metric("error-rate", "User error rate", c.errorRate, "%", 2, 8, "percent"),
      metric("capacity-loss", "Capacity lost to ejection", c.capacityLoss, "%", 15, 30, "percent"),
      metric("ejected-pct", "Hosts ejected", c.ejectedPct, "%", 20, 40, "percent"),
      metric("p99", "End-to-end p99", c.p99, "ms", 500, 1_500, "ms"),
      metric("active-hosts", "Active endpoints", c.active, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      ejected: c.ejected,
      errorRate: c.errorRate,
      overload: c.overload,
      capacity: c.capacity,
    },
    summary: `${c.ejected.toFixed(1)} of ${HOSTS} hosts ejected, ${Math.round(c.capacity).toLocaleString()} rps capacity, ${Math.round(c.errorRate)}% errors.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  items.push(`${c.ejected.toFixed(1)} of ${HOSTS} hosts are ejected. Remaining capacity is ${Math.round(c.capacity).toLocaleString()} of ${TOTAL_CAPACITY.toLocaleString()} rps.`);
  if (c.badActive > 0) {
    items.push(`${c.badActive.toFixed(1)} failing hosts are still active. Outlier detection needs enough requests to observe ${c.consecutive} consecutive errors.`);
  }
  if (c.overload > 0) {
    items.push(`${Math.round(c.overload * 100)}% of requests exceed the remaining capacity. Healthy hosts can return errors under that overload, which looks like more evidence for ejection.`);
  }
  if (c.ejected >= c.maxEjected - 0.01) {
    items.push(`Ejection is capped at ${c.maxEjected} hosts by max ejection percent. Raising the cap allows more capacity to be removed, not more traffic to be served.`);
  }
  items.push("Outlier detection is per proxy. One sidecar can eject a host while another still sends it traffic, so the host's server metrics may show a partial load rather than zero.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 2,
    crit: 8,
    title: "Users are seeing errors from the endpoint pool",
    cause: "Failing endpoints are still serving, or ejection removed so much capacity that the remaining hosts cannot serve the request rate. Both produce 5xx responses, and both can feed the same detector.",
    fix: "Check how many hosts are ejected and why before changing the threshold. If the remaining capacity is below demand, the priority is to restore capacity or shed load, not to eject more hosts.",
    checkFirst: [
      "How many hosts are active, and how many are ejected?",
      "Which detector fired: consecutive errors, gateway errors, or success rate?",
      "Is the error rate coming from the failing hosts or from overloaded healthy hosts?",
    ],
  },
  {
    id: "capacity-loss",
    metricId: "capacity-loss",
    warn: 15,
    crit: 30,
    title: "Ejection has removed a large share of capacity",
    cause: "The max ejection percentage is high enough to remove healthy hosts, or the detector is treating overload errors as proof that every host is bad. Capacity loss feeds back into more overload.",
    fix: "Lower max ejection percent to a level the remaining hosts can absorb, and raise the consecutive error threshold so transient blips do not eject a host. Restore ejected hosts before raising traffic.",
    checkFirst: [
      "Compare capacity after ejection with the current request rate.",
      "Check whether the error rate rose before or after the first ejections.",
      "Check the max ejection percent and the base ejection time.",
    ],
  },
  {
    id: "ejected-pct",
    metricId: "ejected-pct",
    warn: 20,
    crit: 40,
    title: "A large share of the endpoint pool is ejected",
    cause: "A low consecutive error threshold or a high ejection cap lets the detector remove many hosts. In a correlated failure, every host can look bad at the same time.",
    fix: "Cap ejection at a share that leaves enough capacity for the traffic, and use a longer consecutive count or a success-rate detector with a request volume floor.",
    checkFirst: [
      "Did ejections start before or after the error rate rose?",
      "Is the failure isolated to a few hosts or shared by all of them?",
      "Would the panic threshold return traffic to all hosts?",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "Latency is rising as capacity shrinks",
    cause: "Fewer active hosts carry the same traffic. Queueing at the remaining hosts raises latency, and overload can produce the errors that trigger more ejection.",
    fix: "Restore capacity by lowering the ejection percentage or waiting out the base ejection time. Reduce traffic if the pool cannot serve it with the hosts that remain.",
    checkFirst: [
      "Compare per-host request rate before and after ejection.",
      "Check whether the latency is queueing at the remaining hosts.",
      "Check whether ejected hosts are returning and being ejected again.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const outlierModel: SimModel = {
  id: "mesh-outlier-detection",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(stateFor(defaults(), 0, 0), seed),
  step: (frame, p, dt, rng) => {
    const previousEjected = Math.max(0, Number(frame.flags.ejected ?? 0));
    const computed = stateFor(p, previousEjected, dt);
    const jittered = { ...computed, p99: Math.max(1, computed.p99 * (1 + rng.between(-0.01, 0.01))) };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) recordSeries(next, `load.${node.id}`, (node.utilization ?? 0) * 100);
    if (computed.ejected > 0.01 && previousEjected <= 0.01 && frame.flags.ejectedSeen !== 1) {
      pushEvent(next, {
        id: "host-ejected",
        at: frame.t,
        severity: "warn",
        title: "Outlier detection ejected a host",
        detail: `A host crossed ${computed.consecutive} consecutive errors and was removed for ${computed.baseTime}s. The pool now has ${computed.active.toFixed(1)} active hosts.`,
        nodeId: "pool",
        metricId: "ejected-pct",
      });
      next.flags.ejectedSeen = 1;
    }
    if (computed.ejected >= computed.maxEjected - 0.01 && computed.maxEjected < HOSTS && frame.flags.capSeen !== 1) {
      pushEvent(next, {
        id: "ejection-cap",
        at: frame.t,
        severity: "warn",
        title: "Ejection cap reached",
        detail: `The pool has ejected ${computed.maxEjected} hosts, the limit set by ${computed.maxPct}% max ejection. Further bad hosts cannot be removed.`,
        nodeId: "pool",
        metricId: "ejected-pct",
      });
      next.flags.capSeen = 1;
    }
    if (computed.overload > 0 && frame.flags.overloadSeen !== 1) {
      pushEvent(next, {
        id: "capacity-below-demand",
        at: frame.t,
        severity: "crit",
        title: "Remaining capacity is below demand",
        detail: `${Math.round(computed.capacity).toLocaleString()} rps of capacity remains for ${Math.round(computed.rate).toLocaleString()} rps of traffic. Healthy hosts are now overloaded, which can trigger more ejections.`,
        nodeId: "good",
        metricId: "error-rate",
      });
      next.flags.overloadSeen = 1;
    }
    if (computed.active <= 0.01 && frame.flags.allEjectedSeen !== 1) {
      pushEvent(next, {
        id: "all-hosts-ejected",
        at: frame.t,
        severity: "crit",
        title: "The endpoint pool has no active hosts",
        detail: "Every host was ejected. The cluster cannot serve traffic until the base ejection time returns a host.",
        nodeId: "pool",
        metricId: "capacity-loss",
      });
      next.flags.allEjectedSeen = 1;
    }
    next.summary = `${computed.ejected.toFixed(1)} of ${HOSTS} hosts ejected, ${Math.round(computed.capacity).toLocaleString()} rps capacity, ${Math.round(computed.errorRate)}% errors.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => insightsFor(stateFor(p, Math.max(0, Number(frame.flags.ejected ?? 0)), 0)),
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
    description: "No failing hosts, 9,000 rps against 12,000 rps of capacity. Nothing is ejected.",
    tone: "ok",
    params: defaults({ requestRate: 9_000, failingEndpoints: 0, consecutiveErrors: 5, maxEjectionPercent: 10, baseEjectionTime: 30 }),
  },
  {
    id: "peak",
    label: "Two bad hosts",
    description: "Two hosts fail at 11,200 rps. Five consecutive errors eject both, leaving 18 hosts, just below the traffic.",
    tone: "warn",
    params: defaults({ requestRate: 11_200, failingEndpoints: 2, consecutiveErrors: 5, maxEjectionPercent: 10, baseEjectionTime: 30 }),
  },
  {
    id: "failure",
    label: "Aggressive ejection",
    description: "Three hosts fail, the detector needs only one error, and the cap allows 60% ejection. Capacity collapses.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, failingEndpoints: 3, consecutiveErrors: 1, maxEjectionPercent: 60, baseEjectionTime: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The bad hosts are gone, traffic is back inside capacity, and no ejection is active.",
    tone: "ok",
    params: defaults({ requestRate: 9_000, failingEndpoints: 0, consecutiveErrors: 5, maxEjectionPercent: 10, baseEjectionTime: 30 }),
  },
  {
    id: "over-eject",
    label: "Overload spiral",
    description: "No host is failing, but traffic is 4% above capacity. Healthy hosts return errors, the detector ejects them, and capacity falls further.",
    tone: "crit",
    params: defaults({ requestRate: 12_500, failingEndpoints: 0, consecutiveErrors: 1, maxEjectionPercent: 100, baseEjectionTime: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-eject-fleet",
  title: "Predict the over-ejection",
  simId: "outlier-detection",
  question:
    "One host fails. You set consecutive errors to 1 and max ejection percent to 100%, then traffic rises 4% above the cluster's capacity. What happens?",
  prediction: {
    options: [
      { id: "one", label: "Only the failing host is ejected; the rest of the pool serves the traffic" },
      { id: "fleet", label: "Healthy hosts also return errors under overload, get ejected, and the pool collapses" },
      { id: "cap", label: "The ejection cap prevents any host from being removed" },
      { id: "panic", label: "The panic threshold disables outlier detection automatically" },
    ],
    correctOptionId: "fleet",
    explanation:
      "Outlier detection observes errors, not causes. At 4% above capacity, healthy hosts also return errors. With a threshold of one consecutive error and no meaningful ejection cap, those errors eject healthy hosts. Each ejection reduces capacity, which increases overload, which produces more errors. The loop removes the pool even though only one host was actually broken.",
  },
  setup: defaults({ requestRate: 12_500, failingEndpoints: 1, consecutiveErrors: 1, maxEjectionPercent: 100, baseEjectionTime: 60 }),
  runFor: 40,
  observe: [
    "The first ejection removes the failing host, then capacity falls below demand.",
    "Healthy hosts start returning errors and are ejected in turn.",
    "Ejected hosts approaches 100% and capacity approaches zero within the run.",
    "The error rate rises even though only one host was initially broken.",
  ],
  explain:
    "The detector cannot tell a host that is broken from a host that is overloaded. It only sees failed requests. Once ejection removes enough capacity, the remaining hosts are overloaded and fail, which looks like fresh evidence. A low consecutive threshold speeds the decision and a high maximum ejection percentage removes the guardrail. The system converts a single bad host into a fleet outage.",
  fix: defaults({ requestRate: 9_000, failingEndpoints: 1, consecutiveErrors: 5, maxEjectionPercent: 10, baseEjectionTime: 30 }),
  debrief:
    "With five consecutive errors and a 10% cap, only the bad host is ejected and the pool keeps 95% of its capacity. The remaining hosts stay below capacity, so they do not generate the errors that would eject them. Detection is useful when it is a scalpel; it becomes an amplifier when it removes capacity faster than the service can absorb.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Outlier detection is Envoy's passive health check. It watches the responses that real requests receive from each host in a cluster and ejects a host that looks worse than its peers. It does not send probe traffic. The detectors count consecutive 5xx responses, consecutive gateway failures, or a success rate below a threshold. Kuma exposes the same idea through its circuit breaker detectors for total errors, gateway errors, local errors, standard deviation, and failure percentage.",
  },
  {
    type: "p",
    text: "Ejection is temporary. A host returns after the base ejection time, and repeated ejections multiply that time. Envoy's max ejection percent bounds how much of the cluster can be removed at once; Kuma documents a default of 10% and notes that at least one host is ejected even at a low cap. The consecutive error default is 5 and the base ejection time default is 30 seconds.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The detector runs inside each proxy, against its view of the cluster. One sidecar can eject a host while another still sends it traffic. That is useful for a localized network problem and confusing for a shared application bug: the host is not down, it is just removed from one proxy's load balancer. Active health checks are the complement; they probe hosts even without traffic and can catch a dead process that receives no requests.",
  },
  {
    type: "compare",
    leftTitle: "Passive outlier detection",
    rightTitle: "Active health check",
    rows: [
      { label: "Traffic", left: "Uses live requests", right: "Sends probes on a schedule" },
      { label: "Detects", left: "Elevated errors versus peers", right: "Failed probes and dead processes" },
      { label: "Needs volume", left: "Yes; low traffic hides failures", right: "No; probes run regardless" },
      { label: "Risk", left: "Ejects healthy hosts under correlated load", right: "Adds probe load and its own false positives" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Active and ejected hosts, plus the capacity that remains after ejection.",
      "Capacity lost to ejection and the share of the pool that is ejected.",
      "User error rate and p99, which rise as the remaining hosts carry more traffic.",
      "A flow view of the clients, edge proxy, service, endpoint pool, failing hosts, and healthy hosts.",
      "Events for the first ejection, the ejection cap, capacity below demand, and an empty pool.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply One bad host to see a clean ejection. Apply Aggressive ejection to watch capacity collapse. Finally, run Overload spiral: no host is broken at the start, but the detector still removes the pool. Run the experiment before opening the debrief.",
  },
  {
    type: "table",
    headers: ["Setting", "What it controls", "Too aggressive", "Too conservative"],
    rows: [
      ["Consecutive errors", "Evidence before ejection", "Normal blips eject hosts", "Bad hosts serve too long"],
      ["Max ejection percent", "Share of the pool that can be removed", "Capacity collapses under load", "A bad host may stay in rotation"],
      ["Base ejection time", "How long a host stays out", "Capacity returns slowly", "A flapping host returns too soon"],
      ["Panic threshold", "Healthy capacity floor", "Traffic returns to bad hosts", "The pool serves with very little capacity"],
    ],
  },
  { type: "sim", simId: "outlier-detection" },
  { type: "experiment", experimentId: "predict-eject-fleet" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the one-bad-host preset, five consecutive errors ejected the failing host. Nineteen hosts remained, capacity stayed above demand, and the only errors were the share that had been sent to the bad host before ejection. The pool recovered when the host returned and was re-evaluated.",
  },
  {
    type: "p",
    text: "In the aggressive preset, the detector needed one error and the cap allowed 60% ejection. Three failing hosts were removed quickly, then the remaining capacity fell below the request rate. Healthy hosts returned errors under the overload, which the detector counted as fresh evidence, and more hosts were ejected. Capacity loss became the outage.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cluster outlier detection counters: active ejections, total ejections, and ejections that were blocked by the cap.",
      "Per-detector counters for consecutive 5xx, gateway failures, local origin failures, and success rate.",
      "Per-host request rate and error rate. An ejected host's traffic falls only for the proxy that ejected it.",
      "Remaining cluster capacity compared with the current request rate, not with the provisioned host count.",
      "The time since the last ejection and the base ejection time, to explain why a host is still out.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count active and ejected hosts before changing the threshold. Then ask whether the errors started before or after the first ejection. If errors followed ejection, the detector is amplifying a capacity problem. If errors preceded it, a host really is bad.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the spiral: lower max ejection percent or raise the consecutive error threshold so the pool keeps enough capacity to serve traffic.",
      "Restore capacity by letting ejected hosts return, or add hosts if the traffic is legitimate. Do not raise the cap to fix an overload.",
      "Separate the causes: check whether the failing hosts share a deployment, zone, or dependency. A correlated failure is not an outlier.",
      "Use a success-rate detector with a request volume floor for low-traffic services; consecutive errors need enough requests to be meaningful.",
      "Tune the ejection time and the panic threshold so a recovering pool does not oscillate between full and empty.",
      "Re-run the failure with the detector disabled to see the real capacity requirement, then set the cap below it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Aggressive detection removes a bad host quickly and removes healthy capacity just as quickly when the failure is shared.",
      "A high ejection cap protects users from one bad host and exposes them to a smaller pool. The cap should leave enough capacity for the traffic.",
      "A long ejection time gives a host room to recover and keeps capacity out of rotation while it does.",
      "Passive detection needs traffic. A quiet service can hide a broken host until the first real request arrives.",
      "Per-proxy ejection is fast and local, but it makes the host's load and the fleet's view inconsistent.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "healthy-ejected",
    question:
      "One pod returns errors, but Envoy ejects several healthy pods too. What is your hypothesis, and what do you check?",
    difficulty: 4,
    hints: [
      "The detector sees responses, not root causes.",
      "Ejection changes the capacity that the remaining hosts must serve.",
    ],
    answer:
      "I would suspect a capacity spiral. After the first ejection, the remaining hosts carry more traffic, so they start returning errors. If the consecutive threshold is low and the max ejection percentage is high, those overload errors look like more bad hosts and the detector ejects them too. I would check the order of events: did the error rate rise before or after the first ejection? I would compare remaining capacity with the request rate, check the ejection cap, and look at whether the errors are concentrated on one host or spread across the pool. The fix is to restore capacity and lower the ejection cap, not to disable detection.",
    followUps: [
      "How would you prove the healthy hosts were overloaded rather than broken?",
      "What would the per-host request rate look like?",
      "When would you use active health checks instead?",
    ],
    redFlags: [
      "Blaming the healthy pods.",
      "Raises the ejection cap to remove the bad host.",
      "Disables outlier detection entirely.",
    ],
    rubric: [
      "Names the capacity feedback loop.",
      "Checks event order and capacity.",
      "Uses per-host traffic.",
      "Restores capacity before tuning.",
    ],
  },
  {
    id: "tune-detector",
    question:
      "How would you choose consecutive errors, max ejection percent, and base ejection time for a 20-host service?",
    difficulty: 3,
    hints: [
      "Start from the capacity you can afford to lose.",
      "Low-traffic services need different detectors.",
    ],
    answer:
      "I would start with capacity: the cap should leave enough hosts to serve peak traffic with headroom, so 10% to 20% is a common starting range, not 100%. The consecutive error count should be high enough that a single blip does not eject a host, but low enough that a consistently bad host leaves quickly. For a low-traffic service, consecutive counts are weak because few requests arrive, so a success-rate detector with a request volume floor is better. The base ejection time should give the host time to recover without keeping capacity out for too long. I would test the settings against a single bad host and a correlated overload, and verify that the second case does not empty the pool.",
    followUps: [
      "What changes if the service has only three hosts?",
      "How does the panic threshold interact with the cap?",
      "What metric tells you the cap is too high?",
    ],
    redFlags: [
      "Sets the cap to 100%.",
      "Uses one consecutive error for every service.",
      "Ignores the remaining capacity.",
    ],
    rubric: [
      "Starts from capacity.",
      "Sets a meaningful consecutive count.",
      "Adapts to traffic volume.",
      "Tests correlated failure.",
    ],
  },
  {
    id: "passive-vs-active",
    question:
      "When would you rely on outlier detection, and when do you need an active health check?",
    difficulty: 2,
    hints: [
      "One needs traffic; the other sends probes.",
      "Think about a host that is dead but idle.",
    ],
    answer:
      "Outlier detection is useful when the service has enough traffic to judge each host, and when the failure is visible in responses: elevated 5xx, gateway errors, or a success rate below its peers. It reacts to real request outcomes and needs no probe configuration. An active health check is better when traffic is low, when a host must be removed before the first user request, or when the process can be dead while the load balancer still considers it healthy. Most production meshes use both: active checks for liveness and outlier detection for response quality.",
    followUps: [
      "What does an active check add in cost?",
      "Can outlier detection catch a host that never receives traffic?",
      "How do the two interact when a host is failing both?",
    ],
    redFlags: [
      "Uses outlier detection as the only health signal.",
      "Assumes passive detection works without traffic.",
      "Ignores probe false positives.",
    ],
    rubric: [
      "Matches detector to traffic volume.",
      "Explains response-based detection.",
      "Names the idle-host gap.",
      "Combines both signals.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every service has a documented ejection cap that leaves enough capacity for peak traffic.",
      "Consecutive error thresholds are set from traffic volume, not copied blindly.",
      "The panic threshold and active health checks are configured where the service needs them.",
      "Dashboards show active hosts, ejected hosts, and remaining capacity together.",
      "A load test covers one bad host and a correlated overload.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Count active and ejected hosts before changing a threshold.",
      "Check whether errors started before or after the first ejection.",
      "Compare remaining capacity with the request rate.",
      "Lower the ejection cap or restore hosts if capacity is the problem.",
      "Do not raise the cap to remove more hosts during an overload.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-test the detector against a single bad host and a shared dependency failure.",
      "Check whether the base ejection time caused a host to return too early or too late.",
      "Review per-proxy ejection divergence for shared application bugs.",
      "Add a capacity alarm that fires before the pool is exhausted.",
      "Document the ejection policy and who owns it.",
    ],
  },
];

const references = [
  {
    title: "Envoy outlier detection",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Passive health checking, consecutive error detectors, success rate, ejection time, and max ejection percent.",
  },
  {
    title: "Envoy outlier detection configuration",
    url: "https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/outlier_detection.proto",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Field-level reference for consecutive errors, ejection percentage, interval, and panic threshold.",
  },
  {
    title: "Kuma circuit breaker detectors",
    url: "https://kuma.io/docs/latest/policies/circuit-breaker/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Detector types, default consecutive counts, base ejection time, and max ejection percent.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "outlier-detection": {
      model: outlierModel,
      presets,
      instructions:
        "Start Healthy, apply One bad host, then Aggressive ejection and Overload spiral. Watch capacity loss and the order of errors versus ejections.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Host count, per-host capacity, ejection speed, and error shares are teaching values, not Envoy or Kuma defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-circuit-breaking", "mesh-envoy-clusters", "mesh-failover", "mesh-traffic-splitting"],
};
