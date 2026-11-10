import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  HistogramData,
  Params,
  ParamSpec,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { hashString } from "@/lib/rng";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Requests on the endpoint",
    min: 20,
    max: 3_000,
    step: 20,
    value: 600,
    unit: " req/s",
    group: "Traffic",
    help: "Requests per second observed by the histogram. More traffic raises the chance that a scrape contains a slow exemplar.",
    format: "rps",
  },
  {
    id: "slowShare",
    label: "Slow request share",
    min: 0.1,
    max: 10,
    step: 0.1,
    value: 0.4,
    unit: "%",
    group: "Traffic",
    help: "Share of requests above one second. This drives the p99 and the supply of candidate slow traces.",
    format: "percent",
  },
  {
    id: "traceSample",
    label: "Trace sample rate",
    min: 0.1,
    max: 100,
    step: 0.1,
    value: 90,
    unit: "%",
    scale: "log",
    group: "Tracing",
    help: "Share of requests recorded as traces. An exemplar can only point to a trace that exists in the trace store.",
    format: "percent",
  },
  {
    id: "scrapeInterval",
    label: "Scrape interval",
    min: 5,
    max: 60,
    step: 5,
    value: 15,
    unit: " s",
    group: "Collection",
    help: "How often the histogram is scraped. A longer interval collects fewer exemplars per minute.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  slowShare: number;
  traceSample: number;
  scrapeInterval: number;
  p99: number;
  slowRate: number;
  sampledSlow: number;
  expectedPerScrape: number;
  linkHit: number;
  missingExemplar: number;
  linksPerMinute: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.round(num(p, "requestRate", 600));
  const slowShare = num(p, "slowShare", 0.4);
  const traceSample = num(p, "traceSample", 90);
  const scrapeInterval = Math.round(num(p, "scrapeInterval", 15));
  const p99 = 300 + 210 * Math.sqrt(slowShare * 10);
  const slowRate = requestRate * (slowShare / 100);
  const sampledSlow = slowRate * (traceSample / 100);
  const expectedPerScrape = sampledSlow * scrapeInterval;
  const linkHit = 1 - Math.exp(-expectedPerScrape);
  return {
    requestRate,
    slowShare,
    traceSample,
    scrapeInterval,
    p99,
    slowRate,
    sampledSlow,
    expectedPerScrape,
    linkHit,
    missingExemplar: Math.exp(-expectedPerScrape) * 100,
    linksPerMinute: linkHit * (60 / scrapeInterval),
  };
}

function healthFromP99(value: number): Health {
  if (value >= 1_500) return "crit";
  if (value >= 800) return "warn";
  return "ok";
}

function healthFromMissing(value: number): Health {
  if (value >= 60) return "crit";
  if (value >= 25) return "warn";
  return "ok";
}

const BUCKET_LABELS = [
  "<50ms",
  "50-100ms",
  "100-250ms",
  "250-500ms",
  "500ms-1s",
  "1-2s",
  "2-5s",
  ">5s",
];
const FAST_WEIGHTS = [0.1, 0.25, 0.3, 0.2, 0.15];
const SLOW_WEIGHTS = [0.55, 0.35, 0.1];
const SLOW_MIDPOINTS = [1_400, 3_200, 6_500];

function exemplarTraceId(seed: number, label: string): string {
  return [0, 1, 2, 3]
    .map((index) => hashString(`${seed}:${label}:${index}`).toString(16).padStart(8, "0"))
    .join("");
}

