import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "injectPercent",
    label: "Application injects context",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Context",
    help: "Share of application requests that create a trace context and send traceparent or equivalent headers.",
    format: "percent" as const,
  },
  {
    id: "proxyTracingPercent",
    label: "Proxies generating spans",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Proxy",
    help: "Share of sidecars configured to generate proxy spans. A proxy can forward headers without creating a span.",
    format: "percent" as const,
  },
  {
    id: "forwardPercent",
    label: "Upstream forwards context",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Context",
    help: "Share of upstream services that extract the incoming context and continue the same trace for their outbound calls.",
    format: "percent" as const,
  },
  {
    id: "samplePercent",
    label: "Head sampling rate",
    min: 1,
    max: 100,
    step: 1,
    value: 20,
    unit: "%",
    group: "Sampling",
    help: "Share of new traces recorded. Sampling decides whether a trace exists, not whether its spans are connected.",
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
  continuity: number;
  broken: number;
  missingProxy: number;
  unsampled: number;
  spansVisible: number;
  traceDuration: number;
  contextMissing: boolean;
  proxyMissing: boolean;
}

function compute(p: Params): Computed {
  const inject = clamp(num(p, "injectPercent", 100), 0, 100);
  const proxy = clamp(num(p, "proxyTracingPercent", 100), 0, 100);
  const forward = clamp(num(p, "forwardPercent", 100), 0, 100);
  const sample = clamp(num(p, "samplePercent", 20), 1, 100);
  const continuity = (inject * forward) / 100;
  const broken = 100 - continuity;
  const contextMissing = continuity < 99.5;
  const proxyMissing = proxy < 99.5;
  const baseSpans = 2 + (proxy / 100) * 2;
  return {
    continuity,
    broken,
    missingProxy: 100 - proxy,
    unsampled: 100 - sample,
    spansVisible: Math.max(1, Math.round(contextMissing ? baseSpans : baseSpans + 2)),
    traceDuration: 180 + broken * 1.2,
    contextMissing,
    proxyMissing,
  };
}

