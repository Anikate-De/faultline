import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const STATUS_CLASSES = 4;
const INDEX_SHARDS = 8;
const SHARD_SERIES_CAPACITY = 1_500;
const BASELINE_METRIC_SHARE = 0.16;

const params = [
  {
    id: "hosts",
    label: "Agent hosts",
    min: 50,
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
    id: "userValues",
    label: "user_id distinct values",
    min: 1,
    max: 100_000,
    step: 100,
    value: 1,
    unit: "",
    scale: "log" as const,
    group: "New tag",
    help: "Distinct values emitted for the user_id tag per hour. A value of 1 means the tag is constant or absent.",
    format: "count" as const,
  },
  {
    id: "hostSpread",
    label: "Hosts reporting one user",
    min: 1,
    max: 5,
    step: 1,
    value: 2,
    unit: " hosts",
    group: "New tag",
    help: "Average number of hosts that emit a series for the same user because load balancing and retries move requests.",
    format: "count" as const,
  },
  {
    id: "endpointFanout",
    label: "Endpoints per user",
    min: 1,
    max: 6,
    step: 1,
    value: 2,
    unit: " endpoints",
    group: "New tag",
    help: "Endpoint tag values a user touches in an hour. Each combination of user, host, endpoint, and status is separate.",
    format: "count" as const,
  },
  {
    id: "queryWindow",
    label: "Dashboard query window",
    min: 1,
    max: 24,
    step: 1,
    value: 1,
    unit: " h",
    group: "Query",
    help: "Time range scanned by a dashboard panel. A wider window scans more series and raises query time.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  hosts: number;
  userValues: number;
  hostSpread: number;
  endpointFanout: number;
  queryWindow: number;
  baseSeries: number;
  series: number;
  seriesPerHost: number;
  ratio: number;
  costIndex: number;
  queryP95: number;
  shardCpu: number;
  shardSeries: number;
}

function compute(p: Params): Computed {
  const hosts = Math.round(num(p, "hosts", 300));
  const userValues = Math.round(num(p, "userValues", 1));
  const hostSpread = Math.round(num(p, "hostSpread", 2));
  const endpointFanout = Math.round(num(p, "endpointFanout", 2));
  const queryWindow = Math.round(num(p, "queryWindow", 1));
  const baseSeries = hosts * endpointFanout * STATUS_CLASSES;
  const taggedSeries = userValues * hostSpread * endpointFanout * STATUS_CLASSES;
  const series = userValues <= 1 ? baseSeries : Math.max(baseSeries, taggedSeries);
  const activeHosts = userValues <= 1 ? hosts : Math.min(hosts, userValues * hostSpread);
  const ratio = series / Math.max(1, baseSeries);
  const windowFactor = 1 + 0.08 * (queryWindow - 1);
  const queryP95 = (80 + 12 * Math.sqrt(series / 100)) * windowFactor;
  const shardSeries = series / INDEX_SHARDS;
  return {
    hosts,
    userValues,
    hostSpread,
    endpointFanout,
    queryWindow,
    baseSeries,
    series,
    seriesPerHost: series / Math.max(1, activeHosts),
    ratio,
    costIndex: 1 + BASELINE_METRIC_SHARE * (ratio - 1),
    queryP95,
    shardCpu: clamp((shardSeries / SHARD_SERIES_CAPACITY) * 100, 0, 100),
    shardSeries,
  };
}

function healthFor(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  for (let index = 0; index < INDEX_SHARDS; index++) {
    frame.series[`cpu.index-${index}`] = Array.from({ length: 24 }, (_, point) => {
      const wave = Math.sin((point + index + (seed % 7)) / 3.1);
      return clamp(values.shardCpu * (0.94 + 0.08 * wave) + 6, 0, 100);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const shardHealth = healthFor(values.shardCpu);
  const hotTag = values.userValues >= 500;
  const nodes = Array.from({ length: INDEX_SHARDS }, (_, index) => ({
    id: `index-${index}`,
    label: `idx-${String(index).padStart(2, "0")}`,
    kind: "cache" as const,
    role: "shard" as const,
    health: shardHealth,
    utilization: values.shardCpu / 100,
    throughput: values.shardSeries,
    sublabel: `${Math.round(values.shardSeries).toLocaleString()} series`,
    detail: `Illustrative metrics index shard: ${Math.round(values.shardSeries).toLocaleString()} series at ${values.shardCpu.toFixed(0)}% of the teaching capacity.`,
    meta: {
      view: "shards",
      cpu: values.shardCpu,
      memory: 1.2 + values.shardSeries / 2_000,
      hot: 0,
    },
  }));
  return {
    t: 0,
    nodes,
    edges: [],
    metrics: [
      metric("series", "Billable series", values.series, " series", 10_000, 25_000, "count"),
      metric("query-p95", "Dashboard query p95", values.queryP95, "ms", 200, 250, "ms"),
      metric("cost-index", "Account bill index", values.costIndex, "×", 1.8, 2.5, "number"),
      metric("series-per-host", "Series per host", values.seriesPerHost, " /host", 100, 225, "count"),
      metric("user-tag-values", "user_id values", values.userValues, " values", 500, 5_000, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, hotTag: hotTag ? 1 : 0 },
    summary: `${Math.round(values.series).toLocaleString()} series, ${values.seriesPerHost.toFixed(0)} per host; query p95 ${values.queryP95.toFixed(0)}ms; account bill index ${values.costIndex.toFixed(2)}×.`,
  };
}

function insightsFor(p: Params): string[] {
  const values = compute(p);
  const items: string[] = [];
  if (values.userValues <= 1) {
    items.push(`Series are hosts × endpoints × status classes: ${values.hosts} × ${values.endpointFanout} × ${STATUS_CLASSES} = ${values.baseSeries.toLocaleString()}.`);
  } else {
    items.push(`The tag contributes ${values.userValues.toLocaleString()} values × ${values.hostSpread} hosts × ${values.endpointFanout} endpoints × ${STATUS_CLASSES} status classes = ${values.series.toLocaleString()} series.`);
  }
  items.push(`A dashboard query over a ${values.queryWindow}h window scans the series that fall in that range; p95 is ${values.queryP95.toFixed(0)}ms.`);
  items.push(`At ${values.ratio.toFixed(1)}× the baseline series, the illustrative account bill index is ${values.costIndex.toFixed(2)}×.`);
  if (values.seriesPerHost >= 100) {
    items.push(`This metric alone averages ${values.seriesPerHost.toFixed(0)} indexed series per host, more than the 100-per-host share the account's included allocation provides.`);
  }
  items.push(`All ${INDEX_SHARDS} index shards carry ${Math.round(values.shardSeries).toLocaleString()} series each; capacity is exhausted together because hashing spreads values evenly.`);
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "series",
    metricId: "series",
    warn: 10_000,
    crit: 25_000,
    title: "Billable series crossed the cardinality budget",
    cause: "One tag added a value per user, and every unique combination of host, endpoint, status, and user became its own time series.",
    fix: "Remove or allowlist the high-cardinality tag, or move user-level analysis to logs, traces, or a dedicated store. Do not keep a per-user dimension on a fleet-wide metric.",
    checkFirst: [
      "Find the metric name and tag key with the largest series growth in the Metrics Catalog.",
      "Compare ingested and indexed custom metrics on the usage page.",
      "Identify which release or configuration started sending the tag.",
    ],
  },
  {
    id: "query-p95",
    metricId: "query-p95",
    warn: 200,
    crit: 250,
    title: "Dashboard query latency breached the budget",
    cause: "The query has to scan many more series for the same time window, so panel load time grows with cardinality even when the number of datapoints is unchanged.",
    fix: "Reduce the series the query must scan: filter by a bounded tag, shorten the window, or drop the high-cardinality dimension from the indexed tag set.",
    checkFirst: [
      "Compare the panel's time window and group-by tags with its baseline.",
      "Check whether a template variable expands to thousands of values.",
      "Open the query in the Metrics Explorer and inspect series count.",
    ],
  },
  {
    id: "cost-index",
    metricId: "cost-index",
    warn: 1.8,
    crit: 2.5,
    title: "The account bill index tripled",
    cause: "Billable custom metric usage is based on distinct series per hour, not datapoint frequency, so a tag that multiplies combinations multiplies the bill.",
    fix: "Drop the tag at submission or index time, then verify the indexed volume falls. Metrics without Limits can keep ingestion intact while reducing queryable tags.",
    checkFirst: [
      "Confirm the bill change is custom metrics, not infrastructure or logs.",
      "Check the monthly average series count, not a single peak.",
      "Verify whether Metrics without Limits is configured for the metric.",
    ],
  },
  {
    id: "series-per-host",
    metricId: "series-per-host",
    warn: 100,
    crit: 225,
    title: "Series per host exceeds the included allocation",
    cause: "A metric with user-level combinations can consume more than its share of the account-wide custom metric allocation, leaving less room for every other metric.",
    fix: "Govern tag keys centrally with tag indexing rules and review the top metrics by series before adding more dimensions.",
    checkFirst: [
      "List the top custom metrics by indexed series.",
      "Check the account's included allocation and host count.",
      "Look for other metrics that added the same tag in the release.",
    ],
  },
  {
    id: "user-tag-values",
    metricId: "user-tag-values",
    warn: 500,
    crit: 5_000,
    title: "A tag with unbounded values is being emitted",
    cause: "User IDs, request IDs, and timestamps are unbounded sources. Datadog's tagging guidance explicitly warns that they cause unbounded metric growth.",
    fix: "Remove the tag from metric submission. If user correlation is required, use logs or traces, which are designed for high-cardinality identifiers.",
    checkFirst: [
      "Find the code path that adds the tag.",
      "Check whether the value is an ID, timestamp, or raw URL.",
      "Confirm the tag is not also applied by a host or pipeline rule.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const datadogTagsModel: SimModel = {
  id: "observability-datadog-tags",
  visual: "shards",
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
    const jitter = rng.between(-0.015, 0.015);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p95" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? 0));
    if (values.userValues >= 500 && frame.flags.cardinalitySeen !== 1) {
      pushEvent(next, {
        id: "high-cardinality-tag",
        at: frame.t,
        severity: "warn",
        title: "High-cardinality tag detected",
        detail: `${values.userValues.toLocaleString()} user_id values are present. Series are ${values.ratio.toFixed(1)}× baseline and the bill index is ${values.costIndex.toFixed(2)}×.`,
        nodeId: "index-0",
        metricId: "series",
      });
      next.flags.cardinalitySeen = 1;
    }
    if (values.userValues < 500) next.flags.cardinalitySeen = 0;
    next.summary = `${Math.round(values.series).toLocaleString()} series, ${values.seriesPerHost.toFixed(0)} per host; query p95 ${values.queryP95.toFixed(0)}ms; account bill index ${values.costIndex.toFixed(2)}×.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => insightsFor(p),
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
    description: "Host, endpoint, and status tags only. Series stay inside the budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak, 500 user values",
    description: "A busy hour with a moderate user tag and a three-hour dashboard window. Warning, not failure.",
    tone: "warn",
    params: defaults({ userValues: 500, queryWindow: 3 }),
  },
  {
    id: "failure",
    label: "user_id added",
    description: "2,000 user values, each seen on two of 300 hosts, across two endpoints. Series explode and the bill triples.",
    tone: "crit",
    params: defaults({ userValues: 2_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Remove the user_id tag from the metric and return the query window to one hour.",
    tone: "ok",
    params: defaults({ userValues: 1, queryWindow: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-cardinality",
  title: "Predict what a user_id tag does",
  simId: "datadog-tags",
  question:
    "The metric already carries host, endpoint, and status tags. A release adds user_id with 2,000 distinct values. What happens first?",
  prediction: {
    options: [
      { id: "series-blowup", label: "Series grow by roughly an order of magnitude and dashboard queries cross the latency budget" },
      { id: "ingest-only", label: "Datapoint ingest rises but the bill stays flat because billing counts samples" },
      { id: "query-only", label: "Series count is unchanged but query latency rises because the tag is indexed" },
      { id: "cheaper", label: "Series get smaller, so query latency and cost fall" },
    ],
    correctOptionId: "series-blowup",
    explanation:
      "A custom metric is identified by its metric name and tag values, including the host tag. The user_id value splits every existing host, endpoint, and status combination into one series per user. The billable count follows distinct series per hour, not submission frequency.",
  },
  setup: defaults({ userValues: 2_000 }),
  runFor: 20,
  observe: [
    "Billable series rise from 2,400 to 32,000 and series per host from 8 to about 107.",
    "The query p95 rises from about 139ms to about 295ms, past the 250ms budget.",
    "The account bill index rises from 1.00× to about 3.0×.",
    "All eight index shards saturate, because hashing spreads user values across every shard.",
  ],
  explain:
    "The new tag turns one series per host, endpoint, and status into one series per user, host, endpoint, and status. The count is 2,000 users × 2 hosts × 2 endpoints × 4 status classes, which is 32,000. Nothing about the request rate changed. The bill and the query cost changed because the metric now has far more identities to store and scan.",
  fix: defaults({ userValues: 1, queryWindow: 1 }),
  debrief:
    "Removing the tag restores the series count and the bill index. The product still needs user-level answers, so put the user ID in logs, traces, or a dedicated analytics store, and keep the metric aggregated by bounded dimensions. If the tag must be ingested, use Metrics without Limits to keep only the tags that dashboards actually query.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Datadog tag is a key and value pair attached to telemetry, such as `env:prod` or `endpoint:/checkout`. Tags let you filter, group, and compare data. They also define identity. For a custom metric, the billable unit is a time series: one metric name plus one unique combination of tag values, including the host tag. Add a tag and you do not add one dimension to a chart. You split every existing series into as many series as that tag has values.",
  },
  {
    type: "p",
    text: "Cardinality is the number of distinct values a tag can take. `env` has a handful. `endpoint` has dozens. `user_id`, `request_id`, and timestamps are unbounded: every new value creates a new series. Datadog's tagging guidance names user IDs and request IDs as sources that cause unbounded metric growth. The failure is quiet because request volume, latency, and error rate can all stay normal while the series count and the bill climb.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application or Agent, metric submission, ingestion, indexing, then query. Datadog counts a custom metric by the distinct combinations submitted in each hour. Billable usage is the monthly average of those hourly counts; it is not affected by how often you submit datapoints or how many queries you run. A histogram or distribution metric multiplies the count again because each combination generates several aggregations.",
  },
  {
    type: "table",
    headers: ["Layer", "What grows", "What the bill follows"],
    rows: [
      ["Submission", "Datapoints and tags per request", "Not directly; frequency is not the billing unit"],
      ["Ingestion", "Every tag combination received", "Ingested custom metrics when Metrics without Limits is configured"],
      ["Indexing", "The tag allowlist that stays queryable", "Indexed custom metrics, the default billing unit"],
      ["Query", "Series scanned for a panel or monitor", "Query latency and compute, not the custom metric bill"],
    ],
  },
  {
    type: "p",
    text: "Hosts matter twice. The host tag is part of every series identity, so a larger fleet creates more combinations. Datadog also includes a custom metric allocation per host, commonly 100 indexed metrics per host on the Pro plan and 200 on Enterprise. That allocation is pooled across the account, so one oversized metric can consume the room reserved for many smaller ones. The model here assumes the account is already above its allotment, which makes each additional indexed series billable.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Billable series and series per host, with warning and critical budgets.",
      "Dashboard query p95 for a selected time window, the signal that a panel is scanning too many series.",
      "An account bill index, an illustrative multiple of the baseline bill for a metric assumed to be 16% of that bill.",
      "The user_id value count, which isolates the tag that is creating the combinations.",
      "Eight index shards that fill together as series are spread by hash across the storage layer.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that 2,400 series come from hosts, endpoints, and status classes. Apply user_id added. Watch the series, series per host, query p95, and bill index move together. Then apply Recovery and compare. Run the experiment before reading the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "p",
    text: "The model is deliberately small: four status classes, one metric name, and a fixed 16% share of the baseline bill. The numbers are illustrative teaching values, not a Datadog quote or a capacity guarantee. The lesson is the multiplication. Change one high-cardinality tag and the series count, the query scan, and the bill move together even when traffic is flat.",
  },
  { type: "sim", simId: "datadog-tags" },
  { type: "experiment", experimentId: "predict-cardinality" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The user_id tag changed the identity of the metric. Before the tag, each host, endpoint, and status combination was one series. After the tag, each user, host, endpoint, and status combination became its own series. The count rose from 2,400 to 32,000. Request rate did not change. The bill index rose to about 3.0× because this metric represents a share of the bill and its series multiplied.",
  },
  {
    type: "p",
    text: "The query got slower for the same reason. A dashboard panel scans the series that match its filters over its time window. More series means more work, so p95 crossed the 250ms budget. The index shards saturated together because a hash spreads user values evenly; there is no single hot shard to fix. Cardinality is a fleet-wide shape problem, not a partition problem.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Metrics Catalog: the metric's ingested and indexed custom metric counts, plus the tags that dominate the count.",
      "Plan and Usage: the monthly average indexed custom metrics, the top custom metrics table, and the change against the prior day.",
      "Metric queries: a panel that was fast at 10 series becomes slow at 30,000, especially with a wide time window or a group-by on the new tag.",
      "Deploy history: a release that added the tag, often to one library or one shared middleware.",
      "Datadog audit events: tag configuration and percentile aggregation changes that can also raise volume.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the metric and the tag key, not just the total bill. Open the Metrics Catalog, compare ingested and indexed custom metrics, and look for a release that added an unbounded value. Confirm whether the account is above its pooled allocation before treating every new series as billable.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the multiplication: remove user_id, request_id, or timestamp tags from metric submission. This is the most direct fix because it reduces both stored series and the query scan.",
      "If the tag must be ingested, configure an allowlist with Metrics without Limits so only the tags dashboards actually query remain indexed.",
      "Move user-level questions to logs, traces, or a dedicated analytics store, where high-cardinality identifiers are expected.",
      "Replace the unbounded tag with a bounded one that answers the product question, such as plan, region, or a small customer tier.",
      "Add tag indexing rules and a usage alert on estimated custom metrics so the next release is caught before the monthly average moves.",
      "Verify the fix in the Metrics Catalog: indexed series should fall, and the dashboard should return to its budget.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Dropping a tag removes a question the product could ask. Agree on the bounded dimension that preserves the decision, not just the cheapest tag set.",
      "Metrics without Limits keeps ingestion but removes queryability. It reduces the indexed bill, not necessarily the ingested volume, and the dropped tag cannot be queried later.",
      "Sampling user IDs keeps some series but makes per-user counts and ratios unreliable. A sampled dimension is not a smaller version of the same answer.",
      "Per-customer dashboards can be built from a small set of bounded IDs, but each dashboard still multiplies series. Budget the dimension, not the dashboard count.",
      "A wider query window raises latency even after the tag is fixed. Cardinality control and query hygiene are separate levers.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-bill",
    question:
      "The observability bill triples in one week. Traces and logs are flat. How do you find out whether cardinality is the cause?",
    difficulty: 2,
    hints: [
      "Start with the billing unit, not the total bill.",
      "A metric can be healthy in latency and still explode in identities.",
    ],
    answer:
      "I would go to Plan and Usage and split the bill by product. If custom metrics moved, I would open the Metrics Catalog and sort by indexed series, then compare the top metrics with the previous week. I would look for a new tag key whose value count is close to the metric's series count, and correlate the change with deploys. I would also compare ingested and indexed volumes to see whether Metrics without Limits is involved. The confirming evidence is a metric whose distinct tag combinations grew while its datapoint rate stayed flat.",
    followUps: [
      "What would make you suspect logs instead of metrics?",
      "How does a histogram change the count?",
      "Which number do you show finance: peak series or monthly average?",
    ],
    redFlags: [
      "Starts by deleting dashboards.",
      "Assumes submission frequency is the billing unit.",
      "Blames the vendor without finding the tag.",
    ],
    rubric: [
      "Uses the Metrics Catalog and usage page.",
      "Separates ingested from indexed volume.",
      "Correlates the change with a deploy or tag rule.",
      "Names the confirming metric and tag.",
    ],
  },
  {
    id: "low-cardinality-tag",
    question:
      "Why can adding a `region` tag leave the series count unchanged, while adding `user_id` multiplies it?",
    difficulty: 2,
    hints: [
      "Count unique combinations, not tag keys.",
      "Ask whether the new value is already determined by another tag.",
    ],
    answer:
      "A host already belongs to one region, so region does not create a new combination for a metric that already has the host tag. The pair host and region has the same number of distinct values as host alone. A user ID is not determined by the host; the same host can see many users, and the same user can appear on several hosts, so every user-host pair is a new series. The test is functional dependence and value count, not whether the tag looks small.",
    followUps: [
      "What if a host can move regions during the hour?",
      "How would you prove the dependence from the tag values?",
      "Which tag would you add to answer a regional latency question?",
    ],
    redFlags: [
      "Assumes every new tag multiplies series.",
      "Counts tag keys instead of combinations.",
      "Ignores host churn.",
    ],
    rubric: [
      "Explains unique combinations.",
      "Uses functional dependence.",
      "Distinguishes bounded from unbounded values.",
    ],
  },
  {
    id: "keep-user-analysis",
    question:
      "Product wants to find users with slow checkouts. You cannot put user_id on the metric. What do you build instead?",
    difficulty: 3,
    hints: [
      "Match the data type to the cardinality.",
      "A metric is for aggregates; an identifier belongs in an event store.",
    ],
    answer:
      "I would keep the metric aggregated by bounded dimensions such as endpoint, region, status, and release, and send the user ID to traces or logs as a structured attribute. Then I can query slow traces, group by user, and join back to the metric for the aggregate shape. If the product needs a per-user metric, I would use a small bounded cohort or customer tier, not the raw ID. I would also check whether the application can emit a separate per-user event with its own retention and cost budget.",
    followUps: [
      "How would you link a trace back to the metric?",
      "What retention would you set on the user-level data?",
      "When would a per-customer metric be justified?",
    ],
    redFlags: [
      "Suggests hashing the user ID and calling it bounded.",
      "Keeps the tag and samples it without explaining bias.",
      "Ignores access control on user-level data.",
    ],
    rubric: [
      "Separates aggregate metrics from identifiers.",
      "Uses traces or logs for user-level questions.",
      "Names a bounded substitute.",
      "Considers retention and access.",
    ],
  },
  {
    id: "metrics-without-limits",
    question:
      "A team insists on ingesting user_id for future analysis. How does Metrics without Limits change the cost and the risk?",
    difficulty: 3,
    hints: [
      "Ingested and indexed are different volumes.",
      "The allowlist decides what remains queryable.",
    ],
    answer:
      "Metrics without Limits decouples ingestion from indexing. The team can keep sending the tag, but an allowlist decides which tags remain queryable. The indexed custom metric count falls to the combinations of the allowed tags, while ingested volume still reflects what was sent. The risk is that the dropped tag cannot be queried later, and the ingested volume can still cost money. I would confirm the estimator shows indexed below ingested, configure the allowlist from tags that dashboards and monitors actually use, and keep the raw user-level analysis in traces or logs.",
    followUps: [
      "What happens to a monitor that groups by the dropped tag?",
      "How would you audit which tags are actually queried?",
      "Why can ingested volume exceed indexed volume?",
    ],
    redFlags: [
      "Says ingestion becomes free.",
      "Configures an allowlist without checking assets.",
      "Assumes dropped tags remain queryable.",
    ],
    rubric: [
      "Distinguishes ingested and indexed.",
      "Names the allowlist behavior.",
      "Checks dashboards and monitors before dropping.",
      "Keeps a path for user-level analysis.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every custom metric has an owner and a documented tag set.",
      "Tag keys are reviewed for unbounded sources such as user IDs, request IDs, and timestamps.",
      "The Metrics Catalog is checked for the top metrics by indexed series each release.",
      "Usage alerts watch estimated custom metrics, not only the monthly invoice.",
      "The team knows which questions belong in metrics and which belong in traces or logs.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the metric and tag key before changing any configuration.",
      "Compare ingested and indexed volume, and confirm the account's allocation position.",
      "Remove the unbounded tag at submission if the release can be rolled back quickly.",
      "If rollback is slow, apply an allowlist and verify that critical dashboards still work.",
      "Record the series count before and after each change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the indexed series and the bill index return to budget.",
      "Add a tag indexing rule so the same key cannot return on another metric.",
      "Move the user-level question to a data type designed for identifiers.",
      "Add a release check that estimates series before a new tag ships.",
      "Review whether a bounded cohort can answer the product question.",
    ],
  },
];

const references = [
  {
    title: "Getting Started with Tags",
    url: "https://docs.datadoghq.com/getting_started/tagging/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Tag format, reserved keys, and the warning against user IDs and request IDs as tag sources.",
  },
  {
    title: "Custom Metrics Billing",
    url: "https://docs.datadoghq.com/account_management/billing/custom_metrics/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Series identity, hourly distinct counts, allocations, and histogram multipliers.",
  },
  {
    title: "Metrics without Limits",
    url: "https://docs.datadoghq.com/metrics/metrics-without-limits/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Ingested versus indexed custom metrics and tag allowlists.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "datadog-tags": {
      model: datadogTagsModel,
      presets,
      instructions:
        "Start Healthy, then apply user_id added. Compare series, series per host, query p95, and the bill index before and after Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. The 16% bill share, query curve, and index shard capacity are teaching values, not Datadog prices or guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-datadog-metric-cost",
    "observability-metrics-types",
    "observability-victoriametrics-cardinality",
    "observability-golden-signals",
  ],
};
