import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REDIS_CAPACITY = 30_000;
const HOT_KEYS = 40_000;
const ENTRY_BYTES = 220;
const WRITE_SHARE = 0.04;
const DB_CAPACITY = 8_000;
const APP_RPS_PER_TASK = 4_000;

const params = [
  {
    id: "readRps",
    label: "Read rate",
    min: 5_000,
    max: 80_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Reads per second arriving at the service. The hot key is a large share of this traffic.",
    format: "rps" as const,
  },
  {
    id: "hotKeySharePct",
    label: "Hot-key read share",
    min: 10,
    max: 90,
    step: 5,
    value: 60,
    unit: "%",
    group: "Traffic",
    help: "Share of reads that target the hot key set the local cache can hold. This is the ceiling on the local hit rate.",
    format: "percent" as const,
  },
  {
    id: "ttlSeconds",
    label: "Local cache TTL",
    min: 2,
    max: 120,
    step: 2,
    value: 30,
    unit: "s",
    group: "Freshness",
    help: "Time to live for each task's local copy. A short TTL lowers staleness but lowers the hit rate and sends more reads to Redis.",
    format: "number" as const,
  },
  {
    id: "invalidationDelayMs",
    label: "Invalidation delay",
    min: 50,
    max: 60_000,
    step: 500,
    value: 500,
    unit: "ms",
    group: "Freshness",
    help: "Time for a write invalidation to reach every task. This, not the TTL, sets the normal stale window.",
    format: "ms" as const,
  },
  {
    id: "instanceCount",
    label: "Service tasks",
    min: 2,
    max: 40,
    step: 1,
    value: 12,
    unit: "",
    group: "Fleet",
    help: "Tasks with their own local cache. Memory grows linearly with task count; hit rate does not.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  readRps: number;
  hotShare: number;
  ttl: number;
  delaySeconds: number;
  instances: number;
  hitRate: number;
  redisOps: number;
  redisUtil: number;
  redisP99: number;
  staleSeconds: number;
  memoryMb: number;
  dbQps: number;
  entriesPerTask: number;
  appUtil: number;
}

function compute(p: Params, noise = 1): Values {
  const readRps = Math.max(1, num(p, "readRps", 20_000) * noise);
  const hotShare = clamp(num(p, "hotKeySharePct", 60) / 100);
  const ttl = Math.max(2, num(p, "ttlSeconds", 30));
  const delaySeconds = Math.max(0, num(p, "invalidationDelayMs", 500) / 1_000);
  const instances = Math.max(2, Math.round(num(p, "instanceCount", 12)));

  const hitRate = hotShare * (ttl / (ttl + 8));
  const writes = readRps * WRITE_SHARE;
  const redisOps = readRps * (1 - hitRate) + writes;
  const redisUtil = redisOps / REDIS_CAPACITY;
  const redisP99 =
    redisUtil <= 1 ? 1.5 + 45 * redisUtil ** 8 : 45 + 180 * Math.log2(redisUtil);
  const staleSeconds = Math.min(ttl, delaySeconds + 0.05);
  const entriesPerTask = HOT_KEYS * hotShare * Math.min(1, ttl / 30);
  const memoryMb = (instances * entriesPerTask * ENTRY_BYTES) / 1_000_000;
  const dbQps = readRps * (1 - hitRate) * 0.08 + writes * 0.5;
  const appUtil = readRps / (instances * APP_RPS_PER_TASK);

  return {
    readRps,
    hotShare,
    ttl,
    delaySeconds,
    instances,
    hitRate,
    redisOps,
    redisUtil,
    redisP99,
    staleSeconds,
    memoryMb,
    dbQps,
    entriesPerTask,
    appUtil,
  };
}

type HealthState = "ok" | "warn" | "crit";

function healthForUtil(util: number): HealthState {
  if (util >= 1) return "crit";
  if (util >= 0.8) return "warn";
  return "ok";
}

function cacheHealth(values: Values): HealthState {
  if (values.staleSeconds >= 5 || values.memoryMb >= 300) return "crit";
  if (values.staleSeconds >= 2 || values.memoryMb >= 192) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, values: Values, seed: number, t: number): SimFrame {
  const redisHealth = healthForUtil(values.redisUtil);
  const dbHealth = healthForUtil(values.dbQps / DB_CAPACITY);
  const appHealth = healthForUtil(values.appUtil);
  const localHealth = cacheHealth(values);

  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(values.readRps)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service fleet",
        kind: "service",
        health: appHealth,
        utilization: clamp(values.appUtil),
        throughput: values.readRps,
        sublabel: `${values.instances} tasks`,
        meta: { view: "flow" },
      },
      {
        id: "local",
        label: "Local cache (L1)",
        kind: "cache",
        health: localHealth,
        utilization: clamp(values.memoryMb / 512),
        throughput: values.readRps * values.hitRate,
        sublabel: `${(values.hitRate * 100).toFixed(0)}% hit rate`,
        detail: `Each task owns its own copy. Illustrative memory: ${values.memoryMb.toFixed(0)} MB across ${values.instances} tasks, from ${formatCount(values.entriesPerTask)} entries per task at ${ENTRY_BYTES} bytes each.`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis (L2)",
        kind: "cache",
        health: redisHealth,
        utilization: clamp(values.redisUtil),
        throughput: values.redisOps,
        capacity: REDIS_CAPACITY,
        sublabel: `${formatCount(values.redisOps)} ops/s`,
        detail: `The shared cache absorbs local misses and write invalidations. Illustrative teaching capacity: ${formatCount(REDIS_CAPACITY)} ops/s.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Primary database",
        kind: "db",
        health: dbHealth,
        utilization: clamp(values.dbQps / DB_CAPACITY),
        throughput: values.dbQps,
        capacity: DB_CAPACITY,
        sublabel: `${formatCount(values.dbQps)} qps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-service", "client", "service", values.readRps / 80_000),
      edge("service-local", "service", "local", values.hitRate),
      edge(
        "local-redis",
        "local",
        "redis",
        clamp(values.redisOps / Math.max(1, values.readRps)),
        redisHealth,
      ),
      edge("redis-db", "redis", "db", clamp(values.dbQps / Math.max(1, values.redisOps)), dbHealth),
    ],
    metrics: [
      metric("redis-ops", "Redis operations", values.redisOps, " ops/s", 24_000, 30_000, "rps"),
      metric("redis-p99", "Redis p99", values.redisP99, "ms", 40, 120, "ms"),
      metric("local-staleness", "Local staleness", values.staleSeconds, "s", 2, 5, "number"),
      metric("local-memory", "Fleet local-cache memory", values.memoryMb, " MB", 192, 300, "number"),
      metric("hit-rate", "Local hit rate", values.hitRate * 100, "%", undefined, undefined, "percent"),
      metric("db-qps", "Database QPS", values.dbQps, " qps", 5_000, 7_000, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${formatCount(values.readRps)} reads/s, ${(values.hitRate * 100).toFixed(0)}% local hits, ${formatCount(values.redisOps)} Redis ops/s, ${values.staleSeconds.toFixed(1)}s stale, ${values.memoryMb.toFixed(0)} MB local.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const entries: [string, number][] = [
    ["redis-ops", values.redisOps],
    ["redis-p99", values.redisP99],
    ["local-staleness", values.staleSeconds],
    ["local-memory", values.memoryMb],
    ["hit-rate", values.hitRate * 100],
    ["db-qps", values.dbQps],
  ];
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 9)) / 2.7);
  for (const [id, value] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * Math.max(0.2, value * 0.01)),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "local-staleness",
    metricId: "local-staleness",
    warn: 2,
    crit: 5,
    title: "The local cache is serving data past the freshness SLO",
    cause:
      "A write reached one task and the invalidation for the others is still in flight. Each local copy keeps serving the old value until the message arrives or the TTL expires.",
    fix:
      "Shorten the invalidation path, use versioned keys so readers can detect an old copy, or bypass the local cache for reads that must be fresh. A shorter TTL is only a backstop.",
    checkFirst: [
      "Compare the stale window with invalidation delivery time, not with the TTL alone.",
      "Check whether every task received the invalidation, including tasks that started recently.",
      "Check whether a write path updates Redis and the database but skips the invalidation bus.",
    ],
  },
  {
    id: "redis-ops",
    metricId: "redis-ops",
    warn: 24_000,
    crit: 30_000,
    title: "The local cache is too small or too short-lived to protect Redis",
    cause:
      "A low hit rate sends most reads to the shared cache. This can come from a short TTL or a small hot-key share.",
    fix:
      "Raise the hit rate by lengthening the TTL within the freshness budget, caching the right key set, or keeping fewer copies per task. Do not add Redis capacity before confirming the local hit rate.",
    checkFirst: [
      "Compare local hit rate with Redis operations, not with total request rate.",
      "Check whether the TTL is shorter than the key's reuse interval.",
      "Check whether a deploy or a memory limit evicted the local entries.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Redis tail latency rose after local cache changes",
    cause:
      "The shared cache is absorbing more operations than its teaching capacity. Tail latency follows utilization, so a small hit-rate loss can move p99 sharply.",
    fix:
      "Restore local hit rate, reduce the operations each read needs, or shed low-value traffic. A bigger Redis tier buys time but leaves the local hit rate unchanged.",
    checkFirst: [
      "Compare Redis operations with the local hit rate at the same timestamp.",
      "Check whether the extra operations are reads, writes, or invalidations.",
      "Check for retries that multiply the same read.",
    ],
  },
  {
    id: "local-memory",
    metricId: "local-memory",
    warn: 192,
    crit: 300,
    title: "Fleet local-cache memory crossed the budget",
    cause:
      "Memory is per task, so the fleet total is the entry count times task count. A larger hot-key set or more tasks multiplies the cost even when the hit rate is unchanged.",
    fix:
      "Bound the local cache by entries or bytes, cap the key size, or reduce task count. A cache that causes restarts is a worse availability problem than the reads it absorbs.",
    checkFirst: [
      "Check memory per task, not only the fleet total.",
      "Check whether the cache has an entry or byte bound.",
      "Check whether large values or unbounded key cardinality are filling it.",
    ],
  },
  {
    id: "db-qps",
    metricId: "db-qps",
    warn: 5_000,
    crit: 7_000,
    title: "Local cache misses are reaching the database",
    cause:
      "Every local miss that also misses Redis falls through to the database. A short TTL or a cold task turns the local cache from a shield into another lookup.",
    fix:
      "Protect the database with request coalescing and a bounded fallback. Fix the local hit rate only after the database has headroom.",
    checkFirst: [
      "Compare database QPS with Redis misses.",
      "Check whether new tasks started with a cold local cache.",
      "Check whether a single key explains the miss volume.",
    ],
  },
];

