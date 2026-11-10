import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_MS = 50;
const DEADLINE_MS = 2_000;
const STALL_MS = 60_000;

const params = [
  {
    id: "demandRps",
    label: "Offered demand",
    min: 2_000,
    max: 40_000,
    step: 1_000,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the service, including work the product can defer.",
    format: "rps" as const,
  },
  {
    id: "capacityRps",
    label: "Service capacity",
    min: 2_000,
    max: 20_000,
    step: 1_000,
    value: 10_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests the service can complete per second while meeting its deadline.",
    format: "rps" as const,
  },
  {
    id: "queueLimit",
    label: "Queue limit",
    min: 0.5,
    max: 30,
    step: 0.5,
    value: 5,
    unit: " s",
    group: "Admission policy",
    help: "Maximum queue expressed as seconds of work at service capacity. It bounds how long a request can wait.",
    format: "number" as const,
  },
  {
    id: "shedAtFill",
    label: "Shed at queue fill",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Admission policy",
    help: "Queue fill at which low-priority traffic is rejected. One hundred percent sheds only when the queue is full.",
    format: "percent" as const,
  },
  {
    id: "lowPriorityShare",
    label: "Low-priority share",
    min: 0,
    max: 90,
    step: 5,
    value: 30,
    unit: "%",
    group: "Traffic mix",
    help: "Share of demand that is deferrable, such as analytics or background sync. High priority is served first.",
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
  queue: number;
  queueDelay: number;
  p99: number;
  goodput: number;
  highPriorityRejection: number;
  rejectionRate: number;
  accepted: number;
  demand: number;
  capacity: number;
  limitRequests: number;
  shedPoint: number;
  shedding: boolean;
}

function compute(p: Params, previousQueue: number, previousShedding: boolean, dt: number): Computed {
  const demand = Math.max(0, num(p, "demandRps", 8_000));
  const capacity = Math.max(1, num(p, "capacityRps", 10_000));
  const limitSeconds = Math.max(0.5, num(p, "queueLimit", 5));
  const shedAtFill = clamp(num(p, "shedAtFill", 100), 0, 100);
  const lowShare = clamp(num(p, "lowPriorityShare", 30), 0, 90) / 100;
  const limitRequests = limitSeconds * capacity;
  const shedPoint = limitRequests * (shedAtFill / 100);
  const queue = clamp(previousQueue, 0, limitRequests);
  const highDemand = demand * (1 - lowShare);
  const lowDemand = demand * lowShare;
  const shedding = previousShedding ? queue > shedPoint * 0.9 : queue >= shedPoint;

  let acceptedHigh = highDemand;
  let acceptedLow = shedding ? 0 : lowDemand;
  const room = Math.max(0, (limitRequests - queue) / Math.max(dt, 0.01));
  const maxInflow = capacity + room;
  const offered = acceptedHigh + acceptedLow;
  if (offered > maxInflow) {
    const total = maxInflow;
    acceptedHigh = Math.min(highDemand, total);
    acceptedLow = Math.max(0, total - acceptedHigh);
  }

  const accepted = acceptedHigh + acceptedLow;
  const served = Math.min(capacity, queue / Math.max(dt, 0.01) + accepted);
  const nextQueue = clamp(queue + (accepted - served) * dt, 0, limitRequests);
  const queueDelay = nextQueue / capacity;
  const p99 = Math.min(STALL_MS, BASE_MS + queueDelay * 1_000);
  const goodput = served * Math.min(1, DEADLINE_MS / Math.max(DEADLINE_MS, queueDelay * 1_000));
  const highRejected = Math.max(0, highDemand - acceptedHigh);
  return {
    queue: nextQueue,
    queueDelay,
    p99,
    goodput,
    highPriorityRejection: highDemand > 0 ? (highRejected / highDemand) * 100 : 0,
    rejectionRate: demand > 0 ? ((demand - accepted) / demand) * 100 : 0,
    accepted,
    demand,
    capacity,
    limitRequests,
    shedPoint,
    shedding,
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
      Math.max(0, value * (0.97 + 0.05 * Math.sin((index + 2) / 2.6))),
    );
  }
}

