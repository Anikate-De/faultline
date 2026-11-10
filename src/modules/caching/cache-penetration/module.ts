import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DB_CAPACITY = 8_000;
const VALID_MISS_RATE = 0.05;
const REDIS_CAPACITY = 60_000;
const BLOOM_KEY_SPACE = 1_000_000;

const params = [
  {
    id: "requestRps",
    label: "Request rate",
    min: 2_000,
    max: 40_000,
    step: 1_000,
    value: 10_000,
    unit: " rps",
    group: "Traffic",
    help: "Total read requests per second, including valid IDs and random or malformed IDs.",
    format: "rps" as const,
  },
  {
    id: "absentKeySharePct",
    label: "Absent-key share",
    min: 0,
    max: 90,
    step: 5,
    value: 10,
    unit: "%",
    group: "Traffic",
    help: "Share of requests for IDs that do not exist. These never produce a normal cache hit.",
    format: "percent" as const,
  },
  {
    id: "negativeCacheHitPct",
    label: "Negative cache coverage",
    min: 0,
    max: 95,
    step: 5,
    value: 60,
    unit: "%",
    group: "Filters",
    help: "Share of absent-key requests for a key whose not-found marker is still cached. Random, never-repeated IDs defeat it.",
    format: "percent" as const,
  },
  {
    id: "bloomBitsPerKey",
    label: "Bloom filter size",
    min: 0,
    max: 16,
    step: 1,
    value: 8,
    unit: " bits/key",
    group: "Filters",
    help: "Bits per key in the existence filter. Zero disables it. More bits lower the false-positive rate and use more memory.",
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

function bloomFalsePositiveRate(bitsPerKey: number): number {
  if (bitsPerKey <= 0) return 0;
  const hashes = Math.max(1, Math.round(bitsPerKey * Math.LN2));
  return (1 - Math.exp(-hashes / bitsPerKey)) ** hashes;
}

interface Values {
  requestRps: number;
  absentShare: number;
  negativeHit: number;
  bits: number;
  validRps: number;
  absentRps: number;
  bloomFpr: number;
  passRate: number;
  absentToDb: number;
  dbQps: number;
  dbUtil: number;
  dbCpu: number;
  dbP99: number;
  hitRate: number;
  redisRps: number;
  bloomMemoryMb: number;
}

function compute(p: Params, noise = 1): Values {
  const requestRps = Math.max(1, num(p, "requestRps", 10_000) * noise);
  const absentShare = clamp(num(p, "absentKeySharePct", 10) / 100);
  const negativeHit = clamp(num(p, "negativeCacheHitPct", 60) / 100, 0, 0.95);
  const bits = Math.max(0, num(p, "bloomBitsPerKey", 8));
  const validRps = requestRps * (1 - absentShare);
  const absentRps = requestRps * absentShare;
  const bloomFpr = bloomFalsePositiveRate(bits);
  const passRate = bits > 0 ? bloomFpr : 1;
  const absentToDb = absentRps * (1 - negativeHit) * passRate;
  const dbQps = absentToDb + validRps * VALID_MISS_RATE;
  const dbUtil = dbQps / DB_CAPACITY;
  const dbCpu = Math.min(100, dbUtil * 100);
  const dbP99 = dbUtil <= 1 ? 2 + 12 * dbUtil ** 4 : 25 + 260 * Math.log2(dbUtil);
  const hitRate = (validRps * (1 - VALID_MISS_RATE) + absentRps * negativeHit) / requestRps;
  const redisRps = requestRps;
  const bloomMemoryMb = (BLOOM_KEY_SPACE * bits) / 8 / 1_000_000;

  return {
    requestRps,
    absentShare,
    negativeHit,
    bits,
    validRps,
    absentRps,
    bloomFpr,
    passRate,
    absentToDb,
    dbQps,
    dbUtil,
    dbCpu,
    dbP99,
    hitRate,
    redisRps,
    bloomMemoryMb,
  };
}

type HealthState = "ok" | "warn" | "crit";

function healthForUtil(util: number): HealthState {
  if (util >= 1) return "crit";
  if (util >= 0.75) return "warn";
  return "ok";
}

function filterHealth(fpr: number): HealthState {
  if (fpr >= 0.08) return "crit";
  if (fpr >= 0.03) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, values: Values, seed: number, t: number): SimFrame {
  const dbHealth = healthForUtil(values.dbUtil);
  const redisHealth = healthForUtil(values.redisRps / REDIS_CAPACITY);
  const bloomHealth: HealthState = values.bits > 0 ? filterHealth(values.bloomFpr) : "warn";
  const serviceHealth: HealthState = values.dbUtil >= 1.2 ? "warn" : "ok";

  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(values.requestRps)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Catalog service",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(values.requestRps / 40_000),
        throughput: values.requestRps,
        sublabel: `${(values.absentShare * 100).toFixed(0)}% absent IDs`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Shared Redis",
        kind: "cache",
        health: redisHealth,
        utilization: clamp(values.redisRps / REDIS_CAPACITY),
        throughput: values.redisRps,
        capacity: REDIS_CAPACITY,
        sublabel: `${(values.hitRate * 100).toFixed(0)}% overall hit rate`,
        detail: "Absent keys cannot hit a value cache, so the cache cannot protect the database from them by itself.",
        meta: { view: "flow" },
      },
      {
        id: "negative",
        label: "Negative cache",
        kind: "cache",
        health: "ok",
        utilization: clamp(values.negativeHit),
        throughput: values.absentRps * values.negativeHit,
        sublabel: `${(values.negativeHit * 100).toFixed(0)}% absent hits`,
        detail: "Stores a not-found marker for an absent key. A hit returns not found before the Bloom filter or database is consulted. The marker must be short-lived and invalidated when the key is created.",
        meta: { view: "flow" },
      },
      {
        id: "bloom",
        label: "Bloom filter",
        kind: "service",
        health: bloomHealth,
        utilization: clamp(values.bloomFpr / 0.16),
        throughput: values.absentRps * (1 - values.negativeHit),
        sublabel: values.bits > 0 ? `${values.bits} bits/key, ${(values.bloomFpr * 100).toFixed(1)}% false positives` : "disabled",
        detail: `Checks the absent keys that missed the negative cache. It can say definitely absent or possibly present, with no false negatives against the set it was built from. Illustrative memory: ${values.bloomMemoryMb.toFixed(1)} MB for ${formatCount(BLOOM_KEY_SPACE)} keys.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Primary database",
        kind: "db",
        health: dbHealth,
        utilization: clamp(values.dbUtil),
        throughput: values.dbQps,
        capacity: DB_CAPACITY,
        sublabel: `${formatCount(values.dbQps)} qps`,
        detail: `Illustrative teaching capacity: ${formatCount(DB_CAPACITY)} qps. Absent-key lookups that pass both filters have no cache value to reuse.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-service", "client", "service", values.requestRps / 40_000),
      edge("service-redis", "service", "redis", 0.7),
      edge("service-negative", "service", "negative", clamp(values.absentShare)),
      edge("negative-bloom", "negative", "bloom", clamp(1 - values.negativeHit)),
      edge("bloom-db", "bloom", "db", clamp(values.dbQps / Math.max(1, values.requestRps)), dbHealth),
      edge("redis-db", "redis", "db", clamp((values.validRps * VALID_MISS_RATE) / Math.max(1, values.requestRps))),
    ],
    metrics: [
      metric("db-qps", "Database QPS", values.dbQps, " qps", 6_000, 8_000, "rps"),
      metric("db-cpu", "Database CPU", values.dbCpu, "%", 75, 90, "percent"),
      metric("db-p99", "Database p99", values.dbP99, "ms", 100, 400, "ms"),
      metric("absent-db-rps", "Absent requests reaching DB", values.absentToDb, " rps", undefined, undefined, "rps"),
      metric("bloom-fpr", values.bits > 0 ? "Bloom false positives" : "Bloom false positives (disabled)", values.bits > 0 ? values.bloomFpr * 100 : 0, "%", values.bits > 0 ? 3 : undefined, values.bits > 0 ? 8 : undefined, "percent"),
      metric("hit-rate", "Overall cache hit rate", values.hitRate * 100, "%", undefined, undefined, "percent"),
      metric("negative-hit", "Negative cache hits", values.negativeHit * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${(values.absentShare * 100).toFixed(0)}% absent IDs, ${formatCount(values.absentToDb)} absent requests/s reach the database, ${formatCount(values.dbQps)} total qps.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const entries: [string, number][] = [
    ["db-qps", values.dbQps],
    ["db-cpu", values.dbCpu],
    ["db-p99", values.dbP99],
    ["absent-db-rps", values.absentToDb],
    ["bloom-fpr", values.bloomFpr * 100],
    ["hit-rate", values.hitRate * 100],
    ["negative-hit", values.negativeHit * 100],
  ];
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 10)) / 2.8);
  for (const [id, value] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * Math.max(0.1, value * 0.01)),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "db-qps",
    metricId: "db-qps",
    warn: 6_000,
    crit: 8_000,
    title: "Absent-key requests pushed the database past capacity",
    cause:
      "Random or invalid IDs cannot hit a value cache. Every request reaches the database unless a negative cache or an existence filter rejects it first.",
    fix:
      "Stop the traffic at the edge, then add a negative cache for repeated keys and a Bloom filter for keys that have never existed. Neither replaces input validation.",
    checkFirst: [
      "Compare database QPS with the absent-key share, not with total traffic.",
      "Sample the query keys: are they absent, malformed, or outside the valid ID space?",
      "Check whether the same absent keys repeat or rotate.",
    ],
  },
  {
    id: "db-cpu",
    metricId: "db-cpu",
    warn: 75,
    crit: 90,
    title: "Database CPU saturated on lookups that return nothing",
    cause:
      "The database is spending capacity on queries that cannot return a row. The cache is healthy but has no entry to serve because the key does not exist.",
    fix:
      "Reject definitely-absent keys before the database. Add load shedding and a bounded fallback while the filters are deployed.",
    checkFirst: [
      "Check CPU against query count per second, not against cache hit rate.",
      "Check whether the slow queries are indexed lookups or scans.",
      "Check whether retries are multiplying the absent-key traffic.",
    ],
  },
  {
    id: "db-p99",
    metricId: "db-p99",
    warn: 100,
    crit: 400,
    title: "Database tail latency rose under absent-key load",
    cause:
      "A high volume of small lookups still consumes connections and CPU. The queue grows even when each query is cheap.",
    fix:
      "Reduce the number of queries before the database and protect the connection pool. Adding an index does not help a key that does not exist.",
    checkFirst: [
      "Compare p99 with absent requests per second and connection pool wait.",
      "Check whether the database is doing point lookups or scans.",
      "Check whether a retry loop is amplifying the traffic.",
    ],
  },
  {
    id: "bloom-fpr",
    metricId: "bloom-fpr",
    warn: 3,
    crit: 8,
    title: "The Bloom filter is undersized for the key set",
    cause:
      "Too few bits per key raises the false-positive rate. A false positive makes an absent key look possibly present, so it passes to the database. The filter never rejects a key that actually exists.",
    fix:
      "Add bits per key, rebuild with the right capacity, or shard the filter. Measure memory as well as the false-positive target.",
    checkFirst: [
      "Check the filter's configured capacity against the real key count.",
      "Check the hash count and the fill ratio.",
      "Check whether the false positives are concentrated on a key range.",
    ],
  },
];

