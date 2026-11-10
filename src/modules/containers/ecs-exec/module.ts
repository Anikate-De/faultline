import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ATTEMPTS = 3;

const params: ParamSpec[] = [
  {
    id: "executeCommandEnabled",
    label: "Execute command enabled",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Service",
    help: "0 leaves the task or service without enableExecuteCommand. 1 allows ECS Exec sessions for new tasks.",
    format: "count",
  },
  {
    id: "taskRolePermissions",
    label: "Task role permissions",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Identity",
    help: "1 gives the task role the Systems Manager messages permissions used by the SSM agent. 0 lets the control plane accept the request and the session fail.",
    format: "count",
  },
  {
    id: "ssmAgent",
    label: "SSM agent in container",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Runtime",
    help: "1 means the container image or host includes a running SSM agent. 0 means the session channel has no endpoint inside the task.",
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
  enabled: boolean;
  role: boolean;
  agent: boolean;
  gaps: number;
  ready: boolean;
  failures: number;
  sessions: number;
  audit: number;
  rootSessions: number;
  health: Health;
}

function compute(p: Params): Computed {
  const enabled = num(p, "executeCommandEnabled", 1) === 1;
  const role = num(p, "taskRolePermissions", 1) === 1;
  const agent = num(p, "ssmAgent", 1) === 1;
  const gaps = [enabled, role, agent].filter((value) => !value).length;
  const ready = gaps === 0;
  const failures = ready ? 0 : ATTEMPTS;
  const sessions = ready ? 1 : 0;
  const audit = ready ? 100 : 0;
  const rootSessions = ready ? 1 : 0;
  const health: Health = ready ? "ok" : "crit";
  return { enabled, role, agent, gaps, ready, failures, sessions, audit, rootSessions, health };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const ssmHealth: Health = !values.role || !values.agent ? "crit" : "ok";
  const ecsHealth: Health = !values.enabled ? "crit" : "ok";
  const taskHealth: Health = values.health;
  const nodes: SimNode[] = [
    {
      id: "operator",
      label: "Operator",
      kind: "client",
      health: "ok",
      sublabel: "AWS CLI or SDK",
      detail: "The operator calls execute-command through the ECS API. The command does not require an inbound port or an SSH key.",
    },
    {
      id: "ssm",
      label: "SSM Session Manager",
      kind: "external",
      health: ssmHealth,
      sublabel: values.role ? "session channel" : "role denied",
      detail: values.role
        ? values.agent
          ? "The session channel reaches the container agent. Commands and their output can be logged for audit."
          : "The session cannot reach an agent inside the task. The SSM agent is missing or not running."
        : "The task role cannot open a Systems Manager messages channel. The control plane may accept the request, but the session cannot start.",
      meta: { role: values.role ? 1 : 0, agent: values.agent ? 1 : 0 },
    },
    {
      id: "ecs",
      label: "ECS control plane",
      kind: "service",
      health: ecsHealth,
      sublabel: values.enabled ? "execute-command on" : "execute-command off",
      detail: values.enabled
        ? "The service or task has execute-command enabled. New tasks can start an Exec session."
        : "The service or task does not have execute-command enabled. Enabling it requires a new deployment for existing tasks.",
      meta: { enabled: values.enabled ? 1 : 0 },
    },
    {
      id: "task",
      label: "checkout task",
      kind: "service",
      role: "instance",
      health: taskHealth,
      utilization: values.ready ? 0.2 : 1,
      sublabel: values.ready ? "shell available" : "no shell",
      detail: values.ready
        ? "The task is running and the session reaches a shell. Commands run as root, so scope the role and keep the audit trail."
        : `The task is running but ${values.gaps} prerequisite${values.gaps === 1 ? "" : "s"} ${values.gaps === 1 ? "is" : "are"} missing. Execute-command fails before a shell opens.`,
      meta: { gaps: values.gaps, sessions: values.sessions },
    },
    {
      id: "audit",
      label: "Session audit log",
      kind: "storage",
      health: "ok",
      sublabel: values.ready ? "CloudWatch Logs" : "no session",
      detail: "Command output can be sent to CloudWatch Logs or Amazon S3, and CloudTrail records who called execute-command. Audit is a separate control from the permission to open a session.",
      meta: { coverage: values.audit },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("operator-ssm", "operator", "ssm", values.ready ? 1 : 0.1, ssmHealth, "session"),
      edge("ssm-ecs", "ssm", "ecs", values.enabled ? 0.8 : 0, ecsHealth, "execute-command"),
      edge("ecs-task", "ecs", "task", values.ready ? 1 : 0.1, taskHealth, "shell"),
      edge("task-audit", "task", "audit", values.ready ? 0.8 : 0, "ok", "records"),
    ],
    metrics: [
      metric("exec-failures", "Failed Exec attempts", values.failures, " attempts", 1, 1, "count"),
      metric("prerequisite-gaps", "Missing Exec prerequisites", values.gaps, "", 1, 1, "count"),
      metric("exec-sessions", "Exec sessions open", values.sessions, "", undefined, undefined, "count"),
      metric("audit-coverage", "Session audit coverage", values.audit, "%", undefined, undefined, "percent"),
      metric("root-sessions", "Sessions with root access", values.rootSessions, "", undefined, undefined, "count"),
      metric("attempts", "Diagnostic attempts", ATTEMPTS, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: values.ready
      ? "Exec is available and audited. Commands run as root; scope IAM and keep the session log."
      : `Exec is unavailable: ${values.gaps} missing prerequisite${values.gaps === 1 ? "" : "s"}. The task keeps running but cannot be inspected from a shell.`,
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
    id: "exec-failures",
    metricId: "exec-failures",
    warn: 1,
    crit: 1,
    title: "Exec cannot open a session",
    cause:
      "At least one prerequisite is missing: the task or service does not have execute-command enabled, the task role lacks the Systems Manager messages permissions, or the container has no running SSM agent. The session fails before a shell opens.",
    fix:
      "Enable execute-command on the service or task, attach the required task role permissions, and use an image or platform with the SSM agent running. Enabling the flag on an existing task requires a new deployment. Verify with the ECS Exec checker before retrying.",
    checkFirst: [
      "Describe the service or task and confirm enableExecuteCommand is true.",
      "Confirm the task role has the Systems Manager messages permissions, not only the execution role.",
      "Confirm the container image includes a running SSM agent and can reach the SSM endpoint or VPC endpoint.",
    ],
  },
  {
    id: "prerequisite-gaps",
    metricId: "prerequisite-gaps",
    warn: 1,
    crit: 1,
    title: "An Exec prerequisite is missing",
    cause:
      "The three requirements are independent. A healthy-looking task can still be unreachable because the service flag was never enabled, the role policy is scoped to a different task, or the image does not contain the agent.",
    fix:
      "Check each requirement separately and in the same order as the ECS Exec checker: task role, SSM agent, service flag, and network path. Fix the missing one, replace the task, and retry the command.",
    checkFirst: [
      "Run the ECS Exec checker for the cluster and task.",
      "Check the task role trust and permissions for the session channel.",
      "Check the service's executeCommandConfiguration and the task's enableExecuteCommand value.",
    ],
  },
];

export const ecsExecModel: SimModel = {
  id: "containers-ecs-exec",
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
      values.ready
        ? "The service flag, task role, and SSM agent are all present. Exec can open a session in the running task."
        : `Exec is blocked by ${values.gaps} missing prerequisite${values.gaps === 1 ? "" : "s"}. The task is still running, so the failure is in the access path, not the workload.`,
      values.role
        ? "The task role can open a Systems Manager messages channel. The execution role is a different role and does not grant Exec access."
        : "A missing task role permission stops the session before the SSM agent is reached. Grant the messages permissions to the task role and replace the task.",
      values.agent
        ? "The container has a running SSM agent. If the agent is present but the session still fails, check the VPC endpoint or outbound path to Systems Manager."
        : "Without a running SSM agent, the session has no endpoint inside the container. Rebuild the image with the agent or use a platform image that includes it.",
      "Commands run as root. Enable session logging and scope who can call execute-command; the audit record is part of the control, not an optional extra.",
    ];
  },
  legend: [
    { label: "Exec ready", tone: "ok" },
    { label: "Session blocked", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Execute command is enabled, the task role has the session permissions, and the SSM agent is running.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak debugging",
    description: "Exec is available and audited while the task is under peak load. Inspect without changing the task.",
    tone: "info",
    params: defaults(),
  },
  {
    id: "failure",
    label: "Task role denied",
    description: "Execute command is enabled and the agent is present, but the task role cannot open a session channel.",
    tone: "crit",
    params: defaults({ taskRolePermissions: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The task role permissions are restored, the agent is running, and Exec opens an audited session.",
    tone: "ok",
    params: defaults(),
  },
];

const experiment: Experiment = {
  id: "exec-missing-agent",
  title: "The shell that never opens",
  simId: "ecs-exec",
  question:
    "Execute command is enabled on the service, and the task role has the Systems Manager permissions. The task is running, but execute-command fails. What is the most likely cause?",
  prediction: {
    options: [
      { id: "role", label: "The task role is missing the session permissions" },
      { id: "agent", label: "The SSM agent is not installed or not running in the container" },
      { id: "alb", label: "The target group health check is failing" },
      { id: "tag", label: "The image uses a mutable tag" },
    ],
    correctOptionId: "agent",
    explanation:
      "The service flag and task role are already in place. The remaining requirement is a running SSM agent inside the container. Without it, the session has no endpoint to connect to and execute-command fails even though the task is healthy.",
  },
  setup: defaults({ ssmAgent: 0 }),
  runFor: 10,
  observe: [
    "One prerequisite is missing and three Exec attempts fail.",
    "No session opens, so there is no shell and no session log entry.",
    "The ECS control plane still shows execute-command enabled.",
    "The task is running; the failure is in the access path.",
  ],
  explain:
    "ECS Exec has three independent requirements. The service or task must allow execute-command, the task role must be allowed to open a Systems Manager messages channel, and the container must run the SSM agent. The control plane can accept the request while the session fails at the agent step. The ECS Exec checker tests the same prerequisites and is faster than guessing.",
  fix: defaults(),
  debrief:
    "After the agent is present, the session opens and the command output can be logged. The operational tradeoff is real: Exec removes the need for a bastion and inbound ports, but it also gives a root shell to anyone with the right IAM permission. Scope the role to the tasks that need it, enable session logging, and use CloudTrail to review who opened a session.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon ECS Exec uses AWS Systems Manager (SSM) Session Manager to run a command in, or open a shell to, a running container. It does not need an inbound port, a bastion host, or an SSH key. The agent inside the task opens an outbound session channel to Systems Manager, and the operator reaches the task through that channel.",
  },
  {
    type: "p",
    text: "Exec is a debugging path, not a deployment mechanism. It is useful when a task is unhealthy, a process is missing, a file is in the wrong place, or the application logs do not explain a failure. It is also powerful: commands run as root even when the container definition sets a different user, so access and audit have to be designed rather than assumed.",
  },
  {
    type: "table",
    headers: ["Requirement", "Where it is configured", "Symptom when missing"],
    rows: [
      ["Execute command flag", "Service or task enableExecuteCommand", "The API rejects the request before a session starts"],
      ["Task role permissions", "Task IAM role", "The session cannot open the Systems Manager channel"],
      ["SSM agent", "Container image or supported platform", "The command fails with no agent endpoint inside the task"],
      ["Network path", "VPC endpoint or outbound access", "The agent cannot reach Systems Manager"],
      ["Session logging", "Service executeCommandConfiguration", "Commands work but there is no audit record"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is operator, AWS CLI or SDK, ECS API, SSM Session Manager, the SSM agent in the container, then the shell or process. The ECS control plane checks the execute-command flag. The task role authorizes the session channel. The agent is the endpoint inside the task. If the task uses a VPC without a NAT gateway, the VPC needs an interface endpoint for Systems Manager messages.",
  },
  {
    type: "p",
    text: "The task role is not the execution role. The execution role pulls the image and writes logs during task startup. The task role is the identity the workload and the SSM agent use at runtime. Granting the execution role the SSM permissions does not make Exec work.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The execute-command flag as a separate control-plane state.",
      "The task role and SSM agent as independent prerequisites.",
      "Failed attempts and open sessions, so a session that never starts is visible.",
      "The task node that stays running while the shell is unavailable.",
      "An audit node that records the session once the path works.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Task role denied to block the session at the role. Use the experiment to remove the agent and see the same symptom from a different cause. Apply Recovery to restore an audited session. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "ecs-exec" },
  { type: "experiment", experimentId: "exec-missing-agent" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The task never stopped running. The failure was in the access path: one of the three Exec requirements was missing, so the session could not open a shell. The task count, the service health, and the application metrics all looked normal, which is why the failure felt like a missing tool rather than an outage.",
  },
  {
    type: "p",
    text: "The service flag, the task role, and the SSM agent fail at different points. A missing flag is rejected by the control plane. A missing role permission fails when the session channel is created. A missing agent fails after the channel is created, when there is no endpoint inside the container. Checking them in that order avoids changing three things at once.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ECS Exec checker output for the cluster and task.",
      "The task definition task role ARN and the role policy for Systems Manager messages.",
      "The service enableExecuteCommand value and executeCommandConfiguration.",
      "The container image and platform: whether the SSM agent is present and running.",
      "CloudTrail ExecuteCommand events and the session log group or bucket.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Run the ECS Exec checker before changing IAM. It tests the task role, the agent, the service flag, and the network path in one pass. If the checker is clean, the problem is usually the command or the shell inside the image, not the ECS configuration.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm execute-command is enabled on the service or task.",
      "Confirm the task role can open a Systems Manager messages channel.",
      "Confirm the SSM agent is installed and running in the container.",
      "Confirm the task can reach Systems Manager through a VPC endpoint or outbound path.",
      "Replace the task so the new flag, role, or image takes effect.",
      "Turn on session logging and review who can call execute-command.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Exec removes the bastion and inbound port, but it creates a remote shell path that must be authorized and audited.",
      "A broad task role is easier to operate and gives every task more access than it needs.",
      "Session logging adds storage cost and captures sensitive output, so retention and access need review.",
      "Running commands as root simplifies debugging and increases the blast radius of a mistake.",
      "Leaving Exec disabled is safer by default but slows diagnosis when a task is failing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "exec-requirements",
    question:
      "You need to inspect a running task, but execute-command fails. What are the requirements, and how do you check them in order?",
    difficulty: 2,
    hints: [
      "There is a control-plane flag, an identity, and an agent.",
      "The task role and the execution role are different.",
    ],
    answer:
      "I would check the execute-command flag on the service or task first, then the task role permissions for Systems Manager messages, then whether the SSM agent is installed and running in the container. After that I would check the network path to Systems Manager, including a VPC endpoint when there is no NAT gateway. The execution role is not the task role, so granting the execution role the SSM permissions does not help. On EC2, a task without a task role can fall back to the instance role, but that gives every task on the instance the same access and is not the design I would choose. The ECS Exec checker tests these prerequisites together, and enabling the flag on an existing task needs a new deployment.",
    followUps: [
      "What does the ECS Exec checker verify?",
      "Why does an existing task not pick up a new execute-command flag?",
      "What changes for a task on EC2 without a task role?",
    ],
    redFlags: [
      "Confuses the execution role with the task role.",
      "Changes the image before checking the flag.",
      "Ignores the network path to Systems Manager.",
    ],
    rubric: [
      "Lists flag, task role, and agent.",
      "Checks them in a sensible order.",
      "Mentions the network path.",
      "Knows the flag needs a new task.",
    ],
  },
  {
    id: "exec-audit",
    question:
      "Your team wants ECS Exec in production for break-glass access. What controls would you put around it?",
    difficulty: 3,
    hints: [
      "A successful session runs as root.",
      "CloudTrail records the API call, and session logging records the command output.",
    ],
    answer:
      "I would restrict who can call execute-command with an IAM policy scoped to the clusters, services, or tasks that need it, and require a break-glass role rather than attaching the permission to every operator. I would enable session logging to CloudWatch Logs or Amazon S3, protect the log destination, and set retention that matches the audit requirement. I would use CloudTrail to review who opened a session and when, and I would alert on sessions outside an expected window. Because commands run as root, I would also keep the task role narrow and review the session transcript after the fact.",
    followUps: [
      "Where does CloudTrail stop and session logging begin?",
      "How would you limit Exec to one service?",
      "What would you log if the command output contains secrets?",
    ],
    redFlags: [
      "Grants execute-command to everyone.",
      "Turns on Exec without session logging.",
      "Assumes commands run as the container user.",
    ],
    rubric: [
      "Scopes IAM permission.",
      "Enables session logging.",
      "Uses CloudTrail for access review.",
      "Accounts for root execution.",
    ],
  },
  {
    id: "exec-no-shell",
    question:
      "Exec opens a session, but the shell command fails inside the container. What is different about this failure?",
    difficulty: 2,
    hints: [
      "The session channel is already working.",
      "A minimal or distroless image may not include a shell.",
    ],
    answer:
      "If the session opens, the flag, task role, agent, and network path are working. The failure is inside the container, which means the image may not include the shell or the binary you called. I would try a command that exists in the image, or use an image variant with a shell for debugging. I would not change the task role or restart the service, because those are not the failing layer. This is also a reason to keep a debug image or a known-good command list for production.",
    followUps: [
      "How would you list processes without a shell?",
      "Would you add a shell to a production image?",
      "How does this differ from a missing SSM agent?",
    ],
    redFlags: [
      "Changes IAM for a working session.",
      "Restarts the task without checking the image.",
      "Assumes every container has bash.",
    ],
    rubric: [
      "Separates session access from command availability.",
      "Names the image contents.",
      "Keeps the fix local.",
      "Mentions a debug path.",
    ],
  },
];

const checklist = [
  {
    title: "Before enabling Exec",
    items: [
      "The task role, not the execution role, has the Systems Manager messages permissions.",
      "The container image or platform runs the SSM agent.",
      "The task can reach Systems Manager through a VPC endpoint or outbound path.",
      "Session logging is configured with a protected destination and retention.",
      "Only the operators who need break-glass access can call execute-command.",
    ],
  },
  {
    title: "During a session",
    items: [
      "Confirm the task ID and container before running a command.",
      "Prefer read-only inspection first: processes, files, environment, network.",
      "Do not change application state without recording the change.",
      "Keep the session short and close it when the diagnosis is done.",
    ],
  },
  {
    title: "After the session",
    items: [
      "Review the session log and CloudTrail event.",
      "Record what was found and what was changed.",
      "Remove temporary IAM or network access.",
      "Add the failure mode to the runbook.",
    ],
  },
];

const references = [
  {
    title: "Monitor Amazon ECS containers with ECS Exec",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "ECS Exec requirements, session behavior, IAM, and audit.",
  },
  {
    title: "Troubleshoot Amazon ECS Exec issues",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/ecs-exec-troubleshooting.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The Exec checker and the common task role, agent, and endpoint failures.",
  },
  {
    title: "AWS Systems Manager Session Manager",
    url: "https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The session channel that ECS Exec uses to reach the container.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "ecs-exec": {
      model: ecsExecModel,
      presets,
      instructions:
        "Start Healthy, then apply Task role denied. Use the experiment to remove the agent and compare the same symptom from a different cause. Apply Recovery to restore an audited session. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Three diagnostic attempts are a teaching value, not an AWS limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-task-definitions",
    "containers-logs",
    "containers-health-checks",
    "observability-structured-logging",
  ],
};