function buildFrame(c: Computed, seedValue: number): SimFrame {
  const queueHealth = healthFor(c.highPriorityRejection, 0.5, 5);
  const serviceHealth = healthFor(c.p99, 700, 2_000);
  return {
    t: 0,
    nodes: [
      {
        id: "frontend",
        label: "Frontend",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(c.accepted / Math.max(1, c.capacity)),
        throughput: c.accepted,
        sublabel: `${Math.round(c.accepted).toLocaleString()} admitted rps`,
        detail: `Offered ${Math.round(c.demand).toLocaleString()} rps; capacity ${Math.round(c.capacity).toLocaleString()} rps; ${Math.round(c.rejectionRate)}% rejected.`,
        meta: { view: "flow" },
      },
      {
        id: "admission",
        label: "Admission queue",
        kind: "queue",
        health: queueHealth,
        throughput: c.accepted,
        sublabel: `${Math.round(c.queue).toLocaleString()} waiting`,
        detail: `Queue limit ${Math.round(c.limitRequests).toLocaleString()} requests (${Math.round(c.limitRequests / c.capacity)}s of work). Low-priority traffic sheds at ${Math.round(c.shedPoint).toLocaleString()} requests.`,
        meta: { view: "queue" },
      },
      {
        id: "workers",
        label: "Request workers",
        kind: "worker",
        health: serviceHealth,
        utilization: clamp(c.accepted / Math.max(1, c.capacity)),
        throughput: c.goodput,
        sublabel: `${Math.round(c.goodput).toLocaleString()} goodput rps`,
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge("frontend-admission", "frontend", "admission", clamp(c.demand / 40_000), serviceHealth),
      edge("admission-workers", "admission", "workers", clamp(c.accepted / Math.max(1, c.capacity)), serviceHealth),
    ],
    metrics: [
      metric("p99", "End-to-end p99", c.p99, "ms", 700, 2_000, "ms"),
      metric("queue-delay", "Queue delay", c.queueDelay, "s", 1, 3, "number"),
      metric("high-priority-rejection", "High-priority rejection", c.highPriorityRejection, "%", 0.5, 5, "percent"),
      metric("goodput", "Goodput", c.goodput, " rps", undefined, undefined, "rps"),
      metric("queueDepth", "Queue depth", c.queue, " req", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed: seedValue, queue: c.queue, shedding: c.shedding ? 1 : 0 },
    summary: `${Math.round(c.goodput).toLocaleString()} rps goodput; queue delay ${c.queueDelay.toFixed(1)}s; ${Math.round(c.highPriorityRejection)}% high-priority rejection.`,
  };
}

function frameValues(c: Computed): Record<string, number> {
  return {
    p99: c.p99,
    "queue-delay": c.queueDelay,
    "high-priority-rejection": c.highPriorityRejection,
    goodput: c.goodput,
    queueDepth: c.queue,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 700,
    crit: 2_000,
    title: "End-to-end latency is beyond the useful deadline",
    cause:
      "The queue is holding more work than the service can finish before clients give up. Completed requests no longer count as useful throughput when they finish after the deadline.",
    fix:
      "Bound the queue in seconds of work, shed low-value traffic before the bound, and reject early enough that accepted requests can still meet the deadline.",
    checkFirst: [
      "Compare queue delay with the client deadline.",
      "Check admitted rate against service capacity.",
      "Check whether the queue is shared with retries or low-priority work.",
    ],
  },
  {
    id: "queue-delay",
    metricId: "queue-delay",
    warn: 1,
    crit: 3,
    title: "Queue delay is consuming the request budget",
    cause:
      "Arrivals exceed service capacity and the excess accumulates. The queue delay is the wait before work starts, so it adds directly to every accepted request.",
    fix:
      "Reduce the queue bound and shed earlier. A shorter queue rejects more work up front but protects the latency of what it admits.",
    checkFirst: [
      "Check arrival rate versus service rate, not queue depth alone.",
      "Check queue age and whether clients have already timed out.",
      "Check whether the shed policy is firing at all.",
    ],
  },
  {
    id: "high-priority-rejection",
    metricId: "high-priority-rejection",
    warn: 0.5,
    crit: 5,
    title: "The admission policy is rejecting critical work",
    cause:
      "High-priority demand exceeds capacity, or the queue is full before low-priority shedding can protect the critical class. Shedding cannot create capacity that is not there.",
    fix:
      "Reserve capacity for the critical class, shed lower priorities earlier, and add capacity or reduce work for high-priority traffic. Do not raise the queue limit to hide the deficit.",
    checkFirst: [
      "Split demand and acceptance by priority class.",
      "Check whether low-priority work is still consuming capacity.",
      "Check the critical class's peak demand against capacity.",
    ],
  },
];

export const loadSheddingModel: SimModel = {
  id: "foundations-load-shedding",
  visual: "queue",
  params,
  init: ({ seed: seedValue }) => {
    const values = compute(defaults(), 0, false, 0.1);
    const frame = buildFrame(values, seedValue);
    seed(frame, frameValues(values));
    return frame;
  },
  step: (frame, p, dt) => {
    const previousQueue = Math.max(0, Number(frame.flags.queue ?? 0));
    const previousShedding = Number(frame.flags.shedding ?? 0) === 1;
    const values = compute(p, previousQueue, previousShedding, dt);
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
  insights: (frame, p) => {
    const values = compute(
      p,
      Math.max(0, Number(frame.flags.queue ?? 0)),
      Number(frame.flags.shedding ?? 0) === 1,
      0.1,
    );
    const items: string[] = [];
    items.push(
      `Demand is ${Math.round(values.demand).toLocaleString()} rps against ${Math.round(values.capacity).toLocaleString()} rps of capacity. The queue can hold ${Math.round(values.limitRequests).toLocaleString()} requests, or ${Math.round(values.limitRequests / values.capacity)}s of work.`,
    );
    if (values.shedPoint < values.limitRequests) {
      items.push(
        `Low-priority traffic is shed when the queue reaches ${Math.round(values.shedPoint).toLocaleString()} requests. That is the point where the policy trades rejection for latency.`,
      );
    } else {
      items.push("The shed trigger is at the queue limit, so the system admits low-priority work until the queue is already full.");
    }
    items.push(
      `High-priority rejection is ${values.highPriorityRejection.toFixed(1)}%. If it is above zero, the critical class is short of capacity, not short of queue space.`,
    );
    items.push(
      "Goodput counts responses that arrive before the deadline. A response after the client gives up is throughput on the server and waste for the user.",
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
    description: "8k rps against 10k capacity; the queue stays empty.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "12k rps with early shedding. The queue hovers near one second.",
    tone: "warn",
    params: defaults({ demandRps: 12_000, queueLimit: 2, shedAtFill: 50 }),
  },
  {
    id: "failure",
    label: "No shedding",
    description: "30k rps against 10k capacity with the shed trigger at the queue limit.",
    tone: "crit",
    params: defaults({ demandRps: 30_000, queueLimit: 15, shedAtFill: 100 }),
  },
  {
    id: "early-shed",
    label: "Shed low priority",
    description: "The same overload, but cheap work is rejected at 20% queue fill.",
    tone: "warn",
    params: defaults({ demandRps: 30_000, queueLimit: 15, shedAtFill: 20, lowPriorityShare: 70 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A one-second queue and 10% shed trigger keep delay inside the deadline.",
    tone: "ok",
    params: defaults({ demandRps: 30_000, queueLimit: 1, shedAtFill: 10, lowPriorityShare: 70 }),
  },
];

const experiment: Experiment = {
  id: "predict-shedding",
  title: "Predict what early shedding buys",
  simId: "load-shedding",
  question:
    "Demand is 30k rps and capacity is 10k. The queue is unbounded in practice. What does shedding low-priority work at 20% queue fill improve?",
  prediction: {
    options: [
      { id: "goodput", label: "Goodput rises because more accepted work finishes in time" },
      { id: "capacity", label: "Service capacity rises because the queue is shorter" },
      { id: "errors", label: "All errors disappear because low-priority work is gone" },
      { id: "latency", label: "p99 falls below the deadline for every remaining request" },
    ],
    correctOptionId: "goodput",
    explanation:
      "Shedding does not add capacity. It removes work that would have waited past its deadline, so the queue stays shorter and a larger share of the work that is served finishes in time. Goodput rises even though p99 can remain above the deadline and some requests are still rejected.",
  },
  setup: defaults({ demandRps: 30_000, queueLimit: 15, shedAtFill: 100, lowPriorityShare: 70 }),
  runFor: 30,
  observe: [
    "Goodput rises from roughly 1.3k rps to about 6.6k rps.",
    "Queue delay falls from 15s to roughly 3s.",
    "High-priority rejection stays at zero because high demand is 9k rps, below capacity.",
    "Total rejection rises: more low-priority work is refused earlier.",
  ],
  explain:
    "The deadline is what makes a completed request useful. Without shedding, the queue waits 15s, so only a small fraction of served requests finish before the 2s deadline. Shedding at 20% keeps the wait near 3s, which is still above the deadline but short enough that most served work is useful. The remaining latency is a capacity problem, not an admission problem.",
  fix: defaults({ demandRps: 30_000, queueLimit: 15, shedAtFill: 20, lowPriorityShare: 70 }),
  debrief:
    "Early shedding protected goodput and the critical class, but it did not make the system fast. The queue still exceeded the deadline because high-priority demand was close to capacity. The correct next step is to reduce work or add capacity for the critical class, while keeping the shed policy as the safety net. Rejection is a product decision: the team must be able to name which work is deferrable and what the user sees.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Load shedding is admission control under pressure. When demand exceeds what the service can finish before the client's deadline, the service rejects some work early instead of accepting all of it and finishing none of it on time. The goal is goodput: the subset of throughput that completes with an acceptable result before the deadline.",
  },
  {
    type: "p",
    text: "The failure it prevents is the queue collapse. A service that accepts everything grows a queue, and queue delay adds to every request. Once delay exceeds the client timeout, the server is doing work that the client has already abandoned; retries add more work to the same queue. Throughput can stay high while goodput falls toward zero. Shedding breaks that feedback loop by refusing work while rejection is still cheap.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Admission control belongs at the edge of the service that owns the constrained resource, or at a shared proxy in front of it. It needs two inputs: a bound on queued work, expressed in time rather than count, and a ranking of traffic by value. The bound keeps latency inside the deadline; the ranking decides who is refused when the bound is reached. A queue limit without a priority policy is still shedding, but it sheds whoever arrives last.",
  },
  {
    type: "table",
    headers: ["Policy", "What happens under overload", "Goodput", "Risk"],
    rows: [
      ["Accept everything", "Queue grows, latency exceeds the deadline, clients retry", "Collapses", "Wasted work and a longer outage"],
      ["Queue limit only", "New arrivals are rejected when the queue is full", "Stabilizes late", "Critical and low-value work are treated the same"],
      ["Early low-priority shedding", "Cheap work is refused before the queue fills", "Stays near capacity", "Fairness and over-shedding need review"],
      ["Priority reservation", "Critical work has capacity the rest cannot consume", "Protects the critical path", "Idle capacity when the critical class is quiet"],
    ],
  },
  {
    type: "p",
    text: "This module models a 10,000 rps service with a 2s useful deadline and a queue measured in seconds of work. Those values are illustrative. The shape is the lesson: queue delay converts capacity into latency, and a deadline converts late completions into waste.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Goodput in rps: completed work that is still useful to the client.",
      "End-to-end p99 and queue delay: the wait before work starts, which dominates the tail.",
      "High-priority rejection: the critical class's availability loss, which shedding low-value work should not cause.",
      "Queue depth in requests: capacity context, not a user-facing signal by itself.",
      "Admitted rate at the frontend and queue nodes, which shows where the excess is going.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No shedding. Watch the queue delay and goodput together: throughput remains at capacity while goodput collapses. Run the experiment before revealing the answer, then apply Shed low priority and compare goodput, p99, and rejection. Finish with Recovery and note that goodput is protected while the system is still working above its comfortable utilization.",
  },
  { type: "sim", simId: "load-shedding" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Without shedding, 30k rps arrived at a 10k rps service. The queue filled to 15 seconds of work, and each accepted request waited behind that backlog. The server still completed about 10k requests per second, but almost all of them finished after the 2s deadline, so goodput fell to roughly 1.3k rps. The queue turned capacity into waste.",
  },
  {
    type: "p",
    text: "Shedding low-priority work at 20% queue fill kept the queue near 3 seconds. Goodput rose to about 6.6k rps, and high-priority rejection stayed at zero because high-priority demand was 9k rps, below capacity. The remaining 3s delay is the honest signal: admission control protected goodput and fairness, but it could not make 30k rps fit into 10k rps.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Request metrics: admitted rate, rejected rate, queue wait, p99, and completion status split by priority.",
      "Saturation signals: worker utilization, in-flight requests, queue age, and the rate of requests older than the deadline.",
      "Client metrics: timeout rate and retry volume. A retry spike after shedding usually means the rejection was not communicated clearly.",
      "Load balancer and proxy metrics: HTTP 503 or 429 counts, surge queue depth, and spillover.",
      "Business metrics: completed searches, checkouts, or syncs per second, which are the real goodput numbers.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare queue delay with the client deadline. If delay exceeds the deadline, the service is doing work that no longer counts. Check whether low-priority or retry traffic is occupying the queue, and whether the shed policy is firing before the queue is full. Then split rejection by priority: high-priority rejection means the critical class is short of capacity, not merely short of queue space.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the useful deadline and the work that can be deferred before choosing a queue size.",
      "Bound the queue in seconds of work so its maximum wait is explicit.",
      "Rank traffic by value and shed the lowest class first, before the queue fills.",
      "Reserve capacity or concurrency for the critical class so low-priority work cannot consume it.",
      "Return a clear rejection with a retry hint or a deferral message; do not let clients retry into the same queue.",
      "Load-test beyond capacity and verify that goodput plateaus instead of collapsing.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Shedding early rejects work that might have succeeded if the load had fallen; a late trigger protects more work but risks a deep queue.",
      "Priority schemes encode product and business judgments. They must be documented, or on-call engineers will make them under pressure.",
      "Shedding can disable reactive autoscaling by keeping CPU low while rejecting traffic; capacity policy and admission policy must be designed together.",
      "Rejection has a cost too. If refusing a request is expensive, a large shed volume can consume the capacity it was meant to protect.",
      "Goodput can plateau while p99 remains above the deadline. That is an improvement, not a full recovery; capacity or work reduction is still required.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-shed-policy",
    question:
      "Demand is three times capacity. How do you decide which requests to shed?",
    difficulty: 3,
    hints: [
      "Start with the deadline and the product promise.",
      "Rank by value, then by cost to retry.",
    ],
    answer:
      "I would first define the deadline and the classes of work. The critical class gets reserved capacity or a higher admission threshold; deferrable work is shed first, and retries are treated as a separate class so they cannot amplify the load. I would shed before the queue is full, return a clear overload response, and avoid retrying inside the same service. The policy has to be a product decision: which requests can fail without breaking a promise, and what the user sees. I would then load-test the policy to confirm that goodput plateaus and high-priority rejection stays near zero.",
    followUps: [
      "How do you prevent a client from gaming the priority label?",
      "What would you shed first on a checkout path?",
      "How do you measure whether the policy is fair?",
    ],
    redFlags: [
      "Sheds whatever arrives last.",
      "Uses CPU alone as the trigger.",
      "Retries rejected work immediately.",
    ],
    rubric: [
      "Ties shedding to the deadline.",
      "Ranks work by value.",
      "Protects the critical class.",
      "Defines the client response.",
    ],
  },
  {
    id: "goodput-vs-throughput",
    question:
      "The service reports 10k rps completed and a 30k rps offered rate. Why might the product still be down?",
    difficulty: 2,
    hints: [
      "Completion is not the same as usefulness.",
      "Look at the deadline and the tail.",
    ],
    answer:
      "The 10k completions may all be arriving after the client deadline. If the queue wait is 15 seconds and clients time out at 2 seconds, the server is finishing work that no one is waiting for. Throughput counts server completions; goodput counts completions that are still useful. I would check queue delay, p99, timeout rate, and the share of requests older than the deadline. The product is down because users are getting errors or abandoned responses even though the server is busy.",
    followUps: [
      "How would you measure goodput directly?",
      "What happens to retries in this state?",
      "Which metric would you alert on?",
    ],
    redFlags: [
      "Equates throughput with availability.",
      "Ignores the client deadline.",
      "Adds capacity without checking queue delay.",
    ],
    rubric: [
      "Distinguishes throughput from goodput.",
      "Uses the deadline.",
      "Names timeout and retry effects.",
      "Chooses a user-centered metric.",
    ],
  },
  {
    id: "fairness",
    question:
      "Your shed policy rejects low-priority traffic first. A customer says their batch jobs never finish. How do you respond?",
    difficulty: 3,
    hints: [
      "Fairness is a design property, not an accident.",
      "A deferrable class still needs a completion path.",
    ],
    answer:
      "I would confirm that the policy is behaving as designed and then examine whether the design is fair. If batch work is always shed, it has no completion path; the policy has effectively removed a product feature. I would give batch a reserved share, a separate queue, or a deferral window, and I would expose its rejection and completion metrics. The critical class should be protected, but the low-priority class still needs a bound on starvation. That may mean accepting lower utilization or paying for separate capacity; those are the tradeoffs to bring to the product owner.",
    followUps: [
      "How would you detect starvation?",
      "What is a fair deferral window?",
      "Would you rather reserve capacity or use a separate fleet?",
    ],
    redFlags: [
      "Says batch is low priority and can fail forever.",
      "Hides the rejection rate.",
      "Adds capacity without a fairness policy.",
    ],
    rubric: [
      "Confirms the observed policy behavior.",
      "Recognizes starvation as a design failure.",
      "Proposes a bounded completion path.",
      "States the cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The useful deadline is documented for each request class.",
      "The queue is bounded in time, not only in count.",
      "Traffic is ranked by value and the shed order is written down.",
      "The critical class has reserved capacity or a separate pool.",
      "Goodput, rejection, and queue age are dashboarded by priority.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare queue delay with the client deadline before adding capacity.",
      "Check whether the shed policy is firing before the queue is full.",
      "Split rejection by priority; high-priority rejection is a capacity deficit.",
      "Return a clear overload response and suppress immediate retries.",
      "Record which classes were shed and for how long.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that goodput plateaued rather than collapsed.",
      "Review whether the shed trigger was too late or too aggressive.",
      "Check the deferred class for starvation and backlog age.",
      "Reconcile the admission policy with autoscaling and capacity headroom.",
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
    note: "Goodput, positive feedback loops, queue bounds, and overload testing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "load-shedding": {
      model: loadSheddingModel,
      presets,
      instructions:
        "Start healthy, apply No shedding, and watch goodput collapse while throughput stays at capacity. Then compare Shed low priority and Recovery. Read queue delay with p99, not queue depth alone.",
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
    "foundations-queueing-knee",
    "foundations-admission-control",
    "reliability-load-shedding",
    "foundations-bulkheads",
  ],
};
