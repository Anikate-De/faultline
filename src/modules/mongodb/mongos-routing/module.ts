import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 4;
const SHARD_CAPACITY_OPS = 8_000;
const ROUTER_BASE_QPS = 15_000;
const MERGE_ROW_CAPACITY = 3_000_000;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "queryRate",
    label: "Query rate through mongos",
    min: 1_000,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " q/s",
    group: "Traffic",
    help: "Queries arriving at the router tier. The capacity figures behind this model are illustrative teaching values, not MongoDB limits.",
    format: "rps",
  },
  {
    id: "targetedShare",
    label: "Queries that include the shard key",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Query shape",
    help: "Share of queries whose predicate lets mongos target the owning shard. The rest are broadcast to all four shards.",
    format: "percent",
  },
  {
    id: "resultRows",
    label: "Rows returned per query",
    min: 10,
    max: 5_000,
    step: 10,
    value: 50,
    unit: " rows",
    group: "Query shape",
    help: "Total rows the client receives. Wide results make mongos merge, buffer, and serialize more data even when the query is targeted.",
    format: "count",
  },
  {
    id: "routerCount",
    label: "mongos routers",
    min: 1,
    max: 4,
    step: 1,
    value: 2,
    unit: "",
    group: "Topology",
    help: "Routers sharing client traffic. mongos is stateless, so more routers add routing and merge capacity, but they do not reduce the shards one query touches.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  queryRate: number;
  targetedShare: number;
  resultRows: number;
  routerCount: number;
  fanout: number;
  perShardOps: number;
  shardUtil: number;
  shardCpu: number;
  routerUtil: number;
  routerCpu: number;
  shardExecMs: number;
  mergeMs: number;
  streamMs: number;
  p99: number;
  mergeShare: number;
  mongosHealth: Health;
  shardHealth: Health;
  clientHealth: Health;
}

