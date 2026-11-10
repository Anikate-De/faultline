import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const OPEN_TIMEOUT_MS = 30_000;

const params = [
  {
    id: "taskCount",
    label: "Service tasks",
    min: 1,
    max: 200,
    step: 1,
    value: 20,
    unit: " tasks",
    group: "Topology",
    help: "Independent service instances, each with its own pool. Total database connections multiply by this number.",
    format: "count" as const,
  },
  {
    id: "poolSize",
    label: "Pool size per task",
    min: 1,
    max: 50,
    step: 1,
    value: 12,
    unit: " conns",
    group: "Pool",
    help: "Maximum connections one task may hold. This is a concurrency limit, not a throughput target.",
    format: "count" as const,
  },
  {
    id: "rpsPerTask",
    label: "Requests per task",
    min: 1,
    max: 300,
    step: 1,
    value: 40,
    unit: " rps",
    group: "Traffic",
    help: "Queries per second handled by one task. Query concurrency follows Little's Law from rate and time.",
    format: "rps" as const,
  },
  {
    id: "queryMs",
    label: "Query time",
    min: 1,
    max: 100,
    step: 1,
    value: 8,
    unit: " ms",
    group: "Traffic",
    help: "Database execution time per query, excluding pool wait. This is what the database itself reports.",
    format: "ms" as const,
  },
  {
    id: "dbMaxConnections",
    label: "Database max connections",
    min: 50,
    max: 5_000,
    step: 50,
    value: 500,
    unit: " conns",
    group: "Database",
    help: "Hard connection limit on the database or proxy. Every task pool competes for this total.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tasks: number;
  poolSize: number;
  loadPerTask: number;
  utilization: number;
  waitMs: number;
  p99Ms: number;
  connectionsPerTask: number;
  totalConnections: number;
  maxSessions: number;
  dbUtilization: number;
  queryMs: number;
}

function compute(p: Params): Computed {
  const tasks = Math.max(1, Math.round(num(p, "taskCount", 20)));
  const poolSize = Math.max(1, Math.round(num(p, "poolSize", 12)));
  const rpsPerTask = num(p, "rpsPerTask", 40);
  const queryMs = num(p, "queryMs", 8);
  const dbMax = Math.max(10, num(p, "dbMaxConnections", 500));

  const loadPerTask = (rpsPerTask * queryMs) / 1_000;
  const utilization = Math.min(150, (loadPerTask / poolSize) * 100);
  const rho = loadPerTask / poolSize;
  const waitMs =
    rho < 1
      ? queryMs * 0.5 * (rho / Math.max(0.01, 1 - rho))
      : OPEN_TIMEOUT_MS;
  const p99Ms = Math.min(90_000, 3 * waitMs);
  const connectionsPerTask = Math.max(
    1,
    Math.min(poolSize, Math.ceil(Math.min(loadPerTask, poolSize)) + 1),
  );
  const totalConnections = tasks * connectionsPerTask;
  const maxSessions = tasks * poolSize;
  return {
    tasks,
    poolSize,
    loadPerTask,
    utilization,
    waitMs,
    p99Ms,
    connectionsPerTask,
    totalConnections,
    maxSessions,
    dbUtilization: Math.min(150, (maxSessions / dbMax) * 100),
    queryMs,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const waitHealth = values.p99Ms >= 500 ? "crit" : values.p99Ms >= 100 ? "warn" : "ok";
  const dbHealth =
    values.dbUtilization >= 90 ? "crit" : values.dbUtilization >= 75 ? "warn" : "ok";
  const poolHealth =
    values.utilization >= 90 ? "crit" : values.utilization >= 70 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "Service tasks",
        kind: "service",
        health: poolHealth,
        utilization: clamp(values.utilization / 100),
        throughput: values.tasks * num(p, "rpsPerTask", 40),
        sublabel: `${values.tasks} pools × ${values.poolSize}`,
        detail: `Each task runs its own pool. Pool concurrency demand is ${values.loadPerTask.toFixed(1)} queries; the pool has ${values.poolSize} slots.`,
        meta: { view: "flow", utilization: values.utilization },
      },
      {
        id: "pool",
        label: "Connection pool",
        kind: "queue",
        health: waitHealth,
        utilization: clamp(values.utilization / 100),
        sublabel: `${values.p99Ms >= 500 ? "queueing" : "fast acquire"}`,
        detail: "A request that finds no idle connection waits in the pool queue. Acquisition wait is invisible to the database's own execution time.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Database",
        kind: "db",
        health: dbHealth,
        utilization: clamp(values.dbUtilization / 100),
        throughput: values.tasks * num(p, "rpsPerTask", 40),
        capacity: values.maxSessions,
        sublabel: `${Math.round(values.maxSessions).toLocaleString()} max sessions`,
        detail: `Each open connection is a session with memory and scheduling cost. The maximum is tasks × pool size (${Math.round(values.maxSessions).toLocaleString()}); observed demand is ${Math.round(values.totalConnections).toLocaleString()} sessions.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("service-pool", "service", "pool", clamp(values.utilization / 100), poolHealth),
      edge("pool-db", "pool", "db", clamp(values.dbUtilization / 100), dbHealth),
    ],
    metrics: [
      metric("pool-wait-p99", "Pool wait p99", values.p99Ms, "ms", 100, 500, "ms"),
      metric("pool-utilization", "Pool utilization", values.utilization, "%", 70, 90, "percent"),
      metric("db-connection-util", "DB session capacity used", values.dbUtilization, "%", 75, 90, "percent"),
      metric("db-max-sessions", "Max DB sessions", values.maxSessions, " conns", undefined, undefined, "count"),
      metric("db-connections", "DB sessions demanded", values.totalConnections, " conns", undefined, undefined, "count"),
      metric("query-concurrency", "Queries per task", values.loadPerTask, " queries", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Pool wait p99 ${values.p99Ms.toFixed(0)}ms; pool ${values.utilization.toFixed(0)}% utilized; ${Math.round(values.totalConnections)} sessions demanded of ${Math.round(values.maxSessions)} max.`,
  };
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 9)) / 3.2);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, item.value * jitter(index + item.id.length)),
    );
  }
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pool-wait",
    metricId: "pool-wait-p99",
    warn: 100,
    crit: 500,
    title: "Requests are waiting for a pooled connection",
    cause:
      "Query concurrency exceeds the pool size. Each task's pool is a queue: once all connections are busy, new queries wait, and the wait grows nonlinearly as utilization approaches one.",
    fix:
      "Size the pool from measured concurrency, reduce query time, or add capacity at the database. A larger pool helps only if the database can absorb the extra sessions.",
    checkFirst: [
      "Compare pool acquisition time with database execution time.",
      "Check pool active, idle, and waiting counts per task.",
      "Check whether query time rose or only the wait rose.",
    ],
  },
  {
    id: "pool-utilization",
    metricId: "pool-utilization",
    warn: 70,
    crit: 90,
    title: "The pool has no spare concurrency",
    cause:
      "Pool utilization is at or above the point where queueing dominates. At 100% the pool is fully occupied and wait time is bounded only by timeouts.",
    fix:
      "Add pool capacity if the database has headroom, or reduce per-task concurrency with fewer tasks, faster queries, or a multiplexing proxy.",
    checkFirst: [
      "Check whether all tasks are equally loaded or one task is hot.",
      "Check database CPU and connection limits together.",
      "Check whether the pool leaks connections on error paths.",
    ],
  },
  {
    id: "db-connections",
    metricId: "db-connection-util",
    warn: 75,
    crit: 90,
    title: "The database connection limit is the next ceiling",
    cause:
      "Maximum sessions equal tasks multiplied by pool size. A pool size that is safe for one task becomes unsafe when the service scales out.",
    fix:
      "Lower the per-task pool size, reduce task count, or add a proxy that multiplexes many client connections onto fewer database sessions. Verify that session state still works.",
    checkFirst: [
      "Multiply task count by pool size and compare the maximum with the database limit.",
      "Check the database's max_connections and reserved superuser connections.",
      "Check whether autoscaling changed the task count.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const poolModel: SimModel = {
  id: "foundations-connection-pools",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    const values = compute(p);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.5, 0.5);
    next.metrics = next.metrics.map((item) =>
      item.id === "pool-wait-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.utilization >= 90 && frame.flags.poolWarned !== 1) {
      pushEvent(next, {
        id: "pool-wait",
        at: frame.t,
        severity: "warn",
        title: "Pool acquisition wait is rising",
        detail: `${values.loadPerTask.toFixed(1)} concurrent queries compete for ${values.poolSize} connections per task. Pool utilization is ${values.utilization.toFixed(0)}% and acquisition p99 is ${Math.round(values.p99Ms).toLocaleString()}ms.`,
        nodeId: "pool",
        metricId: "pool-wait-p99",
      });
      next.flags.poolWarned = 1;
    }
    if (values.utilization < 80) next.flags.poolWarned = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `Pool wait p99 ${values.p99Ms.toFixed(0)}ms; pool ${values.utilization.toFixed(0)}% utilized; ${Math.round(values.totalConnections)} sessions demanded of ${Math.round(values.maxSessions)} max.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${values.loadPerTask.toFixed(1)} concurrent queries per task need ${Math.ceil(values.loadPerTask)} connections on average; the pool allows ${values.poolSize}.`,
    );
    if (values.utilization >= 90) {
      items.push(
        `Pool utilization is ${values.utilization.toFixed(0)}%, so acquisition p99 is ${Math.round(values.p99Ms).toLocaleString()}ms while the database still executes in ${values.queryMs}ms.`,
      );
    } else {
      items.push(
        `Acquisition p99 is ${values.p99Ms.toFixed(0)}ms, close to the ${values.queryMs}ms execution time.`,
      );
    }
    items.push(
      `${values.tasks} tasks × ${values.poolSize} pool slots = ${Math.round(values.maxSessions)} maximum sessions; observed demand is ${Math.round(values.totalConnections)}, and the database limit is sized against the maximum.`,
    );
    if (values.dbUtilization >= 90) {
      items.push(
        "The database limit, not the pool, is now the bottleneck; adding pool size will cause connection errors.",
      );
    }
    items.push(
      `The pool is ${values.utilization.toFixed(0)}% utilized; a continuous queue estimate is used, so wait rises smoothly rather than jumping at a threshold.`,
    );
    items.push(
      "A transaction-pooling proxy can multiplex many clients onto few sessions, but session-scoped features such as prepared statements, temporary tables, and LISTEN need care.",
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
    description: "Short queries, a small pool, and ample database connection headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Longer queries and high per-task traffic push the pool into the knee.",
    tone: "warn",
    params: defaults({ taskCount: 20, poolSize: 8, rpsPerTask: 250, queryMs: 25 }),
  },
  {
    id: "failure",
    label: "Pool too small",
    description: "Query concurrency exceeds the pool; wait dominates while the database is only 64% connected.",
    tone: "crit",
    params: defaults({ taskCount: 40, poolSize: 8, rpsPerTask: 200, queryMs: 50 }),
  },
  {
    id: "db-limit",
    label: "Too many sessions",
    description: "A sensible pool multiplied by many tasks exceeds the database connection limit.",
    tone: "crit",
    params: defaults({ taskCount: 150, poolSize: 12, rpsPerTask: 100, queryMs: 30, dbMaxConnections: 500 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Pool sized to concurrency, shorter queries, and total sessions inside the database limit.",
    tone: "ok",
    params: defaults({ taskCount: 40, poolSize: 9, rpsPerTask: 120, queryMs: 20, dbMaxConnections: 500 }),
  },
];

const experiment: Experiment = {
  id: "predict-pool-wait",
  title: "Where did the two seconds go?",
  simId: "pool",
  question:
    "The application reports three-second query latency, but the database reports 25ms of execution time. Where is the rest of the time?",
  prediction: {
    options: [
      { id: "pool", label: "Waiting to acquire a pooled connection" },
      { id: "db", label: "Inside the database, hidden by sampling" },
      { id: "network", label: "Network round trips between service and database" },
      { id: "locks", label: "Lock contention inside the database" },
    ],
    correctOptionId: "pool",
    explanation:
      "Database execution time starts when the query reaches a connection. If the pool has no free connection, the request waits in the client-side pool queue first. That wait is invisible in database metrics and can dominate the request even when the database is healthy.",
  },
  setup: defaults({ taskCount: 30, poolSize: 5, rpsPerTask: 198, queryMs: 25, dbMaxConnections: 500 }),
  runFor: 20,
  observe: [
    "Pool wait p99 is seconds while query time stays at 25ms.",
    "Pool utilization is near 100%; the database connection count is only 30% of its limit.",
    "The database looks healthy on CPU and execution time.",
    "Adding pool capacity and reducing query time removes the wait without changing the database.",
  ],
  explain:
    "A pool is a queue in front of the database. Concurrency demand is request rate multiplied by query time; when that exceeds pool size, requests wait. Measuring only database execution time or CPU hides the queue. Instrument acquisition time separately and compare it with execution time before resizing anything.",
  fix: defaults({ taskCount: 30, poolSize: 12, rpsPerTask: 150, queryMs: 15, dbMaxConnections: 500 }),
  debrief:
    "The recovered run holds acquisition near the query time: observed demand is about 160 of 500 database sessions, while the configured maximum is 360. The tradeoff is that the maximum, not the observed demand, must stay inside the database limit when the task count scales out.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A connection pool is a bounded set of reusable database connections owned by one process. A request borrows a connection, runs its query, and returns it. If all connections are busy, the request waits in a queue until one frees or a timeout fires. Pool size is therefore a concurrency limit. It does not make the database faster; it decides how many queries may be in flight and how long the rest wait.",
  },
  {
    type: "p",
    text: "Query concurrency follows Little's Law: concurrency equals arrival rate multiplied by time in the system. If one task handles 200 queries per second and each takes 50ms, about 10 queries are in flight on average. A pool of 8 cannot serve that demand, so requests queue even though the database is not saturated. A pool of 20 serves it with headroom, but 40 tasks times 20 connections is 800 database sessions, which may exceed the database limit.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is request, service task, pool queue, database session, then query execution. The pool sits inside each task, so the fleet-wide total is per-task pool size multiplied by the number of tasks. That multiplication is the trap during autoscaling: a pool that is safe at 10 tasks can exhaust the database at 100. A multiplexing proxy sits between the pools and the database and maps many client connections onto fewer server sessions, but it can break session-scoped state.",
  },
  {
    type: "table",
    headers: ["Approach", "What it bounds", "Main tradeoff"],
    rows: [
      ["Per-task pool", "Concurrency in one task", "Total sessions multiply with task count"],
      ["Global database limit", "Total sessions", "One noisy service can starve another"],
      ["Transaction-pooling proxy", "Server sessions across clients", "Session state may not survive between transactions"],
      ["Session-pinning proxy", "Server sessions with state", "Less multiplexing; pinning can recreate the limit"],
    ],
  },
  {
    type: "p",
    text: "The simulation models 1–200 service tasks, 1–50 connections per pool, and a database limit of 50–5,000 sessions. Query times and wait estimates are illustrative teaching values, not PostgreSQL benchmarks. The shape is the lesson: pool wait grows nonlinearly near full utilization, and total sessions grow linearly with task count.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pool wait p99: time spent waiting for a connection, warning at 100ms and critical at 500ms.",
      "Pool utilization: active connections divided by pool size, warning at 70% and critical at 90%.",
      "DB session capacity used: tasks × poolSize compared with the database limit.",
      "Max DB sessions and demanded sessions: the worst-case pool total and the observed demand.",
      "Queries per task: the concurrency demand that the pool must serve.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Pool too small. Notice that database utilization stays low while pool wait explodes. Apply Too many sessions to see the opposite failure. Run the experiment before reading its explanation, then apply Recovery.",
  },
  {
    type: "compare",
    leftTitle: "Pool wait",
    rightTitle: "Database execution",
    rows: [
      { label: "Where it appears", left: "Client acquisition metric", right: "Database query metric" },
      { label: "Scales with", left: "Concurrency versus pool size", right: "Query plan, data, and load" },
      { label: "Database CPU", left: "Can be low", right: "Usually elevated" },
      { label: "Fix", left: "Size pool or reduce concurrency", right: "Tune query or add database capacity" },
    ],
  },
  { type: "sim", simId: "pool" },
  { type: "experiment", experimentId: "predict-pool-wait" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Per-task query concurrency exceeded the pool size, so requests waited before they ever reached the database. The database executed each query quickly and its connection count was well below the limit, which made it look innocent. Pool wait grew nonlinearly as utilization crossed the knee, and request latency was dominated by a queue the database never saw.",
  },
  {
    type: "p",
    text: "The recovery matched pool size to concurrency and reduced query time. In the second failure, the pool was reasonable per task but the task count multiplied sessions past the database limit. Both failures are pool-sizing problems in opposite directions: too small waits, too large multiplies sessions and contention.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Pool metrics: active, idle, waiting, acquisition time, and timeout counts per task. HikariCP, pgxpool, and most clients expose these.",
      "Database: `pg_stat_activity` connection count, `max_connections`, and wait events; high session count with low CPU points to too many idle or waiting sessions.",
      "Traces: a client span for connection acquisition before the database span. If acquisition is long and the query span is short, the pool is the queue.",
      "Autoscaling events: task count changes that multiply total sessions without a database limit change.",
      "Errors: pool acquisition timeouts, `too many clients already`, or connection reset by the database.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare pool acquisition time with database execution time. If acquisition dominates and the database is healthy, size the pool. If database connections are near the limit, adding pool capacity will make the incident worse.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Instrument acquisition time separately from query execution time.",
      "Compute per-task concurrency from request rate and query time.",
      "Set pool size above measured concurrency with bounded headroom, not to the database maximum.",
      "Multiply by peak task count and keep the total below the database limit with failover headroom.",
      "Reduce query time or add a multiplexing proxy when the database limit is the constraint.",
      "Load-test at peak task count and verify acquisition, execution, total sessions, and errors together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger pool reduces wait but increases database sessions, memory, and contention.",
      "A smaller pool protects the database but turns transient query slowness into client-visible queueing.",
      "A transaction-pooling proxy reduces server sessions but breaks session state that spans transactions.",
      "More tasks improve availability but multiply pool totals unless the pool size shrinks as the fleet grows.",
      "Aggressive acquisition timeouts fail fast but can turn a brief queue into errors and retries.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-pool-wait",
    question:
      "The application reports two-second query latency, but the database reports 20ms execution. How do you prove the pool is the bottleneck?",
    difficulty: 2,
    hints: [
      "Execution time starts after acquisition.",
      "Compare active and waiting counts.",
    ],
    answer:
      "I would measure connection acquisition time in the client and compare it with the database query span. If acquisition is seconds and execution is milliseconds, the pool is the queue. I would check active, idle, and waiting counts per task, plus pool utilization, and confirm the database connection count is below its limit. I would also check for a leak or a long-running transaction holding a connection. The proof is the gap between request latency and database execution, attributed to a client-side wait.",
    followUps: [
      "What would make the database execution time look artificially low?",
      "How does a connection leak appear in pool metrics?",
      "Why can adding pool size make things worse?",
    ],
    redFlags: [
      "Tunes the database before checking acquisition.",
      "Uses average latency only.",
      "Ignores waiting counts.",
    ],
    rubric: [
      "Separates acquisition from execution.",
      "Names pool metrics.",
      "Checks the database limit.",
      "Considers leaks.",
    ],
  },
  {
    id: "size-pool",
    question:
      "A service has 40 tasks, the database allows 500 connections, and each task handles 150 queries per second at 20ms. What pool size do you choose and why?",
    difficulty: 3,
    hints: [
      "Compute per-task concurrency first.",
      "Reserve room for failover and other services.",
    ],
    answer:
      "Per-task concurrency is 150 multiplied by 0.02, which is 3 queries in flight on average. A pool of 6 gives roughly 2x headroom for bursts. Forty tasks times 6 is 240 connections, leaving 260 of the 500 for failover, migrations, and other services. A pool of 12 would use 480 and leave almost nothing. I would verify the burst distribution and set an acquisition timeout, then measure waiting and timeouts at peak. If the database has plenty of CPU, the pool can be larger, but the fleet-wide total is the constraint.",
    followUps: [
      "How does autoscaling to 80 tasks change the answer?",
      "What if query time doubles during a batch job?",
      "When would you choose a proxy instead?",
    ],
    redFlags: [
      "Sets pool size to the database limit divided by tasks without headroom.",
      "Ignores concurrency math.",
      "Forgets failover capacity.",
    ],
    rubric: [
      "Uses Little's Law.",
      "Multiplies by task count.",
      "Leaves headroom.",
      "Verifies at peak.",
    ],
  },
  {
    id: "pool-or-proxy",
    question:
      "When would you add a connection proxy instead of increasing pool sizes? What does it cost?",
    difficulty: 4,
    hints: [
      "The database session limit is the constraint.",
      "Session state decides which pooling mode works.",
    ],
    answer:
      "I would use a proxy when many clients or tasks need more concurrency than the database can accept as sessions, especially with serverless or highly elastic workloads. A transaction-pooling proxy maps many client connections onto fewer server sessions, so the database sees a stable count. The cost is session-state loss: prepared statements, temporary tables, advisory locks, and LISTEN/NOTIFY may not survive between transactions, and some drivers need configuration changes. A session-pinning proxy preserves state but multiplexes less. I would also account for the proxy as a new failure domain and for its own connection limits and failover behavior.",
    followUps: [
      "Which PostgreSQL features break under transaction pooling?",
      "How does the proxy affect failover time?",
      "What metrics would you watch on the proxy?",
    ],
    redFlags: [
      "Assumes all pooling modes are transparent.",
      "Ignores the proxy as a failure domain.",
      "Adds a proxy without checking driver compatibility.",
    ],
    rubric: [
      "Names the session-limit constraint.",
      "Distinguishes pooling modes.",
      "Names stateful features at risk.",
      "Includes proxy capacity and failover.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Pool acquisition time and query execution time are separate metrics.",
      "Pool size is derived from measured concurrency, not a copy of the database limit.",
      "The fleet-wide total is checked at peak task count with failover headroom.",
      "Acquisition timeouts and leak detection are configured on every pool.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare acquisition with execution before changing pool size.",
      "Check active, idle, and waiting counts per task.",
      "Check database session count and max_connections together.",
      "If the database limit is the ceiling, reduce sessions rather than adding pool capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Load-test at peak task count and verify acquisition, execution, and session totals.",
      "Recompute pool size after query or traffic changes.",
      "Check that autoscaling policy accounts for connection multiplication.",
      "Document the proxy or pool mode and its session-state limits.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL connection and authentication settings",
    url: "https://www.postgresql.org/docs/current/runtime-config-connection.html",
    publisher: "PostgreSQL",
    kind: "docs" as const,
    note: "max_connections and per-connection resource behavior.",
  },
  {
    title: "About pool sizing",
    url: "https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing",
    publisher: "HikariCP",
    kind: "docs" as const,
    note: "Why small pools often serve high concurrency, and how queueing applies.",
  },
  {
    title: "Amazon RDS Proxy",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connection pooling, multiplexing, and session pinning.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    pool: {
      model: poolModel,
      presets,
      instructions:
        "Start healthy, then make the pool too small. Compare pool wait with database execution, then apply Too many sessions to see the opposite failure.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Query times and waits are teaching values, not a database benchmark.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-queueing-knee",
    "databases-connection-leak",
    "caching-connection-pool",
  ],
};
