import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "changeRate",
    label: "Change rate",
    min: 10,
    max: 5_000,
    step: 10,
    value: 500,
    unit: " rows/s",
    group: "Database",
    help: "Rows changed per second in the source database. The log emits one change record per row change.",
    format: "rps" as const,
  },
  {
    id: "tableRows",
    label: "Table size",
    min: 100_000,
    max: 50_000_000,
    step: 100_000,
    value: 2_000_000,
    unit: " rows",
    group: "Snapshot",
    help: "Rows in the table being captured. The initial snapshot has to read this before streaming catches up.",
    format: "count" as const,
  },
  {
    id: "snapshotRate",
    label: "Snapshot read rate",
    min: 1_000,
    max: 200_000,
    step: 1_000,
    value: 200_000,
    unit: " rows/s",
    group: "Snapshot",
    help: "Rows per second the snapshot can read. Snapshot duration is table size divided by this rate.",
    format: "rps" as const,
  },
  {
    id: "schemaChange",
    label: "Incompatible schema change",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 applies a column change the connector and downstream projection cannot decode, stopping the stream.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  changeRate: number;
  tableRows: number;
  snapshotRate: number;
  schemaChange: boolean;
  snapshotSeconds: number;
  lagRows: number;
  lagSeconds: number;
  progress: number;
  schemaErrors: number;
  throughput: number;
}

function compute(p: Params, lagRows: number, progress: number): Values {
  const changeRate = Math.round(clamp(num(p, "changeRate", 500), 10, 5_000));
  const tableRows = Math.round(clamp(num(p, "tableRows", 2_000_000), 100_000, 50_000_000));
  const snapshotRate = Math.round(clamp(num(p, "snapshotRate", 200_000), 1_000, 200_000));
  const schemaChange = num(p, "schemaChange", 0) >= 1;
  const snapshotSeconds = tableRows / snapshotRate;
  return {
    changeRate,
    tableRows,
    snapshotRate,
    schemaChange,
    snapshotSeconds,
    lagRows,
    lagSeconds: lagRows / Math.max(1, changeRate),
    progress,
    schemaErrors: schemaChange ? 1 : 0,
    throughput: schemaChange ? 0 : changeRate,
  };
}

