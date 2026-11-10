import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "retentionHours",
    label: "PITR retention",
    min: 0,
    max: 35,
    step: 1,
    value: 35,
    unit: " h",
    group: "Backup policy",
    help: "How far back archived logs and backups are kept. 0 disables PITR. The slider bound is a model limit; check your engine's documented range.",
    format: "number" as const,
  },
  {
    id: "incidentHoursAgo",
    label: "Damage age",
    min: 0.05,
    max: 72,
    step: 0.05,
    value: 2,
    unit: " h",
    group: "Incident",
    help: "How long ago the bad change happened. If it is older than retention, PITR cannot reach it.",
    format: "number" as const,
  },
  {
    id: "walArchiveLag",
    label: "WAL archive delay",
    min: 0,
    max: 900,
    step: 10,
    value: 10,
    unit: " s",
    group: "Backup",
    help: "How far the newest archived write-ahead log (WAL) is behind the latest commit. A recovery target is not reachable until its WAL is archived.",
    format: "number" as const,
  },
  {
    id: "baseBackupAgeHours",
    label: "Base backup age",
    min: 1,
    max: 24,
    step: 1,
    value: 6,
    unit: " h",
    group: "Backup",
    help: "Age of the newest usable base backup. If PITR is unavailable, this becomes the recovery point and the data-loss window.",
    format: "number" as const,
  },
  {
    id: "restoreMinutes",
    label: "Measured restore time",
    min: 5,
    max: 120,
    step: 1,
    value: 20,
    unit: " min",
    group: "Recovery",
    help: "Time to restore the base backup, replay logs to the target, and validate the result. Illustrative measured value.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  retention: number;
  incidentAge: number;
  archiveLag: number;
  baseAge: number;
  restore: number;
  pitrEnabled: boolean;
  withinRetention: boolean;
  recoveryPointSeconds: number;
  dataLossSeconds: number;
  pitrGapHours: number;
  targetWaitSeconds: number;
  archiveHealth: Health;
  targetHealth: Health;
}

