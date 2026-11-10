import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RUNNING = 8;

const params: ParamSpec[] = [
  {
    id: "targetType",
    label: "Target type",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Registration",
    help: "0 registers IP targets, which is required for awsvpc tasks. 1 registers instance targets, which cannot register these task IPs.",
    format: "count",
  },
  {
    id: "targetPort",
    label: "Target group port",
    min: 1,
    max: 65535,
    step: 1,
    value: 8080,
    unit: "",
    group: "Registration",
    help: "The port registered with the target group and used by the target group health check unless the check overrides it.",
    format: "count",
  },
  {
    id: "containerPort",
    label: "Container port",
    min: 1,
    max: 65535,
    step: 1,
    value: 8080,
    unit: "",
    group: "Runtime",
    help: "The port the application listens on inside the container. The registered port must reach this port.",
    format: "count",
  },
  {
    id: "securityGroupOpen",
    label: "Security group allows ALB",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Runtime",
    help: "1 allows the load balancer to reach the task elastic network interface on the container port. 0 leaves the target registered but unreachable.",
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
  targetType: number;
  targetPort: number;
  containerPort: number;
  sgOpen: boolean;
  registrationErrors: number;
  registered: number;
  healthy: number;
  unroutable: number;
  healthCheckFailures: number;
  errorRate: number;
  capacity: number;
}

function compute(p: Params): Computed {
  const targetType = Math.round(clamp(num(p, "targetType", 0), 0, 1));
  const targetPort = Math.round(clamp(num(p, "targetPort", 8080), 1, 65535));
  const containerPort = Math.round(clamp(num(p, "containerPort", 8080), 1, 65535));
  const sgOpen = num(p, "securityGroupOpen", 1) === 1;
  const instanceMode = targetType === 1;
  const registrationErrors = instanceMode ? RUNNING : 0;
  const registered = instanceMode ? 0 : RUNNING;
  const portMismatch = targetPort !== containerPort;
  const healthy = !instanceMode && sgOpen && !portMismatch ? registered : 0;
  const unroutable = RUNNING - healthy;
  const healthCheckFailures = !instanceMode && (portMismatch || !sgOpen) ? registered : 0;
  const errorRate = healthy === 0 ? 100 : 0;
  const capacity = (healthy / RUNNING) * 100;
  return {
    targetType,
    targetPort,
    containerPort,
    sgOpen,
    registrationErrors,
    registered,
    healthy,
    unroutable,
    healthCheckFailures,
    errorRate,
    capacity,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const tgHealth: Health =
    values.registrationErrors > 0 || values.healthy === 0
      ? "crit"
      : values.healthy < values.registered
        ? "warn"
        : "ok";
  const albHealth: Health =
    values.errorRate >= 5 ? "crit" : values.errorRate > 0 ? "warn" : "ok";
  const taskHealth: Health =
    values.unroutable >= 4 ? "crit" : values.unroutable > 0 ? "warn" : "ok";
  const healthyHealth: Health =
    values.healthy === RUNNING ? "ok" : values.healthy > 0 ? "warn" : "crit";
  const mode = values.targetType === 0 ? "ip" : "instance";
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Clients",
      kind: "client",
      health: "ok",
      sublabel: "HTTP requests",
      detail: "Clients connect to the load balancer listener, not to a task address.",
    },
    {
      id: "alb",
      label: "checkout-alb",
      kind: "lb",
      health: albHealth,
      sublabel: `${values.errorRate.toFixed(0)}% request errors`,
      detail:
        values.registrationErrors > 0
          ? "The listener has no registered target. The target group rejected the task registrations, so no target can serve traffic."
          : values.healthy === 0
            ? "The listener has no healthy target. With every registered target unhealthy, the load balancer fails open to all targets, so requests reach a target that cannot serve them."
            : `The listener forwards to the checkout target group. ${values.healthy} of ${RUNNING} tasks are healthy targets.`,
      meta: { errorRate: values.errorRate },
    },
    {
      id: "target-group",
      label: `checkout-tg (${mode})`,
      kind: "lb",
      health: tgHealth,
      utilization: clamp(values.registered / RUNNING),
      sublabel: `${values.healthy} healthy / ${values.registered} registered`,
      detail:
        values.registrationErrors > 0
          ? "The target group uses instance targets, but the service uses awsvpc networking. ECS registers task IP addresses, so this target group receives no targets."
          : values.healthCheckFailures > 0
            ? `All ${values.registered} tasks are registered, but the health check cannot reach the application on port ${values.targetPort}. The target group keeps them out of rotation.`
            : `All ${values.registered} tasks are registered and passing the target group health check on port ${values.targetPort}.`,
      meta: { targetType: values.targetType, port: values.targetPort, healthy: values.healthy },
    },
    {
      id: "tasks",
      label: "checkout tasks",
      kind: "service",
      role: "instance",
      health: taskHealth,
      utilization: 1,
      sublabel: `${RUNNING} running`,
      detail: `All ${RUNNING} tasks are RUNNING in ECS. A running task is not automatically a registered or healthy target; registration and target health are separate states.`,
      meta: { running: RUNNING, unroutable: values.unroutable },
    },
    {
      id: "healthy-targets",
      label: "Targets receiving traffic",
      kind: "service",
      role: "instance",
      health: healthyHealth,
      utilization: clamp(values.healthy / RUNNING),
      sublabel: `${values.healthy} of ${RUNNING} tasks`,
      detail:
        values.healthy === RUNNING
          ? "Every task is registered, passes its target health check, and receives its share of traffic."
          : `${values.unroutable} tasks are running but receive no traffic. Compare the target health state with the task state instead of restarting tasks blindly.`,
      meta: { healthy: values.healthy },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-alb", "client", "alb", 1, "ok", "HTTPS"),
      edge("alb-tg", "alb", "target-group", values.healthy / RUNNING, tgHealth, "forwards"),
      edge("tg-healthy", "target-group", "healthy-targets", values.healthy / RUNNING, healthyHealth, "routes"),
      edge("tasks-tg", "tasks", "target-group", values.registered / RUNNING, tgHealth, "registers"),
    ],
    metrics: [
      metric("healthy-targets", "Healthy targets", values.healthy, "", undefined, undefined, "count"),
      metric("unroutable-tasks", "Running tasks with no traffic", values.unroutable, " tasks", 1, 4, "count"),
      metric("registration-errors", "Target registration errors", values.registrationErrors, " tasks", 1, 1, "count"),
      metric("error-rate", "Load balancer request errors", values.errorRate, "%", 1, 5, "percent"),
      metric("capacity", "Healthy share of desired tasks", values.capacity, "%", undefined, undefined, "percent"),
      metric("tasks-running", "Tasks running", RUNNING, "", undefined, undefined, "count"),
      metric("target-health-failures", "Registered but unhealthy", values.healthCheckFailures, " targets", undefined, undefined, "count"),
      metric("target-port", "Target group port", values.targetPort, "", undefined, undefined, "count"),
      metric("container-port", "Container port", values.containerPort, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.healthy} of ${RUNNING} running tasks are healthy targets. ${values.registrationErrors} registration errors, ${values.healthCheckFailures} health check failures, ${values.errorRate.toFixed(0)}% request errors.`,
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
    id: "registration-errors",
    metricId: "registration-errors",
    warn: 1,
    crit: 1,
    title: "Tasks are running but were never registered",
    cause:
      "The target group does not accept the task registration. An awsvpc task is registered by its elastic network interface IP address, so the target group must use IP targets. The service load balancer block also has to name the right target group and container.",
    fix:
      "Set the target group target type to IP for awsvpc tasks, or change the network mode to bridge or host and use instance targets. Confirm the service's load balancer configuration names the intended target group and container port, then force a new deployment.",
    checkFirst: [
      "Describe the service and read the load balancer target group ARN, container name, and container port.",
      "Describe the target group and confirm its target type matches the task network mode.",
      "Check recent service events for a registration error or a target group that does not exist.",
    ],
  },
  {
    id: "unroutable-tasks",
    metricId: "unroutable-tasks",
    warn: 1,
    crit: 4,
    title: "Running tasks are receiving no traffic",
    cause:
      "The task is registered but the target group health check is failing. The health check connects to the registered port, so a port mismatch, a closed security group, or a health check path that does not return a success code keeps the target out of rotation.",
    fix:
      "Compare the target group port with the container port and port mapping. Allow the load balancer security group to reach the task security group on that port. Confirm the health check path, protocol, and success codes, then wait for the healthy threshold to pass.",
    checkFirst: [
      "Describe target health and read the state and reason code, such as Target.Timeout or Target.ResponseCodeMismatch.",
      "Compare the target group port with the container port in the task definition.",
      "Check the task security group inbound rules and the load balancer security group egress rules.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The load balancer has no healthy target to serve",
    cause:
      "Every registered target is unhealthy, so the listener cannot route requests to a working task. When all targets fail health checks, the load balancer fails open and sends traffic to them anyway, which produces 5XX responses instead of a clean refusal.",
    fix:
      "Restore target health first by fixing registration, port, security group, or the health check endpoint. Do not add tasks or restart the service until the target group can pass a health check, because new tasks will fail the same check.",
    checkFirst: [
      "Read the ALB access logs for the 5XX response and the target that produced it.",
      "Check HealthyHostCount and UnHealthyHostCount for the target group.",
      "Test the health check path from a host that has the same network path as the load balancer.",
    ],
  },
];

export const albTargetRegistrationModel: SimModel = {
  id: "containers-alb-target-registration",
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
      `${values.healthy} of ${RUNNING} running tasks are healthy targets. The task count alone does not tell you whether traffic reaches them.`,
      values.registrationErrors > 0
        ? "The target group is using instance targets for awsvpc tasks. ECS registers the task IP address, so the registration never produces a usable target."
        : values.healthCheckFailures > 0
          ? `Registration succeeded, but the health check cannot reach port ${values.targetPort}. Compare the registered port, the container port, and the security group rules.`
          : "Registration and health checks agree. The remaining risk is capacity and health check timing, not target eligibility.",
      values.unroutable > 0
        ? `${values.unroutable} tasks are running with no traffic. Check describe-target-health before restarting anything; a restart does not fix a port or security group mismatch.`
        : "Every task is in rotation. If requests still fail, look past registration at the listener rules, certificate, or application response.",
      "The target group health check and the ECS container health check answer different questions. A target can be registered and still unhealthy, and a container can be healthy and still unreachable.",
    ];
  },
  legend: [
    { label: "Healthy target", tone: "ok" },
    { label: "Target not ready", tone: "warn" },
    { label: "No usable target", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Eight awsvpc tasks are registered as IP targets on the matching port and pass health checks.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "All eight targets are healthy at peak traffic. There is no spare target if one fails.",
    tone: "info",
    params: defaults(),
  },
  {
    id: "failure",
    label: "Port mismatch",
    description: "The target group registers port 8080 while the container listens on port 80. All targets are registered and none are healthy.",
    tone: "crit",
    params: defaults({ containerPort: 80 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The target group port matches the container port, the security group allows the ALB, and all eight tasks are healthy targets.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "instance-targets",
    label: "Instance targets",
    description: "The target group uses instance targets for an awsvpc service. Registration fails before health checks begin.",
    tone: "crit",
    params: defaults({ targetType: 1 }),
  },
];

const experiment: Experiment = {
  id: "registered-but-unreachable",
  title: "Registered but unreachable",
  simId: "alb-target-registration",
  question:
    "A service has eight running tasks. describe-target-health lists all eight as registered, but every target is unhealthy and the ALB returns 503. Which change is most likely to restore traffic?",
  prediction: {
    options: [
      { id: "restart", label: "Restart the tasks so they register again" },
      { id: "port", label: "Make the target group port match the container port" },
      { id: "instance", label: "Switch the target group to instance targets" },
      { id: "count", label: "Raise the desired count from eight to twelve" },
    ],
    correctOptionId: "port",
    explanation:
      "Registration and health are separate. The tasks are registered, so registration is not the failing step. The target group sends health checks to the registered port; if nothing listens there, every target stays unhealthy and the listener has no healthy target.",
  },
  setup: defaults({ containerPort: 80 }),
  runFor: 10,
  observe: [
    "All eight tasks are RUNNING and all eight appear as registered targets.",
    "Healthy targets is zero and running tasks with no traffic is eight.",
    "Every target health check fails, so the load balancer request error rate is 100%.",
    "The target group port is 8080 and the container port is 80.",
  ],
  explain:
    "The target group health check uses the registered traffic port unless the health check overrides it. A task that listens on 80 but is registered on 8080 accepts no health check connection. Restarting the task does not change the target group port, and adding tasks only creates more unhealthy targets. The fix is to align the registered port with the listening port, or change the container port mapping and registration together.",
  fix: defaults(),
  debrief:
    "The task was never the problem. The registration path was correct enough to create targets, but the health check tested a port with no listener. In production, compare the service load balancer block, the target group port, and the container port mapping before you touch the task. The tradeoff is explicit: dynamic host port mapping gives you flexibility on EC2, but every port change has to be reflected in the registration and the security group.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Application Load Balancer (ALB) forwards HTTP or HTTPS requests to targets in a target group. For an Amazon Elastic Container Service (ECS) service, the scheduler registers each task as a target and deregisters it when the task stops. A task can be running, healthy, and still receive no traffic if registration or target health is wrong.",
  },
  {
    type: "p",
    text: "Registration maps a task to an address and a port. With the awsvpc network mode, the target is the task elastic network interface IP address, so the target group must use the IP target type. With the bridge or host network modes on Amazon EC2, ECS registers the container instance and a host port, so the target group uses instance targets. The address, port, security group, and health check all have to line up.",
  },
  {
    type: "table",
    headers: ["What is checked", "Where it is configured", "Symptom when wrong"],
    rows: [
      ["Target type", "Target group target type", "A running task never appears as a usable target"],
      ["Port", "Target group port and container port mapping", "The target is registered but health checks fail"],
      ["Security group", "Task network interface and load balancer rules", "Health checks time out and requests cannot connect"],
      ["Health check", "Target group path, port, codes, and thresholds", "The target stays initial or unhealthy and gets no traffic"],
      ["Registration", "Service load balancer configuration", "The task runs but is absent from the target group"],
    ],
  },
  {
    type: "p",
    text: "The target group health check is not the same signal as the ECS container health check. The load balancer asks whether the target can answer on the registered port over the network. The ECS agent runs a command inside the container. Either one can keep a task out of service, and a task can pass one while failing the other.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, ALB listener, target group, task network interface, then the container port. ECS owns the registration step. Elastic Load Balancing owns the health check and the routing decision. The load balancer security group must allow outbound traffic to the task security group on the container port, and the task security group must allow inbound traffic from the load balancer. A missing rule produces a registered but unhealthy target, not a task that failed to start.",
  },
  {
    type: "p",
    text: "Registration state lives in the target group, not on the task. DescribeTasks can report RUNNING while describe-target-health reports initial, unhealthy, draining, or unused. That split is why a task can look healthy in the ECS console and still receive no requests.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Registered targets compared with running tasks, so a missing registration is visible.",
      "Healthy targets and the share of desired tasks that can actually receive traffic.",
      "Registration errors caused by a target type that cannot accept the task address.",
      "Target health failures caused by a port or security group mismatch.",
      "The request error rate when the listener has no healthy target.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Port mismatch to see registration succeed while every health check fails. Apply Instance targets to fail one step earlier, at registration. Apply Recovery to restore IP targets on the matching port. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "alb-target-registration" },
  { type: "experiment", experimentId: "registered-but-unreachable" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure was not a failed task launch. All eight tasks were running and all eight were registered. The target group sent health checks to port 8080 while the container listened on port 80, so every target failed its health check and the listener had no healthy target. The running-task count and the healthy-target count disagreed, and only the second number decides traffic.",
  },
  {
    type: "p",
    text: "The instance-target preset failed earlier in the path. The service used awsvpc networking, so ECS had task IP addresses to register, but the target group only accepts instance IDs. No usable targets appeared, either because the service configuration was rejected or because registration could not complete. Both states look similar at the load balancer, but the check is different: one is a registration error, the other is a health check failure.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "describe-target-health: target state, health check port, and a reason code such as Target.Timeout or Target.ResponseCodeMismatch.",
      "describe-services: the load balancer target group ARN, container name, and container port.",
      "describe-tasks: the task network interface IP address and the security group attached to it.",
      "ALB access logs and target group metrics: 5XX responses and the healthy host count.",
      "ECS service events: registration failures and target group attachment errors.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the target group target type with the task network mode, then compare the target group port with the container port. If both match, check the task security group and the health check path. Do not restart tasks before those three checks, because a restart reproduces the same registration.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the task is RUNNING and record its network interface IP address.",
      "Confirm the service load balancer block points at the intended target group, container, and port.",
      "Match the target type to the network mode: IP for awsvpc, instance for bridge or host.",
      "Align the target group port, container port, and port mapping.",
      "Allow the load balancer to reach the task on that port, then verify the health check path returns a success code.",
      "Watch the healthy host count until every desired task is in rotation before declaring recovery.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "IP targets fit awsvpc and Fargate, but each task consumes an IP address and network interface.",
      "Instance targets reuse host ports and suit bridge or host modes, but they need dynamic port mapping and spare instance capacity.",
      "A long health check interval reduces false positives, but it also keeps a bad target in rotation longer.",
      "A permissive security group is easier to debug and too broad for production.",
      "Target group health checks duplicate some application checks, but they test the exact network path the load balancer uses.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "unused-target",
    question:
      "A task is RUNNING, but describe-target-health shows the target as unused with Target.NotRegistered. What do you check?",
    difficulty: 2,
    hints: [
      "The target group state is about registration, not application health.",
      "The service load balancer block names a target group, container, and port.",
    ],
    answer:
      "I would treat this as a registration problem, not an application problem. I would describe the service and confirm the load balancer target group ARN, container name, and container port, then describe the target group and confirm its target type matches the task network mode. For an awsvpc task the target type must be IP, because ECS registers the task network interface address. I would also check service events for a failed registration and confirm the target group is in the same VPC and load balancer as the service. If the service configuration is right, I would force a new deployment so the scheduler registers the tasks again.",
    followUps: [
      "What changes if the service uses bridge networking on EC2?",
      "Which service event message would tell you registration failed?",
      "Why does a running task not guarantee a registered target?",
    ],
    redFlags: [
      "Restarts the task without checking the target group.",
      "Confuses a target health check with a container health check.",
      "Assumes Fargate supports instance targets.",
    ],
    rubric: [
      "Names registration as the failing step.",
      "Checks the service load balancer block.",
      "Matches target type to network mode.",
      "Uses service events or target health to confirm.",
    ],
  },
  {
    id: "ip-target-requirement",
    question:
      "Why does an awsvpc task need an IP target group, and what breaks if you use instance targets?",
    difficulty: 2,
    hints: [
      "Each awsvpc task has its own network interface and address.",
      "Instance targets register an EC2 instance ID and a port.",
    ],
    answer:
      "An awsvpc task gets its own elastic network interface and private IP address. ECS registers that address and the container port in the target group, so the load balancer can send traffic directly to the task. An instance target group registers the EC2 instance ID and a port on the host, which does not identify an awsvpc task address. On Fargate there is no customer-managed instance to register at all. The result is an empty or unusable target group, even though the tasks are running. The fix is to use IP targets, or to change the network mode and port mapping to match an instance target model.",
    followUps: [
      "How does dynamic host port mapping change the registration?",
      "Which target type would you use for a Fargate service?",
      "What does the service load balancer block actually store?",
    ],
    redFlags: [
      "Says awsvpc supports instance targets.",
      "Thinks the load balancer resolves the task by container name.",
      "Ignores the network mode.",
    ],
    rubric: [
      "Explains the task network interface address.",
      "Contrasts IP and instance registration.",
      "Names the network mode dependency.",
      "States the corrective target type.",
    ],
  },
  {
    id: "registered-unhealthy",
    question:
      "All targets are registered but unhealthy. Walk through the port and security group checks you would run.",
    difficulty: 2,
    hints: [
      "The health check connects to the registered traffic port by default.",
      "The health check source is the load balancer, not your laptop.",
    ],
    answer:
      "I would start with the target health reason code. A timeout points to a network path or security group problem; a response code mismatch points to the health check path or protocol. I would compare the target group port with the container port and the port mapping, then confirm the task security group allows inbound traffic from the load balancer security group on that port. I would also confirm the load balancer security group allows outbound traffic to the task, and that the health check path returns the configured success code from inside the task. Testing from a laptop is not enough because the load balancer uses a different network path.",
    followUps: [
      "What does Target.ResponseCodeMismatch usually mean?",
      "How would you test the health check from the load balancer network path?",
      "What changes if the target group health check overrides the traffic port?",
    ],
    redFlags: [
      "Only checks the application port from a laptop.",
      "Ignores the health check reason code.",
      "Opens the security group to the whole internet.",
    ],
    rubric: [
      "Uses the health check reason code.",
      "Checks the registered port against the container port.",
      "Checks security groups in both directions.",
      "Verifies the health check path and success codes.",
    ],
  },
];

const checklist = [
  {
    title: "Before registration",
    items: [
      "The target group target type matches the service network mode.",
      "The service load balancer block names the intended target group, container, and port.",
      "The container port mapping and the target group port agree.",
      "The task security group allows the load balancer on the container port.",
      "The health check path, protocol, and success codes match the application.",
    ],
  },
  {
    title: "During a deployment",
    items: [
      "Watch registered targets and healthy targets separately.",
      "Read target health reason codes before restarting a task.",
      "Confirm new tasks get a network interface address in the target group VPC.",
      "Do not add capacity to compensate for a registration or health check failure.",
    ],
  },
  {
    title: "After recovery",
    items: [
      "Confirm every desired task is a healthy target.",
      "Record the target group port, container port, and health check settings.",
      "Remove temporary security group rules.",
      "Add the failure mode to the deployment checklist.",
    ],
  },
];

const references = [
  {
    title: "Use load balancing to distribute Amazon ECS service traffic",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-load-balancing.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How an ECS service attaches to a load balancer and target group.",
  },
  {
    title: "Allocate a network interface for an Amazon ECS task",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-networking-awsvpc.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "awsvpc task networking and the task network interface address used by IP targets.",
  },
  {
    title: "Register targets with your Application Load Balancer target group",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-register-targets.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Target registration, IP and instance targets, and the deregistration sequence.",
  },
  {
    title: "Health checks for Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Target health states, reason codes, and health check settings.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-target-registration": {
      model: albTargetRegistrationModel,
      presets,
      instructions:
        "Start Healthy, apply Port mismatch, then Instance targets. Compare the running task count with healthy targets, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Eight tasks and the port range are teaching values, not service limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-services",
    "traffic-alb-target-groups",
    "containers-health-checks",
    "containers-draining",
  ],
};
