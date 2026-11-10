import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INTERACTIVE_MS = 60;
const BATCH_MS = 300;
const QUEUE_SECONDS = 2;

const params = [
  {
    id: "interactiveRps",
    label: "Interactive request rate",
    min: 50,
    max: 1_000,
    step: 10,
    value: 200,
    unit: " rps",
    group: "Traffic",
    help: "Synchronous user traffic. Each request holds a worker for about 60ms in this scenario.",
    format: "rps" as const,
  },
  {
    id: "batchRps",
    label: "Batch request rate",
    min: 0,
    max: 1_500,
    step: 10,
    value: 60,
    unit: " rps",
    group: "Traffic",
    help: "Asynchronous or background work. Each request holds a worker for about 300ms.",
    format: "rps" as const,
  },
  {
    id: "poolWorkers",
    label: "Worker pool size",
    min: 10,
    max: 200,
    step: 5,
    value: 60,
    unit: " workers",
    group: "Capacity",
    help: "Total workers available to both workloads before any reservation.",
    format: "count" as const,
  },
  {
    id: "reservedShare",
    label: "Reserved for interactive",
    min: 0,
    max: 80,
    step: 5,
    value: 0,
    unit: "%",
    group: "Isolation",
    help: "Share of the pool dedicated to interactive traffic. Zero leaves one shared pool.",
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

function queueFactor(rho: number): number {
  const safe = Math.max(0, rho);
  return Math.min(80, 1 + (4 * safe ** 3) / Math.max(0.08, 1 - safe));
}

interface Computed {
  interactiveLatency: number;
  batchLatency: number;
  interactiveUtil: number;
  batchUtil: number;
  interactiveQueue: number;
  batchQueue: number;
  queueDepth: number;
  isolated: boolean;
  interactiveWorkers: number;
  batchWorkers: number;
}

function compute(p: Params): Computed {
  const interactiveRps = Math.max(0, num(p, "interactiveRps", 200));
  const batchRps = Math.max(0, num(p, "batchRps", 60));
  const workers = Math.max(1, Math.round(num(p, "poolWorkers", 60)));
  const share = clamp(num(p, "reservedShare", 0), 0, 80) / 100;
  const interactiveWork = (interactiveRps * INTERACTIVE_MS) / 1_000;
  const batchWork = (batchRps * BATCH_MS) / 1_000;

  if (share === 0) {
    const totalWork = interactiveWork + batchWork;
    const util = totalWork / workers;
    const factor = queueFactor(util);
    const excess = Math.max(0, totalWork - workers);
    const interactiveShare = totalWork > 0 ? interactiveWork / totalWork : 0;
    return {
      interactiveLatency: INTERACTIVE_MS * factor,
      batchLatency: BATCH_MS * factor,
      interactiveUtil: util * 100,
      batchUtil: util * 100,
      interactiveQueue: excess * QUEUE_SECONDS * 100 * interactiveShare,
      batchQueue: excess * QUEUE_SECONDS * 100 * (1 - interactiveShare),
      queueDepth: excess * QUEUE_SECONDS * 100,
      isolated: false,
      interactiveWorkers: workers,
      batchWorkers: workers,
    };
  }

  const interactiveWorkers = Math.max(1, Math.round(workers * share));
  const batchWorkers = Math.max(1, workers - interactiveWorkers);
  const interactiveUtil = interactiveWork / interactiveWorkers;
  const batchUtil = batchWork / batchWorkers;
  return {
    interactiveLatency: INTERACTIVE_MS * queueFactor(interactiveUtil),
    batchLatency: BATCH_MS * queueFactor(batchUtil),
    interactiveUtil: interactiveUtil * 100,
    batchUtil: batchUtil * 100,
    interactiveQueue: Math.max(0, interactiveWork - interactiveWorkers) * QUEUE_SECONDS * 100,
    batchQueue: Math.max(0, batchWork - batchWorkers) * QUEUE_SECONDS * 100,
    queueDepth:
      Math.max(0, interactiveWork - interactiveWorkers) * QUEUE_SECONDS * 100 +
      Math.max(0, batchWork - batchWorkers) * QUEUE_SECONDS * 100,
    isolated: true,
    interactiveWorkers,
    batchWorkers,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function seed(frame: SimFrame, values: Record<string, number>): void {
  for (const [id, value] of Object.entries(values)) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.96 + 0.06 * Math.sin((index + 5) / 2.9))),
    );
  }
}

