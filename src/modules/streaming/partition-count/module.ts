import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REPLICAS = 3;
const PER_BROKER_CAPACITY = 40_000;

const params = [
  {
    id: "partitionCount",
    label: "Partitions",
    min: 12,
    max: 400,
    step: 4,
    value: 48,
    unit: "",
    group: "Topic",
    help: "Number of partition logs. More partitions raise consumer parallelism and metadata work.",
    format: "count" as const,
  },
  {
    id: "brokerCount",
    label: "Brokers",
    min: 3,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Cluster",
    help: "Brokers that host partition leaders and replicas. Spreading partitions over more brokers lowers per-broker cost.",
    format: "count" as const,
  },
  {
    id: "recordRate",
    label: "Incoming records",
    min: 10_000,
    max: 200_000,
    step: 5_000,
    value: 60_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Produce rate. Broker capacity is fixed per broker in this model, so more partitions do not add CPU.",
    format: "rps" as const,
  },
  {
    id: "controllerFailover",
    label: "Controller failover",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 runs a controller election and the follow-on group rebalance; 0 leaves the cluster in steady state.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  partitions: number;
  brokers: number;
  recordRate: number;
  failover: boolean;
  perBrokerLeaders: number;
  fileHandles: number;
  failoverTime: number;
  rebalanceTime: number;
  p99: number;
  brokerCpu: number;
  shortfall: number;
  capacity: number;
}

function compute(p: Params): Values {
  const partitions = Math.max(1, Math.round(num(p, "partitionCount", 48)));
  const brokers = Math.max(1, Math.round(num(p, "brokerCount", 6)));
  const recordRate = Math.max(1, num(p, "recordRate", 60_000));
  const failover = num(p, "controllerFailover", 0) >= 1;
  const perBrokerLeaders = partitions / brokers;
  const capacity = brokers * PER_BROKER_CAPACITY;
  const failoverTime = 3 + perBrokerLeaders * 0.8 + (failover ? 4 : 0);
  const rebalanceTime = 2 + partitions * 0.1 + (failover ? partitions * 0.05 : 0);
  return {
    partitions,
    brokers,
    recordRate,
    failover,
    perBrokerLeaders,
    fileHandles: Math.round(perBrokerLeaders * REPLICAS * 6),
    failoverTime,
    rebalanceTime,
    p99: 15 + partitions * 0.35 + (failover ? 12 : 0),
    brokerCpu: Math.min(100, (recordRate / capacity) * 100),
    shortfall: Math.max(0, recordRate - capacity),
    capacity,
  };
}

function healthForCpu(cpu: number): "ok" | "warn" | "crit" {
  if (cpu >= 85) return "crit";
  if (cpu >= 70) return "warn";
  return "ok";
}

function healthForFailover(seconds: number): "ok" | "warn" | "crit" {
  if (seconds >= 40) return "crit";
  if (seconds >= 20) return "warn";
  return "ok";
}

function healthForLatency(ms: number): "ok" | "warn" | "crit" {
  if (ms >= 150) return "crit";
  if (ms >= 80) return "warn";
  return "ok";
}

function healthForFiles(files: number): "ok" | "warn" | "crit" {
  if (files >= 2_400) return "crit";
  if (files >= 1_200) return "warn";
  return "ok";
}

function worst(...healths: ("ok" | "warn" | "crit")[]): "ok" | "warn" | "crit" {
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const cpuHealth = healthForCpu(values.brokerCpu);
  const fileHealth = healthForFiles(values.fileHandles);
  const brokerHealth = worst(cpuHealth, fileHealth);
  const controllerHealth = healthForFailover(values.failoverTime);
  const latencyHealth = healthForLatency(values.p99);
  const throughput = Math.min(values.recordRate, values.capacity);
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Orders producer",
        kind: "service",
        health: cpuHealth,
        utilization: clamp(values.brokerCpu / 100),
        throughput: values.recordRate,
        sublabel: `${Math.round(values.recordRate).toLocaleString("en-US")} rec/s`,
        detail: "The producer does not know the partition count. It hashes keys and writes to partition leaders.",
        meta: { view: "flow" },
      },
      {
        id: "controller",
        label: "KRaft controller",
        kind: "service",
        health: controllerHealth,
        utilization: clamp(values.failoverTime / 60),
        sublabel: `${values.partitions} partitions · ${values.brokers} brokers`,
        detail: `Estimated controller election time is ${values.failoverTime.toFixed(1)}s for ${Math.round(values.perBrokerLeaders)} leaders per broker.`,
        meta: { view: "flow" },
      },
      {
        id: "broker-1",
        label: "broker-1",
        kind: "worker",
        health: brokerHealth,
        utilization: clamp(values.brokerCpu / 100),
        throughput: values.recordRate / values.brokers,
        capacity: PER_BROKER_CAPACITY,
        sublabel: `${Math.round(values.perBrokerLeaders)} leaders · ${values.fileHandles.toLocaleString("en-US")} log files`,
        detail: `${values.fileHandles.toLocaleString("en-US")} open log segments and indexes per broker at ${REPLICAS} replicas.`,
        meta: { view: "flow", files: values.fileHandles },
      },
      {
        id: "broker-2",
        label: "broker-2",
        kind: "worker",
        health: brokerHealth,
        utilization: clamp(values.brokerCpu / 100),
        throughput: values.recordRate / values.brokers,
        capacity: PER_BROKER_CAPACITY,
        sublabel: `${Math.round(values.perBrokerLeaders)} leaders · peer of broker-1`,
        detail: "Leaders and replicas are spread across brokers; the per-broker count is what drives election and file cost.",
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "stream",
        health: "ok",
        utilization: clamp(values.brokerCpu / 100),
        throughput: values.recordRate,
        sublabel: `${values.partitions} partitions · replication factor ${REPLICAS}`,
        detail: "Each partition is an ordered log with one leader and two replicas in this model.",
        meta: { view: "flow" },
      },
      {
        id: "consumer",
        label: "Order consumer group",
        kind: "service",
        health: latencyHealth,
        utilization: clamp(values.p99 / 200),
        throughput,
        sublabel: `p99 ${values.p99.toFixed(0)}ms · group rebalance ${values.rebalanceTime.toFixed(0)}s`,
        detail:
          values.shortfall > 0
            ? `Brokers can accept ${Math.round(values.capacity).toLocaleString("en-US")} rec/s; the producer sends ${Math.round(values.recordRate).toLocaleString("en-US")} rec/s.`
            : "Broker capacity covers the produce rate; partition count still sets the consumer ceiling.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", clamp(values.brokerCpu / 100), cpuHealth),
      edge("controller-broker-1", "controller", "broker-1", 0.5, controllerHealth),
      edge("controller-broker-2", "controller", "broker-2", 0.5, controllerHealth),
      edge("broker-1-topic", "broker-1", "topic", clamp(values.brokerCpu / 100), brokerHealth),
      edge("broker-2-topic", "broker-2", "topic", clamp(values.brokerCpu / 100), brokerHealth),
      edge("topic-consumer", "topic", "consumer", clamp(values.brokerCpu / 100), latencyHealth),
    ],
    metrics: [
      metric("controller-failover", "Controller failover", values.failoverTime, "s", 20, 40, "count"),
      metric("rebalance-time", "Group rebalance", values.rebalanceTime, "s", 15, 35, "count"),
      metric("file-handles", "Open log files per broker", values.fileHandles, "", 1_200, 2_400, "count"),
      metric("p99-latency", "End-to-end p99", values.p99, "ms", 80, 150, "ms"),
      metric("broker-cpu", "Broker CPU", values.brokerCpu, "%", 70, 85, "percent"),
      metric("throughput-shortfall", "Throughput shortfall", values.shortfall, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.partitions} partitions on ${values.brokers} brokers: ${Math.round(values.perBrokerLeaders)} leaders per broker, ${values.fileHandles.toLocaleString("en-US")} open log files per broker, and an estimated ${values.failoverTime.toFixed(0)}s controller failover.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.95 + 0.07 * Math.sin((offset + (seed % 8)) / 2.7);
  const points: [string, number, number][] = [
    ["controller-failover", values.failoverTime, 0.2],
    ["rebalance-time", values.rebalanceTime, 0.2],
    ["file-handles", values.fileHandles, 10],
    ["p99-latency", values.p99, 2],
    ["broker-cpu", values.brokerCpu, 2],
  ];
  for (const [id, value, amplitude] of points) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "controller-failover",
    metricId: "controller-failover",
    warn: 20,
    crit: 40,
    title: "Controller failover time grows with partition count",
    cause:
      "Every partition has leader and replica state that must be recovered and reassigned when the controller changes. More partitions per broker means more metadata work before the cluster is writable again.",
    fix:
      "Reduce the partition count to what the workload needs, or add brokers so the same partitions spread over more metadata owners. Test a controller restart at peak before the incident.",
    checkFirst: [
      "Count leaders and replicas per broker.",
      "Check the controller's own CPU and request queue during election.",
      "Compare failover time at the current partition count with the pre-change baseline.",
    ],
  },
  {
    id: "rebalance-time",
    metricId: "rebalance-time",
    warn: 15,
    crit: 35,
    title: "Group rebalance time is dominated by partition assignment",
    cause:
      "A rebalance reassigns every partition in the group. More partitions means more assignment work, more state to revoke, and a longer pause before consumption resumes.",
    fix:
      "Use cooperative rebalancing and static membership, and keep the partition count proportional to the consumer count. Do not add partitions for capacity you cannot staff with consumers.",
    checkFirst: [
      "Measure the pause from the first revoke to the first successful poll.",
      "Compare partition count with the number of active members.",
      "Check whether the group uses eager or cooperative assignment.",
    ],
  },
  {
    id: "file-handles",
    metricId: "file-handles",
    warn: 1_200,
    crit: 2_400,
    title: "Each partition replica carries open log files",
    cause:
      "A partition replica has log segments and indexes on disk. At a replication factor of three, every partition adds files on three brokers, and many small partitions multiply that cost.",
    fix:
      "Lower the partition count or spread it over more brokers. Segment size and retention affect how many files stay open, but partition count is the multiplier that is hardest to change later.",
    checkFirst: [
      "Check open file descriptors and log segments per broker.",
      "Compare partition count with broker count and replication factor.",
      "Check whether segment rolls are creating many small files.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 80,
    crit: 150,
    title: "End-to-end latency rises with request fan-out",
    cause:
      "More partitions mean more produce and fetch requests, more batching decisions, and more metadata to maintain. The tail grows even when broker CPU has headroom.",
    fix:
      "Keep partitions proportional to throughput and consumer parallelism, use larger batches where latency allows, and measure p99 at the partition count you plan to run.",
    checkFirst: [
      "Compare p99 before and after a partition increase.",
      "Check request queue time and batch size.",
      "Check whether the tail is on produce, fetch, or commit.",
    ],
  },
  {
    id: "broker-cpu",
    metricId: "broker-cpu",
    warn: 70,
    crit: 85,
    title: "Brokers are the throughput bottleneck, not partitions",
    cause:
      "Partition count adds logs and assignment slots, not broker CPU. If the produce rate exceeds the brokers' combined capacity, lag and latency grow regardless of how many partitions exist.",
    fix:
      "Add brokers or reduce the produce rate. Add partitions only if consumers and brokers can use them, and keep the partition-to-broker ratio balanced.",
    checkFirst: [
      "Compare per-broker CPU and request queue time.",
      "Check whether a small number of leaders own most of the traffic.",
      "Check the consumer count before adding partitions for throughput.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const partitionCountModel: SimModel = {
  id: "streaming-partition-count",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
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

    if (values.failover && next.flags.failoverSeen !== 1) {
      pushEvent(next, {
        id: "controller-election",
        at: frame.t,
        severity: values.failoverTime >= 40 ? "crit" : "warn",
        title: "Controller election is reassigning partition metadata",
        detail: `${values.partitions} partitions across ${values.brokers} brokers put ${Math.round(values.perBrokerLeaders)} leaders on each broker. The estimated election is ${values.failoverTime.toFixed(0)}s and the group rebalance is ${values.rebalanceTime.toFixed(0)}s.`,
        nodeId: "controller",
        metricId: "controller-failover",
      });
      next.flags.failoverSeen = 1;
    }
    if (!values.failover) next.flags.failoverSeen = 0;

    if (values.shortfall > 0 && next.flags.shortfallSeen !== 1) {
      pushEvent(next, {
        id: "broker-shortfall",
        at: frame.t,
        severity: "warn",
        title: "Broker capacity is below the produce rate",
        detail: `The cluster can accept ${Math.round(values.capacity).toLocaleString("en-US")} rec/s and the producer sends ${Math.round(values.recordRate).toLocaleString("en-US")} rec/s. More partitions would add logs, not CPU.`,
        nodeId: "broker-1",
        metricId: "throughput-shortfall",
      });
      next.flags.shortfallSeen = 1;
    }
    if (values.shortfall === 0) next.flags.shortfallSeen = 0;

    next.flags.paramsKey = key;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `${values.partitions} partitions across ${values.brokers} brokers means about ${Math.round(values.perBrokerLeaders)} leaders per broker. The failover estimate grows with that ratio.`,
      `At replication factor ${REPLICAS}, each broker holds about ${values.fileHandles.toLocaleString("en-US")} open log segments and indexes.`,
      `Partition count sets the consumer parallelism ceiling. It does not add broker CPU: the cluster capacity here is ${Math.round(values.capacity).toLocaleString("en-US")} rec/s.`,
    ];
    if (values.shortfall > 0) {
      items.push(
        `The producer sends ${Math.round(values.shortfall).toLocaleString("en-US")} rec/s more than the brokers can accept; adding partitions will not close that gap.`,
      );
    }
    if (values.failover) {
      items.push("The controller election is the active scenario; watch failover and rebalance time before throughput.");
    } else {
      items.push("The failover estimate is a planning number; run the failover preset to see the active election.");
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Elevated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "48 partitions on six brokers: modest metadata cost and a fast election estimate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "96 partitions on three brokers at 100k records/s; brokers and election are under pressure.",
    tone: "warn",
    params: defaults({ partitionCount: 96, brokerCount: 3, recordRate: 100_000 }),
  },
  {
    id: "two-hundred",
    label: "200 partitions",
    description: "The production question: 200 partitions on three brokers and a controller election.",
    tone: "crit",
    params: defaults({ partitionCount: 200, brokerCount: 3, recordRate: 90_000, controllerFailover: 1 }),
  },
  {
    id: "failure",
    label: "400 partitions",
    description: "Excess partitions amplify failover, rebalance, files, and tail latency on the same cluster.",
    tone: "crit",
    params: defaults({ partitionCount: 400, brokerCount: 3, recordRate: 90_000, controllerFailover: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "48 partitions spread over six brokers keeps every cost below its threshold.",
    tone: "ok",
    params: defaults({ partitionCount: 48, brokerCount: 6, recordRate: 90_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-partition-growth",
  title: "Predict what doubling partitions buys",
  simId: "partition-count",
  question:
    "A topic has 200 partitions on three brokers. You double the count to 400 to raise throughput but keep the same brokers and consumers. What improves, and what gets worse?",
  prediction: {
    options: [
      { id: "throughput", label: "Throughput doubles because there are twice as many logs" },
      { id: "parallelism", label: "The consumer parallelism ceiling rises, but failover, rebalance, files, and tail latency get worse" },
      { id: "latency", label: "End-to-end latency falls because writes spread out" },
      { id: "nothing", label: "Nothing changes at all" },
    ],
    correctOptionId: "parallelism",
    explanation:
      "Partitions are logs and assignment slots. Doubling them lets more consumers work in the group, but it does not add broker CPU or consumer processes. The same produce rate now has twice as many partition leaders to track, twice as much metadata to recover in an election, twice as many files per replica, and more request fan-out. Throughput improves only when consumers and brokers can use the extra slots.",
  },
  setup: defaults({ partitionCount: 400, brokerCount: 3, recordRate: 90_000, controllerFailover: 1 }),
  runFor: 20,
  observe: [
    "At 400 partitions the failover estimate is about 114 seconds, roughly double the 200-partition baseline.",
    "Open log files per broker double from 1,200 to 2,400 and cross the critical threshold.",
    "Group rebalance time and end-to-end p99 rise even though broker CPU is unchanged.",
    "The consumer parallelism ceiling rises, but no consumer or broker capacity was added.",
  ],
  explain:
    "Partition count is a multiplier on metadata, assignment, and file state. It is also the ceiling on consumer parallelism and the number of independent ordered logs. Those are different resources: adding partitions can help a group that has more consumers than partitions, but it cannot help a cluster that is short on brokers or a consumer fleet that is already fully assigned. Reassigning 400 partition leaders in an election is more work than reassigning 200, and the tail latency reflects it.",
  fix: defaults({ partitionCount: 48, brokerCount: 6, recordRate: 90_000 }),
  debrief:
    "Returning to 48 partitions on six brokers cuts leaders per broker from about 133 to 8. The failover estimate falls from about 114 seconds to about 9, open log files per broker fall from 2,400 to 144, and p99 returns below the warning line. Consumer parallelism is lower, but the group still has enough partitions and the cluster can actually recover.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Partition count is the number of ordered logs a topic is split into. Each partition has one leader and, with replication, followers on other brokers. The count sets the maximum number of consumers that can work in one group, the number of independent ordering scopes, and the amount of metadata every broker and controller must track. It is a one-way sizing decision in practice: increasing it later remaps keys and can break per-key order during the change.",
  },
  {
    type: "p",
    text: "The cost is easy to miss because the topic still works. Every partition adds leader and replica state, log segments and index files, request fan-out, and assignment work during a rebalance or controller election. At a few hundred partitions on a small cluster, those costs can dominate recovery time even when CPU looks fine.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The controller (KRaft, Kafka's Raft-based metadata layer in current releases) tracks partition leadership and broker membership. Brokers host partition leaders and replicas. The consumer group coordinator assigns partitions to members. When the controller changes, the cluster must recover that metadata and re-establish leadership; when a group rebalances, it must revoke and reassign partitions. Both operations scale with the number of partitions, and both sit on the critical path of writes or reads.",
  },
  {
    type: "table",
    headers: ["Partition count", "Parallelism", "Metadata and recovery cost", "Typical mistake"],
    rows: [
      ["Low", "Few consumers can work; keys concentrate", "Small and fast to recover", "Sizing for today's peak with no growth"],
      ["Matched to load", "Enough slots for the consumer fleet", "Manageable rebalance and election time", "Treating it as a throughput dial"],
      ["Very high", "Many slots, many logs", "Slow election, long rebalance, many files, higher p99", "Adding partitions to fix broker CPU"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 12 to 400 partitions, 3 to 12 brokers, and a fixed 40,000 records per second per broker. The failover, rebalance, file, and latency formulas are teaching approximations with labeled outputs, not Kafka limits or a benchmark of any specific cluster.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Controller failover estimate in seconds. Warning at 20, critical at 40.",
      "Group rebalance time in seconds. Warning at 15, critical at 35.",
      "Open log files per broker, which scales with partitions, replication factor, and broker count.",
      "End-to-end p99 and broker CPU, which separate partition cost from raw load.",
      "A flow view from producer to controller, brokers, topic, and consumer group.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply 200 partitions and watch the controller failover and file counts before looking at throughput. Run the guided experiment, compare 400 partitions, then apply Recovery. Move the partition slider slowly and watch which costs move first.",
  },
  { type: "sim", simId: "partition-count" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 400 partitions on three brokers, each broker held about 133 leaders. With three replicas and six open segments per replica, that was about 2,400 open log files per broker. The controller election estimate was about 114 seconds, the group rebalance about 62 seconds, and p99 about 167 milliseconds. Broker CPU was only 75%, below its critical line, which is exactly the trap: the cluster had CPU headroom and no fast way to recover.",
  },
  {
    type: "p",
    text: "At 48 partitions on six brokers, each broker held eight leaders, 144 log files, and the election estimate fell to about 9 seconds. p99 returned to about 32 milliseconds. The lower partition count still gave the group enough slots for its consumers, so the extra partitions were not buying throughput; they were buying recovery work.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Controller election duration, metadata request latency, and the number of partitions per broker.",
      "Group rebalance duration from the first revoke to the first successful poll.",
      "Open file descriptors and log segments per broker.",
      "Produce and fetch p99, request queue time, and batch size.",
      "Broker CPU and network throughput, which show whether the bottleneck is capacity rather than partition count.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare partitions per broker with the recovery time you can tolerate. Then check whether the group actually has more consumers than partitions. If it does not, adding partitions cannot help throughput, and you should look at broker capacity, consumer throughput, or the produce rate first.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the consumer parallelism ceiling and the current assignments.",
      "Measure broker CPU, network, and request queue time separately from partition count.",
      "Choose the smallest partition count that covers peak consumers and expected growth.",
      "Spread that count over enough brokers to keep leaders and files per broker bounded.",
      "Test a controller restart and a rolling broker restart at peak before changing production.",
      "If the count must change, migrate through a new topic or a drained window and verify key order.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More partitions raise the consumer ceiling and reduce per-partition load, but lengthen election and rebalance work.",
      "Fewer partitions recover faster and use fewer files, but cap parallelism and concentrate key load.",
      "Adding brokers lowers partitions per broker but adds replication and operational surface.",
      "Larger batches and fewer requests improve tail latency but can raise per-record latency.",
      "Partition count changes remap keys, so the migration cost can exceed the runtime cost.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-partition-count",
    question: "How do you choose a partition count for a topic that will run for several years?",
    difficulty: 2,
    hints: [
      "Start from the consumer parallelism ceiling and peak throughput.",
      "Recovery time and files per broker bound the upper end.",
    ],
    answer:
      "I would size from three inputs: peak produce rate divided by sustainable per-consumer throughput, the maximum number of consumers I expect in a group, and the key cardinality that must stay ordered. That gives a lower bound. Then I would bound the upper end with partitions per broker, the failover time I can tolerate, open files per broker, and rebalance time. I would choose a count that covers realistic growth because resizing is a key migration. Finally I would test a controller restart and a rolling restart at peak, not just a throughput benchmark.",
    followUps: [
      "What headroom do you leave for growth?",
      "How does replication factor change the file cost?",
      "When would you choose fewer partitions than consumers?",
    ],
    redFlags: [
      "Picks a count from a blog default.",
      "Ignores recovery time.",
      "Assumes partitions add broker capacity.",
    ],
    rubric: [
      "Derives a lower bound from throughput and consumers.",
      "Bounds the upper end with recovery and files.",
      "Tests failover, not only throughput.",
    ],
  },
  {
    id: "slow-failover",
    question: "A topic has 200 partitions and controller failover takes minutes. Why does the partition count matter?",
    difficulty: 3,
    hints: [
      "The controller tracks leadership for every partition.",
      "Each broker has to recover its share of leaders and replicas.",
    ],
    answer:
      "The controller and brokers must recover metadata for every partition: which replica is leader, which replicas are in sync, and what the log state is. More partitions per broker means more state to rebuild and more leader elections to complete before the cluster is fully writable. The group also has to rebalance more assignments. Minute-scale failover usually means the partition count is high relative to the broker count, or the controller and metadata path are undersized. I would measure partitions per broker, metadata request latency, and election duration, then reduce the count or spread it over more brokers and retest.",
    followUps: [
      "What else besides partition count can slow failover?",
      "How would you test this safely?",
      "What does the group rebalance add to the outage?",
    ],
    redFlags: [
      "Blames only broker CPU.",
      "Says partitions are free metadata.",
      "Has no failover test.",
    ],
    rubric: [
      "Connects partition metadata to election work.",
      "Names partitions per broker.",
      "Proposes a bounded test and a fix.",
    ],
  },
  {
    id: "partitions-throughput",
    question: "Does adding partitions increase throughput? Explain when it does and when it does not.",
    difficulty: 2,
    hints: [
      "Partitions are assignment slots and logs.",
      "Consumers, brokers, and the sink have their own limits.",
    ],
    answer:
      "It increases the ceiling only when the group has more consumers than partitions and the brokers and downstream sink can absorb the extra work. If every partition is already assigned, new partitions add logs without adding consumer processes, so throughput stays roughly flat. If the brokers are CPU-bound, partitions do not add CPU. If the sink is the bottleneck, more consumer parallelism just pushes harder on the sink. I would confirm which resource is saturated before changing the count, then treat the change as a key-remapping migration.",
    followUps: [
      "Which metric tells you the group is assignment-limited?",
      "What if the sink is the bottleneck?",
      "How does the partition change affect ordering?",
    ],
    redFlags: [
      "Says more partitions always mean more throughput.",
      "Ignores the downstream sink.",
      "Forgets the key remap.",
    ],
    rubric: [
      "Names the assignment ceiling.",
      "Checks brokers and sink.",
      "Treats the change as a migration.",
    ],
  },
  {
    id: "partition-change-migration",
    question: "You must increase the partition count on a live keyed topic. How do you do it without breaking order?",
    difficulty: 4,
    hints: [
      "The key-to-partition mapping depends on the count.",
      "A new topic lets old and new mappings coexist.",
    ],
    answer:
      "I would not resize in place during normal traffic. I would create a new topic with the target count, dual-write or mirror records, let consumers drain the old topic, switch reads, and then stop the old writes. During the overlap, consumers must tolerate both key mappings or read only one topic per key. If the topic must stay in place, I would pause keyed writes for the change window, increase the count, resume with a versioned key, and verify order with a replay test. Either way the rollback is the old topic and the old mapping.",
    followUps: [
      "How long do you keep the old topic?",
      "What if the producer cannot dual-write?",
      "How do you verify order after the switch?",
    ],
    redFlags: [
      "Increases the count in place with no drain.",
      "Assumes keys keep their partitions.",
      "Has no rollback path.",
    ],
    rubric: [
      "Explains the hash modulo remap.",
      "Describes a dual-write or drain sequence.",
      "Verifies order and has a rollback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Partition count is justified by consumer ceiling and peak throughput, not a default.",
      "Partitions per broker and open log files per broker are tracked against tested limits.",
      "A controller restart and a rolling broker restart have been tested at peak.",
      "A partition-count change has a key migration and rollback plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate broker capacity from partition metadata cost before changing anything.",
      "Measure election and rebalance duration, not only end-to-end latency.",
      "Do not add partitions to fix broker CPU.",
      "Protect the cluster from a second failure while the controller is recovering.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-test failover at the current partition count and record the baseline.",
      "Reduce partitions or add brokers if recovery exceeds the budget.",
      "Verify p99 and consumer lag after the change.",
      "Document the recovery time as a capacity constraint.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: main concepts and terminology",
    url: "https://kafka.apache.org/44/getting-started/introduction#main-concepts-and-terminology",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Partitioned logs, replication, and ordering scope.",
  },
  {
    title: "Apache Kafka documentation: replication design",
    url: "https://kafka.apache.org/44/design/design/#replication",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Leader and follower replicas, in-sync replicas, and failover.",
  },
  {
    title: "Confluent: Intro to Kafka partitions",
    url: "https://developer.confluent.io/courses/apache-kafka/partitions/",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Partition count, concurrency, and the ordering tradeoff.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "partition-count": {
      model: partitionCountModel,
      presets,
      instructions:
        "Start healthy, then apply 200 partitions and watch failover and file counts. Run the experiment, compare 400 partitions, then apply Recovery. Move the partition slider slowly and watch which costs move first.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Partition counts and recovery estimates are teaching values, not Kafka limits or a benchmark.",
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
    "streaming-consumer-groups",
    "streaming-rebalancing",
  ],
};
