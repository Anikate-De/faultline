import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const STEADY_CAPACITY = 6_000;
const FAILOVER_CAPACITY = 3_000;
const RECONNECT_WINDOW_S = 2;

const params = [
  {
    id: "clients",
    label: "Client connections",
    min: 500,
    max: 10_000,
    step: 100,
    value: 2_000,
    unit: " conns",
    group: "Clients",
    help: "Application connections across the fleet. Without a proxy, each one is also a database connection.",
    format: "count" as const,
  },
  {
    id: "proxy",
    label: "RDS Proxy",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "1 puts RDS Proxy between the application and the writer. 0 connects the application pool directly to the database endpoint.",
    format: "count" as const,
  },
  {
    id: "poolSize",
    label: "Proxy pool size",
    min: 50,
    max: 5_000,
    step: 50,
    value: 500,
    unit: " conns",
    group: "Proxy",
    help: "Database connections the proxy keeps for this target. This is the population that reconnects to a new writer.",
    format: "count" as const,
  },
  {
    id: "failover",
    label: "Database failover",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 models a writer failover in progress. The replacement writer has fewer connection slots until it warms up.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  clients: number;
  proxy: boolean;
  poolSize: number;
  failover: boolean;
  dbConnections: number;
  capacity: number;
  dbUtil: number;
  refused: number;
  reconnect: number;
  appHealth: Health;
  proxyHealth: Health;
  writerHealth: Health;
}

function compute(p: Params): Computed {
  const clients = clamp(Math.round(num(p, "clients", 2_000)), 500, 10_000);
  const proxy = num(p, "proxy", 1) >= 0.5;
  const poolSize = clamp(Math.round(num(p, "poolSize", 500)), 50, 5_000);
  const failover = num(p, "failover", 0) >= 0.5;
  const dbConnections = proxy ? Math.min(poolSize, clients) : clients;
  const capacity = failover ? FAILOVER_CAPACITY : STEADY_CAPACITY;
  const dbUtil = clamp((dbConnections / capacity) * 100, 0, 100);
  const refused = Math.max(0, dbConnections - capacity);
  const reconnect = failover ? dbConnections / RECONNECT_WINDOW_S : 0;
  const appHealth: Health =
    refused >= 100 ? "crit" : refused > 0 ? "warn" : failover && reconnect >= 500 ? "warn" : "ok";
  const proxyHealth: Health = proxy
    ? refused > 0
      ? "crit"
      : reconnect >= 500
        ? "warn"
        : "ok"
    : "ok";
  const writerHealth: Health =
    refused > 0 || dbUtil >= 95 ? "crit" : dbUtil >= 80 ? "warn" : "ok";
  return {
    clients,
    proxy,
    poolSize,
    failover,
    dbConnections,
    capacity,
    dbUtil,
    refused,
    reconnect,
    appHealth,
    proxyHealth,
    writerHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.7);
  const rows: [string, number, number][] = [
    ["writer-util", values.dbUtil, 0.3],
    ["refused", values.refused, 0.2],
    ["reconnect", values.reconnect, 2],
    ["db-connections", values.dbConnections, 1],
    ["client-connections", values.clients, 1],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      value <= 0 ? 0 : Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, flags: SimFrame["flags"] = {}): SimFrame {
  const values = compute(p);
  const path = values.proxy ? "proxy endpoint" : "direct database endpoint";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application fleet",
        kind: "service",
        health: values.appHealth,
        utilization: clamp(values.reconnect / 3_000),
        sublabel: `${formatCount(values.clients)} clients · ${path}`,
        detail: values.proxy
          ? "The application connects to the proxy endpoint. During a writer failover, idle client connections stay open and only in-flight transactions are canceled."
          : "The application pool connects directly to the writer. When the writer fails, every pooled connection breaks and the fleet reconnects at once.",
        meta: { view: "flow" },
      },
      {
        id: "proxy",
        label: values.proxy ? "RDS Proxy" : "RDS Proxy · bypassed",
        kind: "mesh",
        health: values.proxyHealth,
        utilization: clamp(values.reconnect / 3_000),
        sublabel: values.proxy
          ? `${formatCount(values.dbConnections)} database conns · ${formatCount(values.reconnect)} reconnects/s`
          : "not in the path",
        detail: values.proxy
          ? "The proxy multiplexes client sessions onto a pool and follows the writer endpoint. It absorbs DNS propagation, local DNS caching, and connection timeouts during failover."
          : "No proxy is in the path. The application must resolve the writer endpoint and rebuild its own connections.",
        meta: { view: "flow" },
      },
      {
        id: "writer",
        label: values.failover ? "Writer · replacement during failover" : "Writer · current primary",
        kind: "db",
        role: "primary",
        health: values.writerHealth,
        utilization: clamp(values.dbUtil / 100),
        sublabel: `${Math.round(values.dbUtil)}% of ${formatCount(values.capacity)} slots · ${formatCount(
          values.refused,
        )} refused`,
        detail: values.failover
          ? `The model gives the replacement writer ${formatCount(
              values.capacity,
            )} connection slots in this state. A failover replacement warms up with less capacity than the steady-state fleet, so the reconnect population matters.`
          : `The model gives the steady-state writer ${formatCount(
              values.capacity,
            )} connection slots. The application demand must fit this budget even without a failover.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-proxy", "app", "proxy", values.proxy ? 1 : 0.1, values.appHealth, "client connections"),
      edge("proxy-writer", "proxy", "writer", values.proxy ? 1 : 0, values.writerHealth, "pooled connections"),
      edge("app-writer", "app", "writer", values.proxy ? 0 : 1, values.writerHealth, "direct connections"),
    ],
    metrics: [
      metric("client-connections", "Client connections", values.clients, "", undefined, undefined, "count"),
      metric("db-connections", "Database connections", values.dbConnections, "", undefined, undefined, "count"),
      metric("writer-util", "Writer connection use", values.dbUtil, "%", 80, 95, "percent"),
      metric("refused", "Refused connections", values.refused, "", 1, 100, "count"),
      metric("reconnect", "Reconnect attempts", values.reconnect, " conn/s", 500, 2_000, "rps"),
    ],
    events: [],
    series: {},
    flags: { ...flags, seed },
    summary: `${values.proxy ? "Proxy" : "Direct"}: ${formatCount(values.clients)} clients, ${formatCount(
      values.dbConnections,
    )} database connections; writer at ${Math.round(values.dbUtil)}%; ${formatCount(
      values.refused,
    )} refused; ${formatCount(values.reconnect)} reconnects/s.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "writer-util",
    metricId: "writer-util",
    warn: 80,
    crit: 95,
    title: "The replacement writer is out of connection slots",
    cause:
      "Every client or pooled connection that reconnects after failover consumes a slot on the new writer. The replacement has less capacity than the steady-state fleet, so a pool sized to the old writer can fill it immediately.",
    fix:
      "Put RDS Proxy in front of the writer, set MaxConnectionsPercent with headroom, and keep the proxy pool below the failover-time capacity. Leave room for administration and direct clients.",
    checkFirst: [
      "Compare DatabaseConnections with MaxDatabaseConnectionsAllowed on the proxy.",
      "Check whether the reconnect burst is from clients or from the proxy pool.",
      "Check the writer's max_connections and memory after the failover.",
    ],
  },
  {
    id: "refused",
    metricId: "refused",
    warn: 1,
    crit: 100,
    title: "The new writer is refusing connections",
    cause:
      "Reconnect demand is above the replacement writer's limit. Refused clients retry, which increases the attempt rate and can keep the writer saturated even after it becomes available.",
    fix:
      "Reduce the reconnect population with RDS Proxy, add jittered backoff, and size the pool to the post-failover capacity. Do not solve a connection storm by raising max_connections without checking memory.",
    checkFirst: [
      "Check DatabaseConnectionsSetupFailed and the database's too many connections errors.",
      "Check whether clients retry immediately with no jitter.",
      "Check whether the proxy pool or direct clients dominate the connection count.",
    ],
  },
  {
    id: "reconnect",
    metricId: "reconnect",
    warn: 500,
    crit: 2_000,
    title: "Reconnect attempts are arriving faster than the writer can accept them",
    cause:
      "All clients detect the broken writer at the same time. Without a proxy, the full client population reconnects; with a proxy, only the pool does. Aggressive retries add attempts even after the writer is healthy.",
    fix:
      "Use RDS Proxy to absorb the client population, add exponential backoff with jitter, and cap retries. Warm capacity before the failover when the change is planned.",
    checkFirst: [
      "Check whether the attempt rate rises again after the writer becomes available.",
      "Check client retry policy and connection pool validation settings.",
      "Check whether the proxy pool is larger than the writer can serve during warmup.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const rdsProxyModel: SimModel = {
  id: "databases-rds-proxy",
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

    if (values.failover && values.refused > 0 && !values.proxy && frame.flags.stormLogged !== 1) {
      pushEvent(next, {
        id: "failover-reconnect-storm",
        at: frame.t,
        severity: "crit",
        title: "Failover triggered a reconnect storm",
        detail: `${formatCount(values.clients)} direct client connections broke and reconnected at once. ${formatCount(
          values.refused,
        )} exceeded the replacement writer's ${formatCount(values.capacity)} slots.`,
        nodeId: "writer",
        metricId: "refused",
      });
    }
    if (values.failover && values.refused > 0 && values.proxy && frame.flags.poolTooLargeLogged !== 1) {
      pushEvent(next, {
        id: "proxy-pool-too-large",
        at: frame.t,
        severity: "crit",
        title: "The proxy pool is larger than the new writer",
        detail: `RDS Proxy reconnects its pool of ${formatCount(
          values.dbConnections,
        )}, but the replacement writer accepts ${formatCount(values.capacity)}. The proxy adds a hop, not database capacity.`,
        nodeId: "proxy",
        metricId: "refused",
      });
    }
    if (values.failover && values.proxy && values.refused === 0 && frame.flags.proxyHeldLogged !== 1) {
      pushEvent(next, {
        id: "proxy-held-connections",
        at: frame.t,
        severity: "info",
        title: "RDS Proxy held the client connections",
        detail: `The proxy kept ${formatCount(values.clients)} client connections and reconnected only ${formatCount(
          values.dbConnections,
        )} database connections. In-flight transactions are still canceled.`,
        nodeId: "proxy",
        metricId: "db-connections",
      });
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      stormLogged: values.failover && values.refused > 0 && !values.proxy ? 1 : 0,
      poolTooLargeLogged: values.failover && values.refused > 0 && values.proxy ? 1 : 0,
      proxyHeldLogged: values.failover && values.proxy && values.refused === 0 ? 1 : 0,
    };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The application has ${formatCount(values.clients)} client connections; the database sees ${formatCount(
        values.dbConnections,
      )}. ${values.proxy ? "RDS Proxy is multiplexing the difference." : "There is no proxy, so the populations are equal."}`,
      values.failover
        ? `The replacement writer has ${formatCount(values.capacity)} connection slots in this model. Reconnect demand is ${formatCount(
            values.dbConnections,
          )}.`
        : "No failover is in progress. The steady-state writer has more connection slots than the current demand.",
    ];
    if (values.refused > 0) {
      items.push(
        `${formatCount(values.refused)} connections are refused. Retries can increase the attempt rate even after the writer is available.`,
      );
    } else {
      items.push("No connections are refused in this state.");
    }
    items.push(
      values.proxy
        ? "The proxy preserves idle client connections during failover. It does not preserve an in-flight transaction."
        : "Without a proxy, every client pool must rebuild its own connections, and each one resolves the writer endpoint independently.",
    );
    items.push("The proxy pool must fit the replacement writer, not the steady-state writer.");
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
    description: "2,000 clients share a 500-connection proxy pool. The writer is at 8% of its steady-state capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Failover at peak",
    description: "8,000 clients and a 2,400-connection pool reconnect to a warming writer. Connections fit, but the attempt rate and utilization are in warning.",
    tone: "warn",
    params: defaults({ clients: 8_000, poolSize: 2_400, failover: 1 }),
  },
  {
    id: "failure",
    label: "Direct reconnect storm",
    description: "6,000 direct clients reconnect to a writer with 3,000 slots. Half the connections are refused and retries add load.",
    tone: "crit",
    params: defaults({ clients: 6_000, proxy: 0, failover: 1 }),
  },
  {
    id: "recovery",
    label: "Proxy absorbs the storm",
    description: "The same 6,000 clients go through a 600-connection proxy pool. The writer is at 20% and no connection is refused.",
    tone: "ok",
    params: defaults({ clients: 6_000, proxy: 1, poolSize: 600, failover: 1 }),
  },
  {
    id: "proxy-limits",
    label: "Proxy pool too large",
    description: "A 3,600-connection pool is larger than the replacement writer's 3,000 slots. The proxy reconnects the storm it was meant to absorb.",
    tone: "crit",
    params: defaults({ clients: 8_000, proxy: 1, poolSize: 3_600, failover: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-reconnect-storm",
  title: "Predict the failover connection storm",
  simId: "rds-proxy-failover",
  question:
    "6,000 clients connect directly to the writer. The writer fails over to a replacement with 3,000 connection slots. What happens when every client reconnects?",
  prediction: {
    options: [
      { id: "half-refused", label: "About 3,000 connections are refused, and retries add more attempts." },
      { id: "all-fit", label: "All 6,000 connections fit because the old writer had 6,000 slots." },
      { id: "dns-only", label: "Nothing happens until the DNS TTL expires, then every connection succeeds." },
      { id: "proxy-queues", label: "RDS Proxy queues the connections and the writer accepts all 6,000." },
    ],
    correctOptionId: "half-refused",
    explanation:
      "The replacement writer accepts 3,000 connections. The other 3,000 are refused, and clients that retry immediately increase the attempt rate. A proxy would keep the 6,000 client connections open and reconnect only its smaller pool, but the pool still has to fit the replacement writer.",
  },
  setup: defaults({ clients: 6_000, proxy: 0, poolSize: 500, failover: 1 }),
  runFor: 20,
  observe: [
    "Writer connection use reaches 100% and refused connections cross the critical threshold.",
    "Reconnect attempts reach 3,000 per second, above the critical threshold.",
    "The application and writer nodes are critical; the proxy node is bypassed.",
    "The proxy pool size is irrelevant while the proxy is disabled.",
    "Enabling the proxy with a 600-connection pool drops the writer to 20% and refuses nothing.",
  ],
  explain:
    "A failover replaces the writer and breaks the connections attached to it. Without a proxy, each client pool reconnects on its own schedule, but they tend to converge in the same few seconds. The replacement writer has fewer slots while it warms up, so the reconnect population is larger than the capacity. RDS Proxy holds idle client connections, follows the new writer, and reconnects only its pool. That reduces the storm but does not create database capacity.",
  fix: defaults({ clients: 6_000, proxy: 1, poolSize: 600, failover: 1 }),
  debrief:
    "The proxy changed the population that reconnects from 6,000 clients to 600 pooled connections, so the replacement writer stayed at 20% and refused nothing. The tradeoff is a new hop and a new limit: if the pool is larger than the new writer, the proxy becomes the storm. Size MaxConnectionsPercent with headroom and verify the pool against the post-failover capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon RDS Proxy is a managed connection pooler that sits between an application and an RDS or Aurora database. The application connects to a proxy endpoint instead of the database endpoint. The proxy keeps a pool of database connections, multiplexes client sessions onto them, and handles authentication through AWS Secrets Manager or IAM. It is not a cache, a read replica, or a second writer.",
  },
  {
    type: "p",
    text: "The failover behavior is the reason many teams adopt it. RDS Proxy follows the current writer. During a database failover, it keeps idle application connections open, reconnects its database pool to the new writer, and queues requests while the writer is unavailable. Only connections in the middle of a transaction or statement are canceled. Clients connecting through the proxy are not exposed to DNS propagation delays, local DNS caching, connection timeouts, or uncertainty about which instance is the writer. Those are exactly the delays that make a direct application take much longer to recover than the database itself.",
  },
  {
    type: "p",
    text: "The proxy also has limits. Each proxy is associated with one target DB instance or Aurora DB cluster. It multiplexes at transaction granularity, but some session state forces it to pin a client to one database connection, which reduces reuse. MaxConnectionsPercent caps the pool as a percentage of the database's connection limit; ConnectionBorrowTimeout defaults to two minutes; IdleClientTimeout defaults to 30 minutes; and a connection has a maximum lifetime of 24 hours. A proxy hop also adds latency. The pool is a budget, not infinite capacity.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application pool, RDS Proxy endpoint, proxy pool, writer. The application still has its own pool: the proxy reduces database connections, not client connections. During failover the proxy holds the client side and reconnects the database side. That is why the client count can be much larger than the database count, and why the database count is the number that must fit the replacement writer.",
  },
  {
    type: "compare",
    leftTitle: "Direct to writer",
    rightTitle: "Through RDS Proxy",
    rows: [
      { label: "Database connections", left: "One per client", right: "Proxy pool, smaller than clients" },
      { label: "Failover reconnect", left: "Every client reconnects", right: "Proxy reconnects the pool" },
      { label: "DNS behavior", left: "Client caches and TTLs apply", right: "Proxy follows the writer" },
      { label: "In-flight work", left: "Connection breaks", right: "In-flight transaction is canceled; idle connections survive" },
      { label: "Main limit", left: "Database max_connections", right: "Proxy pool and pinning limits" },
    ],
  },
  {
    type: "p",
    text: "A proxy is not automatically safer. If the pool is larger than the replacement writer can accept, the proxy reconnects too many database connections and creates the same storm with fewer clients. If the application pins many sessions, the pool behaves more like session pooling and reuse drops. If the application retries aggressively, the proxy queue can still overflow.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Client connections and database connections side by side, showing what the proxy multiplexes.",
      "Writer connection use against the replacement writer's capacity during failover.",
      "Refused connections and reconnect attempts per second, the storm's two signals.",
      "The proxy node, which is bypassed when the proxy toggle is off.",
      "Pool size compared with the failover capacity, not with the steady-state writer.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Direct reconnect storm and read the refused and reconnect numbers. Then apply Proxy absorbs the storm with the same client count. Finally, raise the pool above the replacement writer's capacity to see the proxy become the bottleneck. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Client counts, the 3,000-slot replacement writer, the two-second reconnect window, and the pool sizes are illustrative teaching values. RDS Proxy settings such as MaxConnectionsPercent, ConnectionBorrowTimeout, and IdleClientTimeout are real configuration surfaces, but their correct values depend on the workload.",
  },
  { type: "sim", simId: "rds-proxy-failover" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Without a proxy, 6,000 client connections broke when the writer failed and reconnected within about two seconds. The replacement writer accepted 3,000, so 3,000 were refused. Retries kept the attempt rate at 3,000 per second. The database was available, but the application could not get through its own reconnect storm.",
  },
  {
    type: "p",
    text: "With RDS Proxy and a 600-connection pool, the same 6,000 clients stayed connected to the proxy. The proxy reconnected only 600 database connections, and the replacement writer stayed at 20% of its capacity. The proxy did not add database capacity; it changed which population had to reconnect. In-flight transactions were still canceled.",
  },
  {
    type: "p",
    text: "The third case was the trap: a 3,600-connection pool was larger than the 3,000-slot replacement. The proxy reconnected the storm and the writer refused 600 connections. The correct pool size is bounded by the failover-time capacity, not by the steady-state writer or the client count.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "RDS Proxy CloudWatch metrics: ClientConnections, DatabaseConnections, DatabaseConnectionsSetupFailed, DatabaseConnectionsBorrowLatency, DatabaseConnectionsCurrentlySessionPinned, and MaxDatabaseConnectionsAllowed.",
      "Database: max_connections, current connections, connection errors, and memory or CPU pressure from too many backends.",
      "Application: reconnect bursts, connection timeouts, retry rates, and transaction errors during the failover window.",
      "RDS events: failover started and completed, and the writer endpoint change. Multi-AZ failover typically takes 60 to 120 seconds, but application recovery can take longer.",
      "Proxy events: target registration changes, borrow timeouts, and pinning that reduces multiplexing.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the reconnect population before the writer. If the database connection count is below its limit, the outage is probably DNS, connection validation, or retry behavior. If it is at the limit, compare the proxy pool with the replacement writer's capacity and check whether direct clients bypass the proxy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Put RDS Proxy in front of the writer endpoint and move every application, Lambda function, and job to the proxy endpoint.",
      "Size the proxy pool below the post-failover capacity, with headroom. MaxConnectionsPercent is a percentage of the database limit, so verify the actual limit after instance changes.",
      "Set ConnectionBorrowTimeout and IdleClientTimeout to values that fit the application's own timeouts. Align the layers rather than leaving defaults unexamined.",
      "Reduce session pinning: move initialization to the proxy's initialization query, avoid unnecessary SET statements, and check DatabaseConnectionsCurrentlySessionPinned.",
      "Add exponential backoff with jitter to client reconnects. The proxy absorbs the first wave; retries can still flood it.",
      "Keep direct connections out of the pool budget, or account for them explicitly. A proxy does not reserve capacity for administrators.",
      "If the pool cannot fit the writer, reduce the pool or add capacity. A proxy in front of an undersized writer only changes the shape of the failure.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "The proxy preserves idle client connections and reduces reconnect storms, but adds a network hop and its own failure modes.",
      "A smaller pool protects the writer but increases borrow wait and can reject work under a burst.",
      "A larger pool reduces wait in normal operation but can exceed the replacement writer after failover.",
      "Transaction-level multiplexing breaks if too much session state pins clients to one connection.",
      "The proxy does not remove the need to size max_connections or to test failover end to end.",
      "Managed proxy configuration is another layer to monitor, authenticate, and keep aligned with the database limit.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "proxy-failover",
    question: "What does RDS Proxy preserve during a database failover, and what does it still lose?",
    difficulty: 3,
    hints: [
      "Separate idle client connections from in-flight transactions.",
      "The proxy follows the writer; it does not make the writer invincible.",
    ],
    answer:
      "RDS Proxy keeps idle application connections open and reconnects its database pool to the new writer. It follows the writer endpoint, so clients are not exposed to DNS propagation, local DNS caching, or connection timeouts. It queues requests while the writer is unavailable. It still cancels connections that are in the middle of a transaction or statement, and it cannot preserve an in-flight transaction across the failover. The application must still handle that error and retry safely. The proxy also does not create database capacity.",
    followUps: [
      "Which application errors remain during failover?",
      "How does the proxy follow the new writer?",
      "What happens to requests that arrive while the writer is unavailable?",
    ],
    redFlags: [
      "Says no connections are lost.",
      "Claims transactions survive failover.",
      "Confuses client connections with database connections.",
    ],
    rubric: [
      "Preserves idle client connections.",
      "Cancels in-flight transactions.",
      "Names DNS and reconnect benefits.",
      "States that capacity is unchanged.",
    ],
  },
  {
    id: "size-proxy-pool",
    question:
      "How do you size an RDS Proxy pool for a writer that fails over, and why is the client count not the answer?",
    difficulty: 3,
    hints: [
      "The pool is what reconnects to the new writer.",
      "The replacement writer may have less capacity during warmup.",
    ],
    answer:
      "I would start from the database's connection limit and the number of concurrent transactions, not the client count. MaxConnectionsPercent sets the pool as a percentage of the database limit, so I would leave at least 30% headroom and account for direct clients and administration. Then I would check the pool against the replacement writer's capacity after failover, because that is the state where the pool is most dangerous. I would load-test a failover and watch DatabaseConnections, MaxDatabaseConnectionsAllowed, borrow latency, and refused connections. If the pool does not fit the replacement, I would lower it or add writer capacity.",
    followUps: [
      "What does 30% headroom protect against?",
      "How does pinning change the effective pool size?",
      "What would you measure during the failover test?",
    ],
    redFlags: [
      "Sizes the pool to the client count.",
      "Sets MaxConnectionsPercent to 100 with no headroom.",
      "Ignores the post-failover writer capacity.",
    ],
    rubric: [
      "Starts from database connection limits and concurrency.",
      "Leaves headroom.",
      "Checks post-failover capacity.",
      "Names proxy metrics and a failover test.",
    ],
  },
  {
    id: "proxy-worse",
    question: "When can RDS Proxy make an incident worse?",
    difficulty: 4,
    hints: [
      "A proxy is a pool and a hop, not extra database capacity.",
      "Pinning and timeouts are proxy-specific failure modes.",
    ],
    answer:
      "It can make things worse when the proxy pool is larger than the replacement writer can accept, because the proxy reconnects the storm it was supposed to absorb. It can also hurt when session pinning reduces multiplexing, so the pool behaves like session pooling and exhausts connections. A ConnectionBorrowTimeout that is too short rejects work while the writer is warming up; one that is too long makes clients wait behind a queue. The extra hop adds latency, and the proxy is another component to monitor and authenticate. It is not a substitute for sizing the database, testing failover, or handling retries.",
    followUps: [
      "How would you detect pinning?",
      "What timeout alignment would you check?",
      "When would you avoid a proxy entirely?",
    ],
    redFlags: [
      "Treats the proxy as infinite capacity.",
      "Ignores pinning.",
      "Leaves timeouts unaligned.",
    ],
    rubric: [
      "Names an oversized pool.",
      "Names pinning.",
      "Discusses timeout alignment.",
      "Keeps database sizing and testing in scope.",
    ],
  },
];

const checklist = [
  {
    title: "Before the failover",
    items: [
      "Every application, job, and Lambda function uses the proxy endpoint, not the writer endpoint.",
      "MaxConnectionsPercent is set with headroom for administration and direct clients.",
      "The proxy pool is tested against the replacement writer's post-failover capacity.",
      "ConnectionBorrowTimeout and IdleClientTimeout fit the application's own timeouts.",
      "Pinning is measured and reduced where possible.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check DatabaseConnections against MaxDatabaseConnectionsAllowed before changing the pool.",
      "Check whether direct clients bypass the proxy and contribute to the storm.",
      "Check borrow latency and setup failures, not just CPU on the writer.",
      "Check the client retry policy for immediate, unjittered retries.",
      "Record the failover time separately from the application recovery time.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Rerun a failover test with production client counts and pool settings.",
      "Fix pinning sources or account for them in the pool size.",
      "Add alerts for setup failures, borrow latency, and connection use.",
      "Confirm that retries are idempotent and bounded.",
    ],
  },
];

const references = [
  {
    title: "Amazon RDS Proxy",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed pooling, connection sharing, failover behavior, and proxy quotas.",
  },
  {
    title: "RDS Proxy concepts and terminology",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.howitworks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connection pooling, multiplexing, pinning, and failover behavior in detail.",
  },
  {
    title: "Best practices with RDS Proxy: configuration guidelines",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy-best-practices.configuration.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "MaxConnectionsPercent, MaxIdleConnectionsPercent, IdleClientTimeout, ConnectionBorrowTimeout, and headroom guidance.",
  },
  {
    title: "Failing over a Multi-AZ DB instance for Amazon RDS",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.Failover.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Failover timing, DNS record changes, and JVM DNS TTL guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rds-proxy-failover": {
      model: rdsProxyModel,
      presets,
      instructions:
        "Start healthy, then apply Direct reconnect storm. Apply Proxy absorbs the storm with the same client count, then raise the pool above the replacement writer's capacity.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Client counts, replacement capacity, and reconnect timing are teaching inputs, not RDS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-pgbouncer",
    "databases-failover-dns",
    "databases-max-connections",
    "databases-connection-storm",
  ],
};
