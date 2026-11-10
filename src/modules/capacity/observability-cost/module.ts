import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SECONDS_PER_DAY = 86_400;
const DAYS_PER_MONTH = 30;
const LOG_KB_PER_REQUEST = 1.2;
const TRACE_KB_PER_REQUEST = 4;
const INGEST_PER_GB = 0.1;
const STORAGE_PER_GB_MONTH = 0.02;
const SERIES_PER_MONTH = 0.08;
const BASE_SERIES = 6_000;

const params = [
  {
    id: "trafficRps",
    label: "Request rate",
    min: 1_000,
    max: 30_000,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Sustained requests per second. The monthly model uses 30 days of constant traffic. Illustrative.",
    format: "rps" as const,
  },
  {
    id: "logSamplePct",
    label: "Logs kept",
    min: 1,
    max: 100,
    step: 1,
    value: 40,
    unit: "%",
    group: "Volume",
    help: "Share of log records sent to the log store. The rest are dropped at the collector.",
    format: "percent" as const,
  },
  {
    id: "traceSamplePct",
    label: "Traces sampled",
    min: 1,
    max: 100,
    step: 1,
    value: 10,
    unit: "%",
    group: "Volume",
    help: "Head-sampling rate for traces. Error and slow traces are not modeled separately in this simplified cost view.",
    format: "percent" as const,
  },
  {
    id: "cardinality",
    label: "Active metric series",
    min: 1_000,
    max: 60_000,
    step: 1_000,
    value: 8_000,
    unit: " series",
    group: "Cardinality",
    help: "Distinct time series kept per month. One new label value can multiply this number.",
    format: "count" as const,
  },
  {
    id: "retentionDays",
    label: "Raw retention",
    min: 3,
    max: 90,
    step: 1,
    value: 14,
    unit: " days",
    group: "Retention",
    help: "Days raw logs and traces are stored. Metrics are priced per active series, not per stored point.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function smoothstep(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function seriesAt(p: Params, t: number): number {
  const target = Math.max(1_000, num(p, "cardinality", 8_000));
  const start = Math.min(BASE_SERIES, target);
  return start + (target - start) * smoothstep(t / 12);
}

interface Computed {
  trafficRps: number;
  series: number;
  logGbDay: number;
  traceGbDay: number;
  metricCost: number;
  ingestCost: number;
  storageCost: number;
  monthlyCost: number;
  costPerM: number;
  metricShare: number;
  blindSpot: number;
  monthlyRequestsM: number;
}

function compute(p: Params, t: number): Computed {
  const trafficRps = Math.max(1_000, num(p, "trafficRps", 8_000));
  const series = seriesAt(p, t);
  const logSample = clamp(num(p, "logSamplePct", 40), 1, 100);
  const traceSample = clamp(num(p, "traceSamplePct", 10), 1, 100);
  const retention = Math.max(1, num(p, "retentionDays", 14));
  const requestsPerDay = trafficRps * SECONDS_PER_DAY;
  const logGbDay = (requestsPerDay * LOG_KB_PER_REQUEST * (logSample / 100)) / 1_000_000;
  const traceGbDay = (requestsPerDay * TRACE_KB_PER_REQUEST * (traceSample / 100)) / 1_000_000;
  const metricCost = series * SERIES_PER_MONTH;
  const ingestCost = (logGbDay + traceGbDay) * DAYS_PER_MONTH * INGEST_PER_GB;
  const storageCost = (logGbDay + traceGbDay) * retention * STORAGE_PER_GB_MONTH;
  const monthlyCost = metricCost + ingestCost + storageCost;
  const monthlyRequestsM = (requestsPerDay * DAYS_PER_MONTH) / 1_000_000;
  const logLoss = Math.max(0, 25 - logSample) * 2;
  const traceLoss = Math.max(0, 5 - traceSample) * 4;
  const retentionLoss = Math.max(0, 7 - retention) * 2;
  return {
    trafficRps,
    series,
    logGbDay,
    traceGbDay,
    metricCost,
    ingestCost,
    storageCost,
    monthlyCost,
    costPerM: monthlyCost / Math.max(1, monthlyRequestsM),
    metricShare: (metricCost / Math.max(1, monthlyCost)) * 100,
    blindSpot: Math.min(100, logLoss + traceLoss + retentionLoss),
    monthlyRequestsM,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.costPerM >= 0.28 || values.series >= 40_000 || values.blindSpot >= 25) return "crit";
  if (values.costPerM >= 0.16 || values.series >= 20_000 || values.blindSpot >= 10) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const health = healthFor(values);
  const seriesHealth: "ok" | "warn" | "crit" =
    values.series >= 40_000 ? "crit" : values.series >= 20_000 ? "warn" : "ok";
  const logRate = num(p, "logSamplePct", 40);
  const traceRate = num(p, "traceSamplePct", 10);
  return {
    t: 0,
    nodes: [
      {
        id: "services",
        label: "Instrumented services",
        kind: "service",
        health: health === "crit" ? "warn" : "ok",
        utilization: clamp(values.trafficRps / 30_000),
        sublabel: `${values.trafficRps.toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
      {
        id: "collector",
        label: "Telemetry collector",
        kind: "service",
        health,
        utilization: clamp((values.logGbDay + values.traceGbDay) / 2_000),
        sublabel: `${Math.round(values.logGbDay + values.traceGbDay)} GB/day`,
        detail: `Telemetry costs $${(values.monthlyCost / 1_000).toFixed(1)}k a month, or $${values.costPerM.toFixed(3)} per million requests. Active series ${Math.round(values.series).toLocaleString("en-US")}.`,
        meta: { view: "flow" },
      },
      {
        id: "metrics",
        label: "Metrics store",
        kind: "storage",
        health: seriesHealth,
        utilization: clamp(values.series / 60_000),
        sublabel: `${Math.round(values.series).toLocaleString("en-US")} series`,
        meta: { view: "flow" },
      },
      {
        id: "logs",
        label: "Log store",
        kind: "storage",
        health: logRate < 10 ? "crit" : logRate < 25 ? "warn" : "ok",
        utilization: clamp(values.logGbDay / 1_500),
        sublabel: `${Math.round(values.logGbDay)} GB/day`,
        meta: { view: "flow" },
      },
      {
        id: "traces",
        label: "Trace store",
        kind: "storage",
        health: traceRate < 2 ? "crit" : traceRate < 5 ? "warn" : "ok",
        utilization: clamp(values.traceGbDay / 1_200),
        sublabel: `${Math.round(values.traceGbDay)} GB/day`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("services-collector", "services", "collector", clamp(values.trafficRps / 30_000), health),
      edge("collector-metrics", "collector", "metrics", clamp(values.metricShare / 100), seriesHealth),
      edge("collector-logs", "collector", "logs", clamp(values.logGbDay / 1_500), logRate < 10 ? "crit" : "ok"),
      edge("collector-traces", "collector", "traces", clamp(values.traceGbDay / 1_200), traceRate < 2 ? "crit" : "ok"),
    ],
    metrics: [
      metric("telemetry-cost-per-mreq", "Telemetry cost", values.costPerM, " $/M req", 0.16, 0.28, "number"),
      metric("monthly-cost", "Monthly telemetry spend", values.monthlyCost / 1_000, " k$", undefined, undefined, "number"),
      metric("active-series", "Active metric series", values.series, " series", 20_000, 40_000, "count"),
      metric("log-ingest", "Log ingest", values.logGbDay, " GB/day", undefined, undefined, "number"),
      metric("blind-spot", "Coverage gap", values.blindSpot, "%", 10, 25, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      cardinalityEvent: 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `$${(values.monthlyCost / 1_000).toFixed(1)}k a month at $${values.costPerM.toFixed(3)} per million requests; ${Math.round(values.series).toLocaleString("en-US")} active series and a ${values.blindSpot.toFixed(0)}% coverage gap.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const jitter = 0.97 + 0.05 * Math.sin((seed % 11) / 2.3);
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * jitter * (0.97 + 0.06 * Math.sin((index + (seed % 7)) / 2.5))),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0);
  seedSeries(frame, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "telemetry-cost-per-mreq",
    metricId: "telemetry-cost-per-mreq",
    warn: 0.16,
    crit: 0.28,
    title: "Telemetry cost per request is above the budget",
    cause:
      "Spend is growing faster than traffic. The driver is usually active metric series from a high-cardinality label, not the request count itself. Compare the metric share with the log and trace volume before cutting retention.",
    fix:
      "Find the label or metric that multiplied the series count and remove or bound it. Keep the signals used in incidents; cut duplicates and unused dimensions first.",
    checkFirst: [
      "Split the bill into metrics, logs, and traces.",
      "Compare active series and cost per request over the same window.",
      "Find the deployment or label that changed when series jumped.",
    ],
  },
  {
    id: "active-series",
    metricId: "active-series",
    warn: 20_000,
    crit: 40_000,
    title: "Active series have grown past the budget",
    cause:
      "A new dimension, tenant identifier, request ID, or unbounded label multiplies every metric into many series. Each series is billed whether or not anyone queries it.",
    fix:
      "Drop the unbounded label or aggregate it into a bounded set of values. Add a cardinality limit at the collector, and review new metric dimensions before release.",
    checkFirst: [
      "List the metrics with the largest series growth.",
      "Compare label values against the intended bounded set.",
      "Check whether a recent deploy added a new label.",
    ],
  },
  {
    id: "blind-spot",
    metricId: "blind-spot",
    warn: 10,
    crit: 25,
    title: "The cost cut removed incident coverage",
    cause:
      "Logs, traces, or retention were reduced below the level needed to investigate the failure classes this service owns. Cheap telemetry that cannot answer an incident question is not a saving.",
    fix:
      "Restore the signal with the highest incident value. Prefer tail sampling, error-biased retention, and tiered storage over uniform cuts.",
    checkFirst: [
      "Name the last three incidents and the signals used to resolve them.",
      "Check whether errors and slow requests are still sampled.",
      "Check the retention needed for the longest investigation.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const observabilityCostModel: SimModel = {
  id: "capacity-observability-cost",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    const values = compute(p, t);
    let cardinalityEvent = frame.flags.cardinalityEvent === 1;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (values.series > 20_000 && !cardinalityEvent) {
      pushEvent(next, {
        id: "cardinality-spike",
        at: t,
        severity: "warn",
        title: "Active series crossed the cardinality budget",
        detail: `${Math.round(values.series).toLocaleString("en-US")} series are active. The metric bill is now $${(values.metricCost / 1_000).toFixed(1)}k a month, ${values.metricShare.toFixed(0)}% of total telemetry spend.`,
        nodeId: "metrics",
        metricId: "active-series",
      });
      next.flags.cardinalityEvent = 1;
      cardinalityEvent = true;
    }

    if (values.series <= 20_000) cardinalityEvent = false;
    next.flags.cardinalityEvent = cardinalityEvent ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const share = value("active-series") > 0 && value("monthly-cost") > 0
      ? (value("active-series") * SERIES_PER_MONTH) / (value("monthly-cost") * 1_000) * 100
      : 0;
    const items = [
      `Telemetry costs $${value("telemetry-cost-per-mreq").toFixed(3)} per million requests. Active-series spend is ${share.toFixed(0)}% of the total.`,
    ];
    if (share >= 40) {
      items.push(
        "Cardinality is the largest line. A label with unbounded values multiplies the series count; cutting log retention will not fix that bill.",
      );
    } else {
      items.push("Volume or retention is the larger line. Check log and trace bytes per request before cutting cardinality.");
    }
    if (value("blind-spot") >= 10) {
      items.push(`The coverage gap is ${value("blind-spot").toFixed(0)}%. Restore error and slow-request tracing before cutting further.`);
    }
    return items;
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Approaching budget", tone: "warn" },
    { label: "Over budget", tone: "crit" },
    { label: "No signal", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Ordinary volume, 8,000 active series, 14-day raw retention, and full incident coverage.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Traffic triples and the team samples more logs and traces; cost per request is above target.",
    tone: "warn",
    params: defaults({ trafficRps: 25_000, logSamplePct: 60, traceSamplePct: 15, cardinality: 14_000, retentionDays: 30 }),
  },
  {
    id: "failure",
    label: "Cardinality explosion",
    description: "A new label ramps active series to 48,000 while log and trace volume stay ordinary.",
    tone: "crit",
    params: defaults({ cardinality: 48_000, retentionDays: 21 }),
  },
  {
    id: "recovery",
    label: "Bounded labels",
    description: "The unbounded label is removed, logs drop to 30%, traces to 5%, and raw retention to 7 days.",
    tone: "ok",
    params: defaults({ trafficRps: 12_000, logSamplePct: 30, traceSamplePct: 5, cardinality: 6_000, retentionDays: 7 }),
  },
  {
    id: "blind-cut",
    label: "Blind cut",
    description: "A uniform cut takes logs to 4%, traces to 1%, and retention to 3 days; the bill falls and coverage goes with it.",
    tone: "crit",
    params: defaults({ logSamplePct: 4, traceSamplePct: 1, retentionDays: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-cardinality-driver",
  title: "Predict which cut lowers cost without losing coverage",
  simId: "observability-cost",
  question:
    "Telemetry cost per request has doubled while traffic is flat. Dashboards and traces still cover the incident classes you care about. Which change addresses the cost driver?",
  prediction: {
    options: [
      { id: "retention", label: "Cut raw retention from 21 days to 3 days" },
      { id: "label", label: "Remove a tenant label that creates most of the metric series" },
      { id: "trace", label: "Sample all traces at 1%" },
      { id: "off", label: "Disable application metrics during business hours" },
    ],
    correctOptionId: "label",
    explanation:
      "The bill is dominated by active series, not by log or trace volume. Removing the high-cardinality label cuts the metric line while keeping logs, traces, and the remaining metric dimensions. Retention cuts storage but not ingestion, and it removes the history needed for long investigations. Sampling traces at 1% and disabling metrics both save money by removing coverage.",
  },
  setup: defaults({ trafficRps: 8_000, cardinality: 56_000, retentionDays: 21 }),
  runFor: 30,
  observe: [
    "Active series ramp from the baseline to 56,000, and cost per million requests crosses the critical threshold.",
    "Log and trace volume are unchanged, so a volume-only cut leaves most of the bill in place.",
    "The coverage gap stays at zero, which shows the spend is not buying more incident signal.",
  ],
  explain:
    "The model prices metrics per active series, logs and traces per ingested gigabyte, and storage per gigabyte-month. A tenant identifier label turns one metric into thousands of series. The bill grows even though the request rate and the useful signals do not change. Cutting retention to three days reduces storage, but the series bill remains and the investigation window shrinks.",
  fix: defaults({ trafficRps: 8_000, cardinality: 8_000, retentionDays: 21 }),
  debrief:
    "At 56,000 series the metric line is about $4,480 a month; at 8,000 it is $640. The log and trace lines are unchanged because the workload did not change. That is the useful cut: remove the dimension that multiplied the series, then decide retention and sampling from the incident questions the team must answer. Prices here are illustrative, not a vendor quote.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Observability cost is a capacity cost. Metrics, logs, and traces consume ingest, storage, and query capacity, and the bill is usually expressed per request so it can be compared with traffic. Three components move independently: volume, which is bytes or spans per request; cardinality, which is the number of distinct time series; and retention, which is how long raw data is kept. A change in any one can dominate the others.",
  },
  {
    type: "p",
    text: "Cardinality is the component that surprises teams. A metric is not billed once per name. It is billed per combination of label values. A tenant identifier or request identifier added to a shared metric can turn a few hundred series into tens of thousands, and every series is stored and indexed whether anyone queries it. Volume-based cuts such as log sampling do not reduce that line. Retention cuts reduce storage, but ingestion, indexing, and the investigation window are separate decisions.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is instrumented service to collector to one or more backends. The service emits metrics, logs, and spans. The collector batches, samples, and exports them. Each backend prices its own ingest, storage, and query. The request path is unaffected until the collector or the network path becomes a bottleneck, so telemetry cost is a capacity problem that hides outside the user-facing latency chart.",
  },
  {
    type: "table",
    headers: ["Cost line", "Priced by", "Grows when", "First control"],
    rows: [
      ["Metrics", "Active series and retention", "A label gains unbounded values", "Drop or bound the label"],
      ["Logs", "Ingest bytes and storage", "Verbosity or traffic rises", "Sample, filter, or tier"],
      ["Traces", "Spans, ingest bytes, and storage", "Every request is traced or spans multiply", "Head or tail sampling"],
      ["Queries and dashboards", "Scanned data and concurrent users", "Wide time ranges or high-cardinality queries", "Pre-aggregate and limit ranges"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Cardinality explosion. Watch cost per request rise while log and trace volume stay flat. Compare Blind cut to see the opposite failure: a low bill with a large coverage gap. Run the experiment before changing sliders. Prices, byte volumes, and coverage weights are illustrative teaching values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Cost per million requests against a warning and a critical budget.",
      "Monthly spend, active series, and log ingest, so you can see which component moved.",
      "A coverage gap that rises when logs, traces, or retention are cut below the incident window.",
      "A flow view from services to collector to each backend, with the affected store marked.",
    ],
  },
  { type: "sim", simId: "observability-cost" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, active series climb from 6,000 to 48,000 over about twelve seconds while traffic, log volume, and trace volume stay ordinary. Cost per million requests crosses the critical budget as the metric line grows to most of the bill. The coverage gap stays at zero, which is the important contrast: the extra spend bought no incident signal. It bought more label values.",
  },
  {
    type: "p",
    text: "In the blind-cut preset the opposite happens. The bill falls because logs, traces, and retention are cut hard, but the coverage gap becomes critical. The service is now cheap to observe and expensive to debug. A real cut has to name both sides: the dollars removed and the incident question that can no longer be answered.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Billing usage by signal and by metric name: the metric line grows without a matching traffic increase.",
      "Cardinality dashboards at the collector and backend, with the top label values for each metric.",
      "A deploy or feature flag that added a tenant, user, or request identifier to an existing metric.",
      "Log and trace ingest flat while cost rises, which rules out volume as the driver.",
      "Retention and sampling settings that were changed without a coverage review.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split the bill by signal. Compare active series and cost per request over the same window. Find the label that changed when series jumped. Then check whether errors and slow requests are still sampled before cutting anything else.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Attribute the change: find the metric and label combination with the largest series growth.",
      "Remove or bound the dimension. Aggregate tenant identifiers into a fixed set, or move the value to logs or traces where it is not indexed as a metric.",
      "Set a cardinality limit at the collector so a future label cannot repeat the incident.",
      "Review retention against the longest incident investigation, not against a default.",
      "Use tail sampling or error-biased retention to keep the traces that matter at a lower cost than uniform full sampling.",
      "Record the coverage tradeoff in the change review so the next cost cut does not silently remove the same signal.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cardinality limits protect the bill but can hide a long-tail tenant or a rare failure if the limit drops the wrong series.",
      "Head sampling is cheap and predictable, but it can miss the rare error that a tail-based policy would keep.",
      "Short retention lowers storage and also shortens the window for a slow-burning incident review.",
      "Aggregating labels lowers cost and removes the ability to slice by the aggregated value later.",
      "A budget without an owner becomes a periodic emergency; a budget with an owner becomes a design constraint.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-driver",
    question:
      "Observability spend doubled while traffic was flat. How do you find the driver before cutting anything?",
    difficulty: 3,
    hints: [
      "Split the bill by signal first.",
      "A flat traffic chart rules out volume growth but not cardinality.",
    ],
    answer:
      "I would split spend into metrics, logs, traces, and query cost, then compare each line with traffic over the same window. For metrics I would look at active series and the top label values, because a new tenant or request identifier multiplies series without changing request rate. For logs and traces I would check bytes per request, sampling settings, and retention. That separates a volume problem from a cardinality problem and from a retention problem. Only then can I choose a cut that targets the driver instead of the largest line on the invoice.",
    followUps: [
      "What if every line grew at the same rate?",
      "How would you prove a label change caused the jump?",
      "Which signal would you protect first?",
    ],
    redFlags: [
      "Starts by cutting retention everywhere.",
      "Assumes traffic is the only cost driver.",
      "Does not separate signal types.",
    ],
    rubric: [
      "Splits by signal and by cost driver.",
      "Names cardinality as a candidate.",
      "Compares cost with traffic.",
      "Protects incident coverage.",
    ],
  },
  {
    id: "trace-sampling",
    question:
      "A team proposes sampling all traces at 1% to cut cost. What do you ask before agreeing?",
    difficulty: 3,
    hints: [
      "Rare failures are the reason traces are expensive to replace.",
      "Uniform sampling is not the only option.",
    ],
    answer:
      "I would ask which incident questions depend on traces and whether errors and slow requests can be kept at a higher rate than the baseline. Uniform 1% sampling is cheap but may miss a rare failure, especially on a low-traffic path. Tail sampling can keep all errors and slow traces while sampling successful traffic aggressively. I would also check whether the cost is actually in trace ingest or in storage and query, because the right lever differs. The decision is not the sampling percentage alone; it is the coverage the team needs per incident class.",
    followUps: [
      "How would you validate the sampling policy after a change?",
      "What is the cost of keeping all errors?",
      "When is head sampling the better choice?",
    ],
    redFlags: [
      "Treats 1% as universally safe.",
      "Ignores rare-failure coverage.",
      "Does not distinguish ingest from storage.",
    ],
    rubric: [
      "Names incident coverage as the constraint.",
      "Mentions tail or error-biased sampling.",
      "Separates ingest, storage, and query cost.",
      "Proposes validation.",
    ],
  },
  {
    id: "retention-decision",
    question: "How do you choose retention for logs, metrics, and traces?",
    difficulty: 2,
    hints: [
      "Retention is driven by the questions asked after an incident.",
      "Raw data and aggregates have different value over time.",
    ],
    answer:
      "I start from the investigation window and the compliance requirement, then separate raw retention from aggregate retention. Metrics are usually cheap to keep as aggregates for a long time but expensive as high-cardinality raw series. Logs and traces are expensive raw and can be reduced to aggregates or error-only samples after the active window. I would keep enough raw data to debug the slowest expected incident, and tier the rest. The tradeoff is investigation depth against storage cost, not a single default number.",
    followUps: [
      "How would you test that the window is long enough?",
      "What would you tier first?",
      "Who owns the retention policy?",
    ],
    redFlags: [
      "Picks a default without a use case.",
      "Keeps everything raw forever.",
      "Cuts all signals equally.",
    ],
    rubric: [
      "Starts from incident and compliance needs.",
      "Separates raw from aggregates.",
      "Names a tiering strategy.",
      "Assigns ownership.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Telemetry spend is split by signal and reviewed against traffic every month.",
      "Every metric has a bounded label set; new dimensions require review.",
      "A collector cardinality limit exists and its dropped-series count is monitored.",
      "Retention is justified by the longest investigation, not a vendor default.",
      "Errors and slow requests are sampled at a higher rate than successful traffic.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the cost jump is cardinality, volume, or retention before cutting.",
      "Protect the metrics and traces used to diagnose the current failure.",
      "If a limit is dropping series, record which series and restore them after the incident.",
      "Do not disable a signal that the incident response is actively using.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove or bound the label that caused the growth.",
      "Verify that cost per request returned to budget and coverage stayed intact.",
      "Add a review step for new metric dimensions.",
      "Revisit retention and sampling with the incident's signal usage as evidence.",
    ],
  },
];

const references = [
  {
    title: "Datadog: Usage metrics",
    url: "https://docs.datadoghq.com/account_management/billing/usage_metrics/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Billing usage metrics for custom metrics, logs, and other billable units.",
  },
  {
    title: "Google SRE Workbook: Monitoring",
    url: "https://sre.google/workbook/monitoring/",
    publisher: "Google",
    kind: "book" as const,
    note: "Monitoring strategy, signal value, and the cost of collecting data without a use.",
  },
  {
    title: "Amazon CloudWatch pricing",
    url: "https://aws.amazon.com/cloudwatch/pricing/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How metrics, logs, and retention are priced; useful for building a unit-cost model.",
  },
  {
    title: "AWS X-Ray: Sampling",
    url: "https://docs.aws.amazon.com/xray/latest/devguide/xray-concepts.html#xray-concepts-sampling",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Sampling rules and reservoirs; why trace volume and coverage are separate decisions.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "observability-cost": {
      model: observabilityCostModel,
      presets,
      instructions:
        "Start Healthy, then apply Cardinality explosion. Watch cost per request and active series together, then compare Blind cut. Run the experiment before changing sliders.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative cost model. Prices, byte volumes, and coverage weights are teaching values, not vendor quotes or AWS prices.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-telemetry-cost",
    "observability-datadog-metric-cost",
    "capacity-cost-per-request",
    "capacity-unit-economics",
  ],
};
