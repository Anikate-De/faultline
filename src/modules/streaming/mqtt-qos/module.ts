import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "publishRate",
    label: "Publish rate",
    min: 100,
    max: 5_000,
    step: 100,
    value: 1_000,
    unit: " msg/s",
    group: "Traffic",
    help: "Telemetry messages per second from the sensor fleet. One reading per publish.",
    format: "rps" as const,
  },
  {
    id: "qos",
    label: "Quality of service",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Delivery",
    help: "0 fire-and-forget, 1 at-least-once with acknowledgments, 2 exactly-once at the protocol level with a four-part handshake.",
    format: "count" as const,
  },
  {
    id: "ackLoss",
    label: "Acknowledgment loss",
    min: 0,
    max: 10,
    step: 0.1,
    value: 0.2,
    unit: "%",
    group: "Network",
    help: "Share of acknowledgment packets lost on the return path. A lost acknowledgment makes the publisher retry a message the broker already accepted.",
    format: "percent" as const,
  },
  {
    id: "brokerRestart",
    label: "Broker restart",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 restarts the broker for a 12-second window. QoS 0 messages published in that window are dropped with no retry.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  publishRate: number;
  qos: number;
  ackLoss: number;
  restart: boolean;
  outageSeconds: number;
  deliveryFailure: number;
  duplicates: number;
  latency: number;
  cpu: number;
  lostMessages: number;
  policy: string;
}

function compute(p: Params): Values {
  const publishRate = clamp(num(p, "publishRate", 1_000), 100, 5_000);
  const qos = clamp(Math.round(num(p, "qos", 1)), 0, 2);
  const ackLoss = clamp(num(p, "ackLoss", 0.2), 0, 10);
  const restart = num(p, "brokerRestart", 0) >= 1;
  const outageSeconds = restart ? 12 : 0;
  const deliveryFailure = qos === 0 ? (outageSeconds / 60) * 100 : 0;
  const duplicates = qos === 1 ? Math.min(100, ackLoss * 1.2 + (restart ? 3 : 0)) : 0;
  const latency = (qos === 0 ? 5 : qos === 1 ? 20 + ackLoss * 8 : 55 + ackLoss * 12) + (restart ? 15 : 0);
  const cpu = clamp(7 + publishRate / 55 + qos * 12 + (restart ? 10 : 0), 0, 100);
  return {
    publishRate,
    qos,
    ackLoss,
    restart,
    outageSeconds,
    deliveryFailure,
    duplicates,
    latency,
    cpu,
    lostMessages: Math.round(publishRate * outageSeconds * (qos === 0 ? 1 : 0)),
    policy: `QoS ${qos}`,
  };
}

