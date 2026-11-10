import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "processingTime",
    label: "Processing time",
    min: 5,
    max: 300,
    step: 5,
    value: 30,
    unit: " s",
    group: "Consumer",
    help: "How long one consumer holds a message before deleting it. If this exceeds visibility, the queue can deliver it again.",
    format: "ms" as const,
  },
  {
    id: "visibility",
    label: "Visibility timeout",
    min: 5,
    max: 600,
    step: 5,
    value: 60,
    unit: " s",
    group: "Queue",
    help: "How long SQS hides a received message from other consumers. It starts when the message is received.",
    format: "ms" as const,
  },
  {
    id: "heartbeat",
    label: "Extend while working",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Consumer",
    help: "1 calls ChangeMessageVisibility before the timeout expires, keeping the message hidden until processing finishes.",
    format: "count" as const,
  },
  {
    id: "consumers",
    label: "Consumers",
    min: 1,
    max: 200,
    step: 1,
    value: 10,
    unit: "",
    group: "Consumer",
    help: "Parallel consumers polling the queue. More consumers raise service capacity but also raise the chance of overlapping receives.",
    format: "count" as const,
  },
  {
    id: "arrivalRate",
    label: "Arrival rate",
    min: 2,
    max: 200,
    step: 1,
    value: 15,
    unit: " msg/s",
    group: "Queue",
    help: "Messages sent to the queue per second. The queue buffers the difference when consumers are slower.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  processingTime: number;
  visibility: number;
  heartbeat: boolean;
  consumers: number;
  arrival: number;
  effectiveVisibility: number;
  serviceRate: number;
  consumerUtil: number;
  duplicateRate: number;
  oldestAge: number;
  depth: number;
}

function compute(p: Params, depth: number): Values {
  const processingTime = clamp(num(p, "processingTime", 30), 5, 300);
  const visibility = clamp(num(p, "visibility", 60), 5, 600);
  const heartbeat = num(p, "heartbeat", 0) >= 1;
  const consumers = Math.round(clamp(num(p, "consumers", 10), 1, 200));
  const arrival = clamp(num(p, "arrivalRate", 15), 2, 200);
  const effectiveVisibility = heartbeat ? processingTime + 15 : visibility;
  const serviceRate = consumers * (60 / processingTime);
  const consumerUtil = (arrival / Math.max(1, serviceRate)) * 100;
  const duplicateRate = processingTime > effectiveVisibility
    ? clamp((processingTime / effectiveVisibility - 1) * 25, 0, 100)
    : 0;
  const oldestAge = depth > 0 ? depth / Math.max(1, serviceRate) + processingTime / 2 : processingTime / 2;
  return {
    processingTime,
    visibility,
    heartbeat,
    consumers,
    arrival,
    effectiveVisibility,
    serviceRate,
    consumerUtil,
    duplicateRate,
    oldestAge,
    depth,
  };
}

