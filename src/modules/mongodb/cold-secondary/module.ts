import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOT_WORKING_SET_GB = 16;
const WARM_SECONDS = 45;
const BASE_P99_MS = 2;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "readRate",
    label: "Application read rate",
    min: 4_000,
    max: 40_000,
    step: 1_000,
    value: 12_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Reads arriving at the replica set before any routing decision. Illustrative, not a capacity limit.",
    format: "rps",
  },
  {
    id: "readOffload",
    label: "Reads routed to new secondary",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Routing",
    help: "Share of reads a secondary read preference sends to the newly added member. At 0 the member stays cold.",
    format: "percent",
  },
  {
    id: "cacheSizeGB",
    label: "WiredTiger cache",
    min: 2,
    max: 32,
    step: 1,
    value: 8,
    unit: " GB",
    group: "Storage",
    help: "Illustrative internal cache size. MongoDB's documented default is the larger of 50% of (RAM minus 1 GB) or 0.256 GB.",
    format: "number",
  },
  {
    id: "diskIops",
    label: "Storage read capacity",
    min: 2_000,
    max: 20_000,
    step: 500,
    value: 8_000,
    unit: " IOPS",
    group: "Storage",
    help: "Random read capacity available to the new member. Cache misses compete for it; the value is a teaching number, not a disk benchmark.",
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
  readRate: number;
  offload: number;
  cacheSizeGB: number;
  diskIops: number;
  warm: number;
  warmStartedAt: number;
  missShare: number;
  missOps: number;
  diskUtil: number;
  readP99: number;
  cacheHitRate: number;
  primaryCpu: number;
  newHealth: Health;
}

