import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const READ_RPS = 30_000;
const LOCAL_HIT = 0.85;
const REDIS_CAPACITY = 40_000;
const DEPLOY_BATCH = 4;
const REPLACE_SECONDS = 15;
const BYPASS_STOP_SECONDS = 2;

const params = [
  {
    id: "taskCount",
    label: "ECS task count",
    min: 2,
    max: 40,
    step: 1,
    value: 12,
    unit: "",
    group: "Fleet",
    help: "Tasks in the ECS service. Each task has its own local cache and its own copy of a bad value.",
    format: "count" as const,
  },
  {
    id: "badValueSharePct",
    label: "Bad-value read share",
    min: 0,
    max: 100,
    step: 5,
    value: 2,
    unit: "%",
    group: "Incident",
    help: "Share of reads for keys whose local copy is wrong. This is the blast radius before any bypass.",
    format: "percent" as const,
  },
  {
    id: "bypassCoveragePct",
    label: "Bypass coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Escape hatch",
    help: "Share of tasks that read the bypass flag and skip the local cache for the affected keys.",
    format: "percent" as const,
  },
  {
    id: "ttlSeconds",
    label: "Local cache TTL",
    min: 30,
    max: 600,
    step: 30,
    value: 60,
    unit: "s",
    group: "Freshness",
    help: "Upper bound on how long a bad value survives if nothing else bypasses or replaces it. A long TTL is the worst case, not a plan.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  tasks: number;
  badShare: number;
  bypass: number;
  ttl: number;
  deploySeconds: number;
  purgeSeconds: number;
  bypassStopSeconds: number;
  staleErrorPct: number;
  redisRps: number;
  redisUtil: number;
  redisP99: number;
  bypassRps: number;
  affectedTasks: number;
  healthyTasks: number;
}

function compute(p: Params, noise = 1): Values {
  const tasks = Math.max(2, Math.round(num(p, "taskCount", 12)));
  const badShare = clamp(num(p, "badValueSharePct", 2) / 100);
  const bypass = clamp(num(p, "bypassCoveragePct", 80) / 100);
  const ttl = Math.max(30, num(p, "ttlSeconds", 60));
  const deploySeconds = Math.ceil(tasks / DEPLOY_BATCH) * REPLACE_SECONDS;
  const purgeSeconds = Math.min(ttl, deploySeconds);
  const bypassStopSeconds = BYPASS_STOP_SECONDS;
  const staleErrorPct = badShare * (1 - bypass) * 100;
  const bypassRps = READ_RPS * LOCAL_HIT * bypass * noise;
  const redisRps = READ_RPS * (1 - LOCAL_HIT + LOCAL_HIT * bypass) * noise;
  const redisUtil = redisRps / REDIS_CAPACITY;
  const redisP99 = 2 + 8 * redisUtil ** 4;

  return {
    tasks,
    badShare,
    bypass,
    ttl,
    deploySeconds,
    purgeSeconds,
    bypassStopSeconds,
    staleErrorPct,
    redisRps,
    redisUtil,
    redisP99,
    bypassRps,
    affectedTasks: Math.round(tasks * (1 - bypass)),
    healthyTasks: Math.round(tasks * bypass),
  };
}

type HealthState = "ok" | "warn" | "crit";

function healthForUtil(util: number): HealthState {
  if (util >= 1) return "crit";
  if (util >= 0.8) return "warn";
  return "ok";
}

function incidentHealth(values: Values): HealthState {
  if (values.staleErrorPct >= 5 || values.purgeSeconds >= 100) return "crit";
  if (values.staleErrorPct >= 1 || values.purgeSeconds >= 50) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, values: Values, seed: number, t: number): SimFrame {
  const incident = incidentHealth(values);
  const redisHealth = healthForUtil(values.redisUtil);
  const dbHealth = healthForUtil((READ_RPS * 0.05) / 8_000);

  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(READ_RPS)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application load balancer",
        kind: "lb",
        health: "ok",
        throughput: READ_RPS,
        sublabel: "routes across tasks",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "ECS service",
        kind: "service",
        health: incident,
        utilization: clamp(values.staleErrorPct / 5),
        throughput: READ_RPS,
        sublabel: `${values.tasks} tasks, ${(values.bypass * 100).toFixed(0)}% bypassed`,
        detail: `A rolling replacement replaces about ${DEPLOY_BATCH} tasks per batch in this illustrative model. A task's local cache dies with the task, but the replacement is gradual.`,
        meta: { view: "flow" },
      },
      {
        id: "local",
        label: "Task local cache",
        kind: "cache",
        health: incident,
        utilization: clamp(1 - values.bypass),
        throughput: READ_RPS * LOCAL_HIT * (1 - values.bypass),
        sublabel: `${values.affectedTasks} tasks not bypassed`,
        detail: "In-process memory, one copy per task. Redis commands cannot reach it. A bypass flag, versioned key, or task replacement is required.",
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Shared Redis",
        kind: "cache",
        health: redisHealth,
        utilization: clamp(values.redisUtil),
        throughput: values.redisRps,
        capacity: REDIS_CAPACITY,
        sublabel: `${formatCount(values.redisRps)} ops/s`,
        detail: `Bypassing the local cache sends its hits to Redis. Illustrative capacity: ${formatCount(REDIS_CAPACITY)} ops/s.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Primary database",
        kind: "db",
        health: dbHealth,
        utilization: clamp((READ_RPS * 0.05) / 8_000),
        throughput: READ_RPS * 0.05,
        sublabel: `${formatCount(READ_RPS * 0.05)} qps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", READ_RPS / 30_000),
      edge("alb-service", "alb", "service", READ_RPS / 30_000),
      edge("service-local", "service", "local", LOCAL_HIT * (1 - values.bypass), incident),
      edge("local-redis", "local", "redis", clamp(values.redisRps / READ_RPS), redisHealth),
      edge(
        "service-redis",
        "service",
        "redis",
        clamp(values.bypassRps / READ_RPS),
        redisHealth,
        "bypass",
      ),
      edge("redis-db", "redis", "db", 0.05),
    ],
    metrics: [
      metric("stale-error", "Reads with the bad value", values.staleErrorPct, "%", 1, 5, "percent"),
      metric("bypass-stop-seconds", "Bypass stop time", values.bypassStopSeconds, "s", undefined, undefined, "number"),
      metric("purge-seconds", "Bad entries gone (TTL/rollout)", values.purgeSeconds, "s", 50, 100, "number"),
      metric("deploy-seconds", "Rolling replacement time", values.deploySeconds, "s", undefined, undefined, "number"),
      metric("redis-rps", "Redis operations", values.redisRps, " ops/s", undefined, undefined, "rps"),
      metric("redis-p99", "Redis p99", values.redisP99, "ms", undefined, undefined, "ms"),
      metric("bypass-coverage", "Bypass coverage", values.bypass * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${(values.badShare * 100).toFixed(0)}% bad reads, ${(values.bypass * 100).toFixed(0)}% bypassed, ${values.staleErrorPct.toFixed(1)}% still bad, bypass ${values.bypass > 0 ? `stop ${values.bypassStopSeconds.toFixed(0)}s` : "off"}, entries gone in ${values.purgeSeconds.toFixed(0)}s.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const entries: [string, number][] = [
    ["stale-error", values.staleErrorPct],
    ["bypass-stop-seconds", values.bypassStopSeconds],
    ["purge-seconds", values.purgeSeconds],
    ["deploy-seconds", values.deploySeconds],
    ["redis-rps", values.redisRps],
    ["redis-p99", values.redisP99],
    ["bypass-coverage", values.bypass * 100],
  ];
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 7)) / 2.5);
  for (const [id, value] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.0) * Math.max(0.1, value * 0.01)),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-error",
    metricId: "stale-error",
    warn: 1,
    crit: 5,
    title: "A bad cached value is still being served",
    cause:
      "The bad value lives in each task's local memory. A shared-cache flush cannot reach it, and the remaining tasks are still inside the TTL or waiting for a rolling replacement.",
    fix:
      "Turn on the bypass for the affected key, or deploy a versioned key that makes the old entry unreachable. A rolling replacement is slower and does not help tasks that have not been replaced yet.",
    checkFirst: [
      "Confirm the bad value is a local-cache hit, not a Redis or database value.",
      "Check the bypass flag and the tasks that are still reading the old copy.",
      "Check the TTL and the deployment batch size before choosing a rolling replacement.",
    ],
  },
  {
    id: "purge-seconds",
    metricId: "purge-seconds",
    warn: 50,
    crit: 100,
    title: "Bad entries will outlive the incident budget",
    cause:
      "The bypass stops reads but does not erase the entry. The bad value stays in task memory until the TTL expires or a rolling deployment replaces the task, and the last batch sets that completion time.",
    fix:
      "Use the bypass or a versioned key to stop serving immediately, then plan the TTL or rollout for the memory cleanup. Do not describe the bypass as a purge.",
    checkFirst: [
      "Check that the bypass stopped bad reads; then check the TTL and rollout for entry removal.",
      "Compare the deployment batch size and task count with the incident budget.",
      "Check whether the bad value affects one key or the whole key space.",
    ],
  },
];

