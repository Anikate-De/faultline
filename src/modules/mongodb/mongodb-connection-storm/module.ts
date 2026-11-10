import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MONGOS_COUNT = 4;
const MONGOS_HANDSHAKES_PER_SECOND = 8_000;
const MONGOS_CONNECTIONS = 20_000;

const params: ParamSpec[] = [
  {
    id: "workers",
    label: "Application workers",
    min: 200,
    max: 5_000,
    step: 100,
    value: 600,
    unit: " processes",
    group: "Fleet",
    help: "Each worker is a separate application process with its own driver pool. One restart event affects every worker at once unless reconnects are spread out.",
    format: "count",
  },
  {
    id: "poolSize",
    label: "Pool size per worker",
    min: 5,
    max: 50,
    step: 5,
    value: 10,
    unit: " connections",
    group: "Fleet",
    help: "The driver's maximum pool size. Total client connections are roughly workers multiplied by pool size, before any proxy or pooler.",
    format: "count",
  },
  {
    id: "jitter",
    label: "Reconnect jitter",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Reconnect",
    help: "How widely reconnect attempts are spread in time. Zero means every worker retries on the same schedule; higher values spread the burst.",
    format: "percent",
  },
  {
    id: "backoff",
    label: "Initial backoff",
    min: 0,
    max: 5_000,
    step: 250,
    value: 1_000,
    unit: "ms",
    group: "Reconnect",
    help: "The first delay before a failed handshake is retried. Exponential backoff plus jitter prevents a failed wave from immediately becoming another synchronized wave.",
    format: "ms",
  },
  {
    id: "blip",
    label: "Network blip",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Scenario",
    help: "1 drops established connections at t=0 and forces the fleet to reconnect. 0 shows the steady state with pools already full.",
    format: "count",
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
  workers: number;
  poolSize: number;
  jitter: number;
  backoff: number;
  blip: boolean;
  storm: boolean;
  stormDuration: number;
  reconnectWindow: number;
  totalConnections: number;
  established: number;
  attempts: number;
  mongosCpu: number;
  connectionErrors: number;
  accepted: number;
  shardUtilization: number;
}

function compute(p: Params, t: number): Computed {
  const workers = clamp(num(p, "workers", 600), 0, 10_000);
  const poolSize = clamp(num(p, "poolSize", 10), 0, 100);
  const jitter = clamp(num(p, "jitter", 60), 0, 100);
  const backoff = clamp(num(p, "backoff", 1_000), 0, 10_000);
  const blip = num(p, "blip", 0) >= 0.5;
  const totalConnections = workers * poolSize;
  const reconnectWindow = 2 + (jitter / 100) * 45;
  const stormDuration = 6 + (backoff / 1_000) * 8 + (1 - jitter / 100) * 55;
  const storm = blip && t < stormDuration;
  const progress = storm ? clamp(t / stormDuration) : 1;
  const decay = 1 - progress;
  const peakAttempts = (totalConnections / reconnectWindow) * (1 + (1 - jitter / 100) * 2.5);
  const churn = totalConnections * 0.0004;
  const attempts = storm ? peakAttempts * decay + churn : churn;
  const established = blip
    ? totalConnections * clamp(t / Math.max(0.5, reconnectWindow))
    : totalConnections;

  const handshakeCapacity = MONGOS_COUNT * MONGOS_HANDSHAKES_PER_SECOND;
  const connectionCapacity = MONGOS_COUNT * MONGOS_CONNECTIONS;
  const handshakeErrors =
    attempts > handshakeCapacity ? (1 - handshakeCapacity / attempts) * 100 : 0;
  const capacityErrors =
    established > connectionCapacity ? (1 - connectionCapacity / established) * 100 : 0;
  const connectionErrors = clamp(Math.max(handshakeErrors, capacityErrors * 0.3), 0, 100);
  const accepted = attempts * (1 - connectionErrors / 100);

  const connUtil = established / connectionCapacity;
  const attemptUtil = attempts / handshakeCapacity;
  const mongosCpu = clamp(15 + 55 * connUtil + 60 * attemptUtil, 0, 120);
  const shardUtilization = clamp(attemptUtil * 0.6 + connUtil * 0.25);

  return {
    workers,
    poolSize,
    jitter,
    backoff,
    blip,
    storm,
    stormDuration,
    reconnectWindow,
    totalConnections,
    established,
    attempts,
    mongosCpu,
    connectionErrors,
    accepted,
    shardUtilization,
  };
}

function health(value: number, warn: number, crit: number): Health {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(seed: number, values: Computed): SimFrame {
  const clientHealth = health(values.connectionErrors, 1, 5);
  const mongosHealth = health(values.mongosCpu, 70, 90);
  const shardHealth = health(values.shardUtilization * 100, 70, 90);
  const nodes: SimNode[] = [
    {
      id: "app",
      label: "Application fleet",
      kind: "client",
      health: clientHealth,
      sublabel: `${Math.round(values.workers).toLocaleString()} workers · ${Math.round(values.totalConnections).toLocaleString()} pooled connections`,
      detail:
        "Every worker process owns a driver connection pool. After a network blip each pool must build new connections, and a handshake is more expensive for mongos than reusing an existing connection.",
      meta: { view: "flow" },
    },
  ];

  for (let index = 1; index <= MONGOS_COUNT; index++) {
    nodes.push({
      id: `mongos-${index}`,
      label: `mongos ${index}`,
      kind: "service",
      role: "instance",
      health: mongosHealth,
      utilization: clamp(values.mongosCpu / 100),
      throughput: values.attempts / MONGOS_COUNT,
      sublabel: `${Math.round(values.established / MONGOS_COUNT).toLocaleString()} clients · ${values.connectionErrors.toFixed(0)}% rejected`,
      detail:
        "mongos terminates client connections, authenticates them, and keeps its own pool to every shard. A reconnect wave burns CPU on handshakes before any query is routed.",
      meta: { view: "flow", cpu: values.mongosCpu },
    });
  }

  nodes.push({
    id: "shards",
    label: "Shards",
    kind: "db",
    role: "shard",
    health: shardHealth,
    utilization: values.shardUtilization,
    sublabel: `connection churn from ${MONGOS_COUNT} routers`,
    detail:
      "Shards accept connections from every mongos. Connection storms reach them through the router tier, so a pool sized only for application workers can still overload the cluster.",
    meta: { view: "flow", churn: values.shardUtilization },
  });

  const edges = [
    ...Array.from({ length: MONGOS_COUNT }, (_, index) =>
      edge(
        `app-mongos-${index + 1}`,
        "app",
        `mongos-${index + 1}`,
        clamp(values.attempts / (MONGOS_COUNT * MONGOS_HANDSHAKES_PER_SECOND)),
        clientHealth,
      ),
    ),
    ...Array.from({ length: MONGOS_COUNT }, (_, index) =>
      edge(
        `mongos-${index + 1}-shards`,
        `mongos-${index + 1}`,
        "shards",
        clamp(values.attempts / (MONGOS_COUNT * MONGOS_HANDSHAKES_PER_SECOND)),
        mongosHealth,
      ),
    ),
  ];

  const mode = values.storm ? "Reconnect storm in progress" : "Pools steady";
  const summary = `${mode} · ${Math.round(values.attempts).toLocaleString()}/s handshakes · mongos ${values.mongosCpu.toFixed(0)}% CPU · ${values.connectionErrors.toFixed(0)}% rejected`;

  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric(
        "reconnect-attempts",
        "Reconnect attempts",
        values.attempts,
        "/s",
        6_000,
        15_000,
        "rps",
      ),
      metric("mongos-cpu", "mongos CPU", values.mongosCpu, "%", 70, 90, "percent"),
      metric(
        "connection-errors",
        "Rejected connections",
        values.connectionErrors,
        "%",
        1,
        5,
        "percent",
      ),
      metric(
        "established-connections",
        "Established connections",
        values.established,
        "",
        60_000,
        90_000,
        "count",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      blip: values.blip ? 1 : 0,
      storm: values.storm ? 1 : 0,
      stormDuration: values.stormDuration,
    },
    summary,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["reconnect-attempts", values.attempts, 0.02],
    ["mongos-cpu", values.mongosCpu, 0.2],
    ["connection-errors", values.connectionErrors, 0.05],
    ["established-connections", values.established, 0.01],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "reconnect-attempts",
    metricId: "reconnect-attempts",
    warn: 6_000,
    crit: 15_000,
    title: "The fleet is reconnecting faster than mongos can authenticate",
    cause:
      "Every worker opens its pool at the same time, so handshake rate rises with workers multiplied by pool size divided by the reconnect window. mongos spends CPU on authentication and TLS instead of routing queries.",
    fix: "Spread reconnects with exponential backoff plus jitter, cap `maxPoolSize`, and add a pooler or connection proxy if the fleet cannot be coordinated. Reduce worker count or pool size before raising mongos capacity.",
    checkFirst: [
      "Check driver pool and reconnect settings, especially `maxPoolSize` and any `maxConnecting` limit.",
      "Check mongos CPU and connection counts per router, not only aggregate cluster CPU.",
      "Check whether one deploy or network event restarted many workers at once.",
    ],
  },
  {
    id: "mongos-cpu",
    metricId: "mongos-cpu",
    warn: 70,
    crit: 90,
    title: "mongos CPU is saturated by connection work",
    cause:
      "Connection establishment is CPU-heavy: TLS, authentication, and per-connection state. A synchronized reconnect wave can saturate mongos even when the shards have spare capacity.",
    fix: "Add jitter and backoff at the client, reduce pool size, and route through a connection pooler. Scale mongos only after the reconnect policy is fixed, because more routers also multiply connections to every shard.",
    checkFirst: [
      "Check mongos CPU alongside new connection rate and established connection count.",
      "Check whether all routers are hot or only the ones that received the retry wave.",
      "Check shard connection counts for a second wave caused by more mongos instances.",
    ],
  },
  {
    id: "connection-errors",
    metricId: "connection-errors",
    warn: 1,
    crit: 5,
    title: "Handshakes are being rejected",
    cause:
      "mongos or the shards have reached a connection or handshake limit. Clients retry the failure, which adds load to an already saturated tier and extends the outage.",
    fix: "Stop the retry amplification first: exponential backoff with jitter and a bounded pool. Then restore capacity or restart only the affected router, not the entire fleet.",
    checkFirst: [
      "Check mongos and shard logs for connection limit, authentication, or TLS handshake errors.",
      "Check file descriptor and memory limits on the routers and shards.",
      "Check whether one application deployment caused the whole fleet to reconnect.",
    ],
  },
  {
    id: "established-connections",
    metricId: "established-connections",
    warn: 60_000,
    crit: 90_000,
    title: "Pooled connection count exceeds the modeled router capacity",
    cause:
      "Workers multiplied by pool size can exceed what the router tier can hold, even if the handshake burst is over. Each connection consumes memory and file descriptors on mongos and on every shard it pools to.",
    fix: "Set pool size from concurrent request concurrency, not from worker count alone. Share pools through a proxy or reduce per-process pools; verify the total against mongos and shard limits.",
    checkFirst: [
      "Check total connections per mongos and per shard.",
      "Check the driver's `maxPoolSize` against actual concurrent operations per worker.",
      "Check whether idle pools are holding connections that are never used.",
    ],
  },
];

export const connectionStormModel: SimModel = {
  id: "mongodb-connection-storm",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p, frame.t);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, value]) => [key, [...value]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };

    const jitter = rng.between(-0.12, 0.12) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "mongos-cpu" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.blip && !Number(next.flags.blipAnnounced ?? 0)) {
      pushEvent(next, {
        id: "network-blip",
        at: frame.t,
        severity: "warn",
        title: "Network blip dropped established connections",
        detail:
          "Every application pool lost its connections. The next few seconds are decided by how the clients reconnect, not by shard capacity.",
        nodeId: "app",
      });
      next.flags.blipAnnounced = 1;
    }
    if (values.connectionErrors >= 5 && !Number(next.flags.stormAnnounced ?? 0)) {
      pushEvent(next, {
        id: "connection-storm",
        at: frame.t,
        severity: "crit",
        title: "Reconnect storm is saturating mongos",
        detail: `${Math.round(values.attempts).toLocaleString()} handshakes/s with ${values.connectionErrors.toFixed(0)}% rejected. Retries are adding load to the tier that is already failing.`,
        nodeId: "mongos-1",
        metricId: "connection-errors",
      });
      next.flags.stormAnnounced = 1;
    }
    if (!values.storm && values.connectionErrors < 1 && !Number(next.flags.calmAnnounced ?? 0)) {
      pushEvent(next, {
        id: "pools-calm",
        at: frame.t,
        severity: "info",
        title: "Connection pools have refilled",
        detail:
          "Handshake rate is back near steady-state churn and mongos is no longer rejecting connections.",
        nodeId: "app",
      });
      next.flags.calmAnnounced = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t);
    const items: string[] = [];
    items.push(
      `${Math.round(values.workers).toLocaleString()} workers times a pool of ${Math.round(values.poolSize)} is ${Math.round(values.totalConnections).toLocaleString()} potential connections, or about ${Math.round(values.totalConnections / MONGOS_COUNT).toLocaleString()} per mongos.`,
    );
    if (values.storm) {
      items.push(
        `Reconnects are spread over roughly ${values.reconnectWindow.toFixed(0)}s with ${values.jitter.toFixed(0)}% jitter. The modeled storm lasts about ${values.stormDuration.toFixed(0)}s; a failed handshake without backoff starts another wave.`,
      );
    }
    items.push(
      `Modeled handshake capacity is ${(MONGOS_COUNT * MONGOS_HANDSHAKES_PER_SECOND).toLocaleString()}/s across ${MONGOS_COUNT} routers. This is an illustrative capacity, not a MongoDB limit.`,
    );
    if (values.connectionErrors > 0) {
      items.push(
        `${values.connectionErrors.toFixed(0)}% of handshakes are rejected. Each rejected connection is a client that will retry, so the offered rate is not the useful rate.`,
      );
    } else {
      items.push(
        "No handshakes are rejected, but a rising established connection count still consumes memory and file descriptors on mongos and every shard.",
      );
    }
    if (values.poolSize >= 30) {
      items.push(
        "A large pool does not make one worker faster; it multiplies the reconnect cost across the fleet. Size the pool to concurrent operations per process.",
      );
    }
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
    description: "600 workers with pool size 10 and a spread reconnect schedule. No network blip.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "3,000 workers reconnect after a blip with 60% jitter. mongos is close to its modeled handshake ceiling.",
    tone: "warn",
    params: defaults({ workers: 3_000, poolSize: 25, jitter: 60, backoff: 1_000, blip: 1 }),
  },
  {
    id: "failure",
    label: "Synchronized reconnect",
    description:
      "4,000 workers with pool size 40 reconnect with no jitter or backoff. Every pool retries at once.",
    tone: "crit",
    params: defaults({ workers: 4_000, poolSize: 40, jitter: 0, backoff: 0, blip: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "1,200 workers reconnect with 85% jitter and 2.5s initial backoff. The burst is spread and mongos stays available.",
    tone: "ok",
    params: defaults({ workers: 1_200, poolSize: 10, jitter: 85, backoff: 2_500, blip: 1 }),
  },
  {
    id: "pool-limit",
    label: "Small pool, no jitter",
    description:
      "4,000 workers with a small pool of 5 reconnect at once. Fewer connections still arrive as one burst.",
    tone: "warn",
    params: defaults({ workers: 4_000, poolSize: 5, jitter: 0, backoff: 0, blip: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-pool-limit",
  title: "Does a smaller pool prevent a reconnect storm?",
  simId: "connection-storm",
  question:
    "A network blip forces 4,000 workers to reconnect. You reduce `maxPoolSize` from 40 to 10 but leave jitter and backoff at zero. What happens at mongos?",
  prediction: {
    options: [
      {
        id: "saved",
        label:
          "The smaller pool keeps mongos below its handshake ceiling because total connections fell by 75%",
      },
      {
        id: "same",
        label:
          "The burst is smaller but still synchronized, so handshakes saturate mongos and connections are rejected",
      },
      {
        id: "shards",
        label:
          "mongos stays healthy but shards fail because each shard receives all 40,000 connections",
      },
      {
        id: "slow",
        label:
          "Nothing changes until the application makes a query; idle reconnects do not touch mongos",
      },
    ],
    correctOptionId: "same",
    explanation:
      "A smaller pool lowers the total connection count and the height of the burst, but it does not change when the burst happens. With zero jitter and zero backoff, every worker still starts its handshakes in the same window. The handshake rate can exceed mongos capacity, and rejected clients retry, which sustains the storm. Jitter and backoff address synchronization; pool size addresses total footprint.",
  },
  setup: defaults({ workers: 4_000, poolSize: 10, jitter: 0, backoff: 0, blip: 1 }),
  runFor: 15,
  observe: [
    "The total connection count is lower than the 40-connection case.",
    "Handshake rate is still far above the modeled mongos ceiling because every worker starts at once.",
    "Rejected connections create another wave of retries; mongos CPU stays critical.",
    "The application sees connection errors even though each worker's pool is small.",
  ],
  explain:
    "Connection pools are per process, so the fleet is the unit that reconnects. A pool limit changes the number of handshakes, while jitter and backoff change their timing. If the timing is synchronized, a small pool can still produce a burst larger than the router tier can authenticate. That is why a pooler alone is not a reconnect policy.",
  fix: defaults({ workers: 4_000, poolSize: 10, jitter: 85, backoff: 2_000, blip: 1 }),
  debrief:
    "Check the connection storm from the client side first: pool size, jitter, backoff, and how many workers restarted together. Then check mongos CPU, established connections per router, and shard connection counts. Add capacity only after the retry wave is bounded, because more mongos instances also add connections to every shard.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A MongoDB driver keeps a pool of connections for each client process. The pool lets many concurrent operations share a small number of authenticated sockets, and it hides connection setup from the request path. `maxPoolSize` sets the ceiling per process; it is not a cluster-wide limit.",
  },
  {
    type: "p",
    text: "A connection storm happens when many processes rebuild their pools at the same time. A network blip, a rolling deploy, a DNS change, or a load balancer reset can drop every socket at once. Each driver then reconnects. If every worker retries immediately, the router tier receives a burst of TLS handshakes and authentication requests instead of a steady trickle. The shards feel it too, because every mongos keeps its own pool to every shard.",
  },
  {
    type: "p",
    text: "Connection count and connection rate are different limits. A fleet can hold an acceptable number of idle connections and still fail because it tries to create them too fast. This module separates those two numbers and shows why pool size alone is not a reconnect policy.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "In a sharded cluster, applications connect to `mongos` routers. A router authenticates the client, routes the query using config server metadata, and keeps a pool to every shard. In a replica set without sharding, applications connect directly to `mongod` members, but the same reconnect arithmetic applies at a smaller scale.",
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it does not tell you"],
    rows: [
      [
        "Per-worker `maxPoolSize`",
        "The ceiling one process can open",
        "How many processes will reconnect together",
      ],
      [
        "Established connection count",
        "Memory and file descriptor footprint",
        "How fast those connections were created",
      ],
      [
        "New connections per second",
        "Handshake and authentication load",
        "Whether the connections are doing useful work",
      ],
      [
        "Rejected or timed-out handshakes",
        "The tier is over a connection or CPU limit",
        "Which client fleet caused the wave",
      ],
    ],
  },
  {
    type: "compare",
    leftTitle: "Synchronized reconnect",
    rightTitle: "Spread reconnect",
    rows: [
      {
        label: "Timing",
        left: "Every worker retries in the same window",
        right: "Jitter spreads attempts across the backoff window",
      },
      {
        label: "Shape",
        left: "One tall burst, followed by retry waves",
        right: "A lower, wider hump that capacity can absorb",
      },
      {
        label: "Pool size",
        left: "Multiplies the height of the burst",
        right: "Still sets the footprint, but not the timing",
      },
      {
        label: "Failure mode",
        left: "mongos CPU saturation and rejected handshakes",
        right: "Slower convergence, but the router stays available",
      },
    ],
  },
  {
    type: "p",
    text: "MongoDB drivers expose pool limits such as `maxPoolSize` and, in newer drivers, `maxConnecting` to cap concurrent connection establishment. Those limits help, but they do not coordinate separate processes. Application-level jitter, a deploy that restarts workers gradually, or a shared pooler are what break synchronization across the fleet.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Reconnect attempts per second: the handshake load arriving at mongos.",
      "mongos CPU: how much of the router tier is spent on connection work rather than query routing.",
      "Rejected connections: handshakes that failed and will be retried.",
      "Established connections: the total footprint per router and per shard.",
      "The steady state after the storm: low churn, full pools, and normal routing.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Synchronized reconnect and watch the handshake burst hit mongos before the connection count stabilizes. Then raise jitter and backoff one at a time. Compare that with Small pool, no jitter: fewer connections but the same timing. Use the experiment to predict the result before revealing it.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Illustrative capacity",
    body: "The router and shard capacities in this model are teaching values, not MongoDB limits. Real limits depend on TLS, authentication, CPU, memory, file descriptors, and driver behavior. The invariant is the shape: synchronized handshakes consume router CPU before any query is served.",
  },
  { type: "sim", simId: "connection-storm" },
  { type: "experiment", experimentId: "predict-pool-limit" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The network blip dropped established connections and every application pool tried to rebuild. With no jitter or backoff, the workers reconnected in the same window. mongos spent its CPU on TLS and authentication, rejected handshakes once it hit its modeled limit, and the rejected clients retried. The shards saw the wave indirectly through every router's pool.",
  },
  {
    type: "p",
    text: "Reducing the pool size lowered the total connection footprint but not the synchronization. The burst was smaller and still arrived at once. Adding jitter and backoff changed the shape: attempts spread across a wider window, handshake rate stayed under capacity, and pools refilled without a second storm.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A sharp rise in new connections per second on every mongos at the same time.",
      "mongos CPU dominated by connection setup, with query latency rising or queries timing out.",
      "Application errors such as server selection timeouts, connection refused, or TLS handshake failures.",
      "Shard connection counts rising after the router tier recovers, because each mongos reconnects to every shard.",
      "A second smaller wave minutes later if clients retry without backoff or if a deploy restarts workers in batches.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the client fleet: how many processes restarted, what `maxPoolSize` they use, and whether their reconnect delay has jitter. Then check mongos CPU and rejected handshakes per router, followed by shard connection counts. Do not add mongos instances before the retry behavior is bounded; more routers add more connections to every shard.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the amplification: add exponential backoff with jitter to connection retries.",
      "Reduce per-process pool size to the concurrency the worker actually needs.",
      "Restart or deploy workers in batches so the fleet does not reconnect together.",
      "Use a connection pooler or proxy if many short-lived workers share a backend.",
      "Verify total connections per mongos and per shard against memory and file descriptor limits.",
      "Only then add router capacity, and recheck shard connection counts after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger pool reduces queueing inside one worker but multiplies reconnect cost across the fleet.",
      "Jitter slows convergence slightly in exchange for keeping the router available.",
      "Aggressive backoff protects mongos but can leave some workers without a connection longer than the request timeout.",
      "A pooler reduces backend connections but becomes another tier to size, monitor, and fail over.",
      "More mongos routers add query capacity and also add a pool to every shard, so they are not free during a reconnect storm.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-storm",
    question: "A network blip lasts two seconds, but mongos stays saturated for two minutes. Why?",
    difficulty: 3,
    hints: [
      "Separate the trigger from the recovery behavior.",
      "Think about who retries and when.",
      "Look at the total connection footprint as well as the burst.",
    ],
    answer:
      "The blip drops established connections, and every application worker starts reconnecting. If the retry delay has no jitter, the fleet retries in synchronized waves. Rejected handshakes are retried again, so the offered handshake rate stays above mongos capacity. The duration is set by the retry policy and the number of workers, not by the length of the original blip. A large total pool also keeps memory and file descriptor pressure high after the burst ends.",
    followUps: [
      "What changes if only one availability zone restarts?",
      "How would you prove the database is healthy while mongos is saturated?",
      "What does a connection pooler change?",
    ],
    redFlags: [
      "Blames the shards without checking the router tier.",
      "Says the network blip is still happening.",
      "Ignores client retry behavior.",
    ],
    rubric: [
      "Separates trigger from retry amplification.",
      "Names jitter and backoff.",
      "Mentions total connection footprint.",
      "Checks mongos before adding shards.",
    ],
  },
  {
    id: "pool-size",
    question: "How do you size a MongoDB driver pool for a service with 400 workers?",
    difficulty: 3,
    hints: [
      "Start from concurrent operations per process.",
      "A pool is not a throughput setting.",
      "Total connections matter to mongos and every shard.",
    ],
    answer:
      "Size from the peak number of concurrent database operations per process, not from request rate alone. If a worker handles 20 concurrent operations and a few are long-running, a pool around 25 to 30 may be enough; a pool of 100 mostly holds idle sockets. Then multiply by 400 workers and compare with mongos and shard connection limits. Use a pooler if the product is many short-lived workers. During reconnects, the same pool size becomes the burst multiplier, so pair it with jitter and backoff.",
    followUps: [
      "What is `maxConnecting` for?",
      "When is a larger pool justified?",
      "How do idle connections affect memory?",
    ],
    redFlags: [
      "Sets the pool to the request rate.",
      "Ignores total connections across workers.",
      "Assumes one pool is shared by all processes.",
    ],
    rubric: [
      "Starts from concurrency per process.",
      "Multiplies across the fleet.",
      "Mentions reconnect behavior.",
      "Considers a pooler.",
    ],
  },
  {
    id: "dampen",
    question:
      "You cannot change the application this week. What can you do at the database tier to survive the next reconnect wave?",
    difficulty: 3,
    hints: [
      "Protect the router tier first.",
      "Adding capacity can multiply another connection path.",
      "Recovery is not the same as prevention.",
    ],
    answer:
      "I would protect mongos with rate limits or a pooler in front of it if one is available, ensure the routers have headroom for handshake CPU, and stage any restart so not every worker reconnects at once. I would not add shards as the first move, and I would add mongos capacity only with the shard connection math in hand. I would also verify that retries have a bounded budget, because unlimited retries turn a short storm into a long one. The application fix remains jitter, backoff, and a smaller pool.",
    followUps: [
      "What would you monitor during the next deploy?",
      "How does a rolling restart change the wave?",
      "What is the risk of a connection limit at the shard?",
    ],
    redFlags: [
      "Adds shards to fix a router problem.",
      "Restarts mongos during the storm.",
      "Ignores retry budgets.",
    ],
    rubric: [
      "Protects mongos first.",
      "Accounts for shard connections.",
      "Bounds retries.",
      "Plans a staged restart.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Pool size is derived from concurrent operations per process, not from worker count.",
      "Reconnect uses exponential backoff with jitter and a bounded retry budget.",
      "Deploys restart workers in batches rather than all at once.",
      "Dashboards show new connections per second, established connections, and rejected handshakes per mongos.",
      "Total connections are checked against mongos and shard memory and file descriptor limits.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify whether the trigger was a network event, a deploy, or a DNS change.",
      "Check mongos CPU and handshake errors before changing shard capacity.",
      "Reduce the offered reconnect rate; do not restart the whole fleet again.",
      "Watch for a second wave as routers reconnect to shards.",
      "Keep one change at a time so the effect is measurable.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm handshake rate and rejected connections have returned to steady state.",
      "Check that established connections are within budget on every router and shard.",
      "Review whether the pool size and retry policy match the fleet's real concurrency.",
      "Rehearse a staged restart and measure the reconnect shape.",
    ],
  },
];

const references = [
  {
    title: "Connection String Options",
    url: "https://www.mongodb.com/docs/manual/reference/connection-string-options/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Driver connection string options, including `maxPoolSize` and connection pool behavior.",
  },
  {
    title: "mongos",
    url: "https://www.mongodb.com/docs/manual/reference/program/mongos/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "The sharded-cluster router, its client connections, and its connections to shards and config servers.",
  },
  {
    title: "Production Notes",
    url: "https://www.mongodb.com/docs/manual/administration/production-notes/",
    publisher: "MongoDB",
    kind: "docs" as const,
    note: "Deployment guidance including connection limits, file descriptors, and resource planning.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "connection-storm": {
      model: connectionStormModel,
      presets,
      instructions:
        "Start Healthy. Apply Synchronized reconnect, then add jitter and backoff one at a time. Compare with Small pool, no jitter to separate connection count from reconnect timing.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. Router handshake capacity, connection limits, and storm duration are teaching values; MongoDB behavior depends on TLS, authentication, driver version, and deployment size.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["databases-connection-storm", "mongodb-sharding", "mongodb-mongos-routing"],
};
