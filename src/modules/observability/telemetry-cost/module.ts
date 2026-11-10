import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SECONDS_PER_MONTH = 2_592_000;
const METRIC_RATE_PER_1K = 0.25;
const LOG_RATE_PER_GB = 0.4;
const TRACE_RATE_PER_MILLION = 0.15;

const params = [
  {
    id: "requestsPerSecond",
    label: "Request rate",
    min: 100,
    max: 100_000,
    step: 100,
    value: 10_000,
    unit: " rps",
    scale: "log" as const,
    group: "Workload",
    help: "Requests per second across the services that emit telemetry.",
    format: "rps" as const,
  },
  {
    id: "metricSeries",
    label: "Active metric series",
    min: 100_000,
    max: 50_000_000,
    step: 100_000,
    value: 2_000_000,
    unit: " series",
    scale: "log" as const,
    group: "Metrics",
    help: "Billable series across all custom metrics.",
    format: "count" as const,
  },
  {
    id: "logGBPerDay",
    label: "Log volume",
    min: 10,
    max: 5_000,
    step: 10,
    value: 200,
    unit: " GB/d",
    scale: "log" as const,
    group: "Logs",
    help: "Log volume ingested per day before retention.",
    format: "number" as const,
  },
  {
    id: "traceSampleRate",
    label: "Trace sample rate",
    min: 0.1,
    max: 100,
    step: 0.1,
    value: 10,
    unit: "%",
    scale: "log" as const,
    group: "Traces",
    help: "Share of requests retained as traces. Coverage of rare errors is separate from this number.",
    format: "percent" as const,
  },
  {
    id: "retentionDays",
    label: "Retention",
    min: 7,
    max: 90,
    step: 1,
    value: 30,
    unit: " d",
    group: "Retention",
    help: "Days kept for logs and traces. Metric series cost is modeled independently of retention.",
    format: "number" as const,
  },
  {
    id: "monthlyBudget",
    label: "Monthly budget",
    min: 1,
    max: 200,
    step: 1,
    value: 5,
    unit: " k$",
    group: "Budget",
    help: "Team budget for telemetry in this model. Illustrative, not a vendor quote.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestsPerSecond: number;
  metricSeries: number;
  logGBPerDay: number;
  traceSampleRate: number;
  retentionDays: number;
  monthlyBudget: number;
  metricCostK: number;
  logCostK: number;
  traceCostK: number;
  monthlyCostK: number;
  budgetUsed: number;
  costPerMillion: number;
  coverage: number;
  coverageGap: number;
  retainedSpansPerSecond: number;
  monthlyRequests: number;
}

function compute(p: Params): Computed {
  const requestsPerSecond = Math.max(1, num(p, "requestsPerSecond", 10_000));
  const metricSeries = Math.max(1, num(p, "metricSeries", 2_000_000));
  const logGBPerDay = Math.max(0, num(p, "logGBPerDay", 200));
  const traceSampleRate = clamp(num(p, "traceSampleRate", 10), 0, 100);
  const retentionDays = Math.max(1, num(p, "retentionDays", 30));
  const monthlyBudget = Math.max(0.01, num(p, "monthlyBudget", 5));
  const retentionFactor = retentionDays / 30;
  const monthlyRequests = requestsPerSecond * SECONDS_PER_MONTH;
  const retainedSpansPerSecond = requestsPerSecond * (traceSampleRate / 100);
  const metricCostK = (metricSeries / 1_000) * METRIC_RATE_PER_1K / 1_000;
  const logCostK = (logGBPerDay * 30 * LOG_RATE_PER_GB * retentionFactor) / 1_000;
  const traceCostK =
    (retainedSpansPerSecond * SECONDS_PER_MONTH * TRACE_RATE_PER_MILLION * retentionFactor) / 1_000_000 / 1_000;
  const monthlyCostK = metricCostK + logCostK + traceCostK;
  const coverage = 50 * Math.min(1, logGBPerDay / 200) + 50 * Math.min(1, traceSampleRate / 10);
  return {
    requestsPerSecond,
    metricSeries,
    logGBPerDay,
    traceSampleRate,
    retentionDays,
    monthlyBudget,
    metricCostK,
    logCostK,
    traceCostK,
    monthlyCostK,
    budgetUsed: (monthlyCostK / monthlyBudget) * 100,
    costPerMillion: (monthlyCostK * 1_000) / (monthlyRequests / 1_000_000),
    coverage,
    coverageGap: 100 - coverage,
    retainedSpansPerSecond,
    monthlyRequests,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed): void {
  const seedKeys: [string, number][] = [
    ["monthly-cost", values.monthlyCostK],
    ["trace-cost", values.traceCostK],
    ["budget-used", values.budgetUsed],
    ["cost-per-million", values.costPerMillion],
    ["coverage-gap", values.coverageGap],
    ["metric-series", values.metricSeries],
  ];
  for (const [id, value] of seedKeys) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + id.length) / 3.3);
      return Math.max(0, value * (0.97 + 0.03 * wave));
    });
  }
}

