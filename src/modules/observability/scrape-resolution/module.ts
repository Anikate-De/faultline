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

const SPIKE_START = 8;

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
    help: "Time between samples. The shortest detectable event is bounded by this interval.",
    format: "number",
  },
  {
    id: "spikeWidth",
    label: "Outage width",
    min: 1,
    max: 60,
    step: 1,
    value: 20,
    unit: " s",
    group: "Incident",
    help: "Duration of the error spike. A spike narrower than the scrape interval can fall between samples.",
    format: "number",
  },
  {
    id: "spikeMagnitude",
    label: "Outage error rate",
    min: 1,
    max: 100,
    step: 1,
    value: 2,
    unit: "%",
    group: "Incident",
    help: "Error rate while the outage is active. The dashboard only sees it if a scrape lands inside.",
    format: "percent",
  },
  {
    id: "seriesCount",
    label: "Series per scrape",
    min: 500,
    max: 10_000,
    step: 500,
    value: 2_000,
    unit: " series",
    group: "Cost",
    help: "Time series returned by the target. Ingest scales with series count divided by the scrape interval.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  scrapeInterval: number;
  spikeWidth: number;
  spikeMagnitude: number;
  seriesCount: number;
  spikeEnd: number;
  firstScrape: number;
  detected: boolean;
  samplesInSpike: number;
  blindSpot: number;
  ingest: number;
  phase: "before" | "during" | "after";
  observedError: number;
  missedOutage: number;
}

