import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_P99_MS = 900;

const params: ParamSpec[] = [
  {
    id: "collectionDocs",
    label: "Collection size",
    min: 1,
    max: 50,
    step: 1,
    value: 10,
    unit: "M docs",
    group: "Data",
    help: "Documents in the collection. Scan cost grows with collection size when the plan cannot narrow the search.",
    format: "number",
  },
  {
    id: "selectivity",
    label: "Predicate selectivity",
    min: 0.5,
    max: 20,
    step: 0.5,
    value: 2,
    unit: "%",
    group: "Query",
    help: "Share of documents that match all equality predicates. A more selective predicate makes a usable index worth more.",
    format: "percent",
  },
  {
    id: "equalityPrefix",
    label: "Equality keys in index prefix",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Index",
    help: "How many of the query's equality fields are leading keys in the index. Zero means the index starts with a field the query does not constrain, so it cannot narrow the scan.",
    format: "count",
  },
  {
    id: "sortAligned",
    label: "Sort direction aligned",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Index",
    help: "1 means the index order matches the requested sort. A mismatch still allows filtering but forces a blocking in-memory sort of the matched documents.",
    format: "count",
  },
  {
    id: "queryRate",
    label: "Query rate",
    min: 50,
    max: 2_000,
    step: 50,
    value: 300,
    unit: " ops/s",
    group: "Traffic",
    help: "Queries per second arriving at the collection. A plan that examines many documents costs more as the rate rises.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  docs: number;
  matched: number;
  examined: number;
  scanRatio: number;
  p99: number;
  plan: "COLLSCAN" | "IXSCAN" | "IXSCAN + SORT";
  queryRate: number;
  prefix: number;
  health: Health;
}

function compute(p: Params): Computed {
  const docs = clamp(num(p, "collectionDocs", 10), 1, 50) * 1_000_000;
  const selectivity = clamp(num(p, "selectivity", 2), 0.5, 20) / 100;
  const prefix = Math.round(clamp(num(p, "equalityPrefix", 2), 0, 2));
  const aligned = num(p, "sortAligned", 1) >= 0.5;
  const queryRate = clamp(num(p, "queryRate", 300), 50, 2_000);
  const matched = docs * selectivity;
  const examined = prefix === 0 ? docs : prefix === 1 ? docs * 0.1 : matched;
  const scanRatio = examined / Math.max(1, matched);
  const sortPenalty = aligned ? 0 : Math.min(80, matched / 2_500);
  const p99 = Math.min(MAX_P99_MS, (2 + examined / 8_000 + sortPenalty) * (1 + queryRate / 4_000));
  const plan = prefix === 0 ? "COLLSCAN" : aligned ? "IXSCAN" : "IXSCAN + SORT";
  const health: Health = p99 >= 200 || scanRatio >= 50 ? "crit" : p99 >= 50 || scanRatio >= 10 ? "warn" : "ok";
  return { docs, matched, examined, scanRatio, p99, plan, queryRate, prefix, health };
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const plannerHealth: Health = values.health === "crit" ? "crit" : values.health === "warn" ? "warn" : "ok";
  const planDetail =
    values.plan === "COLLSCAN"
      ? "The index cannot narrow this query, so the server reads every document in the collection."
      : values.plan === "IXSCAN + SORT"
        ? "The index narrows the matches, but the requested sort order differs from the index order, so the server sorts in memory."
        : "The index provides both the filter and the requested order, so the server reads only matching keys and avoids a blocking sort.";
  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application",
      kind: "client",
      health: values.health,
      sublabel: `${Math.round(values.queryRate).toLocaleString()} queries/s`,
      detail: "The application sends the query shape. The driver does not choose an index; the server's query planner does.",
      meta: { view: "flow" },
    },
    {
      id: "planner",
      label: "Query planner",
      kind: "service",
      health: plannerHealth,
      utilization: clamp(values.p99 / 200),
      throughput: values.queryRate,
      sublabel: `${values.plan} · p99 ${values.p99.toFixed(0)}ms`,
      detail: "The planner scores candidate plans from the query shape and the available indexes. `explain` reports the winning plan and the work it did.",
      meta: { view: "flow" },
    },
    {
      id: "index",
      label: "Compound index",
      kind: "storage",
      health: values.plan === "COLLSCAN" ? "warn" : "ok",
      utilization: values.plan === "COLLSCAN" ? 0 : clamp(values.examined / 2_000_000),
      sublabel: values.plan === "COLLSCAN" ? "not used · prefix mismatch" : `${values.examined.toLocaleString()} keys examined`,
      detail: "A compound index is ordered. A query can use a leading prefix of its keys; a field that appears later in the index cannot narrow the scan unless the preceding keys are constrained.",
      meta: { view: "flow" },
    },
    {
      id: "collection",
      label: "Collection",
      kind: "db",
      health: values.plan === "COLLSCAN" ? "crit" : "ok",
      utilization: values.plan === "COLLSCAN" ? 1 : clamp(values.matched / 1_000_000),
      throughput: values.queryRate,
      sublabel: `${values.examined.toLocaleString()} docs examined`,
      detail: planDetail,
      meta: { view: "flow" },
    },
    {
      id: "result",
      label: "Result set",
      kind: "client",
      health: "ok",
      sublabel: `${Math.round(values.matched).toLocaleString()} docs returned`,
      detail: "The number of documents returned is often much smaller than the number examined. That gap is the signal to inspect the plan.",
      meta: { view: "flow" },
    },
  ];
  const edges =
    values.plan === "COLLSCAN"
      ? [
          { id: "app-planner", from: "app", to: "planner", rate: 0.8, health: "ok" as Health },
          { id: "planner-collection", from: "planner", to: "collection", rate: 0.8, health: "crit" as Health },
          { id: "collection-result", from: "collection", to: "result", rate: 0.8, health: "ok" as Health },
        ]
      : [
          { id: "app-planner", from: "app", to: "planner", rate: 0.8, health: "ok" as Health },
          { id: "planner-index", from: "planner", to: "index", rate: 0.8, health: values.health },
          { id: "index-collection", from: "index", to: "collection", rate: 0.8, health: "ok" as Health },
          { id: "collection-result", from: "collection", to: "result", rate: 0.8, health: "ok" as Health },
        ];
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("query-p99", "Query p99", values.p99, "ms", 50, 200, "ms"),
      metric("docs-examined", "Documents examined", values.examined, "", 500_000, 2_000_000, "count"),
      metric("scan-ratio", "Examined-to-returned ratio", values.scanRatio, "x", 10, 50, "number"),
      metric("query-rate", "Query rate", values.queryRate, " ops/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, plan: values.plan, prefix: values.prefix },
    summary: `${values.plan} · ${values.examined.toLocaleString()} docs examined · ${Math.round(values.matched).toLocaleString()} returned · p99 ${values.p99.toFixed(0)}ms`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (index: number) => 1 + 0.03 * Math.sin((index + (seed % 5)) / 2.2);
  for (const [id, value] of [
    ["query-p99", values.p99],
    ["docs-examined", values.examined],
    ["scan-ratio", values.scanRatio],
    ["query-rate", values.queryRate],
  ] as const) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "query-p99",
    metricId: "query-p99",
    warn: 50,
    crit: 200,
    title: "The query plan is doing too much work",
    cause:
      "A plan that examines many documents, or sorts them in memory, spends time on documents the query will discard. The tail grows with collection size and query rate even when the result set is small.",
    fix:
      "Read `explain('executionStats')` and compare `totalDocsExamined` with `nReturned`. Build a compound index whose leading keys match the equality predicates, then the sort, then the range. Remove indexes that the planner rejects for this shape.",
    checkFirst: [
      "Check the winning plan stage: COLLSCAN, IXSCAN, SORT, or a combination.",
      "Compare `totalKeysExamined` and `totalDocsExamined` with `nReturned`.",
      "Check whether the index prefix contains the query's leading predicate.",
    ],
  },
  {
    id: "docs-examined",
    metricId: "docs-examined",
    warn: 500_000,
    crit: 2_000_000,
    title: "The server is reading far more documents than it returns",
    cause:
      "A collection scan reads every document, and an index that only partially matches still fetches more documents than the query needs. At millions of documents per query, the cost is paid on every request.",
    fix:
      "Add or reorder a compound index so the equality fields are leading keys. Confirm that the predicate is sargable: a range, `$regex`, or function on the indexed field narrows what the index can do.",
    checkFirst: [
      "Check collection size and the number of matching documents.",
      "Check whether the query filters on a leading index key or only on a later one.",
      "Check whether a covered query could avoid fetching documents entirely.",
    ],
  },
  {
    id: "scan-ratio",
    metricId: "scan-ratio",
    warn: 10,
    crit: 50,
    title: "The index is not selective for this query shape",
    cause:
      "An examined-to-returned ratio above one means the server reads extra keys or documents and discards them. A ratio in the tens or hundreds usually means the predicate is not using the index prefix, or the index field order puts a low-selectivity key first.",
    fix:
      "Put the equality fields first, then the sort key, then the range key. Measure selectivity before adding another index; a low-cardinality leading field still leaves many documents to inspect.",
    checkFirst: [
      "Check the ratio per query shape, not only the collection average.",
      "Check whether the leading index key is present in the predicate.",
      "Check whether the sort order matches the index direction.",
    ],
  },
];

