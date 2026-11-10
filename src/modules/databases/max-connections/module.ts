import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_MEMORY_SHARE = 0.35;
const RESERVED_SUPERUSER_SLOTS = 3;

const params = [
  {
    id: "attemptedConnections",
    label: "Connection attempts",
    min: 20,
    max: 5_000,
    step: 10,
    value: 120,
    unit: " conns",
    group: "Clients",
    help: "Connections the application fleet tries to hold open. A restart or failover can make every pool retry at once.",
    format: "count" as const,
  },
  {
    id: "maxConnections",
    label: "Configured max_connections",
    min: 50,
    max: 5_000,
    step: 50,
    value: 500,
    unit: " conns",
    group: "Database",
    help: "The configured ceiling. It is a cap, not a promise that the instance has memory for that many sessions. Three slots are reserved for superusers in this model.",
    format: "count" as const,
  },
  {
    id: "instanceMemoryGb",
    label: "Instance memory",
    min: 2,
    max: 256,
    step: 2,
    value: 16,
    unit: " GB",
    group: "Database",
    help: "Total memory for shared buffers, the operating system, and every backend process. The model reserves 35% for shared use.",
    format: "number" as const,
  },
  {
    id: "memoryPerConnectionMb",
    label: "Memory per connection",
    min: 1,
    max: 64,
    step: 1,
    value: 8,
    unit: " MB",
    group: "Workload",
    help: "Illustrative resident memory per active backend, including its share of query work. work_mem is per operation and can multiply.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  attempted: number;
  maxConnections: number;
  memoryGb: number;
  memoryPerConnectionMb: number;
  baseMemoryMb: number;
  practicalByMemory: number;
  practicalLimit: number;
  accepted: number;
  refused: number;
  queueDepth: number;
  memoryUsedMb: number;
  memoryUtil: number;
  connectionUtil: number;
  refusalRate: number;
  memoryHealth: Health;
  refusalHealth: Health;
  connectionHealth: Health;
  databaseHealth: Health;
  queueHealth: Health;
}

function worstHealth(...states: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return states.reduce<Health>((worst, state) => (rank[state] > rank[worst] ? state : worst), "ok");
}

function compute(p: Params): Computed {
  const attempted = Math.max(0, Math.round(num(p, "attemptedConnections", 120)));
  const maxConnections = Math.max(1, Math.round(num(p, "maxConnections", 500)));
  const memoryGb = Math.max(1, num(p, "instanceMemoryGb", 16));
  const memoryPerConnectionMb = Math.max(0.5, num(p, "memoryPerConnectionMb", 8));
  const totalMemoryMb = memoryGb * 1_024;
  const baseMemoryMb = totalMemoryMb * BASE_MEMORY_SHARE;
  const availableMb = totalMemoryMb - baseMemoryMb;
  const practicalByMemory = Math.floor(availableMb / memoryPerConnectionMb);
  const applicationCeiling = Math.max(1, maxConnections - RESERVED_SUPERUSER_SLOTS);
  const practicalLimit = Math.max(1, Math.min(applicationCeiling, practicalByMemory));
  const accepted = Math.min(attempted, practicalLimit);
  const refused = Math.max(0, attempted - accepted);
  const queueDepth = Math.max(0, attempted - practicalLimit);
  const memoryUsedMb = baseMemoryMb + accepted * memoryPerConnectionMb;
  const memoryUtil = Math.min(100, (memoryUsedMb / totalMemoryMb) * 100);
  const connectionUtil = Math.min(100, (accepted / maxConnections) * 100);
  const refusalRate = attempted > 0 ? (refused / attempted) * 100 : 0;
  const memoryHealth: Health = memoryUtil >= 92 ? "crit" : memoryUtil >= 80 ? "warn" : "ok";
  const refusalHealth: Health = refusalRate >= 5 ? "crit" : refusalRate >= 1 ? "warn" : "ok";
  const connectionHealth: Health = connectionUtil >= 95 ? "crit" : connectionUtil >= 80 ? "warn" : "ok";
  return {
    attempted,
    maxConnections,
    memoryGb,
    memoryPerConnectionMb,
    baseMemoryMb,
    practicalByMemory,
    practicalLimit,
    accepted,
    refused,
    queueDepth,
    memoryUsedMb,
    memoryUtil,
    connectionUtil,
    refusalRate,
    memoryHealth,
    refusalHealth,
    connectionHealth,
    databaseHealth: worstHealth(memoryHealth, refusalHealth, connectionHealth),
    queueHealth: refusalRate >= 5 ? "crit" : queueDepth > 0 ? "warn" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.5);
  const rows: [string, number, number][] = [
    ["memory-utilization", values.memoryUtil, 0.4],
    ["refusal-rate", values.refusalRate, 0],
    ["connection-utilization", values.connectionUtil, 0.3],
    ["practical-limit", values.practicalLimit, 0],
    ["queueDepth", values.queueDepth, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const queueLabel = values.queueDepth > 0 ? `${formatCount(values.queueDepth)} waiting` : "no wait";
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application pools",
        kind: "service",
        health: values.databaseHealth,
        sublabel: `${formatCount(values.attempted)} attempts · ${formatCount(values.refused)} refused`,
        detail: `Pools hold connections open. After a restart or failover, every pool can reconnect at once, which turns a normal count into a storm.`,
        meta: { view: "flow" },
      },
      {
        id: "queue",
        label: "Connection queue",
        kind: "queue",
        health: values.queueHealth,
        sublabel: queueLabel,
        detail: `Attempts above the practical limit wait for a slot and then fail. The database can refuse a connection even when max_connections has not been reached, because memory is exhausted first.`,
        meta: { view: "flow", depth: values.queueDepth },
      },
      {
        id: "db",
        label: "Database instance",
        kind: "db",
        health: values.databaseHealth,
        utilization: clamp(values.memoryUtil / 100),
        sublabel: `${formatCount(values.accepted)}/${formatCount(values.maxConnections)} slots · practical ${formatCount(
          values.practicalLimit,
        )}`,
        detail: `Memory is ${Math.round(values.memoryUtil)}% used. The practical limit is the smaller of the application slot ceiling (max_connections minus three reserved slots) and the memory available for backends; the configured limit is not the binding one here.`,
        meta: { view: "flow", practicalLimit: values.practicalLimit, memoryUtil: values.memoryUtil },
      },
    ],
    edges: [
      edge("app-queue", "app", "queue", clamp(values.attempted / 5_000), values.queueHealth),
      edge("queue-db", "queue", "db", clamp(values.accepted / 5_000), values.databaseHealth),
    ],
    metrics: [
      metric("memory-utilization", "Memory utilization", values.memoryUtil, "%", 80, 92, "percent"),
      metric("refusal-rate", "Connection refusal rate", values.refusalRate, "%", 1, 5, "percent"),
      metric("connection-utilization", "max_connections used", values.connectionUtil, "%", 80, 95, "percent"),
      metric("practical-limit", "Practical connection limit", values.practicalLimit, " conns", undefined, undefined, "count"),
      metric("queueDepth", "Waiting connection attempts", values.queueDepth, " conns", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `max_connections ${formatCount(values.maxConnections)}; practical limit ${formatCount(
      values.practicalLimit,
    )}; ${formatCount(values.accepted)} accepted, ${formatCount(values.refused)} refused; memory ${Math.round(
      values.memoryUtil,
    )}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "memory-utilization",
    metricId: "memory-utilization",
    warn: 80,
    crit: 92,
    title: "Connections are exhausting memory before max_connections",
    cause:
      "Each backend process consumes memory, and a query can use work_mem per sort or hash operation. The configured max_connections is only a slot ceiling; the instance runs out of memory for backends below that ceiling.",
    fix:
      "Lower the connection count or the per-session memory, add instance memory, or put a pooler in front of the database. Raising max_connections without adding memory makes the failure more likely.",
    checkFirst: [
      "Compare the practical memory limit with max_connections.",
      "Check pg_stat_activity for active, idle, and idle-in-transaction sessions.",
      "Check work_mem, hash_mem_multiplier, and the number of parallel workers per query.",
    ],
  },
  {
    id: "refusal-rate",
    metricId: "refusal-rate",
    warn: 1,
    crit: 5,
    title: "The database is refusing connections",
    cause:
      "Attempts exceed the practical limit, so new backends cannot start. The client sees a connection error or timeout, and retries can make the queue longer.",
    fix:
      "Reduce attempts at the source, recycle pools gradually, and protect reserved superuser slots. Add a pooler or memory only after the refusal source is understood.",
    checkFirst: [
      "Check the exact error: too many clients, out of memory, or a timeout.",
      "Check whether a restart or failover triggered a reconnect storm.",
      "Check whether autoscaling increased the number of application tasks.",
    ],
  },
  {
    id: "connection-utilization",
    metricId: "connection-utilization",
    warn: 80,
    crit: 95,
    title: "The configured connection ceiling is close",
    cause:
      "Even if memory is available, max_connections limits how many backends can exist. Reserved slots and background workers reduce the number available to the application.",
    fix:
      "Leave headroom for failover, migrations, and superuser access. Lower per-task pool sizes or add a multiplexing proxy instead of raising the ceiling indefinitely.",
    checkFirst: [
      "Compare active sessions with max_connections and superuser_reserved_connections.",
      "Check the connection count per application task.",
      "Check whether pools shrink after a scale-in.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const connectionModel: SimModel = {
  id: "databases-max-connections",
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
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.refused > 0 && frame.flags.refusalLogged !== 1) {
      pushEvent(next, {
        id: "refused-before-max",
        at: frame.t,
        severity: values.refusalRate >= 5 ? "crit" : "warn",
        title: "Connections are refused before max_connections",
        detail: `${formatCount(values.attempted)} attempts against a practical limit of ${formatCount(
          values.practicalLimit,
        )}; ${formatCount(values.refused)} were refused while max_connections is ${formatCount(
          values.maxConnections,
        )} and memory is ${Math.round(values.memoryUtil)}% used.`,
        nodeId: "db",
        metricId: "refusal-rate",
      });
    }
    next.flags.refusalLogged = values.refused > 0 ? 1 : 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [
      `The practical limit is ${formatCount(values.practicalLimit)}: min(max_connections minus ${RESERVED_SUPERUSER_SLOTS} reserved slots (${formatCount(
        values.maxConnections - RESERVED_SUPERUSER_SLOTS,
      )}), memory limit ${formatCount(values.practicalByMemory)}).`,
    ];
    if (values.practicalByMemory < values.maxConnections) {
      items.push(
        `Memory is the binding limit. ${values.memoryGb} GB with ${values.memoryPerConnectionMb} MB per connection leaves room for about ${formatCount(
          values.practicalByMemory,
        )} backends after shared memory and the operating system take ${Math.round(
          BASE_MEMORY_SHARE * 100,
        )}%.`,
      );
    } else {
      items.push(
        `max_connections is the binding limit; the memory estimate could support about ${formatCount(
          values.practicalByMemory,
        )} backends.`,
      );
    }
    items.push(
      `At ${formatCount(values.attempted)} attempts, ${formatCount(values.accepted)} connect and ${formatCount(
        values.refused,
      )} are refused (${values.refusalRate.toFixed(1)}%). The connection ceiling is only ${Math.round(
        values.connectionUtil,
      )}% used, which is why watching max_connections alone misses this failure.`,
    );
    items.push(
      "The model reserves three superuser slots, as superuser_reserved_connections does by default. The application cannot use the last few slots, so leave that headroom in the pool total.",
    );
    items.push(
      "work_mem is per sort or hash operation, not per connection. A complex query can use several times work_mem, and parallel workers each add process memory.",
    );
    items.push(
      "A pooler reduces server sessions but changes session semantics. Keep a reserve for superusers and failover, and test the pooler mode against prepared statements and temporary tables.",
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
    description: "Plenty of memory, few sessions, and the configured ceiling is not the binding limit.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak sessions",
    description: "High connection count and larger per-session work push memory and the slot ceiling into warning.",
    tone: "warn",
    params: defaults({ attemptedConnections: 420, instanceMemoryGb: 8, memoryPerConnectionMb: 10 }),
  },
  {
    id: "failure",
    label: "Memory-bound refusal",
    description: "max_connections is 500, but memory runs out around 330 sessions and the rest are refused.",
    tone: "crit",
    params: defaults({ attemptedConnections: 360, maxConnections: 500, instanceMemoryGb: 4, memoryPerConnectionMb: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "More memory and a smaller per-session footprint keep every attempt inside the configured ceiling.",
    tone: "ok",
    params: defaults({ attemptedConnections: 300, instanceMemoryGb: 16, memoryPerConnectionMb: 6 }),
  },
];

const experiment: Experiment = {
  id: "practical-limit",
  title: "Why the 500-connection database stops at 330",
  simId: "max-connections",
  question:
    "max_connections is 500, but the instance refuses connections at about 330 and memory is exhausted. Which change raises the practical limit most directly?",
  prediction: {
    options: [
      { id: "raise", label: "Raise max_connections to 1,000." },
      { id: "memory", label: "Add memory or reduce the memory each connection can use." },
      { id: "restart", label: "Restart the database to clear the sessions." },
      { id: "workmem", label: "Increase work_mem so queries finish faster." },
    ],
    correctOptionId: "memory",
    explanation:
      "max_connections is a slot ceiling, not a memory allocation. Each backend has a resident footprint, and work_mem can be used per sort or hash operation. The practical limit is the smaller of the application slot ceiling and what memory can support. Raising max_connections adds slots without adding memory; increasing work_mem increases per-query memory and makes the practical limit worse. A restart only clears the current sessions.",
  },
  setup: defaults({ attemptedConnections: 360, maxConnections: 500, instanceMemoryGb: 4, memoryPerConnectionMb: 8 }),
  runFor: 20,
  observe: [
    "The practical limit is about 332 connections, below the 500 configured.",
    "Memory is near 100% while max_connections is only about 66% used.",
    "About 28 connection attempts are refused and queue for a slot.",
    "The refused count appears before the configured ceiling is reached.",
  ],
  explain:
    "The configured ceiling and the practical ceiling are different numbers. PostgreSQL sizes resources from max_connections, but it does not reserve the full memory for every possible backend at startup. When sessions arrive, each backend and its query work consume memory. If the instance runs out first, new connections fail even though slots remain. Raising max_connections makes the mismatch worse; the fix is to lower memory per session or add memory.",
  fix: defaults({ attemptedConnections: 360, maxConnections: 500, instanceMemoryGb: 8, memoryPerConnectionMb: 6 }),
  debrief:
    "With 8GB and 6MB per connection, the memory-backed limit is above the application slot ceiling, so all 360 attempts connect and memory settles around 61%. The next constraint is the slot ceiling and its reserved headroom, not memory. A pooler would reduce server sessions further if the fleet grows.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "max_connections is the maximum number of concurrent client connections PostgreSQL will accept. The default is typically 100, and the parameter can only be set at server start. PostgreSQL sizes some shared resources directly from this value, so raising it is not free. It is a slot ceiling, not a promise that the instance has memory, CPU, or worker capacity for that many active sessions.",
  },
  {
    type: "p",
    text: "PostgreSQL uses a process per connection. Each client backend has its own memory and scheduling cost. On top of that, a query can use work_mem for each sort or hash operation, and a complex query can run several such operations at once. Parallel query workers are separate processes with roughly the same impact as an additional user session. The result is that the memory cost of a connection depends on what the connection is doing, not just on the connection count.",
  },
  {
    type: "p",
    text: "The practical limit is the smallest of several ceilings: max_connections, the memory available after shared buffers and the operating system, CPU and worker limits, and the reserved slots that keep superusers able to log in. superuser_reserved_connections defaults to three, so the application cannot use the last few slots. When the instance runs out of memory before the slot ceiling, clients see connection failures while max_connections still looks far away.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application pool, network, PostgreSQL postmaster, backend process, then query execution. The pool decides how many connections one task holds; the database decides how many it will accept. During a restart or failover, every pool can reconnect at once. That connection storm creates a queue of attempts, a memory spike, and refused connections even when the steady-state count was safe.",
  },
  {
    type: "table",
    headers: ["Limit", "What it bounds", "Why it is easy to miss"],
    rows: [
      ["max_connections", "Concurrent client sessions", "It is a slot count, not a memory guarantee"],
      ["superuser_reserved_connections", "Slots kept for superusers", "The application cannot use the last few slots"],
      ["Memory per backend and work_mem", "Memory available for sessions and query work", "A complex query can use work_mem several times"],
      ["CPU and worker limits", "Runnable work behind the sessions", "Connections wait while CPU is saturated"],
      ["Pool size × task count", "Connections the fleet will attempt", "Autoscaling multiplies the total"],
    ],
  },
  {
    type: "p",
    text: "On managed services, the default max_connections is derived from the DB instance class. Aurora PostgreSQL derives its default from instance memory, capped at 5,000, and you change it through a custom DB cluster parameter group followed by a reboot of the primary instance. Aurora also recommends leaving at least three connections for AWS automation. Check the actual value on the instance before planning a restart; the practical limit still depends on the workload and the memory the queries use.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Memory utilization: warning at 80%, critical at 92% in this model.",
      "Connection refusal rate: warning at 1%, critical at 5% of attempts.",
      "max_connections used: the slot ceiling, warning at 80% and critical at 95%.",
      "Practical connection limit: the smaller of the application ceiling (max_connections minus reserved slots) and the memory-backed estimate.",
      "Waiting connection attempts: the queue that forms above the practical limit.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Memory-bound refusal and compare the practical limit with max_connections before reading the explanation. Lower the per-connection memory or raise the instance memory and watch the refusal disappear. Then apply Peak sessions to see the slot ceiling become the warning instead.",
  },
  {
    type: "p",
    text: "The 35% shared-memory allowance, per-connection memory, and thresholds are illustrative teaching values. Real PostgreSQL memory use depends on shared_buffers, work_mem, hash_mem_multiplier, parallel workers, workload concurrency, and the operating system. Treat the formula as a sizing shape, not a PostgreSQL guarantee.",
  },
  { type: "sim", simId: "max-connections" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The instance had a 500-slot ceiling but only enough memory for about 332 sessions at the modeled footprint. The extra attempts queued and were refused. max_connections looked two-thirds used, so a dashboard that watched only the configured ceiling would have called the database healthy while clients were failing to connect.",
  },
  {
    type: "p",
    text: "Enlarging the instance or lowering the per-session footprint raised the practical limit above the memory ceiling. The refusal disappeared, and the next limit became the configured slot ceiling, which already includes the reserved headroom. The queue was a symptom; memory was the binding constraint.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "PostgreSQL: pg_stat_activity counts by state, pg_settings for max_connections and superuser_reserved_connections, and the server log for too many clients or out-of-memory errors.",
      "Memory: PostgreSQL reports out-of-memory errors and the operating system may invoke the OOM killer. On RDS and Aurora, DatabaseConnections and FreeableMemory are the first CloudWatch pair to compare.",
      "Clients: connection timeouts, pool acquisition failures, and reconnect storms after a failover or deployment.",
      "CPU and workers: runnable sessions, parallel workers, and context switches. Memory can be fine while CPU limits throughput.",
      "Autoscaling: task count changes that multiply the fleet-wide connection total without changing the database.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the actual error and the practical limit together. If memory is exhausted while max_connections is far away, adding slots will not help. If the slot ceiling is the binding limit, check the pool total and the reserved headroom before raising it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the server error and compare active sessions with max_connections and superuser_reserved_connections.",
      "Measure memory per active backend and the concurrency of sorts and hashes; work_mem is per operation.",
      "Reduce pool size or task count, and make reconnects gradual after a restart or failover.",
      "Lower work_mem or bound the queries that use it if per-session work is the problem.",
      "Add instance memory or a pooler when the connection count is genuinely needed.",
      "Keep reserved slots and failover headroom; test the new limit under a connection storm.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More connections increase concurrency and memory pressure, and they add contention for CPU and locks.",
      "A larger instance raises both memory and the slot ceiling, but it costs more and still has a finite limit.",
      "Lower work_mem reduces per-query memory and can spill sorts and hashes to disk, increasing latency.",
      "A pooler reduces server sessions but changes session state; transaction pooling can break prepared statements and temporary tables.",
      "Raising max_connections is a static change that needs a reboot and can make an out-of-memory failure worse.",
      "Reserved superuser slots protect emergency access and reduce the slots available to the application.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-die-early",
    question: "The database has max_connections set to 500 but dies at about 300. How do you explain that?",
    difficulty: 2,
    hints: [
      "A slot ceiling is not a memory allocation.",
      "Check what each backend and query uses.",
    ],
    answer:
      "max_connections only limits how many sessions may exist. Each backend has memory, and each sort or hash operation can use work_mem, so the instance can exhaust memory before 500 sessions. Parallel workers add more processes. I would compare the practical memory limit with the configured ceiling, check pg_stat_activity for active and idle-in-transaction sessions, and check work_mem and the workload's concurrency. If memory is the binding limit, I would reduce sessions or per-session work, add memory, or add a pooler. Raising max_connections would make it worse.",
    followUps: [
      "What does superuser_reserved_connections change?",
      "How would a connection storm look?",
      "When would you choose a pooler over a larger instance?",
    ],
    redFlags: [
      "Raises max_connections first.",
      "Assumes each connection has a fixed memory cost.",
      "Ignores work_mem and parallel workers.",
    ],
    rubric: [
      "Separates slots from memory.",
      "Names work_mem and backend memory.",
      "Checks pg_stat_activity.",
      "Chooses a fix based on the binding limit.",
    ],
  },
  {
    id: "size-connections",
    question: "How do you size a safe connection limit for a PostgreSQL instance?",
    difficulty: 3,
    hints: [
      "Start from memory and concurrency, not a vendor maximum.",
      "Leave room for reserved slots and failover.",
    ],
    answer:
      "I would start with the instance memory, subtract shared buffers and operating-system overhead, and estimate the memory per active backend from the workload's sorts, hashes, and parallel workers. That gives a practical ceiling. I would compare it with the number of concurrent queries the application actually needs, which follows from arrival rate and query time, not from the number of tasks. Then I would leave headroom for superuser_reserved_connections, failover, migrations, and a reconnect storm. The final limit is the smaller of the memory-backed estimate and the slot ceiling, and I would verify it under peak concurrency rather than trusting the formula.",
    followUps: [
      "How does Little's Law help?",
      "What would change if query time doubled?",
      "How would a pooler change the sizing?",
    ],
    redFlags: [
      "Uses the instance class maximum as the target.",
      "Ignores concurrency and query time.",
      "Leaves no failover headroom.",
    ],
    rubric: [
      "Starts from memory and workload.",
      "Uses concurrency, not task count alone.",
      "Reserves headroom.",
      "Verifies under peak.",
    ],
  },
  {
    id: "connection-storm",
    question: "A failover completes and every application pool reconnects at once. What happens, and what do you do?",
    difficulty: 3,
    hints: [
      "The steady-state count was safe.",
      "Reconnects are a burst, not a steady state.",
    ],
    answer:
      "The database sees a burst of connection attempts much larger than the steady-state count. Backends start, memory rises, and attempts above the practical limit queue or fail. Retries can amplify the burst. I would stagger reconnects with jitter and backoff, cap pool size per task, and keep reserved slots for operators. If the burst is expected, I would pre-warm the pool gradually and verify memory headroom. I would not raise max_connections without checking memory, because the burst is a concurrency problem, not a slot-count problem.",
    followUps: [
      "How would you add jitter to reconnects?",
      "What does a pooler do during the storm?",
      "How would you test the failover path?",
    ],
    redFlags: [
      "Raises max_connections without checking memory.",
      "Lets every pool retry immediately.",
      "Ignores the retry amplification.",
    ],
    rubric: [
      "Describes the burst and memory rise.",
      "Adds jitter and backoff.",
      "Caps pool size.",
      "Keeps reserved headroom.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The practical connection limit is documented next to max_connections.",
      "Pool size multiplied by peak task count is checked against the limit.",
      "superuser_reserved_connections and failover headroom are reserved.",
      "Reconnects after failover use jitter and backoff.",
      "Memory per active backend and work_mem concurrency are measured, not guessed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the exact connection error before changing any limit.",
      "Compare active sessions with max_connections and memory.",
      "Check for a reconnect storm or an autoscaling event.",
      "Reduce attempts or memory per session before raising the ceiling.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the practical limit, the binding resource, and the peak attempt count.",
      "Retune pool sizes and work_mem with the measured workload.",
      "Test the connection path under a staggered failover.",
      "Add an alert for refusals and memory, not just max_connections.",
    ],
  },
];

const references = [
  {
    title: "PostgreSQL: Connections and Authentication",
    url: "https://www.postgresql.org/docs/current/runtime-config-connection.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "max_connections, superuser_reserved_connections, and the resources sized from the connection limit.",
  },
  {
    title: "PostgreSQL: Resource Consumption",
    url: "https://www.postgresql.org/docs/current/runtime-config-resource.html",
    publisher: "PostgreSQL Global Development Group",
    kind: "docs" as const,
    note: "work_mem per operation and the memory impact of parallel workers.",
  },
  {
    title: "Maximum connections to an Aurora PostgreSQL DB instance",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraPostgreSQL.Managing.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Default max_connections derived from instance memory, the 5,000 cap, the AWS automation reserve, and the reboot requirement.",
  },
  {
    title: "Working with parameters on your RDS for PostgreSQL DB instance",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Appendix.PostgreSQL.CommonDBATasks.Parameters.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "max_connections as a static parameter and the startup failure when it is set too high for memory.",
  },
  {
    title: "Amazon CloudWatch metrics for Amazon Aurora",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/Aurora.AuroraMonitoring.Metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "DatabaseConnections and FreeableMemory as the first pair to compare during connection pressure.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "max-connections": {
      model: connectionModel,
      presets,
      instructions:
        "Start healthy. Apply Memory-bound refusal and compare the practical limit with max_connections. Lower per-connection memory or add instance memory and watch refusals disappear. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The shared-memory allowance, per-connection memory, three reserved superuser slots, and thresholds are teaching values, not PostgreSQL guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "databases-rds-aurora-arch",
    "databases-pgbouncer",
    "foundations-connection-pools",
    "foundations-file-descriptors",
  ],
};
