import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PRODUCE_RATE = 2_000;
const CONSUMER_CAPACITY = 2_500;
const FIRST_POISON_AT = 2.5;
const MAX_LAG = 5_000_000;

const params = [
  {
    id: "badRecordShare",
    label: "Malformed records",
    min: 0,
    max: 3,
    step: 0.01,
    value: 0.01,
    unit: "%",
    group: "Traffic",
    help: "Share of records that cannot be processed. The model introduces them at a deterministic interval derived from this value.",
    format: "percent" as const,
  },
  {
    id: "retryLimit",
    label: "Retry limit",
    min: 0,
    max: 10,
    step: 1,
    value: 3,
    unit: "",
    group: "Failure handling",
    help: "Attempts before the consumer gives up on a record. Every attempt blocks the partition's processing loop.",
    format: "count" as const,
  },
  {
    id: "retryBackoffMs",
    label: "Retry backoff",
    min: 0,
    max: 2_000,
    step: 100,
    value: 200,
    unit: " ms",
    group: "Failure handling",
    help: "Wait between attempts. Backoff reduces retry pressure but adds directly to the partition's blocked time.",
    format: "ms" as const,
  },
  {
    id: "quarantine",
    label: "Quarantine after retries",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failure handling",
    help: "1 routes the record to a dead letter queue after the retry budget. 0 leaves the consumer stuck on it, blocking every record behind it.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flag(p: Params, id: string, fallback = 0): number {
  return num(p, id, fallback);
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Snapshot {
  lag: number;
  dlq: number;
  blockRemaining: number;
  nextPoisonIn: number;
  stalled: boolean;
  stallSeconds: number;
  poisonCount: number;
  processedRate: number;
}

function buildFrame(p: Params, t: number, snapshot: Snapshot, flags: SimFrame["flags"]): SimFrame {
  const lag = Math.max(0, snapshot.lag);
  const dlq = Math.max(0, snapshot.dlq);
  const consumerHealth = snapshot.stalled ? "crit" : snapshot.blockRemaining > 0 || lag > 2_000 ? "warn" : "ok";
  const topicHealth = healthFor(lag, 2_000, 10_000);
  const retryBudget = Math.max(0, Math.round(num(p, "retryLimit", 3))) * Math.max(0, num(p, "retryBackoffMs", 200)) / 1_000;
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders producer",
        kind: "service",
        health: "ok",
        utilization: clamp(PRODUCE_RATE / CONSUMER_CAPACITY),
        throughput: PRODUCE_RATE,
        sublabel: `${PRODUCE_RATE.toLocaleString("en-US")} rec/s`,
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders.partition-3",
        kind: "queue",
        health: topicHealth,
        throughput: PRODUCE_RATE,
        sublabel: `${Math.round(lag).toLocaleString("en-US")} behind · ${snapshot.stalled ? "blocked" : snapshot.blockRemaining > 0 ? "retrying" : "processing"}`,
        detail: snapshot.stalled
          ? "The consumer is stuck on one record. Every record behind it is waiting, and the offset cannot advance."
          : `One partition delivers ${PRODUCE_RATE.toLocaleString("en-US")} rec/s. In-order processing means a record cannot be skipped while the consumer retries it.`,
        meta: { depth: lag, poisons: snapshot.poisonCount, stalled: snapshot.stalled ? 1 : 0 },
      },
      {
        id: "consumer",
        label: "orders-consumer-3",
        kind: "worker",
        health: consumerHealth,
        utilization: snapshot.stalled ? 1 : clamp(snapshot.processedRate / CONSUMER_CAPACITY),
        throughput: snapshot.processedRate,
        capacity: CONSUMER_CAPACITY,
        sublabel: snapshot.stalled
          ? "stalled on a poison record"
          : snapshot.blockRemaining > 0
            ? `retrying for ${snapshot.blockRemaining.toFixed(1)}s`
            : `${Math.round(snapshot.processedRate).toLocaleString("en-US")} rec/s`,
        detail: `Retry budget ${Math.round(num(p, "retryLimit", 3))} attempts at ${Math.round(num(p, "retryBackoffMs", 200))}ms adds ${retryBudget.toFixed(1)}s of blocked time per poison record. ${num(p, "quarantine", 1) === 1 ? "After the budget, the record is quarantined and the partition resumes." : "With quarantine off, the consumer never advances past the record."}`,
        meta: { capacity: CONSUMER_CAPACITY, blocked: snapshot.blockRemaining, stalled: snapshot.stalled ? 1 : 0 },
      },
      {
        id: "dlq",
        label: "orders-dlq",
        kind: "queue",
        health: healthFor(dlq, 100, 1_000),
        throughput: 0,
        sublabel: `${Math.round(dlq).toLocaleString("en-US")} quarantined`,
        detail: "Quarantined records are removed from the partition's path so later records can proceed. They still need an owner, a retention window, and a replay path.",
        meta: { depth: dlq },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", 1, "ok"),
      edge("topic-consumer", "topic", "consumer", clamp(snapshot.processedRate / PRODUCE_RATE), consumerHealth),
      edge("consumer-dlq", "consumer", "dlq", dlq > 0 ? 0.2 : 0, healthFor(dlq, 100, 1_000)),
    ],
    metrics: [
      metric("queueDepth", "Partition lag", lag, " rec", 2_000, 10_000, "count"),
      metric("partition-throughput", "Partition throughput", snapshot.processedRate, " rec/s", undefined, undefined, "rps"),
      metric("blocked-seconds", "Head-of-line block", snapshot.stallSeconds, " s", 10, 30, "count"),
      metric("dlq-depth", "DLQ depth", dlq, " rec", 100, 1_000, "count"),
      metric("poison-records", "Poison records seen", snapshot.poisonCount, " rec", undefined, undefined, "count"),
      metric("retry-pause", "Current retry pause", snapshot.blockRemaining, " s", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      seed: Number(flags.seed ?? 0),
      lag,
      dlq,
      blockRemaining: snapshot.blockRemaining,
      nextPoisonIn: snapshot.nextPoisonIn,
      stalled: snapshot.stalled ? 1 : 0,
      stallSeconds: snapshot.stallSeconds,
      poisonCount: snapshot.poisonCount,
    },
    summary: snapshot.stalled
      ? `The partition is stalled on a poison record with ${Math.round(lag).toLocaleString("en-US")} records behind it.`
      : `The partition is processing ${Math.round(snapshot.processedRate).toLocaleString("en-US")} rec/s with ${Math.round(lag).toLocaleString("en-US")} records waiting and ${Math.round(dlq).toLocaleString("en-US")} quarantined.`,
  };
}

function seedSeries(frame: SimFrame, snapshot: Snapshot, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 13)) / 2.7);
  const values: [string, number][] = [
    ["queueDepth", snapshot.lag],
    ["partition-throughput", snapshot.processedRate],
    ["blocked-seconds", snapshot.stallSeconds],
    ["dlq-depth", snapshot.dlq],
    ["poison-records", snapshot.poisonCount],
    ["retry-pause", snapshot.blockRemaining],
  ];
  for (const [id, value] of values) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function initialSnapshot(p: Params): Snapshot {
  return {
    lag: 0,
    dlq: 0,
    blockRemaining: 0,
    nextPoisonIn: num(p, "badRecordShare", 0.01) > 0 ? FIRST_POISON_AT : 86_400,
    stalled: false,
    stallSeconds: 0,
    poisonCount: 0,
    processedRate: PRODUCE_RATE,
  };
}

