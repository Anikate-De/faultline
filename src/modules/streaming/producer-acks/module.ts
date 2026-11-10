import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "acks",
    label: "Producer acks",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Producer",
    help: "0 no acknowledgment, 1 leader only, 2 all in-sync replicas. The producer card shows the selected mode.",
    format: "count" as const,
  },
  {
    id: "minIsr",
    label: "min.insync.replicas",
    min: 1,
    max: 3,
    step: 1,
    value: 2,
    unit: "",
    group: "Topic",
    help: "Minimum in-sync replicas required for acks=all writes. If the ISR falls below this, the leader rejects writes.",
    format: "count" as const,
  },
  {
    id: "replicationFactor",
    label: "Replication factor",
    min: 1,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Topic",
    help: "Copies of each partition. A factor of three tolerates one broker loss when min.insync.replicas is two.",
    format: "count" as const,
  },
  {
    id: "brokerFailure",
    label: "Broker failure",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 fails the partition leader, removes it from the ISR, and promotes a replica; 0 keeps every replica in sync.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  acks: number;
  minIsr: number;
  replicationFactor: number;
  brokerFailure: boolean;
  isr: number;
  meetsMin: boolean;
  risk: number;
  actualLoss: number;
  produceErrors: number;
  latency: number;
  underReplicated: number;
  policy: string;
}

function policyName(acks: number): string {
  if (acks === 0) return "acks=0";
  if (acks === 1) return "acks=1";
  return "acks=all";
}

function compute(p: Params): Values {
  const acks = Math.min(2, Math.max(0, Math.round(num(p, "acks", 2))));
  const minIsr = Math.min(3, Math.max(1, Math.round(num(p, "minIsr", 2))));
  const replicationFactor = Math.min(3, Math.max(1, Math.round(num(p, "replicationFactor", 3))));
  const brokerFailure = num(p, "brokerFailure", 0) >= 1;
  const isr = brokerFailure ? Math.max(0, replicationFactor - 1) : replicationFactor;
  const meetsMin = isr >= minIsr;
  const risk =
    acks === 2 ? (meetsMin ? (isr >= 2 ? 0 : 100) : 0) : 100;
  const produceErrors = acks === 2 && !meetsMin ? 100 : 0;
  const latency =
    acks === 0 ? 1 : acks === 1 ? 8 : isr > 0 ? 14 + isr * 8 + (brokerFailure ? 8 : 0) : 0;
  return {
    acks,
    minIsr,
    replicationFactor,
    brokerFailure,
    isr,
    meetsMin,
    risk,
    actualLoss: brokerFailure && acks < 2 ? 100 : 0,
    produceErrors,
    latency,
    underReplicated: brokerFailure ? 1 : 0,
    policy: policyName(acks),
  };
}

