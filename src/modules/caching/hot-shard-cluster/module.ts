import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHARD_COUNT = 8;
const SHARD_CAPACITY = 30_000;
const TOTAL_SLOTS = 16_384;
const CO_LOCATED_OPS = 3;

const params = [
  {
    id: "totalRps",
    label: "Total request rate",
    min: 20_000,
    max: 200_000,
    step: 5_000,
    value: 60_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the cluster. Capacity is still set by the shard that owns the hot slot.",
    format: "rps" as const,
  },
  {
    id: "hotSlotShare",
    label: "Hot slot traffic share",
    min: 5,
    max: 70,
    step: 1,
    value: 10,
    unit: "%",
    group: "Traffic",
    help: "Share of requests that hash to one slot. The slot may contain one hot key and many co-located keys.",
    format: "percent" as const,
  },
  {
    id: "slotsOnHotShard",
    label: "Slots on the hot shard",
    min: 1,
    max: 2_048,
    step: 1,
    value: 2_048,
    unit: " slots",
    group: "Resharding",
    help: "How many of the hot shard's 2,048 balanced slots remain after resharding. Reducing this moves other slots; it does not split the hot slot.",
    format: "count" as const,
    scale: "log" as const,
  },
  {
    id: "coLocatedKeys",
    label: "Keys co-located in the hot slot",
    min: 0,
    max: 1_000,
    step: 10,
    value: 400,
    unit: " keys",
    group: "Resharding",
    help: "Other keys forced into the same slot by the hash or by a hash tag. They move with the hot slot and add load to its shard.",
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
  slots: number;
}

interface Computed {
  totalRps: number;
  hotSlotShare: number;
  slotsOnHotShard: number;
  coLocatedKeys: number;
  hotOps: number;
  hotSlotOps: number;
  coLocatedOps: number;
  shards: ShardState[];
  maxCpu: number;
  avgCpu: number;
  imbalance: number;
  p99: number;
  slotsMoved: number;
}

function p99For(cpu: number): number {
  if (cpu >= 100) return 500;
  return Math.min(500, 1.5 + (45 * (cpu / 100) ** 5) / Math.max(0.05, 1.05 - cpu / 100));
}

function compute(p: Params): Computed {
  const totalRps = Math.max(1, num(p, "totalRps", 60_000));
  const hotSlotShare = clamp(num(p, "hotSlotShare", 10) / 100, 0.05, 0.7);
  const slotsOnHotShard = clamp(Math.round(num(p, "slotsOnHotShard", 2_048)), 1, 2_048);
  const coLocatedKeys = Math.max(0, Math.round(num(p, "coLocatedKeys", 400)));
  const hotOps = totalRps * hotSlotShare;
  const otherOps = totalRps - hotOps;
  const slotFraction = slotsOnHotShard / TOTAL_SLOTS;
  const coLocatedOps = Math.min(otherOps, coLocatedKeys * CO_LOCATED_OPS);
  const remainingOtherOps = otherOps - coLocatedOps;
  const hotBaseline = remainingOtherOps * slotFraction;
  const otherShardOps = (remainingOtherOps * (1 - slotFraction)) / (SHARD_COUNT - 1);
  const hotShardOps = hotOps + coLocatedOps + hotBaseline;
  const otherSlots = (TOTAL_SLOTS - slotsOnHotShard) / (SHARD_COUNT - 1);
  const shards: ShardState[] = Array.from({ length: SHARD_COUNT }, (_, index) => {
    const ops = index === 0 ? hotShardOps : otherShardOps;
    const cpu = (ops / SHARD_CAPACITY) * 100;
    return {
      index,
      cpu,
      p99: p99For(cpu),
      ops,
      slots: index === 0 ? slotsOnHotShard : otherSlots,
    };
  });
  const maxCpu = Math.max(...shards.map((shard) => shard.cpu));
  const avgCpu = (totalRps / SHARD_COUNT / SHARD_CAPACITY) * 100;
  return {
    totalRps,
    hotSlotShare,
    slotsOnHotShard,
    coLocatedKeys,
    hotOps,
    hotSlotOps: hotOps + coLocatedOps,
    coLocatedOps,
    shards,
    maxCpu,
    avgCpu,
    imbalance: maxCpu / Math.max(0.1, avgCpu),
    p99: Math.max(...shards.map((shard) => shard.p99)),
    slotsMoved: 2_048 - slotsOnHotShard,
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
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 9)) / 2.5);
  const seeds: [string, number, number][] = [
    ["hot-shard-cpu", values.maxCpu, 3],
    ["redis-p99", values.p99, 4],
    ["cluster-avg-cpu", values.avgCpu, 0.8],
    ["hot-slot-ops", values.hotSlotOps, 250],
    ["shard-imbalance", values.imbalance, 0.08],
    ["slots-on-hot-shard", values.slotsOnHotShard, 1],
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
  const hotCpuHealth = healthFor(values.maxCpu);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(values.totalRps)} rps`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Product service",
        kind: "service",
        health: values.totalRps > 160_000 ? "warn" : "ok",
        utilization: clamp(values.totalRps / 200_000),
        throughput: values.totalRps,
        sublabel: `${formatCount(values.totalRps)} rps`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis Cluster",
        kind: "cache",
        health: hotCpuHealth,
        utilization: values.maxCpu / 100,
        throughput: values.totalRps,
        sublabel: `${formatCount(TOTAL_SLOTS)} slots across ${SHARD_COUNT} primaries`,
        detail: `The hottest shard owns ${formatCount(values.slotsOnHotShard)} slots and runs at ${formatCpu(values.maxCpu)} CPU. Cluster average is ${formatCpu(values.avgCpu)}. Illustrative capacity: ${formatCount(SHARD_CAPACITY)} ops/s per shard.`,
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
        sublabel: shard.index === 0 ? "hot slot owner" : `${formatCount(shard.slots)} slots`,
        detail:
          shard.index === 0
            ? `${formatCpu(shard.cpu)} CPU, ${formatCount(shard.ops)} ops/s. Owns ${formatCount(shard.slots)} of ${formatCount(TOTAL_SLOTS)} slots, including the hot slot and ${formatCount(values.coLocatedKeys)} co-located keys.`
            : `${formatCpu(shard.cpu)} CPU, ${formatCount(shard.ops)} ops/s. Owns about ${formatCount(shard.slots)} of ${formatCount(TOTAL_SLOTS)} slots.`,
        meta: {
          view: "shards",
          cpu: shard.cpu,
          memory: 4 + values.totalRps / 320_000,
          p99: shard.p99,
          slots: Math.round(shard.slots),
          hot: shard.index === 0 && values.hotSlotShare >= 0.25 ? 1 : 0,
        },
      })),
    ],
    edges: [
      edge("client-service", "client", "service", values.totalRps / 200_000),
      edge("service-redis", "service", "redis", 1, hotCpuHealth),
    ],
    metrics: [
      metric("hot-shard-cpu", "Hot shard CPU", values.maxCpu, "%", 70, 85, "percent"),
      metric("redis-p99", "Redis p99", values.p99, "ms", 40, 120, "ms"),
      metric("cluster-avg-cpu", "Cluster average CPU", values.avgCpu, "%", undefined, undefined, "percent"),
      metric("hot-slot-ops", "Hot slot ops", values.hotSlotOps, " rps", undefined, undefined, "rps"),
      metric("shard-imbalance", "Shard imbalance", values.imbalance, "x", 2.5, 4, "number"),
      metric("slots-on-hot-shard", "Slots on hot shard", values.slotsOnHotShard, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `Hottest shard ${formatCpu(values.maxCpu)} CPU; cluster average ${formatCpu(values.avgCpu)}; hot slot carries ${formatCount(values.hotSlotOps)} ops/s.`,
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
    title: "The shard that owns the hot slot is saturated",
    cause:
      "One hash slot carries a large share of the traffic. The slot is owned by one primary, so its load lands on one shard even when the rest of the cluster has capacity.",
    fix:
      "Reduce the load inside the slot. Resharding can move the slot to another shard, but it moves the same traffic and cannot split one key. Salting, a local cache, or read replicas change the load itself.",
    checkFirst: [
      "Confirm the hot shard and its slot count, not only the cluster average.",
      "Check whether the hot slot moved during the last reshard and whether the new owner is now hot.",
      "Look for one key or a hash-tagged key family inside the slot.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Redis p99 is set by the hot-slot shard",
    cause:
      "Queueing on one shard raises p99 while the other shards remain fast. A cluster-wide p99 can still look moderate because most requests never touch the hot slot.",
    fix:
      "Split p99 by shard and check the hot slot's op rate. Reduce the ops inside the slot rather than moving the same slot to an equally sized shard.",
    checkFirst: [
      "Graph p99 per shard or node.",
      "Compare the hot slot's op rate with the shard's capacity.",
      "Check client timeouts and retries for the same window.",
    ],
  },
  {
    id: "shard-imbalance",
    metricId: "shard-imbalance",
    warn: 2.5,
    crit: 4,
    title: "One shard carries several times the cluster average",
    cause:
      "Slot placement is uneven by traffic, not by slot count. A shard with 2,048 slots can be idle while a shard with one hot slot is saturated.",
    fix:
      "Investigate the slot and key distribution before rebalancing. Moving the hot slot changes which shard is hot; it does not reduce the slot's traffic.",
    checkFirst: [
      "Compare ops per shard, not slots per shard.",
      "Check whether the hot slot has a large number of co-located keys.",
      "Check whether a recent reshard moved the hot slot or only its neighbors.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const hotShardClusterModel: SimModel = {
  id: "caching-hot-shard-cluster",
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
    if (values.slotsOnHotShard <= 8 && values.hotSlotShare >= 0.4 && frame.flags.hotSlotExplained !== 1) {
      pushEvent(next, {
        id: "hot-slot-still-hot",
        at: frame.t,
        severity: "warn",
        title: "Resharding moved the neighbors, not the load",
        detail: `The hot shard still owns the hot slot and runs at ${formatCpu(values.maxCpu)} CPU after ${formatCount(values.slotsMoved)} other slots moved away. The slot's ${formatCount(values.hotSlotOps)} ops/s did not change.`,
        nodeId: "shard-0",
        metricId: "hot-shard-cpu",
      });
      next.flags.hotSlotExplained = 1;
    }
    if (values.slotsOnHotShard > 8) next.flags.hotSlotExplained = 0;
    next.summary = `Hottest shard ${formatCpu(values.maxCpu)} CPU; cluster average ${formatCpu(values.avgCpu)}; ${formatCount(values.slotsOnHotShard)} slots on the hot shard; hot slot carries ${formatCount(values.hotSlotOps)} ops/s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The hot shard holds ${formatCount(values.slotsOnHotShard)} of 16,384 slots and runs at ${formatCpu(values.maxCpu)} CPU. Slot count is not load: ${formatCount(values.hotOps)} of its ops/s come from one slot.`,
    );
    items.push(
      `Resharding moved ${formatCount(values.slotsMoved)} other slots away. The hot slot still carries ${formatCount(values.hotSlotOps)} ops/s, ${values.slotsMoved > 0 ? "so the shard is still the constraint" : "and is the reason the shard is the constraint"}.`,
    );
    items.push(
      `The cluster average is ${formatCpu(values.avgCpu)} and the imbalance ratio is ${values.imbalance.toFixed(1)}x. The average says there is free capacity; the maximum says where it is needed.`,
    );
    items.push(
      `The slot also contains ${formatCount(values.coLocatedKeys)} other keys. Moving the slot moves those keys with it, which is collateral for any hash-tagged key family.`,
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
    description: "A balanced slot map and a modest hot slot at 10% of traffic.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "More traffic and a 15% hot slot. The hot shard is saturated but not failing.",
    tone: "warn",
    params: defaults({ totalRps: 90_000, hotSlotShare: 15, slotsOnHotShard: 2_048, coLocatedKeys: 300 }),
  },
  {
    id: "failure",
    label: "Hot slot",
    description: "One slot takes 45% of 80k requests. The owning shard fails while seven shards have room.",
    tone: "crit",
    params: defaults({ totalRps: 80_000, hotSlotShare: 45, slotsOnHotShard: 2_048, coLocatedKeys: 400 }),
  },
  {
    id: "resharded",
    label: "Resharded neighbors",
    description: "Every other slot moved off the hot shard. The hot slot remains and the shard still fails.",
    tone: "crit",
    params: defaults({ totalRps: 80_000, hotSlotShare: 45, slotsOnHotShard: 1, coLocatedKeys: 400 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Traffic inside the hot slot is reduced and the owning shard returns below its warning threshold.",
    tone: "ok",
    params: defaults({ totalRps: 70_000, hotSlotShare: 16, slotsOnHotShard: 2_048, coLocatedKeys: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-reshard-effect",
  title: "Predict what resharding changes",
  simId: "hot-shard-cluster",
  question:
    "You move every slot except the hot one off its shard. What happens to the hottest shard's CPU?",
  prediction: {
    options: [
      { id: "still-hot", label: "It stays above the critical threshold because the hot slot still owns the traffic." },
      { id: "fixed", label: "It falls below the warning threshold because the shard owns only one slot." },
      { id: "average", label: "The cluster average rises above the critical threshold." },
      { id: "neighbors", label: "The other seven shards saturate instead." },
    ],
    correctOptionId: "still-hot",
    explanation:
      "Resharding changes which shard owns a slot; it does not split the traffic inside the slot. Moving every other slot removes only the hot shard's baseline share of the remaining keys. The hot slot still carries 36k ops/s from the hot key plus about 1.2k from co-located keys, which is above the shard's 30k teaching capacity. The shard stays critical, the cluster average stays low, and the other shards stay lightly loaded.",
  },
  setup: defaults({ totalRps: 80_000, hotSlotShare: 45, slotsOnHotShard: 1, coLocatedKeys: 400 }),
  runFor: 20,
  observe: [
    "The hottest shard is still above 120% CPU after 2,047 slots moved away.",
    "The cluster average stays near 34%, so the cluster still has free capacity.",
    "The hot slot still carries about 37k ops/s; its load did not change.",
    "Redis p99 stays at the model's 500ms cap.",
    "The other seven shards remain near 21% CPU.",
  ],
  explain:
    "A hash slot is the unit of ownership. Moving it moves every key in it, including the hot key and any co-located keys. Resharding cannot split one key across shards, and moving the slot to another equally sized shard just moves the hot shard. To reduce the load, change the key's distribution or serve its reads elsewhere: salt the key, add a local cache, or use read replicas.",
  fix: defaults({ totalRps: 70_000, hotSlotShare: 16, slotsOnHotShard: 2_048, coLocatedKeys: 300 }),
  debrief:
    "The reshard made the slot map look tidier and barely moved the hottest shard's CPU. The hot slot's traffic was the constraint all along. The recovery preset reduces the traffic inside the slot, which is the only change that lowers the shard's CPU. If the slot must keep its traffic, the next step is key salting or a read-side cache, not another reshard.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis Cluster divides the key space into 16,384 hash slots. A key's slot is CRC16(key) modulo 16,384. Each primary owns a subset of slots, and every slot is owned by exactly one primary at a time. A slot can contain many keys. Hash tags change the hash input: in `user:{42}:profile` and `user:{42}:account`, only `42` is hashed, so both keys land in the same slot.",
  },
  {
    type: "p",
    text: "Resharding moves slots between primaries. The keys in a moved slot move with it, and clients follow redirects while the migration runs. That makes resharding the right tool for uneven slot counts and the wrong tool for a hot key. A hot key occupies one slot. Moving that slot changes which shard is hot; it does not reduce the key's traffic or split it across shards. A shard with 2,048 quiet slots can be idle while a shard with one hot slot is saturated.",
  },
  {
    type: "p",
    text: "Co-located keys make the problem harder. If a hash tag forces a family of keys into one slot, moving the slot moves the whole family. The destination shard inherits both the hot key and its neighbors. If the tag is part of the application's data model, the fix is a key-design change, not a reshard.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Operation", "What it changes", "What it does not change"],
    rows: [
      ["Move a quiet slot", "Which shard owns that slot and its keys", "The hot slot's traffic"],
      ["Move the hot slot", "Which shard is hot; all keys in the slot move together", "The ops/s inside the slot"],
      ["Add a primary", "Aggregate slot capacity and the number of shards", "The slot that owns the hot key"],
      ["Split the hot key", "The number of slots and shards that carry its traffic", "Requires a new key scheme and a migration"],
      ["Add a local cache", "How many reads reach Redis", "Per-instance freshness"],
    ],
  },
  {
    type: "p",
    text: "The slot map is not a load map. A balanced slot count says each shard owns about the same number of slots; it says nothing about how many requests each slot receives. The request path is client, service, cluster, then the shard that owns the slot. During a reshard, the source and target exchange redirects, but the total traffic does not change. The capacity question is always about the maximum shard, not the average or the slot count.",
  },
  {
    type: "p",
    text: "This module models eight primaries with 16,384 slots and an illustrative capacity of 30,000 ops/s per shard. The slot count is real Redis Cluster behavior; the capacity, latency curve, and request rates are teaching values, not ElastiCache limits. The point is the ownership boundary: a slot is indivisible, so a hot key inside it is indivisible too.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot shard CPU: the maximum across the eight primaries, with warnings at 70% and 85%.",
      "Cluster average CPU and shard imbalance: why the cluster can look healthy while one shard fails.",
      "Hot slot ops: the traffic owned by the one slot, independent of how many slots the shard owns.",
      "Slots on the hot shard: move the slider down and watch the baseline fall while the hot load stays.",
      "Redis p99: the queueing consequence on the hot shard.",
      "A per-shard heat map: the slot owner's load over time.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Hot slot. Note the hot shard CPU and the cluster average together. Apply Resharded neighbors: the hot shard keeps only one slot, but the CPU stays critical. Run the guided experiment, then use Recovery to see the only change that lowers the maximum. Watch the hot slot ops metric, not the slot count.",
  },
  {
    type: "p",
    text: "The first question is not whether the slot map is balanced. It is whether the hottest shard has enough capacity for the slot it owns. If the answer is no, the fix has to change the traffic inside the slot or serve it from somewhere else. Resharding can buy headroom for the other slots, but it cannot make one slot smaller.",
  },
  { type: "sim", simId: "hot-shard-cluster" },
  { type: "experiment", experimentId: "predict-reshard-effect" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One hash slot carried a large share of the traffic, and its owner shard ran out of capacity. The other seven shards had room, so the cluster average stayed near a third of the maximum. Moving every other slot off the hot shard lowered its baseline slightly, but the hot slot still carried tens of thousands of ops per second. The reshard changed the slot count, not the load.",
  },
  {
    type: "p",
    text: "The hot slot also held hundreds of co-located keys. Moving the slot would have moved all of them, and moving the hot key alone is not possible: the key has exactly one slot. The only fixes that reduce the maximum are the ones that change the key's distribution or keep its reads out of Redis. The recovery preset reduced the traffic inside the slot and brought the shard below its warning threshold.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ElastiCache or Redis Cluster: per-node `EngineCPUUtilization`, `CPUUtilization`, `CurrConnections`, `GetTypeCmds`, and `CacheHits`/`CacheMisses`, with the shard or node dimension.",
      "Cluster: `CLUSTER SLOTS` or `CLUSTER SHARDS` for ownership, `CLUSTER NODES` for slot ranges, and `redis-cli --cluster check` for coverage and slot balance.",
      "Key distribution: `CLUSTER COUNTKEYSINSLOT` and `CLUSTER GETKEYSINSLOT` for one slot, plus a sampled or client-side per-key view. These tell you how many keys are in the slot, not how many requests each key gets.",
      "Latency: per-shard p99, client timeouts, and `MOVED`/`ASK` counts during a reshard.",
      "Logs: redirects, cross-slot errors, and timeout messages tied to one shard.",
      "Traces: the Redis span is slow on one key while other shard spans are normal.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare per-shard ops and CPU, then find which slot owns the hot key. Check whether the hot shard's slot count changed recently and whether the hot slot moved. If the slot still owns the traffic, resharding again will only move the problem.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the hot slot and its owner from per-slot and per-shard data, not from the slot count.",
      "Check whether the hot key is alone in the slot or shares it with a hash-tagged family.",
      "Protect the request path with a bounded timeout and fallback before changing the cluster layout.",
      "Reduce the slot's traffic: a local cache for repeated reads, key salting for a hot counter or object, or read replicas for read-heavy access.",
      "If you move the slot, move it to a shard with real headroom and watch the new owner; the load moves with the slot.",
      "Re-run at peak and verify the maximum shard CPU, p99, redirects, and the hot slot's op rate together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Resharding is online and does not stop the cluster, but it adds redirects and migration work; it does not reduce the hot slot's traffic.",
      "Moving the hot slot to a larger or quieter shard buys time, but the slot remains a single unit and the next growth spurt returns.",
      "Salting splits the key into multiple slots and shards, but every reader must fan out and the key scheme needs a migration.",
      "A local cache removes reads from Redis but introduces per-instance staleness and invalidation work.",
      "Hash tags are useful for multi-key operations and dangerous for hot keys: they turn several keys into one indivisible slot.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "move-the-slot",
    question:
      "One slot is hot while the cluster has free capacity. Can you move the slot, and does that fix it?",
    difficulty: 3,
    hints: [
      "A slot is the unit of ownership.",
      "Moving a slot moves every key in it.",
    ],
    answer:
      "I can move the slot with a reshard, and clients will follow the redirects while it happens. That changes which shard owns the slot and moves every key in it, including the hot key. It does not reduce the slot's traffic or split the key. If the destination shard has the same capacity, the hot shard becomes the destination shard. The fix is to reduce the traffic inside the slot or serve it elsewhere, not to rearrange ownership.",
    followUps: [
      "What if the destination has twice the capacity?",
      "How would co-located keys change the move?",
      "What would you monitor during the reshard?",
    ],
    redFlags: [
      "Says resharding splits the key.",
      "Ignores co-located keys.",
      "Assumes a slot move reduces total ops.",
    ],
    rubric: [
      "Explains slot ownership.",
      "Separates moving from splitting.",
      "Names the destination-shard risk.",
      "States the real fix.",
    ],
  },
  {
    id: "why-more-shards",
    question:
      "Why does adding primaries not fix a single hot key in Redis Cluster?",
    difficulty: 2,
    hints: [
      "A key maps to exactly one slot.",
      "Adding shards changes aggregate capacity, not the slot owner.",
    ],
    answer:
      "A key maps to one of 16,384 slots, and one primary owns that slot. Adding primaries increases the number of slots and the cluster's aggregate capacity, but the hot key still lives in its original slot. A reshard can move the slot, but the key's traffic moves with it. The key is only split if the application changes the key scheme, for example by salting it into several keys in different slots.",
    followUps: [
      "When would adding shards still help?",
      "What does `CLUSTER COUNTKEYSINSLOT` tell you?",
      "How would a hash tag change the answer?",
    ],
    redFlags: [
      "Says more shards spread one key.",
      "Ignores hash slots.",
      "Confuses slot count with load.",
    ],
    rubric: [
      "Explains 16,384 slots.",
      "Distinguishes aggregate from hot-slot capacity.",
      "Mentions resharding and key splitting.",
    ],
  },
  {
    id: "hash-tag-collateral",
    question:
      "A hot slot contains a hash-tagged family of keys. What happens when you move that slot?",
    difficulty: 3,
    hints: [
      "Hash tags force co-location.",
      "The slot moves as one unit.",
    ],
    answer:
      "Every key in the slot moves together, including the hot key and the rest of the tagged family. That is collateral: the destination shard inherits all of them, and any multi-key operation that relies on the tag keeps working because the keys stay in the same slot. The move does not separate the hot key from its neighbors. If the family is the problem, the fix is to redesign the tag or split the data model, not to reshard the slot.",
    followUps: [
      "What breaks if you change the tag?",
      "How would you migrate a multi-key operation?",
      "Can you move one key out of a slot?",
    ],
    redFlags: [
      "Assumes only the hot key moves.",
      "Breaks multi-key atomicity.",
      "Changes the tag without a dual-read plan.",
    ],
    rubric: [
      "Explains co-location.",
      "Names the collateral movement.",
      "Preserves multi-key correctness.",
      "States the migration cost.",
    ],
  },
  {
    id: "reshard-no-effect",
    question:
      "A reshard moved 2,000 slots off the hot shard and CPU is still 120%. What do you check?",
    difficulty: 3,
    hints: [
      "Did the hot slot itself move?",
      "CPU follows ops, not slot count.",
    ],
    answer:
      "I would check whether the hot slot was one of the moved slots. If it was not, the shard still owns the hot key and the reshard only removed baseline traffic from other slots. If it was moved, the new owner is now hot and the old shard should be quiet; I would check the destination's capacity and whether clients are following redirects. In both cases I would graph ops per slot or per key, not slots per shard, and compare the hot slot's ops with the shard's capacity.",
    followUps: [
      "What if the hot shard is quiet but p99 is still high?",
      "How would you confirm the new owner?",
      "What would you do before another reshard?",
    ],
    redFlags: [
      "Assumes slot count equals load.",
      "Reshards again without checking the hot slot.",
      "Ignores redirects and client errors.",
    ],
    rubric: [
      "Checks whether the hot slot moved.",
      "Uses ops per slot or key.",
      "Considers the destination shard.",
      "Avoids a blind second reshard.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The cluster dashboard shows per-shard CPU, ops, p99, and slot counts, not only the cluster average.",
      "The slot map and any hash-tagged key families are documented.",
      "A per-key or per-slot view exists for the keys that are expected to be hot.",
      "The reshard runbook covers redirect handling and a rollback target.",
      "The team knows that a slot move changes ownership, not traffic.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the hot slot and its owner before changing the slot map.",
      "Check whether the hot key is alone or shares the slot with a tagged family.",
      "Protect clients with a timeout and a bounded fallback.",
      "If resharding, move the hot slot deliberately and watch the new owner.",
      "Watch p99 and redirects, not only the slot balance.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the maximum shard CPU and p99 at peak.",
      "Document whether the hot slot moved and where it landed.",
      "Add the key pattern to the capacity review.",
      "Test the next reshard against a redirect-aware client.",
    ],
  },
];

const references = [
  {
    title: "Redis cluster specification",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Hash slots, slot ownership, hash tags, and redirection.",
  },
  {
    title: "Scale with Redis Cluster",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/scaling/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Resharding, cluster operations, and failover behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hot-shard-cluster": {
      model: hotShardClusterModel,
      presets,
      instructions:
        "Start healthy, apply Hot slot, then Resharded neighbors. Compare the hot shard CPU with the cluster average and the hot slot ops before and after the reshard.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "heatmap"],
      note: "Illustrative model. Eight primaries, 16,384 slots, and 30,000 ops/s per shard. Slot behavior is real Redis Cluster; capacities and latency are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-hot-key-detection",
    "caching-hot-key-sharding",
    "caching-key-salting",
    "caching-cluster-resharding",
  ],
};