export const poisonMessagesModel: SimModel = {
  id: "streaming-poison-messages",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const snapshot = initialSnapshot(p);
    const frame = buildFrame(p, 0, snapshot, { seed });
    seedSeries(frame, snapshot, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const badShare = Math.max(0, num(p, "badRecordShare", 0.01));
    const retryLimit = Math.max(0, Math.round(num(p, "retryLimit", 3)));
    const backoff = Math.max(0, num(p, "retryBackoffMs", 200));
    const quarantine = num(p, "quarantine", 1) >= 1;
    const stallSeconds = flag(frame.flags, "stallSeconds");
    const poisonCount = flag(frame.flags, "poisonCount");
    const previousDlq = flag(frame.flags, "dlq");
    const stalled = frame.flags.stalled === 1;
    let lag = flag(frame.flags, "lag") + PRODUCE_RATE * seconds;
    let dlq = previousDlq;
    let blockRemaining = flag(frame.flags, "blockRemaining");
    let nextPoisonIn = flag(frame.flags, "nextPoisonIn", FIRST_POISON_AT);
    let nextStalled = stalled;
    let nextStallSeconds = stallSeconds + (stalled ? seconds : 0);
    let nextPoisonCount = poisonCount;
    let processedRate = 0;

    if (nextStalled && quarantine) {
      dlq += 1;
      nextStalled = false;
      nextStallSeconds = 0;
    }

    if (nextStalled) {
      processedRate = 0;
    } else if (blockRemaining > 0) {
      blockRemaining = Math.max(0, blockRemaining - seconds);
      if (blockRemaining === 0) {
        if (quarantine) dlq += 1;
        else {
          nextStalled = true;
          nextStallSeconds = 0;
        }
      }
    } else {
      const processed = Math.min(CONSUMER_CAPACITY * seconds, lag);
      lag -= processed;
      processedRate = processed / seconds;
      if (badShare > 0) {
        nextPoisonIn -= seconds;
        if (nextPoisonIn <= 0) {
          nextPoisonCount += 1;
          const block = (retryLimit * backoff) / 1_000;
          if (block > 0) {
            blockRemaining = block;
            processedRate = 0;
          } else if (quarantine) {
            dlq += 1;
          } else {
            nextStalled = true;
            nextStallSeconds = 0;
            processedRate = 0;
          }
          const interval = Math.max(seconds, 100 / Math.max(0.001, PRODUCE_RATE * badShare));
          nextPoisonIn = interval;
        }
      }
    }

    if (nextStalled && !stalled) nextStallSeconds = 0;
    const snapshot: Snapshot = {
      lag: Math.min(MAX_LAG, Math.max(0, lag)),
      dlq,
      blockRemaining,
      nextPoisonIn,
      stalled: nextStalled,
      stallSeconds: nextStalled ? nextStallSeconds : 0,
      poisonCount: nextPoisonCount,
      processedRate,
    };
    const t = frame.t + seconds;
    const next = buildFrame(p, t, snapshot, frame.flags);
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (nextPoisonCount > poisonCount && blockRemaining > 0 && frame.flags.poisonDetected !== 1) {
      pushEvent(next, {
        id: "poison-record-blocking",
        at: t,
        severity: "warn",
        title: "A poison record is blocking the partition",
        detail: `The consumer is retrying one record. The partition cannot advance its offset, so every record behind it waits. Retry budget is ${retryLimit} attempts with ${backoff}ms backoff.`,
        nodeId: "consumer",
        metricId: "queueDepth",
      });
      next.flags.poisonDetected = 1;
    }
    if (nextStalled && frame.flags.partitionStalled !== 1) {
      pushEvent(next, {
        id: "partition-stalled",
        at: t,
        severity: "crit",
        title: "The partition is stalled on a single record",
        detail: `Retries are exhausted and quarantine is off. The consumer cannot move past the record, so the partition's lag grows at the full produce rate of ${PRODUCE_RATE.toLocaleString("en-US")} rec/s.`,
        nodeId: "consumer",
        metricId: "blocked-seconds",
      });
      next.flags.partitionStalled = 1;
    }
    if (dlq > previousDlq && frame.flags.dlqUsed !== 1) {
      pushEvent(next, {
        id: "poison-quarantined",
        at: t,
        severity: "info",
        title: "A poison record was quarantined",
        detail: "The consumer moved past the failing record. The partition continues, and the record now needs an owner, a retention window, and a replay decision.",
        nodeId: "dlq",
        metricId: "dlq-depth",
      });
      next.flags.dlqUsed = 1;
    }
    if (!nextStalled) next.flags.partitionStalled = 0;
    return next;
  },
  thresholds: [
    {
      id: "queueDepth",
      metricId: "queueDepth",
      warn: 2_000,
      crit: 10_000,
      title: "The partition backlog is growing behind one record",
      cause:
        "A record that always fails is retried inside the in-order processing loop. While the consumer retries it, no later record can be processed or committed, so lag grows at the full produce rate even though only one record is bad.",
      fix:
        "Bound the retry budget and make the failure path explicit. Quarantine the record after the budget so the partition can advance, then decide whether to replay, repair, or drop it. Validate the event shape before it reaches the processing loop.",
      checkFirst: [
        "Look for a repeated offset or repeated error in the consumer log.",
        "Check whether lag growth started at one record and never recovered.",
        "Check whether the consumer is retrying inside the poll loop or handing retries to a separate path.",
      ],
    },
    {
      id: "blocked-seconds",
      metricId: "blocked-seconds",
      warn: 10,
      crit: 30,
      title: "The partition has been blocked past the recovery budget",
      cause:
        "The retry budget is longer than the partition can afford. Every poison record consumes the consumer's processing time, and with no quarantine the first exhausted retry budget stalls the partition permanently.",
      fix:
        "Reduce retries and backoff to a bounded total, route exhausted records to a DLQ, and alert on the oldest uncommitted record. A separate retry topic can preserve order for the good records without holding the main partition.",
      checkFirst: [
        "Check the age of the oldest uncommitted record, not only the count.",
        "Check whether retries are synchronous with the poll loop.",
        "Check whether a DLQ or retry topic already exists and is wired to an owner.",
      ],
    },
    {
      id: "dlq-depth",
      metricId: "dlq-depth",
      warn: 100,
      crit: 1_000,
      title: "Quarantined records are accumulating",
      cause:
        "The consumer is moving again, but every quarantine is a record that did not complete. A DLQ without alerting and replay converts a visible processing failure into a quiet data-loss path.",
      fix:
        "Alert on DLQ arrival rate and depth, assign an owner, and define a replay path. Fix the producer validation that let the malformed record through, then replay or repair the quarantined records.",
      checkFirst: [
        "Check the DLQ arrival rate and the oldest record's age.",
        "Check whether the same producer or schema change explains the malformed records.",
        "Check whether the DLQ has an owner and a retention policy.",
      ],
    },
  ],
  insights: (frame, p) => {
    const lag = flag(frame.flags, "lag");
    const dlq = flag(frame.flags, "dlq");
    const stalled = frame.flags.stalled === 1;
    const retryLimit = Math.round(num(p, "retryLimit", 3));
    const backoff = num(p, "retryBackoffMs", 200);
    const items: string[] = [];
    items.push(
      `The consumer has ${Math.round(CONSUMER_CAPACITY).toLocaleString("en-US")} rec/s of capacity against ${PRODUCE_RATE.toLocaleString("en-US")} rec/s of production. The partition can keep up only while the consumer is actually processing.`,
    );
    if (stalled) {
      items.push("The consumer is stuck on one record. Lag grows at the full produce rate because no later record can be committed.");
    } else if (lag > 0) {
      items.push(`${Math.round(lag).toLocaleString("en-US")} records are waiting. The backlog is the cost of retries that block the processing loop, not a capacity shortfall.`);
    } else {
      items.push(`No backlog. A poison record costs ${((retryLimit * backoff) / 1_000).toFixed(1)}s of blocked processing time before it is quarantined.`);
    }
    if (dlq > 0) {
      items.push(`${Math.round(dlq).toLocaleString("en-US")} records are in the DLQ. Quarantine protects the partition but moves the correctness problem to the DLQ's owner.`);
    }
    items.push("Validation at the producer prevents the bad record. A retry budget and a quarantine path protect the partition when validation misses one.");
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
    description: "A rare malformed record is retried briefly and quarantined; the partition keeps up.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "More malformed records are quarantined immediately, so the partition stays current but the DLQ fills.",
    tone: "warn",
    params: defaults({ badRecordShare: 0.2, retryLimit: 0, retryBackoffMs: 0 }),
  },
  {
    id: "failure",
    label: "Poison message",
    description: "A record fails ten retries and the consumer has no quarantine path, so the partition stops.",
    tone: "crit",
    params: defaults({ badRecordShare: 2, retryLimit: 10, retryBackoffMs: 1_000, quarantine: 0 }),
  },
  {
    id: "recovery",
    label: "Bounded retries",
    description: "The same failure path now quarantines after a short retry budget, so the partition drains.",
    tone: "ok",
    params: defaults({ badRecordShare: 0.02, retryLimit: 3, retryBackoffMs: 100, quarantine: 1 }),
  },
  {
    id: "skip",
    label: "Skip the record",
    description: "Quarantine every failure immediately. The partition keeps up, but the DLQ grows.",
    tone: "warn",
    params: defaults({ badRecordShare: 2, retryLimit: 0, retryBackoffMs: 0, quarantine: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-poison-recovery",
  title: "Predict what stops the partition",
  simId: "poison-messages",
  question:
    "One malformed record fails every retry. The consumer retries it ten times inside the poll loop. What is the first change that lets the partition process later records without silently dropping the bad one?",
  prediction: {
    options: [
      { id: "retries", label: "Raise the retry limit so the record eventually succeeds" },
      { id: "skip", label: "Commit past the record and continue as if it succeeded" },
      { id: "quarantine", label: "Bound the retry budget and quarantine the record to a DLQ" },
      { id: "consumers", label: "Add consumers so another member processes the blocked partition" },
    ],
    correctOptionId: "quarantine",
    explanation:
      "The record is deterministic: the same malformed input will fail every retry. More retries add blocked time; committing past it silently loses the record. A bounded retry budget followed by a quarantine keeps the partition moving and preserves the failure in a queue with an owner. Consumers cannot split one partition, so another member cannot take the blocked records.",
  },
  setup: defaults({ badRecordShare: 2, retryLimit: 10, retryBackoffMs: 1_000, quarantine: 0 }),
  runFor: 45,
  observe: [
    "The partition stalls after the retry budget is exhausted and never advances.",
    "Lag grows at the full produce rate while throughput falls to zero.",
    "The DLQ stays empty because there is no quarantine path.",
    "A second consumer has nothing to process; the partition is still assigned to the stalled member.",
  ],
  explain:
    "In-order processing makes the consumer's failure handling part of the data path. A synchronous retry holds the offset and blocks every later record, so one bad input becomes a partition outage. Quarantine is not data loss if the record is retained and owned; it is a controlled move of the failure out of the hot path. Validation at the producer is the prevention, and a retry topic is the option when the failure is transient and order for the good records must be preserved.",
  fix: defaults({ badRecordShare: 0.02, retryLimit: 3, retryBackoffMs: 100, quarantine: 1 }),
  debrief:
    "With a bounded retry budget and quarantine, the partition processes about 2,300 rec/s and drains the backlog. The bad-record share also falls because the producer now validates the event before publishing. The DLQ receives a small number of records that need repair or replay. The tradeoff is operational work: a DLQ with no owner is just a quieter outage.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A poison message is a record that can never be processed successfully. The bytes may be malformed, the schema may be wrong, or the business rule may reject the payload every time. In a Kafka partition, records are processed in order and the consumer commits an offset only after it has handled them. If the consumer retries the bad record inside its poll loop, the offset cannot advance. Every record behind it waits, even though none of them is bad.",
  },
  {
    type: "p",
    text: "This is head-of-line blocking. More retries do not fix a deterministic failure; they lengthen the time the partition is unavailable. Committing past the record keeps the partition moving but can silently lose data. The workable pattern is a bounded retry budget plus an explicit quarantine path, usually a dead letter queue, with validation at the producer to reduce how often the path is needed.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, partition, consumer poll loop, downstream write. The consumer fetches a batch, processes each record in order, and commits the offset after the batch. A synchronous retry sits between the record and the commit. A DLQ write happens before the offset advances so the record can be removed from the main path without losing it. A separate retry topic moves transient failures off the hot path while preserving order for the records that succeed.",
  },
  {
    type: "table",
    headers: ["Response", "What it protects", "What it costs"],
    rows: [
      ["Retry forever", "The record is never dropped", "The partition stops; lag grows without bound"],
      ["Retry a bounded number of times", "Transient failures get another chance", "A permanent failure still needs a next step"],
      ["Commit past the record", "The partition keeps moving", "The record is lost unless it was copied elsewhere"],
      ["Quarantine to a DLQ", "Progress plus a retained failure", "A new queue needs an owner, alerting, and replay"],
      ["Retry topic", "Order for good records; delayed retries", "More topics, more lag, and replay ordering to design"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: one partition at 2,000 records per second, a consumer that can process 2,500, and a poison record every few seconds. They are teaching values, not Kafka limits. The shape of the failure is the lesson: a deterministic failure inside the in-order loop turns one record into a stopped partition.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Partition lag: records waiting behind the failing one. Warning at 2,000, critical at 10,000.",
      "Partition throughput: records processed per second. It falls to zero when the consumer stalls.",
      "Head-of-line block: simulated seconds in the stalled state. Warning at 10, critical at 30.",
      "DLQ depth: quarantined records that still need a decision.",
      "A queue view with the partition, the consumer, and the DLQ.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Poison message. Watch throughput fall to zero while lag climbs. Run the experiment before changing sliders: predict which response restores progress. Then compare Bounded retries and Skip the record, and watch what happens to the DLQ.",
  },
  { type: "sim", simId: "poison-messages" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The consumer met a record that failed every attempt. It retried ten times with one second of backoff, holding the partition for about ten seconds. When the budget ran out, the consumer had no quarantine path, so it stayed on the record. Throughput went to zero, lag grew at 2,000 records per second, and the DLQ remained empty. The other consumers were irrelevant: the bad record belonged to one partition, and that partition had one owner.",
  },
  {
    type: "p",
    text: "Recovery bounded the retry budget and quarantined the record. The partition resumed, drained the backlog, and moved the failure into a queue with a depth metric. The bad-record share fell as well because validation rejected malformed events before they reached the consumer. Quarantine did not make the record correct; it made the failure visible and bounded.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer lag for one partition growing while the others are current, with throughput near zero.",
      "A repeated offset or repeated exception in the consumer log.",
      "Commit latency rising because the offset cannot advance past the failing record.",
      "DLQ depth and arrival rate, if a quarantine path exists.",
      "Producer validation errors and schema-registry rejections around the same time.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the same offset is failing repeatedly. Then check whether retries happen inside the poll loop, how long the retry budget blocks the partition, and whether a quarantine path exists. Do not add consumers before confirming that the partition is already assigned to one member.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the failing offset and the exception. Confirm that the input is deterministically bad rather than a transient dependency failure.",
      "Bound the retry budget so a poison record cannot hold the partition indefinitely.",
      "Quarantine the record after the budget and advance the offset. Keep the record, its headers, and its failure reason.",
      "Alert on DLQ arrival rate, depth, and oldest age, and assign an owner.",
      "Fix the producer validation or schema that admitted the record, then replay or repair the quarantined events.",
      "If failures are transient and order matters, use a retry topic with delayed retries rather than synchronous retries.",
      "Re-run the failure case and verify that throughput recovers while the DLQ retains the record.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Quarantine protects the partition but moves correctness work to the DLQ; without replay and ownership it becomes data loss with extra steps.",
      "A short retry budget recovers from brief blips but quarantines transient failures sooner.",
      "Skipping the record is the fastest path and the least safe; it needs an audit trail to be defensible.",
      "A retry topic preserves order for good records but adds another stream, another consumer, and a replay ordering problem.",
      "Validation at the producer prevents bad records but couples producers to consumer expectations and can reject valid future shapes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "poison-diagnosis",
    question:
      "One partition's lag is growing and its consumer throughput is near zero. How do you confirm a poison message?",
    difficulty: 3,
    hints: [
      "Look for a repeated offset, not just a high lag.",
      "A transient downstream failure looks different from a deterministic parse failure.",
    ],
    answer:
      "I would check whether the same offset is being fetched and failing repeatedly. A poison record usually produces the same exception for the same bytes, while a downstream outage produces timeouts across many offsets or partitions. I would inspect the consumer log for the record key, topic, partition, and offset, then reproduce the deserialization or business-rule failure from the retained record. I would also check whether the retry loop is synchronous with the poll loop, because that is what converts one bad record into a stopped partition. If the record is available in the log, I can copy it to a test topic and replay it through the same consumer code.",
    followUps: [
      "How would you tell a poison record from a slow downstream dependency?",
      "What would you do if the record cannot be reproduced?",
      "Which metric tells you the partition is stalled rather than merely slow?",
    ],
    redFlags: [
      "Adds consumers without checking partition assignment.",
      "Raises retries without bounding the block.",
      "Commits past the record with no copy.",
    ],
    rubric: [
      "Names the repeated offset and deterministic failure.",
      "Distinguishes poison from transient dependency failure.",
      "Checks whether retries block the poll loop.",
      "Preserves the record for replay.",
    ],
  },
  {
    id: "retry-budget",
    question:
      "How do you choose a retry budget for a consumer that must preserve order?",
    difficulty: 3,
    hints: [
      "The budget is measured in blocked partition time, not attempts.",
      "A retry that succeeds after the freshness budget is already too late.",
    ],
    answer:
      "I would start from the partition's freshness objective and the expected duration of a transient failure. The budget is attempts times backoff, and that total is time the partition cannot process anything else. If the freshness objective allows 30 seconds of delay, a budget close to that leaves no room for normal lag. I would keep the synchronous budget short, move longer retries to a retry topic, and quarantine deterministic failures immediately. I would also add jitter to backoff so many consumers do not retry the same dependency at once. The exact number comes from the objective and the failure distribution, not from a default.",
    followUps: [
      "What changes if the downstream is a shared dependency?",
      "Why add jitter to backoff?",
      "When is a retry topic better than a synchronous retry?",
    ],
    redFlags: [
      "Picks a retry count without a time budget.",
      "Retries forever in the poll loop.",
      "Ignores the freshness objective.",
    ],
    rubric: [
      "Measures the budget in blocked time.",
      "Ties it to the freshness objective.",
      "Separates transient from deterministic failures.",
      "Mentions jitter or a retry topic.",
    ],
  },
  {
    id: "dlq-ordering",
    question:
      "Quarantining a record lets the partition advance, but what ordering guarantee did you change, and how do you recover it?",
    difficulty: 3,
    hints: [
      "The records around the quarantined one have already moved on.",
      "A replay must decide where the recovered record belongs.",
    ],
    answer:
      "The partition keeps order for the records that were processed, but the quarantined record is now outside that order. If it is repaired and replayed at the tail, later records for the same entity may already have been applied, so the repair can overwrite newer state. I would preserve the original partition, offset, key, and timestamp in the DLQ, then replay through an idempotent path that checks version or sequence. If order is essential, I would stop that key's stream, repair the record, and resume from the correct point rather than appending at the tail. The choice depends on whether the downstream operation is commutative or versioned.",
    followUps: [
      "How would you replay one key without stopping the whole topic?",
      "What metadata must the DLQ record carry?",
      "When is tail replay safe?",
    ],
    redFlags: [
      "Replays at the tail without checking versions.",
      "Drops the original offset and key.",
      "Assumes the downstream is idempotent.",
    ],
    rubric: [
      "States the order guarantee that was broken.",
      "Preserves offset, key, and version metadata.",
      "Describes a safe replay path.",
      "Names the operations that rule out tail replay.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Producer validation rejects malformed events before they enter the topic.",
      "Consumers have a bounded retry budget and a quarantine path.",
      "DLQ depth, arrival rate, and oldest age are monitored with an owner.",
      "The consumer exposes the offset and exception for a failing record.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm that one offset is failing repeatedly and that throughput is falling.",
      "Bound synchronous retries so the partition can make progress.",
      "Quarantine the record with its original metadata and failure reason.",
      "Do not add consumers; the partition is already assigned to one member.",
      "Record the offset, key, and exception for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Alert on DLQ arrival rate, not only depth.",
      "Repair or replay the quarantined records through an idempotent path.",
      "Fix the producer or schema that admitted the bad record.",
      "Re-run the poison scenario and verify that the partition recovers.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: Kafka Connect user guide, error reporting",
    url: "https://kafka.apache.org/documentation/#connect_user",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "How Connect records failures, skips problematic records, and writes a dead letter queue.",
  },
  {
    title: "Confluent documentation: view connector dead letter queue errors",
    url: "https://docs.confluent.io/cloud/current/connectors/dead-letter-queue.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "How connector serde failures are routed to a DLQ and identified from record headers.",
  },
  {
    title: "Apache Kafka documentation: consumer configs",
    url: "https://kafka.apache.org/documentation/#consumerconfigs",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Poll, commit, and fetch settings that shape retry behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "poison-messages": {
      model: poisonMessagesModel,
      presets,
      instructions:
        "Start Healthy, then apply Poison message. Watch throughput fall to zero while lag grows. Run the experiment, then compare Bounded retries and Skip the record and watch the DLQ.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Produce rates, retry budgets, and poison frequency are teaching values, not Kafka limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-slow-consumers",
    "streaming-dlq",
    "streaming-consumer-groups",
    "streaming-retention",
    "streaming-idempotent-producer",
  ],
};
