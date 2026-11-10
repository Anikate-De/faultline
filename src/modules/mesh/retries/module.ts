import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAPACITY = 12_000;
const BASE_LATENCY = 120;
const FAULT_START = 4;
const MAX_RATE = 20_000;

const params = [
  {
    id: "requestRate",
    label: "Client request rate",
    min: 1_000,
    max: MAX_RATE,
    step: 500,
    value: 6_000,
    unit: " rps",
    group: "Traffic",
    help: "Original requests entering the mesh, before retries. The dependency has an illustrative capacity of 12,000 rps.",
    format: "rps" as const,
  },
  {
    id: "retryAttempts",
    label: "Retries per request",
    min: 0,
    max: 4,
    step: 1,
    value: 3,
    unit: "",
    group: "Retry policy",
    help: "Maximum retries after the first attempt. Three retries means up to four attempts for one original request.",
    format: "count" as const,
  },
  {
    id: "retryBudget",
    label: "Retry budget",
    min: 0,
    max: 30,
    step: 1,
    value: 0,
    unit: "%",
    group: "Retry policy",
    help: "Cap on retries as a share of active requests in this model. Zero disables the budget; retries are limited only by the attempt count.",
    format: "percent" as const,
  },
  {
    id: "perTryTimeout",
    label: "Per-try timeout",
    min: 50,
    max: 1_000,
    step: 50,
    value: 250,
    unit: " ms",
    group: "Timeouts",
    help: "Deadline for one attempt. If it is below normal dependency latency, healthy requests are cut and retried.",
    format: "ms" as const,
  },
  {
    id: "faultDuration",
    label: "Injected 503 duration",
    min: 0,
    max: 20,
    step: 1,
    value: 0,
    unit: " s",
    group: "Incident",
    help: "Length of a dependency fault injected four seconds into the run. Zero runs without a fault.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  failure: number;
  offered: number;
  retryShare: number;
}

interface Computed extends State {
  requestRate: number;
  attempts: number;
  budgetPct: number;
  perTryTimeout: number;
  faultDuration: number;
  faultActive: boolean;
  faultFailure: number;
  timeoutShare: number;
  latency: number;
  retryRps: number;
  amplification: number;
  depUtil: number;
  errorRate: number;
  p99: number;
}

function readState(frame: SimFrame, base: number): State {
  return {
    failure: clamp(Number(frame.flags.failure ?? 0), 0, 1),
    offered: Math.max(base, Number(frame.flags.offered ?? base)),
    retryShare: Math.max(0, Number(frame.flags.retryShare ?? 0)),
  };
}

function compute(p: Params, t: number, dt: number, previous: State): Computed {
  const requestRate = Math.max(1_000, Math.round(num(p, "requestRate", 6_000)));
  const attempts = Math.max(0, Math.round(num(p, "retryAttempts", 3)));
  const budgetPct = clamp(num(p, "retryBudget", 0), 0, 100);
  const perTryTimeout = Math.max(10, num(p, "perTryTimeout", 250));
  const faultDuration = Math.max(0, num(p, "faultDuration", 0));
  const faultActive = faultDuration > 0 && t >= FAULT_START && t < FAULT_START + faultDuration;
  const faultTarget = faultActive
    ? 1
    : clamp((previous.offered / CAPACITY - 0.95) * 1.5, 0, 0.95);
  const faultFailure = clamp(previous.failure + (faultTarget - previous.failure) * clamp(dt / 1.5, 0, 1), 0, 1);

  const evaluate = (inputOffered: number) => {
    const util = inputOffered / CAPACITY;
    const nextLatency = BASE_LATENCY * (1 + 3 * util ** 4);
    const nextTimeout = clamp((nextLatency - perTryTimeout) / Math.max(1, nextLatency), 0, 0.95);
    const nextFailure = 1 - (1 - faultFailure) * (1 - nextTimeout);
    const expectedAttempts =
      nextFailure <= 1e-9
        ? 1
        : nextFailure >= 0.999
          ? attempts + 1
          : (1 - nextFailure ** (attempts + 1)) / (1 - nextFailure);
    const rawRetryShare = Math.max(0, expectedAttempts - 1);
    const nextRetryShare = budgetPct > 0 ? Math.min(rawRetryShare, budgetPct / 100) : rawRetryShare;
    return {
      nextOffered: requestRate * (1 + nextRetryShare),
      latency: nextLatency,
      timeoutShare: nextTimeout,
      failure: nextFailure,
      retryShare: nextRetryShare,
    };
  };

  let current = evaluate(requestRate * (1 + Math.min(previous.retryShare, budgetPct > 0 ? budgetPct / 100 : 0)));
  for (let index = 0; index < 12; index++) current = evaluate(current.nextOffered);
  const final = evaluate(current.nextOffered);
  const offered = final.nextOffered;
  const latency = final.latency;
  const timeoutShare = final.timeoutShare;
  const failure = final.failure;
  const retryShare = final.retryShare;
  const finalUtil = offered / CAPACITY;
  return {
    requestRate,
    attempts,
    budgetPct,
    perTryTimeout,
    faultDuration,
    faultActive,
    faultFailure,
    timeoutShare,
    latency,
    failure,
    offered,
    retryShare,
    retryRps: requestRate * retryShare,
    amplification: offered / requestRate,
    depUtil: finalUtil * 100,
    errorRate: failure ** (1 + retryShare) * 100,
    p99: latency * (1 + retryShare) + 25 * retryShare,
  };
}

function healthForErrors(value: number): SimState {
  if (value >= 5) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const requestHealth = healthForErrors(c.errorRate);
  const sidecarHealth: SimState = c.amplification >= 2.5 ? "crit" : c.amplification >= 1.5 ? "warn" : "ok";
  const dependencyHealth: SimState = c.faultActive
    ? "down"
    : c.depUtil >= 90 || c.errorRate >= 5
      ? "crit"
      : c.depUtil >= 75 || c.errorRate >= 1
        ? "warn"
        : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: requestHealth,
        throughput: c.requestRate,
        sublabel: `${c.requestRate.toLocaleString()} rps`,
        detail: "Clients send one logical request. They do not choose the number of attempts; the proxy retry policy does.",
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge proxy",
        kind: "mesh",
        health: requestHealth,
        throughput: c.requestRate,
        sublabel: "route and cluster",
        detail: "The edge proxy may have its own retry policy. Retries at several layers multiply, so the layer immediately above the failing dependency should own the retry.",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: requestHealth,
        throughput: c.requestRate,
        sublabel: "application",
        detail: "The application sends one call to its dependency through the sidecar. If the sidecar retries, the application does not see the extra attempts.",
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Envoy sidecar",
        kind: "mesh",
        health: sidecarHealth,
        throughput: c.offered,
        sublabel: `${c.amplification.toFixed(1)}× attempts · ${Math.round(c.retryRps).toLocaleString()} retry rps`,
        detail: `The retry policy allows ${c.attempts} retries. The budget caps retries at ${c.budgetPct}% of active requests; current amplification is ${c.amplification.toFixed(2)}×.`,
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Inventory service",
        kind: "worker",
        health: dependencyHealth,
        utilization: clamp(c.offered / CAPACITY),
        throughput: c.offered,
        sublabel: `${Math.round(c.depUtil)}% load · ${Math.round(c.failure * 100)}% attempt failure`,
        detail: `Illustrative capacity is 12,000 rps. Offered load is ${Math.round(c.offered).toLocaleString()} rps; per-try timeout is ${c.perTryTimeout}ms.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-edge", "clients", "edge", c.requestRate / MAX_RATE, "ok"),
      edge("edge-checkout", "edge", "checkout", c.requestRate / MAX_RATE, requestHealth),
      edge("checkout-sidecar", "checkout", "sidecar", c.requestRate / MAX_RATE, sidecarHealth),
      edge("sidecar-dependency", "sidecar", "dependency", c.offered / MAX_RATE, dependencyHealth),
    ],
    metrics: [
      metric("amplification", "Retry amplification", c.amplification, "×", 1.5, 2.5, "number"),
      metric("dep-util", "Dependency load", c.depUtil, "%", 75, 90, "percent"),
      metric("error-rate", "User error rate", c.errorRate, "%", 1, 5, "percent"),
      metric("p99", "End-to-end p99", c.p99, "ms", 500, 1_500, "ms"),
      metric("retry-rps", "Retry volume", c.retryRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      failure: c.failure,
      offered: c.offered,
      retryShare: c.retryShare,
    },
    summary: `${c.amplification.toFixed(1)}× attempts, ${Math.round(c.depUtil)}% dependency load, ${c.errorRate.toFixed(1)}% errors, p99 ${Math.round(c.p99)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "amplification",
    metricId: "amplification",
    warn: 1.5,
    crit: 2.5,
    title: "Retries are multiplying the offered load",
    cause:
      "Every failed attempt can produce another attempt. When the failure is shared by all callers, individually reasonable retries add up to a multiple of the original request rate.",
    fix:
      "Bound the retry policy before adding capacity: lower the attempt count, add a retry budget, or retry only at the layer immediately above the failing dependency.",
    checkFirst: [
      "Compare `upstream_rq_retry` with `upstream_rq_total` for the cluster.",
      "Check who changed max retries, retry-on conditions, or per-try timeout.",
      "Check whether the failure is shared by all callers or isolated to one host.",
    ],
  },
  {
    id: "dep-util",
    metricId: "dep-util",
    warn: 75,
    crit: 90,
    title: "Dependency load is above its usable capacity",
    cause:
      "Offered load is at or above the dependency's safe range. It may be original traffic, retry amplification, or both; compare retry volume with the client rate before attributing it to retries.",
    fix:
      "Cut offered load with a retry budget or fewer attempts, then shed non-critical traffic. Capacity added during a retry storm helps only if the dependency is not also queueing on a shared resource.",
    checkFirst: [
      "Compare offered load with measured capacity, not provisioned peak.",
      "Check whether one caller or every caller is retrying.",
      "Check connection pool and pending request saturation.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "User-visible errors are above the SLO",
    cause:
      "Retries are exhausted, the per-try timeout is cutting healthy attempts, or the dependency is saturated by amplified load. Retry volume can keep the dependency down and extend the errors.",
    fix:
      "Bound retries and align the per-try timeout with dependency latency. Do not raise the retry count to improve the error rate during a shared dependency failure.",
    checkFirst: [
      "Separate final response codes from attempts that triggered a retry.",
      "Check `upstream_rq_retry_success` and `upstream_rq_retry_limit_exceeded`.",
      "Check whether a short per-try timeout is creating timeouts on healthy calls.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "End-to-end p99 breached the latency budget",
    cause:
      "The user waits through multiple attempts and backoff. The route timeout includes all retries, so a long per-try timeout or a high attempt count consumes the entire request deadline.",
    fix:
      "Reduce offered load first. Keep the per-try timeout above normal dependency latency but below the route timeout, and keep the route timeout as the outer bound.",
    checkFirst: [
      "Compare proxy upstream latency with dependency server latency.",
      "Check per-try timeout, route timeout, and retry backoff.",
      "Check whether retries are sent to the same overloaded host.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const retryModel: SimModel = {
  id: "mesh-retries",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const base = num(p, "requestRate", 6_000);
    const state: State = { failure: 0, offered: base, retryShare: 0 };
    return buildFrame(compute(p, 0, 0, state), seed);
  },
  step: (frame, p, dt, rng) => {
    const base = num(p, "requestRate", 6_000);
    const previous = readState(frame, base);
    const computed = compute(p, frame.t, dt, previous);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jittered = { ...computed, p99: Math.max(1, computed.p99 * (1 + rng.between(-0.02, 0.02))) };
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: jittered.p99 } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (computed.faultActive && frame.flags.faultSeen !== 1) {
      pushEvent(next, {
        id: "retry-fault",
        at: frame.t,
        severity: "warn",
        title: "503 fault injected",
        detail: `The dependency returns 503 for ${computed.faultDuration}s. The proxy retry policy starts adding attempts.`,
        nodeId: "dependency",
        metricId: "error-rate",
      });
      next.flags.faultSeen = 1;
    }
    if (computed.amplification >= 2.5 && frame.flags.amplificationSeen !== 1) {
      pushEvent(next, {
        id: "retry-amplification",
        at: frame.t,
        severity: "crit",
        title: "Retries multiply offered load",
        detail: `Amplification is ${computed.amplification.toFixed(1)}×: ${Math.round(computed.offered).toLocaleString()} attempts against ${computed.requestRate.toLocaleString()} original requests.`,
        nodeId: "sidecar",
        metricId: "amplification",
      });
      next.flags.amplificationSeen = 1;
    }
    if (
      computed.faultDuration > 0 &&
      !computed.faultActive &&
      frame.t > FAULT_START + computed.faultDuration + 2 &&
      computed.depUtil > 90 &&
      frame.flags.noRecoverySeen !== 1
    ) {
      pushEvent(next, {
        id: "retry-prevents-recovery",
        at: frame.t,
        severity: "crit",
        title: "Retries keep the dependency saturated",
        detail: `The injected fault ended, but offered load is still ${Math.round(computed.offered).toLocaleString()} rps against ${CAPACITY.toLocaleString()} rps of capacity. Retry volume is sustaining the failure.`,
        nodeId: "dependency",
        metricId: "dep-util",
      });
      next.flags.noRecoverySeen = 1;
    }
    if (
      computed.faultDuration > 0 &&
      !computed.faultActive &&
      frame.t > FAULT_START + computed.faultDuration &&
      computed.errorRate < 1 &&
      frame.flags.recoveredSeen !== 1
    ) {
      pushEvent(next, {
        id: "retry-recovered",
        at: frame.t,
        severity: "info",
        title: "Dependency recovered",
        detail: "Offered load is below capacity, the failure rate decayed, and errors are below 1%.",
        nodeId: "dependency",
      });
      next.flags.recoveredSeen = 1;
    }
    next.summary = `${computed.amplification.toFixed(1)}× attempts, ${Math.round(computed.depUtil)}% dependency load, ${computed.errorRate.toFixed(1)}% errors, p99 ${Math.round(jittered.p99)}ms.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const base = num(p, "requestRate", 6_000);
    const c = compute(p, frame.t, 0, readState(frame, base));
    const items: string[] = [];
    items.push(`Offered load is ${Math.round(c.offered).toLocaleString()} rps from ${c.requestRate.toLocaleString()} original requests, or ${c.amplification.toFixed(2)}× amplification.`);
    items.push(`The dependency sees ${Math.round(c.depUtil)}% of its illustrative 12,000 rps capacity. Per-try timeout is ${c.perTryTimeout}ms; the modeled attempt failure rate is ${Math.round(c.failure * 100)}%.`);
    if (c.budgetPct === 0 && c.retryShare > 0) items.push("No retry budget is configured, so the attempt count is the only bound on retry volume.");
    if (c.budgetPct > 0) items.push(`The retry budget caps retries at ${c.budgetPct}% of active requests, so amplification cannot exceed ${(1 + c.budgetPct / 100).toFixed(2)}×.`);
    if (c.perTryTimeout < c.latency) items.push("The per-try timeout is below modeled dependency latency. Healthy slow calls are being cut and retried, which adds load even without a dependency fault.");
    items.push("Envoy uses fully jittered exponential backoff with a 25ms base interval and a 250ms maximum by default. Jitter spreads retry waves but does not cap their number.");
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
    description: "6,000 rps, two retries, a 10% budget, and a 300ms per-try timeout. No failures, so retries never fire.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, retryAttempts: 2, retryBudget: 10, perTryTimeout: 300, faultDuration: 0 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "9,200 rps against 12,000 rps of capacity. The dependency is near its warning line but no retries fire.",
    tone: "warn",
    params: defaults({ requestRate: 9_200, retryAttempts: 2, retryBudget: 10, perTryTimeout: 300, faultDuration: 0 }),
  },
  {
    id: "failure",
    label: "No budget",
    description: "An 8s 503 fault with three retries and no budget. Four attempts per request keep the dependency saturated after the fault ends.",
    tone: "crit",
    params: defaults({ requestRate: 6_000, retryAttempts: 3, retryBudget: 0, perTryTimeout: 250, faultDuration: 8 }),
  },
  {
    id: "recovery",
    label: "Budget",
    description: "Same fault with two retries and a 10% budget. Offered load stays below capacity, so the dependency recovers after the fault.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, retryAttempts: 2, retryBudget: 10, perTryTimeout: 250, faultDuration: 8 }),
  },
  {
    id: "tight-timeout",
    label: "Tight timeout",
    description: "A 80ms per-try timeout against normal latency above 140ms. Healthy requests time out and retry, creating load with no dependency fault.",
    tone: "crit",
    params: defaults({ requestRate: 6_000, retryAttempts: 3, retryBudget: 0, perTryTimeout: 80, faultDuration: 0 }),
  },
];

const experiment: Experiment = {
  id: "retry-timeout-amplification",
  title: "Predict what a tight per-try timeout does",
  simId: "retry",
  question:
    "A dependency's p99 is about 300ms. You set the proxy per-try timeout to 100ms to cut latency. What happens to load and success?",
  prediction: {
    options: [
      { id: "more", label: "Healthy slow calls time out, get retried, and offered load rises; success can fall" },
      { id: "less", label: "Timeouts return early, so offered load falls and success improves" },
      { id: "none", label: "The per-try timeout only applies to attempts that already failed" },
      { id: "budget", label: "The retry budget automatically prevents any extra load" },
    ],
    correctOptionId: "more",
    explanation:
      "A per-try timeout is a deadline for one attempt, not a latency target. If it is below normal dependency latency, requests that would have succeeded are cut and retried. Those retries add load, raise dependency latency, and create more timeouts. A retry budget can bound the extra load, but it is not automatic unless one is configured.",
  },
  setup: defaults({ requestRate: 6_000, retryAttempts: 3, retryBudget: 0, perTryTimeout: 80, faultDuration: 0 }),
  runFor: 30,
  observe: [
    "Retry amplification rises above 3× even though no dependency fault was injected.",
    "Dependency load crosses 150% of its illustrative capacity.",
    "User errors rise as attempts time out and the dependency queues.",
    "End-to-end p99 grows into seconds as the user waits through attempts and backoff.",
    "The event feed records the amplification crossing, not a dependency fault.",
  ],
  explain:
    "The client is not failing because the dependency is down; it is failing because the proxy keeps cutting healthy calls. Each timeout produces another attempt, and each attempt adds queueing delay, which produces more timeouts. The per-try timeout must be above the dependency's normal latency, while the route timeout remains the outer bound for all attempts. A retry budget is a separate control that caps the resulting retry volume.",
  fix: defaults({ requestRate: 6_000, retryAttempts: 2, retryBudget: 10, perTryTimeout: 400, faultDuration: 0 }),
  debrief:
    "With a 400ms per-try timeout and two retries under a 10% budget, normal calls complete on the first attempt and retries stay bounded. The dependency is not asked to absorb attempts created by the proxy's own deadline. Check the per-try timeout against measured latency before changing retry counts, and keep the route timeout as the user-facing bound.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Envoy retry is a new attempt for a request that failed according to a retry policy. Retries are off unless a route or virtual host configures them. Once a policy exists, the retry conditions decide which failures are retryable: 5xx, gateway errors, resets, connect failures, refused streams, retriable 4xx, or specific status codes and headers. The attempt count is bounded by the policy and can be overridden by request headers. Retried attempts are real upstream requests; they consume connections, queue space, and dependency capacity.",
  },
  {
    type: "p",
    text: "Three controls shape a safe policy. The retry condition decides what is worth retrying. The per-try timeout decides how long one attempt may take. The retry budget decides how much retry concurrency the cluster will tolerate. Envoy's retry budget lives in the cluster circuit breaker configuration and is expressed as a percentage of active requests with a minimum retry concurrency. The route timeout is an outer bound that includes all attempts and the backoff between them, which prevents an unbounded retry and timeout explosion.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The retry policy sits on the route or virtual host and is enforced by the router filter in the proxy. The correct place to retry is the layer immediately above the failing dependency. If the edge proxy, the service, and the sidecar all retry, their attempts multiply: two retries at two layers can produce nine attempts at the bottom. The application should see one logical call; the proxy owns the extra attempts and the user-facing deadline.",
  },
  {
    type: "table",
    headers: ["Control", "What it bounds", "If it is wrong"],
    rows: [
      ["Retry condition", "Which failures are retried", "Retries non-idempotent writes or hopeless errors"],
      ["Attempt count", "Attempts for one request", "Amplification multiplies offered load"],
      ["Per-try timeout", "Time for one attempt", "Cuts healthy calls or lets one attempt consume the route timeout"],
      ["Retry budget", "Concurrent retry volume", "Retries crowd out fresh requests and sustain saturation"],
      ["Route timeout", "Total time including retries", "User waits through every attempt with no outer bound"],
    ],
  },
  {
    type: "p",
    text: "A retry budget is not a success guarantee. It converts some retryable failures into user-visible errors in exchange for protecting the dependency from a longer outage. That trade is usually right during a shared failure and wrong for an isolated host failure, where a small retry is likely to land on a healthy endpoint. Scope the policy by dependency criticality rather than applying one retry rule to every route.",
  },
  {
    type: "compare",
    leftTitle: "Isolated failure",
    rightTitle: "Shared dependency failure",
    rows: [
      { label: "Blast radius", left: "One host or connection", right: "Every caller and proxy" },
      { label: "Retry outcome", left: "Often lands on a healthy host", right: "Lands on the same saturated dependency" },
      { label: "Useful control", left: "Small attempt count with jitter", right: "Retry budget, fewer attempts, load shedding" },
      { label: "Main risk", left: "Duplicate side effects", right: "Amplification prevents recovery" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A flow from clients to edge proxy, checkout, sidecar, and dependency.",
      "Retry amplification, dependency load, user error rate, p99, and retry volume.",
      "A failure where an 8s 503 fault becomes a sustained outage because retries keep the dependency saturated.",
      "A recovery where a 10% budget holds offered load below capacity after the same fault.",
      "A tight-timeout case where retries create load with no dependency fault at all.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No budget. Watch amplification reach 4× at the fault and stay high after it ends. Compare Budget and Recovery. Then apply Tight timeout to see retries caused by the proxy's own deadline rather than by the dependency.",
  },
  { type: "sim", simId: "retry" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The dependency failed for eight seconds. With three retries and no budget, each original request could become four attempts. Six thousand requests per second became up to 24,000 attempts against an illustrative 12,000 rps capacity. The dependency stayed saturated after the injected fault ended, so it kept failing, which kept the retry volume high. The fault was short; the retry policy made the outage long.",
  },
  {
    type: "p",
    text: "A 10% retry budget capped retries at 600 rps, so offered load stayed near 6,600 and the dependency could drain after the fault. The tight-timeout preset showed the other path to the same failure: an 80ms per-try deadline cut healthy calls whose latency was above 140ms, and the resulting retries added load without any injected fault.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`upstream_rq_retry`, `upstream_rq_retry_success`, `upstream_rq_retry_limit_exceeded`, and `upstream_rq_retry_overflow` separate attempts from final responses.",
      "`upstream_rq_timeout` rises when the per-try timeout is too tight for normal dependency latency.",
      "`x-envoy-max-retries`, `x-envoy-retry-on`, and `x-envoy-upstream-rq-per-try-timeout-ms` can override the route policy; check them when behavior differs by caller.",
      "The route timeout includes all retries, so a long p99 with several attempts can consume the entire user deadline.",
      "Dependency request rate, concurrency, and queue depth show whether the extra load is actually arriving at the dependency.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare retry rate with the original request rate, then compare dependency load with capacity. Check the retry condition, attempt count, per-try timeout, and route timeout in that order. Do not raise the attempt count to improve success during a shared failure.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the amplification: lower the attempt count, add a retry budget, or remove retries from callers that cannot see dependency health.",
      "Set the per-try timeout above normal dependency latency and below the route timeout.",
      "Keep the route timeout as the outer bound for all attempts and backoff.",
      "Retry only conditions that are safe and likely to succeed on another attempt; restrict writes to idempotent operations or idempotency keys.",
      "Retry at one layer, immediately above the failing dependency.",
      "Restore retries gradually after the dependency recovers, watching retry overflow and success.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A retry budget protects the dependency but turns some transient failures into user-visible errors.",
      "A tight per-try timeout improves tail latency only when attempts succeed; below normal latency it manufactures retries.",
      "More attempts improve success for isolated failures but amplify shared ones.",
      "Jitter prevents synchronized retry waves but cannot bound total volume.",
      "Retrying writes requires idempotency; a timeout does not prove the server did nothing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-policy",
    question:
      "Design an Envoy retry policy for a checkout dependency that occasionally returns 503. What do you set, and what do you refuse to set?",
    difficulty: 3,
    hints: [
      "Start from the failure condition.",
      "Bound volume and time separately.",
    ],
    answer:
      "I would retry only the conditions that indicate a transient failure, typically 503 and gateway errors, and only for idempotent operations. I would set a small attempt count, a per-try timeout above the dependency's normal latency, and a route timeout that bounds the total including retries. I would add a retry budget at the cluster to cap retry concurrency, and I would retry at the sidecar immediately above the dependency rather than at every layer. I would refuse to retry non-idempotent writes without an idempotency key, and I would refuse to raise the retry count to hide a dependency that is saturated.",
    followUps: [
      "What retry conditions would you exclude?",
      "How would you choose the per-try timeout?",
      "What does the budget cost users?",
    ],
    redFlags: [
      "Retries every 5xx on every method.",
      "Sets attempts without a budget.",
      "Retries at multiple layers.",
    ],
    rubric: [
      "Chooses conditions deliberately.",
      "Bounds attempts and time.",
      "Adds a budget.",
      "Protects idempotency.",
    ],
  },
  {
    id: "timeout-math",
    question:
      "A route timeout is 2 seconds and the per-try timeout is 1.5 seconds with two retries. What can the user experience, and how do you fix it?",
    difficulty: 3,
    hints: [
      "The route timeout includes all attempts.",
      "Backoff also consumes the budget.",
    ],
    answer:
      "The route timeout is the outer bound, so the user can wait up to two seconds and then receive a 504. The first attempt may consume 1.5 seconds, leaving only 0.5 seconds for the retry and its backoff, which is likely to fail without a fair chance. I would lower the per-try timeout so several attempts fit inside the route timeout, for example a few hundred milliseconds per try, and make sure the route timeout still covers the expected total. The per-try timeout must also be above normal dependency latency or it will create retries for healthy calls.",
    followUps: [
      "What happens if the per-try timeout exceeds the route timeout?",
      "How does backoff consume the budget?",
      "Would you rather raise the route timeout or lower the per-try timeout?",
    ],
    redFlags: [
      "Treats the two timeouts as independent.",
      "Raises attempts without changing timeouts.",
      "Ignores backoff.",
    ],
    rubric: [
      "Explains the outer bound.",
      "Computes the remaining budget.",
      "Aligns per-try and route timeouts.",
      "Mentions backoff.",
    ],
  },
  {
    id: "budget-vs-attempts",
    question:
      "Why add a retry budget if you already set a maximum of three retries? What does each control actually bound?",
    difficulty: 3,
    hints: [
      "One bounds a single request.",
      "The other bounds the fleet.",
    ],
    answer:
      "The attempt count bounds one request: at most four attempts for a single logical call. The budget bounds the aggregate retry concurrency across the cluster, as a percentage of active requests. With a total failure, every request can still use its three retries, so the attempt count alone allows four times the load. The budget caps that fleet-wide amplification even when each request is behaving as configured. The budget's cost is that some retries are dropped and surface as errors sooner, which protects the dependency from a longer outage.",
    followUps: [
      "How would you size the budget?",
      "What happens when the budget is exceeded?",
      "Does the budget improve user success?",
    ],
    redFlags: [
      "Thinks the attempt count caps fleet load.",
      "Sets a budget without monitoring overflow.",
      "Expects the budget to increase success.",
    ],
    rubric: [
      "Separates per-request and fleet bounds.",
      "Explains amplification.",
      "Names the overflow tradeoff.",
      "Sizes the budget defensibly.",
    ],
  },
  {
    id: "retry-conditions",
    question:
      "Which responses should a mesh retry, and which should it not? Give examples where a retry makes an outage worse.",
    difficulty: 4,
    hints: [
      "Retry only what can succeed on another attempt.",
      "Consider writes, rate limits, and shared failures.",
    ],
    answer:
      "I would retry transient conditions such as 503, gateway errors, connection resets, and refused streams, and only for operations that are safe to repeat. I would not retry a 400, a 401, a 404, or a business-rule 409 without understanding it, because another attempt will fail the same way or duplicate a side effect. I would be careful with 429: retrying without respecting the rate-limit signal adds load to an already throttled dependency. During a shared dependency failure, every retry adds load to the same failing system, so the budget and attempt count matter more than the condition list. For writes, an idempotency key or a safe-method restriction is required.",
    followUps: [
      "How would you handle a 409 from optimistic locking?",
      "What does `Retry-After` change?",
      "Would you retry a POST with an idempotency key?",
    ],
    redFlags: [
      "Retries every non-2xx.",
      "Ignores write semantics.",
      "Retries 429 immediately.",
    ],
    rubric: [
      "Selects transient conditions.",
      "Excludes hopeless errors.",
      "Handles writes safely.",
      "Considers shared failure.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every retry policy has an owner, a retry-on list, and a maximum attempt count.",
      "Per-try timeouts are above normal dependency latency and below the route timeout.",
      "A retry budget is configured per dependency, not only per route.",
      "Retried writes are idempotent or carry an idempotency key.",
      "Dashboards separate retry attempts from final responses and show overflow.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare retry rate with original request rate before changing capacity.",
      "Check whether the failure is shared by all callers or isolated to a host.",
      "Cut retry volume first: budget, attempt count, or condition list.",
      "Check whether a tight per-try timeout is creating the retries.",
      "Protect the dependency with load shedding or a degraded response.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore retries gradually and verify amplification stays bounded.",
      "Remove retries from layers that cannot see dependency health.",
      "Add a load test that injects a shared 503 failure.",
      "Review whether the budget and timeout match the dependency's measured latency.",
      "Document the user-visible error budget spent to protect the dependency.",
    ],
  },
];

const references = [
  {
    title: "Envoy router filter: retries",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Retry conditions, max retries, jittered backoff, per-try timeout, route timeout, and retry statistics.",
  },
  {
    title: "Envoy circuit breaking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Retry budgets, maximum active retries, and retry overflow counters.",
  },
  {
    title: "Envoy cluster statistics",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Upstream retry, timeout, pending, and overflow counters used to diagnose amplification.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    retry: {
      model: retryModel,
      presets,
      instructions:
        "Start Healthy, apply No budget, then compare Budget and Recovery. Apply Tight timeout to see retries created by a per-try deadline rather than by a dependency fault.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Capacity, latency, and failure ramps are teaching values, not Envoy defaults or provider guarantees. Retry budget is modeled as a cap on the retry share.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-retry-backoff-jitter",
    "mesh-retry-storm",
    "mesh-timeouts",
    "mesh-circuit-breaking",
    "mesh-outlier-detection",
  ],
};
