import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TASKS_REPLACED = 4;
const REQUESTS_PER_SECOND = 50;

const params: ParamSpec[] = [
  {
    id: "deregistrationDelay",
    label: "Deregistration delay",
    min: 0,
    max: 300,
    step: 5,
    value: 60,
    unit: "s",
    group: "Load balancer",
    help: "The target group attribute deregistration_delay.timeout_seconds. The load balancer keeps a deregistering target in the draining state for this long before marking it unused.",
    format: "count",
  },
  {
    id: "requestDuration",
    label: "Longest in-flight request",
    min: 1,
    max: 120,
    step: 1,
    value: 20,
    unit: "s",
    group: "Traffic",
    help: "The longest request or stream that can still be running when the task is deregistered. The drain window must cover this time.",
    format: "count",
  },
  {
    id: "stopTimeout",
    label: "Container stop timeout",
    min: 0,
    max: 120,
    step: 1,
    value: 30,
    unit: "s",
    group: "Runtime",
    help: "How long the agent waits after SIGTERM before SIGKILL. This grace only helps when the application handles SIGTERM and keeps serving during shutdown.",
    format: "count",
  },
  {
    id: "sigtermHandled",
    label: "App handles SIGTERM",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Runtime",
    help: "0 means the process exits on SIGTERM without draining. 1 means the application stops accepting new work and finishes in-flight requests.",
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
  delay: number;
  duration: number;
  stopTimeout: number;
  sigterm: boolean;
  available: number;
  shortfall: number;
  cutFraction: number;
  fiveXx: number;
  inFlight: number;
  failedRequests: number;
  health: Health;
}

function compute(p: Params): Computed {
  const delay = Math.round(clamp(num(p, "deregistrationDelay", 60), 0, 300));
  const duration = Math.round(clamp(num(p, "requestDuration", 20), 1, 120));
  const stopTimeout = Math.round(clamp(num(p, "stopTimeout", 30), 0, 120));
  const sigterm = num(p, "sigtermHandled", 1) === 1;
  const available = delay + (sigterm ? stopTimeout : 0);
  const shortfall = Math.max(0, duration - available);
  const cutFraction = clamp(shortfall / duration, 0, 1) * 100;
  const fiveXx = cutFraction * 0.2;
  const inFlight = REQUESTS_PER_SECOND * duration * TASKS_REPLACED;
  const failedRequests = Math.round(inFlight * (cutFraction / 100));
  const health: Health = fiveXx >= 5 || cutFraction >= 25 ? "crit" : cutFraction > 0 ? "warn" : "ok";
  return {
    delay,
    duration,
    stopTimeout,
    sigterm,
    available,
    shortfall,
    cutFraction,
    fiveXx,
    inFlight,
    failedRequests,
    health,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const albHealth: Health = values.fiveXx >= 5 ? "crit" : values.fiveXx > 0 ? "warn" : "ok";
  const taskHealth: Health = values.health;
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Clients",
      kind: "client",
      health: "ok",
      sublabel: "keep-alive connections",
      detail: "Clients reuse connections. A connection that is still open when the task stops receives an error instead of a clean response.",
    },
    {
      id: "alb",
      label: "checkout-alb",
      kind: "lb",
      health: albHealth,
      sublabel: `${values.fiveXx.toFixed(1)}% 5XX`,
      detail:
        values.fiveXx > 0
          ? "The load balancer is still draining the target, but the task stops before the in-flight requests finish. Clients see 502 or 500 responses."
          : "The load balancer stops sending new requests to the deregistering target and lets the existing requests finish before the target becomes unused.",
      meta: { errorRate: values.fiveXx },
    },
    {
      id: "draining-task",
      label: "checkout task (draining)",
      kind: "service",
      role: "instance",
      health: taskHealth,
      utilization: clamp(values.cutFraction / 100),
      sublabel: `${values.cutFraction.toFixed(0)}% of in-flight cut`,
      detail: `The task has ${values.available}s of usable drain window for a request that can last ${values.duration}s. A shortfall of ${values.shortfall}s means the task or the load balancer closes the connection while work remains.`,
      meta: {
        deregistrationDelay: values.delay,
        stopTimeout: values.stopTimeout,
        sigterm: values.sigterm ? 1 : 0,
      },
    },
    {
      id: "replacement-task",
      label: "replacement task",
      kind: "service",
      role: "instance",
      health: "ok",
      utilization: 0.2,
      sublabel: "starting",
      detail: "The replacement task starts before or during the drain. It must pass its target group health check before it receives traffic.",
    },
    {
      id: "runtime",
      label: "ECS container agent",
      kind: "external",
      health: "ok",
      sublabel: values.sigterm ? "SIGTERM, then SIGKILL" : "SIGKILL risk",
      detail: `The agent sends SIGTERM after the target drains and waits ${values.stopTimeout}s before SIGKILL. If the application does not handle SIGTERM, the stop timeout does not save in-flight work.`,
      meta: { stopTimeout: values.stopTimeout },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("client-alb", "client", "alb", 1, "ok", "HTTPS"),
      edge("alb-draining", "alb", "draining-task", 1 - values.cutFraction / 100, albHealth, "in-flight"),
      edge("alb-replacement", "alb", "replacement-task", 0.2, "ok", "new"),
      edge("runtime-draining", "runtime", "draining-task", 1, taskHealth, "stops"),
    ],
    metrics: [
      metric("5xx-rate", "Requests failing during stop", values.fiveXx, "%", 1, 5, "percent"),
      metric("cut-fraction", "In-flight requests cut", values.cutFraction, "%", 1, 25, "percent"),
      metric("drain-shortfall", "Drain window shortfall", values.shortfall, "s", 1, 10, "count"),
      metric("drain-window", "Usable drain window", values.available, "s", undefined, undefined, "count"),
      metric("in-flight-requests", "Requests in flight across replaced tasks", values.inFlight, "", undefined, undefined, "count"),
      metric("failed-requests", "Requests cut during the stop", values.failedRequests, "", undefined, undefined, "count"),
      metric("deregistration-delay", "Deregistration delay", values.delay, "s", undefined, undefined, "count"),
      metric("tasks-replaced", "Tasks replaced per deployment", TASKS_REPLACED, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.cutFraction.toFixed(0)}% of in-flight requests are cut with a ${values.available}s drain window for ${values.duration}s requests. ${values.fiveXx.toFixed(1)}% of requests fail during the stop.`,
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
    id: "5xx-rate",
    metricId: "5xx-rate",
    warn: 1,
    crit: 5,
    title: "The stop sequence is cutting client requests",
    cause:
      "The task or the load balancer closes connections while requests are still in flight. A deregistration delay shorter than the longest request, a process that exits on SIGTERM, or a stop timeout that expires early can all produce 502 and 500 responses during an otherwise healthy rollout.",
    fix:
      "Set the target group deregistration delay above the longest request or stream, add SIGTERM handling that stops accepting new work, and keep the stop timeout long enough for the shutdown path. Then watch the 5XX rate during the next replacement.",
    checkFirst: [
      "Compare the target group deregistration delay with the p99 and maximum request duration.",
      "Check whether the application traps SIGTERM and finishes in-flight requests.",
      "Read the ALB access log for the failing request and the time between deregistration and task stop.",
    ],
  },
  {
    id: "cut-fraction",
    metricId: "cut-fraction",
    warn: 1,
    crit: 25,
    title: "A large share of in-flight work is cut at stop",
    cause:
      "The usable drain window is shorter than the request duration. The gap can come from the deregistration delay, a missing SIGTERM handler, or a stop timeout that is too short for the application shutdown path.",
    fix:
      "Increase the deregistration delay or the stop timeout, and make the application drain connections on SIGTERM. Measure the real request duration before choosing the timeout, because long uploads and streams dominate the tail.",
    checkFirst: [
      "Measure the longest request or stream that the service handles.",
      "Check the target group deregistration delay and the container stop timeout together.",
      "Confirm the application stops accepting new requests when it receives SIGTERM.",
    ],
  },
  {
    id: "drain-shortfall",
    metricId: "drain-shortfall",
    warn: 1,
    crit: 10,
    title: "The drain window does not cover the request tail",
    cause:
      "The combined deregistration and shutdown window is shorter than the longest request. Requests that started just before deregistration still need time to finish after the target leaves rotation.",
    fix:
      "Raise the deregistration delay to at least the maximum request duration plus a margin, and keep the stop timeout aligned with the application shutdown path. Do not shorten either value to make deployments faster unless the request tail is also short.",
    checkFirst: [
      "Compare the drain window with the maximum request duration from the load balancer or application metrics.",
      "Check whether a deployment or scale-in event lines up with the 5XX spike.",
      "Confirm that the target reaches the unused state before the task stop begins.",
    ],
  },
];

export const drainingModel: SimModel = {
  id: "containers-draining",
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
      `The drain window is ${values.available}s: ${values.delay}s of deregistration delay plus ${values.sigterm ? values.stopTimeout : 0}s of stop timeout. The longest request is ${values.duration}s.`,
      values.shortfall > 0
        ? `The window is ${values.shortfall}s short. Requests that started just before deregistration are still running when the task or the load balancer closes the connection.`
        : "The drain window covers the request tail. The load balancer can stop routing new requests while the task finishes the ones already accepted.",
      values.sigterm
        ? "A process that handles SIGTERM can stop accepting new work, finish in-flight requests, and exit before the stop timeout expires."
        : "A process that exits on SIGTERM gives up its remaining work even when the stop timeout is generous. The timeout is a backstop, not a drain.",
      "The deployment can look healthy at the service level while a small share of requests fails during each task replacement. Watch the 5XX rate at the load balancer, not only task health.",
    ];
  },
  legend: [
    { label: "Drain covered", tone: "ok" },
    { label: "Partial request loss", tone: "warn" },
    { label: "Requests cut", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 60-second deregistration delay plus a 30-second stop timeout covers a 20-second request tail.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak request tail",
    description: "A 40-second request tail meets a 30-second deregistration delay and a 5-second stop timeout. Some requests are cut.",
    tone: "warn",
    params: defaults({ deregistrationDelay: 30, requestDuration: 40, stopTimeout: 5, sigtermHandled: 1 }),
  },
  {
    id: "failure",
    label: "No drain window",
    description: "Zero deregistration delay and no SIGTERM handling stop the task immediately while 40-second requests are in flight.",
    tone: "crit",
    params: defaults({ deregistrationDelay: 0, requestDuration: 40, stopTimeout: 0, sigtermHandled: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The deregistration delay and stop timeout cover the request tail, and the app drains on SIGTERM.",
    tone: "ok",
    params: defaults({ deregistrationDelay: 60, requestDuration: 20, stopTimeout: 30, sigtermHandled: 1 }),
  },
];

const experiment: Experiment = {
  id: "drain-before-stop",
  title: "Drain before stop",
  simId: "draining",
  question:
    "Longest requests take 40 seconds. Deregistration delay is 0, stop timeout is 0, and the app handles SIGTERM. Which change removes the 502s during task replacement?",
  prediction: {
    options: [
      { id: "timeout", label: "Raise the stop timeout to 30 seconds" },
      { id: "delay", label: "Set the deregistration delay to 60 seconds" },
      { id: "count", label: "Add more tasks so the load balancer has spare capacity" },
      { id: "health", label: "Disable the target group health check during deployments" },
    ],
    correctOptionId: "delay",
    explanation:
      "The task must stay registered and draining long enough for the in-flight requests to finish. With a zero deregistration delay the target leaves rotation immediately, so there is no window for the 40-second tail. A longer stop timeout comes after deregistration and cannot recover requests that were already cut.",
  },
  setup: defaults({ deregistrationDelay: 0, requestDuration: 40, stopTimeout: 0, sigtermHandled: 1 }),
  runFor: 10,
  observe: [
    "The usable drain window is zero seconds and the request tail is 40 seconds.",
    "Every in-flight request is cut, and the load balancer error rate is 20%.",
    "The 5XX threshold is critical and the draining task is failing.",
    "Adding tasks does not change the per-target drain window.",
  ],
  explain:
    "Draining is a property of each target, not of the fleet size. The load balancer stops sending new requests when the target is deregistered, but requests that are already running need time to finish. The deregistration delay keeps the target in the draining state for that time. A stop timeout is a later backstop for the process, so raising it alone does not restore requests that the load balancer has already closed.",
  fix: defaults({ deregistrationDelay: 60, requestDuration: 40, stopTimeout: 30, sigtermHandled: 1 }),
  debrief:
    "With a 60-second deregistration delay, the 40-second request tail finishes before the target becomes unused. The tradeoff is deployment time: every replacement waits for the drain window, so a 60-second delay adds up across a large rollout. Size the delay from the real request tail and use SIGTERM handling to make the stop timeout useful, rather than setting both to zero to make deployments feel fast.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Draining is the step between deciding to stop a task and actually stopping it. When an Amazon Elastic Container Service (ECS) task is replaced or scaled in, the service deregisters the task from its target group, the load balancer stops sending new requests, and ECS waits for the target to leave the draining state before it stops the task. The wait is controlled by the target group deregistration delay.",
  },
  {
    type: "p",
    text: "The stop sequence has two clocks. The deregistration delay controls how long the load balancer keeps the target in the draining state and lets in-flight requests finish. The container stop timeout controls how long the agent waits after SIGTERM before SIGKILL. If either clock is shorter than the work still in flight, clients see 502 or 500 responses during a rollout that otherwise looks healthy.",
  },
  {
    type: "table",
    headers: ["Step", "Owner", "Signal", "What goes wrong"],
    rows: [
      ["Deregister", "ECS service scheduler", "Target enters draining", "The task stops before the target leaves rotation"],
      ["Drain", "ALB target group", "deregistration_delay.timeout_seconds", "The connection closes while a request is still running"],
      ["Stop signal", "Container runtime", "SIGTERM or the image STOPSIGNAL", "The process exits without finishing in-flight work"],
      ["Stop timeout", "ECS container agent", "ECS_CONTAINER_STOP_TIMEOUT", "SIGKILL cuts the remaining shutdown path"],
      ["Replace", "ECS service scheduler", "Replacement task healthy", "Capacity dips while the old task is still draining"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, target group, task, and container process. ECS owns deregistration and the stop decision. The target group owns the deregistration delay. The container owns SIGTERM handling and the shutdown path. A healthy task that has not been deregistered can still be serving, and a deregistered task can still be finishing requests, so the task state and the target state are not the same thing.",
  },
  {
    type: "p",
    text: "ECS sends the stop signal after the target drains and waits for the stop timeout before SIGKILL. The application has to cooperate: it should stop accepting new work on SIGTERM and finish what it has. An application that exits immediately gives up its in-flight requests, and a stop timeout cannot bring them back.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The usable drain window, built from the deregistration delay and the stop timeout.",
      "The drain shortfall against the longest request or stream.",
      "The share of in-flight requests cut and the resulting 5XX rate.",
      "The draining task, the replacement task, and the agent that sends SIGTERM and SIGKILL.",
      "A deployment that can show healthy tasks while a small share of requests fails.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Peak request tail to see a small shortfall. Apply No drain window to cut every in-flight request, then Recovery to cover the request tail. Watch the 5XX rate rather than the task count. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "draining" },
  { type: "experiment", experimentId: "drain-before-stop" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure happened after the task was already healthy. The target was deregistered, but the drain window was shorter than the requests still running, so the task or the load balancer closed the connection before the work finished. The service-level task count looked correct because the replacement task was starting at the same time.",
  },
  {
    type: "p",
    text: "Lengthening the deregistration delay moved the stop later and let the request tail finish. The stop timeout only helped because the application handled SIGTERM. Without that handler, the process would have exited at the stop signal and the extra timeout would not have preserved the requests.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ALB access logs: 502 or 500 responses clustered around a deployment or scale-in event.",
      "Target health: the target transitions from healthy to draining to unused while the task is still running.",
      "ECS service events: task replacement and stop events that line up with the error spike.",
      "Application logs: whether SIGTERM was received and whether the shutdown path completed.",
      "Request duration metrics: the p99 and maximum, not only the average, because the tail sets the drain requirement.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the target group deregistration delay with the longest request or stream. Then confirm the application handles SIGTERM and the stop timeout matches its shutdown path. Do not start by adding tasks; a larger fleet does not extend a single target's drain window.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the longest request or stream the service handles, including uploads and long-lived connections.",
      "Set the target group deregistration delay above that tail with margin.",
      "Stop accepting new work on SIGTERM and finish in-flight requests.",
      "Set the container stop timeout to cover the application shutdown path.",
      "Watch the 5XX rate and target state through the next replacement.",
      "Shorten the delay only after the request tail is genuinely shorter.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A long deregistration delay protects long requests, but it slows every deployment and scale-in.",
      "A short delay speeds replacements at the risk of cutting the tail.",
      "SIGTERM handling adds application work, but it makes the stop timeout useful.",
      "Keep-alive connections reduce handshake cost and keep draining targets busy longer.",
      "A rollout that replaces tasks slowly is easier to drain safely but takes more wall-clock time.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "drain-sequence",
    question:
      "A deployment causes a small number of 502s each time a task is replaced. What is the drain sequence, and where would you look first?",
    difficulty: 2,
    hints: [
      "The task is deregistered before it is stopped.",
      "The target group has a deregistration delay, and the container has a stop timeout.",
    ],
    answer:
      "ECS deregisters the task from the target group, the load balancer stops sending new requests and keeps the target in the draining state, then ECS stops the task after the target drains. I would compare the deregistration delay with the longest request or stream, because a delay shorter than the request tail cuts connections while work is still running. Then I would check whether the application handles SIGTERM and finishes in-flight requests, and whether the stop timeout covers the shutdown path. The 502s are per-target request loss, so adding tasks does not fix them.",
    followUps: [
      "What does the target state draining mean?",
      "Why can a longer stop timeout fail to fix the 502s?",
      "How would you measure the request tail before choosing a delay?",
    ],
    redFlags: [
      "Blaming the application without checking the drain window.",
      "Raising the desired count to hide the errors.",
      "Setting the deregistration delay to zero to speed up deployments.",
    ],
    rubric: [
      "Orders deregistration, drain, stop, and replacement.",
      "Compares the delay with the request tail.",
      "Checks SIGTERM handling and stop timeout.",
      "Avoids confusing task health with request completion.",
    ],
  },
  {
    id: "stop-timeout",
    question:
      "The deregistration delay is 300 seconds and the stop timeout is 30 seconds. The app ignores SIGTERM. Are in-flight requests safe?",
    difficulty: 2,
    hints: [
      "The load balancer waits for the target to drain before the task stops.",
      "SIGTERM handling determines whether the process finishes its work.",
    ],
    answer:
      "The deregistration delay gives the load balancer time to stop routing new requests and let existing requests finish. If 300 seconds covers the request tail, most in-flight requests should complete before the task is stopped. The stop timeout is a later backstop: if the app ignores SIGTERM, the agent sends SIGKILL after 30 seconds, so any shutdown work that is still running is cut. The requests are probably safe because of the drain, but the shutdown path is not. I would still add SIGTERM handling so the process can close listeners and exit cleanly.",
    followUps: [
      "What happens to a request that starts just before deregistration?",
      "Why is the stop timeout not a substitute for the deregistration delay?",
      "Which signal does the container image control with STOPSIGNAL?",
    ],
    redFlags: [
      "Says the stop timeout drains the load balancer.",
      "Assumes SIGKILL lets the process finish.",
      "Ignores the difference between request drain and process shutdown.",
    ],
    rubric: [
      "Separates load balancer drain from process stop.",
      "Explains SIGTERM and SIGKILL.",
      "Identifies the request tail as the constraint.",
      "Recommends graceful shutdown anyway.",
    ],
  },
  {
    id: "tune-drain",
    question:
      "How would you choose a deregistration delay for a service with a 200 ms median and occasional 45-second file uploads?",
    difficulty: 3,
    hints: [
      "The median does not set the drain requirement.",
      "The longest request or stream sets the lower bound.",
    ],
    answer:
      "I would size the delay from the tail, not the median. The occasional 45-second upload means the delay must be above 45 seconds with margin, otherwise an upload that starts just before deregistration is cut. I would measure the real maximum and p99 over a full traffic cycle, including large files and slow clients, then set the delay above that value. I would also make the upload path handle SIGTERM and finish or fail cleanly, and watch the 5XX rate during a canary replacement. A long delay increases deployment time, so the value should be justified by the request distribution rather than a round number.",
    followUps: [
      "How would a streaming connection change the answer?",
      "What would you do if the upload can take minutes?",
      "How does the stop timeout interact with the delay here?",
    ],
    redFlags: [
      "Uses the median request duration.",
      "Sets a short delay because most requests are fast.",
      "Ignores long-lived connections.",
    ],
    rubric: [
      "Sizes from the tail.",
      "Mentions uploads and streams.",
      "Includes SIGTERM handling.",
      "Accounts for deployment time.",
    ],
  },
];

const checklist = [
  {
    title: "Before the rollout",
    items: [
      "Measure the longest request or stream, including uploads and long-lived connections.",
      "Set the target group deregistration delay above that tail with margin.",
      "Confirm the application handles SIGTERM and stops accepting new work.",
      "Set the container stop timeout to cover the shutdown path.",
      "Know the expected 5XX rate for a healthy replacement.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch target state draining and the task stop event on the same timeline.",
      "Compare 5XX responses with task replacement times.",
      "Check that the replacement task becomes healthy before the old target is unused.",
      "Do not add tasks to compensate for per-target request loss.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Confirm the 5XX rate returned to baseline.",
      "Record the request tail, deregistration delay, and stop timeout.",
      "Review application logs for SIGTERM and shutdown completion.",
      "Add the drain check to the deployment checklist.",
    ],
  },
];

const references = [
  {
    title: "Optimize load balancer connection draining parameters for Amazon ECS",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/load-balancer-connection-draining.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Deregistration delay, the UNUSED state, and SIGTERM responsiveness.",
  },
  {
    title: "Edit target group attributes",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Deregistration delay behavior and the draining to unused transition.",
  },
  {
    title: "Deploy Amazon ECS services by replacing tasks",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Rolling deployment behavior, minimum healthy percent, and maximum percent.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    draining: {
      model: drainingModel,
      presets,
      instructions:
        "Start Healthy, apply Peak request tail, then No drain window. Compare the drain window with the request tail, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Fifty requests per second, four replaced tasks, the 20% request-error conversion, and the slider ranges are teaching values, not service limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-connection-draining",
    "containers-health-checks",
    "containers-rolling-deployments",
    "containers-alb-target-registration",
  ],
};
