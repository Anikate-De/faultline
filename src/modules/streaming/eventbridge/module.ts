import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "eventsPerSec",
    label: "Event rate",
    min: 100,
    max: 10_000,
    step: 100,
    value: 500,
    unit: " events/s",
    group: "Traffic",
    help: "Events published by the order service. Each matched rule and subscription creates its own delivery.",
    format: "rps" as const,
  },
  {
    id: "subscriptions",
    label: "SNS subscriptions",
    min: 1,
    max: 8,
    step: 1,
    value: 3,
    unit: "",
    group: "SNS",
    help: "Endpoints subscribed to the topic. SNS writes one copy per subscription, with no pattern filtering.",
    format: "count" as const,
  },
  {
    id: "ruleBreadth",
    label: "Rule pattern breadth",
    min: 1,
    max: 100,
    step: 1,
    value: 10,
    unit: "%",
    group: "EventBridge",
    help: "How much of the event space a rule pattern matches. A broad source-only pattern catches event types its target never expected.",
    format: "percent" as const,
  },
  {
    id: "targetCapacity",
    label: "Target capacity",
    min: 100,
    max: 5_000,
    step: 100,
    value: 2_000,
    unit: " /s",
    group: "Targets",
    help: "Deliveries per second one target can absorb before latency rises and retries begin.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  events: number;
  subscriptions: number;
  breadth: number;
  capacity: number;
  matchedRules: number;
  broadRules: number;
  deliveries: number;
  perTarget: number;
  util: number;
  unintended: number;
  latency: number;
  retries: number;
}

