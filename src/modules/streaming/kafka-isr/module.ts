import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "replicationFactor",
    label: "Replication factor",
    min: 1,
    max: 5,
    step: 1,
    value: 3,
    unit: "",
    group: "Topic",
    help: "Copies of each partition. A factor of three can tolerate two failures only if min.insync.replicas permits it.",
    format: "count" as const,
  },
  {
    id: "minIsr",
    label: "min.insync.replicas",
    min: 1,
    max: 5,
    step: 1,
    value: 2,
    unit: "",
    group: "Topic",
    help: "Minimum in-sync replicas required before the leader accepts an acks=all write.",
    format: "count" as const,
  },
  {
    id: "acks",
    label: "Producer acks",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Producer",
    help: "0 no acknowledgment, 1 leader only, 2 all in-sync replicas. Only acks=all enforces min.insync.replicas.",
    format: "count" as const,
  },
  {
    id: "brokerFailure",
    label: "Failed brokers",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Brokers removed from the in-sync replica set. A failed leader triggers a new leader election from the remaining ISR.",
    format: "count" as const,
  },
  {
    id: "produceRate",
    label: "Produce rate",
    min: 100,
    max: 10_000,
    step: 100,
    value: 2_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records per second offered to the partition. Rejected writes are not stored.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  rf: number;
  minIsr: number;
  acks: number;
  failures: number;
  isr: number;
  meetsMin: boolean;
  writeErrors: number;
  durabilityRisk: number;
  underReplicated: number;
  latency: number;
  accepted: number;
  policy: string;
}

