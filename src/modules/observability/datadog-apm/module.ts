import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RARE_SHARE_OF_ERRORS = 0.002;
const VISIBILITY_WINDOW_SECONDS = 300;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 500,
    max: 100_000,
    step: 500,
    value: 20_000,
    unit: " rps",
    scale: "log" as const,
    group: "Traffic",
    help: "Requests per second entering the traced services.",
    format: "rps" as const,
  },
  {
    id: "headSampleRate",
    label: "Head sample rate",
    min: 0.1,
    max: 100,
    step: 0.1,
    value: 10,
    unit: "%",
    scale: "log" as const,
    group: "Sampling",
    help: "Share of traces kept at the start of the request, before the outcome is known.",
    format: "percent" as const,
  },
  {
    id: "errorRate",
    label: "Request error rate",
    min: 0.01,
    max: 5,
    step: 0.01,
    value: 0.1,
    unit: "%",
    scale: "log" as const,
    group: "Traffic",
    help: "Share of requests that produce an error span.",
    format: "percent" as const,
  },
  {
    id: "errorCapture",
    label: "Error-biased capture",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Sampling",
    help: "Share of errors kept by an outcome-aware tail sampler after head sampling. A retention filter can only keep traces that were ingested.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  headSampleRate: number;
  errorRate: number;
  errorCapture: number;
  headShare: number;
  captureRate: number;
  errorTraces: number;
  retained: number;
  capturedRare: number;
  blindSpot: number;
  collectorCpu: number;
  volumeIndex: number;
  errorCapturePct: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const headSampleRate = clamp(num(p, "headSampleRate", 10), 0, 100);
  const errorRate = clamp(num(p, "errorRate", 0.1), 0, 100) / 100;
  const errorCapture = clamp(num(p, "errorCapture", 100), 0, 100) / 100;
  const headShare = headSampleRate / 100;
  const captureRate = headShare + (1 - headShare) * errorCapture;
  const errorTraces = requestRate * errorRate;
  const retained = requestRate * headShare + errorTraces * (1 - headShare) * errorCapture;
  const rareRate = errorTraces * RARE_SHARE_OF_ERRORS;
  const capturedRare = rareRate * captureRate;
  const blindSpot = 100 * Math.exp(-capturedRare * VISIBILITY_WINDOW_SECONDS);
  return {
    requestRate,
    headSampleRate,
    errorRate,
    errorCapture,
    headShare,
    captureRate,
    errorTraces,
    retained,
    capturedRare,
    blindSpot,
    collectorCpu: clamp(15 + (retained / 20_000) * 50 + (requestRate / 50_000) * errorCapture * 60, 0, 100),
    volumeIndex: retained / 2_000,
    errorCapturePct: captureRate * 100,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed): void {
  const seedKeys: [string, number][] = [
    ["rare-blind-spot", values.blindSpot],
    ["retained-traces", values.retained],
    ["collector-cpu", values.collectorCpu],
    ["trace-volume-index", values.volumeIndex],
    ["error-capture", values.errorCapturePct],
  ];
  for (const [id, value] of seedKeys) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + id.length) / 3.7);
      return Math.max(0, value * (0.97 + 0.03 * wave));
    });
  }
}

