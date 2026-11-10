import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_BUSY = 0.12;
const BASE_MS_PER_WRITE = 0.00002;
const TIMEOUT_MS = 500;

const params = [
  {
    id: "writeRps",
    label: "Contended writes",
    min: 100,
    max: 20_000,
    step: 100,
    value: 2_000,
    unit: " /s",
    group: "Traffic",
    help: "Writes per second to the counters protected by the script. They are spread over keys by shard.",
    format: "rps" as const,
  },
  {
    id: "scriptMs",
    label: "Script duration",
    min: 0.1,
    max: 6_000,
    step: 0.1,
    scale: "log" as const,
    value: 1,
    unit: "ms",
    group: "Script",
    help: "Time one EVAL or EVALSHA call holds the command thread. The default lua-time-limit is 5,000ms.",
    format: "ms" as const,
  },
  {
    id: "shardCount",
    label: "Redis shards",
    min: 1,
    max: 12,
    step: 1,
    value: 8,
    unit: "",
    group: "Topology",
    help: "Primaries holding the counters. More shards help only when writes are spread over many keys.",
    format: "count" as const,
  },
  {
    id: "luaShare",
    label: "Lua coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Correctness",
    help: "Share of writes using an atomic script. The rest use a read-modify-write path that can lose updates.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  writeRps: number;
  scriptMs: number;
  shardCount: number;
  luaShare: number;
  writesPerShard: number;
  luaPct: number;
  p99: number;
  errors: number;
  racePct: number;
}

function healthFor(luaPct: number, p99: number, errors: number, racePct: number): "ok" | "warn" | "crit" {
  if (luaPct >= 90 || p99 >= 100 || errors >= 2 || racePct >= 1) return "crit";
  if (luaPct >= 70 || p99 >= 20 || errors >= 0.5 || racePct >= 0.1) return "warn";
  return "ok";
}

function compute(p: Params, scale = 1): Computed {
  const writeRps = Math.max(1, num(p, "writeRps", 2_000)) * scale;
  const scriptMs = Math.max(0.1, num(p, "scriptMs", 1));
  const shardCount = Math.max(1, Math.round(num(p, "shardCount", 8)));
  const luaShare = clamp(num(p, "luaShare", 100) / 100);
  const writesPerShard = writeRps / shardCount;
  const baseBusy = BASE_BUSY + writesPerShard * BASE_MS_PER_WRITE;
  const luaBusy = (writesPerShard * luaShare * scriptMs) / 1_000;
  const busy = baseBusy + luaBusy;
  const queueFactor = busy < 0.98 ? busy / (1 - busy) : 50;
  const queuePenalty = queueFactor * 0.25;
  const scriptTerm = luaShare > 0 ? scriptMs * (0.5 + 10 * queueFactor) : 0;
  const p99 = Math.min(10_000, 1.2 + queuePenalty + scriptTerm);
  const errors = p99 > TIMEOUT_MS ? Math.min(25, (p99 - TIMEOUT_MS) / 50) : 0;
  const racePct = (1 - luaShare) * Math.min(15, (writesPerShard / 1_000) * 2);
  return {
    writeRps,
    scriptMs,
    shardCount,
    luaShare,
    writesPerShard,
    luaPct: Math.min(140, luaBusy * 100),
    p99,
    errors,
    racePct,
  };
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const health = healthFor(values.luaPct, values.p99, values.errors, values.racePct);
  const serviceHealth = health === "crit" ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: values.writeRps,
        sublabel: `${Math.round(values.writeRps).toLocaleString("en-US")} writes/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Rate-limit service",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(values.writeRps / 20_000),
        throughput: values.writeRps,
        sublabel: health === "ok" ? "within SLO" : "waiting on the script",
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis primary",
        kind: "cache",
        health,
        utilization: clamp(values.luaPct / 100),
        throughput: values.writeRps,
        sublabel: `${values.luaPct.toFixed(0)}% in scripts`,
        detail: `Each script is atomic, so the shard runs no other command while it executes. ${values.writesPerShard.toFixed(0)} writes/shard at ${values.scriptMs.toFixed(1)}ms per script.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-service", "client", "service", values.writeRps / 20_000),
      edge("service-redis", "service", "redis", values.writeRps / 20_000, health),
    ],
    metrics: [
      metric("script-busy", "Event loop in scripts", values.luaPct, "%", 70, 90, "percent"),
      metric("redis-p99", "Script p99", values.p99, "ms", 20, 100, "ms"),
      metric("redis-errors", "Redis timeouts", values.errors, "%", 0.5, 2, "percent"),
      metric("lost-updates", "Lost updates", values.racePct, "%", 0.1, 1, "percent"),
      metric("script-ms", "Script duration", values.scriptMs, "ms", undefined, undefined, "ms"),
      metric("lua-coverage", "Lua coverage", values.luaShare * 100, "%", undefined, undefined, "percent"),
      metric("writes-per-shard", "Writes per shard", values.writesPerShard, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.luaPct.toFixed(0)}% of the shard's second is inside scripts; p99 ${values.p99.toFixed(0)}ms; ${values.racePct.toFixed(1)}% lost updates.`,
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
    id: "script-busy",
    metricId: "script-busy",
    warn: 70,
    crit: 90,
    title: "Lua scripts are consuming the shard's command thread",
    cause:
      "Every script runs atomically, so no other command executes while it runs. At a high write rate, script duration becomes the shard's throughput limit.",
    fix:
      "Shorten the script, reduce the writes per shard, or replace the script with a single atomic command where one exists. Adding shards helps only when the writes are spread over many keys.",
    checkFirst: [
      "Check the script's runtime and the writes per shard.",
      "Read `SLOWLOG GET` for EVAL or EVALSHA entries.",
      "Check whether one counter key receives all the writes.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 20,
    crit: 100,
    title: "Script latency is now the request path",
    cause:
      "A client that arrives during a script waits for it to finish. The p99 follows the script duration and the queue in front of it, not the average command cost.",
    fix:
      "Bound the script's work and keep the hot path to a single command. If the operation is genuinely long, move it out of the request path or split it into idempotent steps.",
    checkFirst: [
      "Compare p99 with script duration and the write rate per shard.",
      "Check whether the slow spans are EVAL or EVALSHA calls.",
      "Check whether retries are arriving during the script and extending the queue.",
    ],
  },
  {
    id: "redis-errors",
    metricId: "redis-errors",
    warn: 0.5,
    crit: 2,
    title: "Clients are timing out behind the script",
    cause:
      "The script outlasted the client timeout. Retries queue behind the same atomic section, so the timeout rate can stay elevated after the script returns.",
    fix:
      "Stop the retry amplification, reduce script duration, and add a bounded fallback. Raising the client timeout does not shorten the block.",
    checkFirst: [
      "Separate Redis BUSY replies from client-side timeouts.",
      "Check retry volume and connection-pool wait.",
      "Confirm whether the timeouts started with the script change.",
    ],
  },
  {
    id: "lost-updates",
    metricId: "lost-updates",
    warn: 0.1,
    crit: 1,
    title: "Concurrent read-modify-write is losing updates",
    cause:
      "Part of the write path reads a value and writes it back without atomicity. Two clients can read the same value and overwrite each other's update.",
    fix:
      "Use a single atomic command such as INCR or HINCRBY where it fits. Otherwise use a Lua script, or WATCH/MULTI/EXEC with a bounded retry, and measure the retry cost.",
    checkFirst: [
      "Check whether the affected operation is a read-modify-write.",
      "Compare the number of acknowledged writes with the observed counter.",
      "Check whether the service retries or recomputes the value before writing.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const luaModel: SimModel = {
  id: "caching-lua-atomicity",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, compute(p));
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const noise = 1 + rng.between(-0.003, 0.003);
    const values = compute(p, noise);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    next.series = { ...frame.series };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.luaShare > 0 && values.luaPct >= 70 && frame.flags.scriptStallSeen !== 1) {
      pushEvent(next, {
        id: "script-stall",
        at: frame.t,
        severity: values.luaPct >= 90 ? "crit" : "warn",
        title: "The atomic script is holding the shard",
        detail: `${values.writesPerShard.toFixed(0)} scripts/shard at ${values.scriptMs.toFixed(1)}ms occupy ${values.luaPct.toFixed(0)}% of the command thread.`,
        nodeId: "redis",
        metricId: "script-busy",
      });
      next.flags.scriptStallSeen = 1;
    }
    if (values.luaPct < 70 || values.luaShare === 0) next.flags.scriptStallSeen = 0;
    if (values.racePct >= 0.1 && frame.flags.raceSeen !== 1) {
      pushEvent(next, {
        id: "lost-update-detected",
        at: frame.t,
        severity: values.racePct >= 1 ? "crit" : "warn",
        title: "Non-atomic writes are losing updates",
        detail: `${Math.round((1 - values.luaShare) * 100)}% of writes use read-modify-write; the model estimates ${values.racePct.toFixed(1)}% lost updates.`,
        nodeId: "redis",
        metricId: "lost-updates",
      });
      next.flags.raceSeen = 1;
    }
    if (values.racePct < 0.1) next.flags.raceSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.luaPct.toFixed(0)}% of the shard's second is inside scripts; p99 ${values.p99.toFixed(0)}ms; ${values.racePct.toFixed(1)}% lost updates.`;
    next.events = next.events.slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `At ${values.writesPerShard.toFixed(0)} writes/shard and ${values.scriptMs.toFixed(1)}ms per script, Lua occupies ${values.luaPct.toFixed(0)}% of the shard's second.`,
      `p99 is ${values.p99.toFixed(0)}ms. Atomicity is cheap only while the script stays short; the guarantee does not remove the runtime.`,
      `Lua covers ${Math.round(values.luaShare * 100)}% of writes. The model estimates ${values.racePct.toFixed(1)}% lost updates on the uncovered read-modify-write path.`,
      "Atomic means no other command observes an intermediate state. It does not mean rollback: a script that writes and then fails leaves those writes in place.",
    ];
    if (values.scriptMs >= 5_000) {
      items.push(
        "The default lua-time-limit is 5,000ms. Past it Redis replies BUSY to other clients but does not terminate the script; SCRIPT KILL works only if the script has not written.",
      );
    }
    items.push(
      "If every write targets one key, adding shards cannot spread the script. This model spreads writes over counters that map to different shards.",
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
    description: "A 1ms script covers every write at a modest rate across eight shards.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A longer script and more writes per shard push p99 into the warning band.",
    tone: "warn",
    params: defaults({ writeRps: 4_000, scriptMs: 1.2 }),
  },
  {
    id: "failure",
    label: "Failure",
    description: "A 12ms script on four shards consumes the command thread.",
    tone: "crit",
    params: defaults({ writeRps: 4_000, shardCount: 4, scriptMs: 12 }),
  },
  {
    id: "recovery",
    label: "Bound the script",
    description: "The same write rate with a 1ms script and eight shards returns to healthy.",
    tone: "ok",
    params: defaults({ writeRps: 4_000, scriptMs: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-rmw-race",
  title: "Predict what breaks without Lua",
  simId: "lua",
  question:
    "Set Lua coverage to 0% and send 4,000 writes per second across four shards. What fails first?",
  prediction: {
    options: [
      { id: "latency", label: "Latency, because read-modify-write is slower than Lua" },
      { id: "correctness", label: "Correctness: concurrent writes lose updates" },
      { id: "memory", label: "Memory, because the script cache grows" },
      { id: "cpu", label: "Redis CPU reaches 100% and sheds commands" },
    ],
    correctOptionId: "correctness",
    explanation:
      "Without a script, each writer reads the counter, computes a new value, and writes it back. Two writers can read the same value before either writes, so one update overwrites the other. The counter remains fast; it is simply wrong.",
  },
  setup: defaults({ writeRps: 4_000, shardCount: 4, scriptMs: 1, luaShare: 0 }),
  runFor: 20,
  observe: [
    "Lost updates reach about 2% while p99 stays near 1ms.",
    "Script occupancy stays at 0%, so the incident is invisible in the script metric.",
    "No client timeouts appear; the service believes every write succeeded.",
    "The counter's value disagrees with the number of acknowledged increments.",
  ],
  explain:
    "The read-modify-write path is not atomic. At 1,000 writes per shard, two clients can read the same counter before either writes the new value, and the later write discards the earlier update. Lua removes the race because no other command runs between the read and the write inside the script.",
  fix: defaults({ writeRps: 4_000, shardCount: 4, scriptMs: 0.5, luaShare: 100 }),
  debrief:
    "Covering the writes with a 0.5ms script removes the lost updates while keeping p99 near 10ms. The same atomicity at 12ms would consume more than the shard's second and turn a correctness fix into a latency incident. Atomicity and blocking are the same property seen from two sides: the script cannot be interleaved, so its runtime belongs to every client on the shard.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis can execute a Lua script on the server through `EVAL` or `EVALSHA`. Redis guarantees atomic execution: while the script runs, no other command on that shard runs, and no client observes a half-applied update. That property is useful for read-modify-write logic that must not interleave, such as a rate limiter, an inventory decrement, or a compare-and-set.",
  },
  {
    type: "p",
    text: "Atomic is not the same as free. The script runs on the shard's command thread, so its entire runtime is a critical section for every other client. A script that fixes a race by scanning a large collection can turn a rare wrong answer into a sustained latency incident. Atomic is also not rollback: if a script writes and then raises an error, the writes that already happened remain.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The script runs inside Redis, not inside the service. The request path is client, service, then a single EVAL or EVALSHA call. Moving the logic into Redis removes network round trips and the interleaving window, but adds the script's runtime to the shard's serial command path. The same logic in the service is not atomic; the same logic as a single command such as INCR is atomic and usually cheaper.",
  },
  {
    type: "table",
    headers: ["Approach", "Correctness under concurrency", "Cost"],
    rows: [
      ["GET, modify, SET in the service", "Lost updates when two clients interleave", "Round trips, no server-side block"],
      ["Lua EVAL or EVALSHA", "Atomic read-modify-write", "The shard is blocked for the whole script"],
      ["WATCH, MULTI, EXEC", "Optimistic; the transaction aborts on conflict", "Retries under contention, no long block"],
      ["INCR or HINCRBY", "Atomic at command granularity", "Only fits operations a single command can express"],
    ],
  },
  {
    type: "p",
    text: "This module models counters spread over one to twelve shards. Writes per shard are the write rate divided by the shard count; that assumption holds only when the keys are spread across shards. If every write targets one counter key, the key lives on one shard and adding shards cannot help. The model's lost-update percentage is an illustrative teaching value derived from writes per shard, not a measured Redis error rate.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Event loop in scripts: the share of the shard's second spent inside atomic sections.",
      "Script p99: the wait for clients that arrive while a script is running.",
      "Lost updates: what the non-atomic path costs in correctness rather than latency.",
      "Client timeouts: the point where the script outlasts the request budget.",
      "Script duration and writes per shard: the two inputs that decide whether atomicity is cheap.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Peak and Failure to see the same atomic guarantee become a stall. Run the experiment with Lua coverage at zero to see the opposite failure: fast and wrong. Apply the fix to compare a short script with a long one at the same write rate.",
  },
  {
    type: "p",
    text: "Operationally, `EVALSHA` avoids resending the script body by referencing its SHA1. The script cache can be lost after a restart or failover, so the client must handle `NOSCRIPT` by reloading with `SCRIPT LOAD` or falling back to `EVAL`. `lua-time-limit` defaults to 5,000ms: after that Redis starts replying `BUSY` to other clients, but it does not terminate the script. `SCRIPT KILL` can stop only a script that has not written; a write script that will not finish leaves shutdown or failover as the remaining options.",
  },
  { type: "sim", simId: "lua" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The script ran atomically, so the counter was correct. It also held the shard's command thread for its entire runtime. At a high write rate, those runtimes added up until the thread had no idle time, and every client waited behind the current script. p99 and timeouts followed the script duration, not the number of keys or the size of the value.",
  },
  {
    type: "p",
    text: "With Lua coverage at zero, the opposite failure appeared. The reads and writes interleaved, and updates were lost while CPU stayed low and timeouts stayed at zero. The service could not see the bug in its latency metrics because the operation was fast; it was simply not atomic.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Redis: `SLOWLOG GET` shows EVAL or EVALSHA entries with their duration; `INFO commandstats` shows calls and usec per call for the script commands.",
      "Redis: `SCRIPT EXISTS sha` tells you whether the cache still holds the script; `NOSCRIPT` errors point to a restart or failover.",
      "Redis: `CLIENT LIST` shows connected clients and the command each is running; `LATENCY HISTORY` returns events from the latency monitor when it is enabled.",
      "ElastiCache: `EngineCPUUtilization` and `CurrConnections` describe the shard, but a short script incident can hide inside a minute average.",
      "Application: a counter or inventory value that disagrees with the number of acknowledged operations is the correctness signal, not a latency chart.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check script duration and writes per shard before you change the script. If the symptom is wrong values rather than slow responses, check whether the write path is a read-modify-write and whether every writer uses the same atomic path.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the script's runtime, call rate, and the shard it runs on.",
      "Replace the script with a single atomic command such as INCR or HINCRBY when the operation fits.",
      "If a script is required, bound its work: no unbounded loops, no large collection scans, and a fixed number of keys.",
      "Keep the script idempotent where possible, and handle partial failure explicitly because Redis does not roll back.",
      "Load scripts with `SCRIPT LOAD` and call `EVALSHA`, with a `NOSCRIPT` fallback to `EVAL`.",
      "Re-run at peak and verify p99, timeouts, event-loop occupancy, and the counter's value together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Lua gives atomicity at the cost of a shard-wide block; the longer the script, the more clients wait.",
      "Giving up atomicity requires idempotency keys, versioning, or optimistic retry to avoid lost updates.",
      "WATCH/MULTI/EXEC avoids a long block but retries under contention and can starve under high write rates.",
      "EVALSHA saves bandwidth but depends on a cache that can disappear after failover.",
      "Sharding spreads scripts only when the keys are spread; one hot counter still lands on one shard.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "lua-correctness-cost",
    question:
      "A Lua script fixes a lost-update race but raises p99 from 4ms to 120ms. How do you decide whether to keep it?",
    difficulty: 3,
    hints: [
      "Compare the script duration with the write rate per shard.",
      "Look for a single command that expresses the same operation.",
    ],
    answer:
      "I would keep the correctness guarantee but change its implementation. First I would confirm the script duration and the writes per shard; if the script occupies most of the shard's second, the block is structural, not a tail event. Then I would look for a single atomic command such as INCR or HINCRBY that expresses the update without a script. If a script is still required, I would bound its work, reduce the keys it touches, or split the operation into idempotent steps. I would not remove atomicity without adding versioning or idempotency, because the original race would return.",
    followUps: [
      "What if the operation must touch three keys?",
      "How would you verify the race is actually fixed?",
      "What does `SCRIPT KILL` do to a script that has written?",
    ],
    redFlags: [
      "Removes the script and reintroduces the race.",
      "Raises the client timeout.",
      "Assumes atomic means rollback.",
    ],
    rubric: [
      "Quantifies script duration against write rate.",
      "Prefers a single atomic command.",
      "Bounds the script if it stays.",
      "Preserves correctness during the fix.",
    ],
  },
  {
    id: "atomic-guarantees",
    question:
      "What does Redis guarantee about a Lua script's atomicity, and what does it not guarantee?",
    difficulty: 2,
    hints: [
      "Think about interleaving, rollback, and runtime.",
      "The script runs on the same command thread as everything else.",
    ],
    answer:
      "Redis guarantees that no other command runs while the script executes, so clients cannot observe an intermediate state and the script's reads and writes are not interleaved. It does not guarantee that the script is fast, that it can be rolled back, or that it will be terminated at a deadline. If a script writes and then errors, the earlier writes remain. If it runs past `lua-time-limit`, Redis replies BUSY to other clients but keeps running the script; `SCRIPT KILL` works only when the script has not written.",
    followUps: [
      "How does WATCH/MULTI/EXEC differ?",
      "What happens to the script cache after failover?",
      "Why can a read-only script be killed but a write script not?",
    ],
    redFlags: [
      "Says Lua provides rollback.",
      "Says Redis kills a script at the time limit.",
      "Confuses atomicity with isolation from latency.",
    ],
    rubric: [
      "States no interleaving.",
      "States no rollback.",
      "Explains the busy limit.",
      "Explains SCRIPT KILL limits.",
    ],
  },
  {
    id: "operate-scripts",
    question:
      "How do you operate Lua scripts safely across restarts and failovers?",
    difficulty: 3,
    hints: [
      "The script cache is not durable.",
      "The client must have a fallback path.",
    ],
    answer:
      "I would load scripts with `SCRIPT LOAD` at startup and call `EVALSHA`, with a `NOSCRIPT` fallback that reloads and retries once. I would version the script body and keep it in source control, and I would test the fallback after a failover, not only on a fresh start. I would monitor EVAL and EVALSHA duration in the slowlog and commandstats, and set a bounded client timeout. For long scripts I would avoid writes that cannot be killed, because `SCRIPT KILL` cannot stop a script that has modified the dataset.",
    followUps: [
      "What does the client do on NOSCRIPT?",
      "How do you roll out a script change safely?",
      "When would you choose a module or a different data model instead?",
    ],
    redFlags: [
      "Assumes the script cache survives failover.",
      "Has no NOSCRIPT fallback.",
      "Uses a long write script without a kill plan.",
    ],
    rubric: [
      "Uses SCRIPT LOAD and EVALSHA.",
      "Handles NOSCRIPT.",
      "Monitors duration.",
      "Names the kill limitation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every script has a bounded runtime and a documented maximum number of keys.",
      "Scripts are loaded with SCRIPT LOAD and called with EVALSHA; NOSCRIPT has a tested fallback.",
      "The slowlog and commandstats include EVAL and EVALSHA, and dashboards show script p99.",
      "The team knows that SCRIPT KILL cannot stop a script that has written.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the script duration and writes per shard before changing capacity.",
      "Check whether retries are arriving during the script and extending the queue.",
      "Prefer a single atomic command or a shorter script over a longer timeout.",
      "Protect the service with a bounded fallback while the script is fixed.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the counter's value against acknowledged writes, not only latency.",
      "Re-run the peak load with the new script and confirm p99 and timeouts.",
      "Record the script's key count and runtime budget in the runbook.",
      "Add a regression test for the race the script was meant to fix.",
    ],
  },
];

const references = [
  {
    title: "Scripting with Lua",
    url: "https://redis.io/docs/latest/develop/programmability/eval-intro/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Atomic execution, script cache, SCRIPT KILL, and blocking behavior.",
  },
  {
    title: "EVAL",
    url: "https://redis.io/docs/latest/commands/eval/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Script invocation, keys and arguments, and return values.",
  },
  {
    title: "Diagnosing latency issues",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Why the single-threaded command path makes script duration a shard-wide cost.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    lua: {
      model: luaModel,
      presets,
      instructions:
        "Start healthy, then lengthen the script or raise writes per shard. Compare script occupancy with p99, then set Lua coverage to zero to see the correctness failure instead.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Script duration and lost-update rates are teaching values, not measured Redis behavior.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-slow-commands",
    "caching-big-keys",
    "caching-connection-pool",
    "caching-redis-data-types",
  ],
};
