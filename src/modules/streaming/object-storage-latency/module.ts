import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { HistogramData, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_READ_RATE = 5_000;
const MAX_LATENCY = 5_000;
const HISTOGRAM_EDGES = [10, 25, 50, 100, 250, 500, 1_000];
const HISTOGRAM_LABELS = ["0-10 ms", "10-25 ms", "25-50 ms", "50-100 ms", "100-250 ms", "250-500 ms", "500-1000 ms", ">1000 ms"];

const params = [
  {
    id: "readRate",
    label: "Read requests",
    min: 100,
    max: 5_000,
    step: 100,
    value: 1_200,
    unit: " req/s",
    group: "Workload",
    help: "Object reads per second from the streaming consumer or an application path.",
    format: "rps" as const,
  },
  {
    id: "objectSizeMB",
    label: "Object size",
    min: 0.5,
    max: 64,
    step: 0.5,
    value: 4,
    unit: " MB",
    group: "Workload",
    help: "Average bytes per object. Larger objects move more data per request but take longer to transfer.",
    format: "number" as const,
  },
  {
    id: "cacheHitRate",
    label: "Cache hit rate",
    min: 0,
    max: 95,
    step: 5,
    value: 70,
    unit: "%",
    group: "Cache",
    help: "Share of reads served from a local or edge cache instead of object storage. Hits avoid the object store but can serve stale data.",
    format: "percent" as const,
  },
  {
    id: "concurrency",
    label: "Read concurrency",
    min: 8,
    max: 256,
    step: 8,
    value: 64,
    unit: "",
    group: "Capacity",
    help: "Concurrent in-flight reads. More concurrency raises capacity and can lower queueing, at the cost of client connections and memory.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rate: number;
  objectSize: number;
  hitRate: number;
  concurrency: number;
  missServiceMs: number;
  capacity: number;
  utilization: number;
  queueMs: number;
  p50: number;
  p99: number;
  originReads: number;
  throughputMBps: number;
}

function compute(p: Params): Computed {
  const rate = Math.max(1, num(p, "readRate", 1_200));
  const objectSize = Math.max(0.1, num(p, "objectSizeMB", 4));
  const hitRate = clamp(num(p, "cacheHitRate", 70) / 100, 0, 0.95);
  const concurrency = Math.max(1, num(p, "concurrency", 64));
  const missServiceMs = 25 + objectSize * 8;
  const capacity = concurrency * (1_000 / missServiceMs);
  const utilization = rate / Math.max(1, capacity);
  const queueMs = utilization > 0.6 ? (utilization - 0.6) ** 2 * 2_000 : 0;
  const p50 = hitRate * 3 + (1 - hitRate) * missServiceMs * 0.55;
  const p99 = Math.min(
    MAX_LATENCY,
    hitRate * 8 + (1 - hitRate) * missServiceMs * 1.8 + queueMs,
  );
  return {
    rate,
    objectSize,
    hitRate,
    concurrency,
    missServiceMs,
    capacity,
    utilization,
    queueMs,
    p50,
    p99,
    originReads: rate * (1 - hitRate),
    throughputMBps: rate * objectSize,
  };
}

function healthFor(c: Computed): "ok" | "warn" | "crit" {
  if (c.p99 >= 300 || c.originReads >= 2_500) return "crit";
  if (c.p99 >= 100 || c.originReads >= 1_000) return "warn";
  return "ok";
}

function histogramFor(c: Computed): HistogramData {
  const total = 1_000;
  const tailWeight = clamp((c.p99 / Math.max(1, c.p50 * 6.64) - 1) / 4, 0, 0.65);
  const buckets = HISTOGRAM_LABELS.map((label) => ({ label, count: 0 }));
  let previous = 0;
  for (let index = 0; index < HISTOGRAM_EDGES.length; index++) {
    const edgeMs = HISTOGRAM_EDGES[index];
    const cdf = 1 - Math.exp((-Math.LN2 * edgeMs) / Math.max(1, c.p50));
    buckets[index].count = Math.max(0, Math.round((cdf - previous) * (1 - tailWeight) * total));
    previous = cdf;
  }
  const tail = Math.max(0, Math.round((tailWeight + (1 - previous) * (1 - tailWeight)) * total));
  buckets[HISTOGRAM_LABELS.length - 1].count = tail;
  return { buckets, unit: " requests" };
}

function buildFrame(p: Params, t: number, flags: SimFrame["flags"]): SimFrame {
  const c = compute(p);
  const health = healthFor(c);
  return {
    t,
    nodes: [
      {
        id: "app",
        label: "read path",
        kind: "service",
        health,
        utilization: clamp(c.rate / MAX_READ_RATE),
        sublabel: `${Math.round(c.rate).toLocaleString("en-US")} req/s · ${Math.round(c.p99)} ms p99`,
        detail: "The read path can be a synchronous request or a batch consumer. The same p99 affects them differently.",
        meta: { view: "flow" },
      },
      {
        id: "cache",
        label: "read cache",
        kind: "cache",
        health: "ok",
        utilization: clamp(c.hitRate),
        sublabel: `${Math.round(c.hitRate * 100)}% hit rate`,
        detail: "A hit avoids the object store. A miss pays the object round trip and may still be slower than the caller's budget.",
        meta: { view: "flow" },
      },
      {
        id: "storage",
        label: "object storage",
        kind: "storage",
        health,
        utilization: clamp(c.utilization),
        sublabel: `${Math.round(c.originReads).toLocaleString("en-US")} origin reads/s`,
        detail: `Each miss transfers about ${c.objectSize.toFixed(1)} MB. At ${Math.round(c.capacity).toLocaleString("en-US")} req/s of concurrency-limited capacity, utilization is ${Math.round(c.utilization * 100)}%.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-cache", "app", "cache", clamp(c.hitRate), "ok"),
      edge("cache-storage", "cache", "storage", clamp(c.originReads / MAX_READ_RATE), health),
      edge("app-storage", "app", "storage", clamp(c.originReads / MAX_READ_RATE), health),
    ],
    metrics: [
      metric("read-p99", "p99 read latency", c.p99, " ms", 100, 300, "ms"),
      metric("read-p50", "p50 read latency", c.p50, " ms", undefined, undefined, "ms"),
      metric("origin-reads", "Origin reads", c.originReads, " req/s", 1_000, 2_500, "rps"),
      metric("aggregate-throughput", "Aggregate throughput", c.throughputMBps, " MB/s", undefined, undefined, "number"),
      metric("cache-hit", "Cache hit rate", c.hitRate * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    histogram: histogramFor(c),
    flags: { ...flags, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(c.throughputMBps).toLocaleString("en-US")} MB/s aggregate throughput, ${Math.round(c.p50)} ms p50 and ${Math.round(c.p99)} ms p99. Throughput does not describe the tail.`,
  };
}

function seedSeries(frame: SimFrame, c: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 6)) / 2.2);
  const seedValues: [string, number, number][] = [
    ["read-p99", c.p99, 5],
    ["read-p50", c.p50, 1],
    ["origin-reads", c.originReads, 20],
    ["aggregate-throughput", c.throughputMBps, 40],
    ["cache-hit", c.hitRate * 100, 0.5],
  ];
  for (const [id, value, amplitude] of seedValues) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 1.7) * amplitude),
    );
  }
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99-read-latency",
    metricId: "read-p99",
    warn: 100,
    crit: 300,
    title: "Tail read latency breaches the synchronous path budget",
    cause:
      "Each miss pays an object round trip and a transfer. Queueing multiplies that time when concurrency is exhausted. p50 can stay fast because most reads hit the cache while the misses dominate p99.",
    fix:
      "Reduce the miss path: raise the cache hit rate for hot objects, coalesce concurrent reads, lower object size with range reads, or add concurrency. Move strict synchronous work off the object-storage path if the budget cannot be met.",
    checkFirst: [
      "Compare p50 with p99 and with the caller's timeout.",
      "Check cache hit rate for the objects on the slow path.",
      "Check origin read concurrency and queueing, not only average throughput.",
    ],
  },
  {
    id: "origin-read-rate",
    metricId: "origin-reads",
    warn: 1_000,
    crit: 2_500,
    title: "Origin read rate is driving latency and cost",
    cause:
      "Cache misses turn into object requests. A lower hit rate or a larger working set multiplies requests, and object storage charges and throttles per request as well as per byte.",
    fix:
      "Improve the cache key and retention for the hot working set, coalesce duplicate requests, and avoid scanning cold objects on the synchronous path.",
    checkFirst: [
      "Measure the miss ratio by object prefix or topic.",
      "Check whether a new consumer or replay is scanning cold data.",
      "Compare request count with bytes transferred.",
    ],
  },
];