function compute(p: Params): Computed {
  const queryRate = clamp(num(p, "queryRate", 4_000), 0, 20_000);
  const targetedShare = clamp(num(p, "targetedShare", 90), 0, 100);
  const resultRows = clamp(num(p, "resultRows", 50), 10, 5_000);
  const routerCount = Math.round(clamp(num(p, "routerCount", 2), 1, 4));
  const scatterShare = 1 - targetedShare / 100;
  const fanout = 1 + scatterShare * (SHARD_COUNT - 1);
  const perShardOps = (queryRate * fanout) / SHARD_COUNT;
  const shardUtilRaw = perShardOps / SHARD_CAPACITY_OPS;
  const shardUtil = clamp(shardUtilRaw, 0, 0.97);
  const shardExecMs = 2 + (45 * shardUtil) / (1 - shardUtil);

  const routerLoad =
    queryRate / (routerCount * ROUTER_BASE_QPS) +
    (queryRate * resultRows) / (routerCount * MERGE_ROW_CAPACITY);
  const routerUtil = clamp(routerLoad, 0, 0.97);
  const mergeBase = 1 + 0.015 * resultRows * (1 + 0.12 * (fanout - 1));
  const mergeMs = mergeBase * (1 + 2 * routerUtil);
  const streamMs = 0.8 * (fanout - 1);
  const p99 = Math.min(MAX_P99_MS, shardExecMs + mergeMs + streamMs);
  const mergeShare = p99 > 0 ? ((mergeMs + streamMs) / p99) * 100 : 0;

  const mongosHealth: Health = routerLoad >= 0.9 ? "crit" : routerLoad >= 0.7 ? "warn" : "ok";
  const shardHealth: Health = shardUtilRaw >= 0.95 ? "crit" : shardUtilRaw >= 0.75 ? "warn" : "ok";
  const clientHealth: Health = p99 >= 120 ? "crit" : p99 >= 50 ? "warn" : "ok";

  return {
    queryRate,
    targetedShare,
    resultRows,
    routerCount,
    fanout,
    perShardOps,
    shardUtil,
    shardCpu: Math.min(shardUtilRaw, 1.2) * 100,
    routerUtil,
    routerCpu: clamp(routerLoad, 0, 1) * 100,
    shardExecMs,
    mergeMs,
    streamMs,
    p99,
    mergeShare,
    mongosHealth,
    shardHealth,
    clientHealth,
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const shards: SimNode[] = Array.from({ length: SHARD_COUNT }, (_, index) => ({
    id: `shard-${index}`,
    label: `Shard ${index}`,
    kind: "db" as const,
    role: "shard" as const,
    health: values.shardHealth,
    utilization: clamp(values.shardUtil),
    throughput: values.perShardOps,
    sublabel: `${Math.round(values.perShardOps).toLocaleString()} ops/s · ${values.shardCpu.toFixed(0)}% CPU`,
    detail:
      "A shard is a replica set that stores a subset of the collection. It executes the query against local data and returns its rows to mongos. A healthy shard can still be part of a slow query when the router must merge many streams.",
    meta: { view: "flow", cpu: values.shardCpu },
  }));

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: values.clientHealth,
      sublabel: `${Math.round(values.queryRate).toLocaleString()} q/s · p99 ${values.p99.toFixed(0)}ms`,
      detail:
        "The application connects to mongos and receives one merged cursor. It never chooses a shard; server selection and fan-out happen inside the cluster.",
      meta: { view: "flow" },
    },
    {
      id: "mongos",
      label: "mongos",
      kind: "service",
      health: values.mongosHealth,
      utilization: clamp(values.routerUtil),
      throughput: values.queryRate,
      sublabel: `${values.fanout.toFixed(1)} shards/query · ${values.routerCpu.toFixed(0)}% util`,
      detail:
        "mongos parses the query, reads cached chunk metadata, sends the request to the targeted shards, and merges the responses. With a wide or untargeted query, this merge and serialization work becomes the bottleneck.",
      meta: { view: "flow" },
    },
    {
      id: "config",
      label: "Config servers",
      kind: "db",
      role: "replica",
      health: "ok",
      sublabel: "CSRS · cached routing metadata",
      detail:
        "The config server replica set (CSRS) stores chunk ranges and shard metadata. mongos caches that metadata and refreshes it when routing changes. Config servers are not a data-bearing hop for each query.",
      meta: { view: "flow" },
    },
    ...shards,
  ];

  const edges = [
    edge("client-mongos", "client", "mongos", values.queryRate / 20_000, values.clientHealth),
    edge("mongos-config", "mongos", "config", 0.1, "ok", "metadata"),
    ...shards.map((shard) =>
      edge(
        `mongos-${shard.id}`,
        "mongos",
        shard.id,
        values.perShardOps / SHARD_CAPACITY_OPS,
        values.shardHealth,
      ),
    ),
  ];

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("mongos-p99", "Query p99 through mongos", values.p99, "ms", 50, 120, "ms"),
      metric("shards-touched", "Shards touched per query", values.fanout, "", 2, 3.5, "number"),
      metric("merge-share", "Latency spent merging at mongos", values.mergeShare, "%", 30, 50, "percent"),
      metric("router-util", "Busiest router utilization", values.routerCpu, "%", 70, 90, "percent"),
      metric("shard-cpu", "Busiest shard CPU", values.shardCpu, "%", 75, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${Math.round(values.queryRate).toLocaleString()} q/s through ${values.routerCount} mongos; ${values.fanout.toFixed(1)} shards per query; merge is ${values.mergeShare.toFixed(0)}% of p99.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.03 * Math.sin((index + (seed % 7)) / 2.3);
  const rows: [string, number][] = [
    ["mongos-p99", values.p99],
    ["shards-touched", values.fanout],
    ["merge-share", values.mergeShare],
    ["router-util", values.routerCpu],
    ["shard-cpu", values.shardCpu],
  ];
  for (const [id, value] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  for (const node of frame.nodes.filter((item) => item.role === "shard")) {
    frame.series[`cpu.${node.id}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, Number(node.meta?.cpu ?? 0) * jitter(index)),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "mongos-p99",
    metricId: "mongos-p99",
    warn: 50,
    crit: 120,
    title: "The router is inflating the query tail",
    cause:
      "Requests are waiting behind routing, merge, and serialization work at mongos. Fan-out and a wide result set add streams and rows to combine, so the router can slow down while every shard still has CPU headroom.",
    fix:
      "Read the sharded explain plan and compare the query through mongos with the same predicate on one shard. Cut fan-out by including the shard key, or cut rows with projection and pagination. Add routers only after the per-query merge work is understood.",
    checkFirst: [
      "Run `explain(\"executionStats\")` and look for `SHARD_MERGE` and the shards listed.",
      "Compare mongos CPU and network egress with per-shard CPU for the same window.",
      "Compare the query shape through mongos with a direct run against one shard.",
    ],
  },
  {
    id: "shards-touched",
    metricId: "shards-touched",
    warn: 2,
    crit: 3.5,
    title: "Queries reach more than one shard",
    cause:
      "The predicate cannot be bounded by the shard key, so mongos has to send the query to every shard and then combine the streams. Each extra shard adds a request, a result stream, and tail latency.",
    fix:
      "Add the shard key to the predicate when the product allows it, or accept the fan-out as a known cost and bound the result set. Check the explain plan for the shards contacted before changing cluster size.",
    checkFirst: [
      "List the top query shapes and whether each includes the shard key prefix.",
      "Check the collection's shard key and the predicates used by the slow endpoint.",
      "Check whether the query is a point lookup, a range scan, or a report.",
    ],
  },
  {
    id: "merge-share",
    metricId: "merge-share",
    warn: 30,
    crit: 50,
    title: "Merge work dominates the query",
    cause:
      "Most of the modeled p99 is spent after the shards respond: mongos merges result streams, applies the global sort and limit, and serializes batches back to the driver. Wide projections and broadcast queries make this the largest component.",
    fix:
      "Reduce the rows and fields that leave the shards. Project only needed fields, paginate, and make sure the sort is supported by the shard key or an index. If the query must return a wide report, route it to a dedicated path instead of the interactive one.",
    checkFirst: [
      "Check rows returned and bytes per query, not only query count.",
      "Check whether `merge-share` is high while shard CPU is normal.",
      "Check the projection, sort, and limit in the exact query shape.",
    ],
  },
  {
    id: "router-util",
    metricId: "router-util",
    warn: 70,
    crit: 90,
    title: "The router tier is saturated",
    cause:
      "One or more mongos processes are doing too much routing and merge work for their share of client traffic. A single router, a wide result set, or many broadcast queries can saturate the tier even when the shards are comfortable.",
    fix:
      "Add mongos routers, confirm clients spread connections across them, and reduce per-query fan-out and result width. Do not add shards to fix a router that is merging the same rows faster than the cluster can deliver them.",
    checkFirst: [
      "Compare utilization across all mongos instances.",
      "Check client connection distribution and load balancing.",
      "Check whether router saturation tracks a specific query shape or all traffic.",
    ],
  },
  {
    id: "shard-cpu",
    metricId: "shard-cpu",
    warn: 75,
    crit: 95,
    title: "A shard is near its execution limit",
    cause:
      "The shard is doing too much storage or execution work for its share of the query. This is a different failure from router merge pressure and usually points at a hot range, an index gap, or an undersized shard.",
    fix:
      "Check the shard's slow queries and index coverage. If every shard is similarly busy because of fan-out, address targeting first; if one shard is the outlier, look for a hot chunk or a missing index.",
    checkFirst: [
      "Compare CPU across shards to separate a hotspot from a broadcast.",
      "Check the shard's slow-query log and index usage.",
      "Check whether the slow query is targeted or broadcast before adding capacity.",
    ],
  },
];

export const mongosRoutingModel: SimModel = {
  id: "mongodb-mongos-routing",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, points]) => [key, [...points]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };

    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "mongos-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const shard of next.nodes.filter((node) => node.role === "shard")) {
      recordSeries(next, `cpu.${shard.id}`, Number(shard.meta?.cpu ?? 0));
    }

    if (values.fanout >= 2 && !Number(next.flags.fanoutAnnounced ?? 0)) {
      pushEvent(next, {
        id: "query-fanout",
        at: frame.t,
        severity: values.fanout >= 3.5 ? "crit" : "warn",
        title: "Queries are reaching multiple shards",
        detail: `The average query touches ${values.fanout.toFixed(1)} of ${SHARD_COUNT} shards. Each shard returns rows that mongos must merge before the client sees a result.`,
        nodeId: "mongos",
        metricId: "shards-touched",
      });
      next.flags.fanoutAnnounced = 1;
    } else if (values.fanout < 2) {
      next.flags.fanoutAnnounced = 0;
    }

    if (values.mergeShare >= 50 && !Number(next.flags.mergeAnnounced ?? 0)) {
      pushEvent(next, {
        id: "merge-dominant",
        at: frame.t,
        severity: "crit",
        title: "Merge time dominates the query",
        detail: `${values.mergeShare.toFixed(0)}% of modeled p99 is spent merging and serializing results at mongos, while the busiest shard is at ${values.shardCpu.toFixed(0)}% CPU.`,
        nodeId: "mongos",
        metricId: "merge-share",
      });
      next.flags.mergeAnnounced = 1;
    } else if (values.mergeShare < 50) {
      next.flags.mergeAnnounced = 0;
    }

    if (values.routerUtil >= 0.9 && !Number(next.flags.routerAnnounced ?? 0)) {
      pushEvent(next, {
        id: "router-saturated",
        at: frame.t,
        severity: "crit",
        title: "Router tier saturated by merge work",
        detail: `The busiest router is at ${values.routerCpu.toFixed(0)}% utilization. Add routers and reduce the rows per query; shard capacity will not shorten the merge this router performs.`,
        nodeId: "mongos",
        metricId: "router-util",
      });
      next.flags.routerAnnounced = 1;
    } else if (values.routerUtil < 0.9) {
      next.flags.routerAnnounced = 0;
    }

    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `At ${values.targetedShare.toFixed(0)}% targeted traffic, the average query touches ${values.fanout.toFixed(1)} of ${SHARD_COUNT} shards. The router, not the shard, combines those streams.`,
      `Modeled router utilization is ${values.routerCpu.toFixed(0)}% and merge work is ${values.mergeShare.toFixed(0)}% of p99. The busiest shard is at ${values.shardCpu.toFixed(0)}% CPU.`,
      values.mergeShare >= 30
        ? "The slow part of this query happens after the shards return rows: merge, global sort or limit, and serialization. More shard capacity does not remove that work."
        : "Targeted queries with narrow results keep the router cheap: one shard returns rows and mongos has little to merge.",
      "All capacities, row counts, and latency values in this model are illustrative teaching values, not MongoDB benchmarks or limits.",
    ];
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
    description: "Most queries are targeted and return 50 rows; router and shards both have headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher traffic with some untargeted queries and wider results. The router tier is warm.",
    tone: "warn",
    params: defaults({ queryRate: 8_500, targetedShare: 80, resultRows: 400, routerCount: 2 }),
  },
  {
    id: "failure",
    label: "Merge-bound",
    description: "A 4,000-row report has no shard key in its predicate and runs through one router.",
    tone: "crit",
    params: defaults({ queryRate: 3_000, targetedShare: 0, resultRows: 4_000, routerCount: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The endpoint targets the shard key, projects 40 rows, and uses two routers.",
    tone: "ok",
    params: defaults({ queryRate: 5_000, targetedShare: 100, resultRows: 40, routerCount: 2 }),
  },
  {
    id: "wide",
    label: "Wide result",
    description: "Every query is targeted, but 2,000 rows through one router still make merge the bottleneck.",
    tone: "crit",
    params: defaults({ queryRate: 8_000, targetedShare: 100, resultRows: 2_000, routerCount: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-merge",
  title: "Predict why the same query is fast on a shard and slow through mongos",
  simId: "mongos-routing",
  question:
    "A 4,000-row report has no shard key in its predicate and runs through one mongos. In this model, shard CPU is about 38%, router utilization is 100%, and p99 is 274ms. Where does the time go?",
  prediction: {
    options: [
      { id: "config", label: "The config servers recompute the route for all 4,000 rows" },
      { id: "merge", label: "mongos broadcasts to every shard, then merges and serializes the result streams" },
      { id: "one", label: "One shard owns every row and does the whole sort by itself" },
      { id: "driver", label: "The driver bypasses mongos and opens one connection per row" },
    ],
    correctOptionId: "merge",
    explanation:
      "Without the shard key, mongos sends the query to all four shards. Each shard executes locally and returns its rows; mongos merges the streams, applies the final sort and limit, and streams batches to the driver. The shards have CPU headroom, so the cost is the router's fan-out and merge work, not storage.",
  },
  setup: defaults({ queryRate: 3_000, targetedShare: 0, resultRows: 4_000, routerCount: 1 }),
  runFor: 20,
  observe: [
    "Shards touched per query settles at the full shard count.",
    "The busiest shard stays near 38% CPU while router utilization reaches 100%.",
    "Merge work accounts for most of the modeled p99.",
    "Targeting the predicate and returning 40 rows drops all five thresholds.",
  ],
  explain:
    "A shard can be fast and the query can still be slow. The router is on the response path: it fans out, waits for every stream, merges sorted results, applies the global limit, and serializes batches. A direct run against one shard skips that combination step, which is why the same predicate looks cheap in isolation. Reading `SHARD_MERGE` in explain output and comparing shard CPU with router utilization separates the two costs.",
  fix: defaults({ queryRate: 3_000, targetedShare: 100, resultRows: 40, routerCount: 2 }),
  debrief:
    "Check the shards listed in explain and the rows each one returns. If router utilization is high while shard CPU is moderate, the merge is the bottleneck. Reduce fan-out with the shard key and reduce merge width with projection and pagination before adding shards. Adding routers raises the ceiling for router work, but each query still pays for the rows it returns.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "`mongos` is the routing tier of a sharded MongoDB cluster. Applications connect to mongos rather than to a shard. For each query, mongos uses routing metadata cached from the config server replica set (CSRS) to decide which chunks and shards are relevant, sends the query to those shards, and returns one merged cursor to the driver.",
  },
  {
    type: "p",
    text: "Two costs live in the router. Targeting decides how many shards receive the query. Merge decides how much data comes back and how many result streams must be combined. A predicate that includes the shard key can usually be routed only to the shard or shards that own the matching chunks. A predicate that does not may be broadcast to every shard; each shard returns its rows, and mongos merges them, applies the global sort or limit, and streams batches to the client.",
  },
  {
    type: "p",
    text: "That is why a query can be fast when run directly on a shard and slow only through mongos. The shard did the same local work in both cases. The router added fan-out, a merge, and serialization. The capacities and latency curves in this model are illustrative teaching values, not MongoDB limits or benchmarks.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "mongos sits between the driver and the shards. The config servers sit beside that path: they own chunk metadata, and mongos caches it. A normal read does not become a config server lookup per document. When a query is slow, the useful comparison is between router work and shard work, not between the router and the metadata store.",
  },
  {
    type: "compare",
    leftTitle: "On one shard",
    rightTitle: "Through mongos",
    rows: [
      {
        label: "Work performed",
        left: "Execute the predicate against local data and return rows.",
        right: "Route, fan out, merge streams, sort or limit globally, serialize batches.",
      },
      {
        label: "Busy signal",
        left: "That shard's CPU, I/O, and slow-query log.",
        right: "mongos CPU, network egress, and rows merged per query.",
      },
      {
        label: "Usual cause",
        left: "Missing index or a wide scan on one partition.",
        right: "No shard key in the predicate or a wide result set.",
      },
      {
        label: "First fix",
        left: "Index, projection, or query rewrite.",
        right: "Target the query, narrow the rows, then add routers.",
      },
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "The merge is real work",
    body: "A router is not a passive proxy. It holds result streams open, combines them, and re-batches rows for the driver. A fast shard can still produce a slow response when mongos has to merge thousands of rows from several shards through one process.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Query p99 through mongos: routing, shard execution, merge, and serialization combined.",
      "Shards touched per query: one for a targeted lookup, up to four for a broadcast.",
      "Latency spent merging at mongos: how much of the tail is router work rather than shard work.",
      "Busiest router utilization: routing and merge pressure across the router tier.",
      "Busiest shard CPU: storage and execution pressure on one partition.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Merge-bound. Watch router utilization reach its limit while shard CPU stays low, and note that merge work, not shard execution, owns the tail. Switch to Wide result to see the same effect with a targeted query. Use the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "mongos-routing" },
  { type: "experiment", experimentId: "predict-merge" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The report omitted the shard key, so mongos sent it to all four shards. Each shard executed locally and returned its portion. mongos then merged the streams, applied the global sort and limit, and serialized the rows for one client cursor. Shard CPU stayed moderate because each shard held only part of the data. The router saturated because it had to combine every stream through one process.",
  },
  {
    type: "p",
    text: "Nothing was wrong with the config servers. They supplied cached metadata; they did not scan the collection. Adding shards would have widened the fan-out and given the router more streams to merge. The tail was dominated by work after the shards responded.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The sharded explain plan shows `SHARD_MERGE` and a list of all shards for the slow shape.",
      "mongos CPU and network egress rise with rows returned, while shard CPU stays unremarkable.",
      "The slow-query log shows high `nReturned` or bytes per query for that endpoint.",
      "Other query shapes through the same routers remain fast, which points at the shape rather than the tier.",
      "Config server CPU and metadata refresh errors are not elevated for this incident.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the query through mongos with the same predicate on one shard, then read the shards listed in explain. If every shard is touched and router utilization is high, the cost is fan-out and merge. If one shard is hot, look for a hot range or missing index. If router utilization is low and p99 is still high, look at the shard path or the client.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Prove where the time goes: compare direct-to-shard latency with latency through mongos for the same predicate.",
      "Read the sharded explain plan for shards touched, rows returned, and `SHARD_MERGE`.",
      "Add the shard key to the predicate when the product allows it, so mongos can target one shard.",
      "Narrow the result with projection and pagination; a global sort still has to see the rows it orders.",
      "Add routers and confirm clients spread connections across them; this raises router capacity but does not reduce per-query fan-out.",
      "Only then add shard capacity, and verify that shards touched and merge share fell.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Targeting constrains query flexibility: the shard key has to appear in the hot predicates.",
      "Narrow projections and pagination reduce merge cost but can push work into more round trips.",
      "More routers add concurrency and failure domains; they do not reduce the shards one query touches, and router metadata traffic can grow with the router count.",
      "A global sort without the shard key is sometimes unavoidable; run that shape on a separate path.",
      "Caching a report hides merge cost from users but adds a freshness bound.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "trace-the-router",
    question: "Trace a query from the application through mongos. Why can the same predicate be fast on a shard and slow through the router?",
    difficulty: 2,
    hints: [
      "Start with cached metadata and targeting.",
      "The response path also belongs to mongos.",
      "Separate storage work from stream combination.",
    ],
    answer:
      "The application connects to mongos. mongos parses the query and uses cached chunk metadata to decide which shards own the relevant ranges. If the predicate includes the shard key, it can target one shard; otherwise it broadcasts. Each shard executes against its local data and returns rows. mongos then merges the streams, applies the global sort or limit, and serializes batches to the driver. A direct run on one shard skips the fan-out and merge, so the shard-only time can look small while the end-to-end time through mongos is large.",
    followUps: [
      "What does `SHARD_MERGE` in explain tell you?",
      "When is a broadcast the correct plan?",
      "Why is the config server not the per-query bottleneck?",
    ],
    redFlags: [
      "Says the driver chooses the shard.",
      "Blames the config servers for a slow read.",
      "Ignores the merge and serialization step.",
    ],
    rubric: [
      "Names mongos, config metadata, shards, and merge.",
      "Explains targeting versus broadcast.",
      "Separates shard execution from router work.",
      "Accounts for the response path.",
    ],
  },
  {
    id: "router-hot",
    question: "A slow query touches four shards at 40% CPU each. mongos is at 95% CPU and returns 3,000 rows. What do you inspect, and what do you change?",
    difficulty: 3,
    hints: [
      "The shards are not the constraint.",
      "Look at the query shape and the rows crossing the router.",
      "Capacity and per-query cost are different levers.",
    ],
    answer:
      "I would read the sharded explain to confirm the shards touched and whether the plan includes `SHARD_MERGE`. I would compare the predicate with the shard key and check the projection, sort, and limit. The shards have headroom, so the likely cost is fan-out plus a wide merge at the router. I would first try to include the shard key and cut rows with projection and pagination. If the shape must stay broad, I would add routers and confirm connections are spread across them. I would not add shards, because that increases the number of streams the router must combine.",
    followUps: [
      "What would you measure before and after the change?",
      "Why might adding routers not improve this query?",
      "How would a covering index change the result?",
    ],
    redFlags: [
      "Adds shards without reading the plan.",
      "Restarts the config servers.",
      "Treats router CPU as a shard problem.",
    ],
    rubric: [
      "Reads explain and confirms fan-out.",
      "Checks rows and projection.",
      "Chooses targeting or router capacity deliberately.",
      "Defines before-and-after signals.",
    ],
  },
  {
    id: "wide-targeted",
    question: "Every query includes the shard key, yet p99 through mongos is 108ms while the shard is at 25% CPU. How is that possible?",
    difficulty: 2,
    hints: [
      "Targeting controls which shard, not how many rows leave it.",
      "The router still merges and serializes.",
      "A single router is one process.",
    ],
    answer:
      "Targeting removes fan-out, not merge work. A targeted query can still return thousands of rows, and mongos has to receive, buffer, and serialize them into batches for the driver. If the result set is wide and traffic is pinned to one router, that router becomes the queue even though one shard serves every request. The fix is to narrow the result with projection and pagination, and to spread traffic across routers. Adding shards would not help because the query only touches one.",
    followUps: [
      "What role does batch size play?",
      "How would you tell merge cost from network cost?",
      "When would a targeted query still be slow on the shard?",
    ],
    redFlags: [
      "Assumes targeted means cheap.",
      "Looks only at shard CPU.",
      "Adds shards for a single-shard query.",
    ],
    rubric: [
      "Separates targeting from result width.",
      "Names buffering and serialization.",
      "Considers router count and client distribution.",
      "Picks projection or pagination as the first fix.",
    ],
  },
  {
    id: "add-routers",
    question: "The team wants to add a fourth mongos to fix a slow report. When does that help, and when does it not?",
    difficulty: 3,
    hints: [
      "Routers are stateless and share work.",
      "Per-query fan-out is unchanged by router count.",
      "Client connection distribution matters.",
    ],
    answer:
      "Another mongos adds routing and merge capacity, so it helps when the router tier is the constraint and clients actually spread connections across routers. It does not reduce the number of shards a single query touches, and it does not reduce the rows that query must merge. If one report fans out to four shards and returns 4,000 rows, each router that serves it still pays that per-query cost; more routers mainly improve concurrency for many such queries. I would add routers for headroom, but fix targeting and result width for the report itself. I would also check that the client uses a load-balanced connection string rather than pinning to one router.",
    followUps: [
      "How do you verify clients use all routers?",
      "What happens if you restart one mongos?",
      "Which metric tells you the router tier is the limit?",
    ],
    redFlags: [
      "Expects routers to reduce fan-out.",
      "Ignores client-side load balancing.",
      "Adds routers for a single pathological query.",
    ],
    rubric: [
      "States that mongos is stateless and horizontal.",
      "Separates concurrency from per-query cost.",
      "Checks client distribution.",
      "Pairs router capacity with a query-shape fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document the shard key and the top query shapes, including which ones can be targeted.",
      "Dashboard router utilization, rows returned per query, and per-shard CPU separately.",
      "Confirm clients reach mongos through a load-balanced connection string.",
      "Know which reports are broadcast by design and how many rows they return.",
      "Test `explain(\"executionStats\")` on the slow shapes so the team knows what `SHARD_MERGE` looks like.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the query through mongos with the same predicate on one shard.",
      "Read shards touched and rows returned before changing any component.",
      "Compare router utilization with shard CPU for the same window.",
      "Do not add shards to a query that already broadcasts to every shard.",
      "Record the query shape, shard key, and result width for the post-incident review.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify p99 fell because fan-out or merge width fell, not because traffic dropped.",
      "Check that router utilization is balanced across all mongos instances.",
      "Review remaining broadcast queries and cap their result size.",
      "Re-test the fixed shape with explain and a direct-to-shard comparison.",
    ],
  },
];

const references = [
  {
    title: "mongos Instances",
    url: "https://www.mongodb.com/docs/manual/reference/program/mongos/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Router role, config server connection, and sharded cluster options.",
  },
  {
    title: "Sharded Cluster Components",
    url: "https://www.mongodb.com/docs/manual/core/sharded-cluster-components/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "mongos, config server replica set, and shards.",
  },
  {
    title: "Explain Results",
    url: "https://www.mongodb.com/docs/manual/reference/explain-results/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "`SHARD_MERGE` and `SHARDING_FILTER` stages for sharded query plans.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mongos-routing": {
      model: mongosRoutingModel,
      presets,
      instructions:
        "Start Healthy, then apply Merge-bound and note that router utilization saturates while shard CPU stays low. Apply Wide result to isolate result width from fan-out. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. Router capacity, merge cost, row counts, and latency are teaching values, not MongoDB limits or benchmarks. Four shards are fixed to isolate router work from cluster size.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-sharding", "mongodb-shard-key", "mongodb-hot-shard"],
};
