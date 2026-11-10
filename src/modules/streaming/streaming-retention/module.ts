import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const OUTAGE_START = 3;
const REPLAY_MBPS = 50;
const PARTITIONS = 12;
const REPLICATION = 3;

const params = [
  {
    id: "retentionHours",
    label: "Time retention",
    min: 1,
    max: 168,
    step: 1,
    value: 24,
    unit: " h",
    group: "Retention",
    help: "How long a closed log segment is kept. The active segment is not deleted by time retention.",
    format: "count" as const,
  },
  {
    id: "segmentSizeMb",
    label: "Segment size",
    min: 64,
    max: 1_024,
    step: 64,
    value: 256,
    unit: " MB",
    group: "Retention",
    help: "Roll size for a log segment. Deletion works on whole segments, so a larger segment adds deletion granularity.",
    format: "number" as const,
  },
  {
    id: "produceMbPerSec",
    label: "Produce rate",
    min: 0.1,
    max: 2,
    step: 0.1,
    value: 0.5,
    unit: " MB/s",
    group: "Traffic",
    help: "Write rate into one partition. It sets how fast segments roll and how much storage retention consumes.",
    format: "number" as const,
  },
  {
    id: "outageHours",
    label: "Consumer outage",
    min: 0,
    max: 72,
    step: 1,
    value: 0,
    unit: " h",
    group: "Consumer",
    help: "How long the consumer group is offline before it resumes from its committed offsets. One simulated second represents one hour.",
    format: "count" as const,
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

interface Values {
  retentionHours: number;
  segmentSizeMb: number;
  produce: number;
  outageHours: number;
  rollHours: number;
  availableHours: number;
  elapsedHours: number;
  lostHours: number;
  lostGb: number;
  storageTb: number;
  replayHours: number;
  replaySeconds: number;
  connected: boolean;
  hasOutage: boolean;
}

function compute(p: Params, t: number, jitter: number): Values {
  const retentionHours = Math.max(1, num(p, "retentionHours", 24));
  const segmentSizeMb = Math.max(16, num(p, "segmentSizeMb", 256));
  const produce = Math.max(0.01, num(p, "produceMbPerSec", 0.5) * jitter);
  const outageHours = Math.max(0, num(p, "outageHours", 0));
  const hasOutage = outageHours > 0;
  const rollHours = segmentSizeMb / produce / 3_600;
  const availableHours = retentionHours + rollHours;
  const elapsedHours = hasOutage ? clamp(t - OUTAGE_START, 0, outageHours) : 0;
  const connected = !hasOutage || t < OUTAGE_START || t >= OUTAGE_START + outageHours;
  const lostHours = Math.max(0, elapsedHours - availableHours);
  const retainedHours = Math.min(elapsedHours, availableHours);
  const replayHours = connected && elapsedHours > 0 ? retainedHours : 0;
  const lostGb = (lostHours * 3_600 * produce) / 1_024;
  const storageTb = (retentionHours * 3_600 * produce * PARTITIONS * REPLICATION) / (1_024 * 1_024);
  const replaySeconds = (replayHours * 3_600 * produce) / REPLAY_MBPS;
  return {
    retentionHours,
    segmentSizeMb,
    produce,
    outageHours,
    rollHours,
    availableHours,
    elapsedHours,
    lostHours,
    lostGb,
    storageTb,
    replayHours,
    replaySeconds,
    connected,
    hasOutage,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, jitter: number, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, t, jitter);
  const storageHealth = healthFor(values.storageTb, 3, 6);
  const consumerHealth =
    values.connected === false ? "down" : values.lostHours > 0.01 ? "crit" : "ok";
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "Orders producer",
        kind: "service",
        health: "ok",
        utilization: 0.6,
        sublabel: `${values.produce.toFixed(2)} MB/s`,
        meta: { view: "flow" },
      },
      {
        id: "topic",
        label: "orders topic",
        kind: "stream",
        health: storageHealth,
        sublabel: `${values.retentionHours}h retention · ${values.storageTb.toFixed(2)} TB`,
        detail: `Segments roll after ${values.segmentSizeMb} MB. Effective history is about ${values.availableHours.toFixed(2)} hours because deletion is segment-granular.`,
        meta: {
          retainedHours: values.availableHours,
          storageTb: values.storageTb,
          rollHours: values.rollHours,
        },
      },
      {
        id: "consumer",
        label: "orders-consumers",
        kind: "worker",
        health: consumerHealth,
        utilization: values.connected ? 0.7 : 0,
        capacity: REPLAY_MBPS,
        sublabel:
          values.connected === false
            ? `offline · offset age ${values.elapsedHours.toFixed(1)}h`
            : values.lostHours > 0
              ? `replaying · ${values.replaySeconds.toFixed(0)}s`
              : "current",
        detail:
          values.connected === false
            ? "The group is not committing offsets. Its last committed offset ages while retention keeps deleting from the start of the log."
            : values.lostHours > 0
              ? `The committed offset is older than the earliest retained offset. ${values.lostHours.toFixed(1)} hours are gone and cannot be replayed.`
              : `The committed offset is still inside the retained log. About ${values.replayHours.toFixed(1)} hours remain to replay.`,
        meta: {
          connected: values.connected ? 1 : 0,
          lostHours: values.lostHours,
          replaySeconds: values.replaySeconds,
        },
      },
    ],
    edges: [
      edge("producer-topic", "producer", "topic", clamp(values.produce / 2), "ok"),
      edge("topic-consumer", "topic", "consumer", values.connected ? 0.8 : 0.1, consumerHealth),
    ],
    metrics: [
      metric("retention-shortfall", "Data lost to retention", values.lostHours, " h", 0.5, 2, "count"),
      metric("storage", "Retained storage", values.storageTb, " TB", 3, 6, "number"),
      metric("replay-time", "Replay duration", values.replaySeconds, " s", 1_800, 7_200, "count"),
      metric("retained-history", "Available history", values.availableHours, " h", undefined, undefined, "count"),
      metric("data-loss", "Data lost", values.lostGb, " GB", undefined, undefined, "number"),
      metric("committed-offset-age", "Committed offset age", values.elapsedHours, " h", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      outageStarted: flagNumber(flags, "outageStarted"),
      outageEnded: flagNumber(flags, "outageEnded"),
      gapDetected: flagNumber(flags, "gapDetected"),
    },
    summary:
      values.lostHours > 0.01
        ? `The committed offset is ${values.lostHours.toFixed(1)}h older than the retained log; ${values.lostGb.toFixed(1)} GB cannot be replayed.`
        : values.connected === false
          ? `Consumer offline for ${values.elapsedHours.toFixed(1)}h against ${values.availableHours.toFixed(1)}h of retained history.`
          : `Retained history is ${values.availableHours.toFixed(1)}h at ${values.storageTb.toFixed(2)} TB; no data is outside the window.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.2);
  const series: [string, number][] = [
    ["retention-shortfall", values.lostHours],
    ["storage", values.storageTb],
    ["replay-time", values.replaySeconds],
    ["retained-history", values.availableHours],
    ["data-loss", values.lostGb],
    ["committed-offset-age", values.elapsedHours],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

export const retentionModel: SimModel = {
  id: "streaming-retention",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, 1, {});
    seedSeries(frame, compute(defaults(), 0, 1), seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const jitter = 1 + rng.between(-0.005, 0.005);
    const t = frame.t + Math.max(0, dt);
    const values = compute(p, t, jitter);
    const result = buildFrame(p, t, jitter, frame.flags);
    result.series = frame.series;
    result.events = frame.events;

    if (values.hasOutage && t >= OUTAGE_START && frame.flags.outageStarted !== 1) {
      pushEvent(result, {
        id: "consumer-outage-started",
        at: t,
        severity: "warn",
        title: "The consumer group stopped committing offsets",
        detail: `The group is offline. Its committed offset stays fixed while retention continues to delete segments from the start of the log.`,
        nodeId: "consumer",
        metricId: "committed-offset-age",
      });
      result.flags.outageStarted = 1;
    }
    if (values.lostHours > 0.01 && frame.flags.gapDetected !== 1) {
      pushEvent(result, {
        id: "retention-gap-detected",
        at: t,
        severity: "crit",
        title: "The committed offset is outside the retained log",
        detail: `The group's committed offset is ${values.lostHours.toFixed(1)} hours older than the earliest available offset. On restart the consumer will hit an offset-out-of-range condition and cannot read those records.`,
        nodeId: "consumer",
        metricId: "retention-shortfall",
      });
      result.flags.gapDetected = 1;
    }
    if (
      values.hasOutage &&
      values.connected &&
      values.elapsedHours >= values.outageHours - 0.001 &&
      frame.flags.outageEnded !== 1
    ) {
      pushEvent(result, {
        id: "consumer-outage-ended",
        at: t,
        severity: "info",
        title: "The consumer group is back",
        detail: `It resumes from its committed offset, not from the earliest offset. ${values.lostHours > 0.01 ? `${values.lostHours.toFixed(1)} hours are unrecoverable.` : `It can replay about ${values.replayHours.toFixed(1)} hours.`}`,
        nodeId: "consumer",
        metricId: "replay-time",
      });
      result.flags.outageEnded = 1;
    }

    for (const item of result.metrics) recordSeries(result, item.id, item.value);
    return result;
  },
  thresholds: [
    {
      id: "retention-shortfall",
      metricId: "retention-shortfall",
      warn: 0.5,
      crit: 2,
      title: "The consumer outage is longer than the retained history",
      cause:
        "Retention deletes closed segments once they are older than the time limit or the log exceeds the size limit. A consumer that is offline past that window returns with a committed offset older than the earliest available offset. The records in between are gone; they are not queued for the consumer.",
      fix:
        "Set retention from the longest tolerable consumer outage plus replay time, or archive the topic to object storage before the window closes. On restart, fix the offset-out-of-range condition deliberately instead of skipping records silently.",
      checkFirst: [
        "Compare the consumer's committed offset age with the log start offset.",
        "Check retention.ms, retention.bytes, and the segment size on the topic.",
        "Check whether the consumer is actually offline or just not committing.",
      ],
    },
    {
      id: "storage",
      metricId: "storage",
      warn: 3,
      crit: 6,
      title: "Retained storage is growing beyond the budget",
      cause:
        "Retention is a storage commitment. Time retention multiplied by produce rate, partitions, and replication factor sets the steady-state bytes; a size limit can delete earlier than the time limit.",
      fix:
        "Choose retention from a recovery objective, then budget the disks. Reduce retention, reduce replication, archive cold segments to object storage, or lower the produce rate. Do not shorten retention below the outage you must survive.",
      checkFirst: [
        "Break storage down by topic, partition, and replica.",
        "Check whether a size limit is deleting before the time limit.",
        "Check whether tiered storage or an archive can hold the older segments.",
      ],
    },
    {
      id: "replay-time",
      metricId: "replay-time",
      warn: 1_800,
      crit: 7_200,
      title: "Replay will take longer than the recovery objective",
      cause:
        "Replaying retained history is bounded by the bytes that remain and the consumer's read and processing rate. A long outage plus a large retained window can take hours even when no data is lost.",
      fix:
        "Add replay capacity, reduce the retained window, or split the replay across partitions. Verify the consumer's processing rate, not only its fetch rate, because downstream writes often set the real ceiling.",
      checkFirst: [
        "Measure replay throughput against the real downstream, not a synthetic read.",
        "Check whether the consumer is replaying all partitions in parallel.",
        "Check whether the recovery objective counts time to the first fresh record or to the last replayed record.",
      ],
    },
  ],
  insights: (frame, p) => {
    const values = compute(p, frame.t, 1);
    const items: string[] = [];
    items.push(
      `Segments roll about every ${(values.rollHours * 60).toFixed(1)} minutes at ${values.produce.toFixed(2)} MB/s and ${values.segmentSizeMb} MB; deletion is by segment, so effective history is ${values.availableHours.toFixed(2)}h.`,
    );
    if (values.hasOutage) {
      items.push(
        `The consumer has been offline for ${values.elapsedHours.toFixed(1)}h. Lost data starts only after the retained window is exceeded, not when the outage begins.`,
      );
    }
    if (values.lostHours > 0.01) {
      items.push(
        `The committed offset is ${values.lostHours.toFixed(1)}h behind the earliest retained offset. The consumer cannot read those records; increasing consumer throughput does not bring them back.`,
      );
    } else if (values.elapsedHours > 0) {
      items.push(
        `Everything the consumer missed is still inside the window. Replay is about ${values.replayHours.toFixed(1)}h, or ${values.replaySeconds.toFixed(0)}s at the modeled replay rate.`,
      );
    }
    items.push(
      `Steady-state storage is ${values.storageTb.toFixed(2)} TB for ${values.retentionHours}h with ${PARTITIONS} partitions and replication factor ${REPLICATION}.`,
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "One day of retention, a small segment, and a consumer that is current.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak write rate",
    description: "The same retention at 1.2 MB/s per partition; storage crosses the warning budget.",
    tone: "warn",
    params: defaults({ produceMbPerSec: 1.2 }),
    elapsed: 30,
  },
  {
    id: "failure",
    label: "Two-day outage",
    description: "A 48-hour consumer outage against 24-hour retention; the oldest records are deleted first.",
    tone: "crit",
    params: defaults({ outageHours: 48 }),
    elapsed: 30,
  },
  {
    id: "recovery",
    label: "Longer retention",
    description: "Three days of retention at a lower write rate covers the 48-hour outage with room to replay.",
    tone: "ok",
    params: defaults({ retentionHours: 72, produceMbPerSec: 0.3, outageHours: 48 }),
  },
  {
    id: "tight",
    label: "Tight retention",
    description: "Two hours of retention against a 12-hour outage; the storage bill is small and the data loss is large.",
    tone: "crit",
    params: defaults({ retentionHours: 2, segmentSizeMb: 64, outageHours: 12 }),
  },
];