export const indexDesignModel: SimModel = {
  id: "mongodb-index-design",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.5, 0.5);
    next.metrics = next.metrics.map((item) =>
      item.id === "query-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.plan === "COLLSCAN" && !Number(next.flags.collscanAnnounced ?? 0)) {
      pushEvent(next, {
        id: "prefix-mismatch-collscan",
        at: frame.t,
        severity: values.health === "crit" ? "crit" : "warn",
        title: "Index prefix mismatch forces a collection scan",
        detail: `The index does not lead with a constrained field, so the server examined ${values.examined.toLocaleString()} documents to return ${Math.round(values.matched).toLocaleString()}.`,
        nodeId: "collection",
        metricId: "docs-examined",
      });
      next.flags.collscanAnnounced = 1;
    }
    if (values.plan !== "COLLSCAN" && Number(frame.flags.plan === "COLLSCAN" ? 1 : 0) === 1 && !Number(next.flags.recoveredAnnounced ?? 0)) {
      pushEvent(next, {
        id: "index-plan-recovered",
        at: frame.t,
        severity: "info",
        title: "The query uses an index again",
        detail: `The plan is ${values.plan}. Confirm that examined documents fell and that the sort is no longer blocking.`,
      });
      next.flags.recoveredAnnounced = 1;
    }
    if (values.plan !== "COLLSCAN") next.flags.collscanAnnounced = 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The plan is ${values.plan}. It examines ${values.examined.toLocaleString()} documents to return ${Math.round(values.matched).toLocaleString()}, a ratio of ${values.scanRatio.toFixed(1)}.`,
      values.plan === "COLLSCAN"
        ? "A compound index is ordered. If the query constrains a key that is not a leading prefix, the planner cannot use that key to narrow the scan even though the field appears in the index definition."
        : "The index prefix narrows the scan. If the sort direction still differs, the server can filter with the index but must sort the matches in memory.",
      `A single-field sort can often be served by scanning an index in reverse. A compound sort needs every sort key to reverse together, which is why direction and field order are part of the design.`,
      "Illustrative model. Collection size, selectivity, and latency are teaching values; use `explain('executionStats')` on the real query to see the actual keys and documents examined.",
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
    description: "A matching compound index serves the filter and the sort.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A partial prefix and a higher query rate make the plan expensive.",
    tone: "warn",
    params: defaults({ collectionDocs: 8, equalityPrefix: 1, queryRate: 800 }),
  },
  {
    id: "failure",
    label: "Prefix mismatch",
    description: "The index starts with an unconstrained field, so every query scans the collection.",
    tone: "crit",
    params: defaults({ collectionDocs: 20, equalityPrefix: 0, queryRate: 600 }),
  },
  {
    id: "sort-miss",
    label: "Sort mismatch",
    description: "The index filters correctly but the requested order forces an in-memory sort.",
    tone: "warn",
    params: defaults({ collectionDocs: 10, selectivity: 5, sortAligned: 0, queryRate: 600 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The index leads with the equality keys and matches the sort direction.",
    tone: "ok",
    params: defaults({ collectionDocs: 10, equalityPrefix: 2, sortAligned: 1, queryRate: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-prefix",
  title: "Predict why the index is ignored",
  simId: "index-design",
  question:
    "A collection has an index on `{ createdAt: 1, status: 1 }`. A report filters only on `status` and has no sort. Why does the plan scan the collection?",
  prediction: {
    options: [
      { id: "cardinality", label: "`status` has too few distinct values, so MongoDB refuses to use any index" },
      { id: "prefix", label: "`status` is not a leading key, so the index cannot narrow the scan" },
      { id: "direction", label: "The sort direction is wrong, so the index cannot filter" },
      { id: "size", label: "The collection is too large for an index to help" },
    ],
    correctOptionId: "prefix",
    explanation:
      "A compound index is searched by a leading prefix. With `createdAt` first, the index is ordered by a field the report does not constrain; `status` appears later and cannot narrow the scan by itself. Reordering to `{ status: 1, createdAt: 1 }` gives the planner an equality prefix, and it also supports a sort by `createdAt` if the report adds one.",
  },
  setup: defaults({ collectionDocs: 20, equalityPrefix: 0, queryRate: 600 }),
  runFor: 8,
  observe: [
    "The plan is COLLSCAN and documents examined equals the collection size.",
    "The examined-to-returned ratio is far above one.",
    "p99 is well above the budget even though the result set is small.",
    "After the prefix is corrected, the plan uses the index and the ratio falls toward one.",
  ],
  explain:
    "The planner can only use an index efficiently when the query constrains a leading prefix of its keys. A field that appears anywhere in the index definition is not enough. Field order is part of the contract: equality fields first, then the sort, then the range. That order lets one index narrow the scan and return results in the requested order. If the sort direction is also wrong, the server can still filter with the index but must sort the matches in memory.",
  fix: defaults({ collectionDocs: 10, equalityPrefix: 2, sortAligned: 1, queryRate: 300 }),
  debrief:
    "Open `explain('executionStats')` and read the winning plan, not just the list of indexes. Compare keys examined, documents examined, and documents returned. A ratio near one with an IXSCAN is healthy; a COLLSCAN with a large collection is the failure. Reordering the index is cheap compared with scanning on every request, but each index also adds write cost and memory, so remove the old index if it no longer serves a query.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB index is an ordered data structure that maps key values to document locations. A compound index contains several keys in a defined order. The order is the design: a query can use a leading prefix of the keys, and the index can supply a sort order only when the requested order matches the key order or its exact reverse.",
  },
  {
    type: "p",
    text: "The equality-sort-range (ESR) guideline is a starting point. Put equality fields first because they pin the scan to one value per field, then the sort fields so the index can return results in order, then range fields because a range loosens the scan. A range field before the sort prevents the index from supplying the sort. Equality keys can appear in any order among themselves, but all of them must precede sort and range keys.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Indexes sit between the query planner and the collection. The planner evaluates the query shape, the available indexes, and statistics, then chooses a winning plan. At execution time the plan either scans the collection, scans index keys and fetches documents, or reads only the index when the query is covered.",
  },
  {
    type: "table",
    headers: ["Plan signal", "What it means", "What to inspect next"],
    rows: [
      ["COLLSCAN", "Every document is read", "Whether a leading index key is constrained"],
      ["IXSCAN", "Index keys narrow the scan", "Keys examined versus documents returned"],
      ["SORT", "A blocking in-memory sort is needed", "Sort key order and direction"],
      ["FETCH", "Documents are read after the index", "Whether the index could cover the query"],
      ["IXSCAN + SORT", "Filter is indexed but order is not", "Move the sort key before the range key"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Query p99: the tail as the plan examines more documents.",
      "Documents examined: the work the plan performs, not the size of the result.",
      "Examined-to-returned ratio: how much extra work the index removes or leaves behind.",
      "Query rate: the multiplier that turns a bad plan into a capacity problem.",
      "Plan stage: COLLSCAN, IXSCAN, or IXSCAN plus a blocking sort.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy: the index prefix matches the equality fields and the sort. Apply Prefix mismatch and watch the examined count jump to the collection size. Then set the equality prefix back to two and compare. Apply Sort mismatch to isolate filtering from ordering. Use the experiment before revealing the explanation.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "An index is not free",
    body: "Every index consumes memory and must be maintained on writes. Adding one index per query shape can make writes slower and evict useful index pages. Design for the queries that matter, remove unused indexes, and confirm the plan with `explain` instead of assuming the planner will use a field because it appears in the definition.",
  },
  { type: "sim", simId: "index-design" },
  { type: "experiment", experimentId: "predict-prefix" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The query shape did not match the index order. The planner could not use a leading prefix, so it read every document in the collection and discarded almost all of them. At a higher query rate the same wasted work repeated on every request, and p99 rose with collection size even though the result set stayed small.",
  },
  {
    type: "p",
    text: "Correcting the prefix changed the plan from a collection scan to an index scan. The examined-to-returned ratio fell toward one, and the server read only the matching keys. The sort direction was a separate concern: a mismatch would still allow filtering but would add a blocking sort of the matched documents.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`explain('executionStats')` shows a COLLSCAN stage and `totalDocsExamined` equal to the collection size.",
      "`nReturned` is far smaller than `totalDocsExamined`, and `totalKeysExamined` may be zero for a collection scan.",
      "Slow query logs repeat the same query shape rather than a single outlier.",
      "Application p99 rises with collection growth or query rate, not with the size of the result.",
      "After the index change, the plan uses IXSCAN and the examined count tracks the match count.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Run `explain('executionStats')` on the slow query and read the winning plan. Compare examined keys, examined documents, and returned documents. Then check whether the query constrains a leading index key and whether the sort order matches the index. Do not add another index until you know which part of the current plan is doing the extra work.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Capture the exact query shape, including filter, sort, and projection.",
      "Confirm the plan stage and the examined-to-returned ratio with `explain('executionStats')`.",
      "Put equality fields first, then the sort fields, then range fields.",
      "Match sort direction, or reverse the whole sort when the index supports it.",
      "Consider a covered query only when the index contains all projected fields.",
      "Remove the old index if it no longer serves a query; each index costs writes and memory.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More indexes improve read plans but increase write maintenance and memory pressure.",
      "A covering index avoids document fetches but can be wide and expensive to maintain.",
      "An index that matches a sort may not be the most selective filter order for every query.",
      "A low-cardinality leading key can still leave many documents to inspect.",
      "Optimizing for one query shape can make another shape choose a worse plan.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "fields-but-unused",
    question:
      "A compound index contains every field in the query, but the planner does not use it. How do you explain that?",
    difficulty: 2,
    hints: [
      "An index is ordered, not a set.",
      "The planner uses a leading prefix.",
      "Check whether the leading key is constrained.",
    ],
    answer:
      "An index is searched by a leading prefix. If the first key is not constrained by the query, the planner cannot use later keys to narrow the scan. I would inspect the index order, the query predicates, and the sort. Reordering the keys so the equality fields lead, then the sort, then the range usually fixes it. I would verify with `explain('executionStats')` rather than assuming.",
    followUps: [
      "When can equality keys appear in any order?",
      "Why does a range key before the sort hurt?",
      "What does a covered query change?",
    ],
    redFlags: [
      "Says MongoDB should use any index containing the field.",
      "Adds another index without reading the plan.",
      "Ignores sort direction.",
    ],
    rubric: [
      "Explains prefix use.",
      "Applies ESR ordering.",
      "Mentions sort direction.",
      "Verifies with explain.",
    ],
  },
  {
    id: "esr",
    question: "How would you design a compound index for an equality filter, a sort, and a range?",
    difficulty: 3,
    hints: [
      "Start with the fields that pin the scan.",
      "The sort should come before the range.",
      "The order is a guideline, not a law.",
    ],
    answer:
      "I would put the equality fields first, then the sort field, then the range field. That order lets the index narrow to the equality matches, return results in the requested order, and apply the range without forcing a blocking sort. If the range is extremely selective, putting it before the sort can reduce the number of sorted documents, so I would test both plans with real data. I would also check sort direction and whether the query can be covered.",
    followUps: [
      "When would you put the range before the sort?",
      "How does a compound sort direction reversal work?",
      "What statistics would you check before choosing?",
    ],
    redFlags: [
      "Puts the range first by default.",
      "Ignores the sort direction.",
      "Assumes the guideline always beats measurement.",
    ],
    rubric: [
      "Equality first.",
      "Sort before range by default.",
      "Mentions the selective-range exception.",
      "Verifies with explain.",
    ],
  },
  {
    id: "index-cost",
    question: "When would you not add an index for a slow query?",
    difficulty: 2,
    hints: [
      "Indexes cost writes and memory.",
      "A plan can be slow for reasons other than missing keys.",
      "A low-selectivity predicate may not benefit.",
    ],
    answer:
      "I would not add an index when the predicate is not selective enough to justify it, when the query runs rarely and the scan is acceptable, or when the write cost and memory pressure would hurt the workload more than the read improves. I would also check whether the slowness comes from a blocking sort, a large result set, or lock contention rather than a missing index. The index has to earn its maintenance cost.",
    followUps: [
      "How do you measure index usage?",
      "What is the write cost of an extra index?",
      "When is a collection scan the right plan?",
    ],
    redFlags: [
      "Adds an index for every slow query.",
      "Ignores write amplification.",
      "Does not check whether the index is actually used.",
    ],
    rubric: [
      "Considers selectivity.",
      "Considers write and memory cost.",
      "Checks the real bottleneck.",
      "Mentions removing unused indexes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Slow-query dashboards group by query shape and show plan stage.",
      "The team knows the top query shapes and their supporting indexes.",
      "Index builds are tested on production-sized data.",
      "Unused indexes are reviewed and removed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Run `explain('executionStats')` on the slow shape before changing indexes.",
      "Compare keys examined, documents examined, and documents returned.",
      "Check whether the query constrains the leading index key.",
      "Check whether the sort direction matches the index.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the new plan uses the intended index.",
      "Compare p99 and examined documents before and after the change.",
      "Check the write cost of the new index.",
      "Remove the replaced index if it no longer serves a query.",
    ],
  },
];

const references = [
  {
    title: "Indexes",
    url: "https://www.mongodb.com/docs/manual/indexes/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Index types, compound keys, index prefixes, and query planning.",
  },
  {
    title: "The ESR (Equality, Sort, Range) Guideline",
    url: "https://www.mongodb.com/docs/manual/tutorial/equality-sort-range-guideline/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Key order for equality, sort, and range predicates, including the selective-range exception.",
  },
  {
    title: "Analyze Query Performance",
    url: "https://www.mongodb.com/docs/manual/tutorial/analyze-query-plan/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Reading explain output and comparing examined work with returned documents.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "index-design": {
      model: indexDesignModel,
      presets,
      instructions:
        "Start Healthy, then apply Prefix mismatch. Watch documents examined jump to the collection size. Correct the equality prefix and compare the ratio. Apply Sort mismatch to isolate ordering from filtering.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Collection size, selectivity, and latency are teaching values. Confirm real plans with `explain('executionStats')`.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["databases-indexing", "mongodb-write-amplification", "mongodb-aggregation-perf"],
};
