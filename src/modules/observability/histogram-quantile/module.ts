import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BODY_SHAPE = 4;
const SLO_MS = 500;

const LAYOUTS: number[][] = [
  [25, 50, 100, 250, 500, 1_000],
  [10, 25, 50, 75, 100, 150, 200, 300, 500, 1_000, 2_500, 5_000],
  [50, 100, 250, 500, 1_000, 2_000, 3_000, 5_000, 10_000],
  [],
];

const params: ParamSpec[] = [
  {
    id: "medianLatencyMs",
    label: "Median latency",
    min: 20,
    max: 300,
    step: 5,
    value: 80,
    unit: " ms",
    group: "Distribution",
    help: "Median of the body of the latency distribution. The tail is modeled separately.",
    format: "ms",
  },
  {
    id: "tailSharePercent",
    label: "Tail share",
    min: 0,
    max: 10,
    step: 0.1,
    value: 0.1,
    unit: "%",
    group: "Distribution",
    help: "Share of requests in the slow tail. A tail below 1% cannot move p99 by itself.",
    format: "percent",
  },
  {
    id: "tailLatencyMs",
    label: "Tail latency",
    min: 500,
    max: 10_000,
    step: 100,
    value: 900,
    unit: " ms",
    group: "Distribution",
    help: "Latency of the slow tail. If it is above the top finite bucket, the panel cannot report it.",
    format: "ms",
  },
  {
    id: "bucketLayout",
    label: "Bucket layout",
    min: 0,
    max: 3,
    step: 1,
    value: 1,
    unit: "",
    group: "Histogram",
    help: "0 coarse SLO, 1 fine low latency, 2 through 10s, 3 native high resolution.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function bodyCdf(x: number, median: number): number {
  if (x <= 0) return 0;
  return 1 / (1 + (median / x) ** BODY_SHAPE);
}

function bodyQuantile(q: number, median: number): number {
  const safe = Math.min(0.999999, Math.max(0.000001, q));
  return median * (safe / (1 - safe)) ** (1 / BODY_SHAPE);
}

function totalCdf(x: number, median: number, tailShare: number, tailLatency: number): number {
  const body = (1 - tailShare) * bodyCdf(x, median);
  return x >= tailLatency ? body + tailShare : body;
}

function bucketQuantile(
  q: number,
  bounds: number[],
  median: number,
  tailShare: number,
  tailLatency: number,
): number {
  const upper = [...bounds, Number.POSITIVE_INFINITY];
  const cumulative = upper.map((value) => totalCdf(value, median, tailShare, tailLatency));
  let index = cumulative.findIndex((value) => value >= q);
  if (index < 0) index = upper.length - 1;
  if (index === upper.length - 1) return bounds[bounds.length - 1];
  const lower = index === 0 ? 0 : upper[index - 1];
  const previous = index === 0 ? 0 : cumulative[index - 1];
  const count = cumulative[index] - previous;
  const fraction = count > 0 ? (q - previous) / count : 0;
  return lower + fraction * (upper[index] - lower);
}

interface Computed {
  median: number;
  tailShare: number;
  tailLatency: number;
  layout: number;
  panelP99: number;
  actualP99: number;
  p99Error: number;
  slowShare: number;
  bucketSeries: number;
  topBound: number;
  clamped: boolean;
}

function compute(p: Params): Computed {
  const median = num(p, "medianLatencyMs", 80);
  const tailShare = num(p, "tailSharePercent", 0.1) / 100;
  const tailLatency = num(p, "tailLatencyMs", 900);
  const layout = Math.round(num(p, "bucketLayout", 1)) % 4;
  const bounds = LAYOUTS[layout];
  const actualP99 = tailShare >= 0.01 ? tailLatency : bodyQuantile(0.99 / (1 - tailShare), median);
  const panelP99 =
    layout === 3 ? actualP99 : bucketQuantile(0.99, bounds, median, tailShare, tailLatency);
  const p99Error = actualP99 > 0 ? Math.max(0, ((actualP99 - panelP99) / actualP99) * 100) : 0;
  const slowShare = (tailShare + (1 - tailShare) * (1 - bodyCdf(SLO_MS, median))) * 100;
  const topBound = layout === 3 ? 0 : bounds[bounds.length - 1];
  return {
    median,
    tailShare,
    tailLatency,
    layout,
    panelP99,
    actualP99,
    p99Error,
    slowShare,
    bucketSeries: layout === 3 ? 0 : bounds.length + 1,
    topBound,
    clamped: layout !== 3 && Math.abs(panelP99 - topBound) < 0.01 && actualP99 > topBound,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function combine(...values: ("ok" | "warn" | "crit")[]): "ok" | "warn" | "crit" {
  if (values.includes("crit")) return "crit";
  if (values.includes("warn")) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const points = 24;
  const jitter = (index: number) => 0.98 + 0.04 * Math.sin((index + (seed % 9)) / 2.6);
  const seeds: [string, number, number][] = [
    ["panel-p99", values.panelP99, 4],
    ["actual-p99", values.actualP99, 8],
    ["p99-error", values.p99Error, 0.4],
    ["slow-share", values.slowShare, 0.02],
    ["bucket-series", values.bucketSeries, 0.1],
    ["top-bound", values.topBound, 4],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: points }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const serviceHealth = healthFor(values.actualP99, 300, 600);
  const histogramHealth = healthFor(values.p99Error, 15, 40);
  const panelHealth = healthFor(values.panelP99, 300, 600);
  const tailHealth = healthFor(values.slowShare, 0.5, 2);
  const dashboardHealth = combine(panelHealth, tailHealth, histogramHealth);
  return {
    t: 0,
    nodes: [
      {
        id: "gateway",
        label: "Gateway",
        kind: "lb",
        health: "ok",
        sublabel: "requests",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: serviceHealth,
        sublabel: `true p99 ${values.actualP99.toFixed(0)}ms`,
        meta: { view: "flow" },
      },
      {
        id: "histogram",
        label: "Latency histogram",
        kind: "storage",
        health: histogramHealth,
        sublabel: `${values.layout === 3 ? "native" : `${values.bucketSeries} bucket series`}`,
        meta: { view: "flow" },
      },
      {
        id: "query",
        label: "histogram_quantile",
        kind: "service",
        health: panelHealth,
        sublabel: `panel ${values.panelP99.toFixed(0)}ms`,
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "p99 panel",
        kind: "service",
        health: dashboardHealth,
        sublabel: `slow share ${values.slowShare.toFixed(2)}%`,
        meta: { view: "flow" },
      },
      {
        id: "traces",
        label: "Trace sampler",
        kind: "external",
        health: "ok",
        sublabel: `sees ${values.actualP99.toFixed(0)}ms requests`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("gateway-service", "gateway", "service", 1),
      edge("service-histogram", "service", "histogram", 1, serviceHealth),
      edge("histogram-query", "histogram", "query", 1, histogramHealth),
      edge("query-dashboard", "query", "dashboard", 1, tailHealth),
      edge("service-traces", "service", "traces", 0.05, "ok"),
    ],
    metrics: [
      metric("panel-p99", "Panel p99", values.panelP99, "ms", 300, 600, "ms"),
      metric("actual-p99", "True p99", values.actualP99, "ms", undefined, undefined, "ms"),
      metric("p99-error", "P99 underestimation", values.p99Error, "%", 15, 40, "percent"),
      metric("slow-share", "Requests over 500ms", values.slowShare, "%", 0.5, 2, "percent"),
      metric(
        "bucket-series",
        "Bucket series",
        values.bucketSeries,
        "",
        undefined,
        undefined,
        "count",
      ),
      metric("top-bound", "Top finite bucket", values.topBound, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      layout: values.layout,
      clamped: values.clamped ? 1 : 0,
    },
    summary: `histogram_quantile reports ${values.panelP99.toFixed(0)}ms; true p99 is ${values.actualP99.toFixed(0)}ms; ${values.slowShare.toFixed(2)}% of requests exceed 500ms.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99-error",
    metricId: "p99-error",
    warn: 15,
    crit: 40,
    title: "The histogram quantile hides the true tail",
    cause:
      "The quantile is interpolated inside a bucket whose width is large, or it falls into the +Inf bucket. The reported value is an estimate bounded by the bucket layout, not a measurement of the tail.",
    fix: "Add buckets around the tail you care about, use a native histogram with higher resolution, or graph the fraction of requests above the SLO instead of relying on one quantile.",
    checkFirst: [
      "Find the bucket that contains the quantile.",
      "Compare the panel with the largest finite bucket.",
      "Compare the panel with traces or a fraction-over-threshold query.",
    ],
  },
  {
    id: "slow-share",
    metricId: "slow-share",
    warn: 0.5,
    crit: 2,
    title: "Too many requests exceed the latency SLO",
    cause:
      "A tail of slow requests is reaching users. p99 may not show it when the tail share is below 1%, because p99 is a rank, not a maximum.",
    fix: "Graph the fraction over the SLO as well as the quantile. Then fix the slow dependency or shed the work that creates the tail.",
    checkFirst: [
      "Check the fraction of requests above the SLO, not only p99.",
      "Check traces for the slow operation and its dependency.",
      "Check whether the tail share is changing over time.",
    ],
  },
  {
    id: "panel-p99",
    metricId: "panel-p99",
    warn: 300,
    crit: 600,
    title: "The p99 panel breached the latency threshold",
    cause:
      "The estimated p99 is above the warning or critical threshold. The estimate may still be lower than the true tail, so the panel is a lower bound in the worst case.",
    fix: "Confirm the estimate against traces and the fraction over threshold. Fix the slow path, then recheck the bucket layout.",
    checkFirst: [
      "Check the bucket containing the quantile.",
      "Check the true tail in traces.",
      "Check whether the SLO is defined on a quantile or on a fraction.",
    ],
  },
];

export const histogramQuantileModel: SimModel = {
  id: "observability-histogram-quantile",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const jitter = rng.between(-0.01, 0.01);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.stepSeconds = dt;
    next.metrics = next.metrics.map((item) =>
      item.id === "slow-share" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.p99Error >= 15 && frame.flags.tailEvent !== 1) {
      pushEvent(next, {
        id: "hidden-tail",
        severity: values.p99Error >= 40 ? "crit" : "warn",
        title: values.clamped
          ? "P99 clamped by the top finite bucket"
          : "P99 estimate misses the tail",
        detail: values.clamped
          ? `The panel reports ${values.panelP99.toFixed(0)}ms because the quantile fell into the +Inf bucket; traces see ${values.actualP99.toFixed(0)}ms.`
          : `The panel reports ${values.panelP99.toFixed(0)}ms while the true p99 is ${values.actualP99.toFixed(0)}ms. The bucket width is the uncertainty.`,
        metricId: "p99-error",
      });
      next.flags.tailEvent = 1;
    }
    if (values.p99Error < 15) next.flags.tailEvent = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `histogram_quantile(0.99) reports ${values.panelP99.toFixed(0)}ms; the modeled true p99 is ${values.actualP99.toFixed(0)}ms, a ${values.p99Error.toFixed(0)}% underestimation.`,
    );
    if (values.layout === 3) {
      items.push(
        "Native histograms keep a high-resolution bucket structure, so the interpolation error is small without a hand-picked classic layout.",
      );
    } else if (values.clamped) {
      items.push(
        `The quantile fell into the +Inf bucket. Prometheus returns the upper bound of the second-highest bucket, ${values.topBound.toFixed(0)}ms, so the panel cannot report the tail.`,
      );
    } else {
      items.push(
        `The quantile is interpolated inside a bucket below ${values.topBound.toFixed(0)}ms. The error is bounded by that bucket's width.`,
      );
    }
    items.push(
      `${values.slowShare.toFixed(2)}% of requests exceed 500ms. P99 is a rank: a tail below 1% can exist without moving p99 at all.`,
    );
    items.push(
      `This layout uses ${values.bucketSeries === 0 ? "one native histogram sample" : `${values.bucketSeries} classic bucket series`}.`,
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
    description: "A fine low-latency layout estimates p99 within the bucket width.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow body",
    description: "The median rises and a 0.5% tail pushes p99 and the SLO share up.",
    tone: "warn",
    params: defaults({
      medianLatencyMs: 120,
      tailSharePercent: 0.5,
      tailLatencyMs: 3_000,
      bucketLayout: 1,
    }),
  },
  {
    id: "failure",
    label: "Clamped tail",
    description: "A 3% tail at 3s falls into the +Inf bucket; the panel stops at 1s.",
    tone: "crit",
    params: defaults({
      medianLatencyMs: 80,
      tailSharePercent: 3,
      tailLatencyMs: 3_000,
      bucketLayout: 0,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The tail share falls and the fine layout with a 5s top bucket covers the remaining spread.",
    tone: "ok",
    params: defaults({
      medianLatencyMs: 80,
      tailSharePercent: 0.1,
      tailLatencyMs: 900,
      bucketLayout: 1,
    }),
  },
];

const experiment: Experiment = {
  id: "clamped-p99",
  title: "Predict the p99 with a coarse top bucket",
  simId: "histogram-quantile",
  question:
    "Three percent of requests take 3s. The classic histogram's highest finite bucket is 1s, followed by +Inf. What does histogram_quantile(0.99) report?",
  prediction: {
    options: [
      { id: "one-second", label: "1s, the upper bound of the second-highest bucket" },
      { id: "three-seconds", label: "3s, because the tail is in the data" },
      { id: "median", label: "About 250ms, because p99 is below the tail" },
      { id: "nan", label: "No result, because the histogram has a +Inf bucket" },
    ],
    correctOptionId: "one-second",
    explanation:
      "The 99th percentile falls in the +Inf bucket because 3% of requests are at 3s. Prometheus returns the upper bound of the second-highest bucket for a quantile in the highest bucket, so the panel stops at 1s while traces still see 3s.",
  },
  setup: presets[2].params,
  runFor: 20,
  observe: [
    "The panel reports 1,000ms while the true p99 is 3,000ms.",
    "P99 underestimation is about 67% and crosses the critical threshold.",
    "Requests over 500ms are 3.1%, which is the tail p99 cannot hide.",
    "The clamped flag is set because the quantile fell into the +Inf bucket.",
  ],
  explain:
    "Classic histogram buckets are cumulative counts with fixed upper bounds. histogram_quantile interpolates linearly inside the bucket that contains the rank. If the rank falls in the +Inf bucket, the function returns the upper bound of the second-highest bucket. The panel is a lower bound, not a measurement of the tail.",
  fix: defaults({
    medianLatencyMs: 80,
    tailSharePercent: 3,
    tailLatencyMs: 3_000,
    bucketLayout: 2,
  }),
  debrief:
    "Adding a bucket through 10s moves the estimate close to 3s and removes the clamping error. The slow requests are still there: the SLO share remains above 2%. Better buckets fix the measurement, not the latency. The next step is to fix the slow path or change the SLO to a fraction-over-threshold indicator.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A classic histogram counts observations into cumulative buckets. Each bucket has an upper bound and a count of everything at or below that bound. The +Inf bucket holds every observation. histogram_quantile() finds the bucket that contains the requested rank and interpolates linearly inside it, assuming the observations in that bucket are spread evenly.",
  },
  {
    type: "p",
    text: "The bucket layout is a measurement decision. A coarse layout gives a wide interval and a confident-looking number with a large error bar. A layout that stops at 1s cannot report a 3s tail: the rank falls into +Inf, and the function returns the upper bound of the second-highest bucket. A native histogram avoids hand-picked boundaries and keeps a high-resolution structure.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The service observes each request and increments the bucket counters. The scraper collects the bucket series, the query engine computes a rate over the buckets, and histogram_quantile() turns the distribution into a number. The dashboard shows one line. The line is an estimate derived from the layout, not a direct measurement of the slowest request.",
  },
  {
    type: "code",
    language: "promql",
    title: "A classic histogram quantile",
    code: "histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))",
    caption: "The le label carries the bucket upper bound. Sum by le before the quantile.",
  },
  {
    type: "table",
    headers: ["Layout", "Top finite bucket", "What it can hide"],
    rows: [
      ["Coarse SLO", "1s", "Any tail above 1s is clamped at the top finite bucket"],
      ["Fine low latency", "5s", "Good near the median, still coarse between 1s and 5s"],
      ["Through 10s", "10s", "Wide buckets below 1s lose resolution where most requests live"],
      ["Native", "Dynamic", "Resolution is bounded by the configured scale, not a fixed list"],
    ],
  },
  {
    type: "p",
    text: "P99 is a rank, not a maximum. If 0.5% of requests take 3s, the 99th percentile still belongs to the fast body. The slow requests are real, but p99 does not have to move. Graph the fraction of requests above the service-level objective (SLO) alongside the quantile. That fraction answers a different question and cannot be hidden by a rank.",
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start on Healthy, then apply Clamped tail. Compare Panel p99, True p99, P99 underestimation, and Requests over 500ms. Run the guided experiment before reading the debrief. Then switch to the through-10s layout and watch the estimate move without the latency improving.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Panel p99: the value histogram_quantile() returns for the chosen layout.",
      "True p99: the modeled distribution's actual 99th percentile.",
      "P99 underestimation: how far the panel falls below the true tail.",
      "Requests over 500ms: the fraction the SLO cares about, independent of the rank.",
      "Bucket series: the number of classic series the layout creates.",
      "Top finite bucket: the ceiling of the layout, or zero for a native histogram.",
    ],
  },
  {
    type: "p",
    text: "The model separates the body from a point-mass tail so the bucket effect is easy to see. Real latency distributions are smoother, and real buckets interpolate across a range. The rule is the same: the estimate is only as good as the bucket that contains the rank, and the highest bucket cannot report a value above its finite neighbor.",
  },
  { type: "sim", simId: "histogram-quantile" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Three percent of requests landed at 3s, so the 99th percentile fell into the +Inf bucket. The layout's highest finite bound was 1s. histogram_quantile() returned 1s, the upper bound of the second-highest bucket, while traces still saw 3s requests. The panel was not lying about the data it had; it was reporting the limit of the layout.",
  },
  {
    type: "p",
    text: "Adding a bucket through 10s moved the estimate close to 3s. The underestimation fell, but the fraction over 500ms stayed above 2%. The slow requests did not disappear. Better buckets made the measurement honest; fixing the latency is a separate job.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A p99 panel that sits exactly at a round bucket boundary, often the top finite bound.",
      "A trace sample with requests well above the panel value.",
      "A histogram with a +Inf bucket and no finite buckets near the SLO.",
      "A summary panel that is accurate on one instance but averaged across instances, which is a different error.",
      "A dashboard that graphs p99 but not the fraction of requests over the SLO.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the bucket that contains the quantile. Compare the panel with the top finite bucket and with traces. Graph the fraction over the SLO. If the panel equals the top finite bound while traces show slower requests, the layout is clamping the answer.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the SLO: is it a quantile or a fraction over a threshold?",
      "Add buckets around the tail and the SLO boundary.",
      "Prefer native histograms when the backend and instrumentation support them.",
      "Graph the fraction over the SLO next to the quantile.",
      "Fix the slow path; do not stop at a better estimate.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More buckets improve tail resolution but create more series, ingest, and query cost.",
      "Fewer buckets are cheaper but make the quantile a coarse interval, not a precise number.",
      "Native histograms improve resolution and aggregation but require instrumentation and backend support.",
      "Summaries can be accurate on one instance but cannot be aggregated across instances and fix the quantile at instrumentation time.",
      "A fraction-over-threshold indicator is robust and easy to alert on, but it does not tell you the shape of the tail.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "panel-vs-trace",
    question: "The p99 panel says 200ms but traces show 2s requests. How do you reconcile the two?",
    difficulty: 2,
    hints: ["P99 is a rank, not a maximum.", "Check the bucket layout and the quantile's bucket."],
    answer:
      "I first check whether the 2s requests are a small enough share to sit above p99. If less than 1% of requests are slow, p99 can stay in the fast body. Then I find the bucket that contains the quantile and compare it with the top finite bucket. If the quantile falls into +Inf, the panel is clamped. I confirm with the fraction of requests over the SLO and with a trace sample. The panel and the traces can both be correct about different questions.",
    followUps: [
      "What would you graph instead of p99?",
      "How would a native histogram change the answer?",
      "What if the slow requests are exactly 1%?",
    ],
    redFlags: [
      "Assumes one of the two must be broken.",
      "Ignores the bucket layout.",
      "Treats p99 as a maximum.",
    ],
    rubric: [
      "Explains p99 as a rank.",
      "Checks the bucket and top bound.",
      "Uses the fraction over threshold.",
      "Reconciles both signals.",
    ],
  },
  {
    id: "bucket-design",
    question:
      "You have a 300ms latency SLO. How do you choose classic histogram buckets, and what do you optimize for?",
    difficulty: 3,
    hints: [
      "Put resolution where the decision is made.",
      "Buckets are cumulative and cost one series each.",
    ],
    answer:
      "I put several buckets around the SLO boundary, for example below, at, and above 300ms, and enough surrounding buckets to see the shape of the body and the tail. I optimize for accuracy near the decision boundary and for the ability to compute the fraction over the SLO, not for uniform coverage of every possible latency. I also account for the cost: each bucket is a series, and changing the layout later creates a discontinuity in the historical data.",
    followUps: [
      "How many buckets would you add above the SLO?",
      "What happens to old data when the layout changes?",
      "When would you choose a native histogram instead?",
    ],
    redFlags: [
      "Chooses only round decimal buckets without a decision.",
      "Adds dozens of buckets without cost.",
      "Ignores the SLO boundary.",
    ],
    rubric: [
      "Places buckets at the SLO.",
      "Explains the cost.",
      "Mentions layout changes.",
      "Considers native histograms.",
    ],
  },
  {
    id: "clamped-quantile",
    question:
      "Why can histogram_quantile(0.99) never report a value above the highest finite bucket, and what should you do about it?",
    difficulty: 3,
    hints: [
      "The highest bucket is +Inf.",
      "Prometheus returns the second-highest upper bound for a quantile in the highest bucket.",
    ],
    answer:
      "The +Inf bucket has no finite upper bound, so the function cannot interpolate a value inside it. When the quantile falls there, Prometheus returns the upper bound of the second-highest bucket. That is a lower bound on the true value, not a measurement. I would add finite buckets through the tail I need to see, switch to a native histogram, and graph the fraction over the SLO so the tail is visible even when the quantile is clamped.",
    followUps: [
      "What if the tail is unbounded?",
      "How would you detect clamping automatically?",
      "What does the function return for a quantile in the lowest bucket?",
    ],
    redFlags: [
      "Claims the function extrapolates into +Inf.",
      "Ignores the clamped result.",
      "Adds buckets only below the SLO.",
    ],
    rubric: [
      "Explains the +Inf limitation.",
      "Names the second-highest bound.",
      "Proposes a layout or native histogram.",
      "Adds a fraction-over-threshold signal.",
    ],
  },
  {
    id: "histogram-vs-summary",
    question:
      "Why can you aggregate histogram quantiles across instances but not summary quantiles?",
    difficulty: 3,
    hints: [
      "A histogram keeps the distribution; a summary keeps the answer.",
      "Averaging percentiles is not a percentile.",
    ],
    answer:
      "A histogram keeps bucket counts, so I can sum the buckets across instances and compute one quantile from the combined distribution. A summary keeps precomputed quantiles for each instance. Averaging those quantiles gives a number that is not the quantile of the combined distribution, especially when the instances have different traffic volumes or distributions. The histogram is aggregatable; the summary is not, unless the aggregation is done before the quantile is calculated, which a summary does not allow.",
    followUps: [
      "What does a histogram cost compared with a summary?",
      "When is a summary still the right choice?",
      "How does traffic weighting affect the answer?",
    ],
    redFlags: [
      "Averages p99 values.",
      "Says summaries are always wrong.",
      "Ignores per-instance traffic.",
    ],
    rubric: [
      "Explains bucket aggregation.",
      "Explains why averaging quantiles fails.",
      "Names the cost.",
      "States when a summary is acceptable.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The histogram has buckets around the SLO boundary and through the expected tail.",
      "The p99 panel is paired with a fraction-over-threshold panel.",
      "The dashboard marks the top finite bucket so clamping is visible.",
      "Native histograms are used where the backend and instrumentation support them.",
      "Bucket layout changes are annotated so historical comparisons are honest.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the panel with traces and the fraction over the SLO.",
      "Check whether the quantile is in the +Inf bucket.",
      "Check whether the tail share is below 1%, which p99 can hide.",
      "Check for a recent bucket layout change.",
      "Record the estimate and the true tail for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the slow path, not only the measurement.",
      "Add or adjust buckets around the next SLO boundary.",
      "Recheck the estimate against traces at peak.",
      "Document the remaining uncertainty in the panel.",
    ],
  },
];

const references = [
  {
    title: "Histograms and summaries",
    url: "https://prometheus.io/docs/practices/histograms/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Bucket layouts, quantile estimation error, native histograms, and summaries.",
  },
  {
    title: "Query functions: histogram_quantile",
    url: "https://prometheus.io/docs/prometheus/latest/querying/functions/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Interpolation and the special case for a quantile in the highest bucket.",
  },
  {
    title: "Metric types: histogram",
    url: "https://prometheus.io/docs/concepts/metric_types/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Cumulative bucket series and the _sum and _count companions.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "histogram-quantile": {
      model: histogramQuantileModel,
      presets,
      instructions:
        "Start healthy, apply Clamped tail, and compare the panel p99 with the true p99 and the fraction over 500ms. Then change the bucket layout.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Latency distributions, bucket boundaries, and SLO values are teaching figures.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-promql-rate",
    "observability-golden-signals",
    "observability-metrics-types",
  ],
};
