import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_RPS = 6_000;

const params = [
  {
    id: "failureRate",
    label: "Upstream failure rate",
    min: 0,
    max: 30,
    step: 1,
    value: 2,
    unit: "%",
    group: "Traffic",
    help: "Share of requests that fail before a successful response. Failures ramp in over the first eight seconds.",
    format: "percent" as const,
  },
  {
    id: "proxyFailureShare",
    label: "Failures ending at the proxy",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Failure location",
    help: "Share of failures that terminate at the proxy before the application handles the request, such as no healthy upstream or a connect failure.",
    format: "percent" as const,
  },
  {
    id: "logSampleRate",
    label: "Access log sample rate",
    min: 1,
    max: 100,
    step: 1,
    value: 100,
    unit: "%",
    group: "Logging",
    help: "Share of requests that produce an access-log line. Sampling saves volume but also drops evidence.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  failureRate: number;
  proxyFail: number;
  appFail: number;
  appGapPer1k: number;
  unloggedPer1k: number;
  durationP99: number;
}

function compute(p: Params, t: number): Computed {
  const ramp = clamp(t / 8);
  const failureRate = clamp(num(p, "failureRate", 2), 0, 30) * ramp;
  const proxyShare = clamp(num(p, "proxyFailureShare", 60), 0, 100) / 100;
  const sample = clamp(num(p, "logSampleRate", 100), 1, 100) / 100;
  const proxyFail = failureRate * proxyShare;
  const appFail = failureRate - proxyFail;
  return {
    failureRate,
    proxyFail,
    appFail,
    appGapPer1k: proxyFail * 10,
    unloggedPer1k: proxyFail * (1 - sample) * 10,
    durationP99: 45 + failureRate * 22,
  };
}

function healthForErrors(value: number): SimState {
  if (value >= 5) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function worst(...states: SimState[]): SimState {
  if (states.includes("crit")) return "crit";
  if (states.includes("warn")) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const proxyHealth = healthForErrors(c.failureRate);
  const appHealth = healthForErrors(c.appFail);
  const logHealth = c.unloggedPer1k >= 20 ? "crit" : c.unloggedPer1k >= 5 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: "ok",
        utilization: 0.4,
        throughput: BASE_RPS,
        sublabel: `${BASE_RPS.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge Envoy",
        kind: "mesh",
        health: proxyHealth,
        utilization: clamp(c.failureRate / 30),
        throughput: BASE_RPS,
        sublabel: "access log listener",
        detail: `Illustrative model: proxy error rate ${c.failureRate.toFixed(1)}%. The listener logs status, flags, upstream host, duration, and request id.`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Checkout sidecar",
        kind: "mesh",
        health: worst(proxyHealth, logHealth),
        utilization: clamp(c.unloggedPer1k / 40),
        throughput: BASE_RPS,
        sublabel: `${c.unloggedPer1k.toFixed(0)} unlogged / 1k`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout app",
        kind: "service",
        health: appHealth,
        utilization: clamp(c.appFail / 10),
        throughput: BASE_RPS,
        sublabel: `${c.appFail.toFixed(1)}% app errors`,
        detail: `The application records ${c.appFail.toFixed(1)}% errors. It never sees the ${c.proxyFail.toFixed(1)}% that failed at the proxy.`,
        meta: { view: "flow" },
      },
      {
        id: "upstream",
        label: "Inventory upstream",
        kind: "service",
        health: proxyHealth,
        utilization: clamp(c.failureRate / 20),
        throughput: BASE_RPS,
        sublabel: "v2 cluster",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-edge", "clients", "edge", 0.7, "ok"),
      edge("edge-sidecar", "edge", "sidecar", 0.7, proxyHealth),
      edge("sidecar-service", "sidecar", "service", 0.7, appHealth),
      edge("service-upstream", "service", "upstream", 0.7, proxyHealth),
    ],
    metrics: [
      metric("proxy-error", "Proxy-observed errors", c.failureRate, "%", 1, 5, "percent"),
      metric("app-error", "Application errors", c.appFail, "%", 1, 5, "percent"),
      metric("app-gap", "Failures missing from app log", c.appGapPer1k, " /1k", 10, 30, "count"),
      metric("unlogged", "Failures with no log anywhere", c.unloggedPer1k, " /1k", 5, 20, "count"),
      metric("p99", "Proxy request p99", c.durationP99, "ms", 250, 500, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      proxyFail: c.proxyFail,
      appFail: c.appFail,
      appGap: c.appGapPer1k,
      unlogged: c.unloggedPer1k,
    },
    summary: `${c.failureRate.toFixed(1)}% proxy errors, ${c.appFail.toFixed(1)}% app errors. ${c.appGapPer1k.toFixed(0)} failures per 1,000 have no application log; ${c.unloggedPer1k.toFixed(0)} have no log at all.`,
  };
}

function insightsFor(c: Computed, p: Params): string[] {
  const sample = num(p, "logSampleRate", 100);
  const items: string[] = [];
  items.push(`The proxy sees ${c.failureRate.toFixed(1)}% failures; the application logs ${c.appFail.toFixed(1)}%. The difference is ${c.proxyFail.toFixed(1)}% of requests that never reached application code.`);
  items.push(`Per 1,000 requests, ${c.appGapPer1k.toFixed(0)} failures are missing from the application log. At a ${sample}% access-log sample, ${c.unloggedPer1k.toFixed(0)} have no log anywhere.`);
  items.push("The status code is the proxy's final response. The upstream host shows which endpoint was selected. Duration includes connect, queue, and upstream time at the proxy.");
  items.push("Response flags explain failures that a status code alone cannot: UF is an upstream connection failure, UH is no healthy upstream, NR is no route, and UT is an upstream request timeout.");
  items.push("`x-request-id` is the join key. If the application records the same header, one id takes you from the access line to the application event and the trace.");
  items.push("Sampling the listener is a volume control, not a correctness requirement. Keep an unsampled error path or a separate error log if you sample routine successes.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "proxy-error",
    metricId: "proxy-error",
    warn: 1,
    crit: 5,
    title: "The proxy is returning errors",
    cause: "The proxy response code covers failures at every layer below it, including requests that never reached the application. The application error rate can look lower or zero.",
    fix: "Use the status, flags, and upstream host to locate the failing layer. Confirm whether the request reached the application before changing application code.",
    checkFirst: [
      "Read the response flag next to the status code.",
      "Check the upstream host and cluster for the failing requests.",
      "Compare the proxy error rate with the application error rate for the same window.",
    ],
  },
  {
    id: "app-error",
    metricId: "app-error",
    warn: 1,
    crit: 5,
    title: "Application-visible errors are above the SLO",
    cause: "These are requests the application handled and marked as failures. They are a subset of proxy errors, not the whole set.",
    fix: "Correlate the application log with the proxy request id. If the app error is lower than the proxy error, the missing requests failed before application code.",
    checkFirst: [
      "Compare application and proxy error rates for the same route.",
      "Check whether the app log includes the request id.",
      "Check whether the proxy status and app status agree for the same request.",
    ],
  },
  {
    id: "app-gap",
    metricId: "app-gap",
    warn: 10,
    crit: 30,
    title: "Failures are missing from the application log",
    cause: "The request failed at the proxy, for example because no healthy upstream existed or the connection was refused. The application never ran, so it had nothing to log.",
    fix: "Use proxy access logs as the source of truth for the request path. Add a proxy-level error dashboard and alert on flags rather than waiting for application errors.",
    checkFirst: [
      "Check for UF, UH, NR, or UT flags on the failing requests.",
      "Check whether the upstream host is empty or points at an unhealthy endpoint.",
      "Check whether the route matched at all.",
    ],
  },
  {
    id: "unlogged",
    metricId: "unlogged",
    warn: 5,
    crit: 20,
    title: "Some failures have no log anywhere",
    cause: "The access log is sampled, so a fraction of requests never produce a line. A low sample rate can drop the exact failures you need, especially for rare errors.",
    fix: "Raise the sample rate or log all error responses while sampling only successes. Keep the request id on every logged request.",
    checkFirst: [
      "Check the configured access-log sampling percentage.",
      "Check whether a status filter drops 5xx lines.",
      "Check the collector or agent for dropped batches.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 250,
    crit: 500,
    title: "Proxy request duration breached the latency budget",
    cause: "Duration at the proxy includes connection setup, queueing, and the upstream response. A fast failure can look cheap while a timeout looks expensive.",
    fix: "Compare duration with the response flag. A long UT is an upstream timeout; a short UF is a refused or failed connection.",
    checkFirst: [
      "Separate success and failure durations.",
      "Check upstream connect time and queue time.",
      "Check whether retries are included in the final duration.",
    ],
  },
];

function logEvent(c: Computed, t: number, rng: { between: (min: number, max: number) => number }): { id: string; severity: "info" | "warn"; title: string; detail: string } {
  const failed = c.failureRate >= 0.5;
  const status = failed ? (c.proxyFail > c.appFail ? 503 : 500) : 200;
  const flags = status === 200 ? "-" : c.proxyFail > c.appFail ? "UF" : "-";
  const upstream = status === 200 ? "inventory-v1 10.0.2.14:8080" : "inventory-v2 10.0.3.17:8080";
  const duration = status === 200 ? 45 : flags === "UF" ? 3 : 120;
  const requestId = `6f1c${Math.round(rng.between(1000, 9999))}`;
  return {
    id: `access-log-${Math.floor(t / 4)}`,
    severity: failed ? "warn" : "info",
    title: `${status} ${flags === "-" ? "" : `${flags} `}· ${upstream.split(" ")[0]}`,
    detail: `GET /checkout ${status} ${flags} upstream=${upstream} duration=${duration}ms x-request-id=${requestId}`,
  };
}

export const meshAccessLogsModel: SimModel = {
  id: "mesh-access-logs",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults(), 0), seed),
  step: (frame, p, dt, rng) => {
    const t = frame.t + dt;
    const c = compute(p, t);
    const next = buildFrame(c, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    const bucket = Math.floor(t / 4);
    if (Number(frame.flags.logBucket ?? -1) !== bucket) {
      const sample = clamp(num(p, "logSampleRate", 100), 1, 100) / 100;
      if (rng.next() <= sample) {
        const event = logEvent(c, t, rng);
        pushEvent(next, { ...event, at: frame.t }, 1);
      }
      next.flags.logBucket = bucket;
    }
    if (c.proxyFail >= 5 && frame.flags.proxyGapSeen !== 1) {
      pushEvent(next, {
        id: "proxy-only-failure",
        at: frame.t,
        severity: "crit",
        title: "Failures exist only at the proxy",
        detail: `${c.proxyFail.toFixed(1)}% of requests failed before the application handled them. The application log cannot explain them; the access log can.`,
        nodeId: "sidecar",
        metricId: "app-gap",
      });
      next.flags.proxyGapSeen = 1;
    }
    if (c.unloggedPer1k >= 20 && frame.flags.unloggedSeen !== 1) {
      pushEvent(next, {
        id: "access-log-sampled-out",
        at: frame.t,
        severity: "warn",
        title: "Sampling is hiding failures",
        detail: `${c.unloggedPer1k.toFixed(0)} failures per 1,000 have no log at all. The access-log sample rate is dropping evidence.`,
        nodeId: "edge",
        metricId: "unlogged",
      });
      next.flags.unloggedSeen = 1;
    }
    next.summary = `${c.failureRate.toFixed(1)}% proxy errors, ${c.appFail.toFixed(1)}% app errors. ${c.appGapPer1k.toFixed(0)} failures per 1,000 have no application log; ${c.unloggedPer1k.toFixed(0)} have no log at all.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => insightsFor(compute(p, frame.t), p),
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A small number of failures, most of them application-visible, with full access-log coverage.",
    tone: "ok",
    params: defaults({ failureRate: 0.5, proxyFailureShare: 20, logSampleRate: 100 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Three percent failures split between proxy and application. The app log undercounts the incident.",
    tone: "warn",
    params: defaults({ failureRate: 3, proxyFailureShare: 50, logSampleRate: 100 }),
  },
  {
    id: "failure",
    label: "Proxy-only failures",
    description: "Most failures never reach the app, and half the access logs are sampled away.",
    tone: "crit",
    params: defaults({ failureRate: 10, proxyFailureShare: 80, logSampleRate: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The upstream recovers and full access-log coverage is restored. Proxy and app error rates agree again.",
    tone: "ok",
    params: defaults({ failureRate: 0.4, proxyFailureShare: 10, logSampleRate: 100 }),
  },
];

const experiment: Experiment = {
  id: "find-failure-in-proxy-log",
  title: "The request that never reached the app",
  simId: "mesh-access-logs",
  question:
    "Users report 503s from checkout. The application log shows no errors for the window. The mesh access log shows 503 responses with the UF flag, a duration of 3ms, and an upstream host in the v2 cluster. Where did the request fail?",
  prediction: {
    options: [
      { id: "handler", label: "In the checkout handler; the application failed to log its own exception" },
      { id: "connect", label: "Before the application: the proxy could not connect to the selected upstream" },
      { id: "client", label: "At the client, because the client canceled before the proxy responded" },
      { id: "auth", label: "In mTLS certificate validation at the ingress gateway" },
    ],
    correctOptionId: "connect",
    explanation:
      "UF means upstream connection failure. Envoy selected an endpoint, could not connect, and failed before application code ran.",
  },
  setup: defaults({ failureRate: 12, proxyFailureShare: 90, logSampleRate: 100 }),
  runFor: 30,
  observe: [
    "The proxy error rate reaches 12% while the application error rate stays near 1%.",
    "Failures missing from the application log reach 108 per 1,000 requests.",
    "The access-log lines show 503 UF with a 3ms duration and the v2 upstream host.",
    "The sidecar and the application disagree about whether the request existed.",
  ],
  explain:
    "UF means upstream connection failure. Envoy selected an upstream endpoint, tried to connect, and failed before the request reached the application. The 3ms duration is too short for application work. The application never ran, so its log has no line and its error counter stays low. The access log is the only place the failure exists.",
  fix: defaults({ failureRate: 0.5, proxyFailureShare: 20, logSampleRate: 100 }),
  debrief:
    "Use the proxy access log as the request-path source of truth. Read the status and flag together, then the upstream host and duration. A UF with a short duration points at connect failure; a UT with a long duration points at an upstream timeout; UH means the cluster had no healthy endpoint. Correlate x-request-id when the application did run.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A mesh access log is a record written by the proxy for each request it handles. Envoy access logs can include the response code, response flags, upstream host, duration, bytes, protocol, and request id. The log is written at the proxy, so it exists even when the request never reaches application code. That is the difference that matters during an incident: the application can only log requests it received.",
  },
  {
    type: "p",
    text: "Kuma configures access logging with a MeshAccessLog policy, and Envoy writes the records from the data-plane listener. The format is a set of command operators such as %RESPONSE_CODE%, %RESPONSE_FLAGS%, %UPSTREAM_HOST%, %DURATION%, and %REQ(X-REQUEST-ID)%. A log line is only useful if the fields answer where the request failed, which upstream it chose, and how long it waited.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, edge or ingress proxy, service sidecar, application, upstream. The access log is emitted by the proxy that handled the request. A failure at connect, route match, or upstream selection is visible at the proxy and invisible to the application. A failure inside the handler is visible in both places, but the status and timing can still differ.",
  },
  {
    type: "compare",
    leftTitle: "Application log",
    rightTitle: "Proxy access log",
    rows: [
      { label: "Coverage", left: "Only requests the app received", right: "Every request the proxy handled" },
      { label: "Status", left: "The app's own result", right: "The proxy's final response to the caller" },
      { label: "Timing", left: "Handler time", right: "Connect, queue, upstream, and response time" },
      { label: "Best for", left: "Business errors and stack traces", right: "Routing, connectivity, timeouts, and flags" },
    ],
  },
  {
    type: "p",
    text: "Response flags are short codes that describe how a request ended. UF is an upstream connection failure, UH means no healthy upstream, NR means no route, UT means an upstream request timeout, and URX means the retry limit was exceeded. A 503 with UF is a different incident from a 503 with UH; the status alone does not distinguish them.",
  },
  {
    type: "p",
    text: "Sampling is a volume decision. Logging every success at high request rates is expensive, so many teams sample. Sampling errors too is dangerous: a 1% sample of a 0.1% failure can produce almost no evidence. A common pattern is to log all error responses and sample successes, or to keep an independent error log with the same request id.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A proxy error rate and an application error rate that can disagree by design.",
      "Failures missing from the application log, normalized per 1,000 requests.",
      "Failures with no log anywhere when access-log sampling drops them.",
      "A stream of access-log lines with status, flags, upstream host, duration, and request id.",
      "Proxy p99 duration with thresholds for the latency budget.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Proxy-only failures. Compare the proxy and application error rates before reading the log stream. Raise the sample rate and watch the no-log-anywhere metric fall. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "table",
    headers: ["Field", "Question it answers", "Common trap"],
    rows: [
      ["Response code", "What did the caller receive?", "A 503 can come from several layers"],
      ["Response flags", "How did the request end?", "Ignoring flags hides connect and route failures"],
      ["Upstream host", "Which endpoint was selected?", "An empty host means no endpoint was chosen"],
      ["Duration", "Where did time go?", "Fast failures can look harmless"],
      ["Request id", "Which app event matches?", "The app must log the same id"],
    ],
  },
  { type: "sim", simId: "mesh-access-logs" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The upstream started failing, and most of the failures ended at the proxy before the application handled the request. The proxy error rate rose to 10% while the application logged 2%. Eight percent of requests left no application line at all. At a 50% access-log sample, half of those proxy failures also disappeared, leaving 40 failures per 1,000 with no record anywhere.",
  },
  {
    type: "p",
    text: "The access-log lines gave the missing context: 503, UF, a v2 upstream host, and a 3ms duration. The request was routed correctly and then failed to connect. The application was not slow or broken; it was never called. The status alone would have sent you to the handler. The flag and duration sent you to the upstream and the connection.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Access-log fields: %RESPONSE_CODE%, %RESPONSE_FLAGS%, %UPSTREAM_HOST%, %DURATION%, %BYTES_RECEIVED%, and %REQ(X-REQUEST-ID)%.",
      "A gap between proxy error rate and application error rate for the same route and window.",
      "Response flags such as UF, UH, NR, UT, and URX on the failing lines.",
      "Collector or agent metrics for access-log drops and buffer overflows.",
      "An application log that can be joined on x-request-id when the request reached the app.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Filter the access log to the failing status and read the flag before changing code. Check the upstream host and duration on the same line. Then compare the proxy and application error rates for the same route. If the application has no line, the request never reached it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the failing layer from the flag and upstream host, not from the status alone.",
      "Restore the upstream or route: check endpoint health, readiness, and cluster membership.",
      "Keep error responses logged at 100% while sampling successes if volume is a problem.",
      "Raise the access-log sample rate temporarily during the incident and restore it afterward.",
      "Correlate x-request-id with the application and the trace to confirm where the request stopped.",
      "Add an alert on proxy error rate and on failures missing from the application log.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Full access logging is expensive at high request rates. Sampling saves cost and can hide rare failures.",
      "Logging at the proxy duplicates data the application may already emit. The duplication is useful when the app never runs.",
      "More fields per line improve diagnosis and increase storage and cardinality.",
      "A separate error log keeps evidence but adds another pipeline to operate.",
      "Proxy status is not the user's status if a later layer changes the response; correlate end to end.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "no-app-log",
    question:
      "A user reports a failed checkout. The application has no log line, and the mesh access log shows 503 UF. What happened, and what do you check next?",
    difficulty: 2,
    hints: [
      "UF is a response flag, not a status.",
      "The application cannot log a request it never received.",
    ],
    answer:
      "UF means the proxy could not establish an upstream connection. The request reached the proxy, a route selected an upstream endpoint, and the connection failed before the application handled it. I would check the upstream host and port in the same line, the cluster's endpoint health, and whether the endpoint was recently removed or restarted. A short duration supports connect failure rather than an application timeout. I would also check whether the same failure appears across all pods or one endpoint.",
    followUps: [
      "How would UH differ from UF?",
      "What would a 30-second duration suggest?",
      "How would you find the matching trace?",
    ],
    redFlags: [
      "Starts debugging application code.",
      "Treats 503 as a single failure mode.",
      "Ignores the upstream host.",
    ],
    rubric: [
      "Explains UF as connect failure.",
      "Locates the request before the app.",
      "Checks endpoint health.",
      "Uses duration as corroboration.",
    ],
  },
  {
    id: "sampling",
    question:
      "Your access log is sampled at 1% to control cost. An incident has a 0.2% error rate. What is the risk, and how would you change the policy?",
    difficulty: 3,
    hints: [
      "Compute the expected error lines.",
      "Sampling successes and failures the same way is the problem.",
    ],
    answer:
      "At 1% sampling and a 0.2% error rate, only about two error lines appear per 100,000 requests. The sample is too small to characterize the failure and may miss it entirely. I would keep 100% of error responses, or use a status-based filter, and sample successes. I would also keep the request id and enough fields to join the error line to the application and trace. If the proxy cannot filter cheaply, I would raise the sample rate temporarily during the incident.",
    followUps: [
      "How would you test that the filter works?",
      "What fields would you keep on a sampled success line?",
      "How does sampling interact with rate limits?",
    ],
    redFlags: [
      "Samples all responses uniformly.",
      "Assumes a low error rate will still appear.",
      "Drops the request id.",
    ],
    rubric: [
      "Computes expected error lines.",
      "Separates error and success sampling.",
      "Keeps correlation fields.",
      "Names a verification step.",
    ],
  },
  {
    id: "status-conflict",
    question:
      "The mesh access log says 200 for a request, but the user saw an error. How can both be true, and what do you check?",
    difficulty: 3,
    hints: [
      "The proxy status is the response at that hop.",
      "Errors can happen after the response or at another layer.",
    ],
    answer:
      "The proxy status describes the response it sent or received at that hop, not necessarily what the user experienced. A client can time out after the proxy logged 200, a later gateway can rewrite the response, or an error can occur in a streaming body after the headers. I would check the full path, the client-side status, the request id, and the timing. I would also check whether the access log line came from the ingress or the sidecar; they can disagree.",
    followUps: [
      "Which access log would you trust for the user status?",
      "How do retries affect the final logged status?",
      "What if the response body failed after a 200 header?",
    ],
    redFlags: [
      "Assumes one proxy log is the user's view.",
      "Ignores retries and response rewriting.",
      "Does not check the client.",
    ],
    rubric: [
      "Distinguishes hop status from user status.",
      "Names a later-layer or client cause.",
      "Uses request id and timing.",
      "Checks which proxy emitted the line.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Define the access-log fields: status, flags, upstream, duration, bytes, and request id.",
      "Log all error responses; sample successes only if volume requires it.",
      "Send access logs to a queryable store with a retention window that covers incidents.",
      "Teach the on-call rotation the common response flags.",
      "Verify the application logs the same request id the proxy records.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Filter by status and read the flag next to it.",
      "Check upstream host and duration on the failing lines.",
      "Compare proxy and application error rates for the same route.",
      "Raise the sample rate if failures are being dropped.",
      "Correlate the request id with the trace and application event.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add an alert on proxy errors and on failures missing from application logs.",
      "Review whether the sample rate was adequate for the observed error rate.",
      "Document the flag-to-cause mapping used during the incident.",
      "Check collector drops and retention against the incident window.",
      "Remove temporary logging changes and keep the error path unsampled.",
    ],
  },
];

const references = [
  {
    title: "Envoy access log command operators",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/observability/access_log/usage",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Response code, flags, upstream host, duration, and request id operators.",
  },
  {
    title: "Envoy response flags",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/observability/access_log/usage#config-access-log-format-response-flags",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Meaning of UF, UH, NR, UT, URX, and the other response flags.",
  },
  {
    title: "Kuma MeshAccessLog",
    url: "https://kuma.io/docs/latest/policies/meshaccesslog/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Access-log policy for mesh data-plane proxies.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mesh-access-logs": {
      model: meshAccessLogsModel,
      presets,
      instructions:
        "Start Healthy, then apply Proxy-only failures. Compare proxy and application error rates before reading the log stream. Raise the sample rate and watch the no-log-anywhere metric.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Request rate, failure split, and duration are teaching values, not measured Envoy behavior.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-envoy-routes", "observability-structured-logging", "observability-distributed-tracing", "mesh-tracing", "mesh-ingress"],
};