export const cachePenetrationModel: SimModel = {
  id: "caching-cache-penetration",
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

    if (values.absentToDb >= 5_000 && frame.flags.penetrationEvent !== 1) {
      pushEvent(next, {
        id: "penetration-wave",
        at: frame.t,
        severity: "crit",
        title: "Absent-key traffic is reaching the database unbounded",
        detail: `${formatCount(values.absentToDb)} absent-key requests/s pass the filters, with a ${(values.absentShare * 100).toFixed(0)}% absent share.`,
        nodeId: "db",
        metricId: "db-qps",
      });
      next.flags.penetrationEvent = 1;
    }
    if (values.absentToDb < 2_000) next.flags.penetrationEvent = 0;

    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${formatCount(values.absentRps)} requests/s are for absent keys. A value cache cannot serve them; only a negative cache or an existence filter can reject them early.`,
      `The negative cache covers ${(values.negativeHit * 100).toFixed(0)}% of absent traffic. Random keys that never repeat get no benefit.`,
      values.bits > 0
        ? `At ${values.bits} bits/key the Bloom false-positive rate is about ${(values.bloomFpr * 100).toFixed(1)}%. Those false positives pass to the next layer; there are no false negatives.`
        : "The Bloom filter is disabled, so every absent key that misses the negative cache reaches the database.",
      `${formatCount(values.absentToDb)} absent requests/s reach the database, part of ${formatCount(values.dbQps)} total qps.`,
      `The database is at ${(values.dbUtil * 100).toFixed(0)}% of its illustrative capacity.`,
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
    description: "Modest traffic, a small absent share, and an 8-bit Bloom filter.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with a weak filter",
    description: "More traffic and a 6-bit filter. False positives enter the warning band.",
    tone: "warn",
    params: defaults({
      requestRps: 35_000,
      absentKeySharePct: 50,
      negativeCacheHitPct: 40,
      bloomBitsPerKey: 6,
    }),
  },
  {
    id: "failure",
    label: "Penetration",
    description: "Three quarters of requests are absent and both filters are absent or ineffective.",
    tone: "crit",
    params: defaults({
      requestRps: 40_000,
      absentKeySharePct: 75,
      negativeCacheHitPct: 20,
      bloomBitsPerKey: 0,
    }),
  },
  {
    id: "recovery",
    label: "Filtered",
    description: "A 10-bit filter and a 90% negative-cache hit rate stop almost all absent traffic.",
    tone: "ok",
    params: defaults({
      requestRps: 40_000,
      absentKeySharePct: 75,
      negativeCacheHitPct: 90,
      bloomBitsPerKey: 10,
    }),
  },
  {
    id: "bloom-only",
    label: "Bloom only",
    description: "A 12-bit filter with no negative cache. Absent keys that pass as false positives still reach the database.",
    tone: "ok",
    params: defaults({
      requestRps: 40_000,
      absentKeySharePct: 75,
      negativeCacheHitPct: 0,
      bloomBitsPerKey: 12,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-bloom-only",
  title: "Predict what an 8-bit Bloom filter removes",
  simId: "cache-penetration",
  question:
    "Absent keys are 75% of 40,000 reads/s. You add an 8-bit Bloom filter and leave the negative cache at zero. What reaches the database?",
  prediction: {
    options: [
      {
        id: "fpr-only",
        label: "About 2% of absent traffic, because false positives still pass.",
      },
      { id: "zero", label: "Nothing; the filter rejects every absent key." },
      { id: "half", label: "About half of absent traffic, set by the key distribution." },
      { id: "more", label: "More than before, because the filter adds a lookup." },
    ],
    correctOptionId: "fpr-only",
    explanation:
      "At 8 bits per key with the optimal hash count, the theoretical false-positive rate is about 2%. Those false positives are absent keys that the filter says might exist, so they pass to the next layer. A Bloom filter is exact only in the negative direction: it can say definitely absent, never definitely present.",
  },
  setup: defaults({
    requestRps: 40_000,
    absentKeySharePct: 75,
    negativeCacheHitPct: 0,
    bloomBitsPerKey: 8,
  }),
  runFor: 20,
  observe: [
    "Absent traffic reaching the database falls from 30,000 to about 650 requests/s.",
    "Database QPS falls to about 1,150, well under the 8,000 teaching capacity.",
    "The Bloom false-positive rate reads about 2.2%.",
    "Valid-key traffic is unchanged; the filter does not remove keys that exist.",
    "The remaining database load includes the fixed 5% miss rate on valid keys.",
  ],
  explain:
    "The filter removes the definitely-absent majority before the database. What remains is the false-positive slice plus the normal miss rate on valid keys. The false-positive rate is a function of bits per key, not of how many requests arrive. More bits lower it; fewer bits raise it. The negative cache is still useful for repeated absent keys because it stores an exact answer and can be invalidated when a key is created.",
  fix: defaults({
    requestRps: 40_000,
    absentKeySharePct: 75,
    negativeCacheHitPct: 90,
    bloomBitsPerKey: 10,
  }),
  debrief:
    "The filter took the database from overload to comfort without touching the valid-key path. That is the right first move for random IDs: reject the impossible keys before they consume a connection. The negative cache then removes most of the remaining repeated absent keys, including the false positives that the filter lets through. Neither control fixes malformed input, so validation and rate limiting still belong at the edge.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cache penetration is repeated lookup of keys that do not exist. A value cache only holds rows that were found, so a request for an absent ID always misses. If clients send random or malformed IDs, the cache hit rate can look normal for valid traffic while the database absorbs a separate stream of queries that can never return a row. This is different from a stampede, where one existing hot key expires and many readers recompute it, and from an avalanche, where many existing keys expire at once. Penetration is driven by the key space, so it does not heal when the cache warms.",
  },
  {
    type: "p",
    text: "Two controls reject absent keys early. A negative cache stores a not-found marker with a short time to live (TTL). It is exact for the keys it holds, but it costs memory, it only helps repeated keys, and a marker written before a key was created can hide the new row until the TTL expires or the marker is invalidated. A Bloom filter is a bit array with several hash functions. Adding a key sets bits; a lookup says definitely absent if any required bit is zero, otherwise possibly present. It has no false negatives against the set it was built from, so it never rejects a key that exists. It does have false positives, which let absent keys through to the next layer. With m bits and n keys, about m/n bits per key and k = (m/n) ln 2 hashes give a false-positive rate near (1 - e^(-kn/m))^k. The filter must be updated when keys are created; a stale filter can say definitely absent for a new valid key.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, service, shared or local cache, negative cache, existence filter, database. A value-cache hit returns immediately; a negative-cache hit returns not found; otherwise the Bloom filter rejects definitely-absent keys; a possibly-present result reads the database. A database miss then writes a negative marker. The negative cache stores an exact answer for repeated absent keys, while the filter is an existence pre-check for the rotating remainder. Both should sit close to the service so a rejected key never consumes a database connection.",
  },
  {
    type: "table",
    headers: ["Bits per key", "Approximate false-positive rate", "What it means"],
    rows: [
      ["4", "About 15%", "Cheap, but many absent keys still reach the database"],
      ["8", "About 2%", "A common starting point for a large key set"],
      ["12", "About 0.3%", "More memory, far fewer false positives"],
      ["16", "About 0.05%", "Useful when the database is the scarce resource"],
    ],
  },
  {
    type: "p",
    text: "The rates above are theoretical values with the optimal hash count, not product limits. They assume the filter is sized for the real key count and rebuilt when that count changes materially.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Absent-key share and the requests per second that reach the database after each control.",
      "Negative-cache hit rate, which depends on repetition and TTL.",
      "Bloom false-positive rate and the memory implied by bits per key.",
      "Database QPS, CPU, and tail latency as the absent stream grows.",
      "Overall cache hit rate, which can look healthy while the database is overloaded.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Penetration. Watch the database rise while the cache is not failing. Add Bloom only to see false positives remain, then apply Filtered to combine a larger filter with a negative cache. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it rejects", "What it costs"],
    rows: [
      ["Negative cache", "Repeated absent keys, exactly", "Memory per absent key and a TTL that must be invalidated on create"],
      ["Bloom filter", "Definitely absent keys, with no false negatives", "Memory and a false-positive rate that sends some absent keys onward"],
      ["Input validation", "Malformed IDs before any lookup", "A schema and an error contract at the edge"],
      ["Rate limiting", "Volume from one client", "A policy for legitimate bursts and shared clients"],
    ],
  },
  {
    type: "p",
    text: "This module uses illustrative values: a database capacity of 8,000 queries per second, a 5% miss rate on valid keys, and a one-million-key filter. They are not Redis or database limits. The lesson is where the absent stream is rejected and what each rejection costs.",
  },
  { type: "sim", simId: "cache-penetration" },
  { type: "experiment", experimentId: "predict-bloom-only" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "A large share of requests asked for IDs that do not exist. The cache could not help, because there was no value to cache. Every absent request that passed the filters became a database lookup, and the database moved from comfortable to saturated while the cache hit rate stayed unremarkable. The negative cache removed most of the repeated absent keys with an exact answer. The Bloom filter then rejected the definitely-absent majority of the remaining rotating keys at the cost of a small false-positive slice.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Database QPS rising with a flat cache hit rate and a high 404 or not-found rate.",
      "Query samples with random, sequential, or malformed IDs that never return rows.",
      "A small number of client IPs or API keys producing most of the absent traffic.",
      "Negative-cache evictions and memory, especially when the absent keys rotate.",
      "Bloom filter fill ratio, false-positive rate, and the age since the last rebuild.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare database QPS with the absent-key share, not with total traffic. Sample the keys. If they never repeat, a negative cache will not help much and a Bloom filter or input validation is the earlier control.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the database load is absent-key lookups, not a stampede or a slow query.",
      "Add input validation and rate limiting at the edge to cut the source.",
      "Add a negative cache for repeated absent keys with a short TTL.",
      "Add a Bloom filter sized for the real key count, with a target false-positive rate.",
      "Invalidate negative markers and update the filter when keys are created.",
      "Re-run the traffic and check database QPS, false positives, and negative-cache memory together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A negative cache is exact for repeated keys but costs memory and can hide a newly created key until its TTL expires.",
      "A Bloom filter rejects definitely-absent keys with little memory per key, but its false positives still reach the database.",
      "More bits per key lower false positives but raise memory; the filter must be resized as the key set grows.",
      "Input validation rejects malformed IDs but not well-formed IDs that simply do not exist.",
      "Rate limiting protects the database from volume but can punish legitimate clients behind a shared address.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-penetration",
    question:
      "The cache hit rate is normal but database QPS keeps rising. How do you tell whether this is cache penetration?",
    difficulty: 3,
    hints: [
      "Look at what the database queries return.",
      "A value cache cannot hold a row that does not exist.",
    ],
    answer:
      "I would compare database QPS with the not-found rate and sample the query keys. Penetration shows a high volume of lookups that return no row, often with random or malformed IDs, while the hit rate for valid keys is unchanged. I would check whether the same absent keys repeat; if they do, a negative cache can help. If they rotate, a Bloom filter or input validation is the earlier control. I would also rule out a stampede by checking whether the load aligns with a cache expiry and whether the queries are for one existing hot key.",
    followUps: [
      "How would a stampede look different?",
      "What if the absent keys are well-formed but outside the customer's account?",
      "Which control would you deploy first under incident pressure?",
    ],
    redFlags: [
      "Adds database capacity before checking what the queries return.",
      "Assumes a low hit rate is required for penetration.",
      "Ignores malformed input and rate limiting.",
    ],
    rubric: [
      "Uses not-found rate and query samples.",
      "Distinguishes penetration from a stampede.",
      "Checks key repetition.",
      "Names an early control.",
    ],
  },
  {
    id: "bloom-sizing",
    question:
      "How do you size a Bloom filter for a key set that grows over time?",
    difficulty: 3,
    hints: [
      "Start from the target false-positive rate.",
      "A filter sized for today's keys will degrade as the set grows.",
    ],
    answer:
      "I would start with the expected key count and a target false-positive rate, then choose bits per key and the hash count from the standard formula. I would leave headroom for growth and monitor the fill ratio and observed false positives. If the set grows beyond the plan, I would rebuild into a larger filter or shard by key range. I would also define how new keys are added so the filter does not become stale, and keep a path that verifies a filter miss against the database when correctness requires it.",
    followUps: [
      "What happens if you rebuild while traffic is live?",
      "How do you measure the real false-positive rate?",
      "Would you use one filter or one per shard?",
    ],
    redFlags: [
      "Sizes for the current count with no growth headroom.",
      "Treats a Bloom filter as an exact set.",
      "Never rebuilds or measures false positives.",
    ],
    rubric: [
      "Starts from key count and target rate.",
      "Plans for growth and rebuild.",
      "Measures the real rate.",
      "Keeps a correctness fallback.",
    ],
  },
  {
    id: "negative-ttl",
    question:
      "A negative cache entry is written for an ID that is created one second later. What happens, and how do you prevent it?",
    difficulty: 3,
    hints: [
      "The marker is an assertion about absence.",
      "A create path is a write that must invalidate it.",
    ],
    answer:
      "The marker says the key is absent, so reads keep returning not found until the TTL expires. That is a correctness bug, not just a latency issue. I would invalidate the marker on create, or write the new value through the same path that owns the negative cache. If the create path cannot reach every cache, I would keep the negative TTL short and make the read path verify a miss against the database before returning not found. I would also measure negative-cache age and the rate of creates that race with a negative lookup.",
    followUps: [
      "How short would you make the TTL?",
      "What if the create happens in another service?",
      "Would you cache the absence of a key that is expected to be created soon?",
    ],
    redFlags: [
      "Uses a long TTL for negative entries without invalidation.",
      "Assumes the create path updates every cache.",
      "Treats a stale negative as a cache hit.",
    ],
    rubric: [
      "Recognizes the correctness failure.",
      "Invalidates on create or verifies the miss.",
      "Bounds the TTL.",
      "Measures the race.",
    ],
  },
  {
    id: "choose-negative-or-bloom",
    question:
      "A scraper sends a mix of repeated and rotating absent IDs. When do you choose a negative cache versus a Bloom filter?",
    difficulty: 3,
    hints: [
      "The traffic shape decides the control.",
      "One is exact, the other is probabilistic.",
    ],
    answer:
      "I would use the negative cache for the keys that repeat inside a short window, because it stores an exact not-found answer and is cheap per hit. I would use the Bloom filter for the rotating or one-off keys that the negative cache would only fill and evict, because the filter covers the whole valid key set in bounded memory. In this design I check the negative cache first, then the filter for the remaining keys; the reverse order is also valid, but then the negative cache mostly sees the filter’s false-positive slice. The negative TTL must stay tied to the repetition window and must be invalidated on create. The filter must be sized for the real key count and updated when keys are created.",
    followUps: [
      "Which control would you deploy first under incident pressure?",
      "What if the absent keys never repeat?",
      "How would you measure which control is earning its memory?",
    ],
    redFlags: [
      "Uses a negative cache for keys that never repeat.",
      "Uses a Bloom filter as an exact answer.",
      "Ignores create-path invalidation.",
    ],
    rubric: [
      "Matches the control to repetition and rotation.",
      "Combines them when appropriate.",
      "Bounds TTL and filter capacity.",
      "Measures the benefit.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The service distinguishes a valid miss from an absent or malformed key.",
      "A negative cache exists for repeated absent keys, with a short TTL and create-path invalidation.",
      "A Bloom filter is sized for the real key count with growth headroom and a measured false-positive rate.",
      "Input validation and rate limiting protect the lookup path.",
      "Dashboards show absent-key share, database QPS, and filter false positives together.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Sample the keys and confirm the database load is absent-key lookups.",
      "Cut the source with validation or rate limiting before adding capacity.",
      "Deploy the negative cache for repeated keys and the filter for rotating keys.",
      "Watch false positives and negative-cache memory as the controls turn on.",
      "Check that valid-key traffic and latency did not regress.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify database QPS and false-positive rate at peak traffic.",
      "Reconcile the filter capacity with the current key count.",
      "Remove temporary rate limits and document the remaining exposure.",
      "Add a test that sends random IDs through the full read path.",
    ],
  },
];

const references = [
  {
    title: "Bloom filter",
    url: "https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Bloom filter semantics, sizing, and false-positive behavior.",
  },
  {
    title: "Space/time trade-offs in hash coding with allowable errors",
    url: "https://dl.acm.org/doi/10.1145/362686.362692",
    publisher: "Communications of the ACM",
    kind: "standard" as const,
    note: "The original Bloom filter paper, 1970.",
  },
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside and miss-path guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cache-penetration": {
      model: cachePenetrationModel,
      presets,
      instructions:
        "Start healthy, then apply Penetration. Compare Bloom only with Filtered. Watch absent requests at the database and the Bloom false-positive rate, not only the hit rate.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Database capacity is 8,000 qps, valid keys miss 5% of the time, and the filter covers one million keys. Bloom false-positive rates use the standard formula with the optimal hash count.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-negative-caching",
    "caching-eviction-policies",
    "caching-cache-stampede",
    "caching-hot-key-sharding",
  ],
};
