import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ORIGIN_CAPACITY = 30_000;
const MISS_SHARE = 0.04;

const params = [
  {
    id: "engine",
    label: "Cache engine",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Engine",
    help: "0 Redis, 1 Memcached. The workload needs sorted sets, pub/sub, and persistence; use the switch to test whether the simpler cache fits.",
    format: "count" as const,
  },
  {
    id: "readRps",
    label: "Read rate",
    min: 5_000,
    max: 200_000,
    step: 5_000,
    value: 30_000,
    unit: " rps",
    group: "Workload",
    help: "Key lookups per second against a single cache tier. Higher rates expose the difference in per-node capacity.",
    format: "rps" as const,
  },
  {
    id: "valueKb",
    label: "Average value size",
    min: 1,
    max: 64,
    step: 1,
    value: 4,
    unit: " KB",
    group: "Workload",
    help: "Payload per cached value. Larger values increase network and copy cost for both engines.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  isMemcached: boolean;
  engineName: string;
  readRps: number;
  valueKb: number;
  featureGaps: number;
  p99: number;
  originQps: number;
  dbCpu: number;
}

function compute(p: Params): Values {
  const isMemcached = num(p, "engine", 0) >= 0.5;
  const readRps = Math.max(1, num(p, "readRps", 30_000));
  const valueKb = Math.max(0.1, num(p, "valueKb", 4));
  const capacity = isMemcached ? 300_000 : 120_000;
  const p99 = isMemcached
    ? 0.45 + valueKb * 0.008 + (readRps / capacity) ** 4 * 8
    : 0.55 + valueKb * 0.012 + (readRps / capacity) ** 4 * 14;
  const featureGaps = isMemcached ? 3 : 0;
  const originQps = readRps * MISS_SHARE + (isMemcached ? readRps * 0.35 : 0);
  return {
    isMemcached,
    engineName: isMemcached ? "Memcached" : "Redis",
    readRps,
    valueKb,
    featureGaps,
    p99: clamp(p99, 0.1, 500),
    originQps,
    dbCpu: clamp((originQps / ORIGIN_CAPACITY) * 100, 0, 160),
  };
}

function cacheHealth(v: Values): "ok" | "warn" | "crit" {
  if (v.featureGaps > 0 || v.p99 >= 20) return "crit";
  if (v.p99 >= 5) return "warn";
  return "ok";
}

function dbHealth(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 90) return "crit";
  if (cpu >= 75) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return Math.round(value).toLocaleString();
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const wave = (index: number) => 0.97 + 0.05 * Math.sin((index + (seed % 4)) / 2.5);
  frame.series["cache-p99"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.p99 * wave(index)));
  frame.series["feature-gaps"] = Array.from({ length: 24 }, () => v.featureGaps);
  frame.series["db-cpu"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.dbCpu * wave(index + 2)));
  frame.series["db-qps"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.originQps * wave(index + 3)));
  frame.series["read-rps"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.readRps * wave(index + 4)));
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const cache = cacheHealth(v);
  const db = dbHealth(v.dbCpu);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Application",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(v.readRps)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Cache client",
        kind: "service",
        health: "ok",
        utilization: clamp(v.readRps / 200_000),
        throughput: v.readRps,
        sublabel: `${v.valueKb.toFixed(0)} KB values`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: v.engineName,
        kind: "cache",
        health: cache,
        utilization: clamp(v.readRps / (v.isMemcached ? 300_000 : 120_000)),
        throughput: v.readRps,
        sublabel:
          v.featureGaps > 0
            ? `${v.featureGaps} required primitives missing`
            : `p99 ${v.p99.toFixed(2)} ms`,
        detail: v.isMemcached
          ? "Memcached is a multithreaded key-value cache. It has no sorted sets, streams, pub/sub, persistence, or native replication. Those features must come from another system."
          : "Redis provides data structures, persistence, pub/sub, and replication. Command execution is single-threaded per shard, so vertical CPU is bounded and read replicas or sharding add capacity.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Origin database",
        kind: "db",
        health: db,
        utilization: clamp(v.originQps / ORIGIN_CAPACITY),
        throughput: v.originQps,
        sublabel: `${formatCount(v.originQps)} qps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-service", "client", "service", clamp(v.readRps / 200_000)),
      edge("service-cache", "service", "cache", 1, cache),
      edge("service-db", "service", "db", clamp(v.originQps / Math.max(1, v.readRps)), db),
    ],
    metrics: [
      metric("feature-gaps", "Missing primitives", v.featureGaps, "", 1, 1, "count"),
      metric("cache-p99", "Cache p99", v.p99, "ms", 5, 20, "ms"),
      metric("db-cpu", "Origin CPU", v.dbCpu, "%", 75, 90, "percent"),
      metric("db-qps", "Origin QPS", v.originQps, " qps", undefined, undefined, "rps"),
      metric("read-rps", "Read rate", v.readRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.engineName} at ${formatCount(v.readRps)} reads/s: p99 ${v.p99.toFixed(2)} ms, ${v.featureGaps} missing primitives, ${formatCount(v.originQps)} qps at the origin.`,
  };
  seedSeries(frame, v, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "feature-gaps",
    metricId: "feature-gaps",
    warn: 1,
    crit: 1,
    title: "The chosen engine lacks a required primitive",
    cause:
      "The workload needs sorted sets, pub/sub, persistence, or replication. Memcached is a key-value cache and provides none of them, so the application must add another system or recompute from the database.",
    fix:
      "Choose the engine by the primitives the workload requires. If the simpler cache is still attractive, split the workload: keep plain key-value reads on Memcached and move the feature-dependent paths to a system that provides them.",
    checkFirst: [
      "List the required operations and durability guarantees before comparing latency.",
      "Check for hidden fallbacks: sorted-set queries, pub/sub, or persistence handled elsewhere.",
      "Measure the cost of the fallback path, including database load.",
    ],
  },
  {
    id: "cache-p99",
    metricId: "cache-p99",
    warn: 5,
    crit: 20,
    title: "Cache latency exceeds the read budget",
    cause:
      "Key lookups or large values are queueing. Redis executes commands on one thread per shard; Memcached is multithreaded, so its per-node capacity curve differs.",
    fix:
      "Reduce value size, add capacity, or split the workload. Compare engines at the same value size and read mix; a generic benchmark does not answer a queueing question.",
    checkFirst: [
      "Check p99 by command and value size.",
      "Check connection pool wait and network round trips.",
      "Check whether one hot key or large value dominates.",
    ],
  },
  {
    id: "db-cpu",
    metricId: "db-cpu",
    warn: 75,
    crit: 90,
    title: "The origin is absorbing work the cache cannot do",
    cause:
      "A missing primitive forces the application to compute or fetch from the database. The cache hit rate can look fine for plain keys while the feature path bypasses it.",
    fix:
      "Move the feature-dependent path to an engine that supports the primitive, or add an explicit service for it. Do not count the fallback as cache capacity.",
    checkFirst: [
      "Compare origin QPS with the feature path, not with total read rate.",
      "Check whether the fallback is cached anywhere else.",
      "Check whether the database load started when the engine changed.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const redisVsMemcachedModel: SimModel = {
  id: "caching-redis-vs-memcached",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const jittered: Params = {
      ...p,
      readRps: num(p, "readRps", 30_000) * (1 + rng.between(-0.004, 0.004) * Math.min(1, dt / 0.1)),
    };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (!reset) {
      next.series = Object.fromEntries(Object.entries(frame.series).map(([k, values]) => [k, [...values]]));
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events];
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `${v.engineName} at ${formatCount(v.readRps)} reads/s and ${v.valueKb.toFixed(0)} KB values gives a model p99 of ${v.p99.toFixed(2)} ms.`,
      v.isMemcached
        ? "Memcached is multithreaded and simple, but it has no sorted sets, streams, pub/sub, persistence, or native replication. The workload requires three of them (sorted sets, pub/sub, and persistence), so the apparent latency win is not the whole decision."
        : "Redis executes commands on one thread per shard and adds structures, persistence, pub/sub, and replication. Those features are the reason to pay its operational cost.",
      `The origin sees ${formatCount(v.originQps)} qps. Missing primitives force a fallback path; a plain key-value hit rate does not cover it.`,
      "Compare engines on the operations and failure modes you need, then benchmark the surviving candidate with your value sizes and access pattern.",
    ];
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
    description: "Redis serves 30k reads/s with small values and all required primitives present.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Redis at 100k reads/s with larger values; latency is near the warning line.",
    tone: "warn",
    params: defaults({ readRps: 100_000, valueKb: 8 }),
  },
  {
    id: "failure",
    label: "Memcached only",
    description: "Memcached handles the plain lookups, but three required primitives are missing.",
    tone: "crit",
    params: defaults({ engine: 1, readRps: 120_000, valueKb: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Redis at 80k reads/s with the same value size; every required primitive is available.",
    tone: "ok",
    params: defaults({ engine: 0, readRps: 80_000, valueKb: 8 }),
  },
];

const experiment: Experiment = {
  id: "predict-engine-choice",
  title: "Predict the deciding requirement",
  simId: "redis-vs-memcached",
  question:
    "Memcached shows a lower p99 at the same read rate. The workload needs sorted sets, pub/sub, and persistence. Which signal decides the engine?",
  prediction: {
    options: [
      { id: "primitives", label: "The required primitives: Memcached does not provide them, so the fallback path decides the architecture." },
      { id: "latency", label: "The lower p99: latency always dominates the engine choice." },
      { id: "memory", label: "Memory per value: the engine with the smallest allocation wins." },
      { id: "cost", label: "The hourly price: the cache is a commodity and the features are equivalent." },
    ],
    correctOptionId: "primitives",
    explanation:
      "Memcached is a key-value cache. It has no sorted sets, streams, pub/sub, persistence, or native replication. A lower p99 on plain gets does not help the paths that need those operations; those paths move to another system or the database, and the fallback load becomes the real cost. Choose by required primitives first, then compare latency and operating cost among engines that can do the job.",
  },
  setup: defaults({ engine: 1, readRps: 120_000, valueKb: 8 }),
  runFor: 12,
  observe: [
    "The cache p99 is lower than Redis at the same read rate, so latency alone would pick Memcached.",
    "Three required primitives are missing and the origin database absorbs the fallback path.",
    "The cache node is failing even though its latency is healthy.",
    "Switching to Redis removes the feature gap and brings origin load back down.",
  ],
  explain:
    "The engine decision starts with a capability list. Memcached is a fast multithreaded cache for plain key-value data; Redis adds data structures, persistence, pub/sub, and replication. If the workload needs those, Memcached is not a cheaper version of Redis; it is a different component with a second system behind it. Latency benchmarks only compare engines that can both serve the workload.",
  fix: defaults({ engine: 0, readRps: 80_000, valueKb: 8 }),
  debrief:
    "Redis was the slower choice on the plain lookup microbenchmark and the only choice that served the whole workload. The fallback database load was the cost of the simpler engine, not a saving. If the plain lookups were large enough, a split architecture could still use Memcached for them, but that adds a second cache tier and a routing decision.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis and Memcached are both in-memory key-value caches, but they are not interchangeable. Memcached is a multithreaded cache for opaque values: set a key, get a key, delete a key. Redis adds data structures such as sorted sets, hashes, lists, and streams, plus publish/subscribe (pub/sub), persistence, replication, and cluster semantics. Redis executes commands on one thread per shard; Memcached uses multiple worker threads. That threading difference changes the capacity curve, but the feature difference usually decides the architecture first.",
  },
  {
    type: "p",
    text: "A benchmark that compares plain `GET` throughput answers a narrow question. If the workload needs a leaderboard, a fan-out notification, or a write that survives a restart, Memcached cannot serve it without another system. The fallback to that system, often the database, is part of the cache's real cost.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is application, cache client, cache tier, then the origin database on a miss or an unsupported operation. With Memcached, the cache tier is a set of independently sharded nodes and the client owns distribution. With Redis, the cache can be a single primary with replicas or a cluster that owns slot mapping. The engine choice changes what the application must implement.",
  },
  {
    type: "compare",
    leftTitle: "Redis",
    rightTitle: "Memcached",
    rows: [
      { label: "Data model", left: "Strings, hashes, lists, sets, sorted sets, streams, pub/sub", right: "Opaque key-value items" },
      { label: "Threading", left: "Command execution on one thread per shard", right: "Multithreaded workers" },
      { label: "Durability", left: "RDB and AOF persistence", right: "No persistence; a restart is a cold cache" },
      { label: "Replication", left: "Native replication and cluster failover", right: "Client-side sharding; no native replication" },
      { label: "Operational cost", left: "More configuration, persistence, and failover surface", right: "Simpler cache tier; features live elsewhere" },
    ],
  },
  {
    type: "table",
    headers: ["Decision", "Choose Redis when", "Choose Memcached when"],
    rows: [
      [
        "1. Required primitives",
        "The workload needs ordered sets, streams, pub/sub, Lua, persistence, or replication.",
        "The workload is plain key-value reads and writes with no cross-key operations or durability requirement.",
      ],
      [
        "2. Operating model",
        "You can run persistence, replicas, failover, and cluster topology, and you need those guarantees.",
        "You want a simple horizontally sharded cache and can rebuild it after a restart.",
      ],
    ],
  },
  {
    type: "p",
    text: "This module uses 120k ops/s for Redis and 300k ops/s for Memcached as illustrative per-node capacities, a 35% fallback share for unsupported Memcached operations, and 1–64 KB values. These are teaching values, not engine limits. The lesson is the decision order: capability, failure mode, then throughput.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Missing primitives, which turns the cache node critical even when latency looks good.",
      "Cache p99 at the selected read rate and value size.",
      "Origin CPU and QPS, which show the cost of the fallback path.",
      "An engine switch that changes the capacity curve and the feature count together.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then switch to Memcached only. Watch the cache p99 improve while missing primitives and origin load make the node fail. Switch back to Redis and compare. Run the experiment before the debrief: it asks which signal actually decides the engine.",
  },
  {
    type: "p",
    text: "The first question is not which cache is faster. It is which operations the product requires and which failures it can tolerate. If the answer includes sorted sets or persistence, the engine decision is already constrained. Benchmark only the candidates that can serve the whole workload.",
  },
  { type: "sim", simId: "redis-vs-memcached" },
  { type: "experiment", experimentId: "predict-engine-choice" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Memcached served plain lookups with a lower model p99 than Redis. It could not serve the leaderboard, the notification fan-out, or the writes that had to survive a restart. Those paths fell back to the database, which raised origin CPU and made the cache tier fail on capability rather than latency. The faster microbenchmark was real and irrelevant to the workload.",
  },
  {
    type: "p",
    text: "Redis added the required primitives and removed the fallback load. Its single-threaded command execution per shard set a different capacity curve, which is managed with replicas or sharding. The operational cost is real: persistence, failover, and topology now belong to the cache tier.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache p99 and throughput by command and value size, not one blended average.",
      "Application errors for unsupported operations, or a fallback counter that rises when the cache cannot serve the path.",
      "Origin database QPS and CPU, which reveal work the cache is not doing.",
      "Redis `INFO` for persistence, replication, and memory; Memcached stats for item counts and evictions.",
      "Architecture diagrams that show a second system behind the cache for features it does not provide.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "List the required primitives and find the fallback path. If the cache is fast on the operations it supports but the database is absorbing the rest, the engine choice is the problem, not the cache latency.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the capability list: data structures, atomic operations, pub/sub, persistence, replication, and failover.",
      "Find every fallback path and measure its load and failure mode.",
      "Choose an engine that serves the whole workload, or split the workload deliberately.",
      "Benchmark the surviving candidates with production value sizes and access patterns.",
      "Size the tier for the threading model and add replicas or shards where needed.",
      "Re-run the peak load and verify cache p99, origin load, and missing-primitive count.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Memcached is simpler and multithreaded per node, but the application must supply sharding and every missing feature.",
      "Redis provides structures, persistence, pub/sub, and replication, with more configuration and failover surface.",
      "Splitting the workload keeps each engine simple but adds a second tier and a routing decision.",
      "A single Redis primary is easy to reason about but bounded by one command thread per shard.",
      "A lower p99 on a benchmark that omits half the workload is not a capacity plan.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-engine",
    question:
      "A team wants Memcached because it benchmarks faster on plain gets. The product also needs a leaderboard, pub/sub, and persistence. How do you run the decision?",
    difficulty: 2,
    hints: [
      "Start with capabilities, not throughput.",
      "The cost of a missing primitive appears in the fallback path.",
    ],
    answer:
      "I would write the capability list first: sorted sets with range queries, pub/sub, and persistence are required, and Memcached provides none of them. That means those paths need another system, so the comparison is not Memcached versus Redis; it is Memcached plus a second system versus Redis. I would measure the fallback load and failure modes, then benchmark Redis and any remaining candidate with production value sizes. Memcached could still serve the plain key-value subset if the split is worth the extra tier, but that is an architecture decision, not a benchmark result.",
    followUps: [
      "When would the split architecture be worth it?",
      "How would you measure the fallback cost?",
      "What operational work does Redis add?",
    ],
    redFlags: [
      "Picks the faster benchmark without a capability check.",
      "Assumes the database can absorb the fallback indefinitely.",
      "Treats the engines as drop-in replacements.",
    ],
    rubric: [
      "Starts with required primitives.",
      "Names the fallback path and its cost.",
      "Compares architectures, not only engines.",
      "Includes production-sized benchmarking.",
    ],
  },
  {
    id: "threading",
    question:
      "Why can Memcached scale a single large node across CPU cores while Redis is often described as single-threaded?",
    difficulty: 2,
    hints: [
      "Distinguish network I/O from command execution.",
      "Redis can shard across processes or nodes.",
    ],
    answer:
      "Memcached uses a multithreaded worker model, so one process can use multiple cores for cache operations. Redis executes commands on one thread per shard; I/O threading can move network work, but the command execution path remains single-threaded per shard. Redis scales horizontally with replicas for reads and sharding for writes, while Memcached scales vertically within a node and horizontally through client-side sharding. The right comparison is the whole topology and its failure modes, not a single-node thread count.",
    followUps: [
      "When does vertical scaling stop helping Memcached?",
      "How does Redis Cluster change the single-thread story?",
      "Which model is easier to operate for your team?",
    ],
    redFlags: [
      "Says Redis cannot use more than one core anywhere.",
      "Compares one Redis shard with a whole Memcached fleet.",
      "Ignores client-side sharding.",
    ],
    rubric: [
      "Separates I/O from command execution.",
      "Explains per-shard threading.",
      "Orders scale-out options.",
      "Compares topologies.",
    ],
  },
  {
    id: "split-architecture",
    question:
      "The team wants Memcached for plain lookups and Redis for leaderboards. What does the split cost?",
    difficulty: 3,
    hints: [
      "Two caches mean two failure domains and two invalidation paths.",
      "The routing decision belongs in the application.",
    ],
    answer:
      "The split gives each workload an engine that fits it, but it adds a second cache tier, a routing rule, and a second set of credentials, dashboards, and failure modes. If the same logical object appears in both tiers, invalidation has to reach both or the copies will disagree. The application must decide which path serves each endpoint, and that decision must be tested under partial failure. I would only take the split if the plain-lookup volume is large enough to justify it and the two datasets are genuinely separate. Otherwise one Redis tier is simpler to operate and reason about.",
    followUps: [
      "How would you route reads between the tiers?",
      "What happens when one tier is unavailable?",
      "How would you keep the caches coherent?",
    ],
    redFlags: [
      "Adds a second tier without an ownership rule.",
      "Shares keys across both caches without invalidation.",
      "Ignores partial failure.",
    ],
    rubric: [
      "Names the operational costs.",
      "Defines ownership and routing.",
      "Addresses coherence.",
      "States when the split is worth it.",
    ],
  },
];

