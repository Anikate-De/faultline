import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PARTITION_CAPACITY = 5_000;
const TOP_ENTITY_SHARE = 0.02;
const HOT_TENANT_SHARE = 0.32;

const params = [
  {
    id: "keyStrategy",
    label: "Key strategy",
    min: 0,
    max: 3,
    step: 1,
    value: 1,
    unit: "",
    group: "Producer",
    help: "0 no key (producer spreads records), 1 order_id, 2 event_id, 3 tenant_id. Values are shown in the key readout below.",
    format: "count" as const,
  },
  {
    id: "partitions",
    label: "Partitions",
    min: 2,
    max: 16,
    step: 1,
    value: 8,
    unit: "",
    group: "Topic",
    help: "Partition count used by the key hash. Changing it moves keys to different partitions.",
    format: "count" as const,
  },
  {
    id: "eventRate",
    label: "Event rate",
    min: 1_000,
    max: 40_000,
    step: 500,
    value: 9_000,
    unit: " ev/s",
    group: "Traffic",
    help: "Records per second across all orders and event types.",
    format: "rps" as const,
  },
  {
    id: "eventsPerOrder",
    label: "Events per order",
    min: 2,
    max: 10,
    step: 1,
    value: 3,
    unit: " events",
    group: "Workflow",
    help: "Related records an order emits, such as created, paid, and shipped.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  strategy: number;
  keyName: string;
  partitions: number;
  eventRate: number;
  eventsPerOrder: number;
  preserved: number;
  outOfOrder: number;
  maxLoad: number;
  averageLoad: number;
  loadPct: number;
  skew: number;
  splitPerMin: number;
  hotShare: number;
}

function keyName(strategy: number): string {
  if (strategy === 0) return "no key";
  if (strategy === 1) return "order_id";
  if (strategy === 2) return "event_id";
  return "tenant_id";
}

function compute(p: Params): Values {
  const strategy = Math.min(3, Math.max(0, Math.round(num(p, "keyStrategy", 1))));
  const partitions = Math.max(2, Math.round(num(p, "partitions", 8)));
  const eventRate = Math.max(100, num(p, "eventRate", 9_000));
  const eventsPerOrder = Math.max(2, Math.round(num(p, "eventsPerOrder", 3)));
  const orderedKey = strategy === 1 || strategy === 3;
  const preserved = orderedKey ? 1 : Math.pow(1 / partitions, eventsPerOrder - 1);
  const hotShare = strategy === 1 ? TOP_ENTITY_SHARE : strategy === 3 ? HOT_TENANT_SHARE : 0;
  const averageLoad = eventRate / partitions;
  const maxLoad = orderedKey ? eventRate * (hotShare + (1 - hotShare) / partitions) : averageLoad;
  const loadPct = (maxLoad / PARTITION_CAPACITY) * 100;
  return {
    strategy,
    keyName: keyName(strategy),
    partitions,
    eventRate,
    eventsPerOrder,
    preserved,
    outOfOrder: (1 - preserved) * 100,
    maxLoad,
    averageLoad,
    loadPct,
    skew: maxLoad / Math.max(1, averageLoad),
    splitPerMin: (eventRate / eventsPerOrder) * (1 - preserved) * 60,
    hotShare,
  };
}

function healthForLoad(loadPct: number): "ok" | "warn" | "crit" {
  if (loadPct >= 85) return "crit";
  if (loadPct >= 70) return "warn";
  return "ok";
}

function healthForOrder(outOfOrder: number): "ok" | "warn" | "crit" {
  if (outOfOrder >= 2) return "crit";
  if (outOfOrder >= 0.5) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.95 + 0.07 * Math.sin((offset + (seed % 5)) / 2.6);
  const points: [string, number, number][] = [
    ["out-of-order", values.outOfOrder, 0.2],
    ["partition-load", values.loadPct, 2],
    ["partition-skew", values.skew, 0.05],
    ["split-sequences", values.splitPerMin, 50],
  ];
  for (const [id, value, amplitude] of points) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const orderHealth = healthForOrder(values.outOfOrder);
  const loadHealth = healthForLoad(values.loadPct);
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Order producer",
        kind: "service",
        health: "ok",
        utilization: clamp(values.eventRate / (values.partitions * PARTITION_CAPACITY)),
        throughput: values.eventRate,
        sublabel: `${Math.round(values.eventRate).toLocaleString("en-US")} ev/s · key ${values.keyName}`,
        detail: `Each order emits ${values.eventsPerOrder} events. The producer hashes ${values.keyName} to select a partition.`,
        meta: { view: "flow" },
      },
      {
        id: "partitioner",
        label: "Partitioner",
        kind: "service",
        health: "ok",
        utilization: 0.6,
        sublabel: `hash(${values.keyName}) % ${values.partitions}`,
        detail: "Same key, same partition. Different keys can share a partition, but one partition is read in append order.",
        meta: { view: "flow" },
      },
      {
        id: "partition-hot",
        label: `partition-${values.partitions - 1}`,
        kind: "worker",
        role: "shard",
        health: loadHealth,
        utilization: clamp(values.maxLoad / PARTITION_CAPACITY),
        throughput: values.maxLoad,
        capacity: PARTITION_CAPACITY,
        sublabel: `${Math.round(values.maxLoad).toLocaleString("en-US")} ev/s · ${values.skew.toFixed(1)}x average`,
        detail: `The busiest partition carries ${values.skew.toFixed(1)} times the average load.`,
        meta: { view: "flow", hot: values.skew > 2 ? 1 : 0 },
      },
      {
        id: "partition-two",
        label: `partition-${values.partitions - 2}`,
        kind: "worker",
        role: "shard",
        health: healthForLoad((values.averageLoad / PARTITION_CAPACITY) * 100),
        utilization: clamp(values.averageLoad / PARTITION_CAPACITY),
        throughput: values.averageLoad,
        capacity: PARTITION_CAPACITY,
        sublabel: `${Math.round(values.averageLoad).toLocaleString("en-US")} ev/s`,
        detail: "An average partition. The producer gives it the same key hash treatment as every other partition.",
        meta: { view: "flow" },
      },
      {
        id: "partition-three",
        label: `partition-${Math.max(0, values.partitions - 3)}`,
        kind: "worker",
        role: "shard",
        health: healthForLoad((values.averageLoad / PARTITION_CAPACITY) * 100),
        utilization: clamp(values.averageLoad / PARTITION_CAPACITY),
        throughput: values.averageLoad,
        capacity: PARTITION_CAPACITY,
        sublabel: `${Math.round(values.averageLoad).toLocaleString("en-US")} ev/s`,
        detail: "A third representative partition. Its order guarantee applies only to records inside this log.",
        meta: { view: "flow" },
      },
      {
        id: "consumer-group",
        label: "Order consumer group",
        kind: "service",
        health: orderHealth,
        utilization: clamp(values.eventRate / (values.partitions * PARTITION_CAPACITY)),
        throughput: values.eventRate,
        sublabel: `${values.partitions} members · commit per partition`,
        detail:
          values.outOfOrder > 0
            ? `${values.outOfOrder.toFixed(1)}% of multi-event sequences can be read out of order because their events land on different partitions.`
            : "Events for one order share a partition, so each order is read in append order.",
        meta: { view: "flow", outOfOrder: values.outOfOrder },
      },
    ],
    edges: [
      edge("producer-partitioner", "producer", "partitioner", clamp(values.eventRate / (values.partitions * PARTITION_CAPACITY)), "ok"),
      edge("partitioner-hot", "partitioner", "partition-hot", clamp(values.maxLoad / values.eventRate), loadHealth),
      edge("partitioner-two", "partitioner", "partition-two", 1 / values.partitions, "ok"),
      edge("partitioner-three", "partitioner", "partition-three", 1 / values.partitions, "ok"),
      edge("hot-group", "partition-hot", "consumer-group", clamp(values.maxLoad / values.eventRate), orderHealth),
      edge("two-group", "partition-two", "consumer-group", 1 / values.partitions, orderHealth),
      edge("three-group", "partition-three", "consumer-group", 1 / values.partitions, orderHealth),
    ],
    metrics: [
      metric("out-of-order", "Sequences at risk", values.outOfOrder, "%", 0.5, 2, "percent"),
      metric("partition-load", "Hottest partition", values.loadPct, "%", 70, 85, "percent"),
      metric("partition-skew", "Partition skew", values.skew, "x", 2, 4, "number"),
      metric("split-sequences", "Split sequences", values.splitPerMin, "/min", undefined, undefined, "count"),
      metric("ordering-scope", "Ordering scopes", values.partitions, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `Key ${values.keyName} with ${values.partitions} partitions: ${values.outOfOrder.toFixed(1)}% of multi-event orders can be read out of order; the hottest partition carries ${values.skew.toFixed(1)}x the average.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed);
  seedSeries(frame, compute(p), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "out-of-order",
    metricId: "out-of-order",
    warn: 0.5,
    crit: 2,
    title: "Related events can be consumed out of order",
    cause:
      "Events for one entity hashed to different partitions. Kafka orders records within a partition, not across partitions, and consumers read partitions independently, so the workflow sees an older event after a newer one.",
    fix:
      "Use the entity identifier as the key, such as order_id. Keep event identity in the value, not in the key. If the workflow genuinely must split an entity across partitions, carry a version and reconcile in the consumer.",
    checkFirst: [
      "Sample records for one entity and list the partition each event landed on.",
      "Check whether the key is the entity ID or an event ID.",
      "Check whether consumers merge partitions before applying state.",
    ],
  },
  {
    id: "partition-load",
    metricId: "partition-load",
    warn: 70,
    crit: 85,
    title: "A coarse key concentrates load on one partition",
    cause:
      "The key has low cardinality or one value dominates traffic. All records for that key go to one partition, so the partition carries far more than its share while the rest of the topic has room.",
    fix:
      "Use a finer key that still matches the ordering boundary. A composite key can spread unrelated entities while keeping each entity on one partition. Salting splits order as well as load, so it needs a consumer merge.",
    checkFirst: [
      "Count records per key value, not only the number of distinct keys.",
      "Check whether a tenant, region, or device ID is the key.",
      "Compare the hottest partition's rate with the average.",
    ],
  },
  {
    id: "partition-skew",
    metricId: "partition-skew",
    warn: 2,
    crit: 4,
    title: "Key distribution is skewed from the average",
    cause:
      "A small number of key values owns most of the records. The topic average hides the partition that will saturate first, and more partitions do not split one key.",
    fix:
      "Measure the top keys by volume, then choose a key with enough cardinality for the partition count. Treat any key change as an ordering change and migrate consumers with it.",
    checkFirst: [
      "Rank keys by record count over a representative window.",
      "Check whether the skew is constant or tied to a tenant or time of day.",
      "Verify the key cardinality is much larger than the partition count.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const keysOrderingModel: SimModel = {
  id: "streaming-keys-ordering",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.outOfOrder >= 0.5 && next.flags.splitSeen !== 1) {
      pushEvent(next, {
        id: "split-sequences",
        at: frame.t,
        severity: "warn",
        title: "One order's events landed on different partitions",
        detail: `${values.outOfOrder.toFixed(1)}% of ${values.eventsPerOrder}-event orders can be read out of order because key ${values.keyName} does not identify the order. The partitions are individually ordered; the workflow is not.`,
        nodeId: "consumer-group",
        metricId: "out-of-order",
      });
      next.flags.splitSeen = 1;
    }
    if (values.outOfOrder < 0.5) next.flags.splitSeen = 0;

    if (values.skew >= 2 && next.flags.skewSeen !== 1) {
      pushEvent(next, {
        id: "coarse-key-skew",
        at: frame.t,
        severity: "warn",
        title: "Coarse key is concentrating partition load",
        detail: `Key ${values.keyName} puts ${(values.hotShare * 100).toFixed(0)}% of traffic on a small set of key values. The hottest partition carries ${values.skew.toFixed(1)}x the average load.`,
        nodeId: "partition-hot",
        metricId: "partition-skew",
      });
      next.flags.skewSeen = 1;
    }
    if (values.skew < 2) next.flags.skewSeen = 0;

    next.flags.paramsKey = key;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `Key ${values.keyName} hashes to one partition per key value. Ordering scope is ${values.partitions} partition logs, not the topic.`,
    ];
    if (values.outOfOrder > 0) {
      items.push(
        `${values.outOfOrder.toFixed(1)}% of ${values.eventsPerOrder}-event sequences can interleave because their events use different keys. The hottest partition is only at ${values.loadPct.toFixed(0)}% of capacity, so this is an ordering failure, not a load failure.`,
      );
    } else if (values.strategy === 1) {
      items.push(
        "Every order keeps one partition and one order. The cost is that a single order cannot be processed by two consumers at once.",
      );
    } else {
      items.push(
        "Every entity keeps one partition and one order. The cost is skew: the hottest tenant or entity still owns a whole partition.",
      );
    }
    if (values.skew >= 2) {
      items.push(
        `The hottest partition carries ${values.skew.toFixed(1)}x the average. More partitions will not split that key.`,
      );
    }
    items.push("A key change is also an ordering change; the consumer and the migration plan must change with it.");
    return items;
  },
  legend: [
    { label: "Ordered", tone: "ok" },
    { label: "At risk", tone: "warn" },
    { label: "Reordering", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every order is keyed by order_id, so its events share one partition.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Entity key at higher traffic and more partitions; ordered, with a hotter partition.",
    tone: "warn",
    params: defaults({ partitions: 12, eventRate: 36_000 }),
  },
  {
    id: "failure",
    label: "Event key",
    description: "Each event is keyed by event_id, so an order's events scatter across partitions.",
    tone: "crit",
    params: defaults({ keyStrategy: 2 }),
  },
  {
    id: "tenant-key",
    label: "Tenant key",
    description: "A tenant key preserves order but puts one tenant's traffic on one partition.",
    tone: "warn",
    params: defaults({ keyStrategy: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Order_id key with more partitions: ordered and below the load threshold.",
    tone: "ok",
    params: defaults({ partitions: 12, eventRate: 9_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-order-key",
  title: "Predict which key restores order",
  simId: "keys-ordering",
  question:
    "An order emits created, paid, and shipped events. The producer keys by event_id. Which key makes the three events readable in order?",
  prediction: {
    options: [
      { id: "event-id", label: "Keep event_id: each event is unique" },
      { id: "order-id", label: "order_id: every event for the order shares a partition" },
      { id: "no-key", label: "No key: the producer spreads the events across partitions" },
      { id: "tenant-id", label: "tenant_id: all of the tenant's orders share a partition" },
    ],
    correctOptionId: "order-id",
    explanation:
      "Ordering comes from the partition log. Kafka hashes the key and uses modulo to select a partition, so records with the same key share one log. event_id is different for every event, and no key lets the producer spread the events; both scatter the three events. tenant_id also preserves order, but it puts all of one tenant's orders on one partition, which creates skew. order_id keeps each order together while allowing different orders to run in parallel.",
  },
  setup: defaults({ keyStrategy: 2 }),
  runFor: 20,
  observe: [
    "The partitioner spreads created, paid, and shipped across different partitions.",
    "Each partition stays individually ordered, yet the consumer group sees the events interleaved.",
    "Hottest partition load stays low, so the failure is invisible on a throughput dashboard.",
    "The split-sequences rate stays proportional to orders per second, not to total event rate.",
  ],
  explain:
    "Kafka guarantees order within a partition, and a key selects one partition. An event-scoped key is unique per event, so it cannot group events for one entity. An entity-scoped key puts the workflow on one log. The limit is that one entity is then processed by one consumer at a time; that is the price of per-entity order.",
  fix: defaults({ keyStrategy: 1, partitions: 12 }),
  debrief:
    "Keying by order_id drops the at-risk share to zero: all three events share a partition and are appended in order. Load stays below the warning threshold with 12 partitions at 9,000 events/s. The tradeoff is that one order cannot be parallelized inside the consumer group, and a very large order can still be a single hot key.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kafka record can carry a key. The producer hashes that key, applies modulo by the partition count, and appends the record to one partition. Records with the same key therefore share a log, and a log is read in append order. Kafka calls this per-partition ordering: there is a total order inside a partition and no order between partitions. Key design is how you choose which events must share that order.",
  },
  {
    type: "p",
    text: "Keying by an entity identifier such as order_id keeps every event for that order on one partition while different orders spread across the topic. Keying by an event identifier, or sending no key, spreads related events across partitions and lets consumers read them in any order. Keying by a coarse identifier such as tenant_id preserves order but concentrates a tenant's traffic on one partition. The key is both the ordering boundary and the load distribution mechanism.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The producer's partitioner sits between the application and the partition leader. The leader appends the record and replicates it; the consumer group assigns partitions to members. A member reads one partition at a time, so its view of another partition can be arbitrarily behind. Nothing in the broker or consumer reorders records across partitions. The ordering guarantee ends at the partition boundary.",
  },
  {
    type: "table",
    headers: ["Key", "Order for one order", "Load behavior", "Main risk"],
    rows: [
      ["No key", "Events scatter across partitions", "Spread across partitions", "Reordering and no entity affinity"],
      ["event_id", "Events scatter by event hash", "Even across partitions", "Same reordering with a false sense of identity"],
      ["order_id", "All events share a partition", "Spreads by order cardinality", "A single hot order owns one partition"],
      ["tenant_id", "All tenant events share a partition", "Concentrates by tenant", "Tenant skew and one hot partition"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 2 to 16 partitions, 1,000 to 40,000 events per second, and a fixed 5,000 events per second of partition capacity. The top order is 2% of traffic and the top tenant is 32%; those shares are teaching values, not measurements of your system.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Sequences at risk: the share of multi-event orders whose events can land on different partitions. Warning at 0.5%, critical at 2%.",
      "Hottest partition load and partition skew, which show the cost of a coarse key.",
      "Split sequences per minute, which scales with orders per second rather than total events.",
      "Ordering scopes: the number of independent partition logs in the topic.",
      "A flow view from producer to partitioner to the busiest partitions and the consumer group.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Event key and watch the order-flow signal while the load signal stays calm. Run the guided experiment, then compare Tenant key and Recovery. Change the key strategy last and read the key name in the producer card before interpreting the chart.",
  },
  { type: "sim", simId: "keys-ordering" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With event_id as the key, every record hashed independently. At 9,000 events/s and three events per order, the topic carried 3,000 orders/s across eight partitions. The chance that all three events for one order landed on the same partition was one in 64, so about 98.4% of orders could be read out of order. Each partition was still ordered on its own, and the hottest partition was only about 22.5% of capacity. A throughput dashboard would have shown a healthy topic.",
  },
  {
    type: "p",
    text: "Switching to order_id made each order's records share a partition and dropped the at-risk share to zero. The busiest partition carried 1.14 times the average because the top order was 2% of traffic. Keying by tenant_id also restored order, but the top tenant's 32% share pushed the hottest partition to 72.9% of capacity and 3.2 times the average, which is the tradeoff the next module explores.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer-side order violations: an older event applied after a newer event for the same entity.",
      "Record keys sampled from the topic and the partition each key hashes to.",
      "Per-partition produce rate and partition skew, which expose a coarse key before it saturates.",
      "Consumer group assignment and per-partition lag, because an ordered entity waits behind its partition.",
      "Producer retries and max.in.flight, which can reorder records even inside one partition when idempotence is off.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Sample one entity's events and list their partitions. If they differ, the key is wrong for the ordering requirement. If they match, check the consumer's merge and commit logic before blaming the broker. A partition cannot reorder records that it never received.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "State the ordering boundary: per order, per tenant, or global.",
      "Pick the smallest key that contains that boundary, usually the entity ID.",
      "Check the key's cardinality against the partition count; too few keys means skew.",
      "Migrate producers first and make consumers tolerate both old and new keys during the change.",
      "Carry a version or sequence in the value so consumers can detect and resolve late events.",
      "Verify order with a replay test that emits the same entity's events through the new key.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An entity key gives per-entity order but caps that entity's parallelism to one consumer.",
      "A coarse tenant key gives tenant-wide order but concentrates load and makes one partition the tenant ceiling.",
      "No key gives the best load distribution and no ordering; it is suitable only for independent events.",
      "Salting an entity key restores parallelism but splits order, so consumers must merge subkeys.",
      "Changing the key or the partition count remaps keys, so a dual-read or drain window is part of the fix.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-order-key",
    question: "Two updates for one order arrive out of order. What key should the producer use, and what does that key guarantee?",
    difficulty: 2,
    hints: [
      "Ordering is per partition, not per topic.",
      "The key must be the same for every event that shares an order.",
    ],
    answer:
      "I would key by order_id. The producer hashes the key to one partition, so every event for that order lands in the same log and is appended in order. The guarantee is per order, not global: different orders can still be processed concurrently on different partitions. I would move event identity into the value and keep a version or sequence there so consumers can detect late or duplicate events. If the order itself is too hot for one partition, that is a separate problem; salting or splitting it changes the ordering guarantee.",
    followUps: [
      "What happens if the producer retries a batch?",
      "Would tenant_id be acceptable?",
      "How do you verify order after the change?",
    ],
    redFlags: [
      "Keys by event_id.",
      "Claims global order from a keyed topic.",
      "Ignores producer retries.",
    ],
    rubric: [
      "Chooses the entity key.",
      "States per-partition order.",
      "Mentions retries or versions.",
      "Names the hot-entity limit.",
    ],
  },
  {
    id: "one-partition",
    question: "Why not use one partition for the whole topic and get a total order?",
    difficulty: 2,
    hints: [
      "One partition is one log with one consumer owner.",
      "Throughput and failure recovery both scale with partitions.",
    ],
    answer:
      "One partition gives a total order, but it also serializes the topic. A partition is assigned to one consumer in a group, so only one member can process it, and the topic's throughput is capped by that member's rate. The log also lives on one leader at a time, so its size and recovery are concentrated. Partitioning trades global order for parallelism. The usual design is to find the smallest ordering boundary the business needs, key by that, and let unrelated entities run in parallel.",
    followUps: [
      "When is global order actually required?",
      "How would one partition affect failover?",
      "What is the cost of a key with too few values?",
    ],
    redFlags: [
      "Says one partition is always simpler.",
      "Forgets the single-consumer limit.",
      "Ignores recovery and log size.",
    ],
    rubric: [
      "Explains serialization.",
      "Names consumer and broker limits.",
      "Frames the ordering boundary tradeoff.",
    ],
  },
  {
    id: "retry-order",
    question: "The producer retries after a timeout. Can a keyed topic still deliver records out of order?",
    difficulty: 3,
    hints: [
      "Ordering is preserved as records are appended to the log.",
      "In-flight requests and retries can append a retried batch after a later one.",
    ],
    answer:
      "Yes. A key keeps records in one partition, but the producer can still reorder them before they are appended. If max.in.flight.requests.per.connection is greater than one and a batch fails and is retried, a later batch can reach the leader first. Kafka's idempotent producer addresses this: it uses sequence numbers and the broker rejects duplicates and out-of-order appends, and the Java producer enables it by default in recent releases. The safe combination is idempotence on, acks=all, and in-flight requests within the client's supported range. The key alone is not a complete ordering guarantee.",
    followUps: [
      "What does the idempotent producer require from acks?",
      "How does a duplicate differ from a reorder?",
      "What if the application produces from two processes with the same key?",
    ],
    redFlags: [
      "Says a key guarantees order end to end.",
      "Ignores max.in.flight.",
      "Confuses idempotence with transactions.",
    ],
    rubric: [
      "Separates key order from producer append order.",
      "Explains in-flight retries.",
      "Names idempotence and acks.",
    ],
  },
  {
    id: "partition-change-order",
    question: "You increase the partition count on a keyed topic. What happens to existing keys, and how do you protect order?",
    difficulty: 4,
    hints: [
      "The default partitioner hashes the key and applies modulo by the partition count.",
      "Old and new mappings can coexist during a migration.",
    ],
    answer:
      "The key-to-partition mapping depends on the partition count, so increasing it moves many keys to new partitions. During the change, records for one key can be written to the old and new partitions and read by different consumers, which breaks per-key order. I would treat it as a migration: create a new topic with the target count, dual-write or mirror records, let consumers drain and switch reads, then stop the old writes. If the topic must stay in place, I would pause keyed writes for the change and resume with a versioned key, and verify order with a replay test. I would not resize in place during normal traffic.",
    followUps: [
      "How long do you keep the old topic?",
      "What if the producer cannot dual-write?",
      "How do you verify order after the switch?",
    ],
    redFlags: [
      "Assumes keys keep their partitions.",
      "Resizes in place without a drain.",
      "Has no rollback.",
    ],
    rubric: [
      "Explains hash modulo remap.",
      "Describes a dual-write or drain sequence.",
      "Verifies order and has a rollback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every stateful topic documents its ordering boundary and the key that implements it.",
      "Dashboards show partition skew and the top keys by record count.",
      "Producer idempotence and max.in.flight are set deliberately for ordering-sensitive topics.",
      "A key or partition-count change has a dual-read or drain plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Sample one entity's events and list their partitions before changing anything.",
      "Check producer retries and in-flight settings, not only the consumer.",
      "If the key is wrong, stop writes or dual-write before changing the key.",
      "Protect downstream state from late events with version checks.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replay a known entity's events and verify order end to end.",
      "Check the new key's cardinality and partition skew at peak.",
      "Document the ordering guarantee that remains.",
      "Add an alert for order violations, not only consumer lag.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: main concepts and terminology",
    url: "https://kafka.apache.org/44/getting-started/introduction#main-concepts-and-terminology",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Keyed records, partition order, and replication.",
  },
  {
    title: "Apache Kafka documentation: producer configs",
    url: "https://kafka.apache.org/44/configuration/producer-configs/",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "acks, retries, idempotence, and in-flight request settings.",
  },
  {
    title: "Confluent: Intro to Kafka partitions",
    url: "https://developer.confluent.io/courses/apache-kafka/partitions/",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Key hashing and the scope of per-partition ordering.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "keys-ordering": {
      model: keysOrderingModel,
      presets,
      instructions:
        "Start healthy, then apply Event key. Watch sequences at risk while partition load stays calm. Run the guided experiment, compare Tenant key, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Key shares, event rates, and partition capacity are teaching values, not Kafka limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-kafka-partitions",
    "streaming-hot-partition",
    "streaming-partition-count",
    "streaming-consumer-groups",
  ],
};
