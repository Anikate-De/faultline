import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DRIVERS = ["none", "awslogs", "firelens"];

const params: ParamSpec[] = [
  {
    id: "logDriver",
    label: "Log driver",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Logging",
    help: "0 writes no container logs. 1 uses awslogs to send stdout and stderr to CloudWatch Logs. 2 uses awsfirelens to route through a FireLens log router.",
    format: "count",
  },
  {
    id: "logPermission",
    label: "Log permission",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Identity",
    help: "1 gives the execution role or task role permission to create the stream and put events. 0 leaves the driver configured but unable to deliver.",
    format: "count",
  },
  {
    id: "retentionDays",
    label: "Log retention",
    min: 1,
    max: 365,
    step: 1,
    value: 30,
    unit: " days",
    group: "Retention",
    help: "The CloudWatch Logs retention for the log group. Events older than the retention are deleted and cannot be recovered by searching again.",
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
  driver: number;
  driverName: string;
  permission: boolean;
  retention: number;
  available: boolean;
  logs: number;
  missingTasks: number;
  retentionRisk: number;
  stopReasonFound: number;
}

function compute(p: Params): Computed {
  const driver = Math.round(clamp(num(p, "logDriver", 1), 0, 2));
  const permission = num(p, "logPermission", 1) === 1;
  const retention = Math.round(clamp(num(p, "retentionDays", 30), 1, 365));
  const available = driver !== 0 && permission;
  const retentionRisk = Math.max(0, 7 - retention);
  return {
    driver,
    driverName: DRIVERS[driver] ?? "none",
    permission,
    retention,
    available,
    logs: available ? 100 : 0,
    missingTasks: available ? 0 : 1,
    retentionRisk,
    stopReasonFound: 1,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const cloudHealth: Health = !values.available ? "crit" : values.retentionRisk > 0 ? "warn" : "ok";
  const driverHealth: Health = !values.available ? "crit" : "ok";
  const nodes: SimNode[] = [
    {
      id: "task",
      label: "checkout task (stopped)",
      kind: "service",
      role: "instance",
      health: "ok",
      sublabel: "exit code 137",
      detail: "The container was OOM-killed and is gone. This node is the stopped task record, not a running process. Its stdout exists only if a log driver shipped it before the task stopped.",
      meta: { exitCode: 137 },
    },
    {
      id: "driver",
      label: `log driver: ${values.driverName}`,
      kind: "service",
      health: driverHealth,
      utilization: values.available ? 1 : 0,
      sublabel: values.driver === 0 ? "no container logs" : values.permission ? "delivering" : "delivery denied",
      detail:
        values.driver === 0
          ? "The container definition has no log driver. stdout and stderr stay in the container runtime and disappear with the task or instance."
          : values.permission
            ? "The driver is configured and can write to its destination. The log stream name and destination determine where you search."
            : "The driver is configured, but the role that writes logs cannot create the stream or put events. The application still writes to stdout; delivery fails.",
      meta: { driver: values.driver, permission: values.permission ? 1 : 0 },
    },
    {
      id: "cloudwatch",
      label: "log group /ecs/checkout",
      kind: "storage",
      health: cloudHealth,
      sublabel: values.available ? `${values.logs}% events present` : "no events",
      detail:
        values.available
          ? `Events are in the log group. Retention is ${values.retention} days, so older events are deleted after that window.`
          : "There are no delivered events to search. The stop reason still exists on the stopped task, so the task failure is not invisible; the application context is.",
      meta: { retention: values.retention, retentionRisk: values.retentionRisk },
    },
    {
      id: "stop-reason",
      label: "stopped task reason",
      kind: "service",
      health: "ok",
      sublabel: values.stopReasonFound ? "OutOfMemoryError" : "not found",
      detail: "DescribeTasks returns stopCode, stoppedReason, and container reason and exit code. This is a separate record from the log stream and survives a missing log driver.",
      meta: { found: values.stopReasonFound },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("task-driver", "task", "driver", values.available ? 1 : 0, driverHealth, "stdout/stderr"),
      edge("driver-cloudwatch", "driver", "cloudwatch", values.available ? 1 : 0, cloudHealth, "ships"),
      edge("task-stop-reason", "task", "stop-reason", 1, "ok", "DescribeTasks"),
    ],
    metrics: [
      metric("logs-available", "Logs available for the stopped task", values.logs, "%", undefined, undefined, "percent"),
      metric("missing-log-tasks", "Stopped tasks with no logs", values.missingTasks, "", 1, 1, "count"),
      metric("retention-risk", "Retention shortfall against a 7-day search", values.retentionRisk, " days", 1, 6, "count"),
      metric("stop-reason-found", "Stop reason found", values.stopReasonFound, "", undefined, undefined, "count"),
      metric("log-driver", "Log driver", values.driver, "", undefined, undefined, "count"),
      metric("retention-days", "Log retention", values.retention, " days", undefined, undefined, "count"),
      metric("stopped-tasks", "Stopped tasks under investigation", 1, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: values.available
      ? `Logs are available for the stopped task. The stop reason is ${values.stopReasonFound ? "present" : "missing"}; retention is ${values.retention} days.`
      : `No logs were delivered for the stopped task. The stop reason is still available, so the OOM cause can be confirmed without the application's last lines.`,
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
    id: "missing-log-tasks",
    metricId: "missing-log-tasks",
    warn: 1,
    crit: 1,
    title: "The stopped task has no delivered logs",
    cause:
      "The container definition has no log driver, the role that writes logs cannot create or put events, or the delivery destination is misconfigured. The task can still run and fail without leaving application output in CloudWatch Logs.",
    fix:
      "Add the awslogs driver with a log group, region, and stream prefix, or add a FireLens router with a delivery destination. Grant the execution role logs:CreateLogStream and logs:PutLogEvents for awslogs, or the task role permission for the FireLens destination. Then force a new deployment and reproduce the failure.",
    checkFirst: [
      "Describe the task definition and read the container logConfiguration.",
      "Check the execution role policy for CloudWatch Logs create and put permissions.",
      "Search the log group for the task ID or stream prefix, not only the service name.",
    ],
  },
  {
    id: "retention-risk",
    metricId: "retention-risk",
    warn: 1,
    crit: 6,
    title: "Log retention is shorter than the investigation window",
    cause:
      "CloudWatch Logs deletes events older than the log group retention. A short retention can remove the evidence before the incident review or a delayed reproduction, even when the driver and permissions were correct.",
    fix:
      "Raise the retention on the log group, or export the log group to Amazon S3 for long-term retention. Decide the retention from the investigation and compliance window, not from the default setting.",
    checkFirst: [
      "Read the log group retentionInDays value.",
      "Check when the stopped task ran and whether its events are older than the retention.",
      "Confirm whether an export or archive exists for the affected window.",
    ],
  },
];

export const logsModel: SimModel = {
  id: "containers-logs",
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
      values.available
        ? `The ${values.driverName} driver delivered the task output. Search the log group for the task ID or stream prefix, then compare the last lines with the stop reason.`
        : "No application logs were delivered. The stop reason is a separate signal from DescribeTasks, so the OOM cause can still be confirmed even when the container is gone.",
      values.driver === 0
        ? "With no log driver, stdout and stderr stay in the container runtime. When the task or instance disappears, that output is gone."
        : values.permission
          ? "The driver and permissions are in place. If the stream seems missing, check the stream prefix, log group name, and region before changing IAM."
          : "The driver is configured but the writer role is denied. The application still emits output; the delivery step is what fails.",
      values.retentionRisk > 0
        ? `Retention is ${values.retention} days, which is ${values.retentionRisk} days short of a seven-day search. The log may be present now and gone when the review needs it.`
        : "Retention covers a seven-day search window. Check the compliance window before treating this as sufficient.",
      "Exit code 137 confirms SIGKILL and is consistent with an OOM kill, but the stoppedReason and container reason name the cause. The log stream explains what the application was doing before the kill.",
    ];
  },
  legend: [
    { label: "Logs present", tone: "ok" },
    { label: "Short retention", tone: "warn" },
    { label: "No logs delivered", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "The awslogs driver delivers to CloudWatch Logs, the execution role can write, and retention is 30 days.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Short retention",
    description: "FireLens delivers the logs, but the log group keeps them for only three days. The evidence may expire before review.",
    tone: "warn",
    params: defaults({ logDriver: 2, retentionDays: 3 }),
  },
  {
    id: "failure",
    label: "No log driver",
    description: "The task has no log driver. The container is gone and CloudWatch Logs has no events, but the stop reason still says OOM.",
    tone: "crit",
    params: defaults({ logDriver: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The awslogs driver is restored, the execution role can write, and retention covers the review window.",
    tone: "ok",
    params: defaults(),
  },
];

const experiment: Experiment = {
  id: "oom-without-logs",
  title: "OOM without application logs",
  simId: "logs",
  question:
    "A task was OOM-killed and its container is gone. The task definition has no log driver, so CloudWatch Logs has no events. Where do you find why the task stopped?",
  prediction: {
    options: [
      { id: "cloudwatch", label: "In the CloudWatch log group for the service" },
      { id: "stop-reason", label: "In the stopped task's stopReason and container reason from DescribeTasks" },
      { id: "filesystem", label: "On the container filesystem, because the container is still mounted" },
      { id: "alb", label: "In the load balancer access logs" },
    ],
    correctOptionId: "stop-reason",
    explanation:
      "The stop reason is task metadata, not application output. DescribeTasks returns stopCode, stoppedReason, and the container reason and exit code. An OOM kill is reported as an OutOfMemoryError reason, so the cause is visible even when the log driver delivered nothing.",
  },
  setup: defaults({ logDriver: 0 }),
  runFor: 10,
  observe: [
    "Logs available is zero and one stopped task has no logs.",
    "The stop reason is still found and names the OOM kill.",
    "The log group has no events because no driver shipped stdout.",
    "Changing retention does not recover the missing application output.",
  ],
  explain:
    "The log stream and the task metadata are separate signals. The log driver ships stdout and stderr; if it is missing, the application's last lines are lost when the task goes away. The stopped task record is kept by ECS and includes the stop reason and container exit code. That is enough to confirm an OOM kill, but not enough to see what the application was doing just before it died. The two signals answer different questions.",
  fix: defaults(),
  debrief:
    "After the awslogs driver is enabled, the application output lands in CloudWatch Logs and the stop reason is still available. The tradeoff is operational: logging every line costs storage and can expose sensitive data, while logging nothing makes an OOM kill a dead end. Set retention and access deliberately, and test that a stopped task leaves both a stop reason and a searchable stream.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A container writes application output to stdout and stderr. A log driver in the task definition decides what happens to that output. The awslogs driver sends it to Amazon CloudWatch Logs. The awsfirelens driver sends it to a FireLens log router, usually Fluent Bit, which forwards it to CloudWatch Logs, Amazon Data Firehose, Amazon S3, or a partner destination. With no driver, the output stays in the container runtime's local log and disappears with the task or instance.",
  },
  {
    type: "p",
    text: "A stopped task has two independent records. The log stream contains what the application wrote before it stopped. The task metadata contains stopCode, stoppedReason, and the container reason and exit code. The first explains behavior; the second explains why the task ended. An out-of-memory (OOM) kill is the clear case: the stop reason can name the memory failure while the application's last lines are still missing. Losing one does not necessarily lose the other.",
  },
  {
    type: "table",
    headers: ["Signal", "Source", "Survives task stop", "What it answers"],
    rows: [
      ["stdout and stderr", "Container log driver", "Only if shipped to a durable destination", "What was the application doing"],
      ["stoppedReason", "ECS task metadata", "Yes, on the stopped task record", "Why did the task stop"],
      ["Container reason and exit code", "ECS task metadata", "Yes", "Which container exited and how"],
      ["Container runtime log", "EC2 host or runtime", "Only while the host or runtime keeps it", "What happened before the driver"],
      ["ALB access logs", "Load balancer", "Yes", "What did clients see"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is container stdout and stderr, the log driver, the destination, and the log group or stream. For awslogs, the task execution role, or the EC2 instance role on EC2, needs permission to create the log stream and put events. For FireLens, the task role needs permission for the destination, and the router container has its own log configuration. A missing permission fails delivery while the application keeps running.",
  },
  {
    type: "p",
    text: "The stop reason comes from the ECS control plane, not from the log pipeline. DescribeTasks returns it for a stopped task, along with the container exit code. For an OOM kill, the reason can name the out-of-memory condition and the exit code is commonly 137, which is 128 plus SIGKILL. That is enough to identify the failure class even when the application's last lines are gone.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The log driver and whether it is delivering or denied.",
      "The log group and the share of stopped tasks with available logs.",
      "Retention measured against a seven-day investigation window.",
      "The stopped task reason as a separate signal from the log stream.",
      "An exit code that supports the stop reason rather than replacing it.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Short retention to see logs that exist but may expire. Apply No log driver to remove the application output while the stop reason remains. Apply Recovery to restore delivery. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "logs" },
  { type: "experiment", experimentId: "oom-without-logs" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The task was already gone. With no log driver, there was no durable copy of stdout or stderr, so the application's last lines could not be searched. The stopped task still carried the stop reason and exit code, which identified the OOM kill. The evidence was split: the cause survived, the context did not.",
  },
  {
    type: "p",
    text: "Restoring the driver moved the application output into CloudWatch Logs. Retention then became the next failure mode: a log group that keeps events for three days can lose the evidence before a delayed review, even though delivery worked.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Task definition logConfiguration: logDriver, log group, region, stream prefix, and FireLens options.",
      "describe-tasks: stopCode, stoppedReason, and the container reason and exitCode.",
      "CloudWatch Logs: streams matching the task ID or stream prefix, not only the service name.",
      "Execution role policy: logs:CreateLogStream and logs:PutLogEvents for awslogs.",
      "Log group retentionInDays and any export to Amazon S3.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the stopped task's stop reason before searching logs. It tells you whether the task failed from OOM, an image pull, or an application exit. Then check the task definition's log driver and the writer role. Do not change retention to fix a missing driver.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read stopCode, stoppedReason, and the container exit code from the stopped task.",
      "Confirm the container definition has a log driver and destination.",
      "Grant the execution role or task role the permissions the driver needs.",
      "Search the correct log group, region, and stream prefix, including the task ID.",
      "Raise retention or export to Amazon S3 if the investigation window is longer.",
      "Force a new deployment and reproduce the failure with delivery confirmed.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Sending every line to CloudWatch Logs improves diagnosis and adds storage and ingestion cost.",
      "A short retention lowers cost but can delete the evidence before a review.",
      "FireLens adds routing flexibility and another container, configuration, and permission surface.",
      "Structured logs are easier to query but require application changes.",
      "Logging sensitive data helps debugging and creates a data-handling obligation.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "missing-logs",
    question:
      "A task was OOM-killed and CloudWatch Logs has no events for it. Walk through how you would find the cause.",
    difficulty: 2,
    hints: [
      "The stop reason is stored on the stopped task.",
      "The log driver and the writer role are separate from the task exit.",
    ],
    answer:
      "I would start with DescribeTasks for the stopped task and read stopCode, stoppedReason, and the container reason and exitCode. An OOM kill is often reported with an OutOfMemoryError reason and exit code 137, so the cause can be confirmed without application logs. Then I would check the task definition logConfiguration: no driver, a missing execution role permission, or a FireLens destination problem would explain the missing stream. I would search the correct log group and stream prefix, then fix the driver and reproduce with a new task if I need the application's last lines.",
    followUps: [
      "What does exit code 137 mean?",
      "How would you find logs if the stream prefix changed?",
      "What would FireLens add here?",
    ],
    redFlags: [
      "Looks only in CloudWatch Logs.",
      "Assumes the task record is gone with the container.",
      "Changes retention before checking the driver.",
    ],
    rubric: [
      "Uses the stopped task reason.",
      "Checks logConfiguration and permissions.",
      "Searches the stream prefix.",
      "Reproduces with logging enabled.",
    ],
  },
  {
    id: "log-driver-choice",
    question:
      "When would you choose awslogs, and when would you choose FireLens?",
    difficulty: 2,
    hints: [
      "awslogs is a direct path to CloudWatch Logs.",
      "FireLens is a router that can send to multiple destinations.",
    ],
    answer:
      "I would use awslogs for the common case: container stdout and stderr to CloudWatch Logs with the least configuration. I would use FireLens when I need routing or transformation before storage, such as multiple destinations, a partner destination, or a specific parsers and metadata format. FireLens adds a log router container and its own configuration and permissions, so it is not free. In both cases I would confirm the writer role, destination, and retention before calling the logging path production-ready.",
    followUps: [
      "Which role needs the destination permission for FireLens?",
      "How does a FireLens router change the task definition?",
      "What happens if the router container fails?",
    ],
    redFlags: [
      "Chooses FireLens for every workload.",
      "Forgets the extra container and permissions.",
      "Treats the two drivers as identical.",
    ],
    rubric: [
      "States the direct path for awslogs.",
      "Names routing and transformation for FireLens.",
      "Accounts for the extra component.",
      "Checks permissions and retention.",
    ],
  },
  {
    id: "stop-reason-vs-logs",
    question:
      "What is the difference between stoppedReason and the application log stream, and why does it matter during an incident?",
    difficulty: 2,
    hints: [
      "One is written by ECS, the other by the application.",
      "The log driver may be missing while the task record still exists.",
    ],
    answer:
      "stoppedReason is task metadata written by ECS. It explains why the task stopped, such as an OOM kill, an image pull failure, or an essential container exit. The log stream is application output shipped by the log driver, and it explains what the application was doing before it stopped. They fail independently. A missing log driver removes the application context but not the stop reason, so I check the stop reason first to classify the failure, then use logs for the detailed sequence.",
    followUps: [
      "Which one tells you the exit code?",
      "How long does a stopped task record remain available in the console?",
      "What other signal would show client impact?",
    ],
    redFlags: [
      "Treats the log stream as the only source of truth.",
      "Confuses an application error log with the stop reason.",
      "Ignores the exit code.",
    ],
    rubric: [
      "Separates ECS metadata from application output.",
      "Names OOM and image pull examples.",
      "Explains independent failure.",
      "Uses both signals together.",
    ],
  },
];

const checklist = [
  {
    title: "Before the workload ships",
    items: [
      "The container definition has a log driver and a destination.",
      "The execution role or task role has the permissions the driver needs.",
      "The log group, region, and stream prefix are recorded in the runbook.",
      "Retention matches the investigation and compliance window.",
      "Sensitive fields are filtered before they reach the log group.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Read the stopped task reason and exit code first.",
      "Search the log group for the task ID or stream prefix.",
      "Check whether the driver is configured and the writer role is allowed.",
      "Do not assume an empty search means the application wrote nothing.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Export the relevant log window before retention deletes it.",
      "Record the stop reason, exit code, and stream name in the timeline.",
      "Fix the driver, permission, or retention gap that hid the evidence.",
      "Add a logging check to the deployment checklist.",
    ],
  },
];

const references = [
  {
    title: "Send Amazon ECS logs to CloudWatch",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_awslogs.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The awslogs driver, logConfiguration, and the execution role permissions.",
  },
  {
    title: "Send Amazon ECS logs to an AWS service or AWS Partner",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/using_firelens.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "FireLens routing, the log router container, and destination permissions.",
  },
  {
    title: "Viewing Amazon ECS stopped task errors",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/stopped-task-errors.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "stopCode, stoppedReason, and the container reason and exit code.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    logs: {
      model: logsModel,
      presets,
      instructions:
        "Start Healthy, then apply Short retention. Apply No log driver to remove the application output while the stop reason remains, then Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. A seven-day search window, one stopped task, and the retention slider range are teaching values, not AWS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-task-definitions",
    "containers-ecs-exec",
    "observability-structured-logging",
    "containers-cpu-memory-limits",
  ],
};
