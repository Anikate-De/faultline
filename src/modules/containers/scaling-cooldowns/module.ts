import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INITIAL_TASKS = 10;
const MIN_TASKS = 4;
const MAX_TASKS = 40;
const TASK_CAPACITY = 300;
const BASELINE_RPS = 1_400;
const SCALE_OUT_UTIL = 0.7;
const LOW_UTIL = 0.4;
const READY_RAMP = 1;
const CYCLE_SECONDS = 45;
const WARM_START_HOLD = 120;

const params: ParamSpec[] = [
  {
    id: "spikeSize",
    label: "Burst size",
    min: 0,
    max: 5_000,
    step: 100,
    value: 0,
    unit: " rps",
    group: "Traffic",
    help: "Extra requests per second during each burst, added to a fixed 1,400 rps baseline. Zero is flat traffic.",
    format: "rps",
  },
  {
    id: "spikeDuration",
    label: "Burst duration",
    min: 5,
    max: 60,
    step: 5,
    value: 20,
    unit: " s",
    group: "Traffic",
    help: "How long each burst lasts. Bursts repeat on a fixed 45-second cycle, so a duration of 45 seconds or more is continuous traffic.",
    format: "number",
  },
  {
    id: "scaleOutCooldown",
    label: "Scale-out cooldown",
    min: 0,
    max: 300,
    step: 10,
    value: 60,
    unit: " s",
    group: "Policy",
    help: "Time after a scale-out before the policy may scale out again. The ECS default for service auto scaling is 300 seconds; this demo uses shorter values.",
    format: "number",
  },
  {
    id: "scaleInCooldown",
    label: "Scale-in hold",
    min: 0,
    max: 600,
    step: 10,
    value: 300,
    unit: " s",
    group: "Policy",
    help: "Time low load must persist before tasks are removed. Longer holds reduce churn and keep warm capacity.",
    format: "number",
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
  tasks: number;
  ready: number;
  outCooldown: number;
  inCooldown: number;
  lowSeconds: number;
  churn: number;
}

function initialState(): State {
  return {
    tasks: INITIAL_TASKS,
    ready: INITIAL_TASKS,
    outCooldown: 0,
    inCooldown: 0,
    lowSeconds: 0,
    churn: 0,
  };
}

function readState(frame: SimFrame): State {
  const fallback = initialState();
  return {
    tasks: Math.round(clamp(Number(frame.flags.tasks ?? fallback.tasks), MIN_TASKS, MAX_TASKS)),
    ready: clamp(Number(frame.flags.ready ?? fallback.ready), MIN_TASKS, MAX_TASKS),
    outCooldown: Math.max(0, Number(frame.flags.outCooldown ?? 0)),
    inCooldown: Math.max(0, Number(frame.flags.inCooldown ?? 0)),
    lowSeconds: Math.max(0, Number(frame.flags.lowSeconds ?? 0)),
    churn: Math.max(0, Number(frame.flags.churn ?? 0)),
  };
}

function isBurst(p: Params, t: number): boolean {
  const duration = clamp(num(p, "spikeDuration", 20), 5, 60);
  return t % CYCLE_SECONDS < duration;
}

function demandAt(p: Params, t: number): number {
  return BASELINE_RPS + (isBurst(p, t) ? Math.max(0, num(p, "spikeSize", 0)) : 0);
}

interface Values {
  demand: number;
  tasks: number;
  ready: number;
  required: number;
  shortfall: number;
  excess: number;
  load: number;
  p99: number;
  churn: number;
  inCooldownRemaining: number;
}

function compute(p: Params, t: number, state: State): Values {
  const demand = demandAt(p, t);
  const ready = clamp(state.ready, MIN_TASKS, MAX_TASKS);
  const capacity = Math.max(1, ready * TASK_CAPACITY);
  const required = Math.max(MIN_TASKS, Math.ceil(demand / (TASK_CAPACITY * SCALE_OUT_UTIL)));
  const shortfall = Math.max(0, required - ready);
  const excess = Math.max(0, ready - required);
  const load = demand / capacity;
  const p99 = Math.min(5_000, 40 + 1_200 * Math.max(0, load - 0.7) ** 2 + 60 * shortfall);
  return {
    demand,
    tasks: state.tasks,
    ready,
    required,
    shortfall,
    excess,
    load,
    p99,
    churn: state.churn,
    inCooldownRemaining: state.inCooldown,
  };
}

function serviceHealth(values: Values): Health {
  if (values.shortfall >= 4 || values.p99 >= 800) return "crit";
  if (values.shortfall >= 1 || values.p99 >= 300) return "warn";
  return "ok";
}

function policyHealth(values: Values): Health {
  if (values.churn >= 5) return "crit";
  if (values.churn >= 2 || values.excess >= 10) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const health = serviceHealth(values);
  const policy = policyHealth(values);
  const nodes: SimNode[] = [
    {
      id: "clients",
      label: "Clients",
      kind: "client",
      health: "ok",
      throughput: values.demand,
      sublabel: `${Math.round(values.demand).toLocaleString()} rps`,
    },
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.load),
      throughput: values.demand,
      capacity: values.ready * TASK_CAPACITY,
      sublabel: `${values.tasks} desired · ${Math.round(values.ready)} ready`,
      detail: `The service has ${values.tasks} desired tasks and ${Math.round(values.ready)} ready. The fixed baseline is 1,400 rps; a burst adds ${Math.round(num(p, "spikeSize", 0)).toLocaleString()} rps for ${Math.round(num(p, "spikeDuration", 20))} seconds on a 45-second cycle.`,
      meta: { tasks: values.tasks, ready: Math.round(values.ready) },
    },
    {
      id: "policy",
      label: "Cooldown policy",
      kind: "service",
      health: policy,
      sublabel: `${Math.round(values.churn)} actions/min · ${Math.round(values.inCooldownRemaining)}s hold`,
      detail:
        values.excess >= 10
          ? `The service is holding ${values.excess} tasks beyond what current demand requires. That is warm capacity: useful for the next burst, expensive if the quiet period is long.`
          : `Scale-out cooldown limits how often capacity is added. The scale-in hold keeps tasks through short quiet periods instead of removing them immediately.`,
      meta: { churn: values.churn, excess: values.excess },
    },
    {
      id: "tasks",
      label: "Task set",
      kind: "worker",
      health,
      utilization: clamp(values.ready / MAX_TASKS),
      sublabel: `${values.required} required · ${values.excess} warm`,
      detail: `Current demand implies ${values.required} tasks. The service is running ${values.tasks} desired and ${Math.round(values.ready)} ready. Warm tasks above the requirement are the cost of a longer scale-in hold.`,
      meta: { tasks: values.tasks, required: values.required, excess: values.excess },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("clients-service", "clients", "service", clamp(values.demand / 7_000), health),
      edge("policy-service", "policy", "service", 0.6, policy, "sets desired count"),
      edge("service-tasks", "service", "tasks", clamp(values.ready / MAX_TASKS), health),
    ],
    metrics: [
      metric("demand", "Request rate", values.demand, " rps", undefined, undefined, "rps"),
      metric("task-shortfall", "Tasks below requirement", values.shortfall, "", 1, 4, "count"),
      metric("excess-tasks", "Warm tasks above requirement", values.excess, "", 10, 20, "count"),
      metric("p99", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("scaling-actions", "Scaling actions per minute", values.churn, "", 2, 5, "count"),
      metric("tasks", "Desired tasks", values.tasks, "", undefined, undefined, "count"),
      metric("ready-tasks", "Ready tasks", values.ready, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.tasks} desired / ${Math.round(values.ready)} ready · ${Math.round(values.demand).toLocaleString()} rps · ${values.required} required · ${values.excess} warm · p99 ${Math.round(values.p99)}ms.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.2) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

function approach(value: number, target: number, maxDelta: number): number {
  if (value < target) return Math.min(target, value + maxDelta);
  if (value > target) return Math.max(target, value - maxDelta);
  return value;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "task-shortfall",
    metricId: "task-shortfall",
    warn: 1,
    crit: 4,
    title: "The next burst starts before capacity is ready",
    cause:
      "The scale-in hold was shorter than the quiet period, so the policy removed warm tasks. When the next burst arrives, the new tasks are still starting and cannot serve. Short bursts that repeat are the classic case.",
    fix:
      "Lengthen the scale-in hold to cover the gap between bursts, or keep a minimum capacity floor that covers the first seconds of a burst. If the bursts are predictable, scheduled scaling is more reliable than reacting to each one.",
    checkFirst: [
      "Check the task count just before each burst and the time since the last scale-in.",
      "Check whether the scale-in hold is shorter than the quiet period.",
      "Check task startup and health-check time.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Latency follows the burst and the scale-in",
    cause:
      "Per-task load rises faster than ready capacity. If the policy has removed tasks during the previous quiet period, the burst starts short and latency spikes until replacement tasks are ready.",
    fix:
      "Keep enough warm capacity for the start of the burst and make sure the scale-out cooldown does not prevent a second add when the first is not enough. Check that the cooldown is not longer than the burst.",
    checkFirst: [
      "Compare p99 with ready task count and per-task load.",
      "Check whether the spike starts right after a scale-in activity.",
      "Check whether the scale-out cooldown delayed the second addition.",
    ],
  },
  {
    id: "scaling-actions",
    metricId: "scaling-actions",
    warn: 2,
    crit: 5,
    title: "The policy is chasing noise instead of filtering it",
    cause:
      "The cooldowns are short relative to the burst cycle. The policy scales out for each burst, scales in during each quiet period, and repeats. That churn costs startup work and can leave the service short at the start of the next burst.",
    fix:
      "Set the scale-in hold from the quiet period you want to ride through, and the scale-out cooldown from the time the added capacity needs to affect the metric. Do not filter noise by making scale-out so slow that real spikes are missed.",
    checkFirst: [
      "Count scaling actions per minute and compare them with the burst period.",
      "Check the scale-out and scale-in cooldown values.",
      "Check whether the added capacity had time to affect the scaling metric before the next decision.",
    ],
  },
  {
    id: "excess-tasks",
    metricId: "excess-tasks",
    warn: 10,
    crit: 20,
    title: "The service is holding far more tasks than demand requires",
    cause:
      "The scale-in hold is keeping warm capacity long after the burst, or the scale-out cooldown allowed repeated additions that the quiet period never justified. The availability is fine; the cost is not.",
    fix:
      "Shorten the scale-in hold if the quiet periods are long, lower the minimum capacity floor, or use scheduled scaling so capacity follows the known burst instead of staying warm all day.",
    checkFirst: [
      "Compare ready tasks with the tasks current demand requires.",
      "Check the time since the last burst and the scale-in hold.",
      "Check the cost of the warm tasks against the risk of a cold start.",
    ],
  },
];

export const cooldownsModel: SimModel = {
  id: "containers-scaling-cooldowns",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const state = initialState();
    const frame = buildFrame(p, seed, compute(p, 0, state));
    seedSeries(frame);
    frame.flags.tasks = state.tasks;
    frame.flags.ready = state.ready;
    frame.flags.outCooldown = state.outCooldown;
    frame.flags.inCooldown = state.inCooldown;
    frame.flags.lowSeconds = state.lowSeconds;
    frame.flags.churn = state.churn;
    return frame;
  },
  step: (frame, p, dt) => {
    const state = readState(frame);
    const delta = Math.max(0, dt);
    const key = JSON.stringify(p);
    const hold = Math.max(0, num(p, "scaleInCooldown", 300));
    const reset = frame.flags.paramsKey !== key && frame.t < 1;
    const warmStart =
      reset && hold >= WARM_START_HOLD
        ? Math.max(
            INITIAL_TASKS,
            Math.min(
              MAX_TASKS,
              Math.ceil(demandAt(p, 0) / (TASK_CAPACITY * SCALE_OUT_UTIL)),
            ),
          )
        : null;
    let tasks = warmStart ?? state.tasks;
    let ready = warmStart ?? approach(state.ready, tasks, delta * READY_RAMP);
    let outCooldown = Math.max(0, state.outCooldown - delta);
    let inCooldown = Math.max(0, state.inCooldown - delta);
    let lowSeconds = state.lowSeconds;
    let churn = Math.max(0, state.churn - delta / 60);

    const demand = demandAt(p, frame.t);
    const readyCapacity = Math.max(1, ready * TASK_CAPACITY);
    const load = demand / readyCapacity;

    if (outCooldown <= 0 && load > SCALE_OUT_UTIL) {
      const needed = Math.max(MIN_TASKS, Math.ceil(demand / (TASK_CAPACITY * SCALE_OUT_UTIL)));
      if (needed > tasks) {
        tasks = Math.min(MAX_TASKS, Math.max(tasks + 2, needed));
        outCooldown = Math.max(0, num(p, "scaleOutCooldown", 60));
        churn += 1;
      }
    }

    const low = demand < readyCapacity * LOW_UTIL;
    lowSeconds = low ? lowSeconds + delta : 0;
    if (lowSeconds >= hold && inCooldown <= 0 && tasks > MIN_TASKS) {
      const needed = Math.max(MIN_TASKS, Math.ceil(demand / (TASK_CAPACITY * SCALE_OUT_UTIL)));
      const next = Math.max(MIN_TASKS, Math.min(tasks - 2, needed));
      if (next < tasks) {
        tasks = next;
        inCooldown = 10;
        lowSeconds = 0;
        churn += 1;
      }
    }

    ready = Math.min(ready, tasks);

    const nextState: State = { tasks, ready, outCooldown, inCooldown, lowSeconds, churn };
    const values = compute(p, frame.t, nextState);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      tasks,
      ready,
      outCooldown,
      inCooldown,
      lowSeconds,
      churn,
    };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, points]) => [key, [...points]]),
    );
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const state = readState(frame);
    const values = compute(p, frame.t, state);
    return [
      `The burst adds ${Math.round(num(p, "spikeSize", 0)).toLocaleString()} rps for ${Math.round(num(p, "spikeDuration", 20))} seconds on a 45-second cycle.`,
      `The service has ${values.tasks} desired and ${Math.round(values.ready)} ready tasks; current demand implies ${values.required}.`,
      values.excess >= 10
        ? `${values.excess} tasks are warm capacity above current demand. That is the cost side of a long scale-in hold.`
        : "Warm capacity is small, so the service is tracking demand closely between bursts.",
      `Scale-out cooldown is ${Math.round(num(p, "scaleOutCooldown", 60))} seconds and scale-in hold is ${Math.round(num(p, "scaleInCooldown", 300))} seconds. The gap between bursts matters more than either value alone.`,
      "Application Auto Scaling's ECS default cooldown is 300 seconds. A cooldown is a wait after an action, not proof that the load is sustained.",
    ];
  },
  legend: [
    { label: "Tracking demand", tone: "ok" },
    { label: "Warm capacity", tone: "warn" },
    { label: "Chasing noise", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Flat 1,400 rps with ten ready tasks and a 300-second scale-in hold modeled on the ECS cooldown default.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Short burst",
    description: "A 1,200 rps burst for ten seconds. The policy adds tasks once and keeps them.",
    tone: "warn",
    params: defaults({ spikeSize: 1_200, spikeDuration: 10, scaleOutCooldown: 60, scaleInCooldown: 60 }),
  },
  {
    id: "failure",
    label: "Noise chasing",
    description: "An eight-second burst repeats every 45 seconds with five-second cooldowns in both directions.",
    tone: "crit",
    params: defaults({ spikeSize: 1_600, spikeDuration: 8, scaleOutCooldown: 5, scaleInCooldown: 5 }),
  },
  {
    id: "recovery",
    label: "Stabilized",
    description: "The same repeating burst starts with 15 warm tasks, and a 300-second scale-in hold keeps them for the next one.",
    tone: "ok",
    params: defaults({ spikeSize: 1_600, spikeDuration: 8, scaleOutCooldown: 5, scaleInCooldown: 300 }),
  },
  {
    id: "sustained",
    label: "Sustained spike",
    description: "A 45-second burst. Scale-in never engages during the burst, so the hold barely matters.",
    tone: "info",
    params: defaults({ spikeSize: 1_600, spikeDuration: 45, scaleOutCooldown: 60, scaleInCooldown: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-cooldown",
  title: "Predict what a short hold does between bursts",
  simId: "scaling-cooldowns",
  question:
    "A 1,600 rps burst lasts 20 seconds and repeats 45 seconds after it starts. The scale-in hold is five seconds. Will the service keep the tasks it added for the next burst?",
  prediction: {
    options: [
      { id: "keep", label: "Yes. A cooldown always keeps capacity until the next burst" },
      { id: "remove", label: "No. It removes the tasks during the quiet period and starts the next burst short" },
      { id: "cooldown", label: "No, because the scale-out cooldown blocks the first addition" },
      { id: "forever", label: "Yes, until the service reaches its maximum task count" },
    ],
    correctOptionId: "remove",
    explanation:
      "The five-second hold is shorter than the quiet period between bursts. Low load persists, the policy removes the tasks, and the next burst starts with too few ready tasks. A cooldown delays an action; it does not preserve capacity indefinitely.",
  },
  setup: defaults({ spikeSize: 1_600, spikeDuration: 20, scaleOutCooldown: 5, scaleInCooldown: 5 }),
  runFor: 50,
  observe: [
    "The task count rises to meet the first burst.",
    "During the quiet period, the short hold expires and the task count falls back.",
    "The next burst starts short, so p99 and the task shortfall rise again.",
    "Raising the scale-in hold to 120 seconds keeps the warm tasks through the quiet period.",
  ],
  explain:
    "Cooldowns are timers around scaling actions. A scale-out cooldown limits how often the policy adds capacity; a scale-in cooldown blocks removal until it expires. Neither one knows whether the load is a real trend or a burst. The operator has to line the timers up with the workload's duration, its quiet gaps, and the time new tasks need to become ready.",
  fix: defaults({ spikeSize: 1_600, spikeDuration: 20, scaleOutCooldown: 5, scaleInCooldown: 120 }),
  debrief:
    "With a 120-second hold, the added tasks stay through the quiet period and the next burst starts with capacity. The tradeoff is that the service also keeps those tasks after the bursts stop. A long hold is a bet that the gap is shorter than the hold. If that bet is wrong, you pay for idle tasks.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A cooldown is a timer that starts after a scaling activity and blocks another activity of the same direction until it expires. Amazon ECS service auto scaling exposes a scale-out cooldown and a scale-in cooldown. Application Auto Scaling uses a default of 300 seconds for ECS services. The point is not to make scaling slow; it is to give the capacity already added time to affect the metric before the policy decides again. The model applies the scale-in value as a low-load hold so the burst interaction is visible; ECS measures the cooldown from the last scaling activity.",
  },
  {
    type: "p",
    text: "Scale-in needs more protection than scale-out. If a metric falls during a normal trough, an eager scale-in removes tasks that will be needed when traffic returns. The next rise then waits for image pull, application startup, and health checks. A scale-in cooldown or stabilization period keeps those tasks through the trough. The cost is idle capacity. The right value depends on burst duration, the quiet gap, task startup time, and how much you are willing to pay for warm capacity.",
  },
  {
    type: "table",
    headers: ["Mechanism", "What it controls", "Effect on a short burst"],
    rows: [
      ["Scale-out cooldown", "Wait after adding capacity", "Limits repeated additions; does not prevent the first one"],
      ["Scale-in cooldown", "Wait before removing capacity", "Keeps warm tasks through a quiet gap"],
      ["Stabilization window", "How long a low signal must persist", "Similar intent; exposed directly by some autoscalers"],
      ["Scheduled scaling", "Capacity by time", "Avoids reacting to a burst you already know about"],
    ],
  },
  {
    type: "p",
    text: "Cooldowns also interact with the metric pipeline. ECS publishes service metrics at one-minute intervals, and CloudWatch alarms need data points before they change state. A burst shorter than the evaluation window may never produce a clean scaling signal. A long cooldown can then hold capacity that the metric no longer justifies, or delay a second addition that a real spike needs. This is why the workload duration, not a generic default, should drive the value.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The cooldown is part of the Application Auto Scaling policy attached to the ECS service. It sits between the CloudWatch alarm and the desired count. The service scheduler, task startup, health checks, and load balancer registration sit after it, so the observed effect of a scaling action is always delayed relative to the action itself.",
  },
  {
    type: "p",
    text: "A scale-out during a scale-in cooldown cancels the scale-in and scales out immediately. That safety behavior helps when demand returns, but it is not a substitute for a sensible hold. If the policy oscillates, the fix is usually to make scale-in more conservative, not to make scale-out slower.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A repeating burst and the task count that chases it.",
      "Warm tasks above current demand, which is the cost of holding capacity.",
      "Scaling actions per minute, which separates a stable policy from one chasing noise.",
      "p99 latency at the start of a burst when the previous scale-in removed capacity too early.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Noise chasing to see five-second cooldowns follow an eight-second burst. Apply Stabilized to keep the same traffic with a 300-second scale-in hold. Try Sustained spike to see that a long burst does not need a long hold to stay scaled.",
  },
  { type: "sim", simId: "scaling-cooldowns" },
  { type: "experiment", experimentId: "predict-cooldown" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The noise-chasing preset used an eight-second burst on a 45-second cycle with five-second cooldowns. The policy scaled out for the burst, then removed the tasks as soon as the quiet period lasted five seconds. The next burst began with seven tasks against 3,000 rps of demand. Because new tasks need startup time, p99 and the shortfall rose before the policy could add capacity again.",
  },
  {
    type: "p",
    text: "The stabilized preset kept the same burst and the same five-second scale-out cooldown, but raised the scale-in hold to 300 seconds. The policy still added tasks for the burst; it simply did not remove them during the quiet period. The next burst started with warm capacity. The cost was visible as tasks above the current requirement.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Application Auto Scaling scaling activities with timestamps and the reason for each action.",
      "ECS desired, running, ready, and pending task counts around each burst.",
      "Task startup duration from the service event timestamps to the first healthy target.",
      "p99 latency and request rate on the same timeline as the scaling activities.",
      "The cost of warm tasks, which is easy to miss when only availability is monitored.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the scaling activities with the burst period. If scale-in happens between bursts, the hold is too short for that workload. If scale-out happens but capacity still lags, check the scale-out cooldown and task startup time before changing the threshold.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the burst duration and the quiet gap between bursts.",
      "Measure task startup to ready and include health-check time.",
      "Set the scale-in hold longer than the quiet gap you want to ride through.",
      "Set the scale-out cooldown from the time the added capacity needs to affect the metric.",
      "Keep a minimum capacity floor for the first seconds of a known burst.",
      "Use scheduled scaling when the burst pattern is predictable.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long scale-in hold keeps warm capacity and costs money during quiet periods.",
      "A short hold tracks demand closely and risks a cold start at the next burst.",
      "A long scale-out cooldown prevents overshoot but can delay a second needed addition.",
      "A minimum capacity floor is simple and predictable, but it is always paid for.",
      "Scheduled scaling fits a known pattern and is brittle when the pattern changes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "one-minute-spike",
    question:
      "A one-minute spike triggers 30 tasks, and then they all scale in. What do you change?",
    difficulty: 2,
    hints: [
      "Ask whether the spike is real demand or noise.",
      "The hold needs to match the quiet period, not the spike height.",
    ],
    answer:
      "First I would check whether the 30 tasks were justified by the spike and whether the scale-in happened during a normal quiet period. If the spike was real but short, keeping some warm capacity may be cheaper than starting from scratch at the next one. I would raise the scale-in cooldown or stabilization window to cover the gap between bursts, and keep the scale-out path responsive. I would also check task startup time, because a long startup makes premature scale-in more expensive. If the pattern is predictable, scheduled scaling is a better fit than reacting to every spike. The tradeoff is paying for idle tasks during genuinely quiet periods, so I would set the hold from measured burst spacing and review the cost.",
    followUps: [
      "How would you tell a real spike from noise?",
      "What would you change if the bursts were unpredictable?",
      "How does task startup time affect the hold?",
    ],
    redFlags: [
      "Raises the scale-out threshold to avoid scaling at all.",
      "Makes scale-out slower instead of scale-in more conservative.",
      "Ignores the cost of warm capacity.",
    ],
    rubric: [
      "Separates burst response from scale-in protection.",
      "Uses measured burst spacing.",
      "Accounts for task startup.",
      "States the cost tradeoff.",
    ],
  },
  {
    id: "cooldown-default",
    question:
      "Why is the ECS service auto scaling cooldown default 300 seconds, and when would you change it?",
    difficulty: 2,
    hints: [
      "The cooldown gives added capacity time to affect the metric.",
      "A short burst may not deserve a full default.",
    ],
    answer:
      "The default is a conservative starting point: it gives newly added tasks time to start, pass health checks, and affect the metric before the policy acts again. I would shorten it only when I have measured that the metric responds faster and the workload needs faster successive additions. I would lengthen it when the service is overshooting because several scale-out decisions land before the first batch is serving. For scale-in, I would be more conservative than for scale-out, because removing capacity too early is what causes the next burst to start short.",
    followUps: [
      "What evidence would justify shortening the cooldown?",
      "How would you test a new cooldown value?",
      "What happens if the cooldown is longer than the burst?",
    ],
    redFlags: [
      "Changes the default without measurement.",
      "Uses the same value for scale-out and scale-in without thought.",
      "Ignores metric publication delay.",
    ],
    rubric: [
      "Explains the purpose of the cooldown.",
      "Ties changes to measurement.",
      "Treats scale-in more conservatively.",
      "Accounts for metric delay.",
    ],
  },
  {
    id: "stabilization-vs-cooldown",
    question:
      "How is a stabilization window different from a cooldown, and why does the distinction matter?",
    difficulty: 3,
    hints: [
      "One is a wait after an action; the other evaluates how long a signal has persisted.",
      "The distinction changes what you tune when latency spikes after a scale-in.",
    ],
    answer:
      "A cooldown starts after a scaling action and blocks another action for a fixed period. A stabilization window looks at the signal over time and asks whether the low or high condition has persisted long enough to act. ECS service auto scaling exposes cooldowns; some autoscalers expose a stabilization window directly. The practical difference is that a cooldown can expire while the load is still low, and then the policy scales in immediately. A stabilization window keeps evaluating the signal. For a repeating burst, I care about how long the quiet period lasts and how long the low signal must persist before removal. If latency spikes right after a scale-in, the hold is too short regardless of what it is called.",
    followUps: [
      "Which would you tune first for a repeating burst?",
      "How would you measure the low-signal duration?",
      "Why can a cooldown expire at the wrong time?",
    ],
    redFlags: [
      "Uses the terms interchangeably.",
      "Tunes only the threshold.",
      "Ignores the signal history.",
    ],
    rubric: [
      "Defines both mechanisms.",
      "Connects the hold to the quiet period.",
      "Notes the ECS cooldown model.",
      "Chooses a fix based on the observed timing.",
    ],
  },
];

const checklist = [
  {
    title: "Before the policy",
    items: [
      "Measure burst duration, quiet gap, and the repeat interval.",
      "Measure task startup to ready, including health checks.",
      "Decide how much warm capacity is worth paying for.",
      "Set a minimum capacity floor for the first seconds of a known burst.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Compare scale-in timestamps with the next latency spike.",
      "Check desired, ready, and pending tasks around the burst.",
      "Check whether the scale-out cooldown delayed a second needed addition.",
      "Check the cost of warm tasks, not just availability.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Tune the scale-in hold against the measured quiet gap.",
      "Tune the scale-out cooldown against the metric response time.",
      "Consider scheduled scaling if the pattern is predictable.",
      "Record the burst shape used in the decision.",
    ],
  },
];

const references = [
  {
    title: "Automatically scale your Amazon ECS service",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Scale-out and scale-in cooldowns, and the interaction between scaling and deployments.",
  },
  {
    title: "How target tracking scaling for Application Auto Scaling works",
    url: "https://docs.aws.amazon.com/autoscaling/application/userguide/target-tracking-scaling-policy-overview.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Cooldown periods, the 300-second default for ECS services, and conservative scale-in behavior.",
  },
  {
    title: "Cooldowns for Application Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-cooldowns.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How cooldown periods delay scaling activities.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "scaling-cooldowns": {
      model: cooldownsModel,
      presets,
      instructions:
        "Start Healthy, then apply Noise chasing to watch short cooldowns follow an eight-second burst. Apply Stabilized to keep the same traffic with a longer scale-in hold. Try Sustained spike to see a burst that lasts long enough that the hold barely matters.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The fixed 1,400 rps baseline, 45-second burst cycle, 300 rps per task, ten initial tasks, forty-task maximum, four-task minimum, and one-task-per-second ready ramp are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-step-scaling",
    "containers-rolling-deployments",
    "containers-fargate-cold-start",
    "containers-target-tracking",
  ],
};
