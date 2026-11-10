import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 10,
    max: 1_000,
    step: 10,
    value: 300,
    unit: " req/s",
    group: "Workload",
    help: "Requests that need a pooled connection. This is the offered load, not the number of sessions held.",
    format: "rps" as const,
  },
  {
    id: "errorRate",
    label: "Requests taking an error path",
    min: 0,
    max: 50,
    step: 1,
    value: 2,
    unit: "%",
    group: "Workload",
    help: "Share of requests that fail validation, hit an exception, or enter a retry path. Leaks usually live on these paths.",
    format: "percent" as const,
  },
  {
    id: "leakOnErrorPct",
    label: "Error paths that leak",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Bug",
    help: "Share of error-path requests that never return their connection. 0 is a healthy close path; 50 leaks one in two errors.",
    format: "percent" as const,
  },
  {
    id: "poolSize",
    label: "Pool size",
    min: 10,
    max: 500,
    step: 10,
    value: 50,
    unit: " conns",
    group: "Pool",
    help: "Maximum connections the pool may hold open. A leak consumes this ceiling one session at a time.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rate: number;
  errorRate: number;
  leakPct: number;
  pool: number;
  normalActive: number;
  leakRate: number;
  leaked: number;
  active: number;
  utilization: number;
  waitMs: number;
  checkoutErrors: number;
  health: Health;
}