function compute(p: Params): Computed {
  const retention = clamp(num(p, "retentionHours", 35), 0, 35);
  const incidentAge = clamp(num(p, "incidentHoursAgo", 2), 0, 72);
  const archiveLag = clamp(num(p, "walArchiveLag", 10), 0, 900);
  const baseAge = clamp(num(p, "baseBackupAgeHours", 6), 1, 24);
  const restore = clamp(num(p, "restoreMinutes", 20), 5, 120);
  const pitrEnabled = retention > 0;
  const withinRetention = pitrEnabled && incidentAge <= retention;
  const recoveryPointSeconds = withinRetention ? archiveLag : baseAge * 3_600;
  const pitrGapHours = pitrEnabled ? Math.max(0, incidentAge - retention) : incidentAge;
  const targetWaitSeconds = withinRetention ? Math.max(0, archiveLag - incidentAge * 3_600) : 0;
  const archiveHealth: Health = !withinRetention
    ? "crit"
    : targetWaitSeconds > 300
      ? "crit"
      : targetWaitSeconds > 60 || archiveLag > 60
        ? "warn"
        : "ok";
  const targetHealth: Health =
    recoveryPointSeconds > 900 || restore > 60
      ? "crit"
      : recoveryPointSeconds > 60 || restore > 30
        ? "warn"
        : "ok";
  return {
    retention,
    incidentAge,
    archiveLag,
    baseAge,
    restore,
    pitrEnabled,
    withinRetention,
    recoveryPointSeconds,
    dataLossSeconds: recoveryPointSeconds,
    pitrGapHours,
    targetWaitSeconds,
    archiveHealth,
    targetHealth,
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3_600) return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)} min`;
  return `${(seconds / 3_600).toFixed(seconds < 36_000 ? 1 : 0)} h`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["data-loss", values.dataLossSeconds, 3],
    ["restore-time", values.restore, 0.2],
    ["pitr-gap", values.pitrGapHours, 0.02],
    ["target-wait", values.targetWaitSeconds, 2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "primary",
        label: "Primary · live traffic",
        kind: "db",
        role: "primary",
        health: "ok",
        utilization: 0.55,
        sublabel: "serving reads and writes",
        detail: "The primary keeps committing while you restore elsewhere. PITR does not pause it.",
        meta: { lag: 0 },
      },
      {
        id: "wal-archive",
        label: "WAL archive",
        kind: "storage",
        health: values.archiveHealth,
        utilization: values.withinRetention ? clamp(values.targetWaitSeconds / 900) : 1,
        sublabel: values.withinRetention
          ? `${formatDuration(values.archiveLag)} behind · target ${
              values.targetWaitSeconds > 0 ? "not ready" : "ready"
            }`
          : "no recoverable point in retention",
        detail: values.withinRetention
          ? "The archive holds the log needed for the target once the delay has passed. A delay is not the same as a missing backup."
          : "The damage is older than retention. The newest archived backup cannot reach it, so recovery falls back to the base backup.",
        meta: { lag: values.archiveLag, retention: values.retention },
      },
      {
        id: "restore-target",
        label: "Restore target",
        kind: "db",
        health: values.targetHealth,
        utilization: clamp(values.dataLossSeconds / 3_600),
        sublabel: `${formatDuration(values.dataLossSeconds)} data loss · ${values.restore} min restore`,
        detail: values.withinRetention
          ? "The recovery point is a second in the past, not the restore completion time. Choose the second before the bad change."
          : "A base-backup restore lands at the backup's point in time. Everything committed after it is gone unless another source has it.",
        meta: { rpo: values.dataLossSeconds, rto: values.restore },
      },
    ],
    edges: [
      edge("wal-flow", "primary", "wal-archive", values.withinRetention ? 0.9 : 0.2, values.archiveHealth, "WAL shipping"),
      edge("restore-flow", "wal-archive", "restore-target", values.withinRetention ? 0.8 : 0.3, values.targetHealth, "base backup + replay"),
    ],
    metrics: [
      metric("data-loss", "Data loss at recovery point", values.dataLossSeconds, " s", 60, 900, "number"),
      metric("restore-time", "Restore time (RTO)", values.restore, " min", 30, 60, "number"),
      metric("pitr-gap", "Damage outside retention", values.pitrGapHours, " h", 0.5, 1, "number"),
      metric("target-wait", "Wait for target WAL", values.targetWaitSeconds, " s", 60, 300, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.withinRetention
      ? `PITR covers the incident. Recovery point is ${formatDuration(
          values.dataLossSeconds,
        )} old; target ${values.targetWaitSeconds > 0 ? "not archived yet" : "is archived"}; restore ${values.restore} min.`
      : `PITR does not reach the damage: ${values.pitrGapHours.toFixed(
          1,
        )} h outside retention. Fall back to a ${values.baseAge} h base backup, losing up to ${formatDuration(
          values.dataLossSeconds,
        )}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "data-loss",
    metricId: "data-loss",
    warn: 60,
    crit: 900,
    title: "Recovery point is older than the RPO",
    cause:
      "The newest recoverable point is either limited by the base backup, because PITR cannot reach the damage, or by the archived log delay. Both are data-loss windows, not restore-time problems.",
    fix:
      "Restore to the second before the destructive change, not to the latest available point. Extend retention, repair the archive, or use a newer base backup when the target is unreachable.",
    checkFirst: [
      "Compare the damage time with the retention window before promising a target.",
      "Check `pg_stat_archiver` for failed or delayed archival on self-managed PostgreSQL.",
      "Check the managed service's latest restorable time, not the time of the last snapshot.",
    ],
  },
  {
    id: "restore-time",
    metricId: "restore-time",
    warn: 30,
    crit: 60,
    title: "Restore exceeds the RTO",
    cause:
      "Restore time includes provisioning, copying the base backup, replaying WAL to the target, and validating the result. It grows with database size and log volume and is independent of how far back the target sits.",
    fix:
      "Measure a real restore, keep a warm standby or clone path for large databases, pre-provision capacity, and rehearse validation and cutover alongside the database restore.",
    checkFirst: [
      "Measure the last real restore, not the backup duration.",
      "Separate copy time from WAL replay and validation time.",
      "Check whether the application can be pointed at the restored instance without a full redeploy.",
    ],
  },
  {
    id: "pitr-gap",
    metricId: "pitr-gap",
    warn: 0.5,
    crit: 1,
    title: "Damage is outside the PITR window",
    cause:
      "Retention is shorter than the age of the change, or PITR is disabled. No replay target inside the window can undo the damage; only a base backup remains.",
    fix:
      "Set retention longer than the longest undetected corruption you expect, keep independent base backups, and alert before the recoverable window shrinks past the damage.",
    checkFirst: [
      "Compare the incident timestamp with the documented retention period.",
      "Confirm PITR is enabled and the archive is continuous, not just that snapshots exist.",
      "Check whether an older manual snapshot or logical export covers the gap.",
    ],
  },
  {
    id: "target-wait",
    metricId: "target-wait",
    warn: 60,
    crit: 300,
    title: "The target second is not archived yet",
    cause:
      "The commit happened more recently than the archive delay. PITR can only replay WAL that has reached the archive, so a valid target second may exist in the database but not yet be recoverable.",
    fix:
      "Shorten the archive interval, repair the archive command, and wait for the target segment before starting the restore. Do not restore to an earlier point merely because it is available.",
    checkFirst: [
      "Check when the target WAL segment was last archived.",
      "Check archive failures and retries, not only the current lag.",
      "Decide whether waiting for the correct target is shorter than accepting a larger loss.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const pitrModel: SimModel = {
  id: "databases-backups-pitr",
  visual: "timeline",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, values, seed);
    pushEvent(frame, {
      id: "backup-ready",
      at: 0,
      severity: "info",
      title: "Base backup and archive online",
      detail: `Newest base backup is ${values.baseAge} h old. WAL archive delay is ${formatDuration(values.archiveLag)}.`,
      nodeId: "wal-archive",
    });
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
    }
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (!values.withinRetention && frame.flags.outsideLogged !== 1) {
      pushEvent(next, {
        id: "outside-retention",
        severity: "crit",
        title: "No PITR target reaches the damage",
        detail: `The change is ${values.incidentAge.toFixed(1)} h old and retention is ${
          values.retention
        } h. A base-backup restore loses up to ${formatDuration(values.dataLossSeconds)}.`,
        nodeId: "wal-archive",
        metricId: "data-loss",
      });
    }
    if (values.withinRetention && values.targetWaitSeconds > 0 && frame.flags.waitLogged !== 1) {
      pushEvent(next, {
        id: "target-not-archived",
        severity: "warn",
        title: "Target WAL is still in flight",
        detail: `Wait about ${formatDuration(values.targetWaitSeconds)} before the target second can be replayed. The restore clock has not started yet.`,
        nodeId: "wal-archive",
        metricId: "target-wait",
      });
    }
    next.flags = {
      ...frame.flags,
      ...next.flags,
      outsideLogged: values.withinRetention ? 0 : 1,
      waitLogged: values.withinRetention && values.targetWaitSeconds > 0 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.withinRetention) {
      items.push(
        `PITR can reach the damage. The recovery point is ${formatDuration(
          values.dataLossSeconds,
        )} old because the archive is ${formatDuration(values.archiveLag)} behind.`,
      );
      if (values.targetWaitSeconds > 0) {
        items.push(
          `The exact target second is not archived yet. Wait about ${formatDuration(
            values.targetWaitSeconds,
          )}; starting now would restore to an earlier, safer but older point.`,
        );
      } else {
        items.push("The target second is archived, so the restore can begin without waiting for WAL.");
      }
    } else {
      items.push(
        `The damage is ${values.pitrGapHours.toFixed(
          1,
        )} h outside retention. PITR cannot target it; the base backup sets the recovery point at ${values.baseAge} h old.`,
      );
    }
    items.push(
      `Restore time is ${values.restore} min. It is the time to copy and replay, not the data-loss window. A fast restore can still land at the wrong second.`,
    );
    items.push(
      "The target should be just before the destructive statement, not the latest restorable second, when the bad change time is known.",
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

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "PITR covers the incident, the target log is archived, and the last measured restore is 15 minutes.",
    tone: "ok",
    params: defaults({ retentionHours: 35, incidentHoursAgo: 2, walArchiveLag: 5, restoreMinutes: 15 }),
  },
  {
    id: "peak",
    label: "Near retention edge",
    description: "The damage is 7.8 hours old with 8 hours of retention. The target is reachable but the margin is thin.",
    tone: "warn",
    params: defaults({
      retentionHours: 8,
      incidentHoursAgo: 7.8,
      walArchiveLag: 120,
      baseBackupAgeHours: 6,
      restoreMinutes: 35,
    }),
  },
  {
    id: "failure",
    label: "PITR disabled",
    description: "Retention is off and the damage is 6 hours old. Only the 6-hour base backup is available.",
    tone: "crit",
    params: defaults({
      retentionHours: 0,
      incidentHoursAgo: 6,
      walArchiveLag: 120,
      baseBackupAgeHours: 6,
      restoreMinutes: 45,
    }),
  },
  {
    id: "archive-gap",
    label: "Archive lag",
    description: "Retention covers the damage, but the WAL archive is 10 minutes behind a 6-minute-old change.",
    tone: "warn",
    params: defaults({
      retentionHours: 35,
      incidentHoursAgo: 0.1,
      walArchiveLag: 600,
      baseBackupAgeHours: 6,
      restoreMinutes: 25,
    }),
  },
  {
    id: "recovery",
    label: "Restored inside targets",
    description: "The archive is current, the target is reachable, and the measured restore is 12 minutes.",
    tone: "ok",
    params: defaults({ retentionHours: 35, incidentHoursAgo: 2, walArchiveLag: 5, restoreMinutes: 12 }),
  },
];

