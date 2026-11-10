import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const GROUP_CAPACITY = 100;

const params = [
  {
    id: "groups",
    label: "Message groups",
    min: 1,
    max: 1_000,
    step: 1,
    value: 100,
    unit: "",
    group: "Queue",
    help: "Distinct MessageGroupId values in use. One group is processed in order by at most one consumer at a time.",
    format: "count" as const,
  },
  {
    id: "hotGroupShare",
    label: "Hottest group share",
    min: 0,
    max: 95,
    step: 1,
    value: 5,
    unit: "%",
    group: "Traffic",
    help: "Share of messages that carry one MessageGroupId. That group cannot be split across consumers.",
    format: "percent" as const,
  },
  {
    id: "arrivalRate",
    label: "Arrival rate",
    min: 10,
    max: 5_000,
    step: 10,
    value: 300,
    unit: " msg/s",
    group: "Traffic",
    help: "Messages sent per second across all groups.",
    format: "rps" as const,
  },
  {
    id: "consumers",
    label: "Consumers",
    min: 1,
    max: 200,
    step: 1,
    value: 20,
    unit: "",
    group: "Consumers",
    help: "Parallel consumers. Useful parallelism is capped by the number of active message groups, not by consumer count.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  groups: number;
  hotShare: number;
  arrival: number;
  consumers: number;
  hotLoad: number;
  hotCapacity: number;
  fleetCapacity: number;
  totalDepth: number;
  hotDepth: number;
  oldestAge: number;
  consumerUtil: number;
  effectiveConsumers: number;
}

function compute(p: Params, totalDepth: number, hotDepth: number): Values {
  const groups = Math.round(clamp(num(p, "groups", 100), 1, 1_000));
  const hotShare = clamp(num(p, "hotGroupShare", 5) / 100, 0, 0.95);
  const arrival = Math.round(clamp(num(p, "arrivalRate", 300), 10, 5_000));
  const consumers = Math.round(clamp(num(p, "consumers", 20), 1, 200));
  const hotLoad = arrival * hotShare;
  const hotCapacity = GROUP_CAPACITY;
  const effectiveConsumers = Math.min(consumers, groups);
  const fleetCapacity = effectiveConsumers * GROUP_CAPACITY;
  const oldestAge = totalDepth > 0 ? totalDepth / Math.max(1, fleetCapacity) + 0.5 : 0.5;
  return {
    groups,
    hotShare,
    arrival,
    consumers,
    hotLoad,
    hotCapacity,
    fleetCapacity,
    totalDepth,
    hotDepth,
    oldestAge,
    consumerUtil: (Math.min(arrival, fleetCapacity) / Math.max(1, fleetCapacity)) * 100,
    effectiveConsumers,
  };
}

function buildFrame(p: Params, seed: number, totalDepth: number, hotDepth: number): SimFrame {
  const values = compute(p, totalDepth, hotDepth);
  const hotHealth = values.hotDepth >= 10_000 ? "crit" : values.hotDepth >= 1_000 ? "warn" : "ok";
  const queueHealth = hotHealth;
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Order events",
        kind: "service",
        health: "ok",
        utilization: clamp(values.arrival / 5_000),
        throughput: values.arrival,
        sublabel: `${values.arrival} msg/s · ${values.groups} groups`,
        detail: `Messages are published with a MessageGroupId. The hottest group carries ${(values.hotShare * 100).toFixed(0)}% of traffic.`,
        meta: { view: "queue" },
      },
      {
        id: "queue",
        label: "orders.fifo",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(values.consumerUtil / 100),
        throughput: values.arrival,
        capacity: values.fleetCapacity,
        sublabel: `${Math.round(values.totalDepth).toLocaleString("en-US")} waiting`,
        detail: `FIFO order is per message group. ${values.effectiveConsumers} of ${values.consumers} consumers can be active because only ${values.groups} groups exist. The hot group has ${Math.round(values.hotDepth).toLocaleString("en-US")} messages queued.`,
        meta: { view: "queue", depth: values.totalDepth },
      },
      {
        id: "consumers",
        label: "Consumer fleet",
        kind: "worker",
        health: hotHealth,
        utilization: clamp(values.consumerUtil / 100),
        throughput: Math.min(values.arrival, values.fleetCapacity),
        capacity: values.fleetCapacity,
        sublabel: `${values.consumers} consumers · ${values.effectiveConsumers} useful`,
        detail: `Each group is processed by one consumer at a time. The fleet can process about ${values.fleetCapacity.toLocaleString("en-US")} messages/s across ${values.effectiveConsumers} active groups. ${values.hotLoad > values.hotCapacity ? "The hot group receives more than one consumer can process, so its backlog grows regardless of fleet size." : "The hot group fits within one consumer's capacity."}`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("producer-queue", "producer", "queue", clamp(values.arrival / 5_000), queueHealth),
      edge("queue-consumers", "queue", "consumers", clamp(values.consumerUtil / 100), hotHealth),
    ],
    metrics: [
      metric("hot-group-depth", "Hot group backlog", values.hotDepth, " messages", 1_000, 10_000, "count"),
      metric("oldest-age", "Oldest message age", values.oldestAge, " s", 60, 300, "ms"),
      metric("queueDepth", "Messages waiting", values.totalDepth, " messages", undefined, undefined, "count"),
      metric("consumer-util", "Fleet utilization", values.consumerUtil, "%", 80, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      totalDepthJson: String(values.totalDepth),
      hotDepthJson: String(values.hotDepth),
      groups: values.groups,
    },
    summary: `${values.groups} groups, ${values.consumers} consumers: hot group has ${Math.round(values.hotDepth).toLocaleString("en-US")} queued and ${(values.hotShare * 100).toFixed(0)}% of traffic.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "hot-group-depth", Math.max(0, values.hotDepth * (0.96 + 0.04 * Math.sin(index / 2.4))));
    recordSeries(frame, "oldest-age", Math.max(0, values.oldestAge * (0.97 + 0.03 * Math.sin(index / 2.1))));
    recordSeries(frame, "queueDepth", Math.max(0, values.totalDepth * (0.97 + 0.03 * Math.sin(index / 2.6))));
    recordSeries(frame, "consumer-util", Math.max(0, values.consumerUtil * (0.99 + 0.01 * Math.sin(index / 2.2))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-group-depth",
    metricId: "hot-group-depth",
    warn: 1_000,
    crit: 10_000,
    title: "One message group is backing up",
    cause:
      "FIFO processes one group in order on one consumer at a time. If one MessageGroupId carries more traffic than a single consumer can process, its backlog grows even when the rest of the fleet is idle.",
    fix:
      "Redesign the group key so the hot entity is split into ordered subkeys, or reduce its message rate. Adding consumers cannot split an in-order group.",
    checkFirst: [
      "Count messages per MessageGroupId and find the top group.",
      "Compare the hot group's arrival rate with one consumer's processing rate.",
      "Check whether a tenant, customer, or device is over-represented in one group.",
    ],
  },
  {
    id: "oldest-age",
    metricId: "oldest-age",
    warn: 60,
    crit: 300,
    title: "The FIFO backlog is older than the business allows",
    cause:
      "Total arrival rate exceeds the fleet's effective capacity, or one serialized group holds the queue head. Age grows with backlog and with the time to drain it.",
    fix:
      "Raise effective group parallelism, reduce processing time, or shed low-value work. Track age by group, because the topic total hides the serialized one.",
    checkFirst: [
      "Check ApproximateAgeOfOldestMessage for the queue.",
      "Check hot-group depth and per-group consumer assignment.",
      "Check whether processing time changed recently.",
    ],
  },
  {
    id: "consumer-util",
    metricId: "consumer-util",
    warn: 80,
    crit: 95,
    title: "The consumer fleet is saturated",
    cause:
      "Effective parallelism is capped by the number of message groups. Consumers beyond the group count have nothing to poll, while the groups that do exist stay busy.",
    fix:
      "Increase group cardinality to use more consumers, or reduce per-message work. Do not add consumers without checking the group count.",
    checkFirst: [
      "Compare consumer count with the number of active message groups.",
      "Check whether consumers are idle because groups are already assigned.",
      "Check downstream capacity before adding more parallelism.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const sqsFifoModel: SimModel = {
  id: "streaming-sqs-fifo",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, 0);
    const frame = buildFrame(defaults(), seed, 0, 0);
    seedSeries(frame, values);
    return frame;
  },
  step: (frame, p, dt) => {
    const total = Number(frame.flags.totalDepthJson ?? 0);
    const hot = Number(frame.flags.hotDepthJson ?? 0);
    const base = compute(p, total, hot);
    const seconds = Math.min(1, Math.max(0.01, dt));
    const totalExcess = Math.max(0, base.arrival - base.fleetCapacity);
    const hotExcess = Math.max(0, base.hotLoad - base.hotCapacity);
    const nextTotal = Math.max(0, total + (totalExcess > 0 ? totalExcess : base.arrival - base.fleetCapacity) * seconds);
    const nextHot = Math.max(0, hot + (hotExcess > 0 ? hotExcess : -base.hotCapacity) * seconds);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), nextTotal, nextHot);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0, 0);
    const items: string[] = [];
    items.push(
      `${values.effectiveConsumers} of ${values.consumers} consumers can be active with ${values.groups} groups. Parallelism is group-bound, not consumer-bound.`,
    );
    items.push(
      `The hot group carries ${Math.round(values.hotLoad).toLocaleString("en-US")} msg/s against one group's ${values.hotCapacity} msg/s capacity. ${values.hotLoad > values.hotCapacity ? "Its backlog grows no matter how many consumers you add." : "It fits within one consumer's capacity."}`,
    );
    items.push("FIFO ordering is per MessageGroupId. Two groups have no order relationship, so spreading traffic across groups preserves order within each customer and adds parallelism between customers.");
    items.push("Standard queues offer higher throughput but no ordering. FIFO with one group is an ordered single lane; the design question is how many lanes the business actually needs.");
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
    description: "100 groups, a 5% hot group, and 20 consumers with headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "500 messages/s with a 25% hot group; the hot group is slightly over one consumer's capacity.",
    tone: "warn",
    params: defaults({ groups: 50, hotGroupShare: 25, arrivalRate: 500, consumers: 50 }),
  },
  {
    id: "failure",
    label: "Hot group",
    description: "A 10-group queue where one customer is 80% of 2k messages/s and 50 consumers wait.",
    tone: "crit",
    params: defaults({ groups: 10, hotGroupShare: 80, arrivalRate: 2_000, consumers: 50 }),
  },
  {
    id: "recovery",
    label: "Split the group",
    description: "The hot customer is split into ordered subkeys; 200 groups and 100 consumers carry the load.",
    tone: "ok",
    params: defaults({ groups: 200, hotGroupShare: 5, arrivalRate: 2_000, consumers: 100 }),
  },
  {
    id: "single-group",
    label: "One group",
    description: "Ordering for the whole tenant in one group caps throughput at one consumer.",
    tone: "crit",
    params: defaults({ groups: 1, hotGroupShare: 100, arrivalRate: 500, consumers: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-fifo-scale",
  title: "Predict what more consumers buy",
  simId: "sqs-fifo",
  question:
    "A FIFO queue has one hot message group carrying 1,600 messages/s. One consumer can process 100 messages/s from a group. You add 40 consumers. What happens to the hot group's backlog?",
  prediction: {
    options: [
      { id: "fixed", label: "It drains because 40 consumers process the group in parallel" },
      { id: "same", label: "It keeps growing because only one consumer can process that group at a time" },
      { id: "slower", label: "It drains slower because FIFO adds coordination overhead" },
      { id: "dlq", label: "It moves to the DLQ automatically" },
    ],
    correctOptionId: "same",
    explanation:
      "FIFO preserves order within a message group, so at most one consumer processes a group at a time. The hot group's ceiling is one consumer's rate, about 100 messages/s. Additional consumers help only other groups. The backlog keeps growing until the group key is split or the arrival rate falls.",
  },
  setup: defaults({ groups: 10, hotGroupShare: 80, arrivalRate: 2_000, consumers: 50 }),
  runFor: 30,
  observe: [
    "The hot group's backlog grows at arrival times share minus one consumer's capacity.",
    "Most consumers are idle once every group has an owner.",
    "Splitting the hot group into subkeys adds order-preserving parallelism.",
    "The queue total hides the single serialized group.",
  ],
  explain:
    "A FIFO queue is a set of ordered lanes, one per message group. Throughput scales with the number of active groups, up to the consumer count, not with consumers alone. A hot group is a single lane. The fix changes the group key so one customer's work is split into multiple ordered substreams, or reduces that customer's rate. Either way, the consumer must understand the new key.",
  fix: defaults({ groups: 200, hotGroupShare: 5, arrivalRate: 2_000, consumers: 100 }),
  debrief:
    "The fix splits the hot customer into ordered subkeys and raises group cardinality. The hot lane falls from 1,600 to about 100 messages/s, so a single consumer keeps up and the fleet has headroom. The cost is that order is now per subkey, and any consumer that needs the customer's total order must merge the substreams.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon SQS FIFO is a queue type that preserves order within a message group. Every message carries a MessageGroupId; SQS delivers messages from one group in order and does not let a second consumer process that group concurrently. Different groups have no ordering relationship, so they can be processed in parallel. A FIFO queue is therefore a set of ordered lanes, not one global queue.",
  },
  {
    type: "p",
    text: "FIFO also provides deduplication: a producer can set a MessageDeduplicationId, and SQS suppresses duplicates of that ID within a five-minute window. That handles producer retries, not consumer redelivery. Ordering and deduplication are separate properties, and neither makes a side effect idempotent after a visibility timeout.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, FIFO queue, message group, consumer. The group key is chosen by the producer and is the unit of both ordering and parallelism. Consumers poll the queue; SQS leases messages in order within a group. The fleet's useful parallelism is the smaller of consumer count and active group count, with each group limited to one in-flight consumer at a time.",
  },
  {
    type: "table",
    headers: ["Group design", "Ordering", "Parallelism", "Risk"],
    rows: [
      ["One group for everything", "Global order", "One consumer", "Throughput ceiling and head-of-line blocking"],
      ["One group per customer", "Per customer", "Up to customer count", "A large customer becomes a hot lane"],
      ["Customer plus shard", "Per customer shard", "Customer count times shards", "Consumers must merge shards for total order"],
      ["One group per device", "Per device", "Up to device count", "High cardinality and uneven device rates"],
    ],
  },
  {
    type: "p",
    text: "This module uses up to 1,000 groups, 5,000 messages/s, and 200 consumers. Those are illustrative teaching values. The shape of the failure is the lesson: the queue looks parallel, but one group serializes and its backlog grows while the fleet has spare consumers.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot group backlog: messages queued for the busiest MessageGroupId. Warning at 1,000, critical at 10,000.",
      "Oldest message age: how long the head of the queue has waited. Warning at 60 seconds, critical at 300.",
      "Fleet utilization and the number of consumers that can actually be active.",
      "A queue view with producers, the FIFO queue depth, and the consumer fleet.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, apply Hot group, and run the experiment before adding consumers. Compare Split the group with One group, and watch hot-group backlog rather than the queue total.",
  },
  { type: "sim", simId: "sqs-fifo" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Ten groups and 50 consumers looked like plenty of parallelism. But the hottest group carried 80% of 2k messages/s, or 1,600 messages/s, and FIFO allows only one consumer to process a group at a time. That lane could handle 100 messages/s, so its backlog grew by 1,500 messages every second. The other 49 consumers had almost nothing to do.",
  },
  {
    type: "p",
    text: "Splitting the customer into ordered subkeys raised the group count and dropped the hot lane to about 100 messages/s. The fleet could then use its consumers, and the backlog drained. The trade was explicit: order became per subkey, so any reader that needs the customer's total order must merge the substreams by sequence.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ApproximateNumberOfMessagesVisible and ApproximateAgeOfOldestMessage for the queue, plus per-group depth from consumer logs or a custom metric.",
      "MessageGroupId distribution; the top group is the one to watch.",
      "Consumer concurrency and idle consumers, which reveal group-bound parallelism.",
      "ReceiveCount and deduplication IDs, which separate redelivery from producer retries.",
      "Downstream latency inside the handler, which can make even one lane slower.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count messages per group before adding consumers. Compare the hot group's arrival rate with one consumer's processing rate. Check whether consumers are idle because every group already has an owner. Then decide whether the group key can split without breaking the order the business needs.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the top MessageGroupId by message count and by age.",
      "Decide the real ordering unit: customer, account, device, or order.",
      "If order is per customer, split large customers into deterministic subkeys and make readers merge them.",
      "Raise group cardinality so consumers can be assigned across more lanes.",
      "Reduce handler time or batch work inside a group to raise the lane's throughput.",
      "Keep deduplication IDs stable across retries, and make the side effect idempotent.",
      "Alert on hot-group depth and age, not only on total queue depth.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More groups add parallelism but weaken any guarantee that depends on a single global order.",
      "Splitting a customer into subkeys requires consumers to merge or accept per-subkey order.",
      "One group gives the strongest order and the lowest throughput ceiling.",
      "FIFO throughput is lower than standard queues even before a hot group appears.",
      "Deduplication handles producer retries but not consumer redelivery.",
      "High group cardinality increases metadata and can hide skew in the total.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "fifo-parallelism",
    question:
      "A FIFO queue has 5 message groups and 50 consumers. Most consumers are idle. Why, and what do you change?",
    difficulty: 2,
    hints: [
      "One group is processed by one consumer at a time.",
      "Parallelism is bounded by groups, not consumers.",
    ],
    answer:
      "FIFO allows only one consumer to process a message group at a time, so five groups support at most five active consumers. The other 45 have no group to own. I would either increase group cardinality by choosing a finer ordering key, or reduce the number of consumers and use the savings elsewhere. Adding consumers alone cannot help until the group count rises.",
    followUps: [
      "What ordering guarantee do you lose with more groups?",
      "How would you size consumers to groups?",
      "When is a standard queue the better choice?",
    ],
    redFlags: [
      "Adds more consumers.",
      "Assumes FIFO parallelizes within a group.",
      "Ignores the ordering key.",
    ],
    rubric: [
      "States one consumer per group.",
      "Connects parallelism to group count.",
      "Names the ordering tradeoff.",
    ],
  },
  {
    id: "hot-group",
    question:
      "A single customer is 70% of FIFO traffic and its backlog keeps growing. How do you fix it without losing per-customer order?",
    difficulty: 4,
    hints: [
      "The group key is the ordering unit.",
      "Split the customer into ordered subkeys and merge on read.",
    ],
    answer:
      "I would split the customer's stream into deterministic subkeys, such as customer plus shard, and make each subkey a message group. That gives parallelism while preserving order within a subkey. Consumers that need total customer order must merge the substreams by sequence number and handle late or missing shards. If total order is mandatory and the rate exceeds one consumer, the real fix is to reduce the work per message or move that customer to a different processing model.",
    followUps: [
      "How many shards would you choose?",
      "How does a late subkey record affect the merge?",
      "What if the customer's events must be globally ordered?",
    ],
    redFlags: [
      "Adds consumers to one group.",
      "Splits without a merge plan.",
      "Claims order is unchanged.",
    ],
    rubric: [
      "Uses subkeys as groups.",
      "Describes a read-side merge.",
      "States when splitting is not enough.",
    ],
  },
  {
    id: "dedup-limit",
    question:
      "Does FIFO deduplication prevent a message from being processed twice after a visibility timeout?",
    difficulty: 3,
    hints: [
      "Deduplication applies to producer sends, not consumer redelivery.",
      "The dedup window is five minutes.",
    ],
    answer:
      "No. FIFO deduplication suppresses a second send with the same MessageDeduplicationId inside the five-minute window. It does not stop SQS from redelivering a message whose visibility timeout expired, and it does not stop a consumer from reprocessing after a crash. I still need an idempotent handler keyed on the business event, plus a visibility timeout that fits the work.",
    followUps: [
      "What happens after the five-minute window?",
      "Where should the idempotency key live?",
      "How does this differ from a standard queue?",
    ],
    redFlags: [
      "Treats dedup as consumer exactly-once.",
      "Ignores visibility redelivery.",
      "Assumes the window is unlimited.",
    ],
    rubric: [
      "Separates producer dedup from consumer redelivery.",
      "Names the five-minute window.",
      "Requires idempotent handlers.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The MessageGroupId is documented as the ordering unit, with its cardinality and top groups.",
      "Hot-group depth and oldest message age are monitored separately from queue totals.",
      "Consumer count is matched to active groups, not to desired throughput alone.",
      "Deduplication IDs are stable and handlers are idempotent.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the top group before adding consumers.",
      "Check whether the group key can split without breaking required order.",
      "Check idle consumers against the active group count.",
      "Protect downstream services while a hot lane drains.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify hot-group depth and age at peak.",
      "Document the subkey scheme and the merge behavior.",
      "Load-test with the real group distribution, not an even split.",
    ],
  },
];

const references = [
  {
    title: "Amazon SQS FIFO queues",
    url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-fifo-queues.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Message groups, ordering, deduplication, and FIFO throughput behavior.",
  },
  {
    title: "Amazon SQS quotas",
    url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/quotas-queues.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Throughput and message-group limits for FIFO queues.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "sqs-fifo": {
      model: sqsFifoModel,
      presets,
      instructions:
        "Start healthy, apply Hot group, then run the experiment. Compare Split the group and One group. Watch hot-group depth and useful consumers, not total queue depth.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Group counts, processing rates, and depths are teaching values, not SQS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-sqs-visibility", "streaming-keys-ordering", "streaming-hot-partition"],
};
