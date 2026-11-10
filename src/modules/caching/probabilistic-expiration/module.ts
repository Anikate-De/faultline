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

const RECOMPUTE_SECONDS = 0.12;
const SPREAD_GAIN = 10;
const BACKEND_CAPACITY = 9_000;
const BASE_QPS = 40;
const READ_RPS = 25_000;

const params = [
  {
    id: "alignedKeys",
    label: "Aligned keys",
    min: 100,
    max: 5_000,
    step: 100,
    value: 300,
    unit: " keys",
    group: "Workload",
    help: "Keys warmed at the same time with the same TTL. They form the expiry wave unless early refresh or jitter moves them apart.",
    format: "count" as const,
  },
  {
    id: "instances",
    label: "App instances",
    min: 2,
    max: 30,
    step: 1,
    value: 6,
    unit: "",
    group: "Workload",
    help: "Processes that each hold a copy of every key and make their own early-refresh decision.",
    format: "count" as const,
  },
  {
    id: "ttlSeconds",
    label: "TTL",
    min: 10,
    max: 120,
    step: 5,
    value: 20,
    unit: " s",
    group: "Expiry",
    help: "Freshness bound for each key. The wave repeats at this period when keys stay aligned.",
    format: "number" as const,
  },
  {
    id: "beta",
    label: "XFetch beta",
    min: 0,
    max: 3,
    step: 0.1,
    value: 1,
    unit: "",
    group: "Expiry",
    help: "Scales how far before expiry an early refresh may start. 0 waits for expiry; higher values widen the window and add recomputation.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  keys: number;
  instances: number;
  ttl: number;
  beta: number;
  total: number;
  spread: number;
  hardShare: number;
  earlyShare: number;
  earlyTotal: number;
  hardTotal: number;
  earlyRate: number;
  hardRate: number;
  backendQps: number;
  util: number;
  p99: number;
  extraCompute: number;
}

function compute(p: Params, t: number): Computed {
  const keys = Math.max(1, num(p, "alignedKeys", 300));
  const instances = Math.max(2, Math.round(num(p, "instances", 6)));
  const ttl = Math.max(1, num(p, "ttlSeconds", 20));
  const beta = Math.max(0, num(p, "beta", 1));
  const total = keys * instances;
  const spread = beta > 0 ? beta * RECOMPUTE_SECONDS * SPREAD_GAIN : RECOMPUTE_SECONDS;
  const hardShare = Math.exp(-2 * beta);
  const earlyShare = 1 - hardShare;
  const earlyTotal = total * earlyShare;
  const hardTotal = total * hardShare;
  const phase = ((t % ttl) + ttl) % ttl;
  const earlyActive = beta > 0 && phase > ttl - spread && phase < ttl;
  const hardActive = phase > ttl - RECOMPUTE_SECONDS;
  const earlyRate = earlyActive ? earlyTotal / spread : 0;
  const hardRate = hardActive ? hardTotal / RECOMPUTE_SECONDS : 0;
  const backendQps = BASE_QPS + earlyRate + hardRate;
  const util = backendQps / BACKEND_CAPACITY;
  const p99 = util <= 1 ? 18 + 40 * util ** 4 : 40 + 380 * Math.log2(Math.max(1, util));
  const extraCompute = ((earlyShare * (spread / 2)) / Math.max(1, ttl)) * 100;
  return {
    keys,
    instances,
    ttl,
    beta,
    total,
    spread,
    hardShare,
    earlyShare,
    earlyTotal,
    hardTotal,
    earlyRate,
    hardRate,
    backendQps,
    util,
    p99,
    extraCompute,
  };
}

function healthFor(qps: number): "ok" | "warn" | "crit" {
  if (qps >= 9_000) return "crit";
  if (qps >= 6_000) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const c = compute(p, t);
  const health = healthFor(c.backendQps);
  const atExpiryEdge = c.hardRate > 0;
  const hardSharePct = atExpiryEdge ? c.hardShare * 100 : 0;
  const cacheHealth = atExpiryEdge && c.hardShare >= 0.5 ? "warn" : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Readers",
        kind: "client",
        health: "ok",
        utilization: clamp(READ_RPS / 60_000),
        throughput: READ_RPS,
        sublabel: `${formatCount(READ_RPS)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "App fleet",
        kind: "service",
        health: cacheHealth,
        utilization: clamp(READ_RPS / 60_000),
        throughput: READ_RPS,
        sublabel: `${c.instances} instances`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Cache fleet",
        kind: "cache",
        health: cacheHealth,
        throughput: READ_RPS,
        sublabel: `${formatCount(c.keys)} keys share a TTL`,
        detail:
          "Every instance holds its own copy. Early refresh moves the recompute before the expiry edge; it does not change the key or its value.",
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Origin database",
        kind: "db",
        health,
        utilization: clamp(c.util),
        throughput: c.backendQps,
        sublabel: `${formatCount(c.backendQps)} qps`,
        detail: `Illustrative teaching capacity is ${formatCount(BACKEND_CAPACITY)} qps. One cycle recomputes about ${formatCount(c.total)} key-instance copies; early refresh spreads ${formatCount(c.earlyTotal)} of them.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", clamp(READ_RPS / 60_000)),
      edge("app-cache", "app", "cache", 1, "ok"),
      edge("app-backend", "app", "backend", clamp(c.backendQps / READ_RPS), health),
    ],
    metrics: [
      metric("backend-qps", "Backend queries", c.backendQps, " qps", 6_000, 9_000, "rps"),
      metric("backend-p99", "Backend p99", c.p99, " ms", 250, 800, "ms"),
      metric("hard-expiry-share", "Hard expiry share", hardSharePct, "%", 20, 50, "percent"),
      metric(
        "early-refresh",
        "Early refresh share",
        c.earlyShare * 100,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("extra-compute", "Extra recomputation", c.extraCompute, "%", 10, 20, "percent"),
      metric("refresh-window", "Refresh window", c.spread, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCount(c.backendQps)} qps at the origin; ${hardSharePct.toFixed(1)}% of refreshes still hit the expiry edge; ${c.extraCompute.toFixed(1)}% extra recomputation.`,
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
    warn: 6_000,
    crit: 9_000,
    title: "Aligned refreshes saturated the origin",
    cause:
      "Keys that share a TTL reach their expiry edge together. Each instance recomputes its copy, so the origin receives the fleet's refresh work in one short window instead of spread across the TTL.",
    fix: "Move refreshes before the edge and spread them. XFetch with a nonzero beta starts some refreshes early; TTL jitter changes when the keys expire; request coalescing collapses duplicate fetches at the moment of a miss.",
    checkFirst: [
      "Align the origin spike with the TTL of a batch of keys, not with total traffic.",
      "Check whether a warmup, deploy, or bulk load wrote the keys together.",
      "Check whether all instances use the same TTL and the same beta.",
    ],
  },
  {
    id: "hard-expiry-share",
    metricId: "hard-expiry-share",
    warn: 20,
    crit: 50,
    title: "Most keys still reach the hard expiry edge",
    cause:
      "Early refresh is disabled or too weak for the request rate. When beta is zero, every key waits for expiry and the fleet refreshes in sync.",
    fix: "Raise beta until the early-refresh window covers the replay time, then verify extra recomputation and origin load. For a single very hot key, pair XFetch with TTL jitter because the earliest request tends to win the race.",
    checkFirst: [
      "Confirm beta is applied on the read path, not only stored in configuration.",
      "Check the distribution of remaining TTL at refresh time.",
      "Check whether keys were warmed together and still share a TTL.",
    ],
  },
  {
    id: "extra-compute",
    metricId: "extra-compute",
    warn: 10,
    crit: 20,
    title: "Early refresh is spending noticeable extra compute",
    cause:
      "A wide beta refreshes values that still had useful life left. The origin does more total work even though its peak is lower.",
    fix: "Lower beta or shorten the TTL so the early window is a smaller fraction of the value's life. Measure peak load and total recomputation together, not peak alone.",
    checkFirst: [
      "Compare total origin queries per minute before and after the beta change.",
      "Check whether beta is larger than the workload needs.",
      "Check whether refreshes are coalesced or each instance recomputes independently.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const probabilisticExpirationModel: SimModel = {
  id: "caching-probabilistic-expiration",
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
      alignedKeys: Math.max(1, num(p, "alignedKeys", 300) * (1 + rng.between(-0.002, 0.002))),
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
    if (c.hardRate > 0 && c.hardShare >= 0.5 && frame.flags.syncRefreshSeen !== 1) {
      pushEvent(next, {
        id: "synchronized-refresh",
        at: frame.t,
        severity: "crit",
        title: "Synchronized refresh wave at the expiry edge",
        detail: `${formatCount(c.hardTotal)} key-instance copies refreshed at once. ${(c.hardShare * 100).toFixed(0)}% of refreshes still wait for expiry.`,
        nodeId: "backend",
        metricId: "backend-qps",
      });
      next.flags.syncRefreshSeen = 1;
    }
    if (c.hardShare < 0.2) next.flags.syncRefreshSeen = 0;
    next.summary = `${formatCount(c.backendQps)} qps at the origin; ${(c.hardShare * 100).toFixed(1)}% of refreshes still hit the expiry edge; ${c.extraCompute.toFixed(1)}% extra recomputation.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p, 0);
    const edge = compute(p, Math.max(0, c.ttl - 0.05));
    const items: string[] = [];
    items.push(
      `${formatCount(c.keys)} keys across ${c.instances} instances produce about ${formatCount(c.total)} refreshes per TTL cycle. beta ${c.beta.toFixed(1)} moves ${(c.earlyShare * 100).toFixed(1)}% of them before the edge over about ${c.spread.toFixed(1)}s.`,
    );
    items.push(
      `At the expiry edge the origin sees about ${formatCount(edge.hardRate)} qps from hard expiries alone. Early refreshes add about ${formatCount(edge.earlyRate)} qps while their window is open.`,
    );
    items.push(
      `Extra recomputation is about ${c.extraCompute.toFixed(1)}% per cycle: the price of refreshing values before their TTL would have forced it.`,
    );
    if (c.beta >= 2.5) {
      items.push(
        "A wide beta lowers the peak but refreshes values that still had a long life. Verify total origin work, not only the peak.",
      );
    }
    if (c.beta < 0.5) {
      items.push(
        "A small beta leaves most refreshes at the edge. It behaves like a normal TTL with a slight early nudge.",
      );
    }
    items.push(
      "XFetch spreads decisions across keys. For one extremely hot key, the earliest request tends to win, so jitter is still the tool that separates instances.",
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
    description:
      "Moderate aligned keys, a 20-second TTL, and beta 1 spread early refresh below capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description:
      "More keys and instances. The wave crosses the warning threshold but not critical.",
    tone: "warn",
    params: defaults({ alignedKeys: 600, instances: 8, ttlSeconds: 10, beta: 1 }),
  },
  {
    id: "failure",
    label: "No early refresh",
    description:
      "Beta 0 leaves every key at the expiry edge. The origin sees the whole wave at once.",
    tone: "crit",
    params: defaults({ alignedKeys: 1_000, instances: 10, ttlSeconds: 15, beta: 0 }),
  },
  {
    id: "recovery",
    label: "Beta 2",
    description:
      "A wider refresh window spreads the wave; peak load falls with a small extra-compute cost.",
    tone: "ok",
    params: defaults({ alignedKeys: 1_000, instances: 10, ttlSeconds: 15, beta: 2 }),
  },
  {
    id: "aggressive",
    label: "Beta 3",
    description:
      "Even earlier refresh lowers peak load but spends more recomputation on values that were still fresh.",
    tone: "warn",
    params: defaults({ alignedKeys: 1_000, instances: 10, ttlSeconds: 15, beta: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-beta-window",
  title: "Predict what beta changes",
  simId: "probabilistic-expiration",
  question:
    "You raise beta from 0 to 2 on 1,000 keys that share a 15-second TTL across 10 instances. What changes at the expiry?",
  prediction: {
    options: [
      {
        id: "spread",
        label:
          "The same refreshes spread before expiry; peak load falls and total work stays close",
      },
      { id: "less-work", label: "Total refresh work falls because fewer keys expire" },
      { id: "later", label: "Every key expires two seconds later" },
      { id: "zero", label: "The cache stops missing entirely" },
    ],
    correctOptionId: "spread",
    explanation:
      "XFetch makes a refresh more likely as the key approaches expiry. Raising beta widens that early window, so some instances refresh before the edge instead of all at once. The number of keys and copies does not change; the work is spread over time and a small amount is repeated early. Total work stays close to one recompute per key-instance per cycle, while peak load falls.",
  },
  setup: defaults({ alignedKeys: 1_000, instances: 10, ttlSeconds: 15, beta: 0 }),
  runFor: 30,
  observe: [
    "Before the fix, backend QPS jumps above 80,000 at the 15-second edge and hard-expiry share is 100%.",
    "With beta 2, refreshes spread across about 2.4 seconds before the edge and peak QPS falls below 6,000.",
    "Hard-expiry share falls to about 2%; most keys are recomputed before they expire.",
    "Extra recomputation rises to about 8% because some values are refreshed while still fresh.",
    "The origin sees roughly one recompute per key-instance per cycle; the extra 8% is the early-refresh cost.",
  ],
  explain:
    "The XFetch test is current time minus delta times beta times the natural log of a random draw, compared with the expiry time. Because minus log of a uniform draw is positive, the test can pass before expiry. Beta scales that head start. The fleet-level wave flattens because keys and instances draw different thresholds; a single very hot key still tends to refresh as soon as its first request crosses the threshold, which is why TTL jitter remains useful.",
  fix: defaults({ alignedKeys: 1_000, instances: 10, ttlSeconds: 15, beta: 2 }),
  debrief:
    "Beta 2 traded a small amount of early recomputation for a much lower peak. It did not remove the need to size the origin, and it did not make the keys refresh at a perfectly uniform rate. The right beta depends on how much early work the origin can absorb and how much freshness the product needs. Measure total recomputation and peak load together; optimizing one can hide a regression in the other.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Probabilistic early expiration refreshes a cached value before its TTL ends, with a probability that rises as expiry approaches. The best-known form is XFetch. On each read, the cache compares the current time minus delta times beta times the natural log of a uniform random draw with the key's expiry time. If the early deadline has passed, the caller recomputes the value and resets the TTL instead of waiting for the hard expiry edge. Beta controls how early the window opens; delta is the time a recompute takes.",
  },
  {
    type: "p",
    text: "The point is to break the synchronized edge. When a batch of keys is warmed together with the same TTL, every instance reaches expiry at the same moment and the origin receives the fleet's refresh work in one burst. Early expiration moves some of those refreshes earlier, so the same total work arrives over a wider window. It is not free: beta larger than the workload needs recomputes values that still had useful life. The trade is peak load against total recomputation.",
  },
  {
    type: "p",
    text: "XFetch is probabilistic per read, not a scheduled job. That matters for a single extremely hot key: many requests per second mean the first request to cross the threshold usually wins, so all instances can still refresh at nearly the same early time. TTL jitter or per-instance randomization is still needed to separate the fleet. XFetch works best on a population of keys with independent draws and on values whose recompute time is short relative to the TTL.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The read path is client, app instance, cache copy, origin. Each instance holds its own copy of each key and runs its own early-expiration test. The origin sees the union of those decisions. Request coalescing acts at the moment of a miss; TTL jitter changes the expiry timestamp; early expiration changes the decision to refresh before the timestamp. They solve overlapping but different parts of the problem.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      [
        "Early expiration (XFetch)",
        "Moves some refreshes before the expiry edge",
        "Extra recomputation when beta is wide",
      ],
      [
        "TTL jitter",
        "Spreads expiry timestamps across the fleet",
        "Bounds the peak but does not reduce total work",
      ],
      [
        "Request coalescing",
        "Collapses concurrent misses into one fetch",
        "Waiter latency and a timeout/error path",
      ],
      [
        "Larger origin",
        "Absorbs the peak without changing its shape",
        "Expensive, and leaves the synchronized edge in place",
      ],
    ],
  },
  {
    type: "p",
    text: "The model uses an illustrative 9,000 queries-per-second origin, 120 ms recompute time, and a fleet that shares TTLs. These are teaching values, not Redis or database limits. The early-refresh window and the hard-expiry share are fleet-level approximations, not a guarantee of any client library or a precise XFetch distribution.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Backend QPS at the expiry edge and during the early-refresh window.",
      "The share of key-instance copies that still reach a hard expiry.",
      "The extra recomputation percentage compared with one refresh per key per cycle.",
      "The refresh window in seconds, which grows with beta and recompute time.",
      "Node state for the cache fleet and origin, with warning and critical markers.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the small wave. Apply No early refresh to see the hard edge, then raise beta and watch the peak fall while extra recomputation rises. Compare Beta 2 with Beta 3: the second lowers the peak further but spends more total work. Run the guided experiment before the debrief.",
  },
  {
    type: "p",
    text: "Read the peak and the total together. A beta that makes the graph look calm while doubling origin queries has moved the incident, not removed it.",
  },
  { type: "sim", simId: "probabilistic-expiration" },
  { type: "experiment", experimentId: "predict-beta-window" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The keys shared a TTL, so their expiry arrived together. With beta 0, every instance waited for the edge and recomputed its copy in the same short window. The origin saw the whole fleet's refresh work at once, and backend QPS crossed its capacity. Raising beta moved some refreshes earlier, so the same work arrived over a wider window and the peak fell.",
  },
  {
    type: "p",
    text: "The model also charged for the change. Early refreshes brought work forward, so total recomputation rose above one refresh per key-instance per cycle. At beta 3 the peak was lowest, but the extra work was larger. The recovery preset kept both peak and extra work under their warning thresholds, which is the trade a production setting has to make explicitly.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Origin QPS spikes aligned with the TTL of a warmed key batch, not with a traffic surge.",
      "A distribution of remaining TTL at refresh time: with beta 0 it clusters at zero; with early refresh it spreads before zero.",
      "Per-instance refresh counters and the beta value actually applied, which is often different from the intended config.",
      "Cache hit rate that stays high on average while the miss burst still reaches the origin.",
      "Total origin queries per minute, which reveals extra recomputation that a peak-only dashboard hides.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the spike follows a TTL edge and a batch warmup. Check that beta is applied on the read path, that all instances use the same TTL, and that coalescing is not missing at the moment of the hard miss.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Align origin spikes with key TTLs and warmup times before changing capacity.",
      "Add TTL jitter so a batch does not share one expiry timestamp.",
      "Enable early expiration with a beta the origin can afford, and measure total recomputation.",
      "Keep request coalescing for the hard misses that remain; early refresh does not remove them all.",
      "For a single hot key, add per-instance jitter because the earliest request can still win the race.",
      "Load-test the batch expiry at peak and verify peak QPS, total queries, and p99 together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A wider beta lowers the peak but refreshes values that were still fresh, raising total origin work.",
      "A narrower beta protects compute but leaves a sharper edge and a higher peak.",
      "Early refresh does not replace TTL jitter for a single extremely hot key or a fleet with synchronized clocks.",
      "It does not replace coalescing: concurrent hard misses still need to be collapsed.",
      "A shorter TTL makes the early window a smaller fraction of the value's life but increases the refresh rate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-xfetch",
    question:
      "Explain XFetch and what beta controls. Why does it reduce a synchronized expiry wave?",
    difficulty: 3,
    hints: [
      "The test compares an early-refresh deadline with the expiry time.",
      "Beta scales the recompute time in that deadline.",
    ],
    answer:
      "XFetch evaluates a probabilistic early-expiration test on each read. It takes the current time, subtracts delta times beta times the natural log of a uniform random draw, and compares the result with the key's expiry time. Since minus log of a uniform draw is positive, the test can pass before expiry, and it becomes more likely as expiry approaches. Beta scales how far ahead that window opens; delta is the recompute time. Across a population of keys, independent draws spread refreshes before the edge instead of letting them all land at once. It does not reduce the number of keys or guarantee one refresh per key, and a very hot key can still refresh at nearly the same time on every instance because the earliest request wins.",
    followUps: [
      "What happens as beta approaches zero?",
      "Why is delta part of the formula?",
      "How would you choose beta for a key with a 10 ms recompute time?",
    ],
    redFlags: [
      "Describes XFetch as a scheduled background job.",
      "Claims it removes all duplicate refreshes.",
      "Ignores the extra recomputation cost.",
    ],
    rubric: [
      "States the early-expiration test and the role of beta.",
      "Explains why probability rises near expiry.",
      "Spreads refreshes across a key population.",
      "Names a limitation and the cost.",
    ],
  },
  {
    id: "choose-beta",
    question: "How do you choose beta for a production cache?",
    difficulty: 3,
    hints: [
      "Start from origin headroom and the recompute time.",
      "Measure peak and total work, not one or the other.",
    ],
    answer:
      "I would start from the origin's headroom and the value's recompute time. A larger beta widens the early window and lowers the peak, but it refreshes more values that still had useful life, so total origin work rises. I would measure the current peak, the total queries per cycle, and the extra recomputation at two or three beta values under a realistic batch expiry. I would also check whether the key population is large and independently accessed, because a single very hot key may not spread at all. Then I would pick the smallest beta that keeps the peak under capacity with an acceptable extra-work budget, and pair it with jitter and coalescing.",
    followUps: [
      "What would make you lower beta after a deploy?",
      "How does a shorter TTL change the choice?",
      "Which metric would you alert on?",
    ],
    redFlags: [
      "Picks beta from a blog default without measuring.",
      "Optimizes peak load while ignoring total work.",
      "Assumes early refresh replaces coalescing.",
    ],
    rubric: [
      "Ties beta to origin headroom and recompute time.",
      "Measures both peak and total work.",
      "Accounts for key access distribution.",
      "Combines the control with jitter or coalescing.",
    ],
  },
  {
    id: "xfetch-limits",
    question: "When does probabilistic early expiration fail to prevent a stampede?",
    difficulty: 4,
    hints: [
      "Think about request rate, synchronized clocks, and the moment of a hard miss.",
      "Early refresh is a timing control, not a concurrency control.",
    ],
    answer:
      "It fails when the key is so hot that the first request in the early window wins on every instance, so the refreshes still cluster. It fails when all instances share a clock and the same TTL, because their draws may be independent but the window is still narrow relative to the request rate. It does not collapse concurrent hard misses: if a value is absent or a refresh fails, every caller can still fetch. It also fails when beta is set wide enough to cause extra recomputation that saturates the origin, which is a stampede created by the mitigation. The fix is layered: jitter the TTL, coalesce misses, bound refresh failures, and watch total work.",
    followUps: [
      "How would you detect that early refresh is not spreading?",
      "What is the interaction with stale-while-revalidate?",
      "Would you apply XFetch to every key?",
    ],
    redFlags: [
      "Treats XFetch as a lock.",
      "Assumes independent draws guarantee spread.",
      "Ignores refresh failures and absent keys.",
    ],
    rubric: [
      "Names the hot-key race.",
      "Separates timing from concurrency control.",
      "Mentions clock and TTL alignment.",
      "Combines controls and measures the cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Batch warmups and bulk loads add jitter instead of writing one TTL for every key.",
      "Beta is set per workload and recorded next to the TTL.",
      "Dashboards show peak origin QPS and total refreshes per cycle.",
      "Hard misses still have request coalescing and a bounded fallback.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the spike follows a TTL edge, not a traffic increase.",
      "Check whether beta is applied on the read path on every instance.",
      "Raise beta cautiously and watch total origin work, not only the peak.",
      "Keep coalescing enabled for the hard misses that remain.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare peak QPS, extra recomputation, and p99 before and after the beta change.",
      "Verify the TTL distribution and whether keys are still warmed together.",
      "Document the chosen beta and its measured cost.",
      "Add a load test that expires a warmed batch under peak traffic.",
    ],
  },
];

const references = [
  {
    title: "Optimal Probabilistic Cache Stampede Prevention",
    url: "https://www.vldb.org/pvldb/vol8/p886-vattani.pdf",
    publisher: "PVLDB",
    kind: "docs" as const,
    note: "The XFetch paper: probabilistic early expiration and the beta parameter.",
  },
  {
    title: "Redis cache-aside",
    url: "https://redis.io/docs/latest/develop/use-cases/cache-aside",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Cache-aside reads, TTLs, and stampede suppression.",
  },
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "TTL side effects, thundering herd, and cache-aside guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "probabilistic-expiration": {
      model: probabilisticExpirationModel,
      presets,
      instructions:
        "Mechanic: Cache expiry with algorithm switch; refresh load and miss rate. Start Healthy, then apply No early refresh to see the hard edge. Raise beta and compare peak origin QPS with extra recomputation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Origin capacity is 9,000 QPS and recompute time is 120 ms. The refresh window is a fleet-level approximation of XFetch, not a Redis guarantee. The break condition is all instances expiring and refreshing at the same instant; recovery spreads refreshes with beta and keeps coalescing for hard misses.",
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
    "caching-warming",
  ],
};