const experiment: Experiment = {
  id: "predict-target-wait",
  title: "Predict whether the target can be restored now",
  simId: "backups-pitr",
  question:
    "PITR is enabled with 35-day retention. A bad migration ran 3 minutes ago. The WAL archive is 15 minutes behind. Can you restore to the second before the migration right now?",
  prediction: {
    options: [
      { id: "now", label: "Yes. PITR reads WAL directly from the primary on demand." },
      { id: "wait", label: "Not yet. Wait for the target WAL to be archived, roughly 12 more minutes." },
      { id: "base", label: "No. PITR can only restore the most recent base backup." },
      { id: "latest", label: "Yes, to the latest restorable second; the target does not matter." },
    ],
    correctOptionId: "wait",
    explanation:
      "PITR replays archived WAL up to the target. The target is 3 minutes old, but the archive is 15 minutes behind, so the WAL containing that second has not arrived yet. Waiting about 12 more minutes makes the target reachable. Retention is not the constraint here; archive delay is.",
  },
  setup: defaults({
    retentionHours: 35,
    incidentHoursAgo: 0.05,
    walArchiveLag: 900,
    baseBackupAgeHours: 6,
    restoreMinutes: 20,
  }),
  runFor: 20,
  observe: [
    "The damage is inside retention, so the PITR gap stays at zero.",
    "Data loss at the newest recovery point is 900 seconds and crosses the critical threshold.",
    "The wait for the target WAL is about 12 minutes, also critical.",
    "The archive node is failing because the target is not available, not because retention expired.",
    "Restore time is 20 minutes and starts only after a usable target exists.",
  ],
  explain:
    "A recovery target is a second in the past, but it is only usable when the WAL covering that second has reached the archive. The archive delay is the distance between what the primary has committed and what the restore path can read. Retention tells you how far back you may go; archive delay tells you how far forward you can reach right now.",
  fix: defaults({ retentionHours: 35, incidentHoursAgo: 0.05, walArchiveLag: 30, restoreMinutes: 20 }),
  debrief:
    "With the archive 30 seconds behind, the same 3-minute-old target is reachable and the data-loss window drops to 30 seconds. The fix is not more retention; it is a shorter, healthier archive path. A restore runbook should state both the target second and the earliest time that target can be restored.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Point-in-time recovery (PITR) rebuilds a database at a chosen second by combining a base backup with continuous write-ahead log (WAL). The base backup is a consistent copy of the data files. The WAL contains every change after that copy. PostgreSQL replays WAL until it reaches the recovery target, then stops. Amazon RDS automated backups use the same idea and let you restore to a point within the backup retention period.",
  },
  {
    type: "p",
    text: "PITR is not an undo button. It creates a new database at an earlier point. The bad migration still exists in the live database, and any work committed after the target is not in the restored copy. That is why the target matters: restoring to the second before the migration preserves 14:00 through 14:06:59. Restoring to the latest second preserves the migration and the deleted rows are still gone.",
  },
  {
    type: "p",
    text: "The recoverable window has two boundaries. Retention sets how far back you may go. Archive delay sets how far forward you can reach right now. A change that is inside retention can still be unreachable if the WAL covering it has not been archived. A base backup that is six hours old can be the only fallback if PITR is disabled or the damage is older than retention.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The primary writes WAL locally, then an archive process copies completed segments to durable storage. A restore provisions a new instance, loads the base backup, fetches WAL from the archive, and replays to the target. The application is not cut over until the restored instance has passed validation. Database restore, DNS or endpoint cutover, and application warmup are separate steps with separate clocks.",
  },
  {
    type: "table",
    headers: ["Objective", "Question it answers", "This module's signal"],
    rows: [
      ["RPO", "How much data may be lost?", "Age of the chosen recovery point"],
      ["RTO", "How long may recovery take?", "Copy, replay, validate, cut over"],
      ["Retention", "How far back can PITR go?", "Damage age versus retention window"],
      ["Archive delay", "How far forward can PITR reach?", "Wait for the target WAL"],
    ],
  },
  {
    type: "p",
    text: "Managed services report a latest restorable time rather than a backup timestamp. That value moves as logs arrive. For self-managed PostgreSQL, `pg_stat_archiver` shows the last archived segment, failures, and retries; the recovery target is set with `recovery_target_time` and related settings. In both cases, the number you promise the business must come from a restore you have measured.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Data loss at the recovery point: the age of the newest point you can actually restore.",
      "Restore time: copy, replay, and validation, shown separately from data loss.",
      "Damage outside retention: hours by which the incident exceeds the recoverable window.",
      "Wait for target WAL: seconds until the exact target second is archived.",
      "Archive node state: ready, delayed, or unable to reach the damage.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply PITR disabled and read the data-loss line before moving a slider. Next apply Archive lag and notice that retention is fine while the target is still unreachable. Change the damage age across the retention boundary, then shorten the archive delay to see recovery return. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Restore times, retention bounds in the slider, and thresholds are illustrative teaching values. They are not Amazon RDS or PostgreSQL guarantees.",
  },
  { type: "sim", simId: "backups-pitr" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With PITR disabled and a six-hour-old base backup, the recovery point was six hours in the past. Restoring took 45 minutes, but the restore time was not the main loss: everything committed after the base backup was missing. The retention gap was six hours and the data-loss metric crossed critical before the restore even started.",
  },
  {
    type: "p",
    text: "In the archive-lag preset, retention was ample. The target was still unreachable because the WAL was ten minutes behind a six-minute-old change. Data loss at the newest point was ten minutes, and the exact target needed another four minutes of archive progress. Retention and archive delay are different constraints, and only one of them appears in a backup policy document.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`pg_stat_archiver`: last archived WAL, last archived time, failed attempts, and whether the archive command is keeping up.",
      "Managed service: the latest restorable time, backup retention period, and restore job status. The latest restorable time is usually more recent than the last snapshot.",
      "Restore logs: base backup copy progress, WAL fetch failures, replay position, and the recovery target actually reached.",
      "Application validation: row counts, checksums, foreign-key checks, and a sample of known records before cutover.",
      "Cutover: endpoint change, connection-pool recycle, and error rate after traffic moves. A successful restore is not a successful recovery.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the damage time with retention, then check whether the WAL for the target second has been archived. If both are fine, the restore can start; if either fails, the target is unreachable no matter how fast the restore hardware is. Do not restore over the live database.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop writes that would make the damage worse, and record the exact time of the bad change.",
      "Choose the target second just before the change. Write it down with a time zone.",
      "Check retention and archive progress for that second before starting the restore.",
      "Restore to a new instance or cluster. Keep the damaged database intact for comparison.",
      "Validate the restored copy: schema version, row counts, critical records, and application smoke tests.",
      "Cut over the writer endpoint, recycle pools, and watch error rates and constraint violations.",
      "Replay or re-enter legitimate writes made after the target, using idempotency keys and an audit log.",
      "Fix the root cause, then schedule a restore drill that proves the new target and timing.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer retention protects against late-detected corruption but increases backup storage and cost.",
      "A later recovery point loses less recent work but may include the damage. An earlier target is safer but discards more good writes.",
      "Restoring to a new instance preserves evidence and allows validation, but needs capacity and a cutover step.",
      "Snapshot-based recovery is faster than replaying a long WAL chain, but its recovery point is the snapshot, not a chosen second.",
      "Aggressive archive intervals shorten the wait for a target but add archive load and storage churn.",
      "A restore drill costs engineering time and production-like capacity; skipping it leaves the RTO and RPO unproven.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "restore-bad-migration",
    question:
      "A migration deletes rows at 14:07. Backups are enabled and retention is 35 days. Walk me through the recovery.",
    difficulty: 3,
    hints: [
      "Pick the target second before the statement, not the latest second.",
      "Check that the WAL for that second is archived.",
    ],
    answer:
      "I would stop further writes that could widen the damage and confirm the exact statement time. Then I would choose 14:06:59 as the target, verify that the WAL covering that second is archived, and restore to a new instance. After the restore I would validate row counts, constraints, and known records, then cut over the writer endpoint and recycle connection pools. Writes made after 14:07 that are legitimate would be replayed from application logs or an outbox with idempotency keys. I would keep the damaged instance for comparison and fix the migration before retrying.",
    followUps: [
      "What if the WAL for 14:06:59 is not archived yet?",
      "How do you recover writes made after 14:07?",
      "How would the answer change for a 2 TB database?",
    ],
    redFlags: [
      "Restores to the latest second and keeps the deletion.",
      "Restores over the live database.",
      "Promises a target without checking archive progress.",
    ],
    rubric: [
      "Chooses the second before the change.",
      "Checks retention and archive progress.",
      "Restores to a new instance and validates.",
      "Plans replay of post-target writes.",
    ],
  },
  {
    id: "rpo-vs-rto",
    question: "How can a restore meet its RTO and still fail its RPO?",
    difficulty: 2,
    hints: [
      "One clock measures time, the other measures lost data.",
      "A fast restore can land at an old point.",
    ],
    answer:
      "RTO is how long recovery takes; RPO is how much data is lost. A restore can finish in 20 minutes and still land on a six-hour-old base backup, which meets the time target and misses the data target. The reverse also happens: the correct second may be available, but replay and validation take longer than the RTO. I would report both measured values from the same drill, because optimizing one does not imply the other.",
    followUps: [
      "Which one would you trade during a regional outage?",
      "How do you measure the recovery point that was actually reached?",
      "What makes replay time grow?",
    ],
    redFlags: [
      "Treats RTO and RPO as the same number.",
      "Assumes a recent backup means a recent recovery point.",
      "Reports configured targets instead of measured results.",
    ],
    rubric: [
      "Defines both objectives correctly.",
      "Gives a concrete fast-restore, old-point example.",
      "Separates restore completion from recovery point.",
      "Reports both from a drill.",
    ],
  },
  {
    id: "test-restore",
    question: "How do you test PITR without putting production data at risk?",
    difficulty: 3,
    hints: [
      "Restore to an isolated instance, not in place.",
      "Verify the target second, not just that the restore finished.",
    ],
    answer:
      "I would restore a production backup to an isolated instance or account with no route to live traffic, then replay to a known target second and run validation queries against it. I would record copy time, replay time, validation time, and the actual recovery point reached. I would also test the failure paths: a target outside retention, an archive gap, and a restore with the application cutover. The drill should use the same runbook and access path as a real incident, otherwise it proves a different procedure.",
    followUps: [
      "What do you validate before declaring the restore successful?",
      "How often should the drill run?",
      "How do you keep the restored copy from leaking production data?",
    ],
    redFlags: [
      "Tests by restoring over a staging copy of the same database.",
      "Checks only that the restore job completed.",
      "Skips cutover and application validation.",
    ],
    rubric: [
      "Uses an isolated restore target.",
      "Replays to a known second.",
      "Records measured RPO and RTO.",
      "Tests failure paths and cutover.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "PITR is enabled and the retention window is longer than the longest undetected corruption you expect.",
      "The base backup schedule and WAL archive are monitored separately.",
      "A restore drill has measured copy, replay, validation, and cutover time.",
      "The runbook states how to choose the target second and who approves the data loss.",
      "Restored instances are isolated by default and have a defined validation checklist.",
      "Application logs or an outbox can replay legitimate writes made after the target.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Record the exact time of the bad change and the intended recovery target.",
      "Verify retention and archive progress for that second before starting.",
      "Restore to a new instance and keep the damaged database.",
      "Validate data and application behavior before cutover.",
      "Record the recovery point actually reached and the restore completion time.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replay or compensate legitimate writes made after the target.",
      "Fix the archive delay or retention gap that made the target hard to reach.",
      "Re-run the drill with the real timing and update the RTO and RPO.",
      "Remove or mask the restored copy according to the data-handling policy.",
    ],
  },
];

const references = [
  {
    title: "Amazon RDS: Introduction to backups",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Automated backups, retention, and point-in-time recovery within the retention period.",
  },
  {
    title: "PostgreSQL: Continuous Archiving and Point-in-Time Recovery",
    url: "https://www.postgresql.org/docs/current/continuous-archiving.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Base backups, WAL archiving, recovery targets, and replay.",
  },
  {
    title: "PostgreSQL: Backup and Restore",
    url: "https://www.postgresql.org/docs/current/backup.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Backup approaches and the role of continuous archiving.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "backups-pitr": {
      model: pitrModel,
      presets,
      instructions:
        "Start Healthy, apply PITR disabled, then compare it with Archive lag. Watch the target-wait line: retention and archive delay fail differently.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Restore times, retention bounds, and thresholds are teaching values, not vendor guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-dr-drills",
    "databases-aurora-backtrack",
    "databases-cross-region-rpo",
    "databases-locks-deadlocks",
    "case-gitlab-2017",
  ],
};