function buildFrame(p: Params, seed: number, lagRows: number, progress: number): SimFrame {
  const values = compute(p, lagRows, progress);
  const connectorHealth = values.schemaChange ? "crit" : values.lagSeconds >= 300 ? "crit" : values.lagSeconds >= 60 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "database",
        label: "Orders database",
        kind: "db",
        health: "ok",
        utilization: clamp(values.changeRate / 5_000),
        throughput: values.changeRate,
        sublabel: `${values.changeRate.toLocaleString("en-US")} changes/s`,
        detail: `The source of truth. Its write-ahead log or binary log records every row change, including deletes and before/after images when configured.`,
        meta: { view: "flow" },
      },
      {
        id: "log",
        label: "Database log",
        kind: "storage",
        health: "ok",
        utilization: clamp(values.lagRows / 10_000_000),
        throughput: values.changeRate,
        sublabel: values.schemaChange ? "retaining changes" : "streaming changes",
        detail: `The log keeps changes in commit order. A CDC connector reads it without querying the table, so polling load disappears but log retention becomes a constraint.`,
        meta: { view: "flow" },
      },
      {
        id: "connector",
        label: "CDC connector",
        kind: "worker",
        health: connectorHealth,
        utilization: clamp(values.schemaChange ? 1 : values.lagSeconds / 600),
        throughput: values.throughput,
        capacity: values.changeRate,
        sublabel: values.schemaChange ? "stopped on schema" : `${values.progress.toFixed(0)}% snapshot`,
        detail: values.schemaChange
          ? "The connector hit a schema it cannot decode and stopped. Log retention keeps growing while the stream falls behind."
          : `The connector is reading the initial snapshot (${values.progress.toFixed(0)}% complete) while also buffering changes from the log.`,
        meta: { view: "flow", lag: values.lagSeconds },
      },
      {
        id: "index",
        label: "Search index",
        kind: "storage",
        health: connectorHealth,
        utilization: clamp(values.lagSeconds / 600),
        throughput: values.throughput,
        sublabel: `${values.lagSeconds.toFixed(0)}s behind`,
        detail: `The downstream projection applies inserts, updates, and deletes. A tombstone must remove the document; ignoring it leaves a deleted row visible forever.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("db-log", "database", "log", clamp(values.changeRate / 5_000), "ok"),
      edge("log-connector", "log", "connector", values.schemaChange ? 0 : clamp(values.lagRows / 10_000_000), connectorHealth),
      edge("connector-index", "connector", "index", values.schemaChange ? 0 : clamp(values.changeRate / 5_000), connectorHealth),
    ],
    metrics: [
      metric("replication-lag", "Replication lag", values.lagSeconds, " s", 60, 300, "ms"),
      metric("schema-errors", "Schema compatibility errors", values.schemaErrors, "", 0.5, 1, "count"),
      metric("snapshot-progress", "Snapshot progress", values.progress, "%", undefined, undefined, "percent"),
      metric("apply-throughput", "Apply throughput", values.throughput, " rows/s", undefined, undefined, "rps"),
      metric("log-backlog", "Log backlog", values.lagRows, " changes", 1_000_000, 5_000_000, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, lagJson: String(values.lagRows), progress: values.progress, schemaChange: values.schemaChange ? 1 : 0 },
    summary: values.schemaChange
      ? `CDC stopped on an incompatible schema; ${Math.round(values.lagRows).toLocaleString("en-US")} changes buffered and lag ${values.lagSeconds.toFixed(0)}s.`
      : `CDC at ${values.progress.toFixed(0)}% snapshot; replication lag ${values.lagSeconds.toFixed(0)}s.`,
  };
}

function seedSeries(frame: SimFrame, values: Values): void {
  for (let index = 0; index < 24; index++) {
    recordSeries(frame, "replication-lag", Math.max(0, values.lagSeconds * (0.96 + 0.04 * Math.sin(index / 2.4))));
    recordSeries(frame, "schema-errors", values.schemaErrors);
    recordSeries(frame, "snapshot-progress", Math.max(0, values.progress * (0.99 + 0.01 * Math.sin(index / 2))));
    recordSeries(frame, "apply-throughput", Math.max(0, values.throughput * (0.98 + 0.02 * Math.sin(index / 2.7))));
    recordSeries(frame, "log-backlog", Math.max(0, values.lagRows * (0.97 + 0.03 * Math.sin(index / 2.2))));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "replication-lag",
    metricId: "replication-lag",
    warn: 60,
    crit: 300,
    title: "The downstream projection is far behind the database",
    cause:
      "CDC still has to apply changes. A long initial snapshot, a slow connector, or a stopped stream makes the index stale even though the source is current. Lag is measured from the commit time of the oldest unapplied change.",
    fix:
      "Speed up the snapshot with parallel reads, scale the connector, or restore the stream after the schema fix. If the log retention window is shorter than the lag, the pipeline cannot catch up without a new snapshot.",
    checkFirst: [
      "Check connector lag and the age of the oldest unapplied change.",
      "Check snapshot progress and whether the connector is still in snapshot phase.",
      "Check log retention against the time needed to catch up.",
    ],
  },
  {
    id: "schema-errors",
    metricId: "schema-errors",
    warn: 0.5,
    crit: 1,
    title: "A schema change stopped the CDC stream",
    cause:
      "The source table changed in a way the connector or downstream projection cannot decode, such as a dropped column, a type change, or a new non-null field. The connector stops rather than emitting corrupt records.",
    fix:
      "Apply the schema change through a compatible migration, update the connector and projection, and restart from the last committed offset. Prefer additive changes and a compatibility check before the DDL.",
    checkFirst: [
      "Check the connector error and the DDL timestamp.",
      "Check whether the change was additive or destructive.",
      "Check whether the downstream projection has applied the new schema.",
    ],
  },
  {
    id: "log-backlog",
    metricId: "log-backlog",
    warn: 1_000_000,
    crit: 5_000_000,
    title: "The log backlog may exceed retention",
    cause:
      "A stopped or slow connector lets changes accumulate in the database log. If the backlog outlives the log retention window, the missing changes cannot be replayed and a fresh snapshot is required.",
    fix:
      "Restore the connector before retention expires, or plan a resnapshot with the downstream projection paused. Monitor log size and retention alongside lag.",
    checkFirst: [
      "Compare the oldest unapplied change with log retention.",
      "Check database log disk usage.",
      "Check whether the connector offset is advancing.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const cdcModel: SimModel = {
  id: "streaming-cdc",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, 0);
    const frame = buildFrame(defaults(), seed, 0, 0);
    seedSeries(frame, values);
    return frame;
  },
  step: (frame, p, dt) => {
    const previousLag = Number(frame.flags.lagJson ?? 0);
    const base = compute(p, previousLag, Number(frame.flags.progress ?? 0));
    const seconds = Math.min(1, Math.max(0.01, dt));
    const done = frame.t >= base.snapshotSeconds;
    const stalled = base.schemaChange;
    const lagRows = stalled || !done
      ? previousLag + base.changeRate * seconds
      : Math.max(0, previousLag - base.changeRate * 2 * seconds);
    const progress = Math.min(100, (Math.min(frame.t, base.snapshotSeconds) / base.snapshotSeconds) * 100);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), lagRows, progress);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0, 0);
    const items: string[] = [];
    items.push(`The initial snapshot reads ${values.tableRows.toLocaleString("en-US")} rows at ${values.snapshotRate.toLocaleString("en-US")} rows/s, so it takes about ${values.snapshotSeconds.toFixed(0)} seconds before streaming catches up.`);
    items.push("While the snapshot runs, the connector must also buffer live changes from the log. Snapshot duration is the first lag budget.");
    items.push(values.schemaChange ? "The incompatible schema has stopped the stream. Lag now grows until the connector and projection are updated." : "With a compatible schema, the connector applies changes in commit order and the projection converges.");
    items.push("Deletes arrive as delete events or tombstones. A projection that ignores them keeps a row the source no longer has.");
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
    description: "A 2M-row table snapshots in 10 seconds, then streams 500 changes/s.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Large snapshot",
    description: "A 20M-row table at 100k rows/s; the snapshot alone takes over three minutes.",
    tone: "warn",
    params: defaults({ tableRows: 20_000_000, snapshotRate: 100_000, changeRate: 1_000 }),
  },
  {
    id: "failure",
    label: "Schema change",
    description: "An incompatible column change stops the connector while the log fills.",
    tone: "crit",
    params: defaults({ tableRows: 20_000_000, snapshotRate: 100_000, changeRate: 1_000, schemaChange: 1 }),
  },
  {
    id: "recovery",
    label: "Compatible schema",
    description: "The schema migration is additive, the snapshot completes, and the stream catches up.",
    tone: "ok",
    params: defaults({ tableRows: 5_000_000, snapshotRate: 200_000, changeRate: 500, schemaChange: 0 }),
  },
  {
    id: "polling",
    label: "Hourly polling",
    description: "Polling a large table on a schedule leaves the index up to an hour stale.",
    tone: "warn",
    params: defaults({ tableRows: 50_000_000, snapshotRate: 50_000, changeRate: 2_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-cdc-lag",
  title: "Predict CDC lag during the first snapshot",
  simId: "cdc",
  question:
    "A 20M-row table is captured for the first time at 100k rows/s. Live changes continue at 1k rows/s. What does the downstream index see during the snapshot?",
  prediction: {
    options: [
      { id: "instant", label: "It is current immediately because CDC reads the log, not the table" },
      { id: "catching-up", label: "It starts behind while the snapshot runs, then catches up from the buffered log" },
      { id: "lost", label: "Changes during the snapshot are lost and must be backfilled manually" },
      { id: "nothing", label: "No data until the snapshot finishes, then a full copy appears atomically" },
    ],
    correctOptionId: "catching-up",
    explanation:
      "Log-based CDC avoids polling, but the first run still has to read the existing table. While that snapshot runs, the connector buffers new changes from the log. The index is behind until the snapshot completes and the connector applies the buffered changes. If the log retention is shorter than the snapshot, the backlog is lost and a new snapshot is needed.",
  },
  setup: defaults({ tableRows: 20_000_000, snapshotRate: 100_000, changeRate: 1_000, schemaChange: 0 }),
  runFor: 30,
  observe: [
    "Lag grows during the snapshot because changes are buffered while rows are read.",
    "The snapshot progress metric rises independently of lag.",
    "After the snapshot, the connector drains the buffer and lag falls.",
    "An incompatible schema stops progress and lets lag grow without bound.",
  ],
  explain:
    "CDC reads the database log, so steady-state lag can be seconds instead of a polling interval. The first snapshot is the exception: it reads the table while changes continue. Snapshot size, read rate, and log retention determine whether the pipeline can catch up. Schema changes and deletes are the operational edges that make CDC more than a log reader.",
  fix: defaults({ tableRows: 5_000_000, snapshotRate: 200_000, changeRate: 500, schemaChange: 0 }),
  debrief:
    "The fix parallelizes the snapshot and reduces the table being captured, so the initial lag window shrinks. The trade is snapshot load on the source database and the need to keep log retention longer than the snapshot plus catch-up time. After the snapshot, lag settles near the apply rate rather than the polling interval.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Change data capture (CDC) turns database changes into a stream by reading the database log, such as PostgreSQL write-ahead log (WAL) or MySQL binary log (binlog). Instead of polling a table for updated timestamps, a connector reads committed changes in order and emits insert, update, and delete events. The downstream projection applies them without querying the source.",
  },
  {
    type: "p",
    text: "Steady-state CDC can be seconds behind because it follows the log, not a schedule. The first run is different: the connector must snapshot the existing table while changes keep arriving. That snapshot is a bulk read, and the live changes are buffered until it finishes. Snapshot size, read rate, and log retention decide whether the pipeline ever catches up.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is database, log, connector, stream, downstream projection. The connector records an offset in the log and commits it after the downstream write, which gives at-least-once delivery. A delete becomes a delete event or a tombstone, depending on the connector and the log format. Schema changes alter the shape of every subsequent event.",
  },
  {
    type: "table",
    headers: ["Concern", "CDC behavior", "Operational cost"],
    rows: [
      ["Freshness", "Follows committed log changes", "Seconds of lag after catch-up"],
      ["Initial load", "Snapshot plus buffered changes", "Source read load and a longer lag window"],
      ["Deletes", "Delete event or tombstone", "Projection must remove documents, not just upsert"],
      ["Schema change", "Connector decodes a new row shape", "Migration sequencing and connector upgrades"],
      ["Retention", "Log must cover the lag window", "Disk and retention configuration"],
    ],
  },
  {
    type: "p",
    text: "This module uses up to 50M rows, 200k snapshot rows/s, and 5k changes/s. Those are illustrative teaching values. The shape of the failure is the lesson: the connector is current on the log but still behind on the snapshot, or it stops entirely on a schema it cannot decode.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Replication lag in seconds, measured from the oldest unapplied change. Warning at 60 seconds, critical at 300.",
      "Schema compatibility errors, which stop the stream. Critical on the first error.",
      "Snapshot progress, apply throughput, and log backlog, which show whether catch-up is possible.",
      "A flow view from database log through connector to the downstream index.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, apply Large snapshot, and run the experiment before switching to CDC. Compare Schema change with Compatible schema. Watch lag and log backlog, and check whether snapshot progress is still moving.",
  },
  { type: "sim", simId: "cdc" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "During the snapshot, the connector read 20M rows at 100k rows/s while 1k changes/s arrived. The index was behind for the whole 200-second snapshot, then caught up from the buffered log once streaming resumed. Lag was not caused by the log; it was caused by the bulk read that precedes streaming.",
  },
  {
    type: "p",
    text: "An incompatible schema stopped the connector instead of producing corrupt documents. Lag and log backlog kept growing while the downstream unchanged. Recovery required updating the connector and projection, then restarting from the committed offset. A delete adds a different edge: ignoring the tombstone leaves a document that the source has already removed.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Connector metrics: lag, offset commit rate, snapshot phase, and error count.",
      "Database log size, retention, and disk usage relative to the lag window.",
      "Downstream apply latency, error rate, and document count versus source rows.",
      "Schema registry or connector logs around DDL timestamps.",
      "Deleted rows still present downstream, which indicate an unhandled tombstone.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the connector is still in snapshot or already streaming. Compare lag with log retention, because a backlog older than retention cannot be replayed. Check the last DDL and connector error. Then check deletes and the projection's handling of tombstones.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Size the snapshot: rows, read rate, and the time to catch up on buffered changes.",
      "Keep log retention longer than the snapshot plus the worst acceptable catch-up.",
      "Run snapshot reads at a rate the source database can tolerate.",
      "Apply schema changes additively and update the connector and projection before the DDL reaches production.",
      "Handle delete events and tombstones in the projection, not just inserts and updates.",
      "Commit offsets only after the downstream write, then make the downstream idempotent.",
      "Alert on lag, snapshot progress, log backlog, and schema errors together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "CDC lowers steady-state lag but adds a connector, log access, and schema management.",
      "The initial snapshot loads the source database and delays freshness for its duration.",
      "Log retention must cover the longest outage you intend to recover from.",
      "Deletes and tombstones require projection logic that polling snapshots often avoided.",
      "At-least-once delivery needs idempotent downstream writes.",
      "Schema changes become a coordinated deploy between the database, connector, and consumer.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cdc-vs-polling",
    question:
      "A downstream index polls the database every hour and is stale. Would you move to CDC? What do you need to check first?",
    difficulty: 2,
    hints: [
      "Polling lag is bounded by the interval.",
      "CDC still has an initial snapshot and schema handling.",
    ],
    answer:
      "CDC can reduce steady-state lag from an hour to seconds because it follows the log instead of a schedule. Before choosing it, I would check whether the database log is enabled and retained long enough, whether the table is large enough that the initial snapshot creates a long lag window, and whether the team can operate a connector and handle schema changes and deletes. If the freshness requirement is minutes, a shorter polling interval may be cheaper.",
    followUps: [
      "What log retention would you require?",
      "How do you backfill after a failed snapshot?",
      "When is polling still the right choice?",
    ],
    redFlags: [
      "Assumes CDC has no initial lag.",
      "Ignores schema and delete handling.",
      "Cannot state the freshness requirement.",
    ],
    rubric: [
      "Compares steady-state lag and snapshot cost.",
      "Names log retention and schema work.",
      "Chooses based on a freshness requirement.",
    ],
  },
  {
    id: "schema-change",
    question:
      "A connector stops after a column type change. What is the safe recovery sequence?",
    difficulty: 3,
    hints: [
      "The log keeps the changes if retention allows.",
      "Update the connector and projection before restarting.",
    ],
    answer:
      "I would confirm the log retention still covers the stop time. Then I would update the connector and the downstream projection for the new type, test the decode on a sample, and restart from the last committed offset. If retention has passed, I need a new snapshot. I would not skip the change or force the old type, because that risks corrupting the projection. The longer-term fix is an additive migration and a compatibility check before DDL.",
    followUps: [
      "What if the old and new types are incompatible for consumers?",
      "How do you verify the projection after restart?",
      "Who owns the schema change?",
    ],
    redFlags: [
      "Restarts without updating the projection.",
      "Ignores log retention.",
      "Forces a cast without testing.",
    ],
    rubric: [
      "Checks retention first.",
      "Updates connector and projection.",
      "Restarts from a committed offset or resnapshots.",
    ],
  },
  {
    id: "tombstone",
    question:
      "Users still see deleted records in search after CDC is enabled. What is missing?",
    difficulty: 3,
    hints: [
      "A delete is an event, not the absence of an update.",
      "The projection must remove the document.",
    ],
    answer:
      "The projection is probably treating every change as an upsert and ignoring delete events or tombstones. CDC emits a delete with the key and sometimes the before image; the search index has to remove or mark the document deleted. I would check the connector's delete handling, the projection's event switch, and whether ordering lets a late update recreate a deleted document. Idempotent deletes and a version or tombstone marker help.",
    followUps: [
      "How do you prevent a late update from recreating the document?",
      "What does a tombstone contain?",
      "How would you reconcile the index with the source?",
    ],
    redFlags: [
      "Only handles inserts and updates.",
      "Assumes the search engine expires documents.",
      "Ignores event ordering.",
    ],
    rubric: [
      "Identifies missing delete handling.",
      "Describes tombstone or delete semantics.",
      "Addresses late updates and reconciliation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Log retention covers the snapshot and the longest acceptable catch-up.",
      "Snapshot size and read rate are measured against source database capacity.",
      "Connector and projection handle inserts, updates, deletes, and tombstones.",
      "Schema changes go through an additive, tested migration path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the connector is in snapshot or streaming.",
      "Compare lag with log retention before assuming replay is possible.",
      "Check the last DDL and connector error.",
      "Pause the projection rather than applying corrupt records.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify row counts and deleted documents against the source.",
      "Reconcile the index after any resnapshot.",
      "Rehearse a schema change through the full pipeline.",
    ],
  },
];

const references = [
  {
    title: "Debezium architecture and CDC",
    url: "https://debezium.io/documentation/reference/stable/architecture.html",
    publisher: "Debezium",
    kind: "docs" as const,
    note: "Log-based capture, snapshots, offsets, and at-least-once delivery.",
  },
  {
    title: "AWS DMS: change data capture",
    url: "https://docs.aws.amazon.com/dms/latest/userguide/CHAP_Task.CDC.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Ongoing replication, source log requirements, and CDC task behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    cdc: {
      model: cdcModel,
      presets,
      instructions:
        "Start healthy, apply Large snapshot, then run the experiment. Compare Schema change and Compatible schema. Watch lag, schema errors, snapshot progress, and log backlog.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Table sizes, snapshot rates, and lag values are teaching values, not database benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["streaming-outbox", "streaming-consumer-lag", "streaming-schema-registry"],
};
