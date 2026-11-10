import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 8;
const SHARD_CAPACITY = 32_000;
const BASE_OPS = 2_000;
const WRITE_SHARE = 0.9;

const params = [
  {
    id: "hotKeyRps",
    label: "Hot key request rate",
    min: 10_000,
    max: 120_000,
    step: 5_000,
    value: 15_000,
    unit: " rps",
    group: "Traffic",
    help: "Reads and writes for one logical key. The model treats it as a write-heavy aggregate: 90% writes, 10% reads.",
    format: "rps" as const,
  },
  {
    id: "saltFanout",
    label: "Salt fan-out",
    min: 1,
    max: 8,
    step: 1,
    value: 1,
    unit: "",
    group: "Key scheme",
    help: "Number of deterministic subkeys. One means no salting. More variants spread writes but increase read fan-out.",
    format: "count" as const,
  },
  {
    id: "readCoverage",
    label: "Salted read coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Migration",
    help: "Share of readers that query all salted variants. The rest still read the original unsalted key.",
    format: "percent" as const,
  },
  {
    id: "legacyWrite",
    label: "Legacy key write coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Migration",
    help: "Share of writes that also update the old unsalted key. Keeps old readers fresh but adds write load to its shard.",
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
  ops: number;
  role: "old" | "variant" | "idle";
}

interface Computed {
  hotKeyRps: number;
  fanout: number;
  coverage: number;
  legacy: number;
  writes: number;
  reads: number;
  salted: boolean;
  variantWrite: number;
  variantRead: number;
  oldOps: number;
  staleShare: number;
  opsPerRead: number;
  hotKeyRedisOps: number;
  totalRedisOps: number;
  shards: ShardState[];
  maxCpu: number;
  p99: number;
}

function p99For(cpu: number): number {
  if (cpu >= 100) return 500;
  return Math.min(500, 1.5 + (45 * (cpu / 100) ** 5) / Math.max(0.05, 1.05 - cpu / 100));
}

function compute(p: Params): Computed {
  const hotKeyRps = Math.max(1, num(p, "hotKeyRps", 15_000));
  const fanout = Math.max(1, Math.min(SHARD_COUNT, Math.round(num(p, "saltFanout", 1))));
  const coverage = clamp(num(p, "readCoverage", 100) / 100);
  const legacy = clamp(num(p, "legacyWrite", 0) / 100);
  const salted = fanout > 1;
  const writes = hotKeyRps * WRITE_SHARE;
  const reads = hotKeyRps * (1 - WRITE_SHARE);
  const variantWrite = salted ? writes / fanout : 0;
  const variantRead = salted ? reads * coverage : 0;
  const oldOps = salted ? writes * legacy + reads * (1 - coverage) : hotKeyRps;
  const shards: ShardState[] = Array.from({ length: SHARD_COUNT }, (_, index) => {
    const variant = salted && index < fanout;
    const ops = BASE_OPS + (index === 0 ? oldOps : 0) + (variant ? variantWrite + variantRead : 0);
    return {
      index,
      cpu: (ops / SHARD_CAPACITY) * 100,
      p99: p99For((ops / SHARD_CAPACITY) * 100),
      ops,
      role: variant ? (index === 0 ? "old" : "variant") : index === 0 ? "old" : "idle",
    };
  });
  const staleShare = salted ? (1 - coverage) * (1 - legacy) * 100 : 0;
  const hotKeyRedisOps = salted
    ? writes + reads * coverage * fanout + reads * (1 - coverage) + writes * legacy
    : hotKeyRps;
  return {
    hotKeyRps,
    fanout,
    coverage,
    legacy,
    writes,
    reads,
    salted,
    variantWrite,
    variantRead,
    oldOps,
    staleShare,
    opsPerRead: salted ? fanout * coverage + (1 - coverage) : 1,
    hotKeyRedisOps,
    totalRedisOps: hotKeyRedisOps + BASE_OPS * SHARD_COUNT,
    shards,
    maxCpu: Math.max(...shards.map((shard) => shard.cpu)),
    p99: Math.max(...shards.map((shard) => shard.p99)),
  };
}

function healthFor(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function staleHealth(stale: number): "ok" | "warn" | "crit" {
  if (stale >= 5) return "crit";
  if (stale >= 1) return "warn";
  return "ok";
}

function formatCpu(cpu: number): string {
  return cpu >= 100 ? "100+%" : `${cpu.toFixed(0)}%`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.4);
  const seeds: [string, number, number][] = [
    ["hot-shard-cpu", values.maxCpu, 2],
    ["redis-p99", values.p99, 3],
    ["stale-reads", values.staleShare, 0.2],
    ["total-redis-ops", values.totalRedisOps, 400],
    ["ops-per-read", values.opsPerRead, 0.04],
    ["salt-fanout", values.fanout, 0.05],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  for (const shard of values.shards) {
    frame.series[`cpu.shard-${shard.index}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, shard.cpu * jitter(index + shard.index) + Math.sin(index / 2.4 + shard.index) * 1.2),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const shardHealth = healthFor(values.maxCpu);
  const readHealth = staleHealth(values.staleShare);
  const staleDetail =
    values.staleShare >= 1
      ? ` ${values.staleShare.toFixed(0)}% of reads still use the unsalted key, which no longer receives all writes.`
      : "";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: readHealth,
        sublabel:
          values.staleShare >= 1 ? `${values.staleShare.toFixed(0)}% stale reads` : `${formatCount(values.hotKeyRps)} rps`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Product service",
        kind: "service",
        health: readHealth,
        utilization: clamp(values.hotKeyRps / 120_000),
        throughput: values.hotKeyRps,
        sublabel: `${values.fanout} salt variant${values.fanout === 1 ? "" : "s"}`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis Cluster",
        kind: "cache",
        health: shardHealth,
        utilization: values.maxCpu / 100,
        throughput: values.totalRedisOps,
        sublabel: `${formatCount(values.totalRedisOps)} ops/s total`,
        detail: `The logical key runs at ${formatCount(values.hotKeyRps)} rps. Hot-key work after salting is ${formatCount(values.hotKeyRedisOps)} ops/s; with ${formatCount(BASE_OPS * SHARD_COUNT)} background ops/s, the cluster total is ${formatCount(values.totalRedisOps)}.${staleDetail} Illustrative capacity: ${formatCount(SHARD_CAPACITY)} ops/s per shard.`,
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
        sublabel:
          shard.role === "old"
            ? shard.index === 0 && values.salted
              ? "old key + illustrative variant"
              : "old key"
            : shard.role === "variant"
              ? `salt ${shard.index}`
              : "other keys",
        detail: `${formatCpu(shard.cpu)} CPU, ${formatCount(shard.ops)} ops/s. ${
          shard.role === "old"
            ? `The unsalted key and one illustrative variant live here. Actual variant placement depends on the salt and the hash slot. ${values.staleShare.toFixed(0)}% of reads still use the unsalted key.`
            : shard.role === "variant"
              ? `One of ${values.fanout} salted variants. Writes are spread; reads fan out across all variants. Placement is illustrative.`
              : "Keys that are not part of the hot-key migration."
        }`,
        meta: {
          view: "shards",
          cpu: shard.cpu,
          memory: 4 + values.hotKeyRps / 240_000,
          p99: shard.p99,
          hot: shard.role !== "idle" && shard.cpu >= 85 ? 1 : 0,
        },
      })),
    ],
    edges: [
      edge("client-service", "client", "service", values.hotKeyRps / 120_000),
      edge("service-redis", "service", "redis", clamp(values.totalRedisOps / 200_000), shardHealth),
    ],
    metrics: [
      metric("hot-shard-cpu", "Hottest shard CPU", values.maxCpu, "%", 70, 85, "percent"),
      metric("stale-reads", "Stale reads", values.staleShare, "%", 1, 5, "percent"),
      metric("redis-p99", "Redis p99", values.p99, "ms", 40, 120, "ms"),
      metric("total-redis-ops", "Total Redis ops", values.totalRedisOps, " rps", undefined, undefined, "rps"),
      metric("ops-per-read", "Ops per read", values.opsPerRead, "", undefined, undefined, "number"),
      metric("salt-fanout", "Salt fan-out", values.fanout, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary:
      values.staleShare >= 1
        ? `${formatCpu(values.maxCpu)} on the hottest shard; ${values.staleShare.toFixed(0)}% of reads use the unsalted key; writes fan out across ${values.fanout} variants.`
        : `${formatCpu(values.maxCpu)} on the hottest shard; ${values.fanout} salt variants; ${formatCount(values.totalRedisOps)} total ops/s; ${values.opsPerRead.toFixed(1)} ops per read.`,
  };
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-shard-cpu",
    metricId: "hot-shard-cpu",
    warn: 70,
    crit: 85,
    title: "A salted or legacy shard is saturated",
    cause:
      "Salting spreads writes across variants, but read fan-out adds work to every variant shard. Dual-writing the old key adds the full write load back to its shard, recreating the hot spot.",
    fix:
      "Reduce the fan-out or the legacy write window. If the hot path is read-heavy, fan-out can cost more than the concentration it removes; serve the key from a local cache or read replicas instead.",
    checkFirst: [
      "Check whether the hottest shard is the old key's shard or a salted variant.",
      "Compare the total Redis ops with the logical request rate.",
      "Check the legacy write coverage and whether it is still needed.",
    ],
  },
  {
    id: "stale-reads",
    metricId: "stale-reads",
    warn: 1,
    crit: 5,
    title: "Readers are bypassing the salted variants",
    cause:
      "Writes moved to the salted key scheme, but some readers still read the original unsalted key. The old key no longer receives every write, so those reads return a frozen or incomplete value.",
    fix:
      "Route reads through the salted path before or with the write migration, or dual-write the old key during the transition. Backfill the variants and verify a read-your-writes check before removing the old path.",
    checkFirst: [
      "Compare the salted read coverage with the write coverage.",
      "Check the old key's value age and whether it still receives writes.",
      "Check for a client version or deploy that still uses the old key format.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Fan-out or a saturated variant is raising p99",
    cause:
      "A read that fans out across several variants waits for the slowest response and multiplies the number of Redis operations. One slow or saturated variant sets the tail for the whole logical read.",
    fix:
      "Bound the fan-out, fetch variants in parallel, and handle partial failures with a defined fallback. If one variant is hot, the salt distribution is uneven or the shard map is skewed.",
    checkFirst: [
      "Graph p99 by shard and by variant.",
      "Check whether the client fetches variants in parallel or sequentially.",
      "Check whether one variant receives more traffic because of a weak salt.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const keySaltingModel: SimModel = {
  id: "caching-key-salting",
  visual: "shards",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: JSON.stringify(p) };
    const key = JSON.stringify(p);
    if (frame.t <= 0.11 && frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, values, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
      );
    }
    const cpuJitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "hot-shard-cpu" ? { ...item, value: Math.max(0, item.value + cpuJitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const shard of next.nodes.filter((node) => node.meta?.view === "shards")) {
      recordSeries(next, `cpu.${shard.id}`, Number(shard.meta?.cpu ?? 0));
    }
    next.events = [...frame.events].slice(-60);
    if (values.staleShare >= 5 && frame.flags.staleFlagged !== 1) {
      pushEvent(next, {
        id: "salted-writes-unsalted-reads",
        at: frame.t,
        severity: "crit",
        title: "Writes are salted; reads are not",
        detail: `${values.staleShare.toFixed(0)}% of reads still use the unsalted key. ${values.salted ? `Writes fan out across ${values.fanout} variants, so the old key is not kept current.` : "Salting is not active."} The hottest shard is only at ${formatCpu(values.maxCpu)}, which is why a load dashboard misses this.`,
        nodeId: "client",
        metricId: "stale-reads",
      });
      next.flags.staleFlagged = 1;
    }
    if (values.staleShare < 1) next.flags.staleFlagged = 0;
    next.summary =
      values.staleShare >= 1
        ? `${formatCpu(values.maxCpu)} on the hottest shard; ${values.staleShare.toFixed(0)}% of reads use the unsalted key; ${values.fanout} salt variants.`
        : `${formatCpu(values.maxCpu)} on the hottest shard; ${values.fanout} salt variants; ${formatCount(values.totalRedisOps)} total ops/s; ${values.opsPerRead.toFixed(1)} ops per read.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Writes are ${formatCount(values.writes)} ops/s, split across ${values.fanout} variants. Salted read coverage is ${Math.round(values.coverage * 100)}%, producing about ${values.opsPerRead.toFixed(1)} Redis ops per read.`,
    );
    items.push(
      `Hot-key work is ${formatCount(values.hotKeyRedisOps)} ops/s; with ${formatCount(BASE_OPS * SHARD_COUNT)} background ops/s the cluster total is ${formatCount(values.totalRedisOps)} ops/s for ${formatCount(values.hotKeyRps)} logical requests per second. Fan-out raises work even when it spreads the load.`,
    );
    if (values.staleShare >= 1) {
      items.push(
        `${values.staleShare.toFixed(0)}% of reads still use the old key. Its shard is at ${formatCpu(values.shards[0].cpu)} CPU, so the failure is not visible as saturation.`,
      );
    } else {
      items.push(
        `All reads use the salted path. The old shard is at ${formatCpu(values.shards[0].cpu)} CPU; the hottest variant shard is at ${formatCpu(values.maxCpu)}.`,
      );
    }
    if (values.legacy > 0) {
      items.push(
        `Legacy write coverage is ${Math.round(values.legacy * 100)}%. That adds ${formatCount(values.writes * values.legacy)} writes/s to the old shard, which is the dual-write cost.`,
      );
    }
    items.push(
      "A salt only moves a key if it changes the hashed part. A suffix outside a {hash tag} hashes to the same slot.",
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
    description: "One unsalted key at a comfortable shard CPU. No fan-out, no migration.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "One unsalted key near the shard's warning threshold. The next step is a salt or a read cache.",
    tone: "warn",
    params: defaults({ hotKeyRps: 21_000, saltFanout: 1, readCoverage: 100, legacyWrite: 0 }),
  },
  {
    id: "failure",
    label: "Salted writes only",
    description: "Writes fan out across 8 variants, but every reader still reads the old key. Load is healthy; data is stale.",
    tone: "crit",
    params: defaults({ hotKeyRps: 90_000, saltFanout: 8, readCoverage: 0, legacyWrite: 0 }),
  },
  {
    id: "dual-write",
    label: "Dual-write bridge",
    description: "All reads and writes are salted, but every write also updates the old key. The old shard becomes hot again.",
    tone: "crit",
    params: defaults({ hotKeyRps: 80_000, saltFanout: 8, readCoverage: 100, legacyWrite: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Readers finish the migration and the legacy writes stop. The hottest shard returns below warning.",
    tone: "ok",
    params: defaults({ hotKeyRps: 90_000, saltFanout: 8, readCoverage: 100, legacyWrite: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-salting-break",
  title: "Predict what breaks when only writes are salted",
  simId: "key-salting",
  question:
    "You move writes to 8 salted variants but leave every reader on the old unsalted key. What fails first?",
  prediction: {
    options: [
      { id: "stale", label: "Reads return stale or incomplete values while CPU stays healthy." },
      { id: "cpu", label: "The old shard's CPU rises above its critical threshold." },
      { id: "p99", label: "Redis p99 rises because the fan-out is slower." },
      { id: "miss", label: "The cache hit rate collapses and the database saturates." },
    ],
    correctOptionId: "stale",
    explanation:
      "The write path moved to eight variants, so the old key no longer receives every write. Readers that still use the old key see the value from before the migration, and they see it with normal latency. Load is spread and CPU is lower, which is exactly why this failure is easy to miss. The fix is to move reads to the salted path or dual-write the old key during the transition.",
  },
  setup: defaults({ hotKeyRps: 90_000, saltFanout: 8, readCoverage: 0, legacyWrite: 0 }),
  runFor: 20,
  observe: [
    "Stale reads show 100%; the value is frozen at the pre-migration version.",
    "The hottest shard stays below the 70% warning threshold, so a load-only dashboard looks healthy.",
    "Total Redis ops are about 106k/s: 90k for the hot key plus 16k of background keyspace traffic.",
    "Redis p99 stays low; this is a correctness failure, not a latency failure.",
    "The old key's shard stays below its warning threshold, but it also hosts one illustrative variant and carries the old read path.",
  ],
  explain:
    "Salting changes the key scheme. Writes now land on the variants, but a reader that still asks for the old key is asking for a key that is no longer authoritative. The old value may persist until its TTL, so the failure looks like stale data rather than a miss. A safe migration moves reads and writes together, or keeps the old key fresh until every reader has moved.",
  fix: defaults({ hotKeyRps: 90_000, saltFanout: 8, readCoverage: 100, legacyWrite: 0 }),
  debrief:
    "The recovery preset moves every reader to the fan-out path and stops writing the old key. Stale reads fall to zero, but the cost is visible: each read now touches eight variants, and total Redis work is higher than the logical request rate. The migration is only complete when the old key is no longer read, no longer written, and its TTL has expired.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Key salting replaces one hot logical key with a deterministic set of subkeys. Instead of `product:42`, the application writes variants such as `salt:0:product:42` through `salt:7:product:42`. The salt is derived from a request ID, a counter, a hash of the value, or another deterministic input, so every writer can choose a variant from the same set without coordination. Writes spread across the variants. Reads must query all of them and combine the result, or read the one variant that holds the authoritative value.",
  },
  {
    type: "p",
    text: "The salt must change the part of the key that Redis hashes. Redis Cluster computes the slot as CRC16(key) modulo 16,384, but if the key contains a hash tag, only the text inside the braces is hashed. `{user:42}:profile` and `{user:42}:profile:0` land in the same slot because both hash `user:42`. Appending a suffix outside the tag does not salt the key at all. To spread the variants, change the hashed portion, for example `{user:42:0}:profile`, or use a key without a tag. Changing the tag means every multi-key operation that relied on it must be revisited.",
  },
  {
    type: "p",
    text: "Salting is a partition of the logical key, not a free multiplier. Writes become cheaper per shard, but a read that needs every variant performs one operation per variant. If the key is read-heavy, total Redis work rises and the tail waits for the slowest variant. If the key is write-heavy, salting can remove the hot write shard while adding a smaller read fan-out. The workload decides whether that trade is worth it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Migration phase", "Writes", "Reads", "Main risk"],
    rows: [
      ["Before salting", "One hot key, one shard", "One key, one shard", "Shard saturation"],
      ["Writes salted, reads not", "Spread across variants", "Still the old key", "Stale or incomplete reads with healthy CPU"],
      ["Dual-write bridge", "Variants plus the old key", "Either path", "The old shard becomes the write hot spot again"],
      ["Full fan-out", "Spread across variants", "All variants, combined", "Higher total ops and a slower read tail"],
      ["Old key retired", "Variants only", "Variants only", "A missed reader with no fallback"],
    ],
  },
  {
    type: "p",
    text: "The request path gains a client-side fan-out step: the service computes the variant list, issues the reads, and combines the results. The variants are separate keys and usually separate slots, so a multi-key command across them is a cross-slot operation and is rejected by Redis Cluster. The client must issue individual commands, preferably in parallel, and define what happens when one variant is missing or slow. The old key can remain as a fallback until its time to live (TTL) expires.",
  },
  {
    type: "p",
    text: "This module models a write-heavy aggregate key with eight shards, a 90/10 write/read split, and an illustrative 32,000 ops/s per shard. The split and capacity are teaching values, not a workload guarantee. The mechanics are the lesson: salting changes the key scheme, writes fan out, reads fan out, and the old key must stay coherent until every reader has moved.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hottest shard CPU: the maximum across the old key's shard and the salted variants.",
      "Stale reads: the share of reads that still use the unsalted key after writes moved.",
      "Total Redis ops and ops per read: the fan-out cost that the logical request rate hides.",
      "Redis p99: the read tail when a fan-out waits for the slowest variant.",
      "Salt fan-out: the number of variants in the current key scheme.",
      "A per-shard heat map: which shards carry the old key, the variants, and the idle keyspace.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Salted writes only. Watch stale reads go to 100% while CPU stays low. Apply Recovery to move the readers; then apply Dual-write bridge to see the old shard become hot again. Run the guided experiment before the debrief.",
  },
  {
    type: "p",
    text: "The first question is not how many variants to use. It is which side of the key is hot and what the reader can tolerate. A write-heavy counter can benefit from a salt with a small read fan-out. A read-heavy cache value may do better with a local cache or replicas, because fanning out every read multiplies the work the cache exists to absorb. Pick the scheme whose read path you can operate.",
  },
  { type: "sim", simId: "key-salting" },
  { type: "experiment", experimentId: "predict-salting-break" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The write path moved to eight salted variants, but readers kept asking for the old key. The old key stopped receiving the writes that made it authoritative, so readers saw a frozen value with normal latency. CPU fell because the writes were spread, which made the incident look like a healthy cache from the load dashboard. The failure was coherence, not capacity.",
  },
  {
    type: "p",
    text: "Moving readers to the fan-out path fixed the stale reads. Each read now touched eight variants, so total Redis work rose even though the logical request rate did not. The dual-write bridge kept the old key fresh but sent the full write load back to its shard, recreating the hot spot. The safe sequence depends on which side is hot: move reads with writes, keep a bounded bridge, and retire the old key only after the readers are gone.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Application: a stale-read counter, a value-age histogram, and a per-variant error rate. These catch a coherence failure that CPU and p99 miss.",
      "Redis: per-shard `EngineCPUUtilization` and `GetTypeCmds`, plus `CLUSTER KEYSLOT` for a sampled key and `CLUSTER COUNTKEYSINSLOT` for the old and new slots.",
      "Errors: `CROSSSLOT` errors if a multi-key command spans variants, and `MOVED`/`ASK` traffic while slots move.",
      "Traces: the read span fans out into several Redis spans; the slowest child sets the logical read latency.",
      "Logs: the client version or key format still reading the old key after the write migration.",
      "Deploys: the rollout that changed the key scheme, and whether readers and writers moved in the same release.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the write path's key scheme with the read path's key scheme. If writes use variants and reads use the old key, stop and fix coherence before tuning CPU. Then check the fan-out count, the total Redis ops, and whether any variant is missing or slow.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the key scheme on both paths: writers, readers, and the cache keys they actually produce.",
      "Choose the migration order from the workload: move reads with writes for a read-hot key, or use a bounded dual-write bridge for a write-hot key.",
      "Backfill the variants before cutting reads over, and make the read path fall back to the old key or a recompute when a variant is missing.",
      "Bound the fan-out: parallel reads, a per-read deadline, and a defined partial-failure result.",
      "Verify read-your-writes with a version or a checksum before removing the old key.",
      "Retire the old key after its TTL, and remove the dual-write code so the old shard is not kept hot.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Salting spreads writes but multiplies read work. A read-heavy key can end up with more total load than it had before.",
      "Fan-out increases the tail because the logical read waits for the slowest variant; parallel fetches reduce but do not remove that.",
      "Dual-writing keeps old readers correct but recreates the old write hot spot for the duration of the bridge.",
      "Hash tags make multi-key operations possible and make salting harder; a tag change is a data-model migration.",
      "A partial migration is worse than either endpoint: writes and reads must agree on which key is authoritative.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-salting",
    question:
      "Design a salting scheme for a hot key. What has to change on the write path and the read path?",
    difficulty: 3,
    hints: [
      "The salt must change the hash slot.",
      "A read needs every variant, not just one.",
    ],
    answer:
      "I would define a deterministic variant set, for example eight keys derived from a stable hash of the logical key plus an index. Writers choose a variant by request ID, counter, or hash so the writes spread evenly. Readers must know the full variant list, fetch all of them, and combine the result. The salt has to change the hashed portion of the key; a suffix outside a hash tag does not move the slot. I would keep the old key as a fallback during migration, version the scheme, and bound the fan-out with a deadline.",
    followUps: [
      "How do you choose the fan-out count?",
      "What happens if one variant is missing?",
      "How would you salt a key that already uses a hash tag?",
    ],
    redFlags: [
      "Appends a suffix without checking the hash tag.",
      "Reads only one variant and calls it consistent.",
      "Has no fan-out failure path.",
    ],
    rubric: [
      "Deterministic variant mapping.",
      "Explains the read fan-out.",
      "Handles hash tags.",
      "Bounds the read path.",
    ],
  },
  {
    id: "hash-tag-trap",
    question:
      "Your key is `{user:42}:profile`. You append `:0` through `:7` and the shard load does not change. Why?",
    difficulty: 2,
    hints: [
      "Only the text inside the braces is hashed.",
      "The suffix is outside the tag.",
    ],
    answer:
      "Redis hashes only the substring between the braces when a key contains a hash tag. All eight keys still hash `user:42`, so they all map to the same slot and the same shard. To spread them, the salt must change the tagged portion, for example `{user:42:0}:profile`, or the key must stop using a tag. Changing the tag changes which keys can participate in multi-key operations, so the read and write paths need a migration plan.",
    followUps: [
      "What breaks when the tag changes?",
      "Can you keep the tag and still spread the key?",
      "How would you test the slot mapping before deploying?",
    ],
    redFlags: [
      "Assumes every suffix changes the slot.",
      "Ignores multi-key operations.",
      "Changes the tag without a migration.",
    ],
    rubric: [
      "Explains hash-tag hashing.",
      "Names the correct fix.",
      "Considers multi-key impact.",
      "Tests the mapping.",
    ],
  },
  {
    id: "fanout-cost",
    question:
      "A read fans out to eight variants. What does that do to total load, latency, and failure handling?",
    difficulty: 3,
    hints: [
      "Count one Redis operation per variant per read.",
      "The logical read waits for the slowest child.",
    ],
    answer:
      "Total Redis operations become the read rate times the fan-out, plus the write rate. If the variants sit on different shards, the per-shard read load can be roughly the original read rate, but the cluster does more total work. Latency is the maximum of the variant latencies plus the combine step, so the tail grows. Failure handling needs a policy for a missing or slow variant: return a partial result with a version, fall back to the old key, or recompute. The fan-out must have a deadline so one slow shard cannot hold the request.",
    followUps: [
      "How would you choose between sequential and parallel fetches?",
      "What is a safe partial-failure result?",
      "When is a local cache cheaper than fan-out?",
    ],
    redFlags: [
      "Counts only one Redis op per read.",
      "Ignores the tail.",
      "Has no partial-failure policy.",
    ],
    rubric: [
      "Multiplies read work.",
      "Explains tail amplification.",
      "Defines partial failure.",
      "Bounds the fan-out.",
    ],
  },
  {
    id: "dual-write-hot",
    question:
      "You need to keep old readers fresh while salting a write-hot key. How do you avoid making the old shard hot again?",
    difficulty: 4,
    hints: [
      "Dual-write sends the full write load to the old key.",
      "Shorten the bridge and move readers first, or use a shadow copy.",
    ],
    answer:
      "I would avoid an open-ended dual-write. If the key is write-hot, dual-writing the old key restores the original write load on its shard for the whole bridge. I would move readers to the salted path as quickly as possible, keep the dual-write window bounded, and use a shadow write or a backfill to populate the old key only for the readers that still need it. I would measure the old shard's write rate during the bridge and roll back if it crosses the capacity threshold. The old key is retired after the read coverage reaches 100% and its TTL expires.",
    followUps: [
      "How would you bound the bridge window?",
      "What if a reader cannot be upgraded?",
      "How would you roll back mid-migration?",
    ],
    redFlags: [
      "Leaves dual-write on indefinitely.",
      "Moves writes before any reader can use variants.",
      "Has no capacity check on the old shard.",
    ],
    rubric: [
      "Names the dual-write cost.",
      "Bounds the bridge.",
      "Moves readers deliberately.",
      "Defines rollback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The hot key's access pattern is known: read-heavy, write-heavy, or mixed.",
      "The salt scheme changes the hashed portion of the key and has a slot test.",
      "Every reader can fan out, combine variants, and handle a missing or slow variant.",
      "A migration order and a rollback key scheme are documented.",
      "The old key's TTL and dual-write window are bounded.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether writes and reads use the same key scheme before tuning capacity.",
      "Protect the read path with a per-read deadline and a partial-failure policy.",
      "Watch total Redis ops and the hottest variant, not only the logical request rate.",
      "If dual-writing, watch the old shard's write CPU and stop the bridge when readers have moved.",
      "Record the client versions and key formats in use.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify stale reads are zero and the old key is no longer written.",
      "Verify the fan-out p99 and the per-variant load distribution at peak.",
      "Retire the old key after its TTL and remove the dual-write code.",
      "Add a key-scheme check to the deploy pipeline.",
    ],
  },
];

const references = [
  {
    title: "Redis cluster specification",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Hash slots, hash tags, and cross-slot behavior.",
  },
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside patterns, key design, and migration guidance.",
  },
  {
    title: "Scale with Redis Cluster",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Hash tags, multi-key operations, and resharding.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "key-salting": {
      model: keySaltingModel,
      presets,
      instructions:
        "Start healthy, apply Salted writes only, then Recovery. Compare stale reads with CPU, then try Dual-write bridge to see the old shard become hot again.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "heatmap"],
      note: "Illustrative model. Eight shards, 32,000 ops/s per shard, and a 90/10 write/read split. Variant-to-shard placement is illustrative; production placement depends on the salt and the hash slot. Total Redis ops include 16,000 background ops/s.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-hot-key-sharding",
    "caching-hot-shard-cluster",
    "caching-cluster-resharding",
    "caching-local-cache",
  ],
};
