import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUEST_RATE = 10_000;
const FULL_PODS = 12;
const CONN_HOLD_S = 0.08;
const PROMOTE_AT = 20;
const MIN_SAMPLES = 20_000;

const params = [
  {
    id: "canaryWeight",
    label: "Canary traffic weight",
    min: 1,
    max: 20,
    step: 1,
    value: 5,
    unit: "%",
    group: "Canary",
    help: "Share of production traffic the mesh sends to the new version during the canary step. At 10,000 rps, 5% is 500 rps.",
    format: "percent" as const,
  },
  {
    id: "rolloutWeight",
    label: "Promoted traffic weight",
    min: 5,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rollout",
    help: "Weight applied after the 20-second canary step. This is the rollout you are about to approve, not the canary observation.",
    format: "percent" as const,
  },
  {
    id: "canaryPods",
    label: "Canary pod count",
    min: 1,
    max: 12,
    step: 1,
    value: 2,
    unit: " pods",
    group: "Canary",
    help: "Pods serving the canary slice. Production runs 12 pods, so canary density per pod is usually lower than production density.",
    format: "count" as const,
  },
  {
    id: "gateWindow",
    label: "Metric gate window",
    min: 30,
    max: 600,
    step: 30,
    value: 120,
    unit: " s",
    group: "Gate",
    help: "How long the gate observes before deciding. Samples equal request rate times weight times this window.",
    format: "number" as const,
  },
  {
    id: "poolSize",
    label: "Upstream pool per pod",
    min: 20,
    max: 200,
    step: 10,
    value: 60,
    unit: " conns",
    group: "Capacity",
    help: "Connection pool each new-version pod holds against the shared dependency. A request keeps a connection for about 80ms.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

type Phase = "canary" | "promoted";

interface View {
  phase: Phase;
  weight: number;
  pods: number;
  canaryWeight: number;
  canaryPods: number;
  canaryPerPodRps: number;
  poolSize: number;
  v2Rps: number;
  perPodRps: number;
  poolUtil: number;
  p99: number;
  errorRate: number;
  canarySamples: number;
  gateShortfall: number;
  gatePass: boolean;
  projectedUtil: number;
  projectedP99: number;
}

function poolUtilFor(v2Rps: number, pods: number, poolSize: number): number {
  return ((v2Rps / pods) * CONN_HOLD_S * 100) / poolSize;
}

function p99For(util: number): number {
  if (util <= 60) return 42;
  return Math.min(5_000, 42 + 1_100 * ((util - 60) / 40) ** 2);
}

function errorFor(util: number): number {
  if (util <= 80) return 0.08 + util * 0.0015;
  return Math.min(100, 0.2 + (util - 80) * 0.09);
}

function viewFor(p: Params, t: number): View {
  const canaryWeight = clamp(num(p, "canaryWeight", 5), 1, 20);
  const rolloutWeight = clamp(num(p, "rolloutWeight", 100), 5, 100);
  const canaryPods = Math.max(1, Math.round(num(p, "canaryPods", 2)));
  const gateWindow = Math.max(1, num(p, "gateWindow", 120));
  const poolSize = Math.max(1, num(p, "poolSize", 60));
  const phase: Phase = t >= PROMOTE_AT && rolloutWeight > canaryWeight ? "promoted" : "canary";
  const weight = phase === "canary" ? canaryWeight : rolloutWeight;
  const pods = phase === "canary" ? canaryPods : FULL_PODS;
  const v2Rps = (REQUEST_RATE * weight) / 100;
  const poolUtil = poolUtilFor(v2Rps, pods, poolSize);
  const canarySamples = (REQUEST_RATE * canaryWeight * gateWindow) / 100;
  const canaryUtil = poolUtilFor((REQUEST_RATE * canaryWeight) / 100, canaryPods, poolSize);
  const gateShortfall = Math.max(0, MIN_SAMPLES - canarySamples);
  const projectedUtil = poolUtilFor(REQUEST_RATE, FULL_PODS, poolSize);
  return {
    phase,
    weight,
    pods,
    canaryWeight,
    canaryPods,
    canaryPerPodRps: (REQUEST_RATE * canaryWeight) / 100 / canaryPods,
    poolSize,
    v2Rps,
    perPodRps: v2Rps / pods,
    poolUtil,
    p99: p99For(poolUtil),
    errorRate: errorFor(poolUtil),
    canarySamples,
    gateShortfall,
    gatePass:
      gateShortfall === 0 && errorFor(canaryUtil) <= 1 && p99For(canaryUtil) <= 400,
    projectedUtil,
    projectedP99: p99For(projectedUtil),
  };
}

function healthFor(util: number, errorRate: number, p99: number): SimState {
  if (errorRate >= 5 || p99 >= 700 || util >= 95) return "crit";
  if (errorRate >= 1 || p99 >= 250 || util >= 75) return "warn";
  return "ok";
}

function buildFrame(v: View, seed: number): SimFrame {
  const v2Health = healthFor(v.poolUtil, v.errorRate, v.p99);
  const stage = v.weight >= 50 ? "full" : "canary";
  return {
    t: 0,
    nodes: [
      {
        id: "v1",
        label: "Version 1 stable",
        kind: "service",
        role: "primary",
        health: "ok",
        utilization: clamp((REQUEST_RATE - v.v2Rps) / REQUEST_RATE),
        throughput: REQUEST_RATE - v.v2Rps,
        sublabel: `${Math.round(REQUEST_RATE - v.v2Rps).toLocaleString()} rps`,
        meta: { stage: "stable", view: "deployment" },
      },
      {
        id: "v2",
        label: `Version 2 · ${v.pods} pods`,
        kind: "service",
        health: v2Health,
        utilization: clamp(v.poolUtil / 100),
        throughput: v.v2Rps,
        sublabel: `${v.weight}% · gate ${v.gatePass ? "pass" : "fail"}`,
        detail: `Illustrative model: ${Math.round(v.perPodRps).toLocaleString()} rps per pod at ${Math.round(v.poolUtil)}% upstream pool use. Canary density was ${Math.round(v.canaryPerPodRps).toLocaleString()} rps per pod.`,
        meta: { stage, view: "deployment" },
      },
    ],
    edges: [],
    metrics: [
      metric("v2-error", "New version error rate", v.errorRate, "%", 1, 5, "percent"),
      metric("v2-p99", "New version p99", v.p99, "ms", 250, 700, "ms"),
      metric("pool-util", "Upstream pool use", v.poolUtil, "%", 75, 95, "percent"),
      metric("gate-shortfall", "Gate sample shortfall", v.gateShortfall, " req", 8_000, 15_000, "count"),
      metric("projected-p99", "Projected full-fleet p99", v.projectedP99, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      phase: v.phase,
      weight: v.weight,
      pods: v.pods,
      gate: v.gatePass ? "pass" : "fail",
      samples: v.canarySamples,
    },
    summary: `${v.phase === "canary" ? "Canary" : "Rollout"} at ${v.weight}%: ${Math.round(v.perPodRps).toLocaleString()} rps per pod, ${Math.round(v.poolUtil)}% pool use, ${v.errorRate.toFixed(2)}% errors, p99 ${Math.round(v.p99)}ms.`,
  };
}

function insightsFor(v: View): string[] {
  const items: string[] = [];
  if (v.phase === "canary") {
    items.push(`The canary receives ${Math.round(v.v2Rps).toLocaleString()} rps across ${v.pods} pods. The gate holds ${Math.round(v.canarySamples).toLocaleString()} requests, ${v.gateShortfall > 0 ? `${Math.round(v.gateShortfall).toLocaleString()} short of the 20,000-sample minimum` : "which is enough to spend a small error budget"}.`);
  } else {
    items.push(`The rollout runs ${Math.round(v.v2Rps).toLocaleString()} rps across ${v.pods} pods, or ${Math.round(v.perPodRps).toLocaleString()} rps per pod. That density, not the canary weight, sets pool pressure.`);
  }
  items.push(`Each pod holds about ${Math.round(v.perPodRps * CONN_HOLD_S)} concurrent upstream connections at the current density. The pool allows ${Math.round(v.poolSize)} in this frame; utilization is ${Math.round(v.poolUtil)}%.`);
  items.push(`Projected full-fleet p99 is ${Math.round(v.projectedP99)}ms with 12 pods at 100%. A gate that does not project this cannot see capacity risk at the target scale.`);
  items.push(`Canary evidence: ${Math.round(v.canarySamples).toLocaleString()} samples and ${v.gatePass ? "a pass" : "a fail"}. A pass on error rate alone is not a capacity test.`);
  items.push(`Per-pod canary density is ${Math.round(v.canaryPerPodRps).toLocaleString()} rps in this view. Low weight with enough pods can look healthier than production.`);
  items.push("Kuma TrafficRoute weights split traffic between clusters; Envoy weighted clusters implement the split at the proxy. Roll back by returning the weight to 0, not by rebuilding the deployment.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "v2-error",
    metricId: "v2-error",
    warn: 1,
    crit: 5,
    title: "New version error rate is above the gate",
    cause: "Failures can come from the application or from the saturated upstream pool. At low canary weight the error count is too small to distinguish a rare fault from noise.",
    fix: "Stop promotion and compare per-pod density with production. If the pool is saturated, raise the pool or reduce density before increasing weight; do not widen the gate to make the error rate pass.",
    checkFirst: [
      "Divide the canary error count by canary requests, not total requests.",
      "Check whether the errors started before or after the traffic weight changed.",
      "Compare the upstream connection pool counters per pod with the canary baseline.",
    ],
  },
  {
    id: "v2-p99",
    metricId: "v2-p99",
    warn: 250,
    crit: 700,
    title: "New version tail latency breached the rollout budget",
    cause: "Pool queueing grows nonlinearly as concurrent connections approach the pool limit. A canary at low per-pod density stays below the knee; production density may not.",
    fix: "Reduce per-pod request density, increase the connection pool, or add capacity. Verify the fix at the promoted weight, not at the canary weight.",
    checkFirst: [
      "Compare p99 at the canary weight with p99 after promotion.",
      "Check upstream pending requests and connection pool utilization.",
      "Check whether latency rose on v2 only or on both versions.",
    ],
  },
  {
    id: "pool-util",
    metricId: "pool-util",
    warn: 75,
    crit: 95,
    title: "The upstream connection pool is saturated",
    cause: "The new version holds a connection for the whole request. At production per-pod density the pool runs out, and requests queue before they reach the dependency.",
    fix: "Size the pool for production density, or reduce the number of concurrent upstream calls per request. Treat pool size as a per-pod limit, not a fleet-wide number.",
    checkFirst: [
      "Check upstream_cx_active and upstream_rq_pending against the configured pool.",
      "Compare per-pod rps at canary and production density.",
      "Check whether the new version added an upstream call or increased connection hold time.",
    ],
  },
  {
    id: "gate-shortfall",
    metricId: "gate-shortfall",
    warn: 8_000,
    crit: 15_000,
    title: "The metric gate does not have enough samples",
    cause: "A short window or a low traffic weight yields too few canary requests. Rare failures and tail latency can be absent from the sample even when they exist at production scale.",
    fix: "Lengthen the gate window, raise canary weight within the risk budget, or require a minimum sample count before the gate can pass.",
    checkFirst: [
      "Multiply request rate by weight by gate window.",
      "Check whether the gate counts canary requests or all requests.",
      "Check whether the gate window covers a full traffic cycle.",
    ],
  },
];

export const meshCanaryModel: SimModel = {
  id: "mesh-canary",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    return buildFrame(viewFor(p, 0), seed);
  },
  step: (frame, p, dt, rng) => {
    const t = frame.t + dt;
    const view = viewFor(p, t);
    const jittered = { ...view, p99: Math.max(1, view.p99 * (1 + rng.between(-0.01, 0.01))) };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (view.phase === "canary" && frame.flags.canarySeen !== 1) {
      pushEvent(next, {
        id: "rollout-canary-step",
        at: frame.t,
        severity: "info",
        title: "Canary step started",
        detail: `The mesh sends ${view.weight}% of traffic to the new version across ${view.pods} pods. The gate observes ${Math.round(view.canarySamples).toLocaleString()} requests before promotion.`,
        nodeId: "v2",
      });
      next.flags.canarySeen = 1;
    }
    if (view.phase === "promoted" && frame.flags.phase !== "promoted" && frame.flags.promotedSeen !== 1) {
      pushEvent(next, {
        id: "rollout-promoted",
        at: frame.t,
        severity: view.gatePass ? "info" : "warn",
        title: `Promoted to ${view.weight}%`,
        detail: `Gate ${view.gatePass ? "passed" : "failed"} on ${Math.round(view.canarySamples).toLocaleString()} canary samples. Per-pod density is now ${Math.round(view.perPodRps).toLocaleString()} rps and the pool is ${Math.round(view.poolUtil)}% used.`,
        nodeId: "v2",
        metricId: "pool-util",
      });
      next.flags.promotedSeen = 1;
    }
    if (view.phase === "promoted" && view.poolUtil >= 95 && frame.flags.capacitySeen !== 1) {
      pushEvent(next, {
        id: "rollout-capacity-gap",
        at: frame.t,
        severity: "crit",
        title: "Promotion exceeded the tested capacity",
        detail: `The canary passed at ${Math.round(view.canaryPerPodRps).toLocaleString()} rps per pod. Production density is ${Math.round(view.perPodRps).toLocaleString()} rps per pod, and the pool is saturated.`,
        nodeId: "v2",
        metricId: "v2-p99",
      });
      next.flags.capacitySeen = 1;
    }
    if (view.gateShortfall >= 15_000 && frame.flags.shortfallSeen !== 1) {
      pushEvent(next, {
        id: "gate-underpowered",
        at: frame.t,
        severity: "warn",
        title: "Canary gate is underpowered",
        detail: `Only ${Math.round(view.canarySamples).toLocaleString()} canary requests will be observed. Rare errors and tail latency need a larger sample or a longer window.`,
        nodeId: "v2",
        metricId: "gate-shortfall",
      });
      next.flags.shortfallSeen = 1;
    }
    next.summary = `${view.phase === "canary" ? "Canary" : "Rollout"} at ${view.weight}%: ${Math.round(view.perPodRps).toLocaleString()} rps per pod, ${Math.round(view.poolUtil)}% pool use, ${view.errorRate.toFixed(2)}% errors, p99 ${Math.round(jittered.p99)}ms. Gate ${view.gatePass ? "passed" : "failed"} on ${Math.round(view.canarySamples).toLocaleString()} samples.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => insightsFor(viewFor(p, frame.t)),
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
    description: "The canary holds 5% for 10 minutes and the gate collects 150,000 samples. Pool use stays low.",
    tone: "ok",
    params: defaults({ canaryWeight: 5, rolloutWeight: 5, canaryPods: 2, gateWindow: 600, poolSize: 80 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Promotion reaches 100% with a pool that is close to its limit. Pool use and tail latency warn but stay below critical.",
    tone: "warn",
    params: defaults({ canaryWeight: 5, rolloutWeight: 100, canaryPods: 2, gateWindow: 300, poolSize: 85 }),
  },
  {
    id: "failure",
    label: "Canary passes, rollout fails",
    description: "A clean 5% canary promotes to 100%. Production density saturates the 60-connection pool.",
    tone: "crit",
    params: defaults({ canaryWeight: 5, rolloutWeight: 100, canaryPods: 2, gateWindow: 120, poolSize: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Same rollout after the pool is sized for production density. Tail latency returns to baseline.",
    tone: "ok",
    params: defaults({ canaryWeight: 5, rolloutWeight: 100, canaryPods: 2, gateWindow: 300, poolSize: 160 }),
  },
  {
    id: "underpowered",
    label: "Underpowered gate",
    description: "A 1% canary for 30 seconds observes only 3,000 requests. The gate cannot support a promotion decision.",
    tone: "warn",
    params: defaults({ canaryWeight: 1, rolloutWeight: 5, canaryPods: 2, gateWindow: 30, poolSize: 80 }),
  },
];

const experiment: Experiment = {
  id: "promote-past-canary-capacity",
  title: "The canary that never saw production density",
  simId: "mesh-canary",
  question:
    "The 5% canary held 0.1% errors and p99 42ms for 120 seconds with two pods and a 60-connection pool per pod. You promote to 100% across the 12-pod production fleet. What happens?",
  prediction: {
    options: [
      { id: "stable", label: "Nothing changes: the same image and the same gate pass carry over to production" },
      { id: "pool", label: "Per-pod traffic rises, the upstream pool saturates, and p99 and errors jump after promotion" },
      { id: "sampling", label: "The 120-second window is too short, so the gate cannot be trusted" },
      { id: "dependency", label: "The shared dependency fails independently and the mesh cannot influence it" },
    ],
    correctOptionId: "pool",
    explanation:
      "The canary tested a low-density slice. Production density is higher, so connection demand rises and the pool queues even though the image did not change.",
  },
  setup: defaults({ canaryWeight: 5, rolloutWeight: 100, canaryPods: 2, gateWindow: 120, poolSize: 60 }),
  runFor: 45,
  observe: [
    "Before 20 seconds the canary sees about 250 rps per pod and the pool is about 25% used.",
    "The gate passes on 60,000 canary samples with 0.1% errors and p99 42ms.",
    "At 20 seconds the rollout moves to 100%; production density is about 833 rps per pod.",
    "Pool use crosses 95% and p99 rises past 1,500ms within the same second.",
    "The projected full-fleet p99 already showed the risk while the gate was green.",
  ],
  explain:
    "The canary tested the new version at 250 rps per pod. Production runs 833 rps per pod, and each request holds an upstream connection for about 80ms. That is about 67 concurrent connections against a 60-connection pool. The pool queues, queueing raises latency, and latency raises the number of connections held, which makes the queue worse. The gate measured the canary's density, not the target's density.",
  fix: defaults({ canaryWeight: 5, rolloutWeight: 100, canaryPods: 2, gateWindow: 300, poolSize: 160 }),
  debrief:
    "A canary gate needs three things: enough samples, a metric that covers the failure, and a test condition that resembles the target. The sample count here was adequate; the density was not. Project per-pod traffic and pool demand at 100% before promoting, and add that projection to the gate. If projection is too hard, promote in more than one step and watch the same signals at each new weight.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A mesh canary sends a controlled share of traffic to a new version while the previous version keeps serving the rest. The traffic split is a route weight: Kuma TrafficRoute and Envoy weighted clusters can move 5% to the new service and 95% to the old one without changing the client. The rollout decision is a metric gate, a rule that compares canary signals with a threshold and either promotes, holds, or rolls back.",
  },
  {
    type: "p",
    text: "The mesh makes the split easy, which is also the trap. A 5% slice at 10,000 requests per second is 500 requests per second, and two canary pods see 250 each. Production with 12 pods sees about 833 each. The same image behaves differently because per-pod density, connection pools, and cache locality change with scale. A green canary is evidence about the slice it ran, not a guarantee about the fleet it will become.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ingress or edge proxy, mesh route, weighted cluster for v1 or v2, then the shared dependency. The mesh data plane applies the weight at the proxy; the control plane stores the route. The gate reads per-version telemetry from the same proxies and from the application. Rollback is another weight change, so it is fast only if the old version is still deployed and healthy.",
  },
  {
    type: "compare",
    leftTitle: "What a 5% canary proves",
    rightTitle: "What it does not prove",
    rows: [
      { label: "Correctness", left: "The new code handles a sample of real requests", right: "Rare branches and rare inputs were never exercised" },
      { label: "Latency", left: "p99 at canary density", right: "p99 at production density and full pool pressure" },
      { label: "Capacity", left: "The canary pods have headroom", right: "The production fleet has headroom at 100%" },
      { label: "Rollback", left: "The route weight can move", right: "The old version still has capacity for all traffic" },
    ],
  },
  {
    type: "p",
    text: "The sample count is arithmetic: request rate times weight times gate window. A 10,000 rps service at 1% for 30 seconds observes 3,000 canary requests. A 0.2% failure rate produces about six errors, which is too few to separate a real regression from noise. A 0.01% tail is unlikely to appear at all. The gate should require a minimum sample count, not only a passing ratio.",
  },
  {
    type: "p",
    text: "Kuma's traffic routing policy expresses weighted splits between services, and Envoy's weighted cluster route implements the data-plane choice. The examples here use an illustrative 10,000 rps service and a 12-pod production fleet. Real pool sizes, connection hold times, and capacity numbers must come from your own measurements.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A stable and a new-version node. The new-version node shows the current weight, pod count, and gate verdict.",
      "New-version error rate, p99, and upstream pool use, with warning and critical thresholds.",
      "Gate sample shortfall: requests still missing from the 20,000-sample minimum.",
      "Projected full-fleet p99: what the pool would do at 100% across 12 pods.",
      "A 20-second canary step, then promotion to the selected rollout weight.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the gate sample count. Apply Canary passes, rollout fails and watch the promotion at 20 seconds. Then compare Peak, Recovery, and Underpowered gate. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "table",
    headers: ["Gate signal", "What it catches", "What it misses at low weight"],
    rows: [
      ["Error rate", "Application and upstream failures", "Rare failures with too few samples"],
      ["p99 latency", "Pool queueing and slow paths", "Tails that only appear at higher concurrency"],
      ["Pool utilization", "Connection pressure per pod", "Nothing if the gate reads fleet averages"],
      ["Sample count", "A gate that cannot decide", "Nothing; it is the confidence check"],
    ],
  },
  { type: "sim", simId: "mesh-canary" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The canary ran at 5% with two pods. Each pod saw about 250 rps and held about 20 upstream connections against a 60-connection pool. Errors were near 0.1% and p99 was at the 42ms floor, so the gate passed. At 20 seconds the rollout moved to 100%. Production density was about 833 rps per pod, which needs about 67 connections. The pool queued, p99 rose above 1.5 seconds, and errors followed.",
  },
  {
    type: "p",
    text: "Nothing in the new version changed at promotion. The test condition changed. The canary had enough samples but the wrong density, so its latency and error numbers were true for a workload production would never run. The projected full-fleet p99 showed the risk while the canary was green; the gate did not use it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy cluster stats per version: upstream_cx_active, upstream_rq_pending, upstream_rq_pending_overflow, and upstream_cx_overflow.",
      "Per-version request rate and error rate from the mesh, divided by the number of pods serving that version.",
      "Application latency and error dashboards split by version label, not aggregated across both clusters.",
      "Kuma TrafficRoute or Envoy weighted cluster configuration history, including who changed the weight and when.",
      "Rollback readiness: old-version pod count, image availability, and capacity at 100% of traffic.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare per-pod request rate and pool utilization at canary weight with the projection at 100%. Confirm the gate counted canary requests, not all requests. Check whether the error or latency signal existed before promotion. Then verify the old version can absorb 100% if you roll back.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop promotion and return the weight to the last known-good value. Keep the old version deployed until the new one has survived production density.",
      "Compute per-pod density at the target weight: request rate times weight divided by pods. Compare it with the canary density.",
      "Size upstream pools for the target density, or reduce concurrent upstream calls per request.",
      "Add a projected-capacity signal and a minimum sample count to the gate before the next attempt.",
      "Promote in steps and re-evaluate the same signals at each weight. Do not treat one green window as a full-capacity test.",
      "Record the canary weight, sample count, and per-pod density in the rollout record so the next gate can be reviewed.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher canary weight gives better evidence and more blast radius. A lower weight is safer and slower to trust.",
      "A longer gate window improves confidence and delays the release. It also spans more traffic cycles, which can mix in unrelated changes.",
      "A stricter gate rejects good releases. A looser gate ships bad ones. The sample count and the capacity projection are what make the threshold meaningful.",
      "Keeping the old version at full capacity costs money. It is the price of a fast, credible rollback.",
      "Projecting full-fleet behavior from a canary is a model, not a measurement. Treat the projection as a reason to test at higher weight, not as proof.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "canary-sample",
    question:
      "A 5% canary has run for two minutes at 8,000 rps with zero errors. Can you promote? What else do you need?",
    difficulty: 3,
    hints: [
      "Compute the number of canary requests first.",
      "A zero numerator is not evidence if the denominator is small.",
    ],
    answer:
      "Two minutes at 5% of 8,000 rps is 48,000 canary requests. That is enough to bound a common error rate, but it says little about a 0.01% tail or a failure that appears only at production density. I would check the per-pod request rate and connection pool utilization at 100%, confirm the gate measures canary traffic rather than all traffic, and verify the old version can take 100% if rollback is needed. I would promote in steps, not straight to 100%, unless the capacity projection is measured and comfortable.",
    followUps: [
      "How many samples would you require for a 0.1% error budget?",
      "What changes if the canary has 12 pods at 5%?",
      "Which signal would you trust least at this sample size?",
    ],
    redFlags: [
      "Treats zero errors as proof of correctness.",
      "Ignores per-pod density.",
      "Promotes without a rollback capacity check.",
    ],
    rubric: [
      "Computes samples from rate, weight, and time.",
      "Names a rare failure the sample cannot see.",
      "Checks capacity at the target weight.",
      "Promotes in steps with a rollback condition.",
    ],
  },
  {
    id: "density-gap",
    question:
      "The canary is clean at 5% and p99 triples at 100%. The image is identical. How do you explain that to a release review?",
    difficulty: 3,
    hints: [
      "The workload changed, not the code.",
      "Think about connections, pools, and per-pod concurrency.",
    ],
    answer:
      "The canary tested a lower per-pod request rate. At 5% with two pods, each pod saw 250 rps; at 100% with 12 pods, each saw about 833. If a request holds a connection for 80ms, concurrency rises from about 20 to about 67 per pod. A 60-connection pool absorbs the first and queues the second. Queueing raises latency, and higher latency holds connections longer, so the queue grows. The right conclusion is not that the image is bad; it is that the gate did not test the target density.",
    followUps: [
      "How would you catch this before promotion?",
      "What if the production fleet had 40 pods?",
      "Would a longer canary window have helped?",
    ],
    redFlags: [
      "Blames the image without checking load.",
      "Adds capacity without finding the pool limit.",
      "Assumes p99 scales linearly with traffic.",
    ],
    rubric: [
      "Computes per-pod density.",
      "Connects concurrency to pool size.",
      "Explains the queueing feedback.",
      "Names a pre-promotion projection.",
    ],
  },
  {
    id: "gate-design",
    question:
      "Design a mesh canary gate for a service with a 99.9% error SLO and a 300ms p99 target. What are the gates, the sample rule, and the rollback trigger?",
    difficulty: 4,
    hints: [
      "Separate correctness, latency, and capacity.",
      "A gate without a minimum sample count is a coin flip.",
    ],
    answer:
      "I would gate on three families. Correctness: canary error rate within the error budget, with a minimum sample count derived from the smallest regression worth catching. Latency: canary p99 against the 300ms target at the canary weight, plus a projection at the target density. Capacity: per-pod pool utilization and pending requests at 100%, including enough headroom for one pod loss. I would promote in steps, hold each step for a full traffic cycle, and roll back automatically if the error budget burn or p99 crosses the limit for a sustained window. I would also require the old version to have capacity for 100%.",
    followUps: [
      "How do you choose the minimum sample count?",
      "What is the rollback trigger during the first minute?",
      "How do you avoid a gate that flaps on low traffic?",
    ],
    redFlags: [
      "Gates only on error rate.",
      "Uses a fixed percentage without sample math.",
      "Has no rollback capacity check.",
    ],
    rubric: [
      "Covers correctness, latency, and capacity.",
      "Derives a sample minimum.",
      "Promotes in steps.",
      "Defines a sustained rollback trigger.",
    ],
  },
];

const checklist = [
  {
    title: "Before the rollout",
    items: [
      "Compute canary samples from request rate, weight, and gate window; require a minimum count.",
      "Project per-pod request rate, connection demand, and pool utilization at 100%.",
      "Verify the old version can serve 100% of traffic if rollback is needed.",
      "Split dashboards by version; do not average canary and stable signals.",
      "Define the rollback trigger, owner, and the weight change that executes it.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Promote in steps and hold each step for a full traffic cycle.",
      "Compare per-pod density and pool use at each weight.",
      "Check whether errors are application failures or upstream pool queueing.",
      "Watch p99 and pending requests together; latency raises connection demand.",
      "Record the gate values and the sample count at every promotion.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Review whether the canary density represented production density.",
      "Add the projected-capacity signal to the gate if it was missing.",
      "Tune pool size and pod count from measured production data.",
      "Test the rollback path while the old version is still warm.",
      "Document the evidence the gate used, not only the verdict.",
    ],
  },
];

const references = [
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Canary selection, metric gates, sample sizes, and the difference between a canary and a capacity test.",
  },
  {
    title: "Kuma traffic routing",
    url: "https://kuma.io/docs/latest/policies/traffic-route/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Weighted traffic splits between service versions at the mesh data plane.",
  },
  {
    title: "Envoy router filter: weighted clusters",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Weighted cluster selection and route-level traffic splitting.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mesh-canary": {
      model: meshCanaryModel,
      presets,
      instructions:
        "Start Healthy, then apply Canary passes, rollout fails. Watch the gate stay green at 5% and the pool saturate at 100%. Compare the projected full-fleet p99 during the canary step.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Request rate, pool behavior, and capacity are teaching values, not Kuma or Envoy defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "mesh-traffic-splitting",
    "deployment-canary-metric-gate",
    "deployment-canary-capacity",
    "mesh-sidecar-overhead",
    "mesh-ingress",
  ],
};
