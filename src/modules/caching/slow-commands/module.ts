import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SCAN_KEYS_PER_MS = 10_000;
const BASE_OP_US = 8;
const SLOWLOG_MS = 10;

const params = [
  {
    id: "keyspaceM",
    label: "Keyspace size",
    min: 1,
    max: 50,
    step: 1,
    value: 10,
    unit: "M keys",
    group: "Keyspace",
    help: "Total keys in the database. A KEYS call touches all of them; SCAN walks them in batches.",
    format: "count" as const,
  },
  {
    id: "keysCalls",
    label: "Debug full scans",
    min: 1,
    max: 60,
    step: 1,
    value: 1,
    unit: " /min",
    group: "Debug script",
    help: "Full keyspace iterations per minute. A KEYS call is one iteration; a SCAN loop is many calls.",
    format: "number" as const,
  },
  {
    id: "scanCount",
    label: "SCAN COUNT (0 = KEYS)",
    min: 0,
    max: 5_000,
    step: 100,
    value: 500,
    unit: " keys",
    group: "Debug script",
    help: "Keys per SCAN call. COUNT is a hint, not a hard limit. Zero switches the script to KEYS.",
    format: "count" as const,
  },
  {
    id: "otherOps",
    label: "Application commands",
    min: 10_000,
    max: 150_000,
    step: 5_000,
    value: 40_000,
    unit: " ops/s",
    group: "Traffic",
    help: "Normal Redis commands per second. They share the same command thread as the debug scan.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatBlock(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 10) return `${ms.toFixed(1)}ms`;
  return `${Math.round(ms)}ms`;
}

interface Computed {
  keyspaceM: number;
  keysCalls: number;
  scanCount: number;
  otherOps: number;
  useKeys: boolean;
  batchMs: number;
  blockShare: number;
  loopBusy: number;
  p99: number;
  timeouts: number;
  iterationCalls: number;
  iterationMs: number;
  scanCallsPerSec: number;
  commandsPerSec: number;
  slowlogPerMin: number;
}

function healthFor(blockMs: number, p99: number, timeouts: number, loopBusy: number): "ok" | "warn" | "crit" {
  if (blockMs >= 800 || p99 >= 500 || timeouts >= 2 || loopBusy >= 0.95) return "crit";
  if (blockMs >= 100 || p99 >= 50 || timeouts >= 0.5 || loopBusy >= 0.8) return "warn";
  return "ok";
}

function compute(p: Params, scale = 1): Computed {
  const keyspaceM = Math.max(1, num(p, "keyspaceM", 10));
  const keysCalls = Math.max(1, num(p, "keysCalls", 1));
  const scanCount = Math.max(0, Math.round(num(p, "scanCount", 500)));
  const otherOps = Math.max(1, num(p, "otherOps", 40_000)) * scale;
  const keys = keyspaceM * 1_000_000;
  const callsPerSec = keysCalls / 60;
  const useKeys = scanCount === 0;
  const batchKeys = useKeys ? keys : scanCount;
  const batchMs = batchKeys / SCAN_KEYS_PER_MS + (useKeys ? 0 : 0.05);
  const iterationCalls = useKeys ? 1 : Math.ceil(keys / scanCount);
  const iterationMs = iterationCalls * batchMs;
  const blockShare = clamp((callsPerSec * iterationMs) / 1_000, 0, 1.5);
  const baseBusy = (otherOps * BASE_OP_US) / 1_000_000;
  const loopBusy = baseBusy + blockShare;
  const blockWait = blockShare > 0.01 ? batchMs * (1 - 0.01 / blockShare) : batchMs * blockShare;
  const queuePenalty =
    loopBusy >= 1 ? (loopBusy - 1) * 20_000 : (loopBusy / Math.max(0.05, 1 - loopBusy)) * 2;
  const p99 = Math.min(10_000, 1.2 + blockWait + queuePenalty);
  const timeouts =
    batchMs >= 50
      ? Math.min(30, blockShare * 30)
      : loopBusy >= 1
        ? Math.min(30, (loopBusy - 1) * 40)
        : 0;
  const slowlogPerMin = useKeys ? keysCalls : batchMs >= SLOWLOG_MS ? keysCalls * iterationCalls : 0;
  const scanCallsPerSec = iterationCalls * callsPerSec;
  return {
    keyspaceM,
    keysCalls,
    scanCount,
    otherOps,
    useKeys,
    batchMs,
    blockShare,
    loopBusy,
    p99,
    timeouts,
    iterationCalls,
    iterationMs,
    scanCallsPerSec,
    commandsPerSec: otherOps + scanCallsPerSec,
    slowlogPerMin,
  };
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const health = healthFor(values.batchMs, values.p99, values.timeouts, values.loopBusy);
  const loopPct = Math.min(140, values.loopBusy * 100);
  const debugHealth =
    values.batchMs >= 800 ? "crit" : values.batchMs >= 100 || values.timeouts >= 0.5 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Application clients",
        kind: "client",
        health: "ok",
        throughput: values.otherOps,
        sublabel: `${Math.round(values.otherOps).toLocaleString("en-US")} commands/s`,
        meta: { view: "flow" },
      },
      {
        id: "debug",
        label: "Debug script",
        kind: "service",
        health: debugHealth,
        sublabel: values.useKeys
          ? `KEYS * ${values.keysCalls}/min`
          : `SCAN COUNT ${values.scanCount} ${values.keysCalls}/min`,
        detail: values.useKeys
          ? `One call scans all ${values.keyspaceM}M keys. Illustrative scan rate: ${SCAN_KEYS_PER_MS.toLocaleString("en-US")} keys/ms.`
          : `A full iteration needs about ${Math.round(values.iterationCalls).toLocaleString("en-US")} calls of about ${values.batchMs.toFixed(2)}ms each. Illustrative scan rate: ${SCAN_KEYS_PER_MS.toLocaleString("en-US")} keys/ms.`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis primary",
        kind: "cache",
        health,
        utilization: clamp(values.loopBusy),
        throughput: values.commandsPerSec,
        sublabel: `${loopPct.toFixed(0)}% event loop busy`,
        detail: `The command thread serves application traffic and the debug scan in sequence. Longest block in this model: ${formatBlock(values.batchMs)}.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-redis", "client", "redis", values.otherOps / 150_000),
      edge("debug-redis", "debug", "redis", clamp(values.scanCallsPerSec / 1_000), debugHealth),
    ],
    metrics: [
      metric("command-block-ms", "Longest command block", values.batchMs, "ms", 100, 800, "ms"),
      metric("redis-p99", "Application p99", values.p99, "ms", 50, 500, "ms"),
      metric("redis-timeouts", "Client timeouts", values.timeouts, "%", 0.5, 2, "percent"),
      metric("event-loop", "Event loop busy", loopPct, "%", 80, 95, "percent"),
      metric("slowlog", "Slowlog entries", values.slowlogPerMin, "/min", undefined, undefined, "number"),
      metric("scan-calls", "Debug commands", values.scanCallsPerSec, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `Event loop ${loopPct.toFixed(0)}% busy; longest block ${formatBlock(values.batchMs)}; p99 ${values.p99.toFixed(0)}ms; ${values.timeouts.toFixed(1)}% timeouts.`,
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
    id: "command-block-ms",
    metricId: "command-block-ms",
    warn: 100,
    crit: 800,
    title: "One command is holding the event loop for too long",
    cause:
      "An O(N) command is scanning the keyspace or a large collection in a single call. Every other client on the shard waits until that call finishes.",
    fix:
      "Replace the command with an incremental form such as SCAN or HSCAN, bound the batch size, and rate-limit the caller. Do not raise the client timeout to cover the block.",
    checkFirst: [
      "Read `SLOWLOG GET` and match the timestamp to the latency spike.",
      "Check `INFO commandstats` for commands with high usec per call.",
      "Find the caller: a cron job, an admin script, or an endpoint that runs the command.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 50,
    crit: 500,
    title: "Application p99 tracks the blocking command",
    cause:
      "Requests that arrive during the block wait for the remainder of the scan. The average event-loop utilization can stay below 60% while p99 follows the block time.",
    fix:
      "Bound the per-call work and spread it over time. Verify p99 for commands that do not share the debug script's command.",
    checkFirst: [
      "Compare the spike timestamps with the debug script schedule.",
      "Check whether p99 is flat between spikes and rises at a fixed interval.",
      "Confirm the slow spans are waiting on Redis, not on the database.",
    ],
  },
  {
    id: "redis-timeouts",
    metricId: "redis-timeouts",
    warn: 0.5,
    crit: 2,
    title: "Blocked clients are timing out",
    cause:
      "The scan outlasted the client timeout. Retries arrive while the scan is still running, so they queue behind the same block and can extend the incident.",
    fix:
      "Stop the scan first, then drain retries with a bounded budget. Replace the command before re-enabling the tool or schedule it against a replica.",
    checkFirst: [
      "Separate Redis server errors from client-side timeout errors.",
      "Check retry volume and connection-pool wait during the spike.",
      "Confirm whether the timeouts align with the scan interval.",
    ],
  },
  {
    id: "event-loop",
    metricId: "event-loop",
    warn: 80,
    crit: 95,
    title: "The command thread is saturated",
    cause:
      "Frequent scans or a very small SCAN COUNT add enough command overhead to consume the shard's second. The work is split into many calls, but the total cost still exceeds capacity.",
    fix:
      "Increase COUNT to reduce per-call overhead, reduce scan frequency, or move the scan off the primary. A smaller COUNT is not automatically gentler.",
    checkFirst: [
      "Compare the number of debug calls per second with application commands per second.",
      "Check whether a recent change lowered COUNT or raised the scan frequency.",
      "Check per-shard CPU and command counts, not only the cluster average.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const slowCommandModel: SimModel = {
  id: "caching-slow-commands",
  visual: "flow",
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
    if (values.batchMs >= 100 && frame.flags.slowCommandSeen !== 1) {
      pushEvent(next, {
        id: "slow-command-detected",
        at: frame.t,
        severity: values.batchMs >= 800 ? "crit" : "warn",
        title: "A single command is blocking the shard",
        detail: `The debug scan holds the command thread for about ${formatBlock(values.batchMs)} per call. Application p99 is ${values.p99.toFixed(0)}ms.`,
        nodeId: "redis",
        metricId: "command-block-ms",
      });
      next.flags.slowCommandSeen = 1;
    }
    if (values.batchMs < 100) next.flags.slowCommandSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Event loop ${Math.min(140, values.loopBusy * 100).toFixed(0)}% busy; longest block ${formatBlock(values.batchMs)}; p99 ${values.p99.toFixed(0)}ms; ${values.timeouts.toFixed(1)}% timeouts.`;
    next.events = next.events.slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const loopPct = Math.min(140, values.loopBusy * 100);
    const items = [
      `The event loop is ${loopPct.toFixed(0)}% busy on average, but ${(values.blockShare * 100).toFixed(1)}% of the second is inside ${formatBlock(values.batchMs)} ${values.useKeys ? "KEYS" : "SCAN"} calls.`,
      `p99 is ${values.p99.toFixed(0)}ms. A request that arrives inside a block waits for the remainder, so p99 follows block time, not average CPU.`,
      values.useKeys
        ? `KEYS scans all ${values.keyspaceM}M keys in one call. The whole scan is a single critical section.`
        : `COUNT ${values.scanCount} bounds one call to about ${values.batchMs.toFixed(2)}ms but needs about ${Math.round(values.iterationCalls).toLocaleString("en-US")} calls for a full iteration.`,
      `The debug script issues ${values.scanCallsPerSec.toFixed(1)} commands/s; application traffic is ${Math.round(values.otherOps).toLocaleString("en-US")} commands/s.`,
      `About ${values.slowlogPerMin.toFixed(0)} entries per minute cross the default 10ms slowlog threshold in this model.`,
    ];
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
    description: "A SCAN loop with COUNT 500 walks the keyspace in small batches.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 5M-key primary runs KEYS twice a minute; p99 reaches the warning band.",
    tone: "warn",
    params: defaults({ keyspaceM: 5, keysCalls: 2, scanCount: 0, otherOps: 60_000 }),
  },
  {
    id: "failure",
    label: "Failure",
    description: "KEYS on 10M keys six times a minute blocks every client for about a second.",
    tone: "crit",
    params: defaults({ keyspaceM: 10, keysCalls: 6, scanCount: 0, otherOps: 60_000 }),
  },
  {
    id: "scan",
    label: "Use SCAN",
    description: "Replace KEYS with a bounded SCAN loop; per-call block time collapses.",
    tone: "info",
    params: defaults({ keyspaceM: 10, keysCalls: 6, scanCount: 500, otherOps: 60_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A larger COUNT and less application traffic return the shard to healthy.",
    tone: "ok",
    params: defaults({ keyspaceM: 10, keysCalls: 6, scanCount: 1_000, otherOps: 40_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-keys-block",
  title: "Predict the latency signature of KEYS",
  simId: "slow-commands",
  question:
    "A debug script runs `KEYS *` on a 10M-key primary six times a minute. What happens to p99 for requests that never call KEYS?",
  prediction: {
    options: [
      { id: "flat", label: "It stays near 1ms because average event-loop utilization is under 60%" },
      { id: "block", label: "It rises to roughly the KEYS block time when requests arrive during a scan" },
      { id: "debug-only", label: "Only the debug script sees latency" },
      { id: "all-shards", label: "Every shard in the cluster slows down equally" },
    ],
    correctOptionId: "block",
    explanation:
      "The scan is a single critical section on one shard. Requests that arrive during it wait for the remainder, so their latency is bounded by the block, not by their own command cost. The average utilization stays low because the block occupies only part of each minute.",
  },
  setup: defaults({ keyspaceM: 10, keysCalls: 6, scanCount: 0, otherOps: 60_000 }),
  runFor: 20,
  observe: [
    "The event-loop metric is about 58% busy, below the critical band.",
    "The longest command block is about 1,000ms and p99 is about 900ms.",
    "Client timeouts reach about 3%, and every timeout aligns with a scan.",
    "Other shards are unaffected in a clustered deployment; this model shows one primary.",
  ],
  explain:
    "Redis serves a shard's commands in sequence. KEYS scans the whole keyspace in one call, so no other command on that shard runs until it completes. A request that arrives near the start of the scan waits almost the full block. p99 therefore tracks the block time even when the minute-average CPU is modest.",
  fix: defaults({ keyspaceM: 10, keysCalls: 6, scanCount: 1_000, otherOps: 60_000 }),
  debrief:
    "SCAN bounds each call to roughly COUNT keys, so the longest block falls to a fraction of a millisecond and p99 returns to single-digit milliseconds. The total work of one full iteration is still O(N); a small COUNT just moves the cost into more calls and more overhead. That overhead is why COUNT 100 can saturate the loop even though each call is short.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis executes commands on a shard's command thread in sequence. Most commands are O(1) or O(log N), so each one holds the thread for microseconds. A slow command is one whose runtime grows with the keyspace, a collection, or a value: `KEYS`, `HGETALL`, `SMEMBERS`, `SORT`, a large `DEL`, or a Lua loop. While it runs, every other command on that shard waits, including commands that touch unrelated keys.",
  },
  {
    type: "p",
    text: "The failure is a latency spike, not sustained CPU. A scan that blocks for one second every ten seconds consumes 10% of the shard's capacity on average. Average utilization looks calm, but p99 follows the one-second block because a request that arrives during the scan waits for the remainder. The average and the tail describe different things.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application clients and operational tooling, both talking to the same Redis primary. A cron job, a debug endpoint, or an admin script is a client like any other. In Redis Cluster it reaches one shard, so the blast radius is that shard's keys and clients, not the whole cluster. On a replica the scan still blocks that replica's command thread, which matters if reads are routed there.",
  },
  {
    type: "table",
    headers: ["Command", "Complexity", "What it holds"],
    rows: [
      ["KEYS pattern", "O(N) over the keyspace", "The command thread for the entire scan"],
      ["SCAN cursor COUNT n", "O(1) per call, O(N) per full iteration", "A bounded batch per call"],
      ["HGETALL or SMEMBERS", "O(N) over the collection", "The thread for the whole collection"],
      ["DEL of a large collection", "O(N) over the elements", "The thread while every element is freed"],
      ["GET of a 50MB value", "O(N) over the bytes", "The thread while the reply is copied"],
    ],
  },
  {
    type: "p",
    text: "This module models a primary with one to fifty million keys and an illustrative scan rate of 10,000 keys per millisecond. The Redis KEYS documentation gives an example of one million keys in 40ms on an entry-level laptop; this model is slower and is a teaching value, not a hardware promise. The point is the shape: a single call over the whole keyspace produces one long block, while an incremental loop produces many short blocks.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Longest command block: the duration of one scan call, warning at 100ms and critical at 800ms.",
      "Application p99: the wait imposed on clients that never run the slow command.",
      "Client timeouts: requests that exceeded their budget while the block was running.",
      "Event-loop busy: average occupancy, which can look safe during a short blocking scan.",
      "Slowlog entries and debug commands per second: whether the scan is still running and how it is split.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy; the debug script uses SCAN. Apply Failure to switch it to KEYS and watch the block time and p99 move together while average event-loop occupancy stays below 60%. Apply Use SCAN to see the block disappear without the total keyspace work disappearing.",
  },
  {
    type: "p",
    text: "`KEYS` is documented for debugging, not production. `SCAN` is the incremental replacement: O(1) per call, O(N) over a complete iteration, with `COUNT` as a hint rather than a guarantee. SCAN may return duplicates and does not promise a consistent snapshot while the keyspace changes. A full iteration can still take a long time; the improvement is that no single call blocks for the whole iteration.",
  },
  { type: "sim", simId: "slow-commands" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The debug script called KEYS, which scanned the whole keyspace in one command. The command thread stayed inside that scan for about a second, so every application request that arrived during it waited. Average event-loop occupancy stayed below 60% because the scan ran only six times a minute. p99 and timeouts followed the block, not the average.",
  },
  {
    type: "p",
    text: "Switching to SCAN bounded each call and moved the full-keyspace work into many short calls. p99 returned to single-digit milliseconds. The total work did not vanish: a complete iteration still touches every key, and a small COUNT adds enough command overhead to consume the thread in a different way. The fix is a bounded loop with a sensible batch size, a rate limit, and a caller that can be stopped.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Redis: `SLOWLOG GET` lists commands that crossed `slowlog-log-slower-than` (default 10ms), with timestamps and durations.",
      "Redis: `INFO commandstats` shows calls and usec per call; `INFO latencystats` shows per-command percentile distributions on newer versions.",
      "Redis: `LATENCY HISTORY` returns events from the latency monitor and `LATENCY DOCTOR` summarizes them, when the monitor is enabled.",
      "ElastiCache: `EngineCPUUtilization` and `CPUUtilization` are minute averages that can hide a one-second block; pair them with client p99 and `CurrConnections`.",
      "Logs and traces: cache spans are slow for many endpoints at the same timestamps, while the database span is normal. A cron or debug log line often sits at the same minute.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the slowlog next to p99, then find the caller. Check whether the spike repeats on a schedule, whether one command dominates usec per call, and whether the slow commands share a shard. Stop the caller before changing Redis capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the command and caller from the slowlog, commandstats, and the spike timestamps.",
      "Stop or rate-limit the caller. A debug endpoint and an admin script are production dependencies once they share the primary.",
      "Replace KEYS with SCAN, and replace collection-wide reads with HSCAN, SSCAN, or field-level reads.",
      "Choose COUNT to balance per-call block time against command overhead; measure both.",
      "Run the scan on a replica when freshness allows, and keep it off the primary's peak window.",
      "Re-run at peak and verify block time, p99, timeouts, and event-loop occupancy together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "SCAN does not reduce total work; it bounds each call. A full iteration can still take a long time and return duplicates.",
      "A small COUNT reduces per-call block time but multiplies command overhead; a large COUNT reintroduces long blocks.",
      "A replica protects the primary but adds stale-read risk and moves the block to the replica's clients.",
      "Disabling a command with `rename-command` or ACLs is a blunt control that can break legitimate runbooks.",
      "Raising the slowlog threshold hides the evidence without changing the latency.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-keys-spike",
    question:
      "`KEYS *` runs every ten seconds on a 10M-key primary. Average event-loop utilization is 40% and p99 is 900ms. Explain the gap.",
    difficulty: 3,
    hints: [
      "A scan is one critical section, not many small commands.",
      "Requests that arrive during the block wait for the remainder.",
    ],
    answer:
      "The average is low because the scan occupies only part of each ten-second window. During the scan, the command thread cannot serve anything else, so an application request that arrives near the start waits almost the full block. That makes p99 approximately the block time even though the minute average is 40%. I would confirm with `SLOWLOG GET`, `INFO commandstats` for KEYS, and a p99 graph aligned to the scan schedule. The fix is to stop or replace KEYS, not to add CPU.",
    followUps: [
      "What would p99 look like if the scan ran every second instead?",
      "How would the answer change on a replica?",
      "Which metric would you put on the dashboard to catch this earlier?",
    ],
    redFlags: [
      "Says average CPU is the health signal.",
      "Blames the application query plan.",
      "Raises timeouts instead of removing the block.",
    ],
    rubric: [
      "Explains the single-threaded critical section.",
      "Connects p99 to block time.",
      "Uses slowlog and commandstats.",
      "Stops the caller first.",
    ],
  },
  {
    id: "scan-tradeoff",
    question:
      "Does replacing KEYS with SCAN remove the cost of a full keyspace scan?",
    difficulty: 2,
    hints: [
      "Think about total work versus per-call work.",
      "COUNT is a hint.",
    ],
    answer:
      "No. SCAN is O(1) per call and O(N) over a complete iteration, so the total work is still proportional to the keyspace. What changes is that each call scans a bounded batch, so other clients wait for a short block instead of the whole scan. COUNT is a hint, not a hard limit, and a full iteration can return duplicates and does not guarantee a snapshot. A very small COUNT adds per-call overhead and can saturate the loop; a very large COUNT brings back long blocks. The right COUNT is measured against both p99 and total command rate.",
    followUps: [
      "How do you choose COUNT for a 50M-key keyspace?",
      "What happens to the iteration if keys are added or removed?",
      "When would a replica still be the right place to run it?",
    ],
    redFlags: [
      "Says SCAN is O(1) overall.",
      "Assumes COUNT is exact.",
      "Ignores duplicate results.",
    ],
    rubric: [
      "Distinguishes per-call from full-iteration cost.",
      "Explains COUNT as a hint.",
      "Names duplicate and consistency limits.",
      "Balances block time and overhead.",
    ],
  },
  {
    id: "find-slow-command",
    question:
      "Users report periodic Redis latency spikes. How do you find the command responsible without guessing?",
    difficulty: 3,
    hints: [
      "The slowlog is a sample of commands above a threshold.",
      "Correlate timestamps across clients and shards.",
    ],
    answer:
      "I would start with the slowlog to see commands above the configured threshold, then use `INFO commandstats` to rank commands by usec per call and `INFO latencystats` for per-command percentiles where available. I would align the spike timestamps with cron jobs, deploy events, and admin endpoints, and check whether the slow commands are concentrated on one shard. `LATENCY HISTORY` and `LATENCY DOCTOR` can show recorded events if the latency monitor is enabled. The goal is to identify both the command and its caller, because the command may be legitimate and the schedule may be the defect.",
    followUps: [
      "What if the slowlog is empty but p99 still spikes?",
      "How do you tell a slow command from network latency?",
      "What would you change to catch the next occurrence sooner?",
    ],
    redFlags: [
      "Runs KEYS to investigate latency.",
      "Looks only at cluster averages.",
      "Changes the slowlog threshold to hide the entries.",
    ],
    rubric: [
      "Uses slowlog plus command statistics.",
      "Correlates with caller schedule.",
      "Checks per-shard concentration.",
      "Identifies both command and owner.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Production access does not include KEYS; runbooks use SCAN with a bounded COUNT.",
      "Slowlog retention and threshold are set deliberately and exported to the observability stack.",
      "Debug and admin scripts are inventoried with their schedules, target shard, and owner.",
      "Dashboards show p99 and slowlog volume next to average event-loop utilization.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the slowlog and find the caller before changing Redis capacity.",
      "Stop or rate-limit the scan; do not let retries multiply behind it.",
      "Check whether the block is on one shard or on every shard.",
      "Watch p99 after the scan stops to confirm the queue drains.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replace the command with an incremental form and verify the new COUNT under peak load.",
      "Move scheduled scans to a replica or a maintenance window if freshness allows.",
      "Add a guardrail so a debug endpoint cannot run a full scan in production.",
      "Record the block time and the p99 impact in the runbook.",
    ],
  },
];

const references = [
  {
    title: "Diagnosing latency issues",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Single-threaded command execution and slow commands such as KEYS.",
  },
  {
    title: "KEYS",
    url: "https://redis.io/docs/latest/commands/keys/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "O(N) over the keyspace; documented for debugging.",
  },
  {
    title: "SCAN",
    url: "https://redis.io/docs/latest/commands/scan/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "O(1) per call, O(N) per full iteration, COUNT as a hint.",
  },
  {
    title: "SLOWLOG GET",
    url: "https://redis.io/docs/latest/commands/slowlog-get/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Reading commands that exceeded the slowlog threshold.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "slow-commands": {
      model: slowCommandModel,
      presets,
      instructions:
        "Start healthy, switch the debug script to KEYS, then compare it with a SCAN loop. Watch the block time and p99, not the average.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 10,000 keys/ms scan rate and 8us command cost are teaching values, not Redis benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-big-keys",
    "caching-lua-atomicity",
    "caching-connection-pool",
    "caching-hot-key-detection",
  ],
};
