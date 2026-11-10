import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ACTIVE_SHARE = 0.1;
const DB_MAX_CONNECTIONS = 800;

const params = [
  {
    id: "appTasks",
    label: "Application tasks",
    min: 50,
    max: 400,
    step: 10,
    value: 200,
    unit: " tasks",
    group: "Clients",
    help: "Application processes or tasks, each with its own connection pool.",
    format: "count" as const,
  },
  {
    id: "connectionsPerTask",
    label: "Connections per task",
    min: 1,
    max: 20,
    step: 1,
    value: 20,
    unit: " conns",
    group: "Clients",
    help: "Maximum client connections each task opens. The model multiplies this by the task count.",
    format: "count" as const,
  },
  {
    id: "poolSize",
    label: "PgBouncer pool size",
    min: 20,
    max: 1_000,
    step: 20,
    value: 400,
    unit: " conns",
    group: "PgBouncer",
    help: "Maximum server connections PgBouncer opens to PostgreSQL for this user and database.",
    format: "count" as const,
  },
  {
    id: "transactionPooling",
    label: "Transaction pooling",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Mode",
    help: "1 returns a server connection to the pool after each transaction. 0 is session pooling, which holds it until the client disconnects.",
    format: "count" as const,
  },
  {
    id: "sessionStateShare",
    label: "Session-state traffic",
    min: 0,
    max: 100,
    step: 1,
    value: 0,
    unit: "%",
    group: "Application",
    help: "Share of requests that depend on state surviving between statements, such as SQL-level prepared statements, SET, temporary tables, or session advisory locks.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tasks: number;
  perTask: number;
  clients: number;
  active: number;
  poolSize: number;
  dbMax: number;
  transactionPooling: boolean;
  sessionStateShare: number;
  demand: number;
  server: number;
  waitMs: number;
  dbUtil: number;
  refused: number;
  failShare: number;
  appHealth: Health;
  poolerHealth: Health;
  dbHealth: Health;
}

function compute(p: Params): Computed {
  const tasks = clamp(Math.round(num(p, "appTasks", 200)), 50, 400);
  const perTask = clamp(Math.round(num(p, "connectionsPerTask", 20)), 1, 20);
  const poolSize = Math.max(1, Math.round(num(p, "poolSize", 400)));
  const dbMax = DB_MAX_CONNECTIONS;
  const transactionPooling = num(p, "transactionPooling", 1) >= 0.5;
  const sessionStateShare = clamp(num(p, "sessionStateShare", 0), 0, 100);
  const clients = tasks * perTask;
  const active = clients * ACTIVE_SHARE;
  const demand = transactionPooling ? active : clients;
  const server = Math.min(poolSize, demand);
  const waitMs = demand <= poolSize ? 0 : Math.min(2_000, 100 * (demand / poolSize - 1));
  const dbUtil = clamp((server / dbMax) * 100, 0, 100);
  const refused = Math.max(0, server - dbMax);
  const failShare = transactionPooling ? sessionStateShare : 0;
  const appHealth: Health =
    failShare >= 5 || refused > 0 ? "crit" : failShare > 0 || waitMs >= 100 ? "warn" : "ok";
  const poolerHealth: Health = waitMs >= 250 || failShare >= 5 ? "crit" : waitMs >= 100 || failShare > 0 ? "warn" : "ok";
  const dbHealth: Health = dbUtil >= 95 || refused > 0 ? "crit" : dbUtil >= 80 ? "warn" : "ok";
  return {
    tasks,
    perTask,
    clients,
    active,
    poolSize,
    dbMax,
    transactionPooling,
    sessionStateShare,
    demand,
    server,
    waitMs,
    dbUtil,
    refused,
    failShare,
    appHealth,
    poolerHealth,
    dbHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.6);
  const rows: [string, number, number][] = [
    ["client-connections", values.clients, 1],
    ["server-connections", values.server, 1],
    ["db-util", values.dbUtil, 0.3],
    ["pool-wait", values.waitMs, 1],
    ["session-failures", values.failShare, 0.1],
    ["refused", values.refused, 0.2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      value <= 0 ? 0 : Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, flags: SimFrame["flags"] = {}): SimFrame {
  const values = compute(p);
  const mode = values.transactionPooling ? "transaction pooling" : "session pooling";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application fleet",
        kind: "service",
        health: values.appHealth,
        utilization: clamp(values.failShare / 100),
        sublabel: `${formatCount(values.tasks)} tasks × ${values.perTask} = ${formatCount(values.clients)} clients`,
        detail: `Each task keeps up to ${values.perTask} client connections. The model assumes about ${Math.round(
          ACTIVE_SHARE * 100,
        )}% are active at once, so transaction pooling needs fewer server connections than session pooling.`,
        meta: { view: "flow" },
      },
      {
        id: "pgbouncer",
        label: `PgBouncer · ${mode}`,
        kind: "mesh",
        health: values.poolerHealth,
        utilization: clamp(values.waitMs / 1_000),
        sublabel: `${formatCount(values.server)} of ${formatCount(values.poolSize)} server conns · ${Math.round(
          values.waitMs,
        )}ms wait`,
        detail: values.transactionPooling
          ? "The server connection returns to the pool when the transaction ends. Session state does not follow the client to the next transaction."
          : "The server connection stays with the client until it disconnects. That preserves session state but cannot multiplex many idle clients onto a small pool.",
        meta: { view: "flow" },
      },
      {
        id: "postgres",
        label: "PostgreSQL · primary",
        kind: "db",
        role: "primary",
        health: values.dbHealth,
        utilization: clamp(values.dbUtil / 100),
        sublabel: `${Math.round(values.dbUtil)}% of ${formatCount(values.dbMax)} · ${formatCount(values.refused)} refused`,
        detail: `The database sees the server connections PgBouncer opens, not the client connections. Its max_connections limit still applies, and direct clients or administrators also consume slots.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-pooler", "app", "pgbouncer", 1, values.appHealth, "client connections"),
      edge("pooler-db", "pgbouncer", "postgres", clamp(values.server / Math.max(1, values.clients)), values.dbHealth, "server connections"),
    ],
    metrics: [
      metric("client-connections", "Client connections", values.clients, "", undefined, undefined, "count"),
      metric("server-connections", "Server connections", values.server, "", undefined, undefined, "count"),
      metric("db-util", "Database connection use", values.dbUtil, "%", 80, 95, "percent"),
      metric("pool-wait", "Pool wait", values.waitMs, "ms", 100, 250, "ms"),
      metric("session-failures", "Session-state failures", values.failShare, "%", 1, 5, "percent"),
      metric("refused", "Refused connections", values.refused, "", 1, 100, "count"),
    ],
    events: [],
    series: {},
    flags: { ...flags, seed },
    summary: `${formatCount(values.clients)} clients to ${formatCount(values.server)} server connections; database at ${Math.round(
      values.dbUtil,
    )}%; pool wait ${Math.round(values.waitMs)}ms; session-state failures ${Math.round(values.failShare)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "db-util",
    metricId: "db-util",
    warn: 80,
    crit: 95,
    title: "PgBouncer is consuming the database connection budget",
    cause:
      "The pool is allowed to open more server connections than the database can comfortably serve. PgBouncer protects the database only if its pool is smaller than the database limit, with room for administrators and direct clients.",
    fix:
      "Lower the pool size, raise the database limit only with memory and CPU evidence, or move direct clients behind the pool. Leave headroom rather than sizing the pool to the exact limit.",
    checkFirst: [
      "Compare the pool size with max_connections and the current direct-client connections.",
      "Check PostgreSQL memory and worker usage per connection, not just the count.",
      "Check whether session pooling is forcing one server connection per client.",
    ],
  },
  {
    id: "pool-wait",
    metricId: "pool-wait",
    warn: 100,
    crit: 250,
    title: "Clients are queueing for a PgBouncer server connection",
    cause:
      "Demand for server connections is above the pool size. In transaction pooling this means more concurrent transactions than the pool can serve; in session pooling it means connected clients are holding every slot.",
    fix:
      "Raise the pool only if the database has headroom, shorten transactions, reduce the client fleet, or switch to transaction pooling where the application allows it. Do not hide a long transaction behind a larger queue.",
    checkFirst: [
      "Check SHOW POOLS for cl_waiting and the pool's maxwait.",
      "Check whether long-running or idle-in-transaction sessions are holding server connections.",
      "Check whether the application pool is opening more clients than the workload needs.",
    ],
  },
  {
    id: "session-failures",
    metricId: "session-failures",
    warn: 1,
    crit: 5,
    title: "Transaction pooling is breaking session state",
    cause:
      "A server connection is returned to the pool after each transaction. SQL-level prepared statements, SET, LISTEN, session advisory locks, and some temporary-table behavior do not survive on the next connection.",
    fix:
      "Keep the session on one connection, rewrite the session state to be transaction-scoped, or use protocol-level prepared statements with PgBouncer's max_prepared_statements. Session pooling is correct only when the connection count allows it.",
    checkFirst: [
      "Check for prepared statement, SET, or advisory-lock errors that began with the pooling change.",
      "Check whether the driver uses protocol-level or SQL-level prepared statements.",
      "Check whether the pool mode is transaction or session for this database and user.",
    ],
  },
  {
    id: "refused",
    metricId: "refused",
    warn: 1,
    crit: 100,
    title: "PostgreSQL is refusing PgBouncer server connections",
    cause:
      "The pool or session demand exceeds the database connection limit. PgBouncer cannot create the server connection, so clients wait or fail even though they reached the pooler.",
    fix:
      "Reduce the pool size or client count, add database headroom, or move to transaction pooling. Reserve connection slots for administration and failover.",
    checkFirst: [
      "Check PostgreSQL logs for too many connections or remaining connection slots errors.",
      "Compare max_connections with the pool size and direct connections.",
      "Check whether a failover or restart has temporarily reduced capacity.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return {
    ...Object.fromEntries(params.map((param) => [param.id, param.value])),
    ...overrides,
  };
}

export const pgbouncerModel: SimModel = {
  id: "databases-pgbouncer",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.flags);
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];

    if (values.failShare > 0 && frame.flags.sessionBrokenLogged !== 1) {
      pushEvent(next, {
        id: "session-state-broken",
        at: frame.t,
        severity: values.failShare >= 5 ? "crit" : "warn",
        title: "Transaction pooling broke a session assumption",
        detail: `${Math.round(
          values.failShare,
        )}% of requests depend on state that does not survive a transaction boundary. The database connection count is not the cause.`,
        nodeId: "pgbouncer",
        metricId: "session-failures",
      });
    }
    if (values.waitMs >= 100 && frame.flags.poolWaitLogged !== 1) {
      pushEvent(next, {
        id: "pool-queue",
        at: frame.t,
        severity: values.waitMs >= 250 ? "crit" : "warn",
        title: "Clients are waiting for a pool slot",
        detail: `Demand is ${formatCount(values.demand)} server connections against a pool of ${formatCount(
          values.poolSize,
        )}. Pool wait is ${Math.round(values.waitMs)}ms.`,
        nodeId: "pgbouncer",
        metricId: "pool-wait",
      });
    }
    if (values.refused > 0 && frame.flags.refusedLogged !== 1) {
      pushEvent(next, {
        id: "connections-refused",
        at: frame.t,
        severity: "crit",
        title: "PostgreSQL refused server connections",
        detail: `${formatCount(values.refused)} server connections exceed the ${formatCount(
          values.dbMax,
        )} connection budget. PgBouncer is protecting the wrong limit.`,
        nodeId: "postgres",
        metricId: "refused",
      });
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      sessionBrokenLogged: values.failShare > 0 ? 1 : 0,
      poolWaitLogged: values.waitMs >= 100 ? 1 : 0,
      refusedLogged: values.refused > 0 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `${formatCount(values.clients)} client connections become ${formatCount(
        values.server,
      )} server connections in ${values.transactionPooling ? "transaction" : "session"} pooling.`,
      values.transactionPooling
        ? `About ${Math.round(ACTIVE_SHARE * 100)}% of clients are active at once in this model, so the pool is sized against active transactions rather than connected clients.`
        : "Session pooling holds a server connection for each connected client, so the pool size becomes a hard cap on concurrent clients, not just active transactions.",
    ];
    if (values.failShare > 0) {
      items.push(
        `${Math.round(
          values.failShare,
        )}% of requests use session state that transaction pooling does not preserve. Increasing the pool does not fix this.`,
      );
    }
    if (values.waitMs > 0) {
      items.push(
        `Clients wait ${Math.round(values.waitMs)}ms for a server connection. Check SHOW POOLS and whether long transactions are holding slots.`,
      );
    }
    if (values.refused > 0) {
      items.push(
        `${formatCount(values.refused)} server connections exceed the database budget. The pool is larger than the database can accept.`,
      );
    }
    items.push("A pool protects the database only when its size fits inside max_connections with headroom.");
    return items;
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
    description: "4,000 client connections share 400 server connections in transaction mode. The database is at 50%, with no wait.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak clients",
    description: "8,000 clients produce 800 active transactions against a 400-connection pool. Wait reaches the warning line.",
    tone: "warn",
    params: defaults({ appTasks: 400, poolSize: 400 }),
  },
  {
    id: "failure",
    label: "Session state breaks",
    description: "Transaction pooling is on and 15% of requests need session state. They fail even though the database is only at 50%.",
    tone: "crit",
    params: defaults({ sessionStateShare: 15 }),
  },
  {
    id: "recovery",
    label: "Transaction-scoped app",
    description: "The application stops relying on session state. Transaction pooling fits the same clients into 400 server connections.",
    tone: "ok",
    params: defaults({ sessionStateShare: 0, poolSize: 500 }),
  },
  {
    id: "session-pooling",
    label: "Session pooling",
    description: "Session pooling holds a server connection per client. With 4,000 clients and a 1,000-connection pool, clients queue and 200 server connections exceed the 800-connection database budget.",
    tone: "crit",
    params: defaults({ transactionPooling: 0, poolSize: 1_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-session-break",
  title: "Predict what transaction pooling breaks",
  simId: "pgbouncer-pool",
  question:
    "The pool has 400 server connections, the database is at 50% of its connection limit, and 20% of requests use session state. Transaction pooling is on. Why do those requests fail?",
  prediction: {
    options: [
      { id: "prepared-state", label: "Their session state does not survive the transaction boundary." },
      { id: "db-limit", label: "The database has no connection slots left." },
      { id: "pool-wait", label: "They wait longer than the pool timeout." },
      { id: "network", label: "PgBouncer cannot multiplex PostgreSQL protocol traffic." },
    ],
    correctOptionId: "prepared-state",
    explanation:
      "Transaction pooling returns the server connection to the pool when the transaction ends. A later statement can land on a different connection, so SQL-level prepared statements, SET, LISTEN, temporary-table state, and session advisory locks are not guaranteed. The database connection count is fine; the session assumption is not.",
  },
  setup: defaults({ transactionPooling: 1, sessionStateShare: 20, poolSize: 400 }),
  runFor: 20,
  observe: [
    "Session-state failures reach 20% and the critical threshold.",
    "The database connection use stays at 50%, so the failure is not max_connections.",
    "The pool wait stays at zero because the pool has enough server connections.",
    "The application and pooler nodes turn critical while PostgreSQL stays healthy.",
    "Switching to session pooling preserves state but replaces the failure with queueing.",
  ],
  explain:
    "PgBouncer in transaction mode multiplexes many clients onto fewer server connections by returning a connection after every transaction. That is the feature that reduces connection count, and it is also the reason session state cannot be assumed. Increasing the pool does not help because the problem is not capacity. The application must either become transaction-scoped, use protocol-level prepared statements with max_prepared_statements, or use session pooling with enough server connections.",
  fix: defaults({ transactionPooling: 1, sessionStateShare: 0, poolSize: 400 }),
  debrief:
    "Removing the session-state dependency makes transaction pooling safe at the same 400-connection pool and 50% database use. Session pooling would also preserve state, but it needs a server connection per connected client: 4,000 clients cannot fit in a 1,000-connection pool. The cheapest correct fix is usually application cooperation, not a larger pool.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "PgBouncer is a lightweight connection pooler for PostgreSQL. Applications connect to PgBouncer, and PgBouncer keeps a smaller set of server connections open to PostgreSQL. A client connection can be cheap while a database connection is expensive: each PostgreSQL backend consumes memory and a process or worker slot, and max_connections caps the total. Pooling reduces the number of server connections without reducing the number of clients that can be connected.",
  },
  {
    type: "p",
    text: "The pool mode decides when a server connection returns to the pool. Session pooling holds it until the client disconnects, so every connected client needs a server connection and all PostgreSQL session features work. Transaction pooling returns it when the transaction ends, which multiplexes many clients onto fewer connections, but breaks features that expect the connection to persist. Statement pooling returns it after each statement and disallows multi-statement transactions.",
  },
  {
    type: "p",
    text: "Transaction pooling is the usual choice for a large web fleet, and it is also where most incidents start. PgBouncer's own feature table lists what breaks: SET and RESET, LISTEN, WITH HOLD cursors, SQL-level PREPARE and DEALLOCATE, PRESERVE ROWS temporary tables, LOAD, and session-level advisory locks. Protocol-level prepared statements are supported in transaction mode when max_prepared_statements is non-zero; PgBouncer then tracks and re-prepares them on whichever server connection is used.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application pool, PgBouncer, PostgreSQL. There are now two pools, not one. The application pool decides how many client connections exist; PgBouncer decides how many server connections reach the database. If both are sized to the database limit, the database can still be oversubscribed. Size the application pool for concurrency, size PgBouncer for the database's safe connection budget, and leave headroom for administration and direct clients.",
  },
  {
    type: "compare",
    leftTitle: "Session pooling",
    rightTitle: "Transaction pooling",
    rows: [
      { label: "Server connection held", left: "Until the client disconnects", right: "Until the transaction ends" },
      { label: "Multiplexing", left: "Limited: one server connection per client", right: "Many clients share a small pool" },
      { label: "Session state", left: "Preserved", right: "Not guaranteed across transactions" },
      { label: "Prepared statements", left: "All forms work", right: "Protocol-level with max_prepared_statements; SQL PREPARE does not" },
      { label: "Typical failure", left: "Queueing or connection exhaustion", right: "Session-state errors under load" },
    ],
  },
  {
    type: "p",
    text: "PgBouncer is single-threaded per process. A large fleet may need several PgBouncer instances, and the pool size is per user and database pair by default. That means the total server connections can be larger than one pool number suggests. Check max_db_connections, max_client_conn, and the per-pool settings together rather than reading one number as the global budget.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Client connections and server connections side by side, so multiplexing is visible.",
      "Database connection use against max_connections, including refused server connections.",
      "Pool wait: the time clients spend queueing for a server connection.",
      "Session-state failure share: requests that depend on state transaction pooling does not preserve.",
      "A pooling-mode switch, which trades connection count for session compatibility.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Session state breaks and confirm the database is not near its limit. Then switch to Session pooling to see the opposite failure: state works, but 4,000 clients cannot fit through a 1,000-connection pool. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Task counts, the 10% active-client assumption, pool sizes, wait times, and database limits are illustrative teaching values. PgBouncer defaults such as max_client_conn 100, default_pool_size 20, and query_wait_timeout 120 seconds are real defaults, but your production values depend on the workload.",
  },
  { type: "sim", simId: "pgbouncer-pool" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet had 4,000 client connections and about 400 active transactions. Transaction pooling mapped them onto 400 server connections, so the database sat at 50% of its 800-connection budget and pool wait stayed at zero. Then 20% of requests used session state. Because the server connection changes after each transaction, those requests failed. The database was healthy; the pooling mode was not compatible with the application.",
  },
  {
    type: "p",
    text: "Switching to session pooling fixed the state problem but changed the capacity problem. Four thousand connected clients needed four thousand server connections to avoid queueing. A 1,000-connection pool left 3,000 clients waiting, and 200 server connections exceeded the 800-connection database budget. The same fleet cannot be solved by changing only the pool mode.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "PgBouncer admin console: SHOW POOLS for cl_active, cl_waiting, sv_active, sv_idle, and maxwait; SHOW STATS for query and wait totals.",
      "PostgreSQL: pg_stat_activity connection count and state, plus max_connections and superuser_reserved_connections.",
      "Application errors: prepared statement does not exist, cached plan must not change result type, SET or advisory-lock state missing on the next statement.",
      "PgBouncer logs and metrics: connection refusals, pool wait, and the pool mode for the affected database and user.",
      "Deployment history: the failure usually begins when transaction pooling is enabled or when a new driver starts using server-side prepared statements.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the pool mode before increasing the pool. If the database has headroom and clients are still failing with prepared-statement or session errors, the problem is compatibility, not capacity. If clients are queueing, check whether long transactions or session pooling are holding server connections.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Name the failing feature: SQL-level prepared statement, SET, LISTEN, temporary table, or advisory lock. A generic pool increase does not fix any of them.",
      "Make session state transaction-scoped where possible. Set it at the start of each transaction and do not rely on the next transaction inheriting it.",
      "For protocol-level prepared statements, enable and size max_prepared_statements. SQL-level PREPARE and DEALLOCATE are still forwarded and are not tracked.",
      "If the application cannot change, use session pooling and size the pool for connected clients. Check that the database can accept that many connections before promising it.",
      "Size PgBouncer below max_connections with headroom. Account for every pool, direct client, administrator, and failover reserve.",
      "Watch pool wait and server connection use together. A large pool can protect latency while still exhausting the database.",
      "Test the pooling mode with the real driver and ORM. Some frameworks use prepared statements or session settings that are invisible in application code.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Transaction pooling scales connections but requires application cooperation and driver awareness.",
      "Session pooling preserves all PostgreSQL behavior but does not multiplex connected clients.",
      "A larger pool reduces wait but consumes database memory and can make failover recovery slower.",
      "Statement pooling is the most aggressive mode and disallows multi-statement transactions.",
      "PgBouncer adds a hop and a component to operate; it does not remove the need to size max_connections.",
      "Protocol-level prepared statement tracking adds memory and CPU overhead per server connection.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-mode",
    question: "How do you choose between session pooling and transaction pooling for a PostgreSQL application?",
    difficulty: 3,
    hints: [
      "Start from what the application expects between statements.",
      "Connection count and session state pull in opposite directions.",
    ],
    answer:
      "I would inventory the session features first: SQL-level prepared statements, SET, LISTEN, temporary tables, advisory locks, and cursors. If any are used across transaction boundaries, transaction pooling will break them unless the application or driver is changed. Protocol-level prepared statements can work with max_prepared_statements. If the application is transaction-scoped and the fleet is large, transaction pooling is the better fit because it multiplexes many clients onto a small pool. If the application depends on session state and the client count is small enough, session pooling is simpler and safer. The decision is compatibility first, connection count second.",
    followUps: [
      "What changes if the driver uses server-side prepared statements?",
      "How would you test the mode before production?",
      "What does statement pooling add?",
    ],
    redFlags: [
      "Chooses transaction pooling only because it uses fewer connections.",
      "Assumes all prepared statements break.",
      "Ignores the database connection limit.",
    ],
    rubric: [
      "Inventories session features.",
      "Names protocol-level prepared statement support.",
      "Connects mode choice to client count.",
      "Tests with the real driver.",
    ],
  },
  {
    id: "size-pool",
    question:
      "200 application tasks each open 20 connections, and PostgreSQL allows 500 connections. How do you size PgBouncer?",
    difficulty: 3,
    hints: [
      "Client connections and server connections are different populations.",
      "Do not size the pool to the exact database limit.",
    ],
    answer:
      "The fleet has 4,000 client connections, but that is not the server connection requirement. I would measure concurrent active transactions, because transaction pooling only needs a server connection while a transaction is running. If about 10% are active, that is roughly 400 server connections. I would set the PgBouncer pool below 500 with headroom for administration and direct clients, and I would keep the application pool from opening more clients than it needs. I would verify with SHOW POOLS and PostgreSQL connection metrics, then load-test the queue. I would not set the pool to 500 just because max_connections is 500.",
    followUps: [
      "What would make you choose session pooling instead?",
      "How much headroom would you keep?",
      "What if the active share is 40% instead of 10%?",
    ],
    redFlags: [
      "Sets the pool to 4,000.",
      "Sets the pool to 500 with no headroom.",
      "Ignores concurrency and assumes every client is active.",
    ],
    rubric: [
      "Separates client and server connections.",
      "Uses concurrent transactions.",
      "Keeps database headroom.",
      "Plans to verify with SHOW POOLS and metrics.",
    ],
  },
  {
    id: "prepared-statement-error",
    question:
      "After enabling transaction pooling, the application starts failing with prepared statement errors. What do you check, and what are your options?",
    difficulty: 4,
    hints: [
      "SQL-level PREPARE and protocol-level prepared statements behave differently.",
      "PgBouncer can track protocol-level statements on the server connection.",
    ],
    answer:
      "I would first identify whether the driver uses SQL-level PREPARE and EXECUTE or protocol-level prepared statements. SQL-level statements are forwarded to PostgreSQL and are not tracked by PgBouncer, so they break when the next transaction lands on a different server connection. Protocol-level statements can be supported by setting max_prepared_statements to a non-zero value, which makes PgBouncer track and re-prepare them. I would also check for SET, LISTEN, temporary tables, or advisory locks. The options are to enable protocol-level tracking, rewrite the session state to be transaction-scoped, use session pooling, or disable server-side prepared statements in the driver. I would reproduce with the real driver before changing production.",
    followUps: [
      "What does max_prepared_statements cost?",
      "Why can cached plan must not change result type appear?",
      "Which option would you try first and why?",
    ],
    redFlags: [
      "Raises the pool size.",
      "Says all prepared statements are unsupported.",
      "Changes the pool mode without checking the driver.",
    ],
    rubric: [
      "Distinguishes SQL-level from protocol-level statements.",
      "Names max_prepared_statements.",
      "Checks other session features.",
      "Tests with the real driver.",
    ],
  },
];

const checklist = [
  {
    title: "Before enabling PgBouncer",
    items: [
      "The application's session-state dependencies are inventoried, including driver-level prepared statements.",
      "The database connection budget includes PgBouncer, direct clients, administrators, and failover reserve.",
      "The pool mode is tested with the real driver and ORM under load.",
      "query_wait_timeout and client login timeouts are aligned with application timeouts.",
      "PgBouncer admin console access and metrics collection are in place.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Check SHOW POOLS for waiting clients, active server connections, and maxwait.",
      "Check PostgreSQL connection count and max_connections before changing the pool.",
      "Check whether the failure began with a pool-mode or driver change.",
      "Check for session-state errors before assuming a capacity problem.",
      "Record the pool mode, pool size, and client count in the timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix or explicitly accept every session-state dependency.",
      "Size the pool from measured concurrency, not from the client count.",
      "Add an alert for pool wait and server connection saturation.",
      "Keep a tested rollback path to session pooling for compatibility incidents.",
    ],
  },
];

const references = [
  {
    title: "PgBouncer features",
    url: "https://www.pgbouncer.org/features.html",
    publisher: "PgBouncer",
    kind: "docs" as const,
    note: "Session, transaction, and statement pooling, plus the SQL feature compatibility table.",
  },
  {
    title: "PgBouncer configuration",
    url: "https://www.pgbouncer.org/config.html",
    publisher: "PgBouncer",
    kind: "docs" as const,
    note: "pool_mode, default_pool_size, max_client_conn, max_db_connections, query_wait_timeout, and max_prepared_statements.",
  },
  {
    title: "PostgreSQL: Connections and Authentication",
    url: "https://www.postgresql.org/docs/current/runtime-config-connection.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "max_connections, superuser_reserved_connections, and per-connection resource behavior.",
  },
  {
    title: "PgBouncer FAQ",
    url: "https://www.pgbouncer.org/faq.html",
    publisher: "PgBouncer",
    kind: "docs" as const,
    note: "Common questions about pooling modes, prepared statements, and connection reuse.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "pgbouncer-pool": {
      model: pgbouncerModel,
      presets,
      instructions:
        "Start healthy, then apply Session state breaks. Compare the database connection use with the session failure share. Switch to Session pooling to see the capacity tradeoff.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Pool sizes, the 10% active-client share, the fixed 800-connection database budget, and wait times are teaching inputs, not PgBouncer limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-max-connections",
    "databases-rds-proxy",
    "databases-read-replica-routing",
    "databases-connection-storm",
  ],
};
