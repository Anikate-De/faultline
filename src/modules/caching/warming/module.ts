import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOT_KEYS = 100_000;
const DB_CAPACITY = 12_000;
const WARM_HIT_RATE = 0.98;

const params = [
  {
    id: "trafficRps",
    label: "Read traffic",
    min: 5_000,
    max: 100_000,
    step: 5_000,
    value: 30_000,
    unit: " rps",
    group: "Traffic",
    help: "Reads arriving while the cache is cold. The origin absorbs every miss until the hot set is refilled.",
    format: "rps" as const,
  },
  {
    id: "warmRate",
    label: "Warmup rate",
    min: 0,
    max: 20_000,
    step: 500,
    value: 4_000,
    unit: " keys/s",
    group: "Warmup",
    help: "How fast the warmup job preloads the cold hot set. Zero means the cache is left to fill from live traffic, which this model does not credit.",
    format: "rps" as const,
  },
  {
    id: "coalescing",
    label: "Request coalescing",
    min: 0,
    max: 100,
    step: 10,
    value: 80,
    unit: "%",
    group: "Protection",
    help: "Share of concurrent live misses that share one origin fetch. It reduces duplicate work but does not fill the cache by itself.",
    format: "percent" as const,
  },
  {
    id: "coldShare",
    label: "Cold cache share",
    min: 0,
    max: 100,
    step: 10,
    value: 0,
    unit: "%",
    group: "Cache state",
    help: "Share of the hot set missing at the start. 100% models a restart with an empty cache; 0% is a warm cache.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pct(p: Params, id: string, fallback: number): number {
  return clamp(num(p, id, fallback) / 100);
}

interface Computed {
  traffic: number;
  warmRate: number;
  coalescing: number;
  coldShare: number;
  progress: number;
  warmed: number;
  coldKeys: number;
  hitRate: number;
  missRate: number;
  liveDbQps: number;
  warmDbQps: number;
  dbQps: number;
  util: number;
}

function compute(p: Params, progress: number): Computed {
  const traffic = Math.max(0, num(p, "trafficRps", 30_000));
  const warmRate = Math.max(0, num(p, "warmRate", 4_000));
  const coalescing = pct(p, "coalescing", 80);
  const coldShare = pct(p, "coldShare", 0);
  const coldTarget = coldShare * HOT_KEYS;
  const safeProgress = clamp(progress);
  const warmed = HOT_KEYS - coldTarget + coldTarget * safeProgress;
  const coldKeys = HOT_KEYS - warmed;
  const hitRate = WARM_HIT_RATE * (warmed / HOT_KEYS);
  const missRate = 1 - hitRate;
  const duplicateFactor = 1 - 0.8 * coalescing;
  const liveDbQps = traffic * missRate * duplicateFactor;
  const warmDbQps = coldKeys > 0 && warmRate > 0 ? warmRate : 0;
  const dbQps = liveDbQps + warmDbQps;
  return {
    traffic,
    warmRate,
    coalescing,
    coldShare,
    progress: safeProgress,
    warmed,
    coldKeys,
    hitRate,
    missRate,
    liveDbQps,
    warmDbQps,
    dbQps,
    util: dbQps / DB_CAPACITY,
  };
}

function healthFor(qps: number): "ok" | "warn" | "crit" {
  if (qps >= 12_000) return "crit";
  if (qps >= 8_000) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number, progress: number): SimFrame {
  const c = compute(p, progress);
  const dbHealth = healthFor(c.dbQps);
  const cacheHealth = c.coldKeys >= 60_000 ? "warn" : "ok";
  const appHealth = c.dbQps >= 12_000 ? "crit" : c.coldKeys >= 20_000 ? "warn" : "ok";
  const warmHealth = c.coldKeys > 0 ? (c.progress > 0 ? "warn" : "crit") : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Readers",
        kind: "client",
        health: "ok",
        utilization: clamp(c.traffic / 100_000),
        throughput: c.traffic,
        sublabel: `${formatCount(c.traffic)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Service",
        kind: "service",
        health: appHealth,
        utilization: clamp(c.traffic / 100_000),
        throughput: c.traffic,
        sublabel: `${(c.hitRate * 100).toFixed(0)}% hit`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Cache fleet",
        kind: "cache",
        health: cacheHealth,
        throughput: c.traffic,
        sublabel: `${formatCount(c.coldKeys)} keys still cold`,
        detail:
          "A cold key is a miss until the warmup job or a live read stores it. Coalescing collapses duplicate misses; it does not create a cached value.",
        meta: { view: "flow" },
      },
      {
        id: "warmup",
        label: "Warmup job",
        kind: "worker",
        health: warmHealth,
        throughput: c.warmDbQps,
        sublabel: c.coldKeys > 0 ? `${formatCount(c.warmRate)} keys/s` : "complete",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Origin database",
        kind: "db",
        health: dbHealth,
        utilization: clamp(c.util),
        throughput: c.dbQps,
        sublabel: `${formatCount(c.dbQps)} qps`,
        detail: `Illustrative teaching capacity is ${formatCount(DB_CAPACITY)} qps. Live misses contribute ${formatCount(c.liveDbQps)} qps; the warmup contributes ${formatCount(c.warmDbQps)} qps.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", clamp(c.traffic / 100_000)),
      edge("app-cache", "app", "cache", clamp(c.hitRate), cacheHealth),
      edge("app-db", "app", "db", clamp(c.liveDbQps / Math.max(1, c.traffic)), dbHealth),
      edge(
        "warm-cache",
        "warmup",
        "cache",
        clamp(c.warmDbQps / Math.max(1, c.traffic)),
        warmHealth,
      ),
      edge("warm-db", "warmup", "db", clamp(c.warmDbQps / DB_CAPACITY), dbHealth),
    ],
    metrics: [
      metric("db-qps", "Database queries", c.dbQps, " qps", 8_000, 12_000, "rps"),
      metric("cold-keys", "Cold keys", c.coldKeys, "", 20_000, 60_000, "count"),
      metric("miss-rate", "Miss rate", c.missRate * 100, "%", 60, 90, "percent"),
      metric("hit-rate", "Hit rate", c.hitRate * 100, "%", undefined, undefined, "percent"),
      metric(
        "warm-progress",
        "Warmup progress",
        c.progress * 100,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("warm-rate", "Warmup load", c.warmDbQps, " keys/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      warmProgress: c.progress,
      coldShare: c.coldShare,
    },
    summary: `${formatCount(c.dbQps)} qps at the origin; ${(c.hitRate * 100).toFixed(0)}% hit rate; ${formatCount(c.coldKeys)} keys still cold; warmup ${(c.progress * 100).toFixed(0)}%.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
          Math.sin(index / 2.1) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "db-qps",
    metricId: "db-qps",
    warn: 8_000,
    crit: 12_000,
    title: "The cold cache sent the origin above capacity",
    cause:
      "Every cold key is a miss, and live traffic plus the warmup job both read from the origin. An empty cache turns read traffic into origin load until the hot set is refilled.",
    fix: "Protect the origin first: shed or queue noncritical traffic, coalesce live misses, and rate-limit the warmup. Then fill the hot set in waves and restore traffic as the hit rate rises.",
    checkFirst: [
      "Compare origin QPS with cache hit rate and cache state.",
      "Separate live miss traffic from warmup traffic.",
      "Check whether coalescing is enabled on every instance.",
    ],
  },
  {
    id: "cold-keys",
    metricId: "cold-keys",
    warn: 20_000,
    crit: 60_000,
    title: "The hot set is still mostly cold",
    cause:
      "The warmup has not covered enough of the hot set, or its rate is too low relative to the traffic. Live reads keep missing and the origin keeps serving them.",
    fix: "Raise the warmup rate within origin headroom, start it before restoring full traffic, and prioritize the keys that account for most reads. Coalescing limits duplicate misses while the cache fills.",
    checkFirst: [
      "Check warmup progress and the number of keys remaining.",
      "Check whether the job is warming the hot set or the whole keyspace.",
      "Check whether a rate limit or a failed worker is holding the warmup back.",
    ],
  },
  {
    id: "miss-rate",
    metricId: "miss-rate",
    warn: 60,
    crit: 90,
    title: "Most reads are still missing the cache",
    cause:
      "A cold cache cannot absorb reads. Without coalescing, each miss can also become its own origin query, so the miss rate and origin QPS rise together.",
    fix: "Coalesce misses, preload the hot keys, and avoid restoring full traffic until the hit rate is high enough for the origin to absorb the remaining misses.",
    checkFirst: [
      "Check hit rate and cold key count together.",
      "Check whether the cache was restarted or a deploy changed the key namespace.",
      "Check whether the warmup job is reading from a replica that is itself behind.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const warmingModel: SimModel = {
  id: "caching-warming",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed, 0, 1);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const coldShare = pct(p, "coldShare", 0);
    const warmRate = Math.max(0, num(p, "warmRate", 4_000));
    const previousShare = Number(frame.flags.coldShare ?? 0);
    let progress = Number(frame.flags.warmProgress ?? 1);
    if (coldShare === 0) {
      progress = 1;
    } else {
      if (reset || Math.abs(previousShare - coldShare) > 0.001) progress = 0;
      progress = Math.min(1, progress + (warmRate * dt) / Math.max(1, coldShare * HOT_KEYS));
    }
    const noisy = {
      ...p,
      trafficRps: Math.max(0, num(p, "trafficRps", 30_000) * (1 + rng.between(-0.002, 0.002))),
    };
    const next = buildFrame(noisy, Number(frame.flags.seed ?? 20261110), frame.t, progress);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      seed: Number(frame.flags.seed ?? 20261110),
      paramsKey: key,
      warmProgress: progress,
      coldShare,
    };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const c = compute(p, progress);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (c.dbQps >= 12_000 && frame.flags.coldStartSeen !== 1) {
      pushEvent(next, {
        id: "cold-cache-origin-overload",
        at: frame.t,
        severity: "crit",
        title: "Cold cache drove the origin above capacity",
        detail: `${formatCount(c.dbQps)} qps at the origin while ${formatCount(c.coldKeys)} keys are still cold. Live misses account for ${formatCount(c.liveDbQps)} qps and warmup for ${formatCount(c.warmDbQps)} qps.`,
        nodeId: "db",
        metricId: "db-qps",
      });
      next.flags.coldStartSeen = 1;
    }
    if (c.dbQps < 8_000 && c.coldKeys < 20_000) next.flags.coldStartSeen = 0;
    next.summary = `${formatCount(c.dbQps)} qps at the origin; ${(c.hitRate * 100).toFixed(0)}% hit rate; ${formatCount(c.coldKeys)} keys still cold; warmup ${(c.progress * 100).toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p, 1);
    const start = compute(p, 0);
    const items: string[] = [];
    items.push(
      `A cold start leaves ${formatCount(start.coldKeys)} hot keys missing. At ${formatCount(c.traffic)} reads/s, every miss becomes origin work until the cache fills.`,
    );
    items.push(
      `At ${formatCount(c.warmRate)} keys/s, filling the cold set takes about ${(start.coldKeys / Math.max(1, c.warmRate)).toFixed(0)}s. Warmup traffic adds directly to origin load while live misses are still high.`,
    );
    items.push(
      `Request coalescing at ${Math.round(c.coalescing * 100)}% reduces duplicate live misses, but every distinct cold key still needs one fetch.`,
    );
    items.push(
      c.dbQps >= 12_000
        ? "The origin is above capacity even after warming. Protect it before restoring full traffic, or the recovery becomes a second outage."
        : "The warmed steady state is below capacity; the risk is the transition, not the destination.",
    );
    items.push(
      "Warming is a scheduling problem: it decides when the misses happen, not how many distinct keys need a value.",
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
    description: "A warm cache absorbs reads; the origin sees only the steady miss rate.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 30% cold cache with a controlled warmup crosses the origin warning threshold.",
    tone: "warn",
    params: defaults({ trafficRps: 40_000, warmRate: 5_000, coalescing: 90, coldShare: 30 }),
  },
  {
    id: "failure",
    label: "Empty cache",
    description:
      "A full cold start with no warmup and no coalescing sends all reads to the origin.",
    tone: "crit",
    params: defaults({ trafficRps: 50_000, warmRate: 0, coalescing: 0, coldShare: 100 }),
  },
  {
    id: "recovery",
    label: "Controlled warmup",
    description:
      "Full coalescing plus an 8,000 keys/s warmup refills the hot set and returns the origin to normal.",
    tone: "ok",
    params: defaults({ trafficRps: 50_000, warmRate: 8_000, coalescing: 100, coldShare: 100 }),
  },
  {
    id: "warmup-only",
    label: "Warmup only",
    description:
      "Warming without coalescing still sends every live cold miss to the origin during the fill.",
    tone: "crit",
    params: defaults({ trafficRps: 50_000, warmRate: 8_000, coalescing: 0, coldShare: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-warming-order",
  title: "Predict what protects the origin first",
  simId: "warming",
  question:
    "A cache restarts empty while 50,000 reads/s continue. Which combination brings the origin under capacity fastest without dropping traffic?",
  prediction: {
    options: [
      { id: "both", label: "Coalesce live misses and warm the hot set at a controlled rate" },
      { id: "warm", label: "Warm the hot set only; live misses are already covered by the cache" },
      { id: "coalesce", label: "Coalesce live misses only; the cache will fill from traffic" },
      { id: "size", label: "Resize the cache; the empty cache will refill itself" },
    ],
    correctOptionId: "both",
    explanation:
      "Coalescing reduces duplicate work but does not create cached values. Warming fills the hot set, but its own reads add to origin load. The combination protects the origin during the transition: one fetch per distinct key, a warmup rate inside headroom, and a hit rate that rises until live misses fall. Neither control alone fixes both the duplicate work and the cold keys.",
  },
  setup: defaults({ trafficRps: 50_000, warmRate: 0, coalescing: 0, coldShare: 100 }),
  runFor: 20,
  observe: [
    "Before the fix, the origin sees about 50,000 qps and the hit rate is zero.",
    "With full coalescing and an 8,000 keys/s warmup, the origin starts near 18,000 qps because live misses still exceed the warmup.",
    "The hit rate rises as the hot set fills; the origin falls below its warning threshold within about 13 seconds.",
    "At 20 seconds, the hot set is full, the miss rate is near the steady 2%, and the origin is near 200 qps.",
    "Warming alone still sends every live cold miss to the origin; coalescing alone leaves the cache cold.",
  ],
  explain:
    "The empty cache moved read traffic to the origin. Coalescing changed the number of queries per distinct miss; warming changed the number of distinct keys that miss. The origin's load during recovery is the sum of live miss work and warmup work, so the warmup rate must leave room for the live path. Fill the hot set first, restore traffic gradually, and watch the hit rate rather than the clock.",
  fix: defaults({ trafficRps: 50_000, warmRate: 8_000, coalescing: 100, coldShare: 100 }),
  debrief:
    "The combined recovery kept the origin below capacity after a short transition. It depended on the warmup rate staying inside origin headroom and on coalescing being enabled before traffic returned. A faster warmup would have filled the cache sooner but pushed the origin over capacity; a slower one would have left the cache cold longer. The right rate is the one the origin can absorb alongside the live miss rate, not the fastest possible fill.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cache warming is the controlled refill of a cache before or while it serves production traffic. A restart, a deploy that changes the key namespace, an eviction wave, or a new region can leave the hot set empty. Every read that would have hit the cache becomes a miss, so the origin receives the read traffic the cache normally absorbed. If the origin cannot serve that load, a cache restart becomes a database outage.",
  },
  {
    type: "p",
    text: "Warming can replay the keys that account for most reads, load a snapshot of the hot set, or let live traffic fill the cache while coalescing duplicates. The first two reduce the cold period but add their own origin reads. The third avoids a separate job but leaves the origin exposed until the hot keys are populated. Most production recoveries combine them: coalesce live misses, warm the hot set at a rate the origin can absorb, and restore traffic as the hit rate rises.",
  },
  {
    type: "p",
    text: "Warming does not create capacity. It schedules misses and decides which keys are fetched first. A warmup job that reads faster than the origin can serve is a load generator, not a recovery tool. The rate must be chosen with the live miss rate in mind, and it must be bounded by the origin's headroom, not by how fast the job can read.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, service, cache, origin. A warmup job sits beside the read path: it reads the origin and writes the cache before or during traffic. Live misses also write the cache. Coalescing sits in the service, in front of the origin, and collapses concurrent requests for the same missing key. The origin sees both streams, so its load is the sum of live miss work and warmup work.",
  },
  {
    type: "compare",
    leftTitle: "Uncontrolled cold start",
    rightTitle: "Controlled warming",
    rows: [
      {
        label: "Origin load",
        left: "Full read rate until the hot set fills",
        right: "Live miss work plus a bounded warmup rate",
      },
      {
        label: "Time to warm",
        left: "Depends on traffic and key distribution",
        right: "Set by the warmup rate and hot-set size",
      },
      {
        label: "Duplicate work",
        left: "Every concurrent miss can fetch",
        right: "Coalescing keeps one fetch per distinct key",
      },
      {
        label: "Risk",
        left: "Origin saturates and the recovery becomes an outage",
        right: "A slow fill keeps the origin exposed longer",
      },
    ],
  },
  {
    type: "p",
    text: "The model uses a 100,000-key hot set, an illustrative 12,000 queries-per-second origin, and a warm cache hit rate of 98%. These are teaching values, not ElastiCache limits. The model does not credit natural fill from live traffic, so a zero warmup rate leaves the cache cold; that makes the warmup decision visible, not a claim about every cache-aside client.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Database QPS split into live miss work and warmup work.",
      "Cold key count and hit rate as the hot set fills.",
      "Miss rate, which stays high until enough of the hot set is cached.",
      "Warmup progress and the configured warmup rate.",
      "Node state for the cache, warmup job, and origin during the transition.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Empty cache. Watch the origin take the full read rate. Apply Controlled warmup and compare the initial live miss load with the warmup load. Turn coalescing off in the warmup-only preset to see why warming alone is not enough. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      [
        "Warmup rate",
        "How fast the hot set is preloaded",
        "Origin load during the fill; a slow rate prolongs the cold period",
      ],
      [
        "Coalescing",
        "Collapses concurrent misses for one key",
        "Waiter latency and an error path; does not fill the cache",
      ],
      [
        "Traffic ramp",
        "How quickly full read traffic returns",
        "A fast ramp adds live misses before the hit rate recovers",
      ],
      [
        "Hot-set priority",
        "Which keys are warmed first",
        "Requires a reliable ranking; misses on the rest still reach the origin",
      ],
    ],
  },
  {
    type: "p",
    text: "Plan recovery in order: protect the origin, warm the hot set, watch the hit rate, then restore traffic. The cache being full is not the goal; the origin staying inside capacity is.",
  },
  { type: "sim", simId: "warming" },
  { type: "experiment", experimentId: "predict-warming-order" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The empty cache turned read traffic into origin traffic. Every read missed, and without coalescing each concurrent miss could also become its own query. The origin saw the full read rate plus the warmup job, crossed its capacity, and the cache stayed cold because the warmup had not covered the hot set.",
  },
  {
    type: "p",
    text: "Coalescing reduced duplicate live work, and the warmup filled the hot set over time. The origin's load during recovery was the sum of the two: live misses that had not been coalesced and warmup reads. As the hit rate rose, the live component fell; the warmup component stopped when the hot set was full. The recovery worked because the warmup rate left room for the live path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache hit rate near zero after a restart, then rising as keys are populated.",
      "Origin QPS at the full read rate, or higher if misses are duplicated.",
      "Warmup job progress, read rate, and failures; a stalled job keeps the cache cold.",
      "Database pool wait, p99, and errors as the origin absorbs the cold load.",
      "Eviction or key-namespace changes that explain why the cache is cold after a deploy.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check cache hit rate and cold key count before increasing origin capacity. Separate live miss traffic from warmup traffic, confirm coalescing is enabled, and check whether the warmup is rate-limited or stalled.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Protect the origin: shed or queue noncritical reads and coalesce duplicate misses.",
      "Start the warmup before restoring full traffic and target the keys that carry most reads.",
      "Set the warmup rate from origin headroom after accounting for live misses.",
      "Ramp traffic as the hit rate rises; do not wait for a fixed timer.",
      "Verify warmup progress, origin QPS, p99, and errors together.",
      "After recovery, record which keys were cold and why so the next restart is faster.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A fast warmup shortens the cold period but competes with live misses for origin capacity.",
      "A slow warmup protects the origin but leaves the cache cold longer, so the origin serves more live misses.",
      "Coalescing reduces duplicate work but adds waiter latency and needs a timeout and error path.",
      "Warming only the hot set is efficient but leaves long-tail misses on the origin.",
      "Warming from a stale snapshot can serve old values; freshness still needs a TTL or version check.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cold-start-plan",
    question:
      "A cache restart leaves 100,000 hot keys empty while production traffic continues. What do you do first?",
    difficulty: 3,
    hints: [
      "The origin is the immediate risk, not the cache.",
      "Warming and live traffic share the same origin capacity.",
    ],
    answer:
      "I would protect the origin first: enable or verify request coalescing, shed or queue noncritical reads, and avoid restoring any traffic that is still held back. Then I would start a controlled warmup for the keys that carry most reads, at a rate that leaves room for live misses. I would watch hit rate, cold key count, origin QPS, and p99, and ramp traffic as the hit rate rises. I would not run the warmup at full speed just because the job can; the origin has to serve both streams. After recovery I would check why the cache was cold and whether the warmup can start before traffic returns.",
    followUps: [
      "How would you choose the warmup rate?",
      "What would you do if the warmup job itself fails?",
      "How would you prioritize keys?",
    ],
    redFlags: [
      "Runs the warmup at maximum speed.",
      "Restores full traffic before the hit rate recovers.",
      "Adds origin capacity without checking coalescing.",
    ],
    rubric: [
      "Protects the origin first.",
      "Sets a bounded warmup rate.",
      "Uses hit rate to sequence the traffic ramp.",
      "Plans the next restart.",
    ],
  },
  {
    id: "warm-vs-coalesce",
    question: "What does cache warming do that request coalescing does not, and vice versa?",
    difficulty: 3,
    hints: [
      "One changes the number of distinct misses; the other changes duplicates.",
      "Neither creates origin capacity.",
    ],
    answer:
      "Warming fills keys before or during traffic, so it reduces the number of distinct misses. Coalescing leaves the cache cold but ensures concurrent requests for the same missing key share one fetch. Warming alone can still send every live cold miss to the origin; coalescing alone leaves every key cold and each distinct key still needs a fetch. Together they reduce both the number of distinct misses and the duplicate work per miss. Neither adds origin capacity, so the warmup rate and the traffic ramp still have to fit the origin's headroom.",
    followUps: [
      "Which one would you enable first during an incident?",
      "How do they interact with stale-while-revalidate?",
      "What metric shows each one working?",
    ],
    redFlags: [
      "Treats warming and coalescing as interchangeable.",
      "Claims either one removes the first fetch.",
      "Ignores the origin's combined load.",
    ],
    rubric: [
      "Separates distinct misses from duplicates.",
      "Explains the combined effect.",
      "Names the shared capacity limit.",
      "Identifies a metric for each.",
    ],
  },
  {
    id: "warmup-rate",
    question: "How do you choose a cache warmup rate?",
    difficulty: 3,
    hints: [
      "Start from origin headroom after live misses.",
      "A rate that fills faster than the origin can serve is a load test.",
    ],
    answer:
      "I would estimate the origin's usable headroom after the live miss load and set the warmup rate below that, with margin for retries and traffic variance. Then I would measure the fill time and the hit rate curve. If the fill is too slow, I would prioritize hotter keys, warm in waves, or increase origin capacity deliberately rather than raising the rate past headroom. I would also bound the job's concurrency, make it resumable, and stop it if origin p99 or errors cross the threshold.",
    followUps: [
      "What if the hot set changes during the day?",
      "How would you warm a multi-region cache?",
      "What is the risk of warming from a replica?",
    ],
    redFlags: [
      "Chooses the maximum rate the job supports.",
      "Ignores live miss load.",
      "Has no stop condition for origin health.",
    ],
    rubric: [
      "Sizes from origin headroom.",
      "Measures fill time and hit rate.",
      "Prioritizes hot keys or waves.",
      "Bounds and monitors the job.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "A warmup path exists for the hot set and can run before traffic returns.",
      "The warmup rate is capped by origin headroom, not by job throughput.",
      "Request coalescing is enabled on every instance for expensive keys.",
      "Dashboards show hit rate, cold key count, origin QPS, and warmup progress.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Protect the origin before filling the cache: shed, queue, and coalesce.",
      "Warm the keys that carry most reads first.",
      "Ramp traffic with the hit rate, not with a fixed timer.",
      "Watch the warmup job for stalls, errors, and stale reads from its source.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the fill time, peak origin QPS, and the keys that stayed cold.",
      "Verify the warmup source and the TTL or version of warmed values.",
      "Add a restart test that measures origin load with and without warming.",
      "Document the recovery order and the traffic ramp.",
    ],
  },
];

const references = [
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cold-cache load, thundering herd, and cache-aside guidance.",
  },
  {
    title: "Redis persistence",
    url: "https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Restart behavior and the cold-cache scenarios persistence does and does not cover.",
  },
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies",
    publisher: "Amazon Builders' Library",
    kind: "docs" as const,
    note: "Cold caches, request coalescing, and origin protection.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    warming: {
      model: warmingModel,
      presets,
      instructions:
        "Mechanic: Empty cache with warmup strategy; DB load and hit rate. Start Healthy, then apply Empty cache. Watch origin QPS take the full read rate. Apply Controlled warmup and compare live miss load with warmup load. Turn coalescing off to see warming alone.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The hot set is 100,000 keys, origin capacity is 12,000 QPS, and the warm cache hit rate is 98%. These are teaching values, not ElastiCache limits. Coalescing is modeled as up to an 80% reduction in live miss work; distinct-key misses and imperfect coverage still reach the origin. The model does not credit natural fill from live traffic, so the warmup decision is visible. The break condition is a cold cache driving the database above capacity; recovery sequences coalescing, a bounded warmup, and a traffic ramp.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-cache-stampede",
    "caching-request-coalescing",
    "caching-ttl-jitter",
    "caching-aside-vs-write-through",
  ],
};
