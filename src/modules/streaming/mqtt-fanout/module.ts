import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "subscribers",
    label: "Subscribers",
    min: 100,
    max: 50_000,
    step: 100,
    value: 1_000,
    unit: "",
    group: "Subscribers",
    help: "Clients subscribed to the telemetry topic. Each independent subscriber receives its own copy of every publish.",
    format: "count" as const,
  },
  {
    id: "publishRate",
    label: "Publish rate",
    min: 1,
    max: 50,
    step: 1,
    value: 5,
    unit: " msg/s",
    group: "Traffic",
    help: "Telemetry messages per second on the topic. Each one is copied to every independent subscriber.",
    format: "rps" as const,
  },
  {
    id: "payloadKb",
    label: "Payload size",
    min: 1,
    max: 64,
    step: 1,
    value: 1,
    unit: " KB",
    group: "Traffic",
    help: "Payload size per message. Larger payloads cost more broker bandwidth and serialization time per copy.",
    format: "bytes" as const,
  },
  {
    id: "brokers",
    label: "Broker count",
    min: 1,
    max: 8,
    step: 1,
    value: 2,
    unit: "",
    group: "Cluster",
    help: "Brokers sharing the subscriber load. Without shared state or bridging, a client stays on one broker and the cluster does not split a topic's fan-out by itself.",
    format: "count" as const,
  },
  {
    id: "shared",
    label: "Shared subscription",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Design",
    help: "1 puts workers in one shared subscription group so each message goes to one member instead of every subscriber. Dashboards must stay on independent subscriptions.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  subscribers: number;
  publishRate: number;
  payloadKb: number;
  brokers: number;
  shared: boolean;
  copies: number;
  perBroker: number;
  cpu: number;
  latency: number;
  dropped: number;
}

