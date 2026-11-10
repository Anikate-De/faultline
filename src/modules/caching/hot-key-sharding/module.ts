import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOT_INDEX = 2;
const SHARD_CAPACITY = 12_000;
const REPLICA_CAPACITY = 40_000;

const params = [
  {
    id: "totalRps",
    label: "Total request rate",
    min: 5_000,
    max: 200_000,
    step: 5_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Read requests arriving at the service before the local cache or Redis.",
    format: "rps" as const,
  },
  {
    id: "hotKeyShare",
    label: "Hot key share",
    min: 0,
    max: 80,
    step: 1,
    value: 10,
    unit: "%",
    group: "Traffic",
    help: "Share of reads that hit one key. This is the concentration that creates the hot shard.",
    format: "percent" as const,
  },
  {
    id: "shardCount",
    label: "Redis shards",
    min: 4,
    max: 32,
    step: 4,
    value: 8,
    unit: "",
    group: "Topology",
    help: "Primaries in the Redis Cluster. More shards raise aggregate capacity; they do not split one key.",
    format: "count" as const,
  },
  {
    id: "localCacheHit",
    label: "Local cache hit rate",
    min: 0,
    max: 95,
    step: 5,
    value: 0,
    unit: "%",
    group: "Mitigations",
    help: "Share of reads absorbed by an in-process cache before Redis. Fast, but per-instance staleness.",
    format: "percent" as const,
  },
  {
    id: "saltFanout",
    label: "Key salt fan-out",
    min: 1,
    max: 16,
    step: 1,
    value: 1,
    unit: " keys",
    group: "Mitigations",
    help: "Number of deterministic subkeys the hot key is spread across. Readers must fan out across all of them.",
    format: "count" as const,
  },
  {
    id: "replicaOffload",
    label: "Read replica offload",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Mitigations",
    help: "Share of Redis reads sent to replicas. Offloads the primary but adds replication lag and stale reads.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface ShardState {
  index: number;
  cpu: number;
  p99: number;
  errors: number;
  ops: number;
  hot: boolean;
}

interface Computed {
  shards: ShardState[];
  maxCpu: number;
  maxOps: number;
  redisRps: number;
  dbQps: number;
  dbCpu: number;
  replicaCpu: number;
  replicaLag: number;
  staleness: number;
  hitRate: number;
  totalRps: number;
  hotShare: number;
  salt: number;
  local: number;
  offload: number;
  redisP99: number;
  redisErrors: number;
}

function compute(p: Params): Computed {
  const totalRps = num(p, "totalRps", 30_000);
  const hotShare = num(p, "hotKeyShare", 15) / 100;
  const shardCount = Math.round(num(p, "shardCount", 8));
  const local = num(p, "localCacheHit", 0) / 100;
  const salt = Math.max(1, Math.round(num(p, "saltFanout", 1)));
  const offload = num(p, "replicaOffload", 0) / 100;
  const redisRps = totalRps * (1 - local);
  const hotOps = redisRps * hotShare;
  const otherOps = redisRps * (1 - hotShare);
  const targetCount = Math.min(salt, shardCount);
  const hotTargets = new Set(Array.from({ length: targetCount }, (_, index) => (HOT_INDEX + index) % shardCount));
  const shards: ShardState[] = Array.from({ length: shardCount }, (_, index) => {
    const ops = otherOps / shardCount + (hotTargets.has(index) ? hotOps / targetCount : 0);
    const cpu = clamp((ops / SHARD_CAPACITY) * 100, 0, 100);
    const p99 = cpu >= 100 ? 500 : 1.5 + (45 * (cpu / 100) ** 5) / Math.max(0.05, 1.05 - cpu / 100);
    const errors = cpu > 95 ? Math.min(25, (cpu - 95) * 1.5) : 0;
    return {
      index,
      cpu,
      p99: Math.min(500, p99),
      errors,
      ops,
      hot: index === HOT_INDEX && targetCount === 1 && hotShare >= 0.25,
    };
  });
  const maxCpu = Math.max(...shards.map((shard) => shard.cpu));
  const maxOps = Math.max(...shards.map((shard) => shard.ops));
  const dbQps = totalRps * 0.04 * (1 - local);
  const replicaCpu = (maxOps * offload) / (2 * REPLICA_CAPACITY) * 100;
  const replicaLag = offload * hotShare * 5;
  const staleness = local * 1.2 + offload * 0.4;
  return {
    shards,
    maxCpu,
    maxOps,
    redisRps,
    dbQps,
    dbCpu: clamp((dbQps / 30_000) * 100, 0, 140),
    replicaCpu,
    replicaLag,
    staleness,
    hitRate: 96 + 4 * local,
    totalRps,
    hotShare,
    salt: targetCount,
    local,
    offload,
    redisP99: Math.max(...shards.map((shard) => shard.p99)),
    redisErrors: Math.max(...shards.map((shard) => shard.errors)),
  };
}

function healthFor(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.96 + 0.06 * Math.sin((offset + (seed % 9)) / 2.7);
  const metricSeed: [string, number, number][] = [
    ["hot-shard-cpu", values.maxCpu, 4],
    ["redis-p99", values.redisP99, 8],
    ["redis-errors", values.redisErrors, 0.3],
    ["db-cpu", values.dbCpu, 3],
    ["replica-lag", values.replicaLag, 0.2],
    ["staleness", values.staleness, 0.15],
    ["cache-hit-rate", values.hitRate, 0.5],
    ["replica-cpu", values.replicaCpu, 4],
    ["total-rps", values.totalRps, 400],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  for (const shard of values.shards) {
    frame.series[`cpu.shard-${shard.index}`] = Array.from({ length }, (_, index) =>
      Math.max(0, shard.cpu * jitter(index + shard.index) + Math.sin(index / 2.3 + shard.index) * 3),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(paramsValue: Params, seed: number): SimFrame {
  const values = compute(paramsValue);
  const redisHealth = healthFor(values.maxCpu);
  const dbHealth = healthFor(values.dbCpu);
  const replicaHealth = healthFor(values.replicaCpu);
  const lagHealth = values.replicaLag >= 5 ? "crit" : values.replicaLag >= 1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "reads + writes",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Catalog service",
        kind: "service",
        health: values.maxCpu >= 120 ? "warn" : "ok",
        utilization: clamp(values.totalRps / 120_000),
        throughput: values.totalRps,
        sublabel: `${Math.round(values.totalRps).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis Cluster",
        kind: "cache",
        health: redisHealth,
        utilization: values.maxCpu / 100,
        throughput: values.redisRps,
        sublabel: `${values.salt} shard${values.salt === 1 ? "" : "s"} bearing the hot key`,
        meta: { view: "flow" },
      },
      {
        id: "replica",
        label: "Read replicas",
        kind: "cache",
        role: "replica",
        health: replicaHealth === "ok" ? lagHealth : replicaHealth,
        utilization: values.replicaCpu / 100,
        sublabel: `${formatLag(values.replicaLag)} lag`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Catalog DB",
        kind: "db",
        health: dbHealth,
        utilization: values.dbCpu / 100,
        throughput: values.dbQps,
        sublabel: `${Math.round(values.dbQps).toLocaleString()} qps`,
        meta: { view: "flow" },
      },
      ...values.shards.map((shard) => ({
        id: `shard-${shard.index}`,
        label: `shard-${shard.index}`,
        kind: "cache" as const,
        role: "shard" as const,
        health: healthFor(shard.cpu),
        utilization: shard.cpu / 100,
        throughput: shard.ops,
        sublabel: shard.hot ? "hot key" : "keyspace",
        detail: `${formatCpu(shard.cpu)} CPU, p99 ${shard.p99.toFixed(0)}ms, ${Math.round(shard.ops).toLocaleString()} ops/s. Illustrative capacity: ${SHARD_CAPACITY.toLocaleString()} ops/s per shard.`,
        meta: {
          view: "shards",
          cpu: shard.cpu,
          memory: 3.2 + values.totalRps / 240_000,
          p99: shard.p99,
          hot: shard.hot ? 1 : 0,
        },
      })),
    ],
    edges: [
      edge("client-service", "client", "service", values.totalRps / 120_000),
      edge("service-redis", "service", "redis", values.redisRps / values.totalRps, redisHealth),
      edge("service-replica", "service", "replica", values.offload, replicaHealth === "ok" ? lagHealth : replicaHealth),
      edge("service-db", "service", "db", values.dbQps / Math.max(1, values.totalRps), dbHealth),
    ],
    metrics: [
      metric("hot-shard-cpu", "Hot shard CPU", values.maxCpu, "%", 70, 85, "percent"),
      metric("redis-p99", "Redis p99", values.redisP99, "ms", 40, 120, "ms"),
      metric("redis-errors", "Redis errors", values.redisErrors, "%", 0.5, 2, "percent"),
      metric("db-cpu", "Database CPU", values.dbCpu, "%", 75, 90, "percent"),
      metric("replica-lag", "Replica lag", values.replicaLag, "s", 1, 5, "number"),
      metric("staleness", "Local staleness", values.staleness, "s", 1, 3, "number"),
      metric("cache-hit-rate", "Cache hit rate", values.hitRate, "%", undefined, undefined, "percent"),
      metric("replica-cpu", "Replica max CPU", values.replicaCpu, "%", 75, 90, "percent"),
      metric("total-rps", "Total RPS", values.totalRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      hotIndex: HOT_INDEX,
      targetCount: values.salt,
      paramsKey: JSON.stringify(paramsValue),
    },
    summary: `${formatCpu(values.maxCpu)} on the hottest shard; p99 ${values.redisP99.toFixed(0)}ms; ${values.redisErrors.toFixed(1)}% errors.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

function formatCpu(cpu: number): string {
  return cpu >= 100 ? "100+%" : `${cpu.toFixed(0)}%`;
}

function formatLag(seconds: number): string {
  return seconds < 1 ? `${(seconds * 1000).toFixed(0)}ms` : `${seconds.toFixed(1)}s`;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-shard-cpu",
    metricId: "hot-shard-cpu",
    warn: 70,
    crit: 85,
    title: "Hot shard CPU crossed the critical threshold",
    cause: "One shard owns a disproportionate share of reads. Aggregate cluster CPU can look healthy while this shard queues.",
    fix: "Reduce traffic to the hot shard before adding aggregate capacity. Local caching, salting, or read replicas each address a different part of the problem.",
    checkFirst: [
      "Compare per-shard CPU and ops, not the cluster average.",
      "Find the key with the highest command count on the hot shard.",
      "Check whether the current read path can use a local cache or replica.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Redis p99 breached the latency SLO",
    cause: "The hot shard is queueing commands. Averages hide it because the other shards are fast and mostly idle.",
    fix: "Remove read pressure from the hot shard, then verify p99 per shard. Do not diagnose from the cluster-wide p99.",
    checkFirst: [
      "Graph p99 by shard or node dimension.",
      "Check Redis slowlog and client-side timeouts.",
      "Check whether retries are multiplying reads.",
    ],
  },
  {
    id: "redis-errors",
    metricId: "redis-errors",
    warn: 0.5,
    crit: 2,
    title: "Redis timeouts and errors are reaching requests",
    cause: "The hot shard is at or beyond its usable capacity, so commands time out before the service can fall back.",
    fix: "Reduce load on the shard and add a bounded fallback. A timeout retry without a budget makes the shard worse.",
    checkFirst: [
      "Separate client timeouts from server errors.",
      "Check connection pool wait and retry volume.",
      "Confirm the fallback path is bounded and returns a clear error.",
    ],
  },
  {
    id: "db-cpu",
    metricId: "db-cpu",
    warn: 75,
    crit: 90,
    title: "The database is absorbing cache misses",
    cause: "Requests that miss the hot shard are falling through to the database, which has much less headroom than the cache.",
    fix: "Protect the database with request coalescing, negative caching, or load shedding. A cache fix that shifts load to the database is not a fix.",
    checkFirst: [
      "Compare database QPS with cache miss rate.",
      "Check for a stampede or a single missing key.",
      "Check whether a fallback is unbounded.",
    ],
  },
  {
    id: "replica-lag",
    metricId: "replica-lag",
    warn: 1,
    crit: 5,
    title: "Read replica lag exceeds the freshness budget",
    cause: "Replica offload reduces primary CPU but asynchronous replication means some reads can be stale.",
    fix: "Keep freshness-sensitive reads on the primary or use a version token. Reduce offload if the product cannot tolerate the lag.",
    checkFirst: [
      "Check lag per replica, not the fleet average.",
      "Identify reads that must be read-your-writes.",
      "Check whether a hot key also dominates replica reads.",
    ],
  },
  {
    id: "staleness",
    metricId: "staleness",
    warn: 1,
    crit: 3,
    title: "Local cache staleness exceeds the product contract",
    cause: "An in-process cache absorbs reads before Redis but cannot see writes on other instances until its TTL or invalidation arrives.",
    fix: "Shorten the TTL, add versioned invalidation, or bypass the local cache for writes and immediately visible reads.",
    checkFirst: [
      "Check the local cache TTL and invalidation path.",
      "Check whether the product requires read-your-writes.",
      "Check whether all instances receive the invalidation.",
    ],
  },
  {
    id: "replica-cpu",
    metricId: "replica-cpu",
    warn: 75,
    crit: 90,
    title: "The read replica is now the hot path",
    cause: "Offloading a hot key to replicas moved the concentration; the hottest replica can saturate even when the primary is healthy.",
    fix: "Reduce per-replica hot-key load with salting or local caching, or add enough replicas to spread the reads.",
    checkFirst: [
      "Check CPU per replica, not the replica fleet average.",
      "Check whether one key dominates replica reads.",
      "Check whether the routing sends all offload to one replica.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const hotKeyModel: SimModel = {
  id: "caching-hot-key-sharding",
  visual: "shards",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const jitter = rng.between(-0.2, 0.2);
    const maxCpu = Math.min(140, Math.max(0, values.maxCpu + jitter));
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    }
    next.metrics = next.metrics.map((item) =>
      item.id === "hot-shard-cpu" ? { ...item, value: maxCpu } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const shard of next.nodes.filter((node) => node.meta?.view === "shards")) {
      recordSeries(next, `cpu.${shard.id}`, Number(shard.meta?.cpu ?? 0));
    }
    if (values.hotShare >= 0.3 && frame.flags.hotDetected !== 1) {
      pushEvent(next, {
        id: "hot-key-detected",
        at: frame.t,
        severity: "warn",
        title: "Hot key detected",
        detail: `${Math.round(values.hotShare * 100)}% of reads land on one key. The hottest shard carries ${formatCpu(values.maxCpu)} CPU while the cluster average is much lower.`,
        nodeId: `shard-${HOT_INDEX}`,
        metricId: "hot-shard-cpu",
      });
      next.flags.hotDetected = 1;
    }
    if (values.hotShare < 0.3) next.flags.hotDetected = 0;
    next.flags.paramsKey = key;
    next.flags.maxCpu = maxCpu;
    next.summary = `${formatCpu(maxCpu)} on the hottest shard; p99 ${values.redisP99.toFixed(0)}ms; ${values.redisErrors.toFixed(1)}% errors.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const shards = values.shards;
    const hotShard = shards.reduce((best, shard) => (shard.cpu > best.cpu ? shard : best), shards[0]);
    const items: string[] = [];
    if (values.maxCpu >= 85) {
      items.push(`The cluster's usable capacity is set by shard-${hotShard.index} at ${formatCpu(values.maxCpu)} CPU, not by the average.`);
    } else {
      items.push(`The hottest shard is shard-${hotShard.index} at ${formatCpu(values.maxCpu)} CPU; the distribution is the signal.`);
    }
    if (values.local > 0) {
      items.push(`The local cache absorbs ${Math.round(values.local * 100)}% of reads before Redis, but can serve data up to ${values.staleness.toFixed(1)}s stale.`);
    }
    if (values.salt > 1) {
      items.push(`Salting fans the hot key across ${values.salt} shards; every read must query all ${values.salt} variants, so the client and key migration matter.`);
    }
    if (values.offload > 0) {
      items.push(`Replicas take ${Math.round(values.offload * 100)}% of Redis reads; the hottest replica is at ${formatCpu(values.replicaCpu)} CPU with ${formatLag(values.replicaLag)} lag.`);
    }
    items.push(`Total Redis load is ${Math.round(values.redisRps).toLocaleString()} rps; the database sees ${Math.round(values.dbQps).toLocaleString()} qps from cache misses.`);
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
    description: "Even distribution at a comfortable shard CPU.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High traffic but within the shard's capacity.",
    tone: "warn",
    params: defaults({ totalRps: 80_000, hotKeyShare: 4, shardCount: 16 }),
  },
  {
    id: "failure",
    label: "Hot key",
    description: "One key takes 55% of 80k reads; the hot shard saturates.",
    tone: "crit",
    params: defaults({ totalRps: 80_000, hotKeyShare: 55 }),
  },
  {
    id: "local-cache",
    label: "Add local cache",
    description: "Absorb most reads in-process. Redis CPU falls; staleness rises.",
    tone: "warn",
    params: defaults({ totalRps: 80_000, hotKeyShare: 55, localCacheHit: 85 }),
  },
  {
    id: "salting",
    label: "Salt the key",
    description: "Spread the hot key across 16 subkeys. Distribution improves; readers fan out.",
    tone: "ok",
    params: defaults({ totalRps: 80_000, hotKeyShare: 55, shardCount: 16, saltFanout: 16 }),
  },
  {
    id: "replicas",
    label: "Add replicas",
    description: "Offload 80% of reads. Primary CPU falls; the hottest replica and lag become the constraint.",
    tone: "warn",
    params: defaults({ totalRps: 80_000, hotKeyShare: 55, replicaOffload: 80 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Combine a small local cache, salting, and conservative replica offload.",
    tone: "ok",
    params: defaults({ totalRps: 80_000, hotKeyShare: 55, localCacheHit: 60, saltFanout: 8, replicaOffload: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-hot-shard",
  title: "Predict which shard saturates",
  simId: "hot-key",
  question:
    "Raise the hot key to 55% of 80k reads. Which part of the cluster crosses its critical threshold first?",
  prediction: {
    options: [
      { id: "hot-shard", label: "The shard that owns the hot key" },
      { id: "random-shard", label: "A random shard" },
      { id: "all-shards", label: "All shards equally" },
      { id: "database", label: "The database" },
    ],
    correctOptionId: "hot-shard",
    explanation:
      "The key maps to one hash slot, and that slot lives on one shard. The other shards serve the remaining keys and stay near their baseline. Aggregate CPU and hit rate look healthy while one shard queues.",
  },
  setup: defaults({ totalRps: 80_000, hotKeyShare: 55 }),
  runFor: 20,
  observe: [
    "Hot shard CPU crosses 85% while the other shards stay below 50%.",
    "Redis p99 rises sharply because queueing is nonlinear.",
    "Redis errors and client timeouts appear once the shard is beyond usable capacity.",
    "The database stays moderately loaded; the cache is the bottleneck, not the database.",
  ],
  explain:
    "A hot key is a partitioning problem. Adding shards raises aggregate capacity but does not split the key's slot. The fix must change how the key is stored or where its reads are served: a local cache, salting, read replicas, or a combination. Each changes a different tradeoff.",
  fix: defaults({ totalRps: 80_000, hotKeyShare: 55, localCacheHit: 60, saltFanout: 8, replicaOffload: 30 }),
  debrief:
    "The combined fix brings the hottest shard below the warning threshold and keeps staleness and replica lag below one second. It also adds per-instance cache coherence work, a fan-out read path, and replica routing complexity. That is the real cost of recovery.",
};

const primer: Block[] = [
  {
    type: "h2",
    text: "What it is",
  },
  {
    type: "p",
    text: "Redis Cluster divides the keyspace into 16,384 hash slots. Each key maps to one slot, and each slot is owned by one primary shard. A shard is a single-threaded command processor with a finite capacity. When one key receives a large share of reads, its slot and its shard receive that load while the rest of the cluster has spare capacity. That is a hot key.",
  },
  {
    type: "p",
    text: "The failure is easy to miss. Cluster CPU can sit at 30% and the cache hit rate at 96% while one shard is at 95% CPU, queueing commands and timing out. A bigger cluster does not fix it: the key still maps to one slot. The fixes change either the key's distribution or the path that serves its reads.",
  },
  {
    type: "h2",
    text: "Where it sits",
  },
  {
    type: "diagram",
    id: "hot-key-shards",
    caption: "One key, one hash slot, one shard. The other shards are not helping because they do not own that slot.",
  },
  {
    type: "p",
    text: "The request path is client, service, Redis Cluster, then the database on a cache miss. A local cache sits inside the service instance before Redis. Read replicas sit beside the primary shards and receive reads asynchronously. Salting changes the key before it reaches Redis, so the hot value is stored under several deterministic subkeys.",
  },
  {
    type: "p",
    text: "This module models a catalog read path at 5k–200k requests per second. The shard capacity, p99 curve, and error thresholds are illustrative teaching values. They are not ElastiCache limits or a capacity guarantee. The shape of the failure is the lesson: per-shard saturation, nonlinear latency, and a fix whose cost appears somewhere else.",
  },
  {
    type: "h2",
    text: "What you'll see",
  },
  {
    type: "list",
    items: [
      "Hot shard CPU: the maximum across shards, with a warning at 70% and critical at 85%.",
      "Redis p99 and error rate: the hot shard's queueing and timeouts, not the cluster average.",
      "Database CPU: the cost of cache misses falling through to a smaller system.",
      "Replica lag and local staleness: the freshness price of the two offload fixes.",
      "A shard heat map: the distribution over time, which makes the partition obvious.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Hot key. Open Flow to see the request path and Shards to see per-shard CPU. Switch to Heatmap to watch the distribution. Run the guided experiment before you read the debrief: predict which shard fails, then apply a fix and re-run.",
  },
  {
    type: "table",
    headers: ["Mitigation", "What it fixes", "What it costs"],
    rows: [
      ["Local in-process cache", "Removes most reads before Redis, fastest to deploy", "Per-instance staleness; invalidation must reach every instance"],
      ["Key salting", "Spreads one key across several shards", "Readers fan out across variants; migration and key management"],
      ["Read replicas", "Offloads reads from the saturated primary", "Replication lag, stale reads, and a new hot replica"],
      ["More shards", "Adds aggregate capacity for many keys", "Does not split one hot key; resharding still adds work"],
    ],
  },
  {
    type: "p",
    text: "The first question is not which fix is best. It is which constraint you are allowed to violate. If the product cannot tolerate stale reads, a local cache needs a versioned invalidation path. If every reader cannot fan out, salting needs a migration layer. If the replica cannot keep up, replicas move the hot spot. Pick the smallest fix whose failure mode you can explain.",
  },
  { type: "sim", simId: "hot-key" },
  { type: "experiment", experimentId: "predict-hot-shard" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The hot key hashed to one shard. That shard's command queue grew until p99 rose, then timeouts and errors appeared. The other shards stayed busy, so the cluster average looked modest. Resizing the cluster or adding shards would not split the key's slot, which is why the failure survived the obvious capacity response.",
  },
  {
    type: "p",
    text: "A local cache removed reads before Redis but made each instance's view of the key potentially stale. Salting spread the key across several shards but required every reader to query all variants. Replicas reduced primary load but introduced lag and a new concentration on the hottest replica. The combined recovery used a small local cache, salting, and conservative offload, and the remaining cost was operational complexity rather than CPU.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ElastiCache/Redis: `EngineCPUUtilization`, `CPUUtilization`, `CurrConnections`, `CacheHits`, `CacheMisses`, `Evictions`, and `GetTypeCmds`, split by node or shard where available.",
      "Datadog: `redis.cpu.utilization`, `redis.keyspace_hits`, `redis.keyspace_misses`, `redis.latency.p99`, and client timeout counters, grouped by `cluster` and `node`.",
      "Grafana/VictoriaMetrics: per-shard CPU and ops, plus a histogram of Redis command latency. Do not trust the cluster-wide average.",
      "Logs: client timeouts, `MOVED`/`ASK` redirects, connection pool waits, and fallback errors. A retry line that repeats in a burst is a clue, not noise.",
      "Traces: the cache span is slow while the database span is normal. That separates a cache queue from a database problem.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare per-shard CPU and ops. Find the key with the highest command count on the hot shard. Check whether the read path can use a local cache or a replica without violating the product's freshness contract. Only then choose a mitigation.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the hot key, not a cluster-wide capacity problem: per-shard CPU, per-key command counts, and p99 by shard.",
      "Protect the request path: bound retries and add a fallback so a slow cache does not become a slow product.",
      "If the read can tolerate seconds of staleness, add a local cache with a short TTL and a versioned invalidation path.",
      "If every reader can fan out, salt the hot key across deterministic subkeys and migrate reads in a controlled order.",
      "If freshness allows, offload reads to replicas and watch the hottest replica, not the fleet average.",
      "Re-run the load at peak and verify the hottest shard, p99, error rate, staleness, and replica lag together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Local caching is the fastest mitigation and the easiest to get wrong: invalidation must reach every instance, and memory is now per task.",
      "Salting spreads the key but turns one read into N reads and requires a migration that can serve both key shapes during rollout.",
      "Replicas reduce primary CPU but add lag, stale-read risk, and a new hot replica if the key remains concentrated.",
      "Adding shards increases aggregate capacity but does not split one key; resharding has its own redirects and client requirements.",
      "Each fix moves the bottleneck. Verify the next one.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-hot-key",
    question:
      "Redis Cluster CPU is 35%, the hit rate is 96%, and p99 is 900ms. How do you determine whether this is a hot key?",
    difficulty: 3,
    hints: [
      "The cluster average can be healthy while one shard queues.",
      "You need a per-shard and per-key view.",
    ],
    answer:
      "I would split the signal by shard and by key. Check per-shard CPU, ops, and p99; if one shard is above 85% while the others are near 20%, the cluster average is hiding the problem. Then check per-key command counts or a sampled hot-key view. I would also check client timeouts, slowlog entries, and whether retries are multiplying reads. A hot key is confirmed when one key or hash slot explains the load concentration and the other shards have spare capacity.",
    followUps: [
      "What if every shard is at 80%?",
      "Which metric would you put on the incident dashboard first?",
      "How would a read replica change the diagnosis?",
    ],
    redFlags: [
      "Adds shards before checking the distribution.",
      "Uses cluster-wide CPU as proof of health.",
      "Blames the database without checking cache misses.",
    ],
    rubric: [
      "Names per-shard and per-key evidence.",
      "Distinguishes a hot key from aggregate capacity.",
      "Checks retries and client timeouts.",
      "States what would falsify the hypothesis.",
    ],
  },
  {
    id: "choose-mitigation",
    question:
      "You can add a local cache, salt the key, or add read replicas. How do you choose under incident pressure?",
    difficulty: 3,
    hints: [
      "Start with the product's freshness contract.",
      "Rank by time-to-mitigate, then by the new failure mode.",
    ],
    answer:
      "I rank by time-to-mitigate and by which constraint the product can tolerate. A local cache is usually fastest and removes the most Redis reads, but it introduces per-instance staleness, so the product must tolerate that or have a working invalidation path. Salting spreads the key across shards and keeps a single source of truth, but every reader must fan out and the migration has to serve both key shapes. Replicas offload reads without changing the key, but lag makes some reads stale and the hottest replica can become the next bottleneck. I would pick the smallest change that protects the SLO, add a bounded fallback, and measure the next limit before declaring recovery.",
    followUps: [
      "What would make you combine fixes?",
      "How do you roll back salting?",
      "What is the operational cost of a local cache during a deploy?",
    ],
    redFlags: [
      "Picks a fix without naming a tradeoff.",
      "Assumes replicas are always fresh.",
      "Salts without a migration plan.",
    ],
    rubric: [
      "Ties the choice to a freshness budget.",
      "Names time-to-mitigate and blast radius.",
      "Explains the next bottleneck.",
      "Describes rollback.",
    ],
  },
  {
    id: "why-not-resize",
    question:
      "Why does resizing the Redis cluster not fix a single hot key?",
    difficulty: 2,
    hints: [
      "A key maps to one hash slot.",
      "Adding shards changes aggregate capacity, not the slot owner.",
    ],
    answer:
      "A key maps to one of 16,384 hash slots, and the slot is owned by one shard. Adding shards increases the number of slots and aggregate capacity, but the hot key still lives in its original slot. Resharding can move the slot, but it moves the whole slot, not the single key, and clients must handle redirects. The key's read concentration remains unless the key is split, cached earlier, or served elsewhere.",
    followUps: [
      "Can you move a single key without moving the slot?",
      "What do clients need to handle during a reshard?",
      "When would adding shards still help?",
    ],
    redFlags: [
      "Says more shards split the key.",
      "Ignores hash slots.",
      "Forgets client redirect handling.",
    ],
    rubric: [
      "Explains hash slots.",
      "Distinguishes aggregate capacity from hot-key capacity.",
      "Mentions resharding and redirects.",
    ],
  },
  {
    id: "salt-migration",
    question:
      "You decide to salt the hot key. How do you migrate reads and writes without serving partial or missing data?",
    difficulty: 4,
    hints: [
      "Read all variants during the transition.",
      "Write new variants before removing the old key.",
    ],
    answer:
      "I would use a dual-read, dual-write transition. Add the salted variants and write them alongside the unsalted key, then migrate reads by fanning out across all variants and falling back to the old key when a variant is missing. Once the new path is verified, remove the old writes, then the old reads, then the old key after a TTL. I would version the key scheme so a rollback can still read the previous shape, and I would measure fan-out latency and error rate at each step. The tradeoff is more Redis operations and a longer migration, but no single step loses data.",
    followUps: [
      "How do you handle a partial write during the transition?",
      "What happens if one salted variant is hot?",
      "How long do you keep the old key?",
    ],
    redFlags: [
      "Deletes the old key before backfilling.",
      "Reads only one variant and calls it done.",
      "Has no rollback for the key scheme.",
    ],
    rubric: [
      "Dual-read/dual-write sequence.",
      "Versioned key scheme and rollback.",
      "Measures fan-out and errors.",
      "States the migration cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show per-shard CPU, ops, p99, and errors, not only cluster averages.",
      "A hot-key detection method exists and its sample rate is understood.",
      "The product's freshness contract is written down for every read path.",
      "Local cache TTL and invalidation behavior are tested across instances.",
      "Salting has a migration and rollback plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the hot shard and the key before changing capacity.",
      "Bound retries and fallback; do not let a cache timeout become a request storm.",
      "Pick the fix by freshness budget and time-to-mitigate, not by preference.",
      "Watch the next bottleneck: database, replica CPU, or replication lag.",
      "Record decisions and timestamps for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the hottest shard, p99, errors, staleness, and lag at peak.",
      "Remove temporary bypasses and reconcile the key scheme.",
      "Document the tradeoff that remains in production.",
      "Add a regression experiment to the module or runbook.",
    ],
  },
];

const references = [
  {
    title: "Redis cluster specification",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Hash slots, redirects, and resharding.",
  },
  {
    title: "Amazon ElastiCache best practices",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Caching patterns, scaling, and monitoring.",
  },
  {
    title: "Redis latency troubleshooting",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Event loop, slow commands, and latency signals.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hot-key": {
      model: hotKeyModel,
      presets,
      instructions:
        "Start healthy, apply the hot-key preset, then compare local caching, salting, and replicas. Watch the hottest shard, not the cluster average.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "heatmap"],
      note: "Illustrative model. Shard capacity is 12k ops/s in this teaching scenario, not an ElastiCache guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-hot-key-detection",
    "caching-key-salting",
    "caching-local-cache",
    "caching-read-replicas",
    "caching-hot-shard-cluster",
  ],
};
