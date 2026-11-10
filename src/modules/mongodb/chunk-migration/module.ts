import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 4;
const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "migrationRate",
    label: "Migration rate",
    min: 0,
    max: 12,
    step: 1,
    value: 2,
    unit: " chunks/min",
    group: "Balancer",
    help: "Chunks the balancer attempts per minute. A real cluster limits each shard to one migration at a time; this model uses a teaching rate.",
    format: "count",
  },
  {
    id: "chunkSizeMB",
    label: "Chunk size",
    min: 32,
    max: 256,
    step: 16,
    value: 128,
    unit: " MB",
    group: "Balancer",
    help: "Data copied per migrated chunk. MongoDB's documented default chunk size is 128 MB; larger chunks move more data per operation.",
    format: "number",
  },
  {
    id: "writeRate",
    label: "Application write rate",
    min: 2_000,
    max: 30_000,
    step: 1_000,
    value: 12_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Writes competing with migration for the same storage and network. Illustrative, not a cluster capacity limit.",
    format: "rps",
  },
  {
    id: "ioCapacity",
    label: "Shared I/O capacity",
    min: 100,
    max: 1_000,
    step: 25,
    value: 500,
    unit: " MB/s",
    group: "Storage",
    help: "Illustrative read-plus-write capacity available to application and migration traffic on the affected shards.",
    format: "number",
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
  migrationRate: number;
  chunkSizeMB: number;
  writeRate: number;
  ioCapacity: number;
  migrationMBps: number;
  migrationIoMBps: number;
  appMBps: number;
  ioUtil: number;
  queryP99: number;
  donorHealth: Health;
  recipientHealth: Health;
}

