import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUESTS_PER_CONNECTION = 100;
const POOL_CONNS_PER_TARGET = 150;
const WARMUP_SPREAD_S = 30;
const COLD_BURST_S = 1;
const HANDSHAKE_CAPACITY = 6_000;
const BASE_MS = 25;
const DRAIN_FAIL_SHARE = 0.02;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 5_000,
    max: 200_000,
    step: 5_000,
    value: 60_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second through the load balancer or proxy. Traffic is held flat during the deploy.",
    format: "rps" as const,
  },
  {
    id: "targetCount",
    label: "Backend targets",
    min: 3,
    max: 60,
    step: 1,
    value: 20,
    unit: " targets",
    group: "Topology",
    help: "Targets in the pool. A rolling deploy replaces a share of them, and each replacement discards its pooled connections.",
    format: "count" as const,
  },
  {
    id: "rolloutShare",
    label: "Fleet replaced in this deploy",
    min: 5,
    max: 100,
    step: 5,
    value: 25,
    unit: "%",
    group: "Deploy",
    help: "Share of targets replaced in the rolling deploy being modeled. The old connections are discarded as targets are removed.",
    format: "percent" as const,
  },
  {
    id: "poolWarmup",
    label: "Pool warmup (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Deploy",
    help: "Pre-establish upstream connections before a new target receives traffic. Warmup spreads connection setup instead of bursting on the first request.",
    format: "count" as const,
  },
  {
    id: "drainEnabled",
    label: "Connection draining (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Deploy",
    help: "Let in-flight requests finish on a target before it is removed. Without draining, those requests fail and their retries add connections.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  targets: number;
  rolloutShare: number;
  warmup: boolean;
  drain: boolean;
  steadyConnections: number;
  replacedTargets: number;
  poolConnections: number;
  deployConnections: number;
  totalConnections: number;
  deployShare: number;
  connectionMultiple: number;
  failedRequests: number;
  handshakeUtil: number;
  p99: number;
  coldPool: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 60_000));
  const targets = Math.max(1, Math.round(num(p, "targetCount", 20)));
  const rolloutShare = Math.min(100, Math.max(0, num(p, "rolloutShare", 25)));
  const warmup = num(p, "poolWarmup", 1) >= 0.5;
  const drain = num(p, "drainEnabled", 1) >= 0.5;

  const steadyConnections = requestRate / REQUESTS_PER_CONNECTION;
  const replacedTargets = targets * (rolloutShare / 100);
  const poolConnections = replacedTargets * POOL_CONNS_PER_TARGET;
  const deployConnections = poolConnections / (warmup ? WARMUP_SPREAD_S : COLD_BURST_S);
  const totalConnections = steadyConnections + deployConnections;
  const deployShare = totalConnections > 0 ? (deployConnections / totalConnections) * 100 : 0;
  const connectionMultiple = totalConnections / Math.max(1, steadyConnections);
  const failedRequests = drain ? 0 : (rolloutShare / 100) * DRAIN_FAIL_SHARE * 100;
  const handshakeUtil = (totalConnections / HANDSHAKE_CAPACITY) * 100;
  const queueMs = handshakeUtil > 100 ? Math.min(1_200, (handshakeUtil - 100) * 5) : 0;
  const p99 = BASE_MS + queueMs + (failedRequests > 0 ? 200 : 0);

  return {
    requestRate,
    targets,
    rolloutShare,
    warmup,
    drain,
    steadyConnections,
    replacedTargets,
    poolConnections,
    deployConnections,
    totalConnections,
    deployShare,
    connectionMultiple,
    failedRequests,
    handshakeUtil,
    p99,
    coldPool: warmup ? 0 : poolConnections,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = compute(p);
  const clientHealth = healthFor(d.failedRequests, 0.1, 0.5);
  const proxyHealth =
    d.totalConnections >= 4_000 || d.failedRequests >= 0.5
      ? "crit"
      : d.totalConnections >= 2_000 || d.failedRequests >= 0.1
        ? "warn"
        : "ok";
  const targetHealth = healthFor(d.failedRequests, 0.1, 0.5);

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: d.requestRate,
        sublabel: `${d.failedRequests.toFixed(2)}% requests failing`,
        detail: "Clients do not know that a deploy is happening. They see latency, resets, or retries when an upstream connection is replaced.",
        meta: { view: "flow" },
      },
      {
        id: "proxy",
        label: "Upstream pool",
        kind: "lb",
        health: proxyHealth,
        utilization: clamp(d.handshakeUtil / 100),
        throughput: d.requestRate,
        sublabel: `${Math.round(d.totalConnections).toLocaleString()} new conn/s · ${d.warmup ? "warm" : "cold"}`,
        detail: `${d.replacedTargets.toFixed(1)} targets are being replaced, each with about ${POOL_CONNS_PER_TARGET} pooled connections. ${d.warmup ? "New connections are spread over a warmup window before traffic arrives." : "New connections open as requests arrive, so the pool starts cold."}`,
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Backend fleet",
        kind: "service",
        health: targetHealth,
        utilization: clamp(d.totalConnections / 6_000),
        throughput: d.requestRate,
        sublabel: `${d.targets} targets · drain ${d.drain ? "on" : "off"}`,
        detail: `New targets have no established upstream connections. Draining lets in-flight requests finish before a target is removed; without it, those requests fail and retries add more connection setup.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-proxy", "client", "proxy", clamp(d.requestRate / 200_000), clientHealth),
      edge("proxy-targets", "proxy", "targets", clamp(d.totalConnections / 6_000), targetHealth),
    ],
    metrics: [
      metric("new-connections", "New upstream connections", d.totalConnections, " conn/s", 2_000, 4_000, "rps"),
      metric("deploy-connections", "Connections from the deploy", d.deployConnections, " conn/s", 500, 1_500, "rps"),
      metric("steady-connections", "Steady-state connections", d.steadyConnections, " conn/s", undefined, undefined, "rps"),
      metric("deploy-share", "Deploy share of new connections", d.deployShare, "%", 30, 60, "percent"),
      metric("connection-multiple", "Connection multiple over steady state", d.connectionMultiple, "x", 1.5, 3, "number"),
      metric("failed-requests", "Failed requests during deploy", d.failedRequests, "%", 0.1, 0.5, "percent"),
      metric("p99", "Request p99", d.p99, "ms", 150, 500, "ms"),
      metric("pool-connections", "Pooled connections to re-establish", d.poolConnections, " conns", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      warmup: d.warmup ? 1 : 0,
      drain: d.drain ? 1 : 0,
    },
    summary: `${Math.round(d.totalConnections).toLocaleString()} new conn/s (${Math.round(d.steadyConnections).toLocaleString()} steady + ${Math.round(d.deployConnections).toLocaleString()} deploy); ${d.deployShare.toFixed(0)}% deploy share; ${d.failedRequests.toFixed(2)}% failed; p99 ${d.p99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 10)) / 2.4)) + Math.sin(index / 2.3) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "new-connections",
    metricId: "new-connections",
    warn: 2_000,
    crit: 4_000,
    title: "A deploy is creating a connection storm",
    cause:
      "New targets start with empty upstream pools. When the first requests arrive, the proxy or load balancer opens many connections at once. The effect is larger when a big share of the fleet is replaced and warmup is off.",
    fix:
      "Warm the upstream pool before sending traffic to a new target, spread the rollout, and keep the steady-state reuse rate high. Check the next tier before adding capacity.",
    checkFirst: [
      "Compare new connections with request rate before and during the deploy.",
      "Check whether the connection rate spikes at target replacement rather than at a traffic change.",
      "Check the proxy upstream pool and target accept queue at the same timestamps.",
    ],
  },
  {
    id: "deploy-share",
    metricId: "deploy-share",
    warn: 30,
    crit: 60,
    title: "Most new connections are coming from the deploy",
    cause:
      "The deploy is replacing a large share of targets, and each replaced target discards its pool. Without warmup, all of those replacements open connections in a short burst instead of spreading them.",
    fix:
      "Reduce the batch size, enable pool warmup, and stagger target replacement. A deploy that replaces fewer targets at once produces a smaller connection burst.",
    checkFirst: [
      "Compare the deploy start time with the connection spike.",
      "Check batch size and target replacement rate.",
      "Check whether the steady-state connection rate is already high before the deploy.",
    ],
  },
  {
    id: "failed-requests",
    metricId: "failed-requests",
    warn: 0.1,
    crit: 0.5,
    title: "Requests are failing during target replacement",
    cause:
      "Connection draining is off or too short for the in-flight requests on a removed target. Those requests fail, and retries can add new connections to the same deploy storm.",
    fix:
      "Enable connection draining, send a close signal before removal, and let in-flight work finish. Retry only idempotent requests with a budget and jitter.",
    checkFirst: [
      "Check the target group deregistration delay and the target close behavior.",
      "Check whether failures align with target replacement, not with application errors.",
      "Check retry volume immediately after the failures.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 150,
    crit: 500,
    title: "Connection setup and retries are stretching the tail",
    cause:
      "New connections pay a handshake, and requests that fail during draining may be retried. The application work is unchanged; the tail is connection setup plus recovery.",
    fix:
      "Reduce the connection burst with warmup, preserve in-flight requests with draining, and cap retries. If the tail persists, check target capacity next.",
    checkFirst: [
      "Compare p99 with target response time.",
      "Check new connections and failed requests at the same timestamps.",
      "Check the retry rate after the first failure.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const upstreamReuseModel: SimModel = {
  id: "traffic-upstream-connection-reuse",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const d = compute(p);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-60);
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    next.series = {};
    for (const item of next.metrics) {
      const previous = frame.series[item.id] ?? [];
      next.series[item.id] = [...previous, item.value].slice(-120);
    }

    if (d.deployShare >= 30 && next.flags.stormWarned !== 1) {
      pushEvent(next, {
        id: "deploy-connection-storm",
        at: frame.t,
        severity: d.deployShare >= 60 ? "crit" : "warn",
        title: "The deploy is causing a connection storm",
        detail: `${Math.round(d.deployConnections).toLocaleString()} of ${Math.round(d.totalConnections).toLocaleString()} new connections/s come from replacing ${d.replacedTargets.toFixed(1)} targets. Warmup is ${d.warmup ? "on" : "off"}.`,
        nodeId: "proxy",
        metricId: "deploy-share",
      });
      next.flags.stormWarned = 1;
    }
    if (d.deployShare < 30) next.flags.stormWarned = 0;

    if (!d.drain && next.flags.drainWarned !== 1) {
      pushEvent(next, {
        id: "drain-disabled",
        at: frame.t,
        severity: d.failedRequests >= 0.5 ? "crit" : "warn",
        title: "Connection draining is off during the deploy",
        detail: `${d.failedRequests.toFixed(2)}% of requests fail as targets are removed. In-flight requests have no time to finish, and retries add to the connection load.`,
        nodeId: "targets",
        metricId: "failed-requests",
      });
      next.flags.drainWarned = 1;
    }
    if (d.drain) next.flags.drainWarned = 0;

    const previousWarmup = Number(frame.flags.warmup ?? (d.warmup ? 1 : 0));
    if ((d.warmup ? 1 : 0) !== previousWarmup) {
      pushEvent(next, {
        id: "warmup-change",
        at: frame.t,
        severity: "info",
        title: d.warmup ? "Pool warmup enabled" : "Pool warmup disabled",
        detail: d.warmup
          ? `Connections are pre-established over about ${WARMUP_SPREAD_S}s before the new target receives traffic.`
          : "New targets receive traffic with an empty pool, so connections open in a burst.",
        nodeId: "proxy",
        metricId: "new-connections",
      });
    }

    next.summary = `${Math.round(d.totalConnections).toLocaleString()} new conn/s (${Math.round(d.steadyConnections).toLocaleString()} steady + ${Math.round(d.deployConnections).toLocaleString()} deploy); ${d.deployShare.toFixed(0)}% deploy share; ${d.failedRequests.toFixed(2)}% failed; p99 ${d.p99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `Steady state is about ${Math.round(d.steadyConnections).toLocaleString()} new connections/s; the deploy adds about ${Math.round(d.deployConnections).toLocaleString()}/s.`,
    );
    items.push(
      `${d.replacedTargets.toFixed(1)} of ${d.targets} targets are replaced, and each carries about ${POOL_CONNS_PER_TARGET} pooled connections in this model.`,
    );
    items.push(
      d.warmup
        ? `Warmup spreads the pool over ${WARMUP_SPREAD_S}s, so the deploy share of new connections is ${d.deployShare.toFixed(0)}%.`
        : `Without warmup the pool opens in about ${COLD_BURST_S}s, so the deploy share is ${d.deployShare.toFixed(0)}%.`,
    );
    items.push(
      d.failedRequests > 0
        ? `${d.failedRequests.toFixed(2)}% of requests fail because draining is off; retries can amplify the storm.`
        : "Draining is on, so requests in flight on a removed target can finish in this model.",
    );
    items.push(
      "Warmup is not free: it lengthens the deploy, holds connections before they are needed, and must respect the target's connection limit.",
    );
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
    description: "A small rollout with pool warmup and draining keeps new connections near steady state.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A large rollout without warmup doubles new connections; draining still protects in-flight requests.",
    tone: "warn",
    params: defaults({ requestRate: 120_000, targetCount: 30, rolloutShare: 30, poolWarmup: 0, drainEnabled: 1 }),
  },
  {
    id: "failure",
    label: "Cold pool, no drain",
    description: "Half the fleet is replaced without warmup or draining; connections and failures spike together.",
    tone: "crit",
    params: defaults({ requestRate: 150_000, targetCount: 40, rolloutShare: 50, poolWarmup: 0, drainEnabled: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A smaller rollout with warmup and draining returns connections to the steady-state rate.",
    tone: "ok",
    params: defaults({ requestRate: 80_000, targetCount: 30, rolloutShare: 20, poolWarmup: 1, drainEnabled: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-warmup-storm",
  title: "Predict what pool warmup changes",
  simId: "upstream-reuse",
  question:
    "Traffic is flat at 100,000 requests per second. A rolling deploy replaces half of twenty-four targets. New connections jump from 1,000/s to 2,800/s. Warmup is off. What removes the spike?",
  prediction: {
    options: [
      { id: "warmup", label: "Pre-establish each new target's pool over a warmup window before sending traffic." },
      { id: "targets", label: "Add more backend targets so each one carries fewer connections." },
      { id: "idle", label: "Raise the upstream idle timeout so connections stay open longer." },
      { id: "retries", label: "Enable retries so failed connection attempts are absorbed." },
    ],
    correctOptionId: "warmup",
    explanation:
      "The spike comes from replacing targets, not from a traffic increase. Each new target starts with an empty upstream pool, and without warmup the proxy opens that pool as the first requests arrive. Warmup moves the same connection setup before the target receives traffic and spreads it over time. Adding targets changes the pool size per target but does not remove the cold-start burst; retries make it worse.",
  },
  setup: defaults({ requestRate: 100_000, targetCount: 24, rolloutShare: 50, poolWarmup: 0, drainEnabled: 1 }),
  runFor: 20,
  observe: [
    "New connections settle near 2,800/s against 1,000/s of steady-state churn.",
    "The deploy accounts for about 64% of new connections.",
    "Failed requests stay at zero because draining is on; the spike is connection setup, not errors.",
  ],
  explain:
    "A pooled connection is only reusable after it exists. A new target has no pool, so the first requests must create one. When many targets are replaced at once, the proxy builds many pools at once. Warmup pre-creates connections while the target is not yet receiving production traffic, then spreads the work over a window. The deploy still replaces the same number of targets; it no longer turns that replacement into a single connection burst.",
  fix: defaults({ requestRate: 100_000, targetCount: 24, rolloutShare: 50, poolWarmup: 1, drainEnabled: 1 }),
  debrief:
    "Warmup reduces the deploy contribution from about 1,800/s to about 60/s and total new connections to about 1,060/s. p99 stays near the application baseline because handshake demand stays below the illustrative capacity. The tradeoff is a longer rollout and connections that sit idle until the target is registered. Draining is separate: it protects in-flight requests, not the pool, and both are needed for a clean deploy.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An upstream connection pool is a set of already-open connections from a load balancer, proxy, or client to a backend target. Reuse amortizes the TCP and TLS handshake across many requests. The pool is tied to the target: when a target is replaced, its pooled connections go with it. A new target starts with an empty pool, and the first requests must establish connections before they can be served.",
  },
  {
    type: "p",
    text: "A rolling deploy replaces targets in batches. Each replacement removes a share of the pool and creates a new target that has none. If the proxy opens new connections only when requests arrive, the first traffic to each new target creates a burst of handshakes. The burst is easy to misread as a traffic spike because request rate is flat. It is a connection lifecycle event: new target, cold pool, simultaneous first requests.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer or proxy, target fleet. The pool lives on the proxy-to-target leg. A service mesh sidecar, an Envoy cluster, or an application client can own a separate pool per target. The load balancer's target group decides when a target is registered and deregistered. Connection draining, also called deregistration delay, keeps a target registered long enough for in-flight requests to finish before it is removed. Warmup is the opposite end of the same lifecycle: establish connections before traffic, not after.",
  },
  {
    type: "table",
    headers: ["Deploy phase", "What happens to connections", "Control"],
    rows: [
      ["New target registered", "Empty upstream pool; connections open on first requests", "Pool warmup or preconnect"],
      ["Steady state", "Connections reused across requests", "Keep-alive and idle timeout alignment"],
      ["Target deregistered", "In-flight requests finish; pool is discarded", "Deregistration delay and connection draining"],
      ["Target removed", "Clients reconnect to remaining targets", "Jittered retries and capacity headroom"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 5,000–200,000 requests per second, 3–60 targets, and a 5–100% rollout share. Steady reuse is 100 requests per connection, each replaced target carries 150 pooled connections, and warmup spreads the pool over 30 seconds. When draining is off, an illustrative 2% of requests already in flight on a replaced target fail. Those are illustrative teaching values, not a vendor default or a measured pool size. The shape is the lesson: deploy-driven connections scale with replaced targets times pool size, divided by the time allowed to establish them.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "New upstream connections per second, split into steady-state and deploy contributions.",
      "The deploy share of new connections, which isolates the spike from normal churn.",
      "The connection multiple over steady state, a direct measure of the storm.",
      "Failed requests when draining is off, and p99 when connection setup and retries hit the tail.",
      "The number of pooled connections that must be re-established by the rollout.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Cold pool, no drain and compare the steady and deploy connection rates. Run the guided experiment before reading its explanation, then enable warmup and watch the deploy share fall. Turn draining off separately to see failures without a connection spike.",
  },
  {
    type: "compare",
    leftTitle: "Cold pool",
    rightTitle: "Warm pool",
    rows: [
      { label: "When connections open", left: "As first requests arrive", right: "Before the target receives traffic" },
      { label: "Burst shape", left: "Concentrated at target registration", right: "Spread over the warmup window" },
      { label: "Deploy time", left: "Shorter", right: "Longer by the warmup window" },
      { label: "Risk", left: "Handshake storm and accept queue pressure", right: "Idle pre-warmed connections and capacity held early" },
    ],
  },
  { type: "sim", simId: "upstream-reuse" },
  { type: "experiment", experimentId: "predict-warmup-storm" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Half of the target fleet was replaced while traffic stayed flat. Each new target started with an empty upstream pool, and the proxy opened connections as requests arrived. New connections rose from about 1,000/s to 2,800/s, and about 64% of them came from the deploy. The request rate never changed; the connection lifecycle did. With draining off, in-flight requests also failed, and retries added more connection work.",
  },
  {
    type: "p",
    text: "Warmup moved the same connection setup before the new targets received traffic and spread it over a window. The deploy contribution fell to about 60/s and total new connections returned near steady state. Draining addressed a different failure: requests already in flight on a removed target. The two controls are complementary, not substitutes.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer or proxy: `NewConnectionCount`, active connections, upstream connection pool stats, and pending requests per cluster.",
      "Targets: accepted connections per second, accept queue depth, TLS handshakes per second, and file descriptor usage.",
      "Traces: connection setup time before the application span, and retries after a reset during target removal.",
      "Deploy events: target registration and deregistration timestamps compared with the connection spike.",
      "Target group: deregistration delay and health-check timing for new targets.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Line up the connection spike with the deploy timeline. If request rate is flat and new connections rise as targets are replaced, the pool is cold. Check warmup and batch size before adding proxy or target capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the spike aligns with target replacement, not a traffic change.",
      "Pre-establish upstream connections before registering a new target for traffic.",
      "Spread the pool over a warmup window instead of opening it in one burst.",
      "Reduce the rollout batch or stagger target replacement.",
      "Enable connection draining so in-flight requests finish before removal.",
      "Cap and jitter retries, and verify new connections, failures, and p99 together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Warmup smooths the connection spike but lengthens deploys and holds idle connections early.",
      "A larger pool absorbs more concurrent requests but multiplies the connections discarded by each target replacement; it does not improve reuse per connection.",
      "Draining protects in-flight requests but delays target removal and extends the deploy.",
      "A smaller rollout batch reduces the spike but takes longer to complete.",
      "Retries can hide a single failure but amplify a connection storm; cap them and use jitter.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-deploy-storm",
    question:
      "Request rate is flat, but new backend connections jump fivefold during every deploy. How do you confirm the cause?",
    difficulty: 3,
    hints: [
      "Align the spike with target registration.",
      "Separate steady churn from deploy churn.",
    ],
    answer:
      "I would put the deploy timeline next to new connections and request rate. If connections spike when targets are registered or deregistered while request rate stays flat, the pool is cold or being discarded. I would check the proxy's upstream pool stats, the number of replaced targets, and whether warmup or preconnect is enabled. Then I would compare the pool size per target with the connection burst. Adding targets or raising the idle timeout would not address the lifecycle cause.",
    followUps: [
      "How would you prove warmup fixed it?",
      "What does draining change that warmup does not?",
      "How would a canary deploy change the spike?",
    ],
    redFlags: [
      "Blames a traffic spike without checking request rate.",
      "Adds targets first.",
      "Confuses idle timeout with pool warmup.",
    ],
    rubric: [
      "Aligns spike with deploy events.",
      "Names cold pool.",
      "Checks warmup and pool size.",
      "Separates draining.",
    ],
  },
  {
    id: "warmup-drain",
    question:
      "Explain the difference between pool warmup and connection draining during a rolling deploy.",
    difficulty: 3,
    hints: [
      "One is at target registration, the other at removal.",
      "Both change when connections exist.",
    ],
    answer:
      "Warmup is about the new target: establish upstream connections before it receives production traffic, then spread the setup over a window so the first requests do not create a burst. Draining is about the old target: keep it registered after deregistration so in-flight requests can finish before the connection is closed. Warmup protects the start of a target's life; draining protects the end. A deploy can fail from either a cold pool at the front or an abrupt cut at the back, so both need to be configured.",
    followUps: [
      "What happens if warmup opens more connections than the target allows?",
      "How long should draining be?",
      "Can draining itself create a connection storm?",
    ],
    redFlags: [
      "Treats them as the same setting.",
      "Warms a target but removes the old one instantly.",
      "Ignores target connection limits.",
    ],
    rubric: [
      "Separates registration from removal.",
      "Explains the burst.",
      "Names in-flight protection.",
      "States both are needed.",
    ],
  },
  {
    id: "pool-sizing",
    question:
      "How do you size an upstream pool so a deploy does not create a storm or overload the target?",
    difficulty: 4,
    hints: [
      "Start from concurrency and requests per connection.",
      "The pool is per target and must survive replacement.",
    ],
    answer:
      "I would start from concurrent requests and the requests each connection can carry, then set a pool size per target that covers peak concurrency with headroom. I would compare that with the target's connection limit and file descriptors. On a deploy, the connections to replace are the pool size times the number of replaced targets; the warmup window sets the rate at which they are re-established. If the rate is too high, I can reduce the batch, lengthen warmup, or lower the pool size. The trade is that a smaller pool may queue at peak, and a larger pool makes each replacement more expensive.",
    followUps: [
      "How does HTTP/2 multiplexing change the pool size?",
      "What if the target has a hard connection limit?",
      "How would you measure the right warmup window?",
    ],
    redFlags: [
      "Sizes only from average traffic.",
      "Ignores the target connection limit.",
      "Uses a single global pool number without per-target math.",
    ],
    rubric: [
      "Uses concurrency and reuse.",
      "Checks the target limit.",
      "Computes replacement connections.",
      "States the tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Deploy events are on the same timeline as new connections and request rate.",
      "Upstream pool size per target and target connection limits are documented.",
      "Pool warmup or preconnect is configured for new targets.",
      "Deregistration delay and connection draining are configured for removed targets.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the spike aligns with target replacement, not traffic.",
      "Split new connections into steady-state and deploy contributions.",
      "Check target accept queue, handshakes, and file descriptors.",
      "Check whether failures come from draining or from the connection burst.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify new connections return near steady state after the deploy.",
      "Re-test the rollout with warmup and draining together.",
      "Check that pre-warmed connections do not exceed target limits.",
      "Document the batch size, pool size, and warmup window used.",
    ],
  },
];

const references = [
  {
    title: "Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target registration, health checks, and deregistration delay.",
  },
  {
    title: "Envoy connection pooling",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/connection_pooling",
    publisher: "Envoy",
    kind: "docs" as const,
    note: "Upstream connection pools, HTTP/2 multiplexing, and per-cluster connection behavior.",
  },
  {
    title: "Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Load balancer connection handling, idle timeout, and target behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "upstream-reuse": {
      model: upstreamReuseModel,
      presets,
      instructions:
        "Start healthy, then apply Cold pool, no drain. Compare deploy connections with steady-state connections and check failed requests separately. Run the experiment before revealing the answer, then enable warmup. Apply Recovery to confirm the connection rate returns near steady state.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. 100 requests per connection, 150 pooled connections per target, a 30-second warmup window, a 2% in-flight failure share when draining is off, and 6,000 connections/s of handshake capacity are teaching values, not vendor defaults or measured limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-keepalive-idle-timeout", "traffic-alb-health-checks", "traffic-504-debug"],
};