export const localCacheModel: SimModel = {
  id: "caching-local-cache",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, values, seed, 0);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const seed = Number(frame.flags.seed ?? 20261110);
    const values = compute(p, 1 + rng.between(-0.002, 0.002));
    const next = buildFrame(p, values, seed, frame.t);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];

    if (reset) {
      next.flags = { seed, paramsKey: key };
      next.series = {};
      seedSeries(next, values, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
      );
    }

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.staleSeconds >= 5 && frame.flags.staleEvent !== 1) {
      pushEvent(next, {
        id: "local-cache-stale-value",
        at: frame.t,
        severity: "crit",
        title: "Local copies are serving a value past the SLO",
        detail: `${values.staleSeconds.toFixed(1)}s behind the write path. Invalidation delay is ${(values.delaySeconds * 1000).toFixed(0)}ms; the TTL is ${values.ttl.toFixed(0)}s.`,
        nodeId: "local",
        metricId: "local-staleness",
      });
      next.flags.staleEvent = 1;
    }
    if (values.staleSeconds < 2) next.flags.staleEvent = 0;

    if (values.redisUtil >= 1 && frame.flags.redisEvent !== 1) {
      pushEvent(next, {
        id: "local-cache-redis-saturation",
        at: frame.t,
        severity: "crit",
        title: "Local misses pushed Redis past its teaching capacity",
        detail: `${formatCount(values.redisOps)} ops/s against ${formatCount(REDIS_CAPACITY)}. The local hit rate is ${(values.hitRate * 100).toFixed(0)}%.`,
        nodeId: "redis",
        metricId: "redis-ops",
      });
      next.flags.redisEvent = 1;
    }
    if (values.redisUtil < 0.9) next.flags.redisEvent = 0;

    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `A ${values.ttl.toFixed(0)}s TTL with an 8s refresh penalty yields a ${(values.hitRate * 100).toFixed(0)}% local hit rate on a ${(values.hotShare * 100).toFixed(0)}% hot-key share.`,
      `${formatCount(values.readRps)} reads/s produce ${formatCount(values.redisOps)} Redis operations/s once local misses and writes are included.`,
      `Staleness is ${values.staleSeconds.toFixed(1)}s: the smaller of the ${values.ttl.toFixed(0)}s TTL and the ${(values.delaySeconds * 1000).toFixed(0)}ms invalidation delay. A TTL below the delay lowers the bound; it still cannot make a lossy path correct.`,
      `The fleet holds about ${formatCount(values.entriesPerTask)} entries per task, ${values.memoryMb.toFixed(0)} MB total at ${ENTRY_BYTES} bytes per entry.`,
      `The current database load is ${formatCount(values.dbQps)} qps.`,
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
    description: "A warm local cache with a 30s TTL and a fast invalidation path.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "Higher traffic and more tasks. Staleness enters the warning band.",
    tone: "warn",
    params: defaults({
      readRps: 60_000,
      hotKeySharePct: 85,
      ttlSeconds: 45,
      invalidationDelayMs: 3_000,
      instanceCount: 30,
    }),
  },
  {
    id: "failure",
    label: "Slow invalidation",
    description: "A 45s invalidation path leaves every local copy stale while Redis looks calm.",
    tone: "crit",
    params: defaults({
      readRps: 50_000,
      hotKeySharePct: 85,
      ttlSeconds: 120,
      invalidationDelayMs: 45_000,
      instanceCount: 24,
    }),
  },
  {
    id: "short-ttl",
    label: "Short TTL",
    description: "A 4s TTL does not reduce staleness when invalidation is fast; it destroys the hit rate and overruns Redis.",
    tone: "crit",
    params: defaults({
      readRps: 60_000,
      hotKeySharePct: 85,
      ttlSeconds: 4,
      invalidationDelayMs: 500,
      instanceCount: 20,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A moderate TTL, fast invalidation, and a smaller fleet restore headroom.",
    tone: "ok",
    params: defaults({
      readRps: 30_000,
      hotKeySharePct: 75,
      ttlSeconds: 15,
      invalidationDelayMs: 500,
      instanceCount: 12,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-short-ttl-cost",
  title: "Predict the cost of a short TTL",
  simId: "local-cache",
  question:
    "You shorten the local TTL from 60s to 5s to reduce staleness. Invalidation delay is already 500ms. What changes?",
  prediction: {
    options: [
      {
        id: "redis-rises",
        label: "Redis load rises sharply; staleness stays near the invalidation delay.",
      },
      { id: "both-fall", label: "Both Redis load and staleness fall." },
      { id: "neither", label: "Neither Redis load nor staleness changes." },
      { id: "stale-falls", label: "Staleness falls but Redis load is unchanged." },
    ],
    correctOptionId: "redis-rises",
    explanation:
      "Staleness is the smaller of the TTL and the invalidation delay. At a 500ms delay it is already bounded near 0.55s, so a 5s TTL cannot improve it. The shorter TTL does lower the hit rate, which sends many more reads to Redis. TTL is a backstop for a missed invalidation, not the primary freshness control.",
  },
  setup: defaults({
    readRps: 60_000,
    hotKeySharePct: 85,
    ttlSeconds: 5,
    invalidationDelayMs: 500,
    instanceCount: 20,
  }),
  runFor: 20,
  observe: [
    "Redis operations rise from roughly 17,000 to about 43,000 per second in the illustrative model.",
    "Redis p99 crosses its warning threshold as utilization passes the teaching capacity.",
    "Local staleness stays near 0.55s because the invalidation delay, not the TTL, bounds it.",
    "Local memory falls because fewer entries fit inside the shorter TTL window.",
    "The local hit rate falls from about 75% to about 33%.",
  ],
  explain:
    "A shorter TTL evicts entries sooner, so more reads miss locally. Each miss becomes a Redis operation, and the shared cache is sized for the old hit rate. Staleness is capped by the invalidation delay in this setup, so the TTL change buys no freshness while it spends Redis headroom. If invalidations were slow, the TTL would matter as a backstop.",
  fix: defaults({
    readRps: 60_000,
    hotKeySharePct: 85,
    ttlSeconds: 60,
    invalidationDelayMs: 500,
    instanceCount: 20,
  }),
  debrief:
    "Restoring the 60s TTL brings Redis operations back under capacity without changing the stale window, because invalidation was already fast. The real freshness control is the invalidation path; the TTL only bounds the damage when an invalidation is lost. The remaining question is memory: a longer TTL holds more entries per task, so the per-task budget must be explicit.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A local cache, also called L1, keeps a copy of hot data inside each service task's memory. A read checks that copy first, then the shared cache (L2), then the database. The local hit avoids a network round trip and removes load from the shared tier, which is why a hot key that dominates Redis can look like a good candidate. The cost is that every task now has its own copy, its own expiry clock, and its own memory footprint.",
  },
  {
    type: "p",
    text: "The freshness bound is not the time to live (TTL) alone. A write must invalidate the shared cache and every local copy. If the invalidation reaches all tasks in 500ms, a read can be stale for about 500ms even with a five-minute TTL. If an invalidation is lost, the TTL is the backstop that eventually removes the old value. A TTL below the invalidation delay bounds staleness, but it cannot make a lossy invalidation path correct; it only limits how long a missed invalidation survives. It also costs hit rate and Redis capacity. Memory is multiplicative: entry count times tasks times bytes per entry.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, service task, local cache, Redis, database. The write path is service task, database, cache invalidation. A local cache sits before Redis, so it reduces Redis operations but cannot make Redis coherent by itself. A Redis flush clears the shared tier and leaves every task's memory untouched. A task restart clears that task's copy and starts it cold, which can move load back to Redis during a deployment.",
  },
  {
    type: "compare",
    leftTitle: "Local cache (L1)",
    rightTitle: "Shared cache (L2)",
    rows: [
      {
        label: "Latency",
        left: "In-process lookup, no network hop",
        right: "One network round trip, plus serialization",
      },
      {
        label: "Load removal",
        left: "Removes hits from Redis entirely",
        right: "Removes hits from the database",
      },
      {
        label: "Coherence",
        left: "Per task; needs invalidation or versioning",
        right: "One copy, but still needs invalidation on write",
      },
      {
        label: "Memory",
        left: "Multiplied by task count and key size",
        right: "One bounded tier, shared by all tasks",
      },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Local hit rate, Redis operations per second, and Redis tail latency on the same timeline.",
      "Local staleness in seconds, driven by invalidation delay and capped by the TTL.",
      "Per-task and fleet memory from the cached entry count.",
      "Database QPS for the reads that miss both cache layers.",
      "Task count, which changes memory and cold-start load but not the hit rate per task.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Short TTL to see the Redis cost of chasing freshness with expiry. Apply Slow invalidation to see the opposite failure: Redis is calm while local copies serve stale data. Then run the guided experiment and compare the recovery preset.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      ["Longer TTL", "Higher local hit rate and fewer Redis operations", "More staleness when invalidation is lost, and more memory per task"],
      ["Faster invalidation", "Lower stale window without lowering hit rate", "A bus, delivery guarantees, and a failure path to operate"],
      ["Versioned keys", "Readers detect an old copy even after a lost invalidation", "A version lookup and a key or value format change"],
      ["Bypass", "Reads skip the local cache for a chosen key or all keys", "More Redis load and higher latency during the bypass"],
      ["More tasks", "More read capacity", "Memory multiplies, and each new task starts cold"],
    ],
  },
  {
    type: "p",
    text: "This module uses illustrative teaching values: 30,000 Redis operations per second, 220 bytes per entry, and a fixed 4% write share. They are not ElastiCache or Caffeine limits. The lesson is the relationship between hit rate, staleness, and per-task memory.",
  },
  { type: "sim", simId: "local-cache" },
  { type: "experiment", experimentId: "predict-short-ttl-cost" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The local cache absorbed the hot reads and cut Redis operations, which is the intended win. The model then exposed the two bills. When invalidation was slow, every task kept serving its old copy until the message arrived or the TTL expired, so Redis looked healthy while the product was stale. When the TTL was shortened to compensate, the hit rate fell and Redis operations rose past the illustrative capacity. The stale outcome was invisible from Redis p99; the saturation outcome showed up in p99 and operations.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-task local cache hit and miss counts, entry count, and memory. Fleet averages hide one task with a different key set.",
      "Redis operations separated into reads, writes, and invalidations. A local cache should reduce reads first.",
      "Invalidation delivery time and failures. A task that missed a message is stale until its TTL.",
      "Application logs or traces that show the age of the value being served, not only the cache hit.",
      "Cold-start behavior during deployments: new tasks have empty local caches and send more reads to Redis.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare local staleness with invalidation delivery time. If the stale window is longer than the SLO, the TTL is not the cause; the invalidation path is. If Redis is saturated, check the local hit rate and TTL before adding Redis capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm which layer is failing: local staleness, Redis saturation, or both.",
      "If data is stale, measure invalidation delivery and repair the bus or use versioned keys.",
      "If Redis is saturated, restore local hit rate by fixing the TTL or key set, not by adding tasks.",
      "Bound local memory by entries or bytes and verify the per-task budget.",
      "Add a bypass for a bad key or a bad deploy, and test it before the incident.",
      "Re-run peak traffic and check Redis operations, staleness, and per-task memory together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A local cache removes a network hop and Redis load, but it creates a copy that every writer must invalidate.",
      "A longer TTL improves hit rate and lowers Redis load, but increases staleness after a missed invalidation and memory per task.",
      "A shorter TTL bounds staleness, but it can overwhelm Redis and make the local cache less useful.",
      "A bypass is a fast escape hatch, but it shifts load to Redis and raises latency while it is on.",
      "More tasks add capacity, but each task has its own memory and cold start.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-l1",
    question:
      "Redis p99 is fine, but one hot key consumes most of its capacity. How do you decide whether to add a local cache?",
    difficulty: 3,
    hints: [
      "Start with the freshness contract, not the latency chart.",
      "A local cache changes who owns invalidation.",
    ],
    answer:
      "I would first confirm the hot key is read-heavy and that its reads can tolerate a bounded stale window. Then I would measure the expected local hit rate from the key's reuse interval and the task count, and compare the Redis operations removed with the memory added per task. A local cache is a good fit when the freshness bound is explicit and invalidation is reliable; it is a poor fit when reads must be immediately consistent or the key set is too large per task. I would prototype with a bounded cache, a TTL, and a bypass, then load-test cold starts and invalidation loss.",
    followUps: [
      "What stale window would you put in the SLO?",
      "How would you size the cache per task?",
      "What would make you choose a bigger Redis tier instead?",
    ],
    redFlags: [
      "Adds a local cache without an invalidation plan.",
      "Assumes the hit rate is the same on every task.",
      "Ignores memory and cold starts.",
    ],
    rubric: [
      "Ties the decision to a freshness bound.",
      "Quantifies Redis operations removed and memory added.",
      "Names invalidation and cold-start risks.",
      "Includes a bypass or rollback.",
    ],
  },
  {
    id: "invalidation",
    question:
      "A write updates the database and Redis, but some tasks still serve the old value for minutes. How do you debug it?",
    difficulty: 3,
    hints: [
      "Separate the shared tier from the per-task copies.",
      "Look for tasks that were not connected when the message was sent.",
    ],
    answer:
      "I would confirm the stale reads are local-cache hits, not Redis hits, by checking the age of the value and the task that served it. Then I would trace the invalidation path: did the write publish, did each task receive it, and did a task that restarted or lost its connection miss it? I would compare the stale window with the TTL and with the time since the last task start. The fix is either a reliable invalidation path, versioned keys that let readers detect an old copy, or a shorter TTL as a backstop, plus a bypass for the affected key.",
    followUps: [
      "How would versioned keys change the diagnosis?",
      "What if only new tasks are stale?",
      "How do you prove the message was lost rather than delayed?",
    ],
    redFlags: [
      "Flushes Redis and expects local copies to clear.",
      "Shortens the TTL without fixing the bus.",
      "Blames the database before checking the local hit.",
    ],
    rubric: [
      "Distinguishes local from shared cache.",
      "Checks delivery and task lifecycle.",
      "Names a reliable fix and a backstop.",
      "Includes a way to bypass the bad value.",
    ],
  },
  {
    id: "memory-bound",
    question:
      "How do you bound a local cache so it cannot take down the service during a traffic spike?",
    difficulty: 3,
    hints: [
      "A cache is not a source of truth.",
      "The bound should be in bytes or entries, not only time.",
    ],
    answer:
      "I would set a maximum weight in bytes or entries per task, not only a TTL, and reject or evict entries when the bound is reached. I would cap the size of a single value, avoid caching unbounded key cardinality, and expose eviction and memory metrics. The cache should degrade to Redis misses rather than trigger restarts or out-of-memory kills. I would also test a cold start and a large-key case, because those are when the bound is most likely to be hit.",
    followUps: [
      "Which eviction policy would you choose?",
      "How do you handle a single very large value?",
      "What happens when the cache is full?",
    ],
    redFlags: [
      "Uses only a TTL as the memory bound.",
      "Lets key cardinality grow without a limit.",
      "Has no eviction metrics.",
    ],
    rubric: [
      "Bounds by bytes or entries.",
      "Degrades to a miss, not a crash.",
      "Measures evictions and memory.",
      "Tests cold start and large values.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The local cache has a documented freshness bound and an owner for invalidation.",
      "Every task has a byte or entry bound, plus a metric for evictions and memory.",
      "The invalidation path is monitored for delivery failures and restarts.",
      "A bypass or kill switch exists for a bad key or a bad deploy.",
      "Dashboards show local hit rate, Redis operations, staleness, and per-task memory together.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the stale read was served by the local cache or Redis.",
      "Check invalidation delivery and task start times before changing the TTL.",
      "If Redis is saturated, restore local hit rate or shed load before adding capacity.",
      "Use the bypass for the affected key while the root cause is investigated.",
      "Watch cold starts and the next cache layer after any rollback.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the stale window and Redis operations at peak traffic.",
      "Reconcile the TTL with the product's freshness contract.",
      "Remove temporary bypasses and confirm they are off everywhere.",
      "Add a load test that expires the hot key and restarts a task.",
    ],
  },
];

const references = [
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside, TTL, and thundering-herd guidance.",
  },
  {
    title: "Caffeine wiki",
    url: "https://github.com/ben-manes/caffeine/wiki",
    publisher: "Caffeine",
    kind: "docs" as const,
    note: "In-process cache design, eviction, and bounding by size.",
  },
  {
    title: "Client-side caching",
    url: "https://redis.io/docs/latest/develop/clients/client-side-caching/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "How local copies are invalidated when Redis is the shared tier.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "local-cache": {
      model: localCacheModel,
      presets,
      instructions:
        "Start healthy, then compare Short TTL with Slow invalidation. Watch local staleness, Redis operations, and per-task memory together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Redis capacity is 30,000 ops/s, entries are 220 bytes, and the write share is 4%. These are not ElastiCache or Caffeine limits. Staleness is the smaller of the TTL and the invalidation delay.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-coherence",
    "caching-local-bypass",
    "caching-cache-stampede",
    "caching-hot-key-sharding",
  ],
};
