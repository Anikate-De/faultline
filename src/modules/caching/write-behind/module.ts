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

const CACHE_ACK_MS = 1.2;
const DB_WRITE_MS = 20;
const DB_CAPACITY = 12_000;
const MAX_WRITE_RPS = 8_000;

const params = [
  {
    id: "writeRps",
    label: "Write rate",
    min: 100,
    max: 8_000,
    step: 100,
    value: 1_000,
    unit: " rps",
    group: "Traffic",
    help: "Updates accepted by the service. The cache acknowledges each one before the database flush.",
    format: "rps" as const,
  },
  {
    id: "flushDelayMs",
    label: "Flush delay",
    min: 20,
    max: 5_000,
    step: 20,
    value: 200,
    unit: " ms",
    group: "Durability",
    help: "How long an acknowledged write can wait in the cache before it reaches durable storage. It sets the loss window.",
    format: "ms" as const,
  },
  {
    id: "flushConcurrency",
    label: "Flush concurrency",
    min: 1,
    max: 16,
    step: 1,
    value: 1,
    unit: " workers",
    group: "Durability",
    help: "Parallel flush workers. More workers raise throughput and the chance that two updates to one key reach the database out of order.",
    format: "count" as const,
  },
  {
    id: "cacheCrashed",
    label: "Cache state",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Durability",
    help: "1 models a cache crash before the buffered writes reach durable storage. 0 keeps the cache and flush path running.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  writeRps: number;
  delaySec: number;
  concurrency: number;
  crashed: boolean;
  ackMs: number;
  recordsAtRisk: number;
  lostWrites: number;
  reorderRisk: number;
  dbWriteQps: number;
  util: number;
}

function compute(p: Params): Computed {
  const writeRps = Math.max(0, num(p, "writeRps", 1_000));
  const delaySec = Math.max(0, num(p, "flushDelayMs", 200)) / 1000;
  const concurrency = Math.max(1, Math.round(num(p, "flushConcurrency", 1)));
  const crashed = num(p, "cacheCrashed", 0) >= 0.5;
  const recordsAtRisk = writeRps * delaySec;
  const reorderRisk = Math.min(100, (concurrency - 1) * 10);
  return {
    writeRps,
    delaySec,
    concurrency,
    crashed,
    ackMs: CACHE_ACK_MS,
    recordsAtRisk,
    lostWrites: crashed ? recordsAtRisk : 0,
    reorderRisk,
    dbWriteQps: crashed ? 0 : writeRps,
    util: (crashed ? 0 : writeRps) / DB_CAPACITY,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const c = compute(p);
  const appHealth = c.crashed ? "crit" : c.recordsAtRisk >= 500 ? "warn" : "ok";
  const cacheHealth = c.crashed ? "down" : "ok";
  const flushHealth = c.crashed
    ? "crit"
    : c.reorderRisk >= 40
      ? "crit"
      : c.reorderRisk >= 15
        ? "warn"
        : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Writers",
        kind: "client",
        health: "ok",
        utilization: clamp(c.writeRps / MAX_WRITE_RPS),
        throughput: c.writeRps,
        sublabel: `${formatCount(c.writeRps)} writes/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Service",
        kind: "service",
        health: appHealth,
        utilization: clamp(c.writeRps / MAX_WRITE_RPS),
        throughput: c.writeRps,
        sublabel: c.crashed ? "acknowledged writes at risk" : `ack ${CACHE_ACK_MS.toFixed(1)} ms`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Write-behind cache",
        kind: "cache",
        health: cacheHealth,
        throughput: c.crashed ? 0 : c.writeRps,
        sublabel: c.crashed ? "crashed before flush" : `${formatCount(c.recordsAtRisk)} unflushed`,
        detail:
          "The cache acknowledges before durable storage. The value is visible to cache readers immediately, but it is not durable until the flush completes.",
        meta: { view: "flow" },
      },
      {
        id: "flush",
        label: "Flush workers",
        kind: "worker",
        health: flushHealth,
        throughput: c.dbWriteQps,
        sublabel: `${c.concurrency} worker${c.concurrency === 1 ? "" : "s"}`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Durable database",
        kind: "db",
        health: "ok",
        utilization: clamp(c.util),
        throughput: c.dbWriteQps,
        sublabel: `${formatCount(c.dbWriteQps)} writes/s`,
        detail: `Illustrative database write capacity is ${formatCount(DB_CAPACITY)} writes/s; the model assumes each database write takes about ${DB_WRITE_MS} ms.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", clamp(c.writeRps / MAX_WRITE_RPS)),
      edge(
        "app-cache",
        "app",
        "cache",
        c.crashed ? 0 : clamp(c.writeRps / MAX_WRITE_RPS),
        cacheHealth === "down" ? "down" : "ok",
      ),
      edge(
        "cache-flush",
        "cache",
        "flush",
        c.crashed ? 0 : clamp(c.writeRps / MAX_WRITE_RPS),
        flushHealth,
      ),
      edge("flush-db", "flush", "db", clamp(c.dbWriteQps / DB_CAPACITY), "ok"),
    ],
    metrics: [
      metric("write-p99", "Write acknowledgement p99", c.ackMs, " ms", undefined, undefined, "ms"),
      metric("durability-lag", "Ack-to-durable lag", c.delaySec, " s", 1, 3, "number"),
      metric("records-at-risk", "Records at risk", c.recordsAtRisk, "", 500, 2_000, "count"),
      metric("lost-writes", "Lost on crash", c.lostWrites, "", 1, 100, "count"),
      metric("reorder-risk", "Reorder risk", c.reorderRisk, "%", 15, 40, "percent"),
      metric("db-write-qps", "Database writes", c.dbWriteQps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCount(c.writeRps)} writes/s acknowledged at ${c.ackMs.toFixed(1)}ms; ${formatCount(c.recordsAtRisk)} records in the ${(c.delaySec * 1000).toFixed(0)}ms loss window; ${formatCount(c.lostWrites)} lost.`,
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
    id: "lost-writes",
    metricId: "lost-writes",
    warn: 1,
    crit: 100,
    title: "Acknowledged writes were lost in the cache crash",
    cause:
      "The cache accepted and acknowledged writes that had not reached durable storage. A crash or eviction removed them before the flush.",
    fix: "For data that cannot lose writes, write synchronously or put a durable queue between the cache and the database. Replay the queue after recovery and reconcile with the source of truth.",
    checkFirst: [
      "Identify which writes were acknowledged but not flushed.",
      "Check the cache persistence mode and the last durable point.",
      "Check whether the database has a unique constraint or idempotency key to detect gaps.",
    ],
  },
  {
    id: "records-at-risk",
    metricId: "records-at-risk",
    warn: 500,
    crit: 2_000,
    title: "The write buffer holds more records than the loss budget allows",
    cause:
      "Write-behind acknowledges before durable storage. Every acknowledged write inside the flush delay is at risk if the cache fails, and a larger write rate or longer delay widens that window.",
    fix: "Shorten the flush delay, batch by size as well as time, and move the buffer to a durable log or queue if the records cannot be lost. Verify the loss budget against the write rate.",
    checkFirst: [
      "Multiply write rate by flush delay to size the window.",
      "Check whether the buffer is only in cache memory or is persisted elsewhere.",
      "Check whether replication or failover can lose the same records.",
    ],
  },
  {
    id: "durability-lag",
    metricId: "durability-lag",
    warn: 1,
    crit: 3,
    title: "The ack-to-durable lag exceeds the recovery objective",
    cause:
      "The flush interval is longer than the product's acceptable loss window. A fast acknowledgement does not mean the write is durable.",
    fix: "Set the flush interval from the recovery point objective (RPO), not from throughput alone. Flush on size and time, and make the acknowledgement policy explicit to callers.",
    checkFirst: [
      "Compare the flush delay with the documented RPO.",
      "Check whether flush-on-size can shorten the window under load.",
      "Check whether the database commit is acknowledged before the flush is considered complete.",
    ],
  },
  {
    id: "reorder-risk",
    metricId: "reorder-risk",
    warn: 15,
    crit: 40,
    title: "Concurrent flushes can apply an older value last",
    cause:
      "Two workers flush updates for the same key in parallel. The database applies last-write-wins, so the order of arrival, not the order of acknowledgement, decides the stored value.",
    fix: "Use one writer per key or partition, coalesce updates to the latest value, or attach a monotonic version and reject older writes. Make retries idempotent.",
    checkFirst: [
      "Check whether flush workers are partitioned by key.",
      "Check whether updates carry a version or sequence number.",
      "Check whether a retry can arrive after a newer update.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const writeBehindModel: SimModel = {
  id: "caching-write-behind",
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
      writeRps: Math.max(0, num(p, "writeRps", 1_000) * (1 + rng.between(-0.003, 0.003))),
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
    if (c.crashed && frame.flags.crashSeen !== 1) {
      pushEvent(next, {
        id: "write-behind-crash",
        at: frame.t,
        severity: "crit",
        title: "Cache crash lost acknowledged writes",
        detail: `${formatCount(c.lostWrites)} writes were acknowledged but not durable. The flush delay was ${(c.delaySec * 1000).toFixed(0)}ms at ${formatCount(c.writeRps)} writes/s.`,
        nodeId: "cache",
        metricId: "lost-writes",
      });
      next.flags.crashSeen = 1;
    }
    if (!c.crashed) next.flags.crashSeen = 0;
    if (c.reorderRisk >= 40 && frame.flags.reorderSeen !== 1) {
      pushEvent(next, {
        id: "flush-reorder-risk",
        at: frame.t,
        severity: "warn",
        title: "Concurrent flushes can reorder updates",
        detail: `${c.concurrency} workers flush the same keys in parallel. Last-write-wins at the database may apply an older update after a newer one.`,
        nodeId: "flush",
        metricId: "reorder-risk",
      });
      next.flags.reorderSeen = 1;
    }
    if (c.reorderRisk < 15) next.flags.reorderSeen = 0;
    next.summary = `${formatCount(c.writeRps)} writes/s acknowledged at ${c.ackMs.toFixed(1)}ms; ${formatCount(c.recordsAtRisk)} records in the ${(c.delaySec * 1000).toFixed(0)}ms loss window; ${formatCount(c.lostWrites)} lost.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `${formatCount(c.writeRps)} writes/s with a ${(c.delaySec * 1000).toFixed(0)}ms flush delay puts about ${formatCount(c.recordsAtRisk)} acknowledged records at risk. The acknowledgement is ${c.ackMs.toFixed(1)}ms; durability is later.`,
    );
    items.push(
      `The database receives ${formatCount(c.dbWriteQps)} writes/s when the cache is healthy. A crash stops the flush and leaves the buffered records behind.`,
    );
    if (c.reorderRisk > 0) {
      items.push(
        `${c.concurrency} flush workers create about ${c.reorderRisk.toFixed(0)}% reorder risk in this illustrative model. At least one key partition, a version, or a single writer is needed to keep the latest value.`,
      );
    }
    if (c.crashed) {
      items.push(
        "The crash lost the whole window because the buffer lived only in cache memory. A durable queue or a synchronous database write moves the durability boundary.",
      );
    } else {
      items.push(
        "Cache persistence can shrink the window, but it does not make the cache a durable queue. Replication, fsync policy, and failover decide what survives.",
      );
    }
    items.push(
      "A fast acknowledgement is a promise about latency, not about durability. State which one the caller is receiving.",
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
    description: "Modest writes, a short flush delay, one worker, and no crash.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "Higher write rate and two workers put 800 records at risk but stay below critical.",
    tone: "warn",
    params: defaults({ writeRps: 4_000, flushDelayMs: 200, flushConcurrency: 2, cacheCrashed: 0 }),
  },
  {
    id: "failure",
    label: "Crash before flush",
    description:
      "A two-second flush delay and eight workers leave 8,000 acknowledged writes in a crash.",
    tone: "crit",
    params: defaults({
      writeRps: 4_000,
      flushDelayMs: 2_000,
      flushConcurrency: 8,
      cacheCrashed: 1,
    }),
  },
  {
    id: "recovery",
    label: "Short, ordered flush",
    description: "A 50 ms flush delay and one worker shrink the window and remove reorder risk.",
    tone: "ok",
    params: defaults({ writeRps: 4_000, flushDelayMs: 50, flushConcurrency: 1, cacheCrashed: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-loss-window",
  title: "Predict what a cache crash loses",
  simId: "write-behind",
  question:
    "Write-behind acknowledges 4,000 writes/s at 1.2 ms and flushes every two seconds. The cache crashes before the next flush. What is lost?",
  prediction: {
    options: [
      {
        id: "window",
        label: "The writes acknowledged during the last flush window, about 8,000 records",
      },
      { id: "flushed", label: "Only writes that already reached the database" },
      { id: "nothing", label: "Nothing, because the cache has a TTL" },
      { id: "reads", label: "Only reads that were waiting on the cache" },
    ],
    correctOptionId: "window",
    explanation:
      "The cache acknowledged writes before they reached durable storage. At 4,000 writes/s and a two-second flush delay, about 8,000 acknowledged records sit in the buffer. A crash before the flush loses that window. Writes that already reached the database are durable; a TTL does not make an unflushed value durable.",
  },
  setup: defaults({ writeRps: 4_000, flushDelayMs: 2_000, flushConcurrency: 8, cacheCrashed: 1 }),
  runFor: 20,
  observe: [
    "Before the fix, about 8,000 acknowledged writes are lost and the ack-to-durable lag is two seconds.",
    "Eight concurrent flush workers create about 70% reorder risk for updates to the same key.",
    "The database receives no new writes after the crash because the flush path is gone.",
    "After a 50 ms flush delay and one worker, only about 200 records are at risk and reorder risk is zero.",
    "Write acknowledgement stays near 1.2 ms; durability improves without giving up the cache ack path.",
  ],
  explain:
    "The loss window is the write rate multiplied by the time between acknowledgement and durable commit, plus anything already batched or retrying. Write-behind does not make the cache durable; it makes the cache the acknowledgement point. A durable queue or a synchronous database write changes where the promise is made. Ordering is a separate problem: parallel flushes for one key can apply an older value after a newer one unless a version or a single writer prevents it.",
  fix: defaults({ writeRps: 4_000, flushDelayMs: 50, flushConcurrency: 1, cacheCrashed: 0 }),
  debrief:
    "Shortening the flush delay shrank the loss window but did not remove it. Removing reorder risk required one writer per key. For data that cannot lose an acknowledged write, the buffer must be durable or the write must be synchronous; a faster cache acknowledgement is not a durability guarantee. Reconcile any lost range after recovery and make the acknowledgement policy explicit to callers.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Write-behind, also called write-back, acknowledges a write when it reaches the cache and flushes it to durable storage later. The cache absorbs bursts, batches updates, and returns much faster than a synchronous database write. The price is a loss window: every acknowledged write that has not reached durable storage can disappear if the cache crashes, is evicted, or fails over before the flush. The window is roughly the write rate multiplied by the flush delay, plus any batch already in flight or waiting on a retry.",
  },
  {
    type: "p",
    text: "The pattern is only as durable as its buffer. If the buffer lives in cache memory with no replication, a crash loses the window. Redis persistence can shrink the window, but it does not turn the cache into a durable queue: an append-only file with a one-second fsync policy can lose up to that interval, a snapshot loses everything since the last snapshot, and a failover can lose writes that had not replicated. A durable log or queue between the cache and the database moves the durability boundary; a synchronous database write removes the window but gives up the fast acknowledgement.",
  },
  {
    type: "p",
    text: "Write-behind also changes ordering. If several workers flush updates for the same key in parallel, the database's last-write-wins behavior may apply an older update after a newer one. A single writer per key or partition, coalescing to the latest value, or a monotonic version with a conditional update prevents that. Reads also need a policy: the cache has the new value before the database does, so a cache miss or another region can read the old one. Read-your-writes requires a version token, a session pin, or a read from the cache until the flush completes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The write path is client, service, cache, flush workers, database. The cache acknowledges immediately and holds a buffer; the flush workers batch and retry. The database is the durability boundary only after the flush commits. In a cache-aside design the database is written first and the cache is optional; in write-behind the cache is the acknowledgement point and the database is eventually updated.",
  },
  {
    type: "compare",
    leftTitle: "Write-through",
    rightTitle: "Write-behind",
    rows: [
      {
        label: "Acknowledgement",
        left: "After the cache and database writes succeed",
        right: "After the cache accepts the value",
      },
      {
        label: "Write latency",
        left: "Database write plus cache write",
        right: "Cache write only",
      },
      {
        label: "Durability",
        left: "Durable when the database commit succeeds",
        right: "Durable only after the flush; the buffer decides the loss window",
      },
      {
        label: "Ordering",
        left: "One synchronous path, easier to serialize",
        right: "Parallel flushes can reorder unless keyed or versioned",
      },
      {
        label: "Best fit",
        left: "Writes that cannot be lost and can afford the latency",
        right: "Bursty, lower-value writes with an explicit loss budget",
      },
    ],
  },
  {
    type: "p",
    text: "The model uses a 1.2 ms cache acknowledgement, a 20 ms database write, and an illustrative 12,000 writes-per-second database capacity. These are teaching values, not Redis or database limits. The model assumes the buffer is in cache memory only; a durable queue would change the loss calculation.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Write acknowledgement p99, which stays fast even when durability is at risk.",
      "Ack-to-durable lag and the number of acknowledged records sitting in the flush window.",
      "Lost writes after a crash, computed from the write rate and the unflushed window.",
      "Reorder risk from concurrent flush workers.",
      "Database write throughput, which falls to zero when the flush path is lost.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Crash before flush. Watch lost writes and reorder risk. Lower the flush delay and the worker count to see the window shrink; then compare the acknowledgement time with the durability lag. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      [
        "Flush delay",
        "How long an acknowledged write can sit in the buffer",
        "Shorter delay means less batching and more database load",
      ],
      [
        "Flush concurrency",
        "Flush throughput across keys",
        "Reorder risk for the same key unless partitioned or versioned",
      ],
      [
        "Durable queue",
        "Moves the durability boundary off the cache",
        "More infrastructure, replay, and idempotency work",
      ],
      ["Synchronous write", "Removes the loss window", "Gives up the fast acknowledgement"],
    ],
  },
  {
    type: "p",
    text: "Decide the loss budget before choosing the flush interval. A recovery point objective measured in seconds rules out a buffer that can lose minutes.",
  },
  { type: "sim", simId: "write-behind" },
  { type: "experiment", experimentId: "predict-loss-window" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The cache acknowledged writes in about a millisecond, while durable storage lagged by the flush delay. At 4,000 writes per second and a two-second delay, about 8,000 acknowledged records were still in the buffer. The crash removed the cache and the flush path, so those records were lost and the database stopped receiving updates.",
  },
  {
    type: "p",
    text: "The failure was not a slow database. It was a promise made too early: the caller was told the write succeeded before the durability boundary was crossed. Shortening the delay and using one worker shrank the window and removed reorder risk, but it did not make the buffer durable. The remaining fix is architectural: a durable queue or a synchronous write for data that cannot lose records.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache: accepted writes, buffer depth, flush lag, retries, and the last durable offset or snapshot.",
      "Database: write throughput and gaps or duplicate keys after recovery.",
      "Application: acknowledgement latency versus durable latency, and the fraction of writes served from cache only.",
      "Persistence: AOF fsync policy, RDB snapshot age, replication lag, and failover history. These bound the cache's own loss, not the application's promise.",
      "Ordering: version or sequence numbers on writes, and conditional-update failures that reveal stale flushes.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Calculate write rate times flush delay. Check whether the buffer is memory-only or durable, and whether replication or failover can lose the same records. Then check ordering and read-your-writes before restoring traffic.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "State the loss budget and compare it with the flush window.",
      "Make the buffer durable, or write synchronously for data that cannot lose an acknowledgement.",
      "Flush on both size and time, and bound retries with idempotency keys.",
      "Partition flushes by key or attach a monotonic version to prevent reordering.",
      "Define read-your-writes behavior while the database lags.",
      "Reconcile lost or duplicated ranges after recovery and verify with a crash test.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short flush delay reduces the loss window but lowers batching efficiency and raises database write load.",
      "A durable queue preserves acknowledged writes but adds infrastructure, replay, and duplicate-delivery handling.",
      "More flush workers raise throughput but increase reorder risk unless keys are partitioned or versioned.",
      "A synchronous write removes the loss window but gives up the latency advantage that motivated write-behind.",
      "Cache persistence helps with restarts but is not a substitute for an application-level durability boundary.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "quantify-loss",
    question: "How do you quantify the loss window of a write-behind cache?",
    difficulty: 3,
    hints: [
      "Start with the write rate and the flush interval.",
      "Add batches in flight, retries, and replication.",
    ],
    answer:
      "The first estimate is write rate multiplied by the time between acknowledgement and durable commit. I would add any batch already being flushed, records waiting on a retry, and anything that has not replicated to a failover target. Then I would compare that number with the product's recovery point objective. I would also check whether the flush is triggered by size as well as time, because a size trigger can shorten the window under load. The estimate is not a guarantee: the actual loss depends on where the crash lands relative to the flush and on the cache's persistence and replication behavior.",
    followUps: [
      "What changes if the buffer is a durable queue?",
      "How would you test the estimate?",
      "Does a shorter flush interval remove the window?",
    ],
    redFlags: [
      "Uses only the flush interval without the write rate.",
      "Assumes cache persistence is durability.",
      "Ignores retries and in-flight batches.",
    ],
    rubric: [
      "Multiplies rate by window.",
      "Adds in-flight and retry work.",
      "Compares with an RPO.",
      "Names persistence and replication limits.",
    ],
  },
  {
    id: "ordering",
    question:
      "How do you prevent out-of-order writes when several flush workers update the same key?",
    difficulty: 3,
    hints: [
      "Last-write-wins is decided by arrival order.",
      "A single writer or a version can impose order.",
    ],
    answer:
      "I would partition the flush queue by key so one worker owns a key at a time, or coalesce updates to the latest value before flushing. If parallel workers must handle the same key, I would attach a monotonic version or sequence number and use a conditional update that rejects an older version. Retries need idempotency keys so a delayed retry cannot overwrite a newer value. I would also emit reorder or stale-version metrics, because the failure is silent when last-write-wins applies the wrong value.",
    followUps: [
      "What if the database cannot do conditional updates?",
      "How does coalescing interact with audit history?",
      "How would you repair a key that was reordered?",
    ],
    redFlags: [
      "Assumes parallel flushes preserve order.",
      "Retries without idempotency.",
      "Coalesces updates and loses required history.",
    ],
    rubric: [
      "Partitions or coalesces by key.",
      "Uses a version or conditional write.",
      "Makes retries idempotent.",
      "Measures stale or reordered writes.",
    ],
  },
  {
    id: "when-write-behind",
    question: "When is write-behind acceptable, and when would you refuse it?",
    difficulty: 3,
    hints: [
      "Start from the cost of losing an acknowledged write.",
      "The answer is per data class, not per company.",
    ],
    answer:
      "I would accept write-behind for data where a short loss window is tolerable and the write rate or burst absorption matters: view counters, recommendations, analytics events, or a cache of derived values that can be rebuilt. I would refuse it for payments, inventory reservations, account balances, or anything where an acknowledged write is a promise to a customer or another system. If the throughput benefit is essential for those, I would put a durable queue or log in the path so the acknowledgement is durable, and treat the cache as a read accelerator rather than the system of record.",
    followUps: [
      "What if the product owner accepts the loss?",
      "How would you make the promise visible to callers?",
      "Would a durable queue still need reconciliation?",
    ],
    redFlags: [
      "Applies write-behind to every write for speed.",
      "Treats a cache TTL as a durability control.",
      "Ignores the cost of reconciliation after loss.",
    ],
    rubric: [
      "Separates data classes by loss cost.",
      "Names durable alternatives.",
      "Makes the acknowledgement policy explicit.",
      "Plans reconciliation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The loss budget is documented and compared with write rate times flush delay.",
      "The durability boundary is explicit: cache memory, cache persistence, durable queue, or database.",
      "Flushes are partitioned or versioned to preserve order.",
      "Dashboards show buffer depth, flush lag, lost writes, and reorder or stale-version counts.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop acknowledging writes that cannot be made durable.",
      "Preserve the buffer if the cache is still reachable; do not restart it blindly.",
      "Reconcile acknowledged writes against the database before restoring traffic.",
      "Check read-your-writes paths for values that were only in the cache.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replay or repair the lost range and verify idempotency.",
      "Measure the actual loss window and compare it with the RPO.",
      "Reduce the flush delay or move the buffer to durable storage.",
      "Add a crash test that fails the cache between acknowledgement and flush.",
    ],
  },
];

const references = [
  {
    title: "Redis persistence",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "RDB snapshots, AOF fsync policies, and the loss windows they imply.",
  },
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Write-behind, write-through, and cache failure tradeoffs.",
  },
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies",
    publisher: "Amazon Builders' Library",
    kind: "docs" as const,
    note: "Durability, staleness, and write-path design.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "write-behind": {
      model: writeBehindModel,
      presets,
      instructions:
        "Mechanic: Write path with flush delay; crash and lost records. Start Healthy, then apply Crash before flush. Compare the 1.2 ms acknowledgement with the ack-to-durable lag and lost writes. Lower the flush delay and worker count to shrink the window.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Cache acknowledgement is 1.2 ms, database write is 20 ms, and database capacity is 12,000 writes/s. The buffer is assumed to live in cache memory only. The break condition is a cache failure losing acknowledged writes; recovery shortens the window and removes reorder risk, but a durable queue or synchronous write is still required for zero loss.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-aside-vs-write-through",
    "caching-redis-persistence",
    "foundations-caching-strategies",
    "caching-cache-stampede",
  ],
};
