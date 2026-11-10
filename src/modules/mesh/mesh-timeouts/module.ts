import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_RATE = 20_000;

const params = [
  {
    id: "backendLatency",
    label: "Backend response time",
    min: 100,
    max: 3_000,
    step: 50,
    value: 300,
    unit: " ms",
    group: "Backend",
    help: "Illustrative response time for the request that sets the tail. The model treats the share above the shortest deadline as the cut share.",
    format: "ms" as const,
  },
  {
    id: "routeTimeout",
    label: "Route timeout",
    min: 100,
    max: 5_000,
    step: 100,
    value: 2_000,
    unit: " ms",
    group: "Timeouts",
    help: "Total time the proxy allows for the upstream response, including every retry attempt. It starts after the request stream is complete.",
    format: "ms" as const,
  },
  {
    id: "perTryTimeout",
    label: "Per-try timeout",
    min: 50,
    max: 2_000,
    step: 50,
    value: 1_000,
    unit: " ms",
    group: "Timeouts",
    help: "Deadline for one attempt. A value below the backend response time cuts every attempt and sends the next retry into the same wall.",
    format: "ms" as const,
  },
  {
    id: "appDeadline",
    label: "Application deadline",
    min: 50,
    max: 3_000,
    step: 50,
    value: 800,
    unit: " ms",
    group: "Timeouts",
    help: "Deadline the service enforces on its own work, or receives through a propagated gRPC deadline. The proxy does not set this clock.",
    format: "ms" as const,
  },
  {
    id: "retryAttempts",
    label: "Retry attempts",
    min: 0,
    max: 3,
    step: 1,
    value: 2,
    unit: "",
    group: "Retries",
    help: "Retries after the first attempt. Each attempt gets the per-try timeout again, while the route timeout caps the total.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Source = "route timeout" | "per-try timeout" | "application deadline";

interface Computed {
  rate: number;
  backendLatency: number;
  routeTimeout: number;
  perTryTimeout: number;
  appDeadline: number;
  retryAttempts: number;
  perAttemptBudget: number;
  attemptsAllowed: number;
  timeoutShare: number;
  prematureShare: number;
  errorRate: number;
  p99: number;
  budgetUsed: number;
  amplification: number;
  source: Source;
  routeHeadroom: number;
}

function compute(p: Params, jitter = 0): Computed {
  const rate = 8_000;
  const backendLatency = Math.max(10, num(p, "backendLatency", 300));
  const routeTimeout = Math.max(10, num(p, "routeTimeout", 2_000));
  const perTryTimeout = Math.max(10, num(p, "perTryTimeout", 1_000));
  const appDeadline = Math.max(10, num(p, "appDeadline", 800));
  const retryAttempts = Math.max(0, Math.round(num(p, "retryAttempts", 2)));
  const perAttemptBudget = Math.min(perTryTimeout, appDeadline);
  const source: Source =
    routeTimeout <= perAttemptBudget
      ? "route timeout"
      : appDeadline <= perTryTimeout
        ? "application deadline"
        : "per-try timeout";
  const attemptsAllowed = Math.max(
    1,
    Math.min(retryAttempts + 1, Math.max(1, Math.floor(routeTimeout / Math.max(1, perAttemptBudget)))),
  );
  const totalTime = Math.min(routeTimeout, perAttemptBudget * attemptsAllowed);
  const timeoutShare = clamp((backendLatency - Math.min(perAttemptBudget, routeTimeout)) / Math.max(1, backendLatency), 0, 1);
  const failed = timeoutShare > 0;
  const prematureShare = routeTimeout > backendLatency && perAttemptBudget < backendLatency ? timeoutShare : 0;
  return {
    rate,
    backendLatency,
    routeTimeout,
    perTryTimeout,
    appDeadline,
    retryAttempts,
    perAttemptBudget,
    attemptsAllowed,
    timeoutShare,
    prematureShare,
    errorRate: timeoutShare * 100,
    p99: Math.max(1, (failed ? totalTime : backendLatency) + jitter),
    budgetUsed: Math.min(100, ((failed ? totalTime : backendLatency) / routeTimeout) * 100),
    amplification: 1 + (attemptsAllowed - 1) * timeoutShare,
    source,
    routeHeadroom: routeTimeout - backendLatency,
  };
}

function healthFor(pct: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (pct >= crit) return "crit";
  if (pct >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const errorHealth = healthFor(c.errorRate, 1, 5);
  const cutHealth = healthFor(c.prematureShare * 100, 1, 10);
  const sourceIsRoute = c.source === "route timeout";
  const attemptRps = c.rate * c.amplification;
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
        sublabel: `route ${c.routeTimeout} ms`,
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: c.source === "application deadline" ? cutHealth : errorHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `app deadline ${c.appDeadline} ms`,
        detail: `The application clock is ${c.appDeadline} ms. The proxy per-try clock is ${c.perTryTimeout} ms; the route clock is ${c.routeTimeout} ms.`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Envoy sidecar",
        kind: "mesh",
        health: sourceIsRoute ? "crit" : cutHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: attemptRps,
        sublabel: `cut by ${c.source}`,
        detail: `${c.attemptsAllowed} attempt(s) allowed, each capped at ${c.perAttemptBudget} ms. Total time is capped at ${c.routeTimeout} ms.`,
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Payments service",
        kind: "service",
        health: errorHealth,
        utilization: clamp(c.backendLatency / 3_000),
        throughput: attemptRps,
        sublabel: `${Math.round(c.backendLatency)} ms response`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-edge", "clients", "edge", c.rate / MAX_RATE, errorHealth),
      edge("edge-checkout", "edge", "checkout", c.rate / MAX_RATE, errorHealth),
      edge("checkout-sidecar", "checkout", "sidecar", c.rate / MAX_RATE, errorHealth),
      edge("sidecar-backend", "sidecar", "backend", c.rate / MAX_RATE, errorHealth),
    ],
    metrics: [
      metric("error-rate", "User error rate", c.errorRate, "%", 1, 5, "percent"),
      metric("p99", "End-to-end p99", c.p99, "ms", 500, 1_500, "ms"),
      metric("budget-used", "Route budget used", c.budgetUsed, "%", 80, 95, "percent"),
      metric("premature-cut", "Premature cuts", c.prematureShare * 100, "%", 1, 10, "percent"),
      metric("amplification", "Attempt amplification", c.amplification, "×", 1.5, 2.5, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      source: c.source,
      timeoutShare: c.timeoutShare,
      perAttemptBudget: c.perAttemptBudget,
      route: c.routeTimeout,
    },
    summary: `${Math.round(c.errorRate)}% timed out; ${c.source} is the shortest clock at ${Math.round(c.perAttemptBudget)} ms. Route budget ${c.routeTimeout} ms.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  if (c.errorRate > 0) {
    items.push(`${c.errorRate.toFixed(1)}% of requests end at ${Math.round(c.p99)} ms. The shortest clock is the ${c.source} at ${Math.round(c.perAttemptBudget)} ms, not the route timeout at ${c.routeTimeout} ms.`);
  } else {
    items.push(`No requests are cut. Every attempt finishes within ${Math.round(c.perAttemptBudget)} ms, under the route timeout of ${c.routeTimeout} ms.`);
  }
  if (c.prematureShare > 0) {
    items.push(`The route allows ${c.routeTimeout} ms, but a shorter clock cuts ${(c.prematureShare * 100).toFixed(1)}% of requests. Raising the route timeout will not recover them.`);
  }
  items.push(`Each timed-out request can run ${c.attemptsAllowed} attempts, so backend work is ${c.amplification.toFixed(2)}× the request rate. The route timeout caps the user's total wait.`);
  items.push("Envoy returns 504 when the upstream misses the route timeout. An application can also return its own 504, so the status code alone does not identify which clock fired.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Timeouts are failing user requests",
    cause: "A deadline shorter than the backend response time ends the request before the work completes. The shortest clock wins, whether it is the route timeout, a per-try timeout, or the application deadline.",
    fix: "Compare the three clocks and raise the one that is prematurely short. Keep per-try below route, and make the application deadline consistent with the work the service actually performs.",
    checkFirst: [
      "Which timeout is the smallest for this route?",
      "Does the access log show an upstream timeout response flag, or is the 504 produced by the application?",
      "Did a retry multiply the per-try budget without changing the per-attempt limit?",
    ],
  },
  {
    id: "premature-cut",
    metricId: "premature-cut",
    warn: 1,
    crit: 10,
    title: "Requests are cut while the route still has budget",
    cause: "The per-try or application deadline is shorter than the backend response time, but the route timeout is longer. The request would have completed inside the route budget if the shorter clock had not fired.",
    fix: "Raise the per-try timeout or the application deadline, not the route timeout. Then verify that the total retry budget still fits inside the route and the caller's deadline.",
    checkFirst: [
      "Compare the per-try timeout and the application deadline with the backend's measured response time.",
      "Check whether the application cancels work at its own deadline before the proxy would.",
      "Check whether a retry starts after the successful attempt already exceeded a shorter per-try limit.",
    ],
  },
  {
    id: "budget-used",
    metricId: "budget-used",
    warn: 80,
    crit: 95,
    title: "The route timeout budget is nearly exhausted",
    cause: "Successful responses are arriving close to the route limit, or retries are consuming the budget. There is little room for a slow tail before the proxy returns a 504.",
    fix: "Reduce per-attempt time or retry count if the work fits, or raise the route timeout if the caller's deadline allows it. Do not leave the budget so tight that normal tail latency becomes an error.",
    checkFirst: [
      "Compare the p99 with the route timeout.",
      "Check whether retries are spending the budget on attempts that keep timing out.",
      "Check the caller's own deadline; a longer route timeout is useless if the caller gives up first.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "End-to-end latency is above the user budget",
    cause: "Timeouts are being paid in series. Each attempt runs to its per-try limit, and retries add those waits until the route timeout caps the total.",
    fix: "Fix the shortest clock first, then reduce retries for timeout responses. A retry cannot succeed when every attempt is cut at the same point below the backend's response time.",
    checkFirst: [
      "Compare p99 with the per-try timeout and the number of attempts.",
      "Check whether timeout responses are being retried.",
      "Check the backend's own latency distribution, not just its average.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const timeoutModel: SimModel = {
  id: "mesh-timeouts",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const jitter = frame.t === 0 ? 0 : rng.between(-2, 2);
    const computed = compute(p, jitter);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) recordSeries(next, `load.${node.id}`, (node.utilization ?? 0) * 100);
    if (computed.timeoutShare > 0 && frame.flags.cutSeen !== 1) {
      pushEvent(next, {
        id: "timeout-cut",
        at: frame.t,
        severity: computed.source === "route timeout" ? "crit" : "warn",
        title: `Requests cut by the ${computed.source}`,
        detail: `${(computed.timeoutShare * 100).toFixed(1)}% of requests exceed ${Math.round(computed.perAttemptBudget)} ms. The route timeout is ${computed.routeTimeout} ms.`,
        nodeId: "sidecar",
        metricId: "error-rate",
      });
      next.flags.cutSeen = 1;
    }
    if (computed.prematureShare > 0 && frame.flags.prematureSeen !== 1) {
      pushEvent(next, {
        id: "premature-cut",
        at: frame.t,
        severity: "warn",
        title: "Shorter clock cut a request the route would have allowed",
        detail: `The backend takes ${Math.round(computed.backendLatency)} ms and the route allows ${computed.routeTimeout} ms, but the ${computed.source} fires at ${Math.round(computed.perAttemptBudget)} ms.`,
        nodeId: "checkout",
        metricId: "premature-cut",
      });
      next.flags.prematureSeen = 1;
    }
    next.summary = `${Math.round(computed.errorRate)}% timed out; ${computed.source} is the shortest clock at ${Math.round(computed.perAttemptBudget)} ms. Route budget ${computed.routeTimeout} ms.`;
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
    description: "The backend responds in 250 ms, well inside the per-try, application, and route clocks.",
    tone: "ok",
    params: defaults({ backendLatency: 250, routeTimeout: 2_500, perTryTimeout: 1_000, appDeadline: 1_200, retryAttempts: 2 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Backend time rises to 650 ms. Requests still succeed, but the p99 crosses its warning threshold.",
    tone: "warn",
    params: defaults({ backendLatency: 650, routeTimeout: 1_200, perTryTimeout: 800, appDeadline: 1_000, retryAttempts: 2 }),
  },
  {
    id: "failure",
    label: "Per-try too short",
    description: "The backend needs 1,200 ms, the per-try timeout is 400 ms, and two retries repeat the same cut. The route has budget to spare.",
    tone: "crit",
    params: defaults({ backendLatency: 1_200, routeTimeout: 2_500, perTryTimeout: 400, appDeadline: 900, retryAttempts: 2 }),
  },
  {
    id: "recovery",
    label: "Aligned",
    description: "The backend is fast and every clock has room. Retries remain available for real transient failures.",
    tone: "ok",
    params: defaults({ backendLatency: 250, routeTimeout: 2_500, perTryTimeout: 1_500, appDeadline: 1_500, retryAttempts: 1 }),
  },
  {
    id: "route-short",
    label: "Route too short",
    description: "The route timeout is 500 ms and the backend needs 1,200 ms. The proxy, not the per-try clock, ends every request.",
    tone: "crit",
    params: defaults({ backendLatency: 1_200, routeTimeout: 500, perTryTimeout: 1_000, appDeadline: 1_000, retryAttempts: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-route-raise",
  title: "Predict the route timeout change",
  simId: "timeouts",
  question:
    "The route timeout is 2,000 ms and the backend needs 1,200 ms. A 400 ms per-try timeout cuts each attempt, and two retries repeat the cut. You raise the route timeout to 5,000 ms. What changes?",
  prediction: {
    options: [
      { id: "succeeds", label: "Requests succeed because the route now allows enough time" },
      { id: "same", label: "Nothing: each attempt is still cut at 400 ms, the route budget was not the limiting clock" },
      { id: "faster", label: "Requests fail faster because the route timeout changed" },
      { id: "route", label: "The 504 moves to 5,000 ms, giving the backend time to finish" },
    ],
    correctOptionId: "same",
    explanation:
      "The route timeout bounds the whole request, including retries. It does not extend the time allowed for one attempt. With a 400 ms per-try timeout and a backend that needs 1,200 ms, every attempt is cut at 400 ms. The 2,000 ms route budget was already longer than the three attempts, so raising it to 5,000 ms changes nothing. The user still waits through the same failed attempts and still gets a 504.",
  },
  setup: defaults({ backendLatency: 1_200, routeTimeout: 2_000, perTryTimeout: 400, appDeadline: 900, retryAttempts: 2 }),
  runFor: 20,
  observe: [
    "The p99 sits at the accumulated per-try budget, not at the backend's 1,200 ms response time.",
    "Premature cuts stay high because the route has more budget than the shorter clock.",
    "Raising the route timeout leaves the error rate unchanged.",
    "Attempt amplification stays above 2× while each attempt repeats the same failure.",
  ],
  explain:
    "There are three clocks. The route clock caps total wait, the per-try clock caps one attempt, and the application deadline caps the work inside the service. The smallest one that applies to the current phase wins. Here the per-try clock is 400 ms and the backend needs 1,200 ms, so each attempt is hopeless. The route budget determines how many hopeless attempts fit, not whether one can succeed.",
  fix: defaults({ backendLatency: 1_200, routeTimeout: 2_500, perTryTimeout: 1_500, appDeadline: 1_500, retryAttempts: 1 }),
  debrief:
    "The repair is to align the per-attempt clock with the work: 1,500 ms per try, an application deadline at least as long, and a route budget that covers one attempt plus a bounded retry. Raising the route timeout alone just buys more failed attempts. The same reasoning applies when an application deadline is shorter than the proxy's per-try timeout.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A mesh request can be ended by several independent clocks. The route timeout bounds the entire upstream request, including every retry and its backoff. The per-try timeout bounds one attempt when retries are configured. The application deadline is enforced by the service itself, often from a propagated gRPC deadline. Envoy's route timeout defaults to 15 seconds, but the effective limit is whichever clock is smallest for the phase the request is in.",
  },
  {
    type: "p",
    text: "A 504 is ambiguous. Envoy returns 504 when the upstream does not produce a complete response inside the route timeout. The application can also return its own 504 when its deadline expires. The status code tells you that a deadline fired; it does not tell you which one. You need the proxy configuration, the application setting, and the response flags to attribute the failure.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, edge proxy, service, sidecar, dependency. Each layer may enforce a deadline. If the edge allows 2 seconds, the service allows 1 second, and the dependency needs 1.2 seconds, the service's deadline wins and the dependency's work is discarded. Deadline propagation is the discipline of passing the remaining budget downstream instead of resetting it at every hop.",
  },
  {
    type: "compare",
    leftTitle: "Total request budget",
    rightTitle: "One attempt budget",
    rows: [
      { label: "Configured by", left: "Route timeout", right: "Per-try timeout or application deadline" },
      { label: "Covers", left: "All attempts and backoff", right: "One attempt before response headers" },
      { label: "Raise it when", left: "Normal tail latency exceeds the total budget", right: "Every attempt is cut before the backend can finish" },
      { label: "Risk", left: "Long waits hold connections and retries", right: "Too short turns healthy slow calls into retries" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The shortest clock in the sidecar label: route timeout, per-try timeout, or application deadline.",
      "Premature cuts: requests the route would have allowed but a shorter clock ended.",
      "Route budget used, attempt amplification, error rate, and end-to-end p99.",
      "A flow view of clients, edge proxy, service, sidecar, and backend, with attempt throughput at the backend.",
      "Events that name the clock that cut the request and the event that identifies a premature cut.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Per-try too short. Watch the 504s arrive near 400 ms while the route timeout is 2,000 ms. Raise the route timeout and confirm nothing recovers. Then apply Aligned to see the same backend succeed after the per-attempt clock is fixed.",
  },
  {
    type: "table",
    headers: ["Clock", "What it bounds", "Typical mistake"],
    rows: [
      ["Route timeout", "The whole request, including retries", "Raising it when a shorter clock is the real limit"],
      ["Per-try timeout", "One attempt", "Setting it below the backend's normal response time"],
      ["Application deadline", "The service's own work", "Ignoring a propagated caller deadline"],
      ["Caller deadline", "The user's total wait", "Letting it expire before the route budget is spent"],
    ],
  },
  { type: "sim", simId: "timeouts" },
  { type: "experiment", experimentId: "predict-route-raise" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset the backend needed 1,200 ms, the per-try clock allowed 400 ms, and the route allowed 2,500 ms. Every attempt was cut at 400 ms. Two retries turned one doomed attempt into three, so backend work rose while the user received a 504 after roughly 1,200 ms. The route budget was never the problem, which is why raising it changed nothing.",
  },
  {
    type: "p",
    text: "In the route-short preset the order reversed: the route clock was 500 ms, so retries never got a second attempt and the per-try setting was irrelevant. In the aligned preset the backend fit inside one attempt and the route had room for a retry. The winning clock moved with the configuration, and so did the repair.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy access log response flags. The upstream timeout flag identifies a proxy-generated timeout; a 504 without it came from the upstream application.",
      "Cluster timeout stats, including the request timeout counter and the upstream reset counter for timed-out streams.",
      "The route configuration: route timeout, retry policy, and per-try timeout, plus any virtual host override.",
      "The application's request deadline and cancellation behavior, including whether it propagates a gRPC deadline.",
      "The caller's timeout, because a route budget longer than the caller's patience is not a real budget.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the response flags before reading the status code. Then list every clock on the path and find the smallest. If the route has budget but the request dies earlier, the per-try or application clock is the suspect. If retries are configured, remember that the route timeout includes them.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Attribute the timeout: proxy route timeout, proxy per-try timeout, or application deadline. Do not change anything until you know which clock fired.",
      "Set the per-try timeout above the backend's normal response time, but below the route timeout.",
      "Make the application deadline consistent with the work and propagate the caller's remaining budget.",
      "Keep the route timeout longer than one attempt plus the retries you actually need, and shorter than the caller's deadline.",
      "Do not retry requests that timeout on every attempt. A retry only helps when the next attempt has a different outcome.",
      "Re-measure p99 and the route budget after the change, then verify that timeouts fall without a latency regression.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer deadlines tolerate slow work but hold connections, memory, and retry budget. A 504 is sometimes the correct answer.",
      "Shorter deadlines fail fast but cut healthy tail requests and can create retry traffic that makes the tail worse.",
      "Retries improve success for transient failures and multiply work for deterministic ones. Timeouts are often deterministic.",
      "Per-try timeouts protect the user's total wait, but a per-try budget multiplied by a retry count can exceed the route and surprise everyone.",
      "A deadline propagated from the caller is more honest than a locally reset timer, but it requires every service to honor cancellation.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "attribute-504",
    question:
      "A request returns 504 after 400 ms. The route timeout is 2,000 ms and the backend normally responds in 150 ms. What do you check, and what could explain it?",
    difficulty: 2,
    hints: [
      "The route timeout is not the only clock.",
      "A 504 can come from the proxy or from the application.",
    ],
    answer:
      "I would check the response flags, the per-try timeout, and the application deadline. A 504 at 400 ms with a 2,000 ms route timeout means a shorter clock fired. If the route has a 400 ms per-try timeout, the proxy cut the attempt and may have retried. If the application enforces a 400 ms deadline, it returned its own 504. I would also check whether a retry was attempted and whether the backend saw the request. The status code alone does not distinguish these cases.",
    followUps: [
      "What response flag would prove the proxy cut it?",
      "How would you tell a retry from a first attempt in the logs?",
      "What if the backend logs show a 200 response?",
    ],
    redFlags: [
      "Raises the route timeout first.",
      "Assumes every 504 is generated by Envoy.",
      "Ignores retries.",
    ],
    rubric: [
      "Names the shorter clocks.",
      "Uses response flags or config.",
      "Separates proxy and application 504s.",
      "Checks retry behavior.",
    ],
  },
  {
    id: "budget-math",
    question:
      "How do you set route, per-try, and application timeouts for a service with a 300 ms p99 and a caller that gives up at 2 seconds?",
    difficulty: 3,
    hints: [
      "Start from the caller's budget and work backward.",
      "Leave room for one useful retry, not an unlimited chain.",
    ],
    answer:
      "I would start with the caller's 2 second budget and reserve time for the response and any retry I actually need. The per-try timeout should sit above the 300 ms p99, with headroom for the tail, for example 600 to 800 ms. The application deadline should be at least the per-try budget so the proxy does not cut work the service is still doing. The route timeout should cover the attempts I allow plus backoff, and stay below the caller's 2 seconds. I would verify with a load test that the p99 and timeout rate behave, and I would not add retries to timeout responses unless the next attempt can plausibly succeed.",
    followUps: [
      "What would you set first if you had no latency data?",
      "How does a gRPC deadline change the design?",
      "What happens if the retry count doubles?",
    ],
    redFlags: [
      "Sets all three clocks to the same value.",
      "Uses the average instead of the tail.",
      "Ignores the caller's deadline.",
    ],
    rubric: [
      "Works backward from the caller.",
      "Sets per-try above the tail.",
      "Keeps the route budget bounded.",
      "Accounts for retries.",
    ],
  },
  {
    id: "retry-timeout",
    question:
      "Why can adding retries increase 504s instead of reducing them, and what would you change?",
    difficulty: 3,
    hints: [
      "Each retry gets the same per-try budget.",
      "The route timeout caps the total.",
    ],
    answer:
      "If the backend is slower than the per-try timeout, every attempt is cut at the same point. Retries do not give the backend more time per attempt; they repeat the same failure and consume the route budget. The user waits longer, backend work multiplies, and the final result is still a 504. I would first fix the per-try timeout or the backend latency. Then I would retry only failures that can succeed on a different host or connection, and keep the total attempts inside the route and caller budgets.",
    followUps: [
      "Which failures are worth retrying?",
      "How does a retry budget change the math?",
      "What if only one host is slow?",
    ],
    redFlags: [
      "Adds retries to every 504.",
      "Raises both the per-try and route timeouts without measuring.",
      "Ignores total user wait.",
    ],
    rubric: [
      "Explains the repeated cut.",
      "Separates per-try from route.",
      "Names a selective retry policy.",
      "Bounds total wait.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every route has a documented total budget, per-try budget, and caller deadline.",
      "Per-try timeouts are above the backend's normal tail, not its average.",
      "Applications propagate deadlines and honor cancellation.",
      "Retries are limited to failures that can succeed on another attempt or host.",
      "Dashboards show timeout counts by source and the route budget used.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the access log response flags before changing configuration.",
      "List every clock and identify the smallest one for the failing route.",
      "Check whether retries are repeating a deterministic timeout.",
      "Check the backend's latency and whether it received the request.",
      "Change one clock at a time and watch p99, error rate, and amplification.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Align the per-try and application budgets with the measured backend tail.",
      "Add a test that asserts the route budget covers one attempt plus the allowed retries.",
      "Document which layer owns the deadline and how it is propagated.",
      "Review retry conditions for timeout responses.",
      "Recheck the caller's deadline after any increase to the route budget.",
    ],
  },
];

const references = [
  {
    title: "Envoy: How do I configure timeouts?",
    url: "https://www.envoyproxy.io/docs/envoy/latest/faq/configuration/timeouts",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Route timeout, per-try timeout, stream timeouts, and the default route timeout.",
  },
  {
    title: "Envoy router filter",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/router_filter",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Retry policy, per-try timeout, route timeout interaction, and timeout statistics.",
  },
  {
    title: "Kuma MeshTimeout",
    url: "https://kuma.io/docs/latest/policies/meshtimeout/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Mesh-level timeout policy for inbound and outbound requests, including idle and connect timeouts.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    timeouts: {
      model: timeoutModel,
      presets,
      instructions:
        "Start Healthy, apply Per-try too short, then raise the route timeout and observe that nothing recovers. Apply Aligned to compare.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Backend response time, cut shares, and budget arithmetic are teaching values, not Envoy or Kuma defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-retries", "mesh-retry-storm", "mesh-circuit-breaking", "mesh-mtls"],
};
