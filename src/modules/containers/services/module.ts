import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "desiredCount",
    label: "Desired count",
    min: 1,
    max: 30,
    step: 1,
    value: 10,
    unit: " tasks",
    group: "Service",
    help: "The number of tasks the service tries to keep running. It is a target, not a guarantee.",
    format: "count",
  },
  {
    id: "clusterSlots",
    label: "Placeable task slots",
    min: 0,
    max: 30,
    step: 1,
    value: 16,
    unit: " tasks",
    group: "Cluster",
    help: "How many tasks the cluster can actually host after CPU, memory, ports, and constraints. Illustrative, not an instance-type limit.",
    format: "count",
  },
  {
    id: "startupSuccess",
    label: "Tasks that pass health checks",
    min: 40,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Health",
    help: "Share of placed tasks that reach a healthy state. The rest start and are replaced, consuming capacity again.",
    format: "percent",
  },
  {
    id: "startupSeconds",
    label: "Task startup time",
    min: 0,
    max: 30,
    step: 1,
    value: 8,
    unit: " s",
    group: "Health",
    help: "Time from placement to a health decision. Longer startup makes each replacement slower and lengthens the degraded window.",
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
  desired: number;
  slots: number;
  success: number;
  startupSeconds: number;
  placeable: number;
  running: number;
  healthy: number;
  shortfall: number;
  unplaced: number;
  unhealthy: number;
  unhealthyShare: number;
  slotUtilization: number;
  retryTarget: number;
}

function compute(p: Params): Computed {
  const desired = Math.round(clamp(num(p, "desiredCount", 10), 1, 30));
  const slots = Math.round(clamp(num(p, "clusterSlots", 16), 0, 30));
  const success = clamp(num(p, "startupSuccess", 100), 40, 100);
  const startupSeconds = Math.max(0, num(p, "startupSeconds", 8));
  const placeable = Math.min(desired, slots);
  const running = placeable;
  const healthy = Math.round((running * success) / 100);
  const unhealthy = running - healthy;
  const shortfall = desired - healthy;
  return {
    desired,
    slots,
    success,
    startupSeconds,
    placeable,
    running,
    healthy,
    shortfall,
    unplaced: Math.max(0, desired - slots),
    unhealthy,
    unhealthyShare: running > 0 ? (unhealthy / running) * 100 : 0,
    slotUtilization: slots > 0 ? clamp(desired / slots) : desired > 0 ? 1 : 0,
    retryTarget: shortfall > 0 ? Math.min(120, Math.max(5, startupSeconds * 3)) : 0,
  };
}

function shortfallHealth(shortfall: number): Health {
  if (shortfall >= 3) return "crit";
  if (shortfall >= 1) return "warn";
  return "ok";
}