function healthFor(values: Values): "ok" | "warn" | "crit" {
  if (values.duplicateRate >= 2 || values.consumerUtil >= 95) return "crit";
  if (values.duplicateRate >= 0.5 || values.consumerUtil >= 80) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, depth: number): SimFrame {
  const values = compute(p, depth);
  const consumerHealth = healthFor(values);
  const queueHealth = values.consumerUtil >= 95 || values.duplicateRate >= 2 ? "crit" : values.consumerUtil >= 80 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Order events",
        kind: "service",
        health: "ok",
        utilization: clamp(values.arrival / 200),
        throughput: values.arrival,
        sublabel: `${values.arrival} msg/s`,
        detail: `Producers send ${values.arrival} messages per second. SQS stores them until a consumer receives and deletes them.`,
        meta: { view: "queue" },
      },
      {
        id: "queue",
        label: "orders queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(values.consumerUtil / 100),
        throughput: values.arrival,
        capacity: values.serviceRate,
        sublabel: `${Math.round(values.depth).toLocaleString("en-US")} waiting`,
        detail: `Messages are visible to consumers except while a receive is in flight. The visibility timeout is ${values.visibility}s; effective hide time is ${values.effectiveVisibility}s. ${values.duplicateRate > 0 ? "Processing is longer than the hide window, so another consumer can receive the same message." : "Processing finishes inside the hide window."}`,
        meta: { view: "queue", depth: values.depth },
      },
      {
        id: "consumers",
        label: "Consumer fleet",
        kind: "worker",
        health: consumerHealth,
        utilization: clamp(values.consumerUtil / 100),
        throughput: Math.min(values.arrival, values.serviceRate),
        capacity: values.serviceRate,
        sublabel: `${values.consumers} consumers · ${values.consumerUtil.toFixed(0)}% busy`,
        detail: `Each consumer takes ${values.processingTime}s per message. The fleet can delete about ${values.serviceRate.toFixed(1)} messages/s. ${values.duplicateRate > 0 ? `About ${values.duplicateRate.toFixed(1)}% of receives are duplicates because the visibility window closes before the work ends.` : "No duplicate receives are expected."}`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("producer-queue", "producer", "queue", clamp(values.arrival / 200), queueHealth),
      edge("queue-consumers", "queue", "consumers", clamp(values.consumerUtil / 100), consumerHealth),
    ],
    metrics: [
      metric("duplicate-rate", "Duplicate receives", values.duplicateRate, "%", 0.5, 2, "percent"),
      metric("oldest-age", "Oldest message age", values.oldestAge, " s", 60, 300, "ms"),
      metric("queueDepth", "Messages waiting", values.depth, " messages", undefined, undefined, "count"),
      metric("consumer-util", "Consumer utilization", values.consumerUtil, "%", 80, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, depthJson: String(values.depth), processingTime: values.processingTime, visibility: values.visibility },
    summary: `${Math.round(values.depth).toLocaleString("en-US")} messages waiting; ${values.duplicateRate.toFixed(1)}% duplicate receives, ${values.oldestAge.toFixed(0)}s oldest age.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "duplicate-rate", Math.max(0, values.duplicateRate * (0.97 + 0.03 * Math.sin(index / 2.3))));
    recordSeries(frame, "oldest-age", Math.max(0, values.oldestAge * (0.98 + 0.02 * Math.sin(index / 2.7))));
    recordSeries(frame, "queueDepth", Math.max(0, values.depth * (0.97 + 0.03 * Math.sin(index / 2.5))));
    recordSeries(frame, "consumer-util", Math.max(0, values.consumerUtil * (0.99 + 0.01 * Math.sin(index / 2.1))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "duplicate-rate",
    metricId: "duplicate-rate",
    warn: 0.5,
    crit: 2,
    title: "The same message is being processed more than once",
    cause:
      "The consumer received the message, but its processing time exceeded the visibility timeout. SQS made the message visible again and another consumer received it. The first consumer may still finish and delete the message, so the second copy can process after the work was already done.",
    fix:
      "Make the visibility timeout longer than the p99 processing time, or call ChangeMessageVisibility on a heartbeat while working. Add an idempotency key for side effects, because a crash between work and delete can always produce a duplicate.",
    checkFirst: [
      "Compare p99 processing time with the visibility timeout.",
      "Check whether the consumer extends the timeout while working.",
      "Check ReceiveCount and duplicate side effects for the same message ID.",
    ],
  },
  {
    id: "oldest-age",
    metricId: "oldest-age",
    warn: 60,
    crit: 300,
    title: "The oldest message is older than the freshness budget",
    cause:
      "Arrival rate is above the consumer fleet's service rate, so the queue buffers work. Age, not depth, is the user-facing signal: a message at the head has been waiting the entire backlog drain time.",
    fix:
      "Raise consumer concurrency or shorten processing time, and keep the visibility timeout aligned with the new processing time. If the backlog cannot drain before retention, shed or reroute work.",
    checkFirst: [
      "Check ApproximateAgeOfOldestMessage, not only ApproximateNumberOfMessagesVisible.",
      "Check whether consumers are CPU-bound, I/O-bound, or waiting on a downstream call.",
      "Check whether the arrival rate changed or the consumer fleet shrank.",
    ],
  },
  {
    id: "consumer-util",
    metricId: "consumer-util",
    warn: 80,
    crit: 95,
    title: "Consumers have no headroom for the backlog",
    cause:
      "The fleet is spending almost all of its time processing. Any increase in arrival rate or processing time pushes the queue into unbounded growth, and retries add more work.",
    fix:
      "Add consumers within the downstream capacity budget, reduce per-message work, or batch where the API supports it. Do not scale consumers past the database or API they call.",
    checkFirst: [
      "Check consumer CPU and downstream latency together.",
      "Check whether duplicate processing is consuming capacity.",
      "Check the queue's retention window against the drain forecast.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const sqsVisibilityModel: SimModel = {
  id: "streaming-sqs-visibility",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(defaults(), seed, 0);
    seedSeries(frame, values);
    return frame;
  },
  step: (frame, p, dt) => {
    const previousDepth = Number(frame.flags.depthJson ?? 0);
    const base = compute(p, previousDepth);
    const seconds = Math.min(1, Math.max(0.01, dt));
    const depth = Math.max(0, previousDepth + (base.arrival - base.serviceRate) * seconds);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), depth);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0);
    const items: string[] = [];
    items.push(
      values.duplicateRate > 0
        ? `Processing takes ${values.processingTime}s but the message is hidden for ${values.effectiveVisibility}s. Another consumer can receive it before the first finishes.`
        : `Processing takes ${values.processingTime}s and the message stays hidden for ${values.effectiveVisibility}s, so no overlap is expected.`,
    );
    items.push(
      `The fleet can process ${values.serviceRate.toFixed(1)} messages/s against ${values.arrival}/s arriving. ${values.serviceRate >= values.arrival ? "The backlog drains." : "The backlog grows and oldest age follows it."}`,
    );
    items.push("Visibility is a lease, not a lock. It hides the message, but it does not stop work or guarantee that the first consumer will finish.");
    if (values.heartbeat) items.push("Heartbeat extension keeps the lease alive while work continues; it does not protect against a crashed consumer, so the message eventually becomes visible again.");
    items.push("A DLQ is the backstop for repeated failures. Set maxReceiveCount so a poison message leaves the main queue instead of cycling forever.");
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
    description: "30-second processing, 60-second visibility, and enough consumers for the arrival rate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A longer processing time and a near-capacity consumer fleet; no duplicates yet.",
    tone: "warn",
    params: defaults({ processingTime: 60, visibility: 90, consumers: 55, arrivalRate: 50 }),
  },
  {
    id: "failure",
    label: "Slow consumer",
    description: "120-second processing against a 30-second visibility timeout, with no extension.",
    tone: "crit",
    params: defaults({ processingTime: 120, visibility: 30, heartbeat: 0, consumers: 40, arrivalRate: 40 }),
  },
  {
    id: "heartbeat",
    label: "Heartbeat only",
    description: "The consumer extends visibility but the fleet is still short of capacity, so the backlog ages.",
    tone: "crit",
    params: defaults({ processingTime: 120, visibility: 30, heartbeat: 1, consumers: 30, arrivalRate: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Shorter processing, visibility above the p99, heartbeat extension, and enough consumers to drain.",
    tone: "ok",
    params: defaults({ processingTime: 45, visibility: 180, heartbeat: 1, consumers: 80, arrivalRate: 40 }),
  },
];

const experiment: Experiment = {
  id: "predict-visibility-duplicate",
  title: "Predict the duplicate delivery",
  simId: "sqs-visibility",
  question:
    "A consumer takes 120 seconds to process a message, the visibility timeout is 30 seconds, and it never extends the lease. What happens?",
  prediction: {
    options: [
      { id: "hidden", label: "The message stays hidden until the consumer deletes it" },
      { id: "redelivered", label: "After 30 seconds the message becomes visible and another consumer can receive it" },
      { id: "deleted", label: "SQS deletes the message when the timeout expires" },
      { id: "moved", label: "SQS moves the message to the DLQ automatically" },
    ],
    correctOptionId: "redelivered",
    explanation:
      "The visibility timeout is a lease. When it expires the message becomes visible again, even though the first consumer is still working. A second consumer can receive it, so the work runs twice. SQS does not delete the message and it does not move it to a DLQ without a redrive policy and maxReceiveCount.",
  },
  setup: defaults({ processingTime: 120, visibility: 30, heartbeat: 0, consumers: 40, arrivalRate: 40 }),
  runFor: 30,
  observe: [
    "Duplicate receives rise once processing outlasts the hide window.",
    "The queue depth is not the only signal; age and duplicate rate matter.",
    "A longer visibility timeout removes duplicates but increases the wait after a consumer crash.",
    "Heartbeat extension fixes duplicates only while the consumer is alive.",
  ],
  explain:
    "SQS hides a received message for the visibility timeout. If the consumer finishes and deletes it first, the message is gone. If the timeout expires first, another receive is allowed. The consumer cannot tell that another copy is in flight. Idempotency is still required because a crash between the side effect and DeleteMessage always leaves the message available for redelivery.",
  fix: defaults({ processingTime: 120, visibility: 180, heartbeat: 1, consumers: 80, arrivalRate: 40 }),
  debrief:
    "The fix sets visibility above the p99 processing time, extends it while work runs, and adds consumers so the backlog drains. Duplicate receives fall to zero in the model, but the design still needs an idempotency key for the crash case. The cost is a longer wait before a failed message can be retried.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Simple Queue Service (SQS) is a managed message queue. A consumer receives a message and gets a visibility timeout: for that many seconds, other consumers cannot receive it. If the consumer deletes the message before the timeout, the work is done. If it does not, the message becomes visible again and can be delivered to another consumer, even if the first one is still working.",
  },
  {
    type: "p",
    text: "The visibility timeout is a lease, not a lock. It controls when a message is eligible for redelivery, not whether work stops. A slow consumer, a paused process, or a network partition can all let the lease expire. The duplicate is the queue doing what it was designed to do: keep the message available until someone deletes it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, queue, consumer, downstream service. The receive sets the lease. The consumer calls DeleteMessage only after the side effect succeeds. A redrive policy moves a message to a dead-letter queue (DLQ) after maxReceiveCount receives, which bounds poison-message loops but does not prevent a slow consumer from being overtaken.",
  },
  {
    type: "table",
    headers: ["Control", "What it does", "What it does not do"],
    rows: [
      ["Visibility timeout", "Hides a received message from other consumers", "Stop the first consumer or delete the message"],
      ["ChangeMessageVisibility", "Extends the lease while work continues", "Protect against a crashed consumer"],
      ["DeleteMessage", "Removes the message after success", "Roll back a side effect that already happened"],
      ["Redrive policy and DLQ", "Moves a repeatedly failing message aside", "Prevent duplicates before maxReceiveCount"],
    ],
  },
  {
    type: "p",
    text: "This module uses 5 to 300 seconds of processing and up to 200 consumers. Those are illustrative teaching values, not SQS limits. The shape of the failure is the lesson: processing outlasts the lease, the message returns, and two workers perform the same side effect.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Duplicate receives: the share of receives that overlap an earlier delivery. Warning at 0.5%, critical at 2%.",
      "Oldest message age: the wait at the head of the queue. Warning at 60 seconds, critical at 300.",
      "Messages waiting and consumer utilization, which show whether the fleet can drain the backlog.",
      "A queue view with producers, the queue depth, and the consumer fleet.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Slow consumer. Run the experiment before changing the timeout. Compare Heartbeat only and Recovery: the first fixes duplicates but not capacity, the second fixes both.",
  },
  { type: "sim", simId: "sqs-visibility" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The consumer needed 120 seconds but the queue hid the message for only 30. The lease expired while the first worker was still processing, so a second worker received the same message. Duplicate receives rose above the critical line, and the queue's depth also grew because the fleet was slower than arrival. The duplicate was not a race in the consumer; it was a mismatch between work time and lease time.",
  },
  {
    type: "p",
    text: "Extending visibility with a heartbeat closed the overlap while the process was alive, but the backlog still aged because 30 consumers could not drain 40 messages/s. Recovery needed both a lease longer than the work and enough consumers to reduce the queue. The residual risk is a crash after the side effect and before DeleteMessage, which only idempotency can absorb.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "SQS metrics: ApproximateNumberOfMessagesVisible, ApproximateAgeOfOldestMessage, and ApproximateNumberOfMessagesNotVisible.",
      "Per-message ReceiveCount and message ID in consumer logs; a count above one is evidence of redelivery.",
      "Consumer p50 and p99 processing time, plus downstream latency inside the handler.",
      "Duplicate side effects in the downstream system, such as two charges for one order.",
      "ChangeMessageVisibility calls and their failure rate.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare p99 processing time with the visibility timeout. Check whether the consumer extends the lease. Check ReceiveCount and downstream idempotency before assuming the queue is at fault. Then check consumer capacity and oldest message age.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Set the visibility timeout above the p99 processing time, with room for retries.",
      "Extend visibility during long work with ChangeMessageVisibility, and stop extending when the work fails.",
      "Make the handler idempotent on a business key so a redelivery cannot repeat the effect.",
      "Add consumers only up to the downstream capacity, and watch oldest age rather than depth alone.",
      "Configure maxReceiveCount and a DLQ for messages that keep failing.",
      "Alert on ReceiveCount above one and on duplicate side effects, not only on queue depth.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A longer visibility timeout reduces duplicates but delays retry after a consumer crash.",
      "Heartbeat extension handles long work but adds a failure mode if the extension call fails.",
      "A DLQ bounds poison messages but requires an owner, alerting, and a replay path.",
      "More consumers raise throughput until the downstream API or database becomes the limit.",
      "Idempotency protects the side effect but adds a deduplication store and a retention window.",
      "Batching improves throughput but increases the blast radius of one failed batch.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "duplicate-cause",
    question:
      "A message is processed twice. The consumer code has no retry loop. How do you explain it?",
    difficulty: 2,
    hints: [
      "The queue can redeliver after the visibility timeout.",
      "Check ReceiveCount and processing time.",
    ],
    answer:
      "The likely cause is visibility timeout expiry. The first consumer received the message, but its work took longer than the timeout, so SQS made the message visible again and a second consumer received it. I would compare p99 processing time with the timeout, check ReceiveCount, and check whether the consumer extends the lease. I would also confirm that the handler deletes the message only after the side effect succeeds, and make the side effect idempotent.",
    followUps: [
      "What if the processing time is under the timeout?",
      "How does a consumer crash change the explanation?",
      "Where would you put the idempotency key?",
    ],
    redFlags: [
      "Assumes the queue delivered twice at random.",
      "Raises the timeout without checking processing time.",
      "Ignores idempotency.",
    ],
    rubric: [
      "Names visibility expiry as the cause.",
      "Cites processing time and ReceiveCount.",
      "Adds idempotency for the crash case.",
    ],
  },
  {
    id: "timeout-choice",
    question:
      "How do you choose a visibility timeout for a handler with a 2-minute p50 and a 9-minute p99?",
    difficulty: 3,
    hints: [
      "The timeout must exceed the slow path, not the median.",
      "A very long timeout slows recovery from crashes.",
    ],
    answer:
      "I would set the timeout above the p99, so at least 9 minutes, or use a shorter base timeout with ChangeMessageVisibility heartbeats during work. A fixed timeout above the p99 protects the slow path but leaves a crashed message invisible for that long. Heartbeats keep the lease tight while the process is alive and let the message return quickly after a crash. I would also add jitter and a maxReceiveCount so repeated failures reach a DLQ.",
    followUps: [
      "What timeout would you use if the work is highly variable?",
      "How do you monitor that the extension is working?",
      "What changes for a batch receive?",
    ],
    redFlags: [
      "Uses the p50.",
      "Sets the maximum timeout without discussing crash recovery.",
      "Extends visibility forever.",
    ],
    rubric: [
      "Uses p99 or heartbeat extension.",
      "Discusses crash recovery delay.",
      "Bounds retries with maxReceiveCount.",
    ],
  },
  {
    id: "dlq-role",
    question:
      "Does a DLQ prevent duplicate processing? What is its actual role?",
    difficulty: 2,
    hints: [
      "The DLQ receives messages after repeated receives.",
      "It does not shorten the visibility timeout.",
    ],
    answer:
      "A DLQ does not prevent duplicates. It moves a message aside after maxReceiveCount receives so a poison message stops consuming the main queue's capacity. Duplicates still happen whenever visibility expires or a consumer crashes before deleting. The DLQ gives you a bounded failure path, an alerting signal, and a place to inspect and replay after the bug is fixed. It needs an owner, retention, and a replay procedure to be useful.",
    followUps: [
      "What maxReceiveCount would you start with?",
      "How do you replay a DLQ safely?",
      "What if the DLQ itself fills up?",
    ],
    redFlags: [
      "Treats the DLQ as duplicate protection.",
      "Creates a DLQ with no alert.",
      "Replays without fixing the handler.",
    ],
    rubric: [
      "Separates redelivery from duplicate prevention.",
      "Describes maxReceiveCount and alerting.",
      "Names replay and ownership.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Visibility timeout is set above the p99 processing time or extended by a heartbeat.",
      "Handlers are idempotent on a business key with a defined retention window.",
      "ReceiveCount, oldest message age, and duplicate side effects are monitored.",
      "A redrive policy and DLQ owner are defined.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare processing time with the visibility timeout before changing the queue.",
      "Check whether duplicates or backlog are the user-visible problem.",
      "Stop extending visibility for work that is failing; let it retry or reach the DLQ.",
      "Protect the downstream service from retry and consumer fan-out.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify duplicate rate and oldest age at peak load.",
      "Replay the DLQ after the handler fix and reconcile side effects.",
      "Add a slow-handler test that exceeds the visibility timeout.",
    ],
  },
];

const references = [
  {
    title: "Amazon SQS visibility timeout",
    url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Visibility lease, ChangeMessageVisibility, and redelivery behavior.",
  },
  {
    title: "Amazon SQS dead-letter queues",
    url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "maxReceiveCount, redrive policy, and DLQ behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "sqs-visibility": {
      model: sqsVisibilityModel,
      presets,
      instructions:
        "Start healthy, apply Slow consumer, then run the experiment. Compare Heartbeat only and Recovery, and watch duplicates separately from oldest message age.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Processing times, consumer counts, and duplicate rates are teaching values, not SQS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-sqs-fifo", "streaming-consumer-groups", "streaming-dlq", "case-composite-visibility-timeout"],
};
