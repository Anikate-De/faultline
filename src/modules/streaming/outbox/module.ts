import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "writeRate",
    label: "Order writes",
    min: 10,
    max: 5_000,
    step: 10,
    value: 1_000,
    unit: " /s",
    group: "Database",
    help: "Transactions per second that change an order and should produce one event.",
    format: "rps" as const,
  },
  {
    id: "useOutbox",
    label: "Transactional outbox",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Design",
    help: "1 writes the event row in the same transaction as the order change. 0 publishes to Kafka from the application after the commit, a dual write.",
    format: "count" as const,
  },
  {
    id: "publishFailure",
    label: "Publish failure",
    min: 0,
    max: 50,
    step: 1,
    value: 2,
    unit: "%",
    group: "Failure",
    help: "Share of broker publishes that fail because of a timeout, throttle, or outage. With a dual write, the database has already committed.",
    format: "percent" as const,
  },
  {
    id: "pollInterval",
    label: "Publisher poll interval",
    min: 10,
    max: 5_000,
    step: 10,
    value: 200,
    unit: " ms",
    group: "Publisher",
    help: "How often the outbox publisher claims a batch. Longer intervals add latency; shorter intervals add query load.",
    format: "ms" as const,
  },
  {
    id: "batchSize",
    label: "Batch size",
    min: 10,
    max: 1_000,
    step: 10,
    value: 500,
    unit: " events",
    group: "Publisher",
    help: "Events claimed per poll. Publisher capacity is batch size divided by poll interval.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  writeRate: number;
  outbox: boolean;
  failure: number;
  pollInterval: number;
  batchSize: number;
  publisherCapacity: number;
  lostRate: number;
  depth: number;
  publishLag: number;
  publisherUtil: number;
}

function compute(p: Params, depth: number): Values {
  const writeRate = Math.round(clamp(num(p, "writeRate", 1_000), 10, 5_000));
  const outbox = num(p, "useOutbox", 1) >= 1;
  const failure = clamp(num(p, "publishFailure", 2), 0, 50);
  const pollInterval = clamp(num(p, "pollInterval", 200), 10, 5_000);
  const batchSize = Math.round(clamp(num(p, "batchSize", 500), 10, 1_000));
  const publisherCapacity = batchSize * (1_000 / pollInterval);
  const lostRate = outbox ? 0 : writeRate * (failure / 100);
  const publishLag = outbox ? (depth / Math.max(1, publisherCapacity)) * 1_000 + pollInterval : 0;
  return {
    writeRate,
    outbox,
    failure,
    pollInterval,
    batchSize,
    publisherCapacity,
    lostRate,
    depth,
    publishLag,
    publisherUtil: (writeRate / Math.max(1, publisherCapacity)) * 100,
  };
}

