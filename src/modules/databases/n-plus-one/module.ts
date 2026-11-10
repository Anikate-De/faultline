import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "itemCount",
    label: "Items on the page",
    min: 10,
    max: 1_000,
    step: 10,
    value: 200,
    unit: " items",
    group: "Page",
    help: "How many parent rows the page renders. N+1 cost scales with this number, so a page that is fine in testing can fail at production size.",
    format: "count" as const,
  },
  {
    id: "queriesPerItem",
    label: "Queries per item",
    min: 1,
    max: 5,
    step: 1,
    value: 1,
    unit: "",
    group: "Page",
    help: "Extra queries issued for each item, such as a lazy relation. One or two is typical of an object-relational mapper loading associations.",
    format: "count" as const,
  },
  {
    id: "dbLatencyMs",
    label: "Database round trip",
    min: 0.5,
    max: 20,
    step: 0.5,
    value: 2,
    unit: " ms",
    group: "Database",
    help: "Time for one request and response. Network distance and database queueing both contribute.",
    format: "ms" as const,
  },
  {
    id: "batchSize",
    label: "Batch size",
    min: 1,
    max: 200,
    step: 1,
    value: 1,
    unit: " items",
    group: "Fix",
    help: "1 means one query per item. A larger batch fetches related rows for many items in one round trip, at the cost of a larger result set.",
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

interface Computed {
  itemCount: number;
  queriesPerItem: number;
  dbLatencyMs: number;
  batchSize: number;
  batches: number;
  roundTrips: number;
  queueFactor: number;
  pageMs: number;
  dbTimeMs: number;
  pageHealth: Health;
  poolHealth: Health;
  dbHealth: Health;
}

function compute(p: Params): Computed {
  const itemCount = Math.round(clamp(num(p, "itemCount", 200), 10, 1_000));
  const queriesPerItem = Math.round(clamp(num(p, "queriesPerItem", 1), 1, 5));
  const dbLatencyMs = clamp(num(p, "dbLatencyMs", 2), 0.5, 20);
  const batchSize = Math.round(clamp(num(p, "batchSize", 1), 1, 200));
  const batches = Math.ceil(itemCount / batchSize);
  const roundTrips = batches * queriesPerItem + 1;
  const queueFactor = 1 + Math.max(0, roundTrips - 50) / 200;
  const pageMs = 5 + roundTrips * dbLatencyMs * queueFactor;
  const dbTimeMs = roundTrips * dbLatencyMs;
  return {
    itemCount,
    queriesPerItem,
    dbLatencyMs,
    batchSize,
    batches,
    roundTrips,
    queueFactor,
    pageMs,
    dbTimeMs,
    pageHealth: status(pageMs, 300, 1_000),
    poolHealth: status(roundTrips, 40, 400),
    dbHealth: status(pageMs, 300, 1_000),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["page-p95", values.pageMs, 0.6],
    ["round-trips", values.roundTrips, 0],
    ["db-time", values.dbTimeMs, 0.4],
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
        id: "client",
        label: "Browser",
        kind: "client",
        health: values.pageHealth,
        utilization: clamp(values.pageMs / 25_000),
        sublabel: `waits ${values.pageMs.toFixed(0)} ms`,
        detail:
          "The browser waits for the server response. Every extra round trip adds latency to the critical path even when each query is fast.",
        meta: { pageMs: Math.round(values.pageMs) },
      },
      {
        id: "page",
        label: "Page service",
        kind: "service",
        health: values.pageHealth,
        utilization: clamp(values.roundTrips / 1_000),
        sublabel: `${formatCount(values.roundTrips)} queries`,
        detail:
          "The page loads the parent list, then asks for each item's related data. The pattern is invisible in a single slow-query log because no individual query is slow.",
        meta: { queries: values.roundTrips },
      },
      {
        id: "pool",
        label: "Connection pool",
        kind: "storage",
        health: values.poolHealth,
        utilization: clamp(values.roundTrips / 400),
        sublabel: `${Math.min(values.roundTrips, 400)} of 400 busy`,
        detail:
          "Each query borrows a connection for its round trip. Many short queries occupy the pool longer in aggregate than one larger query and increase wait time for other requests.",
        meta: { roundTrips: values.roundTrips },
      },
      {
        id: "db",
        label: "orders database",
        kind: "db",
        role: "primary",
        health: values.dbHealth,
        utilization: clamp(values.dbTimeMs / 25_000),
        sublabel: `${values.dbLatencyMs.toFixed(1)} ms per trip`,
        detail:
          "The database may execute each small query efficiently. The cost is the number of trips, not the cost of one statement.",
        meta: { latency: values.dbLatencyMs },
      },
    ],
    edges: [
      edge("client-page", "client", "page", clamp(values.roundTrips / 1_000), values.pageHealth, "page request"),
      edge("page-pool", "page", "pool", clamp(values.roundTrips / 1_000), values.poolHealth, "borrow connection"),
      edge("pool-db", "pool", "db", clamp(values.roundTrips / 1_000), values.dbHealth, "query"),
    ],
    metrics: [
      metric("page-p95", "Page p95", values.pageMs, " ms", 300, 1_000, "ms"),
      metric("round-trips", "Queries per page", values.roundTrips, " queries", 40, 400, "count"),
      metric("db-time", "Database time per page", values.dbTimeMs, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.roundTrips)} queries for ${values.itemCount} items; page p95 ${values.pageMs.toFixed(
      0,
    )} ms; ${values.batchSize === 1 ? "no batching" : `batch of ${values.batchSize}`}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "page-latency",
    metricId: "page-p95",
    warn: 300,
    crit: 1_000,
    title: "Round trips dominate page latency",
    cause:
      "Each item triggers its own query, so page time grows with item count times queries per item. Queueing and connection-pool waits amplify the effect because many small queries compete for the same capacity.",
    fix:
      "Replace per-item queries with a join, an IN batch, or a dataloader. Keep the batch size bounded and measure the result set and memory cost.",
    checkFirst: [
      "Count queries per page request, not just the slowest query.",
      "Check whether the ORM is lazy-loading an association inside the render loop.",
      "Compare page latency with item count; a linear relationship points at N+1.",
    ],
  },
  {
    id: "query-count",
    metricId: "round-trips",
    warn: 40,
    crit: 400,
    title: "Query count scales with page size",
    cause:
      "The page issues one query per item plus the parent query. The count grows with the number of rendered items, so a larger page or a larger tenant makes the same code path much more expensive.",
    fix:
      "Fetch related rows for the whole page in one query, or chunk into a fixed number of batches. Add a query-count budget to the page and test it with production-sized data.",
    checkFirst: [
      "Look at the query count for one request in the ORM log or trace.",
      "Check whether the page size is configurable and whether the test data is small.",
      "Identify which association is loaded per item.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const nPlusOneModel: SimModel = {
  id: "databases-n-plus-one",
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
    if (values.roundTrips >= 40 && frame.flags.nPlusOneLogged !== 1) {
      pushEvent(next, {
        id: "n-plus-one-pattern",
        severity: values.roundTrips >= 400 ? "crit" : "warn",
        title: "Per-item queries multiply with page size",
        detail: `${values.itemCount} items at ${values.queriesPerItem} extra queries each produced ${formatCount(
          values.roundTrips,
        )} round trips. Page p95 is ${values.pageMs.toFixed(0)} ms.`,
        nodeId: "page",
        metricId: "round-trips",
      });
    }
    if (values.pageMs >= 1_000 && frame.flags.queueLogged !== 1) {
      pushEvent(next, {
        id: "round-trip-queueing",
        severity: "crit",
        title: "Connection queueing amplifies the round trips",
        detail: `The page needs ${formatCount(values.roundTrips)} round trips and waits ${values.pageMs.toFixed(
          0,
        )} ms. The queue factor is ${values.queueFactor.toFixed(2)}, so each query also waits for capacity.`,
        nodeId: "pool",
        metricId: "page-p95",
      });
    }
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.nPlusOneLogged = values.roundTrips >= 40 ? 1 : 0;
    next.flags.queueLogged = values.pageMs >= 1_000 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${formatCount(values.roundTrips)} queries for ${values.itemCount} items; page p95 ${values.pageMs.toFixed(
      0,
    )} ms; ${values.batchSize === 1 ? "no batching" : `batch of ${values.batchSize}`}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The page makes ${formatCount(values.roundTrips)} round trips for ${values.itemCount} items: one list query plus ${
        values.batches
      } batch${values.batches === 1 ? "" : "es"} of ${values.queriesPerItem} per-item queries.`,
      `At ${values.dbLatencyMs.toFixed(1)} ms per trip, database time alone is ${values.dbTimeMs.toFixed(
        0,
      )} ms. The rest is queueing and page overhead.`,
      values.batchSize > 1
        ? `A batch size of ${values.batchSize} reduces the trips to ${formatCount(
            values.roundTrips,
          )}. Batch size trades round trips for result-set size and memory.`
        : "Batch size is one, so every item is a separate round trip.",
      "A join often returns the same data in one trip, but it can duplicate parent columns and complicate pagination.",
      "The slowest single query may look fine; the problem is the count and the aggregate wait.",
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
    description: "Fifty items fetched in batches of fifty: two round trips and a nine-millisecond page.",
    tone: "ok",
    params: defaults({ itemCount: 50, batchSize: 50 }),
  },
  {
    id: "peak",
    label: "Production page size",
    description: "Two hundred items with one lazy query each and no batching. Page p95 warns without crossing critical.",
    tone: "warn",
    params: defaults({ itemCount: 200, dbLatencyMs: 1.5 }),
  },
  {
    id: "failure",
    label: "Two queries per item",
    description: "Five hundred items, two lazy queries each, four milliseconds per trip. The page makes 1,001 round trips.",
    tone: "crit",
    params: defaults({ itemCount: 500, queriesPerItem: 2, dbLatencyMs: 4 }),
  },
  {
    id: "recovery",
    label: "Batched fetch",
    description: "The same page size batched in groups of one hundred: three round trips and a healthy page.",
    tone: "ok",
    params: defaults({ itemCount: 200, dbLatencyMs: 4, batchSize: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-n-plus-one-count",
  title: "Predict the round trips",
  simId: "n-plus-one",
  question:
    "A page loads 500 orders and, for each order, lazy-loads two related records. It also issues one query for the order list. How many round trips does the page make?",
  prediction: {
    options: [
      { id: "1001", label: "1,001: one list query plus 500 times 2 related queries." },
      { id: "501", label: "501: one list query plus one related query per order." },
      { id: "2", label: "2: one query for orders and one batch for related records." },
      { id: "4000", label: "4,000: the number of rows times the number of joins." },
    ],
    correctOptionId: "1001",
    explanation:
      "N+1 means one query for the list plus N queries for related data. Here each of the 500 orders triggers two lazy queries, so the page makes 1 + 500 times 2, or 1,001 round trips. The database may execute each one quickly; the count and queueing are what make the page slow.",
  },
  setup: defaults({ itemCount: 500, queriesPerItem: 2, dbLatencyMs: 4 }),
  runFor: 20,
  observe: [
    "Queries per page is 1,001 and crosses the 400 critical line.",
    "Page p95 is about 23,000 ms because each trip also waits on queueing.",
    "Database time alone is about 4,000 ms; the rest is the queue factor.",
    "The page, pool, and database nodes are all failing.",
    "Batching in groups of 50 reduces the same page to 21 round trips.",
  ],
  explain:
    "The per-item query sits inside the render loop, so the count is page size times queries per item plus the list query. The queue factor makes it worse: as the page holds connections longer, each subsequent query waits for capacity. A join or batch collapses the 1,001 trips into a small fixed number, and p95 falls with them.",
  fix: defaults({ itemCount: 500, queriesPerItem: 2, dbLatencyMs: 4, batchSize: 50 }),
  debrief:
    "Batching a group of 50 items changes 1,001 trips into 21: ten batches times two queries, plus the list query. Page p95 falls from about 23,000 ms to about 89 ms. The same page size is now healthy, which is why the fix belongs in the data-loading shape, not in a faster database instance.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "N+1 is a query pattern, not a query. One query loads a list of parent rows, then the application issues one additional query per row to load a relation. A page with 200 orders and one lazy-loaded customer per order makes 201 queries. The pattern is easy to miss because each query is fast in isolation.",
  },
  {
    type: "p",
    text: "The cost is mostly round trips, not row processing. Each query carries a request and response across the network, borrows a connection, and waits in the database's queue. At low volume the overhead is hidden. As page size grows, the number of trips grows linearly, and p99 suffers more than the average because some requests wait behind others for connections and database time.",
  },
  {
    type: "p",
    text: "The fix changes the shape of the data loading. A join returns parents and children in one statement. An IN batch fetches related rows for many parents in one statement. A dataloader collects the keys requested during one render tick and issues a single batched query. Each option reduces round trips and has a different effect on result size, ordering, and application code.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pattern lives in the application or object-relational mapper, not in the database. The page service requests a list, then calls a relation for each item. Those calls pass through the connection pool and into the database. The database sees many short statements; the pool sees long aggregate occupancy; the user sees the sum of every round trip.",
  },
  {
    type: "compare",
    leftTitle: "Per-item query",
    rightTitle: "Batched or joined fetch",
    rows: [
      { label: "Round trips", left: "1 + N times queries per item", right: "A small fixed number" },
      { label: "Latency shape", left: "Grows with page size", right: "Mostly flat with page size" },
      { label: "Connection use", left: "Many short borrows", right: "Fewer, longer borrows" },
      { label: "Main risk", left: "N+1 explosion and pool pressure", right: "Large result sets and memory" },
      { label: "Code change", left: "Usually the status quo", right: "Eager load, join, or dataloader" },
    ],
  },
  {
    type: "table",
    headers: ["Fix", "Best when", "Cost"],
    rows: [
      ["Join", "Parent and child are displayed together and pagination is on the parent", "Duplicated parent columns; count and pagination need care"],
      ["IN batch", "The page already has parent keys and needs children by key", "Bound the batch size; large IN lists consume memory and planning time"],
      ["Dataloader", "Many resolvers request the same relation during one render", "Per-request cache and scheduling complexity"],
      ["Eager loading", "The ORM can declare the relation up front", "Easy to over-fetch or create a different N+1 on another relation"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Queries per page, the count that grows with item count and queries per item.",
      "Page p95, which includes every round trip, queueing, and render overhead.",
      "Database time per page, which separates query execution from waiting.",
      "A batch-size control, so you can collapse the per-item calls without changing the page size.",
      "Connection pool pressure, because many short queries hold capacity longer in aggregate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with fifty items and a batch of fifty. Apply Production page size: the same code now makes 201 queries for 200 items. Then apply Two queries per item to see the count and queueing compound. Set batch size to 50 and compare the page latency at the same item count. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Item counts, round-trip times, and thresholds are illustrative teaching values. The shape of the curve matters more than the exact milliseconds.",
  },
  { type: "sim", simId: "n-plus-one" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The page loaded 500 orders and issued two related queries per order plus the list query: 1,001 round trips. At four milliseconds per trip the database time was about 4,000 ms, but the page took about 23,000 ms because the queue factor multiplied each wait as connections became scarce. Neither the list query nor any single related query was slow.",
  },
  {
    type: "p",
    text: "Batching in groups of 50 turned the same 500 items into ten batches of two queries plus the list query: 21 round trips. Page p95 fell to about 89 ms. The item count did not change and the database did not get faster. The data-loading shape changed, and that was enough.",
  },
  {
    type: "p",
    text: "The queue factor is the part teams underestimate. When a page holds connections for a thousand short queries, other requests wait behind it. p99 grows faster than the average because the slowest requests are the ones that arrive when the pool is busiest. The fix is not only fewer queries; it is a bounded, predictable number of them.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A query count per request in the ORM log, APM trace, or database proxy, rather than only the slowest query.",
      "`pg_stat_statements` showing many calls of the same small statement with one row per call.",
      "Connection pool wait time and active connections rising with page size or tenant size.",
      "Page p95 and p99 diverging as concurrency rises, even when the mean stays acceptable.",
      "The same page fast with test data and slow with a production-sized tenant.",
      "A trace where database spans are numerous and short, and the total span is dominated by their sum.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count queries for one page request. If the count is close to the number of rendered items, you have N+1. Then find the relation loaded inside the loop and decide whether a join, an IN batch, or a dataloader fits the access pattern.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Reproduce with production-sized data and count queries, not just duration.",
      "Find the per-item call in the render or serialization loop.",
      "Prefer a join when parent and child rows are returned together and pagination is on the parent.",
      "Use an IN batch when the page already has keys and needs related rows; bound the batch size.",
      "Use a dataloader when many resolvers request the same relation in one request; cache per request.",
      "Watch the result-set size: fewer round trips can mean a much larger payload and more memory.",
      "Add a query-count budget or a test that fails when a page exceeds the expected number of statements.",
      "Re-measure p95 and pool wait after the change, including a larger tenant.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A join reduces round trips but duplicates parent columns and complicates pagination and counts.",
      "An IN batch is simple but can create a very large result set; chunk it and keep the chunk size bounded.",
      "A dataloader reduces duplicate work per request but adds per-request caching and scheduling complexity.",
      "Eager loading is convenient but can over-fetch columns or create a different N+1 on another relation.",
      "Fewer, larger queries shift cost from the network and pool to the database's memory and planning.",
      "A cache can hide N+1 until the cache is cold; the query count still matters on the first request.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "detect-n-plus-one",
    question:
      "A page loads 200 orders and makes 201 queries. How do you confirm N+1 and where do you fix it?",
    difficulty: 2,
    hints: [
      "Look for a query issued inside the loop over items.",
      "The fix changes data loading, not the database.",
    ],
    answer:
      "I would confirm it from a request-scoped query count or trace: one list query plus one query per order is the signature. Then I would find the relation loaded for each order and choose a fix based on the access pattern. A join works if parents and children are rendered together and pagination is on the parent. An IN batch works when I already have the order keys, with a bounded batch size. A dataloader works when many resolvers ask for the same relation. I would re-measure query count, p95, and pool wait with production-sized data.",
    followUps: [
      "How would you fix a nested N+1 two relations deep?",
      "What if the related data comes from another service?",
      "How do you keep the fix from regressing?",
    ],
    redFlags: [
      "Adds an index to the per-item query.",
      "Increases the connection pool.",
      "Optimizes only the slowest query.",
    ],
    rubric: [
      "Counts queries per request.",
      "Identifies the per-item relation.",
      "Chooses join, batch, or dataloader with a reason.",
      "Re-measures with realistic data.",
    ],
  },
  {
    id: "p99-growth",
    question: "Why does N+1 hurt p99 more than the average latency?",
    difficulty: 3,
    hints: [
      "Each request makes many waits.",
      "The pool is shared across requests.",
    ],
    answer:
      "Each request accumulates many small waits, and those waits are variable. A request that arrives when the pool is busy waits behind other requests, so its total is the sum of its own round trips plus queueing. Averaging over many requests hides the tail, while p99 captures the requests that hit contention. As concurrency rises, the queue grows and the tail grows faster than the mean. Reducing the number of round trips reduces both the baseline and the variance.",
    followUps: [
      "How would you measure pool wait separately from query time?",
      "What does a flat mean with a rising p99 suggest?",
      "How does batch size change the tail?",
    ],
    redFlags: [
      "Says the database is slow.",
      "Looks only at average query time.",
      "Ignores connection pool contention.",
    ],
    rubric: [
      "Connects round trips to accumulated waits.",
      "Explains queueing and shared pool.",
      "Distinguishes mean from tail.",
      "Proposes reducing round trips.",
    ],
  },
  {
    id: "join-vs-batch",
    question: "When would you choose a join over an IN batch, and what breaks with each?",
    difficulty: 3,
    hints: [
      "Think about pagination and result shape.",
      "Think about batch size and memory.",
    ],
    answer:
      "A join is natural when the page renders parent and child rows together and pagination is on the parent; it returns one result set and avoids a second round trip. The risk is duplicated parent columns, a larger result, and count or pagination queries that need DISTINCT or a subquery. An IN batch is natural when the page already has parent keys and needs children separately; it keeps the parent query simple but can create a huge IN list. I would bound the batch size, keep ordering stable in the application, and measure the result-set size. A dataloader is a third option when many resolvers request the same relation during one request.",
    followUps: [
      "How do you paginate a parent-child join correctly?",
      "What is the risk of a very large IN list?",
      "When is a dataloader better than either?",
    ],
    redFlags: [
      "Uses a join for every relation.",
      "Ignores pagination correctness.",
      "Builds an unbounded IN list.",
    ],
    rubric: [
      "Matches the fix to the access pattern.",
      "Names the result-shape risk.",
      "Bounds batch size.",
      "Mentions pagination or counts.",
    ],
  },
  {
    id: "prevent-regression",
    question: "How do you prevent N+1 from coming back after you fix it?",
    difficulty: 2,
    hints: [
      "Make the query count visible in tests.",
      "Make the default data-loading path safe.",
    ],
    answer:
      "I would make the query count observable per request or per test, and set a budget for important pages. I would add a test with production-sized data that fails when the count exceeds the budget. I would also make the safe path the default in the data layer, such as an eager-loading or dataloader pattern, so a new relation does not silently add a per-item query. Finally I would keep a dashboard for query count and pool wait, not just latency, so a regression is visible before it becomes an incident.",
    followUps: [
      "What budget would you set for a list page?",
      "How do you test a page that uses a third-party API?",
      "Why is a latency-only alert insufficient?",
    ],
    redFlags: [
      "Relies on code review alone.",
      "Tests only with small fixtures.",
      "Alerts only on average latency.",
    ],
    rubric: [
      "Adds a query-count budget or test.",
      "Uses production-sized data.",
      "Makes the safe path the default.",
      "Monitors query count and pool wait.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Important pages have a query-count budget and a test with production-sized data.",
      "The data layer makes eager loading or batching the default for common relations.",
      "Traces record query count and pool wait per request, not only duration.",
      "Batch sizes are bounded and result-set size is reviewed.",
      "p99 and pool saturation are alerted separately from average latency.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Count queries for a single slow request and compare with item count.",
      "Identify the relation loaded inside the loop.",
      "Choose join, batch, or dataloader based on the access pattern.",
      "Check pool wait before increasing pool size.",
      "Re-measure with the same page size after the change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test for the query count.",
      "Review other pages that render lists with lazy relations.",
      "Keep batch sizes and result-set memory within a stated limit.",
      "Document the pattern and the safe data-loading path for the team.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Table Expressions and Joins",
    url: "https://www.postgresql.org/docs/current/queries-table-expressions.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Join types, join order, and how a single statement can return parent and child rows.",
  },
  {
    title: "PostgreSQL: Performance Tips",
    url: "https://www.postgresql.org/docs/current/performance-tips.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "The cost of many small statements and the benefit of reducing round trips.",
  },
  {
    title: "PostgreSQL: Using EXPLAIN",
    url: "https://www.postgresql.org/docs/current/using-explain.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Reading plans for the batched or joined replacement query.",
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
    "n-plus-one": {
      model: nPlusOneModel,
      presets,
      instructions:
        "Start healthy, apply Two queries per item, then raise batch size without changing the item count. Compare queries per page, page p95, and database time.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Item counts, latencies, and thresholds are teaching values, not ORM benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-query-plans",
    "databases-indexing",
    "databases-max-connections",
    "databases-pgbouncer",
    "databases-rds-aurora-arch",
  ],
};
