import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_CAPACITY_OPS = 10_000;
const MONGOS_CAPACITY_QPS = 8_000;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "queryRate",
    label: "Query rate",
    min: 1_000,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " q/s",
    group: "Traffic",
    help: "Queries arriving at mongos. Illustrative routing capacity, not a documented MongoDB limit.",
    format: "rps",
  },
  {
    id: "targetedShare",
    label: "Queries that include the shard key",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Query shape",
    help: "Share of queries whose predicate lets mongos target one shard. The rest scatter to every shard.",
    format: "percent",
  },
  {
    id: "shardCount",
    label: "Shards",
    min: 2,
    max: 4,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Number of shards in the cluster. More shards add capacity but widen a scatter-gather query.",
    format: "count",
  },
  {
    id: "mongosCount",
    label: "mongos routers",
    min: 1,
    max: 4,
    step: 1,
    value: 2,
    unit: "",
    group: "Topology",
    help: "Routers sharing client traffic. mongos is stateless and caches routing metadata, but it still merges results.",
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
  scatterShare: number;
  shardCount: number;
  mongosCount: number;
  fanout: number;
  perShardOps: number;
  shardUtil: number;
  mongosUtil: number;
  routingP99: number;
  mongosHealth: Health;
  shardHealth: Health;
  clientHealth: Health;
}