function buildFrame(p: Params, seed: number, depth: number): SimFrame {
  const values = compute(p, depth);
  const publisherHealth = !values.outbox ? "crit" : values.publisherUtil >= 95 ? "crit" : values.publisherUtil >= 80 ? "warn" : "ok";
  const outboxHealth = !values.outbox ? "crit" : values.depth >= 50_000 ? "crit" : values.depth >= 5_000 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "api",
        label: "Orders API",
        kind: "service",
        health: "ok",
        utilization: clamp(values.writeRate / 5_000),
        throughput: values.writeRate,
        sublabel: `${values.writeRate.toLocaleString("en-US")} writes/s`,
        detail: `Each order write commits a row in the database. ${values.outbox ? "The event row is inserted in the same transaction." : "The application then calls Kafka after the commit, so the two systems cannot commit together."}`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Orders database",
        kind: "db",
        health: "ok",
        utilization: clamp(values.writeRate / 5_000),
        throughput: values.writeRate,
        sublabel: "orders + outbox",
        detail: "The database commit is the source of truth. An outbox row is durable with the order change and survives an application crash.",
        meta: { view: "flow" },
      },
      {
        id: "outbox",
        label: values.outbox ? "outbox table" : "outbox bypassed",
        kind: "storage",
        health: outboxHealth,
        utilization: clamp(values.depth / 50_000),
        throughput: values.outbox ? Math.min(values.writeRate, values.publisherCapacity) : 0,
        capacity: values.publisherCapacity,
        sublabel: `${Math.round(values.depth).toLocaleString("en-US")} pending`,
        detail: values.outbox
          ? `The publisher claims up to ${values.batchSize} rows every ${values.pollInterval} ms, publishing at about ${Math.round(values.publisherCapacity).toLocaleString("en-US")} events/s.`
          : "No outbox row is written. If the broker publish fails after the commit, there is no durable record to retry from.",
        meta: { view: "flow", depth: values.depth },
      },
      {
        id: "publisher",
        label: "Outbox publisher",
        kind: "worker",
        health: publisherHealth,
        utilization: clamp(values.publisherUtil / 100),
        throughput: values.outbox ? Math.min(values.writeRate, values.publisherCapacity) : 0,
        capacity: values.publisherCapacity,
        sublabel: `${values.publisherUtil.toFixed(0)}% utilized`,
        detail: `The publisher reads pending rows, publishes each event, and marks the row sent. ${values.outbox ? "A crash after publish and before the mark produces a duplicate, so the consumer must be idempotent." : "In a dual write, a failed publish is simply lost; the API returns success for the database commit."}`,
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "order-events",
        kind: "stream",
        health: values.lostRate > 1 ? "crit" : "ok",
        utilization: clamp((values.writeRate - values.lostRate) / 5_000),
        throughput: Math.max(0, values.writeRate - values.lostRate),
        sublabel: values.outbox ? "at-least-once stream" : "gaps after failed publish",
        detail: `The topic receives ${Math.max(0, values.writeRate - values.lostRate).toLocaleString("en-US")} events/s. ${values.outbox ? "The outbox guarantees every committed order eventually appears, possibly more than once." : `${values.lostRate.toFixed(0)} events/s are lost when the publish fails after commit.`}`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("api-db", "api", "db", clamp(values.writeRate / 5_000), "ok"),
      edge("db-outbox", "db", "outbox", values.outbox ? 1 : 0, outboxHealth),
      edge("outbox-publisher", "outbox", "publisher", values.outbox ? clamp(values.publisherUtil / 100) : 0, publisherHealth),
      edge("publisher-topic", "publisher", "topic", values.outbox ? clamp(values.publisherUtil / 100) : clamp(values.lostRate / 5_000), values.lostRate > 1 ? "crit" : "ok"),
    ],
    metrics: [
      metric("lost-events", "Lost events", values.lostRate, " /s", 0.1, 1, "rps"),
      metric("publish-lag", "Publish lag", values.publishLag, "ms", 2_000, 10_000, "ms"),
      metric("outbox-depth", "Outbox backlog", values.depth, " rows", 5_000, 50_000, "count"),
      metric("publisher-util", "Publisher utilization", values.publisherUtil, "%", 80, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, depthJson: String(values.depth), outbox: values.outbox ? 1 : 0 },
    summary: values.outbox
      ? `Outbox has ${Math.round(values.depth).toLocaleString("en-US")} pending rows; publish lag ${(values.publishLag / 1_000).toFixed(1)}s.`
      : `Dual write is losing ${values.lostRate.toFixed(0)} events/s when the broker publish fails after commit.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "lost-events", Math.max(0, values.lostRate * (0.95 + 0.05 * Math.sin(index / 2.4))));
    recordSeries(frame, "publish-lag", Math.max(0, values.publishLag * (0.98 + 0.02 * Math.sin(index / 2.7))));
    recordSeries(frame, "outbox-depth", Math.max(0, values.depth * (0.97 + 0.03 * Math.sin(index / 2.3))));
    recordSeries(frame, "publisher-util", Math.max(0, values.publisherUtil * (0.99 + 0.01 * Math.sin(index / 2))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lost-events",
    metricId: "lost-events",
    warn: 0.1,
    crit: 1,
    title: "Committed orders have no event",
    cause:
      "The database commit and the Kafka publish are separate operations. In a dual write, the commit succeeds and the publish fails or times out, so the API reports success while the event is gone. There is no durable record to retry.",
    fix:
      "Write the event to an outbox table in the same transaction as the order change, then publish from the outbox. The commit becomes the only atomic boundary, and the publisher can retry from durable rows.",
    checkFirst: [
      "Compare committed orders with events on the topic for the same time window.",
      "Check broker publish errors and producer timeouts after commits.",
      "Check whether the API writes an outbox row in the same transaction.",
    ],
  },
  {
    id: "publish-lag",
    metricId: "publish-lag",
    warn: 2_000,
    crit: 10_000,
    title: "Outbox events are publishing too slowly",
    cause:
      "The publisher's capacity is batch size divided by poll interval. If writes exceed that capacity, rows accumulate and downstream consumers see stale state even though the database is current.",
    fix:
      "Raise batch size or lower the poll interval, add publisher partitions by key, or use change data capture to stream the outbox without polling. Measure lag from commit time, not only row count.",
    checkFirst: [
      "Compute publisher capacity and compare it with write rate.",
      "Check outbox row age, not only row count.",
      "Check whether one publisher is a bottleneck across all partitions.",
    ],
  },
  {
    id: "outbox-depth",
    metricId: "outbox-depth",
    warn: 5_000,
    crit: 50_000,
    title: "The outbox backlog is growing",
    cause:
      "Arrival of outbox rows exceeds the publisher's drain rate. A growing table increases query cost and the time until consumers see an event.",
    fix:
      "Scale the publisher, partition the outbox by key, or move to log-based CDC. Keep the table pruned after rows are published and verified.",
    checkFirst: [
      "Compare write rate with publisher drain rate.",
      "Check whether a poison row blocks the batch.",
      "Check table size, index cost, and cleanup policy.",
    ],
  },
  {
    id: "publisher-util",
    metricId: "publisher-util",
    warn: 80,
    crit: 95,
    title: "The outbox publisher has no headroom",
    cause:
      "One publisher is close to its batch and poll limits. Any write burst or broker slowdown turns into backlog and lag.",
    fix:
      "Increase batch size, add publisher workers with ordered key ranges, or use CDC. Do not simply shorten the poll interval without checking database load.",
    checkFirst: [
      "Check publisher CPU, batch claim time, and broker latency.",
      "Check whether rows are claimed in one global order.",
      "Check database query load from polling.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const outboxModel: SimModel = {
  id: "streaming-outbox",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(defaults(), seed, 0);
    seedSeries(frame, values);
    return frame;
  },
  step: (frame, p, dt) => {
    const previous = Number(frame.flags.depthJson ?? 0);
    const base = compute(p, previous);
    const seconds = Math.min(1, Math.max(0.01, dt));
    const depth = base.outbox ? Math.max(0, previous + (base.writeRate - base.publisherCapacity) * seconds) : 0;
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
    if (!values.outbox) {
      items.push(`A dual write commits the order and then publishes. At ${values.failure}% publish failure, ${values.lostRate.toFixed(0)} committed orders per second have no event.`);
      items.push("Retrying the publish from the request path does not fix the crash case: the process can die after commit and before the retry.");
    } else {
      items.push(`The outbox makes the database commit the atomic boundary. The publisher drains ${Math.round(values.publisherCapacity).toLocaleString("en-US")} rows/s against ${values.writeRate.toLocaleString("en-US")} writes/s.`);
      items.push(values.publisherUtil > 100 ? "Publisher capacity is below the write rate; backlog and publish lag grow until capacity changes." : "The publisher has headroom, so backlog drains and publish lag stays near the poll interval.");
    }
    items.push("The outbox gives at-least-once publication, not exactly-once. A crash after publish and before marking the row sent produces a duplicate.");
    items.push("Polling is simple and adds database load; change data capture reads the log and avoids polling but adds schema and connector operations.");
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
    description: "Outbox at 1k writes/s with a 200 ms poll and a 500-row batch.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "1.5k writes/s against an 1.6k rows/s publisher; publisher utilization is near its warning line.",
    tone: "warn",
    params: defaults({ writeRate: 1_500, pollInterval: 500, batchSize: 800 }),
  },
  {
    id: "failure",
    label: "Dual write",
    description: "A dual write at 1k writes/s with a 20% publish failure; 200 events/s are lost.",
    tone: "crit",
    params: defaults({ writeRate: 1_000, useOutbox: 0, publishFailure: 20 }),
  },
  {
    id: "recovery",
    label: "Outbox recovery",
    description: "The event is written in the same transaction and the publisher has capacity for the write rate.",
    tone: "ok",
    params: defaults({ writeRate: 1_000, useOutbox: 1, publishFailure: 10, pollInterval: 200, batchSize: 500 }),
  },
  {
    id: "backlog",
    label: "Outbox backlog",
    description: "Outbox is on, but the publisher is too slow for 3k writes/s; the table and lag grow.",
    tone: "crit",
    params: defaults({ writeRate: 3_000, useOutbox: 1, publishFailure: 10, pollInterval: 1_000, batchSize: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-dual-write-loss",
  title: "Predict what a failed publish loses",
  simId: "outbox",
  question:
    "The API commits an order, then calls Kafka. The call times out after the commit and the request returns success. What is the state of the system?",
  prediction: {
    options: [
      { id: "rolled-back", label: "The database transaction rolls back when the publish fails" },
      { id: "event-lost", label: "The order exists but the event is lost, and nothing durable records that it should be published" },
      { id: "event-retried", label: "Kafka retries the publish from the producer buffer after the timeout" },
      { id: "duplicate", label: "The order is written twice to compensate" },
    ],
    correctOptionId: "event-lost",
    explanation:
      "The database commit already succeeded. The application cannot roll it back because Kafka failed, and the failed publish exists only in memory or a client buffer. If the process moves on or dies, the event is gone. That is the dual-write gap the outbox closes.",
  },
  setup: defaults({ writeRate: 1_000, useOutbox: 0, publishFailure: 20 }),
  runFor: 20,
  observe: [
    "Lost events equal write rate times publish failure.",
    "The database row count is complete; the topic has gaps.",
    "An outbox row would be committed with the order and retried independently.",
    "At-least-once publication can duplicate an event after a crash, so consumers need idempotency.",
  ],
  explain:
    "A database and a broker do not share a transaction. A dual write tries to update both and has no atomic boundary, so one can succeed while the other fails. The outbox writes the event row in the database transaction, making the commit the single source of truth. A publisher then reads unsent rows and publishes them. Polling and CDC are two ways to drain that table; both require idempotent consumers.",
  fix: defaults({ writeRate: 1_000, useOutbox: 1, publishFailure: 10, pollInterval: 200, batchSize: 500 }),
  debrief:
    "The fix writes the event in the same transaction as the order. Lost events fall to zero even with a 10% publish failure, because the publisher retries from durable rows. The cost is an extra table, a publisher or connector to operate, and duplicates when the publisher crashes between publish and mark-sent.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The transactional outbox pattern publishes an event without a distributed transaction. Instead of committing the database change and then calling the broker, the service inserts an event row into an outbox table in the same database transaction. A separate publisher reads unsent rows and publishes them to Kafka or another broker, then marks them sent. The database commit is the only atomic boundary.",
  },
  {
    type: "p",
    text: "The alternative is a dual write: commit the order, then publish. Those are two systems with two failure modes. The commit can succeed while the publish fails, or the publish can succeed while the commit rolls back. Retrying from the request path cannot cover a process crash between the two. The outbox removes the gap by making the event durable before the request succeeds.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is service, database transaction, outbox table, publisher or connector, broker. Polling queries unsent rows on an interval. Change data capture (CDC) reads the database log and turns outbox inserts into a stream without polling. Both produce at-least-once publication: a crash after publish and before marking the row sent causes a duplicate.",
  },
  {
    type: "table",
    headers: ["Approach", "Atomic boundary", "Drain mechanism", "Main cost"],
    rows: [
      ["Dual write", "None", "Request-path retry", "Lost or phantom events across two systems"],
      ["Outbox with polling", "Database transaction", "Scheduled query and publish", "Polling load and publisher capacity"],
      ["Outbox with CDC", "Database transaction", "Log-based connector", "Connector operations and schema handling"],
      ["Event sourcing", "Event log itself", "Log consumption", "A larger change to how state is modeled"],
    ],
  },
  {
    type: "p",
    text: "This module uses 10 to 5,000 writes/s and a publisher that drains 1.2k to 2.5k rows/s. Those are illustrative teaching values. The shape of the failure is the lesson: the commit succeeds, the publish does not, and only a durable outbox row can retry it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Lost events per second: committed writes with no event. Warning at 0.1/s, critical at 1/s.",
      "Publish lag: time from commit to event availability. Warning at 2 seconds, critical at 10.",
      "Outbox backlog and publisher utilization, which show whether the drain keeps up.",
      "A flow view from API to database to outbox to publisher to topic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, apply Dual write, and run the experiment before enabling the outbox. Compare Outbox backlog with Recovery, and watch lost events separately from publish lag.",
  },
  { type: "sim", simId: "outbox" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With a dual write, 20% of publishes failed after the order commit. At 1k writes/s, 200 committed orders per second had no event. The API returned success because the database commit succeeded; the topic simply had gaps. No durable record said those events were owed, so a retry could only happen inside the request that had already moved on.",
  },
  {
    type: "p",
    text: "With the outbox, the event row committed with the order. The publisher retried from the table and lost events fell to zero even at a 10% publish failure. The new failure modes were backlog and lag: the publisher could only drain 2.5k rows/s, so a write rate above that grew the table. The publisher also produced at-least-once delivery, not exactly-once.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Order commits compared with events on the topic for the same interval.",
      "Outbox row count, oldest unsent row age, and publisher batch duration.",
      "Broker publish errors, retries, and producer buffer saturation.",
      "Consumer duplicates and idempotency-key collisions after a publisher crash.",
      "Database load from polling queries and outbox table growth.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare committed rows with published events before changing the broker. Check whether the event is written in the same transaction. Then check outbox age and publisher capacity. Do not replay from the topic until you know which events were never published.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the event row in the same transaction as the business change.",
      "Give the outbox a stable event ID and publish that ID with the payload.",
      "Drain with a publisher that claims rows, publishes, and marks them sent; make the consumer idempotent on the event ID.",
      "Size publisher capacity above the write rate and alert on oldest unsent age.",
      "Prune sent rows on a schedule and keep the table small enough for efficient polling.",
      "Consider CDC when polling load or latency becomes the bottleneck.",
      "Test a crash between publish and mark-sent to confirm duplicate handling.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "The outbox adds a table and a publisher to operate, but removes the dual-write gap.",
      "Polling is simple and adds database query load; CDC avoids polling but adds connector operations.",
      "At-least-once publication requires idempotent consumers and a stable event ID.",
      "Higher publisher throughput lowers lag but increases broker and database load.",
      "A longer poll interval reduces query load but raises the minimum publish latency.",
      "Pruning keeps the table small but must not delete rows before they are published.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-dual-write-fails",
    question:
      "Why can a service not just commit the database and publish to Kafka in the same request?",
    difficulty: 2,
    hints: [
      "The database and broker do not share a transaction.",
      "A crash can happen between the two calls.",
    ],
    answer:
      "The database commit and the Kafka publish are separate operations with separate failure domains. The commit can succeed and the publish fail, or the publish succeed and the commit roll back. A process crash between them leaves no record of what should happen next. Retrying inside the request cannot recover a process that died. The outbox fixes this by making the event durable in the same database transaction, then publishing asynchronously.",
    followUps: [
      "What happens if the publish succeeds and the process dies before marking the row?",
      "How would you detect missing events after the fact?",
      "Is a distributed transaction a good alternative?",
    ],
    redFlags: [
      "Assumes the two writes are atomic.",
      "Relies on in-memory retries.",
      "Ignores the crash window.",
    ],
    rubric: [
      "Names the two failure domains.",
      "Describes the crash window.",
      "Explains the outbox boundary.",
    ],
  },
  {
    id: "outbox-exactly-once",
    question:
      "Does the outbox give exactly-once publishing? What do you tell the consumer team?",
    difficulty: 3,
    hints: [
      "The publisher can crash after publishing and before marking the row.",
      "The event ID is the deduplication key.",
    ],
    answer:
      "No. The outbox gives at-least-once publication. If the publisher crashes after the broker accepts the event but before it marks the row sent, it will publish the same event again on restart. Consumers must deduplicate on the outbox event ID or a business key. Exactly-once effects need an idempotent sink or a transactional handoff, not just an outbox.",
    followUps: [
      "Where does the duplicate first appear?",
      "How long should the consumer keep deduplication keys?",
      "Can CDC avoid the duplicate?",
    ],
    redFlags: [
      "Claims exactly-once end to end.",
      "Has no event ID.",
      "Puts deduplication only in the publisher.",
    ],
    rubric: [
      "States at-least-once clearly.",
      "Explains the publish-and-crash window.",
      "Requires consumer idempotency.",
    ],
  },
  {
    id: "polling-vs-cdc",
    question:
      "Compare polling an outbox table with change data capture for draining it.",
    difficulty: 3,
    hints: [
      "Polling adds query load and latency.",
      "CDC reads the log and has schema and connector costs.",
    ],
    answer:
      "Polling is simple: a scheduled query claims unsent rows, publishes them, and marks them sent. It adds periodic database load and its minimum latency is the poll interval. CDC reads the database log and emits inserts without polling, which lowers latency and query load, but adds a connector, replication permissions, schema-change handling, and ordering concerns. I would start with polling for a modest rate and move to CDC when lag or polling load matters.",
    followUps: [
      "What schema change breaks a CDC connector?",
      "How does CDC handle deletes and tombstones?",
      "Which one is easier to operate on a small team?",
    ],
    redFlags: [
      "Treats CDC as free.",
      "Uses polling at a rate the database cannot sustain.",
      "Ignores schema evolution.",
    ],
    rubric: [
      "Names latency and load for polling.",
      "Names connector and schema cost for CDC.",
      "Gives a selection criterion.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The event is written in the same transaction as the business change.",
      "Every event has a stable ID for consumer deduplication.",
      "Outbox age, backlog, and publisher capacity are monitored.",
      "A crash between publish and mark-sent is tested.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare committed rows with published events before replaying.",
      "Check outbox age and publisher drain rate, not just row count.",
      "Check broker errors and database polling load together.",
      "Protect consumers from duplicate events during recovery.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Backfill missing events from the outbox or database, not from memory.",
      "Prune sent rows and verify the cleanup does not delete unsent work.",
      "Load-test publisher capacity above the peak write rate.",
    ],
  },
];

const references = [
  {
    title: "Pattern: transactional outbox",
    url: "https://microservices.io/patterns/data/transactional-outbox.html",
    publisher: "microservices.io",
    kind: "docs" as const,
    note: "Dual-write problem, outbox transaction, and polling or log tailing.",
  },
  {
    title: "Debezium outbox event router",
    url: "https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html",
    publisher: "Debezium",
    kind: "docs" as const,
    note: "CDC-based outbox publication and event routing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    outbox: {
      model: outboxModel,
      presets,
      instructions:
        "Start healthy, apply Dual write, then run the experiment. Compare Outbox backlog with Recovery. Watch lost events, publish lag, and publisher utilization.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Write rates, failure rates, and publisher capacity are teaching values, not production benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-cdc", "streaming-exactly-once", "foundations-idempotency"],
};
