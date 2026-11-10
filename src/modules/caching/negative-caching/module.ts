import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DB_CAPACITY = 8_000;
const VALID_MISS_RATE = 0.05;
const REDIS_CAPACITY = 60_000;
const BLOOM_KEY_SPACE = 1_000_000;
const ABSENT_KEYS_PER_SECOND = 2_000;
const NEGATIVE_ENTRY_BYTES = 250;
const NEW_KEY_REJECT_AT_MAX_TTL = 10;
const MAX_NEGATIVE_TTL_SECONDS = 300;

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
    help: "Total reads per second, including normal traffic and the scraper.",
    format: "rps" as const,
  },
  {
    id: "absentSharePct",
    label: "Absent-key share",
    min: 20,
    max: 95,
    step: 5,
    value: 70,
    unit: "%",
    group: "Traffic",
    help: "Share of requests for IDs that do not exist. A scraper can hold this high for a long time.",
    format: "percent" as const,
  },
  {
    id: "negativeTtlSeconds",
    label: "Negative cache TTL",
    min: 5,
    max: 300,
    step: 5,
    value: 10,
    unit: "s",
    group: "Negative cache",
    help: "How long a not-found marker lives. Longer absorbs more repeats, costs more memory, and keeps a newly created key hidden longer.",
    format: "number" as const,
  },
  {
    id: "bloomBitsPerKey",
    label: "Bloom filter size",
    min: 0,
    max: 16,
    step: 1,
    value: 10,
    unit: " bits/key",
    group: "Bloom filter",
    help: "Bits per key in the existence filter. Zero disables it. The filter is updated when valid keys are created.",
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
  negativeTtl: number;
  bits: number;
  validRps: number;
  absentRps: number;
  negativeHit: number;
  bloomFpr: number;
  passRate: number;
  absentToDb: number;
  dbQps: number;
  dbUtil: number;
  dbCpu: number;
  dbP99: number;
  hitRate: number;
  newKeyReject: number;
  negativeMemoryMb: number;
  filterMemoryMb: number;
  totalMemoryMb: number;
  redisRps: number;
}

function compute(p: Params, noise = 1): Values {
  const requestRps = Math.max(1, num(p, "requestRps", 10_000) * noise);
  const absentShare = clamp(num(p, "absentSharePct", 70) / 100, 0.2, 0.95);
  const negativeTtl = Math.max(5, num(p, "negativeTtlSeconds", 10));
  const bits = Math.max(0, num(p, "bloomBitsPerKey", 10));
  const validRps = requestRps * (1 - absentShare);
  const absentRps = requestRps * absentShare;
  const negativeHit = Math.min(0.75, (negativeTtl / 10) * 0.75);
  const bloomFpr = bloomFalsePositiveRate(bits);
  const passRate = bits > 0 ? bloomFpr : 1;
  const absentToDb = absentRps * (1 - negativeHit) * passRate;
  const dbQps = absentToDb + validRps * VALID_MISS_RATE;
  const dbUtil = dbQps / DB_CAPACITY;
  const dbCpu = Math.min(100, dbUtil * 100);
  const dbP99 = dbUtil <= 1 ? 2 + 12 * dbUtil ** 4 : 25 + 260 * Math.log2(dbUtil);
  const hitRate = (validRps * (1 - VALID_MISS_RATE) + absentRps * negativeHit) / requestRps;
  const newKeyReject = Math.min(100, (negativeTtl / MAX_NEGATIVE_TTL_SECONDS) * NEW_KEY_REJECT_AT_MAX_TTL);
  const negativeMemoryMb = (negativeTtl * ABSENT_KEYS_PER_SECOND * NEGATIVE_ENTRY_BYTES) / 1_000_000;
  const filterMemoryMb = (BLOOM_KEY_SPACE * bits) / 8 / 1_000_000;
  const totalMemoryMb = negativeMemoryMb + filterMemoryMb;
  const redisRps = requestRps;

  return {
    requestRps,
    absentShare,
    negativeTtl,
    bits,
    validRps,
    absentRps,
    negativeHit,
    bloomFpr,
    passRate,
    absentToDb,
    dbQps,
    dbUtil,
    dbCpu,
    dbP99,
    hitRate,
    newKeyReject,
    negativeMemoryMb,
    filterMemoryMb,
    totalMemoryMb,
    redisRps,
  };
}

