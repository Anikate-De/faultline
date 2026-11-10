import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ACTIVE_TASKS = 3;
const CLIENT_TIMEOUT_SEC = 10;
const PRICE_PER_TASK_HOUR = 0.06;
const HOURS_PER_MONTH = 730;

const params = [
  {
    id: "minimumTasks",
    label: "Minimum tasks",
    min: 0,
    max: 3,
    step: 1,
    value: 1,
    unit: " tasks",
    group: "Policy",
    help: "Floor that stays running when the environment is idle. Zero allows scale-to-zero.",
    format: "count" as const,
  },
  {
    id: "idleWindowMin",
    label: "Idle window before zero",
    min: 5,
    max: 120,
    step: 5,
    value: 30,
    unit: " min",
    group: "Policy",
    help: "How long the environment waits after the last request before scaling to zero. A short window also lets it zero during a one-hour lunch gap.",
    format: "number" as const,
  },
  {
    id: "coldStartSec",
    label: "Cold start",
    min: 2,
    max: 180,
    step: 2,
    value: 20,
    unit: " s",
    group: "Wake-up",
    help: "Time from the first request to a ready task: scheduling, image pull, start, and health check. Illustrative.",
    format: "number" as const,
  },
  {
    id: "activeHoursPerDay",
    label: "Active hours per day",
    min: 2,
    max: 16,
    step: 1,
    value: 10,
    unit: " h",
    group: "Schedule",
    help: "Hours per day the environment is expected to serve work. The rest is idle capacity under an always-on policy.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  minimumTasks: number;
  idleWindowMin: number;
  coldStartSec: number;
  activeHours: number;
  canScaleToZero: boolean;
  lunchZeroed: boolean;
  coldStartsPerDay: number;
  taskHoursPerMonth: number;
  monthlyCostK: number;
  alwaysOnCostK: number;
  savingsK: number;
  wakeP99Ms: number;
  timeoutPct: number;
  taskUtilization: number;
}

function compute(p: Params): Computed {
  const minimumTasks = clamp(Math.round(num(p, "minimumTasks", 1)), 0, 3);
  const idleWindowMin = clamp(num(p, "idleWindowMin", 30), 1, 240);
  const coldStartSec = clamp(num(p, "coldStartSec", 20), 1, 600);
  const activeHours = clamp(num(p, "activeHoursPerDay", 10), 1, 24);
  const canScaleToZero = minimumTasks === 0;
  const lunchZeroed = canScaleToZero && idleWindowMin <= 60 && activeHours >= 5;
  const extraTasks = Math.max(0, ACTIVE_TASKS - minimumTasks);
  const lunchSaved = lunchZeroed ? extraTasks * 1 : 0;
  const taskHoursPerDay = minimumTasks * 24 + extraTasks * activeHours - lunchSaved;
  const taskHoursPerMonth = Math.max(0, taskHoursPerDay) * 30;
  const monthlyCostK = (taskHoursPerMonth * PRICE_PER_TASK_HOUR) / 1_000;
  const alwaysOnCostK = (ACTIVE_TASKS * 24 * 30 * PRICE_PER_TASK_HOUR) / 1_000;
  const coldStartsPerDay = canScaleToZero ? 1 + (lunchZeroed ? 1 : 0) : 0;
  return {
    minimumTasks,
    idleWindowMin,
    coldStartSec,
    activeHours,
    canScaleToZero,
    lunchZeroed,
    coldStartsPerDay,
    taskHoursPerMonth,
    monthlyCostK,
    alwaysOnCostK,
    savingsK: alwaysOnCostK - monthlyCostK,
    wakeP99Ms: canScaleToZero ? coldStartSec * 1_000 : 200,
    timeoutPct: canScaleToZero && coldStartSec > CLIENT_TIMEOUT_SEC ? 100 : 0,
    taskUtilization: clamp(taskHoursPerMonth / (ACTIVE_TASKS * HOURS_PER_MONTH)),
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.wakeP99Ms >= 30_000 || values.timeoutPct >= 5) return "crit";
  if (values.wakeP99Ms >= 5_000 || values.timeoutPct >= 1) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.03 * Math.sin((offset + (seed % 6)) / 2.6);
  const entries: [string, number, number][] = [
    ["wake-p99", values.wakeP99Ms, 60],
    ["wake-timeouts", values.timeoutPct, 0.1],
    ["monthly-cost", values.monthlyCostK, 0.04],
    ["cold-starts", values.coldStartsPerDay, 0.03],
    ["idle-savings", values.savingsK, 0.04],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.5 + value) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, state: { announced: boolean }): SimFrame {
  const v = compute(p);
  const health = healthFor(v);
  return {
    t: 0,
    nodes: [
      {
        id: "developer",
        label: "Developer client",
        kind: "client",
        health: v.timeoutPct > 0 ? "crit" : "ok",
        sublabel: `${CLIENT_TIMEOUT_SEC}s request timeout`,
        meta: { view: "flow" },
      },
      {
        id: "environment",
        label: "Dev environment",
        kind: "service",
        role: "instance",
        health,
        utilization: v.taskUtilization,
        capacity: ACTIVE_TASKS,
        sublabel: v.canScaleToZero ? `${v.minimumTasks} floor · scales to zero` : `${v.minimumTasks} floor · always warm`,
        detail: v.canScaleToZero
          ? `The first request after idle waits ${v.coldStartSec}s for a task. With a ${CLIENT_TIMEOUT_SEC}s client timeout, ${v.timeoutPct.toFixed(0)}% of those requests fail.`
          : `A floor of ${v.minimumTasks} task keeps the environment warm. Wake latency is about 200ms, and the floor bills around the clock.`,
        meta: { view: "flow" },
      },
      {
        id: "tasks",
        label: "Task definition",
        kind: "service",
        health: "ok",
        utilization: clamp(v.activeHours / 24),
        sublabel: `${v.activeHours}h active per day`,
        detail: "The task definition does not change when the last task stops. Only the running task count does.",
        meta: { view: "flow" },
      },
      {
        id: "state",
        label: "Local state",
        kind: "db",
        health: v.canScaleToZero ? "warn" : "ok",
        sublabel: v.canScaleToZero ? "lost on scale-in" : "kept by the floor",
        detail: "Anything written to the task's local disk disappears when the task stops. Durable state must live outside the task.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("developer-env", "developer", "environment", 0.4, health),
      edge("env-tasks", "environment", "tasks", clamp(v.activeHours / 24), "ok"),
      edge("env-state", "environment", "state", v.canScaleToZero ? 0.1 : 0.4, v.canScaleToZero ? "warn" : "ok"),
    ],
    metrics: [
      metric("wake-p99", "First-request latency after idle", v.wakeP99Ms, " ms", 5_000, 30_000, "ms"),
      metric("wake-timeouts", "First-request timeouts", v.timeoutPct, "%", 1, 5, "percent"),
      metric("monthly-cost", "Monthly environment cost", v.monthlyCostK, " k$", undefined, undefined, "number"),
      metric("idle-savings", "Savings versus always-on", v.savingsK, " k$/month", undefined, undefined, "number"),
      metric("cold-starts", "Cold starts per day", v.coldStartsPerDay, " starts", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      announced: state.announced ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${v.canScaleToZero ? "Scales to zero" : "Keeps a floor"}: ${v.coldStartsPerDay} cold start(s)/day, ${v.wakeP99Ms.toFixed(0)}ms first-request latency, ${v.monthlyCostK.toFixed(1)}k$/month. Cost figures illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, { announced: false });
  seedSeries(frame, compute(p), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "wake-p99",
    metricId: "wake-p99",
    warn: 5_000,
    crit: 30_000,
    title: "The first request after idle waits too long",
    cause:
      "The environment scaled to zero and the first request has to schedule a task, pull an image, start the process, and pass a health check. The idle policy saved money and moved the cost into the wake-up path.",
    fix:
      "Keep a floor of one task for latency-sensitive environments, reduce cold-start time with a smaller image and pre-pulled layers, or move the wake-up behind an asynchronous request that can tolerate the wait.",
    checkFirst: [
      "Compare the idle window with the client timeout.",
      "Check image size, start time, and health-check delay for the task.",
      "Check whether the service has a floor or a warm pool.",
    ],
  },
  {
    id: "wake-timeouts",
    metricId: "wake-timeouts",
    warn: 1,
    crit: 5,
    title: "The first request times out before the environment wakes",
    cause:
      "Cold-start time is longer than the client timeout. The request fails before a task is ready, and a retry starts the same wait again. Scale-to-zero saved idle cost and created a user-visible failure.",
    fix:
      "Raise the client timeout only if the product can wait, reduce cold start below the timeout, or keep a warm floor. A retry without a longer timeout repeats the cold start.",
    checkFirst: [
      "Check whether the errors are connection failures or gateway timeouts.",
      "Check the task start and health-check timestamps against the first request.",
      "Check whether the client retry has a deadline longer than the cold start.",
    ],
  },
  {
    id: "cold-starts",
    metricId: "cold-starts",
    warn: 2,
    crit: 4,
    title: "The environment is cold starting repeatedly",
    cause:
      "The idle window is shorter than the gaps between work, so the environment scales to zero during lunch and between short sessions. Each wake pays the start cost and adds a failure window.",
    fix:
      "Lengthen the idle window, schedule a warm window around working hours, or keep a floor during the hours people use the environment.",
    checkFirst: [
      "Check the idle window against the actual gaps between requests.",
      "Check whether a scheduled warm-up exists for core hours.",
      "Check how many first requests fail after each cold start.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const scaleToZeroModel: SimModel = {
  id: "capacity-scale-to-zero",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const values = compute(p);
    const announced = frame.flags.announced === 1;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), { announced });
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (!announced) {
      pushEvent(next, {
        id: "idle-policy",
        at: t,
        severity: values.timeoutPct > 0 ? "crit" : values.canScaleToZero ? "info" : "info",
        title: values.canScaleToZero ? "The environment is allowed to reach zero tasks" : "A floor keeps the environment warm",
        detail: values.canScaleToZero
          ? `The first request after idle waits ${values.coldStartSec}s against a ${CLIENT_TIMEOUT_SEC}s client timeout. ${values.coldStartsPerDay} cold start(s) per day, ${values.monthlyCostK.toFixed(1)}k$/month.`
          : `The floor of ${values.minimumTasks} task removes the cold start and bills ${values.monthlyCostK.toFixed(1)}k$/month. The savings versus always-on are ${values.savingsK.toFixed(1)}k$/month.`,
        nodeId: "environment",
        metricId: "wake-p99",
      });
    }
    if (values.timeoutPct > 0 && frame.flags.timeoutEvent !== 1) {
      pushEvent(next, {
        id: "first-request-timeout",
        at: t,
        severity: "crit",
        title: "The first request after idle times out",
        detail: `Cold start is ${values.coldStartSec}s and the client gives up after ${CLIENT_TIMEOUT_SEC}s. The retry repeats the cold start unless the timeout or the policy changes.`,
        nodeId: "developer",
        metricId: "wake-timeouts",
      });
    }

    next.flags.announced = 1;
    next.flags.timeoutEvent = values.timeoutPct > 0 ? 1 : frame.flags.timeoutEvent === 1 ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `The environment saves ${value("idle-savings").toFixed(1)}k$ per month and costs ${value("monthly-cost").toFixed(1)}k$.`,
    ];
    if (value("wake-p99") >= 5_000) {
      items.push(
        `The first request after idle waits ${(value("wake-p99") / 1_000).toFixed(0)}s; ${value("wake-timeouts").toFixed(0)}% time out at the client. The saving is real and the wake-up is a product decision.`,
      );
    }
    items.push(
      "A floor of one task trades most of the idle saving for a warm path. Scale-to-zero is a fit for development and batch work, not for a path whose first request has a tight deadline.",
    );
    return items;
  },
  legend: [
    { label: "Warm", tone: "ok" },
    { label: "Slow wake", tone: "warn" },
    { label: "First request fails", tone: "crit" },
    { label: "No data", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A one-task floor keeps the environment warm; the idle savings are modest.",
    tone: "ok",
    params: defaults({ minimumTasks: 1, idleWindowMin: 30, coldStartSec: 20, activeHoursPerDay: 10 }),
  },
  {
    id: "peak",
    label: "Fast wake",
    description: "Scale to zero with an 8s cold start; slower than warm, but under the 10s client timeout.",
    tone: "warn",
    params: defaults({ minimumTasks: 0, idleWindowMin: 15, coldStartSec: 8, activeHoursPerDay: 10 }),
  },
  {
    id: "failure",
    label: "The first request times out",
    description: "Zero tasks, a short idle window, and a 120s cold start against a 10s client timeout.",
    tone: "crit",
    params: defaults({ minimumTasks: 0, idleWindowMin: 15, coldStartSec: 120, activeHoursPerDay: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A one-task floor removes the cold start and the timeout; cost rises with the floor.",
    tone: "ok",
    params: defaults({ minimumTasks: 1, idleWindowMin: 60, coldStartSec: 120, activeHoursPerDay: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-scale-to-zero-fit",
  title: "Predict when scale-to-zero is safe",
  simId: "scale-to-zero",
  question:
    "A development environment is idle most of the day. Its first request after idle times out with a 120s cold start and a 10s client timeout. Which change makes scale-to-zero viable?",
  prediction: {
    options: [
      { id: "timeout", label: "Raise the client timeout to 180s and keep the 120s cold start" },
      { id: "floor", label: "Keep one task running as a floor" },
      { id: "faster", label: "Cut cold start below 10s with a smaller image and pre-warmed dependencies" },
      { id: "health", label: "Remove the readiness check so traffic reaches the task sooner" },
    ],
    correctOptionId: "faster",
    explanation:
      "A longer timeout makes the user wait two minutes, which is not viable for an interactive request. A floor works but gives up most of the saving. Removing the readiness check sends traffic to a task that is not ready. Cutting cold start below the timeout keeps the idle saving and makes the first request succeed. If the cold start cannot be cut, the floor is the honest choice.",
  },
  setup: defaults({ minimumTasks: 0, idleWindowMin: 15, coldStartSec: 120, activeHoursPerDay: 8 }),
  runFor: 30,
  observe: [
    "With zero tasks and a 120s cold start, every first request after idle exceeds the 10s client timeout.",
    "The savings versus always-on are large, but the failure lands on the first request of the day.",
    "Cutting cold start to 4s removes the timeout and keeps most of the saving.",
    "A one-task floor also removes the timeout, at a higher monthly cost than the faster cold start.",
  ],
  explain:
    "Scale-to-zero is a latency trade, not only a cost control. The saving is idle task-hours; the cost is the wake-up path. The policy works when the wake-up fits inside the client's deadline, or when the workload can wait. Development environments can often tolerate a slower first request; a checkout path usually cannot.",
  fix: defaults({ minimumTasks: 0, idleWindowMin: 120, coldStartSec: 4, activeHoursPerDay: 8 }),
  debrief:
    "At a 4s cold start the environment stays at zero when idle, saves about 86k$ a month in this model, and the first request succeeds. The remaining risk is image or dependency drift: the model assumes the cold start stays small, and a larger image or a database connection can put it back over the timeout.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Scale-to-zero stops every task when a workload is idle and starts one when the next request arrives. The idle saving is real: a development environment that runs ten hours a day can avoid most of the other fourteen. The cost moves into the wake-up path. A task has to be scheduled, an image pulled, a process started, and a health check passed before the first request can be served.",
  },
  {
    type: "p",
    text: "That wake-up is a cold start. It is tolerable for a developer who can wait, and often fatal for a request with a short deadline. The policy also loses local state: anything written to the task's disk or memory disappears when the last task stops. A floor of one task removes the cold start and keeps a process warm, at the cost of running that task around the clock.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, environment, task definition, and external state. The scheduler owns the task count; the client owns the timeout. A scale-to-zero policy that looks cheap on the billing page can fail before the environment has a chance to start. Durable state belongs outside the task, or the wake-up returns a service that has forgotten its work.",
  },
  {
    type: "table",
    headers: ["Policy", "Idle cost", "First-request latency", "State risk"],
    rows: [
      ["Always on, three tasks", "Highest", "Warm, about 200ms", "Local state survives"],
      ["Floor of one task", "Middle", "Warm path; one task bills", "Local state survives on the floor"],
      ["Scale to zero, fast image", "Lowest", "Cold start under the timeout", "Local state lost on scale-in"],
      ["Scale to zero, slow image", "Lowest", "Cold start over the timeout", "Local state lost and first request fails"],
    ],
  },
  {
    type: "p",
    text: "This model uses three active tasks, a one-hour lunch gap, a 10-second client timeout, and an illustrative task price. It compresses a day into a single policy snapshot rather than animating a clock. Task prices and cold-start times are teaching values, not AWS benchmarks.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "First-request latency and the share of first requests that exceed the client timeout.",
      "Monthly cost and savings versus an always-on environment.",
      "Cold starts per day, including the lunch gap when the idle window is short.",
      "A flow view from the developer client to the environment, task definition, and local state.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply The first request times out. Compare Fast wake and Recovery. Watch the trade between idle savings and first-request latency, then run the guided experiment before changing sliders.",
  },
  { type: "sim", simId: "scale-to-zero" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The environment was allowed to reach zero tasks with a 120s cold start and a 10s client timeout. The idle saving was large and the first request after idle failed every time. The failure was not in the scheduler or the image; it was in the mismatch between the wake-up path and the deadline the client was willing to wait.",
  },
  {
    type: "p",
    text: "The recovery preset kept one task running. The cold start disappeared, the first request succeeded, and the monthly cost rose. The faster-image preset kept scale-to-zero and cut the cold start below the timeout. Both work; they spend the saving in different places. The model makes the exchange visible instead of treating scale-to-zero as free.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Amazon Elastic Container Service (ECS) on Fargate: desired count, running count, task start time, and the gap between task start and healthy. A service at zero has no target for the load balancer.",
      "Load balancer: 502/504 responses at the start of the day, and target registration delay after a scale-out.",
      "Lambda or App Runner: init duration, cold-start percentage, and concurrency. Provisioned concurrency removes the cold start at a cost.",
      "Aurora Serverless v2: minimum capacity and resume time. A database that pauses adds its own wake-up to the request path.",
      "State: logs from the previous task, lost local files, and reconnect storms from clients that held a session on the stopped task.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the cold-start time with the client timeout. Check whether a floor or warm pool exists. Check whether the first request is interactive or can be made asynchronous. Then check what local state the task held before it stopped.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure cold start end to end: scheduling, image pull, start, readiness, and the first dependency call.",
      "Cut the cold start below the client deadline with a smaller image, pre-pulled layers, and lazy initialization.",
      "If the deadline cannot be met, keep a floor of one task or a warm pool for the paths that need it.",
      "Move durable state out of the task before scaling to zero, or accept that it is lost.",
      "Make the first request asynchronous where the product allows it: accept the request, wake the environment, and notify the client.",
      "Test the wake path after a long idle, not only after a rolling deploy that leaves tasks warm.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Scale-to-zero saves the most money on workloads with long idle gaps and the least on workloads that are rarely idle.",
      "A floor removes the cold start and bills every hour; it is the right answer when the first request has a hard deadline.",
      "A faster image helps every wake-up and adds build and cache work to every deploy.",
      "Local state is cheap while the task runs and disappears when it stops; external state costs money and removes the failure mode.",
      "A longer client timeout hides the cold start in the latency budget and makes every user wait for it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "decide-scale-to-zero",
    question:
      "A dev environment is idle 80% of the time. How do you decide whether it can scale to zero?",
    difficulty: 2,
    hints: [
      "Start from the first-request deadline, not from the idle percentage.",
      "Compare the cold start with the client timeout and the cost of a floor.",
    ],
    answer:
      "I would measure the cold start end to end and compare it with the timeout of the first request. If the wake-up fits, scale-to-zero is a clear saving. If it does not, I would either cut the cold start, keep a floor of one task, or make the first request asynchronous. For a development environment, a slow first request may be acceptable; for a production checkout path, it usually is not. I would also check what local state the task holds and whether the environment has a scheduled warm window.",
    followUps: [
      "What if the environment is used intermittently all day?",
      "How would you measure the cold start?",
      "When would you choose a floor over a faster image?",
    ],
    redFlags: [
      "Says scale-to-zero is always cheaper.",
      "Ignores the client timeout.",
      "Forgets local state.",
    ],
    rubric: [
      "Compares cold start with deadline.",
      "Names a floor or async path.",
      "Considers state.",
      "Separates dev from production.",
    ],
  },
  {
    id: "cold-start",
    question:
      "The first request after idle times out, but the second succeeds. What is happening?",
    difficulty: 2,
    hints: [
      "The first request starts the environment; the retry finds it running.",
      "The timeout may be shorter than the cold start.",
    ],
    answer:
      "The first request pays the cold start: the scheduler starts a task, pulls the image, and waits for readiness. If that takes longer than the client timeout, the client gives up, but the task continues starting. The retry arrives after the environment is warm and succeeds. The fix is to shorten the cold start, lengthen the deadline if the product can wait, keep a floor, or make the first request asynchronous. Increasing retries without changing the deadline only repeats the failure at the start of the next idle period.",
    followUps: [
      "How would you prove the task kept starting after the timeout?",
      "What does this do to the error budget?",
      "Would a warm pool help?",
    ],
    redFlags: [
      "Blames the retry.",
      "Raises retries without a deadline change.",
      "Ignores task start timestamps.",
    ],
    rubric: [
      "Explains the cold start race.",
      "Uses task timing.",
      "Names a fix.",
      "Considers the user wait.",
    ],
  },
  {
    id: "state-loss",
    question:
      "What state do you check before allowing an environment to scale to zero?",
    difficulty: 2,
    hints: [
      "Local disk and memory disappear with the task.",
      "Sessions and in-flight work are state too.",
    ],
    answer:
      "I would check local disk, in-memory caches, open sessions, and any in-flight work that assumes the process stays alive. A task that stops loses all of it. Durable state should live in a database, object store, or queue before the policy is enabled. I would also check whether clients hold a session on a specific task and whether a scale-in drains connections before the task stops.",
    followUps: [
      "How would you drain in-flight work?",
      "What about a local cache that is only a performance optimization?",
      "How do you test the loss path?",
    ],
    redFlags: [
      "Assumes the task restarts where it left off.",
      "Ignores in-flight work.",
      "Confuses a cache with durable state.",
    ],
    rubric: [
      "Names disk, memory, and sessions.",
      "Moves durable state out.",
      "Drains before stop.",
      "Tests the loss path.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The first-request deadline and the client timeout are documented for every environment.",
      "Cold start is measured end to end after a long idle, including dependency warm-up.",
      "Durable state lives outside the task, and scale-in drains in-flight work.",
      "A floor or warm window exists for paths that cannot tolerate the wake-up.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the cold start with the client timeout before changing retries.",
      "Check whether the first request is interactive or can be made asynchronous.",
      "Check whether the task kept starting after the client gave up.",
      "Check what local state was lost with the last task.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reduce cold start or add a floor for the affected path.",
      "Add a wake-path test that starts from zero tasks.",
      "Review the idle window against actual gaps between requests.",
      "Record the idle saving and the cost of the floor.",
    ],
  },
];

const references = [
  {
    title: "AWS Lambda: runtime environment lifecycle",
    url: "https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How a cold start creates an execution environment and why the first request pays for initialization.",
  },
  {
    title: "Amazon ECS: service auto scaling",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Desired count, minimum capacity, and the scaling policies that decide whether a service can reach zero.",
  },
  {
    title: "Aurora Serverless v2: scaling capacity",
    url: "https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-how-it-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Minimum capacity and resume behavior when a database scales down or pauses.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "scale-to-zero": {
      model: scaleToZeroModel,
      presets,
      instructions:
        "Start healthy, then apply The first request times out. Compare Fast wake and Recovery. Watch first-request latency and idle savings together.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Task price, cold-start time, and the client timeout are teaching values. Savings assume an always-on three-task baseline.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-fargate-cold-start",
    "capacity-warm-pools",
    "capacity-autoscaling-policies",
    "capacity-headroom-cost",
    "capacity-cost-allocation",
  ],
};
