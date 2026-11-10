import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAIN_RATE = 20_000;
const MAX_DEPTH = 5_000_000;
const NO_REPLAY_DRAIN = 30 * 86_400;

const params = [
  {
    id: "failureRate",
    label: "Failure rate",
    min: 0.1,
    max: 10,
    step: 0.1,
    value: 0.1,
    unit: "%",
    group: "Traffic",
    help: "Share of the main stream that fails processing and is written to the DLQ.",
    format: "percent" as const,
  },
  {
    id: "replayRate",
    label: "Replay throughput",
    min: 0,
    max: 3_000,
    step: 50,
    value: 200,
    unit: " rec/s",
    group: "Recovery",
    help: "Records per second the replay worker can read, repair, and re-emit. Zero means no replay path is running.",
    format: "rps" as const,
  },
  {
    id: "alerting",
    label: "Alerting and owner",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Operations",
    help: "1 means DLQ depth and age page an owner. 0 means the queue grows without a notification.",
    format: "count" as const,
  },
  {
    id: "retentionDays",
    label: "DLQ retention",
    min: 1,
    max: 14,
    step: 1,
    value: 7,
    unit: " days",
    group: "Retention",
    help: "How long a failed record is kept. If drain time exceeds this window, older records are deleted before replay.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function flag(frame: SimFrame, id: string, fallback = 0): number {
  const value = frame.flags[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Snapshot {
  depth: number;
  arrival: number;
  replayed: number;
  atRisk: number;
  drainSeconds: number;
  timeToAlert: number;
  retentionRatio: number;
  retained: number;
}

function snapshotFor(p: Params, depth: number): Snapshot {
  const failureRate = Math.max(0, num(p, "failureRate", 0.1));
  const replayRate = Math.max(0, num(p, "replayRate", 200));
  const alerting = num(p, "alerting", 1) >= 1;
  const retentionDays = Math.max(1, Math.round(num(p, "retentionDays", 7)));
  const arrival = MAIN_RATE * (failureRate / 100);
  const drainSeconds = depth > 0 ? (replayRate > 0 ? depth / replayRate : NO_REPLAY_DRAIN) : 0;
  const retentionSeconds = retentionDays * 86_400;
  const atRisk = replayRate > 0 ? Math.max(0, depth - replayRate * retentionSeconds) : depth;
  return {
    depth,
    arrival,
    replayed: Math.min(replayRate, depth),
    atRisk,
    drainSeconds,
    timeToAlert: depth > 0 && !alerting ? 86_400 : 0,
    retentionRatio: retentionSeconds > 0 ? drainSeconds / retentionSeconds : 0,
    retained: Math.max(0, depth - atRisk),
  };
}

function buildFrame(t: number, snapshot: Snapshot, flags: SimFrame["flags"]): SimFrame {
  const queueHealth = healthFor(snapshot.depth, 5_000, 25_000);
  const alertHealth = snapshot.timeToAlert > 0 && snapshot.depth > 0 ? "crit" : "ok";
  const replayHealth = snapshot.depth > 0 && snapshot.replayed === 0 ? "crit" : snapshot.depth > 0 ? "warn" : "ok";
  return {
    t,
    nodes: [
      {
        id: "producer",
        label: "orders consumer group",
        kind: "service",
        health: "ok",
        utilization: clamp(snapshot.arrival / Math.max(1, snapshot.arrival + snapshot.replayed)),
        throughput: snapshot.arrival,
        sublabel: `${Math.round(snapshot.arrival).toLocaleString("en-US")} failed rec/s`,
        detail: "Failed records are written to the DLQ instead of blocking the main stream. The DLQ is only as useful as the process that owns it.",
        meta: { view: "flow", arrival: snapshot.arrival },
      },
      {
        id: "alerting",
        label: "DLQ alerting",
        kind: "service",
        health: alertHealth,
        utilization: alertHealth === "crit" ? 1 : 0,
        throughput: 0,
        sublabel: alertHealth === "crit" ? "no owner paged" : "owner paged on depth and age",
        detail: alertHealth === "crit" ? "Depth and age are not being sent to an owner. The queue can grow for days without a human response." : "Depth and age alerts route to a named owner with a runbook.",
        meta: { alerting: snapshot.timeToAlert > 0 ? 0 : 1 },
      },
      {
        id: "dlq",
        label: "orders-dlq",
        kind: "queue",
        health: queueHealth,
        throughput: snapshot.arrival,
        sublabel: `${Math.round(snapshot.depth).toLocaleString("en-US")} waiting · ${(snapshot.retentionRatio).toFixed(2)}x retention`,
        detail: snapshot.depth === 0
          ? "The DLQ is empty. Failures are being handled as they arrive."
          : `The DLQ holds ${Math.round(snapshot.depth).toLocaleString("en-US")} records. At ${Math.round(snapshot.replayed).toLocaleString("en-US")} rec/s of replay, the backlog needs ${Math.round(snapshot.drainSeconds).toLocaleString("en-US")}s to drain against a ${Math.round(snapshot.drainSeconds > 0 ? snapshot.drainSeconds / Math.max(0.001, snapshot.retentionRatio) : 0).toLocaleString("en-US")}s retention window.`,
        meta: { depth: snapshot.depth, atRisk: snapshot.atRisk, retentionRatio: snapshot.retentionRatio },
      },
      {
        id: "replay",
        label: "DLQ replay worker",
        kind: "worker",
        health: replayHealth,
        utilization: snapshot.depth > 0 ? clamp(snapshot.replayed / Math.max(1, snapshot.replayed + 1)) : 0,
        throughput: snapshot.replayed,
        sublabel: snapshot.replayed > 0 ? `${Math.round(snapshot.replayed).toLocaleString("en-US")} rec/s` : "not running",
        detail: "Replay must be idempotent and must preserve the original event metadata. A replay that re-emits failures without a bound is a loop, not a recovery path.",
        meta: { replayed: snapshot.replayed, arrival: snapshot.arrival },
      },
    ],
    edges: [
      edge("producer-dlq", "producer", "dlq", clamp(snapshot.arrival / Math.max(1, snapshot.arrival + snapshot.replayed)), "ok"),
      edge("dlq-replay", "dlq", "replay", snapshot.depth > 0 ? clamp(snapshot.replayed / Math.max(1, snapshot.depth)) : 0, replayHealth),
    ],
    metrics: [
      metric("queueDepth", "DLQ depth", snapshot.depth, " rec", 5_000, 25_000, "count"),
      metric("at-risk-records", "Records at risk", snapshot.atRisk, " rec", 5_000, 25_000, "count"),
      metric("time-to-alert", "Time to alert", snapshot.timeToAlert, " s", 60, 300, "count"),
      metric("retention-ratio", "Drain to retention", snapshot.retentionRatio, "x", 0.5, 1, "number"),
      metric("dlq-arrival", "DLQ arrival rate", snapshot.arrival, " rec/s", undefined, undefined, "rps"),
      metric("replay-throughput", "Replay throughput", snapshot.replayed, " rec/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      ...flags,
      seed: Number(flags.seed ?? 0),
      depth: snapshot.depth,
      atRisk: snapshot.atRisk,
      arrival: snapshot.arrival,
      replayed: snapshot.replayed,
      retentionRatio: snapshot.retentionRatio,
    },
    summary: snapshot.depth === 0
      ? `The DLQ is empty; ${Math.round(snapshot.arrival).toLocaleString("en-US")} failed rec/s are being handled on arrival.`
      : `The DLQ holds ${Math.round(snapshot.depth).toLocaleString("en-US")} records, ${Math.round(snapshot.atRisk).toLocaleString("en-US")} of them at risk of expiring before replay.`,
  };
}

function seedSeries(frame: SimFrame, snapshot: Snapshot, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 17)) / 2.6);
  const values: [string, number][] = [
    ["queueDepth", snapshot.depth],
    ["at-risk-records", snapshot.atRisk],
    ["time-to-alert", snapshot.timeToAlert],
    ["retention-ratio", snapshot.retentionRatio],
    ["dlq-arrival", snapshot.arrival],
    ["replay-throughput", snapshot.replayed],
  ];
  for (const [id, value] of values) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const dlqModel: SimModel = {
  id: "streaming-dlq",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const snapshot = snapshotFor(p, 0);
    const frame = buildFrame(0, snapshot, { seed });
    seedSeries(frame, snapshot, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const seconds = Math.min(1, Math.max(0.01, dt));
    const previousDepth = Math.max(0, flag(frame, "depth"));
    const base = snapshotFor(p, previousDepth);
    const replayRate = Math.max(0, num(p, "replayRate", 200));
    const replayed = Math.min(replayRate * seconds, previousDepth + base.arrival * seconds);
    const depth = Math.min(MAX_DEPTH, Math.max(0, previousDepth + base.arrival * seconds - replayed));
    const snapshot = snapshotFor(p, depth);
    const t = frame.t + seconds;
    const next = buildFrame(t, snapshot, frame.flags);
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (snapshot.depth >= 1_000 && snapshot.timeToAlert > 0 && frame.flags.unnoticed !== 1) {
      pushEvent(next, {
        id: "dlq-unnoticed",
        at: t,
        severity: "crit",
        title: "The DLQ is growing with no owner alerted",
        detail: `${Math.round(snapshot.depth).toLocaleString("en-US")} records are waiting and no alert is configured. The failures are already outside the main path; without an owner they become silent loss.`,
        nodeId: "alerting",
        metricId: "time-to-alert",
      });
      next.flags.unnoticed = 1;
    }
    if (snapshot.depth > 0 && snapshot.timeToAlert === 0 && frame.flags.alerted !== 1) {
      pushEvent(next, {
        id: "dlq-alerted",
        at: t,
        severity: "warn",
        title: "The DLQ has an owner and an alert",
        detail: `${Math.round(snapshot.depth).toLocaleString("en-US")} records are queued. Alerting makes the failure visible, but the backlog still needs replay capacity or a decision to discard.`,
        nodeId: "dlq",
        metricId: "queueDepth",
      });
      next.flags.alerted = 1;
    }
    if (snapshot.atRisk > 0 && frame.flags.retentionRisk !== 1) {
      pushEvent(next, {
        id: "retention-risk",
        at: t,
        severity: "crit",
        title: "Records will expire before they can be replayed",
        detail: `At the current replay rate, ${Math.round(snapshot.atRisk).toLocaleString("en-US")} records are older than the retention window can protect. Increasing retention buys time; it does not create replay capacity.`,
        nodeId: "dlq",
        metricId: "at-risk-records",
      });
      next.flags.retentionRisk = 1;
    }
    if (base.arrival > 0 && frame.flags.dlqSeen !== 1) {
      next.flags.dlqSeen = 1;
    }
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds: [
    {
      id: "queueDepth",
      metricId: "queueDepth",
      warn: 5_000,
      crit: 25_000,
      title: "The DLQ backlog is larger than the operation can absorb",
      cause:
        "Failed records arrive faster than replay drains them. Depth alone does not say whether the failures are old, but a growing depth with a flat replay rate means the operation is falling behind every second.",
      fix:
        "Reduce the failure rate at the source, raise replay capacity, or deliberately discard records under a documented policy. Alert on depth and age, assign an owner, and verify that replay throughput exceeds the arrival rate.",
      checkFirst: [
        "Compare DLQ arrival rate with replay throughput.",
        "Check the age of the oldest record, not only the count.",
        "Check whether the same producer or schema change is causing the failures.",
      ],
    },
    {
      id: "at-risk-records",
      metricId: "at-risk-records",
      warn: 5_000,
      crit: 25_000,
      title: "Retention will delete failures before replay reaches them",
      cause:
        "The backlog is larger than the replay worker can drain within the retention window. The oldest records are on a path to deletion, so the DLQ is holding data it cannot recover in time.",
      fix:
        "Increase replay capacity, extend retention only while the replay plan is credible, or move older records to archival storage before they expire. Measure the drain time against retention, not against a vague future replay.",
      checkFirst: [
        "Compute drain time as depth divided by replay throughput.",
        "Compare that time with the DLQ retention window.",
        "Check whether replay is blocked by the same failure that filled the DLQ.",
      ],
    },
    {
      id: "time-to-alert",
      metricId: "time-to-alert",
      warn: 60,
      crit: 300,
      title: "No one is being paged for DLQ growth",
      cause:
        "The DLQ exists, but depth and age are not wired to an owner. A queue that nobody watches converts visible processing failures into silent data loss, and the first notification becomes a customer report.",
      fix:
        "Alert on DLQ arrival rate, depth, and oldest age; route the alert to a named owner with a runbook; and include a replay or discard decision in the response.",
      checkFirst: [
        "Check whether the DLQ has an alert, an owner, and a runbook.",
        "Check whether the alert fires on arrival rate as well as depth.",
        "Check whether the owner has a replay tool and a retention policy.",
      ],
    },
  ],
  insights: (frame, p) => {
    const depth = flag(frame, "depth");
    const arrival = flag(frame, "arrival");
    const replayed = flag(frame, "replayed");
    const atRisk = flag(frame, "atRisk");
    const alerting = num(p, "alerting", 1) >= 1;
    const items: string[] = [];
    items.push(
      `Failures arrive at ${Math.round(arrival).toLocaleString("en-US")} rec/s and replay drains ${Math.round(replayed).toLocaleString("en-US")} rec/s. The difference sets whether the DLQ grows or shrinks.`,
    );
    items.push(
      `The DLQ holds ${Math.round(depth).toLocaleString("en-US")} records. ${depth === 0 ? "There is no backlog to operate." : `At the current replay rate, draining takes about ${Math.round(depth / Math.max(1, replayed)).toLocaleString("en-US")}s.`}`,
    );
    if (!alerting) {
      items.push("No owner is paged. A DLQ without an alert is a data dump, not a recovery mechanism.");
    } else {
      items.push("An owner is paged. Visibility is necessary but not sufficient; the owner still needs replay capacity and a retention policy.");
    }
    if (atRisk > 0) {
      items.push(`${Math.round(atRisk).toLocaleString("en-US")} records will expire before replay reaches them unless retention or replay capacity changes.`);
    }
    items.push("A DLQ needs four things at once: alerting, ownership, replay, and retention. Removing any one turns failures into silent loss or an unbounded queue.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A low failure rate, an owner, and enough replay capacity to keep the DLQ empty.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Failures arrive faster than replay, so depth grows while the owner is still paged.",
    tone: "warn",
    params: defaults({ failureRate: 2, replayRate: 150 }),
  },
  {
    id: "failure",
    label: "Silent DLQ",
    description: "No replay and no alert. The DLQ grows for days with no owner.",
    tone: "crit",
    params: defaults({ failureRate: 10, replayRate: 0, alerting: 0, retentionDays: 2 }),
  },
  {
    id: "recovery",
    label: "Replay and alert",
    description: "Replay outruns failures, the owner is paged, and retention covers the drain.",
    tone: "ok",
    params: defaults({ failureRate: 10, replayRate: 3_000, alerting: 1, retentionDays: 7 }),
  },
  {
    id: "alert-only",
    label: "Alert only",
    description: "The owner is paged, but no replay runs. The backlog still grows.",
    tone: "crit",
    params: defaults({ failureRate: 10, replayRate: 0, alerting: 1, retentionDays: 7 }),
  },
];

const experiment: Experiment = {
  id: "predict-dlq-gap",
  title: "Predict what a silent DLQ is missing",
  simId: "dlq",
  question:
    "A dead letter queue holds 2 million failed events and no one notices for a week. The queue is durable and retention is long. What is the missing piece?",
  prediction: {
    options: [
      { id: "storage", label: "More storage, because the queue is too small" },
      { id: "alert", label: "An alert, an owner, and a replay path that acts on the failures" },
      { id: "retention", label: "Longer retention, so the records never expire" },
      { id: "partitions", label: "More partitions on the DLQ" },
    ],
    correctOptionId: "alert",
    explanation:
      "Durability only preserves the failure. A DLQ becomes useful when depth and age page an owner, the owner has a replay tool, and replay throughput is enough to drain the backlog before retention deletes it. More storage or longer retention buys time but does not create action. Partitions add parallelism to a consumer, not an owner or a decision.",
  },
  setup: defaults({ failureRate: 10, replayRate: 0, alerting: 0, retentionDays: 2 }),
  runFor: 45,
  observe: [
    "DLQ depth grows at the full failure rate with no replay.",
    "Time to alert stays at a day because no notification is configured.",
    "Retention risk rises as the backlog outgrows the time window.",
    "Adding retention alone does not change the arrival or replay rates.",
  ],
  explain:
    "A DLQ is an operational contract, not a queue. The contract says who watches it, how quickly they respond, how records are replayed, and what happens when retention expires. Without the alert and owner, the queue is a place to hide failures. Without replay, the backlog only grows. Without retention, the queue grows without bound. All four pieces are needed, and each one has a cost.",
  fix: defaults({ failureRate: 10, replayRate: 3_000, alerting: 1, retentionDays: 7 }),
  debrief:
    "With replay at 3,000 rec/s against 2,000 failures/s, the DLQ drains instead of growing. The owner is paged, and the retention window is longer than the drain time. The remaining work is the replay itself: repair the records, re-emit them idempotently, and verify that the downstream state matches. A DLQ that drains without repairing the cause will fill again.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A dead letter queue, or DLQ, is a separate destination for records that could not be processed. It protects the main stream from a poison record or a failing dependency: the consumer moves the bad record aside, commits its offset, and continues. The DLQ retains the failure so it can be inspected, repaired, and replayed instead of disappearing.",
  },
  {
    type: "p",
    text: "The queue itself is the easy part. A DLQ is only useful when four things exist together: an alert on depth and age, a named owner, a replay path with enough throughput, and a retention window long enough for that replay. Remove the alert and failures become silent. Remove the owner and the alert has no action. Remove replay and the queue only grows. Remove retention and it grows without bound. The common failure is a queue that is technically durable and operationally abandoned.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is main topic, consumer, DLQ, replay worker, and back to the main or corrected topic. The consumer writes the failed record and its metadata before advancing the offset. The replay worker reads the DLQ, repairs or re-emits the record, and acknowledges it only after the downstream effect is durable. Retention runs on the DLQ independently of the main topic, so the recovery window is a property of the DLQ, not of the stream that produced it.",
  },
  {
    type: "table",
    headers: ["Piece", "What it answers", "What fails without it"],
    rows: [
      ["Alert", "Does anyone know the DLQ is growing?", "Failures accumulate until a customer reports them"],
      ["Owner", "Who decides repair, replay, or discard?", "The alert has no action and the queue is ignored"],
      ["Replay", "How does a failed record return to the stream?", "The backlog only grows; recovery never starts"],
      ["Retention", "How long is replay possible?", "Old records are deleted before anyone acts"],
      ["Idempotent sink", "Can a replay run twice safely?", "Repair creates duplicates or overwrites newer state"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: a 20,000 records per second main stream, a failure rate from 0.1% to 10%, and a replay worker from 0 to 3,000 records per second. They are teaching values, not SQS or Kafka limits. The shape of the failure is the lesson: arrival rate, replay rate, and retention decide whether the DLQ is a recovery path or a data dump.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "DLQ depth: failed records waiting. Warning at 5,000, critical at 25,000.",
      "Records at risk: records that will expire before replay reaches them.",
      "Time to alert: zero when an owner is paged, a day when no alert exists.",
      "Drain to retention: drain time divided by the retention window. Above 1x, records will expire first.",
      "DLQ arrival and replay throughput, so the net growth rate is visible.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Silent DLQ. Watch depth grow while time to alert stays at a day. Run the experiment before changing sliders, then compare Alert only and Recovery. Watch the difference between visibility and drain.",
  },
  { type: "sim", simId: "dlq" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The main stream failed 10% of 20,000 records per second, so 2,000 records per second entered the DLQ. No replay ran and no owner was paged. Depth grew by 2,000 every second, and the retention window was two days. Time to alert stayed at a day, and records at risk grew with the queue. The DLQ was durable the entire time; that was exactly the problem.",
  },
  {
    type: "p",
    text: "Recovery added replay at 3,000 records per second, paged an owner, and extended retention. The queue drained at 1,000 records per second. The alert made the failure visible, but the drain came from replay capacity. Retention only bought time for the drain to happen.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "DLQ depth and arrival rate, separated from the main topic's lag.",
      "Age of the oldest DLQ record, which is the real replay deadline.",
      "Replay throughput, replay failures, and duplicate suppression at the sink.",
      "Alert history: was the owner paged, acknowledged, and followed by a replay?",
      "Retention and deletion metrics for the DLQ, including records deleted before replay.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the DLQ has an owner and an alert, then compare arrival rate with replay throughput. Compute drain time and compare it with retention. Only then decide whether to add replay capacity, extend retention, or discard records under a documented policy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Page an owner on DLQ arrival rate, depth, and oldest age. A depth-only alert misses slow, steady leaks.",
      "Measure arrival and replay throughput. If arrival is higher, the queue will grow regardless of retention.",
      "Add replay capacity and make replay idempotent. A replay that re-emits the same failure is a loop.",
      "Compare drain time with retention. Extend retention only while a credible replay plan exists.",
      "Fix the producer or schema that caused the failures so the queue stops refilling.",
      "Reconcile the replayed records with the downstream state and record what was discarded.",
      "Re-run at peak and verify that the DLQ drains before retention deletes anything.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer retention protects more replay opportunities but increases storage and the age of recoverable data.",
      "Faster replay recovers sooner but puts load on the same downstream that may have caused the failures.",
      "Automatic replay can create duplicate effects; it needs an idempotent sink or a version check.",
      "Discarding old records bounds the queue but is a data-loss decision that needs an owner and a record.",
      "A per-record DLQ preserves detail; a batch summary is cheaper but loses the ability to replay individual events.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "dlq-operations",
    question:
      "A DLQ has two million events and no one noticed for a week. What is missing, and what do you fix first?",
    difficulty: 3,
    hints: [
      "Depth is a symptom; the missing pieces are operational.",
      "Visibility before replay, but replay before the retention deadline.",
    ],
    answer:
      "The DLQ has no operational contract. I would first establish visibility: alert on arrival rate, depth, and oldest age, and name an owner with a runbook. Then I would measure replay throughput against arrival rate and compute drain time against retention. If records will expire before replay, I would archive or extend retention while adding replay capacity. I would also fix the producer or schema that is filling the queue, because replay without prevention just refills it. The order is alert and owner first, then drain and retention, then root cause.",
    followUps: [
      "Which alert would have caught this earliest?",
      "How do you replay two million events without duplicating effects?",
      "When would you discard instead of replay?",
    ],
    redFlags: [
      "Adds storage and calls it a fix.",
      "Starts replay without an owner or idempotency.",
      "Ignores retention.",
    ],
    rubric: [
      "Names alerting and ownership.",
      "Compares arrival, replay, and retention.",
      "Includes idempotent replay.",
      "Fixes the failure source.",
    ],
  },
  {
    id: "dlq-retention",
    question:
      "How do you choose DLQ retention, and what happens when the drain time exceeds it?",
    difficulty: 3,
    hints: [
      "Retention is a recovery deadline, not a storage setting.",
      "Drain time is depth divided by replay throughput.",
    ],
    answer:
      "I would set retention from the recovery objective and the credible replay rate, not from a storage default. Drain time is depth divided by replay throughput; if it is longer than retention, the oldest records will be deleted before replay reaches them. I would either increase replay capacity, archive older records before deletion, or accept a documented loss window. I would also alert on records at risk, not only on depth, because a large queue with enough replay time is different from a smaller queue that is about to expire.",
    followUps: [
      "What if replay is blocked by the same dependency that caused the failures?",
      "How would you archive records before retention deletes them?",
      "Which metric tells you the deadline is close?",
    ],
    redFlags: [
      "Sets retention without a replay rate.",
      "Assumes retention equals recoverability.",
      "Ignores the age of the oldest record.",
    ],
    rubric: [
      "Computes drain time from depth and replay.",
      "Compares it with retention.",
      "Names a mitigation before deletion.",
      "Alerts on age or records at risk.",
    ],
  },
  {
    id: "dlq-idempotency",
    question:
      "You replay a DLQ into the main topic. How do you prevent the replay from duplicating effects?",
    difficulty: 3,
    hints: [
      "The original event may already have partially succeeded.",
      "The sink needs a stable key and a version or deduplication record.",
    ],
    answer:
      "I would replay through an idempotent path keyed by the original event ID and version, and I would check the downstream state before applying the effect. If the sink supports conditional writes or a deduplication table, the replay can be safely retried. If the effect is not idempotent, I would route the replay to a staging topic, inspect it, and apply it with a controlled procedure. I would also preserve the original topic, partition, offset, key, and timestamp so the replay can be audited and ordered correctly. Replaying at the tail without those checks can overwrite newer state.",
    followUps: [
      "What metadata must the DLQ preserve?",
      "How would you replay one key without stopping the topic?",
      "When is at-least-once replay acceptable?",
    ],
    redFlags: [
      "Replays blindly and assumes idempotence.",
      "Drops the original offset and key.",
      "Replays at the tail for a versioned entity.",
    ],
    rubric: [
      "Names a stable key and version.",
      "Checks downstream state or uses a dedupe store.",
      "Preserves original metadata.",
      "Describes a controlled replay path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every DLQ has a named owner, a runbook, and an alert on arrival rate, depth, and oldest age.",
      "Replay throughput is measured and exceeds the expected failure arrival rate.",
      "Retention is longer than the drain time for the expected backlog.",
      "The replay path is idempotent and preserves the original event metadata.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the owner is paged and the DLQ alert is firing.",
      "Compare arrival rate with replay throughput before adding storage.",
      "Compute drain time against retention and protect records that are about to expire.",
      "Fix the producer or schema that is filling the queue.",
      "Record what was replayed, repaired, or discarded.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile replayed records with downstream state.",
      "Verify that the DLQ is empty or draining at the expected rate.",
      "Remove temporary retention extensions once the backlog is gone.",
      "Add a failure-injection test that fills the DLQ and verifies the alert and replay.",
    ],
  },
];

const references = [
  {
    title: "Amazon SQS documentation: using dead-letter queues",
    url: "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "DLQ redrive policy, message retention, and redrive to source.",
  },
  {
    title: "Apache Kafka documentation: Kafka Connect user guide, error reporting",
    url: "https://kafka.apache.org/documentation/#connect_user",
    publisher: "Apache Software Foundation",
    kind: "docs" as const,
    note: "Error reporting modes and dead letter queue behavior for failed records.",
  },
  {
    title: "Confluent documentation: view connector dead letter queue errors",
    url: "https://docs.confluent.io/cloud/current/connectors/dead-letter-queue.html",
    publisher: "Confluent",
    kind: "docs" as const,
    note: "How connector serde failures are routed to a DLQ and identified from record headers.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    dlq: {
      model: dlqModel,
      presets,
      instructions:
        "Start Healthy, then apply Silent DLQ. Watch depth grow while time to alert stays at a day. Run the experiment, then compare Alert only and Recovery. Watch arrival, replay, and retention together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Rates and retention windows are teaching values, not SQS or Kafka limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-poison-messages",
    "streaming-retention",
    "streaming-consumer-lag",
    "streaming-slow-consumers",
    "streaming-sqs-visibility",
  ],
};
