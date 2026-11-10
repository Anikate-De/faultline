import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PRIMARY_CAPACITY = 60_000;
const REPLICA_CAPACITY = 50_000;

const params = [
  {
    id: "readRps",
    label: "Read rate",
    min: 5_000,
    max: 200_000,
    step: 5_000,
    value: 30_000,
    unit: " rps",
    group: "Traffic",
    help: "Read commands per second before routing. The split decides how many reach the primary and replicas.",
    format: "rps" as const,
  },
  {
    id: "replicaCount",
    label: "Replica count",
    min: 1,
    max: 5,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Read replicas attached to the primary. More replicas split replica reads but add replication fan-out.",
    format: "count" as const,
  },
  {
    id: "readSplit",
    label: "Reads routed to replicas",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
    group: "Routing",
    help: "Share of reads the client sends to replicas. Freshness-sensitive reads must stay on the primary or carry a version check.",
    format: "percent" as const,
  },
  {
    id: "replicaDelay",
    label: "Injected replica delay",
    min: 0,
    max: 10,
    step: 0.5,
    value: 0,
    unit: "s",
    group: "Replication",
    help: "Extra delay before a replica applies the primary's stream, as with a cross-region replica. Lag also rises when a replica is saturated.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface ReplicaState {
  id: string;
  cpu: number;
  ops: number;
  lag: number;
  health: "ok" | "warn" | "crit";
}

interface Values {
  readRps: number;
  replicaCount: number;
  split: number;
  writeRps: number;
  primaryOps: number;
  primaryCpu: number;
  replicas: ReplicaState[];
  replicaCpu: number;
  replicaOps: number;
  replicaLag: number;
  staleReads: number;
}

function compute(p: Params): Values {
  const readRps = Math.max(1, num(p, "readRps", 30_000));
  const replicaCount = Math.round(clamp(num(p, "replicaCount", 3), 1, 6));
  const split = clamp(num(p, "readSplit", 50) / 100, 0, 1);
  const writeRps = readRps * 0.1;
  const replicaDelay = Math.max(0, num(p, "replicaDelay", 0));
  const primaryOps = writeRps + readRps * (1 - split);
  const replicaOps = (readRps * split) / replicaCount;
  const replicaUtil = replicaOps / REPLICA_CAPACITY;
  const lag = Math.max(
    0.02,
    0.05 + replicaDelay + Math.max(0, replicaUtil - 0.7) ** 2 * 80,
  );
  const replicas: ReplicaState[] = Array.from({ length: replicaCount }, (_, index) => {
    const cpu = clamp((replicaOps / REPLICA_CAPACITY) * 100, 0, 100);
    const health = cpu >= 90 || lag >= 5 ? "crit" : cpu >= 75 || lag >= 1 ? "warn" : "ok";
    return { id: `replica-${index}`, cpu, ops: replicaOps, lag, health };
  });
  return {
    readRps,
    replicaCount,
    split,
    writeRps,
    primaryOps,
    primaryCpu: clamp((primaryOps / PRIMARY_CAPACITY) * 100, 0, 100),
    replicas,
    replicaCpu: Math.max(...replicas.map((replica) => replica.cpu)),
    replicaOps,
    replicaLag: lag,
    staleReads: lag > 1 ? split * 100 : 0,
  };
}

function cpuHealth(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 90) return "crit";
  if (cpu >= 75) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return Math.round(value).toLocaleString();
}

