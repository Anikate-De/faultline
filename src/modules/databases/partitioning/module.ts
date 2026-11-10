import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "tableRows",
    label: "Table size",
    min: 10,
    max: 2_000,
    step: 10,
    value: 100,
    unit: "M rows",
    group: "Data",
    help: "Total rows before archiving. Larger tables make scans and maintenance longer, but row count alone does not decide the strategy.",
    format: "count" as const,
  },
  {
    id: "partitionCount",
    label: "Partitions",
    min: 1,
    max: 64,
    step: 1,
    value: 12,
    unit: "",
    group: "Layout",
    help: "How many partitions the logical table is split into. Partition pruning helps only when queries filter on the partition key.",
    format: "count" as const,
  },
  {
    id: "shardCount",
    label: "Shards",
    min: 1,
    max: 8,
    step: 1,
    value: 4,
    unit: "",
    group: "Layout",
    help: "How many independent writers hold the data. Sharding adds routing, cross-shard queries, and rebalancing work.",
    format: "count" as const,
  },
  {
    id: "hotShare",
    label: "Hot-slice traffic",
    min: 5,
    max: 80,
    step: 1,
    value: 20,
    unit: "%",
    group: "Workload",
    help: "Share of traffic that lands on the busiest value of the distribution key. Skew is what turns a balanced layout into a hot shard.",
    format: "percent" as const,
  },
  {
    id: "archivePercent",
    label: "Rows archived",
    min: 0,
    max: 90,
    step: 5,
    value: 40,
    unit: "%",
    group: "Data",
    help: "Old rows moved out of the hot table. Archiving reduces the working set without changing routing, but the data still has to live somewhere.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function status(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Computed {
  tableRows: number;
  partitionCount: number;
  shardCount: number;
  hotShare: number;
  archivePercent: number;
  activeRows: number;
  rowsPerShard: number;
  strategy: string;
  queryMs: number;
  hotCpu: number;
  maintenanceMin: number;
  shardHealth: Health;
}

