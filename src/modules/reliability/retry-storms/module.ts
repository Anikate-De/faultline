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

const FAULT_START_SEC = 1;
const FAULT_END_SEC = 5;
const FAULT_CAPACITY_FACTOR = 0.15;
const BREAKER_HOLD_SEC = 5;
const QUEUE_CAP = 500_000;

const params: ParamSpec[] = [
  {
    id: "baseRps",
    label: "Original request rate",
    min: 1_000,
    max: 30_000,
    step: 500,
    value: 4_000,
    unit: " rps",
    group: "Traffic",
    help: "Logical requests before retries. Every failed attempt can add another request.",
    format: "rps",
  },
  {
    id: "capacityRps",
    label: "Dependency capacity",
    min: 5_000,
    max: 60_000,
    step: 1_000,
    value: 40_000,
    unit: " rps",
    group: "Dependency",
    help: "Requests the dependency can serve when healthy. The modeled blip removes 85% of this capacity for four seconds.",
    format: "rps",
  },
  {
    id: "maxRetries",
    label: "Max retries per request",
    min: 0,
    max: 5,
    step: 1,
    value: 1,
    unit: "",
    group: "Retry policy",
    help: "Additional attempts after a failure. The theoretical amplification ceiling is one plus this value.",
    format: "count",
  },
  {
    id: "retryBudgetPct",
    label: "Retry budget",
    min: 0,
    max: 500,
    step: 10,
    value: 10,
    unit: "%",
    group: "Retry policy",
    help: "Retries are capped at this share of original traffic. One hundred percent allows one retry per original on average; 500% allows five.",
    format: "percent",
  },
  {
    id: "breakerThresholdPct",
    label: "Breaker trip threshold",
    min: 0,
    max: 100,
    step: 1,
    value: 5,
    unit: "%",
    group: "Breaker",
    help: "Error rate that opens the breaker for five seconds. Zero disables the breaker and removes the automatic stop.",
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

interface State {
  queue: number;
  error: number;
  breakerUntil: number;
}

interface Computed {
  base: number;
  capacity: number;
  maxRetries: number;
  budgetPct: number;
  breakerThreshold: number;
  fault: boolean;
  capacityEffective: number;
  breakerEnabled: boolean;
  breakerOpen: boolean;
  breakerUntil: number;
  prevError: number;
  retryRate: number;
  budgetRps: number;
  load: number;
  queue: number;
  serviceRate: number;
  queueDelay: number;
  error: number;
  clientError: number;
  utilization: number;
  amplification: number;
}

function compute(p: Params, t: number, state: State, dt: number): Computed {
  const base = Math.max(1, num(p, "baseRps", 4_000));
  const capacity = Math.max(1, num(p, "capacityRps", 40_000));
  const maxRetries = clamp(Math.round(num(p, "maxRetries", 1)), 0, 5);
  const budgetPct = clamp(num(p, "retryBudgetPct", 10), 0, 500);
  const breakerThreshold = clamp(num(p, "breakerThresholdPct", 5), 0, 100);
  const fault = t >= FAULT_START_SEC && t < FAULT_END_SEC;
  const capacityEffective = capacity * (fault ? FAULT_CAPACITY_FACTOR : 1);
  const breakerEnabled = breakerThreshold > 0;
  const breakerOpen = breakerEnabled && state.breakerUntil > t;
  const prevError = clamp(state.error, 0, 100);
  const queue = clamp(state.queue, 0, QUEUE_CAP);
  const budgetRps = base * (budgetPct / 100);
  const retryRate = breakerOpen ? 0 : Math.min(base * maxRetries * (prevError / 100), budgetRps);
  const load = base + retryRate;
  const serviceRate = Math.min(capacityEffective, queue / Math.max(dt, 0.01) + load);
  const queueNext = clamp(queue + (load - serviceRate) * dt, 0, QUEUE_CAP);
  const queueDelay = queueNext / capacityEffective;
  const faultError = fault ? 30 : 0;
  const error = clamp(Math.max(faultError, (queueDelay - 1) * 20), 0, 95);
  const clientError = breakerOpen ? Math.max(error, 30) : error;
  let breakerUntil = breakerOpen ? state.breakerUntil : 0;
  if (breakerEnabled && !breakerOpen && error >= breakerThreshold) {
    breakerUntil = t + BREAKER_HOLD_SEC;
  }
  if (!breakerEnabled) breakerUntil = 0;
  return {
    base,
    capacity,
    maxRetries,
    budgetPct,
    breakerThreshold,
    fault,
    capacityEffective,
    breakerEnabled,
    breakerOpen,
    breakerUntil,
    prevError,
    retryRate,
    budgetRps,
    load,
    queue: queueNext,
    serviceRate,
    queueDelay,
    error,
    clientError,
    utilization: clamp(load / capacityEffective),
    amplification: load / base,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seedValue: number, t: number): SimFrame {
  const gatewayHealth = healthFor(c.clientError, 1, 5);
  const dependencyHealth = healthFor(c.utilization * 100, 80, 95);
  const queueHealth = healthFor(c.queue, 10_000, 50_000);
  const breakerHealth: "ok" | "warn" | "crit" = c.breakerOpen ? "warn" : "ok";
  return {
    t,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: c.base,
        sublabel: `${Math.round(c.base).toLocaleString("en-US")} rps original`,
        meta: { view: "queue" },
      },
      {
        id: "gateway",
        label: "API gateway",
        kind: "service",
        health: gatewayHealth,
        utilization: clamp(c.load / Math.max(1, c.capacityEffective)),
        throughput: c.base,
        sublabel: `${c.clientError.toFixed(0)}% failures`,
        detail: `Retries add ${Math.round(c.retryRate).toLocaleString("en-US")} rps on top of ${Math.round(c.base).toLocaleString("en-US")} rps. The budget is ${Math.round(c.budgetRps).toLocaleString("en-US")} rps.`,
        meta: { view: "queue" },
      },
      {
        id: "retry-queue",
        label: "Retry queue",
        kind: "queue",
        health: queueHealth,
        utilization: clamp(c.queue / QUEUE_CAP),
        throughput: c.retryRate,
        sublabel: `${Math.round(c.queue).toLocaleString("en-US")} waiting`,
        detail:
          "Failed attempts wait here before another try. A queue full of retries keeps the dependency busy after the original fault clears.",
        meta: { view: "queue" },
      },
      {
        id: "dependency",
        label: "Dependency",
        kind: "external",
        health: dependencyHealth,
        utilization: c.utilization,
        throughput: Math.min(c.load, c.capacityEffective),
        sublabel: `${Math.round(c.load).toLocaleString("en-US")} rps offered`,
        detail: `Illustrative healthy capacity is ${Math.round(c.capacity).toLocaleString("en-US")} rps. During the fault it is ${Math.round(c.capacityEffective).toLocaleString("en-US")} rps.`,
        meta: { view: "queue" },
      },
      {
        id: "breaker",
        label: "Retry breaker",
        kind: "service",
        health: breakerHealth,
        utilization: c.breakerOpen ? 0.8 : 0.1,
        sublabel: c.breakerEnabled ? (c.breakerOpen ? "open, failing fast" : "closed") : "disabled",
        detail: c.breakerEnabled
          ? `Opens for ${BREAKER_HOLD_SEC}s when errors reach ${Math.round(c.breakerThreshold)}%.`
          : "A zero threshold disables the automatic stop. Retries continue regardless of the dependency's state.",
        meta: { view: "queue" },
      },
    ],
    edges: [
      edge(
        "client-gateway",
        "client",
        "gateway",
        clamp(c.load / Math.max(1, c.capacityEffective)),
        gatewayHealth,
      ),
      edge(
        "gateway-queue",
        "gateway",
        "retry-queue",
        clamp(c.retryRate / Math.max(1, c.base)),
        queueHealth,
      ),
      edge("queue-dependency", "retry-queue", "dependency", c.utilization, dependencyHealth),
      edge(
        "gateway-dependency",
        "gateway",
        "dependency",
        clamp(c.base / Math.max(1, c.capacityEffective)),
        dependencyHealth,
      ),
    ],
    metrics: [
      metric("client-errors", "Client-facing errors", c.clientError, "%", 1, 5, "percent"),
      metric("retry-amplification", "Retry amplification", c.amplification, "x", 1.5, 3, "number"),
      metric(
        "dependency-utilization",
        "Dependency utilization",
        c.utilization * 100,
        "%",
        80,
        95,
        "percent",
      ),
      metric("queueDepth", "Retry queue depth", c.queue, " req", 10_000, 50_000, "count"),
      metric("retry-rate", "Retry rate", c.retryRate, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed: seedValue,
      queue: c.queue,
      error: c.error,
      breakerUntil: c.breakerUntil,
    },
    summary: `${c.clientError.toFixed(0)}% failures at ${c.amplification.toFixed(1)}x amplification; dependency at ${Math.round(c.utilization * 100)}% of capacity; ${Math.round(c.queue).toLocaleString("en-US")} retries waiting.`,
  };
}

function seedSeries(frame: SimFrame, seedValue: number): void {
  const phase = seedValue % 13;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.95 + 0.08 * Math.sin((index + phase) / 3.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "client-errors",
    metricId: "client-errors",
    warn: 1,
    crit: 5,
    title: "The dependency failure is reaching every client",
    cause:
      "Failed attempts are being retried, and the retries are failing too. The client sees the accumulated failure rather than a fast, bounded response.",
    fix: "Cut retries with a budget or breaker, return a fast failure for the affected call, and protect the rest of the platform. Fix the dependency after the retry loop is stopped.",
    checkFirst: [
      "Compare the failure rate with the retry rate.",
      "Check whether the breaker is enabled and open.",
      "Check whether clients are retrying above the retry layer.",
    ],
  },
  {
    id: "retry-amplification",
    metricId: "retry-amplification",
    warn: 1.5,
    crit: 3,
    title: "Retries are multiplying the load",
    cause:
      "Each failed attempt creates another request. The amplification factor is the total load divided by the original request rate. At several times the original rate, a dependency blip becomes a capacity event.",
    fix: "Set a retry budget as a share of original traffic, use backoff with jitter, and open the breaker when errors persist. The budget caps the damage; the breaker stops it.",
    checkFirst: [
      "Compare dependency load with the original request rate.",
      "Check the retry budget and the maximum attempts per request.",
      "Check whether retries are synchronized or jittered.",
    ],
  },
  {
    id: "dependency-utilization",
    metricId: "dependency-utilization",
    warn: 80,
    crit: 95,
    title: "The dependency is saturated by retry load",
    cause:
      "The dependency is receiving more work than it can serve, so its queue grows and its latency rises. The retries that were meant to recover individual requests are keeping the dependency unavailable.",
    fix: "Reduce offered load before tuning the dependency. Open the breaker, shrink the retry budget, and shed low-value work. Adding capacity before stopping the retries usually just feeds the loop.",
    checkFirst: [
      "Separate original traffic from retry traffic at the dependency.",
      "Check dependency queue depth and latency, not only its error rate.",
      "Check whether the dependency recovered when retries stopped.",
    ],
  },
  {
    id: "queue-depth",
    metricId: "queueDepth",
    warn: 10_000,
    crit: 50_000,
    title: "A retry backlog is keeping the dependency down",
    cause:
      "Failed attempts accumulate in the retry queue. Even after the original fault clears, the queue continues to feed the dependency, so the recovery never gets a quiet period.",
    fix: "Stop adding retries, drain or expire the backlog, and restore traffic in stages. A queue that outlives the fault turns a short blip into a long incident.",
    checkFirst: [
      "Check queue age and the oldest retry, not only depth.",
      "Check whether the client gives up before the retry runs.",
      "Check whether the backlog is draining or growing after the fault clears.",
    ],
  },
];

const experiment: Experiment = {
  id: "predict-storm-first-move",
  title: "Predict the first move in a retry storm",
  simId: "retry-storm",
  question:
    "The dependency blip lasted four seconds, but twenty minutes later the platform is still failing. Dependency load is almost five times the original request rate. What is the first move?",
  prediction: {
    options: [
      { id: "capacity", label: "Add capacity to the dependency" },
      { id: "retries", label: "Cut retries with a budget or breaker, then drain the backlog" },
      { id: "timeout", label: "Raise the dependency timeout" },
      { id: "traffic", label: "Send all traffic to a second dependency without checking it" },
    ],
    correctOptionId: "retries",
    explanation:
      "The original fault is over. The load is self-generated by retries and backlog, so adding capacity or raising timeouts feeds the loop. Cutting retries reduces offered load, lets the dependency drain, and gives recovery a chance.",
  },
  setup: defaults({
    baseRps: 12_000,
    capacityRps: 20_000,
    maxRetries: 4,
    retryBudgetPct: 500,
    breakerThresholdPct: 0,
  }),
  runFor: 30,
  observe: [
    "Retry amplification is about 4.8x, with almost 58k rps offered to a 20k rps dependency.",
    "The retry queue is full and the dependency stays at 100% utilization.",
    "After cutting retries, amplification returns to 1x and the queue drains.",
    "Dependency utilization falls below 95% only after the retry load is removed.",
  ],
  explain:
    "The storm is a feedback loop. A failed attempt creates a retry, the retry adds load, the extra load causes more failures, and the cycle continues after the trigger is gone. The dependency cannot recover while it is being held at 100% utilization. Reducing retries is the action that changes the loop; capacity and timeouts do not.",
  fix: defaults({
    baseRps: 12_000,
    capacityRps: 20_000,
    maxRetries: 2,
    retryBudgetPct: 10,
    breakerThresholdPct: 2,
  }),
  debrief:
    "The first move in a retry storm is to reduce load, not to repair the dependency. A retry budget caps amplification, a breaker fails fast when errors persist, and a bounded queue prevents a backlog from outliving the fault. Once the load is down, the dependency can recover and the team can investigate the original trigger.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A retry storm is a feedback loop. A dependency fails or slows, clients retry, the retries add load, the added load causes more failures, and the cycle continues after the original fault is gone. The incident looks like a dependency outage, but the dependency is being held down by the traffic the platform generates.",
  },
  {
    type: "p",
    text: "Two controls break the loop. A retry budget caps retries as a share of original traffic, so the platform cannot amplify beyond a known factor. A circuit breaker stops calling a dependency that is failing, then probes carefully when it might have recovered. Backoff and jitter reduce synchronization, but they do not cap total amplification. During an incident, the first move is to reduce retries and load, not to tune the dependency.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Retries belong to the caller, close to the dependency client. The budget should be enforced per dependency and per caller, because a global budget lets one noisy service consume the capacity reserved for everyone else. The breaker belongs on the same path. Both need a bounded queue or concurrency limit behind them, or the retries simply wait somewhere else and arrive later as a backlog.",
  },
  {
    type: "table",
    headers: ["Control", "What it limits", "Effect during a storm", "What it does not fix"],
    rows: [
      [
        "Max attempts",
        "Retries per request",
        "Bounds one request's amplification",
        "Many requests still multiply together",
      ],
      [
        "Retry budget",
        "Total retry volume",
        "Caps aggregate load as a share of traffic",
        "A dependency that is already saturated",
      ],
      [
        "Circuit breaker",
        "Calls while failing",
        "Stops the loop and gives recovery a quiet period",
        "The original bug or capacity shortage",
      ],
      [
        "Backoff and jitter",
        "Timing of retries",
        "Spreads the load and avoids synchronized waves",
        "The total amount of retry work",
      ],
      [
        "Bounded queue",
        "Waiting retries",
        "Prevents a backlog from outliving the fault",
        "The decision to stop retrying",
      ],
    ],
  },
  {
    type: "p",
    text: "This module models a dependency that loses 85% of its capacity for four simulated seconds. The healthy capacity is illustrative. The structure is the lesson: the fault is short, the retry loop is what makes the incident long.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Retry amplification: total dependency load divided by the original request rate.",
      "Dependency utilization: whether retries have saturated the dependency.",
      "Retry queue depth: the backlog that can keep the dependency busy after the fault clears.",
      "Client-facing errors: the cost of failing fast versus retrying into a saturated dependency.",
      "Breaker state: whether the automatic stop is open, closed, or disabled.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No limits. Watch amplification and dependency utilization rise while the fault is still short. Run the experiment before revealing the answer. Then apply Recovery to compare the budget and breaker together. Finish with Budget only to see that a budget alone can contain the loop, and with Breaker only to see that the stop matters more than the retry count.",
  },
  { type: "sim", simId: "retry-storm" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The dependency lost most of its capacity for four seconds. With four retries per request and no budget, load rose to almost five times the original traffic. The retry queue filled, the dependency stayed at 100% utilization, and the platform kept failing long after the original blip. The dependency was not the only problem; the retry loop was the incident.",
  },
  {
    type: "p",
    text: "Cutting the retry budget and opening the breaker reduced amplification to 1x. The queue drained, dependency utilization fell below the critical threshold, and client errors returned to zero. The fix did not add capacity or change the dependency. It removed the load that prevented recovery.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Dependency load split into original traffic and retry traffic.",
      "Retry rate, retry budget consumption, and attempts per request.",
      "Breaker state and the time since the last state change.",
      "Dependency queue depth, latency, and error rate.",
      "Client error rate and timeout rate, which may rise when the breaker fails fast.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare dependency load with the original request rate. If load is several times the original, retries are driving the incident. Check whether the breaker is enabled and open, and whether the retry queue is still feeding the dependency after the fault cleared. Stop the retries before adding capacity or raising timeouts. Then check the oldest retry in the queue, not only its depth.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the amplification: shrink the retry budget, open the breaker, or disable retries for the affected dependency.",
      "Bound the queue and expire retries that can no longer help the client.",
      "Shed low-value work so the dependency sees the smallest useful load.",
      "Verify that dependency utilization falls and the queue is draining, not just that errors changed.",
      "Restore traffic in stages and keep the breaker armed until the dependency is stable.",
      "Fix the original trigger and review the retry policy, budget, and queue bounds.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A tight retry budget reduces amplification but increases the number of requests that fail without a second chance.",
      "A breaker that opens quickly protects the dependency but returns fast failures to users who might have succeeded on a later attempt.",
      "Larger queues absorb bursts but can outlive the fault and delay recovery.",
      "Backoff reduces synchronization but raises latency; jitter helps only if the base delay is already reasonable.",
      "Retries are still useful for transient single-request failures. The mistake is treating them as an incident strategy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "first-move",
    question:
      "A dependency blips and the whole platform melts down for twenty minutes. What is your first move?",
    difficulty: 4,
    hints: [
      "The original fault may already be over.",
      "Look at the load the platform is generating.",
    ],
    answer:
      "I would compare dependency load with the original request rate. If load is several times the original, retries are the incident. My first move is to reduce retries and offered load: shrink the retry budget, open the breaker, or disable retries for that dependency. Then I would drain or expire the retry backlog and shed low-value work. I would not add capacity or raise timeouts first, because those moves feed the loop. Once utilization falls, I can investigate the original trigger.",
    followUps: [
      "How do you distinguish a retry storm from a real capacity shortage?",
      "What do you tell customers while the breaker is open?",
      "How do you restore traffic without restarting the storm?",
    ],
    redFlags: [
      "Adds capacity first.",
      "Raises timeouts to reduce errors.",
      "Blames the dependency without checking retry load.",
    ],
    rubric: [
      "Checks amplification first.",
      "Reduces retries and load.",
      "Drains the backlog.",
      "Restores in stages.",
    ],
  },
  {
    id: "budget-vs-breaker",
    question: "Would you use a retry budget or a circuit breaker to stop a retry storm?",
    difficulty: 3,
    hints: ["They limit different things.", "One caps volume; the other stops calls."],
    answer:
      "They solve different parts of the problem, so I would use both. A retry budget caps total retry volume as a share of original traffic, which bounds amplification even when the dependency is only partially failing. A breaker stops calls when the error rate is high and gives the dependency a quiet period to recover. The budget is the continuous control; the breaker is the emergency stop. Neither replaces a bounded queue and a sane maximum attempts setting.",
    followUps: [
      "What budget would you start with?",
      "How does the breaker close safely?",
      "What happens to requests while the breaker is open?",
    ],
    redFlags: [
      "Treats them as interchangeable.",
      "Sets a budget with no max attempts.",
      "Closes the breaker without a probe.",
    ],
    rubric: [
      "Distinguishes volume from call state.",
      "Uses both.",
      "Mentions bounded queue and max attempts.",
      "Describes safe breaker closure.",
    ],
  },
  {
    id: "dependency-recovered",
    question:
      "The dependency is healthy again, but your error rate is still high. What keeps the incident going?",
    difficulty: 3,
    hints: ["Look at the queue and the clients.", "A backlog can outlive the fault."],
    answer:
      "The retry backlog and the clients are still generating load. The queue may be feeding requests that were created during the fault, and clients outside my retry layer may still be retrying. I would check queue age, retry rate, and dependency utilization. I would expire stale retries, keep the budget tight, and restore traffic in stages. The dependency being healthy is necessary but not sufficient; the system needs a quiet period to drain.",
    followUps: [
      "How do you expire retries without dropping useful work?",
      "How do you detect client-side retries outside your control?",
      "What is a safe drain rate?",
    ],
    redFlags: [
      "Assumes the dependency health is the end of the incident.",
      "Reopens all traffic at once.",
      "Ignores stale retries.",
    ],
    rubric: [
      "Identifies backlog and client retries.",
      "Checks queue age.",
      "Expires stale work.",
      "Ramps traffic.",
    ],
  },
  {
    id: "prevention",
    question:
      "What would you change after the incident so the next blip does not become a platform outage?",
    difficulty: 3,
    hints: [
      "Prevention is policy and defaults, not vigilance.",
      "Think about per-dependency controls.",
    ],
    answer:
      "I would set a retry budget per dependency and per caller, cap maximum attempts, add backoff with jitter, and enable a breaker with a tested close path. I would bound the retry queue and expire retries that can no longer help the client. I would also add load tests that inject a short dependency fault and verify that amplification stays bounded. The goal is to make the safe behavior the default, not to rely on an engineer noticing the storm in time.",
    followUps: [
      "How would you test the breaker?",
      "What metric proves the budget is working?",
      "How do you prevent one caller from consuming the whole budget?",
    ],
    redFlags: [
      "Says the team should watch dashboards more closely.",
      "Adds capacity instead of controls.",
      "Leaves the retry policy unchanged.",
    ],
    rubric: [
      "Sets per-dependency budgets.",
      "Caps attempts and uses jitter.",
      "Bounds the queue.",
      "Tests the fault path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Retries use a per-dependency budget, backoff, jitter, and a maximum attempts setting.",
      "A breaker exists with a tested open and close path.",
      "The retry queue is bounded and retries expire when they can no longer help.",
      "Dependency load is dashboarded separately from original request rate.",
      "A fault-injection test verifies that a short dependency failure does not amplify.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare dependency load with the original request rate before adding capacity.",
      "Reduce retries and offered load first.",
      "Check breaker state and the retry queue age.",
      "Expire or drain stale retries and shed low-value work.",
      "Restore traffic in stages and watch amplification after each step.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that dependency utilization and queue depth returned to baseline.",
      "Review whether the budget and breaker thresholds were right.",
      "Check for client retries outside the controlled retry layer.",
      "Add the amplification timeline to the postmortem.",
      "Load-test the recovery path so the next blip is bounded.",
    ],
  },
];

const references = [
  {
    title: "Timeouts, retries, and backoff with jitter",
    url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Retry amplification, backoff, jitter, and token-bucket retry budgets.",
  },
  {
    title: "Addressing cascading failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Retry storms, load shedding, and failure containment.",
  },
  {
    title: "Circuit breaker pattern",
    url: "https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker",
    publisher: "Microsoft Azure Architecture Center",
    kind: "docs" as const,
    note: "Breaker states, half-open probes, and failure handling.",
  },
];

export const retryStormModel: SimModel = {
  id: "reliability-retry-storms",
  visual: "queue",
  params,
  init: ({ seed }) => {
    const values = compute(defaults(), 0, { queue: 0, error: 0, breakerUntil: 0 }, 0.1);
    const frame = buildFrame(values, seed, 0);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, dt) => {
    const state: State = {
      queue: Math.max(0, Number(frame.flags.queue ?? 0)),
      error: clamp(Number(frame.flags.error ?? 0), 0, 100),
      breakerUntil: Math.max(0, Number(frame.flags.breakerUntil ?? 0)),
    };
    const values = compute(p, frame.t, state, dt);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), frame.t);
    next.flags = {
      ...frame.flags,
      ...next.flags,
      queue: values.queue,
      error: values.error,
      breakerUntil: values.breakerUntil,
    };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, seriesValues]) => [key, [...seriesValues]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events].slice(-60);
    if (values.fault && frame.flags.faultSeen !== 1) {
      pushEvent(next, {
        id: "dependency-fault",
        at: frame.t,
        severity: "warn",
        title: "Dependency capacity drops",
        detail: `The dependency loses 85% of its capacity for ${FAULT_END_SEC - FAULT_START_SEC} simulated seconds. Retry load is ${Math.round(values.retryRate).toLocaleString("en-US")} rps.`,
        nodeId: "dependency",
        metricId: "dependency-utilization",
      });
      next.flags.faultSeen = 1;
    }
    if (values.breakerOpen && frame.flags.breakerOpenEvent !== 1) {
      pushEvent(next, {
        id: "breaker-open",
        at: frame.t,
        severity: "warn",
        title: "Retry breaker opened",
        detail: `Errors reached ${values.error.toFixed(1)}%. Retries are stopped for ${BREAKER_HOLD_SEC}s and requests fail fast while the dependency drains.`,
        nodeId: "breaker",
        metricId: "client-errors",
      });
      next.flags.breakerOpenEvent = 1;
    } else if (!values.breakerOpen) {
      next.flags.breakerOpenEvent = 0;
    }
    if (values.amplification >= 3 && frame.flags.stormSeen !== 1) {
      pushEvent(next, {
        id: "retry-storm",
        at: frame.t,
        severity: "crit",
        title: "Retry storm detected",
        detail: `Dependency load is ${values.amplification.toFixed(1)}x the original request rate. ${Math.round(values.queue).toLocaleString("en-US")} retries are waiting.`,
        nodeId: "retry-queue",
        metricId: "retry-amplification",
      });
      next.flags.stormSeen = 1;
    }
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(
      p,
      frame.t,
      {
        queue: Math.max(0, Number(frame.flags.queue ?? 0)),
        error: clamp(Number(frame.flags.error ?? 0), 0, 100),
        breakerUntil: Math.max(0, Number(frame.flags.breakerUntil ?? 0)),
      },
      0.1,
    );
    const items: string[] = [];
    items.push(
      `Original traffic is ${Math.round(values.base).toLocaleString("en-US")} rps. Dependency load is ${Math.round(values.load).toLocaleString("en-US")} rps, or ${values.amplification.toFixed(1)}x.`,
    );
    items.push(
      `The retry budget is ${Math.round(values.budgetRps).toLocaleString("en-US")} rps. Maximum attempts per request is ${values.maxRetries}. ${
        values.breakerEnabled
          ? `The breaker opens at ${Math.round(values.breakerThreshold)}% errors.`
          : "The breaker is disabled, so nothing stops the loop automatically."
      }`,
    );
    items.push(
      `Dependency utilization is ${Math.round(values.utilization * 100)}% of the modeled capacity. The retry queue holds ${Math.round(values.queue).toLocaleString("en-US")} requests.`,
    );
    items.push(
      "Backoff and jitter spread retries in time. They do not cap the total number of retries; a budget or breaker is what bounds amplification.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Breaker open", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "4k rps against 40k rps of capacity. The short fault does not overwhelm the dependency.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Bounded storm",
    description:
      "10k rps against 30k rps with two retries and a 10% breaker. The breaker stops the loop.",
    tone: "warn",
    params: defaults({
      baseRps: 10_000,
      capacityRps: 30_000,
      maxRetries: 2,
      retryBudgetPct: 50,
      breakerThresholdPct: 10,
    }),
  },
  {
    id: "failure",
    label: "No limits",
    description:
      "12k rps, four retries, a 500% budget, and no breaker. Load reaches almost five times the original.",
    tone: "crit",
    params: defaults({
      baseRps: 12_000,
      capacityRps: 20_000,
      maxRetries: 4,
      retryBudgetPct: 500,
      breakerThresholdPct: 0,
    }),
  },
  {
    id: "budget",
    label: "Budget only",
    description:
      "The same retries, but the budget caps them at 10% of original traffic. The loop cannot run away.",
    tone: "warn",
    params: defaults({
      baseRps: 12_000,
      capacityRps: 20_000,
      maxRetries: 4,
      retryBudgetPct: 10,
      breakerThresholdPct: 0,
    }),
  },
  {
    id: "breaker",
    label: "Breaker only",
    description: "No tight budget, but a 5% breaker opens and gives the dependency a quiet period.",
    tone: "warn",
    params: defaults({
      baseRps: 12_000,
      capacityRps: 20_000,
      maxRetries: 4,
      retryBudgetPct: 500,
      breakerThresholdPct: 5,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "A tight budget and a 2% breaker stop the amplification, drain the queue, and return to zero errors.",
    tone: "ok",
    params: defaults({
      baseRps: 12_000,
      capacityRps: 20_000,
      maxRetries: 2,
      retryBudgetPct: 10,
      breakerThresholdPct: 2,
    }),
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "retry-storm": {
      model: retryStormModel,
      presets,
      instructions:
        "Start Healthy, then apply No limits and watch amplification, dependency utilization, and queue depth rise together. Run the experiment, then compare Budget only and Breaker only. Finish with Recovery and confirm that the queue drains before the error rate returns to zero.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Capacity, fault duration, and retry bounds are teaching values, not a vendor limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-retry-backoff-jitter",
    "reliability-dependency-failure",
    "reliability-cache-failure",
    "reliability-load-shedding",
  ],
};
