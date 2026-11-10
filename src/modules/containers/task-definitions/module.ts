import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TASK_COUNT = 10;
const MAX_REVISION = 12;

const params: ParamSpec[] = [
  {
    id: "serviceRevision",
    label: "Service revision",
    min: 1,
    max: MAX_REVISION,
    step: 1,
    value: 8,
    unit: "",
    group: "Revision",
    help: "The task definition revision the service deploys. A service stores family:revision, not a floating latest tag.",
    format: "count",
  },
  {
    id: "latestRevision",
    label: "Latest registered revision",
    min: 1,
    max: MAX_REVISION,
    step: 1,
    value: 8,
    unit: "",
    group: "Revision",
    help: "The newest ACTIVE revision in the task definition family. Registering it does not change a service that pins an older revision.",
    format: "count",
  },
  {
    id: "replacedPercent",
    label: "Tasks on the service revision",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Task mix",
    help: "Share of running tasks that use the service revision. The rest still run the previous revision during a rollout.",
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

interface Computed {
  serviceRevision: number;
  latestRevision: number;
  replaced: number;
  currentTasks: number;
  previousTasks: number;
  previousShare: number;
  gap: number;
  mixedMinority: number;
  stale: number;
  launchFailures: number;
  previousRevision: number;
  hasPrevious: boolean;
}

function compute(p: Params): Computed {
  const serviceRevision = Math.round(clamp(num(p, "serviceRevision", 8), 1, MAX_REVISION));
  const latestRevision = Math.round(clamp(num(p, "latestRevision", 8), 1, MAX_REVISION));
  const replaced = clamp(num(p, "replacedPercent", 100), 0, 100);
  const registered = serviceRevision <= latestRevision;
  const hasPrevious = registered ? serviceRevision > 1 : true;
  const previousRevision = registered ? Math.max(1, serviceRevision - 1) : latestRevision;
  const currentTasks = !registered ? 0 : hasPrevious ? Math.round((TASK_COUNT * replaced) / 100) : TASK_COUNT;
  const previousTasks = TASK_COUNT - currentTasks;
  const previousShare = (previousTasks / TASK_COUNT) * 100;
  const mixedMinority =
    currentTasks > 0 && previousTasks > 0 ? (Math.min(currentTasks, previousTasks) / TASK_COUNT) * 100 : 0;
  const gap = registered ? Math.max(0, latestRevision - serviceRevision) : 0;
  return {
    serviceRevision,
    latestRevision,
    replaced,
    currentTasks,
    previousTasks,
    previousShare,
    gap,
    mixedMinority,
    stale: registered ? (gap > 0 ? 100 : previousShare) : 0,
    launchFailures: registered ? 0 : 100,
    previousRevision,
    hasPrevious,
  };
}

function serviceHealth(values: Computed): Health {
  if (values.launchFailures > 0 || values.gap >= 2 || values.mixedMinority >= 20) return "crit";
  if (values.gap === 1 || values.mixedMinority > 0 || (values.currentTasks === 0 && values.hasPrevious)) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const health = serviceHealth(values);
  const currentHealth: Health =
    values.launchFailures > 0 || values.gap >= 2
      ? "crit"
      : values.gap === 1 || (values.currentTasks === 0 && values.hasPrevious)
        ? "warn"
        : "ok";
  const previousHealth: Health =
    values.mixedMinority >= 20 ? "crit" : values.mixedMinority > 0 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      sublabel: `pins checkout:${values.serviceRevision}`,
      detail:
        values.launchFailures > 0
          ? `The service points to checkout:${values.serviceRevision}, which is newer than the latest ACTIVE revision checkout:${values.latestRevision}. No task can launch from an unregistered revision.`
          : `The service stores checkout:${values.serviceRevision}. The newest ACTIVE revision is checkout:${values.latestRevision}. ${values.gap > 0 ? "A newer revision exists but is not part of this service unless the service is updated." : "The service is on the newest revision."}`,
      meta: { pinned: values.serviceRevision, latest: values.latestRevision },
    },
    {
      id: "task-current",
      label: `Tasks on checkout:${values.serviceRevision}`,
      kind: "service",
      role: "instance",
      health: currentHealth,
      utilization: clamp(values.currentTasks / TASK_COUNT),
      sublabel: `${values.currentTasks} of ${TASK_COUNT} tasks`,
      detail:
        values.launchFailures > 0
          ? "No task can launch because the service revision is not registered. The existing tasks stay on the previous valid revision."
          : `These tasks launched from checkout:${values.serviceRevision}. Image, CPU, memory, environment, volumes, and IAM came from that revision.`,
      meta: { revision: values.serviceRevision, tasks: values.currentTasks },
    },
    {
      id: "task-previous",
      label: values.hasPrevious ? `Tasks on checkout:${values.previousRevision}` : "No previous revision",
      kind: "service",
      role: "instance",
      health: previousHealth,
      utilization: clamp(values.previousTasks / TASK_COUNT),
      sublabel: values.hasPrevious
        ? `${values.previousTasks} of ${TASK_COUNT} tasks`
        : `checkout:${values.serviceRevision} is the first revision`,
      detail: !values.hasPrevious
        ? `checkout:${values.serviceRevision} is the first revision in this family, so there is no older revision for tasks to mix with.`
        : values.launchFailures > 0
          ? `These tasks remain on checkout:${values.previousRevision}, the latest ACTIVE revision, while the service points at an unregistered revision.`
          : `These tasks are older than the service revision. If the environment changed in checkout:${values.serviceRevision}, these tasks hold the previous values until they are replaced.`,
      meta: { revision: values.hasPrevious ? values.previousRevision : 0, tasks: values.previousTasks },
    },
    {
      id: "latest",
      label: `checkout:${values.latestRevision}`,
      kind: "service",
      health: "ok",
      sublabel: "latest ACTIVE revision",
      detail: `Registering checkout:${values.latestRevision} creates an immutable revision. It does not update a service, a standalone task, or a scheduled task that pins another revision.`,
      meta: { latest: values.latestRevision },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge(
        "service-current",
        "service",
        "task-current",
        values.currentTasks / TASK_COUNT,
        currentHealth,
        "deploys",
      ),
      edge(
        "service-previous",
        "service",
        "task-previous",
        values.previousTasks / TASK_COUNT,
        previousHealth,
        "still running",
      ),
      edge("latest-service", "latest", "service", 0.15, "warn", "not deployed"),
    ],
    metrics: [
      metric("revision-gap", "Service revision behind latest", values.gap, "", 1, 2, "count"),
      metric("mixed-revision", "Minority share on the other revision", values.mixedMinority, "%", 1, 20, "percent"),
      metric("previous-share", "Tasks on the previous revision", values.previousShare, "%", undefined, undefined, "percent"),
      metric("launch-failures", "Task launches failing", values.launchFailures, "%", 1, 5, "percent"),
      metric("stale-tasks", "Tasks older than the latest revision", values.stale, "%", undefined, undefined, "percent"),
      metric("service-revision", "Service revision", values.serviceRevision, "", undefined, undefined, "count"),
      metric("latest-revision", "Latest ACTIVE revision", values.latestRevision, "", undefined, undefined, "count"),
      metric("running-tasks", "Running tasks", TASK_COUNT, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Service pins checkout:${values.serviceRevision}; latest ACTIVE is checkout:${values.latestRevision}; ${values.currentTasks} tasks on the service revision, ${values.previousTasks} on the previous one.`,
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
    id: "revision-gap",
    metricId: "revision-gap",
    warn: 1,
    crit: 2,
    title: "The service is running behind the latest task definition",
    cause:
      "Registering a task definition revision creates a new immutable revision but does not update the service. The service still stores the family and revision it was created or last updated with.",
    fix:
      "Decide whether the new revision is meant for this service. If it is, update the service with the new revision and watch the deployment. If it is not, pin the intended revision explicitly and document it.",
    checkFirst: [
      "Compare the task definition ARN on a running task with the service's task definition.",
      "Describe the service and look at taskDefinition, deployments, and rolloutState.",
      "Check whether the change was registered but never applied, or applied to a different service.",
    ],
  },
  {
    id: "mixed-revision",
    metricId: "mixed-revision",
    warn: 1,
    crit: 20,
    title: "Tasks from two revisions are serving together",
    cause:
      "A rollout replaced only part of the fleet. The older tasks carry the previous environment, image, or resource values, so two supposedly identical tasks can behave differently.",
    fix:
      "Finish or roll back the deployment so one revision serves traffic. If the old tasks cannot be replaced yet, verify that the mixed configuration is compatible and drain the old tasks deliberately.",
    checkFirst: [
      "Compare environment variables and image digests on an old task and a new task.",
      "Check the service deployment state and the number of running tasks per revision.",
      "Look for a failed deployment or a service that hit its maximumPercent limit.",
    ],
  },
  {
    id: "launch-failures",
    metricId: "launch-failures",
    warn: 1,
    crit: 5,
    title: "The service points at a revision that cannot be used",
    cause:
      "The service revision is newer than the latest registered revision in this model, so the revision is not available. A real launch fails when the revision is deregistered, the image cannot be pulled, or the execution role cannot read it.",
    fix:
      "Point the service at an ACTIVE revision, or register the missing revision. Then confirm the image, execution role, and log configuration before retrying the deployment.",
    checkFirst: [
      "Describe the task definition and confirm its status is ACTIVE.",
      "Check the service event message for the placement or image pull failure.",
      "Check the execution role's access to the image and log group.",
    ],
  },
];

export const taskDefinitionModel: SimModel = {
  id: "containers-task-definitions",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, compute(p));
    seedSeries(frame);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed, compute(p));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, values]) => [key, [...values]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The service stores checkout:${values.serviceRevision}. The newest ACTIVE revision is checkout:${values.latestRevision}; a gap of ${values.gap}.`,
      values.gap > 0
        ? "A new revision is not live until the service is updated. Registering it only adds a version to the family."
        : "The service and the newest revision agree. This is the state to verify before debugging environment drift.",
      values.launchFailures > 0
        ? `The service points at checkout:${values.serviceRevision}, which is newer than the latest ACTIVE revision checkout:${values.latestRevision}. No new task can launch; ${values.previousTasks} tasks remain on the latest valid revision.`
        : `About ${values.mixedMinority.toFixed(0)}% of tasks are on the minority revision, and ${values.previousShare.toFixed(0)}% are on the previous revision. Mixed revisions explain a task that behaves differently after a restart.`,
      `Environment variables live in the task definition revision, not in the service. Changing an environment value creates a new revision and a new deployment.`,
      "A task launch resolves the revision to an image digest and a set of task settings. The running task keeps that revision until it is replaced.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Revision drift", tone: "warn" },
    { label: "Mismatched tasks", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "The service and the newest ACTIVE revision are both checkout:8.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Revision registered",
    description: "checkout:9 is registered, but the service still pins checkout:8. The change is not live.",
    tone: "warn",
    params: defaults({ serviceRevision: 8, latestRevision: 9, replacedPercent: 100 }),
  },
  {
    id: "failure",
    label: "Mixed environment",
    description: "A partial rollout leaves 40% of tasks on checkout:7 while the service revision is checkout:8.",
    tone: "crit",
    params: defaults({ serviceRevision: 8, latestRevision: 9, replacedPercent: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The service is updated to checkout:9 and every task has been replaced.",
    tone: "ok",
    params: defaults({ serviceRevision: 9, latestRevision: 9, replacedPercent: 100 }),
  },
];

const experiment: Experiment = {
  id: "trace-launch-revision",
  title: "Trace a task back to its revision",
  simId: "task-definitions",
  question:
    "The service runs checkout:7. A colleague registers checkout:9, then restarts one task. Which environment does the restarted task receive?",
  prediction: {
    options: [
      { id: "latest", label: "The checkout:9 environment, because it is the latest revision" },
      { id: "pinned", label: "The checkout:7 environment, because the service still pins that revision" },
      { id: "merged", label: "A merge of both environments, resolved at launch" },
      { id: "none", label: "No environment, because the task must be re-registered first" },
    ],
    correctOptionId: "pinned",
    explanation:
      "A service stores a specific task definition ARN. Registering a new revision adds a version to the family; it does not change the service. The restarted task launches from checkout:7 and receives that revision's environment.",
  },
  setup: defaults({ serviceRevision: 7, latestRevision: 9, replacedPercent: 100 }),
  runFor: 12,
  observe: [
    "The service revision is 7 and the latest ACTIVE revision is 9, a gap of 2.",
    "Every running task is on checkout:7, so the environment matches the last run of that revision.",
    "checkout:9 is healthy as a revision but receives no traffic from this service.",
    "The service becomes current only after an update that points it at checkout:9.",
  ],
  explain:
    "The immutable unit is the revision. Image, CPU, memory, environment variables, volumes, and IAM are read from the revision when a task launches. A new revision is a candidate, not a deployment. Updating the service is the step that starts a new deployment and replaces the pinned revision.",
  fix: defaults({ serviceRevision: 9, latestRevision: 9, replacedPercent: 100 }),
  debrief:
    "After the service is updated to checkout:9, the gap is zero and every task launches from the same revision. The tradeoff is deliberate: pinning makes a deployment reproducible and auditable, but it also means a new revision does nothing until someone updates the service. Treat the revision as a release artifact and make the service update part of the same release process.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A task definition is the blueprint for an Amazon Elastic Container Service (ECS) task: a JSON document that names the container image, CPU and memory, environment variables, volumes, ports, logging, and IAM roles. A task is one running instantiation of that blueprint. A service keeps a chosen number of tasks running.",
  },
  {
    type: "p",
    text: "A task definition belongs to a family, such as checkout, and each registration creates a new revision, such as checkout:8. Revisions are immutable: you do not edit revision 8, you register revision 9 with the fields you want to change. The family keeps both revisions, and a task launch always resolves to a specific revision and image.",
  },
  {
    type: "table",
    headers: ["Field", "What it controls", "What goes wrong when it drifts"],
    rows: [
      ["Image", "The container image and tag or digest that starts the task", "A task runs older code than the revision that was reviewed"],
      ["CPU and memory", "Task size and container limits used for placement and runtime", "A task is throttled or killed under a limit that was meant for another revision"],
      ["Environment", "Plaintext variables and references to Secrets Manager or SSM parameters", "A task connects to the wrong endpoint or uses an old credential reference"],
      ["Volumes and mounts", "Ephemeral or attached storage available to the containers", "A task starts without the data or scratch space it expects"],
      ["Task and execution roles", "AWS permissions for the workload and for image pulls and logs", "The task cannot read its input or the image cannot be pulled"],
    ],
  },
  {
    type: "p",
    text: "The important consequence is that a new revision is not a deployment. Registering checkout:9 creates a candidate. A service that stores checkout:8 keeps launching checkout:8 until the service is updated. That separation is useful for audit and rollback, and it is the usual explanation for a task that restarts with different environment variables than the task beside it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The task definition sits in the ECS control plane, between the container image in Amazon Elastic Container Registry (ECR) and the running task. The service scheduler reads the service's pinned revision, checks placement and capacity, and asks the container agent on the chosen instance to start the task. The agent pulls the image, creates the containers, and passes the environment, volumes, and role credentials from that revision.",
  },
  {
    type: "p",
    text: "A task definition revision is immutable, but it is not the only moving part. The image tag can point at a different digest, a secret reference can resolve to a new value, and an execution role can lose access to a log group. Those are separate signals from the revision number. When the task definition is right and the task still behaves differently, compare the resolved image digest and the secret version, not only family:revision.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Revision gap: how far the service's pinned revision is from the newest ACTIVE revision.",
      "Minority share on the other revision: how close the fleet is to an even split.",
      "Tasks on the previous revision: the share of running tasks that still hold older values.",
      "Launch failures: launches that cannot resolve an ACTIVE revision or pull the image.",
      "The service, current tasks, older tasks, and latest revision as separate nodes, so the mismatch is visible rather than averaged away.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Revision registered. The service stays on checkout:8 while checkout:9 exists. Apply Mixed environment to see two task groups serving together, then Recovery to update the service and replace the fleet. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "task-definitions" },
  { type: "experiment", experimentId: "trace-launch-revision" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The simulated service stored a specific revision, and a newer revision existed without being deployed. When part of the fleet had been replaced, tasks from two revisions served at once. The older tasks kept the image and environment from their own revision, so a restart could land on a different configuration than the task it replaced.",
  },
  {
    type: "p",
    text: "Updating the service to the newest revision removed the gap and the mixed environment. The model does not treat a registered revision as live, because ECS does not either: the service update is the action that starts the deployment.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`DescribeTasks` for a running task: taskDefinitionArn, startedBy, and the image digest actually in use.",
      "`DescribeServices`: taskDefinition, deployments, rolloutState, and the running versus desired count.",
      "`DescribeTaskDefinition`: the exact environment, secrets, CPU, memory, volumes, and roles in that revision.",
      "Service events: a failed launch or a deployment that cannot place tasks usually names the reason.",
      "ECR image details and CloudWatch Logs: the tag can move even when the revision does not.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the task definition ARN on the task that behaved differently with the ARN on a healthy task. Then describe the service and check whether a deployment is still in progress. Do not start by editing environment variables in the console; the revision is the source of truth.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the revision each task launched from, not only the service's latest revision.",
      "Decide whether the newer revision is intended for this service.",
      "Update the service to the chosen revision, or roll back to the last known good revision.",
      "Watch the deployment until every task is on one revision, then verify the environment on a running task.",
      "Record the revision, image digest, and secret versions in the release record.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Immutable revisions make rollback and audit possible, but they accumulate and need a retention policy.",
      "Pinning a revision makes a deployment reproducible, but a new revision does nothing until the service is updated.",
      "Using a mutable tag such as latest can make two tasks with the same revision run different code.",
      "Injecting secrets at launch avoids baking them into the image, but the secret version becomes another input to reproduce.",
      "Updating the service in place is simple, but a partial rollout creates a window where two configurations serve together.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "revision-immutable",
    question:
      "A service is running checkout:8. An engineer registers checkout:9 with a new environment variable and restarts a task. Why does the task still have the old value?",
    difficulty: 1,
    hints: [
      "A service stores a task definition ARN, not a family name.",
      "Registration and deployment are separate actions.",
    ],
    answer:
      "The service is still pinned to checkout:8. Registering checkout:9 creates an immutable candidate revision, but it does not update the service or any standalone task that pins checkout:8. The restarted task launches from checkout:8 and gets that revision's environment. I would confirm the task definition ARN on the task, update the service to checkout:9 if that is the intent, and watch the deployment until the old tasks are replaced.",
    followUps: [
      "What changes if the service was created without a revision number?",
      "How would you prove which image digest a task is running?",
      "What happens to a running task when its revision is deregistered?",
    ],
    redFlags: [
      "Assumes the latest revision is automatically deployed.",
      "Edits the running task instead of the service.",
      "Ignores the difference between a task and a service.",
    ],
    rubric: [
      "Separates registration from deployment.",
      "Names the pinned revision as the cause.",
      "Checks the task definition ARN.",
      "States the corrective service update.",
    ],
  },
  {
    id: "mixed-fleet",
    question:
      "During a deployment, half the tasks run revision 8 and half run revision 7. The error rate is low but two tasks behave differently. How do you debug it?",
    difficulty: 2,
    hints: [
      "Two revisions can have different images, environments, and resource limits.",
      "A deployment that has not completed is not the same as a healthy steady state.",
    ],
    answer:
      "I would treat the fleet as two populations and compare them directly: task definition ARN, image digest, environment, CPU and memory, and IAM role on one task from each revision. Then I would check the service deployment state and why it has not completed, such as a failing health check or a capacity limit. If the new revision is wrong, roll back; if it is right, finish the rollout and drain the old tasks. I would not change a shared environment variable in place, because that would create a third configuration.",
    followUps: [
      "Which signal tells you the deployment is stuck rather than slow?",
      "How does maximumPercent affect the number of mixed tasks?",
      "What would you check if both revisions look identical?",
    ],
    redFlags: [
      "Restarts tasks at random without comparing revisions.",
      "Changes the service's environment outside the task definition.",
      "Assumes a low error rate means the two revisions are equivalent.",
    ],
    rubric: [
      "Compares revision-level fields.",
      "Checks deployment state and capacity.",
      "Chooses rollback or completion deliberately.",
      "Avoids unmanaged configuration drift.",
    ],
  },
  {
    id: "rollback-safety",
    question:
      "You need to roll back a service to a previous task definition revision. What must be true for the rollback to be safe?",
    difficulty: 2,
    hints: [
      "The old revision must still be usable.",
      "The image, secrets, and data schema may have moved on.",
    ],
    answer:
      "The previous revision must still be ACTIVE or available to the service, the image digest it references must still exist, and its environment and secret references must still resolve. I would also check compatibility with any schema or message-format change the new revision made, because rolling back the task definition does not roll back data. I would verify capacity and health checks before shifting the whole service, and I would keep the failing revision for investigation rather than deleting it.",
    followUps: [
      "What happens if the old revision was deregistered?",
      "Can a rollback be unsafe even when the image still exists?",
      "How would you test the rollback path before you need it?",
    ],
    redFlags: [
      "Assumes every old revision is still deployable.",
      "Ignores schema or secret changes.",
      "Deletes the failing revision before investigating.",
    ],
    rubric: [
      "Checks revision and image availability.",
      "Checks secrets and data compatibility.",
      "Verifies capacity and health.",
      "Preserves evidence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "The task definition revision is registered and its image digest is recorded.",
      "Environment and secret references are reviewed in the revision, not in a console override.",
      "The service is updated to the intended revision as part of the release.",
      "A previous ACTIVE revision and its image are available for rollback.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch the service deployment state and the task count per revision.",
      "Compare a new task with an old task on revision, image digest, and environment.",
      "Check service events for placement, image pull, or health check failures.",
      "Do not treat a registered revision as deployed until the service points at it.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Confirm every running task uses one revision and one image digest.",
      "Record the revision, digest, and secret versions in the release record.",
      "Deregister or retire old revisions according to the retention policy.",
      "Add the failure mode to the next rollout checklist.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS task definitions",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definitions.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The task definition as a JSON blueprint and the relationship between tasks and services.",
  },
  {
    title: "Amazon ECS task definition states",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-definition-state.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "ACTIVE and INACTIVE revisions, deregistration, and the effect on new tasks.",
  },
  {
    title: "Updating an Amazon ECS task definition",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/update-task-definition-console-v2.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Creating a revision and the required service update.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "task-definitions": {
      model: taskDefinitionModel,
      presets,
      instructions:
        "Start Healthy, apply Revision registered, then Mixed environment. Compare the service revision with the tasks that are actually running, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Ten tasks and twelve revision numbers are teaching values, not ECS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-services",
    "containers-logs",
    "containers-ecs-exec",
    "containers-cpu-memory-limits",
  ],
};
