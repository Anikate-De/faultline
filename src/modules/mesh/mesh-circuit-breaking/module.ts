import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_RATE = 30_000;
const UPSTREAM_CAPACITY = 8_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: MAX_RATE,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests entering the mesh. Concurrency demand is request rate multiplied by upstream latency, divided by 1,000.",
    format: "rps" as const,
  },
  {
    id: "upstreamLatency",
    label: "Upstream latency",
    min: 50,
    max: 1_500,
    step: 50,
    value: 150,
    unit: " ms",
    group: "Upstream",
    help: "Time each in-flight request holds a connection. At a fixed request rate, doubling latency doubles the concurrency the upstream needs.",
    format: "ms" as const,
  },
  {
    id: "maxConnections",
    label: "Max connections",
    min: 100,
    max: 15_000,
    step: 100,
    value: 2_000,
    unit: "",
    group: "Breaker",
    help: "Connection cap per proxy for this cluster. The model treats each connection as one concurrent request, so this is the concurrency limit.",
    format: "count" as const,
  },
  {
    id: "maxPendingRequests",
    label: "Max pending requests",
    min: 10,
    max: 2_000,
    step: 10,
    value: 500,
    unit: "",
    group: "Breaker",
    help: "Requests allowed to wait for a connection. Beyond this cap, the proxy rejects locally instead of queueing.",
    format: "count" as const,
  },
  {
    id: "concurrentRetries",
    label: "Concurrent retries",
    min: 0,
    max: 10,
    step: 1,
    value: 2,
    unit: "",
    group: "Breaker",
    help: "Retries the proxy may run in parallel. Retries consume the same connection and pending budgets as new requests.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rate: number;
  latency: number;
  maxConnections: number;
  maxPending: number;
  retries: number;
  baseConcurrency: number;
  demand: number;
  pending: number;
  localError: number;
  upstreamAdmitted: number;
  upstreamLoad: number;
  upstreamOverload: number;
  errorRate: number;
  p99: number;
  connUtil: number;
  pendingUtil: number;
  amplification: number;
}

function compute(p: Params, jitter = 0): Computed {
  const rate = Math.max(1, Math.round(num(p, "requestRate", 8_000)));
  const latency = Math.max(1, num(p, "upstreamLatency", 150));
  const maxConnections = Math.max(1, num(p, "maxConnections", 2_000));
  const maxPending = Math.max(0, num(p, "maxPendingRequests", 500));
  const retries = Math.max(0, Math.round(num(p, "concurrentRetries", 2)));
  const baseConcurrency = (rate * latency) / 1_000;
  const firstPendingRaw = Math.max(0, baseConcurrency - maxConnections);
  const firstPending = Math.min(maxPending, firstPendingRaw);
  const firstLocal = clamp((firstPendingRaw - firstPending) / Math.max(1, baseConcurrency), 0, 1);
  const demand = baseConcurrency * (1 + firstLocal * retries);
  const pendingRaw = Math.max(0, demand - maxConnections);
  const pending = Math.min(maxPending, pendingRaw);
  const localError = clamp((pendingRaw - pending) / Math.max(1, demand), 0, 1);
  const upstreamAdmitted = demand * (1 - localError);
  const upstreamLoad = (upstreamAdmitted / UPSTREAM_CAPACITY) * 100;
  const upstreamOverload = clamp((upstreamAdmitted - UPSTREAM_CAPACITY) / Math.max(1, upstreamAdmitted), 0, 1);
  const errorRate = (localError + (1 - localError) * upstreamOverload) * 100;
  return {
    rate,
    latency,
    maxConnections,
    maxPending,
    retries,
    baseConcurrency,
    demand,
    pending,
    localError,
    upstreamAdmitted,
    upstreamLoad,
    upstreamOverload,
    errorRate,
    p99: Math.max(1, latency * (1 + pending / Math.max(1, maxConnections)) + upstreamOverload * 2_000 + localError * 400 + jitter),
    connUtil: Math.min(100, (demand / maxConnections) * 100),
    pendingUtil: maxPending > 0 ? (pending / maxPending) * 100 : 0,
    amplification: demand / Math.max(1, baseConcurrency),
  };
}

