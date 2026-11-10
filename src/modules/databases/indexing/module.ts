import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TABLE_ROWS = 10_000_000;
const SEQ_SCAN_MS = 940;

const params = [
  {
    id: "selectivity",
    label: "Predicate selectivity",
    min: 0.01,
    max: 50,
    step: 0.01,
    value: 1,
    unit: "%",
    group: "Query",
    help: "Share of table rows the predicate matches. Low selectivity favors an index; high selectivity usually favors a sequential scan.",
    format: "percent" as const,
  },
  {
    id: "wrapped",
    label: "Function-wrapped predicate",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Query",
    help: "1 models `WHERE lower(email) = ...` or another function on the indexed column. A plain B-tree on the column cannot serve that predicate.",
    format: "count" as const,
  },
  {
    id: "leading",
    label: "Leading index column",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Index",
    help: "1 means the queried column is first in the composite index. 0 means it sits behind a column the query does not filter.",
    format: "count" as const,
  },
  {
    id: "indexCount",
    label: "Indexes on the table",
    min: 1,
    max: 10,
    step: 1,
    value: 2,
    unit: "",
    group: "Index",
    help: "Every insert and update must maintain each index and write its own WAL records.",
    format: "count" as const,
  },
  {
    id: "writeRate",
    label: "Row change rate",
    min: 100,
    max: 20_000,
    step: 100,
    value: 800,
    unit: " rows/s",
    group: "Workload",
    help: "Inserts, updates, and deletes per second. Write latency rises with index count and change rate.",
    format: "rps" as const,
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
  selectivity: number;
  wrapped: boolean;
  leading: boolean;
  indexCount: number;
  writeRate: number;
  usable: boolean;
  matchedRows: number;
  rowsRead: number;
  readMs: number;
  writeMs: number;
  indexSizeGb: number;
  tableHealth: Health;
  indexHealth: Health;
  writeHealth: Health;
}

function compute(p: Params): Computed {
  const selectivity = clamp(num(p, "selectivity", 1), 0.01, 50);
  const wrapped = num(p, "wrapped", 0) >= 0.5;
  const leading = num(p, "leading", 1) >= 0.5;
  const indexCount = Math.round(clamp(num(p, "indexCount", 2), 1, 10));
  const writeRate = clamp(num(p, "writeRate", 800), 100, 20_000);
  const usable = !wrapped && leading;
  const matchedRows = (TABLE_ROWS * selectivity) / 100;
  const readMs = usable
    ? 1.5 + matchedRows * 0.0004 + (selectivity > 10 ? (selectivity - 10) * 6 : 0)
    : SEQ_SCAN_MS + selectivity * 4;
  const writeMs = 1.1 + indexCount * 0.45 + writeRate / 6_000;
  const rowsRead = usable ? matchedRows * 1.1 : TABLE_ROWS;
  const indexSizeGb = 0.03 + indexCount * 0.31 + selectivity * 0.004;
  return {
    selectivity,
    wrapped,
    leading,
    indexCount,
    writeRate,
    usable,
    matchedRows,
    rowsRead,
    readMs,
    writeMs,
    indexSizeGb,
    tableHealth: status(readMs, 100, 300),
    indexHealth: usable ? "ok" : "warn",
    writeHealth: status(writeMs, 3, 6),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["read-p95", values.readMs, 0.4],
    ["write-p95", values.writeMs, 0.03],
    ["rows-read", values.rowsRead, 0],
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
        id: "app",
        label: "Application",
        kind: "service",
        health: values.tableHealth,
        utilization: clamp(values.readMs / 1_200),
        sublabel: `read p95 ${values.readMs.toFixed(0)} ms`,
        detail:
          "The application measures the result. An unused index does not make a query slower by itself; the sequential scan does, while the index adds write cost elsewhere.",
        meta: { readMs: Math.round(values.readMs) },
      },
      {
        id: "planner",
        label: "Query planner",
        kind: "service",
        health: values.usable ? "ok" : "warn",
        utilization: clamp(values.selectivity / 50),
        sublabel: values.usable ? "index path available" : "index path unusable",
        detail:
          "The planner can use a B-tree only when the predicate is sargable and the index's leading column matches the query. Cost then decides between index and sequential scan.",
        meta: { usable: values.usable ? 1 : 0 },
      },
      {
        id: "index",
        label: "B-tree indexes",
        kind: "storage",
        health: values.indexHealth,
        utilization: clamp(values.indexCount / 10),
        sublabel: `${values.indexCount} indexes · ${values.indexSizeGb.toFixed(1)} GB`,
        detail:
          "Each index is a separate ordered structure with its own pages and WAL. The index can only help if the query can seek into it.",
        meta: { count: values.indexCount, sizeGb: Number(values.indexSizeGb.toFixed(1)) },
      },
      {
        id: "table",
        label: "orders table",
        kind: "db",
        role: "primary",
        health: values.tableHealth,
        utilization: clamp(values.rowsRead / TABLE_ROWS),
        sublabel: values.usable ? `${formatCount(values.rowsRead)} rows read` : "full scan · 10M rows",
        detail:
          "The heap holds the rows. An index scan reads matching entries and then fetches rows; a sequential scan reads every page.",
        meta: { rows: TABLE_ROWS },
      },
    ],
    edges: [
      edge("app-planner", "app", "planner", clamp(values.selectivity / 50), values.tableHealth, "query"),
      edge(
        "planner-index",
        "planner",
        "index",
        values.usable ? 0.9 : 0.05,
        values.usable ? "ok" : "warn",
        "index scan",
      ),
      edge(
        "planner-table",
        "planner",
        "table",
        values.usable ? 0.2 : 0.95,
        values.tableHealth,
        values.usable ? "heap fetch" : "sequential scan",
      ),
      edge("index-table", "index", "table", values.usable ? 0.8 : 0.05, values.tableHealth, "row lookup"),
    ],
    metrics: [
      metric("read-p95", "Read p95", values.readMs, " ms", 100, 300, "ms"),
      metric("write-p95", "Write p95", values.writeMs, " ms", 3, 6, "ms"),
      metric("rows-read", "Rows read per query", values.rowsRead, " rows", undefined, undefined, "count"),
      metric("index-size", "Index storage", values.indexSizeGb, " GB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.usable ? "Index usable" : "Index unusable"}; read p95 ${values.readMs.toFixed(
      0,
    )} ms; write p95 ${values.writeMs.toFixed(2)} ms; ${values.indexCount} index${
      values.indexCount === 1 ? "" : "es"
    }.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "read-latency",
    metricId: "read-p95",
    warn: 100,
    crit: 300,
    title: "Sequential scan dominates read latency",
    cause:
      "The predicate is not sargable or the index's leading column does not match, so the B-tree cannot serve the query. The planner falls back to reading the whole table.",
    fix:
      "Rewrite the predicate to compare the bare column, add an expression index for the function, or reorder the composite index so the filtered column leads. Confirm with EXPLAIN that the index is used.",
    checkFirst: [
      "Run `EXPLAIN (ANALYZE, BUFFERS)` and compare estimated with actual rows.",
      "Check whether the predicate wraps the column in a function or a cast.",
      "Compare the composite index column order with the query's equality predicates.",
    ],
  },
  {
    id: "write-latency",
    metricId: "write-p95",
    warn: 3,
    crit: 6,
    title: "Index maintenance is taxing writes",
    cause:
      "Every insert and update maintains each index and writes WAL for the new entries. More indexes mean more random page writes, more cache pressure, and longer commit latency.",
    fix:
      "Drop indexes with no scans, merge overlapping indexes, and prefer a covering or partial index over several narrow ones. Measure `idx_scan` before removing anything.",
    checkFirst: [
      "Check `pg_stat_user_indexes` for `idx_scan` and `pg_stat_user_tables` for HOT update counts.",
      "Compare write latency with the number of indexes before and after the change.",
      "Look for duplicate indexes with the same leading columns.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const indexingModel: SimModel = {
  id: "databases-indexing",
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
    if (!values.usable && frame.flags.unusedIndexLogged !== 1) {
      pushEvent(next, {
        id: "index-unusable",
        severity: values.readMs >= 300 ? "crit" : "warn",
        title: "Index cannot serve this predicate",
        detail: values.wrapped
          ? "The predicate wraps the indexed column in a function, so a plain B-tree on the column cannot be used."
          : "The queried column is not the leading column of the composite index, so the B-tree cannot seek on it.",
        nodeId: "index",
        metricId: "read-p95",
      });
    }
    if (values.writeMs >= 6 && frame.flags.writeCostLogged !== 1) {
      pushEvent(next, {
        id: "write-amplification",
        severity: "crit",
        title: "Index maintenance is the write bottleneck",
        detail: `${values.indexCount} indexes at ${formatCount(
          values.writeRate,
        )} row changes per second push write p95 to ${values.writeMs.toFixed(2)} ms.`,
        nodeId: "index",
        metricId: "write-p95",
      });
    }
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.unusedIndexLogged = values.usable ? 0 : 1;
    next.flags.writeCostLogged = values.writeMs >= 6 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.usable ? "Index usable" : "Index unusable"}; read p95 ${values.readMs.toFixed(
      0,
    )} ms; write p95 ${values.writeMs.toFixed(2)} ms; ${values.indexCount} index${
      values.indexCount === 1 ? "" : "es"
    }.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      values.usable
        ? `The index can serve the predicate. At ${values.selectivity}% selectivity it reads about ${formatCount(
            values.rowsRead,
          )} rows and returns in ${values.readMs.toFixed(0)} ms.`
        : `The index cannot serve this predicate. The query reads all ${formatCount(
            TABLE_ROWS,
          )} rows and takes ${values.readMs.toFixed(0)} ms, while the index still costs writes.`,
      `Each of the ${values.indexCount} indexes adds roughly 0.45 ms to write p95 at this rate. Removing one helps writes but may hurt a different query.`,
      "A composite index is only usable from its leading column. Put equality predicates first, then the range or sort column.",
      "Selectivity decides whether an index is worth it: a predicate matching most of the table is usually cheaper as a sequential scan.",
      "Adding an index to a write-heavy table is a trade, not a free read optimization.",
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
    description: "A selective predicate on the leading column with two indexes. Read and write latency stay low.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak writes",
    description: "Six thousand row changes per second with four indexes. Reads and writes both warn without crossing critical.",
    tone: "warn",
    params: defaults({ selectivity: 3, indexCount: 4, writeRate: 6_000 }),
  },
  {
    id: "failure",
    label: "Function-wrapped predicate",
    description: "A 25 percent predicate wrapped in a function with eight indexes at 12,000 changes per second. The index is unusable and writes are critical.",
    tone: "crit",
    params: defaults({ selectivity: 25, wrapped: 1, indexCount: 8, writeRate: 12_000 }),
  },
  {
    id: "covering",
    label: "Covering index",
    description: "A two percent predicate served by a covering index with three indexes on the table.",
    tone: "ok",
    params: defaults({ selectivity: 2, indexCount: 3, writeRate: 2_000 }),
  },
  {
    id: "recovery",
    label: "Sargable and lean",
    description: "The predicate compares the bare column and the table keeps only two indexes. Reads and writes return to healthy.",
    tone: "ok",
    params: defaults({ selectivity: 0.5, indexCount: 2, writeRate: 1_200 }),
  },
];

