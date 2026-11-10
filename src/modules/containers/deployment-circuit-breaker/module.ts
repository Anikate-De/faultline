import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DESIRED = 10;
const MIN_HEALTHY = 5;
const FAILURE_INTERVAL = 6;

const params: ParamSpec[] = [
  {
    id: "revisionHealth",
    label: "New tasks passing health checks",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Revision",
    help: "Share of tasks in the new revision that pass their health checks. Below 100% the deployment is treated as failing.",
    format: "percent",
  },
  {
    id: "failureThreshold",
    label: "Circuit breaker threshold",
    min: 1,
    max: 10,
    step: 1,
    value: 5,
    unit: " failures",
    group: "Circuit breaker",
    help: "Task failures counted before the deployment is marked failed. The model uses COUNT mode; the ECS default is a bounded percentage of desired count.",
    format: "count",
  },
  {
    id: "rollbackEnabled",
    label: "Automatic rollback",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Circuit breaker",
    help: "0 marks the deployment failed and stops launching tasks. 1 rolls back to the last deployment in the COMPLETED state.",
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

type Phase = "steady" | "deploying" | "complete" | "failed" | "rolled-back";

interface DeploymentState {
  phase: Phase;
  elapsed: number;
  failures: number;
  oldTasks: number;
  newHealthy: number;
}

function initialState(): DeploymentState {
  return { phase: "steady", elapsed: 0, failures: 0, oldTasks: DESIRED, newHealthy: 0 };
}

interface Computed {
  health: number;
  threshold: number;
  rollback: boolean;
  phase: Phase;
  elapsed: number;
  failures: number;
  oldTasks: number;
  newHealthy: number;
  healthyTasks: number;
  shortfall: number;
  failedPercent: number;
}

function compute(p: Params, state: DeploymentState): Computed {
  const health = Math.round(clamp(num(p, "revisionHealth", 100), 0, 100));
  const threshold = Math.round(clamp(num(p, "failureThreshold", 5), 1, 10));
  const rollback = num(p, "rollbackEnabled", 1) >= 0.5;
  const healthyTasks = Math.min(DESIRED, state.oldTasks + state.newHealthy);
  const active = state.phase === "deploying" || state.phase === "failed";
  const attemptedNew = DESIRED - MIN_HEALTHY;
  const failedNew = active && health < 100 ? Math.max(0, attemptedNew - state.newHealthy) : 0;
  return {
    health,
    threshold,
    rollback,
    phase: state.phase,
    elapsed: state.elapsed,
    failures: state.failures,
    oldTasks: state.oldTasks,
    newHealthy: state.newHealthy,
    healthyTasks,
    shortfall: DESIRED - healthyTasks,
    failedPercent: attemptedNew > 0 ? (failedNew / attemptedNew) * 100 : 0,
  };
}

function serviceHealth(values: Computed): Health {
  if (values.shortfall >= 3 || values.phase === "failed") return "crit";
  if (values.shortfall >= 1) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const health = serviceHealth(values);
  const stableHealth: Health =
    values.phase === "complete"
      ? "ok"
      : values.oldTasks >= DESIRED
        ? "ok"
        : values.oldTasks >= MIN_HEALTHY
          ? "warn"
          : "crit";
  const newHealth: Health =
    values.phase === "complete" || values.phase === "rolled-back"
      ? "ok"
      : values.health >= 100
        ? "ok"
        : values.health >= 80
          ? "warn"
          : "crit";
  const breakerHealth: Health =
    values.phase === "failed"
      ? "crit"
      : values.phase === "rolled-back" || values.phase === "complete"
        ? "ok"
        : values.failures > 0 || (!values.rollback && values.failedPercent > 0)
          ? "warn"
          : "ok";
  const phaseLabel =
    values.phase === "steady"
      ? "ready to deploy"
      : values.phase === "deploying"
        ? "deployment in progress"
        : values.phase === "complete"
          ? "deployment complete"
          : values.phase === "failed"
            ? "deployment failed, no rollback"
            : "rolled back";
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.healthyTasks / DESIRED),
      sublabel: `${values.healthyTasks} of ${DESIRED} healthy`,
      detail: `The service is maintaining at least ${MIN_HEALTHY} healthy tasks during the rollout. ${values.shortfall > 0 ? `${values.shortfall} tasks of capacity are missing.` : "Desired capacity is intact."}`,
      meta: { desired: DESIRED, healthy: values.healthyTasks },
    },
    {
      id: "stable",
      label: "checkout:41",
      kind: "service",
      role: "primary",
      health: stableHealth,
      utilization: clamp(values.oldTasks / DESIRED),
      sublabel: `${values.oldTasks} stable tasks`,
      detail: `The previous revision. ${values.phase === "rolled-back" ? "The rollback restored the full stable task set." : "Stable tasks are kept while the new revision proves it can pass health checks."}`,
      meta: { tasks: values.oldTasks },
    },
    {
      id: "new",
      label: "checkout:42",
      kind: "service",
      role: "replica",
      health: newHealth,
      utilization: clamp(values.newHealthy / DESIRED),
      sublabel: `${values.newHealthy} healthy new tasks`,
      detail: `The new revision. ${values.failedPercent > 0 ? `${values.failedPercent.toFixed(0)}% of the attempted batch fails health checks.` : "Its tasks are passing health checks."} ${values.phase === "rolled-back" ? "It has been abandoned by the rollback." : ""}`,
      meta: { tasks: values.newHealthy, health: values.health },
    },
    {
      id: "breaker",
      label: "Deployment circuit breaker",
      kind: "service",
      health: breakerHealth,
      sublabel: `${values.rollback ? "rollback on" : "rollback off"} · ${values.failures}/${values.threshold}`,
      detail: `${phaseLabel}. ${values.rollback ? "When the failure threshold is reached, ECS rolls back to the last COMPLETED deployment." : "When the threshold is reached, ECS marks the deployment FAILED but keeps the tasks it has."}`,
      meta: { failures: values.failures, threshold: values.threshold, rollback: values.rollback ? 1 : 0 },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("service-stable", "service", "stable", values.oldTasks / DESIRED, stableHealth, "stable"),
      edge("service-new", "service", "new", values.newHealthy / DESIRED, newHealth, "new"),
      edge("breaker-new", "breaker", "new", values.rollback ? 1 : 0.3, breakerHealth, "evaluates"),
    ],
    metrics: [
      metric("task-shortfall", "Healthy tasks below desired", values.shortfall, "", 1, 3, "count"),
      metric("failed-task-percent", "New tasks failing health checks", values.failedPercent, "%", 5, 25, "percent"),
      metric("deployment-age", "Deployment age", values.elapsed, " s", 60, 120, "number"),
      metric("failure-count", "Failures counted", values.failures, "", undefined, undefined, "count"),
      metric("healthy-tasks", "Healthy tasks", values.healthyTasks, "", undefined, undefined, "count"),
      metric("desired-count", "Desired count", DESIRED, "", undefined, undefined, "count"),
      metric("new-healthy", "Healthy tasks on new revision", values.newHealthy, "", undefined, undefined, "count"),
      metric("rollback-enabled", "Automatic rollback", values.rollback ? 1 : 0, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${phaseLabel}; ${values.healthyTasks} of ${DESIRED} healthy; ${values.failures} of ${values.threshold} failures; rollback ${values.rollback ? "on" : "off"}.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 8)) / 2.5) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, Math.min(item.value, item.value + wave));
    });
  }
}

