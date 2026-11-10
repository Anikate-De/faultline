import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RUNNING_TASKS = 6;
const TARGET_CAPACITY_RPS = 1_200;
const TRAFFIC_PORT = 8080;
const HEALTH_PATH = "/healthz";
const HEALTH_PORT = 8080;

const params = [
  {
    id: "registeredTargets",
    label: "Registered targets",
    min: 0,
    max: 6,
    step: 1,
    value: 6,
    unit: "",
    group: "Registration",
    help: "Targets registered with the target group. The ECS service still runs six tasks; a task that is not registered receives no traffic.",
    format: "count" as const,
  },
  {
    id: "requestRate",
    label: "Client requests",
    min: 1_000,
    max: 10_000,
    step: 200,
    value: 4_800,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving at the ALB. Each registered target has an illustrative capacity of 1,200 rps.",
    format: "rps" as const,
  },
  {
    id: "probeMode",
    label: "Health check target (0 correct, 1 wrong path, 2 wrong port)",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Health check",
    help: "0 probes GET /healthz on 8080. 1 probes /health. 2 probes 8081. A mismatch fails the check even when the task is running.",
    format: "count" as const,
  },
  {
    id: "allowFromAlb",
    label: "Target security group allows ALB (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Network",
    help: "1 allows the ALB security group on both the traffic port and the health check port. 0 blocks both, so checks and requests fail.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  registered: number;
  requestRate: number;
  probe: number;
  allows: boolean;
  healthy: number;
  capacity: number;
  routed: number;
  served: number;
  targetUtil: number;
  elb503: number;
  unhealthyShare: number;
  connectionFailures: number;
  errorRate: number;
  failOpen: boolean;
  p99: number;
}

function compute(p: Params): State {
  const registered = Math.min(RUNNING_TASKS, Math.max(0, Math.round(num(p, "registeredTargets", 6))));
  const requestRate = Math.max(1, num(p, "requestRate", 4_800));
  const probe = Math.min(2, Math.max(0, Math.round(num(p, "probeMode", 0))));
  const allows = num(p, "allowFromAlb", 1) >= 0.5;
  const healthy = registered > 0 && probe === 0 && allows ? registered : 0;
  const capacity = registered * TARGET_CAPACITY_RPS;
  const elb503 = registered === 0 ? 100 : 0;
  const failOpen = registered > 0 && healthy === 0;
  const connectionFailures = failOpen && !allows ? 100 : 0;
  const unhealthyShare = registered > 0 ? ((registered - healthy) / registered) * 100 : 0;
  const routed = requestRate * (1 - elb503 / 100) * (1 - connectionFailures / 100);
  const targetUtil = capacity > 0 && allows ? clamp((routed / capacity) * 100, 0, 100) : 0;
  const served = capacity > 0 ? Math.min(routed, capacity) : 0;
  const errorRate = clamp(100 - (served / requestRate) * 100, 0, 100);
  const overflowRatio = capacity > 0 ? Math.max(0, routed - capacity) / capacity : 0;
  const queueing = targetUtil > 85 ? (targetUtil - 85) * 8 : 0;
  const p99 = Math.min(10_000, 12 + queueing + overflowRatio * 1_000 + (connectionFailures > 0 ? 5_000 : 0));
  return {
    registered,
    requestRate,
    probe,
    allows,
    healthy,
    capacity,
    routed,
    served,
    targetUtil,
    elb503,
    unhealthyShare,
    connectionFailures,
    errorRate,
    failOpen,
    p99,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function probeLabel(probe: number): string {
  if (probe === 1) return `GET /health on ${HEALTH_PORT}`;
  if (probe === 2) return `GET ${HEALTH_PATH} on 8081`;
  return `GET ${HEALTH_PATH} on ${HEALTH_PORT}`;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const s = compute(p);
  const clientHealth: Health = s.errorRate >= 5 ? "crit" : s.errorRate >= 0.5 ? "warn" : "ok";
  const albHealth: Health =
    s.elb503 > 0 || s.healthy === 0 ? "crit" : s.targetUtil >= 95 ? "crit" : s.targetUtil >= 85 ? "warn" : "ok";
  const targetHealth: Health =
    s.registered === 0
      ? "down"
      : s.healthy === 0
        ? "crit"
        : s.targetUtil >= 95
          ? "crit"
          : s.targetUtil >= 85
            ? "warn"
            : "ok";
  const nodeDetail =
    `ECS service: ${RUNNING_TASKS} running tasks on port ${TRAFFIC_PORT}. ` +
    `Target group: ${s.registered} registered, ${s.healthy} healthy. ` +
    `Health check: HTTP ${probeLabel(s.probe)}. ` +
    (s.registered === 0
      ? "No target is registered, so the ALB has nowhere to send the request."
      : s.healthy === 0
        ? "All registered targets are unhealthy. The ALB fails open and sends traffic to them anyway."
        : s.served < s.requestRate
          ? "Requests above registered target capacity are rejected or queued; the ALB p99 includes that overflow."
          : "The ALB routes only to healthy registered targets.");
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: s.requestRate,
        sublabel: `${s.errorRate.toFixed(0)}% failed`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: albHealth,
        throughput: s.served,
        sublabel: `HTTP listener · ${s.registered} registered`,
        detail: `Returns 503 only when the target group has no registered targets or every registered target is unused. If all registered targets fail health checks, the ALB fails open and keeps sending traffic. ${s.errorRate.toFixed(0)}% of requests fail at the current load.`,
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Target group",
        kind: "service",
        health: targetHealth,
        utilization: clamp(s.targetUtil / 100),
        throughput: s.served,
        sublabel: `${s.registered} registered · ${s.healthy} healthy`,
        detail: nodeDetail,
        meta: { view: "flow", runningTasks: RUNNING_TASKS },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", 1 - s.elb503 / 100, clientHealth),
      edge("alb-targets", "alb", "targets", s.served / Math.max(1, s.requestRate), targetHealth),
    ],
    metrics: [
      metric("registered-targets", "Registered targets", s.registered, "", undefined, undefined, "count"),
      metric("healthy-targets", "Healthy targets", s.healthy, "", undefined, undefined, "count"),
      metric("unhealthy-share", "Unhealthy target share", s.unhealthyShare, "%", 1, 50, "percent"),
      metric("elb-503", "ALB-generated 503", s.elb503, "%", 0.5, 5, "percent"),
      metric("connection-failures", "Target connection failures", s.connectionFailures, "%", 0.5, 5, "percent"),
      metric("error-rate", "Failed requests", s.errorRate, "%", 0.5, 5, "percent"),
      metric("target-utilization", "Registered target utilization", s.targetUtil, "%", 85, 95, "percent"),
      metric("served", "Requests served", s.served, " rps", undefined, undefined, "rps"),
      metric("p99", "ALB p99", s.p99, "ms", 500, 2_000, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      registered: s.registered,
      healthy: s.healthy,
      probe: s.probe,
      allows: s.allows ? 1 : 0,
    },
    summary: `${s.registered} registered, ${s.healthy} healthy; ${formatCount(s.served)} of ${formatCount(s.requestRate)} req/s served; ${s.errorRate.toFixed(0)}% failed; ${s.elb503.toFixed(0)}% ALB 503; ${s.connectionFailures.toFixed(0)}% target connection failures; ${s.targetUtil.toFixed(0)}% target utilization.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value =
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
        Math.sin(index / 2.1) * amplitude;
      const bounded = item.format === "percent" ? Math.min(100, value) : value;
      return Math.max(0, bounded);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "elb-503",
    metricId: "elb-503",
    warn: 0.5,
    crit: 5,
    title: "The ALB has no usable registered target",
    cause:
      "A 503 from the ALB means the target group has no registered targets, or every registered target is in an unused state. Common causes are a missing registration, a target group not attached to a listener rule, a disabled Availability Zone, or a target that is stopped or terminated.",
    fix:
      "Register the running tasks, attach the target group to a listener rule, enable the Availability Zone, and confirm the registered port. Check describe-target-health for Target.NotRegistered, Target.NotInUse, Target.InvalidState, or Target.IpUnusable before changing health-check timing.",
    checkFirst: [
      "Compare ECS running count with the target group's registered target count.",
      "Check that the listener rule forwards to this target group and not to another one.",
      "Inspect describe-target-health reason codes for the registered targets.",
    ],
  },
  {
    id: "unhealthy-share",
    metricId: "unhealthy-share",
    warn: 1,
    crit: 50,
    title: "Registered targets are failing health checks",
    cause:
      "The health check path, port, protocol, or success code does not match what the task serves. A shared dependency can make every target fail at the same time, so one bad check removes the whole fleet from service.",
    fix:
      "Match the health check to a cheap endpoint that proves the task can serve traffic. Confirm the port is the traffic port or an explicitly reachable health port, and that the expected success code is returned.",
    checkFirst: [
      "Read the target health reason code: ResponseCodeMismatch, Timeout, or FailedHealthChecks.",
      "Curl the health path and port from a task or a debug sidecar.",
      "Check whether all targets failed together, which points to a shared dependency or a configuration change.",
    ],
  },
  {
    id: "connection-failures",
    metricId: "connection-failures",
    warn: 0.5,
    crit: 5,
    title: "The ALB cannot connect to its targets",
    cause:
      "The target security group does not allow the ALB security group on the traffic or health-check port, or the target is listening on a different port. A blocked health check and blocked traffic look the same at the ALB.",
    fix:
      "Allow the ALB security group on both the traffic port and the health-check port. Prefer a security group reference over a CIDR range. Confirm the process is listening on the registered port.",
    checkFirst: [
      "Check the target security group inbound rules for the ALB security group.",
      "Confirm the registered port and the port the process listens on.",
      "Read TargetConnectionErrorCount alongside the health-check reason codes.",
    ],
  },
  {
    id: "target-utilization",
    metricId: "target-utilization",
    warn: 85,
    crit: 95,
    title: "Registered target capacity is the next limit",
    cause:
      "The request rate is high relative to the registered target count. Adding targets that never become healthy does not add capacity; only healthy registered targets receive traffic.",
    fix:
      "Register more healthy targets or reduce the request rate. Verify healthy host count before assuming the new tasks are carrying traffic.",
    checkFirst: [
      "Compare healthy target count with desired task count.",
      "Check request count per target and target CPU or latency.",
      "Confirm new tasks pass the initial health check before the next peak.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const albTargetGroupsModel: SimModel = {
  id: "traffic-alb-target-groups",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const s = compute(p);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (s.registered !== Number(frame.flags.registered ?? -1)) {
      pushEvent(next, {
        id: "registration-change",
        at: frame.t,
        severity: s.registered === 0 ? "crit" : "info",
        title: s.registered === 0 ? "Target group has no registered targets" : `${s.registered} targets registered`,
        detail:
          s.registered === 0
            ? "The ECS tasks are still running, but the target group is empty. The ALB returns 503 because it has no target to choose."
            : `The target group now has ${s.registered} registered targets and ${s.healthy} healthy targets.`,
        nodeId: "targets",
        metricId: "registered-targets",
      });
    }
    if (s.registered > 0 && s.healthy === 0 && frame.flags.allUnhealthy !== 1) {
      pushEvent(next, {
        id: "all-targets-unhealthy",
        at: frame.t,
        severity: "crit",
        title: "Every registered target failed its health check",
        detail: `The health check is ${probeLabel(s.probe)}. ${
          s.allows
            ? "The security group allows the ALB, so the check path, port, or response code is the likely cause."
            : "The target security group does not allow the ALB on the check port."
        } The ALB fails open while every target is unhealthy.`,
        nodeId: "targets",
        metricId: "unhealthy-share",
      });
      next.flags.allUnhealthy = 1;
    } else if (s.healthy > 0) {
      next.flags.allUnhealthy = 0;
    }
    next.flags.registered = s.registered;
    next.flags.healthy = s.healthy;
    next.summary = `${s.registered} registered, ${s.healthy} healthy; ${formatCount(s.served)} of ${formatCount(s.requestRate)} req/s served; ${s.errorRate.toFixed(0)}% failed; ${s.elb503.toFixed(0)}% ALB 503; ${s.connectionFailures.toFixed(0)}% target connection failures; ${s.targetUtil.toFixed(0)}% target utilization.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const s = compute(p);
    const items: string[] = [];
    items.push(`${RUNNING_TASKS} tasks are running; ${s.registered} are registered and ${s.healthy} are healthy.`);
    if (s.registered === 0) {
      items.push("An empty target group produces an ALB 503 before any target capacity or health-check timing matters.");
    }
    if (s.healthy === 0 && s.registered > 0) {
      items.push(
        s.allows
          ? `The check is ${probeLabel(s.probe)}; the security group is open, so compare the path, port, and success code with the task.`
          : "The check is blocked by the target security group, so the ALB cannot establish a health-check connection.",
      );
      items.push("The ALB fails open when all targets are unhealthy, so user traffic may continue while HealthyHostCount is zero.");
    }
    if (s.healthy > 0) {
      items.push(`Healthy targets carry ${formatCount(s.served)} req/s at ${s.targetUtil.toFixed(0)}% of registered capacity.`);
    }
    items.push("A running task is not the same as a registered target, and a registered target is not healthy until it passes a check.");
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
    label: "Healthy registration",
    description: "Six running tasks, six registered, correct health path and port, security group open.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak load",
    description: "All six targets healthy and near their capacity warning line.",
    tone: "warn",
    params: defaults({ registeredTargets: 6, requestRate: 6_800 }),
  },
  {
    id: "failure",
    label: "Blocked security group",
    description: "Tasks are running and registered, but the target security group does not allow the ALB.",
    tone: "crit",
    params: defaults({ registeredTargets: 6, requestRate: 4_800, probeMode: 0, allowFromAlb: 0 }),
  },
  {
    id: "wrong-path",
    label: "Wrong health path",
    description: "All targets fail the check and the ALB fails open; user traffic still reaches the tasks.",
    tone: "crit",
    params: defaults({ registeredTargets: 6, requestRate: 4_800, probeMode: 1, allowFromAlb: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Correct path, open security group, and six healthy registered targets.",
    tone: "ok",
    params: defaults({ registeredTargets: 6, requestRate: 4_000, probeMode: 0, allowFromAlb: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-empty-target-group",
  title: "Predict what a 503 is telling you",
  simId: "alb-target-groups",
  question:
    "Six ECS tasks are running and pass their container health checks, but the ALB returns 503 for every request. The target group shows zero registered targets. What is the first fix?",
  prediction: {
    options: [
      { id: "register", label: "Register the tasks with the target group and attach it to the listener rule." },
      { id: "health-path", label: "Change the health check path from /healthz to /." },
      { id: "security-group", label: "Open the target security group to 0.0.0.0/0." },
      { id: "target-cpu", label: "Add more tasks because the existing tasks are overloaded." },
    ],
    correctOptionId: "register",
    explanation:
      "A running task is not automatically a target. The task must be registered with the target group, the target group must be used by a listener rule, and the target's Availability Zone must be enabled. An empty target group produces a 503 because the ALB has no target to choose. A wrong health path produces unhealthy targets and fail-open behavior, not this 503.",
  },
  setup: defaults({ registeredTargets: 0, requestRate: 4_800, probeMode: 0, allowFromAlb: 1 }),
  runFor: 10,
  observe: [
    "ALB-generated 503 is 100% while the ECS service still reports six running tasks.",
    "Registered and healthy target counts are both zero.",
    "The target group's utilization is zero because no target receives traffic.",
    "Changing the health-check path cannot help an empty target group.",
  ],
  explain:
    "The 503 is an admission failure before a target is chosen. The ALB has no registered target, or every registered target is unused. The ECS service and container health checks are separate from target group registration. Fix the registration and listener attachment first; then verify the health check path and port so the new targets become healthy.",
  fix: defaults({ registeredTargets: 6, requestRate: 4_800, probeMode: 0, allowFromAlb: 1 }),
  debrief:
    "With six targets registered and a matching health check, all six become healthy and the 503 disappears. The next limit is target capacity: 4,800 rps across six targets is 67% of the illustrative capacity. Registration is the gate; capacity tuning comes after it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A target group is the list of destinations behind an Application Load Balancer (ALB) listener rule. You register targets by instance ID, IP address, or Lambda function. The target group owns the port, protocol, and health-check settings. A listener rule forwards to a target group, and the ALB sends a request to a registered healthy target while one is available; if every target is unhealthy, it fails open. Registration and health are separate states: a running task can be absent from the target group, and a registered target can fail its check.",
  },
  {
    type: "p",
    text: "Amazon Elastic Container Service (ECS) registers tasks with a target group when the service's load balancer configuration is correct. The task definition's container port must match the target group port, the task must be in a subnet and Availability Zone enabled for the load balancer, and the target security group must allow the ALB on both the traffic port and the health-check port. If any of those is wrong, the task keeps running and the target group stays empty or unhealthy.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ALB listener, listener rule, target group, target. The listener checks the port and protocol; the rule matches host, path, or other conditions; the target group chooses a healthy registered target. The ALB's 503 means it could not choose a target at all, usually because the group has no registered targets or all registered targets are unused. If targets are registered but all fail health checks, the ALB fails open and routes to all of them, so the symptom is often a target error rather than a 503.",
  },
  {
    type: "compare",
    leftTitle: "Running task",
    rightTitle: "Serving target",
    rows: [
      { label: "ECS state", left: "Task is RUNNING and passes its container health check", right: "Task is registered in the target group" },
      { label: "ALB health", left: "Not evaluated until registration", right: "Must pass the target group health check" },
      { label: "Traffic", left: "None unless registered", right: "Receives requests from the ALB" },
      { label: "Port", left: "Container port may be dynamically mapped", right: "Registered port must match the listener target port" },
      { label: "Security group", left: "May allow the task's own checks", right: "Must allow the ALB on traffic and health ports" },
    ],
  },
  {
    type: "p",
    text: "The most expensive mistake is treating a container health check as a load balancer health check. They answer different questions. The container check asks whether the process is alive; the target group check asks whether the ALB can reach the process on the registered port and get the expected response. A task can pass the first and fail the second.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Registered target count, healthy target count, and the unhealthy share.",
      "ALB-generated 503 percentage, separate from target connection failures.",
      "Registered target utilization and the requests actually served.",
      "A target group node whose detail shows the ECS task count, the check path, the port, and the health state.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then set registered targets to zero. The ECS tasks still run, but the ALB returns 503. Restore registration and switch the health check to the wrong path: all targets become unhealthy, the ALB fails open, and user traffic may still work. Then block the security group and watch connection failures become real errors.",
  },
  {
    type: "table",
    headers: ["Symptom", "First check", "Why"],
    rows: [
      ["ALB 503", "Registered target count and listener rule", "No registered or usable target to choose" ],
      ["Healthy host count zero, traffic still works", "Health check path, port, and success code", "ALB fails open when every target is unhealthy" ],
      ["Target connection failures", "Target security group and registered port", "ALB cannot establish a TCP connection" ],
      ["New task receives no traffic", "ECS load balancer configuration and target health", "Task is running but not registered or not healthy" ],
    ],
  },
  { type: "sim", simId: "alb-target-groups" },
  { type: "experiment", experimentId: "predict-empty-target-group" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The six tasks were running the whole time. When the target group had zero registered targets, the ALB returned 503 before it could choose a target. When all six targets were registered but failed the health check, the ALB failed open and kept sending traffic to them; the health state was critical while the user traffic could still succeed. When the security group blocked the ALB, the same fail-open behavior produced real connection failures.",
  },
  {
    type: "p",
    text: "The order of diagnosis matters. Registration first, listener attachment second, health-check path and port third, security group fourth, capacity last. Changing health-check timing or adding tasks cannot fix an empty target group.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ALB: `HTTPCode_ELB_503_Count`, `RequestCount`, `TargetConnectionErrorCount`, `TargetResponseTime`, and `HealthyHostCount` / `UnHealthyHostCount` by target group.",
      "Target health: `describe-target-health` reason codes such as `Target.NotRegistered`, `Target.NotInUse`, `Target.InvalidState`, `Target.ResponseCodeMismatch`, `Target.Timeout`, and `Target.FailedHealthChecks`.",
      "ECS: service events, running versus desired count, the load balancer configuration, and the container port mapping.",
      "Security groups: the target group's traffic port and health-check port must both allow the ALB security group.",
      "Access logs: requests may show a 503 from the ALB with no target chosen, or a target error when fail-open sends traffic to an unhealthy task.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the ECS running count with the target group's registered count. If registered is zero, fix registration and listener attachment before touching health checks. If registered is greater than zero but healthy is zero, read the health-check reason code and verify the path, port, success code, and security group.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the task is running and the service's load balancer configuration points at the intended target group and container port.",
      "Register the target and confirm the target group is attached to a listener rule.",
      "Enable the Availability Zone and confirm the target is in a supported subnet.",
      "Match the health-check path, port, protocol, and success code to a cheap endpoint the task actually serves.",
      "Allow the ALB security group on both the traffic port and the health-check port.",
      "Wait for the initial health check, then verify healthy host count before shifting traffic.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A deep health check catches dependency failures but can remove every target at once when the dependency is shared. A shallow check keeps capacity but may route to a task that cannot serve.",
      "Fail-open keeps traffic flowing when all targets are unhealthy, but it removes the health gate and can overload tasks that are already failing.",
      "IP targets support ECS tasks with dynamic ports and cross-VPC addresses, but they require the target security group to allow the ALB and the IP to be routable.",
      "Instance targets are simple for static fleets but tie registration to instance lifecycle and the primary network interface.",
      "Aggressive health checks detect failure quickly but increase check traffic and false positives; slower checks trade detection time for stability.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "503-first-check",
    question:
      "The ALB returns 503 while the ECS tasks are running and the container health checks pass. What do you check, in order?",
    difficulty: 2,
    hints: [
      "A running task is not necessarily a registered target.",
      "503 means the ALB could not choose a target at all.",
    ],
    answer:
      "I would compare the ECS running count with the target group's registered and healthy counts. If registered is zero, I would check the service load balancer configuration, the container port, the listener rule attachment, and the target group's Availability Zones. I would read describe-target-health for reason codes such as NotRegistered, NotInUse, or InvalidState. Only after registration is correct would I check the health-check path, port, success code, and the target security group. A 503 is not the same as all targets failing health checks; in that case the ALB fails open and the symptom is usually a target error.",
    followUps: [
      "What does a 503 tell you that a 502 does not?",
      "How would an ECS deployment circuit breaker change the diagnosis?",
      "Which metric would you alarm on first?",
    ],
    redFlags: [
      "Starts by adding tasks or changing CPU.",
      "Assumes a 503 always means unhealthy targets.",
      "Changes the health-check path before checking registration.",
    ],
    rubric: [
      "Separates registration from health.",
      "Names listener rule and Availability Zone checks.",
      "Reads target health reason codes.",
      "Explains fail-open behavior.",
    ],
  },
  {
    id: "healthy-count-zero",
    question:
      "HealthyHostCount is zero, but users report that the application still works. How is that possible, and why is it still urgent?",
    difficulty: 3,
    hints: [
      "Read the ALB fail-open behavior.",
      "The health check and the user traffic may use different paths or ports.",
    ],
    answer:
      "When every registered target is unhealthy, the ALB fails open and routes requests to all registered targets regardless of health. If the health check path or port is wrong but the application traffic path is fine, users can still succeed while the target group reports zero healthy hosts. It is urgent because the health signal is no longer protecting the fleet: a real target failure will not be removed from rotation, new targets may never be considered healthy, and autoscaling or deployment decisions based on healthy host count will be wrong. I would fix the check to match a real readiness endpoint and verify both the traffic and health ports.",
    followUps: [
      "How would you prove the health check is wrong rather than the app?",
      "What happens during a rolling deployment in this state?",
      "Would you alert on HealthyHostCount or UnHealthyHostCount?",
    ],
    redFlags: [
      "Says the ALB stops routing when all targets are unhealthy.",
      "Ignores the false health signal because users are not complaining.",
      "Changes the app before checking the check configuration.",
    ],
    rubric: [
      "Explains fail-open accurately.",
      "Names path, port, or success-code mismatch.",
      "States the operational risk of a false healthy signal.",
      "Proposes a verification step.",
    ],
  },
  {
    id: "ecs-not-registered",
    question:
      "A new ECS task is running but receives no traffic. Walk through the registration path and the likely causes.",
    difficulty: 3,
    hints: [
      "The service load balancer configuration controls registration.",
      "The target group port and the container port must agree.",
    ],
    answer:
      "ECS registers a task when the service has a load balancer configuration for the target group and the task reaches the running state. I would check that the service uses the intended target group and container name, that the container port matches the target group port or the registered port override, and that the task is in an enabled Availability Zone and a routable subnet. Then I would read describe-target-health: NotRegistered means the registration never happened, NotInUse means the target group is not attached to a listener rule or the zone is disabled, and FailedHealthChecks or Timeout means the ALB cannot reach the port. The target security group must allow the ALB on the traffic port and the health-check port.",
    followUps: [
      "What changes if the target type is IP instead of instance?",
      "How does a rolling deployment interact with health-check grace period?",
      "What would you check if only one task in the service is missing?",
    ],
    redFlags: [
      "Only checks the container health check.",
      "Ignores the listener rule attachment.",
      "Opens the security group to the internet instead of referencing the ALB group.",
    ],
    rubric: [
      "Traces service configuration to target registration.",
      "Names port mapping and Availability Zone constraints.",
      "Uses target health reason codes.",
      "Keeps the security group scoped to the ALB.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show registered, healthy, and unhealthy target counts per target group.",
      "Alerts cover ALB 503, target connection errors, and healthy host count.",
      "The ECS service load balancer configuration and container port are documented.",
      "Target security groups reference the ALB security group on traffic and health ports.",
      "The health check uses a cheap readiness endpoint, not a deep dependency check.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare running tasks with registered targets before changing anything.",
      "Confirm the target group is attached to a listener rule and the zone is enabled.",
      "Read describe-target-health reason codes.",
      "Check the target security group and the registered port.",
      "Do not add tasks to fix a registration or health-check problem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify healthy host count reaches the desired count after the fix.",
      "Re-run a deployment to confirm new tasks register and become healthy.",
      "Add a synthetic check that exercises the listener path, not only the container.",
      "Record whether fail-open masked the health signal.",
    ],
  },
];

const references = [
  {
    title: "Target groups for your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target types, registration, ports, health checks, and target group attributes.",
  },
  {
    title: "Health checks for Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Health check settings, target states, reason codes, and fail-open behavior.",
  },
  {
    title: "Troubleshoot your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "503 causes, unhealthy target causes, security group and network ACL checks.",
  },
  {
    title: "Register targets with your Application Load Balancer target group",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-register-targets.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Registration requirements, target security groups, and ECS target support.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-target-groups": {
      model: albTargetGroupsModel,
      presets,
      instructions:
        "Start healthy. Set registered targets to zero and watch the ALB 503. Restore registration, then switch the health check to the wrong path and observe fail-open. Block the security group last to see real connection failures.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Task count, per-target request capacity, latency, and error timing are teaching values, not AWS limits or guarantees. The 503 and fail-open behaviors follow AWS documentation; the exact response mix depends on the application and the failure.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-l4-vs-l7", "traffic-alb-health-checks", "traffic-502-debug"],
};
