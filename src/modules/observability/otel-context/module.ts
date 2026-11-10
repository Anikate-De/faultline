import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  Params,
  ParamSpec,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUEST_RPS = 480;
const HTTP_BOUNDARIES = 3;
const BYTES_PER_BAGGAGE_ENTRY = 80;

const params: ParamSpec[] = [
  {
    id: "httpCoverage",
    label: "HTTP context coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Propagation",
    help: "Share of HTTP client calls that inject traceparent and whose servers extract it.",
    format: "percent",
  },
  {
    id: "queueCoverage",
    label: "Queue context coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Propagation",
    help: "Share of messages that carry traceparent in a message attribute and whose consumer extracts it.",
    format: "percent",
  },
  {
    id: "asyncCoverage",
    label: "Background job context",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Propagation",
    help: "Share of scheduled jobs that restore the originating context before the first span.",
    format: "percent",
  },
  {
    id: "baggageEntries",
    label: "Baggage entries",
    min: 0,
    max: 30,
    step: 1,
    value: 2,
    unit: "",
    group: "Baggage",
    help: "Key and value pairs propagated beside the trace. Baggage carries data, not parent-child structure.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  httpCoverage: number;
  queueCoverage: number;
  asyncCoverage: number;
  baggageEntries: number;
  httpGap: number;
  pieces: number;
  fragmentation: number;
  orphanRate: number;
  baggageBytes: number;
  p99: number;
}

function compute(p: Params): Computed {
  const httpCoverage = Math.round(num(p, "httpCoverage", 100));
  const queueCoverage = Math.round(num(p, "queueCoverage", 100));
  const asyncCoverage = Math.round(num(p, "asyncCoverage", 100));
  const baggageEntries = Math.round(num(p, "baggageEntries", 2));
  const httpGap = 1 - httpCoverage / 100;
  const pieces =
    1 + HTTP_BOUNDARIES * httpGap + (1 - queueCoverage / 100) + (1 - asyncCoverage / 100);
  const intact =
    (httpCoverage / 100) ** HTTP_BOUNDARIES * (queueCoverage / 100) * (asyncCoverage / 100);
  const fragmentation = clamp((1 - intact) * 100, 0, 100);
  return {
    httpCoverage,
    queueCoverage,
    asyncCoverage,
    baggageEntries,
    httpGap,
    pieces,
    fragmentation,
    orphanRate: REQUEST_RPS * (pieces - 1),
    baggageBytes: baggageEntries * BYTES_PER_BAGGAGE_ENTRY,
    p99: 238 + Math.min(6, baggageEntries * 0.2),
  };
}

function coverageHealth(coverage: number): Health {
  if (coverage < 60) return "crit";
  if (coverage < 100) return "warn";
  return "ok";
}

function worst(a: Health, b: Health): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["fragmentation", values.fragmentation, 2],
    ["trace-pieces", values.pieces, 0.04],
    ["orphan-roots", values.orphanRate, 12],
    ["baggage-bytes", values.baggageBytes, 4],
    ["checkout-p99", values.p99, 2],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 11)) / 2.6) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const httpHealth = coverageHealth(values.httpCoverage);
  const queueHealth = coverageHealth(values.queueCoverage);
  const asyncHealth = coverageHealth(values.asyncCoverage);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Checkout client",
        kind: "client",
        health: "ok",
        throughput: REQUEST_RPS,
        sublabel: `${REQUEST_RPS} req/s`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge router",
        kind: "lb",
        health: httpHealth,
        throughput: REQUEST_RPS,
        sublabel: "HTTP hop 1",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: httpHealth,
        throughput: REQUEST_RPS,
        sublabel: "HTTP hop 2, 3",
        meta: { view: "flow" },
      },
      {
        id: "queue",
        label: "Receipt queue",
        kind: "queue",
        health: queueHealth,
        sublabel: `${values.queueCoverage}% carry traceparent`,
        meta: { view: "flow" },
      },
      {
        id: "worker",
        label: "Receipt worker",
        kind: "worker",
        health: worst(queueHealth, asyncHealth),
        sublabel: `${values.asyncCoverage}% attach job context`,
        meta: { view: "flow" },
      },
      {
        id: "payments",
        label: "Payments API",
        kind: "service",
        health: httpHealth,
        throughput: Math.round(REQUEST_RPS * 0.35),
        sublabel: "sync HTTP call",
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "client-edge", from: "client", to: "edge", rate: 1, health: "ok" },
      { id: "edge-checkout", from: "edge", to: "checkout", rate: 1, health: httpHealth },
      { id: "checkout-queue", from: "checkout", to: "queue", rate: 1, health: queueHealth },
      { id: "queue-worker", from: "queue", to: "worker", rate: 1, health: queueHealth },
      { id: "checkout-payments", from: "checkout", to: "payments", rate: 0.35, health: httpHealth },
    ],
    metrics: [
      metric("fragmentation", "Checkouts with split traces", values.fragmentation, "%", 10, 25, "percent"),
      metric("trace-pieces", "Trace pieces per checkout", values.pieces, "", 1.25, 1.75, "number"),
      metric("orphan-roots", "Orphan root spans", values.orphanRate, " /s", 60, 200, "number"),
      metric("baggage-bytes", "Baggage size", values.baggageBytes, " bytes", 1_000, 2_000, "bytes"),
      metric("checkout-p99", "Checkout p99", values.p99, "ms", 800, 1_200, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, rps: REQUEST_RPS },
    summary: `${values.pieces.toFixed(2)} trace pieces per checkout; ${values.fragmentation.toFixed(0)}% of checkouts are split; ${Math.round(values.orphanRate)} orphan roots/s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "fragmentation",
    metricId: "fragmentation",
    warn: 10,
    crit: 25,
    title: "Checkout traces no longer form one causal tree",
    cause: "A hop accepted a request without an extracted parent context, so its instrumentation started a new root span with a new trace ID.",
    fix: "Inject traceparent on the outbound side and extract it on the inbound side at the missing hop. Then verify that the new span's parent is the producer span, not empty.",
    checkFirst: [
      "Compare trace IDs at the producer and the consumer for the same request.",
      "Check whether the consumer span has a parent span ID.",
      "Find the first hop where the trace ID changes.",
    ],
  },
  {
    id: "trace-pieces",
    metricId: "trace-pieces",
    warn: 1.25,
    crit: 1.75,
    title: "One checkout produces more than one trace",
    cause: "Every uninstrumented boundary adds another root. Three HTTP boundaries plus a queue and a background job can create five separate traces for one order.",
    fix: "Carry the same trace ID across all five boundaries. Treat the number of roots per request as the coverage metric.",
    checkFirst: [
      "Count distinct root spans for one order ID over a minute.",
      "List the boundaries on the request path, including asynchronous ones.",
      "Check the messaging and job libraries, not only the HTTP framework.",
    ],
  },
  {
    id: "orphan-roots",
    metricId: "orphan-roots",
    warn: 60,
    crit: 200,
    title: "Orphan root spans are arriving at the collector",
    cause: "The consumer or worker is tracing the work but not linking it to the caller. The work is visible, yet it cannot be found from the originating trace.",
    fix: "Attach context before the first span in the consumer. If the message has no traceparent, mark the span as a link or record the missing-context case instead of silently starting a new trace.",
    checkFirst: [
      "Search traces by the order ID and count the roots.",
      "Check the consumer's message attributes for traceparent.",
      "Verify the extractor runs before the consumer starts its span.",
    ],
  },
  {
    id: "baggage-bytes",
    metricId: "baggage-bytes",
    warn: 1_000,
    crit: 2_000,
    title: "Baggage is large enough to threaten header budgets",
    cause: "Baggage is copied onto every outbound request. Entries that carry lists or identifiers grow the header on every hop, and proxies or queues may reject oversized metadata.",
    fix: "Keep baggage to the few values every hop needs. Pass large or sensitive data by reference, not by value, and never treat baggage as trusted input.",
    checkFirst: [
      "List the baggage keys and who reads each one.",
      "Check the largest value and whether it is user-controlled.",
      "Check gateway and queue metadata limits in your own stack.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const otelContextModel: SimModel = {
  id: "observability-otel-context",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.008, 0.008);
    next.metrics = next.metrics.map((item) =>
      item.id === "checkout-p99"
        ? { ...item, value: Math.max(0, item.value * (1 + jitter)) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.queueCoverage < 100 && frame.flags.queueSplitSeen !== 1) {
      pushEvent(next, {
        id: "context-lost-at-queue",
        at: frame.t,
        severity: "warn",
        title: "Trace context stops at the queue consumer",
        detail: `${values.queueCoverage}% of messages carry traceparent. The consumer starts a new root, so one checkout becomes ${values.pieces.toFixed(2)} traces.`,
        nodeId: "worker",
        metricId: "fragmentation",
      });
      next.flags.queueSplitSeen = 1;
    }
    if (values.queueCoverage >= 100) next.flags.queueSplitSeen = 0;
    next.summary = `${values.pieces.toFixed(2)} trace pieces per checkout; ${values.fragmentation.toFixed(0)}% of checkouts are split; ${Math.round(values.orphanRate)} orphan roots/s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.httpCoverage < 100) {
      items.push(
        `${100 - values.httpCoverage}% of HTTP calls start a new trace, adding ${(HTTP_BOUNDARIES * values.httpGap).toFixed(2)} extra roots per checkout.`,
      );
    }
    if (values.queueCoverage < 100) {
      items.push(
        `The queue hop is broken: the producer span and the consumer span have different trace IDs. This alone produces ${Math.round(REQUEST_RPS)} orphan roots/s at ${REQUEST_RPS} req/s.`,
      );
    }
    if (values.asyncCoverage < 100) {
      items.push(
        `${100 - values.asyncCoverage}% of scheduled jobs do not restore the request context, so the job cannot be found from the order trace.`,
      );
    }
    items.push(
      `Checkout p99 stays near ${values.p99.toFixed(0)}ms: broken tracing changes what you can see, not what users experience.`,
    );
    if (values.baggageBytes > 0) {
      items.push(
        `${values.baggageEntries} baggage entries add about ${values.baggageBytes} bytes to every outbound request. Baggage values are copied, not linked.`,
      );
    }
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
    description: "HTTP, queue, and job context are all injected and extracted. One request, one trace.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "One HTTP hop missed",
    description: "Five percent of HTTP calls skip extraction. About 14.3% of checkouts split at the edge, but the queue is intact.",
    tone: "warn",
    params: defaults({ httpCoverage: 95 }),
  },
  {
    id: "failure",
    label: "Queue context lost",
    description: "The producer publishes without traceparent. The consumer starts a new root and the order trace ends at the queue.",
    tone: "crit",
    params: defaults({ queueCoverage: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Inject traceparent into the message and extract it before the consumer span. Baggage is trimmed to four entries.",
    tone: "ok",
    params: defaults({ baggageEntries: 4 }),
  },
];

const experiment: Experiment = {
  id: "predict-trace-split",
  title: "Predict where the checkout trace splits",
  simId: "otel-context",
  question:
    "Every HTTP hop injects traceparent. The checkout service publishes to a queue, and the producer does not add traceparent to the message. What will the trace search show?",
  prediction: {
    options: [
      { id: "two-roots", label: "Two traces: the checkout trace ends at publish and the worker starts a new root" },
      { id: "one-gap", label: "One trace with a missing worker span but the same trace ID" },
      { id: "baggage-lost", label: "One trace that is complete but has no baggage" },
      { id: "rejected", label: "The message is rejected because trace context is required" },
    ],
    correctOptionId: "two-roots",
    explanation:
      "The trace ID travels in traceparent, not in the payload. Without the header or message attribute, the consumer has no parent to attach to, so its instrumentation creates a new trace. Baggage is separate and is not required for a message to be accepted.",
  },
  setup: defaults({ queueCoverage: 0 }),
  runFor: 20,
  observe: [
    "Every checkout is split: split checkouts reach 100% and one checkout produces two trace pieces.",
    "The worker emits about 480 orphan roots per second at 480 checkouts per second.",
    "The HTTP path and the payments span still share one trace; only the consumer splits.",
    "Checkout p99 stays around 240ms, so user-facing latency does not reveal the break.",
  ],
  explain:
    "The producer's span is the last span in the first trace. The consumer's span has no parent, so the SDK allocates a new trace ID. Search by trace ID finds either the checkout side or the worker side, never both. The fix is to inject traceparent where the message is published and extract it where the message is consumed, before the first consumer span starts.",
  fix: defaults({ queueCoverage: 100, baggageEntries: 2 }),
  debrief:
    "Restoring the message attribute brings the checkout and the worker back into one trace and drops orphan roots to zero. The cost is a propagation contract on the message schema: producers must inject, consumers must extract, and a message replayed from a dead-letter queue must not reuse stale context. Test the replay path separately.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A distributed trace is a tree of spans. Every span needs the trace ID of the whole request and the span ID of its parent. OpenTelemetry uses the W3C Trace Context format to carry those two identifiers, plus trace flags, in a `traceparent` header. The same context object also carries baggage, which is a set of application key and value pairs that travel with the request.",
  },
  {
    type: "p",
    text: "Propagation is the work of moving that context across a boundary. On the way out, a client injects the header. On the way in, a server extracts it and makes it the parent of the server span. If either side is missing, the receiver starts a new trace. The trace still looks valid, so the failure is easy to miss: two complete traces replace one causal tree.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Context crosses more boundaries than HTTP. A queue message, a scheduled job, a thread pool, and a callback all start with no ambient parent unless the producer stores the context and the consumer restores it. Instrumentation libraries handle common HTTP clients and servers, but messaging, batch, and background runtimes often need explicit injection and extraction.",
  },
  {
    type: "table",
    headers: ["Boundary", "Carrier", "Failure if skipped"],
    rows: [
      ["HTTP or gRPC call", "traceparent header on the request", "Server span starts a new trace"],
      ["Queue publish and consume", "Message attribute or header set by the producer", "Consumer is a new root; the producer trace ends"],
      ["Scheduled or background job", "Context persisted in the job record", "Job cannot be found from the request that scheduled it"],
      ["Thread or task handoff", "Context passed to the new execution scope", "Span is missing or attached to the wrong parent"],
    ],
  },
  {
    type: "p",
    text: "Baggage uses the same propagation path but has a different job. It does not join spans and it does not decide parentage. It carries values such as a tenant or a feature flag across services. Because it is copied onto every outbound request, its size and trust model matter. The model here assumes an average of 80 bytes per entry, an illustrative value, not a protocol limit.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Split checkouts: the share of checkouts whose spans do not share one trace ID.",
      "Trace pieces per checkout: one means intact; two or more means the path has extra roots.",
      "Orphan root spans per second: work that exists but cannot be reached from the originating trace.",
      "Baggage size: the header cost of the values carried beside the trace.",
      "Checkout p99: a deliberate control that stays flat while tracing breaks.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and follow the flow from client to worker. Apply Queue context lost, then watch the fragment count and orphan roots move while p99 stays flat. Open the timeline to see the event, then raise queue coverage to 100 in the parameters and confirm the trace count returns to one.",
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it does not tell you"],
    rows: [
      ["Trace ID change", "A boundary lost the parent", "Which library or hop caused it"],
      ["Missing parent span ID", "The receiver started a root", "Whether the producer sent anything at all"],
      ["Baggage is absent", "Application metadata was not propagated", "Whether the trace itself is intact"],
      ["High orphan rate", "Work is unreachable from its caller", "Whether users are affected"],
    ],
  },
  { type: "sim", simId: "otel-context" },
  { type: "experiment", experimentId: "predict-trace-split" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The checkout request crossed three HTTP boundaries, a queue, and a background job. With full coverage, all of those spans shared one trace ID. Removing the queue attribute did not remove the worker's spans. It changed their parent. The consumer started a new root, which gave the order two trace IDs and added an orphan root for every message.",
  },
  {
    type: "p",
    text: "The other signals confirm the shape. Split checkouts rose to 100%: every order had one intact HTTP trace and one separate consumer trace. The HTTP path and the payments call stayed intact, which ruled out a global collector problem. Checkout p99 did not move, which is the trap: the system was healthy for users while the evidence chain was broken.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Trace search: the order ID returns two traces with different trace IDs and no shared parent.",
      "Span detail: the consumer span has no parent span ID, or its parent belongs to a different trace.",
      "Producer logs: the message was published, but the traceparent attribute is absent from the message metadata.",
      "Consumer logs: the trace ID in the log line differs from the producer's trace ID for the same order.",
      "Collector or backend counts: root spans rise without a matching rise in requests.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Pick one affected request and compare the trace ID at the producer and the consumer. If they differ, the boundary lost context. Then check whether the producer injected the header, whether the consumer's extractor ran before its first span, and whether the message attribute survived serialization and any middleware.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the split at the smallest boundary: inject traceparent on the producer and extract it at the top of the consumer before any span is created.",
      "For queues, store context as a message attribute or header, not in an application field that the consumer parses later.",
      "For background jobs, persist the context with the job record and restore it when the job starts, including retries and replays.",
      "For thread or task handoffs, pass the context explicitly instead of relying on ambient storage.",
      "Add a test that asserts one trace ID across the whole path for a synthetic order.",
      "Trim baggage to the values every hop needs, and keep secrets and user identifiers out of it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Full propagation adds a small header to every request and a contract to every message schema. The cost is real but bounded.",
      "A missing-context span can be recorded as a link instead of a new root, preserving some causality without pretending the parent exists.",
      "Baggage is convenient and risky: it is copied everywhere, can grow headers, and is untrusted input unless every producer is trusted.",
      "Sampling decisions travel in trace flags. Changing the decision mid-trace can produce partial traces that look like propagation bugs.",
      "Fix propagation before you tune sampling; a sampled trace that is already split cannot be repaired downstream.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "debug-consumer-split",
    question:
      "A trace ends at the queue producer and the consumer appears as a separate trace. How do you prove where context was lost?",
    difficulty: 3,
    hints: [
      "Compare identifiers, not durations.",
      "Check the message metadata before you check the tracing backend.",
    ],
    answer:
      "I would take one message or order ID and compare the trace ID at the producer with the trace ID at the consumer. If they differ, I would inspect the message metadata for traceparent and check whether the consumer extracts it before creating its first span. Then I would look at the consumer span's parent span ID: absent or unrelated means a new root. I would also check serialization and middleware between the publish call and the broker, because a header can be dropped without an application error.",
    followUps: [
      "How would you test the fix without waiting for a real order?",
      "What if the consumer is a batch job that handles many messages?",
      "How do you handle a replayed dead-letter message?",
    ],
    redFlags: [
      "Starts by restarting the collector.",
      "Assumes the trace backend lost data.",
      "Looks only at HTTP instrumentation.",
    ],
    rubric: [
      "Compares trace IDs at both ends.",
      "Checks message metadata.",
      "Checks parent span ID.",
      "Names a reproducible test.",
    ],
  },
  {
    id: "propagation-carriers",
    question:
      "Which carriers would you use for an HTTP call, an SQS message, and a nightly batch job, and why are they different?",
    difficulty: 3,
    hints: [
      "The carrier has to survive the transport and the runtime.",
      "Ambient context does not cross a process or a delay.",
    ],
    answer:
      "For HTTP I would rely on the W3C traceparent header, which the client library injects and the server extracts. For SQS I would put traceparent in a message attribute or header set at publish time and extract it at the start of the consumer, before the receive span is created. For a nightly job I would persist the context in the job record, because the job may start hours later on another host with no ambient parent. In every case the rule is the same: serialize the context at the producer, restore it before the first span at the consumer, and test the handoff.",
    followUps: [
      "What happens if the queue is replayed after a week?",
      "Would you propagate baggage on all three?",
      "How do you avoid a stale parent on a retry?",
    ],
    redFlags: [
      "Uses a global variable across processes.",
      "Stores context only in logs.",
      "Treats baggage as the trace parent.",
    ],
    rubric: [
      "Names a carrier per boundary.",
      "Explains serialization and restoration.",
      "Mentions delayed and replayed work.",
      "Keeps baggage separate.",
    ],
  },
  {
    id: "baggage-risk",
    question:
      "A team wants to propagate a tenant ID and a user email in baggage. What do you allow, and what do you change?",
    difficulty: 3,
    hints: [
      "Baggage is copied to every downstream call.",
      "Classify the value before it leaves the service.",
    ],
    answer:
      "I would allow the tenant ID if downstream services need it for routing or authorization context, and I would keep it short and validate it on every hop. I would not put an email in baggage: it is personal data, it is copied onto every request, and downstream systems may log headers or metadata. If a service needs the user identity, it should resolve it from an authenticated token or a reference, not from a value the client can set. I would also cap the entry count and size, document ownership of each key, and check that gateways and queues in our stack preserve the metadata.",
    followUps: [
      "What stops a caller from forging the tenant ID?",
      "How would you audit which baggage keys are read?",
      "What happens when baggage exceeds a gateway limit?",
    ],
    redFlags: [
      "Treats baggage as trusted because it is internal.",
      "Puts secrets or personal data in headers.",
      "Adds keys without an owner.",
    ],
    rubric: [
      "Separates routing data from identity.",
      "Names privacy and trust risk.",
      "Caps size and ownership.",
      "Checks infrastructure behavior.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every boundary on the critical path has a named carrier and an owner.",
      "Messaging and batch libraries are covered by tests that assert one trace ID.",
      "Baggage keys are documented, bounded, and free of secrets and personal data.",
      "A synthetic order can be traced end to end on demand.",
      "The team knows which spans are created by proxies and which by application code.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare trace IDs at the producer and consumer for one request.",
      "Check message metadata and the consumer's first span, not just the backend.",
      "Confirm whether the break is one hop or every hop before changing configuration.",
      "Preserve one broken trace ID as evidence for the postmortem.",
      "Record the time of the change that altered propagation.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test for the boundary that broke.",
      "Verify retries, replays, and dead-letter paths carry context safely.",
      "Reduce baggage to the values with a named consumer.",
      "Alert on root-span growth per request, not only on trace volume.",
      "Document the propagation contract next to the message schema.",
    ],
  },
];

const references = [
  {
    title: "W3C Trace Context",
    url: "https://www.w3.org/TR/trace-context/",
    publisher: "W3C",
    kind: "standard" as const,
    note: "traceparent and tracestate formats, header handling, and the trace flags field.",
  },
  {
    title: "Context propagation",
    url: "https://opentelemetry.io/docs/concepts/context-propagation/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Context, inject and extract, baggage, and propagation across process boundaries.",
  },
  {
    title: "Traces",
    url: "https://opentelemetry.io/docs/concepts/signals/traces/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Spans, parent-child relationships, trace IDs, and span context.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "otel-context": {
      model: otelContextModel,
      presets,
      instructions:
        "Start Healthy, then apply Queue context lost. Compare split checkouts and orphan roots with checkout p99, then restore queue coverage to 100.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 480 req/s path, three HTTP boundaries, and 80-byte baggage average are teaching values, not protocol limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-distributed-tracing",
    "observability-trace-critical-path",
    "observability-otel-head-sampling",
    "observability-structured-logging",
  ],
};
