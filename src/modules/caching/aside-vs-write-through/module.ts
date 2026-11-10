import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const READ_RPS = 20_000;
const KEYSPACE = 100_000;
const DB_CAPACITY = 10_000;
const DB_LATENCY_MS = 20;
const CACHE_LATENCY_MS = 1;
const CACHE_WRITE_MS = 2;

const params = [
  {
    id: "strategy",
    label: "Write strategy",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Strategy",
    help: "0 is cache-aside: write the database, then invalidate the cache. 1 is write-through: write the cache and database in the same synchronous path.",
    format: "count" as const,
  },
  {
    id: "writeRps",
    label: "Write rate",
    min: 100,
    max: 5_000,
    step: 100,
    value: 500,
    unit: " rps",
    group: "Traffic",
    help: "Updates per second. Cache-aside performs one database write and an invalidation; write-through performs a cache write and a database write.",
    format: "rps" as const,
  },
  {
    id: "invalidationDelay",
    label: "Invalidation delay",
    min: 0,
    max: 120,
    step: 5,
    value: 0,
    unit: " s",
    group: "Cache-aside",
    help: "How long the old cached value survives after a database write. Write-through ignores this because it writes the cache directly.",
    format: "number" as const,
  },
  {
    id: "cacheUp",
    label: "Cache available",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failure",
    help: "1 keeps the cache in service; 0 models a cache outage. Cache-aside reads fall back to the database; write-through is configured to fail closed.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  writeThrough: boolean;
  up: boolean;
  writeRps: number;
  delay: number;
  readHit: number;
  dbReadQps: number;
  dbWriteQps: number;
  dbQps: number;
  util: number;
  readP99: number;
  writeP99: number;
  writeErrors: number;
  staleReadPct: number;
  writeOps: number;
}

function compute(p: Params): Computed {
  const writeThrough = num(p, "strategy", 0) >= 0.5;
  const up = num(p, "cacheUp", 1) >= 0.5;
  const writeRps = Math.max(0, num(p, "writeRps", 500));
  const delay = Math.max(0, num(p, "invalidationDelay", 0));
  const readHit = up ? (writeThrough ? 0.99 : 0.95) : 0;
  const dbReadQps = READ_RPS * (1 - readHit);
  const dbWriteQps = writeRps;
  const dbQps = dbReadQps + dbWriteQps;
  const util = dbQps / DB_CAPACITY;
  const queueFactor = util <= 1 ? 1 : 1 + 3 * (util - 1) ** 1.5;
  const readP99 = (up ? (readHit >= 0.985 ? 21 : 22) : 24) * queueFactor ** 2;
  const writeP99 = writeThrough
    ? up
      ? DB_LATENCY_MS + CACHE_WRITE_MS
      : 0
    : DB_LATENCY_MS + CACHE_LATENCY_MS;
  const writeErrors = writeThrough && !up ? 100 : 0;
  const staleReadPct =
    !writeThrough && up ? Math.min(95, ((writeRps * delay) / KEYSPACE) * 100) : 0;
  return {
    writeThrough,
    up,
    writeRps,
    delay,
    readHit,
    dbReadQps,
    dbWriteQps,
    dbQps,
    util,
    readP99,
    writeP99,
    writeErrors,
    staleReadPct,
    writeOps: writeThrough ? writeRps * 2 : writeRps,
  };
}

function healthFor(qps: number): "ok" | "warn" | "crit" {
  if (qps >= 9_000) return "crit";
  if (qps >= 7_000) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const c = compute(p);
  const dbHealth = healthFor(c.dbQps);
  const appHealth =
    c.writeErrors >= 5 ? "crit" : c.staleReadPct >= 30 ? "warn" : c.util > 1 ? "crit" : "ok";
  const cacheHealth = c.up ? "ok" : "down";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        utilization: clamp((READ_RPS + c.writeRps) / 50_000),
        throughput: READ_RPS + c.writeRps,
        sublabel: `${formatCount(READ_RPS)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Service",
        kind: "service",
        health: appHealth,
        utilization: clamp((READ_RPS + c.writeRps) / 50_000),
        throughput: READ_RPS + c.writeRps,
        sublabel: c.writeThrough ? "write-through path" : "cache-aside path",
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Cache",
        kind: "cache",
        health: cacheHealth,
        throughput: c.up ? READ_RPS * c.readHit + (c.writeThrough ? c.writeRps : 0) : 0,
        sublabel: c.up ? `${(c.readHit * 100).toFixed(0)}% read hit` : "unavailable",
        detail:
          "Cache-aside invalidates after the database write. Write-through updates the cache in the same synchronous path, so the next read is fresh if both writes succeed.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Primary database",
        kind: "db",
        health: dbHealth,
        utilization: clamp(c.util),
        throughput: c.dbQps,
        sublabel: `${formatCount(c.dbQps)} qps`,
        detail: `Illustrative teaching capacity is ${formatCount(DB_CAPACITY)} qps. Reads contribute ${formatCount(c.dbReadQps)} qps and writes ${formatCount(c.dbWriteQps)} qps.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", clamp((READ_RPS + c.writeRps) / 50_000)),
      edge(
        "app-cache",
        "app",
        "cache",
        c.up ? clamp(c.readHit) : 0,
        cacheHealth === "down" ? "down" : "ok",
      ),
      edge("app-db", "app", "db", clamp(c.dbQps / (READ_RPS + c.writeRps)), dbHealth),
    ],
    metrics: [
      metric("db-qps", "Database queries", c.dbQps, " qps", 7_000, 9_000, "rps"),
      metric("read-p99", "Read p99", c.readP99, " ms", 150, 400, "ms"),
      metric("write-p99", "Write p99", c.writeP99, " ms", undefined, undefined, "ms"),
      metric("write-errors", "Write errors", c.writeErrors, "%", 1, 5, "percent"),
      metric("stale-reads", "Stale reads", c.staleReadPct, "%", 5, 30, "percent"),
      metric("write-ops", "Synchronous write ops", c.writeOps, " rps", undefined, undefined, "rps"),
      metric("cache-hit", "Cache hit rate", c.readHit * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCount(c.dbQps)} qps at the database; ${c.writeErrors.toFixed(0)}% write errors; ${c.staleReadPct.toFixed(0)}% stale reads; read p99 ${c.readP99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
          Math.sin(index / 2.1) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "write-errors",
    metricId: "write-errors",
    warn: 1,
    crit: 5,
    title: "Write-through is failing writes when the cache is down",
    cause:
      "Write-through puts the cache in the synchronous write path. With no bypass, a cache outage becomes a write outage even though the database is healthy.",
    fix: "Add a bounded bypass to write the database directly during a cache outage, and make the resulting cache staleness explicit. Alternatively use cache-aside for data whose write availability cannot depend on the cache.",
    checkFirst: [
      "Separate database write failures from cache write failures.",
      "Check whether the write path has a bypass and whether it is enabled.",
      "Check whether failed cache writes left a partial or stale value.",
    ],
  },
  {
    id: "db-qps",
    metricId: "db-qps",
    warn: 7_000,
    crit: 9_000,
    title: "The database is carrying the read path",
    cause:
      "The cache is unavailable, so every read misses and falls through to the database. Writes remain durable in cache-aside, but the origin is now serving read traffic it was never sized for.",
    fix: "Protect the origin with load shedding, request coalescing, and a bounded fallback. Restore the cache before restoring full traffic; do not treat a write success as proof that the read path is healthy.",
    checkFirst: [
      "Compare database QPS with the cache hit rate and cache health.",
      "Check whether reads and writes are both hitting the same database.",
      "Check whether a retry or fallback path is multiplying load.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 150,
    crit: 400,
    title: "Read latency is dominated by database queueing",
    cause:
      "Reads that used to hit the cache are now database queries, and the database is above its usable capacity. The tail is the queue, not one slow statement.",
    fix: "Restore or bypass the cache safely, shed noncritical reads, and coalesce duplicate misses. Adding database capacity may buy time but does not rebuild the cache.",
    checkFirst: [
      "Compare read p99 with cache hit rate and database QPS.",
      "Check pool wait and timeout counts.",
      "Check whether stale data could serve some reads during recovery.",
    ],
  },
  {
    id: "stale-reads",
    metricId: "stale-reads",
    warn: 5,
    crit: 30,
    title: "Cache-aside is serving reads older than the freshness contract",
    cause:
      "The database write succeeded but the cached copy was not invalidated in time. Reads of recently updated keys keep returning the old value until invalidation or TTL removes it.",
    fix: "Delete the key after the database commit, add versioned keys or a short TTL as a backstop, and make the invalidation path observable. Do not rely on a cache update alone; concurrent readers can repopulate the old value.",
    checkFirst: [
      "Compare the stale read rate with the write rate and invalidation delay.",
      "Check whether invalidation is asynchronous and whether it retries.",
      "Check whether reads can repopulate the cache between the commit and the delete.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const asideVsWriteThroughModel: SimModel = {
  id: "caching-aside-vs-write-through",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const noisy = {
      ...p,
      writeRps: Math.max(0, num(p, "writeRps", 500) * (1 + rng.between(-0.003, 0.003))),
    };
    const next = buildFrame(noisy, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      seed: Number(frame.flags.seed ?? 20261110),
      paramsKey: key,
    };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const c = compute(p);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (c.writeErrors >= 5 && frame.flags.writeFailSeen !== 1) {
      pushEvent(next, {
        id: "write-through-failed-closed",
        at: frame.t,
        severity: "crit",
        title: "Write-through failed closed during a cache outage",
        detail: `${formatCount(c.writeRps)} writes/s are returning errors because the cache is in the synchronous path and no bypass is configured.`,
        nodeId: "app",
        metricId: "write-errors",
      });
      next.flags.writeFailSeen = 1;
    }
    if (c.writeErrors < 1) next.flags.writeFailSeen = 0;
    if (c.staleReadPct >= 30 && frame.flags.staleSeen !== 1) {
      pushEvent(next, {
        id: "cache-aside-stale",
        at: frame.t,
        severity: "crit",
        title: "Cache-aside served stale reads after a write",
        detail: `About ${c.staleReadPct.toFixed(0)}% of reads can return a value older than the last database write. The invalidation delay is ${c.delay.toFixed(0)}s.`,
        nodeId: "cache",
        metricId: "stale-reads",
      });
      next.flags.staleSeen = 1;
    }
    if (c.staleReadPct < 5) next.flags.staleSeen = 0;
    next.summary = `${formatCount(c.dbQps)} qps at the database; ${c.writeErrors.toFixed(0)}% write errors; ${c.staleReadPct.toFixed(0)}% stale reads; read p99 ${c.readP99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      c.writeThrough
        ? `Write-through sends each write to the cache and the database in the same path: ${formatCount(c.writeOps)} synchronous write operations/s for ${formatCount(c.writeRps)} updates/s.`
        : `Cache-aside writes the database and invalidates the cache: ${formatCount(c.writeRps)} database writes/s and the same number of invalidations. The cache is not in the write transaction.`,
    );
    items.push(
      `The database sees ${formatCount(c.dbReadQps)} read qps and ${formatCount(c.dbWriteQps)} write qps. The cache hit rate is ${(c.readHit * 100).toFixed(0)}%.`,
    );
    if (!c.up) {
      items.push(
        c.writeThrough
          ? "The cache is down and write-through has no bypass. The database is healthy, but writes fail because the cache is in the synchronous path."
          : "The cache is down. Writes still reach the database, but every read falls through to it and the origin becomes the bottleneck.",
      );
    }
    if (c.staleReadPct > 0) {
      items.push(
        `With a ${c.delay.toFixed(0)}s invalidation delay, up to ${c.staleReadPct.toFixed(0)}% of reads can see a value older than the latest write. The cache TTL is the final backstop.`,
      );
    }
    items.push(
      "Write-through is fresher only when both writes succeed. The database commit and the cache write are not one atomic operation.",
    );
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
    description:
      "Cache-aside with prompt invalidation. Reads hit the cache and writes commit to the database.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "More writes and a five-second invalidation delay push a small share of reads stale.",
    tone: "warn",
    params: defaults({ writeRps: 2_000, invalidationDelay: 5 }),
  },
  {
    id: "failure",
    label: "Cache down, write-through",
    description:
      "Write-through has no bypass, so a cache outage becomes a write outage and reads hit the database.",
    tone: "crit",
    params: defaults({ strategy: 1, writeRps: 2_000, invalidationDelay: 0, cacheUp: 0 }),
  },
  {
    id: "stale-reads",
    label: "Stale reads",
    description:
      "Cache-aside leaves a 60-second invalidation delay and serves old values after writes.",
    tone: "crit",
    params: defaults({ writeRps: 2_000, invalidationDelay: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Cache-aside with immediate invalidation keeps writes durable and reads fresh.",
    tone: "ok",
    params: defaults({ writeRps: 2_000, invalidationDelay: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-cache-aside",
  title: "Predict which strategy serves stale reads",
  simId: "aside-vs-write-through",
  question:
    "A write lands in the database, but the cache invalidation is delayed by 60 seconds. Which strategy serves stale reads, and what changes with write-through?",
  prediction: {
    options: [
      {
        id: "aside-stale",
        label:
          "Cache-aside serves stale reads; write-through keeps the cache fresh at extra write cost",
      },
      { id: "both-stale", label: "Both serve stale reads because the cache has a TTL" },
      {
        id: "through-stale",
        label: "Write-through serves stale reads because it writes the database first",
      },
      { id: "none", label: "Neither serves stale data once the database commit returns" },
    ],
    correctOptionId: "aside-stale",
    explanation:
      "Cache-aside writes the database and then invalidates the cache. If invalidation is delayed, the old value remains readable until the delete or the TTL removes it. Write-through writes the cached copy in the same synchronous path as the database, so the next read is fresh if both writes succeed. The cost is an extra cache write on every update and a synchronous dependency on the cache.",
  },
  setup: defaults({ strategy: 0, writeRps: 2_000, invalidationDelay: 60, cacheUp: 1 }),
  runFor: 20,
  observe: [
    "Before the fix, about 95% of reads can see a value older than the latest write.",
    "The database stays below its warning threshold because the cache still absorbs most reads.",
    "Write p99 stays near 21 ms; the invalidation is asynchronous and does not sit in the write path.",
    "After switching to write-through, stale reads fall to zero and synchronous write operations double.",
    "Write p99 rises slightly because the cache write is now synchronous.",
  ],
  explain:
    "Cache-aside treats the cache as optional. The database write is the source of truth, and invalidation is a separate step that can lag, fail, or race with a concurrent read. Write-through makes the cache part of the write path, so freshness improves when both writes succeed. It does not make the pair atomic: a database commit can succeed and a cache write can fail, leaving the cache stale until the next write, invalidation, or TTL.",
  fix: defaults({ strategy: 1, writeRps: 2_000, invalidationDelay: 60, cacheUp: 1 }),
  debrief:
    "Write-through removed the stale-read window at the cost of a second synchronous write and a new failure mode: if the cache is unavailable and there is no bypass, writes fail even though the database is healthy. Cache-aside kept writes durable and the cache optional, but it needed prompt invalidation or a shorter TTL to meet freshness. Neither strategy is free; the choice follows the data's freshness and availability requirements.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cache-aside and write-through differ in where the cache sits on the write path. In cache-aside, the application reads the cache first, loads from the database on a miss, and stores the result. On a write, it commits to the database and then deletes or invalidates the cached key. The cache is optional: if it is unavailable, reads fall back to the database and writes still succeed. The cost is a stale window between the database commit and the invalidation, plus the race where a concurrent reader repopulates the old value before the delete arrives.",
  },
  {
    type: "p",
    text: "In write-through, the application writes the cache and the database in the same synchronous path. A read after a successful write should hit a fresh cached value, so the read path stays fast and the stale window is small. The cost is on writes: every update performs two operations, and the cache is now part of write availability. If the cache write fails, the application must choose between failing the write and bypassing the cache. Failing closed avoids acknowledging a write that the cache did not accept, but it turns a cache outage into a write outage. Bypassing keeps writes available but leaves a stale cached value that must be invalidated or expired.",
  },
  {
    type: "p",
    text: "Neither pattern makes the database and cache atomic. A database commit can succeed and a cache write or delete can fail. A cache write can succeed and the database commit can fail, leaving the cache ahead of the source of truth. Production designs add idempotent retries, versioned values, a short TTL as a backstop, and a way to bypass the cache during an outage. The TTL is not the primary freshness mechanism; it is the limit on how long a mistake can survive.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, service, cache, database. The write path is client, service, then either database plus invalidation (cache-aside) or cache plus database (write-through). In a cache-aside design the cache is a read accelerator; in a write-through design it is a synchronous copy of the write. That difference decides what happens when the cache is slow or down: cache-aside degrades reads, write-through can degrade writes.",
  },
  {
    type: "compare",
    leftTitle: "Cache-aside",
    rightTitle: "Write-through",
    rows: [
      {
        label: "Write path",
        left: "Commit to database, then invalidate cache",
        right: "Write cache and database synchronously",
      },
      {
        label: "Freshness",
        left: "Stale until invalidation or TTL; races are possible",
        right: "Fresh after both writes succeed; partial failure still leaves a gap",
      },
      {
        label: "Cache outage",
        left: "Reads fall back to the database; writes continue",
        right: "Without a bypass, writes fail; with a bypass, the cache can be stale",
      },
      {
        label: "Write cost",
        left: "One database write plus an invalidation",
        right: "One cache write plus one database write",
      },
      {
        label: "Best fit",
        left: "Read-heavy data that tolerates a short stale window",
        right:
          "Data whose reads must see the latest write and whose writes can afford the cache dependency",
      },
    ],
  },
  {
    type: "p",
    text: "The model uses 20,000 reads per second, an illustrative 10,000 queries-per-second database, and a cache-aside hit rate of 95%. These are teaching values, not service limits. The invalidation delay is a simplification of an asynchronous delete or a missed invalidation, not a guarantee that every stale read lasts exactly that long.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Database QPS split into read and write traffic.",
      "Read p99 and write p99, which move when the cache is on or off the path.",
      "Write errors when write-through fails closed during a cache outage.",
      "Stale reads as a percentage of reads after a delayed invalidation.",
      "Cache hit rate and synchronous write operations, which expose the extra work of write-through.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Stale reads to see cache-aside's freshness gap. Switch Write strategy to 1 and watch stale reads fall while synchronous write operations double. Apply Cache down, write-through to see the opposite failure: the database is healthy but writes fail. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      [
        "Invalidation delay",
        "How long an old value survives after a database write",
        "Freshness; a missed invalidation can outlive the delay",
      ],
      [
        "Write-through",
        "Puts the cache in the synchronous write path",
        "Write latency, extra write ops, and cache availability coupling",
      ],
      [
        "Bypass on cache failure",
        "Keeps writes available during a cache outage",
        "The cache can be stale until invalidation or TTL",
      ],
      [
        "Shorter TTL",
        "Bounds how long a stale value can survive",
        "More refresh traffic and lower hit rate",
      ],
    ],
  },
  {
    type: "p",
    text: "Choose by data class, not by one global setting. A product catalog can tolerate a short stale window; an account balance or an inventory reservation usually cannot.",
  },
  { type: "sim", simId: "aside-vs-write-through" },
  { type: "experiment", experimentId: "predict-stale-cache-aside" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In cache-aside, the database write succeeded but the cached copy survived the invalidation delay. Reads of recently updated keys kept returning the old value, so the database was healthy and the cache was fast while the product served stale data. Switching to write-through put the cache in the write path and closed that window: the next read saw the new value. The cost appeared as a second synchronous write and a higher write p99.",
  },
  {
    type: "p",
    text: "The failure preset showed the other side. With the cache down and write-through configured to fail closed, writes returned errors even though the database was available. Cache-aside kept writes durable and shifted the pressure to the read path, where every read missed and the database saw the full read rate. The strategy moved the failure; it did not remove it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache-aside: a stale-read rate that rises with write rate and invalidation lag; database QPS that stays normal while users report old values.",
      "Write-through: write p99 includes the cache write; cache error rate appears as write errors if the path fails closed.",
      "Cache outage: cache hit rate at zero, database read QPS at the full request rate, and pool wait rising.",
      "Write path: duplicate write operations, retries, and partial failures where one store succeeded and the other did not.",
      "Freshness: key age, version, or last-write timestamp on the read path, not only cache hit rate.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Separate database health from cache health and from write-path health. Check the invalidation path and its retries, then check whether write-through has a bypass. Confirm which data classes require read-your-writes before choosing a global strategy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify the data by freshness and write-availability requirements.",
      "For cache-aside, delete after the database commit, retry the invalidation, and add a short TTL as a backstop.",
      "For write-through, add a bounded bypass for cache outages and make the resulting staleness visible.",
      "Make writes idempotent and versioned so a retry cannot apply an older value.",
      "Verify read p99, write p99, stale reads, and write errors under cache-up and cache-down conditions.",
      "Document the failure mode that remains: stale reads for cache-aside, write coupling for write-through.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cache-aside keeps the cache optional and writes durable, but it can serve stale data until invalidation or TTL.",
      "Write-through keeps reads fresh after a successful write, but adds a synchronous cache write and a cache dependency on the write path.",
      "A bypass preserves write availability during a cache outage but leaves a stale cached value that must be invalidated or expired.",
      "A shorter TTL bounds staleness but increases refresh traffic and lowers the hit rate.",
      "Neither pattern makes the two stores atomic; versioning and idempotency are still required.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-strategy",
    question:
      "You have a read-heavy catalog and a balance service. Which caching strategy fits each, and why?",
    difficulty: 2,
    hints: [
      "Start from freshness and write availability, not read latency.",
      "A catalog can tolerate a short stale window; a balance usually cannot.",
    ],
    answer:
      "I would use cache-aside for the catalog. Reads dominate, the cache is an accelerator, a short stale window is acceptable, and a cache outage should not block catalog updates. I would invalidate after the database commit and keep a short TTL as a backstop. For the balance service I would be much stricter: either avoid caching the authoritative balance, or use write-through with a clear read-your-writes path and a bypass plan. The balance write cannot silently fail because the cache is down, and a stale read can be a correctness incident. The decision is per data class, not one cache policy for the whole product.",
    followUps: [
      "What if the catalog has a price that must be exact?",
      "How would you handle a cache outage for the balance service?",
      "Would you use the same TTL for both?",
    ],
    redFlags: [
      "Chooses one strategy for every data class.",
      "Ignores write availability.",
      "Treats a TTL as a substitute for correct invalidation.",
    ],
    rubric: [
      "Separates data by freshness and availability.",
      "Explains the failure mode of each choice.",
      "Names invalidation and TTL roles.",
      "Keeps writes durable.",
    ],
  },
  {
    id: "stale-window",
    question:
      "A cache-aside update commits to the database, then deletes the cache key. How can a read still return the old value?",
    difficulty: 3,
    hints: [
      "The delete is a separate operation from the commit.",
      "A concurrent reader can repopulate the key.",
    ],
    answer:
      "The delete can lag, fail, or be lost. If a read misses between the database commit and the delete, it can load the old value if the read started before the commit, or it can load the new value and then be overwritten by an older in-flight read that writes back after the delete. The old value then survives until the next invalidation or the TTL. I would delete after the commit, retry the delete, use versioned values or a compare-and-set, and keep a short TTL as a bound. I would also measure stale reads directly rather than assuming the invalidation path works.",
    followUps: [
      "Does deleting before the write help?",
      "How would a version token change the design?",
      "What is the role of the TTL here?",
    ],
    redFlags: [
      "Assumes the delete is atomic with the commit.",
      "Relies only on TTL for freshness.",
      "Ignores in-flight reads that repopulate the key.",
    ],
    rubric: [
      "Names the commit/delete gap.",
      "Explains the repopulation race.",
      "Adds retries, versioning, or a TTL bound.",
      "Measures stale reads.",
    ],
  },
  {
    id: "write-through-failure",
    question:
      "Write-through is failing all writes during a cache outage while the database is healthy. What are your options?",
    difficulty: 3,
    hints: [
      "The cache is in the synchronous write path.",
      "Failing closed and bypassing have different correctness costs.",
    ],
    answer:
      "The immediate options are to restore the cache, enable a bypass that writes the database directly, or fail the writes. Failing closed protects cache consistency but turns a cache outage into a product outage, which is rarely acceptable if the database can take the write. A bypass keeps writes available but leaves the cached copy stale, so I need an invalidation or versioning path and a way to prevent reads from serving the old value. I would make the bypass bounded and observable, then reconcile the cache after recovery. Long term, I would use cache-aside for data whose write availability cannot depend on the cache, or make the cache write asynchronous with a durable queue and accept a different loss window.",
    followUps: [
      "What does the bypass do to read freshness?",
      "How do you reconcile the cache after recovery?",
      "Would you retry the cache write in the background?",
    ],
    redFlags: [
      "Accepts a write outage because the cache is part of the path.",
      "Adds a bypass without addressing stale reads.",
      "Retries the cache write without idempotency.",
    ],
    rubric: [
      "Names fail-closed versus bypass.",
      "Explains the correctness cost of each.",
      "Restores availability without hiding staleness.",
      "Plans reconciliation and monitoring.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each cached data class has a documented freshness and write-availability requirement.",
      "Invalidation is retried and observable; the TTL is a backstop, not the primary mechanism.",
      "Write-through has a tested bypass and a plan for the stale value it leaves.",
      "Dashboards show stale reads, write errors, cache hit rate, and database read and write QPS.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate database health from cache health and write-path health.",
      "For cache-aside, check invalidation lag and whether reads are repopulating old values.",
      "For write-through, decide between failing closed and bypassing, and state the freshness cost.",
      "Protect the database from the read fallback before restoring full traffic.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile the cache with the database and verify version or timestamp ordering.",
      "Measure stale reads and write errors under both cache-up and cache-down conditions.",
      "Remove temporary bypasses and document the remaining failure mode.",
      "Add a test that fails the cache during a write burst.",
    ],
  },
];

const references = [
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside, write-through, TTL, and failure behavior.",
  },
  {
    title: "Redis cache-aside",
    url: "https://redis.io/docs/latest/develop/use-cases/cache-aside",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Cache-aside reads, invalidation, and consistency tradeoffs.",
  },
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies",
    publisher: "Amazon Builders' Library",
    kind: "docs" as const,
    note: "Write-path choices, stale data, and cache failure behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "aside-vs-write-through": {
      model: asideVsWriteThroughModel,
      presets,
      instructions:
        "Mechanic: Read/write path with strategy switch; latency and staleness. Start Healthy, then apply Stale reads to see cache-aside's freshness gap. Switch Write strategy to write-through and watch stale reads fall while synchronous write operations double. Then apply Cache down, write-through to see the write-availability failure.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The service serves 20,000 reads/s against a 10,000 QPS database; cache-aside hit rate is 95%, write-through is 99%. These are teaching values, not service limits. The break condition is a cache failure losing writes or serving stale data; recovery restores the cache and prompt invalidation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-caching-strategies",
    "caching-write-behind",
    "caching-cache-stampede",
    "caching-request-coalescing",
  ],
};
