import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOT_INDEX = 2;
const SHARD_CAPACITY = 30_000;
const SAMPLE_TARGET = 4_000;
const MAX_DETECTION = 180;
const DB_CAPACITY = 25_000;

const params = [
  {
    id: "totalRps",
    label: "Total read rate",
    min: 10_000,
    max: 200_000,
    step: 5_000,
    value: 30_000,
    unit: " rps",
    group: "Traffic",
    help: "Reads arriving at the service before Redis. The cluster average is computed from this rate.",
    format: "rps" as const,
  },
  {
    id: "hotKeyShare",
    label: "Hot key share",
    min: 1,
    max: 70,
    step: 1,
    value: 5,
    unit: "%",
    group: "Traffic",
    help: "Share of reads that land on one key. At 40% the key, not the cluster, sets the capacity.",
    format: "percent" as const,
  },
  {
    id: "sampleRate",
    label: "Per-key sample rate",
    min: 0.1,
    max: 100,
    step: 0.1,
    value: 20,
    unit: "%",
    group: "Instrumentation",
    help: "Share of commands recorded by the per-key sampler. Lower rates are cheaper but need longer to collect enough samples.",
    format: "percent" as const,
    scale: "log" as const,
  },
  {
    id: "shardCount",
    label: "Redis primaries",
    min: 3,
    max: 16,
    step: 1,
    value: 8,
    unit: "",
    group: "Topology",
    help: "Primaries in the Redis Cluster. More shards raise aggregate capacity but do not split one key.",
    format: "count" as const,
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
}

interface Computed {
  totalRps: number;
  hotShare: number;
  sampleRate: number;
  shardCount: number;
  shards: ShardState[];
  maxCpu: number;
  avgCpu: number;
  imbalance: number;
  p99: number;
  errors: number;
  hitRate: number;
  dbQps: number;
  dbCpu: number;
  detectSeconds: number;
  hotOps: number;
}

function p99For(cpu: number): number {
  if (cpu >= 100) return 500;
  return Math.min(500, 1.5 + (45 * (cpu / 100) ** 5) / Math.max(0.05, 1.05 - cpu / 100));
}

function compute(p: Params): Computed {
  const totalRps = Math.max(1, num(p, "totalRps", 30_000));
  const hotShare = clamp(num(p, "hotKeyShare", 5) / 100, 0.01, 0.7);
  const sampleRate = clamp(num(p, "sampleRate", 20) / 100, 0.001, 1);
  const shardCount = Math.max(3, Math.round(num(p, "shardCount", 8)));
  const hotOps = totalRps * hotShare;
  const otherOps = totalRps - hotOps;
  const shards: ShardState[] = Array.from({ length: shardCount }, (_, index) => {
    const ops = otherOps / shardCount + (index === HOT_INDEX % shardCount ? hotOps : 0);
    const cpu = (ops / SHARD_CAPACITY) * 100;
    return { index, cpu, p99: p99For(cpu), ops };
  });
  const maxCpu = Math.max(...shards.map((shard) => shard.cpu));
  const avgCpu = (totalRps / shardCount / SHARD_CAPACITY) * 100;
  const hitRate = 96 + 3 * (1 - hotShare);
  const dbQps = totalRps * (1 - hitRate / 100);
  return {
    totalRps,
    hotShare,
    sampleRate,
    shardCount,
    shards,
    maxCpu,
    avgCpu,
    imbalance: maxCpu / Math.max(0.1, avgCpu),
    p99: Math.max(...shards.map((shard) => shard.p99)),
    errors: Math.max(...shards.map((shard) => (shard.cpu > 95 ? Math.min(30, (shard.cpu - 95) * 1.5) : 0))),
    hitRate,
    dbQps,
    dbCpu: clamp((dbQps / DB_CAPACITY) * 100, 0, 200),
    detectSeconds: Math.min(MAX_DETECTION, SAMPLE_TARGET / Math.max(1, hotOps * sampleRate)),
    hotOps,
  };
}

function healthFor(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function formatCpu(cpu: number): string {
  return cpu >= 100 ? "100+%" : `${cpu.toFixed(0)}%`;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 11)) / 2.6);
  const seeds: [string, number, number][] = [
    ["hot-shard-cpu", values.maxCpu, 3],
    ["redis-p99", values.p99, 4],
    ["redis-errors", values.errors, 0.2],
    ["detection-lag", values.detectSeconds, 0.1],
    ["shard-imbalance", values.imbalance, 0.08],
    ["cache-hit-rate", values.hitRate, 0.2],
    ["db-cpu", values.dbCpu, 0.6],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  for (const shard of values.shards) {
    frame.series[`cpu.shard-${shard.index}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, shard.cpu * jitter(index + shard.index) + Math.sin(index / 2.4 + shard.index) * 1.5),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const hotShardHealth = healthFor(values.maxCpu);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(values.totalRps)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Product service",
        kind: "service",
        health: values.totalRps > 150_000 ? "warn" : "ok",
        utilization: clamp(values.totalRps / 200_000),
        throughput: values.totalRps,
        sublabel: `${formatCount(values.totalRps)} rps`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis Cluster",
        kind: "cache",
        health: hotShardHealth,
        utilization: values.maxCpu / 100,
        throughput: values.totalRps,
        sublabel: `${values.shardCount} primaries, ${formatCpu(values.avgCpu)} average`,
        detail: `Cluster average CPU is ${formatCpu(values.avgCpu)}; the hottest shard is ${formatCpu(values.maxCpu)}. Illustrative shard capacity: ${formatCount(SHARD_CAPACITY)} ops/s.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Product database",
        kind: "db",
        health: healthFor(values.dbCpu),
        utilization: values.dbCpu / 100,
        throughput: values.dbQps,
        sublabel: `${formatCount(values.dbQps)} qps`,
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
        sublabel: shard.index === HOT_INDEX % values.shardCount ? "hot shard" : "keyspace",
        detail: `${formatCpu(shard.cpu)} CPU, p99 ${shard.p99.toFixed(0)}ms, ${formatCount(shard.ops)} ops/s. Illustrative capacity: ${formatCount(SHARD_CAPACITY)} ops/s.`,
        meta: {
          view: "shards",
          cpu: shard.cpu,
          memory: 4 + values.totalRps / 300_000,
          p99: shard.p99,
          hot: shard.index === HOT_INDEX % values.shardCount && values.hotShare >= 0.25 ? 1 : 0,
        },
      })),
    ],
    edges: [
      edge("client-service", "client", "service", values.totalRps / 200_000),
      edge("service-redis", "service", "redis", 1, hotShardHealth),
      edge("service-db", "service", "db", values.dbQps / values.totalRps, healthFor(values.dbCpu)),
    ],
    metrics: [
      metric("hot-shard-cpu", "Hot shard CPU", values.maxCpu, "%", 70, 85, "percent"),
      metric("redis-p99", "Redis p99", values.p99, "ms", 40, 120, "ms"),
      metric("redis-errors", "Redis errors", values.errors, "%", 0.5, 2, "percent"),
      metric("detection-lag", "Detection lag", values.detectSeconds, "s", 45, 90, "number"),
      metric("shard-imbalance", "Shard imbalance", values.imbalance, "x", 2.5, 4, "number"),
      metric("cache-hit-rate", "Cache hit rate", values.hitRate, "%", undefined, undefined, "percent"),
      metric("db-cpu", "Database CPU", values.dbCpu, "%", 75, 90, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCpu(values.maxCpu)} on the hottest shard; cluster average ${formatCpu(values.avgCpu)}; hit rate ${values.hitRate.toFixed(1)}%.`,
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
    title: "One shard is saturated while the cluster has capacity",
    cause:
      "A single key owns a large share of reads, and its hash slot lives on one shard. The cluster average and the aggregate hit rate stay healthy because the other shards are lightly loaded.",
    fix:
      "Attribute the load before adding capacity. Per-shard CPU shows where the pressure is; per-key counts or sampled command streams show which key owns it. Then reduce the key's read load or spread it.",
    checkFirst: [
      "Compare CPU and ops per shard, not the cluster average.",
      "Check p99 by shard; the cluster-wide p99 hides the slow shard.",
      "Look for a single key with an outsized command count or an unusual access pattern.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Redis p99 is set by the hottest shard",
    cause:
      "Queueing is nonlinear. Once one shard is near its capacity, its command queue grows and p99 rises even though the other shards are fast.",
    fix:
      "Split the p99 by shard or node. Reduce load on the hot shard, and add a bounded fallback so a slow cache does not become a slow request path.",
    checkFirst: [
      "Graph p99 with a shard or node dimension.",
      "Check the client timeout and retry counters for the same window.",
      "Check whether a retry loop is multiplying reads to the same key.",
    ],
  },
  {
    id: "redis-errors",
    metricId: "redis-errors",
    warn: 0.5,
    crit: 2,
    title: "Redis errors are reaching requests",
    cause:
      "The hot shard is at or beyond usable capacity, so commands queue past the client deadline. The error rate is small in aggregate but concentrated on one slot.",
    fix:
      "Protect the request path with a bounded fallback and retry budget. Reduce the hot key's load rather than retrying the same shard harder.",
    checkFirst: [
      "Separate client timeouts from server-side errors.",
      "Check whether errors cluster on one shard or one key.",
      "Confirm the fallback is bounded and observable.",
    ],
  },
  {
    id: "detection-lag",
    metricId: "detection-lag",
    warn: 45,
    crit: 90,
    title: "The per-key detector is too slow to attribute the incident",
    cause:
      "Per-key metrics are sampled. At a low sample rate, a hot key still dominates, but the detector needs more time to collect enough samples to report it with confidence.",
    fix:
      "Temporarily raise sampling for the affected shard or key, or use a bounded top-K counter at the client or proxy. Do not wait for attribution before protecting the shard.",
    checkFirst: [
      "Check the per-key sample rate and the sample count in the current window.",
      "Confirm the detector counts commands, not just unique keys.",
      "Check whether a shard-level signal already localizes the problem.",
    ],
  },
  {
    id: "shard-imbalance",
    metricId: "shard-imbalance",
    warn: 2.5,
    crit: 4,
    title: "Shard load is badly imbalanced",
    cause:
      "The maximum shard CPU is several times the cluster average. This is the signature of a hot key or a hot slot, not a uniformly undersized cluster.",
    fix:
      "Use the imbalance ratio as a trigger to investigate per-key distribution. Adding shards lowers the average and leaves the maximum unchanged.",
    checkFirst: [
      "Find the shard with the highest CPU and compare its key count with the others.",
      "Check whether the hottest shard owns a slot with unusually high traffic.",
      "Compare the imbalance before and after the last deploy or traffic change.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const hotKeyDetectionModel: SimModel = {
  id: "caching-hot-key-detection",
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
    const remaining = Math.max(0, values.detectSeconds - frame.t);
    const cpuJitter = rng.between(-0.5, 0.5);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "hot-shard-cpu") return { ...item, value: Math.max(0, item.value + cpuJitter) };
      if (item.id === "detection-lag") return { ...item, value: remaining };
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const shard of next.nodes.filter((node) => node.meta?.view === "shards")) {
      recordSeries(next, `cpu.${shard.id}`, Number(shard.meta?.cpu ?? 0));
    }
    next.events = [...frame.events].slice(-60);
    if (remaining <= 0 && values.hotShare >= 0.2 && frame.flags.keyAttributed !== 1) {
      pushEvent(next, {
        id: "hot-key-attributed",
        at: frame.t,
        severity: "warn",
        title: "Hot key attributed",
        detail: `One key owns ${Math.round(values.hotShare * 100)}% of reads. At ${values.sampleRate * 100}% sampling, the detector needed about ${Math.round(values.detectSeconds)}s of traffic to collect enough samples. The shard was already at ${formatCpu(values.maxCpu)} CPU.`,
        nodeId: `shard-${HOT_INDEX % values.shardCount}`,
        metricId: "detection-lag",
      });
      next.flags.keyAttributed = 1;
    }
    if (remaining > 0) next.flags.keyAttributed = 0;
    next.summary =
      remaining > 0 && values.hotShare >= 0.2
        ? `${formatCpu(values.maxCpu)} on the hottest shard; cluster average ${formatCpu(values.avgCpu)}; key not yet attributed; about ${Math.ceil(remaining)}s of samples remain.`
        : `${formatCpu(values.maxCpu)} on the hottest shard; cluster average ${formatCpu(values.avgCpu)}; p99 ${values.p99.toFixed(0)}ms; hit rate ${values.hitRate.toFixed(1)}%.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const remaining = Math.max(0, values.detectSeconds - frame.t);
    const items: string[] = [];
    items.push(
      `The hottest shard carries ${formatCpu(values.maxCpu)} CPU while the cluster average is ${formatCpu(values.avgCpu)}. The average is not a health signal for a partitioned cache.`,
    );
    items.push(
      `At ${values.sampleRate * 100}% sampling, ${formatCount(values.hotOps)} hot ops/s produce ${formatCount(values.hotOps * values.sampleRate)} samples/s. Collecting ${formatCount(SAMPLE_TARGET)} samples takes about ${Math.round(values.detectSeconds)}s.`,
    );
    if (remaining > 0) {
      items.push(
        `The detector has about ${Math.ceil(remaining)}s left before it can attribute the key. Shard CPU and p99 are already visible and should drive the immediate response.`,
      );
    } else {
      items.push(
        "The detector can attribute the key. If the sample rate was lowered during the incident, restore it and keep the temporary top-K counter as a follow-up check.",
      );
    }
    items.push(
      `The aggregate hit rate is ${values.hitRate.toFixed(1)}%, which is why a cache dashboard that plots only hit rate and cluster CPU can stay green through this incident.`,
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
    description: "Even traffic at a comfortable shard CPU and a generous per-key sample rate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher traffic and a modest hot key. The hottest shard is saturated but below its critical threshold.",
    tone: "warn",
    params: defaults({ totalRps: 75_000, hotKeyShare: 18, sampleRate: 2, shardCount: 8 }),
  },
  {
    id: "failure",
    label: "Unattributed hot key",
    description: "One key takes 45% of 80k reads while per-key sampling runs at 0.1%. The shard fails before the detector can name the key.",
    tone: "crit",
    params: defaults({ totalRps: 80_000, hotKeyShare: 45, sampleRate: 0.1, shardCount: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The key share falls, sampling rises, and the hottest shard returns below its warning threshold.",
    tone: "ok",
    params: defaults({ totalRps: 60_000, hotKeyShare: 20, sampleRate: 5, shardCount: 8 }),
  },
];

const experiment: Experiment = {
  id: "predict-sample-lag",
  title: "Predict what sampling changes",
  simId: "hot-key-detection",
  question:
    "You keep the hot key at 45% of 80k reads but lower per-key sampling from 100% to 0.1%. Which signal changes first?",
  prediction: {
    options: [
      { id: "detector", label: "The detector's attribution time rises; shard CPU and p99 stay critical." },
      { id: "cpu", label: "The hot shard CPU falls because fewer commands are counted." },
      { id: "hit", label: "The aggregate hit rate falls because the sample is smaller." },
      { id: "nothing", label: "Nothing changes; sampling is uniform across keys." },
    ],
    correctOptionId: "detector",
    explanation:
      "Sampling changes how many commands the detector observes, not how many commands Redis serves. The hot shard still receives 36k ops/s, so its CPU and p99 are unchanged. At 0.1% sampling the detector sees about 36 hot samples per second, so collecting 4,000 samples takes roughly 111 seconds. The incident is visible in shard CPU long before it is attributable to a key.",
  },
  setup: defaults({ totalRps: 80_000, hotKeyShare: 45, sampleRate: 0.1, shardCount: 8 }),
  runFor: 30,
  observe: [
    "Detection lag starts above 100 seconds and is still above 75 seconds at the end of the 30-second run.",
    "The hottest shard CPU and Redis p99 are unchanged from the 100% sampling case.",
    "The aggregate hit rate stays near 98%, so a hit-rate dashboard looks healthy.",
    "Shard imbalance is about 4x, which localizes the problem to one shard but not to one key.",
    "The product database stays lightly loaded; this is not a cache-miss problem.",
  ],
  explain:
    "Per-key sampling is an observability cost, not a traffic control. A low sample rate reduces collector work but increases the time needed to collect a confident count for a key. During that gap, per-shard CPU, p99, and imbalance are the signals that localize the incident. The detector names the key after the fact; it does not prevent the saturation.",
  fix: defaults({ totalRps: 60_000, hotKeyShare: 20, sampleRate: 5, shardCount: 8 }),
  debrief:
    "The hot key was always visible in the per-shard view: one shard at more than 130% CPU while the cluster average stayed near 33%. Sampling delayed the per-key answer by almost two minutes. The recovery preset lowers the key's share and raises sampling, so the shard returns below its warning threshold and the detector can confirm the key quickly. A permanent fix also needs a bounded top-K counter or an on-demand sample burst, because waiting for the default sample rate is not an incident response.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A hot key is one key that receives a disproportionate share of a cache's traffic. Redis Cluster maps each key to one of 16,384 hash slots, and each slot is owned by one primary. When a key is hot, its slot and its shard receive the load while the rest of the cluster has spare capacity. The user-visible symptom is usually latency on one shard, not a cluster-wide capacity problem.",
  },
  {
    type: "p",
    text: "The failure is hard to see because the most common cache dashboards are aggregates. Cache hit rate is a ratio over all requests, so one key's pain is diluted by millions of healthy reads. Cluster CPU is an average over all shards, so one saturated shard can sit beside seven idle ones without moving the line. The signals that expose the problem are per-shard CPU and ops, per-shard p99, and a per-key command count.",
  },
  {
    type: "p",
    text: "Redis does not provide a cheap built-in per-key command counter. `INFO commandstats` aggregates by command name, not by key. `SLOWLOG` records only commands that exceed its latency threshold, so a hot key made of fast commands may never appear. `MONITOR` streams every command and is useful for a short debugging window, but it adds substantial overhead and is not a production sampling method. In practice, per-key counts come from the client library, a proxy, or a sampled command stream, and the sample rate determines how long attribution takes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Signal", "What it answers", "What it hides"],
    rows: [
      ["Cluster average CPU", "Is the fleet broadly busy?", "One shard at 130% beside seven at 20%"],
      ["Cache hit rate", "What share of reads found a value?", "Which key is slow, and whether one shard is queueing"],
      ["Per-shard CPU and ops", "Which shard is carrying the load?", "Which key owns that shard"],
      ["Per-key command count", "Which key is hot?", "Whether the collector's sample is large enough to trust"],
      ["Per-shard p99", "Is the hot shard queueing?", "Whether the queue is caused by one key or many"],
      ["SLOWLOG and MONITOR", "What commands ran, or ran slowly?", "Fast hot commands stay out of the slowlog; MONITOR is costly"],
    ],
  },
  {
    type: "p",
    text: "The request path is client, product service, Redis Cluster, then the database on a miss. Per-shard signals come from Redis or the managed cache's node-level metrics. Per-key signals usually come from the service's Redis client or a proxy that sees each command. The two views must be joined by shard and by time; otherwise a per-key counter on one instance cannot explain a shard that is hot because of traffic from another instance.",
  },
  {
    type: "p",
    text: "This module models a catalog read path with 3–16 primaries. The shard capacity (30,000 ops/s), the detector's sample target (4,000 commands), and the p99 curve are illustrative teaching values, not ElastiCache limits or a capacity guarantee. The shape of the failure is the lesson: one shard saturates, the aggregate stays green, and a sampled detector takes time to name the key.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot shard CPU: the maximum across shards, with warnings at 70% and 85%.",
      "Redis p99 and errors: the hot shard's queueing and timeouts, not the cluster average.",
      "Detection lag: seconds of traffic the per-key sampler still needs before it can attribute the key.",
      "Shard imbalance: the hottest shard's CPU divided by the cluster average.",
      "Cache hit rate and database CPU: the aggregate signals that stay healthy and hide the incident.",
      "A per-shard heat map: CPU over time, which makes the partition visible even before the key is named.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Unattributed hot key. Watch the shard heat map and the imbalance metric before looking at the key. Lower the sample rate and observe that the traffic and the shard CPU do not move, but detection lag grows. Run the guided experiment, then apply Recovery and confirm that detection lag falls with the key's share.",
  },
  {
    type: "p",
    text: "The first question is not which dashboard to add. It is which decision the signal supports. Per-shard CPU tells you where to look. Per-key counts tell you what to fix. Hit rate tells you whether the cache is doing its job overall, which is not the same question. A detector that cannot answer within the incident's time budget is a monitoring gap, even if its sample is statistically valid.",
  },
  { type: "sim", simId: "hot-key-detection" },
  { type: "experiment", experimentId: "predict-sample-lag" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One key took a large share of reads, and its hash slot placed all of that traffic on one primary. That shard's command queue grew, p99 rose, and client timeouts turned into Redis errors. The cluster average, the aggregate hit rate, and the database stayed healthy because the other shards were doing very little. The problem was a partition, not a shortage of aggregate capacity.",
  },
  {
    type: "p",
    text: "The detector was sampled. At 0.1%, it saw only a small fraction of the hot key's commands, so it needed more than a minute of traffic before it could attribute the load. Shard CPU and p99 were already critical. Lowering the sample did not change the traffic or the CPU; it changed the time to answer the question. The recovery preset lowered the key's share and raised sampling, so the shard recovered and the detector could confirm the key quickly.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ElastiCache: `EngineCPUUtilization`, `CPUUtilization`, `CurrConnections`, `CacheHits`, `CacheMisses`, `Evictions`, and `GetTypeCmds`, split by node or shard where the metric supports it.",
      "Redis: `INFO commandstats` for command-level rates, `SLOWLOG GET` for commands over the slowlog threshold, and `LATENCY HISTORY` for latency events. None of these is a per-key counter.",
      "Client or proxy: bounded top-K counters by key prefix or full key, sampled command counts, timeout counts, and connection-pool waits. The sample rate and the scaling factor must be visible on the dashboard.",
      "Traces: the Redis span is slow for one key while the database span is normal. A trace can name the key even when the metrics are sampled.",
      "Logs: timeout messages that repeat for the same key, and retry bursts from one service instance.",
      "Capacity: the hottest shard's CPU is the constraint. The cluster average and the number of shards are not.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare per-shard CPU and ops, then per-shard p99. If one shard stands out, find the key with the highest command count on that shard using a bounded top-K counter or a short, deliberate sample. Check whether the aggregate hit rate is masking the incident. Only then choose a mitigation.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm a hot shard, not a cluster-wide capacity problem: per-shard CPU, ops, p99, and the imbalance ratio.",
      "Protect the request path now: bound retries, set a client timeout below the request budget, and add a defined fallback.",
      "Attribute the key with the cheapest tool that fits the time budget: a client or proxy top-K counter, a temporary sample-rate increase, or a short trace sample.",
      "Reduce the key's load with the smallest change the product can tolerate: a local cache, key salting, or read replicas. Each moves the problem somewhere else, so verify the next bottleneck.",
      "Fix the instrumentation: keep a bounded per-key view, alert on shard imbalance, and document the sample rate and its error.",
      "Re-run at peak and verify the hottest shard, p99, errors, hit rate, and detection lag together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Per-key metrics cost memory and cardinality. A top-K counter with a bounded key space is cheaper than a label per key, but it can miss a key that enters late.",
      "A low sample rate is cheap and statistically unbiased, but it delays attribution and makes rare keys invisible. Raise it temporarily during an incident, then restore it.",
      "`MONITOR` gives complete command visibility at a cost that can change the incident. Use it for a short window, on one node, with a clear stop condition.",
      "Per-shard CPU localizes the problem but does not name the key. A detector that only reports shard heat is not enough for a hot-key runbook.",
      "Adding shards lowers the cluster average and leaves the hot shard's load unchanged. It can make the dashboard look better while the user experience stays the same.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-the-key",
    question:
      "Shard CPU is uneven but the dashboard only shows cluster averages. How do you find the key?",
    difficulty: 3,
    hints: [
      "Start with the dimension that already shows the skew.",
      "Per-key data is usually instrumentation, not a built-in Redis metric.",
    ],
    answer:
      "I would start with per-shard CPU, ops, and p99 to find the shard that is carrying the load. Then I would use a client-side or proxy top-K counter, or a sampled command stream, to rank keys on that shard. `INFO commandstats` is aggregated by command name, not by key, and `SLOWLOG` only shows commands over its threshold, so neither is a complete per-key view. `MONITOR` can show every command for a short window but has real overhead. I would also check traces and timeout logs for a repeated key, and confirm the skew is not a big key or a slot with many small keys.",
    followUps: [
      "What would you put on the dashboard permanently?",
      "How would you handle a key with a high-cardinality suffix?",
      "What would make you suspect a hot slot rather than a hot key?",
    ],
    redFlags: [
      "Adds shards before checking per-shard distribution.",
      "Treats `INFO commandstats` as a per-key counter.",
      "Runs `MONITOR` in production without a time limit.",
    ],
    rubric: [
      "Starts with per-shard evidence.",
      "Names a real per-key instrumentation path.",
      "States the cost of the sampling method.",
      "Separates a hot key from a hot slot.",
    ],
  },
  {
    id: "sampling-latency",
    question:
      "Per-key sampling is 1 in 10,000 and one key is 40% of traffic. How long until you can attribute it, and what do you do meanwhile?",
    difficulty: 3,
    hints: [
      "Estimate the sampled rate for the hot key, not the total rate.",
      "Do not wait for attribution to protect the shard.",
    ],
    answer:
      "If the key receives 40% of traffic, its sampled rate is 40% of the total divided by 10,000. For 80k reads per second that is 32,000 hot reads per second and about 3.2 sampled hot commands per second. Collecting a few thousand samples takes many minutes, which is too slow for an incident. Meanwhile I would use the per-shard CPU and p99 to localize the problem, raise sampling temporarily for that shard or key, and add a bounded top-K counter at the client or proxy. I would also protect the request path with a timeout and fallback before the attribution finishes.",
    followUps: [
      "How would you size the temporary sample?",
      "What is the risk of raising sampling during an incident?",
      "Would a trace sample be faster than a command counter?",
    ],
    redFlags: [
      "Uses the total request rate instead of the hot key's rate.",
      "Waits for per-key attribution before mitigating.",
      "Raises sampling without a cost or stop condition.",
    ],
    rubric: [
      "Computes the sampled hot-key rate.",
      "Explains the attribution delay.",
      "Protects the shard in parallel.",
      "Names a bounded fallback.",
    ],
  },
  {
    id: "aggregate-hit-rate",
    question:
      "Cache hit rate is 98%, cluster CPU is 35%, and p99 is 900ms. How can all three be true?",
    difficulty: 2,
    hints: [
      "A hit rate is a ratio over all requests.",
      "The cluster average is not the maximum.",
    ],
    answer:
      "The hit rate can stay high because the hot key's requests are a minority of all requests, and most requests hit their values. The cluster CPU can stay low because the other shards are lightly loaded. The p99 can still be 900ms because the one shard that owns the hot key is queueing. I would split CPU and p99 by shard, then look for the key that dominates that shard. The three numbers are not contradictory; they answer different questions.",
    followUps: [
      "Which metric would you page on?",
      "How would a read replica change the picture?",
      "What would make the hit rate fall as well?",
    ],
    redFlags: [
      "Concludes the cache is healthy from the hit rate alone.",
      "Blames the database without checking cache spans.",
      "Assumes the cluster average bounds the worst shard.",
    ],
    rubric: [
      "Explains dilution in the hit-rate ratio.",
      "Distinguishes average from maximum.",
      "Names per-shard evidence.",
      "States a next check.",
    ],
  },
  {
    id: "instrumentation-plan",
    question:
      "What would you instrument permanently for hot-key detection, and what would you keep sampled?",
    difficulty: 3,
    hints: [
      "Bound the cardinality of anything keyed by the full key.",
      "Alert on the signal that localizes, not only the one that names.",
    ],
    answer:
      "I would keep a bounded top-K counter per service instance or proxy, with a key prefix or a hashed key and a fixed maximum number of entries. I would emit per-shard CPU, ops, p99, and an imbalance ratio from the cache, and alert on the imbalance and the hottest shard. Full per-key counts and command streams would stay sampled, with the sample rate and scaling factor exported as metadata. Traces and logs would sample the slow or failing requests. That gives a cheap always-on localizer and a bounded way to name the key without turning every key into a metric label.",
    followUps: [
      "How would you prevent a top-K counter from leaking user data?",
      "What is the failure mode of a fixed-size top-K table?",
      "Which alert would you page on, and which would you ticket?",
    ],
    redFlags: [
      "Puts the full key in a metric label.",
      "Only instruments the aggregate hit rate.",
      "Keeps `MONITOR` running continuously.",
    ],
    rubric: [
      "Bounds per-key cardinality.",
      "Combines shard-level and key-level signals.",
      "States sample-rate metadata.",
      "Distinguishes paging from diagnosis.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show per-shard CPU, ops, p99, and errors, not only cluster averages.",
      "A bounded per-key counter or proxy view exists, and its sample rate is documented.",
      "The alert on shard imbalance is separate from the alert on cluster CPU.",
      "The client timeout is below the request budget, and the fallback path is tested.",
      "The team knows which keys are expected to be hot and why.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Localize with per-shard CPU and p99 before changing capacity.",
      "Attribute the key with the cheapest tool that fits the time budget.",
      "Protect the request path with bounded retries and a defined fallback.",
      "Watch the next bottleneck: database, replica CPU, or client connection pool.",
      "Record the detection method, sample rate, and time to attribution.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the hottest shard, p99, errors, and hit rate at peak.",
      "Keep or remove the temporary sampling change deliberately.",
      "Add the key pattern to the capacity review if it is expected to recur.",
      "Test the detector against a known hot key in staging.",
    ],
  },
];

const references = [
  {
    title: "Diagnosing latency issues",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Latency sources, slowlog, and the limits of command-level monitoring.",
  },
  {
    title: "Amazon ElastiCache best practices",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache monitoring, scaling, and client best practices.",
  },
  {
    title: "Redis cluster specification",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Hash-slot ownership and per-shard key distribution.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hot-key-detection": {
      model: hotKeyDetectionModel,
      presets,
      instructions:
        "Start healthy, apply Unattributed hot key, then lower the sample rate and watch detection lag grow while shard CPU stays critical. Use the shard heat map before the per-key view.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "heatmap"],
      note: "Illustrative model. Shard capacity is 30,000 ops/s, the detector target is 4,000 samples, and p99 is a teaching curve, not an ElastiCache guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-hot-key-sharding",
    "caching-key-salting",
    "caching-cluster-resharding",
    "foundations-percentiles",
  ],
};