export const localBypassModel: SimModel = {
  id: "caching-local-bypass",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, values, seed, 0);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const seed = Number(frame.flags.seed ?? 20261110);
    const values = compute(p, 1 + rng.between(-0.002, 0.002));
    const next = buildFrame(p, values, seed, frame.t);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];

    if (reset) {
      next.flags = { seed, paramsKey: key };
      next.series = {};
      seedSeries(next, values, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
      );
    }

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (values.staleErrorPct >= 5 && frame.flags.badValueEvent !== 1) {
      pushEvent(next, {
        id: "local-bypass-bad-value",
        at: frame.t,
        severity: "crit",
        title: "A bad value is still in task memory",
        detail: `${values.affectedTasks} of ${values.tasks} tasks are not bypassed, so they still serve the bad value. A full bypass stops new bad reads in ${values.bypassStopSeconds.toFixed(0)}s; the entries themselves remain until the TTL or rollout (${values.purgeSeconds.toFixed(0)}s).`,
        nodeId: "local",
        metricId: "stale-error",
      });
      next.flags.badValueEvent = 1;
    }
    if (values.staleErrorPct < 1) next.flags.badValueEvent = 0;

    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${values.tasks} tasks each hold their own copy. A Redis flush changes none of them; only a bypass, versioned key, TTL, or task replacement does.`,
      `A rolling replacement with ${DEPLOY_BATCH} tasks per batch at ${REPLACE_SECONDS}s per batch takes ${values.deploySeconds}s before the last task is replaced.`,
      `With ${(values.bypass * 100).toFixed(0)}% bypass coverage, ${values.staleErrorPct.toFixed(1)}% of reads still return the bad value. A full bypass stops new bad reads in about ${values.bypassStopSeconds.toFixed(0)}s, but the entries remain until the TTL or rollout (${values.purgeSeconds.toFixed(0)}s).`,
      `Bypassing sends ${formatCount(values.bypassRps)} reads/s to Redis, raising Redis operations to ${formatCount(values.redisRps)} per second.`,
      `The TTL is ${values.ttl.toFixed(0)}s. It is a worst-case bound, not an operational purge.`,
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
    description: "A small bad-value share, 80% bypass coverage, and a 60s TTL.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Wide rollout",
    description: "More tasks and a wider bad-value share. Recovery enters the warning band.",
    tone: "warn",
    params: defaults({
      taskCount: 16,
      badValueSharePct: 5,
      bypassCoveragePct: 60,
      ttlSeconds: 60,
    }),
  },
  {
    id: "failure",
    label: "No escape hatch",
    description: "Every read gets the bad value; the only exit is a 40-task rolling replacement or the TTL.",
    tone: "crit",
    params: defaults({
      taskCount: 40,
      badValueSharePct: 100,
      bypassCoveragePct: 0,
      ttlSeconds: 600,
    }),
  },
  {
    id: "recovery",
    label: "Bypass on",
    description: "Full bypass coverage stops bad reads in about two seconds; entries expire at the 30s TTL.",
    tone: "ok",
    params: defaults({
      taskCount: 40,
      badValueSharePct: 100,
      bypassCoveragePct: 100,
      ttlSeconds: 30,
    }),
  },
  {
    id: "kill-switch",
    label: "Kill switch",
    description: "The bypass stops a 100% bad value immediately; entries still expire at the 600s TTL.",
    tone: "ok",
    params: defaults({
      taskCount: 12,
      badValueSharePct: 100,
      bypassCoveragePct: 100,
      ttlSeconds: 600,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-rolling-purge",
  title: "Predict how long a rolling replacement takes",
  simId: "local-bypass",
  question:
    "A bad value is on every one of 40 tasks. You replace 4 tasks per batch and each batch takes 15 seconds. How long until the last task is replaced?",
  prediction: {
    options: [
      { id: "fifteen", label: "About 15 seconds, one batch." },
      { id: "sixty", label: "About 60 seconds, one minute of rollout." },
      { id: "one-fifty", label: "About 150 seconds, ten batches." },
      { id: "six-hundred", label: "About 600 seconds, the TTL." },
    ],
    correctOptionId: "one-fifty",
    explanation:
      "Ten batches of four tasks cover 40 tasks. At 15 seconds per batch, the last task is replaced after about 150 seconds. That is longer than a 60-second incident budget and much longer than a runtime bypass. The TTL of 600 seconds is a separate worst-case bound.",
  },
  setup: defaults({
    taskCount: 40,
    badValueSharePct: 100,
    bypassCoveragePct: 0,
    ttlSeconds: 600,
  }),
  runFor: 60,
  observe: [
    "The rolling replacement time is 150 seconds; after 60 simulated seconds the fleet is not clean.",
    "Reads with the bad value stay at 100% because no bypass is on.",
    "Redis operations stay low because every task still uses its local copy.",
    "The entries-gone metric reports 150 seconds, longer than the 60s incident budget.",
    "The TTL is 600 seconds, so waiting for expiry is even slower than the rollout.",
  ],
  explain:
    "A rolling deployment replaces tasks in batches, and only the replaced tasks have an empty local cache. The last batch determines when the fleet is clean. The calculation is task count divided by batch size, rounded up, times the batch duration. A bypass changes the read path immediately; a deployment changes the task population gradually.",
  fix: defaults({
    taskCount: 40,
    badValueSharePct: 100,
    bypassCoveragePct: 100,
    ttlSeconds: 30,
  }),
  debrief:
    "The bypass stopped serving the bad value in about two seconds, while the rolling replacement needed 150. The entry itself remained until the TTL or rollout; the bypass changed who could read it, not what was in memory. The tradeoff is Redis load: bypassing the local cache sent its hits to the shared tier, which stayed inside its illustrative capacity. That is the right emergency trade for a correctness bug. After the data is fixed, remove the bypass and let the local cache refill.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A local cache inside an ECS task is memory owned by that task. It is not shared with other tasks, and it is not reachable by a Redis command. If a bad value is written into that memory, a Redis flush, a database correction, or a new deployment of the shared tier does not remove it. Each task keeps serving the bad value until its local time to live (TTL) expires or the task is replaced. A rolling deployment replaces tasks in batches, so the fleet is only clean after the last batch. A runtime bypass, a versioned key, or a kill switch changes the read path now, without waiting for the task population to turn over.",
  },
  {
    type: "p",
    text: "The escape hatch has to be designed before the incident. A bypass flag read on every request can skip the local cache for a key, a tenant, or the whole service. A versioned key makes old entries unreachable by changing the lookup key. A kill switch can disable the local cache entirely. Each option has a cost: bypassing shifts reads to Redis and can raise latency; versioning changes the key format and needs a version source; a global kill switch is simple but has the largest blast radius. A bypass stops serving the bad value; it does not erase the entry from task memory. The TTL is the final bound, not the plan, because it can be minutes and it is not observable as a purge.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, load balancer, ECS service, task local cache, Redis, database. The control plane is separate: the task definition, the deployment configuration, and the configuration or feature-flag service that the task reads. The local cache lives and dies with the task. A new task starts cold, which is why a rolling replacement temporarily increases Redis load even after the bad value is gone. A bypass is read at request time, so it can take effect on the next request without a deployment, provided every task reads the same flag and the flag service is not cached for too long.",
  },
  {
    type: "compare",
    leftTitle: "Rolling replacement",
    rightTitle: "Runtime bypass",
    rows: [
      {
        label: "Time to effect",
        left: "One batch at a time; the last task sets the completion time",
        right: "Next request after the flag propagates",
      },
      {
        label: "What it changes",
        left: "Replaces the whole task, including unrelated cached entries",
        right: "Stops serving the named keys or scope; entries remain in memory",
      },
      {
        label: "Cost",
        left: "Cold starts and a temporary Redis load increase",
        right: "Redis load and latency for every bypassed read",
      },
      {
        label: "Risk",
        left: "The bad value survives until the last batch",
        right: "A broad bypass can overload the shared tier",
      },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Reads still returning the bad value, split by task and bypass state.",
      "Time until bad reads stop, and time until the entries are gone.",
      "Redis operations and tail latency as bypassed reads move to the shared tier.",
      "Task count and batch size, which set the deployment's completion time.",
      "The TTL as a separate worst-case bound, not as the observed purge.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply No escape hatch. Notice that the bad value persists at 60 seconds even though the deployment is progressing. Apply Bypass on to stop serving it immediately, and watch Redis operations rise. Run the guided experiment to compare the rollout time with the bypass time.",
  },
  {
    type: "table",
    headers: ["Escape hatch", "Time to effect", "Blast radius", "Best use"],
    rows: [
      ["TTL expiry", "Up to the TTL", "Only the affected keys", "A backstop, never the primary mitigation"],
      ["Rolling replacement", "Task count divided by batch size, times batch duration", "The whole task, including unrelated cached entries", "A code or configuration change that must ship"],
      ["Bypass flag", "Next request after propagation", "The named key, tenant, or service", "A bad value that must stop now"],
      ["Versioned key", "Next read with the new version", "The affected key space", "A durable fix that also prevents old entries from returning"],
    ],
  },
  {
    type: "p",
    text: "Two decisions matter more than the tool. First, do you change the task population or the read path? A deployment is gradual and broad; a bypass is immediate and scoped. Second, do you bypass one key or the whole local cache? A narrow bypass protects Redis; a broad one is easier to operate but can turn a cache incident into a shared-tier incident. The model uses illustrative values: 4 tasks per batch, 15 seconds per batch, and a 40,000 operations per second Redis tier. They are not ECS or ElastiCache limits.",
  },
  { type: "sim", simId: "local-bypass" },
  { type: "experiment", experimentId: "predict-rolling-purge" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The bad value was in task memory, so the shared cache correction did not reach it. With no bypass, every task kept serving the old value and the only exit was the TTL or a rolling replacement. The replacement took 150 seconds because it moved four tasks at a time. The bypass stopped new bad reads in about two seconds and moved the local hits to Redis, which stayed within its illustrative capacity. The difference was not the size of the fix; it was whether the fix changed the read path or the task population.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A bad value that survives a Redis flush and a database correction.",
      "Task-level read results split by deployment version and bypass flag.",
      "A deployment that is progressing while the error rate stays flat, because the last batch is not done.",
      "Redis operations rising when the bypass is enabled, especially if the bypass is broad.",
      "New tasks with cold local caches, which add Redis load even after the bad value is gone.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the bad value is a local-cache hit. Check the bypass flag and the tasks that still read the old copy. If the only plan is a deployment, calculate the last-batch time before promising a recovery window.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the bad value is in local memory, not Redis or the database.",
      "Turn on the narrowest bypass that stops the bad reads.",
      "Fix the source data and invalidate the affected keys.",
      "If a deployment is required, calculate the last-batch time and communicate it.",
      "Watch Redis load while the bypass is on and remove it when the data is clean.",
      "Add a test that exercises the bypass during a deployment.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A bypass is fast but shifts read load to Redis and can raise latency while it is on.",
      "A rolling replacement clears all local state but is gradual and causes cold starts.",
      "A versioned key is durable and scoped, but it changes the key format and needs a version source.",
      "A global kill switch is simple to operate but has the largest blast radius.",
      "A short TTL bounds the damage but lowers the hit rate and raises shared-cache load all the time.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-bypass",
    question:
      "A bad value is cached in every ECS task and a Redis flush did not help. What escape hatch do you design?",
    difficulty: 3,
    hints: [
      "The cache is in task memory, not in Redis.",
      "Separate the immediate mitigation from the durable fix.",
    ],
    answer:
      "I would add a runtime bypass that the task reads on every request, scoped to the affected key or tenant, so the next request skips the local cache and reads the corrected shared value. I would make the flag observable and default it off, with a clear owner and an expiry. For the durable fix I would use a versioned key or invalidate on write, so an old local entry cannot be served again. A rolling deployment is the fallback if the bypass cannot be shipped safely; I would calculate the last-batch time before promising it.",
    followUps: [
      "How do you scope the bypass to one key?",
      "What happens to Redis load while it is on?",
      "How do you remove the bypass safely?",
    ],
    redFlags: [
      "Flushes Redis and expects local copies to clear.",
      "Uses a full redeploy as the only mitigation.",
      "Adds a global bypass with no scope or expiry.",
    ],
    rubric: [
      "Recognizes task-local memory.",
      "Names an immediate scoped bypass.",
      "Adds a durable fix.",
      "Calculates or bounds the deployment fallback.",
    ],
  },
  {
    id: "ecs-purge",
    question:
      "Why does a rolling ECS deployment take longer than the first healthy task suggests?",
    difficulty: 3,
    hints: [
      "The fleet is replaced in batches.",
      "The last old task is the completion condition.",
    ],
    answer:
      "A rolling deployment replaces tasks in batches, subject to the service's minimum healthy percent and maximum percent. The first new task can be healthy quickly, but the old tasks that have not been replaced still serve the bad value. The fleet is clean only when the last old task is gone. The time is roughly the number of batches times the batch duration, and it grows with task count. A TTL can be even slower, so neither is a runtime purge.",
    followUps: [
      "How would you shorten the rollout?",
      "What does the deployment circuit breaker change?",
      "Why not scale to zero and back?",
    ],
    redFlags: [
      "Assumes a new task definition clears all tasks at once.",
      "Confuses the first healthy task with fleet completion.",
      "Ignores cold-start load.",
    ],
    rubric: [
      "Explains batching.",
      "Uses the last old task as the completion condition.",
      "Relates time to task count.",
      "Notes cold-start cost.",
    ],
  },
  {
    id: "bypass-risk",
    question:
      "What can go wrong when you turn on a local-cache bypass during an incident?",
    difficulty: 3,
    hints: [
      "The bypass moves traffic, not just correctness.",
      "A flag has a propagation and ownership problem.",
    ],
    answer:
      "The local cache was absorbing most reads, so a broad bypass sends that traffic to Redis. If the shared tier is already near capacity, the mitigation can become a second incident. The flag also has to reach every task; a task that caches the flag for too long keeps serving the bad value. I would scope the bypass to the affected key, set a short flag refresh, watch Redis utilization and p99, and define who removes the flag. A versioned key avoids the broad traffic shift but changes the key format.",
    followUps: [
      "How would you scope a bypass to one tenant?",
      "What flag refresh interval would you use?",
      "How do you test the bypass before the incident?",
    ],
    redFlags: [
      "Turns on a global bypass without checking Redis headroom.",
      "Assumes the flag reaches every task instantly.",
      "Leaves the bypass on after recovery.",
    ],
    rubric: [
      "Names the traffic shift.",
      "Checks shared-tier headroom.",
      "Bounds flag propagation.",
      "Defines removal and testing.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The local cache has a documented bypass, versioned-key path, or kill switch.",
      "The bypass is scoped to a key, tenant, or service, with an owner and an expiry.",
      "Every task reads the flag with a bounded refresh interval.",
      "The shared tier has headroom for the traffic a bypass would shift.",
      "The deployment batch size and last-batch time are known.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the bad value is a local-cache hit, not Redis or the database.",
      "Turn on the narrowest bypass that stops the bad reads.",
      "Watch Redis operations and p99 while the bypass is on.",
      "Fix the source data and invalidate the affected keys.",
      "Record the bypass start time and the observed effect.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove the bypass and confirm it is off on every task.",
      "Verify Redis load and local hit rate after the cache refills.",
      "Reconcile the TTL and the versioning strategy with the fix.",
      "Add a game day that enables the bypass during a deployment.",
    ],
  },
];

const references = [
  {
    title: "Rolling deployment",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-rolling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How ECS replaces tasks in batches during a rolling deployment.",
  },
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside, TTL, and invalidation guidance.",
  },
  {
    title: "Client-side caching",
    url: "https://redis.io/docs/latest/develop/clients/client-side-caching/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Invalidation of local copies when Redis is the shared tier.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "local-bypass": {
      model: localBypassModel,
      presets,
      instructions:
        "Start healthy, then apply No escape hatch. Compare the rolling replacement time with Bypass on. Watch stale reads, time to stop bad reads, entries-gone time, and Redis operations.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The fleet replaces 4 tasks per batch at 15s per batch, reads are 30,000/s, and Redis capacity is 40,000 ops/s. These are not ECS or ElastiCache limits. The TTL is a worst-case bound, not an operational purge.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-coherence",
    "caching-local-cache",
    "caching-hot-key-sharding",
    "deployment-canary-metric-gate",
  ],
};
