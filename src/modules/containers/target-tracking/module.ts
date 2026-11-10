import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INITIAL_TASKS = 10;
const MIN_TASKS = 2;
const MAX_TASKS = 40;

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 500,
    max: 12_000,
    step: 100,
    value: 2_400,
    unit: " rps",
    group: "Demand",
    help: "Requests per second arriving at the service. Each task has a finite request capacity.",
    format: "rps",
  },
  {
    id: "taskCapacity",
    label: "Safe capacity per task",
    min: 100,
    max: 1_000,
    step: 50,
    value: 400,
    unit: " rps",
    group: "Capacity",
    help: "Requests per second one task can serve at the latency target. Illustrative, not a task-size benchmark.",
    format: "rps",
  },
  {
    id: "targetValue",
    label: "Target value",
    min: 30,
    max: 90,
    step: 5,
    value: 60,
    unit: "%",
    group: "Policy",
    help: "Target as a percentage of the metric's safe ceiling. For CPU this is CPU percent; for requests it is the share of each task's safe rate.",
    format: "percent",
  },
  {
    id: "metricChoice",
    label: "Scaling metric",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "0 is CPU utilization, 1 is requests per target, 2 is concurrency. Only a metric above its target triggers scale-out.",
    format: "count",
  },
  {
    id: "cooldownSeconds",
    label: "Scale-out cooldown",
    min: 10,
    max: 300,
    step: 10,
    value: 60,
    unit: " s",
    group: "Policy",
    help: "Time the policy waits after a scaling activity before another one. The Application Auto Scaling default for ECS services is 300 seconds; this demo uses shorter values.",
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

interface Computed {
  requestRate: number;
  taskCapacity: number;
  target: number;
  metricChoice: number;
  cooldownSeconds: number;
  tasks: number;
  loadRatio: number;
  cpu: number;
  metricValue: number;
  metricName: string;
  overshoot: number;
  requiredTasks: number;
  shortfall: number;
  p99: number;
  errorRate: number;
  capacity: number;
}

const metricNames = ["CPU utilization", "requests per target", "concurrency"];

function compute(p: Params, tasks: number): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 2_400));
  const taskCapacity = Math.max(1, num(p, "taskCapacity", 400));
  const target = clamp(num(p, "targetValue", 60), 30, 90);
  const metricChoice = Math.round(clamp(num(p, "metricChoice", 1), 0, 2));
  const cooldownSeconds = Math.max(0, num(p, "cooldownSeconds", 60));
  const capacity = tasks * taskCapacity;
  const loadRatio = requestRate / Math.max(1, capacity);
  const cpu = Math.min(55, 20 + 20 * loadRatio);
  const loadMetric = Math.min(400, loadRatio * 100);
  const metricValue = metricChoice === 0 ? cpu : loadMetric;
  const requiredTasks = Math.max(1, Math.ceil(requestRate / (taskCapacity * (target / 100))));
  return {
    requestRate,
    taskCapacity,
    target,
    metricChoice,
    cooldownSeconds,
    tasks,
    loadRatio,
    cpu,
    metricValue,
    metricName: metricNames[metricChoice],
    overshoot: Math.max(0, metricValue - target),
    requiredTasks,
    shortfall: Math.max(0, requiredTasks - tasks),
    p99: Math.min(5_000, 40 + 500 * loadRatio ** 3),
    errorRate: Math.min(10, Math.max(0, (loadRatio - 1.1) * 8)),
    capacity,
  };
}

function serviceHealth(values: Computed): Health {
  if (values.shortfall >= 4 || values.p99 >= 800) return "crit";
  if (values.shortfall >= 1 || values.p99 >= 300) return "warn";
  return "ok";
}

