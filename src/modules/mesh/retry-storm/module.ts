import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAPACITY = 12_000;
const FAULT_START = 5;
const RECOVERY_HOLD = 2;
const QUEUE_SECONDS = 0.35;
const MAX_QUEUE = 20_000;

const params = [
  {
    id: "clientRps",
    label: "Base request rate",
    min: 1_000,
    max: 20_000,
    step: 500,
    value: 6_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests entering the mesh before retries. The dependency's teaching capacity is 12,000 rps.",
    format: "rps" as const,
  },
  {
    id: "retryAttempts",
    label: "Retries per request",
    min: 0,
    max: 5,
    step: 1,
    value: 3,
    unit: "",
    group: "Retry policy",
    help: "Maximum retries after the first attempt. Two retries can offer three attempts for every original request.",
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
    help: "Share of base requests that may be retries in this model. Zero means no budget; retries are limited only by the attempt count.",
    format: "percent" as const,
  },
  {
    id: "breakerThreshold",
    label: "Breaker threshold",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Protection",
    help: "Failure rate that blocks retries. One hundred percent disables the breaker in this model.",
    format: "percent" as const,
  },
  {
    id: "outageSeconds",
    label: "Injected fault duration",
    min: 0,
    max: 30,
    step: 1,
    value: 5,
    unit: " s",
    group: "Incident",
    help: "Length of the dependency fault injected five seconds into the run. Zero runs without a fault.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Mode = "healthy" | "fault" | "overloaded" | "recovering";

interface SimStateInternal {
  mode: Mode;
  breakerOpen: boolean;
  queue: number;
  hold: number;
  offered: number;
}

interface Computed {
  baseRps: number;
  attempts: number;
  budgetPct: number;
  breakerThreshold: number;
  outageSeconds: number;
  retryShare: number;
  retryRps: number;
  offered: number;
  amplification: number;
  depUtil: number;
  p99: number;
  errorRate: number;
  failureRate: number;
  mode: Mode;
  breakerOpen: boolean;
}

function readState(frame: SimFrame, baseRps: number): SimStateInternal {
  const mode = String(frame.flags.mode ?? "healthy") as Mode;
  return {
    mode: mode === "fault" || mode === "overloaded" || mode === "recovering" ? mode : "healthy",
    breakerOpen: Number(frame.flags.breaker ?? 0) === 1,
    queue: Math.max(0, Number(frame.flags.queue ?? 0)),
    hold: Math.max(0, Number(frame.flags.hold ?? 0)),
    offered: Math.max(0, Number(frame.flags.offered ?? baseRps)),
  };
}

function advance(
  p: Params,
  previous: SimStateInternal,
  t: number,
  dt: number,
): { computed: Computed; state: SimStateInternal } {
  const baseRps = Math.max(1, Math.round(num(p, "clientRps", 6_000)));
  const attempts = Math.max(0, Math.round(num(p, "retryAttempts", 3)));
  const budgetPct = clamp(num(p, "retryBudget", 0), 0, 100);
  const breakerThreshold = clamp(num(p, "breakerThreshold", 100), 0, 100);
  const outageSeconds = Math.max(0, num(p, "outageSeconds", 5));
  const faultActive = outageSeconds > 0 && t >= FAULT_START && t < FAULT_START + outageSeconds;

  let failureRate: number;
  if (faultActive) {
    failureRate = 1;
  } else if (previous.mode === "overloaded") {
    failureRate = 0.9;
  } else if (previous.mode === "fault") {
    failureRate = previous.offered > CAPACITY * 0.9 ? 0.9 : 0.2;
  } else if (previous.mode === "recovering") {
    failureRate = 0.25 * Math.max(0, 1 - previous.hold / RECOVERY_HOLD);
  } else {
    failureRate = 0.001;
  }

  let breakerOpen = previous.breakerOpen;
  const threshold = breakerThreshold / 100;
  if (threshold >= 1) {
    breakerOpen = false;
  } else if (!breakerOpen && failureRate >= threshold) {
    breakerOpen = true;
  } else if (breakerOpen && failureRate <= threshold * 0.5) {
    breakerOpen = false;
  }

  const budgetCap = budgetPct > 0 ? budgetPct / 100 : Number.POSITIVE_INFINITY;
  const retryShare = breakerOpen ? 0 : Math.min(failureRate * attempts, budgetCap);
  const offered = baseRps * (1 + retryShare);

  let mode: Mode;
  let hold = previous.hold;
  if (faultActive) {
    mode = "fault";
    hold = 0;
  } else if (offered > CAPACITY * 0.9) {
    mode = "overloaded";
    hold = 0;
  } else if (previous.mode === "fault" || previous.mode === "overloaded" || previous.mode === "recovering") {
    hold += dt;
    if (hold >= RECOVERY_HOLD) {
      mode = "healthy";
      hold = 0;
    } else {
      mode = "recovering";
    }
  } else {
    mode = "healthy";
    hold = 0;
  }

  const retryRps = baseRps * retryShare;
  const targetQueue = retryRps * QUEUE_SECONDS;
  const queue = clamp(previous.queue + (targetQueue - previous.queue) * Math.min(1, dt / 1.2), 0, MAX_QUEUE);
  const ratio = offered / CAPACITY;
  const effectiveAttempts = breakerOpen ? 0 : attempts;
  const errorRate = failureRate >= 0.999 ? 100 : Math.min(100, failureRate ** (effectiveAttempts + 1) * 100);
  const p99 = Math.min(5_000, 40 + 900 * ratio ** 3);
  return {
    computed: {
      baseRps,
      attempts,
      budgetPct,
      breakerThreshold,
      outageSeconds,
      retryShare,
      retryRps,
      offered,
      amplification: offered / baseRps,
      depUtil: Math.min(1.4, ratio) * 100,
      p99,
      errorRate,
      failureRate,
      mode,
      breakerOpen,
    },
    state: { mode, breakerOpen, queue, hold, offered },
  };
}

function worst(...health: SimState[]): SimState {
  if (health.includes("crit")) return "crit";
  if (health.includes("warn")) return "warn";
  return "ok";
}

function healthForUtil(value: number): SimState {
  if (value >= 90) return "crit";
  if (value >= 75) return "warn";
  return "ok";
}

function healthForErrors(value: number): SimState {
  if (value >= 5) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function modeLabel(mode: Mode): string {
  if (mode === "fault") return "unavailable";
  if (mode === "overloaded") return "overloaded by retries";
  if (mode === "recovering") return "recovering";
  return "healthy";
}

function buildFrame(c: Computed, state: SimStateInternal, seed: number): SimFrame {
  const depHealth = c.mode === "fault" ? "down" : worst(healthForUtil(c.depUtil), healthForErrors(c.errorRate));
  const sidecarHealth = c.amplification >= 2.5 ? "crit" : c.amplification >= 1.5 ? "warn" : "ok";
  const queueHealth = state.queue >= 5_000 ? "crit" : state.queue >= 2_000 ? "warn" : "ok";
  const requestHealth = healthForErrors(c.errorRate);
  const retryLabel = c.breakerOpen ? "breaker open" : `${c.amplification.toFixed(1)}× attempts`;
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: "ok",
        utilization: clamp(c.baseRps / 20_000),
        throughput: c.baseRps,
        sublabel: `${c.baseRps.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge Envoy",
        kind: "mesh",
        health: requestHealth,
        utilization: clamp(c.baseRps / 25_000),
        throughput: c.baseRps,
        sublabel: "retry policy",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: requestHealth,
        utilization: clamp(c.baseRps / CAPACITY),
        throughput: c.baseRps,
        sublabel: `${c.baseRps.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Envoy sidecar",
        kind: "mesh",
        health: sidecarHealth,
        utilization: clamp(c.offered / 30_000),
        throughput: c.offered,
        sublabel: retryLabel,
        detail: `${Math.round(c.retryRps).toLocaleString()} retry rps. Retries wait in a pending queue while the dependency is slow or out of connections.`,
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Inventory service",
        kind: "worker",
        health: depHealth,
        utilization: clamp(c.offered / CAPACITY),
        throughput: c.offered,
        sublabel: `${modeLabel(c.mode)} · ${Math.round(c.depUtil)}% load`,
        detail: `Illustrative capacity is 12,000 rps. Failure rate ${(c.failureRate * 100).toFixed(0)}%; offered load ${Math.round(c.offered).toLocaleString()} rps.`,
        meta: { view: "flow" },
      },
      {
        id: "retry-backlog",
        label: "Retry backlog",
        kind: "queue",
        health: queueHealth,
        throughput: c.retryRps,
        sublabel: `${Math.round(state.queue).toLocaleString()} pending`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("clients-edge", "clients", "edge", c.baseRps / 25_000, "ok"),
      edge("edge-checkout", "edge", "checkout", c.baseRps / 25_000, requestHealth),
      edge("checkout-sidecar", "checkout", "sidecar", c.offered / 30_000, sidecarHealth),
      edge("sidecar-dependency", "sidecar", "dependency", c.offered / 30_000, depHealth),
    ],
    metrics: [
      metric("amplification", "Retry amplification", c.amplification, "×", 1.5, 2.5, "number"),
      metric("dep-util", "Dependency load", c.depUtil, "%", 75, 90, "percent"),
      metric("error-rate", "User error rate", c.errorRate, "%", 1, 5, "percent"),
      metric("p99", "End-to-end p99", c.p99, "ms", 500, 1_500, "ms"),
      metric("queueDepth", "Pending retries", state.queue, " req", 2_000, 5_000, "count"),
      metric("retry-rps", "Retry volume", c.retryRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      mode: state.mode,
      breaker: state.breakerOpen ? 1 : 0,
      queue: state.queue,
      hold: state.hold,
      offered: state.offered,
    },
    summary: `${c.amplification.toFixed(1)}× attempts, ${Math.round(c.depUtil)}% dependency load, ${c.errorRate.toFixed(1)}% errors, p99 ${Math.round(c.p99)}ms.`,
  };
}

function insightsFor(state: SimStateInternal, c: Computed): string[] {
  const items: string[] = [];
  if (c.mode === "fault") {
    items.push(`The dependency is unavailable. ${Math.round(c.retryRps).toLocaleString()} retry rps raise offered load to ${Math.round(c.offered).toLocaleString()} rps against ${CAPACITY.toLocaleString()} of teaching capacity.`);
  } else if (c.mode === "overloaded") {
    items.push(`The injected fault has ended, but ${Math.round(c.offered).toLocaleString()} rps of offered load keeps the dependency saturated and failing.`);
  } else if (c.mode === "recovering") {
    items.push(`Offered load is below the dependency's capacity. The failure rate is decaying and the dependency is recovering.`);
  } else {
    items.push(`Offered load is ${Math.round(c.offered).toLocaleString()} rps with ${c.amplification.toFixed(2)}× amplification.`);
  }
  if (c.budgetPct > 0) items.push(`The retry budget caps retries at ${c.budgetPct}% of base requests, so amplification cannot exceed ${(1 + c.budgetPct / 100).toFixed(2)}×.`);
  if (c.breakerThreshold < 100) items.push(`The breaker blocks retries above a ${c.breakerThreshold}% failure rate; while open, users may see errors sooner but the dependency gets relief.`);
  if (c.retryShare > 0) items.push(`Each failing request can produce ${c.attempts} retries, so a 100% failure rate without a budget can offer ${(1 + c.attempts).toFixed(1)}× the original traffic.`);
  items.push(`Envoy uses fully jittered exponential backoff by default, with a 25ms base and a 250ms cap. Jitter spreads retry waves within milliseconds; it does not cap total attempts.`);
  items.push(`Pending retries: ${Math.round(state.queue).toLocaleString()}. Envoy increments upstream_rq_retry_overflow when the retry budget or retry circuit breaker rejects a retry.`);
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "amplification",
    metricId: "amplification",
    warn: 1.5,
    crit: 2.5,
    title: "Retry amplification crossed the critical threshold",
    cause: "Every proxy retries failed calls independently. Individually reasonable retries add up to a multiple of the original request rate when the failure is shared by the whole fleet.",
    fix: "Stop the amplification before tuning the dependency: add a retry budget, cap retries, or open a breaker. Then reduce attempts and retry only at the layer immediately above the failing dependency.",
    checkFirst: [
      "Compare upstream_rq_retry with upstream_rq_total for the affected cluster.",
      "Check who changed the retry policy, max retries, or retry-on conditions.",
      "Check whether the dependency failure is shared by all callers or isolated to one host.",
    ],
  },
  {
    id: "dep-util",
    metricId: "dep-util",
    warn: 75,
    crit: 90,
    title: "Dependency load is above its usable capacity",
    cause: "Offered load is at or above the dependency's safe range. It may be base traffic, retry amplification, or both; compare retry-rps with client-rps before attributing it to retries.",
    fix: "Cut offered load with a retry budget or breaker and shed non-critical traffic. Adding capacity during the storm helps only if the dependency is not also queueing on a shared resource.",
    checkFirst: [
      "Compare offered load with the dependency's measured capacity, not its provisioned peak.",
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
    cause: "Retries are exhausted, or the breaker is failing fast. Retry volume also keeps the dependency down, so the errors last far longer than the original fault.",
    fix: "Bound retries, then protect the remaining capacity with load shedding or a degraded response. Do not raise retry counts to improve the error rate during a shared dependency failure.",
    checkFirst: [
      "Separate final response codes from attempts that triggered a retry.",
      "Check upstream_rq_retry_success and upstream_rq_retry_limit_exceeded.",
      "Check whether the breaker is open and returning local errors.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "End-to-end p99 breached the latency budget",
    cause: "The dependency is queueing amplified load. Per-try timeouts multiply the time spent on failed attempts, and the user waits through the retry budget.",
    fix: "Reduce offered load first. Keep a per-try timeout below the route timeout; the route timeout includes all retries, so it bounds total user wait.",
    checkFirst: [
      "Compare proxy upstream latency with dependency server latency.",
      "Check per-try timeout, route timeout, and retry backoff.",
      "Check whether retries are sent to the same overloaded host.",
    ],
  },
  {
    id: "queueDepth",
    metricId: "queueDepth",
    warn: 2_000,
    crit: 5_000,
    title: "Pending retries are consuming connection capacity",
    cause: "Retries wait for a connection or a backoff slot while the dependency is slow. The pending queue grows with retry volume and can starve fresh requests.",
    fix: "Cap retries and pending requests. The retry budget and circuit breaker exist to drop retries before this queue becomes the bottleneck.",
    checkFirst: [
      "Check upstream_rq_pending_overflow and upstream_rq_retry_overflow.",
      "Check connection pool limits and max concurrent streams.",
      "Check whether retries are competing with new requests for the same pool.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const retryStormModel: SimModel = {
  id: "mesh-retry-storm",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const previous: SimStateInternal = { mode: "healthy", breakerOpen: false, queue: 0, hold: 0, offered: num(p, "clientRps", 6_000) };
    const { computed, state } = advance(p, previous, 0, 0);
    return buildFrame(computed, state, seed);
  },
  step: (frame, p, dt, rng) => {
    const baseRps = num(p, "clientRps", 6_000);
    const previous = readState(frame, baseRps);
    const { computed, state } = advance(p, previous, frame.t, dt);
    const jittered = { ...computed, p99: Math.max(1, computed.p99 * (1 + rng.between(-0.02, 0.02))) };
    const next = buildFrame(jittered, state, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) {
      recordSeries(next, `load.${node.id}`, (node.utilization ?? 0) * 100);
    }
    if (computed.mode === "fault" && frame.flags.faultSeen !== 1) {
      pushEvent(next, {
        id: "dependency-fault",
        at: frame.t,
        severity: "warn",
        title: "Dependency fault injected",
        detail: `The dependency is failing for ${computed.outageSeconds}s. Proxies begin retrying according to the route policy.`,
        nodeId: "dependency",
        metricId: "error-rate",
      });
      next.flags.faultSeen = 1;
    }
    if (!previous.breakerOpen && state.breakerOpen && frame.flags.breakerSeen !== 1) {
      pushEvent(next, {
        id: "retry-breaker-open",
        at: frame.t,
        severity: "warn",
        title: "Retry breaker opened",
        detail: `Failure rate crossed ${computed.breakerThreshold}%. Retries are blocked, reducing dependency load but returning errors sooner.`,
        nodeId: "sidecar",
        metricId: "amplification",
      });
      next.flags.breakerSeen = 1;
    }
    if (computed.mode === "overloaded" && previous.mode === "fault" && frame.flags.noRecoverySeen !== 1) {
      pushEvent(next, {
        id: "retry-prevents-recovery",
        at: frame.t,
        severity: "crit",
        title: "Retries prevent the dependency from recovering",
        detail: `The injected fault ended, but ${Math.round(computed.offered).toLocaleString()} rps of offered load keeps the dependency saturated. Retry volume is sustaining the outage.`,
        nodeId: "dependency",
        metricId: "amplification",
      });
      next.flags.noRecoverySeen = 1;
    }
    if (computed.mode === "healthy" && previous.mode === "recovering" && frame.flags.recoveredSeen !== 1) {
      pushEvent(next, {
        id: "dependency-recovered",
        at: frame.t,
        severity: "info",
        title: "Dependency recovered",
        detail: "Offered load returned below capacity and the failure rate decayed. Retries are no longer sustaining the outage.",
        nodeId: "dependency",
      });
      next.flags.recoveredSeen = 1;
    }
    next.summary = `${computed.amplification.toFixed(1)}× attempts, ${Math.round(computed.depUtil)}% dependency load, ${computed.errorRate.toFixed(1)}% errors, p99 ${Math.round(jittered.p99)}ms.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const state = readState(frame, num(p, "clientRps", 6_000));
    return insightsFor(state, advance(p, state, frame.t, 0).computed);
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
    description: "Baseline traffic, retries configured, no fault. The dependency has headroom.",
    tone: "ok",
    params: defaults({ outageSeconds: 0, retryBudget: 10, breakerThreshold: 50 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "10,500 rps against 12,000 rps of capacity. Saturated, but no retry storm.",
    tone: "warn",
    params: defaults({ clientRps: 10_500, outageSeconds: 0, retryBudget: 10, breakerThreshold: 50 }),
  },
  {
    id: "failure",
    label: "Fault, no budget",
    description: "A 5s fault with two retries, no budget, and no breaker. Attempts triple and the dependency never recovers.",
    tone: "crit",
    params: defaults({ clientRps: 6_000, retryAttempts: 2, retryBudget: 0, breakerThreshold: 100, outageSeconds: 5 }),
  },
  {
    id: "budget",
    label: "Retry budget",
    description: "Same fault, with retries capped at 10% of base requests. Amplification stays near 1.1×, but errors still surface.",
    tone: "warn",
    params: defaults({ clientRps: 6_000, retryAttempts: 2, retryBudget: 10, breakerThreshold: 100, outageSeconds: 5 }),
  },
  {
    id: "breaker",
    label: "Breaker",
    description: "No budget, but retries stop when the failure rate crosses 50%. Fast errors protect the dependency.",
    tone: "warn",
    params: defaults({ clientRps: 6_000, retryAttempts: 2, retryBudget: 0, breakerThreshold: 50, outageSeconds: 5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Budget and breaker together. Load stays below capacity, and the dependency recovers after the fault.",
    tone: "ok",
    params: defaults({ clientRps: 6_000, retryAttempts: 2, retryBudget: 10, breakerThreshold: 50, outageSeconds: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-retry-tail",
  title: "Predict the five-minute tail",
  simId: "retry-storm",
  question:
    "A dependency fails for 5 seconds. Proxies allow 2 retries per request, have no retry budget, and the breaker is disabled. What happens after the fault clears?",
  prediction: {
    options: [
      { id: "recovers", label: "Offered load falls with the fault and traffic returns to baseline within seconds" },
      { id: "sustained", label: "Retries keep offered load near 3× until retry volume is reduced or load is shed" },
      { id: "only-fault", label: "Request volume triples only during the 5-second fault, then the extra attempts disappear" },
      { id: "jitter", label: "Jittered backoff prevents any sustained increase in load" },
    ],
    correctOptionId: "sustained",
    explanation:
      "The fault is shared by every caller. Each failed request produces two retries, so 6,000 rps becomes 18,000 attempts. That is above the dependency's 12,000 rps teaching capacity, so it stays saturated after the original fault ends. Retries are individually reasonable and collectively a denial of service.",
  },
  setup: defaults({ clientRps: 6_000, retryAttempts: 2, retryBudget: 0, breakerThreshold: 100, outageSeconds: 5 }),
  runFor: 45,
  observe: [
    "Amplification reaches 3.0× when the fault starts and remains near 2.8× after it ends.",
    "Dependency load stays at or above 100% of capacity, and user errors remain high.",
    "Pending retries climb into the thousands and keep a queue at the sidecar.",
    "The event feed records that the injected fault ended but retries prevent recovery.",
    "A 5-second fault becomes a sustained incident measured in minutes.",
  ],
  explain:
    "The original fault contributes 5 seconds of failure. The retry policy contributes the rest. With two retries and a 100% failure rate, offered load is three times the base rate. Six thousand requests per second become 18,000 attempts, and the dependency can serve 12,000. Because the dependency stays saturated, it keeps failing, which keeps the retry rate high. Jitter spreads the attempts by milliseconds; it cannot remove the extra 12,000 rps.",
  fix: defaults({ clientRps: 6_000, retryAttempts: 2, retryBudget: 10, breakerThreshold: 50, outageSeconds: 5 }),
  debrief:
    "A 10% retry budget caps retries at 600 rps, so offered load is about 6,600 rps and the dependency recovers after the fault. A 50% breaker does the same by blocking retries during the failure, at the cost of failing fast. The budget is the recommended default control for transient errors; the breaker is the backstop for a dependency that is already saturated.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Envoy retry is a new attempt for a request that failed according to a retry policy. The router filter supports retry conditions such as 5xx, gateway errors, resets, connect failures, and gRPC status codes. Retries are off unless a route or virtual host configures them; when a policy exists, Envoy defaults to one retry and allows the count to be raised. The route timeout includes every attempt and the backoff between them, which prevents an unbounded retry and timeout explosion.",
  },
  {
    type: "p",
    text: "A retry storm is what happens when many proxies retry the same shared failure. Each caller sees a reasonable local decision: the call failed, so try again. The dependency sees the sum of those decisions. If every request gets two retries during a total failure, offered load becomes three times the original. If the dependency was already at its capacity, the extra load keeps it failing, which produces more retries. A five-second fault can become a sustained outage without any single bad actor.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, edge proxy, service, sidecar proxy, dependency. Retries can be configured at the route or virtual host and are enforced by the proxy, so an application change is not required. The correct place to retry is the layer immediately above the failing dependency. If several layers retry, the amplification multiplies: three attempts at two layers is nine attempts at the bottom.",
  },
  {
    type: "compare",
    leftTitle: "Transient, isolated failure",
    rightTitle: "Shared dependency failure",
    rows: [
      { label: "Blast radius", left: "One host or one connection", right: "Every caller and every proxy" },
      { label: "Retry outcome", left: "Usually lands on a healthy host", right: "Lands on the same saturated dependency" },
      { label: "Useful control", left: "A small retry count with jitter", right: "Retry budget, breaker, load shedding" },
      { label: "Risk", left: "Duplicate side effects without idempotency", right: "Amplification prevents recovery" },
    ],
  },
  {
    type: "p",
    text: "Envoy applies fully jittered exponential backoff by default. The base interval is 25ms and the maximum interval is 250ms, so the first retry waits 0–24ms, the second 0–74ms, and later retries spread across a wider window. Jitter is useful: it prevents every proxy from retrying on the same millisecond. It does not reduce the total number of attempts, which is the quantity that keeps a saturated dependency down.",
  },
  {
    type: "p",
    text: "Envoy's retry budget lives in the cluster circuit breaker configuration and is expressed as a budget percentage with a minimum retry concurrency. The simulator simplifies it to a share of the base request rate so the arithmetic stays visible; the control behavior is the same.",
  },
  {
    type: "p",
    text: "Envoy does not expose a single feature named a retry breaker. It bounds retries with the cluster retry budget and retry circuit breaker, and it can eject failing hosts with outlier detection. The simulator models that bounding behavior as one retry breaker so the state change is visible.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Retry amplification: total attempts divided by original requests, with warning at 1.5× and critical at 2.5×.",
      "Dependency load against a 12,000 rps teaching capacity, plus the user error rate and end-to-end p99.",
      "Pending retries at the sidecar, the queue that grows when retries wait for connections or backoff.",
      "A flow view of clients, edge proxy, checkout, sidecar, and the dependency, plus a queue view of the retry backlog.",
      "A breaker state in the sidecar label and an event when retries are blocked.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Fault, no budget. Watch amplification reach 3× at the five-second mark and stay high after the fault ends. Compare Retry budget and Breaker. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "table",
    headers: ["Control", "What it bounds", "Cost"],
    rows: [
      ["Retries per request", "Attempts for one request", "User waits through every attempt; duplicates need idempotency"],
      ["Retry budget", "Retries as a share of base requests in this model", "Some transient failures surface as errors"],
      ["Circuit breaker", "Retries while the failure rate is high", "Fail fast and partial failure; needs a recovery policy"],
      ["Jittered backoff", "Synchronization between retries", "Spreads, but does not cap, total volume"],
      ["Per-try timeout", "Time for one attempt", "Too short creates retries for slow but healthy calls"],
    ],
  },
  { type: "sim", simId: "retry-storm" },
  { type: "experiment", experimentId: "predict-retry-tail" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The dependency failed for five seconds. Every proxy saw the failure and retried according to the same policy. With two retries and no budget, 6,000 requests per second became 18,000 attempts. The dependency's teaching capacity is 12,000 rps, so the amplified load kept it saturated after the original fault ended. The fault was small; the response to it was the outage.",
  },
  {
    type: "p",
    text: "A 10% retry budget capped retries at 600 rps, holding offered load near 6,600 rps. A 50% breaker blocked retries during the failure and let the dependency drain, at the cost of returning errors sooner. In the combined recovery, the load stayed below capacity, the failure rate decayed, and the dependency returned to healthy. The queue drained last, which is why the tail outlives the fault.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy retry counters: `upstream_rq_retry`, `upstream_rq_retry_success`, `upstream_rq_retry_limit_exceeded`, and `upstream_rq_retry_overflow`.",
      "Circuit breaker and pool stats: `upstream_rq_pending_overflow`, `upstream_rq_active_overflow`, and `upstream_cx_overflow`.",
      "Router stats count final responses; retried attempts appear in the cluster retry stats. Do not infer attempt volume from final response codes alone.",
      "`x-envoy-overloaded` on a response means the router dropped work because of maintenance mode or circuit breaking.",
      "Dependency server metrics: request rate, concurrency, queue depth, CPU, and latency. A flat request rate with rising retries points at the proxy layer.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare retry rate with base request rate for the affected cluster. Confirm whether the failure is shared by all callers or isolated to a host. Check who changed max retries, retry-on, or per-try timeout. Then check whether the dependency is saturated by offered load, not just by its original traffic.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the amplification: add a retry budget, lower the retry count, or open a breaker. Do this before adding dependency capacity.",
      "Retry only at the layer immediately above the failing dependency. Remove retries from callers that cannot see the dependency's health.",
      "Set a per-try timeout below the route timeout. The route timeout includes all attempts, so it caps total user wait.",
      "Make retried operations idempotent, or restrict retries to safe methods and explicit retryable codes.",
      "Add load shedding or a degraded response for non-critical traffic so the dependency can recover with the capacity it has.",
      "Restore retries gradually after the dependency is healthy, and watch retry overflow and success as you raise the budget.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A retry budget converts some retryable failures into user-visible errors. That is the point: it spends availability to protect the dependency from a longer outage.",
      "A breaker fails fast. Users see errors sooner, and a badly tuned threshold can oscillate between open and closed.",
      "Jitter is cheap and useful, but it cannot bound volume. Treat it as a complement to a budget, not a substitute.",
      "Fewer retries improve recovery but reduce resilience to isolated host failures. Scope the policy by dependency criticality.",
      "Retries can duplicate side effects. Idempotency keys or safe-method restrictions are part of the retry design, not an afterthought.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-storm",
    question:
      "A dependency failed for five seconds, but error rates stay high for five minutes and its request rate is triple normal. What are your first checks?",
    difficulty: 4,
    hints: [
      "Separate the original fault from the response to it.",
      "Look at attempts, not only final responses.",
    ],
    answer:
      "I would compare retry rate with base request rate per cluster and confirm the dependency is seeing attempts, not new demand. Then I would check the retry policy: max retries, retry-on conditions, per-try timeout, and whether every caller retries the same dependency. I would look for a deploy or config change that added retries, and check whether the dependency is saturated by offered load. Envoy stats such as upstream_rq_retry and upstream_rq_retry_overflow separate retries from final responses. If the retry rate is high and the dependency is above capacity, the first action is to cut retry volume, not to add capacity.",
    followUps: [
      "Which stat tells you retries were dropped?",
      "How would you tell a shared dependency failure from a single bad host?",
      "What would you change first if you could not deploy?",
    ],
    redFlags: [
      "Raises retry counts to improve success rate.",
      "Looks only at final error codes.",
      "Adds capacity without checking offered load.",
    ],
    rubric: [
      "Separates fault from amplification.",
      "Uses retry and overflow stats.",
      "Checks policy and config changes.",
      "Names a load-reduction action.",
    ],
  },
  {
    id: "retry-math",
    question:
      "Why does a 5-second failure produce a 5-minute incident, and how does a 10% retry budget change the math?",
    difficulty: 3,
    hints: [
      "Retries are extra load, not extra time.",
      "The dependency's recovery depends on load, not on the fault timer.",
    ],
    answer:
      "The fault timer ends after five seconds, but the dependency only recovers when offered load falls below its capacity. With two retries and a total failure, 6,000 base rps becomes 18,000 attempts. If capacity is 12,000, the dependency stays saturated and keeps failing, so retries keep coming. A 10% budget caps retries at 600 rps, so offered load is about 6,600 and the dependency can drain and recover. The budget ends the feedback loop; the fault timer alone does not.",
    followUps: [
      "What if the dependency's capacity is 20,000 rps?",
      "How does a retry budget interact with per-request retries?",
      "What does the budget do to user-visible errors?",
    ],
    redFlags: [
      "Assumes the outage ends when the fault ends.",
      "Ignores capacity.",
      "Treats retries as free.",
    ],
    rubric: [
      "Explains the feedback loop.",
      "Computes amplification.",
      "Shows the budget cap.",
      "Names the error tradeoff.",
    ],
  },
  {
    id: "budget-vs-breaker",
    question:
      "When would you choose a retry budget, a circuit breaker, or jitter, and which is the default?",
    difficulty: 3,
    hints: [
      "One controls the rate, one controls the state, one controls timing.",
      "Start from the failure mode you need to bound.",
    ],
    answer:
      "A retry budget is the recommended default because it bounds retry volume continuously without needing a failure threshold. It allows a small retry rate for isolated blips and caps the fleet-wide amplification. A breaker is the backstop for a dependency that is already saturated or failing hard: it stops retries and can fail fast, but it needs hysteresis to avoid oscillation. Jitter is a timing control that prevents synchronized retry waves; it does not cap the number of attempts. I would use a budget plus jitter first, and add a breaker for dependencies whose failures are correlated or expensive.",
    followUps: [
      "What threshold would you start with for the breaker?",
      "How do you avoid breaker oscillation?",
      "Why not rely on jitter alone?",
    ],
    redFlags: [
      "Treats jitter as a volume control.",
      "Sets a breaker with no recovery policy.",
      "Uses retries as the only resilience mechanism.",
    ],
    rubric: [
      "Matches control to failure mode.",
      "Explains hysteresis.",
      "Distinguishes rate and timing.",
      "Names a default and a backstop.",
    ],
  },
  {
    id: "idempotency",
    question:
      "You add retries to a payment call. What must be true before that is safe, and how do timeouts complicate it?",
    difficulty: 4,
    hints: [
      "A timeout does not prove the server did nothing.",
      "A retry can duplicate a side effect.",
    ],
    answer:
      "The operation must be idempotent, or the retry must carry an idempotency key that the server uses to deduplicate. A timeout is ambiguous: the server may have committed the payment and failed to return the response, so retrying can charge twice. I would restrict automatic retries to safe methods or explicit retryable responses, use an idempotency key with a defined retention window, and keep the retry budget small. I would also make the client's final error distinguishable from an unknown outcome so reconciliation can handle it.",
    followUps: [
      "What status codes would you retry for a payment?",
      "How long should the idempotency key be retained?",
      "What would you show the user on an unknown outcome?",
    ],
    redFlags: [
      "Retries every 5xx on a non-idempotent write.",
      "Treats a timeout as a definite failure.",
      "Ignores duplicate side effects.",
    ],
    rubric: [
      "Requires idempotency or safe methods.",
      "Explains timeout ambiguity.",
      "Defines deduplication retention.",
      "Handles unknown outcomes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every retry policy has an owner, a max attempt count, and a retry-on list.",
      "A retry budget is configured per dependency, not only per route.",
      "Per-try timeouts are lower than route timeouts.",
      "Retried writes are idempotent or carry an idempotency key.",
      "Dashboards separate retry attempts from final responses and show overflow counters.",
      "Only the layer immediately above a dependency retries it.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare retry rate with base request rate before changing capacity.",
      "Confirm whether the failure is shared by all callers or isolated to a host.",
      "Cut retry volume first: budget, attempt count, or breaker.",
      "Protect the dependency with load shedding or a degraded response.",
      "Watch retry overflow, pending overflow, and retry success as you adjust.",
      "Record the policy change and the time it took effect.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore retries gradually and verify amplification stays bounded.",
      "Remove retries from layers that cannot see dependency health.",
      "Add a load test that injects a shared dependency failure.",
      "Review whether the breaker threshold and recovery policy match the dependency.",
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
    note: "Retry conditions, max retries, jittered backoff, route timeouts, and retry statistics.",
  },
  {
    title: "Envoy circuit breaking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Retry budgets, maximum active retries, and overflow counters.",
  },
  {
    title: "Handling Overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Per-request and per-client retry budgets, the 10% retry ratio, and retry amplification math.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "retry-storm": {
      model: retryStormModel,
      presets,
      instructions:
        "Start Healthy, apply Fault, no budget, then compare Retry budget, Breaker, and Recovery. Watch amplification after the injected fault ends.",
      experimentIds: [experiment.id],
      alternateVisuals: ["queue"],
      note: "Illustrative model. Dependency capacity, queue behavior, and the failure curve are teaching values, not Envoy defaults or provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "mesh-retries",
    "mesh-circuit-breaking",
    "mesh-outlier-detection",
    "mesh-timeouts",
    "mesh-traffic-splitting",
  ],
};
