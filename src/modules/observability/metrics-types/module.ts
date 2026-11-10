import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Events per second",
    min: 20,
    max: 2_000,
    step: 10,
    value: 200,
    unit: " /s",
    group: "Counter",
    help: "Rate at which the counter increments. The true event rate is independent of the query.",
    format: "number",
  },
  {
    id: "deployAge",
    label: "Time since deploy reset",
    min: 0,
    max: 900,
    step: 5,
    value: 600,
    unit: " s",
    group: "Counter",
    help: "Seconds since the process restarted and the counter reset to zero, relative to now.",
    format: "number",
  },
  {
    id: "queryWindow",
    label: "Query window",
    min: 15,
    max: 600,
    step: 15,
    value: 60,
    unit: " s",
    group: "Query",
    help: "Range vector width. A reset inside this window is the case that separates the queries.",
    format: "number",
  },
  {
    id: "scrapeInterval",
    label: "Scrape interval",
    min: 5,
    max: 60,
    step: 5,
    value: 15,
    unit: " s",
    group: "Query",
    help: "Spacing between counter samples. Two samples are the minimum for a range query.",
    format: "number",
  },
  {
    id: "queryMode",
    label: "Query mode",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Query",
    help: "0 rate(), 1 delta(), 2 increase() divided by window, 3 avg_over_time() divided by window.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  deployAge: number;
  queryWindow: number;
  scrapeInterval: number;
  mode: number;
  age: number;
  counterNow: number;
  counterStart: number;
  deltaRaw: number;
  panelRate: number;
  trueRate: number;
  queryError: number;
  resetDeficit: number;
  samples: number;
  sampleShortfall: number;
}

