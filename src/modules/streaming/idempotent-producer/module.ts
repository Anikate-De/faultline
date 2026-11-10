import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const PRODUCE_RATE = 20_000;
const ERROR_START = 4;
const JITTER = 0.005;

const params = [
  {
    id: "idempotence",
    label: "Idempotent producer",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Producer",
    help: "0 disables idempotence. 1 assigns a producer ID and per-partition sequence numbers so the broker can drop retried batches.",
    format: "count" as const,
  },
  {
    id: "errorRate",
    label: "Ambiguous failures",
    min: 0,
    max: 30,
    step: 1,
    value: 0,
    unit: "%",
    group: "Failure",
    help: "Share of batches where the broker appended the records but the acknowledgement was lost. The producer cannot tell whether the write succeeded.",
    format: "percent" as const,
  },
  {
    id: "batchSize",
    label: "Batch size",
    min: 100,
    max: 2_000,
    step: 100,
    value: 500,
    unit: " rec",
    group: "Producer",
    help: "Records per batch. At a fixed produce rate this changes how many requests are retried, not the total duplicate record volume.",
    format: "count" as const,
  },
  {
    id: "maxInFlight",
    label: "Max in flight",
    min: 1,
    max: 8,
    step: 1,
    value: 5,
    unit: "",
    group: "Producer",
    help: "Unacknowledged batches allowed per connection. Idempotence preserves ordering up to five; above five, retries can be reordered.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flagNumber(flags: SimFrame["flags"], id: string, fallback = 0): number {
  const value = flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Totals {
  produced: number;
  duplicates: number;
  retries: number;
}

interface Values {
  idempotent: boolean;
  errorRate: number;
  errorShare: number;
  batchSize: number;
  maxInFlight: number;
  produceRate: number;
  retryRecords: number;
  retryRequests: number;
  duplicateRate: number;
  duplicateShare: number;
  reorderExposure: number;
  requestRate: number;
  appendRate: number;
  requestAmplification: number;
  appendAmplification: number;
  consumerRate: number;
}

function compute(p: Params, t: number, jitter: number): Values {
  const idempotent = num(p, "idempotence", 1) >= 0.5;
  const errorRate = Math.max(0, num(p, "errorRate", 0));
  const errorShare = t >= ERROR_START ? errorRate / 100 : 0;
  const batchSize = Math.max(1, Math.round(num(p, "batchSize", 500)));
  const maxInFlight = Math.max(1, Math.round(num(p, "maxInFlight", 5)));
  const produceRate = PRODUCE_RATE * jitter;
  const retryRecords = produceRate * errorShare;
  const duplicateRate = idempotent ? 0 : retryRecords;
  const consumerRate = produceRate + duplicateRate;
  const duplicateShare = (duplicateRate / consumerRate) * 100;
  let reorderExposure = 0;
  if (errorShare > 0) {
    if (maxInFlight > 5) reorderExposure = retryRecords;
    else if (!idempotent && maxInFlight > 1) reorderExposure = retryRecords * ((maxInFlight - 1) / maxInFlight);
  }
  return {
    idempotent,
    errorRate,
    errorShare,
    batchSize,
    maxInFlight,
    produceRate,
    retryRecords,
    retryRequests: retryRecords / batchSize,
    duplicateRate,
    duplicateShare,
    reorderExposure,
    requestRate: produceRate + retryRecords,
    appendRate: produceRate + (idempotent ? 0 : retryRecords),
    requestAmplification: 1 + errorShare,
    appendAmplification: idempotent ? 1 : 1 + errorShare,
    consumerRate,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worstHealth(a: "ok" | "warn" | "crit", b: "ok" | "warn" | "crit"): "ok" | "warn" | "crit" {
  const rank = { ok: 0, warn: 1, crit: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function buildFrame(p: Params, t: number, jitter: number, totals: Totals, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, t, jitter);
  const duplicateHealth = healthFor(values.duplicateShare, 0.5, 2);
  const reorderHealth = healthFor(values.reorderExposure, 200, 1_000);
  const producerHealth = worstHealth(duplicateHealth, reorderHealth);
  const brokerHealth = healthFor(values.requestAmplification, 1.3, 1.5);
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders producer",
        kind: "service",
        health: producerHealth,
        utilization: 0.6,
        throughput: values.produceRate,
        sublabel: values.idempotent
          ? `idempotence on · ${values.batchSize} rec/batch`
          : `idempotence off · ${values.batchSize} rec/batch`,
        detail: values.idempotent
          ? "Each partition has a producer ID and a monotonically increasing sequence number. A retried batch carries the same sequence, so the broker can recognize it as a repeat."
          : "A retried batch has no identity the broker can use to recognize a repeat. The retry is appended again even when the first attempt succeeded.",
        meta: {
          idempotent: values.idempotent ? 1 : 0,
          errorShare: values.errorShare,
          inFlight: values.maxInFlight,
        },
      },
      {
        id: "topic",
        label: "orders.events",
        kind: "stream",
        health: brokerHealth,
        throughput: values.appendRate,
        sublabel: `${Math.round(values.appendRate).toLocaleString("en-US")} appends/s · ${Math.round(values.requestRate).toLocaleString("en-US")} requests/s`,
        detail: `The broker receives ${Math.round(values.requestRate).toLocaleString("en-US")} requests/s including retries and appends ${Math.round(values.appendRate).toLocaleString("en-US")} rec/s. ${values.idempotent ? "A retry whose sequence is already present is acknowledged without an append." : "Every retry is a new append, so duplicates land in the log."}`,
        meta: {
          requestRate: values.requestRate,
          appendRate: values.appendRate,
          requestAmplification: values.requestAmplification,
          appendAmplification: values.appendAmplification,
        },
      },
      {
        id: "consumer",
        label: "downstream writer",
        kind: "worker",
        health: duplicateHealth,
        utilization: 0.55,
        throughput: values.consumerRate,
        sublabel: `${Math.round(values.consumerRate).toLocaleString("en-US")} rec/s delivered`,
        detail:
          values.duplicateShare > 0
            ? `The consumer sees about ${values.duplicateShare.toFixed(1)}% duplicate records. If its write is not idempotent, those become duplicate side effects downstream.`
            : "The consumer receives one copy of each event; retries are suppressed before they reach it.",
        meta: { duplicateShare: values.duplicateShare, duplicateRate: values.duplicateRate },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", clamp(values.requestRate / (PRODUCE_RATE * 1.5)), producerHealth),
      edge("topic-consumer", "topic", "consumer", clamp(values.consumerRate / (PRODUCE_RATE * 1.5)), duplicateHealth),
    ],
    metrics: [
      metric("duplicate-share", "Duplicate share", values.duplicateShare, "%", 0.5, 2, "percent"),
      metric("duplicate-rate", "Duplicate records", values.duplicateRate, " rec/s", 100, 400, "rps"),
      metric("reorder-exposure", "Retry reorder exposure", values.reorderExposure, " rec/s", 200, 1_000, "rps"),
      metric("request-amplification", "Request amplification", values.requestAmplification, "x", 1.3, 1.5, "number"),
      metric("append-amplification", "Append amplification", values.appendAmplification, "x", undefined, undefined, "number"),
      metric("broker-request-rate", "Broker request rate", values.requestRate, " rec/s", undefined, undefined, "rps"),
      metric("log-append-rate", "Log append rate", values.appendRate, " rec/s", undefined, undefined, "rps"),
      metric("retry-requests", "Retry requests", values.retryRequests, " req/s", undefined, undefined, "rps"),
      metric("duplicate-total", "Duplicate records so far", totals.duplicates, " rec", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      produced: totals.produced,
      duplicates: totals.duplicates,
      retries: totals.retries,
      idempotent: values.idempotent ? 1 : 0,
      errorShare: values.errorShare,
    },
    summary:
      values.duplicateShare > 0
        ? `${values.duplicateShare.toFixed(1)}% of delivered records are duplicates; the broker cannot tell a retry from a new batch.`
        : values.reorderExposure > 0
          ? `Records are unique, but ${Math.round(values.reorderExposure).toLocaleString("en-US")} rec/s are exposed to reordering above five in flight.`
          : values.requestAmplification > 1.001
            ? `Records are unique. The broker sees ${values.requestAmplification.toFixed(2)}x request load while the log appends at ${values.appendAmplification.toFixed(2)}x.`
            : `No duplicates and no reorder exposure at ${Math.round(values.produceRate).toLocaleString("en-US")} rec/s.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.6);
  const series: [string, number][] = [
    ["duplicate-share", values.duplicateShare],
    ["duplicate-rate", values.duplicateRate],
    ["reorder-exposure", values.reorderExposure],
    ["request-amplification", values.requestAmplification],
    ["append-amplification", values.appendAmplification],
    ["broker-request-rate", values.requestRate],
    ["log-append-rate", values.appendRate],
    ["retry-requests", values.retryRequests],
    ["duplicate-total", 0],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

export const idempotentProducerModel: SimModel = {
  id: "streaming-idempotent-producer",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const totals: Totals = { produced: 0, duplicates: 0, retries: 0 };
    const frame = buildFrame(defaults(), 0, 1, totals, {});
    seedSeries(frame, compute(defaults(), 0, 1), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const jitter = 1 + rng.between(-JITTER, JITTER);
    const t = frame.t + Math.max(0, dt);
    const values = compute(p, t, jitter);
    const totals: Totals = {
      produced: flagNumber(frame.flags, "produced") + values.produceRate * dt,
      duplicates: flagNumber(frame.flags, "duplicates") + values.duplicateRate * dt,
      retries: flagNumber(frame.flags, "retries") + values.retryRecords * dt,
    };
    const result = buildFrame(p, t, jitter, totals, frame.flags);
    result.series = frame.series;
    result.events = frame.events;

    if (values.duplicateShare >= 0.5 && frame.flags.duplicateEvent !== 1) {
      pushEvent(result, {
        id: "duplicate-retries-detected",
        at: t,
        severity: "crit",
        title: "Retries are creating duplicate records",
        detail: `${values.duplicateShare.toFixed(1)}% of delivered records are duplicates. The producer retried batches whose acknowledgement was lost, and the broker appended them again.`,
        nodeId: "producer",
        metricId: "duplicate-share",
      });
      result.flags.duplicateEvent = 1;
    }
    if (values.reorderExposure >= 200 && frame.flags.reorderEvent !== 1) {
      pushEvent(result, {
        id: "reorder-exposure-detected",
        at: t,
        severity: "warn",
        title: "Retries can overtake later batches",
        detail: `${Math.round(values.maxInFlight)} batches are allowed in flight. ${values.maxInFlight > 5 ? "Idempotence preserves ordering only up to five in flight." : "Without idempotence, a retried batch can be appended after a later batch."}`,
        nodeId: "producer",
        metricId: "reorder-exposure",
      });
      result.flags.reorderEvent = 1;
    }

    for (const item of result.metrics) recordSeries(result, item.id, item.value);
    return result;
  },
  thresholds: [
    {
      id: "duplicate-share",
      metricId: "duplicate-share",
      warn: 0.5,
      crit: 2,
      title: "A visible share of events is duplicated",
      cause:
        "A batch was appended but its acknowledgement was lost. The producer retried because it could not know the write succeeded. Without a producer ID and sequence number, the broker has no way to recognize the retry and appends it again.",
      fix:
        "Enable idempotence on the producer and keep retries enabled. Then make downstream writes idempotent as well, because idempotence covers retries within a producer session, not duplicate events sent by the application.",
      checkFirst: [
        "Compare broker log end offset growth with the producer's acknowledged record count.",
        "Check whether produce retries and request timeouts rose at the same time.",
        "Check whether the consumer is seeing exact duplicate keys or only similar events.",
      ],
    },
    {
      id: "duplicate-rate",
      metricId: "duplicate-rate",
      warn: 100,
      crit: 400,
      title: "Duplicate volume is large enough to corrupt downstream state",
      cause:
        "Every ambiguous failure is retried with the full batch. Duplicate volume scales with the produce rate and the failure share; batch size changes how many requests carry the duplicates, not how many records are duplicated.",
      fix:
        "Enable idempotence, reduce the batch size if retries are expensive, and add an idempotency key at the consumer's write boundary. Do not rely on deduplicating only at the dashboard.",
      checkFirst: [
        "Measure duplicates per key and per partition, not only as a global count.",
        "Check whether downstream writes are keyed by an event ID.",
        "Check whether the producer retries because of broker timeouts rather than real errors.",
      ],
    },
    {
      id: "reorder-exposure",
      metricId: "reorder-exposure",
      warn: 200,
      crit: 1_000,
      title: "Retry ordering is no longer guaranteed",
      cause:
        "With more than one request in flight, a failed batch can be retried after a later batch has already been appended. Idempotence prevents duplicate appends but preserves ordering only up to five in-flight requests per connection.",
      fix:
        "Keep max.in.flight.requests.per.connection at or below five when ordering matters, or reduce it to one for the strictest guarantee. Enable idempotence and keep retries above zero.",
      checkFirst: [
        "Check the producer's max.in.flight.requests.per.connection and enable.idempotence.",
        "Compare the order of records by key in the log with the order the application sent them.",
        "Check whether a downstream consumer depends on per-key order.",
      ],
    },
    {
      id: "request-amplification",
      metricId: "request-amplification",
      warn: 1.3,
      crit: 1.5,
      title: "Retry traffic is amplifying broker work",
      cause:
        "Idempotence can stop a retry from being appended, but the broker still receives the request and checks the producer state. Request amplification measures that work; append amplification measures how much actually reaches the log.",
      fix:
        "Enable idempotence to keep append amplification at 1.0, reduce ambiguous failures, and check producer timeouts. If broker request load is the constraint, reduce retries or batch size, not just duplicate output.",
      checkFirst: [
        "Compare broker request rate with log append rate.",
        "Check request latency and broker CPU during retry bursts.",
        "Check whether timeouts, not real broker errors, are causing the retries.",
      ],
    },
  ],
  insights: (frame, p) => {
    const values = compute(p, frame.t, 1);
    const items: string[] = [];
    items.push(
      values.idempotent
        ? "The producer has a PID and a per-partition sequence. A retry with the same sequence is dropped by the broker, so it does not become a second record."
        : "Without idempotence, a retry is just another append. The broker cannot distinguish it from a new batch.",
    );
    items.push(
      `At ${Math.round(PRODUCE_RATE).toLocaleString("en-US")} rec/s and ${values.errorRate.toFixed(0)}% ambiguous failures, the broker receives ${Math.round(values.requestRate).toLocaleString("en-US")} requests/s while the log appends ${Math.round(values.appendRate).toLocaleString("en-US")} rec/s. Retries cost broker work even when they are deduplicated.`,
    );
    if (values.retryRequests > 0) {
      items.push(
        `${Math.round(values.retryRequests).toLocaleString("en-US")} retry requests/s at ${values.batchSize} records per batch; a larger batch means fewer retry requests for the same retried record volume.`,
      );
    }
    if (values.duplicateShare > 0) {
      items.push(
        `About ${values.duplicateShare.toFixed(1)}% of delivered records are duplicates, or ${Math.round(values.duplicateRate).toLocaleString("en-US")} rec/s. The consumer's write path now decides whether that becomes duplicate state.`,
      );
    }
    if (values.maxInFlight > 5) {
      items.push("More than five in-flight requests breaks the ordering guarantee even with idempotence; duplicates stay suppressed, but order does not.");
    } else if (!values.idempotent && values.maxInFlight > 1 && values.errorShare > 0) {
      items.push("Without idempotence, multiple in-flight requests let a retried batch land after a later batch.");
    }
    items.push(`The producer session is the boundary: a new producer ID starts a new sequence space, so cross-session duplicates need application keys or transactions.`);
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Idempotence on, no ambiguous failures, and five requests in flight.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Retries under load",
    description: "Idempotence suppresses duplicates, but six in-flight requests expose ordering risk.",
    tone: "warn",
    params: defaults({ errorRate: 4, batchSize: 1_000, maxInFlight: 6 }),
    elapsed: 4.2,
  },
  {
    id: "failure",
    label: "Duplicates",
    description: "Idempotence off with 10% ambiguous failures; retries duplicate every failed batch.",
    tone: "crit",
    params: defaults({ idempotence: 0, errorRate: 10 }),
    elapsed: 4.2,
  },
  {
    id: "recovery",
    label: "Idempotence on",
    description: "The same failures, but the broker now recognizes and drops retried batches.",
    tone: "ok",
    params: defaults({ idempotence: 1, errorRate: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-idempotence",
  title: "Predict what enabling idempotence changes",
  simId: "idempotent-producer",
  question:
    "A producer sees 10% ambiguous failures. With idempotence off, the consumer sees duplicates. If you enable idempotence and leave retries on, what happens?",
  prediction: {
    options: [
      { id: "no-retries", label: "Retries stop, so the write rate drops to the produce rate" },
      { id: "deduped", label: "Retries still happen, but the broker drops the repeat appends" },
      { id: "consumer", label: "Duplicates move to the consumer, which must deduplicate them" },
      { id: "exactly-once", label: "The whole pipeline becomes exactly-once with no other changes" },
    ],
    correctOptionId: "deduped",
    explanation:
      "Idempotence does not remove retries; it makes them safe. Each batch carries the producer ID and a per-partition sequence number. If the broker already appended that sequence, it acknowledges the retry without writing the records again. The producer still retries, and the broker still does the work of checking, but the consumer sees one copy.",
  },
  setup: defaults({ idempotence: 0, errorRate: 10 }),
  runFor: 30,
  observe: [
    "Duplicate share holds near 9.1% while the failure rate is active.",
    "Duplicate records accumulate at about 2,000 per second.",
    "Log appends and broker requests both exceed the produce rate because every failed batch is retried.",
    "The consumer's delivered rate includes the duplicate copies.",
  ],
  explain:
    "The producer cannot distinguish a lost acknowledgement from a failed write. It retries to avoid losing data, which is the correct choice for availability. Without idempotence, that retry is appended as new data. With idempotence, the broker keeps producer state per partition and compares the sequence number. A sequence it has already seen is a duplicate and is not appended. The producer ID identifies the session; the sequence number identifies the position in that partition's stream.",
  fix: defaults({ idempotence: 1, errorRate: 10 }),
  debrief:
    "Enabling idempotence takes the duplicate share to zero while the failure rate stays at 10%. The broker still receives retries, so request amplification remains 1.1x, but append amplification falls to 1.0x. The saving is correctness and log growth, not broker work. The limit is the producer session: a new producer gets a new ID, and an application that sends the same event twice still creates two records. Cross-session and cross-system duplicates need an application idempotency key or transactions.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A producer sends a batch to a partition leader and waits for an acknowledgement. The acknowledgement can be lost after the broker has already appended the batch. The producer sees a timeout or a network error, cannot tell whether the write succeeded, and retries. Without extra information, the broker sees a second batch and appends it. The result is a duplicate record, even though every individual write succeeded.",
  },
  {
    type: "p",
    text: "An idempotent producer changes that interaction. The broker assigns a producer ID (PID) when the producer starts, and the producer attaches a monotonically increasing sequence number to each batch per partition. On a retry, the batch carries the same PID and sequence. The broker remembers the recent sequence state for that producer and partition. If the sequence is one it has already appended, it returns success without appending again. If the sequence is the next expected one, it appends. The retry becomes harmless. Idempotence requires acknowledgements from all in-sync replicas, retries above zero, and at most five in-flight requests per connection for ordering.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application to producer buffer to partition leader to log to consumer. Idempotence sits between the producer and the broker, before the log append. It does not deduplicate records that the application intentionally sends twice, and it does not span producer restarts: a new producer gets a new PID and a new sequence space. It also does not make the consumer's downstream write atomic. That is the boundary between idempotent production, consumer-side idempotency keys, and transactions.",
  },
  {
    type: "table",
    headers: ["Mechanism", "What it covers", "What it does not cover"],
    rows: [
      ["Idempotent producer", "Retries of the same batch within one producer session", "Application duplicates, new producer sessions, downstream writes"],
      ["Consumer idempotency key", "Repeated processing of the same event by the application", "Atomicity across multiple writes"],
      ["Kafka transactions", "Produced records and consumed offsets committed together", "Side effects outside Kafka"],
      ["Deduplication table", "A bounded window of event IDs at the consumer", "Events older than the window or a lost table"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 20,000 records per second, batches of 100 to 2,000 records, and an ambiguous failure share of 0 to 30%. Those are illustrative teaching values. They make the arithmetic visible: at a fixed produce rate, duplicate record volume is the produce rate times the failure share, while batch size changes how many retry requests carry it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Duplicate share: the percentage of delivered records that are retries of an already-appended batch.",
      "Duplicate records per second and cumulative duplicates so far.",
      "Append amplification and request amplification: log appends or broker requests divided by unique produced records.",
      "Retry reorder exposure: records retried while later batches may already be in flight.",
      "A flow view with the producer, the log, and the downstream writer, plus PID and sequence detail.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Duplicates. Watch duplicate share, request rate, and append rate together. Run the guided experiment before toggling idempotence, then compare Recovery. Finally raise Max in flight above five and note that duplicates stay at zero while ordering risk appears.",
  },
  { type: "sim", simId: "idempotent-producer" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At four seconds the producer began hitting ambiguous failures on 10% of batches. Each failure was a batch the broker had appended but the producer had not seen acknowledged. The producer retried. With idempotence off, the broker appended the retry as new data, so the consumer saw about 2,000 duplicate records per second, or 9.1% of delivered records. The broker received 22,000 requests per second and appended 22,000: 20,000 unique records plus 2,000 retries.",
  },
  {
    type: "p",
    text: "Enabling idempotence did not stop the retries. The broker still received 22,000 requests per second, but it recognized the retried batches by producer ID and sequence number and appended only 20,000 records. The duplicate share fell to zero, append amplification fell to 1.0x, and request amplification stayed at 1.1x. With six requests in flight, however, the model still showed reorder exposure: retries could land after later batches, and idempotence only preserves ordering up to five in-flight requests.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Producer metrics: record-retry-rate, record-error-rate, request-latency, and batch-size.",
      "Broker metrics: messages-in rate compared with the application's produced rate.",
      "Consumer records: duplicate event IDs or duplicate business keys, not just duplicate counts.",
      "Producer logs: OutOfOrderSequenceException, UnknownProducerIdException, and retry storms.",
      "Configuration: enable.idempotence, acks, retries, and max.in.flight.requests.per.connection.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the producer has idempotence enabled and whether retries are still on. Compare log-end-offset growth with acknowledged records, then sample duplicate keys at the consumer. If ordering matters, check in-flight requests before changing anything else.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm duplicates: compare produced records with distinct event IDs at the consumer.",
      "Check producer configuration: enable.idempotence, acks=all, retries above zero, and in-flight requests.",
      "Enable idempotence and keep retries on; do not fix duplicates by disabling retries.",
      "Keep max.in.flight at or below five when ordering matters, or reduce it to one for the strictest guarantee.",
      "Add an idempotency key at the consumer's write boundary for duplicates that cross producer sessions.",
      "Use transactions when produced records and consumed offsets must commit together.",
      "Re-run the ambiguous-failure scenario and verify duplicate share, request amplification, append amplification, and ordering.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Idempotence adds producer state and broker-side sequence checks; the cost is small relative to the network round trip but not zero.",
      "Retries still consume bandwidth and broker work even when the records are deduplicated.",
      "A larger batch makes each retry more expensive and increases the duplicate blast radius when idempotence is off.",
      "More in-flight requests raise throughput but weaken ordering; five is the idempotent producer's ordering boundary.",
      "Idempotence is per producer session, so a restart creates a new PID and a new duplicate window unless the application supplies keys.",
      "Transactions extend atomicity but add latency, a transactional ID, and a coordinator dependency.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-idempotence",
    question:
      "A producer has retries enabled and the consumer sees the same event twice. Why does enabling idempotence fix it?",
    difficulty: 3,
    hints: [
      "The producer cannot tell whether a timed-out write succeeded.",
      "The broker needs a way to recognize a retry.",
    ],
    answer:
      "The duplicate comes from an ambiguous acknowledgement: the broker appended the batch, but the producer did not receive the response and retried. Without idempotence, the retry looks like a new batch. With idempotence, the broker assigns a producer ID and the producer attaches a sequence number per partition. The retry carries the same sequence, so the broker can see it has already appended that batch and acknowledge it without writing again. The producer still retries; the retry is simply deduplicated before the append.",
    followUps: [
      "What happens if the producer restarts between the original write and the retry?",
      "Does idempotence deduplicate two separate sends of the same event?",
      "What does the consumer still need to do?",
    ],
    redFlags: [
      "Says idempotence stops retries.",
      "Claims exactly-once end to end.",
      "Ignores the producer session boundary.",
    ],
    rubric: [
      "Explains the ambiguous acknowledgement.",
      "Names producer ID and sequence number.",
      "States the session boundary.",
      "Distinguishes broker dedupe from application dedupe.",
    ],
  },
  {
    id: "idempotence-limits",
    question:
      "What are the limits of an idempotent producer, and when do you need transactions?",
    difficulty: 3,
    hints: [
      "The producer ID is tied to a session.",
      "Transactions cover produced records and consumed offsets together.",
    ],
    answer:
      "Idempotence suppresses duplicate appends from retries within one producer session. It does not cover an application that sends the same event twice, and a restarted producer gets a new PID, so a retry that crosses the restart can duplicate again. It also does not make the consumer's downstream write atomic with the offset commit. Transactions are the tool when a consume-transform-produce cycle must commit its output records and its input offsets together, or when writes span partitions and need atomicity. Even then, external side effects need their own idempotency key.",
    followUps: [
      "What configuration does idempotence require?",
      "How does a transactional ID change the producer lifecycle?",
      "What latency cost do transactions add?",
    ],
    redFlags: [
      "Treats idempotence as exactly-once for the whole pipeline.",
      "Ignores restarts and application-level duplicates.",
      "Uses transactions for a single-partition write with no offset coupling.",
    ],
    rubric: [
      "States the per-session scope.",
      "Names application duplicates and restarts.",
      "Places transactions at the consume-transform-produce boundary.",
      "Mentions external side effects.",
    ],
  },
  {
    id: "ordering-in-flight",
    question:
      "Idempotence is on and duplicate share is zero, but a consumer sees records out of order for one key. What do you check?",
    difficulty: 4,
    hints: [
      "Ordering is per partition, not per topic.",
      "The idempotent producer's ordering guarantee has an in-flight limit.",
    ],
    answer:
      "I would first confirm that the key always maps to one partition; a key change or a partition count change can move records. Then I would check max.in.flight.requests.per.connection. Idempotence prevents duplicate appends, but ordering is only preserved up to five in-flight requests per connection. Above five, a retried batch can be appended after a later batch. I would also check whether the consumer reorders during processing, whether multiple producers write the same key, and whether a transaction or a stream processor changed the key. The fix is to lower in-flight requests, keep the key stable, and verify order at the partition level.",
    followUps: [
      "Why does idempotence not guarantee ordering by itself?",
      "What happens if two producers write the same key?",
      "How would you detect a partition remap during a deploy?",
    ],
    redFlags: [
      "Blames the broker without checking in-flight requests.",
      "Assumes idempotence implies ordering.",
      "Ignores key changes and multiple producers.",
    ],
    rubric: [
      "Checks partition mapping and key stability.",
      "Names the five in-flight boundary.",
      "Considers consumer-side reordering and multiple producers.",
      "Proposes a verification at the partition level.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Producers that need ordering or retry safety have idempotence enabled.",
      "acks, retries, and max.in.flight are documented together, not tuned separately.",
      "Consumer writes have an idempotency key for events that can be replayed.",
      "Dashboards compare produced records with distinct event IDs at the consumer.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm duplicates by event ID, not only by payload similarity.",
      "Check whether retries rose with ambiguous failures or timeouts.",
      "Enable idempotence before disabling retries.",
      "Check in-flight requests if ordering is also broken.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify duplicate share, request amplification, and append amplification after the configuration change.",
      "Reconcile downstream state that may have received duplicate writes.",
      "Add an application-level key for duplicates that cross producer sessions.",
      "Test the ambiguous-failure path, including a producer restart.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: producer config enable.idempotence",
    url: "https://kafka.apache.org/documentation/#producerconfigs_enable.idempotence",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Idempotent producer behavior, required settings, and retry semantics.",
  },
  {
    title: "Apache Kafka documentation: message delivery semantics",
    url: "https://kafka.apache.org/documentation/#semantics",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "At-most-once, at-least-once, and exactly-once boundaries.",
  },
  {
    title: "Apache Kafka documentation: max.in.flight.requests.per.connection",
    url: "https://kafka.apache.org/documentation/#producerconfigs_max.in.flight.requests.per.connection",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "The in-flight limit that interacts with idempotence and ordering.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "idempotent-producer": {
      model: idempotentProducerModel,
      presets,
      instructions:
        "Start Healthy, then apply Duplicates. Compare Recovery with the same failure rate, then raise Max in flight above five and watch ordering risk return without duplicates.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Failure shares, batch sizes, and write rates are teaching values, not Kafka benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-idempotency",
    "streaming-producer-acks",
    "streaming-transactions",
    "streaming-consumer-groups",
    "streaming-keys-ordering",
  ],
};
