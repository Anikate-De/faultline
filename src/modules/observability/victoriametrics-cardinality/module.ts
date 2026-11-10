import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BYTES_PER_SERIES = 8_192;
const MEMORY_CAPACITY_GB = 128;
const SAMPLES_PER_DAY = 5_760;
const BYTES_PER_SAMPLE = 1.2;
const INGEST_CAPACITY = 2_000_000;

const params = [
  {
    id: "metricNames",
    label: "Metric names",
    min: 10,
    max: 500,
    step: 10,
    value: 80,
    unit: " names",
    group: "Shape",
    help: "Distinct metric names emitted by each host.",
    format: "count" as const,
  },
  {
    id: "hosts",
    label: "Reporting hosts",
    min: 50,
    max: 5_000,
    step: 50,
    value: 500,
    unit: " hosts",
    scale: "log" as const,
    group: "Shape",
    help: "Hosts that report the metric. The host tag is part of every series identity.",
    format: "count" as const,
  },
  {
    id: "labelValues",
    label: "Label values per host",
    min: 1,
    max: 5_000,
    step: 1,
    value: 10,
    unit: " values",
    scale: "log" as const,
    group: "Label",
    help: "Distinct values of a high-cardinality label, such as request_id. One means the label is absent.",
    format: "count" as const,
  },
  {
    id: "retentionDays",
    label: "Retention",
    min: 7,
    max: 365,
    step: 7,
    value: 30,
    unit: " d",
    group: "Storage",
    help: "Days of samples kept on disk. Retention changes disk, not active series memory.",
    format: "number" as const,
  },
  {
    id: "queryHours",
    label: "Query window",
    min: 1,
    max: 24,
    step: 1,
    value: 1,
    unit: " h",
    group: "Query",
    help: "Time range scanned by a dashboard panel. A wider window scans more data per series.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  metricNames: number;
  hosts: number;
  labelValues: number;
  retentionDays: number;
  queryHours: number;
  series: number;
  memoryGB: number;
  diskGB: number;
  queryP95: number;
  seriesPerMetric: number;
  ingestSamples: number;
}

function compute(p: Params): Computed {
  const metricNames = Math.max(1, Math.round(num(p, "metricNames", 80)));
  const hosts = Math.max(1, Math.round(num(p, "hosts", 500)));
  const labelValues = Math.max(1, Math.round(num(p, "labelValues", 10)));
  const retentionDays = Math.max(1, Math.round(num(p, "retentionDays", 30)));
  const queryHours = Math.max(1, num(p, "queryHours", 1));
  const series = metricNames * hosts * labelValues;
  return {
    metricNames,
    hosts,
    labelValues,
    retentionDays,
    queryHours,
    series,
    memoryGB: (series * BYTES_PER_SERIES) / 1e9,
    diskGB: (series * SAMPLES_PER_DAY * retentionDays * BYTES_PER_SAMPLE) / 1e9,
    queryP95: 40 + series * Math.sqrt(queryHours) * 0.00008,
    seriesPerMetric: hosts * labelValues,
    ingestSamples: series / 15,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed): void {
  const seedKeys: [string, number][] = [
    ["active-series", values.series],
    ["index-memory", values.memoryGB],
    ["query-p95", values.queryP95],
    ["series-per-metric", values.seriesPerMetric],
    ["index-disk", values.diskGB],
  ];
  for (const [id, value] of seedKeys) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + id.length) / 3.1);
      return Math.max(0, value * (0.97 + 0.03 * wave));
    });
  }
}

