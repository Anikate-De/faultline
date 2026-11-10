import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TIMEOUT_MS = 1_000;
const REQUEST_RPS = 1_200;
const DEP_CAPACITY = 2_000;
const THREADS = 1_000;
const FAULT_START = 5;
const PROBES = 3;

const params = [
  {
    id: "dependencyLatency",
    label: "Dependency latency during fault",
    min: 50,
    max: 2_500,
    step: 10,
    value: 120,
    unit: " ms",
    group: "Dependency",
    help: "Response time while the dependency is degraded. The caller's timeout is 1,000ms in this scenario.",
    format: "ms" as const,
  },
  {
    id: "faultDuration",
    label: "Fault duration",
    min: 0,
    max: 60,
    step: 5,
    value: 0,
    unit: " s",
    group: "Dependency",
    help: "Length of the injected degradation, starting five seconds into the run. Zero runs without a fault.",
    format: "number" as const,
  },
  {
    id: "failureThreshold",
    label: "Failure threshold",
    min: 5,
    max: 95,
    step: 5,
    value: 50,
    unit: "%",
    group: "Breaker policy",
    help: "Observed failure rate that opens the breaker. A threshold near the observed rate can leave it closed.",
    format: "percent" as const,
  },
  {
    id: "resetTimeout",
    label: "Reset timeout",
    min: 1,
    max: 30,
    step: 1,
    value: 8,
    unit: " s",
    group: "Breaker policy",
    help: "Time the breaker stays open before admitting half-open probes.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface BreakerState {
  state: number;
  since: number;
  probes: number;
  probeFails: number;
}

interface Computed {
  state: number;
  since: number;
  probes: number;
  probeFails: number;
  faultActive: boolean;
  callerP99: number;
  errorRate: number;
  threadOccupancy: number;
  callerThroughput: number;
  dependencyRps: number;
  probeRps: number;
  probeP99: number;
}

function readState(frame: SimFrame): BreakerState {
  const state = Number(frame.flags.breaker ?? 0);
  return {
    state: state === 1 || state === 2 ? state : 0,
    since: Math.max(0, Number(frame.flags.since ?? 0)),
    probes: Math.max(0, Number(frame.flags.probes ?? 0)),
    probeFails: Math.max(0, Number(frame.flags.probeFails ?? 0)),
  };
}

function compute(p: Params, t: number, previous: BreakerState): Computed {
  const dependencyLatency = clamp(num(p, "dependencyLatency", 120), 50, 2_500);
  const faultDuration = Math.max(0, num(p, "faultDuration", 0));
  const threshold = clamp(num(p, "failureThreshold", 50), 5, 95) / 100;
  const resetTimeout = Math.max(1, num(p, "resetTimeout", 8));
  const faultActive = faultDuration > 0 && t >= FAULT_START && t < FAULT_START + faultDuration;
  const effectiveLatency = faultActive ? dependencyLatency : 120;
  const failureSample = faultActive ? 0.8 : 0.005;

  let state = previous.state;
  let since = previous.since;
  let probes = previous.probes;
  let probeFails = previous.probeFails;

  if (state === 0 && failureSample >= threshold) {
    state = 2;
    since = t;
    probes = 0;
    probeFails = 0;
  } else if (state === 2 && t - since >= resetTimeout) {
    state = 1;
    since = t;
    probes = 0;
    probeFails = 0;
  } else if (state === 1 && t - since >= 1) {
    probes += 1;
    if (faultActive) probeFails += 1;
    since = t;
    if (probes >= PROBES) {
      if (probeFails === 0) {
        state = 0;
      } else {
        state = 2;
      }
      since = t;
      probes = 0;
      probeFails = 0;
    }
  }

  const closed = state === 0;
  const callLatency = closed ? Math.min(effectiveLatency, TIMEOUT_MS) : 5;
  const callerP99 = closed ? callLatency + 20 : 5;
  const errorRate = closed ? failureSample * 100 : 100;
  const threadOccupancy = closed ? clamp((REQUEST_RPS * callLatency) / 1_000 / THREADS, 0, 1) * 100 : 2;
  const probeRps = state === 1 ? 1 : 0;
  const dependencyRps = closed ? REQUEST_RPS : probeRps;
  const probeP99 = state === 1 ? (faultActive ? callLatency + 20 : 120) : 0;
  return {
    state,
    since,
    probes,
    probeFails,
    faultActive,
    callerP99,
    errorRate,
    threadOccupancy,
    callerThroughput: REQUEST_RPS,
    dependencyRps,
    probeRps,
    probeP99,
  };
}

function stateLabel(state: number): string {
  if (state === 2) return "open";
  if (state === 1) return "half-open";
  return "closed";
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seed(frame: SimFrame, values: Record<string, number>): void {
  for (const [id, value] of Object.entries(values)) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.96 + 0.06 * Math.sin((index + 3) / 2.7))),
    );
  }
}