type HealthState = "ok" | "warn" | "crit";

function healthForUtil(util: number): HealthState {
  if (util >= 1) return "crit";
  if (util >= 0.75) return "warn";
  return "ok";
}

function rejectHealth(pct: number): HealthState {
  if (pct >= 2) return "crit";
  if (pct >= 0.5) return "warn";
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
  const negativeHealth = rejectHealth(values.newKeyReject);
  const serviceHealth: HealthState =
    values.newKeyReject >= 2 || values.dbUtil >= 1
      ? "crit"
      : values.newKeyReject >= 0.5 || values.dbUtil >= 0.75
        ? "warn"
        : "ok";

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
        meta: { view: "flow" },
      },
      {
        id: "negative",
        label: "Negative cache",
        kind: "cache",
        health: negativeHealth,
        utilization: clamp(values.negativeTtl / 300),
        throughput: values.absentRps * values.negativeHit,
        sublabel: `${values.negativeTtl.toFixed(0)}s TTL, ${(values.negativeHit * 100).toFixed(0)}% absent hits`,
        detail: `Stores an exact not-found marker. A hit returns not found before the Bloom filter or database is consulted. A marker written before a key was created can hide that key until the TTL expires. Illustrative memory: ${values.negativeMemoryMb.toFixed(0)} MB for ${formatCount(values.negativeTtl * ABSENT_KEYS_PER_SECOND)} markers.`,
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
        detail: `Checks the absent keys that missed the negative cache. The filter is updated when a key is created, so it does not reject new valid keys. Its false positives only let absent keys through. Illustrative memory: ${values.filterMemoryMb.toFixed(1)} MB for ${formatCount(BLOOM_KEY_SPACE)} keys.`,
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
        detail: `Illustrative teaching capacity: ${formatCount(DB_CAPACITY)} qps. The absent stream that passes both filters has no value to reuse.`,
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
      metric("new-key-reject", "Reads rejected by stale markers", values.newKeyReject, "%", 0.5, 2, "percent"),
      metric("bloom-fpr", values.bits > 0 ? "Bloom false positives" : "Bloom false positives (disabled)", values.bits > 0 ? values.bloomFpr * 100 : 0, "%", values.bits > 0 ? 3 : undefined, values.bits > 0 ? 8 : undefined, "percent"),
      metric("negative-hit", "Negative cache hits", values.negativeHit * 100, "%", undefined, undefined, "percent"),
      metric("total-memory", "Marker and filter memory", values.totalMemoryMb, " MB", 64, 128, "number"),
      metric("hit-rate", "Overall cache hit rate", values.hitRate * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${(values.absentShare * 100).toFixed(0)}% absent IDs, ${(values.negativeHit * 100).toFixed(0)}% negative hits, ${formatCount(values.dbQps)} db qps, ${values.totalMemoryMb.toFixed(0)} MB markers and filter, ${values.newKeyReject.toFixed(1)}% of reads rejected by stale markers.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const entries: [string, number][] = [
    ["db-qps", values.dbQps],
    ["db-cpu", values.dbCpu],
    ["db-p99", values.dbP99],
    ["new-key-reject", values.newKeyReject],
    ["bloom-fpr", values.bloomFpr * 100],
    ["negative-hit", values.negativeHit * 100],
    ["total-memory", values.totalMemoryMb],
    ["hit-rate", values.hitRate * 100],
  ];
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 11)) / 2.7);
  for (const [id, value] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * Math.max(0.1, value * 0.01)),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "db-qps",
    metricId: "db-qps",
    warn: 6_000,
    crit: 8_000,
    title: "Absent-key traffic overwhelmed the database",
    cause:
      "The negative cache is too small or too short-lived, the filter is disabled or undersized, or enough keys rotate that neither control sees a repeat.",
    fix:
      "Cut the source at the edge, then size the negative cache and the filter for the observed key churn. A filter that is large enough for the valid set will still pass a small false-positive slice.",
    checkFirst: [
      "Compare database QPS with the absent share and the negative-cache hit rate.",
      "Check whether absent keys repeat or rotate; the answer decides which control helps.",
      "Check the Bloom filter's fill ratio and false-positive rate.",
    ],
  },
  {
    id: "new-key-reject",
    metricId: "new-key-reject",
    warn: 0.5,
    crit: 2,
    title: "Stale negative entries are rejecting newly created keys",
    cause:
      "A not-found marker was written before the key existed and outlived the create. The marker is exact, so every read of the new key returns not found until the TTL expires or the entry is invalidated. A Bloom false positive is not this failure; false positives only let absent keys through.",
    fix:
      "Invalidate the marker on create, shorten the negative TTL, or verify a negative hit against the database before returning not found. The create path must be able to reach every negative cache.",
    checkFirst: [
      "Check the creation time of the rejected key against the negative marker's age.",
      "Check whether the create path invalidates the key or only updates the database.",
      "Check whether the rejected keys are new or were created after a bulk import.",
    ],
  },
  {
    id: "bloom-fpr",
    metricId: "bloom-fpr",
    warn: 3,
    crit: 8,
    title: "The Bloom filter is undersized for the key set",
    cause:
      "Too few bits per key raises false positives. An absent key that the filter reports as possibly present reaches the next layer, adding database load. The filter still does not reject any key that exists.",
    fix:
      "Add bits per key, rebuild for the current key count with growth headroom, or shard the filter. Measure memory as part of the same change.",
    checkFirst: [
      "Check the filter capacity against the live key count.",
      "Check the hash count and the fill ratio.",
      "Check whether the false positives are spread evenly or concentrated.",
    ],
  },
  {
    id: "total-memory",
    metricId: "total-memory",
    warn: 64,
    crit: 128,
    title: "Negative markers and filter bits are consuming the memory budget",
    cause:
      "Negative cache memory grows with the TTL times the distinct absent keys per second. The filter grows with the key set and bits per key. Both are bounded only if someone sets the bound.",
    fix:
      "Shorten the negative TTL, cap the number of markers, or reduce bits per key and accept more false positives. Treat the filter as a bounded data structure with an explicit memory budget.",
    checkFirst: [
      "Check the distinct absent keys per second and the marker size.",
      "Check the filter capacity and bits per key.",
      "Check whether one scraper is creating most of the distinct keys.",
    ],
  },
  {
    id: "db-p99",
    metricId: "db-p99",
    warn: 100,
    crit: 400,
    title: "Database tail latency rose under the absent stream",
    cause:
      "A high rate of cheap-looking point lookups still consumes connections and CPU. The queue grows even when each query is fast.",
    fix:
      "Reject absent keys earlier and protect the connection pool. Adding an index does not help a key that does not exist.",
    checkFirst: [
      "Compare p99 with the absent requests that reach the database.",
      "Check connection pool wait and retry volume.",
      "Check whether the database is doing point lookups or scans.",
    ],
  },
];

