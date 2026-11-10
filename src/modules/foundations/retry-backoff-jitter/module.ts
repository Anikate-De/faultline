import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, Rng, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DEP_CAPACITY = 12_000;
const OUTAGE_SEC = 2;
const RECOVERY_HOLD_SEC = 3;
const BUCKET_SEC = 0.1;
const BUCKETS = 400;
const MAX_ATTEMPTS = 7;

const params: ParamSpec[] = [
  {
    id: "trafficRps",
    label: "Original request rate",
    min: 1_000,
    max: 20_000,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Logical requests before retries. Every failed attempt can add another request.",
    format: "rps",
  },
  {
    id: "maxRetries",
    label: "Max retries per request",
    min: 0,
    max: 6,
    step: 1,
    value: 2,
    unit: "",
    group: "Retry policy",
    help: "Additional attempts after the first failure. The theoretical amplification ceiling is one plus this value.",
    format: "count",
  },
  {
    id: "baseDelayMs",
    label: "Base backoff",
    min: 50,
    max: 1_000,
    step: 50,
    value: 250,
    unit: " ms",
    group: "Retry policy",
    help: "First retry delay. Each later attempt doubles the base before jitter is applied.",
    format: "ms",
  },
  {
    id: "jitterPct",
    label: "Jitter",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
    group: "Retry policy",
    help: "Random spread around each backoff delay. Zero means every client retries in the same wave.",
    format: "percent",
  },
  {
    id: "retryBudgetPct",
    label: "Retry budget",
    min: 0,
    max: 500,
    step: 5,
    value: 10,
    unit: "%",
    group: "Retry policy",
    help: "Retries are capped at this share of original traffic. 100% allows one retry per original on average; 300% allows three.",
    format: "percent",
  },
  {
    id: "faultInjected",
    label: "Dependency fault",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Scenario",
    help: "Inject the two-second 503 outage. Set to 0 to observe an already healthy dependency.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function emptyQueues(): number[][] {
  return Array.from({ length: MAX_ATTEMPTS }, () => new Array<number>(BUCKETS).fill(0));
}

function readQueues(frame: SimFrame): number[][] {
  const raw = frame.flags.queues;
  if (typeof raw !== "string") return emptyQueues();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return emptyQueues();
    return Array.from({ length: MAX_ATTEMPTS }, (_, attempt) => {
      const bucket = Array.isArray(parsed[attempt]) ? (parsed[attempt] as unknown[]) : [];
      return Array.from({ length: BUCKETS }, (_, index) => {
        const value = Number(bucket[index] ?? 0);
        return Number.isFinite(value) ? Math.max(0, value) : 0;
      });
    });
  } catch {
    return emptyQueues();
  }
}

function sumQueues(queues: number[][]): number {
  return queues.reduce((total, queue) => total + queue.reduce((sum, count) => sum + count, 0), 0);
}

interface Computed {
  trafficRps: number;
  maxRetries: number;
  baseDelayMs: number;
  jitterPct: number;
  retryBudgetPct: number;
  faultInjected: number;
}

function readParams(p: Params): Computed {
  return {
    trafficRps: num(p, "trafficRps", 8_000),
    maxRetries: Math.round(num(p, "maxRetries", 2)),
    baseDelayMs: num(p, "baseDelayMs", 250),
    jitterPct: num(p, "jitterPct", 50) / 100,
    retryBudgetPct: num(p, "retryBudgetPct", 10) / 100,
    faultInjected: Math.round(num(p, "faultInjected", 1)),
  };
}

function healthFor(utilPct: number, errorPct: number): "ok" | "warn" | "crit" {
  if (errorPct >= 20 || utilPct >= 100) return "crit";
  if (errorPct >= 5 || utilPct >= 80) return "warn";
  return "ok";
}