function healthFor(pct: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (pct >= crit) return "crit";
  if (pct >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const errorHealth = healthFor(c.errorRate, 1, 5);
  const localHealth = c.localError >= 0.05 ? "crit" : c.localError > 0 ? "warn" : "ok";
  const upstreamHealth = c.upstreamOverload >= 0.05 ? "crit" : c.upstreamOverload > 0 ? "warn" : localHealth === "crit" ? "warn" : "ok";
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
        sublabel: `${c.baseConcurrency.toFixed(0)} concurrent`,
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: errorHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `${Math.round(c.latency)} ms upstream`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Envoy sidecar",
        kind: "mesh",
        health: localHealth,
        utilization: clamp(c.demand / Math.max(1, c.maxConnections)),
        throughput: c.rate * c.amplification,
        sublabel: `${Math.round(c.pending)} pending · ${c.amplification.toFixed(1)}× attempts`,
        detail: `Connection cap ${Math.round(c.maxConnections)}, pending cap ${Math.round(c.maxPending)}, ${c.retries} concurrent retries. ${Math.round(c.localError * 100)}% of demand is rejected locally.`,
        meta: { view: "flow" },
      },
      {
        id: "upstream",
        label: "Inventory service",
        kind: "service",
        health: upstreamHealth,
        utilization: clamp(c.upstreamAdmitted / UPSTREAM_CAPACITY),
        throughput: c.rate * (1 - c.localError),
        sublabel: `${Math.round(c.upstreamLoad)}% of upstream capacity`,
        detail: `Teaching capacity is 8,000 concurrent requests. ${Math.round(c.upstreamAdmitted).toLocaleString()} concurrent requests are admitted after local shedding.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-edge", "clients", "edge", c.rate / MAX_RATE, errorHealth),
      edge("edge-checkout", "edge", "checkout", c.rate / MAX_RATE, errorHealth),
      edge("checkout-sidecar", "checkout", "sidecar", c.rate / MAX_RATE, localHealth),
      edge("sidecar-upstream", "sidecar", "upstream", c.rate / MAX_RATE, localHealth),
    ],
    metrics: [
      metric("local-error", "Locally rejected", c.localError * 100, "%", 1, 5, "percent"),
      metric("error-rate", "User error rate", c.errorRate, "%", 1, 5, "percent"),
      metric("pending-util", "Pending cap used", c.pendingUtil, "%", 60, 90, "percent"),
      metric("conn-util", "Connection cap used", c.connUtil, "%", 80, 95, "percent"),
      metric("upstream-load", "Upstream concurrency", c.upstreamLoad, "%", 85, 100, "percent"),
      metric("p99", "End-to-end p99", c.p99, "ms", 500, 1_500, "ms"),
      metric("amplification", "Attempt amplification", c.amplification, "×", 1.5, 2.5, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      localError: c.localError,
      pending: c.pending,
      upstreamLoad: c.upstreamLoad,
      demand: c.demand,
    },
    summary: `${Math.round(c.errorRate)}% errors; ${Math.round(c.localError * 100)}% rejected locally, ${Math.round(c.upstreamLoad)}% upstream concurrency, ${Math.round(c.pending)} pending.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  items.push(`${Math.round(c.rate).toLocaleString()} rps at ${Math.round(c.latency)} ms needs about ${Math.round(c.baseConcurrency).toLocaleString()} concurrent requests. The connection cap is ${Math.round(c.maxConnections)}.`);
  if (c.localError > 0) {
    items.push(`${(c.localError * 100).toFixed(1)}% of requests are rejected at the proxy. That is the breaker protecting the upstream by failing fast locally.`);
  }
  if (c.upstreamOverload > 0) {
    items.push(`${Math.round(c.upstreamLoad)}% upstream concurrency means the limits are loose enough to pass the saturation upstream. The proxy is no longer the bottleneck.`);
  }
  if (c.retries > 0) {
    items.push(`Retries share the connection and pending budgets. With ${c.retries} concurrent retries, the model raises demand by ${(c.amplification - 1).toFixed(2)}× when local errors occur.`);
  }
  items.push("Breaker limits are per proxy per cluster. Ten sidecars with a 1,000-connection cap can each open 1,000 connections; the dependency sees the sum unless the upstream also protects itself.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "local-error",
    metricId: "local-error",
    warn: 1,
    crit: 5,
    title: "The proxy is rejecting requests locally",
    cause: "Concurrency demand exceeded the connection cap plus the pending request cap. The proxy returns an error without sending the request upstream, which protects the dependency but spends the user's request.",
    fix: "Decide whether the limit or the demand is wrong. If the upstream can serve the concurrency, raise the caps with headroom. If it cannot, shed non-critical traffic or scale the upstream before raising limits.",
    checkFirst: [
      "Compare request rate multiplied by latency with the connection cap.",
      "Check pending overflow and connection overflow counters.",
      "Confirm whether the errors are local rejections or upstream failures.",
    ],
  },
  {
    id: "pending-util",
    metricId: "pending-util",
    warn: 60,
    crit: 90,
    title: "The pending request buffer is nearly full",
    cause: "Requests are arriving faster than connections become available. The pending buffer absorbs the mismatch until it hits its cap, then the proxy starts rejecting.",
    fix: "Reduce concurrency demand or raise the pending cap only if the upstream can drain the queue. A large pending buffer turns errors into latency, not into capacity.",
    checkFirst: [
      "Compare pending depth with the cap and with upstream latency.",
      "Check whether the upstream is slow because it is saturated or because one host is bad.",
      "Check whether retries are filling the pending buffer.",
    ],
  },
  {
    id: "upstream-load",
    metricId: "upstream-load",
    warn: 85,
    crit: 100,
    title: "The upstream is at or above its concurrency capacity",
    cause: "The breaker limits are loose enough to admit more concurrent work than the dependency can serve. Raising limits moved the failure upstream instead of removing it.",
    fix: "Tighten the breaker to shed load before the upstream saturates, or add upstream capacity. A breaker is a local protection, not a substitute for capacity planning.",
    checkFirst: [
      "Compare admitted concurrency with the dependency's measured capacity.",
      "Check upstream latency and queue depth at the dependency.",
      "Check whether one slow dependency is holding connections for every caller.",
    ],
  },
  {
    id: "conn-util",
    metricId: "conn-util",
    warn: 80,
    crit: 95,
    title: "The connection cap has little headroom",
    cause: "Concurrency demand is close to the per-proxy connection limit. A latency increase or a traffic spike will push requests into the pending buffer and then into local rejection.",
    fix: "Add headroom only after confirming the upstream can serve it. Otherwise reduce per-request latency, cap retries, or shed low-priority traffic.",
    checkFirst: [
      "Check whether latency rose before the connection count did.",
      "Check the number of sidecars and their individual limits.",
      "Check whether retries are counted against the same pool.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "End-to-end latency is above the user budget",
    cause: "Requests wait in the pending buffer for a connection. Queue wait grows with pending depth, and retries add more work to the same pool.",
    fix: "Reduce demand or raise capacity. Raising the pending cap without draining capacity converts a fast rejection into a slow timeout.",
    checkFirst: [
      "Compare p99 with upstream latency and pending depth.",
      "Check whether the latency is queue wait or upstream service time.",
      "Check whether retries are being sent into the same saturated pool.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const circuitBreakingModel: SimModel = {
  id: "mesh-circuit-breaking",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const jitter = frame.t === 0 ? 0 : rng.between(-3, 3);
    const computed = compute(p, jitter);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) recordSeries(next, `load.${node.id}`, (node.utilization ?? 0) * 100);
    if (computed.localError > 0 && frame.flags.localSeen !== 1) {
      pushEvent(next, {
        id: "local-overflow",
        at: frame.t,
        severity: computed.localError >= 0.05 ? "crit" : "warn",
        title: "Circuit breaker shed load locally",
        detail: `${(computed.localError * 100).toFixed(1)}% of requests exceeded the connection and pending caps. The proxy returned them without calling the upstream.`,
        nodeId: "sidecar",
        metricId: "local-error",
      });
      next.flags.localSeen = 1;
    }
    if (computed.upstreamOverload > 0 && frame.flags.upstreamSeen !== 1) {
      pushEvent(next, {
        id: "upstream-saturated",
        at: frame.t,
        severity: "crit",
        title: "Breaker limits pass saturation to the upstream",
        detail: `${Math.round(computed.upstreamAdmitted).toLocaleString()} concurrent requests reached an upstream with 8,000 of teaching capacity. Local shedding is no longer protecting it.`,
        nodeId: "upstream",
        metricId: "upstream-load",
      });
      next.flags.upstreamSeen = 1;
    }
    next.summary = `${Math.round(computed.errorRate)}% errors; ${Math.round(computed.localError * 100)}% rejected locally, ${Math.round(computed.upstreamLoad)}% upstream concurrency, ${Math.round(computed.pending)} pending.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => insightsFor(compute(p)),
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
    description: "8,000 rps at 150 ms needs 1,200 concurrent requests against a 2,000 connection cap. No pending, no overflow.",
    tone: "ok",
    params: defaults({ requestRate: 8_000, upstreamLatency: 150, maxConnections: 2_000, maxPendingRequests: 500, concurrentRetries: 2 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "12,000 rps at 180 ms uses 86% of the connection cap. Saturated but still serving; the next latency increase will overflow.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, upstreamLatency: 180, maxConnections: 2_500, maxPendingRequests: 500, concurrentRetries: 2 }),
  },
  {
    id: "failure",
    label: "Pending overflow",
    description: "20,000 rps at 600 ms needs 12,000 concurrent requests. The caps admit 1,800, so the proxy rejects most of the load.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, upstreamLatency: 600, maxConnections: 1_500, maxPendingRequests: 300, concurrentRetries: 4 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Traffic falls and latency returns to 150 ms. The cap has headroom and the pending buffer is empty.",
    tone: "ok",
    params: defaults({ requestRate: 8_000, upstreamLatency: 150, maxConnections: 3_000, maxPendingRequests: 500, concurrentRetries: 2 }),
  },
  {
    id: "limits-raised",
    label: "Limits raised",
    description: "The caps are raised to 12,000 connections. Local rejection stops, but 12,000 concurrent requests hit an upstream with 8,000 of capacity.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, upstreamLatency: 600, maxConnections: 12_000, maxPendingRequests: 2_000, concurrentRetries: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-limit-raise",
  title: "Predict what raising the caps moves",
  simId: "circuit-breaking",
  question:
    "The proxy rejects most requests because the pending buffer is full. You raise max connections from 1,500 to 12,000 and max pending from 300 to 2,000. What happens?",
  prediction: {
    options: [
      { id: "fixed", label: "Errors disappear because the breaker now admits the full demand" },
      { id: "moved", label: "Local rejection falls, but the upstream saturates: latency rises and about a third of requests still fail" },
      { id: "same", label: "Nothing changes because retries still overflow the pool" },
      { id: "faster", label: "Latency falls because more connections always mean more throughput" },
    ],
    correctOptionId: "moved",
    explanation:
      "The breaker is a local limit, not extra upstream capacity. At 20,000 rps and 600 ms, demand is 12,000 concurrent requests. The 12,000 connection cap admits all of it, so local rejections stop. The upstream has teaching capacity for 8,000 concurrent requests, so it becomes saturated: queueing moves upstream, latency rises, and about a third of requests fail there. Raising limits removes the local symptom without adding capacity.",
  },
  setup: defaults({ requestRate: 20_000, upstreamLatency: 600, maxConnections: 12_000, maxPendingRequests: 2_000, concurrentRetries: 2 }),
  runFor: 20,
  observe: [
    "Locally rejected falls to zero while upstream concurrency rises above 100%.",
    "The connection cap reads 100% used and the p99 rises above 1.2 seconds.",
    "The event feed switches from local overflow to upstream saturation.",
    "The user error rate falls from near-total local rejection to about 33%, now from upstream overload rather than local rejection.",
  ],
  explain:
    "There are two different protections. The breaker caps what one proxy will admit. The upstream has its own finite capacity. When the cap is below demand, the proxy fails fast and the upstream stays healthy. When the cap is above upstream capacity, the proxy forwards the queue and the failure moves to the dependency. Neither setting creates capacity; only scaling, reducing latency, or shedding load does.",
  fix: defaults({ requestRate: 8_000, upstreamLatency: 600, maxConnections: 5_000, maxPendingRequests: 500, concurrentRetries: 1 }),
  debrief:
    "The repair is to match the limit to measured upstream capacity and to shed what cannot be served. At 8,000 rps and 600 ms the demand is 4,800 concurrent requests, inside the 5,000 connection cap and below the upstream's 8,000. The breaker still has a pending budget for short bursts. A limit that is too high is not generosity; it is a queue in front of a dependency that cannot drain it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Envoy circuit breaking is a set of local limits on an upstream cluster. Each proxy caps how many connections it opens, how many requests may wait for a connection, how many requests may be active, and how many retries may run in parallel. Kuma exposes these as MeshCircuitBreaker thresholds. The limits are enforced by the sidecar before a request reaches the dependency.",
  },
  {
    type: "p",
    text: "Envoy's defaults are 1,024 connections, 1,024 pending requests, 1,024 active requests, and 3 concurrent retries when the fields are omitted. Those are defaults, not recommendations: the right values come from the dependency's measured concurrency and the traffic each proxy sends. A breaker does not create capacity. It decides where the failure happens.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The breaker is configured on the outbound cluster of each sidecar. If a service has ten proxies and each allows 1,000 connections, the dependency can see 10,000 connections. The limit is per proxy, so the fleet-wide limit is the sum unless the upstream also protects itself. This is why a breaker that looks conservative in one pod can still overwhelm a dependency after a scale-out.",
  },
  {
    type: "compare",
    leftTitle: "Circuit breaker limits",
    rightTitle: "Outlier detection",
    rows: [
      { label: "Scope", left: "One proxy to one cluster", right: "Hosts inside one cluster" },
      { label: "Trigger", left: "Concurrency or pending depth", right: "Host error rate or consecutive failures" },
      { label: "Action", left: "Reject new work locally", right: "Eject a host from the load balancer" },
      { label: "Signal", left: "Overflow counters and local errors", right: "Ejection count and capacity loss" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Locally rejected: the share of requests the proxy refuses without calling the upstream.",
      "Pending cap used and connection cap used: how close the proxy is to its local limits.",
      "Upstream concurrency: what actually reaches the dependency after local shedding.",
      "Attempt amplification: how retries add demand to the same connection and pending budgets.",
      "A flow view of clients, edge proxy, service, sidecar, and upstream, plus events for local overflow and upstream saturation.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, apply Pending overflow, then Limits raised. Watch local rejection fall to zero while upstream concurrency crosses 100%. Run the experiment before opening the debrief: the question is where the failure goes, not whether errors disappear.",
  },
  {
    type: "table",
    headers: ["Limit", "Bounds", "When it is too low", "When it is too high"],
    rows: [
      ["Max connections", "Concurrent requests per proxy", "Healthy work is rejected", "Upstream is saturated"],
      ["Max pending requests", "Requests waiting for a connection", "Bursts become errors", "Latency grows into timeouts"],
      ["Max active requests", "Parallel requests per cluster", "Throughput is capped early", "Upstream queues grow"],
      ["Max concurrent retries", "Retry work in flight", "Recovery is slower", "Retries amplify overload"],
    ],
  },
  { type: "sim", simId: "circuit-breaking" },
  { type: "experiment", experimentId: "predict-limit-raise" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, 20,000 rps at 600 ms created 12,000 concurrent requests. The proxy admitted 1,500 connections plus 300 pending, and rejected the rest locally. The upstream saw only a fraction of the demand, which is exactly what the breaker is for. Retries added to the same pool and pushed the rejected share higher.",
  },
  {
    type: "p",
    text: "When the caps were raised, local rejection stopped and all 12,000 concurrent requests reached the upstream. The upstream's teaching capacity is 8,000, so its queue and latency grew and the user error rate stayed high. The outage did not disappear; it moved from the proxy to the dependency. The recovery preset reduced demand and latency until the cap had headroom again.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cluster overflow counters: connection overflow, pending overflow, active request overflow, and retry overflow.",
      "The upstream overflow response flag and a 503 returned by the proxy without an upstream request.",
      "Upstream cluster latency, queue depth, and concurrency at the dependency, compared with the breaker caps.",
      "The number of sidecars sending to the same cluster, because each proxy has its own limit.",
      "Retry counters, because retries compete with new requests for the same connections and pending slots.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare request rate multiplied by latency with the connection cap. Then compare admitted concurrency with the upstream's measured capacity. If the errors are local, the breaker is working; the question is whether the limit is right. If the errors are upstream, the breaker is too loose or the upstream is too small.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the dependency's safe concurrency and the concurrency each proxy sends. Do not set limits from the defaults.",
      "Set max connections below the upstream's safe concurrency divided by the number of proxies, with headroom for bursts.",
      "Set max pending to absorb only the burst you can drain; a deep pending buffer turns errors into timeouts.",
      "Cap concurrent retries and count them against the same budget as new requests.",
      "Shed low-priority traffic or scale the upstream when demand exceeds capacity. Raising the breaker alone moves the failure.",
      "Watch overflow counters and local error rate after every change, and recheck the per-proxy math when the fleet scales.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A tight breaker fails fast and protects the dependency, but rejects work the dependency might have served. That is the availability trade.",
      "A loose breaker keeps accepting work and turns a fast rejection into a slow timeout. It also lets the dependency's queue grow.",
      "Pending requests absorb bursts but add latency. The cap should reflect drain time, not optimism.",
      "Retries inside the breaker budget improve success for isolated failures and consume the same capacity as new requests.",
      "Per-proxy limits are simple to configure and multiply across the fleet. A global limit needs coordination the mesh does not provide by default.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "set-limits",
    question:
      "A dependency is slow and Envoy keeps opening connections. How do you choose max connections, pending requests, and retries?",
    difficulty: 3,
    hints: [
      "Start from concurrency, not from a copied default.",
      "Remember that every sidecar has its own limit.",
    ],
    answer:
      "I would measure the dependency's safe concurrency and the request rate multiplied by latency at each proxy. That gives the concurrency demand. I would set max connections below the upstream's safe concurrency divided by the number of proxies, with headroom for normal bursts. Pending requests should cover only the burst the upstream can drain within the latency budget; a deep buffer hides overload as queue time. Concurrent retries should be small and counted against the same pool. Then I would watch overflow counters and local error rate, and redo the math when the fleet scales or latency changes.",
    followUps: [
      "What would you do if the dependency's capacity is unknown?",
      "How does a latency increase change the answer?",
      "Why not set all limits to the Envoy defaults?",
    ],
    redFlags: [
      "Copies the default limits without measuring.",
      "Sets limits per cluster without counting proxies.",
      "Raises pending depth to hide errors.",
    ],
    rubric: [
      "Uses concurrency math.",
      "Accounts for proxy count.",
      "Sets pending from drain time.",
      "Caps retries.",
    ],
  },
  {
    id: "local-vs-upstream",
    question:
      "Users see 503s, but the dependency's error rate and latency are normal. What is your hypothesis, and what do you check?",
    difficulty: 2,
    hints: [
      "A proxy can reject before the request leaves the pod.",
      "Look for an overflow signal rather than an upstream failure.",
    ],
    answer:
      "I would suspect the local circuit breaker is shedding load before the request reaches the dependency. That fits a normal upstream and failing users. I would check pending overflow, connection overflow, and the upstream overflow response flag on the proxy. Then I would compare demand with the breaker caps and confirm whether the limit or the demand changed. If the limit is too tight for the upstream's real capacity, I would raise it with headroom; if the upstream cannot serve the demand, I would shed load rather than raise the cap.",
    followUps: [
      "Which counter distinguishes pending overflow from connection overflow?",
      "How would you confirm the request never left the proxy?",
      "What if only one sidecar shows the errors?",
    ],
    redFlags: [
      "Blaming the dependency without checking proxy stats.",
      "Raises every limit at once.",
      "Ignores retry overflow.",
    ],
    rubric: [
      "Names local shedding.",
      "Uses overflow counters.",
      "Compares demand with caps.",
      "Chooses shedding or capacity.",
    ],
  },
  {
    id: "raise-limits",
    question:
      "Why can raising circuit breaker limits make an incident worse, and when would you still raise them?",
    difficulty: 3,
    hints: [
      "The breaker is not capacity.",
      "The failure moves to the next queue.",
    ],
    answer:
      "The breaker limits how much work one proxy admits. If the upstream cannot serve that work, raising the limit moves the queue from the proxy to the dependency. Latency and errors rise, and the dependency may fail for every caller instead of only the ones the breaker rejected. I would raise limits only when I have measured that the upstream has spare concurrency and the current limit is rejecting work it could serve. Otherwise I would reduce demand, shed low-priority traffic, or add capacity first.",
    followUps: [
      "How would you prove the upstream has spare concurrency?",
      "What is the user-visible difference between a local rejection and an upstream timeout?",
      "How do retries change the decision?",
    ],
    redFlags: [
      "Treats a higher limit as more capacity.",
      "Raises limits during an incident without measurement.",
      "Ignores the latency cost of queueing.",
    ],
    rubric: [
      "Explains the moved queue.",
      "Requires spare capacity evidence.",
      "Names demand reduction.",
      "Distinguishes rejection from timeout.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each upstream has a measured safe concurrency and a documented breaker limit per proxy.",
      "The fleet-wide limit is the per-proxy limit multiplied by the number of proxies.",
      "Pending depth is sized to burst drain time, not to hide sustained overload.",
      "Concurrent retries are capped and counted against the same pool.",
      "Dashboards show local overflow and upstream concurrency together.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate local rejections from upstream errors using response flags and counters.",
      "Compare demand, connection cap, and pending cap before changing a limit.",
      "Check whether latency or retry volume changed before the errors started.",
      "Reduce demand or shed load if the upstream is already saturated.",
      "Change one limit at a time and watch upstream concurrency.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Recompute limits after any fleet scale-out or latency change.",
      "Add a load test that drives the upstream to its safe concurrency.",
      "Verify that the pending buffer drains within the latency budget.",
      "Review retry limits and their interaction with the breaker.",
      "Document which layer is expected to fail first and why.",
    ],
  },
];

const references = [
  {
    title: "Envoy circuit breaking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Connection, pending request, active request, and retry limits, plus overflow behavior.",
  },
  {
    title: "Kuma MeshCircuitBreaker",
    url: "https://kuma.io/docs/latest/policies/meshcircuitbreaker/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Mesh-level circuit breaker thresholds and their Envoy defaults.",
  },
  {
    title: "Envoy cluster statistics",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Overflow, pending, connection, and retry counters used to diagnose breaker behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "circuit-breaking": {
      model: circuitBreakingModel,
      presets,
      instructions:
        "Start Healthy, apply Pending overflow, then Limits raised. Compare local rejection with upstream concurrency and watch where the failure moves.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Concurrency arithmetic, teaching capacity, and overflow shares are educational values, not Envoy or Kuma defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-circuit-breaking", "mesh-retries", "mesh-outlier-detection", "mesh-timeouts"],
};
