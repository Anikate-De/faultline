import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ARRIVAL_RPS = 500;
const THREAD_POOL = 400;
const P99_MULTIPLIER = 1.6;

const params: ParamSpec[] = [
  {
    id: "totalBudgetMs",
    label: "End-to-end budget",
    min: 200,
    max: 3_000,
    step: 50,
    value: 1_500,
    unit: " ms",
    group: "Budget",
    help: "The time the caller will wait for the whole request, including every hop and retry.",
    format: "ms",
  },
  {
    id: "hopATimeoutMs",
    label: "Hop A timeout",
    min: 50,
    max: 2_000,
    step: 50,
    value: 600,
    unit: " ms",
    group: "Per-hop timeouts",
    help: "Timeout for the first downstream call. It must fit inside the remaining budget.",
    format: "ms",
  },
  {
    id: "hopBTimeoutMs",
    label: "Hop B timeout",
    min: 50,
    max: 2_000,
    step: 50,
    value: 600,
    unit: " ms",
    group: "Per-hop timeouts",
    help: "Timeout for the second call. A fresh full timeout restarts the clock instead of respecting the budget.",
    format: "ms",
  },
  {
    id: "hopCTimeoutMs",
    label: "Hop C timeout",
    min: 50,
    max: 2_000,
    step: 50,
    value: 600,
    unit: " ms",
    group: "Per-hop timeouts",
    help: "Timeout for the third call. The sum of hop timeouts is the worst-case work a request can start.",
    format: "ms",
  },
  {
    id: "hopLatencyMs",
    label: "Downstream latency per hop",
    min: 10,
    max: 1_500,
    step: 10,
    value: 100,
    unit: " ms",
    group: "Dependency",
    help: "Typical time each dependency takes. The model assumes the same value for all three hops.",
    format: "ms",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  budgetMs: number;
  hopTimeouts: number[];
  latencyMs: number;
  success: boolean;
  failureRate: number;
  visibleMs: number;
  p99Ms: number;
  poolUtil: number;
  orphanMs: number;
  failedHop: number;
  sumTimeouts: number;
}

function compute(p: Params, poolOverride?: number): Computed {
  const budgetMs = num(p, "totalBudgetMs", 1_500);
  const hopTimeouts = [
    num(p, "hopATimeoutMs", 600),
    num(p, "hopBTimeoutMs", 600),
    num(p, "hopCTimeoutMs", 600),
  ];
  const latencyMs = num(p, "hopLatencyMs", 100);
  const failedHop = hopTimeouts.findIndex((timeout) => latencyMs > timeout);
  let success = false;
  let visibleMs: number;
  let orphanMs = 0;
  if (failedHop >= 0) {
    const before = failedHop * latencyMs;
    visibleMs = Math.min(budgetMs, before + hopTimeouts[failedHop]);
    orphanMs = 0;
  } else if (latencyMs * 3 > budgetMs) {
    visibleMs = budgetMs;
    orphanMs = Math.max(0, Math.min(latencyMs * 3, hopTimeouts.reduce((sum, value) => sum + value, 0)) - budgetMs);
  } else {
    success = true;
    visibleMs = latencyMs * 3;
  }
  const p99Ms = success ? Math.min(budgetMs, visibleMs * P99_MULTIPLIER) : visibleMs;
  const poolTarget = (ARRIVAL_RPS * (visibleMs / 1_000)) / THREAD_POOL;
  return {
    budgetMs,
    hopTimeouts,
    latencyMs,
    success,
    failureRate: success ? 0 : 100,
    visibleMs,
    p99Ms,
    poolUtil: poolOverride === undefined ? poolTarget * 100 : poolOverride,
    orphanMs,
    failedHop,
    sumTimeouts: hopTimeouts.reduce((sum, value) => sum + value, 0),
  };
}

function healthFor(failureRate: number): "ok" | "warn" | "crit" {
  if (failureRate >= 5) return "crit";
  if (failureRate >= 1) return "warn";
  return "ok";
}

function buildFrame(p: Params, poolOverride: number | undefined, seed: number): SimFrame {
  const values = compute(p, poolOverride);
  const health = healthFor(values.failureRate);
  const poolHealth = values.poolUtil >= 95 ? "crit" : values.poolUtil >= 80 ? "warn" : "ok";
  const hopDetail = (index: number): string => {
    if (values.failedHop === index) return `Typical latency ${values.latencyMs}ms. The hop timeout fires before the work finishes.`;
    if (values.failedHop >= 0 && index > values.failedHop) return `Typical latency ${values.latencyMs}ms. Not reached; the request failed at an earlier hop.`;
    if (!values.success) return `Typical latency ${values.latencyMs}ms. Completed, but the caller ran out of budget before the chain returned.`;
    return `Typical latency ${values.latencyMs}ms. The hop finishes inside its own timeout.`;
  };
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "caller",
        label: "Caller",
        kind: "client",
        health,
        utilization: clamp(values.poolUtil / 100),
        sublabel: `${values.budgetMs}ms budget`,
        meta: { view: "flow" },
      },
      {
        id: "gateway",
        label: "Edge gateway",
        kind: "lb",
        health: poolHealth,
        utilization: clamp(values.poolUtil / 100),
        throughput: ARRIVAL_RPS,
        sublabel: `${values.poolUtil.toFixed(0)}% pool used`,
        detail: `${THREAD_POOL} request slots at ${ARRIVAL_RPS} rps. A request holds a slot for about ${values.visibleMs.toFixed(0)}ms.`,
        meta: { view: "flow" },
      },
      ...values.hopTimeouts.map((timeout, index) => ({
        id: `hop-${index}`,
        label: `Service ${String.fromCharCode(65 + index)}`,
        kind: "service" as const,
        health: values.failedHop === index ? ("crit" as const) : ("ok" as const),
        utilization: clamp(values.visibleMs / Math.max(1, values.budgetMs)),
        sublabel: `${timeout}ms timeout`,
        detail: hopDetail(index),
        meta: { view: "flow", latency: values.latencyMs },
      })),
    ],
    edges: [
      edge("caller-gateway", "caller", "gateway", 0.8, health),
      ...values.hopTimeouts.map((_, index) =>
        edge(
          index === 0 ? "gateway-hop-0" : `hop-${index - 1}-hop-${index}`,
          index === 0 ? "gateway" : `hop-${index - 1}`,
          `hop-${index}`,
          0.8,
          values.failedHop === index ? "crit" : "ok",
        ),
      ),
    ],
    metrics: [
      metric("failure-rate", "Request failure rate", values.failureRate, "%", 1, 5, "percent"),
      metric("p99", "End-to-end p99", values.p99Ms, "ms", 900, 1_500, "ms"),
      metric("pool-util", "Request pool utilization", values.poolUtil, "%", 80, 95, "percent"),
      metric("orphan-ms", "Work orphaned past the budget", values.orphanMs, "ms", 200, 500, "ms"),
      metric("success-rate", "Success rate", values.success ? 100 : 0, "%", undefined, undefined, "percent"),
      metric("sum-timeouts", "Sum of hop timeouts", values.sumTimeouts, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      poolUtil: values.poolUtil,
      paramsKey: JSON.stringify(p),
    },
    summary: values.success
      ? `Success at ${values.visibleMs.toFixed(0)}ms; ${values.budgetMs}ms budget; pool ${values.poolUtil.toFixed(0)}%.`
      : `Failure at ${values.visibleMs.toFixed(0)}ms; ${values.budgetMs}ms budget; ${values.orphanMs.toFixed(0)}ms orphaned work.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 12 }, (_, index) => {
      const wave = Math.sin((index + (seed % 8)) / 2.5) * Math.max(0.3, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failure-rate",
    metricId: "failure-rate",
    warn: 1,
    crit: 5,
    title: "Requests are failing before the work can finish",
    cause:
      "The end-to-end budget, a per-hop timeout, or the sum of both is shorter than the work the chain actually needs. The caller receives a timeout while downstream work may still be running.",
    fix:
      "Measure each hop before changing a number. Raise the budget only if the product can wait, reduce downstream latency, or shorten the chain. Then propagate the remaining deadline to every hop.",
    checkFirst: [
      "Identify which hop or budget boundary fired from the trace.",
      "Compare each hop's p99 with its configured timeout.",
      "Check whether retries are consuming the same budget.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 900,
    crit: 1_500,
    title: "End-to-end latency crossed the critical threshold",
    cause:
      "The chain is spending its budget on serial hops or waiting for a slow dependency. A request can be slow without failing yet, which is the window before a timeout becomes an outage.",
    fix:
      "Reduce the slowest hop, parallelize independent calls, or lower the work per request. Do not simply raise the timeout; that moves the wait to the caller and holds resources longer.",
    checkFirst: [
      "Split latency by hop using traces, not logs.",
      "Check whether pool wait is included in the measured latency.",
      "Check whether the slow hop is also slow for other callers.",
    ],
  },
  {
    id: "pool-util",
    metricId: "pool-util",
    warn: 80,
    crit: 95,
    title: "The request pool is saturated",
    cause:
      "Requests are holding threads or connections for longer than the arrival pattern can absorb. Long timeouts, missing cancellation, and retries all increase hold time and turn latency into a queue.",
    fix:
      "Reduce hold time first: propagate cancellation, lower timeouts to the measured budget, and bound retries. Add capacity only after the work per request is understood.",
    checkFirst: [
      "Check active threads, queue wait, and connection pool wait separately.",
      "Check whether canceled requests keep running downstream.",
      "Check whether a retry policy is multiplying the arrival rate.",
    ],
  },
  {
    id: "orphan-ms",
    metricId: "orphan-ms",
    warn: 200,
    crit: 500,
    title: "Downstream work is outliving the caller",
    cause:
      "The caller stopped waiting at its deadline, but the downstream hops were given fresh timeouts and did not receive the remaining budget. The work continues after the user has gone, consuming capacity with no chance of a useful response.",
    fix:
      "Propagate the absolute deadline, not a new timeout. Cancel the context when the caller gives up, and make each hop derive its timeout from the remaining budget.",
    checkFirst: [
      "Compare the caller's deadline with the sum of downstream timeouts.",
      "Check for canceled spans that continue after the parent ends.",
      "Check whether the client library forwards a deadline header or only a per-call timeout.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const timeoutModel: SimModel = {
  id: "foundations-timeouts",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), undefined, seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt) => {
    const target = compute(p);
    const previous = Number(frame.flags.poolUtil ?? target.poolUtil);
    const smoothing = Math.min(1, dt / 1.5);
    const poolUtil = previous + (target.poolUtil - previous) * smoothing;
    const next = buildFrame(p, poolUtil, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const remaining = values.budgetMs - values.sumTimeouts;
    return [
      remaining >= 0
        ? `The three timeouts sum to ${values.sumTimeouts}ms against a ${values.budgetMs}ms budget, leaving ${remaining}ms of slack.`
        : `The three timeouts exceed the ${values.budgetMs}ms budget by ${Math.abs(remaining)}ms, so the chain can start more work than the caller will wait for.`,
      values.success
        ? `The typical request completes in ${values.visibleMs}ms, inside both the hops and the budget.`
        : `The typical request ends at ${values.visibleMs}ms; ${values.orphanMs > 0 ? "downstream work can continue after the caller gives up" : "a hop timeout fired before the chain could finish"}.`,
      `At ${ARRIVAL_RPS} rps and a ${values.visibleMs}ms hold time, the pool of ${THREAD_POOL} slots runs at ${values.poolUtil.toFixed(0)}%.`,
      `The sum of hop timeouts is the worst-case work a request can start, not the time the caller is willing to wait.`,
      "A propagated deadline shrinks each hop's allowed time; a fresh per-hop timeout restarts the clock.",
    ];
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Pool pressure", tone: "warn" },
    { label: "Budget exhausted", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 1.5s budget, three 600ms timeouts, and 100ms per hop. Plenty of room.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak latency",
    description: "Per-hop latency rises to 250ms. The request still succeeds but the pool is busy.",
    tone: "warn",
    params: defaults({ hopLatencyMs: 250 }),
  },
  {
    id: "failure",
    label: "Downstream slowness",
    description: "A 800ms budget with 600ms hops. Each hop fits its timeout, but the chain cannot fit the budget.",
    tone: "crit",
    params: defaults({
      totalBudgetMs: 800,
      hopATimeoutMs: 900,
      hopBTimeoutMs: 900,
      hopCTimeoutMs: 900,
      hopLatencyMs: 600,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The budget is unchanged, but downstream latency and hop timeouts fit inside it.",
    tone: "ok",
    params: defaults({
      totalBudgetMs: 800,
      hopATimeoutMs: 300,
      hopBTimeoutMs: 300,
      hopCTimeoutMs: 300,
      hopLatencyMs: 120,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-visible-timeout",
  title: "Predict what the caller observes",
  simId: "chain",
  question:
    "A caller has an 800ms budget. Each of three hops takes 400ms and has its own 600ms timeout. How long does the caller wait?",
  prediction: {
    options: [
      { id: "400", label: "About 400ms, the latency of one hop" },
      { id: "600", label: "About 600ms, the per-hop timeout" },
      { id: "800", label: "About 800ms, the caller budget" },
      { id: "1200", label: "About 1,200ms, the sum of the three hops" },
    ],
    correctOptionId: "800",
    explanation:
      "Every hop finishes inside its own 600ms timeout, so no hop timeout fires. The chain needs about 1,200ms, but the caller stops waiting at its 800ms deadline. The per-hop timeouts did not enforce the end-to-end budget.",
  },
  setup: defaults({
    totalBudgetMs: 800,
    hopATimeoutMs: 600,
    hopBTimeoutMs: 600,
    hopCTimeoutMs: 600,
    hopLatencyMs: 400,
  }),
  runFor: 10,
  observe: [
    "Failure rate is 100% even though no per-hop timeout fired.",
    "The caller observes about 800ms, not 1,200ms.",
    "About 400ms of downstream work is orphaned past the caller's deadline.",
    "The pool fills because each request holds a slot for the full budget.",
  ],
  explain:
    "A per-hop timeout bounds one call. A budget bounds the whole request. Three 600ms timeouts can start up to 1,800ms of work, which is more than the caller will wait. The fix is to compute each hop's timeout from the remaining budget and propagate the absolute deadline so the downstream hops stop when the caller stops.",
  fix: defaults({
    totalBudgetMs: 800,
    hopATimeoutMs: 250,
    hopBTimeoutMs: 250,
    hopCTimeoutMs: 250,
    hopLatencyMs: 200,
  }),
  debrief:
    "With 200ms per hop, the chain needs 600ms inside an 800ms budget, leaving 200ms for overhead and jitter. The hop timeouts are smaller than the budget and the deadline propagates, so a slow hop cannot spend time the caller no longer has. The tighter timeout is safe only because it is above the measured hop latency; a timeout below the real p99 would turn healthy requests into failures.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A timeout is a limit on how long one call may take. A deadline is an absolute point in time by which the whole request must finish. A budget is the time the caller is willing to wait. The three are related but not interchangeable: a per-hop timeout answers 'how long may this call take?', while a deadline answers 'how much time is left for everything?'",
  },
  {
    type: "p",
    text: "In a chain of three calls, giving each hop its own full timeout can start more work than the caller will ever wait for. With an 800ms budget and three 600ms timeouts, the chain can start up to 1,800ms of work. If the caller stops at 800ms but the downstream calls do not receive the deadline, they keep running after the user has gone. That is orphaned work, and it is how a timeout bug becomes a capacity incident.",
  },
  {
    type: "p",
    text: "The rule is to derive each hop's timeout from the remaining budget and to propagate the absolute deadline, not a fresh timeout. If the gateway has 800ms, and the first hop may use 250ms, the next hop receives roughly 550ms minus overhead, and so on. The smallest limit wins. A retry inside that budget must also fit; it cannot borrow time the caller does not have.",
  },
  {
    type: "table",
    headers: ["Control", "What it bounds", "Failure if missing"],
    rows: [
      ["Per-hop timeout", "One downstream call", "A stuck call waits indefinitely"],
      ["End-to-end budget", "The whole request", "The caller waits longer than the product allows"],
      ["Propagated deadline", "The remaining time at every hop", "Downstream work continues after the caller gives up"],
      ["Cancellation", "Work already in flight", "Orphaned requests consume threads and connections"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is caller, edge gateway, service A, service B, service C. Each layer may have its own timeout configured in a client library, a proxy, or application code. The caller's budget is usually set by the product: how long a user will wait before retrying or leaving. The gateway is the right place to establish the deadline because it sees the whole request. Each service then derives its own limit from the time remaining.",
  },
  {
    type: "p",
    text: "The model shows a typical per-hop latency and applies the same value to all three hops. It counts a request as failed when a hop timeout fires or when the chain exceeds the caller's budget. The request pool is an illustrative 400 slots at 500 requests per second; it exists to show that hold time becomes queueing. Numbers are teaching values, not a specific framework's thread pool or a cloud limit.",
  },
  {
    type: "compare",
    leftTitle: "Restart the clock",
    rightTitle: "Propagate the deadline",
    rows: [
      { label: "Each hop gets", left: "Its own full timeout", right: "The time remaining in the budget" },
      { label: "Worst-case work", left: "Sum of all hop timeouts", right: "Bounded by the caller's budget" },
      { label: "On caller timeout", left: "Downstream work may continue", right: "Cancellation travels with the context" },
      { label: "Failure mode", left: "Orphaned work and pool saturation", right: "Some hops may be cut earlier, which is the intended trade" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Request failure rate: the share of requests that hit a hop timeout or the caller budget.",
      "End-to-end p99: the latency the caller observes, including the effect of the budget.",
      "Request pool utilization: hold time multiplied by arrival rate, divided by slots.",
      "Orphaned work: downstream time that continues past the caller's deadline.",
      "Sum of hop timeouts: the worst-case work the chain can start, which should fit the budget.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Downstream slowness. Compare the sum of hop timeouts with the end-to-end budget and watch orphaned work and pool utilization rise. Run the experiment before reading its explanation, then apply the fix and check that the chain still fits inside 800ms.",
  },
  { type: "sim", simId: "chain" },
  { type: "experiment", experimentId: "predict-visible-timeout" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Each hop finished inside its own timeout, so no individual call looked broken. The chain as a whole needed more time than the caller had, so the caller gave up at its budget. The downstream work did not receive that deadline, so part of it kept running. The pool filled because every request held a slot for the full budget, and the latency became a queueing problem.",
  },
  {
    type: "p",
    text: "The recovery kept the budget but reduced per-hop latency and set hop timeouts that fit inside it. The chain completed with room for overhead, the pool drained, and the orphaned work disappeared. The timeout values were safe because they were above the measured hop latency, not because they were small.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "HTTP: 504 Gateway Timeout at the edge or proxy, and 499 or client-closed requests when the caller gives up first.",
      "gRPC: status `DEADLINE_EXCEEDED` (code 4), and `context deadline exceeded` in service logs. The deadline is carried in the request metadata.",
      "Envoy or another proxy: `upstream_rq_timeout`, `upstream_rq_pending_overflow`, and per-route timeout configuration. The proxy's timeout can win before the application's.",
      "Thread and connection pools: active threads, queue wait, and pool wait time. High active count with low CPU is a hold-time problem, not a compute problem.",
      "Traces: a parent span that ends at the budget while child spans continue, or a child span with a canceled status after the parent completed.",
      "Load balancer and client metrics: retry rate and connection churn. Retries consume the same budget and add load.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find which limit fired: a per-hop timeout, the caller budget, or a proxy timeout. Compare each hop's p99 with its configured limit, and compare the sum of hop timeouts with the end-to-end budget. Then check whether the deadline and cancellation actually reach the downstream call.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure p99 per hop before changing any timeout. A timeout below the real p99 creates failures.",
      "Set the end-to-end budget from the product's tolerance, including the response path to the user.",
      "Reserve overhead for serialization, queueing, and network, then derive each hop's timeout from the remaining budget.",
      "Propagate the absolute deadline and cancel the context when the caller gives up.",
      "Bound retries inside the same budget; a retry cannot restart the clock.",
      "If the work cannot fit, shorten the chain, parallelize independent calls, or shed low-value work.",
      "Load test the failure path and verify that canceled requests stop consuming downstream capacity.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A tight timeout fails fast and protects the pool, but it can cut legitimate slow requests and create false errors.",
      "A loose timeout protects the slow tail and holds resources longer, which turns latency into queueing under load.",
      "Propagating a deadline can cut a downstream call that would have finished, but it prevents work the caller no longer needs.",
      "Retries improve success for transient faults and consume budget and capacity. They must be bounded and idempotent.",
      "Long-running jobs, streaming responses, and uploads need different limits; a single request timeout is the wrong control for all of them.",
      "Clocks and timeout headers are not free: a deadline depends on synchronized time or on a duration that is decremented at each hop.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "set-three-timeouts",
    question:
      "A request has an 800ms end-to-end budget and three serial calls. How do you set the timeouts?",
    difficulty: 2,
    hints: [
      "Measure the hops before choosing numbers.",
      "The sum of the limits must fit inside the budget, including overhead.",
    ],
    answer:
      "I would start from measured p99 per hop, not from an equal division. Suppose the hops measure 150ms, 250ms, and 200ms at p99. I would reserve something like 100ms for serialization, queueing, and network, leaving about 700ms for the calls. I would set each hop's timeout above its p99, for example 200ms, 300ms, and 250ms, so the sum fits the remaining budget. The gateway establishes the absolute deadline, and each hop derives its limit from the time left rather than starting a fresh 800ms clock. If the work cannot fit, I would shorten the chain or reduce the work before raising the budget.",
    followUps: [
      "What if one hop's p99 alone is 600ms?",
      "How do retries fit in the budget?",
      "What do you do when the product owner asks for a longer timeout?",
    ],
    redFlags: [
      "Sets all three to 800ms.",
      "Divides the budget without measuring.",
      "Forgets overhead and retries.",
    ],
    rubric: [
      "Starts from measured per-hop latency.",
      "Fits the sum inside the budget.",
      "Propagates the deadline.",
      "Names what to do when work cannot fit.",
    ],
  },
  {
    id: "timeout-vs-deadline",
    question:
      "Explain the difference between a timeout and a deadline, and why the distinction matters for cancellation.",
    difficulty: 3,
    hints: [
      "One is a duration; the other is an absolute point in time.",
      "A retry or a nested call can restart a duration.",
    ],
    answer:
      "A timeout is a duration applied to one operation. A deadline is an absolute time by which the whole request must finish. If every hop applies a fresh timeout, each one restarts the clock and the sum can exceed what the caller will wait. A deadline is computed once at the edge and passed down; each hop converts it to the time remaining. When the deadline expires, the context is canceled and the downstream work stops. The distinction matters because cancellation is only useful if every layer knows the same end time.",
    followUps: [
      "How is a gRPC deadline carried?",
      "What happens if one hop ignores cancellation?",
      "How do you test deadline propagation?",
    ],
    redFlags: [
      "Uses the terms interchangeably.",
      "Restarts a timeout at each hop.",
      "Has no cancellation path.",
    ],
    rubric: [
      "Defines duration versus absolute time.",
      "Explains the sum problem.",
      "Connects the deadline to cancellation.",
      "Mentions propagation across layers.",
    ],
  },
  {
    id: "debug-504",
    question:
      "Users see 504s on a three-hop request. The application logs show successful downstream calls. How do you find which timeout won?",
    difficulty: 3,
    hints: [
      "Compare the proxy, the caller, and the application clocks.",
      "A successful downstream call can still finish after the caller gave up.",
    ],
    answer:
      "I would correlate the request ID across the edge, the proxy, and the services, then compare the timestamps and durations of each span. A downstream success that ends after the caller's budget is the signature of a deadline that was not propagated or a proxy timeout that is shorter than the application's. I would check the proxy route timeout, the caller's budget, and each hop's configured timeout, then look for a child span that continues after the parent ends. The fix depends on which limit fired: align the proxy with the application, lower per-hop timeouts to fit the budget, or propagate the deadline so the downstream work stops.",
    followUps: [
      "How would you tell a proxy timeout from an application timeout?",
      "What if the logs have different clock skew?",
      "Which metric would you add to catch this earlier?",
    ],
    redFlags: [
      "Assumes the downstream service is slow.",
      "Ignores the proxy layer.",
      "Changes timeouts without identifying the winner.",
    ],
    rubric: [
      "Correlates traces across layers.",
      "Compares each configured limit.",
      "Recognizes work after the parent ends.",
      "Chooses a fix based on the limit that fired.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The end-to-end budget is written down for every user-facing route.",
      "Each hop's p99 is measured and each timeout is set above it.",
      "The sum of per-hop timeouts fits inside the budget with overhead reserved.",
      "Deadlines are propagated and cancellation is tested across every client.",
      "Retries are bounded inside the same budget and only used for safe operations.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify whether a hop timeout, the caller budget, or a proxy timeout fired.",
      "Compare per-hop p99 with the configured limits before changing a number.",
      "Check pool wait and active threads for hold-time saturation.",
      "Reduce demand or shorten the chain if the work cannot fit the budget.",
      "Record the limit, the evidence, and the change in the incident timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the deadline reaches every downstream call under load.",
      "Load test the slow-hop path and confirm canceled work stops.",
      "Review whether the budget matched the product's tolerance.",
      "Add a trace check or alert for work that continues after the parent span.",
    ],
  },
];

const references = [
  {
    title: "Addressing Cascading Failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "Timeouts, retries, and overload behavior in request chains.",
  },
  {
    title: "Deadlines",
    url: "https://grpc.io/docs/guides/deadlines/",
    publisher: "gRPC",
    kind: "docs" as const,
    note: "How gRPC deadlines propagate and what DEADLINE_EXCEEDED means.",
  },
  {
    title: "Cancellation",
    url: "https://grpc.io/docs/guides/cancellation/",
    publisher: "gRPC",
    kind: "docs" as const,
    note: "Propagating cancellation when a caller no longer needs the result.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    chain: {
      model: timeoutModel,
      presets,
      instructions:
        "Start Healthy, apply Downstream slowness, and compare the sum of hop timeouts with the end-to-end budget. Watch orphaned work and pool utilization. Run the experiment, then apply the fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. All three hops share one latency value, p99 is modeled as 1.6x the typical end-to-end time, and 500 rps hits a 400-slot pool. These are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-littles-law",
    "foundations-retry-backoff-jitter",
    "mesh-timeouts",
    "foundations-circuit-breaking",
  ],
};