function compute(p: Params): Computed {
  const migrationRate = clamp(num(p, "migrationRate", 2), 0, 12);
  const chunkSizeMB = clamp(num(p, "chunkSizeMB", 128), 32, 256);
  const writeRate = clamp(num(p, "writeRate", 12_000), 0, 30_000);
  const ioCapacity = clamp(num(p, "ioCapacity", 500), 100, 1_000);
  const migrationMBps = (migrationRate / 60) * chunkSizeMB;
  const migrationIoMBps = migrationMBps * 2;
  const appMBps = writeRate * 0.0015;
  const ioUtil = (migrationIoMBps + appMBps) / ioCapacity;
  const queue = Math.min(0.97, ioUtil);
  const queryP99 = Math.min(
    MAX_P99_MS,
    4 + (90 * queue) / (1 - queue) + (migrationIoMBps / ioCapacity) * 120,
  );
  const affectedHealth: Health = queryP99 >= 150 || ioUtil >= 0.9 ? "crit" : queryP99 >= 50 || ioUtil >= 0.7 ? "warn" : "ok";
  return {
    migrationRate,
    chunkSizeMB,
    writeRate,
    ioCapacity,
    migrationMBps,
    migrationIoMBps,
    appMBps,
    ioUtil,
    queryP99,
    donorHealth: migrationRate > 0 ? affectedHealth : "ok",
    recipientHealth: migrationRate > 0 ? affectedHealth : "ok",
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const nodes: SimNode[] = Array.from({ length: SHARD_COUNT }, (_, index) => {
    const donor = index === 0 && values.migrationRate > 0;
    const recipient = index === 1 && values.migrationRate > 0;
    const affected = donor || recipient;
    const ioUtil = affected ? values.ioUtil : values.appMBps / values.ioCapacity;
    const health: Health = affected ? (donor ? values.donorHealth : values.recipientHealth) : "ok";
    const appCpu = ((values.writeRate / SHARD_COUNT) / 12_000) * 35;
    const migrationCpu = affected ? (values.migrationMBps / values.ioCapacity) * 45 : 0;
    const cpu = Math.min(100, appCpu + migrationCpu);
    return {
      id: `shard-${index}`,
      label: `Shard ${index}`,
      kind: "db" as const,
      role: "shard" as const,
      health,
      utilization: clamp(ioUtil),
      throughput: values.writeRate / SHARD_COUNT,
      sublabel: donor
        ? `donor · ${values.migrationMBps.toFixed(0)} MB/s`
        : recipient
          ? `recipient · ${values.migrationMBps.toFixed(0)} MB/s`
          : `${(values.writeRate / SHARD_COUNT).toFixed(0)} ops/s`,
      detail: donor
        ? "The source shard sends documents to the destination while still accepting writes for the range. It competes with migration for disk and network."
        : recipient
          ? "The destination receives documents and applies the catch-up changes before the metadata switch. Its disk writes compete with normal traffic."
          : "A shard not participating in this migration. A real cluster limits each shard to one migration at a time.",
      meta: {
        view: "shards",
        cpu,
        memory: 8 + values.writeRate / 6_000,
        p99: affected ? values.queryP99 : 9,
        io: ioUtil * 100,
        hot: 0,
      },
    };
  });

  return {
    t: 0,
    nodes,
    edges: [],
    metrics: [
      metric("query-p99", "Application p99", values.queryP99, "ms", 50, 150, "ms"),
      metric("io-util", "Shared I/O utilization", values.ioUtil * 100, "%", 70, 90, "percent"),
      metric("migration-mbps", "Migration throughput", values.migrationMBps, " MB/s", 25, 45, "number"),
      metric("migration-rate", "Migration rate", values.migrationRate, " chunks/min", undefined, undefined, "count"),
      metric("app-write-rate", "Application writes", values.writeRate, " ops/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, migrationRate: values.migrationRate },
    summary: `${values.migrationRate.toFixed(0)} chunks/min · ${values.migrationMBps.toFixed(0)} MB/s copied · shared I/O ${(values.ioUtil * 100).toFixed(0)}% · p99 ${values.queryP99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.04 * Math.sin((index + (seed % 8)) / 2.5);
  const rows: [string, number][] = [
    ["query-p99", values.queryP99],
    ["io-util", values.ioUtil * 100],
    ["migration-mbps", values.migrationMBps],
    ["migration-rate", values.migrationRate],
    ["app-write-rate", values.writeRate],
  ];
  for (const [id, value] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.nodes.forEach((node) => {
    const util = Number(node.meta?.cpu ?? 0);
    frame.series[`cpu.${node.id}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, util * jitter(index)),
    );
  });
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-p99",
    metricId: "query-p99",
    warn: 50,
    crit: 150,
    title: "Migration traffic is inflating application latency",
    cause:
      "Chunk migration copies documents from the donor to the recipient and then catches up on changes. That read and write traffic shares disk and network with application requests, so queueing and p99 rise even when CPU is not saturated.",
    fix:
      "Reduce the migration rate, move migrations into a lower-traffic window, or add I/O capacity. Do not disable the balancer permanently; uneven data volume returns. Check whether the affected shard is also serving a hot key, which needs a different fix.",
    checkFirst: [
      "Check whether p99 rose on the donor and recipient, not every shard.",
      "Check migration activity and chunk size for the same window.",
      "Check disk read and write latency, queue depth, and network throughput.",
    ],
  },
  {
    id: "io-util",
    metricId: "io-util",
    warn: 70,
    crit: 90,
    title: "Shared storage is saturated by migration",
    cause:
      "Each migrated chunk is read from the donor and written to the recipient. At a high migration rate or large chunk size, that doubles into enough I/O to crowd out application reads and writes.",
    fix:
      "Lower the migration rate or chunk size, schedule the migration, or give the shards more IOPS and network headroom. Throttling slows convergence but protects the application.",
    checkFirst: [
      "Check per-device I/O utilization and latency on donor and recipient.",
      "Compare migration bytes per second with application bytes per second.",
      "Check whether other migrations are running on the same shard.",
    ],
  },
  {
    id: "migration-mbps",
    metricId: "migration-mbps",
    warn: 30,
    crit: 60,
    title: "The migration is moving a large amount of data",
    cause:
      "Migration throughput is the product of chunk rate and chunk size. A moderate chunk rate with large chunks can consume more bandwidth than a high rate with small chunks.",
    fix:
      "Reduce chunk size or rate, or schedule the move. A smaller chunk size means more metadata operations but less data per migration; a larger chunk moves faster in bulk but creates a bigger burst.",
    checkFirst: [
      "Check chunk size, not only chunks per minute.",
      "Check the number of chunks waiting to move.",
      "Check whether the migration is a one-time rebalance or ongoing.",
    ],
  },
];

