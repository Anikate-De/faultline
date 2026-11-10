import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BUDGET_MB = 512;
const TYPES = ["string", "hash", "list", "sorted set", "stream"];
const OVERHEAD = [12, 72, 40, 132, 160];

const params = [
  {
    id: "structure",
    label: "Key data type",
    min: 0,
    max: 4,
    step: 1,
    value: 3,
    unit: "",
    group: "Structure",
    help: "0 string, 1 hash, 2 list, 3 sorted set, 4 stream. The same leaderboard members are stored in each encoding.",
    format: "count" as const,
  },
  {
    id: "entries",
    label: "Leaderboard members",
    min: 100_000,
    max: 10_000_000,
    step: 100_000,
    value: 500_000,
    unit: "",
    group: "Size",
    help: "Distinct members in the key. Per-member overhead grows linearly once a compact encoding is exceeded.",
    format: "count" as const,
  },
  {
    id: "memberBytes",
    label: "Average member size",
    min: 16,
    max: 256,
    step: 8,
    value: 48,
    unit: " B",
    group: "Size",
    help: "Member identifier plus score payload. Larger members make every encoding more expensive.",
    format: "bytes" as const,
  },
  {
    id: "readRps",
    label: "Rank read rate",
    min: 1_000,
    max: 80_000,
    step: 1_000,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Top-N and rank lookups per second. This is the operation mix the structure must serve.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function typeIndex(p: Params): number {
  return Math.round(clamp(num(p, "structure", 3), 0, 4));
}

interface Values {
  type: string;
  entries: number;
  memberBytes: number;
  readRps: number;
  memoryMb: number;
  p99: number;
}

function compute(p: Params): Values {
  const type = typeIndex(p);
  const entries = Math.max(1, Math.round(num(p, "entries", 500_000)));
  const memberBytes = Math.max(1, num(p, "memberBytes", 48));
  const readRps = Math.max(1, num(p, "readRps", 8_000));
  const memoryMb = (entries * (memberBytes + OVERHEAD[type])) / 1_000_000 + 0.5;
  const load = readRps / 80_000;
  let p99 = 1.8;
  if (type === 0) p99 = 2 + entries * 0.004 + load * 6;
  if (type === 1) p99 = 1.1 + load * 8;
  if (type === 2) p99 = 1.4 + entries * 0.002 + load * 8;
  if (type === 3) p99 = 0.8 + Math.log2(entries) * 0.06 + load ** 3 * 12;
  if (type === 4) p99 = 1.2 + entries * 0.0005 + load * 10;
  return {
    type: TYPES[type],
    entries,
    memberBytes,
    readRps,
    memoryMb,
    p99: clamp(p99, 0.2, 2_000),
  };
}

function health(memoryMb: number, p99: number): "ok" | "warn" | "crit" {
  if (memoryMb >= BUDGET_MB || p99 >= 60) return "crit";
  if (memoryMb >= 430 || p99 >= 10) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const wave = (index: number) => 0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.4);
  frame.series["memory-used"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.memoryMb * wave(index)));
  frame.series["rank-p99"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.p99 * wave(index + 3) + Math.sin(index / 2.2) * v.p99 * 0.03),
  );
  frame.series["members"] = Array.from({ length: 24 }, () => v.entries);
  frame.series["read-rps"] = Array.from({ length: 24 }, (_, index) =>
    Math.max(0, v.readRps * wave(index + 5)),
  );
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const nodeHealth = health(v.memoryMb, v.p99);
  const shardHealth = health(v.memoryMb, v.p99);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Leaderboard readers",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(v.readRps).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Ranking API",
        kind: "service",
        health: v.p99 >= 60 ? "crit" : v.p99 >= 10 ? "warn" : "ok",
        utilization: clamp(v.readRps / 80_000),
        throughput: v.readRps,
        sublabel: `${v.type} lookups`,
        meta: { view: "flow" },
      },
      {
        id: "key",
        label: "leaderboard:global",
        kind: "cache",
        health: nodeHealth,
        utilization: clamp(v.memoryMb / BUDGET_MB),
        sublabel: `${v.type} · ${Math.round(v.entries).toLocaleString()} members`,
        detail: `Illustrative encoding cost: ${v.memberBytes.toFixed(0)} B member plus ${OVERHEAD[TYPES.indexOf(v.type)]} B overhead, ${v.memoryMb.toFixed(0)} MB total. Compact encodings apply only below their configured element and value limits.${v.type === "string" ? " A single Redis string is capped at 512 MB; larger leaderboards must be split." : ""}`,
        meta: { view: "flow" },
      },
      {
        id: "shard",
        label: "Redis shard",
        kind: "cache",
        role: "shard",
        health: shardHealth,
        utilization: clamp(v.memoryMb / BUDGET_MB),
        throughput: v.readRps,
        sublabel: `${BUDGET_MB} MB budget · p99 ${v.p99.toFixed(1)} ms`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-service", "client", "service", v.readRps / 80_000),
      edge("service-key", "service", "key", v.readRps / 80_000, nodeHealth),
      edge("key-shard", "key", "shard", clamp(v.memoryMb / BUDGET_MB), shardHealth),
    ],
    metrics: [
      metric("memory-used", "Key memory", v.memoryMb, " MB", 430, BUDGET_MB, "number"),
      metric("rank-p99", "Rank p99", v.p99, "ms", 10, 60, "ms"),
      metric("members", "Members", v.entries, "", undefined, undefined, "count"),
      metric("read-rps", "Rank reads", v.readRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.type} at ${Math.round(v.entries).toLocaleString()} members uses ${v.memoryMb.toFixed(0)} MB of a ${BUDGET_MB} MB budget; rank p99 ${v.p99.toFixed(1)} ms.`,
  };
  seedSeries(frame, v, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "memory-used",
    metricId: "memory-used",
    warn: 430,
    crit: BUDGET_MB,
    title: "The key exceeds the shard memory budget",
    cause:
      "Each member carries the value plus the structure's own metadata. A sorted set adds a score and skip-list links per member, and large collections leave the compact encoding.",
    fix:
      "Estimate bytes per member before the migration, then cap the key or archive cold members. Choose the structure for the operations you need, and budget its overhead rather than the payload alone.",
    checkFirst: [
      "Read `MEMORY USAGE` for the key and compare it with the payload estimate.",
      "Check `object encoding` to see whether the compact encoding still applies.",
      "Check the shard's `maxmemory` and how much headroom the other keys need.",
    ],
  },
  {
    id: "rank-p99",
    metricId: "rank-p99",
    warn: 10,
    crit: 60,
    title: "Rank reads are queueing behind the command",
    cause:
      "A string or list forces the server to touch much more data per rank read than a sorted set. On a single command thread, that work delays every other client.",
    fix:
      "Use an indexed structure for rank queries, keep the value size bounded, and split oversized keys. A faster encoding does not help if one command still scans the whole value.",
    checkFirst: [
      "Compare p99 with the command type and the key size.",
      "Check `SLOWLOG` for the same command repeating.",
      "Check whether a full-value read or scan is on the request path.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const redisDataTypesModel: SimModel = {
  id: "caching-redis-data-types",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const jittered: Params = {
      ...p,
      readRps: num(p, "readRps", 8_000) * (1 + rng.between(-0.004, 0.004) * Math.min(1, dt / 0.1)),
    };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (!reset) {
      next.series = Object.fromEntries(Object.entries(frame.series).map(([k, values]) => [k, [...values]]));
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events];
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const perMember = (v.memoryMb * 1_000_000) / v.entries;
    return [
      `${v.type} stores ${Math.round(v.entries).toLocaleString()} members at roughly ${perMember.toFixed(0)} B each in this model, ${v.memoryMb.toFixed(0)} MB in total.`,
      `The payload is only part of the cost. Per-member indexes, scores, and allocator headers decide whether the key fits the ${BUDGET_MB} MB budget.`,
      `At ${Math.round(v.readRps).toLocaleString()} rank reads per second, p99 is ${v.p99.toFixed(1)} ms. A structure that scans the collection makes reads more expensive as it grows.`,
      v.memoryMb >= BUDGET_MB
        ? "This key is over budget. Shrinking the member count or changing the structure changes memory; a larger shard only moves the limit."
        : `Headroom is about ${(BUDGET_MB - v.memoryMb).toFixed(0)} MB. Project the growth rate before the next migration.`,
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
    description: "A sorted set with 500k members fits comfortably in a 512 MB shard budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "2.2 million members at a higher read rate; memory is approaching the budget.",
    tone: "warn",
    params: defaults({ entries: 2_200_000, memberBytes: 64, readRps: 30_000 }),
  },
  {
    id: "failure",
    label: "Leaderboard rewrite",
    description: "Four million members with a 96-byte payload exceed the shard budget.",
    tone: "crit",
    params: defaults({ entries: 4_000_000, memberBytes: 96, readRps: 40_000 }),
  },
  {
    id: "recovery",
    label: "Archive cold members",
    description: "Keep 1.2M active members in the sorted set; archive the rest and reduce read pressure.",
    tone: "ok",
    params: defaults({ entries: 1_200_000, memberBytes: 48, readRps: 15_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-sorted-set-cost",
  title: "Predict the memory increase",
  simId: "redis-data-types",
  question:
    "One JSON string held the leaderboard. The rewrite moved the same members into a sorted set, reads got faster, and memory tripled. What explains the increase?",
  prediction: {
    options: [
      { id: "metadata", label: "The sorted set keeps a score and skip-list links per member, plus separate allocations." },
      { id: "compression", label: "Sorted sets disable compression, so every member is stored twice." },
      { id: "replicas", label: "Replication buffers are counted in the key's memory." },
      { id: "ttl", label: "Each sorted-set member carries its own TTL and expiry entry." },
    ],
    correctOptionId: "metadata",
    explanation:
      "A sorted set is an index: member, score, and skip-list links, with per-member allocation overhead. A single JSON string is one allocation with almost no per-member structure, but reading or updating one member means moving and parsing the whole value. The rewrite traded memory and write amplification for ranked access. Redis's compact encodings reduce this cost only while the key is small enough for them.",
  },
  setup: defaults({ entries: 4_000_000, memberBytes: 48, readRps: 40_000 }),
  runFor: 12,
  observe: [
    "Key memory crosses the 512 MB budget while rank p99 stays low.",
    "The shard is failing on memory, not on CPU or command latency.",
    "The same member count in a hash or list uses less memory but loses ordered rank reads.",
    "The headroom disappears linearly as members grow; there is no steady state at this size.",
  ],
  explain:
    "The sorted set is doing exactly what it was chosen to do: answer rank queries without scanning. That index has a per-member cost. At four million members the index alone pushes the key past the shard budget. Shrinking the payload helps, but the structural overhead remains, so the durable fix is to bound the key, archive cold members, or move the index to a store sized for it.",
  fix: defaults({ entries: 1_200_000, memberBytes: 48, readRps: 15_000 }),
  debrief:
    "The rewrite made rank reads cheap and made memory the new constraint. Capping the key at active members restored headroom without giving up ordered reads. If the full leaderboard must stay queryable, the next step is a larger shard or a different index, not another encoding change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Redis key is not just its payload. Every data type carries metadata: a hash has field and value entries, a list has linked quicklist nodes, a sorted set has a score and skip-list links per member, and a stream has entry IDs and consumer-group state. The payload can be identical across those types while the memory per member differs by a large factor. The same is true of operation cost: `GET` on one large string returns everything, while `ZRANGE` on a sorted set walks an index and returns only the requested rank.",
  },
  {
    type: "p",
    text: "This is why a rewrite can lower latency and raise memory at the same time. The new type is better at the query, and its index is the cost. Compact encodings soften the cost for small collections, but Redis converts to the full encoding once the configured element-count or value-size limit is crossed. A capacity estimate based on the payload alone will miss that step.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is reader, ranking service, Redis key, shard memory. The key is the unit of encoding and the shard is the unit of memory budget. A single large key can consume the shard even when the rest of the keyspace is small, so the relevant limit is the largest key plus the working set that must stay resident.",
  },
  {
    type: "table",
    headers: ["Structure", "Good at", "Main cost at scale"],
    rows: [
      ["String", "Opaque blobs, counters, one-value reads", "Whole-value reads and rewrites; no partial rank access"],
      ["Hash", "Field-level reads and updates on one object", "Per-field overhead and no ordering by score"],
      ["List", "Ends, queues, bounded recent sets", "Rank or middle access scans; per-node overhead"],
      ["Sorted set", "Ordered ranks, ranges, score updates", "Score and skip-list metadata per member"],
      ["Stream", "Append-only events, consumer groups", "Entry IDs, pending state, and range scans"],
    ],
  },
  {
    type: "p",
    text: "This module uses a 512 MB shard budget, a 100k–10M member range, and per-member overhead values as illustrative teaching numbers. They are not a sizing guarantee. Redis limits a single string value to 512 MB, so the string row is a comparison for smaller payloads; at the top of this member range a JSON leaderboard must be split across keys. The shape to remember is that memory grows with members times (payload plus structure overhead), while read cost depends on whether the command can use an index.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Key memory and the percentage of the shard budget, with a warning before the limit.",
      "Rank p99 (99th percentile latency), which separates an indexed read from a full-value scan.",
      "Member count and read rate, so you can change size and traffic independently.",
      "A node detail that states the encoding cost used by the model.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Leaderboard rewrite. Watch key memory cross the budget while p99 stays low: the structure is fast and still too large. Switch the data type to string, hash, or list to see the other side of the tradeoff, then apply Archive cold members. Run the experiment before reading the debrief.",
  },
  {
    type: "p",
    text: "The first question is not which type is fastest. It is which operations the product needs and which budget the key must fit. A sorted set is the right index for ranks; it is the wrong choice if the key cannot be bounded. Pick the structure whose cost you can estimate before the migration, not after the incident.",
  },
  { type: "sim", simId: "redis-data-types" },
  { type: "experiment", experimentId: "predict-sorted-set-cost" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The sorted set answered rank queries from an index instead of scanning a serialized blob, so p99 fell. The index stored a score and skip-list links for every member, and the key crossed the shard budget. Reads were healthy at the moment memory failed, which is why a latency-only review missed it. The shard was not short on CPU; the key's encoding was the bottleneck.",
  },
  {
    type: "p",
    text: "Reducing the member count restored headroom. Changing to a hash or list would have reduced memory further but given up ordered rank access. That is the actual decision: which operations are worth the index, and how large is the key allowed to grow.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Redis `INFO memory`: `used_memory`, `used_memory_dataset`, and `maxmemory` for the shard.",
      "`MEMORY USAGE key` for the specific key, and `OBJECT ENCODING key` to see whether the compact encoding was lost.",
      "`SLOWLOG` entries for the same command repeating, especially whole-value reads or scans.",
      "ElastiCache or Redis metrics split by node: `DatabaseMemoryUsagePercentage`, `EngineCPUUtilization`, and evictions.",
      "Application traces: the cache span is fast but the key size grows after a backfill or migration.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Measure the key with `MEMORY USAGE`, check its encoding, and compare it with the shard budget. Then confirm the read path can use the index you are paying for. A memory alert on a fast key is still an incident.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the key, not the whole keyspace: per-key memory and encoding.",
      "Project growth from members times bytes per member, including structure overhead.",
      "Bound the key: archive cold members, split by tenant or time window, or cap the collection.",
      "If ordered reads are required, keep an index sized for the active set and move history elsewhere.",
      "If the index must grow, give the shard enough memory and re-check eviction headroom.",
      "Re-run the load at peak and verify memory, p99, and encoding together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A sorted set buys ordered access with per-member index memory; a hash is leaner but cannot answer rank queries.",
      "A single string is compact and simple but makes partial reads and updates expensive.",
      "Compact encodings save memory only below their limits; crossing the limit converts the whole key.",
      "Archiving cold members protects the shard but adds a second lookup path and a retention policy.",
      "Adding shard memory buys time and leaves the per-member growth rate unchanged.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "estimate-key-memory",
    question:
      "You need a leaderboard of 5 million members with rank queries. How do you estimate whether a sorted set fits a 1 GB shard?",
    difficulty: 2,
    hints: [
      "Start with payload per member, then add the index overhead.",
      "The encoding changes when the collection stops being small.",
    ],
    answer:
      "I would estimate the value size per member, then add the sorted-set score and skip-list metadata, and multiply by the member count. I would check whether the key is small enough for a compact encoding; if not, the full encoding applies. Then I would compare the result with the shard's usable memory after replication buffers and other keys, not with the raw instance size. I would validate with `MEMORY USAGE` on a representative key and load the same shape in staging. If the estimate is close to the budget, I would bound the key or plan a larger shard before the backfill, because growth is linear.",
    followUps: [
      "What changes if the key uses a compact encoding?",
      "How would you validate the estimate in production safely?",
      "What would you archive first?",
    ],
    redFlags: [
      "Counts only the member payload.",
      "Assumes the instance size is the usable key budget.",
      "Ignores the encoding conversion.",
    ],
    rubric: [
      "Separates payload from structure overhead.",
      "Checks compact encoding limits.",
      "Leaves headroom for buffers and other keys.",
      "Names a validation step.",
    ],
  },
  {
    id: "compact-encoding",
    question:
      "A small hash uses little memory, but the same hash at ten times the size does not. What changed?",
    difficulty: 2,
    hints: [
      "Redis uses compact encodings below configured element and value limits.",
      "Crossing a limit converts the whole key.",
    ],
    answer:
      "Small aggregate values can use a compact encoding that stores entries in a linear structure with much less per-entry overhead. Redis converts the key to a full hash table or skip list when the element count or value size crosses the configured limit. The conversion is per key, so the memory step can be sudden rather than linear. I would check `OBJECT ENCODING` and the configured limits, then estimate the full-encoding cost before growing the key. If the compact form is load-bearing, keep the key under the limits or split it.",
    followUps: [
      "Which limit applies to a hash versus a sorted set?",
      "How would you detect the conversion in production?",
      "What happens to latency during the conversion?",
    ],
    redFlags: [
      "Assumes memory grows linearly through the whole range.",
      "Ignores `OBJECT ENCODING`.",
      "Tunes limits without measuring the full encoding.",
    ],
    rubric: [
      "Names compact versus full encoding.",
      "Explains the per-key conversion.",
      "Checks configured limits.",
      "Estimates the full-encoding cost.",
    ],
  },
  {
    id: "choose-structure",
    question:
      "The product needs top-N ranks, per-member profile fields, and a recent-activity feed. Do you use one key or several structures?",
    difficulty: 3,
    hints: [
      "Match each access pattern to the structure that serves it.",
      "Cross-structure consistency has a cost.",
    ],
    answer:
      "I would separate the access patterns. A sorted set serves top-N and rank queries; a hash serves profile fields by member ID; a capped list or stream serves the recent-activity feed. That keeps each key's cost and eviction behavior aligned with its use. The cost is that writes must update more than one key, so I would decide whether the feed and profile can be eventually consistent and whether a missing update is acceptable. If atomicity matters, a Lua script or a single hash with derived fields can help, but it may reintroduce the memory and scan cost I was trying to avoid.",
    followUps: [
      "How would you keep the sorted set and hash consistent?",
      "Which structure would you evict first under memory pressure?",
      "When is one key simpler than three?",
    ],
    redFlags: [
      "Uses one string for every access pattern.",
      "Adds structures without a consistency plan.",
      "Ignores eviction behavior per key.",
    ],
    rubric: [
      "Maps operations to structures.",
      "Names the consistency cost.",
      "Considers eviction and memory.",
      "States a failure mode.",
    ],
  },
];

const checklist = [
  {
    title: "Before the migration",
    items: [
      "Each key has an owner, a growth rate, and a memory budget.",
      "The estimate includes structure overhead, not only the payload.",
      "The encoding and its conversion limits are known for the expected size.",
      "The read path uses operations the structure can serve without a full scan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Measure the specific key with `MEMORY USAGE` and check `OBJECT ENCODING`.",
      "Compare the key with the shard budget and the rest of the working set.",
      "Protect the shard from further growth before changing the query path.",
      "Check whether a backfill or bulk write caused the step change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Bound or archive the key and verify the new growth rate.",
      "Re-check p99 and memory together at peak.",
      "Document the encoding and the size at which it changes.",
      "Add a capacity test for the key's expected growth.",
    ],
  },
];

const references = [
  {
    title: "Redis data types",
    url: "https://redis.io/docs/latest/develop/data-types/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Structure semantics and the operations each type supports.",
  },
  {
    title: "Memory optimization",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Compact encodings, per-member overhead, and allocator behavior.",
  },
  {
    title: "MEMORY USAGE",
    url: "https://redis.io/docs/latest/commands/memory-usage/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Per-key memory measurement used in the checklist.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "redis-data-types": {
      model: redisDataTypesModel,
      presets,
      instructions:
        "Start healthy, then apply Leaderboard rewrite. Watch memory cross the shard budget while p99 stays low, then switch the data type and apply Archive cold members.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 512 MB shard budget and per-member overhead values are teaching numbers, not Redis limits or a sizing guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-caching-strategies", "caching-eviction-policies", "caching-memory-fragmentation"],
};
