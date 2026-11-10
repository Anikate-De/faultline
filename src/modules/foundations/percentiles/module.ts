import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUEST_RATE = 20_000;

const params = [
  {
    id: "baselineMs",
    label: "Baseline latency",
    min: 10,
    max: 200,
    step: 1,
    value: 30,
    unit: "ms",
    group: "Distribution",
    help: "Latency for the fast majority of requests: the p50 and usually the p95.",
    format: "ms" as const,
  },
  {
    id: "slowShare",
    label: "Slow request share",
    min: 0,
    max: 20,
    step: 0.1,
    value: 0.2,
    unit: "%",
    group: "Distribution",
    help: "Share of requests that land in the slow cohort. A small share can still dominate timeouts.",
    format: "percent" as const,
  },
  {
    id: "slowMs",
    label: "Slow cohort latency",
    min: 500,
    max: 5_000,
    step: 100,
    value: 900,
    unit: "ms",
    group: "Distribution",
    help: "Typical latency of the slow cohort. The cohort spreads from 0.5x to 1.7x this value.",
    format: "ms" as const,
  },
  {
    id: "timeoutMs",
    label: "Client timeout",
    min: 500,
    max: 5_000,
    step: 100,
    value: 2_000,
    unit: "ms",
    group: "Impact",
    help: "Requests slower than this are counted as timeouts. The client sees an error even if the server finishes later.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  baseline: number;
  slowShare: number;
  slowMs: number;
  timeoutMs: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  p999: number;
  timeoutRate: number;
  requestRate: number;
  slowRps: number;
}

function slowLatencyAt(q: number, slowMs: number): number {
  const bounded = clamp(q, 0, 1);
  return slowMs * (0.5 + 1.2 * bounded * bounded);
}

function latencyAt(percentile: number, baseline: number, slowShare: number, slowMs: number): number {
  const share = clamp(slowShare / 100, 0, 1);
  if (share <= 0) return baseline;
  const fastShare = 1 - share;
  if (percentile <= fastShare) return baseline;
  const q = (percentile - fastShare) / share;
  return slowLatencyAt(q, slowMs);
}

function cdfAt(latency: number, baseline: number, slowShare: number, slowMs: number): number {
  const share = clamp(slowShare / 100, 0, 1);
  if (latency < baseline) return 0;
  if (share <= 0) return 1;
  if (latency >= slowMs * 1.7) return 1;
  const q = Math.sqrt(Math.max(0, (latency / slowMs - 0.5) / 1.2));
  return clamp(1 - share + share * clamp(q, 0, 1));
}

function compute(p: Params): Computed {
  const baseline = Math.max(1, num(p, "baselineMs", 30));
  const slowShare = clamp(num(p, "slowShare", 0.2), 0, 20);
  const slowMs = Math.max(100, num(p, "slowMs", 900));
  const timeoutMs = Math.max(100, num(p, "timeoutMs", 2_000));
  const share = slowShare / 100;
  const ratio = timeoutMs / slowMs;
  let timeoutRate: number;
  if (ratio <= 0.5) timeoutRate = slowShare;
  else if (ratio >= 1.7) timeoutRate = 0;
  else {
    const cut = Math.sqrt((ratio - 0.5) / 1.2);
    timeoutRate = slowShare * (1 - cut);
  }
  return {
    baseline,
    slowShare,
    slowMs,
    timeoutMs,
    mean: (1 - share) * baseline + share * slowMs * 0.9,
    p50: latencyAt(0.5, baseline, slowShare, slowMs),
    p95: latencyAt(0.95, baseline, slowShare, slowMs),
    p99: latencyAt(0.99, baseline, slowShare, slowMs),
    p999: latencyAt(0.999, baseline, slowShare, slowMs),
    timeoutRate,
    requestRate: REQUEST_RATE,
    slowRps: (REQUEST_RATE * slowShare) / 100,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 8)) / 2.7);
  const entries: [string, number, number][] = [
    ["mean", values.mean, 1],
    ["p99", values.p99, 8],
    ["p999", values.p999, 12],
    ["timeout-rate", values.timeoutRate, 0.05],
    ["request-rate", values.requestRate, 80],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4 + value) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const s = v.slowShare / 100;
  const thresholdsMs = [500, 1_000, 2_000];
  const cumulative = thresholdsMs.map((ms) => cdfAt(ms, v.baseline, v.slowShare, v.slowMs));
  const shares = [
    cumulative[0],
    cumulative[1] - cumulative[0],
    cumulative[2] - cumulative[1],
    1 - cumulative[2],
  ].map((value) => clamp(value, 0, 1));
  const bands = [
    { id: "band-fast", label: "Under 500 ms", share: shares[0] },
    { id: "band-mid", label: "500 ms to 1 s", share: shares[1] },
    { id: "band-slow", label: "1 to 2 s", share: shares[2] },
    { id: "band-tail", label: "Over 2 s", share: shares[3] },
  ];
  const serviceHealth =
    v.mean >= 300 || v.p99 >= 1_500 ? "crit" : v.p99 >= 500 ? "warn" : "ok";
  const timeoutHealth = v.timeoutRate >= 1 ? "crit" : v.timeoutRate >= 0.1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(v.requestRate).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "API service",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(v.mean / 500),
        throughput: v.requestRate,
        sublabel: `mean ${v.mean.toFixed(0)}ms`,
        detail: `Mean is ${v.mean.toFixed(0)}ms, p99 is ${v.p99.toFixed(0)}ms. The mean is not the user experience when the tail times out.`,
        meta: { view: "flow" },
      },
      ...bands.map((band) => ({
        id: band.id,
        label: band.label,
        kind: "service" as const,
        health: (band.id === "band-tail" || band.id === "band-slow" ? timeoutHealth : "ok") as SimNode["health"],
        utilization: band.share,
        throughput: v.requestRate * band.share,
        sublabel: `${(band.share * 100).toFixed(band.id === "band-fast" ? 1 : 2)}% of requests`,
        detail: `${Math.round(v.requestRate * band.share).toLocaleString()} requests/s in this band. Each band is a latency range, not a separate service.`,
        meta: { view: "flow" },
      })),
    ],
    edges: [
      edge("client-service", "client", "service", 0.9),
      ...bands.map((band) => edge(`service-${band.id}`, "service", band.id, band.share, band.id === "band-tail" ? timeoutHealth : "ok")),
    ],
    metrics: [
      metric("mean", "Mean latency", v.mean, "ms", 200, 300, "ms"),
      metric("p50", "p50 latency", v.p50, "ms", undefined, undefined, "ms"),
      metric("p95", "p95 latency", v.p95, "ms", undefined, undefined, "ms"),
      metric("p99", "p99 latency", v.p99, "ms", 500, 1_500, "ms"),
      metric("p999", "p999 latency", v.p999, "ms", 3_000, 5_000, "ms"),
      metric("timeout-rate", "Timeout rate", v.timeoutRate, "%", 0.1, 1, "percent"),
      metric("slow-rps", "Slow requests", v.slowRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), tailHidden: 0, slowShare: s },
    summary: `Mean ${v.mean.toFixed(0)}ms, p50 ${v.p50.toFixed(0)}ms, p99 ${v.p99.toFixed(0)}ms, timeouts ${v.timeoutRate.toFixed(2)}%.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "mean",
    metricId: "mean",
    warn: 200,
    crit: 300,
    title: "The mean itself crossed the latency SLO",
    cause:
      "Enough requests are slow that the average has moved. The tail is no longer rare; it is large enough to dominate the distribution.",
    fix:
      "Break latency down by endpoint and dependency, find the slow cohort, and fix it. Do not tune the average while the tail is still timing out.",
    checkFirst: [
      "Compare mean with p50 and p99.",
      "Check whether the slow cohort grew or its latency grew.",
      "Check whether retries are adding duplicate slow requests.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "p99 latency crossed the tail SLO",
    cause:
      "At least one percent of requests are slower than this value. A small slow cohort can hold the p99 high while the mean and p50 stay healthy.",
    fix:
      "Find the slow cohort by endpoint, instance, or dependency. Reduce its latency or its share, then recheck p99 and the timeout rate together.",
    checkFirst: [
      "Break p99 down by endpoint, instance, and dependency.",
      "Check whether the slow requests share a data size, tenant, or region.",
      "Check whether a timeout or retry is creating a second slow request.",
    ],
  },
  {
    id: "p999",
    metricId: "p999",
    warn: 3_000,
    crit: 5_000,
    title: "p999 latency is in the multi-second range",
    cause:
      "The rarest requests are waiting on something that the p99 view does not capture: a cold cache, a lock, a garbage collection pause, or a retry.",
    fix:
      "Trace the slowest requests and fix the specific stall. p999 needs enough traffic to be statistically meaningful, so confirm the sample count before acting.",
    checkFirst: [
      "Check the sample count behind p999.",
      "Check for stalls, locks, cold starts, and retries.",
      "Compare p999 with the timeout distribution.",
    ],
  },
  {
    id: "timeout-rate",
    metricId: "timeout-rate",
    warn: 0.1,
    crit: 1,
    title: "One percent of requests are timing out while the mean is healthy",
    cause:
      "The slow cohort exceeds the client timeout. These requests fail even though the mean and p50 look acceptable, and retries can multiply the load.",
    fix:
      "Reduce the slow cohort below the timeout or raise the timeout only with a latency budget. Bound retries and verify that users see success, not just a fast average.",
    checkFirst: [
      "Compare timeout rate with p99 and p999.",
      "Check whether retries are counted as new requests.",
      "Check the server-side completion time for requests the client abandoned.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const percentilesModel: SimModel = {
  id: "foundations-percentiles",
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
    const key = JSON.stringify(p);
    const changed = frame.flags.paramsKey !== key;
    next.flags = { ...frame.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (changed && frame.t <= 0.11) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = frame.series;
    }
    const jitter = rng.between(-0.005, 0.005);
    next.metrics = next.metrics.map((item) =>
      item.id === "slow-rps" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.mean < 300 && values.timeoutRate >= 1 && frame.flags.tailHidden !== 1) {
      pushEvent(next, {
        id: "tail-hidden",
        at: frame.t,
        severity: "warn",
        title: "The mean is healthy and one percent is timing out",
        detail: `Mean latency is ${values.mean.toFixed(0)}ms, but p99 is ${values.p99.toFixed(0)}ms and ${values.timeoutRate.toFixed(2)}% of requests exceed the ${Math.round(values.timeoutMs)}ms timeout.`,
        nodeId: "service",
        metricId: "timeout-rate",
      });
      next.flags.tailHidden = 1;
    }
    if (values.timeoutRate < 0.1) next.flags.tailHidden = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `Mean ${values.mean.toFixed(0)}ms, p50 ${values.p50.toFixed(0)}ms, p99 ${values.p99.toFixed(0)}ms, timeouts ${values.timeoutRate.toFixed(2)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `Mean ${v.mean.toFixed(0)}ms, p50 ${v.p50.toFixed(0)}ms, p95 ${v.p95.toFixed(0)}ms, p99 ${v.p99.toFixed(0)}ms, p999 ${v.p999.toFixed(0)}ms.`,
      `${v.slowShare.toFixed(1)}% of requests are in the slow cohort: about ${Math.round(v.slowRps).toLocaleString()} requests/s at ${Math.round(v.requestRate).toLocaleString()} rps.`,
      `${v.timeoutRate.toFixed(2)}% of requests exceed the ${Math.round(v.timeoutMs)}ms timeout; that is ${Math.round((v.timeoutRate / 100) * v.requestRate).toLocaleString()} failed requests/s.`,
    ];
    if (v.mean < 300 && v.timeoutRate >= 1) {
      items.push("The average is inside its SLO while the timeout rate is not. A mean-only alert would miss this incident.");
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
    description: "A tiny slow cohort and no timeouts. All percentiles stay close to the baseline.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 1.2% slow cohort raises p99 and the timeout rate while the mean stays near 50ms.",
    tone: "warn",
    params: defaults({ baselineMs: 34, slowShare: 1.2, slowMs: 1_600, timeoutMs: 2_000 }),
  },
  {
    id: "failure",
    label: "Tail timeout",
    description: "2.2% of requests sit above one second; p99 is near 2s and one percent time out while the mean is 81ms.",
    tone: "crit",
    params: defaults({ baselineMs: 36, slowShare: 2.2, slowMs: 2_300, timeoutMs: 1_900 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The slow cohort is smaller and faster, so the tail falls below the timeout and p99 returns to baseline.",
    tone: "ok",
    params: defaults({ baselineMs: 34, slowShare: 0.5, slowMs: 1_200, timeoutMs: 2_500 }),
  },
];

const experiment: Experiment = {
  id: "predict-tail",
  title: "Predict which users feel the incident",
  simId: "percentiles",
  question:
    "The mean is 81ms and p99 is about 2s. Which statement describes the user experience?",
  prediction: {
    options: [
      { id: "none", label: "No one: the mean is far below the SLO" },
      { id: "tail", label: "About one percent of requests time out while most users see a fast response" },
      { id: "all", label: "Every request takes about 2s" },
      { id: "p50", label: "The p50 user sees the 2s delay" },
    ],
    correctOptionId: "tail",
    explanation:
      "The distribution is a mixture: 97.8% of requests are near 36ms and 2.2% are in a slow cohort above one second. The mean is pulled up but stays low; the p99 and the timeout rate describe the users who fail.",
  },
  setup: defaults({ baselineMs: 36, slowShare: 2.2, slowMs: 2_300, timeoutMs: 1_900 }),
  runFor: 20,
  observe: [
    "p50 and p95 stay at the 36ms baseline.",
    "p99 rises to about 1.97s and p999 to about 3.7s.",
    "The timeout rate is about 1.05%, or roughly 210 requests per second at 20k rps.",
    "The mean is about 81ms, below the 300ms mean SLO.",
  ],
  explain:
    "A percentile is a position in the distribution, not an average of the values. With a 2.2% slow cohort, the 99th percentile falls inside that cohort, while the 95th percentile is still in the fast majority. The timeout count is a direct measure of users who did not get a useful response, even though the mean looks healthy.",
  fix: defaults({ baselineMs: 34, slowShare: 0.5, slowMs: 1_200, timeoutMs: 2_500 }),
  debrief:
    "The recovery shrinks the slow cohort and gives the client more room before it abandons the request. p99 returns to the baseline and the timeout rate falls to zero. The mean falls with the tail, but the mean was never the signal that described the failure.",
};

const primer: Block[] = [
  {
    type: "h2",
    text: "What it is",
  },
  {
    type: "p",
    text: "A percentile is the value below which a given share of requests fall. p50 is the median: half the requests are faster, half are slower. p99 is the value below which 99% of requests fall: 99% are faster, and the slowest 1% are above it. A mean is the sum of all latencies divided by the count. It is useful for cost and capacity, but it is not a description of the user experience when the distribution has a long tail.",
  },
  {
    type: "p",
    text: "Latency distributions are usually not symmetric. Most requests are fast, a small cohort is slow because of a cache miss, a lock, a retry, or a dependency, and a few are extremely slow. The mean is pulled toward the tail, but it can still look acceptable while a meaningful share of users time out. The percentile you choose should match the user action: p50 for a typical page view, p99 for an interactive request, p999 when the action is expensive or when failures are unacceptable.",
  },
  {
    type: "h2",
    text: "Where it sits",
  },
  {
    type: "p",
    text: "Percentiles sit on the request path, after the service and its dependencies have produced a latency sample. They are only as good as the histogram behind them. A p99 computed from an average of per-minute percentiles is not a p99. A p99 computed from a histogram with coarse buckets is approximate. A p99 computed from a sample that omits stalled requests is biased, which is the subject of the next module.",
  },
  {
    type: "table",
    headers: ["Signal", "Failure preset", "What it describes"],
    rows: [
      ["Mean", "81ms", "Total latency divided by request count; hides the shape"],
      ["p50", "36ms", "The typical request"],
      ["p95", "36ms", "Still inside the fast majority"],
      ["p99", "1.97s", "Inside the slow cohort"],
      ["p999", "3.67s", "The rare, very slow requests"],
      ["Timeout rate", "1.05%", "Users who did not get a useful response"],
    ],
  },
  {
    type: "p",
    text: "The values above come from the failure preset in this module. They are illustrative, not a benchmark. The structure is the lesson: the mean and p50 can agree that the service is fast while the p99 and timeout rate show a real incident. If the product promises a response within two seconds, the 1.05% that miss the client timeout is the number that matters.",
  },
  {
    type: "h2",
    text: "What you'll see",
  },
  {
    type: "list",
    items: [
      "A latency-band view: fast, mid, slow, and tail shares of the request population.",
      "Mean, p50, p95, p99, and p999 side by side.",
      "Timeout rate, which converts the tail into failed requests per second.",
      "Slow request count, which shows how many users are in the cohort.",
      "A timeout control, which changes the failure boundary without changing the distribution.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Tail timeout and compare the mean with p99 and the timeout rate. Move the slow-share slider and watch which percentiles move first. Before applying Recovery, decide which percentile your product actually promises.",
  },
  { type: "sim", simId: "percentiles" },
  {
    type: "p",
    text: "There is a second trap: averaging percentiles. If one instance reports p99 100ms and another reports p99 2s, the average is 1.05s, which is not the fleet p99. The fleet p99 needs the merged histogram, or at least a weighted calculation from the underlying buckets. The same rule applies across time windows: an average of per-minute p99 values is not the p99 of the hour.",
  },
  { type: "experiment", experimentId: "predict-tail" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset put 2.2% of requests into a slow cohort around 2.3s. The fast majority stayed at 36ms, so p50 and p95 did not move. The 99th percentile landed inside the slow cohort at about 1.97s, and p999 reached about 3.67s. With a 1.9s client timeout, about 1.05% of requests failed. At 20,000 rps, that is roughly 210 failed requests every second.",
  },
  {
    type: "p",
    text: "The mean was about 81ms, well below a 300ms SLO. A mean-only dashboard would have called the service healthy. The tail was not a rounding error; it was a stable subpopulation large enough to dominate the p99 and produce a continuous stream of timeouts. Reducing the slow cohort and its latency brought p99 back to the baseline and removed the timeouts.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Prometheus: `http_request_duration_seconds_bucket` with `histogram_quantile(0.99, ...)`, split by endpoint, instance, and status.",
      "Datadog: latency percentiles from a distribution metric, not an average of per-host percentiles.",
      "CloudWatch: `ExtendedStatistics` with `p99` on a custom latency metric, or a histogram from the application.",
      "Traces: the slow span and its child spans, which show whether the tail is local, a dependency, or a retry.",
      "Timeouts and retries: client-side timeout counters, server-side cancellations, and retry volume by endpoint.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare mean, p50, p99, and the timeout rate together. If p99 is high and the mean is low, find the slow cohort: which endpoint, instance, tenant, or dependency is in it. If p99 is high but the timeout rate is zero, check whether the product promise is actually being measured. If the timeout rate is high, count the users, not just the percentile.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Break the distribution down by endpoint, instance, dependency, and request type before choosing a fix.",
      "Find the slow cohort and its cause: cache misses, locks, cold starts, retries, or a slow dependency.",
      "Reduce the cohort's latency or its share; do not tune the mean while the tail is timing out.",
      "Set the timeout from the latency budget and bound retries so one slow request does not become several.",
      "Verify p99, p999, and the timeout rate together after the change.",
      "Check the merged histogram, not an average of per-instance percentiles.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Optimizing p99 can add cost or complexity that does not improve the typical request.",
      "A longer timeout reduces timeout errors but holds resources longer and can worsen queueing.",
      "Retries can improve success for transient failures but amplify load and add tail latency.",
      "p999 needs enough traffic to be meaningful; at low volume it is a handful of samples.",
      "A percentile is a position, not a promise. The SLO should name the percentile and the window.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "which-number",
    question:
      "Mean latency is 80ms and p99 is 1.9s. Which number describes the user experience?",
    difficulty: 1,
    hints: [
      "Think about the shape of the distribution, not the center.",
      "Ask what a user who times out experiences.",
    ],
    answer:
      "Both describe part of it, but p99 and the timeout rate describe the users who are failing. A mean of 80ms can coexist with 1% of requests above 1.9s. If the product promise is a response within two seconds, the p99 is the relevant tail signal, and the timeout rate tells me how many users actually failed. I would also look at p50 to confirm the typical request is fast, and at p999 to see how bad the tail gets. A mean alone would hide the incident.",
    followUps: [
      "What if the product is a batch export rather than an interactive page?",
      "How would you find the slow cohort?",
      "Which number would you put in the SLO?",
    ],
    redFlags: [
      "Says the mean is the user experience.",
      "Ignores the timeout rate.",
      "Treats p99 as a guarantee for every user.",
    ],
    rubric: [
      "Uses the distribution, not only the mean.",
      "Connects p99 to the timeout.",
      "Asks for the product promise.",
      "Names the slow cohort.",
    ],
  },
  {
    id: "average-percentiles",
    question:
      "Two instances report p99 100ms and p99 2s. Is the fleet p99 1.05s?",
    difficulty: 2,
    hints: [
      "A percentile is not additive.",
      "The fleet percentile needs the merged distribution.",
    ],
    answer:
      "No. Averaging two p99 values assumes the percentiles are arithmetic quantities, which they are not. The fleet p99 depends on the merged histogram and the traffic split. If the slow instance handles 10% of requests, its 2s tail may still dominate the fleet p99; if it handles 0.1%, it may not. I would merge the underlying buckets, or compute a weighted estimate from the histograms, and I would check the sample count on each instance. The same mistake appears when averaging per-minute p99 values into an hourly number.",
    followUps: [
      "How would you compute the fleet p99 from Prometheus histograms?",
      "What if one instance has very low traffic?",
      "Why is an average of per-minute p99 wrong?",
    ],
    redFlags: [
      "Averages the two p99 values.",
      "Ignores traffic weight.",
      "Uses a percentile without a histogram.",
    ],
    rubric: [
      "Rejects arithmetic averaging.",
      "Mentions merged histograms or buckets.",
      "Accounts for traffic weight.",
      "Notes sample count.",
    ],
  },
  {
    id: "tail-amplification",
    question:
      "A page fans out to three services, each with a 1% slow probability. Why is the page's tail worse than 1%?",
    difficulty: 2,
    hints: [
      "The page waits for all three calls.",
      "One slow dependency is enough to slow the page.",
    ],
    answer:
      "If the calls are independent and the page waits for all three, the probability that at least one is slow is 1 − 0.99³, which is about 3%. The page's tail is roughly three times the per-service tail, even though no single service is worse. The effect grows with fan-out and with retries. The fix is not only to make each service faster; it is to reduce the number of serial dependencies, hedge or parallelize calls, and set a per-call deadline that leaves budget for the rest of the page.",
    followUps: [
      "What if the calls are sequential rather than parallel?",
      "How do hedged requests change the tail?",
      "What does this imply for a microservice architecture?",
    ],
    redFlags: [
      "Assumes the page tail equals the service tail.",
      "Ignores fan-out.",
      "Adds retries without a budget.",
    ],
    rubric: [
      "Explains the at-least-one probability.",
      "Connects fan-out to user impact.",
      "Names a mitigation.",
      "Mentions deadlines or hedging.",
    ],
  },
  {
    id: "choose-percentile",
    question:
      "How do you choose the percentile for an SLO instead of picking p99 by habit?",
    difficulty: 3,
    hints: [
      "Start from the user action and the cost of failure.",
      "A percentile needs a window and enough samples.",
    ],
    answer:
      "I start from the user action. For a page view, p50 and p95 describe most sessions, but p99 describes the users who abandon. For a checkout or a write, the cost of a slow request is higher, so I may use p99 or p999 and pair it with a success-rate SLO. I also check the traffic volume: p999 at 100 requests per day is a handful of samples and should not drive the SLO. The SLO should name the percentile, the window, and the population, and it should be paired with a timeout or error budget so a fast average cannot hide failures.",
    followUps: [
      "What would you do at low traffic?",
      "How does the window change the meaning?",
      "When would you use a maximum instead of a percentile?",
    ],
    redFlags: [
      "Picks p99 for every service.",
      "Ignores sample count.",
      "Sets an SLO without a window.",
    ],
    rubric: [
      "Ties the percentile to the user action.",
      "Considers cost of failure.",
      "Checks sample count and window.",
      "Pairs with timeout or error budget.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Latency is recorded as a histogram, not only as an average.",
      "Dashboards show p50, p99, p999, and the timeout rate by endpoint.",
      "Percentiles are computed from merged histograms, not averaged across instances.",
      "The SLO names the percentile, the window, and the population.",
      "The slow cohort has a known owner and a way to be isolated.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the mean with p99 and the timeout rate before declaring health.",
      "Find the slow cohort by endpoint, instance, tenant, or dependency.",
      "Check whether retries are adding requests and duplicating the tail.",
      "Decide whether to reduce the cohort's latency, its share, or the timeout boundary.",
      "Count failed users per second, not only the percentile value.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify p99 and the timeout rate at peak after the change.",
      "Check p999 and its sample count before drawing conclusions.",
      "Remove any temporary timeout or retry change that hides the tail.",
      "Re-run the experiment with the production fan-out and timeout.",
    ],
  },
];

const references = [
  {
    title: "Monitoring Distributed Systems",
    url: "https://sre.google/sre-book/monitoring-distributed-systems/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Percentiles, averages, and the limits of a single latency number.",
  },
  {
    title: "The Tail at Scale",
    url: "https://research.google/pubs/the-tail-at-scale/",
    publisher: "Google Research",
    kind: "docs" as const,
    note: "Why tail latency amplifies with fan-out and what to do about it.",
  },
  {
    title: "AWS Builders' Library",
    url: "https://aws.amazon.com/builders-library/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Instrumentation and percentile practice for distributed services.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    percentiles: {
      model: percentilesModel,
      presets,
      instructions:
        "Compare Mean, p50, p99, and the timeout rate. Apply Tail timeout, then move the slow-share slider to see which percentile moves first.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The request rate and latency mixture are teaching values; the relationship between a slow cohort, percentiles, and timeouts is the lesson.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-use-red",
    "foundations-coordinated-omission",
    "observability-golden-signals",
    "foundations-sli-slo-error-budget",
  ],
};