function compute(p: Params, t: number, warmStartedAt = -1): Computed {
  const readRate = clamp(num(p, "readRate", 12_000), 0, 40_000);
  const offload = clamp(num(p, "readOffload", 0), 0, 100) / 100;
  const cacheSizeGB = clamp(num(p, "cacheSizeGB", 8), 2, 32);
  const diskIops = clamp(num(p, "diskIops", 8_000), 2_000, 20_000);
  const coverage = clamp(cacheSizeGB / HOT_WORKING_SET_GB);
  const warm =
    offload > 0 && warmStartedAt >= 0 ? clamp((t - warmStartedAt) / WARM_SECONDS) : 0;
  const missShare = 1 - 0.85 * coverage * warm;
  const routedReads = readRate * offload;
  const missOps = routedReads * missShare;
  const diskUtil = clamp(missOps / diskIops, 0, 1.4);
  const queueUtil = Math.min(0.98, diskUtil);
  const readP99 =
    offload <= 0 ? BASE_P99_MS : Math.min(MAX_P99_MS, BASE_P99_MS + (90 * diskUtil) / (1 - queueUtil) + 1.2 * missShare);
  const cacheHitRate = (1 - missShare) * 100;
  const primaryCpu = clamp(readRate / 60_000) * 100;
  const newHealth: Health =
    readP99 >= 120 || diskUtil >= 0.9 ? "crit" : readP99 >= 50 || diskUtil >= 0.7 ? "warn" : "ok";
  return {
    readRate,
    offload,
    cacheSizeGB,
    diskIops,
    warm,
    warmStartedAt,
    missShare,
    missOps,
    diskUtil,
    readP99,
    cacheHitRate,
    primaryCpu,
    newHealth,
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const routedReads = values.readRate * values.offload;
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Application",
      kind: "client",
      health: values.newHealth === "crit" ? "crit" : values.newHealth === "warn" ? "warn" : "ok",
      sublabel: `${Math.round(values.offload * 100)}% reads to the new member`,
      detail: "The application chooses a read preference. A cold secondary is eligible to receive reads as soon as it reaches SECONDARY, before its cache holds the working set.",
      meta: { view: "replication" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: "ok",
      utilization: clamp(values.primaryCpu / 100),
      throughput: values.readRate * (1 - values.offload) + values.readRate * 0.2,
      sublabel: `${values.primaryCpu.toFixed(0)}% CPU · warm cache`,
      detail: "The primary has been serving traffic, so its WiredTiger cache holds a working set. Lower CPU does not mean the new secondary will serve a read as quickly.",
      meta: { view: "replication", lag: 0 },
    },
    {
      id: "replica-warm",
      label: "Existing secondary",
      kind: "db",
      role: "replica",
      health: "ok",
      utilization: clamp(values.readRate / 80_000),
      throughput: values.readRate * 0.2,
      sublabel: "warm cache",
      detail: "An existing secondary has been applying the oplog and serving its share of reads. Its cache is populated by that history.",
      meta: { view: "replication", lag: 0.1 },
    },
    {
      id: "replica-new",
      label: "New secondary",
      kind: "db",
      role: "replica",
      health: values.newHealth,
      utilization: clamp(values.diskUtil),
      throughput: routedReads,
      sublabel: `p99 ${values.readP99.toFixed(0)}ms · disk ${(values.diskUtil * 100).toFixed(0)}%`,
      detail: `The new member completed initial sync and is serving ${Math.round(routedReads).toLocaleString()} reads/s with a cold cache. About ${(values.missShare * 100).toFixed(0)}% of its reads miss the internal cache and read from storage.`,
      meta: { view: "replication", lag: 0.1 },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-primary", "client", "primary", (1 - values.offload) * 0.8, "ok"),
      edge("client-new", "client", "replica-new", values.offload, values.newHealth),
      edge("primary-warm", "primary", "replica-warm", 0.2, "ok"),
    ],
    metrics: [
      metric("read-p99", "New secondary read p99", values.readP99, "ms", 50, 120, "ms"),
      metric("disk-io-util", "New secondary disk I/O", values.diskUtil * 100, "%", 70, 90, "percent"),
      metric("cache-hit-rate", "New secondary cache hit rate", values.cacheHitRate, "%", undefined, undefined, "percent"),
      metric("missed-reads", "Cache-miss reads", values.missOps, " ops/s", 5_000, 10_000, "rps"),
      metric("primary-cpu", "Primary CPU", values.primaryCpu, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, offload: values.offload, warm: values.warm, warmStartedAt: values.warmStartedAt },
    summary:
      values.offload <= 0
        ? "No reads routed to the new secondary; its cache stays cold."
        : `New secondary p99 ${values.readP99.toFixed(0)}ms at ${(values.diskUtil * 100).toFixed(0)}% disk I/O; cache hit ${values.cacheHitRate.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 7)) / 2.3);
  const rows: [string, number][] = [
    ["read-p99", values.readP99],
    ["disk-io-util", values.diskUtil * 100],
    ["cache-hit-rate", values.cacheHitRate],
    ["missed-reads", values.missOps],
    ["primary-cpu", values.primaryCpu],
  ];
  for (const [id, value] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 50,
    crit: 120,
    title: "Reads on the new secondary exceed the latency budget",
    cause:
      "The new member is serving reads before its WiredTiger cache holds the working set. Each miss reads from storage, and concurrent misses queue behind limited random-read capacity. CPU can stay low because the member is waiting on I/O.",
    fix:
      "Stop routing production reads to the member, let it warm through replication and a measured canary, or add read capacity. If reads must start immediately, warm the working set and raise the cache only within memory limits; a larger cache does not fix a storage device that is already saturated.",
    checkFirst: [
      "Compare per-member read p99 with CPU: low CPU and high p99 points at storage waits.",
      "Check cache hit rate, disk read latency, and the disk device's queue depth on the new member.",
      "Check replication lag separately; a cold cache and a lagging member are different failures.",
    ],
  },
  {
    id: "disk-io-util",
    metricId: "disk-io-util",
    warn: 70,
    crit: 90,
    title: "Cold reads saturate the new member's storage",
    cause:
      "Cache misses turn read traffic into random storage reads. The device approaches saturation, so latency rises faster than the read rate. The rest of the replica set can be healthy while one member's disk is the bottleneck.",
    fix:
      "Move reads back to warm members until the cache fills, or reduce the read share. Check whether the storage volume is undersized for the working set. Adding replicas does not add cache to the member that is already cold.",
    checkFirst: [
      "Check `iostat` or the cloud volume's read IOPS and queue metrics on that member.",
      "Check `wiredTiger.cache` hit ratio and bytes read into cache.",
      "Check whether backups, initial sync, or a second `mongod` share the same device.",
    ],
  },
  {
    id: "missed-reads",
    metricId: "missed-reads",
    warn: 5_000,
    crit: 10_000,
    title: "The cache is not covering the read working set",
    cause:
      "The routed read rate and the miss share together produce more storage reads than the member can serve at low latency. A small cache, a large working set, or reads that touch new documents all keep the miss rate high.",
    fix:
      "Route a smaller share, warm the member with the queries it will serve, or increase cache capacity only after checking memory headroom. Do not treat initial sync as cache warmup: sync copies data, but it does not prove the read working set is resident.",
    checkFirst: [
      "Check the cache size against the hot working set, not the total data size.",
      "Check whether the read pattern is random or sequential.",
      "Check whether the member just restarted, which empties the cache.",
    ],
  },
];

export const coldSecondaryModel: SimModel = {
  id: "mongodb-cold-secondary",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const offload = clamp(num(p, "readOffload", 0), 0, 100);
    const previousOffload = num(frame.flags, "offload", 0);
    let warmStartedAt = Number(frame.flags.warmStartedAt ?? -1);
    if (offload > 0 && previousOffload <= 0) warmStartedAt = frame.t;
    if (offload <= 0) warmStartedAt = -1;
    const values = compute(p, frame.t, warmStartedAt);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "read-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.offload > 0 && !Number(next.flags.coldAnnounced ?? 0) && values.readP99 >= 50) {
      pushEvent(next, {
        id: "cold-cache-reads",
        at: frame.t,
        severity: values.readP99 >= 120 ? "crit" : "warn",
        title: "Reads are hitting a cold cache",
        detail: `${Math.round(values.readRate * values.offload).toLocaleString()} reads/s are routed to the new member while ${(values.missShare * 100).toFixed(0)}% miss the cache. Disk I/O is ${(values.diskUtil * 100).toFixed(0)}%.`,
        nodeId: "replica-new",
        metricId: "read-p99",
      });
      next.flags.coldAnnounced = 1;
    }
    if (values.offload <= 0 || values.readP99 < 50) next.flags.coldAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t, Number(frame.flags.warmStartedAt ?? -1));
    return [
      `The new member is modeled with a ${values.cacheSizeGB.toFixed(0)} GB cache against a ${HOT_WORKING_SET_GB} GB hot working set; coverage is ${(clamp(values.cacheSizeGB / HOT_WORKING_SET_GB) * 100).toFixed(0)}%.`,
      `At this instant ${(values.missShare * 100).toFixed(0)}% of routed reads miss, producing ${Math.round(values.missOps).toLocaleString()} storage reads/s against ${Math.round(values.diskIops).toLocaleString()} IOPS.`,
      "Replication lag measures freshness. A cold cache measures where reads are served from. A member can be fully caught up and still be the slowest place to read.",
      "Illustrative values only: the cache/warmup curve is a teaching model, not a WiredTiger benchmark. MongoDB documents the cache default, not a warmup duration.",
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
    description: "Reads stay on warm members while the new secondary catches up.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A small read share reaches the new member during a busy period.",
    tone: "warn",
    params: defaults({ readRate: 20_000, readOffload: 15, cacheSizeGB: 8, diskIops: 12_000 }),
  },
  {
    id: "failure",
    label: "Cold reads",
    description: "Sixty percent of reads go to a new member with a small, cold cache.",
    tone: "crit",
    params: defaults({ readRate: 30_000, readOffload: 60, cacheSizeGB: 4, diskIops: 6_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Reads return to warm members while the new member warms.",
    tone: "ok",
    params: defaults({ readRate: 10_000, readOffload: 0, cacheSizeGB: 8, diskIops: 12_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-cold-read",
  title: "Predict what a cold secondary does with production reads",
  simId: "cold-secondary",
  question:
    "A new secondary finishes initial sync. Its CPU is at 12%, and 60% of reads are routed to it. What happens to read latency?",
  prediction: {
    options: [
      { id: "fine", label: "Latency stays low because CPU has plenty of headroom" },
      { id: "disk", label: "Latency rises because cache misses turn reads into storage I/O" },
      { id: "lag", label: "Latency rises only because the member is behind on the oplog" },
      { id: "writes", label: "Only writes slow down; the member is read-only until it is warm" },
    ],
    correctOptionId: "disk",
    explanation:
      "A newly started member has an empty WiredTiger cache. Reads that miss must come from storage, and concurrent misses queue on the device. CPU can stay near idle while p99 rises because the member is waiting on I/O. Replication lag is a separate freshness signal.",
  },
  setup: defaults({ readRate: 30_000, readOffload: 60, cacheSizeGB: 4, diskIops: 6_000 }),
  runFor: 30,
  observe: [
    "The new member's CPU does not track its read p99.",
    "Cache hit rate starts near zero and improves slowly as reads populate the cache.",
    "Disk I/O and cache-miss reads rise together.",
    "The primary and the existing secondary stay healthy, so a cluster-wide CPU chart looks calm.",
  ],
  explain:
    "Initial sync copies the data set, but it does not preload the cache with the pages that production reads will touch. The first reads after the member becomes eligible are storage reads. With a working set larger than the cache, a meaningful share stays on disk even after warmup. Read preference decides whether that cost reaches users.",
  fix: defaults({ readRate: 10_000, readOffload: 0, cacheSizeGB: 8, diskIops: 12_000 }),
  debrief:
    "Warm a new member before giving it production share: replicate, let it serve a small canary, watch cache hit rate and disk latency, then increase gradually. Confirm the member is caught up, but do not use lag as evidence that the cache is warm. If the working set cannot fit, plan for steady-state disk reads rather than assuming warmup fixes everything.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "WiredTiger is MongoDB's default storage engine. It keeps recently used data and indexes in an internal cache, and reads that miss that cache go to the filesystem or storage device. A newly started `mongod` begins with an empty cache. It can finish initial sync, become a secondary, and accept reads while most of its cache is still cold.",
  },
  {
    type: "p",
    text: "That produces a confusing shape: the new member reports low CPU and healthy replication, yet reads served from it are slow. The member is not short of compute. It is waiting on storage for pages it has not seen yet, and those misses queue when the device approaches its random-read limit.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, driver, selected member, WiredTiger cache, then storage. A secondary read preference can select any eligible secondary, including one that was added minutes ago. Mongos is not involved in an unsharded replica set; the driver chooses the member from topology metadata.",
  },
  {
    type: "table",
    headers: ["Signal", "Cold secondary", "Warm secondary"],
    rows: [
      ["CPU", "Can be low while reads wait on I/O", "Tracks the read load it serves"],
      ["Read p99", "High and storage-bound", "Closer to memory latency"],
      ["Disk read I/O", "High, driven by cache misses", "Low for a stable working set"],
      ["Cache hit rate", "Starts near zero", "Reflects the resident working set"],
      ["Replication lag", "Independent of cache temperature", "Independent of cache temperature"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "Cache size is not cache warmth",
    body: "MongoDB documents the default internal cache size as the larger of 50% of (RAM minus 1 GB) or 0.256 GB. A larger cache can hold more of the working set, but it does not arrive populated. The model here uses an illustrative 16 GB hot working set and a 45-second warmup curve, not documented MongoDB limits.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "New secondary read p99: latency for reads routed to the cold member.",
      "Disk I/O: utilization of the member's random-read capacity.",
      "Cache hit rate: how much of the routed read stream is served from memory.",
      "Cache-miss reads: the absolute storage read rate the device must absorb.",
      "Primary CPU: the warm path's load, included so a cluster average cannot hide the cold member.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy: no reads reach the new member, so its cache stays cold but users do not see it. Apply Cold reads and watch p99 and disk I/O rise while CPU stays modest. Then set reads to zero to separate cache temperature from replication health. Use the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "cold-secondary" },
  { type: "experiment", experimentId: "predict-cold-read" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Routing reads to the new member turned cache misses into storage reads. The member was caught up on replication, but its WiredTiger cache did not hold the pages the reads needed. Disk I/O rose, reads queued, and p99 crossed the budget while CPU stayed low. Removing the read share removed the symptom without changing replication.",
  },
  {
    type: "p",
    text: "Warmup reduced the miss share over time, but the member remained the slowest read path while the working set exceeded the cache. The primary and existing secondary were healthy throughout, so any dashboard that averaged CPU or latency across members understated the user-visible tail.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-member read latency is much higher on the new member than on its peers.",
      "CPU on the new member is flat or low while disk read latency and queue depth rise.",
      "`wiredTiger.cache` metrics show a low hit ratio and a high number of pages read into cache.",
      "Replication lag can be near zero; do not use it to explain the latency.",
      "The cluster-wide average p99 may move only slightly because the cold member serves a minority of reads.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check read p99 per member before checking the cluster average. Compare that member's CPU with disk read latency and cache hit rate. If CPU is low and disk waits are high, the member is cold, not compute-bound. Then check replication lag as a separate signal and confirm the read preference that put traffic there.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop or reduce production reads to the new member.",
      "Verify it is caught up and stable, then warm it with the queries it will actually serve.",
      "Watch cache hit rate and disk read latency while increasing a small canary share.",
      "Check memory headroom before changing the cache size; a larger cache is not a free fix.",
      "Increase the read share only when p99 and disk I/O stay inside budget.",
      "Record the warmup duration so the next member addition is planned, not discovered.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Keeping reads off a new member protects latency but delays the capacity it was added to provide.",
      "A larger cache can cover more of the working set but competes with other processes for memory.",
      "Warming with production queries is realistic but risky; a canary share bounds the blast radius.",
      "Averaging latency across members hides the cold tail; per-member charts are noisier but honest.",
      "If the working set cannot fit in cache, steady-state disk reads are part of the design, not a warmup bug.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "low-cpu-slow-reads",
    question: "A secondary shows 10% CPU and 400 ms read p99. How do you investigate?",
    difficulty: 3,
    hints: [
      "Separate waiting from working.",
      "The member may be reading from storage.",
      "Check cache metrics, not only CPU.",
    ],
    answer:
      "I would compare per-member read p99 with CPU, disk read latency, queue depth, and WiredTiger cache hit rate. Low CPU with high p99 and high disk reads points to cache misses waiting on storage. I would also check whether the member just started or restarted, whether its working set fits the cache, and whether another process shares the volume. Replication lag is a separate check; a caught-up member can still have a cold cache. The fix is to reduce reads to that member until it warms, not to add CPU.",
    followUps: [
      "What would change if CPU were at 95%?",
      "How does initial sync affect cache warmth?",
      "Why might the cluster average look healthy?",
    ],
    redFlags: [
      "Assumes low CPU means the member is healthy.",
      "Confuses replication lag with read latency.",
      "Adds replicas without checking the cold member's storage.",
    ],
    rubric: [
      "Checks per-member latency and disk metrics.",
      "Names cache warmth as the mechanism.",
      "Separates lag from cache temperature.",
      "Reduces or stages read traffic.",
    ],
  },
  {
    id: "warmup-sequence",
    question: "How would you add a secondary and route reads to it safely?",
    difficulty: 3,
    hints: [
      "Becoming eligible is not the same as being warm.",
      "Use a bounded share.",
      "Have a rollback condition.",
    ],
    answer:
      "I would let initial sync finish, confirm the member is stable and caught up, then send a small canary share of the reads it will serve. I would watch cache hit rate, disk read latency, p99, and replication lag. If p99 stays inside budget, I would increase the share gradually. If it breaches, I would return reads to warm members and investigate capacity or working-set size. I would not make the new member eligible for a large read share on the same day it finishes sync.",
    followUps: [
      "What canary share would you start with, and why?",
      "Which signal tells you the cache is warm enough?",
      "What if the workload is read-only and never warms through writes?",
    ],
    redFlags: [
      "Routes full read share immediately after sync.",
      "Uses replication lag as the only readiness gate.",
      "Has no rollback path.",
    ],
    rubric: [
      "Waits for sync and stability.",
      "Uses a staged read share.",
      "Names cache and disk signals.",
      "Defines a rollback condition.",
    ],
  },
  {
    id: "cache-sizing",
    question: "The new member's cache is 8 GB and the hot working set is 16 GB. What do you expect after warmup?",
    difficulty: 2,
    hints: [
      "Warm does not mean fully resident.",
      "Think steady state, not startup.",
      "Memory has a cost.",
    ],
    answer:
      "Even after warmup, only part of the working set can be resident. The member will keep serving a meaningful share of reads from storage, so its steady-state p99 depends on disk capacity, not only on time. I would either accept that with a lower read share, resize the cache within memory limits, or reduce the working set through query and index changes. Adding memory may help, but it does not guarantee the entire working set fits.",
    followUps: [
      "How would you measure the steady-state miss rate?",
      "When is a larger cache the wrong fix?",
      "How do indexes change the working set?",
    ],
    redFlags: [
      "Assumes warmup makes all reads memory-resident.",
      "Raises cache without checking memory headroom.",
      "Ignores index and query shape.",
    ],
    rubric: [
      "Explains partial residency.",
      "Predicts steady-state disk reads.",
      "Weighs cache size against memory cost.",
      "Mentions query or index changes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the change",
    items: [
      "Know which read preferences can select a newly added member.",
      "Record the hot working set and the member's cache size.",
      "Set a canary read share and a p99 rollback threshold.",
      "Check that monitoring is per member, not only cluster-wide.",
    ],
  },
  {
    title: "During warmup",
    items: [
      "Watch cache hit rate, disk read latency, and p99 on the new member.",
      "Keep replication lag and cache temperature as separate signals.",
      "Do not raise the read share while p99 or disk I/O is climbing.",
      "Check for competing workloads on the same storage device.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Confirm steady-state p99 and miss rate at the final read share.",
      "Document the warmup duration for the next member addition.",
      "Review whether the working set fits the cache or needs query changes.",
      "Verify the rollback path still works.",
    ],
  },
];

const references = [
  {
    title: "WiredTiger Storage Engine",
    url: "https://www.mongodb.com/docs/manual/core/wiredtiger/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Internal cache, memory use, and the documented default cache size.",
  },
  {
    title: "Replication",
    url: "https://www.mongodb.com/docs/manual/replication/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Secondary members, asynchronous replication, and read scaling.",
  },
  {
    title: "Replica Set Members",
    url: "https://www.mongodb.com/docs/manual/core/replica-set-members/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Member roles, secondaries, and priorities.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cold-secondary": {
      model: coldSecondaryModel,
      presets,
      instructions:
        "Start Healthy, then apply Cold reads. Compare CPU with read p99 and disk I/O, then set reads to zero. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Cache coverage, warmup duration, and IOPS are teaching values; MongoDB documents the cache-size default, not a warmup duration or a throughput guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-adding-readers", "mongodb-read-preference", "mongodb-replication-lag"],
};