function compute(p: Params, leaked: number): Computed {
  const rate = Math.max(0, num(p, "requestRate", 300));
  const errorRate = clamp(num(p, "errorRate", 2), 0, 50);
  const leakPct = clamp(num(p, "leakOnErrorPct", 0), 0, 100);
  const pool = Math.max(1, Math.round(num(p, "poolSize", 50)));
  const normalActive = Math.min(pool, rate * 0.02);
  const leakRate = (rate * (errorRate / 100) * leakPct) / 100;
  const active = Math.min(pool, normalActive + leaked);
  const utilization = (active / pool) * 100;
  const exhausted = active >= pool;
  const overload = Math.max(0, leaked - (pool - normalActive));
  const waitMs = exhausted ? Math.min(60_000, 200 + overload * 20) : 5;
  const checkoutErrors = exhausted ? Math.min(100, 30 + overload * 0.05) : 0;
  const health: Health =
    utilization >= 95 || waitMs >= 2_000 || checkoutErrors >= 5
      ? "crit"
      : utilization >= 80 || waitMs >= 200 || checkoutErrors >= 1
        ? "warn"
        : "ok";
  return {
    rate,
    errorRate,
    leakPct,
    pool,
    normalActive,
    leakRate,
    leaked,
    active,
    utilization,
    waitMs,
    checkoutErrors,
    health,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["pool-utilization", values.utilization, 0.3],
    ["checkout-wait", values.waitMs, 0.3],
    ["leaked-connections", values.leaked, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, leaked: number, seed: number, t: number): SimFrame {
  const values = compute(p, leaked);
  const poolHealth: Health = values.health;
  return {
    t,
    nodes: [
      {
        id: "app",
        label: "Application",
        kind: "service",
        health: values.health,
        sublabel: `${Math.round(values.rate)} req/s · ${values.errorRate}% errors`,
        detail:
          "The application checks out a connection for each request. A code path that returns without closing the connection holds it until the process restarts or a leak detector intervenes.",
        meta: { view: "flow" },
      },
      {
        id: "pool",
        label: "Connection pool",
        kind: "db",
        role: "instance",
        health: poolHealth,
        utilization: clamp(values.utilization / 100),
        sublabel: `${Math.round(values.active)}/${values.pool} checked out`,
        detail: `${values.leaked.toFixed(0)} sessions are leaked and never returned. The pool has ${values.pool} slots, so a positive leak rate eventually consumes all of them.`,
        meta: { view: "flow", leaked: values.leaked, pool: values.pool },
      },
      {
        id: "db",
        label: "PostgreSQL",
        kind: "db",
        role: "primary",
        health: values.checkoutErrors >= 5 ? "warn" : "ok",
        sublabel: `${Math.round(values.active)} backends · CPU low`,
        detail:
          "The database is healthy: it has sessions, but they are idle rather than working. The bottleneck is the client pool, not database CPU.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-pool", "app", "pool", clamp(values.utilization / 100), values.health, "checkout"),
      edge("pool-db", "pool", "db", clamp(values.utilization / 100), "ok", "sessions"),
    ],
    metrics: [
      metric("pool-utilization", "Pool utilization", values.utilization, "%", 80, 95, "percent"),
      metric("checkout-wait", "Checkout wait", values.waitMs, " ms", 200, 2_000, "ms"),
      metric("leaked-connections", "Leaked connections", values.leaked, " conns", undefined, undefined, "count"),
      metric("checkout-errors", "Checkout errors", values.checkoutErrors, "%", 1, 5, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${Math.round(values.active)}/${values.pool} pooled connections checked out; ${values.leaked.toFixed(
      0,
    )} leaked; wait ${Math.round(values.waitMs)} ms; ${values.checkoutErrors.toFixed(1)}% checkout errors.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pool-utilization",
    metricId: "pool-utilization",
    warn: 80,
    crit: 95,
    title: "The connection pool is nearly exhausted",
    cause:
      "Connections are checked out and never returned, so the pool's free list shrinks even when request throughput is unchanged. The active count rises; the idle count falls.",
    fix:
      "Find the path that skips close, fix it with a finally block or a scoped resource, and restart the affected process to release the held sessions. Add leak detection with a stack trace.",
    checkFirst: [
      "Compare pool active and idle counts over time; active should track concurrency, not grow without bound.",
      "Check the error path and any early return that skips close.",
      "Check pg_stat_activity for idle sessions from the affected application.",
    ],
  },
  {
    id: "checkout-wait",
    metricId: "checkout-wait",
    warn: 200,
    crit: 2_000,
    title: "Requests are waiting for a pooled connection",
    cause:
      "Every slot is held by a leaked session, so new requests wait for a connection that never comes back. A longer checkout timeout only changes the error, not the leak.",
    fix:
      "Restore service by recycling the leaking process, then fix the close path. Keep a bounded checkout timeout so requests fail fast instead of queueing indefinitely.",
    checkFirst: [
      "Check whether wait time grows while database CPU stays low.",
      "Check which code path holds the sessions.",
      "Check whether a restart clears the pool and the symptom returns with the same error rate.",
    ],
  },
  {
    id: "checkout-errors",
    metricId: "checkout-errors",
    warn: 1,
    crit: 5,
    title: "Requests cannot acquire a connection",
    cause:
      "The pool is exhausted and the checkout timeout expires. The application reports pool timeouts while the database is reachable and mostly idle.",
    fix:
      "Do not raise the pool size as the first response; that only delays exhaustion. Fix the leak, recycle the process, and size the pool for real concurrency.",
    checkFirst: [
      "Check the error text: pool timeout versus database refusal.",
      "Check leaked connection count and process uptime.",
      "Check whether the leak rate follows a specific endpoint or error code.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const leakModel: SimModel = {
  id: "databases-connection-leak",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed, 0);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const t = frame.t + dt;
    const first = frame.flags.stateInit !== 1;
    const previousLeaked = first ? 0 : Number(frame.flags.leaked ?? 0);
    const provisional = compute(p, previousLeaked);
    const leaked = clamp(previousLeaked + provisional.leakRate * dt, 0, 1_000_000);
    const values = compute(p, leaked);
    const next = buildFrame(p, leaked, Number(frame.flags.seed ?? 20261110), t);
    next.flags = { ...frame.flags, ...next.flags, leaked, stateInit: 1 };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.checkoutErrors >= 5 && frame.flags.leakLogged !== 1) {
      pushEvent(next, {
        id: "pool-exhausted",
        at: t,
        severity: "crit",
        title: "Pool exhausted by leaked connections",
        detail: `${Math.round(values.leaked)} connections are held and never returned; ${Math.round(
          values.rate,
        )} req/s now waits ${Math.round(values.waitMs)} ms for a slot.`,
        nodeId: "pool",
        metricId: "pool-utilization",
      });
    }
    next.flags.leakLogged = values.checkoutErrors >= 5 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const leaked = frame.flags.stateInit === 1 ? Number(frame.flags.leaked ?? 0) : 0;
    const values = compute(p, leaked);
    return [
      `The leak rate is ${values.leakRate.toFixed(1)} connections/s: ${Math.round(values.rate)} req/s × ${values.errorRate}% errors × ${values.leakPct}% leaking errors.`,
      `${values.leaked.toFixed(0)} connections have leaked from a pool of ${values.pool}. Normal concurrency is only about ${Math.round(
        values.normalActive,
      )}, so the growth is not explained by traffic.`,
      "A checkout timeout frees the waiting request, not the leaked session. Without a fix or a process restart, the pool stays exhausted.",
      "Pool active and idle counts tell the story: active climbs toward the ceiling while idle falls, and database CPU can stay low because leaked sessions are not doing work.",
      "Leak detection with a stack trace turns a hunt into a code location. It costs a little overhead, so enable it when the leak rate is high or in a canary.",
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
    description: "Error paths close their connections; the pool holds only normal in-flight work.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Leak under load",
    description: "A small leak at high traffic consumes the pool over tens of seconds; utilization enters warning.",
    tone: "warn",
    elapsed: 20,
    params: defaults({ requestRate: 800, errorRate: 5, leakOnErrorPct: 10, poolSize: 120 }),
  },
  {
    id: "failure",
    label: "Error path leak",
    description: "Half of the error paths leak 20% of a 400 req/s workload; the pool exhausts within seconds.",
    tone: "crit",
    elapsed: 30,
    params: defaults({ requestRate: 400, errorRate: 20, leakOnErrorPct: 50, poolSize: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The close path is fixed; the leak rate is zero and the pool returns to normal concurrency.",
    tone: "ok",
    params: defaults({ requestRate: 300, errorRate: 2, leakOnErrorPct: 0, poolSize: 50 }),
  },
];

const experiment: Experiment = {
  id: "find-the-leak",
  title: "Pool exhausted with normal traffic",
  simId: "connection-leak",
  question:
    "The pool is exhausted and requests wait, but request rate is normal and database CPU is low. What is the most likely cause?",
  prediction: {
    options: [
      { id: "traffic", label: "A traffic spike used more connections than the pool allows." },
      { id: "cpu", label: "The database CPU is saturated, so queries hold their connections longer." },
      { id: "leak", label: "An error path checks out a connection and never returns it." },
      { id: "network", label: "Network latency increased the time each query holds a connection." },
    ],
    correctOptionId: "leak",
    explanation:
      "Normal request rate with a pool that fills over time points to connections that are never returned, not to concurrency. A traffic spike would raise request rate and then recede; CPU saturation would show high CPU and long queries. A leak grows the active count while idle falls, and the leaked sessions sit idle in the database.",
  },
  setup: defaults({ requestRate: 400, errorRate: 20, leakOnErrorPct: 50, poolSize: 60 }),
  runFor: 30,
  observe: [
    "The leak rate is 40 connections/s: 400 req/s × 20% errors × 50% leaking.",
    "The 60-slot pool is exhausted in under two seconds.",
    "Pool utilization reaches 100% while PostgreSQL CPU stays low.",
    "Checkout wait reaches the cap and checkout errors climb past 30%.",
  ],
  explain:
    "A pooled connection is borrowed from a free list and must be returned. An exception path that returns early without close leaves the session checked out forever. The pool eventually has no free slots, so every request waits or times out even though the database is healthy and the request rate never changed.",
  fix: defaults({ requestRate: 400, errorRate: 20, leakOnErrorPct: 0, poolSize: 60 }),
  debrief:
    "Fixing the close path drops the leak rate to zero. The pool returns to normal concurrency, wait falls to milliseconds, and checkout errors disappear. The fix has to cover every error path, including the ones added later, so leak detection and a scoped resource pattern matter as much as the one-line close.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A connection leak is a checked-out connection that is never returned to its pool. The application borrows a session, hits an error or an early return, and skips the close. The request ends; the session does not. Each leak consumes one pool slot permanently, so the pool eventually runs out even when traffic is steady.",
  },
  {
    type: "p",
    text: "The leak is on the client side, not in the database. PostgreSQL still sees a healthy backend; it is simply idle. A pool timeout rejects the waiting request after a configured interval, but it does not reclaim the leaked session. The only ways to get the slot back are to fix the code and release it, restart the process, or let a leak detector close it.",
  },
  {
    type: "p",
    text: "This is why the symptom is confusing. Request rate is normal, database CPU is low, and the pool is full. A capacity review would suggest a larger pool, which buys a little time but raises the number of sessions the leak can consume. The distribution of timeouts follows the error path, not the traffic curve.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application asks the pool for a connection, uses it, and returns it. The pool keeps a free list and a ceiling. When the free list is empty, requests wait until the checkout timeout. A leak removes entries from the free list without a corresponding return, so the pool's active count ratchets upward and its idle count ratchets down.",
  },
  {
    type: "table",
    headers: ["Signal", "Leak", "Traffic or capacity problem"],
    rows: [
      ["Request rate", "Normal or flat", "Rises with the incident"],
      ["Pool active", "Climbs and stays high", "Tracks concurrency and recedes"],
      ["Pool idle", "Falls toward zero", "Falls only while busy"],
      ["Database CPU", "Often low", "Usually high or I/O-bound"],
      ["After restart", "Symptom returns with the same path", "Symptom follows traffic"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pool utilization: warning at 80% and critical at 95% in this model.",
      "Checkout wait: warning at 200 ms and critical at 2 s as free slots disappear.",
      "Leaked connections: the count that never returns, which keeps rising until the process restarts.",
      "Checkout errors: pool timeouts while the database is reachable.",
      "A leak-share slider on the error path, which separates the bug from the traffic rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Error path leak. Read the leaked count and pool utilization before changing the pool size. Set the leak share to zero to see the fixed close path. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Pool sizes, rates, and thresholds are illustrative teaching values. Real pool behavior depends on the client library, checkout timeout, connection lifetime, and whether the application uses a scoped resource or a manual close.",
  },
  { type: "sim", simId: "connection-leak" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 400 requests per second, 20% of requests took an error path, and half of those paths leaked. That is 40 leaked connections per second. A 60-slot pool was exhausted in under two seconds. Pool utilization hit 100%, checkout wait reached the cap, and checkout errors passed 30%, while PostgreSQL CPU stayed low because the leaked sessions were idle.",
  },
  {
    type: "p",
    text: "Setting the leak share to zero fixed the growth. The pool returned to normal concurrency, and wait and errors fell to healthy values. The close path, not the pool size, was the binding constraint.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Pool metrics: active, idle, waiting, and creation rate; active climbing while idle falls is the leak signature.",
      "PostgreSQL pg_stat_activity: many idle sessions from the same application user, with old state-change times.",
      "Checkout timeout errors in application logs, often from one endpoint or error code.",
      "Process uptime and restart history: a restart that clears the pool and a symptom that returns is a strong signal.",
      "Leak-detection stack traces from the pool library, which point at the allocation site.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare pool active and idle counts over time. If active climbs while traffic is flat and database CPU is low, look for a close path that is skipped on errors. Restarting the process restores service but does not fix the bug; the leak returns with the same code path.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Restore service by recycling the leaking process or closing leaked sessions, and stop the error path if possible.",
      "Find the allocation site with pool leak detection and a stack trace.",
      "Fix the close path with a finally block, try-with-resources, or a scoped helper that cannot be skipped.",
      "Audit other error paths and early returns for the same pattern.",
      "Set a bounded checkout timeout so requests fail fast instead of waiting forever.",
      "Add an alert on leaked connections and a test that exercises the error path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger pool delays exhaustion but increases the number of sessions a leak can consume.",
      "A shorter checkout timeout fails faster but can reject requests during a legitimate burst.",
      "Leak detection adds overhead and log volume, but it is the fastest route to the allocation site.",
      "Restarting on a schedule masks the leak and causes recurring disruption; it is a stopgap, not a fix.",
      "Connection lifetime limits can recycle leaked sessions, but they also add churn and may interrupt long queries.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "leak-signature",
    question: "How do you tell a connection leak from a traffic spike?",
    difficulty: 2,
    hints: [
      "Traffic recedes; a leak does not.",
      "Compare active, idle, and request rate.",
    ],
    answer:
      "I would compare request rate, pool active, and pool idle over time. A traffic spike raises request rate and active together, then both recede. A leak raises active and lowers idle while request rate stays flat, and the active count does not come down after the burst. Database CPU is often low because leaked sessions are idle. A process restart that clears the pool and a symptom that returns is another strong signal.",
    followUps: [
      "Which pool metric is most diagnostic?",
      "What would pg_stat_activity show?",
      "How would you confirm the allocation site?",
    ],
    redFlags: [
      "Raises pool size first.",
      "Looks only at request rate.",
      "Ignores idle connections.",
    ],
    rubric: [
      "Compares active, idle, and rate.",
      "Notes persistence after the burst.",
      "Mentions idle database sessions.",
      "Uses restart behavior.",
    ],
  },
  {
    id: "timeout-myth",
    question: "Does a checkout timeout fix a connection leak?",
    difficulty: 2,
    hints: [
      "The waiter is not the holder.",
      "The leaked session is already checked out.",
    ],
    answer:
      "No. A checkout timeout bounds how long a request waits for a free connection, so it turns an indefinite wait into an error, but the leaked session is already checked out and is not returned by that timeout. The pool stays exhausted. To recover the slot, the holding process must close it or restart, or a leak detector must reclaim it. The timeout is a safety valve, not a repair.",
    followUps: [
      "What does a connection lifetime limit do?",
      "How would you fail fast without hiding the leak?",
      "What should the timeout alert on?",
    ],
    redFlags: [
      "Believes the timeout reclaims the connection.",
      "Raises the timeout to reduce errors.",
      "Confuses waiting with holding.",
    ],
    rubric: [
      "Separates waiting from holding.",
      "Says the slot is not reclaimed.",
      "Names restart or fix.",
      "Treats timeout as a valve.",
    ],
  },
  {
    id: "prevent-recurrence",
    question: "How do you prevent the next leak after fixing this one?",
    difficulty: 3,
    hints: [
      "Make close impossible to skip.",
      "Detect growth before exhaustion.",
    ],
    answer:
      "I would make connection handling scoped so every path returns the resource, and add a lint or test that exercises error paths. I would enable pool leak detection in canary or at a sampling rate and alert on leaked-connection growth and on active-versus-idle divergence. I would also keep a bounded checkout timeout and a lifetime limit as backstops, and review new code that adds early returns.",
    followUps: [
      "What would the alert threshold be?",
      "How would you test the error path?",
      "Why is a lifetime limit not the primary fix?",
    ],
    redFlags: [
      "Relies only on code review.",
      "Adds a bigger pool.",
      "Ignores error paths.",
    ],
    rubric: [
      "Uses scoped resources.",
      "Adds detection and alerting.",
      "Tests error paths.",
      "Keeps backstops.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every connection checkout uses a scoped resource or a guaranteed close.",
      "Pool active, idle, waiting, and checkout timeout are charted.",
      "Leak detection is available and sampled in canary or on demand.",
      "A bounded checkout timeout and connection lifetime are configured.",
      "An alert fires on leaked-connection growth, not only on pool saturation.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare request rate with active and idle pool counts.",
      "Check pg_stat_activity for idle sessions from the application user.",
      "Recycle the leaking process to restore service.",
      "Find the allocation site with a stack trace before changing pool size.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix every error path that can skip close and add a regression test.",
      "Verify the leak rate stays zero under the same error mix.",
      "Tune the pool from measured concurrency, not from the incident peak.",
      "Record the time to exhaustion and the detection that found it.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Connections and Authentication",
    url: "https://www.postgresql.org/docs/current/runtime-config-connection.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Connection limits, backend creation, and why idle sessions still consume server resources.",
  },
  {
    title: "PostgreSQL: Monitoring Database Activity",
    url: "https://www.postgresql.org/docs/current/monitoring-stats.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "pg_stat_activity states, including idle and idle-in-transaction sessions, used to find held connections.",
  },
  {
    title: "Amazon RDS Proxy connection management",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-managing.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How a managed pool holds and reuses sessions, and why client pool behavior still matters.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "connection-leak": {
      model: leakModel,
      presets,
      instructions:
        "Start healthy, apply Error path leak, and read leaked connections before pool size. Set the leak share to zero to see the fixed close path. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Request rates, pool sizes, and thresholds are teaching values, not library defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-file-descriptors",
    "foundations-connection-pools",
    "databases-max-connections",
    "databases-pgbouncer",
  ],
};
