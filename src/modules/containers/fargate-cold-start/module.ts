import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INITIAL_TASKS = 10;
const TASK_CAPACITY = 300;
const BASELINE_RPS = 1_800;
const SPIKE_AT = 30;
const SPIKE_END = 90;
const TARGET_UTIL = 0.65;
const SCHEDULING_SECONDS = 5;
const PULL_MBPS = 25;
const MAX_TASKS = 60;

const params: ParamSpec[] = [
  {
    id: "spikeRate",
    label: "Spike request rate",
    min: 2_000,
    max: 12_000,
    step: 250,
    value: 2_400,
    unit: " rps",
    group: "Traffic",
    help: "Request rate after the spike starts. The model holds it for 60 seconds, then returns to 1,800 rps.",
    format: "rps",
  },
  {
    id: "scaleLeadSeconds",
    label: "Scale lead time",
    min: 0,
    max: 120,
    step: 5,
    value: 30,
    unit: " s",
    group: "Policy",
    help: "How early the policy adds tasks before the known spike. Zero is reactive scaling at the spike.",
    format: "number",
  },
  {
    id: "imageSizeMb",
    label: "Image size",
    min: 100,
    max: 2_000,
    step: 50,
    value: 300,
    unit: " MB",
    group: "Startup",
    help: "Image size pulled by each task. The model assumes 25 MB/s of pull throughput per task; registry contention is covered in the image pull module.",
    format: "number",
  },
  {
    id: "startupSeconds",
    label: "Application startup",
    min: 5,
    max: 60,
    step: 5,
    value: 10,
    unit: " s",
    group: "Startup",
    help: "Time from container start to the application passing its health check. Illustrative, not a benchmark.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function coldStartSeconds(p: Params): number {
  const imageSize = Math.max(1, num(p, "imageSizeMb", 800));
  const startup = Math.max(0, num(p, "startupSeconds", 25));
  return SCHEDULING_SECONDS + imageSize / PULL_MBPS + startup;
}

function desiredFor(rate: number): number {
  return Math.max(1, Math.min(MAX_TASKS, Math.ceil(rate / (TASK_CAPACITY * TARGET_UTIL))));
}

interface Values {
  demand: number;
  desired: number;
  ready: number;
  pending: number;
  capacity: number;
  shortfall: number;
  load: number;
  p99: number;
  coldStart: number;
  leadGap: number;
  lead: number;
  spikeStart: number;
  scaled: boolean;
}

function compute(p: Params, t: number, ready: number, desired: number, scaled: boolean): Values {
  const spikeRate = Math.max(1, num(p, "spikeRate", 7_000));
  const lead = Math.max(0, num(p, "scaleLeadSeconds", 0));
  const coldStart = coldStartSeconds(p);
  const inSpike = t >= SPIKE_AT && t < SPIKE_END;
  const demand = inSpike ? spikeRate : BASELINE_RPS;
  const capacity = Math.max(1, ready * TASK_CAPACITY);
  const shortfall = Math.max(0, demand - capacity);
  const load = demand / capacity;
  const p99 = Math.min(
    5_000,
    40 + 1_200 * Math.max(0, load - TARGET_UTIL) ** 2 + 100 * Math.min(10, shortfall / TASK_CAPACITY),
  );
  return {
    demand,
    desired,
    ready,
    pending: Math.max(0, desired - ready),
    capacity,
    shortfall,
    load,
    p99,
    coldStart,
    leadGap: Math.max(0, coldStart - lead),
    lead,
    spikeStart: Math.max(0, SPIKE_AT - lead),
    scaled,
  };
}

function serviceHealth(values: Values): Health {
  if (values.shortfall >= 500 || values.p99 >= 800) return "crit";
  if (values.shortfall > 0 || values.p99 >= 300) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values, imageSize: number): SimFrame {
  const health = serviceHealth(values);
  const registryHealth: Health = values.coldStart >= 90 ? "crit" : values.coldStart >= 60 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "clients",
      label: "Clients",
      kind: "client",
      health: "ok",
      throughput: values.demand,
      sublabel: `${Math.round(values.demand).toLocaleString()} rps`,
    },
    {
      id: "alb",
      label: "Load balancer",
      kind: "lb",
      health,
      throughput: values.demand,
      capacity: values.capacity,
      sublabel: `${Math.round(values.ready)} ready targets`,
      detail: `The load balancer can send traffic only to tasks that are registered and healthy. ${values.pending} tasks are still starting.`,
    },
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.load),
      throughput: values.demand,
      capacity: values.capacity,
      sublabel: `${values.desired} desired · ${Math.round(values.ready)} ready`,
      detail: `The service wants ${values.desired} tasks and has ${Math.round(values.ready)} ready. Ready capacity is ${Math.round(values.capacity).toLocaleString()} rps against ${Math.round(values.demand).toLocaleString()} rps of demand.`,
      meta: { desired: values.desired, ready: Math.round(values.ready) },
    },
    {
      id: "tasks",
      label: "Starting tasks",
      kind: "worker",
      health: values.pending > 0 && values.shortfall > 0 ? "crit" : "ok",
      utilization: clamp(values.pending / Math.max(1, values.desired)),
      sublabel: `${values.pending} pending · ${Math.round(values.coldStart)}s cold start`,
      detail: `A task is not serving until it is scheduled, its image is pulled, the application starts, and the health check passes. The model uses ${Math.round(values.coldStart)} seconds from scale-out to ready.`,
      meta: { pending: values.pending, coldStart: Math.round(values.coldStart) },
    },
    {
      id: "registry",
      label: "Image registry",
      kind: "external",
      health: registryHealth,
      sublabel: `${imageSize} MB · ${PULL_MBPS} MB/s`,
      detail: "Each Fargate task pulls its image from the registry. With no long-lived container instance that you manage, image pull is part of the task startup path.",
      meta: { imageSize },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("clients-alb", "clients", "alb", clamp(values.demand / 12_000), health),
      edge("alb-service", "alb", "service", clamp(values.load), health),
      edge("service-tasks", "service", "tasks", clamp(values.pending / Math.max(1, values.desired)), health),
      edge("registry-tasks", "registry", "tasks", clamp(values.coldStart / 120), registryHealth, "image pull"),
    ],
    metrics: [
      metric("request-shortfall", "Unserved demand", values.shortfall, " rps", 1, 500, "rps"),
      metric("p99", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("time-to-serve", "Time from scale-out to ready", values.coldStart, " s", 45, 90, "number"),
      metric("lead-gap", "Cold start beyond scale lead", values.leadGap, " s", 15, 45, "number"),
      metric("pending-tasks", "Tasks still starting", values.pending, "", undefined, undefined, "count"),
      metric("ready-tasks", "Ready tasks", values.ready, "", undefined, undefined, "count"),
      metric("desired-tasks", "Desired tasks", values.desired, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.desired} desired / ${Math.round(values.ready)} ready tasks · ${Math.round(values.demand).toLocaleString()} rps · ${Math.round(values.coldStart)}s to ready · ${values.pending} starting · p99 ${Math.round(values.p99)}ms.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 9)) / 2.6) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "request-shortfall",
    metricId: "request-shortfall",
    warn: 1,
    crit: 500,
    title: "New tasks are not ready before demand arrives",
    cause:
      "The scale-out started too late relative to the task cold start. Scheduling, image pull, application startup, and health-check registration all happen before a task can serve, so a reactive policy that adds tasks at the spike cannot help during the first part of it.",
    fix:
      "Start the scale-out earlier with scheduled or predictive scaling, reduce cold-start time with a smaller image and faster startup, or keep a warm minimum capacity that covers the start of the spike.",
    checkFirst: [
      "Compare the scale-out timestamp with the spike and the first healthy target.",
      "Check the task phase: pending, pulling, starting, or failing health checks.",
      "Compare measured cold start with the scale lead time.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Tail latency rises while new tasks are still starting",
    cause:
      "Demand is above the capacity of the ready tasks. The remaining tasks are in the startup path, so queueing and timeouts raise the tail even though the desired count already looks correct.",
    fix:
      "Restore ready capacity first. Then reduce startup time or add capacity before the spike. A desired count is not serving capacity until the tasks pass health checks.",
    checkFirst: [
      "Check ready tasks and the load balancer healthy target count.",
      "Check whether tasks are pending placement or still pulling the image.",
      "Check application startup logs and health-check timing.",
    ],
  },
  {
    id: "time-to-serve",
    metricId: "time-to-serve",
    warn: 45,
    crit: 90,
    title: "Cold start is longer than the burst can absorb",
    cause:
      "The task spends too long in scheduling, image pull, application startup, or health checks. A large image, a slow boot, or a late health check can each dominate the total.",
    fix:
      "Measure each phase separately, then shorten the largest one. Use a smaller image, fewer layers, a faster startup path, and a health check that reflects readiness rather than process start.",
    checkFirst: [
      "Measure the time from task creation to image pull completion.",
      "Measure application boot to the first successful health check.",
      "Check whether the health-check interval and grace period add avoidable delay.",
    ],
  },
  {
    id: "lead-gap",
    metricId: "lead-gap",
    warn: 15,
    crit: 45,
    title: "The policy starts scaling later than the cold start",
    cause:
      "Reactive scaling starts after the metric shows the spike. If the cold start is longer than the lead time, the new tasks become ready after the demand has already arrived. The policy is correct but late.",
    fix:
      "Scale earlier for known spikes, or reduce cold start below the available lead. If neither is possible, keep warm capacity or use a minimum task floor during the risk window.",
    checkFirst: [
      "Compare the scaling activity timestamp with the traffic spike.",
      "Measure cold start for the same task definition and image.",
      "Check whether scheduled or predictive scaling is available for the pattern.",
    ],
  },
];