function buildFrame(p: Params): SimFrame {
  const values = compute(p);
  const unitCostHealth = healthFor(values.costPerMillion, 0.2, 0.4);
  const budgetHealth = healthFor(values.budgetUsed, 90, 100);
  const coverageHealth = healthFor(values.coverageGap, 18, 28);
  const seriesHealth = healthFor(values.metricSeries, 10_000_000, 25_000_000);
  return {
    t: 0,
    nodes: [
      {
        id: "services",
        label: "Services",
        kind: "client",
        health: "ok",
        utilization: clamp(values.requestsPerSecond / 100_000),
        sublabel: `${values.requestsPerSecond.toLocaleString()} rps`,
        detail: "Every signal starts here; the cost depends on what the service emits.",
        meta: { view: "flow" },
      },
      {
        id: "collectors",
        label: "Collectors",
        kind: "worker",
        health: coverageHealth,
        utilization: clamp(values.coverageGap / 28),
        sublabel: `${values.coverageGap.toFixed(0)}% log/trace gap`,
        detail: "Sampling and filtering happen here. The gap covers logs and traces; metric coverage is a separate design question.",
        meta: { view: "flow" },
      },
      {
        id: "pipeline",
        label: "Unit cost",
        kind: "stream",
        health: unitCostHealth,
        utilization: clamp(values.costPerMillion / 0.4),
        sublabel: `$${values.costPerMillion.toFixed(2)} / M`,
        detail: `Illustrative split: metrics ${values.metricCostK.toFixed(1)}k$, logs ${values.logCostK.toFixed(1)}k$, traces ${values.traceCostK.toFixed(2)}k$.`,
        meta: { view: "flow" },
      },
      {
        id: "storage",
        label: "Metric series",
        kind: "storage",
        health: seriesHealth,
        utilization: clamp(values.metricSeries / 25_000_000),
        sublabel: `${values.metricSeries.toLocaleString()} series`,
        detail: "Cardinality is the metrics multiplier; retention does not change this number.",
        meta: { view: "flow" },
      },
      {
        id: "budget",
        label: "Budget",
        kind: "external",
        health: budgetHealth,
        utilization: clamp(values.budgetUsed / 100),
        sublabel: `${values.budgetUsed.toFixed(0)}% used`,
        detail: `Budget is ${values.monthlyBudget.toFixed(1)}k$ per month in this teaching model.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("services-collectors", "services", "collectors", clamp(values.requestsPerSecond / 100_000)),
      edge("collectors-pipeline", "collectors", "pipeline", clamp(values.costPerMillion / 0.4), coverageHealth),
      edge("pipeline-storage", "pipeline", "storage", clamp(values.metricSeries / 25_000_000), unitCostHealth),
      edge("storage-budget", "storage", "budget", clamp(values.budgetUsed / 100), budgetHealth),
    ],
    metrics: [
      metric("monthly-cost", "Monthly cost", values.monthlyCostK, "k$", undefined, undefined, "number"),
      metric("trace-cost", "Trace cost", values.traceCostK, "k$", undefined, undefined, "number"),
      metric("budget-used", "Budget used", values.budgetUsed, "%", 90, 100, "percent"),
      metric("cost-per-million", "Cost per million requests", values.costPerMillion, " $/M", 0.2, 0.4, "number"),
      metric("coverage-gap", "Log/trace coverage gap", values.coverageGap, "%", 18, 28, "percent"),
      metric("metric-series", "Active metric series", values.metricSeries, " series", 10_000_000, 25_000_000, "count"),
    ],
    events: [],
    series: {},
    flags: {},
    summary: `${values.monthlyCostK.toFixed(1)}k$ per month, ${values.budgetUsed.toFixed(0)}% of budget; $${values.costPerMillion.toFixed(2)} per million requests; log/trace coverage gap ${values.coverageGap.toFixed(0)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "budget-used",
    metricId: "budget-used",
    warn: 90,
    crit: 100,
    title: "The telemetry budget is exhausted",
    cause:
      "The team is paying for volume or cardinality that is not tied to an owned coverage decision. Budgets without an owner drift with every new dashboard and log line.",
    fix:
      "Assign an owner per signal, set a monthly budget, and review the top drivers. Protect error and latency coverage while cutting low-value volume.",
    checkFirst: [
      "Confirm the budget owner and the current forecast.",
      "Check whether a single service or team dominates the spend.",
      "Check whether the overage is retention, volume, or cardinality.",
    ],
  },
  {
    id: "cost-per-million",
    metricId: "cost-per-million",
    warn: 0.2,
    crit: 0.4,
    title: "Cost per request is rising",
    cause:
      "Telemetry cost is growing faster than the request rate. That is a unit-cost problem, not a traffic problem: retention, cardinality, or low-value log volume changed.",
    fix:
      "Compute cost per million requests by signal and compare it with traffic. Cut the multiplier that changed, then verify that the incident questions the team needs are still answerable.",
    checkFirst: [
      "Compare cost per request by signal over time.",
      "Check for a retention increase or a new high-cardinality label.",
      "Check for a log line that fires on every request.",
    ],
  },
  {
    id: "coverage-gap",
    metricId: "coverage-gap",
    warn: 18,
    crit: 28,
    title: "Cost cuts have reduced log/trace coverage",
    cause:
      "The plan is cheap because it stopped collecting the evidence the team needs. A low trace sample, a short log window, or a narrow retention tier can hide the failure that matters.",
    fix:
      "Restore coverage for errors and latency first, then cut successful fast traces and verbose logs. Coverage is the benefit side of the unit-cost equation.",
    checkFirst: [
      "Check whether rare errors and slow traces are still queryable.",
      "Check the log retention window against the incident review window.",
      "Check whether sampling is uniform or outcome-aware.",
    ],
  },
  {
    id: "metric-series",
    metricId: "metric-series",
    warn: 10_000_000,
    crit: 25_000_000,
    title: "Metric cardinality is a major cost driver",
    cause:
      "Series count, not query count, sets the metric bill. A label with unbounded values can dominate spend while the service looks healthy.",
    fix:
      "Set a per-metric series budget and remove unbounded labels. Move identifiers to logs or traces, where retention can be tuned separately.",
    checkFirst: [
      "Rank metrics by series count.",
      "Check the newest label or target in the release.",
      "Check whether the metric is queried by any dashboard or alert.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const telemetryCostModel: SimModel = {
  id: "observability-telemetry-cost",
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
    if (values.costPerMillion >= 0.4 && values.coverageGap >= 18 && frame.flags.unitCostEvent !== 1) {
      pushEvent(next, {
        id: "telemetry-unit-cost",
        at: frame.t,
        severity: "crit",
        title: "Telemetry cost rose while coverage fell",
        detail: `Cost is $${values.costPerMillion.toFixed(2)} per million requests with a ${values.coverageGap.toFixed(0)}% log/trace coverage gap. The overage is retention, cardinality, or low-value volume, not traffic alone.`,
        nodeId: "pipeline",
        metricId: "cost-per-million",
      });
      next.flags.unitCostEvent = 1;
    }
    if (values.costPerMillion < 0.4 || values.coverageGap < 18) next.flags.unitCostEvent = 0;
    next.summary = `${values.monthlyCostK.toFixed(1)}k$ per month, ${values.budgetUsed.toFixed(0)}% of budget; $${values.costPerMillion.toFixed(2)} per million requests; log/trace coverage gap ${values.coverageGap.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Metrics contribute ${values.metricCostK.toFixed(1)}k$ from ${values.metricSeries.toLocaleString()} series; logs contribute ${values.logCostK.toFixed(1)}k$ at ${values.logGBPerDay.toLocaleString()}GB/day.`,
    );
    items.push(
      `Traces contribute ${values.traceCostK.toFixed(2)}k$ because ${values.retainedSpansPerSecond.toLocaleString()} spans/s are retained at a ${values.traceSampleRate.toFixed(1)}% sample.`,
    );
    items.push(
      `Cost is $${values.costPerMillion.toFixed(2)} per million requests and log/trace coverage is ${values.coverage.toFixed(0)}%, leaving a ${values.coverageGap.toFixed(0)}% gap.`,
    );
    items.push("All unit rates are illustrative teaching values, not vendor prices.");
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
    description: "A balanced plan: 2 million series, 200GB logs/day, 10% traces, 30-day retention.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak growth",
    description: "Traffic and volume double at 60-day retention. Unit cost and log/trace coverage gap cross warning.",
    tone: "warn",
    params: defaults({
      requestsPerSecond: 20_000,
      metricSeries: 5_000_000,
      logGBPerDay: 400,
      traceSampleRate: 5,
      retentionDays: 60,
      monthlyBudget: 15,
    }),
  },
  {
    id: "failure",
    label: "Unowned spend",
    description: "High cardinality, heavy logs, weak trace coverage, and 90-day retention exhaust the budget.",
    tone: "crit",
    params: defaults({
      metricSeries: 10_000_000,
      logGBPerDay: 1_200,
      traceSampleRate: 0.5,
      retentionDays: 90,
      monthlyBudget: 30,
    }),
  },
  {
    id: "recovery",
    label: "Governed recovery",
    description: "Return to bounded cardinality, shorter retention, and a 10% trace sample.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "trace-everything",
    label: "Trace everything",
    description: "100% traces roughly double the bill and cross the unit-cost warning. Log/trace coverage is already complete, so the extra successful traces add little incident value.",
    tone: "warn",
    params: defaults({ requestsPerSecond: 10_000, traceSampleRate: 100, monthlyBudget: 15 }),
  },
];

const experiment: Experiment = {
  id: "predict-unit-cost",
  title: "Predict why unit cost rose",
  simId: "telemetry-cost",
  question:
    "Request rate is flat at 10,000 rps, but telemetry cost per million requests rises fourteen times and log/trace coverage falls. Which change explains it?",
  prediction: {
    options: [
      { id: "multipliers", label: "High cardinality, heavy logs, weak trace coverage, and long retention" },
      { id: "queries", label: "More dashboards are querying the same data" },
      { id: "traffic", label: "Request traffic grew faster than the budget" },
      { id: "compression", label: "The storage engine stopped compressing samples" },
    ],
    correctOptionId: "multipliers",
    explanation:
      "Cost per request isolates the unit cost from traffic. If it rises while requests are flat, a multiplier changed: series cardinality, log volume, retained spans, or retention days. Query count and dashboard count affect query compute, not the stored volume that dominates the bill.",
  },
  setup: defaults({
    metricSeries: 10_000_000,
    logGBPerDay: 1_200,
    traceSampleRate: 0.5,
    retentionDays: 90,
    monthlyBudget: 30,
  }),
  runFor: 20,
  observe: [
    "Monthly cost rises from about 3.3k$ to about 45.8k$ while request rate stays at 10,000 rps.",
    "Cost per million requests rises from about $0.13 to about $1.77.",
    "Log/trace coverage falls from 100% to about 53% because traces are sampled at 0.5% and the gap is purely log/trace evidence.",
    "The budget is exceeded at about 152%, and the largest driver is log volume at 90-day retention.",
  ],
  explain:
    "Three multipliers moved at once. Metric series rose five times, log volume rose six times and retention tripled, and trace sampling fell to a level that saves little while losing coverage. Traffic did not change. The result is a higher unit cost and a worse evidence set: the spend grew on volume and retention while the error path became less visible.",
  fix: defaults(),
  debrief:
    "Returning to 2 million series, 200GB/day, 10% traces, and 30-day retention brings the bill back to about 3.3k$ and log/trace coverage back to 100%. The governance lesson is that every signal has its own multiplier and its own coverage tradeoff. A budget review must name both sides, or it will cut the evidence that explains the next incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Telemetry cost is the price of collecting, storing, and querying metrics, logs, and traces. It is not one bill with one driver. Metrics are usually priced by active series, logs by ingested volume and retention, and traces by sampled span volume and retention. A service can grow traffic by 20% and telemetry cost by 200% if a label, a log line, or a retention tier changed at the same time.",
  },
  {
    type: "p",
    text: "Governance turns that bill into a product with an owner, a budget, and a unit cost. Cost per request is the useful unit: it separates growth caused by traffic from growth caused by cardinality, verbose logs, sampling, or retention. The modeled coverage gap covers logs and traces; metric coverage is a separate design choice about which bounded dimensions remain queryable. The goal is not the cheapest telemetry; it is the least telemetry that still answers the incident questions the team has committed to.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is service instrumentation, collectors and pipelines, then the metrics, logs, and trace backends. Each backend has its own cost model. A single ownership label, such as team or service, lets the bill be split along the same boundary as the on-call rotation. Without that label, cost reviews become arguments about a shared total.",
  },
  {
    type: "table",
    headers: ["Signal", "Main cost driver", "Lower-cost lever", "Evidence risk"],
    rows: [
      ["Metrics", "Active series", "Drop unbounded labels; set series budgets", "Losing a dimension a dashboard needs"],
      ["Logs", "Ingested GB x retention", "Filter noise; tier or shorten retention", "Deleting the line that explains an incident"],
      ["Traces", "Sampled spans x retention", "Lower uniform sample; add error policy", "Hiding rare errors or tail latency"],
      ["Queries", "Scan size and concurrency", "Bound variables; precompute aggregates", "Slower dashboards, not a storage bill"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative unit rates: $0.25 per 1,000 active series per month, $0.40 per GB of logs per month, and $0.15 per million sampled spans per month. Those are teaching assumptions, not Datadog or Grafana prices. Real rates depend on plan, contract, and region. The arithmetic is the lesson, not the constants.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Monthly cost split into metrics, logs, and traces, with a budget line.",
      "Cost per million requests, which rises when a multiplier grows faster than traffic.",
      "Log/trace coverage gap, a modeled measure of the log and trace evidence the plan no longer collects.",
      "Active metric series, the cardinality driver that retention cannot fix.",
      "Five topology nodes from services to the budget owner.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the 3.3k$ bill at 100% log/trace coverage. Apply Unowned spend. Watch cost per request and coverage move in opposite directions. Then apply Governed recovery. Run the experiment before reading the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "p",
    text: "The failure is not a high bill by itself. A high bill can be justified by a hard incident question. The failure is a high unit cost with no coverage gain, and no owner who can explain which question the spend answers.",
  },
  { type: "sim", simId: "telemetry-cost" },
  { type: "experiment", experimentId: "predict-unit-cost" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Request rate stayed at 10,000 rps, but three multipliers moved. Metric series rose to 10 million, log volume rose to 1,200GB per day and retention tripled to 90 days, and trace sampling fell to 0.5%. Monthly cost rose from about 3.3k$ to about 45.8k$, cost per million requests rose from about $0.13 to about $1.77, and log/trace coverage fell from 100% to about 53%.",
  },
  {
    type: "p",
    text: "The largest single driver was log volume at 90-day retention. The trace cut looked like a saving but contributed little to the bill while removing visibility. That is the classic governance failure: the cheapest-looking lever is not the largest cost driver, and it damages the evidence the team needs.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Billing or usage exports split by product, team, service, and environment.",
      "Metrics: the top series by count and the label that grew.",
      "Logs: the top sources by ingested GB and the retention tier applied.",
      "Traces: sampled span volume, the head sample rate, and error or latency policy coverage.",
      "Unit cost: spend per request, per service, or per customer, compared with traffic over the same period.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split the bill by signal. Compute cost per request for each signal. Find the multiplier that changed: cardinality, log volume, sample rate, or retention. Then ask which incident question the spend answers and which coverage the proposed cut would remove.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Assign an owner and a monthly budget to each signal, using the same boundary as on-call.",
      "Publish cost per request and coverage per signal, not only the total bill.",
      "Cut the largest multiplier first: drop unbounded metric labels, filter noisy logs, or tier retention.",
      "Protect error and latency coverage with sampling policies before lowering the uniform sample.",
      "Set cardinality, volume, and retention limits that warn before the budget is exhausted.",
      "Review the top drivers monthly and record the coverage decision with the cut.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cutting log volume saves the most when logs are the largest driver, but the deleted line is often the one an incident needs.",
      "Shortening retention lowers cost quickly and is hard to reverse; older evidence is gone.",
      "Lowering the trace sample saves storage but can hide rare errors unless an outcome-aware policy protects them.",
      "Dropping a metric label reduces cardinality and bill, but removes a dimension from every query that used it.",
      "A budget without a coverage measure rewards deleting telemetry, not improving it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "build-model",
    question:
      "Build a telemetry cost model for a service that handles 10,000 rps. What are the inputs and the first thing you would measure?",
    difficulty: 3,
    hints: [
      "Model each signal separately.",
      "Start with the largest bill line, not the easiest one to change.",
    ],
    answer:
      "I would model metrics, logs, and traces separately because each has a different multiplier. For metrics I need active series and the contracted rate per series. For logs I need ingested GB per day and retention. For traces I need request rate, sample rate, average span size, and retention. I would also tag the spend by team or service so it can be owned. The first measurement is the current bill split by signal and the cost per million requests, because that tells me whether the problem is traffic or a multiplier. Then I would rank the top drivers and check coverage before cutting anything.",
    followUps: [
      "Which input is usually hardest to get?",
      "How would you forecast the next month?",
      "What would you do if tagging is missing?",
    ],
    redFlags: [
      "Uses one blended cost per request.",
      "Starts cutting before splitting the bill.",
      "Ignores coverage.",
    ],
    rubric: [
      "Separates the three signals.",
      "Names the multipliers.",
      "Uses unit cost and ownership.",
      "Checks coverage before cuts.",
    ],
  },
  {
    id: "defend-cut",
    question:
      "You must cut telemetry spend by 40%. How do you defend the plan to engineering and to finance?",
    difficulty: 3,
    hints: [
      "Name the coverage you keep.",
      "Rank cuts by cost per unit of coverage lost.",
    ],
    answer:
      "I would present a plan by signal with three numbers: saving, coverage kept, and coverage lost. I would cut low-value volume first, such as debug logs on successful requests, duplicate metrics, and high-cardinality labels that no dashboard uses. Then I would tier retention and lower the uniform trace sample while keeping error and latency policies. I would protect the evidence needed for the incident classes the team actually faces. Finance gets the run-rate saving and the risk; engineering gets the specific queries that will stop working and the owner for each exception.",
    followUps: [
      "What would you refuse to cut?",
      "How would you measure coverage after the cut?",
      "What if a team says it needs all its logs?",
    ],
    redFlags: [
      "Cuts uniformly across signals.",
      "Promises savings without coverage risk.",
      "Has no exception process.",
    ],
    rubric: [
      "Quantifies saving and coverage.",
      "Cuts low-value volume first.",
      "Protects error and latency evidence.",
      "Names owners and exceptions.",
    ],
  },
  {
    id: "ownership",
    question:
      "Who should own the telemetry budget: platform, finance, or each service team? How would you make it work?",
    difficulty: 3,
    hints: [
      "The person who can change the emitters should own the number.",
      "Central standards still matter.",
    ],
    answer:
      "I would make the service team own the budget for the telemetry it emits, because that is where cardinality, log volume, and sampling decisions are made. The platform team owns the shared pipeline, the tagging standard, and the unit-cost reporting. Finance owns the contract and the forecast, not the daily tradeoff. To make it work I would allocate cost with a consistent ownership label, publish a monthly unit-cost review, and give teams a small exception path for incident-heavy services. Central review for every tag would be too slow.",
    followUps: [
      "How do you allocate shared collector cost?",
      "What does the platform team own?",
      "How do you handle a shared multi-tenant backend?",
    ],
    redFlags: [
      "Finance owns engineering tradeoffs.",
      "No one owns the emitters.",
      "Central approval for every change.",
    ],
    rubric: [
      "Puts ownership near the emitters.",
      "Keeps central standards.",
      "Defines finance's role.",
      "Allows exceptions.",
    ],
  },
  {
    id: "unit-cost",
    question:
      "Cost per request doubled but request volume is flat. Walk through your diagnosis.",
    difficulty: 2,
    hints: [
      "Flat traffic means a multiplier changed.",
      "Check each signal's main driver.",
    ],
    answer:
      "I would split the increase by signal. For metrics I would check active series and look for a new label or metric. For logs I would check ingested GB per day and retention. For traces I would check the sample rate, span volume, and retention. I would also check for a plan or rate change. The confirming evidence is a multiplier that changed while request volume stayed flat. Then I would tie the change to a release, a scrape configuration, or a retention edit.",
    followUps: [
      "Which signal would you check first?",
      "How would a plan change show up?",
      "What if all three signals rose together?",
    ],
    redFlags: [
      "Blames traffic without checking.",
      "Looks only at the total bill.",
      "Changes retention before finding the driver.",
    ],
    rubric: [
      "Splits by signal.",
      "Checks each multiplier.",
      "Correlates with a change.",
      "Separates price from volume.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every signal has an owner, a budget, and a monthly forecast.",
      "Cost is tagged by team or service, matching the on-call boundary.",
      "Cost per request and coverage are reported together.",
      "Cardinality, log volume, sample rate, and retention have limits that warn early.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split the overage by signal before cutting.",
      "Find the multiplier that changed: series, GB, spans, or days.",
      "Protect error and latency coverage while cutting volume.",
      "Record the decision and the coverage risk with the change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the bill and the coverage measure after the cut.",
      "Remove temporary filters and reconcile the sampling policy.",
      "Review the top drivers with the owners.",
      "Add a regression check for the next high-cardinality or high-volume release.",
    ],
  },
];

const references = [
  {
    title: "Billing",
    url: "https://docs.datadoghq.com/account_management/billing/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Usage-based billing concepts and product-level cost controls.",
  },
  {
    title: "Grafana Cloud billing and usage",
    url: "https://grafana.com/docs/grafana-cloud/billing-and-usage/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "How usage is metered across metrics, logs, traces, and retention.",
  },
  {
    title: "Grafana pricing",
    url: "https://grafana.com/pricing/",
    publisher: "Grafana Labs",
    kind: "docs" as const,
    note: "Plan structure and published usage dimensions. Model rates are not taken from this page.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "telemetry-cost": {
      model: telemetryCostModel,
      presets,
      instructions:
        "Start Healthy, then apply Unowned spend. Compare monthly cost, cost per million requests, and coverage gap. Apply Governed recovery, then Trace everything to see cost rise while log/trace coverage is already complete.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Unit rates, coverage weights, and budget are teaching values, not Datadog or Grafana prices.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-datadog-metric-cost",
    "observability-datadog-apm",
    "observability-victoriametrics-retention",
    "capacity-observability-cost",
  ],
};
