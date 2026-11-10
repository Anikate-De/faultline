import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TASK_CAPACITY = 300;
const STARTUP_SECONDS = 20;
const DRAIN_SECONDS = 30;

const params: ParamSpec[] = [
  {
    id: "desiredTasks",
    label: "Desired tasks",
    min: 4,
    max: 40,
    step: 1,
    value: 12,
    unit: " tasks",
    group: "Service",
    help: "The service's desired count. Each task is modeled at 300 rps of safe serving capacity.",
    format: "count",
  },
  {
    id: "requestRate",
    label: "Request rate",
    min: 500,
    max: 12_000,
    step: 100,
    value: 2_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second the load balancer must serve during the deployment.",
    format: "rps",
  },
  {
    id: "minHealthyPercent",
    label: "Minimum healthy",
    min: 25,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rollout",
    help: "Lower limit on healthy tasks during the rollout, as a share of desired count. ECS rounds this up.",
    format: "percent",
  },
  {
    id: "maxPercent",
    label: "Maximum percent",
    min: 100,
    max: 200,
    step: 5,
    value: 150,
    unit: "%",
    group: "Rollout",
    help: "Upper limit on tasks during the rollout, as a share of desired count. ECS rounds this down; values above 100 create surge capacity.",
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

interface Values {
  desired: number;
  requestRate: number;
  minHealthy: number;
  maxPercent: number;
  floorCount: number;
  maxCount: number;
  surge: number;
  batch: number;
  stalled: boolean;
  deploying: boolean;
  progress: number;
  availableCount: number;
  availableCapacity: number;
  floorCapacity: number;
  desiredCapacity: number;
  shortfall: number;
  errorRate: number;
  p99: number;
  draining: number;
}

function compute(p: Params, elapsed: number): Values {
  const desired = Math.round(clamp(num(p, "desiredTasks", 12), 4, 40));
  const requestRate = Math.max(1, num(p, "requestRate", 2_000));
  const minHealthy = clamp(num(p, "minHealthyPercent", 100), 25, 100);
  const maxPercent = clamp(num(p, "maxPercent", 150), 100, 200);
  const floorCount = Math.max(1, Math.ceil((desired * minHealthy) / 100));
  const maxCount = Math.max(floorCount, Math.floor((desired * maxPercent) / 100));
  const surge = Math.max(0, maxCount - desired);
  const stalled = maxCount <= desired && floorCount >= desired;
  const batch = stalled ? 0 : surge > 0 ? surge : Math.max(1, desired - floorCount);
  const duration = stalled ? 0 : Math.ceil(desired / batch) * (STARTUP_SECONDS + DRAIN_SECONDS);
  const deploying = !stalled && elapsed < duration;
  const availableCount = stalled ? desired : deploying ? (surge > 0 ? desired : floorCount) : desired;
  const availableCapacity = availableCount * TASK_CAPACITY;
  const shortfall = Math.max(0, requestRate - availableCapacity);
  const utilization = requestRate / Math.max(1, availableCapacity);
  const errorRate = shortfall > 0 ? Math.min(100, (shortfall / requestRate) * 100 + 1) : 0;
  const p99 = Math.min(
    5_000,
    60 + 2_000 * Math.max(0, utilization - 0.75) ** 2 + shortfall * 0.15,
  );
  const progress = stalled ? 0 : deploying ? Math.min(100, (elapsed / duration) * 100) : 100;
  return {
    desired,
    requestRate,
    minHealthy,
    maxPercent,
    floorCount,
    maxCount,
    surge,
    batch,
    stalled,
    deploying,
    progress,
    availableCount,
    availableCapacity,
    floorCapacity: floorCount * TASK_CAPACITY,
    desiredCapacity: desired * TASK_CAPACITY,
    shortfall,
    errorRate,
    p99,
    draining: deploying && surge > 0 && elapsed > STARTUP_SECONDS ? batch : 0,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function capacityHealth(shortfall: number): Health {
  if (shortfall >= 500) return "crit";
  if (shortfall > 0) return "warn";
  return "ok";
}

function errorHealth(errorRate: number): Health {
  if (errorRate >= 5) return "crit";
  if (errorRate >= 1) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const capacity = capacityHealth(values.shortfall);
  const errors = errorHealth(values.errorRate);
  const serving = worst(capacity, errors);
  const replacement: Health = values.stalled ? "crit" : serving;
  const targetUtil = values.requestRate / Math.max(1, values.desiredCapacity);
  const targetHealth: Health = targetUtil > 1 ? "crit" : targetUtil > 0.9 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "stable",
      label: "Old version serving",
      kind: "service",
      health: serving,
      utilization: clamp(values.requestRate / Math.max(1, values.availableCapacity)),
      throughput: values.requestRate,
      capacity: values.availableCapacity,
      sublabel: `${values.availableCount} available · floor ${values.floorCount}`,
      detail: `The controller may let serving capacity fall to ${Math.round(values.floorCapacity).toLocaleString()} rps, which is ${values.minHealthy}% of desired. Demand is ${Math.round(values.requestRate).toLocaleString()} rps.`,
      meta: { stage: "stable" },
    },
    {
      id: "replacement",
      label: "Replacement batch",
      kind: "worker",
      health: replacement,
      utilization: values.stalled ? 0 : clamp(values.batch / Math.max(1, values.desired)),
      capacity: values.batch * TASK_CAPACITY,
      sublabel: values.stalled ? "No task can start or stop" : `${values.batch} tasks per batch`,
      detail: values.stalled
        ? "maximumPercent and minimumHealthyPercent are both 100. There is no slot to start a replacement and no permission to stop an old task, so the deployment waits."
        : `New tasks start in batches of ${values.batch}. With surge above 100%, new tasks start before old tasks are removed. Without surge, capacity can fall to the minimum healthy floor.`,
      meta: { stage: "canary" },
    },
    {
      id: "target",
      label: "Post-rollout service",
      kind: "service",
      health: targetHealth,
      utilization: clamp(targetUtil),
      throughput: values.requestRate,
      capacity: values.desiredCapacity,
      sublabel: `${values.desired} tasks · ${Math.round(values.desiredCapacity).toLocaleString()} rps`,
      detail: `After the rollout, the service returns to ${values.desired} tasks. A healthy target does not prove the transition had enough capacity; the floor applies only while old tasks are being replaced.`,
      meta: { stage: "full" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("stable-replacement", "stable", "replacement", values.stalled ? 0 : 0.6, replacement, "replaced by"),
      edge("replacement-target", "replacement", "target", clamp(targetUtil), targetHealth, "target capacity"),
    ],
    metrics: [
      metric("capacity-shortfall", "Capacity shortfall", values.shortfall, " rps", 1, 500, "rps"),
      metric("service-error-rate", "Service error rate", values.errorRate, "%", 1, 5, "percent"),
      metric("rollout-stall", "Rollout stalled", values.stalled ? 1 : 0, "", 0.5, 1, "count"),
      metric("available-capacity", "Available capacity", values.availableCapacity, " rps", undefined, undefined, "rps"),
      metric("capacity-floor", "Minimum healthy floor", values.floorCapacity, " rps", undefined, undefined, "rps"),
      metric("draining-tasks", "Tasks draining", values.draining, " tasks", undefined, undefined, "count"),
      metric("rollout-progress", "Rollout progress", values.progress, "%", undefined, undefined, "percent"),
      metric("p99-latency", "Request p99", values.p99, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.desired} desired · floor ${values.floorCount} tasks (${Math.round(values.floorCapacity).toLocaleString()} rps) · available ${Math.round(values.availableCapacity).toLocaleString()} rps · demand ${Math.round(values.requestRate).toLocaleString()} rps · errors ${values.errorRate.toFixed(1)}%.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = base(item.value) * 0.02 * Math.sin((index + (seed % 6)) / 3.1);
      return Math.max(0, item.value + wave);
    });
  }
}

function base(value: number): number {
  return value === 0 ? 1 : value;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "capacity-shortfall",
    metricId: "capacity-shortfall",
    warn: 1,
    crit: 500,
    title: "Serving capacity is below the request rate during the rollout",
    cause:
      "The minimum healthy floor is below what demand requires, and the rollout has no surge to start replacements before old tasks are removed. The load balancer has too few healthy targets, so requests fail or queue.",
    fix:
      "Raise minimumHealthyPercent, add surge with a maximumPercent above 100, add capacity, or reduce demand during the rollout. Plan the rollout against the floor, not the post-rollout desired capacity.",
    checkFirst: [
      "Compare demand with desired tasks times the minimum healthy share.",
      "Check whether maximumPercent leaves room for a replacement task.",
      "Check target group healthy host count and 5xx responses from the load balancer.",
    ],
  },
  {
    id: "service-error-rate",
    metricId: "service-error-rate",
    warn: 1,
    crit: 5,
    title: "The service is returning errors during the deployment",
    cause:
      "A capacity shortfall, failed health checks, or requests cut off during deregistration are turning the rollout into user-facing errors. A 503 from no healthy targets looks different from an application error, but both can follow a bad rollout.",
    fix:
      "Pause or roll back the deployment, restore capacity, and confirm error rates return to baseline. If the new revision is failing health checks, fix the revision rather than extending the grace period indefinitely.",
    checkFirst: [
      "Check whether errors are load balancer 503s or application responses.",
      "Check target health and the new revision's health-check failures.",
      "Check the deregistration delay and whether in-flight requests are being cut off.",
    ],
  },
  {
    id: "rollout-stall",
    metricId: "rollout-stall",
    warn: 0.5,
    crit: 1,
    title: "The deployment cannot start or stop a task",
    cause:
      "With maximumPercent at 100 and minimumHealthyPercent at 100, the scheduler has no free slot to start a replacement and is not allowed to stop an old task. The deployment waits instead of making progress.",
    fix:
      "Add surge by raising maximumPercent above 100, or lower minimumHealthyPercent enough to let one task be replaced. A deployment that cannot move is not zero downtime; it is an unfinished deployment.",
    checkFirst: [
      "Check maximumPercent and minimumHealthyPercent.",
      "Check the service event message for a deployment configuration error.",
      "Check whether cluster capacity or subnet IP space is also blocking placement.",
    ],
  },
];

export const rollingDeploymentsModel: SimModel = {
  id: "containers-rolling-deployments",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame);
    frame.flags.elapsed = 0;
    return frame;
  },
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    let elapsed = reset ? 0 : Math.max(0, Number(frame.flags.elapsed ?? 0));
    elapsed += Math.max(0, dt);
    const values = compute(p, elapsed);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, elapsed, paramsKey: key };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
    );
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const elapsed = Number(frame.flags.elapsed ?? 0);
    const values = compute(p, elapsed);
    const lines = [
      `Desired ${values.desired} tasks. The minimum healthy floor is ${values.floorCount} tasks (${Math.round(values.floorCapacity).toLocaleString()} rps); maximum percent allows ${values.maxCount} tasks.`,
    ];
    if (values.stalled) {
      lines.push(
        "The rollout is stalled: maximumPercent and minimumHealthyPercent leave no task that can be started or stopped.",
      );
    } else if (values.surge > 0) {
      lines.push(
        `Surge is ${values.surge} tasks. New tasks can start before old tasks are removed, so serving capacity stays at the desired count while they drain.`,
      );
    } else {
      lines.push(
        "There is no surge. Old tasks must stop before replacements start, so serving capacity can fall to the minimum healthy floor.",
      );
    }
    if (values.shortfall > 0) {
      lines.push(
        `Demand is ${Math.round(values.requestRate).toLocaleString()} rps, so the floor is short by ${Math.round(values.shortfall).toLocaleString()} rps. Surge changes how replacements are scheduled; it does not repair a floor below demand.`,
      );
    } else {
      lines.push(
        `Demand is ${Math.round(values.requestRate).toLocaleString()} rps, leaving ${Math.round(values.availableCapacity - values.requestRate).toLocaleString()} rps of headroom against current serving capacity.`,
      );
    }
    lines.push(
      `The model uses ${STARTUP_SECONDS}s startup and ${DRAIN_SECONDS}s drain per batch. ECS waits for the target group deregistration delay before stopping a task that has been removed from the load balancer.`,
    );
    return lines;
  },
  legend: [
    { label: "Capacity above demand", tone: "ok" },
    { label: "Floor below demand", tone: "warn" },
    { label: "Rollout stalled", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Twelve tasks, 2,000 rps, 100% minimum healthy, and 150% maximum percent with surge.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak demand",
    description: "The same rollout at 3,500 rps leaves little headroom but keeps serving capacity.",
    tone: "warn",
    params: defaults({ desiredTasks: 12, requestRate: 3_500, minHealthyPercent: 100, maxPercent: 150 }),
  },
  {
    id: "failure",
    label: "No surge, low floor",
    description: "A 25% healthy floor with maximum percent at 100 drops serving capacity to three tasks at 3,200 rps.",
    tone: "crit",
    params: defaults({ desiredTasks: 12, requestRate: 3_200, minHealthyPercent: 25, maxPercent: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Sixteen tasks with 100% minimum healthy and 150% maximum percent keep capacity above demand.",
    tone: "ok",
    params: defaults({ desiredTasks: 16, requestRate: 4_000, minHealthyPercent: 100, maxPercent: 150 }),
  },
  {
    id: "stalled",
    label: "Stalled rollout",
    description: "Minimum healthy 100% and maximum percent 100% leave no task that can be started or stopped.",
    tone: "crit",
    params: defaults({ desiredTasks: 12, requestRate: 2_000, minHealthyPercent: 100, maxPercent: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-floor",
  title: "Predict whether the rollout keeps serving",
  simId: "rolling-deployments",
  question:
    "The service runs 12 tasks at 300 rps each. A rolling deployment uses 50% minimum healthy and 100% maximum percent. Demand is 3,000 rps. Will the service keep serving through the rollout?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. The desired count is unchanged, so capacity cannot drop" },
      { id: "no", label: "No. Without surge, serving capacity can fall to six tasks, which is 1,800 rps" },
      { id: "surge", label: "Yes, because maximum percent above 100 adds surge capacity" },
      { id: "health", label: "Only if the health check grace period is longer than the rollout" },
    ],
    correctOptionId: "no",
    explanation:
      "With maximumPercent at 100 there is no surge. ECS must stop old tasks before starting replacements, and the 50% minimum healthy floor allows serving capacity to fall to 6 of 12 tasks. At 300 rps per task that is 1,800 rps against 3,000 rps of demand, so requests fail during the transition.",
  },
  setup: defaults({ desiredTasks: 12, requestRate: 3_000, minHealthyPercent: 50, maxPercent: 100 }),
  runFor: 30,
  observe: [
    "Available capacity falls to six tasks, or 1,800 rps.",
    "The capacity shortfall is 1,200 rps and the error rate rises.",
    "Raising maximum percent to 150 adds six surge tasks and keeps serving capacity at the desired count.",
    "The post-rollout fleet is healthy; the failure is confined to the transition.",
  ],
  explain:
    "The deployment configuration sets two bounds. minimumHealthyPercent is the floor the scheduler may leave you with while it replaces tasks. maximumPercent is the ceiling it may reach to start replacements first. If the ceiling is 100, there is no surge, so the floor becomes the operating capacity during replacement. Demand has to fit inside the floor, not inside the desired count.",
  fix: defaults({ desiredTasks: 12, requestRate: 3_000, minHealthyPercent: 50, maxPercent: 150 }),
  debrief:
    "With 150% maximum percent, ECS can start six surge tasks before stopping old ones, so serving capacity stays above demand. The tradeoff is temporary extra capacity and cost during the rollout. A high minimum healthy floor achieves a similar safety margin without surge, but it slows the deployment because fewer tasks can be replaced at once.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An ECS rolling deployment replaces the tasks in a service with tasks from a new task definition. The service scheduler starts new tasks, waits for them to become healthy, and stops old tasks in batches. Two percentages bound the process: minimumHealthyPercent is the lower limit on healthy tasks, and maximumPercent is the upper limit on total tasks during the deployment.",
  },
  {
    type: "p",
    text: "ECS rounds minimumHealthyPercent up and maximumPercent down. With a desired count of four and a 50% minimum, the scheduler can stop two healthy tasks before starting two replacements. With a 125% maximum and a desired count of three, the rounded-down limit is still three, so there is no surge slot. If both values are 100, the scheduler can neither start a replacement nor stop an old task, and the deployment stalls.",
  },
  {
    type: "table",
    headers: ["Setting", "Bounds", "Failure mode"],
    rows: [
      ["minimumHealthyPercent", "Healthy tasks kept during replacement", "Floor below demand, so 503s during the rollout"],
      ["maximumPercent above 100", "Surge tasks started before old tasks stop", "Extra cost and capacity during the rollout"],
      ["Both at 100", "No free slot to start or stop", "Deployment stalls instead of progressing"],
      ["Health check and drain", "When a task is actually ready or removed", "Started tasks that cannot serve, or cut-off requests"],
    ],
  },
  {
    type: "p",
    text: "The percentages are not the whole availability story. A task is not serving just because it is running. It must pass its container and load balancer health checks and be registered as a healthy target. On the other side, ECS waits for the target group deregistration delay before it stops a task that has been removed from the load balancer. A deployment can therefore be at the configured healthy count and still be losing requests if health checks are too early or draining is too short.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The ECS service deployment controller owns the rollout. It reads the deployment configuration, asks the scheduler to start and stop tasks, and tracks the rollout state. The load balancer's target group decides which tasks receive traffic. The service auto scaler sits alongside the deployment controller; Application Auto Scaling turns off scale-in while a deployment is in progress, while scale-out can continue.",
  },
  {
    type: "p",
    text: "That separation matters during an incident. A capacity shortfall can be caused by the deployment configuration, a health check that never passes, a target group that has not registered the new tasks, or a cluster that cannot place them. The deployment state and the target health tell you which of those is happening.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The minimum healthy floor and maximum task ceiling in task counts and rps.",
      "Serving capacity during the rollout, separated from post-rollout capacity.",
      "The capacity shortfall and error rate while replacements are in progress.",
      "Rollout progress and the number of tasks draining, which show whether the deployment is moving.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No surge, low floor to see serving capacity fall to the floor. Apply Recovery to keep capacity above demand. Try Stalled rollout to see a configuration that cannot start or stop a task at all.",
  },
  { type: "sim", simId: "rolling-deployments" },
  { type: "experiment", experimentId: "predict-floor" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The no-surge preset used a 25% minimum healthy floor and a 100% maximum. ECS could not start a replacement before stopping an old task, so serving capacity fell to three tasks, or 900 rps, against 3,200 rps of demand. The capacity shortfall and error rate rose together. The post-rollout fleet would have been healthy, but the transition was not.",
  },
  {
    type: "p",
    text: "The recovery preset used 16 tasks, a 100% minimum healthy floor, and a 150% maximum. Surge let new tasks start before old ones were removed, so serving capacity stayed at the desired count. The stalled preset showed the other edge: both values at 100 left no task that could be started or stopped.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ECS service events for the deployment, including the rollout state and any configuration error.",
      "The deployment's running and desired counts, plus the primary and active deployment IDs.",
      "Target group healthy and unhealthy host counts, not just task count.",
      "Application Load Balancer 5xx metrics, especially 503 responses from no healthy targets.",
      "Task health-check failures and stopped-task reasons for the new revision.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare demand with desired tasks times minimumHealthyPercent. If the floor is below demand, the rollout configuration cannot keep serving without surge. Then check target health and the service event message to separate a capacity problem from a stalled deployment.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Calculate the floor: desired tasks times minimum healthy, rounded up.",
      "Check that the floor covers peak demand, not average demand.",
      "Add surge by raising maximum percent above 100, or raise the minimum healthy floor.",
      "Fix health checks and the grace period so new tasks can become healthy.",
      "Set the deregistration delay long enough for in-flight requests to finish.",
      "Pause or roll back if error rates breach the budget while the rollout is still progressing.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Surge protects capacity and temporarily costs more.",
      "A high minimum healthy floor slows the rollout because fewer tasks can be replaced at once.",
      "A low floor is fast and risky when demand exceeds it.",
      "A long deregistration delay protects in-flight requests and slows task replacement.",
      "A short health-check grace period speeds registration and can send traffic to an unready application.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "floor-math",
    question:
      "A service runs 20 tasks behind a load balancer. The deployment uses 50% minimum healthy and 100% maximum percent. What is the worst-case serving capacity during the rollout, and what would you change?",
    difficulty: 2,
    hints: [
      "Minimum healthy is rounded up; maximum percent is rounded down.",
      "With maximum percent at 100, there is no surge.",
    ],
    answer:
      "The floor is 10 tasks, so the rollout can leave 10 healthy tasks serving while it replaces the other 10. If each task serves a known request rate, that is the capacity I would compare with peak demand. If 10 tasks cannot carry peak demand, I would add surge by raising maximum percent above 100 so replacements start before old tasks are removed, or raise the minimum healthy floor. I would also check that new tasks pass load balancer health checks and that the deregistration delay lets in-flight requests finish. The desired count after the rollout is not the number that protects availability during it.",
    followUps: [
      "How does the answer change at 150% maximum percent?",
      "What if the service is already at its maximum capacity?",
      "How would you choose the minimum healthy floor from traffic data?",
    ],
    redFlags: [
      "Uses desired count as the rollout capacity.",
      "Ignores rounding.",
      "Adds tasks without checking health checks.",
    ],
    rubric: [
      "Calculates the floor correctly.",
      "Compares the floor with demand.",
      "Uses surge or a higher floor deliberately.",
      "Accounts for health checks and draining.",
    ],
  },
  {
    id: "503-during-deploy",
    question:
      "Users see 503s only during deployments. The service has plenty of desired capacity. What do you check?",
    difficulty: 2,
    hints: [
      "The load balancer returns 503 when there are no healthy targets.",
      "A task can be running but not registered.",
    ],
    answer:
      "I would check the load balancer target health first, because a 503 from the load balancer usually means no healthy targets or a target group with no registered tasks. Then I would compare the deployment configuration's minimum healthy floor with demand, and check whether maximum percent allows surge. I would also check health-check path, port, grace period, and the deregistration delay. If new tasks are running but never healthy, the revision or health check is the problem. If old tasks are removed before replacements are ready, the deployment configuration is the problem.",
    followUps: [
      "How do you distinguish a 503 from an application 500?",
      "What does a health-check grace period change?",
      "When would you roll back instead of fixing forward?",
    ],
    redFlags: [
      "Blaming the application before checking target health.",
      "Raising desired count without checking the floor.",
      "Ignoring the deployment configuration.",
    ],
    rubric: [
      "Checks target health and registration.",
      "Calculates the floor against demand.",
      "Checks health checks and draining.",
      "Separates capacity from revision failure.",
    ],
  },
  {
    id: "stalled-rollout",
    question:
      "A deployment has been in progress for 20 minutes with no new healthy tasks. What are the possible causes, and how do you tell them apart?",
    difficulty: 3,
    hints: [
      "The deployment controller may be blocked by its own percentages.",
      "The scheduler may be unable to place tasks.",
    ],
    answer:
      "I would read the ECS service event message and the deployment's rollout state first. If maximum percent and minimum healthy are both 100, the controller cannot start or stop a task and the deployment is stuck by configuration. If the controller is trying to start tasks but none become healthy, I would check cluster capacity, subnet IP space, image pull, application startup, and health checks. If tasks are running but not registering, I would check the target group and health-check settings. A stuck deployment is not the same as a slow one; the fix depends on whether the controller is blocked or the tasks are failing.",
    followUps: [
      "What does the service event message tell you?",
      "How would you distinguish placement failure from health-check failure?",
      "What would you do if the previous deployment is still active?",
    ],
    redFlags: [
      "Waits longer without reading the deployment state.",
      "Raises the health-check grace period for a configuration stall.",
      "Assumes the new revision is bad without evidence.",
    ],
    rubric: [
      "Reads the deployment state and events.",
      "Checks the percentage configuration.",
      "Checks placement and health separately.",
      "Chooses a targeted fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the deployment",
    items: [
      "Calculate the minimum healthy floor in tasks and rps.",
      "Confirm the floor covers peak demand, not average.",
      "Confirm maximum percent leaves at least one surge slot.",
      "Measure health-check time and set the grace period above it.",
      "Set the deregistration delay for in-flight requests.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch target group healthy hosts, not only running tasks.",
      "Compare available capacity with demand.",
      "Check the service event message if progress stops.",
      "Check whether 503s are load balancer or application responses.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Confirm the new revision is healthy at full desired count.",
      "Review the rollout duration and any capacity dip.",
      "Record the floor and surge values that were used.",
      "Revisit the values when traffic or task size changes.",
    ],
  },
];

const references = [
  {
    title: "Deploy Amazon ECS services by replacing tasks",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Rolling update behavior, minimumHealthyPercent, maximumPercent, rounding, and the stalled-deployment condition.",
  },
  {
    title: "Amazon ECS deployment parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Deployment configuration parameters for ECS services.",
  },
  {
    title: "Register targets with a load balancer",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/load-balancer-deregistration.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Target registration, health checks, and the deregistration delay before a task is stopped.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rolling-deployments": {
      model: rollingDeploymentsModel,
      presets,
      instructions:
        "Start Healthy, then apply No surge, low floor to watch serving capacity fall to the floor. Apply Recovery to see surge hold capacity above demand. Try Stalled rollout to see a configuration that cannot make progress.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 300 rps per task, 20-second startup, 30-second drain, and one-batch-at-a-time progression are teaching assumptions; the deployment percentages and rounding behavior follow the ECS documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-deployment-circuit-breaker",
    "containers-services",
    "containers-fargate-cold-start",
    "deployment-rolling",
  ],
};