function buildHistogram(values: Computed, seed: number): HistogramData {
  const total = Math.max(1, Math.round(values.requestRate * values.scrapeInterval));
  const slowTotal = Math.round(total * (values.slowShare / 100));
  const fastTotal = Math.max(0, total - slowTotal);
  const fastCounts = FAST_WEIGHTS.map((weight) => Math.round(fastTotal * weight));
  fastCounts[fastCounts.length - 1] = Math.max(
    0,
    fastTotal - fastCounts.slice(0, -1).reduce((sum, count) => sum + count, 0),
  );
  const slowCounts = SLOW_WEIGHTS.map((weight) => Math.round(slowTotal * weight));
  slowCounts[slowCounts.length - 1] = Math.max(
    0,
    slowTotal - slowCounts.slice(0, -1).reduce((sum, count) => sum + count, 0),
  );
  const buckets: HistogramData["buckets"] = BUCKET_LABELS.map((label, index) => ({
    label,
    count: index < FAST_WEIGHTS.length ? fastCounts[index] : slowCounts[index - FAST_WEIGHTS.length],
  }));
  const slowIndex = buckets.findIndex(
    (bucket, index) => index >= FAST_WEIGHTS.length && bucket.count > 0,
  );
  if (slowIndex >= 0 && values.missingExemplar < 25) {
    buckets[slowIndex].exemplar = {
      traceId: exemplarTraceId(
        seed,
        `${buckets[slowIndex].label}:${values.requestRate}:${values.slowShare}:${values.scrapeInterval}`,
      ),
      durationMs: SLOW_MIDPOINTS[slowIndex - FAST_WEIGHTS.length],
      service: "checkout-api",
    };
  }
  return { unit: " requests", buckets };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metrics: [string, number, number][] = [
    ["p99", values.p99, 8],
    ["missing-exemplar", values.missingExemplar, 2],
    ["exemplar-links", values.linksPerMinute, 0.1],
    ["sample-rate", values.traceSample, 0.5],
    ["slow-requests", values.slowRate * 60, 2],
  ];
  for (const [id, value, amplitude] of metrics) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value + Math.sin((index + (seed % 8)) / 2.6) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const slowHealth = healthFromP99(values.p99);
  const linkHealth = healthFromMissing(values.missingExemplar);
  return {
    t: 0,
    histogram: buildHistogram(values, seed),
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        throughput: values.requestRate,
        sublabel: `${values.requestRate} req/s`,
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: "ok",
        throughput: values.requestRate,
        sublabel: "HTTP",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: slowHealth,
        throughput: values.requestRate,
        sublabel: `p99 ${values.p99.toFixed(0)}ms`,
        meta: { view: "flow" },
      },
      {
        id: "sdk",
        label: "OTel SDK",
        kind: "service",
        health: "ok",
        sublabel: `records ${values.traceSample}% of traces`,
        meta: { view: "flow" },
      },
      {
        id: "metrics",
        label: "Histogram store",
        kind: "storage",
        health: "ok",
        sublabel: `${values.requestRate} samples/s, buckets and counts`,
        meta: { view: "flow" },
      },
      {
        id: "links",
        label: "Exemplar links",
        kind: "service",
        health: linkHealth,
        sublabel: `${values.linksPerMinute.toFixed(1)} slow links/min`,
        detail: `${values.missingExemplar.toFixed(0)}% of scrapes contain no slow exemplar. A link needs a recorded trace and an attached exemplar on the histogram observation.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      { id: "client-lb", from: "client", to: "lb", rate: 1, health: "ok" },
      { id: "lb-service", from: "lb", to: "service", rate: 1, health: slowHealth },
      { id: "service-sdk", from: "service", to: "sdk", rate: 1, health: "ok" },
      { id: "sdk-metrics", from: "sdk", to: "metrics", rate: 1, health: "ok" },
      {
        id: "sdk-links",
        from: "sdk",
        to: "links",
        rate: values.traceSample / 100,
        health: "ok",
      },
      {
        id: "metrics-links",
        from: "metrics",
        to: "links",
        rate: values.linkHit,
        health: linkHealth,
      },
    ],
    metrics: [
      metric("p99", "Endpoint p99", values.p99, "ms", 800, 1_500, "ms"),
      metric("missing-exemplar", "Scrapes with no slow exemplar", values.missingExemplar, "%", 25, 60, "percent"),
      metric("exemplar-links", "Exemplar links", values.linksPerMinute, " /min", undefined, undefined, "number"),
      metric("sample-rate", "Trace sample rate", values.traceSample, "%", undefined, undefined, "percent"),
      metric("slow-requests", "Slow requests", values.slowRate * 60, " /min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `p99 ${values.p99.toFixed(0)}ms; ${values.missingExemplar.toFixed(0)}% of scrapes had no slow exemplar; ${values.linksPerMinute.toFixed(1)} slow links/min.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 800,
    crit: 1_500,
    title: "The p99 bucket is in the slow tail",
    cause: "A small share of requests is much slower than the rest. The histogram shows the aggregate, but a percentile cannot tell you which request produced it or where the time went.",
    fix: "Use an exemplar on the slow bucket to open a concrete trace, then read the span waterfall. If no exemplar is attached, fix the instrumentation or the sample rate before guessing at a cause.",
    checkFirst: [
      "Confirm the slow bucket has a nonzero count.",
      "Check whether the histogram series carries exemplars.",
      "Open one linked trace and compare its span timing with the bucket.",
    ],
  },
  {
    id: "missing-exemplar",
    metricId: "missing-exemplar",
    warn: 25,
    crit: 60,
    title: "The slow bucket has no trace to open",
    cause: "A link requires both a recorded trace and an exemplar attached to the histogram observation. A low trace sample rate, or a metrics library without exemplar support, leaves the aggregate intact but the individual request unreachable.",
    fix: "Raise the trace sample rate for the endpoint during the investigation and verify that the histogram instrumentation attaches exemplars. Then confirm the linked trace actually exists before the sample window rolls over.",
    checkFirst: [
      "Check the SDK and exporter versions for exemplar support on histograms.",
      "Check the trace sample rate for the service that records the endpoint.",
      "Take a known slow request and follow its trace ID from the metric to the trace store.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const exemplarsModel: SimModel = {
  id: "observability-exemplars",
  visual: "histogram",
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
    const jitter = rng.between(-0.012, 0.012);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" || item.id === "exemplar-links"
        ? { ...item, value: Math.max(0, item.value * (1 + jitter)) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.missingExemplar >= 60 && frame.flags.exemplarGapSeen !== 1) {
      pushEvent(next, {
        id: "slow-bucket-no-exemplar",
        at: frame.t,
        severity: "warn",
        title: "Slow bucket has no exemplar to open",
        detail: `${values.missingExemplar.toFixed(0)}% of scrapes contain no slow exemplar at ${values.traceSample}% trace sampling. The histogram is still correct; the trace is missing.`,
        nodeId: "links",
        metricId: "missing-exemplar",
      });
      next.flags.exemplarGapSeen = 1;
    }
    if (values.missingExemplar < 60) next.flags.exemplarGapSeen = 0;
    next.summary = `p99 ${values.p99.toFixed(0)}ms; ${values.missingExemplar.toFixed(0)}% of scrapes had no slow exemplar; ${values.linksPerMinute.toFixed(1)} slow links/min.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The slow bucket holds ${Math.round(values.slowRate * 60)} requests per minute, but only ${values.sampledSlow.toFixed(2)} per second are recorded as traces.`,
      `One scrape covers ${values.scrapeInterval}s and expects ${values.expectedPerScrape.toFixed(2)} sampled slow requests. The chance of at least one exemplar is ${(values.linkHit * 100).toFixed(0)}%.`,
      `${values.missingExemplar.toFixed(0)}% of scrapes contain no slow exemplar. That is a tracing and instrumentation gap, not a bucket-count error.`,
      `At ${values.linksPerMinute.toFixed(1)} links per minute, finding a concrete slow request is fast only while the rate stays above one per incident window.`,
      `Raising trace sampling preserves the metric shape and adds link targets; it does not change the p99 by itself.`,
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Missing links", tone: "warn" },
    { label: "No evidence", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "600 req/s, 90% trace sampling, and a 15s scrape. Slow requests almost always have a link.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow release",
    description: "The slow share rises to 1.2% and p99 crosses the warning line. Exemplars still resolve.",
    tone: "warn",
    params: defaults({ slowShare: 1.2 }),
  },
  {
    id: "failure",
    label: "Sparse trace sampling",
    description: "A 60 req/s endpoint with a 4% slow class and 0.5% trace sampling. p99 is high and about 70% of scrapes contain no slow exemplar.",
    tone: "crit",
    params: defaults({ requestRate: 60, slowShare: 4, traceSample: 0.5, scrapeInterval: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Restore 95% trace sampling and a 15s scrape. The slow class is small again and links resolve.",
    tone: "ok",
    params: defaults({ traceSample: 95 }),
  },
];

const experiment: Experiment = {
  id: "predict-exemplar-link",
  title: "Predict what the exemplar dot proves",
  simId: "exemplars",
  question:
    "The p99 panel shows 1.6 seconds and the slow bucket has an exemplar dot. You click it. What does the dot give you?",
  prediction: {
    options: [
      { id: "one-trace", label: "One concrete slow trace with a trace ID, service, and duration" },
      { id: "distribution", label: "The full distribution of slow requests" },
      { id: "count", label: "The exact count of slow requests in the bucket" },
      { id: "query", label: "A link to the metric query that produced the p99" },
    ],
    correctOptionId: "one-trace",
    explanation:
      "An exemplar is a pointer attached to a metric observation. It carries a trace ID for one sampled request. Clicking the dot resolves that trace and shows its service and duration; the histogram still owns the counts and the percentile.",
  },
  setup: defaults({ requestRate: 60, slowShare: 4, traceSample: 95, scrapeInterval: 30 }),
  runFor: 20,
  observe: [
    "The dot opens a trace ID, checkout-api, and a duration near 1.4s.",
    "The slow bucket still shows the scrape count, and p99 stays at 1.6s.",
    "The exemplar is one sampled request, not a sample of every slow request.",
    "At 0.5% sampling the same bucket has no dot; that is the failure preset.",
  ],
  explain:
    "The exemplar is created at observation time and carries a trace ID. At 95% trace sampling on a 60 req/s endpoint, a scrape every 30 seconds has enough sampled slow requests to attach a dot. Clicking it gives one concrete trace, not a distribution and not a count. At 0.5% sampling the expected sampled slow requests per scrape is 0.36, so most scrapes have no dot; the visual omits it and the missing-exemplar metric explains why.",
  fix: defaults({ requestRate: 60, slowShare: 0.4, traceSample: 95, scrapeInterval: 30 }),
  debrief:
    "After the slow dependency is fixed, the slow bucket shrinks and p99 returns to 720ms; the exemplar still resolves. The dot was the evidence, not the fix. Keep the difference clear: the histogram says how many and how slow, the dot says which request, and the trace says where the time went.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A histogram aggregates latency into buckets. It answers how many requests were slow, but not which requests or why. An exemplar is a small sample attached to a metric observation that carries a trace ID, the observed value, and a timestamp. It is the bridge from an aggregate bucket to one concrete request in the trace store.",
  },
  {
    type: "p",
    text: "The exemplar is not a copy of the trace and it is not stored for every request. It is a pointer. That makes it cheap and it creates a dependency: the pointer is only useful if the trace it names exists and is retained long enough to open. If trace sampling dropped the request, the metric remains correct and the link has nowhere to go.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is request, histogram observation, scrape, metrics store, and then a trace lookup. The exemplar is attached where the observation is recorded, usually by the metrics SDK. The scrape carries it to the metrics backend, and the dashboard renders it as a dot or a link. A trace store is a separate system with its own sampling and retention.",
  },
  {
    type: "table",
    headers: ["Signal", "Answers", "Does not answer"],
    rows: [
      ["Histogram bucket", "How many requests were in this range", "Which request, or where its time went"],
      ["Exemplar", "One request that landed in this observation", "The full distribution or a representative sample"],
      ["Trace", "The span tree and timing for one request", "How common the pattern is across all requests"],
    ],
  },
  {
    type: "p",
    text: "Many scrapers keep a limited number of exemplars per bucket per scrape, so the interval matters. This model treats a scrape as a window with an expected number of sampled slow requests. The probability of at least one is one minus e to the power of negative expected count. The 1.6-second p99 and the four-percent slow share are illustrative values, not a benchmark.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Endpoint p99, with a warning at 800ms and a critical line at 1.5s.",
      "Scrapes with no slow exemplar: the share of scrapes that contain no link to a slow request.",
      "Exemplar links per minute: the actual supply of clickable slow requests.",
      "Trace sample rate and scrape interval: the two levers that turn a bucket into a link.",
      "A per-scrape latency histogram with eight buckets and a clickable dot on the first slow bucket when a sampled trace is available.",
      "An exemplar-links node that turns critical while the histogram store stays healthy, which is the diagnosis in one glance.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, click the dot on the 1-2s bucket, and read the trace ID, service, and duration. Apply Sparse trace sampling and note the dot disappears while p99 stays high. Use the trace sample slider to bring it back, then run the experiment and explain what the dot can and cannot prove.",
  },
  { type: "sim", simId: "exemplars" },
  { type: "experiment", experimentId: "predict-exemplar-link" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The histogram kept counting slow requests correctly. The exemplar supply did not. At 0.5% trace sampling on a 60 req/s endpoint, a scrape every 30 seconds expected 0.36 sampled slow requests, so most scrapes had no slow exemplar to attach. The slow bucket had no dot to click. The histogram was still correct; the trace was not recorded.",
  },
  {
    type: "p",
    text: "Restoring sampling to 95% made almost every scrape carry a link. The p99 did not fall, because the slow dependency was still slow. This separates two questions that are easy to merge during an incident: what is slow, and can I prove it with one request. The exemplar answers the second. The trace then answers where the time went.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Histogram series: a populated slow bucket with a count, and an exemplar field on some observations.",
      "Exemplar labels: a trace ID and often the observed value and timestamp on the metric sample.",
      "Trace lookup: the ID resolves, or it returns nothing because the trace was not sampled or has aged out.",
      "SDK and exporter versions: exemplar support differs by language and metrics library.",
      "Grafana or Prometheus query: the exemplar is visible in the graph but the trace link is configured separately.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the bucket has a count and an exemplar. If the count is there and the exemplar is not, check the metrics instrumentation and the trace sample rate, not the histogram layout. Then verify that the trace ID resolves in the trace store before you blame the dashboard.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Verify exemplar support on the histogram instrument and the exporter for the service language.",
      "Raise the trace sample rate for the endpoint or service during the investigation.",
      "Keep the trace retention long enough for the metric window you query.",
      "Confirm the dashboard's exemplar-to-trace link is configured and the trace ID is stored as a searchable attribute.",
      "Take one slow request end to end: metric observation, exemplar, trace ID, span waterfall.",
      "Restore the sample rate after the incident and record what the lower rate cannot answer.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Exemplars are cheap because they are pointers, but a pointer to a dropped trace is worthless.",
      "Higher trace sampling improves links and raises trace storage cost.",
      "A shorter scrape interval produces more exemplars per minute but more collection overhead.",
      "An exemplar is not a statistical sample. One linked slow trace is evidence for a cause, not a measurement of prevalence.",
      "Bucket layout still decides percentile accuracy. Exemplars help you investigate a bucket; they do not fix a bad one.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "metric-to-trace",
    question:
      "The p99 panel is high. Walk me through how you get from that graph to a single slow trace.",
    difficulty: 2,
    hints: [
      "Start with the bucket, not the percentile line.",
      "A link needs two systems to agree.",
    ],
    answer:
      "I would open the slow bucket and look for an exemplar, which carries a trace ID and the observed value. I would click through to the trace, then read the span waterfall for self time and waiting. If there is no exemplar, I would check whether the histogram instrumentation attaches them and whether the trace sample rate is high enough for the endpoint. I would also confirm the trace still exists within retention. The metric tells me where to look; the trace tells me why.",
    followUps: [
      "What if the exemplar points to a trace with no error?",
      "How would you confirm the exemplar is representative?",
      "What would you do if the bucket had no exemplars at all?",
    ],
    redFlags: [
      "Guesses at a cause from the p99 line.",
      "Assumes every metric sample has a trace.",
      "Ignores retention.",
    ],
    rubric: [
      "Starts from the slow bucket.",
      "Names the trace ID link.",
      "Checks sampling and instrumentation.",
      "Reads the span tree.",
    ],
  },
  {
    id: "missing-exemplar",
    question:
      "A dashboard shows an exemplar dot but clicking it returns no trace. What are the possible causes, in order of likelihood?",
    difficulty: 3,
    hints: [
      "The dot is evidence that the metric side worked.",
      "The trace side has its own sampling and retention.",
    ],
    answer:
      "The dot means the metrics side attached an exemplar, so I would focus on the trace. The trace may have been dropped by head sampling, filtered by the collector, or aged out of retention before the click. The trace ID may also be stored under a different attribute than the dashboard queries. I would take the ID from the exemplar and search the trace store directly, then check the service's sampler and the trace retention window.",
    followUps: [
      "How would you prove the trace was never recorded?",
      "What if only some services fail to resolve?",
      "How does tail sampling change the answer?",
    ],
    redFlags: [
      "Rebuilds the histogram.",
      "Blames the dashboard without checking the ID.",
      "Ignores trace retention.",
    ],
    rubric: [
      "Separates metric and trace sides.",
      "Names sampling, filtering, retention.",
      "Checks the trace ID directly.",
      "Distinguishes services.",
    ],
  },
  {
    id: "exemplar-limits",
    question:
      "Why can an exemplar not replace a histogram or a statistically valid sample of traces?",
    difficulty: 2,
    hints: [
      "Think about how the exemplar is chosen.",
      "One request is an existence proof, not a rate.",
    ],
    answer:
      "An exemplar is a small, implementation-defined selection attached to a metric observation. It is chosen to be cheap, not to be representative. It can prove that a slow request exists and give you a trace to inspect, but it cannot tell you the share of traffic affected or the shape of the distribution. The histogram still provides the aggregate, and a proper sample is still needed for prevalence. I use the exemplar to explain one case and the histogram to size the problem.",
    followUps: [
      "How would you measure prevalence after finding one trace?",
      "What makes an exemplar biased?",
      "When would you keep every trace instead?",
    ],
    redFlags: [
      "Treats one exemplar as a representative sample.",
      "Drops the histogram after adding exemplars.",
      "Claims a rate from a single linked trace.",
    ],
    rubric: [
      "Separates existence from prevalence.",
      "Explains selection bias.",
      "Keeps the histogram for aggregates.",
      "Names a measurement for prevalence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Histogram instrumentation attaches exemplars for the services that own latency SLOs.",
      "The trace sample rate is high enough to produce links for the slow classes that matter.",
      "Trace retention covers the metric window used during an investigation.",
      "Dashboards are tested from exemplar to trace, not only from graph to bucket.",
      "Bucket boundaries are reviewed separately from exemplar configuration.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Open the slow bucket and check for an exemplar before theorizing.",
      "If the dot exists but the trace does not, search the trace ID directly.",
      "Check the sampler and retention for that service.",
      "Raise sampling for the affected endpoint if links are missing.",
      "Keep one exemplar and trace pair as evidence for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore the sample rate and confirm trace cost.",
      "Fix the instrumentation gap that produced empty links.",
      "Add a synthetic slow request to the exemplar test suite.",
      "Review whether the dashboard exposes the exemplar clearly.",
      "Document which investigations need full traces and which can use metrics.",
    ],
  },
];

const references = [
  {
    title: "Metrics data model: exemplars",
    url: "https://opentelemetry.io/docs/specs/otel/metrics/data-model/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Exemplar structure, trace context on metric points, and histogram data.",
  },
  {
    title: "Exemplars storage",
    url: "https://prometheus.io/docs/prometheus/latest/feature_flags/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Exemplar storage, scrape behavior, and the feature flag that enables it.",
  },
  {
    title: "Exemplars",
    url: "https://grafana.com/docs/grafana/latest/fundamentals/exemplars/",
    publisher: "Grafana",
    kind: "docs" as const,
    note: "How exemplars connect a metric panel to a trace and what the link requires.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    exemplars: {
      model: exemplarsModel,
      presets,
      instructions:
        "Start Healthy and click the exemplar dot on the 1-2s bucket to inspect its trace ID, service, and duration. Apply Sparse trace sampling and watch the dot disappear while p99 stays high. Use the trace sample slider to bring it back.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. The histogram shows one scrape; bucket counts and the 1.4s exemplar trace are teaching values. The dot is omitted when the missing-exemplar metric is at or above its 25% warning line.",
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
    "observability-histogram-quantile",
    "observability-promql-rate",
  ],
};
