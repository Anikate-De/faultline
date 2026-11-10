import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_REPLAY_RISK = 1_000_000;
const MAX_REPLAY_RATE = 5_000_000;
const FIRST_CRASH_AT = 8;

const params = [
  {
    id: "commitInterval",
    label: "Commit interval",
    min: 1,
    max: 30,
    step: 1,
    value: 5,
    unit: " s",
    group: "Offsets",
    help: "How often the group commits the offsets returned by poll. A restart replays everything processed after the last commit.",
    format: "count" as const,
  },
  {
    id: "processingMs",
    label: "Processing time",
    min: 10,
    max: 400,
    step: 10,
    value: 40,
    unit: " ms/record",
    group: "Consumer",
    help: "Time one member spends processing a record. This sets the group's per-member throughput.",
    format: "ms" as const,
  },
  {
    id: "members",
    label: "Group members",
    min: 2,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Consumer group",
    help: "Members sharing the partitions. Each member processes records at the rate implied by processing time.",
    format: "count" as const,
  },
  {
    id: "crashEverySec",
    label: "Restart interval",
    min: 0,
    max: 600,
    step: 30,
    value: 0,
    unit: " s",
    group: "Failure",
    help: "Seconds between full group restarts. 0 disables restarts. The first restart happens at 8 seconds, then the interval repeats.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flagNumber(frame: SimFrame, id: string, fallback = 0): number {
  const value = frame.flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  commitInterval: number;
  processingMs: number;
  members: number;
  crashEverySec: number;
  consumeRate: number;
  replayRisk: number;
  commitAge: number;
  hasCrash: boolean;
  crashesPerMin: number;
  replayedPerMin: number;
  crashIndex: number;
}

function compute(p: Params, t: number): Values {
  const commitInterval = Math.max(1, Math.round(num(p, "commitInterval", 5)));
  const processingMs = Math.max(1, num(p, "processingMs", 40));
  const members = Math.max(1, Math.round(num(p, "members", 6)));
  const crashEverySec = Math.max(0, Math.round(num(p, "crashEverySec", 0)));
  const memberRate = 1000 / processingMs;
  const consumeRate = members * memberRate;
  const replayRisk = Math.min(MAX_REPLAY_RISK, consumeRate * commitInterval);
  const hasCrash = crashEverySec > 0 && t >= FIRST_CRASH_AT;
  const crashesPerMin = crashEverySec > 0 ? 60 / crashEverySec : 0;
  const replayedPerMin = hasCrash ? Math.min(MAX_REPLAY_RATE, crashesPerMin * replayRisk) : 0;
  const crashIndex =
    crashEverySec > 0 && t >= FIRST_CRASH_AT
      ? Math.max(0, Math.floor((t - FIRST_CRASH_AT) / crashEverySec))
      : -1;
  return {
    commitInterval,
    processingMs,
    members,
    crashEverySec,
    consumeRate,
    replayRisk,
    commitAge: commitInterval,
    hasCrash,
    crashesPerMin,
    replayedPerMin,
    crashIndex,
  };
}

function healthForReplay(replayRisk: number, commitAge: number): "ok" | "warn" | "crit" {
  if (replayRisk >= 20_000 || commitAge >= 20) return "crit";
  if (replayRisk >= 5_000 || commitAge >= 8) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.95 + 0.07 * Math.sin((offset + (seed % 6)) / 2.4);
  const points: [string, number, number][] = [
    ["replay-risk", values.replayRisk, 5],
    ["replayed-events", values.replayedPerMin, 10],
    ["commit-age", values.commitAge, 0.1],
    ["consume-rate", values.consumeRate, 2],
  ];
  for (const [id, value, amplitude] of points) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const riskHealth = healthForReplay(values.replayRisk, values.commitAge);
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Orders producer",
        kind: "service",
        health: "ok",
        utilization: 0.5,
        throughput: values.consumeRate,
        sublabel: `${Math.round(values.consumeRate).toLocaleString("en-US")} rec/s steady state`,
        detail: "The producer rate matches the group's processing rate in this model; the lesson is the commit window, not lag.",
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "stream",
        health: "ok",
        utilization: 0.5,
        throughput: values.consumeRate,
        sublabel: "partitioned log · offsets per partition",
        detail: "Offsets are monotonic inside one partition. A group commits one position per partition.",
        meta: { view: "flow" },
      },
      {
        id: "coordinator",
        label: "Group coordinator",
        kind: "service",
        health: "ok",
        utilization: 0.3,
        sublabel: `orders-reader · ${values.members} members`,
        detail: "The coordinator tracks membership and the committed offsets stored for the group.",
        meta: { view: "flow" },
      },
      {
        id: "group",
        label: "consumer group",
        kind: "worker",
        health: riskHealth,
        throughput: values.consumeRate,
        sublabel: `${values.members} members · commits every ${values.commitInterval}s`,
        detail: `The group processes ${Math.round(values.consumeRate).toLocaleString("en-US")} records/s across ${values.members} members. A full restart after processing but before a commit replays the uncommitted window.`,
        meta: { view: "flow", consumeRate: values.consumeRate },
      },
      {
        id: "offsets",
        label: "Offset store",
        kind: "db",
        health: riskHealth,
        throughput: values.consumeRate,
        sublabel: `commits every ${values.commitAge}s · ${Math.round(values.replayRisk).toLocaleString("en-US")} records at risk`,
        detail: "Committed offsets live in the group's offset store. The gap between the processed position and the committed position is the replay window.",
        meta: { view: "flow", commitAge: values.commitAge },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", 0.5, "ok"),
      edge("topic-coordinator", "topic", "coordinator", 0.5, "ok"),
      edge("coordinator-group", "coordinator", "group", 0.5, riskHealth),
      edge("group-offsets", "group", "offsets", 0.5, riskHealth),
    ],
    metrics: [
      metric("replay-risk", "Uncommitted records", values.replayRisk, " records", 5_000, 20_000, "count"),
      metric("replayed-events", "Replay rate", values.replayedPerMin, " rec/min", 30_000, 100_000, "count"),
      metric("commit-age", "Commit interval", values.commitAge, "s", 8, 20, "count"),
      metric("consume-rate", "Processed rate", values.consumeRate, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `The group processes ${Math.round(values.consumeRate).toLocaleString("en-US")} rec/s and commits every ${values.commitInterval}s, so up to ${Math.round(values.replayRisk).toLocaleString("en-US")} processed records can replay after a restart.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0);
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replay-risk",
    metricId: "replay-risk",
    warn: 5_000,
    crit: 20_000,
    title: "The replay window is large enough to duplicate a burst",
    cause:
      "The group has processed records but not committed their offsets. A restart resumes from the last committed position and every record after it is delivered again. The window is processing rate times commit interval.",
    fix:
      "Commit after the work is durable, shorten the interval if commit overhead allows, and make the consumer idempotent so a replay does not repeat side effects.",
    checkFirst: [
      "Compare the processed position with the last committed offset for each partition.",
      "Check whether commits happen before or after the downstream write.",
      "Check the auto-commit interval and whether processing outlives it.",
    ],
  },
  {
    id: "replayed-events",
    metricId: "replayed-events",
    warn: 30_000,
    crit: 100_000,
    title: "A group restart is replaying already processed records",
    cause:
      "The group restarted after its last commit and resumed from that offset. Everything processed after the commit is read again. Repeated restarts multiply the duplicate volume.",
    fix:
      "Reduce the uncommitted window, commit after processing, and deduplicate on an entity or event identifier. If the downstream must be exact, use a transaction or an idempotent write.",
    checkFirst: [
      "Correlate the replay burst with a full group restart or rebalance.",
      "Check the committed offset timestamp, not only the consumer position.",
      "Check whether the downstream accepts duplicate writes.",
    ],
  },
  {
    id: "commit-age",
    metricId: "commit-age",
    warn: 8,
    crit: 20,
    title: "The commit interval leaves a large replay window",
    cause:
      "The commit interval is long or commits are failing. The older the committed offset, the more work a group restart repeats, even if the group is currently caught up.",
    fix:
      "Shorten the commit interval, commit after each batch, and alert on commit failures. Do not trade an unbounded replay window for a small reduction in commit requests.",
    checkFirst: [
      "Check commit latency and error rate.",
      "Check whether the coordinator is reachable.",
      "Check whether the consumer commits the polled position or the processed position.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const consumerGroupsModel: SimModel = {
  id: "streaming-consumer-groups",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const values = compute(p, frame.t);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.t);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const previousCrash = flagNumber(frame, "crashIndex", -1);
    if (values.crashIndex > previousCrash) {
      pushEvent(next, {
        id: `group-restart-${values.crashIndex}`,
        at: frame.t,
        severity: values.replayRisk >= 20_000 ? "crit" : values.replayRisk >= 5_000 ? "warn" : "info",
        title: "The consumer group restarted and resumed from its last commits",
        detail: `Every member restarted and resumed from the group's last committed offsets. Those commits can be up to ${values.commitInterval}s old, so up to ${Math.round(values.replayRisk).toLocaleString("en-US")} already processed records are delivered again across the group.`,
        nodeId: "group",
        metricId: "replayed-events",
      });
      next.flags.crashIndex = values.crashIndex;
    } else if (values.crashIndex < previousCrash) {
      next.flags.crashIndex = values.crashIndex;
    }

    if (values.replayedPerMin >= 100_000 && next.flags.replaySeen !== 1) {
      pushEvent(next, {
        id: "replay-burst",
        at: frame.t,
        severity: "crit",
        title: "Replay volume exceeds the duplicate budget",
        detail: `${Math.round(values.replayedPerMin).toLocaleString("en-US")} records per minute are being redelivered after restarts. The group is committing every ${values.commitInterval}s at ${Math.round(values.consumeRate).toLocaleString("en-US")} rec/s.`,
        nodeId: "offsets",
        metricId: "replayed-events",
      });
      next.flags.replaySeen = 1;
    }
    if (values.replayedPerMin < 30_000) next.flags.replaySeen = 0;

    next.flags.paramsKey = key;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items = [
      `The group processes ${Math.round(values.consumeRate).toLocaleString("en-US")} rec/s. With a ${values.commitInterval}s commit interval, up to ${Math.round(values.replayRisk).toLocaleString("en-US")} processed records sit beyond the committed offset.`,
      "A committed offset is the next record the group intends to read, not the last record it read. The gap after it is the replay window.",
    ];
    if (values.hasCrash) {
      items.push(
        `Restarts occur about ${values.crashesPerMin.toFixed(1)} times per minute in this scenario, replaying roughly ${Math.round(values.replayedPerMin).toLocaleString("en-US")} records per minute.`,
      );
    } else {
      items.push("No restart is scheduled in this preset; the replay window is a risk, not yet a duplicate burst.");
    }
    items.push("Shortening the interval reduces the window but adds commit round trips; idempotent consumers make the duplicate harmless either way.");
    return items;
  },
  legend: [
    { label: "Committed", tone: "ok" },
    { label: "Wide window", tone: "warn" },
    { label: "Replaying", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Commits every five seconds and no group restarts; the replay window is small.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Higher throughput with a twelve-second commit interval; the window is wider.",
    tone: "warn",
    params: defaults({ commitInterval: 12, processingMs: 25, members: 8, crashEverySec: 300 }),
  },
  {
    id: "failure",
    label: "Restart after slow commits",
    description: "Thirty-second commits at 1,000 records/s; a restart replays a large processed burst.",
    tone: "crit",
    params: defaults({ commitInterval: 30, processingMs: 10, members: 10, crashEverySec: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "One-second commits, moderate processing, and rare restarts keep replays small.",
    tone: "ok",
    params: defaults({ commitInterval: 1, processingMs: 30, members: 10, crashEverySec: 120 }),
  },
];

const experiment: Experiment = {
  id: "predict-replay-window",
  title: "Predict the replay after a restart",
  simId: "consumer-groups",
  question:
    "A group processes 1,000 records/s and commits every 30 seconds. The whole group restarts after processing but before the next commit. How much work can be replayed?",
  prediction: {
    options: [
      { id: "none", label: "Nothing: the broker stored the processed offset" },
      { id: "one", label: "One record: the one in flight" },
      { id: "window", label: "Up to 30 seconds of processed records, about 30,000" },
      { id: "all", label: "Every record since the group started" },
    ],
    correctOptionId: "window",
    explanation:
      "The broker only knows the group's committed offsets. Records processed after the last commit are not part of the committed position, so the restarted group reads them again. At 1,000 records/s, a 30-second commit interval opens a window of up to 30,000 records across the group. The exact count depends on when the last commit happened and how much processing had completed.",
  },
  setup: defaults({ commitInterval: 30, processingMs: 10, members: 10, crashEverySec: 30 }),
  runFor: 30,
  observe: [
    "Uncommitted records rise to 30,000 as soon as the commit interval is 30 seconds.",
    "At the first group restart, replay rate jumps to about 60,000 records per minute.",
    "Commit interval stays at 30 seconds, so every restart starts from a stale position.",
    "Throughput stays constant; the failure is duplicate work, not slow processing.",
  ],
  explain:
    "Offsets are committed by the group, per partition, and the committed offset is the next record to read. Processing does not move it. A group that restarts after processing but before committing resumes at the old positions. Shortening the interval narrows the window. Committing after the downstream write makes the reprocessing safe; idempotent writes make the duplicate harmless even when the window is wide.",
  fix: defaults({ commitInterval: 1, processingMs: 30, members: 10, crashEverySec: 120 }),
  debrief:
    "With one-second commits, the same group has about 333 uncommitted records instead of 30,000. Restarts still replay, but the burst is small enough for an idempotent consumer to absorb. The fix is a narrower commit window plus duplicate-safe writes, not a promise that restarts stop happening.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A consumer group is a set of consumers that share a subscription to a topic. Kafka assigns each partition to one member of the group, and each member tracks how far it has read with an offset. An offset is a position in one partition's log. The group commits offsets so a restarted member can resume instead of reading from the beginning. The committed offset is the next record the group intends to read, not the last record it processed.",
  },
  {
    type: "p",
    text: "The gap between processing and committing is the replay window. If a member processes ten records and crashes before committing, those ten are delivered again. If it commits before processing and then crashes, the records are skipped. At-least-once delivery chooses the first tradeoff: commit after the work, accept duplicates, and make the work idempotent. The commit interval is the main size control for that duplicate burst.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The group coordinator assigns partitions and stores committed offsets in Kafka's internal offsets topic. A member polls records from its partitions, processes them, and commits the next position. With auto-commit enabled, the client commits the offsets returned by poll on a timer; with manual commit, the application chooses the point. A crash, a rebalance, or a long processing batch can all leave the committed position behind the processed position.",
  },
  {
    type: "table",
    headers: ["Commit point", "Delivery effect", "Crash behavior", "Use when"],
    rows: [
      ["Before processing", "At-most-once", "Records can be lost", "Loss is acceptable and duplicates are not"],
      ["After processing", "At-least-once", "Records replay", "The write can be made idempotent"],
      ["After processing, in a transaction", "Exactly-once for Kafka reads and writes", "The transaction commits or aborts atomically", "The output is another Kafka topic read with read_committed"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 2 to 12 members, 10 to 400 milliseconds per record, 1 to 30 second commit intervals, and a crash every 0 to 600 seconds. The first crash happens at 8 seconds, then repeats on the interval. Those are teaching values, not Kafka defaults or limits.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Uncommitted records: processed records beyond the last commit, the replay window. Warning at 5,000, critical at 20,000.",
      "Replay rate: records redelivered per minute after restarts. Warning at 30,000, critical at 100,000.",
      "Commit interval: how often the group commits offsets, which sets the replay window. Warning at 8 seconds, critical at 20.",
      "Processed rate: records per second the group can handle at the current processing time.",
      "A flow view from producer to topic, coordinator, group, and offset store.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Crash after slow commits. Watch uncommitted records before the first crash, then watch replay rate after it. Run the guided experiment, then try Recovery. Change the commit interval and note that throughput does not move; only the replay window does.",
  },
  { type: "sim", simId: "consumer-groups" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, ten members processed 100 records/s each, for 1,000 records/s. The group committed every 30 seconds, so up to 30,000 already processed records sat beyond the committed offsets. At the first restart, the whole group resumed from those stale positions and the replay rate reached about 60,000 records per minute. Processing throughput never dropped. The dashboard looked healthy if it only watched records consumed.",
  },
  {
    type: "p",
    text: "Recovery shortened the interval to one second and slowed processing slightly. The uncommitted window fell to about 333 records, and a restart every two minutes produced only a small replay burst. The group still delivered duplicates; it just bounded them to a size an idempotent consumer can absorb.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer group lag, committed offset age, and commit rate per partition.",
      "Restart and rebalance events correlated with duplicate-write spikes in the downstream service.",
      "The gap between the consumer's position and its committed offset, which is the replay window.",
      "Commit latency and commit failures, especially when the coordinator is slow.",
      "Idempotency or dedupe counters in the sink, which show whether replays cause repeated effects.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the processed position with the committed offset for the affected partition. If the committed offset is much older, a restart will replay. Check whether the commit happens before or after the downstream write, then check whether the sink can tolerate the duplicate before shortening the interval.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the affected partition and compare its processed position with its committed offset.",
      "Confirm whether commits happen before or after the side effect.",
      "Commit after the write is durable, and shorten the interval until the replay window fits the duplicate budget.",
      "Make the sink idempotent with an entity or event key, or use a transaction when the sink supports it.",
      "Bound commit overhead: batch commits and monitor commit latency rather than committing every record.",
      "Replay a known crash and verify the duplicate count matches the expected window.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Committing more often shrinks the replay window but adds coordinator round trips and commit overhead.",
      "Committing less often lowers overhead but makes every crash replay more work.",
      "Committing before processing can avoid duplicates but risks losing records on a crash.",
      "Exactly-once transactions remove duplicates only when the output is Kafka and the reader consumes committed data; an external sink still needs idempotency.",
      "A long processing batch extends the window even with a short commit interval if the commit waits for the batch.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "replay-ten-minutes",
    question: "A consumer restarts and reprocesses ten minutes of events. What do you check, and what is the likely cause?",
    difficulty: 2,
    hints: [
      "The broker only knows the group's committed offsets.",
      "Ten minutes is much larger than a typical auto-commit interval.",
    ],
    answer:
      "I would compare the processed position with the committed offset for each partition and check when the offsets were last committed. Ten minutes suggests the group was not committing, commits were failing, or the member was processing a long batch while auto-commit was disabled. It can also happen if the consumer group changed and offsets were reset, or if the consumer never committed and auto.offset.reset started it earlier. I would check commit errors and coordinator health, then confirm whether the downstream writes are idempotent before replaying again. The fix is to restore commits after processing and bound the replay window.",
    followUps: [
      "What does auto.offset.reset do if no offset is committed?",
      "How would you tell a commit failure from a rebalance?",
      "What is the duplicate budget for this pipeline?",
    ],
    redFlags: [
      "Blames Kafka for losing the committed offset.",
      "Says the consumer position is committed automatically by the broker.",
      "Replays without checking downstream idempotency.",
    ],
    rubric: [
      "Compares processed and committed offsets.",
      "Checks commit failures and rebalance.",
      "Considers auto.offset.reset.",
      "Bounds the replay and protects the sink.",
    ],
  },
  {
    id: "auto-vs-manual-commit",
    question: "When would you use auto-commit, and when would you commit manually after processing?",
    difficulty: 2,
    hints: [
      "Auto-commit commits the offsets returned by poll.",
      "Manual commit lets the application choose the point relative to the side effect.",
    ],
    answer:
      "Auto-commit is convenient for pipelines where the processing is quick and idempotent, or where occasional replay is acceptable. The client commits the offsets returned by poll on the configured interval, which can be before the application has finished its work, so the window between poll and commit matters. I would commit manually after the downstream write when duplicates are expensive or when processing time can exceed the interval. The manual path costs more code and commit requests, but it aligns the committed position with durable work. In both cases the consumer must tolerate duplicates, because a crash between the write and the commit still replays.",
    followUps: [
      "Can auto-commit commit before processing finishes?",
      "How does a batch commit change the window?",
      "What does a transactional commit add?",
    ],
    redFlags: [
      "Claims auto-commit is exactly-once.",
      "Commits before the write and calls it safe.",
      "Ignores commit overhead.",
    ],
    rubric: [
      "Explains what auto-commit commits.",
      "Aligns commit with the side effect.",
      "Accepts at-least-once duplicates.",
    ],
  },
  {
    id: "duplicate-safety",
    question: "The same event is processed twice after a restart. How do you make that harmless?",
    difficulty: 3,
    hints: [
      "The event needs a stable identity.",
      "The write must be idempotent or deduplicated.",
    ],
    answer:
      "I would make the write idempotent on a stable key from the event, such as order_id plus event type and version, or a unique event ID. An upsert with a version check ignores older replays; a dedupe table records seen IDs for a bounded window. If the sink supports transactions, a consume-process-produce transaction can make the offset commit and the output atomic inside Kafka. The choice depends on the sink and the retention needed for dedupe. I would also measure duplicate rate and set a budget, because at-least-once delivery does not promise zero duplicates.",
    followUps: [
      "How long do you keep dedupe keys?",
      "What if the event has no stable ID?",
      "When do transactions not help?",
    ],
    redFlags: [
      "Says exactly-once is free.",
      "Uses a random request ID per attempt.",
      "Keeps a dedupe window shorter than the replay window.",
    ],
    rubric: [
      "Uses a stable event or entity key.",
      "Chooses upsert, dedupe, or transaction by sink.",
      "Sizes the dedupe window against replay.",
    ],
  },
  {
    id: "committed-offset-meaning",
    question: "What exactly does a committed offset represent, and what happens on restart if none exists?",
    difficulty: 1,
    hints: [
      "It is a position in one partition.",
      "The reset policy decides the starting point.",
    ],
    answer:
      "A committed offset is the position of the next record the group intends to read in one partition. It is stored per group and per partition, not as a global topic position. On restart, the member resumes from that offset, so records after it are delivered again. If the group has no committed offset for a partition, the consumer's auto.offset.reset policy decides whether to start at the earliest or latest offset, or fail. That is why a new group can read history or skip it depending on configuration.",
    followUps: [
      "Is the committed offset the last processed record or the next one?",
      "What does latest mean for an existing group?",
      "Why is the offset per partition?",
    ],
    redFlags: [
      "Calls it a global topic offset.",
      "Says the broker tracks the consumer's in-memory position.",
      "Ignores auto.offset.reset.",
    ],
    rubric: [
      "Defines the next record position.",
      "States per-partition scope.",
      "Explains the no-offset reset policy.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Commit policy is documented and matches the sink's idempotency.",
      "The replay window is measured as processing rate times commit interval.",
      "Dashboards show committed offset age, commit rate, and duplicate rate.",
      "Every consumer has a stable dedupe key and a bounded dedupe store.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the processed position with the committed offset before replaying.",
      "Check commit failures and coordinator health.",
      "Protect the sink with idempotent writes before draining a large replay.",
      "Record the restart time, committed offset, and duplicate count.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run a group restart test and verify the duplicate count matches the window.",
      "Tune the commit interval against commit overhead, not only duplicate volume.",
      "Verify the dedupe window is longer than the maximum replay window.",
      "Document the delivery guarantee the pipeline actually provides.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: consumer configs",
    url: "https://kafka.apache.org/44/configuration/consumer-configs/",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "enable.auto.commit, auto.commit.interval.ms, and auto.offset.reset.",
  },
  {
    title: "Apache Kafka documentation: message delivery semantics",
    url: "https://kafka.apache.org/44/design/design/#message-delivery-semantics",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "At-most-once, at-least-once, and exactly-once delivery.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "consumer-groups": {
      model: consumerGroupsModel,
      presets,
      instructions:
        "Start healthy, then apply Crash after slow commits. Watch uncommitted records before the first crash, then replay rate after it. Run the experiment, then try Recovery and compare the window.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Commit intervals, processing times, and restart timings are teaching values, not Kafka defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-kafka-partitions",
    "streaming-rebalancing",
    "streaming-retention",
    "streaming-consumer-lag",
  ],
};