function compute(p: Params, t: number): Computed {
  const scrapeInterval = num(p, "scrapeInterval", 15);
  const spikeWidth = num(p, "spikeWidth", 20);
  const spikeMagnitude = num(p, "spikeMagnitude", 2);
  const seriesCount = num(p, "seriesCount", 2_000);
  const spikeEnd = SPIKE_START + spikeWidth;
  const firstScrape = Math.ceil(SPIKE_START / scrapeInterval) * scrapeInterval;
  const detected = firstScrape <= spikeEnd;
  const firstIndex = Math.ceil(SPIKE_START / scrapeInterval);
  const lastIndex = Math.floor(spikeEnd / scrapeInterval);
  const samplesInSpike = detected ? Math.max(0, lastIndex - firstIndex + 1) : 0;
  const blindSpot = Math.max(0, scrapeInterval - spikeWidth);
  const ingest = (seriesCount * 60) / scrapeInterval;
  const phase = t < SPIKE_START ? "before" : t < spikeEnd ? "during" : "after";
  const lastSample = detected ? Math.floor(spikeEnd / scrapeInterval) * scrapeInterval : -1;
  const observedError =
    detected && t >= firstScrape && t < lastSample + scrapeInterval ? spikeMagnitude : 0;
  const missedOutage = phase === "after" && !detected ? spikeMagnitude : 0;
  return {
    scrapeInterval,
    spikeWidth,
    spikeMagnitude,
    seriesCount,
    spikeEnd,
    firstScrape,
    detected,
    samplesInSpike,
    blindSpot,
    ingest,
    phase,
    observedError,
    missedOutage,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const points = 24;
  const jitter = (index: number) => 0.98 + 0.04 * Math.sin((index + (seed % 7)) / 2.7);
  const seeds: [string, number, number][] = [
    ["observed-error", values.observedError, 0.1],
    ["missed-outage", values.missedOutage, 0.1],
    ["blind-spot", values.blindSpot, 0.3],
    ["ingest", values.ingest, 80],
    ["spike-samples", values.samplesInSpike, 0.05],
    ["series", values.seriesCount, 10],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: points }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t = 0): SimFrame {
  const values = compute(p, t);
  const scraperHealth = healthFor(values.blindSpot, 5, 15);
  const ingestHealth = healthFor(values.ingest, 15_000, 30_000);
  const outageHealth = healthFor(values.spikeMagnitude, 5, 25);
  const serviceHealth = values.phase === "during" ? outageHealth : "ok";
  const dashboardHealth = healthFor(values.observedError, 5, 25);
  const oncallHealth = healthFor(values.observedError, 5, 25);
  return {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: serviceHealth,
        sublabel: `${values.spikeMagnitude.toFixed(0)}% errors during outage`,
        meta: { view: "flow" },
      },
      {
        id: "scraper",
        label: "Prometheus scrape",
        kind: "worker",
        health: scraperHealth,
        sublabel: `${values.scrapeInterval.toFixed(0)}s interval`,
        meta: { view: "flow" },
      },
      {
        id: "tsdb",
        label: "Time-series store",
        kind: "storage",
        health: ingestHealth,
        utilization: clamp(values.ingest / 30_000),
        sublabel: `${Math.round(values.ingest).toLocaleString()} samples/min`,
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "Error dashboard",
        kind: "service",
        health: dashboardHealth,
        sublabel: values.detected
          ? `${values.samplesInSpike} sample(s) inside`
          : "no sample inside",
        meta: { view: "flow" },
      },
      {
        id: "oncall",
        label: "On-call engineer",
        kind: "external",
        health: oncallHealth,
        sublabel: values.missedOutage > 0 ? "retrospective miss" : "sees the signal",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("service-scraper", "service", "scraper", 1, serviceHealth),
      edge("scraper-tsdb", "scraper", "tsdb", clamp(values.ingest / 30_000), ingestHealth),
      edge("tsdb-dashboard", "tsdb", "dashboard", 1, dashboardHealth),
      edge("dashboard-oncall", "dashboard", "oncall", values.detected ? 1 : 0, oncallHealth),
    ],
    metrics: [
      metric("observed-error", "Observed error rate", values.observedError, "%", 5, 25, "percent"),
      metric("missed-outage", "Missed outage", values.missedOutage, "%", 1, 50, "percent"),
      metric("blind-spot", "Blind spot", values.blindSpot, " s", 5, 15, "number"),
      metric("ingest", "Ingest", values.ingest, " samples/min", 15_000, 30_000, "number"),
      metric(
        "spike-samples",
        "Samples inside outage",
        values.samplesInSpike,
        "",
        undefined,
        undefined,
        "count",
      ),
      metric("series", "Series per scrape", values.seriesCount, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      detected: values.detected ? 1 : 0,
      phase: values.phase,
    },
    summary: `${values.scrapeInterval.toFixed(0)}s scrape, ${values.spikeWidth.toFixed(0)}s outage: ${values.samplesInSpike} sample(s) inside, ${values.missedOutage.toFixed(0)}% missed; ingest ${Math.round(values.ingest).toLocaleString()} samples/min.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "missed-outage",
    metricId: "missed-outage",
    warn: 1,
    crit: 50,
    title: "A short outage was never sampled",
    cause:
      "The error spike began and ended between scrapes. The dashboard stayed green while users experienced the failure.",
    fix: "Increase the sampling resolution for the signal that must catch this class of outage, or add a direct event signal. Recheck the ingest cost after the change.",
    checkFirst: [
      "Calculate the gap between the outage and the nearest scrape.",
      "Check logs, traces, or load-balancer metrics for the same window.",
      "Check whether the alert rule can ever see an event this short.",
    ],
  },
  {
    id: "blind-spot",
    metricId: "blind-spot",
    warn: 5,
    crit: 15,
    title: "The scrape interval leaves a large blind spot",
    cause:
      "The outage is shorter than the scrape interval. If it starts and ends between two scrapes, no sample records the error rate.",
    fix: "Shorten the scrape interval below the shortest outage you must detect, or add a signal that samples the event directly, such as logs, traces, or a synthetic probe.",
    checkFirst: [
      "Compare the outage width with the scrape interval.",
      "Check whether any scrape landed inside the outage window.",
      "Check whether an independent signal saw the event.",
    ],
  },
  {
    id: "observed-error",
    metricId: "observed-error",
    warn: 5,
    crit: 25,
    title: "The sampled error rate is above the service-level objective (SLO)",
    cause:
      "A scrape landed inside the outage and recorded the full error rate. The dashboard sees the failure, but detection is still limited by when the sample landed.",
    fix: "Respond to the error spike and verify the duration with a higher-resolution signal. Do not assume the sampled value is the peak.",
    checkFirst: [
      "Check the sampled error rate against the SLO.",
      "Check the outage duration in logs or traces.",
      "Check whether the next scrape shows recovery.",
    ],
  },
  {
    id: "ingest",
    metricId: "ingest",
    warn: 15_000,
    crit: 30_000,
    title: "Ingest cost is above the teaching budget",
    cause:
      "A shorter scrape interval multiplies the sample rate for every series. Detection improved, but storage, query, and network cost rose with it.",
    fix: "Reduce series cardinality, pre-aggregate, or keep the short interval only for the signals that need it. Do not shorten every job to fix one blind spot.",
    checkFirst: [
      "Multiply series count by scrapes per minute.",
      "Check whether all series need the higher resolution.",
      "Check retention and disk headroom.",
    ],
  },
];

export const scrapeResolutionModel: SimModel = {
  id: "observability-scrape-resolution",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p, frame.t);
    const jitter = rng.between(-30, 30);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.t);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.stepSeconds = dt;
    next.metrics = next.metrics.map((item) =>
      item.id === "ingest" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.phase === "after" && frame.flags.spikeEvent !== 1) {
      pushEvent(next, {
        id: "spike-outcome",
        severity: values.detected ? "info" : "crit",
        title: values.detected
          ? "Short outage captured by a scrape"
          : "Short outage missed between scrapes",
        detail: values.detected
          ? `${values.samplesInSpike} scrape(s) landed inside the ${values.spikeWidth.toFixed(0)}s outage. The dashboard saw ${values.spikeMagnitude.toFixed(0)}% errors.`
          : `The ${values.spikeWidth.toFixed(0)}s outage began and ended between ${values.scrapeInterval.toFixed(0)}s scrapes. The dashboard stayed green while users saw ${values.spikeMagnitude.toFixed(0)}% errors.`,
        nodeId: "dashboard",
        metricId: "missed-outage",
      });
      next.flags.spikeEvent = 1;
    }
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `A ${values.spikeWidth.toFixed(0)}s outage with a ${values.scrapeInterval.toFixed(0)}s scrape interval puts ${values.samplesInSpike} sample(s) inside the event.`,
    );
    items.push(
      values.detected
        ? "At least one sample lands inside the outage, so the dashboard can see it. The sampled value is still one instant, not the peak or the duration."
        : "No sample lands inside the outage. The dashboard cannot see it, regardless of how good the alert rule is.",
    );
    items.push(
      `The blind spot is ${values.blindSpot.toFixed(0)}s. Any event shorter than the interval can be missed; an event longer than the interval is guaranteed to contain a sample.`,
    );
    items.push(
      `Ingest is ${Math.round(values.ingest).toLocaleString()} samples/min. Halving the interval doubles the sample rate for the same series.`,
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
    description: "A 20s outage is wider than the 15s scrape, so a sample lands inside.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "A short 12% spike is sampled, but the blind spot and ingest cost rise.",
    tone: "warn",
    params: defaults({ scrapeInterval: 15, spikeWidth: 8, spikeMagnitude: 12, seriesCount: 4_000 }),
  },
  {
    id: "failure",
    label: "Missed outage",
    description: "A 4s outage falls between 30s scrapes; the dashboard stays green.",
    tone: "crit",
    params: defaults({ scrapeInterval: 30, spikeWidth: 4, spikeMagnitude: 80, seriesCount: 2_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 10s scrape covers the event; the outage is small and the cost stays bounded.",
    tone: "ok",
    params: defaults({ scrapeInterval: 10, spikeWidth: 20, spikeMagnitude: 2, seriesCount: 2_000 }),
  },
];

const experiment: Experiment = {
  id: "missed-spike",
  title: "Predict what the dashboard sees",
  simId: "scrape-resolution",
  question:
    "An outage lasts 4s and starts at t=8s. Prometheus scrapes every 30s. What does the error dashboard show?",
  prediction: {
    options: [
      { id: "nothing", label: "Nothing: no scrape lands inside the outage" },
      { id: "full", label: "The full 80% error spike" },
      { id: "half", label: "About half the spike, because one scrape lands inside" },
      { id: "reset", label: "A counter reset, not an error spike" },
    ],
    correctOptionId: "nothing",
    explanation:
      "Scrapes occur at 30s and 60s. The outage runs from 8s to 12s, so it begins and ends between samples. The dashboard has no data point inside the event and stays green.",
  },
  setup: presets[2].params,
  runFor: 40,
  observe: [
    "Samples inside the outage is zero.",
    "Observed error rate stays at zero while the outage is active.",
    "Missed outage reaches 80% after the event ends.",
    "The blind spot is 26s and the incident event fires at the end of the spike.",
  ],
  explain:
    "Sampling resolution bounds detection. A scrape is an instant, not an average over the interval. If the event is narrower than the interval and falls between samples, the metric never contains it. A shorter interval improves the chance of catching the event but multiplies ingest for every series.",
  fix: defaults({ scrapeInterval: 5, spikeWidth: 4, spikeMagnitude: 80, seriesCount: 2_000 }),
  debrief:
    "At a 5s interval, a scrape lands inside the 4s outage and the dashboard sees the 80% error rate. The cost is 24,000 samples per minute for 2,000 series, above the teaching ingest warning. Detection is now possible, but the ingest bill and storage load are real. Choose the interval from the shortest event you must catch, and apply it only to the signals that need it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A scrape interval is the time between samples of a target. Prometheus records an instant value at each scrape; it does not average the interval. A 15-second interval means the metric can miss any event shorter than 15 seconds that starts and ends between scrapes. That is aliasing in time, the same idea as a low frame rate missing a fast movement.",
  },
  {
    type: "p",
    text: "Resolution bounds detection. A shorter interval raises the chance of catching a short event, and it raises the number of samples stored for every series. The cost is not only storage: it is scrape CPU, network, query load, and retention. The right interval comes from the shortest event you must detect, not from the smallest number the configuration allows.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The target exposes metrics, the scraper collects them, the time-series store keeps them, the query engine evaluates a rate or an alert, and the dashboard or pager consumes the result. A short event that falls between scrapes is absent at the source. No query, alert, or dashboard can recover it from the metric series.",
  },
  {
    type: "table",
    headers: ["Requirement", "Implication"],
    rows: [
      ["Detect a 5s outage", "Scrape well below 5s, or add logs, traces, or a probe"],
      ["Detect a 30s outage", "A 15s interval guarantees a sample inside"],
      ["Keep ingest flat", "Do not shorten every job; shorten the signal that needs it"],
      ["Keep retention", "More samples per series consume more disk and memory"],
    ],
  },
  {
    type: "p",
    text: "Prometheus's default global scrape interval is one minute in its configuration documentation, with a ten-second scrape timeout. Those defaults are a starting point, not a detection guarantee. A one-minute interval cannot see a five-second outage. An exporter that aggregates internally can preserve a short event in a histogram or a counter, but a single gauge sampled every minute cannot.",
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start on Healthy, then apply Missed outage. Watch the observed error rate stay at zero while the missed-outage metric rises. Run the guided experiment before reading the debrief. Then shorten the interval and compare detection with the ingest cost.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Observed error rate: the value a scrape actually recorded.",
      "Missed outage: the error rate users experienced that no sample captured.",
      "Blind spot: how much of the interval is longer than the outage.",
      "Ingest: samples per minute, which scales with series count divided by interval.",
      "Samples inside outage: whether any scrape landed inside the event.",
      "Series per scrape: the multiplier behind the ingest cost.",
    ],
  },
  {
    type: "p",
    text: "The model uses one outage at a fixed time so the sampling geometry is visible. In production, events arrive at arbitrary times, so the chance of missing a short event depends on its width relative to the interval. An event wider than the interval is guaranteed to contain a sample; an event narrower than the interval can fall entirely between samples.",
  },
  { type: "sim", simId: "scrape-resolution" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The outage ran for four seconds and the scrape interval was thirty seconds. The scrapes at 30s and 60s both fell outside the 8s to 12s window. The observed error rate stayed at zero, the samples-inside count stayed at zero, and the dashboard stayed green. The missed-outage metric rose only after the event ended, when the model could compare the outage with the sampling grid.",
  },
  {
    type: "p",
    text: "Shortening the interval to five seconds placed a scrape inside the four-second outage. The dashboard saw the full error rate. The ingest rate rose from 4,000 to 24,000 samples per minute for the same 2,000 series. Detection improved, and the cost moved with it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A dashboard that is green during a user-reported outage, with a gap in the metric samples or a sample just before and after the event.",
      "An alert rule that never fires because the metric never crosses the threshold.",
      "A load balancer or application log with errors in the same window, which is the independent signal the metric missed.",
      "A scrape interval longer than the shortest outage in the postmortem timeline.",
      "An ingest graph that jumps after someone shortened every scrape interval to fix one blind spot.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the outage width with the scrape interval. Count the samples inside the event. Check logs, traces, or load-balancer metrics for the same window. Then decide whether to shorten the interval for that signal or add an event source that samples directly.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "State the shortest event that must be detected.",
      "Choose an interval below that width, with margin for scrape jitter and missed scrapes.",
      "Apply the shorter interval only to the jobs that need it.",
      "Add an independent signal for events shorter than any feasible interval.",
      "Recheck ingest, retention, and query cost after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Shorter intervals improve detection but multiply scrape, storage, and query cost for every series.",
      "Longer intervals are cheaper but create blind spots that no query can recover.",
      "Internal aggregation in the exporter can preserve a short event in a histogram without scraping every second.",
      "Logs and traces can capture an event the metric missed, but they have their own sampling and cost.",
      "A probe can detect an outage directly, but it adds another moving part and another failure domain.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "missing-spike",
    question:
      "Users report a five-second outage, but the error-rate dashboard is flat. The scrape interval is one minute. What do you check, and what do you change?",
    difficulty: 2,
    hints: [
      "A scrape is an instant sample, not an average.",
      "Five seconds is much shorter than one minute.",
    ],
    answer:
      "I check whether any scrape landed inside the outage window. If the event is shorter than the interval and falls between samples, the metric never contained it. I confirm with logs, traces, or load-balancer errors, then choose a shorter interval for that signal or add a direct event source. I would not shorten every job; I would apply the resolution only where the detection requirement justifies the cost.",
    followUps: [
      "What interval would you choose for a five-second event?",
      "How would you estimate the ingest increase?",
      "What if the event is shorter than any feasible interval?",
    ],
    redFlags: [
      "Blames the alert threshold.",
      "Shortens every scrape job.",
      "Claims the query can recover missing samples.",
    ],
    rubric: [
      "Explains sampling resolution.",
      "Checks an independent signal.",
      "Chooses a targeted interval.",
      "Accounts for cost.",
    ],
  },
  {
    id: "resolution-cost",
    question:
      "How does halving the scrape interval affect ingest, storage, and detection, and how would you decide whether it is worth it?",
    difficulty: 2,
    hints: [
      "Every series is sampled twice as often.",
      "Detection is bounded by the shortest event.",
    ],
    answer:
      "Halving the interval doubles the sample rate for every series in the job, so ingest and storage roughly double for the same retention. Detection improves for events near the old interval, but an event shorter than the new interval can still be missed. I would compare the shortest event that must be detected with the cost of the extra samples, and I would apply the shorter interval only to the series that need it. If the event is much shorter than any feasible interval, I would add logs, traces, or a probe.",
    followUps: [
      "What does retention time do to the cost?",
      "How would you reduce series count instead?",
      "When is internal aggregation better than a shorter scrape?",
    ],
    redFlags: [
      "Says the cost is negligible.",
      "Assumes a shorter interval detects every event.",
      "Ignores retention.",
    ],
    rubric: [
      "Doubles sample rate.",
      "Connects resolution to detection.",
      "Mentions targeted application.",
      "Names an alternative signal.",
    ],
  },
  {
    id: "guaranteed-detection",
    question:
      "When is a scrape interval guaranteed to contain a sample from an event, and when is detection probabilistic?",
    difficulty: 3,
    hints: [
      "Think about an event longer than the interval.",
      "An event shorter than the interval can fall between samples.",
    ],
    answer:
      "If the event duration is at least the scrape interval, any interval of that length must contain at least one scrape, so detection is guaranteed for a periodic scrape schedule. If the event is shorter than the interval, it can fall entirely between two scrapes, so detection depends on its phase relative to the schedule. That is why a five-second event needs an interval well below five seconds, or a different signal. Jitter and missed scrapes make the practical margin larger than the theoretical one.",
    followUps: [
      "What does scrape jitter do to the guarantee?",
      "How would a histogram change the guarantee?",
      "What if the event is exactly the interval length?",
    ],
    redFlags: [
      "Says a shorter interval guarantees detection of any event.",
      "Ignores event phase.",
      "Ignores missed scrapes.",
    ],
    rubric: [
      "States the width-versus-interval rule.",
      "Explains phase for short events.",
      "Mentions jitter and missed scrapes.",
      "Names an alternative.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The shortest event the team must detect is written down.",
      "Scrape intervals are below that width with margin.",
      "High-resolution collection is limited to the signals that need it.",
      "Logs, traces, or probes cover events shorter than the metric resolution.",
      "Ingest and retention have headroom for the chosen resolution.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether any sample landed inside the event window.",
      "Compare the metric with logs, traces, or load-balancer errors.",
      "Check the scrape interval and missed scrapes for the target.",
      "Do not assume a green dashboard means no user impact.",
      "Record the sampling gap in the timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Choose a resolution from the postmortem's shortest event.",
      "Apply it only to the relevant jobs.",
      "Recheck ingest and retention after the change.",
      "Add a regression check for the sampling blind spot.",
    ],
  },
];

const references = [
  {
    title: "Configuration: scrape_interval and scrape_timeout",
    url: "https://prometheus.io/docs/prometheus/latest/configuration/configuration/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Global and per-job scrape intervals, defaults, and timeout constraints.",
  },
  {
    title: "Storage",
    url: "https://prometheus.io/docs/prometheus/latest/storage/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Sample size, retention, and the effect of scrape interval and series count on disk.",
  },
  {
    title: "Monitoring Distributed Systems: choosing a resolution",
    url: "https://sre.google/sre-book/monitoring-distributed-systems/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Match measurement granularity to the question and the cost of collection.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "scrape-resolution": {
      model: scrapeResolutionModel,
      presets,
      instructions:
        "Start healthy, apply Missed outage, and watch the observed error rate stay at zero. Then shorten the interval and compare detection with ingest.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Outage timing, series count, and ingest values are teaching figures, not Prometheus limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-promql-rate",
    "observability-metrics-types",
    "observability-golden-signals",
  ],
};