const checklist = [
  {
    title: "Before choosing",
    items: [
      "The workload's required primitives and durability are written down.",
      "Every feature the cache cannot provide has a named fallback system.",
      "The threading model and failure behavior of each candidate are understood.",
      "The benchmark uses production value sizes and access patterns.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the failure is latency, a missing primitive, or a fallback overload.",
      "Measure origin load separately from cache hit rate.",
      "Check whether a client-side sharding change moved load to one node.",
      "Do not add cache capacity for a capability gap.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Revisit the engine choice with the fallback cost included.",
      "Document which paths depend on which cache.",
      "Re-run the benchmark with the whole workload.",
      "Record the operational cost the team accepted.",
    ],
  },
];

const references = [
  {
    title: "Redis vs Memcached",
    url: "https://redis.io/compare/redis-vs-memcached/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Feature comparison published by Redis; treat vendor framing accordingly.",
  },
  {
    title: "Memcached documentation",
    url: "https://docs.memcached.org/",
    publisher: "Memcached",
    kind: "docs" as const,
    note: "Protocol, client behavior, and the key-value data model.",
  },
  {
    title: "Redis data types",
    url: "https://redis.io/docs/latest/develop/data-types/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "The structures that Memcached does not provide.",
  },
  {
    title: "Memcached wiki",
    url: "https://github.com/memcached/memcached/wiki",
    publisher: "Memcached project",
    kind: "docs" as const,
    note: "Deployment and client-sharding guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "redis-vs-memcached": {
      model: redisVsMemcachedModel,
      presets,
      instructions:
        "Start healthy, then apply Memcached only. Compare the lower cache p99 with the missing primitives and origin load. Switch back to Redis and apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Per-node capacity values are teaching numbers, not engine limits. Feature availability reflects the documented data models.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["caching-redis-data-types", "caching-aside-vs-write-through", "foundations-caching-strategies"],
};
