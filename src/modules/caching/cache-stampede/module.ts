import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DB_CAPACITY = 6_000;
const RECOMPUTE_SECONDS = 0.12;
const BASE_QPS = 30;
const APP_CAPACITY = 60_000;

const params = [
  {
    id: "readRps",
    label: "Hot-key read rate",
    min: 500,
    max: 60_000,
    step: 500,
    value: 6_000,
    unit: " rps",
    group: "Traffic",
    help: "Reads per second for the one popular key. This is the load the local cache normally absorbs.",
    format: "rps" as const,
  },
  {
    id: "appInstances",
    label: "App instances",
    min: 2,
    max: 40,
    step: 1,
    value: 8,
    unit: "",
    group: "Traffic",
    help: "Processes with their own local cache, TTL clock, and in-flight request set.",
    format: "count" as const,
  },
  {
    id: "ttlSeconds",
    label: "Cache TTL",
    min: 5,
    max: 300,
    step: 5,
    value: 60,
    unit: "s",
    group: "Expiry",
    help: "Freshness bound for each instance's local copy. A shorter TTL expires more often; it does not make the wave smaller.",
    format: "number" as const,
  },
  {
    id: "ttlJitter",
    label: "TTL jitter",
    min: 0,
    max: 100,
    step: 5,
    value: 30,
    unit: "%",
    group: "Expiry",
    help: "Spread each instance's local expiry inside the TTL window. Zero means every instance expires together.",
    format: "percent" as const,
  },
  {
    id: "singleFlight",
    label: "Single-flight coverage",
    min: 0,
    max: 100,
    step: 10,
    value: 60,
    unit: "%",
    group: "Mitigations",
    help: "Share of instances that collapse concurrent misses for this key into one in-flight fetch.",
    format: "percent" as const,
  },
  {
    id: "earlyRefresh",
    label: "Early refresh coverage",
    min: 0,
    max: 100,
    step: 10,
    value: 0,
    unit: "%",
    group: "Mitigations",
    help: "Share of instances that recompute before expiry instead of waiting for a miss.",
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

interface Demand {
  readRps: number;
  instances: number;
  ttl: number;
  jitter: number;
  coverage: number;
  early: number;
  burst: number;
  wave: number;
  instant: number;
  backgroundQps: number;
  wavesPerMinute: number;
}

function demand(p: Params, t: number): Demand {
  const readRps = Math.max(1, num(p, "readRps", 6_000));
  const instances = Math.max(2, Math.round(num(p, "appInstances", 8)));
  const ttl = Math.max(5, num(p, "ttlSeconds", 60));
  const jitter = pct(p, "ttlJitter", 30);
  const coverage = pct(p, "singleFlight", 60);
  const early = pct(p, "earlyRefresh", 0);
  const perInstanceRps = readRps / instances;
  const herdShare = 1 - early;
  const queriesPerInstance = coverage + (1 - coverage) * perInstanceRps * RECOMPUTE_SECONDS;
  // Total duplicate work per TTL is invariant under jitter.
  const burst = instances * herdShare * queriesPerInstance;
  const perInstancePeakQps = queriesPerInstance / RECOMPUTE_SECONDS;
  // Start just before the first expiry so the wave is visible.
  const startOffset = Math.max(0, ttl - 5);
  let waveSum = 0;
  for (let index = 0; index < instances; index++) {
    const offset = (index / instances) * jitter * ttl;
    const age = ((t + startOffset - offset) % ttl + ttl) % ttl;
    waveSum += Math.exp(-age / RECOMPUTE_SECONDS);
  }
  const wave = waveSum / instances;
  const backgroundQps = (instances * early) / ttl;
  const instant = BASE_QPS + backgroundQps + perInstancePeakQps * herdShare * waveSum;
  return {
    readRps,
    instances,
    ttl,
    jitter,
    coverage,
    early,
    burst,
    wave,
    instant,
    backgroundQps,
    wavesPerMinute: (instances / ttl) * 60,
  };
}

function dbHealth(cpu: number, errors: number): "ok" | "warn" | "crit" {
  if (cpu >= 90 || errors >= 5) return "crit";
  if (cpu >= 75 || errors >= 1) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number, t: number, load: number): SimFrame {
  const d = demand(p, t);
  const overload = load / DB_CAPACITY;
  const cpu = Math.min(100, overload * 100);
  const p99 = overload <= 1 ? 8 + 32 * overload ** 4 : 40 + 380 * Math.log2(overload);
  const errors = overload <= 1 ? 0 : Math.min(40, (overload - 1) * 5);
  const health = dbHealth(cpu, errors);
  const queueDepth = d.burst * d.wave;
  const queueHealth = queueDepth >= 1_200 ? "crit" : queueDepth >= 400 ? "warn" : "ok";
  const appHealth = load > DB_CAPACITY ? "warn" : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(d.readRps)} reads/s`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "App fleet",
        kind: "service",
        health: appHealth,
        utilization: clamp(d.readRps / APP_CAPACITY),
        throughput: d.readRps,
        sublabel: `${d.instances} instances`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Local hot-key cache",
        kind: "cache",
        health: "ok",
        utilization: clamp(1 - d.wave),
        throughput: d.readRps,
        sublabel: d.wave >= 0.25 ? "expired, recomputing" : `TTL ${Math.round(d.ttl)}s`,
        detail:
          "Each app instance owns its own local cache with its own TTL and in-flight fetches. This node shows the fleet's local hit ratio during the current expiry wave.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Primary database",
        kind: "db",
        health,
        utilization: clamp(overload),
        throughput: load,
        sublabel: `${formatCount(load)} qps`,
        detail: `Illustrative teaching capacity is ${formatCount(DB_CAPACITY)} QPS. One TTL contains about ${formatCount(d.burst)} duplicate queries across the fleet; ${formatCount(queueDepth)} are waiting now.`,
        meta: { view: "flow" },
      },
      {
        id: "db-queue",
        label: "Recompute queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(queueDepth / 2_000),
        throughput: queueDepth,
        sublabel: "identical fetches",
        meta: { view: "queue" },
      },
      {
        id: "db-worker",
        label: "Primary database",
        kind: "worker",
        health,
        utilization: clamp(cpu / 100),
        throughput: load,
        sublabel: `${formatCount(load)} qps`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", d.readRps / APP_CAPACITY),
      edge("app-cache", "app", "cache", 1, "ok"),
      edge("app-db", "app", "db", clamp(d.wave * (1 - d.coverage * 0.95)), health),
      edge("app-queue", "app", "db-queue", clamp(queueDepth / 2_000), queueHealth),
      edge("queue-db", "db-queue", "db-worker", clamp(queueDepth / 2_000), queueHealth),
    ],
    metrics: [
      metric("db-qps", "Database QPS", load, " rps", 4_000, 6_000, "rps"),
      metric("db-cpu", "Database CPU", cpu, "%", 75, 90, "percent"),
      metric("db-p99", "Database p99", p99, "ms", 250, 800, "ms"),
      metric("db-errors", "Database errors", errors, "%", 1, 5, "percent"),
      metric("miss-burst", "Duplicate queries per TTL", d.burst, "", 400, 1_200, "rps"),
      metric("expiry-events", "Expiry events", d.wavesPerMinute, "/min", undefined, undefined, "number"),
      metric("queueDepth", "Waiting recomputes", queueDepth, " queries", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${formatCount(load)} qps at the database; duplicate fetches ${formatCount(d.burst)} per TTL; ${formatCount(queueDepth)} waiting now; ${errors.toFixed(0)}% errors.`,
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
    warn: 4_000,
    crit: 6_000,
    title: "Local expiry pushed the database above capacity",
    cause:
      "Concurrent local misses for the same hot key recomputed the value. The database sees the requests that the local caches normally absorb, all inside the recompute window.",
    fix:
      "Collapse the wave before adding database capacity. Single-flight reduces duplicate work, jitter spreads expiry, and early refresh moves the recompute off the request path.",
    checkFirst: [
      "Align the database QPS spike with the local cache expiry for the hot key.",
      "Sample the database queries: are many identical reads for the same key running at once?",
      "Check whether TTLs were written together, for example by a warmup or deploy.",
    ],
  },
  {
    id: "db-cpu",
    metricId: "db-cpu",
    warn: 75,
    crit: 90,
    title: "Database CPU saturated during the miss wave",
    cause:
      "The database is doing duplicate work and queueing it. CPU follows the wave, not the average request rate.",
    fix:
      "Reduce concurrent recomputation and keep a bounded fallback. Adding CPU buys time but leaves the synchronized expiry in place.",
    checkFirst: [
      "Compare CPU with the number of identical queries, not with total request rate.",
      "Check the connection pool and query queue for waits.",
      "Check whether retries are multiplying the wave.",
    ],
  },
  {
    id: "db-p99",
    metricId: "db-p99",
    warn: 250,
    crit: 800,
    title: "Database p99 breached the latency objective",
    cause:
      "Duplicate recomputes queue behind each other. The slow tail is the queue, not one expensive query plan.",
    fix:
      "Coalesce the misses and bound the wait. If waiters must not block, serve a stale value while one fetch completes.",
    checkFirst: [
      "Compare p99 with the local cache miss rate and expiry timestamps.",
      "Check whether the slow queries are the same statement.",
      "Check pool wait and retry volume before blaming the query.",
    ],
  },
  {
    id: "db-errors",
    metricId: "db-errors",
    warn: 1,
    crit: 5,
    title: "Database errors are reaching requests",
    cause:
      "The database is shedding or timing out under the duplicate load, so the local cache miss becomes a user-facing error.",
    fix:
      "Protect the database with coalescing and a bounded fallback. A retry without a budget adds more duplicate work.",
    checkFirst: [
      "Separate database timeouts from application errors.",
      "Check whether the fallback path is bounded and observable.",
      "Confirm the error rate falls when the miss wave ends.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const cacheStampedeModel: SimModel = {
  id: "caching-cache-stampede",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, 0, demand(p, 0).instant);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = demand(p, frame.t);
    const load = Math.max(0, d.instant * (1 + rng.between(-0.005, 0.005)));
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.t, load);
    next.flags = { ...frame.flags, ...next.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (d.burst >= 1_200 && d.wave >= 0.25 && frame.flags.stampedeSeen !== 1) {
      pushEvent(next, {
        id: "stampede-wave",
        at: frame.t,
        severity: "crit",
        title: "Synchronized local expiry detected",
        detail: `${formatCount(d.burst)} duplicate queries are recomputed per TTL. The local caches are expiring together, so the database sees the work in one window.`,
        nodeId: "db",
        metricId: "miss-burst",
      });
      next.flags.stampedeSeen = 1;
    }
    if (d.wave < 0.1) next.flags.stampedeSeen = 0;
    next.summary = `${formatCount(load)} qps at the database; duplicate fetches ${formatCount(d.burst)} per TTL; ${formatCount(d.burst * d.wave)} waiting now; ${((load / DB_CAPACITY) * 100).toFixed(0)}% of capacity.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const d = demand(p, frame.t);
    const load = d.instant;
    const items: string[] = [];
    items.push(
      `One TTL contains about ${formatCount(d.burst)} duplicate queries across the fleet. ${
        d.jitter < 0.01
          ? "At 0% jitter they land together."
          : `At ${Math.round(d.jitter * 100)}% jitter they are spread across roughly ${(d.jitter * d.ttl).toFixed(0)}s of the ${Math.round(d.ttl)}s TTL.`
      } The total does not change.`,
    );
    items.push(
      `A ${Math.round(d.ttl)}s TTL across ${d.instances} instances produces about ${d.wavesPerMinute.toFixed(0)} expiry events per minute. Jitter changes when they land, not how many occur.`,
    );
    items.push(
      `Single-flight covers ${Math.round(d.coverage * 100)}% of instances. Covered instances issue one query per key per expiry; uncovered instances issue up to one per request in the recompute window.`,
    );
    if (d.early > 0) {
      items.push(
        `Early refresh removes ${Math.round(d.early * 100)}% of instances from the expiry path and adds about ${d.backgroundQps.toFixed(1)} background refreshes per second.`,
      );
    }
    items.push(
      `Jitter changes when the ${d.instances} expiries land. It bounds the peak but does not remove the duplicate work.`,
    );
    items.push(`The current database load is ${formatCount(load)} qps.`);
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
    description: "A warm local hot-key cache, modest traffic, and partial single-flight coverage.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High traffic and more instances, still inside the database's teaching capacity.",
    tone: "warn",
    params: defaults({ readRps: 30_000, appInstances: 10, ttlSeconds: 60, ttlJitter: 40, singleFlight: 70 }),
  },
  {
    id: "failure",
    label: "Synchronized expiry",
    description: "All 12 local caches expire together with no single-flight protection.",
    tone: "crit",
    params: defaults({ readRps: 30_000, appInstances: 12, ttlSeconds: 10, ttlJitter: 0, singleFlight: 0 }),
  },
  {
    id: "single-flight",
    label: "Single-flight",
    description: "Collapse concurrent local misses. Each covered instance fetches once; waiters pay the latency.",
    tone: "ok",
    params: defaults({ readRps: 30_000, appInstances: 12, ttlSeconds: 10, ttlJitter: 0, singleFlight: 100 }),
  },
  {
    id: "jitter",
    label: "Add jitter",
    description: "Spread local expiry across the TTL. The peak falls; total work stays the same.",
    tone: "warn",
    params: defaults({ readRps: 30_000, appInstances: 12, ttlSeconds: 10, ttlJitter: 100, singleFlight: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Combine local jitter, per-instance single-flight, and early refresh.",
    tone: "ok",
    params: defaults({
      readRps: 30_000,
      appInstances: 12,
      ttlSeconds: 10,
      ttlJitter: 80,
      singleFlight: 100,
      earlyRefresh: 60,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-jitter-shape",
  title: "Predict what jitter changes",
  simId: "cache-stampede",
  question:
    "You add 80% TTL jitter but leave single-flight off. What happens to the database?",
  prediction: {
    options: [
      { id: "spread", label: "The same recomputes are spread over time; the peak falls, the total does not." },
      { id: "less-work", label: "The total number of recomputes falls because fewer requests miss." },
      { id: "unchanged", label: "The database load is unchanged in both shape and total." },
      { id: "slower", label: "Latency rises because jitter delays every read." },
    ],
    correctOptionId: "spread",
    explanation:
      "Jitter changes when each instance's local copy expires. It does not deduplicate the requests that arrive during a local miss. The same instances still recompute the value, just at different times, so the peak falls while the total work is roughly unchanged. Collapsing duplicate work requires single-flight per instance, or a shared lock if the fleet also uses a shared cache tier.",
  },
  setup: defaults({ readRps: 30_000, appInstances: 12, ttlSeconds: 10, ttlJitter: 80, singleFlight: 0 }),
  runFor: 20,
  observe: [
    "The peak database QPS stays below the 0% jitter case and under the model's 6,000 QPS teaching capacity.",
    "The duplicate-query metric still shows 3,600 recomputes per TTL.",
    "Expiry events remain at 72 per minute; only their timing moves.",
    "Single-flight is off, so every instance still recomputes its own local copy.",
    "The local cache health stays ok; the remaining cost is total database work, not the peak.",
  ],
  explain:
    "Jitter changes when each instance's local copy expires, not how many copies exist. The same 12 instances still recompute, just at staggered times, so the peak falls while the total duplicate work over one TTL stays the same. Single-flight changes the count by letting one fetch serve each instance's concurrent waiters. A shared lock is a separate step only if a shared cache tier holds the value.",
  fix: defaults({
    readRps: 30_000,
    appInstances: 12,
    ttlSeconds: 10,
    ttlJitter: 80,
    singleFlight: 100,
    earlyRefresh: 0,
  }),
  debrief:
    "Jitter alone lowered the peak but left the total work unchanged. Adding single-flight collapses each instance's concurrent waiters into one fetch, so the database sees about one query per instance instead of one per request. The remaining cost is waiter latency and a dependency on the in-flight registry. If waiting is unacceptable, serve a stale value while one refresh runs; that trades freshness for availability.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A local cache-aside read checks the app instance's in-process hot-key cache first, falls back to the database on a local miss, then writes the value back with a time to live (TTL). Each app instance owns its own copy, TTL clock, and in-flight request set. The TTL is a freshness bound: when it reaches zero, the next reader on that instance must recompute. If the key is hot and recomputation is expensive, every request that arrives during that instance's recompute window also misses. Many instances can do this at once. That is a cache stampede, also called a thundering herd.",
  },
  {
    type: "p",
    text: "The stampede is a shape problem, not an average problem. A one-minute local hit rate can be 99% while the database sees a burst several times its capacity for a few hundred milliseconds. If the TTL is short enough, the next local expiry arrives before the queue drains and the burst becomes a sustained outage. The burst is created by concurrency: many instances, each with its own copy and requests in flight, expire at the same moment. Raising database capacity treats the symptom and leaves the synchronized local expiry in place.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, app instance, local hot-key cache, database. Each instance owns its own cache, TTL clock, and in-flight set. Per-instance single-flight collapses misses inside one process; other instances still miss. If the fleet also uses a shared cache tier such as Redis, a distributed lock or shared coalescing key can collapse work there, but it does not merge the per-instance local copies. TTL jitter staggers local expiry. Early refresh moves the recompute before the local expiry edge.",
  },
  {
    type: "compare",
    leftTitle: "Without protection",
    rightTitle: "With per-instance single-flight",
    rows: [
      { label: "Concurrent local misses", left: "Every request in the recompute window runs its own query", right: "One query per instance runs; that instance's other requests wait" },
      { label: "Database work", left: "Duplicates scale with request rate and recompute time", right: "One fetch per instance per expiry, unless a shared tier coalesces further" },
      { label: "Latency", left: "The database queue sets the tail", right: "Waiters pay one recompute per instance, not a queue of recomputes" },
      { label: "Failure mode", left: "The origin saturates during every local expiry", right: "A slow or failed fetch stalls that instance's waiters unless the wait is bounded" },
    ],
  },
  {
    type: "p",
    text: "This module models one hot key in a catalog read path with a per-instance local cache. The database capacity (6,000 queries per second, or QPS), recompute time (120 ms), and per-instance behavior are illustrative teaching values, not ElastiCache or database limits. The lesson is the shape of the wave and the cost of each control.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Database QPS at local expiry, with warning and critical thresholds against the model's capacity.",
      "Database CPU, p99, and error rate, which move together when duplicate work queues.",
      "Duplicate queries per TTL and the number of expiry events per minute.",
      "A queue view of identical fetches waiting at the database, plus the normal request path.",
      "Local cache hit ratio: each instance's copy expires independently, so jitter shows up here first.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Synchronized expiry. Switch to the Queue view to see duplicate fetches pile up. Apply Add jitter first: the peak falls while the total duplicate work and expiry count stay the same. Then apply Single-flight to collapse the remaining per-instance work. Run the guided experiment before the debrief.",
  },
  {
    type: "table",
    headers: ["Control", "What it changes", "What it costs"],
    rows: [
      ["Single-flight", "One in-flight fetch per key per instance serves that instance's concurrent waiters", "Waiters on that instance block; the registry must propagate errors and time out"],
      ["TTL jitter", "Staggers each instance's local expiry", "Bounds the peak but does not reduce total duplicate work"],
      ["Early refresh", "Recomputes before local expiry, off the request path", "Extra background load and a refresh path that must handle failures"],
      ["Larger database", "Adds headroom for the burst", "Expensive, and it hides the synchronized expiry instead of removing it"],
    ],
  },
  {
    type: "p",
    text: "The first question is not which control is best. It is which constraint you can spend: latency, freshness, or compute. Pick the smallest change whose failure mode you can explain, then verify the next bottleneck.",
  },
  { type: "sim", simId: "cache-stampede" },
  { type: "experiment", experimentId: "predict-jitter-shape" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Each instance's local hot-key copy reached its TTL. Every instance that expired at the same moment recomputed the value. The database received thousands of identical queries in one wave, so CPU, p99, and errors rose together. The local caches were healthy and the hit rate was high before and after; they simply missed after expiry, which is why the incident looked like a database problem.",
  },
  {
    type: "p",
    text: "In the model, single-flight changed the number of queries per TTL, jitter changed when each instance's local copy expired, and early refresh removed instances from the expiry path. The recovery preset combined them, and the database load fell below its warning threshold.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Local cache: hit and miss counts per instance, TTL age, in-flight fetches, and single-flight waiters. A healthy local cache still misses at expiry.",
      "If a shared Redis or ElastiCache tier sits behind the local cache, check its per-key misses, `CurrConnections`, and `EngineCPUUtilization` as well; the same stampede shape can appear there.",
      "Database: QPS, CPU, p99, connection-pool wait, and errors. The spike repeats at the local TTL period for the hot key.",
      "Logs: many identical queries or loader calls with the same key, clustered within the recompute window.",
      "Traces: the local cache span is a miss and the database span is slow; the local cache span is fast on either side of the wave.",
      "Application metrics: single-flight waiters, coalesced fetches, stale-serve counts, and the age of the value being served.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Align the database spike with the local TTL for the hot key. Sample the slow queries for duplicates. Check whether a warmup, deploy, or bulk write gave many instances the same local TTL. Only then choose a control.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm a stampede: the database spike is tied to local expiry and the same query is running concurrently for one key.",
      "Add jitter to local TTLs so instances do not expire together. This lowers the peak but not total work.",
      "Protect the database now: add per-instance single-flight for the hot key with a bounded wait and a defined fallback.",
      "If waiters cannot block, serve a stale value while one refresh runs, and make the staleness bound explicit.",
      "Refresh hot keys before local expiry when the background load is acceptable, and monitor the refresh failure path.",
      "Re-run the load at peak and verify database QPS, p99, errors, and single-flight wait time together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Single-flight protects the origin but adds latency for every waiter on that instance and needs a clear timeout, error, and retry story.",
      "Jitter smooths the peak without reducing total work; the same number of per-instance recomputes still occurs.",
      "Early refresh moves work off the request path but adds background load and a refresh path that can fail quietly.",
      "Serving stale data keeps the product available but makes the freshness bound a product decision, not only a cache setting.",
      "A larger database absorbs the burst at the highest cost and leaves the next local expiry unchanged.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-stampede",
    question:
      "Database CPU hits 100% every few minutes while the local cache hit rate is 99%. How do you confirm a cache stampede?",
    difficulty: 3,
    hints: [
      "Look at the periodicity, not only the average.",
      "The database is doing duplicate work; the local caches are not down.",
    ],
    answer:
      "I would align the database spikes with the hot key's local TTL and look for many identical queries in the same short window. I would check per-instance local cache misses or expiry timestamps, sample the slow statements, and compare the number of concurrent loader calls with the number of distinct keys. A stampede is confirmed when one key explains the duplicate work and the spike ends when the local copies are repopulated. I would also check whether a warmup or deploy synchronized local TTLs, and rule out a slow query plan and a genuine traffic increase.",
    followUps: [
      "What if the spikes are not periodic?",
      "Which metric would you put on the incident dashboard first?",
      "How would a shared Redis tier change the diagnosis?",
    ],
    redFlags: [
      "Adds database capacity before checking the query duplication.",
      "Treats a high local hit rate as proof that no instance is missing.",
      "Ignores the TTL period and the warmup history.",
    ],
    rubric: [
      "Names local-expiry-aligned evidence.",
      "Distinguishes duplicate work from aggregate load.",
      "Checks warmups and per-instance TTLs.",
      "States what would falsify the hypothesis.",
    ],
  },
  {
    id: "choose-control",
    question:
      "You can add single-flight, TTL jitter, or early refresh. How do you choose under incident pressure?",
    difficulty: 3,
    hints: [
      "Start with what the request path can tolerate.",
      "Rank by time to mitigate, then by the new failure mode.",
    ],
    answer:
      "I would add jitter to the local TTLs first: it is the cheapest, lowest-blast-radius step and stops instances from expiring together. It lowers the peak but not the total work. If the database is already saturated, I would add per-instance single-flight immediately to collapse duplicate work; waiters block, so I need a bounded wait, a stale fallback, and a clear error path. Early refresh is strongest for a known hot key, but adds background load and a refresh path that must be monitored. I would combine them in that order and verify the next bottleneck.",
    followUps: [
      "When would you choose stale-while-revalidate over waiting?",
      "How do you roll out single-flight without a flag day?",
      "What would make you add database capacity anyway?",
    ],
    redFlags: [
      "Treats the three controls as interchangeable.",
      "Adds single-flight without a timeout or error path.",
      "Adds jitter and claims it reduces total work.",
    ],
    rubric: [
      "Ties the choice to a latency or freshness budget.",
      "Names time to mitigate and blast radius.",
      "Explains the next bottleneck.",
      "Describes a rollback or fallback.",
    ],
  },
  {
    id: "single-flight-correctness",
    question:
      "How do you implement single-flight for a hot key without turning a slow database into a stalled request path?",
    difficulty: 4,
    hints: [
      "One in-flight result must be shared by every waiter.",
      "The wait needs a bound and the fetch needs an owner.",
    ],
    answer:
      "I would keep a per-key in-flight entry with a shared promise or result, so the first caller owns the fetch and later callers attach to it. The entry needs a timeout longer than the worst-case fetch, but the request path also needs its own deadline. On timeout or failure, waiters get a defined outcome: a stale value if the product allows it, or a clear error. I would release the entry in a finally block, avoid holding a distributed lock for the whole request, and emit metrics for waiters, coalesced fetches, and fetch failures. For per-instance local caches, one in-flight fetch per instance is the expected floor; a process-local map is enough. If the fleet also shares a Redis tier, use a distributed lock or shared coalescing key there, because a local map cannot collapse that tier's misses.",
    followUps: [
      "What happens if the owner crashes mid-fetch?",
      "How do you prevent a thundering herd when the lock expires?",
      "Would you coalesce errors as well as successful values?",
    ],
    redFlags: [
      "Lets every waiter hold a lock for the whole fetch.",
      "Has no timeout or error propagation.",
      "Assumes a process-local map collapses the whole fleet's misses.",
    ],
    rubric: [
      "Shares one in-flight result per instance or shared tier.",
      "Bounds the wait and defines the fallback.",
      "Releases the entry on every path.",
      "Measures waiters and failures.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every hot key cached locally has a documented TTL and a freshness budget.",
      "TTL writers add jitter, including warmups, deploys, and bulk loads.",
      "Each instance has single-flight or request coalescing for expensive local keys.",
      "A bounded stale fallback exists for reads that cannot wait.",
      "Dashboards show per-instance local misses, duplicate queries, and single-flight waiters.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the local-expiry-aligned spike before changing database capacity.",
      "Protect the database with per-instance coalescing and a bounded wait.",
      "Check whether retries or a cold cache are multiplying the wave.",
      "Watch the next bottleneck: connection pool, replica lag, or app latency.",
      "Record the timeline and the mitigation's observed effect.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify database QPS, p99, errors, and waiter latency at peak.",
      "Remove temporary bypasses and reconcile TTLs.",
      "Document the freshness tradeoff that remains in production.",
      "Add a load test that expires the hot key under peak traffic.",
    ],
  },
];

const references = [
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Thundering herd, TTL side effects, and cache-aside guidance.",
  },
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies",
    publisher: "Amazon Builders' Library",
    kind: "docs" as const,
    note: "Request coalescing and the risks of a cold or expiring cache.",
  },
  {
    title: "Redis cache-aside",
    url: "https://redis.io/docs/latest/develop/use-cases/cache-aside",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Cache-aside reads, single-flight locks, and stampede suppression.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cache-stampede": {
      model: cacheStampedeModel,
      presets,
      instructions:
        "Start healthy, apply Synchronized expiry, then compare Add jitter and Single-flight. Watch duplicate queries per TTL and the Queue view, not only CPU.",
      experimentIds: [experiment.id],
      alternateVisuals: ["queue"],
      note: "Illustrative model. Database capacity is 6,000 QPS, recompute time is 120 ms, and each app instance owns a local cache with its own TTL. These are not ElastiCache or database guarantees. Jitter is modeled by staggering per-instance expiry offsets while total recompute work stays constant.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-request-coalescing",
    "caching-probabilistic-expiration",
    "caching-ttl-jitter",
    "caching-warming",
  ],
};
