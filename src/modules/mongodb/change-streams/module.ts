import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_EVENTS = 5_000_000;

const params: ParamSpec[] = [
  {
    id: "eventRate",
    label: "Write event rate",
    min: 200,
    max: 10_000,
    step: 100,
    value: 2_000,
    unit: " events/s",
    group: "Writes",
    help: "Documents changed per second in the watched collection. Each change becomes an event in the stream if it is majority-committed.",
    format: "rps",
  },
  {
    id: "consumerRate",
    label: "Consumer rate",
    min: 200,
    max: 10_000,
    step: 100,
    value: 2_500,
    unit: " events/s",
    group: "Consumer",
    help: "Events the downstream consumer can process per second. A consumer slower than the write rate falls behind even without a disconnect.",
    format: "rps",
  },
  {
    id: "outageSeconds",
    label: "Consumer outage",
    min: 0,
    max: 600,
    step: 10,
    value: 0,
    unit: "s",
    group: "Failure",
    help: "How long the consumer is disconnected from the change stream cursor. Events continue to accumulate in the oplog while it is away.",
    format: "number",
  },
  {
    id: "resumeTokenAge",
    label: "Resume token age",
    min: 0,
    max: 120,
    step: 5,
    value: 0,
    unit: "min",
    group: "Failure",
    help: "How old the last saved resume token is when the consumer disconnects. The token is only usable while the oplog still contains the operation it points to.",
    format: "number",
  },
  {
    id: "oplogWindow",
    label: "Oplog retention",
    min: 5,
    max: 240,
    step: 5,
    value: 60,
    unit: "min",
    group: "Storage",
    help: "Illustrative time range of operations still in the oplog. A real oplog window depends on its configured size and the write rate, not a fixed duration.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  eventRate: number;
  consumerRate: number;
  outageSeconds: number;
  consumerDown: boolean;
  tokenAgeMinutes: number;
  tokenExpired: boolean;
  backlog: number;
  lagSeconds: number;
  missedEvents: number;
  errorRate: number;
  oplogWindow: number;
  writeCpu: number;
  cursorHealth: Health;
  consumerHealth: Health;
  downstreamHealth: Health;
  primaryHealth: Health;
}

function compute(p: Params, t: number): Computed {
  const eventRate = clamp(num(p, "eventRate", 2_000), 200, 10_000);
  const consumerRate = clamp(num(p, "consumerRate", 2_500), 200, 10_000);
  const outageSeconds = clamp(num(p, "outageSeconds", 0), 0, 600);
  const tokenAgeBase = clamp(num(p, "resumeTokenAge", 0), 0, 120);
  const oplogWindow = clamp(num(p, "oplogWindow", 60), 5, 240);
  const elapsed = Math.max(0, t);
  const outageElapsed = Math.min(elapsed, outageSeconds);
  const consumerDown = outageSeconds > 0 && elapsed < outageSeconds;
  const tokenAgeMinutes = tokenAgeBase + outageElapsed / 60;
  const tokenExpired = outageSeconds > 0 && tokenAgeMinutes > oplogWindow;
  const initial = eventRate * outageSeconds;
  const net = eventRate - consumerRate;
  const afterOutage = Math.max(0, elapsed - outageSeconds);
  const backlog = clamp(
    consumerDown ? eventRate * outageElapsed : Math.max(0, initial + net * afterOutage),
    0,
    MAX_EVENTS,
  );
  const lagSeconds = backlog / Math.max(1, consumerRate);
  const missedEvents = tokenExpired ? eventRate * outageElapsed : 0;
  const errorRate = tokenExpired ? 100 : 0;
  const writeCpu = clamp((eventRate / 12_000) * 100, 0, 100);
  const lagHealth: Health = lagSeconds >= 120 ? "crit" : lagSeconds >= 30 ? "warn" : "ok";
  const cursorHealth: Health = tokenExpired ? "crit" : lagHealth;
  const consumerHealth: Health = consumerDown ? "down" : lagHealth;
  const downstreamHealth: Health = missedEvents > 0 ? "crit" : lagHealth === "crit" ? "warn" : "ok";
  const primaryHealth: Health = writeCpu >= 90 ? "crit" : writeCpu >= 70 ? "warn" : "ok";
  return {
    eventRate,
    consumerRate,
    outageSeconds,
    consumerDown,
    tokenAgeMinutes,
    tokenExpired,
    backlog,
    lagSeconds,
    missedEvents,
    errorRate,
    oplogWindow,
    writeCpu,
    cursorHealth,
    consumerHealth,
    downstreamHealth,
    primaryHealth,
  };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application writes",
      kind: "client",
      health: values.primaryHealth,
      throughput: values.eventRate,
      sublabel: `${Math.round(values.eventRate).toLocaleString()} events/s`,
      detail: "Applications write to the collection. A change stream does not remove the write itself; it removes the repeated polling reads downstream.",
      meta: { view: "flow" },
    },
    {
      id: "primary",
      label: "Primary",
      kind: "db",
      role: "primary",
      health: values.primaryHealth,
      utilization: clamp(values.writeCpu / 100),
      throughput: values.eventRate,
      sublabel: `${values.writeCpu.toFixed(0)}% write CPU`,
      detail: "The primary records writes in the oplog. Change streams expose majority-committed changes, so a notification is not emitted until the write has persisted to a majority of data-bearing members.",
      meta: { view: "flow" },
    },
    {
      id: "cursor",
      label: "Change stream cursor",
      kind: "stream",
      health: values.cursorHealth,
      sublabel: values.tokenExpired ? "resume token expired" : `lag ${values.lagSeconds.toFixed(0)}s`,
      detail: "The cursor tails the oplog and holds a getMore operation open while it waits. It is not a durable queue with its own retention; replay depends on the oplog still containing the token's position.",
      meta: { view: "flow" },
    },
    {
      id: "consumer",
      label: "Consumer",
      kind: "worker",
      health: values.consumerHealth,
      utilization: clamp(values.consumerRate / 10_000),
      sublabel: values.consumerDown ? "disconnected" : `${Math.round(values.consumerRate).toLocaleString()} events/s`,
      detail: "The consumer processes events and persists its resume token. Saving the token after processing gives at-least-once delivery; saving it before processing risks losing an event on crash.",
      meta: { view: "flow" },
    },
    {
      id: "downstream",
      label: "Downstream",
      kind: "service",
      health: values.downstreamHealth,
      sublabel:
        values.missedEvents > 0
          ? `${Math.round(values.missedEvents).toLocaleString()} events missed`
          : "in sync",
      detail: "The downstream view is only as complete as the events the consumer processed. A gap is not repaired by waiting; the consumer must rebuild from a full read or another source.",
      meta: { view: "flow" },
    },
  ];
  const edges = [
    edge("app-primary", "app", "primary", values.eventRate / 10_000, values.primaryHealth),
    edge("primary-cursor", "primary", "cursor", values.eventRate / 10_000, values.cursorHealth),
    edge("cursor-consumer", "cursor", "consumer", values.consumerRate / 10_000, values.consumerHealth),
    edge("consumer-downstream", "consumer", "downstream", values.consumerRate / 10_000, values.downstreamHealth),
  ];
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("missed-events", "Missed events", values.missedEvents, "", 1, 100, "count"),
      metric("consumer-lag", "Consumer lag", values.lagSeconds, "s", 30, 120, "number"),
      metric("stream-error-rate", "Resume failure rate", values.errorRate, "%", 1, 10, "percent"),
      metric("event-rate", "Write event rate", values.eventRate, " events/s", undefined, undefined, "rps"),
      metric("oplog-window", "Oplog retention", values.oplogWindow, "min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      tokenExpired: values.tokenExpired ? 1 : 0,
      consumerDown: values.consumerDown ? 1 : 0,
    },
    summary: `${values.consumerDown ? "Consumer disconnected" : "Consumer connected"} · lag ${values.lagSeconds.toFixed(0)}s · ${Math.round(values.missedEvents).toLocaleString()} missed · errors ${values.errorRate.toFixed(0)}%`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.05 * Math.sin((index + (seed % 8)) / 2.6);
  for (const [id, value] of [
    ["missed-events", values.missedEvents],
    ["consumer-lag", values.lagSeconds],
    ["stream-error-rate", values.errorRate],
    ["event-rate", values.eventRate],
  ] as const) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "missed-events",
    metricId: "missed-events",
    warn: 1,
    crit: 100,
    title: "The consumer resumed from a token the oplog no longer has",
    cause:
      "The consumer was away longer than the oplog retains history, or it resumed with an old token. The server cannot locate the token's position, so the events between the token and the oldest oplog entry cannot be replayed. Changing the pipeline or options when resuming can also prevent a clean resume.",
    fix:
      "Treat the gap as data loss and rebuild the downstream view from a full read or a known-good snapshot. Then save resume tokens after processing, monitor token age against the oplog window, and size the oplog for the longest consumer outage you intend to survive.",
    checkFirst: [
      "Check the error: a lost history error means the token is older than the oplog.",
      "Compare the consumer's last saved token time with the oplog window.",
      "Check whether the resume used the same pipeline and options as the original stream.",
    ],
  },
  {
    id: "consumer-lag",
    metricId: "consumer-lag",
    warn: 30,
    crit: 120,
    title: "The consumer is falling behind the change stream",
    cause:
      "The consumer processes events more slowly than they are produced, or it was disconnected and must catch up. A change stream preserves order but does not make a slow consumer faster; the backlog is bounded by the oplog window.",
    fix:
      "Scale or optimize the consumer, batch its downstream writes, and alert on lag before the token leaves the oplog. If the gap is already too large, rebuild rather than waiting for an unbounded catch-up.",
    checkFirst: [
      "Compare event rate with consumer throughput.",
      "Check whether the consumer is disconnected or retrying.",
      "Check whether lag is growing, steady, or draining.",
    ],
  },
  {
    id: "stream-error-rate",
    metricId: "stream-error-rate",
    warn: 1,
    crit: 10,
    title: "The change stream cannot resume",
    cause:
      "The resume token is no longer valid, the consumer cannot find a node that satisfies its read preference, or the stream was resumed with a different pipeline. MongoDB can only resume from a token that is still inside the oplog and was produced by the same stream shape.",
    fix:
      "Start a new change stream and perform a reconciliation read for the gap. Make token persistence part of the consumer's checkpoint, not an in-memory value. Alert on resume failures instead of retrying a permanently invalid token forever.",
    checkFirst: [
      "Check the driver error and whether it is classified as resumable.",
      "Check that the oplog still covers the token's timestamp.",
      "Check that the pipeline and options match the original stream.",
    ],
  },
];

