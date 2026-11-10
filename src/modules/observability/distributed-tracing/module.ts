import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SPANS_PER_TRACE = 12;

const params = [
  {
    id: "propagationCoverage",
    label: "Context propagation coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Instrumentation",
    help: "Share of calls that inject and extract the trace context. A missing hop starts a new root span instead of continuing the trace.",
    format: "percent" as const,
  },
  {
    id: "instrumentedServices",
    label: "Instrumented services",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Instrumentation",
    help: "Share of services that emit spans at all. An uninstrumented service leaves a gap that no propagation fix can fill.",
    format: "percent" as const,
  },
  {
    id: "samplingRate",
    label: "Trace sample rate",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Retention",
    help: "Share of traces kept. Sampling changes how many traces you can inspect, not whether a kept trace is complete.",
    format: "percent" as const,
  },
  {
    id: "downstreamLatency",
    label: "Database latency",
    min: 20,
    max: 2_000,
    step: 10,
    value: 120,
    unit: " ms",
    group: "Backend",
    help: "Time spent in the database span. This is the real work the trace is trying to attribute.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  propagation: number;
  instrumented: number;
  sampling: number;
  downstream: number;
  completeness: number;
  missing: number;
  unattributed: number;
  p99: number;
  sampledPer1k: number;
  completePer1k: number;
}

function compute(p: Params): Computed {
  const propagation = num(p, "propagationCoverage", 100);
  const instrumented = num(p, "instrumentedServices", 100);
  const sampling = num(p, "samplingRate", 100);
  const downstream = num(p, "downstreamLatency", 120);
  const completeness = (propagation * instrumented) / 100;
  const missing = 100 - completeness;
  const unattributed = downstream * (missing / 100);
  const p99 = 72 + downstream;
  const sampledPer1k = Math.round(1000 * (sampling / 100));
  const completePer1k = Math.round(sampledPer1k * (completeness / 100));
  return {
    propagation,
    instrumented,
    sampling,
    downstream,
    completeness,
    missing,
    unattributed,
    p99,
    sampledPer1k,
    completePer1k,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface SpanDef {
  id: string;
  label: string;
  nodeKind: SimNode["kind"];
  spanKind: string;
  start: number;
  duration: number;
  depth: number;
  self: number;
  critical: boolean;
}

const MISSING_ORDER = [
  "receipt-worker",
  "receipt-producer",
  "inventory-server",
  "inventory-client",
  "tax-server",
  "tax-client",
  "checkout-internal",
  "edge-internal",
  "payments",
  "db",
  "checkout",
  "edge",
];

function spanLayout(values: Computed): SpanDef[] {
  const rootEnd = values.p99;
  const receiptStart = rootEnd - 42;
  return [
    {
      id: "edge",
      label: "GET /checkout",
      nodeKind: "lb",
      spanKind: "server",
      start: 0,
      duration: rootEnd,
      depth: 0,
      self: 12,
      critical: true,
    },
    {
      id: "edge-internal",
      label: "Edge: parse and route",
      nodeKind: "lb",
      spanKind: "internal",
      start: 2,
      duration: 8,
      depth: 1,
      self: 8,
      critical: false,
    },
    {
      id: "checkout",
      label: "Checkout: handle order",
      nodeKind: "service",
      spanKind: "server",
      start: 12,
      duration: rootEnd - 12,
      depth: 1,
      self: 36,
      critical: true,
    },
    {
      id: "checkout-internal",
      label: "Checkout: validate cart",
      nodeKind: "service",
      spanKind: "internal",
      start: 14,
      duration: 8,
      depth: 2,
      self: 8,
      critical: false,
    },
    {
      id: "inventory-client",
      label: "Inventory call",
      nodeKind: "service",
      spanKind: "client",
      start: 24,
      duration: 22,
      depth: 2,
      self: 4,
      critical: false,
    },
    {
      id: "inventory-server",
      label: "Inventory service",
      nodeKind: "service",
      spanKind: "server",
      start: 28,
      duration: 18,
      depth: 3,
      self: 18,
      critical: false,
    },
    {
      id: "payments",
      label: "Payments: authorize",
      nodeKind: "service",
      spanKind: "server",
      start: 48,
      duration: rootEnd - 48,
      depth: 2,
      self: 24,
      critical: true,
    },
    {
      id: "tax-client",
      label: "Tax call",
      nodeKind: "service",
      spanKind: "client",
      start: 50,
      duration: 30,
      depth: 3,
      self: 6,
      critical: false,
    },
    {
      id: "tax-server",
      label: "Tax service",
      nodeKind: "service",
      spanKind: "server",
      start: 56,
      duration: 24,
      depth: 4,
      self: 24,
      critical: false,
    },
    {
      id: "db",
      label: "Payments DB",
      nodeKind: "db",
      spanKind: "client",
      start: 72,
      duration: values.downstream,
      depth: 3,
      self: values.downstream,
      critical: true,
    },
    {
      id: "receipt-producer",
      label: "Publish receipt",
      nodeKind: "queue",
      spanKind: "producer",
      start: receiptStart,
      duration: 10,
      depth: 3,
      self: 10,
      critical: false,
    },
    {
      id: "receipt-worker",
      label: "Receipt worker",
      nodeKind: "worker",
      spanKind: "consumer",
      start: receiptStart + 12,
      duration: 20,
      depth: 4,
      self: 20,
      critical: false,
    },
  ];
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const p99 = values.p99;
  const latencyHealth = healthFor(p99, 500, 900);
  const missingCount = Math.round((SPANS_PER_TRACE * values.missing) / 100);
  const missing = new Set(MISSING_ORDER.slice(0, missingCount));
  const criticalIds = new Set(["edge", "checkout", "payments", "db"]);
  const nodes = spanLayout({ ...values, p99 }).map((def) => {
    const isMissing = missing.has(def.id);
    const health = isMissing ? "ok" : criticalIds.has(def.id) ? latencyHealth : "ok";
    return {
      id: def.id,
      label: def.label,
      kind: def.nodeKind,
      health,
      utilization: clamp(def.duration / 2_500),
      sublabel: `${def.spanKind} · ${def.start.toFixed(0)}–${(def.start + def.duration).toFixed(0)}ms`,
      detail: isMissing
        ? "This span never joined the trace. A missing span is a gap, not a failing service."
        : `${def.critical ? "On the critical path. " : ""}Self time ${def.self.toFixed(0)}ms of ${def.duration.toFixed(0)}ms.`,
      span: {
        start: def.start,
        duration: def.duration,
        depth: def.depth,
        kind: def.spanKind,
        self: def.self,
        critical: def.critical,
        missing: isMissing,
      },
    } satisfies SimNode;
  });
  const healthById = Object.fromEntries(nodes.map((node) => [node.id, node.health]));
  return {
    t: 0,
    nodes,
    edges: [
      edge("edge-internal", "edge", "edge-internal", 1, healthById["edge-internal"]),
      edge("edge-checkout", "edge", "checkout", 1, healthById.checkout),
      edge("checkout-internal", "checkout", "checkout-internal", 1, healthById["checkout-internal"]),
      edge("checkout-inventory", "checkout", "inventory-client", 1, healthById["inventory-client"]),
      edge("inventory-server", "inventory-client", "inventory-server", 1, healthById["inventory-server"]),
      edge("checkout-payments", "checkout", "payments", 1, healthById.payments),
      edge("payments-tax", "payments", "tax-client", 1, healthById["tax-client"]),
      edge("tax-server", "tax-client", "tax-server", 1, healthById["tax-server"]),
      edge("payments-db", "payments", "db", 1, healthById.db),
      edge("payments-receipt", "payments", "receipt-producer", 1, healthById["receipt-producer"]),
      edge("receipt-worker", "receipt-producer", "receipt-worker", 1, healthById["receipt-worker"]),
    ],
    metrics: [
      metric("missing-spans", "Missing span rate", values.missing, "%", 6, 20, "percent"),
      metric("unattributed-latency", "Unattributed latency", values.unattributed, " ms", 100, 400, "ms"),
      metric("trace-p99", "Trace p99", p99, " ms", 500, 900, "ms"),
      metric("sampled-traces", "Traces kept", values.sampledPer1k, " /1k", undefined, undefined, "count"),
      metric("complete-traces", "Complete traces", values.completePer1k, " /1k", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.missing.toFixed(0)}% of spans are missing; ${values.unattributed.toFixed(0)}ms of backend latency is unattributed; trace p99 ${p99.toFixed(0)}ms; ${values.sampledPer1k} of 1,000 traces kept, ${values.completePer1k} complete.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "missing-spans",
    metricId: "missing-spans",
    warn: 6,
    crit: 20,
    title: "The trace is missing spans",
    cause: "A service is not instrumented or a call boundary does not inject and extract the trace context, so the child starts a new root instead of joining the trace.",
    fix: "Initialize the propagator once at startup, inject context on every outgoing request and message, and extract it before creating the next span. Instrument the service that owns the missing span.",
    checkFirst: [
      "Compare the span tree with the call graph for the same request.",
      "Look for orphan spans with the same timestamp but no parent.",
      "Check headers or message attributes at the first missing hop.",
    ],
  },
  {
    id: "unattributed-latency",
    metricId: "unattributed-latency",
    warn: 100,
    crit: 400,
    title: "Latency has no span to explain it",
    cause: "Time is spent in a call whose span is missing, so the waterfall shows a gap between a parent ending and the next known child starting.",
    fix: "Instrument the missing dependency and propagate context into it. Until then, compare client-side duration with server-side span duration to bound the gap.",
    checkFirst: [
      "Find the largest gap between parent end and child start.",
      "Compare the caller's client span with the callee's server span.",
      "Check asynchronous work that completes after the parent span ends.",
    ],
  },
  {
    id: "trace-p99",
    metricId: "trace-p99",
    warn: 500,
    crit: 900,
    title: "End-to-end trace latency breached the SLO",
    cause: "The backend is slow. The trace may also be incomplete, so the visible spans do not account for the request duration.",
    fix: "Fix attribution before optimizing. A faster uninstrumented service cannot be verified, and a slow span may be waiting on the missing one.",
    checkFirst: [
      "Compare the root span duration with the sum of child spans.",
      "Check the database span and the queue wait separately.",
      "Confirm the trace sample is not biased toward fast requests.",
    ],
  },
];

export const distributedTracingModel: SimModel = {
  id: "observability-distributed-tracing",
  visual: "trace",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = 1 + rng.between(-0.005, 0.005);
    next.metrics = next.metrics.map((item) =>
      item.id === "unattributed-latency" ? { ...item, value: item.value * jitter } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.missing >= 20 && frame.flags.traceGapSeen !== 1) {
      pushEvent(next, {
        id: "trace-context-lost",
        at: frame.t,
        severity: "crit",
        title: "Trace context is lost at a service boundary",
        detail: `${values.missing.toFixed(0)}% of spans are missing. About ${values.unattributed.toFixed(0)}ms of backend time has no span to explain it.`,
        nodeId: "checkout",
        metricId: "missing-spans",
      });
      next.flags.traceGapSeen = 1;
    }
    if (values.missing < 20) next.flags.traceGapSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    const p99 = (next.metrics.find((item) => item.id === "trace-p99")?.value ?? values.p99).toFixed(0);
    next.summary = `${values.missing.toFixed(0)}% of spans are missing; ${values.unattributed.toFixed(0)}ms of backend latency is unattributed; trace p99 ${p99}ms; ${values.sampledPer1k} of 1,000 traces kept, ${values.completePer1k} complete.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.missing > 0) {
      items.push(`${values.missing.toFixed(0)}% of spans never join the trace. The visible waterfall ends where propagation or instrumentation stops.`);
      items.push(`The missing spans hide about ${values.unattributed.toFixed(0)}ms of the ${values.downstream.toFixed(0)}ms database time.`);
    } else {
      items.push("Every span joins the same trace, so parent and child timing account for the full request.");
    }
    items.push(`${SPANS_PER_TRACE} spans describe one checkout trace; the root duration is ${values.p99.toFixed(0)}ms at p99.`);
    items.push(`Sampling at ${values.sampling.toFixed(0)}% keeps ${values.sampledPer1k} of every 1,000 traces. ${values.completePer1k} of those kept traces contain all 12 spans.`);
    items.push("Sampling changes coverage; propagation and instrumentation change completeness. They are separate metrics.");
    return items;
  },
  legend: [
    { label: "Complete", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Broken context", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every service is instrumented, context propagates on every hop, and the database takes 120ms.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Instrumentation gaps",
    description: "Some services and hops are missing coverage at 350ms database latency. The trace is partial.",
    tone: "warn",
    params: defaults({ propagationCoverage: 95, instrumentedServices: 90, samplingRate: 50, downstreamLatency: 350 }),
  },
  {
    id: "failure",
    label: "Broken propagation",
    description: "A new async worker drops the context and 40% of services are uninstrumented. The slow span is invisible.",
    tone: "crit",
    params: defaults({ propagationCoverage: 40, instrumentedServices: 60, samplingRate: 100, downstreamLatency: 900 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Propagation and instrumentation restored; sampling stays at 50% to control cost.",
    tone: "ok",
    params: defaults({ propagationCoverage: 100, instrumentedServices: 100, samplingRate: 50, downstreamLatency: 120 }),
  },
];

const experiment: Experiment = {
  id: "predict-orphan-span",
  title: "Predict what the async worker does to the trace",
  simId: "distributed-tracing",
  question:
    "A checkout request publishes a job, and a worker consumes it without extracting the trace context. The worker is instrumented. What appears in the trace?",
  prediction: {
    options: [
      { id: "same-trace", label: "The worker span joins the original trace because both services use the same SDK" },
      { id: "new-root", label: "The worker creates a new root trace, so the async work appears as an unrelated trace" },
      { id: "missing", label: "The worker span is dropped because the queue does not support tracing" },
      { id: "sampled", label: "The trace is split only when sampling is below 100%" },
    ],
    correctOptionId: "new-root",
    explanation:
      "The SDK can create a span, but only the extracted context tells it which trace and parent to join. Without a `traceparent` or equivalent message attribute, the worker starts a new trace. Both traces can be complete internally, yet the causal link between them is gone.",
  },
  setup: defaults({ propagationCoverage: 20, instrumentedServices: 100, samplingRate: 100, downstreamLatency: 120 }),
  runFor: 20,
  observe: [
    "The missing span rate reaches 80%, far past the 20% critical threshold.",
    "About 96ms of the 120ms database time has no span to explain it.",
    "Traces kept remain 1,000 of 1,000 because sampling is still 100%; only 200 are complete.",
    "The trace p99 stays at 192ms, so latency alone does not reveal the broken causality.",
    "The waterfall shows missing spans and a broken parent link, while no service is marked as failing.",
  ],
  explain:
    "Instrumentation creates spans; propagation joins them. The worker needs to extract the context from the message before it starts its span, and the producer needs to inject it when it publishes. If either side skips that step, the worker becomes a new root. The fix is a propagator configured once plus inject and extract calls at every async boundary, not more spans in the worker.",
  fix: defaults({ propagationCoverage: 100, instrumentedServices: 100, samplingRate: 100, downstreamLatency: 120 }),
  debrief:
    "Restoring propagation rejoins the worker to the checkout trace and removes the unattributed time. Sampling remains a separate decision: a 50% sample still produces complete traces for the requests it keeps. The tradeoff is that more spans and more context headers add overhead, and baggage can carry sensitive values across services if it is not controlled.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A distributed trace is a tree of spans that describes one request. A span is a timed operation with a trace ID, a span ID, a parent span ID, a name, a start and end time, a kind, attributes, events, and a status. The root span is the entry point. Each child span represents work caused by its parent: an HTTP call, a database query, a queue publish, or an in-process step.",
  },
  {
    type: "p",
    text: "The parent ID is what makes the trace causal. Two spans with overlapping timestamps are not necessarily related. Two spans with a parent-child link are. Span kind narrows the meaning: a client span measures the caller's view of a remote call, a server span measures the callee's handling, a producer span measures a message publish, a consumer span measures message processing, and an internal span measures local work.",
  },
  {
    type: "p",
    text: "Context propagation is the mechanism that carries the trace identity across process boundaries. In HTTP, the W3C Trace Context standard defines the `traceparent` header; messaging systems need an equivalent attribute or header on the message. If a hop does not inject and extract that value, the next service starts a new trace. The SDK is still working; the causality is broken.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is instrumented application, context injection, network or queue, context extraction, collector, trace backend, then the waterfall or query UI. Instrumentation decides what is measured, propagation decides what is joined, and sampling decides what is kept. Each is a separate failure mode.",
  },
  {
    type: "table",
    headers: ["Span kind", "Measures", "Typical question"],
    rows: [
      ["Server", "Time the callee spent handling the request", "Is the service slow, or is it waiting?"],
      ["Client", "Time the caller waited for a remote call", "Is the dependency slow from here?"],
      ["Producer", "Time to publish a message", "Is the queue or broker accepting?"],
      ["Consumer", "Time to process a delivered message", "Is the async work keeping up?"],
      ["Internal", "Local computation or a library call", "Which step inside the service dominates?"],
    ],
  },
  {
    type: "p",
    text: "This module models a 12-span checkout trace with illustrative timing. The exact millisecond values are teaching values, not a benchmark. The lesson is structural: a trace is only as useful as the spans that joined it, and a missing span makes the remaining waterfall look confident while hiding the work.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Missing span rate: the share of expected spans that never joined the trace.",
      "Unattributed latency: backend time with no span to explain it.",
      "Trace p99: the end-to-end duration a user experiences.",
      "Traces kept per 1,000: sample coverage only, with no completeness factor.",
      "Complete traces per 1,000: kept traces that still contain every expected span.",
      "The waterfall tree: parent indentation, span kinds, self time, the critical path, and dashed missing spans.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Broken propagation. Read the waterfall from the root down: indentation is the parent chain, and dashed bars are missing spans. Compare traces kept with complete traces. Run the experiment before the debrief, then restore propagation and confirm that completeness returns without changing the sample rate.",
  },
  {
    type: "compare",
    leftTitle: "Instrumented but not propagated",
    rightTitle: "Instrumented and propagated",
    rows: [
      { label: "Span count", left: "Many spans, split across roots", right: "One tree with a single root" },
      { label: "Parent IDs", left: "Missing or pointing to a new root", right: "Point to the calling span" },
      { label: "Latency attribution", left: "Gaps with no explanation", right: "Every child accounts for its share" },
      { label: "Async work", left: "Looks unrelated", right: "Joins through the message attribute" },
      { label: "Incident value", left: "Pretty waterfall, wrong story", right: "A path you can test" },
    ],
  },
  { type: "sim", simId: "distributed-tracing" },
  { type: "experiment", experimentId: "predict-orphan-span" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The propagation gap split the checkout trace. The worker was instrumented, so it emitted spans, but it had no extracted parent and started a new root. The waterfall for the original request ended early, and the backend time appeared as a gap rather than a slow span. The trace p99 stayed believable, which is why the failure can survive a latency review.",
  },
  {
    type: "p",
    text: "Restoring propagation rejoined the worker and the database time to the checkout trace. Sampling at 50% still produced complete traces for the requests it kept. That is the separation the module is teaching: sampling controls how many traces you keep; propagation controls whether a kept trace tells the truth.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "OpenTelemetry Collector: accepted, refused, and dropped spans; exporter queue length; propagation is not a collector setting, but collector gaps show up as missing services.",
      "Jaeger or Grafana Tempo: orphan spans, traces with more than one root, and services that appear in logs but not in the trace.",
      "Application logs: the trace ID on a log line that has no matching trace, which points to a sampling or export gap.",
      "Service map: an edge that exists in the call graph but not in the trace graph, which is a strong propagation clue.",
      "Async systems: message attributes that do not carry the trace context, and consumer spans whose parent is empty.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the first hop where the child has no parent. Check the outgoing header or message attribute before you change the SDK version. If the child is a new root, the problem is propagation; if the child is absent, the problem is instrumentation or sampling.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Configure one propagator at process startup and use it for every inbound and outbound call.",
      "Inject context on HTTP requests and message publishes; extract it before creating the next span.",
      "Instrument the services that own the missing spans; a propagation fix cannot invent a span.",
      "Add a test that sends a request through the async boundary and asserts one trace ID and one root.",
      "Review sampling after completeness; keep error and slow traces if the backend supports it.",
      "Watch orphan-span rate and traces with multiple roots as ongoing health signals.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More spans improve attribution and add CPU, memory, and export volume; sample or batch at the collector.",
      "Propagation headers must be supported by every proxy, queue, and client library; a dropped header is invisible until a trace is investigated.",
      "Baggage can carry values across services, but it can also carry sensitive data and inflate every request; keep it small and controlled.",
      "Higher sampling improves rare-path visibility and raises storage cost; head sampling cannot know which traces will be interesting.",
      "A complete trace of the wrong operation is still useless; instrument the boundaries that match the incident questions.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-waterfall",
    question:
      "A trace has 12 spans. The longest span belongs to service B, but the root duration is much larger than the sum of B and its children. How do you read it?",
    difficulty: 3,
    hints: [
      "A waterfall is a tree, not a sorted list.",
      "Look for gaps between a parent ending and a child starting.",
    ],
    answer:
      "I would reconstruct the tree from parent IDs and compare each parent's duration with the union of its children. If the root is much larger than the known children, the missing time is either an uninstrumented call or time outside any child span. I would find the largest gap, check whether a client span has no matching server span, and compare timestamps at that boundary. The longest span is a candidate, not a conclusion; it may be waiting on the missing child.",
    followUps: [
      "How would an orphan span change your answer?",
      "What if two children overlap in time?",
      "Which span kind would you look for at an async boundary?",
    ],
    redFlags: [
      "Sorts spans by duration and blames the top one.",
      "Ignores parent IDs.",
      "Assumes the root span is accurate without checking children.",
    ],
    rubric: [
      "Reconstructs the tree.",
      "Compares parent duration with child coverage.",
      "Separates missing span from slow span.",
    ],
  },
  {
    id: "propagation-debug",
    question:
      "A trace stops at a queue consumer. The producer and consumer both emit spans. What do you check, and in what order?",
    difficulty: 3,
    hints: [
      "Producer injection and consumer extraction are separate steps.",
      "The message attribute is the boundary.",
    ],
    answer:
      "I would first confirm that the producer injects the context into the message attributes and that the consumer extracts it before starting its span. Then I would check whether the messaging library or broker drops the attribute. If both sides look correct, I would compare the trace IDs on the producer and consumer spans and look for a new root on the consumer. The order matters because adding consumer spans without extraction just creates more orphans.",
    followUps: [
      "How would you prove the broker preserved the attribute?",
      "What if the consumer processes a batch of messages?",
      "Where would baggage fit in this path?",
    ],
    redFlags: [
      "Starts by increasing sampling.",
      "Adds spans without checking extraction.",
      "Ignores the message attribute.",
    ],
    rubric: [
      "Separates injection from extraction.",
      "Checks the broker or library boundary.",
      "Uses trace IDs and root count as evidence.",
    ],
  },
  {
    id: "sampling-vs-completeness",
    question:
      "The team lowers trace sampling to 5% to cut cost. A trace that is kept is missing half its spans. Is sampling the cause?",
    difficulty: 2,
    hints: [
      "Sampling decides which traces are kept, not which spans belong to a kept trace.",
      "Look for a propagation or instrumentation gap.",
    ],
    answer:
      "No. Head sampling decides whether a trace is recorded before the request outcome is known; once a trace is sampled in, its spans should still join through context propagation. A kept trace with missing spans points to a propagation or instrumentation gap, not the sample rate. I would check the missing service, the parent IDs, and whether the trace decision is being propagated to downstream services. Sampling changes volume and rare-path visibility, not the internal completeness of a kept trace.",
    followUps: [
      "How does tail sampling differ?",
      "What would a sampling bug look like in the data?",
      "How would you verify the sampler is consistent across services?",
    ],
    redFlags: [
      "Blames sampling for missing spans.",
      "Raises sampling to fix completeness.",
      "Does not check propagation of the sampling decision.",
    ],
    rubric: [
      "Distinguishes coverage from completeness.",
      "Names propagation as the likely cause.",
      "Mentions sampling decision propagation.",
    ],
  },
  {
    id: "instrumentation-plan",
    question:
      "You can instrument only three boundaries in a checkout path. Which do you choose, and what question does each answer?",
    difficulty: 2,
    hints: [
      "Start from the user-visible latency and the dependencies that can block it.",
      "Include the async path if it affects the response.",
    ],
    answer:
      "I would instrument the inbound request at the edge, the outbound call to the slowest critical dependency, and the async boundary that affects the response or the next user step. The edge span answers what the user waited for; the dependency span separates work from waiting; the async span answers whether work continued after the response and whether it failed silently. I would add database spans inside the dependency if the driver supports it, but I would not instrument low-value internal helpers before those three.",
    followUps: [
      "How would you choose between two dependencies with similar latency?",
      "What would you do about a third-party call you cannot instrument?",
      "How do you keep span attributes bounded?",
    ],
    redFlags: [
      "Instruments everything with no question.",
      "Ignores async work.",
      "Adds high-cardinality attributes to every span.",
    ],
    rubric: [
      "Ties each span to an incident question.",
      "Covers sync and async paths.",
      "Considers attribute cost and cardinality.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "A propagator is configured once and used by every HTTP and messaging client.",
      "Every service that appears in the call graph emits spans.",
      "Async producers inject context and consumers extract it before starting a span.",
      "Dashboards show orphan spans and traces with multiple roots.",
      "Sampling policy is documented, including how the decision propagates.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Reconstruct the tree from parent IDs before sorting by duration.",
      "Find the first hop where the parent link disappears.",
      "Compare a client span with its matching server span.",
      "Check collector drops and export errors before changing application code.",
      "Record the missing service and the trace IDs used as evidence.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a propagation test through the failed boundary.",
      "Add the missing service to the instrumentation coverage check.",
      "Review sampling and retention against the traces responders needed.",
      "Remove any temporary verbose span attributes that carry sensitive values.",
    ],
  },
];

const references = [
  {
    title: "Traces",
    url: "https://opentelemetry.io/docs/concepts/signals/traces/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Spans, traces, context, and the relationship between instrumentation and propagation.",
  },
  {
    title: "Context Propagation",
    url: "https://opentelemetry.io/docs/concepts/context-propagation/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Inject and extract across process boundaries, including messaging.",
  },
  {
    title: "Jaeger Documentation",
    url: "https://www.jaegertracing.io/docs/",
    publisher: "Jaeger",
    kind: "docs" as const,
    note: "Trace storage, query, and the waterfall view used to read span trees.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "distributed-tracing": {
      model: distributedTracingModel,
      presets,
      instructions:
        "Start Healthy, then apply Broken propagation. Compare the missing span rate with trace p99, then run the experiment and restore propagation. Sampling stays a separate control.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Span timings and the 12-span checkout trace are teaching values, not a benchmark.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-structured-logging",
    "observability-trace-critical-path",
    "observability-otel-context",
    "observability-otel-head-sampling",
  ],
};