function compute(p: Params): Values {
  const subscribers = Math.round(clamp(num(p, "subscribers", 1_000), 100, 50_000));
  const publishRate = Math.round(clamp(num(p, "publishRate", 5), 1, 50));
  const payloadKb = Math.round(clamp(num(p, "payloadKb", 1), 1, 64));
  const brokers = Math.round(clamp(num(p, "brokers", 2), 1, 8));
  const shared = num(p, "shared", 0) >= 1;
  const copies = publishRate * (shared ? 1 : subscribers);
  const perBroker = copies / brokers;
  const cpu = clamp((perBroker / 100_000) * 100, 0, 100);
  const latency = 8 + payloadKb * 1.5 + cpu * 1.5 + (shared ? 0 : Math.min(60, subscribers / 1_000));
  const dropped = cpu >= 100 ? Math.min(100, (perBroker / 100_000 - 1) * 30) : 0;
  return { subscribers, publishRate, payloadKb, brokers, shared, copies, perBroker, cpu, latency, dropped };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const brokerHealth = values.cpu >= 85 ? "crit" : values.cpu >= 70 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "publisher",
        label: "Telemetry publisher",
        kind: "service",
        health: "ok",
        utilization: clamp(values.publishRate / 50),
        throughput: values.publishRate,
        sublabel: `${values.publishRate} msg/s · ${values.payloadKb} KB`,
        detail: `The publisher sends ${values.publishRate} messages per second. Fan-out cost is measured in copies, not publishes: ${values.copies.toLocaleString("en-US")} deliveries per second.`,
        meta: { view: "flow" },
      },
      {
        id: "broker",
        label: values.brokers === 1 ? "MQTT broker" : `MQTT cluster (${values.brokers})`,
        kind: "stream",
        health: brokerHealth,
        utilization: values.cpu / 100,
        throughput: values.copies,
        capacity: values.brokers * 100_000,
        sublabel: `${values.cpu.toFixed(0)}% CPU · ${Math.round(values.perBroker).toLocaleString("en-US")} copies/s each`,
        detail: `${values.copies.toLocaleString("en-US")} copies per second split across ${values.brokers} brokers. ${values.shared ? "A shared subscription delivers each message to one worker in the group." : "Every independent subscriber gets its own copy of every publish."}`,
        meta: { view: "flow" },
      },
      {
        id: "subscribers",
        label: values.shared ? "Worker group" : "Subscriber fleet",
        kind: "worker",
        health: values.dropped > 0 ? "crit" : brokerHealth,
        utilization: clamp(values.cpu / 100),
        throughput: values.copies * (1 - values.dropped / 100),
        sublabel: `${values.subscribers.toLocaleString("en-US")} clients · ${values.dropped.toFixed(1)}% dropped`,
        detail: `The subscriber side receives ${Math.round(values.copies * (1 - values.dropped / 100)).toLocaleString("en-US")} deliveries per second. Delivery latency is ${values.latency.toFixed(0)} ms; ${values.dropped.toFixed(1)}% of copies are dropped when the broker is over capacity.`,
        meta: { view: "flow", dropped: values.dropped },
      },
    ],
    edges: [
      edge("publisher-broker", "publisher", "broker", clamp(values.publishRate / 50), "ok"),
      edge("broker-subscribers", "broker", "subscribers", clamp(values.cpu / 100), brokerHealth),
    ],
    metrics: [
      metric("broker-cpu", "Broker CPU", values.cpu, "%", 70, 85, "percent"),
      metric("fanout-copies", "Fan-out copies", values.copies, " /s", undefined, undefined, "rps"),
      metric("delivery-latency", "Delivery latency", values.latency, "ms", 200, 1_000, "ms"),
      metric("dropped-deliveries", "Dropped deliveries", values.dropped, "%", 0.1, 1, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, brokers: values.brokers, shared: values.shared ? 1 : 0 },
    summary: `${values.copies.toLocaleString("en-US")} copies/s across ${values.brokers} broker(s); ${values.cpu.toFixed(0)}% CPU and ${values.dropped.toFixed(1)}% dropped deliveries.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "broker-cpu", Math.max(0, values.cpu * (0.98 + 0.02 * Math.sin(index / 2.2))));
    recordSeries(frame, "fanout-copies", Math.max(0, values.copies * (0.99 + 0.01 * Math.sin(index / 3))));
    recordSeries(frame, "delivery-latency", Math.max(0, values.latency * (0.97 + 0.03 * Math.sin(index / 1.8))));
    recordSeries(frame, "dropped-deliveries", Math.max(0, values.dropped * (0.9 + 0.1 * Math.sin(index / 2))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "broker-cpu",
    metricId: "broker-cpu",
    warn: 70,
    crit: 85,
    title: "Broker CPU is saturated by fan-out",
    cause:
      "Every independent subscriber costs one delivery per publish. The broker serializes, copies, and writes each one, so subscriber count multiplies load even when the publish rate is flat.",
    fix:
      "Reduce copies with shared subscriptions for workers, split topics so clients subscribe only to what they need, or add brokers behind a design that actually distributes the topic. A load balancer alone does not split an existing subscriber set.",
    checkFirst: [
      "Compute copies per second as publish rate times independent subscribers.",
      "Check whether all subscribers need every message or only a subset does.",
      "Check whether workers can join a shared subscription group without losing required order.",
    ],
  },
  {
    id: "delivery-latency",
    metricId: "delivery-latency",
    warn: 200,
    crit: 1_000,
    title: "Fan-out latency exceeds the telemetry budget",
    cause:
      "Serialization and per-copy queueing grow with payload size and subscriber count. The broker falls behind, so even messages that are delivered arrive later than the dashboard or control loop expects.",
    fix:
      "Shrink payloads, split high-rate topics from high-cardinality topics, and move workers to shared subscriptions. Measure latency at the subscriber, not only inside the broker.",
    checkFirst: [
      "Compare publish time with receive time at a sample subscriber.",
      "Check payload size and serialization cost per copy.",
      "Check whether one topic serves both dashboards and high-volume workers.",
    ],
  },
  {
    id: "dropped-deliveries",
    metricId: "dropped-deliveries",
    warn: 0.1,
    crit: 1,
    title: "The broker is dropping deliveries",
    cause:
      "When broker CPU or egress is exhausted, the broker sheds subscriber writes. Dropped deliveries are silent gaps for the affected clients, and QoS 1 retries can add load to an already saturated broker.",
    fix:
      "Cut fan-out before adding retries. Move workers to shared subscriptions, shard topics, or add brokers with a state-sharing design. Treat dropped deliveries as a capacity incident, not a client bug.",
    checkFirst: [
      "Check broker CPU, egress, and per-topic subscriber count.",
      "Check whether drops cluster on one broker or one subscriber group.",
      "Check whether retries are amplifying the load.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const mqttFanoutModel: SimModel = {
  id: "streaming-mqtt-fanout",
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
    items.push(
      `${values.publishRate} publishes/s times ${values.subscribers.toLocaleString("en-US")} subscribers is ${values.copies.toLocaleString("en-US")} copies/s. Publisher rate is not the fan-out cost.`,
    );
    items.push(
      values.shared
        ? "A shared subscription sends each message to one member of the group, which cuts copies to one per group."
        : "Independent subscriptions copy every message to every client; that is the broker-bound part of MQTT fan-out.",
    );
    items.push(
      `Per broker, the cluster handles ${Math.round(values.perBroker).toLocaleString("en-US")} copies/s at ${values.cpu.toFixed(0)}% CPU. ${values.brokers === 1 ? "One broker is the whole ceiling." : "Brokers only help if clients and sessions are distributed across them."}`,
    );
    if (values.dropped > 0) items.push("Dropped deliveries are already happening. Adding QoS retries now would increase the load on a saturated broker.");
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
    description: "1k subscribers at 5 messages/s across two brokers, with headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "30k subscribers and an 8 KB payload across four brokers; CPU is near the warning line.",
    tone: "warn",
    params: defaults({ subscribers: 30_000, publishRate: 10, payloadKb: 8, brokers: 4 }),
  },
  {
    id: "failure",
    label: "50k subscribers",
    description: "One topic, 50k independent subscribers, 10 messages/s, and two brokers.",
    tone: "crit",
    params: defaults({ subscribers: 50_000, publishRate: 10, payloadKb: 1, brokers: 2 }),
  },
  {
    id: "recovery",
    label: "Add brokers",
    description: "The same 50k subscribers spread across eight brokers with headroom.",
    tone: "ok",
    params: defaults({ subscribers: 50_000, publishRate: 10, payloadKb: 1, brokers: 8 }),
  },
  {
    id: "shared",
    label: "Shared workers",
    description: "Workers join one shared subscription, so each message is delivered once to the group.",
    tone: "ok",
    params: defaults({ subscribers: 50_000, publishRate: 10, payloadKb: 1, brokers: 2, shared: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-fanout-fix",
  title: "Predict what fixes a 50k-subscriber topic",
  simId: "mqtt-fanout",
  question:
    "A topic has 50k independent subscribers, publishes 10 messages/s, and one broker is at 100% CPU. Which change reduces the broker's per-second work the most?",
  prediction: {
    options: [
      { id: "add-brokers", label: "Add brokers and reconnect subscribers across them" },
      { id: "shared", label: "Put worker subscribers in a shared subscription group" },
      { id: "qos", label: "Raise the subscription QoS from 0 to 2" },
      { id: "payload", label: "Compress the payload without changing subscribers" },
    ],
    correctOptionId: "shared",
    explanation:
      "The broker's dominant cost is one delivery per subscriber per publish. A shared subscription group delivers each message to one member, collapsing 50k copies to one per group. More brokers spread the same copies and require clients to reconnect, while raising QoS adds handshake work and compression only reduces bytes, not the number of deliveries.",
  },
  setup: defaults({ subscribers: 50_000, publishRate: 10, payloadKb: 1, brokers: 2, shared: 0 }),
  runFor: 20,
  observe: [
    "Fan-out copies per second sit at publish rate times subscriber count.",
    "CPU rises with copies, not with publisher rate.",
    "A shared subscription cuts copies to one delivery per group.",
    "Adding brokers divides per-broker copies, but the total delivery work stays the same.",
  ],
  explain:
    "Fan-out is the cost of delivering one publish to many clients. MQTT brokers copy per independent subscription. Shared subscriptions are a delivery-group mechanism: one message goes to one member, which is right for workers and wrong for dashboards that each need the value. Bridging and clustering spread the work, but they do not remove the per-subscriber copy.",
  fix: defaults({ subscribers: 50_000, publishRate: 10, payloadKb: 1, brokers: 2, shared: 1 }),
  debrief:
    "The fix puts workers in a shared group and keeps dashboards on independent subscriptions. Copies fall from 500k/s to 10/s for the worker path, and broker CPU returns to headroom. The trade is that a shared group delivers each message to one worker, so per-worker order and retry behavior must be designed deliberately.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Fan-out is one publish delivered to many subscribers. In MQTT the broker owns that work: it matches a topic against every subscription and writes a copy to each connected client. If 50k clients subscribe independently, one 10-message/s topic becomes 500k deliveries per second, before retries. The publisher is not the bottleneck; the broker's copy, serialization, and socket work is.",
  },
  {
    type: "p",
    text: "There are three levers. A shared subscription puts workers in a group and delivers each message to one member, which is right when any worker can do the job. Topic design narrows subscriptions so clients receive only what they need. Broker clustering or bridging spreads connections and copies across machines, but only when clients and session state are actually distributed.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is publisher, broker, topic tree, subscriber connections. The topic tree narrows the candidate set, but the broker still writes one copy per matching independent subscription. A bridge forwards messages between brokers; it does not automatically split one topic's subscriber set. A load balancer distributes new connections, and existing clients stay where they connected until they reconnect.",
  },
  {
    type: "table",
    headers: ["Lever", "What it changes", "What it costs"],
    rows: [
      ["Shared subscription", "One delivery per group instead of per member", "Only one worker sees each message; per-message order is per group"],
      ["Topic tree split", "Fewer subscribers match each publish", "Producers and clients must agree on a narrower topic scheme"],
      ["Add brokers", "Divides connections and copies across machines", "Clients reconnect; session and retained state must be shared"],
      ["Smaller payload", "Less bandwidth and serialization per copy", "Does not reduce the number of deliveries"],
    ],
  },
  {
    type: "p",
    text: "This module uses 100 to 50k subscribers, 1 to 50 messages/s, and one to eight brokers. Those are illustrative teaching values, not broker limits. The shape of the failure is the lesson: copies grow with subscribers, CPU follows copies, and latency and drops arrive together.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Broker CPU: the cost of copying and serializing each delivery. Warning at 70%, critical at 85%.",
      "Fan-out copies per second: publish rate multiplied by independent subscriber count.",
      "Delivery latency and dropped deliveries, which rise once the broker is over capacity.",
      "A flow view with the publisher, the broker cluster, and the subscriber fleet.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply 50k subscribers. Run the experiment before changing the sliders. Compare Add brokers with Shared workers, and watch copies per second rather than publisher rate.",
  },
  { type: "sim", simId: "mqtt-fanout" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 50k independent subscribers and 10 publishes/s, the broker had to produce 500k deliveries per second. Two brokers carried 250k copies each and saturated. Publisher rate stayed at 10 messages/s the whole time, which is why a dashboard of inbound publishes looked normal while subscribers saw rising latency and dropped messages.",
  },
  {
    type: "p",
    text: "Adding brokers divided the copy work, but only after subscribers reconnected across the cluster. The shared subscription cut the worker path to one delivery per group and left CPU with headroom. It also changed semantics: one worker gets each message, so a worker failure means the group must redeliver rather than every member having its own copy.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Broker metrics: CPU, egress bytes, connected clients, subscriptions per topic, and dropped messages.",
      "Per-topic subscriber counts and delivery rate; copies per second is the number that tracks cost.",
      "Client-side receive latency and reconnect rate, especially after a broker or load-balancer change.",
      "Network egress and connection counts per broker, which reveal uneven client distribution.",
      "Shared subscription group size and per-member delivery, which reveal a group that is too small or too large.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute copies per second before adding brokers. Check whether every subscriber truly needs every message. Check whether workers can share a group and whether dashboards must remain independent. Then check whether clients are evenly distributed across brokers.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Separate state topics for dashboards from work topics for workers.",
      "Put homogeneous workers in a shared subscription group and size the group to the work rate.",
      "Narrow topic trees so clients subscribe to the data they use, not the whole fleet.",
      "Reduce payload size and publish frequency where the freshness budget allows.",
      "Distribute connections across brokers with shared session state and a tested reconnect plan.",
      "Alert on copies per second, broker CPU, and dropped deliveries before latency reaches users.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Shared subscriptions cut copies but remove the guarantee that every worker sees every message.",
      "More brokers add capacity but require session sharing and a reconnect strategy.",
      "Narrow topics reduce fan-out but increase the number of topics and subscriptions to manage.",
      "Lower QoS reduces handshake cost but weakens delivery guarantees.",
      "Payload compression saves bandwidth but adds CPU per copy and does not reduce delivery count.",
      "Bridging improves locality but creates duplicate paths and ordering questions if not bounded.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "fanout-cost",
    question:
      "A topic publishes 10 messages/s and has 50k subscribers. The broker is at 100% CPU. Where did the load come from, and what do you measure first?",
    difficulty: 3,
    hints: [
      "Count deliveries, not publishes.",
      "Check whether every subscriber is independent or in a shared group.",
    ],
    answer:
      "The broker is producing 500k deliveries per second, one per independent subscriber per publish. I would measure copies per second, connected subscribers per topic, CPU per delivery, payload size, and dropped messages. Then I would check how many subscribers actually need every message. Workers that can share work should move to a shared subscription; dashboards that each need the latest value stay independent. Adding brokers is a capacity move, not a fan-out reduction.",
    followUps: [
      "How does QoS affect the cost per copy?",
      "What happens to shared subscriptions when a worker dies?",
      "How would you split a topic without breaking clients?",
    ],
    redFlags: [
      "Adds brokers without examining subscriber count.",
      "Confuses publish rate with delivery rate.",
      "Moves every subscriber to a shared group.",
    ],
    rubric: [
      "Computes copies as rate times subscribers.",
      "Separates worker and dashboard semantics.",
      "Names a measurement and a reduction lever.",
    ],
  },
  {
    id: "shared-subscription",
    question:
      "When is a shared subscription the wrong design for MQTT fan-out?",
    difficulty: 3,
    hints: [
      "A shared group delivers each message to one member.",
      "Some clients need the latest value independently.",
    ],
    answer:
      "A shared subscription is wrong when every client must see every message, such as independent dashboards, audit consumers, or per-tenant state views. It is also risky when the work requires strict global order: group delivery gives one member each message, so a failover can reorder or redeliver. Shared groups fit homogeneous workers doing interchangeable jobs. For per-entity order, the topic or group key must keep that entity on one member.",
    followUps: [
      "How would you preserve per-device order with shared workers?",
      "What does a shared group do when its only member disconnects?",
      "How do you size a shared group?",
    ],
    redFlags: [
      "Uses shared subscriptions for dashboards.",
      "Assumes every member gets every message.",
      "Ignores ordering during failover.",
    ],
    rubric: [
      "States one-delivery-per-group semantics.",
      "Names workloads that need independent copies.",
      "Connects group design to ordering.",
    ],
  },
  {
    id: "broker-add",
    question:
      "You add a broker to an MQTT cluster, but CPU on the original broker barely moves. Why?",
    difficulty: 3,
    hints: [
      "Existing clients stay on their connected broker.",
      "A load balancer affects new connections, not established sessions.",
    ],
    answer:
      "The existing subscribers are still connected to the original broker. A load balancer only chooses a broker for a new connection, and MQTT sessions are broker-local unless the cluster shares session state. The topic's fan-out stays where the clients are. I would verify connection distribution, then plan a reconnect or rolling restart with session persistence, and check whether a bridge is forwarding the topic at all.",
    followUps: [
      "What breaks when clients reconnect to a new broker?",
      "How does retained state affect the move?",
      "Would a bridge reduce or increase total copies?",
    ],
    redFlags: [
      "Assumes adding a broker rebalances live connections.",
      "Ignores session state.",
      "Bridges without checking duplicate delivery.",
    ],
    rubric: [
      "Explains connection affinity.",
      "Names session state as the constraint.",
      "Proposes a controlled reconnect or bridge plan.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Per-topic subscriber counts and copies per second are on the dashboard.",
      "Worker topics use shared subscriptions with a documented group key.",
      "Broker CPU, egress, and dropped deliveries have alerts tied to subscriber growth.",
      "A reconnect plan exists for adding or draining a broker.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compute copies per second before adding capacity.",
      "Check whether payload size or subscriber count changed most recently.",
      "Move homogeneous workers to a shared group before raising QoS or retries.",
      "Protect dashboards from worker retry storms with separate topics.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify latency and dropped deliveries at the new subscriber peak.",
      "Document the shared-group semantics and failure behavior.",
      "Load-test a broker loss with the real subscriber distribution.",
    ],
  },
];

const references = [
  {
    title: "MQTT Version 5.0 specification: shared subscriptions",
    url: "https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html",
    publisher: "OASIS",
    kind: "standard" as const,
    note: "Shared subscription syntax and delivery semantics.",
  },
  {
    title: "EMQX documentation: MQTT shared subscriptions",
    url: "https://docs.emqx.com/en/emqx/latest/messaging/mqtt-shared-subscription.html",
    publisher: "EMQX",
    kind: "docs" as const,
    note: "Shared subscription groups, load balancing, and failover behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mqtt-fanout": {
      model: mqttFanoutModel,
      presets,
      instructions:
        "Start healthy, apply 50k subscribers, then run the experiment. Compare Add brokers with Shared workers and watch copies per second, CPU, latency, and drops.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Subscriber counts, CPU capacity, and latency are teaching values, not broker benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-mqtt-broker-scaling", "streaming-mqtt-qos", "streaming-mqtt-retained"],
};