function span(start: number, duration: number, depth: number, kind: string, extra: Partial<SimNode["span"]> = {}): SimNode["span"] {
  return { start, duration, depth, kind, ...extra };
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const paymentMissing = c.contextMissing;
  const proxySpanHealth: SimState = c.proxyMissing ? "down" : "ok";
  const paymentHealth: SimState = paymentMissing ? "down" : "ok";
  const scale = c.traceDuration / 180;
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Client request",
      kind: "client",
      health: "ok",
      span: span(0, 180 * scale, 0, "client"),
      meta: { view: "trace" },
    },
    {
      id: "ingress",
      label: "Ingress Envoy",
      kind: "mesh",
      health: "ok",
      span: span(2 * scale, 176 * scale, 1, "proxy", { self: 2 * scale, critical: true }),
      meta: { view: "trace" },
    },
    {
      id: "checkout",
      label: "checkout (app)",
      kind: "service",
      health: "ok",
      span: span(6 * scale, 150 * scale, 2, "server", { self: 50 * scale, critical: true }),
      meta: { view: "trace" },
    },
    {
      id: "checkout-proxy",
      label: "checkout sidecar",
      kind: "mesh",
      health: proxySpanHealth,
      span: span(58 * scale, 96 * scale, 3, "proxy", { self: 4 * scale, missing: c.proxyMissing }),
      detail: c.proxyMissing
        ? `Illustrative sample: ${c.missingProxy.toFixed(0)}% of proxies emit no span, so this hop is absent.`
        : "The sidecar recorded the proxy hop for this request.",
      meta: { view: "trace" },
    },
    {
      id: "payment",
      label: "payment (app)",
      kind: "service",
      health: paymentHealth,
      span: span(62 * scale, 88 * scale, 4, "server", { self: 60 * scale, critical: !paymentMissing, missing: paymentMissing }),
      detail: paymentMissing
        ? `Illustrative sample: ${c.broken.toFixed(0)}% of calls lose context, so payment belongs to another trace.`
        : "Payment continued the same trace.",
      meta: { view: "trace" },
    },
    {
      id: "payment-proxy",
      label: "payment sidecar",
      kind: "mesh",
      health: paymentMissing || c.proxyMissing ? "down" : "ok",
      span: span(66 * scale, 80 * scale, 5, "proxy", { self: 4 * scale, missing: paymentMissing || c.proxyMissing }),
      meta: { view: "trace" },
    },
  ];
  return {
    t: 0,
    nodes,
    edges: [],
    metrics: [
      metric("broken-traces", "Broken trace context", c.broken, "%", 5, 20, "percent"),
      metric("missing-proxy", "Missing proxy spans", c.missingProxy, "%", 5, 20, "percent"),
      metric("unsampled", "Traces not sampled", c.unsampled, "%", 95, 99, "percent"),
      metric("spans-visible", "Spans in sample trace", c.spansVisible, "", undefined, undefined, "count"),
      metric("trace-duration", "Sample trace duration", c.traceDuration, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      continuity: c.continuity,
      context: c.contextMissing ? "broken" : "continuous",
      proxy: c.proxyMissing ? "missing" : "present",
    },
    summary: `${c.continuity.toFixed(0)}% of spans share one trace; ${c.missingProxy.toFixed(0)}% of proxy spans are missing. ${c.unsampled.toFixed(0)}% of traces are not sampled.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  items.push(`Trace continuity is injection times forwarding: ${c.continuity.toFixed(1)}%. The other ${c.broken.toFixed(1)}% start a new root when a service fails to extract the incoming context.`);
  items.push(`Proxy span coverage is ${(100 - c.missingProxy).toFixed(0)}%. A sidecar can forward headers correctly and still produce no span if tracing is not configured on its listener.`);
  items.push(`Head sampling records ${(100 - c.unsampled).toFixed(0)}% of new traces. Missing traces and disconnected spans are different failures: one loses the whole request, the other splits it in two.`);
  items.push("A trace that ends at an application server span usually points at a missing traceparent on the outbound call, or at a proxy that did not forward the context headers.");
  items.push("If application spans are connected but proxy spans are absent, check the tracing configuration on the connection manager, not the application instrumentation.");
  items.push("Sampling decisions propagate. If the ingress marks a trace as not sampled, a correct downstream proxy will honor that and not export spans even though it generated them.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "broken-traces",
    metricId: "broken-traces",
    warn: 5,
    crit: 20,
    title: "Trace context is broken across services",
    cause: "A caller did not inject context or a receiver did not extract and continue it. The upstream work appears in a separate trace with a new root span.",
    fix: "Verify the outbound request carries traceparent or the configured propagation headers, and verify the receiver extracts them before creating a new span.",
    checkFirst: [
      "Compare the trace id at the caller and at the upstream service.",
      "Check for a new root span on the upstream side.",
      "Check header allowlists and proxies that strip unknown headers.",
    ],
  },
  {
    id: "missing-proxy",
    metricId: "missing-proxy",
    warn: 5,
    crit: 20,
    title: "Proxy spans are missing from the trace",
    cause: "Tracing is not enabled on the sidecar listener, the proxy is not sampling, or the collector is dropping spans. Application context can still be continuous.",
    fix: "Enable tracing on the proxy's HTTP connection manager and confirm the tracer provider and cluster are configured. Then verify spans arrive at the collector.",
    checkFirst: [
      "Check the trace for app spans with no proxy span between them.",
      "Check the proxy bootstrap and listener tracing configuration.",
      "Check the collector's accepted and refused span counters.",
    ],
  },
  {
    id: "unsampled",
    metricId: "unsampled",
    warn: 95,
    crit: 99,
    title: "Sampling is too low for incident visibility",
    cause: "Head sampling keeps a small share of traces. Rare errors can be absent even when continuity and proxy spans are correct.",
    fix: "Use tail sampling for errors and slow requests, or raise the head sample rate during an incident. Sampling is a cost control, not a correctness control.",
    checkFirst: [
      "Check whether the sampled flag is honored across services.",
      "Check whether errors are sampled at a different rate.",
      "Check the collector's sampling policy.",
    ],
  },
];

export const meshTracingModel: SimModel = {
  id: "mesh-tracing",
  visual: "trace",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const c = compute(p);
    const jittered = { ...c, traceDuration: Math.max(1, c.traceDuration + rng.between(-2, 2)) };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (c.broken >= 20 && frame.flags.brokenSeen !== 1) {
      pushEvent(next, {
        id: "trace-context-broken",
        at: frame.t,
        severity: "crit",
        title: "Upstream call started a new trace",
        detail: `${c.broken.toFixed(0)}% of calls lose context. The payment span is absent from the checkout trace and appears under a different trace id.`,
        nodeId: "payment",
        metricId: "broken-traces",
      });
      next.flags.brokenSeen = 1;
    }
    if (c.missingProxy >= 50 && frame.flags.proxySeen !== 1) {
      pushEvent(next, {
        id: "proxy-spans-missing",
        at: frame.t,
        severity: "warn",
        title: "Sidecar spans are not being generated",
        detail: `${c.missingProxy.toFixed(0)}% of proxy spans are missing. The application trace continues, but the time spent in the proxy and the upstream hop is invisible.`,
        nodeId: "checkout-proxy",
        metricId: "missing-proxy",
      });
      next.flags.proxySeen = 1;
    }
    if (c.unsampled >= 99 && frame.flags.sampleSeen !== 1) {
      pushEvent(next, {
        id: "trace-sampling-hides",
        at: frame.t,
        severity: "warn",
        title: "One percent sampling hides most traces",
        detail: "Continuity can be perfect and still yield almost no trace for a rare error. Add tail sampling for failures.",
        metricId: "unsampled",
      });
      next.flags.sampleSeen = 1;
    }
    next.summary = `${c.continuity.toFixed(0)}% of spans share one trace; ${c.missingProxy.toFixed(0)}% of proxy spans are missing. ${c.unsampled.toFixed(0)}% of traces are not sampled. ${paymentNote(c)}`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => insightsFor(compute(p)),
  legend: [
    { label: "Continuous", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Disconnected", tone: "crit" },
    { label: "Span missing", tone: "down" },
  ],
};

function paymentNote(c: Computed): string {
  return c.contextMissing ? "The payment spans are in another trace." : "The payment call is on the same trace.";
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Full injection, proxy spans, and forwarding at a 20% head sample. The waterfall is complete.",
    tone: "ok",
    params: defaults({ injectPercent: 100, proxyTracingPercent: 100, forwardPercent: 100, samplePercent: 20 }),
  },
  {
    id: "peak",
    label: "Degraded",
    description: "A few services skip header forwarding and some proxies lack tracing. The trace is split and incomplete.",
    tone: "warn",
    params: defaults({ injectPercent: 95, proxyTracingPercent: 95, forwardPercent: 90, samplePercent: 5 }),
  },
  {
    id: "failure",
    label: "Disconnected",
    description: "Half the callers inject, half the receivers forward, most proxies lack spans, and one percent is sampled.",
    tone: "crit",
    params: defaults({ injectPercent: 50, proxyTracingPercent: 40, forwardPercent: 50, samplePercent: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Instrumentation is corrected and sampling is raised. One trace covers client, proxies, and both services.",
    tone: "ok",
    params: defaults({ injectPercent: 100, proxyTracingPercent: 100, forwardPercent: 100, samplePercent: 25 }),
  },
];

const experiment: Experiment = {
  id: "trace-stops-at-checkout",
  title: "The trace that stops at checkout",
  simId: "mesh-tracing",
  question:
    "A trace contains the client, ingress proxy, and checkout server spans. It has no checkout sidecar span and no payment span. The head sample rate is 100%. Which two settings do you inspect first?",
  prediction: {
    options: [
      { id: "sampling", label: "The sampling rate and the collector retention policy" },
      { id: "proxy-context", label: "Proxy span generation on the sidecar and context forwarding from checkout" },
      { id: "clock", label: "Clock skew between checkout and payment" },
      { id: "db", label: "The payment database latency and its connection pool" },
    ],
    correctOptionId: "proxy-context",
    explanation:
      "Sampling is already 100%, so the trace was recorded. The missing sidecar span means the proxy is not generating spans, and the missing payment span means context did not cross the checkout boundary.",
  },
  setup: defaults({ injectPercent: 100, proxyTracingPercent: 0, forwardPercent: 0, samplePercent: 100 }),
  runFor: 20,
  observe: [
    "The checkout server span ends without a sidecar child span.",
    "The payment application has no parent span in this trace.",
    "Continuity is 0% even though the sample rate is 100%.",
    "Two independent failures appear: missing proxy spans and broken context.",
  ],
  explain:
    "Sampling is already 100%, so the trace was recorded. The missing sidecar span means the proxy is not generating spans. The missing payment span means checkout did not forward the context, or payment did not extract it, so payment started a new root. These are separate controls: proxy tracing decides whether proxy spans exist; propagation decides whether they join the same trace.",
  fix: defaults({ injectPercent: 100, proxyTracingPercent: 100, forwardPercent: 100, samplePercent: 20 }),
  debrief:
    "Diagnose a mesh trace in two directions. Downward: does each proxy emit a span for the hop it handled? Upward: does each caller pass context and each receiver continue it? A gap between two application spans with no proxy span is a proxy configuration problem. An upstream application span in a different trace is a propagation problem. Fix both before tuning sampling.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A distributed trace is a tree of spans that share one trace id. In a mesh, the sidecar proxy can create its own span for the time a request spends at the proxy and can forward the context headers to the next service. The application creates the server span and any outbound client spans. A complete mesh trace stitches those pieces together, so you can see proxy queueing and upstream time alongside application work.",
  },
  {
    type: "p",
    text: "Two independent mechanisms have to work. Context propagation carries the trace id, parent span id, and sampling decision across process boundaries, usually in traceparent and tracestate headers. Proxy span generation makes the proxy an instrumentation point. If either is missing, the waterfall has a hole: the proxy time disappears, or the upstream service appears in a different trace.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ingress proxy, checkout application, checkout sidecar, payment application, payment sidecar. Envoy creates spans when tracing is configured on the HTTP connection manager and a tracer provider is available. Kuma can configure tracing for the mesh data plane. The application must inject the outbound context and extract the inbound context; a proxy that forwards headers does not fix an application that creates a new root.",
  },
  {
    type: "compare",
    leftTitle: "App-only tracing",
    rightTitle: "Mesh tracing",
    rows: [
      { label: "Scope", left: "Application code and explicit calls", right: "Application plus every proxy hop" },
      { label: "Blind spot", left: "Proxy queueing, retries, connect time", right: "None, if proxy spans are enabled" },
      { label: "Setup", left: "SDK in each service", right: "SDK plus proxy tracing and header forwarding" },
      { label: "Failure mode", left: "Missing app instrumentation", right: "Disconnected spans or missing proxy spans" },
    ],
  },
  {
    type: "p",
    text: "Sampling is a separate decision. Head sampling decides at the start of a trace whether to record it; tail sampling decides after seeing the whole trace, which lets you keep errors and slow requests. A head sample of 1% can be perfectly continuous and still provide almost no evidence during a rare incident. Sampling does not cause disconnected spans; it causes absent traces.",
  },
  {
    type: "p",
    text: "Envoy's tracing integration follows the configured propagation format and can generate spans for the request, the upstream call, and the router. The exact span names and tags depend on the tracer and configuration. The model here uses six illustrative spans and fixed timings; the percentages are teaching values, not measured defaults.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A trace waterfall with client, ingress proxy, checkout, checkout sidecar, payment, and payment sidecar spans.",
      "Broken trace context, missing proxy spans, and unsampled traces as separate percentages.",
      "Missing spans rendered as dashed rows so the gap is visible while paused.",
      "A sample trace duration and span count that change with the configuration.",
      "Events when context breaks, proxy spans disappear, or sampling falls below one percent.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and read the waterfall from client to payment. Apply Disconnected and find the first gap. Then compare Degraded and Recovery. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "table",
    headers: ["Symptom", "Likely cause", "Where to look"],
    rows: [
      ["No proxy span between two app spans", "Proxy tracing disabled", "Listener tracing configuration"],
      ["Upstream app span in a different trace", "Context not injected or extracted", "traceparent handling and header allowlists"],
      ["No trace at all for a request", "Head sampling", "Sampling rate and sampled flag"],
      ["Proxy spans but no upstream spans", "Upstream instrumentation or propagation", "Upstream SDK and extractor"],
    ],
  },
  { type: "sim", simId: "mesh-tracing" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The trace was recorded at 100% sampling, so the missing pieces were not a sampling problem. The checkout sidecar produced no span, which removed the proxy hop between checkout and payment. Checkout also failed to forward context, so payment started a new root and its spans belonged to another trace. The waterfall looked short because two different mechanisms were missing at the same time.",
  },
  {
    type: "p",
    text: "When continuity was restored, the payment span rejoined the trace and the waterfall showed the upstream call. When proxy tracing was restored, the sidecar span appeared between the application spans. The two fixes are independent: one changes what the proxy records, the other changes what the caller passes and the receiver continues.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A trace id that changes between the caller and the upstream service, with a new root span at the upstream.",
      "Application spans that are adjacent in the waterfall with no proxy span between them.",
      "Trace headers on outbound requests: traceparent, tracestate, or the vendor equivalent.",
      "Collector counters for spans accepted, refused, and dropped, plus sampling policy.",
      "A request id that still correlates the logs even when the trace is broken or unsampled.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the first gap in the waterfall and classify it. No proxy span means proxy tracing. Upstream span in another trace means propagation. No trace at all means sampling. Check the sampled flag before assuming a propagation bug.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Enable tracing on the proxy listener and verify that proxy spans reach the collector.",
      "Confirm every outbound client injects the configured context headers.",
      "Confirm every inbound server extracts the context before creating a root span.",
      "Check for proxies, gateways, or header allowlists that strip traceparent or tracestate.",
      "Use the sampled flag consistently so downstream services honor the head decision.",
      "Add tail sampling for errors and slow traces instead of raising head sampling for everything.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Full tracing is expensive in storage and collector capacity. Sampling is necessary, but it changes what you can see.",
      "Proxy spans add detail and add overhead at every hop. The cost is usually small compared with application instrumentation.",
      "Tail sampling keeps the interesting traces and requires buffering the trace until the decision is made.",
      "Wide propagation formats improve compatibility and increase header handling complexity.",
      "A request id is cheaper than a trace and less useful for causality; keep both for correlation.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "gap-in-waterfall",
    question:
      "A trace shows checkout and payment application spans, but no spans from either sidecar. What is the likely cause, and what would you check?",
    difficulty: 3,
    hints: [
      "Application spans are connected, so context is not the first suspect.",
      "The proxy is a separate instrumentation point.",
    ],
    answer:
      "The application context is continuous, so the missing layer is proxy instrumentation. I would check whether tracing is enabled on the sidecar listeners and whether the proxies have a tracer provider and a reachable collector. I would compare the trace with a proxy that does emit spans and check the listener bootstrap. If only one sidecar is missing, the issue is local configuration; if all are missing, the mesh or collector configuration is more likely.",
    followUps: [
      "How would missing proxy spans change your latency analysis?",
      "What if only the ingress proxy has spans?",
      "Which collector metric would you check?",
    ],
    redFlags: [
      "Blames sampling first.",
      "Changes application instrumentation.",
      "Ignores the proxy layer.",
    ],
    rubric: [
      "Identifies proxy instrumentation.",
      "Checks listener tracing configuration.",
      "Uses a comparison trace.",
      "Names collector health.",
    ],
  },
  {
    id: "new-root",
    question:
      "Payment appears in its own trace with a new root span whenever checkout calls it. Sampling is 100%. What broke, and how do you prove it?",
    difficulty: 3,
    hints: [
      "A new root means the receiver did not see a parent.",
      "Prove it at the boundary, not inside the application.",
    ],
    answer:
      "The trace context did not cross the checkout-to-payment boundary. Checkout may not inject traceparent, a proxy may strip it, or payment may not extract it. I would capture the outbound request headers at checkout and the inbound headers at payment for the same request id. If the header is present at checkout but absent at payment, a proxy or gateway is stripping it. If it is present at payment but ignored, the extractor or instrumentation is wrong.",
    followUps: [
      "How would you test this without deploying?",
      "What if the header is present but the trace still splits?",
      "How do baggage and tracestate differ from traceparent?",
    ],
    redFlags: [
      "Assumes sampling.",
      "Only inspects application code.",
      "Ignores intermediate proxies.",
    ],
    rubric: [
      "Names the boundary.",
      "Checks both injection and extraction.",
      "Uses request-level evidence.",
      "Considers header stripping.",
    ],
  },
  {
    id: "sampling-design",
    question:
      "You need traces for 0.1% errors but cannot store every request. Design the sampling strategy and explain what it does not solve.",
    difficulty: 4,
    hints: [
      "Head sampling decides early; tail sampling decides late.",
      "Sampling cannot reconnect a broken trace.",
    ],
    answer:
      "I would use a modest head sample for baseline latency and add tail sampling at the collector to keep all error traces and a sample of slow ones. I would propagate the sampled flag so downstream services do not override the decision inconsistently. This keeps evidence for rare failures without storing every success. It does not fix disconnected spans or missing proxy spans; those are instrumentation problems. It also does not guarantee a trace for an error that occurs before the trace is created.",
    followUps: [
      "What buffer does tail sampling require?",
      "How do you sample a trace that never reaches the collector?",
      "How would you verify error coverage?",
    ],
    redFlags: [
      "Raises head sampling to 100%.",
      "Samples errors at the same rate as successes.",
      "Expects sampling to repair context.",
    ],
    rubric: [
      "Combines head and tail sampling.",
      "Propagates the sampled flag.",
      "Separates sampling from propagation.",
      "Defines error coverage.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Tracing is enabled on every proxy listener that should emit spans.",
      "Every service injects outbound context and extracts inbound context.",
      "Header allowlists and gateways preserve traceparent and tracestate.",
      "Sampling keeps errors and slow traces, not only a uniform head sample.",
      "Dashboards show trace completeness and missing proxy spans.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the first gap in the waterfall and classify it: proxy, propagation, or sampling.",
      "Compare the trace id at the caller and at the upstream.",
      "Check the sampled flag before blaming propagation.",
      "Check collector accepted and refused span rates.",
      "Correlate with the request id when the trace is absent.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix instrumentation at the boundary where the trace broke.",
      "Add a test that asserts one trace id across the critical path.",
      "Review sampling coverage for the failure class that occurred.",
      "Document the propagation format and header handling.",
      "Remove temporary sampling overrides once the incident closes.",
    ],
  },
];

const references = [
  {
    title: "Envoy tracing architecture",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/observability/tracing",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "How Envoy generates spans and propagates trace context across a request.",
  },
  {
    title: "OpenTelemetry context propagation",
    url: "https://opentelemetry.io/docs/concepts/context-propagation/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Injecting and extracting context across process boundaries.",
  },
  {
    title: "W3C Trace Context",
    url: "https://www.w3.org/TR/trace-context/",
    publisher: "W3C",
    kind: "standard" as const,
    note: "traceparent and tracestate header formats and the sampled flag.",
  },
  {
    title: "Kuma observability",
    url: "https://kuma.io/docs/latest/explore/observability/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Mesh-level tracing and telemetry configuration.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mesh-tracing": {
      model: meshTracingModel,
      presets,
      instructions:
        "Start Healthy and read the waterfall end to end. Apply Disconnected and find the first gap. Compare Degraded and Recovery, then change sampling last.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Span timings and percentages are teaching values, not Envoy defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-distributed-tracing",
    "observability-otel-context",
    "mesh-access-logs",
    "mesh-envoy-routes",
    "mesh-sidecar-overhead",
  ],
};
