import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MESSAGE_KB = 2;

const params = [
  {
    id: "producerRps",
    label: "Producer rate",
    min: 100,
    max: 50_000,
    step: 100,
    value: 5_000,
    unit: " msg/s",
    group: "Producer",
    help: "Messages the producer can emit per second when nothing slows it down.",
    format: "rps" as const,
  },
  {
    id: "consumerRps",
    label: "Consumer rate",
    min: 100,
    max: 20_000,
    step: 100,
    value: 2_000,
    unit: " msg/s",
    group: "Consumer",
    help: "Messages the consumer can process per second. It is the real capacity of the pipeline.",
    format: "rps" as const,
  },
  {
    id: "queueLimit",
    label: "Queue limit",
    min: 100,
    max: 1_000_000,
    step: 100,
    value: 10_000,
    unit: " msg",
    group: "Buffer",
    help: "Maximum messages the queue will hold. Memory is the limit multiplied by message size.",
    format: "count" as const,
  },
  {
    id: "responseMode",
    label: "Producer response",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Buffer",
    help: "Zero keeps producing and drops overflow. One blocks the producer when the buffer is nearly full. Two throttles the producer to consumer capacity.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function modeName(mode: number): string {
  if (mode === 1) return "Block producer";
  if (mode === 2) return "Throttle producer";
  return "Drop overflow";
}

interface Computed {
  mode: number;
  producer: number;
  consumer: number;
  limit: number;
  messageKb: number;
  queue: number;
  effectiveProducer: number;
  accepted: number;
  dropped: number;
  memoryMb: number;
  lag: number;
  fill: number;
  blockedShare: number;
  producerLatency: number;
}

function compute(p: Params, previousQueue: number, dt: number): Computed {
  const mode = Math.round(clamp(num(p, "responseMode", 0), 0, 2));
  const producer = Math.max(1, num(p, "producerRps", 5_000));
  const consumer = Math.max(1, num(p, "consumerRps", 2_000));
  const limit = Math.max(1, num(p, "queueLimit", 10_000));
  const messageKb = MESSAGE_KB;
  const queue = clamp(previousQueue, 0, limit);
  const nearFull = queue >= limit * 0.8;
  const effectiveProducer = mode !== 0 && nearFull ? Math.min(producer, consumer) : producer;
  const room = (limit - queue) / Math.max(dt, 0.01);
  const accepted = Math.min(effectiveProducer, consumer + room);
  const served = Math.min(consumer, queue / Math.max(dt, 0.01) + accepted);
  const nextQueue = clamp(queue + (accepted - served) * dt, 0, limit);
  const dropped = Math.max(0, effectiveProducer - accepted);
  return {
    mode,
    producer,
    consumer,
    limit,
    messageKb,
    queue: nextQueue,
    effectiveProducer,
    accepted,
    dropped,
    memoryMb: (nextQueue * messageKb) / 1_024,
    lag: nextQueue / consumer,
    fill: (nextQueue / limit) * 100,
    blockedShare: mode !== 0 && effectiveProducer < producer ? (1 - effectiveProducer / producer) * 100 : 0,
    producerLatency: mode !== 0 && nearFull ? (nextQueue / consumer) * 1_000 + 10 : 10,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const memoryHealth = healthFor(values.memoryMb, 512, 1_024);
  const dropHealth = healthFor(values.dropped, 100, 5_000);
  const lagHealth = healthFor(values.lag, 10, 60);
  const producerHealth = values.blockedShare >= 90 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Producer",
        kind: "service",
        health: producerHealth,
        utilization: clamp(values.effectiveProducer / Math.max(1, values.producer)),
        throughput: values.effectiveProducer,
        sublabel: `${Math.round(values.effectiveProducer).toLocaleString()} msg/s`,
        detail: `${modeName(values.mode)}. ${Math.round(values.blockedShare)}% of producer capacity is withheld; producer-side latency ${values.producerLatency.toFixed(0)}ms.`,
        meta: { view: "queue" },
      },
      {
        id: "queue",
        label: "Bounded queue",
        kind: "queue",
        health: memoryHealth === "ok" ? lagHealth : memoryHealth,
        utilization: clamp(values.fill / 100),
        throughput: values.queue,
        sublabel: `${Math.round(values.queue).toLocaleString()} / ${Math.round(values.limit).toLocaleString()} msg`,
        detail: `${values.memoryMb.toFixed(0)} MB at ${values.messageKb.toFixed(1)} KB per message. ${Math.round(values.dropped).toLocaleString()} msg/s dropped at the overflow point.`,
        meta: { view: "queue", memoryMb: values.memoryMb, fill: values.fill },
      },
      {
        id: "consumer",
        label: "Consumer",
        kind: "worker",
        health: lagHealth,
        utilization: clamp(values.consumer / Math.max(1, values.consumer)),
        throughput: values.consumer,
        sublabel: `${Math.round(values.consumer).toLocaleString()} msg/s`,
        meta: { view: "queue" },
      },
      {
        id: "dlq",
        label: "Overflow",
        kind: "queue",
        health: dropHealth,
        throughput: values.dropped,
        sublabel: `${Math.round(values.dropped).toLocaleString()} msg/s dropped`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("producer-queue", "producer", "queue", clamp(values.effectiveProducer / 50_000), "ok"),
      edge("queue-consumer", "queue", "consumer", clamp(values.consumer / 50_000), lagHealth),
      edge("queue-dlq", "queue", "dlq", clamp(values.dropped / 50_000), dropHealth),
    ],
    metrics: [
      metric("memory-mb", "Queue memory", values.memoryMb, " MB", 512, 1_024, "bytes"),
      metric("dropped-rate", "Dropped messages", values.dropped, " msg/s", 100, 5_000, "rps"),
      metric("lag", "Consumer lag", values.lag, "s", 10, 60, "number"),
      metric("queue-depth", "Queue depth", values.queue, " msg", undefined, undefined, "count"),
      metric("queue-fill", "Queue fill", values.fill, "%", 85, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, queue: values.queue, mode: values.mode },
    summary: `${modeName(values.mode)}: ${values.memoryMb.toFixed(0)} MB queued, ${values.lag.toFixed(1)}s lag, ${Math.round(values.dropped).toLocaleString()} msg/s dropped.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 4)) / 2.3);
  const seeds: [string, number, number][] = [
    ["memory-mb", values.memoryMb, 3],
    ["dropped-rate", values.dropped, 20],
    ["lag", values.lag, 0.1],
    ["queue-depth", values.queue, values.limit * 0.005],
    ["queue-fill", values.fill, 0.5],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.5) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "memory-mb",
    metricId: "memory-mb",
    warn: 512,
    crit: 1_024,
    title: "The queue is becoming a memory problem",
    cause:
      "The producer emits faster than the consumer drains, and the buffer has no effective bound or is large enough to exhaust the process. Queue memory is depth times message size; a depth that looks acceptable in messages can be fatal in bytes.",
    fix:
      "Bound the queue by memory or bytes, then choose an overflow behavior: block the producer, throttle it to consumer capacity, or drop with a defined policy. An unbounded queue is not a buffer; it is a memory leak with a backlog.",
    checkFirst: [
      "Compare producer rate with consumer rate; the difference is the fill rate.",
      "Check queue depth in bytes, not only in messages.",
      "Check whether the producer can observe the queue's capacity signal.",
    ],
  },
  {
    id: "dropped-rate",
    metricId: "dropped-rate",
    warn: 100,
    crit: 5_000,
    title: "Overflow is dropping work",
    cause:
      "The buffer reached its limit and the producer kept writing. Dropping protects memory and latency, but every dropped message is work that must be retried, reconciled, or abandoned.",
    fix:
      "Decide which drop policy the product can defend: newest, oldest, or a priority class. Prefer propagating backpressure so the producer stops producing work that will be discarded.",
    checkFirst: [
      "Check which messages are dropped and whether they are replayable.",
      "Check whether the producer retries immediately into the same queue.",
      "Check whether the drop policy is documented or accidental.",
    ],
  },
  {
    id: "lag",
    metricId: "lag",
    warn: 10,
    crit: 60,
    title: "Consumer lag exceeds the freshness budget",
    cause:
      "The queue holds more work than the consumer can process within the time the product allows. Lag is the backlog divided by consumer throughput, so it grows linearly while the producer outruns the consumer.",
    fix:
      "Increase consumer capacity, reduce message cost, or slow the producer. A larger queue hides lag; it does not reduce it.",
    checkFirst: [
      "Calculate lag as queue depth divided by consumer rate.",
      "Check whether consumer capacity fell or producer volume rose.",
      "Check whether one partition, key, or message type dominates the backlog.",
    ],
  },
];

export const backpressureModel: SimModel = {
  id: "foundations-backpressure",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, 0.1);
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const previousQueue = Math.max(0, Number(frame.flags.queue ?? 0));
    const values = compute(p, previousQueue, dt);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${modeName(values.mode)}: ${values.memoryMb.toFixed(0)} MB queued, ${values.lag.toFixed(1)}s lag, ${Math.round(values.dropped).toLocaleString()} msg/s dropped.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, Math.max(0, Number(frame.flags.queue ?? 0)), 0.1);
    const items: string[] = [];
    items.push(
      `The producer offers ${Math.round(values.producer).toLocaleString()} msg/s and the consumer drains ${Math.round(values.consumer).toLocaleString()} msg/s. The difference fills the queue at ${Math.round(Math.max(0, values.producer - values.consumer)).toLocaleString()} msg/s until backpressure or overflow intervenes.`,
    );
    items.push(
      `The queue holds ${Math.round(values.queue).toLocaleString()} messages, or ${values.memoryMb.toFixed(0)} MB at ${values.messageKb.toFixed(1)} KB each. The limit is ${Math.round(values.limit).toLocaleString()} messages.`,
    );
    if (values.mode === 0) {
      items.push(
        `Overflow is dropping ${Math.round(values.dropped).toLocaleString()} msg/s. Memory is bounded by the limit, but work is not: the producer keeps creating messages that will never be processed.`,
      );
    } else {
      items.push(
        `${modeName(values.mode)} withholds ${Math.round(values.blockedShare)}% of producer capacity while the queue is near full. The producer waits; the queue and memory stay bounded.`,
      );
    }
    items.push(
      `Consumer lag is ${values.lag.toFixed(1)}s. Lag is the backlog the consumer has accepted, not the work the producer has already discarded.`,
    );
    return items;
  },
  legend: [
    { label: "Flowing", tone: "ok" },
    { label: "Backlog", tone: "warn" },
    { label: "Overflow", tone: "crit" },
    { label: "Blocked", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "1.5k msg/s into a 2k consumer. The queue stays empty and the producer never waits.",
    tone: "ok",
    params: defaults({ producerRps: 1_500, consumerRps: 2_000, queueLimit: 10_000, responseMode: 0 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "6k msg/s into 4k with a 100k buffer and throttling. Lag builds to about 20 seconds.",
    tone: "warn",
    params: defaults({ producerRps: 6_000, consumerRps: 4_000, queueLimit: 100_000, responseMode: 2 }),
  },
  {
    id: "failure",
    label: "Unbounded growth",
    description: "30k msg/s into 2k with a 600k buffer and no backpressure. Memory and drops both cross critical.",
    tone: "crit",
    params: defaults({ producerRps: 30_000, consumerRps: 2_000, queueLimit: 600_000, responseMode: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Throttle the producer to consumer capacity with a small buffer. No drops, bounded memory, stable lag.",
    tone: "ok",
    params: defaults({ producerRps: 30_000, consumerRps: 2_000, queueLimit: 10_000, responseMode: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-backpressure",
  title: "Predict what protects memory without losing work",
  simId: "backpressure",
  question:
    "The producer writes four times faster than the consumer and the queue is allowed to grow to 600k messages. Which response bounds memory without silently discarding work?",
  prediction: {
    options: [
      { id: "grow", label: "Let the queue grow until the consumer catches up" },
      { id: "drop", label: "Drop the newest messages when the queue is full" },
      { id: "block", label: "Apply backpressure so the producer waits for capacity" },
      { id: "heap", label: "Add heap so the queue can hold more" },
    ],
    correctOptionId: "block",
    explanation:
      "Backpressure propagates the consumer's capacity to the producer. When the buffer is full, the producer blocks or throttles instead of creating more work. Memory stays bounded and no accepted message is discarded. Dropping also bounds memory, but it loses work. Growing the queue or the heap only delays the failure and increases the recovery time.",
  },
  setup: defaults({ producerRps: 30_000, consumerRps: 2_000, queueLimit: 600_000, responseMode: 0 }),
  runFor: 40,
  observe: [
    "Queue memory reaches about 1.17 GB and crosses the critical threshold.",
    "Dropped messages settle at 28k msg/s once the queue is full.",
    "Consumer lag reaches 300s: the consumer is 300 seconds behind the newest message.",
    "Blocking at the same load holds memory near 20 MB and drops to zero, but producer latency rises.",
  ],
  explain:
    "A queue absorbs a temporary mismatch; it cannot absorb a permanent one. At 30k in and 2k out, the backlog grows by 28k messages per second. With no signal to the producer, the only outcomes are memory growth or overflow. Backpressure changes the producer's behavior: it stops accepting new work until the consumer catches up. That moves the cost to producer latency, which is visible and bounded, instead of memory, which is invisible until the process dies.",
  fix: defaults({ producerRps: 30_000, consumerRps: 2_000, queueLimit: 10_000, responseMode: 2 }),
  debrief:
    "Throttling protected memory and avoided drops, but the producer now runs at 2k instead of 30k. That is the honest capacity of the pipeline. The team still has to decide whether to add consumers, reduce message cost, or reject producer work upstream. A bounded queue with backpressure makes that decision explicit; an unbounded queue postpones it until the crash.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Backpressure is a signal from a slower stage to a faster one: slow down, because I cannot accept more work at this rate. It is the alternative to buffering without a bound. A queue can absorb a short burst, but if the producer sustains a higher rate than the consumer, the backlog grows by the difference every second. Memory grows with the backlog, and latency grows with the wait.",
  },
  {
    type: "p",
    text: "There are three common responses when the buffer is full. Drop overflow keeps the producer running and discards work. Blocking the producer stops it from writing until space is available. Throttling reduces the producer's rate to the consumer's capacity. Dropping protects memory and loses data. Blocking protects both and transfers the cost to producer latency. Throttling is blocking with a smoother control loop.",
  },
  {
    type: "p",
    text: "The failure is not the queue filling. It is the queue being treated as infinite. An unbounded queue has no signal path, so the producer never learns that the consumer is behind. The process eventually runs out of memory or the latency becomes useless, and the restart loses whatever was buffered. The same mismatch with a bound and a backpressure signal becomes a slow producer, which is a capacity problem rather than an outage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Backpressure belongs at the boundary where the producer can still be slowed: an API response, a database write, a socket, or a message producer. If the producer is an external client, the signal is a 429 or a full TCP window. If the producer is an internal worker, the signal is a blocking write or a rate limit. Putting the bound only at the consumer is too late; by then the work is already in the queue and the producer has no reason to stop.",
  },
  {
    type: "table",
    headers: ["Response", "Memory", "Work", "Cost"],
    rows: [
      ["Unbounded queue", "Grows until failure", "Retained, then lost on restart", "Long latency and crash recovery"],
      ["Drop overflow", "Bounded by limit", "Discarded", "Data loss and reconciliation"],
      ["Block producer", "Bounded by limit", "Retained, delayed", "Producer latency and stalled callers"],
      ["Throttle producer", "Bounded with headroom", "Retained, paced", "Control loop and rate coordination"],
    ],
  },
  {
    type: "p",
    text: "This module models a producer, a bounded queue, and a consumer. The message size, queue limit, and rates are illustrative. The shape is the lesson: a queue depth in messages becomes a memory number only when it is multiplied by message size, and a rate mismatch becomes a memory failure only when nothing pushes back.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Queue memory in MB: depth times message size, the number that decides whether the process survives.",
      "Dropped messages per second: work discarded at the overflow point.",
      "Consumer lag in seconds: backlog divided by consumer throughput.",
      "Queue fill and depth: how close the buffer is to its bound.",
      "Producer throughput and withheld capacity: the cost of the backpressure signal.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Unbounded growth. Watch memory, drops, and lag rise together. Run the experiment before revealing the explanation, then set Producer response to Block and compare it with Recovery. Compare what happens to memory and to producer throughput; the tradeoff is the lesson.",
  },
  {
    type: "p",
    text: "The first question is not how large the queue should be. It is what the producer does when the queue is full. If the answer is nothing, the queue is unbounded regardless of its configured limit, because the producer will keep finding a way to add work. Bounded memory requires a behavior at the bound.",
  },
  { type: "sim", simId: "backpressure" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The producer offered 30k messages per second and the consumer drained 2k. With no backpressure, the 600k-message buffer filled in about 21 seconds, then every additional message was dropped. Memory reached about 1.17 GB and lag reached 300 seconds. The queue was bounded in messages, but the producer's behavior was not: it kept creating work that the system could not process.",
  },
  {
    type: "p",
    text: "Blocking or throttling the producer changed the outcome. The buffer stayed near 80% full, memory stayed around 20 MB, and no accepted message was dropped. The producer's effective rate fell to the consumer's 2k, so producer latency rose. That is the real trade: the queue no longer hides the mismatch, and the producer must wait or be rejected upstream.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Queue metrics: depth, bytes, oldest message age, and the configured limit.",
      "Producer metrics: send rate, blocked time, retry rate, and the number of writes that waited on the buffer.",
      "Consumer metrics: processing rate, lag, error rate, and per-partition or per-key skew.",
      "Process metrics: heap in use, garbage collection, and restarts. A queue that lives in memory is a heap risk.",
      "Application metrics: dropped or dead-lettered messages, reconciliation backlog, and customer-visible missing work.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare producer rate with consumer rate. The difference is the fill rate, and the queue limit divided by that difference is the time to failure. Check memory in bytes, not only depth. Then check what the producer does at the bound: if it keeps producing, the queue has no backpressure.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Bound the queue in bytes as well as messages.",
      "Decide the overflow behavior: block, throttle, or drop by class.",
      "Propagate the signal to the producer so it stops creating work that will be discarded.",
      "Return a clear response to upstream callers when the producer is blocked or throttled.",
      "Add consumer capacity only after the queue is bounded; otherwise the backlog hides the need.",
      "Load-test at a sustained mismatch and verify that memory, lag, and drops stay bounded.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Dropping keeps the producer fast and bounds memory, but it loses work and creates a reconciliation problem.",
      "Blocking preserves work and bounds memory, but it transfers latency to the producer and can stall a request thread.",
      "Throttling is smoother than blocking, but it needs a control loop that reacts quickly enough to be useful.",
      "A larger queue absorbs longer bursts and lengthens the time to detect a permanent mismatch.",
      "Backpressure on an external producer can look like an outage to that producer even when the system is protecting itself.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "where-backpressure",
    question:
      "A producer writes 20k messages/s and the consumer processes 5k. The queue is growing. Where do you apply backpressure, and what does the producer see?",
    difficulty: 2,
    hints: [
      "The signal must reach the component that can slow down.",
      "A bound inside the consumer is too late.",
    ],
    answer:
      "I would apply backpressure at the producer's write boundary, backed by a bounded queue. When the buffer reaches its high-water mark, the producer blocks or is throttled to the consumer's rate, and upstream callers get a clear busy or retry response. The producer should not keep accepting work it cannot hand off. I would also bound the queue in bytes, set a drop policy for non-critical classes, and add consumer capacity if the 4× gap is permanent. The producer sees higher latency or rejections; that is the visible cost of not losing the data silently.",
    followUps: [
      "What if the producer is an external service you cannot slow?",
      "How do you choose the high-water mark?",
      "What happens to in-flight requests when the producer blocks?",
    ],
    redFlags: [
      "Adds a bigger queue.",
      "Drops messages without a policy.",
      "Blocks the consumer instead of the producer.",
    ],
    rubric: [
      "Places the signal at the producer boundary.",
      "Bounds the queue.",
      "Defines the upstream response.",
      "Addresses the permanent capacity gap.",
    ],
  },
  {
    id: "drop-vs-block",
    question:
      "When would you choose to drop messages instead of blocking the producer?",
    difficulty: 3,
    hints: [
      "Start with the value of the message and the cost of delay.",
      "Blocking can consume the producer's request threads.",
    ],
    answer:
      "I would drop when the message is low-value, replayable, or already superseded, and when blocking would stall a request path that serves live users. Metrics, debug events, and periodic sensor samples are examples where the newest value matters more than every value. I would block or throttle when the message is a command or an event that must not be lost, and when the producer can tolerate the wait. In both cases the policy must be explicit and observable: which class is dropped, how it is recorded, and how the consumer or operator finds out.",
    followUps: [
      "How would you drop oldest versus newest?",
      "What is the risk of blocking a request thread?",
      "How do you make drops visible without flooding logs?",
    ],
    redFlags: [
      "Drops everything equally.",
      "Blocks without a timeout.",
      "Has no record of what was dropped.",
    ],
    rubric: [
      "Ties the choice to message value.",
      "Considers producer thread cost.",
      "Names a drop policy.",
      "Makes the loss observable.",
    ],
  },
  {
    id: "blocked-thread",
    question:
      "You add blocking backpressure to an HTTP handler that writes to a queue. What new failure have you created, and how do you bound it?",
    difficulty: 3,
    hints: [
      "Blocking a request thread consumes the server's concurrency.",
      "The wait needs a limit and a response.",
    ],
    answer:
      "Blocking moves the backlog into the request threads. If the queue is full and every handler waits, the server's thread pool or event loop can stall, and health checks or unrelated routes fail with it. I would bound the wait, return a clear 429 or 503 when it expires, and keep the blocking write off the latency-critical request path where possible. I would monitor blocked time and in-flight requests, and use a separate worker or durable queue for work that can be deferred. Backpressure should slow one producer, not take down the process that serves everyone.",
    followUps: [
      "How would you implement the wait timeout?",
      "What happens to health checks while threads are blocked?",
      "Would you use a separate queue for critical work?",
    ],
    redFlags: [
      "Blocks indefinitely.",
      "Blocks the event loop.",
      "Has no overload response.",
    ],
    rubric: [
      "Names thread or event-loop exhaustion.",
      "Bounds the wait.",
      "Returns an overload response.",
      "Separates critical work.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every queue has a bound in messages and bytes.",
      "The producer's behavior at the bound is documented: block, throttle, or drop.",
      "The drop policy names which classes may be discarded.",
      "Queue memory is dashboarded against the process heap limit.",
      "A sustained producer-consumer mismatch is load-tested, not only a short burst.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare producer and consumer rates; the difference is the fill rate.",
      "Check queue memory and time-to-limit, not only depth.",
      "Check whether the producer is still accepting work at the bound.",
      "Check whether drops are replayable and whether retries amplify the load.",
      "Protect the consumer before adding buffer or heap.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile dropped or dead-lettered work.",
      "Review the high-water mark and the producer's response time.",
      "Decide whether the capacity gap is temporary or structural.",
      "Test the bound and the overflow path after every change to message size.",
    ],
  },
];

const references = [
  {
    title: "Reactive Streams",
    url: "https://www.reactive-streams.org/",
    publisher: "Reactive Streams",
    kind: "standard" as const,
    note: "Demand-based flow control and bounded buffering between asynchronous stages.",
  },
  {
    title: "Kafka consumer configuration",
    url: "https://kafka.apache.org/documentation/#consumerconfigs",
    publisher: "Apache Kafka",
    kind: "docs" as const,
    note: "Fetch sizing, polling, and consumer lag as a backpressure signal.",
  },
  {
    title: "Handling overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Rejecting excess work and client-side throttling.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    backpressure: {
      model: backpressureModel,
      presets,
      instructions:
        "Start healthy, then apply Unbounded growth. Watch memory and drops rise together. Run the experiment, then compare Block and Recovery. The producer's throughput is the cost of the protection.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Rates, message size, and queue limits are teaching values, not a broker default.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-admission-control",
    "foundations-load-shedding",
    "streaming-backpressure",
    "observability-log-pipeline-backpressure",
  ],
};
