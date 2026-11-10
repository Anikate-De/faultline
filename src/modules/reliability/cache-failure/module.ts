import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_MS = 20;
const QUEUE_LIMIT_SEC = 2;
const SHED_TRIGGER_UTIL = 0.8;

const params: ParamSpec[] = [
  {
    id: "requestRps",
    label: "Read request rate",
    min: 5_000,
    max: 60_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Reads arriving at the service. The cache normally absorbs most of them.",
    format: "rps",
  },
  {
    id: "cacheHitRatePct",
    label: "Cache hit rate",
    min: 0,
    max: 99,
    step: 1,
    value: 90,
    unit: "%",
    group: "Cache",
    help: "Share of reads served by the cache. Zero models a full cache outage.",
    format: "percent",
  },
  {
    id: "originCapacityRps",
    label: "Origin capacity",
    min: 2_000,
    max: 30_000,
    step: 1_000,
    value: 12_000,
    unit: " rps",
    group: "Origin",
    help: "Reads the database or origin can serve while meeting its latency objective.",
    format: "rps",
  },
  {
    id: "shedPct",
    label: "Shed low-value reads",
    min: 0,
    max: 90,
    step: 5,
    value: 0,
    unit: "%",
    group: "Protection",
    help: "Share of origin reads refused when demand exceeds 80% of origin capacity. Shedding starts before the queue fills.",
    format: "percent",
  },
  {
    id: "staleCoveragePct",
    label: "Stale or negative cache coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Protection",
    help: "Share of misses answered from stale data or a negative entry instead of the origin.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  request: number;
  hit: number;
  capacity: number;
  shed: number;
  stale: number;
  cacheServed: number;
  miss: number;
  staleServed: number;
  originDemand: number;
  shedding: boolean;
  shedLoad: number;
  offered: number;
  accepted: number;
  served: number;
  queue: number;
  queueDelay: number;
  utilization: number;
  p99: number;
  errors: number;
  limitRequests: number;
}

function compute(p: Params, previousQueue: number, dt: number): Computed {
  const request = Math.max(0, num(p, "requestRps", 20_000));
  const hit = clamp(num(p, "cacheHitRatePct", 90), 0, 100) / 100;
  const capacity = Math.max(1, num(p, "originCapacityRps", 12_000));
  const shed = clamp(num(p, "shedPct", 0), 0, 100) / 100;
  const stale = clamp(num(p, "staleCoveragePct", 0), 0, 100) / 100;
  const cacheServed = request * hit;
  const miss = request - cacheServed;
  const staleServed = miss * stale;
  const originDemand = miss - staleServed;
  const limitRequests = capacity * QUEUE_LIMIT_SEC;
  const queue = clamp(previousQueue, 0, limitRequests);
  const shedding = originDemand > capacity * SHED_TRIGGER_UTIL;
  const shedLoad = shedding ? originDemand * shed : 0;
  const offered = originDemand - shedLoad;
  const room = Math.max(0, (limitRequests - queue) / Math.max(dt, 0.01));
  const accepted = Math.min(offered, capacity + room);
  const served = Math.min(capacity, queue / Math.max(dt, 0.01) + accepted);
  const queueNext = clamp(queue + (accepted - served) * dt, 0, limitRequests);
  const queueDelay = queueNext / capacity;
  const p99 = Math.min(30_000, BASE_MS + queueDelay * 1_000);
  return {
    request,
    hit,
    capacity,
    shed,
    stale,
    cacheServed,
    miss,
    staleServed,
    originDemand,
    shedding,
    shedLoad,
    offered,
    accepted,
    served,
    queue: queueNext,
    queueDelay,
    utilization: served / capacity,
    p99,
    errors: request > 0 ? ((offered - accepted) / request) * 100 : 0,
    limitRequests,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seedValue: number, t: number): SimFrame {
  const appHealth = healthFor(c.errors, 0.5, 2);
  const cacheHealth: "ok" | "warn" | "down" = c.hit <= 0.01 ? "down" : c.hit < 0.5 ? "warn" : "ok";
  const originHealth: "ok" | "warn" | "crit" =
    c.utilization >= 0.95 || c.p99 >= 800
      ? "crit"
      : c.utilization >= 0.8 || c.p99 >= 300
        ? "warn"
        : "ok";
  const queueHealth = healthFor(c.queueDelay, 0.8, 1.6);
  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Readers",
        kind: "client",
        health: "ok",
        throughput: c.request,
        sublabel: `${Math.round(c.request).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Read service",
        kind: "service",
        health: appHealth,
        utilization: clamp(c.errors / 100),
        throughput: c.request,
        sublabel: `${c.errors.toFixed(1)}% failed reads`,
        detail: `${Math.round(c.hit * 100)}% of reads are served by the cache. ${(c.stale * 100).toFixed(0)}% of misses have a stale or negative response.`,
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "Redis cache",
        kind: "cache",
        health: cacheHealth,
        utilization: clamp(c.hit),
        throughput: c.cacheServed,
        sublabel: cacheHealth === "down" ? "unavailable" : `${Math.round(c.hit * 100)}% hit rate`,
        detail:
          "When the cache is unavailable, every miss becomes origin work. A cache is a load absorber, not a source of truth.",
        meta: { view: "flow" },
      },
      {
        id: "origin-queue",
        label: "Origin queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(c.queue / Math.max(1, c.limitRequests)),
        throughput: c.accepted,
        sublabel: `${Math.round(c.queue).toLocaleString("en-US")} queries waiting`,
        detail: `The queue is bounded at ${Math.round(c.limitRequests).toLocaleString("en-US")} queries, or ${QUEUE_LIMIT_SEC}s of origin work. Shedding starts above ${Math.round(SHED_TRIGGER_UTIL * 100)}% utilization.`,
        meta: { view: "queue" },
      },
      {
        id: "origin",
        label: "Origin database",
        kind: "db",
        health: originHealth,
        utilization: clamp(c.utilization),
        throughput: c.served,
        sublabel: `${Math.round(c.utilization * 100)}% utilized`,
        detail: `Origin demand is ${Math.round(c.originDemand).toLocaleString("en-US")} rps after ${Math.round(c.staleServed).toLocaleString("en-US")} rps of stale responses. Capacity is ${Math.round(c.capacity).toLocaleString("en-US")} rps.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-app", "client", "app", 1, appHealth),
      edge(
        "app-cache",
        "app",
        "cache",
        clamp(c.hit),
        cacheHealth === "down" ? "down" : cacheHealth,
      ),
      edge(
        "app-origin",
        "app",
        "origin-queue",
        clamp(c.offered / Math.max(1, c.capacity)),
        appHealth,
      ),
      edge("queue-origin", "origin-queue", "origin", clamp(c.utilization), originHealth),
    ],
    metrics: [
      metric(
        "origin-utilization",
        "Origin utilization",
        c.utilization * 100,
        "%",
        80,
        95,
        "percent",
      ),
      metric("origin-p99", "Origin p99", c.p99, "ms", 300, 800, "ms"),
      metric("origin-errors", "Origin overflow errors", c.errors, "%", 0.5, 2, "percent"),
      metric("shed-reads", "Shed reads", c.shedLoad, " rps", undefined, undefined, "rps"),
      metric("queueDepth", "Origin queue depth", c.queue, " queries", 5_000, 15_000, "count"),
      metric("cache-hit", "Cache hit rate", c.hit * 100, "%", undefined, undefined, "percent"),
      metric(
        "stale-served",
        "Stale or negative responses",
        c.staleServed,
        " rps",
        undefined,
        undefined,
        "rps",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      queue: c.queue,
      hit: c.hit,
      shedding: c.shedding ? 1 : 0,
    },
    summary: `${Math.round(c.utilization * 100)}% origin utilization; ${c.errors.toFixed(1)}% failed reads; ${Math.round(c.queue).toLocaleString("en-US")} queries waiting.`,
  };
}

function seedSeries(frame: SimFrame, seedValue: number): void {
  const phase = seedValue % 10;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.96 + 0.06 * Math.sin((index + phase) / 3.3))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "origin-utilization",
    metricId: "origin-utilization",
    warn: 80,
    crit: 95,
    title: "The origin is saturated by cache misses",
    cause:
      "The cache stopped absorbing reads, so the origin receives the full read rate. Origin capacity was sized for the miss rate, not for the full traffic.",
    fix: "Reduce origin work before adding capacity: shed low-value reads, serve stale or negative responses, and restore the cache in stages. Adding origin capacity without a load plan usually moves the bottleneck.",
    checkFirst: [
      "Compare origin demand with the cache hit rate.",
      "Check whether the origin queue is growing or draining.",
      "Check whether retries or background jobs are adding to the miss traffic.",
    ],
  },
  {
    id: "origin-p99",
    metricId: "origin-p99",
    warn: 300,
    crit: 800,
    title: "Origin latency is beyond the read deadline",
    cause:
      "Origin work is queueing behind more requests than it can serve. The queue wait adds to every query, so p99 rises before the error rate does.",
    fix: "Bound the origin queue, shed before it fills, and serve stale data where the product allows it. Do not raise the client timeout to hide the queue.",
    checkFirst: [
      "Check origin queue depth and age.",
      "Check whether the slow queries are cache misses or retries.",
      "Check whether the cache is warming or still unavailable.",
    ],
  },
  {
    id: "origin-errors",
    metricId: "origin-errors",
    warn: 0.5,
    crit: 2,
    title: "Cache loss is overflowing the origin",
    cause:
      "After stale responses and any shedding, the origin still receives more reads than it can serve. The cache outage has become a product outage because the misses have no bounded fallback.",
    fix: "Serve a stale or negative response, shed the lowest-value reads, and tell customers what is unavailable. Restore the cache only after the origin is stable.",
    checkFirst: [
      "Check whether failed reads are misses or origin errors.",
      "Check whether the stale or negative path is serving.",
      "Check whether the error rate falls when origin load falls.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-cache-recovery",
  title: "Predict the safe cache recovery",
  simId: "cache-failure",
  question:
    "Redis is down and the origin is at 100% utilization. The cache can be restarted now, but it will start cold. What is the safer recovery plan?",
  prediction: {
    options: [
      { id: "restart", label: "Restart the cache and send all traffic back immediately" },
      { id: "capacity", label: "Add origin capacity and keep the cache offline" },
      {
        id: "stage",
        label:
          "Shed low-value reads, serve stale or negative responses, and ramp traffic as the cache warms",
      },
      { id: "disable", label: "Disable the cache permanently to remove the failure mode" },
    ],
    correctOptionId: "stage",
    explanation:
      "A cold cache is another miss wave. The origin is already saturated, so the recovery must reduce origin work while the cache warms. Shedding and stale responses buy that time; a staged traffic ramp prevents the cache from being hit by the full read rate before it can absorb it.",
  },
  setup: defaults({
    requestRps: 20_000,
    cacheHitRatePct: 0,
    originCapacityRps: 8_000,
    shedPct: 0,
    staleCoveragePct: 0,
  }),
  runFor: 30,
  observe: [
    "Origin overflow errors fall from about 60% to zero.",
    "Origin utilization falls from 100% to about 60%.",
    "Origin queue depth falls from the limit to zero.",
    "Stale or negative responses carry about 14k rps of the read load.",
  ],
  explain:
    "The recovery did not wait for the cache to be healthy. It reduced the origin demand to a level the origin could serve, using stale responses and shedding when needed, then let the cache warm behind that protection. Restarting the cache at full traffic would have sent the same miss wave to an origin that was already failing.",
  fix: defaults({
    requestRps: 20_000,
    cacheHitRatePct: 0,
    originCapacityRps: 10_000,
    shedPct: 0,
    staleCoveragePct: 70,
  }),
  debrief:
    "A cache outage is an origin capacity incident. The cache was sized to absorb most reads, and the origin was sized for the remainder. Losing the cache moves the full read rate onto the origin. The incident plan must protect the origin, define what readers see for a miss, and restore the cache without a second stampede.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A cache failure is an origin capacity incident in disguise. The cache normally absorbs most reads, so the origin is sized for the miss rate, not for the full request rate. When the cache disappears, every miss becomes origin work. If the origin cannot serve that load, the cache outage becomes a product outage.",
  },
  {
    type: "p",
    text: "The dangerous moment is often the recovery, not the initial failure. A restarted cache starts cold, so the first requests are misses. If all traffic returns at once, the origin sees another miss wave while it is still recovering. Load shedding, stale or negative responses, and a staged traffic ramp protect the origin while the cache warms.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The cache sits between the read service and the origin. It is a load absorber and a latency optimization, not a source of truth. The service must know what to do when a key is missing and when the cache is unavailable: fetch from the origin, serve stale data within a bounded age, return a negative response, or refuse the read. That decision belongs to the product, not to the cache client library.",
  },
  {
    type: "table",
    headers: ["Miss response", "Origin work", "Customer effect", "When it fits"],
    rows: [
      ["Read through", "One origin query per miss", "Fresh result", "Origin has headroom"],
      [
        "Serve stale",
        "None until the stale bound expires",
        "Older result, still useful",
        "Product tolerates bounded staleness",
      ],
      [
        "Negative cache",
        "None for known-missing keys",
        "Not found, no retry",
        "Missing keys are common",
      ],
      [
        "Shed low-value reads",
        "None for refused reads",
        "Feature unavailable",
        "Origin is saturated and reads are not equal",
      ],
      [
        "Synchronous rebuild",
        "One rebuild per miss",
        "Slow or failed read",
        "Never at full traffic during an outage",
      ],
    ],
  },
  {
    type: "p",
    text: "This module models 20k reads per second, a cache that absorbs 90% of them, and an illustrative 12k rps origin. The numbers are teaching values. The structure is the lesson: hit rate converts directly into origin load, and origin capacity is a hard boundary.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Origin utilization and p99: whether the origin can serve the miss load.",
      "Failed reads: the customer-visible cost of losing the cache.",
      "Origin queue depth: the backlog that outlives the first miss wave.",
      "Cache hit rate: how much load the cache is absorbing right now.",
      "Stale or negative responses: the work the origin did not have to do.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Cache down. Watch origin utilization, queue depth, and failed reads rise together. Run the experiment before revealing the answer. Then apply Protect the origin and compare the same cache outage with stale responses. Finish with Shed only to see how much protection shedding provides before the origin reaches its limit.",
  },
  { type: "sim", simId: "cache-failure" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With the cache gone, 20k reads per second arrived at an 8k rps origin. The origin queue filled to two seconds of work, p99 passed two seconds, and about 60% of reads failed. The origin was not slow because of a bad query plan; it was slow because the cache had been absorbing most of the work.",
  },
  {
    type: "p",
    text: "Serving 70% of misses from stale or negative entries cut origin demand from 20k rps to 6k rps. Failed reads fell to zero, utilization fell to about 60%, and the queue drained. The cache was still down. The service recovered because the origin was protected, not because the cache came back.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cache hit rate, miss rate, and the origin read rate on the same timeline.",
      "Origin utilization, queue depth, p99, and error rate.",
      "Which keys or read classes dominate the miss load.",
      "Stale and negative response rates, including their error rates.",
      "Cache warmup progress and the traffic ramp after recovery.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare origin demand with origin capacity and with the cache hit rate. If the miss load exceeds capacity, the cache outage is already an origin incident. Check whether the origin queue is growing, whether stale or negative responses are available, and whether low-value reads can be shed. Do not restart the cache at full traffic until the origin has a stable margin.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Quantify the miss load: request rate multiplied by one minus the hit rate.",
      "Protect the origin with a bounded queue and a shed policy for low-value reads.",
      "Serve stale data within a product-approved bound, or a negative response for known-missing keys.",
      "Restore the cache in stages and ramp traffic only as the hit rate recovers.",
      "Verify that origin utilization and queue depth stay inside the margin during warmup.",
      "Fix the cache failure and review why the origin was sized for the miss rate only.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Stale data is cheaper than origin load but can show prices, inventory, or permissions that are no longer true.",
      "Negative caching saves origin work but can hide a key that was created a moment ago.",
      "Shedding low-value reads protects the origin but removes features and needs a customer message.",
      "A cold cache warms faster under high traffic but puts more load on the origin; a slow ramp is safer but prolongs degraded latency.",
      "Adding origin capacity can be the right long-term fix, but it is slower than shedding and does not address the cold-start wave by itself.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "origin-saturation",
    question: "Redis is down and the database immediately saturates. What is your incident plan?",
    difficulty: 3,
    hints: [
      "Start with the miss load, not the cache.",
      "Protect the origin before restoring the cache.",
    ],
    answer:
      "I would calculate the miss load from the request rate and the lost hit rate, then compare it with origin capacity. If the origin is over capacity, I protect it first: bound the queue, shed low-value reads, serve stale or negative responses where the product allows, and stop any background jobs that add origin work. Then I would restore the cache in stages and ramp traffic as the hit rate recovers. Restarting the cache at full traffic would create another miss wave, so the recovery needs the same protection as the initial outage.",
    followUps: [
      "Which reads would you shed first?",
      "How do you decide the stale bound?",
      "What if stale data is not acceptable for any read?",
    ],
    redFlags: [
      "Restarts the cache and sends all traffic back.",
      "Adds origin capacity without a load plan.",
      "Ignores background jobs and retries.",
    ],
    rubric: [
      "Quantifies miss load.",
      "Protects the origin first.",
      "Defines stale or negative behavior.",
      "Stages cache recovery.",
    ],
  },
  {
    id: "stale-data",
    question:
      "The product team says stale data is unacceptable. How do you protect the origin during a cache outage?",
    difficulty: 3,
    hints: [
      "Not every read has the same freshness requirement.",
      "If stale is truly unacceptable, the answer is load reduction, not more origin traffic.",
    ],
    answer:
      "I would challenge the blanket statement and split reads by freshness requirement. Product listings, recommendations, and counts can usually tolerate bounded staleness; prices, inventory, and permissions may not. For reads that cannot be stale, I would shed lower-value traffic, serve a clear unavailable response, and protect the origin queue. If every read truly requires fresh data and the origin cannot serve the miss load, the service cannot meet its promise during a full cache outage; that is a capacity and product decision, not something a cache client can fix.",
    followUps: [
      "How would you classify reads by freshness?",
      "What is a bounded staleness window?",
      "How do you communicate a fresh-only failure?",
    ],
    redFlags: [
      "Accepts the blanket requirement without splitting reads.",
      "Serves stale prices as if they were current.",
      "Adds origin capacity as the only answer.",
    ],
    rubric: [
      "Separates reads by freshness.",
      "Uses shedding for fresh-only reads.",
      "Protects the origin.",
      "Escalates the product tradeoff.",
    ],
  },
  {
    id: "cold-start",
    question: "The cache is back but cold. How do you avoid a second outage during warmup?",
    difficulty: 3,
    hints: [
      "A cold cache is another miss wave.",
      "Ramp traffic against the hit rate, not the clock.",
    ],
    answer:
      "I would keep the origin protections in place and ramp traffic only as the hit rate recovers. I would pre-warm the hottest keys if the cache supports it, serve stale or negative responses for the rest, and watch origin utilization and queue depth after each ramp step. I would not switch all traffic back at once, even if the cache process is healthy. The recovery is complete when the hit rate and origin margin are stable, not when the cache reports ready.",
    followUps: [
      "How would you identify the hot keys to pre-warm?",
      "What ramp step would you use?",
      "When do you remove the stale fallback?",
    ],
    redFlags: [
      "Sends all traffic back when the cache starts.",
      "Warms the cache with a full scan.",
      "Removes shedding before the hit rate recovers.",
    ],
    rubric: [
      "Treats cold start as a miss wave.",
      "Pre-warms hot keys.",
      "Ramps against hit rate.",
      "Keeps origin protection.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The origin is sized with an explicit cache-miss assumption.",
      "The service has a defined behavior for a miss and for a cache outage.",
      "Stale and negative response bounds are approved by the product owner.",
      "Low-value reads are ranked and can be shed before the origin queue fills.",
      "Cache hit rate, miss rate, and origin load share one dashboard.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Calculate miss load before changing cache or origin capacity.",
      "Bound the origin queue and shed low-value reads.",
      "Serve stale or negative responses within the approved bounds.",
      "Stop background jobs and retries that add origin work.",
      "Restore the cache in stages and ramp traffic against the hit rate.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that origin utilization and queue depth stayed inside the margin during warmup.",
      "Check whether the stale or negative path returned incorrect data.",
      "Review why the origin was sized only for the miss rate.",
      "Add the cache outage and recovery ramp to the postmortem timeline.",
      "Test a cold-cache recovery in staging or a game day.",
    ],
  },
];

