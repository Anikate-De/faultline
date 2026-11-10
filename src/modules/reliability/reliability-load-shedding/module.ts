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

const BASE_MS = 60;
const DEADLINE_MS = 1_500;
const QUEUE_LIMIT_SEC = 2;

const params: ParamSpec[] = [
  {
    id: "demandRps",
    label: "Offered demand",
    min: 5_000,
    max: 60_000,
    step: 1_000,
    value: 18_000,
    unit: " rps",
    group: "Incident load",
    help: "Requests arriving during the incident, including work the product can defer.",
    format: "rps",
  },
  {
    id: "capacityRps",
    label: "Service capacity",
    min: 5_000,
    max: 40_000,
    step: 1_000,
    value: 24_000,
    unit: " rps",
    group: "Incident load",
    help: "Requests the service can finish per second while meeting the deadline.",
    format: "rps",
  },
  {
    id: "criticalSharePct",
    label: "Critical traffic share",
    min: 10,
    max: 80,
    step: 5,
    value: 35,
    unit: "%",
    group: "Traffic ranking",
    help: "Share of demand that belongs to the critical path, such as checkout or authentication.",
    format: "percent",
  },
  {
    id: "shedTriggerPct",
    label: "Shed trigger",
    min: 10,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Shed policy",
    help: "Queue fill at which low-priority work is rejected. One hundred percent sheds only when the queue is full.",
    format: "percent",
  },
  {
    id: "shedSharePct",
    label: "Low-priority shed share",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Shed policy",
    help: "Share of low-priority traffic refused once the trigger fires. Zero keeps admitting all of it.",
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
  demand: number;
  capacity: number;
  criticalShare: number;
  highDemand: number;
  lowDemand: number;
  limitRequests: number;
  triggerRequests: number;
  shedding: boolean;
  acceptedHigh: number;
  acceptedLow: number;
  accepted: number;
  served: number;
  queueDepth: number;
  queueDelay: number;
  p99: number;
  criticalErrors: number;
  rejection: number;
  goodput: number;
}

function compute(
  p: Params,
  previousQueue: number,
  previousShedding: boolean,
  dt: number,
): Computed {
  const demand = Math.max(0, num(p, "demandRps", 18_000));
  const capacity = Math.max(1, num(p, "capacityRps", 24_000));
  const criticalShare = clamp(num(p, "criticalSharePct", 35), 0, 100) / 100;
  const shedTrigger = clamp(num(p, "shedTriggerPct", 90), 0, 100);
  const shedShare = clamp(num(p, "shedSharePct", 100), 0, 100) / 100;
  const highDemand = demand * criticalShare;
  const lowDemand = demand - highDemand;
  const limitRequests = capacity * QUEUE_LIMIT_SEC;
  const triggerRequests = limitRequests * (shedTrigger / 100);
  const queue = clamp(previousQueue, 0, limitRequests);
  const shedding = previousShedding ? queue > triggerRequests * 0.9 : queue >= triggerRequests;

  let acceptedHigh = highDemand;
  let acceptedLow = shedding ? lowDemand * (1 - shedShare) : lowDemand;
  const room = Math.max(0, (limitRequests - queue) / Math.max(dt, 0.01));
  const maxInflow = capacity + room;
  if (acceptedHigh + acceptedLow > maxInflow) {
    acceptedHigh = Math.min(highDemand, maxInflow);
    acceptedLow = Math.max(0, maxInflow - acceptedHigh);
  }

  const accepted = acceptedHigh + acceptedLow;
  const served = Math.min(capacity, queue / Math.max(dt, 0.01) + accepted);
  const queueDepth = clamp(queue + (accepted - served) * dt, 0, limitRequests);
  const queueDelay = queueDepth / capacity;
  const waitMs = queueDelay * 1_000;
  const p99 = Math.min(30_000, BASE_MS + waitMs);
  const lateShare = clamp((waitMs - DEADLINE_MS) / DEADLINE_MS, 0, 1);
  const rejectedHigh = Math.max(0, highDemand - acceptedHigh);
  const criticalErrors =
    highDemand > 0 ? clamp((rejectedHigh / highDemand + lateShare * 0.7) * 100, 0, 100) : 0;
  const usefulShare = clamp(DEADLINE_MS / Math.max(DEADLINE_MS, waitMs), 0.05, 1);

  return {
    demand,
    capacity,
    criticalShare,
    highDemand,
    lowDemand,
    limitRequests,
    triggerRequests,
    shedding,
    acceptedHigh,
    acceptedLow,
    accepted,
    served,
    queueDepth,
    queueDelay,
    p99,
    criticalErrors,
    rejection: demand > 0 ? ((demand - accepted) / demand) * 100 : 0,
    goodput: served * usefulShare,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seedValue: number, t: number): SimFrame {
  const criticalHealth = healthFor(c.criticalErrors, 0.5, 2);
  const latencyHealth = healthFor(c.p99, 800, 1_500);
  const queueHealth = healthFor(c.queueDelay, 0.8, 1.6);
  const workerUtil = clamp(c.served / Math.max(1, c.capacity));
  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        sublabel: `${Math.round(c.demand).toLocaleString("en-US")} rps offered`,
        meta: { view: "flow" },
      },
      {
        id: "gateway",
        label: "API gateway",
        kind: "service",
        health: criticalHealth,
        utilization: clamp(c.accepted / Math.max(1, c.capacity)),
        throughput: c.accepted,
        sublabel: `${Math.round(c.accepted).toLocaleString("en-US")} rps admitted`,
        detail: `Critical traffic is ${Math.round(c.criticalShare * 100)}% of demand. The shed policy is ${c.shedding ? "active" : "idle"}.`,
        meta: { view: "flow" },
      },
      {
        id: "admission",
        label: "Admission queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(c.queueDepth / Math.max(1, c.limitRequests)),
        throughput: c.accepted,
        sublabel: `${Math.round(c.queueDepth).toLocaleString("en-US")} waiting`,
        detail: `The queue is bounded at ${Math.round(c.limitRequests).toLocaleString("en-US")} requests, or ${QUEUE_LIMIT_SEC}s of work. Low-priority shedding starts at ${Math.round(c.triggerRequests).toLocaleString("en-US")} waiting.`,
        meta: { view: "queue" },
      },
      {
        id: "workers",
        label: "Request workers",
        kind: "worker",
        health: latencyHealth,
        utilization: workerUtil,
        throughput: c.served,
        sublabel: `${Math.round(c.served).toLocaleString("en-US")} rps served`,
        detail: `Completed work before the useful deadline is ${Math.round(c.goodput).toLocaleString("en-US")} rps. The rest is throughput the user has already abandoned.`,
        meta: { view: "flow" },
      },
      {
        id: "deferred",
        label: "Deferred work",
        kind: "worker",
        health: c.shedding ? "warn" : "ok",
        utilization: clamp(c.acceptedLow / Math.max(1, c.lowDemand || 1)),
        throughput: c.acceptedLow,
        sublabel: c.shedding ? "partly refused" : "fully admitted",
        detail:
          "Low-priority work such as analytics, recommendations, and background sync. It is the first class to drop under pressure.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge(
        "client-gateway",
        "client",
        "gateway",
        clamp(c.demand / Math.max(1, c.capacity)),
        criticalHealth,
      ),
      edge(
        "gateway-admission",
        "gateway",
        "admission",
        clamp(c.accepted / Math.max(1, c.capacity)),
        queueHealth,
      ),
      edge("admission-workers", "admission", "workers", workerUtil, latencyHealth),
      edge(
        "gateway-deferred",
        "gateway",
        "deferred",
        clamp(c.acceptedLow / Math.max(1, c.lowDemand || 1)),
        c.shedding ? "warn" : "ok",
      ),
    ],
    metrics: [
      metric("critical-errors", "Critical-path errors", c.criticalErrors, "%", 0.5, 2, "percent"),
      metric("queue-delay", "Queue delay", c.queueDelay, "s", 0.8, 1.6, "number"),
      metric("p99", "End-to-end p99", c.p99, "ms", 800, 1_500, "ms"),
      metric("goodput", "Useful throughput", c.goodput, " rps", undefined, undefined, "rps"),
      metric("queueDepth", "Queue depth", c.queueDepth, " req", undefined, undefined, "count"),
      metric(
        "low-priority-accepted",
        "Low-priority admitted",
        c.acceptedLow,
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
      queue: c.queueDepth,
      shedding: c.shedding ? 1 : 0,
    },
    summary: `${Math.round(c.criticalErrors).toFixed(1)}% critical errors; queue delay ${c.queueDelay.toFixed(1)}s; ${Math.round(c.goodput).toLocaleString("en-US")} rps useful throughput.`,
  };
}

