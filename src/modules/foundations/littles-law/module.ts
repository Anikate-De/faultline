import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "arrivalRate",
    label: "Arrival rate",
    min: 100,
    max: 1_200,
    step: 10,
    value: 400,
    unit: " rps",
    group: "Demand",
    help: "Requests offered to the queue each second. This is λ in Little's Law.",
    format: "rps" as const,
  },
  {
    id: "serviceTimeMs",
    label: "Service time",
    min: 5,
    max: 100,
    step: 1,
    value: 20,
    unit: "ms",
    group: "Capacity",
    help: "Time one worker needs for one request, excluding queue wait. This is the service demand.",
    format: "ms" as const,
  },
  {
    id: "workers",
    label: "Workers",
    min: 2,
    max: 64,
    step: 1,
    value: 16,
    unit: "",
    group: "Capacity",
    help: "Parallel servers. Each worker handles one request at a time; capacity is workers divided by service time.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  arrival: number;
  serviceMs: number;
  workers: number;
  capacity: number;
  utilization: number;
  queueDepth: number;
  waitMs: number;
  latencyMs: number;
  concurrency: number;
  throughput: number;
}

function compute(p: Params, t: number): Computed {
  const arrival = Math.max(1, num(p, "arrivalRate", 400));
  const serviceMs = Math.max(1, num(p, "serviceTimeMs", 20));
  const workers = Math.max(1, Math.round(num(p, "workers", 16)));
  const capacity = (workers * 1_000) / serviceMs;
  const utilization = arrival / capacity;
  let queueDepth: number;
  if (utilization < 1) {
    queueDepth = (utilization ** 2) / Math.max(0.01, 1 - utilization);
  } else {
    queueDepth = (arrival - capacity) * Math.max(0, t);
  }
  const waitMs = (queueDepth / arrival) * 1_000;
  const latencyMs = serviceMs + waitMs;
  const concurrency = (arrival * latencyMs) / 1_000;
  return {
    arrival,
    serviceMs,
    workers,
    capacity,
    utilization,
    queueDepth,
    waitMs,
    latencyMs,
    concurrency,
    throughput: Math.min(arrival, capacity),
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 1) return "crit";
  if (utilization >= 0.8) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 5)) / 2.4);
  const entries: [string, number, number][] = [
    ["queueDepth", values.queueDepth, 0.4],
    ["latency", values.latencyMs, 1.2],
    ["concurrency", values.concurrency, 0.8],
    ["utilization", values.utilization * 100, 1],
    ["throughput", values.throughput, 12],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1 + value) * amplitude),
    );
  }
}

function buildFrame(p: Params, seed: number, t = 0): SimFrame {
  const v = compute(p, t);
  const health = healthFor(v.utilization);
  const groupCount = Math.min(3, v.workers);
  const basePool = Math.floor(v.workers / groupCount);
  const remainder = v.workers % groupCount;
  const pools = Array.from({ length: groupCount }, (_, index) => basePool + (index < remainder ? 1 : 0));
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "API producer",
        kind: "service",
        health: "ok",
        utilization: clamp(v.arrival / 1_200),
        throughput: v.arrival,
        sublabel: `${Math.round(v.arrival)} rps offered`,
        meta: { view: "queue" },
      },
      {
        id: "queue",
        label: "Work queue",
        kind: "queue",
        health,
        utilization: clamp(v.utilization),
        throughput: v.arrival,
        sublabel: `${Math.round(v.queueDepth).toLocaleString()} waiting`,
        detail: `At ${Math.round(v.utilization * 100)}% utilization the queue holds ${Math.round(v.queueDepth).toLocaleString()} requests. Capacity is ${Math.round(v.capacity)} rps.`,
        meta: { view: "queue", depth: v.queueDepth },
      },
      ...pools.map((poolSize, index) => ({
        id: `workers-${index + 1}`,
        label: `Worker pool ${String.fromCharCode(65 + index)}`,
        kind: "worker" as const,
        role: "instance" as const,
        health,
        utilization: clamp(v.utilization),
        throughput: (v.capacity * poolSize) / v.workers,
        sublabel: `${poolSize} worker${poolSize === 1 ? "" : "s"}`,
        detail: `${poolSize} of ${v.workers} workers. They are busy ${Math.round(clamp(v.utilization) * 100)}% of the time.`,
        meta: { view: "queue" },
      })),
    ],
    edges: [
      edge("producer-queue", "producer", "queue", clamp(v.utilization), health),
      ...pools.map((poolSize, index) =>
        edge(
          `queue-workers-${index + 1}`,
          "queue",
          `workers-${index + 1}`,
          clamp(v.utilization * (poolSize / v.workers) + 0.1),
          health,
        ),
      ),
    ],
    metrics: [
      metric("queueDepth", "Queue depth", v.queueDepth, " req", 50, 300, "count"),
      metric("latency", "Time in system W", v.latencyMs, "ms", 100, 500, "ms"),
      metric("concurrency", "Concurrency L", v.concurrency, " req", 50, 300, "count"),
      metric("wait", "Queue wait", v.waitMs, "ms", 50, 300, "ms"),
      metric("utilization", "Worker utilization", v.utilization * 100, "%", 80, 100, "percent"),
      metric("throughput", "Throughput", v.throughput, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), queueGrowing: 0 },
    summary: `${Math.round(v.arrival)} rps offered, ${Math.round(v.throughput)} rps served. Queue ${Math.round(v.queueDepth).toLocaleString()}, W ${formatMs(v.latencyMs)}, L ${Math.round(v.concurrency)}.`,
  };
  return frame;
}