function formatLag(seconds: number): string {
  return seconds < 1 ? `${(seconds * 1000).toFixed(0)}ms` : `${seconds.toFixed(1)}s`;
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const wave = (index: number) => 0.97 + 0.05 * Math.sin((index + (seed % 6)) / 2.4);
  frame.series["replica-cpu"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.replicaCpu * wave(index)));
  frame.series["replication-lag"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.replicaLag * wave(index + 2)),
  );
  frame.series["primary-cpu"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.primaryCpu * wave(index + 3)));
  frame.series["stale-reads"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.staleReads * wave(index + 4)));
  frame.series["read-rps"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.readRps * wave(index + 5)));
  for (const replica of v.replicas) {
    frame.series[`cpu.${replica.id}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, replica.cpu * wave(index + 6)),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const primaryHealth = cpuHealth(v.primaryCpu);
  const appHealth = v.replicaLag >= 5 || v.primaryCpu >= 90 ? "crit" : v.replicaLag >= 1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "Read router",
        kind: "service",
        health: appHealth,
        utilization: clamp(v.readRps / 200_000),
        throughput: v.readRps,
        sublabel: `${Math.round(v.split * 100)}% to replicas`,
        meta: { view: "flow" },
      },
      {
        id: "primary",
        label: "Redis primary",
        kind: "cache",
        role: "primary",
        health: primaryHealth,
        utilization: clamp(v.primaryCpu / 100),
        throughput: v.primaryOps,
        sublabel: `${formatCount(v.primaryOps)} ops/s · ${v.primaryCpu.toFixed(0)}% CPU`,
        detail: `Reads and writes both reach the primary. Illustrative capacity is ${formatCount(PRIMARY_CAPACITY)} ops/s per primary; this is a teaching value, not an ElastiCache limit.`,
        meta: { view: "flow" },
      },
      ...v.replicas.map((replica) => ({
        id: replica.id,
        label: replica.id,
        kind: "cache" as const,
        role: "replica" as const,
        health: replica.health,
        utilization: clamp(replica.cpu / 100),
        throughput: replica.ops,
        sublabel: `${formatCount(replica.ops)} ops/s · ${replica.cpu.toFixed(0)}% CPU`,
        detail: `Asynchronous replica. Lag ${formatLag(replica.lag)}; reads served here can be that far behind the primary.`,
        meta: { view: "flow", lag: replica.lag, cpu: replica.cpu },
      })),
    ],
    edges: [
      edge("service-primary", "service", "primary", 1 - v.split, primaryHealth),
      ...v.replicas.map((replica) =>
        edge(`service-${replica.id}`, "service", replica.id, v.split / v.replicaCount, replica.health),
      ),
    ],
    metrics: [
      metric("primary-cpu", "Primary CPU", v.primaryCpu, "%", 75, 90, "percent"),
      metric("replica-cpu", "Replica max CPU", v.replicaCpu, "%", 75, 90, "percent"),
      metric("replication-lag", "Replication lag", v.replicaLag, "s", 1, 5, "number"),
      metric("stale-reads", "Stale read share", v.staleReads, "%", 5, 20, "percent"),
      metric("read-rps", "Read rate", v.readRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(v.split * 100)}% of ${formatCount(v.readRps)} reads to ${v.replicaCount} replicas: replica CPU ${v.replicaCpu.toFixed(0)}%, lag ${formatLag(v.replicaLag)}, ${v.staleReads.toFixed(0)}% of reads stale.`,
  };
  seedSeries(frame, v, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "primary-cpu",
    metricId: "primary-cpu",
    warn: 75,
    crit: 90,
    title: "The primary is still the bottleneck",
    cause:
      "Reads not routed to replicas, plus every write, still land on the primary. Offloading a share of reads does not reduce the write path.",
    fix:
      "Route more reads to replicas if freshness allows, or reduce write cost. Adding replicas helps only the read share that actually leaves the primary.",
    checkFirst: [
      "Check the primary's CPU and ops split by command type.",
      "Check the configured read split and whether clients honor it.",
      "Check whether writes or transactions dominate primary work.",
    ],
  },
  {
    id: "replica-cpu",
    metricId: "replica-cpu",
    warn: 75,
    crit: 90,
    title: "A replica is saturated",
    cause:
      "Replica reads are concentrated. If the hot key is routed to replicas, the same concentration moves to each replica, and adding replicas only helps if reads spread across them.",
    fix:
      "Spread reads across replicas, reduce per-replica hot-key load with caching or salting, or add replicas only after checking the routing. A replica is a read server, not extra primary capacity.",
    checkFirst: [
      "Compare CPU per replica, not the replica fleet average.",
      "Check whether one key or tenant dominates replica reads.",
      "Check whether the client routes to a single replica or a pool.",
    ],
  },
  {
    id: "replication-lag",
    metricId: "replication-lag",
    warn: 1,
    crit: 5,
    title: "Replication lag exceeds the freshness budget",
    cause:
      "Redis replicates asynchronously. A replica applies the primary's write stream later, and a saturated replica applies it more slowly. Reads served during that gap can return older data.",
    fix:
      "Keep freshness-sensitive reads on the primary, reduce replica load, or use a version token that lets the client detect stale data. More replicas do not make replication synchronous.",
    checkFirst: [
      "Check lag per replica with `INFO replication`.",
      "Check replica CPU, network, and persistence activity.",
      "Identify reads that require read-your-writes and confirm their routing.",
    ],
  },
  {
    id: "stale-reads",
    metricId: "stale-reads",
    warn: 5,
    crit: 20,
    title: "Stale reads are reaching users",
    cause:
      "A share of reads is routed to replicas whose data is older than the freshness budget. The user-visible error is stale content, not a timeout or a cache miss.",
    fix:
      "Route reads that need the latest value to the primary, shorten the lag, or return a version the client can validate. Measure staleness at the read path, not only at the replica.",
    checkFirst: [
      "Trace a stale response back to the replica and its lag at read time.",
      "Check whether the client uses a primary read after its own write.",
      "Check whether the freshness budget is documented per endpoint.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const readReplicasModel: SimModel = {
  id: "caching-read-replicas",
  visual: "replication",
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
    for (const replica of next.nodes.filter((node) => node.role === "replica")) {
      recordSeries(next, `cpu.${replica.id}`, Number(replica.meta?.cpu ?? 0));
    }
    next.events = [...frame.events];
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    return [
      `${Math.round(v.split * 100)}% of ${formatCount(v.readRps)} reads leave the primary: ${formatCount(v.replicaOps)} ops/s per replica across ${v.replicaCount} replicas.`,
      `The primary keeps every write plus the unoffloaded read share: ${formatCount(v.primaryOps)} ops/s at ${v.primaryCpu.toFixed(0)}% CPU. The model assumes writes equal 10% of reads; replicas cannot reduce that work.`,
      `Replica CPU is ${v.replicaCpu.toFixed(0)}% and lag is ${formatLag(v.replicaLag)}. Lag rises when replicas cannot apply the write stream fast enough, so staleness and CPU are linked.`,
      `About ${v.staleReads.toFixed(0)}% of all reads are served by replicas beyond the one-second freshness budget in this model. If the product requires read-your-writes, those reads need a different route.`,
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
    description: "Three replicas absorb half the reads; lag is well inside the freshness budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High read traffic with 60% offload; the primary is saturated but replicas are not.",
    tone: "warn",
    params: defaults({ readRps: 100_000, replicaCount: 3, readSplit: 60, replicaDelay: 0.2 }),
  },
  {
    id: "failure",
    label: "Replica saturation",
    description: "Two replicas take 90% of 120k reads; replica CPU and lag both go critical.",
    tone: "crit",
    params: defaults({ readRps: 120_000, replicaCount: 2, readSplit: 90, replicaDelay: 1.5 }),
  },
  {
    id: "failover",
    label: "One replica lost",
    description: "One of three replicas is lost; the two survivors take the same read share, and lag follows CPU.",
    tone: "crit",
    params: defaults({ readRps: 120_000, replicaCount: 2, readSplit: 80, replicaDelay: 1.5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Four replicas, 75% offload, and a small injected delay leave lag inside the budget.",
    tone: "ok",
    params: defaults({ readRps: 90_000, replicaCount: 4, readSplit: 75, replicaDelay: 0.2 }),
  },
];

const experiment: Experiment = {
  id: "predict-replica-constraint",
  title: "Predict the binding constraint",
  simId: "read-replicas",
  question:
    "Two replicas take 90% of 120k reads and users see stale data. Primary CPU is below its warning threshold. What limits recovery?",
  prediction: {
    options: [
      { id: "replica", label: "Replica CPU and replication lag: the replicas cannot apply reads and the write stream fast enough." },
      { id: "primary", label: "Primary CPU, because every read still reaches it once." },
      { id: "network", label: "Network bandwidth, because replication uses more bytes than reads." },
      { id: "hit", label: "Cache hit rate, because replicas have a separate keyspace." },
    ],
    correctOptionId: "replica",
    explanation:
      "The primary is below its warning threshold because most reads were moved off it. The replicas now carry the concentrated read load and must also apply the primary's write stream. As replica CPU saturates, lag grows and reads served there fall behind. Adding replicas can help only if the read routing spreads across them; it does not make replication synchronous.",
  },
  setup: defaults({ readRps: 120_000, replicaCount: 2, readSplit: 90, replicaDelay: 1.5 }),
  runFor: 12,
  observe: [
    "Replica CPU crosses 90% while primary CPU stays below its warning threshold.",
    "Replication lag combines the injected delay with replica saturation; it is not set by the read rate alone.",
    "The stale-read share follows lag and the offloaded read share.",
    "Adding replicas lowers per-replica CPU only if the router spreads reads evenly.",
  ],
  explain:
    "Replica offload moves read work, not write work. Each replica must serve its read share and apply the primary's write stream. When that combined work saturates a replica, lag grows and the freshness budget fails. The fix has to reduce per-replica load or keep freshness-sensitive reads on the primary; a bigger primary does not help a saturated replica.",
  fix: defaults({ readRps: 90_000, replicaCount: 4, readSplit: 75, replicaDelay: 0.2 }),
  debrief:
    "Four replicas and a lower injected delay brought both replica CPU and lag back under the thresholds. The remaining cost is routing complexity and a larger replica fleet. The freshness-sensitive reads still need a primary path or a version check; offload is not a correctness fix.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Redis read replica is an asynchronous copy of a primary. The primary sends its write stream to each replica; the replica applies it and can serve read commands. Because the primary does not wait for every replica before acknowledging a write, a replica can be behind. That difference is replication lag, and it becomes user-visible staleness when reads are routed there. Replication lag is not a bug in Redis; it is the cost of the asynchronous model that makes the primary fast.",
  },
  {
    type: "p",
    text: "Read replicas are attractive because they add read capacity without sharding the keyspace. The primary keeps all writes and the reads that must be fresh. Replicas take the rest. If the reads are concentrated on one hot key, every replica that serves that key inherits the concentration. Adding replicas then spreads load only if the client actually spreads requests across them.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, read router, primary or replica. Writes always go to the primary, then flow asynchronously to replicas. A read-your-writes endpoint must go to the primary or carry a version that the client can check. A recommendation or catalog page may tolerate a short lag and can use a replica. The routing decision belongs to the endpoint, not to a global cache client default.",
  },
  {
    type: "compare",
    leftTitle: "Primary read",
    rightTitle: "Replica read",
    rows: [
      { label: "Freshness", left: "Current at the time of the read", right: "As fresh as the replica's applied offset" },
      { label: "Capacity", left: "Competes with every write", right: "Adds read capacity across replicas" },
      { label: "Failure mode", left: "Primary CPU or connection limits", right: "Lag, stale data, or a saturated replica" },
      { label: "Good fit", left: "Read-your-writes, checkout, permissions", right: "Catalogs, feeds, recommendations, analytics" },
    ],
  },
  {
    type: "p",
    text: "This module uses a 60k operations per second (ops/s) primary and 50k ops/s per replica as illustrative capacity values. Lag is a model of replica delay, write-stream pressure, and replica saturation, not a Redis measurement. The shape is what matters: reads leave the primary, writes do not, and lag is the freshness price.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Primary CPU, which falls only for the read share that is actually offloaded.",
      "Replica max CPU, which can rise even as the primary gets quieter.",
      "Replication lag and the share of reads served beyond the freshness budget.",
      "A replica topology that makes the failover case visible: one fewer replica means more load per survivor.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Replica saturation. Compare primary CPU with replica CPU: the primary looks better while the replicas fail. Apply One replica lost to see the same load on fewer replicas, then Recovery. Run the experiment before reading the debrief.",
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it does not tell you"],
    rows: [
      ["Primary CPU", "Write plus unoffloaded read work", "Whether the offloaded reads are fresh"],
      ["Replica CPU", "Per-replica read and replication work", "Whether the client spread reads evenly"],
      ["Replication lag", "How far a replica is behind", "Whether the stale read mattered to the user"],
      ["Stale read share", "How much traffic can see old data", "Which endpoint or key is affected"],
    ],
  },
  {
    type: "p",
    text: "The first question is which reads are allowed to be stale. A global 50% split is not a policy; it is a guess. Route by endpoint, keep read-your-writes on the primary, and measure lag at the replica that served the read. If the product cannot tolerate any staleness, replicas are read capacity for other workloads, not for that endpoint.",
  },
  { type: "sim", simId: "read-replicas" },
  { type: "experiment", experimentId: "predict-replica-constraint" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The read router sent most reads to two replicas. The primary CPU fell because it kept only writes and the remaining reads. Each replica had to serve a large read share and apply the primary's write stream. Replica CPU saturated, lag grew, and reads served during the lag returned older data. The primary was healthy while the user-visible freshness failed.",
  },
  {
    type: "p",
    text: "Adding replicas spread the read share and lowered per-replica CPU, which let lag recover. The write path still went through the primary, and freshness-sensitive reads still needed a primary route. The recovery was a routing and capacity change, not a replication mode change.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Redis `INFO replication`: per-replica offset, `master_repl_offset`, and lag.",
      "ElastiCache: `ReplicationLag`, `EngineCPUUtilization`, `CurrConnections`, and `SaveInProgress` per node.",
      "Read-router metrics: share of reads by target, fallback counts, and errors when a replica is unhealthy.",
      "Application signals: stale reads, version-conflict retries, and endpoints that require read-your-writes.",
      "Traces: the replica span is fast but the returned version is older than the write the user just made.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check lag per replica and CPU per replica, not the fleet average. Then confirm which reads are routed there. If primary CPU is low and users see stale data, the replicas are the bottleneck, not the primary.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Separate read-your-writes endpoints from reads that can tolerate lag.",
      "Check lag and CPU per replica; find whether one key or tenant dominates.",
      "Spread reads across healthy replicas and remove a failed replica from rotation.",
      "Reduce per-replica load with a local cache, key salting, or a lower offload share.",
      "Keep a primary path for reads that cannot be stale, and expose a version when possible.",
      "Re-run at peak and failover: verify lag, replica CPU, stale share, and primary CPU together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Replicas add read capacity without sharding, but they do not reduce write work or make replication synchronous.",
      "Higher offload lowers primary CPU and raises the chance that a stale read reaches a user.",
      "More replicas spread reads and add replication fan-out, connection overhead, and failover surface.",
      "Keeping reads on the primary protects freshness and keeps the primary as the scaling limit.",
      "A version check can make replica reads safe, but every client path must honor it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-stale-reads",
    question:
      "Users see stale profile data after updating it. The service reads from Redis replicas. How do you diagnose the path?",
    difficulty: 3,
    hints: [
      "Start with the write, then the read target, then the replica offset.",
      "A fast replica can still be behind.",
    ],
    answer:
      "I would trace one update end to end: the write reaches the primary at some offset, the client then reads, and the read router chooses a target. If the read goes to a replica, I compare the replica's applied offset with the primary's offset at read time. A nonzero gap explains the stale value. I would also check whether the endpoint is supposed to be read-your-writes, whether the client has a primary-read-after-write rule, and whether lag is elevated across replicas or only one. The fix is routing or a version check, not a cache flush.",
    followUps: [
      "How would you prove the read hit a replica?",
      "What if the lag was zero but the value was still old?",
      "How would you set a freshness budget per endpoint?",
    ],
    redFlags: [
      "Flushes the cache without checking the read target.",
      "Assumes replicas are synchronous.",
      "Ignores the write offset.",
    ],
    rubric: [
      "Traces write offset to read target.",
      "Checks per-replica lag.",
      "Identifies read-your-writes endpoints.",
      "Names a routing or version fix.",
    ],
  },
  {
    id: "choose-offload",
    question:
      "The primary is at 80% CPU and replicas are at 20%. How much read traffic do you move, and what do you check next?",
    difficulty: 3,
    hints: [
      "The primary also carries every write.",
      "The next bottleneck may be the replica or the freshness budget.",
    ],
    answer:
      "I would first split primary CPU into write work and read work. If writes are a large share, offloading reads has a limited ceiling; if reads dominate, I can move the share that is freshness-tolerant. I would increase offload in steps and watch per-replica CPU and lag, not just primary CPU. The next bottleneck is usually the hottest replica or the staleness budget. I would stop when either approaches its threshold and keep read-your-writes on the primary. The goal is not to equalize CPU; it is to protect the SLO without breaking freshness.",
    followUps: [
      "What if one replica is much hotter than the others?",
      "How would you roll back an offload change?",
      "What would make you add a replica instead of raising the split?",
    ],
    redFlags: [
      "Moves 100% of reads immediately.",
      "Watches only primary CPU.",
      "Ignores read-your-writes.",
    ],
    rubric: [
      "Separates write and read work on the primary.",
      "Raises offload incrementally.",
      "Watches per-replica CPU and lag.",
      "Defines a stopping condition.",
    ],
  },
  {
    id: "failover-plan",
    question:
      "A replica fails during peak. What happens to the remaining replicas and the read path?",
    difficulty: 3,
    hints: [
      "The read share does not disappear with the replica.",
      "The router must remove the failed target quickly.",
    ],
    answer:
      "The remaining replicas take the failed replica's share if the router redistributes, so per-replica CPU rises and lag can follow. If the router keeps sending to the failed node, reads error or time out. I would remove the failed replica from rotation, verify the remaining replicas have headroom, and temporarily reduce offload or route freshness-sensitive reads to the primary if lag grows. I would also check whether the failure was a replica or the network path, because a network partition can leave the primary and replica disagreeing about connectivity. The plan needs a tested failover path, not just a replica count.",
    followUps: [
      "How do you detect a failed replica quickly?",
      "What happens if the primary also fails?",
      "How would you restore the replica without adding load?",
    ],
    redFlags: [
      "Leaves the failed replica in rotation.",
      "Adds read share to survivors without checking headroom.",
      "Confuses replica failure with primary failure.",
    ],
    rubric: [
      "Removes the failed target.",
      "Rechecks per-replica headroom and lag.",
      "Protects freshness-sensitive reads.",
      "Distinguishes failure modes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each read endpoint has a documented freshness budget and routing rule.",
      "Read-your-writes paths are pinned to the primary or carry a version.",
      "Dashboards show lag and CPU per replica, plus the offload share.",
      "A replica-loss drill confirms the router redistributes safely.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check lag and CPU per replica before changing the primary.",
      "Remove failed replicas from rotation and watch the survivors.",
      "Reduce offload or pin sensitive reads if lag exceeds the budget.",
      "Check whether one key or tenant dominates replica reads.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run peak and failover with the new routing.",
      "Record the remaining freshness window per endpoint.",
      "Right-size the replica count and the offload share.",
      "Add an alert on stale reads, not only on lag.",
    ],
  },
];

const references = [
  {
    title: "Redis replication",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/replication/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Asynchronous replication, offsets, and read-only replicas.",
  },
  {
    title: "ElastiCache replication",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Replication.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Replication groups, replicas, and failover behavior.",
  },
  {
    title: "INFO command",
    url: "https://redis.io/docs/latest/commands/info/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Replication offsets and memory fields.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "read-replicas": {
      model: readReplicasModel,
      presets,
      instructions:
        "Start healthy, then apply Replica saturation. Compare primary CPU with per-replica CPU and lag, then apply One replica lost. Recovery adds replicas and lowers the injected delay.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Primary and replica capacity values are teaching numbers, not ElastiCache limits. Lag combines an injected replica delay with write-stream pressure and replica saturation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["caching-redis-persistence", "caching-cluster-failover", "caching-hot-key-sharding"],
};