function readState(frame: SimFrame): DeploymentState {
  const phase = String(frame.flags.phase ?? "steady") as Phase;
  return {
    phase,
    elapsed: Math.max(0, Number(frame.flags.elapsed ?? 0)),
    failures: Math.max(0, Number(frame.flags.failures ?? 0)),
    oldTasks: Math.max(0, Number(frame.flags.oldTasks ?? DESIRED)),
    newHealthy: Math.max(0, Number(frame.flags.newHealthy ?? 0)),
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "task-shortfall",
    metricId: "task-shortfall",
    warn: 1,
    crit: 3,
    title: "The deployment has removed healthy capacity",
    cause:
      "A rolling deployment can stop old tasks before the new revision proves it can pass health checks. When the new tasks fail, the service is left below its desired count, bounded by minimumHealthyPercent.",
    fix:
      "Stop the deployment or enable the circuit breaker with rollback. Restore the previous revision, then fix the health check or application startup before trying again.",
    checkFirst: [
      "Compare healthy tasks with desired count and with minimumHealthyPercent.",
      "Check the deployment rolloutState and rolloutStateReason.",
      "Check whether the new tasks fail container, load balancer, or Cloud Map health checks.",
    ],
  },
  {
    id: "failed-task-percent",
    metricId: "failed-task-percent",
    warn: 5,
    crit: 25,
    title: "The new revision is failing health checks",
    cause:
      "Tasks in the new task definition start but do not become healthy. A bad image, missing configuration, failed dependency, or a health check that starts before the application is ready will keep producing failures.",
    fix:
      "Preserve the stopped task reason and logs, roll back, and fix the revision. Do not raise the failure threshold to hide a revision that cannot become healthy.",
    checkFirst: [
      "Read the stopped task reason and exit code.",
      "Check the target group health check path, port, and grace period.",
      "Check environment, secrets, and dependencies that changed in the new revision.",
    ],
  },
  {
    id: "deployment-age",
    metricId: "deployment-age",
    warn: 60,
    crit: 120,
    title: "The deployment is taking too long to reach a steady state",
    cause:
      "A healthy rollout finishes. A deployment that keeps waiting is either starting tasks slowly or failing them repeatedly. Without a circuit breaker decision, it can hold the service in a partial state indefinitely.",
    fix:
      "Check the deployment state and task failures before waiting longer. If the revision is bad, roll back. If startup is genuinely slow, align the health check grace period with measured startup and keep the threshold above that window.",
    checkFirst: [
      "Check rolloutState and the number of healthy tasks per revision.",
      "Check whether failures are increasing or the deployment is merely slow.",
      "Check image pull time, startup time, and health check grace period.",
    ],
  },
];

