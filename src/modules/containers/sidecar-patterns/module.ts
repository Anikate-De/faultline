import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAIN_DEMAND = 2;

const params: ParamSpec[] = [
  {
    id: "taskCpu",
    label: "Task CPU",
    min: 1,
    max: 4,
    step: 0.5,
    value: 4,
    unit: " vCPU",
    group: "Task size",
    help: "The CPU the task can use in total. On Fargate this is the task size. On EC2 it also bounds placement, while container CPU values act as relative shares.",
    format: "number",
  },
  {
    id: "sidecarCpu",
    label: "Sidecar CPU",
    min: 0.25,
    max: 2.5,
    step: 0.25,
    value: 1,
    unit: " vCPU",
    group: "Sidecar",
    help: "CPU the sidecar consumes at peak. It comes out of the same task budget as the application container, not from a separate pool.",
    format: "number",
  },
  {
    id: "startupOrder",
    label: "Startup order",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Lifecycle",
    help: "0 starts the application before the proxy sidecar. 1 waits for the sidecar to be healthy. 2 starts both in parallel. The model assumes the sidecar is a traffic proxy.",
    format: "count",
  },
  {
    id: "sidecarEssential",
    label: "Sidecar essential",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Lifecycle",
    help: "1 makes a sidecar exit stop the whole task. 0 lets the main container continue, which changes the blast radius rather than the current CPU math.",
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
  taskCpu: number;
  sidecarCpu: number;
  startupOrder: number;
  essential: boolean;
  mainAllocated: number;
  throttle: number;
  p99: number;
  startupFailures: number;
  sidecarShare: number;
}

function compute(p: Params): Values {
  const taskCpu = clamp(num(p, "taskCpu", 4), 1, 4);
  const sidecarCpu = clamp(num(p, "sidecarCpu", 1), 0.25, 2.5);
  const startupOrder = Math.round(clamp(num(p, "startupOrder", 1), 0, 2));
  const essential = Math.round(clamp(num(p, "sidecarEssential", 0), 0, 1)) === 1;
  const mainAllocated = Math.max(0, taskCpu - sidecarCpu);
  const throttle = clamp(((MAIN_DEMAND - mainAllocated) / MAIN_DEMAND) * 100, 0, 100);
  const startupFailures = startupOrder === 0 ? 100 : startupOrder === 1 ? 0 : 25;
  return {
    taskCpu,
    sidecarCpu,
    startupOrder,
    essential,
    mainAllocated,
    throttle,
    p99: 40 + throttle * 4.2,
    startupFailures,
    sidecarShare: (sidecarCpu / taskCpu) * 100,
  };
}

function healthOf(values: Values): Health {
  if (values.throttle >= 30 || values.startupFailures >= 10) return "crit";
  if (values.throttle > 0 || values.startupFailures > 0 || (values.essential && values.sidecarShare >= 50)) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const sidecarHealth: Health =
    values.sidecarShare >= 70 ? "crit" : values.sidecarShare >= 50 ? "warn" : "ok";
  const startupHealth: Health =
    values.startupFailures >= 10 ? "crit" : values.startupFailures > 0 ? "warn" : "ok";
  const orderLabel =
    values.startupOrder === 0 ? "application first" : values.startupOrder === 1 ? "sidecar healthy first" : "parallel start";
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.throttle / 100),
      sublabel: `${values.throttle.toFixed(0)}% throttled · p99 ${values.p99.toFixed(0)} ms`,
      detail: `The service is healthy enough to receive traffic but the application container is short on CPU. The sidecar consumes ${values.sidecarCpu.toFixed(2)} of the ${values.taskCpu.toFixed(2)} vCPU task budget.`,
      meta: { throttle: values.throttle, p99: values.p99 },
    },
    {
      id: "task",
      label: "checkout-task",
      kind: "service",
      role: "instance",
      health,
      utilization: clamp((values.sidecarCpu + Math.min(MAIN_DEMAND, values.mainAllocated)) / values.taskCpu),
      sublabel: `${values.taskCpu.toFixed(2)} vCPU shared · ${orderLabel}`,
      detail: `The task is one CPU and memory boundary. Every container in it draws from the same budget. ${
        values.essential
          ? "The sidecar is essential, so a sidecar exit also stops the task."
          : "The sidecar is not essential, so a sidecar exit leaves the application running."
      }`,
      meta: { taskCpu: values.taskCpu, sidecarCpu: values.sidecarCpu, essential: values.essential ? 1 : 0 },
    },
    {
      id: "main",
      label: "checkout-app",
      kind: "service",
      health,
      utilization: clamp(values.mainAllocated / MAIN_DEMAND),
      sublabel: `${values.mainAllocated.toFixed(2)} of ${MAIN_DEMAND.toFixed(2)} vCPU needed`,
      detail: `The application needs ${MAIN_DEMAND.toFixed(2)} vCPU to serve at its target latency. It receives ${values.mainAllocated.toFixed(2)} after the sidecar's consumption. ${
        values.throttle > 0
          ? `The gap produces ${values.throttle.toFixed(0)}% throttling and pushes p99 to about ${values.p99.toFixed(0)} ms in this model.`
          : "It has enough CPU, so the sidecar is not stealing from the request path."
      }`,
      meta: { allocated: values.mainAllocated, demand: MAIN_DEMAND },
    },
    {
      id: "sidecar",
      label: "envoy-sidecar",
      kind: "mesh",
      health: sidecarHealth,
      utilization: clamp(values.sidecarCpu / values.taskCpu),
      sublabel: `${values.sidecarCpu.toFixed(2)} vCPU · ${values.sidecarShare.toFixed(0)}% of task`,
      detail: `The sidecar provides the proxy or log path. It shares the task's CPU and memory and can consume a large share before the application is throttled. ${
        values.startupOrder === 0
          ? "The application starts before the sidecar is ready, so early requests can fail before the proxy is listening."
          : values.startupOrder === 1
            ? "The application waits for the sidecar to be healthy, so the proxy is ready before traffic arrives."
            : "Both containers start together, so some early requests can race the proxy."
      }`,
      meta: { cpu: values.sidecarCpu, share: values.sidecarShare },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("task-main", "task", "main", values.mainAllocated / MAIN_DEMAND, health, "runs"),
      edge("task-sidecar", "task", "sidecar", values.sidecarCpu / values.taskCpu, sidecarHealth, "runs"),
      edge("main-service", "main", "service", clamp(1 - values.throttle / 100), health, "serves"),
      edge("sidecar-service", "sidecar", "service", values.startupOrder === 0 ? 0.2 : 1, startupHealth, "fronts"),
    ],
    metrics: [
      metric("cpu-throttle", "Application CPU throttled", values.throttle, "%", 10, 30, "percent"),
      metric("p99", "Request p99", values.p99, " ms", 200, 350, "ms"),
      metric("startup-failures", "Requests before sidecar ready", values.startupFailures, "%", 1, 10, "percent"),
      metric("main-cpu-allocated", "Main container CPU allocated", values.mainAllocated, " vCPU", undefined, undefined, "number"),
      metric("task-cpu", "Task CPU", values.taskCpu, " vCPU", undefined, undefined, "number"),
      metric("sidecar-cpu", "Sidecar CPU", values.sidecarCpu, " vCPU", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, throttle: values.throttle, startupOrder: values.startupOrder, essential: values.essential ? 1 : 0 },
    summary: `${values.taskCpu.toFixed(2)} vCPU task with a ${values.sidecarCpu.toFixed(2)} vCPU sidecar; main gets ${values.mainAllocated.toFixed(2)} vCPU, ${values.throttle.toFixed(0)}% throttled, p99 ${values.p99.toFixed(0)} ms.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.6) * Math.max(0.1, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cpu-throttle",
    metricId: "cpu-throttle",
    warn: 10,
    crit: 30,
    title: "The sidecar is consuming the application's CPU budget",
    cause:
      "The task has one CPU budget and every container in it draws from that budget. A proxy, log router, or security agent sized for peak traffic leaves the application container short, so the kernel throttles it and request latency rises.",
    fix:
      "Size the task for the application plus every sidecar, not the application alone. Reduce the sidecar's CPU or move it to a separate task if it does not need to share the network namespace. Recheck the task size after adding or upgrading a sidecar, and alert on application throttling rather than on task CPU alone.",
    checkFirst: [
      "Compare the application's CPU throttling with the sidecar's CPU usage during the same window.",
      "Check the task size and each container's CPU value.",
      "Check whether the sidecar changed version or configuration in the same release.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 200,
    crit: 350,
    title: "Tail latency rose with the sidecar's CPU share",
    cause:
      "CPU throttling delays the application's request handling, and the delay appears in the tail rather than the average. A sidecar that is healthy in its own metrics can still starve the container that serves traffic.",
    fix:
      "Relieve the CPU contention before tuning timeouts. Increase the task CPU, lower the sidecar's share, or split the sidecar into its own task. Confirm that p99 falls after the change, because a timeout increase only hides the throttling.",
    checkFirst: [
      "Check CPU throttling on the application container, not only task-level utilization.",
      "Compare p99 with the sidecar's CPU and memory.",
      "Check whether the regression aligns with a sidecar deployment.",
    ],
  },
  {
    id: "startup-failures",
    metricId: "startup-failures",
    warn: 1,
    crit: 10,
    title: "Requests reach the application before the sidecar is ready",
    cause:
      "The application starts before the proxy sidecar is listening. The task is running but the request path is not complete, so early requests fail even though both containers eventually become healthy.",
    fix:
      "Use a dependsOn condition so the application waits for the sidecar to be healthy, or make the application tolerate a not-ready proxy. For a log router, start the router first. For a proxy, verify readiness with a health check rather than only process start.",
    checkFirst: [
      "Check the task definition's dependsOn conditions and the sidecar health check.",
      "Compare the first request failures with the task start time.",
      "Check whether the sidecar is essential and whether its exit stops the task.",
    ],
  },
];

export const sidecarModel: SimModel = {
  id: "containers-sidecar-patterns",
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
      `The task has ${values.taskCpu.toFixed(2)} vCPU and the sidecar consumes ${values.sidecarCpu.toFixed(2)}. The application is left with ${values.mainAllocated.toFixed(2)} against a ${MAIN_DEMAND.toFixed(2)} vCPU target.`,
      values.throttle > 0
        ? `The gap produces ${values.throttle.toFixed(0)}% application CPU throttling and p99 of about ${values.p99.toFixed(0)} ms. The sidecar is not failing; it is winning the shared budget.`
        : "The application has enough CPU after the sidecar, so the shared budget is not the bottleneck.",
      values.startupOrder === 0
        ? "Starting the application before the proxy means early requests can arrive before the sidecar is listening. A dependsOn health condition is the fix."
        : values.startupOrder === 1
          ? "Waiting for the sidecar to be healthy puts the proxy in front of traffic before the application starts."
          : "Parallel startup saves time and lets some early requests race the sidecar.",
      values.essential
        ? "The sidecar is essential, so its exit stops the whole task. That is appropriate for a proxy that must front every request, and risky for a best-effort log shipper."
        : "The sidecar is not essential, so its exit leaves the application running. That limits blast radius and can leave the request path unproxied.",
      "Sidecar memory is also part of the task size. CPU throttling is the visible symptom here, but a sidecar that grows without a memory limit can OOM the task.",
    ];
  },
  legend: [
    { label: "Sidecar budgeted", tone: "ok" },
    { label: "Application throttled", tone: "warn" },
    { label: "Main container starved", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 4 vCPU task runs a 1 vCPU sidecar, leaving 3 vCPU for a 2 vCPU application after a healthy sidecar start.",
    tone: "ok",
    params: defaults({ taskCpu: 4, sidecarCpu: 1, startupOrder: 1, sidecarEssential: 0 }),
  },
  {
    id: "peak",
    label: "Sidecar at peak",
    description: "A 2 vCPU task gives 0.5 vCPU to the sidecar. The application gets 1.5 vCPU and throttles at 25%.",
    tone: "warn",
    params: defaults({ taskCpu: 2, sidecarCpu: 0.5, startupOrder: 1, sidecarEssential: 1 }),
  },
  {
    id: "failure",
    label: "Main container starved",
    description: "A 1.5 vCPU task gives 1.25 vCPU to the sidecar, leaving 0.25 vCPU for the application.",
    tone: "crit",
    params: defaults({ taskCpu: 1.5, sidecarCpu: 1.25, startupOrder: 1, sidecarEssential: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The task grows to 4 vCPU and the sidecar drops to 0.5 vCPU, leaving 3.5 vCPU for the application.",
    tone: "ok",
    params: defaults({ taskCpu: 4, sidecarCpu: 0.5, startupOrder: 1, sidecarEssential: 0 }),
  },
];

const experiment: Experiment = {
  id: "shared-cpu-budget",
  title: "Predict the application allocation",
  simId: "sidecar-patterns",
  question:
    "A task has 2 vCPU and runs a sidecar that consumes 1 vCPU. The application container needs 2 vCPU at peak. What happens to the application?",
  prediction: {
    options: [
      { id: "full", label: "It still gets 2 vCPU because each container has its own allocation" },
      { id: "throttle", label: "It gets 1 vCPU after the sidecar and is throttled under peak load" },
      { id: "fail", label: "The task fails to start because the containers exceed the task size" },
      { id: "sidecar", label: "The sidecar is throttled first because the application has priority" },
    ],
    correctOptionId: "throttle",
    explanation:
      "The task CPU is the shared boundary. The sidecar's 1 vCPU leaves 1 vCPU for the application, which is half of what it needs at peak. Both containers are running, so the symptom is application CPU throttling and higher tail latency, not a task that refuses to start.",
  },
  setup: defaults({ taskCpu: 2, sidecarCpu: 1, startupOrder: 1, sidecarEssential: 1 }),
  runFor: 20,
  observe: [
    "The application receives 1 vCPU against a 2 vCPU target.",
    "CPU throttling reaches 50% and p99 rises to about 250 ms.",
    "The sidecar is healthy and is not reporting a failure; it is simply using its share.",
    "Increasing the task to 4 vCPU or reducing the sidecar to 0.5 vCPU restores the application.",
  ],
  explain:
    "The sidecar is not beside the task budget; it is inside it. ECS sizes the task once, and every container draws from that CPU and memory. On Fargate the task size is the hard boundary. On EC2 the container CPU values are shares, and the instance is shared with other tasks, so contention can be worse than the task view suggests. Budget the application plus all sidecars at peak.",
  fix: defaults({ taskCpu: 4, sidecarCpu: 0.5, startupOrder: 1, sidecarEssential: 0 }),
  debrief:
    "With 3.5 vCPU left for the application, throttling falls to zero and p99 returns to the baseline. The tradeoff is a larger and more expensive task, or a smaller sidecar with less headroom for its own peak. The right answer is not to remove the sidecar; it is to size the task for the request path, then verify throttling and tail latency after every sidecar change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A sidecar is a second container in the same Amazon Elastic Container Service (ECS) task. It shares the task's CPU, memory, network namespace, and lifecycle. Common sidecars are a service proxy such as Envoy, a log router such as Fluent Bit with FireLens, and a security or configuration agent. The application container and the sidecar are scheduled, started, and stopped together.",
  },
  {
    type: "p",
    text: "The important word is shared. The task size is one budget. If the task has 2 vCPU and the sidecar uses 1, the application has 1 left, regardless of how the container definitions are written. On Fargate the task size is the hard boundary. On EC2 the container CPU values are relative shares and the instance is shared with other tasks, so the same design can behave differently under contention.",
  },
  {
    type: "table",
    headers: ["Decision", "Good default", "Failure it prevents"],
    rows: [
      ["Task size", "Application peak plus every sidecar peak", "Application throttling under sidecar load"],
      ["Startup order", "Proxy or router healthy before the application", "Requests arriving before the sidecar listens"],
      ["Essential flag", "True for a proxy that must front traffic", "Traffic without a proxy after the sidecar exits"],
      ["Memory limit", "Explicit limit for each sidecar", "A growing sidecar OOM-killing the task"],
    ],
  },
  {
    type: "p",
    text: "Sidecars also change the failure surface. An essential sidecar that exits stops the task, even if the application is healthy. A non-essential sidecar can exit quietly and leave the request path without its proxy or log path. Startup order has the same shape: a task can be running while the request path is incomplete. The application sees connection failures, not a task that is down.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Sidecars are declared in the same task definition as the application. The ECS agent creates all the containers in one task, attaches the task's network interface, and starts them according to dependsOn conditions. A proxy sidecar usually needs to start before the application and stay alive for every request. A log router needs to start first so application logs have somewhere to go. A security agent may need to be essential or may be best-effort, depending on what it protects.",
  },
  {
    type: "p",
    text: "The task definition also carries the CPU and memory values that bound the group. Container memory is a hard limit; a sidecar that exceeds its limit can be killed, and an essential sidecar takes the task with it. Container CPU is a share of the task's CPU on EC2 and part of the task size on Fargate. The service sees the task as one unit, so a sidecar problem looks like an application problem until you inspect the containers separately.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Application CPU throttling: the share left after the sidecar consumes its budget.",
      "p99 latency: the request-path symptom of a starved main container.",
      "Startup failures: requests that arrive before the sidecar is ready.",
      "The task, application container, and sidecar as separate nodes, so the shared budget is visible.",
      "The blast radius of a sidecar exit appears in the task detail rather than being averaged into service health.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Sidecar at peak to see the application throttle at 25%. Apply Main container starved to see the request path collapse, then Recovery. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "sidecar-patterns" },
  { type: "experiment", experimentId: "shared-cpu-budget" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset gave most of a small task to the sidecar. The application container had almost no CPU left, so it throttled and p99 rose. The sidecar was healthy and its own metrics looked fine. The service was still receiving traffic, which made the problem look like an application regression rather than a task-sizing decision.",
  },
  {
    type: "p",
    text: "The recovery preset increased the task size and reduced the sidecar's share. The application had more than its target CPU and the throttle fell to zero. The task still paid for the sidecar, but the sidecar no longer set the request-path latency.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Application container CPU throttling while task-level CPU looks acceptable.",
      "p99 rising after a sidecar version or configuration change.",
      "Requests failing at task start before the proxy or log router is ready.",
      "A task stopped because an essential sidecar exited.",
      "Sidecar memory growth that pushes the task toward its memory limit.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare per-container CPU and memory with the task size. Then check the startup order and the essential flags. A healthy sidecar can still be the cause, so do not stop at the sidecar's own health check.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the application's CPU throttling and the sidecar's CPU at the same time.",
      "Resize the task or the sidecar so the application keeps its peak allocation.",
      "Set a dependsOn health condition for a proxy or router that must be ready first.",
      "Decide whether the sidecar is essential and set the flag deliberately.",
      "Set memory limits for the sidecar and verify the task stays below its memory size.",
      "Recheck p99 and throttling after the change, not only task health.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger task protects the application and costs more per task-hour.",
      "A smaller sidecar saves CPU and may not have enough headroom for its own peak.",
      "An essential sidecar keeps the request path complete and makes a sidecar crash a task outage.",
      "A non-essential sidecar limits the blast radius and can leave traffic unproxied or logs undelivered.",
      "A separate task removes CPU contention and loses the shared network namespace and loopback access.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "shared-budget",
    question:
      "A service adds an Envoy sidecar and p99 rises. Task CPU looks the same as before. How do you explain that?",
    difficulty: 2,
    hints: [
      "Task CPU is a shared boundary.",
      "Check per-container throttling, not only the task average.",
    ],
    answer:
      "The sidecar is using part of the same task CPU budget, so the application container has less than it did before even if the task size did not change. Task-level CPU can look moderate while the application container is throttled, because the sidecar's usage is included in the average. I would compare per-container CPU, throttling, and memory with the sidecar's peak, then resize the task or the sidecar. I would also check whether the sidecar added a network hop or a startup dependency.",
    followUps: [
      "How does Fargate change the accounting?",
      "What would you check if the sidecar traffic is low but latency is high?",
      "When would you move the sidecar to a separate task?",
    ],
    redFlags: [
      "Looks only at task-level CPU.",
      "Removes the sidecar without measuring its value.",
      "Raises timeouts instead of relieving throttling.",
    ],
    rubric: [
      "Explains the shared budget.",
      "Checks per-container throttling.",
      "Resizes deliberately.",
      "Considers startup and network effects.",
    ],
  },
  {
    id: "startup-order",
    question:
      "How would you order the start of an application, an Envoy proxy sidecar, and a Fluent Bit log router?",
    difficulty: 3,
    hints: [
      "Logs should have a destination before the application writes.",
      "The proxy should be ready before traffic arrives.",
    ],
    answer:
      "I would start the log router first so application logs have a destination, then the proxy, then the application after the proxy is healthy. In ECS I would express that with dependsOn conditions, using HEALTHY for the proxy if it has a health check and START or SUCCESS for the router depending on what readiness means. I would also decide which sidecars are essential. The application should not depend on a best-effort log shipper to start, but it should not receive traffic before the proxy is ready.",
    followUps: [
      "Which dependsOn conditions does ECS support?",
      "What happens if the log router is essential and exits?",
      "How would you test the startup order?",
    ],
    redFlags: [
      "Starts everything in parallel.",
      "Makes every sidecar essential without a reason.",
      "Uses process start as a proxy readiness signal.",
    ],
    rubric: [
      "Orders router, proxy, application.",
      "Uses dependsOn conditions.",
      "Chooses essential flags deliberately.",
      "Tests readiness, not only start.",
    ],
  },
  {
    id: "essential-choice",
    question:
      "When should a sidecar be essential, and what changes when it is not?",
    difficulty: 2,
    hints: [
      "Essential ties the task lifecycle to the sidecar.",
      "A non-essential sidecar can fail without stopping the application.",
    ],
    answer:
      "A sidecar should be essential when the application cannot serve correctly without it, such as a proxy that must front every request or a security agent that enforces the request path. Then a sidecar exit should stop the task and let the service replace it. A best-effort log shipper or metrics agent can be non-essential, so its failure does not take down the application, but the team has to accept that logs or metrics may be missing. The flag is a blast-radius decision, not a performance setting.",
    followUps: [
      "What does a non-essential sidecar failure look like in the logs?",
      "How does the service replace a task when an essential sidecar exits?",
      "When would you split the sidecar into its own service?",
    ],
    redFlags: [
      "Makes every sidecar essential by default.",
      "Makes a required proxy non-essential without a fallback.",
      "Ignores the observability gap.",
    ],
    rubric: [
      "Ties essential to request-path correctness.",
      "Explains task replacement.",
      "Accepts the non-essential observability gap.",
      "Treats it as a blast-radius choice.",
    ],
  },
];

const checklist = [
  {
    title: "Before adding a sidecar",
    items: [
      "The sidecar's peak CPU and memory are included in the task size.",
      "The startup order and dependsOn conditions match the request path.",
      "The essential flag matches whether the application can serve without it.",
      "The sidecar has its own memory limit and health check.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Compare per-container CPU throttling with task-level CPU.",
      "Check p99 against the sidecar's CPU and memory.",
      "Check startup failures and the dependsOn conditions.",
      "Check whether an essential sidecar exit stopped the task.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Verify p99 and throttling returned to baseline.",
      "Review the task size and cost after the sidecar change.",
      "Test a sidecar exit and confirm the intended blast radius.",
      "Update the runbook with the startup order and essential flags.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS task definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Container definitions, CPU and memory, essential, dependsOn, and task-level sizing.",
  },
  {
    title: "Custom log routing with FireLens",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/firelens-taskdef.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "A log-router sidecar in the task definition and the logConfiguration path.",
  },
  {
    title: "Envoy draining",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/operations/draining",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "How a proxy sidecar drains connections and why shutdown ordering matters.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "sidecar-patterns": {
      model: sidecarModel,
      presets,
      instructions:
        "Start Healthy, then apply Sidecar at peak to see the application throttle. Apply Main container starved to see the shared budget fail, then Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 2 vCPU application demand, the latency curve, and the startup failure rates are teaching values, not ECS limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-cpu-memory-limits",
    "containers-task-definitions",
    "mesh-sidecar-overhead",
    "containers-logs",
  ],
};
