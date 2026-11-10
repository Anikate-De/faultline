import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SINK_CAPACITY = 30_000;

const params = [
  {
    id: "inputRate",
    label: "Input records",
    min: 2_000,
    max: 20_000,
    step: 1_000,
    value: 8_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records consumed from the input topic and written to the sink.",
    format: "rps" as const,
  },
  {
    id: "transactions",
    label: "Kafka transactions",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Broker",
    help: "1 makes the produced records and the consumed offsets commit atomically. It does not include a write to an external sink.",
    format: "count" as const,
  },
  {
    id: "idempotentSink",
    label: "Idempotent sink",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Sink",
    help: "1 deduplicates writes by event ID, so replaying the same event does not apply the effect twice.",
    format: "count" as const,
  },
  {
    id: "retryRate",
    label: "Retry or crash rate",
    min: 0,
    max: 5,
    step: 0.5,
    value: 0.5,
    unit: "%",
    group: "Failure",
    help: "Share of records that trigger a retry, timeout, or replay window. This is the fault that exposes the guarantee boundary.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  input: number;
  transactions: boolean;
  idempotent: boolean;
  retryRate: number;
  brokerDupRate: number;
  sinkDupRate: number;
  endToEndPct: number;
  brokerPct: number;
  p99: number;
  utilization: number;
}

function compute(p: Params): Computed {
  const input = Math.max(100, num(p, "inputRate", 8_000));
  const transactions = num(p, "transactions", 1) >= 1;
  const idempotent = num(p, "idempotentSink", 1) >= 1;
  const retryRate = clamp(num(p, "retryRate", 0.5), 0, 5) / 100;
  const faults = input * retryRate;
  const brokerDupRate = faults * (transactions ? 0 : 1);
  const sinkDupRate = faults * (idempotent ? 0 : transactions ? 0.45 : 1);
  const p99 = 18 + (transactions ? 14 : 0) + (idempotent ? 9 : 0) + (input / 1_000) * 0.6;
  return {
    input,
    transactions,
    idempotent,
    retryRate: retryRate * 100,
    brokerDupRate,
    sinkDupRate,
    endToEndPct: (sinkDupRate / input) * 100,
    brokerPct: (brokerDupRate / input) * 100,
    p99,
    utilization: input / SINK_CAPACITY,
  };
}

function healthFor(endToEndPct: number, brokerPct: number): "ok" | "warn" | "crit" {
  if (endToEndPct >= 0.25 || brokerPct >= 1) return "crit";
  if (endToEndPct >= 0.05 || brokerPct >= 0.2) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, flags: SimFrame["flags"]): SimFrame {
  const c = compute(p);
  const health = healthFor(c.endToEndPct, c.brokerPct);
  const sinkHealth = healthFor(c.endToEndPct, 0);
  return {
    t,
    nodes: [
      {
        id: "input",
        label: "payments.in",
        kind: "stream",
        health: "ok",
        throughput: c.input,
        sublabel: `${Math.round(c.input).toLocaleString("en-US")} rec/s`,
        meta: { view: "flow" },
      },
      {
        id: "processor",
        label: "enrichment consumer",
        kind: "service",
        health,
        utilization: clamp(c.utilization),
        throughput: c.input,
        capacity: SINK_CAPACITY,
        sublabel: c.transactions ? "transactional read-process-write" : "output write, then offset commit",
        detail: c.transactions
          ? "The produced record and the consumed offset commit together. A retry replays the batch, but the broker hides aborted or duplicate transactional records from read_committed consumers."
          : "The output record is written and the offset is committed separately. A crash between the two steps replays records that were already written.",
        meta: {
          retryRate: c.retryRate,
          brokerDupPct: c.brokerPct,
          sinkDupPct: c.endToEndPct,
        },
      },
      {
        id: "output",
        label: "payments.out",
        kind: "stream",
        health: healthFor(0, c.brokerPct),
        throughput: c.input,
        sublabel: c.transactions ? "read_committed visible" : "retries may duplicate records",
        detail: `At ${c.retryRate.toFixed(1)}% retries, the broker duplicate rate is ${c.brokerPct.toFixed(2)}%. Transactions remove this rate; they do not remove the sink write.`,
        meta: { view: "flow" },
      },
      {
        id: "sink",
        label: "ledger database",
        kind: "db",
        health: sinkHealth,
        utilization: clamp(c.utilization),
        throughput: c.input,
        capacity: SINK_CAPACITY,
        sublabel: c.idempotent ? "upsert by event_id" : "append-only insert",
        detail: c.idempotent
          ? "The sink keys each write by event ID. Replaying a record overwrites the same row instead of applying a second effect."
          : "The sink appends a new effect for every write. A replay after a successful write leaves a duplicate that Kafka cannot remove.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("input-processor", "input", "processor", clamp(c.utilization), "ok"),
      edge("processor-output", "processor", "output", clamp(c.utilization), health),
      edge("output-sink", "output", "sink", clamp(c.utilization), sinkHealth),
    ],
    metrics: [
      metric("end-to-end-dup", "End-to-end duplicate rate", c.endToEndPct, "%", 0.05, 0.25, "percent"),
      metric("broker-dup", "Broker duplicate rate", c.brokerPct, "%", 0.2, 1, "percent"),
      metric("sink-p99", "Sink write p99", c.p99, " ms", 60, 120, "ms"),
      metric("processed-rate", "Processed records", c.input, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { ...flags, paramsKey: JSON.stringify(p) },
    summary: `${c.endToEndPct.toFixed(2)}% end-to-end duplicate rate and ${c.brokerPct.toFixed(2)}% broker duplicates at ${Math.round(c.input).toLocaleString("en-US")} rec/s. Transactions are ${c.transactions ? "on" : "off"}; the sink is ${c.idempotent ? "idempotent" : "append-only"}.`,
  };
}

function seedSeries(frame: SimFrame, c: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.3);
  const seedValues: [string, number, number][] = [
    ["end-to-end-dup", c.endToEndPct, 0.02],
    ["broker-dup", c.brokerPct, 0.02],
    ["sink-p99", c.p99, 2],
    ["processed-rate", c.input, 120],
  ];
  for (const [id, value, amplitude] of seedValues) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 1.9) * amplitude),
    );
  }
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "end-to-end-duplicates",
    metricId: "end-to-end-dup",
    warn: 0.05,
    crit: 0.25,
    title: "The sink has applied duplicate effects",
    cause:
      "A retry or replay rewrote a record whose sink effect had already committed. Kafka offsets and Kafka records can be atomic while the external write remains outside that boundary.",
    fix:
      "Make the sink idempotent with a stable event key and an upsert or dedupe table, or move the effect into a transactional output that shares the same commit boundary. Verify with a replay test, not with the producer setting.",
    checkFirst: [
      "Compare the sink row count with the distinct event count.",
      "Check whether the event ID is stable across retries and restarts.",
      "Confirm that the sink write and the offset commit are in the same atomic boundary.",
    ],
  },
  {
    id: "broker-duplicates",
    metricId: "broker-dup",
    warn: 0.2,
    crit: 1,
    title: "The output topic contains duplicate records",
    cause:
      "The producer or consumer retried without an idempotent producer or a transaction. The broker accepted the retry as a new record, so every downstream consumer sees it.",
    fix:
      "Enable idempotence for the producer and transactions for the read-process-write path. Downstream readers must use read_committed if they need to hide aborted records.",
    checkFirst: [
      "Inspect producer retries and duplicate record counts by partition.",
      "Check the consumer isolation level.",
      "Check whether the processor commits offsets and output in one transaction.",
    ],
  },
  {
    id: "sink-write-latency",
    metricId: "sink-p99",
    warn: 60,
    crit: 120,
    title: "The sink write path is adding tail latency",
    cause:
      "Deduplication and transactional commits add round trips. The guarantee is not free, and the slowest writes set the end-to-end latency.",
    fix:
      "Batch writes, move dedupe into the store with a unique constraint, and keep transaction scope small. Measure the p99 of the whole effect, not only the broker produce call.",
    checkFirst: [
      "Split latency into broker commit, sink write, and dedupe lookup.",
      "Check whether the sink retries on timeout without a key.",
      "Check transaction batch size and commit frequency.",
    ],
  },
];