function buildFrame(p: Params): SimFrame {
  const values = compute(p);
  const blindHealth = healthFor(values.blindSpot, 30, 60);
  const volumeHealth = healthFor(values.retained, 8_000, 15_000);
  const cpuHealth = healthFor(values.collectorCpu, 70, 85);
  return {
    t: 0,
    nodes: [
      {
        id: "services",
        label: "Traced services",
        kind: "service",
        health: "ok",
        utilization: clamp(values.requestRate / 100_000),
        sublabel: `${values.requestRate.toLocaleString()} rps`,
        detail: "Every request produces a trace; the sampling decision happens after this point.",
        meta: { view: "flow" },
      },
      {
        id: "collector",
        label: "Collector",
        kind: "worker",
        health: cpuHealth,
        utilization: values.collectorCpu / 100,
        sublabel: `${Math.round(values.retained).toLocaleString()} traces/s kept`,
        detail: "Tail sampling buffers spans until a policy decision, so error capture has a CPU and memory cost.",
        meta: { view: "flow" },
      },
      {
        id: "sampler",
        label: "Sampling decision",
        kind: "worker",
        health: blindHealth,
        utilization: clamp(values.blindSpot / 60),
        sublabel: `${values.blindSpot.toFixed(0)}% rare blind spot`,
        detail: "The blind spot is the chance that no trace of the rare error class is retained in a five-minute window.",
        meta: { view: "flow" },
      },
      {
        id: "store",
        label: "Trace store",
        kind: "storage",
        health: volumeHealth,
        utilization: clamp(values.retained / 15_000),
        sublabel: `${values.volumeIndex.toFixed(1)}x baseline`,
        detail: `Retained volume is ${Math.round(values.retained).toLocaleString()} traces/s at an illustrative 2,000/s baseline.`,
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "Error analysis",
        kind: "service",
        health: blindHealth,
        utilization: clamp(values.blindSpot / 60),
        sublabel: `${values.errorCapturePct.toFixed(0)}% error capture`,
        detail: "A rare class with no retained trace cannot be counted, grouped, or opened.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("services-collector", "services", "collector", 1),
      edge("collector-sampler", "collector", "sampler", clamp(values.headShare + 0.05), cpuHealth),
      edge("sampler-store", "sampler", "store", clamp(values.retained / Math.max(1, values.requestRate)), blindHealth),
      edge("store-dashboard", "store", "dashboard", 0.7, volumeHealth),
    ],
    metrics: [
      metric("rare-blind-spot", "Rare-error blind spot", values.blindSpot, "%", 30, 60, "percent"),
      metric("retained-traces", "Retained traces", values.retained, " traces/s", 8_000, 15_000, "count"),
      metric("collector-cpu", "Collector CPU", values.collectorCpu, "%", 70, 85, "percent"),
      metric("trace-volume-index", "Trace volume", values.volumeIndex, "×", 3, 6, "number"),
      metric("error-capture", "Error capture", values.errorCapturePct, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {},
    summary: `${Math.round(values.retained).toLocaleString()} traces/s kept; rare-error blind spot ${values.blindSpot.toFixed(0)}%; collector CPU ${values.collectorCpu.toFixed(0)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rare-blind-spot",
    metricId: "rare-blind-spot",
    warn: 30,
    crit: 60,
    title: "A rare error class has no retained traces",
    cause:
      "Uniform head sampling kept only a small share of requests, and no error-biased policy caught the errors that head sampling dropped. The class is absent from the trace store even though it is happening.",
    fix:
      "Add an error-biased tail policy before ingestion, or a retention rule for the error traces that are already collected. A retention filter cannot recover spans that head sampling never sent. Verify that the rare class appears in a five-minute query.",
    checkFirst: [
      "Query the trace store for the rare class over the last five minutes.",
      "Compare error span counts in logs with retained error traces.",
      "Check whether the sampling decision happens before the error is known.",
    ],
  },
  {
    id: "retained-traces",
    metricId: "retained-traces",
    warn: 8_000,
    crit: 15_000,
    title: "Trace retention is above the collection budget",
    cause:
      "The head sample rate captures too many successful traces. Volume rises even when the interesting error and latency classes are already covered.",
    fix:
      "Lower the uniform head rate and compensate with an error or latency policy. Keep the traces that answer a question, not a flat share of all traffic.",
    checkFirst: [
      "Compare the head rate with the trace volume budget.",
      "Check whether successful traces dominate the retained set.",
      "Check for a retention filter that keeps everything.",
    ],
  },
  {
    id: "collector-cpu",
    metricId: "collector-cpu",
    warn: 70,
    crit: 85,
    title: "The sampling collector is saturated",
    cause:
      "Tail sampling holds spans until a decision can be made. A large request rate and an aggressive error policy increase the buffer and the work per trace.",
    fix:
      "Reduce the head volume before the collector, scale the collector, or apply the error policy at a tier that does not buffer every successful trace.",
    checkFirst: [
      "Check collector CPU and memory together.",
      "Check whether the buffer is dropping spans before the decision.",
      "Check whether the policy has a bounded timeout.",
    ],
  },
  {
    id: "trace-volume-index",
    metricId: "trace-volume-index",
    warn: 3,
    crit: 6,
    title: "Trace volume is several times the baseline",
    cause:
      "A high head sample rate or an error policy that captures far more than the error class has multiplied retention without a matching coverage gain.",
    fix:
      "Tie the sample rate to the trace budget and verify coverage of the errors and latency classes that matter. Volume alone is not coverage.",
    checkFirst: [
      "Compare retained volume with the trace budget.",
      "Check which policy retains the most spans.",
      "Confirm the rare error class is still visible after the cut.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const apmModel: SimModel = {
  id: "observability-datadog-apm",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults());
    seedSeries(frame, compute(defaults()));
    frame.flags.seed = seed;
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p);
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.blindSpot >= 60 && frame.flags.rareErrorEvent !== 1) {
      pushEvent(next, {
        id: "rare-error-unseen",
        at: frame.t,
        severity: "crit",
        title: "Rare error class is missing from traces",
        detail: `Head sampling keeps ${values.headSampleRate.toFixed(1)}% and error capture covers ${values.errorCapturePct.toFixed(0)}% of error traces. The chance of no rare-class trace in five minutes is ${values.blindSpot.toFixed(0)}%.`,
        nodeId: "sampler",
        metricId: "rare-blind-spot",
      });
      next.flags.rareErrorEvent = 1;
    }
    if (values.blindSpot < 60) next.flags.rareErrorEvent = 0;
    next.summary = `${Math.round(values.retained).toLocaleString()} traces/s kept; rare-error blind spot ${values.blindSpot.toFixed(0)}%; collector CPU ${values.collectorCpu.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Head sampling keeps ${values.headSampleRate.toFixed(1)}% of ${values.requestRate.toLocaleString()} rps, or ${Math.round(values.requestRate * values.headShare).toLocaleString()} traces/s before error policy.`,
    );
    items.push(
      `Total capture is ${values.errorCapturePct.toFixed(0)}% of error traces, and the plan retains ${Math.round(values.retained).toLocaleString()} traces/s in total.`,
    );
    items.push(
      `The rare class is modeled as ${(RARE_SHARE_OF_ERRORS * 100).toFixed(1)}% of error spans. In a five-minute window the blind spot is ${values.blindSpot.toFixed(0)}%.`,
    );
    if (values.collectorCpu >= 70) {
      items.push("Collector CPU is above the warning line because tail buffering costs work per trace, not only per retained trace.");
    } else {
      items.push("Collector CPU is below the warning line; the sampling policy is not the current cost constraint.");
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "10% head sampling plus an error policy that keeps every error span.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak volume",
    description: "Double traffic at a 25% head rate. Trace retention crosses warning; rare errors stay visible.",
    tone: "warn",
    params: defaults({ requestRate: 40_000, headSampleRate: 25, errorRate: 1, errorCapture: 50 }),
  },
  {
    id: "failure",
    label: "1% uniform",
    description: "A 1% head rate with no error capture. The rare class disappears from the trace store.",
    tone: "crit",
    params: defaults({ headSampleRate: 1, errorCapture: 0 }),
  },
  {
    id: "recovery",
    label: "Targeted recovery",
    description: "Keep 1% of normal traffic but capture every error through the error policy.",
    tone: "ok",
    params: defaults({ headSampleRate: 1, errorCapture: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-rare-trace",
  title: "Predict whether the rare class survives",
  simId: "apm",
  question:
    "The head sample rate falls to 1% and error capture is off. A class appears on 0.2% of error spans. Will the trace store show it in the next five minutes?",
  prediction: {
    options: [
      { id: "hidden", label: "No. The retained volume is too low for the rare class to appear reliably" },
      { id: "visible", label: "Yes. Every error is retained because errors bypass sampling" },
      { id: "visible-slow", label: "Yes, but only after the collector buffer drains" },
      { id: "no-change", label: "The trace store sees the same data as before" },
    ],
    correctOptionId: "hidden",
    explanation:
      "Head sampling decides before the request outcome is known. At 1%, only one in a hundred error spans survives, and the rare class is a small share of errors. The expected count in a five-minute window is well below one, so the class can be absent even though it is occurring.",
  },
  setup: defaults({ headSampleRate: 1, errorCapture: 0 }),
  runFor: 20,
  observe: [
    "Retained traces fall from about 2,018/s to 200/s.",
    "The rare-error blind spot rises to roughly 89%.",
    "Collector CPU falls because almost nothing is retained, which can look like a healthy cost cut.",
    "The trace volume index falls below one, but coverage of the rare class is gone.",
  ],
  explain:
    "The rare class is 0.2% of error spans. At a 0.1% request error rate and 20,000 rps, that is about 0.04 rare errors per second. A 1% head rate keeps 0.0004 per second, or about 0.12 in five minutes. The probability of retaining none is above 88%. Cheap sampling is not wrong by itself; it is wrong when the decision happens before the outcome you need.",
  fix: defaults({ headSampleRate: 1, errorCapture: 100 }),
  debrief:
    "Keeping the 1% head rate and adding a 100% error policy restores rare-class visibility while retaining only about 220 traces per second. The tradeoff moves to the collector: tail sampling buffers spans until the decision, so CPU and memory become the next constraint. The design goal is coverage per retained trace, not the lowest sample rate.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Application performance monitoring (APM) turns requests into distributed traces: a trace is the whole request, and each span is one unit of work inside it. Tracing every request is expensive, so most systems sample. Head sampling decides at the start of the request, when the outcome is unknown. Tail sampling waits for the trace to finish, then applies policies such as keep every error, keep slow traces, or keep a small share of the rest.",
  },
  {
    type: "p",
    text: "The trap is that a uniform head rate is blind to rarity. A 1% sample of a high-volume request stream can look generous in aggregate while a specific error class appears only a few times per hour. The trace store then has no example to count, group, or open, and the team concludes the error is gone. The failure is not a dropped trace; it is a missing question.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is service, collector, sampling decision, trace store, then query. Head sampling happens before the collector sees the completed trace. Error-biased or tail sampling happens after the spans are buffered, so it can keep errors that head sampling would have dropped. Datadog retention filters and OpenTelemetry tail-sampling processors sit at different points in that path, and mixing them without a coverage check can hide a class twice. In this model, 100% error capture represents an outcome-aware OpenTelemetry tail policy; a Datadog retention filter can only keep traces that were already ingested.",
  },
  {
    type: "table",
    headers: ["Control", "When it decides", "What it can preserve", "What it costs"],
    rows: [
      ["Head sampling", "At request start", "A uniform share of all traffic", "Almost no collector buffering"],
      ["Error-biased tail", "After spans finish", "All or most error traces", "Buffer and CPU per traced request"],
      ["Retention filter", "After ingestion", "Selected traces kept queryable", "Storage and indexing at the vendor"],
      ["No sampling", "Never drops", "Everything", "Highest collection and retention cost"],
    ],
  },
  {
    type: "p",
    text: "The model assumes a fixed rare class equal to 0.2% of error spans and a five-minute visibility window. Those are teaching assumptions, not provider limits. The useful question is not whether the sample rate is high or low. It is whether the retained set contains the class you need to answer the next incident question.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Retained traces per second and a trace volume index against an illustrative baseline.",
      "Rare-error blind spot: the modeled chance that no trace of the rare class is retained in five minutes.",
      "Collector CPU, which rises with tail buffering even when the retained volume is low.",
      "Error capture as a percentage of error traces, separate from the head sample rate.",
      "A five-node path from services to the error-analysis view.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that error capture is 100% while the head rate is only 10%. Apply 1% uniform. Watch the blind spot rise as retained volume falls. Then apply Targeted recovery and compare coverage per retained trace. Run the experiment before reading the debrief.",
  },
  {
    type: "p",
    text: "The numbers are deliberately small: one rare class, one error policy, and a fixed visibility window. They are not a Datadog quota or an OpenTelemetry guarantee. The shape of the lesson is the separation between the head decision and the outcome-aware decision.",
  },
  { type: "sim", simId: "apm" },
  { type: "experiment", experimentId: "predict-rare-trace" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The 1% head rate kept 200 traces per second from 20,000 rps. With error capture off, the rare class at 0.2% of error spans produced about 0.04 events per second, and 1% of those survived: roughly 0.0004 per second. In a five-minute window the chance of keeping none was about 89%. The volume metric looked excellent; the coverage metric failed.",
  },
  {
    type: "p",
    text: "Targeted recovery kept the same 1% head rate and added a 100% error policy. Retained volume rose only to about 220 per second, but the rare-class blind spot fell to nearly zero. The cost moved from storage volume to collector work: tail sampling must hold spans until the outcome is known.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Trace search: zero results for an error class that logs show is still occurring.",
      "Sampling configuration: a low head rate with no error or latency policy, often set once and never revisited.",
      "Collector metrics: buffer usage, dropped spans, CPU, and memory when tail sampling is enabled.",
      "Retention filters: a filter that keeps only a narrow service or environment, excluding the failing path.",
      "Volume dashboards: retained spans falling after a cost cut, with no coverage check for errors or latency outliers.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare error counts in logs with retained error traces for the same five minutes. If logs show the class and traces do not, the sampling decision is the suspect. Check the head rate, the error policy, and the retention filter in that order.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the missing class in logs or metrics before changing the sample rate.",
      "Add an error policy that keeps error spans regardless of the head decision.",
      "Keep the head rate low enough to bound volume, then verify rare-class coverage in a short window.",
      "Add a latency policy for slow traces if the incident question is tail latency rather than errors.",
      "Watch collector CPU and buffer drops; tail sampling moves cost rather than removing it.",
      "Re-query the rare class after the change and record the coverage result in the runbook.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Uniform head sampling is cheap and simple, but it cannot prioritize an outcome it has not seen.",
      "Tail sampling preserves errors and slow traces, but it buffers spans and adds collector CPU and memory.",
      "Retention filters reduce stored volume after ingestion; they cannot recover a trace that was never collected.",
      "A high error-capture rate can retain a flood during a broad outage. Bound it with a rate limit or a policy budget.",
      "Every sampling plan needs a coverage check. Retained volume alone measures cost, not usefulness.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "head-vs-tail",
    question:
      "Explain the difference between head sampling and tail sampling, and which one you would use to keep every timeout.",
    difficulty: 2,
    hints: [
      "One decides before the outcome exists.",
      "Buffering is the price of knowing the outcome.",
    ],
    answer:
      "Head sampling decides at the start of the trace, using information available then, such as a random value or a route. It is cheap because no buffering is needed, but it cannot guarantee that a timeout is kept. Tail sampling waits for the trace to complete, buffers the spans, and applies policies such as keep errors, keep traces over a latency threshold, or keep a sample of the rest. To keep every timeout I would use a tail policy with a latency threshold, plus a bounded fallback if the buffer fills. The cost is collector memory and CPU, and the policy must have a clear timeout.",
    followUps: [
      "What happens when the tail buffer fills?",
      "How would you keep every error without keeping every success?",
      "Where would a retention filter fit?",
    ],
    redFlags: [
      "Says head sampling can filter on error after the fact.",
      "Ignores buffer limits.",
      "Confuses collection with retention.",
    ],
    rubric: [
      "States when each decision happens.",
      "Names the buffering cost.",
      "Gives a bounded tail policy.",
      "Distinguishes retention from collection.",
    ],
  },
  {
    id: "rare-class",
    question:
      "A 1% sample is missing a 0.2% error class. Walk through the arithmetic and the fix.",
    difficulty: 3,
    hints: [
      "Start from error spans per second, then apply the rare share and the sample.",
      "One retained trace in a window is a coverage question, not an average.",
    ],
    answer:
      "I would compute error spans per second from request rate and error rate, multiply by the rare class share, then by the effective capture rate. At 20,000 rps and a 0.1% error rate, there are 20 error spans per second. If the rare class is 0.2% of errors, that is 0.04 per second. A 1% uniform sample keeps 0.0004 per second, or about 0.12 in five minutes, so the chance of seeing none is high. The fix is an error-biased policy that keeps that class at or near 100%, while the head rate stays low. Then I would verify the class appears in a five-minute query and watch the collector buffer.",
    followUps: [
      "What if the class is 0.2% of requests, not errors?",
      "How would you set the retention window?",
      "What would make you raise the head rate instead?",
    ],
    redFlags: [
      "Multiplies the sample rate by traffic and stops.",
      "Assumes an average guarantees a sample.",
      "Raises the head rate without a budget.",
    ],
    rubric: [
      "Computes events per window.",
      "Separates rare share from sample rate.",
      "Uses an outcome-aware policy.",
      "Verifies coverage and cost.",
    ],
  },
  {
    id: "cost-cut",
    question:
      "Finance asks you to cut trace cost by 60%. How do you do it without losing the errors that matter?",
    difficulty: 3,
    hints: [
      "Rank traces by the question they answer.",
      "Cut the uniform share before the error policy.",
    ],
    answer:
      "I would first measure retained volume by category: successful fast traces, errors, slow traces, and debug traffic. The uniform share of successful fast traces is usually the cheapest thing to cut because it answers the fewest incident questions. I would lower the head rate, keep the error and latency policies, and check the coverage of the classes the team actually uses. I would also look for noisy services, health checks, or duplicate spans before changing the global rate. The 60% target is a budget; the constraint is that the retained set still contains the rare failures and tail latency examples.",
    followUps: [
      "How would you prove coverage did not fall?",
      "What would you cut first if errors are 40% of volume?",
      "How do you handle a team that wants all its traces?",
    ],
    redFlags: [
      "Cuts the sample rate uniformly.",
      "Drops error traces to hit the number.",
      "Has no coverage measure.",
    ],
    rubric: [
      "Segments volume by value.",
      "Protects error and latency coverage.",
      "Checks noisy sources first.",
      "Defines a coverage check.",
    ],
  },
  {
    id: "retention-filter",
    question:
      "A retention filter keeps only production traces, but the rare error happens in a canary environment. What went wrong, and how do you prevent it?",
    difficulty: 3,
    hints: [
      "Retention is a second sampling decision.",
      "A filter is a query over tags, not a business priority.",
    ],
    answer:
      "The retention filter applied a second, independent decision after collection. It kept production because that was the assumed default, and the canary tag did not match. The rare error was collected but not retained, so it became unqueryable. I would make the filter explicit about environments and add an error policy that retains errors regardless of environment, or at least includes the canary during a rollout. I would test the filter with a known error trace before relying on it, and I would document that collection coverage and retention coverage are separate guarantees.",
    followUps: [
      "How would you test a retention filter?",
      "What if the canary is intentionally low-volume?",
      "Which team owns the filter?",
    ],
    redFlags: [
      "Assumes collected means queryable.",
      "Blames the canary for being noisy.",
      "Adds another filter without testing.",
    ],
    rubric: [
      "Separates collection from retention.",
      "Names the tag mismatch.",
      "Adds an error-aware rule.",
      "Tests the filter.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document the head sample rate, error policy, and retention filter for every environment.",
      "Estimate rare-class visibility from traffic, error rate, and the sample.",
      "Alert on collector buffer drops and CPU, not only retained volume.",
      "Keep a known error trace that can test the retention path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare log error counts with retained error traces for the same window.",
      "Check the head decision before blaming the application.",
      "Add an error policy or widen the retention filter for the affected class.",
      "Watch collector CPU and buffer usage after raising capture.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the rare class is queryable and countable.",
      "Record the coverage check and the retained volume.",
      "Remove temporary filters and reconcile the sampling configuration.",
      "Add a regression check for the next low-volume error class.",
    ],
  },
];

const references = [
  {
    title: "Trace Ingestion Mechanisms",
    url: "https://docs.datadoghq.com/tracing/trace_pipeline/ingestion_mechanisms/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Head-based sampling, retention filters, and ingestion controls.",
  },
  {
    title: "Sampling",
    url: "https://opentelemetry.io/docs/concepts/sampling/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Head sampling, tail sampling, and the tradeoff between volume and coverage.",
  },
  {
    title: "Ingestion Controls",
    url: "https://docs.datadoghq.com/tracing/trace_pipeline/ingestion_controls/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Sampling rates by service and environment.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    apm: {
      model: apmModel,
      presets,
      instructions:
        "Start Healthy, then apply 1% uniform. Compare the rare-error blind spot, retained volume, and collector CPU. Apply Targeted recovery to see coverage return at low volume.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The rare-class share, five-minute window, collector CPU curve, and 2,000/s baseline are teaching values, not provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-otel-tail-sampling",
    "observability-datadog-metric-cost",
    "observability-telemetry-cost",
    "foundations-percentiles",
  ],
};
