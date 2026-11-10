import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DAY_MINUTES = 1_440;
const SCHEDULER_NAMES = ["ECS service scheduler", "EventBridge Scheduler", "AWS Batch scheduler"];

const params: ParamSpec[] = [
  {
    id: "scheduler",
    label: "Scheduler",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Workload",
    help: "0 runs the job as an ECS service with a desired count. 1 runs it once on a schedule with RunTask. 2 submits it to an AWS Batch job queue with retries.",
    format: "count",
  },
  {
    id: "jobMinutes",
    label: "Job runtime",
    min: 10,
    max: 120,
    step: 5,
    value: 30,
    unit: " min",
    group: "Workload",
    help: "How long one execution takes. A service replaces the task when it exits, so a short job restarts more often in the same night.",
    format: "number",
  },
  {
    id: "maxAttempts",
    label: "Retry limit",
    min: 0,
    max: 5,
    step: 1,
    value: 2,
    unit: "",
    group: "Retries",
    help: "Additional attempts after a failed run. In this model the job hits one transient failure, so zero retries leaves the nightly run incomplete.",
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
  scheduler: number;
  schedulerName: string;
  jobMinutes: number;
  maxAttempts: number;
  runsPerNight: number;
  restarts: number;
  attemptsUsed: number;
  completion: number;
  idleHours: number;
  taskHours: number;
  relativeCost: number;
}

function compute(p: Params): Values {
  const scheduler = Math.round(clamp(num(p, "scheduler", 2), 0, 2));
  const jobMinutes = clamp(num(p, "jobMinutes", 30), 10, 120);
  const maxAttempts = Math.round(clamp(num(p, "maxAttempts", 2), 0, 5));
  const runsPerNight = scheduler === 0 ? Math.max(1, Math.floor(DAY_MINUTES / jobMinutes)) : 1;
  const restarts = Math.max(0, runsPerNight - 1);
  const attemptsUsed = scheduler === 0 ? runsPerNight : Math.min(maxAttempts + 1, 2);
  const completion = scheduler === 0 ? 0 : maxAttempts >= 1 ? 100 : 0;
  const idleHours = scheduler === 0 ? Math.max(0, 24 - jobMinutes / 60) : 0;
  const taskHours = scheduler === 0 ? 24 : (jobMinutes / 60) * attemptsUsed;
  return {
    scheduler,
    schedulerName: SCHEDULER_NAMES[scheduler],
    jobMinutes,
    maxAttempts,
    runsPerNight,
    restarts,
    attemptsUsed,
    completion,
    idleHours,
    taskHours,
    relativeCost: (taskHours / 24) * 100,
  };
}

function healthOf(values: Values): Health {
  if ((values.restarts >= 2 && values.jobMinutes < 60) || values.restarts >= 12 || (values.scheduler !== 0 && values.completion === 0)) {
    return "crit";
  }
  if (values.restarts >= 2 || values.idleHours >= 18 || values.completion === 0) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const completionHealth: Health = values.completion === 100 ? "ok" : values.scheduler === 0 ? "warn" : "crit";
  const runtimeHealth: Health = values.idleHours >= 23 ? "crit" : values.idleHours >= 18 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "scheduler",
      label: values.schedulerName,
      kind: "service",
      health,
      utilization: clamp(values.restarts / Math.max(1, values.runsPerNight)),
      sublabel:
        values.scheduler === 0
          ? "maintains desired count 1"
          : values.scheduler === 1
            ? "one run per night"
            : "job queue with retries",
      detail:
        values.scheduler === 0
          ? "The service treats the task as a long-running process. When the job exits, the service sees a missing task and starts another one, even after a successful run."
          : values.scheduler === 1
            ? "RunTask starts one task for this execution. There is no desired count to reconcile, so a completed task stays completed."
            : "AWS Batch owns the job lifecycle, including the queue, attempts, and dependencies. A completed job stays completed and reports its exit status.",
      meta: { scheduler: values.scheduler, restarts: values.restarts },
    },
    {
      id: "job",
      label: "nightly-report",
      kind: "worker",
      health,
      utilization: clamp(values.runsPerNight / 48),
      sublabel:
        values.scheduler === 0
          ? `${values.runsPerNight} runs · ${values.restarts} restarts`
          : `${values.attemptsUsed} attempt${values.attemptsUsed === 1 ? "" : "s"} · ${values.completion}% complete`,
      detail:
        values.scheduler === 0
          ? `The job takes ${values.jobMinutes} minutes. A service replaces it when it exits, so it runs ${values.runsPerNight} times in a day and never reaches a terminal success state. Any side effect is repeated unless the job is idempotent.`
          : `The job takes ${values.jobMinutes} minutes. It runs once and records a terminal outcome. ${values.maxAttempts === 0 ? "With no retries, the simulated transient failure ends the run." : "The retry limit covers the simulated transient failure."}`,
      meta: { runs: values.runsPerNight, completion: values.completion },
    },
    {
      id: "completion",
      label: "Completion record",
      kind: "storage",
      health: completionHealth,
      utilization: values.completion / 100,
      sublabel: values.completion === 100 ? "success recorded" : "no terminal success",
      detail:
        values.completion === 100
          ? "The run has a terminal success. A scheduler or operator can tell that the work is done and can stop retrying."
          : values.scheduler === 0
            ? "A service never records a terminal success for a finite job. The task exits, the service replaces it, and the next run begins. Restart count is not the same as job success."
            : "The run failed and the retry limit is exhausted. The job remains failed until an operator intervenes.",
      meta: { completion: values.completion },
    },
    {
      id: "runtime",
      label: "Runtime cost",
      kind: "external",
      health: runtimeHealth,
      utilization: clamp(values.relativeCost / 100),
      sublabel: `${values.taskHours.toFixed(1)} task-hours/night`,
      detail:
        values.scheduler === 0
          ? `The service keeps a task running for the whole day, so it pays for ${values.taskHours.toFixed(1)} task-hours per night even when the job is idle.`
          : `The job pays for ${values.taskHours.toFixed(1)} task-hours per night, including ${values.attemptsUsed === 1 ? "one attempt" : "the attempts used"}.`,
      meta: { taskHours: values.taskHours },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("scheduler-job", "scheduler", "job", 1, health, "runs"),
      edge("job-completion", "job", "completion", values.completion / 100, completionHealth, "records"),
      edge("job-runtime", "job", "runtime", clamp(values.taskHours / 24), runtimeHealth, "costs"),
    ],
    metrics: [
      metric("unexpected-runs", "Unexpected runs per night", values.restarts, " runs", 2, 12, "count"),
      metric("idle-hours", "Idle task-hours per night", values.idleHours, " h", 18, 23, "number"),
      metric("runs-per-night", "Runs per night", values.runsPerNight, " runs", undefined, undefined, "count"),
      metric("task-hours", "Task-hours per night", values.taskHours, " h", undefined, undefined, "number"),
      metric("completion", "Terminal completion", values.completion, "%", undefined, undefined, "percent"),
      metric("attempts", "Attempts used", values.attemptsUsed, " attempts", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, scheduler: values.scheduler, restarts: values.restarts },
    summary: `${values.schedulerName}; ${values.runsPerNight} run(s) per night; ${values.restarts} unexpected restart(s); ${values.completion}% terminal completion.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.5) * Math.max(0.1, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unexpected-runs",
    metricId: "unexpected-runs",
    warn: 2,
    crit: 12,
    title: "A finite job keeps running after it exits",
    cause:
      "The workload is an ECS service with a desired count. A service is a reconciler: it replaces any task that stops, even when the task stopped successfully. A nightly job therefore runs again immediately instead of waiting for the next schedule.",
    fix:
      "Run the job once with RunTask on a schedule, or submit it to AWS Batch when it needs a queue, retries, or dependencies. Set the schedule to the intended cadence and record completion. Keep a service only for work that is supposed to run continuously.",
    checkFirst: [
      "Check the scheduler type and whether a desired count is set.",
      "Compare task start times with the intended nightly schedule.",
      "Look for repeated side effects such as duplicate reports, emails, or rows.",
    ],
  },
  {
    id: "idle-hours",
    metricId: "idle-hours",
    warn: 18,
    crit: 23,
    title: "The task is paid for while the job is idle",
    cause:
      "A service keeps one task running all day to preserve the desired count. If the actual work takes minutes, most of the task-hours are idle. The cost is invisible when the service is judged only by availability.",
    fix:
      "Use a scheduled standalone task or a Batch job that exits when the work is done. Size the timeout and retry policy for the real runtime, and alert on failed or missing runs rather than on a continuously running task.",
    checkFirst: [
      "Compare the task's CPU and memory during the job window with the rest of the day.",
      "Check whether the task is idle but still counted as running.",
      "Compare the intended schedule with the observed run interval.",
    ],
  },
];

export const batchServiceModel: SimModel = {
  id: "containers-batch-vs-service",
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
      `The workload uses ${values.schedulerName} and takes ${values.jobMinutes} minutes per run.`,
      values.scheduler === 0
        ? `A service replaces the task every time it exits, so the job runs ${values.runsPerNight} times per night instead of once.`
        : `The job runs once per night and records a terminal outcome. ${values.maxAttempts} retries ${values.maxAttempts === 1 ? "covers" : "cover"} the simulated transient failure.`,
      values.completion === 100
        ? "Completion is recorded, so an operator can distinguish a finished run from a failed or missing one."
        : "There is no terminal success. A restart loop can look busy while the work is never marked done.",
      values.scheduler === 0
        ? `The service pays for ${values.taskHours.toFixed(1)} task-hours per night even though the job needs ${(values.jobMinutes / 60).toFixed(1)} hours.`
        : `The job pays only for the attempts it uses, about ${values.taskHours.toFixed(1)} task-hours per night.`,
      "A service is the right scheduler for a long-running server. It is the wrong scheduler for a finite job with a completion condition.",
    ];
  },
  legend: [
    { label: "Terminal and retried", tone: "ok" },
    { label: "Long-running or idle", tone: "warn" },
    { label: "Restart loop", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "An AWS Batch job takes 30 minutes, records completion, and has two retries for a transient failure.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Long job as a service",
    description: "A 120-minute job runs as a service. It restarts 11 times per night and idles for 22 hours.",
    tone: "warn",
    params: defaults({ scheduler: 0, jobMinutes: 120, maxAttempts: 2 }),
  },
  {
    id: "failure",
    label: "Nightly job as a service",
    description: "A 30-minute report runs as a service, so it restarts 47 times and never records completion.",
    tone: "crit",
    params: defaults({ scheduler: 0, jobMinutes: 30, maxAttempts: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The report moves to AWS Batch, runs once, and succeeds on its retry.",
    tone: "ok",
    params: defaults({ scheduler: 2, jobMinutes: 30, maxAttempts: 2 }),
  },
];

const experiment: Experiment = {
  id: "after-successful-exit",
  title: "Predict the next action",
  simId: "batch-vs-service",
  question:
    "A nightly report runs as an ECS service with desired count 1. The report takes 45 minutes and exits successfully. What does the service do next?",
  prediction: {
    options: [
      { id: "wait", label: "Waits until the next scheduled night before starting another task" },
      { id: "restart", label: "Starts another task immediately to keep the desired count at 1" },
      { id: "scale", label: "Scales to zero because the job is complete" },
      { id: "fail", label: "Marks the service failed because the task exited" },
    ],
    correctOptionId: "restart",
    explanation:
      "A service reconciles desired count, not job completion. When the task exits successfully, the running count falls below the desired count, so the scheduler starts a replacement. The report runs again immediately, about 32 times in a day, and never reaches a terminal success state.",
  },
  setup: defaults({ scheduler: 0, jobMinutes: 45, maxAttempts: 2 }),
  runFor: 20,
  observe: [
    "The service reports 32 runs per night and 31 unexpected restarts.",
    "The completion node stays at zero because the service never records a terminal success.",
    "The task-hours metric stays at 24 hours even though each report takes 45 minutes.",
    "Moving the workload to AWS Batch or a scheduled RunTask produces one run and a completion record.",
  ],
  explain:
    "The scheduler choice defines the lifecycle. A service is level-triggered: it compares desired and running tasks and acts on the difference. A standalone task is edge-triggered: it runs once and exits. AWS Batch adds a queue, attempt tracking, and dependency handling on top of that one-shot model. A finite job needs a terminal state, not a desired count.",
  fix: defaults({ scheduler: 2, jobMinutes: 45, maxAttempts: 2 }),
  debrief:
    "The Batch job runs once, uses one retry for the transient failure, and records completion. The tradeoff is another scheduler to operate and a different observability surface: job status and attempts instead of service deployment events. That surface is the point. A job that reports success and stops is easier to trust than a service that restarts every 45 minutes and calls the activity availability.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Elastic Container Service (ECS) can run a container in more than one lifecycle. A service keeps a desired number of tasks running. A standalone task runs once, either directly with RunTask or on a schedule. AWS Batch adds a job queue, attempt tracking, and dependencies on top of the same container primitives. The scheduler decides whether completion is a terminal state or just another reason to start a replacement.",
  },
  {
    type: "p",
    text: "A service is a reconciler. It compares the desired count with the running count and starts or stops tasks to close the gap. That is exactly what a web server needs. It is wrong for a nightly report: when the report exits successfully, the running count drops below desired, so the service starts another one. The job runs again immediately, repeats any side effects, and never records a terminal success.",
  },
  {
    type: "compare",
    leftTitle: "Service",
    rightTitle: "Standalone task or Batch job",
    rows: [
      { label: "Lifecycle", left: "Keeps desired count running", right: "Runs to completion" },
      { label: "After success", left: "Starts a replacement", right: "Records success and stops" },
      { label: "Retries", left: "Task replacement, potentially forever", right: "Bounded attempts or scheduler policy" },
      { label: "Best for", left: "Long-running servers and workers", right: "Finite jobs, reports, and scheduled work" },
      { label: "Main signal", left: "Desired versus running count", right: "Job status, exit code, and attempts" },
    ],
  },
  {
    type: "p",
    text: "The distinction is not about the container image. The same image can run as a service or as a batch job. It is about what should happen when the process exits. A server should be replaced. A report should be marked done. If the workload has a natural completion condition, give it a scheduler that understands completion.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A service sits behind the ECS service scheduler, which also handles deployments and load balancer registration. A scheduled standalone task sits behind EventBridge Scheduler or a similar trigger that calls RunTask. AWS Batch sits in front of a job queue and computes the environment, then submits work to ECS. The observability follows the scheduler: service events and deployment state for a service, task stop codes for a standalone task, and job status plus attempt count for Batch.",
  },
  {
    type: "p",
    text: "Retries are part of the same decision. A service will replace a task indefinitely, which can hide a deterministic failure. A standalone task has no built-in retry unless the trigger or the caller adds one. AWS Batch tracks attempts and can retry a failed job up to a configured limit. Whichever path you choose, the work must be safe to retry: duplicate reports, emails, or database writes are the real cost of a restart loop.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unexpected runs per night: how many extra executions the scheduler starts.",
      "Idle task-hours: time paid for while the job is not doing work.",
      "Terminal completion: whether the workload can report that it finished.",
      "Attempts used: how many tries the retry policy consumed.",
      "Task-hours per night: the illustrative cost of the chosen lifecycle.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Long job as a service to see the idle cost. Apply Nightly job as a service to see the restart loop, then Recovery to move the report to AWS Batch. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "batch-vs-service" },
  { type: "experiment", experimentId: "after-successful-exit" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The service kept replacing the report after every successful exit. The desired count stayed satisfied, so the control plane looked healthy, while the job ran dozens of times and never reached a terminal success. The cost model paid for a full day of task time for less than an hour of work. The same behavior would duplicate any non-idempotent side effect.",
  },
  {
    type: "p",
    text: "The recovery preset moved the report to AWS Batch. It ran once, used a retry for the simulated transient failure, and recorded completion. The job stopped when the work was done, and the cost followed the runtime instead of the calendar.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Service task start times that repeat far more often than the intended schedule.",
      "A running task all day with low CPU and memory outside the job window.",
      "No terminal job status, only a service that keeps replacing tasks.",
      "Duplicate reports, notifications, or rows that share the same run identifier.",
      "A failed standalone or Batch job that stops instead of restarting forever.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Look at the scheduler, not the application logs. If the workload has a desired count, ask why a finite job needs one. Then compare task start times with the intended cadence and check whether the job has an idempotency key for the side effects it repeats.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Decide whether the workload is continuous or finite.",
      "For a finite job, remove the desired count and run it with RunTask on a schedule or through AWS Batch.",
      "Set a retry limit that matches the failure modes and the job's idempotency.",
      "Record a terminal status and alert on missing or failed runs.",
      "Verify the schedule and the first successful run, then remove the old service.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A service is simple and self-healing for long-running work, and it is the wrong lifecycle for a finite job.",
      "A scheduled standalone task is lightweight, with less built-in retry and dependency handling than Batch.",
      "AWS Batch adds queueing, attempts, and dependencies, with another service to operate and monitor.",
      "A retry limit prevents infinite loops and can leave a failed job waiting for an operator.",
      "Idempotency makes retries safe and adds work to the application design.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "service-restart",
    question:
      "A nightly report runs as an ECS service and restarts after every successful run. Why, and what would you change?",
    difficulty: 1,
    hints: [
      "A service reconciles desired count.",
      "Exit code does not change the service's goal.",
    ],
    answer:
      "The service is doing its job: it keeps one task running. When the report exits, the running count falls below desired, so the scheduler starts a replacement. The exit code does not make the service treat the work as complete. I would remove the service and run the report as a scheduled standalone task or an AWS Batch job, set a retry limit, and record completion. Then I would check for duplicate side effects from the runs that already happened.",
    followUps: [
      "What signal would tell you the report actually succeeded?",
      "How would you clean up duplicate side effects?",
      "When would a service still be the right choice?",
    ],
    redFlags: [
      "Changes the restart policy without changing the scheduler.",
      "Ignores duplicate side effects.",
      "Treats a running task as a successful job.",
    ],
    rubric: [
      "Explains desired-count reconciliation.",
      "Chooses a completion-aware scheduler.",
      "Adds bounded retries and a success signal.",
      "Checks for duplicate effects.",
    ],
  },
  {
    id: "choose-scheduler",
    question:
      "Compare a scheduled RunTask, an ECS service, and AWS Batch for a nightly data export.",
    difficulty: 2,
    hints: [
      "One is continuous, one is a single run, one adds a queue and attempts.",
      "Match the scheduler to the failure and dependency requirements.",
    ],
    answer:
      "A scheduled RunTask is enough for a single export with no queue or dependency graph: the trigger starts one task and the task records its exit. A service is for continuous work and would restart the export after completion, so it does not fit. AWS Batch fits when the export needs a queue, bounded attempts, dependencies, or array-style work, at the cost of another scheduler and job definitions. I would choose the smallest lifecycle that gives a terminal status and the retry behavior the export needs.",
    followUps: [
      "What does Batch add beyond RunTask?",
      "How would you handle a failed export that must not be skipped?",
      "Where would the completion alert come from in each option?",
    ],
    redFlags: [
      "Uses a service for a finite job.",
      "Adds Batch without needing queueing or retries.",
      "Has no completion or failure signal.",
    ],
    rubric: [
      "Matches lifecycle to workload.",
      "Names the tradeoffs of each option.",
      "Requires a terminal signal.",
      "Keeps retries bounded.",
    ],
  },
  {
    id: "retry-idempotency",
    question:
      "A batch job retries after a timeout and sends the report email twice. How do you fix the retry path?",
    difficulty: 3,
    hints: [
      "The timeout may have happened after the side effect.",
      "Retries need a stable idempotency key.",
    ],
    answer:
      "I would make the side effect idempotent with a stable key for the run, such as the job ID plus the report date, and have the email or downstream system deduplicate on that key. I would also record the step's completion before acknowledging it, so a retry can skip work that already succeeded. Then I would set the retry limit and timeout to match the real runtime. Retrying without idempotency just repeats the side effect more reliably.",
    followUps: [
      "Where should the idempotency key be generated?",
      "What if the downstream system cannot deduplicate?",
      "How would you test the timeout-after-send case?",
    ],
    redFlags: [
      "Disables retries entirely.",
      "Assumes the timeout means the side effect did not happen.",
      "Uses a random key per attempt.",
    ],
    rubric: [
      "Identifies the ambiguous timeout.",
      "Adds a stable idempotency key.",
      "Records progress before acknowledging.",
      "Tests the duplicate path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the workload ships",
    items: [
      "The workload is classified as continuous or finite.",
      "A finite job uses a schedule or Batch, not a desired count.",
      "The retry limit and timeout match the real runtime.",
      "Every side effect is idempotent or deduplicated.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Check the scheduler type and the desired count.",
      "Compare task start times with the intended schedule.",
      "Look for duplicate side effects across runs.",
      "Check whether a failed job stopped or is restarting forever.",
    ],
  },
  {
    title: "After the fix",
    items: [
      "Confirm a terminal success or a bounded failure.",
      "Alert on missing runs as well as failed runs.",
      "Remove the old service and its unused capacity.",
      "Record the new schedule, retry policy, and completion signal.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS scheduled tasks",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/scheduled_tasks.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Running a task on a schedule and the difference from a service with a desired count.",
  },
  {
    title: "Amazon ECS standalone tasks",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/standalone-tasks.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "RunTask and StartTask lifecycles for work that runs once.",
  },
  {
    title: "What is AWS Batch?",
    url: "https://docs.aws.amazon.com/batch/latest/userguide/what-is-batch.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Job queues, attempt tracking, and managed scheduling for batch workloads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "batch-vs-service": {
      model: batchServiceModel,
      presets,
      instructions:
        "Start Healthy, then apply Long job as a service. Apply Nightly job as a service to see the restart loop, then Recovery to move the report to AWS Batch. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 47-restart figure, the task-hour costs, and the single transient failure are teaching values, not AWS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-services",
    "containers-task-definitions",
    "containers-logs",
    "containers-deployment-circuit-breaker",
  ],
};