function buildFrame(c: Computed, seedValue: number): SimFrame {
  const dependencyHealth = c.faultActive ? "crit" : "ok";
  const breakerHealth = c.state === 2 ? "warn" : c.state === 1 ? "warn" : "ok";
  const callerHealth = healthFor(c.callerP99, 300, 800);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: `${REQUEST_RPS.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "caller",
        label: "Checkout service",
        kind: "service",
        health: callerHealth,
        utilization: clamp(c.threadOccupancy / 100),
        throughput: c.callerThroughput,
        sublabel: `${Math.round(c.threadOccupancy)}% threads waiting`,
        meta: { view: "flow" },
      },
      {
        id: "breaker",
        label: "Circuit breaker",
        kind: "mesh",
        health: breakerHealth,
        utilization: clamp(c.dependencyRps / DEP_CAPACITY),
        sublabel: stateLabel(c.state),
        detail: `State ${stateLabel(c.state)}. Failure threshold is a share of observed calls; the reset timeout starts when the breaker opens.`,
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Inventory dependency",
        kind: "external",
        health: dependencyHealth,
        utilization: clamp(c.dependencyRps / DEP_CAPACITY),
        throughput: c.dependencyRps,
        sublabel: c.faultActive ? "degraded" : "healthy",
        detail: `Illustrative teaching capacity is 2,000 rps. Offered load is ${Math.round(c.dependencyRps).toLocaleString()} rps while the breaker is ${stateLabel(c.state)}.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-caller", "client", "caller", clamp(REQUEST_RPS / 2_000), "ok"),
      edge("caller-breaker", "caller", "breaker", clamp(c.callerThroughput / 2_000), breakerHealth),
      edge("breaker-dependency", "breaker", "dependency", clamp(c.dependencyRps / DEP_CAPACITY), dependencyHealth),
    ],
    metrics: [
      metric("caller-p99", "Caller p99", c.callerP99, "ms", 300, 800, "ms"),
      metric("error-rate", "User error rate", c.errorRate, "%", 1, 5, "percent"),
      metric("thread-occupancy", "Caller threads waiting", c.threadOccupancy, "%", 60, 85, "percent"),
      metric("dependency-rps", "Dependency traffic", c.dependencyRps, " rps", undefined, undefined, "rps"),
      metric("probe-rps", "Probe traffic", c.probeRps, " rps", undefined, undefined, "rps"),
      metric("probe-p99", "Probe p99", c.probeP99, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed: seedValue, breaker: c.state, since: c.since, probes: c.probes, probeFails: c.probeFails },
    summary: `${stateLabel(c.state)} breaker; caller p99 ${Math.round(c.callerP99)}ms; dependency ${Math.round(c.dependencyRps).toLocaleString()} rps; ${Math.round(c.errorRate)}% errors.`,
  };
  seed(frame, {
    "caller-p99": c.callerP99,
    "error-rate": c.errorRate,
    "thread-occupancy": c.threadOccupancy,
    "dependency-rps": c.dependencyRps,
    "probe-rps": c.probeRps,
    "probe-p99": c.probeP99,
  });
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "caller-p99",
    metricId: "caller-p99",
    warn: 300,
    crit: 800,
    title: "Caller p99 is pinned to the dependency timeout",
    cause:
      "The breaker is closed while the dependency is slow, so every request waits for the full timeout. One slow dependency becomes a caller-wide latency incident.",
    fix:
      "Open on a failure-rate or slow-call threshold and shorten the dependency timeout. A fast local failure returns caller capacity even while the dependency is broken.",
    checkFirst: [
      "Compare dependency latency with the caller timeout.",
      "Check whether the breaker state is closed during the latency spike.",
      "Split p99 by dependency and by operation before changing capacity.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "User-visible errors exceed the SLO",
    cause:
      "The breaker changes where failures happen, not whether they happen. An open breaker returns fast failures, and a closed breaker returns timeouts, unless a fallback serves the request.",
    fix:
      "Pair the breaker with a bounded fallback such as cached or reduced content. Report the fallback rate separately so a silent degradation does not become the new normal.",
    checkFirst: [
      "Separate timeout errors from fast-fail errors.",
      "Check whether a fallback exists and whether it is inside its own timeout.",
      "Check whether retries or duplicate requests are inflating the error count.",
    ],
  },
  {
    id: "thread-occupancy",
    metricId: "thread-occupancy",
    warn: 60,
    crit: 85,
    title: "Caller worker threads are exhausted by blocked calls",
    cause:
      "Each in-flight request holds a worker while it waits for the dependency. When latency reaches the timeout, concurrency rises until the caller cannot serve unrelated work.",
    fix:
      "Cap concurrency per dependency, open the breaker earlier, and keep timeouts below the request budget. The breaker exists to free the caller, not only to protect the dependency.",
    checkFirst: [
      "Check in-flight requests and worker-pool saturation by dependency.",
      "Check whether unrelated endpoints are failing at the same time.",
      "Check connection-pool wait as well as thread wait.",
    ],
  },
];