function seedSeries(frame: SimFrame, seedValue: number): void {
  const phase = seedValue % 9;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.96 + 0.06 * Math.sin((index + phase) / 3.1))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "critical-errors",
    metricId: "critical-errors",
    warn: 0.5,
    crit: 2,
    title: "The critical path is failing",
    cause:
      "Critical work is being rejected or completed after its deadline. The queue is shared with lower-value requests, so deferrable work is consuming the capacity the critical path needs.",
    fix: "Shed low-priority work earlier, reserve capacity for the critical class, and confirm that the critical class is not itself above capacity. Raising the queue limit makes the failure slower, not smaller.",
    checkFirst: [
      "Split demand and errors by request class before changing the shed policy.",
      "Check whether the queue is full of deferrable work or retries.",
      "Check whether critical demand alone exceeds service capacity.",
    ],
  },
  {
    id: "queue-delay",
    metricId: "queue-delay",
    warn: 0.8,
    crit: 1.6,
    title: "Queue delay is consuming the request budget",
    cause:
      "Arrivals exceed service capacity and the excess accumulates ahead of work that has not started. Once the wait exceeds the client deadline, the service is doing work for users who have already given up.",
    fix: "Lower the shed trigger and bound the queue in seconds of work. Protect the critical class first, then refuse deferrable work before the queue reaches the point where every request is late.",
    checkFirst: [
      "Compare queue delay with the client deadline.",
      "Check arrival rate against service rate rather than queue depth alone.",
      "Check whether the shed policy is firing before the queue is full.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 800,
    crit: 1_500,
    title: "The tail is beyond the useful deadline",
    cause:
      "The queue wait is added to every accepted request. The tail grows faster than the average because some requests wait behind the entire backlog.",
    fix: "Reduce the queue bound and shed earlier. Preserve the critical class even if total admitted throughput falls, and tell customers which work is deferred.",
    checkFirst: [
      "Check whether the slow requests are the critical class or deferrable work.",
      "Check queue age rather than average latency.",
      "Check whether a retry policy is adding work to the same queue.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-incident-shedding",
  title: "Predict what incident shedding protects",
  simId: "load-shedding-incident",
  question:
    "Demand is 50k rps and capacity is 20k rps. Critical traffic is 35% of demand. The team sheds low-priority work at 30% queue fill instead of waiting for the queue to fill. What improves first?",
  prediction: {
    options: [
      { id: "capacity", label: "Service capacity rises because the queue is shorter" },
      {
        id: "critical",
        label: "Critical-path errors fall because the queue stops competing with deferrable work",
      },
      { id: "all-errors", label: "Every error disappears because low-priority traffic is gone" },
      { id: "count", label: "Total completed requests rise because more work is admitted" },
    ],
    correctOptionId: "critical",
    explanation:
      "Shedding does not create capacity. It removes work that was competing for the same queue and workers, so critical requests wait less and are rejected less often. Total admitted throughput can fall while the critical path becomes healthy again.",
  },
  setup: defaults({
    demandRps: 50_000,
    capacityRps: 20_000,
    criticalSharePct: 35,
    shedTriggerPct: 100,
    shedSharePct: 0,
  }),
  runFor: 30,
  observe: [
    "Critical-path errors fall from about 23% to zero.",
    "Queue delay falls from roughly 2.0s to about 0.6s.",
    "Low-priority admitted traffic falls sharply; the deferrable class is mostly refused.",
    "Useful throughput rises because admitted critical work finishes inside the deadline.",
  ],
  explain:
    "The failure was not a shortage of critical demand. Critical traffic was 17.5k rps against 20k rps of capacity, so it fit. The queue was full of low-priority work, and that wait pushed critical requests past the deadline. Shedding the low-value class protected the critical path without adding capacity. The remaining queue delay is the safety margin, not a full recovery.",
  fix: defaults({
    demandRps: 50_000,
    capacityRps: 20_000,
    criticalSharePct: 35,
    shedTriggerPct: 30,
    shedSharePct: 100,
  }),
  debrief:
    "Incident shedding is a product decision executed under pressure. The team must already know which work is deferrable, which class is protected, and what the user sees when a request is refused. Shedding everything is not a strategy: it turns an overload into a full outage. Shedding nothing is also a decision, because the queue then decides who fails.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Incident load shedding is the deliberate refusal of some work while a service is overloaded. It is not capacity planning and it is not a queue limit by itself. It is an incident action: the team decides which request classes must survive, which can wait, and which should be refused now so the critical path can still meet its deadline.",
  },
  {
    type: "p",
    text: "The distinction from ordinary admission control is ownership. A shed policy encodes a product promise. Checkout, authentication, and payment authorization usually belong to the critical path. Recommendations, analytics, image derivatives, and background sync are usually deferrable. During an incident, someone must be able to say which class is being dropped and what customers will see. If that decision is invented at 03:00, it will be inconsistent and slow.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Shedding happens at the edge of the constrained service, or at a shared proxy in front of it, before work enters the queue. It needs a bound on queued work and a ranking of traffic. The bound keeps accepted requests inside the deadline. The ranking decides who is refused when the bound is reached. A system with a queue limit but no ranking still sheds, but it sheds whoever arrives last, which is rarely the right class.",
  },
  {
    type: "table",
    headers: ["Decision", "What is refused", "Effect on the critical path", "Main risk"],
    rows: [
      [
        "Shed nothing",
        "Nothing until the queue is full",
        "Competes with every other class and misses the deadline",
        "The queue chooses the losers",
      ],
      [
        "Shed low priority first",
        "Deferrable work",
        "Protected if critical demand fits capacity",
        "Deferred work can starve",
      ],
      [
        "Shed everything",
        "All non-essential and some essential work",
        "Fails with the rest of the product",
        "Overload becomes a full outage",
      ],
      [
        "Reserve critical capacity",
        "Low priority plus a capacity reservation",
        "Protected even when low-priority demand is large",
        "Idle capacity when critical traffic is quiet",
      ],
    ],
  },
  {
    type: "p",
    text: "This module models a service with a 1.5s useful deadline and a queue bounded at two seconds of work. The numbers are illustrative teaching values. The structure is the lesson: queue delay converts capacity into late completions, and a ranking decides which class pays for the shortage.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Critical-path errors: the availability loss that matters most during the incident.",
      "Queue delay and p99: the wait before work starts and the tail it creates.",
      "Useful throughput: served work that still finishes before the deadline.",
      "Low-priority admitted rate: the class being traded away to protect the critical path.",
      "Admission and worker nodes, which show whether the queue or the workers are the constraint.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No shedding. Watch critical errors and queue delay rise while workers stay at capacity. Run the experiment before revealing the answer. Then apply Recovery and compare the critical path with the low-priority admitted rate. Finish with Shed critical work to see the opposite failure: a policy that protects nothing because the critical class is larger than capacity.",
  },
  { type: "sim", simId: "load-shedding-incident" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With no shedding, 50k rps arrived at a 20k rps service. The queue filled to two seconds of work, which pushed the tail past the 1.5s deadline. Critical traffic was only 17.5k rps, below capacity, but it waited behind low-priority work and lost about a quarter of its requests to rejection or lateness. The service was busy and the critical path was still failing.",
  },
  {
    type: "p",
    text: "Shedding low-priority work at 30% queue fill kept the queue near 0.6s. Critical errors fell to zero because critical demand fit inside capacity once the competition was removed. Low-priority admitted traffic fell sharply. Useful throughput rose because the critical class finished inside its deadline, while the total admitted request count stayed roughly flat. The improvement is in the promise that was protected, not in the raw number of requests the service touched.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Request metrics split by class: admitted, rejected, completed, and completed after the deadline.",
      "Saturation signals: worker utilization, queue age, in-flight requests, and the share of requests older than the deadline.",
      "Business signals: checkout completion, login success, and payment authorization, which are the real critical-path metrics.",
      "Client signals: timeout rate and retry volume. A retry spike after a shed decision usually means the refusal was not explained or was retried into the same queue.",
      "Communication signals: status page views, support contacts, and the gap between the first refusal and the first customer update.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split demand and errors by class before changing anything. If critical demand alone exceeds capacity, shedding lower classes will not save it; the team needs more capacity, less critical work, or a smaller promise. If critical demand fits, check whether the queue is occupied by deferrable work or retries. Then check whether the shed trigger fires before the queue is full and whether the refusal message tells clients not to retry immediately.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Name the critical path and the deferrable classes before the incident, with a product owner's sign-off.",
      "Bound the queue in seconds of work so the maximum wait is explicit.",
      "Set the shed trigger below the queue limit and shed the lowest class first.",
      "Reserve capacity or concurrency for the critical class so low-value work cannot consume it.",
      "Return a clear overload response with a retry hint or a deferral message, and suppress immediate retries.",
      "Publish a customer update that states what is unavailable and when the next update will arrive.",
      "After the incident, review which classes were shed and whether the deferred work has a completion path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Early shedding refuses work that might have succeeded if demand fell; a late trigger admits more work but risks the critical path.",
      "Priority labels are a product and business judgment. They must be written down, or on-call engineers will improvise them under pressure.",
      "A protected class can starve. Deferred work still needs a bounded completion path, even if that path is slower.",
      "Shedding can keep CPU low and suppress reactive autoscaling while requests are being refused. Capacity policy and admission policy must be designed together.",
      "Refusal has a cost. If rejection is expensive or clients retry aggressively, a large shed volume can consume the capacity it was meant to protect.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-to-shed-first",
    question:
      "The service is overloaded and every request is timing out. How do you decide what to shed first?",
    difficulty: 3,
    hints: [
      "Start from the promise the product cannot break.",
      "Separate critical demand from deferrable work before touching the queue.",
    ],
    answer:
      "I would identify the critical path first: the requests whose failure stops revenue, safety, or authentication. Then I would compare critical demand with capacity. If critical demand already exceeds capacity, shedding lower classes will not save it; I need more capacity, less critical work, or a smaller promise. If critical demand fits, I shed deferrable work at a trigger below the queue limit, protect a capacity reservation for the critical class, and return a clear refusal with a retry hint. I would also publish a customer update that names what is unavailable and the next update time.",
    followUps: [
      "Which metrics would you watch in the first five minutes?",
      "How do you prevent a client from labeling its traffic critical?",
      "What would you defer on a checkout path?",
    ],
    redFlags: [
      "Sheds whatever arrives last.",
      "Sheds all traffic to make the graphs look healthy.",
      "Uses CPU alone as the trigger.",
    ],
    rubric: [
      "Defines the critical path.",
      "Compares critical demand with capacity.",
      "Sheds lower-value work before the queue fills.",
      "Defines the customer message.",
    ],
  },
  {
    id: "shed-everything",
    question:
      "The queue is full and the team wants to refuse all traffic until it drains. What is wrong with that move?",
    difficulty: 3,
    hints: [
      "An empty queue is not the same as a healthy service.",
      "Think about what customers and dependent services see.",
    ],
    answer:
      "Refusing all traffic turns an overload into a full outage. The critical path fails even though some of it could have been served, and dependent services may interpret the mass refusal as a health failure and fail over or retry. It also removes the signal that tells us which classes were actually over capacity. A better move is to refuse the lowest-value class first, keep the critical path flowing, and drain the queue at a controlled rate. If capacity is truly gone, a full stop may be necessary, but it should be a deliberate last step with a clear customer message.",
    followUps: [
      "How would you drain a full queue without a second wave?",
      "What do dependent services do when you return 503?",
      "How do you distinguish overload from a code failure?",
    ],
    redFlags: [
      "Assumes an empty queue means recovery.",
      "Does not distinguish critical from deferrable work.",
      "Ignores dependent services and retries.",
    ],
    rubric: [
      "Recognizes over-shedding as a failure.",
      "Preserves the critical class.",
      "Controls queue drain.",
      "Communicates the customer impact.",
    ],
  },
  {
    id: "communication",
    question:
      "You have decided to disable recommendations and search suggestions for thirty minutes. What does the customer update say?",
    difficulty: 2,
    hints: ["State impact, not cause.", "Give a next update time you can meet."],
    answer:
      "The update should state what customers will notice, what still works, and when they will hear more. For example: recommendations and search suggestions are unavailable while we protect checkout and account access; search results and checkout still work; the next update will be at a specific time. I would avoid speculating about the cause, blaming a vendor, or promising a fix time we cannot verify. Internally, the same decision should be recorded with the trigger, the classes shed, and the owner who can reverse it.",
    followUps: [
      "Which channel gets the update first?",
      "What do support agents need that customers do not?",
      "When do you update again if nothing changes?",
    ],
    redFlags: [
      "Publishes raw incident-channel speculation.",
      "Promises a fix time without evidence.",
      "Says nothing because the cause is unknown.",
    ],
    rubric: [
      "States customer-visible impact.",
      "Names what still works.",
      "Gives a credible next update time.",
      "Avoids speculation and blame.",
    ],
  },
  {
    id: "recovery",
    question:
      "Demand has fallen and the queue is draining. How do you restore the deferred features without causing a second incident?",
    difficulty: 3,
    hints: [
      "A feature flag is not a ramp.",
      "Watch the same saturation signal that triggered the shed.",
    ],
    answer:
      "I would restore in stages, lowest-value class first, and watch queue delay, critical-path errors, and worker utilization after each step. I would not restore all features at once, because the backlog and the returning clients can create a second wave. I would keep the shed policy armed, restore a fraction of traffic, wait for the queue to stay flat, then increase. I would also verify that deferred work has drained and that clients are not still retrying from the incident.",
    followUps: [
      "What is the rollback trigger for a restore step?",
      "How do you handle a backlog of deferred jobs?",
      "Would you restore before or after the postmortem?",
    ],
    redFlags: [
      "Restores everything when the graph looks normal.",
      "Ignores the deferred backlog.",
      "Disarms the shed policy during recovery.",
    ],
    rubric: [
      "Restores in stages.",
      "Watches the same saturation signals.",
      "Keeps the shed policy armed.",
      "Accounts for backlog and retries.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The critical path is named and agreed with a product owner.",
      "Deferrable classes are listed with their customer-visible fallback.",
      "The queue is bounded in seconds of work, not only in request count.",
      "The shed trigger, order, and owner are documented.",
      "Critical-path and per-class rejection metrics are on one dashboard.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare critical demand with capacity before changing the shed policy.",
      "Shed the lowest-value class first and keep the critical class reserved.",
      "Return a clear overload response and suppress immediate retries.",
      "Publish a customer update with impact and next update time.",
      "Record the decision, the trigger, and the person who owns the reversal.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that critical-path errors returned to baseline.",
      "Check the deferred class for starvation and backlog age.",
      "Review whether the trigger fired too late or too aggressively.",
      "Reconcile the shed policy with autoscaling and capacity headroom.",
      "Add the customer-visible impact to the postmortem timeline.",
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

export const loadSheddingIncidentModel: SimModel = {
  id: "reliability-load-shedding",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, false, 0.1);
    const frame = buildFrame(values, seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const previousQueue = Math.max(0, Number(frame.flags.queue ?? 0));
    const previousShedding = Number(frame.flags.shedding ?? 0) === 1;
    const values = compute(p, previousQueue, previousShedding, dt);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = { ...frame.flags, ...next.flags };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);
    if (values.criticalErrors >= 2 && frame.flags.criticalShedEvent !== 1) {
      pushEvent(next, {
        id: "shed-policy-lost-critical-path",
        at: frame.t,
        severity: "crit",
        title: "Load shedding is not protecting the critical path",
        detail: `Critical errors are ${values.criticalErrors.toFixed(1)}% while low-priority admitted traffic is ${Math.round(values.acceptedLow).toLocaleString("en-US")} rps. Check the class ranking and the shed trigger.`,
        nodeId: "gateway",
        metricId: "critical-errors",
      });
      next.flags.criticalShedEvent = 1;
    } else if (values.criticalErrors < 2) {
      next.flags.criticalShedEvent = 0;
    }
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
      `Critical demand is ${Math.round(values.highDemand).toLocaleString("en-US")} rps, ${Math.round(values.criticalShare * 100)}% of ${Math.round(values.demand).toLocaleString("en-US")} rps offered. Capacity is ${Math.round(values.capacity).toLocaleString("en-US")} rps.`,
    );
    items.push(
      values.highDemand > values.capacity
        ? "Critical demand alone exceeds capacity. No shed order can protect it without adding capacity, reducing critical work, or narrowing the promise."
        : "Critical demand fits inside capacity. The question is whether lower-value work is competing for the queue.",
    );
    items.push(
      `The queue is ${Math.round(values.queueDepth).toLocaleString("en-US")} requests, or ${values.queueDelay.toFixed(1)}s of work. Low-priority shedding is ${values.shedding ? "active" : "idle"} at a ${Math.round(values.triggerRequests).toLocaleString("en-US")} request trigger.`,
    );
    items.push(
      `Low-priority admission is ${Math.round(values.acceptedLow).toLocaleString("en-US")} rps. Total rejection is ${values.rejection.toFixed(0)}%. A shed policy that refuses almost everything has stopped being selective.`,
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
      "18k rps against 24k rps of capacity. The queue stays empty and the critical path is clean.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with early shed",
    description:
      "36k rps against 24k rps. Low-priority work is shed at half fill, so delay stays near one second.",
    tone: "warn",
    params: defaults({ demandRps: 36_000, shedTriggerPct: 50 }),
  },
  {
    id: "failure",
    label: "No shedding",
    description:
      "50k rps against 20k rps with the trigger at the queue limit. The queue fills and the critical path pays.",
    tone: "crit",
    params: defaults({
      demandRps: 50_000,
      capacityRps: 20_000,
      shedTriggerPct: 100,
      shedSharePct: 0,
    }),
  },
  {
    id: "shed-critical",
    label: "Shed critical work",
    description:
      "Critical demand is 70% of 50k rps against 15k rps of capacity. The policy refuses the class it was meant to protect.",
    tone: "crit",
    params: defaults({
      demandRps: 50_000,
      capacityRps: 15_000,
      criticalSharePct: 70,
      shedTriggerPct: 30,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The same overload, but low-priority work is shed at 30% fill and the critical path returns to zero errors.",
    tone: "ok",
    params: defaults({
      demandRps: 50_000,
      capacityRps: 20_000,
      criticalSharePct: 35,
      shedTriggerPct: 30,
      shedSharePct: 100,
    }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "load-shedding-incident": {
      model: loadSheddingIncidentModel,
      presets,
      instructions:
        "Start Healthy, apply No shedding, and watch critical errors and queue delay rise while workers stay at capacity. Run the experiment, then apply Recovery and compare the critical path with low-priority admission. Finish with Shed critical work to see over-shedding.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Demand, capacity, deadline, and queue bounds are teaching values, not a vendor limit.",
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
    "reliability-graceful-degradation",
    "reliability-cache-failure",
  ],
};