function compute(p: Params): Values {
  const rf = Math.round(clamp(num(p, "replicationFactor", 3), 1, 5));
  const minIsr = Math.round(clamp(num(p, "minIsr", 2), 1, 5));
  const acks = Math.round(clamp(num(p, "acks", 2), 0, 2));
  const failures = Math.round(clamp(num(p, "brokerFailure", 0), 0, 2));
  const produceRate = Math.round(clamp(num(p, "produceRate", 2_000), 100, 10_000));
  const isr = Math.max(0, rf - failures);
  const meetsMin = isr >= minIsr;
  const writeErrors = acks === 2 && !meetsMin ? 100 : 0;
  const durabilityRisk = acks === 0
    ? 100
    : acks === 1
      ? failures > 0 ? 100 : 40
      : meetsMin ? (isr < rf ? 20 : 2) : 100;
  return {
    rf,
    minIsr,
    acks,
    failures,
    isr,
    meetsMin,
    writeErrors,
    durabilityRisk,
    underReplicated: failures,
    latency: acks === 0 ? 2 : acks === 1 ? 12 : writeErrors > 0 ? 0 : 30 + rf * 8,
    accepted: produceRate * (1 - writeErrors / 100),
    policy: acks === 2 ? "acks=all" : `acks=${acks}`,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const leaderHealth = values.writeErrors > 0 ? "crit" : values.underReplicated > 0 ? "warn" : "ok";
  const replicas = Array.from({ length: Math.max(0, values.rf - 1) }, (_, index) => {
    const failed = index < values.failures;
    return {
      id: `replica-${index + 1}`,
      label: failed ? `broker-${index + 2} (offline)` : `broker-${index + 2}`,
      kind: "worker" as const,
      role: "replica" as const,
      health: failed ? ("down" as const) : ("ok" as const),
      utilization: failed ? 0 : clamp(0.35 + values.isr / 20),
      throughput: failed ? 0 : values.accepted / Math.max(1, values.isr),
      capacity: values.accepted,
      sublabel: failed ? "removed from ISR" : "in sync",
      detail: failed
        ? "This broker is unreachable and removed from the in-sync replica set. Its copy is stale; it must catch up before rejoining the ISR."
        : "This replica is in the ISR. acks=all waits for all in-sync replicas, subject to min.insync.replicas.",
      meta: { lag: failed ? 999 : 0 },
    };
  });
  return {
    t: 0,
    nodes: [
      {
        id: "broker-1",
        label: "broker-1 (leader)",
        kind: "stream",
        role: "primary",
        health: leaderHealth,
        utilization: clamp(0.4 + values.isr / 20),
        throughput: values.accepted,
        capacity: values.accepted,
        sublabel: values.writeErrors > 0 ? "rejecting acks=all writes" : "accepting writes",
        detail: `The leader accepts writes only when the ISR meets min.insync.replicas for acks=all. Current ISR is ${values.isr} of ${values.rf}; minimum is ${values.minIsr}.`,
        meta: { isr: values.isr },
      },
      ...replicas,
    ],
    edges: values.rf > 1
      ? Array.from({ length: values.rf - 1 }, (_, index) =>
          edge(
            `replication-${index + 1}`,
            "broker-1",
            `replica-${index + 1}`,
            index < values.failures ? 0 : values.accepted / Math.max(1, values.isr),
            index < values.failures ? "down" : "ok",
            "replicate",
          ),
        )
      : [],
    metrics: [
      metric("write-errors", "Write errors", values.writeErrors, "%", 0.5, 1, "percent"),
      metric("under-replicated", "Under-replicated partitions", values.underReplicated, "", 1, 2, "count"),
      metric("durability-risk", "Durability risk", values.durabilityRisk, "%", 5, 50, "percent"),
      metric("isr-count", "In-sync replicas", values.isr, "", undefined, undefined, "count"),
      metric("produce-latency", "Produce latency", values.latency, "ms", 150, 500, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, isr: values.isr, acks: values.acks, failures: values.failures },
    summary: `ISR ${values.isr}/${values.rf} with min.insync.replicas ${values.minIsr}. ${values.writeErrors > 0 ? "acks=all writes are rejected." : `Writes are accepted with ${values.durabilityRisk}% durability risk.`}`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "write-errors", values.writeErrors);
    recordSeries(frame, "under-replicated", values.underReplicated);
    recordSeries(frame, "durability-risk", Math.max(0, values.durabilityRisk * (0.98 + 0.02 * Math.sin(index / 2.5))));
    recordSeries(frame, "isr-count", values.isr);
    recordSeries(frame, "produce-latency", Math.max(0, values.latency * (0.97 + 0.03 * Math.sin(index / 2.2))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "write-errors",
    metricId: "write-errors",
    warn: 0.5,
    crit: 1,
    title: "acks=all writes are rejected because the ISR is too small",
    cause:
      "The leader accepts acks=all writes only when the in-sync replica count is at least min.insync.replicas. Broker failures removed replicas from the ISR, so the leader returns NotEnoughReplicas instead of acknowledging a write it cannot make durable.",
    fix:
      "Restore the failed brokers and let them catch up, or lower min.insync.replicas deliberately with the durability cost understood. Do not switch the producer to acks=1 to bypass the check unless losing recent writes is acceptable.",
    checkFirst: [
      "Compare ISR size per partition with min.insync.replicas.",
      "Check which brokers are down and whether they are rejoining.",
      "Check producer errors for NotEnoughReplicas or NotEnoughReplicasAfterAppend.",
    ],
  },
  {
    id: "under-replicated",
    metricId: "under-replicated",
    warn: 1,
    crit: 2,
    title: "Partitions are under-replicated",
    cause:
      "At least one replica is outside the ISR. The partition still has a leader, but fewer copies can absorb the next failure. Under-replicated partitions are a durability warning before they become a write outage.",
    fix:
      "Restore broker health and watch ISR expansion. If a broker is slow rather than down, fix disk, network, or request-handler saturation; a lagging replica stays out of the ISR until it catches up.",
    checkFirst: [
      "Check UnderReplicatedPartitions and offline partitions.",
      "Check broker disk, network, and request-handler idle time.",
      "Check whether the ISR is shrinking or recovering.",
    ],
  },
  {
    id: "durability-risk",
    metricId: "durability-risk",
    warn: 5,
    crit: 50,
    title: "Acknowledged writes have weak durability",
    cause:
      "With acks=0 the producer never waits. With acks=1 only the leader acknowledges, so a leader failure can lose a write that the client considered successful. Even acks=all leaves reduced headroom when the ISR is at the minimum.",
    fix:
      "Use acks=all with min.insync.replicas of at least two and a replication factor of three. Treat acks=1 as a deliberate availability choice, not a default.",
    checkFirst: [
      "Check the producer's acks setting.",
      "Check the topic's min.insync.replicas and replication factor.",
      "Check whether a leader election or broker loss coincided with missing records.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const kafkaIsrModel: SimModel = {
  id: "streaming-kafka-isr",
  visual: "replication",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()));
    return frame;
  },
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(`ISR is ${values.isr} of ${values.rf}; min.insync.replicas is ${values.minIsr}. ${values.meetsMin ? "The leader can satisfy acks=all." : "The leader must reject acks=all writes."}`);
    items.push(values.writeErrors > 0 ? "Writes are failing closed. That protects durability but turns a broker loss into an availability incident." : values.underReplicated > 0 ? "Writes are still accepted, but the partition has less failure headroom. The next broker loss can cross min.insync.replicas." : "Every replica is in sync and writes have full durability headroom.");
    items.push(values.acks === 1 ? "acks=1 acknowledges at the leader only. A leader failure can lose a write the producer reported as successful." : values.acks === 0 ? "acks=0 never waits for the broker, so any broker loss can drop records with no error." : "acks=all makes the ISR and min.insync.replicas the write admission control.");
    if (values.failures > 0) items.push("A failed leader is replaced from the ISR. A replica outside the ISR cannot be elected without risking data loss.");
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
    description: "Three replicas in sync, min.insync.replicas two, and acks=all.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Under-replicated",
    description: "One broker is down; two replicas remain in the ISR and writes still succeed.",
    tone: "warn",
    params: defaults({ brokerFailure: 1 }),
  },
  {
    id: "failure",
    label: "Below minimum",
    description: "Two brokers are down; the ISR is one against a minimum of two, so acks=all writes fail.",
    tone: "crit",
    params: defaults({ brokerFailure: 2 }),
  },
  {
    id: "acks-one",
    label: "acks=1 hazard",
    description: "Two brokers are down but the producer uses acks=1, so writes are accepted with weak durability.",
    tone: "crit",
    params: defaults({ brokerFailure: 2, acks: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Replicas are restored and in sync; the ISR is back to three.",
    tone: "ok",
    params: defaults({ brokerFailure: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-isr-write",
  title: "Predict writes with one broker down",
  simId: "kafka-isr",
  question:
    "A partition has replication factor 3, min.insync.replicas 2, and acks=all. One broker fails. Does the leader accept writes?",
  prediction: {
    options: [
      { id: "reject", label: "No; the ISR is below three and writes must fail" },
      { id: "accept", label: "Yes; two replicas remain, which meets the minimum, but there is less failure headroom" },
      { id: "lose", label: "Yes, and the failed broker's acknowledged records are lost immediately" },
      { id: "switch", label: "The broker automatically changes min.insync.replicas to one" },
    ],
    correctOptionId: "accept",
    explanation:
      "The ISR drops from three to two, which still meets min.insync.replicas of two. acks=all writes succeed with two copies. Durability is reduced because one more broker loss takes the ISR below the minimum and blocks writes. The failed replica's records are not automatically lost; the remaining ISR is the authoritative copy.",
  },
  setup: defaults({ brokerFailure: 1 }),
  runFor: 20,
  observe: [
    "ISR falls to two and under-replicated partitions rises.",
    "Write errors stay at zero while the ISR meets the minimum.",
    "A second failure takes the ISR below the minimum and writes fail.",
    "acks=1 accepts writes with two brokers down but reports high durability risk.",
  ],
  explain:
    "The ISR is the set of replicas that are caught up with the leader. The leader uses it for acks=all admission: if the ISR is smaller than min.insync.replicas, the write cannot be made durable enough and is rejected. That is a deliberate fail-closed behavior. acks=1 bypasses it and accepts writes with less durability, which is a trade of safety for availability.",
  fix: defaults({ brokerFailure: 1, minIsr: 2, replicationFactor: 3, acks: 2 }),
  debrief:
    "With one broker down, writes continue on two in-sync replicas and the topic is under-replicated. The correct action is to restore the failed broker and watch the ISR expand, not to lower min.insync.replicas under pressure. A second failure blocks writes, which is the cost of refusing to acknowledge data that is not durable enough.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Kafka replicates each partition across brokers. The in-sync replica set (ISR) is the leader plus the replicas that are caught up to it. A partition is under-replicated when its ISR is smaller than its replication factor. The leader uses the ISR to decide whether an acks=all write can be acknowledged: it needs at least min.insync.replicas in-sync copies.",
  },
  {
    type: "p",
    text: "A failed broker leaves the ISR. If enough replicas remain, writes continue with less failure headroom. If the ISR falls below min.insync.replicas, the leader rejects acks=all writes with NotEnoughReplicas rather than acknowledging data it cannot make durable. The producer can switch to acks=1 to keep writing, but then a leader failure can lose records that were reported as successful.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, partition leader, follower replicas. The leader appends the record and waits according to acks. Replicas fetch from the leader; when a replica is caught up it stays in the ISR. A slow replica falls out, so under-replication can come from disk or network pressure, not only a dead broker.",
  },
  {
    type: "table",
    headers: ["Setting", "What it controls", "Failure behavior"],
    rows: [
      ["replication.factor", "Copies of the partition", "Sets how many broker failures the data can survive"],
      ["min.insync.replicas", "Minimum ISR for acks=all", "Below it, writes are rejected"],
      ["acks=all", "Wait for all in-sync replicas", "Durable when the ISR meets the minimum"],
      ["acks=1", "Wait for the leader only", "Accepted writes can be lost on leader failure"],
      ["acks=0", "No acknowledgment", "No delivery or durability signal"],
    ],
  },
  {
    type: "p",
    text: "This module uses replication factors up to five and up to two failed brokers. Those are illustrative teaching values. The shape of the failure is the lesson: one failure reduces headroom, a second crosses the minimum, and the same cluster can be available or unavailable depending on acks and min.insync.replicas.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "In-sync replicas and under-replicated partitions. Warning at one, critical at two.",
      "Write errors: acks=all rejections when the ISR is below the minimum. Critical at 1%.",
      "Durability risk: acknowledged writes that could be lost on the next failure. Warning at 5%, critical at 50%.",
      "Produce latency and the broker view with leader and replica state.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, apply Under-replicated, and run the experiment before failing a second broker. Compare Below minimum, acks=1 hazard, and Recovery. Watch ISR, write errors, and durability risk together.",
  },
  { type: "sim", simId: "kafka-isr" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With three replicas and one broker down, the ISR was two. That met min.insync.replicas of two, so acks=all writes continued. The partition was under-replicated, which meant the cluster had no room for another failure. A second broker failure dropped the ISR to one, and the leader rejected acks=all writes rather than acknowledge a record it could not replicate.",
  },
  {
    type: "p",
    text: "Switching to acks=1 made writes succeed again, but the durability risk was complete: the leader alone held the record, and a leader failure would lose writes the producer saw as successful. Recovery came from restoring brokers and letting them catch up into the ISR, not from weakening the guarantee.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "UnderReplicatedPartitions, offline partitions, and ISR shrink or expand rate per broker.",
      "Producer errors: NotEnoughReplicas, NotEnoughReplicasAfterAppend, and request timeouts.",
      "Broker disk, network, and request-handler idle time, which explain slow replicas that fall out of the ISR.",
      "Leader elections and unclean leader election events, which indicate data-loss risk.",
      "Records appended versus records acknowledged, to detect acknowledged writes that later disappear.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check ISR size per partition against min.insync.replicas before changing the producer. Check whether the failures are brokers or slow replicas. Keep acks=all while restoring capacity; do not lower min.insync.replicas during an incident without an explicit durability decision.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the ISR and the failed or lagging brokers per partition.",
      "Restore broker health and let replicas catch up before they rejoin the ISR.",
      "Keep acks=all and min.insync.replicas at a level that tolerates one failure with headroom.",
      "If writes must continue below the minimum, treat it as an explicit availability-over-durability decision and record the data-loss window.",
      "Watch for a second failure while the cluster is under-replicated.",
      "After recovery, verify ISR is full and no acknowledged records were lost.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "acks=all protects durability but turns a broker outage into a write outage once the minimum is crossed.",
      "acks=1 keeps writes available but can lose acknowledged records on leader failure.",
      "A higher replication factor adds durability and storage and network cost.",
      "A higher min.insync.replicas increases safety but reduces the number of failures the topic can absorb.",
      "Lowering min.insync.replicas during an incident restores writes and weakens the guarantee at the worst time.",
      "Waiting for slow replicas to rejoin is safer than forcing them into the ISR with stale data.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "isr-read",
    question:
      "A topic has replication factor 3 and shows 40 under-replicated partitions. Are writes at risk?",
    difficulty: 2,
    hints: [
      "Under-replicated means the ISR is smaller than the replication factor.",
      "Check min.insync.replicas and acks.",
    ],
    answer:
      "Under-replicated means at least one replica is out of the ISR, but writes may still be fine if the remaining ISR meets min.insync.replicas. I would check ISR size per partition, the topic's min.insync.replicas, and the producer's acks. If the ISR is at the minimum, the next failure blocks acks=all writes. I would also check whether the out-of-sync replicas are down or just slow.",
    followUps: [
      "What if the ISR is exactly at the minimum?",
      "How does a slow replica differ from a dead one?",
      "Which metric would you alert on first?",
    ],
    redFlags: [
      "Equates under-replicated with data loss.",
      "Ignores min.insync.replicas.",
      "Adds brokers without checking ISR.",
    ],
    rubric: [
      "Separates under-replication from write failure.",
      "Checks ISR against the minimum.",
      "Distinguishes slow from dead replicas.",
    ],
  },
  {
    id: "acks-tradeoff",
    question:
      "During an outage the team wants to switch producers from acks=all to acks=1 to restore writes. What do you say?",
    difficulty: 3,
    hints: [
      "acks=1 acknowledges only the leader.",
      "A leader failure can lose acknowledged records.",
    ],
    answer:
      "It will restore writes, but it changes the guarantee: acks=1 can acknowledge a record that exists only on the leader, so a leader failure loses data the producer considered durable. I would treat it as an explicit availability-over-durability decision with an owner and a time limit. The safer path is to restore brokers, keep acks=all, and accept a write outage until the ISR recovers, unless the business prefers losing recent writes to stopping writes.",
    followUps: [
      "How would you bound the data-loss window?",
      "What does unclean leader election add?",
      "How do you communicate the change?",
    ],
    redFlags: [
      "Switches silently.",
      "Claims no data loss with acks=1.",
      "Makes the change permanent.",
    ],
    rubric: [
      "States the durability loss.",
      "Frames it as an explicit trade.",
      "Has a recovery and revert plan.",
    ],
  },
  {
    id: "isr-recovery",
    question:
      "A broker is back online but its partitions are still under-replicated. What is happening, and what do you check?",
    difficulty: 3,
    hints: [
      "A returning replica must catch up before rejoining the ISR.",
      "Disk and network throughput set catch-up speed.",
    ],
    answer:
      "The broker is running but its replicas are still fetching and applying records to catch up with the leader. Until they reach the leader's log end offset they stay out of the ISR. I would check replication lag, disk throughput, network saturation, and request-handler load. If catch-up is slower than retention, the replica may need a log truncation and a full resync. I would not force it into the ISR.",
    followUps: [
      "What happens if the leader's log is truncated first?",
      "How would you speed up catch-up safely?",
      "When would you replace the broker instead?",
    ],
    redFlags: [
      "Assumes a running broker is in the ISR.",
      "Forces the replica into the ISR.",
      "Ignores disk and network throughput.",
    ],
    rubric: [
      "Explains catch-up before ISR rejoin.",
      "Names disk and network limits.",
      "Avoids forcing stale replicas in.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Replication factor, min.insync.replicas, and producer acks are documented per topic.",
      "Under-replicated partitions and ISR size are monitored per broker.",
      "A broker failure test verifies that writes fail closed below the minimum.",
      "Broker disk and network headroom supports replica catch-up.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check ISR against min.insync.replicas before changing producer settings.",
      "Restore failed brokers and watch catch-up; do not force stale replicas into the ISR.",
      "Treat any acks change as an explicit durability decision.",
      "Watch for a second failure while under-replicated.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the ISR is full and no acknowledged records were lost.",
      "Review broker capacity and slow-replica causes.",
      "Update the runbook with the observed failure sequence.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: replication",
    url: "https://kafka.apache.org/documentation/#replication",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "ISR, leader election, min.insync.replicas, and under-replicated partitions.",
  },
  {
    title: "Apache Kafka producer configs: acks",
    url: "https://kafka.apache.org/documentation/#producerconfigs_acks",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "acks=0, 1, and all, and their durability behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "kafka-isr": {
      model: kafkaIsrModel,
      presets,
      instructions:
        "Start healthy, apply Under-replicated, then run the experiment. Compare Below minimum, acks=1 hazard, and Recovery. Watch ISR, write errors, and durability risk.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Replication factors, ISR counts, and risk percentages are teaching values, not Kafka defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-producer-acks", "streaming-kafka-partitions", "streaming-consumer-lag"],
};
