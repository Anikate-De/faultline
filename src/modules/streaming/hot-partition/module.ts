import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOT_INDEX = 2;
const MAX_LAG = 5_000_000;

const params = [
  {
    id: "incomingRate",
    label: "Incoming records",
    min: 2_000,
    max: 120_000,
    step: 2_000,
    value: 24_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records arriving at the topic before partitioning.",
    format: "rps" as const,
  },
  {
    id: "hotKeyShare",
    label: "Hottest key share",
    min: 0,
    max: 80,
    step: 1,
    value: 5,
    unit: "%",
    group: "Traffic",
    help: "Share of records produced with one key. This is the concentration that creates the hot partition.",
    format: "percent" as const,
  },
  {
    id: "partitionCount",
    label: "Partitions",
    min: 4,
    max: 12,
    step: 1,
    value: 8,
    unit: "",
    group: "Topic",
    help: "Partition count. One consumer per partition per group, so this also caps consumer parallelism.",
    format: "count" as const,
  },
  {
    id: "consumerRate",
    label: "Consumer throughput",
    min: 2_000,
    max: 20_000,
    step: 500,
    value: 8_000,
    unit: " rec/s",
    group: "Consumers",
    help: "Records per second one partition consumer can process while keeping its downstream write rate stable.",
    format: "rps" as const,
  },
  {
    id: "saltFanout",
    label: "Key salt fan-out",
    min: 1,
    max: 12,
    step: 1,
    value: 1,
    unit: " keys",
    group: "Mitigation",
    help: "Deterministic subkeys the hot key is split into. Effective fan-out is capped by the partition count. Readers must merge them, and per-entity order is no longer total.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface PartitionState {
  index: number;
  load: number;
  utilization: number;
  lag: number;
  hot: boolean;
}

interface Computed {
  incoming: number;
  hotShare: number;
  partitionCount: number;
  consumerRate: number;
  salt: number;
  partitions: PartitionState[];
  maxUtilization: number;
  maxLoad: number;
  hotLag: number;
  totalLag: number;
  skew: number;
  delay: number;
}

function compute(p: Params, lags: number[]): Computed {
  const incoming = Math.max(1, num(p, "incomingRate", 24_000));
  const hotShare = clamp(num(p, "hotKeyShare", 5) / 100, 0, 1);
  const partitionCount = Math.max(2, Math.round(num(p, "partitionCount", 8)));
  const consumerRate = Math.max(100, num(p, "consumerRate", 8_000));
  const salt = Math.max(1, Math.min(partitionCount, Math.round(num(p, "saltFanout", 1))));
  const hotLoad = incoming * hotShare;
  const otherLoad = incoming - hotLoad;
  const base = otherLoad / partitionCount;
  const hotIndex = Math.min(HOT_INDEX, partitionCount - 1);
  const targets = new Set(Array.from({ length: salt }, (_, index) => (hotIndex + index) % partitionCount));
  const perSalt = hotLoad / salt;
  const partitions: PartitionState[] = Array.from({ length: partitionCount }, (_, index) => {
    const load = base + (targets.has(index) ? perSalt : 0);
    const utilization = load / consumerRate;
    return {
      index,
      load,
      utilization,
      lag: Math.max(0, lags[index] ?? 0),
      hot: targets.has(index) && salt === 1 && hotShare >= 0.25,
    };
  });
  const maxUtilization = Math.max(...partitions.map((partition) => partition.utilization));
  const maxLoad = Math.max(...partitions.map((partition) => partition.load));
  const hotLag = Math.max(...partitions.map((partition) => partition.lag));
  const totalLag = partitions.reduce((sum, partition) => sum + partition.lag, 0);
  return {
    incoming,
    hotShare,
    partitionCount,
    consumerRate,
    salt,
    partitions,
    maxUtilization,
    maxLoad,
    hotLag,
    totalLag,
    skew: maxLoad / Math.max(1, incoming / partitionCount),
    delay: hotLag > 0 ? Math.min(300_000, (hotLag / consumerRate) * 1000) : 12,
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 0.85) return "crit";
  if (utilization >= 0.7) return "warn";
  return "ok";
}

function readLags(value: unknown, count: number): number[] {
  if (typeof value !== "string") return Array.from({ length: count }, () => 0);
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return Array.from({ length: count }, () => 0);
    return Array.from({ length: count }, (_, index) => {
      const item = parsed[index];
      return typeof item === "number" && Number.isFinite(item) ? Math.max(0, item) : 0;
    });
  } catch {
    return Array.from({ length: count }, () => 0);
  }
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.96 + 0.06 * Math.sin((offset + (seed % 9)) / 2.7);
  const metricSeed: [string, number, number][] = [
    ["hot-partition-load", values.maxUtilization * 100, 3],
    ["hot-partition-lag", values.hotLag, 0.2],
    ["queueDepth", values.totalLag, 0.2],
    ["delivery-delay", values.delay, 0.4],
    ["partition-skew", values.skew, 0.05],
    ["incoming-rate", values.incoming, 400],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  for (const partition of values.partitions) {
    frame.series[`load.partition-${partition.index}`] = Array.from({ length }, (_, index) =>
      Math.max(0, partition.utilization * 100 * jitter(index + partition.index)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, lags: number[]): SimFrame {
  const values = compute(p, lags);
  const hottest = values.partitions.reduce(
    (best, partition) => (partition.utilization > best.utilization ? partition : best),
    values.partitions[0],
  );
  const hotHealth = healthFor(values.maxUtilization);
  const producerHealth = values.maxUtilization >= 1 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Orders producer",
        kind: "service",
        health: producerHealth,
        utilization: clamp(values.incoming / (values.partitionCount * values.consumerRate)),
        throughput: values.incoming,
        sublabel: `${Math.round(values.incoming).toLocaleString("en-US")} rec/s`,
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "stream",
        health: hotHealth,
        throughput: values.incoming,
        sublabel: `${values.partitionCount} partitions · key order_id`,
        detail: `Hottest key is ${(values.hotShare * 100).toFixed(0)}% of records. ${values.salt === 1 ? "One key, one partition." : `Salted across ${values.salt} keys.`}`,
        meta: { view: "flow" },
      },
      ...values.partitions.map((partition) => ({
        id: `partition-${partition.index}`,
        label: `partition-${partition.index}`,
        kind: "worker" as const,
        role: "shard" as const,
        health: healthFor(partition.utilization),
        utilization: Math.min(1, partition.utilization),
        throughput: partition.load,
        capacity: values.consumerRate,
        sublabel: `${(partition.utilization * 100).toFixed(0)}% · lag ${Math.round(partition.lag).toLocaleString("en-US")}`,
        detail: `Partition ${partition.index} receives ${Math.round(partition.load).toLocaleString("en-US")} rec/s against a consumer capacity of ${Math.round(values.consumerRate).toLocaleString("en-US")} rec/s. Lag ${Math.round(partition.lag).toLocaleString("en-US")} records.`,
        meta: {
          partition: partition.index,
          load: partition.load,
          loadPct: partition.utilization * 100,
          lag: partition.lag,
          hot: partition.hot ? 1 : 0,
        },
      })),
    ],
    edges: [
      edge("producer-topic", "producer", "topic", values.incoming / (values.partitionCount * values.consumerRate), producerHealth),
      ...values.partitions.map((partition) =>
        edge(
          `topic-partition-${partition.index}`,
          "topic",
          `partition-${partition.index}`,
          clamp(partition.load / Math.max(1, values.incoming)),
          healthFor(partition.utilization),
        ),
      ),
    ],
    metrics: [
      metric("hot-partition-load", "Hot partition load", values.maxUtilization * 100, "%", 70, 85, "percent"),
      metric("hot-partition-lag", "Hot partition lag", values.hotLag, " records", 10_000, 50_000, "count"),
      metric("queueDepth", "Topic lag", values.totalLag, " records", undefined, undefined, "count"),
      metric("delivery-delay", "Delivery delay", values.delay, "ms", 2_000, 10_000, "ms"),
      metric("partition-skew", "Partition skew", values.skew, "x", 2, 4, "number"),
      metric("incoming-rate", "Incoming records", values.incoming, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      lagJson: JSON.stringify(values.partitions.map((partition) => partition.lag)),
      hotIndex: Math.min(HOT_INDEX, values.partitionCount - 1),
      salt: values.salt,
      paramsKey: JSON.stringify(p),
    },
    summary: `Partition ${hottest.index} at ${(values.maxUtilization * 100).toFixed(0)}% of consumer capacity; ${Math.round(values.hotLag).toLocaleString("en-US")} records behind on that partition.`,
  };
}

function seedFrame(p: Params, seed: number, lags: number[]): SimFrame {
  const frame = buildFrame(p, seed, lags);
  seedSeries(frame, compute(p, lags), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-partition-load",
    metricId: "hot-partition-load",
    warn: 70,
    crit: 85,
    title: "The hottest partition is beyond its consumer capacity",
    cause:
      "One key received a large share of records and hashed to one partition. The other partitions have spare capacity, so the topic average hides the saturation.",
    fix:
      "Change the key distribution, not the consumer count. Salt the key, redesign it so the hot entity is split by a documented subkey, or split the event. Add partitions only alongside a key change and an ordering plan.",
    checkFirst: [
      "Compare per-partition throughput and lag, not the topic total.",
      "Find the key or key pattern that dominates the hot partition.",
      "Check whether the consumer group already has more members than partitions.",
    ],
  },
  {
    id: "hot-partition-lag",
    metricId: "hot-partition-lag",
    warn: 10_000,
    crit: 50_000,
    title: "Consumer lag is concentrated on one partition",
    cause:
      "The hot partition is receiving records faster than its single consumer can process them. Kafka assigns one partition to one consumer in a group, so the consumer is the partition's ceiling.",
    fix:
      "Reduce records per second on that partition by changing the key, or increase the partition's processing capacity. Adding consumers does nothing while every partition is already assigned.",
    checkFirst: [
      "Graph lag by partition and by consumer member.",
      "Check whether the hot consumer is CPU-bound, I/O-bound, or waiting on a downstream call.",
      "Check whether lag grows in step with the hot key's produce rate.",
    ],
  },
  {
    id: "delivery-delay",
    metricId: "delivery-delay",
    warn: 2_000,
    crit: 10_000,
    title: "Delivery delay exceeds the freshness budget",
    cause:
      "Lag divided by the partition's consumption rate is the time a new record waits before processing. A large backlog on one partition becomes user-visible staleness even when other partitions are current.",
    fix:
      "Drain the hot partition by reducing its input or increasing its processing rate. Verify the freshness budget per key, not as a topic average.",
    checkFirst: [
      "Check the age of the newest processed record, not only message count.",
      "Identify which product surfaces depend on the hot key.",
      "Check whether retries or downstream timeouts are slowing the consumer.",
    ],
  },
  {
    id: "partition-skew",
    metricId: "partition-skew",
    warn: 2,
    crit: 4,
    title: "Partition load is skewed from the average",
    cause:
      "A small number of keys owns most of the records. Skew is the early signal; saturation and lag follow once the hottest partition passes its consumer capacity.",
    fix:
      "Treat skew as a key-design signal. Measure the key distribution, then choose a key change whose ordering cost the consumers can absorb.",
    checkFirst: [
      "Sample keys on the topic and count records per key.",
      "Check whether the skew is seasonal or constant.",
      "Check whether a single tenant, product, or device dominates the key space.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const hotPartitionModel: SimModel = {
  id: "streaming-hot-partition",
  visual: "queue",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed, []),
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const base = compute(p, []);
    const previousLags = fresh ? [] : readLags(frame.flags.lagJson, base.partitionCount);
    const stepSeconds = Math.min(1, Math.max(0.01, dt));
    const lags = base.partitions.map((partition) => {
      const lag = previousLags[partition.index] ?? 0;
      const excess = partition.load - base.consumerRate;
      if (excess > 0) return Math.min(MAX_LAG, lag + excess * stepSeconds);
      return Math.max(0, lag + excess * stepSeconds);
    });
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), lags);
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;
    next.flags.hotDetected = fresh ? 0 : frame.flags.hotDetected === 1 ? 1 : 0;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes) {
      if (typeof node.meta?.partition === "number") {
        recordSeries(next, `load.partition-${node.meta.partition}`, Number(node.meta.loadPct ?? 0));
        recordSeries(next, `lag.partition-${node.meta.partition}`, Number(node.meta.lag ?? 0));
      }
    }

    if (base.hotShare >= 0.3 && base.salt === 1 && frame.flags.hotDetected !== 1) {
      pushEvent(next, {
        id: "hot-key-detected",
        at: frame.t,
        severity: "warn",
        title: "One key dominates a single partition",
        detail: `${(base.hotShare * 100).toFixed(0)}% of records use one key. The hottest partition carries ${(base.maxUtilization * 100).toFixed(0)}% of its consumer capacity while the topic average is much lower.`,
        nodeId: `partition-${Math.min(HOT_INDEX, base.partitionCount - 1)}`,
        metricId: "hot-partition-load",
      });
      next.flags.hotDetected = 1;
    }
    if (base.hotShare < 0.3 || base.salt > 1) next.flags.hotDetected = 0;

    if (base.salt > 1 && frame.flags.salt !== base.salt) {
      pushEvent(next, {
        id: "key-salted",
        at: frame.t,
        severity: "info",
        title: "Hot key split across multiple partitions",
        detail: `The hot key now uses ${base.salt} subkeys. Consumers must merge them; per-entity order is no longer total.`,
        metricId: "partition-skew",
      });
    }

    next.flags.paramsKey = key;
    next.flags.salt = base.salt;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, []);
    const hottest = values.partitions.reduce(
      (best, partition) => (partition.utilization > best.utilization ? partition : best),
      values.partitions[0],
    );
    const items: string[] = [];
    if (values.maxUtilization >= 1) {
      items.push(
        `Partition ${hottest.index} is at ${(values.maxUtilization * 100).toFixed(0)}% of its consumer capacity. The group cannot assign a second consumer to it.`,
      );
    } else {
      items.push(
        `Partition ${hottest.index} is the hottest at ${(hottest.utilization * 100).toFixed(0)}% of consumer capacity; the distribution is the signal.`,
      );
    }
    items.push(
      `The topic carries ${Math.round(values.incoming).toLocaleString("en-US")} records/s across ${values.partitionCount} partitions; the hottest partition carries ${values.skew.toFixed(1)}x the average.`,
    );
    if (values.salt === 1) {
      items.push("Adding consumers beyond the partition count leaves new members idle, and adding partitions does not split the hot key.");
    } else {
      items.push(
        `Salting spreads the key across ${values.salt} partitions. Skew falls, but the load per partition still has to fit the consumer, and consumers must merge subkeys.`,
      );
    }
    if (frame.metrics.some((item) => item.id === "hot-partition-lag" && item.value > 0)) {
      items.push("Lag is concentrated where load exceeds the consumer; a group-level lag total hides the partition that is actually behind.");
    }
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
    description: "A broad key space and comfortable consumer headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher traffic with a mild hot key; the hottest partition is saturated but keeping up.",
    tone: "warn",
    params: defaults({ incomingRate: 60_000, hotKeyShare: 8, partitionCount: 12, consumerRate: 12_000 }),
  },
  {
    id: "failure",
    label: "Hot partition",
    description: "One key is 60% of 80k records/s and hashes to one partition.",
    tone: "crit",
    params: defaults({ incomingRate: 80_000, hotKeyShare: 60, partitionCount: 8, consumerRate: 8_000 }),
  },
  {
    id: "salting",
    label: "Salt the key",
    description: "Spread the hot key across all eight partitions without adding consumer capacity.",
    tone: "crit",
    params: defaults({ incomingRate: 80_000, hotKeyShare: 60, partitionCount: 8, consumerRate: 8_000, saltFanout: 8 }),
  },
  {
    id: "repartition",
    label: "Add partitions only",
    description: "Twelve partitions for the same key. The hot key still hashes to one of them.",
    tone: "crit",
    params: defaults({ incomingRate: 80_000, hotKeyShare: 60, partitionCount: 12, consumerRate: 8_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Twelve partitions, twelve subkeys, and a consumer that can sustain the spread load.",
    tone: "ok",
    params: defaults({ incomingRate: 80_000, hotKeyShare: 60, partitionCount: 12, consumerRate: 10_000, saltFanout: 12 }),
  },
];

const experiment: Experiment = {
  id: "predict-partition-fix",
  title: "Predict what more partitions buy",
  simId: "hot-partition",
  question:
    "The hot key is 60% of 80k records/s and one partition is at 650% of its consumer capacity. If you add four partitions but leave the key and consumers alone, what happens to the hot partition?",
  prediction: {
    options: [
      { id: "fixed", label: "It falls below the warning threshold" },
      { id: "barely", label: "It stays far above capacity because the key still hashes to one partition" },
      { id: "all-hot", label: "Every partition becomes equally hot" },
      { id: "errors-gone", label: "Lag disappears because there are more logs" },
    ],
    correctOptionId: "barely",
    explanation:
      "Adding partitions adds logs and consumer slots, but the hot key still hashes to one of them. Only the non-hot 40% of records spread further, so the hot partition stays far above its consumer capacity. The consumer count is still one for that partition, and the backlog keeps growing.",
  },
  setup: defaults({ incomingRate: 80_000, hotKeyShare: 60, partitionCount: 12, consumerRate: 8_000 }),
  runFor: 25,
  observe: [
    "The hot partition stays pinned at the top of the load chart after the partition count rises.",
    "Lag grows on that partition only; the other partitions receive a smaller share of the non-hot traffic.",
    "The topic average load falls, which makes the problem look smaller than it is.",
    "A second consumer cannot split that partition; each partition is assigned to one consumer in the group.",
  ],
  explain:
    "Partition count is a parallelism ceiling and a distribution mechanism, not a way to split an individual key. The key's hash still selects one partition, so the skewed share of traffic stays together. Salting or a key redesign changes the key before it is hashed; splitting the event changes what a record represents. Each one changes ordering, so the consumer and migration plan must change with it.",
  fix: defaults({ incomingRate: 80_000, hotKeyShare: 60, partitionCount: 12, consumerRate: 10_000, saltFanout: 12 }),
  debrief:
    "The fix spreads the key across twelve subkeys in twelve partitions. Each partition now receives about 6.7k records/s against a 10k consumer, so lag drains instead of growing. The cost is a fan-out read path, a migration that can serve both key shapes, and the loss of total per-entity order across the subkeys.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kafka topic is divided into partitions. Each partition is an append-only log, and within a consumer group one consumer owns each partition. A keyed producer hashes its key to choose a partition, so every record with that key lands in the same log. When one key is a large share of traffic, its share lands on one partition while the others keep spare capacity. That is a hot partition.",
  },
  {
    type: "p",
    text: "The average is the trap. Topic-wide throughput can look normal, every consumer can look busy, and one partition can be millions of records behind. Kafka does not rebalance a single key across partitions. Adding consumers beyond the partition count creates idle members, and adding partitions does not split an existing key. The fix changes the key, the partition count, or the consumer's ability to process that key's records.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, partition leader, consumer group. The producer chooses a partition. The broker appends to that partition's log and replicates it. The group assigns each partition to one consumer, and that consumer commits offsets. Ordering is per partition, so the key is both the ordering boundary and the parallelism boundary. A hot key therefore limits both at once.",
  },
  {
    type: "table",
    headers: ["Change", "What it does", "What it costs"],
    rows: [
      ["Add consumers", "Fills unused partition assignments", "No effect once every partition has a consumer"],
      ["Add partitions", "Adds logs and consumer slots", "Existing keys remap; ordering can break during the change"],
      ["Salt the key", "Turns one logical key into N keys on N partitions", "Per-entity order becomes per-subkey order; readers must merge"],
      ["Redesign the key", "Uses a coarser or composite key to spread load", "Changes co-partitioning and downstream joins"],
      ["Split the event", "Turns one large record into several smaller records", "Consumers must reassemble; atomicity is harder"],
    ],
  },
  {
    type: "p",
    text: "This module models a topic at 24k to 80k records per second with 4 to 12 partitions and a fixed per-partition consumer capacity. Those are illustrative teaching values, not Kafka limits or a benchmark. The shape of the failure is the lesson: one log saturates, its consumer falls behind, and the other logs have room.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot partition load: records per second against that partition's consumer capacity. Warning at 70%, critical at 85%.",
      "Hot partition lag and topic lag in records. Only the skewed partition should accumulate a backlog.",
      "Delivery delay: lag divided by the partition's consumption rate, which is the wait for a new record.",
      "Partition skew: the hottest partition's load divided by the average partition load.",
      "A queue view with one producer, the topic, and one consumer card per partition.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Hot partition. Compare the hot partition card with the idle ones. Run the guided experiment before changing sliders: predict whether more partitions will fix it, then try Salt the key and Recovery. Watch lag and delivery delay, not only throughput.",
  },
  { type: "sim", simId: "hot-partition" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The hottest key hashed to partition 2. That partition received 60% of 80k records/s, or 48k records/s, while its consumer could process 8k. Its backlog grew by 40k records every second; the other partitions had no backlog. The topic total rose, but the failure was one log's consumer. The topic average described the fleet and the group-level lag total described the group; neither identified the partition.",
  },
  {
    type: "p",
    text: "Adding four partitions moved only the non-hot traffic. Salting alone spread the key across all eight partitions, but 10k records/s per partition still exceeded the 8k consumer, so the backlog kept growing with no skew left to explain it. Recovery required both: twelve partitions gave the salt room, and twelve subkeys spread the key across them; about 6.7k records/s per partition stayed below the 10k consumer.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Kafka consumer metrics: records-lag-max, records-consumed-rate, fetch-latency-avg, and commit latency. Lag is a per-partition signal; a group total hides which partition is behind.",
      "Broker and topic metrics: BytesInPerSec, MessagesInPerSec, and request handler idle time. Compare the leader of the hot partition with its followers.",
      "Consumer group state: assigned partitions and offset commit rate. Idle members with no assignment mean the group already has more consumers than partitions.",
      "Producer metrics: record-send-rate, record-error-rate, and retry volume. Timeouts appear when the hot partition's leader cannot keep up.",
      "Logs and traces: consumer poll durations, rebalance events, and downstream writes attributed to the hot key.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare lag per partition, not per group. Find the key or key pattern that dominates the hot partition. Check whether the group has idle consumers, then check whether the hot consumer is CPU-bound, I/O-bound, or waiting on a downstream call. Only then choose a key change.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm skew: graph per-partition throughput and lag, and sample keys on the hot partition.",
      "Stop the bleeding: bound producer retries, slow non-critical producers, and protect the downstream store. Do not add consumers beyond the partition count.",
      "Choose the smallest key change. If per-entity order matters, redesign the key so one entity stays on one partition, and split only with a documented subkey.",
      "If order can be relaxed, salt the key with a bounded fan-out and teach consumers to merge subkey streams or accept per-subkey order.",
      "If one record is too large, split the event under a stable parent ID and make consumers handle partial batches.",
      "Increase partitions only with a migration: existing keys remap, so dual-write or drain the topic before the change.",
      "Re-run at peak and verify hot-partition load, lag, delivery delay, and skew together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Salting turns one ordered stream into N streams. You gain parallelism and lose the guarantee that one entity's records arrive in order.",
      "Key redesign can preserve entity order, but it changes co-partitioning: joins and stateful consumers must use the same key.",
      "Adding partitions is a one-way change for keyed ordering. The default partitioner maps keys with the partition count, so changing it remaps keys and can reorder records during rollout.",
      "More partitions also add broker metadata, open file handles, and rebalance time, so they are not free parallelism.",
      "Splitting an event reduces per-record size but makes atomicity and exactly-once effects harder.",
      "Every fix moves the bottleneck to the consumer, the downstream store, or the migration.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-hot-partition",
    question:
      "A topic has 12 partitions and total consumer lag is 2 million records. The group-level lag graph is flat. How do you find the hot partition?",
    difficulty: 3,
    hints: [
      "A group total can hide one partition's backlog.",
      "You need per-partition offsets and per-member assignment.",
    ],
    answer:
      "I would split lag by partition and by consumer member. The current log end offset minus the committed consumer offset gives lag per partition; records-lag-max per client is a quick confirmation. Then I would compare per-partition throughput and consumption rate. If one partition has a growing gap and the others are current, that is the hot partition. I would also sample keys on that partition, check which member owns it, and check whether the member is CPU-bound or waiting downstream. The group total is not evidence that lag is evenly spread.",
    followUps: [
      "What if every partition is behind?",
      "How would you confirm that one key is responsible?",
      "Which metric would you alert on before lag grows?",
    ],
    redFlags: [
      "Adds consumers before checking assignments.",
      "Uses only group-level lag.",
      "Blames the broker without checking the consumer.",
    ],
    rubric: [
      "Names per-partition lag and offset evidence.",
      "Checks consumer assignment and per-member throughput.",
      "Distinguishes key skew from aggregate capacity.",
      "States how to confirm the key.",
    ],
  },
  {
    id: "why-more-consumers",
    question:
      "The group has 8 consumers for 8 partitions and one partition is behind. Why does adding a ninth consumer not help?",
    difficulty: 2,
    hints: [
      "A partition is assigned to one consumer in a group.",
      "Consumers beyond the partition count sit idle.",
    ],
    answer:
      "Kafka assigns each partition to at most one consumer in a consumer group, so eight consumers already cover eight partitions. A ninth member has no partition to own and stays idle. The hot partition's consumer is the bottleneck, and the only ways to reduce its work are to reduce the records it receives, make that consumer process faster, or split the key across more partitions. Adding a member only helps when the group has fewer consumers than partitions.",
    followUps: [
      "What changes if the group has 4 consumers and 12 partitions?",
      "Can two consumer groups read the same partition?",
      "How does a rebalance interact with adding a member?",
    ],
    redFlags: [
      "Says Kafka will split the partition.",
      "Confuses consumer count with partition count.",
      "Ignores the hot partition's assignment.",
    ],
    rubric: [
      "Explains one consumer per partition per group.",
      "Distinguishes idle members from useful parallelism.",
      "Names the real levers: key, consumer capacity, partitions.",
    ],
  },
  {
    id: "salting-order",
    question:
      "You salt a key into eight subkeys. What ordering guarantee did you change, and how do consumers cope?",
    difficulty: 3,
    hints: [
      "Ordering is per partition, and the subkeys land on different partitions.",
      "A consumer can merge streams if the records carry a sequence or version.",
    ],
    answer:
      "The original key gave one total order for that entity because all of its records landed in one partition. After salting, the entity's records are split across up to eight partitions, so the guarantee is only per subkey. A consumer that needs entity-level order must merge the subkey streams, typically by buffering and sorting on a sequence number or version, and it must handle gaps and late records. If the operation cannot tolerate that, salting is the wrong fix; redesign the key so the entity stays on one partition and split a different dimension instead.",
    followUps: [
      "What happens if one subkey is much hotter than the others?",
      "How do you handle a late record during the merge?",
      "Which operations cannot tolerate per-subkey order?",
    ],
    redFlags: [
      "Says ordering is unchanged.",
      "Salts without changing consumers.",
      "Ignores late or missing subkey records.",
    ],
    rubric: [
      "States the lost total order explicitly.",
      "Describes a merge or version strategy.",
      "Names the operations that rule salting out.",
    ],
  },
  {
    id: "partition-migration",
    question:
      "You need more partitions for a keyed topic. How do you add them without breaking ordering for in-flight keys?",
    difficulty: 4,
    hints: [
      "The default partitioner maps a key with the partition count.",
      "A new topic lets old and new mappings coexist.",
    ],
    answer:
      "I would treat the partition change as a key remap, not a resize. The default partitioner computes the partition from the key hash and the partition count, so increasing the count moves many keys to new partitions. During the change, records for one key can be written to the old and new partitions and be consumed out of order. I would create a new topic with the target partition count, dual-write or mirror records, let consumers drain the old topic, then switch reads and stop the old writes. If the topic must stay in place, I would stop keyed writes for the migration window, increase the count, and resume with a versioned key scheme. Either way, I would verify lag and order before removing the old path.",
    followUps: [
      "How long do you keep the old topic?",
      "What if the producer cannot dual-write?",
      "How do you verify ordering after the switch?",
    ],
    redFlags: [
      "Increases the count in place with no migration.",
      "Assumes keys keep their old partition.",
      "Has no rollback path.",
    ],
    rubric: [
      "Explains the hash-and-modulo remap.",
      "Describes a dual-write or drain sequence.",
      "Verifies ordering and has a rollback.",
      "States the cost of the migration.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show per-partition throughput, lag, and consumer assignment, not only topic totals.",
      "Key cardinality and the top keys by record count are measured for every keyed topic.",
      "Consumer throughput per partition is known at the target downstream write rate.",
      "A key-change or partition-change runbook exists with an ordering and rollback plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the hot partition and the dominant key before changing capacity.",
      "Do not add consumers beyond the partition count; check assignments first.",
      "Protect the downstream store with bounded retries and backpressure.",
      "Choose salting, key redesign, event splitting, or repartitioning by the ordering cost.",
      "Record the key scheme, migration step, and timestamps for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify hot-partition load, lag, delivery delay, and skew at peak.",
      "Remove dual-write paths and reconcile the key scheme.",
      "Document the ordering guarantee that remains and the one that was given up.",
      "Add a regression load test with the real key distribution.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: topics, partitions, and producer configs",
    url: "https://kafka.apache.org/documentation/#intro_concepts_and_terms",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Partitioned logs, consumer groups, and ordering scope.",
  },
  {
    title: "Confluent Cloud cluster performance: hot partitions",
    url: "https://docs.confluent.io/cloud/current/monitoring/monitor-performance.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Hot-partition metric and guidance to reassess the key before adding partitions.",
  },
  {
    title: "Kafka producer configs: partitioner.class",
    url: "https://kafka.apache.org/documentation/#producerconfigs_partitioner.class",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Partitioner configuration and the default key-hash behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hot-partition": {
      model: hotPartitionModel,
      presets,
      instructions:
        "Start healthy, apply Hot partition, then compare Salt the key, Add partitions only, and Recovery. Watch per-partition lag and delivery delay, not the topic average.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Consumer capacity and partition counts are teaching values, not Kafka benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-keys-ordering",
    "streaming-kafka-partitions",
    "streaming-consumer-groups",
    "streaming-partition-count",
    "streaming-consumer-lag",
  ],
};