function leaderHealth(values: Values): "ok" | "warn" | "crit" | "down" {
  if (values.replicationFactor === 1 && values.brokerFailure) return "down";
  if (values.produceErrors > 0) return "crit";
  if (values.risk > 0 || values.underReplicated > 0) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const lHealth = leaderHealth(values);
  const replicas = Array.from({ length: Math.max(0, values.replicationFactor - 1) }, (_, index) => {
    const promoted = values.brokerFailure && index === 0;
    return {
      id: `replica-${index + 1}`,
      label: `broker-${index + 2}${promoted ? " (new leader)" : ""}`,
      kind: "worker" as const,
      role: promoted ? ("primary" as const) : ("replica" as const),
      health: promoted ? lHealth : ("ok" as const),
      utilization: promoted ? 0.5 : 0.4,
      sublabel: promoted ? "promoted from ISR" : "in sync",
      detail: promoted
        ? "This replica was promoted after the old leader failed. New writes go through it."
        : "An in-sync replica. acks=all waits for this broker before returning success.",
      meta: { promoted: promoted ? 1 : 0, lag: 0 },
    };
  });
  const leaderDown = values.brokerFailure;
  return {
    t: 0,
    nodes: [
      {
        id: "leader",
        label: leaderDown ? "broker-1 (failed leader)" : "broker-1 (leader)",
        kind: "worker",
        role: leaderDown && values.replicationFactor > 1 ? "replica" : "primary",
        health: leaderDown ? "down" : lHealth,
        utilization: leaderDown ? 0 : values.produceErrors > 0 ? 0.9 : 0.5,
        sublabel: leaderDown
          ? "unavailable · removed from ISR"
          : `${values.policy} · ISR ${values.isr} of ${values.replicationFactor}`,
        detail: leaderDown
          ? "The old leader is unavailable. A replica was promoted, but records acknowledged only by the old leader may not exist on the new one."
          : `The leader waits for ${values.acks === 0 ? "no acknowledgment" : values.acks === 1 ? "its own log write" : "all in-sync replicas"} before returning success. min.insync.replicas is ${values.minIsr}.`,
        meta: { isr: values.isr, acks: values.acks, lag: leaderDown ? 1 : 0 },
      },
      ...replicas,
    ],
    edges: replicas.map((replica) =>
      edge(
        `leader-${replica.id}`,
        "leader",
        replica.id,
        replica.health === "down" || leaderDown ? 0 : 0.5,
        replica.health === "down" || leaderDown ? "down" : "ok",
      ),
    ),
    metrics: [
      metric("durability-risk", "Loss exposure", values.risk, "%", 0.1, 1, "percent"),
      metric("produce-errors", "Rejected writes", values.produceErrors, "%", 0.1, 1, "percent"),
      metric("ack-latency", "Ack latency p99", values.latency, "ms", 50, 120, "ms"),
      metric("isr", "In-sync replicas", values.isr, "", undefined, undefined, "count"),
      metric("under-replicated", "Under-replicated partitions", values.underReplicated, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.policy} with replication factor ${values.replicationFactor} and min.insync.replicas ${values.minIsr}: ISR ${values.isr}, ${values.produceErrors > 0 ? "writes rejected" : values.risk > 0 ? (values.acks === 0 ? "unacknowledged writes exposed to loss" : "acknowledged writes exposed to loss") : "writes durable across the ISR"}.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.95 + 0.07 * Math.sin((offset + (seed % 4)) / 2.5);
  const points: [string, number, number][] = [
    ["durability-risk", values.risk, 0.1],
    ["produce-errors", values.produceErrors, 0.1],
    ["ack-latency", values.latency, 1],
    ["isr", values.isr, 0.05],
  ];
  for (const [id, value, amplitude] of points) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "durability-risk",
    metricId: "durability-risk",
    warn: 0.1,
    crit: 1,
    title: "Acknowledged writes are not on enough replicas",
    cause:
      "The producer is not waiting for enough replicas. acks=1 returns success after the leader's local write, and acks=0 does not wait at all, so loss is silent. acks=all with too few in-sync replicas has the same exposure.",
    fix:
      "Use acks=all with min.insync.replicas at least two and a replication factor of three. Confirm that the ISR meets the minimum before treating a write as durable.",
    checkFirst: [
      "Read the producer's acks setting and the topic's min.insync.replicas.",
      "Check the ISR size for the affected partitions.",
      "Check whether the producer saw success for the lost records.",
    ],
  },
  {
    id: "produce-errors",
    metricId: "produce-errors",
    warn: 0.1,
    crit: 1,
    title: "The ISR is below min.insync.replicas, so writes are rejected",
    cause:
      "With acks=all, the leader refuses the write when the in-sync replica count is below the topic's minimum. This protects durability by rejecting the write instead of acknowledging a weak copy.",
    fix:
      "Restore the failed broker or lower min.insync.replicas only as a deliberate durability decision. Keep the replication factor above the minimum so one broker loss does not block writes.",
    checkFirst: [
      "Check ISR membership and the failed broker.",
      "Compare min.insync.replicas with the replication factor.",
      "Check producer errors for NotEnoughReplicas.",
    ],
  },
  {
    id: "ack-latency",
    metricId: "ack-latency",
    warn: 50,
    crit: 120,
    title: "Waiting for more replicas raises acknowledgment latency",
    cause:
      "acks=all waits for every in-sync replica, and a weaker ISR can slow the response. The producer's send latency includes that wait, so durability has a direct latency cost.",
    fix:
      "Measure ack latency at the durability level you need. If it breaches the budget, add broker capacity or reduce the replica wait only with an explicit decision about loss exposure.",
    checkFirst: [
      "Compare producer send latency with broker replication time.",
      "Check whether one replica is consistently slow.",
      "Check the batching and linger settings before weakening acks.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const producerAcksModel: SimModel = {
  id: "streaming-producer-acks",
  visual: "replication",
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

    if (values.brokerFailure && next.flags.failureSeen !== 1) {
      pushEvent(next, {
        id: "leader-failure",
        at: frame.t,
        severity: values.actualLoss > 0 || values.produceErrors > 0 ? "crit" : "warn",
        title: "A broker failed and the in-sync set shrank",
        detail:
          values.acks === 0
            ? "The producer is using acks=0. It never waited for an acknowledgment, so records that were only on the failed leader are lost and the producer cannot tell."
            : values.acks === 1
              ? "The producer is using acks=1. Acknowledged records that existed only on the failed leader can be lost; the producer saw success and cannot tell."
              : values.produceErrors > 0
                ? `acks=all and min.insync.replicas=${values.minIsr} leave the ISR at ${values.isr}. The leader rejects writes rather than acknowledge a weak copy.`
                : values.risk > 0
                  ? `acks=all and min.insync.replicas=${values.minIsr} leave the ISR at ${values.isr}. Writes are acknowledged by a single replica, so another failure can still lose them.`
                  : `acks=all and min.insync.replicas=${values.minIsr} leave the ISR at ${values.isr}. Writes continue without acknowledged loss.`,
        nodeId: "leader",
        metricId: values.acks < 2 ? "durability-risk" : "produce-errors",
      });
      next.flags.failureSeen = 1;
    }
    if (!values.brokerFailure) next.flags.failureSeen = 0;

    if (values.produceErrors > 0 && next.flags.blockedSeen !== 1) {
      pushEvent(next, {
        id: "writes-blocked",
        at: frame.t,
        severity: "crit",
        title: "Produce requests are being rejected",
        detail: `The ISR has ${values.isr} replicas and min.insync.replicas is ${values.minIsr}. acks=all cannot satisfy the minimum, so the leader rejects writes instead of accepting them.`,
        nodeId: "leader",
        metricId: "produce-errors",
      });
      next.flags.blockedSeen = 1;
    }
    if (values.produceErrors === 0) next.flags.blockedSeen = 0;

    next.flags.paramsKey = key;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `${values.policy} waits for ${values.acks === 0 ? "no acknowledgment" : values.acks === 1 ? "the leader's local write only" : `all ${values.isr} in-sync replicas`}.`,
      `With replication factor ${values.replicationFactor} and min.insync.replicas ${values.minIsr}, the ISR has ${values.isr} replicas and ${values.meetsMin ? "meets" : "does not meet"} the minimum.`,
    ];
    if (values.risk > 0) {
      items.push(
        values.acks === 0
          ? "100% of writes are exposed to loss on a leader failure. With no acknowledgment, the producer cannot even detect it."
          : "100% of acknowledged writes are exposed to loss on a leader failure. The producer can report success for records that exist on only one broker.",
      );
    } else if (values.produceErrors > 0) {
      items.push("Writes are rejected rather than acknowledged weakly. That is a durability choice with an availability cost.");
    } else {
      items.push("Acknowledged writes are replicated across the ISR; a single broker loss does not remove the only copy.");
    }
    items.push("acks=all is not exactly-once: retries can still duplicate a write, so idempotence or transactions are separate decisions.");
    return items;
  },
  legend: [
    { label: "Durable", tone: "ok" },
    { label: "At risk", tone: "warn" },
    { label: "Losing data", tone: "crit" },
    { label: "Failed replica", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "acks=all, replication factor 3, min.insync.replicas 2, and every replica in sync.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak (RF2)",
    description: "Two replicas cut acknowledgment latency, but one broker loss leaves no in-sync pair for acks=all.",
    tone: "info",
    params: defaults({ replicationFactor: 2 }),
  },
  {
    id: "failure",
    label: "Leader loss with acks=1",
    description: "The leader acknowledged writes that no follower had yet replicated, then failed.",
    tone: "crit",
    params: defaults({ acks: 1, brokerFailure: 1 }),
  },
  {
    id: "blocked",
    label: "Minimum too high",
    description: "min.insync.replicas 3 with one broker down: acks=all rejects every write.",
    tone: "crit",
    params: defaults({ minIsr: 3, brokerFailure: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "acks=all, replication factor 3, min.insync.replicas 2, and the broker restored.",
    tone: "ok",
    params: defaults({ brokerFailure: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-acks-loss",
  title: "Predict which acknowledged records survive",
  simId: "producer-acks",
  question:
    "A producer uses acks=1 with replication factor 3. The leader acknowledges 5,000 records and then fails before any follower replicates them. What happens to those acknowledged records?",
  prediction: {
    options: [
      { id: "safe", label: "They are safe because there are three replicas" },
      { id: "lost", label: "They can be lost because only the leader had them" },
      { id: "min-isr", label: "min.insync.replicas protects them from loss" },
      { id: "replay", label: "The consumer can replay them from the leader" },
    ],
    correctOptionId: "lost",
    explanation:
      "acks=1 means the leader writes to its local log and returns success without waiting for followers. If the leader fails before replication, a new leader is elected from the remaining replicas and the acknowledged records are not there. min.insync.replicas only gates writes that use acks=all; it does not retroactively replicate a record. The producer saw success and has no way to know the record was lost.",
  },
  setup: defaults({ acks: 1, brokerFailure: 1 }),
  runFor: 20,
  observe: [
    "Loss exposure is 100%: every acknowledged record is on the failed leader only.",
    "Rejected writes stay at zero, because the producer never waited for a follower.",
    "The ISR is two of three replicas, so the cluster still accepts new writes.",
    "Ack latency is low, which is exactly why acks=1 is tempting.",
  ],
  explain:
    "The acknowledgment is a promise about where the record is. acks=1 promises only the leader's local log. acks=all promises the in-sync replicas, and min.insync.replicas refuses the write when too few replicas are in sync. The leader election can only choose a replica that has the record; if no follower received it, the acknowledged write is gone. Strong durability needs both acks=all and a minimum that leaves a survivable copy.",
  fix: defaults({ acks: 2, minIsr: 2, replicationFactor: 3, brokerFailure: 1 }),
  debrief:
    "Switching to acks=all with min.insync.replicas 2 makes the same broker loss survivable: the ISR is two, the minimum is met, writes continue, and loss exposure is zero. The cost is a higher ack latency while the leader waits for the in-sync replicas.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The producer's acks setting controls how many replicas must acknowledge a record before the send is considered successful. acks=0 does not wait at all; the producer writes to the socket and moves on. acks=1 waits for the partition leader to append the record to its local log. acks=all waits for the full set of in-sync replicas (ISR) to acknowledge it. The setting is a direct trade between acknowledgment latency and the durability of a successful send.",
  },
  {
    type: "p",
    text: "min.insync.replicas is a topic or broker configuration, not a producer setting. With acks=all, the leader rejects the write when the ISR is smaller than that minimum. This is the safety valve: it converts a weak replication state into an error instead of a false success. A replication factor of three with min.insync.replicas of two tolerates one broker loss while keeping every acknowledged write on at least two replicas.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The producer sends to the partition leader. The leader appends to its log and, depending on acks, waits for followers in the ISR before responding. Followers fetch continuously; a follower that falls too far behind leaves the ISR. If the leader fails, the controller elects a new leader from the remaining ISR. A record that was acknowledged by only the old leader may not exist anywhere else.",
  },
  {
    type: "table",
    headers: ["acks", "Waits for", "A successful send means", "Loss window"],
    rows: [
      ["0", "Nothing", "The bytes left the producer", "Any broker or network failure"],
      ["1", "Leader local append", "The leader has it", "Leader fails before followers replicate"],
      ["all", "Every in-sync replica", "The ISR has it, subject to min.insync.replicas", "Only if the ISR itself is insufficient"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: a fixed payload, a replication factor of one to three, and label-only latency numbers. The latency values show the direction of the tradeoff, not a benchmark. The important quantity is the ISR size relative to min.insync.replicas, which is exact in the model.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Loss exposure: the share of acknowledged writes that a leader failure can remove. Warning at 0.1%, critical at 1%.",
      "Rejected writes: the share the leader refuses because the ISR is below the minimum. Warning at 0.1%, critical at 1%.",
      "Ack latency p99, which rises as the producer waits for more replicas.",
      "ISR size and under-replicated partitions, so the replication state is visible next to the ack policy.",
      "A replication view with the leader and each replica, including the failed broker.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Leader loss with acks=1 and compare loss exposure with rejected writes. Run the guided experiment, then try Minimum too high to see the availability cost of durability. Finish with Recovery and check that the ISR is back to three.",
  },
  { type: "sim", simId: "producer-acks" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With acks=1 and replication factor 3, the leader returned success as soon as it wrote to its own log. When that leader failed, one replica was removed from the ISR and the new leader was chosen from the two remaining replicas. Any acknowledged record that had not reached them was gone. Loss exposure read 100%, rejected writes read zero, and p99 acknowledgment latency was the lowest of the durable-looking options. The producer had no error to report.",
  },
  {
    type: "p",
    text: "With acks=all and min.insync.replicas 3 on the same three-replica topic, one broker loss left the ISR at two. The leader refused writes instead of acknowledging a weak copy, so rejected writes read 100%. With min.insync.replicas 2, the same failure left enough replicas, writes continued, and loss exposure stayed at zero. The minimum is the line between availability and durability.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Producer record-error-rate, retry rate, and send latency split by topic and partition.",
      "Topic under-replicated-partitions and the ISR size per partition.",
      "Broker logs for NotEnoughReplicas and NotEnoughReplicasAfterAppend.",
      "Leader election events and the time the partition spent without a leader.",
      "Consumer-side gaps or duplicate effects after a failover, which reveal what the producer was told.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the producer's acks setting and the topic's min.insync.replicas together. Then check the ISR size. A successful send with acks=1 says nothing about the followers, and a full ISR with min.insync.replicas 1 still has a single-copy window.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm what the producer was told: success, timeout, or NotEnoughReplicas.",
      "Check the ISR and the failed broker before assuming the record is lost.",
      "Move durability-sensitive topics to acks=all with min.insync.replicas at least two.",
      "Keep the replication factor above the minimum so one broker loss does not block writes.",
      "Add idempotence or transactions if duplicates, not just loss, are unacceptable.",
      "Re-test a leader failover at peak and verify both loss exposure and write availability.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "acks=all costs acknowledgment latency because the leader waits for the ISR.",
      "min.insync.replicas equal to the replication factor makes a single broker loss block writes.",
      "A higher replication factor costs storage and network bandwidth.",
      "acks=1 is fast and can look healthy until the first leader failure, when acknowledged data disappears.",
      "acks=all does not provide exactly-once; retries can still duplicate, so idempotence or transactions are separate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "success-but-lost",
    question: "A producer returns success and the broker later loses the event. What acks setting was likely used, and why?",
    difficulty: 2,
    hints: [
      "The producer's success is only as strong as the acknowledgments it waited for.",
      "acks=0 has no acknowledgment at all.",
    ],
    answer:
      "The likely setting is acks=1. The leader appended the record locally and returned success before the followers replicated it. When that leader failed, the new leader was chosen from replicas that never had the record, so the acknowledged write disappeared. acks=0 could also lose the record, but the producer never receives a success acknowledgment in that mode; it only knows the bytes were sent. acks=all with an adequate min.insync.replicas would not have acknowledged the write until the in-sync replicas had it.",
    followUps: [
      "What role does min.insync.replicas play?",
      "Could acks=all still lose the record?",
      "How would you prove which setting was used?",
    ],
    redFlags: [
      "Blames the consumer.",
      "Says acks=all was used with no evidence.",
      "Ignores the ISR at the time of failure.",
    ],
    rubric: [
      "Identifies acks=1.",
      "Explains leader-only acknowledgment.",
      "Distinguishes acks=0.",
      "Names min.insync.replicas.",
    ],
  },
  {
    id: "tolerate-one-broker",
    question: "What acks and replication settings let a topic survive one broker loss without losing acknowledged writes?",
    difficulty: 2,
    hints: [
      "The acknowledged copy must exist on more than one broker.",
      "The minimum must still be met after the loss.",
    ],
    answer:
      "I would use acks=all, a replication factor of at least three, and min.insync.replicas of two. A write is acknowledged only after the in-sync replicas have it, and with three replicas one broker can fail while two remain in sync. If the ISR falls below two, the leader rejects writes rather than acknowledge a single copy. That keeps acknowledged data durable through one failure, at the cost of blocking writes if a second replica is unavailable.",
    followUps: [
      "What happens to writes while the ISR is below the minimum?",
      "Can you survive two broker losses?",
      "What does this cost in latency and storage?",
    ],
    redFlags: [
      "Uses acks=1 with replication factor 3.",
      "Sets min.insync.replicas to 1.",
      "Claims two failures are tolerated with RF3 and min ISR 2.",
    ],
    rubric: [
      "Requires acks=all.",
      "Chooses RF3 and min ISR2.",
      "Explains the write rejection when ISR is low.",
      "Names the availability cost.",
    ],
  },
  {
    id: "why-not-min-three",
    question: "If acks=all with min.insync.replicas 2 is good, why not set min.insync.replicas to 3?",
    difficulty: 3,
    hints: [
      "The minimum is checked against the ISR.",
      "A three-replica topic loses one replica in the ISR when one broker fails.",
    ],
    answer:
      "With a replication factor of three, min.insync.replicas 3 means all three replicas must be in sync for a write to succeed. One broker loss drops the ISR to two, below the minimum, so the leader rejects every write until the replica returns. That is maximal durability but poor availability. min.insync.replicas 2 tolerates one broker loss while still requiring two copies. The right choice depends on whether the workload would rather stop writing or risk a weaker copy; for most systems the answer is to keep RF above the minimum.",
    followUps: [
      "When would min.insync.replicas 3 be appropriate?",
      "What happens to the producer during the block?",
      "How does the replication factor change the answer?",
    ],
    redFlags: [
      "Sets the minimum equal to the replication factor without discussing availability.",
      "Thinks min.insync.replicas is a producer setting.",
      "Ignores the ISR drop.",
    ],
    rubric: [
      "Explains the ISR drop after one failure.",
      "Names the availability cost.",
      "Chooses the minimum from the durability target.",
    ],
  },
  {
    id: "acks-exactly-once",
    question: "Does acks=all give exactly-once delivery?",
    difficulty: 3,
    hints: [
      "A timeout is an ambiguous result.",
      "A retry can append the same record twice.",
    ],
    answer:
      "No. acks=all gives stronger durability for an acknowledged write, but a producer that times out does not know whether the write succeeded. If it retries, the record can be appended twice. The idempotent producer adds producer IDs and sequence numbers so the broker can reject duplicates, and transactions extend exactly-once effects across a consume-process-produce flow. Those are separate from acks. acks=all is necessary for the strongest guarantee but not sufficient for exactly-once.",
    followUps: [
      "What does the idempotent producer require?",
      "When do transactions not help?",
      "How does a duplicate differ from a lost write?",
    ],
    redFlags: [
      "Says acks=all means exactly-once.",
      "Ignores retries.",
      "Confuses durability with deduplication.",
    ],
    rubric: [
      "Separates durability from delivery semantics.",
      "Explains timeout and retry duplication.",
      "Names idempotence or transactions.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Durability-sensitive topics use acks=all with min.insync.replicas at least two.",
      "Replication factor is above the minimum so one broker loss does not block writes.",
      "Dashboards show ISR size, under-replicated partitions, producer errors, and send latency.",
      "A leader failover test verifies both loss exposure and write availability.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check what the producer was told before assuming data is safe.",
      "Compare the ISR with min.insync.replicas for the affected partitions.",
      "Do not lower the minimum during an incident without recording the durability decision.",
      "Protect consumers from duplicate effects after a failover.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile records that were acknowledged during the failure window.",
      "Verify the ISR is back to the replication factor.",
      "Re-test failover with the production acks and minimum.",
      "Document the durability guarantee and its availability cost.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: producer configs",
    url: "https://kafka.apache.org/44/configuration/producer-configs/#producerconfigs_acks",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "acks=0, 1, and all, retries, and idempotence requirements.",
  },
  {
    title: "Apache Kafka documentation: topic configs",
    url: "https://kafka.apache.org/44/configuration/topic-configs/#topicconfigs_min.insync.replicas",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "min.insync.replicas and write rejection when the ISR is too small.",
  },
  {
    title: "Apache Kafka documentation: replication design",
    url: "https://kafka.apache.org/44/design/design/#replication",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Leader and follower replicas, the ISR, and leader election.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "producer-acks": {
      model: producerAcksModel,
      presets,
      instructions:
        "Start healthy, then apply Leader loss with acks=1 and compare loss exposure with rejected writes. Run the experiment, try Minimum too high, then finish with Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Latency values show direction, not a benchmark; the ISR and minimum relationship is exact.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-kafka-partitions",
    "streaming-kafka-isr",
    "streaming-keys-ordering",
    "streaming-consumer-groups",
  ],
};
