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

const BURST_CYCLE = 4;

const params: ParamSpec[] = [
  {
    id: "scrapeInterval",
    label: "Scrape interval",
    min: 5,
    max: 60,
    step: 5,
    value: 15,
    unit: " s",
    group: "Collection",
    help: "Time between counter samples. A range query needs at least two samples.",
    format: "number",
  },
  {
    id: "queryWindow",
    label: "Query window",
    min: 10,
    max: 300,
    step: 10,
    value: 300,
    unit: " s",
    group: "Query",
    help: "Width of the rate() range vector. More scrapes smooth the result and reduce aliasing.",
    format: "number",
  },
  {
    id: "requestRate",
    label: "Base request rate",
    min: 50,
    max: 2_000,
    step: 50,
    value: 400,
    unit: " /s",
    group: "Traffic",
    help: "Long-run counter increment rate before the periodic burst.",
    format: "number",
  },
  {
    id: "burstShare",
    label: "Burst amplitude",
    min: 0,
    max: 200,
    step: 10,
    value: 50,
    unit: "%",
    group: "Traffic",
    help: "Extra increment on one of every four scrape intervals. Short windows can sample only the burst.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function phaseAt(seconds: number, scrapeInterval: number): number {
  const phase = Math.round(seconds / scrapeInterval) % BURST_CYCLE;
  return ((phase % BURST_CYCLE) + BURST_CYCLE) % BURST_CYCLE;
}

interface Computed {
  scrapeInterval: number;
  queryWindow: number;
  requestRate: number;
  burstShare: number;
  samples: number;
  covered: number;
  extrapolation: number;
  queryRate: number;
  trueRate: number;
  spikeError: number;
  sampleShortfall: number;
  resetCount: number;
}

function compute(p: Params, t: number): Computed {
  const scrapeInterval = num(p, "scrapeInterval", 15);
  const queryWindow = num(p, "queryWindow", 300);
  const requestRate = num(p, "requestRate", 400);
  const burstShare = num(p, "burstShare", 50) / 100;
  const samples = Math.max(1, Math.ceil(queryWindow / scrapeInterval));
  const covered = Math.max(scrapeInterval, (samples - 1) * scrapeInterval);
  const extrapolation = samples < 2 ? 1 : Math.min(1.1, queryWindow / covered);
  let increment = 0;
  for (let index = 1; index < samples; index++) {
    const laterSample = -(index - 1) * scrapeInterval;
    const burst = phaseAt(t + laterSample, scrapeInterval) === 0 ? burstShare : 0;
    increment += requestRate * scrapeInterval * (1 + burst);
  }
  const queryRate = samples < 2 ? 0 : (increment / covered) * extrapolation;
  const trueRate = requestRate * (1 + burstShare / BURST_CYCLE);
  const spikeError = (Math.abs(queryRate - trueRate) / Math.max(1, trueRate)) * 100;
  const sampleShortfall = Math.max(0, 4 - samples);
  const resetCount = t >= 30 && t - 30 < queryWindow ? 1 : 0;
  return {
    scrapeInterval,
    queryWindow,
    requestRate,
    burstShare,
    samples,
    covered,
    extrapolation,
    queryRate,
    trueRate,
    spikeError,
    sampleShortfall,
    resetCount,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const points = 24;
  const jitter = (index: number) => 0.97 + 0.06 * Math.sin((index + (seed % 5)) / 2.4);
  const seeds: [string, number, number][] = [
    ["query-rate", values.queryRate, 3],
    ["true-rate", values.trueRate, 2],
    ["spike-error", values.spikeError, 0.5],
    ["sample-shortfall", values.sampleShortfall, 0.1],
    ["samples", values.samples, 0.2],
    ["extrapolation", values.extrapolation, 0.005],
    ["reset-count", values.resetCount, 0.1],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: points }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t = 0): SimFrame {
  const values = compute(p, t);
  const queryHealth = healthFor(values.spikeError, 15, 40);
  const sampleHealth = healthFor(values.sampleShortfall, 1, 2);
  const overall =
    queryHealth === "crit" || sampleHealth === "crit"
      ? "crit"
      : queryHealth === "warn" || sampleHealth === "warn"
        ? "warn"
        : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "Service counter",
        kind: "service",
        health: "ok",
        throughput: values.trueRate,
        sublabel: `${Math.round(values.trueRate).toLocaleString()} events/s long-run`,
        meta: { view: "flow" },
      },
      {
        id: "scraper",
        label: "Scraper",
        kind: "worker",
        health: sampleHealth,
        sublabel: `${values.samples} samples, ${values.scrapeInterval.toFixed(0)}s apart`,
        meta: { view: "flow" },
      },
      {
        id: "tsdb",
        label: "Time-series store",
        kind: "storage",
        health: "ok",
        utilization: clamp(values.requestRate / 2_000),
        sublabel: "counter samples",
        meta: { view: "flow" },
      },
      {
        id: "query",
        label: "rate() query",
        kind: "service",
        health: queryHealth,
        sublabel: `${values.extrapolation.toFixed(2)}x extrapolation`,
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "Rate panel",
        kind: "service",
        health: overall,
        sublabel:
          values.samples < 2
            ? "no result"
            : `${Math.round(values.queryRate).toLocaleString()} /s reported`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("service-scraper", "service", "scraper", 1),
      edge("scraper-tsdb", "scraper", "tsdb", clamp(values.requestRate / 2_000)),
      edge("tsdb-query", "tsdb", "query", 1),
      edge("query-dashboard", "query", "dashboard", 1, overall),
    ],
    metrics: [
      metric(
        "query-rate",
        values.samples < 2 ? "Rate panel (No result)" : "Rate panel",
        values.queryRate,
        " /s",
        undefined,
        undefined,
        "number",
      ),
      metric("true-rate", "Long-run rate", values.trueRate, " /s", undefined, undefined, "number"),
      metric("spike-error", "Rate error vs long-run", values.spikeError, "%", 15, 40, "percent"),
      metric(
        "sample-shortfall",
        "Sample shortfall",
        values.sampleShortfall,
        " samples",
        1,
        2,
        "count",
      ),
      metric(
        "extrapolation",
        "Extrapolation factor",
        values.extrapolation,
        "x",
        undefined,
        undefined,
        "number",
      ),
      metric("samples", "Samples in window", values.samples, "", undefined, undefined, "count"),
      metric(
        "reset-count",
        "Counter resets in window",
        values.resetCount,
        "",
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
        ? `No result: the ${values.queryWindow.toFixed(0)}s window contains only ${values.samples} sample.`
        : `rate() reports ${values.queryRate.toFixed(0)}/s from ${values.samples} samples; long-run rate ${values.trueRate.toFixed(0)}/s; error ${values.spikeError.toFixed(0)}%.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "spike-error",
    metricId: "spike-error",
    warn: 15,
    crit: 40,
    title: "The rate panel disagrees with the long-run rate",
    cause:
      "The window covers only one or two scrape intervals, so a burst in one interval is extrapolated into a sustained spike. The panel is reporting the sample, not the signal.",
    fix: "Widen the rate window until it covers several scrapes, or use a recording rule that evaluates over a stable window. Keep the scrape interval shorter than the shortest event you must detect.",
    checkFirst: [
      "Count the samples in the range vector.",
      "Compare the window with the scrape interval.",
      "Compare the panel with a longer-window rate or an independent trace signal.",
    ],
  },
  {
    id: "sample-shortfall",
    metricId: "sample-shortfall",
    warn: 1,
    crit: 2,
    title: "The range vector is under-sampled",
    cause:
      "The query window is close to or smaller than the scrape interval. rate() needs at least two samples, and two samples cannot distinguish a burst from a sustained change.",
    fix: "Use a window that covers at least four scrape intervals for alerting, and keep the scrape interval shorter than the shortest outage you need to detect.",
    checkFirst: [
      "Check the configured scrape interval for this job.",
      "Check for missed scrapes or target restarts in the window.",
      "Check whether the query window was shortened to make the graph look responsive.",
    ],
  },
];

export const promqlRateModel: SimModel = {
  id: "observability-promql-rate",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p, frame.t);
    const jitter = rng.between(-0.002, 0.002);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.t);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.stepSeconds = dt;
    next.metrics = next.metrics.map((item) =>
      item.id === "extrapolation" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (
      frame.t >= 30 &&
      values.queryWindow > 0 &&
      values.resetCount > 0 &&
      frame.flags.resetEvent !== 1
    ) {
      pushEvent(next, {
        id: "rate-reset",
        severity: "info",
        title: "Counter reset inside the rate window",
        detail:
          "The target restarted and the counter dropped to zero. rate() adjusts for the monotonicity break; a raw subtraction would not.",
        metricId: "reset-count",
      });
      next.flags.resetEvent = 1;
    }
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `The window is ${values.queryWindow.toFixed(0)}s and the scrape interval is ${values.scrapeInterval.toFixed(0)}s, so the range vector contains ${values.samples} samples.`,
    );
    items.push(
      values.samples < 2
        ? "With one sample, rate() returns no result; the panel is empty, not zero."
        : `rate() reports ${values.queryRate.toFixed(0)}/s against a long-run ${values.trueRate.toFixed(0)}/s. The ${values.extrapolation.toFixed(2)}x factor fills the part of the window not covered by samples.`,
    );
    if (values.samples <= 3) {
      items.push(
        "This window is too short to separate a burst from a sustained change; the panel aliases the sample into a spike.",
      );
    } else {
      items.push(
        "Several scrapes smooth the burst. The remaining error comes from the burst phase and the extrapolation, not from a missing sample.",
      );
    }
    items.push(
      `A counter reset is ${values.resetCount === 1 ? "inside" : "outside"} the window. rate() adjusts for resets; it does not invent a negative rate.`,
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
    description: "A 300s window covers 20 samples; the burst averages out.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description:
      "High traffic with a 90s window and 30s scrapes; the burst is only partly smoothed.",
    tone: "warn",
    params: defaults({ scrapeInterval: 30, queryWindow: 90, requestRate: 800, burstShare: 100 }),
  },
  {
    id: "failure",
    label: "Aliased spike",
    description:
      "A 20s window over 15s scrapes samples the burst and reports 2.2x the long-run rate (3.3x the base rate).",
    tone: "crit",
    params: defaults({ scrapeInterval: 15, queryWindow: 20, requestRate: 400, burstShare: 200 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The window widens to 300s and the panel comes within a few percent of the long-run rate.",
    tone: "ok",
    params: defaults({ scrapeInterval: 15, queryWindow: 300, requestRate: 400, burstShare: 50 }),
  },
];

const experiment: Experiment = {
  id: "window-aliasing",
  title: "Predict the panel with two samples",
  simId: "promql-rate",
  question:
    "The scrape interval is 15s and the rate window is 20s. A burst triples one interval. What does rate() report?",
  prediction: {
    options: [
      { id: "amplified", label: "An amplified rate that can exceed the long-run average" },
      { id: "smooth", label: "The long-run average, because rate() smooths" },
      { id: "empty", label: "No result, because the window is shorter than the scrape" },
      { id: "zero", label: "Zero, because the counter reset" },
    ],
    correctOptionId: "amplified",
    explanation:
      "Two samples are enough to produce a result, but they cover one interval. A burst in that interval is divided by the covered time and extrapolated to the window edge, so the panel reports the burst as if it were sustained.",
  },
  setup: presets[2].params,
  runFor: 35,
  observe: [
    "The range vector contains two samples.",
    "The panel alternates between the burst rate and the normal rate as the window slides over the burst cycle.",
    "At the burst phase it reports about 3.3x the base rate while the long-run rate is 1.5x.",
    "Rate error crosses the warning threshold; the sample shortfall stays critical.",
    "The counter reset at 30s is absorbed by rate(); the reset event appears after the reset.",
  ],
  explain:
    "rate() divides the counter increase by the time covered by the samples, then extrapolates to the window edges. A two-sample window slides across the burst cycle: when it covers the burst, the panel reports the burst as if it were sustained; when it does not, the panel reports a low rate. With a long window, the bursts average out. The window is not a cosmetic zoom level; it defines the signal.",
  fix: { queryWindow: 300 },
  debrief:
    "Widening the window to 300s brings the panel within a few percent of the long-run rate. The tradeoff is slower response to a real change. Choose the window from the shortest event you must detect and the scrape interval, not from how smooth the graph looks.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Prometheus Query Language (PromQL) provides rate(), which calculates a per-second average increase from a range vector. It does not simply subtract the first and last samples. It adjusts for counter resets, divides by the time covered by the samples, and extrapolates to the ends of the requested range. That extrapolation fills gaps caused by scrape alignment and missed scrapes.",
  },
  {
    type: "p",
    text: "The query window is part of the measurement. A long window averages over many scrapes and responds slowly. A short window responds quickly but can be dominated by one interval. When the window is close to the scrape interval, the panel reports the sample rather than the signal. That is aliasing.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The target exposes a counter, the scraper samples it at a fixed interval, the time-series store keeps the samples, and the query engine evaluates rate() over the window. The dashboard is the last step. A panel can be mathematically valid and still answer the wrong question because the window is too short for the event.",
  },
  {
    type: "code",
    language: "promql",
    title: "A rate query with a window",
    code: 'rate(http_requests_total{job="checkout"}[5m])',
    caption: "The [5m] is a range vector. It must contain enough samples for the question.",
  },
  {
    type: "table",
    headers: ["Function", "Uses", "Smoothing", "Best for"],
    rows: [
      [
        "rate()",
        "All samples in the window",
        "Averages over the window",
        "Alerts and slow-moving counters",
      ],
      ["irate()", "Last two samples", "Almost none", "Volatile counters on a graph"],
      [
        "increase()",
        "All samples, as a total",
        "Averages over the window",
        "Readable totals and capacity",
      ],
      ["delta()", "First and last sample", "None", "Gauges, not counters"],
    ],
  },
  {
    type: "p",
    text: "rate() and increase() both adjust for counter resets. irate() also adjusts for the last two samples, but it is intentionally jumpy: a brief change can reset an alert's for clause or make a graph unreadable. The Prometheus documentation recommends rate() for alerts and slow-moving counters, and irate() only for volatile counters on a graph.",
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start on Healthy, then apply Aliased spike. Compare the rate panel with the long-run rate and count the samples. Run the guided experiment before reading the debrief. Then widen the window and watch the error fall.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Rate panel: the value rate() reports at the current simulated time.",
      "Long-run rate: the average including the periodic burst, which the short window cannot see.",
      "Rate error: the absolute difference between the panel and the long-run rate.",
      "Sample shortfall: how far the range vector is below four samples.",
      "Extrapolation factor: how much rate() stretches the covered interval to the window edge.",
      "Counter resets in window: whether a restart is inside the range vector.",
    ],
  },
  {
    type: "p",
    text: "The simulated burst repeats every four scrape intervals, which makes the aliasing visible. Real traffic is messier, but the mechanism is the same: the window decides which samples become the answer. A dashboard that shows a spike every minute may be showing a sampling artifact, not a user-facing event.",
  },
  { type: "sim", simId: "promql-rate" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The short window contained two samples: one normal interval and one burst interval. rate() divided that increase by the covered time and extrapolated to the window edge. The result was a rate close to the burst, not the long-run average. The panel was not broken; it was answering a different question from the one the operator thought it was answering.",
  },
  {
    type: "p",
    text: "The long window contained 20 samples and averaged the burst across four intervals. The panel came within a few percent of the long-run rate because the window covered enough of the cycle. The cost is latency: a long window takes longer to show a real change. The right window is a compromise between detection time and stability.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A rate panel with spikes at a regular period that do not match errors, latency, or deploys.",
      "A range vector with fewer than four samples when you inspect the query in the Prometheus UI.",
      "A scrape interval that is close to the window, often because someone shortened the window to make the graph responsive.",
      "A counter reset annotation at the same time as a dip, which rate() should absorb without going negative.",
      "An extrapolation factor near 1.1, which means the query is stretching a short covered interval.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count the samples in the range vector. Compare the window with the scrape interval. Compare the panel with a longer-window rate and with an independent signal such as traces or logs. If the spike disappears at a longer window, it was aliasing, not traffic.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Choose the window from the shortest event you must detect, not from the graph's appearance.",
      "Keep at least four scrapes in the window for alerting; more for a stable graph.",
      "Use rate() for alerts and slow counters; reserve irate() for volatile counters on a graph.",
      "Add a recording rule if the dashboard needs a consistent window across panels.",
      "Add a deploy annotation so counter resets are visible without changing the query.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long window is stable but slow; it can miss a short outage or delay a page.",
      "A short window is responsive but noisy; it can page on a burst that did not affect users.",
      "A shorter scrape interval improves detection but increases ingest, storage, and query cost.",
      "irate() is responsive but jumps on every brief change, which makes alerts and graphs harder to read.",
      "Extrapolation fills gaps but cannot create missing samples; a window without two samples returns no result.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "spike-every-minute",
    question:
      "Your rate panel shows a spike every minute that does not match user impact. How do you determine whether it is real?",
    difficulty: 2,
    hints: [
      "Count the samples in the range vector.",
      "Compare the window with the scrape interval.",
    ],
    answer:
      "I check the number of samples in the range vector and the scrape interval first. If the window contains only one or two samples, the panel may be aliasing a burst. I compare it with a longer-window rate and with an independent signal such as traces, errors, or logs. If the spike disappears at a longer window and no user-facing signal moved, it is a sampling artifact. If it remains, I look for a real periodic workload or a retry cycle.",
    followUps: [
      "How would a recording rule change the diagnosis?",
      "What if the spike remains at every window?",
      "Which window would you use for a page?",
    ],
    redFlags: [
      "Assumes the graph is always right.",
      "Shortens the window further to investigate.",
      "Ignores the scrape interval.",
    ],
    rubric: [
      "Counts samples.",
      "Compares windows.",
      "Uses an independent signal.",
      "Distinguishes aliasing from traffic.",
    ],
  },
  {
    id: "rate-vs-irate",
    question: "When would you use irate() instead of rate(), and what do you give up?",
    difficulty: 2,
    hints: ["irate() uses the last two samples.", "Alerts need stability."],
    answer:
      "I use irate() on a graph for a volatile, fast-moving counter when I want to see the most recent change. I give up smoothing: a brief burst dominates the value, and an alert with a for clause can be reset by a single sample. For alerts and slow-moving counters I use rate() over a window that covers several scrapes. If I need a fast alert, I use a multi-window rate rather than irate().",
    followUps: [
      "What does irate() do at a counter reset?",
      "Why does aggregation order matter with irate()?",
      "How would you show both views on one dashboard?",
    ],
    redFlags: [
      "Uses irate() for every alert.",
      "Says irate() ignores resets.",
      "Aggregates before irate().",
    ],
    rubric: [
      "Names the volatility use case.",
      "Explains the loss of smoothing.",
      "Mentions alert stability.",
      "Mentions reset handling.",
    ],
  },
  {
    id: "extrapolation",
    question:
      "What does rate() extrapolate, and why can the result be slightly off even when the counter is correct?",
    difficulty: 3,
    hints: [
      "Samples rarely align exactly with the window edges.",
      "The function stretches the covered interval to the requested range.",
    ],
    answer:
      "rate() divides the increase by the time covered by the first and last samples, then extrapolates that rate to the ends of the requested range. If the samples do not align with the window edges, the function assumes the rate continues into the uncovered edges. It also handles counter resets by treating a decrease as a reset. The result can be slightly off because the extrapolation is an estimate, not a measurement of the missing time.",
    followUps: [
      "When would extrapolation be most misleading?",
      "How does a missed scrape affect the result?",
      "Why does the Prometheus implementation cap the extrapolation?",
    ],
    redFlags: [
      "Says rate() only subtracts two samples.",
      "Ignores scrape alignment.",
      "Confuses extrapolation with interpolation.",
    ],
    rubric: [
      "Describes the covered interval.",
      "Explains edge extrapolation.",
      "Mentions reset handling.",
      "States the estimate's limitation.",
    ],
  },
  {
    id: "window-choice",
    question:
      "You need to detect a five-second outage on a counter scraped every fifteen seconds. What do you change, and what does it cost?",
    difficulty: 3,
    hints: [
      "A five-second event can fall entirely between scrapes.",
      "Detection resolution is bounded by sampling.",
    ],
    answer:
      "A fifteen-second scrape cannot reliably see a five-second outage, so I would shorten the scrape interval below the event width or add a second signal that captures the event, such as logs, traces, or a synthetic probe. Shortening the interval increases ingest, storage, and query cost. I would also make sure the rate window is long enough to produce a stable result without hiding the event. The tradeoff is detection resolution against cost, not a free improvement.",
    followUps: [
      "What if the outage is shorter than any feasible scrape interval?",
      "How would a histogram or exemplar help?",
      "What is the cost of halving the interval?",
    ],
    redFlags: [
      "Claims a longer window will catch the short outage.",
      "Ignores ingest cost.",
      "Assumes rate() can interpolate missing events.",
    ],
    rubric: [
      "States the sampling limit.",
      "Proposes a shorter interval or another signal.",
      "Quantifies the cost qualitatively.",
      "Keeps the query window coherent.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every alerting rate window covers at least four scrape intervals.",
      "The scrape interval is shorter than the shortest outage the team must detect.",
      "Dashboards and alerts use the same window for the same signal.",
      "Deploy annotations are visible on rate panels.",
      "A longer-window comparison is available for suspected aliasing.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Count the samples in the range vector before trusting a spike.",
      "Compare the short window with a longer window.",
      "Check for counter resets and missed scrapes.",
      "Use traces or logs to confirm user impact.",
      "Record the window and scrape interval in the incident timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Adjust the window to the detection requirement.",
      "Add a recording rule if multiple panels need the same rate.",
      "Review ingest cost after changing the scrape interval.",
      "Document why the chosen window is the right tradeoff.",
    ],
  },
];

const references = [
  {
    title: "Query functions: rate, irate, and increase",
    url: "https://prometheus.io/docs/prometheus/latest/querying/functions/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Reset adjustment, extrapolation, and the intended use of each function.",
  },
  {
    title: "Histograms and summaries",
    url: "https://prometheus.io/docs/practices/histograms/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Rate windows, bucket aggregation, and quantile estimation.",
  },
  {
    title: "Grafana dashboard best practices",
    url: "https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Panel design and the cost of unnecessary refresh and query load.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "promql-rate": {
      model: promqlRateModel,
      presets,
      instructions:
        "Start healthy, apply Aliased spike, and compare the rate panel with the long-run rate. Count the samples before changing the window.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Scrape intervals, burst amplitude, and extrapolation values are teaching figures.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-metrics-types",
    "observability-histogram-quantile",
    "observability-scrape-resolution",
  ],
};
