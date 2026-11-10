import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const POLICIES = ["noeviction", "allkeys-lru", "allkeys-lfu", "volatile-lru", "volatile-lfu"];
const READ_RPS = 50_000;
const ORIGIN_CAPACITY = 50_000;

const params = [
  {
    id: "workingSetGb",
    label: "Working set",
    min: 2,
    max: 48,
    step: 1,
    value: 6,
    unit: " GB",
    group: "Memory",
    help: "Keys the application needs to serve its normal read mix. This can exceed maxmemory.",
    format: "number" as const,
  },
  {
    id: "maxmemoryGb",
    label: "maxmemory",
    min: 1,
    max: 32,
    step: 1,
    value: 8,
    unit: " GB",
    group: "Memory",
    help: "The Redis memory limit for cached data. Replication and persistence buffers are outside this comparison.",
    format: "number" as const,
  },
  {
    id: "ttlCoverage",
    label: "Keys with a TTL",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Key mix",
    help: "Share of the working set that carries an expiration. volatile policies can evict only this share.",
    format: "percent" as const,
  },
  {
    id: "policy",
    label: "Eviction policy",
    min: 0,
    max: 4,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "0 noeviction, 1 allkeys-lru, 2 allkeys-lfu, 3 volatile-lru, 4 volatile-lfu. Volatile policies behave like noeviction when nothing has a TTL.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function policyOf(p: Params): number {
  return Math.round(clamp(num(p, "policy", 1), 0, 4));
}

interface Values {
  policy: number;
  policyName: string;
  workingSetGb: number;
  maxmemoryGb: number;
  ttlCoverage: number;
  memoryUsedGb: number;
  hitRate: number;
  missRate: number;
  evictions: number;
  writeErrors: number;
  originQps: number;
}

function compute(p: Params): Values {
  const policy = policyOf(p);
  const workingSetGb = Math.max(0.5, num(p, "workingSetGb", 6));
  const maxmemoryGb = Math.max(0.5, num(p, "maxmemoryGb", 8));
  const ttlCoverage = clamp(num(p, "ttlCoverage", 90) / 100, 0, 1);
  const ratio = workingSetGb / maxmemoryGb;
  const over = Math.max(0, workingSetGb - maxmemoryGb);
  const evictable = workingSetGb * ttlCoverage;
  const pressureHit = clamp((maxmemoryGb / workingSetGb) * 96 - 4, 5, 95);
  let hitRate = 96;
  let evictions = 0;
  let writeErrors = 0;
  if (ratio > 1) {
    if (policy === 0) {
      hitRate = clamp((maxmemoryGb / workingSetGb) * 96, 10, 95);
      writeErrors = clamp((ratio - 1) * 20, 5, 40);
    } else if (policy === 3 || policy === 4) {
      if (evictable >= over) {
        hitRate = clamp(pressureHit + (policy === 4 ? 10 : 0), 5, 95);
        evictions = over * (policy === 4 ? 90 : 120);
      } else {
        hitRate = 92;
        evictions = evictable * 110;
        writeErrors = clamp(((over - evictable) / Math.max(0.2, evictable)) * 20, 5, 40);
      }
    } else {
      hitRate = clamp(pressureHit + (policy === 2 ? 10 : 0), 5, 95);
      evictions = over * (policy === 2 ? 90 : 120);
    }
  }
  const missRate = 100 - hitRate;
  return {
    policy,
    policyName: POLICIES[policy],
    workingSetGb,
    maxmemoryGb,
    ttlCoverage,
    memoryUsedGb: Math.min(workingSetGb, maxmemoryGb),
    hitRate,
    missRate,
    evictions,
    writeErrors,
    originQps: (READ_RPS * missRate) / 100,
  };
}

function redisHealth(v: Values): "ok" | "warn" | "crit" {
  if (v.missRate >= 40 || v.writeErrors >= 5) return "crit";
  if (v.missRate >= 20 || v.writeErrors >= 1) return "warn";
  return "ok";
}

function dbHealth(qps: number): "ok" | "warn" | "crit" {
  if (qps >= 45_000) return "crit";
  if (qps >= 37_500) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}k`;
  return Math.round(value).toLocaleString();
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const wave = (index: number) => 0.97 + 0.05 * Math.sin((index + (seed % 6)) / 2.6);
  frame.series["miss-rate"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.missRate * wave(index)));
  frame.series["write-errors"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.writeErrors * wave(index + 2)));
  frame.series["evictions"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.evictions * wave(index + 3)));
  frame.series["hit-rate"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.hitRate * wave(index + 4)));
  frame.series["memory-used"] = Array.from({ length: 24 }, (_, index) => Math.max(0, v.memoryUsedGb * wave(index + 5)));
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const cacheHealth = redisHealth(v);
  const originHealth = dbHealth(v.originQps);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Readers",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(READ_RPS)} rps reference`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Cache client",
        kind: "service",
        health: v.writeErrors >= 5 ? "crit" : v.writeErrors >= 1 ? "warn" : "ok",
        utilization: clamp(READ_RPS / 80_000),
        throughput: READ_RPS,
        sublabel: v.writeErrors > 0 ? `${v.writeErrors.toFixed(0)}% writes rejected` : "reads and writes",
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Redis cache",
        kind: "cache",
        health: cacheHealth,
        utilization: clamp(v.memoryUsedGb / v.maxmemoryGb),
        throughput: READ_RPS,
        sublabel: `${v.policyName} · ${v.hitRate.toFixed(0)}% hit`,
        detail: `Working set ${v.workingSetGb.toFixed(0)} GB, maxmemory ${v.maxmemoryGb.toFixed(0)} GB, ${Math.round(v.ttlCoverage * 100)}% of keys with a TTL. This model estimates ${formatCount(v.evictions)} evictions/s.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Origin database",
        kind: "db",
        health: originHealth,
        utilization: clamp(v.originQps / ORIGIN_CAPACITY),
        throughput: v.originQps,
        sublabel: `${formatCount(v.originQps)} qps from misses`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", 0.6),
      edge("app-redis", "app", "redis", 1 - v.missRate / 100, cacheHealth),
      edge("app-db", "app", "db", v.missRate / 100, originHealth),
    ],
    metrics: [
      metric("miss-rate", "Cache miss rate", v.missRate, "%", 20, 40, "percent"),
      metric("write-errors", "Rejected writes", v.writeErrors, "%", 1, 5, "percent"),
      metric("evictions", "Evictions", v.evictions, "/s", 500, 2_000, "number"),
      metric("hit-rate", "Cache hit rate", v.hitRate, "%", undefined, undefined, "percent"),
      metric("memory-used", "Memory used", v.memoryUsedGb, " GB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.policyName}: ${v.hitRate.toFixed(0)}% hit, ${v.missRate.toFixed(0)}% miss, ${formatCount(v.originQps)} qps to the origin, ${v.writeErrors.toFixed(0)}% writes rejected.`,
  };
  seedSeries(frame, v, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "miss-rate",
    metricId: "miss-rate",
    warn: 20,
    crit: 40,
    title: "Eviction is removing keys the application still needs",
    cause:
      "The working set is larger than maxmemory, so the policy evicts keys between reads. allkeys policies may remove a hot key; volatile policies may remove only TTL keys and leave persistent data occupying memory.",
    fix:
      "Match the policy to the key mix and give the working set enough memory. allkeys-lru or allkeys-lfu protects reads when every key is cacheable; volatile policies fit a mixed instance only when the TTL share covers the pressure.",
    checkFirst: [
      "Check `INFO stats` for `evicted_keys` and `keyspace_hits` versus `keyspace_misses`.",
      "Check `INFO memory` for `used_memory` against `maxmemory`.",
      "Check whether the hot keys have TTLs and which policy is actually configured.",
    ],
  },
  {
    id: "write-errors",
    metricId: "write-errors",
    warn: 1,
    crit: 5,
    title: "Writes are being rejected because nothing can be evicted",
    cause:
      "noeviction, or a volatile policy without enough TTL keys, leaves memory full and rejects commands that add data. Reads of existing keys still work, so the hit rate can look healthy while the write path fails.",
    fix:
      "Either allow all keys to be evicted or ensure the TTL share and maxmemory leave room for the write path. If the data must never be evicted, move it out of the cache or raise the limit with headroom.",
    checkFirst: [
      "Check `INFO commandstats` for rejected commands and the current policy.",
      "Check the TTL coverage of the working set.",
      "Check whether a non-cache dataset is sharing the instance.",
    ],
  },
  {
    id: "evictions",
    metricId: "evictions",
    warn: 500,
    crit: 2_000,
    title: "The cache is evicting continuously",
    cause:
      "Continuous eviction means the working set does not fit. The cache is churning: every new key displaces one that will be requested again, so origin load follows.",
    fix:
      "Reduce the working set, add memory, or change the key mix so the hot subset fits. A policy change can improve which keys survive, but it cannot make an oversized working set fit.",
    checkFirst: [
      "Compare `evicted_keys` with the write rate and key count.",
      "Check whether the working set grew after a deploy or backfill.",
      "Check whether TTLs are expiring keys before eviction can help.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const evictionPoliciesModel: SimModel = {
  id: "caching-eviction-policies",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const jittered: Params = {
      ...p,
      workingSetGb: num(p, "workingSetGb", 6) * (1 + rng.between(-0.002, 0.002) * Math.min(1, dt / 0.1)),
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
    const items = [
      `The working set is ${v.workingSetGb.toFixed(0)} GB against ${v.maxmemoryGb.toFixed(0)} GB of maxmemory; a ${v.policyName} policy estimates a ${v.missRate.toFixed(0)}% miss rate.`,
      v.policy === 0
        ? "noeviction keeps existing keys but rejects commands that add data once memory is full. Reads can stay healthy while writes fail."
        : v.policy <= 2
          ? "allkeys policies may evict any key. LRU approximates recency, LFU tracks frequency with decay, so LFU usually keeps a repeatedly read hot key longer."
          : "volatile policies evict only keys with a TTL. If the TTL share cannot free enough memory, they behave like noeviction and reject writes.",
      `${Math.round(v.ttlCoverage * 100)}% of keys carry a TTL. That share is the size of the evictable pool for volatile policies, not a guarantee that the right keys survive.`,
      `Misses send ${formatCount(v.originQps)} qps to the origin in this model. Continuous eviction turns a cache capacity problem into a database load problem.`,
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
    description: "The working set fits in maxmemory; no eviction and a high hit rate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The working set is 20% over maxmemory; LRU begins to churn keys.",
    tone: "warn",
    params: defaults({ workingSetGb: 9.6, maxmemoryGb: 8, ttlCoverage: 100, policy: 1 }),
  },
  {
    id: "failure",
    label: "Working set does not fit",
    description: "28 GB of keys in 8 GB of memory under allkeys-lru; the hot set is evicted.",
    tone: "crit",
    params: defaults({ workingSetGb: 28, maxmemoryGb: 8, ttlCoverage: 100, policy: 1 }),
  },
  {
    id: "volatile-mistake",
    label: "Volatile, few TTLs",
    description: "Only 15% of keys expire, so volatile-lru runs out of evictable keys and rejects writes.",
    tone: "crit",
    params: defaults({ workingSetGb: 28, maxmemoryGb: 8, ttlCoverage: 15, policy: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Fit the working set under maxmemory and use LFU to retain frequently read keys.",
    tone: "ok",
    params: defaults({ workingSetGb: 7.8, maxmemoryGb: 8, ttlCoverage: 100, policy: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-volatile-mistake",
  title: "Predict what volatile-lru protects",
  simId: "eviction-policies",
  question:
    "Only 15% of keys have a TTL. You switch from allkeys-lru to volatile-lru to protect persistent keys. What happens under memory pressure?",
  prediction: {
    options: [
      { id: "writes", label: "Eviction is limited to TTL keys; once they run out, writes are rejected while memory stays full." },
      { id: "more", label: "Evictions increase because the policy has a smaller pool to choose from." },
      { id: "hit", label: "The hit rate rises to 100% because persistent keys can never be evicted." },
      { id: "free", label: "Memory shrinks because volatile keys are expired first." },
    ],
    correctOptionId: "writes",
    explanation:
      "volatile-lru can evict only keys with a TTL. When that pool is too small to free the required memory, the instance behaves like noeviction for commands that add data: writes fail, but reads of existing keys continue. The hit rate can look healthy while the write path is broken, which is why rejected writes is a separate signal.",
  },
  setup: defaults({ workingSetGb: 28, maxmemoryGb: 8, ttlCoverage: 15, policy: 3 }),
  runFor: 12,
  observe: [
    "The miss rate stays low because cached reads still hit.",
    "Rejected writes climb as the TTL pool is exhausted.",
    "Evictions stop being enough to keep memory below the limit for new data.",
    "Switching to allkeys-lfu and fitting the working set removes both signals.",
  ],
  explain:
    "A volatile policy is not a way to protect persistent keys for free. It narrows the eviction pool to TTL keys, and when the required memory exceeds that pool, Redis cannot make room. The result is rejected writes, not more evictions. The fix is to size the working set, or separate persistent data from cache data, rather than expecting the policy to protect everything.",
  fix: defaults({ workingSetGb: 7.8, maxmemoryGb: 8, ttlCoverage: 100, policy: 2 }),
  debrief:
    "The volatile policy protected non-TTL keys by refusing to evict them, and the write path paid for it. allkeys-lfu with the working set inside maxmemory returned both reads and writes to healthy. If the persistent keys must stay in Redis, give them a separate instance or a memory budget that does not depend on evicting the cache.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Redis enforces a memory limit with `maxmemory`. When a command would add data above that limit, Redis applies `maxmemory-policy` to choose keys to evict. `noeviction` removes nothing and returns an error for commands that add data. `allkeys-lru` (least recently used) and `allkeys-lfu` (least frequently used) may evict any key, approximating recency or frequency. `volatile-lru` and `volatile-lfu` may evict only keys with a time to live (TTL) set; if none have a TTL, they behave like `noeviction`.",
  },
  {
    type: "p",
    text: "The policy is a statement about which keys are allowed to disappear. It cannot make an oversized working set fit. If the hot set is larger than the memory available, every policy will churn it or reject writes. The useful distinction is whether the failure appears as misses, as rejected writes, or both.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, application, Redis, then the origin database on a miss. The write path hits the same Redis limit: if memory is full and no key can be evicted, the write fails before it reaches the origin. The eviction policy therefore sits between the cache's memory budget and both request paths.",
  },
  {
    type: "compare",
    leftTitle: "allkeys policy",
    rightTitle: "volatile policy",
    rows: [
      { label: "Eligible keys", left: "Every key in the keyspace", right: "Only keys with an expiration" },
      { label: "Typical use", left: "A dedicated cache where all data is disposable", right: "A mixed instance with persistent keys alongside cache keys" },
      { label: "Failure when memory is short", left: "Hot keys are evicted and misses rise", right: "Writes are rejected once the TTL pool is exhausted" },
      { label: "Signal to watch", left: "`evicted_keys` and miss rate", right: "Rejected commands and TTL coverage" },
    ],
  },
  {
    type: "p",
    text: "This module uses a 50,000 reads/s reference workload, a 50,000 queries per second (QPS) origin, and 2–48 GB working sets as illustrative teaching values. The policy behavior follows Redis: `noeviction` rejects writes, `volatile-*` only evicts keys with a TTL, and LRU/LFU are approximations. The exact hit-rate and eviction curves are model estimates, not Redis benchmarks.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Cache miss rate and hit rate, which move in opposite directions.",
      "Rejected writes, the signal that volatile or noeviction policies produce instead of misses.",
      "Evictions per second and memory used against maxmemory.",
      "Origin QPS, which rises when misses replace cache reads.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Working set does not fit. Watch the miss rate and origin load rise as the hot set is evicted. Apply Volatile, few TTLs next: the miss rate looks better but writes are rejected. Then apply Recovery and compare which signal disappeared. Run the experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Policy", "Can evict", "Fails as"],
    rows: [
      ["noeviction", "Nothing", "Rejected writes when memory is full"],
      ["allkeys-lru", "Any key", "Misses when hot keys are displaced"],
      ["allkeys-lfu", "Any key", "Misses, but frequency usually keeps hot keys longer"],
      ["volatile-lru / volatile-lfu", "Keys with a TTL only", "Rejected writes once the TTL pool is exhausted"],
    ],
  },
  {
    type: "p",
    text: "The first question is not which policy has the best hit rate. It is which keys are allowed to disappear and which path must never fail. A cache-only instance can usually use allkeys-lfu or allkeys-lru. A mixed instance needs a memory budget that does not rely on evicting data the application cannot rebuild.",
  },
  { type: "sim", simId: "eviction-policies" },
  { type: "experiment", experimentId: "predict-volatile-mistake" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The working set was larger than maxmemory, so every read had to compete with new writes for space. Under allkeys-lru the cache evicted keys it would need again, the miss rate rose, and the origin database absorbed the difference. Under volatile-lru with few TTL keys, the cache could not evict enough and started rejecting writes while reads of cached keys still looked healthy.",
  },
  {
    type: "p",
    text: "Fitting the working set under maxmemory removed the pressure. allkeys-lfu then kept frequently read keys longer than LRU. The policy improved which keys survived, but it did not replace the memory budget.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`INFO stats`: `evicted_keys`, `keyspace_hits`, `keyspace_misses`, and `expired_keys`.",
      "`INFO memory`: `used_memory`, `used_memory_dataset`, `maxmemory`, and `mem_fragmentation_ratio`.",
      "`INFO commandstats`: rejected commands when the policy cannot free memory.",
      "Origin database QPS and latency, which follow the cache miss rate.",
      "Application errors on writes, often with an out-of-memory message, while reads still succeed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the configured policy and maxmemory, then separate miss-driven load from rejected writes. If evictions are high, the working set does not fit. If writes are rejected with few evictions, the policy has no eligible keys.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the working set and compare it with usable memory, not the instance's total size.",
      "Choose allkeys-lfu or allkeys-lru for a dedicated cache; use volatile policies only when the TTL share covers the pressure.",
      "Reduce the working set or add memory so the hot subset fits with headroom.",
      "Protect the origin with request coalescing and load shedding while the cache churns.",
      "Watch rejected writes separately from hit rate; a healthy hit rate can hide a broken write path.",
      "Re-run at peak and verify evictions, misses, rejected writes, and origin load together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "allkeys-lru is simple and adapts to recency, but a scan or batch job can displace the hot set.",
      "allkeys-lfu keeps frequently used keys longer, but frequency counters are approximate and decay over time.",
      "volatile policies protect persistent keys but can reject writes when too few keys have a TTL.",
      "noeviction preserves existing data and fails the write path; it is not a capacity plan.",
      "More memory delays the decision; it does not change which keys the policy is allowed to remove.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-eviction",
    question:
      "Redis hit rate dropped from 95% to 60% and the origin database is overloaded. How do you confirm eviction is the cause?",
    difficulty: 2,
    hints: [
      "Check evictions and memory together.",
      "A working-set change can look like a traffic change.",
    ],
    answer:
      "I would check `evicted_keys` against the start of the miss increase, then compare `used_memory` with `maxmemory`. If evictions are high and memory is pinned at the limit, the working set no longer fits. I would also check whether a deploy, backfill, or TTL change altered the key mix, and whether the misses are concentrated on keys that used to be hot. I would rule out a Redis restart or a cold cache, which also raises misses but does not require evictions. The confirmation is that the origin load tracks the eviction period, not a traffic increase.",
    followUps: [
      "What if evictions are low but misses are high?",
      "How would you tell an LRU problem from an LFU problem?",
      "What would you change first during the incident?",
    ],
    redFlags: [
      "Adds origin capacity before checking evictions.",
      "Treats hit rate as a policy-only metric.",
      "Ignores a cold cache or restart.",
    ],
    rubric: [
      "Aligns evictions with the miss increase.",
      "Checks memory against maxmemory.",
      "Rules out cold cache and traffic.",
      "Names the origin impact.",
    ],
  },
  {
    id: "maxmemory-scope",
    question:
      "You set maxmemory to 8 GB and see the process using 10 GB. Is Redis ignoring the limit?",
    difficulty: 3,
    hints: [
      "maxmemory compares cached data, not every process allocation.",
      "Replication buffers and client buffers are outside that comparison.",
    ],
    answer:
      "No. maxmemory is compared with the memory used for cached data, and Redis documents that replication buffers are not included in that total. Client output buffers, allocator metadata, and fragmentation also contribute to RSS. A replica may ignore maxmemory by default and rely on the primary's evictions. I would read `used_memory`, `used_memory_rss`, and `mem_not_counted_for_evict`, then check replica buffers and client buffers. The limit is doing its job for the dataset; the process is using memory the limit does not govern.",
    followUps: [
      "How would you cap the memory outside maxmemory?",
      "Why does a replica use more memory than its primary?",
      "What would you alert on?",
    ],
    redFlags: [
      "Concludes maxmemory is broken.",
      "Confuses RSS with the dataset.",
      "Ignores replica and client buffers.",
    ],
    rubric: [
      "Distinguishes dataset from process memory.",
      "Names buffers outside maxmemory.",
      "Reads the right INFO fields.",
      "Proposes a cap or headroom.",
    ],
  },
  {
    id: "choose-policy",
    question:
      "You have a cache instance that also stores idempotency keys that must not be evicted. Which policy and layout do you choose?",
    difficulty: 3,
    hints: [
      "The two datasets have different loss rules.",
      "A policy cannot protect one key class inside a single memory pool.",
    ],
    answer:
      "I would separate them. Idempotency keys are not cache data; they need a durability and eviction policy of their own. Putting them in the same instance means an allkeys policy can evict them, while a volatile policy can reject cache writes when the TTL pool is exhausted. I would move the idempotency keys to a separate instance or a durable store, then use allkeys-lfu for the cache with enough memory for its working set. If they must share, I would give the persistent keys no TTL and size maxmemory so the cache portion can be evicted without touching them, but that is a weaker guarantee and needs monitoring.",
    followUps: [
      "What durability does the idempotency store need?",
      "How would you migrate the keys without losing writes?",
      "What would you alert on after the split?",
    ],
    redFlags: [
      "Uses allkeys-lru with persistent keys in the same pool.",
      "Assumes volatile-lru protects all non-TTL keys without a cost.",
      "Ignores durability for idempotency data.",
    ],
    rubric: [
      "Separates data classes by loss rule.",
      "Explains why one policy cannot protect both.",
      "Sizes the cache for its working set.",
      "Names migration and monitoring.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The cache has a measured working set and a maxmemory with headroom.",
      "The policy matches the key mix and every key's loss rule is known.",
      "Evictions, rejected writes, hit rate, and origin load are on one dashboard.",
      "A cold-cache and eviction drill has been run at peak.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the failure is misses or rejected writes.",
      "Check `evicted_keys`, `used_memory`, and `maxmemory` together.",
      "Protect the origin with coalescing or load shedding before adding cache memory.",
      "Check whether a deploy, backfill, or TTL change altered the working set.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Resize or re-layout so the hot subset fits.",
      "Re-check the policy against the key mix after the change.",
      "Record the remaining headroom and the next growth trigger.",
      "Add a regression test for the eviction and rejection signals.",
    ],
  },
];

const references = [
  {
    title: "Key eviction",
    url: "https://redis.io/docs/latest/develop/reference/eviction/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "maxmemory, policy names, approximated LRU, and LFU behavior.",
  },
  {
    title: "INFO command",
    url: "https://redis.io/docs/latest/commands/info/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "keyspace_hits, keyspace_misses, evicted_keys, and memory fields.",
  },
  {
    title: "Memory optimization",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/memory-optimization/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Working-set sizing and memory limits.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "eviction-policies": {
      model: evictionPoliciesModel,
      presets,
      instructions:
        "Start healthy, apply Working set does not fit, then compare Volatile, few TTLs. Watch miss rate and rejected writes as separate failure signals.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 50k reads/s reference and 50k qps origin are teaching values; the policy eligibility rules follow Redis.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["caching-redis-data-types", "caching-cache-penetration", "caching-hot-key-detection"],
};