export const circuitBreakerModel: SimModel = {
  id: "containers-deployment-circuit-breaker",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const state = initialState();
    const frame = buildFrame(p, seed, compute(p, state));
    seedSeries(frame);
    frame.flags.phase = state.phase;
    frame.flags.elapsed = state.elapsed;
    frame.flags.failures = state.failures;
    frame.flags.oldTasks = state.oldTasks;
    frame.flags.newHealthy = state.newHealthy;
    return frame;
  },
  step: (frame, p, dt) => {
    const health = Math.round(clamp(num(p, "revisionHealth", 100), 0, 100));
    const threshold = Math.round(clamp(num(p, "failureThreshold", 5), 1, 10));
    const rollback = num(p, "rollbackEnabled", 1) >= 0.5;
    let state = readState(frame);

    if (state.phase === "steady") {
      state = {
        phase: "deploying",
        elapsed: 0,
        failures: 0,
        oldTasks: health >= 100 ? DESIRED : MIN_HEALTHY,
        newHealthy: 0,
      };
    }

    if (state.phase === "failed" && rollback) {
      state = { ...state, phase: "rolled-back", oldTasks: DESIRED, newHealthy: 0 };
    }

    if (state.phase === "deploying") {
      state.elapsed += Math.max(0, dt);
      if (health >= 100) {
        state.newHealthy = Math.min(DESIRED, Math.floor(state.elapsed / 1.5));
        state.oldTasks = Math.max(0, DESIRED - state.newHealthy);
        if (state.newHealthy >= DESIRED) {
          state.phase = "complete";
          state.oldTasks = 0;
        }
      } else {
        state.failures = Math.min(threshold, Math.floor(state.elapsed / FAILURE_INTERVAL));
        state.newHealthy = Math.floor(((DESIRED - MIN_HEALTHY) * health) / 100);
        state.oldTasks = MIN_HEALTHY;
        if (state.failures >= threshold) {
          if (rollback) {
            state.phase = "rolled-back";
            state.oldTasks = DESIRED;
            state.newHealthy = 0;
          } else {
            state.phase = "failed";
          }
        }
      }
    } else if (state.phase === "failed") {
      state.elapsed += Math.max(0, dt);
    }

    const values = compute(p, state);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      phase: state.phase,
      elapsed: state.elapsed,
      failures: state.failures,
      oldTasks: state.oldTasks,
      newHealthy: state.newHealthy,
    };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, values]) => [key, [...values]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const state = readState(frame);
    const values = compute(p, state);
    return [
      `Deployment phase: ${values.phase}. ${values.healthyTasks} of ${DESIRED} tasks are healthy.`,
      values.rollback
        ? "Automatic rollback is enabled. The circuit breaker will mark the deployment failed at the threshold and restore the last COMPLETED deployment."
        : "Automatic rollback is disabled. The circuit breaker can mark the deployment failed, but it will not restore the previous revision.",
      `${values.failures} of ${values.threshold} counted failures. This model uses a fixed count; ECS also supports a bounded or unbounded percentage of the desired count.`,
      values.health < 100
        ? `The new revision has ${values.failedPercent.toFixed(0)}% of the attempted batch failing health checks. Repeated failures are a revision problem, so waiting without a fix is not a recovery plan.`
        : "The new revision is passing health checks and the rollout is replacing stable tasks.",
      "A rollback needs a previous deployment in the COMPLETED state. If none exists, the deployment stalls instead of rolling back.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Deployment in progress", tone: "warn" },
    { label: "Failed or rolled back", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A good revision replaces ten stable tasks without losing capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial failures",
    description: "Ninety-five percent of new tasks pass, but the five-task batch still loses one task.",
    tone: "warn",
    params: defaults({ revisionHealth: 95, failureThreshold: 10, rollbackEnabled: 1 }),
  },
  {
    id: "failure",
    label: "No rollback",
    description: "A bad revision fails every health check and rollback is disabled. Capacity stays at half.",
    tone: "crit",
    params: defaults({ revisionHealth: 0, failureThreshold: 5, rollbackEnabled: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The same bad revision, now with rollback enabled. ECS restores the stable revision.",
    tone: "ok",
    params: defaults({ revisionHealth: 0, failureThreshold: 5, rollbackEnabled: 1 }),
  },
  {
    id: "slow-rollback",
    label: "High threshold",
    description: "A threshold of ten delays the rollback and keeps the service at half capacity for longer.",
    tone: "warn",
    params: defaults({ revisionHealth: 0, failureThreshold: 10, rollbackEnabled: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-circuit-breaker",
  title: "Predict what the circuit breaker does",
  simId: "deployment-circuit-breaker",
  question:
    "A new revision fails every health check. The circuit breaker is enabled with rollback off and a threshold of five. What happens after five task failures?",
  prediction: {
    options: [
      { id: "rollback", label: "ECS rolls back to the previous revision automatically" },
      { id: "failed", label: "ECS marks the deployment FAILED, stops launching tasks, and keeps the current tasks" },
      { id: "retry", label: "ECS resets the failure count and keeps trying the same revision" },
      { id: "scale", label: "ECS scales the service up until a task passes" },
    ],
    correctOptionId: "failed",
    explanation:
      "The circuit breaker detects repeated task failures, but rollback is a separate option. With rollback off, ECS marks the deployment failed and stops launching new tasks. The stable tasks remain, bounded by the service's minimum healthy percentage, so capacity can stay below desired.",
  },
  setup: defaults({ revisionHealth: 0, failureThreshold: 5, rollbackEnabled: 0 }),
  runFor: 30,
  observe: [
    "Five of ten tasks remain healthy, so the service is at half capacity.",
    "Every new task fails its health check and the failure count reaches the threshold.",
    "The deployment is FAILED and stops launching tasks; it does not retry the bad revision forever.",
    "Enabling rollback restores the previous revision and the full task set.",
  ],
  explain:
    "The circuit breaker answers one question: has this deployment failed enough times to stop? Rollback answers a second: should ECS restore the previous deployment? They are configured together but they are not the same action. A failed deployment without rollback is a stopped rollout, not a recovery.",
  fix: defaults({ revisionHealth: 0, failureThreshold: 5, rollbackEnabled: 1 }),
  debrief:
    "With rollback on, the fifth counted failure marks the deployment failed and ECS restores the last COMPLETED deployment. Healthy tasks return to ten. The cost is that a slow-starting but healthy revision can be rolled back if the threshold is too low, so the threshold has to be set above the measured startup failure window.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Amazon ECS deployment circuit breaker is a rolling deployment control. It monitors the tasks in a new deployment and counts failures: tasks that do not reach RUNNING, and tasks that fail Elastic Load Balancing, AWS Cloud Map, or container health checks. When the count reaches the configured threshold, ECS marks the deployment as failed.",
  },
  {
    type: "p",
    text: "Rollback is a separate option. With rollback enabled, ECS looks for the most recent deployment in the COMPLETED state and restores it. Without rollback, the deployment stops launching new tasks and stays failed. If no COMPLETED deployment exists, ECS does not launch new tasks and the deployment stalls, because there is nothing safe to return to.",
  },
  {
    type: "table",
    headers: ["Setting", "What it controls", "Failure if misconfigured"],
    rows: [
      ["Circuit breaker enabled", "Whether ECS evaluates task failures and can fail the deployment", "A bad rollout stays in progress and keeps holding capacity"],
      ["Rollback enabled", "Whether ECS restores the last COMPLETED deployment", "The deployment is marked failed but the service stays degraded"],
      ["Failure threshold", "How many task failures trigger the decision", "Too low aborts a slow starter; too high prolongs a degraded rollout"],
      ["Health check grace period", "How long health checks are ignored after task start", "Tasks are failed while still warming up, or a broken task hides longer"],
    ],
  },
  {
    type: "p",
    text: "The default threshold is a bounded percentage of the desired count: 50% by default, clamped to a minimum of 3 and a maximum of 200. You can also use an unbounded percentage or a fixed count. The default failure counting resets when a task becomes healthy, so only consecutive failures count; the reset can be disabled to count cumulative failures. The model uses a fixed count for legibility.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The circuit breaker sits inside the ECS rolling deployment controller, not in the load balancer or the application. It reads the deployment's task states and health checks and drives the deployment state that `DescribeServices` reports as rolloutState. Service deployment state changes are also emitted to EventBridge, which is how you can alert on or automate a failed deployment.",
  },
  {
    type: "p",
    text: "The circuit breaker only applies to services using the rolling update ECS deployment controller. It does not replace CloudWatch alarm rollback, which can roll back on a metric such as error rate or latency. The circuit breaker is about task health during the rollout; an alarm rollback is about the service's behavior after the tasks are running.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Deployment age: whether the rollout is progressing or stuck.",
      "New tasks failing health checks: the signal the circuit breaker is counting.",
      "Healthy tasks below desired: the capacity cost of a failed rollout.",
      "Circuit breaker state: whether rollback is armed and how close the failure count is to the threshold.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy to watch a good revision replace the stable tasks. Apply No rollback to see a failed deployment stop at half capacity, then Recovery to restore the stable revision. Apply High threshold to see how a larger failure count delays the rollback. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "deployment-circuit-breaker" },
  { type: "experiment", experimentId: "predict-circuit-breaker" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The bad revision could not pass health checks. With rollback disabled, the circuit breaker eventually marked the deployment failed and stopped launching new tasks, but the service was left at half capacity because the deployment had already removed stable tasks down to the minimum healthy percentage. Marking a deployment failed is not the same as restoring service.",
  },
  {
    type: "p",
    text: "With rollback enabled, the same failure count triggered a return to the last COMPLETED deployment. The stable task set came back to ten. The high-threshold preset showed the cost of waiting: the service stayed degraded about thirty seconds longer before the rollback started.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`DescribeServices`: rolloutState FAILED, rolloutStateReason, deployments, and task counts per revision.",
      "EventBridge `SERVICE_DEPLOYMENT_FAILED` events, including whether the deployment started because of a rollback.",
      "Stopped task reasons and container logs for the new revision.",
      "Target group health, Cloud Map health, and container health check results.",
      "Deployment age and the rate of new task failures before the threshold is reached.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check rolloutState and whether a previous deployment is in COMPLETED. Then read the stopped task reason. If rollback is off, enabling it is a configuration change, not a diagnosis. If rollback is on but did not happen, confirm the deployment controller is the ECS rolling controller and that a COMPLETED deployment exists.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the rollout or roll back immediately if users are affected.",
      "Preserve the failed task definition, stopped task reasons, and logs.",
      "Fix the image, configuration, health check, or startup dependency.",
      "Verify the previous deployment is COMPLETED so a future rollback has a target.",
      "Enable the circuit breaker with rollback and set the threshold above measured startup failures.",
      "Run a canary or a small deployment before replacing the full task set.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A low failure threshold rolls back quickly and can abort a revision that is merely slow to start.",
      "A high threshold tolerates startup noise and keeps the service degraded for longer.",
      "Rollback restores the task definition, not the database schema or messages the bad revision already wrote.",
      "minimumHealthyPercent protects availability during a rollout and limits how much old capacity can be replaced at once.",
      "The circuit breaker only works with the rolling ECS deployment controller; blue/green and external controllers need their own rollback design.",
      "CloudWatch alarm rollback catches bad behavior after tasks are healthy; the circuit breaker catches tasks that never become healthy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "breaker-vs-health",
    question:
      "How is the ECS deployment circuit breaker different from a container health check?",
    difficulty: 2,
    hints: [
      "One evaluates individual task health; the other evaluates the deployment.",
      "The circuit breaker counts repeated failures across tasks.",
    ],
    answer:
      "A container health check decides whether a single task is healthy. The deployment circuit breaker aggregates task failures across the deployment and compares them with a threshold. When the threshold is reached, it marks the deployment failed and, if rollback is enabled, restores the last COMPLETED deployment. A health check can fail forever without a circuit breaker; the breaker is what turns repeated failures into a deployment decision.",
    followUps: [
      "Which health checks does the circuit breaker consider?",
      "What happens when a task becomes healthy between failures?",
      "Why does the circuit breaker not fix a bad application by itself?",
    ],
    redFlags: [
      "Treats the breaker as a replacement for health checks.",
      "Assumes rollback is automatic whenever the breaker is enabled.",
      "Ignores the deployment-level decision.",
    ],
    rubric: [
      "Separates task health from deployment health.",
      "Explains failure counting.",
      "Mentions rollback as a separate option.",
      "Names the health check sources.",
    ],
  },
  {
    id: "threshold-config",
    question:
      "How would you set the circuit breaker failure threshold for a service whose tasks take 90 seconds to start?",
    difficulty: 3,
    hints: [
      "The threshold is a count, a bounded percentage, or an unbounded percentage.",
      "The threshold must be larger than the failures expected during normal startup.",
    ],
    answer:
      "I would first measure startup and health check behavior under normal load, including the grace period, and then choose a threshold that tolerates the expected transient failures while still detecting a revision that never becomes healthy. With a desired count of 20 and the default bounded percentage of 50%, the threshold would be 10, clamped within the 3 to 200 range. If startup is genuinely slow, I would align the health check grace period with measured startup rather than raising the failure threshold alone, because a high threshold keeps a bad rollout running longer. I would test the setting in a staging deployment with a deliberately broken revision.",
    followUps: [
      "When would you use COUNT instead of BOUNDED_PERCENT?",
      "What does resetOnHealthyTask change?",
      "How does the threshold interact with minimumHealthyPercent?",
    ],
    redFlags: [
      "Picks a threshold without measuring startup.",
      "Raises the threshold to hide a broken health check.",
      "Ignores desired count.",
    ],
    rubric: [
      "Starts from measured startup.",
      "Explains threshold types.",
      "Connects to grace period.",
      "Tests the failure path.",
    ],
  },
  {
    id: "no-rollback",
    question:
      "The circuit breaker is enabled, the deployment is FAILED, but the old revision did not come back. Why?",
    difficulty: 2,
    hints: [
      "Marking a deployment failed and rolling back are separate settings.",
      "A rollback needs a previous deployment in COMPLETED.",
    ],
    answer:
      "The most likely reason is that rollback is disabled, so ECS marked the deployment failed and stopped launching tasks without restoring the previous revision. Another possibility is that no previous deployment is in the COMPLETED state, so the circuit breaker has nothing to roll back to and the deployment stalls. I would check the deployment configuration, the rolloutStateReason, and the state of the previous deployment. I would also confirm the service uses the ECS rolling deployment controller, because the circuit breaker is not supported for the other controllers.",
    followUps: [
      "What does the service look like when the rollout stalls with no COMPLETED deployment?",
      "How would you recover manually?",
      "Which EventBridge event would you alert on?",
    ],
    redFlags: [
      "Assumes enabling the breaker always enables rollback.",
      "Ignores the previous deployment state.",
      "Blames the health check only.",
    ],
    rubric: [
      "Separates breaker from rollback.",
      "Checks COMPLETED deployment.",
      "Checks deployment controller.",
      "Names a recovery path.",
    ],
  },
  {
    id: "rollback-verify",
    question:
      "A rollback completed. How do you verify that the service is actually recovered, and what might still be broken?",
    difficulty: 3,
    hints: [
      "Task count is not the same as traffic health.",
      "A rollback does not undo data or schema changes.",
    ],
    answer:
      "I would verify the task count and health per revision, the deployment rolloutState, load balancer target health, error rate, latency, and SLO burn. I would confirm that the service is serving traffic on the previous revision and that no new tasks from the failed revision are still running. I would also check for side effects the bad revision wrote: schema migrations, messages, cache entries, or partial writes. A rollback restores the task definition, not the data, so those need a separate repair or forward fix.",
    followUps: [
      "What would you check before rolling back a database migration?",
      "How do you drain tasks from the failed revision?",
      "When would a forward fix be safer than a rollback?",
    ],
    redFlags: [
      "Checks only the task count.",
      "Assumes data changes are reversible.",
      "Leaves tasks from the failed revision running.",
    ],
    rubric: [
      "Checks traffic and SLO signals.",
      "Confirms revision and task state.",
      "Considers data side effects.",
      "Chooses rollback or forward fix deliberately.",
    ],
  },
];

const checklist = [
  {
    title: "Before the deployment",
    items: [
      "The circuit breaker is enabled with rollback for services that need automatic recovery.",
      "The failure threshold is above the measured startup failure window and below the point where capacity is badly degraded.",
      "A previous deployment is in the COMPLETED state and can be restored.",
      "The health check grace period matches measured application startup.",
    ],
  },
  {
    title: "During the deployment",
    items: [
      "Watch rolloutState, deployment age, and healthy tasks per revision.",
      "Read stopped task reasons before raising the threshold.",
      "Check whether the failure is a bad revision or a slow but healthy one.",
      "Roll back or stop the rollout when the revision cannot become healthy.",
    ],
  },
  {
    title: "After the deployment",
    items: [
      "Verify healthy task count, target health, error rate, and latency.",
      "Check for data or message side effects the failed revision produced.",
      "Record the failure count, threshold, and rollback outcome.",
      "Adjust the threshold or grace period only with measured startup evidence.",
    ],
  },
];

const references = [
  {
    title: "How the Amazon ECS deployment circuit breaker detects failures",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Failure counting, threshold configuration, rollback behavior, and the COMPLETED deployment requirement.",
  },
  {
    title: "Amazon ECS service definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "minimumHealthyPercent, maximumPercent, healthCheckGracePeriodSeconds, and deployment configuration.",
  },
  {
    title: "Amazon ECS services",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs_services.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How the service scheduler replaces unhealthy tasks during a deployment.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "deployment-circuit-breaker": {
      model: circuitBreakerModel,
      presets,
      instructions:
        "Start Healthy, then apply No rollback and watch capacity stay at half. Apply Recovery to see the rollback restore the stable revision. Apply High threshold to see the cost of a larger failure count. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Ten desired tasks, a 50% minimum healthy percentage, and a six-second failure interval are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-services",
    "containers-rolling-deployments",
    "containers-draining",
    "deployment-automated-rollback",
  ],
};