function buildFrame(p: Params): SimFrame {
  const values = compute(p);
  const memoryHealth = healthFor(values.memoryGB, 80, 120);
  const queryHealth = healthFor(values.queryP95, 300, 1_200);
  return {
    t: 0,
    nodes: [
      {
        id: "instrumentation",
        label: "Instrumentation",
        kind: "client",
        health: healthFor(values.ingestSamples / INGEST_CAPACITY, 0.7, 0.85),
        utilization: clamp(values.ingestSamples / INGEST_CAPACITY),
        sublabel: `${Math.round(values.ingestSamples).toLocaleString()} samples/s`,
        detail: "Each unique label combination becomes a new series identity before the data reaches storage.",
        meta: { view: "flow" },
      },
      {
        id: "vminsert",
        label: "vminsert",
        kind: "stream",
        health: healthFor(values.ingestSamples / INGEST_CAPACITY, 0.7, 0.85),
        utilization: clamp(values.ingestSamples / INGEST_CAPACITY),
        sublabel: `${values.series.toLocaleString()} series`,
        detail: "The router hashes each series to a storage node; cardinality is spread across all of them.",
        meta: { view: "flow" },
      },
      {
        id: "index",
        label: "vmstorage index",
        kind: "storage",
        health: memoryHealth,
        utilization: clamp(values.memoryGB / MEMORY_CAPACITY_GB),
        sublabel: `${values.memoryGB.toFixed(1)}GB required / ${MEMORY_CAPACITY_GB}GB`,
        detail: `Index memory required: ${values.memoryGB.toFixed(1)}GB of the ${MEMORY_CAPACITY_GB}GB model capacity. The model assumes ${BYTES_PER_SERIES.toLocaleString()} bytes of index and series metadata per active series.`,
        meta: { view: "flow" },
      },
      {
        id: "vmselect",
        label: "vmselect",
        kind: "service",
        health: queryHealth,
        utilization: clamp(values.queryP95 / 1_200),
        sublabel: `p95 ${values.queryP95.toFixed(0)}ms`,
        detail: "A query scans matching series. More series means more index work and a longer merge.",
        meta: { view: "flow" },
      },
      {
        id: "dashboards",
        label: "Dashboards",
        kind: "service",
        health: queryHealth,
        utilization: clamp(values.queryP95 / 1_200),
        sublabel: `${values.queryHours}h window`,
        detail: "The panel may time out even though ingestion and retention are unchanged.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("instrumentation-insert", "instrumentation", "vminsert", clamp(values.ingestSamples / INGEST_CAPACITY)),
      edge("insert-index", "vminsert", "index", clamp(values.ingestSamples / INGEST_CAPACITY), memoryHealth),
      edge("index-select", "index", "vmselect", clamp(values.queryHours / 24), memoryHealth),
      edge("select-dashboard", "vmselect", "dashboards", clamp(values.queryHours / 24), queryHealth),
    ],
    metrics: [
      metric("active-series", "Active series", values.series, " series", 5_000_000, 12_000_000, "count"),
      metric("index-memory", "Index memory required", values.memoryGB, " GB", 80, 120, "number"),
      metric("query-p95", "Query p95", values.queryP95, "ms", 300, 1_200, "ms"),
      metric("series-per-metric", "Series per metric", values.seriesPerMetric, " /metric", 25_000, 50_000, "count"),
      metric("index-disk", "Sample storage", values.diskGB, " GB", 500, 1_000, "number"),
    ],
    events: [],
    series: {},
    flags: {},
    summary: `${values.series.toLocaleString()} active series, ${values.memoryGB.toFixed(1)}GB index memory, query p95 ${values.queryP95.toFixed(0)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "active-series",
    metricId: "active-series",
    warn: 5_000_000,
    crit: 12_000_000,
    title: "Active series crossed the cardinality budget",
    cause:
      "A label multiplied the number of unique metric, host, and label combinations. Each combination is a separate series with its own index entry.",
    fix:
      "Remove the high-cardinality label, or aggregate it away before ingestion. Keep only bounded labels on the metric and move identifiers to logs or traces.",
    checkFirst: [
      "Find the metric and label key with the largest series growth.",
      "Check whether the label value is a request, user, or session identifier.",
      "Compare the release history with the start of the growth.",
    ],
  },
  {
    id: "index-memory",
    metricId: "index-memory",
    warn: 80,
    crit: 120,
    title: "Index memory required exceeds capacity",
    cause:
      "Every active series needs index and metadata in memory. Cardinality raises memory even when the sample rate and retention are unchanged.",
    fix:
      "Reduce active series before adding memory. Add storage nodes only if the series count is justified; a bigger index for an unbounded label is still the wrong design.",
    checkFirst: [
      "Check per-node memory and series count.",
      "Check for a recent label or target change.",
      "Check whether a scrape relabel rule is adding an identifier.",
    ],
  },
  {
    id: "query-p95",
    metricId: "query-p95",
    warn: 300,
    crit: 1_200,
    title: "Queries are slow because they scan too many series",
    cause:
      "A wide query window over a large matching series set spends its time finding and merging series, not processing samples. Coarser retention does not reduce the series count.",
    fix:
      "Filter on a bounded label, shorten the window, or remove the high-cardinality dimension. Downsampling helps sample volume, not the number of matching series.",
    checkFirst: [
      "Check the series count matching the query.",
      "Check template variables and group-by labels.",
      "Compare the same query with and without the high-cardinality filter.",
    ],
  },
  {
    id: "series-per-metric",
    metricId: "series-per-metric",
    warn: 25_000,
    crit: 50_000,
    title: "One metric name carries too many series across the fleet",
    cause:
      "The label creates thousands of values per host, so a single metric consumes the index budget that many metrics should share.",
    fix:
      "Replace the label with a bounded dimension, or split the identifier-level question into traces. Set a per-metric series budget before the next release.",
    checkFirst: [
      "Rank metrics by series count.",
      "Check which dashboards need the label.",
      "Check whether the label can be dropped at scrape time.",
    ],
  },
  {
    id: "index-disk",
    metricId: "index-disk",
    warn: 500,
    crit: 1_000,
    title: "Sample storage is filling disk",
    cause:
      "Retention multiplies the samples stored per series. Cardinality multiplies the number of series, so the two together grow disk faster than either alone.",
    fix:
      "Reduce series first, then set retention from the audit requirement. Downsampling or tiering can reduce long-range storage without hiding the cardinality.",
    checkFirst: [
      "Compare disk growth with series growth and retention changes.",
      "Check per-node free space and read-only state.",
      "Check whether a retention change landed with the label change.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const cardinalityModel: SimModel = {
  id: "observability-victoriametrics-cardinality",
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
    if (values.memoryGB >= 120 && frame.flags.memoryEvent !== 1) {
      pushEvent(next, {
        id: "cardinality-memory-exhausted",
        at: frame.t,
        severity: "crit",
        title: "Cardinality exhausted the index",
        detail: `${values.series.toLocaleString()} active series need ${values.memoryGB.toFixed(0)}GB of index memory. Query p95 is ${values.queryP95.toFixed(0)}ms.`,
        nodeId: "index",
        metricId: "index-memory",
      });
      next.flags.memoryEvent = 1;
    }
    if (values.memoryGB < 120) next.flags.memoryEvent = 0;
    next.summary = `${values.series.toLocaleString()} active series, ${values.memoryGB.toFixed(1)}GB index memory, query p95 ${values.queryP95.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Series are ${values.metricNames} metric names x ${values.hosts.toLocaleString()} hosts x ${values.labelValues.toLocaleString()} label values = ${values.series.toLocaleString()}.`,
    );
    items.push(
      `At ${BYTES_PER_SERIES.toLocaleString()} bytes per active series, the index needs ${values.memoryGB.toFixed(1)}GB of the ${MEMORY_CAPACITY_GB}GB model capacity.`,
    );
    items.push(
      `Retention is ${values.retentionDays} days and the modeled disk footprint is ${values.diskGB.toFixed(0)}GB; retention changes disk, not the active series count.`,
    );
    items.push(
      `A ${values.queryHours}h query scans the matching set at p95 ${values.queryP95.toFixed(0)}ms. Reducing label values lowers both memory and query time.`,
    );
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
    description: "80 metric names, 500 hosts, and 10 bounded label values.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak cardinality",
    description: "3 million series from 100 metric names, 1,000 hosts, and 30 label values.",
    tone: "warn",
    params: defaults({ metricNames: 100, hosts: 1_000, labelValues: 30, queryHours: 6 }),
  },
  {
    id: "failure",
    label: "Request ID label",
    description: "20 million series. Index memory and query time both cross critical.",
    tone: "crit",
    params: defaults({ metricNames: 200, hosts: 2_000, labelValues: 50, retentionDays: 30, queryHours: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Drop the identifier label and keep the bounded dimensions.",
    tone: "ok",
    params: defaults({ metricNames: 80, hosts: 500, labelValues: 10, queryHours: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-cardinality-memory",
  title: "Predict what a request_id label does",
  simId: "vm-cardinality",
  question:
    "A metric has 200 names on 2,000 hosts. A release adds request_id with 50 values per host. What fails first?",
  prediction: {
    options: [
      { id: "memory", label: "Index memory and query time, because active series multiply" },
      { id: "disk-only", label: "Only disk, because each sample is larger" },
      { id: "ingest-only", label: "Only ingest CPU, because there are more samples" },
      { id: "nothing", label: "Nothing, because the label replaces the host tag" },
    ],
    correctOptionId: "memory",
    explanation:
      "A new label does not replace the host tag; it combines with it. The series count becomes metric names x hosts x label values. Every combination needs an index entry, so memory and query work grow even if the scrape rate is unchanged.",
  },
  setup: defaults({ metricNames: 200, hosts: 2_000, labelValues: 50, queryHours: 1 }),
  runFor: 20,
  observe: [
    "Active series rise from 400,000 to 20 million.",
    "Index memory rises from about 3.3GB to about 164GB, past the 120GB critical threshold.",
    "Query p95 rises from about 72ms to about 1.6s.",
    "Retention stays at 30 days; the memory failure is not a retention problem.",
  ],
  explain:
    "The label value is not functionally dependent on the host. The same host sees many request IDs, and the same ID can appear on several hosts. That makes every metric, host, and label value combination a new series. The index must hold an entry for each one, so memory and query scan grow with cardinality while sample volume per series can stay flat.",
  fix: defaults({ metricNames: 80, hosts: 500, labelValues: 10, queryHours: 1 }),
  debrief:
    "Removing the identifier label returns series to 400,000 and index memory to about 3.3GB. The product still needs per-request analysis, so the next step is traces or logs, where a request ID is a normal attribute rather than a metric identity. The tradeoff is a different query interface and retention budget, not a loss of the answer.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cardinality is the number of unique series in a metrics store. A series is a metric name plus a unique set of label values, including the host or instance label. Ten label values on one metric across one host create ten series. The same ten values across 1,000 hosts create 10,000. A label such as request_id, user_id, or session_id is effectively unbounded: every new value creates a new identity that the index must track.",
  },
  {
    type: "p",
    text: "High cardinality is not the same as high sample volume. You can scrape the same number of samples per second and still multiply the index by adding one label. VictoriaMetrics stores a per-series index entry and metadata in memory, so the active series count drives memory even when the samples are compressed efficiently on disk. It also drives query cost: the engine must find and merge every series that matches.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is instrumentation, vminsert, the vmstorage index, vmselect, then the dashboard. vminsert hashes each series to a storage node. Because the hash spreads values, a cardinality explosion fills every storage node together; there is no single hot shard to isolate. vmselect then has to scan the matching set, so a label that looked harmless at write time becomes a slow panel at read time.",
  },
  {
    type: "table",
    headers: ["Label", "Bounded?", "What it costs", "Better home"],
    rows: [
      ["region, env, status", "Yes, small fixed set", "A few combinations", "Metric label"],
      ["customer tier", "Yes, if the tier list is short", "A small multiplier", "Metric label or dashboard filter"],
      ["request_id, trace_id", "No", "One series per request", "Trace or log attribute"],
      ["user_id", "No", "One series per user per host", "Logs, traces, or a dedicated store"],
      ["raw URL or error message", "No", "Unbounded values and churn", "Logs or exemplars"],
    ],
  },
  {
    type: "p",
    text: "The model assumes 8KB of index and metadata per active series, 128GB of cluster memory, 5,760 samples per series per day, and 1.2 compressed bytes per sample. Those are teaching values, not VictoriaMetrics limits or sizing guidance. The shape is the point: series multiply by label values, memory follows active series, and query time follows the matching set.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Active series, with warning at 5 million and critical at 12 million.",
      "Index memory required in GB, shown against a 128GB model capacity with thresholds at 80GB and 120GB.",
      "Query p95 for the selected window, from tens of milliseconds to seconds.",
      "Series per metric name, which exposes one oversized metric before the cluster total moves.",
      "Sample storage, which separates retention growth from cardinality growth.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that 400,000 series need about 3.3GB. Apply Request ID label. Watch active series, index memory, query p95, and disk move. Then apply Recovery and change only label values to see memory and query time fall while retention stays fixed.",
  },
  {
    type: "p",
    text: "Disk and memory fail for different reasons. Retention raises disk per series; cardinality raises the number of series and the memory index. Fixing one does not fix the other, which is why the module tracks both.",
  },
  { type: "sim", simId: "vm-cardinality" },
  { type: "experiment", experimentId: "predict-cardinality-memory" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The request_id label multiplied 200 metric names across 2,000 hosts by 50 values per host, producing 20 million active series. At 8KB per series that needed about 164GB of index memory, past the 120GB critical threshold. Query p95 rose to about 1.6 seconds because the matching set was 50 times larger. The scrape rate and the 30-day retention did not change.",
  },
  {
    type: "p",
    text: "The recovery removed the identifier and returned to bounded dimensions. Series fell to 400,000 and memory to about 3.3GB. The disk metric also fell, but disk was a consequence of series count in this run, not the cause. That distinction matters when the first symptom is a full volume: adding disk to an unbounded label only buys time.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "vmstorage memory and per-node series count rising together, with no matching rise in scrape rate.",
      "Slow queries that scan a large matching set; the same query with a bounded filter is fast.",
      "A scrape configuration, relabel rule, or client library change that introduced an identifier as a label.",
      "Series churn: new label values appear continuously even when the active set looks stable.",
      "Disk growth that continues after retention is shortened because the series count is still climbing.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the metric and label key, then compare the active series count with the scrape rate. If series grew while samples per second did not, the label is the cause. Check the index memory and query matching set before adding storage nodes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the label at the source, or drop it in a relabel rule before ingestion.",
      "Replace it with a bounded dimension that answers the same product question, such as endpoint or status.",
      "Move identifier-level analysis to traces or logs, where high cardinality is expected.",
      "Set a per-metric series budget and alert on growth before the cluster memory is exhausted.",
      "Check that query filters and template variables do not expand to thousands of values.",
      "Verify memory, query p95, and disk after the change; a series drop should lower all three.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Dropping a label removes a dimension from every metric query that used it. Preserve the decision with a bounded label or a trace attribute.",
      "Aggregating away an identifier loses per-request detail. That is the point when the question is aggregate, and a problem when the question is individual.",
      "Adding memory or storage buys time but does not change the cardinality curve. It can make the next failure larger.",
      "Downsampling reduces sample volume and query work per series, but not the number of series. It will not rescue an unbounded label.",
      "A cardinality limit protects the cluster by dropping data; it must be paired with a signal that tells the team what was dropped.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "series-arithmetic",
    question:
      "A metric has 50 names, 800 hosts, and a label with 200 values. How many series, and what happens if the label is removed?",
    difficulty: 2,
    hints: [
      "Multiply names, hosts, and values.",
      "Removing a label removes its multiplier, not the hosts.",
    ],
    answer:
      "With the label, the shape is 50 x 800 x 200, or 8 million series. Without it, the shape is 50 x 800, or 40,000 series. The label multiplied the index by 200. I would confirm the actual fan-out rather than assume every value appears on every host, but the estimate is enough to see the order of magnitude. The memory and query consequences follow from the active series count.",
    followUps: [
      "What if each value appears on only five hosts?",
      "How would churn change the estimate?",
      "Which metric would you check after the change?",
    ],
    redFlags: [
      "Adds the three numbers.",
      "Forgets the host label.",
      "Treats sample rate as cardinality.",
    ],
    rubric: [
      "Multiplies the dimensions.",
      "Separates label multiplier from host count.",
      "Mentions measured fan-out.",
      "Names memory or query evidence.",
    ],
  },
  {
    id: "memory-or-disk",
    question:
      "Index memory is at 95% but disk is at 45%. Does adding disk help? What do you do?",
    difficulty: 2,
    hints: [
      "Active series live in the index, not only on disk.",
      "Adding disk does not reduce the series count.",
    ],
    answer:
      "No. Disk capacity does not reduce the in-memory index. The memory pressure comes from active series, so I would find the label or metric that grew and reduce the series count, or add memory if the series are justified. I would also check per-node balance and query load. Adding disk may be useful for retention later, but it does not address the current bottleneck.",
    followUps: [
      "When would adding memory be the right call?",
      "How would you find the responsible label?",
      "What does per-node balance tell you?",
    ],
    redFlags: [
      "Adds disk for a memory problem.",
      "Assumes retention causes memory.",
      "Ignores the label.",
    ],
    rubric: [
      "Separates memory from disk.",
      "Finds the series source.",
      "Considers justified growth.",
      "Checks balance.",
    ],
  },
  {
    id: "request-id",
    question:
      "Product wants to find requests from one user. Why is user_id a bad metric label, and what would you build?",
    difficulty: 3,
    hints: [
      "Metric labels are identities, not free-form attributes.",
      "The question is individual, not aggregate.",
    ],
    answer:
      "A user ID is unbounded and not functionally dependent on the host. Every user-host combination becomes a new series, and the index and query cost grow with the user base. I would keep metrics aggregated by bounded dimensions such as endpoint, region, status, and release, then send the user ID to traces or logs as a structured attribute. That lets the team find one user's requests without turning the metric store into a per-user index. If a per-user metric is genuinely required, I would use a small cohort or customer tier, not the raw ID.",
    followUps: [
      "How would you link a trace back to the metric?",
      "What retention would the user-level data need?",
      "When is a per-customer metric justified?",
    ],
    redFlags: [
      "Hashes the ID and calls it bounded.",
      "Keeps the label and samples it.",
      "Ignores access control on user data.",
    ],
    rubric: [
      "Explains unbounded identity.",
      "Moves the question to traces or logs.",
      "Names a bounded substitute.",
      "Considers retention and access.",
    ],
  },
  {
    id: "query-slow",
    question:
      "A dashboard query is slow only when a template variable is set to all. What is happening, and what is the fix?",
    difficulty: 3,
    hints: [
      "All means the query matches every series.",
      "The cost is the matching set, not the sample count.",
    ],
    answer:
      "The variable expands the query to every matching series, so vmselect has to find and merge a much larger set. The fix is to bound the variable, require a narrower default, or precompute a recording rule for the aggregate the dashboard actually needs. I would confirm the series count for the all case and compare it with a single-value query. Removing the high-cardinality label at ingestion is the durable fix if the variable is exposing it.",
    followUps: [
      "How would a recording rule change the cost?",
      "What default would you set?",
      "How do you keep the all view available for incidents?",
    ],
    redFlags: [
      "Adds query replicas without bounding the query.",
      "Blames the dashboard renderer.",
      "Ignores the series count.",
    ],
    rubric: [
      "Explains template expansion.",
      "Names the matching set.",
      "Uses a bounded variable or recording rule.",
      "Verifies series count.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Estimate series as metric names x hosts x label values for every new label.",
      "Reject labels that can take a request, user, session, or timestamp value.",
      "Set a per-metric series budget and a cluster cardinality alert.",
      "Check dashboards for template variables that can expand to all values.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the metric and label before adding memory or disk.",
      "Compare active series with scrape rate to separate cardinality from volume.",
      "Check per-node memory and query matching-set size.",
      "Drop the label at ingestion or relabeling if the change can be reversed quickly.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify memory, query p95, and disk all fall after the series drop.",
      "Move identifier-level analysis to traces or logs.",
      "Add a relabel safeguard so the key cannot return on another metric.",
      "Record the series estimate and the actual count in the review.",
    ],
  },
];

const references = [
  {
    title: "Cardinality",
    url: "https://docs.victoriametrics.com/victoriametrics/single-server-victoriametrics/#cardinality-limiter",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "Cardinality limits, series growth, and the effect on memory.",
  },
  {
    title: "Cluster version",
    url: "https://docs.victoriametrics.com/victoriametrics/cluster-victoriametrics/",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "vminsert, vmstorage, and vmselect responsibilities.",
  },
  {
    title: "Why IndexDB size is so large",
    url: "https://docs.victoriametrics.com/victoriametrics/faq/#why-indexdb-size-is-so-large",
    publisher: "VictoriaMetrics",
    kind: "docs" as const,
    note: "Index growth from high-churn and high-cardinality series.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vm-cardinality": {
      model: cardinalityModel,
      presets,
      instructions:
        "Start Healthy, then apply Request ID label. Watch active series, index memory, and query p95. Apply Recovery and change only the label value count to separate cardinality from retention.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 8KB per-series index cost, 128GB memory capacity, and compression assumptions are teaching values, not VictoriaMetrics limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-victoriametrics-architecture",
    "observability-victoriametrics-retention",
    "observability-datadog-tags",
    "observability-telemetry-cost",
  ],
};