const references = [
  {
    title: "Caching challenges and strategies",
    url: "https://aws.amazon.com/builders-library/caching-challenges-and-strategies/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Cache failure modes, stampedes, and protecting the origin.",
  },
  {
    title: "Cache-Aside pattern",
    url: "https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside",
    publisher: "Microsoft Azure Architecture Center",
    kind: "docs" as const,
    note: "Read-through behavior, stale data, and cache invalidation tradeoffs.",
  },
];

export const cacheFailureModel: SimModel = {
  id: "reliability-cache-failure",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, 0.1);
    const frame = buildFrame(values, seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const previousQueue = Math.max(0, Number(frame.flags.queue ?? 0));
    const values = compute(p, previousQueue, dt);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);
    if (values.hit <= 0.01 && frame.flags.cacheDownEvent !== 1) {
      pushEvent(next, {
        id: "cache-unavailable",
        at: frame.t,
        severity: "crit",
        title: "Cache unavailable",
        detail: `${Math.round(values.miss).toLocaleString("en-US")} rps of reads are now origin work. The origin is at ${Math.round(values.utilization * 100)}% utilization.`,
        nodeId: "cache",
        metricId: "cache-hit",
      });
      next.flags.cacheDownEvent = 1;
    } else if (values.hit > 0.01) {
      next.flags.cacheDownEvent = 0;
    }
    if (
      values.hit <= 0.01 &&
      values.errors < 0.5 &&
      values.utilization < 0.8 &&
      frame.flags.originProtectedEvent !== 1
    ) {
      pushEvent(next, {
        id: "origin-protected",
        at: frame.t,
        severity: "info",
        title: "Origin protected during cache outage",
        detail: `Failed reads are ${values.errors.toFixed(1)}% and origin utilization is ${Math.round(values.utilization * 100)}% while the cache is unavailable.`,
        nodeId: "origin",
        metricId: "origin-errors",
      });
      next.flags.originProtectedEvent = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, Math.max(0, Number(frame.flags.queue ?? 0)), 0.1);
    const items: string[] = [];
    items.push(
      `Reads are ${Math.round(values.request).toLocaleString("en-US")} rps and the cache hit rate is ${Math.round(values.hit * 100)}%. That leaves ${Math.round(values.miss).toLocaleString("en-US")} rps of misses.`,
    );
    items.push(
      `Stale or negative coverage answers ${Math.round(values.staleServed).toLocaleString("en-US")} rps, so origin demand is ${Math.round(values.originDemand).toLocaleString("en-US")} rps against ${Math.round(values.capacity).toLocaleString("en-US")} rps of capacity.`,
    );
    items.push(
      values.shedding
        ? `Shedding is active and removes ${Math.round(values.shedLoad).toLocaleString("en-US")} rps. Failed reads are ${values.errors.toFixed(1)}%.`
        : `Shedding is idle because origin demand is below ${Math.round(SHED_TRIGGER_UTIL * 100)}% of capacity. Failed reads are ${values.errors.toFixed(1)}%.`,
    );
    items.push(
      "A cold cache is another miss wave. The recovery ramp should follow the hit rate, not the cache process health.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Cache down", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "20k reads, a 90% hit rate, and a 12k rps origin. The origin sees 2k rps.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial cache loss",
    description:
      "The hit rate falls to 20%, but stale responses absorb half the misses and keep the origin at a warning.",
    tone: "warn",
    params: defaults({
      cacheHitRatePct: 20,
      originCapacityRps: 10_000,
      shedPct: 0,
      staleCoveragePct: 50,
    }),
  },
  {
    id: "failure",
    label: "Cache down",
    description:
      "A full cache outage, no shedding, and no stale data. Every read becomes origin work.",
    tone: "crit",
    params: defaults({
      cacheHitRatePct: 0,
      originCapacityRps: 8_000,
      shedPct: 0,
      staleCoveragePct: 0,
    }),
  },
  {
    id: "shed-only",
    label: "Shed only",
    description:
      "The cache is down and there is no stale data, but shedding 60% of origin reads keeps the origin at its warning limit.",
    tone: "warn",
    params: defaults({
      cacheHitRatePct: 0,
      originCapacityRps: 10_000,
      shedPct: 60,
      staleCoveragePct: 0,
    }),
  },
  {
    id: "recovery",
    label: "Protect the origin",
    description:
      "The cache is still down, but stale responses absorb 70% of the misses and keep the origin at 60% utilization.",
    tone: "ok",
    params: defaults({
      cacheHitRatePct: 0,
      originCapacityRps: 10_000,
      shedPct: 0,
      staleCoveragePct: 70,
    }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cache-failure": {
      model: cacheFailureModel,
      presets,
      instructions:
        "Start Healthy, apply Cache down, and watch origin utilization, queue depth, and failed reads rise together. Run the experiment, then apply Protect the origin and compare the same outage with stale responses and shedding. Finish with Shed only to see how much protection shedding provides before the origin saturates.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Hit rate, origin capacity, and queue bounds are teaching values, not a vendor limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "caching-cache-stampede",
    "reliability-load-shedding",
    "reliability-dependency-failure",
    "caching-negative-caching",
  ],
};