export const fargateColdStartModel: SimModel = {
  id: "containers-fargate-cold-start",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0, INITIAL_TASKS, INITIAL_TASKS, false);
    const frame = buildFrame(seed, values, Math.round(num(p, "imageSizeMb", 800)));
    seedSeries(frame);
    frame.flags.ready = INITIAL_TASKS;
    frame.flags.desired = INITIAL_TASKS;
    frame.flags.readyAt = 0;
    frame.flags.scaled = 0;
    return frame;
  },
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    let ready = reset ? INITIAL_TASKS : Math.max(0, Number(frame.flags.ready ?? INITIAL_TASKS));
    let desired = reset ? INITIAL_TASKS : Math.max(0, Number(frame.flags.desired ?? INITIAL_TASKS));
    let readyAt = reset ? 0 : Math.max(0, Number(frame.flags.readyAt ?? 0));
    let scaled = reset ? 0 : Number(frame.flags.scaled ?? 0);

    const t = frame.t;
    const lead = Math.max(0, num(p, "scaleLeadSeconds", 0));
    const spikeStart = Math.max(0, SPIKE_AT - lead);
    const coldStart = coldStartSeconds(p);
    const spikeDesired = desiredFor(Math.max(1, num(p, "spikeRate", 7_000)));

    if (!scaled && t >= spikeStart) {
      desired = spikeDesired;
      readyAt = spikeStart + coldStart;
      scaled = 1;
    }
    if (scaled && readyAt > 0 && t >= readyAt) {
      ready = desired;
    }
    if (t >= SPIKE_END) {
      desired = desiredFor(BASELINE_RPS);
      ready = Math.min(ready, desired);
    }

    const values = compute(p, t, ready, desired, scaled > 0);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, values, Math.round(num(p, "imageSizeMb", 800)));
    next.t = frame.t;
    next.flags = {
      ...frame.flags,
      ...next.flags,
      ready,
      desired,
      readyAt,
      scaled,
      paramsKey: key,
    };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
    );
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const ready = Number(frame.flags.ready ?? INITIAL_TASKS);
    const desired = Number(frame.flags.desired ?? INITIAL_TASKS);
    const values = compute(p, frame.t, ready, desired, Number(frame.flags.scaled ?? 0) > 0);
    return [
      `Cold start is about ${Math.round(values.coldStart)} seconds: ${SCHEDULING_SECONDS}s scheduling, about ${Math.round(Math.max(1, num(p, "imageSizeMb", 800)) / PULL_MBPS)}s image pull, and ${Math.round(Math.max(0, num(p, "startupSeconds", 25)))}s application startup.`,
      `The policy leads the spike by ${Math.round(values.lead)} seconds. The lead gap is ${Math.round(values.leadGap)} seconds; a positive gap means the tasks cannot be ready for the spike unless demand is lower than expected.`,
      `The service wants ${values.desired} tasks and has ${Math.round(values.ready)} ready. ${values.pending} tasks are still in the startup path.`,
      values.shortfall > 0
        ? `Unserved demand is ${Math.round(values.shortfall).toLocaleString()} rps. The desired count is not the same as serving capacity.`
        : "Ready capacity covers demand. The next question is whether the lead time is enough for the next spike.",
      "Reactive autoscaling starts after the metric moves. For a spike with a long Fargate cold start, the useful fix is earlier capacity, faster startup, or a warm floor.",
    ];
  },
  legend: [
    { label: "Ready before demand", tone: "ok" },
    { label: "Starting late", tone: "warn" },
    { label: "Not ready", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 2,400 rps spike with 30 seconds of lead and a 27-second cold start.",
    tone: "ok",
    params: defaults({ spikeRate: 2_400, scaleLeadSeconds: 30, imageSizeMb: 300, startupSeconds: 10 }),
  },
  {
    id: "peak",
    label: "Late but recovering",
    description: "A 3,300 rps spike with 20 seconds of lead and a 49-second cold start.",
    tone: "warn",
    params: defaults({ spikeRate: 3_300, scaleLeadSeconds: 20, imageSizeMb: 600, startupSeconds: 20 }),
  },
  {
    id: "failure",
    label: "Reactive and slow",
    description: "A 9,000 rps spike, no lead time, a 1,500 MB image, and 45 seconds of startup.",
    tone: "crit",
    params: defaults({ spikeRate: 9_000, scaleLeadSeconds: 0, imageSizeMb: 1_500, startupSeconds: 45 }),
  },
  {
    id: "recovery",
    label: "Scaled early",
    description: "The same 9,000 rps spike, now with 40 seconds of lead and a 300 MB image.",
    tone: "ok",
    params: defaults({ spikeRate: 9_000, scaleLeadSeconds: 40, imageSizeMb: 300, startupSeconds: 10 }),
  },
  {
    id: "small-image",
    label: "Small image",
    description: "A 4,000 rps spike with a 100 MB image and a 14-second cold start.",
    tone: "info",
    params: defaults({ spikeRate: 4_000, scaleLeadSeconds: 20, imageSizeMb: 100, startupSeconds: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-lead",
  title: "Predict whether reactive scaling beats the spike",
  simId: "fargate-cold-start",
  question:
    "A service reacts to a 9,000 rps spike by adding tasks at the moment the spike starts. The image is 1.5 GB and application startup takes 45 seconds. Will the new tasks serve traffic during the first minute of the spike?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. Adding tasks at the spike is fast enough because Fargate starts in seconds" },
      { id: "no", label: "No. Scheduling, image pull, startup, and health checks take longer than the spike's first minute" },
      { id: "desired", label: "Yes, because the desired count increases immediately" },
      { id: "health", label: "Only if the health check grace period is disabled" },
    ],
    correctOptionId: "no",
    explanation:
      "The desired count is not serving capacity. Each task must be scheduled, pull its image, start the application, and pass health checks. With a 1.5 GB image and 45 seconds of startup in this model, the task is not ready until well after the spike begins. Reactive scaling is late by construction when the cold start exceeds the time between the metric change and the demand.",
  },
  setup: defaults({ spikeRate: 9_000, scaleLeadSeconds: 0, imageSizeMb: 1_500, startupSeconds: 45 }),
  runFor: 60,
  observe: [
    "The desired count jumps at the spike, but ready tasks stay at ten.",
    "Unserved demand and p99 stay high while the tasks are still starting.",
    "The time-to-serve metric is longer than the entire first minute of the spike.",
    "Scaling 40 seconds earlier, with a 300 MB image, gets the tasks ready before the spike.",
  ],
  explain:
    "Cold start is a pipeline, not a single number. Scheduling allocates the task, the image pull transfers layers from the registry, the container starts, the application initializes, and the health check must pass before the load balancer registers the target. Scaling earlier gives that pipeline time to finish. Shrinking the image or startup shortens it. Neither changes the fact that a task added at the spike serves later.",
  fix: defaults({ spikeRate: 9_000, scaleLeadSeconds: 40, imageSizeMb: 300, startupSeconds: 10 }),
  debrief:
    "With 40 seconds of lead and a 27-second cold start, the tasks are ready before the 9,000 rps spike and unserved demand stays at zero. The tradeoff is that predictive or scheduled capacity may be added before it is needed, and a warm floor costs money even when the spike does not arrive. Faster startup reduces both the lead requirement and the cost of being wrong.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Fargate cold start is the time between asking for a task and having a task that can serve traffic. It includes scheduling and provisioning, image pull, container start, application initialization, and the health check that makes the task eligible for the load balancer. The desired count can change in seconds; serving capacity cannot.",
  },
  {
    type: "p",
    text: "Fargate runs each task with its own isolation boundary. For Linux containers, image layers are not cached on the task's instance, so each task pulls its image as part of startup. You do not manage container instances or their image cache. A large image, a slow application boot, or a health check that waits for the wrong condition all extend the cold start. The load balancer does not send traffic to a task until the target is registered and healthy.",
  },
  {
    type: "table",
    headers: ["Phase", "What happens", "How to shorten it"],
    rows: [
      ["Scheduling", "Fargate provisions the task and its network interface", "Reduce placement constraints and quota pressure"],
      ["Image pull", "The task pulls layers from the registry", "Smaller image, fewer layers, closer registry; lazy loading where supported"],
      ["Application startup", "The process initializes and opens its listeners", "Faster boot, lazy initialization, smaller dependency set"],
      ["Health check", "The target must pass before it receives traffic", "A readiness check that matches real serving ability"],
    ],
  },
  {
    type: "p",
    text: "The policy question is not only how fast the service can scale. It is whether the scale-out starts early enough for the cold start to finish before demand arrives. Reactive scaling waits for the metric. If the metric reflects the spike after it has begun, and the cold start is longer than the remaining runway, the added tasks arrive after the useful window. That is why a correct desired count can coexist with a two-minute p99 spike.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The chain runs from CloudWatch to Application Auto Scaling to the ECS service, then through Fargate scheduling, the image registry, the container runtime, the application, and the load balancer target group. Each step has its own delay. The scaling policy owns only the decision to change the desired count; it does not own scheduling, image pull, startup, or health checks.",
  },
  {
    type: "p",
    text: "That is also why the fix is often outside the autoscaler. A smaller image or a faster readiness check shortens every future scale-out. A scheduled action or predictive scaling starts the pipeline before the spike. A warm minimum keeps capacity that is already past the cold start. Each trades cost or complexity for time.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The scale lead time compared with the measured time from scale-out to ready.",
      "Desired tasks, ready tasks, and tasks still in the startup path.",
      "Unserved demand and p99 during the gap, not just after it closes.",
      "The image size and startup time that dominate the cold start.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Reactive and slow to see a spike arrive before the tasks are ready. Apply Scaled early to start the same cold start before the spike. Try Small image to see how much of the gap is image pull rather than policy.",
  },
  { type: "sim", simId: "fargate-cold-start" },
  { type: "experiment", experimentId: "predict-lead" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The reactive preset added tasks when the spike began, but the tasks were still in the startup pipeline when demand arrived. Ready capacity stayed at ten tasks while the desired count rose. Unserved demand and p99 stayed high until the first batch finished pulling, starting, and passing health checks.",
  },
  {
    type: "p",
    text: "The scaled-early preset started the same pipeline 40 seconds before the spike with a much smaller image. The tasks were ready before demand arrived, so the desired count and serving capacity were aligned. The small-image preset showed the other lever: the same policy can be sufficient when the cold start is short enough.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ECS task lifecycle timestamps: provisioning, pulling, running, and healthy.",
      "Service events for task placement failures, image pull failures, and health-check failures.",
      "Target group healthy host count, which lags the running task count.",
      "Application startup logs and the health-check response time.",
      "Application Auto Scaling activities with the desired count change and the time of the spike.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the scale-out timestamp with the first healthy target, then compare both with the spike. If the desired count rose but ready capacity did not, the problem is startup, not the policy threshold. Break the cold start into scheduling, pull, startup, and health check before choosing a fix.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the cold start by phase, not as one number.",
      "Compare it with the lead time the policy actually has before demand.",
      "Scale earlier for known spikes with scheduled or predictive scaling.",
      "Shrink the image and remove unnecessary layers.",
      "Reduce application startup time and make the readiness check reflect serving ability.",
      "Keep a warm minimum capacity for the first minutes of an unpredictable spike.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Earlier scaling adds capacity before it is needed and may waste money.",
      "A warm floor is simple and always paid for.",
      "A smaller image reduces pull time but may not help if application startup dominates.",
      "A faster health check registers tasks sooner and can send traffic to an application that is not ready.",
      "Predictive scaling fits repeating patterns and is only as good as the history behind it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-p99-spike",
    question:
      "Autoscaling adds tasks during a spike, but p99 stays high for two minutes. How do you explain it?",
    difficulty: 3,
    hints: [
      "The desired count changes before serving capacity does.",
      "Break the delay into scheduling, pull, startup, and health check.",
    ],
    answer:
      "I would check when the tasks became ready, not when the desired count changed. A Fargate task has to be scheduled, pull its image, start the application, and pass health checks before the load balancer sends it traffic. If the spike arrives before that pipeline finishes, the service is short even though the desired count looks correct. I would compare the scale-out timestamp with the first healthy target timestamp, then break the gap into image pull, application startup, and health-check delay. The fix could be earlier scaling for a known spike, a smaller image, faster startup, or a warm floor, depending on which phase dominates.",
    followUps: [
      "How would you measure each phase?",
      "When would you choose a warm floor over predictive scaling?",
      "What if the tasks are running but never healthy?",
    ],
    redFlags: [
      "Assumes the desired count is serving capacity.",
      "Raises the scaling threshold without measuring startup.",
      "Ignores health-check registration.",
    ],
    rubric: [
      "Separates desired from ready capacity.",
      "Names the startup phases.",
      "Measures the dominant delay.",
      "Chooses a fix for that delay.",
    ],
  },
  {
    id: "reduce-cold-start",
    question:
      "How do you reduce a Fargate cold start without adding permanent capacity?",
    difficulty: 3,
    hints: [
      "Attack the largest phase first.",
      "Image size and startup time are separate levers.",
    ],
    answer:
      "I would measure the phases first, because the dominant one determines the fix. If image pull dominates, I would shrink the image, remove unused layers and dependencies, and check whether the registry path is slow. If application startup dominates, I would reduce initialization work and defer non-critical setup. If the health check dominates, I would make the readiness check reflect actual serving ability and tune the interval and grace period. I would also check whether tasks are waiting on scheduling because of quotas or placement constraints. None of these require keeping permanent extra capacity, although they may require engineering work.",
    followUps: [
      "Which phase is usually hardest to change?",
      "How would you verify the improvement?",
      "When is a warm floor cheaper than the engineering work?",
    ],
    redFlags: [
      "Only reduces the image size without measuring.",
      "Disables health checks to make tasks look ready.",
      "Ignores scheduling and quota delays.",
    ],
    rubric: [
      "Measures before changing.",
      "Targets the dominant phase.",
      "Keeps a real readiness check.",
      "Considers scheduling and quotas.",
    ],
  },
  {
    id: "predictive-vs-warm",
    question:
      "When would you use predictive scaling or scheduled scaling instead of a larger minimum capacity?",
    difficulty: 3,
    hints: [
      "Predictable spikes and unpredictable spikes need different tools.",
      "A warm floor is paid for continuously.",
    ],
    answer:
      "I would use scheduled or predictive scaling when the spike has a reliable time or shape and the cold start is long enough that reactive scaling cannot help. That starts the pipeline before demand and avoids paying for the floor all day. A larger minimum is better when the spike is unpredictable, when the cost of being short is high, or when the workload is small enough that a warm floor is cheap. I would validate the prediction against real history and keep a fallback floor for the cases it misses. The failure mode of prediction is a spike that does not match the pattern.",
    followUps: [
      "How would you validate a predictive scaling policy?",
      "What happens when the predicted spike does not arrive?",
      "How would you price the warm floor against the SLO risk?",
    ],
    redFlags: [
      "Treats prediction as guaranteed.",
      "Keeps a warm floor for a once-a-quarter event.",
      "Ignores the cost of the floor.",
    ],
    rubric: [
      "Matches the tool to predictability.",
      "Accounts for cold-start length.",
      "States the cost tradeoff.",
      "Keeps a fallback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the spike",
    items: [
      "Measure cold start from task creation to healthy target.",
      "Break the measurement into scheduling, pull, startup, and health check.",
      "Compare cold start with the lead time the policy has.",
      "Decide whether a warm floor or earlier scaling is cheaper.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check ready tasks and healthy targets, not just desired count.",
      "Check whether tasks are pending, pulling, starting, or failing health checks.",
      "Check unserved demand and p99 against the startup timeline.",
      "Check registry and scheduling errors.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the cold-start phases for the next capacity review.",
      "Reduce the dominant phase.",
      "Tune scheduled or predictive scaling against real history.",
      "Re-test with a traffic replay that includes the spike shape.",
    ],
  },
];