export const chunkMigrationModel: SimModel = {
  id: "mongodb-chunk-migration",
  visual: "shards",
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
    const jitter = rng.between(-0.6, 0.6);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes) {
      recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? 0));
    }
    if (values.migrationRate > 0 && !Number(next.flags.migrationAnnounced ?? 0)) {
      pushEvent(next, {
        id: "migration-started",
        at: frame.t,
        severity: values.queryP99 >= 150 ? "crit" : values.queryP99 >= 50 ? "warn" : "info",
        title: "Chunk migration is competing with application traffic",
        detail: `${values.migrationRate.toFixed(0)} chunks/min at ${values.chunkSizeMB.toFixed(0)} MB per chunk moves ${values.migrationMBps.toFixed(0)} MB/s. Shared I/O is ${(values.ioUtil * 100).toFixed(0)}%.`,
        nodeId: "shard-0",
        metricId: "query-p99",
      });
      next.flags.migrationAnnounced = 1;
    }
    if (values.migrationRate <= 0) next.flags.migrationAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `Moving ${values.migrationRate.toFixed(0)} chunks/min at ${values.chunkSizeMB.toFixed(0)} MB each copies ${values.migrationMBps.toFixed(0)} MB/s. The donor reads it and the recipient writes it, so the modeled I/O is ${values.migrationIoMBps.toFixed(0)} MB/s before application traffic.`,
      `Application writes add about ${values.appMBps.toFixed(0)} MB/s, bringing shared I/O to ${(values.ioUtil * 100).toFixed(0)}% of ${values.ioCapacity.toFixed(0)} MB/s. Queueing turns that utilization into the p99 tail.`,
      "The metadata switch is short; the copy and catch-up phases are what compete with traffic. A migration is not free just because the final range move is brief.",
      "Illustrative model. Chunk size, migration rate, write amplification, and I/O capacity are teaching values; MongoDB documents the migration procedure, not these numbers.",
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
    description: "A slow background migration with ample I/O headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A larger chunk and higher application write rate with less headroom.",
    tone: "warn",
    params: defaults({ migrationRate: 6, chunkSizeMB: 192, writeRate: 20_000, ioCapacity: 400 }),
  },
  {
    id: "failure",
    label: "Migration burst",
    description: "Large chunks and a high migration rate share a constrained device with production writes.",
    tone: "crit",
    params: defaults({ migrationRate: 12, chunkSizeMB: 256, writeRate: 25_000, ioCapacity: 150 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The migration stops and application I/O returns to normal.",
    tone: "ok",
    params: defaults({ migrationRate: 0, chunkSizeMB: 128, writeRate: 12_000, ioCapacity: 500 }),
  },
];

const experiment: Experiment = {
  id: "predict-migration",
  title: "Predict why migration raises p99",
  simId: "chunk-migration",
  question:
    "The balancer starts moving 128 MB chunks. CPU stays at 40%, but application p99 triples. What is the most likely cause?",
  prediction: {
    options: [
      { id: "cpu", label: "The CPUs are saturated by the metadata update" },
      { id: "io", label: "Migration reads and writes compete for disk and network I/O" },
      { id: "config", label: "The config servers are serving every query during the move" },
      { id: "key", label: "The shard key changed during migration" },
    ],
    correctOptionId: "io",
    explanation:
      "Migration copies documents from donor to recipient and catches up on writes. The donor reads the data, the recipient writes it, and both share storage and network with application traffic. CPU can stay moderate while I/O queueing drives p99 up.",
  },
  setup: defaults({ migrationRate: 12, chunkSizeMB: 256, writeRate: 25_000, ioCapacity: 150 }),
  runFor: 20,
  observe: [
    "Shared I/O utilization approaches saturation while CPU is not the limiting signal.",
    "p99 rises on the donor and recipient, not on every shard equally.",
    "Migration throughput is the product of chunk rate and chunk size.",
    "Stopping the migration returns application latency without changing the data set.",
  ],
  explain:
    "A chunk migration is a data copy with a catch-up phase and a short metadata switch. The copy is the expensive part: the donor reads documents, the recipient writes them, and both must also serve the application. When migration and application traffic share the same IOPS and network, queueing raises the tail. Throttling reduces the burst but extends the migration window, which is the tradeoff.",
  fix: defaults({ migrationRate: 0, chunkSizeMB: 128, writeRate: 12_000, ioCapacity: 500 }),
  debrief:
    "Check migration activity and per-device I/O before blaming the balancer's logic. Lower the migration rate, use smaller chunks if the burst is the problem, and schedule the window. Verify that p99 fell because I/O pressure fell, not because application traffic dropped. Leaving the balancer off forever trades a temporary latency spike for permanent data imbalance.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A chunk migration moves a range of documents from a donor shard to a recipient shard. The donor keeps serving writes for the range during the copy. The recipient requests documents, builds indexes it needs, and then catches up on changes that happened during the copy. When it is synchronized, the donor updates the cluster metadata with the new location, and later deletes its copy.",
  },
  {
    type: "p",
    text: "The expensive part is not the metadata switch. It is copying the data and then catching up while both shards continue to serve application traffic. Migration consumes disk reads on the donor, disk writes on the recipient, network bandwidth between them, and cache capacity on both. Those resources are shared with users.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The balancer runs on the config server primary. It compares data volume per shard and starts migrations when the difference crosses its threshold. Each shard can participate in one migration at a time, which bounds concurrency but does not bound the bandwidth of a single large chunk. `_secondaryThrottle` controls how migration waits for write concern on moved documents; it is not a general rate limiter for application traffic.",
  },
  {
    type: "table",
    headers: ["Phase", "What moves", "What competes with traffic"],
    rows: [
      ["Copy", "Documents from donor to recipient", "Donor reads, recipient writes, network"],
      ["Catch-up", "Changes made during the copy", "Both shards' write path and oplog"],
      ["Metadata update", "Range location in the config database", "Brief CRUD pause for the range"],
      ["Deletion", "Donor's old copy", "Background range deletion and cache pressure"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "Migration is not a free rebalance",
    body: "The balancer improves distribution over time, but each move has a cost. MongoDB documents a default chunk size of 128 MB and one migration per shard at a time; this model's migration rate, write amplification, and I/O capacity are illustrative teaching values.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Application p99: the tail as migration and user traffic share I/O.",
      "Shared I/O utilization: reads plus writes on the affected shards.",
      "Migration throughput: chunk rate multiplied by chunk size.",
      "Migration rate: the control that trades convergence time for load.",
      "Application write rate: the background demand that sets the remaining headroom.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Migration burst. Watch I/O and p99 rise on the donor and recipient while the other shards stay calm. Stop the migration to confirm the cause, then restart it at a lower rate. Use the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "chunk-migration" },
  { type: "experiment", experimentId: "predict-migration" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The balancer copied large chunks at a high rate. The donor read documents and the recipient wrote them while both continued to serve application traffic. Shared I/O utilization crossed the point where queueing became nonlinear, so p99 rose even though CPU was not the limiting resource. Stopping or slowing the migration removed the pressure.",
  },
  {
    type: "p",
    text: "The metadata update was not the long pole. The copy and catch-up phases were. This is why a migration can be healthy from the balancer's perspective and still be an application incident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "p99 rises on the donor and recipient while other shards stay normal.",
      "Disk read latency and queue depth rise on the donor; write latency on the recipient.",
      "Network throughput between the two shards rises with migration rate.",
      "CPU may stay moderate because the shards are waiting on I/O.",
      "The balancer reports migrations in progress; config server metadata is not the bottleneck.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether p99 rose only on the shards participating in a migration. Then compare migration bytes per second with application bytes per second and check device latency. If the affected shards are also hot for a key, separate the two causes before changing the balancer.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the donor, recipient, and migration rate.",
      "Reduce the rate or chunk size, or pause the migration if p99 is breaching.",
      "Schedule the remaining work in a lower-traffic window.",
      "Add I/O or network capacity if the cluster cannot converge within the window.",
      "Verify p99, I/O utilization, and migration progress after the change.",
      "Re-enable balancing; permanent disablement brings back data imbalance.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A lower migration rate protects latency but extends the time the cluster stays imbalanced.",
      "Smaller chunks reduce the per-migration burst but add metadata operations and more moves.",
      "A migration window concentrates load in a quieter period but may be too short to converge.",
      "Pausing the balancer stops the pain now and stores up more work for later.",
      "Disabling balancing permanently avoids migration load but leaves data volume uneven.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-p99",
    question: "The balancer starts moving chunks and p99 rises while CPU stays at 40%. Why?",
    difficulty: 3,
    hints: [
      "Think about what migration copies.",
      "Both shards still serve traffic.",
      "Look at I/O and network, not only CPU.",
    ],
    answer:
      "Migration copies documents from the donor to the recipient and then catches up on changes. The donor reads, the recipient writes, and both use network and storage that application traffic also needs. When those resources approach saturation, requests queue and p99 rises even though CPU has headroom. I would check migration rate, chunk size, per-device I/O latency, and network throughput on the donor and recipient. Reducing the rate or scheduling the work protects latency.",
    followUps: [
      "Which shard sees reads and which sees writes?",
      "How does chunk size change the burst?",
      "What does `_secondaryThrottle` control?",
    ],
    redFlags: [
      "Assumes migration is free because the metadata update is brief.",
      "Looks only at CPU.",
      "Disables the balancer permanently.",
    ],
    rubric: [
      "Names copy and catch-up phases.",
      "Identifies shared I/O and network.",
      "Explains queueing at moderate CPU.",
      "Chooses throttling or scheduling.",
    ],
  },
  {
    id: "migration-control",
    question: "How would you control chunk migration during peak traffic?",
    difficulty: 3,
    hints: [
      "There is more than an on/off switch.",
      "Rate and chunk size both matter.",
      "Leaving it off has a cost.",
    ],
    answer:
      "I would reduce the migration rate and use the balancing window to keep bulk moves out of peak. I would check whether large chunks are creating the burst and consider a smaller chunk size if the metadata cost is acceptable. If the cluster must converge sooner, I would add I/O and network capacity. I would not leave the balancer off indefinitely, because data volume would drift and future moves would be larger. I would verify p99 and I/O during the next window.",
    followUps: [
      "What does a smaller chunk size cost?",
      "When is pausing the balancer acceptable?",
      "How would you measure convergence?",
    ],
    redFlags: [
      "Only offers enable or disable.",
      "Ignores chunk size.",
      "Leaves balancing off forever.",
    ],
    rubric: [
      "Uses rate and window.",
      "Considers chunk size.",
      "Names the cost of disabling.",
      "Verifies with latency and progress.",
    ],
  },
  {
    id: "hot-shard-vs-migration",
    question: "How do you tell a migration-induced latency problem from a hot-shard problem?",
    difficulty: 3,
    hints: [
      "Which shards are affected?",
      "Is I/O rising with migration bytes?",
      "A hot key follows one key, not a move.",
    ],
    answer:
      "A migration problem follows the donor and recipient and correlates with migration bytes and I/O. A hot-shard problem follows one shard and one key or range, and it persists when migration stops. I would check whether p99 falls when the migration is paused, whether the affected shards are the migration participants, and whether write rate is concentrated on one key. If both are true, fix the migration pressure first, then the key distribution.",
    followUps: [
      "What if the recipient is also the hot shard?",
      "Which metric separates the two fastest?",
      "Why can a migration make a hot shard worse?",
    ],
    redFlags: [
      "Blames the balancer for a key hotspot.",
      "Assumes migration affects all shards equally.",
      "Changes the shard key during the incident.",
    ],
    rubric: [
      "Uses affected-shard scope.",
      "Correlates with migration activity.",
      "Checks key concentration.",
      "Separates the two fixes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the migration",
    items: [
      "Know the chunk size, migration rate, and balancing window.",
      "Check I/O and network headroom on likely donors and recipients.",
      "Set a p99 rollback threshold for the migration window.",
      "Confirm the cluster is not already dealing with a hot key.",
    ],
  },
  {
    title: "During the migration",
    items: [
      "Watch p99 and I/O on the donor and recipient, not the cluster average.",
      "Compare migration bytes per second with application bytes per second.",
      "Reduce the rate or pause if p99 breaches.",
      "Do not disable the balancer permanently to hide the symptom.",
    ],
  },
  {
    title: "After the migration",
    items: [
      "Confirm p99 and I/O returned to baseline.",
      "Verify the range moved and the balancer is still healthy.",
      "Check for residual range deletion or cache pressure.",
      "Review whether the next window needs a lower rate or more capacity.",
    ],
  },
];

const references = [
  {
    title: "Chunk Migration",
    url: "https://www.mongodb.com/docs/manual/core/sharding-chunk-migration/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Migration procedure, copy and catch-up phases, metadata update, and deletion.",
  },
  {
    title: "Sharded Cluster Balancer",
    url: "https://www.mongodb.com/docs/manual/core/sharding-balancer-administration/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Balancer behavior, migration thresholds, and balancing windows.",
  },
  {
    title: "Sharding",
    url: "https://www.mongodb.com/docs/manual/sharding/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Sharded cluster overview and chunk concepts.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "chunk-migration": {
      model: chunkMigrationModel,
      presets,
      instructions:
        "Start Healthy, then apply Migration burst. Compare p99 with shared I/O, stop the migration, and restart it at a lower rate. Use the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. Migration rate, chunk size, write amplification, and I/O capacity are teaching values; MongoDB documents the procedure and default chunk size, not these throughput numbers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-hot-shard", "mongodb-balancer", "mongodb-sharding"],
};