function compute(p: Params): Computed {
  const requestRate = num(p, "requestRate", 200);
  const deployAge = num(p, "deployAge", 600);
  const queryWindow = num(p, "queryWindow", 60);
  const scrapeInterval = num(p, "scrapeInterval", 15);
  const mode = Math.round(num(p, "queryMode", 0)) % 4;
  const samples = Math.max(1, Math.ceil(queryWindow / scrapeInterval));
  const age = deployAge;
  const counterNow = requestRate * age;
  const counterStart =
    age >= queryWindow ? requestRate * (age - queryWindow) : requestRate * (queryWindow - age);
  const deltaRaw =
    age >= queryWindow ? requestRate * queryWindow : requestRate * (2 * age - queryWindow);
  let panelRate = requestRate;
  if (mode === 1) panelRate = deltaRaw / queryWindow;
  if (mode === 3) panelRate = (counterNow + counterStart) / 2 / queryWindow;
  if (samples < 2) panelRate = 0;
  panelRate = Math.max(0, panelRate);
  const trueRate = requestRate;
  const queryError = (Math.abs(panelRate - trueRate) / Math.max(1, trueRate)) * 100;
  const resetDeficit =
    samples < 2 || mode !== 1 ? 0 : Math.max(0, trueRate * queryWindow - deltaRaw);
  const sampleShortfall = Math.max(0, 4 - samples);
  return {
    requestRate,
    deployAge,
    queryWindow,
    scrapeInterval,
    mode,
    age,
    counterNow,
    counterStart,
    deltaRaw,
    panelRate,
    trueRate,
    queryError,
    resetDeficit,
    samples,
    sampleShortfall,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const points = 24;
  const jitter = (index: number) => 0.97 + 0.06 * Math.sin((index + (seed % 7)) / 2.8);
  const seeds: [string, number, number][] = [
    ["panel-rate", values.panelRate, 2],
    ["true-rate", values.trueRate, 2],
    ["query-error", values.queryError, 0.4],
    ["reset-deficit", values.resetDeficit, 10],
    ["sample-shortfall", values.sampleShortfall, 0.05],
    ["samples", values.samples, 0.2],
    ["raw-counter", values.counterNow, 40],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: points }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const queryHealth = healthFor(values.queryError, 15, 50);
  const sampleHealth = healthFor(values.sampleShortfall, 1, 2);
  const resetHealth =
    values.resetDeficit >= 10_000 ? "crit" : values.resetDeficit >= 1_000 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "instrumentation",
        label: "Instrumented service",
        kind: "service",
        health: "ok",
        utilization: clamp(values.requestRate / 2_000),
        throughput: values.requestRate,
        sublabel: `${Math.round(values.requestRate).toLocaleString()} events/s`,
        meta: { view: "flow" },
      },
      {
        id: "scraper",
        label: "Scraper",
        kind: "worker",
        health: sampleHealth,
        sublabel: `${Math.round(values.samples)} samples in window`,
        meta: { view: "flow" },
      },
      {
        id: "tsdb",
        label: "Time-series store",
        kind: "storage",
        health: "ok",
        sublabel: "counter samples",
        meta: { view: "flow" },
      },
      {
        id: "query",
        label: "Query engine",
        kind: "service",
        health: queryHealth,
        sublabel: values.mode === 1 ? "delta() on a counter" : `mode ${values.mode}`,
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "Error panel",
        kind: "service",
        health: queryHealth === "ok" ? resetHealth : queryHealth,
        sublabel:
          values.samples < 2
            ? "No result"
            : `${Math.round(values.panelRate).toLocaleString()} events/s`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("service-scraper", "instrumentation", "scraper", 1),
      edge("scraper-tsdb", "scraper", "tsdb", clamp(values.requestRate / 2_000)),
      edge("tsdb-query", "tsdb", "query", 1, sampleHealth),
      edge("query-dashboard", "query", "dashboard", 1, queryHealth),
    ],
    metrics: [
      metric(
        "panel-rate",
        values.samples < 2 ? "Panel rate (No result)" : "Panel rate",
        values.panelRate,
        " /s",
        undefined,
        undefined,
        "number",
      ),
      metric(
        "true-rate",
        "True event rate",
        values.trueRate,
        " /s",
        undefined,
        undefined,
        "number",
      ),
      metric("query-error", "Query error vs truth", values.queryError, "%", 15, 50, "percent"),
      metric(
        "reset-deficit",
        "Counter reset deficit",
        values.resetDeficit,
        " events",
        1_000,
        10_000,
        "count",
      ),
      metric(
        "sample-shortfall",
        "Sample shortfall",
        values.sampleShortfall,
        " samples",
        1,
        2,
        "count",
      ),
      metric("samples", "Samples in window", values.samples, "", undefined, undefined, "count"),
      metric(
        "raw-counter",
        "Raw counter value",
        values.counterNow,
        " events",
        undefined,
        undefined,
        "count",
      ),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), queryHealth },
    summary:
      values.samples < 2
        ? `Mode ${values.mode}: No result, because the window contains only ${values.samples} sample.`
        : `Mode ${values.mode}: panel reports ${values.panelRate.toFixed(0)}/s against a true ${values.trueRate.toFixed(0)}/s; query error ${values.queryError.toFixed(0)}%.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "sample-shortfall",
    metricId: "sample-shortfall",
    warn: 1,
    crit: 2,
    title: "The query window is under-sampled",
    cause:
      "The range vector has fewer than four samples. A short window over a long scrape interval makes the rate noisy and can hide a reset between samples.",
    fix: "Widen the query window, shorten the scrape interval, or both. Keep at least four samples in the window for a stable rate.",
    checkFirst: [
      "Count the samples in the range vector.",
      "Compare the query window with the scrape interval.",
      "Check whether the short window was chosen to make the graph responsive.",
    ],
  },
  {
    id: "query-error",
    metricId: "query-error",
    warn: 15,
    crit: 50,
    title: "The query result disagrees with the true event rate",
    cause:
      "The panel is applying a function that does not match the metric type. A counter reset or an absolute counter level is being treated as a rate.",
    fix: "Use rate() or increase() for counters, last-value or averaging for gauges, and histogram_quantile() over bucket rates for histograms. Never divide an absolute counter by the window.",
    checkFirst: [
      "Identify the metric type at the exporter, not from the graph shape.",
      "Check the query for delta(), deriv(), or raw subtraction on a counter.",
      "Check whether the window contains a deploy or restart.",
    ],
  },
  {
    id: "reset-deficit",
    metricId: "reset-deficit",
    warn: 1_000,
    crit: 10_000,
    title: "A counter reset is creating a large missing-events deficit",
    cause:
      "The query subtracts two counter values across a reset without compensating. The counter dropped to zero, so the observed delta is smaller than the true increase or negative.",
    fix: "Switch to a reset-aware function: rate() for a per-second view or increase() for a total. Reserve delta() for gauges.",
    checkFirst: [
      "Find the deploy or process restart in the annotation stream.",
      "Check whether the counter name ends in _total.",
      "Compare the raw counter with the true event count.",
    ],
  },
];

export const metricsTypesModel: SimModel = {
  id: "observability-metrics-types",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const jitter = rng.between(-20, 20);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.stepSeconds = dt;
    next.metrics = next.metrics.map((item) =>
      item.id === "raw-counter" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    const resetInWindow = values.age < values.queryWindow;
    if (resetInWindow && frame.flags.resetEvent !== 1) {
      const broken = values.mode === 1;
      pushEvent(next, {
        id: "counter-reset",
        severity: broken ? "crit" : "info",
        title: broken ? "Counter reset breaks delta()" : "Counter reset inside the query window",
        detail: broken
          ? "The counter dropped to zero at the deploy. Subtracting the first and last sample produces a negative or understated delta; rate() would adjust for the reset."
          : "The counter dropped to zero at the deploy. rate() and increase() adjust for monotonicity breaks; delta() would not.",
        metricId: "reset-deficit",
      });
      next.flags.resetEvent = 1;
    }
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const shownRate =
      frame.metrics.find((item) => item.id === "panel-rate")?.value ?? values.panelRate;
    const items: string[] = [];
    items.push(
      values.samples < 2
        ? "The range vector has one sample, so rate() returns no result; the panel is empty, not zero."
        : `The panel reports ${shownRate.toFixed(0)}/s against a true ${values.trueRate.toFixed(0)}/s, a ${values.queryError.toFixed(0)}% error.`,
    );
    if (values.mode === 1) {
      items.push(
        "delta() is a gauge function. Across a reset it subtracts a larger pre-reset counter from a smaller post-reset counter, so the result can be negative.",
      );
    } else if (values.mode === 3) {
      items.push(
        "avg_over_time() returns the absolute counter level, not an increase. Dividing it by the window invents a rate with no meaning.",
      );
    } else {
      items.push(
        "rate() and increase() are reset-aware. Dividing increase() by the window gives the same per-second rate.",
      );
    }
    items.push(
      `${values.samples} samples fall in the ${values.queryWindow.toFixed(0)}s window. A query needs at least two samples to produce a range result.`,
    );
    if (values.sampleShortfall > 0) {
      items.push(
        `The window is ${values.sampleShortfall} sample(s) short of the four-sample target; the rate is noisy even when the query function is correct.`,
      );
    }
    items.push(
      `The reset happened ${values.age.toFixed(0)}s ago. ${values.age < values.queryWindow ? "It is inside the window." : "It is outside the window."}`,
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
    description: "A counter read with rate(); the deploy reset is far outside the window.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "High volume",
    description: "High traffic with a 45s window over 15s scrapes; the rate is under-sampled.",
    tone: "warn",
    params: defaults({
      requestRate: 1_500,
      deployAge: 200,
      queryWindow: 45,
      scrapeInterval: 15,
      queryMode: 0,
    }),
  },
  {
    id: "failure",
    label: "Reset with delta()",
    description: "A deploy reset sits inside the window and delta() reports a negative change.",
    tone: "crit",
    params: defaults({
      requestRate: 200,
      deployAge: 5,
      queryWindow: 300,
      scrapeInterval: 15,
      queryMode: 1,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The query moves to rate() and the reset no longer distorts the panel.",
    tone: "ok",
    params: defaults({
      requestRate: 200,
      deployAge: 600,
      queryWindow: 300,
      scrapeInterval: 15,
      queryMode: 0,
    }),
  },
];

const experiment: Experiment = {
  id: "query-after-reset",
  title: "Choose the query after a counter reset",
  simId: "metrics-types",
  question:
    "A deploy reset the error counter five seconds ago. The panel uses delta(errors_total[5m]) and reports an impossible drop. Which query should replace it?",
  prediction: {
    options: [
      { id: "rate", label: "rate(errors_total[5m])" },
      { id: "delta", label: "delta(errors_total[5m]) with a shorter window" },
      { id: "avg", label: "avg_over_time(errors_total[5m]) divided by 300" },
      { id: "raw", label: "errors_total - errors_total offset 5m" },
    ],
    correctOptionId: "rate",
    explanation:
      "Prometheus rate() and increase() detect counter resets and adjust for the drop to zero. delta() is a gauge function, and raw subtraction has the same problem: both compare a larger pre-reset value with a smaller post-reset value.",
  },
  setup: presets[2].params,
  runFor: 30,
  observe: [
    "The panel reports 0 events/s while the true rate is 200 events/s.",
    "Query error reaches 100% and the reset deficit is over 100,000 events.",
    "The raw counter is small because the process restarted five seconds ago.",
    "Switching to rate() restores the panel without waiting for the reset to age out.",
  ],
  explain:
    "A counter is cumulative and resets to zero on restart. The current value is not comparable with a value from before the reset unless the query compensates. rate() and increase() do that; delta() and raw subtraction do not. A longer window makes the problem worse because it is more likely to contain the reset.",
  fix: { queryMode: 0 },
  debrief:
    "The corrected query reports 200 events/s through the reset and brings the query error to zero. The counter still resets on every deploy; the query now treats that as normal. The same reasoning applies to every _total series: use rate() or increase(), and reserve delta() for gauges.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A metric type describes how a value changes and which questions it can answer. A counter is cumulative and only increases, except when the process restarts and it resets to zero. A gauge is a point-in-time value that can go up or down. A histogram records observations in cumulative buckets and exposes counts, a sum, and a bucket series. A summary calculates quantiles inside the instrumented process and exposes them directly.",
  },
  {
    type: "p",
    text: "The query must match the type. Applying a gauge function to a counter, or a rate to a gauge, produces a number that looks plausible and means nothing. The failure is often subtle until a deploy resets a counter and the graph goes negative or spikes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The instrumented service exposes the metric, the scraper collects samples, the time-series store keeps them, and the query engine evaluates the expression. A dashboard panel is the last step. A type error can be introduced at any of those steps, but the most common is a query that ignores the type written by the exporter.",
  },
  {
    type: "table",
    headers: ["Type", "What it means", "Correct query", "Wrong query"],
    rows: [
      [
        "Counter",
        "Cumulative total; resets to zero on restart",
        "rate() for per second; increase() for a total",
        "delta(), raw subtraction, averaging the level",
      ],
      [
        "Gauge",
        "Point-in-time value that can rise or fall",
        "Last value, avg_over_time(), min or max",
        "rate() or increase()",
      ],
      [
        "Histogram",
        "Observations counted in cumulative buckets",
        "histogram_quantile() over rate(bucket)",
        "Quantile of averages or of raw bucket counts",
      ],
      [
        "Summary",
        "Quantiles calculated in the process",
        "Read the configured quantile; aggregate with care",
        "Average quantiles across instances",
      ],
    ],
  },
  {
    type: "p",
    text: "Prometheus's rate() and increase() adjust for counter resets and extrapolate to the ends of the range. delta() is documented for gauges. If a counter reset is inside the window, delta() compares a larger pre-reset value with a smaller post-reset value; the result can be negative or understated. That is the production question in this module.",
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start on Healthy, then apply Reset with delta(). Watch the panel rate, query error, and reset deficit. Run the guided experiment before reading the debrief, then switch the query mode to rate() and compare.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Panel rate: what the selected query reports, in events per second.",
      "True event rate: the counter's actual increment rate, independent of the query.",
      "Query error: the absolute difference between the panel and the truth.",
      "Counter reset deficit: the missing events created by comparing across a reset.",
      "Sample shortfall: how far the range vector falls below a stable four-sample target.",
      "Samples in window: whether the range vector has enough data to evaluate.",
    ],
  },
  {
    type: "p",
    text: "The query mode slider is a compact type switch. Mode 0 is rate(), mode 1 is delta(), mode 2 is increase() divided by the window, and mode 3 is avg_over_time() divided by the window. Only modes 0 and 2 preserve the meaning of a counter. Mode 1 is the reset failure. Mode 3 is nonsense even without a reset because the absolute counter level is not an event count for the window.",
  },
  { type: "sim", simId: "metrics-types" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The deploy restarted the process and the counter reset to zero. The panel compared the first and last samples in a five-minute window and found a smaller value at the end than at the start. The negative result was clamped to zero, so the panel showed no errors while the true rate was 200 events per second. The reset deficit captured the missing events that the subtraction hid.",
  },
  {
    type: "p",
    text: "Switching to rate() did not change the counter or wait for the reset to age out. It changed how the query interpreted the decrease. rate() treats a counter decrease as a reset, adds the pre-reset value, and reports the true per-second increase. increase() does the same for a total; dividing it by the window gives the same rate.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A counter panel with a negative dip or a flat zero immediately after a deploy.",
      "A deploy annotation that lines up with the change, which is the fastest confirmation.",
      "A `_total` series whose value is smaller than the previous sample.",
      "A dashboard query containing `delta()`, `deriv()`, or `counter - counter offset` on a counter.",
      "A summary panel that averages quantiles across instances, which is a different type error with the same shape.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the metric type at the exporter. Check whether the series name ends in `_total` or the help text says counter. Look for a deploy or restart at the same timestamp. Then read the query: rate or increase for counters, last value or averaging for gauges, histogram_quantile over bucket rates for histograms.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the metric type before changing the query.",
      "Replace delta() or raw subtraction with rate() or increase() for counters.",
      "Keep the window wide enough to contain several scrapes.",
      "Check that the panel's unit matches the query: per second, total, or absolute value.",
      "Add a deploy annotation so the next reset is visible immediately.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "rate() is reset-aware and smooth, but a long window hides short spikes; a short window is noisy.",
      "increase() is easier to read as a total, but it is still a rate multiplied by the window and inherits the same window tradeoff.",
      "Histograms support aggregation and arbitrary quantiles but cost one series per bucket and interpolate within buckets.",
      "Summaries calculate accurate quantiles in the process but cannot be aggregated across instances and fix the quantile and window at instrumentation time.",
      "Correct types reduce query surprises but do not fix missing labels or bad instrumentation.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "negative-counter",
    question:
      "An error-rate panel goes negative after a deploy. What are the likely causes, and how do you confirm them?",
    difficulty: 2,
    hints: [
      "A counter resets to zero on restart.",
      "Check the query function, not only the graph.",
    ],
    answer:
      "The most likely cause is a query that subtracts counter values across a reset, such as delta() or a raw offset expression. I would confirm that the series is a counter, find the deploy or restart at the same time, and inspect the samples on both sides of the drop. Then I would replace the query with rate() or increase(), which adjust for counter resets. I would also check the panel unit and whether the window contains several scrapes.",
    followUps: [
      "Why does rate() not go negative?",
      "When is delta() the right function?",
      "What if the metric is a gauge that legitimately decreased?",
    ],
    redFlags: [
      "Blames the exporter without reading the query.",
      "Clamps the graph and calls it fixed.",
      "Uses delta() on a counter.",
    ],
    rubric: [
      "Identifies the reset and the wrong function.",
      "Names rate() or increase().",
      "Confirms with the raw samples.",
      "Distinguishes counters from gauges.",
    ],
  },
  {
    id: "counter-or-gauge",
    question: "You need to track the number of in-flight requests. Counter or gauge, and why?",
    difficulty: 1,
    hints: ["The value rises and falls.", "A counter can only increase or reset."],
    answer:
      "A gauge. In-flight requests rise and fall as work arrives and completes, so the value is a point-in-time measurement. A counter would only make sense for a cumulative total such as requests started or requests completed. I would graph the gauge directly, or use an average over time, and I would not apply rate() to it.",
    followUps: [
      "How would you compute the average in-flight count over five minutes?",
      "What would a counter of requests started let you calculate?",
      "How does a queue depth differ from a counter?",
    ],
    redFlags: [
      "Chooses a counter because the name contains requests.",
      "Applies rate() to the gauge.",
      "Confuses a level with a total.",
    ],
    rubric: [
      "Chooses gauge.",
      "Explains the up-and-down behavior.",
      "Names the correct query.",
      "Contrasts with a cumulative counter.",
    ],
  },
  {
    id: "histogram-vs-summary",
    question:
      "You need a 99th-percentile (p99) latency service-level objective (SLO) across a fleet of instances. Do you choose a histogram or a summary, and what do you give up?",
    difficulty: 3,
    hints: [
      "Quantiles from separate instances do not average.",
      "A histogram keeps the distribution; a summary keeps precomputed quantiles.",
    ],
    answer:
      "I choose a histogram because it can be aggregated across instances: sum the bucket rates, then call histogram_quantile. A summary calculates quantiles inside each process, and averaging those quantiles across instances is not statistically valid. The histogram costs one series per bucket and interpolates within the bucket that contains the quantile, so the bucket layout determines the tail accuracy. A summary can be more accurate for a single instance and a fixed quantile, but it cannot be recalculated for a different percentile or window after the fact.",
    followUps: [
      "How would you choose the bucket boundaries for a 300ms SLO?",
      "What is the error when the quantile falls in the highest bucket?",
      "When would a summary be the better choice?",
    ],
    redFlags: [
      "Averages p99 values across instances.",
      "Chooses a summary for fleet-wide aggregation.",
      "Ignores bucket boundaries.",
    ],
    rubric: [
      "Chooses histogram for aggregation.",
      "Explains why summary quantiles cannot be averaged.",
      "Names bucket interpolation and cost.",
      "States when a summary is acceptable.",
    ],
  },
  {
    id: "reset-window",
    question:
      "A counter reset is inside the query window. Why does a longer window make the problem worse for delta(), and what does rate() do differently?",
    difficulty: 3,
    hints: [
      "The reset is a drop from a larger value to zero.",
      "Reset-aware functions adjust monotonicity breaks.",
    ],
    answer:
      "A longer window is more likely to include the reset. delta() subtracts the first and last samples as if the series were a gauge, so the drop to zero makes the result smaller or negative and can hide the increase on both sides of the reset. rate() detects a decrease between consecutive samples, treats it as a reset, and adds the pre-reset value to the increase. It then divides by the covered time and extrapolates to the window edges. The result stays a valid per-second rate as long as the samples are present.",
    followUps: [
      "What happens if the reset falls between two scrapes?",
      "How does increase() relate to rate()?",
      "What would you check if the rate still looks wrong?",
    ],
    redFlags: [
      "Says rate() ignores resets.",
      "Uses a longer window to hide the problem.",
      "Confuses extrapolation with reset handling.",
    ],
    rubric: [
      "Explains the reset drop.",
      "Describes rate() adjustment.",
      "Mentions window coverage and extrapolation.",
      "Names a verification step.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every counter query uses rate() or increase(), not delta() or raw subtraction.",
      "Gauge panels use last value or averaging, not rate().",
      "Histogram quantiles are computed from bucket rates with histogram_quantile().",
      "Summary quantiles are not averaged across instances.",
      "Deploy annotations are visible on the same dashboard as counter panels.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the metric type and the query before the graph shape.",
      "Look for a deploy or restart at the start of the anomaly.",
      "Check whether the window contains at least two scrapes.",
      "Check the panel unit against the query output.",
      "Record the query change and the result for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test or alert for negative counter-derived values.",
      "Review other panels for the same type error.",
      "Document the window and bucket choices.",
      "Remove panels that cannot answer a question with their current type.",
    ],
  },
];

const references = [
  {
    title: "Metric types",
    url: "https://prometheus.io/docs/concepts/metric_types/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Counter, gauge, histogram, and summary definitions.",
  },
  {
    title: "Query functions",
    url: "https://prometheus.io/docs/prometheus/latest/querying/functions/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "rate(), increase(), delta(), irate(), and histogram_quantile() behavior.",
  },
  {
    title: "Metrics types",
    url: "https://docs.datadoghq.com/metrics/types/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Submission and in-app types, including count, rate, gauge, and histogram.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "metrics-types": {
      model: metricsTypesModel,
      presets,
      instructions:
        "Start healthy, apply Reset with delta(), then switch the query mode to rate() and compare the panel with the true rate.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Event rates, windows, and deficits are teaching values, not production limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-golden-signals",
    "observability-promql-rate",
    "observability-histogram-quantile",
  ],
};
