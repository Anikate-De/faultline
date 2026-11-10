import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const QUEUE_SECONDS = 5;

const params = [
  {
    id: "clients",
    label: "Application workers",
    min: 1_000,
    max: 20_000,
    step: 500,
    value: 2_000,
    unit: "",
    group: "Clients",
    help: "Workers that hold a pool and reconnect after the writer moves. Every worker is a potential reconnect source.",
    format: "count" as const,
  },
  {
    id: "jitterSeconds",
    label: "Reconnect jitter",
    min: 0,
    max: 60,
    step: 1,
    value: 30,
    unit: "s",
    group: "Reconnect",
    help: "Window over which reconnects are spread. Zero means every client retries in the same second.",
    format: "number" as const,
  },
  {
    id: "backoffMs",
    label: "Base backoff",
    min: 0,
    max: 5_000,
    step: 100,
    value: 1_000,
    unit: " ms",
    group: "Reconnect",
    help: "Delay before a failed connection is retried. Without backoff, a failed attempt immediately creates another.",
    format: "ms" as const,
  },
  {
    id: "writerCapacity",
    label: "New writer accept rate",
    min: 500,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " conns/s",
    group: "Database",
    help: "Connections per second the new writer can authenticate and accept. Illustrative; real capacity depends on instance size and TLS setup.",
    format: "rps" as const,
  },
  {
    id: "poolReuse",
    label: "Connections held by proxy",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Pooling",
    help: "Share of client connections kept alive by a pooler or proxy across the failover. Reused connections do not reconnect.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  clients: number;
  jitter: number;
  backoff: number;
  capacity: number;
  reuse: number;
  effectiveClients: number;
  retryFactor: number;
  attemptRate: number;
  admitted: number;
  queueDepth: number;
  waitMs: number;
  errorPct: number;
  health: Health;
}

function compute(p: Params): Computed {
  const clients = Math.max(1, Math.round(num(p, "clients", 2_000)));
  const jitter = Math.max(0, num(p, "jitterSeconds", 30));
  const backoff = Math.max(0, num(p, "backoffMs", 1_000));
  const capacity = Math.max(100, num(p, "writerCapacity", 4_000));
  const reuse = clamp(num(p, "poolReuse", 80) / 100);
  const effectiveClients = clients * (1 - reuse);
  const spread = Math.max(1, jitter);
  const retryFactor = backoff <= 0 ? 2.5 : 1 + 500 / (backoff + 500);
  const attemptRate = (effectiveClients / spread) * retryFactor;
  const admitted = Math.min(attemptRate, capacity);
  const queueDepth = Math.max(0, attemptRate - admitted) * QUEUE_SECONDS;
  const waitMs = attemptRate <= 0 ? 0 : admitted > 0 ? Math.min(60_000, (queueDepth / admitted) * 1_000) : 60_000;
  const errorPct = attemptRate > 0 ? Math.max(0, (1 - admitted / attemptRate) * 100 * 0.3) : 0;
  const health: Health =
    queueDepth >= 2_000 || waitMs >= 2_000 || errorPct >= 5
      ? "crit"
      : queueDepth >= 500 || waitMs >= 500 || errorPct >= 1
        ? "warn"
        : "ok";
  return {
    clients,
    jitter,
    backoff,
    capacity,
    reuse,
    effectiveClients,
    retryFactor,
    attemptRate,
    admitted,
    queueDepth,
    waitMs,
    errorPct,
    health,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["queueDepth", values.queueDepth, 0.5],
    ["connect-wait", values.waitMs, 0.5],
    ["reconnect-rate", values.attemptRate, 0.3],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const queueHealth: Health = values.queueDepth >= 2_000 ? "crit" : values.queueDepth >= 500 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application fleet",
        kind: "service",
        health: values.health,
        sublabel: `${formatCount(values.effectiveClients)} reconnecting workers`,
        detail: `${Math.round(values.reuse * 100)}% of connections are held by the proxy, so only ${formatCount(
          values.effectiveClients,
        )} of ${formatCount(values.clients)} workers need a new session.`,
        meta: { view: "flow" },
      },
      {
        id: "queue",
        label: "Reconnect queue",
        kind: "queue",
        health: queueHealth,
        sublabel: `${formatCount(values.queueDepth)} waiting`,
        detail:
          "Attempts that arrive faster than the writer can accept wait in the connection queue. The queue is a count of sessions, not a request rate.",
        meta: { view: "flow", depth: values.queueDepth },
      },
      {
        id: "writer",
        label: "New writer",
        kind: "db",
        role: "primary",
        health: values.health,
        utilization: clamp(values.attemptRate / Math.max(1, values.capacity) / 4),
        sublabel: `accepts ${formatCount(values.admitted)}/s of ${formatCount(values.attemptRate)}/s`,
        detail:
          "After failover the new writer must authenticate connections, allocate backends, and serve queries. A synchronized burst spends its capacity on connection setup.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-queue", "app", "queue", clamp(values.attemptRate / 20_000), values.health, "reconnects"),
      edge("queue-writer", "queue", "writer", clamp(values.admitted / 20_000), values.health, "admitted"),
    ],
    metrics: [
      metric("queueDepth", "Waiting reconnects", values.queueDepth, " conns", 500, 2_000, "count"),
      metric("connect-wait", "Connect wait", values.waitMs, " ms", 500, 2_000, "ms"),
      metric("error-rate", "Connection errors", values.errorPct, "%", 1, 5, "percent"),
      metric("reconnect-rate", "Reconnect attempts", values.attemptRate, " conns/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.effectiveClients)} effective clients; ${formatCount(
      values.attemptRate,
    )} attempts/s against ${formatCount(values.admitted)}/s accepted; ${formatCount(
      values.queueDepth,
    )} waiting; ${values.errorPct.toFixed(1)}% errors.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "queue-depth",
    metricId: "queueDepth",
    warn: 500,
    crit: 2_000,
    title: "The reconnect queue is overwhelming the new writer",
    cause:
      "Every client lost its session at the same moment and retried immediately. The writer accepts connections at a finite rate, so attempts that arrive faster than that rate queue and then fail.",
    fix:
      "Spread reconnects with jitter, add backoff, and keep connections alive through a pooler. Pre-warm capacity and test the reconnect path before the next failover.",
    checkFirst: [
      "Check whether clients reconnect in a single wave or over a window.",
      "Check retry policy: immediate retry, fixed delay, or jittered exponential backoff.",
      "Check whether a pool or proxy survived the failover.",
    ],
  },
  {
    id: "connect-wait",
    metricId: "connect-wait",
    warn: 500,
    crit: 2_000,
    title: "Connection setup is the bottleneck",
    cause:
      "The writer is spending its time authenticating and allocating sessions instead of serving queries. TLS handshakes and pool refills make each attempt more expensive.",
    fix:
      "Reduce the number of new sessions with pooling, stagger the reconnects, and raise writer capacity only after the burst is shaped.",
    checkFirst: [
      "Compare connection attempts with accepted connections.",
      "Check CPU and memory on the new writer during the burst.",
      "Check whether connection setup includes TLS and authentication.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Clients are failing to connect",
    cause:
      "The burst exceeds the writer's accept capacity or the database's connection limit. Retries add load, and the failure outlasts the original failover.",
    fix:
      "Apply backoff with jitter, cap pool size, and keep a proxy in front of the database. Treat the connection path as part of the failover runbook.",
    checkFirst: [
      "Check the exact client error: refused, timeout, or authentication failure.",
      "Check whether retries are synchronized across tasks.",
      "Check the database connection limit and reserved slots.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const stormModel: SimModel = {
  id: "databases-connection-storm",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = frame.series;
    for (const item of next.metrics) {
      recordSeries(next, item.id, item.value);
      item.trend = next.series[item.id] ?? [];
    }
    next.events = [...frame.events];
    if (values.queueDepth >= 2_000 && frame.flags.stormLogged !== 1) {
      pushEvent(next, {
        id: "reconnect-storm",
        at: frame.t,
        severity: "crit",
        title: "Synchronized reconnects overwhelm the new writer",
        detail: `${formatCount(values.attemptRate)} attempts/s arrive against ${formatCount(
          values.admitted,
        )}/s accepted; ${formatCount(values.queueDepth)} connections wait and ${values.errorPct.toFixed(
          1,
        )}% fail.`,
        nodeId: "queue",
        metricId: "queueDepth",
      });
    }
    next.flags.stormLogged = values.queueDepth >= 2_000 ? 1 : 0;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${formatCount(values.effectiveClients)} workers need a new session after pooling. Spread over ${values.jitter}s, that is ${formatCount(
        values.effectiveClients / Math.max(1, values.jitter),
      )} attempts/s before retries.`,
      `The retry factor is ${values.retryFactor.toFixed(2)}x in this model. With no backoff a failed attempt immediately creates another, so the burst is larger than the number of clients.`,
      `The writer accepts ${formatCount(values.admitted)}/s, leaving ${formatCount(
        values.queueDepth,
      )} connections waiting and ${values.errorPct.toFixed(1)}% failing.`,
      "Jitter spreads the first wave; backoff limits the repeated waves. They solve different parts of the storm, so use both.",
      "A proxy keeps connections alive across the failover, but it adds a hop and its own limits. It is most valuable when clients are numerous and pool sizes are large.",
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
    description: "Most connections survive through the proxy, reconnects are spread over 30 seconds, and the writer keeps up.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Thin headroom",
    description: "Half the connections survive and a short jitter window produces a burst just above the writer's accept rate.",
    tone: "warn",
    params: defaults({ clients: 10_000, jitterSeconds: 5, backoffMs: 200, writerCapacity: 1_500, poolReuse: 50 }),
  },
  {
    id: "failure",
    label: "Synchronized storm",
    description: "Ten thousand workers retry at once with no backoff against a writer that accepts 1,500 connections/s.",
    tone: "crit",
    params: defaults({ clients: 10_000, jitterSeconds: 0, backoffMs: 0, writerCapacity: 1_500, poolReuse: 0 }),
  },
  {
    id: "jitter",
    label: "Jitter only",
    description: "Jitter alone spreads the first wave enough to keep the queue empty, even without a proxy.",
    tone: "ok",
    params: defaults({ clients: 10_000, jitterSeconds: 30, backoffMs: 0, writerCapacity: 1_500, poolReuse: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A proxy holds 80% of connections, reconnects are jittered over 30 seconds, and backoff is in place.",
    tone: "ok",
    params: defaults({ clients: 10_000, jitterSeconds: 30, backoffMs: 1_000, writerCapacity: 4_000, poolReuse: 80 }),
  },
];

const experiment: Experiment = {
  id: "dampen-the-storm",
  title: "Dampen ten thousand reconnects",
  simId: "connection-storm",
  question:
    "A failover makes 10,000 application workers reconnect at once. The new writer accepts about 1,500 connections per second. Which combination actually shortens the outage?",
  prediction: {
    options: [
      { id: "max", label: "Raise max_connections on the writer." },
      { id: "restart", label: "Restart all application workers together so they retry cleanly." },
      { id: "jitter", label: "Spread reconnects with jitter, add backoff, and keep connections alive through a proxy." },
      { id: "replicas", label: "Add read replicas so the writer has less work." },
    ],
    correctOptionId: "jitter",
    explanation:
      "The writer's problem is the arrival rate of new sessions, not the total number of slots. Raising max_connections adds slots but not accept throughput. Restarting everything synchronizes the retry again. Jitter spreads the first wave, backoff prevents immediate retries, and a proxy removes most clients from the reconnect path entirely. Read replicas do not accept writer connections.",
  },
  setup: defaults({ clients: 10_000, jitterSeconds: 0, backoffMs: 0, writerCapacity: 1_500, poolReuse: 0 }),
  runFor: 20,
  observe: [
    "Ten thousand workers produce 25,000 attempts/s after the no-backoff retry factor.",
    "The writer accepts 1,500/s, so 117,500 connections wait and about 28% fail.",
    "Connect wait exceeds 60 seconds and the queue turns critical.",
    "Adding jitter and a proxy cuts the effective burst below the writer's accept rate.",
  ],
  explain:
    "A reconnect storm is an arrival-rate problem. The clients all learned about the failover at the same moment, and their retry policy created more attempts than there were workers. Jitter changes when the first attempt happens; backoff changes how often failures repeat; a proxy changes how many clients need to reconnect at all. Capacity is the last lever, not the first.",
  fix: defaults({ clients: 10_000, jitterSeconds: 30, backoffMs: 1_000, writerCapacity: 4_000, poolReuse: 80 }),
  debrief:
    "With 80% of connections held by the proxy, only 2,000 workers reconnect. Spread over 30 seconds with backoff, the rate stays far below 4,000/s, the queue empties, and errors go to zero. The tradeoff is a proxy hop and a pool that must be sized and failed over deliberately.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A connection storm is a synchronized wave of new database sessions after a failover, network blip, or deployment. Every application worker had a connection, lost it at roughly the same moment, and now wants a new one. The database's steady-state connection count may be safe, but the arrival rate is not.",
  },
  {
    type: "p",
    text: "The storm is amplified by retries. If a connection attempt fails and the client retries immediately, the failed attempt creates another attempt. A client library with no jitter makes all workers retry on the same schedule, so the second wave is as synchronized as the first. The result is a queue of connection attempts, high connect latency, and errors that continue after the database is healthy.",
  },
  {
    type: "p",
    text: "The controls act at different layers. Jitter spreads the first reconnect over a window. Backoff slows repeated attempts after failures. A pooler or proxy keeps sessions alive across the failover so many clients never reconnect. Capacity on the new writer sets the ceiling, but adding capacity without shaping the burst often just moves the queue.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The application pool holds connections to a writer endpoint or a proxy. On failover, the endpoint changes and the old sessions break. The pool starts opening new sessions; the writer authenticates them, allocates memory, and begins serving queries. Each new session costs CPU and memory before it does useful work, so a burst spends the writer's capacity on setup.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it does not fix"],
    rows: [
      ["Jitter", "When the first reconnect happens", "Repeated failures after a rejected attempt"],
      ["Backoff", "How often a failed attempt repeats", "The initial synchronized wave"],
      ["Pool or proxy", "How many clients need a new session", "The proxy's own capacity and failover"],
      ["Writer capacity", "How fast new sessions are accepted", "A burst larger than that rate"],
      ["Connection limit", "How many sessions may exist", "The rate at which they are created"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Waiting reconnects: warning at 500 and critical at 2,000 connections in this model.",
      "Connect wait: warning at 500 ms and critical at 2 s.",
      "Connection errors: warning at 1% and critical at 5% of attempts.",
      "Reconnect attempts per second against the writer's accept rate.",
      "Pool reuse: the share of sessions that survive the failover through a proxy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply Synchronized storm. Read attempts per second and queue depth before changing capacity. Add jitter, then backoff, then pool reuse, one at a time. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "Client counts, accept rates, and thresholds are illustrative teaching values. Real failover behavior depends on the client library, DNS time to live, TLS setup, pool configuration, and the new writer's size.",
  },
  { type: "sim", simId: "connection-storm" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Ten thousand workers lost their sessions at once. With no jitter and no backoff, they produced 25,000 attempts per second against a writer that accepted 1,500. The queue reached 117,500 connections, connect wait passed a minute, and about 28% of attempts failed. The database was available, but the application could not get to it.",
  },
  {
    type: "p",
    text: "Jitter spread the first wave, backoff stopped immediate retries, and the proxy kept 80% of sessions alive across the failover. The effective client count fell to 2,000, the arrival rate fell below the writer's accept rate, and the queue and errors cleared. The ordering matters: shape the burst before adding capacity.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Database connection counts and connection creation rate, separated from active query count.",
      "Application pool metrics: pending acquisitions, creation time, timeouts, and waiters.",
      "Client errors by type: refused, timeout, authentication failure, and DNS failure.",
      "New writer CPU and memory during the burst, including TLS and authentication cost.",
      "Retry logs with timestamps, which show whether clients are synchronized.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Measure the arrival rate of new sessions, not just the total. If attempts per second exceed the writer's accept rate, the queue will grow regardless of how many slots exist. Then check jitter, backoff, and whether a pool or proxy survived the failover.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Add jitter to the reconnect delay so clients do not all return in the same second.",
      "Use exponential backoff with a cap and jitter for failed attempts.",
      "Keep connections alive through a pooler or proxy where the client count is large.",
      "Cap pool size per task and account for the total fleet, not one process.",
      "Pre-warm the new writer and verify its accept rate under a realistic burst.",
      "Test the failover path with production-like client counts and measure time to steady state.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Jitter slows the fastest reconnect in exchange for a smoother wave; a short window may still be too sharp.",
      "Backoff reduces retry load but lengthens recovery for the clients that could have succeeded immediately.",
      "A proxy removes clients from the reconnect path but adds a hop, a new failure domain, and its own capacity limit.",
      "Larger pools reduce connection churn but increase the number of sessions and memory per task.",
      "More writer capacity helps only after the burst is shaped; it can be expensive and still finite.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "storm-shape",
    question: "A failover finishes, but the app is still down for ten minutes. How do you diagnose the connection storm?",
    difficulty: 3,
    hints: [
      "Separate database health from application recovery.",
      "Look at the rate of new sessions.",
    ],
    answer:
      "I would check whether the database is accepting connections and what rate it is accepting them at, then compare that with the application's connection attempts. If attempts per second far exceed accepts, the queue is the problem. I would look at client retry policy, jitter, pool size, and whether a proxy survived. The database may be healthy while the application is still spending its capacity on connection setup.",
    followUps: [
      "What metric separates the two?",
      "How would you tell a refused connection from a timeout?",
      "What would you change first?",
    ],
    redFlags: [
      "Assumes the database is still broken.",
      "Raises max_connections first.",
      "Ignores retry timestamps.",
    ],
    rubric: [
      "Separates database and app recovery.",
      "Measures arrival rate.",
      "Checks jitter and backoff.",
      "Considers the proxy.",
    ],
  },
  {
    id: "jitter-vs-backoff",
    question: "What is the difference between jitter and backoff, and why use both?",
    difficulty: 2,
    hints: [
      "One spreads the first attempt.",
      "The other controls repeats.",
    ],
    answer:
      "Jitter randomizes when a client reconnects, so the first wave is spread over a window instead of arriving together. Backoff controls how long a client waits after a failed attempt, and exponential backoff makes repeated failures less frequent. Jitter without backoff still lets a failed client retry immediately; backoff without jitter can keep clients synchronized on the same schedule. Using both spreads the first wave and damps the repeats.",
    followUps: [
      "How would you choose the jitter window?",
      "What cap would you put on backoff?",
      "How does full jitter differ from equal jitter?",
    ],
    redFlags: [
      "Uses one control only.",
      "Sets a fixed retry interval for all clients.",
      "Lets backoff grow without a cap.",
    ],
    rubric: [
      "Defines both.",
      "Explains the first wave versus repeats.",
      "Combines them.",
      "Mentions a cap or jitter strategy.",
    ],
  },
  {
    id: "proxy-tradeoff",
    question: "When is a database proxy worth the extra hop during failover?",
    difficulty: 3,
    hints: [
      "Compare client count with proxy capacity.",
      "Consider what the proxy hides and what it adds.",
    ],
    answer:
      "A proxy is worth it when many clients hold large pools and the reconnect burst is the dominant recovery cost. It keeps connections alive across the failover, so most clients never need a new session, and it can queue or shape the rest. The cost is an extra network hop, a new component to size and fail over, and its own connection limits. I would use it when the client fleet is large or autoscaling, and test that the proxy itself can survive the failover.",
    followUps: [
      "What happens if the proxy fails over too?",
      "How would you size the proxy?",
      "When would client-side jitter be enough?",
    ],
    redFlags: [
      "Adds a proxy without sizing it.",
      "Assumes the proxy is highly available by default.",
      "Ignores the extra hop.",
    ],
    rubric: [
      "Names the burst reduction.",
      "Names the new failure domain.",
      "Sizes the proxy.",
      "Compares with client-side controls.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Reconnect jitter and backoff are configured in every client and tested.",
      "Pool size per task and total fleet connections are documented.",
      "A pooler or proxy is sized for the failover burst, or its absence is accepted.",
      "The new writer's accept rate is measured under a realistic burst.",
      "The failover runbook includes connection recovery, not just database promotion.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare connection attempts per second with accepts per second.",
      "Check whether retries are synchronized across tasks.",
      "Reduce the effective client count with a proxy or by pausing non-critical workers.",
      "Avoid raising connection limits before the arrival rate is shaped.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record time to steady state and the peak attempt rate.",
      "Retune jitter, backoff, and pool sizes with the measured burst.",
      "Re-test the failover with production-like client counts.",
      "Add an alert for connection creation rate and pool wait time.",
    ],
  },
];

const references = [
  {
    title: "Timeouts, retries, and backoff with jitter",
    url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Why synchronized retries amplify failures and how jitter and backoff reduce load.",
  },
  {
    title: "Amazon RDS Proxy",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Connection pooling, holding connections through failover, and proxy limits.",
  },
  {
    title: "PostgreSQL: Connections and Authentication",
    url: "https://www.postgresql.org/docs/current/runtime-config-connection.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "Connection limits, reserved slots, and the cost of creating backends.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "connection-storm": {
      model: stormModel,
      presets,
      instructions:
        "Start healthy, apply Synchronized storm, and read attempts per second before capacity. Add jitter, backoff, and pool reuse one at a time. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Client counts, accept rates, and thresholds are teaching values, not RDS Proxy limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-failover-dns",
    "databases-rds-proxy",
    "databases-max-connections",
    "reliability-db-failover",
  ],
};