function buildFrame(
  p: Params,
  state: { amplification: number; utilPct: number; errorPct: number; pending: number; recovery: number },
  seed: number,
): SimFrame {
  const values = readParams(p);
  const depHealth = healthFor(state.utilPct, state.errorPct);
  const gatewayHealth = state.amplification >= 3 ? "crit" : state.amplification >= 1.5 ? "warn" : "ok";
  const backlogHealth = state.pending >= 2_000 ? "crit" : state.pending >= 500 ? "warn" : "ok";
  const dependencyDown = state.errorPct >= 20;
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "gateway",
        label: "API gateway",
        kind: "service",
        health: gatewayHealth,
        utilization: clamp(state.amplification / 6),
        throughput: values.trafficRps,
        sublabel: `${state.amplification.toFixed(1)}x amplification`,
        meta: { view: "flow" },
      },
      {
        id: "retry-backlog",
        label: "Retry backlog",
        kind: "queue",
        health: backlogHealth,
        utilization: clamp(state.pending / 5_000),
        sublabel: `${Math.round(state.pending).toLocaleString()} pending`,
        detail: `Retries are capped at ${(values.retryBudgetPct * 100).toFixed(0)}% of ${values.trafficRps.toLocaleString()} original rps. Backoff base ${values.baseDelayMs}ms, jitter ${(values.jitterPct * 100).toFixed(0)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Dependency",
        kind: "worker",
        health: depHealth,
        utilization: clamp(state.utilPct / 100),
        throughput: (state.utilPct / 100) * DEP_CAPACITY,
        capacity: DEP_CAPACITY,
        sublabel: dependencyDown ? "returning 503" : `${state.errorPct.toFixed(1)}% errors`,
        detail: `Illustrative capacity ${DEP_CAPACITY.toLocaleString()} rps. Inbound load is ${state.utilPct.toFixed(0)}% of capacity.`,
        meta: { view: "flow" },
      },
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: state.errorPct >= 20 ? "warn" : "ok",
        sublabel: `${values.maxRetries} retries max`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-gateway", "clients", "gateway", 0.8, gatewayHealth),
      edge("gateway-backlog", "gateway", "retry-backlog", clamp(state.amplification - 1), backlogHealth),
      edge("backlog-dependency", "retry-backlog", "dependency", 0.8, depHealth),
      edge("gateway-dependency", "gateway", "dependency", clamp(1 / Math.max(1, state.amplification)), depHealth),
    ],
    metrics: [
      metric("amplification", "Request amplification", state.amplification, "x", 2, 3, "number"),
      metric("dep-util", "Dependency utilization", state.utilPct, "%", 70, 90, "percent"),
      metric("dep-errors", "Dependency error rate", state.errorPct, "%", 5, 20, "percent"),
      metric("queueDepth", "Pending retries", state.pending, "", 500, 2_000, "count"),
      metric("retry-budget", "Retry budget", values.retryBudgetPct * 100, "%", undefined, undefined, "percent"),
      metric("recovery-hold", "Recovery hold remaining", state.recovery, " s", undefined, undefined, "number"),
      metric("offered", "Offered load", (state.utilPct / 100) * DEP_CAPACITY, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      amplification: state.amplification,
      utilPct: state.utilPct,
      errorPct: state.errorPct,
      pending: state.pending,
      recovery: state.recovery,
      paramsKey: JSON.stringify(p),
    },
    summary: `${state.amplification.toFixed(1)}x amplification; dependency at ${state.utilPct.toFixed(0)}% with ${state.errorPct.toFixed(1)}% errors; ${Math.round(state.pending).toLocaleString()} retries pending.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 12 }, (_, index) => {
      const wave = Math.sin((index + (seed % 4)) / 2.8) * Math.max(0.1, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "amplification",
    metricId: "amplification",
    warn: 2,
    crit: 3,
    title: "Retry amplification crossed the critical threshold",
    cause:
      "Failed requests are being retried faster than the dependency can recover. Each retry is real load, and a retry budget that is too high turns a short outage into a sustained one.",
    fix:
      "Reduce retries before tuning the dependency. Lower the retry budget, add jitter, raise the backoff base, and stop retrying non-idempotent or already-failed requests.",
    checkFirst: [
      "Compare offered load with the dependency's known capacity.",
      "Check whether retries are synchronized in waves.",
      "Check whether the retry path is shared by several callers at once.",
    ],
  },
  {
    id: "dep-util",
    metricId: "dep-util",
    warn: 70,
    crit: 90,
    title: "The dependency is beyond its safe utilization",
    cause:
      "Retries and original traffic together exceed what the dependency can serve with acceptable latency. At this point success rate falls because the dependency is saturated, not because the original request was invalid.",
    fix:
      "Cut retry volume and shed low-value load. If the dependency is healthy but underprovisioned, add capacity only after the retry multiplication is bounded.",
    checkFirst: [
      "Compare original traffic with total offered load.",
      "Check the dependency's own saturation signals: CPU, queue, or provider limits.",
      "Check whether a retry budget is shared across callers.",
    ],
  },
  {
    id: "dep-errors",
    metricId: "dep-errors",
    warn: 5,
    crit: 20,
    title: "The dependency error rate is preventing recovery",
    cause:
      "The dependency is returning errors while retries keep arriving. A dependency that needs a quiet period to recover will not get one if the retry policy holds load above capacity.",
    fix:
      "Stop the retry amplification first, then allow the dependency to recover. Add a circuit breaker or retry budget so recovery is possible without manual intervention.",
    checkFirst: [
      "Check whether errors started before or after the retry rate rose.",
      "Check whether the dependency recovers when offered load drops in a test.",
      "Check the retry budget and the backoff distribution.",
    ],
  },
  {
    id: "queueDepth",
    metricId: "queueDepth",
    warn: 500,
    crit: 2_000,
    title: "The retry backlog is growing faster than it drains",
    cause:
      "Scheduled retries are accumulating because the dependency is failing and each attempt schedules another. The backlog is a leading indicator of a storm that will outlive the original failure.",
    fix:
      "Drop or cap the retry backlog, reduce the retry budget, and stop accepting new low-priority work. Do not drain the backlog into a dependency that is still saturated.",
    checkFirst: [
      "Check whether the backlog has an age limit or a maximum size.",
      "Check whether retries are idempotent and safe to drop.",
      "Check whether the dependency is recovering or still failing.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const retryModel: SimModel = {
  id: "foundations-retry-backoff-jitter",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(
      defaults(),
      { amplification: 1, utilPct: 66.7, errorPct: 0.2, pending: 0, recovery: 0 },
      seed,
    );
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt, rng: Rng) => {
    const values = readParams(p);
    const queues = readQueues(frame);
    const due = queues.map((queue) => {
      const count = queue.shift() ?? 0;
      queue.push(0);
      return count;
    });
    const originals = values.trafficRps * dt;
    const retryLoad = due.reduce((sum, count) => sum + count, 0);
    const offered = originals + retryLoad;
    const offeredRps = offered / Math.max(0.0001, dt);
    const outage = values.faultInjected === 1 && frame.t < OUTAGE_SEC;
    let recovery = Number(frame.flags.recovery ?? 0);
    const util = offeredRps / DEP_CAPACITY;
    if (outage) {
      recovery = RECOVERY_HOLD_SEC;
    } else if (util > 1) {
      recovery = RECOVERY_HOLD_SEC;
    } else if (recovery > 0) {
      recovery = util < 0.9 ? Math.max(0, recovery - dt) : Math.min(RECOVERY_HOLD_SEC, recovery + dt);
    }
    const degraded = outage || util > 1 || recovery > 0;
    const errorRate = degraded ? 1 : 0.002;

    let retryBudget = values.trafficRps * values.retryBudgetPct * dt;
    const schedule = (count: number, attempt: number) => {
      if (attempt > values.maxRetries || count <= 0 || retryBudget <= 0) return;
      const allowed = Math.min(count, retryBudget);
      retryBudget -= allowed;
      const exponent = Math.max(0, attempt - 1);
      const spread = 1 + values.jitterPct * (rng.next() * 2 - 1);
      const delaySec = (values.baseDelayMs / 1_000) * 2 ** exponent * spread;
      const index = Math.max(0, Math.min(BUCKETS - 1, Math.round(delaySec / BUCKET_SEC)));
      queues[attempt][index] += allowed;
    };

    schedule(originals * errorRate, 1);
    for (let attempt = 1; attempt < values.maxRetries; attempt++) {
      schedule(due[attempt] * errorRate, attempt + 1);
    }

    const pending = sumQueues(queues);
    const amplificationTarget = offered / Math.max(1, originals);
    const previousAmplification = Number(frame.flags.amplification ?? 1);
    const amplification = previousAmplification + (amplificationTarget - previousAmplification) * Math.min(1, dt / 0.4);
    const state = {
      amplification,
      utilPct: util * 100,
      errorPct: errorRate * 100,
      pending,
      recovery,
    };
    const next = buildFrame(p, state, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.queues = JSON.stringify(queues);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (util >= 2 && frame.flags.stormDetected !== 1) {
      pushEvent(next, {
        id: "retry-storm-detected",
        at: frame.t,
        severity: "crit",
        title: "Retry amplification is keeping the dependency down",
        detail: `Offered load is ${offeredRps.toFixed(0)} rps against an illustrative ${DEP_CAPACITY.toLocaleString()} rps capacity. The dependency cannot recover while retries hold it above capacity.`,
        metricId: "amplification",
        nodeId: "dependency",
      });
      next.flags.stormDetected = 1;
    }
    if (util < 1) next.flags.stormDetected = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = readParams(p);
    const ceiling = 1 + values.maxRetries;
    return [
      `With ${values.maxRetries} retries, one original request can become ${ceiling} attempts before the retry budget binds.`,
      `A ${(values.retryBudgetPct * 100).toFixed(0)}% budget caps retries at ${Math.round(values.trafficRps * values.retryBudgetPct).toLocaleString()} rps on top of ${values.trafficRps.toLocaleString()} original rps.`,
      `The first retry waits about ${values.baseDelayMs}ms before jitter; each later attempt doubles the base.`,
      `Jitter at ${(values.jitterPct * 100).toFixed(0)}% spreads the wave. At zero, every client retries at the same instant.`,
      "The dependency must drop below its recovery threshold before it can serve again. A retry budget bounds the load that prevents that drop.",
    ];
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Amplified", tone: "warn" },
    { label: "Storm", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "No fault is injected. The dependency is healthy and the retry policy stays bounded.",
    tone: "ok",
    params: defaults({ trafficRps: 6_000, maxRetries: 2, baseDelayMs: 300, jitterPct: 60, retryBudgetPct: 5, faultInjected: 0 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher traffic and a 20% retry budget. Amplification stays bounded but load rises.",
    tone: "warn",
    params: defaults({ trafficRps: 7_000, maxRetries: 2, baseDelayMs: 250, jitterPct: 50, retryBudgetPct: 20 }),
  },
  {
    id: "failure",
    label: "Retry storm",
    description: "Five retries and a 500% budget. Six times the original load keeps the dependency down.",
    tone: "crit",
    params: defaults({ trafficRps: 8_000, maxRetries: 5, baseDelayMs: 100, jitterPct: 0, retryBudgetPct: 500 }),
  },
  {
    id: "sync-retries",
    label: "Synchronized retries",
    description: "No jitter. Every client retries in the same wave even with a lower attempt count.",
    tone: "warn",
    params: defaults({ trafficRps: 7_000, maxRetries: 4, baseDelayMs: 50, jitterPct: 0, retryBudgetPct: 400 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 5% budget, jitter, and a longer base delay let the dependency drain and recover.",
    tone: "ok",
    params: defaults({ trafficRps: 8_000, maxRetries: 2, baseDelayMs: 500, jitterPct: 80, retryBudgetPct: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-retry-amplification",
  title: "Predict the load after the dependency returns",
  simId: "retries",
  question:
    "Nine thousand requests per second hit a dependency that returns 503 for two seconds. Every request retries three times with no jitter and a retry budget high enough not to bind. What load does the dependency see?",
  prediction: {
    options: [
      { id: "one", label: "About 1x; retries stop after the first failure" },
      { id: "two", label: "About 2x; only one retry reaches the dependency" },
      { id: "four", label: "Up to 4x, and the dependency stays down" },
      { id: "half", label: "About 0.5x; clients back off and traffic falls" },
    ],
    correctOptionId: "four",
    explanation:
      "One original attempt plus three retries is four attempts per logical request. Nine thousand requests per second become up to 36,000 attempts against a 12,000 rps dependency. The dependency cannot recover while the retries keep it above capacity, so the two-second outage becomes a sustained one.",
  },
  setup: defaults({ trafficRps: 9_000, maxRetries: 3, baseDelayMs: 200, jitterPct: 0, retryBudgetPct: 400 }),
  runFor: 15,
  observe: [
    "Offered load reaches about 4x the original request rate.",
    "Dependency utilization stays above 100% and the error rate stays high after the original outage would have cleared.",
    "The pending retry backlog grows because every failed attempt schedules the next one.",
    "Without a budget or breaker, the dependency never gets the quiet period it needs to recover.",
  ],
  explain:
    "Amplification is attempts per logical request. Retries are additional requests, so the dependency sees the original traffic plus every retry. A retry budget caps that addition as a share of original traffic; jitter and backoff spread it in time; neither reduces the effect of a retry that is already in flight. The dependency recovers only when offered load falls below its recovery threshold.",
  fix: defaults({ trafficRps: 9_000, maxRetries: 2, baseDelayMs: 500, jitterPct: 80, retryBudgetPct: 5 }),
  debrief:
    "A 5% budget caps retries at 450 rps, so the dependency sees 9,450 rps, about 79% of its illustrative capacity. With jitter and a 500ms base delay, the retries spread out and the dependency drains enough to recover. The remaining tradeoff is that some transient failures now return errors to users instead of being retried, which is the correct choice when retrying would prevent recovery.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A retry repeats a failed request in the hope that the failure was transient. It is useful when failures are independent and short. It is dangerous when the dependency is overloaded, because every retry is additional load on a system that is already failing. Retry amplification is the ratio of total attempts to original requests. One retry on every request doubles the load; three retries can quadruple it, and more attempts can multiply further.",
  },
  {
    type: "p",
    text: "Backoff delays each later attempt so a client does not hammer a dependency. Exponential backoff doubles the delay per attempt. Jitter randomizes the delay so many clients do not retry at the same instant. A retry budget caps retries as a share of original traffic, and a circuit breaker stops retries entirely when the failure rate is high. These controls solve different parts of the problem: backoff reduces rate, jitter removes synchronization, and a budget or breaker bounds the total load.",
  },
  {
    type: "p",
    text: "A retry storm is a feedback loop. The dependency fails because it is overloaded, clients retry, the retries increase the overload, and the dependency stays down after the original trigger clears. The loop can outlive the cause. Stopping it requires reducing the retry load before tuning the dependency, because a dependency that needs a quiet period will not recover while the retries keep arriving.",
  },
  {
    type: "table",
    headers: ["Policy", "What it changes", "Failure mode"],
    rows: [
      ["Immediate retry", "Recovers a single lost response quickly", "Synchronized load spike; amplifies an overload"],
      ["Fixed delay", "Spaces attempts by a constant", "All clients still retry together"],
      ["Exponential backoff", "Reduces the retry rate over time", "Long tail; still synchronized without jitter"],
      ["Backoff plus jitter", "Spreads attempts across clients", "Still unbounded if the failure persists"],
      ["Retry budget or breaker", "Caps total retry load", "Some transient failures become user-visible errors"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Retries can live in the client SDK, the API gateway, the service mesh, or the application. They compose badly: a gateway retry, an SDK retry, and an application retry can multiply into far more attempts than any one layer intended. Each layer must know the retry policy of the others, or the totals must be bounded by a shared budget. The dependency sees only the sum.",
  },
  {
    type: "p",
    text: "The model shows a gateway, a retry backlog, and a dependency with an illustrative 12,000 rps capacity. The dependency returns errors for the first two simulated seconds and then needs a quiet period to recover. Retries are scheduled on a 0.1-second delay grid with exponential backoff and optional jitter. The capacity and timings are teaching values, not a specific provider's limits.",
  },
  {
    type: "compare",
    leftTitle: "Synchronized retries",
    rightTitle: "Jittered retries",
    rows: [
      { label: "Arrival pattern", left: "Waves at the same instant", right: "Spread across the delay window" },
      { label: "Effect on a recovering dependency", left: "Repeated spikes reset recovery", right: "A smoother load that can drain" },
      { label: "Tail latency", left: "Long waits behind each wave", right: "More even, but some requests wait longer than the base delay" },
      { label: "What it does not fix", left: "Total amplification", right: "Total amplification" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Request amplification: total attempts divided by original requests, with warnings at 2x and 3x.",
      "Dependency utilization and error rate: the load the retries create and whether the dependency can recover.",
      "Pending retries: the backlog that will arrive even if the original failure stops now.",
      "Retry budget: the configured ceiling on retries as a share of original traffic.",
      "A queue visual that shows original traffic, the retry backlog, and the dependency as separate stages.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Retry storm. Watch amplification and pending retries rise while the dependency error rate stays high after the initial outage. Compare Synchronized retries with a jittered policy. Run the experiment before reading its explanation, then apply the fix and check that the dependency recovers.",
  },
  { type: "sim", simId: "retries" },
  { type: "experiment", experimentId: "predict-retry-amplification" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The dependency failed for two seconds. Every failed request scheduled another attempt, and the attempts arrived while the dependency was still down. Offered load rose above capacity, so the dependency stayed in error and the retries kept scheduling. The backlog grew, and the failure outlived its trigger.",
  },
  {
    type: "p",
    text: "Adding jitter and a longer base delay spread the attempts, but the total was still set by the attempt count. The retry budget was the hard ceiling: it capped retries as a share of original traffic, so the dependency could drain and recover. The cost was that some transient failures became user-visible errors instead of being retried.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Gateway and mesh: retry counters such as Envoy `upstream_rq_retry`, `upstream_rq_retry_success`, and `upstream_rq_retry_overflow`, compared with original request rate.",
      "Dependency: error rate, latency, CPU or queue depth, and provider rate-limit responses. The error rate stays high after the original trigger clears.",
      "Queues: pending retries and age of the oldest retry. A growing backlog means the storm will continue even if the trigger stops now.",
      "Logs: repeated attempt numbers for one request ID, and a retry delay that is identical across many clients.",
      "Traces: one logical request with several child attempts, often with the same downstream span name and increasing timestamps.",
      "Client behavior: a synchronized spike at a round-number delay after the failure, which is the signature of zero jitter.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Reduce retries before tuning the dependency. Check whether the retry budget is a real cap or only a metric, whether jitter is enabled at every retry layer, and whether the offered load is above the dependency's recovery threshold. Then check for a retry loop that outlived the original error.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop or cap retries on the affected path. A dependency that is still saturated cannot be tuned back to health.",
      "Measure original traffic and total attempts separately; the difference is the amplification.",
      "Add full jitter to every retry layer and remove nested retries that multiply.",
      "Set a retry budget as a share of original traffic and enforce it, not just observe it.",
      "Use a circuit breaker to stop retries when the failure rate is high and probe recovery with limited traffic.",
      "Make retried writes idempotent so a retry cannot create a duplicate effect.",
      "Recover the dependency, then raise the budget gradually and watch the next limit.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Retries improve success for transient faults and increase load on a failing dependency. The budget decides which effect dominates.",
      "Jitter spreads load but makes individual latency less predictable; some requests wait longer than the base delay.",
      "A long backoff reduces amplification and increases the time a user waits before the final failure.",
      "A retry budget protects the dependency and turns some recoverable failures into errors the user sees.",
      "A breaker fails fast and can open on a healthy dependency during a brief blip; the half-open probe must be bounded.",
      "Retries are only safe for idempotent operations. Retrying a charge, an email, or an inventory decrement without a key creates duplicates.",
      "Layered retries are the most common cause of an accidental storm: each layer looks reasonable, and the product is the multiplication.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "calculate-amplification",
    question:
      "A service handles 5,000 requests per second. Each request retries three times on failure, and 40% of attempts fail. What is the offered load at the dependency?",
    difficulty: 3,
    hints: [
      "Start with one original plus the retries that actually occur.",
      "The failure rate applies at each attempt, not only the first.",
    ],
    answer:
      "I would model it attempt by attempt. The first attempt is 5,000 rps. If 40% fail, 2,000 retries are scheduled for attempt two; 40% of those, 800, schedule attempt three; 320 schedule attempt four. The total is 5,000 plus 2,000 plus 800 plus 320, or 8,120 rps, which is about 1.62x the original. If every attempt failed, the ceiling would be 4x, or 20,000 rps. A retry budget would cap the sum directly, which is more predictable than trying to reason about the failure rate at each level.",
    followUps: [
      "How does a 10% retry budget change the answer?",
      "What if the failure rate rises as load rises?",
      "Why is the theoretical ceiling usually the wrong planning number?",
    ],
    redFlags: [
      "Multiplies 5,000 by 4 without applying the failure rate.",
      "Ignores retries of retries.",
      "Assumes the dependency capacity is unchanged.",
    ],
    rubric: [
      "Models attempts level by level.",
      "Computes the actual total.",
      "Contrasts the ceiling with the budget.",
      "Mentions load-dependent failure.",
    ],
  },
  {
    id: "stop-the-storm",
    question:
      "The dependency is healthy again but request volume is still three times normal. What is the first move?",
    difficulty: 3,
    hints: [
      "The trigger is gone; the feedback loop is not.",
      "Load, not the dependency, is the current problem.",
    ],
    answer:
      "I would reduce retry load first, not tune the dependency. The dependency may be healthy but still unable to absorb three times its normal traffic, and every retry keeps the loop alive. I would cut the retry budget, disable retries on the affected path, add jitter or increase backoff, and shed low-priority traffic. Then I would watch offered load fall below the dependency's recovery threshold and confirm the error rate drops. Only after the loop is broken would I investigate why the original failure happened.",
    followUps: [
      "How do you decide between cutting retries and scaling the dependency?",
      "What if several services share the same dependency?",
      "Which metric tells you the loop is broken?",
    ],
    redFlags: [
      "Scales the dependency first.",
      "Waits for the dependency to recover on its own.",
      "Changes timeouts without reducing retries.",
    ],
    rubric: [
      "Reduces retry load first.",
      "Names budget, jitter, and shedding.",
      "Verifies offered load and error rate.",
      "Separates the trigger from the loop.",
    ],
  },
  {
    id: "jitter-and-budget",
    question:
      "Why is jitter not enough on its own, and why is a retry budget not enough on its own?",
    difficulty: 3,
    hints: [
      "Jitter changes when retries arrive; a budget changes how many.",
      "A budget can still allow a synchronized burst.",
    ],
    answer:
      "Jitter spreads retries in time, which prevents synchronized spikes and gives a recovering dependency a smoother load, but it does not reduce the total number of attempts. A budget caps the total retry volume, but a budget-compliant set of retries can still arrive in a burst if every client uses the same delay. You need both: the budget bounds the amplification and the jitter spreads what the budget allows. Backoff adds a third control by reducing the rate over time. A breaker covers the case where the failure persists and even a bounded budget is too much.",
    followUps: [
      "How would you choose the budget percentage?",
      "What does full jitter mean?",
      "How does a breaker interact with a retry budget?",
    ],
    redFlags: [
      "Treats jitter as a load reduction.",
      "Treats a budget as a latency control.",
      "Adds controls without saying what each one bounds.",
    ],
    rubric: [
      "Separates timing from volume.",
      "Explains the burst that a budget can still allow.",
      "Combines budget, jitter, backoff, and breaker.",
      "Connects each control to a failure mode.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every retry layer is inventoried: SDK, gateway, mesh, and application.",
      "Retries are limited to idempotent operations or protected by an idempotency key.",
      "Backoff is exponential and jitter is enabled at every layer.",
      "A retry budget exists as an enforced cap, not only a dashboard metric.",
      "A breaker or admission policy can stop retries when the dependency is failing.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Reduce retry load before tuning the dependency.",
      "Measure original traffic and total attempts separately.",
      "Check pending retries and the age of the oldest retry.",
      "Check whether the dependency is recovering or still saturated.",
      "Record the retry change and the observed load in the timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the dependency recovers when offered load drops.",
      "Review nested retry layers for accidental multiplication.",
      "Add a test that injects a dependency outage and measures amplification.",
      "Tune the budget from observed recovery behavior, not from a default.",
    ],
  },
];

const references = [
  {
    title: "Timeouts, retries, and backoff with jitter",
    url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Retry amplification, backoff, jitter, and the interaction with timeouts.",
  },
  {
    title: "Exponential Backoff and Jitter",
    url: "https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/",
    publisher: "AWS Architecture Blog",
    kind: "docs" as const,
    note: "Full jitter and the effect of correlated retries on load.",
  },
  {
    title: "Handling Overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "Retry budgets, client-side throttling, and protecting an overloaded service.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    retries: {
      model: retryModel,
      presets,
      instructions:
        "Start Healthy, then apply Retry storm. Watch amplification, pending retries, and dependency error rate together. Compare Synchronized retries with jitter, run the experiment, then apply the fix and confirm recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "timeline"],
      note: "Illustrative model. The dependency capacity is 12k rps, the outage lasts 2 simulated seconds, and retries are scheduled on a 100ms grid.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-timeouts",
    "foundations-circuit-breaking",
    "reliability-retry-storms",
    "mesh-retries",
  ],
};