function retryHealth(delay: number): Health {
  if (delay >= 45) return "crit";
  if (delay >= 15) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, values: Computed, retryDelay: number): SimFrame {
  const health = shortfallHealth(values.shortfall);
  const schedulerHealth = retryHealth(retryDelay);
  const capacityHealth: Health = values.unplaced > 2 ? "crit" : values.unplaced > 0 ? "warn" : "ok";
  const unhealthyHealth: Health = values.unhealthyShare >= 30 ? "crit" : values.unhealthyShare >= 10 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.healthy / values.desired),
      sublabel: `${values.desired} desired · ${values.running} running · ${values.healthy} healthy`,
      detail: `The service keeps asking for ${values.desired} tasks. ${values.running} are running and ${values.healthy} of those pass health checks. The desired count does not change just because placement or health checks are failing.`,
      meta: { desired: values.desired, running: values.running, healthy: values.healthy },
    },
    {
      id: "scheduler",
      label: "Service scheduler",
      kind: "service",
      health: schedulerHealth,
      sublabel: values.shortfall > 0 ? `reconciling ${values.shortfall} task${values.shortfall === 1 ? "" : "s"}` : "steady state",
      detail: `The service scheduler keeps reconciling desired and running counts. ${retryDelay > 0 ? `Repeated failures have stretched the retry delay to about ${retryDelay.toFixed(0)} seconds.` : "No retry backoff is active."}`,
      meta: { retryDelay: retryDelay, shortfall: values.shortfall },
    },
    {
      id: "capacity",
      label: "Cluster task slots",
      kind: "service",
      health: capacityHealth,
      utilization: values.slotUtilization,
      capacity: values.slots,
      sublabel: `${values.slots} placeable · ${values.unplaced} cannot place`,
      detail: `The cluster can host ${values.slots} tasks after resources and constraints. ${values.unplaced > 0 ? `${values.unplaced} desired tasks have no valid placement.` : "Every desired task has a placement candidate."}`,
      meta: { slots: values.slots, unplaced: values.unplaced },
    },
    {
      id: "healthy-tasks",
      label: "Healthy tasks",
      kind: "worker",
      health: values.healthy >= values.desired ? "ok" : health,
      utilization: clamp(values.healthy / Math.max(1, values.running)),
      sublabel: `${values.healthy} passing health checks`,
      meta: { healthy: values.healthy },
    },
    {
      id: "unhealthy-tasks",
      label: "Unhealthy tasks",
      kind: "worker",
      health: unhealthyHealth,
      utilization: clamp(values.unhealthy / Math.max(1, values.running)),
      sublabel: `${values.unhealthy} being replaced`,
      meta: { unhealthy: values.unhealthy },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("service-scheduler", "service", "scheduler", 1, schedulerHealth, "desired state"),
      edge("scheduler-capacity", "scheduler", "capacity", 1, capacityHealth, "place"),
      edge("capacity-healthy", "capacity", "healthy-tasks", values.healthy / Math.max(1, values.running), health),
      edge("capacity-unhealthy", "capacity", "unhealthy-tasks", values.unhealthy / Math.max(1, values.running), unhealthyHealth),
    ],
    metrics: [
      metric("task-shortfall", "Tasks below desired count", values.shortfall, "", 1, 3, "count"),
      metric("unhealthy-share", "Placed tasks failing health checks", values.unhealthyShare, "%", 10, 30, "percent"),
      metric("retry-delay", "Scheduler retry delay", retryDelay, " s", 15, 45, "number"),
      metric("desired-count", "Desired count", values.desired, "", undefined, undefined, "count"),
      metric("running-tasks", "Running tasks", values.running, "", undefined, undefined, "count"),
      metric("healthy-tasks", "Healthy tasks", values.healthy, "", undefined, undefined, "count"),
      metric("pending-tasks", "Tasks not yet healthy", values.shortfall, "", undefined, undefined, "count"),
      metric("cluster-slots", "Placeable task slots", values.slots, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.desired} desired, ${values.running} running, ${values.healthy} healthy; retry delay ${retryDelay.toFixed(0)}s.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.2) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, Math.min(item.value, item.value + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "task-shortfall",
    metricId: "task-shortfall",
    warn: 1,
    crit: 3,
    title: "The service cannot reach its desired count",
    cause:
      "The service scheduler is trying to place more tasks than the cluster can host, or placed tasks keep failing health checks. The desired count is a target; ECS does not reduce it to match reality.",
    fix:
      "Find the limiting constraint. Add compatible capacity, relax a binding placement constraint, or fix the health check or application startup. Confirm the service event message before changing the desired count.",
    checkFirst: [
      "Check the service event message for placement or health check failures.",
      "Compare desired count, running count, and pending count in the service deployment.",
      "Check cluster CPU, memory, ports, and placement constraints for the task size.",
    ],
  },
  {
    id: "unhealthy-share",
    metricId: "unhealthy-share",
    warn: 10,
    crit: 30,
    title: "Placed tasks are failing health checks",
    cause:
      "Tasks reach the cluster but do not become healthy. A failing container health check, load balancer target health check, or a crash at startup turns the reconciliation loop into repeated replacement.",
    fix:
      "Read the task stop reason and the health check output. Fix the application, the health check timing, or the dependency it needs at startup. A longer grace period only helps when startup is genuinely slow.",
    checkFirst: [
      "Check the stopped task reason and exit code.",
      "Check the target group health and the health check grace period.",
      "Check whether the task can reach its dependencies and secrets during startup.",
    ],
  },
  {
    id: "retry-delay",
    metricId: "retry-delay",
    warn: 15,
    crit: 45,
    title: "The scheduler is backing off repeated launch attempts",
    cause:
      "When tasks stop without reaching RUNNING, the service scheduler slows later launch attempts and emits service events. This protects the cluster from a tight failure loop, but it also lengthens recovery.",
    fix:
      "Fix the launch failure rather than waiting out the backoff. Once the service is updated, the scheduler resumes normal scheduling. Check the event message for the first failure, because later retries repeat it.",
    checkFirst: [
      "Find the first service event, not the most recent retry.",
      "Check image pull, execution role, secrets, and subnet or security group errors.",
      "Check whether the task size can ever fit the available instances.",
    ],
  },
];