function computeFromFrame(frame: SimFrame, p: Params): Computed {
  return compute(p, frame.t, readState(frame));
}

export const circuitBreakerModel: SimModel = {
  id: "foundations-circuit-breaking",
  visual: "flow",
  params,
  init: ({ seed: seedValue }) =>
    buildFrame(
      compute(defaults(), 0, { state: 0, since: 0, probes: 0, probeFails: 0 }),
      seedValue,
    ),
  step: (frame, p) => {
    const previousState = readState(frame);
    const values = compute(p, frame.t, previousState);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    if (values.state !== previousState.state) {
      const titles: Record<number, string> = {
        2: "Breaker opened",
        1: "Breaker half-open",
        0: "Breaker closed",
      };
      pushEvent(next, {
        id: `breaker-${values.state}`,
        at: frame.t,
        severity: values.state === 0 ? "info" : "warn",
        title: titles[values.state],
        detail:
          values.state === 0
            ? "The probes succeeded; normal traffic is allowed again."
            : values.state === 1
              ? `The reset timeout elapsed. ${PROBES} probes may test the dependency.`
              : `The failure rate crossed ${Math.round(clamp(num(p, "failureThreshold", 50), 5, 95))}%. Calls fail locally until the reset timeout.`,
        nodeId: "breaker",
      });
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = computeFromFrame(frame, p);
    const items: string[] = [];
    if (c.state === 0) {
      const effective = c.faultActive
        ? Math.min(num(p, "dependencyLatency", 120), TIMEOUT_MS)
        : 120;
      items.push(
        `The breaker is closed. Every request pays up to ${Math.round(effective)}ms of dependency latency.`,
      );
    } else if (c.state === 2) {
      items.push("The breaker is open. Calls fail locally in milliseconds while the dependency receives no production traffic.");
    } else {
      items.push(`The breaker is half-open. ${PROBES} probes decide whether to close it or reopen it.`);
    }
    items.push(
      `Thread occupancy is ${Math.round(c.threadOccupancy)}%; an open breaker frees the caller even when the dependency is still down.`,
    );
    items.push(
      "The error rate stays high during an outage unless a fallback serves the request. A breaker protects latency and capacity, not correctness.",
    );
    items.push(
      `Observed failure share is ${c.faultActive ? "80" : "0.5"}% against a ${Math.round(num(p, "failureThreshold", 50))}% threshold.`,
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
    description: "Fast dependency, breaker closed.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow dependency",
    description: "450ms calls inside a 1s timeout. p99 warns but the breaker stays closed.",
    tone: "warn",
    params: defaults({ dependencyLatency: 450 }),
  },
  {
    id: "failure",
    label: "No trip",
    description: "The dependency fails for the whole run while the threshold stays above the observed failure rate.",
    tone: "crit",
    params: defaults({ dependencyLatency: 2_500, faultDuration: 60, failureThreshold: 95, resetTimeout: 30 }),
  },
  {
    id: "open",
    label: "Breaker open",
    description: "The same fault with a 40% threshold. Calls fail fast; errors remain.",
    tone: "warn",
    params: defaults({ dependencyLatency: 2_500, faultDuration: 60, failureThreshold: 40, resetTimeout: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 20s fault, a 40% threshold, and a 5s reset. The breaker probes and closes after the dependency heals.",
    tone: "ok",
    params: defaults({ dependencyLatency: 2_500, faultDuration: 20, failureThreshold: 40, resetTimeout: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-fast-failure",
  title: "Predict what the breaker changes",
  simId: "breaker",
  question:
    "The dependency fails for the whole run. You lower the failure threshold from 95% to 30%. What changes first?",
  prediction: {
    options: [
      { id: "latency", label: "Caller p99 falls to milliseconds, but errors remain" },
      { id: "errors", label: "User errors disappear because the breaker blocks them" },
      { id: "dependency", label: "The dependency recovers and starts serving normally" },
      { id: "nothing", label: "Nothing changes until the dependency is fixed" },
    ],
    correctOptionId: "latency",
    explanation:
      "The breaker observes the 80% failure share, opens, and rejects calls locally. That removes the timeout wait and frees caller threads, so p99 collapses. It does not make the dependency healthy, and every rejected call is still a failed request unless a fallback exists.",
  },
  setup: defaults({ dependencyLatency: 2_500, faultDuration: 60, failureThreshold: 95, resetTimeout: 10 }),
  runFor: 25,
  observe: [
    "With the 95% threshold, caller p99 stays pinned near 1,020ms and dependency traffic stays at 1,200 rps.",
    "Caller threads remain fully occupied, so the slow dependency becomes a caller-wide latency incident.",
    "User errors stay near 80% because every failed call waits for the timeout.",
    "After applying 30%, p99 falls to 5ms, dependency traffic drops to zero while the breaker stays open, and errors rise to 100%.",
  ],
  explain:
    "A breaker is a state machine over observed outcomes, not a repair mechanism. Closed admits traffic and measures failure. Open rejects locally and waits. Half-open admits a small probe budget. The tradeoff is deliberate: you accept immediate errors to stop a slow dependency from consuming the caller.",
  fix: defaults({ dependencyLatency: 2_500, faultDuration: 60, failureThreshold: 30, resetTimeout: 5 }),
  debrief:
    "After the probe budget and reset timeout are tuned, the caller stays responsive through the outage. The remaining work is product-facing: a fallback for the failed operation, a clear degraded response, and a dashboard that separates fast failures from timeouts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A circuit breaker is a local state machine in front of a dependency. In the closed state it admits calls and records outcomes. When the failure rate or slow-call rate crosses a threshold, it opens and rejects calls immediately instead of waiting for another timeout. After a reset timeout it enters half-open and admits a small number of probes. If the probes succeed, it closes; if they fail, it opens again.",
  },
  {
    type: "p",
    text: "The failure it prevents is not the dependency's outage. It is the caller's collapse. Every request that waits on a slow dependency holds a worker, a connection, or memory. Once the timeout is long relative to the request rate, in-flight work exhausts the caller and unrelated endpoints fail too. The breaker turns a repeated remote failure into a cheap local failure, which preserves the caller's capacity and gives the dependency room to recover.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The breaker belongs at the call boundary: inside the client library, the service mesh sidecar, or an API gateway. It should wrap one dependency or one operation, not an entire service, because different operations have different failure costs. The timeout sits inside the breaker, and the fallback sits outside it: the breaker decides whether to call; the fallback decides what to return when the call is rejected or fails.",
  },
  {
    type: "table",
    headers: ["State", "Traffic", "What it protects", "What can go wrong"],
    rows: [
      ["Closed", "All requests", "Nothing yet; it only measures", "A high threshold never trips and the caller keeps waiting"],
      ["Open", "No production calls; local failures", "Caller threads, connections, dependency", "Errors stay visible; a long timeout hides recovery"],
      ["Half-open", "A small probe budget", "Dependency from a thundering herd", "Too many probes can re-open the breaker under load"],
      ["Closed after probes", "All requests", "Restored throughput", "A flapping dependency reopens it repeatedly"],
    ],
  },
  {
    type: "p",
    text: "This module models a checkout caller at 1,200 requests per second against a dependency with an illustrative 2,000 rps capacity and a 1,000ms caller timeout. The numbers are teaching values, not a vendor limit. The shape is the lesson: a closed breaker inherits the timeout, an open breaker removes it, and the half-open state is the only place where recovery is tested.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Caller p99 (99th-percentile latency): it tracks the dependency timeout while closed and collapses to milliseconds when open.",
      "User error rate: fast failures still count as errors, so this metric rarely improves when the breaker opens.",
      "Caller threads waiting: the resource that a closed breaker consumes and an open breaker releases.",
      "Dependency traffic: production load while closed, probe traffic while half-open, and zero while open.",
      "Probe traffic and probe p99: the small half-open sample that decides whether the breaker closes.",
      "Breaker state on the node and in the event feed: closed, open, or half-open.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No trip. Watch p99 pin to the timeout and threads fill. Switch to Breaker open with the same fault and compare p99, errors, and dependency traffic. Run the experiment before reading its explanation. Then use Recovery and watch the half-open probes after the fault ends. The breaker is not a fallback; say out loud what the user receives in each state.",
  },
  { type: "sim", simId: "breaker" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "While the breaker stayed closed, every call waited up to the 1,000ms timeout. At 1,200 rps that is 1,200 concurrent requests waiting on a 1,000-thread caller, so the pool saturated and p99 pinned to the timeout. The dependency was slow, but the caller turned that into thread exhaustion and broad latency.",
  },
  {
    type: "p",
    text: "Lowering the threshold opened the breaker. Calls then failed locally in milliseconds, dependency traffic fell toward zero, and threads were released. The error rate did not fall: fast failure is still failure. Recovery came from the half-open probes after the fault ended, not from the breaker itself. That distinction is the whole lesson.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy: `upstream_rq_pending_overflow`, `upstream_rq_active_overflow`, `upstream_cx_overflow`, and `upstream_rq_retry_overflow` on the upstream cluster.",
      "Resilience4j or a client library: state transitions, failure rate, slow-call rate, buffered calls, and `CallNotPermittedException` counts.",
      "Application metrics: caller p99 by dependency, in-flight requests, worker-pool queue, connection-pool wait, and fallback rate.",
      "Logs: repeated timeout messages that stop abruptly when the breaker opens, followed by local rejection messages.",
      "Traces: a dependency span that disappears while the parent span becomes a fast local error, which separates a breaker from a dependency recovery.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the breaker state before you touch capacity. Compare dependency latency with the caller timeout, then check in-flight requests and thread-pool saturation. If the breaker is closed and the timeout is long, open it earlier or shorten the timeout. If it is open, verify that the probes are actually reaching a healthy dependency and that the fallback is bounded.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the call boundary and the timeout that the caller currently pays.",
      "Instrument outcomes and state transitions before tuning the threshold.",
      "Set a failure threshold below the failure share you are willing to wait through, and require a minimum call volume so one error does not open it.",
      "Keep the reset timeout long enough for the dependency to recover, and cap half-open probes so recovery cannot become a load spike.",
      "Add a fallback with its own short timeout and a clear degraded response.",
      "Test the open and half-open states under load; a breaker that has never opened in a test is an untested code path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A low threshold trips on noise and turns a transient blip into user-visible errors; a high threshold lets the caller absorb the full timeout.",
      "A short reset timeout probes too often and can keep a struggling dependency down; a long one delays recovery after the dependency heals.",
      "An open breaker without a fallback trades latency for errors. That may be the right trade, but it must be a decision, not a surprise.",
      "The breaker is per process. Many callers can still synchronize their retries or probes, so pair it with retry budgets and jitter.",
      "Fallbacks need freshness and correctness rules of their own; a stale cache can hide an outage for too long.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-threshold",
    question:
      "How do you choose the failure threshold and reset timeout for a dependency that fails in bursts?",
    difficulty: 3,
    hints: [
      "Think about the cost of a false open versus a slow timeout.",
      "The reset timeout is a recovery test, not a fixed sleep.",
    ],
    answer:
      "I start from the caller's budget. If a request can spend at most 800ms and the dependency normally answers in 100ms, a 1,000ms timeout is already wrong. I set the threshold from the failure share the caller can absorb without exhausting threads, require a minimum number of calls so a single error does not trip it, and use a sliding window long enough to cover a burst but short enough to react. The reset timeout should match the dependency's recovery behavior, and half-open probes should be a small, bounded sample. I would tune both against a load test that includes an open and a half-open period, not against production for the first time.",
    followUps: [
      "What changes if the dependency is idempotent?",
      "How would you detect a breaker that is flapping?",
      "What is the risk of a very low minimum call count?",
    ],
    redFlags: [
      "Picks 50% because it is the default.",
      "Sets a reset timeout without a recovery test.",
      "Treats an open breaker as a fix for errors.",
    ],
    rubric: [
      "Ties thresholds to the caller budget.",
      "Explains minimum volume and the sliding window.",
      "Bounds half-open probes.",
      "Names the flapping risk.",
    ],
  },
  {
    id: "explain-half-open",
    question:
      "Explain half-open to a product owner who wants the breaker to close as soon as the dependency is healthy.",
    difficulty: 2,
    hints: [
      "The breaker cannot know health without sending traffic.",
      "The probe is a sample, not a guarantee.",
    ],
    answer:
      "Half-open is how the breaker asks the dependency a controlled question. After the reset timeout, it allows a few requests through. If they succeed, it closes and restores full traffic. If they fail, it opens again and waits. Closing immediately on a timer would send the full request rate at a dependency that may still be down, which is exactly the load that prevents recovery. The probe budget makes recovery observable without turning it into another outage.",
    followUps: [
      "How many probes are enough?",
      "What happens if the probes succeed but the dependency fails a minute later?",
      "Should the probe traffic come from real users?",
    ],
    redFlags: [
      "Says half-open is the same as closed.",
      "Wants to close on a timer without probes.",
      "Sends the full production rate as the probe.",
    ],
    rubric: [
      "Describes the probe budget.",
      "Explains why full traffic is dangerous.",
      "States the success and failure transitions.",
      "Connects probes to recovery time.",
    ],
  },
  {
    id: "breaker-not-fallback",
    question:
      "The breaker is open, p99 is 4ms, and the error rate is 100%. Is the incident over?",
    difficulty: 3,
    hints: [
      "Latency and availability are different promises.",
      "What does the user actually receive?",
    ],
    answer:
      "No. The breaker has protected the caller's capacity and the dependency, but every request is still failing. The incident has changed shape: it is now an availability incident with a fast error instead of a latency incident with a slow one. I would check whether a fallback can serve a correct-enough response, whether the dependency is recovering, and whether the error budget burn is acceptable. If there is no fallback, the breaker is still useful, but the product is down; saying otherwise hides the user impact.",
    followUps: [
      "What fallback would you add for a checkout page?",
      "How do you measure the fallback's correctness?",
      "When would you keep the breaker open longer than necessary?",
    ],
    redFlags: [
      "Calls the incident resolved because p99 improved.",
      "Ignores the error rate.",
      "Adds a fallback without a freshness rule.",
    ],
    rubric: [
      "Separates latency from availability.",
      "Names the user-visible outcome.",
      "Connects the breaker to the error budget.",
      "Proposes a bounded fallback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every remote dependency has a timeout below the caller's remaining budget.",
      "Breaker state transitions and failure rates are dashboarded per dependency.",
      "A minimum call volume prevents a single error from opening the breaker.",
      "Half-open probe count and reset timeout are documented and load-tested.",
      "A fallback exists for operations that must not return an error.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check breaker state before adding capacity or retrying.",
      "Compare p99 with the timeout; a pinned p99 means closed plus slow.",
      "Watch thread and connection pools, not only the dependency.",
      "Confirm probes are reaching a dependency that can answer them.",
      "Record when the breaker opened, closed, and reopened.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run the fault with the breaker enabled and disabled.",
      "Review the threshold against the observed failure distribution.",
      "Remove temporary fallbacks or make them permanent with a freshness rule.",
      "Add an alert for a breaker that stays open or flaps.",
    ],
  },
];

const references = [
  {
    title: "Circuit breaking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Connection, pending-request, active-request, and retry limits at the proxy.",
  },
  {
    title: "CircuitBreaker",
    url: "https://resilience4j.readme.io/docs/circuitbreaker",
    publisher: "Resilience4j",
    kind: "docs" as const,
    note: "Closed, open, and half-open states; failure-rate and slow-call thresholds.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    breaker: {
      model: circuitBreakerModel,
      presets,
      instructions:
        "Start healthy, apply No trip, then compare Breaker open with the same fault. Watch caller p99, error rate, threads, and dependency traffic together.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 1,000ms timeout, 1,200 rps caller, and 2,000 rps dependency capacity are teaching values, not vendor limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-retry-backoff-jitter",
    "foundations-timeouts",
    "mesh-circuit-breaking",
    "reliability-dependency-failure",
  ],
};
