import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SMALL_OP_US = 8;
const BIG_KEY_MS_PER_MB = 1.8;
const DATASET_GB = 36;

const params = [
  {
    id: "bigKeyMb",
    label: "Big key payload",
    min: 1,
    max: 512,
    step: 1,
    value: 50,
    unit: " MB",
    group: "Key",
    help: "Bytes one operation returns. Splitting a value so each read fetches one chunk lowers this number; splitting without changing the read path does not.",
    format: "number" as const,
  },
  {
    id: "bigKeyRps",
    label: "Reads of the big key",
    min: 0,
    max: 20,
    step: 0.5,
    value: 1.5,
    unit: " /s",
    group: "Traffic",
    help: "Operations per second against the one large key. Every one of them lands on the shard that owns the key.",
    format: "number" as const,
  },
  {
    id: "totalOps",
    label: "Total Redis commands",
    min: 10_000,
    max: 200_000,
    step: 5_000,
    value: 60_000,
    unit: " ops/s",
    group: "Traffic",
    help: "All commands across the cluster. They are spread over the shards; the big key is not.",
    format: "rps" as const,
  },
  {
    id: "shardCount",
    label: "Redis shards",
    min: 3,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Topology",
    help: "Primaries in the cluster. More shards lower the small-command load per shard but do not split one key.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface ShardState {
  index: number;
  busy: number;
  p99: number;
  errors: number;
  ops: number;
  memoryGb: number;
  hot: boolean;
}

interface Computed {
  shards: ShardState[];
  hotShard: number;
  hottest: ShardState;
  hottestBusy: number;
  p99: number;
  errors: number;
  bandwidth: number;
  memorySkew: number;
  totalOps: number;
  bigKeyMb: number;
  bigKeyRps: number;
  bigKeyMs: number;
  shardCount: number;
}

function healthFor(busy: number, p99: number, errors: number): "ok" | "warn" | "crit" {
  if (busy >= 0.85 || p99 >= 120 || errors >= 2) return "crit";
  if (busy >= 0.65 || p99 >= 40 || errors >= 0.5) return "warn";
  return "ok";
}

function compute(p: Params, scale = 1): Computed {
  const bigKeyMb = Math.max(0, num(p, "bigKeyMb", 50));
  const bigKeyRps = Math.max(0, num(p, "bigKeyRps", 1.5)) * scale;
  const totalOps = Math.max(1, num(p, "totalOps", 60_000));
  const shardCount = Math.max(3, Math.round(num(p, "shardCount", 6)));
  const hotShard = Math.min(2, shardCount - 1);
  const smallOpsPerShard = totalOps / shardCount;
  const bigKeyMs = bigKeyMb * BIG_KEY_MS_PER_MB;
  const smallBusy = (smallOpsPerShard * SMALL_OP_US) / 1_000_000;
  const bigBusy = (bigKeyRps * bigKeyMs) / 1_000;
  const datasetPerShardMb = (DATASET_GB * 1024) / shardCount;
  const shards: ShardState[] = Array.from({ length: shardCount }, (_, index) => {
    const hot = index === hotShard;
    const busy = smallBusy + (hot ? bigBusy : 0);
    const wait = bigBusy / Math.max(0.05, 1 - Math.min(busy, 1.05));
    const p99 = hot ? Math.min(2_000, 1.5 + bigKeyMs * wait) : 1.5;
    const errors = hot && busy > 0.95 ? Math.min(25, (busy - 0.95) * 20) : 0;
    return {
      index,
      busy,
      p99,
      errors,
      ops: smallOpsPerShard + (hot ? bigKeyRps : 0),
      memoryGb: datasetPerShardMb / 1024 + (hot ? bigKeyMb / 1024 : 0),
      hot,
    };
  });
  const hottest = shards[hotShard];
  return {
    shards,
    hotShard,
    hottest,
    hottestBusy: hottest.busy,
    p99: hottest.p99,
    errors: hottest.errors,
    bandwidth: bigKeyMb * bigKeyRps,
    memorySkew: (bigKeyMb / datasetPerShardMb) * 100,
    totalOps,
    bigKeyMb,
    bigKeyRps,
    bigKeyMs,
    shardCount,
  };
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const health = healthFor(values.hottestBusy, values.p99, values.errors);
  const serviceHealth = health === "crit" ? "warn" : "ok";
  const loopPct = Math.min(140, values.hottestBusy * 100);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(values.totalOps).toLocaleString("en-US")} commands/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Catalog service",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(values.totalOps / 200_000),
        throughput: values.totalOps,
        sublabel: health === "ok" ? "within SLO" : "waiting on Redis",
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis Cluster",
        kind: "cache",
        health,
        utilization: clamp(values.hottestBusy),
        throughput: values.totalOps,
        sublabel: `hottest shard ${loopPct.toFixed(0)}% busy`,
        detail: `The cluster has ${values.shardCount} shards. Its usable performance is set by the one shard that owns the big key, not by the cluster average.`,
        meta: { view: "flow" },
      },
      ...values.shards.map((shard) => {
        const shardHealth = healthFor(shard.busy, shard.p99, shard.errors);
        return {
          id: `shard-${shard.index}`,
          label: `shard-${shard.index}`,
          kind: "cache" as const,
          role: "shard" as const,
          health: shardHealth,
          utilization: clamp(shard.busy),
          throughput: shard.ops,
          sublabel: shard.hot ? "owns the big key" : "keyspace",
          detail: `${Math.min(140, shard.busy * 100).toFixed(0)}% event-loop occupancy, p99 ${shard.p99.toFixed(0)}ms, ${shard.memoryGb.toFixed(2)}GB resident. Illustrative model values.`,
          meta: {
            view: "shards",
            cpu: Math.min(140, shard.busy * 100),
            memory: shard.memoryGb,
            p99: shard.p99,
            hot: shard.hot ? 1 : 0,
          },
        };
      }),
    ],
    edges: [
      edge("client-service", "client", "service", values.totalOps / 200_000),
      edge("service-redis", "service", "redis", values.totalOps / 200_000, health),
    ],
    metrics: [
      metric("hot-shard-loop", "Hot shard event loop", loopPct, "%", 65, 85, "percent"),
      metric("redis-p99", "Redis p99 (other commands)", values.p99, "ms", 40, 120, "ms"),
      metric("redis-errors", "Redis timeouts", values.errors, "%", 0.5, 2, "percent"),
      metric("big-key-bandwidth", "Big-key egress", values.bandwidth, " MB/s", undefined, undefined, "number"),
      metric("big-key-memory", "Big-key shard memory share", values.memorySkew, "%", undefined, undefined, "percent"),
      metric("total-ops", "Total commands", values.totalOps, " ops/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      hotShard: values.hotShard,
      paramsKey: JSON.stringify(p),
    },
    summary: `shard-${values.hotShard} is ${loopPct.toFixed(0)}% busy; p99 ${values.p99.toFixed(0)}ms; big-key egress ${values.bandwidth.toFixed(0)}MB/s.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.96 + 0.06 * Math.sin((offset + (seed % 9)) / 2.7);
  for (const item of frame.metrics) {
    const amplitude = Math.max(0.1, item.value * 0.02);
    frame.series[item.id] = Array.from({ length }, (_, index) =>
      Math.max(0, item.value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  for (const node of frame.nodes.filter((item) => item.meta?.view === "shards")) {
    const cpu = Number(node.meta?.cpu ?? 0);
    frame.series[`cpu.${node.id}`] = Array.from({ length }, (_, index) =>
      Math.max(0, cpu * jitter(index + node.id.length) + Math.sin(index / 2.3) * 2),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-shard-loop",
    metricId: "hot-shard-loop",
    warn: 65,
    crit: 85,
    title: "The big-key shard is running out of event-loop time",
    cause:
      "Copying and serializing one large value occupies the command thread. Every other command on that shard waits behind it, even though the rest of the cluster has headroom.",
    fix:
      "Reduce the bytes or elements touched per operation before adding capacity. Fetch one field, chunk the value, cache the hot read locally, or remove the key.",
    checkFirst: [
      "Find the shard with the highest p99 and event-loop utilization, not the cluster average.",
      "Sample keys for size and element count with SCAN, then confirm the largest with MEMORY USAGE.",
      "Check the slowlog for commands that touch the suspect key.",
    ],
  },
  {
    id: "redis-p99",
    metricId: "redis-p99",
    warn: 40,
    crit: 120,
    title: "Unrelated Redis commands are waiting on a big value",
    cause:
      "A big-key operation is a long critical section on the shard. Small commands queue behind the copy, so their p99 follows the big key's size and read rate rather than their own complexity.",
    fix:
      "Bound the per-operation cost: split the value, read fewer elements, compress, or serve the hot path from a local cache. Then verify p99 for commands that never touch the key.",
    checkFirst: [
      "Compare p99 on the owning shard with p99 on the other shards.",
      "Check whether the slow commands are small commands that happen to share the shard.",
      "Check whether the big key is read on a schedule or by a retry loop.",
    ],
  },
  {
    id: "redis-errors",
    metricId: "redis-errors",
    warn: 0.5,
    crit: 2,
    title: "Client timeouts are now visible to users",
    cause:
      "The queue behind the big-key operation exceeded the client timeout. Retries add more commands to the same shard, so the timeout rate can stay high after the first read finishes.",
    fix:
      "Stop the retry amplification, reduce big-key read frequency or size, and add a bounded fallback. Raising the timeout hides the queue instead of removing it.",
    checkFirst: [
      "Separate client-side timeouts from Redis errors.",
      "Check retry volume and connection-pool wait on the service.",
      "Confirm whether the timeouts cluster around reads of one key.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const bigKeyModel: SimModel = {
  id: "caching-big-keys",
  visual: "shards",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, compute(p));
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const noise = 1 + rng.between(-0.005, 0.005);
    const values = compute(p, noise);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    const shardKeys = new Set(
      next.nodes.filter((item) => item.meta?.view === "shards").map((item) => `cpu.${item.id}`),
    );
    next.series = Object.fromEntries(
      Object.entries(frame.series).filter(
        ([key]) => !key.startsWith("cpu.") || shardKeys.has(key),
      ),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes.filter((item) => item.meta?.view === "shards")) {
      recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? 0));
    }
    if (values.bandwidth >= 450 && frame.flags.bigKeySeen !== 1) {
      pushEvent(next, {
        id: "big-key-detected",
        at: frame.t,
        severity: "warn",
        title: "Big-key read is consuming the shard",
        detail: `One key returns ${values.bigKeyMb.toFixed(0)}MB per read at ${values.bigKeyRps.toFixed(1)} reads/s. That is ${values.bandwidth.toFixed(0)}MB/s through one shard.`,
        nodeId: `shard-${values.hotShard}`,
        metricId: "hot-shard-loop",
      });
      next.flags.bigKeySeen = 1;
    }
    if (values.bandwidth < 450) next.flags.bigKeySeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `shard-${values.hotShard} is ${Math.min(140, values.hottestBusy * 100).toFixed(0)}% busy; p99 ${values.p99.toFixed(0)}ms; big-key egress ${values.bandwidth.toFixed(0)}MB/s.`;
    next.events = next.events.slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const other = values.shards.filter((shard) => !shard.hot);
    const otherBusy = other.length ? Math.max(...other.map((shard) => shard.busy)) : 0;
    const loopPct = Math.min(140, values.hottestBusy * 100);
    const bigShare = Math.min(140, (values.bigKeyRps * values.bigKeyMs) / 10);
    const items = [
      `shard-${values.hotShard} is at ${loopPct.toFixed(0)}% event-loop occupancy; the busiest other shard is at ${Math.min(140, otherBusy * 100).toFixed(0)}%.`,
      `Each ${values.bigKeyMb.toFixed(0)}MB read occupies the command thread for about ${values.bigKeyMs.toFixed(0)}ms in this model. At ${values.bigKeyRps.toFixed(1)} reads/s that is ${bigShare.toFixed(0)}% of the shard's second.`,
      `The key sends ${values.bandwidth.toFixed(0)}MB/s and adds ${values.memorySkew.toFixed(1)}% to the owning shard's resident memory. At this dataset size, blocking arrives before memory pressure.`,
      `Adding shards lowers the small-command load per shard but leaves the whole big value on shard-${values.hotShard}. Resizing does not split a key.`,
      "Splitting helps only when a read needs one chunk. If every request needs every chunk, the same bytes still cross the wire and fan-out adds round trips.",
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
    description: "A 50MB value read 1.5 times per second; the owning shard has headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Four reads per second of the same value; p99 crosses the warning threshold.",
    tone: "warn",
    params: defaults({ bigKeyRps: 4, totalOps: 90_000 }),
  },
  {
    id: "failure",
    label: "Failure",
    description: "Ten reads per second; the owning shard queues every other command.",
    tone: "crit",
    params: defaults({ bigKeyRps: 10, totalOps: 120_000 }),
  },
  {
    id: "recovery",
    label: "Split the value",
    description: "Each read fetches a 5MB chunk instead of the whole value; the shard recovers.",
    tone: "ok",
    params: defaults({ bigKeyMb: 5, bigKeyRps: 10, totalOps: 120_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-big-key-stall",
  title: "Predict who waits on a big-key read",
  simId: "big-key",
  question:
    "Raise the key to 50MB and eight reads per second. Which requests slow down?",
  prediction: {
    options: [
      { id: "big-only", label: "Only the requests that read the big key" },
      { id: "shard", label: "Every command on the shard that owns the key" },
      { id: "all-shards", label: "All shards in the cluster equally" },
      { id: "database", label: "Only the database behind a cache miss" },
    ],
    correctOptionId: "shard",
    explanation:
      "Redis executes commands on the shard's main thread. While one command copies or iterates a large value, no other command on that shard runs. Commands on other shards are unaffected, which is why a cluster-wide average hides the stall.",
  },
  setup: defaults({ bigKeyMb: 50, bigKeyRps: 8, totalOps: 90_000 }),
  runFor: 20,
  observe: [
    "The owning shard's event-loop occupancy rises to about 84%, while the other shards stay near 12%.",
    "p99 for commands that never touch the big key rises above 400ms.",
    "Big-key egress reaches 400MB/s; the network cost and the blocking cost arrive together.",
    "The cluster average and the other shard cards look healthy, so a cluster-wide chart would miss the incident.",
  ],
  explain:
    "The big value is one object on one shard. Copying it into the reply buffer and writing it to the socket takes time on the command thread. Every small command that arrives during that copy waits. The queue is on one shard, but it is a queue for all of that shard's clients.",
  fix: defaults({ bigKeyMb: 5, bigKeyRps: 8, totalOps: 90_000 }),
  debrief:
    "Splitting the value into 5MB chunks and fetching only the chunk a request needs lowers the per-operation cost by an order of magnitude. The shard returns below the warning threshold. If every request needed all ten chunks, the same bytes would still cross the wire; the split would add round trips without fixing the stall.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis stores a value as one object under one key. A big key is a value whose size makes an operation on it expensive: a 50MB string, a hash with millions of fields, a sorted set with millions of members. The key is not automatically a problem because it is large. It becomes one when reads, writes, iteration, or deletion of that value occupy the shard's command thread long enough for other clients to notice.",
  },
  {
    type: "p",
    text: "Three costs are easy to blur. Bandwidth is the bytes sent per read. Blocking is the time the command thread spends finding, allocating, copying, or iterating the value. Memory imbalance is the resident bytes added to the one shard that owns the key. A 50MB value can be tolerable for bandwidth and memory while still causing multi-hundred-millisecond stalls, because the shard serves every other command in sequence.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, service, Redis, then the database on a miss. The value lives on one shard, selected by its hash slot. Redis has used background threads for some slow I/O since 2.4 and optional I/O threads for socket reads and writes since 6.0, but command execution still runs on the shard's main thread. A GET of a large string must place the value into the client output buffer; a DEL of a large collection must free every element; a Lua loop over the value runs inside the same critical section.",
  },
  {
    type: "table",
    headers: ["Cost", "What grows with the value", "What it delays"],
    rows: [
      ["Reply copy and allocation", "Bytes copied into the output buffer", "Every command on the shard while the copy runs"],
      ["Network egress", "Bytes sent per read and buffer memory", "The client, the link, and the shard's output buffer"],
      ["Iteration", "Elements scanned by HGETALL, SMEMBERS, DEL, or a Lua loop", "The event loop for the whole traversal"],
      ["Memory", "Resident bytes on the one shard that owns the key", "Headroom and eviction on that shard, not the cluster"],
    ],
  },
  {
    type: "p",
    text: "This module models a 36GB dataset spread over three to twelve shards. A single value is read at a chosen size and rate. The per-megabyte cost of 1.8ms is an illustrative teaching value for copying and serializing a reply, not a Redis benchmark. The shape is the lesson: the owning shard's queue grows nonlinearly as the big-key operation consumes more of each second, and the other shards do not help.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Hot shard event loop: the share of the owning shard's second spent in commands, warning at 65% and critical at 85%.",
      "Redis p99 for other commands: the wait imposed on clients that never touch the big key.",
      "Timeouts: the point where the queue exceeds the client budget.",
      "Big-key egress and shard memory share: the bandwidth and memory sides of the same value.",
      "Shard cards and per-shard CPU history: one shard diverging while the cluster average stays calm.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, apply Peak, then Failure. Watch the shard that owns the key rather than the cluster summary. Raise the shard count and notice that the big-key shard does not improve. Apply the recovery preset to see why splitting helps only when the read path fetches one chunk.",
  },
  {
    type: "p",
    text: "A big key is found by sampling, not by a cluster average. `redis-cli --bigkeys` walks the keyspace with SCAN and reports the largest key per type; it samples rather than proving that no larger key exists. `MEMORY USAGE key SAMPLES n` estimates one key's bytes. Neither command is free on a production primary, so run them against a replica when the topology allows it and rate-limit the scan.",
  },
  { type: "sim", simId: "big-key" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The big value lived on one shard. As its read rate rose, the shard spent more of every second copying it, and the queue for that shard grew. Small commands that had nothing to do with the key waited behind each copy, so their p99 rose even though their own work was constant. The other shards stayed near their baseline, which is why the cluster average and the aggregate hit rate looked healthy.",
  },
  {
    type: "p",
    text: "Adding shards reduced the small-command load per shard but left the entire value on its original shard. Splitting the value into chunks lowered the per-read cost and recovered the shard, but only because each request fetched one chunk. If the read path needs every chunk, the same bytes still cross the wire and the fan-out adds round trips.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Redis: `INFO commandstats` shows high usec per call for the command that touches the key; `INFO latencystats` shows the per-command percentile; `SLOWLOG GET` lists the individual stall.",
      "Redis: `MEMORY USAGE key SAMPLES n` estimates the key's bytes, and `redis-cli --bigkeys` samples the keyspace by type.",
      "ElastiCache: `EngineCPUUtilization`, `NetworkBytesOut`, `CurrConnections`, `Evictions`, and `BytesUsedForCache`, split by node or shard where the metric supports it.",
      "Traces: the cache span has a large self-time or response size while the database span is normal. The slow span belongs to the cache, not the query.",
      "Client logs: timeouts and retries that cluster around reads of one key or one key prefix.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare p99 and event-loop utilization per shard. If one shard diverges, sample its keys with SCAN and confirm the largest with MEMORY USAGE. Check whether the slow commands are the big-key command or small commands queueing behind it. Do not start with a cluster resize.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the key and the cost: per-shard p99, slowlog entries, key bytes, and element count.",
      "Reduce bytes per operation: fetch only the fields a request needs, compress the value, or cap the response size.",
      "If the access pattern allows it, split the value into deterministic chunks or hash fields, dual-write during migration, and read only the needed chunk.",
      "Move deletion off the command thread with `UNLINK`, and migrate readers before removing the old key.",
      "Re-run at peak and verify the owning shard's loop, p99, timeout rate, egress, and memory together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Chunking adds round trips, partial-failure handling, and migration work; it reduces cost only when the read path needs less than the whole value.",
      "Compression lowers bandwidth but spends CPU on the same command thread, so it can make the stall worse.",
      "A local cache absorbs the read before Redis but adds per-instance memory and staleness.",
      "A larger shard or faster network buys headroom without changing the per-operation cost.",
      "`UNLINK` moves the free off the command thread but can raise memory until the background free completes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-big-key",
    question:
      "A 50MB key is read three times per second. Redis CPU is 20%, the hit rate is 95%, and p99 is 400ms. What is happening?",
    difficulty: 3,
    hints: [
      "CPU is an average over time; a single command can own the thread for a long interval.",
      "Look at p99 per shard and per command before you look at the cluster.",
    ],
    answer:
      "The average CPU is low because the shard is idle most of the second, but each read copies 50MB on the command thread. Three reads can consume a large share of the second in long critical sections. Every small command that arrives during a copy waits, so p99 rises even though the other shards are healthy. I would confirm with per-shard p99, `INFO commandstats` or `INFO latencystats` for the read command, `SLOWLOG GET`, and `MEMORY USAGE` for the key. I would not diagnose from cluster CPU or hit rate, because both can look normal.",
    followUps: [
      "How would the answer change if the key were a hash read one field at a time?",
      "What would you check before running `--bigkeys` on the primary?",
      "Why does adding shards not fix this?",
    ],
    redFlags: [
      "Says CPU is low, so Redis is healthy.",
      "Blames the network only.",
      "Recommends resizing before checking per-shard latency.",
    ],
    rubric: [
      "Names the single-threaded command path.",
      "Uses per-shard and per-command evidence.",
      "Explains why averages hide the stall.",
      "Distinguishes bandwidth from blocking.",
    ],
  },
  {
    id: "find-big-key",
    question:
      "How do you find a big key in production without running `KEYS *`?",
    difficulty: 2,
    hints: [
      "SCAN is incremental; KEYS is a full scan in one call.",
      "Size and element count are different measurements.",
    ],
    answer:
      "I would use a SCAN-based sampler such as `redis-cli --bigkeys` or `--memkeys` against a replica, with a rate limit, and then confirm the suspects with `MEMORY USAGE key SAMPLES n`. For collections I would also check the element count, because a hash with many small fields and a string of the same byte size have different operation costs. I would correlate the suspects with per-shard p99 and slowlog entries so I am not just ranking keys by size. I would avoid KEYS on a primary because it scans the whole keyspace in one command and blocks every other client.",
    followUps: [
      "What does `--bigkeys` sample, and what does it not prove?",
      "How would you find a big key that is only written, never read?",
      "What is the risk of running the scan during peak traffic?",
    ],
    redFlags: [
      "Runs KEYS on the primary.",
      "Ranks only by byte size and ignores element count.",
      "Treats the sampler as a complete inventory.",
    ],
    rubric: [
      "Uses SCAN-based sampling.",
      "Confirms with MEMORY USAGE.",
      "Correlates with latency evidence.",
      "Names the production risk.",
    ],
  },
  {
    id: "split-big-key",
    question:
      "You decide to split a 50MB value into ten chunks. How do you migrate without breaking readers, and when does the split fail to help?",
    difficulty: 4,
    hints: [
      "Dual-write before dual-read.",
      "A chunked value only helps if a request needs fewer bytes than before.",
    ],
    answer:
      "I would write the chunks alongside the old key, then move readers to a path that fetches only the chunk or field they need, with a fallback to the old key while the migration runs. After the new path is verified, I would stop writing the old key and remove it after a TTL. The split fails to help if every request needs all ten chunks: the same bytes still cross the wire, and the client now pays ten round trips and partial-failure handling. It also fails if the chunks are read together in a Lua script or a transaction, because the atomic unit still touches the same total data. I would measure per-shard loop time and p99 for commands that do not touch the key, not just the big-key latency.",
    followUps: [
      "How do you handle a partial write during the migration?",
      "Would you use hash fields or separate keys?",
      "What changes if the chunks live in different hash slots?",
    ],
    redFlags: [
      "Deletes the old key before backfilling.",
      "Assumes chunking always reduces bytes.",
      "Ignores cross-slot access in Redis Cluster.",
    ],
    rubric: [
      "Dual-write and dual-read sequence.",
      "Reads only the needed chunk.",
      "Names the case where the split does not help.",
      "Verifies unrelated command latency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Per-shard event-loop utilization, p99, and slowlog volume are on the dashboard.",
      "A SCAN-based big-key sampler runs against a replica on a schedule, with a rate limit.",
      "The largest values and collections have an owner and a documented access pattern.",
      "A chunking or field-level read path exists for the keys that cannot be removed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the owning shard and the key before changing cluster capacity.",
      "Reduce big-key read frequency or bytes per read; stop retry loops that re-read the key.",
      "Bound client timeouts and retries so the queue does not grow after the first stall.",
      "Watch the other shards to prove the problem is localized.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify unrelated-command p99 and the owning shard's loop time at peak.",
      "Complete the reader migration before deleting the old key.",
      "Record the remaining bandwidth and memory cost of the new shape.",
      "Add the key to the size and element-count review.",
    ],
  },
];

const references = [
  {
    title: "Redis CLI: scanning for big keys",
    url: "https://redis.io/docs/latest/develop/tools/cli/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "--bigkeys and --memkeys sample the keyspace with SCAN.",
  },
  {
    title: "Diagnosing latency issues",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Single-threaded command execution and slow commands.",
  },
  {
    title: "MEMORY USAGE",
    url: "https://redis.io/docs/latest/commands/memory-usage/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Estimates the bytes used by one key, with sampling.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "big-key": {
      model: bigKeyModel,
      presets,
      instructions:
        "Start healthy, then raise the read rate and payload. Compare the owning shard with the others before and after splitting the value.",
      experimentIds: [experiment.id],
      alternateVisuals: ["heatmap"],
      note: "Illustrative model. The 1.8ms per MB and 36GB dataset are teaching values, not Redis or ElastiCache limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-redis-data-types",
    "caching-slow-commands",
    "caching-memory-fragmentation",
    "caching-hot-key-sharding",
  ],
};