export const objectStorageLatencyModel: SimModel = {
  id: "streaming-object-storage-latency",
  visual: "histogram",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, { seed });
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const c = compute(p);
    const next = buildFrame(p, frame.t, frame.flags);
    next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (c.p99 >= 300 && frame.flags.p99Event !== 1) {
      pushEvent(next, {
        id: "read-p99-breach",
        at: frame.t,
        severity: "crit",
        title: "Object read p99 exceeds the request budget",
        detail: `p99 is ${Math.round(c.p99)} ms while aggregate throughput is ${Math.round(c.throughputMBps).toLocaleString("en-US")} MB/s. ${Math.round(c.originReads).toLocaleString("en-US")} origin reads/s and ${Math.round(c.hitRate * 100)}% cache hits set the miss path.`,
        nodeId: "storage",
        metricId: "read-p99",
      });
    }
    next.flags.p99Event = c.p99 >= 300 ? 1 : 0;

    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `Aggregate throughput is ${Math.round(c.throughputMBps).toLocaleString("en-US")} MB/s, but p50 is ${Math.round(c.p50)} ms and p99 is ${Math.round(c.p99)} ms. A throughput number cannot tell a synchronous caller whether it will time out.`,
    );
    items.push(
      `${Math.round(c.originReads).toLocaleString("en-US")} origin reads/s at a ${Math.round(c.hitRate * 100)}% cache hit rate; misses are the expensive path.`,
    );
    if (c.utilization > 0.9) {
      items.push(
        `Origin reads use ${Math.round(c.utilization * 100)}% of the concurrency-limited capacity. Queueing adds about ${Math.round(c.queueMs)} ms to the tail.`,
      );
    }
    if (c.objectSize >= 8) {
      items.push("Large objects raise transfer time per miss. Range reads or smaller objects can keep the same bytes while lowering the tail.");
    }
    if (c.hitRate >= 0.85) {
      items.push("A high hit rate protects p50. The remaining misses still set p99, so the cache must cover the objects on the latency-critical path.");
    }
    if (frame.metrics.some((item) => item.id === "read-p99" && item.value >= 300)) {
      items.push("The tail is above the caller budget. Aggregate throughput is not evidence that the request path is healthy.");
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A warm cache, small objects, and enough concurrency keep p99 inside the budget.",
    tone: "ok",
    params: defaults({ readRate: 600, objectSizeMB: 2, cacheHitRate: 85, concurrency: 96 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "More traffic and larger objects push p99 into the warning band.",
    tone: "warn",
    params: defaults({ readRate: 1_800, objectSizeMB: 4, cacheHitRate: 70, concurrency: 128 }),
  },
  {
    id: "failure",
    label: "Tail latency",
    description: "A cold cache, 16 MB objects, and too little concurrency exhaust the read path.",
    tone: "crit",
    params: defaults({ readRate: 4_000, objectSizeMB: 16, cacheHitRate: 20, concurrency: 64 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "More concurrency and a warm cache restore p99 without reducing durability.",
    tone: "ok",
    params: defaults({ readRate: 2_000, objectSizeMB: 2, cacheHitRate: 90, concurrency: 128 }),
  },
];

const experiment: Experiment = {
  id: "predict-throughput-vs-p99",
  title: "Predict which workload the throughput hides",
  simId: "object-storage-latency",
  question:
    "A read path moves about 24,000 MB/s in aggregate through object storage, but p99 is above 3 seconds. A synchronous API reads one small object per request on the same path. Is the API safe?",
  prediction: {
    options: [
      { id: "safe", label: "Yes, because aggregate throughput is far above the API's need" },
      { id: "unsafe", label: "No, because the API waits on the same tail latency for every request" },
      { id: "safe-batch", label: "Yes, if the API batches all requests into one object" },
      { id: "unknown", label: "Only if the object store is in another region" },
    ],
    correctOptionId: "unsafe",
    explanation:
      "Aggregate throughput is the sum of bytes moved across many concurrent requests. A synchronous API cares about the latency of its own request. If 1% of reads take more than 3 seconds, a caller with a 1-second timeout fails even though the fleet is moving enormous byte volume. The API either needs a cache or a different storage path for its object, or it must tolerate timeouts and retries.",
  },
  setup: defaults({ readRate: 3_000, objectSizeMB: 8, cacheHitRate: 50, concurrency: 64 }),
  runFor: 20,
  observe: [
    "Aggregate throughput reaches about 24,000 MB/s in this illustrative model.",
    "p99 is pinned at the 5-second cap while p50 stays far lower.",
    "Origin reads are in the critical band, so the miss path is the bottleneck.",
    "The histogram shows a heavy tail, not a uniform slowdown.",
  ],
  explain:
    "Throughput and latency answer different questions. High throughput means the system can move many bytes per second in aggregate; it does not mean any one request is fast. Object storage is built for the former: large parallel transfers, high durability, and per-request pricing. A request path that needs a single object within a tight budget needs a cache, a smaller object, or a storage tier with a lower per-request latency.",
  fix: defaults({ readRate: 1_200, objectSizeMB: 4, cacheHitRate: 85, concurrency: 128 }),
  debrief:
    "The fix raises the cache hit rate, halves the object size, and doubles concurrency. p99 falls to about 20 ms while aggregate throughput drops to about 4,800 MB/s. That is not a regression: the workload was never throughput-bound. The durability model is unchanged, and the synchronous path now fits its budget.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Object storage is a durable, highly available key-value store for large immutable blobs. It is excellent at aggregate throughput: many clients can read and write in parallel, and the service spreads load across a large fleet. It is not a low-latency block device. Every request has a round trip, every miss may need a metadata lookup, and per-request pricing makes small frequent operations expensive.",
  },
  {
    type: "p",
    text: "That split matters for streaming. A consumer that reads a large batch once can use object storage well. A synchronous API that reads one object per request inherits the tail of the object store on every call. The average can look fine, aggregate throughput can look impressive, and p99 can still be multiple seconds. The histogram, not the throughput counter, tells you which workload is safe.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is the caller, an optional cache, and the object store. A cache hit returns quickly; a miss pays the object round trip and transfer. Concurrency sets how many misses can be in flight, so it sets capacity and queueing. Object size sets transfer time per miss. The cache hit rate sets how often the caller avoids the expensive path, which is why p50 and p99 can diverge sharply.",
  },
  {
    type: "table",
    headers: ["Workload", "Object storage fit", "Why"],
    rows: [
      ["Batch analytics over large objects", "Strong", "Sequential reads, high aggregate throughput, latency is not user-facing"],
      ["Log or event replay", "Strong", "Durable history and parallel reads"],
      ["Synchronous API reading one small object", "Weak", "Per-request round trip and tail latency dominate"],
      ["Interactive dashboard with a hot working set", "Mixed", "A cache can cover the hot set; cold reads still pay the tail"],
      ["Strict request budget under 100 ms", "Weak", "The object round trip alone can exceed the budget"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses illustrative values: 100 to 5,000 reads per second, 0.5 to 64 MB objects, and 8 to 256 concurrent reads. The latency formula and the 5-second cap are teaching values, not an S3 benchmark. The lesson is the shape: a heavy tail and a high aggregate throughput can coexist.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A latency histogram with a p50 marker in the low buckets and a tail that reaches the cap.",
      "p50 and p99 read latency, which move apart when misses and queueing dominate.",
      "Origin reads per second, the miss traffic that drives both latency and request cost.",
      "Aggregate throughput in MB/s, which can stay high while the tail fails.",
      "Cache hit rate, which protects the median but not necessarily the objects your request path needs.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Tail latency. Compare the histogram with aggregate throughput, then apply Recovery. Change object size and cache hit rate one at a time to see which moves the tail.",
  },
  { type: "sim", simId: "object-storage-latency" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset read 4,000 objects per second with a 20% cache hit rate and 16 MB objects. Each miss needed about 153 ms of service time, and 64 concurrent reads could sustain only about 418 requests per second. Utilization passed 900%, the queue added seconds, and p99 hit the 5-second cap. Aggregate throughput still reported 64,000 MB/s because each of those slow reads moved 16 MB. The throughput number described the bytes; the histogram described the caller's experience.",
  },
  {
    type: "p",
    text: "Recovery used 2 MB objects, a 90% hit rate, and 128 concurrent reads. Miss service time fell to about 41 ms, capacity rose to about 3,100 requests per second, utilization fell to 64%, and p99 returned to about 18 ms. The durability model did not change; the workload shape and the hot-set cache did. The tail was bought back with concurrency and cache coverage, not with a stronger storage guarantee.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A latency histogram per operation, not only an average; watch the bucket that contains the caller's timeout.",
      "Cache hit rate split by object prefix, topic, and tenant, because a global hit rate can hide a cold critical key.",
      "Origin request rate and bytes per request; both drive cost and throttling.",
      "Concurrency and in-flight requests at the client, plus retries and timeouts.",
      "Object-store slow-down responses, cross-region reads, and the age of the object being read.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare p99 with the caller's timeout and with p50. Check the cache hit rate for the exact objects on the slow path. Then check concurrency and origin request rate. Only after that consider a different storage class or a different architecture.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Map the caller budget to a percentile: if the timeout is 1 second, p99 must be below it, not the average.",
      "Raise cache coverage for the hot objects on the synchronous path and verify the key includes the version.",
      "Coalesce concurrent reads for the same object so one origin request serves many callers.",
      "Reduce object size or use range reads so a miss transfers only the bytes the caller needs.",
      "Increase concurrency to raise capacity, then re-check queueing and client memory.",
      "Move cold or historical reads off the synchronous path; keep them on the batch path where throughput is the right metric.",
      "Use a lower-latency storage class only for the objects that need it, and verify the cost change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A cache lowers p99 and origin cost but can serve stale data; the invalidation policy is part of the correctness story.",
      "More concurrency raises capacity and lowers queueing but consumes client connections and memory.",
      "Smaller objects reduce transfer time but increase request count and per-request cost.",
      "A low-latency storage class improves p99 but costs more and still has a network round trip.",
      "Keeping cold data on cheap object storage protects cost but makes historical reads unsuitable for synchronous callers.",
      "Durability is not the tradeoff here; the tradeoff is latency, request cost, and cache freshness.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "throughput-vs-tail",
    question:
      "A storage path reports high aggregate throughput but p99 is 3 seconds. Which workloads are actually affected?",
    difficulty: 2,
    hints: [
      "Throughput is aggregate; latency is per request.",
      "Think about caller timeouts and batch jobs.",
    ],
    answer:
      "Any workload that waits on an individual read is affected: synchronous APIs, interactive dashboards, request-scoped enrichment, and health checks. A batch job that reads many objects in parallel may be unaffected because it cares about total bytes and can tolerate a slow individual object. I would compare the caller's timeout with p99, not with the average, and split the histogram by operation and object. A high-throughput path can still be the wrong path for a request that needs one object quickly.",
    followUps: [
      "How would you prove a batch job is unaffected?",
      "Which percentile would you put in an SLO?",
      "What does a heavy tail imply about retries?",
    ],
    redFlags: [
      "Uses average latency for an SLO.",
      "Assumes throughput implies low latency.",
      "Ignores caller timeouts.",
    ],
    rubric: [
      "Separates per-request from aggregate.",
      "Names synchronous workloads.",
      "Uses a percentile and a timeout.",
      "Distinguishes batch tolerance.",
    ],
  },
  {
    id: "reduce-tail",
    question:
      "How do you reduce object-storage tail latency without weakening durability?",
    difficulty: 3,
    hints: [
      "Durability is not the same as cache freshness.",
      "The hot set is smaller than the full data set.",
    ],
    answer:
      "I would keep the durable object as the source of truth and optimize the read path around it. Cache the hot objects with a versioned key, coalesce concurrent misses, use range reads or smaller objects, add concurrency, and keep cold scans off the synchronous path. A low-latency storage class can help for a subset. None of these removes durability; they change how often a caller pays the object round trip. I would measure p99 before and after each change and watch cache staleness.",
    followUps: [
      "How do you invalidate a cached object?",
      "What does request coalescing change for the origin?",
      "When would you use range reads?",
    ],
    redFlags: [
      "Suggests disabling durability.",
      "Caches without a version or invalidation plan.",
      "Adds concurrency without checking queueing.",
    ],
    rubric: [
      "Keeps the object store authoritative.",
      "Names cache, coalescing, and size levers.",
      "Mentions invalidation.",
      "Measures the tail.",
    ],
  },
  {
    id: "when-object-storage",
    question:
      "When is object storage the right backing store for a streaming workload?",
    difficulty: 3,
    hints: [
      "Separate throughput-oriented from request-oriented consumers.",
      "Consider cost, durability, and replay.",
    ],
    answer:
      "It fits when the consumer values durable retention, high aggregate throughput, and low storage cost more than per-request latency: analytics, replay, archival, and batch enrichment. It also fits spiky ingestion because the store scales without provisioning disks. It is a poor fit for a synchronous path that needs a single recent record within a tight budget, unless a cache or a lower-latency tier covers that path. I would decide per topic and per consumer, and I would verify the tail against the caller's timeout rather than the fleet's throughput.",
    followUps: [
      "How would you split hot and cold paths?",
      "What does replay cost in request terms?",
      "How do you test the tail before launch?",
    ],
    redFlags: [
      "Chooses storage by throughput alone.",
      "Ignores replay and request cost.",
      "Has no latency SLO.",
    ],
    rubric: [
      "Matches workload to storage properties.",
      "Names durability and cost benefits.",
      "Names the latency limitation.",
      "Proposes a split or cache.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each read path has a latency budget and an SLO percentile that matches the caller timeout.",
      "Histograms are recorded per operation, object prefix, and cache status.",
      "Cache hit rate and origin request rate are charted together.",
      "Object size and concurrency limits are documented for the hot path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare p99 with the caller timeout before changing storage.",
      "Check the hit rate for the specific objects on the slow path.",
      "Check origin concurrency and queueing, not only bytes per second.",
      "Shed cold or non-critical reads to protect the synchronous path.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add or fix cache coverage for the critical working set.",
      "Right-size objects and concurrency against the measured tail.",
      "Move historical scans to a batch path.",
      "Re-run the load test with the real object size and hit rate.",
    ],
  },
];

const references = [
  {
    title: "Amazon S3 performance best practices",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Request rate, object size, and parallelism guidance for S3 workloads.",
  },
  {
    title: "Amazon S3 request rate and performance considerations",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/request-rate-perf-considerations.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How request patterns and prefixes affect throughput and latency.",
  },
  {
    title: "WarpStream architecture overview",
    url: "https://docs.warpstream.com/warpstream/overview/architecture",
    publisher: "WarpStream",
    kind: "docs" as const,
    note: "Object storage as the durable log and the role of stateless agents.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "object-storage-latency": {
      model: objectStorageLatencyModel,
      presets,
      instructions:
        "Start Healthy, then apply Tail latency. Compare the histogram with aggregate throughput, then apply Recovery and change cache hit rate one step at a time.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Latency, capacity, and throughput values are teaching numbers, not S3 benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "streaming-warpstream",
    "streaming-retention",
    "streaming-consumer-lag",
    "caching-cache-stampede",
  ],
};
