import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const LIVE_ROWS = 2_000_000;

const params = [
  {
    id: "txnMinutes",
    label: "Oldest transaction age",
    min: 1,
    max: 90,
    step: 1,
    value: 2,
    unit: " min",
    group: "Transaction",
    help: "How long the oldest open transaction has been running. It pins the snapshot that vacuum must preserve across the whole database.",
    format: "number" as const,
  },
  {
    id: "writeRate",
    label: "Row change rate",
    min: 100,
    max: 10_000,
    step: 100,
    value: 900,
    unit: " rows/s",
    group: "Workload",
    help: "Updates and deletes per second. Every change leaves an older row version that vacuum may need to keep.",
    format: "rps" as const,
  },
  {
    id: "holdLocks",
    label: "Holds row locks",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Transaction",
    help: "1 models `SELECT ... FOR UPDATE` or a schema change that blocks writers. 0 models a plain read with a snapshot only.",
    format: "count" as const,
  },
  {
    id: "walMb",
    label: "WAL generated",
    min: 0,
    max: 1_024,
    step: 32,
    value: 0,
    unit: " MB",
    group: "Replication",
    help: "Write-ahead log (WAL) produced by the transaction. A replica cannot expose those changes until the transaction commits, so readers stay on an older visible state.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function status(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Computed {
  txnMinutes: number;
  writeRate: number;
  holdLocks: boolean;
  walMb: number;
  retainedDead: number;
  bloat: number;
  blockedWriters: number;
  lockWait: number;
  replicaLag: number;
  primaryHealth: Health;
  replicaHealth: Health;
  vacuumHealth: Health;
  reportingHealth: Health;
}

function compute(p: Params): Computed {
  const txnMinutes = clamp(num(p, "txnMinutes", 2), 1, 90);
  const writeRate = clamp(num(p, "writeRate", 900), 100, 10_000);
  const holdLocks = num(p, "holdLocks", 0) >= 0.5;
  const walMb = clamp(num(p, "walMb", 0), 0, 1_024);
  const retainedDead = writeRate * 60 * txnMinutes;
  const bloat = clamp((100 * retainedDead) / (LIVE_ROWS + retainedDead), 0, 95);
  const blockedWriters = holdLocks ? Math.max(1, Math.round(writeRate / 400)) : 0;
  const lockWait = holdLocks ? txnMinutes * 60 * clamp(blockedWriters / 8) : 0;
  const replicaLag = walMb > 0 ? txnMinutes * 60 + Math.min(120, walMb / 20) : 0;
  const primaryHealth: Health =
    bloat >= 50 || lockWait >= 60 ? "crit" : bloat >= 25 || lockWait >= 5 ? "warn" : "ok";
  return {
    txnMinutes,
    writeRate,
    holdLocks,
    walMb,
    retainedDead,
    bloat,
    blockedWriters,
    lockWait,
    replicaLag,
    primaryHealth,
    replicaHealth: status(replicaLag, 300, 600),
    vacuumHealth: status(txnMinutes, 10, 30),
    reportingHealth: status(txnMinutes, 10, 30),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["bloat", values.bloat, 0.15],
    ["lock-wait", values.lockWait, values.lockWait > 0 ? 2 : 0],
    ["replica-lag", values.replicaLag, 0.5],
    ["snapshot-age", values.txnMinutes, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
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
        id: "reporting",
        label: "Reporting job",
        kind: "service",
        health: values.reportingHealth,
        utilization: clamp(values.txnMinutes / 90),
        sublabel: `${values.txnMinutes} min transaction`,
        detail:
          "A single logical read or batch. It keeps one snapshot for its whole duration, so every table must preserve versions visible at that instant.",
        meta: { txnMinutes: values.txnMinutes },
      },
      {
        id: "primary",
        label: "Primary · orders",
        kind: "db",
        role: "primary",
        health: values.primaryHealth,
        utilization: clamp(values.bloat / 100),
        sublabel: `${values.bloat.toFixed(1)}% bloat · ${formatCount(values.retainedDead)} dead rows`,
        detail:
          "The primary retains dead row versions for the oldest snapshot. If row locks are held, writers queue behind the transaction as well.",
        meta: { bloat: Number(values.bloat.toFixed(1)), lockWait: Math.round(values.lockWait) },
      },
      {
        id: "replica",
        label: "Read replica",
        kind: "db",
        role: "replica",
        health: values.replicaHealth,
        utilization: clamp(values.replicaLag / 900),
        sublabel: values.replicaLag > 0 ? `${Math.round(values.replicaLag)}s behind` : "up to date",
        detail:
          "WAL can be applied while the transaction is open, but its changes stay invisible until commit. Replay lag can look healthy while the visible state is minutes old.",
        meta: { lag: Math.round(values.replicaLag) },
      },
      {
        id: "vacuum",
        label: "Autovacuum",
        kind: "worker",
        health: values.vacuumHealth,
        utilization: clamp(values.txnMinutes / 60),
        sublabel: values.txnMinutes >= 10 ? "blocked by snapshot" : "keeping up",
        detail:
          "Vacuum cannot remove a tuple that any snapshot can still see. A transaction age above the cleanup horizon makes dead tuples accumulate on every table.",
        meta: { txnMinutes: values.txnMinutes },
      },
    ],
    edges: [
      edge("report-primary", "reporting", "primary", clamp(values.txnMinutes / 90), values.reportingHealth, "long query"),
      edge("primary-replica", "primary", "replica", clamp(1 - values.replicaLag / 3_000), values.replicaHealth, "WAL"),
      edge("vacuum-primary", "vacuum", "primary", clamp(1 - values.txnMinutes / 60), values.vacuumHealth, "cleanup"),
    ],
    metrics: [
      metric("bloat", "Table bloat", values.bloat, "%", 25, 50, "percent"),
      metric("lock-wait", "Oldest lock wait", values.lockWait, "s", 5, 60, "number"),
      metric("replica-lag", "Replica visible lag", values.replicaLag, "s", 300, 600, "number"),
      metric("snapshot-age", "Oldest snapshot age", values.txnMinutes, " min", undefined, undefined, "number"),
      metric("retained-dead", "Retained dead rows", values.retainedDead, " rows", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.txnMinutes} min transaction; ${values.bloat.toFixed(1)}% bloat; ${Math.round(
      values.lockWait,
    )}s lock wait; ${Math.round(values.replicaLag)}s replica visible lag.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "bloat",
    metricId: "bloat",
    warn: 25,
    crit: 50,
    title: "Long snapshot is blocking cleanup",
    cause:
      "The oldest snapshot keeps dead row versions visible, so vacuum cannot remove them. The table and its indexes grow, and every scan reads more pages.",
    fix:
      "End the transaction, set a statement timeout and idle-in-transaction timeout, and run long reporting reads on a replica with a bounded statement timeout.",
    checkFirst: [
      "Find the oldest `xact_start` and `backend_xmin` in `pg_stat_activity`.",
      "Check `pg_stat_user_tables` for dead tuples and the last autovacuum time.",
      "Check replication slots and `hot_standby_feedback` for other snapshots holding cleanup back.",
    ],
  },
  {
    id: "lock-wait",
    metricId: "lock-wait",
    warn: 5,
    crit: 60,
    title: "Writers are queued behind the transaction",
    cause:
      "The transaction holds row locks, so updates to the same rows wait until it commits or rolls back. A schema change can block readers and writers even more broadly.",
    fix:
      "Remove `FOR UPDATE` from reporting queries, shorten batches, set `lock_timeout`, and find the blocking process identifier (PID) in `pg_locks` before canceling anything.",
    checkFirst: [
      "Use `pg_blocking_pids()` to name the session holding the lock.",
      "Check `pg_stat_activity.wait_event_type` for `Lock` and the waiting query text.",
      "Confirm whether the operation is a read that took row locks or a schema change waiting on its own lock.",
    ],
  },
  {
    id: "replica-lag",
    metricId: "replica-lag",
    warn: 300,
    crit: 600,
    title: "Replica readers see stale data",
    cause:
      "A long write transaction's changes are not visible until commit. WAL replay can be current while the replica's visible state is minutes behind, and a long query can also hold back cleanup there.",
    fix:
      "Move reporting to a dedicated replica, chunk the write transaction, and measure visible freshness with a known write, not only `replay_lag`.",
    checkFirst: [
      "Compare `pg_stat_replication.replay_lag` with application-visible freshness.",
      "Check for an open write transaction and its `xact_start` on the primary.",
      "Check whether `hot_standby_feedback` is keeping dead tuples on the primary.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const longTransactionModel: SimModel = {
  id: "databases-long-transactions",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const base = defaults();
    const frame = buildFrame(base, seed);
    seedSeries(frame, compute(base), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.txnMinutes >= 10 && frame.flags.longTxnLogged !== 1) {
      pushEvent(next, {
        id: "long-transaction-open",
        severity: values.txnMinutes >= 30 ? "crit" : "warn",
        title: "Long transaction is holding the visibility horizon",
        detail: `Oldest transaction is ${values.txnMinutes} minutes old. Vacuum cannot remove row versions newer than this snapshot, and ${
          values.holdLocks ? "writers are waiting on its row locks" : "writers are not blocked by it"
        }.`,
        nodeId: "primary",
        metricId: "snapshot-age",
      });
    }
    if (values.replicaLag > 0 && frame.flags.replicaLagLogged !== 1) {
      pushEvent(next, {
        id: "replica-visible-lag",
        severity: values.replicaLag >= 600 ? "crit" : "warn",
        title: "Replica visible state is behind the commit",
        detail: `The transaction is ${values.txnMinutes} minutes old and generated ${values.walMb} MB of WAL. Readers on the replica see data from before its commit even when replay is keeping up.`,
        nodeId: "replica",
        metricId: "replica-lag",
      });
    }
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.longTxnLogged = values.txnMinutes >= 10 ? 1 : 0;
    next.flags.replicaLagLogged = values.replicaLag > 0 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.txnMinutes} min transaction; ${values.bloat.toFixed(1)}% bloat; ${Math.round(
      values.lockWait,
    )}s lock wait; ${Math.round(values.replicaLag)}s replica visible lag.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `A ${values.txnMinutes} min transaction retains about ${formatCount(
        values.retainedDead,
      )} dead row versions at ${formatCount(values.writeRate)} changes per second. That is ${values.bloat.toFixed(
        1,
      )}% of the live table.`,
      values.holdLocks
        ? `Row locks make about ${values.blockedWriters} writers queue; the oldest has waited ${Math.round(
            values.lockWait,
          )}s. A read-only report without row locks would not do this.`
        : "No row locks are held, so writers do not wait on this transaction. The damage is cleanup and, if it writes, replica visibility.",
      values.walMb > 0
        ? `WAL streaming can be current while the replica's visible state is ${Math.round(
            values.replicaLag,
          )}s old, because the transaction's changes become visible only at commit.`
        : "A read-only transaction generates no WAL, so it does not delay replica visibility. It still holds the snapshot.",
      "Vacuum cannot trade correctness for space. The snapshot must be allowed to end before cleanup can catch up.",
      "Setting a statement timeout is a guardrail, not a fix: the reporting job still needs a bounded, resumable design.",
    ];
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
    description: "A two-minute report, no row locks, and no WAL. Bloat stays near five percent.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak reports",
    description: "An eight-minute read generates 128 MB of WAL at 4,000 row changes per second. Bloat and visible lag warn without blocking writers.",
    tone: "warn",
    params: defaults({ txnMinutes: 8, writeRate: 4_000, walMb: 128 }),
  },
  {
    id: "failure",
    label: "Forty-minute report",
    description: "A 40-minute `FOR UPDATE` report at 3,000 changes per second. Locks, bloat, and replica freshness all breach together.",
    tone: "crit",
    params: defaults({ txnMinutes: 40, writeRate: 3_000, holdLocks: 1, walMb: 512 }),
  },
  {
    id: "batched",
    label: "Batched locking job",
    description: "One-minute batches still take row locks but release them quickly. Locks warn; bloat and visible lag stay bounded.",
    tone: "warn",
    params: defaults({ txnMinutes: 1, writeRate: 2_400, holdLocks: 1, walMb: 64 }),
  },
  {
    id: "recovery",
    label: "Bounded on replica",
    description: "A one-minute read without locks or WAL runs on a replica. Every threshold returns to healthy.",
    tone: "ok",
    params: defaults({ txnMinutes: 1, writeRate: 800, holdLocks: 0, walMb: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-long-transaction-chain",
  title: "Predict the chain from one open transaction",
  simId: "long-transactions",
  question:
    "A reporting job runs `SELECT ... FOR UPDATE` for 40 minutes while the table takes 3,000 row changes per second. Which set of signals do you expect?",
  prediction: {
    options: [
      {
        id: "all-three",
        label: "Writers queue, bloat grows, and replica readers see stale data until commit.",
      },
      {
        id: "read-only",
        label: "Only read latency rises; a read cannot affect writers, cleanup, or replication.",
      },
      {
        id: "lag-zero",
        label: "Replica lag stays at zero because WAL streaming is asynchronous.",
      },
      {
        id: "bloat-only",
        label: "Only bloat rises; lock waits and replica lag are unrelated to transaction age.",
      },
    ],
    correctOptionId: "all-three",
    explanation:
      "The transaction holds row locks, so writers queue. Its snapshot prevents vacuum from removing versions created after it began, so bloat grows. Its writes are not visible on the replica until commit, so replica readers see an older state even when replay lag looks healthy.",
  },
  setup: defaults({ txnMinutes: 40, writeRate: 3_000, holdLocks: 1, walMb: 512 }),
  runFor: 20,
  observe: [
    "Table bloat reaches about 78 percent and crosses the critical threshold.",
    "The oldest lock wait reaches 2,400 seconds, far beyond the 60-second critical line.",
    "Replica visible lag is about 2,426 seconds and crosses the 600-second line.",
    "Snapshot age reads 40 minutes, the root cause all three metrics share.",
    "The primary, replica, vacuum worker, and reporting job are all failing.",
  ],
  explain:
    "The mechanisms are separate but share one cause: the transaction is still open. Locks block writers immediately; the snapshot blocks cleanup; the uncommitted write transaction blocks visible freshness on the replica. A read-only query without locks would only hold the snapshot and would not queue writers or generate WAL.",
  fix: defaults({ txnMinutes: 1, writeRate: 800, holdLocks: 0, walMb: 0 }),
  debrief:
    "Bounding the transaction to one minute and moving it off the writer removes all three breaches. The durable fix is not a bigger database: it is a statement timeout, a resumable report, and a replica with enough capacity for the report's reads.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "PostgreSQL uses multiversion concurrency control (MVCC). An update writes a new row version and leaves the old one in place. Each transaction sees the database as of the moment it took its snapshot, so old versions must remain visible until that transaction finishes. Vacuum can remove a dead version only when no snapshot can still see it.",
  },
  {
    type: "p",
    text: "A long transaction is any transaction open long enough to hold that visibility horizon back. It does not have to be a bad query. A reporting job with a consistent snapshot can run for 40 minutes and delay cleanup for the whole database, because the oldest snapshot applies to every table, not just the one being read.",
  },
  {
    type: "p",
    text: "The damage arrives through three different mechanisms. Dead tuples accumulate, so tables and indexes grow and scans read more pages. If the transaction takes row locks, writers queue behind it. If it writes, its changes are not visible on a replica until commit, so replica readers see stale data even when WAL streaming is healthy. Each mechanism has a different signal and a different fix.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The transaction sits between the application session and the storage layer. The session holds a snapshot identifier and possibly row locks. The primary writes WAL, autovacuum walks the table to reclaim versions, and streaming replication ships WAL to each replica. A single long session can therefore affect the table, the indexes, the lock manager, autovacuum, and every replica at once.",
  },
  {
    type: "compare",
    leftTitle: "Read-only report",
    rightTitle: "Report with FOR UPDATE",
    rows: [
      { label: "Snapshot", left: "Held for the whole transaction", right: "Held for the whole transaction" },
      { label: "Writers", left: "Not blocked", right: "Queue on the locked rows" },
      { label: "Vacuum", left: "Blocked from removing new dead tuples", right: "Blocked from removing new dead tuples" },
      { label: "Replica", left: "No WAL; no visibility delay from this query", right: "Changes invisible until commit" },
      { label: "First signal", left: "Oldest snapshot age and dead tuples", right: "Lock wait and blocking PIDs" },
    ],
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it does not tell you"],
    rows: [
      ["`xact_start` in `pg_stat_activity`", "How long the oldest transaction has been open", "Whether it holds locks or writes"],
      ["`n_dead_tup` in `pg_stat_user_tables`", "How much cleanup is pending", "Whether the snapshot or autovacuum settings are the cause"],
      ["`wait_event_type = Lock`", "A session is waiting on a lock", "Which session holds it"],
      ["`pg_stat_replication.replay_lag`", "How far WAL replay is behind", "How old the replica's visible data is"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Oldest snapshot age, in minutes: the shared root cause.",
      "Table bloat and retained dead rows: the cleanup debt the snapshot creates.",
      "Oldest lock wait, which appears only when the transaction holds row locks.",
      "Replica visible lag, which appears only when the transaction writes; it is not the same as replay lag.",
      "A lock toggle, so you can separate a read-only report from a locking one.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Forty-minute report. Read lock wait, bloat, and replica lag before moving any slider. Turn row locks off and watch only the lock wait fall: bloat and visible lag remain. Then set the transaction to one minute and compare the recovery preset. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Transaction ages, row counts, and thresholds are illustrative teaching values. They are chosen to make the causal chain visible, not to predict a specific PostgreSQL deployment.",
  },
  { type: "sim", simId: "long-transactions" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 40 minutes and 3,000 row changes per second, the primary retained about 7.2 million dead row versions. Against a two-million-row live table that is roughly 78 percent bloat. The same transaction held row locks for the whole duration, so the oldest writer waited 2,400 seconds. Because it also wrote, its changes were not visible on the replica until commit, leaving readers about 2,426 seconds behind.",
  },
  {
    type: "p",
    text: "The three numbers did not rise for the same reason. The lock wait came from row locks. The bloat came from the snapshot. The replica lag came from the uncommitted write transaction. Turning off row locks removed the lock wait but left the other two. Shortening the transaction to one minute brought all three back under their thresholds.",
  },
  {
    type: "p",
    text: "This is why killing the session is not automatically the right first move. It releases the snapshot and the locks, which is often necessary, but it rolls back work and may leave a reporting job to restart from zero. The better fix is to make the job bounded before it becomes an incident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`pg_stat_activity`: `xact_start`, `state`, `wait_event_type`, and `backend_xmin` for the oldest session.",
      "`pg_stat_user_tables`: `n_dead_tup`, `n_live_tup`, and `last_autovacuum` for the affected table.",
      "`pg_stat_progress_vacuum`: whether vacuum is running and how far it has progressed, not just whether it was scheduled.",
      "`pg_locks` and `pg_blocking_pids()`: the waiting session, the holder, and the lock mode.",
      "`pg_stat_replication`: `write_lag`, `flush_lag`, and `replay_lag`; correlate with application-visible freshness.",
      "`pg_stat_replication_slots` and `hot_standby_feedback`: other reasons cleanup can be held back.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the oldest `xact_start` before you check CPU or disk. If the oldest transaction is minutes old, every other cleanup metric is downstream of it. Then check whether the session holds locks: a plain read cannot make writers wait, so a lock wait means something else is true about the query.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the transaction and its owner from `pg_stat_activity`; do not terminate sessions before you know what will roll back.",
      "Set `statement_timeout` and `idle_in_transaction_session_timeout` for application roles. PostgreSQL 17 adds `transaction_timeout` for the whole transaction.",
      "Set `lock_timeout` so writers fail fast instead of queueing behind a long lock holder.",
      "Move consistent reporting reads to a dedicated replica with headroom; a replica does not remove the snapshot cost there.",
      "Chunk large updates and deletes, commit frequently, and keep batches short enough that locks are released quickly.",
      "Check `hot_standby_feedback` and replication slots, which can hold cleanup back even after the transaction ends.",
      "Run `VACUUM (VERBOSE)` or observe autovacuum progress after the blocker clears; measure dead tuples rather than assuming cleanup is immediate.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A statement timeout protects the system but can abort a report near completion. Make the job resumable or partition its work.",
      "Moving reports to a replica protects the writer but can make the replica's own vacuum and I/O worse; size it for that work.",
      "Shorter batches reduce lock duration but increase commit overhead and may change application semantics if a batch fails midway.",
      "Killing the session restores cleanup quickly but loses the transaction's work and can cause a retry storm.",
      "`hot_standby_feedback` protects replica queries from cleanup conflicts but can increase primary bloat, the opposite of what you want during a long report.",
      "There is no setting that lets vacuum remove versions a snapshot can still see; correctness constrains cleanup.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-blocks-writes",
    question:
      "A read-only reporting query has run for 40 minutes. Writes are timing out and replica readers are stale. How can a read cause all of that?",
    difficulty: 4,
    hints: [
      "A plain read and a locking read are different operations.",
      "Replica freshness has more than one cause.",
    ],
    answer:
      "A plain read cannot make writers wait, so I would first check whether the report actually holds row locks, for example `SELECT ... FOR UPDATE` or a cursor that updates. If it does, writers queue behind those locks. Separately, the report's snapshot prevents vacuum from removing row versions created after it began, so bloat grows regardless of locking. If the report also writes, its changes are not visible on a replica until commit, so replica readers see an older state even when WAL replay is current. I would verify each claim with `pg_stat_activity`, `pg_locks`, dead-tuple counts, and a known write on the replica rather than assuming all three share one mechanism.",
    followUps: [
      "Which of those three problems would disappear if the report ran on a replica?",
      "How would you distinguish a lock wait from a slow query?",
      "What changes if the report is read-only and takes no locks?",
    ],
    redFlags: [
      "Assumes every read blocks writers.",
      "Treats replay lag as visible freshness.",
      "Kills the session without checking what it holds.",
    ],
    rubric: [
      "Separates snapshot, row locks, and uncommitted WAL.",
      "Names the right system views.",
      "Explains why a plain read does not queue writers.",
      "Proposes bounded transactions and replica isolation.",
    ],
  },
  {
    id: "find-snapshot-holder",
    question: "Autovacuum is running but dead tuples keep growing. How do you find the snapshot holding cleanup back?",
    difficulty: 3,
    hints: [
      "Look at transaction start times, not just query duration.",
      "A replication slot can hold a snapshot too.",
    ],
    answer:
      "I would query `pg_stat_activity` for the oldest `xact_start` and for sessions in `idle in transaction`, and compare their `backend_xmin` with the table's visibility horizon. I would also check `pg_replication_slots` for an active slot and `pg_stat_replication` for a standby using `hot_standby_feedback`. If autovacuum is running but cannot remove tuples, the blocker is usually a snapshot older than the tuples, not a lack of vacuum runs. I would confirm with `pg_stat_progress_vacuum` and the table's `n_dead_tup` before deciding whether to cancel a session or tune autovacuum.",
    followUps: [
      "What is the difference between an idle session and an idle-in-transaction session?",
      "Why does a replication slot hold cleanup back?",
      "When would you tune autovacuum instead of ending the transaction?",
    ],
    redFlags: [
      "Runs VACUUM FULL first.",
      "Only checks whether autovacuum is enabled.",
      "Ignores idle-in-transaction sessions.",
    ],
    rubric: [
      "Finds the oldest transaction or slot.",
      "Uses `backend_xmin` or an equivalent horizon check.",
      "Distinguishes scheduling from blocking.",
      "Names a safe resolution path.",
    ],
  },
  {
    id: "bound-duration",
    question: "How do you bound transaction duration without breaking a reporting workload that legitimately needs to scan a large table?",
    difficulty: 3,
    hints: [
      "A timeout is a guardrail, not a design.",
      "The report can be resumable or partitioned.",
    ],
    answer:
      "I would start with a statement timeout and an idle-in-transaction timeout per role, plus `lock_timeout` for writers, but treat those as guardrails. For the report itself I would give it a bounded, resumable shape: paginate by key range, export to a snapshot or analytical store, or run it on a dedicated replica with capacity for the scan. Each chunk gets its own short transaction, so the visibility horizon advances and locks are released. I would measure the report's actual runtime distribution before choosing the timeout, because a limit that aborts every run is not a fix.",
    followUps: [
      "Why is an idle-in-transaction timeout especially important?",
      "What breaks if the report paginates on a non-unique column?",
      "How do you test the timeout without waiting for the next month-end run?",
    ],
    redFlags: [
      "Sets a timeout and calls it done.",
      "Uses one giant transaction for the whole export.",
      "Runs the report on the primary by default.",
    ],
    rubric: [
      "Names statement, idle, and lock timeouts.",
      "Makes the workload bounded or resumable.",
      "Mentions replica isolation and sizing.",
      "Measures runtime before setting limits.",
    ],
  },
  {
    id: "visible-vs-replay",
    question: "`replay_lag` is under a second, but application reads on the replica are 20 minutes stale. How is that possible?",
    difficulty: 4,
    hints: [
      "Replay lag measures WAL application, not commit visibility.",
      "Think about a long write transaction.",
    ],
    answer:
      "`replay_lag` measures how far the replica has applied WAL, not what a query can see. If the primary has a write transaction open for 20 minutes, its changes are not committed, so the replica cannot expose them even though it has applied the surrounding WAL. Queries on the replica use a snapshot that predates the transaction. I would look for the oldest `xact_start` on the primary, check whether the transaction has written anything, and test visible freshness with a known committed write. A long read-only transaction can also hold back cleanup on the replica through `hot_standby_feedback`, but it does not by itself make committed data invisible.",
    followUps: [
      "How would you alert on visible freshness rather than replay lag?",
      "What does `pg_last_wal_replay_lsn` tell you here?",
      "When is a logical replication slot the better explanation?",
    ],
    redFlags: [
      "Assumes replay lag equals data freshness.",
      "Looks only at replica CPU.",
      "Ignores open write transactions on the primary.",
    ],
    rubric: [
      "Separates WAL replay from visibility.",
      "Identifies the long write transaction.",
      "Names a freshness probe.",
      "Mentions replica-side cleanup effects.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every application role has statement, lock, and idle-in-transaction timeouts.",
      "Reporting reads run on a dedicated replica or an analytical store with capacity for the scan.",
      "Dashboards show oldest transaction age and dead tuples, not only CPU and query latency.",
      "A resumable or chunked design exists for the largest update and export jobs.",
      "Replication slots and `hot_standby_feedback` are reviewed for cleanup impact.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the oldest transaction and its owner before canceling anything.",
      "Check whether it holds locks and whether it has written WAL.",
      "Measure visible freshness on the replica with a known write.",
      "Relieve the writer first, then let vacuum catch up and watch dead tuples fall.",
      "Record the rollback cost before terminating a session.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm bloat and dead tuples are falling, not just that the session ended.",
      "Review the report's design and replace an unbounded transaction with a bounded one.",
      "Tune autovacuum only after the snapshot blocker is gone.",
      "Add an alert on oldest transaction age with an owner and a runbook.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Routine Vacuuming",
    url: "https://www.postgresql.org/docs/current/routine-vacuuming.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Dead tuples, the visibility horizon, autovacuum, and why open snapshots prevent cleanup.",
  },
  {
    title: "PostgreSQL: Monitoring Statistics",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "`pg_stat_activity`, `pg_stat_user_tables`, `pg_stat_progress_vacuum`, and replication views.",
  },
  {
    title: "PostgreSQL: Client Connection Defaults",
    url: "https://www.postgresql.org/docs/current/runtime-config-client.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "`statement_timeout`, `lock_timeout`, and `idle_in_transaction_session_timeout`.",
  },
  {
    title: "PostgreSQL: Hot Standby",
    url: "https://www.postgresql.org/docs/current/hot-standby.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "`hot_standby_feedback` and cleanup conflicts between primary and standby.",
  },
  {
    title: "Best practices for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/CHAP_BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Operational guidance for monitoring, maintenance, and capacity on Aurora.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "long-transactions": {
      model: longTransactionModel,
      presets,
      instructions:
        "Start healthy, apply Forty-minute report, then toggle row locks to separate lock waits from snapshot bloat and replica visibility. Shorten the transaction to see recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Transaction ages, row counts, and thresholds are teaching values, not PostgreSQL limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-vacuum-bloat",
    "databases-locks-deadlocks",
    "databases-primary-replica-lag",
    "databases-rds-aurora-arch",
    "databases-max-connections",
  ],
};
