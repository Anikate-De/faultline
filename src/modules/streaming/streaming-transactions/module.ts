import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INPUT_RATE = 4_000;
const BASE_CAPACITY = 5_000;
const MAX_LAG = 5_000_000;

const params = [
  {
    id: "transactionsEnabled",
    label: "Transactions",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Semantics",
    help: "1 groups the output records and the consumed offsets in one transaction. 0 writes output first and commits the offset separately.",
    format: "count" as const,
  },
  {
    id: "crashIntervalSec",
    label: "Crash interval",
    min: 5,
    max: 60,
    step: 5,
    value: 30,
    unit: " s",
    group: "Failure",
    help: "Simulated time between process crashes. A crash between the output write and the offset commit is the duplicate window.",
    format: "count" as const,
  },
  {
    id: "recordsPerTxn",
    label: "Records per transaction",
    min: 100,
    max: 5_000,
    step: 100,
    value: 500,
    unit: " rec",
    group: "Transaction",
    help: "Batch size for one transaction. Larger batches reduce commit frequency but increase the work aborted by a crash.",
    format: "count" as const,
  },
  {
    id: "commitOverheadMs",
    label: "Commit overhead",
    min: 5,
    max: 500,
    step: 5,
    value: 20,
    unit: " ms",
    group: "Transaction",
    help: "Coordinator and commit cost added to each batch when transactions are on. It reduces effective processing throughput.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flag(frame: SimFrame, id: string, fallback = 0): number {
  const value = frame.flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function effectiveCapacity(p: Params): number {
  const transactions = num(p, "transactionsEnabled", 1) >= 1;
  const records = Math.max(1, num(p, "recordsPerTxn", 500));
  const overhead = Math.max(0, num(p, "commitOverheadMs", 20));
  if (!transactions) return BASE_CAPACITY;
  const batchSeconds = records / BASE_CAPACITY;
  const capacity = records / (batchSeconds + overhead / 1_000);
  return clamp(capacity, 0, BASE_CAPACITY);
}

interface Snapshot {
  lag: number;
  duplicates: number;
  crashes: number;
  crashIn: number;
  processedRate: number;
  capacity: number;
  latency: number;
}

function buildFrame(p: Params, t: number, snapshot: Snapshot, flags: SimFrame["flags"]): SimFrame {
  const transactions = num(p, "transactionsEnabled", 1) >= 1;
  const processorHealth = healthFor(snapshot.duplicates, 100, 1_000);
  const lagHealth = healthFor(snapshot.lag, 20_000, 100_000);
  const latencyHealth = healthFor(snapshot.latency, 50, 200);
  return {
    t,
    nodes: [
      {
        id: "input",
        label: "payments.in",
        kind: "stream",
        health: "ok",
        throughput: INPUT_RATE,
        sublabel: `${INPUT_RATE.toLocaleString("en-US")} rec/s`,
        meta: { view: "flow" },
      },
      {
        id: "processor",
        label: "enrichment consumer",
        kind: "service",
        health: processorHealth === "ok" ? lagHealth : processorHealth,
        utilization: clamp(snapshot.processedRate / Math.max(1, snapshot.capacity)),
        throughput: snapshot.processedRate,
        capacity: snapshot.capacity,
        sublabel: `${Math.round(snapshot.processedRate).toLocaleString("en-US")} rec/s · ${Math.round(snapshot.capacity).toLocaleString("en-US")} capacity`,
        detail: transactions
          ? `Each batch commits output records and consumed offsets together. ${snapshot.duplicates.toLocaleString("en-US")} duplicate outputs observed after ${snapshot.crashes} crash(es).`
          : `Output is written before the offset commit. A crash in between replays the batch, so ${snapshot.duplicates.toLocaleString("en-US")} duplicate outputs have been produced.`,
        meta: {
          lag: snapshot.lag,
          duplicates: snapshot.duplicates,
          crashes: snapshot.crashes,
          capacity: snapshot.capacity,
        },
      },
      {
        id: "coordinator",
        label: "transaction coordinator",
        kind: "service",
        health: latencyHealth,
        utilization: transactions ? clamp(snapshot.latency / 200) : 0,
        throughput: transactions ? snapshot.capacity / Math.max(1, num(p, "recordsPerTxn", 500)) : 0,
        sublabel: transactions ? `${Math.round(snapshot.latency)} ms commit overhead` : "not used",
        detail: transactions
          ? "The coordinator assigns a producer ID, tracks the transaction, and commits or aborts it. Commit overhead is latency the processing loop pays per batch."
          : "Without transactions there is no coordinator boundary. The output write and the offset commit are separate operations.",
        meta: { latency: snapshot.latency },
      },
      {
        id: "output",
        label: "payments.enriched",
        kind: "stream",
        health: processorHealth,
        throughput: snapshot.processedRate,
        sublabel: `${snapshot.duplicates.toLocaleString("en-US")} duplicate outputs`,
        detail: "The output stream is the observable effect. A duplicate here is a duplicate downstream unless the sink deduplicates by a stable key.",
        meta: { duplicates: snapshot.duplicates, lag: snapshot.lag },
      },
    ],
    edges: [
      edge("input-processor", "input", "processor", 1, lagHealth),
      edge("processor-coordinator", "processor", "coordinator", transactions ? 0.5 : 0, latencyHealth),
      edge("processor-output", "processor", "output", clamp(snapshot.processedRate / INPUT_RATE), processorHealth),
    ],
    metrics: [
      metric("duplicate-outputs", "Duplicate outputs", snapshot.duplicates, " rec", 100, 1_000, "count"),
      metric("txn-latency", "Transaction commit latency", snapshot.latency, "ms", 50, 200, "ms"),
      metric("processing-lag", "Processing lag", snapshot.lag, " rec", 20_000, 100_000, "count"),
      metric("output-rate", "Output rate", snapshot.processedRate, " rec/s", undefined, undefined, "rps"),
      metric("input-rate", "Input rate", INPUT_RATE, " rec/s", undefined, undefined, "rps"),
      metric("transaction-rate", "Transactions", transactions ? snapshot.capacity / Math.max(1, num(p, "recordsPerTxn", 500)) : 0, " txn/s", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      seed: Number(flags.seed ?? 0),
      lag: snapshot.lag,
      duplicates: snapshot.duplicates,
      crashes: snapshot.crashes,
      crashIn: snapshot.crashIn,
      capacity: snapshot.capacity,
    },
    summary: snapshot.duplicates > 0
      ? `${snapshot.duplicates.toLocaleString("en-US")} duplicate outputs after ${snapshot.crashes} crash(es); transactions are ${transactions ? "on" : "off"}.`
      : `No duplicate outputs with ${snapshot.crashes} crash(es); throughput ${Math.round(snapshot.processedRate).toLocaleString("en-US")} rec/s.`,
  };
}

function seedSeries(frame: SimFrame, snapshot: Snapshot, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 19)) / 2.8);
  const values: [string, number][] = [
    ["duplicate-outputs", snapshot.duplicates],
    ["txn-latency", snapshot.latency],
    ["processing-lag", snapshot.lag],
    ["output-rate", snapshot.processedRate],
    ["input-rate", INPUT_RATE],
    ["transaction-rate", 0],
  ];
  for (const [id, value] of values) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const transactionsModel: SimModel = {
  id: "streaming-transactions",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const capacity = effectiveCapacity(p);
    const snapshot: Snapshot = {
      lag: 0,
      duplicates: 0,
      crashes: 0,
      crashIn: num(p, "crashIntervalSec", 30),
      processedRate: Math.min(INPUT_RATE, capacity),
      capacity,
      latency: num(p, "transactionsEnabled", 1) >= 1 ? num(p, "commitOverheadMs", 20) : 0,
    };
    const frame = buildFrame(p, 0, snapshot, { seed });
    seedSeries(frame, snapshot, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const transactions = num(p, "transactionsEnabled", 1) >= 1;
    const capacity = effectiveCapacity(p);
    const crashInterval = Math.max(5, num(p, "crashIntervalSec", 30));
    const records = Math.max(1, num(p, "recordsPerTxn", 500));
    let lag = flag(frame, "lag") + INPUT_RATE * seconds;
    let duplicates = flag(frame, "duplicates");
    let crashes = flag(frame, "crashes");
    let crashIn = frame.t <= 0 ? crashInterval : flag(frame, "crashIn", crashInterval);
    const processed = Math.min(capacity * seconds, lag);
    lag = Math.max(0, lag - processed);
    const processedRate = processed / seconds;
    crashIn -= seconds;
    let crashed = false;
    if (crashIn <= 0) {
      crashed = true;
      crashes += 1;
      crashIn = crashInterval;
      if (!transactions) duplicates += Math.min(records, INPUT_RATE * crashInterval);
    }
    const latency = transactions ? Math.max(0, num(p, "commitOverheadMs", 20)) : 0;
    const snapshot: Snapshot = {
      lag: Math.min(MAX_LAG, lag),
      duplicates,
      crashes,
      crashIn,
      processedRate,
      capacity,
      latency,
    };
    const t = frame.t + seconds;
    const next = buildFrame(p, t, snapshot, frame.flags);
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (crashed && !transactions && frame.flags.crashDuplicate !== 1) {
      pushEvent(next, {
        id: "crash-duplicate-output",
        at: t,
        severity: "crit",
        title: "A crash duplicated an output batch",
        detail: `The consumer wrote output, then crashed before committing its offset. On restart it reprocessed the batch, so up to ${Math.round(records).toLocaleString("en-US")} output records were written twice.`,
        nodeId: "processor",
        metricId: "duplicate-outputs",
      });
      next.flags.crashDuplicate = 1;
    }
    if (crashed && transactions && frame.flags.txnAbort !== 1) {
      pushEvent(next, {
        id: "transaction-aborted",
        at: t,
        severity: "info",
        title: "The transaction aborted cleanly",
        detail: "The crash happened before the transaction commit. The output records and the consumed offsets were both aborted, so the batch is reprocessed without a duplicate effect.",
        nodeId: "coordinator",
        metricId: "duplicate-outputs",
      });
      next.flags.txnAbort = 1;
    }
    if (lag > 20_000 && frame.flags.lagSeen !== 1) {
      pushEvent(next, {
        id: "txn-overhead-lag",
        at: t,
        severity: "warn",
        title: "Transaction overhead is now the throughput bottleneck",
        detail: `Input is ${INPUT_RATE.toLocaleString("en-US")} rec/s and effective capacity is ${Math.round(capacity).toLocaleString("en-US")} rec/s. Commit overhead per batch is reducing the consumer below the arrival rate.`,
        nodeId: "coordinator",
        metricId: "processing-lag",
      });
      next.flags.lagSeen = 1;
    }
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds: [
    {
      id: "duplicate-outputs",
      metricId: "duplicate-outputs",
      warn: 100,
      crit: 1_000,
      title: "A crash duplicated output records",
      cause:
        "The consumer wrote to the output system and crashed before committing its input offset. On restart, the batch was processed again. The output write and the offset commit were not atomic, so the duplicate window was open for the whole batch.",
      fix:
        "Group the output records and the consumed offsets in one Kafka transaction with sendOffsetsToTransaction, or make the sink idempotent on a stable event key. A transaction removes the window for Kafka outputs; it cannot make an external sink atomic.",
      checkFirst: [
        "Compare the crash time with the offset commit time for the affected batch.",
        "Check whether the sink is idempotent on a stable key.",
        "Check whether the consumer is configured with a transactional producer and read_committed isolation.",
      ],
    },
    {
      id: "txn-latency",
      metricId: "txn-latency",
      warn: 50,
      crit: 200,
      title: "Transaction commit latency is above the batch budget",
      cause:
        "Every transaction adds coordinator work: begin, produce, send offsets, and commit. With small batches or a slow coordinator, that fixed cost becomes a large share of the batch's processing time and lowers throughput.",
      fix:
        "Increase the batch size within the latency budget, reduce commit frequency, or move non-transactional work out of the transaction. Measure throughput and commit latency together; a transaction that is correct but too slow is still an incident.",
      checkFirst: [
        "Compare commit latency with the time spent processing the batch.",
        "Check the coordinator's load and the transaction timeout.",
        "Check whether small batches are forcing too many commits.",
      ],
    },
    {
      id: "processing-lag",
      metricId: "processing-lag",
      warn: 20_000,
      crit: 100_000,
      title: "Transaction overhead has pushed throughput below input",
      cause:
        "The transactional producer is committing slower than records arrive. The input topic grows while the consumer spends an increasing share of each second on transaction coordination rather than processing.",
      fix:
        "Raise effective throughput by increasing the batch size, reducing commit overhead, or adding partitions and consumers. If the sink is external, consider whether a transaction is the right boundary for that effect.",
      checkFirst: [
        "Compare effective capacity with input rate.",
        "Check whether commit latency rose after a deploy or coordinator change.",
        "Check whether the batch size is too small for the transaction cost.",
      ],
    },
  ],
  insights: (frame, p) => {
    const duplicates = flag(frame, "duplicates");
    const lag = flag(frame, "lag");
    const capacity = flag(frame, "capacity");
    const transactions = num(p, "transactionsEnabled", 1) >= 1;
    const latency = num(p, "commitOverheadMs", 20);
    const items: string[] = [];
    items.push(
      `Effective capacity is ${Math.round(capacity).toLocaleString("en-US")} rec/s against ${INPUT_RATE.toLocaleString("en-US")} rec/s of input, with transactions ${transactions ? "on" : "off"}.`,
    );
    if (duplicates > 0) {
      items.push(`${duplicates.toLocaleString("en-US")} duplicate outputs have been produced. Each crash before the offset commit replayed the batch.`);
    } else {
      items.push("No duplicate outputs have been observed. That is the broker-side guarantee; the sink still has to handle retries and replays correctly.");
    }
    if (transactions && latency > 0) {
      items.push(`Each transaction adds about ${Math.round(latency)}ms of commit overhead. Small batches pay that cost more often.`);
    }
    if (lag > 0) {
      items.push(`${Math.round(lag).toLocaleString("en-US")} records are waiting. The transaction boundary reduced throughput below the arrival rate.`);
    }
    items.push("Transactions make Kafka writes and offsets atomic. They do not make an external database or HTTP sink atomic; that requires an idempotent effect or a different boundary.");
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
    description: "Small transactions keep the consumer above input with no duplicate output.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A larger batch and higher commit overhead push throughput below input.",
    tone: "warn",
    params: defaults({ recordsPerTxn: 1_000, commitOverheadMs: 100 }),
  },
  {
    id: "failure",
    label: "Crash without transactions",
    description: "Output is written before the offset commit, so a crash replays the batch.",
    tone: "crit",
    params: defaults({ transactionsEnabled: 0, crashIntervalSec: 15, recordsPerTxn: 1_000 }),
  },
  {
    id: "recovery",
    label: "Same crash, transaction on",
    description: "The output and offsets commit together, so the crash aborts cleanly.",
    tone: "ok",
    params: defaults({ transactionsEnabled: 1, crashIntervalSec: 15, recordsPerTxn: 1_000, commitOverheadMs: 20 }),
  },
  {
    id: "overhead",
    label: "Too much overhead",
    description: "Transactions are correct but the commit cost pushes capacity below input.",
    tone: "crit",
    params: defaults({ transactionsEnabled: 1, crashIntervalSec: 15, recordsPerTxn: 1_000, commitOverheadMs: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-transaction-window",
  title: "Predict what a transaction changes",
  simId: "transactions",
  question:
    "A consumer writes an output record, then commits its input offset. A crash between those two operations duplicates 1,000 output records. What changes when the output writes and the consumed offsets are in one Kafka transaction?",
  prediction: {
    options: [
      { id: "atomic", label: "Both the output and the offset commit or neither does, so the crash no longer duplicates" },
      { id: "faster", label: "Throughput doubles because the broker batches the writes" },
      { id: "sink", label: "The external sink becomes transactional automatically" },
      { id: "offset", label: "The consumer no longer needs to commit offsets" },
    ],
    correctOptionId: "atomic",
    explanation:
      "A Kafka transaction groups the produced output records and the consumed offsets into one atomic commit. If the process crashes before the commit, the transaction aborts: the output records are not visible to read_committed consumers and the offsets are not advanced. On restart the batch is processed again, but the aborted output is not counted twice. This is atomicity between Kafka writes and Kafka offsets, not a transaction over an external database.",
  },
  setup: defaults({ transactionsEnabled: 0, crashIntervalSec: 15, recordsPerTxn: 1_000 }),
  runFor: 30,
  observe: [
    "The first crash after 15 seconds adds about 1,000 duplicate output records.",
    "The consumer reprocesses the batch because its offset did not advance.",
    "The output stream shows the duplicate effect while the input is processed once.",
    "Turning transactions on removes the duplicate count but adds commit latency.",
  ],
  explain:
    "The duplicate window is the gap between the output write and the offset commit. A transaction closes that gap for Kafka outputs by making both part of one commit. It does not close the gap for an external sink: if the HTTP call or database write happens outside Kafka, the sink must be idempotent or the transaction cannot cover it. Transactions also cost coordinator round trips and require consumers to read committed data, so they are not free.",
  fix: defaults({ transactionsEnabled: 1, crashIntervalSec: 15, recordsPerTxn: 1_000, commitOverheadMs: 20 }),
  debrief:
    "With transactions on, the crash at 15 seconds aborts the in-flight batch. The output records are not visible and the offset is not committed, so the reprocessed batch produces one effect. Duplicate outputs stay at zero. The cost is about 20ms of commit overhead per batch, which still leaves capacity above input. If the batch were much smaller or the coordinator slower, that fixed cost would become the bottleneck.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kafka transaction groups a set of produced records and a set of consumed offsets into one atomic commit. Either all of the writes become visible and the offsets advance, or none of them do. That closes a specific crash window in a stream processor: the output was written, the process died before committing its input offset, and on restart the same input was processed again.",
  },
  {
    type: "p",
    text: "The guarantee is broker-side. It covers records produced to Kafka and offsets stored in Kafka, not an arbitrary HTTP call or a database write. If the consumer writes to an external sink outside the transaction, a crash can still duplicate that effect. End-to-end exactly-once needs an idempotent sink or a transactional output that participates in the same boundary. Transactions also add coordinator work, commit latency, and a requirement that downstream readers use read_committed isolation.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is input topic, consumer poll loop, transactional producer, output topic, and transaction coordinator. The consumer begins a transaction, processes a batch, produces output records, sends the consumed offsets to the transaction, and commits. The coordinator assigns the producer ID and decides the transaction's fate. A crash before the commit causes an abort. A crash after the commit means both the output and the offset are already durable, so the batch is not repeated.",
  },
  {
    type: "table",
    headers: ["Boundary", "What is atomic", "What is still exposed"],
    rows: [
      ["Output write then offset commit", "Nothing across the crash", "The batch can be reprocessed and duplicated"],
      ["Kafka transaction", "Kafka output records and consumed offsets", "External sinks, side effects, and non-transactional readers"],
      ["Idempotent producer", "Retries within one producer session", "A new session or a new process can still duplicate"],
      ["Idempotent sink", "The sink's effect on a stable key", "The sink must define the key and retain deduplication state"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 4,000 input records per second, a 5,000 records per second base capacity, and 5 to 500 milliseconds of commit overhead. They are teaching values, not Kafka limits. The shape of the failure is the lesson: a crash between two non-atomic writes duplicates a batch, while the transaction makes the pair commit or abort together.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Duplicate outputs: records written twice after a crash. Warning at 100, critical at 1,000.",
      "Transaction commit latency: coordinator overhead per batch. Warning at 50ms, critical at 200ms.",
      "Processing lag: input waiting because transaction overhead reduced throughput.",
      "Output rate and transaction rate, so the cost of the boundary is visible.",
      "A flow view with the input topic, the processor, the coordinator, and the output topic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Crash without transactions. Watch the duplicate count jump at the first crash. Run the experiment before changing sliders, then compare Same crash, transaction on and Too much overhead. Read the lag and latency together.",
  },
  { type: "sim", simId: "transactions" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The consumer wrote a batch of 1,000 output records, then crashed before committing its input offset. On restart it read the same input again and wrote the output again. The duplicate count rose by 1,000 at the crash and the output stream held two copies of the batch. The input offset was the only record of what had been processed, and it had not advanced.",
  },
  {
    type: "p",
    text: "With transactions on, the output writes and the offsets were sent in one transaction. The crash aborted the transaction, so the output records were not visible and the offset did not move. The reprocessed batch produced one effect. The cost was commit overhead: about 20ms per batch, which still left capacity above the 4,000 records per second input.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Duplicate keys or duplicate business effects at the sink around a restart time.",
      "Consumer offset commits that lag behind output writes, or a restart that replays a batch.",
      "Transaction metrics: commit rate, commit latency, aborted transactions, and transaction timeouts.",
      "Consumer isolation level and whether downstream readers see uncommitted records.",
      "Coordinator errors, producer ID resets, and transactions stuck open past their timeout.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the output write and the offset commit are in the same transaction. If they are, check the commit latency and the consumer's isolation level. If they are not, check the sink for an idempotency key before adding transactions, because a transaction cannot cover an external effect.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the crash window: compare the output write time with the offset commit time for the duplicated batch.",
      "Decide the boundary. Kafka-to-Kafka output can use a transactional producer and sendOffsetsToTransaction.",
      "Give every producer a stable transactional ID so it can fence stale instances after a restart.",
      "Set consumers that read the output to read_committed isolation if they must not see aborted records.",
      "For an external sink, add an idempotency key or a deduplication table instead of assuming the transaction covers it.",
      "Measure commit latency and throughput together. Increase batch size if the fixed cost is too high.",
      "Re-run the crash scenario and verify duplicate outputs, lag, and commit latency together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Transactions remove the crash window for Kafka outputs but add coordinator round trips and commit latency.",
      "Larger batches amortize the commit cost but increase the work lost on an abort and the time a transaction stays open.",
      "read_committed readers see only committed records, which adds visibility latency and requires consumer support.",
      "An idempotent sink can cover external effects, but it needs a stable key and retained deduplication state.",
      "A transactional ID fences stale producers, so a restart is safe; reusing the same ID across unrelated instances causes conflicts.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "transaction-window",
    question:
      "A consumer writes output and commits its offset separately. A crash duplicates the batch. How does a Kafka transaction fix it, and what does it not fix?",
    difficulty: 4,
    hints: [
      "The crash window is between two writes.",
      "The transaction covers Kafka records and Kafka offsets, not an arbitrary sink.",
    ],
    answer:
      "A Kafka transaction puts the produced output records and the consumed offsets in one atomic commit. If the process crashes before the commit, the transaction aborts: the output records are not visible to read_committed consumers and the offset does not advance. On restart the input is processed again, but the aborted output is not counted twice. It does not fix an external sink that was written outside the transaction, because that effect is not part of the Kafka commit. For an external sink I need an idempotent write keyed by a stable event ID or a different transactional boundary.",
    followUps: [
      "What isolation level must the downstream consumer use?",
      "What does the transactional ID do after a restart?",
      "When is an idempotent sink a better choice than a transaction?",
    ],
    redFlags: [
      "Claims the transaction covers an external database.",
      "Ignores the consumer isolation level.",
      "Confuses transactions with the idempotent producer.",
    ],
    rubric: [
      "Names the output write and offset commit as one atomic unit.",
      "Explains abort and reprocessing.",
      "States the external-sink limit.",
      "Mentions read_committed or idempotency.",
    ],
  },
  {
    id: "transaction-cost",
    question:
      "Transactions are correct but throughput fell below input. What do you check, and how do you recover?",
    difficulty: 4,
    hints: [
      "Commit overhead is paid per batch.",
      "A correct transaction that cannot keep up is still an incident.",
    ],
    answer:
      "I would compare effective capacity with input and look at commit latency, batch size, and transaction rate. A fixed commit cost per batch hurts most when batches are small. I would increase the batch size within the latency budget, reduce commit frequency, or add partitions and consumers if the input can be parallelized. I would also check the coordinator for load, timeouts, and aborted transactions. If the sink is external and the transaction is adding cost without covering the effect, I would reconsider the boundary and use an idempotent sink instead.",
    followUps: [
      "How does batch size affect the abort cost?",
      "What is the risk of a long transaction timeout?",
      "How would you measure the break-even batch size?",
    ],
    redFlags: [
      "Raises throughput by removing the transaction without replacing the guarantee.",
      "Ignores batch size.",
      "Adds consumers without checking partition count.",
    ],
    rubric: [
      "Connects commit overhead to batch size.",
      "Measures capacity against input.",
      "Names a safe throughput fix.",
      "Considers the external-sink boundary.",
    ],
  },
  {
    id: "transaction-fencing",
    question:
      "What is a transactional ID for, and what happens if two instances use the same one?",
    difficulty: 3,
    hints: [
      "The broker needs to identify a producer across restarts.",
      "Only one instance should be able to commit for a given ID.",
    ],
    answer:
      "A transactional ID identifies a producer across process restarts so the coordinator can recover or abort its in-flight transactions and fence an older instance. If two live instances use the same transactional ID, the newer one fences the older one: the older instance's transactional writes fail, which is the intended safety behavior. The operational rule is one stable transactional ID per stream task or partition, not one shared ID for an entire fleet unless the tasks are genuinely interchangeable.",
    followUps: [
      "How does fencing interact with a rolling deploy?",
      "What happens to an open transaction when the producer dies?",
      "How would you assign transactional IDs to partitions?",
    ],
    redFlags: [
      "Shares one transactional ID across all instances.",
      "Thinks the ID is only a label.",
      "Ignores stale producers after a restart.",
    ],
    rubric: [
      "Explains recovery and fencing.",
      "States one ID per task or partition.",
      "Connects it to rolling deploys.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The output write and the offset commit are in one transaction, or the sink is idempotent on a stable key.",
      "Every transactional producer has a unique, stable transactional ID.",
      "Downstream consumers that must exclude aborted records use read_committed isolation.",
      "Commit latency, transaction rate, and aborted transactions are monitored.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the crash time with the offset commit for the duplicated batch.",
      "Check whether the output is a Kafka topic or an external sink.",
      "Check commit latency and effective capacity before changing the transaction boundary.",
      "Do not remove the transaction without replacing the duplicate protection.",
      "Record the affected keys, offsets, and crash timestamps.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify duplicate outputs and processing lag at peak.",
      "Reconcile the downstream state for the duplicated keys.",
      "Re-run the crash scenario with the transaction on.",
      "Review batch size and commit overhead against the throughput target.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: using transactions",
    url: "https://kafka.apache.org/documentation/#usingtransactions",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Transactional producer design, offset commits, and atomic write semantics.",
  },
  {
    title: "Apache Kafka documentation: producer configs",
    url: "https://kafka.apache.org/documentation/#producerconfigs",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Transactional ID, idempotence, and producer retry settings.",
  },
  {
    title: "Confluent documentation: message delivery guarantees",
    url: "https://docs.confluent.io/kafka/design/delivery-semantics.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "At-least-once, at-most-once, and exactly-once delivery semantics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    transactions: {
      model: transactionsModel,
      presets,
      instructions:
        "Start Healthy, then apply Crash without transactions and watch duplicate outputs jump at the crash. Run the experiment, then compare Same crash, transaction on and Too much overhead.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Input rates, batch sizes, and commit overhead are teaching values, not Kafka limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-idempotent-producer",
    "streaming-exactly-once",
    "streaming-consumer-groups",
    "streaming-retention",
    "streaming-ksqldb",
  ],
};
