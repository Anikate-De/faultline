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
import { metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WINDOW_SECONDS = 300;
const SECONDS_PER_DAY = 86_400;

const params: ParamSpec[] = [
  {
    id: "sampleRate",
    label: "Head sampling rate",
    min: 0.1,
    max: 100,
    step: 0.1,
    value: 20,
    unit: "%",
    scale: "log",
    group: "Sampler",
    help: "Share of root traces the SDK records. The decision is made at span start, before status or duration is known.",
    format: "percent",
  },
  {
    id: "incidentRps",
    label: "Traffic on the affected path",
    min: 10,
    max: 2_000,
    step: 10,
    value: 60,
    unit: " req/s",
    group: "Workload",
    help: "Requests per second through the endpoint that produces the rare error class.",
    format: "rps",
  },
  {
    id: "errorShare",
    label: "Rare error share",
    min: 0.01,
    max: 5,
    step: 0.01,
    value: 0.1,
    unit: "%",
    group: "Workload",
    help: "Share of requests on this path that fail with the class you are trying to observe.",
    format: "percent",
  },
  {
    id: "spansPerTrace",
    label: "Spans per trace",
    min: 5,
    max: 40,
    step: 1,
    value: 12,
    unit: " spans",
    group: "Cost",
    help: "Average spans recorded for a retained trace. This multiplies the stored volume, not the error visibility.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  sampleRate: number;
  incidentRps: number;
  errorShare: number;
  spansPerTrace: number;
  errorsPerWindow: number;
  capturedErrors: number;
  blindSpot: number;
  storedSpans: number;
  storedTraces: number;
}

function compute(p: Params): Computed {
  const sampleRate = num(p, "sampleRate", 20);
  const incidentRps = Math.round(num(p, "incidentRps", 60));
  const errorShare = num(p, "errorShare", 0.1);
  const spansPerTrace = Math.round(num(p, "spansPerTrace", 12));
  const rate = sampleRate / 100;
  const errorsPerWindow = incidentRps * (errorShare / 100) * WINDOW_SECONDS;
  const capturedErrors = errorsPerWindow * rate;
  return {
    sampleRate,
    incidentRps,
    errorShare,
    spansPerTrace,
    errorsPerWindow,
    capturedErrors,
    blindSpot: Math.exp(-capturedErrors) * 100,
    storedSpans: incidentRps * rate * spansPerTrace * SECONDS_PER_DAY,
    storedTraces: incidentRps * rate * SECONDS_PER_DAY,
  };
}

function healthForBlindSpot(value: number): Health {
  if (value >= 40) return "crit";
  if (value >= 10) return "warn";
  return "ok";
}

function healthForSpans(value: number): Health {
  if (value >= 60_000_000) return "crit";
  if (value >= 25_000_000) return "warn";
  return "ok";
}

function fmtMillions(value: number): string {
  return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 1 : 2)}M`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["blind-spot", values.blindSpot, 3],
    ["captured-errors", values.capturedErrors, 0.2],
    ["stored-spans", values.storedSpans / 1_000_000, (values.storedSpans / 1_000_000) * 0.02],
    ["sample-rate", values.sampleRate, 0.5],
    ["stored-traces", values.storedTraces / 1_000_000, (values.storedTraces / 1_000_000) * 0.02],
    ["checkout-p99", 210, 2],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 7)) / 2.9) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Checkout client",
        kind: "client",
        health: "ok",
        throughput: values.incidentRps,
        sublabel: `${values.incidentRps} req/s`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge router",
        kind: "lb",
        health: "ok",
        throughput: values.incidentRps,
        sublabel: "root span starts",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: "ok",
        throughput: values.incidentRps,
        sublabel: `${values.errorsPerWindow.toFixed(1)} errors / 5 min`,
        meta: { view: "flow" },
      },
      {
        id: "collector",
        label: "OTel collector",
        kind: "service",
        health: "ok",
        sublabel: `receives ${values.incidentRps} traces/s`,
        meta: { view: "flow" },
      },
      {
        id: "sampler",
        label: "Head sampler",
        kind: "service",
        health: healthForBlindSpot(values.blindSpot),
        sublabel: `${values.sampleRate}% sampled, ${Math.round(values.incidentRps * (values.sampleRate / 100))} req/s`,
        detail: `The sampler decides before the request completes. A rare class has ${values.capturedErrors.toFixed(2)} expected captures in a five-minute window.`,
        meta: { view: "flow" },
      },
      {
        id: "traces",
        label: "Trace store",
        kind: "storage",
        health: healthForSpans(values.storedSpans),
        sublabel: `${fmtMillions(values.storedSpans)} spans/day`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "client-edge", from: "client", to: "edge", rate: 1, health: "ok" },
      { id: "edge-checkout", from: "edge", to: "checkout", rate: 1, health: "ok" },
      { id: "checkout-collector", from: "checkout", to: "collector", rate: 1, health: "ok" },
      { id: "collector-sampler", from: "collector", to: "sampler", rate: 1, health: "ok" },
      {
        id: "sampler-traces",
        from: "sampler",
        to: "traces",
        rate: values.sampleRate / 100,
        health: healthForSpans(values.storedSpans),
      },
    ],
    metrics: [
      metric("blind-spot", "Rare-class blind spot", values.blindSpot, "%", 10, 40, "percent"),
      metric("captured-errors", "Captured error spans / 5 min", values.capturedErrors, "", undefined, undefined, "number"),
      metric("stored-spans", "Stored spans per day", values.storedSpans / 1_000_000, "M spans/day", 25, 60, "count"),
      metric("sample-rate", "Head sample rate", values.sampleRate, "%", undefined, undefined, "percent"),
      metric("stored-traces", "Stored traces per day", values.storedTraces / 1_000_000, "M traces/day", undefined, undefined, "count"),
      metric("checkout-p99", "Checkout p99", 210, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.blindSpot.toFixed(1)}% blind spot for a ${values.errorShare}% error class; ${values.capturedErrors.toFixed(2)} expected captures per 5 min; ${fmtMillions(values.storedSpans)} spans/day.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blind-spot",
    metricId: "blind-spot",
    warn: 10,
    crit: 40,
    title: "The rare error class has no trace evidence",
    cause: "Head sampling keeps a fixed fraction of roots before the outcome is known. At a low rate, the expected number of captures for a rare class in a short window falls below one, so most windows contain no example.",
    fix: "Raise the head rate for the affected endpoint, or move the decision to a tail sampler that can see status and duration. Keep a metric or log counter for the class during the investigation.",
    checkFirst: [
      "Compute expected captures: rps × error share × sample rate × window.",
      "Search the class in traces for the last hour, not only the current window.",
      "Check whether the SDK sampler is overridden per service or environment.",
    ],
  },
  {
    id: "stored-spans",
    metricId: "stored-spans",
    warn: 25,
    crit: 60,
    title: "Trace storage is over the daily span budget",
    cause: "Raising the head rate multiplies stored spans by request rate and spans per trace. The cost rises even for traffic that is healthy and uninteresting.",
    fix: "Keep the high rate only for the path under investigation, or use tail sampling so the budget is spent on errors and latency outliers instead of every root.",
    checkFirst: [
      "Split stored spans by service and endpoint.",
      "Check spans per trace after a release that added instrumentation.",
      "Confirm whether the budget is a hard quota or a charge threshold.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const headSamplingModel: SimModel = {
  id: "observability-otel-head-sampling",
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
    if (values.sampleRate < 5 && frame.flags.rareClassSeen !== 1) {
      pushEvent(next, {
        id: "rare-class-sampled-away",
        at: frame.t,
        severity: "warn",
        title: "Rare error class is below the sampling floor",
        detail: `At ${values.sampleRate}% head sampling, the class yields ${values.capturedErrors.toFixed(2)} expected captures in five minutes. The blind spot is ${values.blindSpot.toFixed(0)}%.`,
        nodeId: "sampler",
        metricId: "blind-spot",
      });
      next.flags.rareClassSeen = 1;
    }
    if (values.sampleRate >= 5) next.flags.rareClassSeen = 0;
    next.summary = `${values.blindSpot.toFixed(1)}% blind spot for a ${values.errorShare}% error class; ${values.capturedErrors.toFixed(2)} expected captures per 5 min; ${fmtMillions(values.storedSpans)} spans/day.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `At ${values.sampleRate}% sampling, the root decision keeps ${values.sampleRate}% of requests before the status code exists. The sampler cannot choose this request because it fails.`,
      `A ${values.errorShare}% class on ${values.incidentRps} req/s produces ${values.errorsPerWindow.toFixed(1)} errors per five minutes; at this rate, ${values.capturedErrors.toFixed(2)} are expected in traces.`,
      `With an expected count of ${values.capturedErrors.toFixed(2)}, the Poisson probability of zero captures is about ${values.blindSpot.toFixed(0)}%. One quiet window proves nothing.`,
      `Stored volume is ${fmtMillions(values.storedSpans)} spans per day at ${values.spansPerTrace} spans per trace. Raising the rate raises cost linearly with traffic.`,
      `Head sampling remains unbiased for overall request volume, latency percentiles, and error rate at high counts. It is not a tool for rare classes.`,
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Blind spot", tone: "warn" },
    { label: "No evidence", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Twenty percent sampling at 60 req/s. The rare class still yields about 3.6 expected captures per five minutes.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Five percent sampling at 800 req/s. Rare-class visibility is good, but stored spans cross the warning budget.",
    tone: "warn",
    params: defaults({ sampleRate: 5, incidentRps: 800 }),
  },
  {
    id: "failure",
    label: "One percent",
    description: "One percent at 60 req/s. Most five-minute windows capture no instance of the 0.1% error class.",
    tone: "crit",
    params: defaults({ sampleRate: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Raise this path to 30% and keep the span budget. Expected captures rise to 5.4 per window.",
    tone: "ok",
    params: defaults({ sampleRate: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-head-sample",
  title: "Predict what 1% sampling keeps",
  simId: "otel-head-sampling",
  question:
    "A 0.1% error class hits 60 requests per second on one endpoint. You set head sampling to 1%. What will a five-minute incident window contain?",
  prediction: {
    options: [
      { id: "mostly-empty", label: "About 0.2 error spans are expected, so most windows contain none" },
      { id: "all-errors", label: "Every error is kept because the sampler sees the status code before deciding" },
      { id: "more-errors", label: "The error rate rises because unsampled requests are not retried" },
      { id: "p99-wrong", label: "The p99 latency becomes inaccurate but error traces remain complete" },
    ],
    correctOptionId: "mostly-empty",
    explanation:
      "The root decision happens at span creation, before the response exists. The expected captures are request rate × error share × sampling rate × window, which is 0.18 here. The probability of seeing zero is about 84%, so absence of evidence is the normal outcome.",
  },
  setup: defaults({ sampleRate: 1 }),
  runFor: 20,
  observe: [
    "Captured error spans fall to 0.18 per five-minute window and the blind spot rises to 84%.",
    "Stored spans fall to 0.62M per day; the cost metric looks excellent.",
    "The sampler node turns critical while every request-level metric stays normal.",
    "The checkout p99 stays near 210ms; latency is not the problem this setting breaks.",
  ],
  explain:
    "Head sampling is a volume tool. It reduces stored spans by keeping a fixed share of roots, and it is unbiased when you count many requests. A rare class is different: the count of retained examples is small enough that randomness decides whether you see one. You cannot fix that by looking harder at the trace store, because the evidence was never recorded.",
  fix: defaults({ sampleRate: 30 }),
  debrief:
    "Raising this path to 30% produces 5.4 expected captures per window and a blind spot below 1%, while staying under the span budget. That works for one endpoint. At fleet scale the same rate is expensive, which is why error-biased tail sampling exists. Until then, keep a counter or structured log for the class so the symptom is visible even when the trace is not.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Head sampling decides whether to record a trace when the root span starts. OpenTelemetry SDKs commonly implement it as a ratio over the trace ID, so the same decision is consistent for every span in that trace. The decision is carried in the trace flags, and child services inherit it with a parent-based sampler. The sampler is stateless, cheap, and runs before the request has a status code or a duration.",
  },
  {
    type: "p",
    text: "That timing is the whole tradeoff. A head sampler can keep 5% of traffic without knowing which requests will fail. It is unbiased for counts that are large, such as total request rate or the p50 of a busy endpoint. It is unreliable for outcomes that are rare, because the number of retained examples can be less than one per incident window. A low sampled error count is not proof that errors are rare; it may be proof that the sampler dropped them.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The decision sits at the start of the trace, in the SDK or the collector's first receiver, before spans are exported. It is not a filter on completed data. Once the root is dropped, no downstream service can recover the trace, and a parent-based sampler will drop its children too. This is why a per-service sampler change or a collector tail policy cannot repair a trace that was never recorded at the root.",
  },
  {
    type: "table",
    headers: ["Decision point", "Knows the outcome", "Cost at high volume", "Good for"],
    rows: [
      ["Head sampler at the root", "No", "Low; work is skipped early", "Volume reduction, overall latency and traffic"],
      ["Head sampler by route", "Route only", "Low", "Keeping checkout while dropping health checks"],
      ["Tail sampler after completion", "Status and duration", "Higher; traces are buffered", "Rare errors, timeouts, slow outliers"],
      ["Metric or log counter", "Any event you emit", "Independent of traces", "Proving a rare class exists at all"],
    ],
  },
  {
    type: "p",
    text: "The model treats the blind spot as a probability. If the expected number of captured error spans in a window is λ, the chance of zero captures is approximated by e to the power of negative λ. This is a teaching model for a Poisson arrival process, not a guarantee about your traffic, and the five-minute window and daily span budget are illustrative.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Rare-class blind spot: the probability that a five-minute window contains no captured error span.",
      "Captured error spans per five minutes: the expected count, not a rate to celebrate when it is low.",
      "Stored spans per day: the cost that falls when the sample rate falls.",
      "Checkout p99 as a flat control: sampling changes evidence, not request latency.",
      "Head sample rate and stored traces: the two levers behind every other number.",
      "A sampler node that turns critical while request latency and traffic remain healthy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that 20% still produces about 3.6 expected captures for this class. Apply One percent and watch the blind spot cross 80% while stored spans fall. Then use the sample-rate slider to find a rate that keeps the blind spot below 10% without crossing the span budget. The experiment asks you to predict the direction before you move it.",
  },
  { type: "sim", simId: "otel-head-sampling" },
  { type: "experiment", experimentId: "predict-head-sample" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 1% sampling, the expected number of captured error spans for this class fell to 0.18 per five-minute window. The probability of a window with no example was about 84%. The stored span count fell with it, which is exactly what the sampler was asked to do. The cost metric improved while the evidence disappeared.",
  },
  {
    type: "p",
    text: "The sampler node went critical because its blind spot crossed the visibility budget, not because requests failed. Checkout p99 and traffic stayed normal. That split is the lesson: head sampling changes what you can prove, not what users experience. If the incident is real, users are already affected. If the error class is rare, the trace store may simply have no record of it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "SDK configuration: a sampler such as TraceIdRatioBased at the service that owns the root span.",
      "Trace flags: sampled or not-sampled on the trace context, inherited by child services.",
      "Trace search: the rare class returns few or no traces while the log or metric counter shows it is happening.",
      "Span volume: stored spans fall by roughly the same factor as the sample rate.",
      "A parent-based sampler: a service cannot raise the rate above the root decision.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute the expected captures before you conclude the class is gone. Multiply request rate by error share, sampling rate, and the window length. If the result is below one, absence is expected. Then check the SDK sampler and the root service. A downstream service cannot recover a trace that was dropped at the root.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "During the investigation, raise the head rate for the affected route or service. Scope it so the span budget does not move everywhere.",
      "Emit a counter or structured log for the error class so you have evidence even when traces miss it.",
      "Move rare-outcome retention to a tail sampler that can see status and duration.",
      "Use route or attribute-based head sampling to keep the endpoints that matter and drop the high-volume noise.",
      "Verify the rate on the root service; child services must not override the parent decision.",
      "Return the rate to its baseline after the incident and record why the temporary rate was needed.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Every point of head sampling trades cost for evidence. The curve is linear for cost and nonlinear for rare-outcome visibility.",
      "Sampling by route keeps the important endpoints but encodes a guess about importance that must be maintained.",
      "Tail sampling spends the budget on completed traces, which costs buffering and collector memory before the decision.",
      "Unsampled traces cannot be rebuilt later. A metric counter is a cheap insurance policy, not a replacement for a trace.",
      "A low sampled error count is ambiguous. Treat it as a measurement of the sampler until you prove otherwise.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-missing-class",
    question:
      "A rare error class has no traces but the log counter shows it is still happening. How do you decide whether this is a sampling problem?",
    difficulty: 2,
    hints: [
      "Estimate retained examples, not just the error rate.",
      "Check where the sampling decision is made.",
    ],
    answer:
      "I would estimate the expected captures. I need the request rate for the endpoint, the error share, the sampling rate, and the window. If the product is below one, zero traces is the expected outcome. Then I would confirm the sampler at the root service and check that child services use a parent-based sampler. I would also check trace flags and whether a collector is filtering. If the expected count is well above one and there are still no traces, I would look for an export or filter bug instead of raising the rate.",
    followUps: [
      "What window length would you use for the estimate?",
      "How would you prove the sampler is the cause?",
      "What evidence would you keep alongside traces?",
    ],
    redFlags: [
      "Raises the sample rate before estimating.",
      "Blames the vendor without checking the root sampler.",
      "Treats zero traces as zero errors.",
    ],
    rubric: [
      "Computes expected captures.",
      "Checks the root decision point.",
      "Separates filtering from sampling.",
      "Names a non-trace evidence source.",
    ],
  },
  {
    id: "choose-rate",
    question:
      "You have a fixed span budget and one critical endpoint. How do you choose a head sampling rate, and what do you tell the product team it cannot answer?",
    difficulty: 3,
    hints: [
      "Start from the budget, then from the questions.",
      "State the blind spot explicitly.",
    ],
    answer:
      "I would start with the stored span budget and the request rate, then choose the highest rate that fits. I would scope it: keep the critical endpoint at a higher rate and drop high-volume, low-value paths to a lower one. Then I would write down which questions the rate can answer. It can answer overall traffic, latency distributions, and high-count error rates. It cannot reliably answer a class whose expected captures per incident window fall below one. For those I would add a counter, a structured log, or a tail policy.",
    followUps: [
      "How would you measure whether the rate is too low?",
      "What would make you change the decision per route?",
      "When is 100% sampling justified?",
    ],
    redFlags: [
      "Picks a rate by convention without doing the arithmetic.",
      "Promises rare-class coverage from a head sample.",
      "Samples everything at 1% and calls it governance.",
    ],
    rubric: [
      "Starts from budget and traffic.",
      "Scopes by route or service.",
      "States the blind spot quantitatively.",
      "Adds complementary evidence.",
    ],
  },
  {
    id: "head-vs-tail",
    question:
      "Why can a tail sampler keep every error while a head sampler cannot, and what does the tail sampler cost?",
    difficulty: 2,
    hints: [
      "The decision moves after the trace is complete.",
      "Buffering is the price of seeing the outcome.",
    ],
    answer:
      "A tail sampler waits until the trace is complete, then applies policies based on status, duration, or attributes. It can keep all errors and slow traces while sampling the rest, so the budget goes to the interesting outcomes. The cost is that the collector must buffer traces for a decision window, which consumes memory and adds a place where traces can be dropped before the decision. The buffer must be sized for the highest traffic times the decision wait, and that is a capacity limit separate from the storage budget.",
    followUps: [
      "What happens when the buffer fills?",
      "How does the decision wait affect memory?",
      "Would you combine head and tail sampling?",
    ],
    redFlags: [
      "Says tail sampling is free because it stores less.",
      "Ignores the buffer.",
      "Promises every error without capacity planning.",
    ],
    rubric: [
      "Explains the decision point.",
      "Describes outcome-based policies.",
      "Names buffer memory and drops.",
      "Connects wait time to capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The head sampling rate is documented per service and per route.",
      "The root service owns the decision; child services use a parent-based sampler.",
      "Rare error classes have a counter or log line independent of traces.",
      "The span budget is translated into a maximum rate at current traffic.",
      "Someone has computed the expected captures for the classes that matter.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the expected captures before concluding the class is absent.",
      "Confirm the sampler and trace flags at the root service.",
      "Raise the rate only for the affected path or service.",
      "Preserve a metric or log sample of the class while traces are sparse.",
      "Record the rate change and its cost for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Return the rate to baseline and verify the span budget.",
      "Add a tail policy or a dedicated counter for the class.",
      "Review whether route-based sampling matches current priorities.",
      "Test that a temporary rate change does not require a redeploy.",
      "Document the blind spot next to the sampling configuration.",
    ],
  },
];

const references = [
  {
    title: "Sampling",
    url: "https://opentelemetry.io/docs/concepts/sampling/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Head and tail sampling, consistent probability, and the limits of decisions made at trace start.",
  },
  {
    title: "Trace SDK",
    url: "https://opentelemetry.io/docs/specs/otel/trace/sdk/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Sampler interface, parent-based sampling, and trace flags.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "otel-head-sampling": {
      model: headSamplingModel,
      presets,
      instructions:
        "Start Healthy, then apply One percent. Watch the blind spot rise while stored spans fall. Use the sampler slider to find a rate that keeps both metrics inside their budgets.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The five-minute window and daily span budgets are teaching values, not provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-otel-context",
    "observability-otel-tail-sampling",
    "observability-datadog-apm",
    "observability-golden-signals",
  ],
};
