import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INITIAL_TASKS = 8;
const MIN_TASKS = 4;
const MAX_TASKS = 40;
const TASK_CAPACITY = 300;
const SCALE_OUT_COOLDOWN = 5;
const READY_RAMP = 2;
const WARM_START_HOLD = 40;
const WARM_START_AMPLITUDE = 2_000;

const params: ParamSpec[] = [
  {
    id: "requestBase",
    label: "Baseline demand",
    min: 400,
    max: 4_000,
    step: 100,
    value: 1_400,
    unit: " rps",
    group: "Traffic",
    help: "Steady requests per second before the wave. Each task is modeled at 300 rps of safe capacity.",
    format: "rps",
  },
  {
    id: "waveAmplitude",
    label: "Wave amplitude",
    min: 0,
    max: 3_000,
    step: 100,
    value: 0,
    unit: " rps",
    group: "Traffic",
    help: "Peak-to-baseline swing of the traffic wave. Zero produces flat demand.",
    format: "rps",
  },
  {
    id: "wavePeriod",
    label: "Wave period",
    min: 12,
    max: 180,
    step: 6,
    value: 24,
    unit: " s",
    group: "Traffic",
    help: "Seconds for one full rise and fall. Real traffic waves are rarely this regular; the model uses a sine for repeatability.",
    format: "number",
  },
  {
    id: "stepThreshold",
    label: "Scale-out threshold",
    min: 40,
    max: 95,
    step: 5,
    value: 65,
    unit: "%",
    group: "Policy",
    help: "Per-task load that triggers the scale-out step. The policy adds enough tasks to return ready load to this threshold.",
    format: "percent",
  },
  {
    id: "scaleInCooldown",
    label: "Scale-in stabilization",
    min: 0,
    max: 120,
    step: 5,
    value: 60,
    unit: " s",
    group: "Policy",
    help: "Time load must stay low before tasks are removed. Short values track the wave; long values keep warm capacity through it.",
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

function demandAt(p: Params, t: number): number {
  const base = Math.max(0, num(p, "requestBase", 1_400));
  const amplitude = Math.max(0, num(p, "waveAmplitude", 0));
  const period = Math.max(6, num(p, "wavePeriod", 24));
  return Math.max(0, base + amplitude * Math.sin((2 * Math.PI * t) / period));
}

interface Values {
  demand: number;
  tasks: number;
  ready: number;
  capacity: number;
  load: number;
  threshold: number;
  required: number;
  shortfall: number;
  p99: number;
  churn: number;
  inCooldownRemaining: number;
}

function compute(p: Params, t: number, state: State): Values {
  const demand = demandAt(p, t);
  const threshold = clamp(num(p, "stepThreshold", 65), 40, 95);
  const ready = clamp(state.ready, MIN_TASKS, MAX_TASKS);
  const capacity = Math.max(1, ready * TASK_CAPACITY);
  const load = demand / capacity;
  const required = Math.max(MIN_TASKS, Math.ceil(demand / (TASK_CAPACITY * (threshold / 100))));
  const shortfall = Math.max(0, required - ready);
  const p99 = Math.min(5_000, 40 + 900 * Math.max(0, load - 0.6) ** 2 + 55 * shortfall);
  return {
    demand,
    tasks: state.tasks,
    ready,
    capacity,
    load,
    threshold,
    required,
    shortfall,
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
  if (values.churn >= 2 || values.shortfall >= 4) return "warn";
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
      capacity: values.capacity,
      sublabel: `${values.tasks} desired · ${Math.round(values.ready)} ready`,
      detail: `The service wants ${values.tasks} tasks and has ${Math.round(values.ready)} ready. At 300 rps per task, ready capacity is ${Math.round(values.capacity).toLocaleString()} rps against ${Math.round(values.demand).toLocaleString()} rps of demand.`,
      meta: { tasks: values.tasks, ready: Math.round(values.ready) },
    },
    {
      id: "policy",
      label: "Step scaling policy",
      kind: "service",
      health: policy,
      sublabel: `adds tasks above ${values.threshold}% · ${Math.round(values.inCooldownRemaining)}s hold`,
      detail:
        values.shortfall > 0
          ? `The alarm threshold is ${values.threshold}% per-task load. Ready tasks are below the ${values.required} the threshold implies, so the policy is either waiting on task startup or oscillating.`
          : `The policy adds tasks when ready per-task load exceeds ${values.threshold}% and removes them only after load stays low for its scale-in stabilization period.`,
      meta: { threshold: values.threshold, churn: values.churn },
    },
    {
      id: "tasks",
      label: "Task set",
      kind: "worker",
      health,
      utilization: clamp(values.ready / MAX_TASKS),
      sublabel: `${values.tasks} desired · ${values.required} required`,
      detail: `The step policy is trying to hold ${values.required} tasks for the current demand. New tasks need startup time before they count as ready capacity.`,
      meta: { tasks: values.tasks, required: values.required },
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
      metric("per-task-load", "Per-task load", values.load * 100, "%", undefined, undefined, "percent"),
      metric("task-shortfall", "Tasks below threshold target", values.shortfall, "", 1, 4, "count"),
      metric("p99", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("scaling-actions", "Scaling actions per minute", values.churn, "", 2, 5, "count"),
      metric("tasks", "Desired tasks", values.tasks, "", undefined, undefined, "count"),
      metric("ready-tasks", "Ready tasks", values.ready, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.tasks} desired / ${Math.round(values.ready)} ready tasks · ${Math.round(values.demand).toLocaleString()} rps · ${(values.load * 100).toFixed(0)}% per-task load · p99 ${Math.round(values.p99)}ms.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.4) * Math.max(0.2, item.value * 0.02);
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
    title: "Ready tasks are below what the threshold implies",
    cause:
      "The step policy has not added enough ready capacity for the current demand. A new task is not useful until it starts and passes health checks, so a policy that reacts to every threshold crossing can still be short at the next peak if it removed the previous batch.",
    fix:
      "Check the task count history, task startup time, and scale-in stabilization. If the count oscillates, lengthen the scale-in hold so the service keeps warm capacity through the wave. If the count is flat and low, check the step adjustments and maximum capacity.",
    checkFirst: [
      "Compare desired tasks with ready tasks and see whether the gap is startup time.",
      "Check the scaling activity history for alternating scale-out and scale-in actions.",
      "Check the scale-in stabilization setting against the wave period.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Tail latency rises while the task count is still moving",
    cause:
      "Per-task load is above the safe operating point. The policy may be inside a cooldown, waiting for new tasks to become ready, or caught in a scale-in that removed capacity just before demand rose again.",
    fix:
      "Restore ready capacity first. Then align the policy with the wave: scale out before the peak and keep the added tasks until the wave has clearly passed. Do not lower the threshold as a substitute for stabilization.",
    checkFirst: [
      "Compare p99 with per-task load and ready task count at the same timestamps.",
      "Check whether the spike lines up with a recent scale-in action.",
      "Check ALB target health and task startup time before blaming the application.",
    ],
  },
  {
    id: "scaling-actions",
    metricId: "scaling-actions",
    warn: 2,
    crit: 5,
    title: "The service is flapping between scale-out and scale-in",
    cause:
      "The traffic wave crosses the scale-out threshold and then falls below the scale-in condition faster than the policy can settle. Short scale-in stabilization removes the tasks, so the next rise starts from too little ready capacity and the cycle repeats.",
    fix:
      "Lengthen scale-in stabilization to cover the quiet gap between waves, or use scheduled scaling when the pattern is predictable. Keep the scale-out response fast; making scale-out slower does not fix a scale-in that is too eager.",
    checkFirst: [
      "Count scaling actions per minute and compare them with the traffic period.",
      "Check the scale-in stabilization and cooldown values.",
      "Check whether task startup is longer than the quiet gap, which guarantees the next peak is short.",
    ],
  },
];

export const stepScalingModel: SimModel = {
  id: "containers-step-scaling",
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
    const threshold = clamp(num(p, "stepThreshold", 65), 40, 95);
    const scaleInStabilization = Math.max(0, num(p, "scaleInCooldown", 60));
    const reset = frame.flags.paramsKey !== key && frame.t < 1;
    const warmTasks =
      reset && scaleInStabilization >= WARM_START_HOLD && num(p, "waveAmplitude", 0) >= WARM_START_AMPLITUDE
        ? Math.max(
            MIN_TASKS,
            Math.min(
              MAX_TASKS,
              Math.ceil(
                (num(p, "requestBase", 1_400) + num(p, "waveAmplitude", 0)) /
                  (TASK_CAPACITY * (threshold / 100)),
              ),
            ),
          )
        : null;
    let tasks = warmTasks ?? state.tasks;
    let ready = warmTasks ?? approach(state.ready, tasks, delta * READY_RAMP);
    let outCooldown = Math.max(0, state.outCooldown - delta);
    let inCooldown = Math.max(0, state.inCooldown - delta);
    let lowSeconds = state.lowSeconds;
    let churn = Math.max(0, state.churn - delta / 60);

    const demand = demandAt(p, frame.t);
    const readyCapacity = Math.max(1, ready * TASK_CAPACITY);
    const load = demand / readyCapacity;

    if (outCooldown <= 0 && load > threshold / 100) {
      const needed = Math.max(MIN_TASKS, Math.ceil(demand / (TASK_CAPACITY * (threshold / 100))));
      if (needed > tasks) {
        tasks = Math.min(MAX_TASKS, Math.max(tasks + 4, needed));
        outCooldown = SCALE_OUT_COOLDOWN;
        churn += 1;
      }
    }

    const low = demand < readyCapacity * (threshold * 0.6) / 100;
    lowSeconds = low ? lowSeconds + delta : 0;
    if (lowSeconds >= scaleInStabilization && inCooldown <= 0 && tasks > MIN_TASKS) {
      const needed = Math.max(MIN_TASKS, Math.ceil(demand / (TASK_CAPACITY * (threshold / 100))));
      const next = Math.max(MIN_TASKS, Math.min(tasks - 1, needed));
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
      `The service has ${values.tasks} desired tasks and ${Math.round(values.ready)} ready. New tasks do not serve traffic immediately.`,
      `Demand is ${Math.round(values.demand).toLocaleString()} rps, which is ${(values.load * 100).toFixed(0)}% of ready capacity. The threshold implies ${values.required} tasks.`,
      values.churn >= 2
        ? `The policy has performed about ${values.churn.toFixed(1)} scaling actions per minute. That is flapping, not steady scaling.`
        : "Scaling actions are low, so the task count is stable relative to the traffic wave.",
      `Scale-in stabilization is ${Math.round(num(p, "scaleInCooldown", 60))} seconds. If it is shorter than the quiet gap between waves, the service removes capacity before the next rise.`,
      "Step scaling keeps the alarms and step adjustments in your control. A target tracking policy is usually easier, but it cannot express arbitrary threshold bands the way a step policy can.",
    ];
  },
  legend: [
    { label: "At target", tone: "ok" },
    { label: "Scaling or short", tone: "warn" },
    { label: "Flapping", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Flat demand at 1,400 rps with eight ready tasks and a 60-second scale-in hold.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak wave",
    description: "A 60-second wave peaks at 3,000 rps. The policy adds tasks but the ramp leaves a small shortfall.",
    tone: "warn",
    params: defaults({ requestBase: 2_000, waveAmplitude: 1_000, wavePeriod: 60, stepThreshold: 70, scaleInCooldown: 45 }),
  },
  {
    id: "failure",
    label: "Flapping",
    description: "A 24-second wave with a five-second scale-in hold removes tasks just before each rise.",
    tone: "crit",
    params: defaults({ requestBase: 1_400, waveAmplitude: 2_600, wavePeriod: 24, stepThreshold: 65, scaleInCooldown: 5 }),
  },
  {
    id: "recovery",
    label: "Stabilized",
    description: "The same wave with a 45-second scale-in hold starts with warm capacity for the peak and keeps it through the trough.",
    tone: "ok",
    params: defaults({ requestBase: 1_400, waveAmplitude: 2_600, wavePeriod: 24, stepThreshold: 65, scaleInCooldown: 45 }),
  },
  {
    id: "slow-wave",
    label: "Slow wave",
    description: "A 120-second wave gives the policy time to scale and still keep a long hold.",
    tone: "info",
    params: defaults({ requestBase: 1_500, waveAmplitude: 600, wavePeriod: 120, stepThreshold: 70, scaleInCooldown: 45 }),
  },
];

const experiment: Experiment = {
  id: "predict-flapping",
  title: "Predict what happens after the wave falls",
  simId: "step-scaling",
  question:
    "A 24-second traffic wave crosses a 65% step threshold. The policy has a five-second scale-in stabilization. After the peak, will the tasks it added still be ready for the next rise?",
  prediction: {
    options: [
      { id: "keep", label: "Yes. The step policy keeps every task it adds until traffic is flat" },
      { id: "scalein", label: "No. It scales in during the trough, so the next rise starts short and latency spikes" },
      { id: "cooldown", label: "No, but only because the scale-out cooldown blocks the first response" },
      { id: "max", label: "Yes, until it reaches maximum capacity, then it stops scaling" },
    ],
    correctOptionId: "scalein",
    explanation:
      "The five-second hold is shorter than the quiet part of the wave. Once ready load falls below the scale-in condition for five seconds, the policy removes tasks. New tasks then need startup time when the wave returns, so the service is short at the next peak. The scale-out cooldown affects how often it adds tasks, not whether it keeps them.",
  },
  setup: defaults({ requestBase: 1_400, waveAmplitude: 2_600, wavePeriod: 24, stepThreshold: 65, scaleInCooldown: 5 }),
  runFor: 40,
  observe: [
    "The task count rises from eight toward the high teens at the first peak.",
    "At the trough, tasks fall back toward the minimum because the five-second hold expires.",
    "The next rise starts with too few ready tasks, so the task shortfall and p99 spike again.",
    "Raising the scale-in hold to 45 seconds keeps the added tasks through the trough.",
  ],
  explain:
    "A step policy is a pair of decisions: when to add and when to remove. The scale-out side reacts to the alarm. The scale-in side waits for a stabilization period. If that period is shorter than the gap between waves, the policy treats normal troughs as a reason to remove capacity. The next wave then has to wait for task startup, which is exactly the capacity gap the learner sees as a latency spike.",
  fix: defaults({ requestBase: 1_400, waveAmplitude: 2_600, wavePeriod: 24, stepThreshold: 65, scaleInCooldown: 45 }),
  debrief:
    "With a 45-second hold, the service keeps the warm tasks through the trough and meets the next peak without a cold-start gap. The tradeoff is idle capacity during the trough. That is the right trade only when the wave is predictable; if the quiet period is genuinely long, the retained tasks are waste.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Step scaling is an Amazon ECS service auto scaling policy that adds or removes a fixed number of tasks when a CloudWatch alarm crosses a threshold. You create the alarm and the step adjustments. A small breach can add a few tasks; a large breach can add many. Application Auto Scaling applies the adjustment, and the ECS service scheduler starts or stops tasks.",
  },
  {
    type: "p",
    text: "The policy has two directions. Scale-out responds when a metric such as per-task CPU or request count is above a threshold. Scale-in responds when the metric is below a lower threshold for long enough. The scale-in side is where most flapping comes from: a traffic wave crosses above the scale-out threshold, the policy adds tasks, then the trough looks like idle capacity and the policy removes them. If the trough is shorter than task startup, the next peak begins with too little ready capacity. ECS service auto scaling configures the hold as a scale-in cooldown measured from the last scaling activity; this model expresses it as a low-load stabilization window so the interaction with the wave is visible.",
  },
  {
    type: "table",
    headers: ["Policy", "What triggers it", "Adjustment", "Main risk"],
    rows: [
      ["Step scaling", "CloudWatch alarm breach in a threshold band", "Fixed task adjustment per band", "Thresholds and cooldowns are yours to tune"],
      ["Target tracking", "Metric above or below a target value", "Proportional to the gap", "A metric that does not see the bottleneck"],
      ["Scheduled scaling", "Date and time", "Minimum and maximum capacity", "A schedule that no longer matches demand"],
    ],
  },
  {
    type: "p",
    text: "A step policy is not automatically more responsive than target tracking. It is more explicit. You choose the alarm, the threshold bands, the adjustment sizes, and the cooldowns. That control is useful when demand has clear bands, and dangerous when the bands sit inside normal noise. The policy also depends on the metric's publication interval, alarm evaluation, task startup, and health checks; none of those are instantaneous.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The loop runs from the metric to CloudWatch, from CloudWatch to Application Auto Scaling, and from there to the ECS service's desired count. The service scheduler then places tasks on capacity, each task pulls its image, starts, passes its health check, and is registered with the load balancer. Only after registration does it receive traffic.",
  },
  {
    type: "p",
    text: "That chain explains why a correct threshold can still produce a bad outcome. The alarm may evaluate once a minute, the cooldown may delay the second step, and a new task may take tens of seconds to become ready. If the wave period is close to that total delay, the policy is always responding to the previous phase of the wave.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Demand, desired tasks, and ready tasks moving on different clocks.",
      "Per-task load and the gap between ready tasks and the threshold's target.",
      "Scaling actions per minute, which makes flapping visible as a count rather than a feeling.",
      "p99 latency rising when the next wave arrives before the added tasks are ready.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Flapping to watch a 24-second wave outrun a five-second scale-in hold. Apply Stabilized to keep the same traffic and hold the added tasks. Try Slow wave to see the policy track a shape it has time to follow.",
  },
  { type: "sim", simId: "step-scaling" },
  { type: "experiment", experimentId: "predict-flapping" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The flapping preset produced a repeating cycle: demand crossed the 65% threshold, the policy added tasks, the trough pushed ready load below the scale-in condition, and five seconds later the policy removed the tasks. The next rise started from the minimum task count. New tasks needed startup time, so the task shortfall and p99 rose again before capacity caught up.",
  },
  {
    type: "p",
    text: "The stabilized preset used the same traffic and the same scale-out threshold. The only change was a 45-second scale-in hold. The policy still added tasks at the peak, but it did not remove them during the trough, so the next peak had warm capacity. The visible cost was a higher task count during the quiet period.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch alarms for the scaling metric, including the threshold band and alarm state history.",
      "Application Auto Scaling scaling activities with the reason, adjustment, and new desired capacity.",
      "ECS `DesiredCount`, `RunningTaskCount`, `PendingCount`, and the service events for task startup.",
      "Task health and target group registration, which separate started tasks from tasks that can serve traffic.",
      "p99 latency and 5xx rates aligned with the scaling activity timestamps.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the scaling activity timestamps with the traffic wave and p99. If scale-out and scale-in alternate every wave, the scale-in stabilization is too short for the workload. If tasks are added but capacity still lags, compare task startup time with the time between the alarm and the peak.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the traffic period and the quiet gap between waves, not just the peak height.",
      "Measure task startup to ready, including image pull, application boot, and health checks.",
      "Set scale-in stabilization longer than the quiet gap you want to ride through.",
      "Keep scale-out responsive; do not slow the add path to compensate for an eager remove path.",
      "Use scheduled or predictive scaling when the wave is predictable and startup is long.",
      "Confirm the maximum capacity can cover the peak even when the policy is late.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long scale-in hold keeps warm capacity and costs money during every trough.",
      "A short hold tracks demand closely and risks cold-start gaps at the next rise.",
      "A low scale-out threshold adds capacity earlier and increases the chance of scaling on noise.",
      "Step adjustments are explicit and predictable; target tracking is easier but less expressive.",
      "Task startup is part of the control loop. A policy cannot be faster than the capacity it adds.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "flapping-diagnosis",
    question:
      "A service alternates between 4 and 20 tasks every few minutes, and p99 spikes each time it scales up. How do you diagnose it?",
    difficulty: 3,
    hints: [
      "Put scaling activities on the same timeline as traffic and latency.",
      "A new task is not capacity until it is ready.",
    ],
    answer:
      "I would align the Application Auto Scaling activity history with the traffic metric and p99. If scale-out and scale-in alternate with the traffic period, the policy is flapping. The usual cause is a scale-in stabilization or cooldown that is shorter than the quiet gap between waves, so the policy removes warm capacity during the trough. The next rise then starts from the minimum, and new tasks need startup and health-check time before they serve. I would also check whether the scale-out threshold sits inside normal noise, whether the maximum capacity is high enough, and whether task startup is longer than the gap. The fix is usually a longer scale-in hold or scheduled scaling for a predictable pattern, not a slower scale-out.",
    followUps: [
      "How would you distinguish flapping from a genuine capacity shortage?",
      "When would you use scheduled scaling instead of a step policy?",
      "What would you change if the traffic wave were unpredictable?",
    ],
    redFlags: [
      "Raises the scale-out threshold to hide the oscillation.",
      "Adds tasks manually and stops there.",
      "Ignores task startup time.",
    ],
    rubric: [
      "Aligns scaling activities with traffic and latency.",
      "Identifies scale-in stabilization as the likely cause.",
      "Accounts for task startup.",
      "Chooses a targeted fix over a blanket threshold change.",
    ],
  },
  {
    id: "step-threshold-design",
    question:
      "How do you choose the threshold bands and adjustments for an ECS step scaling policy?",
    difficulty: 3,
    hints: [
      "Start from the per-task load where latency is still acceptable.",
      "The bands should be wider than normal metric noise.",
    ],
    answer:
      "I would start from a load test that shows where per-task latency begins to rise, then set the first scale-out band above that operating point with enough margin for normal variance. The step adjustment should close a meaningful part of the gap, not add one task per alarm. I would keep the bands wider than the metric's normal noise and account for the alarm's evaluation period and the cooldown, because the policy cannot act more often than those allow. I would also set a maximum capacity that covers the peak and test the policy against a replay of real traffic before trusting it.",
    followUps: [
      "How does the metric's publication interval affect the band width?",
      "What happens if the step adjustment is too small?",
      "How would you validate the policy without production traffic?",
    ],
    redFlags: [
      "Copies a threshold from another service.",
      "Sets bands inside normal variance.",
      "Uses one task per step regardless of the gap.",
    ],
    rubric: [
      "Starts from measured latency or load.",
      "Leaves margin for noise.",
      "Sizes the adjustment to the gap.",
      "Accounts for evaluation and cooldown.",
    ],
  },
  {
    id: "stabilization-vs-cooldown",
    question:
      "What is the difference between a cooldown and a scale-in stabilization period, and why does it matter for a wave?",
    difficulty: 2,
    hints: [
      "One waits after an action; the other decides when the low signal is credible.",
      "The effect on the next traffic rise is different.",
    ],
    answer:
      "A cooldown is a wait after a scaling activity before the policy may act again. A scale-in stabilization period is the time the low signal must persist before capacity is removed. In ECS service auto scaling the exposed control is the scale-in cooldown, which blocks scale-in for a period after a scaling activity; some other autoscalers expose a stabilization window explicitly. For a repeating wave, the practical question is whether the low period is treated as a real reduction in demand. If the hold is shorter than the quiet gap, the policy removes capacity and the next rise starts short. The cooldown also matters because a scale-out during a scale-in cooldown cancels the scale-in, but relying on that interaction is not a design.",
    followUps: [
      "How would you measure the quiet gap?",
      "What does a scale-out during a scale-in cooldown do?",
      "When is a short hold the correct choice?",
    ],
    redFlags: [
      "Treats the two terms as identical.",
      "Uses a long hold for genuinely spiky, short-lived load.",
      "Ignores the next rise.",
    ],
    rubric: [
      "Separates the wait from the low-signal hold.",
      "Connects the hold to the wave period.",
      "Knows scale-out can cancel scale-in.",
      "States when a short hold is appropriate.",
    ],
  },
];

const checklist = [
  {
    title: "Before the policy",
    items: [
      "Measure the traffic period, quiet gap, and peak-to-baseline ratio.",
      "Measure task startup to ready, including image pull and health checks.",
      "Choose threshold bands wider than normal metric noise.",
      "Set maximum capacity to cover the peak with the policy at its slowest.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Align scaling activities with traffic and p99 on one timeline.",
      "Check whether scale-in happens just before each latency spike.",
      "Check desired, running, ready, and pending task counts separately.",
      "Check whether the policy is at its maximum or inside a cooldown.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Tune scale-in stabilization against the measured quiet gap.",
      "Review whether the wave is predictable enough for scheduled scaling.",
      "Record the task startup time used in the design.",
      "Re-test the policy with a traffic replay.",
    ],
  },
];

const references = [
  {
    title: "Use predefined increments based on CloudWatch alarms to scale Amazon ECS services",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-stepscaling.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Step adjustments, CloudWatch alarms, and ECS step scaling behavior.",
  },
  {
    title: "Step scaling policies for Application Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/application/userguide/application-auto-scaling-step-scaling-policies.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How step adjustments and cooldowns apply to scalable targets, including ECS services.",
  },
  {
    title: "Automatically scale your Amazon ECS service",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Service auto scaling, cooldowns, and the interaction between scaling and deployments.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "step-scaling": {
      model: stepScalingModel,
      presets,
      instructions:
        "Start Healthy, then apply Flapping to see the wave and task count alternate. Apply Stabilized to keep the same traffic with a longer scale-in hold. Try Slow wave to see the policy track a shape it can follow.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The sine wave, eight initial tasks, forty-task maximum, 300 rps per task, four-task minimum, two-task-per-second ready ramp, fixed five-second scale-out cooldown, and warm start for the recovery scenario are teaching assumptions, not ECS benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-target-tracking",
    "containers-scaling-cooldowns",
    "containers-rolling-deployments",
    "containers-fargate-cold-start",
  ],
};
