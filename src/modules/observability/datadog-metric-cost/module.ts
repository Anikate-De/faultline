import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SERIES_BUDGET = 80_000;
const INGEST_CAPACITY = 500_000;

const params = [
  {
    id: "hosts",
    label: "Agent hosts",
    min: 100,
    max: 5_000,
    step: 50,
    value: 300,
    unit: " hosts",
    scale: "log" as const,
    group: "Fleet",
    help: "Hosts that submit the metric. The host tag is part of every series identity.",
    format: "count" as const,
  },
  {
    id: "metricNames",
    label: "Metric names",
    min: 5,
    max: 100,
    step: 5,
    value: 20,
    unit: " names",
    group: "Fleet",
    help: "Distinct custom metric names emitted by each host.",
    format: "count" as const,
  },
  {
    id: "tagValues",
    label: "New tag values",
    min: 1,
    max: 5_000,
    step: 1,
    value: 1,
    unit: " values",
    scale: "log" as const,
    group: "New tag",
    help: "Distinct values of one added tag. A value of 1 means the tag is absent or constant.",
    format: "count" as const,
  },
  {
    id: "tagFanout",
    label: "Hosts per tag value",
    min: 1,
    max: 5,
    step: 1,
    value: 2,
    unit: " hosts",
    group: "New tag",
    help: "Average hosts that report the same tag value because load balancing and retries move work.",
    format: "count" as const,
  },
  {
    id: "aggregations",
    label: "Query aggregations",
    min: 1,
    max: 4,
    step: 1,
    value: 1,
    unit: " agg",
    group: "Query",
    help: "Aggregation functions in the dashboard query. This raises query work, not the billable series count.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  hosts: number;
  metricNames: number;
  tagValues: number;
  tagFanout: number;
  aggregations: number;
  baseSeries: number;
  taggedSeries: number;
  series: number;
  budgetUsed: number;
  queryP95: number;
  seriesPerHost: number;
  tagged: boolean;
}

function compute(p: Params): Computed {
  const hosts = Math.round(num(p, "hosts", 300));
  const metricNames = Math.round(num(p, "metricNames", 20));
  const tagValues = Math.max(1, Math.round(num(p, "tagValues", 1)));
  const tagFanout = Math.max(1, Math.round(num(p, "tagFanout", 2)));
  const aggregations = Math.max(1, Math.round(num(p, "aggregations", 1)));
  const baseSeries = hosts * metricNames;
  const taggedSeries = metricNames * tagValues * tagFanout;
  const tagged = tagValues > 1;
  const series = tagged ? Math.max(baseSeries, taggedSeries) : baseSeries;
  return {
    hosts,
    metricNames,
    tagValues,
    tagFanout,
    aggregations,
    baseSeries,
    taggedSeries,
    series,
    budgetUsed: (series / SERIES_BUDGET) * 100,
    queryP95: 70 + (series / 1_000) * 2 * aggregations,
    seriesPerHost: series / Math.max(1, hosts),
    tagged,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed): void {
  const seedKeys: [string, number][] = [
    ["billable-series", values.series],
    ["budget-used", values.budgetUsed],
    ["query-p95", values.queryP95],
    ["series-per-host", values.seriesPerHost],
  ];
  for (const [id, value] of seedKeys) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + id.length) / 3.2);
      return Math.max(0, value * (0.98 + 0.02 * wave));
    });
  }
}

