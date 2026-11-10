import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INSTANCES = 12;
const BACKEND_CAPACITY = 900;
const APP_CAPACITY = 60_000;

const params = [
  {
    id: "missRps",
    label: "Miss arrival rate",
    min: 100,
    max: 20_000,
    step: 100,
    value: 1_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second for one key that arrive after it expired or while it is absent. Every arrival is a cache miss.",
    format: "rps" as const,
  },
  {
    id: "coalescing",
    label: "Single-flight coverage",
    min: 0,
    max: 100,
    step: 10,
    value: 80,
    unit: "%",
    group: "Protection",
    help: "Share of the 12 app instances that keep one in-flight fetch per key and share its result with concurrent callers. 0% is no coalescing.",
    format: "percent" as const,
  },
  {
    id: "backendMs",
    label: "Backend fetch time",
    min: 20,
    max: 800,
    step: 20,
    value: 120,
    unit: " ms",
    group: "Backend",
    help: "Time one database fetch takes. It also sets how long an in-flight entry stays open and how many waiters it collects.",
    format: "ms" as const,
  },
  {
    id: "stalePolicy",
    label: "Serve stale while refreshing",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Protection",
    help: "1 returns the last cached value immediately while one fetch runs. 0 makes every waiter block until the fetch finishes.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pct(p: Params, id: string, fallback: number): number {
  return clamp(num(p, id, fallback) / 100);
}

interface Computed {
  missRps: number;
  coverage: number;
  backendMs: number;
  backendSec: number;
  stale: boolean;
  coveredLoad: number;
  uncoveredLoad: number;
  backendQps: number;
  coalescedPct: number;
  waiters: number;
  p99: number;
  readP99: number;
  staleServed: number;
  util: number;
}

function compute(p: Params): Computed {
  const missRps = Math.max(1, num(p, "missRps", 1_000));
  const coverage = pct(p, "coalescing", 80);
  const backendMs = Math.max(1, num(p, "backendMs", 120));
  const backendSec = backendMs / 1000;
  const stale = num(p, "stalePolicy", 1) >= 1;
  const canServeStale = stale && coverage > 0;
  const coveredCapacity = (INSTANCES * coverage) / backendSec;
  const coveredLoad = Math.min(missRps * coverage, coveredCapacity);
  const uncoveredLoad = missRps * (1 - coverage);
  const backendQps = coveredLoad + uncoveredLoad;
  const util = backendQps / BACKEND_CAPACITY;
  const p99 =
    backendMs * (util <= 1 ? 1 + 0.25 * util ** 4 : 1 + 3.2 * Math.log2(Math.max(1, util)));
  const waiters = canServeStale ? 0 : Math.max(0, coverage * (missRps * backendSec - INSTANCES));
  const fetchP99 = 1.5 + p99;
  const readP99 = canServeStale
    ? coverage >= 1
      ? 1.5
      : coverage * 1.5 + (1 - coverage) * fetchP99
    : fetchP99;
  const coalescedPct = missRps > 0 ? clamp(1 - backendQps / missRps) * 100 : 0;
  return {
    missRps,
    coverage,
    backendMs,
    backendSec,
    stale,
    coveredLoad,
    uncoveredLoad,
    backendQps,
    coalescedPct,
    waiters,
    p99,
    readP99,
    staleServed: canServeStale ? missRps * coverage : 0,
    util,
  };
}

function healthFor(qps: number): "ok" | "warn" | "crit" {
  if (qps >= 900) return "crit";
  if (qps >= 600) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const c = compute(p);
  const health = healthFor(c.backendQps);
  const appHealth = c.backendQps >= 900 ? "warn" : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Readers",
        kind: "client",
        health: "ok",
        utilization: clamp(c.missRps / APP_CAPACITY),
        throughput: c.missRps,
        sublabel: `${formatCount(c.missRps)} misses/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "App fleet",
        kind: "service",
        health: appHealth,
        utilization: clamp(c.missRps / APP_CAPACITY),
        throughput: c.missRps,
        sublabel: `${INSTANCES} instances`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Shared cache",
        kind: "cache",
        health: appHealth,
        throughput: c.missRps,
        sublabel: "key absent or expired",
        detail:
          "The key is missing for every instance. A cache hit would end the path here; this module starts after the miss.",
        meta: { view: "flow" },
      },
      {
        id: "inflight",
        label: "In-flight fetch",
        kind: "worker",
        health: "ok",
        throughput: c.coveredLoad,
        sublabel: c.waiters > 0 ? `${formatCount(c.waiters)} waiters` : "shared result",
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Database",
        kind: "db",
        health,
        utilization: clamp(c.util),
        throughput: c.backendQps,
        sublabel: `${formatCount(c.backendQps)} qps`,
        detail: `Illustrative teaching capacity is ${formatCount(BACKEND_CAPACITY)} qps. ${formatCount(c.coveredLoad)} qps come from coalesced fetches and ${formatCount(c.uncoveredLoad)} from uncovered misses.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", clamp(c.missRps / APP_CAPACITY)),
      edge("app-cache", "app", "cache", 1, "ok"),
      edge("app-inflight", "app", "inflight", c.coverage, "ok"),
      edge(
        "app-backend",
        "app",
        "backend",
        clamp(c.uncoveredLoad / Math.max(1, c.missRps)),
        health,
      ),
      edge(
        "inflight-backend",
        "inflight",
        "backend",
        clamp(c.coveredLoad / BACKEND_CAPACITY),
        health,
      ),
    ],
    metrics: [
      metric("backend-qps", "Backend queries", c.backendQps, " qps", 600, 900, "rps"),
      metric("backend-p99", "Backend p99", c.p99, " ms", 400, 1_000, "ms"),
      metric("read-p99", "Read p99", c.readP99, " ms", 250, 800, "ms"),
      metric("waiters", "Coalesced waiters", c.waiters, "", undefined, undefined, "count"),
      metric(
        "coalesced-share",
        "Coalesced misses",
        c.coalescedPct,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("stale-served", "Stale responses", c.staleServed, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCount(c.missRps)} misses/s; ${formatCount(c.backendQps)} backend qps; ${c.coalescedPct.toFixed(0)}% coalesced; p99 ${c.readP99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
          Math.sin(index / 2.1) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "backend-qps",
    metricId: "backend-qps",
    warn: 600,
    crit: 900,
    title: "Concurrent misses reached the database",
    cause:
      "Each uncovered miss ran its own fetch. Process-local single-flight covers only the instances that enabled it, so the database sees one query per uncovered miss rather than one per key.",
    fix: "Collapse concurrent misses before adding database capacity. Enable single-flight on every instance, add a shared lock for a shared cache tier, and serve stale data while the fetch runs if waiters cannot block.",
    checkFirst: [
      "Compare database QPS with the miss rate for this one key.",
      "Sample the slow statements: are many identical reads running at once?",
      "Check whether every app instance has the per-key in-flight registry enabled.",
    ],
  },
  {
    id: "backend-p99",
    metricId: "backend-p99",
    warn: 400,
    crit: 1_000,
    title: "Duplicate fetches are queueing at the database",
    cause:
      "The database is running the same expensive query many times and queueing the copies. The tail reflects the queue, not one slow query plan.",
    fix: "Reduce concurrent work, not query cost alone. Coalesce the misses, bound the wait, and check whether retries are multiplying the fetch.",
    checkFirst: [
      "Compare p99 with the number of concurrent identical queries.",
      "Check connection-pool wait and query queue depth.",
      "Check whether the cache client retries a timed-out fetch.",
    ],
  },
  {
    id: "read-p99",
    metricId: "read-p99",
    warn: 250,
    crit: 800,
    title: "Users are paying the backend queue time",
    cause:
      "Waiters block until the in-flight fetch completes. That protects the database but moves latency into the request path.",
    fix: "Return the last known value while one refresh runs, or cap the wait and return a defined fallback. A timeout must release the in-flight entry and propagate the failure.",
    checkFirst: [
      "Separate cache-hit latency from miss latency.",
      "Check the waiter count and the fetch deadline.",
      "Check whether stale-while-revalidate is enabled for this key.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const requestCoalescingModel: SimModel = {
  id: "caching-request-coalescing",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const noisy = {
      ...p,
      missRps: Math.max(1, num(p, "missRps", 1_000) * (1 + rng.between(-0.003, 0.003))),
    };
    const next = buildFrame(noisy, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      seed: Number(frame.flags.seed ?? 20261110),
      paramsKey: key,
    };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const c = compute(p);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (c.backendQps >= 900 && frame.flags.uncoalescedSeen !== 1) {
      pushEvent(next, {
        id: "uncoalesced-misses",
        at: frame.t,
        severity: "crit",
        title: "Concurrent misses reached the database",
        detail: `${formatCount(c.backendQps)} queries/s are running for ${formatCount(c.missRps)} misses/s. Only ${Math.round(c.coverage * 100)}% of instances collapse duplicate fetches.`,
        nodeId: "backend",
        metricId: "backend-qps",
      });
      next.flags.uncoalescedSeen = 1;
    }
    if (c.backendQps < 600) next.flags.uncoalescedSeen = 0;
    next.summary = `${formatCount(c.missRps)} misses/s; ${formatCount(c.backendQps)} backend qps; ${c.coalescedPct.toFixed(0)}% coalesced; p99 ${c.readP99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `At ${formatCount(c.missRps)} misses/s and ${Math.round(c.coverage * 100)}% coverage, the database sees ${formatCount(c.backendQps)} qps. ${formatCount(c.uncoveredLoad)} of those qps come from instances with no coalescing.`,
    );
    items.push(
      `Each covered instance can run one fetch per ${c.backendMs.toFixed(0)}ms, about ${(1 / c.backendSec).toFixed(1)} fetches/s per instance. With ${INSTANCES} instances, the covered path is bounded near ${formatCount((INSTANCES * c.coverage) / c.backendSec)} qps.`,
    );
    if (c.waiters > 0) {
      items.push(
        `About ${formatCount(c.waiters)} callers are attached to in-flight fetches. They wait for the same ${c.backendMs.toFixed(0)}ms fetch and need a deadline and an error path.`,
      );
    } else if (c.coverage > 0) {
      items.push(
        `Stale-while-revalidate is on: covered callers get the last value immediately and one fetch runs in the background. Staleness is bounded by the refresh duration only if the refresh succeeds.`,
      );
    }
    if (c.coverage < 1) {
      items.push(
        `${Math.round((1 - c.coverage) * 100)}% of instances do not coalesce, so every miss there becomes a separate query. A single-flight map is process-local; it does not collapse another instance's requests.`,
      );
    }
    items.push(
      "Coalescing bounds duplicate work. It does not remove the first fetch, and it does not make a failed fetch succeed.",
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
    description: "Most instances coalesce, stale reads are allowed, and the database has headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "More misses and partial coverage. The database crosses its warning threshold.",
    tone: "warn",
    params: defaults({ missRps: 1_200, coalescing: 40, backendMs: 200, stalePolicy: 1 }),
  },
  {
    id: "failure",
    label: "No coalescing",
    description: "Every instance fetches on every miss; the database saturates.",
    tone: "crit",
    params: defaults({ missRps: 6_000, coalescing: 0, backendMs: 120, stalePolicy: 0 }),
  },
  {
    id: "recovery",
    label: "Coalesced",
    description:
      "Full coverage and stale-while-revalidate. Backend work falls to one fetch per instance.",
    tone: "ok",
    params: defaults({ missRps: 4_000, coalescing: 100, backendMs: 120, stalePolicy: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-coalesced-queries",
  title: "Predict the queries after coalescing",
  simId: "request-coalescing",
  question:
    "Six thousand requests per second miss the same key. If single-flight covers all 12 instances and each fetch takes 120 ms, about how many database queries per second run?",
  prediction: {
    options: [
      { id: "per-miss", label: "About 6,000: one query for every miss" },
      { id: "per-instance", label: "About 100: one in-flight fetch per instance" },
      { id: "zero", label: "Zero: the cache answers every request" },
      { id: "half", label: "About 3,000: half the misses are combined" },
    ],
    correctOptionId: "per-instance",
    explanation:
      "A covered instance keeps one in-flight entry per key. While that fetch runs, later callers attach to it instead of starting another. One fetch every 120 ms is about 8.3 fetches per second per instance, and 12 instances give about 100 queries per second. The rest of the 6,000 misses per second wait on those entries or receive a stale value. Without coverage, the database sees one query per miss.",
  },
  setup: defaults({ missRps: 6_000, coalescing: 100, backendMs: 120, stalePolicy: 0 }),
  runFor: 20,
  observe: [
    "The coalesced run holds backend queries near 100 qps while the miss rate stays at 6,000.",
    "About 700 callers are attached to in-flight entries and block for the fetch.",
    "Read p99 is about 120 ms because every covered caller pays the fetch latency.",
    "After stale-while-revalidate is enabled, read p99 falls to the cache path and callers receive the last value immediately.",
    "Backend work stays near 100 qps in both runs; the policy changes the caller's wait, not the fetch count.",
  ],
  explain:
    "Single-flight does not reduce the number of distinct keys or the cost of one fetch. It reduces duplicates: concurrent callers for the same key share one in-flight result. The bound is one fetch per key per instance per fetch duration. That is why 12 instances at 120 ms settle near 100 queries per second, not 6,000. A process-local map cannot collapse another process's request; a shared Redis lock can, at the cost of a round trip, lock expiry, and a new failure mode.",
  fix: defaults({ missRps: 6_000, coalescing: 100, backendMs: 120, stalePolicy: 1 }),
  debrief:
    "Coalescing moved the cost from the database to the request path. Blocking waiters kept the database quiet but held requests for the full fetch. Serving stale values removed that wait and bounded freshness by the refresh duration. The remaining risks are a failed refresh that never updates the value, a stale value served past the product's freshness budget, and a process-local map that leaves other instances uncovered.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Request coalescing, also called single-flight, makes concurrent requests for the same missing key share one fetch. The first caller becomes the leader and starts the database query. Later callers for that key attach to the same in-flight result instead of starting their own. When the fetch returns, the leader stores the value and every waiter receives it. The key is still missing once per instance; the backend does not see fifty copies of the same query.",
  },
  {
    type: "p",
    text: "This is a fix for the concurrency that creates a cache stampede, not a replacement for the cache. A stampede happens when a hot key expires and many requests miss at once. Adding a larger database absorbs the duplicates; coalescing removes them. The mechanism is a per-key in-flight registry: a map from key to a shared promise or result. The map must be released on success, error, and timeout, or the key stays stuck behind a fetch that will never finish.",
  },
  {
    type: "p",
    text: "The second decision is what non-leaders do. They can wait for the fetch, which protects the backend but adds latency, or they can receive the previous value immediately while one refresh runs. The second pattern is stale-while-revalidate. It keeps the read path fast, but the product now has a freshness budget: how old may a value be while a refresh is in progress? A failed refresh must not pin that stale value forever.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, app instance, shared cache, database. Each app instance owns its own in-flight map, so process-local single-flight collapses only the requests that reach that process. With 12 instances, the expected floor is one fetch per instance per key, not one fetch for the fleet. A shared lock in Redis or a coalescing key in the cache tier can collapse across instances, but it adds a network round trip, lock ownership, expiry, and the risk that a crashed leader leaves the lock behind.",
  },
  {
    type: "compare",
    leftTitle: "Blocking waiters",
    rightTitle: "Stale-while-revalidate",
    rows: [
      {
        label: "Backend work",
        left: "One fetch per key per instance in flight",
        right: "One fetch per key per instance in flight",
      },
      {
        label: "Read latency",
        left: "The waiter pays the full fetch time plus queueing",
        right: "The reader gets the cached value immediately",
      },
      {
        label: "Freshness",
        left: "The response is fresh when it returns",
        right: "The response can be stale until the refresh completes",
      },
      {
        label: "Failure mode",
        left: "A slow fetch stalls every waiter; a failed fetch must fan out an error",
        right: "A failed refresh leaves the stale value in place until the next attempt",
      },
    ],
  },
  {
    type: "p",
    text: "The model uses 12 app instances, an illustrative 900 queries-per-second database capacity, and a fixed single key. These are teaching values, not ElastiCache or database limits. The lesson is the difference between one fetch per miss and one fetch per instance in flight.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Backend queries per second, with warning and critical thresholds against the model's teaching capacity.",
      "Backend p99 and user-facing read p99, which separate queueing from waiter latency.",
      "The number of callers attached to an in-flight fetch and the share of misses that were coalesced.",
      "Stale responses per second when stale-while-revalidate is enabled.",
      "Node state for the app fleet, cache, in-flight entry, and database.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No coalescing. Watch backend queries track the miss rate. Raise single-flight coverage and the database load falls to one fetch per instance while waiter count rises. Switch Serve stale while refreshing to 1 and read p99 drops without changing backend work. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      [
        "Single-flight coverage",
        "Collapses concurrent misses inside each covered process",
        "Waiters hold a request slot; the registry needs timeouts and error propagation",
      ],
      [
        "Shared lock",
        "Collapses misses across instances",
        "A network round trip, lock expiry, and a leader that can fail mid-fetch",
      ],
      [
        "Stale-while-revalidate",
        "Removes the wait from the read path",
        "A freshness bound and a refresh path that can fail silently",
      ],
      [
        "Retry budget",
        "Limits repeated fetches after a timeout",
        "A retry without a budget recreates the duplicate work",
      ],
    ],
  },
  {
    type: "p",
    text: "The first question is not how to make the database faster. It is how many copies of the same work are allowed to run at once, and what a caller sees while that work is in progress.",
  },
  { type: "sim", simId: "request-coalescing" },
  { type: "experiment", experimentId: "predict-coalesced-queries" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Without coalescing, every request for the key missed and started its own database fetch. The database received one query per miss and queued the duplicates; backend p99 and read p99 rose together. Enabling single-flight did not make the first fetch cheaper. It made the other callers attach to it, so the database saw one fetch per instance in flight instead of one per request.",
  },
  {
    type: "p",
    text: "The model's covered path is bounded by instances divided by fetch time. At 12 instances and 120 ms, that is about 100 queries per second regardless of whether 1,000 or 6,000 requests per second miss. The difference shows up in waiter count and read latency, not in backend QPS. Stale-while-revalidate removed the waiter latency but left the same one-refresh-per-instance work.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Database: identical queries for one key clustered in the same short window, with QPS far above the key's normal miss rate.",
      "Application: a per-key in-flight map, waiter count, coalesced-fetch count, and fetch failures. These are usually custom metrics, not cache-server metrics.",
      "Cache: one miss per instance per key, not one miss per request. The cache hit rate can look normal before and after the burst.",
      "Traces: a long database span with many sibling requests that start and end together, then a sharp drop when the value is stored.",
      "Logs: repeated loader calls or query text for the same key within the fetch duration.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm that the database spike is duplicate work for one key, not a broader traffic increase. Check whether every instance has coalescing enabled, whether the in-flight entry is released on timeout, and whether waiters have a bounded fallback.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the duplicate-work pattern: identical queries for one key inside one fetch window.",
      "Add per-key single-flight on every instance, with one shared result and a release in a finally path.",
      "Bound the waiter: a deadline longer than the worst fetch, plus a stale value or a defined error.",
      "Decide whether stale reads are acceptable and write the freshness bound into the product contract.",
      "If cross-instance collapsing is required, add a shared lock with a short expiry and a safe owner check.",
      "Load-test a hot-key expiry at peak and verify backend QPS, waiter count, read p99, and refresh failures together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Blocking waiters protect the backend but turn a slow fetch into a slow request; the wait needs a deadline and an error path.",
      "Stale-while-revalidate keeps latency low but makes freshness a product decision and leaves a stale value if refreshes keep failing.",
      "A shared lock collapses more work than a process-local map but adds a network hop, lock expiry, and a new partial-failure mode.",
      "Single-flight does not reduce the first fetch or the cost of a cache miss; it only removes duplicates.",
      "A retry without a budget recreates the load that coalescing just removed.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "fifty-misses",
    question:
      "Fifty requests for the same key miss at the same moment. How many database queries run with process-local single-flight, and what does each caller receive?",
    difficulty: 3,
    hints: [
      "Count processes, not requests.",
      "The leader fetches; the others attach to the same result.",
    ],
    answer:
      "With process-local single-flight, each app instance runs at most one fetch for that key at a time, so the number of queries equals the number of instances that receive the miss, not fifty. The first caller on each instance becomes the leader and the rest attach to its result. If the instances share a Redis lock or a coalescing key, the fleet can collapse to one fetch, but that adds a round trip and lock failure modes. Each caller receives either the fetched value after waiting or the previous value if stale-while-revalidate is enabled. A failed fetch must be delivered to every waiter and the in-flight entry must be released.",
    followUps: [
      "What happens if the leader crashes after taking a distributed lock?",
      "How would you measure coalescing in production?",
      "Would you coalesce errors as well as successful values?",
    ],
    redFlags: [
      "Claims one query for the whole fleet with a process-local map.",
      "Ignores waiter timeout and error propagation.",
      "Holds a distributed lock for the entire request instead of the fetch.",
    ],
    rubric: [
      "Counts one in-flight fetch per process.",
      "Explains how waiters share the result.",
      "Distinguishes local and distributed coalescing.",
      "Defines the failure and timeout behavior.",
    ],
  },
  {
    id: "wait-or-stale",
    question:
      "When would you make callers wait for a coalesced fetch, and when would you serve stale data instead?",
    difficulty: 3,
    hints: [
      "Start from the product's freshness and latency budget.",
      "A stale serve still needs a bound and a refresh that can fail.",
    ],
    answer:
      "I would make callers wait when the value must be fresh for correctness, the fetch is reliably fast, and the request deadline can absorb it. I would serve stale when read latency matters more than a short freshness window, when the backend is already saturated, or when the value is advisory, such as a product recommendation or a catalog count. Stale-while-revalidate needs an explicit maximum age, a refresh deadline, and a fallback for a refresh that keeps failing. It also needs a way to bypass the stale value for reads that must observe a recent write. The choice is per key or per data class, not one global setting.",
    followUps: [
      "How do you prevent a stale value from surviving a failed refresh forever?",
      "Which reads must bypass stale data?",
      "How would you test the freshness bound?",
    ],
    redFlags: [
      "Serves stale data without a maximum age.",
      "Makes every read wait because the cache is easier to reason about.",
      "Treats freshness as only a cache configuration.",
    ],
    rubric: [
      "Ties the choice to a product freshness budget.",
      "Names the latency and backend effects.",
      "Bounds staleness and refresh failure.",
      "Identifies reads that cannot use stale data.",
    ],
  },
  {
    id: "failed-fetch",
    question:
      "How do you handle a slow or failed fetch inside a single-flight entry without stalling the request path?",
    difficulty: 4,
    hints: [
      "Every waiter is attached to one result.",
      "The entry must be released on every path, and the wait must be bounded.",
    ],
    answer:
      "I would give the fetch its own deadline and give the request path a separate, shorter deadline. Waiters select on the shared result, their request context, and a timer. On timeout, the leader cancels the fetch if the client supports it, releases the in-flight entry, and waiters receive a defined outcome: the last stale value if the product allows it, or a typed error. The release belongs in a finally block so a panic or cancellation cannot leave the key wedged. I would emit metrics for waiters, coalesced fetches, fetch failures, and stale serves, and I would make retries budgeted so a failed fetch does not immediately recreate the load.",
    followUps: [
      "What if the leader is cancelled but the database query keeps running?",
      "How do you avoid a cascade of retries after a timeout?",
      "Should a failed result be cached briefly to protect the backend?",
    ],
    redFlags: [
      "Leaves the in-flight entry held after an error.",
      "Has no request deadline separate from the fetch deadline.",
      "Retries every waiter independently.",
    ],
    rubric: [
      "Defines one shared result and a bounded wait.",
      "Releases the entry on success, error, and cancellation.",
      "Defines the fallback for waiters.",
      "Limits retries and measures failures.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every expensive cache miss has a per-key in-flight path with a release on all outcomes.",
      "Waiter deadlines are shorter than the request deadline and have a defined fallback.",
      "Stale-while-revalidate keys have a maximum age and an owner for the refresh path.",
      "Dashboards show backend queries, waiter count, coalesced fetches, and refresh failures.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm duplicate queries for one key before adding database capacity.",
      "Turn on coalescing for the affected key and every instance, not only the busiest one.",
      "If waiters cannot block, serve the last value and bound its age.",
      "Check whether retries or a shared-lock timeout are recreating the duplicate work.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify backend QPS, read p99, waiter latency, and refresh failures at peak.",
      "Remove temporary bypasses and reconcile the freshness bound with the product.",
      "Add a load test that expires the key under peak traffic and measures duplicate queries.",
      "Document which reads must bypass stale data.",
    ],
  },
];

const references = [
  {
    title: "singleflight package",
    url: "https://pkg.go.dev/golang.org/x/sync/singleflight",
    publisher: "Go project",
    kind: "docs" as const,
    note: "Per-process duplicate function call suppression and shared results.",
  },
  {
    title: "Redis cache-aside",
    url: "https://redis.io/docs/latest/develop/use-cases/cache-aside",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Cache-aside reads, miss handling, and stampede suppression.",
  },
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies",
    publisher: "Amazon Builders' Library",
    kind: "docs" as const,
    note: "Request coalescing and the risks of a cold or expiring cache.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "request-coalescing": {
      model: requestCoalescingModel,
      presets,
      instructions:
        "Mechanic: Concurrent requests with coalescing toggle; backend QPS. Start Healthy, apply No coalescing, then raise Single-flight coverage and switch Serve stale while refreshing. Watch backend QPS and waiter count, not only cache hit rate.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The fleet has 12 app instances, the database capacity is 900 QPS, and one hot key is missing. These are teaching values, not service limits. The break condition is all concurrent misses hit the database; recovery combines full coverage with a bounded stale fallback.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-cache-stampede",
    "caching-probabilistic-expiration",
    "caching-ttl-jitter",
    "caching-warming",
  ],
};
