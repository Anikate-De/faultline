import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DB_READ_CAPACITY = 12_000;
const DB_WRITE_CAPACITY = 2_000;
const FLUSH_SECONDS = 2;
const ASIDE_TTL_SECONDS = 60;
const HIT_RATE = 0.9;

const params = [
  {
    id: "strategy",
    label: "Cache strategy",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "Zero is cache-aside. One is write-through. Two is write-behind. The strategy changes both the read path and the write acknowledgment.",
    format: "count" as const,
  },
  {
    id: "readRps",
    label: "Read rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " rps",
    group: "Workload",
    help: "Read requests per second arriving at the service.",
    format: "rps" as const,
  },
  {
    id: "writeRps",
    label: "Write rate",
    min: 50,
    max: 2_000,
    step: 50,
    value: 300,
    unit: " rps",
    group: "Workload",
    help: "Updates per second. Write rate determines the size of the loss window in write-behind.",
    format: "rps" as const,
  },
  {
    id: "cacheAvailable",
    label: "Cache available",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failure",
    help: "Zero makes the cache node unavailable. Reads miss and writes reveal whether the cache was in the durability path.",
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

function strategyName(strategy: number): string {
  if (strategy === 1) return "Write-through";
  if (strategy === 2) return "Write-behind";
  return "Cache-aside";
}

interface Computed {
  strategy: number;
  cacheUp: boolean;
  readRps: number;
  writeRps: number;
  effectiveHit: number;
  dbReadRps: number;
  dbWriteRps: number;
  readP99: number;
  writeP99: number;
  lostWrites: number;
  staleness: number;
  durability: number;
  errorRate: number;
}

function compute(p: Params): Computed {
  const strategy = Math.round(clamp(num(p, "strategy", 0), 0, 2));
  const cacheUp = num(p, "cacheAvailable", 1) >= 1;
  const readRps = Math.max(1, num(p, "readRps", 4_000));
  const writeRps = Math.max(0, num(p, "writeRps", 300));
  const effectiveHit = cacheUp ? HIT_RATE : 0;
  const dbReadRps = readRps * (1 - effectiveHit);
  const dbWriteRps = strategy === 2 ? (cacheUp ? writeRps : 0) : writeRps;
  const readUtil = dbReadRps / DB_READ_CAPACITY;
  const writeUtil = dbWriteRps / DB_WRITE_CAPACITY;
  const missLatency =
    readUtil >= 0.98 ? 500 : 20 + (30 * readUtil ** 3) / Math.max(0.02, 1 - readUtil);
  const readP99 = 2 + (1 - effectiveHit) * missLatency;
  const writeP99 =
    strategy === 1 ? (cacheUp ? 35 : 30) : strategy === 2 ? (cacheUp ? 5 : 500) : writeUtil > 0.9 ? 70 : 25;
  const lostWrites = strategy === 2 && !cacheUp ? writeRps * FLUSH_SECONDS : 0;
  const staleness = strategy === 0 ? (cacheUp ? ASIDE_TTL_SECONDS : 0) : strategy === 2 ? 0.5 : 0;
  const durability = strategy === 2 ? (cacheUp ? 99.99 : 0) : 100;
  return {
    strategy,
    cacheUp,
    readRps,
    writeRps,
    effectiveHit,
    dbReadRps,
    dbWriteRps,
    readP99,
    writeP99,
    lostWrites,
    staleness,
    durability,
    errorRate: strategy === 2 && !cacheUp ? 100 : 0,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const cacheHealth = values.cacheUp ? "ok" : "down";
  const serviceHealth = healthFor(values.lostWrites, 1, 100);
  const writeHealth = healthFor(values.writeP99, 50, 200);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        throughput: values.readRps + values.writeRps,
        sublabel: `${Math.round(values.readRps).toLocaleString()} reads, ${Math.round(values.writeRps).toLocaleString()} writes`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Product service",
        kind: "service",
        health: serviceHealth === "ok" ? writeHealth : serviceHealth,
        utilization: clamp((values.readRps + values.writeRps) / 22_000),
        throughput: values.readRps + values.writeRps,
        sublabel: `${strategyName(values.strategy)}`,
        detail: `Read p99 ${values.readP99.toFixed(0)}ms, write p99 ${values.writeP99.toFixed(0)}ms, ${Math.round(values.errorRate)}% write errors.`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Redis cache",
        kind: "cache",
        health: cacheHealth,
        utilization: cacheHealth === "ok" ? clamp(HIT_RATE) : 0,
        throughput: values.cacheUp ? values.readRps * values.effectiveHit : 0,
        sublabel: values.cacheUp ? `${Math.round(values.effectiveHit * 100)}% hit rate` : "unavailable",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Primary database",
        kind: "db",
        health: healthFor(Math.max(values.dbReadRps / DB_READ_CAPACITY, values.dbWriteRps / DB_WRITE_CAPACITY) * 100, 75, 95),
        utilization: clamp(Math.max(values.dbReadRps / DB_READ_CAPACITY, values.dbWriteRps / DB_WRITE_CAPACITY)),
        throughput: values.dbReadRps + values.dbWriteRps,
        sublabel: `${Math.round(values.dbReadRps).toLocaleString()} reads, ${Math.round(values.dbWriteRps).toLocaleString()} writes`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-service", "client", "service", clamp((values.readRps + values.writeRps) / 22_000), serviceHealth),
      edge("service-cache", "service", "cache", clamp(values.cacheUp ? values.effectiveHit : 0), cacheHealth),
      edge("service-db", "service", "db", clamp((values.dbReadRps + values.dbWriteRps) / 14_000), "ok"),
    ],
    metrics: [
      metric("read-p99", "Read p99", values.readP99, "ms", 40, 120, "ms"),
      metric("write-p99", "Write p99", values.writeP99, "ms", 50, 200, "ms"),
      metric("lost-writes", "Acknowledged writes lost", values.lostWrites, " req", 1, 100, "count"),
      metric("staleness", "Stale window", values.staleness, "s", 10, 120, "number"),
      metric("durability", "Acknowledged durability", values.durability, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, strategy: values.strategy, cacheUp: values.cacheUp ? 1 : 0 },
    summary: `${strategyName(values.strategy)}: read p99 ${values.readP99.toFixed(0)}ms, write p99 ${values.writeP99.toFixed(0)}ms, ${Math.round(values.lostWrites).toLocaleString()} acknowledged writes lost.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 5)) / 2.5);
  const seeds: [string, number, number][] = [
    ["read-p99", values.readP99, 0.5],
    ["write-p99", values.writeP99, 1],
    ["lost-writes", values.lostWrites, 2],
    ["staleness", values.staleness, 0.2],
    ["durability", values.durability, 0.05],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lost-writes",
    metricId: "lost-writes",
    warn: 1,
    crit: 100,
    title: "Acknowledged writes were lost with the cache",
    cause:
      "Write-behind acknowledges the write after it reaches the cache and flushes to the database later. When the cache fails before the flush, the acknowledgment is already with the client and the durable copy does not exist. The size of the loss is the write rate times the flush interval.",
    fix:
      "Do not acknowledge a write until it is durable. Use write-through or write-behind with a durable log that survives the cache, and reconcile the client-visible state after recovery.",
    checkFirst: [
      "Confirm which write path acknowledged before the database commit.",
      "Check the flush interval and the write rate to estimate the loss window.",
      "Check whether the cache had persistence or a replicated log.",
    ],
  },
  {
    id: "write-p99",
    metricId: "write-p99",
    warn: 50,
    crit: 200,
    title: "The write path is failing or timing out",
    cause:
      "Writes are waiting on an unavailable cache, a saturated database, or both. A strategy that puts the cache in the synchronous write path turns cache unavailability into write unavailability.",
    fix:
      "Decide whether writes must be durable synchronously. If yes, write the database first and treat the cache as a projection. If no, queue the write durably and expose the delay.",
    checkFirst: [
      "Split write latency by database time and cache time.",
      "Check database write utilization and connection pool waits.",
      "Check whether the client retries failed writes without an idempotency key.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 40,
    crit: 120,
    title: "Reads are falling through to the database",
    cause:
      "A cache miss, an unavailable cache, or a low hit rate sends reads to a database sized for a fraction of the traffic. Read latency rises nonlinearly as database utilization approaches saturation.",
    fix:
      "Restore the cache or protect the database with bounded concurrency, request coalescing, and a fallback. Raising the database size without fixing the miss path only moves the limit.",
    checkFirst: [
      "Compare cache hit rate with database read rate.",
      "Check whether one key or one route dominates misses.",
      "Check database CPU and connection waits, not only query latency.",
    ],
  },
  {
    id: "staleness",
    metricId: "staleness",
    warn: 10,
    crit: 120,
    title: "Cached reads can outlive the freshness contract",
    cause:
      "Cache-aside serves the cached value until its TTL expires or an invalidation arrives. A write on another instance does not update this instance's copy, so the stale window is the TTL, not the write latency.",
    fix:
      "Shorten the TTL, invalidate on write, or use a versioned key so a reader can tell that the value changed. The right choice depends on how much staleness the product allows.",
    checkFirst: [
      "Check the TTL and the invalidation path for every write.",
      "Identify reads that must observe the writer's own update.",
      "Check whether invalidations reach every instance.",
    ],
  },
];

export const cachingStrategiesModel: SimModel = {
  id: "foundations-caching-strategies",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${strategyName(values.strategy)}: read p99 ${values.readP99.toFixed(0)}ms, write p99 ${values.writeP99.toFixed(0)}ms, ${Math.round(values.lostWrites).toLocaleString()} acknowledged writes lost.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${strategyName(values.strategy)} serves reads at ${values.readP99.toFixed(0)}ms p99 and writes at ${values.writeP99.toFixed(0)}ms p99 while the cache is ${values.cacheUp ? "available" : "down"}.`,
    );
    if (values.strategy === 2) {
      items.push(
        `Write-behind acknowledges after ${5}ms of cache latency and flushes every ${FLUSH_SECONDS}s. With ${Math.round(values.writeRps).toLocaleString()} writes/s, the loss window holds about ${Math.round(values.writeRps * FLUSH_SECONDS).toLocaleString()} writes.`,
      );
    }
    if (values.strategy === 1) {
      items.push(
        "Write-through pays cache and database latency on every write. It keeps the cache fresh, but the cache is now in the synchronous path; a cache outage becomes a write-latency event.",
      );
    }
    if (values.strategy === 0) {
      items.push(
        `Cache-aside writes the database and invalidates the cache. The cache is optional for writes, and the stale window is the ${ASIDE_TTL_SECONDS}s TTL when invalidation is not immediate.`,
      );
    }
    items.push(
      `${Math.round(values.dbReadRps).toLocaleString()} read qps and ${Math.round(values.dbWriteRps).toLocaleString()} write qps reach the database. Every strategy moves load between these two paths.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Write-through with a 90% hit rate. Reads are fast, writes are durable, and nothing is stale.",
    tone: "ok",
    params: defaults({ strategy: 1, readRps: 4_000, writeRps: 300, cacheAvailable: 1 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Cache-aside at 12k reads with a 90% hit rate. Reads are fast, but a write can be stale for the TTL.",
    tone: "warn",
    params: defaults({ strategy: 0, readRps: 12_000, writeRps: 600, cacheAvailable: 1 }),
  },
  {
    id: "failure",
    label: "Write-behind loss",
    description: "Write-behind at 300 writes/s loses the cache before the two-second flush. Acknowledged writes disappear.",
    tone: "crit",
    params: defaults({ strategy: 2, readRps: 4_000, writeRps: 300, cacheAvailable: 0 }),
  },
  {
    id: "fast-writes",
    label: "Write-behind",
    description: "The same write-behind path while the cache is healthy. Writes look excellent; durability is not 100%.",
    tone: "ok",
    params: defaults({ strategy: 2, readRps: 4_000, writeRps: 300, cacheAvailable: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Write-through with the cache healthy. Writes are durable and reads stay fast at a higher write cost.",
    tone: "ok",
    params: defaults({ strategy: 1, readRps: 4_000, writeRps: 400, cacheAvailable: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-cache-loss",
  title: "Predict which strategy loses writes",
  simId: "caching-strategies",
  question:
    "The cache node fails. Which strategy can lose writes that clients were already told succeeded?",
  prediction: {
    options: [
      { id: "aside", label: "Cache-aside, because the cache holds the newest value" },
      { id: "through", label: "Write-through, because the cache and database disagree" },
      { id: "behind", label: "Write-behind, because acknowledgment precedes the database write" },
      { id: "none", label: "None, because all three write the database first" },
    ],
    correctOptionId: "behind",
    explanation:
      "Write-behind acknowledges after the cache accepts the write and flushes to the database later. If the cache fails before the flush, the client has a success response and the database has no corresponding write. Cache-aside writes the database first. Write-through writes both before acknowledging, so a cache failure costs latency or errors, not silent loss.",
  },
  setup: defaults({ strategy: 2, readRps: 4_000, writeRps: 300, cacheAvailable: 0 }),
  runFor: 20,
  observe: [
    "Acknowledged writes lost reaches 600: 300 writes/s for the two-second flush interval.",
    "Write p99 reaches 500ms and write error rate reaches 100% while the cache is down.",
    "Reads fall through to the database, but the database survives at this read rate.",
    "Switching to write-through at the same load returns lost writes to zero and write p99 to about 35ms.",
  ],
  explain:
    "Durability is a property of the acknowledgment, not of the cache. Write-behind is fast because it moves the database write out of the request path; the price is a window in which the only copy is the cache. A cache failure inside that window turns an acknowledged success into a lost update. The fix is to make the durable write precede the acknowledgment, or to put the queue on durable storage that survives the cache.",
  fix: defaults({ strategy: 1, readRps: 4_000, writeRps: 300, cacheAvailable: 1 }),
  debrief:
    "Write-through costs more write latency and puts the cache in the synchronous path, but it does not silently lose an acknowledged update. For a workload that can tolerate a few seconds of delay, write-behind with a durable queue is still valid; the queue, not the cache, must be the durability boundary. The decision is a product one: how long may a successful write live only in memory?",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A cache strategy answers one question: when a write happens, which copy is authoritative and when is the client told it succeeded? Cache-aside leaves the database authoritative. The application reads the cache, falls back to the database on a miss, and fills the cache. A write goes to the database, then the cache entry is invalidated or updated.",
  },
  {
    type: "p",
    text: "Write-through writes the cache and the database in the request path, then acknowledges. The cache stays fresh, but every write pays both latencies and the cache becomes part of write availability. Write-behind writes the cache, acknowledges, and flushes to the database asynchronously. Writes are fast and the database sees smoother load, but the acknowledgment now precedes durability.",
  },
  {
    type: "p",
    text: "The failure follows from that ordering. If the cache fails after acknowledging a write and before the flush, the client has a success response and the database has nothing. The loss window is the flush interval times the write rate. No amount of read-path tuning repairs it, because the missing data was never durable.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The cache sits between the service and the database, usually as Redis or a managed cache. Reads may be served from the cache; writes either go through it or around it. The database remains the system of record unless the design explicitly makes another component durable. A queue or log between the cache and the database can move the durability boundary without giving up asynchronous writes.",
  },
  {
    type: "compare",
    leftTitle: "Read path",
    rightTitle: "Write path",
    rows: [
      { label: "Cache-aside", left: "Hit returns from cache; miss reads the database and fills", right: "Database write, then invalidate or update the cache" },
      { label: "Write-through", left: "Cache is kept fresh by the write path", right: "Cache and database before acknowledgment" },
      { label: "Write-behind", left: "Cache is the fast copy; database follows", right: "Cache, acknowledge, asynchronous flush" },
      { label: "Failure question", left: "How stale can a hit be?", right: "What is durable when the client is told yes?" },
    ],
  },
  {
    type: "p",
    text: "This module uses a 12,000 qps illustrative read capacity, a 2,000 qps write capacity, and a two-second flush interval. They are teaching values, not a database benchmark. The shape is the lesson: the strategy changes which failure the product experiences.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Read p99 and write p99: the two paths the strategy prices differently.",
      "Acknowledged writes lost: the count of updates the client believes are durable but are not.",
      "Stale window: how long a cached read can lag the latest write.",
      "Acknowledged durability: the share of acknowledged writes that survive a cache failure.",
      "Database read and write load: where each strategy sends the work.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Write-behind loss. Watch acknowledged writes lost and write p99 together: the fast path becomes the loss path. Run the experiment before revealing the explanation, then apply Recovery and compare write latency, durability, and database load. Finish with Write-behind to see the healthy version of the same tradeoff.",
  },
  {
    type: "table",
    headers: ["Strategy", "Read behavior", "Write behavior", "Main risk"],
    rows: [
      ["Cache-aside", "Cache hit or database fallback", "Database first, then invalidate", "Stale reads until TTL or invalidation"],
      ["Write-through", "Cache is fresh on write", "Cache and database before ack", "Write latency and cache availability coupling"],
      ["Write-behind", "Cache is the fast copy", "Cache ack, database later", "Acknowledged writes lost with the cache"],
    ],
  },
  { type: "sim", simId: "caching-strategies" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Write-behind acknowledged 300 writes per second and buffered them for two seconds. When the cache failed, 600 acknowledged writes had no durable copy. The database was healthy and reads continued after falling through, which is exactly why the failure is easy to miss: the system looked available while a small, recent slice of acknowledged work had vanished.",
  },
  {
    type: "p",
    text: "Write-through at the same load kept durability at 100% and moved the cost into write latency and cache coupling. Cache-aside kept the cache optional for writes but left a stale window equal to its TTL. Each strategy is a different answer to which failure the product can tolerate, not a different speed of the same system.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache metrics: hit rate, misses, evictions, latency, and connection errors.",
      "Database metrics: read and write qps, CPU, connection waits, and replication lag.",
      "Write-path metrics: acknowledgment latency split by cache and database time, error rate, and retry volume.",
      "Durability evidence: replication or flush lag, queue depth, and the count of writes accepted but not yet committed.",
      "Product signals: support reports of missing updates, which often arrive before any infrastructure alert.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask what the client was told before the failure. If the write was acknowledged, check whether it was durable at that moment. Then check the flush interval and write rate to bound the loss. For a read incident, compare hit rate with database load before resizing anything.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the durability requirement: may an acknowledged write ever be lost?",
      "If no, put the durable write before the acknowledgment, or log the write durably before acknowledging.",
      "If write-behind is required for throughput, make the queue durable and replay it after a cache failure.",
      "Bound the stale window with a TTL that matches the product contract, and invalidate on write where it matters.",
      "Reconcile writes after a cache failure: compare the client-visible log with the database.",
      "Load-test the cache-down path, not only the cache-warm path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cache-aside is the simplest and most failure-tolerant for writes, but it accepts a stale window and a cold-start penalty.",
      "Write-through keeps reads fresh and writes durable, but adds cache latency to every write and makes the cache part of write availability.",
      "Write-behind gives the best write latency and absorbs database spikes, but it requires a durable buffer to avoid losing acknowledged work.",
      "A shorter flush interval reduces the loss window and reduces the batching benefit; a longer one does the opposite.",
      "Every strategy moves load. Verify the database, the cache, and the client-visible truth after any change.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-strategy",
    question:
      "The product needs sub-10ms reads and durable writes. Which cache strategy do you choose, and what do you give up?",
    difficulty: 3,
    hints: [
      "Separate the read requirement from the write requirement.",
      "Durability is about when the client is told yes.",
    ],
    answer:
      "I would use cache-aside or write-through for durability and keep the write acknowledgment behind the database commit. Cache-aside is simpler and keeps the cache optional; the cost is a stale read window that I would bound with a TTL and invalidation. Write-through keeps the cache fresher but adds cache latency and availability coupling to every write. Write-behind would meet the write-latency goal, but only if the buffered write is durable before acknowledgment. I would not choose it just because it is fastest; I would choose it when the product can tolerate asynchronous durability and the buffer survives a cache failure.",
    followUps: [
      "What stale window would you accept for a checkout?",
      "How would you migrate from write-behind to write-through?",
      "What happens to in-flight writes during a cache deploy?",
    ],
    redFlags: [
      "Picks write-behind for speed without a durability story.",
      "Says cache-aside is always consistent.",
      "Ignores the cache-down read path.",
    ],
    rubric: [
      "Separates read and write requirements.",
      "Places durability at the acknowledgment.",
      "Names the stale window.",
      "Explains the cache-down behavior.",
    ],
  },
  {
    id: "write-behind-recovery",
    question:
      "You run write-behind and the cache fails. How do you find out what was lost, and what do you tell customers?",
    difficulty: 3,
    hints: [
      "The loss window is bounded by flush interval and write rate.",
      "The client may have a success response and no durable record.",
    ],
    answer:
      "I would first stop acknowledging new writes through the broken path and switch to a durable path. Then I would bound the loss window from the flush lag and the write rate, and reconcile the client-visible operation log against the database for that interval. If the write carried an idempotency key, replay is safe; if not, I need a business-level reconciliation. Customer communication depends on what was lost: a profile update and a payment are different. The fix is to move the durability boundary to a queue or log that survives the cache, then replay before resuming asynchronous acknowledgment.",
    followUps: [
      "How would idempotency keys change the recovery?",
      "What if the cache had persistence enabled?",
      "How do you prevent a replay from duplicating writes?",
    ],
    redFlags: [
      "Says the data is in the cache and will flush eventually.",
      "Restarts the cache and assumes recovery.",
      "Has no way to identify the affected writes.",
    ],
    rubric: [
      "Stops the unsafe acknowledgment path.",
      "Bounds the loss window.",
      "Reconciles with a durable record.",
      "Explains customer impact.",
    ],
  },
  {
    id: "migrate-durability",
    question:
      "You need to move a write-behind path to write-through without losing acknowledged writes. How do you sequence the change?",
    difficulty: 3,
    hints: [
      "Do not switch the acknowledgment boundary in one step.",
      "Keep both paths observable during the transition.",
    ],
    answer:
      "I would first add a durable write or log to the write-behind path so no acknowledged write depends only on the cache. Then I would dual-write to the database and the cache for a subset of traffic, keep the existing flush draining, and compare the two paths for missing or duplicate writes. Once the database path is proven at peak, I would move the acknowledgment to after the database commit and remove the asynchronous flush. Each step needs a rollback and a way to reconcile in-flight writes; the risk is not the code change, it is the writes that are somewhere between the old and new boundaries.",
    followUps: [
      "How do you handle writes that are in the flush queue during the switch?",
      "What metric proves the new path is durable?",
      "How long do you run both paths?",
    ],
    redFlags: [
      "Flips the acknowledgment in one deploy.",
      "Removes the flush before draining it.",
      "Has no reconciliation for the transition window.",
    ],
    rubric: [
      "Makes the buffer durable first.",
      "Dual-writes and compares.",
      "Moves the acknowledgment last.",
      "Defines rollback and reconciliation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each write path's durability point is documented: database commit, durable log, or cache acknowledgment.",
      "The flush interval and maximum loss window are known for write-behind.",
      "The TTL and invalidation path match the product's freshness contract.",
      "The cache-down read path has bounded concurrency and a fallback.",
      "A restore or replay procedure exists for buffered writes.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop acknowledging writes through a path that is no longer durable.",
      "Estimate lost writes from write rate and flush lag.",
      "Check database read and write load before adding cache capacity.",
      "Check whether retries are duplicating writes without idempotency keys.",
      "Record the acknowledgment boundary and the affected interval.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile the affected writes against the system of record.",
      "Re-run the cache-down test at peak write rate.",
      "Review whether write-behind still matches the product's durability requirement.",
      "Document the remaining stale window and the customer-visible behavior.",
    ],
  },
];

const references = [
  {
    title: "Caching best practices",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside, write-through, TTLs, and cache failure behavior.",
  },
  {
    title: "Redis persistence",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "RDB and AOF durability, fsync policy, and what survives a restart.",
  },
  {
    title: "AWS database caching",
    url: "https://aws.amazon.com/caching/database-caching/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Read-heavy caching patterns and consistency tradeoffs.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "caching-strategies": {
      model: cachingStrategiesModel,
      presets,
      instructions:
        "Start healthy, then apply Write-behind loss. Compare acknowledged writes lost with write p99, then apply Recovery. Use the cache-available control to separate a slow path from a lost one.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Read and write capacities and the two-second flush interval are teaching values, not vendor guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-consistency-models",
    "caching-aside-vs-write-through",
    "caching-redis-data-types",
    "foundations-cache-invalidation",
  ],
};
