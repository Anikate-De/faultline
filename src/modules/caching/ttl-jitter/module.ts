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

const BACKEND_CAPACITY = 6_000;
const BASE_QPS = 200;
const READ_RPS = 20_000;

const params = [
  {
    id: "keyCount",
    label: "Keys in the batch",
    min: 1_000,
    max: 30_000,
    step: 1_000,
    value: 8_000,
    unit: " keys",
    group: "Workload",
    help: "Keys written together by a warmup, deploy, or bulk load. They share one TTL unless jitter is added.",
    format: "count" as const,
  },
  {
    id: "ttlSeconds",
    label: "Base TTL",
    min: 10,
    max: 120,
    step: 5,
    value: 30,
    unit: " s",
    group: "Expiry",
    help: "Freshness bound written on every key in the batch. The first expiry wave starts here.",
    format: "number" as const,
  },
  {
    id: "jitterPercent",
    label: "TTL jitter",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Expiry",
    help: "Share of the base TTL added as a random offset at write time. 0% keeps the batch aligned.",
    format: "percent" as const,
  },
  {
    id: "refreshMs",
    label: "Refresh time per key",
    min: 20,
    max: 500,
    step: 20,
    value: 100,
    unit: " ms",
    group: "Backend",
    help: "How long one key takes to recompute. With zero jitter it sets the width of the expiry spike.",
    format: "ms" as const,
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
  keys: number;
  ttl: number;
  jitter: number;
  refreshMs: number;
  spread: number;
  jitterWindow: number;
  cycle: number;
  phase: number;
  active: boolean;
  peak: number;
  base: number;
  qps: number;
  util: number;
  concentration: number;
  missRate: number;
  maxTtl: number;
}

function compute(p: Params, t: number): Computed {
  const keys = Math.max(1, num(p, "keyCount", 8_000));
  const ttl = Math.max(1, num(p, "ttlSeconds", 30));
  const jitter = pct(p, "jitterPercent", 20);
  const refreshMs = Math.max(1, num(p, "refreshMs", 100));
  const jitterWindow = jitter * ttl;
  const spread = Math.max(refreshMs / 1000, jitterWindow);
  const cycle = ttl + spread;
  const phase = ((t % cycle) + cycle) % cycle;
  const active = phase >= ttl - 1e-6;
  const peak = keys / spread;
  const averageRefresh = keys / cycle;
  const base = BASE_QPS + averageRefresh;
  const peakExtra = Math.max(0, peak - averageRefresh);
  const qps = base + (active ? peakExtra : 0);
  const util = qps / BACKEND_CAPACITY;
  const concentration = active ? Math.min(100, 100 / spread) : 0;
  const missRate = active ? 85 : 2;
  return {
    keys,
    ttl,
    jitter,
    refreshMs,
    spread,
    jitterWindow,
    cycle,
    phase,
    active,
    peak,
    base,
    qps,
    util,
    concentration,
    missRate,
    maxTtl: ttl + jitterWindow,
  };
}

function healthFor(qps: number): "ok" | "warn" | "crit" {
  if (qps >= 6_000) return "crit";
  if (qps >= 3_000) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const c = compute(p, t);
  const health = healthFor(c.qps);
  const cacheHealth = c.qps >= 3_000 ? "warn" : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Readers",
        kind: "client",
        health: "ok",
        utilization: clamp(READ_RPS / 50_000),
        throughput: READ_RPS,
        sublabel: `${formatCount(READ_RPS)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "App fleet",
        kind: "service",
        health: cacheHealth,
        utilization: clamp(READ_RPS / 50_000),
        throughput: READ_RPS,
        sublabel: "shared TTL writer",
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Cache fleet",
        kind: "cache",
        health: cacheHealth,
        throughput: READ_RPS,
        sublabel: `${formatCount(c.keys)} keys warmed together`,
        detail:
          "The batch is aligned. Each key carries its own TTL, but a warmup wrote them at the same time and without jitter they expire together.",
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Origin database",
        kind: "db",
        health,
        utilization: clamp(c.util),
        throughput: c.qps,
        sublabel: `${formatCount(c.qps)} qps`,
        detail: `Illustrative teaching capacity is ${formatCount(BACKEND_CAPACITY)} qps. With ${Math.round(c.jitter * 100)}% jitter, expiry is spread over about ${c.spread.toFixed(0)}s and the maximum TTL is about ${c.maxTtl.toFixed(0)}s.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", clamp(READ_RPS / 50_000)),
      edge("app-cache", "app", "cache", 1, "ok"),
      edge("app-backend", "app", "backend", clamp(c.qps / READ_RPS), health),
    ],
    metrics: [
      metric("backend-qps", "Backend queries", c.qps, " qps", 3_000, 6_000, "rps"),
      metric(
        "expiry-concentration",
        "Expiry concentration",
        c.concentration,
        "%",
        20,
        50,
        "percent",
      ),
      metric(
        "miss-rate",
        "Miss rate during wave",
        c.missRate,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("refresh-window", "Refresh window", c.spread, " s", undefined, undefined, "number"),
      metric("max-ttl", "Maximum TTL", c.maxTtl, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCount(c.qps)} qps at the origin; ${Math.round(c.jitter * 100)}% jitter spreads expiry over ${c.spread.toFixed(1)}s; max TTL ${c.maxTtl.toFixed(0)}s.`,
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
    id: "backend-qps",
    metricId: "backend-qps",
    warn: 3_000,
    crit: 6_000,
    title: "Aligned TTLs sent an expiry wave to the origin",
    cause:
      "A batch load wrote the same TTL for every key. They reach expiry together, so the origin receives the batch's refresh work in a short window rather than at the average refresh rate.",
    fix: "Add jitter where the TTL is written, including warmups, deploys, and backfills. Spread the offset over a window the origin can absorb, and cap the maximum TTL so freshness still meets the product contract.",
    checkFirst: [
      "Compare origin spikes with the TTL period and with batch-load times.",
      "Check whether the TTL writer uses one constant or a random offset.",
      "Check whether a deploy or warmup rewrote the whole batch at once.",
    ],
  },
  {
    id: "expiry-concentration",
    metricId: "expiry-concentration",
    warn: 20,
    crit: 50,
    title: "Too much of the batch expires inside one second",
    cause:
      "The expiry window is narrow relative to the batch size. Even if the origin survives one wave, the next wave arrives with the same shape.",
    fix: "Increase jitter or run the warmup in smaller waves. Measure concentration, not only the peak QPS of one wave.",
    checkFirst: [
      "Calculate the intended jitter window as a share of the TTL.",
      "Check whether every key really received the random offset.",
      "Check whether a retry or backfill re-aligned keys after the first expiry.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const ttlJitterModel: SimModel = {
  id: "caching-ttl-jitter",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const noisy = {
      ...p,
      keyCount: Math.max(1, num(p, "keyCount", 8_000) * (1 + rng.between(-0.002, 0.002))),
    };
    const next = buildFrame(noisy, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      seed: Number(frame.flags.seed ?? 20261110),
      paramsKey: key,
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
    const c = compute(p, frame.t);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (c.active && c.concentration >= 50 && frame.flags.ttlWaveSeen !== 1) {
      pushEvent(next, {
        id: "ttl-expiry-wave",
        at: frame.t,
        severity: "crit",
        title: "TTL alignment created an expiry wave",
        detail: `${formatCount(c.keys)} keys expire inside one refresh window. The origin sees ${formatCount(c.qps)} qps instead of the batch's average refresh rate.`,
        nodeId: "backend",
        metricId: "backend-qps",
      });
      next.flags.ttlWaveSeen = 1;
    }
    next.summary = `${formatCount(c.qps)} qps at the origin; ${Math.round(c.jitter * 100)}% jitter spreads expiry over ${c.spread.toFixed(1)}s; max TTL ${c.maxTtl.toFixed(0)}s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p, 0);
    const items: string[] = [];
    items.push(
      `${formatCount(c.keys)} keys refreshed over a ${c.spread.toFixed(1)}s window produce about ${formatCount(c.peak)} qps at the peak. With no jitter that window is only ${c.refreshMs.toFixed(0)}ms.`,
    );
    items.push(
      `The batch still does ${formatCount(c.keys)} refreshes per cycle. Jitter changes when they arrive, not how many there are. The average refresh rate is about ${formatCount(c.keys / c.cycle)} per second.`,
    );
    items.push(
      `A ${Math.round(c.jitter * 100)}% additive jitter raises the maximum TTL from ${c.ttl.toFixed(0)}s to about ${c.maxTtl.toFixed(0)}s. That is the freshness cost.`,
    );
    if (c.jitter === 0) {
      items.push(
        "At zero jitter every key in the batch becomes eligible at the same instant. The origin sees the batch as one spike, repeated at the TTL period.",
      );
    } else {
      items.push(
        `Expiry concentration is about ${c.concentration.toFixed(1)}% of the batch per second. Lower is smoother, but a wider window means older values.`,
      );
    }
    items.push(
      "Jitter is not early refresh and not coalescing. It moves the expiry timestamp; it does not collapse duplicate fetches at the edge.",
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
    description: "A modest batch with 20% jitter stays below the origin's warning threshold.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "A larger batch with the same jitter crosses the warning threshold during its wave.",
    tone: "warn",
    params: defaults({ keyCount: 14_000, ttlSeconds: 15, jitterPercent: 20, refreshMs: 100 }),
  },
  {
    id: "failure",
    label: "Aligned batch",
    description: "A 24,000-key warmup with no jitter expires in one spike.",
    tone: "crit",
    params: defaults({ keyCount: 24_000, ttlSeconds: 15, jitterPercent: 0, refreshMs: 100 }),
  },
  {
    id: "recovery",
    label: "Smear the batch",
    description:
      "Full jitter spreads the same batch over its whole TTL and keeps the origin below warning.",
    tone: "ok",
    params: defaults({ keyCount: 24_000, ttlSeconds: 15, jitterPercent: 100, refreshMs: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-jitter-peak",
  title: "Predict what jitter changes",
  simId: "ttl-jitter",
  question:
    "Twenty thousand keys are warmed with a 20-second TTL and no jitter. You add 80% jitter. What changes?",
  prediction: {
    options: [
      { id: "spread", label: "The peak falls; the number of refreshes per cycle stays the same" },
      { id: "less", label: "The number of refreshes falls because fewer keys expire" },
      { id: "same", label: "Nothing changes until the next deploy" },
      { id: "hot", label: "The cache stops missing during the wave" },
    ],
    correctOptionId: "spread",
    explanation:
      "Jitter adds a random offset when the TTL is written. The keys still expire and refresh once per cycle; they no longer do it at the same instant. The origin's peak falls because the same work is spread over a wider window. Total work per cycle stays roughly the same, and the maximum TTL rises by the jitter window.",
  },
  setup: defaults({ keyCount: 20_000, ttlSeconds: 20, jitterPercent: 0, refreshMs: 100 }),
  runFor: 20.1,
  observe: [
    "Before the fix, the origin jumps above 200,000 qps at the 20-second edge.",
    "After 80% jitter, the same 20,000 refreshes spread over about 16 seconds and peak near 1,450 qps.",
    "Expiry concentration falls from 100% to about 6% of the batch per second.",
    "Maximum TTL rises from 20 seconds to about 36 seconds.",
    "Total refreshes per cycle stays at 20,000; only their timing changes.",
  ],
  explain:
    "Jitter is applied at write time, so it changes the expiry timestamp of each key. It does not deduplicate refreshes and it does not refresh early. The batch still has one refresh per key per cycle. Spreading the same work over 16 seconds lowers the peak by roughly the ratio of the windows, while the longer maximum TTL is the freshness cost. If the origin still saturates, add coalescing or warm in smaller waves.",
  fix: defaults({ keyCount: 20_000, ttlSeconds: 20, jitterPercent: 80, refreshMs: 100 }),
  debrief:
    "The peak fell by more than an order of magnitude and the average load barely moved. That is the signature of jitter: same work, different shape. The cost is a wider TTL range, so a key can be up to the maximum TTL old. Set the jitter window from the origin's headroom and the product's freshness bound, then verify that every TTL writer, including warmups and backfills, uses it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "TTL jitter, also called smearing, adds a random offset to a key's time to live when the key is written. A cache-aside read stores a value with a freshness bound; without jitter, every key written by the same warmup or deploy gets the same bound and expires at the same moment. The origin then receives the whole batch's refresh work in one wave. Jitter moves each key's expiry a little earlier or later so the work arrives over a window instead of an edge.",
  },
  {
    type: "p",
    text: "The offset can be additive, proportional, or drawn from a distribution. A simple form is base TTL plus a uniform random value up to a percentage of the base. Another is base TTL times a random factor in a bounded range. The choice matters for freshness: if jitter only adds time, the maximum TTL grows and a value can be older than the base bound. If it subtracts time, the maximum stays at the base but the average TTL falls and the refresh rate rises. Either way, the jitter belongs where the TTL is written, not only in a dashboard or a client default.",
  },
  {
    type: "p",
    text: "Jitter is a timing fix, not a concurrency fix. It does not collapse duplicate fetches at the edge; request coalescing does that. It does not refresh values before expiry; early expiration does that. It changes when keys become eligible to expire, which lowers the peak while leaving the number of refreshes per cycle essentially unchanged.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The write path is client, app instance, cache, origin. The app sets the value and its TTL in the cache client after a read miss, a write, or a warmup job. A bulk loader or deploy script may write millions of keys in a few seconds, which is where aligned TTLs usually come from. Redis stores the expiration per key; its TTL commands expose the remaining time, not the original jitter. The jitter must be applied by every writer, including backfills, retries, and cache rebuild jobs.",
  },
  {
    type: "compare",
    leftTitle: "No jitter",
    rightTitle: "Jitter at write time",
    rows: [
      {
        label: "Expiry shape",
        left: "One edge for the whole batch",
        right: "A window whose width is the jitter range",
      },
      {
        label: "Origin peak",
        left: "Batch size divided by refresh time",
        right: "Batch size divided by the jitter window",
      },
      {
        label: "Total refreshes",
        left: "One per key per TTL",
        right: "One per key per TTL, plus a small rate change if the average TTL moves",
      },
      {
        label: "Freshness cost",
        left: "Bounded by the base TTL",
        right: "Bounded by the maximum TTL after the offset",
      },
    ],
  },
  {
    type: "p",
    text: "The model uses a 6,000 queries-per-second origin, 100 ms refresh time, and a batch of keys written together. These are teaching values, not Redis limits. The expiry window is a simplified uniform spread, not a claim about how any particular client generates random numbers.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Origin QPS over repeated expiry cycles, with warning and critical thresholds.",
      "Expiry concentration: the share of the batch that becomes eligible inside one second.",
      "Miss rate during the wave and the refresh window in seconds.",
      "Maximum TTL, which shows the freshness cost of an additive jitter range.",
      "Node state for the cache fleet and origin as the wave arrives.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and wait for the wave, then apply Aligned batch. Watch the origin spike at the TTL edge. Raise jitter and compare the peak with the maximum TTL: the peak falls, but the oldest value gets older. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      [
        "Additive jitter",
        "Moves expiry later by a random offset",
        "Raises maximum TTL and staleness",
      ],
      [
        "Subtractive jitter",
        "Moves expiry earlier by a random offset",
        "Keeps maximum TTL but raises refresh rate",
      ],
      [
        "Smaller warmup waves",
        "Writes fewer keys with one timestamp",
        "Longer warmup and more operational steps",
      ],
      [
        "Request coalescing",
        "Collapses concurrent misses at the edge",
        "Waiter latency and an error path; does not spread expiry",
      ],
    ],
  },
  {
    type: "p",
    text: "Pick the jitter window from the origin's headroom first, then check it against the freshness bound. A window that protects the origin but violates the product's maximum staleness is not a fix.",
  },
  { type: "sim", simId: "ttl-jitter" },
  { type: "experiment", experimentId: "predict-jitter-peak" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The warmup wrote every key with the same TTL. At the TTL edge the whole batch became eligible at once, so the origin received one refresh per key inside a window only as wide as the refresh time. The load was not caused by more traffic; it was caused by alignment. Adding jitter moved each key's expiry by a random offset, so the same refreshes arrived over a wider window and the peak fell.",
  },
  {
    type: "p",
    text: "The total number of refreshes per cycle did not change, and the origin's average load barely moved. The maximum TTL grew by the additive jitter, which is the freshness cost. At full jitter the batch was still large, but the origin stayed below its warning threshold because the work was spread rather than concentrated.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Origin QPS with a period equal to the cache TTL, often sharp and repeatable.",
      "A batch load, deploy, or warmup immediately before the first spike.",
      "Cache TTL distribution: without jitter it clusters at one value; with jitter it spreads.",
      "Miss rate rising only during the wave, while the average hit rate looks healthy.",
      "Maximum key age or TTL p99, which reveals the freshness cost of the jitter range.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Align the spike with the TTL period and the last batch write. Check the TTL writer, not only the cache server. Confirm that warmups, backfills, retries, and deploys all apply the same jitter, and that the maximum TTL still meets the freshness contract.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the wave is periodic and tied to a batch write, not to a traffic surge.",
      "Add a random offset at every TTL write path, including warmups and backfills.",
      "Choose the window from origin headroom, then check the maximum TTL against the freshness bound.",
      "Warm large batches in smaller waves if a single batch is still too large.",
      "Keep request coalescing for the hard misses that remain at the edge.",
      "Load-test a batch expiry and verify peak QPS, concentration, miss rate, and maximum TTL together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Additive jitter lowers the peak but raises the oldest value's age; the product must accept the new maximum TTL.",
      "Subtractive jitter keeps the maximum TTL but refreshes more often, so total origin work rises.",
      "A wider window smooths more but spends more freshness; a narrower window protects freshness but leaves a sharper peak.",
      "Jitter does not collapse duplicate fetches at the edge; coalescing is still needed for hard misses.",
      "Jitter does not refresh early; early expiration changes the decision to recompute before expiry.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-wave",
    question:
      "Origin CPU spikes every five minutes and the cache hit rate is otherwise healthy. How do you confirm a TTL alignment problem?",
    difficulty: 1,
    hints: ["Look at the period, not the average.", "Find what wrote the keys five minutes ago."],
    answer:
      "I would check whether the spike period matches a cache TTL and whether a warmup, deploy, or bulk load wrote a large batch just before the first spike. I would compare the origin QPS shape with the batch size and refresh time, and check the TTL distribution for a cluster at one value. If the spike disappears when the batch is spread over time or when jitter is added, the alignment is confirmed. I would also rule out a scheduled job, a cron-driven cache clear, or a retry loop that runs on the same period.",
    followUps: [
      "What if the spike period is not stable?",
      "Which metric would you graph first?",
      "How would a shared cache tier change the diagnosis?",
    ],
    redFlags: [
      "Adds origin capacity before checking the period.",
      "Blames traffic without looking at the batch write.",
      "Checks only the average hit rate.",
    ],
    rubric: [
      "Ties the spike to a TTL period.",
      "Finds the batch writer.",
      "Checks the TTL distribution.",
      "Names what would falsify the hypothesis.",
    ],
  },
  {
    id: "choose-jitter",
    question:
      "How much jitter would you add, and how do you keep it from violating the freshness bound?",
    difficulty: 2,
    hints: [
      "Start from the origin's headroom.",
      "The maximum TTL, not the base TTL, is the freshness bound.",
    ],
    answer:
      "I would size the window so the batch's peak refresh rate fits the origin's headroom, then check the resulting maximum TTL against the product's freshness requirement. If additive jitter would make values too old, I would use subtractive jitter or a shorter base TTL, accepting a higher refresh rate. I would apply the same jitter function in every writer and verify the TTL distribution in production, not only in the warmup code. I would also keep a maximum cap so a random draw cannot produce an unbounded TTL.",
    followUps: [
      "How would you verify the distribution after a deploy?",
      "What happens if only the warmup applies jitter?",
      "Would you use a uniform or exponential offset?",
    ],
    redFlags: [
      "Chooses a percentage without checking origin headroom.",
      "Ignores maximum TTL and staleness.",
      "Applies jitter only in one writer.",
    ],
    rubric: [
      "Sizes from peak load and headroom.",
      "Checks maximum TTL against freshness.",
      "Applies jitter at every write path.",
      "Caps the offset.",
    ],
  },
  {
    id: "jitter-vs-work",
    question:
      "Does TTL jitter reduce total backend work? Explain what it does and does not change.",
    difficulty: 1,
    hints: ["Count refreshes per key per cycle.", "Separate peak from average."],
    answer:
      "Jitter does not reduce the number of refreshes per key per cycle. Each key still expires and is recomputed once per TTL. Jitter changes when those refreshes arrive: instead of one spike at a shared expiry edge, they spread across a window. That lowers peak QPS and makes the load easier to serve. If the jitter changes the average TTL, the refresh rate moves slightly: additive jitter lowers it and raises maximum staleness, while subtractive jitter raises it. Total work and peak work are different questions.",
    followUps: [
      "How would you prove the total work is unchanged?",
      "What else would you add if the average load is still too high?",
      "How does jitter interact with coalescing?",
    ],
    redFlags: [
      "Claims jitter reduces the number of refreshes.",
      "Confuses peak smoothing with capacity reduction.",
      "Ignores the average TTL change.",
    ],
    rubric: [
      "Separates total work from peak shape.",
      "Counts one refresh per key per cycle.",
      "Explains the average TTL effect.",
      "Names complementary controls.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every TTL writer applies jitter, including warmups, backfills, retries, and deploys.",
      "The jitter window is derived from origin headroom and documented next to the freshness bound.",
      "Maximum TTL, not only base TTL, is checked against the product contract.",
      "Dashboards show expiry concentration and origin QPS by TTL cohort.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Align the spike with the TTL period and the last batch write.",
      "Check whether one writer bypassed jitter or re-aligned the batch.",
      "Spread or pause the next warmup wave instead of adding origin capacity first.",
      "Watch the next bottleneck: connection pool, replica lag, or app latency.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify peak QPS, concentration, miss rate, and maximum TTL after the change.",
      "Reconcile the jitter function across every writer and environment.",
      "Document the freshness cost that remains.",
      "Add a load test that expires a warmed batch under peak traffic.",
    ],
  },
];

const references = [
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "TTL side effects, thundering herd, and cache-aside guidance.",
  },
  {
    title: "EXPIRE",
    url: "https://redis.io/docs/latest/commands/expire",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Per-key expiration and TTL behavior in Redis.",
  },
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies",
    publisher: "Amazon Builders' Library",
    kind: "docs" as const,
    note: "Expiring caches, request coalescing, and cold-cache load.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "ttl-jitter": {
      model: ttlJitterModel,
      presets,
      instructions:
        "Mechanic: Cache fleet with TTL distribution; expiry and backend QPS. Start Healthy and wait for the expiry wave, then apply Aligned batch. Raise TTL jitter and compare peak origin QPS with maximum TTL.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Origin capacity is 6,000 QPS, refresh time is 100 ms, and the jitter window is a uniform additive offset. These are teaching values, not Redis limits. The break condition is TTL alignment creating periodic backend spikes; recovery smears the same batch across the TTL.",
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
    "caching-probabilistic-expiration",
    "caching-warming",
  ],
};