export const exactlyOnceModel: SimModel = {
  id: "streaming-exactly-once",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, { seed });
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const c = compute(p);
    const next = buildFrame(p, frame.t, frame.flags);
    next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (c.endToEndPct >= 0.25 && frame.flags.sinkDuplicate !== 1) {
      pushEvent(next, {
        id: "sink-duplicate-detected",
        at: frame.t,
        severity: "crit",
        title: "Duplicate effect reached the sink",
        detail: `${c.endToEndPct.toFixed(2)}% of records are applying a second effect. Transactions are ${c.transactions ? "on" : "off"} and the sink is ${c.idempotent ? "idempotent" : "append-only"}, so the duplicate window is still open.`,
        nodeId: "sink",
        metricId: "end-to-end-dup",
      });
    }
    next.flags.sinkDuplicate = c.endToEndPct >= 0.25 ? 1 : 0;

    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    if (c.endToEndPct > 0) {
      items.push(
        `The sink applies ${c.endToEndPct.toFixed(2)}% duplicate effects. Broker duplicate rate is ${c.brokerPct.toFixed(2)}%, which shows the two guarantees are different.`,
      );
    } else {
      items.push("No duplicate effects reach the sink at these settings; the retry window is covered by the sink key.");
    }
    if (c.transactions && !c.idempotent) {
      items.push(
        "Transactions commit the output record and the consumed offset together, but the ledger write is outside that transaction. A replay still repeats the effect.",
      );
    }
    if (!c.transactions && c.idempotent) {
      items.push(
        "The sink deduplicates by event ID, so the effect is stable. The output topic still carries duplicate records for readers that are not idempotent.",
      );
    }
    items.push(
      `Retry rate is ${c.retryRate.toFixed(1)}% at ${Math.round(c.input).toLocaleString("en-US")} rec/s; sink p99 is ${c.p99.toFixed(0)} ms.`,
    );
    if (frame.metrics.some((item) => item.id === "end-to-end-dup" && item.value >= 0.25)) {
      items.push("The incident is not a broker problem. Start at the sink's key and transaction boundary.");
    }
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
    description: "Low retries, transactions on, and an idempotent upsert at the sink.",
    tone: "ok",
    params: defaults({ inputRate: 8_000, retryRate: 0.2 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher traffic without transactions; the sink deduplicates the resulting broker duplicates.",
    tone: "warn",
    params: defaults({ inputRate: 18_000, transactions: 0, idempotentSink: 1, retryRate: 0.5 }),
  },
  {
    id: "failure",
    label: "Duplicate effects",
    description: "No transactions and an append-only sink: both broker and sink duplicates accumulate.",
    tone: "crit",
    params: defaults({ inputRate: 18_000, transactions: 0, idempotentSink: 0, retryRate: 4 }),
  },
  {
    id: "transactions-only",
    label: "Transactions only",
    description: "Transactions are enabled, but the external ledger write is still outside the transaction.",
    tone: "crit",
    params: defaults({ inputRate: 18_000, transactions: 1, idempotentSink: 0, retryRate: 4 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Transactions plus an idempotent sink: retries no longer change the final effect.",
    tone: "ok",
    params: defaults({ inputRate: 18_000, transactions: 1, idempotentSink: 1, retryRate: 4 }),
  },
];

const experiment: Experiment = {
  id: "predict-transactions-only",
  title: "Predict what transactions cover",
  simId: "exactly-once",
  question:
    "The pipeline has transactions enabled, the sink still appends every write, and 4% of records are retried. Broker duplicates fall to zero. What happens at the sink?",
  prediction: {
    options: [
      { id: "clean", label: "Sink duplicates fall to zero because the transaction covers the whole path" },
      { id: "partial", label: "Sink duplicates remain because the ledger write is outside the transaction" },
      { id: "worse", label: "Sink duplicates rise because transactions increase retries" },
      { id: "lag", label: "The sink stays correct but lag grows without bound" },
    ],
    correctOptionId: "partial",
    explanation:
      "A Kafka transaction can atomically commit produced records and consumed offsets, and read_committed consumers will not see aborted records. The ledger database is a separate system: its write is not part of that transaction. If the write succeeds and the transaction later aborts or retries, the same event is written again. Transactions remove broker duplicates; only an idempotent sink or a transactional output that includes the sink removes the duplicate effect.",
  },
  setup: defaults({ inputRate: 18_000, transactions: 1, idempotentSink: 0, retryRate: 4 }),
  runFor: 20,
  observe: [
    "Broker duplicate rate drops to zero because the transaction hides retried records.",
    "End-to-end duplicate rate stays above the critical threshold.",
    "The ledger's row count keeps growing faster than the distinct event count.",
    "Enabling the idempotent sink is what clears the end-to-end metric.",
  ],
  explain:
    "The transaction boundary ends at the Kafka commit. The ledger write is a second effect with its own commit, so the guarantee has to be enforced there. That can be a unique key and upsert, a dedupe table written in the same database transaction, or a sink connector that participates in an exactly-once protocol. The choice depends on what the downstream system can do, not on the Kafka producer setting.",
  fix: defaults({ inputRate: 18_000, transactions: 1, idempotentSink: 1, retryRate: 4 }),
  debrief:
    "With both controls on, retries still happen but the final effect is stable. Broker p99 rises by about 23 ms in this illustrative model because the transaction and the dedupe lookup each add a round trip. That is the trade: pay latency and operational complexity, or pay for reconciliation and duplicate handling downstream.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Exactly-once semantics (EOS) is a claim about an effect, not a property of a topic. Kafka can make a set of produced records and a set of consumed offsets commit atomically inside a transaction. A consumer configured with read_committed sees only committed records. That is a strong broker guarantee, and it is also where the guarantee stops when the pipeline writes to a database, an API, or a file system.",
  },
  {
    type: "p",
    text: "The common failure has two writes. The processor writes an output record to Kafka, commits its input offset, and then writes an effect to a sink. If the sink write succeeds and the process dies before the offset commit, the record is replayed. With transactions, the Kafka output and the offset can be one commit, but the sink effect is still a separate commit. Kafka cannot roll it back. The sink must deduplicate the replay.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is input topic, consumer or stream processor, output topic, and sink. The transaction coordinator tracks a transactional ID across producer sessions. The processor calls beginTransaction, writes output, sends the consumed offsets to the transaction, and commits. The broker then makes the records visible to read_committed readers. The sink sits after that boundary and has its own idempotency, transaction, or reconciliation process.",
  },
  {
    type: "table",
    headers: ["Boundary", "What it can guarantee", "What it cannot"],
    rows: [
      ["Producer to broker", "Retries do not create duplicate records within the producer session", "Effects in another system"],
      ["Consumer offsets plus output", "Output records and offsets commit or abort together", "A database write performed beside the transaction"],
      ["Read-process-write with sink", "At-least-once processing unless the sink deduplicates", "Exactly-once effects without a sink key or shared transaction"],
      ["Sink with a unique event key", "The same event applied repeatedly has one row", "Correctness if the key changes between retries"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses illustrative values: 2k to 20k records per second, a 30k rec/s sink, and retry rates up to 5%. They are teaching numbers, not Kafka limits or a benchmark. The shape is what matters: the broker duplicate rate and the end-to-end duplicate rate move separately.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "End-to-end duplicate rate: the share of records whose sink effect was applied more than once.",
      "Broker duplicate rate: the share of output-topic records that are duplicates, before sink deduplication.",
      "Sink write p99: the time to apply one effect, including the dedupe or transaction overhead.",
      "A flow view with the input topic, processor, output topic, and ledger sink. Each node states whether it is inside the transaction boundary.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Duplicate effects. Note both duplicate metrics. Apply Transactions only and watch the broker metric fall while the end-to-end metric stays critical. Then apply Recovery and compare the sink detail.",
  },
  { type: "sim", simId: "exactly-once" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, 18k records per second arrived with a 4% retry rate. The broker duplicate rate reached 4% because transactions were off. The sink was append-only, so the same 4% applied a second effect. The ledger grew faster than the set of distinct events. Turning on transactions removed the broker duplicates completely, but the end-to-end rate stayed at 1.8% because the sink write was still outside the transaction. The transaction covered the Kafka commit, not the ledger commit.",
  },
  {
    type: "p",
    text: "The recovery preset kept the same retry rate and added an idempotent sink. The sink keyed every write by event ID, so a replay overwrote the same row instead of inserting a new one. Both duplicate metrics returned to zero. The cost appeared in p99, which rose because the transaction commit and the dedupe lookup each add a round trip. The pipeline is not free of retries; it is free of duplicate effects.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Sink row count versus distinct event ID count, grouped by minute and by source partition.",
      "Broker metrics: duplicate record count, producer retry rate, and transaction abort rate.",
      "Consumer metrics with isolation.level=read_committed, plus last stable offset and commit latency.",
      "Application logs that pair the event ID, the transaction ID, and the sink write result.",
      "Database unique-constraint violations, which are a useful signal that replay is reaching the sink.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare distinct event IDs with applied effects before changing Kafka settings. Confirm whether the sink write is inside the transaction or a separate commit. Check for a stable idempotency key across retries, then check whether read_committed consumers are used where duplicates matter.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the effect and its key: what must happen once, and which event field identifies it across retries.",
      "Add a unique constraint or an upsert in the sink. Make the write and the dedupe record commit in the same sink transaction.",
      "If the sink supports it, use a transactional output that shares the commit boundary with the offset, and verify the connector or client actually participates.",
      "Enable idempotent producers and transactions for the read-process-write path so the output topic is clean for other consumers.",
      "Set read_committed where aborted records would be visible, and document the consumers that intentionally read uncommitted data.",
      "Replay a known batch and compare the effect count before and after the change.",
      "Add an alert on sink effect count minus distinct event count, not only on consumer lag.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A transactional sink gives the strongest boundary, but it couples the processor to one store and adds commit latency and abort handling.",
      "An idempotent sink is usually cheaper, but it requires a stable key and a place to store dedupe state; a key that changes on replay defeats it.",
      "Reconciliation can repair duplicates after the fact, but it moves correctness into an offline job and leaves a window where users see the wrong effect.",
      "Transactions reduce broker duplicates for downstream readers, but they do not make an external side effect atomic.",
      "Longer transactions amortize commit cost but increase the work lost on abort and the time an effect stays invisible.",
      "Every guarantee has an observability cost: you need distinct-event counts, not only throughput and lag.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "eos-sink-duplicates",
    question:
      "Kafka transactions are enabled and the output topic has no duplicates, but the database still shows duplicate rows. How do you explain that?",
    difficulty: 4,
    hints: [
      "Name the commit boundary that the transaction covers.",
      "The database write is a second effect with its own commit.",
    ],
    answer:
      "The transaction covers the records produced to Kafka and the consumed offsets, so read_committed consumers see one committed output per input. It does not cover a separate database write. If the database write succeeds and the process dies before the transaction commits, the record is reprocessed and the database write happens again. The sink needs an idempotency key with an upsert or unique constraint, or the database write must participate in the same transaction through a connector that supports it. I would confirm by comparing distinct event IDs with applied effects and by replaying a known batch.",
    followUps: [
      "What key would you use for the sink write?",
      "How would you test that the key is stable across restarts?",
      "What changes if the sink is an HTTP API with no transaction support?",
    ],
    redFlags: [
      "Says the transaction covers all downstream systems.",
      "Raises the producer retry count as the fix.",
      "Adds a consumer-side dedupe cache without durability.",
    ],
    rubric: [
      "Separates broker atomicity from the sink effect.",
      "Names a stable key and a durable dedupe mechanism.",
      "Describes a replay test.",
      "States the remaining failure window.",
    ],
  },
  {
    id: "when-transactions-enough",
    question:
      "When is a Kafka transaction enough without changing the sink?",
    difficulty: 3,
    hints: [
      "Consider consumers that only read Kafka.",
      "Consider effects that are naturally idempotent.",
    ],
    answer:
      "A transaction is enough when the final effect is another Kafka topic read with read_committed, or when the sink operation is naturally idempotent for the same input, such as setting a value to an absolute state rather than incrementing it. It is also enough when the consumer can discard duplicates because the event carries a version and the store keeps the highest version. It is not enough for an append-only ledger, an increment, an email send, or a payment capture. The test is whether applying the same event twice changes the observable result.",
    followUps: [
      "Give an example of a naturally idempotent write.",
      "How does a versioned update behave with out-of-order retries?",
      "What if the sink is a search index?",
    ],
    redFlags: [
      "Treats all writes as idempotent.",
      "Ignores the read isolation level.",
      "Assumes retries never reach the sink.",
    ],
    rubric: [
      "Names the read_committed condition.",
      "Distinguishes absolute state from increments.",
      "Gives a concrete safe and unsafe example.",
    ],
  },
  {
    id: "dedupe-key-design",
    question:
      "How do you design an idempotency key for a sink that receives enriched events?",
    difficulty: 4,
    hints: [
      "The key must survive retries and reprocessing.",
      "A generated UUID at write time is not stable.",
    ],
    answer:
      "I would use a deterministic key from the source event, such as the source topic, partition, and offset, or a business key plus a version. The key must be computed before the first sink attempt and must not change when the event is retried or enriched again. The sink stores the key with a unique constraint and applies the write in the same transaction as the key insert. If the same key arrives with different content, that is a conflict to alert on, not silently overwrite. I would also bound how long keys are retained and make the retention longer than the maximum replay window.",
    followUps: [
      "Why is topic-partition-offset stable?",
      "What happens after a topic is recreated?",
      "How long do you retain dedupe keys?",
    ],
    redFlags: [
      "Generates the key inside the sink request.",
      "Uses only a timestamp.",
      "Keeps dedupe state in a process-local cache.",
    ],
    rubric: [
      "Chooses a deterministic source-derived key.",
      "Commits dedupe and effect together.",
      "Bounds retention against the replay window.",
      "Handles conflicting content explicitly.",
    ],
  },
  {
    id: "eos-cost",
    question:
      "What does end-to-end exactly-once cost, and when would you choose at-least-once instead?",
    difficulty: 3,
    hints: [
      "Think about commit latency, abort handling, and sink support.",
      "Some effects tolerate duplicates with reconciliation.",
    ],
    answer:
      "The cost is extra round trips for transaction commit and dedupe, a coordinator and transactional ID to operate, abort and timeout handling, and a sink that can enforce a key or join the transaction. It also narrows the set of stores you can use. I would choose at-least-once when the effect is cheap to reconcile, when duplicates are invisible to users, or when the sink has no idempotency primitive and the volume makes a dedupe table expensive. In that case I would invest in reconciliation, alerting on the duplicate rate, and a replay runbook. For payments or inventory decrements, I would pay for the stronger boundary.",
    followUps: [
      "How would you reconcile a duplicate charge?",
      "Which metric tells you reconciliation is failing?",
      "Does a longer transaction reduce or increase risk?",
    ],
    redFlags: [
      "Claims exactly-once has no cost.",
      "Chooses at-least-once without a reconciliation plan.",
      "Ignores sink capabilities.",
    ],
    rubric: [
      "Names latency and operational costs.",
      "Matches the guarantee to the effect.",
      "Describes a reconciliation fallback.",
      "Mentions a measurable signal.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every sink has a documented idempotency key and a retention window longer than the maximum replay.",
      "Dashboards compare distinct event IDs with applied effects, not only consumer lag.",
      "Transaction timeout, abort rate, and last stable offset are monitored.",
      "A replay test is part of the pipeline's release checklist.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether duplicates exist in the output topic or only in the sink.",
      "Check read isolation and the sink's unique constraint before changing producer settings.",
      "Stop the replay source or bound retries while the sink is fixed.",
      "Record the event IDs and time window for cleanup and reconciliation.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Repair duplicate effects with an idempotent replay or a reconciliation job.",
      "Verify the key is stable across a forced restart.",
      "Update the runbook with the exact transaction boundary and owner.",
      "Re-run peak traffic with the retry injector enabled.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: message delivery semantics",
    url: "https://kafka.apache.org/documentation/#semantics",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "At-most-once, at-least-once, and exactly-once processing with transactions.",
  },
  {
    title: "Confluent documentation: Kafka delivery semantics",
    url: "https://docs.confluent.io/kafka/design/delivery-semantics.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Transactional producers, read_committed consumers, and the scope of the guarantee.",
  },
  {
    title: "Kafka producer config: transactional.id",
    url: "https://kafka.apache.org/documentation/#producerconfigs_transactional.id",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Transactional ID, fencing, and producer session behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "exactly-once": {
      model: exactlyOnceModel,
      presets,
      instructions:
        "Start Healthy, apply Duplicate effects, then compare Transactions only with Recovery. Watch both duplicate rates; they move independently.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Retry, capacity, and latency values are teaching numbers, not Kafka benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-transactions",
    "streaming-idempotent-producer",
    "streaming-outbox",
    "streaming-consumer-groups",
  ],
};
