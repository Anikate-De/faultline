import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_MS = 20;
const DEADLINE_MS = 2_000;

const params = [
  {
    id: "demandRps",
    label: "Offered demand",
    min: 1_000,
    max: 50_000,
    step: 1_000,
    value: 12_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving at the admission layer, before any rejection.",
    format: "rps" as const,
  },
  {
    id: "capacityRps",
    label: "Service capacity",
    min: 1_000,
    max: 20_000,
    step: 1_000,
    value: 10_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests the workers can complete per second while meeting the deadline.",
    format: "rps" as const,
  },
  {
    id: "queueLimitSeconds",
    label: "Queue bound",
    min: 0.2,
    max: 60,
    step: 0.2,
    value: 5,
    unit: " s",
    group: "Admission policy",
    help: "Maximum queued work expressed in seconds at capacity. It caps the wait an admitted request can experience.",
    format: "number" as const,
  },
  {
    id: "highPriorityShare",
    label: "High-priority share",
    min: 0,
    max: 99,
    step: 1,
    value: 30,
    unit: "%",
    group: "Traffic mix",
    help: "Share of demand that must be protected, such as checkout or authentication.",
    format: "percent" as const,
  },
  {
    id: "reservedShare",
    label: "Reserved for high priority",
    min: 0,
    max: 50,
    step: 5,
    value: 0,
    unit: "%",
    group: "Admission policy",
    help: "Share of capacity that low-priority work cannot consume, so critical work has room when it arrives.",
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

interface Computed {
  demand: number;
  capacity: number;
  limitRequests: number;
  queue: number;
  queueDelay: number;
  p99: number;
  goodput: number;
  accepted: number;
  highDemand: number;
  highAccepted: number;
  highRejection: number;
  rejectionRate: number;
  reserved: number;
  lowCapacity: number;
}

function compute(p: Params, previousQueue: number, dt: number): Computed {
  const demand = Math.max(0, num(p, "demandRps", 12_000));
  const capacity = Math.max(1, num(p, "capacityRps", 10_000));
  const limitSeconds = Math.max(0.2, num(p, "queueLimitSeconds", 5));
  const highShare = clamp(num(p, "highPriorityShare", 30), 0, 99) / 100;
  const reserved = (capacity * clamp(num(p, "reservedShare", 0), 0, 50)) / 100;
  const lowCapacity = Math.max(0, capacity - reserved);
  const limitRequests = limitSeconds * capacity;
  const queue = clamp(previousQueue, 0, limitRequests);
  const highDemand = demand * highShare;
  const lowDemand = demand * (1 - highShare);
  const room = Math.max(0, limitRequests - queue) / Math.max(dt, 0.01);
  const maxInflow = capacity + room;
  const highAccepted = Math.min(highDemand, maxInflow);
  const lowAccepted = Math.min(lowDemand, lowCapacity, Math.max(0, maxInflow - highAccepted));
  const accepted = highAccepted + lowAccepted;
  const served = Math.min(capacity, queue / Math.max(dt, 0.01) + accepted);
  const nextQueue = clamp(queue + (accepted - served) * dt, 0, limitRequests);
  const queueDelay = nextQueue / capacity;
  const p99 = BASE_MS + queueDelay * 1_000;
  return {
    demand,
    capacity,
    limitRequests,
    queue: nextQueue,
    queueDelay,
    p99,
    goodput: served * Math.min(1, DEADLINE_MS / Math.max(DEADLINE_MS, p99)),
    accepted,
    highDemand,
    highAccepted,
    highRejection: highDemand > 0 ? ((highDemand - highAccepted) / highDemand) * 100 : 0,
    rejectionRate: demand > 0 ? ((demand - accepted) / demand) * 100 : 0,
    reserved,
    lowCapacity,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const latencyHealth = healthFor(values.p99, 1_500, 5_000);
  const queueHealth = healthFor(values.queueDelay, 1.5, 5);
  const priorityHealth = healthFor(values.highRejection, 0.5, 5);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client fleet",
        kind: "client",
        health: "ok",
        throughput: values.demand,
        sublabel: `${Math.round(values.demand).toLocaleString()} rps offered`,
        meta: { view: "queue" },
      },
      {
        id: "admission",
        label: "Admission queue",
        kind: "queue",
        health: priorityHealth === "ok" ? queueHealth : priorityHealth,
        utilization: clamp(values.queue / Math.max(1, values.limitRequests)),
        throughput: values.queue,
        sublabel: `${Math.round(values.queue).toLocaleString()} queued`,
        detail: `Bound ${Math.round(values.limitRequests).toLocaleString()} requests (${(values.limitRequests / values.capacity).toFixed(1)}s). High priority ${Math.round(values.highDemand).toLocaleString()} rps, ${Math.round(values.highRejection)}% rejected.`,
        meta: { view: "queue" },
      },
      {
        id: "workers",
        label: "Request workers",
        kind: "worker",
        health: latencyHealth,
        utilization: clamp(values.accepted / Math.max(1, values.capacity)),
        throughput: values.goodput,
        sublabel: `${Math.round(values.goodput).toLocaleString()} goodput rps`,
        meta: { view: "queue" },
      },
      {
        id: "rejected",
        label: "Rejected",
        kind: "external",
        health: values.rejectionRate >= 50 ? "warn" : "ok",
        throughput: values.demand - values.accepted,
        sublabel: `${Math.round(values.rejectionRate)}% of demand`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("client-admission", "client", "admission", clamp(values.demand / 50_000), queueHealth),
      edge("admission-workers", "admission", "workers", clamp(values.accepted / 50_000), latencyHealth),
      edge("admission-rejected", "admission", "rejected", clamp((values.demand - values.accepted) / 50_000), "warn"),
    ],
    metrics: [
      metric("p99", "End-to-end p99", values.p99, "ms", 1_500, 5_000, "ms"),
      metric("queue-delay", "Queue delay", values.queueDelay, "s", 1.5, 5, "number"),
      metric("high-priority-rejection", "High-priority rejection", values.highRejection, "%", 0.5, 5, "percent"),
      metric("goodput", "Goodput", values.goodput, " rps", undefined, undefined, "rps"),
      metric("queue-depth", "Queue depth", values.queue, " req", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, queue: values.queue },
    summary: `p99 ${(values.p99 / 1_000).toFixed(1)}s; queue delay ${values.queueDelay.toFixed(1)}s; ${Math.round(values.highRejection)}% high-priority rejection.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 6)) / 2.6);
  const seeds: [string, number, number][] = [
    ["p99", values.p99, 15],
    ["queue-delay", values.queueDelay, 0.05],
    ["high-priority-rejection", values.highRejection, 0.2],
    ["goodput", values.goodput, values.capacity * 0.02],
    ["queue-depth", values.queue, values.limitRequests * 0.01],
  ];
  for (const [id, value, amplitude] of seeds) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 1_500,
    crit: 5_000,
    title: "Latency is beyond the client deadline",
    cause:
      "The queue holds more work than the service can finish before clients give up. Every admitted request waits behind the backlog, so completion after the deadline is work the user never receives.",
    fix:
      "Bound the queue in seconds of work and reject new arrivals at the bound. A shorter queue rejects earlier but protects the latency of what it admits.",
    checkFirst: [
      "Compare queue delay with the client deadline.",
      "Compare admitted rate with service capacity.",
      "Check whether retries or low-priority work occupy the queue.",
    ],
  },
  {
    id: "queue-delay",
    metricId: "queue-delay",
    warn: 1.5,
    crit: 5,
    title: "Queue delay is consuming the request budget",
    cause:
      "Arrivals exceed capacity and the excess accumulates. Queue delay is the wait before work starts, and it adds directly to every accepted request.",
    fix:
      "Lower the queue bound, shed low-value traffic earlier, and reserve capacity for critical work. Do not raise the bound to hide a capacity deficit.",
    checkFirst: [
      "Check arrival rate against service rate, not queue depth alone.",
      "Check the age of the oldest queued request.",
      "Check whether the rejection policy is firing before the queue is full.",
    ],
  },
  {
    id: "high-priority-rejection",
    metricId: "high-priority-rejection",
    warn: 0.5,
    crit: 5,
    title: "The admission policy is rejecting critical work",
    cause:
      "High-priority demand exceeds capacity, or low-priority work consumed the capacity before critical work arrived. Priority labels only help if capacity is reserved or admission is ordered by class.",
    fix:
      "Reserve capacity for the critical class, shed lower priorities earlier, and add capacity or reduce work for the critical path. A queue bound alone cannot create capacity.",
    checkFirst: [
      "Split demand and acceptance by priority class.",
      "Check whether low-priority work is consuming reserved capacity.",
      "Compare critical peak demand with total capacity.",
    ],
  },
];

export const admissionControlModel: SimModel = {
  id: "foundations-admission-control",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, 0.1);
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const previousQueue = Math.max(0, Number(frame.flags.queue ?? 0));
    const values = compute(p, previousQueue, dt);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `p99 ${(values.p99 / 1_000).toFixed(1)}s; queue delay ${values.queueDelay.toFixed(1)}s; ${Math.round(values.highRejection)}% high-priority rejection.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, Math.max(0, Number(frame.flags.queue ?? 0)), 0.1);
    const items: string[] = [];
    items.push(
      `Demand is ${Math.round(values.demand).toLocaleString()} rps against ${Math.round(values.capacity).toLocaleString()} rps of capacity. The queue can hold ${Math.round(values.limitRequests).toLocaleString()} requests, or ${(values.limitRequests / values.capacity).toFixed(1)}s of work.`,
    );
    items.push(
      `Queue delay is ${values.queueDelay.toFixed(1)}s and p99 is ${(values.p99 / 1_000).toFixed(1)}s. Goodput is ${Math.round(values.goodput).toLocaleString()} rps, counting only work that finishes inside the ${(DEADLINE_MS / 1_000).toFixed(0)}s deadline.`,
    );
    if (values.highRejection > 0) {
      items.push(
        `High-priority rejection is ${values.highRejection.toFixed(1)}%. The critical class is short of capacity, not merely short of queue space.`,
      );
    } else {
      items.push(
        "High-priority rejection is zero. That does not mean the system is healthy; the queue can still be making every admitted request late.",
      );
    }
    if (values.reserved > 0) {
      items.push(
        `Low-priority work is limited to ${Math.round(values.lowCapacity).toLocaleString()} rps, leaving ${Math.round(values.reserved).toLocaleString()} rps reserved for critical work.`,
      );
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Queue building", tone: "warn" },
    { label: "Beyond deadline", tone: "crit" },
    { label: "Rejected", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "8k rps against 10k capacity. The queue stays empty and every request finishes in milliseconds.",
    tone: "ok",
    params: defaults({ demandRps: 8_000, capacityRps: 10_000, queueLimitSeconds: 5, highPriorityShare: 30, reservedShare: 0 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "16k rps against 10k with a three-second queue. The queue fills and p99 crosses the warning line.",
    tone: "warn",
    params: defaults({ demandRps: 16_000, capacityRps: 10_000, queueLimitSeconds: 3, highPriorityShare: 30, reservedShare: 0 }),
  },
  {
    id: "failure",
    label: "Unbounded queue",
    description: "30k rps against 10k with a 30-second queue. Every admitted request waits behind half a minute of work.",
    tone: "crit",
    params: defaults({ demandRps: 30_000, capacityRps: 10_000, queueLimitSeconds: 30, highPriorityShare: 20, reservedShare: 0 }),
  },
  {
    id: "priority",
    label: "Priority starved",
    description: "Critical work is 70% of 30k rps, above total capacity. The queue cannot protect it.",
    tone: "crit",
    params: defaults({ demandRps: 30_000, capacityRps: 10_000, queueLimitSeconds: 5, highPriorityShare: 70, reservedShare: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The queue is bounded at one second and 20% of capacity is reserved. Latency fits the deadline; rejection rises.",
    tone: "ok",
    params: defaults({ demandRps: 30_000, capacityRps: 10_000, queueLimitSeconds: 1, highPriorityShare: 30, reservedShare: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-queue-bound",
  title: "Predict what a shorter queue buys",
  simId: "admission-control",
  question:
    "Demand is 30k rps and capacity is 10k. The queue is bounded at 30 seconds. What happens if you shorten the bound to one second and reserve capacity for critical work?",
  prediction: {
    options: [
      { id: "capacity", label: "Service capacity rises because the queue is smaller" },
      { id: "goodput", label: "Goodput rises because admitted work finishes inside the deadline" },
      { id: "rejection", label: "Total rejection falls because fewer requests are refused" },
      { id: "high", label: "High-priority rejection rises because the queue is shorter" },
    ],
    correctOptionId: "goodput",
    explanation:
      "A shorter queue does not add capacity. It stops admitting work that would wait past the deadline, so the requests that are served finish in time and count as goodput. Total rejection rises because more arrivals are refused up front. High-priority rejection stays at zero as long as critical demand is below capacity and capacity is reserved for it.",
  },
  setup: defaults({ demandRps: 30_000, capacityRps: 10_000, queueLimitSeconds: 30, highPriorityShare: 20, reservedShare: 0 }),
  runFor: 40,
  observe: [
    "Queue delay reaches 30s and p99 crosses 30s; goodput falls toward the deadline ratio.",
    "High-priority rejection stays at zero because critical demand is only 6k rps.",
    "A one-second bound drops p99 to about 1.02s and restores goodput to capacity.",
    "Total rejection rises to roughly half the demand; that is the price of a bounded queue.",
  ],
  explain:
    "Queue delay is the product of backlog and service rate. With a 30-second bound, an admitted request can wait 30 seconds for a 2-second deadline, so most completed work is useless. A one-second bound keeps the wait inside the budget. The service still completes 10k rps, but now those completions are useful. Admission control cannot make 30k fit into 10k; it decides which 10k get a timely answer.",
  fix: defaults({ demandRps: 30_000, capacityRps: 10_000, queueLimitSeconds: 1, highPriorityShare: 30, reservedShare: 20 }),
  debrief:
    "The bounded queue protected latency and goodput, and the reservation protected the critical class. The cost is more visible rejection and a policy that must be explained to clients. A queue bound is not a capacity plan: the 20k rps gap remains, and the team still needs to reduce work, add capacity, or accept that some traffic is refused. The difference is that the refusal is early and honest instead of late and disguised as a timeout.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Admission control decides whether a request enters the service. It is the policy at the door: a bound on how much work may wait, a ranking of which work matters, and a rejection response when the door is full. It is distinct from a rate limiter, which constrains a caller over time, and from load shedding, which focuses on preserving useful throughput under overload.",
  },
  {
    type: "p",
    text: "A queue is a buffer between arrival and service. If arrivals exceed service rate and the queue has no bound, the backlog grows without limit. Queue delay adds to every request, so a request admitted at the back of a 30-second queue waits 30 seconds before work starts. If the client deadline is two seconds, the service is doing work that the client has already abandoned. The queue converts a capacity deficit into a latency outage.",
  },
  {
    type: "p",
    text: "A bound alone is not enough. When the queue is full, the service rejects whoever arrives last, which may be the most important request. A priority policy and a capacity reservation decide who gets the remaining room. The queue bound protects latency; the priority policy protects the product.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Admission control belongs at the edge of the constrained service: a frontend, an API gateway, or a worker pool. It needs the service's real capacity, the client deadline, and a classification of work. Placing it after the expensive work has already been done is too late; placing it before authentication may let unauthenticated traffic consume the policy's own capacity.",
  },
  {
    type: "table",
    headers: ["Policy", "What it protects", "What it costs", "Failure"],
    rows: [
      ["Unbounded queue", "Nothing; it only delays rejection", "Memory and latency", "Requests complete after the deadline"],
      ["Bounded queue", "Latency of admitted work", "More early rejection", "Late arrivals are refused even if important"],
      ["Priority queue", "Critical work", "Complexity and fairness questions", "Low-priority starvation"],
      ["Reserved capacity", "Critical work under contention", "Idle capacity when critical traffic is quiet", "Reservation too small or too large"],
    ],
  },
  {
    type: "p",
    text: "This module models a 10,000 rps service with a 2-second useful deadline. Demand, capacity, queue bounds, and priority shares are illustrative. The shape is the lesson: a queue bound is a latency decision, and a priority policy is a product decision.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "End-to-end p99 and queue delay: how long admitted work waits before it starts.",
      "Goodput: completed work that still arrives inside the deadline.",
      "High-priority rejection: the critical class's loss, which a total rejection rate can hide.",
      "Queue depth and the queue bound in requests, so the wait is visible in both units.",
      "Admitted, rejected, and served rates: where the excess demand goes.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Unbounded queue. Watch queue delay and goodput together; throughput stays at capacity while useful work collapses. Run the experiment before revealing the explanation, then apply Priority starved and Recovery. Compare total rejection with high-priority rejection at each step.",
  },
  {
    type: "p",
    text: "The first question is not how large the queue should be. It is how long a request may wait and still be useful. That deadline sets the bound. The second question is which work must survive when the bound is reached. That answer sets the priority policy.",
  },
  { type: "sim", simId: "admission-control" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 30k rps against 10k of capacity, the 30-second queue filled and every admitted request waited behind the backlog. The service still completed 10k requests per second, but most of them finished after the 2-second deadline, so goodput fell. High-priority rejection stayed at zero because critical demand was only 6k rps; the queue was hurting everyone equally, which is another way of saying it was protecting no one.",
  },
  {
    type: "p",
    text: "A one-second bound rejected more work up front and kept the wait inside the deadline. Goodput rose to capacity even though total rejection rose. The 20% reservation kept low-priority work from consuming the capacity reserved for critical traffic. The gap between 30k demand and 10k capacity did not close; the system simply stopped pretending it could serve all of it on time.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Request metrics: admitted, rejected, completed, and timed-out counts split by priority class.",
      "Queue metrics: depth, age of the oldest item, and the configured bound in seconds and requests.",
      "Latency: p50, p99, and the share of requests older than the deadline when they complete.",
      "Saturation: worker utilization, in-flight requests, and connection pool waits.",
      "Client metrics: timeout rate and retry volume, which reveal whether rejection is being communicated.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare queue delay with the client deadline. If the wait exceeds the deadline, the service is completing work nobody is waiting for. Then split rejection by priority: high-priority rejection means a capacity deficit, while total rejection may be the intended policy. Check whether the queue bound is enforced before the queue is full.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the useful deadline and the priority classes before choosing a queue size.",
      "Bound the queue in seconds of work at capacity, not in raw request count.",
      "Reserve capacity or a separate pool for the critical class.",
      "Shed low-priority work before the queue is full and return a clear overload response.",
      "Keep retries out of the same queue, or give them a separate budget.",
      "Load-test above capacity and verify that goodput plateaus instead of collapsing.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short queue protects latency but rejects work that might have succeeded if load fell; a long queue protects more work and risks a late outage.",
      "Priority policies encode product judgments and must be documented, or on-call engineers will invent them during the incident.",
      "Reserved capacity is idle when critical traffic is quiet; that idle capacity is the insurance premium.",
      "Rejection is cheap only if the client handles it well. A 429 without retry guidance becomes a retry storm.",
      "Admission control can keep CPU low while rejecting traffic, which may disable autoscaling signals; capacity policy and admission policy must be designed together.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "unbounded-queue",
    question:
      "The queue is 30 seconds deep and clients time out after two seconds. What should the server do right now?",
    difficulty: 3,
    hints: [
      "The queue is holding work that can no longer be useful.",
      "The fastest protection is to stop admitting more.",
    ],
    answer:
      "I would stop admitting work that cannot finish inside the deadline and return a clear overload response. That means bounding the queue in seconds of work and shedding the lowest-value traffic first. I would not add capacity as the first move unless it is available in seconds, because the queue will keep growing until then. After the immediate protection, I would split demand by priority, check whether retries are amplifying the load, and decide whether the gap is temporary or a capacity problem. The key is that rejection is cheap now and expensive after the client has already given up.",
    followUps: [
      "What queue bound would you choose?",
      "How do you avoid rejecting the critical class?",
      "What do you tell clients in the rejection response?",
    ],
    redFlags: [
      "Raises the queue limit to absorb the spike.",
      "Adds workers without checking the deadline.",
      "Rejects random requests with no priority policy.",
    ],
    rubric: [
      "Stops admitting useless work.",
      "Ties the bound to the deadline.",
      "Protects a priority class.",
      "Names the client response.",
    ],
  },
  {
    id: "priority-design",
    question:
      "How do you design priorities for an API that serves checkout, search, and analytics?",
    difficulty: 3,
    hints: [
      "Rank by the cost of a late or missing response.",
      "A priority label is only useful if capacity is reserved.",
    ],
    answer:
      "I would rank by product impact: checkout and authentication are critical, search is important but degradable, and analytics is deferrable. I would give the critical class reserved concurrency or capacity, put analytics on a separate queue or pool, and shed analytics first when the queue fills. I would also cap the critical class so it cannot monopolize the service, and I would make the classification explicit in the request rather than trusting a client-supplied header. The policy has to be documented with the product owner, because it decides who gets an error during an incident.",
    followUps: [
      "How do you prevent a client from claiming the critical label?",
      "What happens when checkout demand alone exceeds capacity?",
      "How would you measure fairness between tenants?",
    ],
    redFlags: [
      "Makes every request high priority.",
      "Uses CPU as the only admission signal.",
      "Has no deferral path for low-priority work.",
    ],
    rubric: [
      "Ranks by product impact.",
      "Reserves capacity for critical work.",
      "Separates deferrable work.",
      "Defines the error experience.",
    ],
  },
  {
    id: "goodput",
    question:
      "The service reports 10k completed requests per second and 30k offered. Why might the product still be down?",
    difficulty: 2,
    hints: [
      "Completion is not the same as usefulness.",
      "Compare completion time with the deadline.",
    ],
    answer:
      "The completions may all be later than the client deadline. If the queue wait is 30 seconds and clients time out at two seconds, the server is finishing work that no one receives. Throughput counts server completions; goodput counts completions that are still useful. I would check queue delay, p99, timeout rate, and the share of requests older than the deadline. The fix is to bound the queue and reject early, not to celebrate the completion rate.",
    followUps: [
      "How would you measure goodput directly?",
      "What happens to retries in this state?",
      "Which metric would you alert on?",
    ],
    redFlags: [
      "Equates throughput with availability.",
      "Ignores the deadline.",
      "Adds capacity without checking queue delay.",
    ],
    rubric: [
      "Distinguishes throughput from goodput.",
      "Uses the deadline.",
      "Names timeout and retry effects.",
      "Chooses a user-centered metric.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The useful deadline is documented for every request class.",
      "The queue is bounded in seconds of work at capacity.",
      "Traffic is ranked by value and the shed order is written down.",
      "The critical class has reserved capacity or a separate pool.",
      "Goodput, rejection, and queue age are dashboarded by priority.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare queue delay with the client deadline before adding capacity.",
      "Check whether the queue bound is enforced before the queue is full.",
      "Split rejection by priority; critical rejection is a capacity deficit.",
      "Return a clear overload response and suppress immediate retries.",
      "Record which classes were rejected and for how long.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that goodput plateaued rather than collapsed.",
      "Review whether the queue bound or priority policy was too late.",
      "Check the deferred class for starvation and backlog age.",
      "Reconcile admission policy with autoscaling and capacity headroom.",
    ],
  },
];

const references = [
  {
    title: "Handling overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Criticality, client-side throttling, and rejecting excess work.",
  },
  {
    title: "Using load shedding to avoid overload",
    url: "https://aws.amazon.com/builders-library/using-load-shedding-to-avoid-overload/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Goodput, queue bounds, and overload testing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "admission-control": {
      model: admissionControlModel,
      presets,
      instructions:
        "Start healthy, then apply Unbounded queue. Watch goodput and queue delay together. Run the experiment, then compare Priority starved and Recovery. Split rejection by priority before calling the incident resolved.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Capacity, deadline, and queue bounds are teaching values, not a vendor limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-load-shedding",
    "foundations-queueing-knee",
    "reliability-load-shedding",
    "foundations-backpressure",
  ],
};
