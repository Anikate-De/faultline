import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NESTED_LOOP_LIMIT = 25_000;

const params = [
  {
    id: "rowCount",
    label: "Table rows",
    min: 100_000,
    max: 50_000_000,
    step: 100_000,
    value: 2_000_000,
    unit: " rows",
    group: "Data",
    help: "Rows in the table. The planner estimates how many it must visit from this and the predicate selectivity.",
    format: "count" as const,
  },
  {
    id: "selectivity",
    label: "Predicate selectivity",
    min: 0.01,
    max: 50,
    step: 0.01,
    value: 2,
    unit: "%",
    group: "Query",
    help: "Actual share of rows the predicate matches. High selectivity means many rows and usually a sequential scan.",
    format: "percent" as const,
  },
  {
    id: "statsAgeDays",
    label: "Statistics age",
    min: 0,
    max: 30,
    step: 1,
    value: 1,
    unit: " days",
    group: "Statistics",
    help: "How long since ANALYZE last sampled the table. Stale statistics make the row estimate drift from reality.",
    format: "number" as const,
  },
  {
    id: "statsTarget",
    label: "Statistics target",
    min: 1,
    max: 1_000,
    step: 10,
    value: 100,
    unit: "",
    group: "Statistics",
    help: "Sample size for this column. A higher target resists staleness and captures more values, at the cost of longer ANALYZE.",
    format: "count" as const,
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
    help: "1 models a predicate such as `WHERE upper(status) = ...`, which a plain index on the column cannot serve.",
    format: "count" as const,
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

type PlanKind = "seq" | "index" | "nested";

interface Computed {
  rowCount: number;
  selectivity: number;
  statsAgeDays: number;
  statsTarget: number;
  wrapped: boolean;
  actualRows: number;
  accuracy: number;
  estimatedRows: number;
  plan: PlanKind;
  readMs: number;
  rowsExamined: number;
  plannerHealth: Health;
}

function compute(p: Params): Computed {
  const rowCount = clamp(num(p, "rowCount", 2_000_000), 100_000, 50_000_000);
  const selectivity = clamp(num(p, "selectivity", 2), 0.01, 50);
  const statsAgeDays = clamp(num(p, "statsAgeDays", 1), 0, 30);
  const statsTarget = clamp(num(p, "statsTarget", 100), 1, 1_000);
  const wrapped = num(p, "wrapped", 0) >= 0.5;
  const actualRows = (rowCount * selectivity) / 100;
  const accuracy = clamp(1 - (statsAgeDays / 30) * (100 / statsTarget));
  const estimatedRows = Math.max(1, actualRows * (0.02 + 0.98 * accuracy));
  let plan: PlanKind;
  if (wrapped) plan = "seq";
  else if (estimatedRows < NESTED_LOOP_LIMIT) plan = "nested";
  else if (selectivity < 5) plan = "index";
  else plan = "seq";
  const readMs =
    plan === "nested" ? 0.4 + actualRows * 0.004 : plan === "index" ? 2 + actualRows * 0.001 : 4 + rowCount * 0.00009;
  const rowsExamined = plan === "seq" ? rowCount : actualRows;
  return {
    rowCount,
    selectivity,
    statsAgeDays,
    statsTarget,
    wrapped,
    actualRows,
    accuracy,
    estimatedRows,
    plan,
    readMs,
    rowsExamined,
    plannerHealth: status(readMs, 150, 600),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function planLabel(plan: PlanKind): string {
  return plan === "seq" ? "sequential scan" : plan === "index" ? "index scan" : "nested loop";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["read-p95", values.readMs, 0.5],
    ["rows-examined", values.rowsExamined, 0],
    ["estimated-rows", values.estimatedRows, 0],
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
        health: values.plannerHealth,
        utilization: clamp(values.readMs / 6_000),
        sublabel: `query p95 ${values.readMs.toFixed(0)} ms`,
        detail:
          "The application sees the result, not the plan. A plan can be fast on a small table and pathological after growth, even when the query text never changes.",
        meta: { readMs: Math.round(values.readMs) },
      },
      {
        id: "planner",
        label: "Planner",
        kind: "service",
        health: values.plannerHealth,
        utilization: clamp(values.estimatedRows / Math.max(1, values.actualRows)),
        sublabel: `${planLabel(values.plan)} · est ${formatCount(values.estimatedRows)}`,
        detail:
          "The planner compares paths using statistics and cost constants. It cannot see the future; when the estimate is wrong, a path that looks cheap becomes expensive at execution.",
        meta: { estimated: Math.round(values.estimatedRows), actual: Math.round(values.actualRows) },
      },
      {
        id: "index",
        label: "Index on filter column",
        kind: "storage",
        health: values.wrapped ? "warn" : "ok",
        utilization: values.plan === "nested" || values.plan === "index" ? 0.8 : 0.15,
        sublabel: values.wrapped ? "unusable for this predicate" : "available",
        detail:
          "The index exists, but existence is not use. A function on the column or a leading-column mismatch makes it unusable; a bad estimate can make the planner reject a usable index.",
        meta: { used: values.plan === "nested" || values.plan === "index" ? 1 : 0 },
      },
      {
        id: "table",
        label: "orders table",
        kind: "db",
        role: "primary",
        health: values.plannerHealth,
        utilization: clamp(values.rowsExamined / Math.max(1, values.rowCount)),
        sublabel: `${formatCount(values.rowsExamined)} rows examined`,
        detail:
          "Execution reads rows, not estimates. A nested loop over one million outer rows performs one million inner lookups, which is where the time goes.",
        meta: { examined: Math.round(values.rowsExamined) },
      },
    ],
    edges: [
      edge("app-planner", "app", "planner", 0.8, values.plannerHealth, "query"),
      edge(
        "planner-index",
        "planner",
        "index",
        values.plan === "seq" ? 0.1 : 0.8,
        values.plan === "seq" ? "warn" : "ok",
        "candidate path",
      ),
      edge(
        "planner-table",
        "planner",
        "table",
        values.plan === "seq" ? 0.95 : 0.3,
        values.plannerHealth,
        values.plan === "seq" ? "sequential scan" : "join path",
      ),
      edge(
        "index-table",
        "index",
        "table",
        values.plan === "nested" || values.plan === "index" ? 0.8 : 0.05,
        values.plannerHealth,
        "row lookup",
      ),
    ],
    metrics: [
      metric("read-p95", "Query p95", values.readMs, " ms", 150, 600, "ms"),
      metric("rows-examined", "Rows examined", values.rowsExamined, " rows", 50_000, 500_000, "count"),
      metric("estimated-rows", "Planner estimate", values.estimatedRows, " rows", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${planLabel(values.plan)}; estimate ${formatCount(values.estimatedRows)} vs actual ${formatCount(
      values.actualRows,
    )}; p95 ${values.readMs.toFixed(0)} ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-latency",
    metricId: "read-p95",
    warn: 150,
    crit: 600,
    title: "Plan choice is driving query latency",
    cause:
      "The planner chose a path based on estimated rows. When the estimate is too low, a nested loop performs far more inner lookups than the cost model expected, and latency grows with the actual row count.",
    fix:
      "Read EXPLAIN ANALYZE, refresh statistics with ANALYZE, raise the statistics target for the filtered column, and rewrite function-wrapped predicates. Do not disable planner methods as a permanent fix.",
    checkFirst: [
      "Compare estimated rows with actual rows at every plan node, not just the top.",
      "Check `last_analyze` and `last_autoanalyze` for the table.",
      "Check whether the predicate wraps the column and therefore cannot use the index.",
    ],
  },
  {
    id: "rows-examined",
    metricId: "rows-examined",
    warn: 50_000,
    crit: 500_000,
    title: "The plan reads far more rows than it returns",
    cause:
      "A nested loop or a sequential scan visits rows the query does not return. The plan is spending I/O on filtering or repeated probes rather than narrowing the result early.",
    fix:
      "Make the predicate sargable, add the right index, or help the planner with current statistics. For a broad predicate, a sequential scan or hash join may genuinely be cheaper.",
    checkFirst: [
      "Compare rows examined with rows returned in EXPLAIN ANALYZE.",
      "Look at loop counts on the inner side of a nested loop.",
      "Check whether a join order or a missing join predicate causes the extra rows.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const queryPlanModel: SimModel = {
  id: "databases-query-plans",
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
    if (values.accuracy < 0.5 && frame.flags.staleStatsLogged !== 1) {
      pushEvent(next, {
        id: "stale-statistics",
        severity: values.readMs >= 600 ? "crit" : "warn",
        title: "Statistics no longer describe the data",
        detail: `Statistics are ${values.statsAgeDays} days old with target ${values.statsTarget}. The planner estimates ${formatCount(
          values.estimatedRows,
        )} rows but execution sees ${formatCount(values.actualRows)}.`,
        nodeId: "planner",
        metricId: "rows-examined",
      });
    }
    if (values.plan === "nested" && values.actualRows >= 500_000 && frame.flags.nestedLoopLogged !== 1) {
      pushEvent(next, {
        id: "nested-loop",
        severity: "crit",
        title: "Nested loop probes the inner side too many times",
        detail: `The planner estimated ${formatCount(
          values.estimatedRows,
        )} outer rows, below the ${formatCount(NESTED_LOOP_LIMIT)} threshold for a nested loop, but execution produced ${formatCount(
          values.actualRows,
        )}.`,
        nodeId: "table",
        metricId: "query-latency",
      });
    }
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.staleStatsLogged = values.accuracy < 0.5 ? 1 : 0;
    next.flags.nestedLoopLogged =
      values.plan === "nested" && values.actualRows >= 500_000 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${planLabel(values.plan)}; estimate ${formatCount(
      values.estimatedRows,
    )} vs actual ${formatCount(values.actualRows)}; p95 ${values.readMs.toFixed(0)} ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The planner estimated ${formatCount(values.estimatedRows)} rows and execution examined ${formatCount(
        values.actualRows,
      )}. The gap comes from statistics that are ${values.statsAgeDays} days old with target ${values.statsTarget}.`,
      `The chosen path is a ${planLabel(values.plan)}. A nested loop is not wrong in general; it is wrong when its outer row count is underestimated by orders of magnitude.`,
      values.wrapped
        ? "The predicate wraps the column in a function, so no plain index on that column can be used. Fix the predicate or index the expression."
        : "The predicate is sargable, so the planner's choice is a cost decision, not a hard limitation.",
      "Raising the statistics target helps only if ANALYZE actually runs; a better sample of stale data is still stale.",
      "A plan is a prediction. Read actual rows and loop counts before changing indexes or planner settings.",
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
    description: "Fresh statistics estimate the predicate accurately and the planner chooses an index scan.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Growing table",
    description: "Ten million rows at two percent selectivity and five-day-old statistics. The plan warns but does not collapse.",
    tone: "warn",
    params: defaults({ rowCount: 10_000_000, statsAgeDays: 5 }),
  },
  {
    id: "failure",
    label: "Stale statistics",
    description: "Twenty-one-day-old statistics on a twenty-million-row table estimate 20,000 rows for a predicate that matches one million. The planner picks a nested loop.",
    tone: "crit",
    params: defaults({ rowCount: 20_000_000, selectivity: 5, statsAgeDays: 21, statsTarget: 20 }),
  },
  {
    id: "wrapped",
    label: "Function-wrapped predicate",
    description: "The index cannot serve a predicate wrapped in a function, so the plan scans a smaller table sequentially.",
    tone: "warn",
    params: defaults({ rowCount: 300_000, selectivity: 5, wrapped: 1 }),
  },
  {
    id: "recovery",
    label: "Fresh and selective",
    description: "Fresh statistics on a selective predicate restore the index path and return rows examined below the warning line.",
    tone: "ok",
    params: defaults({ selectivity: 0.5, statsAgeDays: 0, statsTarget: 200 }),
  },
];

const experiment: Experiment = {
  id: "predict-planner-mistake",
  title: "Predict why the planner chose a nested loop",
  simId: "query-plans",
  question:
    "A twenty-million-row table has fresh-looking statistics from 21 days ago. A predicate matches five percent of rows, but the planner estimates 20,000 and chooses a nested loop. What happens at execution?",
  prediction: {
    options: [
      { id: "nested", label: "It probes the inner side about one million times and latency explodes." },
      { id: "seq", label: "It silently switches to a sequential scan before executing." },
      { id: "index", label: "It uses an index-only scan and stays fast because the index exists." },
      { id: "cpu", label: "The plan is fine; the latency comes only from database CPU saturation." },
    ],
    correctOptionId: "nested",
    explanation:
      "The estimate is below the point where a nested loop looks cheap, so the planner chooses it. At execution the outer side produces about one million rows, and the inner side is probed once per row. The plan is a prediction made from statistics; it does not re-plan after the first row arrives.",
  },
  setup: defaults({ rowCount: 20_000_000, selectivity: 5, statsAgeDays: 21, statsTarget: 20 }),
  runFor: 20,
  observe: [
    "The planner estimates 20,000 rows; execution examines about one million.",
    "The chosen plan is a nested loop, and query p95 is about 4,000 ms.",
    "Rows examined crosses the 500,000 critical line.",
    "The table and planner nodes are both failing.",
    "A sequential scan of the same table would read 20 million rows but avoid one million inner probes.",
  ],
  explain:
    "The cost model compares a nested loop using estimated outer rows with a scan over the table. Twenty thousand estimated rows makes the loop look cheap; one million actual rows makes it catastrophic. The estimate is wrong because the statistics are old and the sample is small. A planner does not get feedback from the executor and switch paths mid-query.",
  fix: defaults({ rowCount: 20_000_000, selectivity: 0.2, statsAgeDays: 0, statsTarget: 200 }),
  debrief:
    "Refreshing statistics moves the estimate to the truth, but a predicate matching one million rows still deserves a scan or a hash join. Narrowing the predicate to 0.2 percent makes the index path both possible and cheap: about 42 ms. The durable fix is current statistics, a query that returns fewer rows, and a review of the plan after data growth changes the estimate.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A query plan is the executor's route through the data. The planner generates candidate paths, estimates how many rows each will produce, and assigns a cost. It then chooses the cheapest path. EXPLAIN shows that choice; EXPLAIN ANALYZE runs the query and shows estimated rows next to actual rows and loop counts.",
  },
  {
    type: "p",
    text: "Statistics are the planner's model of the data. ANALYZE samples a table and records value distributions, null fractions, and correlation. Selectivity is the share of rows a predicate is expected to match. With current statistics, the estimate should be close to reality. With stale statistics, the model describes data that no longer exists.",
  },
  {
    type: "p",
    text: "A nested loop is a reasonable plan when the outer side is small: for each outer row, probe the inner side through an index. It becomes pathological when the outer side is millions of rows and the planner thought it was thousands. A sequential scan is also reasonable when the predicate matches a large share of the table. The failure is not the node type; it is the mismatch between the estimate and the execution.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The planner sits after parsing and rewriting, before the executor. It reads table and column statistics, evaluates predicates, considers join orders and access paths, and hands the chosen plan to the executor. Statistics are refreshed by autovacuum's analyze step or by an explicit ANALYZE. The executor reads the plan; it does not ask the planner to reconsider after the first batch.",
  },
  {
    type: "table",
    headers: ["Plan field", "What to compare", "Why it matters"],
    rows: [
      ["`rows` estimate", "Against actual rows at the same node", "A large gap explains a wrong path choice"],
      ["`actual rows`", "Per loop versus total", "A nested loop's inner side is multiplied by loops"],
      ["`loops`", "Outer rows for the inner node", "One million loops means one million probes"],
      ["`Buffers`", "Shared hits versus reads", "Shows whether the cost is cache misses, not row count"],
      ["`Planning Time`", "Against execution time", "Separates planning cost from execution cost"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Wrong because of statistics",
    rightTitle: "Wrong because of the predicate",
    rows: [
      { label: "Index exists", left: "Yes, and could be used", right: "Yes, but cannot serve the predicate" },
      { label: "Estimate", left: "Far below actual rows", right: "May be accurate; the path is still a scan" },
      { label: "Fix", left: "ANALYZE, raise statistics target", right: "Rewrite the predicate or index the expression" },
      { label: "Signal", left: "Estimate and actual rows diverge", right: "Estimate is close, plan has no index path" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The chosen plan and its p95, so you can see the consequence before reading the numbers.",
      "Planner estimate versus actual rows, the core diagnostic.",
      "Rows examined, which separates a broad scan from a repeated inner probe.",
      "Statistics age and target, the inputs that decide how much to trust the estimate.",
      "A function-wrapped toggle, so a hard limitation is not mistaken for a statistics problem.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy: the estimate and actual rows agree and the plan is an index scan. Apply Stale statistics: the estimate falls to 20,000 while execution sees one million, and the planner switches to a nested loop. Then apply Fresh and selective to see the difference between refreshing statistics and narrowing the query. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Row counts, costs, and thresholds are illustrative teaching values. Real planner choices depend on PostgreSQL version, cost settings, correlation, and the actual data distribution.",
  },
  { type: "sim", simId: "query-plans" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The table had twenty million rows and the predicate matched five percent, or one million rows. Stale statistics with a low target estimated 20,000. That estimate made a nested loop look cheap, so the planner chose it. At execution the outer side produced one million rows and the inner side was probed once per row. Query p95 reached about 4,000 ms.",
  },
  {
    type: "p",
    text: "The plan was not irrational given the estimate. That is the important distinction. The planner did not know the data had changed, and it does not switch paths after seeing the first million rows. Reading estimated versus actual rows turns a mysterious slow query into a specific modeling error.",
  },
  {
    type: "p",
    text: "Refreshing statistics alone changed the estimate to one million, which is honest. With that many matching rows, a sequential scan or hash join is a defensible choice, and latency was still high. Narrowing the predicate to half a percent made the index path cheap and returned the query to about 102 ms. The fix depends on which problem you actually have.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`EXPLAIN (ANALYZE, BUFFERS)` with estimated and actual rows at every node, plus loop counts.",
      "`pg_stat_user_tables.last_analyze` and `last_autoanalyze`, and `pg_class.reltuples`, for staleness.",
      "`pg_stats` for the filtered column: `n_distinct`, `most_common_vals`, and histogram bounds.",
      "`pg_stat_statements` for calls, mean time, and rows per call, to find the query and its scale.",
      "`pg_stat_progress_analyze` while a manual ANALYZE is running on a large table.",
      "`auto_explain` for plans from queries that are too fast to catch interactively.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare estimated rows with actual rows at the node that takes the time. If they diverge, check statistics age and target before touching the query. If they agree, the plan is choosing a genuinely expensive path for a broad predicate, and the fix is the query shape or the data model.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Run EXPLAIN ANALYZE on the real query with real parameters; cached plans and literal values can differ.",
      "Find the node whose actual rows differ most from its estimate and compare its loop count.",
      "Run ANALYZE on the table, then recheck the plan before making other changes.",
      "Raise the statistics target for columns used in selective predicates: `ALTER TABLE ... ALTER COLUMN ... SET STATISTICS`.",
      "Create extended statistics for correlated columns when single-column statistics mislead the estimate.",
      "Rewrite function-wrapped predicates, or create an expression index that matches the expression exactly.",
      "Avoid disabling nested loops or seq scans globally; use them only as a diagnostic to confirm the path.",
      "Add or adjust the index only after the estimate is trustworthy; otherwise you are tuning against a bad model.",
      "Recheck plans after large data changes, bulk loads, or schema changes that alter distribution.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher statistics target improves estimates but makes ANALYZE slower and uses more catalog space.",
      "Frequent ANALYZE keeps estimates current but competes with query I/O; autovacuum's schedule is a compromise.",
      "A sequential scan is not a failure. For a predicate matching a large share of rows, it is often the fastest path.",
      "Forcing a plan with planner settings can unblock an incident but will break a different query later.",
      "Extended statistics help correlated columns but add planning and maintenance overhead.",
      "Prepared statements can reuse a generic plan that is wrong for a specific parameter value; forcing a custom plan has its own cost.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "index-ignored",
    question:
      "An index exists but the planner chooses a sequential scan. How do you decide whether this is a statistics problem or an unusable index?",
    difficulty: 3,
    hints: [
      "Compare estimated and actual rows.",
      "Check whether the predicate can use the index at all.",
    ],
    answer:
      "I would run EXPLAIN ANALYZE and look at two things. First, can the index serve the predicate: is the column bare and is it the leading column of the index? If not, no statistics change will help. Second, if the index is usable, compare estimated rows with actual rows. A large underestimate or overestimate points at stale or insufficient statistics, and I would check `last_analyze`, `pg_stats`, and the statistics target. I would also check whether the predicate is genuinely broad: for a large share of the table, a sequential scan is the correct plan, not a bug.",
    followUps: [
      "What would you do if the estimate is accurate but the plan is still slow?",
      "How do extended statistics change this?",
      "Why can a plan be fast for a literal but slow for a bind parameter?",
    ],
    redFlags: [
      "Adds another index without reading the plan.",
      "Disables sequential scans globally.",
      "Assumes the planner is broken.",
    ],
    rubric: [
      "Checks sargability and leading column.",
      "Compares estimated with actual rows.",
      "Checks statistics age and target.",
      "Accepts a sequential scan for broad predicates.",
    ],
  },
  {
    id: "estimate-gap",
    question:
      "EXPLAIN ANALYZE shows an estimated one row and an actual 500,000 at the same node. What happened, and what do you do next?",
    difficulty: 3,
    hints: [
      "The estimate comes from statistics, not from the executor.",
      "Look at the node's loops and its parent.",
    ],
    answer:
      "The planner's model of that node is wrong by orders of magnitude. I would check whether the statistics are stale, whether the column has a skewed distribution that a small sample missed, and whether a function or cast prevents the planner from using the column's histogram. I would run ANALYZE, raise the statistics target, and add extended statistics if the predicate involves correlated columns. Then I would re-read the plan, because the parent's choice, such as a nested loop, may change once the estimate is accurate. I would not force a join method before fixing the estimate.",
    followUps: [
      "How does a most-common-values list fail on a skewed column?",
      "What does a row estimate of one usually indicate?",
      "When would you use `CREATE STATISTICS`?",
    ],
    redFlags: [
      "Trusts the estimate over the actual count.",
      "Changes the query before checking statistics.",
      "Forces a hash join as a permanent fix.",
    ],
    rubric: [
      "Identifies the estimate as the problem.",
      "Checks staleness, skew, and statistics target.",
      "Mentions extended statistics.",
      "Rechecks the parent plan after fixing the estimate.",
    ],
  },
  {
    id: "nested-loop",
    question: "Why would PostgreSQL choose a nested loop that ends up probing the inner side a million times?",
    difficulty: 3,
    hints: [
      "The choice is made before execution.",
      "The cost model uses estimated outer rows.",
    ],
    answer:
      "The planner chooses a nested loop when the estimated outer row count is small enough that repeated index probes look cheaper than a scan or hash join. If the outer estimate is 20,000 but execution produces one million rows, the loop executes fifty times more probes than planned. The planner does not receive feedback and switch methods mid-query. The fix is to correct the estimate or the predicate, not to assume the nested loop is inherently bad. For a genuinely large outer side, a hash join or a sequential scan may be the right plan.",
    followUps: [
      "What plan would you expect for a large outer side with an indexed inner side?",
      "How can you see the loop count in EXPLAIN?",
      "When is a nested loop still correct despite a large outer side?",
    ],
    redFlags: [
      "Says nested loops are always bad.",
      "Blames the executor.",
      "Ignores the estimate.",
    ],
    rubric: [
      "Connects the choice to estimated outer rows.",
      "Explains the lack of mid-query re-planning.",
      "Names the actual row amplification.",
      "Proposes statistics or query changes.",
    ],
  },
  {
    id: "prepared-plan",
    question:
      "A query is fast in psql with literal values but slow from the application. What plan-related causes would you investigate?",
    difficulty: 4,
    hints: [
      "Prepared statements can use a generic plan.",
      "The application may send different parameter values.",
    ],
    answer:
      "I would check whether the application uses prepared statements and whether PostgreSQL is using a generic plan that ignores the specific parameter values. A generic plan can be reasonable on average but wrong for a skewed value. I would compare EXPLAIN with the actual parameters, inspect `pg_stat_statements` for the application's calls, and check whether the driver sends parameters as text or unknown types, which can change casts and index usability. I would also verify that the application and psql see the same search path, statistics, and schema. Forcing a custom plan is a diagnostic; the durable fix is usually statistics, a query rewrite, or a plan that is robust across values.",
    followUps: [
      "What is the difference between a custom and a generic plan?",
      "How do parameterized `LIKE` patterns change the plan?",
      "When would you set `plan_cache_mode`?",
    ],
    redFlags: [
      "Assumes the application is lying about the query.",
      "Forces a custom plan permanently without measuring.",
      "Ignores parameter skew.",
    ],
    rubric: [
      "Mentions generic versus custom plans.",
      "Checks actual parameters and driver types.",
      "Uses EXPLAIN and pg_stat_statements.",
      "Distinguishes diagnosis from durable fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Slow-query review includes EXPLAIN ANALYZE with estimated and actual rows, not only duration.",
      "Autovacuum analyze is enabled and monitored for large or rapidly changing tables.",
      "Statistics targets are raised for columns used in selective predicates.",
      "Extended statistics exist for known correlated column pairs.",
      "Plans are rechecked after bulk loads, schema changes, and large data growth.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Capture the plan with the real parameters before changing anything.",
      "Find the node with the largest estimate-to-actual gap and check its loop count.",
      "Refresh statistics and recheck the plan before forcing a join method.",
      "Check whether the predicate is sargable and whether the index column is leading.",
      "Record the old and new plans so the change can be reviewed.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replace any temporary planner override with a durable query or statistics fix.",
      "Add plan regression checks for the queries that matter.",
      "Review statistics maintenance for tables that change distribution quickly.",
      "Document the parameter values and data shape that triggered the bad plan.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Using EXPLAIN",
    url: "https://www.postgresql.org/docs/current/using-explain.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Plan nodes, estimated and actual rows, loop counts, and how to read EXPLAIN ANALYZE.",
  },
  {
    title: "PostgreSQL: ANALYZE",
    url: "https://www.postgresql.org/docs/current/sql-analyze.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Statistics collection, sampling, and the per-column statistics target.",
  },
  {
    title: "PostgreSQL: Planner/Optimizer",
    url: "https://www.postgresql.org/docs/current/planner-optimizer.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "How the planner generates paths, estimates costs, and chooses a plan.",
  },
  {
    title: "PostgreSQL: Query Planning Configuration",
    url: "https://www.postgresql.org/docs/current/runtime-config-query.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Cost constants, `enable_*` planner methods, and why disabling them is diagnostic only.",
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
    "query-plans": {
      model: queryPlanModel,
      presets,
      instructions:
        "Start healthy, apply Stale statistics, then compare the estimate with the actual rows. Refresh statistics by lowering the age, then narrow the predicate to see why the fix depends on both.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Costs, row counts, and thresholds are teaching values, not planner guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-indexing",
    "databases-vacuum-bloat",
    "databases-n-plus-one",
    "databases-rds-aurora-arch",
    "databases-long-transactions",
  ],
};
