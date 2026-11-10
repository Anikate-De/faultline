import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_LAG = 2_000_000;

const params = [
  {
    id: "partitions",
    label: "Partitions",
    min: 2,
    max: 16,
    step: 1,
    value: 12,
    unit: "",
    group: "Topic",
    help: "Partition count. Each partition is one ordered log and one consumer assignment per group.",
    format: "count" as const,
  },
  {
    id: "consumers",
    label: "Group members",
    min: 1,
    max: 24,
    step: 1,
    value: 6,
    unit: "",
    group: "Consumer group",
    help: "Consumers in one group. A partition is assigned to at most one member, so extra members stay idle.",
    format: "count" as const,
  },
  {
    id: "produceRate",
    label: "Incoming records",
    min: 2_000,
    max: 80_000,
    step: 1_000,
    value: 24_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records produced to the topic before the consumer group reads them.",
    format: "rps" as const,
  },
  {
    id: "consumerCapacity",
    label: "Per-consumer throughput",
    min: 2_000,
    max: 20_000,
    step: 500,
    value: 6_000,
    unit: " rec/s",
    group: "Consumers",
    help: "Records per second one member can process while keeping its downstream write rate stable.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flagNumber(frame: SimFrame, id: string, fallback = 0): number {
  const value = frame.flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  partitions: number;
  consumers: number;
  produceRate: number;
  consumerCapacity: number;
  assigned: number;
  idle: number;
  perPartitionLoad: number;
  groupCapacity: number;
  groupUtilization: number;
  lag: number;
  delay: number;
  shortfall: number;
}

function compute(p: Params, lag: number): Values {
  const partitions = Math.max(1, Math.round(num(p, "partitions", 12)));
  const consumers = Math.max(1, Math.round(num(p, "consumers", 6)));
  const produceRate = Math.max(1, num(p, "produceRate", 24_000));
  const consumerCapacity = Math.max(100, num(p, "consumerCapacity", 6_000));
  const assigned = Math.min(partitions, consumers);
  const groupCapacity = assigned * consumerCapacity;
  const perPartitionLoad = produceRate / partitions;
  return {
    partitions,
    consumers,
    produceRate,
    consumerCapacity,
    assigned,
    idle: Math.max(0, consumers - partitions),
    perPartitionLoad,
    groupCapacity,
    groupUtilization: produceRate / groupCapacity,
    lag,
    delay: lag > 0 ? Math.min(600_000, (lag / groupCapacity) * 1000) : 0,
    shortfall: Math.max(0, produceRate - groupCapacity),
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 0.85) return "crit";
  if (utilization >= 0.7) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.94 + 0.08 * Math.sin((offset + (seed % 7)) / 2.9);
  const seedPoints: [string, number, number][] = [
    ["consumer-load", values.groupUtilization * 100, 2],
    ["queueDepth", values.lag, 100],
    ["delivery-delay", values.delay, 20],
    ["idle-consumers", values.idle, 0.1],
    ["throughput-shortfall", values.shortfall, 200],
  ];
  for (const [id, value, amplitude] of seedPoints) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number, lag: number): SimFrame {
  const values = compute(p, lag);
  const topicHealth = healthFor(values.groupUtilization);
  const consumerHealth = healthFor(values.groupUtilization);
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Orders producer",
        kind: "service",
        health: values.groupUtilization > 1 ? "warn" : "ok",
        utilization: clamp(values.groupUtilization),
        throughput: values.produceRate,
        sublabel: `${Math.round(values.produceRate).toLocaleString("en-US")} rec/s`,
        detail: "Keyed writes are hashed across the topic partitions; unkeyed writes are spread by the producer.",
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "queue",
        health: topicHealth,
        utilization: clamp(values.groupUtilization),
        throughput: values.produceRate,
        capacity: values.groupCapacity,
        sublabel: `${values.partitions} partitions · 1 ordered log each`,
        detail:
          values.idle > 0
            ? `${values.partitions} partitions and ${values.consumers} members. ${values.idle} members have no partition to own.`
            : `${values.partitions} partitions and ${values.consumers} members. Every member owns at least one partition.`,
        meta: { partitions: values.partitions, idle: values.idle },
      },
      {
        id: "consumers-assigned",
        label: "Assigned members",
        kind: "worker",
        health: consumerHealth,
        utilization: clamp(values.groupUtilization),
        throughput: Math.min(values.produceRate, values.groupCapacity),
        capacity: values.groupCapacity,
        sublabel: `${values.assigned} of ${values.consumers} members · ${values.partitions} partitions owned`,
        detail: `Each assigned member owns ${(values.partitions / values.assigned).toFixed(1)} partitions on average and shares a ${Math.round(values.consumerCapacity).toLocaleString("en-US")} rec/s processing budget across them, so the average member is at ${(values.groupUtilization * 100).toFixed(0)}% of that budget.`,
        meta: { assigned: values.assigned },
      },
      {
        id: "consumers-idle",
        label: "Idle members",
        kind: "worker",
        health: values.idle > 0 ? "warn" : "ok",
        utilization: 0,
        throughput: 0,
        sublabel: values.idle > 0 ? `${values.idle} members with no assignment` : "no idle members",
        detail:
          values.idle > 0
            ? "Kafka assigns a partition to at most one member in the group, so these members wait through the next rebalance with no work."
            : "Every member owns at least one partition.",
        meta: { idle: values.idle },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", clamp(values.groupUtilization), topicHealth),
      edge(
        "topic-consumers",
        "topic",
        "consumers-assigned",
        clamp(values.groupUtilization),
        consumerHealth,
      ),
    ],
    metrics: [
      metric("consumer-load", "Consumer load", values.groupUtilization * 100, "%", 70, 85, "percent"),
      metric("queueDepth", "Consumer lag", values.lag, " records", 20_000, 100_000, "count"),
      metric("delivery-delay", "Delivery delay", values.delay, "ms", 2_000, 10_000, "ms"),
      metric("idle-consumers", "Idle consumers", values.idle, "", undefined, undefined, "count"),
      metric("assigned-consumers", "Assigned consumers", values.assigned, "", undefined, undefined, "count"),
      metric("throughput-shortfall", "Throughput shortfall", values.shortfall, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      lag,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.assigned} of ${values.consumers} members are assigned ${values.partitions} partitions; the group carries ${Math.round(values.produceRate).toLocaleString("en-US")} rec/s against ${Math.round(values.groupCapacity).toLocaleString("en-US")} rec/s of member capacity, or ${(values.groupUtilization * 100).toFixed(0)}% load.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0);
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "consumer-load",
    metricId: "consumer-load",
    warn: 70,
    crit: 85,
    title: "The consumer group is near its processing ceiling",
    cause:
      "Each member owns one or more partitions. When the group's combined load exceeds the members' combined processing capacity, every member falls behind and the backlog grows. Adding partitions does not help if there are no extra members.",
    fix:
      "Add consumers only while members are fewer than partitions. Once every partition is assigned, raise per-consumer throughput or add partitions plus members, and plan the key remap before changing the count.",
    checkFirst: [
      "Compare the member count with the partition count before adding capacity.",
      "Graph records consumed per member and per partition, not only the topic total.",
      "Check whether the consumer is CPU-bound, I/O-bound, or waiting on a downstream call.",
    ],
  },
  {
    id: "queueDepth",
    metricId: "queueDepth",
    warn: 20_000,
    crit: 100_000,
    title: "Consumer lag is growing because the group is under-provisioned",
    cause:
      "The group's combined processing rate is below the produce rate. With every partition already assigned, extra members cannot take work and the backlog grows by the shortfall every second.",
    fix:
      "Remove the shortfall: increase per-consumer throughput, add partitions plus members, or reduce the produce rate. Check assignment first so you do not add idle members.",
    checkFirst: [
      "List consumer group members and their assigned partitions.",
      "Compare total consume rate with produce rate.",
      "Check for a hot partition or a slow downstream dependency before adding members.",
    ],
  },
  {
    id: "delivery-delay",
    metricId: "delivery-delay",
    warn: 2_000,
    crit: 10_000,
    title: "Delivery delay exceeds the freshness budget",
    cause:
      "Lag divided by the group's processing rate is the wait for a newly produced record. A growing backlog becomes user-visible staleness even when the topic and brokers look healthy.",
    fix:
      "Drain the backlog by raising processing capacity or lowering input, then verify the age of the newest processed record per partition.",
    checkFirst: [
      "Measure record age, not only record count.",
      "Identify which product surfaces read the lagging topic.",
      "Check whether retries or downstream timeouts are slowing members.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const kafkaPartitionsModel: SimModel = {
  id: "streaming-kafka-partitions",
  visual: "queue",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const seconds = Math.min(1, Math.max(0.01, dt));
    const base = compute(p, 0);
    const previousLag = fresh ? 0 : flagNumber(frame, "lag", 0);
    const excess = base.produceRate - base.groupCapacity;
    const lag =
      excess > 0
        ? Math.min(MAX_LAG, previousLag + excess * seconds)
        : Math.max(0, previousLag + excess * seconds);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), lag);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (base.idle > 0 && next.flags.idleSeen !== 1) {
      pushEvent(next, {
        id: "idle-members",
        at: frame.t,
        severity: "warn",
        title: `${base.idle} group members have no partition to consume`,
        detail: `A group assigns at most one member per partition, so ${base.partitions} partitions can keep at most ${base.partitions} of the ${base.consumers} members busy. The other ${base.idle} members stay idle until the group has more partitions than members.`,
        nodeId: "consumers-idle",
        metricId: "idle-consumers",
      });
      next.flags.idleSeen = 1;
    }
    if (base.idle === 0) next.flags.idleSeen = 0;

    if (base.shortfall > 0 && next.flags.lagSeen !== 1) {
      pushEvent(next, {
        id: "lag-growing",
        at: frame.t,
        severity: "crit",
        title: "Lag is growing at the group's throughput ceiling",
        detail: `The group can process ${Math.round(base.groupCapacity).toLocaleString("en-US")} rec/s and receives ${Math.round(base.produceRate).toLocaleString("en-US")} rec/s. The backlog grows by ${Math.round(base.shortfall).toLocaleString("en-US")} records every second.`,
        nodeId: "topic",
        metricId: "queueDepth",
      });
      next.flags.lagSeen = 1;
    }
    if (base.shortfall === 0 && lag === 0) next.flags.lagSeen = 0;

    next.flags.lag = lag;
    next.flags.paramsKey = key;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, flagNumber(frame, "lag", 0));
    const items = [
      `${values.assigned} of ${values.consumers} members are assigned; ${values.idle} have no partition. The group's ceiling is ${Math.round(values.groupCapacity).toLocaleString("en-US")} rec/s.`,
      `Each partition carries ${Math.round(values.perPartitionLoad).toLocaleString("en-US")} rec/s; the assigned members are at ${(values.groupUtilization * 100).toFixed(0)}% of their combined processing capacity.`,
    ];
    if (values.shortfall > 0) {
      items.push(
        `Lag grows by ${Math.round(values.shortfall).toLocaleString("en-US")} records/s. A new member cannot help because every partition already has an owner.`,
      );
    } else {
      items.push("The group is keeping up; the remaining question is how much headroom you need at peak.");
    }
    if (values.idle > 0) {
      items.push("Idle members still count as group members during a rebalance. They cost money without adding throughput.");
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
    description: "Twelve partitions and six consumers, just below the warning line at about two thirds of member capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Every partition assigned and running at three quarters of consumer capacity.",
    tone: "warn",
    params: defaults({ consumers: 12, produceRate: 54_000 }),
  },
  {
    id: "failure",
    label: "Idle members, growing lag",
    description: "Twenty consumers for twelve partitions: eight sit idle while the group falls behind.",
    tone: "crit",
    params: defaults({ consumers: 20, produceRate: 60_000, consumerCapacity: 4_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "More partitions and one member per partition give the group enough processing capacity.",
    tone: "ok",
    params: defaults({ partitions: 16, consumers: 16, produceRate: 60_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-extra-consumers",
  title: "Predict what eight more consumers buy",
  simId: "kafka-partitions",
  question:
    "A topic has 12 partitions and 20 consumers. Eight members are idle and lag is growing. If you add eight more consumers, what happens to the group's processing rate?",
  prediction: {
    options: [
      { id: "doubles", label: "It doubles because there are twice as many consumers" },
      { id: "unchanged", label: "It stays at 12 partitions times one member's capacity" },
      { id: "partitions", label: "It creates eight new partitions automatically" },
      { id: "lag", label: "Lag drains because idle members absorb the backlog" },
    ],
    correctOptionId: "unchanged",
    explanation:
      "A partition is assigned to one consumer in a group. Twelve partitions can use at most twelve members, so twenty-eight consumers still give twelve assignments. The eight original idle members and the eight new ones have no partition to read. Processing capacity only rises with more partitions, a faster member, or less work per record.",
  },
  setup: defaults({ consumers: 20, produceRate: 60_000, consumerCapacity: 4_000 }),
  runFor: 25,
  observe: [
    "Twelve members own one partition each; eight members have no assignment.",
    "Each partition receives 5,000 records/s against a 4,000 records/s consumer, so lag grows by 12,000 records/s.",
    "Adding consumers leaves the assignment count at twelve and does not change the lag slope.",
    "The topic's ceiling is partition count times per-consumer throughput, not the member count.",
  ],
  explain:
    "Partition count is the parallelism ceiling for a consumer group. Kafka gives each partition to one member, which is what makes per-partition order possible. Members beyond the partition count wait idle; they receive work only if the assignment changes. The only ways to raise the ceiling are more partitions, faster consumers, or less work per record. Adding partitions later also remaps keys, so it needs an ordering and migration plan.",
  fix: defaults({ partitions: 16, consumers: 16, produceRate: 60_000 }),
  debrief:
    "With sixteen partitions and sixteen members, each partition carries 3,750 records/s against a 6,000 records/s consumer. The group processes 96,000 records/s, lag drains, and no member is idle. The cost is more partition metadata and a key remap for the existing topic.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kafka topic is split into partitions. Each partition is an append-only log stored on a broker, and each record in that log gets an offset: its position in that partition. A consumer group is a set of consumers that share the work of reading a topic. Kafka assigns each partition to at most one member of the group at a time. That rule is the whole module: the partition count is the maximum number of consumers that can do useful work in one group.",
  },
  {
    type: "p",
    text: "The partition also sets the ordering scope. Records in one partition are read in append order. There is no order between partitions. A keyed producer hashes the key to pick a partition, so all records with the same key land in one log and keep their order. Partitioning is therefore both a throughput decision and an ordering decision.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The write path is producer, partition leader, follower replicas. The producer chooses a partition, and the leader appends the record and returns an acknowledgment according to the producer's acks setting. The read path is consumer group, group coordinator, assigned members. The coordinator hands each partition to one member, and that member fetches, processes, and commits its offset.",
  },
  {
    type: "table",
    headers: ["Situation", "Assignments", "What you get"],
    rows: [
      ["6 consumers, 12 partitions", "6 members own 2 partitions each", "Parallelism limited by members, not partitions"],
      ["12 consumers, 12 partitions", "One member per partition", "Full partition parallelism"],
      ["20 consumers, 12 partitions", "12 members own one partition; 8 idle", "Same throughput as 12 consumers, plus idle cost"],
      ["20 consumers, 24 partitions", "20 members own one partition; 4 partitions unassigned", "More parallelism, but four partitions have no reader"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: up to 80,000 records per second, 2 to 16 partitions, and 2,000 to 20,000 records per second per consumer. Those are teaching numbers, not Kafka limits or a benchmark. The shape is what matters: one partition, one owner, one ordered log.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Consumer load: the group's produce rate against the assigned members' combined processing capacity. With one partition per member this is also the busiest partition's load. Warning at 70%, critical at 85%.",
      "Consumer lag in records. It grows by the difference between produce rate and the group's processing ceiling.",
      "Delivery delay: lag divided by processing rate, which is how long a new record waits.",
      "Idle consumers and assigned consumers, so the assignment limit is visible without reading logs.",
      "A queue view with the producer, the topic, and assigned and idle members.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Idle members, growing lag. Watch the assignment count and the lag slope before touching a slider. Run the guided experiment, then try Recovery. Move the member slider above the partition count and confirm that throughput does not change.",
  },
  { type: "sim", simId: "kafka-partitions" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, 60,000 records/s arrived at 12 partitions, or 5,000 records/s per partition, while each consumer could process 4,000. The group's ceiling was 12 times 4,000, or 48,000 records/s. Lag grew by 12,000 records every second. Eight of the twenty members had no assignment because every partition already had an owner. After 25 seconds the backlog was about 300,000 records, and the delivery delay was over six seconds.",
  },
  {
    type: "p",
    text: "Adding members did not change the ceiling. Recovery used 16 partitions and 16 members: 3,750 records/s per partition against 6,000 of capacity, a ceiling of 96,000 records/s, and no idle members. The fix was more assignment slots, not more processes waiting for work.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-partition records-lag-max, records-consumed-rate, fetch latency, and commit rate. Topic-wide lag hides which partition is behind.",
      "Consumer group state: member count, assigned partitions per member, and rebalance events. An idle member has no assignment.",
      "Broker metrics for the partition leaders: bytes in, messages in, request handler idle time, and replication health.",
      "Producer record-send-rate and record-error-rate. Backpressure appears at the producer when brokers or partitions saturate.",
      "The age of the newest processed record, which converts lag into a user-visible freshness number.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare member count with partition count. If members already exceed partitions, stop adding consumers. Then compare the produce rate per assigned member with that member's processing budget. Only after those two checks decide whether the fix is more partitions, a faster consumer, or less work per record.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the assignment: list members and the partitions each one owns.",
      "Find the bottleneck: records per assigned member versus one member's sustainable processing rate.",
      "If members are fewer than partitions, add members. If members exceed partitions, remove the idle ones.",
      "If every partition is assigned and still saturated, increase per-consumer throughput or add partitions.",
      "Before adding partitions, plan the key remap and the ordering guarantee for existing keys.",
      "Re-run at peak and check lag, delivery delay, and idle members together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More partitions raise the consumer ceiling and the ordering granularity, but they add broker metadata, open files, and rebalance work.",
      "More consumers reduce per-member load only while members are fewer than partitions. Beyond that they add cost and rebalance noise.",
      "Faster consumers can close a gap quickly, but they also push more load into the downstream store.",
      "Fewer partitions keep metadata small and ordering simple, but cap parallelism and concentrate key load.",
      "Every partition-count change remaps keys, so it is a data migration, not a routine resize.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "idle-consumers",
    question: "A topic has 12 partitions and a consumer group has 20 members. Eight members show no assigned partitions. Why, and what would you change?",
    difficulty: 1,
    hints: [
      "The group coordinator assigns partitions, not the consumers.",
      "One partition cannot be split between two members of the same group.",
    ],
    answer:
      "Kafka assigns each partition to at most one consumer in a group, so twelve partitions can occupy at most twelve members. The other eight stay idle; they gain partitions only if the group or partition count changes. I would check whether the group is actually behind. If lag is healthy, I would remove the idle members to cut cost and rebalance noise. If lag is growing, the fix is more partitions, a faster consumer, or less work per record, not more members. Before adding partitions I would plan the key remap because the partition count is part of the key-to-partition mapping.",
    followUps: [
      "What changes if the group has 4 members and 12 partitions?",
      "Can two different consumer groups read the same partition?",
      "What happens to idle members during a rebalance?",
    ],
    redFlags: [
      "Says Kafka splits a partition between members.",
      "Adds consumers without checking assignments.",
      "Confuses partition count with replication factor.",
    ],
    rubric: [
      "States one consumer per partition per group.",
      "Checks lag before changing capacity.",
      "Names the real levers: partitions, consumer throughput, record work.",
      "Mentions the key remap when partitions change.",
    ],
  },
  {
    id: "size-partitions",
    question: "How do you choose a partition count for a new topic?",
    difficulty: 2,
    hints: [
      "Start from the consumer throughput ceiling you need.",
      "Partition count also sets the maximum useful consumer count and the ordering granularity.",
    ],
    answer:
      "I start with peak produce rate and the sustainable throughput of one consumer, then divide to get the minimum partitions for the target headroom. I check that the result is at least the maximum number of consumers I expect to run, because extra consumers beyond the partition count are idle. I also check key cardinality: a low-cardinality key concentrates load no matter how many partitions exist. Then I add the operational costs: metadata per partition, open files per replica, rebalance time, and controller failover work. I would rather choose a count that covers realistic growth than resize later, because increasing partitions remaps keys and complicates ordering.",
    followUps: [
      "How much headroom do you leave at peak?",
      "What if the key space is smaller than the partition count?",
      "How would you test the choice before production?",
    ],
    redFlags: [
      "Picks a number without a throughput target.",
      "Ignores consumer parallelism.",
      "Treats partition count as free.",
    ],
    rubric: [
      "Derives a count from rate and per-consumer capacity.",
      "Checks consumer ceiling and key cardinality.",
      "Names metadata, file, rebalance, and failover costs.",
      "Explains why resizing later is risky.",
    ],
  },
  {
    id: "more-partitions-throughput",
    question: "You double the partition count but keep the same consumers and brokers. Does throughput double?",
    difficulty: 2,
    hints: [
      "Partitions are assignment slots and logs, not CPU.",
      "Consumers, brokers, and downstream writes still have fixed capacity.",
    ],
    answer:
      "No. Doubling partitions doubles the number of logs and the maximum number of consumers that can work in the group, but it does not add consumer processing capacity or broker capacity. With the same consumers, total consume rate stays roughly the same, though the work is spread over more partitions. If the consumers were already fewer than the old partition count, the extra partitions do not even add assignments. Throughput rises only when the new slots are filled with consumers and the brokers and downstream store can absorb the load. The change also remaps keys, so ordering needs a migration plan.",
    followUps: [
      "When would doubling partitions help?",
      "What happens to existing keys after the change?",
      "Which metric would show that brokers are now the bottleneck?",
    ],
    redFlags: [
      "Says partitions add CPU.",
      "Ignores key remapping.",
      "Forgets the downstream store.",
    ],
    rubric: [
      "Separates assignment slots from capacity.",
      "Requires consumers and brokers to absorb the load.",
      "Mentions key remap and ordering.",
    ],
  },
  {
    id: "offset-meaning",
    question: "What does a consumer group's committed offset identify, and why is it per partition?",
    difficulty: 1,
    hints: [
      "Each partition is an independent log.",
      "The committed offset is the next record the group intends to read.",
    ],
    answer:
      "A committed offset is the position in one partition's log that the group has finished up to; concretely, it is the offset of the next record the group intends to read. It is per partition because each partition has its own sequence of offsets and its own owner in the group. There is no meaningful global offset across partitions, and partitions are consumed at different rates. On restart, a member resumes from the committed offset for its assigned partitions. Records produced after that offset are replayed, which is why commit policy determines duplicate volume.",
    followUps: [
      "What happens if no offset is committed for a partition?",
      "How does auto-commit interact with processing?",
      "Can one group commit offsets for another group?",
    ],
    redFlags: [
      "Describes a global topic offset.",
      "Says the broker tracks each consumer's read position automatically.",
      "Confuses the log end offset with the committed offset.",
    ],
    rubric: [
      "Defines the committed offset as the next record to read.",
      "Explains the per-partition scope.",
      "Connects restart behavior to replay.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show member count, assigned partitions, per-partition lag, and consume rate.",
      "Partition count is at least the planned peak consumer count.",
      "Per-consumer sustainable throughput is measured against the real downstream write rate.",
      "A partition-count change runbook includes the key remap and ordering plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check assignments before adding or removing members.",
      "Remove idle members only after confirming the group has enough capacity.",
      "If every partition is assigned, raise consumer throughput or reduce input instead of adding members.",
      "Record the assignment map and lag slope for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify lag, delivery delay, and idle members at peak.",
      "Resize the group to the partition count, not above it.",
      "If partitions changed, reconcile keys and verify per-key order.",
      "Add a load test that runs at peak with the real key distribution.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: main concepts and terminology",
    url: "https://kafka.apache.org/44/getting-started/introduction#main-concepts-and-terminology",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Topics, partitions, keys, ordering scope, and replication.",
  },
  {
    title: "Apache Kafka documentation: consumer configs",
    url: "https://kafka.apache.org/44/configuration/consumer-configs/",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Consumer group, offset, and commit settings.",
  },
  {
    title: "Confluent: Intro to Kafka partitions",
    url: "https://developer.confluent.io/courses/apache-kafka/partitions/",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Key hashing, per-partition order, and the parallelism tradeoff.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "kafka-partitions": {
      model: kafkaPartitionsModel,
      presets,
      instructions:
        "Start healthy, then apply Idle members, growing lag. Compare assigned and idle members, watch the lag slope, then try Recovery. Move the member slider above the partition count and confirm that throughput does not change.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Rates, partition counts, and consumer capacity are teaching values, not Kafka limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-keys-ordering",
    "streaming-consumer-groups",
    "streaming-partition-count",
    "foundations-backpressure",
  ],
};
