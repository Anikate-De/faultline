import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REDIS_CAPACITY = 120_000;
const MAX_CLIENTS = 10_000;
const TIMEOUT_MS = 500;

const params = [
  {
    id: "requestRps",
    label: "Redis calls per instance",
    min: 100,
    max: 20_000,
    step: 100,
    value: 3_000,
    unit: " /s",
    group: "Traffic",
    help: "Commands one service instance needs to send to Redis each second.",
    format: "rps" as const,
  },
  {
    id: "redisMs",
    label: "Redis service time",
    min: 0.1,
    max: 20,
    step: 0.1,
    value: 0.5,
    unit: "ms",
    group: "Traffic",
    help: "Average time a command occupies a connection, including the round trip. Concurrency is rate times this value.",
    format: "ms" as const,
  },
  {
    id: "poolSize",
    label: "Pool size per instance",
    min: 1,
    max: 300,
    step: 1,
    value: 20,
    unit: " conns",
    group: "Pool",
    help: "Connections one service instance may hold open. Requests beyond this wait in a local queue.",
    format: "count" as const,
  },
  {
    id: "instances",
    label: "Service instances",
    min: 1,
    max: 40,
    step: 1,
    value: 8,
    unit: "",
    group: "Pool",
    help: "Instances each running their own pool. Total Redis sessions are pool size times instances.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function erlangC(connections: number, offered: number): number {
  let blocking = 1;
  for (let index = 1; index <= connections; index++) {
    blocking = (offered * blocking) / (index + offered * blocking);
  }
  const rho = offered / connections;
  const denominator = 1 - rho * (1 - blocking);
  return denominator <= 0 ? 1 : blocking / denominator;
}

interface Computed {
  requestRps: number;
  totalRps: number;
  redisMs: number;
  poolSize: number;
  instances: number;
  required: number;
  rho: number;
  waitMs: number;
  p99: number;
  timeouts: number;
  connections: number;
  connectionRejects: number;
  redisCpu: number;
  queueDepth: number;
  poolUtil: number;
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (
    values.waitMs >= 50 ||
    values.p99 >= 500 ||
    values.timeouts >= 2 ||
    values.connectionRejects >= 2 ||
    values.connections >= 9_500 ||
    values.poolUtil >= 99 ||
    values.redisCpu >= 90
  ) {
    return "crit";
  }
  if (
    values.waitMs >= 5 ||
    values.p99 >= 100 ||
    values.timeouts >= 0.5 ||
    values.connectionRejects >= 0.5 ||
    values.connections >= 8_000 ||
    values.poolUtil >= 95 ||
    values.redisCpu >= 75
  ) {
    return "warn";
  }
  return "ok";
}

function compute(p: Params, scale = 1): Computed {
  const requestRps = Math.max(1, num(p, "requestRps", 3_000)) * scale;
  const redisMs = Math.max(0.1, num(p, "redisMs", 0.5));
  const poolSize = Math.max(1, Math.round(num(p, "poolSize", 20)));
  const instances = Math.max(1, Math.round(num(p, "instances", 8)));
  const required = (requestRps * redisMs) / 1_000;
  const rho = required / poolSize;
  let waitMs: number;
  if (rho < 1) {
    const probabilityWait = erlangC(poolSize, required);
    waitMs = Math.min(redisMs * 50, (probabilityWait * redisMs) / (poolSize * (1 - rho)));
  } else {
    waitMs = Math.min(5_000, redisMs * 50 * rho * rho);
  }
  const p99 = Math.min(10_000, redisMs + waitMs * 5);
  const timeouts = p99 > TIMEOUT_MS ? Math.min(30, (p99 - TIMEOUT_MS) / 50) : 0;
  const connections = poolSize * instances;
  const connectionRejects =
    connections > MAX_CLIENTS ? Math.min(30, (connections / MAX_CLIENTS - 1) * 100) : 0;
  const redisCpu = Math.min(140, ((requestRps * instances) / REDIS_CAPACITY) * 100);
  return {
    requestRps,
    totalRps: requestRps * instances,
    redisMs,
    poolSize,
    instances,
    required,
    rho,
    waitMs,
    p99,
    timeouts,
    connections,
    connectionRejects,
    redisCpu,
    queueDepth: Math.max(0, requestRps * (waitMs / 1_000)),
    poolUtil: Math.min(140, rho * 100),
  };
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const health = healthFor(values);
  const queueHealth =
    values.waitMs >= 50 ? "crit" : values.waitMs >= 5 ? "warn" : "ok";
  const redisHealth =
    values.redisCpu >= 90 || values.connections >= 9_500 || values.connectionRejects >= 2
      ? "crit"
      : values.redisCpu >= 75 || values.connections >= 8_000 || values.connectionRejects >= 0.5
        ? "warn"
        : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "Service instance",
        kind: "service",
        health,
        utilization: clamp(values.rho),
        throughput: values.requestRps,
        sublabel: `${values.poolSize} connections, ${values.instances} instances`,
        detail: `One of ${values.instances} instances. Each request borrows a connection; if all ${values.poolSize} are busy, it waits in this instance's queue.`,
        meta: { view: "queue" },
      },
      {
        id: "pool-queue",
        label: "Connection request queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(values.waitMs / 5_000),
        throughput: values.requestRps,
        sublabel: `${values.queueDepth.toFixed(0)} requests waiting`,
        detail: `Little's Law: ${Math.round(values.requestRps).toLocaleString("en-US")} calls/s times ${values.waitMs.toFixed(1)}ms of wait is about ${Math.round(values.queueDepth).toLocaleString("en-US")} requests waiting per instance.`,
        meta: { view: "queue" },
      },
      {
        id: "redis",
        label: "Redis primary",
        kind: "worker",
        health: redisHealth,
        utilization: clamp(values.redisCpu / 100),
        throughput: values.totalRps,
        sublabel: `${values.redisCpu.toFixed(0)}% CPU, ${values.connections} conns`,
        detail: `Redis is at ${values.redisCpu.toFixed(0)}% CPU with ${Math.round(values.totalRps).toLocaleString("en-US")} commands/s and ${values.connections} client connections across the fleet. The default maxclients is ${MAX_CLIENTS.toLocaleString("en-US")}.`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("service-queue", "service", "pool-queue", values.requestRps / 20_000, queueHealth),
      edge("queue-redis", "pool-queue", "redis", values.requestRps / 20_000, redisHealth),
    ],
    metrics: [
      metric("pool-wait", "Pool wait", values.waitMs, "ms", 5, 50, "ms"),
      metric("request-p99", "Request p99", values.p99, "ms", 100, 500, "ms"),
      metric("pool-timeouts", "Pool timeouts", values.timeouts, "%", 0.5, 2, "percent"),
      metric("pool-util", "Pool utilization", values.poolUtil, "%", 95, 99, "percent"),
      metric("redis-cpu", "Redis CPU", values.redisCpu, "%", 75, 90, "percent"),
      metric("connections", "Redis connections", values.connections, " conns", 8_000, 9_500, "count"),
      metric("queueDepth", "Requests waiting", values.queueDepth, " requests", undefined, undefined, "count"),
      metric("connection-rejects", "Connection rejects", values.connectionRejects, "%", 0.5, 2, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `Redis at ${values.redisCpu.toFixed(0)}% CPU; pool wait ${values.waitMs.toFixed(1)}ms; ${Math.round(values.queueDepth).toLocaleString("en-US")} waiting per instance.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const jitter = (offset: number) => 0.96 + 0.06 * Math.sin((offset + (seed % 9)) / 2.7);
  for (const item of frame.metrics) {
    const amplitude = Math.max(0.1, item.value * 0.02);
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pool-wait",
    metricId: "pool-wait",
    warn: 5,
    crit: 50,
    title: "Requests are waiting for a pooled connection",
    cause:
      "The pool has fewer connections than the in-flight concurrency the request rate requires. The request never reaches Redis, so Redis CPU stays low while the client queue grows.",
    fix:
      "Size the pool above arrival rate times service time, then verify the fleet's total connections against Redis maxclients. Reduce the call rate or service time if the pool cannot grow.",
    checkFirst: [
      "Compare pool wait with Redis CPU and command latency.",
      "Calculate required concurrency: calls per second times service time.",
      "Check whether one instance or every instance is waiting.",
    ],
  },
  {
    id: "request-p99",
    metricId: "request-p99",
    warn: 100,
    crit: 500,
    title: "Request p99 is dominated by acquisition time",
    cause:
      "A request spends most of its budget waiting for a connection, not inside Redis. The Redis span is short or missing, and the pool span carries the latency.",
    fix:
      "Add connections or reduce concurrency per call. Separate pool acquisition timeout from command timeout so a pool wait fails fast instead of consuming the whole request budget.",
    checkFirst: [
      "Break the trace into pool acquisition and Redis command time.",
      "Check whether the slow requests share one instance or one pool.",
      "Check whether retries are holding connections longer.",
    ],
  },
  {
    id: "pool-timeouts",
    metricId: "pool-timeouts",
    warn: 0.5,
    crit: 2,
    title: "Pool acquisition is timing out",
    cause:
      "The local queue exceeded the acquisition timeout. Redis may be healthy; the service cannot get a connection in time.",
    fix:
      "Relieve the queue with more pool capacity or less concurrency, then add a bounded fallback. Raising the acquisition timeout moves the failure to the request deadline.",
    checkFirst: [
      "Separate pool timeouts from Redis command timeouts.",
      "Check active, idle, and waiting counts for every instance.",
      "Check whether a deploy changed pool size or call volume.",
    ],
  },
  {
    id: "pool-util",
    metricId: "pool-util",
    warn: 95,
    crit: 99,
    title: "The pool is nearly out of connections",
    cause:
      "Pool utilization is required concurrency divided by pool size. Above 95%, a small burst pushes requests into the wait queue even when the average looks manageable.",
    fix:
      "Add headroom or reduce concurrency per call. Size the pool above peak concurrency, then check the fleet-wide session count against maxclients.",
    checkFirst: [
      "Compare required concurrency with pool size per instance.",
      "Check pool wait and waiting counts at the same timestamps.",
      "Check whether the pool was sized for average traffic instead of peak.",
    ],
  },
  {
    id: "connections",
    metricId: "connections",
    warn: 8_000,
    crit: 9_500,
    title: "The fleet is pressing against Redis maxclients",
    cause:
      "Total sessions are pool size times instances. A large pool per instance multiplies quickly across the fleet and can exceed the server's connection limit.",
    fix:
      "Cap total connections below maxclients, reduce per-instance pool size, or multiplex commands over fewer connections. Size the pool for concurrency, not for comfort.",
    checkFirst: [
      "Multiply pool size by the number of instances.",
      "Check `INFO clients` and `CLIENT LIST` on the primary.",
      "Check whether a recent scale-out multiplied the session count.",
    ],
  },
  {
    id: "connection-rejects",
    metricId: "connection-rejects",
    warn: 0.5,
    crit: 2,
    title: "Redis is rejecting new connections",
    cause:
      "The fleet exceeded maxclients. New sessions are refused, and clients retry, which adds more connection attempts during the same incident.",
    fix:
      "Reduce total sessions below maxclients, add multiplexing or a proxy, or raise maxclients only with memory and file-descriptor headroom.",
    checkFirst: [
      "Multiply pool size by instance count.",
      "Check `INFO clients` and `CLIENT LIST` on the primary.",
      "Check `NewConnections` and reconnect logs during a deploy or failover.",
    ],
  },
  {
    id: "redis-cpu",
    metricId: "redis-cpu",
    warn: 75,
    crit: 90,
    title: "Redis is now the bottleneck, not the pool",
    cause:
      "The pool has enough connections, but the command rate or command cost is consuming the primary. Adding connections will add queueing, not throughput.",
    fix:
      "Reduce command count or cost, add read capacity where freshness allows, or shard the keyspace. Do not grow the pool to compensate for a saturated server.",
    checkFirst: [
      "Compare Redis CPU with pool wait; both can be high for different reasons.",
      "Check command rate and slowlog entries.",
      "Check whether one shard or key dominates the load.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const poolModel: SimModel = {
  id: "caching-connection-pool",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, compute(p));
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const noise = 1 + rng.between(-0.002, 0.002);
    const values = compute(p, noise);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    next.series = { ...frame.series };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.waitMs >= 5 && frame.flags.poolWaitSeen !== 1) {
      pushEvent(next, {
        id: "pool-wait-detected",
        at: frame.t,
        severity: values.waitMs >= 50 ? "crit" : "warn",
        title: "Requests are queueing for a connection",
        detail: `Pool wait is ${values.waitMs.toFixed(0)}ms while Redis CPU is ${values.redisCpu.toFixed(0)}%. The bottleneck is the local pool, not the server.`,
        nodeId: "pool-queue",
        metricId: "pool-wait",
      });
      next.flags.poolWaitSeen = 1;
    }
    if (values.waitMs < 5) next.flags.poolWaitSeen = 0;
    if ((values.connections >= 8_000 || values.connectionRejects >= 0.5) && frame.flags.maxClientsSeen !== 1) {
      pushEvent(next, {
        id: "maxclients-pressure",
        at: frame.t,
        severity: values.connections >= 9_500 || values.connectionRejects >= 2 ? "crit" : "warn",
        title: "The fleet is pressing against the Redis connection budget",
        detail: `${values.connections.toLocaleString("en-US")} pooled sessions against a default maxclients of ${MAX_CLIENTS.toLocaleString("en-US")}. Every connection also has to reconnect after failover.`,
        nodeId: "redis",
        metricId: "connections",
      });
      next.flags.maxClientsSeen = 1;
    }
    if (values.connections < 8_000 && values.connectionRejects < 0.5) next.flags.maxClientsSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Redis at ${values.redisCpu.toFixed(0)}% CPU; pool wait ${values.waitMs.toFixed(1)}ms; ${Math.round(values.queueDepth).toLocaleString("en-US")} waiting per instance.`;
    next.events = next.events.slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `Required concurrency is ${values.required.toFixed(1)} connections per instance (${Math.round(values.requestRps).toLocaleString("en-US")} calls/s times ${values.redisMs.toFixed(1)}ms). The pool has ${values.poolSize}.`,
      `The pool holds ${values.poolSize} connections against ${values.required.toFixed(1)} required; reported utilization is ${values.poolUtil.toFixed(0)}%.`,
      `At that utilization, mean wait is ${values.waitMs.toFixed(1)}ms and about ${Math.round(values.queueDepth).toLocaleString("en-US")} requests wait per instance.`,
      `The fleet sends ${Math.round(values.totalRps).toLocaleString("en-US")} commands/s to Redis, which is at ${values.redisCpu.toFixed(0)}% CPU. When wait is high and CPU is low, the queue is local.`,
      `The fleet holds ${values.connections.toLocaleString("en-US")} sessions across ${values.instances} instances. The default maxclients is ${MAX_CLIENTS.toLocaleString("en-US")}.`,
      "Multiplexing reduces sessions, but responses on one connection are ordered; a slow command delays later commands on that connection.",
    ];
    if (values.connectionRejects > 0) {
      items.push(
        `About ${values.connectionRejects.toFixed(1)}% of connection attempts are rejected at this session count; every rejected connection also has to retry.`,
      );
    }
    items.push(
      "Large pools do not add throughput past the server's limit. They add sessions that must reconnect after a failover.",
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
    description: "Eight instances, 20 connections each, and 1.5 connections of required concurrency.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Service time rises and the pool reaches 97.5% utilization; wait crosses 5ms.",
    tone: "warn",
    params: defaults({ requestRps: 6_500, redisMs: 3 }),
  },
  {
    id: "failure",
    label: "Failure",
    description: "Four connections cannot cover 24 in-flight calls; wait dominates while Redis is idle.",
    tone: "crit",
    params: defaults({ requestRps: 8_000, redisMs: 3, poolSize: 4, instances: 3 }),
  },
  {
    id: "oversize",
    label: "Oversized pools",
    description: "Forty instances with 300 connections each exceed the default maxclients.",
    tone: "crit",
    params: defaults({ requestRps: 2_000, redisMs: 0.5, poolSize: 300, instances: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Thirty-two connections cover the same 24 in-flight calls with headroom.",
    tone: "ok",
    params: defaults({ requestRps: 8_000, redisMs: 3, poolSize: 32, instances: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-pool-wait",
  title: "Predict where the latency lives",
  simId: "pool",
  question:
    "Redis CPU is 20%, request p99 is over three seconds, and clients are timing out. Where is the time going?",
  prediction: {
    options: [
      { id: "redis", label: "Inside Redis command execution" },
      { id: "pool", label: "Waiting in the local connection pool" },
      { id: "network", label: "On the network between service and Redis" },
      { id: "database", label: "In the database behind the cache" },
    ],
    correctOptionId: "pool",
    explanation:
      "A request that cannot borrow a connection never reaches Redis. The service queues locally, so Redis CPU stays low while request latency and pool wait grow. A short or missing Redis span next to a long pool span is the tell.",
  },
  setup: defaults({ requestRps: 8_000, redisMs: 3, poolSize: 4, instances: 3 }),
  runFor: 20,
  observe: [
    "Pool wait reaches about five seconds per instance while Redis CPU stays near 20%.",
    "Each instance holds four connections, but the call rate needs about 24 in-flight calls.",
    "The wait queue grows to tens of thousands of requests per instance.",
    "Client timeouts reach about 30% even though Redis is healthy.",
  ],
  explain:
    "Little's Law sets the requirement: 8,000 calls per second times 3ms per call is 24 concurrent connections. The pool has four, so 20 calls' worth of concurrency is missing. Those requests wait locally. The Redis command itself is still fast, which is why its CPU is idle.",
  fix: defaults({ requestRps: 8_000, redisMs: 3, poolSize: 32, instances: 3 }),
  debrief:
    "A 32-connection pool covers the 24 in-flight calls with headroom, and pool wait falls below a millisecond. The same fix at 40 instances and 300 connections each would create 12,000 sessions, above the default maxclients, so pool size has to be chosen with the fleet's total connection budget in view.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A connection pool is a bounded set of reusable connections owned by one service instance. A request borrows a connection, sends its Redis commands, and returns it. When every connection is busy, the request waits in a local queue. The pool is a concurrency limit, not a throughput limit: it decides how many Redis commands one instance can have in flight at once.",
  },
  {
    type: "p",
    text: "The size requirement follows from Little's Law. If an instance sends 3,000 commands per second and each command occupies a connection for 0.5ms, the average in-flight count is 1.5. A pool of 20 is ample. If service time rises to 3ms at 8,000 commands per second, the requirement is 24, and a pool of 4 leaves 20 calls' worth of concurrency with nowhere to go but the queue.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pool sits inside the service, between the request handler and the Redis client. Each instance has its own pool, so the fleet's total sessions are pool size times instance count. Redis accepts connections up to `maxclients`, which defaults to 10,000, and every connection consumes memory and a file descriptor. A pool wait is invisible to Redis because the request never reaches the server.",
  },
  {
    type: "table",
    headers: ["Signal", "What it means", "Where to look"],
    rows: [
      ["Pool wait high, Redis CPU low", "Too few connections for the required concurrency", "Client pool metrics and local queue depth"],
      ["Redis CPU high, pool wait low", "Redis is the bottleneck", "Command latency, command rate, slowlog"],
      ["Connections near maxclients", "Pools are too large for the fleet", "CLIENT LIST, INFO clients, maxclients"],
      ["Reconnects spike after failover", "Every pooled session must re-establish", "Client reconnect logs and connection churn"],
    ],
  },
  {
    type: "p",
    text: "This module models one service instance's pool and a Redis primary with an illustrative capacity of 120,000 commands per second. The pool wait uses an Erlang C approximation, which assumes Poisson arrivals and exponential service times; real traffic is burstier, so treat the values as a teaching model rather than a capacity guarantee. The default maxclients value of 10,000 is a real Redis default, and the module labels it explicitly.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pool wait: the mean time a request spends waiting for a connection, warning at 5ms and critical at 50ms.",
      "Request p99: the full request latency, which can be dominated by acquisition rather than Redis.",
      "Pool utilization and queue depth: how close the pool is to its concurrency limit and how many requests are waiting.",
      "Redis CPU and connection count: whether the server or the fleet's session budget is the next constraint.",
      "Pool timeouts and connection rejects: the user-visible failures when the local queue or maxclients is exceeded.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, apply Failure, and compare pool wait with Redis CPU. Then apply Recovery and confirm that more connections remove the queue without raising Redis CPU. Apply Oversized pools to see the opposite failure: no wait, but more sessions than the default maxclients.",
  },
  {
    type: "p",
    text: "A connection can carry pipelined commands, and many clients multiplex several in-flight requests over one connection. That reduces the number of sessions, but responses on a connection are ordered: a slow response delays the commands behind it on that connection. Multiplexing changes the connection count, not the need to bound in-flight work. Pool size, command concurrency, and client timeout still have to agree.",
  },
  { type: "sim", simId: "pool" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The service needed 24 concurrent connections to sustain 8,000 calls per second at 3ms each, but each instance had four. Requests that could not borrow a connection waited in the local queue. The queue grew until the acquisition timeout fired, so request p99 and timeouts rose while Redis CPU stayed near 20%. The Redis command never became slow; it was simply not reached.",
  },
  {
    type: "p",
    text: "Increasing the pool to 32 covered the requirement and removed the queue. The same increase applied without a fleet-wide budget can create the opposite incident: 40 instances with 300 connections each hold 12,000 sessions, above the default maxclients, and every one of them has to reconnect after a failover.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Client library: active, idle, and waiting connection counts, acquisition time, and pool timeout counters. Metric names differ by library; the wait histogram is the signal.",
      "Redis: `INFO clients` reports `connected_clients` and `blocked_clients`; `CLIENT LIST` shows the sessions; `CONFIG GET maxclients` confirms the limit.",
      "ElastiCache: `CurrConnections`, `NewConnections`, and `EngineCPUUtilization` show connection churn and server load.",
      "Traces: a long pool-acquisition span next to a short Redis span, or no Redis span at all when acquisition fails.",
      "Logs: pool timeout, connection reset, and reconnect messages that cluster around a deploy or failover.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare pool wait with Redis CPU. If wait is high and CPU is low, the queue is local. Calculate required concurrency as calls per second times service time, then check the fleet's total connections against maxclients before changing the pool size.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure calls per second and service time per instance, then calculate the required in-flight count.",
      "Size the pool above that requirement with headroom for bursts, not at an arbitrary round number.",
      "Multiply pool size by instance count and keep the total below maxclients with room for failover and admin sessions.",
      "Separate pool acquisition timeout from command timeout so a local queue fails fast instead of consuming the request budget.",
      "On failover, use bounded retries with backoff and jitter, refresh topology, and avoid reconnecting the whole fleet at once.",
      "Re-run at peak and verify pool wait, request p99, Redis CPU, and total connections together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A small pool protects Redis and makes the local queue predictable, but it can starve concurrency during a burst.",
      "A large pool reduces wait but multiplies sessions across the fleet and lengthens reconnect storms after failover.",
      "Multiplexing cuts connection count but introduces head-of-line blocking on each connection.",
      "Increasing the acquisition timeout hides the queue and pushes the failure to the request deadline.",
      "Adding Redis capacity does not fix a local pool wait; the request still needs a connection before it can use that capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-pool",
    question:
      "Redis CPU is 20%, service p99 is 3 seconds, and pool wait is 2 seconds. How do you diagnose the bottleneck?",
    difficulty: 2,
    hints: [
      "If the request never reaches Redis, Redis cannot be the bottleneck.",
      "Compare the Redis span with the pool-acquisition span.",
    ],
    answer:
      "I would compare the pool-acquisition span with the Redis command span. If acquisition dominates and the Redis span is short or missing, the request is waiting locally. I would calculate required concurrency as calls per second times service time and compare it with pool size, then check active and waiting connection counts per instance. Low Redis CPU is consistent with pool exhaustion because the request never reaches the server. I would also check whether one instance or the whole fleet is waiting, since a single hot instance points to a different problem.",
    followUps: [
      "How would the diagnosis change if Redis CPU were 90%?",
      "What if only one instance has high wait?",
      "How do you distinguish pool wait from network latency?",
    ],
    redFlags: [
      "Adds Redis shards because p99 is high.",
      "Raises the client timeout without checking the pool.",
      "Uses average CPU as proof that Redis is healthy.",
    ],
    rubric: [
      "Calculates required concurrency.",
      "Compares pool and Redis spans.",
      "Checks per-instance wait.",
      "Explains why Redis CPU is low.",
    ],
  },
  {
    id: "size-pool",
    question:
      "How do you size a Redis connection pool for a service fleet?",
    difficulty: 3,
    hints: [
      "Start from Little's Law.",
      "Do not forget the fleet-wide connection budget.",
    ],
    answer:
      "Per instance, I would multiply peak calls per second by the average connection hold time to get the required in-flight count, then add headroom for bursts and slow commands. I would not size from average traffic alone. Then I would multiply by the number of instances and compare the total with Redis maxclients, leaving room for failover reconnects and admin sessions. If the total is too high, I would reduce per-instance pool size, reduce command count or service time, or multiplex over fewer connections. I would verify the choice with pool wait and request p99 at peak, not just with a successful load test at average.",
    followUps: [
      "What headroom would you add, and why?",
      "How does a slow command change the requirement?",
      "When would multiplexing be a better answer than a larger pool?",
    ],
    redFlags: [
      "Picks a round number without a calculation.",
      "Sizes only from average traffic.",
      "Ignores the fleet-wide session count.",
    ],
    rubric: [
      "Uses Little's Law.",
      "Accounts for bursts and slow commands.",
      "Checks maxclients across the fleet.",
      "Verifies with wait and p99.",
    ],
  },
  {
    id: "pool-failover",
    question:
      "What happens to a large connection pool during a Redis failover, and how do you limit the damage?",
    difficulty: 3,
    hints: [
      "Every pooled session breaks when the primary changes.",
      "Reconnects are a burst, not a steady rate.",
    ],
    answer:
      "Every pooled connection to the old primary breaks, so the fleet reconnects to the new primary at once. A large pool multiplies that burst: 40 instances times 300 connections is 12,000 sessions, which can exceed maxclients and add accept, authentication, and topology-refresh load while the new primary is still warming. I would cap total connections, use bounded retries with backoff and jitter, refresh topology promptly, and avoid reconnecting every instance on the same schedule. I would also alert on connection churn and `NewConnections`, not only on Redis CPU.",
    followUps: [
      "How does jitter change the reconnect curve?",
      "What would you check if clients keep using the old topology?",
      "How do you test the reconnect path before an incident?",
    ],
    redFlags: [
      "Assumes pools reconnect instantly without cost.",
      "Ignores maxclients during failover.",
      "Retries without a budget.",
    ],
    rubric: [
      "Explains the reconnect burst.",
      "Connects pool size to fleet-wide sessions.",
      "Uses backoff and jitter.",
      "Monitors connection churn.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each service has a documented pool size, acquisition timeout, and command timeout.",
      "Pool wait and active, idle, and waiting counts are exported per instance.",
      "Peak calls per second and service time are used to calculate required concurrency.",
      "The fleet's total connection count is checked against maxclients, including failover headroom.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare pool wait with Redis CPU before changing either one.",
      "Check whether wait is local to one instance or spread across the fleet.",
      "Stop retries that hold connections longer and increase the queue.",
      "Keep total connections below maxclients when adding pool capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run peak traffic and verify pool wait, p99, Redis CPU, and session count together.",
      "Test the reconnect path after a failover with the new pool size.",
      "Record the calculation and the chosen headroom in the runbook.",
      "Review pool size whenever instance count or command cost changes.",
    ],
  },
];

const references = [
  {
    title: "Redis client handling",
    url: "https://redis.io/docs/latest/develop/reference/clients/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Connection limits, maxclients, and client lifecycle.",
  },
  {
    title: "Diagnosing latency issues",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Separating server-side latency from client-side queueing.",
  },
  {
    title: "Amazon ElastiCache best practices",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connection management, monitoring, and cache client guidance.",
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
        "Start healthy, then shrink the pool or raise the call rate. Compare pool wait with Redis CPU before adding connections. Apply Oversized pools to see the fleet-wide session cost.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Pool wait uses an Erlang C approximation; capacity and service times are teaching values, not provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-connection-pools",
    "caching-cluster-failover",
    "foundations-timeouts",
    "caching-read-replicas",
  ],
};
