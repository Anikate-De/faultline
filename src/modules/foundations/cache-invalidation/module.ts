import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INSTANCE_COUNT = 8;
const MAX_STALENESS_SECONDS = 600;
const READ_RPS = 2_000;

const params = [
  {
    id: "mode",
    label: "Invalidation mode",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "Zero is TTL expiry only. One is pub/sub delete. Two is versioned keys with a shared version lookup.",
    format: "count" as const,
  },
  {
    id: "writeRps",
    label: "Update rate",
    min: 1,
    max: 200,
    step: 1,
    value: 30,
    unit: " updates/s",
    group: "Workload",
    help: "Writes per second that change a cached value. Higher write rates make every second of staleness more expensive.",
    format: "rps" as const,
  },
  {
    id: "ttlSeconds",
    label: "Cache TTL",
    min: 5,
    max: 600,
    step: 5,
    value: 60,
    unit: " s",
    group: "Policy",
    help: "Time before an entry expires on its own. It is also the worst-case stale window when an invalidation is missed.",
    format: "number" as const,
  },
  {
    id: "delivery",
    label: "Pub/sub delivery",
    min: 90,
    max: 100,
    step: 0.1,
    value: 99.9,
    unit: "%",
    group: "Failure",
    help: "Share of invalidation messages that reach every instance. A missed message leaves that instance stale until the TTL.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function modeName(mode: number): string {
  if (mode === 1) return "Pub/sub delete";
  if (mode === 2) return "Versioned keys";
  return "TTL only";
}

interface Computed {
  mode: number;
  writeRps: number;
  ttl: number;
  delivery: number;
  missRate: number;
  staleWindow: number;
  staleKeys: number;
  missedInvalidations: number;
  readP99: number;
  hitRate: number;
  messages: number;
  coherence: number;
}

function compute(p: Params): Computed {
  const mode = Math.round(clamp(num(p, "mode", 0), 0, 2));
  const writeRps = Math.max(1, num(p, "writeRps", 30));
  const ttl = Math.max(5, num(p, "ttlSeconds", 60));
  const delivery = clamp(num(p, "delivery", 99.9), 90, 100);
  const missRate = mode === 1 ? (100 - delivery) / 100 : 0;
  const staleWindow =
    mode === 0 ? ttl : mode === 1 ? (missRate > 0.01 ? ttl : 0.25) : 0.5;
  const staleKeys = Math.min(1_000_000, writeRps * staleWindow);
  return {
    mode,
    writeRps,
    ttl,
    delivery,
    missRate,
    staleWindow: Math.min(MAX_STALENESS_SECONDS, staleWindow),
    staleKeys,
    missedInvalidations: writeRps * missRate,
    readP99: mode === 2 ? 4 : mode === 1 ? 2.5 : 2,
    hitRate: mode === 2 ? 92 : mode === 1 ? 94 : 95,
    messages: mode === 1 ? writeRps * (INSTANCE_COUNT - 1) : 0,
    coherence: Math.max(0, 100 - Math.min(100, (staleWindow / ttl) * 100)),
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const staleHealth = healthFor(values.staleWindow, 2, 60);
  const invalidationHealth = healthFor(values.missedInvalidations, 0.1, 1);
  return {
    t: 0,
    nodes: [
      {
        id: "writer",
        label: "Writer instance",
        kind: "service",
        health: "ok",
        throughput: values.writeRps,
        sublabel: `${Math.round(values.writeRps).toLocaleString()} updates/s`,
        meta: { view: "flow" },
      },
      {
        id: "pubsub",
        label: "Invalidation bus",
        kind: "queue",
        health: values.mode === 1 ? invalidationHealth : "ok",
        utilization: values.mode === 1 ? clamp(1 - values.delivery / 100) : 0,
        throughput: values.messages,
        sublabel: values.mode === 1 ? `${values.delivery.toFixed(1)}% delivered` : "not used",
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Shared cache",
        kind: "cache",
        health: staleHealth,
        utilization: clamp(values.hitRate / 100),
        throughput: READ_RPS,
        sublabel: `${Math.round(values.hitRate)}% hit rate`,
        detail: `Stale window ${values.staleWindow.toFixed(1)}s. ${Math.round(values.staleKeys).toLocaleString()} keys written during that window may be stale on some instance.`,
        meta: { view: "flow" },
      },
      {
        id: "reader",
        label: "Reader instances",
        kind: "service",
        health: staleHealth,
        throughput: READ_RPS,
        sublabel: `${INSTANCE_COUNT} instances`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("writer-cache", "writer", "cache", clamp(values.writeRps / 200), "ok"),
      edge("writer-pubsub", "writer", "pubsub", clamp(values.writeRps / 200), values.mode === 1 ? invalidationHealth : "ok"),
      edge("pubsub-reader", "pubsub", "reader", clamp(values.mode === 1 ? values.delivery / 100 : 0), values.mode === 1 ? invalidationHealth : "ok"),
      edge("cache-reader", "cache", "reader", clamp(values.hitRate / 100), staleHealth),
    ],
    metrics: [
      metric("staleness", "Stale window p99", values.staleWindow, "s", 2, 120, "number"),
      metric("stale-keys", "Keys at risk", values.staleKeys, " keys", 100, 5_000, "count"),
      metric("missed-invalidations", "Missed invalidations", values.missedInvalidations, " msg/s", 0.1, 1, "number"),
      metric("read-p99", "Read p99", values.readP99, "ms", 5, 20, "ms"),
      metric("coherence", "Coherence score", values.coherence, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, mode: values.mode },
    summary: `${modeName(values.mode)}: stale window ${values.staleWindow.toFixed(1)}s; ${Math.round(values.staleKeys).toLocaleString()} keys at risk; ${values.missedInvalidations.toFixed(2)} missed invalidations/s.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 6)) / 2.7);
  const seeds: [string, number, number][] = [
    ["staleness", values.staleWindow, 0.1],
    ["stale-keys", values.staleKeys, 2],
    ["missed-invalidations", values.missedInvalidations, 0.02],
    ["read-p99", values.readP99, 0.1],
    ["coherence", values.coherence, 0.2],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "staleness",
    metricId: "staleness",
    warn: 2,
    crit: 120,
    title: "Stale reads outlive the freshness SLO",
    cause:
      "An update reached one instance, but the other instances still hold the previous value. With TTL-only expiry, the stale window is the full TTL. With pub/sub, a missed message leaves one instance stale until the TTL. A single cache is not the problem; the number of copies is.",
    fix:
      "Add an invalidation path that reaches every instance, shorten the TTL to bound a missed message, or move the version into the cache key so a reader cannot use an old value after the version changes.",
    checkFirst: [
      "Compare the update timestamp with the first correct read on each instance.",
      "Check whether the invalidation message was published and delivered.",
      "Check the TTL for the key; it is the worst-case fallback.",
    ],
  },
  {
    id: "stale-keys",
    metricId: "stale-keys",
    warn: 100,
    crit: 5_000,
    title: "A large set of keys can be stale at once",
    cause:
      "The stale window is multiplied by the update rate. A long TTL on a busy key space produces a large window of values that may disagree with the system of record.",
    fix:
      "Reduce the stale window, prioritize invalidation for high-write keys, or use versioned keys so old entries are unreachable rather than merely old.",
    checkFirst: [
      "Identify the keys with the highest write rate.",
      "Check whether one hot key or a broad key space is stale.",
      "Check whether reads can detect an old version without a shared lookup.",
    ],
  },
  {
    id: "missed-invalidations",
    metricId: "missed-invalidations",
    warn: 0.1,
    crit: 1,
    title: "Invalidation messages are being lost",
    cause:
      "Pub/sub is best-effort at the application level: a disconnected subscriber, a restart, or a slow consumer can miss a message. The entry is not invalidated until its TTL expires, so delivery failure becomes a freshness failure.",
    fix:
      "Treat pub/sub as a fast path, not a guarantee. Keep a bounded TTL, reconcile on reconnect, or use a durable log or versioned keys for the authoritative signal.",
    checkFirst: [
      "Check subscriber connection state and reconnect events.",
      "Check publish and receive counts per instance.",
      "Check whether missed messages are detected or silently expire.",
    ],
  },
];

export const cacheInvalidationModel: SimModel = {
  id: "foundations-cache-invalidation",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${modeName(values.mode)}: stale window ${values.staleWindow.toFixed(1)}s; ${Math.round(values.staleKeys).toLocaleString()} keys at risk.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `${modeName(values.mode)} leaves a ${values.staleWindow.toFixed(1)}s stale window at ${Math.round(values.writeRps).toLocaleString()} updates/s, which puts about ${Math.round(values.staleKeys).toLocaleString()} keys at risk.`,
    );
    if (values.mode === 0) {
      items.push(
        `TTL-only expiry does not invalidate on write. Every instance can serve the old value until its own copy expires, so the TTL is the freshness contract whether or not anyone intended it.`,
      );
    }
    if (values.mode === 1) {
      items.push(
        `Pub/sub sends ${Math.round(values.messages).toLocaleString()} messages/s to ${INSTANCE_COUNT - 1} subscribers. At ${values.delivery.toFixed(1)}% delivery, about ${values.missedInvalidations.toFixed(2)} updates/s are missed and wait for the TTL.`,
      );
    }
    if (values.mode === 2) {
      items.push(
        `Versioned keys make old entries unreachable after the version changes. The cost is a shared version lookup on the read path and a key-space migration when the version changes.`,
      );
    }
    items.push(
      `Reads cost ${values.readP99.toFixed(1)}ms p99 and hit ${Math.round(values.hitRate)}%. A coherence fix that doubles read latency is still a product decision.`,
    );
    return items;
  },
  legend: [
    { label: "Fresh", tone: "ok" },
    { label: "Approaching SLO", tone: "warn" },
    { label: "Stale", tone: "crit" },
    { label: "No invalidation", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Pub/sub invalidation with 99.99% delivery and a 60s TTL as the fallback.",
    tone: "ok",
    params: defaults({ mode: 1, writeRps: 20, ttlSeconds: 60, delivery: 99.99 }),
  },
  {
    id: "peak",
    label: "Degraded delivery",
    description: "Delivery falls to 98.5%. More than 1% of updates are missed, so the TTL becomes the stale window.",
    tone: "warn",
    params: defaults({ mode: 1, writeRps: 40, ttlSeconds: 30, delivery: 98.5 }),
  },
  {
    id: "failure",
    label: "TTL only",
    description: "No invalidation path and a five-minute TTL. An update can be invisible to readers for minutes.",
    tone: "crit",
    params: defaults({ mode: 0, writeRps: 50, ttlSeconds: 300, delivery: 99.9 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Versioned keys with a 30s fallback TTL. Old entries are unreachable once the version changes.",
    tone: "ok",
    params: defaults({ mode: 2, writeRps: 50, ttlSeconds: 30, delivery: 99.9 }),
  },
];

const experiment: Experiment = {
  id: "predict-ttl-staleness",
  title: "Predict how long a stale value survives",
  simId: "cache-invalidation",
  question:
    "Two instances use a five-minute TTL and no invalidation on write. An update lands on instance A. How long can instance B serve the old value?",
  prediction: {
    options: [
      { id: "zero", label: "Not at all; the shared cache updates immediately" },
      { id: "instant", label: "Until instance A publishes an invalidation" },
      { id: "ttl", label: "Up to the remaining TTL on instance B's copy" },
      { id: "forever", label: "Forever, because B never sees the write" },
    ],
    correctOptionId: "ttl",
    explanation:
      "Without an invalidation path, instance B has no signal that the value changed. Its copy expires on its own TTL, so the stale window is the remaining TTL, up to five minutes. If the cache is shared rather than local, a delete on write would remove the shared entry, which is why the topology matters.",
  },
  setup: defaults({ mode: 0, writeRps: 50, ttlSeconds: 300, delivery: 99.9 }),
  runFor: 30,
  observe: [
    "The stale window p99 is 300s, exactly the configured TTL.",
    "Keys at risk reach 15,000: 50 updates/s times 300s.",
    "Read p99 stays low, which is why the problem is easy to miss: the reads are fast and wrong.",
    "Versioned keys at the same update rate bring the stale window to about 0.5s without changing the TTL alone.",
  ],
  explain:
    "Invalidation is a coherence problem, not a cache eviction problem. A TTL is a fallback that guarantees eventual expiry, not a signal that a write happened. To make readers observe the change quickly, either notify every copy (pub/sub), make old copies unreachable (versioned keys), or shorten the TTL until the stale window fits the product's contract. Each option has a different failure mode when the notification path breaks.",
  fix: defaults({ mode: 2, writeRps: 50, ttlSeconds: 30, delivery: 99.9 }),
  debrief:
    "Versioned keys remove the missed-message failure: a reader looks up the current version and cannot use an older entry. The cost is a version lookup on the read path and a key-space change on every version bump. A short TTL alone would also bound staleness, but it raises miss rate and database load. The right answer depends on whether the product needs freshness on write or simply a bounded delay.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cache invalidation is the process of making a cached copy stop being used after the authoritative value changes. The difficulty is not deleting one key. It is that the same value may exist in a shared cache, in process memory on several app instances, in a CDN, and in a client. Each copy needs a signal or an expiry, and signals can be missed.",
  },
  {
    type: "p",
    text: "TTL expiry is the simplest policy: a copy is valid for a fixed time, then it is refetched. It bounds staleness without any coordination, but the bound is the TTL. Pub/sub invalidation publishes a delete or update message when a write occurs; every subscriber removes its copy. It is fast when delivery works, but a disconnected or restarted subscriber can miss the message and remain stale until the TTL. Versioned keys put a version in the cache key, so a reader that knows the new version cannot hit an old entry.",
  },
  {
    type: "p",
    text: "The stale-read failure is quiet. Read latency stays low, cache hit rate stays high, and the only wrong signal is the value itself. That is why the freshness contract has to be measured from the write, not inferred from cache health.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The invalidation path sits beside the write path: a service writes the database, then publishes an invalidation or increments a version. App instances subscribe or look up the version. A shared cache needs only one delete, while a local cache needs every instance to receive the signal or to check a version. The topology decides how many copies exist and therefore how many chances there are to miss.",
  },
  {
    type: "diagram",
    id: "cache-invalidation-paths",
    caption: "A write can invalidate a shared cache once, or fan out to every local cache. The local path has more copies and more ways to miss.",
  },
  {
    type: "p",
    text: "This module models eight app instances behind a shared cache, 1–200 updates per second, and a TTL from 5 to 600 seconds. The instance count and delivery rates are illustrative. The lesson is structural: a missed message is not an error the reader sees, it is a delay the reader cannot distinguish from freshness.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Stale window p99: the longest expected delay before a reader observes an update.",
      "Keys at risk: update rate multiplied by the stale window, a proxy for how much data may disagree.",
      "Missed invalidations per second: the delivery failure rate expressed in updates.",
      "Read p99 and hit rate: the cost of the coherence mechanism on the read path.",
      "A coherence score: how much of the TTL budget the current policy consumes.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply TTL only. Compare stale window and keys at risk; the reads remain fast. Run the experiment before revealing the explanation, then apply Degraded delivery and Recovery. Notice that pub/sub and versioned keys fail differently when the signal path is unhealthy.",
  },
  {
    type: "compare",
    leftTitle: "Fast signal",
    rightTitle: "Guaranteed fallback",
    rows: [
      { label: "TTL only", left: "No signal; expiry is the only event", right: "Bounded by TTL, no coordination", },
      { label: "Pub/sub", left: "Delete on write, milliseconds when delivered", right: "Missed message waits for TTL", },
      { label: "Versioned keys", left: "Reader checks the current version", right: "Old entries become unreachable", },
      { label: "Failure question", left: "What happens when the signal is lost?", right: "How long can the old copy survive?", },
    ],
  },
  { type: "sim", simId: "cache-invalidation" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With TTL-only expiry, the update reached the database and the writer's cache, but the other instances had no reason to stop using their copies. The stale window equaled the TTL, and 50 updates per second made 15,000 keys potentially stale. Reads were fast and the cache was healthy, which is exactly why the incident was hard to see.",
  },
  {
    type: "p",
    text: "Pub/sub reduced the window to milliseconds when messages arrived, but delivery was not a guarantee. At 98.5% delivery, more than one percent of updates missed the fast path and fell back to the full TTL. Versioned keys removed the dependency on message delivery: a reader that saw the new version could not use the old entry. The cost moved to a version lookup and a key-space migration.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache metrics: hit rate, miss rate, evictions, and the age of the oldest entry per key class.",
      "Invalidation metrics: published messages, received messages, subscriber reconnects, and delivery lag.",
      "Application logs: updates followed by reads that return the previous value, especially on a different instance.",
      "Database metrics: read qps after a TTL change or a cold cache, which is the cost of shortening freshness.",
      "Product signals: a customer sees their own update disappear after a refresh or a second device shows the old value.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Establish the write time and the read time, then compare the value on each instance. Check whether the invalidation was published and whether every subscriber received it. Check the TTL: it is the worst-case answer when the fast path fails. Then check whether the read is allowed to see an older version at all.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the freshness contract per read path: how old may a value be?",
      "Add an invalidation signal on write for values that need to be fresh immediately.",
      "Keep a bounded TTL as the fallback for a missed or delayed signal.",
      "Make invalidation idempotent and replayable; a delete that arrives twice is harmless.",
      "Reconcile on subscriber reconnect, and alert when delivery lags the write rate.",
      "If the product cannot tolerate a miss, use versioned keys or read from the system of record for that path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short TTL bounds staleness but raises misses and database load; a long TTL protects the database and extends the stale window.",
      "Pub/sub is fast and simple but best-effort. Treating it as a guarantee converts a delivery failure into a silent freshness failure.",
      "Versioned keys remove the missed-message path and add a lookup to every read, plus a migration when the key shape changes.",
      "Invalidating on every write can create a thundering herd on a hot key; coalescing or delaying the refill trades freshness for load.",
      "A local cache reduces latency and multiplies the number of copies that must be invalidated.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stale-read-diagnosis",
    question:
      "A user updates their profile and immediately sees the old name on a second device. The cache hit rate is 96% and read latency is normal. How do you debug it?",
    difficulty: 3,
    hints: [
      "The read is fast and wrong, so latency is not the signal.",
      "Compare the write time, the read time, and the instance that served each.",
    ],
    answer:
      "I would trace one update end to end: the write timestamp, the database commit, the cache delete or update, the publish, and the read that returned the old value. I would check which instance served the read and whether it had a local copy that missed the invalidation. Then I would check the TTL and whether the invalidation message was delivered. If the second device has its own client cache, that is another copy. The fix depends on which copy was stale: a missed message needs a fallback and reconnect reconciliation, a local cache needs a version check, and a long TTL needs a shorter freshness bound.",
    followUps: [
      "How would you reproduce it without a second device?",
      "What if only one instance is stale?",
      "How would you measure the stale window in production?",
    ],
    redFlags: [
      "Blames cache latency because the read is fast.",
      "Clears the cache without finding the missed path.",
      "Assumes a shared cache means one copy.",
    ],
    rubric: [
      "Traces the write and the read separately.",
      "Identifies every copy of the value.",
      "Checks delivery and TTL.",
      "Names a measurable freshness contract.",
    ],
  },
  {
    id: "pubsub-guarantee",
    question:
      "You use Redis pub/sub for invalidation. A subscriber restarts during a deploy and misses messages. What do you change?",
    difficulty: 3,
    hints: [
      "Pub/sub does not retain messages for a disconnected subscriber.",
      "The fallback needs to be bounded and observable.",
    ],
    answer:
      "I would stop treating pub/sub as the durability boundary. A restarted subscriber can reconcile by clearing its local cache on startup and by using a bounded TTL as the fallback. For stronger guarantees I would use a durable stream or log with a consumer position, or versioned keys so the reader checks the current version. I would also alert on subscriber disconnects and on a gap between published and received invalidations. The tradeoff is more infrastructure and read-path work for a freshness guarantee that survives a restart.",
    followUps: [
      "Would you replay every missed invalidation?",
      "How do you avoid clearing the cache on every deploy?",
      "What does a versioned key cost on the read path?",
    ],
    redFlags: [
      "Assumes pub/sub delivers to offline subscribers.",
      "Clears the entire cache on every deploy without load analysis.",
      "Has no way to detect missed messages.",
    ],
    rubric: [
      "Explains pub/sub delivery semantics.",
      "Adds a bounded fallback.",
      "Names a durable or versioned alternative.",
      "Mentions observability and load cost.",
    ],
  },
  {
    id: "invalidation-storm",
    question:
      "A hot key changes 50 times per second. Every write publishes an invalidation, and the cache misses on every read. What is happening, and how do you fix it?",
    difficulty: 4,
    hints: [
      "Invalidation removes the value; the next readers refill it.",
      "A write rate near the read rate makes the cache a pass-through.",
    ],
    answer:
      "The invalidation rate is high enough that the entry is deleted before most reads can use it, so the cache becomes a pass-through and the database absorbs the read load. I would first confirm the key's write rate and the refill rate. Then I would coalesce invalidations, delay the refill slightly, or keep a short-lived local copy with a version check. If the product can tolerate a bounded stale window, a short TTL without immediate delete may be better than invalidating on every write. The tradeoff is explicit: freshness versus database load on a hot key.",
    followUps: [
      "How would you coalesce invalidations without serving stale data?",
      "What if the key is a counter?",
      "When would you bypass the cache entirely?",
    ],
    redFlags: [
      "Adds more cache nodes without changing the invalidation rate.",
      "Invalidates more aggressively.",
      "Ignores the database load.",
    ],
    rubric: [
      "Recognizes the pass-through pattern.",
      "Ties invalidation rate to refill rate.",
      "Proposes coalescing or a versioned approach.",
      "States the freshness tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The freshness contract is written down for each read path.",
      "Every copy of the value is known: shared cache, local cache, CDN, client.",
      "Invalidation is published after the durable write, not before.",
      "A bounded TTL exists as the fallback for a missed signal.",
      "Subscriber disconnects and delivery lag are alerted, not silent.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the write timestamp with the first correct read on each instance.",
      "Check whether the invalidation was published and received.",
      "Check the TTL and the remaining life of the stale entry.",
      "Check for a local cache or client cache that the shared delete cannot reach.",
      "Record which instances served stale values and for how long.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconcile the affected keys against the system of record.",
      "Measure the stale window, not only the cache hit rate.",
      "Review whether pub/sub is being treated as a guarantee.",
      "Load-test reconnect and cold-cache behavior after a deploy.",
    ],
  },
];

const references = [
  {
    title: "Redis pub/sub",
    url: "https://redis.io/docs/latest/develop/interact/pubsub/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Delivery semantics, subscriber disconnects, and the lack of persistence.",
  },
  {
    title: "Client-side caching",
    url: "https://redis.io/docs/latest/develop/clients/client-side-caching/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Tracking and invalidation for local caches.",
  },
  {
    title: "Caching best practices",
    url: "https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "TTLs, invalidation, and cache-aside consistency.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cache-invalidation": {
      model: cacheInvalidationModel,
      presets,
      instructions:
        "Start healthy, then apply TTL only. Compare the stale window with read p99: the reads stay fast. Run the experiment, then apply Degraded delivery and Recovery. The mode control changes the mechanism, not just the number.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Eight instances and the delivery rates are teaching values, not a Redis guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-caching-strategies",
    "caching-aside-vs-write-through",
    "traffic-cdn-cache-keys",
    "caching-hot-key-sharding",
  ],
};