function formatMs(ms: number): string {
  if (ms < 1) return `${(ms * 1_000).toFixed(0)}us`;
  if (ms < 1_000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "queueDepth",
    metricId: "queueDepth",
    warn: 50,
    crit: 300,
    title: "The queue is growing without bound",
    cause:
      "Arrivals exceed the workers' service capacity. Every second adds the difference to the queue, so depth rises linearly and never reaches a steady state.",
    fix:
      "Reduce arrivals, add service capacity, or reduce service time before the queue reaches its limit. A queue with no bound will eventually consume memory and time out work.",
    checkFirst: [
      "Compare arrival rate with capacity: workers divided by service time.",
      "Check whether the queue depth is rising or oscillating around a level.",
      "Check whether retries are adding arrivals.",
    ],
  },
  {
    id: "latency",
    metricId: "latency",
    warn: 100,
    crit: 500,
    title: "Time in system is rising at fixed throughput",
    cause:
      "Throughput cannot rise above capacity, so extra arrivals wait. By Little's Law, L = λW, a rising W at flat λ means more concurrency is sitting in the system.",
    fix:
      "Treat the wait, not the workers, as the symptom: reduce λ, raise capacity, or shorten the service time. Then verify that W and L fall together.",
    checkFirst: [
      "Plot throughput and latency on the same time axis.",
      "Compare queue wait with service time.",
      "Check whether the concurrency limit is already reached.",
    ],
  },
  {
    id: "concurrency",
    metricId: "concurrency",
    warn: 50,
    crit: 300,
    title: "In-flight work exceeds the safe concurrency budget",
    cause:
      "L is the number of requests in the queue plus the number being served. It rises when either the arrival rate or the time in system rises.",
    fix:
      "Bound concurrency at the caller and shed or queue excess work. An unbounded pool moves the queue into memory and makes latency worse.",
    checkFirst: [
      "Compute L from the observed λ and W, then compare with the pool's active count.",
      "Check whether the concurrency limit is enforced or advisory.",
      "Check for requests that hold a slot while waiting on another dependency.",
    ],
  },
  {
    id: "utilization",
    metricId: "utilization",
    warn: 80,
    crit: 100,
    title: "Worker utilization reached capacity",
    cause:
      "At 100% utilization the workers have no idle time, so any arrival burst becomes queue wait. Above 100% offered load, the queue grows without bound.",
    fix:
      "Add workers or reduce service time to restore headroom. Utilization is a capacity signal; latency is the user-facing consequence.",
    checkFirst: [
      "Check utilization per worker group, not only the fleet average.",
      "Check service time for a regression or a slow dependency.",
      "Check whether a burst is temporary or the new baseline.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const littlesLawModel: SimModel = {
  id: "foundations-littles-law",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults(), 0), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p, frame.t);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), frame.t);
    next.t = frame.t;
    const key = JSON.stringify(p);
    const changed = frame.flags.paramsKey !== key;
    next.flags = { ...frame.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    if (changed && frame.t <= 0.11) {
      next.series = {};
      seedSeries(next, values, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = frame.series;
    }
    const jitter = rng.between(-0.003, 0.003);
    next.metrics = next.metrics.map((item) =>
      item.id === "queueDepth" ? { ...item, value: Math.max(0, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.utilization > 1 && frame.flags.queueGrowing !== 1) {
      pushEvent(next, {
        id: "queue-unbounded",
        at: frame.t,
        severity: "crit",
        title: "Arrivals exceed service capacity",
        detail: `${Math.round(values.arrival)} rps arrive while ${Math.round(values.capacity)} rps can be served. The queue grows by ${Math.round(values.arrival - values.capacity)} requests every second.`,
        nodeId: "queue",
        metricId: "queueDepth",
      });
      next.flags.queueGrowing = 1;
    }
    if (values.utilization <= 1) next.flags.queueGrowing = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${Math.round(values.arrival)} rps offered, ${Math.round(values.throughput)} rps served. Queue ${Math.round(values.queueDepth).toLocaleString()}, W ${formatMs(values.latencyMs)}, L ${Math.round(values.concurrency)}.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    const items = [
      `λ = ${Math.round(v.arrival)} rps, W = ${formatMs(v.latencyMs)}, so L = λW = ${Math.round(v.concurrency).toLocaleString()} requests.`,
      `Capacity is ${Math.round(v.capacity)} rps at ${Math.round(v.utilization * 100)}% utilization; ${Math.round(v.throughput)} rps are actually served.`,
    ];
    if (v.utilization >= 1) {
      items.push("Above 100% utilization the queue grows linearly with time; it will not find a new equilibrium.");
    } else {
      items.push("Below 100% utilization the queue settles; depth depends on variability as well as utilization.");
    }
    items.push("The workers are not the same as concurrency: concurrency includes the queue, which is why L can exceed the worker count.");
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
    description: "400 rps against 800 rps of capacity. The queue is tiny and stable.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "720 rps against 800 rps of capacity. Utilization is high and wait is growing.",
    tone: "warn",
    params: defaults({ arrivalRate: 720 }),
  },
  {
    id: "failure",
    label: "Overloaded",
    description: "1,000 rps against 400 rps of capacity. Throughput stays flat and the queue grows without bound.",
    tone: "crit",
    params: defaults({ arrivalRate: 1_000, serviceTimeMs: 30, workers: 12 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Add workers until capacity exceeds arrivals with headroom.",
    tone: "ok",
    params: defaults({ arrivalRate: 720, workers: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-overload",
  title: "Predict what the queue does above capacity",
  simId: "littles-law",
  question:
    "Arrivals are 1,000 rps and capacity is 400 rps. After 30 seconds, what has happened to queue depth and throughput?",
  prediction: {
    options: [
      { id: "drain", label: "The queue drains once workers catch up" },
      { id: "grow", label: "The queue grows without bound while throughput stays near 400 rps" },
      { id: "throughput", label: "Throughput rises to 1,000 rps" },
      { id: "flat", label: "The queue stays flat because latency is an average" },
    ],
    correctOptionId: "grow",
    explanation:
      "Workers can serve 400 requests per second. The other 600 arrive faster than they can be served, so the backlog grows by 600 every second. Throughput is capped by capacity, not by demand.",
  },
  setup: defaults({ arrivalRate: 1_000, serviceTimeMs: 30, workers: 12 }),
  runFor: 30,
  observe: [
    "Queue depth grows roughly linearly after the first second.",
    "Throughput stays flat near 400 rps while arrivals remain at 1,000 rps.",
    "Time in system W grows because each request waits behind the backlog.",
    "Concurrency L rises with W, even though the worker count has not changed.",
  ],
  explain:
    "Little's Law is an identity for a stable system: the average number of requests in the system equals the arrival rate times the average time each request spends there. When arrivals exceed capacity, there is no stable average. The extra arrivals accumulate, so W rises without a new throughput level. The identity still holds for any finite window you measure, but the averages do not converge to a steady state.",
  fix: defaults({ arrivalRate: 720, workers: 20 }),
  debrief:
    "The recovery restores the 20ms service time and adds workers, so capacity is 1,000 rps against 720 rps of demand. The queue settles and W falls with it. The important part is not the exact depth: it is that throughput never exceeded capacity, and the rising concurrency was the queue, not more useful work.",
};

const primer: Block[] = [
  {
    type: "h2",
    text: "What it is",
  },
  {
    type: "p",
    text: "Little's Law says that the average number of requests in a system equals the arrival rate times the average time each request spends in the system: L = λW. L is concurrency, the work in flight. λ is the arrival rate, in requests per second. W is the time in system, in seconds. The units cancel: requests per second times seconds gives requests.",
  },
  {
    type: "p",
    text: "The law is an accounting identity, not a queueing model. It holds for any stable system over the window you measure, whether the system is a thread pool, a database, a queue with workers, or an entire request path. It does not tell you why W is large. It tells you that if you know two of the three quantities, the third is fixed. That is enough to catch a system that is piling up work while its throughput looks flat.",
  },
  {
    type: "h2",
    text: "Where it sits",
  },
  {
    type: "p",
    text: "The request path has an arrival process, a queue, and a set of workers. Throughput is what the workers complete. Concurrency is everything between arrival and completion: requests waiting in the queue plus requests being served. The worker count is a capacity limit, not the same as concurrency. At 100% utilization, a request can wait behind a long queue while every worker is busy.",
  },
  {
    type: "table",
    headers: ["Quantity", "Symbol", "Meaning", "Units"],
    rows: [
      ["Concurrency", "L", "Requests in the queue plus in service", "requests"],
      ["Arrival rate", "λ", "Requests entering per second", "requests/s"],
      ["Time in system", "W", "Queue wait plus service time", "seconds"],
      ["Throughput", "X", "Requests completed per second", "requests/s"],
    ],
  },
  {
    type: "p",
    text: "In a stable system, throughput equals the arrival rate over a long enough window. That is why the law is often written with X in place of λ. The distinction matters during an incident: if arrivals exceed capacity, throughput stays at capacity while λ stays above it, and the difference accumulates as queue depth.",
  },
  {
    type: "h2",
    text: "What you'll see",
  },
  {
    type: "list",
    items: [
      "Queue depth, the number of requests waiting for a worker.",
      "Time in system W, the queue wait plus service time.",
      "Concurrency L, computed live as λW.",
      "Worker utilization, the share of capacity in use.",
      "Throughput, which stops rising once demand exceeds capacity.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read L, λ, and W together. Apply Overloaded and watch depth grow linearly while throughput stays flat. Then apply Recovery. Before you move on, compute L by hand from the displayed λ and W and compare it with the concurrency metric.",
  },
  { type: "sim", simId: "littles-law" },
  {
    type: "p",
    text: "A useful sanity check: if a service handles 200 rps and each request takes 250ms, then L = 200 × 0.25 = 50 requests are in flight on average. If the pool has 20 workers, the service cannot be stable at that latency without a queue of about 30 requests. That is the kind of arithmetic that turns a vague capacity argument into a concrete one.",
  },
  { type: "experiment", experimentId: "predict-overload" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The overloaded preset offered 1,000 rps to a system that could serve 400 rps. Throughput stayed at 400 rps because twelve workers at 30ms each cannot complete more. The other 600 requests per second accumulated in the queue. After 30 seconds the backlog was about 18,000 requests, and W had grown with it. Concurrency L rose because the queue is part of the system, not because the workers became faster.",
  },
  {
    type: "p",
    text: "The queue depth grew linearly, not exponentially, because the arrivals and capacity were constant. That is still unbounded. A real queue would hit a memory limit, a timeout, or a load shedder first. The law does not need a complicated model to show the direction: above capacity, the difference has nowhere to go.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "SQS: `ApproximateNumberOfMessagesVisible`, `ApproximateAgeOfOldestMessage`, and `NumberOfMessagesSent` minus `NumberOfMessagesDeleted`.",
      "Thread pools: active threads, queued tasks, and rejected tasks from the runtime or Micrometer.",
      "HTTP services: in-flight requests, request rate, and latency histogram; compare the active count with λW.",
      "Databases: active connections, wait events, and queue depth; a pool wait is concurrency you did not intend.",
      "Kubernetes: pending pods and unschedulable work, which behave like a queue even when the service is not queueing internally.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare arrival rate with capacity, not with last week's throughput. If throughput is flat and latency is rising, compute L = λW and compare it with the worker count or concurrency limit. Then find out where the extra concurrency is waiting: the application queue, a connection pool, a lock, or a dependency.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Establish whether the system is stable: is arrival rate below service capacity?",
      "Compute L = λW from observed values and compare it with the pool or limit.",
      "If the queue is growing, reduce arrivals, add capacity, or reduce service time.",
      "Bound the queue and the concurrency limit so excess work fails fast instead of waiting forever.",
      "Check for retries that inflate λ and for requests that hold a slot while waiting on another dependency.",
      "Verify recovery with all three: throughput, W, and L. A lower queue depth with the same W is not recovery.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More workers raise capacity but also raise cost and contention on shared dependencies.",
      "A bounded queue protects memory and latency but rejects work earlier; the product must accept that failure mode.",
      "Longer timeouts let requests wait longer, which raises L and can turn a slow dependency into a queue.",
      "Batching improves throughput per request but increases W for each item and can make tail latency worse.",
      "Little's Law describes the average; a burst can exceed the average concurrency even when the steady state is safe.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "derive-concurrency",
    question:
      "A service handles 300 rps and p50 latency is 200ms. How many requests are in flight, and what would change if latency doubled?",
    difficulty: 1,
    hints: [
      "Use L = λW and keep the units consistent.",
      "Concurrency follows latency at a fixed arrival rate.",
    ],
    answer:
      "At 300 rps and 0.2 seconds, L = 300 × 0.2 = 60 requests in flight on average. If latency doubles to 400ms and the arrival rate stays at 300 rps, L = 120. The workers did not double; the queue or the time spent waiting did. That is why a latency regression is also a concurrency regression, and why a pool sized for 60 in-flight requests will saturate when latency rises.",
    followUps: [
      "What if the arrival rate falls as latency rises?",
      "Why is p50 not always the right W?",
      "How would you validate the estimate against runtime metrics?",
    ],
    redFlags: [
      "Multiplies rps by workers.",
      "Uses milliseconds without converting to seconds.",
      "Assumes concurrency equals worker count.",
    ],
    rubric: [
      "Applies L = λW correctly.",
      "Converts units.",
      "Explains the pool implication.",
      "Names a way to validate.",
    ],
  },
  {
    id: "flat-throughput",
    question:
      "Throughput has been flat at 2,000 rps for an hour while p99 has risen from 200ms to 4s. What is your hypothesis?",
    difficulty: 2,
    hints: [
      "Throughput is capped; latency is absorbing the difference.",
      "Look for a queue, a pool, or a dependency that is holding work.",
    ],
    answer:
      "My hypothesis is that arrivals exceed capacity and the excess is accumulating. Throughput is capped at 2,000 rps, so the extra demand cannot show up as completed work; it shows up as in-flight requests and queue wait. Using L = λW, a 20x rise in W at the same λ implies roughly 20x the concurrency. I would check the application queue, connection pool, thread pool, and any dependency queue, then compare the active count with the limit. I would also check retries, which can raise λ without raising useful throughput.",
    followUps: [
      "Which metric would distinguish a queue from a slow dependency?",
      "What if the arrival rate is also falling?",
      "When would you shed load rather than add capacity?",
    ],
    redFlags: [
      "Says throughput is healthy so the system is healthy.",
      "Looks only at average latency.",
      "Adds workers without finding the constraint.",
    ],
    rubric: [
      "Connects flat throughput to accumulation.",
      "Uses L = λW.",
      "Checks queues, pools, and retries.",
      "Proposes a discriminating signal.",
    ],
  },
  {
    id: "size-pool",
    question:
      "You need to serve 500 rps at 100ms latency with a concurrency limit. What limit do you set, and what assumptions are you making?",
    difficulty: 2,
    hints: [
      "L = λW gives the average in-flight count.",
      "A limit at the average has no room for bursts or tail latency.",
    ],
    answer:
      "The average in-flight count is 500 × 0.1 = 50. A limit of exactly 50 would run at the average with no headroom, so any burst would queue or reject. I would set the limit above the expected in-flight count based on the tail latency and the burst multiplier, then test it under peak. I am assuming the arrival process is stable, the 100ms is the time in system rather than service time alone, and the dependency can handle the resulting concurrency. If any of those is false, the limit needs to be derived from the tail and the failure mode, not from the average.",
    followUps: [
      "How does a 10x p99 change the limit?",
      "What happens when the limit is reached?",
      "Would you set the limit per instance or per fleet?",
    ],
    redFlags: [
      "Sets the limit to the average.",
      "Ignores tail latency and bursts.",
      "Forgets the downstream dependency.",
    ],
    rubric: [
      "Computes 50 in-flight requests.",
      "Adds headroom for tail and bursts.",
      "States assumptions.",
      "Defines behavior at the limit.",
    ],
  },
  {
    id: "unstable-system",
    question:
      "Does L = λW still hold when arrivals exceed capacity? Why or why not?",
    difficulty: 3,
    hints: [
      "The law is an average over a window.",
      "A stable system has a finite long-run average.",
    ],
    answer:
      "The identity holds over any finite observation window if you measure the actual averages of L, λ, and W in that window. What fails is the assumption of a steady state. When arrivals exceed capacity, the queue grows, so the long-run averages do not converge: W and L increase with the length of the window. The formula still describes the snapshot, but it cannot be used to predict a stable operating point. That is why I check stability first, then use the law to quantify the concurrency that the instability is creating.",
    followUps: [
      "How would you compute L during a growing backlog?",
      "What does the law say about a system with a leaky bucket?",
      "Which average would you use for an incident review?",
    ],
    redFlags: [
      "Says the law only works for queues.",
      "Uses a long-run average during an unbounded backlog.",
      "Confuses throughput with arrival rate.",
    ],
    rubric: [
      "Distinguishes the identity from steady state.",
      "Explains non-convergence.",
      "Uses windowed averages.",
      "Connects to incident measurement.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show arrival rate, throughput, latency, and in-flight requests together.",
      "Queues expose depth and age, not only a processed count.",
      "Concurrency limits exist and their rejection behavior is tested.",
      "The team knows the capacity arithmetic: workers divided by service time.",
      "Retries are counted separately from first attempts.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether throughput is flat while latency rises; that is an accumulation signal.",
      "Compute L = λW and compare it with the pool or limit.",
      "Find where the concurrency is waiting: application, pool, lock, or dependency.",
      "Decide whether to reduce arrivals, add capacity, or shed work.",
      "Do not add workers until you know the constraint is local to the workers.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify throughput, latency, and concurrency at peak.",
      "Keep a queue bound or load shedder that prevents another unbounded backlog.",
      "Document the capacity assumption and the service-time measurement.",
      "Re-run the overload experiment with the production arrival pattern.",
    ],
  },
];

const references = [
  {
    title: "Addressing Cascading Failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Queueing, retries, and the ways overload turns into latency.",
  },
  {
    title: "Performance Modeling and Design of Computer Systems",
    url: "https://www.cs.cmu.edu/~harchol/PerformanceModeling/book.html",
    publisher: "Mor Harchol-Balter",
    kind: "book" as const,
    note: "Queueing theory, Little's Law, and the assumptions behind averages.",
  },
  {
    title: "Handling Overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Why a system above capacity needs admission control, not more queue.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "littles-law": {
      model: littlesLawModel,
      presets,
      instructions:
        "Start healthy, then apply Overloaded. Watch throughput flatten while queue depth and time in system rise. Compare L with λW before applying Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Queue depth uses a simple M/M/1 steady state below capacity and a constant overload above it; the arithmetic of L = λW is the lesson.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-use-red",
    "foundations-queueing-knee",
    "foundations-connection-pools",
    "capacity-capacity-models",
  ],
};
