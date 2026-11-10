import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SLOW_INDEX = 2;
const MAX_LAG = 5_000_000;

const params = [
  {
    id: "incomingRate",
    label: "Incoming records",
    min: 2_000,
    max: 30_000,
    step: 500,
    value: 8_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records arriving at the topic. Each partition receives an equal share in this model.",
    format: "rps" as const,
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
    help: "Partition count. One consumer in a group owns each partition, so this is also the group's useful parallelism.",
    format: "count" as const,
  },
  {
    id: "processingMs",
    label: "Processing time",
    min: 0.2,
    max: 2,
    step: 0.05,
    value: 0.5,
    unit: " ms",
    group: "Consumers",
    help: "Time one healthy consumer spends per record. Capacity per consumer is 1,000 divided by this value.",
    format: "number" as const,
  },
  {
    id: "stragglerMs",
    label: "Straggler downstream wait",
    min: 0,
    max: 6,
    step: 0.1,
    value: 0,
    unit: " ms",
    group: "Consumers",
    help: "Extra time one consumer waits on a downstream call for every record. It lowers only that consumer's capacity.",
    format: "number" as const,
  },
  {
    id: "consumers",
    label: "Consumer members",
    min: 4,
    max: 14,
    step: 1,
    value: 8,
    unit: "",
    group: "Consumers",
    help: "Members in the consumer group. Members beyond the partition count receive no partition and stay idle.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 1) return "crit";
  if (utilization >= 0.7) return "warn";
  return "ok";
}

interface PartitionState {
  index: number;
  load: number;
  capacity: number;
  utilization: number;
  lag: number;
  assigned: boolean;
  slow: boolean;
  processed: number;
}

interface Computed {
  incoming: number;
  partitionCount: number;
  processingMs: number;
  stragglerMs: number;
  consumers: number;
  assigned: number;
  idle: number;
  slowIndex: number;
  slowCapacity: number;
  slowLag: number;
  slowLagPct: number;
  totalLag: number;
  processed: number;
  delay: number;
  partitions: PartitionState[];
}

function compute(p: Params, lags: number[]): Computed {
  const incoming = Math.max(1, num(p, "incomingRate", 8_000));
  const partitionCount = Math.max(2, Math.round(num(p, "partitionCount", 8)));
  const processingMs = Math.max(0.05, num(p, "processingMs", 0.5));
  const stragglerMs = Math.max(0, num(p, "stragglerMs", 0));
  const consumers = Math.max(1, Math.round(num(p, "consumers", 8)));
  const assigned = Math.min(consumers, partitionCount);
  const slowIndex = Math.min(SLOW_INDEX, partitionCount - 1);
  const normalCapacity = Math.min(20_000, 1_000 / processingMs);
  const slowCapacity = Math.min(20_000, 1_000 / (processingMs + stragglerMs));
  const load = incoming / partitionCount;
  const partitions: PartitionState[] = Array.from({ length: partitionCount }, (_, index) => {
    const isAssigned = index < assigned;
    const capacity = !isAssigned ? 0 : index === slowIndex ? slowCapacity : normalCapacity;
    const lag = Math.max(0, lags[index] ?? 0);
    const utilization = capacity > 0 ? load / capacity : 1;
    const processed = capacity <= 0 ? 0 : lag > 0 ? capacity : Math.min(capacity, load);
    return {
      index,
      load,
      capacity,
      utilization,
      lag,
      assigned: isAssigned,
      slow: index === slowIndex && stragglerMs > 0,
      processed,
    };
  });
  const slow = partitions[slowIndex];
  const totalLag = partitions.reduce((sum, partition) => sum + partition.lag, 0);
  return {
    incoming,
    partitionCount,
    processingMs,
    stragglerMs,
    consumers,
    assigned,
    idle: Math.max(0, consumers - partitionCount),
    slowIndex,
    slowCapacity,
    slowLag: slow.lag,
    slowLagPct: slow.capacity > 0 ? (slow.lag / Math.max(1, slow.capacity)) * 100 : 100,
    totalLag,
    processed: partitions.reduce((sum, partition) => sum + partition.processed, 0),
    delay: slow.capacity > 0 ? slow.lag / slow.capacity : 300,
    partitions,
  };
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
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 11)) / 2.9);
  const seedValues: [string, number][] = [
    ["slow-consumer-load", values.slowCapacity > 0 ? (values.incoming / values.partitionCount / values.slowCapacity) * 100 : 100],
    ["slow-partition-lag", values.slowLag],
    ["queueDepth", values.totalLag],
    ["slow-processing-time", values.processingMs + values.stragglerMs],
    ["delivery-delay", values.delay],
    ["processed-rate", values.processed],
  ];
  for (const [id, value] of seedValues) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, t: number, lags: number[], flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, lags);
  const slow = values.partitions[values.slowIndex];
  const topicHealth = values.partitions.some((partition) => healthFor(partition.utilization) === "crit")
    ? "crit"
    : values.partitions.some((partition) => healthFor(partition.utilization) === "warn")
      ? "warn"
      : "ok";
  const producerHealth = values.incoming > values.processed * 1.5 ? "warn" : "ok";
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders producer",
        kind: "service",
        health: producerHealth,
        utilization: clamp(values.incoming / Math.max(1, values.processed)),
        throughput: values.incoming,
        sublabel: `${Math.round(values.incoming).toLocaleString("en-US")} rec/s`,
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders.events",
        kind: "queue",
        health: topicHealth,
        throughput: values.incoming,
        sublabel: `${values.partitionCount} partitions · ${Math.round(values.totalLag).toLocaleString("en-US")} behind`,
        detail: `The topic has ${values.partitionCount} partitions and ${values.consumers} group members. ${values.idle > 0 ? `${values.idle} members have no assignment.` : "Every member owns a partition."}`,
        meta: { depth: values.totalLag, partitions: values.partitionCount, idle: values.idle },
      },
      ...values.partitions.map((partition) => ({
        id: `consumer-${partition.index}`,
        label: `consumer-${partition.index}`,
        kind: "worker" as const,
        role: "shard" as const,
        health: partition.assigned ? healthFor(partition.utilization) : "crit",
        utilization: partition.assigned ? clamp(partition.utilization) : 1,
        throughput: partition.processed,
        capacity: partition.capacity,
        sublabel: partition.assigned
          ? `${(partition.utilization * 100).toFixed(0)}% · ${partition.lag > 0 ? `${Math.round(partition.lag).toLocaleString("en-US")} lag` : `${Math.round(partition.processed).toLocaleString("en-US")} rec/s`}`
          : "idle · no partition",
        detail: partition.assigned
          ? `Partition ${partition.index} delivers ${Math.round(partition.load).toLocaleString("en-US")} rec/s. This consumer can process ${Math.round(partition.capacity).toLocaleString("en-US")} rec/s${partition.slow ? ` because a downstream call adds ${values.stragglerMs.toFixed(1)}ms per record` : ""}. Lag is ${Math.round(partition.lag).toLocaleString("en-US")} records.`
          : `This member joined the group but the topic has ${values.partitionCount} partitions, all already assigned. It processes nothing.`,
        meta: {
          partition: partition.index,
          load: partition.load,
          loadPct: partition.utilization * 100,
          lag: partition.lag,
          processingMs: values.processingMs + (partition.slow ? values.stragglerMs : 0),
          slow: partition.slow ? 1 : 0,
        },
      })),
    ],
    edges: [
      edge("producer-topic", "producer", "topic", values.incoming / Math.max(1, values.processed), producerHealth),
      ...values.partitions
        .filter((partition) => partition.assigned)
        .map((partition) =>
          edge(
            `topic-consumer-${partition.index}`,
            "topic",
            `consumer-${partition.index}`,
            clamp(partition.processed / Math.max(1, partition.load)),
            healthFor(partition.utilization),
          ),
        ),
    ],
    metrics: [
      metric("slow-consumer-load", "Slow consumer load", slow.capacity > 0 ? slow.utilization * 100 : 100, "%", 85, 120, "percent"),
      metric("slow-partition-lag", "Slow partition lag", values.slowLag, " rec", 2_000, 10_000, "count"),
      metric("queueDepth", "Total topic lag", values.totalLag, " rec", undefined, undefined, "count"),
      metric("slow-processing-time", "Slow processing time", values.processingMs + values.stragglerMs, "ms", 2, 4, "ms"),
      metric("delivery-delay", "Delivery delay", values.delay, " s", 30, 120, "count"),
      metric("processed-rate", "Processed rate", values.processed, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      seed: Number(flags.seed ?? 0),
      lagJson: JSON.stringify(values.partitions.map((partition) => partition.lag)),
      slowIndex: values.slowIndex,
    },
    summary: `Consumer-${values.slowIndex} is at ${(slow.utilization * 100).toFixed(0)}% of its capacity with ${Math.round(values.slowLag).toLocaleString("en-US")} records behind; ${values.idle} member(s) idle.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const slowConsumersModel: SimModel = {
  id: "streaming-slow-consumers",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, [], { seed });
    seedSeries(frame, compute(defaults(), []), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const base = compute(p, []);
    const previous = readLags(frame.flags.lagJson, base.partitionCount);
    const lags = base.partitions.map((partition) => {
      const lag = previous[partition.index] ?? 0;
      const excess = partition.load - partition.capacity;
      if (excess > 0) return Math.min(MAX_LAG, lag + excess * seconds);
      return Math.max(0, lag + excess * seconds);
    });
    const t = frame.t + seconds;
    const next = buildFrame(p, t, lags, frame.flags);
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes) {
      if (typeof node.meta?.partition === "number") {
        recordSeries(next, `lag.partition-${node.meta.partition}`, Number(node.meta.lag ?? 0));
      }
    }

    const values = compute(p, lags);
    const slow = values.partitions[values.slowIndex];
    if (values.stragglerMs > 0 && slow.utilization >= 1 && frame.flags.slowDetected !== 1) {
      pushEvent(next, {
        id: "slow-consumer-detected",
        at: t,
        severity: "crit",
        title: "One consumer is slower than its partition's arrival rate",
        detail: `Partition ${values.slowIndex} delivers ${Math.round(slow.load).toLocaleString("en-US")} rec/s to a consumer that can process ${Math.round(slow.capacity).toLocaleString("en-US")} rec/s. The extra ${values.stragglerMs.toFixed(1)}ms per record is isolated to this member.`,
        nodeId: `consumer-${values.slowIndex}`,
        metricId: "slow-consumer-load",
      });
      next.flags.slowDetected = 1;
    }
    if (values.stragglerMs === 0) next.flags.slowDetected = 0;

    if (values.idle > 0 && frame.flags.idleDetected !== 1) {
      pushEvent(next, {
        id: "idle-consumer",
        at: t,
        severity: "info",
        title: "A group member has no partition",
        detail: `${values.consumers} members for ${values.partitionCount} partitions. ${values.idle} member(s) cannot own work, so they do not add throughput.`,
        metricId: "processed-rate",
      });
      next.flags.idleDetected = 1;
    }
    if (values.idle === 0) next.flags.idleDetected = 0;

    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds: [
    {
      id: "slow-consumer-load",
      metricId: "slow-consumer-load",
      warn: 85,
      crit: 120,
      title: "One consumer is above its processing capacity",
      cause:
        "The partition delivers records faster than this member can process them. Per-record processing time on one member, often a downstream call, is the difference. The other partitions can be current, so the group average looks healthy.",
      fix:
        "Find the slow span or downstream call and remove it from the hot path. If the member is healthy but the partition is simply too large, split the key space into more partitions or move a class of records off this stream. Adding members does not split one partition.",
      checkFirst: [
        "Compare processing time per consumer member, not just the group average.",
        "Trace the slow member's downstream calls and look for a latency step change.",
        "Check whether the partition carries a hot key or a heavy record shape.",
      ],
    },
    {
      id: "slow-partition-lag",
      metricId: "slow-partition-lag",
      warn: 2_000,
      crit: 10_000,
      title: "The slow partition's backlog is growing without bound",
      cause:
        "Arrival rate on the partition is above this consumer's capacity. While the gap persists, lag grows by the difference every second, and the partition falls further behind even if the rest of the group is fine.",
      fix:
        "Restore the consumer's processing rate or reduce the records sent to that partition. Check for a downstream timeout, a poison record, and a key that dominates the partition before adding capacity that cannot be assigned.",
      checkFirst: [
        "Graph lag for each partition and confirm that only one is diverging.",
        "Check consumer logs for retries, timeouts, or a record that repeats.",
        "Check the assignment: is the slow member also the only member for that partition?",
      ],
    },
    {
      id: "slow-processing-time",
      metricId: "slow-processing-time",
      warn: 2,
      crit: 4,
      title: "Per-record processing time exceeds the consumer budget",
      cause:
        "A downstream call, a synchronous write, or heavier records increased the time to process one record on one member. Capacity falls in proportion, so a small latency increase can turn a stable partition into a growing backlog.",
      fix:
        "Remove the synchronous call from the consumer path, batch or cache the downstream work, add a timeout and fallback, and verify the capacity of the partition after the change.",
      checkFirst: [
        "Check the p99 of the downstream dependency during the same window.",
        "Check whether the slowdown is per record, per batch, or only for one key.",
        "Check whether retries are included in the measured processing time.",
      ],
    },
  ],
  insights: (_frame, p) => {
    const values = compute(p, []);
    const slow = values.partitions[values.slowIndex];
    const items: string[] = [];
    items.push(
      `Consumer-${values.slowIndex} can process ${Math.round(slow.capacity).toLocaleString("en-US")} rec/s while its partition delivers ${Math.round(slow.load).toLocaleString("en-US")} rec/s. ${values.stragglerMs > 0 ? `The extra ${values.stragglerMs.toFixed(1)}ms belongs to this member.` : "No member has extra processing time."}`,
    );
    if (values.idle > 0) {
      items.push(`${values.idle} of ${values.consumers} members have no partition. They are idle by assignment, not by choice.`);
    } else {
      items.push(`Every one of the ${values.consumers} members owns a partition, so a new member needs an existing partition to be released before it can help.`);
    }
    if (values.slowLag > 0) {
      items.push(`The slow partition holds ${Math.round(values.slowLag).toLocaleString("en-US")} records. At ${Math.round(slow.capacity).toLocaleString("en-US")} rec/s, that is ${Math.round(values.delay).toLocaleString("en-US")} seconds of delay for the next record.`);
    }
    items.push("A slow consumer is a capacity problem on one partition. A hot partition is a distribution problem. Both produce one bad partition, so check processing time and key share before choosing a fix.");
    return items;
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
    description: "Eight partitions and eight consumers, each at half its processing capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher traffic puts every consumer at 87% of capacity, but none is falling behind.",
    tone: "warn",
    params: defaults({ incomingRate: 14_000 }),
  },
  {
    id: "failure",
    label: "Slow consumer",
    description: "One consumer waits an extra 5ms per record on a downstream call and cannot keep up.",
    tone: "crit",
    params: defaults({ incomingRate: 14_000, stragglerMs: 5 }),
  },
  {
    id: "recovery",
    label: "Fix downstream",
    description: "The downstream wait is removed and traffic returns to a level the group can sustain.",
    tone: "ok",
    params: defaults({ incomingRate: 10_000, stragglerMs: 0 }),
  },
  {
    id: "add-consumer",
    label: "Add a consumer",
    description: "A ninth member joins an eight-partition group. It has no partition to process.",
    tone: "crit",
    params: defaults({ incomingRate: 14_000, stragglerMs: 5, consumers: 9 }),
  },
];

const experiment: Experiment = {
  id: "predict-slow-consumer",
  title: "Predict what a ninth consumer buys",
  simId: "slow-consumers",
  question:
    "An eight-partition group has eight consumers. One consumer is 10x slower because a downstream call adds 5ms per record. You add a ninth consumer. What happens to the slow partition's lag?",
  prediction: {
    options: [
      { id: "split", label: "It drains twice as fast because two consumers share the partition" },
      { id: "unchanged", label: "It keeps growing because one partition is assigned to one consumer" },
      { id: "rebalance", label: "The group rebalances the record across the new member" },
      { id: "all", label: "Every partition speeds up because there are more members" },
    ],
    correctOptionId: "unchanged",
    explanation:
      "Kafka assigns each partition to at most one consumer in a group. With eight partitions and eight consumers, a ninth member has no partition to own and sits idle. The slow partition still has one consumer, still waits on the same downstream call, and still receives records faster than it can process them. Lag keeps growing at the same rate.",
  },
  setup: defaults({ incomingRate: 14_000, stragglerMs: 5, consumers: 9 }),
  runFor: 30,
  observe: [
    "Lag on the slow partition keeps rising after the ninth member joins.",
    "The ninth member shows no assignment and processes no records.",
    "The other seven partitions stay current, so a group-level lag average looks small.",
    "Processing time on the slow member does not change when the member count changes.",
  ],
  explain:
    "The partition is the unit of assignment, not the record. One consumer owns all of its records, so its processing time is the partition's ceiling. More members only help when there are unassigned partitions. To fix this failure you must reduce the slow member's per-record time, reduce the records sent to that partition, or move part of the key space to another partition with a key redesign. Adding a member is the one action that cannot change the slow partition's rate.",
  fix: defaults({ incomingRate: 10_000, stragglerMs: 0, consumers: 8 }),
  debrief:
    "With the downstream wait removed, the slow member processes about 2,000 rec/s against a 1,250 rec/s load, so its backlog drains. The group is back to one member per partition and no one is idle. The tradeoff is real work: the downstream call had to be removed, cached, or moved off the synchronous path. If it cannot be removed, the alternative is to split the partition's key space or accept the lag as a product decision.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A slow consumer is a group member that processes records below the rate its partition receives them. Kafka assigns each partition to one consumer in a group. That consumer owns the partition's records in order, so its processing time sets the partition's ceiling. If the partition receives 1,250 records per second and the member can process 1,200, the backlog grows by 50 records every second. The other members can be completely current, which is why a group average hides the problem.",
  },
  {
    type: "p",
    text: "Slow is relative to the partition, not to the other consumers. The cause is usually one of three things: a downstream call that adds latency on this member, a heavier record shape that only this partition receives, or a poison record that fails and is retried. A hot key is a different failure: the partition receives too many records, not too little capacity. They look similar on a lag chart and need different fixes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, partition, consumer member, downstream service. The producer chooses the partition. The broker appends and replicates. The group assigns the partition to one member, and that member polls, processes, and commits an offset. A synchronous downstream write sits inside the processing loop, so its latency is multiplied by the number of records. A retry sits there too. The partition cannot move to another member while the group is stable, and a new member cannot take half of its records.",
  },
  {
    type: "table",
    headers: ["Signal", "What it suggests", "What it does not prove"],
    rows: [
      ["One partition's lag grows, others are current", "One member or one key is the bottleneck", "Whether the cause is slow processing or extra load"],
      ["Processing time is high on one member", "Downstream latency, retries, or heavy records", "Which downstream call or which record shape"],
      ["Load per partition is uneven", "Hot key or partition skew", "That the consumer is slow"],
      ["Lag grows during retries and resets", "Poison record or failing dependency", "That adding members will help"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 2,000 to 30,000 records per second, 4 to 12 partitions, and 0.2 to 2 milliseconds of processing time per record. They are teaching values, not Kafka limits or a benchmark. The shape of the failure is the lesson: one member's processing time falls below its partition's arrival rate, and only that partition diverges.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Slow consumer load: the slow member's arrival rate as a percentage of its processing capacity. Warning at 85%, critical at 120%.",
      "Slow partition lag: records behind on that one partition. Warning at 2,000, critical at 10,000.",
      "Slow processing time: milliseconds per record on the slow member, including the downstream wait.",
      "Delivery delay: the slow partition's lag divided by its processing rate, in seconds.",
      "A queue view with the topic, one consumer card per partition, and idle members called out.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Slow consumer. Compare the one failing consumer card with the current ones. Run the experiment before moving sliders: predict what a ninth member will do. Then try Add a consumer, Recovery, and your own combination of downstream wait and traffic.",
  },
  { type: "sim", simId: "slow-consumers" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One consumer waited an extra 5 milliseconds per record. Its capacity fell from 2,000 to about 182 records per second, while its partition still delivered 1,750. The backlog grew by roughly 1,568 records every second, and the other seven consumers stayed current. The topic total rose, but the failure was one member's processing loop. Adding a ninth member left one member idle and did not change the slow partition at all.",
  },
  {
    type: "p",
    text: "Recovery removed the downstream wait and reduced traffic. The same member could then process 2,000 records per second against a 1,250 load, so the backlog drained. The group returned to one member per partition. The cost was fixing the downstream call, not buying more consumers.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer metrics by member: records-consumed-rate, records-lag-max, fetch-latency-avg, and commit-latency-avg.",
      "Per-partition lag: log-end offset minus the committed offset, grouped by partition and by member assignment.",
      "Traces: the downstream span inside the poll loop, its p99, and the retry count per record.",
      "Logs: repeated processing errors for the same offset, timeouts, and rebalance events.",
      "Group state: members with no assignment, and partitions whose owner changes during the incident.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check lag per partition and per member. If one partition is behind, compare its member's processing time with its peers. Then check the downstream span and the retry count before adding a consumer. Finally, check whether the partition is carrying a hot key or an unusually heavy record.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the slow partition and the member that owns it. Do not act on a group-level lag average.",
      "Compare per-record processing time across members and find the span that is different.",
      "If a downstream call is the cause, add a timeout, cache or batch the call, or move it out of the synchronous path.",
      "If a poison record is repeating, bound retries and quarantine the record before resuming the partition.",
      "If the partition is simply too large, split its key space with a documented key change or move a record class to another stream.",
      "Add consumer members only when partitions are unassigned. Otherwise they sit idle.",
      "Re-run at peak and verify slow-partition lag, processing time, delivery delay, and idle members together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Fixing the downstream call preserves ordering but may require a cache, a batch API, or an asynchronous write with its own consistency cost.",
      "Splitting the key space adds parallelism but changes ordering scope and requires a migration.",
      "Skipping or quarantining a poison record keeps the partition moving but loses the record or moves the failure to another queue.",
      "Adding consumers is cheap only when the group has fewer members than partitions; otherwise it adds idle members and rebalance cost.",
      "A larger processing timeout can hide a slow call until the backlog is too large to drain within the freshness budget.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-slow-consumer",
    question:
      "One partition's lag is growing while the other seven are current. The group has eight consumers and eight partitions. How do you find the cause?",
    difficulty: 3,
    hints: [
      "Start with the member that owns the partition, not the group average.",
      "Separate arrival rate from processing rate before choosing a fix.",
    ],
    answer:
      "I would graph lag per partition and confirm that only one is diverging. Then I would find the member that owns it and compare its processing time and throughput with its peers. If its arrival rate matches the other partitions, the member is slow; I would trace the downstream calls inside the poll loop and check for timeouts, retries, or a record shape that only this partition gets. If its arrival rate is higher, the partition is hot and the fix is on the key or distribution side. I would also check whether the member is the only owner and whether a rebalance is moving the partition repeatedly. The group total would not tell me which of those is true.",
    followUps: [
      "What would you check if processing time is normal but throughput is low?",
      "How would you distinguish a hot key from a slow downstream call?",
      "When would you add a consumer member?",
    ],
    redFlags: [
      "Adds consumers before checking partition assignment.",
      "Uses only group-level lag.",
      "Assumes the broker is slow without tracing the consumer.",
    ],
    rubric: [
      "Uses per-partition lag and per-member processing time.",
      "Separates arrival rate from processing rate.",
      "Names a downstream or record-level check.",
      "Explains when adding members cannot help.",
    ],
  },
  {
    id: "slow-versus-hot",
    question:
      "A partition is behind. How do you tell a slow consumer from a hot partition, and why does the distinction matter?",
    difficulty: 3,
    hints: [
      "Compare the partition's arrival rate with its peers.",
      "The same lag symptom has two different fixes.",
    ],
    answer:
      "A hot partition receives more records than its peers because of key skew; a slow consumer receives a normal share but processes it below the rate. I would compare per-partition produce rate and per-member processing time. If the partition's load is several times the average, it is hot; the fix is a key change, salting, or a partition split. If its load is normal and its processing time is high, the consumer is slow; the fix is the downstream call, retries, or the record shape. The distinction matters because adding consumers or partitions does not fix a slow member, and optimizing the member does nothing for a hot key.",
    followUps: [
      "What if both are true at once?",
      "Which signal would you alert on first?",
      "How does ordering constrain each fix?",
    ],
    redFlags: [
      "Treats every lag as a capacity problem.",
      "Adds partitions without checking key distribution.",
      "Optimizes the consumer without checking its load.",
    ],
    rubric: [
      "Compares arrival rate and processing time.",
      "Names different fixes for each cause.",
      "States the ordering consequence.",
    ],
  },
  {
    id: "preserve-order",
    question:
      "You need to fix a slow consumer without breaking order for one entity. What options do you have?",
    difficulty: 3,
    hints: [
      "Ordering is per partition, and the entity currently lives on one partition.",
      "A slower but correct path may be better than a parallel path that reorders.",
    ],
    answer:
      "I would first try to keep the entity on one partition and make that consumer faster: remove the synchronous downstream call, cache it, batch records, or add a bounded concurrency inside the poll loop while preserving per-key order. If the partition is simply too large, I would split by a dimension that does not break the entity's order, or move unrelated records to another stream. Salting the entity would spread its records across partitions and lose total order, so I would only do that if consumers can merge by version or sequence. Adding a member is not an option while every partition is assigned, and increasing partitions remaps keys, so both need a migration plan.",
    followUps: [
      "How would you preserve order with in-consumer concurrency?",
      "What does salting cost the reader?",
      "How would you migrate a keyed topic to more partitions?",
    ],
    redFlags: [
      "Salts the key without changing consumers.",
      "Assumes Kafka splits a partition across members.",
      "Ignores the migration window.",
    ],
    rubric: [
      "States the per-partition ordering boundary.",
      "Offers a fix that preserves entity order.",
      "Describes the cost of salting or repartitioning.",
      "Includes a verification step.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show lag, processing time, and throughput per partition and per member.",
      "The downstream calls inside the consumer poll loop have latency and timeout alerts.",
      "Consumer capacity per partition is known at the target record size.",
      "There is a documented key-split or poison-record runbook with an ordering plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the slow partition and its owner before changing capacity.",
      "Compare processing time across members and trace the slow span.",
      "Check for a repeating record or a failing downstream dependency.",
      "Do not add members beyond the partition count; check assignments first.",
      "Record the partition, member, offsets, and timestamps for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify per-partition lag and processing time at peak.",
      "Remove temporary skips or quarantines and reconcile the dropped records.",
      "Document whether ordering was preserved and what changed.",
      "Add a load test that includes the slow downstream path and the real record mix.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: consumer configs",
    url: "https://kafka.apache.org/documentation/#consumerconfigs",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Consumer fetch, poll, and commit settings that shape per-member processing.",
  },
  {
    title: "Confluent documentation: Kafka monitoring",
    url: "https://docs.confluent.io/platform/current/kafka/monitoring.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Consumer lag, fetch latency, and per-partition monitoring metrics.",
  },
  {
    title: "Apache Kafka documentation: the consumer",
    url: "https://kafka.apache.org/documentation/#theconsumer",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Consumer groups, partition assignment, and the per-partition ordering boundary.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "slow-consumers": {
      model: slowConsumersModel,
      presets,
      instructions:
        "Start Healthy, apply Slow consumer, and compare the slow consumer card with its peers. Then try Add a consumer and Recovery. Watch per-partition lag and processing time, not the group total.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Rates, processing times, and partition counts are teaching values, not Kafka limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-consumer-lag",
    "streaming-consumer-groups",
    "streaming-hot-partition",
    "streaming-rebalancing",
    "streaming-poison-messages",
  ],
};