const experiment: Experiment = {
  id: "predict-unusable-index",
  title: "Predict what the index can do",
  simId: "indexing",
  question:
    "A ten-million-row table has a B-tree on `email`, and the query filters `WHERE lower(email) = '...'`, matching about two percent of rows. What happens?",
  prediction: {
    options: [
      { id: "seq", label: "The index is unusable and the query scans the table; extra indexes only add write cost." },
      { id: "index-only", label: "The B-tree is used as an index-only scan and returns in a few milliseconds." },
      { id: "used-slower", label: "The planner uses the index but it is slower than a sequential scan." },
      { id: "write-falls", label: "Adding more indexes lowers write latency because each write finds a smaller index." },
    ],
    correctOptionId: "seq",
    explanation:
      "A plain B-tree on `email` is ordered by the stored value. Wrapping the column in `lower()` changes the value being compared, so the index cannot be used unless you create an expression index on `lower(email)`. The fallback is a sequential scan of all ten million rows. Every additional index still costs write time and space.",
  },
  setup: defaults({ selectivity: 2, wrapped: 1, indexCount: 2, writeRate: 4_000 }),
  runFor: 20,
  observe: [
    "Rows read is ten million, not the roughly 200,000 rows that match.",
    "Read p95 is about 948 ms against a 300 ms critical line.",
    "The index and planner nodes show the index path as unusable.",
    "Write p95 is about 2.7 ms: the index still costs writes even though it is not read.",
    "The number of indexes does not change the scan: it changes only the write cost.",
  ],
  explain:
    "The planner cannot seek a B-tree with a value produced by a function applied to the indexed column. The query reads the heap sequentially. The index entries are still maintained on every write, so the table pays both the scan and the index cost. The fix is an expression index or a predicate that compares the bare column.",
  fix: defaults({ selectivity: 2, wrapped: 0, indexCount: 2, writeRate: 4_000 }),
  debrief:
    "Rewriting the predicate or adding an expression index makes the index usable and drops read p95 to about 82 ms. Two indexes at 4,000 changes per second keep write p95 around 2.7 ms. The index is now a real trade rather than pure overhead.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A B-tree index is a separate ordered structure keyed by one or more columns. It lets the database seek to a range instead of reading every row. The index does not change the table; it adds a second structure that must be kept in sync with every insert, update, and delete.",
  },
  {
    type: "p",
    text: "An index can serve a query only when the predicate matches how the index is ordered. The compared value must be the bare column, which is what sargable means, and the first column of a composite index must match the query's equality or range predicate. A function around the column changes the value being compared, so a plain B-tree on that column cannot seek into it.",
  },
  {
    type: "p",
    text: "Selectivity decides whether an index is worth using. A predicate matching a few rows reads a small part of the index and fetches those rows. A predicate matching most of the table reads almost every row anyway, and the planner may choose a sequential scan because it is cheaper. The crossover depends on row size, correlation, cache, and cost settings, not on a fixed percentage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The planner sits between the query and the storage structures. It evaluates predicates, estimates row counts from statistics, and compares the cost of an index scan with a sequential scan. The chosen plan drives the executor, which reads index pages and heap pages. Separately, every write path updates each index and writes its own WAL, so the same index that speeds a read adds work to every write.",
  },
  {
    type: "compare",
    leftTitle: "Index seek",
    rightTitle: "Sequential scan",
    rows: [
      { label: "Reads", left: "Matching index entries plus heap rows", right: "Every page in the table" },
      { label: "Best when", left: "Predicate is selective and sargable", right: "Predicate matches a large share of rows" },
      { label: "Write cost", left: "Index maintenance on every change", right: "None beyond the table itself" },
      { label: "Failure mode", left: "Unusable or unused; pure write overhead", right: "Linear latency growth with table size" },
    ],
  },
  {
    type: "table",
    headers: ["Query shape", "Can a B-tree on `email` help?"],
    rows: [
      ["`WHERE email = $1`", "Yes, equality seek on the leading column"],
      ["`WHERE lower(email) = $1`", "No, unless the index is on `lower(email)`"],
      ["`WHERE email LIKE 'ann%'`", "Yes with a matching operator class; a leading wildcard cannot use the index"],
      ["`WHERE email = $1 AND created_at > $2`", "Yes with a composite index on `(email, created_at)`; a single-column index still narrows the rows"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Read p95 and rows read per query, which show whether the index path is actually being used.",
      "Write p95 and index count, which show the maintenance cost the index adds.",
      "A function-wrapped toggle, which makes the predicate non-sargable.",
      "A leading-column toggle, which models the most common composite-index mistake.",
      "Index storage, a reminder that each index has its own pages and cache footprint.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that read latency is low with two indexes. Apply Function-wrapped predicate: reads jump to a full scan while the indexes remain. Toggle the function off, then move the leading-column toggle to 0 to see the second way an index is defeated. Finally raise the index count at a high write rate and watch write p95 cross its line.",
  },
  {
    type: "p",
    text: "Row counts, latencies, and thresholds are illustrative teaching values. They show the direction of the trade, not a benchmark for a specific table or instance class.",
  },
  { type: "sim", simId: "indexing" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With a function-wrapped predicate matching 25 percent of a ten-million-row table, the index could not be used. The query read all ten million rows and took about 1,040 ms. Eight indexes at 12,000 changes per second pushed write p95 to 6.7 ms. The table paid for the indexes on every write while getting none of the read benefit.",
  },
  {
    type: "p",
    text: "Turning off the function did not automatically make the index small or free. It made the predicate sargable, so the index could seek and the read dropped sharply. The write cost stayed tied to the number of indexes and the change rate. Those are independent knobs, and the simulator keeps them independent on purpose.",
  },
  {
    type: "p",
    text: "The leading-column toggle showed the other common failure. A composite index on `(tenant_id, email)` can serve a query that filters both, but not a query that filters only `email`, because the index is ordered by tenant first. Column order is part of the index's contract, not a cosmetic choice.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`EXPLAIN (ANALYZE, BUFFERS)` showing a sequential scan, the actual row count, and the buffers touched.",
      "`pg_stat_user_indexes`: `idx_scan` near zero on an index that is still maintained on every write.",
      "`pg_stat_user_tables`: `n_tup_upd` and `n_tup_hot_upd`, which show how often updates avoid new index entries.",
      "`pg_stat_statements`: the query's calls, mean time, and rows per call, which distinguish a bad plan from a bad query shape.",
      "`pg_indexes` and `pg_relation_size`: duplicate or overlapping indexes and the storage each one consumes.",
      "Write latency and WAL volume before and after adding an index, not only the read improvement.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Run EXPLAIN before adding another index. If the existing index is not in the plan, find out whether the predicate is sargable and whether the column is leading. If the plan is fine but writes are slow, count the indexes and check which ones are never scanned.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the plan with `EXPLAIN (ANALYZE, BUFFERS)` and compare estimated rows with actual rows.",
      "Rewrite the predicate to compare the bare column; if the application needs a case-insensitive match, create an expression index on the normalized value.",
      "For a composite index, put equality columns first and the range or sort column after them.",
      "Consider a partial index when the query always filters on a stable condition, such as `WHERE status = 'open'`.",
      "Use an `INCLUDE` covering index only when the heap fetch is the dominant cost and the extra storage is acceptable.",
      "Drop indexes with no scans or merge overlapping indexes, using `DROP INDEX CONCURRENTLY` to avoid a long write lock.",
      "Create new indexes with `CREATE INDEX CONCURRENTLY` and watch build time, disk, and replication lag.",
      "Re-measure read and write latency after the change; an index that helps one query can hurt every write.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Every index speeds some reads and slows every write. The right number is the smallest set that serves the important queries.",
      "A covering index avoids heap fetches but duplicates column data and increases storage and vacuum work.",
      "A partial index is small and fast but only serves queries whose predicates imply its condition.",
      "An expression index makes a function-wrapped predicate sargable, but the query must use the same expression and the index adds write cost.",
      "A composite index with the wrong leading column is usually worse than no index: it costs writes and is not used.",
      "Indexes reduce the need for sequential scans but cannot fix a query that returns most of the table; that is a data-model or pagination problem.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "function-predicate",
    question:
      "There is an index on `email`, but `WHERE lower(email) = $1` does a sequential scan. Why, and what would you change?",
    difficulty: 2,
    hints: [
      "Compare the value the query searches for with the value stored in the index.",
      "The fix can be in the query or in the index definition.",
    ],
    answer:
      "A B-tree on `email` is ordered by the stored value, and the query searches for the result of `lower(email)`. The two orderings do not match, so the planner cannot seek the index and falls back to a sequential scan. I would either compare the bare column, normalizing the input in the application, or create an expression index on `lower(email)` and make sure the query uses exactly that expression. I would confirm with EXPLAIN that the new index is chosen and measure write cost, because the expression index is maintained on every write.",
    followUps: [
      "Would a hash index help here?",
      "What if the column uses a case-insensitive collation?",
      "How do you test the expression index without locking the table?",
    ],
    redFlags: [
      "Adds another index on `email` and expects it to work.",
      "Says the planner is broken.",
      "Ignores write cost.",
    ],
    rubric: [
      "Explains the ordering mismatch.",
      "Proposes an expression index or a bare-column predicate.",
      "Verifies with EXPLAIN.",
      "Accounts for write cost.",
    ],
  },
  {
    id: "composite-order",
    question:
      "A query filters `tenant_id = $1 AND status = 'open' AND created_at > $2` and sorts by `created_at`. How would you order a composite index?",
    difficulty: 3,
    hints: [
      "Equality predicates narrow the index range most tightly.",
      "The range column can also support the sort.",
    ],
    answer:
      "I would put the equality columns first, in either order, and the range column last: `(tenant_id, status, created_at)`. That lets the index seek to the tenant and status, then scan the created-at range in order, which can also avoid a separate sort. The exact order of `tenant_id` and `status` matters less for this query but matters for other queries that filter only one of them. I would check the plan and the index's actual use before committing, and consider a partial index on `status = 'open'` if that is the dominant access path.",
    followUps: [
      "What changes if the query sorts descending?",
      "When would a partial index be better than the third column?",
      "How does this interact with a covering index?",
    ],
    redFlags: [
      "Puts the range column first.",
      "Orders columns alphabetically.",
      "Ignores the sort.",
    ],
    rubric: [
      "Puts equality columns before the range.",
      "Connects column order to the sort.",
      "Mentions partial or covering variants.",
      "Plans to verify with EXPLAIN.",
    ],
  },
  {
    id: "write-cost",
    question: "Adding one index doubled write latency. How do you decide whether to keep it?",
    difficulty: 3,
    hints: [
      "Measure the read benefit per query, not just the average.",
      "An index that is never scanned is pure cost.",
    ],
    answer:
      "I would measure the read improvement on the queries the index was meant to serve and the write cost across all writes, then compare them at the relevant percentiles. I would check `idx_scan` after a representative period and look for duplicate or overlapping indexes that could be merged. If the index serves a critical query but the write cost is unacceptable, I would consider a narrower or partial index, a covering index that replaces two others, or moving the read to a replica. The decision is workload-specific; there is no universal index budget.",
    followUps: [
      "What does `idx_scan` miss?",
      "How would a HOT update change the calculation?",
      "When would you drop an index that is used occasionally?",
    ],
    redFlags: [
      "Keeps every index because reads matter.",
      "Drops indexes without checking usage.",
      "Measures only average latency.",
    ],
    rubric: [
      "Quantifies read benefit and write cost.",
      "Checks index usage statistics.",
      "Considers partial, covering, or replica options.",
      "Uses percentiles.",
    ],
  },
  {
    id: "prove-index",
    question: "How do you prove an index is actually used, and what can mislead you?",
    difficulty: 2,
    hints: [
      "A plan can mention an index without reading it usefully.",
      "Statistics are cumulative and reset on restart in some setups.",
    ],
    answer:
      "I would use `EXPLAIN (ANALYZE, BUFFERS)` on the real query and check the actual plan, rows, loops, and buffers, not only the estimated cost. I would also check `pg_stat_user_indexes.idx_scan` over a representative window and `pg_stat_statements` for the query's calls and rows. A plan that names an index can still read a large fraction of it, and cumulative counters can be reset, inherited by a replica, or dominated by one query. I would verify with a controlled before-and-after measurement rather than trusting a single number.",
    followUps: [
      "What does an index-only scan require?",
      "Why can `idx_scan` be high while the index is not helping?",
      "How do you measure the write cost of one index?",
    ],
    redFlags: [
      "Trusts estimated cost alone.",
      "Reads only `idx_scan`.",
      "Ignores buffers and rows.",
    ],
    rubric: [
      "Uses EXPLAIN ANALYZE with buffers.",
      "Names usage statistics and their limits.",
      "Checks rows and loops.",
      "Measures before and after.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every important query has a plan review with actual rows and buffers.",
      "Indexes with zero scans are reviewed and removed when safe.",
      "Composite index column order matches the dominant equality and range predicates.",
      "Expression and partial indexes exist only for predicates that need them.",
      "Write latency and WAL volume are tracked alongside read latency.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Run EXPLAIN on the slow query before adding or dropping an index.",
      "Check whether the predicate is sargable and the leading column matches.",
      "Compare rows read with rows returned; a large ratio points at the scan or the join.",
      "Check whether a recent index addition correlates with the write regression.",
      "Measure the plan after any change; do not assume the planner switched.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the read gain and write cost of the change.",
      "Remove duplicate or unused indexes created during the response.",
      "Update the query or schema so the fix is durable, not just an index.",
      "Recheck statistics and plans after data growth changes selectivity.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Indexes",
    url: "https://www.postgresql.org/docs/current/indexes.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Index types, selectivity, cost tradeoffs, and when the planner chooses an index.",
  },
  {
    title: "PostgreSQL: Multicolumn Indexes",
    url: "https://www.postgresql.org/docs/current/indexes-multicolumn.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Leading-column behavior, equality and range predicates, and column ordering.",
  },
  {
    title: "Use The Index, Luke",
    url: "https://use-the-index-luke.com/",
    publisher: "Markus Winand",
    kind: "book" as const,
    note: "A vendor-independent guide to sargability, composite indexes, and write cost.",
  },
  {
    title: "PostgreSQL: Monitoring Statistics",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-ALL-INDEXES-VIEW",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "`pg_stat_all_indexes` scan counters and table modification counters.",
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
    indexing: {
      model: indexingModel,
      presets,
      instructions:
        "Start healthy, apply Function-wrapped predicate, then toggle the function and leading column. Raise index count at a high write rate to see the write trade.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Row counts, latencies, and thresholds are teaching values, not PostgreSQL benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-query-plans",
    "databases-vacuum-bloat",
    "databases-rds-aurora-arch",
    "databases-max-connections",
    "mongodb-index-design",
  ],
};