function compute(p: Params): Values {
  const events = Math.round(clamp(num(p, "eventsPerSec", 500), 100, 10_000));
  const subscriptions = Math.round(clamp(num(p, "subscriptions", 3), 1, 8));
  const breadth = Math.round(clamp(num(p, "ruleBreadth", 10), 1, 100));
  const capacity = Math.round(clamp(num(p, "targetCapacity", 2_000), 100, 5_000));
  const matchedRules = Math.max(1, Math.ceil(breadth / 20));
  const broadRules = breadth > 60 ? matchedRules - 1 : 0;
  const deliveries = events * (subscriptions + matchedRules);
  const perTarget = events * (1 + broadRules);
  const util = (perTarget / capacity) * 100;
  const unintended = broadRules * 7.5;
  const latency = 20 + perTarget / capacity * 120 + (util > 100 ? 400 : 0);
  const retries = util > 100 ? Math.min(100, (util - 100) / 4) : 0;
  return {
    events,
    subscriptions,
    breadth,
    capacity,
    matchedRules,
    broadRules,
    deliveries,
    perTarget,
    util,
    unintended,
    latency,
    retries,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const targetHealth = values.util >= 85 ? "crit" : values.util >= 70 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "publisher",
        label: "Orders service",
        kind: "service",
        health: "ok",
        utilization: clamp(values.events / 10_000),
        throughput: values.events,
        sublabel: `${values.events.toLocaleString("en-US")} events/s`,
        detail: "The order service emits order, refund, and shipment events. Routing decisions determine which targets receive each type.",
        meta: { view: "flow" },
      },
      {
        id: "sns",
        label: "SNS topic",
        kind: "stream",
        health: values.retries > 0 ? "warn" : "ok",
        utilization: clamp(values.events * values.subscriptions / 20_000),
        throughput: values.events * values.subscriptions,
        capacity: 10_000,
        sublabel: `${values.subscriptions} subscriptions`,
        detail: `SNS sends one copy per subscription, with no content filtering in this model. ${values.subscriptions} subscriptions produce ${(values.events * values.subscriptions).toLocaleString("en-US")} deliveries/s.`,
        meta: { view: "flow" },
      },
      {
        id: "bus",
        label: "EventBridge bus",
        kind: "stream",
        health: values.breadth > 60 ? "warn" : "ok",
        utilization: values.breadth / 100,
        throughput: values.events * values.matchedRules,
        capacity: 20_000,
        sublabel: `${values.matchedRules} matching rules · ${values.breadth}% breadth`,
        detail: `${values.matchedRules} rule(s) match each event. ${values.broadRules > 0 ? `${values.broadRules} broad rule(s) also match event types their targets were not designed for.` : "Patterns are narrow enough to avoid unintended matches."}`,
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Downstream targets",
        kind: "worker",
        health: targetHealth,
        utilization: clamp(values.util / 100),
        throughput: values.perTarget,
        capacity: values.capacity,
        sublabel: `${values.util.toFixed(0)}% of target capacity`,
        detail: `Each target receives ${Math.round(values.perTarget).toLocaleString("en-US")} deliveries/s against ${values.capacity.toLocaleString("en-US")}/s capacity. Unintended matches add ${values.unintended.toFixed(1)}% duplicate side effects and ${values.retries.toFixed(0)}% retry load.`,
        meta: { view: "flow", unintended: values.unintended },
      },
    ],
    edges: [
      edge("publisher-sns", "publisher", "sns", clamp(values.events / 10_000), "ok"),
      edge("publisher-bus", "publisher", "bus", clamp(values.events / 10_000), values.breadth > 60 ? "warn" : "ok"),
      edge("sns-targets", "sns", "targets", clamp(values.util / 100), targetHealth),
      edge("bus-targets", "bus", "targets", clamp(values.util / 100), targetHealth),
    ],
    metrics: [
      metric("unintended-matches", "Unintended matches", values.unintended, "%", 0.5, 2, "percent"),
      metric("target-util", "Target utilization", values.util, "%", 70, 85, "percent"),
      metric("delivery-latency", "Delivery latency", values.latency, "ms", 200, 1_000, "ms"),
      metric("fanout-copies", "Deliveries", values.deliveries, " /s", undefined, undefined, "rps"),
      metric("retry-load", "Retry load", values.retries, "%", 1, 5, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, breadth: values.breadth, subscriptions: values.subscriptions },
    summary: `${values.deliveries.toLocaleString("en-US")} deliveries/s from ${values.events.toLocaleString("en-US")} events/s; ${values.unintended.toFixed(1)}% unintended matches and ${values.util.toFixed(0)}% target utilization.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "unintended-matches", Math.max(0, values.unintended * (0.96 + 0.04 * Math.sin(index / 2.2))));
    recordSeries(frame, "target-util", Math.max(0, values.util * (0.98 + 0.02 * Math.sin(index / 2.6))));
    recordSeries(frame, "delivery-latency", Math.max(0, values.latency * (0.97 + 0.03 * Math.sin(index / 1.9))));
    recordSeries(frame, "fanout-copies", Math.max(0, values.deliveries * (0.99 + 0.01 * Math.sin(index / 3.1))));
    recordSeries(frame, "retry-load", Math.max(0, values.retries * (0.95 + 0.05 * Math.sin(index / 2.4))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unintended-matches",
    metricId: "unintended-matches",
    warn: 0.5,
    crit: 2,
    title: "Events are reaching consumers that did not ask for them",
    cause:
      "The rule pattern is broader than the event types the target expects. A source-only pattern matches every detail type on that source, so a new event type silently triggers existing targets and their side effects.",
    fix:
      "Narrow the pattern with detail-type and the fields the target actually consumes. Give each consumer its own rule or subscription rather than sharing one broad route.",
    checkFirst: [
      "Read the event pattern against the new event's source and detail-type.",
      "List every rule and subscription that matches, including disabled owners and test targets.",
      "Check whether the target's side effect is idempotent for the unexpected event type.",
    ],
  },
  {
    id: "target-util",
    metricId: "target-util",
    warn: 70,
    crit: 85,
    title: "A downstream target is saturated by routing volume",
    cause:
      "Deliveries multiply with subscriptions and matching rules. A high event rate plus several matches exceeds the target's capacity even when the publisher's rate looks normal.",
    fix:
      "Bound fan-out with narrower patterns and fewer subscriptions per event, or raise target capacity. Check retries, which add load to an already saturated target.",
    checkFirst: [
      "Multiply event rate by subscriptions and matching rules.",
      "Check target concurrency, queue depth, and retry rate.",
      "Check whether a broad rule is sending events the target discards after processing.",
    ],
  },
  {
    id: "delivery-latency",
    metricId: "delivery-latency",
    warn: 200,
    crit: 1_000,
    title: "Event delivery latency exceeds the consumer budget",
    cause:
      "SNS and EventBridge retry when a target is slow or returns an error. Retries plus the original delivery increase load, so latency grows faster than the event rate.",
    fix:
      "Reduce unintended matches, add target capacity, and configure a dead-letter queue with a bounded retry policy. Do not let a slow target absorb retries indefinitely.",
    checkFirst: [
      "Check target response time and error rate.",
      "Check delivery attempts per event, not only event count.",
      "Check whether one broad rule is fanning out to a slow consumer.",
    ],
  },
  {
    id: "retry-load",
    metricId: "retry-load",
    warn: 1,
    crit: 5,
    title: "Retries are amplifying the routing load",
    cause:
      "A saturated target returns errors or times out, so the bus retries. Each retry is another delivery, and a broad rule multiplies the effect across targets.",
    fix:
      "Add a DLQ and retry limit, reduce fan-out, and fix the target's capacity before raising retries. Alert on delivery attempts per event.",
    checkFirst: [
      "Check retry rate and DLQ depth.",
      "Check whether retries target the same slow consumer.",
      "Check the retry policy and maximum event age.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const eventBridgeModel: SimModel = {
  id: "streaming-eventbridge",
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
      `${values.events.toLocaleString("en-US")} events/s become ${values.deliveries.toLocaleString("en-US")} deliveries/s across ${values.subscriptions} SNS subscriptions and ${values.matchedRules} matching rules.`,
    );
    items.push(
      values.breadth > 60
        ? `A ${values.breadth}% broad pattern matches event types the target never expected. That is hidden coupling, not fan-out.`
        : "The pattern is narrow enough that matching rules correspond to the event types the target consumes.",
    );
    items.push("SNS is a topic subscription: every subscription receives every message. EventBridge is rule matching: a target receives only events whose pattern matches, so pattern design is the routing contract.");
    if (values.util > 85) items.push("The target is over its capacity. Narrowing patterns is cheaper than scaling a consumer that is processing events it should never have received.");
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
    description: "Narrow rules at 500 events/s; each target receives only its event type.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "1.5k events/s with four subscriptions and a moderately broad rule; target utilization warns.",
    tone: "warn",
    params: defaults({ eventsPerSec: 1_500, subscriptions: 4, ruleBreadth: 40, targetCapacity: 2_000 }),
  },
  {
    id: "failure",
    label: "Broad rule",
    description: "A 90% broad pattern at 3k events/s sends refunds and shipments to three order targets.",
    tone: "crit",
    params: defaults({ eventsPerSec: 3_000, subscriptions: 6, ruleBreadth: 90, targetCapacity: 1_500 }),
  },
  {
    id: "narrow",
    label: "Narrow the rule",
    description: "The rule now matches only the intended detail type; target load drops sharply.",
    tone: "ok",
    params: defaults({ eventsPerSec: 3_000, subscriptions: 3, ruleBreadth: 10, targetCapacity: 5_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Narrow rules, bounded subscriptions, and enough target capacity for peak.",
    tone: "ok",
    params: defaults({ eventsPerSec: 3_000, subscriptions: 2, ruleBreadth: 10, targetCapacity: 5_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-broad-rule",
  title: "Predict what a broad rule catches",
  simId: "eventbridge",
  question:
    "An EventBridge rule matches `source: orders` and sends to the fulfillment target. The team adds refund events with the same source. What does the fulfillment target receive?",
  prediction: {
    options: [
      { id: "nothing", label: "Nothing; the rule excludes event types it does not know" },
      { id: "refunds", label: "Refund events too, because the source matches and the pattern does not name detail-type" },
      { id: "dlq", label: "Only failed refunds, which go to the DLQ" },
      { id: "once", label: "One copy total because EventBridge deduplicates by source" },
    ],
    correctOptionId: "refunds",
    explanation:
      "EventBridge matches the fields in the pattern. A pattern with only source matches every event from that source, including new detail types. The fulfillment target receives refunds and processes them as if they were orders. That is hidden coupling created by an under-specified rule.",
  },
  setup: defaults({ eventsPerSec: 3_000, subscriptions: 6, ruleBreadth: 90, targetCapacity: 1_500 }),
  runFor: 20,
  observe: [
    "Unintended matches rise with pattern breadth, not with the number of rules alone.",
    "Target utilization includes deliveries the target discards after processing.",
    "Narrowing to the intended detail-type drops both load and duplicate side effects.",
    "SNS subscriptions have no rule match; every subscriber gets every message.",
  ],
  explain:
    "SNS fan-out and EventBridge matching solve different problems. SNS sends every publish to every subscription; the subscriber cannot filter by content in this model. EventBridge evaluates each rule's event pattern and invokes only matching targets. A broad pattern is a routing decision that every future event must satisfy, so it silently enrolls new event types in old consumers.",
  fix: defaults({ eventsPerSec: 3_000, subscriptions: 2, ruleBreadth: 10, targetCapacity: 5_000 }),
  debrief:
    "The fix narrows the pattern to the order detail-type and removes subscriptions the event does not need. Deliveries fall and the target returns to headroom. The cost is that each new event type must now be routed explicitly, which is the point: routing is a contract, not a side effect of sharing a source.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Simple Notification Service (SNS) is a publish-subscribe topic. Every subscription receives a copy of every message published to the topic. Amazon EventBridge is an event bus with rules: each rule has an event pattern, and a target is invoked only when an event matches. SNS fans out by subscription; EventBridge routes by content and structure.",
  },
  {
    type: "p",
    text: "Both multiply deliveries. SNS multiplies by subscription count. EventBridge multiplies by the number of matching rules and targets. A broad pattern does not just route more traffic; it enrolls future event types into an existing consumer. That is hidden coupling, and it is easy to miss because the new producer sees a successful publish.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer, topic or bus, rule or subscription, target. SNS has no pattern matching in the basic model: the subscription is the routing decision. EventBridge evaluates the event against each rule's pattern, so the pattern is the contract. A target can be a Lambda function, a queue, a Step Functions state machine, or another bus.",
  },
  {
    type: "table",
    headers: ["Mechanism", "Who receives", "Routing cost", "Failure shape"],
    rows: [
      ["SNS subscription", "Every subscriber", "One copy per subscription", "Fan-out grows with subscribers"],
      ["EventBridge narrow rule", "Only pattern matches", "One delivery per matching target", "New event types are ignored until routed"],
      ["EventBridge broad rule", "Every event from a source", "One delivery per matching target", "Unintended consumers and duplicate side effects"],
      ["Multiple matching rules", "Every rule's target", "Deliveries multiply", "A single event triggers several workflows"],
    ],
  },
  {
    type: "p",
    text: "This module uses 100 to 10k events/s and up to eight subscriptions. Those are illustrative teaching values. The shape of the failure is the lesson: an under-specified pattern sends events to targets that process them without understanding them.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unintended matches: the share of events reaching a target that did not expect that event type. Warning at 0.5%, critical at 2%.",
      "Target utilization and delivery latency, which rise with every extra match.",
      "Deliveries per second across SNS subscriptions and EventBridge rules.",
      "Retry load, which amplifies a saturated target.",
      "A flow view from the orders service through SNS and the bus to downstream targets.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, apply Broad rule, and run the experiment before editing the pattern. Compare Narrow the rule with Recovery, and watch unintended matches separately from target utilization.",
  },
  { type: "sim", simId: "eventbridge" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The broad rule matched every event from the orders source. Three thousand events/s became thousands of deliveries across six subscriptions and several rules. The fulfillment target received refunds and shipments, processed them, and produced side effects for events it was never designed to handle. Target utilization went critical before the publisher saw any error.",
  },
  {
    type: "p",
    text: "Narrowing the pattern to the intended detail type and removing unnecessary subscriptions cut deliveries sharply. The target returned to headroom. The trade is explicit routing: every new event type needs its own rule and owner. That is better than a shared source silently enrolling old consumers in new behavior.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "EventBridge metrics: MatchedEvents, Invocations, FailedInvocations, and delivery latency per rule.",
      "SNS metrics: NumberOfMessagesPublished, NumberOfNotificationsDelivered, and delivery failures per subscription.",
      "Target metrics: invocation count, error rate, queue depth, and duplicate side effects.",
      "Rule and subscription inventory, including owners and last-modified time.",
      "Retry and DLQ depth, which reveal a slow target before the publisher notices.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the event pattern against the new event's source and detail-type. List every rule and subscription that matches. Check whether the target's side effect is safe for the unexpected event. Then compare target utilization with event rate times matches.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory rules and subscriptions by owner, pattern, and target.",
      "Narrow patterns with detail-type and the fields the target consumes.",
      "Remove subscriptions the event does not need; do not use one topic for unrelated event types.",
      "Make targets idempotent and validate the event type before side effects.",
      "Add a DLQ and bounded retry policy for targets that fall behind.",
      "Require a routing review when a new event type is added to an existing source.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "SNS fan-out is simple but sends every message to every subscriber.",
      "Narrow EventBridge rules reduce unintended coupling but require explicit routing for each new event type.",
      "More rules increase delivery count and the number of owners to track.",
      "A shared bus improves discoverability but makes hidden consumers easier to create.",
      "Retries protect delivery but amplify load on a target that is already saturated.",
      "Content filtering reduces fan-out but adds pattern maintenance and testing work.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "sns-vs-eb",
    question:
      "When would you choose SNS over EventBridge, and when the reverse?",
    difficulty: 2,
    hints: [
      "SNS sends every message to every subscription.",
      "EventBridge matches rules by event content.",
    ],
    answer:
      "I would use SNS when every subscriber needs every message and the routing decision is the subscription itself, such as a notification fan-out to email, SMS, and a queue. I would use EventBridge when consumers should receive only specific event types and the pattern is part of the contract, such as order events routed to fulfillment but not refunds. SNS is simpler fan-out; EventBridge is content-based routing with more rules and owners to manage.",
    followUps: [
      "How does ordering differ between the two?",
      "What happens when a new event type is added?",
      "How would you bound fan-out in each?",
    ],
    redFlags: [
      "Treats the two as interchangeable.",
      "Uses SNS for content filtering.",
      "Ignores rule ownership.",
    ],
    rubric: [
      "States the SNS copy-per-subscription model.",
      "States EventBridge pattern matching.",
      "Gives a concrete routing choice.",
    ],
  },
  {
    id: "broad-pattern",
    question:
      "A new event type starts triggering an existing consumer. The producer changed nothing about its routing. What happened?",
    difficulty: 3,
    hints: [
      "Check the rule pattern, not the producer.",
      "A source-only pattern matches every detail type.",
    ],
    answer:
      "The existing rule pattern was broader than the event types the consumer expected, likely matching only source. The new event has the same source, so it matched and the consumer was invoked. The producer did not change routing; it added an event type inside an already broad contract. I would narrow the pattern with detail-type and required fields, audit other broad rules, and make the consumer validate the event type before side effects.",
    followUps: [
      "How would you find every affected consumer?",
      "Should the consumer or the rule enforce the type?",
      "How do you roll out the narrowed pattern safely?",
    ],
    redFlags: [
      "Blames the producer.",
      "Adds a filter in code without fixing the rule.",
      "Does not audit other rules.",
    ],
    rubric: [
      "Identifies the broad pattern.",
      "Explains source matching.",
      "Narrows the rule and validates in the consumer.",
    ],
  },
  {
    id: "fanout-bound",
    question:
      "An event bus delivers 20k events/s and downstream targets are timing out. How do you bound the fan-out?",
    difficulty: 3,
    hints: [
      "Count matching rules and subscriptions per event.",
      "Retries multiply the load.",
    ],
    answer:
      "I would compute deliveries as event rate times matching rules and subscriptions, then look for broad patterns and duplicate routes. I would narrow patterns, remove subscriptions that do not need the event, and route each consumer through its own rule. I would also bound retries with a DLQ and check target capacity. Adding targets without reducing matches preserves the same total delivery work.",
    followUps: [
      "Which metric shows the match multiplier?",
      "How would you find duplicate routes?",
      "What is the first change during an active incident?",
    ],
    redFlags: [
      "Scales targets without reducing matches.",
      "Ignores retries.",
      "Cannot estimate deliveries per event.",
    ],
    rubric: [
      "Multiplies rate by matches.",
      "Narrows patterns and removes routes.",
      "Bounds retries and checks capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every rule and subscription has an owner, a pattern, and a documented event contract.",
      "Deliveries per second are estimated from event rate times matches.",
      "Targets validate event type and are idempotent.",
      "Retry policies and DLQs are configured for every target.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "List every rule and subscription matching the event before changing the producer.",
      "Check whether the target is processing events it should ignore.",
      "Check retry load and target utilization together.",
      "Narrow the pattern or disable the unintended route.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Audit broad patterns and unused subscriptions.",
      "Verify delivery volume and latency at peak.",
      "Add a routing review for new event types on shared sources.",
    ],
  },
];

const references = [
  {
    title: "Amazon EventBridge event patterns",
    url: "https://docs.aws.amazon.com/eventbridge/latest/userguide/eb-event-patterns.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Pattern matching by source, detail-type, and event fields.",
  },
  {
    title: "Amazon SNS: how publish-subscribe works",
    url: "https://docs.aws.amazon.com/sns/latest/dg/sns-how-it-works.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Topics, subscriptions, and one copy per subscribed endpoint.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    eventbridge: {
      model: eventBridgeModel,
      presets,
      instructions:
        "Start healthy, apply Broad rule, then run the experiment. Compare Narrow the rule and Recovery, and watch unintended matches, target utilization, and retry load.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Event rates, subscription counts, and target capacity are teaching values, not AWS quotas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-keys-ordering", "streaming-outbox", "streaming-cdc"],
};