function compute(p: Params): Computed {
  const queryRate = clamp(num(p, "queryRate", 4_000), 0, 20_000);
  const targetedShare = clamp(num(p, "targetedShare", 95), 0, 100) / 100;
  const scatterShare = 1 - targetedShare;
  const shardCount = Math.round(clamp(num(p, "shardCount", 3), 2, 4));
  const mongosCount = Math.round(clamp(num(p, "mongosCount", 2), 1, 4));
  const fanout = 1 + scatterShare * (shardCount - 1);
  const perShardOps = (queryRate * fanout) / shardCount;
  const shardUtil = perShardOps / SHARD_CAPACITY_OPS;
  const mongosUtil = queryRate / (mongosCount * MONGOS_CAPACITY_QPS);
  const mongosQueue = Math.min(0.97, mongosUtil);
  const shardQueue = Math.min(0.97, shardUtil);
  const routingP99 = Math.min(
    MAX_P99_MS,
    3 + (fanout - 1) * 4 + (35 * mongosQueue) / (1 - mongosQueue) + (55 * shardQueue) / (1 - shardQueue),
  );
  const mongosHealth: Health = mongosUtil >= 0.9 ? "crit" : mongosUtil >= 0.7 ? "warn" : "ok";
  const shardHealth: Health = shardUtil >= 0.95 ? "crit" : shardUtil >= 0.75 ? "warn" : "ok";
  const clientHealth: Health = routingP99 >= 150 ? "crit" : routingP99 >= 50 ? "warn" : "ok";
  return {
    queryRate,
    targetedShare,
    scatterShare,
    shardCount,
    mongosCount,
    fanout,
    perShardOps,
    shardUtil,
    mongosUtil,
    routingP99,
    mongosHealth,
    shardHealth,
    clientHealth,
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const shards: SimNode[] = Array.from({ length: values.shardCount }, (_, index) => ({
    id: `shard-${index}`,
    label: `Shard ${index}`,
    kind: "db" as const,
    role: "shard" as const,
    health: values.shardHealth,
    utilization: clamp(values.shardUtil),
    throughput: values.perShardOps,
    sublabel: `${Math.round(values.perShardOps).toLocaleString()} ops/s · ${(values.shardUtil * 100).toFixed(0)}% CPU`,
    detail:
      "A shard is itself a replica set that stores a subset of the collection. It executes the query mongos sends and returns its portion of the result; it does not decide which other shards to contact.",
    meta: { view: "flow", cpu: values.shardUtil * 100 },
  }));

  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: values.clientHealth,
      sublabel: `${Math.round(values.targetedShare * 100)}% targeted queries`,
      detail: "The application connects to mongos. The driver does not know which shard holds a document; that routing belongs to the cluster.",
      meta: { view: "flow" },
    },
    {
      id: "mongos",
      label: "mongos",
      kind: "service",
      health: values.mongosHealth,
      utilization: clamp(values.mongosUtil),
      throughput: values.queryRate,
      sublabel: `${Math.round(values.queryRate).toLocaleString()} q/s · touches ${values.fanout.toFixed(1)} shards`,
      detail: `mongos parses the query, uses cached routing metadata, sends it to the relevant shards, and merges the results. This query fans out to ${values.fanout.toFixed(1)} of ${values.shardCount} shards on average.`,
      meta: { view: "flow" },
    },
    {
      id: "config",
      label: "Config servers",
      kind: "db",
      role: "replica",
      health: "ok",
      sublabel: "CSRS · chunk metadata",
      detail: "The config server replica set (CSRS) stores the cluster's routing metadata: which ranges live on which shard. mongos caches that metadata and refreshes it when it is stale; every query does not become a config server read.",
      meta: { view: "flow" },
    },
    ...shards,
  ];

  const edges = [
    edge("client-mongos", "client", "mongos", values.queryRate / 20_000, values.clientHealth),
    edge("mongos-config", "mongos", "config", 0.1, "ok"),
    ...shards.map((shard) =>
      edge(`mongos-${shard.id}`, "mongos", shard.id, values.perShardOps / SHARD_CAPACITY_OPS, values.shardHealth),
    ),
  ];

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("routing-p99", "Query p99 through mongos", values.routingP99, "ms", 50, 150, "ms"),
      metric("shards-touched", "Shards touched per query", values.fanout, "", 2, 3.5, "number"),
      metric("scatter-share", "Scatter-gather queries", values.scatterShare * 100, "%", 30, 70, "percent"),
      metric("mongos-cpu", "Busiest mongos", values.mongosUtil * 100, "%", 70, 90, "percent"),
      metric("shard-cpu", "Busiest shard", values.shardUtil * 100, "%", 75, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(values) },
    summary: `${Math.round(values.queryRate).toLocaleString()} q/s through ${values.mongosCount} mongos; ${values.fanout.toFixed(1)} shards touched per query; p99 ${values.routingP99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.03 * Math.sin((index + (seed % 5)) / 2.1);
  const rows: [string, number][] = [
    ["routing-p99", values.routingP99],
    ["shards-touched", values.fanout],
    ["scatter-share", values.scatterShare * 100],
    ["mongos-cpu", values.mongosUtil * 100],
    ["shard-cpu", values.shardUtil * 100],
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
    id: "routing-p99",
    metricId: "routing-p99",
    warn: 50,
    crit: 150,
    title: "A scatter-gather query is setting p99",
    cause:
      "The query omits the shard key or cannot be targeted, so mongos sends it to every shard and waits for the slowest response. Merge cost and per-shard queueing add to the tail.",
    fix:
      "Read the query plan and shard key. Add the shard key to the predicate when the product allows, or accept the fan-out and add capacity. Do not start by tuning the config servers; they provide metadata, not each query's result set.",
    checkFirst: [
      "Count the shards listed in the explain output or slow-query profile.",
      "Compare p99 with the number of shards and the query's predicate.",
      "Check whether mongos or a shard is the busiest component.",
    ],
  },
  {
    id: "shards-touched",
    metricId: "shards-touched",
    warn: 2,
    crit: 3.5,
    title: "Queries fan out across the cluster",
    cause:
      "Without the shard key, mongos cannot exclude shards. Every additional shard adds a request and a result stream, so query cost grows with cluster size instead of staying constant.",
    fix:
      "Use a shard key that appears in the hot query shapes, or change the query to include it. Scatter-gather is sometimes correct, but it should be a known cost, not the default for every request.",
    checkFirst: [
      "List the top query shapes and whether each includes the shard key.",
      "Check the collection's shard key and index coverage.",
      "Check whether the query is a broadcast read or a targeted lookup.",
    ],
  },
  {
    id: "mongos-cpu",
    metricId: "mongos-cpu",
    warn: 70,
    crit: 90,
    title: "The router tier is saturated",
    cause:
      "Too few mongos processes, or each request is doing too much routing and merge work. mongos is stateless, so this is a horizontal scaling and query-shape problem, not a shard storage problem.",
    fix:
      "Add mongos routers and rebalance client connections, then reduce fan-out for the hottest queries. Check that the client uses a load-balanced connection string so it does not pin all traffic to one router.",
    checkFirst: [
      "Compare CPU across mongos instances, not just the busiest one.",
      "Check connection counts and client-side load balancing.",
      "Check whether the same window has high fan-out.",
    ],
  },
  {
    id: "scatter-share",
    metricId: "scatter-share",
    warn: 30,
    crit: 70,
    title: "Most queries cannot be targeted",
    cause:
      "The shard key does not match the dominant query pattern, or the application omits it. The cluster stores data correctly but cannot use the key to route reads.",
    fix:
      "Review the shard key against the query shapes. A key chosen for write distribution can still be wrong for reads; changing it is a resharding decision, not a mongos setting.",
    checkFirst: [
      "Map the top ten query shapes to the shard key prefix.",
      "Check whether the key is present in filters and sort orders.",
      "Check whether the workload is read-heavy or write-heavy.",
    ],
  },
];

export const shardingModel: SimModel = {
  id: "mongodb-sharding",
  visual: "topology",
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
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.5, 0.5);
    next.metrics = next.metrics.map((item) =>
      item.id === "routing-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const shard of next.nodes.filter((node) => node.role === "shard")) {
      recordSeries(next, `cpu.${shard.id}`, Number(shard.meta?.cpu ?? (shard.utilization ?? 0) * 100));
    }
    if (values.fanout >= 2 && !Number(next.flags.fanoutAnnounced ?? 0)) {
      pushEvent(next, {
        id: "scatter-gather",
        at: frame.t,
        severity: values.fanout >= 3.5 ? "crit" : "warn",
        title: "Queries are touching multiple shards",
        detail: `Each query touches ${values.fanout.toFixed(1)} of ${values.shardCount} shards. Targeted queries are ${(values.targetedShare * 100).toFixed(0)}% of traffic.`,
        nodeId: "mongos",
        metricId: "shards-touched",
      });
      next.flags.fanoutAnnounced = 1;
    }
    if (values.fanout < 2) next.flags.fanoutAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `mongos receives ${Math.round(values.queryRate).toLocaleString()} queries/s and routes each one using cached chunk metadata. The config servers are the source of that metadata, not a per-query data path.`,
      `At ${(values.targetedShare * 100).toFixed(0)}% targeted traffic, the average query touches ${values.fanout.toFixed(1)} shards. The shards each execute a subset; mongos merges the responses.`,
      `The busiest mongos is modeled at ${(values.mongosUtil * 100).toFixed(0)}% and the busiest shard at ${(values.shardUtil * 100).toFixed(0)}%. They fail differently: routing and merge versus storage and query execution.`,
      "Routing capacity and shard capacity are illustrative teaching values. MongoDB documents the components and metadata flow, not these numbers.",
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
    description: "Most queries include the shard key and touch one shard.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher query volume with some untargeted traffic.",
    tone: "warn",
    params: defaults({ queryRate: 12_000, targetedShare: 85, shardCount: 4, mongosCount: 3 }),
  },
  {
    id: "failure",
    label: "Scatter-gather",
    description: "No query includes the shard key, so every query touches all four shards through one router.",
    tone: "crit",
    params: defaults({ queryRate: 12_000, targetedShare: 0, shardCount: 4, mongosCount: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Queries target the shard key and the router tier has headroom.",
    tone: "ok",
    params: defaults({ queryRate: 6_000, targetedShare: 100, shardCount: 4, mongosCount: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-scatter",
  title: "Predict where a query without the shard key spends its time",
  simId: "sharding",
  question:
    "A collection is sharded on `customerId`. A report queries only `createdAt`, and p99 rises as the cluster grows. Which component does the extra work?",
  prediction: {
    options: [
      { id: "config", label: "The config servers look up the route for every document" },
      { id: "shards", label: "Every shard runs the query and mongos merges all the results" },
      { id: "one", label: "One shard owns all createdAt values, so only it is slow" },
      { id: "driver", label: "The driver contacts each shard directly and bypasses mongos" },
    ],
    correctOptionId: "shards",
    explanation:
      "A predicate without the shard key cannot exclude shards. mongos sends the query to every shard, each shard scans its local data, and mongos merges the result streams. The config servers supply cached metadata; they are not scanning the collection per query.",
  },
  setup: defaults({ queryRate: 12_000, targetedShare: 0, shardCount: 4, mongosCount: 1 }),
  runFor: 20,
  observe: [
    "Shards touched per query equals the shard count.",
    "Every shard's CPU rises together, while each holds only part of the data.",
    "Mongos CPU rises from routing and merging, not from storing documents.",
    "The p99 tracks the slowest shard plus the merge, so adding shards can make it worse.",
  ],
  explain:
    "Sharding partitions data; it does not automatically partition every query. Targeting depends on the shard key appearing in the predicate. A broadcast query pays for every shard and for the merge at mongos, so its cost scales with cluster size. The config server is involved in metadata, but mongos caches it and does not turn each query into a metadata lookup.",
  fix: defaults({ queryRate: 12_000, targetedShare: 100, shardCount: 4, mongosCount: 4 }),
  debrief:
    "Read the explain output for shards touched and compare it with the query predicate. If the hot query cannot include the shard key, treat the fan-out as an architectural cost: add router and shard capacity, cache the report, or run it on a different path. Do not debug the config servers unless metadata refresh or config server health is actually failing.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A sharded MongoDB cluster has three roles. `mongos` is a stateless router that accepts client queries. Config servers form a replica set (CSRS) that stores routing metadata: which chunk ranges live on which shard. Shards store the data, and each shard is itself a replica set.",
  },
  {
    type: "p",
    text: "The client connects to mongos, not to a shard. mongos parses the query, consults cached metadata, sends the query to the relevant shards, and merges the responses. The shard key is what lets it exclude shards. Without the key in the predicate, the only correct plan may be to ask every shard.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "On the write path, mongos routes to the shard that owns the chunk, and the shard's replica set commits the write. On the read path, mongos targets one shard for a shard-key lookup or fans out for a broadcast query. Config server metadata is cached by mongos and refreshed when routing information changes; it is not a data-bearing hop for each query.",
  },
  {
    type: "table",
    headers: ["Component", "Owns", "Failure shape"],
    rows: [
      ["mongos", "Query routing, fan-out, result merge", "High router CPU, connection pressure, slow merge"],
      ["Config servers", "Chunk and shard metadata", "Metadata refresh failures, cluster administration errors"],
      ["Shard", "A subset of data as a replica set", "Storage, CPU, or replica-set problems on part of the data"],
      ["Driver", "Connection to mongos and server selection", "Cannot reach a router or select a server"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "The config server is not the query engine",
    body: "mongos caches routing metadata. A slow query that fans out to every shard is usually a shard-key problem plus a merge cost, not a config server lookup per document. The model labels its routing and shard capacities as illustrative values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Query p99 through mongos: routing, per-shard execution, and merge combined.",
      "Shards touched per query: 1 for a targeted lookup, up to the shard count for a broadcast.",
      "Scatter-gather share: how much traffic cannot use the shard key.",
      "Busiest mongos CPU: routing and merge pressure.",
      "Busiest shard CPU: execution and storage pressure on one partition.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy: most queries include the shard key and touch one shard. Apply Scatter-gather and watch every shard and the single router load together. Add routers and reduce fan-out to see which fix addresses which bottleneck. Use the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "sharding" },
  { type: "experiment", experimentId: "predict-scatter" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Queries without the shard key could not be targeted. mongos sent each one to every shard, every shard scanned its local portion, and mongos merged the streams. Adding shards added work instead of reducing it. The busiest mongos and every shard rose together, which is the signature of fan-out rather than a single hot partition.",
  },
  {
    type: "p",
    text: "The config servers were not the bottleneck. They supplied metadata that mongos had cached; the per-query work happened in routing, shard execution, and merge. A targeted query with the same total data would have touched one shard.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Slow-query logs or the profiler show a high number of shards touched.",
      "Every shard shows elevated CPU for the same query shape, not one outlier.",
      "mongos CPU and network egress rise with fan-out and result size.",
      "The p99 grows when shards are added, because the broadcast waits for the slowest response.",
      "Config server CPU and metadata refresh errors are not necessarily elevated.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the query predicate and the collection's shard key before checking cluster components. Then read shards touched and merge size from the slow-query profile. If every shard is busy for one query shape, the problem is fan-out. If one shard is busy, look for a hot range or hot key. If mongos is busy but shards are not, look at connection count and merge size.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the top query shapes and whether they include the shard key prefix.",
      "Rewrite hot queries to include the key when the product permits it.",
      "If fan-out is unavoidable, add mongos and shard capacity and bound the result size.",
      "Check client load balancing across mongos instances.",
      "Verify that the fix reduced shards touched, not only p99 for one sample.",
      "Only then consider a shard key change or resharding, with its own migration cost.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A key that targets reads may concentrate writes; a key that spreads writes may make reads fan out.",
      "More shards add storage and write capacity but widen broadcast queries and increase merge work.",
      "More mongos routers add routing capacity but do not reduce the number of shards a query touches.",
      "Caching a report result hides fan-out from users but adds a freshness bound.",
      "Changing a shard key is a data movement project, not a routing toggle.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "draw-sharding",
    question: "Draw a sharded MongoDB cluster and trace a query from the application to a result.",
    difficulty: 2,
    hints: [
      "Start at mongos, not at a shard.",
      "Separate metadata from data.",
      "Explain targeted versus broadcast.",
    ],
    answer:
      "The application connects to one or more mongos routers. mongos parses the query and uses cached routing metadata from the config server replica set to decide which chunks and shards are relevant. It sends the query to those shards; each shard is a replica set that executes against its local data. mongos merges the responses and returns one result to the client. If the predicate includes the shard key, the router can target one shard. If not, it may have to send the query to every shard and merge a larger response.",
    followUps: [
      "What does the config server store?",
      "Why is mongos stateless?",
      "What changes when the query includes the shard key?",
    ],
    redFlags: [
      "Sends the client directly to a shard.",
      "Says the config server stores the collection data.",
      "Treats every query as targeted.",
    ],
    rubric: [
      "Names all three roles.",
      "Separates metadata from data.",
      "Explains routing and merge.",
      "Distinguishes targeted from broadcast.",
    ],
  },
  {
    id: "slow-routing",
    question: "A sharded cluster routes queries slowly. How do you decide whether mongos, the config servers, or a shard is responsible?",
    difficulty: 3,
    hints: [
      "Compare component metrics for the same query shape.",
      "Fan-out loads every shard at once.",
      "Config metadata is cached.",
    ],
    answer:
      "I would start with the slow-query profile and shards touched. If every shard is busy for the same shape, the query is fanning out and mongos is merging; the config servers are probably not involved per query. If one shard is busy, I would look for a hot range or hot key. If mongos is saturated while shards have headroom, I would check connection distribution, merge size, and router count. I would check config server health when metadata refreshes, chunk operations, or cluster administration are failing, not as the default explanation for a slow read.",
    followUps: [
      "What does a high merge size tell you?",
      "How would you prove the config servers are healthy?",
      "What if only one client is slow?",
    ],
    redFlags: [
      "Blames the config servers without evidence.",
      "Adds shards to a broadcast query.",
      "Ignores query shape.",
    ],
    rubric: [
      "Uses shards touched and per-component metrics.",
      "Separates fan-out from hot partition.",
      "Knows metadata is cached.",
      "Checks client-side effects.",
    ],
  },
  {
    id: "add-shards",
    question: "The cluster is at 70% CPU on every shard. Will adding shards fix a broadcast query?",
    difficulty: 2,
    hints: [
      "Broadcast cost scales with shard count.",
      "Capacity and routing are different.",
      "The query still has to visit every shard.",
    ],
    answer:
      "Adding shards adds storage and write capacity, and it reduces the data each shard holds. For a broadcast query, however, every new shard becomes another request and another result stream, so p99 can get worse even though total CPU per shard falls. I would first try to target the query or reduce its result size, then add shards for capacity if the workload still needs it. I would measure shards touched and mongos merge time before and after.",
    followUps: [
      "When does adding shards help a read workload?",
      "How does result size affect mongos?",
      "What would you measure after the change?",
    ],
    redFlags: [
      "Assumes sharding makes every query faster.",
      "Ignores merge cost.",
      "Adds routers and shards without a query-shape fix.",
    ],
    rubric: [
      "Separates capacity from routing.",
      "Explains broadcast scaling.",
      "Mentions merge and result size.",
      "Defines before-and-after signals.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document the shard key and the top query shapes.",
      "Dashboard shards touched, mongos CPU, and per-shard CPU separately.",
      "Confirm clients connect through mongos with load-balanced routers.",
      "Know which reports are broadcast by design.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read shards touched for the slow query before changing components.",
      "Compare mongos CPU with per-shard CPU for the same window.",
      "Check whether one shard or every shard is busy.",
      "Do not restart config servers to fix a fan-out query.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify p99 fell because fan-out or merge cost fell, not because traffic dropped.",
      "Record the query shapes that still broadcast.",
      "Review router capacity and client connection distribution.",
      "Plan shard key changes as separate migration projects.",
    ],
  },
];

const references = [
  {
    title: "Sharding",
    url: "https://www.mongodb.com/docs/manual/sharding/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Sharded cluster overview, components, and when to shard.",
  },
  {
    title: "Sharded Cluster Components",
    url: "https://www.mongodb.com/docs/manual/core/sharded-cluster-components/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "mongos, config server replica set, and shards.",
  },
  {
    title: "mongos",
    url: "https://www.mongodb.com/docs/manual/reference/program/mongos/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Router behavior and routing metadata.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    sharding: {
      model: shardingModel,
      presets,
      instructions:
        "Start Healthy, then apply Scatter-gather. Compare the router and shard loads, add routers, and reduce fan-out. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Router and shard capacities, query rates, and latency are teaching values, not MongoDB limits or benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-shard-key", "mongodb-mongos-routing", "mongodb-hot-shard"],
};