function buildFrame(c: Computed, seedValue: number): SimFrame {
  const interactiveHealth = healthFor(c.interactiveLatency, 250, 500);
  const batchHealth = healthFor(c.batchUtil, 120, 150);
  const queueHealth = healthFor(c.interactiveQueue, 20, 100);
  return {
    t: 0,
    nodes: [
      {
        id: "ingress",
        label: "Request ingress",
        kind: "service",
        health: interactiveHealth,
        utilization: clamp(c.interactiveUtil / 100),
        sublabel: `${Math.round(c.interactiveLatency)}ms interactive p99`,
        meta: { view: "flow" },
      },
      {
        id: "work-queue",
        label: "Work queue",
        kind: "queue",
        health: queueHealth,
        sublabel: `${Math.round(c.queueDepth).toLocaleString()} waiting`,
        detail: c.isolated
          ? `Interactive bulkhead: ${c.interactiveWorkers} workers. Batch bulkhead: ${c.batchWorkers} workers.`
          : `One shared pool of ${c.interactiveWorkers} workers. Interactive and batch work compete for the same slots.`,
        meta: { view: "queue" },
      },
      {
        id: "interactive-workers",
        label: "Interactive workers",
        kind: "worker",
        health: interactiveHealth,
        utilization: clamp(c.interactiveUtil / 100),
        sublabel: `${Math.round(c.interactiveUtil)}% utilized`,
        meta: { view: "queue" },
      },
      {
        id: "batch-workers",
        label: "Batch workers",
        kind: "worker",
        health: batchHealth,
        utilization: clamp(c.batchUtil / 100),
        sublabel: `${Math.round(c.batchUtil)}% utilized`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("ingress-queue", "ingress", "work-queue", clamp(c.interactiveUtil / 250), interactiveHealth),
      edge("queue-interactive", "work-queue", "interactive-workers", 0.6, interactiveHealth),
      edge("queue-batch", "work-queue", "batch-workers", 0.4, batchHealth),
    ],
    metrics: [
      metric("interactive-p99", "Interactive p99", c.interactiveLatency, "ms", 250, 500, "ms"),
      metric("interactive-utilization", "Interactive pool utilization", c.interactiveUtil, "%", 75, 90, "percent"),
      metric("interactive-queue", "Interactive requests queued", c.interactiveQueue, " req", 20, 100, "count"),
      metric("batch-p99", "Batch p99", c.batchLatency, "ms", undefined, undefined, "ms"),
      metric("queueDepth", "Total queue depth", c.queueDepth, " req", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      isolated: c.isolated ? 1 : 0,
      interactiveWorkers: c.interactiveWorkers,
      batchWorkers: c.batchWorkers,
    },
    summary: c.isolated
      ? `Isolated pools: interactive p99 ${Math.round(c.interactiveLatency)}ms; batch p99 ${Math.round(c.batchLatency)}ms.`
      : `Shared pool: interactive p99 ${Math.round(c.interactiveLatency)}ms; batch p99 ${Math.round(c.batchLatency)}ms.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "interactive-p99",
    metricId: "interactive-p99",
    warn: 250,
    crit: 500,
    title: "Interactive p99 breached the tenant SLO",
    cause:
      "Batch work is occupying the same worker pool. The queue is first-in, first-out, so a short interactive request waits behind long batch jobs even when total CPU has headroom.",
    fix:
      "Reserve a separate pool or concurrency limit for interactive traffic. Size the reservation from peak interactive work, not from the average.",
    checkFirst: [
      "Compare interactive p99 with batch p99 and pool utilization.",
      "Check whether both workloads share one queue and one worker pool.",
      "Check the current batch backlog and whether it can be deferred.",
    ],
  },
  {
    id: "interactive-utilization",
    metricId: "interactive-utilization",
    warn: 75,
    crit: 90,
    title: "The interactive pool has no queueing headroom",
    cause:
      "At high utilization, queueing delay grows nonlinearly. A small burst pushes the pool past the point where p99 can meet the SLO.",
    fix:
      "Add workers to the interactive bulkhead, cap interactive concurrency, or shed low-value interactive work. Do not fix it by adding workers to the shared batch pool.",
    checkFirst: [
      "Check utilization per pool, not fleet-wide CPU.",
      "Check the arrival rate and service time of the interactive class.",
      "Check whether a burst or a retry loop is driving the increase.",
    ],
  },
  {
    id: "interactive-queue",
    metricId: "interactive-queue",
    warn: 20,
    crit: 100,
    title: "Interactive requests are waiting in a shared queue",
    cause:
      "The queue is holding work that has already missed its useful deadline. Batch jobs ahead of it make the wait longer, and retries can add more requests to the same queue.",
    fix:
      "Isolate the queues as well as the workers, bound the interactive queue, and reject or redirect before the wait exceeds the SLO.",
    checkFirst: [
      "Check queue wait time, not only depth.",
      "Check whether the queue is shared with batch or retry traffic.",
      "Check whether clients have already timed out and retried.",
    ],
  },
];

export const bulkheadModel: SimModel = {
  id: "foundations-bulkheads",
  visual: "queue",
  params,
  init: ({ seed: seedValue }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seedValue);
    seed(frame, {
      "interactive-p99": values.interactiveLatency,
      "interactive-utilization": values.interactiveUtil,
      "interactive-queue": values.interactiveQueue,
      "batch-p99": values.batchLatency,
      queueDepth: values.queueDepth,
    });
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    if (!c.isolated) {
      items.push(
        `One pool serves both classes. Interactive work is ${Math.round(c.interactiveUtil)}% of the pool's capacity, so a batch surge becomes interactive latency.`,
      );
    } else {
      items.push(
        `Interactive has ${c.interactiveWorkers} dedicated workers and batch has ${c.batchWorkers}. Interactive p99 is ${Math.round(c.interactiveLatency)}ms.`,
      );
    }
    if (c.batchQueue > 0) {
      items.push(
        `The batch bulkhead is holding about ${Math.round(c.batchQueue).toLocaleString()} requests. That backlog is the price of protecting interactive traffic.`,
      );
    }
    items.push(
      `Total queue depth is ${Math.round(c.queueDepth).toLocaleString()} requests; depth alone is ambiguous without the wait time and arrival rate.`,
    );
    items.push(
      "Isolation lowers utilization on the protected pool and raises it on the other. The unused capacity is an availability cost, not waste to eliminate.",
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
    description: "Shared pool at 50% utilization; both classes meet their targets.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak interactive",
    description: "Interactive traffic rises in a shared pool. p99 warns before it fails.",
    tone: "warn",
    params: defaults({ interactiveRps: 300, batchRps: 80 }),
  },
  {
    id: "failure",
    label: "Batch surge",
    description: "Batch traffic jumps to 400 rps in the shared pool and interactive p99 collapses.",
    tone: "crit",
    params: defaults({ interactiveRps: 300, batchRps: 400 }),
  },
  {
    id: "recovery",
    label: "Reserve a pool",
    description: "Half the workers are reserved for interactive traffic. Batch sees a smaller pool and higher latency.",
    tone: "ok",
    params: defaults({ interactiveRps: 300, batchRps: 80, reservedShare: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-isolation",
  title: "Predict what isolation protects",
  simId: "bulkheads",
  question:
    "Batch traffic jumps from 80 to 400 rps. You reserve 50% of the worker pool for interactive traffic. What happens?",
  prediction: {
    options: [
      { id: "interactive", label: "Interactive p99 recovers; batch latency becomes the new backlog" },
      { id: "both", label: "Both classes recover because the pool has more capacity" },
      { id: "batch", label: "Batch latency recovers because it has dedicated workers" },
      { id: "nothing", label: "Nothing changes; the total work is the same" },
    ],
    correctOptionId: "interactive",
    explanation:
      "The reservation gives interactive requests their own workers, so batch work can no longer sit ahead of them. Total capacity did not increase. The batch pool now absorbs the backlog, so its latency rises and its queue grows. Isolation contains the blast radius; it does not create capacity.",
  },
  setup: defaults({ interactiveRps: 300, batchRps: 400 }),
  runFor: 20,
  observe: [
    "Interactive p99 falls from seconds to under 200ms.",
    "The batch p99 rises sharply as its smaller pool absorbs the same work.",
    "Interactive queue depth falls to zero while the batch queue grows.",
    "Total utilization stays high; the protected pool now has idle headroom by design.",
  ],
  explain:
    "A bulkhead is a capacity partition. It works because the protected class no longer shares a queue with the noisy class. The cost appears as unused capacity in the protected pool and a larger backlog in the other. Choose the reservation from the protected class's peak work, then decide what the other class should do when its own queue is full: wait, drop, or move to a separate fleet.",
  fix: defaults({ interactiveRps: 300, batchRps: 400, reservedShare: 50 }),
  debrief:
    "The interactive SLO is restored, but batch work is now the visible loser. That is the correct shape of the tradeoff: the batch class should have a bounded queue, a deadline, and a separate scaling policy. Isolation without a batch backpressure plan simply moves the outage to the workload with less political power.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A bulkhead is a partition of a shared resource: workers, connections, memory, or queues. One workload cannot consume another workload's share, so saturation stays inside the partition that caused it. The name comes from a ship's watertight compartments. A breach floods one compartment, not the hull. The protected workload usually has a service-level objective (SLO) that the shared pool cannot guarantee during a surge.",
  },
  {
    type: "p",
    text: "The failure it prevents is a noisy neighbor. A shared worker pool with one queue looks efficient at average load. When a batch job arrives with long service times, its requests occupy workers and sit in the queue ahead of short interactive requests. Interactive p99 rises even though total CPU may still have headroom, because the bottleneck is the queue and the work mix, not the aggregate capacity.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A bulkhead sits at the boundary between workloads: separate thread pools in one process, separate deployments, separate connection pools, or separate queues consumed by separate worker sets. The important property is that the protected class has its own queue and its own concurrency limit. Separate workers with a shared queue are only half a bulkhead, because the queue still lets one class delay the other.",
  },
  {
    type: "table",
    headers: ["Design", "What it protects", "What it costs", "When it fails"],
    rows: [
      ["One shared pool", "Maximum utilization, simplest operations", "No isolation; one workload sets everyone's latency", "A batch surge becomes an interactive outage"],
      ["Separate worker pools", "Interactive latency and queue position", "Idle capacity in the protected pool; more configuration", "The other pool's backlog grows without a policy"],
      ["Separate queues and workers", "Queue position and retry isolation", "More moving parts; two backlogs to operate", "A shared dependency downstream still couples them"],
      ["Per-tenant quotas", "Fairness across many tenants", "Enforcement and accounting complexity", "A tenant below quota can still be slow"],
    ],
  },
  {
    type: "p",
    text: "This module models a 60-worker pool with 60ms interactive work and 300ms batch work. Those service times and the queueing curve are illustrative teaching values. The shape is the lesson: the shared pool's capacity is one number, and the mix of work decides who waits.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Interactive p99 and batch p99, measured separately, because the aggregate hides the class that is suffering.",
      "Interactive pool utilization: the protected pool's headroom, including the idle capacity isolation creates.",
      "Interactive queue depth: work that is waiting rather than running.",
      "Total queue depth: useful for capacity, ambiguous for user impact.",
      "The ingress and worker nodes, which show whether the pool is shared or split.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Batch surge. Watch interactive p99 and the shared queue together. Run the experiment and predict which class improves before you reserve the pool. Then compare the failure and recovery presets: the interactive SLO is restored, but the batch p99 and batch queue show the cost. Ask what the batch class should do when its own bulkhead is full.",
  },
  { type: "sim", simId: "bulkheads" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the shared pool, 300 interactive rps and 400 batch rps produced 138 worker-seconds of demand per second against 60 workers. The pool was at 230% utilization, so the queue grew and interactive requests waited behind long batch jobs. Interactive p99 reached seconds while aggregate CPU looked busy rather than broken.",
  },
  {
    type: "p",
    text: "Reserving 30 workers for interactive traffic changed the queue discipline. Interactive demand was 18 worker-seconds per second, so its pool sat at 60% and p99 returned to normal. Batch demand was 120 worker-seconds against 30 workers, so the batch backlog grew. The total capacity did not change. The protected class got its own failure domain.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-class metrics: p50, p95, p99, queue wait, in-flight requests, and worker utilization split by workload or tenant.",
      "Queue metrics: depth, age of the oldest item, arrival rate, and service rate. Depth without age hides whether work is still useful.",
      "Saturation signals: thread-pool active count, executor queue size, connection-pool wait, and cgroup CPU throttling.",
      "Logs and traces: batch spans holding workers while interactive spans wait, then a shared timeout or cancellation.",
      "Business signals: checkout success rate, search latency, and batch completion time, which show which class paid for the contention.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split latency and utilization by workload. If interactive p99 rises while aggregate CPU is below saturation and batch p99 is also high, the queue is shared and the work mix is the cause. Check queue age, not only depth. Then confirm whether the protected class has its own workers and its own queue, not just a higher priority label.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Classify work by latency sensitivity and business value before choosing a partition.",
      "Measure per-class service time, arrival rate, and queue wait to size the protected pool from peak work.",
      "Give the protected class its own workers and queue, or enforce a concurrency limit that batch cannot exceed.",
      "Bound the other class's queue and define what happens at the bound: wait, reject, or move to a separate fleet.",
      "Load-test the mix at peak, including a batch surge that lasts longer than the queue can absorb.",
      "Watch the protected pool's idle capacity and the other pool's backlog; both are expected costs, not surprises.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Isolation lowers utilization. The reserved pool must be sized for peak, so it will be idle at average load.",
      "Separate pools multiply configuration, deployment, and on-call surface; too many bulkheads become their own operational risk.",
      "A shared downstream dependency can still couple the classes even when the workers are separate.",
      "Per-tenant isolation gives fairness but can be expensive at high tenant counts; tiering is often the practical compromise.",
      "A batch backlog is acceptable only if batch work has a deadline and can be delayed or dropped. Otherwise the outage is still real, just quieter.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-noisy-neighbor",
    question:
      "Interactive p99 tripled while fleet CPU is 55%. A batch job started an hour ago. How do you confirm a noisy neighbor?",
    difficulty: 2,
    hints: [
      "Aggregate CPU can be healthy while a queue is not.",
      "Compare the classes, not the fleet.",
    ],
    answer:
      "I would split p99, queue wait, and worker utilization by class. If interactive queue wait rose while interactive service time stayed flat, and batch p99 or batch in-flight work rose at the same time, the shared queue is the coupling. I would also check thread-pool active counts and the executor queue, because CPU alone does not show queue position. A batch job with long service times can occupy every worker while CPU sits at 55%, especially if the work is I/O-bound. The confirmation is that interactive latency falls when batch traffic is paused or moved to a separate pool.",
    followUps: [
      "What if both classes share a downstream dependency?",
      "Which metric would you put on the incident dashboard first?",
      "How would you prove the batch job is the cause without stopping it?",
    ],
    redFlags: [
      "Adds capacity before checking per-class queues.",
      "Uses fleet CPU as proof that the pool is healthy.",
      "Blames the network without queue evidence.",
    ],
    rubric: [
      "Splits metrics by class.",
      "Names queue wait and worker occupancy.",
      "States a falsifying test.",
      "Distinguishes CPU from queueing.",
    ],
  },
  {
    id: "size-reservation",
    question:
      "How do you size a dedicated pool for interactive traffic without overprovisioning?",
    difficulty: 3,
    hints: [
      "Start from peak work, not average request rate.",
      "Include a queueing margin, then measure the idle cost.",
    ],
    answer:
      "I convert the interactive peak into worker-seconds per second: peak rps times the p95 service time, with a margin for burstiness. That gives the minimum worker count for the target utilization. I add headroom for the queueing knee and for one failure domain, then load-test the reservation against a batch surge. The leftover workers go to the batch pool with a bounded queue. I would state the cost explicitly: the protected pool is sized for peak and will be idle off-peak. If that cost is unacceptable, the alternative is to reduce interactive work or accept a lower SLO, not to silently share the pool again.",
    followUps: [
      "What utilization target would you use?",
      "How does a batch deadline change the sizing?",
      "What would make you choose separate deployments instead of pools?",
    ],
    redFlags: [
      "Sizes from average traffic.",
      "Ignores queueing headroom.",
      "Claims isolation is free.",
    ],
    rubric: [
      "Uses peak work and service time.",
      "Adds queueing and failure headroom.",
      "States the idle-capacity cost.",
      "Defines the batch backpressure policy.",
    ],
  },
  {
    id: "isolation-limits",
    question:
      "You isolate the worker pools, but interactive latency still spikes during batch surges. What did the bulkhead not isolate?",
    difficulty: 3,
    hints: [
      "Workers are only one shared resource.",
      "Follow the request past the pool.",
    ],
    answer:
      "The bulkhead isolated workers and queue position, but the classes may still share a downstream dependency: a database, a connection pool, a cache, a network link, or a lock. If batch traffic saturates the database or the connection pool, interactive requests wait there instead. I would trace both classes through the dependency and compare connection-pool wait, query latency, and lock time. The fix is another boundary at the actual bottleneck, or backpressure on batch before it reaches that dependency. A bulkhead is only as good as the resource it partitions.",
    followUps: [
      "How would you isolate a shared database?",
      "What does a connection pool per class cost?",
      "When is rate limiting a better answer than isolation?",
    ],
    redFlags: [
      "Assumes worker isolation is sufficient.",
      "Ignores downstream connection pools.",
      "Adds more pools without finding the shared resource.",
    ],
    rubric: [
      "Follows the request past the worker pool.",
      "Names shared dependencies.",
      "Proposes isolation at the real bottleneck.",
      "Includes backpressure for batch.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Workloads are classified by latency sensitivity and business value.",
      "Per-class p99, queue wait, and worker utilization are dashboarded.",
      "Every protected class has its own queue or concurrency limit, not just a priority label.",
      "The batch class has a deadline, a bounded queue, and a defined drop or defer policy.",
      "The reservation is load-tested against a batch surge and an AZ failure.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split latency by class before adding capacity.",
      "Check queue age and worker occupancy, not only CPU.",
      "Confirm whether the shared resource is the pool, the queue, or a downstream dependency.",
      "Protect the interactive class first; pause or defer batch if the boundary is missing.",
      "Record which class paid for the mitigation and how long it will remain degraded.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Resize the reservation from observed peak work, not the incident's average.",
      "Verify the batch backlog drains within its deadline.",
      "Remove emergency pauses and restore the batch schedule deliberately.",
      "Add a regression test that mixes both classes at peak.",
    ],
  },
];

const references = [
  {
    title: "Bulkhead pattern",
    url: "https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead",
    publisher: "Microsoft Azure Architecture Center",
    kind: "docs" as const,
    note: "Partitioning consumers and services into isolated pools to contain failures.",
  },
  {
    title: "Reliability pillar: AWS Well-Architected Framework",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Failure isolation, bounded queues, and static stability guidance.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    bulkheads: {
      model: bulkheadModel,
      presets,
      instructions:
        "Start healthy, apply Batch surge, then compare recovery with a 50% reservation. Watch interactive p99 and batch p99 separately, and check queue age as well as depth.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Service times, worker counts, and the queueing curve are teaching values, not a capacity guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-queueing-knee",
    "foundations-load-shedding",
    "capacity-noisy-neighbor",
    "reliability-graceful-degradation",
  ],
};