function subscriberHealth(values: Values): "ok" | "warn" | "crit" {
  if (values.deliveryFailure >= 2 || values.duplicates >= 2) return "crit";
  if (values.duplicates >= 0.5 || values.cpu >= 70) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const subHealth = subscriberHealth(values);
  const brokerHealth = values.cpu >= 85 ? "crit" : values.restart || values.cpu >= 70 ? "warn" : "ok";
  const publisherHealth = values.restart ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "sensor",
        label: "Sensor publisher",
        kind: "service",
        health: publisherHealth,
        utilization: clamp(values.publishRate / 5_000),
        throughput: values.publishRate,
        sublabel: `${Math.round(values.publishRate).toLocaleString("en-US")} msg/s · ${values.policy}`,
        detail: `${values.policy} publishes at ${Math.round(values.publishRate).toLocaleString("en-US")} messages per second. Acknowledgment loss is ${values.ackLoss.toFixed(1)}%.`,
        meta: { view: "flow", qos: values.qos },
      },
      {
        id: "broker",
        label: "MQTT broker",
        kind: "stream",
        health: brokerHealth,
        utilization: values.cpu / 100,
        throughput: values.publishRate,
        sublabel: values.restart ? "restarting · sessions interrupted" : `${values.cpu.toFixed(0)}% CPU`,
        detail: values.restart
          ? `The broker restarts for ${values.outageSeconds} seconds. QoS 0 publishes during the outage have no retry; QoS 1 and 2 retry after reconnecting.`
          : "The broker acknowledges each QoS 1 PUBLISH with a PUBACK, and each QoS 2 PUBLISH with a four-part handshake. QoS 0 gets no acknowledgment.",
        meta: { view: "flow", cpu: values.cpu },
      },
      {
        id: "subscriber",
        label: "Telemetry consumer",
        kind: "worker",
        health: subHealth,
        utilization: clamp(values.duplicates / 5),
        throughput: values.publishRate * (1 - values.deliveryFailure / 100),
        sublabel: `${values.deliveryFailure.toFixed(1)}% lost · ${values.duplicates.toFixed(1)}% duplicate`,
        detail: `The consumer receives ${(values.deliveryFailure).toFixed(1)}% fewer messages than were published and sees ${values.duplicates.toFixed(1)}% duplicates. QoS 2 removes protocol duplicates, but the application can still repeat an effect after a crash.`,
        meta: { view: "flow", duplicates: values.duplicates },
      },
    ],
    edges: [
      edge("sensor-broker", "sensor", "broker", clamp(values.publishRate / 5_000), publisherHealth),
      edge("broker-subscriber", "broker", "subscriber", clamp(values.publishRate / 5_000), subHealth),
    ],
    metrics: [
      metric("delivery-failure", "Delivery failure", values.deliveryFailure, "%", 0.5, 2, "percent"),
      metric("duplicate-rate", "Duplicate deliveries", values.duplicates, "%", 0.5, 2, "percent"),
      metric("broker-cpu", "Broker CPU", values.cpu, "%", 70, 85, "percent"),
      metric("delivery-latency", "Delivery latency", values.latency, "ms", 120, 400, "ms"),
      metric("lost-messages", "Messages lost in outage", values.lostMessages, " messages", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, qos: values.qos, restart: values.restart ? 1 : 0 },
    summary: `${values.policy} at ${Math.round(values.publishRate).toLocaleString("en-US")} msg/s: ${values.deliveryFailure.toFixed(1)}% loss, ${values.duplicates.toFixed(1)}% duplicates, ${values.cpu.toFixed(0)}% broker CPU.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const base = (offset: number) => 0.98 + 0.03 * Math.sin((offset + (seed % 7)) / 2.3);
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "delivery-failure", Math.max(0, values.deliveryFailure * base(index)));
    recordSeries(frame, "duplicate-rate", Math.max(0, values.duplicates * base(index + 3)));
    recordSeries(frame, "broker-cpu", Math.max(0, values.cpu * base(index + 5)));
    recordSeries(frame, "delivery-latency", Math.max(0, values.latency * base(index + 1)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "delivery-failure",
    metricId: "delivery-failure",
    warn: 0.5,
    crit: 2,
    title: "Published telemetry is not reaching the consumer",
    cause:
      "QoS 0 gives the publisher no acknowledgment and keeps no copy for retry. A broker restart drops every publish in flight and every publish during the outage window, so the consumer silently sees a gap.",
    fix:
      "Move telemetry that matters to QoS 1 so the broker acknowledges and the client retries after reconnect. Keep QoS 0 only for readings where a missing sample is harmless and the newer sample replaces it.",
    checkFirst: [
      "Compare the publisher's send count with the subscriber's receive count per topic.",
      "Check broker restart and client reconnect events against the gap.",
      "Check whether the publisher uses QoS 0 because of bandwidth or because nobody chose a level.",
    ],
  },
  {
    id: "duplicate-rate",
    metricId: "duplicate-rate",
    warn: 0.5,
    crit: 2,
    title: "The consumer is processing duplicate telemetry",
    cause:
      "QoS 1 is at-least-once. If the PUBACK is lost, the publisher retransmits with the same packet identifier, and the broker delivers the message again. The protocol cannot tell a duplicate from a new reading at the application boundary.",
    fix:
      "Make the consumer idempotent on a reading identifier, or move to QoS 2 when the duplicate cost is higher than the handshake cost. Do not assume QoS 1 means once.",
    checkFirst: [
      "Check the duplicate rate against acknowledgment loss and reconnects.",
      "Check whether readings carry a device timestamp or sequence number.",
      "Check whether the duplicate has a side effect such as a billing increment.",
    ],
  },
  {
    id: "broker-cpu",
    metricId: "broker-cpu",
    warn: 70,
    crit: 85,
    title: "Broker CPU is saturated by delivery overhead",
    cause:
      "QoS 2 adds a PUBREC, PUBREL, and PUBCOMP exchange and stores packet identifiers per session. At high publish rates the broker spends more CPU on the handshake and on duplicate suppression than on moving payload.",
    fix:
      "Reserve QoS 2 for the small set of topics that need it, raise broker capacity, or reduce publish rate by batching readings. Measure the handshake cost before applying QoS 2 to the whole fleet.",
    checkFirst: [
      "Compare CPU per message across QoS levels.",
      "Check the number of connected clients and in-flight QoS 2 sessions.",
      "Check whether payload size or connection churn explains the CPU.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const mqttQosModel: SimModel = {
  id: "streaming-mqtt-qos",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    const values = compute(p);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.qos === 0 && values.restart && frame.flags.qosLossEvent !== 1) {
      pushEvent(next, {
        id: "qos0-restart-loss",
        at: frame.t,
        severity: "crit",
        title: "QoS 0 publishes dropped during broker restart",
        detail: `${values.lostMessages.toLocaleString("en-US")} messages published during the ${values.outageSeconds}-second outage have no acknowledgment and no retry.`,
        nodeId: "subscriber",
        metricId: "delivery-failure",
      });
      next.flags.qosLossEvent = 1;
    }
    next.flags.qos = values.qos;
    next.flags.restart = values.restart ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.qos === 0) {
      items.push("QoS 0 sends once. The publisher keeps no copy, so a restart or a dropped packet is an invisible gap.");
    } else if (values.qos === 1) {
      items.push("QoS 1 retries until the broker acknowledges. Delivery is at-least-once, so a lost acknowledgment becomes a duplicate.");
    } else {
      items.push("QoS 2 suppresses protocol duplicates with a four-part handshake. It still cannot make an application side effect atomic.");
    }
    items.push(
      `At ${Math.round(values.publishRate).toLocaleString("en-US")} msg/s, ${values.duplicates.toFixed(1)}% duplicates is ${Math.round((values.publishRate * values.duplicates) / 100).toLocaleString("en-US")} extra messages per second for the consumer to absorb.`,
    );
    if (values.restart) {
      items.push(
        `The restart lasts ${values.outageSeconds} seconds. QoS 0 loses that window; QoS 1 and 2 reconnect and retry, at the cost of latency and duplicate risk.`,
      );
    } else {
      items.push("Without a restart, QoS 0 looks perfect. That is why the delivery gap is easy to miss until a broker event.");
    }
    if (values.cpu >= 70) items.push("Broker CPU is above 70%. Check whether QoS 2 handshakes or connection churn is the cause before adding payload capacity.");
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
    description: "QoS 1 at 1k messages/s with almost no acknowledgment loss.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "QoS 2 at 2.4k messages/s. Delivery is exact at the protocol level, but the handshake costs CPU.",
    tone: "warn",
    params: defaults({ publishRate: 2_400, qos: 2, ackLoss: 1 }),
  },
  {
    id: "failure",
    label: "QoS 0 restart",
    description: "QoS 0 at 2.5k messages/s while the broker restarts for 12 seconds.",
    tone: "crit",
    params: defaults({ publishRate: 2_500, qos: 0, ackLoss: 3, brokerRestart: 1 }),
  },
  {
    id: "duplicates",
    label: "QoS 1 duplicates",
    description: "QoS 1 with 4% acknowledgment loss and a restart; retries create duplicate readings.",
    tone: "crit",
    params: defaults({ publishRate: 2_000, qos: 1, ackLoss: 4, brokerRestart: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "QoS 1, no restart, and a consumer that can absorb the retry volume.",
    tone: "ok",
    params: defaults({ publishRate: 2_500, qos: 1, ackLoss: 0.2, brokerRestart: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-qos-restart",
  title: "Predict what QoS 0 loses on restart",
  simId: "mqtt-qos",
  question:
    "A sensor fleet publishes 2k messages/s at QoS 0. The broker restarts for 12 seconds. What reaches the consumer?",
  prediction: {
    options: [
      { id: "nothing-lost", label: "Nothing is lost; the broker persists every publish before acknowledging" },
      { id: "outage-lost", label: "Messages published during the outage are lost and never retried" },
      { id: "all-retried", label: "Every message is retried until the consumer acknowledges" },
      { id: "exactly-once", label: "Messages are delivered exactly once because QoS 0 has no duplicates" },
    ],
    correctOptionId: "outage-lost",
    explanation:
      "QoS 0 is fire-and-forget. The publisher does not wait for an acknowledgment and keeps no copy, so publishes sent while the broker is down are gone. The subscriber sees a gap and has no protocol signal that it missed anything.",
  },
  setup: defaults({ publishRate: 2_000, qos: 0, ackLoss: 0, brokerRestart: 1 }),
  runFor: 20,
  observe: [
    "Delivery failure rises to the share of the observation window covered by the outage.",
    "The lost-message counter reports the publishes inside the outage window.",
    "QoS 1 with the same restart loses no messages, but duplicates rise when acknowledgments are lost.",
    "Broker CPU is lower at QoS 0 and higher at QoS 2; the guarantee is paid for on every message.",
  ],
  explain:
    "QoS 0 has one packet, no acknowledgment, and no retry. QoS 1 adds PUBACK and retries, which makes delivery at-least-once. QoS 2 adds PUBREC, PUBREL, and PUBCOMP with packet identifiers, so the broker and client can suppress duplicate delivery. The protocol guarantee ends at the MQTT session boundary: a consumer that writes to a database and crashes can still repeat the effect.",
  fix: defaults({ publishRate: 2_000, qos: 1, ackLoss: 0.2, brokerRestart: 1 }),
  debrief:
    "The fix moves the telemetry to QoS 1 and makes the consumer idempotent on the reading identifier. Loss falls to zero because unacknowledged publishes are retried. The cost is more packets, higher latency, and the need to deduplicate after a lost acknowledgment.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "MQTT is a publish-subscribe protocol built for constrained devices and unreliable networks. A sensor publishes to a topic through a broker, and subscribers receive matching messages. Quality of service (QoS) is the per-message contract for how hard the protocol tries to deliver a publish. It is not a property of the topic or the connection; the publisher chooses it on each message.",
  },
  {
    type: "p",
    text: "QoS 0 sends a PUBLISH packet once. There is no acknowledgment and no stored copy, so a lost packet or a broker restart becomes a silent gap. QoS 1 stores the message until the broker returns PUBACK, then retries with the same packet identifier if the acknowledgment is lost. That makes delivery at-least-once. QoS 2 adds a four-part handshake (PUBLISH, PUBREC, PUBREL, PUBCOMP) so neither side delivers the same protocol message twice.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is device, TCP or TLS connection, broker, subscriber session. QoS is negotiated per publish and per subscription, and the broker uses the lower of the two when it forwards. The packet identifier is scoped to the client session, so session state matters: a clean session discards in-flight QoS 1 and 2 messages and their identifiers.",
  },
  {
    type: "table",
    headers: ["Level", "Handshake", "Guarantee", "Typical cost"],
    rows: [
      ["QoS 0", "PUBLISH only", "At most once", "Lowest latency and overhead; gaps are invisible"],
      ["QoS 1", "PUBLISH, PUBACK, retry", "At least once", "Duplicates after a lost acknowledgment"],
      ["QoS 2", "PUBLISH, PUBREC, PUBREL, PUBCOMP", "Exactly once at the protocol level", "Extra round trips and broker state per in-flight message"],
    ],
  },
  {
    type: "p",
    text: "This module uses 1k to 5k messages/s and a 12-second broker restart. Those are illustrative teaching values. The failure shape is the lesson: the same outage is harmless at QoS 1 and destructive at QoS 0, while QoS 2 moves the cost to broker CPU and handshake latency.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Delivery failure: the share of published messages the subscriber never receives. Warning at 0.5%, critical at 2%.",
      "Duplicate deliveries: messages the subscriber sees more than once. Warning at 0.5%, critical at 2%.",
      "Broker CPU and delivery latency, which rise with the stronger handshake.",
      "Messages lost in outage: the count of publishes inside the restart window that had no retry.",
      "A flow view from sensor to broker to consumer, with the selected QoS on the publisher.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy. Run the experiment before touching the sliders: predict what the restart does at QoS 0. Then compare QoS 1 Duplicates, QoS 2 Peak, and Recovery. Watch loss and duplicates together; a level that removes one can increase the other.",
  },
  { type: "sim", simId: "mqtt-qos" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At QoS 0 the publisher sent 2k messages/s and never waited for an acknowledgment. When the broker restarted for 12 seconds, every publish in that window was dropped. Delivery failure settled near 20%, and the lost-message metric reported about 24k readings with no retry path. Nothing in the publisher's metrics showed an error, because QoS 0 has no error signal.",
  },
  {
    type: "p",
    text: "QoS 1 removed the loss: the client reconnected and retransmitted unacknowledged messages. The trade appeared as duplicate deliveries, because a lost PUBACK makes the publisher resend a message the broker already accepted. QoS 2 removed protocol duplicates but raised CPU and latency. At 4% acknowledgment loss, QoS 1 produced enough duplicates to matter to a billing or alerting consumer.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Publisher metrics: publish rate, PUBACK latency, retry count, and in-flight window. A rising retry count is the first sign of acknowledgment loss.",
      "Broker metrics: connected clients, session count, dropped messages, CPU, and per-topic message rate.",
      "Subscriber metrics: received rate versus expected rate, duplicate identifiers, and consumer lag.",
      "Broker logs: restart, session takeover, and keep-alive timeouts. Correlate the gap with the client reconnect.",
      "Device logs: reconnect backoff and local buffer depth. A device that buffers locally can hide broker loss until the buffer overflows.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare published and received counts per topic before changing anything. Check whether the gap lines up with a broker restart or reconnect. Then check duplicate rate: QoS 1 retries can turn a loss incident into a duplicate incident. Confirm the subscription QoS is not lower than the publish QoS.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify the topic: a missing reading is harmless, expensive, or safety-critical.",
      "Use QoS 0 only when the next reading replaces the missing one and no downstream total depends on it.",
      "Use QoS 1 for telemetry that must arrive, and make the consumer idempotent on a device sequence number or reading ID.",
      "Use QoS 2 only where duplicate protocol delivery is unacceptable and the broker can carry the handshake cost.",
      "Persist the session and the device's local buffer so a reconnect does not discard in-flight messages.",
      "Alert on the gap between publish and receive rates, not only on broker uptime.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "QoS 1 costs an acknowledgment and a retry path; it converts loss into duplicates.",
      "QoS 2 costs two extra round trips and broker state; it protects the protocol session, not your database write.",
      "Higher QoS raises latency, which matters for control loops that need the latest value quickly.",
      "Persistent sessions improve delivery but increase broker memory and reconnect time.",
      "Local device buffering hides broker outages until storage fills, then loses a larger batch.",
      "A deduplication key is required at the application boundary no matter which QoS you choose.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-qos",
    question:
      "A fleet publishes temperature readings every five seconds. A missed reading is tolerable, but a duplicate billing event is not. Which QoS do you choose and why?",
    difficulty: 2,
    hints: [
      "Separate the telemetry topic from the billing event.",
      "At-least-once moves the duplicate problem to the consumer.",
    ],
    answer:
      "I would split the topics. Temperature telemetry can stay at QoS 0 if the next reading replaces the missed one and no average depends on every sample; if the average matters, use QoS 1 and make the consumer idempotent on device and timestamp. The billing event needs either QoS 2 or, more realistically, QoS 1 plus an idempotency key in the billing service, because protocol exactly-once does not make a database write and a publish atomic. I would not apply QoS 2 to the whole fleet just to protect one topic.",
    followUps: [
      "What changes if the device has a local buffer?",
      "How do you deduplicate a reading that has no sequence number?",
      "What does the broker do when publish QoS is higher than subscription QoS?",
    ],
    redFlags: [
      "Chooses QoS 2 for everything without discussing cost.",
      "Claims QoS 1 is exactly-once.",
      "Ignores the application side effect.",
    ],
    rubric: [
      "Separates delivery guarantee from business effect.",
      "Names the cost of the chosen level.",
      "Describes an idempotency key or deduplication window.",
    ],
  },
  {
    id: "qos1-duplicates",
    question:
      "The broker shows one accepted message, but the consumer processed it twice at QoS 1. How is that possible?",
    difficulty: 3,
    hints: [
      "The publisher retries when PUBACK does not arrive.",
      "The broker may have received the first publish and lost only the acknowledgment.",
    ],
    answer:
      "QoS 1 is at-least-once, not exactly-once. The broker can accept and store the first PUBLISH, then the PUBACK is lost on the return path. The publisher's retry timer fires and it sends the same message again with the same packet identifier. The broker delivers it again, and the subscriber processes it again. The duplicate is a protocol-level retry, so the consumer must deduplicate on an application key or accept repeated effects.",
    followUps: [
      "Does QoS 2 eliminate this case entirely?",
      "What happens if the session is clean and the client reconnects?",
      "Where would you put the deduplication store?",
    ],
    redFlags: [
      "Blames the broker for delivering twice.",
      "Says QoS 1 guarantees one delivery.",
      "Suggests disabling retries without a delivery plan.",
    ],
    rubric: [
      "Explains the lost PUBACK path.",
      "States at-least-once explicitly.",
      "Names an application-level deduplication control.",
    ],
  },
  {
    id: "qos2-cost",
    question:
      "Why not run every topic at QoS 2 if it is the strongest guarantee?",
    difficulty: 3,
    hints: [
      "Count the round trips and the per-session state.",
      "Exactly-once at the protocol layer is not exactly-once end to end.",
    ],
    answer:
      "QoS 2 adds two round trips per message and requires the broker and client to track packet identifiers and session state until the handshake completes. At fleet scale that costs CPU, memory, and latency, and it reduces the publish rate a broker can sustain. It also stops at the MQTT session: if the subscriber writes to a database and crashes before committing, the effect can repeat on redelivery. I would reserve QoS 2 for the small set of topics where a duplicate protocol delivery is unacceptable and use idempotent consumers elsewhere.",
    followUps: [
      "Which metric would show the CPU cost first?",
      "How does a clean session interact with QoS 2 state?",
      "When is QoS 2 still the right choice?",
    ],
    redFlags: [
      "Treats QoS 2 as end-to-end exactly-once.",
      "Ignores broker capacity.",
      "Cannot name the handshake packets.",
    ],
    rubric: [
      "Names the four-part handshake and its cost.",
      "Separates protocol from application effects.",
      "Gives a criterion for using QoS 2 selectively.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every topic has a documented QoS choice tied to the cost of a missing or duplicate message.",
      "Dashboards compare publish rate with receive rate per topic and show retry and duplicate counts.",
      "Consumer idempotency keys exist for every QoS 1 topic with a side effect.",
      "Broker restart and session-expiry behavior is tested with a real reconnect.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the gap aligns with a broker restart, network loss, or a subscription QoS downgrade.",
      "Check duplicate rate before replaying or retrying messages manually.",
      "Protect the downstream store with bounded concurrency while the backlog drains.",
      "Record the topic, QoS, session settings, and reconnect timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify delivery and duplicate rates at peak, not only at steady state.",
      "Add a broker-restart test to the device and consumer test suite.",
      "Document the remaining guarantee and the application deduplication window.",
    ],
  },
];

const references = [
  {
    title: "MQTT Version 5.0 specification",
    url: "https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html",
    publisher: "OASIS",
    kind: "standard" as const,
    note: "Quality of service levels, packet identifiers, and session state.",
  },
  {
    title: "MQTT essentials: quality of service levels",
    url: "https://www.hivemq.com/blog/mqtt-essentials-part-6-mqtt-quality-of-service-levels/",
    publisher: "HiveMQ",
    kind: "docs" as const,
    note: "QoS 0, 1, and 2 packet flows and the at-least-once duplicate case.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mqtt-qos": {
      model: mqttQosModel,
      presets,
      instructions:
        "Start healthy, run the experiment, then compare QoS 0 Restart, QoS 1 Duplicates, QoS 2 Peak, and Recovery. Watch delivery failure and duplicate rate together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Publish rates, outage length, and CPU values are teaching values, not MQTT benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-mqtt-retained",
    "streaming-mqtt-fanout",
    "streaming-mqtt-broker-scaling",
    "foundations-idempotency",
  ],
};
