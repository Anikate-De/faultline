import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DESIRED = 12;

const params: ParamSpec[] = [
  {
    id: "spotShare",
    label: "Spot share of flexible tasks",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
    group: "Fleet",
    help: "Share of the tasks beyond the on-demand base that use FARGATE_SPOT. The rest use FARGATE.",
    format: "percent",
  },
  {
    id: "onDemandBase",
    label: "On-demand base",
    min: 0,
    max: 10,
    step: 1,
    value: 4,
    unit: " tasks",
    group: "Fleet",
    help: "Tasks guaranteed on FARGATE before the Spot share is applied. This is the minimum healthy floor when Spot capacity disappears.",
    format: "count",
  },
  {
    id: "drainSeconds",
    label: "Graceful stop window",
    min: 0,
    max: 120,
    step: 10,
    value: 120,
    unit: " s",
    group: "Drain",
    help: "The task's stopTimeout, bounded by the two-minute Fargate Spot warning. The application must handle SIGTERM and finish in-flight work within this window.",
    format: "number",
  },
  {
    id: "interruptions",
    label: "Tasks interrupted",
    min: 0,
    max: 6,
    step: 1,
    value: 0,
    unit: " tasks",
    group: "Failure",
    help: "Spot tasks interrupted in this window. Only tasks on FARGATE_SPOT can be interrupted; the on-demand base is unaffected.",
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
  spotShare: number;
  base: number;
  drainSeconds: number;
  interruptions: number;
  spot: number;
  onDemand: number;
  interrupted: number;
  drainSuccess: number;
  undrained: number;
  available: number;
  shortfall: number;
  shortfallPct: number;
  lostRequests: number;
  spotExposure: number;
  costIndex: number;
}

function compute(p: Params): Values {
  const spotShare = Math.round(clamp(num(p, "spotShare", 50), 0, 100));
  const base = Math.min(DESIRED, Math.round(clamp(num(p, "onDemandBase", 4), 0, 10)));
  const drainSeconds = clamp(num(p, "drainSeconds", 120), 0, 120);
  const interruptions = Math.round(clamp(num(p, "interruptions", 0), 0, 6));
  const remaining = DESIRED - base;
  const spot = Math.round((remaining * spotShare) / 100);
  const onDemand = DESIRED - spot;
  const interrupted = Math.min(spot, interruptions);
  const drainSuccess = (drainSeconds / 120) * 100;
  const undrained = interrupted * (1 - drainSuccess / 100);
  const available = DESIRED - interrupted;
  const shortfall = DESIRED - available;
  return {
    spotShare,
    base,
    drainSeconds,
    interruptions,
    spot,
    onDemand,
    interrupted,
    drainSuccess,
    undrained,
    available,
    shortfall,
    shortfallPct: (shortfall / DESIRED) * 100,
    lostRequests: (undrained / DESIRED) * 100,
    spotExposure: (spot / DESIRED) * 100,
    costIndex: ((onDemand + spot * 0.35) / DESIRED) * 100,
  };
}

function healthOf(values: Values): Health {
  if (values.shortfallPct >= 25 || values.lostRequests >= 5) return "crit";
  if (values.shortfallPct > 0 || values.spotExposure >= 70 || values.undrained > 0) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const spotHealth: Health =
    values.interrupted === 0 ? "ok" : values.undrained > 0 ? "crit" : "warn";
  const interruptedHealth: Health =
    values.interrupted === 0 ? "ok" : values.undrained > 0 ? "crit" : "warn";
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.available / DESIRED),
      sublabel: `desired ${DESIRED} · ${values.available} available`,
      detail: `The service wants ${DESIRED} tasks. ${values.base} run on FARGATE as a base, and the remaining tasks split between the two Fargate providers. ${
        values.interrupted > 0
          ? `${values.interrupted} Spot tasks are interrupted in this window, so ${values.available} tasks are available until replacement capacity is placed.`
          : "No Spot interruption is active in this window."
      }`,
      meta: { desired: DESIRED, available: values.available },
    },
    {
      id: "on-demand",
      label: "FARGATE",
      kind: "service",
      health: "ok",
      utilization: clamp(values.onDemand / DESIRED),
      sublabel: `${values.onDemand} tasks · protected base ${values.base}`,
      detail: `The on-demand tasks are not interrupted by a Spot event. The base is the part of the service that remains available even when Fargate Spot capacity disappears.`,
      meta: { tasks: values.onDemand, base: values.base },
    },
    {
      id: "spot",
      label: "FARGATE_SPOT",
      kind: "service",
      health: spotHealth,
      utilization: clamp(values.spot / DESIRED),
      sublabel:
        values.interrupted > 0
          ? `${values.spot} tasks · ${values.interrupted} interrupted`
          : `${values.spot} tasks · no interruption`,
      detail: `Fargate Spot runs on spare capacity. The two-minute warning arrives as an EventBridge task state change and as SIGTERM. The service scheduler tries to replace interrupted tasks on Fargate Spot when capacity is available; it does not move them to FARGATE automatically.`,
      meta: { tasks: values.spot, interrupted: values.interrupted },
    },
    {
      id: "interrupted",
      label: "Interrupted tasks",
      kind: "external",
      health: interruptedHealth,
      utilization: clamp(values.interrupted / DESIRED),
      sublabel:
        values.interrupted === 0
          ? "none in this window"
          : `${values.interrupted} interrupted · ${values.undrained.toFixed(1)} not drained`,
      detail:
        values.interrupted === 0
          ? "No Spot task is interrupted, so the graceful stop path is idle."
          : `${values.interrupted} tasks received the two-minute warning. With a ${values.drainSeconds.toFixed(0)}-second stop window, ${values.drainSuccess.toFixed(0)}% of in-flight work can finish. The remaining ${values.undrained.toFixed(1)} task-equivalents are cut when the container is stopped.`,
      meta: { interrupted: values.interrupted, undrained: values.undrained },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("ondemand-service", "on-demand", "service", values.onDemand / DESIRED, "ok", "serves"),
      edge("spot-service", "spot", "service", values.spot / DESIRED, spotHealth, "serves"),
      edge("spot-interrupted", "spot", "interrupted", values.interrupted / DESIRED, interruptedHealth, "warns"),
    ],
    metrics: [
      metric("capacity-shortfall", "Capacity shortfall during interruption", values.shortfallPct, "%", 10, 25, "percent"),
      metric("lost-in-flight", "In-flight work lost", values.lostRequests, "%", 1, 5, "percent"),
      metric("spot-exposure", "Spot share of the service", values.spotExposure, "%", 70, 90, "percent"),
      metric("available-tasks", "Available tasks", values.available, " tasks", undefined, undefined, "count"),
      metric("interrupted-tasks", "Interrupted tasks", values.interrupted, " tasks", undefined, undefined, "count"),
      metric("relative-cost", "Relative cost vs all on-demand", values.costIndex, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, spot: values.spot, interrupted: values.interrupted },
    summary: `${values.onDemand} on-demand and ${values.spot} Spot tasks; ${values.interrupted} interrupted; ${values.available} available; ${values.lostRequests.toFixed(1)}% in-flight work lost.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin((index + (seed % 8)) / 2.4) * Math.max(0.1, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "capacity-shortfall",
    metricId: "capacity-shortfall",
    warn: 10,
    crit: 25,
    title: "An interruption removed more capacity than the base covers",
    cause:
      "Too many tasks were on Fargate Spot and the on-demand base was too small. A Spot interruption removes tasks at once, and the service scheduler can replace them only when Fargate Spot capacity is available. Fargate does not replace Spot capacity with on-demand capacity automatically.",
    fix:
      "Raise the FARGATE base to the minimum healthy count, lower the Spot share, or reduce the desired count during the shortage. For a service that must stay at full capacity, keep the entire floor on FARGATE and treat Spot as burst capacity.",
    checkFirst: [
      "Check how many tasks were on FARGATE_SPOT and how many were interrupted.",
      "Check the service's base and weights, and whether the base is on FARGATE.",
      "Check service events for replacement tasks that are waiting for Spot capacity.",
    ],
  },
  {
    id: "lost-in-flight",
    metricId: "lost-in-flight",
    warn: 1,
    crit: 5,
    title: "In-flight work is cut during the graceful stop",
    cause:
      "The task received SIGTERM but did not finish its work before stopTimeout expired. The default stopTimeout is 30 seconds, and the application may not handle SIGTERM at all. The two-minute warning gives more time only if the stop window and the application use it.",
    fix:
      "Handle SIGTERM in the application, stop accepting new work, and finish or checkpoint in-flight work within the stop window. Set stopTimeout to match the real drain time, up to 120 seconds, and test the path with a deliberate interruption. Make retries idempotent for work that cannot finish.",
    checkFirst: [
      "Check the container's stopTimeout and whether the application handles SIGTERM.",
      "Compare the interruption time with the last successful request or checkpoint.",
      "Check for duplicate side effects after the replacement task retries the work.",
    ],
  },
  {
    id: "spot-exposure",
    metricId: "spot-exposure",
    warn: 70,
    crit: 90,
    title: "Too much of the service depends on interruptible capacity",
    cause:
      "The Spot share is high enough that one interruption event can remove most of the service. Fargate Spot is discounted because the capacity can be reclaimed, so a high share is a deliberate availability trade, not a free saving.",
    fix:
      "Keep the minimum healthy floor on FARGATE and move only interruption-tolerant work to Spot. For a stateless service, use retries and a load balancer that can absorb fewer tasks. For stateful work, checkpoint before the stop window and expect the task to disappear.",
    checkFirst: [
      "Check the percentage of tasks on FARGATE_SPOT and the base on FARGATE.",
      "Check whether the service can serve correctly with the base alone.",
      "Check the cost difference against the availability requirement.",
    ],
  },
];

export const fargateSpotModel: SimModel = {
  id: "containers-fargate-spot",
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
      `The service has ${values.base} tasks on the FARGATE base and ${values.spot} on FARGATE_SPOT. ${values.interrupted} Spot tasks are interrupted in this window.`,
      values.interrupted > 0
        ? `Available capacity falls to ${values.available} of ${DESIRED}. The base covers ${Math.min(values.base, values.available)} tasks, so the shortfall is ${values.shortfallPct.toFixed(0)}%.`
        : "No interruption is active. The Spot share is still an availability exposure, not a cost-free choice.",
      `The graceful stop window is ${values.drainSeconds.toFixed(0)} seconds. ${values.drainSuccess.toFixed(0)}% of in-flight work can finish before the container is stopped; ${values.lostRequests.toFixed(1)}% is lost.`,
      values.spotExposure >= 70
        ? "Most of the service depends on interruptible capacity. A single event can remove the majority of the tasks, and Fargate does not silently replace them with on-demand capacity."
        : "The Spot share is bounded, so an interruption removes a minority of the service. The base still determines the worst-case availability.",
      "The service scheduler tries to replace interrupted Spot tasks on Spot when capacity is available. A task that must always be there belongs on FARGATE or needs a strategy that does not depend on Spot.",
    ];
  },
  legend: [
    { label: "Within the base", tone: "ok" },
    { label: "Spot exposed", tone: "warn" },
    { label: "Capacity or work lost", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Four tasks on the FARGATE base, four on Spot, a full stop window, and no interruption.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Spot-heavy",
    description: "Nine of twelve tasks run on FARGATE_SPOT, leaving only three on-demand tasks as the floor.",
    tone: "warn",
    params: defaults({ spotShare: 90, onDemandBase: 2, drainSeconds: 120, interruptions: 0 }),
  },
  {
    id: "failure",
    label: "Interrupted with no drain",
    description: "Eleven tasks are on Spot, six are interrupted, and the 30-second stop window cuts most in-flight work.",
    tone: "crit",
    params: defaults({ spotShare: 100, onDemandBase: 1, drainSeconds: 30, interruptions: 6 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The on-demand base covers most of the service, the Spot share is small, and the stop window is full.",
    tone: "ok",
    params: defaults({ spotShare: 50, onDemandBase: 5, drainSeconds: 120, interruptions: 0 }),
  },
  {
    id: "on-demand-floor",
    label: "On-demand floor",
    description: "Ten tasks are protected on FARGATE. Two Spot tasks are interrupted, but nothing in flight is lost.",
    tone: "warn",
    params: defaults({ spotShare: 100, onDemandBase: 10, drainSeconds: 120, interruptions: 2 }),
  },
];

const experiment: Experiment = {
  id: "stop-window-versus-notice",
  title: "Predict what happens to in-flight work",
  simId: "fargate-spot",
  question:
    "A Fargate Spot task gets the two-minute interruption warning. The application needs 90 seconds to finish in-flight work, but its stopTimeout is 30 seconds. What happens?",
  prediction: {
    options: [
      { id: "full", label: "The task gets the full two minutes because the warning is two minutes" },
      { id: "cut", label: "SIGTERM starts the stop, the 30-second window expires, and the remaining work is cut" },
      { id: "move", label: "ECS moves the task to FARGATE and finishes the work there" },
      { id: "ignore", label: "The warning is informational and does not affect the container" },
    ],
    correctOptionId: "cut",
    explanation:
      "The two-minute warning is the notice, not the stop window. ECS sends SIGTERM, waits for stopTimeout, then sends SIGKILL. With stopTimeout at 30 seconds, the application has 30 seconds to drain even though the warning arrived earlier. A 90-second drain needs a stop window close to the warning and an application that handles SIGTERM.",
  },
  setup: defaults({ spotShare: 100, onDemandBase: 4, drainSeconds: 30, interruptions: 1 }),
  runFor: 20,
  observe: [
    "One Spot task is interrupted, so available capacity drops to eleven.",
    "Only 25% of the in-flight work fits in the 30-second stop window.",
    "In-flight loss crosses 5% and the graceful-stop threshold is critical.",
    "A 120-second window keeps the same capacity shortfall but loses no in-flight work.",
  ],
  explain:
    "Fargate Spot gives the account a two-minute task state change event and sends SIGTERM to the container. The container's stopTimeout controls how long ECS waits before SIGKILL. Those are separate timers. The application must handle SIGTERM, stop accepting new work, and finish or checkpoint within stopTimeout. If the work cannot finish, the retry path must be idempotent.",
  fix: defaults({ spotShare: 50, onDemandBase: 5, drainSeconds: 120, interruptions: 0 }),
  debrief:
    "The recovery preset keeps a larger on-demand floor and lowers the Spot share. The stop window is full, so an interruption that does occur has time to drain. The tradeoff is cost: more on-demand tasks and fewer Spot tasks. That is the right direction when the service must keep serving through an interruption, and the wrong direction when the work is stateless and can be retried cheaply.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Fargate Spot is an AWS Fargate capacity provider that runs tasks on spare compute at a discount. It is associated with a cluster and used in a capacity provider strategy with the FARGATE provider. The price is lower because AWS can reclaim the capacity. When it does, the task receives a two-minute warning as an EventBridge task state change event and as a SIGTERM signal, then it is stopped.",
  },
  {
    type: "p",
    text: "The two-minute warning is notice, not a grace period extension. The container's stopTimeout controls how long ECS waits after SIGTERM before sending SIGKILL. The default is 30 seconds, and the maximum is 120 seconds. An application that needs 90 seconds to drain must both set a longer stop window and handle SIGTERM. Otherwise the warning arrives, the task is still killed early, and the in-flight work is cut.",
  },
  {
    type: "compare",
    leftTitle: "FARGATE",
    rightTitle: "FARGATE_SPOT",
    rows: [
      { label: "Capacity", left: "On-demand Fargate", right: "Spare Fargate capacity" },
      { label: "Price", left: "Higher", right: "Discounted" },
      { label: "Interruption", left: "No Spot interruption", right: "Two-minute warning, then stop" },
      { label: "Best fit", left: "Minimum healthy floor, stateful work", right: "Stateless, retryable, drainable work" },
      { label: "Failure mode", left: "Provider capacity or quota", right: "Capacity disappears during demand" },
    ],
  },
  {
    type: "p",
    text: "Fargate Spot does not expose the underlying instance, so there is no instance to drain or cordon. The unit of loss is the task. A service keeps a desired count and tries to replace the interrupted tasks, but the replacement is another Spot task. If Spot capacity is unavailable, the service waits. Fargate does not replace Spot capacity with on-demand capacity automatically, which is why the base on FARGATE matters.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Fargate Spot sits behind a capacity provider strategy. Base and weight decide how many tasks use FARGATE and how many use FARGATE_SPOT. The cluster must associate both providers before the strategy can use them. A strategy can contain Fargate providers or Auto Scaling group providers, but not both families. The service sees the task lifecycle, not the spare-capacity pool.",
  },
  {
    type: "p",
    text: "At interruption time, the task state change event is delivered to EventBridge, and the container receives SIGTERM. The application stops accepting new work and finishes or checkpoints what it has. If it exits before stopTimeout, the task stops cleanly. If not, SIGKILL ends it. The load balancer removes the task as it stops, so a drain-aware application can finish requests without new ones arriving. The service then places a replacement, subject to Spot capacity.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Capacity shortfall: tasks that are unavailable while interrupted Spot capacity is replaced.",
      "In-flight work lost: the share that did not finish inside the stop window.",
      "Spot exposure: how much of the service depends on interruptible capacity.",
      "Available tasks and interrupted tasks, so the base floor is visible during the event.",
      "Relative cost: an illustrative comparison with an all-on-demand fleet, not an AWS price.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Spot-heavy to see the exposure without an interruption. Apply Interrupted with no drain to lose capacity and in-flight work, then Recovery. Apply On-demand floor to see a small interruption with no lost work. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "fargate-spot" },
  { type: "experiment", experimentId: "stop-window-versus-notice" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset put almost the whole service on Spot and used a short stop window. Six tasks were interrupted at once, leaving only the one-task on-demand base. The application had 30 seconds to drain, so most in-flight work was cut. The service tried to replace the Spot tasks, but replacement depended on Spot capacity, not on the on-demand base.",
  },
  {
    type: "p",
    text: "The recovery preset moved more of the service to FARGATE and reduced the Spot share. An interruption still removes tasks, but the base covers the minimum healthy count and the stop window gives the application time to finish. The cost rose, which is the explicit trade for availability.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "An EventBridge task state change event with a Spot interruption reason and stop code.",
      "Tasks stopping in a batch rather than one at a time.",
      "Service events for replacement tasks that are waiting for Spot capacity.",
      "In-flight requests failing near the interruption time, especially with the default 30-second stopTimeout.",
      "A cost drop that tracks a higher Spot share, followed by an availability incident when capacity is reclaimed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the FARGATE base before the Spot share. The base is what remains when Spot capacity disappears. Then check stopTimeout and whether the application handles SIGTERM. Do not add retries until you know whether the work was cut before or after its side effect.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify how many tasks were on Spot and how many were interrupted.",
      "Raise the on-demand base to the minimum healthy count.",
      "Handle SIGTERM: stop accepting work, drain, and checkpoint before the window closes.",
      "Set stopTimeout to match the real drain time, up to 120 seconds.",
      "Make retries idempotent for work that cannot finish inside the window.",
      "Verify the interruption path with a controlled test and compare the cost change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger Spot share lowers cost and increases the capacity removed by one interruption.",
      "A larger on-demand base protects availability and reduces the discount.",
      "A longer stop window gives the application time to drain and delays task replacement.",
      "A shorter stop window replaces tasks faster and cuts more in-flight work.",
      "Stateless, idempotent work tolerates Spot well; stateful work needs checkpointing or on-demand capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "two-minute-warning",
    question:
      "A Fargate Spot task gets a two-minute interruption warning. Does the application automatically have two minutes to finish?",
    difficulty: 2,
    hints: [
      "The warning and the stop window are separate timers.",
      "stopTimeout defaults to 30 seconds.",
    ],
    answer:
      "No. The two-minute warning is the notice, delivered as an EventBridge event and as SIGTERM. The container's stopTimeout controls how long ECS waits after SIGTERM before SIGKILL. The default is 30 seconds and the maximum is 120 seconds. If the application needs 90 seconds, it must set stopTimeout close to the notice and handle SIGTERM by stopping new work and draining or checkpointing. Otherwise it is killed after the shorter window.",
    followUps: [
      "What signal does the container receive at interruption?",
      "What happens if the application ignores SIGTERM?",
      "How would you test the stop path?",
    ],
    redFlags: [
      "Assumes the warning extends the stop window.",
      "Leaves stopTimeout at the default.",
      "Does not handle SIGTERM.",
    ],
    rubric: [
      "Separates notice from stop window.",
      "Names SIGTERM and SIGKILL.",
      "Sets stopTimeout deliberately.",
      "Tests the drain path.",
    ],
  },
  {
    id: "spot-share",
    question:
      "How would you decide the Fargate Spot share for a checkout service and a nightly thumbnail job?",
    difficulty: 3,
    hints: [
      "Checkout has a strict availability requirement.",
      "The thumbnail job can retry and does not hold a user connection.",
    ],
    answer:
      "For checkout I would keep the minimum healthy floor on FARGATE and use Spot only for burst capacity that can disappear. The base should cover the service's ability to serve through an interruption, and the application should drain within stopTimeout. For the thumbnail job I would use a much larger Spot share, because the work is stateless, retryable, and can be checkpointed or restarted. I would compare the cost saving with the interruption behavior and test the worst-case event rather than choosing a single percentage for every workload.",
    followUps: [
      "What is the worst case if all Spot tasks are interrupted at once?",
      "How would you measure whether the base is large enough?",
      "What changes for a stateful workload?",
    ],
    redFlags: [
      "Uses the same Spot share for every workload.",
      "Puts the whole checkout floor on Spot.",
      "Chooses on price alone.",
    ],
    rubric: [
      "Separates availability-critical and retryable work.",
      "Sizes the base for the worst case.",
      "Considers drain and state.",
      "Tests the interruption.",
    ],
  },
  {
    id: "replacement-capacity",
    question:
      "Fargate Spot capacity is exhausted and tasks stay pending. What happens to the service, and what do you change?",
    difficulty: 3,
    hints: [
      "Fargate does not replace Spot with on-demand automatically.",
      "The base is the floor that remains.",
    ],
    answer:
      "The service keeps trying to place the interrupted tasks on Fargate Spot, so the running count stays below desired until capacity returns. The on-demand base continues to serve. I would confirm the service event and the provider mix, then raise the FARGATE base or move the affected share to FARGATE. If the workload can wait, I would reduce the desired count or let it retry. I would not assume that Fargate will silently substitute on-demand capacity.",
    followUps: [
      "Which event tells you the task is waiting for capacity?",
      "How would you protect the minimum healthy count in the strategy?",
      "What would you monitor during the shortage?",
    ],
    redFlags: [
      "Assumes automatic on-demand fallback.",
      "Raises the desired count during a capacity shortage.",
      "Leaves the entire service on Spot.",
    ],
    rubric: [
      "Explains the pending replacement.",
      "Keeps the on-demand base.",
      "Changes the strategy or capacity.",
      "Monitors running versus desired.",
    ],
  },
];

const checklist = [
  {
    title: "Before using Spot",
    items: [
      "The workload is stateless, retryable, or able to checkpoint.",
      "The FARGATE base covers the minimum healthy count.",
      "The application handles SIGTERM and drains within stopTimeout.",
      "The stop window is set deliberately, up to 120 seconds.",
    ],
  },
  {
    title: "During an interruption",
    items: [
      "Check how many tasks were on Spot and how many were interrupted.",
      "Compare available tasks with the desired count and the base.",
      "Check for in-flight failures near the stop time.",
      "Check whether replacement tasks are waiting for Spot capacity.",
    ],
  },
  {
    title: "After the event",
    items: [
      "Verify the service returned to its desired count.",
      "Review lost work and duplicate side effects from retries.",
      "Adjust the base or Spot share if the floor was too small.",
      "Record the interruption and the cost change in the service notes.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS clusters for Fargate",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Fargate and Fargate Spot capacity providers, interruption warnings, and stopTimeout guidance.",
  },
  {
    title: "Amazon ECS capacity provider strategies",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/capacity-Strategy.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Base and weight, provider families, and how a service distributes tasks.",
  },
  {
    title: "Amazon ECS container timeouts",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/stop-timeout.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "stopTimeout, SIGTERM, SIGKILL, and the graceful shutdown sequence.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "fargate-spot": {
      model: fargateSpotModel,
      presets,
      instructions:
        "Start Healthy, then apply Spot-heavy. Apply Interrupted with no drain to lose capacity and work, then Recovery. Apply On-demand floor to see a protected base. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Twelve tasks, the 0.35 relative Spot cost, and the drain-success curve are teaching values, not AWS prices or limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-capacity-providers",
    "capacity-spot-interruptions",
    "containers-draining",
    "containers-services",
  ],
};
