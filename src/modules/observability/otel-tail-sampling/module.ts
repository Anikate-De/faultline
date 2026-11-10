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

const BUFFER_PER_COLLECTOR = 50_000;
const ERROR_SHARE = 0.002;
const BASELINE_SHARE = 0.01;

const params: ParamSpec[] = [
  {
    id: "incomingRps",
    label: "Incoming traces",
    min: 200,
    max: 12_000,
    step: 100,
    value: 2_000,
    unit: " /s",
    group: "Traffic",
    help: "Completed traces arriving at the tail-sampling tier. Each trace is held for the decision wait.",
    format: "rps",
  },
  {
    id: "decisionWait",
    label: "Decision wait",
    min: 1,
    max: 30,
    step: 1,
    value: 10,
    unit: " s",
    group: "Buffer",
    help: "How long a trace stays in memory before the policy decides. It must exceed the longest trace you need to classify.",
    format: "number",
  },
  {
    id: "collectorCount",
    label: "Collector instances",
    min: 1,
    max: 8,
    step: 1,
    value: 1,
    unit: "",
    group: "Buffer",
    help: "Tail-sampling collectors sharing the load. Capacity scales with instances when traces are routed consistently.",
    format: "count",
  },
  {
    id: "errorRetention",
    label: "Error policy retention",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Policies",
    help: "Share of error traces the policy keeps once the decision runs. A dropped trace never reaches this policy.",
    format: "percent",
  },
  {
    id: "latencyThreshold",
    label: "Slow-trace threshold",
    min: 100,
    max: 3_000,
    step: 50,
    value: 800,
    unit: "ms",
    group: "Policies",
    help: "Traces at or above this duration are retained by the latency policy. A lower threshold keeps more traces and raises cost.",
    format: "ms",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  incomingRps: number;
  decisionWait: number;
  collectorCount: number;
  errorRetention: number;
  latencyThreshold: number;
  capacity: number;
  bufferLoad: number;
  overflow: number;
  effectiveRps: number;
  slowShare: number;
  retainedFraction: number;
  retainedShare: number;
  retainedRps: number;
  missedErrors: number;
  drops: number;
}

function compute(p: Params): Computed {
  const incomingRps = Math.round(num(p, "incomingRps", 2_000));
  const decisionWait = Math.round(num(p, "decisionWait", 10));
  const collectorCount = Math.round(num(p, "collectorCount", 1));
  const errorRetention = num(p, "errorRetention", 100) / 100;
  const latencyThreshold = Math.round(num(p, "latencyThreshold", 800));
  const capacity = BUFFER_PER_COLLECTOR * collectorCount;
  const bufferLoad = (incomingRps * decisionWait) / collectorCount;
  const overflow = clamp(1 - capacity / Math.max(1, bufferLoad), 0, 1);
  const effectiveRps = incomingRps * (1 - overflow);
  const slowShare = 0.08 * Math.exp(-latencyThreshold / 300);
  const retainedFraction =
    ERROR_SHARE * errorRetention + slowShare + Math.max(0, 1 - ERROR_SHARE - slowShare) * BASELINE_SHARE;
  const retainedRps = effectiveRps * retainedFraction;
  return {
    incomingRps,
    decisionWait,
    collectorCount,
    errorRetention,
    latencyThreshold,
    capacity,
    bufferLoad,
    overflow,
    effectiveRps,
    slowShare,
    retainedFraction,
    retainedShare: (retainedRps / Math.max(1, incomingRps)) * 100,
    retainedRps,
    missedErrors: (1 - errorRetention * (1 - overflow)) * 100,
    drops: overflow * 100,
  };
}

function healthFromLoad(load: number): Health {
  if (load >= BUFFER_PER_COLLECTOR) return "crit";
  if (load >= BUFFER_PER_COLLECTOR * 0.7) return "warn";
  return "ok";
}

function healthFromRetention(share: number): Health {
  if (share >= 4) return "crit";
  if (share >= 2) return "warn";
  return "ok";
}

function healthFromMissed(value: number): Health {
  if (value >= 20) return "crit";
  if (value >= 5) return "warn";
  return "ok";
}

function fmt(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 1_000)}k`;
  return `${Math.round(value)}`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["pre-decision-drops", values.drops, 0.3],
    ["buffer-load", values.bufferLoad / 1_000, (values.bufferLoad / 1_000) * 0.03],
    ["missed-errors", values.missedErrors, 1.5],
    ["retained-share", values.retainedShare, 0.1],
    ["retained-rps", values.retainedRps, Math.max(1, values.retainedRps * 0.04)],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 9)) / 2.7) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const bufferHealth = healthFromLoad(values.bufferLoad);
  const policyHealth = healthFromMissed(values.missedErrors);
  return {
    t: 0,
    nodes: [
      {
        id: "apps",
        label: "Instrumented apps",
        kind: "service",
        health: "ok",
        sublabel: `${values.incomingRps.toLocaleString()} traces/s`,
        meta: { view: "flow" },
      },
      {
        id: "collector",
        label: "Tail sampler",
        kind: "service",
        health: bufferHealth,
        sublabel: `${values.collectorCount} instance${values.collectorCount === 1 ? "" : "s"}`,
        meta: { view: "flow" },
      },
      {
        id: "buffer",
        label: "Decision buffer",
        kind: "storage",
        health: bufferHealth,
        sublabel: `${fmt(values.bufferLoad)} / ${fmt(BUFFER_PER_COLLECTOR)} per collector`,
        detail: `Traces in memory = arrival rate × decision wait ÷ collectors. ${fmt(values.bufferLoad)} traces per collector against an illustrative capacity of ${fmt(BUFFER_PER_COLLECTOR)}.`,
        meta: { view: "flow" },
      },
      {
        id: "policy",
        label: "Policies",
        kind: "service",
        health: policyHealth,
        sublabel: `${values.errorRetention * 100}% errors, ${values.latencyThreshold}ms slow`,
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Trace store",
        kind: "storage",
        health: healthFromRetention(values.retainedShare),
        sublabel: `${values.retainedShare.toFixed(2)}% retained, ${Math.round(values.retainedRps)} traces/s`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "apps-collector", from: "apps", to: "collector", rate: 1, health: "ok" },
      { id: "collector-buffer", from: "collector", to: "buffer", rate: 1, health: bufferHealth },
      {
        id: "buffer-policy",
        from: "buffer",
        to: "policy",
        rate: 1 - values.overflow,
        health: bufferHealth,
      },
      {
        id: "policy-backend",
        from: "policy",
        to: "backend",
        rate: clamp(values.retainedShare / 100, 0, 1),
        health: healthFromRetention(values.retainedShare),
      },
    ],
    metrics: [
      metric("pre-decision-drops", "Dropped before decision", values.drops, "%", 0.5, 2, "percent"),
      metric("buffer-load", "Traces buffered per collector", values.bufferLoad / 1_000, "k traces", 35, 50, "count"),
      metric("missed-errors", "Error traces not retained", values.missedErrors, "%", 5, 20, "percent"),
      metric("retained-share", "Retained share of traces", values.retainedShare, "%", 2, 4, "percent"),
      metric("retained-rps", "Retained traces", values.retainedRps, " /s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, bufferPerCollector: BUFFER_PER_COLLECTOR },
    summary: `${values.retainedShare.toFixed(2)}% of traces retained; ${values.missedErrors.toFixed(0)}% of error traces lost; ${fmt(values.bufferLoad)} traces buffered per collector against ${fmt(BUFFER_PER_COLLECTOR)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pre-decision-drops",
    metricId: "pre-decision-drops",
    warn: 0.5,
    crit: 2,
    title: "Traces are dropped before a policy can decide",
    cause: "The decision buffer is full. Arrival rate multiplied by the decision wait exceeds the collector's capacity, so new traces are evicted before any error or latency policy evaluates them.",
    fix: "Add collectors with consistent trace routing, shorten the decision wait to the longest trace you must classify, or reduce the traces entering this tier. An error policy cannot save a trace that was evicted first.",
    checkFirst: [
      "Compare traces in memory with the configured buffer limit on each collector.",
      "Check whether trace routing sends the same trace to more than one collector.",
      "Check whether the decision wait grew after a latency investigation.",
    ],
  },
  {
    id: "buffer-load",
    metricId: "buffer-load",
    warn: 35,
    crit: 50,
    title: "The decision buffer is at its capacity",
    cause: "Every trace waits for the full decision period, so the buffer holds arrival rate times wait divided by collector count. A longer wait or a traffic peak raises memory without raising retained volume.",
    fix: "Scale the collector tier or shorten the wait. Keep the wait above the p99 of the traces you need to classify, and route traces consistently so one collector does not hold duplicates.",
    checkFirst: [
      "Compute traces in flight: traces/s × decision wait.",
      "Check memory per collector against its configured limit.",
      "Confirm that load balancing is consistent by trace ID.",
    ],
  },
  {
    id: "missed-errors",
    metricId: "missed-errors",
    warn: 5,
    crit: 20,
    title: "Error traces are not reaching storage",
    cause: "Either the error policy is disabled or the buffer evicted the trace before the policy ran. Both produce the same outcome: the one class you promised to keep is missing.",
    fix: "Enable the error policy and fix the buffer first. Then verify on a known failing request that the retained trace exists in storage.",
    checkFirst: [
      "Check the policy configuration and its evaluation order.",
      "Check pre-decision drops on the same collector.",
      "Send a synthetic failing request and follow it end to end.",
    ],
  },
  {
    id: "retained-share",
    metricId: "retained-share",
    warn: 2,
    crit: 4,
    title: "Retained traces exceed the storage budget",
    cause: "The latency threshold, the error policy, and the baseline sample all retain traces. Lowering the latency threshold raises the slow share quickly because the tail is long.",
    fix: "Raise the slow threshold, reduce the baseline sample, or keep the extra volume only for a bounded incident window. Measure retained share, not incoming volume.",
    checkFirst: [
      "Split retained traces by policy.",
      "Check the latency threshold against the actual duration distribution.",
      "Check whether baseline sampling is configured per service.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const tailSamplingModel: SimModel = {
  id: "observability-otel-tail-sampling",
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
    const jitter = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "retained-rps" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.overflow > 0.001 && frame.flags.bufferOverflowSeen !== 1) {
      pushEvent(next, {
        id: "tail-buffer-overflow",
        at: frame.t,
        severity: "crit",
        title: "Decision buffer overflows before sampling",
        detail: `${fmt(values.bufferLoad)} traces per collector against ${fmt(BUFFER_PER_COLLECTOR)} capacity. ${values.drops.toFixed(0)}% of traces are evicted before any policy runs.`,
        nodeId: "buffer",
        metricId: "pre-decision-drops",
      });
      next.flags.bufferOverflowSeen = 1;
    }
    if (values.overflow <= 0.001) next.flags.bufferOverflowSeen = 0;
    next.summary = `${values.retainedShare.toFixed(2)}% of traces retained; ${values.missedErrors.toFixed(0)}% of error traces lost; ${fmt(values.bufferLoad)} traces buffered per collector against ${fmt(BUFFER_PER_COLLECTOR)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `Traces in flight are ${values.incomingRps.toLocaleString()} × ${values.decisionWait}s ÷ ${values.collectorCount} = ${fmt(values.bufferLoad)} per collector. The illustrative buffer holds ${fmt(BUFFER_PER_COLLECTOR)}.`,
      values.overflow > 0
        ? `The buffer is over capacity, so ${values.drops.toFixed(0)}% of traces are evicted before the error and latency policies see them.`
        : `The buffer is below capacity, so every policy can evaluate a completed trace.`,
      `The latency policy keeps ${(values.slowShare * 100).toFixed(2)}% of traces at ${values.latencyThreshold}ms; lowering the threshold raises this share nonlinearly.`,
      `The error policy retains ${values.errorRetention * 100}% of errors, but ${values.missedErrors.toFixed(0)}% of error traces never reach storage after eviction.`,
      `Total retention is ${values.retainedShare.toFixed(2)}% at ${Math.round(values.retainedRps)} traces/s. The budget is a share of incoming, not a fixed count.`,
    ];
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
    description: "2,000 traces/s, a 10s wait, and one collector. Buffer and retention both sit inside budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with tight policy",
    description: "8,000 traces/s across two collectors and a 500ms slow threshold. Buffer and retention both warn.",
    tone: "warn",
    params: defaults({ incomingRps: 8_000, collectorCount: 2, latencyThreshold: 500 }),
  },
  {
    id: "failure",
    label: "Wait too long",
    description: "8,000 traces/s held for 30s on one collector. 240k traces compete for a 50k buffer.",
    tone: "crit",
    params: defaults({ incomingRps: 8_000, decisionWait: 30 }),
  },
  {
    id: "errors-dropped",
    label: "Error policy off",
    description: "The buffer is healthy, but the error policy retains nothing. Every error trace is lost after a successful decision.",
    tone: "crit",
    params: defaults({ errorRetention: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Two collectors and a 5s wait bring the buffer back under capacity while the policies stay on.",
    tone: "ok",
    params: defaults({ incomingRps: 8_000, decisionWait: 5, collectorCount: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-tail-buffer",
  title: "Predict what fails first at peak",
  simId: "otel-tail-sampling",
  question:
    "Traffic is 8,000 completed traces per second. One tail-sampling collector holds each trace for 30 seconds before deciding. The storage budget is not the constraint. What fails first?",
  prediction: {
    options: [
      { id: "buffer", label: "The decision buffer fills and drops traces before any policy runs" },
      { id: "retention", label: "The retained share rises above the storage budget" },
      { id: "latency", label: "The latency policy threshold stops matching slow traces" },
      { id: "errors", label: "The error policy starts rejecting error spans" },
    ],
    correctOptionId: "buffer",
    explanation:
      "The buffer holds arrival rate times decision wait: 8,000 × 30 = 240,000 traces on one collector. With a 50,000-trace capacity, most traces are evicted before the policy evaluates them. Storage never sees them, so the retention budget stays low while errors disappear.",
  },
  setup: defaults({ incomingRps: 8_000, decisionWait: 30 }),
  runFor: 30,
  observe: [
    "Traces buffered per collector reach 240,000 against a 50,000 capacity.",
    "Pre-decision drops reach about 79%, and the same share of error traces is lost.",
    "Retained share falls to about 0.36%, well under the budget, because the traces never arrive.",
    "The trace store looks cheap while the error policy looks broken.",
  ],
  explain:
    "A tail sampler must hold a trace until it can see the outcome. The number of traces in memory is arrival rate multiplied by the decision wait, divided by the number of collectors that share the trace. When that exceeds capacity, the collector evicts traces before the policy runs. The policy configuration is irrelevant for evicted traces, which is why an error policy can be correct and still retain nothing.",
  fix: defaults({ incomingRps: 8_000, decisionWait: 5, collectorCount: 2 }),
  debrief:
    "Two collectors and a 5s wait hold 20,000 traces each, so no trace is evicted and every error is retained. The wait still has to cover the longest trace you need to classify; shortening it below that limit trades memory for incomplete decisions. Scale out or shorten deliberately, and verify both drops and retained errors after the change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Tail sampling decides after a trace is complete. A collector buffers the spans of each trace for a decision window, then evaluates policies against the whole trace: keep it if it has an error, keep it if it is slower than a threshold, keep a small baseline sample, drop the rest. Because the decision happens at the end, the sampler can see the status code and the duration that a head sampler never sees.",
  },
  {
    type: "p",
    text: "The price is memory and a new failure mode. Every buffered trace waits for the full decision window, so a collector holds roughly arrival rate times wait. That buffer has a finite capacity. When it fills, traces are evicted before any policy runs, which means an error policy can be configured correctly and still retain nothing. The policy is only as good as the buffer in front of it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The tier sits between the instrumented services and the trace store. Applications export spans to a collector; the tail-sampling processor groups spans by trace ID, holds them for the decision wait, and forwards only retained traces. If you run several collectors, traces must be routed consistently by trace ID, or one trace can be split across instances and decided with partial data.",
  },
  {
    type: "table",
    headers: ["Policy", "What it keeps", "What it costs"],
    rows: [
      ["Error policy", "Traces with an error status or error event", "Little volume; needs the status to be recorded correctly"],
      ["Latency policy", "Traces above a duration threshold", "Volume rises quickly as the threshold falls"],
      ["Baseline sample", "A fixed share of everything else", "Predictable volume; keeps a comparison group"],
      ["Composite policy", "A union of the rules above", "The sum of their volume, unless rules are ordered to exclude duplicates"],
    ],
  },
  {
    type: "p",
    text: "The buffer capacity here is 50,000 traces per collector, an illustrative teaching value. The retention budget is 2% of incoming, also illustrative. The arithmetic is the lesson: in-flight traces equal arrival rate times decision wait, divided by collectors. A 30-second wait at 8,000 traces per second needs 240,000 slots on one collector.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Traces buffered per collector, with a warning at 70% of capacity and a critical line at capacity.",
      "Dropped before decision: the share evicted before any policy can evaluate it.",
      "Error traces not retained: the number the promise was about.",
      "Retained share of traces: the storage budget, independent of incoming volume.",
      "Retained traces per second: the absolute volume the backend receives.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that the buffer holds 20,000 traces. Apply Wait too long and watch drops and missed errors rise together while retained share falls. Then apply Recovery to see two collectors and a 5s wait restore the buffer. Run the experiment before reading the debrief; it asks which limit fails first.",
  },
  { type: "sim", simId: "otel-tail-sampling" },
  { type: "experiment", experimentId: "predict-tail-buffer" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 8,000 traces per second and a 30-second decision wait, the collector needed 240,000 buffer slots on one instance. It had 50,000. About 79% of traces were evicted before the error policy ran, so the same share of error traces disappeared. Retained share fell to 0.36%, which looks like excellent cost control until you notice that errors are missing.",
  },
  {
    type: "p",
    text: "Two collectors and a 5s wait reduced the per-collector load to 20,000 traces and removed the eviction. Every error was then retained and the storage share returned to 1.75%. The wait still matters: it must be longer than the slowest trace you need to classify, or the policy decides on a trace that is still incomplete. The buffer and the wait are a capacity decision, not a sampling preference.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Collector memory: traces in the decision buffer, or the processor's own in-memory trace count, rising with traffic and wait time.",
      "Processor telemetry: traces sampled and traces dropped, split by policy, plus decision latency.",
      "Collector logs: eviction or queue-full messages that appear before the trace store volume changes.",
      "Trace store: error traces absent while application logs and error counters still show failures.",
      "Load balancer: traces split across collectors because routing is not consistent by trace ID.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute traces in flight before you touch a policy: incoming traces per second times the decision wait, divided by collectors. Compare that with the configured buffer. If the buffer is full, fix capacity first. Then verify the error policy with a synthetic failing request that you can follow from the service to the trace store.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the eviction: add collectors, shorten the decision wait to the longest trace you must classify, or reduce the traces entering the tier.",
      "Route traces consistently by trace ID so each collector sees a complete trace once.",
      "Verify the error policy separately from the latency policy; send a failing request and confirm the retained trace.",
      "Tune the slow threshold from the duration distribution, not from a round number.",
      "Check retained share after every policy change, because a lower latency threshold can dominate the budget.",
      "Record the buffer size, wait, and collector count next to the policy configuration.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A longer decision wait covers slower traces but multiplies memory by the same factor.",
      "More collectors add capacity but require consistent trace routing and more operational surface.",
      "A lower latency threshold keeps more tails and can cross the budget quickly because the distribution is long.",
      "A baseline sample is cheap and keeps a comparison group, but it spends budget on traces no policy flagged.",
      "Tail sampling costs memory before storage. The bill can move from the backend to the collector tier without disappearing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "size-buffer",
    question:
      "How do you size a tail-sampling buffer for 10,000 traces per second and a 20-second decision wait?",
    difficulty: 3,
    hints: [
      "Use arrival rate and time in the buffer.",
      "Decide whether the capacity number is per collector or for the fleet.",
    ],
    answer:
      "The number of traces in flight is arrival rate times the decision wait, so 10,000 × 20 equals 200,000 traces for the fleet. I would divide that by the number of collectors only if traces are routed consistently and each trace lands on one collector. Then I would add headroom for traffic peaks and for spans arriving late. I would also check that the wait is longer than the slowest trace I need to classify, and monitor per-collector memory, not just the fleet average.",
    followUps: [
      "What happens if routing is not consistent?",
      "How much headroom would you add?",
      "How does a traffic peak change the number?",
    ],
    redFlags: [
      "Sizes by storage budget only.",
      "Ignores the decision wait.",
      "Divides by collectors without checking routing.",
    ],
    rubric: [
      "Uses arrival rate × wait.",
      "Distinguishes per-collector and fleet.",
      "Adds headroom.",
      "Connects wait to trace duration.",
    ],
  },
  {
    id: "errors-missing",
    question:
      "The tail sampler is configured to keep every error, but error traces are still missing. What do you check?",
    difficulty: 3,
    hints: [
      "The policy runs after the buffer.",
      "A trace can fail before the policy sees it.",
    ],
    answer:
      "I would first check pre-decision drops: if the buffer is full, traces are evicted before the error policy runs. Then I would verify that the error status is actually recorded on the span at the time the policy evaluates it, and that the policy order does not drop the trace earlier. I would also check trace routing, because a trace split across collectors may be decided with partial spans. Finally I would send a known failing request and follow it end to end.",
    followUps: [
      "How would you distinguish an eviction from a policy miss?",
      "What if only some errors are missing?",
      "How does collector routing affect the answer?",
    ],
    redFlags: [
      "Turns the error policy up and down without checking the buffer.",
      "Assumes the policy sees every trace.",
      "Ignores status recording.",
    ],
    rubric: [
      "Checks buffer drops first.",
      "Verifies status and policy order.",
      "Considers routing.",
      "Names a synthetic test.",
    ],
  },
  {
    id: "wait-tradeoff",
    question:
      "Why not set the decision wait to 60 seconds so every trace is definitely complete?",
    difficulty: 2,
    hints: [
      "Memory grows with time in the buffer.",
      "A decision is only useful if the trace is complete enough.",
    ],
    answer:
      "Because memory grows linearly with the wait. At a fixed arrival rate, doubling the wait doubles the traces held in memory, and the buffer has to be sized for the peak. A 60-second wait also delays the trace's availability for investigation. I would set the wait just above the duration of the slowest trace I need to classify, then measure evictions. If long traces matter, I would rather route them separately than hold every trace for a minute.",
    followUps: [
      "How would you handle a few traces that run longer than the wait?",
      "What does the delay do to incident response?",
      "How would you measure the right wait?",
    ],
    redFlags: [
      "Sets the maximum without doing the arithmetic.",
      "Ignores memory and delay.",
      "Assumes a longer wait is always safer.",
    ],
    rubric: [
      "Connects wait to memory.",
      "Connects wait to trace completeness.",
      "Names a measurement.",
      "Mentions investigation delay.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The buffer is sized from peak traces per second times decision wait, with headroom.",
      "Trace routing is consistent by trace ID across collectors.",
      "The decision wait covers the slowest trace the policies must classify.",
      "Error and latency policies are tested with synthetic traces.",
      "Retained share has an owner and a budget alert.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check pre-decision drops before changing a policy.",
      "Compare per-collector memory with its limit.",
      "Confirm traces are not split across collectors.",
      "Send a known failing request and verify it is retained.",
      "Record the buffer, wait, and policy values for the timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify error retention and retained share at peak traffic.",
      "Right-size the wait and the collector count together.",
      "Remove temporary policy overrides.",
      "Add a capacity test for the next traffic peak.",
      "Document the policy order and what each rule costs.",
    ],
  },
];

const references = [
  {
    title: "Tail sampling processor",
    url: "https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/tailsamplingprocessor/README.md",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Decision wait, policies, in-memory trace handling, and collector configuration.",
  },
  {
    title: "Sampling",
    url: "https://opentelemetry.io/docs/concepts/sampling/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Head versus tail sampling and the outcome information each decision can use.",
  },
  {
    title: "Collector",
    url: "https://opentelemetry.io/docs/collector/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Receivers, processors, exporters, and where tail sampling sits in the pipeline.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "otel-tail-sampling": {
      model: tailSamplingModel,
      presets,
      instructions:
        "Start Healthy, then apply Wait too long. Watch buffered traces, pre-decision drops, and missed errors move together. Apply Recovery to see capacity return, then compare Error policy off.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 50,000-trace buffer, 2% retention budget, and 0.2% error share are teaching values, not collector defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-otel-head-sampling",
    "observability-otel-context",
    "observability-datadog-apm",
    "observability-trace-critical-path",
  ],
};
