import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const LIVE_ROWS = 10_000_000;

const params = [
  {
    id: "updateRate",
    label: "Update and delete rate",
    min: 100,
    max: 20_000,
    step: 100,
    value: 1_000,
    unit: " rows/s",
    group: "Workload",
    help: "Rows changed per second. Each update writes a new row version and leaves the old one dead, even when the value is unchanged.",
    format: "rps" as const,
  },
  {
    id: "vacuumInterval",
    label: "Vacuum interval",
    min: 1,
    max: 120,
    step: 1,
    value: 5,
    unit: " min",
    group: "Maintenance",
    help: "How often vacuum runs on the table. Longer intervals let more dead tuples accumulate between passes.",
    format: "number" as const,
  },
  {
    id: "oldestSnapshot",
    label: "Oldest snapshot age",
    min: 0,
    max: 180,
    step: 1,
    value: 0,
    unit: " min",
    group: "Maintenance",
    help: "Age of the oldest transaction or replication snapshot that can still see the table. Vacuum cannot remove tuples visible to it.",
    format: "number" as const,
  },
  {
    id: "fillfactor",
    label: "Fillfactor",
    min: 50,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Maintenance",
    help: "How full each page is packed. Lower values leave room for updates on the same page, which reduces page splits and bloat.",
    format: "percent" as const,
  },
  {
    id: "vacuumIoShare",
    label: "Vacuum I/O share",
    min: 10,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Maintenance",
    help: "Share of the table's I/O budget available to vacuum. A low share makes cleanup slower and competes with queries.",
    format: "percent" as const,
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
  updateRate: number;
  interval: number;
  snapshotAge: number;
  fillfactor: number;
  ioShare: number;
  blockedFraction: number;
  retainedDead: number;
  bloatPercent: number;
  indexBloatPercent: number;
  queryMs: number;
  tableHealth: Health;
  indexHealth: Health;
  vacuumHealth: Health;
  appHealth: Health;
}

function compute(p: Params): Computed {
  const updateRate = clamp(num(p, "updateRate", 1_000), 100, 20_000);
  const interval = clamp(num(p, "vacuumInterval", 5), 1, 120);
  const snapshotAge = clamp(num(p, "oldestSnapshot", 0), 0, 180);
  const fillfactor = clamp(num(p, "fillfactor", 90), 50, 100);
  const ioShare = clamp(num(p, "vacuumIoShare", 80), 10, 100);
  const blockedFraction = clamp(snapshotAge / Math.max(interval, 1));
  const pageSplitFactor = 0.7 + 0.3 * (fillfactor / 100);
  const deadPerCycle = updateRate * 60 * interval * pageSplitFactor;
  const retainedDead = deadPerCycle * (1 + 4 * blockedFraction);
  const bloatPercent = (100 * retainedDead) / (LIVE_ROWS + retainedDead);
  const indexBloatPercent = bloatPercent * 0.8;
  const queryMs = 4 + bloatPercent * 0.6 + (100 - ioShare) * 0.05;
  const tableHealth = status(bloatPercent, 25, 50);
  const indexHealth = status(indexBloatPercent, 25, 50);
  const vacuumHealth: Health =
    blockedFraction >= 1 || snapshotAge >= 60 ? "crit" : blockedFraction >= 0.5 || snapshotAge >= 15 ? "warn" : "ok";
  const appHealth = status(queryMs, 20, 40);
  return {
    updateRate,
    interval,
    snapshotAge,
    fillfactor,
    ioShare,
    blockedFraction,
    retainedDead,
    bloatPercent,
    indexBloatPercent,
    queryMs,
    tableHealth,
    indexHealth,
    vacuumHealth,
    appHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["bloat", values.bloatPercent, 0.15],
    ["query-p95", values.queryMs, 0.3],
    ["snapshot-age", values.snapshotAge, 0.2],
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
        id: "app",
        label: "Application queries",
        kind: "service",
        health: values.appHealth,
        utilization: clamp(values.queryMs / 80),
        sublabel: `p95 ${values.queryMs.toFixed(1)} ms`,
        detail:
          "Scans read every page the table still occupies, including pages that contain only dead versions. Latency tracks bloat even when the row count is flat.",
        meta: { p95: Number(values.queryMs.toFixed(1)) },
      },
      {
        id: "table",
        label: "orders table",
        kind: "db",
        role: "primary",
        health: values.tableHealth,
        utilization: clamp(values.bloatPercent / 100),
        sublabel: `${values.bloatPercent.toFixed(1)}% bloat · ${formatCount(values.retainedDead)} dead`,
        detail:
          "Dead tuples are still on disk because vacuum has not been able to remove them, or has not run often enough. The file does not shrink when they are removed; the space becomes reusable.",
        meta: { bloat: Number(values.bloatPercent.toFixed(1)), dead: Math.round(values.retainedDead) },
      },
      {
        id: "indexes",
        label: "Indexes",
        kind: "storage",
        health: values.indexHealth,
        utilization: clamp(values.indexBloatPercent / 100),
        sublabel: `${values.indexBloatPercent.toFixed(1)}% estimated bloat`,
        detail:
          "Index entries point at row versions. Dead entries remain until vacuum, and a bloated index adds I/O to every lookup and every update.",
        meta: { bloat: Number(values.indexBloatPercent.toFixed(1)) },
      },
      {
        id: "autovacuum",
        label: "Autovacuum and snapshots",
        kind: "worker",
        health: values.vacuumHealth,
        utilization: values.blockedFraction,
        sublabel:
          values.snapshotAge === 0
            ? `runs every ${values.interval} min`
            : `blocked by a ${values.snapshotAge} min snapshot`,
        detail:
          "Vacuum can only remove tuples that are dead to every snapshot. A long-running transaction, a replication slot, or an idle-in-transaction session holds the visibility horizon back.",
        meta: { interval: values.interval, snapshot: values.snapshotAge },
      },
    ],
    edges: [
      edge("query-path", "app", "table", clamp(values.queryMs / 60), values.appHealth, "reads and writes"),
      edge("index-path", "table", "indexes", 0.8, values.indexHealth, "index maintenance"),
      edge(
        "vacuum-path",
        "autovacuum",
        "table",
        clamp(1 - values.blockedFraction),
        values.vacuumHealth,
        "dead tuple cleanup",
      ),
    ],
    metrics: [
      metric("bloat", "Table bloat", values.bloatPercent, "%", 25, 50, "percent"),
      metric("query-p95", "Query p95", values.queryMs, " ms", 20, 40, "ms"),
      metric("snapshot-age", "Oldest snapshot age", values.snapshotAge, " min", 15, 60, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.bloatPercent.toFixed(1)}% bloat with ${formatCount(
      values.retainedDead,
    )} retained dead tuples. Query p95 ${values.queryMs.toFixed(1)} ms. Oldest snapshot ${values.snapshotAge} min.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "bloat",
    metricId: "bloat",
    warn: 25,
    crit: 50,
    title: "Table bloat is consuming the working set",
    cause:
      "Updates and deletes leave dead row versions that vacuum has not removed. The table file keeps its pages, so scans read more data and the cache holds less useful content.",
    fix:
      "Remove the oldest snapshot, run vacuum during a quiet window, and tune autovacuum for the table's update rate. Use VACUUM FULL or pg_repack only when you need disk returned and can pay the lock or rewrite cost.",
    checkFirst: [
      "Check `pg_stat_user_tables` for dead tuples and the last autovacuum time.",
      "Check `pg_stat_activity` and replication slots for the oldest snapshot holding cleanup back.",
      "Check whether the table has a high update rate that outpaces the current autovacuum settings.",
    ],
  },
  {
    id: "query-latency",
    metricId: "query-p95",
    warn: 20,
    crit: 40,
    title: "Query latency is rising with bloat",
    cause:
      "Scans and index lookups traverse pages that contain dead versions, and vacuum adds I/O while it runs. The planner may also choose a different plan as the table's physical size grows.",
    fix:
      "Restore cleanup headroom, run maintenance outside peak traffic, and check the plan after bloat drops. Adding an index does not remove dead tuples.",
    checkFirst: [
      "Compare query latency with bloat and dead-tuple counts over the same period.",
      "Check whether latency spikes coincide with vacuum or autovacuum runs.",
      "Run EXPLAIN (ANALYZE, BUFFERS) to see whether the plan reads more pages than expected.",
    ],
  },
  {
    id: "snapshot",
    metricId: "snapshot-age",
    warn: 15,
    crit: 60,
    title: "A long snapshot is blocking cleanup",
    cause:
      "Vacuum cannot remove a tuple that remains visible to any snapshot. A long transaction, an idle-in-transaction session, or a replication slot can hold the horizon back even when autovacuum runs on schedule.",
    fix:
      "Find and end the oldest transaction, set idle-in-transaction and statement timeouts, and check replication slots. Then let vacuum catch up before rewriting the table.",
    checkFirst: [
      "Query `pg_stat_activity` for the oldest `xact_start` and idle-in-transaction sessions.",
      "Check `pg_replication_slots` for inactive slots that retain WAL and snapshots.",
      "Check whether the table's autovacuum is running but unable to remove tuples.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const bloatModel: SimModel = {
  id: "databases-vacuum-bloat",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, values, seed);
    pushEvent(frame, {
      id: "table-sampled",
      at: 0,
      severity: "info",
      title: "Table statistics sampled",
      detail: `The table has about ${formatCount(LIVE_ROWS)} live rows. Apply a preset or change maintenance settings.`,
      nodeId: "table",
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
    if (values.snapshotAge >= 15 && frame.flags.snapshotLogged !== 1) {
      pushEvent(next, {
        id: "snapshot-blocks-vacuum",
        severity: values.snapshotAge >= 60 ? "crit" : "warn",
        title: "Vacuum is held back by an old snapshot",
        detail: `The oldest snapshot is ${values.snapshotAge} min old, so tuples dead after it started cannot be removed. Autovacuum may run and still leave the table bloated.`,
        nodeId: "autovacuum",
        metricId: "snapshot-age",
      });
    }
    next.flags = {
      ...frame.flags,
      ...next.flags,
      snapshotLogged: values.snapshotAge >= 15 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [
      `Table bloat is ${values.bloatPercent.toFixed(1)}% with ${formatCount(
        values.retainedDead,
      )} dead tuples retained. The estimate is illustrative and depends on row width and page layout.`,
      `Vacuum can remove only ${(100 - values.blockedFraction * 100).toFixed(
        0,
      )}% of each cycle's dead tuples because the oldest snapshot is ${values.snapshotAge} min old.`,
      "Removing dead tuples makes space reusable inside the table; it does not return the file to the operating system.",
      `Query p95 is ${values.queryMs.toFixed(1)} ms. Bloat raises the number of pages read; vacuum I/O share changes how much it competes with queries.`,
    ];
    if (values.snapshotAge > values.interval) {
      items.push(
        "The snapshot is older than the vacuum interval, so every run is blocked by work that started after the snapshot. Ending the transaction is the first fix.",
      );
    }
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
    description: "Frequent vacuum, no long snapshot, and a fillfactor that leaves room for updates.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy table",
    description: "Twice the update rate, vacuum every 10 minutes, and a 4-minute reporting snapshot.",
    tone: "warn",
    params: defaults({ updateRate: 2_000, vacuumInterval: 10, oldestSnapshot: 4, fillfactor: 80, vacuumIoShare: 50 }),
  },
  {
    id: "failure",
    label: "Snapshot blocks vacuum",
    description: "A 90-minute snapshot outlives every vacuum run while 10,000 rows per second are updated.",
    tone: "crit",
    params: defaults({
      updateRate: 10_000,
      vacuumInterval: 30,
      oldestSnapshot: 90,
      fillfactor: 100,
      vacuumIoShare: 30,
    }),
  },
  {
    id: "slow-vacuum",
    label: "Vacuum too rare",
    description: "No long snapshot, but vacuum runs only every hour on a table with 12,000 updates per second.",
    tone: "crit",
    params: defaults({
      updateRate: 12_000,
      vacuumInterval: 60,
      oldestSnapshot: 0,
      fillfactor: 100,
      vacuumIoShare: 90,
    }),
  },
  {
    id: "recovery",
    label: "Cleanup restored",
    description: "Vacuum runs every 5 minutes, the oldest snapshot is 2 minutes, and bloat stays below the warning line.",
    tone: "ok",
    params: defaults({ updateRate: 3_000, vacuumInterval: 5, oldestSnapshot: 2, fillfactor: 70, vacuumIoShare: 70 }),
  },
];

const experiment: Experiment = {
  id: "predict-blocked-vacuum",
  title: "Predict why vacuum is not reclaiming space",
  simId: "vacuum-bloat",
  question:
    "Autovacuum runs every 10 minutes on a table with 5,000 updates per second. A reporting transaction has held a snapshot for 40 minutes. What happens to the dead tuples vacuum can remove?",
  prediction: {
    options: [
      { id: "all", label: "Vacuum removes all dead tuples on every run." },
      { id: "blocked", label: "Tuples dead after the snapshot began cannot be removed, so bloat grows." },
      { id: "full", label: "PostgreSQL automatically runs VACUUM FULL to recover the space." },
      { id: "restart", label: "A restart clears the dead tuples and resets bloat." },
    ],
    correctOptionId: "blocked",
    explanation:
      "Vacuum may remove versions that are dead to every snapshot, but the reporting transaction must still see the table as of 40 minutes ago. Tuples deleted or updated after that point are still visible to it and cannot be removed. The run completes without error while the table keeps growing. Ending the transaction, not running vacuum more often, restores cleanup.",
  },
  setup: defaults({ updateRate: 5_000, vacuumInterval: 10, oldestSnapshot: 40, fillfactor: 90, vacuumIoShare: 80 }),
  runFor: 20,
  observe: [
    "Table bloat crosses the critical threshold at about 59%.",
    "Query p95 rises above 40 ms and crosses critical.",
    "The oldest snapshot is 40 minutes and crosses the critical threshold.",
    "Autovacuum is failing even though it runs on schedule, because the snapshot blocks removal.",
    "Index bloat tracks table bloat and adds I/O to lookups.",
  ],
  explain:
    "Autovacuum is not a delete job that runs on a timer. It removes tuples that no snapshot can still see. A 40-minute snapshot makes the last 40 minutes of dead tuples ineligible, and every vacuum cycle adds more. The table file keeps its pages, so queries read more data even though the live row count did not change.",
  fix: defaults({ updateRate: 5_000, vacuumInterval: 3, oldestSnapshot: 0, fillfactor: 90, vacuumIoShare: 80 }),
  debrief:
    "With the snapshot gone and vacuum every 3 minutes, bloat falls to single digits and query p95 returns below 20 ms. The fix was not a bigger vacuum or a table rewrite; it was removing the visibility horizon that made cleanup impossible.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "PostgreSQL uses multiversion concurrency control (MVCC). An update writes a new row version and marks the old one dead; a delete marks a version dead. Readers continue to see the version that was visible when their snapshot started. The dead version cannot be removed while any snapshot can still see it. This is why a table can grow even when the live row count is flat.",
  },
  {
    type: "p",
    text: "Vacuum finds dead tuples that are no longer visible to any snapshot and makes their space reusable. It does not usually return that space to the operating system; the table file keeps its pages, and new rows reuse the free space. Autovacuum runs this work automatically based on update and delete activity. A long-running transaction, an idle-in-transaction session, or a replication slot can hold the oldest snapshot back and make every vacuum run ineffective.",
  },
  {
    type: "p",
    text: "Bloat is the gap between the space the table occupies and the space its live data needs. It increases the number of pages scanned, reduces cache efficiency, and can push the planner toward a different plan. VACUUM FULL rewrites the table and returns space, but it takes an ACCESS EXCLUSIVE lock and blocks reads and writes for the duration. Extensions such as pg_repack offer an online rewrite with different costs.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The heap holds row versions; indexes hold entries that point to them. A dead version leaves a dead index entry until vacuum. The visibility map marks pages where all tuples are visible, which helps index-only scans. Autovacuum workers read the table, update the visibility map, and record statistics. A snapshot older than the cleanup horizon keeps dead tuples in place, no matter how often the worker runs.",
  },
  {
    type: "table",
    headers: ["Action", "What it reclaims", "Main cost"],
    rows: [
      ["VACUUM", "Space inside the table for reuse", "I/O while it runs; no long lock"],
      ["Autovacuum", "Same, on a schedule", "Competes with queries; can be blocked"],
      ["VACUUM FULL", "Disk returned to the OS", "ACCESS EXCLUSIVE lock and rewrite"],
      ["pg_repack", "Disk returned with less blocking", "Extra disk, triggers, and operational care"],
    ],
  },
  {
    type: "p",
    text: "Transaction ID wraparound is the other reason vacuum is not optional. PostgreSQL tracks the age of transaction IDs, and an old enough database must be vacuumed to freeze rows. Anti-wraparound autovacuum is more aggressive than ordinary cleanup. Monitor `age(datfrozenxid)` and do not treat a scheduled maintenance window as a substitute for autovacuum.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Table bloat: the estimated share of the file that is dead space.",
      "Query p95: latency as scans and index lookups traverse dead pages.",
      "Oldest snapshot age: the transaction or slot holding cleanup back.",
      "Retained dead tuples: the population vacuum could not remove.",
      "Index bloat: dead entries that add I/O to every lookup and update.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Snapshot blocks vacuum and find the snapshot node before reading the bloat number. Compare it with Vacuum too rare: the first is a visibility problem, the second is a scheduling problem. Lower the snapshot age first, then tune the interval. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The 10-million-row table, bloat percentages, latency values, and thresholds are illustrative teaching values. Real bloat estimates depend on row width, page layout, and the measurement method.",
  },
  { type: "sim", simId: "vacuum-bloat" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the snapshot-blocked preset, 10,000 updates per second produced 18 million dead tuples per vacuum cycle. Because the oldest snapshot was 90 minutes old, every cycle was blocked, and retained dead tuples reached 90 million. Table bloat hit 90%, query p95 exceeded 60 ms, and index bloat followed the table.",
  },
  {
    type: "p",
    text: "The vacuum-too-rare preset had no long snapshot. The same kind of growth came from a 60-minute interval instead. Both looked like 'vacuum is broken', but one needed a transaction ended and the other needed a schedule changed. The fix depends on which constraint is holding the horizon.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`pg_stat_user_tables`: `n_dead_tup`, `n_live_tup`, `last_autovacuum`, and `autovacuum_count` for the table.",
      "`pg_stat_activity`: the oldest `xact_start`, long queries, and sessions idle in transaction.",
      "`pg_replication_slots`: inactive slots that retain WAL and can hold the cleanup horizon.",
      "`pg_stat_progress_vacuum`: whether a vacuum is running, what phase it is in, and how much it has processed.",
      "Bloat measurement: `pgstattuple` or a carefully validated estimate query; the catalog counters alone do not prove physical bloat.",
      "Latency and plan changes: more shared buffers read per query, or a sequential scan where an index scan used to win.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the oldest snapshot before changing autovacuum settings. If a transaction or replication slot is holding the horizon, more frequent vacuum will run, fail to remove the tuples, and add I/O. End the blocker first, then measure whether the table actually needs a rewrite.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the oldest transaction or replication slot and decide whether it can be ended or moved to a replica.",
      "Set `idle_in_transaction_session_timeout` and a statement timeout for interactive and reporting paths.",
      "Let autovacuum catch up, then check dead-tuple counts and bloat again.",
      "Tune autovacuum for high-churn tables: lower the scale factor, raise the cost limit carefully, and set per-table options.",
      "Run `VACUUM (ANALYZE)` during a quiet window and watch query latency while it runs.",
      "Use `VACUUM FULL` or `pg_repack` only when disk must be returned; schedule it with a lock and capacity plan.",
      "Monitor `age(datfrozenxid)` and the visibility map, not only table size.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More frequent vacuum keeps bloat lower but consumes I/O that queries could use.",
      "A lower fillfactor leaves room for updates on the same page but makes the table larger from the start.",
      "VACUUM FULL returns disk but blocks the table; pg_repack reduces blocking but needs extra disk and triggers.",
      "Killing a long reporting transaction restores cleanup but may lose work and break a report.",
      "Longer autovacuum intervals reduce background I/O but let dead tuples accumulate and latency rise.",
      "Bloat estimates are approximate; a rewrite based on a bad estimate can cost hours for little gain.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-bloat",
    question: "A table has 10 million live rows and grows every week. Deletes run nightly. What do you check?",
    difficulty: 3,
    hints: [
      "Deletes mark tuples dead; something must remove them.",
      "Start with the oldest snapshot, not with a rewrite.",
    ],
    answer:
      "I would check `pg_stat_user_tables` for dead tuples and the last autovacuum, then look for the oldest snapshot in `pg_stat_activity` and `pg_replication_slots`. If a long transaction or inactive slot is holding the horizon, vacuum cannot remove the dead tuples no matter how often it runs. I would also check the table's update rate and autovacuum settings, and measure bloat with `pgstattuple` before planning a rewrite. Ending the blocker and letting vacuum catch up is the first fix; VACUUM FULL or pg_repack is for returning disk after cleanup.",
    followUps: [
      "How do you prove the space is reusable rather than merely free?",
      "What does a replication slot have to do with bloat?",
      "When would you choose pg_repack over VACUUM FULL?",
    ],
    redFlags: [
      "Runs VACUUM FULL first.",
      "Assumes autovacuum is disabled because dead tuples remain.",
      "Ignores long-running transactions and slots.",
    ],
    rubric: [
      "Checks dead tuples and last autovacuum.",
      "Finds the oldest snapshot or slot.",
      "Measures bloat before rewriting.",
      "Explains reusable versus returned space.",
    ],
  },
  {
    id: "vacuum-vs-full",
    question: "What is the difference between VACUUM and VACUUM FULL, and when do you use each?",
    difficulty: 2,
    hints: [
      "One makes space reusable; the other rewrites the file.",
      "One takes a much stronger lock.",
    ],
    answer:
      "VACUUM marks dead tuple space as reusable inside the existing table file and updates the visibility map. It runs alongside normal traffic. VACUUM FULL rewrites the table into a new file, returns the old space to the operating system, and takes an ACCESS EXCLUSIVE lock that blocks reads and writes. I use ordinary or autovacuum routinely, and reserve VACUUM FULL or pg_repack for a table whose physical size is causing a real problem after cleanup has caught up.",
    followUps: [
      "What lock does VACUUM FULL take?",
      "How does pg_repack avoid the long lock?",
      "Why does a regular VACUUM not shrink the file?",
    ],
    redFlags: [
      "Says VACUUM FULL is safe under load.",
      "Confuses reusable space with returned disk.",
      "Recommends a rewrite before fixing the snapshot.",
    ],
    rubric: [
      "Distinguishes reusable space from returned disk.",
      "Names the ACCESS EXCLUSIVE lock.",
      "Places each tool in a maintenance plan.",
      "Mentions an online alternative.",
    ],
  },
  {
    id: "wraparound",
    question: "Why is vacuum required even if the table has no deletes?",
    difficulty: 3,
    hints: [
      "Transaction IDs are finite.",
      "Freezing is part of the maintenance job.",
    ],
    answer:
      "Every write transaction consumes a transaction ID, and PostgreSQL must eventually freeze old row versions so their IDs can be reused. If vacuum cannot keep up, the database approaches transaction ID wraparound and will stop accepting writes to protect itself. That is why `age(datfrozenxid)` is a health signal even on insert-only tables, and why anti-wraparound autovacuum is more aggressive. Bloat is a performance problem; wraparound is an availability problem.",
    followUps: [
      "Which catalog column do you monitor?",
      "What happens when wraparound protection triggers?",
      "How do long snapshots affect freezing?",
    ],
    redFlags: [
      "Says vacuum only matters for deletes.",
      "Ignores `datfrozenxid`.",
      "Treats wraparound as a disk-space issue.",
    ],
    rubric: [
      "Explains transaction ID reuse.",
      "Names `age(datfrozenxid)`.",
      "Separates bloat from wraparound.",
      "Connects snapshots to freezing.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Autovacuum is enabled and high-churn tables have per-table settings.",
      "`n_dead_tup`, `last_autovacuum`, and `age(datfrozenxid)` are monitored per table.",
      "Idle-in-transaction and statement timeouts are set for application and reporting roles.",
      "Replication slots are monitored for inactive or lagging consumers.",
      "Bloat is measured with a validated method, not inferred from table size alone.",
      "A maintenance plan covers VACUUM FULL or pg_repack with lock and disk requirements.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the oldest snapshot and the query or slot that owns it.",
      "Check whether vacuum is running and what phase it is in.",
      "Decide whether to end the blocker, wait, or schedule a rewrite.",
      "Watch query latency and I/O while cleanup runs.",
      "Do not run VACUUM FULL under peak traffic without an explicit lock plan.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm dead tuples and bloat fell after the blocker was removed.",
      "Tune autovacuum for the tables that fell behind.",
      "Add an alert for the oldest snapshot age, not just dead-tuple count.",
      "Record the rewrite or cleanup time and its impact on latency.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Routine Vacuuming",
    url: "https://www.postgresql.org/docs/current/routine-vacuuming.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "MVCC, dead tuples, autovacuum, visibility, and transaction ID wraparound.",
  },
  {
    title: "PostgreSQL: VACUUM",
    url: "https://www.postgresql.org/docs/current/sql-vacuum.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "VACUUM and VACUUM FULL behavior, locking, and space reuse.",
  },
  {
    title: "PostgreSQL: Monitoring Statistics",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Table activity, vacuum progress, and session state used to find the blocker.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vacuum-bloat": {
      model: bloatModel,
      presets,
      instructions:
        "Start Healthy, apply Snapshot blocks vacuum, then compare it with Vacuum too rare. Lower the snapshot age before changing the vacuum interval.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Table size, bloat, latency, and thresholds are teaching values, not PostgreSQL guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-indexing",
    "databases-long-transactions",
    "databases-query-plans",
    "databases-primary-replica-lag",
    "databases-storage-autoscaling",
  ],
};