export const negativeCachingModel: SimModel = {
  id: "caching-negative-caching",
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

    if (values.newKeyReject >= 2 && frame.flags.rejectEvent !== 1) {
      pushEvent(next, {
        id: "negative-cache-stale-create",
        at: frame.t,
        severity: "crit",
        title: "A stale not-found marker is hiding a new key",
        detail: `The ${values.negativeTtl.toFixed(0)}s negative TTL rejects about ${values.newKeyReject.toFixed(1)}% of all reads, concentrated on newly created keys.`,
        nodeId: "negative",
        metricId: "new-key-reject",
      });
      next.flags.rejectEvent = 1;
    }
    if (values.newKeyReject < 0.5) next.flags.rejectEvent = 0;

    if (values.dbUtil >= 1 && frame.flags.dbEvent !== 1) {
      pushEvent(next, {
        id: "negative-cache-db-saturation",
        at: frame.t,
        severity: "crit",
        title: "The absent stream passed both filters",
        detail: `${formatCount(values.absentToDb)} absent requests/s reach the database with a ${(values.negativeHit * 100).toFixed(0)}% negative hit rate and a ${(values.bloomFpr * 100).toFixed(1)}% Bloom false-positive rate.`,
        nodeId: "db",
        metricId: "db-qps",
      });
      next.flags.dbEvent = 1;
    }
    if (values.dbUtil < 0.9) next.flags.dbEvent = 0;

    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The negative cache covers ${(values.negativeHit * 100).toFixed(0)}% of absent traffic at a ${values.negativeTtl.toFixed(0)}s TTL. Longer than about 10s adds memory without raising coverage in this model.`,
      values.bits > 0
        ? `At ${values.bits} bits/key the Bloom false-positive rate is about ${(values.bloomFpr * 100).toFixed(1)}%. False positives add database load; they do not reject a key that exists.`
        : "The Bloom filter is disabled. Every absent key that misses the negative cache reaches the database.",
      `A ${values.negativeTtl.toFixed(0)}s negative TTL rejects about ${values.newKeyReject.toFixed(1)}% of all reads, concentrated on newly created keys, if the create path does not invalidate the marker.`,
      `Markers and filter use ${values.totalMemoryMb.toFixed(0)} MB: ${values.negativeMemoryMb.toFixed(0)} MB of negative markers and ${values.filterMemoryMb.toFixed(1)} MB of Bloom bits.`,
      `The database receives ${formatCount(values.dbQps)} qps, ${(values.dbUtil * 100).toFixed(0)}% of its illustrative capacity.`,
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
    description: "A short negative TTL, a 10-bit filter, and modest absent traffic.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with long TTL",
    description: "More traffic and a 30s negative TTL. New keys begin to see stale negatives.",
    tone: "warn",
    params: defaults({
      requestRps: 25_000,
      absentSharePct: 80,
      negativeTtlSeconds: 30,
      bloomBitsPerKey: 8,
    }),
  },
  {
    id: "failure",
    label: "Long TTL, no filter",
    description: "A 300s negative TTL blocks newly created keys and the absent stream saturates the database.",
    tone: "crit",
    params: defaults({
      requestRps: 40_000,
      absentSharePct: 90,
      negativeTtlSeconds: 300,
      bloomBitsPerKey: 0,
    }),
  },
  {
    id: "recovery",
    label: "Short TTL and filter",
    description: "A 10s TTL and a 12-bit filter stop the absent stream and free new keys quickly.",
    tone: "ok",
    params: defaults({
      requestRps: 40_000,
      absentSharePct: 90,
      negativeTtlSeconds: 10,
      bloomBitsPerKey: 12,
    }),
  },
  {
    id: "short-ttl",
    label: "Short TTL only",
    description: "A 5s TTL protects new keys but gives up most of the negative-cache benefit.",
    tone: "info",
    params: defaults({
      requestRps: 40_000,
      absentSharePct: 90,
      negativeTtlSeconds: 5,
      bloomBitsPerKey: 12,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-long-negative-ttl",
  title: "Predict what a longer negative TTL buys",
  simId: "negative-caching",
  question:
    "Negative-cache coverage is already about 75% at a 10s TTL. You raise the TTL to 300s. What changes most?",
  prediction: {
    options: [
      {
        id: "memory-reject",
        label: "Memory and new-key rejection rise; database load barely moves.",
      },
      { id: "db-falls", label: "Database load falls by 30× because the cache covers 30× more time." },
      { id: "coverage-doubles", label: "Negative-cache coverage doubles." },
      { id: "nothing", label: "Nothing changes because the filter already catches absent keys." },
    ],
    correctOptionId: "memory-reject",
    explanation:
      "The absent keys in this model are requested only a few times within about 10 seconds. A 10s TTL already captures that repetition, so coverage is capped near 75% and does not grow with a longer TTL. Memory grows linearly with the TTL times the distinct absent keys, and a marker that lives 300s hides a newly created key for much longer.",
  },
  setup: defaults({
    requestRps: 40_000,
    absentSharePct: 90,
    negativeTtlSeconds: 300,
    bloomBitsPerKey: 8,
  }),
  runFor: 20,
  observe: [
    "Database QPS stays near 400 because the negative cache already covers the repeats and the 8-bit filter covers the rest; the extra TTL adds no new hits.",
    "Negative-cache coverage stays near 75%, the same as a 10s TTL in this model.",
    "Reads rejected by stale markers rise to about 10%, concentrated on newly created keys.",
    "Marker and filter memory rises to about 151 MB, dominated by negative markers.",
    "The overall hit rate is unchanged because the extra TTL adds no new hits.",
  ],
  explain:
    "The TTL is only useful for the interval in which an absent key is likely to repeat. Once that interval is covered, a longer TTL adds memory and extends the stale-negative window without removing more database work. The filter handles the rotating keys that never repeat. The two controls cover different traffic shapes, which is why the right TTL is a function of repetition and creation, not a large round number.",
  fix: defaults({
    requestRps: 40_000,
    absentSharePct: 90,
    negativeTtlSeconds: 10,
    bloomBitsPerKey: 10,
  }),
  debrief:
    "Shortening the TTL cut marker memory and new-key rejection while the filter kept the database quiet. The negative cache now covers the repeats and the filter covers the rotating keys. The remaining risk is a create that races with a negative marker; the create path must invalidate the marker, or the read path must verify a negative hit before returning not found.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A negative cache stores the answer that a key does not exist. It turns a repeated absent lookup into a cache hit, so a scraper asking for the same bad IDs does not reach the database every time. The marker is exact for that key while it lives, but it is still a cache entry: it consumes memory, it has a time to live (TTL), and it can be wrong after the key is created. A short TTL and an invalidation on create are part of the correctness design, not tuning details.",
  },
  {
    type: "p",
    text: "A Bloom filter is a probabilistic set for the keys that do exist. It uses a bit array and several hash functions. Adding a key sets its bits; a lookup returns definitely absent if any required bit is zero, otherwise possibly present. For the set it was built from, it has no false negatives, so it cannot reject a key that exists. It does have false positives: an absent key can look possibly present and pass to the next layer. The false-positive rate depends on bits per key and the hash count; with the optimal count it is about (1 - e^(-kn/m))^k for n keys in m bits. A filter that was built before a key was created is a different problem: it is stale, and a miss on that new key is a false negative caused by the stale source set, not by the Bloom math.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, service, value cache, negative cache, Bloom filter, database. A value-cache hit returns immediately; a negative-cache hit returns not found; otherwise the Bloom filter rejects definitely-absent keys; a possibly-present result reads the database. The negative cache stores exact absence for repeated keys, while the filter is an existence pre-check for the rotating remainder. On a database miss, the service writes a negative marker. On a create, it should invalidate that marker and add the key to the filter. If the create path cannot reach every cache, the TTL is the only bound, and a newly created key can be hidden until it expires.",
  },
  {
    type: "compare",
    leftTitle: "Negative cache",
    rightTitle: "Bloom filter",
    rows: [
      {
        label: "Answer",
        left: "Exact for the keys it holds",
        right: "Definitely absent or possibly present",
      },
      {
        label: "Traffic shape",
        left: "Repeated absent keys",
        right: "Rotating or never-repeated absent keys",
      },
      {
        label: "Memory",
        left: "Per marker, times the TTL and distinct keys",
        right: "Bits per key, sized to the valid key set",
      },
      {
        label: "Failure",
        left: "A stale marker can hide a newly created key",
        right: "False positives add database load; no false negatives for the built set",
      },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Negative-cache hit rate and the fraction of absent keys that repeat.",
      "Bloom false-positive rate, filter memory, and the bits-per-key setting.",
      "Reads rejected by stale markers, which exposes a negative entry that outlived a create.",
      "Database QPS and tail latency from the absent traffic that passes both filters.",
      "Total marker and filter memory, split between exact markers and Bloom bits.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Peak with long TTL: the database is still fine, but new keys start to be rejected. Apply Long TTL, no filter to see both failures at once. Then run the guided experiment and compare the recovery preset.",
  },
  {
    type: "table",
    headers: ["Setting", "What it improves", "What it risks"],
    rows: [
      ["Short negative TTL", "New keys become visible sooner", "Fewer repeats are absorbed"],
      ["Long negative TTL", "More repeats are absorbed", "More memory and a longer window that can hide a new key"],
      ["More Bloom bits", "Fewer false positives", "More memory per key"],
      ["Fewer Bloom bits", "Less memory", "More absent keys reach the database"],
      ["Create-path invalidation", "Removes the stale-negative race", "Every create path must participate"],
    ],
  },
  {
    type: "p",
    text: "A Bloom false positive never blocks a key that exists. It makes an absent key look possibly present, so the request falls through to the database. The failure that blocks a valid key is a stale negative entry written before the key was created, or a filter that was built before the key existed. Keeping those two failures separate is the point of this module.",
  },
  {
    type: "p",
    text: "The model uses illustrative values: 2,000 distinct absent keys per second, 250 bytes per marker, and a one-million-key filter that is updated when valid keys are created. They are not Redis limits. The negative TTL is capped at 300s to show the memory and correctness cost of a long marker; the new-key rejection curve is an illustrative teaching curve.",
  },
  { type: "sim", simId: "negative-caching" },
  { type: "experiment", experimentId: "predict-long-negative-ttl" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The negative cache absorbed repeated absent keys with an exact answer, and the Bloom filter rejected the definitely-absent majority of the remaining rotating keys. When the negative TTL was short, new keys became visible quickly but more absent traffic reached the database. When the TTL was long and the filter was on, the database stayed quiet while memory grew and newly created keys were hidden behind stale not-found markers. The filter's false positives added a small database stream; the stale markers caused a correctness failure that no amount of database capacity could fix.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A high not-found rate with a stable value-cache hit rate.",
      "Negative-cache marker count, memory, and age, plus the create rate for the same key space.",
      "New-key reads returning not found after the write succeeded.",
      "Bloom filter fill ratio, false-positive rate, and how stale its view of the key set is.",
      "Database QPS from the absent stream that passes both filters.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "If a newly created key is missing, compare its creation time with the age of the negative marker. If the database is overloaded, compare the absent share with the negative hit rate and the Bloom false-positive rate. The two symptoms have different fixes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Separate the database overload from the new-key rejection before changing any setting.",
      "For overload, cut the source and size the filter for the real key count.",
      "For new-key rejection, invalidate the marker on create or shorten the negative TTL.",
      "Keep the negative TTL tied to the repetition window, not to a round number.",
      "Bound filter and marker memory explicitly, and alert on the bound.",
      "Re-run the traffic and check database QPS, false positives, and new-key rejection together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A negative cache is exact and cheap per hit, but it costs memory and can hide a new key until its TTL.",
      "A Bloom filter covers rotating keys with little memory per key, but false positives still reach the database.",
      "More filter bits lower false positives and raise memory; the filter must be resized as the key set grows.",
      "A longer negative TTL absorbs more repeats but extends the stale-negative window and memory.",
      "Create-path invalidation removes the race but requires every writer to participate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "size-negative-cache",
    question:
      "A scraper sends 10,000 random IDs per second. How do you size a negative cache and decide its TTL?",
    difficulty: 3,
    hints: [
      "Start with repetition, not with the request rate.",
      "The TTL is a correctness bound as well as a cache setting.",
    ],
    answer:
      "I would measure how often the same absent key repeats and how many distinct absent keys arrive per second. If keys repeat within a short window, a negative cache sized for the distinct count times the TTL can absorb them. I would set the TTL to the repetition window and keep it short, because a marker can outlive a create and hide a valid key. I would also add create-path invalidation or verify a negative hit against the database. For rotating keys that never repeat, the negative cache will not help much and a Bloom filter or input validation is the earlier control.",
    followUps: [
      "What if the scraper rotates keys faster than the TTL?",
      "How do you bound marker memory?",
      "What does a create path need to do?",
    ],
    redFlags: [
      "Sizes the cache from request rate alone.",
      "Uses a long TTL without create invalidation.",
      "Assumes a negative cache helps random keys.",
    ],
    rubric: [
      "Starts from repetition and distinct keys.",
      "Ties the TTL to correctness.",
      "Bounds memory.",
      "Names a fallback for rotating keys.",
    ],
  },
  {
    id: "bloom-math",
    question:
      "What does a Bloom filter guarantee, and what does a false positive actually cause?",
    difficulty: 3,
    hints: [
      "One direction is exact.",
      "A false positive is an absent key that looks present.",
    ],
    answer:
      "For the set it was built from, a Bloom filter has no false negatives: if it says definitely absent, the key is absent. A lookup that says possibly present may be wrong. That false positive is an absent key that passes to the next layer, which adds database load and may fill a negative cache. It does not reject a key that exists. If the filter is built from a stale set, a newly created key can be reported absent; that is a stale-filter false negative, not the Bloom false-positive rate.",
    followUps: [
      "How do you measure the real false-positive rate?",
      "What happens when the key set grows past the filter capacity?",
      "Why can a false positive never hide an existing key?",
    ],
    redFlags: [
      "Says false positives block valid keys.",
      "Treats the filter as an exact set.",
      "Ignores stale filter contents.",
    ],
    rubric: [
      "States no false negatives for the built set.",
      "Explains false positives as extra database load.",
      "Separates stale-filter misses.",
      "Knows how to measure and resize.",
    ],
  },
  {
    id: "fix-new-key",
    question:
      "A key is created successfully, but reads return not found for two minutes. What is your diagnosis and fix?",
    difficulty: 3,
    hints: [
      "The write succeeded; the read path is returning a cached answer.",
      "A negative marker is an assertion with a lifetime.",
    ],
    answer:
      "I would check whether a negative marker for that key was written before the create and is still inside its TTL. The fix is to invalidate the marker on create, or to verify a negative hit against the database before returning not found. If the create happens in another service, the invalidation must cross that boundary. I would also measure the age of negative markers and the create rate to find the race window, then shorten the TTL as a backstop rather than as the primary fix.",
    followUps: [
      "How would you test the race?",
      "What if the create path cannot publish an invalidation?",
      "How short would you make the TTL?",
    ],
    redFlags: [
      "Blaming the database write.",
      "Shortening the TTL without fixing the create path.",
      "Assuming the read path is uncached.",
    ],
    rubric: [
      "Identifies the stale negative marker.",
      "Names create invalidation or verification.",
      "Measures the race.",
      "Uses TTL as a backstop.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The negative cache TTL is tied to the key repetition window and documented as a correctness bound.",
      "Every create path invalidates the negative marker or the read path verifies a negative hit.",
      "The Bloom filter is sized for the real key count with growth headroom.",
      "Filter and marker memory have explicit bounds and alerts.",
      "Dashboards show absent share, negative hits, false positives, and new-key rejection together.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate database overload from new-key rejection.",
      "For overload, cut the source and check the filter's false-positive rate.",
      "For rejection, find the marker age and the create path that missed it.",
      "Shorten the TTL only as a backstop while the invalidation is repaired.",
      "Watch memory as the filter or TTL changes.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify database QPS and false-positive rate at peak traffic.",
      "Reconcile filter capacity and negative TTL with the current key set.",
      "Remove temporary marker suppressions and confirm invalidation works.",
      "Add a test that creates a key immediately after a negative lookup.",
    ],
  },
];

const references = [
  {
    title: "Bloom filter",
    url: "https://redis.io/docs/latest/develop/data-types/probabilistic/bloom-filter/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Bloom filter mechanics, sizing, and false-positive behavior.",
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
    "negative-caching": {
      model: negativeCachingModel,
      presets,
      instructions:
        "Start healthy, then apply Peak with long TTL and Long TTL, no filter. Watch new-key rejection and memory, not only database QPS.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Absent keys arrive at 2,000 distinct keys/s, each marker is 250 bytes, the filter covers one million keys, and it is updated when valid keys are created. Break condition: a stale negative entry rejects a newly created key. Bloom false positives add database load; they do not reject present keys.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-cache-penetration",
    "caching-eviction-policies",
    "caching-local-cache",
    "caching-hot-key-sharding",
  ],
};