function policyHealth(values: Computed): Health {
  if (values.shortfall >= 3 && values.metricValue <= values.target) return "crit";
  if (values.shortfall >= 1 || values.overshoot >= 20) return "crit";
  if (values.overshoot > 0 || values.p99 >= 300) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, values: Computed, cooldown: number): SimFrame {
  const health = serviceHealth(values);
  const policy = policyHealth(values);
  const nodes: SimNode[] = [
    {
      id: "clients",
      label: "Clients",
      kind: "client",
      health: "ok",
      throughput: values.requestRate,
      sublabel: `${Math.round(values.requestRate).toLocaleString()} rps`,
    },
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.loadRatio),
      throughput: values.requestRate,
      capacity: values.capacity,
      sublabel: `${values.tasks} tasks · ${(values.loadRatio * 100).toFixed(0)}% per-task load`,
      detail: `Each task can serve about ${Math.round(values.taskCapacity)} rps at the latency target. The service is serving ${Math.round(values.requestRate).toLocaleString()} rps with ${values.tasks} tasks.`,
      meta: { tasks: values.tasks, load: values.loadRatio },
    },
    {
      id: "policy",
      label: "Target tracking policy",
      kind: "service",
      health: policy,
      sublabel: `${values.metricName} · target ${values.target}%`,
      detail:
        values.shortfall > 0 && values.metricValue <= values.target
          ? `The policy only scales out when ${values.metricName} is above ${values.target}%. It is at ${values.metricValue.toFixed(0)}% while the service needs about ${values.requiredTasks} tasks. The metric is not seeing the bottleneck.`
          : `The policy compares ${values.metricName} with the ${values.target}% target and adjusts the task count. The metric is at ${values.metricValue.toFixed(0)}%.`,
      meta: { metric: values.metricName, target: values.target, value: values.metricValue },
    },
    {
      id: "tasks",
      label: "Task set",
      kind: "worker",
      health,
      utilization: clamp(values.tasks / MAX_TASKS),
      sublabel: `${values.tasks} tasks · target needs ${values.requiredTasks}`,
      detail: `The service currently runs ${values.tasks} tasks. Reaching the target would need about ${values.requiredTasks}. The maximum for this model is ${MAX_TASKS}.`,
      meta: { tasks: values.tasks, required: values.requiredTasks },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("clients-service", "clients", "service", clamp(values.requestRate / 12_000), "ok"),
      edge("policy-service", "policy", "service", 0.6, policy, "adjusts desired count"),
      edge("service-tasks", "service", "tasks", clamp(values.tasks / MAX_TASKS), health),
    ],
    metrics: [
      metric("scaling-metric", `Scaling metric: ${values.metricName}`, values.metricValue, "%", undefined, undefined, "percent"),
      metric("target-overshoot", "Metric above target", values.overshoot, "%", 1, 20, "percent"),
      metric("p99", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("task-shortfall", "Tasks below target", values.shortfall, "", 1, 4, "count"),
      metric("tasks", "Task count", values.tasks, "", undefined, undefined, "count"),
      metric("required-tasks", "Tasks needed for target", values.requiredTasks, "", undefined, undefined, "count"),
      metric("load-per-task", "Per-task load", values.loadRatio * 100, "%", undefined, undefined, "percent"),
      metric("cooldown", "Cooldown remaining", cooldown, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.tasks} tasks at ${(values.loadRatio * 100).toFixed(0)}% per-task load; ${values.metricName} ${values.metricValue.toFixed(0)}% against a ${values.target}% target; p99 ${values.p99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.3) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, Math.min(item.value, item.value + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "target-overshoot",
    metricId: "target-overshoot",
    warn: 1,
    crit: 20,
    title: "The scaling metric is above target but capacity is not following",
    cause:
      "The policy wants to add tasks, but it is inside a cooldown or has reached its maximum capacity. A target tracking policy does not scale out when its metric is below target, so a capped or misconfigured policy can leave the gap open.",
    fix:
      "Check the policy's maximum capacity, the cooldown, and the scaling activities. If the service is already at its maximum, raise it or reduce per-task work. If a cooldown is blocking the response, shorten it only after confirming the workload is not noisy.",
    checkFirst: [
      "Describe the scaling policy and the scalable target maximum.",
      "Check recent scaling activities and the cooldown timestamps.",
      "Check whether the metric is above target and capacity is actually available.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Latency is breaching the target while the policy waits",
    cause:
      "Requests per task are above the safe capacity, so queueing raises tail latency. If the scaling metric does not reflect that load, the policy never receives a scale-out signal.",
    fix:
      "Choose a metric that rises with the bottleneck, such as requests per target or a custom concurrency metric. Confirm the metric is above its target before waiting for the policy to act.",
    checkFirst: [
      "Compare the scaling metric with p99 and per-task load at the same timestamps.",
      "Check whether the service is CPU-bound or waiting on a dependency.",
      "Check the task count and whether the policy has scaled at all.",
    ],
  },
  {
    id: "task-shortfall",
    metricId: "task-shortfall",
    warn: 1,
    crit: 4,
    title: "The task count is below what the target requires",
    cause:
      "Demand has outgrown the task count. The policy may be in a cooldown, capped at its maximum, or watching a different metric that has not crossed its target.",
    fix:
      "Check the metric value, the target, the cooldown, and the maximum capacity. If the metric is below target while the service is short, the metric choice is the problem, not the target value.",
    checkFirst: [
      "Check the scaling metric against its target before changing the desired count.",
      "Check the maximum capacity and recent scaling activities.",
      "Check per-task load and p99 to confirm the shortfall is real.",
    ],
  },
];

export const targetTrackingModel: SimModel = {
  id: "containers-target-tracking",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, compute(p, INITIAL_TASKS), 0);
    seedSeries(frame);
    frame.flags.tasks = INITIAL_TASKS;
    frame.flags.cooldown = 0;
    return frame;
  },
  step: (frame, p, dt) => {
    let tasks = Math.round(clamp(Number(frame.flags.tasks ?? INITIAL_TASKS), MIN_TASKS, MAX_TASKS));
    let cooldown = Math.max(0, Number(frame.flags.cooldown ?? 0));
    const before = compute(p, tasks);

    if (cooldown <= 0) {
      if (before.metricValue > before.target + 0.001) {
        const wanted = Math.ceil(tasks * (before.metricValue / before.target));
        const next = Math.min(MAX_TASKS, Math.max(tasks + 1, wanted));
        if (next > tasks) {
          tasks = next;
          cooldown = before.cooldownSeconds;
        }
      } else if (before.metricValue < before.target * 0.9 && tasks > MIN_TASKS) {
        const nextLoad = before.requestRate / ((tasks - 1) * before.taskCapacity) * 100;
        if (nextLoad <= before.target) {
          tasks -= 1;
          cooldown = before.cooldownSeconds;
        }
      }
    }

    cooldown = Math.max(0, cooldown - Math.max(0, dt));
    const values = compute(p, tasks);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed, values, cooldown);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, tasks, cooldown };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, values]) => [key, [...values]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const tasks = Number(frame.flags.tasks ?? INITIAL_TASKS);
    const values = compute(p, tasks);
    return [
      `The policy is watching ${values.metricName} at ${values.metricValue.toFixed(0)}% against a ${values.target}% target.`,
      values.metricValue <= values.target && values.shortfall > 0
        ? "The metric is below target while the service is short of tasks. Target tracking cannot scale out on a metric that never crosses its target."
        : `The service runs ${values.tasks} tasks and needs about ${values.requiredTasks} to hold the target.`,
      `Per-task load is ${(values.loadRatio * 100).toFixed(0)}%. Requests per task is the direct load signal; CPU is a proxy that can plateau when the workload waits on I/O.`,
      `At a 300-second cooldown, a second scale-out waits up to five minutes. The default is there to reduce oscillation, not to make the first response faster.`,
      "A target tracking policy scales out aggressively and scales in conservatively. It does not scale out when the metric is below target, even if latency is high.",
    ];
  },
  legend: [
    { label: "At target", tone: "ok" },
    { label: "Scaling", tone: "warn" },
    { label: "Metric blind spot", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Ten tasks at 60% of safe capacity, with requests per target as the scaling metric.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Demand rises to 3,600 rps. Requests per target scales the service from ten tasks to fifteen.",
    tone: "warn",
    params: defaults({ requestRate: 3_600, metricChoice: 1, targetValue: 60, cooldownSeconds: 60 }),
  },
  {
    id: "failure",
    label: "CPU blind spot",
    description: "Demand is 6,000 rps but the policy watches CPU, which plateaus below its target.",
    tone: "crit",
    params: defaults({ requestRate: 6_000, metricChoice: 0, targetValue: 60, cooldownSeconds: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The policy watches requests per target and scales to twenty-five tasks.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, metricChoice: 1, targetValue: 60, cooldownSeconds: 60 }),
  },
  {
    id: "maxed",
    label: "At maximum",
    description: "Demand is 12,000 rps on tasks that safely serve 200 rps each; the policy is capped at forty tasks.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, taskCapacity: 200, metricChoice: 1, targetValue: 60, cooldownSeconds: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-blind-metric",
  title: "Predict why the service does not scale",
  simId: "target-tracking",
  question:
    "A service runs ten tasks at 6,000 rps. CPU sits at 50% against a 60% target while p99 is above one second. Will target tracking add tasks?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. Latency is above target, so the policy will add tasks" },
      { id: "no", label: "No. The policy only scales out when its configured metric is above target" },
      { id: "scalein", label: "No, and it will scale in because CPU is below target" },
      { id: "alarm", label: "Yes, but only after the CloudWatch alarm for CPU enters ALARM" },
    ],
    correctOptionId: "no",
    explanation:
      "A target tracking policy scales out when the selected metric is above the target. CPU is below 60%, so the policy sees no reason to add capacity even though per-task load and latency are high. The metric, not the target value, is the problem.",
  },
  setup: defaults({ requestRate: 6_000, taskCapacity: 400, metricChoice: 0, targetValue: 60, cooldownSeconds: 60 }),
  runFor: 20,
  observe: [
    "The task count stays at ten while p99 reaches about 1,700ms.",
    "CPU is 50%, below the 60% target, so the policy has no scale-out signal.",
    "The task shortfall is fifteen against the twenty-five tasks needed for the target.",
    "Switching the metric to requests per target immediately scales the service to twenty-five tasks.",
  ],
  explain:
    "Target tracking is a feedback loop around one metric. If the metric does not move with the bottleneck, the loop is stable and wrong. CPU is a proxy for compute pressure; a service waiting on a dependency or queueing requests can have low CPU and long latency. Requests per target or a custom concurrency metric tracks the load that actually matters here.",
  fix: defaults({ requestRate: 6_000, taskCapacity: 400, metricChoice: 1, targetValue: 60, cooldownSeconds: 60 }),
  debrief:
    "With requests per target, the policy sees 150% against a 60% target and scales to twenty-five tasks. Per-task load returns to 60% and p99 falls to about 150ms. The tradeoff is that requests per target needs a load balancer metric and assumes requests have similar cost; a custom concurrency metric can be more faithful, at the cost of publishing and maintaining it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Target tracking is an Amazon ECS service auto scaling policy that keeps a metric near a target value. You choose a metric and a target, and Application Auto Scaling creates and manages the CloudWatch alarms, calculates how many tasks are needed, and changes the service's desired count. It scales out when the metric is above the target and scales in when the metric is below it.",
  },
  {
    type: "p",
    text: "The policy is a feedback loop, so the metric is the design decision. If the metric rises with the real bottleneck, the loop adds capacity before users are badly affected. If the metric plateaus below its target while requests queue, the loop is stable and wrong: it will not scale out, no matter how high latency climbs. Target tracking also does not scale out when the metric has insufficient data, and it scales in conservatively.",
  },
  {
    type: "table",
    headers: ["Metric", "Moves with", "Blind spot"],
    rows: [
      ["Average CPU utilization", "CPU-bound work", "I/O wait, dependency latency, and queueing with idle CPU"],
      ["Requests per target", "Arrival rate divided by task count", "Changes in per-request cost or traffic mix"],
      ["Custom concurrency or queue depth", "The resource that actually limits throughput", "Requires publishing, validating, and paying for the metric"],
    ],
  },
  {
    type: "p",
    text: "Cooldowns separate scaling activities. Application Auto Scaling uses a default of 300 seconds for ECS services, and scale-out is more aggressive than scale-in: the policy adds capacity proportionally when the metric is high, but removes capacity only when the metric is far enough below target that removal is unlikely to cause oscillation. A cooldown protects against flapping; it also delays the second response to a sustained spike.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The policy sits between CloudWatch and the ECS service. ECS publishes service-level CPU and memory metrics, and the load balancer publishes request count per target. Application Auto Scaling evaluates the metric, owns the alarms that trigger the policy, and writes a new desired count. The service scheduler then places the additional tasks, subject to cluster capacity.",
  },
  {
    type: "p",
    text: "That chain has several delays: metric publication, alarm evaluation, policy calculation, scheduler placement, image pull, application startup, and health checks. Target tracking can only shorten the part it owns. If tasks take two minutes to become healthy, a policy that reacts in one minute still cannot add useful capacity for two more minutes. The metric and the target decide whether scaling starts; startup time decides when it helps.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The selected scaling metric and its distance from the target.",
      "Task count and the number of tasks the target implies.",
      "Per-task load and p99 latency, which show whether the metric reflects the bottleneck.",
      "Cooldown remaining, which explains why a second scale-out has not happened yet.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Peak to watch requests per target add tasks. Apply CPU blind spot to see a policy that never scales while latency climbs. Apply Recovery to switch the metric and close the gap. Try At maximum to see a policy that is capped rather than blind.",
  },
  { type: "sim", simId: "target-tracking" },
  { type: "experiment", experimentId: "predict-blind-metric" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The policy watched CPU while the service was limited by requests per task. CPU plateaued below the 60% target, so the policy concluded that no scale-out was needed. Latency and the task shortfall rose anyway. Changing the metric to requests per target gave the same service a signal above target, and the policy added tasks until per-task load returned to the target.",
  },
  {
    type: "p",
    text: "The maximum-capacity preset showed a different limit: the metric was far above target, but the policy had already reached its task ceiling. A target tracking policy cannot exceed its maximum, and it cannot compensate for a metric that does not measure the bottleneck.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`CPUUtilization` and `MemoryUtilization` for the service in the AWS/ECS namespace, at one-minute resolution.",
      "`RequestCountPerTarget` from the load balancer in the AWS/ApplicationELB namespace, split by target group.",
      "The policy's predefined metric names, such as `ECSServiceAverageCPUUtilization` and `ALBRequestCountPerTarget`.",
      "`RunningTaskCount`, `LiveTaskCount`, desired count, and pending count for the service.",
      "Scaling activities from Application Auto Scaling, including the reason and the new desired capacity.",
      "Task startup time and health check latency, which determine how long the new capacity takes to help.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the scaling metric with per-task load and p99 at the same timestamps. If the metric is below target while latency is high, the metric is wrong for the bottleneck. If the metric is above target and the task count is not moving, check the cooldown, the maximum capacity, and whether the policy has insufficient data.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the bottleneck: CPU, request concurrency, queue depth, or a downstream dependency.",
      "Choose a metric that rises with that bottleneck and falls when capacity is added.",
      "Set the target from the latency or utilization point you want to hold, not from a default.",
      "Check the maximum capacity and raise it if the policy is capped.",
      "Tune the cooldown against the workload's burst duration and task startup time.",
      "Verify that the new tasks become healthy fast enough to help during the spike.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A low target keeps more headroom and costs more at idle.",
      "CPU is cheap and universal but blind to I/O waits and dependency latency.",
      "Requests per target tracks arrival load but assumes requests have similar cost.",
      "A custom concurrency metric can match the bottleneck more closely, at the cost of instrumenting and maintaining it.",
      "A long cooldown reduces flapping and delays the response to a sustained second spike.",
      "Scaling out is only as fast as task placement, image pull, startup, and health checks.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cpu-low-latency-high",
    question:
      "CPU is at 40% and p99 is rising, but the ECS service does not scale. What do you check, and what would you change?",
    difficulty: 2,
    hints: [
      "Target tracking scales on the metric you configure, not on latency by default.",
      "Low CPU with high latency often means the workload is waiting, not computing.",
    ],
    answer:
      "I would check which metric the scaling policy watches and whether it is above its target. If the policy watches CPU at a 60% target and CPU is 40%, the policy has no scale-out signal even though the service is queueing. I would look at per-task request rate, concurrency, queue depth, and dependency latency to find the real bottleneck, then switch the policy to a metric that rises with it, such as requests per target or a custom concurrency metric. I would also check task startup time, because a correct metric still needs capacity to become healthy before the SLO is lost.",
    followUps: [
      "When would CPU still be the right metric?",
      "How would you validate a custom metric before using it for scaling?",
      "What if the real bottleneck is a shared database?",
    ],
    redFlags: [
      "Lowers the CPU target without checking whether CPU is the bottleneck.",
      "Adds tasks manually and stops there.",
      "Ignores startup time.",
    ],
    rubric: [
      "Checks the configured metric and target.",
      "Finds the real bottleneck.",
      "Chooses a load-proportional metric.",
      "Accounts for startup lag.",
    ],
  },
  {
    id: "target-selection",
    question:
      "How do you choose the target value for an ECS target tracking policy?",
    difficulty: 3,
    hints: [
      "Start from the latency or utilization point you need to hold.",
      "The target is a steady-state operating point, not a maximum.",
    ],
    answer:
      "I would start from the service-level objective and a load test that shows where latency starts to rise sharply. The target should keep the metric below that knee with enough room for bursts and for the time it takes to add capacity. For CPU I would not automatically use 70%; I would use the utilization where p99 still meets the SLO for this workload. I would then verify the target against real traffic, because the relationship between the metric and latency changes with traffic mix, task size, and downstream latency.",
    followUps: [
      "How does request cost variation affect a requests-per-target policy?",
      "What happens if the target is set too low?",
      "How would you test the target before production?",
    ],
    redFlags: [
      "Picks a target from a generic best practice.",
      "Sets the target at 100% of capacity.",
      "Ignores burst room and startup time.",
    ],
    rubric: [
      "Starts from the SLO and the latency knee.",
      "Leaves burst headroom.",
      "Validates with a load test.",
      "Accounts for workload variability.",
    ],
  },
  {
    id: "cooldown",
    question:
      "A service scales out, then scales in, then scales out again on every traffic wave. How do cooldowns and target tracking behavior contribute?",
    difficulty: 3,
    hints: [
      "Scale-out is aggressive; scale-in is conservative.",
      "A cooldown waits after an activity, but it does not delay the first response.",
    ],
    answer:
      "The policy adds capacity quickly when the metric is above target and removes it only when the metric is far enough below target. If the traffic wave is shorter than the time to start tasks and the cooldown, the new tasks arrive after the peak and then look idle, so the policy scales them in. The next wave repeats the cycle. I would look at the wave period, task startup time, and the cooldown together, and consider a longer scale-in cooldown or stabilization rather than making scale-out slower. If the load is predictable, scheduled scaling may be better than reacting to every wave.",
    followUps: [
      "Which cooldown would you lengthen first?",
      "How does task startup time change the answer?",
      "When would you use predictive or scheduled scaling instead?",
    ],
    redFlags: [
      "Makes scale-out slower instead of stabilizing scale-in.",
      "Ignores task startup time.",
      "Treats a short traffic wave as a capacity problem.",
    ],
    rubric: [
      "Explains asymmetric scale-out and scale-in.",
      "Connects the wave period to startup and cooldown.",
      "Prefers stabilizing scale-in.",
      "Considers scheduled scaling.",
    ],
  },
  {
    id: "maxed-capacity",
    question:
      "The scaling metric is far above target, but the task count stopped growing. What are the likely causes?",
    difficulty: 2,
    hints: [
      "The policy has a maximum capacity.",
      "The cluster may not be able to place the tasks the policy requests.",
    ],
    answer:
      "The policy may have reached its maximum capacity, or the cluster may be unable to place the tasks it requests because of CPU, memory, ports, constraints, or subnet capacity. I would check the scalable target's maximum, recent scaling activities, service events, and pending task count. If the policy requested capacity but the scheduler could not place it, the fix is cluster capacity or placement, not a lower target. If the maximum is the limit, raise it deliberately and recheck the cost and downstream capacity.",
    followUps: [
      "How do you distinguish a policy cap from a placement failure?",
      "What else downstream might saturate when the service scales?",
      "How would you choose a new maximum?",
    ],
    redFlags: [
      "Lowers the target to hide the cap.",
      "Assumes the policy is broken.",
      "Ignores placement events.",
    ],
    rubric: [
      "Checks the scalable target maximum.",
      "Checks placement and pending tasks.",
      "Separates policy from capacity.",
      "Raises limits deliberately.",
    ],
  },
];

