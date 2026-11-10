import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "publishInterval",
    label: "Publish interval",
    min: 5,
    max: 600,
    step: 5,
    value: 30,
    unit: " s",
    group: "Publisher",
    help: "Time between telemetry publishes on the topic. After a retained value, this is also how stale the state becomes.",
    format: "ms" as const,
  },
  {
    id: "retained",
    label: "Retain last value",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Broker",
    help: "1 stores the last message per topic and sends it immediately to every new subscriber. 0 sends nothing until the next publish.",
    format: "count" as const,
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
    help: "1 restarts the broker and clears its in-memory retained store. Retained messages return only after the publisher sends again.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  interval: number;
  retained: boolean;
  restart: boolean;
  firstValueDelay: number;
  stateAge: number;
  hasState: boolean;
  memory: number;
  retainedStore: number;
  stateLost: number;
}

function compute(p: Params): Values {
  const interval = clamp(num(p, "publishInterval", 30), 5, 600);
  const retained = num(p, "retained", 1) >= 1;
  const restart = num(p, "brokerRestart", 0) >= 1;
  const hasState = retained && !restart;
  const firstValueDelay = hasState ? 0.2 : interval;
  const stateAge = hasState ? interval / 2 : 0;
  return {
    interval,
    retained,
    restart,
    firstValueDelay,
    stateAge,
    hasState,
    memory: 35 + (retained ? 8 : 0) + (restart ? 12 : 0),
    retainedStore: retained ? 1 : 0,
    stateLost: restart ? 100 : 0,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const dashboardHealth = values.firstValueDelay >= 60 ? "crit" : values.firstValueDelay >= 10 ? "warn" : "ok";
  const brokerHealth = values.restart ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "publisher",
        label: "Sensor publisher",
        kind: "service",
        health: "ok",
        utilization: clamp(10 / values.interval),
        throughput: 1 / values.interval,
        sublabel: `one reading every ${values.interval}s`,
        detail: `The sensor publishes a new reading every ${values.interval} seconds. Retained messages rely on this publisher sending at least once after a restart.`,
        meta: { view: "flow" },
      },
      {
        id: "broker",
        label: "MQTT broker",
        kind: "stream",
        health: brokerHealth,
        utilization: values.restart ? 0.75 : 0.3,
        throughput: 1 / values.interval,
        sublabel: values.restart ? "restarted · retained store empty" : values.retained ? "retained value stored" : "no retained value",
        detail: values.restart
          ? "An in-memory retained store is lost on restart. Clients that subscribe before the next publish get no state."
          : values.retained
            ? "The broker keeps the last message and its QoS for each topic, and sends it on every new subscription."
            : "Without retain, the broker forwards only new publishes. A subscriber that joins between publishes sees nothing.",
        meta: { view: "flow", hasState: values.hasState ? 1 : 0 },
      },
      {
        id: "dashboard",
        label: "Dashboard subscriber",
        kind: "worker",
        health: dashboardHealth,
        utilization: clamp(values.firstValueDelay / 120),
        throughput: 1 / values.interval,
        sublabel: values.hasState ? "state on connect" : `${values.firstValueDelay}s blank`,
        detail: values.hasState
          ? `The dashboard receives the retained value immediately. The value is about ${values.stateAge.toFixed(0)} seconds old on average and is replaced by the next publish.`
          : `The dashboard waits ${values.firstValueDelay} seconds for the next publish. Until then it has no value and cannot distinguish "unknown" from "zero".`,
        meta: { view: "flow", delay: values.firstValueDelay },
      },
    ],
    edges: [
      edge("publisher-broker", "publisher", "broker", clamp(1 / values.interval), "ok"),
      edge("broker-dashboard", "broker", "dashboard", values.hasState ? 1 : clamp(1 / values.interval), dashboardHealth),
    ],
    metrics: [
      metric("first-value-delay", "Time to first value", values.firstValueDelay, " s", 10, 60, "ms"),
      metric("state-age", "Retained state age", values.stateAge, " s", 60, 300, "ms"),
      metric("broker-memory", "Broker memory", values.memory, "%", 70, 85, "percent"),
      metric("retained-store", "Retained topics", values.retainedStore, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, retained: values.retained ? 1 : 0, restart: values.restart ? 1 : 0 },
    summary: values.hasState
      ? `New subscribers get the last value immediately; it is about ${values.stateAge.toFixed(0)} seconds old.`
      : `New subscribers wait up to ${values.interval} seconds for the next publish; the dashboard is blank until then.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "first-value-delay", Math.max(0, values.firstValueDelay * (0.97 + 0.03 * Math.sin(index / 2.4))));
    recordSeries(frame, "state-age", Math.max(0, values.stateAge * (0.98 + 0.02 * Math.sin(index / 2))));
    recordSeries(frame, "broker-memory", Math.max(0, values.memory * (0.99 + 0.01 * Math.sin(index / 2.8))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "first-value-delay",
    metricId: "first-value-delay",
    warn: 10,
    crit: 60,
    title: "A new subscriber has no value until the next publish",
    cause:
      "The publisher did not set the retain flag, or the broker restarted and lost its in-memory retained store. MQTT only forwards new publishes, so a subscriber that connects between publishes has no state.",
    fix:
      "Publish state topics with retain set, and size the publish interval to the freshness the dashboard needs. Make the client show unknown rather than a fabricated zero while it waits.",
    checkFirst: [
      "Check the retain flag on the publisher for that topic.",
      "Check whether the broker restarted and cleared retained state.",
      "Compare the publish interval with the dashboard's acceptable staleness.",
    ],
  },
  {
    id: "state-age",
    metricId: "state-age",
    warn: 60,
    crit: 300,
    title: "The retained value is older than the freshness budget",
    cause:
      "A retained message is the last value, not a guarantee that the publisher is alive. If the sensor stops publishing, the broker keeps serving the old value to every new subscriber.",
    fix:
      "Attach a timestamp or sequence number to the value, alert when the age exceeds the budget, and clear the retained message when the device is decommissioned. Do not treat a retained value as a liveness signal.",
    checkFirst: [
      "Check the age of the retained value against the publish interval.",
      "Check whether the publisher is still connected and publishing.",
      "Check whether the dashboard displays the value timestamp.",
    ],
  },
  {
    id: "broker-memory",
    metricId: "broker-memory",
    warn: 70,
    crit: 85,
    title: "Retained state is consuming broker memory",
    cause:
      "One retained message per topic is small, but a topic per device or per metric multiplies quickly. High-cardinality retained topics keep payloads and metadata in memory for every subscriber.",
    fix:
      "Bound retained topics to state, not event history. Use a compact payload, expire retained messages where the protocol supports it, and monitor the retained topic count.",
    checkFirst: [
      "Count retained topics and their payload sizes.",
      "Check whether every device creates a unique retained topic.",
      "Check whether retained messages are published for high-frequency event streams.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const mqttRetainedModel: SimModel = {
  id: "streaming-mqtt-retained",
  visual: "flow",
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
    if (values.hasState) {
      items.push("A new subscriber receives the retained value immediately; it does not wait for the next publish.");
    } else {
      items.push(`A new subscriber waits up to ${values.interval} seconds for the next publish. Until then the dashboard has no value.`);
    }
    items.push("A retained message is a last value per topic, not a queue and not a history. Two subscribers see the same value, and the broker keeps only the newest.");
    if (values.restart) {
      items.push("An in-memory retained store is lost on restart. The value returns only after the publisher sends again.");
    } else {
      items.push(`The retained value is replaced every ${values.interval} seconds. If the publisher stops, the old value stays and looks current.`);
    }
    if (values.retained) items.push("Retained state scales with topic cardinality: one value per topic, not one per subscriber.");
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
    description: "Retained state with a 30-second publish interval; a reconnecting dashboard has a value immediately.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Stale but present",
    description: "Retained state with a two-minute interval; the dashboard has a value but it is at the freshness limit.",
    tone: "warn",
    params: defaults({ publishInterval: 120 }),
  },
  {
    id: "failure",
    label: "No retained value",
    description: "No retain flag and a five-minute publish interval; a reconnecting dashboard is blank.",
    tone: "crit",
    params: defaults({ publishInterval: 300, retained: 0 }),
  },
  {
    id: "restart",
    label: "Restart clears state",
    description: "Retain is on, but an in-memory broker restart wipes the last value until the next publish.",
    tone: "crit",
    params: defaults({ publishInterval: 180, retained: 1, brokerRestart: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Retain enabled with a short interval, and a dashboard that shows the value timestamp.",
    tone: "ok",
    params: defaults({ publishInterval: 30, retained: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-retained-connect",
  title: "Predict what a reconnecting dashboard sees",
  simId: "mqtt-retained",
  question:
    "A dashboard connects 10 seconds after the last telemetry publish. The topic has retain off and publishes every five minutes. What is on screen?",
  prediction: {
    options: [
      { id: "last-value", label: "The last value, because the broker holds it for new subscribers" },
      { id: "blank", label: "No value until the next publish, which can be almost five minutes away" },
      { id: "zero", label: "Zero, because the broker sends an empty retained message" },
      { id: "queued", label: "All messages since the last connection, replayed in order" },
    ],
    correctOptionId: "blank",
    explanation:
      "Without the retain flag, the broker forwards only new publishes. A subscriber that connects between publishes receives nothing. It is not queued and it is not zero; the client simply has no state, and the screen stays blank until the publisher sends again.",
  },
  setup: defaults({ publishInterval: 300, retained: 0 }),
  runFor: 20,
  observe: [
    "Time to first value equals the remaining wait for the next publish.",
    "The broker shows no retained value for the topic.",
    "With retain on, the same connect gets a value in about a second.",
    "The retained value has an age; it is not proof that the sensor is alive.",
  ],
  explain:
    "A retained message is the last message on a topic, stored by the broker and delivered on subscribe. It is per topic, not per subscriber, and the broker replaces it on every retained publish. It trades broker memory for immediate state. If the broker restarts without persistence, or the publisher stops, the state disappears or goes stale.",
  fix: defaults({ publishInterval: 60, retained: 1 }),
  debrief:
    "The fix sets retain on the state topic and shortens the publish interval. A new dashboard gets a value immediately and shows its timestamp. The remaining risk is a stale value after a publisher outage, which the timestamp and age alert expose.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "MQTT retained messages are a per-topic last-value store. When a publisher sets the retain flag, the broker keeps that message and sends it to every future subscriber of the topic, then replaces it with the next retained publish. A subscriber that connects between publishes gets the current state instead of waiting, and a dashboard can render immediately after a reconnect.",
  },
  {
    type: "p",
    text: "Retained is not a queue and not a history. The broker keeps one message per topic, not a backlog per subscriber. It does not replay the last ten readings. A retained message also has no built-in liveness meaning: if the sensor stops publishing, the broker keeps serving the old value, and every new client sees a value that may be hours old.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is publisher, broker, subscriber. The retain flag is set on the PUBLISH packet and stored with the topic. On SUBSCRIBE, the broker sends the retained message with the retain flag set so the client knows it is state rather than a live event. The message still has a QoS; a retained QoS 1 message is delivered with the same at-least-once behavior as a live one.",
  },
  {
    type: "compare",
    leftTitle: "Retained message",
    rightTitle: "Queued message",
    rows: [
      { label: "Scope", left: "One per topic", right: "One backlog per subscriber or queue" },
      { label: "Delivery", left: "On every new subscription", right: "When the consumer polls or receives" },
      { label: "History", left: "Only the newest value", right: "Every pending message" },
      { label: "Lifetime", left: "Until replaced, cleared, or broker restart", right: "Until acknowledged or retention expires" },
    ],
  },
  {
    type: "p",
    text: "This module uses a 5-second to 10-minute publish interval and a single retained topic. Those are illustrative teaching values. The shape of the failure is the lesson: the broker has no state to send, so the subscriber's first value arrives only when the publisher next speaks.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to first value: how long a new subscriber waits before it has any reading. Warning at 10 seconds, critical at 60.",
      "Retained state age: the age of the value served on subscribe. Warning at 60 seconds, critical at 5 minutes.",
      "Broker memory and retained topic count, which grow with topic cardinality rather than subscriber count.",
      "A flow view from publisher to broker to dashboard, with the retained store state on the broker.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply No retained value and watch the dashboard wait. Run the experiment before changing the retain flag. Compare Restart clears state with Recovery, and check the state age as well as the delay.",
  },
  { type: "sim", simId: "mqtt-retained" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With retain off, the broker held nothing for the topic. The dashboard connected 10 seconds after the last publish and received no message; time to first value matched the remaining five-minute interval. The screen was blank, and the client could not tell an empty topic from a healthy sensor that had not spoken yet.",
  },
  {
    type: "p",
    text: "With retain on, the broker sent the stored value immediately and the dashboard rendered in under a second. The value was not new: its age was half the publish interval on average. When the broker restarted, the in-memory store was cleared and the next subscriber was blank again until the publisher sent a retained message.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Broker metrics: retained message count, retained store size, and memory. A jump in retained topics often follows a new per-device topic scheme.",
      "Subscriber logs: subscribe acknowledged, first message received, and the time between them.",
      "Publisher metrics: publish interval, retain flag, and last successful publish per topic.",
      "Dashboard behavior: blank tiles, null versus zero handling, and the displayed value timestamp.",
      "Broker restart events correlated with a wave of blank dashboards.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the retain flag on the publisher before touching the dashboard. Then check whether the broker restarted and cleared retained state. Compare the publish interval with the freshness the screen needs, and confirm the client shows unknown rather than zero while it waits.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Publish current-state topics with retain set and a compact payload that includes a timestamp.",
      "Keep event streams unretained; retain state, not history.",
      "Size the publish interval to the screen's freshness budget, and alert when the value age exceeds it.",
      "Use a broker configuration that persists retained state if a restart must not blank the fleet.",
      "Clear retained messages when a device is decommissioned so the topic does not serve a dead value.",
      "Show unknown explicitly in the client until the first value arrives.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Retained state buys immediate rendering at the cost of broker memory per topic.",
      "A high-cardinality topic scheme multiplies retained storage and makes broker memory a capacity concern.",
      "A retained value makes staleness invisible unless the payload carries a timestamp.",
      "Persisting retained state across restarts adds durability work to the broker.",
      "Clearing retained state prevents dead values but creates a blank screen until the next publish.",
      "Retained messages do not replace a queue when the consumer must process every event.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "retained-vs-queue",
    question:
      "A teammate says to use retained messages so the analytics consumer can catch up after an hour offline. What is wrong with that plan?",
    difficulty: 2,
    hints: [
      "Retained keeps one message per topic.",
      "A consumer that was offline needs every event, not the newest value.",
    ],
    answer:
      "Retained messages keep only the newest message per topic and send it on subscribe. They do not queue every event for an offline consumer. If analytics needs all events, it needs a durable subscription or a queue with retention. Retained is right for current state, such as the latest device reading or configuration, not for a history the consumer must replay.",
    followUps: [
      "When is a durable session the right mechanism?",
      "What happens to retained messages when the topic is cleared?",
      "How would you keep a last-value view and a full event stream?",
    ],
    redFlags: [
      "Treats retained as a queue.",
      "Assumes every message is kept.",
      "Ignores the consumer's replay requirement.",
    ],
    rubric: [
      "Distinguishes last value from history.",
      "Names durable subscription or queue as the alternative.",
      "Gives a correct use for retained state.",
    ],
  },
  {
    id: "retained-stale",
    question:
      "A dashboard shows 21 degrees for six hours. The sensor died at midnight. Why did nobody notice?",
    difficulty: 3,
    hints: [
      "The broker keeps the last retained value.",
      "A value without a timestamp looks current.",
    ],
    answer:
      "The broker kept the last retained value and served it to every new subscriber, so the dashboard looked healthy. Nothing in the retained payload said when it was produced, and no alert watched the age of the last publish. I would add a timestamp and sequence number to the payload, alert when the age exceeds the publish interval, and show the value age in the UI. Retained state is a cache of the last value, not a liveness signal.",
    followUps: [
      "How would you clear the retained value when the device is retired?",
      "Which metric catches this before a user does?",
      "Should the broker or the dashboard compute the age?",
    ],
    redFlags: [
      "Blames the dashboard only.",
      "Adds a heartbeat topic but no alert.",
      "Assumes retained state expires automatically.",
    ],
    rubric: [
      "Explains retained state outliving the publisher.",
      "Adds a timestamp and an age alert.",
      "Separates state freshness from device liveness.",
    ],
  },
  {
    id: "retained-cardinality",
    question:
      "Retained messages are enabled for one topic per device, and broker memory keeps growing. What do you check?",
    difficulty: 3,
    hints: [
      "One retained message per topic, not per subscriber.",
      "Retired devices and high-frequency topics can leave state behind.",
    ],
    answer:
      "I would count retained topics, payload sizes, and the share tied to devices that no longer publish. A per-device topic scheme grows with the fleet, and decommissioned devices leave retained values behind. I would also check whether high-frequency event topics were accidentally retained. The fix is to retain only compact state topics, clear retained messages on decommission, and alert on retained count and memory growth.",
    followUps: [
      "How would you find topics with no publisher?",
      "What payload fields make retained state cheap?",
      "Would you expire retained messages?",
    ],
    redFlags: [
      "Adds broker memory without finding the topics.",
      "Retains event streams.",
      "Has no decommission path.",
    ],
    rubric: [
      "Connects topic cardinality to memory.",
      "Names retired devices and event topics as causes.",
      "Proposes a bound and a cleanup path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Current-state topics are documented and published with retain set.",
      "Retained payloads include a timestamp or sequence number.",
      "Broker retained-topic count and memory are monitored.",
      "The client renders unknown explicitly until the first value arrives.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the retain flag and the last publish time before changing the dashboard.",
      "Check whether a broker restart cleared retained state.",
      "Check whether the displayed value is old rather than missing.",
      "Keep event consumers on durable subscriptions, not retained state.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Clear retained state for retired devices and unused topics.",
      "Add an age alert tied to the publish interval.",
      "Test a broker restart and a cold subscriber connect in staging.",
    ],
  },
];

const references = [
  {
    title: "MQTT Version 5.0 specification: retained messages",
    url: "https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html",
    publisher: "OASIS",
    kind: "standard" as const,
    note: "Retain flag, retained message storage, and delivery on subscribe.",
  },
  {
    title: "MQTT essentials: retained messages",
    url: "https://www.hivemq.com/blog/mqtt-essentials-part-8-retained-messages/",
    publisher: "HiveMQ",
    kind: "docs" as const,
    note: "Last-value behavior, clearing retained messages, and common uses.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mqtt-retained": {
      model: mqttRetainedModel,
      presets,
      instructions:
        "Start healthy, then apply No retained value. Run the experiment, compare Restart clears state, and finish with Recovery. Watch time to first value and state age.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Intervals, memory, and delay values are teaching values, not broker benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-mqtt-qos", "streaming-mqtt-fanout", "streaming-mqtt-broker-scaling"],
};
