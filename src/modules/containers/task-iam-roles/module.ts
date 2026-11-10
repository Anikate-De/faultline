import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ACCESS_NAMES = ["own prefix", "shared bucket", "admin write"];
const SOURCE_NAMES = ["node instance profile", "task role", "static access keys"];
const SCOPE_NAMES = ["s3:* on all buckets", "read-only shared bucket", "read-only own prefix"];

const params: ParamSpec[] = [
  {
    id: "credentialSource",
    label: "Credential source",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Identity",
    help: "0 uses the node instance profile, which every task on the node can reach. 1 uses a task role. 2 uses static access keys, which do not expire.",
    format: "count",
  },
  {
    id: "policyScope",
    label: "Task policy scope",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Policy",
    help: "0 grants s3:* on all buckets. 1 grants read-only access to the shared bucket. 2 grants read-only access to the workload's own prefix.",
    format: "count",
  },
  {
    id: "executionRole",
    label: "Execution role",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Identity",
    help: "0 is missing, so the task cannot pull its image or write logs. 1 is separate and scoped to registry and logs. 2 is the same broad role used for both purposes.",
    format: "count",
  },
  {
    id: "accessNeed",
    label: "Workload access need",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Workload",
    help: "0 reads its own prefix. 1 also reads a shared bucket. 2 performs an administrative write. This is the requirement the policy must satisfy.",
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

interface Values {
  source: number;
  scope: number;
  execution: number;
  need: number;
  effectiveScope: number;
  allowed: boolean;
  denied: number;
  overprivilege: number;
  launchFailures: number;
  staticAgeDays: number;
  sourceName: string;
  scopeName: string;
  needName: string;
}

function compute(p: Params): Values {
  const source = Math.round(clamp(num(p, "credentialSource", 1), 0, 2));
  const scope = Math.round(clamp(num(p, "policyScope", 2), 0, 2));
  const execution = Math.round(clamp(num(p, "executionRole", 1), 0, 2));
  const need = Math.round(clamp(num(p, "accessNeed", 0), 0, 2));
  const effectiveScope = source === 0 ? 0 : scope;
  const maxNeed = effectiveScope === 0 ? 2 : effectiveScope === 1 ? 1 : 0;
  const launchFailures = execution === 0 ? 100 : 0;
  const reached = launchFailures === 0;
  const scopeExcess = effectiveScope === 0 ? 100 : effectiveScope === 1 ? (need === 0 ? 45 : 0) : 0;
  const overprivilege =
    source === 0 ? 100 : Math.min(100, scopeExcess + (source === 2 ? 30 : 0) + (execution === 2 ? 25 : 0));
  const allowed = reached && need <= maxNeed;
  return {
    source,
    scope,
    execution,
    need,
    effectiveScope,
    allowed,
    denied: reached && need > maxNeed ? 100 : 0,
    overprivilege,
    launchFailures,
    staticAgeDays: source === 2 ? 120 : 0,
    sourceName: SOURCE_NAMES[source],
    scopeName: SCOPE_NAMES[effectiveScope],
    needName: ACCESS_NAMES[need],
  };
}

function healthOf(values: Values): Health {
  if (values.launchFailures > 0 || values.denied >= 10 || values.overprivilege >= 70 || values.staticAgeDays >= 90) {
    return "crit";
  }
  if (values.overprivilege >= 40) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const policyHealth: Health =
    values.denied >= 10 ? "crit" : values.overprivilege >= 70 ? "crit" : values.overprivilege >= 40 ? "warn" : "ok";
  const launchHealth: Health = values.launchFailures > 0 ? "crit" : "ok";
  const credentialHealth: Health =
    values.source === 2 ? "crit" : values.source === 0 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "task",
      label: "checkout-task",
      kind: "service",
      health,
      utilization: clamp(values.overprivilege / 100),
      sublabel: `${values.sourceName} · needs ${values.needName}`,
      detail: `The workload needs to ${values.needName === "admin write" ? "perform an administrative write" : `read the ${values.needName}`}. It receives credentials from ${values.sourceName}.`,
      meta: { overprivilege: values.overprivilege, source: values.source },
    },
    {
      id: "role",
      label: values.source === 0 ? "Node instance profile" : "checkout-task-role",
      kind: "service",
      health: policyHealth,
      utilization: clamp(values.overprivilege / 100),
      sublabel: values.scopeName,
      detail:
        values.source === 0
          ? "The workload uses the node's instance profile. The task policy is irrelevant because the task is not using a task role, and every task on the node can reach the same credentials."
          : values.source === 2
            ? "The workload uses static access keys. The policy may be scoped, but the credential does not expire and must be stored and rotated outside IAM role delivery."
            : "The task role is assumed by the ECS agent and its temporary credentials are delivered to the task. The policy attached here controls the workload, not the image pull.",
      meta: { scope: values.effectiveScope, overprivilege: values.overprivilege },
    },
    {
      id: "execution",
      label: "Execution role",
      kind: "service",
      health: launchHealth,
      sublabel:
        values.execution === 0
          ? "missing"
          : values.execution === 1
            ? "separate · ECR and logs"
            : "combined broad role",
      detail:
        values.execution === 0
          ? "The execution role is missing. The agent cannot pull the image or write logs, so the task never starts."
          : values.execution === 1
            ? "The execution role is separate and scoped to pulling the image and writing logs. The task role remains the only source of workload permissions."
            : "The same broad role is used for execution and workload access. It works, but it gives the agent and the workload more permission than each needs.",
      meta: { mode: values.execution },
    },
    {
      id: "bucket",
      label: "shared bucket",
      kind: "storage",
      health: values.launchFailures > 0 ? "ok" : values.denied >= 10 ? "crit" : "ok",
      utilization: values.allowed ? 0.6 : 0,
      sublabel:
        values.launchFailures > 0 ? "not reached" : values.allowed ? "request allowed" : "request denied",
      detail:
        values.launchFailures > 0
          ? "The task never starts because the execution role is missing, so the S3 request is never attempted."
          : values.allowed
            ? `The effective policy permits the ${values.needName} operation in this model.`
            : `The effective policy does not permit the ${values.needName} operation. The request fails with AccessDenied even though the task is running.`,
      meta: { allowed: values.allowed ? 1 : 0 },
    },
    {
      id: "credentials",
      label: "Credential path",
      kind: "external",
      health: credentialHealth,
      sublabel: values.sourceName,
      detail:
        values.source === 1
          ? "The ECS agent assumes the task role and makes temporary credentials available to the task. The credentials rotate without a redeploy."
          : values.source === 0
            ? "The task can use the node's instance profile through the instance metadata path. That credential is shared with every task on the node."
            : "Static keys are placed in the task environment or image. They do not rotate and are visible to anyone who can read the task definition or the image.",
      meta: { staticAge: values.staticAgeDays },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("cred-role", "credentials", "role", 1, credentialHealth, "issues"),
      edge("role-bucket", "role", "bucket", values.allowed ? 1 : 0.1, policyHealth, values.allowed ? "allowed" : "denied"),
      edge("exec-task", "execution", "task", values.launchFailures > 0 ? 0.1 : 1, launchHealth, "starts task"),
      edge("task-bucket", "task", "bucket", values.allowed ? 0.8 : 0.1, health, "reads"),
    ],
    metrics: [
      metric("overprivilege", "Permission breadth above need", values.overprivilege, "", 40, 70, "count"),
      metric("denied-calls", "Workload calls denied", values.denied, "%", 1, 10, "percent"),
      metric("launch-failures", "Task launches failing", values.launchFailures, "%", 1, 5, "percent"),
      metric("static-credential-age", "Static credential age", values.staticAgeDays, " days", 30, 90, "number"),
      metric("allowed", "Workload request allowed", values.allowed ? 1 : 0, "", undefined, undefined, "count"),
      metric("scope", "Effective policy scope", values.effectiveScope, "", undefined, undefined, "count"),
      metric("execution-role", "Execution role mode", values.execution, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, allowed: values.allowed ? 1 : 0 },
    summary: `${values.sourceName}, ${values.scopeName}, ${values.execution === 0 ? "missing execution role" : values.execution === 1 ? "separate execution role" : "combined role"}; ${values.allowed ? "request allowed" : "request denied"}.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.2) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "overprivilege",
    metricId: "overprivilege",
    warn: 40,
    crit: 70,
    title: "The task can do more than its workload needs",
    cause:
      "The task inherits the node instance profile, uses a wildcard policy, or shares one broad role between execution and workload. Every permission beyond the workload's requirement is a path an attacker or a bug can use.",
    fix:
      "Attach a dedicated task role with only the actions and resources the workload uses. Keep the execution role separate. If the task currently uses the node profile, move it to a task role and block the instance metadata path where the platform allows it.",
    checkFirst: [
      "Compare the task role policy with the actions and resources the application actually calls.",
      "Check whether the task uses a task role or the node instance profile.",
      "Check whether execution and workload share one role.",
    ],
  },
  {
    id: "denied-calls",
    metricId: "denied-calls",
    warn: 1,
    crit: 10,
    title: "The workload is being denied access it needs",
    cause:
      "The policy is narrower than the workload's real requirement, or the request goes to a resource outside the allowed prefix. Least privilege is a target that has to include the access the application legitimately needs.",
    fix:
      "Identify the denied action and resource from the error, then add the smallest permission that satisfies the requirement. Do not widen to a wildcard to clear the error. If the need is cross-team, use a resource policy or a dedicated role rather than a broader identity policy.",
    checkFirst: [
      "Read the AccessDenied error for the action and resource ARN.",
      "Compare the policy's resource prefix with the object being requested.",
      "Check whether the request uses the task role or a different credential source.",
    ],
  },
  {
    id: "launch-failures",
    metricId: "launch-failures",
    warn: 1,
    crit: 5,
    title: "The task cannot start because its execution role is wrong",
    cause:
      "The execution role is missing or lacks permission to pull the image or write logs. This role is used by the ECS agent before the application runs, so a task role policy cannot compensate for it.",
    fix:
      "Attach an execution role that can pull from the registry and write to the configured log group. Keep it separate from the task role. Verify the task reaches RUNNING and that logs arrive before debugging application permissions.",
    checkFirst: [
      "Check the task's stopped reason and the service event message.",
      "Check the execution role's trust policy and its ECR and CloudWatch Logs permissions.",
      "Check whether the task definition references the intended role ARN.",
    ],
  },
  {
    id: "static-credentials",
    metricId: "static-credential-age",
    warn: 30,
    crit: 90,
    title: "The workload is using long-lived static credentials",
    cause:
      "Static access keys do not rotate with a role session. They must be stored somewhere the task can read, and anyone who can read the task definition or the image can use them until they are revoked. Rotating them requires a deployment or a secret update.",
    fix:
      "Replace the static keys with a task role so the ECS agent delivers temporary credentials. If an external system cannot use a role, store the credential in Secrets Manager, restrict its permissions, and rotate it on a schedule with an owner.",
    checkFirst: [
      "Check whether the task definition or environment contains AWS access keys.",
      "Check whether the workload can use a task role instead.",
      "Check the key's age, owner, and last rotation.",
    ],
  },
];

export const taskIamModel: SimModel = {
  id: "containers-task-iam-roles",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(seed, values);
    seedSeries(frame);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, values);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, paramsKey: JSON.stringify(p) };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The workload needs ${values.needName} and receives credentials from ${values.sourceName}.`,
      values.source === 0
        ? "Using the node instance profile means every task on the node shares the same permissions. A task role would scope credentials to this workload."
        : values.source === 2
          ? "Static keys work until they leak or expire. They are not delivered by the ECS agent and do not rotate automatically."
          : "The task role is assumed by the agent and delivered as temporary credentials, so the workload does not need static keys.",
      values.launchFailures > 0
        ? "The task cannot start because the execution role is missing, so the workload never makes the S3 call. Fix the execution role before evaluating the workload policy."
        : values.allowed
          ? `The policy permits the request. Its breadth score is ${values.overprivilege}, which measures permission beyond the stated need.`
          : `The policy denies the request. Least privilege has to include the legitimate need, not only remove excess permissions.`,
      values.execution === 0
        ? "The execution role is missing, so the task cannot pull its image or write logs. Fix that before debugging S3."
        : values.execution === 1
          ? "The execution role is separate and scoped to image pulls and logs. The task role remains the only workload identity."
          : "Using one broad role for execution and workload works, but it gives the agent and application more access than either needs.",
      "A trust policy decides who can assume a role; a permission policy decides what the role can do. Both matter, and neither replaces the other.",
    ];
  },
  legend: [
    { label: "Scoped and working", tone: "ok" },
    { label: "Excess permission", tone: "warn" },
    { label: "Denied or overbroad", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A scoped task role, a separate execution role, and access to the workload's own prefix.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Shared bucket grant",
    description: "The workload needs only its own prefix, but the task role can read the whole shared bucket.",
    tone: "warn",
    params: defaults({ credentialSource: 1, policyScope: 1, executionRole: 1, accessNeed: 0 }),
  },
  {
    id: "failure",
    label: "Node role",
    description: "The task uses the node instance profile with s3:* and shares a broad execution role.",
    tone: "crit",
    params: defaults({ credentialSource: 0, policyScope: 0, executionRole: 2, accessNeed: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A dedicated task role reads only the required prefix, with a separate execution role.",
    tone: "ok",
    params: defaults({ credentialSource: 1, policyScope: 2, executionRole: 1, accessNeed: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-execution-role",
  title: "Predict why a correctly scoped task cannot start",
  simId: "task-iam-roles",
  question:
    "A task has a task role that allows s3:GetObject on its own prefix. The task never reaches RUNNING and the service event mentions an image pull failure. Which role is misconfigured?",
  prediction: {
    options: [
      { id: "task", label: "The task role, because it does not allow image pulls" },
      { id: "execution", label: "The execution role, because it pulls the image and writes logs" },
      { id: "node", label: "The node role, because every task needs S3 access" },
      { id: "bucket", label: "The bucket policy, because the image is stored in S3" },
    ],
    correctOptionId: "execution",
    explanation:
      "The execution role is used by the ECS agent to pull the image and write logs before the application starts. The task role is for the workload after it runs. A task role policy cannot grant the agent permission to pull an image. Keep the two roles separate and scope each to its own job.",
  },
  setup: defaults({ credentialSource: 1, policyScope: 2, executionRole: 0, accessNeed: 0 }),
  runFor: 20,
  observe: [
    "The task role permits the workload's own-prefix read, but the launch failure is 100%.",
    "The execution role is missing, so the agent cannot pull the image or write logs.",
    "The S3 request is never reached because the task never starts.",
    "Attaching a separate execution role lets the task launch and keeps the workload policy scoped.",
  ],
  explain:
    "ECS uses two identities with different jobs. The execution role belongs to the agent: image pull, log delivery, and secret injection. The task role belongs to the application: the AWS API calls the code makes. Mixing them produces either a task that cannot start or a workload with the agent's permissions. The trust policy for both allows the ECS tasks service, while the permission policies differ.",
  fix: defaults({ credentialSource: 1, policyScope: 2, executionRole: 1, accessNeed: 0 }),
  debrief:
    "With a separate execution role, the image pulls, logs arrive, and the task reaches RUNNING. The task role still grants only the own-prefix read. The tradeoff is two roles to manage and two policies to review, which is exactly the separation that limits blast radius: a compromised workload does not inherit permission to pull images or write logs outside its own path.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An AWS Identity and Access Management (IAM) role is a set of temporary credentials with a trust policy and a permission policy. Amazon Elastic Container Service (ECS) gives a task two separate roles. The task role supplies the workload's AWS permissions: the ECS agent assumes it and delivers temporary credentials to the application. The execution role is assumed by the agent to pull the image, write logs, and inject secrets before the application starts.",
  },
  {
    type: "p",
    text: "The separation is the point. A task that reads one S3 prefix should not inherit permission to pull arbitrary images or write to any log group. A task that cannot pull its image should not be fixed by widening its S3 policy. The roles also have different trust relationships: both typically trust the ECS tasks service, but they are attached to different parts of the task lifecycle.",
  },
  {
    type: "compare",
    leftTitle: "Task role",
    rightTitle: "Execution role",
    rows: [
      { label: "Who uses it", left: "Application code in the container", right: "ECS agent on the task's behalf" },
      { label: "What it authorizes", left: "S3, DynamoDB, SQS, and other workload calls", right: "Image pull, log delivery, secret injection" },
      { label: "When it matters", left: "After the container starts", right: "Before the application runs" },
      { label: "Typical mistake", left: "Using the node role or a wildcard policy", right: "Reusing the task role for image pulls" },
    ],
  },
  {
    type: "p",
    text: "On EC2 launch types, the container instance also has an instance profile. That profile is not a task role. If the task does not have a task role, or the application reaches the instance metadata service, it may use the node's credentials. Those credentials are shared by every task on the instance and are usually broader than any one workload needs. Fargate has no customer-managed node to inherit from, which removes that path but does not remove the need for a scoped task role.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The execution role is used by the agent at task launch. The agent calls the registry for the image, creates the log stream, and resolves secret references. If the execution role is missing or lacks one of those permissions, the task does not start. The failure appears as a stopped task or a service event, not as an application error.",
  },
  {
    type: "p",
    text: "The task role is used after the container starts. The agent assumes the role and delivers temporary credentials to the container, usually through an environment variable and a local credentials endpoint. The AWS SDK picks them up and signs calls. The credentials rotate automatically, so the application does not need static keys. A trust policy that does not allow the ECS tasks service to assume the role breaks the delivery even when the permission policy looks correct.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Permission breadth above the workload's need, which rises with wildcard actions, wildcard resources, and shared roles.",
      "Denied workload calls, which show the policy is narrower than the real requirement.",
      "Launch failures, which point at the execution role before the application runs.",
      "Static credential age, which shows when keys are used instead of role-delivered credentials.",
    ],
  },
  {
    type: "table",
    headers: ["Symptom", "First role to check", "Signal"],
    rows: [
      ["Task never reaches RUNNING", "Execution role", "Image pull or log configuration error in the service event"],
      ["Task runs but S3 returns AccessDenied", "Task role", "Denied action and resource ARN in the application log"],
      ["Every task on a node has the same broad access", "Task role and node profile", "Workload uses the instance profile instead of a task role"],
      ["Credentials stop working after a rotation", "Static credential source", "Long-lived keys outside IAM role delivery"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Shared bucket grant to see a task role wider than the workload's need. Apply Node role to see a workload inherit the instance profile and a shared execution role. Apply Recovery to return to a scoped task role, then run the experiment before the debrief.",
  },
  { type: "sim", simId: "task-iam-roles" },
  { type: "experiment", experimentId: "predict-execution-role" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The node-role preset made the workload's effective permission the node's permission. The task policy slider stopped mattering because the task was not using a task role. The same broad role was also used for execution, so the agent and the application shared one identity. The workload could read the bucket, but it also carried permission it never needed.",
  },
  {
    type: "p",
    text: "The recovery preset separated the two roles. The execution role pulled the image and wrote logs, while the task role allowed only the own-prefix read. The workload still got the access it needed, and the permission breadth fell to the low range. Nothing about the application changed except which identity it used.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`DescribeTasks` showing a stopped reason about image pull or log configuration.",
      "Application logs with an AccessDenied error naming the action and resource ARN.",
      "A task definition whose task role and execution role ARNs are the same, or whose task role is absent.",
      "Long-lived access keys in environment variables or the image.",
      "The node instance profile being used by a workload because no task role was attached.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the failure boundary: did the task start? If it never started, check the execution role and the image or log configuration. If it started and an AWS call failed, check the task role, the requested action and resource, and the trust policy. Do not widen a policy until you know which role the request used.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify whether the failure happens before or after the container starts.",
      "For launch failures, verify the execution role can pull the image and write logs.",
      "For workload denials, read the action and resource ARN from the error.",
      "Grant the smallest additional permission, or add a resource policy for cross-team access.",
      "Replace node-profile or static-key access with a dedicated task role.",
      "Verify the trust policy allows the ECS tasks service and that credentials rotate.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A separate task role and execution role improve blast-radius control and add two policies to manage.",
      "A wildcard policy is quick to unblock and converts an outage into a standing security exposure.",
      "A strict prefix policy reduces risk and can break a legitimate cross-team read that was never documented.",
      "A shared role is simpler to audit and gives the agent and workload more access than either needs.",
      "Static keys work with any container runtime and create rotation, storage, and leak obligations.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "two-roles",
    question:
      "Explain the difference between an ECS task role and an execution role, and what breaks if you swap them.",
    difficulty: 2,
    hints: [
      "One is used before the application starts; one is used after.",
      "Image pull and logs belong to the agent.",
    ],
    answer:
      "The execution role is assumed by the ECS agent to pull the image, write logs, and resolve secrets before the application starts. The task role is also assumed by the agent, which delivers temporary credentials to the application for its AWS API calls after it starts. If the execution role is missing or too narrow, the task never reaches RUNNING. If the task role is missing, the application falls back to the node profile on EC2 or has no credentials on Fargate. Swapping them either gives the agent workload permissions or gives the workload agent permissions, and the launch or the application call fails.",
    followUps: [
      "Which role needs ECR permissions?",
      "What does the trust policy of each role allow?",
      "How would you prove which identity a request used?",
    ],
    redFlags: [
      "Treats the roles as interchangeable.",
      "Adds S3 permissions to fix an image pull.",
      "Ignores the trust policy.",
    ],
    rubric: [
      "Separates launch time from runtime.",
      "Names image pull and logs for execution.",
      "Names workload APIs for the task role.",
      "Connects the failure to the right phase.",
    ],
  },
  {
    id: "node-role",
    question:
      "A task has no task role and uses the EC2 node's instance profile. Why is that a problem, and how do you move away from it?",
    difficulty: 3,
    hints: [
      "The instance profile is shared by every task on the node.",
      "The metadata path is reachable unless you block it.",
    ],
    answer:
      "The node profile is shared by every task on the instance, so one workload can use permissions intended for another and a compromise spreads beyond one service. It is also usually broader than any single workload needs. I would create a dedicated task role with only the required actions and resources, attach it to the task definition, and deploy a new revision. On EC2 I would also restrict access to the instance metadata service where the platform allows it, so the application cannot fall back to the node profile. I would verify from the application which role ARN the credentials belong to.",
    followUps: [
      "How would you detect that a workload is using the node profile?",
      "What changes on Fargate?",
      "Why is a task role not enough if IMDS stays open?",
    ],
    redFlags: [
      "Assumes a task role automatically blocks the node profile.",
      "Leaves the node role broad.",
      "Ignores shared tenancy on the instance.",
    ],
    rubric: [
      "Explains shared credentials and blast radius.",
      "Creates a scoped task role.",
      "Restricts the metadata path.",
      "Verifies the effective identity.",
    ],
  },
  {
    id: "least-privilege-denial",
    question:
      "You scope a task role to one S3 prefix and the application starts returning AccessDenied for a legitimate shared file. What do you change?",
    difficulty: 2,
    hints: [
      "Least privilege must include the real requirement.",
      "Do not widen to s3:* to clear one error.",
    ],
    answer:
      "I would read the denied action and resource ARN, confirm the request is legitimate, and add the smallest permission that covers it. If the file is in another team's bucket, I would prefer a bucket policy that grants this task role read access to that prefix, or a dedicated role for the cross-team read, rather than expanding the workload's identity policy to all buckets. I would also document the requirement so the next policy review does not remove it. Widening to s3:* would fix the symptom and recreate the overprivilege problem.",
    followUps: [
      "When is a resource policy better than an identity policy?",
      "How would you test the policy before production?",
      "What would you log to detect future denials?",
    ],
    redFlags: [
      "Adds a wildcard action or resource.",
      "Grants access to every bucket.",
      "Does not document the legitimate need.",
    ],
    rubric: [
      "Reads the denied action and resource.",
      "Adds the smallest permission.",
      "Prefers a resource policy for cross-team access.",
      "Documents and tests the change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the task ships",
    items: [
      "The task role contains only the actions and resources the workload calls.",
      "The execution role is separate and can pull the image and write to the configured log group.",
      "No static access keys are stored in the image, task definition, or environment.",
      "The trust policy allows the ECS tasks service to assume each role.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Decide whether the failure happens before or after the container starts.",
      "For launch failures, check the execution role, image, and log configuration.",
      "For workload failures, read the denied action and resource ARN.",
      "Check whether the workload is using the node instance profile instead of a task role.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Replace broad or shared roles with dedicated task roles.",
      "Restrict the instance metadata path where the platform allows it.",
      "Add the denied or excess permission to the policy review.",
      "Verify the effective role ARN from inside the workload.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS task IAM role",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-iam-roles.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The task role, how the agent delivers temporary credentials, and the difference from the execution role.",
  },
  {
    title: "Amazon ECS task execution IAM role",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_execution_IAM_role.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The execution role permissions used for image pulls, logs, and secret injection.",
  },
  {
    title: "Amazon ECS security and IAM",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/security-iam.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "IAM roles, trust policies, and least-privilege guidance for ECS workloads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "task-iam-roles": {
      model: taskIamModel,
      presets,
      instructions:
        "Start Healthy, then apply Shared bucket grant and Node role. Compare the effective identity and permission breadth, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The breadth score, the 120-day static credential age, and the access-need levels are teaching values, not IAM scoring or AWS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-task-definitions",
    "containers-secrets",
    "containers-ecs-exec",
    "containers-logs",
  ],
};