const checklist = [
  {
    title: "Before the policy",
    items: [
      "The bottleneck is identified and the scaling metric moves with it.",
      "The target is derived from a load test and the latency target.",
      "The maximum capacity is enough for the busiest expected period.",
      "Task startup and health check time are measured, not assumed.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Compare the scaling metric with per-task load and p99 at the same timestamps.",
      "Check whether the metric is above target; if not, the policy has no signal.",
      "Check the cooldown, maximum capacity, and pending task count.",
      "Check whether downstream dependencies can absorb the added capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Review scaling activities and the metric history around the event.",
      "Confirm the target still matches the observed latency knee.",
      "Adjust cooldowns only with evidence about burst duration.",
      "Record the metric choice and the bottleneck it represents.",
    ],
  },
];

const references = [
  {
    title: "Use a target metric to scale Amazon ECS services",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-autoscaling-targettracking.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Target tracking behavior, scale-out and scale-in, and ECS service auto scaling.",
  },
  {
    title: "How target tracking scaling for Application Auto Scaling works",
    url: "https://docs.aws.amazon.com/autoscaling/application/userguide/target-tracking-scaling-policy-overview.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Metric selection, target values, cooldowns, and the 300-second ECS default.",
  },
  {
    title: "Automatically scale your Amazon ECS service",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Service auto scaling mechanics, cooldowns, and behavior during deployments.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "target-tracking": {
      model: targetTrackingModel,
      presets,
      instructions:
        "Start Healthy, then apply Peak. Apply CPU blind spot to see the metric plateau while latency rises, then Recovery to switch the metric. Try At maximum to separate a policy cap from a metric problem.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The target value is normalized to a percentage of each metric's safe ceiling; ten initial tasks, forty maximum tasks, and a CPU curve that plateaus near 55% are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-services",
    "containers-step-scaling",
    "containers-scaling-cooldowns",
    "containers-fargate-cold-start",
  ],
};