export const changeStreamsModel: SimModel = {
  id: "mongodb-change-streams",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "consumer-lag" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.consumerDown && !Number(next.flags.outageAnnounced ?? 0)) {
      pushEvent(next, {
        id: "consumer-disconnected",
        at: frame.t,
        severity: "warn",
        title: "Change stream consumer disconnected",
        detail:
          "The cursor is no longer being consumed. Writes continue and events accumulate in the oplog, but only for as long as the oplog retains them.",
        nodeId: "consumer",
      });
      next.flags.outageAnnounced = 1;
    }
    if (values.tokenExpired && !Number(next.flags.tokenAnnounced ?? 0)) {
      pushEvent(next, {
        id: "resume-token-expired",
        at: frame.t,
        severity: "crit",
        title: "Resume token is older than the oplog",
        detail: `The token is about ${values.tokenAgeMinutes.toFixed(0)} minutes old against a ${num(p, "oplogWindow", 60).toFixed(0)} minute oplog window. Events before the oldest oplog entry cannot be replayed.`,
        nodeId: "cursor",
        metricId: "missed-events",
      });
      next.flags.tokenAnnounced = 1;
    }
    if (!values.consumerDown && Number(frame.flags.consumerDown ?? 0) === 1 && !values.tokenExpired && !Number(next.flags.recoveredAnnounced ?? 0)) {
      pushEvent(next, {
        id: "stream-resumed",
        at: frame.t,
        severity: "info",
        title: "Consumer resumed from its last token",
        detail: `The token was still inside the oplog. The consumer is draining ${Math.round(values.backlog).toLocaleString()} backlogged events; lag is ${values.lagSeconds.toFixed(0)}s.`,
      });
      next.flags.recoveredAnnounced = 1;
    }
    if (!values.consumerDown) next.flags.outageAnnounced = 0;
    if (!values.tokenExpired) next.flags.tokenAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0);
    return [
      values.consumerDown
        ? `The consumer is disconnected. Events are accumulating at ${Math.round(values.eventRate).toLocaleString()} per second in the oplog, and the saved token is aging with the outage.`
        : `The consumer is connected at ${Math.round(values.consumerRate).toLocaleString()} events/s against a ${Math.round(values.eventRate).toLocaleString()} events/s write rate. Backlog is ${Math.round(values.backlog).toLocaleString()} events.`,
      values.tokenExpired
        ? `The resume token is about ${values.tokenAgeMinutes.toFixed(0)} minutes old and the oplog retains about ${num(p, "oplogWindow", 60).toFixed(0)} minutes. The token cannot be resolved, so a gap is permanent until the downstream view is rebuilt.`
        : "A valid resume token lets the consumer replay events from its last checkpoint. That replay is at-least-once: an event processed just before a crash can be delivered again if the token was not saved.",
      "Change streams notify on majority-committed changes. A notification is not a per-consumer acknowledgement, and the stream has no retention beyond the oplog.",
      "Illustrative model. Oplog retention, event rates, and lag are teaching values; the oplog window depends on configured size and write volume.",
    ];
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
    description: "The consumer keeps up with writes and its resume token is current.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Write volume is high but the consumer still keeps pace.",
    tone: "warn",
    params: defaults({ eventRate: 9_000, consumerRate: 9_500 }),
  },
  {
    id: "failure",
    label: "Token expired",
    description: "The consumer is away for five minutes with an already old token and a short oplog window.",
    tone: "crit",
    params: defaults({ eventRate: 6_000, consumerRate: 3_000, outageSeconds: 300, resumeTokenAge: 45, oplogWindow: 30 }),
  },
  {
    id: "short-gap",
    label: "Short outage",
    description: "The consumer disconnects briefly and resumes from a token that is still in the oplog.",
    tone: "warn",
    params: defaults({ eventRate: 4_000, consumerRate: 4_500, outageSeconds: 120, resumeTokenAge: 0, oplogWindow: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The consumer is connected, faster than the write rate, with a current token.",
    tone: "ok",
    params: defaults({ eventRate: 2_000, consumerRate: 3_000, outageSeconds: 0, resumeTokenAge: 0, oplogWindow: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-delivery",
  title: "Predict what a reconnect can redeliver",
  simId: "change-streams",
  question:
    "A consumer processes an event, then crashes before saving the new resume token. It restarts and resumes from the previous token. What delivery guarantee does that pattern produce?",
  prediction: {
    options: [
      { id: "exactly", label: "Exactly once: the server remembers which consumer processed each event" },
      { id: "at-least", label: "At least once: the uncheckpointed event can be delivered and processed again" },
      { id: "at-most", label: "At most once: the event is dropped because the token was not saved" },
      { id: "none", label: "No guarantee: the stream always restarts from the beginning of the oplog" },
    ],
    correctOptionId: "at-least",
    explanation:
      "The resume token is the consumer's checkpoint. If the process crashes after the side effect but before saving the token, the restart resumes before that event and the event is delivered again. Change streams provide replay, not exactly-once processing. The consumer must make its downstream write idempotent or deduplicate by event id.",
  },
  setup: defaults({ eventRate: 4_000, consumerRate: 5_000, outageSeconds: 20, resumeTokenAge: 0, oplogWindow: 60 }),
  runFor: 30,
  observe: [
    "The consumer is disconnected for the first 20 seconds.",
    "Events accumulate in the oplog while it is away.",
    "After reconnect, the token is still valid and the consumer replays from its checkpoint.",
    "Lag drains because the consumer is faster than the write rate.",
  ],
  explain:
    "A change stream is a resumable cursor over the oplog, not a queue with per-consumer acknowledgement. The token marks a position, and resuming replays everything after it. That gives at-least-once delivery. If the consumer saves the token before its downstream write commits, a crash can lose the event; if it saves after, a crash can replay it. Exactly-once requires an idempotent downstream write keyed by the event id or a transaction that covers both the effect and the checkpoint.",
  fix: defaults({ eventRate: 2_000, consumerRate: 3_000, outageSeconds: 0, resumeTokenAge: 0, oplogWindow: 60 }),
  debrief:
    "Store the resume token with the downstream effect, or make the effect idempotent. Alert when consumer lag approaches the oplog window, not after the token has already expired. If a token is lost, do not retry it forever: start a new stream and reconcile the gap with a full read. The tradeoff is that reconciliation costs a scan, while a longer oplog costs storage and recovery time.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A change stream is a resumable cursor over a collection's changes. Instead of querying the collection every second, a consumer opens a cursor and receives an event for each insert, update, replace, delete, or invalidate. The server reads from the oplog and emits only changes that have persisted to a majority of data-bearing members.",
  },
  {
    type: "p",
    text: "Each event carries a resume token in its `_id`. The consumer saves the token after processing an event. On reconnect, it passes the token to `resumeAfter` and the server replays from that position. The token is a position in the oplog, not a permanent receipt: it is only usable while the oplog still contains the operation it points to.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The change stream sits between the replica set's oplog and a downstream consumer. For a replica set, it can be opened on any data-bearing member; for a sharded cluster, it is opened through `mongos`. The cursor holds a `getMore` operation open while it waits, so each open stream consumes a connection from the pool.",
  },
  {
    type: "table",
    headers: ["Approach", "Load pattern", "Failure behavior"],
    rows: [
      ["Poll every second", "A query per interval, even when nothing changed", "Misses changes between polls unless the query tracks a watermark"],
      ["Change stream", "One cursor and a getMore wait per consumer", "Replays from the last resume token if the oplog still has it"],
      ["Change stream after oplog expiry", "Cursor cannot resolve the token", "Gap is permanent; rebuild the downstream view"],
      ["Change stream with a slow consumer", "Backlog grows in the oplog", "Lag can outrun retention even without a crash"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Consumer lag: how far the consumer is behind the current write position.",
      "Missed events: changes that fell out of the oplog before the consumer could replay them.",
      "Resume failure rate: how often a token cannot be used.",
      "Write event rate: the production rate the consumer must sustain.",
      "Oplog retention: the replay window, which depends on oplog size and write volume.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Short outage: the consumer disconnects, the backlog grows, and the token remains valid. Apply Token expired with a short oplog window to see the gap become permanent. Compare the recovery preset. Use the experiment before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Replay is not exactly-once",
    body: "A resume token is a checkpoint, not a per-event acknowledgement. If a consumer crashes after applying an effect but before saving the token, the event is delivered again. Make downstream writes idempotent or deduplicate by event id. Do not use a change stream as a durable work queue with independent retention.",
  },
  { type: "sim", simId: "change-streams" },
  { type: "experiment", experimentId: "predict-delivery" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The consumer stopped reading. Writes continued, so events accumulated in the oplog. Because the saved token was already old and the outage outlasted the oplog window, the token's position fell out of history. On reconnect the server could not replay from that point, so the events between the token and the oldest oplog entry were lost. Consumer lag and the missed-event count rose together, and the resume failure was a separate signal from the lag.",
  },
  {
    type: "p",
    text: "In the short-outage case the token was still valid. The consumer resumed, replayed the backlog, and drained it because its processing rate exceeded the write rate. The stream preserved order, but it did not guarantee that every event was processed exactly once; the consumer's checkpoint placement determined whether a crash could replay or skip an event.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The driver reports a resumable error, then a lost-history error when the token is no longer in the oplog.",
      "Consumer lag rises before the token expires; the gap becomes permanent only after it does.",
      "The oplog window shrinks under a write burst even if the configured oplog size did not change.",
      "Downstream data is missing a range of changes, while new events continue to arrive.",
      "The number of open change streams can exhaust the connection pool and add notification latency.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the error is resumable or a lost-history error. Compare the saved token's age with the current oplog window. Check consumer lag and whether it is growing. If the token is gone, stop retrying it and plan a reconciliation read; if it is still valid, let the consumer drain and watch that lag falls.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify the error: transient resume, lost history, or a configuration mismatch.",
      "If the token is still valid, resume with the same pipeline and options and drain the backlog.",
      "If history is lost, rebuild the downstream view from a full read or a snapshot and record the gap.",
      "Save resume tokens with the downstream effect, not before it.",
      "Alert on lag as a fraction of the oplog window, not only on absolute lag.",
      "Size the oplog for the longest outage you intend to survive, and cap open streams against the pool.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger oplog extends replay but costs disk and increases recovery time.",
      "Polling is simple but adds load even when nothing changed and can miss changes between intervals.",
      "At-least-once replay requires idempotent consumers; exactly-once needs a transactional boundary.",
      "More consumers mean more open cursors and connection pressure.",
      "Rebuilding after a lost token is correct but expensive compared with preventing the gap.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "poll-vs-stream",
    question: "A downstream service polls MongoDB every second. When is a change stream the better choice?",
    difficulty: 2,
    hints: [
      "Compare load when nothing changes.",
      "Consider replay and ordering requirements.",
      "A change stream is not a durable queue.",
    ],
    answer:
      "A change stream is better when the service needs near-real-time changes, must preserve order, and would otherwise run a repeated query that mostly returns nothing. It replaces polling load with one cursor and a getMore wait. It is not automatically better when the consumer needs independent retention, per-message acknowledgement, or replay beyond the oplog. In those cases a stream plus a durable queue, or polling with a watermark, may fit better.",
    followUps: [
      "What happens when the consumer is down longer than the oplog window?",
      "How does an open change stream affect the connection pool?",
      "When would polling still be appropriate?",
    ],
    redFlags: [
      "Treats a change stream as a durable queue.",
      "Ignores replay limits.",
      "Assumes exactly-once delivery.",
    ],
    rubric: [
      "Compares load patterns.",
      "Mentions order and replay.",
      "Names the oplog limit.",
      "Considers retention and acknowledgement.",
    ],
  },
  {
    id: "resume-token",
    question: "How does a resume token work, and what makes it unusable?",
    difficulty: 3,
    hints: [
      "The token marks a position in the oplog.",
      "The oplog is capped.",
      "The stream shape must match.",
    ],
    answer:
      "The token identifies a position in the change stream history, backed by the oplog. On reconnect the consumer passes it to `resumeAfter` and the server replays events after that position. It becomes unusable when the oplog no longer contains the operation, when the stream is resumed with a different pipeline or options, or when an invalidate event closed the stream and `resumeAfter` is not allowed. A lost token means a gap that must be reconciled, not retried.",
    followUps: [
      "What is the difference between `resumeAfter` and `startAfter`?",
      "Why does the oplog window shrink under a write burst?",
      "What does an invalidate event represent?",
    ],
    redFlags: [
      "Thinks the token is stored forever.",
      "Resumes with a different pipeline and expects the same result.",
      "Retries a lost token indefinitely.",
    ],
    rubric: [
      "Explains position semantics.",
      "Names the oplog limit.",
      "Mentions pipeline consistency.",
      "Plans reconciliation after loss.",
    ],
  },
  {
    id: "delivery",
    question: "What delivery guarantee does a change stream consumer get, and how do you make it safe?",
    difficulty: 3,
    hints: [
      "Think about when the token is saved.",
      "A crash between effect and checkpoint matters.",
      "Idempotence is separate from replay.",
    ],
    answer:
      "The stream gives at-least-once replay from a checkpoint. If the consumer saves the token after the downstream effect, a crash can replay the event; if it saves before, a crash can lose it. To make it safe, I would make the downstream write idempotent with the event id or write the effect and the checkpoint in one transaction. Then replay is harmless and the checkpoint cannot advance past an effect that was not committed.",
    followUps: [
      "How would you deduplicate by event id?",
      "What changes if the downstream store is not transactional?",
      "How do you test the crash window?",
    ],
    redFlags: [
      "Claims exactly-once without a transactional boundary.",
      "Saves the token before the effect.",
      "Ignores duplicate side effects.",
    ],
    rubric: [
      "States at-least-once.",
      "Explains checkpoint ordering.",
      "Chooses idempotence or a transaction.",
      "Describes a test for the crash window.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Resume tokens are persisted with the downstream effect.",
      "Consumer lag is alerted as a fraction of the oplog window.",
      "The oplog is sized for the longest planned consumer outage.",
      "Open change streams are counted against the connection pool.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Classify the error as resumable or lost history.",
      "Compare token age with the oplog window.",
      "Check whether lag is growing, steady, or draining.",
      "Do not retry an invalid token forever.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile any gap with a full read or snapshot.",
      "Confirm the consumer is current and lag is falling.",
      "Review checkpoint placement for crash safety.",
      "Decide whether the oplog or consumer capacity needs to change.",
    ],
  },
];

const references = [
  {
    title: "MongoDB Change Streams",
    url: "https://www.mongodb.com/docs/manual/changeStreams/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Change stream availability, majority-committed notifications, resume tokens, and resume behavior.",
  },
  {
    title: "Change Events",
    url: "https://www.mongodb.com/docs/manual/reference/change-events/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Event shape, the _id resume token, and operation types.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "change-streams": {
      model: changeStreamsModel,
      presets,
      instructions:
        "Start Healthy, then apply Short outage and watch lag drain after reconnect. Apply Token expired with a short oplog window to see the gap become permanent. Compare the recovery preset.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Event rates, lag, and oplog retention are teaching values. The real oplog window depends on configured size and write volume.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mongodb-replication-lag", "mongodb-read-concern", "mongodb-write-concern"],
};