function buildFrame(p: Params): SimFrame {
  const values = compute(p);
  const budgetHealth = healthFor(values.budgetUsed, 70, 90);
  const seriesHealth = healthFor(values.series, 50_000, 80_000);
  return {
    t: 0,
    nodes: [
      {
        id: "agents",
        label: "Agent hosts",
        kind: "client",
        health: "ok",
        utilization: clamp(values.hosts / 5_000),
        sublabel: `${values.hosts.toLocaleString()} hosts`,
        detail: "Each host adds its own tag value to every metric it submits.",
        meta: { view: "flow" },
      },
      {
        id: "ingest",
        label: "Metric ingest",
        kind: "stream",
        health: healthFor(values.series / INGEST_CAPACITY, 0.7, 0.85),
        utilization: clamp(values.series / INGEST_CAPACITY),
        sublabel: `${Math.round(values.series).toLocaleString()} series`,
        detail: `Illustrative ingest capacity is ${INGEST_CAPACITY.toLocaleString()} series in this teaching model.`,
        meta: { view: "flow" },
      },
      {
        id: "index",
        label: "Indexed series",
        kind: "storage",
        health: budgetHealth,
        utilization: clamp(values.budgetUsed / 100),
        sublabel: `${values.budgetUsed.toFixed(0)}% of budget`,
        detail: `The model assumes a monthly budget of ${SERIES_BUDGET.toLocaleString()} billable series.`,
        meta: { view: "flow" },
      },
      {
        id: "bill",
        label: "Bill meter",
        kind: "external",
        health: budgetHealth,
        utilization: clamp(values.budgetUsed / 100),
        sublabel: `${values.series.toLocaleString()} series`,
        detail: "The bill follows distinct series in the month, not the number of datapoints or queries.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("agents-ingest", "agents", "ingest", 1),
      edge("ingest-index", "ingest", "index", clamp(values.series / INGEST_CAPACITY), seriesHealth),
      edge("index-bill", "index", "bill", clamp(values.budgetUsed / 100), seriesHealth),
    ],
    metrics: [
      metric("billable-series", "Billable series", values.series, " series", 50_000, 80_000, "count"),
      metric("budget-used", "Budget used", values.budgetUsed, "%", 70, 90, "percent"),
      metric("query-p95", "Query p95", values.queryP95, "ms", 300, 900, "ms"),
      metric("series-per-host", "Series per host", values.seriesPerHost, " /host", 100, 250, "count"),
    ],
    events: [],
    series: {},
    flags: { tagged: values.tagged ? 1 : 0 },
    summary: `${values.series.toLocaleString()} billable series, ${values.budgetUsed.toFixed(0)}% of the teaching budget; query p95 ${values.queryP95.toFixed(0)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "billable-series",
    metricId: "billable-series",
    warn: 50_000,
    crit: 80_000,
    title: "Billable series crossed the budget",
    cause:
      "A tag multiplied every metric and host combination. The bill follows distinct series, so the added tag now dominates the cost.",
    fix:
      "Remove the unbounded tag from metric submission, or keep ingestion and index only the tags that dashboards query. Move identifiers to logs or traces.",
    checkFirst: [
      "Open the Metrics Catalog and sort by indexed series.",
      "Find the metric name whose series count changed with the release.",
      "Compare the tag value count with the number of hosts.",
    ],
  },
  {
    id: "budget-used",
    metricId: "budget-used",
    warn: 70,
    crit: 90,
    title: "The custom metric budget is nearly exhausted",
    cause:
      "Series growth is consuming the pooled allocation the account needs for every other custom metric, not only this one.",
    fix:
      "Estimate the series count for every new tag before rollout. Drop the tag or replace it with a bounded dimension such as region, plan, or status.",
    checkFirst: [
      "Check the monthly average, not a single hour.",
      "List the top ten metrics by series count.",
      "Confirm whether the account is above its pooled host allocation.",
    ],
  },
  {
    id: "query-p95",
    metricId: "query-p95",
    warn: 300,
    crit: 900,
    title: "Dashboard queries scan too many series",
    cause:
      "The same tag that multiplied the bill also multiplied the series each panel must scan, and aggregation functions add more work per query.",
    fix:
      "Filter on a bounded tag, shorten the window, or remove the high-cardinality group-by. Query hygiene helps, but dropping the series is the durable fix.",
    checkFirst: [
      "Compare the panel's group-by tags with its baseline.",
      "Check whether a template variable expands to thousands of values.",
      "Open the query in Metrics Explorer and inspect the series count.",
    ],
  },
  {
    id: "series-per-host",
    metricId: "series-per-host",
    warn: 100,
    crit: 250,
    title: "The tagged metric set consumes too much allocation per host",
    cause:
      "The tagged metric set has many combinations and can use more than its share of the account allocation, leaving less room for other teams.",
    fix:
      "Set a series budget per metric and review it before adding dimensions. Keep identifiers out of metric labels.",
    checkFirst: [
      "Rank metrics by series per host.",
      "Check whether several metrics added the same tag in one release.",
      "Ask which dashboard or monitor needs the new dimension.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const metricCostModel: SimModel = {
  id: "observability-datadog-metric-cost",
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
    if (values.budgetUsed >= 100 && frame.flags.budgetEvent !== 1) {
      pushEvent(next, {
        id: "metric-budget-exceeded",
        at: frame.t,
        severity: "crit",
        title: "Monthly series budget exceeded",
        detail: `${values.series.toLocaleString()} billable series are ${values.budgetUsed.toFixed(0)}% of the teaching budget. The tag, not request volume, created the step change.`,
        nodeId: "bill",
        metricId: "budget-used",
      });
      next.flags.budgetEvent = 1;
    }
    if (values.budgetUsed < 100) next.flags.budgetEvent = 0;
    next.summary = `${values.series.toLocaleString()} billable series, ${values.budgetUsed.toFixed(0)}% of the teaching budget; query p95 ${values.queryP95.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The baseline is ${values.hosts.toLocaleString()} hosts x ${values.metricNames} metric names = ${values.baseSeries.toLocaleString()} series.`,
    );
    if (values.tagged) {
      items.push(
        `The tag creates ${values.tagValues.toLocaleString()} values x ${values.tagFanout} hosts x ${values.metricNames} metrics = ${values.taggedSeries.toLocaleString()} series. The model uses the larger of that shape and the ${values.baseSeries.toLocaleString()}-series baseline.`,
      );
    } else {
      items.push("With no new tag, the host tag alone sets the series count.");
    }
    items.push(
      `${values.aggregations} query aggregation${values.aggregations === 1 ? "" : "s"} raise the query to ${values.queryP95.toFixed(0)}ms but do not change the ${values.series.toLocaleString()} billable series.`,
    );
    items.push(`The budget is a teaching assumption of ${SERIES_BUDGET.toLocaleString()} series, not a vendor price or allocation.`);
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
    description: "Twenty metric names on 300 hosts, no high-cardinality tag.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak tag growth",
    description: "A 400-value tag on 600 hosts. Series and query time cross warning, not failure.",
    tone: "warn",
    params: defaults({ hosts: 600, metricNames: 50, tagValues: 400, tagFanout: 3, aggregations: 2 }),
  },
  {
    id: "failure",
    label: "Tag explosion",
    description: "3,000 tag values across 600 hosts. The series budget is exceeded several times over.",
    tone: "crit",
    params: defaults({ hosts: 600, metricNames: 50, tagValues: 3_000, tagFanout: 3, aggregations: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Remove the unbounded tag and return to the baseline series count.",
    tone: "ok",
    params: defaults({ hosts: 600, metricNames: 50, tagValues: 1, tagFanout: 3, aggregations: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-tag-cost",
  title: "Forecast a tagged metric portfolio",
  simId: "metric-cost",
  question:
    "A 50-metric portfolio runs on 600 hosts. A release adds a tag with 3,000 values to every metric name, each seen on three hosts. What happens first?",
  prediction: {
    options: [
      { id: "series", label: "Billable series and the bill rise by roughly an order of magnitude" },
      { id: "datapoints", label: "Only datapoint volume rises; the bill is unchanged" },
      { id: "queries", label: "Series are unchanged but queries get slower" },
      { id: "cheaper", label: "Series fall because the tag replaces the host tag" },
    ],
    correctOptionId: "series",
    explanation:
      "Custom metric billing counts distinct series. The new tag turns the 50-metric portfolio on 600 hosts into 50 metric names x 3,000 tag values x 3 hosts, which is 450,000 combinations. Datapoint frequency and query count are not the billing unit. The tag-identity mechanics are covered in Datadog Tags and Cardinality; this is the portfolio forecast before a rollout.",
  },
  setup: defaults({ hosts: 600, metricNames: 50, tagValues: 3_000, tagFanout: 3, aggregations: 3 }),
  runFor: 20,
  observe: [
    "Billable series rise from 30,000 to 450,000.",
    "The teaching budget of 80,000 series is exceeded by more than five times.",
    "Query p95 rises past two seconds because the panel scans the new series.",
    "Series per host rises from 50 to 750 across the 50-name portfolio, so the tagged set consumes the allocation other metrics need.",
  ],
  explain:
    "The tag did not add one dimension. It created a new identity for every metric, tag value, and reporting host. The baseline was 600 hosts x 50 metric names. The tagged shape is 50 metric names x 3,000 values x 3 hosts. The larger shape wins. Nothing about request rate, scrape interval, or query count changed.",
  fix: defaults({ hosts: 600, metricNames: 50, tagValues: 20, tagFanout: 3, aggregations: 2 }),
  debrief:
    "The tag-identity mechanics are covered in Datadog Tags and Cardinality; this experiment applies them to a 50-metric portfolio. Replacing the unbounded tag with 20 bounded values returns each metric to its baseline shape and the query below its warning threshold. The product still gets a useful dimension, but not one value per request. If the team needs the raw identifier, it belongs in logs or traces, where the cost model is built for high cardinality.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Datadog custom metric is billed by the number of distinct time series it creates, not by how often you submit datapoints or how many dashboards query it. A series is one metric name plus one unique combination of tag values, including the host tag. Add a tag with 3,000 values to a metric that already has 600 hosts and you do not add one dimension. You replace one series per host with thousands of combinations per metric.",
  },
  {
    type: "p",
    text: "The quiet part is that traffic, latency, and error rate can all stay flat. The bill moves because the metric's identity changed. A small tag addition can therefore dominate an observability budget without a single user-visible symptom, which is why the estimate belongs in the release review rather than the finance review.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Telemetry moves from the application or Agent to metric submission, ingestion, indexing, then query. Custom metric usage is counted from the distinct combinations received in each hour and averaged across the month. The host tag is part of that combination, so a larger fleet multiplies every metric that carries a per-host dimension.",
  },
  {
    type: "table",
    headers: ["Layer", "What grows", "What the bill follows"],
    rows: [
      ["Submission", "Datapoints and tag keys per request", "Not directly; frequency is not the billing unit"],
      ["Ingestion", "Every tag combination received", "Ingested custom metrics when tag filtering is configured"],
      ["Indexing", "The tag allowlist that stays queryable", "Indexed custom metrics, the default billing unit"],
      ["Query", "Series scanned by a panel or monitor", "Query time and compute, not the series bill"],
    ],
  },
  {
    type: "p",
    text: "Hosts count twice. The host tag is part of every identity, and the account includes a pooled custom metric allocation based on host count. One oversized tagged metric set can consume room that every other metric depends on. This model assumes the account is already above its pool, so each additional series is billable. The budget is expressed in series, not dollars, because vendor rates vary by contract and plan.",
  },
  {
    type: "p",
    text: "The arithmetic assumes one series per metric name, host, and tag combination, which fits count, gauge, and rate metrics. Histograms and distributions create multiple series or aggregations per combination. Multiply the estimate with the vendor's metric-type rules before sizing a release.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Billable series and series per host, with warning and critical budgets.",
      "Budget used as a percentage of an illustrative 80,000-series monthly budget.",
      "Query p95, which rises when the same tag expands the series a panel must scan.",
      "Four topology nodes: hosts, ingest, indexed series, and the bill meter.",
      "The tag value count and host fan-out that create the multiplication.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the 6,000-series baseline. Apply Tag explosion. Watch series, budget, series per host, and query p95 move together. Then apply Recovery and compare. Run the experiment before reading the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "p",
    text: "The model is deliberately small: one added tag, an average host fan-out, and a fixed series budget. The numbers are teaching values, not a Datadog quote or a capacity guarantee. The lesson is the multiplication. Change one tag and the bill and query scan move together even when request volume is flat.",
  },
  { type: "sim", simId: "metric-cost" },
  { type: "experiment", experimentId: "predict-tag-cost" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The new tag changed the metric's identity. Before the tag, the baseline was 600 hosts x 50 metric names, or 30,000 series. After the tag, the tagged shape was 50 metric names x 3,000 values x 3 reporting hosts, or 450,000 series. The larger shape won. The series count rose fifteen times, the teaching budget was exceeded by more than five times, and the dashboard query crossed two seconds.",
  },
  {
    type: "p",
    text: "Request rate never changed. The query aggregations added work per panel, but they did not create the series. That distinction matters during an incident: turning off dashboards reduces query load, while only removing the tag or restricting the index reduces the bill.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Plan and Usage: the monthly average of indexed custom metrics, split by product and top metric.",
      "Metrics Catalog: ingested versus indexed series and the tag keys that dominate the count.",
      "A deploy or configuration change that added the tag, often in shared middleware rather than the service owner's code.",
      "Dashboards that were fast at dozens of series and became slow at thousands, especially with a wide window.",
      "Tag indexing rules or percentile aggregation settings that changed the queryable shape of the metric.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the metric and the tag key, not just the total bill. Open the Metrics Catalog, sort by indexed series, and compare the top metric with last week. Then check whether the account is above its pooled allocation before treating every new series as billable.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the multiplication: remove the unbounded tag from metric submission. This reduces both the stored series and the query scan.",
      "If the tag must be ingested, configure an allowlist so only the tags that dashboards and monitors use remain indexed.",
      "Replace the raw identifier with a bounded dimension such as region, plan, status, or a small customer tier.",
      "Move user-level or request-level analysis to logs, traces, or a dedicated store built for identifiers.",
      "Add a release check that estimates series as metric names x hosts x tag values before a new tag ships.",
      "Verify the fix in the Metrics Catalog: indexed series should fall and the panel should return to its query budget.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Dropping a tag removes a question the product could ask. Agree on the bounded dimension that preserves the decision, not only the cheapest tag set.",
      "Indexing an allowlist keeps ingestion but removes queryability for the dropped tag. The raw data may still cost money and cannot be queried later.",
      "Sampling tag values keeps some series but makes per-value counts and ratios unreliable. A sampled dimension is not a smaller version of the same answer.",
      "Per-customer dashboards multiply series too. Budget the dimension, not the number of dashboards.",
      "Aggregation and query hygiene can make panels faster, but they do not undo the billable series. Treat them as separate levers.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "estimate-series",
    question:
      "A metric runs on 400 hosts with 12 tag values. Each host emits 15 metric names. Roughly how many series does it create, and what changes if the tag becomes 2,000 values?",
    difficulty: 2,
    hints: [
      "Start with metric names x hosts.",
      "A tag value does not always appear on every host.",
    ],
    answer:
      "Without the tag, the shape is 15 metric names x 400 hosts, or 6,000 series. With 12 tag values, if each value appears on every host, the shape becomes 15 x 12 x 400, or 72,000 series, so the larger shape wins. At 2,000 values the same arithmetic gives 12 million series if each value is seen on every host. In practice I would use the measured hosts per tag value rather than assume full fan-out, because a value that appears on one host contributes far fewer combinations. The point is to estimate the multiplier before the release, then confirm in the Metrics Catalog.",
    followUps: [
      "What if each tag value appears on only two hosts?",
      "How would a histogram change the estimate?",
      "Which number would you take to the release review?",
    ],
    redFlags: [
      "Counts tag keys instead of combinations.",
      "Assumes submission frequency sets the bill.",
      "Ignores the host tag.",
    ],
    rubric: [
      "Shows the multiplication.",
      "Uses hosts per tag value.",
      "Names the confirming usage view.",
      "Separates estimate from guarantee.",
    ],
  },
  {
    id: "bill-doubled",
    question:
      "The custom metric bill doubles in one week. Traces and logs are flat, and request rate is unchanged. How do you find the cause?",
    difficulty: 2,
    hints: [
      "Start with the billing unit, not the invoice.",
      "Look for a new identity before a new volume.",
    ],
    answer:
      "I would split the bill by product and confirm that custom metrics moved. Then I would open the Metrics Catalog and sort by indexed series, comparing the top metrics with the prior week. I would look for a metric whose distinct tag combinations grew while its datapoint rate stayed flat, and correlate that with a deploy or a tag rule change. Comparing ingested and indexed volume tells me whether an allowlist is involved. The confirming evidence is a series count step change tied to a new tag, not a traffic increase.",
    followUps: [
      "What would make you suspect logs instead?",
      "How does a percentile aggregation change the picture?",
      "Which number do you show finance: peak or monthly average?",
    ],
    redFlags: [
      "Starts by deleting dashboards.",
      "Assumes datapoint volume is the bill.",
      "Blames the vendor without finding the tag.",
    ],
    rubric: [
      "Uses usage and catalog evidence.",
      "Separates ingested from indexed.",
      "Correlates with a release.",
      "Names the confirming metric and tag.",
    ],
  },
  {
    id: "why-frequency-free",
    question:
      "Why can a team scrape a metric every five seconds instead of every minute without changing the custom metric bill?",
    difficulty: 1,
    hints: [
      "The billing unit is an identity, not a sample.",
      "Ask how many distinct series exist in the hour.",
    ],
    answer:
      "The bill counts distinct series in each hour, then averages those hourly counts over the month. Scraping more often adds datapoints to an existing series but does not create a new series. The bill changes when the metric name, host, or tag combination changes. There are exceptions around how a vendor treats particular metric types or aggregation settings, so I would verify the contract, but frequency alone is not the multiplier in the standard custom metric model.",
    followUps: [
      "What does change when scrape frequency rises?",
      "How would you prove the series count is stable?",
      "Why might a histogram behave differently?",
    ],
    redFlags: [
      "Says every datapoint is billed.",
      "Confuses query volume with ingestion.",
      "Ignores metric type differences.",
    ],
    rubric: [
      "States the series identity.",
      "Separates datapoints from series.",
      "Mentions the hourly average.",
      "Flags vendor-specific exceptions.",
    ],
  },
  {
    id: "governance",
    question:
      "You own observability cost. What governance would stop the next tag explosion without blocking every team?",
    difficulty: 3,
    hints: [
      "Make the estimate part of the release, not the invoice.",
      "Give teams a bounded alternative.",
    ],
    answer:
      "I would publish a short series-estimate rule, require the estimate in the metric review, and add a usage alert on the monthly average. I would define approved bounded dimensions and a fast path for them, so teams do not need a central review for every status or region tag. For identifiers, I would provide a traces or logs path with its own retention and access budget. I would also review the top metrics by series every month and feed the findings back into the rule. The goal is to make the cheap path the default without pretending cost does not matter.",
    followUps: [
      "Who owns the budget: platform or service teams?",
      "How do you handle an exception for a real customer need?",
      "What would you automate first?",
    ],
    redFlags: [
      "Requires manual review for every tag.",
      "Cuts telemetry without a coverage decision.",
      "Has no owner for the monthly number.",
    ],
    rubric: [
      "Makes estimation part of the release.",
      "Provides bounded alternatives.",
      "Names an owner and alert.",
      "Balances cost with coverage.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Estimate series as metric names x hosts x tag values for every new tag.",
      "Confirm the tag value is bounded and cannot become a user or request ID.",
      "Check the account's current position against its pooled custom metric allocation.",
      "Identify the dashboard or monitor that needs the new dimension.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the metric and tag key before changing retention or dashboards.",
      "Compare ingested and indexed volume to see which layer grew.",
      "Remove the tag at submission if a rollback is fast enough.",
      "If rollback is slow, apply an allowlist and verify critical panels still work.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify indexed series and the query p95 return to budget.",
      "Add a tag rule so the same key cannot return on another metric.",
      "Move identifier-level analysis to logs or traces.",
      "Record the estimate and the actual series count in the review.",
    ],
  },
];

const references = [
  {
    title: "Custom Metrics Billing",
    url: "https://docs.datadoghq.com/account_management/billing/custom_metrics/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Series identity, hourly distinct counts, and monthly averaging.",
  },
  {
    title: "Getting Started with Tags",
    url: "https://docs.datadoghq.com/getting_started/tagging/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Tag format and the warning against unbounded values such as user IDs.",
  },
  {
    title: "Metrics without Limits",
    url: "https://docs.datadoghq.com/metrics/metrics-without-limits/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Ingested versus indexed volume and tag allowlists.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "metric-cost": {
      model: metricCostModel,
      presets,
      instructions:
        "Start Healthy, then apply Tag explosion. Compare billable series, budget used, series per host, and query p95 before and after Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 80,000-series budget, ingest capacity, and query curve are teaching values, not Datadog prices or allocations.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-datadog-tags",
    "observability-datadog-apm",
    "observability-telemetry-cost",
    "observability-victoriametrics-cardinality",
  ],
};
