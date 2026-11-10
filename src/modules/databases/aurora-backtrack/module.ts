import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WRITES_PER_MINUTE = 1_800;

const params = [
  {
    id: "minutesSinceChange",
    label: "Time since bad change",
    min: 1,
    max: 120,
    step: 1,
    value: 20,
    unit: " min",
    group: "Incident",
    help: "How long ago the migration changed data. Backtrack must target a time before this point.",
    format: "number" as const,
  },
  {
    id: "backtrackWindowMinutes",
    label: "Backtrack window",
    min: 0,
    max: 120,
    step: 5,
    value: 60,
    unit: " min",
    group: "Backtrack",
    help: "Retention available for rewinding. 0 means backtrack is disabled or unsupported. The service maximum is up to 72 hours for supported engines.",
    format: "number" as const,
  },
  {
    id: "restoreMinutes",
    label: "Restore time",
    min: 10,
    max: 240,
    step: 10,
    value: 90,
    unit: " min",
    group: "Recovery",
    help: "Time to restore a point-in-time copy and cut over. Illustrative; it depends on volume size, engine, and application readiness.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  since: number;
  window: number;
  restore: number;
  enabled: boolean;
  canBacktrack: boolean;
  coverageGap: number;
  rto: number;
  lostMinutes: number;
  lostWrites: number;
  health: Health;
}

function compute(p: Params): Computed {
  const since = clamp(num(p, "minutesSinceChange", 20), 1, 120);
  const window = clamp(num(p, "backtrackWindowMinutes", 60), 0, 120);
  const restore = Math.max(1, num(p, "restoreMinutes", 90));
  const enabled = window > 0;
  const canBacktrack = enabled && since <= window;
  const coverageGap = enabled ? Math.max(0, since - window) : since;
  const rto = canBacktrack ? Math.max(2, 2 + since / 6) : restore;
  const lostMinutes = since;
  const lostWrites = Math.round(lostMinutes * WRITES_PER_MINUTE);
  const health: Health =
    rto >= 30 || coverageGap >= 10 ? "crit" : rto >= 15 || coverageGap >= 1 ? "warn" : "ok";
  return {
    since,
    window,
    restore,
    enabled,
    canBacktrack,
    coverageGap,
    rto,
    lostMinutes,
    lostWrites,
    health,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["rto", values.rto, 0.1],
    ["coverage-gap", values.coverageGap, 0],
    ["lost-writes", values.lostWrites, 10],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "cluster",
        label: "Aurora cluster",
        kind: "db",
        role: "primary",
        health: values.health,
        sublabel: values.canBacktrack ? `rewind ${values.since} min` : "rewind unavailable",
        detail: values.canBacktrack
          ? "Backtrack rewinds the cluster in place to a target time inside the window. It is fast, but every write after that target is discarded."
          : "The target time is outside the backtrack window or backtrack is disabled. Recovery must use a point-in-time restore, which creates a new cluster and takes longer.",
        meta: { view: "timeline" },
      },
      {
        id: "backup",
        label: "Point-in-time backups",
        kind: "storage",
        health: "ok",
        sublabel: "continuous logs",
        detail:
          "Point-in-time recovery restores a new cluster to a chosen time. It is slower than an in-place rewind but is not bounded by the backtrack window and survives cluster deletion.",
        meta: { view: "timeline" },
      },
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: values.health,
        sublabel: values.canBacktrack ? "writes paused during rewind" : `${values.restore} min restore`,
        detail:
          "Both paths interrupt writes. Backtrack pauses the cluster while it rewinds; a restore builds a new cluster and then requires a cutover.",
        meta: { view: "timeline" },
      },
    ],
    edges: [
      edge("cluster-backup", "cluster", "backup", 0.8, "ok", "backups"),
      edge("app-cluster", "app", "cluster", 0.6, values.health, "writes"),
    ],
    metrics: [
      metric("rto", "Recovery time (RTO)", values.rto, " min", 15, 30, "number"),
      metric("coverage-gap", "Outside backtrack window", values.coverageGap, " min", 1, 10, "number"),
      metric("lost-writes", "Writes after target", values.lostWrites, " writes", 50_000, 150_000, "count"),
      metric("window", "Backtrack window", values.window, " min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.canBacktrack
      ? `Backtrack to ${values.since} min ago; RTO ${values.rto.toFixed(1)} min; about ${formatCount(
          values.lostWrites,
        )} writes discarded.`
      : `Backtrack unavailable; restore ${values.restore} min; about ${formatCount(
          values.lostWrites,
        )} writes discarded; window ${values.window} min.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rto",
    metricId: "rto",
    warn: 15,
    crit: 30,
    title: "Recovery takes longer than the service target",
    cause:
      "A full restore builds a new cluster and requires a cutover. If the target time is outside the backtrack window, the faster in-place rewind is not available.",
    fix:
      "Use backtrack when the change is inside the window, or shorten the restore path with pre-built automation and tested cutover. Do not assume a backup is faster than it has been drilled.",
    checkFirst: [
      "Check whether the target time is inside the backtrack window.",
      "Check whether the engine and cluster support backtrack.",
      "Measure restore and cutover separately, including application readiness.",
    ],
  },
  {
    id: "coverage-gap",
    metricId: "coverage-gap",
    warn: 1,
    crit: 10,
    title: "The bad change is outside the backtrack window",
    cause:
      "Backtrack can only rewind to a time inside its retention window. A change older than that cannot be targeted, even if the cluster is otherwise healthy.",
    fix:
      "Use point-in-time recovery to a time before the change, then reconcile writes after the target. Extend the window only if the engine supports it and the cost is justified.",
    checkFirst: [
      "Compare the change time with the window and the current time.",
      "Check whether a point-in-time restore can target the right second.",
      "Check what writes happened after the target and how they will be reconciled.",
    ],
  },
  {
    id: "lost-writes",
    metricId: "lost-writes",
    warn: 50_000,
    crit: 150_000,
    title: "Rewinding discards a large amount of valid work",
    cause:
      "Backtrack and point-in-time restore both return the database to an earlier point. Every write after that point is lost unless it is replayed from application records.",
    fix:
      "Choose the latest target that is still before the bad change, capture an export of the current state for reconciliation, and replay valid writes idempotently.",
    checkFirst: [
      "Find the exact time the bad change was applied.",
      "Capture current data for reconciliation before rewinding.",
      "Check which writes after the target are safe to replay.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function timelineEvents(frame: SimFrame, p: Params): void {
  const values = compute(p);
  pushEvent(frame, {
    id: "bad-change",
    at: 0,
    severity: "warn",
    title: "Bad migration applied",
    detail: `A schema or data change ran ${values.since} minutes ago and altered rows that should not have changed.`,
    nodeId: "cluster",
  });
  pushEvent(frame, {
    id: "detected",
    at: 1,
    severity: "warn",
    title: "Detection",
    detail: "The error is confirmed. Writes continue while the team decides between rewind and restore.",
    nodeId: "app",
  });
  pushEvent(frame, {
    id: "decision",
    at: 2,
    severity: values.canBacktrack ? "info" : "crit",
    title: values.canBacktrack ? "Backtrack is available" : "Backtrack is not available",
    detail: values.canBacktrack
      ? `The target is inside the ${values.window}-minute window; an in-place rewind should take about ${values.rto.toFixed(
          1,
        )} minutes.`
      : `The target is outside the ${values.window}-minute window; a point-in-time restore takes about ${values.restore} minutes.`,
    nodeId: "cluster",
    metricId: "coverage-gap",
  });
}

export const backtrackModel: SimModel = {
  id: "databases-aurora-backtrack",
  visual: "timeline",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    timelineEvents(frame, defaults());
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const key = JSON.stringify(p);
    const changed = frame.flags.eventKey !== key;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    if (changed) {
      next.events = [];
      timelineEvents(next, p);
    } else {
      next.events = [...frame.events];
    }
    if (values.coverageGap > 0 && frame.flags.gapLogged !== 1) {
      pushEvent(next, {
        id: "backtrack-window-missed",
        at: frame.t,
        severity: "crit",
        title: "Backtrack window cannot cover the change",
        detail: `The change is ${values.since} minutes old and the window is ${values.window} minutes; the gap is ${values.coverageGap} minutes.`,
        nodeId: "cluster",
        metricId: "coverage-gap",
      });
    }
    next.flags.gapLogged = values.coverageGap > 0 ? 1 : 0;
    next.flags.eventKey = key;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      values.canBacktrack
        ? `The change is inside the ${values.window}-minute window, so an in-place rewind can target a time before it. The modeled RTO is ${values.rto.toFixed(
            1,
          )} minutes.`
        : `The change is outside the ${values.window}-minute window or backtrack is disabled. The faster in-place path is unavailable, so recovery uses a restore.`,
      `Either path discards writes after its target time. At ${WRITES_PER_MINUTE} writes/min and a ${values.since}-minute window, about ${formatCount(
        values.lostWrites,
      )} writes are lost unless they are replayed.`,
      "Backtrack rewinds the cluster in place. Point-in-time recovery creates a new cluster and then you cut over, so the restore path has more steps and a longer RTO.",
      "Backtrack is not a backup. It is bounded by retention, may not be supported on every engine, and cannot recover a cluster that was deleted.",
      "Before rewinding, export or snapshot the current state for reconciliation. The database is the easiest place to recover the lost writes, and it is about to be rewound.",
    ];
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
    description: "A change 10 minutes old sits well inside a 60-minute window; rewind takes under 4 minutes.",
    tone: "ok",
    params: defaults({ minutesSinceChange: 10, backtrackWindowMinutes: 60, restoreMinutes: 90 }),
  },
  {
    id: "peak",
    label: "Late detection",
    description: "Detection took 50 minutes; rewind still works but discards 90,000 writes.",
    tone: "warn",
    params: defaults({ minutesSinceChange: 50, backtrackWindowMinutes: 60, restoreMinutes: 120 }),
  },
  {
    id: "failure",
    label: "Window missed",
    description: "A change 20 minutes old with backtrack disabled needs a 90-minute restore.",
    tone: "crit",
    params: defaults({ minutesSinceChange: 20, backtrackWindowMinutes: 0, restoreMinutes: 90 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Backtrack is enabled with a 60-minute window; the 20-minute-old change rewinds in about 5 minutes.",
    tone: "ok",
    params: defaults({ minutesSinceChange: 20, backtrackWindowMinutes: 60, restoreMinutes: 90 }),
  },
];

const experiment: Experiment = {
  id: "window-too-short",
  title: "Can this change be rewound?",
  simId: "aurora-backtrack",
  question:
    "A bad migration ran 20 minutes ago. Backtrack is enabled with a 15-minute window and a restore takes 90 minutes. Can you rewind, and what does recovery look like?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. Backtrack targets any time in the last 24 hours." },
      { id: "no-pitr", label: "No. The change is outside the 15-minute window, so use point-in-time recovery before the change." },
      { id: "no-recovery", label: "No. Without backtrack there is no way to recover the data." },
      { id: "yes-restore", label: "Yes. Backtrack can target the 20-minute point and avoid the restore." },
    ],
    correctOptionId: "no-pitr",
    explanation:
      "Backtrack can only rewind to a target inside its retention window. A 15-minute window cannot reach a change 20 minutes old, so the in-place path is unavailable. Point-in-time recovery can restore a new cluster to a time before the change, but it takes longer and requires a cutover. The data is still recoverable; the method changes.",
  },
  setup: defaults({ minutesSinceChange: 20, backtrackWindowMinutes: 15, restoreMinutes: 90 }),
  runFor: 20,
  observe: [
    "The coverage gap is 5 minutes: the change is older than the window.",
    "RTO is 90 minutes, the restore path, not the in-place rewind.",
    "About 36,000 writes after the target are discarded unless replayed.",
    "The decision event marks backtrack unavailable; recovery still exists through point-in-time restore.",
  ],
  explain:
    "The window is a hard boundary. Inside it, backtrack is an in-place rewind with a short RTO. Outside it, the only path is a restore to a new cluster, which takes longer and requires cutover. Both paths lose writes after their target, so the target should be as late as possible while still before the bad change.",
  fix: defaults({ minutesSinceChange: 20, backtrackWindowMinutes: 60, restoreMinutes: 90 }),
  debrief:
    "With a 60-minute window, the same 20-minute-old change is inside retention and rewinds in about 5 minutes in this model. The 36,000 writes after the target are still lost unless they are reconciled. Backtrack changed the RTO, not the data-loss window; the target time decides that.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Aurora Backtrack rewinds an Aurora MySQL-compatible cluster to a point in time inside a retention window, in place. It is not a restore to a new cluster. The cluster becomes the earlier version of itself, and writes after the target are discarded. Because it does not build and copy a new cluster, it can be much faster than a restore.",
  },
  {
    type: "p",
    text: "Point-in-time recovery (PITR) is the alternative. It uses continuous backup logs to create a new cluster at a chosen time, then you cut the application over. PITR is not bounded by the backtrack window, works across more engines, and can recover a deleted cluster. It is usually slower and has more steps.",
  },
  {
    type: "p",
    text: "Backtrack is not a backup. It has a retention limit, it only works on supported engines and cluster configurations, and it rewinds the whole cluster rather than one table. A bad change that is older than the window cannot be backtracked. A cluster that no longer exists cannot be backtracked. Backups and PITR remain the durable recovery path.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The cluster records changes that allow it to rewind within the window. When you choose a target, the cluster rewinds its storage to that point and restarts. The application sees dropped connections and must reconnect after the rewind. If the target is outside the window, the path moves to PITR: build a new cluster, verify it, and cut over.",
  },
  {
    type: "table",
    headers: ["Path", "Scope", "RTO shape", "Main limit"],
    rows: [
      ["Backtrack", "Whole cluster, in place", "Short, bounded by rewind", "Retention window and engine support"],
      ["PITR restore", "New cluster to a chosen time", "Longer, includes cutover", "Restore and verification time"],
      ["Snapshot restore", "New cluster from a snapshot", "Longer, coarse target", "Snapshot interval"],
      ["Replica promotion", "Another copy", "Fast if current", "Only for availability, not bad writes"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Recovery time: warning at 15 minutes and critical at 30 in this model.",
      "Coverage gap: how far the change lies beyond the backtrack window, critical at 10 minutes.",
      "Writes after the target, which both paths discard unless replayed.",
      "A timeline with the bad change, detection, and the recovery decision.",
      "A window slider: shrinking it below the change age removes the fast path.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Window missed. Read the coverage gap before the RTO. Enable backtrack with a window longer than the change age and compare. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Write rates, restore times, and thresholds are illustrative teaching values. Backtrack retention, supported engines, and restore performance depend on the Aurora version, cluster size, and configuration; check the current documentation.",
  },
  { type: "sim", simId: "aurora-backtrack" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With backtrack disabled, a 20-minute-old change had a 20-minute coverage gap and the RTO jumped to the 90-minute restore path. The database was recoverable, but the fast in-place option was not available. About 36,000 writes after the target were still at risk.",
  },
  {
    type: "p",
    text: "Enabling backtrack with a 60-minute window covered the change. The modeled rewind took about 5 minutes, and the same 36,000 writes were discarded. The faster path reduced downtime; it did not reduce data loss, because both paths return to a time before the change.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Aurora events for backtrack start, completion, and any failure, with the target time.",
      "The cluster's backtrack window and whether the target time falls inside it.",
      "Connection drops and application reconnect behavior during the rewind.",
      "Point-in-time restore progress and the new cluster's readiness if backtrack is unavailable.",
      "Application records for writes after the target that need replay or compensation.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the change time with the window before choosing a path. If the change is inside the window and the engine supports backtrack, the in-place rewind is the faster option. If not, start the PITR restore immediately and capture the current state for reconciliation.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the bad write path so the target does not move while you decide.",
      "Find the exact time of the bad change and compare it with the backtrack window.",
      "Capture the current state or an export for reconciliation before rewinding.",
      "Choose the latest target that is still before the bad change.",
      "Run backtrack or start the PITR restore, then verify the data at the target.",
      "Replay valid writes after the target idempotently, or compensate them.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Backtrack is fast and in place, but it is bounded by retention and engine support.",
      "PITR is more flexible and durable, but it builds a new cluster and needs a cutover.",
      "A later target loses less valid work but risks including part of the bad change; choose carefully.",
      "A longer backtrack window protects older mistakes but has storage and cost implications.",
      "Rewinding the whole cluster is simple but affects unrelated writes, not just the bad migration's rows.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "backtrack-vs-pitr",
    question: "When do you use Aurora Backtrack instead of point-in-time recovery?",
    difficulty: 2,
    hints: [
      "Inside the window and supported engine.",
      "Compare RTO and cutover.",
    ],
    answer:
      "I use backtrack when the target time is inside the retention window, the engine supports it, and the whole-cluster rewind is acceptable. It is in place and usually much faster than building and cutting over a new cluster. I use PITR when the change is older than the window, the engine does not support backtrack, the cluster was deleted, or I need a separate copy for verification. Backtrack is not a backup, so PITR remains the durable path.",
    followUps: [
      "What happens to writes after the target?",
      "How would you verify the rewound data?",
      "What if the bad change is older than the window?",
    ],
    redFlags: [
      "Treats backtrack as a backup.",
      "Uses it outside the window.",
      "Ignores engine support.",
    ],
    rubric: [
      "Checks window and support.",
      "Compares RTO and cutover.",
      "Names PITR fallback.",
      "Mentions data loss after target.",
    ],
  },
  {
    id: "data-loss",
    question: "Backtrack completes in five minutes. Is the incident over?",
    difficulty: 3,
    hints: [
      "The target is before the bad change.",
      "Valid writes after the target are gone.",
    ],
    answer:
      "Not necessarily. The rewind discarded every write after the target, including valid work that happened after the bad migration. I would compare application records with the rewound database, replay safe writes idempotently, and compensate the rest. I would also verify that the bad change is actually gone and that dependent services did not cache or propagate the bad data.",
    followUps: [
      "How do you bound the lost writes?",
      "What if a downstream service already consumed them?",
      "How would you prevent a repeat?",
    ],
    redFlags: [
      "Declares recovery complete at rewind.",
      "Ignores valid writes after the target.",
      "Forgets downstream propagation.",
    ],
    rubric: [
      "Names the lost window.",
      "Plans reconciliation.",
      "Checks downstream effects.",
      "Verifies the bad change is gone.",
    ],
  },
  {
    id: "window-design",
    question: "How do you choose a backtrack window?",
    difficulty: 3,
    hints: [
      "Start from detection time.",
      "Balance cost and the age of mistakes you must cover.",
    ],
    answer:
      "I would start from how long it takes to detect a bad change and decide to recover, then add margin for weekends and slower responses. The window must cover the oldest mistake I intend to rewind, not the average. I would compare the storage and cost of a longer window with the RTO benefit, and keep PITR as the path for anything older. I would also test that the window is actually enabled and that the engine supports it.",
    followUps: [
      "What would make you shorten it?",
      "How does detection time affect the choice?",
      "How would you test the path?",
    ],
    redFlags: [
      "Chooses the maximum without a requirement.",
      "Ignores detection time.",
      "Assumes the window is always enabled.",
    ],
    rubric: [
      "Starts from detection and recovery time.",
      "Adds margin.",
      "Balances cost.",
      "Keeps PITR fallback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Backtrack is enabled on supported clusters and the window is documented.",
      "The change-detection time and decision path are measured.",
      "PITR restore and cutover are drilled independently of backtrack.",
      "A reconciliation plan exists for writes after the target.",
      "The team knows that backtrack is not a backup and cannot recover a deleted cluster.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Stop the bad write path before choosing a target.",
      "Compare the change time with the window.",
      "Capture current data for reconciliation before rewinding.",
      "Run the faster path if it is valid, otherwise start the restore immediately.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replay or compensate writes after the target.",
      "Verify dependent services and caches did not keep the bad data.",
      "Record the actual RTO and the data-loss window.",
      "Adjust the window, detection, or migration controls with what you learned.",
    ],
  },
];

const references = [
  {
    title: "Backtracking an Aurora DB cluster",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.Managing.Backtrack.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Backtrack support, retention window, target time, and in-place rewind behavior.",
  },
  {
    title: "Restoring a DB cluster to a specified time",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-pitr.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Point-in-time recovery to a new cluster and the restore and cutover steps.",
  },
  {
    title: "PostgreSQL: Continuous Archiving and Point-in-Time Recovery",
    url: "https://www.postgresql.org/docs/current/continuous-archiving.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Base backups plus WAL replay, the general mechanism behind point-in-time recovery.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "aurora-backtrack": {
      model: backtrackModel,
      presets,
      instructions:
        "Start healthy, apply Window missed, and read the coverage gap before the RTO. Enable backtrack with a window longer than the change age and compare. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Write rates, restore times, and thresholds are teaching values; check Aurora Backtrack support and limits for your engine version.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-backups-pitr",
    "databases-dr-drills",
    "databases-cross-region-rpo",
    "databases-long-transactions",
  ],
};
