import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SCHEDULING_SECONDS = 5;
const STARTUP_SECONDS = 10;
const THROTTLE_FLOOR = 8;
const RETRY_SECONDS = 30;

const params: ParamSpec[] = [
  {
    id: "imageSizeMb",
    label: "Image size",
    min: 100,
    max: 4_000,
    step: 50,
    value: 500,
    unit: " MB",
    group: "Image",
    help: "Compressed image size pulled by each task. Larger images take longer to transfer and extract.",
    format: "number",
  },
  {
    id: "layerCount",
    label: "Layer count",
    min: 1,
    max: 40,
    step: 1,
    value: 10,
    unit: " layers",
    group: "Image",
    help: "Number of layers in the image. Each uncached layer needs a registry request, so layers add overhead beyond bytes.",
    format: "count",
  },
  {
    id: "concurrentTasks",
    label: "Concurrent pulls",
    min: 1,
    max: 60,
    step: 1,
    value: 8,
    unit: " tasks",
    group: "Deployment",
    help: "Tasks pulling at the same time. They share the registry budget, so more concurrency can make each task slower.",
    format: "count",
  },
  {
    id: "registryBudgetMbps",
    label: "Registry pull budget",
    min: 20,
    max: 500,
    step: 10,
    value: 200,
    unit: " MB/s",
    group: "Registry",
    help: "Shared pull bandwidth available to this deployment. Illustrative; real registry limits are quotas and rate limits, not a single bandwidth number.",
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

interface Values {
  imageSize: number;
  layers: number;
  concurrent: number;
  budget: number;
  perTaskMbps: number;
  pullSeconds: number;
  timeToReady: number;
  throttled: boolean;
  stalled: boolean;
  ready: number;
  pending: number;
}

function compute(p: Params, ready: number): Values {
  const imageSize = Math.max(1, num(p, "imageSizeMb", 500));
  const layers = Math.round(clamp(num(p, "layerCount", 10), 1, 40));
  const concurrent = Math.round(clamp(num(p, "concurrentTasks", 8), 1, 60));
  const budget = Math.max(1, num(p, "registryBudgetMbps", 200));
  const perTaskMbps = budget / concurrent;
  const throttled = perTaskMbps < THROTTLE_FLOOR;
  const layerOverhead = layers * 0.4;
  const pullSeconds = imageSize / perTaskMbps + layerOverhead;
  const timeToReady = SCHEDULING_SECONDS + pullSeconds + (throttled ? RETRY_SECONDS : 0) + STARTUP_SECONDS;
  return {
    imageSize,
    layers,
    concurrent,
    budget,
    perTaskMbps,
    pullSeconds,
    timeToReady,
    throttled,
    stalled: timeToReady > 180,
    ready,
    pending: Math.max(0, concurrent - ready),
  };
}

function serviceHealth(values: Values): Health {
  if (values.throttled || values.timeToReady >= 120) return "crit";
  if (values.timeToReady >= 60) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = serviceHealth(values);
  const registryHealth: Health = values.throttled
    ? "crit"
    : values.timeToReady >= 120
      ? "crit"
      : values.timeToReady >= 60
        ? "warn"
        : "ok";
  const nodes: SimNode[] = [
    {
      id: "registry",
      label: "Amazon ECR",
      kind: "external",
      health: registryHealth,
      sublabel: `${Math.round(values.budget)} MB/s shared · ${values.perTaskMbps.toFixed(1)} MB/s per task`,
      detail: `The deployment shares ${Math.round(values.budget)} MB/s across ${values.concurrent} tasks, so each task gets about ${values.perTaskMbps.toFixed(1)} MB/s. Each uncached layer also needs a registry request.`,
      meta: { budget: values.budget, perTask: Number(values.perTaskMbps.toFixed(1)) },
    },
    {
      id: "tasks",
      label: "Pulling tasks",
      kind: "worker",
      health,
      utilization: clamp(values.pending / Math.max(1, values.concurrent)),
      sublabel: `${values.pending} pending · ${Math.round(values.layers)} layers`,
      detail: `The task must fetch ${Math.round(values.imageSize)} MB across ${values.layers} layers. Registry throttling adds a retry delay in this model.`,
      meta: { pending: values.pending, layers: values.layers },
    },
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.ready / Math.max(1, values.concurrent)),
      sublabel: `${Math.round(values.ready)} of ${values.concurrent} ready · ${Math.round(values.timeToReady)}s`,
      detail: `Time to ready is ${Math.round(values.timeToReady)} seconds: ${SCHEDULING_SECONDS}s scheduling, ${Math.round(values.pullSeconds)}s pull, and ${STARTUP_SECONDS}s application startup${values.throttled ? `, plus ${RETRY_SECONDS}s retry` : ""}.`,
      meta: { ready: Math.round(values.ready), timeToReady: Math.round(values.timeToReady) },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("registry-tasks", "registry", "tasks", clamp(values.perTaskMbps / 50), registryHealth, "layers"),
      edge("tasks-service", "tasks", "service", clamp(values.ready / Math.max(1, values.concurrent)), health, "ready"),
    ],
    metrics: [
      metric("time-to-ready", "Time to ready", values.timeToReady, " s", 60, 120, "number"),
      metric("registry-throttled", "Registry throttling", values.throttled ? 1 : 0, "", 0.5, 1, "count"),
      metric("deployment-stall", "Deployment stalled", values.stalled ? 1 : 0, "", 0.5, 1, "count"),
      metric("pending-tasks", "Tasks still pulling", values.pending, "", undefined, undefined, "count"),
      metric("ready-tasks", "Tasks ready", values.ready, "", undefined, undefined, "count"),
      metric("per-task-pull", "Pull rate per task", values.perTaskMbps, " MB/s", undefined, undefined, "number"),
      metric("pull-seconds", "Image pull time", values.pullSeconds, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.concurrent} tasks · ${Math.round(values.imageSize)} MB · ${values.layers} layers · ${values.perTaskMbps.toFixed(1)} MB/s each · ${Math.round(values.timeToReady)}s to ready${values.throttled ? " · throttled" : ""}.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin((index + (seed % 8)) / 2.5) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "time-to-ready",
    metricId: "time-to-ready",
    warn: 60,
    crit: 120,
    title: "Image pull is delaying task readiness",
    cause:
      "The image is large, the deployment is pulling many tasks through a shared budget, the layer count adds registry requests, or the registry is throttling and forcing retries. The task cannot pass its health check until the image is present.",
    fix:
      "Measure pull time separately from application startup. Reduce image size and layer count, increase the registry budget or pull concurrency deliberately, or use a pull-through cache where the architecture supports it. Do not raise the health-check grace period to hide a pull that never finishes.",
    checkFirst: [
      "Check the task state and image pull events before the application starts.",
      "Compare image size and layer count with the pull rate per task.",
      "Check registry throttling and retry metrics.",
    ],
  },
  {
    id: "registry-throttled",
    metricId: "registry-throttled",
    warn: 0.5,
    crit: 1,
    title: "The registry is throttling pulls",
    cause:
      "Too many tasks are pulling at once for the available registry budget, or the image has enough layers that request pressure is high. Throttling adds retries, so the deployment gets slower as more tasks start together.",
    fix:
      "Reduce concurrent pull pressure, split the rollout into smaller batches, shrink the image, or raise the registry quota if the limit is a real service quota. Check whether the limit is bandwidth, request rate, or a pull-count quota before changing the deployment.",
    checkFirst: [
      "Check registry response codes and retry counts.",
      "Compare concurrent pulls with the registry quota.",
      "Check whether the limit is per account, per repository, or per client.",
    ],
  },
  {
    id: "deployment-stall",
    metricId: "deployment-stall",
    warn: 0.5,
    crit: 1,
    title: "The deployment is effectively stalled on image pulls",
    cause:
      "Time to ready is beyond the deployment's patience. A very large image, a very small shared budget, or repeated throttling can keep every task pending long enough that the rollout makes no visible progress.",
    fix:
      "Stop adding pull pressure. Reduce the image and layer count first, then raise the budget or reduce concurrency. If the image is already minimal, check the registry path and whether a cache or pull-through cache is available.",
    checkFirst: [
      "Check whether tasks are pending or pulling, not starting.",
      "Check image size and layer count against the previous revision.",
      "Check registry throttling and network path to the registry.",
    ],
  },
];

export const imagePullModel: SimModel = {
  id: "containers-image-pull",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p, 0);
    const frame = buildFrame(seed, values);
    seedSeries(frame);
    frame.flags.ready = 0;
    frame.flags.readyAt = values.timeToReady;
    return frame;
  },
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    let ready = reset ? 0 : Math.max(0, Number(frame.flags.ready ?? 0));
    const readyAt = reset ? frame.t + compute(p, 0).timeToReady : Math.max(0, Number(frame.flags.readyAt ?? 0));
    const values = compute(p, ready);
    if (frame.t >= readyAt) ready = values.concurrent;
    const nextValues = compute(p, ready);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, nextValues);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, ready, readyAt, paramsKey: key };
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([seriesKey, points]) => [seriesKey, [...points]]),
    );
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const ready = Number(frame.flags.ready ?? 0);
    const values = compute(p, ready);
    return [
      `Time to ready is about ${Math.round(values.timeToReady)} seconds: ${SCHEDULING_SECONDS}s scheduling, ${Math.round(values.pullSeconds)}s pull, ${STARTUP_SECONDS}s startup${values.throttled ? `, and ${RETRY_SECONDS}s retry` : ""}.`,
      `The deployment shares ${Math.round(values.budget)} MB/s across ${values.concurrent} tasks, so each task gets about ${values.perTaskMbps.toFixed(1)} MB/s.`,
      `${Math.round(values.imageSize)} MB across ${values.layers} layers. Each uncached layer needs a registry request, so layer count matters even when total bytes are moderate.`,
      values.throttled
        ? "The per-task pull rate is below the model's throttle floor, so retries are adding time. More concurrency would make this worse, not better."
        : "The registry is not throttling in this configuration. Check whether image size, layer count, or startup dominates the remaining time.",
      "Amazon ECR publishes API quotas, including per-second rates for layer download URL requests and image manifest requests. Docker Hub also enforces pull limits. The simulated bandwidth budget is a teaching abstraction, not an ECR quota.",
    ];
  },
  legend: [
    { label: "Pull within budget", tone: "ok" },
    { label: "Slow pull", tone: "warn" },
    { label: "Throttled or stalled", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 500 MB image with ten layers, eight concurrent pulls, and a 200 MB/s budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy registry",
    description: "A 900 MB image and twenty concurrent pulls through a 300 MB/s budget.",
    tone: "warn",
    params: defaults({ imageSizeMb: 900, layerCount: 18, concurrentTasks: 20, registryBudgetMbps: 300 }),
  },
  {
    id: "failure",
    label: "Throttled",
    description: "A 3,000 MB image with 30 layers and forty concurrent pulls through an 80 MB/s budget.",
    tone: "crit",
    params: defaults({ imageSizeMb: 3_000, layerCount: 30, concurrentTasks: 40, registryBudgetMbps: 80 }),
  },
  {
    id: "recovery",
    label: "Slim image",
    description: "A 250 MB image with five layers, twenty concurrent pulls, and a 400 MB/s budget.",
    tone: "ok",
    params: defaults({ imageSizeMb: 250, layerCount: 5, concurrentTasks: 20, registryBudgetMbps: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-concurrency",
  title: "Predict whether more concurrent pulls start faster",
  simId: "image-pull",
  question:
    "A deployment launches 30 tasks at once. The image is 2,000 MB, the registry budget is 100 MB/s, and each task pulls the same image. Will launching all 30 at once reduce the time to ready?",
  prediction: {
    options: [
      { id: "faster", label: "Yes. More tasks pulling in parallel always finish sooner" },
      { id: "same", label: "No. Image pull time is fixed by the image size alone" },
      { id: "slower", label: "No. The shared budget is divided across tasks, so each pull is slower and may throttle" },
      { id: "cache", label: "Yes, because every task shares a cache on the Fargate host" },
    ],
    correctOptionId: "slower",
    explanation:
      "The registry budget is shared. With 30 tasks, each task gets about 3.3 MB/s instead of the full 100 MB/s, so the same image takes much longer per task. The layer requests also multiply. Throttling adds retries on top of that. More concurrency can improve total throughput only when the registry and network are not the bottleneck.",
  },
  setup: defaults({ imageSizeMb: 2_000, layerCount: 25, concurrentTasks: 30, registryBudgetMbps: 100 }),
  runFor: 60,
  observe: [
    "Each task gets about 3.3 MB/s, so the 2,000 MB image takes far longer than the healthy preset.",
    "The per-task pull rate falls below the throttle floor and the model adds retry time.",
    "The deployment is stalled, with every task still pending at 60 seconds.",
    "Reducing the image and raising the budget brings time to ready under a minute.",
  ],
  explain:
    "Image pull is a shared-resource problem. Bytes and layers are per task, but the registry path and its quotas are shared by the deployment. When you increase concurrency, you increase aggregate demand and the number of layer requests. If the registry is the bottleneck, each task gets a smaller share and the deployment can move backward. The fix is to reduce the work per task or increase the shared capacity deliberately.",
  fix: defaults({ imageSizeMb: 600, layerCount: 12, concurrentTasks: 20, registryBudgetMbps: 300 }),
  debrief:
    "The smaller image and higher budget bring time to ready to about a minute. The tradeoff is that a larger budget may not be available, and a smaller image may require build changes. Reducing concurrency also helps, but it slows the rollout because fewer tasks start at once. The right combination depends on whether the limit is bandwidth, request rate, or a pull-count quota.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An image pull is the transfer of an image manifest and its layers from a registry to the container runtime. The runtime resolves the manifest, requests a download URL for each layer it does not already have, downloads the layers, and extracts them. Only then can the container start. On Fargate, Linux containers run on single-use instances and image layers are not cached there, so each task pulls its image as part of the startup path.",
  },
  {
    type: "p",
    text: "Two different costs scale with the image. Bytes determine transfer time. Layers determine the number of registry requests and the amount of metadata work. A 2 GB image with three layers and a 2 GB image with 40 layers are not the same pull. The compressed size, the number of layers that are actually new, and the registry path all matter.",
  },
  {
    type: "table",
    headers: ["Lever", "Effect", "Tradeoff"],
    rows: [
      ["Smaller image", "Less data to transfer and extract", "May require build or dependency changes"],
      ["Fewer layers", "Fewer registry requests and less metadata work", "Layer consolidation can reduce cache reuse"],
      ["Shared cache", "Avoids pulling layers already present", "Not every runtime gives you a persistent cache"],
      ["Higher registry budget", "More aggregate throughput", "Cost, quota limits, and shared capacity"],
      ["Lower concurrency", "More bandwidth per task", "Slower overall rollout"],
    ],
  },
  {
    type: "p",
    text: "Registries enforce limits. Amazon ECR publishes per-second API quotas, including default rates of 3,000 `GetDownloadUrlForLayer` requests and 2,000 `BatchGetImage` requests per second in each supported Region, both adjustable through Service Quotas. Each uncached layer causes a layer download URL request. Docker Hub also enforces pull limits. A deployment that launches many tasks at once multiplies request pressure, and a throttled registry adds retries and backoff, which makes the pull slower exactly when the rollout needs speed.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pull sits between the registry and the container runtime on the task. ECS asks Fargate to provision the task, the runtime resolves and pulls the image, the container starts, and the application initializes. The ECS task state and the registry's response codes tell you which part is slow. The load balancer does not enter the picture until the task is healthy.",
  },
  {
    type: "p",
    text: "That boundary matters because the autoscaler and the deployment controller only see the desired count. They cannot tell whether a task is waiting for capacity, a registry, a slow layer, or an application that has not opened its port. The task state and the pull events are the evidence.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to ready, split into scheduling, pull, and application startup.",
      "The shared registry budget and the resulting rate per task.",
      "Pending tasks and ready tasks, which show whether the deployment is making progress.",
      "Registry throttling and retry time, which grow with concurrent pulls.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Throttled to see a large image and forty concurrent pulls overload the budget. Apply Slim image to see the same deployment with less work per task. Raise concurrent pulls in the healthy preset to watch the per-task rate fall.",
  },
  { type: "sim", simId: "image-pull" },
  { type: "experiment", experimentId: "predict-concurrency" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The throttled preset gave forty tasks an 80 MB/s shared budget, or 2 MB/s each. A 3,000 MB image with 30 layers took over 1,500 seconds to pull before application startup. The per-task rate fell below the model's throttle floor, so retries added more time. The deployment was still pending when the healthy preset would have finished several times over.",
  },
  {
    type: "p",
    text: "The slim-image preset used 250 MB, five layers, twenty concurrent pulls, and a 400 MB/s budget. Each task got 20 MB/s, the pull finished in about 15 seconds, and time to ready was under 30 seconds. The difference was not a better autoscaler; it was less work per task and more shared capacity.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ECS task states for provisioning, pulling, and running, with the stopped reason if the pull fails.",
      "Registry response codes, retry counts, and throttling events.",
      "Image size and layer count per revision, which are easy to compare across deploys.",
      "Pull duration from the task's image-pull events, separated from application startup.",
      "Service quotas for registry APIs, especially layer download URL and manifest requests.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether tasks are pending or pulling before you change anything else. Compare image size and layer count with the previous revision, then compare concurrent pulls with the registry quota. If the image is already small, check the registry path and retry behavior.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure pull time separately from scheduling and application startup.",
      "Compare image size and layer count with the previous revision.",
      "Reduce image size with a smaller base, multi-stage builds, and a proper ignore file.",
      "Reduce unnecessary layers and avoid reinstalling dependencies in a late layer.",
      "Check whether a cache or pull-through cache applies to the runtime.",
      "Reduce concurrent pull pressure or raise the registry quota deliberately.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Smaller images reduce pull time and usually improve security surface, at the cost of build changes.",
      "Fewer layers reduce request overhead but can reduce cache reuse if unrelated changes are consolidated.",
      "A cache helps only when the layer is already present; on Fargate Linux tasks, layers are not cached on the task instance.",
      "More concurrent pulls can improve total throughput when the registry is not the bottleneck, and make it worse when it is.",
      "A higher registry quota costs money and may not fix a slow application startup.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "slow-pull",
    question:
      "New tasks take 90 seconds to start and the registry is throttling. What do you change first?",
    difficulty: 2,
    hints: [
      "Separate pull time from application startup.",
      "More concurrent pulls can make throttling worse.",
    ],
    answer:
      "I would confirm from the task events that the time is in image pull rather than application startup or health checks. Then I would compare the image size and layer count with the previous revision, and check the registry response codes and retry counts. If the registry is throttling because many tasks are pulling at once, I would reduce concurrency or split the rollout, and reduce the image size and layer count. I would check whether the limit is a per-second API quota, a bandwidth limit, or a pull-count limit, because the fix differs. Raising the quota is reasonable only after the image is already minimal.",
    followUps: [
      "How would you prove the delay is image pull?",
      "Which is more likely to throttle: bytes or layers?",
      "When would you use a pull-through cache?",
    ],
    redFlags: [
      "Raises the health-check grace period without checking the pull.",
      "Adds more concurrent pulls to speed it up.",
      "Changes the autoscaler before measuring startup.",
    ],
    rubric: [
      "Confirms the pull is the bottleneck.",
      "Checks size and layers.",
      "Checks the registry limit type.",
      "Reduces pressure before raising quotas.",
    ],
  },
  {
    id: "layers-vs-bytes",
    question:
      "Why can an image with fewer bytes still start more slowly than a slightly larger image?",
    difficulty: 3,
    hints: [
      "Each uncached layer needs a registry request.",
      "Cache reuse depends on layer boundaries.",
    ],
    answer:
      "Bytes are only one part of the pull. Each uncached layer requires a registry request and metadata work, and a registry can throttle request rate even when bandwidth is fine. An image with many small layers can therefore be slower than a slightly larger image with fewer layers, especially when the registry is under request pressure. Layer boundaries also affect cache reuse: if a late layer changes, only that layer needs to be pulled, so a well-structured image can be faster on the second deploy even if it is larger. I would measure pull time and request counts rather than assuming bytes alone decide.",
    followUps: [
      "How would you inspect layer sizes?",
      "What makes a layer cache-friendly?",
      "When does consolidating layers hurt?",
    ],
    redFlags: [
      "Assumes bytes are the only cost.",
      "Ignores cache reuse.",
      "Consolidates every layer into one.",
    ],
    rubric: [
      "Explains per-layer request overhead.",
      "Connects layer boundaries to cache reuse.",
      "Measures instead of assuming.",
      "Recognizes the tradeoff in consolidation.",
    ],
  },
  {
    id: "registry-quota",
    question:
      "How do you tell a registry quota problem from a network or application startup problem?",
    difficulty: 3,
    hints: [
      "The task state and registry response codes separate the phases.",
      "A throttled request usually returns a specific error and a retry.",
    ],
    answer:
      "I would start with the task state and events. If the task is in a pulling state with registry errors or retries, the problem is in the pull path. If the image pull completes and the task is running but not healthy, the problem is application startup or the health check. If pulls are slow without errors, I would compare the observed rate with the expected network path and the registry's quota. Registry throttling usually shows up as explicit error responses and retries; a network problem shows up as slow transfer or timeouts. I would also check whether the limit is per account, per repository, or per client, because that changes who is affected.",
    followUps: [
      "Which registry metrics would you alert on?",
      "How would you test a quota change safely?",
      "What if only one availability zone is slow?",
    ],
    redFlags: [
      "Treats every slow start as a registry problem.",
      "Ignores task state.",
      "Raises quotas without identifying the limit.",
    ],
    rubric: [
      "Uses task state to locate the phase.",
      "Distinguishes errors from slowness.",
      "Identifies the quota scope.",
      "Tests changes safely.",
    ],
  },
];

const checklist = [
  {
    title: "Before the rollout",
    items: [
      "Record image size and layer count per revision.",
      "Measure pull time separately from application startup.",
      "Check registry quotas and the expected concurrent pull count.",
      "Decide whether a cache or pull-through cache applies.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Check whether tasks are pending, pulling, or starting.",
      "Check registry response codes and retries.",
      "Compare per-task pull rate with the shared budget.",
      "Check whether the rollout is adding pull pressure faster than the registry can serve it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reduce image size and unnecessary layers.",
      "Adjust concurrency or registry quota deliberately.",
      "Re-measure time to ready with the same task definition.",
      "Keep the image size visible in the deploy review.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECR service quotas",
    url: "https://docs.aws.amazon.com/AmazonECR/latest/userguide/service-quotas.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Default API quotas, including layer download URL and image manifest request rates.",
  },
  {
    title: "Pull an image from Amazon ECR",
    url: "https://docs.aws.amazon.com/AmazonECR/latest/userguide/docker-pull-ecr-image.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "How a container runtime authenticates to ECR and pulls an image.",
  },
  {
    title: "Docker build best practices",
    url: "https://docs.docker.com/build/building/best-practices/",
    publisher: "Docker",
    kind: "docs" as const,
    note: "Image size, layer structure, caching, and multi-stage build guidance.",
  },
  {
    title: "Linux containers on Fargate container image pull behavior",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-pull-behavior.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Fargate tasks use single-use instances, image layers are not cached there, and each task pulls its image.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "image-pull": {
      model: imagePullModel,
      presets,
      instructions:
        "Start Healthy, then apply Throttled to see a large image and forty concurrent pulls overload the shared budget. Apply Slim image to see the same deployment with less work per task. Raise concurrent pulls in the healthy preset to watch the per-task rate fall.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The shared bandwidth budget, 8 MB/s throttle floor, 30-second retry, 5-second scheduling, and 10-second application startup are teaching assumptions, not registry quotas. Fargate Linux tasks do not cache image layers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-fargate-cold-start",
    "containers-task-definitions",
    "containers-services",
    "capacity-warm-pools",
  ],
};