export const servicesModel: SimModel = {
  id: "containers-services",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values, 0);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt) => {
    const values = compute(p);
    const previous = Number(frame.flags.retryDelay ?? 0);
    const smoothing = Math.min(1, Math.max(0, dt) / 4);
    const retryDelay = previous + (values.retryTarget - previous) * smoothing;
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed, values, retryDelay);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, retryDelay };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, values]) => [key, [...values]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The service wants ${values.desired} tasks. ${values.healthy} are healthy and ${values.shortfall} are not.`,
      values.unplaced > 0
        ? `${values.unplaced} tasks have no placement candidate. The scheduler will keep retrying, but retries cannot create capacity.`
        : "Every desired task has a placement candidate, so the remaining gap is health or startup, not cluster capacity.",
      values.unhealthy > 0
        ? `${values.unhealthy} placed tasks are failing health checks. Each replacement consumes another launch attempt and can trigger scheduler backoff.`
        : "Placed tasks are passing health checks.",
      "Desired count is not a request rate. It is the number of task replicas the service will try to keep running.",
      "A service update resumes normal scheduling after throttling. Fix the failure before waiting out the backoff.",
    ];
  },
  legend: [
    { label: "Reconciled", tone: "ok" },
    { label: "Below desired", tone: "warn" },
    { label: "Cannot reconcile", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Ten desired tasks, sixteen placeable slots, and every task passes its health check.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Capacity tight",
    description: "Fourteen desired tasks against twelve placeable slots. Two tasks cannot be placed.",
    tone: "warn",
    params: defaults({ desiredCount: 14, clusterSlots: 12, startupSuccess: 100, startupSeconds: 8 }),
  },
  {
    id: "failure",
    label: "Capacity and health",
    description: "Sixteen desired tasks, ten slots, and 40% of placed tasks failing health checks.",
    tone: "crit",
    params: defaults({ desiredCount: 16, clusterSlots: 10, startupSuccess: 60, startupSeconds: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Capacity is restored and every task becomes healthy after startup.",
    tone: "ok",
    params: defaults({ desiredCount: 10, clusterSlots: 16, startupSuccess: 100, startupSeconds: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-reconcile",
  title: "Predict what the scheduler does next",
  simId: "services",
  question:
    "A service has a desired count of 10 and six placeable task slots. Six tasks are healthy. What happens next?",
  prediction: {
    options: [
      { id: "lower", label: "ECS lowers the desired count to six" },
      { id: "retry", label: "ECS keeps the desired count at ten and retries placement with backoff" },
      { id: "stop", label: "ECS stops the service and waits for a manual update" },
      { id: "burst", label: "ECS launches ten replacements at once until capacity appears" },
    ],
    correctOptionId: "retry",
    explanation:
      "The desired count is an input to reconciliation, not an output. The scheduler keeps trying to place the missing tasks, backs off after repeated failures, and reports service events. It does not rewrite the desired count to match available capacity.",
  },
  setup: defaults({ desiredCount: 10, clusterSlots: 6, startupSuccess: 100, startupSeconds: 8 }),
  runFor: 20,
  observe: [
    "Desired count stays at 10 while six tasks are healthy.",
    "The shortfall is four tasks and the retry delay climbs as placement keeps failing.",
    "No new capacity appears; retries only consume time and events.",
    "Adding four placeable slots closes the gap without changing the desired count.",
  ],
  explain:
    "A service reconciles toward the desired count. When placement is impossible, the correct state is desired 10, running 6, with a service event that names the constraint. Retrying is correct behavior, but it is not a capacity plan. An operator has to add capacity, relax a constraint, or decide that the desired count is wrong.",
  fix: defaults({ desiredCount: 10, clusterSlots: 12, startupSuccess: 100, startupSeconds: 5 }),
  debrief:
    "With twelve placeable slots the scheduler places all ten tasks and the shortfall goes to zero. The fix was capacity, not a larger desired count or a longer timeout. The tradeoff is cost: the extra slots sit idle when the service is steady. Reconciliation keeps the service honest, but it cannot make an impossible placement succeed.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Amazon Elastic Container Service (ECS) service keeps a chosen number of task replicas running. The chosen number is the desired count. The service scheduler continuously compares the desired count with the tasks that are actually running, then launches or stops tasks to close the gap.",
  },
  {
    type: "p",
    text: "Reconciliation is a loop, not a one-time command. If a task stops, the scheduler launches a replacement. If a task fails a container health check or a load balancer target health check, the scheduler starts a replacement and then stops the unhealthy task when maximumPercent leaves room; without that headroom, it stops an unhealthy task first to make room. If a replacement cannot be placed, the scheduler keeps trying, but it slows repeated launch attempts when tasks stop before reaching RUNNING.",
  },
  {
    type: "table",
    headers: ["Number", "What it means", "What it does not mean"],
    rows: [
      ["Desired count", "The replica target stored on the service", "That the cluster can host or healthy-start that many tasks"],
      ["Running count", "Tasks that reached RUNNING", "That the tasks pass health checks or receive traffic"],
      ["Pending count", "Tasks the scheduler is trying to place or start", "That placement will eventually succeed"],
      ["Healthy count", "Tasks that pass the configured checks", "That the service is at its desired count"],
    ],
  },
  {
    type: "p",
    text: "A deployment adds a second reconciliation problem: the service must replace the old task set without dropping below minimumHealthyPercent or exceeding maximumPercent. Those settings control how many old and new tasks can coexist. They do not raise the desired count permanently, and they cannot create cluster capacity.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The service sits above the scheduler and below the load balancer or service discovery layer. It stores the task definition revision, the desired count, the deployment configuration, and the health check grace period. The scheduler selects container instances or Fargate capacity, places tasks, and watches health. Stopped tasks and failed health checks feed back into the same loop.",
  },
  {
    type: "p",
    text: "The loop has three common limits: cluster capacity, placement constraints, and health. Capacity is CPU, memory, ports, and available instances. Constraints are binding rules such as a required instance attribute or one task per instance. Health is the application's ability to pass its checks. A service can be blocked by one, two, or all three at the same time, which is why the first useful signal is the service event message, not the desired count.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Desired, running, healthy, and shortfall counts moving independently.",
      "Scheduler retry delay: repeated failed launches slow the loop and stretch recovery.",
      "Placeable task slots: the capacity ceiling that retries cannot exceed.",
      "Unhealthy placed tasks: tasks that consume a slot but never become healthy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Capacity tight to see two tasks with nowhere to go. Apply Capacity and health to combine a placement ceiling with failing health checks. Watch the retry delay grow, then apply Recovery to restore capacity and healthy startup. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "services" },
  { type: "experiment", experimentId: "predict-reconcile" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The service held its desired count while the cluster could not host every task. The scheduler kept reconciling, but the gap became a retry loop: place, fail, back off, retry. When health checks also failed, placed tasks consumed capacity without becoming useful, so the shortfall was larger than the placement gap alone.",
  },
  {
    type: "p",
    text: "Restoring capacity and healthy startup closed the gap. The desired count never changed, because the service was doing its job: preserving the requested target and reporting that reality did not match it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Service events such as `was unable to place a task` or a health check failure, with the reason attached.",
      "`DescribeServices`: desiredCount, runningCount, pendingCount, deployments, and rolloutState.",
      "CloudWatch `RunningTaskCount`, `LiveTaskCount`, CPU, and memory utilization for the service.",
      "Stopped task reasons and exit codes, which separate application crashes from placement failures.",
      "Cluster capacity and placement constraints: CPU, memory, ports, instance attributes, and task size.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the first service event, not the latest retry. Compare desired, running, and pending counts. Then check whether the task can ever fit: CPU, memory, ports, constraints, subnets, and image pull. If tasks start and then stop, move to stop reasons and health checks.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the gap is placement, health, or both.",
      "Read the first failure event and the stopped task reason.",
      "Add compatible capacity or relax a binding constraint if placement is the limit.",
      "Fix the application, health check, or startup dependency if health is the limit.",
      "Watch the service until running count reaches desired and remains stable through a replacement.",
      "Revisit the desired count only after understanding the constraint; do not lower it to hide the gap.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher desired count improves burst tolerance and costs more every hour.",
      "A strict health check protects users from bad tasks but increases replacement churn during startup.",
      "A longer health check grace period reduces false failures but delays the detection of a genuinely broken task.",
      "Scheduler backoff protects the cluster from a failure loop and slows recovery after the fix.",
      "Maximum percent and minimum healthy percent trade deployment speed against capacity during a rollout.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "desired-vs-running",
    question:
      "A service reports 10 desired and 6 running tasks. Walk me through what ECS is doing and what you check first.",
    difficulty: 1,
    hints: [
      "Desired count is an input to reconciliation.",
      "There are two broad reasons for the gap: placement and health.",
    ],
    answer:
      "The service scheduler is reconciling: it still wants 10 tasks and is trying to launch the missing four. I would read the first service event to separate placement from health. If placement failed, I would check cluster CPU, memory, ports, constraints, subnets, and the task size. If tasks started and stopped, I would check the stop reason, health check output, and startup dependencies. I would not lower the desired count until I understood which limit was real.",
    followUps: [
      "What does a pending count add that a running count does not?",
      "How does the scheduler behave after repeated launch failures?",
      "When is lowering the desired count the right fix?",
    ],
    redFlags: [
      "Assumes ECS will eventually fix it without a constraint change.",
      "Changes desired count before reading events.",
      "Confuses running with healthy.",
    ],
    rubric: [
      "Describes reconciliation correctly.",
      "Separates placement from health.",
      "Names concrete checks.",
      "Avoids hiding the gap.",
    ],
  },
  {
    id: "replacement-loop",
    question:
      "Tasks start, fail a load balancer health check, and are replaced in a loop. What is happening, and how do you stop the loop?",
    difficulty: 2,
    hints: [
      "A task can be RUNNING and still be unhealthy.",
      "The replacement consumes capacity and repeats the same startup path.",
    ],
    answer:
      "The scheduler is replacing tasks that never become healthy targets. Each replacement starts the same image with the same configuration, so the loop will continue until the cause changes. I would check the target group health check path, port, and expected status code, then the application logs and the task's ability to reach its dependencies. I would also check the health check grace period: if startup is slower than the check allows, tasks are killed while warming up. The fix is the application or the check configuration, not a larger desired count.",
    followUps: [
      "What is the difference between a container health check and a target group health check?",
      "How can a grace period hide a real failure?",
      "What would you change to make the loop visible sooner?",
    ],
    redFlags: [
      "Raises the desired count to compensate.",
      "Disables the health check without fixing startup.",
      "Ignores the target group configuration.",
    ],
    rubric: [
      "Explains the replacement loop.",
      "Checks health check path and timing.",
      "Checks startup dependencies.",
      "Fixes the cause rather than masking it.",
    ],
  },
  {
    id: "deployment-capacity",
    question:
      "During a deployment, the service stays at its desired count but the new tasks never become healthy. How do minimumHealthyPercent and maximumPercent affect what you see?",
    difficulty: 2,
    hints: [
      "These percentages bound the old and new task sets during a rolling deployment.",
      "They do not create cluster capacity.",
    ],
    answer:
      "minimumHealthyPercent sets the lower bound on healthy tasks during the rollout, and maximumPercent sets the upper bound on total tasks in RUNNING, STOPPING, or PENDING. With maximumPercent 200 and enough cluster capacity, ECS can start a full replacement set before stopping the old tasks, so the service keeps its old capacity while the new tasks fail. With maximumPercent 100, ECS has to stop old tasks to make room, so a failing new revision can reduce capacity. In both cases the deployment can stall or fail, and the task definition or health check has to be fixed before retrying.",
    followUps: [
      "What happens if the cluster cannot host the maximumPercent headroom?",
      "How does the deployment circuit breaker change the outcome?",
      "Why is minimumHealthyPercent rounded up?",
    ],
    redFlags: [
      "Treats the percentages as capacity guarantees.",
      "Assumes old tasks are always kept.",
      "Ignores cluster capacity.",
    ],
    rubric: [
      "Defines both bounds correctly.",
      "Explains the capacity consequence.",
      "Connects to the failing revision.",
      "Names the recovery path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Desired count is derived from capacity and demand, not copied from a previous service.",
      "The task size fits the cluster with room for a replacement set during deployment.",
      "Health checks test readiness, not only process liveness.",
      "minimumHealthyPercent and maximumPercent match the capacity available during a rollout.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the first service event and the stopped task reason.",
      "Compare desired, running, pending, and healthy counts.",
      "Check placement constraints and cluster capacity before changing the service.",
      "Check whether repeated failures have triggered scheduler backoff.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Confirm the service holds desired count through a replacement.",
      "Record the limiting constraint and the fix.",
      "Adjust health check timing only with evidence from startup timings.",
      "Add the failure mode to the service runbook.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS services",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Service scheduler, task replacement, unhealthy task handling, and throttle logic.",
  },
  {
    title: "Amazon ECS service definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "desiredCount, minimumHealthyPercent, maximumPercent, and task placement parameters.",
  },
  {
    title: "Amazon ECS service utilization metrics",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_utilization.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "RunningTaskCount and LiveTaskCount, and how service utilization is calculated.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    services: {
      model: servicesModel,
      presets,
      instructions:
        "Start Healthy, then apply Capacity tight and Capacity and health. Watch desired count stay fixed while the shortfall and retry delay grow. Apply Recovery to restore capacity, then run the experiment.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Task slots, startup time, and retry delay are teaching values, not ECS limits or guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-task-definitions",
    "containers-placement",
    "containers-target-tracking",
    "containers-draining",
  ],
};