const references = [
  {
    title: "Architect for AWS Fargate for Amazon ECS",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Fargate task isolation, capacity providers, and service load balancing.",
  },
  {
    title: "Amazon ECS task definitions for Fargate",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-defs.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Task definition requirements and differences for Fargate tasks.",
  },
  {
    title: "Schedule your containers on Amazon ECS",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Service scheduling, task placement, and load balancer registration.",
  },
  {
    title: "Linux containers on Fargate container image pull behavior",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-pull-behavior.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Fargate tasks use single-use instances, image layers are not cached there, and each task pulls its image.",
  },
  {
    title: "Reducing AWS Fargate startup times with zstd compressed container images",
    url: "https://aws.amazon.com/blogs/containers/reducing-aws-fargate-startup-times-with-zstd-compressed-container-images/",
    publisher: "AWS Containers Blog",
    kind: "docs" as const,
    note: "How image compression affects Fargate image pull and task startup time.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "fargate-cold-start": {
      model: fargateColdStartModel,
      presets,
      instructions:
        "Start Healthy, then apply Reactive and slow to see the spike arrive before new tasks are ready. Apply Scaled early to start the same cold start earlier. Try Small image to see how much of the gap is image pull.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 1,800 rps baseline, 30-second spike start, ten initial tasks, sixty-task maximum, 300 rps per task, 5-second scheduling, 25 MB/s pull rate, and 60-second spike hold are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-target-tracking",
    "containers-image-pull",
    "containers-scaling-cooldowns",
    "capacity-warm-pools",
  ],
};