const experiment: Experiment = {
  id: "predict-retention-loss",
  title: "Predict what a two-day outage costs",
  simId: "streaming-retention",
  question:
    "The topic keeps 24 hours of records and the consumer group is offline for 48 hours. When it returns, what can it read?",
  prediction: {
    options: [
      { id: "all", label: "All 48 hours, because Kafka holds records until every consumer reads them" },
      { id: "retained", label: "The retained window, but the first day of records is already deleted" },
      { id: "none", label: "Nothing, because retention deletes the whole topic at 24 hours" },
      { id: "compacted", label: "Only the latest record per key, because retention compacts the log" },
    ],
    correctOptionId: "retained",
    explanation:
      "Kafka retention is independent of consumer progress. Once a segment is older than the retention limit, it is eligible for deletion even if a consumer has not read it. The consumer's committed offset stays where it was, so on return it is older than the earliest available offset. Records still inside the window can be read; the deleted first day cannot.",
  },
  setup: defaults({ outageHours: 48 }),
  runFor: 55,
  observe: [
    "The committed offset keeps aging while the consumer is offline; no offset is committed.",
    "The shortfall stays at zero until the outage passes the retained history, then it grows.",
    "The consumer returns to a committed offset older than the log start offset.",
    "Data loss is measured in hours and gigabytes, not in consumer lag.",
  ],
  explain:
    "Time retention deletes closed segments whose records are older than the limit; the active segment stays. Because deletion is segment-granular, the effective window is the configured retention plus up to one segment roll. Here a 256 MB segment at 0.5 MB/s rolls in about 8.5 minutes, so the window is roughly 24.1 hours. After that, every additional hour of outage is an hour of records the consumer can never read. Restarting the consumer does not restore them.",
  fix: defaults({ retentionHours: 72, produceMbPerSec: 0.3, outageHours: 48 }),
  debrief:
    "Three days of retention covers the two-day outage, and a lower write rate keeps storage near 2.7 TB. The consumer can replay the missed window, but replay still takes time: about 17 minutes at the modeled 50 MB/s replay rate before downstream processing. The tradeoff is storage cost and a longer replay tail; longer retention is not free, and it is not a substitute for fixing why the consumer was offline.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kafka partition is an append-only log split into segments. Retention decides how long those segments stay. Time retention deletes a closed segment once its records are older than the configured limit. Size retention deletes the oldest segments when the partition exceeds a byte limit. The active segment is not deleted by time retention, so the effective history can be longer than the configured window by up to one segment roll. Deletion is always whole-segment, never record-by-record.",
  },
  {
    type: "p",
    text: "Retention is not a queue and it is not tied to consumer progress. A consumer can be offline for a week; the log keeps deleting on its own schedule. When the consumer returns with a committed offset older than the earliest retained offset, Kafka reports an offset-out-of-range condition. The consumer must reset to the earliest or latest offset, which means the records in between are lost to that consumer. This is the difference between lag, which is a delay, and retention, which is a boundary.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is producer to partition leader to segment files on the broker. Each partition has one active segment that receives appends. When the segment reaches its size or time limit, it rolls and becomes eligible for retention. The broker also tracks the log start offset, the earliest offset still on disk. A consumer group tracks its committed offset separately. The gap between the committed offset and the log start offset is the replay window that still exists; once the committed offset falls behind the log start offset, the window is gone.",
  },
  {
    type: "table",
    headers: ["Control", "What it bounds", "Failure mode"],
    rows: [
      ["retention.ms", "Age of a closed segment", "A consumer offline longer than the window returns to deleted records"],
      ["retention.bytes", "Total bytes per partition", "A size limit can delete before the time limit under a write burst"],
      ["segment.ms / segment.bytes", "When the active segment rolls", "Large segments delay deletion and add effective history"],
      ["log start offset", "Earliest readable record", "Committed offset below it is out of range"],
      ["replication factor", "Copies of every segment", "Storage and network cost scale with copies"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 1 to 168 hours of retention, 64 MB to 1 GB segments, 0.1 to 2 MB/s per partition, and an outage of up to 72 hours. One simulated second represents one hour. The storage estimate assumes 12 partitions and replication factor 3. Those are illustrative teaching values, not Kafka defaults or limits. The shape is the lesson: the log keeps moving while the consumer is away.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Data lost to retention in hours: zero until the outage passes the available history, then it grows.",
      "Retained storage in terabytes: retention times write rate times partitions times replication.",
      "Replay duration in seconds: the retained backlog divided by a modeled replay rate.",
      "Committed offset age: how far behind the consumer's last commit is while it is offline.",
      "A flow view with the producer, the topic, and the consumer, plus offset and segment detail.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Two-day outage. Watch the shortfall stay at zero for the first day and start growing after the retained window is passed. Run the guided experiment before changing sliders, then compare Longer retention and Tight retention on both data loss and storage.",
  },
  { type: "sim", simId: "streaming-retention" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The consumer went offline at three seconds and stopped committing. The log kept appending at 0.5 MB/s. The 256 MB segments rolled about every 8.5 minutes, and segments older than 24 hours were deleted. For the first day of the outage nothing was lost yet, because the committed offset was still inside the retained window. After roughly 24.1 hours, the earliest retained offset passed the committed offset. From then on, every hour offline was an hour of records that could never be read.",
  },
  {
    type: "p",
    text: "By the time the consumer returned at 51 seconds, about 23.9 hours, or 42 GB, were outside the window. The consumer could replay the remaining 24.1 hours, which took about 14.5 minutes at the modeled replay rate before downstream processing. Longer retention covered the same outage with no loss, at the cost of about 2.7 TB of retained storage. Tight retention saved almost all of that storage and lost ten hours of records.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Consumer group offsets: committed offset age and the difference from the log start offset.",
      "Topic and partition metrics: log start offset, log end offset, size, and segment count.",
      "Broker logs: offset out of range on fetch, auto.offset.reset behavior, and failed commits.",
      "Disk metrics: partition size, disk headroom, and retention deletion rate.",
      "Replay behavior: fetch rate, processing rate, downstream write latency, and time to the first fresh record.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the committed offset with the earliest available offset before changing retention. Check retention.ms, retention.bytes, and segment size on the topic, then check whether the consumer was offline or merely not committing. If the offset is already out of range, decide deliberately between earliest and latest; do not let auto.offset.reset choose silently.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the gap: compare committed offset age with the log start offset and the retained history.",
      "Stop the loss: restore the consumer and make it commit again, or pause producers if the downstream cannot tolerate a replay.",
      "Recover what remains: replay the retained window with enough consumer and downstream capacity.",
      "Set retention from the longest tolerable outage plus replay time, not from the current disk size.",
      "Archive older segments to object storage if the recovery objective is longer than the disk budget allows.",
      "Test the recovery path with a real outage duration and measure time to the first fresh record.",
      "Watch storage and replay time together; a longer window is a larger bill and a longer tail.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer retention buys recovery range and costs disk, replication traffic, and replay time.",
      "Size retention protects the disk but can delete records earlier than the time limit during a write burst.",
      "Larger segments reduce file count but make deletion coarser and can extend effective history.",
      "More partitions increase parallelism for replay but multiply segment overhead and storage metadata.",
      "Replication factor protects availability and multiplies retained bytes; reducing it to save storage weakens durability.",
      "Tiered storage can extend history cheaply, but replay from remote storage is slower and has its own failure modes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "offset-out-of-range",
    question:
      "A consumer group was offline for two days. Retention is 24 hours. It restarts and reports an offset-out-of-range error. What happened, and what do you do?",
    difficulty: 2,
    hints: [
      "Retention does not wait for consumer progress.",
      "The committed offset is compared with the log start offset.",
    ],
    answer:
      "The group's committed offset is older than the earliest offset still on the partition. Retention deleted the segments containing the records the group had not read yet. On restart, the fetch for that offset is out of range. I would first confirm the gap by comparing the committed offset, the log start offset, and the retained window. Then I would choose a reset policy deliberately: earliest to replay what remains, or latest to skip to new records. I would record how much data is unrecoverable and tell the dependent teams. The fix is to set retention from the longest tolerable outage plus replay time, or archive the topic so old records are still available outside Kafka.",
    followUps: [
      "How would you find out exactly how many records were lost?",
      "What does auto.offset.reset do, and why is it not a recovery plan?",
      "How would you change retention without affecting other consumers?",
    ],
    redFlags: [
      "Says Kafka retains records until every group reads them.",
      "Resets to latest without quantifying the loss.",
      "Raises retention without checking storage or replay time.",
    ],
    rubric: [
      "Explains offset-out-of-range from the log start offset.",
      "Quantifies the gap before choosing a reset.",
      "Names retention or archival as the prevention.",
      "Considers other consumers and storage cost.",
    ],
  },
  {
    id: "retention-sizing",
    question:
      "How do you choose retention for a topic that must survive a 48-hour consumer outage and still replay in under an hour?",
    difficulty: 3,
    hints: [
      "Retention sets the available history; replay rate sets the recovery time.",
      "Storage is retention times write rate times partitions times replication.",
    ],
    answer:
      "I would start from the recovery objective: 48 hours of outage plus the replay time, with margin for the segment roll. Then I would compute the storage from the write rate, partition count, and replication factor, and check that the disk budget can hold it. I would also verify the replay rate against the real downstream, not the broker's fetch rate, because processing is often the ceiling. If the storage cost is too high, I would archive older segments to object storage rather than shorten retention below the outage. Finally, I would test a replay of the full window and measure time to the first fresh record, not just the last replayed record.",
    followUps: [
      "What margin would you add for segment granularity?",
      "How does a size limit interact with the time limit?",
      "When would tiered storage be the wrong answer?",
    ],
    redFlags: [
      "Sets retention to the outage duration with no replay margin.",
      "Ignores replication in the storage estimate.",
      "Assumes broker fetch rate equals processing rate.",
    ],
    rubric: [
      "Sizes retention from outage plus replay plus margin.",
      "Computes storage with partitions and replication.",
      "Tests replay against the downstream.",
      "Uses archival when the disk budget is the constraint.",
    ],
  },
  {
    id: "per-group-retention",
    question:
      "A new analytics group needs to replay 48 hours, but the topic keeps 24 hours for everyone else. How do you give it more history without doubling production storage?",
    difficulty: 3,
    hints: [
      "Retention is configured on the topic, not per consumer group.",
      "The log can be copied to cheaper storage.",
    ],
    answer:
      "Retention is a topic-level setting, so I cannot give one group a longer window on the same topic. I would either raise retention for the topic and pay the storage cost for every group and replica, or copy the records to an archive or a separate topic with a longer window. A mirror or connector can write the same records to object storage, and the analytics group can replay from there. A third option is a dedicated copy of the topic for analytics, but that duplicates write and storage cost. I would choose by how often the replay happens and how long the history must live; a one-off backfill is usually cheaper from an archive than from a permanently larger Kafka retention.",
    followUps: [
      "What consistency issue arises when the archive lags the topic?",
      "How would you verify the archive has every offset in the window?",
      "When would raising topic retention be the simpler choice?",
    ],
    redFlags: [
      "Claims retention can be set per consumer group.",
      "Raises retention without checking storage for all replicas.",
      "Builds an archive with no offset completeness check.",
    ],
    rubric: [
      "States that retention is topic-level.",
      "Offers archive, mirror, or separate topic options.",
      "Compares one-off backfill with permanent retention.",
      "Verifies offset completeness.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Retention is documented per topic with the outage it is meant to survive.",
      "Log start offset, committed offset, and retained bytes are on a dashboard.",
      "Storage capacity accounts for replication and peak write rate.",
      "A replay runbook exists with a measured downstream processing rate.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the committed offset with the earliest available offset before restarting.",
      "Check whether retention or a size limit caused the deletion.",
      "Choose earliest or latest deliberately; record the data-loss window.",
      "Protect the downstream during replay and watch time to the first fresh record.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile the lost window with dependent teams and downstream state.",
      "Set retention or archival from the measured outage and replay time.",
      "Verify storage after the change and test deletion behavior under peak write rate.",
      "Add an alert for committed offset age approaching the retained window.",
    ],
  },
];

const references = [
  {
    title: "Apache Kafka documentation: topic configs, retention.ms and retention.bytes",
    url: "https://kafka.apache.org/documentation/#topicconfigs_retention.ms",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Time and size retention behavior and the segment-level deletion model.",
  },
  {
    title: "Apache Kafka documentation: broker configs, log.retention.hours and log.segment.bytes",
    url: "https://kafka.apache.org/documentation/#brokerconfigs_log.retention.hours",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Broker defaults and segment roll settings that interact with retention.",
  },
  {
    title: "Confluent documentation: topic configuration reference",
    url: "https://docs.confluent.io/platform/current/installation/configuration/topic-configs.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "Retention, segment, and cleanup policy settings in a managed distribution.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "streaming-retention": {
      model: retentionModel,
      presets,
      instructions:
        "Start Healthy, then apply Two-day outage and watch the shortfall. Compare Longer retention and Tight retention on data loss, storage, and replay time.",
      experimentIds: [experiment.id],
      note: "Illustrative model. One simulated second represents one hour; storage assumes 12 partitions and replication factor 3. The rates are teaching values, not benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-consumer-groups",
    "streaming-kafka-partitions",
    "streaming-partition-count",
    "streaming-consumer-lag",
    "streaming-producer-acks",
  ],
};