function compute(p: Params): Computed {
  const tableRows = clamp(num(p, "tableRows", 100), 10, 2_000) * 1_000_000;
  const partitionCount = Math.round(clamp(num(p, "partitionCount", 12), 1, 64));
  const shardCount = Math.round(clamp(num(p, "shardCount", 4), 1, 8));
  const hotShare = clamp(num(p, "hotShare", 20), 5, 80);
  const archivePercent = clamp(num(p, "archivePercent", 40), 0, 90);
  const activeRows = tableRows * (1 - archivePercent / 100);
  const rowsPerShard = activeRows / shardCount;
  const pruning = partitionCount > 1 ? 0.35 : 1;
  const scanMs = 3 + rowsPerShard * pruning * 0.00002;
  const hotFactor = (hotShare / 100) * shardCount;
  const queryMs = scanMs * (0.3 + 0.7 * hotFactor) + (shardCount > 1 ? 6 : 0);
  const hotCpu = clamp(30 + hotShare * 0.8 + (rowsPerShard / 20_000_000) * 10, 0, 100);
  const maintenanceMin =
    shardCount > 1
      ? 2 + (tableRows / 1_000_000_000) * 4
      : partitionCount > 1
        ? 4 + (tableRows / 1_000_000_000) * 8
        : 30 + (tableRows / 1_000_000_000) * 180;
  const strategy = shardCount > 1 ? "sharded" : partitionCount > 1 ? "partitioned" : "single table";
  return {
    tableRows,
    partitionCount,
    shardCount,
    hotShare,
    archivePercent,
    activeRows,
    rowsPerShard,
    strategy,
    queryMs,
    hotCpu,
    maintenanceMin,
    shardHealth: status(hotCpu, 70, 90),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const visible = Math.min(values.shardCount, 8);
  for (let index = 0; index < visible; index++) {
    const cpu = index === 0 ? values.hotCpu : clamp(values.hotCpu * 0.55, 0, 100);
    const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7) + index) / 2.4);
    const key = `cpu.shard-${index + 1}`;
    frame.series[key] = Array.from({ length }, (_, point) => Math.max(0, cpu * jitter(point)));
  }
  frame.series.load = Array.from({ length }, (_, index) => Math.max(0, values.hotCpu * (0.95 + 0.05 * Math.sin(index / 2))));
  const metricRows: [string, number, number][] = [
    ["query-p95", values.queryMs, 0.5],
    ["hot-cpu", values.hotCpu, 0.2],
    ["maintenance-min", values.maintenanceMin, 0.1],
  ];
  for (const [id, value, amplitude] of metricRows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * (0.97 + 0.06 * Math.sin((index + (seed % 7)) / 2.4)) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const visible = Math.min(values.shardCount, 8);
  const nodes = Array.from({ length: visible }, (_, index) => {
    const cpu = index === 0 ? values.hotCpu : clamp(values.hotCpu * 0.55, 0, 100);
    const rows = values.rowsPerShard * (index === 0 ? 1 + values.hotShare / 100 : 1);
    return {
      id: `shard-${index + 1}`,
      label: values.shardCount === 1 ? "orders · single writer" : `orders · shard ${index + 1}`,
      kind: "db" as const,
      role: "shard" as const,
      health: status(cpu, 70, 90),
      utilization: clamp(cpu / 100),
      sublabel: `CPU ${Math.round(cpu)}% · ${formatCount(rows)} rows`,
      detail:
        index === 0
          ? "The hottest shard sets the capacity of the whole system. Adding shards does not help if the distribution key keeps sending this share to one node."
          : "A shard holds a disjoint slice of rows. Queries that route by the shard key stay local; queries that do not must fan out.",
      meta: {
        view: "shards",
        cpu: Number(cpu.toFixed(1)),
        memory: Number((32 + rows / 50_000_000 * 8).toFixed(1)),
        hot: index === 0 && cpu >= 70 ? 1 : 0,
        shard: index + 1,
      },
    };
  });
  return {
    t: 0,
    nodes,
    edges: [],
    metrics: [
      metric("query-p95", "Query p95", values.queryMs, " ms", 400, 900, "ms"),
      metric("hot-cpu", "Hot shard CPU", values.hotCpu, "%", 70, 90, "percent"),
      metric("maintenance-min", "Maintenance window", values.maintenanceMin, " min", 10, 30, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.strategy}; ${formatCount(values.tableRows)} rows before archive; p95 ${values.queryMs.toFixed(
      0,
    )} ms; hot shard ${Math.round(values.hotCpu)}% CPU.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-latency",
    metricId: "query-p95",
    warn: 400,
    crit: 900,
    title: "A scan or cross-shard query dominates latency",
    cause:
      "The query touches too many rows on one node, or it must fan out across shards. Partitioning helps only when the predicate prunes partitions; sharding helps only when the query routes by the shard key.",
    fix:
      "Route by the shard key, add the partition key to the predicate, or archive cold rows. If the query inherently spans shards, redesign it as an aggregate or move it to an analytical store.",
    checkFirst: [
      "Check whether the predicate includes the partition or shard key.",
      "Compare rows scanned with rows returned for one query.",
      "Check whether the hot shard's latency is much worse than the others.",
    ],
  },
  {
    id: "hot-shard",
    metricId: "hot-cpu",
    warn: 70,
    crit: 90,
    title: "One shard carries the workload",
    cause:
      "Traffic is concentrated on one value of the distribution key. Adding shards increases total capacity but leaves the hottest node saturated, so the system's ceiling does not move.",
    fix:
      "Split the hot key or isolate the tenant, change the distribution key, or add a dedicated node for the hot slice. Measure the fan-out cost before choosing.",
    checkFirst: [
      "Rank shards by CPU and write volume, not by row count.",
      "Check the top keys in the hot shard and their share of traffic.",
      "Check whether a single tenant or time range is responsible.",
    ],
  },
  {
    id: "maintenance-window",
    metricId: "maintenance-min",
    warn: 10,
    crit: 30,
    title: "Maintenance requires a long exclusive window",
    cause:
      "A single large table must be vacuumed, indexed, or rebuilt as one object. Partitioning breaks that work into per-partition operations, but only if the table is actually partitioned and old partitions can be detached or dropped.",
    fix:
      "Partition by time or another maintenance key, operate on one partition at a time, and detach or archive old partitions instead of deleting rows from the whole table.",
    checkFirst: [
      "Check whether maintenance is blocked by one table or one index.",
      "Check whether old partitions can be detached without a long lock.",
      "Measure the maintenance time on the largest partition, not the whole table.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const partitioningModel: SimModel = {
  id: "databases-partitioning",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const base = defaults();
    const frame = buildFrame(base, seed);
    seedSeries(frame, compute(base), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.hotCpu >= 90 && frame.flags.hotShardLogged !== 1) {
      pushEvent(next, {
        id: "hot-shard",
        severity: "crit",
        title: "Hot shard is saturated",
        detail: `${values.hotShare}% of traffic lands on one slice. The hottest shard is at ${Math.round(
          values.hotCpu,
        )}% CPU while the layout has ${values.shardCount} shard${values.shardCount === 1 ? "" : "s"}.`,
        nodeId: "shard-1",
        metricId: "hot-cpu",
      });
    }
    if (values.maintenanceMin >= 30 && frame.flags.maintenanceLogged !== 1) {
      pushEvent(next, {
        id: "maintenance-window",
        severity: "crit",
        title: "Maintenance requires a long exclusive window",
        detail: `${formatCount(values.tableRows)} rows in a ${values.strategy} layout need about ${Math.round(
          values.maintenanceMin,
        )} minutes of maintenance.`,
        metricId: "maintenance-min",
      });
    }
    if (values.shardCount === 1 && values.rowsPerShard > 30_000_000 && frame.flags.singleWriterLogged !== 1) {
      pushEvent(next, {
        id: "single-writer",
        severity: "warn",
        title: "One writer holds the entire active set",
        detail: `${formatCount(
          values.rowsPerShard,
        )} active rows sit on one node. Partitioning can reduce maintenance scope but does not split write capacity.`,
        nodeId: "shard-1",
        metricId: "query-p95",
      });
    }
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.hotShardLogged = values.hotCpu >= 90 ? 1 : 0;
    next.flags.maintenanceLogged = values.maintenanceMin >= 30 ? 1 : 0;
    next.flags.singleWriterLogged =
      values.shardCount === 1 && values.rowsPerShard > 30_000_000 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.strategy}; ${formatCount(values.tableRows)} rows before archive; p95 ${values.queryMs.toFixed(
      0,
    )} ms; hot shard ${Math.round(values.hotCpu)}% CPU.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The layout is ${values.strategy} with ${values.partitionCount} partition${
        values.partitionCount === 1 ? "" : "s"
      } and ${values.shardCount} writer${values.shardCount === 1 ? "" : "s"}. The active set is ${formatCount(
        values.activeRows,
      )} rows across ${values.shardCount} node${values.shardCount === 1 ? "" : "s"}.`,
      values.hotShare >= 30
        ? `${values.hotShare}% of traffic lands on the hottest slice. The hot shard is at ${Math.round(
            values.hotCpu,
          )}% CPU, so capacity is set by that node, not by the total shard count.`
        : `Traffic is reasonably spread at ${values.hotShare}% on the hottest slice. The hot shard is at ${Math.round(
            values.hotCpu,
          )}% CPU.`,
      `Maintenance needs about ${values.maintenanceMin.toFixed(
        1,
      )} minutes. Partitioning helps this number; sharding also helps it by making each node smaller.`,
      "Partitioning splits one logical table for maintenance and pruning. It does not create a second writer.",
      "Sharding splits writers, but every query must route or fan out, and rebalancing becomes an operational project.",
    ];
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
    description: "Twelve partitions and four shards spread 100 million rows with moderate traffic. Queries and maintenance stay healthy.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak growth",
    description: "Three hundred million rows and eight shards, but 40 percent of traffic hits one slice. The hot shard and query latency warn.",
    tone: "warn",
    params: defaults({ tableRows: 300, partitionCount: 24, shardCount: 8, hotShare: 40 }),
  },
  {
    id: "failure",
    label: "Single writer",
    description: "Eight hundred million rows in one table on one writer, with 70 percent of traffic on one slice. Query latency, CPU, and maintenance all breach.",
    tone: "crit",
    params: defaults({ tableRows: 800, partitionCount: 1, shardCount: 1, hotShare: 70, archivePercent: 10 }),
  },
  {
    id: "partitioned",
    label: "Partitioned only",
    description: "The table is partitioned for maintenance, but one writer still holds the active set. Queries improve; write capacity does not.",
    tone: "warn",
    params: defaults({ tableRows: 100, partitionCount: 24, shardCount: 1, hotShare: 20, archivePercent: 50 }),
  },
  {
    id: "recovery",
    label: "Sharded and archived",
    description: "Eight shards, 24 partitions, and 70 percent of cold rows archived. Queries, hot-shard CPU, and maintenance return to healthy.",
    tone: "ok",
    params: defaults({ tableRows: 400, partitionCount: 24, shardCount: 8, hotShare: 15, archivePercent: 70 }),
  },
];

const experiment: Experiment = {
  id: "predict-partition-or-shard",
  title: "Predict the split that fixes the bottleneck",
  simId: "partitioning",
  question:
    "An orders table has 800 million rows, one writer, and 70 percent of traffic concentrated on one slice. Queries are slow and the maintenance window is hours. What addresses the bottleneck?",
  prediction: {
    options: [
      {
        id: "shard",
        label: "Shard by a key that spreads the hot slice, accepting routing and cross-shard query cost.",
      },
      {
        id: "partition",
        label: "Partition by date only; one writer is enough, and queries will route themselves.",
      },
      {
        id: "archive",
        label: "Archive old rows only; the hot slice and write capacity are unaffected.",
      },
      {
        id: "instance",
        label: "Use a larger instance; the layout and traffic distribution do not matter.",
      },
    ],
    correctOptionId: "shard",
    explanation:
      "The bottleneck is both the single writer and the skew. Partitioning by date can shorten maintenance and prune old data, but all writes still land on one node. Sharding splits writers, but it helps only if the key spreads the hot slice; otherwise the hot shard stays saturated. Archiving alone reduces rows but leaves the distribution and the writer unchanged.",
  },
  setup: defaults({ tableRows: 800, partitionCount: 1, shardCount: 1, hotShare: 70, archivePercent: 10 }),
  runFor: 20,
  observe: [
    "Query p95 is about 11,400 ms with one writer and 70 percent hot traffic.",
    "The hot shard is at 100 percent CPU and crosses the critical line.",
    "The maintenance window is about 174 minutes.",
    "The single shard card is marked hot and failing.",
    "Partitioning alone lowers the scan and maintenance numbers but leaves one writer and a hot node.",
  ],
  explain:
    "Partitioning changes how one table is organized for maintenance and pruning; it does not add a writer. Sharding adds writers, but only a key that distributes the hot slice reduces the hottest node. The correct answer depends on which constraint is binding: maintenance scope, write capacity, or the concentration of traffic.",
  fix: defaults({ tableRows: 800, partitionCount: 24, shardCount: 8, hotShare: 15, archivePercent: 85 }),
  debrief:
    "Eight shards with a key that spreads the hot slice, 24 partitions, and archived cold rows reduce query p95 to about 129 ms and hot-shard CPU to about 50 percent. The trade is routing: every query must carry the shard key, and any query that does not must fan out or move to an analytical store.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Partitioning splits one logical table into smaller physical tables inside one database. Queries that filter on the partition key can prune to one or a few partitions, and maintenance can operate on one partition at a time. The table is still one writer and one transaction domain.",
  },
  {
    type: "p",
    text: "Sharding splits rows across independent databases or writers. Each shard owns a disjoint slice, so write capacity grows with the number of shards. The cost is routing: every query must know which shard to use, queries without the shard key must fan out, and transactions and unique constraints become harder. Rebalancing is an operational project, not a configuration change.",
  },
  {
    type: "p",
    text: "Archiving removes cold rows from the hot table. It reduces scan size and maintenance scope, but it does not change the number of writers or the distribution of live traffic. All three options can be used together, and each solves a different constraint.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The layout sits between the application's routing layer and the storage nodes. The application chooses a shard key, the router maps keys to shards, and each shard may partition its own tables by time. Maintenance and backups run per shard. A query either routes to one shard, fans out to all shards, or is served from an aggregate store built for cross-shard access.",
  },
  {
    type: "compare",
    leftTitle: "Partitioning",
    rightTitle: "Sharding",
    rows: [
      { label: "Writers", left: "One database writer", right: "One writer per shard" },
      { label: "Maintenance", left: "Per partition", right: "Per shard, plus rebalancing" },
      { label: "Query routing", left: "Planner prunes partitions", right: "Application or router chooses a shard" },
      { label: "Cross-partition query", left: "Normal SQL across partitions", right: "Fan-out or a separate aggregate path" },
      { label: "Failure domain", left: "One database", right: "One shard at a time, if routing handles it" },
    ],
  },
  {
    type: "table",
    headers: ["Symptom", "First option", "Why"],
    rows: [
      ["Maintenance takes hours and blocks writes", "Partition by time or maintenance key", "Operate on one partition; detach old data"],
      ["One writer is CPU-bound at peak", "Shard by a key that spreads writes", "Partitioning does not add write capacity"],
      ["One tenant or key gets most traffic", "Split the hot key or isolate it", "More shards do not fix skew"],
      ["Historical rows are rarely read", "Archive or detach old partitions", "Shrinks the active working set"],
      ["Queries span many keys", "Keep one database or use an aggregate store", "Cross-shard fan-out adds latency and complexity"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Per-shard CPU and rows, so the hottest node is visible rather than hidden by an average.",
      "Query p95, including the routing overhead when more than one shard exists.",
      "Hot-slice traffic, the input that turns a balanced layout into a hot shard.",
      "Maintenance window, which shows what partitioning can fix and sharding can also reduce.",
      "Partition and shard counts you can change independently, so the two mechanisms stay distinct.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that four shards and twelve partitions keep the hot shard below its warning line. Apply Partitioned only: maintenance improves but one writer still holds the active set. Then apply Single writer to see query latency and CPU breach. Set eight shards and lower hot-slice traffic to see recovery. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Row counts, latencies, and thresholds are illustrative teaching values. Real shard capacity depends on the key distribution, query mix, and the cost of cross-shard operations.",
  },
  { type: "sim", simId: "partitioning" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With 800 million rows, one writer, and 70 percent of traffic on one slice, query p95 reached about 11,400 ms, the hot shard hit 100 percent CPU, and maintenance needed about 174 minutes. Partitioning the same table would have shortened maintenance and pruned scans, but every write would still land on one node. The hot slice would still saturate it.",
  },
  {
    type: "p",
    text: "Eight shards, 24 partitions, and 70 percent of cold rows archived brought query p95 to about 129 ms, hot-shard CPU to about 50 percent, and maintenance to under four minutes. The shard key had to spread the hot slice; with 70 percent concentration, more shards alone would not have helped.",
  },
  {
    type: "p",
    text: "The cost moved rather than disappeared. Queries now need the shard key to route. Queries without it fan out, and cross-shard transactions or unique constraints need a different design. The operational model also changed: backups, schema changes, and rebalancing now happen per shard.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-shard CPU, disk, and write volume, ranked by hottest rather than averaged.",
      "Top keys or tenants by request count and rows written, to expose skew.",
      "Query latency split into routed and fan-out queries.",
      "Maintenance duration per partition and per shard, not just for the logical table.",
      "Replication lag and backup time per shard, which become independent failure domains.",
      "Cross-shard query counts and their p95, the cost of the new layout.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Rank shards by CPU and writes before adding another one. If one node is hot, the key distribution is the problem, not the shard count. Then check whether maintenance time is dominated by one table or one index; that is the case partitioning actually solves.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Name the binding constraint: maintenance scope, write capacity, scan size, or cross-shard query cost.",
      "For maintenance and pruning, partition by time or another key that appears in the dominant predicates.",
      "For write capacity, shard by a key with high cardinality and even distribution; verify the top-key share before migrating.",
      "Isolate a hot tenant or key onto its own shard before splitting the key, if the business allows it.",
      "Archive or detach cold partitions instead of deleting rows from the whole table.",
      "Route queries by the shard key and keep a separate path for cross-shard aggregates.",
      "Plan rebalancing, backups, schema changes, and failure handling per shard before the first production write.",
      "Measure fan-out query latency and cost after the split; a layout that fixes writes can make reads worse.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Partitioning improves maintenance and pruning with far less application change, but it does not add write capacity.",
      "Sharding adds writers but introduces routing, cross-shard queries, distributed transactions, and rebalancing.",
      "Archiving reduces the active set but needs a retention policy and a place for the cold data.",
      "A shard key that spreads writes may make the most common read fan out; the key must match the access pattern.",
      "More shards mean more failure domains and more operational work, even when each one is smaller.",
      "A larger instance can postpone the decision, but it does not change skew or the maintenance model.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-layout",
    question:
      "A table has grown to hundreds of millions of rows. How do you decide between partitioning, sharding, and archiving?",
    difficulty: 3,
    hints: [
      "Name the constraint before the technology.",
      "Each option solves a different problem.",
    ],
    answer:
      "I would start from the binding constraint. If maintenance and scans are the problem and one writer still has headroom, partitioning by a key used in the dominant predicates plus archiving cold rows is usually enough. If write throughput or storage per node is the limit, sharding is the only option that adds writers, and it brings routing and cross-shard costs. If the table is large mostly because of history, archiving or detaching old partitions may solve it without changing the write path. I would measure the top-key distribution before choosing a shard key, because skew can make a sharded layout behave like the single table it replaced.",
    followUps: [
      "What would make you choose both partitioning and sharding?",
      "How does the query mix change the answer?",
      "What would you do first if you had one week?",
    ],
    redFlags: [
      "Shards by default.",
      "Chooses partitioning to add write capacity.",
      "Ignores archive and retention.",
    ],
    rubric: [
      "Starts from the constraint.",
      "Distinguishes maintenance from write capacity.",
      "Considers archive and query mix.",
      "Checks key distribution.",
    ],
  },
  {
    id: "hot-partition",
    question: "One partition receives 60 percent of writes and its disk is filling. What do you do?",
    difficulty: 3,
    hints: [
      "Adding partitions does not move traffic.",
      "The hot key may be a tenant or a time range.",
    ],
    answer:
      "I would first identify whether the hot partition is one tenant, one key range, or a time-based partition that is simply current. If it is one tenant, I would consider isolating that tenant on its own shard or splitting the key. If it is the current time partition, I would check whether the retention or partition interval is too coarse and whether the writes can be spread. Adding more partitions alone will not move traffic. I would also check whether the disk pressure is from writes, bloat, or an index before changing the layout.",
    followUps: [
      "What if the hot tenant cannot be moved?",
      "How would you split a hot key without downtime?",
      "How do you verify the fix reduced skew?",
    ],
    redFlags: [
      "Adds partitions and expects the hot spot to move.",
      "Moves the tenant without measuring cross-shard queries.",
      "Confuses disk usage with write rate.",
    ],
    rubric: [
      "Identifies the hot key or tenant.",
      "Proposes isolation or key split.",
      "Explains why extra partitions do not help.",
      "Checks disk cause before layout change.",
    ],
  },
  {
    id: "shard-key",
    question: "How do you choose a shard key for an orders table?",
    difficulty: 4,
    hints: [
      "Distribution and routing are different requirements.",
      "The key should appear in the dominant queries.",
    ],
    answer:
      "I would list the dominant queries and the write distribution first. The key needs high enough cardinality to spread writes and a distribution that avoids a single hot tenant or time range. It also needs to appear in the queries that must stay single-shard, so routing is possible without fan-out. For orders, `tenant_id` is often a better key than `order_id` because it keeps a tenant's orders together, but it concentrates a large tenant. I would test the top-key share, define a plan for cross-shard queries, and check how rebalancing would work before committing.",
    followUps: [
      "What breaks if you shard by order date?",
      "How do you handle a global unique order number?",
      "What is the cost of changing the key later?",
    ],
    redFlags: [
      "Chooses a random or hash key without checking queries.",
      "Ignores hot tenants.",
      "Has no rebalancing plan.",
    ],
    rubric: [
      "Checks cardinality and skew.",
      "Matches the key to dominant queries.",
      "Addresses cross-shard access.",
      "Plans rebalancing and uniqueness.",
    ],
  },
  {
    id: "shard-cost",
    question: "What breaks when you move from one database to sharded databases?",
    difficulty: 3,
    hints: [
      "Think beyond query routing.",
      "Think about transactions, constraints, and operations.",
    ],
    answer:
      "Queries without the shard key must fan out, which adds latency and cost. Cross-shard transactions lose the single-database atomic commit and need a saga or two-phase approach. Unique constraints that were global become per-shard unless you keep a separate registry. Joins become application-side or require co-locating related data on the same key. Operationally, backups, schema changes, monitoring, and rebalancing now happen per shard, and a single slow shard can dominate the tail. I would plan those costs before the migration, not after.",
    followUps: [
      "How would you keep a global unique constraint?",
      "What is the blast radius of one shard failure?",
      "How do you run a schema change across shards safely?",
    ],
    redFlags: [
      "Says sharding is transparent.",
      "Forgets cross-shard transactions.",
      "Assumes global indexes are free.",
    ],
    rubric: [
      "Names fan-out queries.",
      "Discusses distributed transactions.",
      "Addresses global constraints.",
      "Covers per-shard operations.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The dominant queries and their partition or shard keys are documented.",
      "Top-key and top-tenant distributions are measured, not assumed.",
      "Retention and archive policy exist for cold rows.",
      "Maintenance time is measured per partition and per shard.",
      "Cross-shard query count and latency are tracked separately.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Rank nodes by CPU and write volume to find the hot shard.",
      "Check whether the predicate includes the routing key.",
      "Check whether maintenance is blocked by one table or index.",
      "Compare the cost of isolating a hot tenant with changing the key.",
      "Measure fan-out latency before adding more shards.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Document the chosen key and the queries it supports.",
      "Add skew and hot-shard alerts, not only average utilization.",
      "Test rebalancing, backup, and schema changes per shard.",
      "Review archive and retention against the new layout.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Table Partitioning",
    url: "https://www.postgresql.org/docs/current/ddl-partitioning.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Declarative partitioning, partition pruning, and maintenance per partition.",
  },
  {
    title: "AWS: Sharding with Amazon Relational Database Service",
    url: "https://aws.amazon.com/blogs/database/sharding-with-amazon-relational-database-service/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Shard-key selection, routing, and the operational tradeoffs of sharding a relational database.",
  },
  {
    title: "Best practices for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Operational guidance for monitoring, maintenance, and capacity on Aurora.",
  },
  {
    title: "PostgreSQL: Performance Tips",
    url: "https://www.postgresql.org/docs/current/performance-tips.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Scan cost, table size, and maintenance considerations that motivate partitioning.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    partitioning: {
      model: partitioningModel,
      presets,
      instructions:
        "Start healthy, apply Partitioned only, then Single writer. Add shards without changing the hot-slice share, then lower the share and archive cold rows to recover.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Row counts, latencies, and thresholds are teaching values, not capacity guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-hot-partitions",
    "databases-vacuum-bloat",
    "databases-query-plans",
    "databases-n-plus-one",
    "databases-rds-aurora-arch",
  ],
};
