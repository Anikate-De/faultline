import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DESIRED = 10;
const RESTARTS = 3;

const params: ParamSpec[] = [
  {
    id: "startupSeconds",
    label: "Application startup",
    min: 0,
    max: 180,
    step: 5,
    value: 20,
    unit: "s",
    group: "Warm-up",
    help: "How long the application needs before it can pass both the container and target group checks. This is the warm-up the checks have to tolerate.",
    format: "count",
  },
  {
    id: "gracePeriod",
    label: "Service health check grace period",
    min: 0,
    max: 180,
    step: 5,
    value: 60,
    unit: "s",
    group: "Warm-up",
    help: "healthCheckGracePeriodSeconds. The service scheduler ignores load balancer and container health checks for this long after a task starts.",
    format: "count",
  },
  {
    id: "healthCheckInterval",
    label: "Container check interval",
    min: 5,
    max: 60,
    step: 5,
    value: 15,
    unit: "s",
    group: "Detection",
    help: "How often the container health check runs. Interval multiplied by retries sets how long a failed check can run before the task is marked unhealthy.",
    format: "count",
  },
  {
    id: "healthCheckRetries",
    label: "Container check retries",
    min: 1,
    max: 10,
    step: 1,
    value: 3,
    unit: "",
    group: "Detection",
    help: "Consecutive failed checks before the container is unhealthy. Fewer retries detect faster and react to a slow start sooner.",
    format: "count",
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
  startup: number;
  grace: number;
  interval: number;
  retries: number;
  detection: number;
  restarts: number;
  trafficLoss: number;
  coverage: number;
  detectionTime: number;
  readyTasks: number;
}

function compute(p: Params): Computed {
  const startup = Math.round(clamp(num(p, "startupSeconds", 20), 0, 180));
  const grace = Math.round(clamp(num(p, "gracePeriod", 60), 0, 180));
  const interval = Math.round(clamp(num(p, "healthCheckInterval", 30), 5, 60));
  const retries = Math.round(clamp(num(p, "healthCheckRetries", 3), 1, 10));
  const detection = interval * retries;
  const restartBeforeReady = startup > grace + detection;
  const restarts = restartBeforeReady ? RESTARTS : 0;
  const trafficLoss = startup > grace && startup > 0 ? ((startup - grace) / startup) * 100 : 0;
  const coverage = startup > 0 ? Math.min(100, ((grace + detection) / startup) * 100) : 100;
  const detectionTime = detection;
  const readyTasks = restarts > 0 ? DESIRED - RESTARTS : DESIRED;
  return {
    startup,
    grace,
    interval,
    retries,
    detection,
    restarts,
    trafficLoss,
    coverage,
    detectionTime,
    readyTasks,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const albHealth: Health =
    values.trafficLoss >= 25 ? "crit" : values.trafficLoss > 0 ? "warn" : "ok";
  const schedulerHealth: Health = values.restarts > 0 ? "crit" : "ok";
  const warmingHealth: Health =
    values.restarts > 0 ? "crit" : values.trafficLoss > 0 ? "warn" : "ok";
  const checkHealth: Health =
    values.restarts > 0 || values.detectionTime >= 120
      ? "crit"
      : values.detectionTime >= 60
        ? "warn"
        : "ok";
  const nodes: SimNode[] = [
    {
      id: "alb",
      label: "checkout-alb",
      kind: "lb",
      health: albHealth,
      sublabel: `${values.trafficLoss.toFixed(0)}% of warm-up out of rotation`,
      detail:
        values.trafficLoss > 0
          ? "The target group check fails while the task is warming, so the load balancer keeps it out of rotation. The task may still be alive and starting."
          : "The target group check and the warm-up window agree. The task enters rotation only after it can answer the check.",
      meta: { trafficLoss: values.trafficLoss },
    },
    {
      id: "warming",
      label: "new task (warming)",
      kind: "service",
      role: "instance",
      health: warmingHealth,
      utilization: clamp(values.coverage / 100),
      sublabel: `${values.coverage.toFixed(0)}% of warm-up covered`,
      detail: `The task needs ${values.startup}s to become ready. The service ignores checks for ${values.grace}s, then the container check needs ${values.detection}s to mark it unhealthy. That covers ${values.coverage.toFixed(0)}% of the warm-up.`,
      meta: { startup: values.startup, grace: values.grace, detection: values.detection },
    },
    {
      id: "serving",
      label: "task serving",
      kind: "service",
      role: "instance",
      health: "ok",
      utilization: 0.2,
      sublabel: "ready",
      detail: "A task that has passed both checks is in rotation. The replacement and the old task can serve together during a rolling deployment.",
    },
    {
      id: "scheduler",
      label: "ECS service scheduler",
      kind: "service",
      health: schedulerHealth,
      sublabel: values.restarts > 0 ? `${values.restarts} premature restarts` : "no restarts",
      detail:
        values.restarts > 0
          ? "The task is marked unhealthy before it finishes warming, so the scheduler stops it and starts another. The replacement repeats the same race unless the grace period or startup changes."
          : "The task has enough time to become healthy before the scheduler acts on a failed check.",
      meta: { restarts: values.restarts, readyTasks: values.readyTasks },
    },
    {
      id: "check",
      label: "container health check",
      kind: "service",
      health: checkHealth,
      sublabel: `${values.detection}s to detect`,
      detail: `The container check runs every ${values.interval}s and marks the container unhealthy after ${values.retries} consecutive failures. The detection time also sets how long a genuinely dead task can keep serving traffic.`,
      meta: { interval: values.interval, retries: values.retries },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("alb-warming", "alb", "warming", values.trafficLoss > 0 ? 0.2 : 1, albHealth, "not ready"),
      edge("alb-serving", "alb", "serving", 0.8, "ok", "serves"),
      edge("scheduler-warming", "scheduler", "warming", 1, schedulerHealth, "replaces"),
      edge("check-scheduler", "check", "scheduler", values.restarts > 0 ? 1 : 0.3, checkHealth, "UNHEALTHY"),
    ],
    metrics: [
      metric("premature-restarts", "Premature restarts", values.restarts, "", 1, 1, "count"),
      metric("traffic-loss", "Warm-up time out of rotation", values.trafficLoss, "%", 1, 25, "percent"),
      metric("detection-time", "Time to detect a dead task", values.detectionTime, "s", 60, 120, "count"),
      metric("warmup-coverage", "Warm-up covered by checks", values.coverage, "%", undefined, undefined, "percent"),
      metric("ready-tasks", "Tasks ready", values.readyTasks, "", undefined, undefined, "count"),
      metric("startup-time", "Application startup", values.startup, "s", undefined, undefined, "count"),
      metric("grace-period", "Service grace period", values.grace, "s", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `The warm-up is ${values.startup}s and the checks cover ${values.coverage.toFixed(0)}% of it. ${values.restarts} premature restarts, ${values.trafficLoss.toFixed(0)}% of warm-up out of rotation, ${values.detectionTime}s to detect a dead task.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.4) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, Math.min(item.value, item.value + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "premature-restarts",
    metricId: "premature-restarts",
    warn: 1,
    crit: 1,
    title: "A warming task is being restarted",
    cause:
      "The service grace period plus the container check detection time is shorter than the application startup. The task is marked unhealthy while it is still booting, and the scheduler replaces it with another task that repeats the same race.",
    fix:
      "Raise healthCheckGracePeriodSeconds above the real startup time with margin, or shorten startup. Keep the container check start period and retries aligned with the same budget. Verify with a new task that it reaches healthy before the first failed check can trigger replacement.",
    checkFirst: [
      "Compare the service grace period with the application startup time.",
      "Check the container health check interval, retries, and start period.",
      "Read service events for repeated task stops shortly after start.",
    ],
  },
  {
    id: "traffic-loss",
    metricId: "traffic-loss",
    warn: 1,
    crit: 25,
    title: "A ready task is kept out of rotation",
    cause:
      "The target group health check runs before the application can answer it, and the grace period ends before the task is ready. The task is alive, but the load balancer removes it from rotation, so capacity is lower than the task count suggests.",
    fix:
      "Set the service grace period to cover the warm-up, or make the target group check tolerant of the startup window. Confirm the check path and port return success as soon as the application is ready, and watch the healthy host count during a deployment.",
    checkFirst: [
      "Compare the target group health check settings with the application startup time.",
      "Check whether the task is running while the target is unhealthy.",
      "Read the target health reason code for a connection failure or a response mismatch.",
    ],
  },
  {
    id: "detection-time",
    metricId: "detection-time",
    warn: 60,
    crit: 120,
    title: "A dead task keeps serving traffic too long",
    cause:
      "The container health check interval multiplied by the retry count is the detection window. A long interval or many retries makes the check tolerant of transient failures, but it also lets a genuinely dead task stay in rotation.",
    fix:
      "Shorten the interval or retries until the detection time fits the request timeout and error budget. Keep enough tolerance for transient failures, and use the target group check as an independent signal for traffic removal.",
    checkFirst: [
      "Multiply the health check interval by the retry count.",
      "Compare the detection time with the load balancer timeout and the error budget.",
      "Check whether a failing task was still receiving traffic before it was replaced.",
    ],
  },
];

export const healthChecksModel: SimModel = {
  id: "containers-health-checks",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed);
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The task needs ${values.startup}s to warm up. The grace period plus the detection window covers ${values.coverage.toFixed(0)}% of that time.`,
      values.restarts > 0
        ? `The task is marked unhealthy before it can become ready, so the scheduler replaces it and the replacement repeats the same race. The fix is a longer grace period or a shorter startup, not more capacity.`
        : "The task has enough time to reach healthy before the scheduler acts. The remaining risk is how long a dead task stays in rotation.",
      values.trafficLoss > 0
        ? `The target group check removes the task from rotation for the first ${values.trafficLoss.toFixed(0)}% of its warm-up. The task is alive but not ready, which is exactly what a readiness check should express.`
        : "The target group check and the service grace period agree. A task that is not ready is not sent traffic.",
      "In ECS, a failing container check and a failing target group check can both cause task replacement. The difference is which check removes traffic first; the container check does not control routing.",
      `Detection is ${values.interval}s times ${values.retries} retries, or ${values.detectionTime}s. A faster check catches a dead task sooner and is less tolerant of a slow start.`,
    ];
  },
  legend: [
    { label: "Checks agree", tone: "ok" },
    { label: "Warm-up exposed", tone: "warn" },
    { label: "Restart loop", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 20-second startup fits inside a 60-second grace period and a 45-second detection window.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Slow warm-up",
    description: "A 75-second startup outlasts the 60-second grace period. The task is alive but removed from traffic until it is ready.",
    tone: "warn",
    params: defaults({ startupSeconds: 75, gracePeriod: 60, healthCheckInterval: 30, healthCheckRetries: 3 }),
  },
  {
    id: "failure",
    label: "Restart loop",
    description: "A 90-second startup meets a 10-second grace period and a 60-second detection window. The task is replaced before it can become ready.",
    tone: "crit",
    params: defaults({ startupSeconds: 90, gracePeriod: 10, healthCheckInterval: 30, healthCheckRetries: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The grace period covers the warm-up, so the task reaches healthy without a premature restart.",
    tone: "ok",
    params: defaults({ startupSeconds: 20, gracePeriod: 120, healthCheckInterval: 15, healthCheckRetries: 3 }),
  },
  {
    id: "slow-detection",
    label: "Slow detection",
    description: "A 60-second interval with three retries takes 180 seconds to detect a dead task, so it keeps serving traffic.",
    tone: "crit",
    params: defaults({ startupSeconds: 20, gracePeriod: 60, healthCheckInterval: 60, healthCheckRetries: 3 }),
  },
];

const experiment: Experiment = {
  id: "warmup-restart-loop",
  title: "The warm-up that never finishes",
  simId: "health-checks",
  question:
    "A new task needs 90 seconds to start. The service grace period is 10 seconds, the container check runs every 30 seconds, and it marks the container unhealthy after 2 failures. What happens?",
  prediction: {
    options: [
      { id: "wait", label: "The task is left alone until it becomes ready" },
      { id: "restart", label: "The task is marked unhealthy and replaced before it finishes warming" },
      { id: "traffic", label: "Only the target group removes it from traffic; the task keeps running" },
      { id: "ignore", label: "The health check is ignored for the full 90-second startup" },
    ],
    correctOptionId: "restart",
    explanation:
      "The service ignores checks for 10 seconds. After that, the container check needs 30 seconds times 2 retries, or 60 seconds, to mark the container unhealthy. The task reaches 70 seconds and is replaced before it can finish the 90-second warm-up. The replacement repeats the same race.",
  },
  setup: defaults({ startupSeconds: 90, gracePeriod: 10, healthCheckInterval: 30, healthCheckRetries: 2 }),
  runFor: 20,
  observe: [
    "The grace period plus detection covers 78% of the warm-up.",
    "Three premature restarts occur before a replacement can become ready.",
    "The task is out of rotation for about 89% of its warm-up.",
    "The task is alive for most of the warm-up but is removed from rotation and then stopped.",
  ],
  explain:
    "The check is not wrong; the timing is. The service-level grace period is the scheduler's promise to ignore health checks while a task starts. After that promise expires, the container check retries count, and the task is marked unhealthy before it can pass. A replacement cannot fix a budget that is shorter than the startup, because every new task starts the same clock. The fix is to make the budget longer than the warm-up or the warm-up shorter than the budget.",
  fix: defaults({ startupSeconds: 20, gracePeriod: 120, healthCheckInterval: 15, healthCheckRetries: 3 }),
  debrief:
    "With a grace period that covers the warm-up, the task reaches healthy before the first failed check can trigger replacement. The tradeoff is detection: a long grace period also hides a genuinely broken task for longer. Set the budget from measured startup and keep the container check aggressive enough to detect a real failure after the warm-up, rather than using one value for both jobs.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Elastic Container Service (ECS) has two health signals that are easy to conflate. A container health check is a command in the task definition that runs inside the container and reports HEALTHY, UNHEALTHY, or UNKNOWN. For a task in a service, an essential container that becomes unhealthy causes the scheduler to stop and replace the task. A target group health check is an HTTP or TCP check from the load balancer. It decides whether the target receives traffic; an unhealthy target is removed from rotation, and ECS also treats a failing load balancer health check as an unhealthy task and replaces it.",
  },
  {
    type: "p",
    text: "Kubernetes names these ideas liveness and readiness. ECS does not use those names, but the split is still useful: the container check is the liveness-like signal that can restart the task, and the target group check is the readiness-like signal that removes traffic. In ECS both can lead to replacement, so the question is not only which check fails but which one should act first.",
  },
  {
    type: "table",
    headers: ["Check or control", "Where it runs", "Question it answers", "Action when it fails"],
    rows: [
      ["Container health check", "Inside the container", "Can the process serve?", "Task marked unhealthy and replaced"],
      ["Target group health check", "Load balancer to task", "Can the network path serve?", "Target removed from rotation; task also replaced"],
      ["healthCheckGracePeriodSeconds", "Service scheduler", "How long should checks be ignored after start?", "Delays replacement during warm-up"],
      ["Container start period", "Container check", "How long is bootstrap exempt from retries?", "Failures do not count until it ends"],
      ["Deregistration delay", "Target group", "How long should a stopping task drain?", "Protects in-flight requests"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The checks sit on different sides of the task boundary. The container check runs inside the task and asks the application. The target group check runs from the load balancer and asks the network path, including the security group and port. The service scheduler watches both signals and the grace period delays its reaction after a task starts. A task can be alive and failing the target group check because it is not ready, or ready and failing the container check because an internal dependency is broken.",
  },
  {
    type: "p",
    text: "The warm-up budget is the important number. The service grace period and the container check start period both provide warm-up time, but they apply at different layers. The grace period also covers the load balancer check; the container start period only affects the container check. If the budget is shorter than the real startup, the task is marked unhealthy before it can become ready, and the replacement repeats the same race.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Premature restarts when the warm-up outlasts the grace period and detection window.",
      "Warm-up time while a running task is out of rotation because it is not ready.",
      "Detection time from the check interval and retry count.",
      "Warm-up coverage, comparing the budget with the real startup.",
      "The scheduler, container check, target group, warming task, and serving task as separate nodes.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Slow warm-up to see a task removed from traffic without a restart. Apply Restart loop to shorten the budget below the startup, then Recovery to cover the warm-up. Apply Slow detection to see the opposite risk. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "health-checks" },
  { type: "experiment", experimentId: "warmup-restart-loop" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The task was not failing the check because the application was broken. It was failing because the check ran before the application could answer it. The service grace period expired at 10 seconds, the container check needed 60 more seconds to mark the container unhealthy, and the task needed 90 seconds to start. The scheduler replaced a task that was still warming, and the replacement repeated the same race.",
  },
  {
    type: "p",
    text: "Lengthening the grace period moved the first possible failure past the warm-up. The task reached healthy and entered rotation. The tradeoff moved to detection: a long grace period also delays the reaction to a task that is genuinely broken at startup.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Service events: repeated task stops shortly after start, without an application crash.",
      "Task health: UNHEALTHY or UNKNOWN during the warm-up window.",
      "Target health: initial or unhealthy while the task is still running.",
      "Container logs: the application is still starting when the stop signal arrives.",
      "The health check grace period, interval, retries, and start period in the service and task definition.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the real startup time with the grace period plus the container check detection window. If the budget is shorter, fix the budget before changing the application or adding tasks. Then check the target group check path and port separately.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the application startup time through the first successful check.",
      "Raise the service grace period above that time with margin.",
      "Align the container check start period and retries with the same budget.",
      "Confirm the target group check path succeeds as soon as the application is ready.",
      "Watch the healthy host count and restart count through a new deployment.",
      "Tighten detection after the warm-up so a dead task does not serve for too long.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long grace period prevents restart loops during a slow start and hides a broken task for longer.",
      "A short check interval detects a dead task faster and adds check load and false positives.",
      "Many retries tolerate transient failures and extend how long a dead task stays in rotation.",
      "A container check that calls dependencies is a better readiness signal and can fail when a dependency is slow.",
      "A target group check tests the network path and can fail for reasons the container check never sees.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "two-checks",
    question:
      "A task is running and the container health check is healthy, but the target group says it is unhealthy and it receives no traffic. Which check do you fix?",
    difficulty: 2,
    hints: [
      "The container check runs inside the task.",
      "The target group check runs from the load balancer over the network.",
    ],
    answer:
      "I would fix the target group path, not the container check. The container check is passing, so the process can serve inside the task. The target group check is failing over the network, which points to the registered port, the security group, the health check path, or the target group settings. I would read the target health reason code, compare the target group port with the container port, and confirm the load balancer can reach the task on that port. A passing container check does not prove the network path works.",
    followUps: [
      "What reason code would a security group problem produce?",
      "What if the target group check path is wrong but the port is right?",
      "Why can a task be healthy and still not ready?",
    ],
    redFlags: [
      "Restarts the task because the target is unhealthy.",
      "Changes the container check command.",
      "Ignores the target health reason code.",
    ],
    rubric: [
      "Separates internal health from network readiness.",
      "Checks port and security group.",
      "Uses the target health reason code.",
      "Avoids unnecessary restarts.",
    ],
  },
  {
    id: "grace-budget",
    question:
      "A service takes 90 seconds to start. What would you set for the health check grace period, and what else has to agree with it?",
    difficulty: 3,
    hints: [
      "The grace period delays the scheduler's reaction to both checks.",
      "The container check has its own start period and retry window.",
    ],
    answer:
      "I would set the service grace period above 90 seconds with margin, then check the container check start period and retries so the first failed check cannot mark the task unhealthy during the same window. I would also confirm the target group check is not removing the task from rotation before it is ready. The exact value should come from measured startup, not a guess. After the warm-up, I would keep detection tight enough to remove a dead task within the error budget.",
    followUps: [
      "How does the container start period differ from the service grace period?",
      "What happens if the grace period is longer than the startup?",
      "How would you measure startup time?",
    ],
    redFlags: [
      "Sets a round number without measuring.",
      "Only changes the container check.",
      "Makes the grace period so long that real failures hide.",
    ],
    rubric: [
      "Sizes from measured startup.",
      "Aligns grace, start period, and retries.",
      "Checks the target group path.",
      "Keeps detection after warm-up.",
    ],
  },
  {
    id: "restart-vs-traffic",
    question:
      "Why does a failing target group health check also cause ECS to replace the task, and how does that change your debugging?",
    difficulty: 3,
    hints: [
      "ECS treats the load balancer health status as one source of task health.",
      "The target group can fail for a network reason the container cannot see.",
    ],
    answer:
      "ECS considers the load balancer health status when it decides whether a task is healthy, so a failing target group check can mark the task unhealthy and cause replacement, not just traffic removal. That means a network problem such as a wrong port or a closed security group can look like an application restart loop. I would read the target health reason code before changing the application, confirm the task can answer the check on the registered port, and check whether the task is being replaced or only removed from rotation. The distinction tells me whether I am fixing routing or fixing the process.",
    followUps: [
      "Which check removes traffic first?",
      "How would you tell a restart loop from a target removal?",
      "What does healthCheckGracePeriodSeconds cover?",
    ],
    redFlags: [
      "Assumes the target group only affects routing.",
      "Changes application code for a network failure.",
      "Ignores the task replacement events.",
    ],
    rubric: [
      "Knows ECS uses both health sources.",
      "Separates routing from replacement.",
      "Uses target reason codes.",
      "Checks the grace period.",
    ],
  },
];

const checklist = [
  {
    title: "Before the service ships",
    items: [
      "Measure the application startup time through the first successful check.",
      "Set healthCheckGracePeriodSeconds above the startup with margin.",
      "Align the container check start period, interval, and retries with the same budget.",
      "Confirm the target group check path and port work once the app is ready.",
      "Decide the detection budget from the request timeout and error budget.",
    ],
  },
  {
    title: "During a deployment",
    items: [
      "Watch premature restarts and target health separately.",
      "Read the target health reason code before restarting a task.",
      "Confirm a new task reaches healthy before the grace period ends.",
      "Check that the healthy host count follows the ready task count.",
    ],
  },
  {
    title: "After an incident",
    items: [
      "Record the startup time, grace period, and detection window.",
      "Fix the check that removed traffic before changing the application.",
      "Tighten detection after the warm-up without recreating the race.",
      "Add the warm-up timing to the deployment checklist.",
    ],
  },
];

const references = [
  {
    title: "Determine Amazon ECS task health using container health checks",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/healthcheck.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Container health check parameters, task health, and replacement behavior.",
  },
  {
    title: "Health checks for Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Target group health check settings, target states, and reason codes.",
  },
  {
    title: "UpdateService",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateService.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "healthCheckGracePeriodSeconds and its effect on service health checks.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "health-checks": {
      model: healthChecksModel,
      presets,
      instructions:
        "Start Healthy, then apply Slow warm-up. Apply Restart loop to shorten the budget below the startup, then Recovery. Apply Slow detection to see the opposite risk. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Ten desired tasks, three restarts, and the 0–180 second slider range are teaching values, not service limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-health-checks",
    "containers-draining",
    "containers-alb-target-registration",
    "containers-rolling-deployments",
  ],
};
