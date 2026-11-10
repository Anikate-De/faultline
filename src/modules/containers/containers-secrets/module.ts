import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SOURCE_NAMES = ["plaintext environment", "SSM Parameter Store", "Secrets Manager"];

const params: ParamSpec[] = [
  {
    id: "secretSource",
    label: "Secret source",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Source",
    help: "0 puts the value in the environment block. 1 references an SSM parameter. 2 references a Secrets Manager secret. Both references use valueFrom and are resolved at task launch.",
    format: "count",
  },
  {
    id: "credentialAgeDays",
    label: "Days since rotation",
    min: 0,
    max: 180,
    step: 5,
    value: 20,
    unit: " days",
    group: "Rotation",
    help: "Illustrative age of the credential in use. A long age is a risk even when the value is stored in a managed secret.",
    format: "number",
  },
  {
    id: "logPolicy",
    label: "Application logging",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Logs",
    help: "0 redacts secret fields before logging. 1 enables debug output that can print the resolved environment. Injection does not protect a value that the application writes to logs.",
    format: "count",
  },
  {
    id: "accessScope",
    label: "Execution role scope",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Access",
    help: "0 allows only this secret or parameter. 1 allows a wildcard read across the account, which increases the blast radius if the role is misused.",
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
  ageDays: number;
  debugLogs: boolean;
  wildcardRole: boolean;
  sourceName: string;
  definitionExposed: boolean;
  exposure: number;
  rotationEnabled: boolean;
  plaintextReferences: number;
  blastRadius: number;
}

function compute(p: Params): Values {
  const source = Math.round(clamp(num(p, "secretSource", 2), 0, 2));
  const ageDays = clamp(num(p, "credentialAgeDays", 20), 0, 180);
  const debugLogs = Math.round(clamp(num(p, "logPolicy", 0), 0, 1)) === 1;
  const wildcardRole = Math.round(clamp(num(p, "accessScope", 0), 0, 1)) === 1;
  const definitionExposed = source === 0;
  const exposure = definitionExposed ? (debugLogs ? 100 : 80) : debugLogs ? 60 : 0;
  return {
    source,
    ageDays,
    debugLogs,
    wildcardRole,
    sourceName: SOURCE_NAMES[source],
    definitionExposed,
    exposure,
    rotationEnabled: source === 2,
    plaintextReferences: definitionExposed ? 1 : 0,
    blastRadius: definitionExposed ? 100 : wildcardRole ? 85 : 25,
  };
}

function healthOf(values: Values): Health {
  if (values.exposure >= 50 || values.ageDays >= 90 || values.blastRadius >= 70) return "crit";
  if (values.exposure > 0 || values.ageDays >= 30 || values.blastRadius >= 50) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const secretHealth: Health = values.ageDays >= 90 ? "crit" : values.ageDays >= 30 ? "warn" : "ok";
  const definitionHealth: Health = values.definitionExposed ? "crit" : "ok";
  const logsHealth: Health = values.debugLogs ? "crit" : "ok";
  const roleHealth: Health = values.wildcardRole ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "task",
      label: "checkout-task",
      kind: "service",
      health,
      utilization: clamp(values.exposure / 100),
      sublabel: `${values.sourceName} · ${values.ageDays} days old`,
      detail: `The task receives its database password from ${values.sourceName}. ${
        values.definitionExposed
          ? "The value is part of the task definition revision, so it is readable wherever the revision is readable."
          : "The task definition stores a reference, not the value. The ECS agent resolves it before the container starts."
      }`,
      meta: { source: values.source, exposure: values.exposure },
    },
    {
      id: "definition",
      label: "checkout:42 task definition",
      kind: "service",
      health: definitionHealth,
      utilization: values.definitionExposed ? 0.9 : 0.3,
      sublabel: values.definitionExposed ? "plaintext value" : "valueFrom reference",
      detail: values.definitionExposed
        ? "The environment block contains the password literally. DescribeTaskDefinition and the console show it, and every reader of the revision can copy it. A private image does not protect this field."
        : "The container definition uses a secrets entry with valueFrom pointing at the secret or parameter ARN. The revision contains the ARN and the version or stage, not the password.",
      meta: { exposed: values.definitionExposed ? 1 : 0 },
    },
    {
      id: "secret",
      label: values.source === 2 ? "checkout/db-password" : values.source === 1 ? "/checkout/db-password" : "no managed secret",
      kind: "storage",
      health: secretHealth,
      utilization: clamp(values.ageDays / 180),
      sublabel: values.source === 0 ? "not used" : `${values.ageDays} days since rotation`,
      detail:
        values.source === 0
          ? "There is no managed secret in this configuration. The password exists in the task definition and wherever that revision is copied."
          : values.ageDays >= 90
            ? "The secret exists, but the current value is old. Storing a secret is not the same as rotating it; a long-lived credential widens the window after a leak."
            : "The managed secret holds the current version. Rotation changes the value in the store, but a running task keeps the value injected at launch until it is replaced.",
      meta: { ageDays: values.ageDays, rotation: values.rotationEnabled ? 1 : 0 },
    },
    {
      id: "logs",
      label: "CloudWatch Logs",
      kind: "storage",
      health: logsHealth,
      utilization: values.debugLogs ? 0.8 : 0.2,
      sublabel: values.debugLogs ? "resolved value in debug output" : "secret fields redacted",
      detail: values.debugLogs
        ? "Debug logging prints the resolved environment or the connection string. Once copied to a log group, the value has a second retention window and a second access policy."
        : "The application redacts secret fields before logging. Injection keeps the value out of the task definition, and redaction keeps it out of retained logs.",
      meta: { exposed: values.debugLogs ? 1 : 0 },
    },
    {
      id: "role",
      label: "Execution role",
      kind: "external",
      health: roleHealth,
      utilization: values.wildcardRole ? 0.85 : 0.25,
      sublabel: values.wildcardRole ? "wildcard secret read" : "single secret ARN",
      detail: values.wildcardRole
        ? "The execution role can read any secret in the account. A compromised task or a mistaken task definition can pull credentials far beyond this service."
        : "The execution role can read only the secret or parameter this task needs, plus the KMS key when a customer managed key is used. The task role remains separate for workload calls.",
      meta: { wildcard: values.wildcardRole ? 1 : 0 },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("role-secret", "role", "secret", values.source === 0 ? 0.1 : 1, roleHealth, "reads"),
      edge("secret-task", "secret", "task", values.source === 0 ? 0.1 : 0.8, secretHealth, "injects"),
      edge("definition-task", "definition", "task", values.definitionExposed ? 1 : 0.4, definitionHealth, "launches"),
      edge("task-logs", "task", "logs", values.debugLogs ? 0.9 : 0.2, logsHealth, "writes"),
    ],
    metrics: [
      metric("secret-exposure", "Secret readable outside the store", values.exposure, "%", 1, 50, "percent"),
      metric("rotation-age", "Days since last rotation", values.ageDays, " days", 30, 90, "number"),
      metric("blast-radius", "Execution role secret reach", values.blastRadius, "%", 50, 70, "percent"),
      metric("plaintext-references", "Plaintext references", values.plaintextReferences, "", undefined, undefined, "count"),
      metric("managed-secret", "Managed secret in use", values.source === 0 ? 0 : 1, "", undefined, undefined, "count"),
      metric("log-exposures", "Log paths that can print the value", values.debugLogs ? 1 : 0, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, source: values.source, exposure: values.exposure },
    summary: `${values.sourceName}; ${values.ageDays} days since rotation; exposure ${values.exposure}%; execution role reach ${values.blastRadius}%.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.4) * Math.max(0.15, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "secret-exposure",
    metricId: "secret-exposure",
    warn: 1,
    crit: 50,
    title: "A secret value is readable outside the secret store",
    cause:
      "The value is written into the task definition environment block, or the application logs the resolved value. A private image, a narrow task role, and a managed secret do not help when the plaintext is copied into a revision or a log stream.",
    fix:
      "Move the value into Secrets Manager or SSM Parameter Store and reference it with a secrets valueFrom entry. Remove the plaintext environment value, create a new task definition revision, and replace the running tasks. Then remove the value from logs and decide whether the old revision or log stream must be treated as compromised.",
    checkFirst: [
      "Describe the task definition and compare the environment and secrets sections.",
      "Search the log group for the variable name and for connection strings around the deployment window.",
      "Check who can call DescribeTaskDefinition and read the log group.",
    ],
  },
  {
    id: "rotation-age",
    metricId: "rotation-age",
    warn: 30,
    crit: 90,
    title: "The credential is older than its rotation window",
    cause:
      "A managed secret can still hold an old value. Rotation is a separate schedule, and injected secrets are read at task launch, so a running task keeps the old value even after the store rotates. Long-lived credentials increase the exposure window after a leak.",
    fix:
      "Enable rotation for the secret, or run a controlled rotation for an SSM parameter. Then replace the tasks so they resolve the new version, and verify the application reconnects. Treat rotation as a deployment to every consumer, not only a change in the secret store.",
    checkFirst: [
      "Check the secret's last rotation date and the version currently serving traffic.",
      "Compare the value in the running task with the current secret version.",
      "Look for consumers that cache the value or hold a long-lived connection.",
    ],
  },
  {
    id: "blast-radius",
    metricId: "blast-radius",
    warn: 50,
    crit: 70,
    title: "The execution role can read more secrets than this task needs",
    cause:
      "The execution role grants a wildcard secret read instead of the ARN for this task. The role is used by the ECS agent, so a misconfigured task definition or a compromised agent identity can reach credentials for other services.",
    fix:
      "Scope the execution role to the exact secret or parameter ARN and to the KMS key used to encrypt it. Keep the task role separate. If several tasks share a secret, grant the shared ARN explicitly rather than widening to every secret in the account.",
    checkFirst: [
      "Compare the execution role policy with the secret ARN in the task definition.",
      "Check whether a customer managed KMS key adds a separate decrypt permission.",
      "Check whether the task role and execution role are the same role.",
    ],
  },
];

export const secretsModel: SimModel = {
  id: "containers-secrets",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(seed, compute(p));
    seedSeries(frame);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, compute(p));
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
      `The task gets its credential from ${values.sourceName}, and the value is ${values.ageDays} days old.`,
      values.definitionExposed
        ? "A private image does not hide an environment value. The value lives in the task definition revision and is readable wherever that revision is readable."
        : "The task definition stores a reference. The ECS agent resolves it at launch using the execution role, so the revision and image stay free of the value.",
      values.debugLogs
        ? "Injection does not stop the application from logging the resolved value. Redaction has to happen before the log line is written."
        : "Redaction keeps the value out of retained logs. The task can still read the value in memory, so protect the process and the debugging path.",
      values.rotationEnabled
        ? "The secret is managed and can rotate. Running tasks keep the value they started with, so rotation needs a replacement or a refresh path."
        : "SSM Parameter Store can hold the value and is cheaper for simple parameters, but it does not provide the same built-in rotation flow as Secrets Manager.",
      "A running task does not re-read its injected environment. After rotation, the old value remains in the task until it is replaced.",
    ];
  },
  legend: [
    { label: "Managed and current", tone: "ok" },
    { label: "Stale or broad access", tone: "warn" },
    { label: "Value exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Secrets Manager injection, a 20-day-old credential, redacted logs, and a single-secret execution role.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Stale credential",
    description: "An SSM parameter is injected correctly, but the value is 75 days old and due for rotation.",
    tone: "warn",
    params: defaults({ secretSource: 1, credentialAgeDays: 75, logPolicy: 0, accessScope: 0 }),
  },
  {
    id: "failure",
    label: "Plaintext and debug logs",
    description: "The password sits in the environment block, debug logging prints it, and the execution role can read any secret.",
    tone: "crit",
    params: defaults({ secretSource: 0, credentialAgeDays: 120, logPolicy: 1, accessScope: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The value is moved to Secrets Manager, the credential is fresh, logs are redacted, and the role reads one secret.",
    tone: "ok",
    params: defaults({ secretSource: 2, credentialAgeDays: 5, logPolicy: 0, accessScope: 0 }),
  },
];

const experiment: Experiment = {
  id: "where-the-secret-is-readable",
  title: "Locate the secret after launch",
  simId: "secrets",
  question:
    "A database password is stored in the environment block of a task definition. The image is private and the task role is narrow. Who can read the password?",
  prediction: {
    options: [
      { id: "nobody", label: "Nobody, because the image is private and the role is narrow" },
      { id: "readers", label: "Anyone who can read the task definition revision or the console" },
      { id: "taskrole", label: "Only the task role, because it is the runtime identity" },
      { id: "logs", label: "Only through CloudWatch Logs, because environment values are not stored" },
    ],
    correctOptionId: "readers",
    explanation:
      "An environment value is part of the task definition document. DescribeTaskDefinition, the console, and any copy of the revision expose it. A private image and a narrow task role do not change that. Moving the value to Secrets Manager or SSM with a secrets valueFrom entry removes the plaintext from the revision.",
  },
  setup: defaults({ secretSource: 0, credentialAgeDays: 30, logPolicy: 0, accessScope: 0 }),
  runFor: 20,
  observe: [
    "The task definition node reports a plaintext value even though the logs are redacted.",
    "The execution role still has a narrow scope, so the exposure is not caused by role breadth.",
    "The managed secret node is unused because there is no secret reference.",
    "Switching the source to Secrets Manager removes the plaintext from the revision without changing the image.",
  ],
  explain:
    "Injection separates the value from the deployment artifact. The container definition keeps a reference, the ECS agent resolves it at task launch with the execution role, and the running process receives the value in its environment. The same agent can resolve an SSM parameter or a Secrets Manager secret; the difference is rotation, cost, and the KMS key path.",
  fix: defaults({ secretSource: 2, credentialAgeDays: 5, logPolicy: 0, accessScope: 0 }),
  debrief:
    "After the move, the revision contains an ARN and the password lives in Secrets Manager. The remaining work is operational: scope the execution role to that secret, enable rotation, replace tasks after rotation, and keep the value out of logs. The tradeoff is more moving parts and a per-secret cost, exchanged for a deployment artifact that can be reviewed and shared without carrying credentials.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Amazon Elastic Container Service (ECS) task definition can pass configuration to a container in two ways. The environment block contains plaintext values. The secrets block contains references that the ECS agent resolves at task launch, using the task execution role, from AWS Secrets Manager or AWS Systems Manager Parameter Store (SSM). The container sees a normal environment variable either way; the difference is where the value lives before launch and who can read it.",
  },
  {
    type: "p",
    text: "A plaintext environment value is part of the task definition revision. It is visible in DescribeTaskDefinition, in the console, in infrastructure as code, and in any copy of the revision. A secrets reference stores an ARN and an optional version or stage. The password never appears in the revision, and the image does not need to be rebuilt when the value changes.",
  },
  {
    type: "table",
    headers: ["Path", "What the revision contains", "When the value is resolved", "Main risk"],
    rows: [
      ["Environment value", "The literal password", "When the revision is written", "Readable by anyone with revision access"],
      ["Secrets Manager reference", "Secret ARN plus version or stage", "At task launch by the ECS agent", "Stale value in long-running tasks after rotation"],
      ["SSM Parameter reference", "Parameter ARN or name", "At task launch by the ECS agent", "Rotation is not built in; access and versioning need care"],
    ],
  },
  {
    type: "p",
    text: "The distinction that matters during an incident is launch time versus run time. The agent resolves the reference before the container starts. The running task does not poll the secret store. If the secret rotates, the running task keeps the old value until it is replaced or the application refreshes it through its own code. Injection removes the secret from the artifact; it does not make the credential live.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path runs from the secret store through the task execution role to the ECS agent and into the container environment. The execution role needs permission to read the specific secret or parameter, and permission to decrypt with the KMS key when a customer managed key is used. The task role is separate and governs what the application can call after it starts. Mixing the two roles widens the blast radius and is a common review finding.",
  },
  {
    type: "p",
    text: "Logs are the other exit path. A correctly injected secret can still appear in a debug line, a connection string, or a stack trace. CloudWatch Logs has its own retention and access policy, so a value copied there has a second life outside the secret store. Redaction has to happen at emit time, before the line is written. The task definition, the running environment, and the log group are three different places to check.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Secret exposure: whether the value is readable from the task definition or retained logs.",
      "Days since rotation: the age of the credential currently in use, separate from where it is stored.",
      "Execution role reach: whether the role can read one secret or any secret in the account.",
      "Managed secret use: whether the task references a managed store at all.",
      "A task, task definition, secret, log group, and role as separate nodes, so storage and exposure are not averaged into one health value.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Stale credential to separate storage from rotation. Apply Plaintext and debug logs to see the same value exposed through the revision and the log path. Apply Recovery to move the value into Secrets Manager and replace the tasks. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "secrets" },
  { type: "experiment", experimentId: "where-the-secret-is-readable" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The plaintext preset put the password into the task definition revision. The managed secret node was unused, so the store could not help. Debug logging then copied the value into the log path, and the wildcard execution role made every other secret reachable from the same identity. The task still ran, which is why this failure is easy to miss: availability stayed green while the credential spread.",
  },
  {
    type: "p",
    text: "The recovery preset moved the value into Secrets Manager and left only a reference in the revision. The execution role could read one secret, the logs were redacted, and the credential was fresh. Replacing the tasks was part of the fix because the old tasks still held the old environment.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`DescribeTaskDefinition` showing a plaintext value under environment, or a secrets entry with a valueFrom ARN.",
      "CloudWatch Logs containing the variable name, a connection string, or an authorization header near a deployment.",
      "A task execution role with `secretsmanager:GetSecretValue` on `*` or a KMS decrypt permission on a broad key.",
      "Secret versions in Secrets Manager and the value actually present inside a running task.",
      "A rotation event that did not produce new tasks, leaving consumers on the old credential.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Describe the task definition before touching the running task. Compare the environment and secrets sections, then check the log group for the same value. If the value was ever plaintext, treat the revision and the logs as exposure paths even after the new revision is deployed.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify every place the value appears: task definition revisions, image layers, environment overrides, and logs.",
      "Create the secret in Secrets Manager or the parameter in SSM, then reference it from the container definition with valueFrom.",
      "Scope the execution role to the secret ARN and the KMS key, and keep the task role separate.",
      "Deploy a new revision and replace the running tasks so the old environment leaves the fleet.",
      "Enable rotation and add a replacement or refresh step for consumers after each rotation.",
      "Redact the field in application logs and review who can read the log group and the secret.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Secrets Manager provides managed rotation and version stages, at a per-secret cost and with a Lambda rotation path to maintain.",
      "SSM Parameter Store is cheaper for simple values, but rotation and cross-account sharing need more work.",
      "Injecting at launch keeps the value out of the image and revision, but a running task does not see a rotation until it is replaced.",
      "Keeping the value in the environment is simple and works with any runtime, but it puts the secret in the deployment artifact and the process table.",
      "A broad execution role is easier to operate across many services, and it turns one compromised task into access to every secret the role can read.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "plaintext-revision",
    question:
      "A password is in the task definition environment block. The image is private and the task role is narrow. Why is that still a secret leak?",
    difficulty: 2,
    hints: [
      "The environment block is part of the revision document.",
      "DescribeTaskDefinition is an API call with its own permissions.",
    ],
    answer:
      "The environment value is stored in the task definition revision, not only inside the running container. Anyone with permission to call DescribeTaskDefinition, use the console, or read the infrastructure as code can recover it. The private image and narrow task role govern different paths and do not protect the revision. I would move the value to Secrets Manager or SSM, reference it with valueFrom, deploy a new revision, replace the tasks, and treat the old revision and any log copies as exposed.",
    followUps: [
      "Which IAM actions expose a task definition revision?",
      "What happens to the old revision after the new one is deployed?",
      "How would you find out whether the value reached logs?",
    ],
    redFlags: [
      "Assumes a private image protects environment values.",
      "Confuses the task role with the execution role.",
      "Leaves the old revision and logs unexamined.",
    ],
    rubric: [
      "Names the revision as the storage location.",
      "Separates image, task role, and revision access.",
      "Moves the value to a managed store.",
      "Plans replacement and exposure cleanup.",
    ],
  },
  {
    id: "rotation-refresh",
    question:
      "You rotate a database password in Secrets Manager. The service is healthy and no new tasks start. What happens to the running tasks, and how do you complete the rotation?",
    difficulty: 3,
    hints: [
      "The agent resolves the secret at task launch.",
      "A running process does not automatically re-read its environment.",
    ],
    answer:
      "The running tasks keep the value they received at launch. The secret store now has a new version, but the old credential remains in memory until the task is replaced or the application refreshes it. I would confirm whether the database accepts both versions during the transition, then roll the service so new tasks resolve the new version. If the application supports a refresh path, I would use it and verify with a query. After the rollout, I would revoke the old version and check that no consumer still uses it.",
    followUps: [
      "How would you rotate without dropping in-flight database connections?",
      "What if the database does not allow two valid passwords at once?",
      "How would you detect a consumer that cached the old value?",
    ],
    redFlags: [
      "Assumes the running task picks up the new value.",
      "Rotates and immediately revokes the old version.",
      "Does not verify consumers after the rollout.",
    ],
    rubric: [
      "Explains launch-time injection.",
      "Plans a rolling replacement or refresh.",
      "Handles dual-credential acceptance.",
      "Verifies and then retires the old version.",
    ],
  },
  {
    id: "execution-role-scope",
    question:
      "Design the execution role for a task that reads one database secret from Secrets Manager with a customer managed KMS key.",
    difficulty: 3,
    hints: [
      "The agent needs the secret and the decrypt permission.",
      "The task role is a different identity.",
    ],
    answer:
      "The execution role trusts the ECS tasks service and allows secretsmanager:GetSecretValue on the specific secret ARN, plus kms:Decrypt on the specific key when a customer managed key is used. It does not need secretsmanager:GetSecretValue on every secret, and it does not need the workload's S3 or database permissions. The task role stays separate and grants only the application's calls. I would also check the secret resource policy and the KMS key policy, because both can deny access even when the IAM policy looks correct.",
    followUps: [
      "When would you use a secret resource policy instead of widening the execution role?",
      "What changes if the secret is in another account?",
      "How would you verify which role resolved the value?",
    ],
    redFlags: [
      "Grants secretsmanager:* on all secrets.",
      "Uses one role for execution and workload.",
      "Forgets the KMS decrypt permission.",
    ],
    rubric: [
      "Scopes to the secret ARN.",
      "Includes the KMS key permission.",
      "Keeps the task role separate.",
      "Checks resource and key policies.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "The container definition uses a secrets valueFrom reference, not a plaintext environment value.",
      "The execution role can read only the intended secret or parameter and the intended KMS key.",
      "The task role and execution role are separate identities.",
      "The application redacts secret fields before logging.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Describe the task definition revision and locate every plaintext value.",
      "Search retained logs for the variable name and connection strings.",
      "Check the secret version and the value present in a running task.",
      "Decide whether the old revision, logs, or role should be treated as compromised.",
    ],
  },
  {
    title: "After the fix",
    items: [
      "Deploy the new revision and replace every task that held the old value.",
      "Enable rotation and define how consumers pick up a new version.",
      "Remove or restrict the old revision and the log entries that contain the value.",
      "Record the secret ARN, version, and rotation owner in the release record.",
    ],
  },
];

const references = [
  {
    title: "Passing sensitive data to an Amazon ECS container",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The secrets block, valueFrom references, and execution role permissions for Secrets Manager.",
  },
  {
    title: "Passing Systems Manager parameters to an Amazon ECS container",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-ssm-paramstore.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "SSM Parameter Store references, parameter types, and the execution role path.",
  },
  {
    title: "Rotating AWS Secrets Manager secrets",
    url: "https://docs.aws.amazon.com/secretsmanager/latest/userguide/rotating-secrets.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Rotation schedules and the Lambda rotation function that changes the stored value.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    secrets: {
      model: secretsModel,
      presets,
      instructions:
        "Start Healthy, then apply Stale credential to separate storage from rotation. Apply Plaintext and debug logs to expose the value through the revision and logs, then Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The exposure scores, the 180-day age range, and the 50/70 breadth thresholds are teaching values, not AWS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-task-iam-roles",
    "containers-task-definitions",
    "containers-logs",
    "cloud-networking-secrets",
  ],
};
