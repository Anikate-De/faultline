import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BUFFER_LIMIT = 250_000;
const PARTITIONS = 10;
const JITTER = 0.005;

const params = [
  {
    id: "produceRate",
    label: "Produce rate",
    min: 5_000,
    max: 40_000,
    step: 1_000,
    value: 10_000,
    unit: " rec/s",
    group: "Traffic",
    help: "Records the application attempts to write. Throttling reduces this before it reaches the bounded queue.",
    format: "rps" as const,
  },
  {
    id: "consumers",
    label: "Consumers",
    min: 2,
    max: 12,
    step: 1,
    value: 5,
    unit: "",
    group: "Consumers",
    help: "Members processing the queue. One member owns each assigned partition, so parallelism is capped at the model's 10 partitions.",
    format: "count" as const,
  },
  {
    id: "consumerRate",
    label: "Consumer throughput",
    min: 1_000,
    max: 8_000,
    step: 500,
    value: 3_000,
    unit: " rec/s",
    group: "Consumers",
    help: "Records per second one consumer can process. The group capacity is consumers times this rate.",
    format: "rps" as const,
  },
  {
    id: "throttlePct",
    label: "Producer throttle",
    min: 10,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Backpressure",
    help: "Share of the produce rate that is admitted upstream. Lowering it applies backpressure before the bounded queue fills.",
    format: "percent" as const,
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

function capacityFor(p: Params): number {
  const consumers = Math.min(PARTITIONS, Math.max(0, Math.round(num(p, "consumers", 5))));
  return consumers * Math.max(0, num(p, "consumerRate", 3_000));
}

interface Snapshot {
  lag: number;
  produceRate: number;
  acceptedRate: number;
  consumedRate: number;
  capacity: number;
  rejectedRate: number;
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, snapshot: Snapshot, flags: SimFrame["flags"]): SimFrame {
  const fill = clamp(snapshot.lag / BUFFER_LIMIT) * 100;
  const drainTime = snapshot.lag / Math.max(1, snapshot.capacity);
  const bufferHealth = healthFor(fill, 40, 80);
  const producerHealth = healthFor(snapshot.rejectedRate, 100, 1_000);
  const consumerHealth = healthFor(drainTime, 30, 120);
  const consumers = Math.min(PARTITIONS, Math.max(2, Math.round(num(p, "consumers", 5))));
  const consumerRate = Math.max(100, num(p, "consumerRate", 3_000));
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders producer",
        kind: "service",
        health: producerHealth,
        utilization: snapshot.capacity > 0 ? clamp(snapshot.produceRate / snapshot.capacity) : 1,
        throughput: snapshot.produceRate,
        sublabel: `${Math.round(snapshot.produceRate).toLocaleString("en-US")} rec/s attempted`,
        detail:
          snapshot.rejectedRate > 0
            ? `${Math.round(snapshot.rejectedRate).toLocaleString("en-US")} rec/s are being rejected because the bounded queue is full. The application must slow down, buffer locally, or shed.`
            : "Writes are being accepted. The producer is still faster than the consumers, so the bounded queue is absorbing the difference.",
        meta: { rejected: snapshot.rejectedRate, throttle: num(p, "throttlePct", 100) },
      },
      {
        id: "topic",
        label: "ingest queue",
        kind: "queue",
        health: bufferHealth,
        utilization: clamp(snapshot.lag / BUFFER_LIMIT),
        throughput: snapshot.acceptedRate,
        capacity: BUFFER_LIMIT,
        sublabel: `${Math.round(snapshot.lag).toLocaleString("en-US")} buffered · ${fill.toFixed(0)}%`,
        detail: `This bounded queue holds up to ${BUFFER_LIMIT.toLocaleString("en-US")} records. Consumers draining it free space. A Kafka log is also finite, but consumer progress does not free its disk; retention deletion does.`,
        meta: {
          depth: snapshot.lag,
          fill,
          limit: BUFFER_LIMIT,
          accepted: snapshot.acceptedRate,
        },
      },
      {
        id: "consumer",
        label: "orders-consumers",
        kind: "worker",
        health: consumerHealth,
        utilization: snapshot.capacity > 0 ? clamp(snapshot.consumedRate / snapshot.capacity) : 0,
        throughput: snapshot.consumedRate,
        capacity: snapshot.capacity,
        sublabel: `${Math.round(snapshot.consumedRate).toLocaleString("en-US")} rec/s processed`,
        detail: `${consumers} consumers at ${Math.round(consumerRate).toLocaleString("en-US")} rec/s each, capped by ${PARTITIONS} partitions. Capacity is ${Math.round(snapshot.capacity).toLocaleString("en-US")} rec/s; the backlog drains at capacity minus the admitted produce rate.`,
        meta: { capacity: snapshot.capacity, drainSeconds: drainTime },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", clamp(snapshot.acceptedRate / Math.max(1, snapshot.produceRate)), producerHealth),
      edge("topic-consumer", "topic", "consumer", clamp(snapshot.consumedRate / Math.max(1, snapshot.capacity)), consumerHealth),
    ],
    metrics: [
      metric("queueDepth", "Buffered records", snapshot.lag, " rec", undefined, undefined, "count"),
      metric("buffer-fill", "Queue fill", fill, "%", 40, 80, "percent"),
      metric("ingress-rejected", "Rejected ingress", snapshot.rejectedRate, " rec/s", 100, 1_000, "rps"),
      metric("drain-time", "Backlog drain time", drainTime, " s", 30, 120, "count"),
      metric("effective-produce", "Admitted produce rate", snapshot.produceRate, " rec/s", undefined, undefined, "rps"),
      metric("consumer-throughput", "Consumer throughput", snapshot.consumedRate, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      lag: snapshot.lag,
      rejectedRate: snapshot.rejectedRate,
      capacity: snapshot.capacity,
    },
    summary:
      snapshot.lag >= BUFFER_LIMIT
        ? `The bounded queue is full at ${BUFFER_LIMIT.toLocaleString("en-US")} records; ${Math.round(snapshot.rejectedRate).toLocaleString("en-US")} rec/s are rejected.`
        : `The queue holds ${Math.round(snapshot.lag).toLocaleString("en-US")} records (${fill.toFixed(0)}%); ${Math.round(snapshot.capacity).toLocaleString("en-US")} rec/s of consumer capacity.`,
  };
}

function seedSeries(frame: SimFrame, snapshot: Snapshot, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.5);
  const fill = clamp(snapshot.lag / BUFFER_LIMIT) * 100;
  const series: [string, number][] = [
    ["queueDepth", snapshot.lag],
    ["buffer-fill", fill],
    ["ingress-rejected", snapshot.rejectedRate],
    ["drain-time", snapshot.lag / Math.max(1, snapshot.capacity)],
    ["effective-produce", snapshot.produceRate],
    ["consumer-throughput", snapshot.consumedRate],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

export const backpressureModel: SimModel = {
  id: "streaming-backpressure",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const produce = Math.max(0, num(defaults(), "produceRate", 10_000));
    const capacity = capacityFor(defaults());
    const snapshot: Snapshot = {
      lag: 0,
      produceRate: produce,
      acceptedRate: produce,
      consumedRate: Math.min(capacity, produce),
      capacity,
      rejectedRate: 0,
    };
    const frame = buildFrame(defaults(), 0, snapshot, {});
    seedSeries(frame, snapshot, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const jitter = 1 + rng.between(-JITTER, JITTER);
    const produceRate = Math.max(0, num(p, "produceRate", 20_000) * (num(p, "throttlePct", 100) / 100) * jitter);
    const capacity = capacityFor(p);
    const previousLag = Math.max(0, Math.min(BUFFER_LIMIT, flagNumber(frame.flags, "lag")));
    const incoming = produceRate * seconds;
    const backlog = previousLag + incoming;
    const drained = Math.min(capacity * seconds, backlog);
    const overflow = Math.max(0, backlog - drained - BUFFER_LIMIT);
    const accepted = incoming - Math.min(incoming, overflow);
    const lag = clamp(backlog - drained - overflow, 0, BUFFER_LIMIT);
    const rejected = Math.max(0, incoming - accepted);
    const snapshot: Snapshot = {
      lag,
      produceRate,
      acceptedRate: accepted / seconds,
      consumedRate: drained / seconds,
      capacity,
      rejectedRate: rejected / seconds,
    };
    const t = frame.t + seconds;
    const result = buildFrame(p, t, snapshot, frame.flags);
    result.series = frame.series;
    result.events = frame.events;

    const fill = (lag / BUFFER_LIMIT) * 100;
    if (fill >= 40 && frame.flags.bufferWarning !== 1) {
      pushEvent(result, {
        id: "buffer-warning",
        at: t,
        severity: "warn",
        title: "The bounded queue is filling",
        detail: `The queue holds ${Math.round(lag).toLocaleString("en-US")} records, ${fill.toFixed(0)}% of its limit. At the current difference between produce rate and consumer capacity, the remaining space has a finite lifetime.`,
        nodeId: "topic",
        metricId: "buffer-fill",
      });
      result.flags.bufferWarning = 1;
    }
    if (snapshot.rejectedRate > 0 && frame.flags.rejectsStarted !== 1) {
      pushEvent(result, {
        id: "buffer-full-rejects",
        at: t,
        severity: "crit",
        title: "The bounded queue is full and rejecting writes",
        detail: `Accepted throughput is capped at ${Math.round(capacity).toLocaleString("en-US")} rec/s while the producer attempts ${Math.round(produceRate).toLocaleString("en-US")} rec/s. ${Math.round(snapshot.rejectedRate).toLocaleString("en-US")} rec/s are rejected.`,
        nodeId: "topic",
        metricId: "ingress-rejected",
      });
      result.flags.rejectsStarted = 1;
    }

    for (const item of result.metrics) recordSeries(result, item.id, item.value);
    return result;
  },
  thresholds: [
    {
      id: "buffer-fill",
      metricId: "buffer-fill",
      warn: 40,
      crit: 80,
      title: "The bounded queue is close to full",
      cause:
        "The producer is faster than the consumer group. A bounded queue absorbs the difference for a while, but it has a finite size. Buffer fill is the runway before accepted throughput must fall or writes must be rejected. A Kafka log is also finite, but its disk is reclaimed by retention deletion, not by consumer progress.",
      fix:
        "Reduce the produce rate with a quota or application throttle, add consumer capacity up to the partition count, or shed low-value work. If this is a Kafka log, do not wait for the disk to fill; by then the producer is already receiving errors.",
      checkFirst: [
        "Compare produce rate with consumer capacity, not with queue depth alone.",
        "Check disk headroom and retention deletion on the broker if the buffer is a log.",
        "Check whether the consumer is limited by processing, downstream calls, or partition count.",
      ],
    },
    {
      id: "ingress-rejected",
      metricId: "ingress-rejected",
      warn: 100,
      crit: 1_000,
      title: "Backpressure has reached the producer as errors",
      cause:
        "The queue is full, so it can only accept what consumers drain. The producer is attempting more than that, and the excess is rejected. This is backpressure arriving late, after the buffer was consumed.",
      fix:
        "Throttle at the producer or an upstream queue, shed low-priority records deliberately, and add consumer capacity. Make the rejection path explicit: retry with backoff, buffer locally with a bound, or drop with a metric.",
      checkFirst: [
        "Check producer error rates and retry behavior; retries can amplify the overload.",
        "Check whether the producer blocks on its local buffer or receives queue rejections.",
        "Check whether the consumer is keeping up with the partition count it owns.",
      ],
    },
    {
      id: "drain-time",
      metricId: "drain-time",
      warn: 30,
      crit: 120,
      title: "The buffered backlog will take too long to drain",
      cause:
        "Drain time is buffered records divided by consumer capacity. Even after the producer slows, the existing backlog keeps downstream state stale for that long, and any new failure extends it.",
      fix:
        "Add consumer capacity, reduce the produce rate further, or shed work that does not need to be processed. Bound the acceptable drain time in the freshness objective.",
      checkFirst: [
        "Check whether consumer capacity is actually available, not just configured.",
        "Check whether one partition or consumer is the bottleneck.",
        "Check whether the downstream can absorb a faster drain.",
      ],
    },
  ],
  insights: (frame, p) => {
    const lag = Math.max(0, flagNumber(frame.flags, "lag"));
    const capacity = capacityFor(p);
    const produce = Math.max(0, num(p, "produceRate", 20_000) * (num(p, "throttlePct", 100) / 100));
    const consumers = Math.min(PARTITIONS, Math.max(2, Math.round(num(p, "consumers", 5))));
    const items: string[] = [];
    items.push(
      `Produce is ${Math.round(produce).toLocaleString("en-US")} rec/s against ${Math.round(capacity).toLocaleString("en-US")} rec/s of consumer capacity. The difference is the rate at which the queue fills or drains.`,
    );
    items.push(
      `The queue holds ${Math.round(lag).toLocaleString("en-US")} of ${BUFFER_LIMIT.toLocaleString("en-US")} records. A bounded queue buys time; it does not create consumer capacity.`,
    );
    items.push(
      `${consumers} consumers are active under a ${PARTITIONS}-partition cap. Extra members beyond the cap have no partition to own and add no capacity.`,
    );
    if (produce > capacity) {
      items.push("While production exceeds capacity, the queue has a finite time to full. Throttling, shedding, or adding consumers are the only ways to change that.");
    } else {
      items.push("Capacity covers production, so the queue drains. The remaining question is whether the drain completes before the freshness objective.");
    }
    items.push("A Kafka log is also finite, but consumer progress does not free its disk; retention deletion does. The rate mismatch and the need to throttle or shed are the same.");
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
    description: "Consumers can process 15k rec/s against 10k produced; the queue stays empty.",
    tone: "ok",
    params: defaults({ produceRate: 10_000 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 2k rec/s surplus fills the queue slowly; it reaches warning but does not overflow.",
    tone: "warn",
    params: defaults({ produceRate: 17_000 }),
    elapsed: 60,
  },
  {
    id: "failure",
    label: "Queue full",
    description: "30k rec/s into 12k of consumer capacity; the queue fills and writes are rejected.",
    tone: "crit",
    params: defaults({ produceRate: 30_000, consumers: 4 }),
    elapsed: 15,
  },
  {
    id: "recovery",
    label: "Throttle the producer",
    description: "The same 30k attempt is throttled to 15k, matching consumer capacity and stopping growth.",
    tone: "ok",
    params: defaults({ produceRate: 30_000, consumers: 5, throttlePct: 50 }),
  },
  {
    id: "scale",
    label: "Scale consumers",
    description: "Ten consumers provide 30k rec/s of capacity, so the queue drains without throttling.",
    tone: "ok",
    params: defaults({ produceRate: 30_000, consumers: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-buffer-overflow",
  title: "Predict what happens when the bounded queue fills",
  simId: "streaming-backpressure",
  question:
    "The producer attempts 30k rec/s and consumers process 12k rec/s. The bounded queue is finite. Once it is full, what happens to the producer's writes?",
  prediction: {
    options: [
      { id: "grow", label: "The queue keeps growing; a durable log or buffer is effectively unbounded" },
      { id: "reject", label: "The queue rejects the excess and accepted throughput falls to consumer capacity" },
      { id: "speed", label: "Consumers automatically speed up because the queue is full" },
      { id: "delete", label: "Retention deletes old records, so the producer never sees a failure" },
    ],
    correctOptionId: "reject",
    explanation:
      "In this bounded queue, records cannot exceed the queue limit. Once it is full, accepted throughput cannot exceed what consumers drain, so the excess is rejected. A Kafka log is also finite, but consumer progress does not free its disk: retention deletion does. The rate mismatch is the same; only the reclamation mechanism differs. The producer receives errors or blocks on its local buffer, and the excess is rejected, retried, buffered elsewhere, or shed.",
  },
  setup: defaults({ produceRate: 30_000, consumers: 4 }),
  runFor: 40,
  observe: [
    "Queue fill reaches 100% after about 14 seconds at an 18k rec/s surplus.",
    "Rejected ingress jumps to roughly 18k rec/s once the queue is full.",
    "Queue depth stops at the queue limit instead of growing without bound.",
    "Consumer throughput stays at 12k rec/s; the consumers did not get faster.",
  ],
  explain:
    "The queue bought about 14 seconds. That is the value and the trap of a bounded buffer: it decouples producer and consumer for a while, then the finite limit turns the rate mismatch into errors. A Kafka log has the same rate mismatch but different reclamation: retention deletes segments, so consumer progress does not free disk. Backpressure can be applied earlier by throttling the producer, later by shedding at the consumer, or structurally by adding consumer capacity.",
  fix: defaults({ produceRate: 30_000, consumers: 6, throttlePct: 40 }),
  debrief:
    "Throttling to 40% admits 12k rec/s, and six consumers provide 18k rec/s of capacity. The queue drains at 6k rec/s instead of filling. The cost is deliberate loss of producer throughput: 18k rec/s of attempted work is slowed or shed before it reaches the queue. Scaling alone also works here because ten consumers provide 30k rec/s, but it fails if the partition cap or the downstream is the real bottleneck.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Backpressure is the mechanism that stops a fast producer from forcing unbounded work onto a slower consumer. In a streaming system, a buffer sits between them. That buffer can be a bounded queue in front of consumers or the Kafka log itself. Both absorb a burst, but neither is infinite. A bounded queue frees space when consumers drain it. A Kafka log frees disk when retention deletes segments; consumer progress does not reclaim it. When a limit is reached, the mismatch appears as rejected writes, blocked producers, or dropped work.",
  },
  {
    type: "p",
    text: "There are three places to apply backpressure. At the producer, you throttle or block before the write, which protects the buffer and preserves the data but slows the source. At the buffer, you accept that lag is a debt with a due date. At the workload, you shed low-value records or reject new work early, which protects the important path but loses data by design. None of these creates consumer capacity. They decide who waits and what is lost.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path has four queues: the producer's local buffer, the bounded queue or Kafka log, the consumer's fetch pipeline, and the downstream system. Each has a bound. The producer blocks when its local buffer is full, subject to max.block.ms. A bounded queue accepts until its limit and then rejects or blocks; it frees space as consumers drain. A Kafka log is bounded by disk and retention; it frees space only when segments are deleted, not when offsets are committed. The consumer fetches only what it can process, and its downstream writes can slow it further. Lag is the difference between production and consumption; queue fill is how close the bounded queue is to its limit.",
  },
  {
    type: "table",
    headers: ["Lever", "What it protects", "What it costs"],
    rows: [
      ["Throttle the producer", "Buffer and downstream stability", "Lower ingest; the source must wait or buffer"],
      ["Buffer in a bounded queue", "Short bursts and producer-consumer decoupling", "Lag and memory; consumer drain frees space, but the queue has a deadline"],
      ["Buffer in the Kafka log", "Durability and replay", "Disk and retention cost; consumer progress does not free space"],
      ["Add consumers", "Processing capacity up to the partition count", "Cost; no help beyond partitions or a slow downstream"],
      ["Shed low-value work", "The critical path and bounded latency", "Deliberate data loss; needs a policy and a metric"],
      ["Block the producer", "No loss and no overload", "Backpressure travels to the source; latency and timeouts"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 5k to 40k records per second, 2 to 12 consumers at 1k to 8k records per second each, a 250,000-record bounded queue, and 10 illustrative partitions. It models the bounded queue, where draining frees space. A Kafka log has the same rate mismatch but different reclamation: retention deletion frees disk, not consumer progress. The arithmetic is the lesson: fill time is free space divided by the difference between admitted production and consumer capacity.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Buffered records and queue fill: how much of the finite bounded queue is occupied.",
      "Rejected ingress: records the queue cannot accept because it is full.",
      "Backlog drain time: buffered records divided by consumer capacity.",
      "Admitted produce rate and consumer throughput, so the rate mismatch is visible.",
      "A queue view with the producer, the ingest queue, and the consumer group.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Queue full. Watch fill time and rejected ingress. Run the guided experiment before changing sliders, then compare Throttle the producer and Scale consumers. Ask which one protects downstream state and which one only moves the wait.",
  },
  { type: "sim", simId: "streaming-backpressure" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The producer attempted 30,000 records per second while four consumers processed 12,000. The difference, 18,000 records per second, went into the bounded queue. At 250,000 records of space, the queue filled in about 14 seconds. After that, it could accept only what consumers drained. Rejected ingress rose to 18,000 per second, queue depth sat at the limit, and consumer throughput stayed at 12,000. The queue delayed the failure; it did not prevent it.",
  },
  {
    type: "p",
    text: "Throttling to 40% admitted 12,000 records per second, matching capacity and stopping growth. Adding six consumers gave 18,000 records per second of capacity, so the queue drained at 6,000 per second. Both fixes changed the rate mismatch. Neither made the downstream faster, and neither increased the partition count; the model caps parallelism at 10 partitions, so members beyond that would be idle.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer lag and time-to-catch-up, not only queue depth.",
      "For a bounded queue: depth, reject rate, memory, and the consumer drain rate.",
      "For a Kafka log: disk headroom, log size, and retention deletion. Consumer progress does not free that disk.",
      "Producer metrics: buffer-available-bytes, record-error-rate, retries, and max.block.ms timeouts.",
      "Consumer metrics: records-consumed-rate, fetch latency, processing time, and downstream write latency.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare admitted produce rate with consumer capacity before looking at queue depth. Then check whether the bottleneck is partition count, consumer processing, or the downstream. If the buffer is a Kafka log, check disk headroom and retention deletion; a full disk turns a lag problem into a write-availability problem.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the rate mismatch: admitted produce rate versus consumer capacity, not lag alone.",
      "Stop amplification: bound producer retries and make rejection handling explicit.",
      "Choose the backpressure point: throttle at the source, buffer within a known bound, or shed low-value work.",
      "Add consumers only if partitions are available and the downstream can absorb the extra write rate.",
      "If the buffer is a Kafka log, protect disk with retention and headroom; consumer progress will not free it.",
      "Verify that the drain completes before the freshness objective, not just that the queue stopped growing.",
      "Re-run at peak and check that the producer's rejection path does not create a retry storm.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Buffering decouples producer and consumer but converts a rate problem into a lag and memory or disk problem with a deadline.",
      "A bounded queue frees space as consumers drain; a Kafka log does not, so its disk and retention budget are the real limit.",
      "Throttling protects the buffer and downstream but pushes latency to the source; the source may time out or buffer elsewhere.",
      "Shedding protects the critical path but loses data; it needs a policy for which records can be dropped.",
      "Adding consumers is effective only up to the partition count and only if the downstream is not the bottleneck.",
      "A larger buffer buys more time and costs more memory or disk, longer replay, and a larger failure when it finally fills.",
      "Blocking the producer preserves data but can stall the source and amplify timeouts upstream.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "where-backpressure",
    question:
      "A producer writes 30k records per second and consumers process 12k. Lag is growing and the broker disk is filling. Where do you apply backpressure?",
    difficulty: 2,
    hints: [
      "The log is a buffer, not extra consumer capacity.",
      "Decide whether the excess work can be delayed, dropped, or processed faster.",
    ],
    answer:
      "I would first confirm the mismatch and how long the disk has left. Then I would choose based on what the business can tolerate. If every record matters and the source can wait, I would throttle the producer or let it block on its local buffer, and add consumers up to the partition count if the downstream can absorb them. If some records are low value, I would shed them early with a metric. I would not rely on the log alone, because it only delays the point where writes are rejected. I would also bound producer retries so a rejection does not become a retry storm.",
    followUps: [
      "How do you decide between throttling and shedding?",
      "What limits consumer scaling?",
      "What happens to producer retries when the broker rejects writes?",
    ],
    redFlags: [
      "Says the log can absorb unlimited data.",
      "Adds consumers without checking partitions or the downstream.",
      "Ignores retry amplification.",
    ],
    rubric: [
      "Identifies the rate mismatch and disk deadline.",
      "Chooses a backpressure point by data value and latency tolerance.",
      "Names partition and downstream limits.",
      "Bounds retries and makes rejection explicit.",
    ],
  },
  {
    id: "lag-is-debt",
    question:
      "Lag is two million records and the buffer is at 90%. The team wants to raise retention to buy time. What is wrong with that plan?",
    difficulty: 3,
    hints: [
      "Retention controls how long records stay, not how fast they are processed.",
      "A bigger buffer extends the runway and the recovery tail.",
    ],
    answer:
      "Raising retention changes when old records are deleted; it does not add consumer capacity or reduce the produce rate. If the buffer is filling because production exceeds consumption, more retention gives the backlog more room and more time before writes fail, but the drain rate is unchanged. It also increases storage cost and the replay tail, and it can hide the problem until the disk or the freshness objective fails. I would keep retention sized for recovery, then fix the rate mismatch with throttling, shedding, or real consumer capacity. I would watch time-to-catch-up, not just buffer percentage.",
    followUps: [
      "When is a larger buffer the right answer?",
      "How would you calculate the runway?",
      "What signal tells you the drain is actually working?",
    ],
    redFlags: [
      "Treats retention as consumer capacity.",
      "Ignores storage and replay cost.",
      "Watches queue depth without drain rate.",
    ],
    rubric: [
      "Separates retention from processing capacity.",
      "Computes runway or drain time.",
      "Names storage and replay costs.",
      "Chooses a rate fix and a freshness signal.",
    ],
  },
  {
    id: "lag-without-overload",
    question:
      "Consumer lag is rising, but the broker is healthy and producers are not retrying. Does that always mean you should throttle the producer?",
    difficulty: 3,
    hints: [
      "Lag is the result of production and consumption rates.",
      "A backlog can be draining even while it is large.",
    ],
    answer:
      "No. I would compare production rate with consumer capacity and look at the trend, not just the level. If capacity is above production, the backlog is draining even if it is large; throttling would only slow useful work. If production is above capacity, the gap will not close by itself, and I would choose between throttling, adding consumers, and shedding based on the data value and the latency budget. I would also check whether the consumer slowed down: a downstream regression or a poison record can create the same lag without any increase in production. The right action depends on which side of the rate equation changed.",
    followUps: [
      "How would you tell a producer surge from a consumer regression?",
      "What would you check before adding consumers?",
      "When is a rising lag safe to leave alone?",
    ],
    redFlags: [
      "Treats rising lag as proof of producer overload.",
      "Throttles without checking consumer capacity.",
      "Ignores a consumer-side regression.",
    ],
    rubric: [
      "Compares production rate with capacity.",
      "Checks the lag trend and drain direction.",
      "Considers consumer-side regression.",
      "Chooses an action from data value and latency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Produce rate, consumer capacity, and partition count are on one dashboard.",
      "Broker disk headroom and retention deletion rate are monitored.",
      "Producer retries and max.block.ms are configured so rejection does not amplify load.",
      "A shedding policy exists for work that can be dropped under overload.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare admitted produce rate with consumer capacity before changing retention.",
      "Check whether the bottleneck is partitions, consumer processing, or the downstream.",
      "Throttle or shed before the broker disk fills; do not wait for write errors.",
      "Bound retries and make the rejection path explicit.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that the queue drained and time-to-catch-up returned to target.",
      "Reconcile records that were shed or rejected.",
      "Right-size the queue, buffer, and retention against a measured recovery objective.",
      "Load-test the producer rejection path and the consumer drain rate.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: producer configs buffer.memory and max.block.ms",
    url: "https://kafka.apache.org/documentation/#producerconfigs_buffer.memory",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Producer-side buffering and the point where send calls block.",
  },
  {
    title: "Apache Kafka documentation: monitoring and consumer lag",
    url: "https://kafka.apache.org/documentation/#monitoring",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Lag, broker health, and the metrics that show a growing backlog.",
  },
  {
    title: "Reactive Streams specification",
    url: "https://www.reactive-streams.org/",
    publisher: "Reactive Streams",
    kind: "standard" as const,
    note: "Demand-based flow control and bounded buffering across asynchronous stages.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "streaming-backpressure": {
      model: backpressureModel,
      presets,
      instructions:
        "Start Healthy, then apply Queue full. Watch fill time and rejected ingress, then compare Throttle the producer and Scale consumers.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 250,000-record bounded queue, 10-partition cap, and rates are teaching values, not Kafka defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-backpressure",
    "streaming-consumer-lag",
    "streaming-consumer-groups",
    "streaming-kafka-partitions",
    "streaming-partition-count",
  ],
};
