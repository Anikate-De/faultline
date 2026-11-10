import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const READ_RPS = 20_000;
const TTL_SECONDS = 60;
const REDIS_CAPACITY = 50_000;
const BASE_DB_RPS = 200;
const VERSION_LOOKUP_FACTOR = 0.6;

const params = [
  {
    id: "updatesPerMin",
    label: "Update rate",
    min: 1,
    max: 120,
    step: 1,
    value: 12,
    unit: "/min",
    group: "Writes",
    help: "Keys updated per minute. Each update must reach the shared cache and every local copy.",
    format: "number" as const,
  },
  {
    id: "pubsubLossPct",
    label: "Pub/sub message loss",
    min: 0,
    max: 30,
    step: 0.5,
    value: 0.5,
    unit: "%",
    group: "Invalidation",
    help: "Share of invalidation messages that never reach a subscriber, for example because a task was reconnecting or restarting.",
    format: "percent" as const,
  },
  {
    id: "invalidationDelayMs",
    label: "Invalidation delay",
    min: 10,
    max: 3_000,
    step: 10,
    value: 200,
    unit: "ms",
    group: "Invalidation",
    help: "Typical time for a delivered invalidation to reach every subscriber.",
    format: "ms" as const,
  },
  {
    id: "versionCoveragePct",
    label: "Versioned read coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Coherence",
    help: "Share of reads that check a version token before serving a local copy. This detects a missed invalidation without waiting for TTL.",
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

interface Values {
  updatesPerMin: number;
  loss: number;
  delaySeconds: number;
  coverage: number;
  missedShare: number;
  staleP99: number;
  staleReadPct: number;
  redisOps: number;
  redisUtil: number;
  redisP99: number;
  deliveryPct: number;
  versionLookups: number;
  dbOps: number;
}

function compute(p: Params, noise = 1): Values {
  const updatesPerMin = Math.max(1, num(p, "updatesPerMin", 12));
  const loss = clamp(num(p, "pubsubLossPct", 0.5) / 100);
  const delaySeconds = Math.max(0.01, num(p, "invalidationDelayMs", 200) / 1_000);
  const coverage = clamp(num(p, "versionCoveragePct", 0) / 100);
  const missedShare = loss * (1 - coverage);
  const deliveredStale = delaySeconds + 0.05;
  const versionedStale = 0.05;
  const staleP99 =
    missedShare >= 0.01
      ? TTL_SECONDS
      : coverage * versionedStale + (1 - coverage) * deliveredStale;
  const staleReadPct = missedShare * 100;
  const versionLookups = READ_RPS * coverage * VERSION_LOOKUP_FACTOR;
  const redisOps = (READ_RPS + versionLookups + updatesPerMin / 60) * noise;
  const redisUtil = redisOps / REDIS_CAPACITY;
  const redisP99 =
    redisUtil <= 1 ? 1.2 + 25 * redisUtil ** 6 : 26 + 60 * Math.log2(redisUtil);
  const deliveryPct = (1 - loss) * 100;
  const dbOps = updatesPerMin / 60 + BASE_DB_RPS;

  return {
    updatesPerMin,
    loss,
    delaySeconds,
    coverage,
    missedShare,
    staleP99,
    staleReadPct,
    redisOps,
    redisUtil,
    redisP99,
    deliveryPct,
    versionLookups,
    dbOps,
  };
}

type HealthState = "ok" | "warn" | "crit";

function healthForUtil(util: number): HealthState {
  if (util >= 1) return "crit";
  if (util >= 0.8) return "warn";
  return "ok";
}

function staleHealth(seconds: number): HealthState {
  if (seconds >= 10) return "crit";
  if (seconds >= 2) return "warn";
  return "ok";
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, values: Values, seed: number, t: number): SimFrame {
  const cacheHealth = staleHealth(values.staleP99);
  const redisHealth = healthForUtil(values.redisUtil);
  const busHealth: HealthState = values.missedShare >= 0.01 ? "crit" : "ok";
  const dbHealth = values.dbOps >= 600 ? "warn" : "ok";

  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: "reads + updates",
        meta: { view: "flow" },
      },
      {
        id: "catalog",
        label: "Catalog service",
        kind: "service",
        health: cacheHealth,
        utilization: clamp(values.staleP99 / 10),
        throughput: READ_RPS / 2,
        sublabel: "10 tasks, local cache",
        detail: `Local copies expire after ${TTL_SECONDS}s. A missed invalidation leaves the old value until the TTL backstop.`,
        meta: { view: "flow" },
      },
      {
        id: "pricing",
        label: "Pricing service",
        kind: "service",
        health: cacheHealth,
        utilization: clamp(values.staleP99 / 10),
        throughput: READ_RPS / 2,
        sublabel: "10 tasks, local cache",
        detail: `A second service with the same local-cache pattern. Invalidation must reach both services, not only the writer.`,
        meta: { view: "flow" },
      },
      {
        id: "redis",
        label: "Shared Redis",
        kind: "cache",
        health: redisHealth,
        utilization: clamp(values.redisUtil),
        throughput: values.redisOps,
        capacity: REDIS_CAPACITY,
        sublabel: `${formatCount(values.redisOps)} ops/s`,
        detail: `Holds the shared copy and the version tokens. Illustrative capacity: ${formatCount(REDIS_CAPACITY)} ops/s.`,
        meta: { view: "flow" },
      },
      {
        id: "bus",
        label: "Invalidation bus",
        kind: "stream",
        health: busHealth,
        utilization: clamp(values.missedShare / 0.05),
        throughput: (values.updatesPerMin / 60) * (1 - values.loss),
        sublabel: `${values.deliveryPct.toFixed(1)}% delivered`,
        detail:
          values.coverage >= 0.999
            ? "Redis Pub/Sub is fire-and-forget, but every covered read verifies the shared version, so a missed message does not become a stale serve."
            : "Redis Pub/Sub is fire-and-forget: no persistence, no acknowledgement, and no replay for a subscriber that was disconnected.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Source database",
        kind: "db",
        health: dbHealth,
        utilization: clamp(values.dbOps / 1_000),
        throughput: values.dbOps,
        sublabel: `${formatCount(values.dbOps)} ops/s`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-catalog", "client", "catalog", 0.5),
      edge("client-pricing", "client", "pricing", 0.5),
      edge("catalog-redis", "catalog", "redis", 0.5, redisHealth),
      edge("pricing-redis", "pricing", "redis", 0.5, redisHealth),
      edge("catalog-bus", "catalog", "bus", clamp(values.updatesPerMin / 120), busHealth),
      edge("bus-pricing", "bus", "pricing", clamp(values.deliveryPct / 100), busHealth),
      edge("bus-catalog", "bus", "catalog", clamp(values.deliveryPct / 100), busHealth),
    ],
    metrics: [
      metric("stale-p99", "Stale-read p99", values.staleP99, "s", 2, 10, "number"),
      metric("stale-read-pct", "Stale reads on updated keys", values.staleReadPct, "%", 1, 5, "percent"),
      metric("redis-ops", "Redis operations", values.redisOps, " ops/s", undefined, undefined, "rps"),
      metric("redis-p99", "Redis p99", values.redisP99, "ms", undefined, undefined, "ms"),
      metric("delivery-pct", "Invalidation delivery", values.deliveryPct, "%", undefined, undefined, "percent"),
      metric("version-lookups", "Version lookups", values.versionLookups, " ops/s", undefined, undefined, "rps"),
      metric("invalidation-lag", "Invalidation lag", values.delaySeconds * 1_000, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.deliveryPct.toFixed(1)}% of invalidations delivered; stale p99 ${values.staleP99.toFixed(1)}s; ${values.staleReadPct.toFixed(1)}% of updated-key reads stale; ${formatCount(values.redisOps)} Redis ops/s.`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const entries: [string, number][] = [
    ["stale-p99", values.staleP99],
    ["stale-read-pct", values.staleReadPct],
    ["redis-ops", values.redisOps],
    ["redis-p99", values.redisP99],
    ["delivery-pct", values.deliveryPct],
    ["version-lookups", values.versionLookups],
    ["invalidation-lag", values.delaySeconds * 1_000],
  ];
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 8)) / 2.6);
  for (const [id, value] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * Math.max(0.2, value * 0.01)),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "stale-p99",
    metricId: "stale-p99",
    warn: 2,
    crit: 10,
    title: "A missed invalidation left local copies stale past the SLO",
    cause:
      "The invalidation message never reached a subscriber, so its local copy survived until the TTL. The shared cache may be correct while one service still serves the old value.",
    fix:
      "Make readers verify a version token, use durable delivery with replay, or shorten the TTL as a backstop. Repairing only the publisher leaves disconnected subscribers stale.",
    checkFirst: [
      "Identify which service and task served the stale value.",
      "Check subscriber reconnects and restarts around the update time.",
      "Compare the stale window with the TTL to confirm the message was lost, not delayed.",
    ],
  },
  {
    id: "stale-read-pct",
    metricId: "stale-read-pct",
    warn: 1,
    crit: 5,
    title: "Updated keys are being served stale",
    cause:
      "A share of updates is not reaching every local copy. The product sees old values even though the write succeeded and the shared cache was updated.",
    fix:
      "Add version checks for reads that must be fresh, or move to a durable invalidation stream. Keep a TTL backstop for the cases that still slip through.",
    checkFirst: [
      "Compare the stale reads with update timestamps and the affected key.",
      "Check whether only one service or one task is affected.",
      "Check whether the write path publishes after the database commit.",
    ],
  },
];

export const coherenceModel: SimModel = {
  id: "caching-coherence",
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

    if (values.missedShare >= 0.01 && frame.flags.missedEvent !== 1) {
      pushEvent(next, {
        id: "coherence-missed-invalidation",
        at: frame.t,
        severity: "crit",
        title: "Invalidation messages are being lost",
        detail: `${(values.loss * 100).toFixed(1)}% of messages are lost and ${(values.coverage * 100).toFixed(0)}% of reads verify a version. Stale p99 is ${values.staleP99.toFixed(1)}s.`,
        nodeId: "bus",
        metricId: "stale-p99",
      });
      next.flags.missedEvent = 1;
    }
    if (values.missedShare < 0.005) next.flags.missedEvent = 0;

    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${(values.loss * 100).toFixed(1)}% message loss with ${(values.coverage * 100).toFixed(0)}% version coverage leaves ${(values.missedShare * 100).toFixed(1)}% of updates undetected locally.`,
      `Delivered invalidations settle in about ${(values.delaySeconds * 1000).toFixed(0)}ms. Lost invalidations settle only at the ${TTL_SECONDS}s TTL.`,
      `Stale p99 is ${values.staleP99.toFixed(1)}s. Once more than 1% of updates are missed, the p99 can be the TTL backstop. Full version coverage replaces the delivery delay with the version-check latency.`,
      `Version checks add ${formatCount(values.versionLookups)} Redis operations/s, bringing the total to ${formatCount(values.redisOps)}.`,
      `The shared cache is at ${(values.redisUtil * 100).toFixed(0)}% of its illustrative capacity.`,
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
    description: "Low update volume, 0.5% message loss, and a fast bus.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak updates",
    description: "More writes and a slower bus. Staleness enters the warning band without crossing the SLO.",
    tone: "warn",
    params: defaults({
      updatesPerMin: 40,
      pubsubLossPct: 0.5,
      invalidationDelayMs: 2_500,
      versionCoveragePct: 0,
    }),
  },
  {
    id: "failure",
    label: "Lossy pub/sub",
    description: "15% of invalidation messages are lost. Local copies stay stale until the 60s TTL.",
    tone: "crit",
    params: defaults({
      updatesPerMin: 60,
      pubsubLossPct: 15,
      invalidationDelayMs: 1_500,
      versionCoveragePct: 0,
    }),
  },
  {
    id: "recovery",
    label: "Versioned reads",
    description: "Full version coverage detects missed invalidations; Redis absorbs the extra lookups.",
    tone: "ok",
    params: defaults({
      updatesPerMin: 60,
      pubsubLossPct: 15,
      invalidationDelayMs: 200,
      versionCoveragePct: 100,
    }),
  },
  {
    id: "durable-bus",
    label: "Durable bus",
    description: "A durable stream with replay cuts message loss without adding version lookups.",
    tone: "ok",
    params: defaults({
      updatesPerMin: 60,
      pubsubLossPct: 0.1,
      invalidationDelayMs: 200,
      versionCoveragePct: 0,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-versioned-reads",
  title: "Predict the cost of versioned reads",
  simId: "coherence",
  question:
    "Message loss is 8%. You enable a version check on 100% of reads. What happens to staleness and Redis load?",
  prediction: {
    options: [
      {
        id: "stale-falls-redis-rises",
        label: "Staleness falls to the version-check latency; Redis operations rise.",
      },
      { id: "both-fall", label: "Staleness and Redis operations both fall." },
      { id: "stale-same", label: "Staleness stays at the TTL because messages are still lost." },
      { id: "redis-falls", label: "Staleness falls and Redis operations fall." },
    ],
    correctOptionId: "stale-falls-redis-rises",
    explanation:
      "A version check lets a reader detect that its local copy is older than the shared version, even when the invalidation message was lost. Staleness is then bounded by the version-check latency and refresh, not by the delivery delay or the TTL. The check is an extra shared-cache operation, so Redis load rises with coverage.",
  },
  setup: defaults({
    updatesPerMin: 60,
    pubsubLossPct: 8,
    invalidationDelayMs: 1_500,
    versionCoveragePct: 0,
  }),
  runFor: 20,
  observe: [
    "Stale p99 falls from the 60s TTL to about 0.05s once version checks are on.",
    "Stale reads on updated keys fall from 8% to zero in the model.",
    "Redis operations rise from about 20,000 to about 32,000 per second.",
    "Redis p99 stays low at 100% coverage; the visible cost is the operations line, not the tail.",
    "The bus still loses messages; readers now detect the stale copy instead of trusting delivery.",
  ],
  explain:
    "Versioned reads move the correctness check from the message path to the read path. The publisher can still lose a message, but the reader compares its copy with the shared version and refreshes when they differ. That closes the stale window without a durable subscriber and without waiting for delivery. The cost is an extra lookup per covered read, which is why the Redis line moves.",
  fix: defaults({
    updatesPerMin: 60,
    pubsubLossPct: 8,
    invalidationDelayMs: 1_500,
    versionCoveragePct: 100,
  }),
  debrief:
    "Version coverage fixed the staleness without fixing delivery. That is a useful separation: the bus can remain lossy if every reader can prove its copy is current. If the version lookup itself is cached, the stale window returns, so the token must come from a source that is at least as fresh as the read requirement. A durable bus is the other valid fix, but it adds consumer state and replay cost.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cache coherence means every cache layer agrees with the source within an explicit freshness bound. With a shared Redis tier, a write can delete one key and make every reader see the new value. With a local cache in each task, one delete is not enough: every task holds its own copy and must be told to drop it. An invalidation message is that signal. If the message is delayed, a reader sees the old value for the delay. If it is lost, the reader sees the old value until the time to live (TTL) expires.",
  },
  {
    type: "p",
    text: "Redis Pub/Sub is fast and simple, but it is fire-and-forget. It has no persistence, no acknowledgement, and no replay for a subscriber that was disconnected when the message was published. A task restart, a network blip, or a slow consumer can miss an invalidation. Redis Streams or a log such as Kafka add durable delivery and replay, at the cost of consumer groups, offsets, and retention. Versioned keys take a different route: each read compares a version token with its local copy and refreshes when the token is newer. Versioning does not make delivery reliable; it makes the reader able to detect a missed delivery. TTLs remain the final backstop.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The write path is service, database, shared-cache invalidation, then local-cache invalidation to every task in every service that caches the key. The read path is client, service task, local cache, shared Redis, database. Coherence has to cover both services in this model: the same modeled loss applies to both, and in production an update that reaches the catalog service but not pricing leaves half the product stale. The invalidation bus sits beside the request path and must be observed as its own dependency.",
  },
  {
    type: "compare",
    leftTitle: "Invalidate on write",
    rightTitle: "Update on write",
    rows: [
      {
        label: "What is sent",
        left: "A delete or version bump; the next read reloads",
        right: "The new value, written into every cache",
      },
      {
        label: "Race",
        left: "A concurrent read can repopulate an old value before the delete",
        right: "A concurrent write can leave caches with the older value unless ordered",
      },
      {
        label: "Payload",
        left: "Small; works for any value size",
        right: "Full value; larger messages and more serialization",
      },
      {
        label: "Failure mode",
        left: "A missed delete leaves a stale copy until TTL",
        right: "A missed update leaves a stale copy until the next update or TTL",
      },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Invalidation delivery percentage and lag, separated from request latency.",
      "Stale-read p99 and the share of reads on updated keys that return an old value.",
      "Shared Redis operations and tail latency, including any version lookups.",
      "The stale state is modeled across both services; in production, one missed subscriber can leave a single service stale.",
      "The TTL backstop, which sets the worst-case stale window when delivery fails.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Lossy pub/sub. Notice that the shared cache and the bus can both look healthy while local copies are stale. Apply Versioned reads to close the stale window, and watch Redis operations rise. Compare that with Durable bus, which fixes delivery instead of adding read work.",
  },
  {
    type: "table",
    headers: ["Approach", "Stale window", "Cost", "Failure mode"],
    rows: [
      ["TTL only", "Up to the TTL", "Lowest write-path cost", "Minutes of staleness after every write"],
      ["Pub/sub invalidation", "Delivery delay; TTL if a message is lost", "A bus and subscriber management", "Disconnected subscribers miss messages"],
      ["Durable stream", "Delivery delay plus consumer lag", "Retention, offsets, replay", "Lag and duplicate processing"],
      ["Versioned keys", "Version-check latency", "An extra lookup per covered read", "A stale version source defeats it"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values: 20,000 reads per second, a 60s TTL, and a 50,000 operations per second shared cache. They are not Redis limits. The two decisions that matter are whether to fix delivery or make readers verify, and whether to invalidate or write the new value.",
  },
  { type: "sim", simId: "coherence" },
  { type: "experiment", experimentId: "predict-versioned-reads" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The write path updated the database and the shared cache, but a share of local invalidation messages never arrived. Each affected task kept serving its old copy until the 60s TTL, so the product saw stale data while the shared cache looked correct. The bus was honest about delivery only if you measured it; the request path showed the consequence. Adding version checks made readers compare their copy with the shared version and refresh, which collapsed the stale window without making the bus reliable.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-service and per-task stale reads, with the age of the value served.",
      "Subscriber reconnect and restart events around the first stale read.",
      "Pub/Sub delivery counts if the client exposes them; Redis Pub/Sub itself does not retain a backlog.",
      "Shared Redis correctness and latency, which can be healthy while local copies are stale.",
      "Version lookup rate and Redis operations after enabling versioned reads.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Identify the service and task that served the stale value. Check whether it was connected when the update was published. Compare the stale window with the TTL: a window near the TTL points to a lost message, while a window near the delivery delay points to normal propagation.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the stale value came from a local cache, not the shared cache or the database.",
      "Find the missed invalidation: subscriber restart, network loss, or a publish that happened before the commit.",
      "Choose the fix: durable delivery with replay, or versioned reads that detect a missed message.",
      "Keep the TTL as a bounded backstop and make its value explicit in the freshness contract.",
      "Add a bypass for the affected key while the fix rolls out.",
      "Re-run the update load and check stale p99, Redis operations, and delivery together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Pub/Sub is cheap and fast but lossy; it is a notification, not a guarantee.",
      "A durable stream adds delivery guarantees but also consumer state, lag, and replay cost.",
      "Versioned keys close the stale window but add a lookup to every covered read.",
      "TTL-only coherence is simple but makes the freshness bound equal to the TTL.",
      "A shorter TTL reduces the worst case but raises miss traffic and database load.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-coherence",
    question:
      "Two services cache the same key locally. A write updates one service and the other serves stale data for minutes. How do you design coherence?",
    difficulty: 3,
    hints: [
      "Name every cache layer that holds a copy.",
      "A message that is sent is not a message that is delivered.",
    ],
    answer:
      "I would map the copies first: the database, the shared cache, and the local cache in each task of each service. On write I would commit the database, invalidate the shared key, and publish an invalidation that every service consumes. Because Pub/Sub can lose messages, I would either use a durable stream with replay or add a version token that readers check before serving a local copy. I would keep a TTL as a backstop, define the stale window, and add a bypass for a bad key. Then I would test a subscriber restart during a write, because that is where the loss shows up.",
    followUps: [
      "Would you invalidate or write the new value?",
      "How do you handle a reader that repopulates the old value during the write?",
      "What stale window would you promise?",
    ],
    redFlags: [
      "Assumes Pub/Sub delivery is reliable.",
      "Invalidates only the shared cache.",
      "Uses a TTL as the only coherence mechanism.",
    ],
    rubric: [
      "Maps every cache layer.",
      "Addresses loss and replay.",
      "Defines a stale bound.",
      "Includes a bypass and a test for subscriber restart.",
    ],
  },
  {
    id: "diagnose-loss",
    question:
      "The shared cache is correct, but one service returns old values after a deploy. How do you debug it?",
    difficulty: 3,
    hints: [
      "The request path and the invalidation path are different.",
      "Look at task start time versus update time.",
    ],
    answer:
      "I would confirm the old value is a local-cache hit by checking the value age and the task that served it. Then I would compare the task start time with the update time: a task that started after the publish missed the message and has no local entry, so it should be cold, not stale. If it started before the publish but was reconnecting, it may have missed the invalidation. I would check subscriber reconnect logs, the publish timestamp relative to the database commit, and whether the service publishes to the same channel it subscribes to. The fix is durable delivery or versioned reads, plus a TTL bound.",
    followUps: [
      "What if only one task is stale?",
      "How would versioned keys change the investigation?",
      "How do you prove the publish happened after the commit?",
    ],
    redFlags: [
      "Flushes Redis and expects local copies to clear.",
      "Blames the database before checking the local cache.",
      "Shortens the TTL without fixing delivery.",
    ],
    rubric: [
      "Separates local from shared cache.",
      "Checks task lifecycle and subscriber state.",
      "Verifies commit and publish ordering.",
      "Names a durable or versioned fix.",
    ],
  },
  {
    id: "durable-vs-version",
    question:
      "When would you choose a durable invalidation stream over versioned keys?",
    difficulty: 3,
    hints: [
      "Think about who pays for the check.",
      "Consider replay and audit requirements.",
    ],
    answer:
      "I would choose a durable stream when many consumers need every change, when replay after an outage matters, or when the write volume is low enough that retention and consumer lag are manageable. I would choose versioned keys when reads are simple, the version source is already on the read path, and adding a lookup is cheaper than operating consumer groups. The two can be combined: a durable stream for background consumers and version checks for latency-sensitive reads. In both cases I would keep a TTL backstop and measure the stale window.",
    followUps: [
      "What does replay cost in storage and duplicate processing?",
      "How do you version a key without changing every client?",
      "Which option fails more safely?",
    ],
    redFlags: [
      "Treats the two as interchangeable.",
      "Ignores consumer lag.",
      "Adds version checks without measuring the extra load.",
    ],
    rubric: [
      "Ties the choice to consumer count and replay needs.",
      "Accounts for operational cost.",
      "Keeps a TTL backstop.",
      "Can combine the approaches.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every cache layer and every service that holds a copy is documented.",
      "Invalidation delivery is measured, not assumed, including subscriber restarts.",
      "The stale window has an explicit SLO and a TTL backstop that matches it.",
      "Versioned reads or a durable stream is available for keys that need read-your-writes.",
      "A bypass exists for a bad key and is tested during a deployment.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the service, task, and key serving the stale value.",
      "Check subscriber state and publish order before changing the TTL.",
      "Use the bypass or a forced refresh for the affected key.",
      "Watch shared-cache load if version checks are enabled as a mitigation.",
      "Record which layer was stale and how long the window lasted.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify invalidation delivery and stale p99 at peak update rate.",
      "Reconcile the TTL with the product's freshness contract.",
      "Remove temporary bypasses and confirm all services consume invalidations.",
      "Add a test that restarts a subscriber during a write.",
    ],
  },
];

const references = [
  {
    title: "Redis Pub/Sub",
    url: "https://redis.io/docs/latest/develop/pubsub/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Fire-and-forget delivery semantics and subscriber behavior.",
  },
  {
    title: "Client-side caching",
    url: "https://redis.io/docs/latest/develop/clients/client-side-caching/",
    publisher: "Redis",
    kind: "docs" as const,
    note: "Invalidation of local copies when Redis is the shared tier.",
  },
  {
    title: "Caching best practices",
    url: "https://aws.amazon.com/caching/best-practices/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cache-aside, TTL, and invalidation guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    coherence: {
      model: coherenceModel,
      presets,
      instructions:
        "Start healthy, then apply Lossy pub/sub. Compare Versioned reads with Durable bus: one fixes the reader, the other fixes delivery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Reads are 20,000/s, the TTL is 60s, and shared-cache capacity is 50,000 ops/s. Redis Pub/Sub is modeled as lossy; Redis Streams or Kafka would be the durable alternative.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-local-cache",
    "caching-local-bypass",
    "caching-probabilistic-expiration",
    "caching-ttl-jitter",
  ],
};
