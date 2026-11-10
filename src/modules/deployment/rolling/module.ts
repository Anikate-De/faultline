import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const INSTANCE_CAPACITY = 1_500;
const READY_SECONDS = 20;
const DRAIN_SECONDS = 10;
const SHORTFALL_WARN = 1;
const SHORTFALL_CRIT = 2_000;

const params: ParamSpec[] = [
  {
    id: "fleetSize",
    label: "Desired fleet size",
    min: 4,
    max: 40,
    step: 1,
    value: 12,
    unit: " instances",
    group: "Fleet",
    help: "Instances the deployment controller wants running. Each instance is modeled at 1,500 request equivalents per second of safe capacity.",
    format: "count",
  },
  {
    id: "requestRate",
    label: "Production request rate",
    min: 4_000,
    max: 40_000,
    step: 500,
    value: 12_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second the service must serve during the rollout, in requests per second (rps).",
    format: "rps",
  },
  {
    id: "minHealthyPercent",
    label: "Minimum healthy",
    min: 25,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rollout",
    help: "Share of desired capacity the controller may treat as the floor while old instances drain. In AWS ECS this is minimumHealthyPercent; Kubernetes expresses the same idea with maxUnavailable.",
    format: "percent",
  },
  {
    id: "maxSurgePercent",
    label: "Maximum surge",
    min: 0,
    max: 50,
    step: 5,
    value: 25,
    unit: "%",
    group: "Rollout",
    help: "Extra instances the controller may launch above the desired count. In ECS this is the gap between maximumPercent and 100; in Kubernetes it is maxSurge.",
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

interface Values {
  fleetSize: number;
  requestRate: number;
  minHealthy: number;
  maxSurge: number;
  desiredCapacity: number;
  availableCapacity: number;
  shortfall: number;
  headroom: number;
  surgeCount: number;
  batch: number;
  stalled: boolean;
  errorRate: number;
  p99: number;
  rolloutSeconds: number;
}

function compute(p: Params): Values {
  const fleetSize = Math.max(1, Math.round(num(p, "fleetSize", 12)));
  const requestRate = Math.max(1, num(p, "requestRate", 12_000));
  const minHealthy = clamp(num(p, "minHealthyPercent", 100) / 100, 0.25, 1);
  const maxSurge = clamp(num(p, "maxSurgePercent", 25) / 100, 0, 0.5);

  const desiredCapacity = fleetSize * INSTANCE_CAPACITY;
  const availableCapacity = desiredCapacity * minHealthy;
  const shortfall = Math.max(0, requestRate - availableCapacity);
  const headroom = Math.max(0, availableCapacity - requestRate);
  const surgeCount = Math.floor(fleetSize * maxSurge);
  const replaceable = Math.floor(fleetSize * (1 - minHealthy));
  const batch = surgeCount > 0 ? surgeCount : replaceable;
  const stalled = batch <= 0;
  const pressure = clamp(shortfall / requestRate, 0, 1);
  const errorRate = Math.min(100, 0.05 + pressure * 90);
  const p99 = Math.min(5_000, 120 + 700 * pressure ** 2 + Math.max(0, requestRate / availableCapacity - 0.85) * 900);
  const rolloutSeconds = stalled ? 0 : Math.ceil(fleetSize / batch) * (READY_SECONDS + DRAIN_SECONDS);

  return {
    fleetSize,
    requestRate,
    minHealthy,
    maxSurge,
    desiredCapacity,
    availableCapacity,
    shortfall,
    headroom,
    surgeCount,
    batch,
    stalled,
    errorRate,
    p99,
    rolloutSeconds,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function capacityHealth(shortfall: number): Health {
  if (shortfall >= SHORTFALL_CRIT) return "crit";
  if (shortfall >= SHORTFALL_WARN) return "warn";
  return "ok";
}

function errorHealth(errorRate: number): Health {
  if (errorRate >= 5) return "crit";
  if (errorRate >= 1) return "warn";
  return "ok";
}

function utilizationHealth(value: number): Health {
  if (value > 1) return "crit";
  if (value >= 0.9) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function buildFrame(values: Values, seed: number): SimFrame {
  const capacity = capacityHealth(values.shortfall);
  const errors = errorHealth(values.errorRate);
  const stall: Health = values.stalled ? "crit" : "ok";
  const oldHealth = worst(capacity, errors);
  const overall = worst(capacity, errors, stall);
  const utilization = clamp(values.requestRate / values.availableCapacity);
  const targetUtilization = clamp(values.requestRate / values.desiredCapacity);
  const targetHealth = utilizationHealth(values.requestRate / values.desiredCapacity);
  const oldCount = Math.max(0, values.fleetSize - values.batch);

  const stageNodes = [
    {
      id: "current",
      label: "Old version serving",
      kind: "service" as const,
      health: oldHealth,
      utilization,
      throughput: values.requestRate,
      capacity: values.availableCapacity,
      sublabel: `${oldCount} of ${values.fleetSize} instances · floor ${percent(values.minHealthy * 100)}`,
      detail: `The controller may let available capacity fall to ${Math.round(values.availableCapacity).toLocaleString()} rps, which is ${percent(values.minHealthy * 100)} of the ${Math.round(values.desiredCapacity).toLocaleString()} rps desired capacity. The request rate is ${Math.round(values.requestRate).toLocaleString()} rps.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "replacement",
      label: "Replacement batch",
      kind: "service" as const,
      health: stall,
      utilization: values.stalled ? 0 : 0.55,
      capacity: values.batch * INSTANCE_CAPACITY,
      sublabel: values.stalled ? "No instance can be replaced" : `${values.batch} instance${values.batch === 1 ? "" : "s"} at a time`,
      detail: values.stalled
        ? "With no surge and a 100 percent healthy floor, there is no spare slot to start a replacement. The rollout waits indefinitely."
        : `The batch size is ${values.batch}. Surge capacity is used to start replacements before old instances are removed.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "target",
      label: "Post-rollout fleet",
      kind: "service" as const,
      health: targetHealth,
      utilization: targetUtilization,
      throughput: values.requestRate,
      capacity: values.desiredCapacity,
      sublabel: `${values.fleetSize} instances · ${Math.round(values.desiredCapacity).toLocaleString()} rps`,
      detail: `After the rollout, the fleet has ${values.fleetSize} instances. The target is healthy only when the request rate fits inside the desired capacity, not just inside the temporary floor.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    {
      id: "clients",
      label: "Clients",
      kind: "client" as const,
      health: "ok" as const,
      throughput: values.requestRate,
      sublabel: `${Math.round(values.requestRate).toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "service",
      label: "Checkout service",
      kind: "service" as const,
      health: overall,
      utilization,
      throughput: values.requestRate,
      capacity: values.availableCapacity,
      sublabel: `${values.fleetSize} desired · ${values.batch} replaceable`,
      meta: { view: "flow" },
    },
    {
      id: "load-balancer",
      label: "Load balancer",
      kind: "lb" as const,
      health: overall,
      throughput: values.requestRate,
      capacity: values.availableCapacity,
      sublabel: `${values.shortfall > 0 ? "short on healthy targets" : "healthy targets available"}`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-service", "clients", "service", values.requestRate / 40_000, overall),
      edge("service-lb", "service", "load-balancer", values.requestRate / 40_000, overall),
    ],
    metrics: [
      metric("capacity-shortfall", "Capacity shortfall", values.shortfall, " rps", SHORTFALL_WARN, SHORTFALL_CRIT, "rps"),
      metric("service-error-rate", "Service error rate", values.errorRate, "%", 1, 5, "percent"),
      metric("rollout-stall", "Rollout stalled", values.stalled ? 1 : 0, "", 0.5, 1, "count"),
      metric("available-capacity", "Available capacity", values.availableCapacity, " rps", undefined, undefined, "rps"),
      metric("replacement-batch", "Replacement batch", values.batch, " instances", undefined, undefined, "count"),
      metric("p99-latency", "Request p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.fleetSize} instances · floor ${Math.round(values.availableCapacity).toLocaleString()} rps · demand ${Math.round(values.requestRate).toLocaleString()} rps · errors ${percent(values.errorRate)}`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const ids = ["capacity-shortfall", "service-error-rate", "rollout-stall", "available-capacity", "replacement-batch", "p99-latency"];
  for (const id of ids) {
    const item = frame.metrics.find((entry) => entry.id === id);
    if (!item) continue;
    const base = item.value;
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const scale = base === 0 ? 0 : base;
      return Math.max(0, scale * (0.97 + 0.03 * Math.sin((index + (seed % 9)) / 3.1)));
    });
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "capacity-shortfall",
    metricId: "capacity-shortfall",
    warn: SHORTFALL_WARN,
    crit: SHORTFALL_CRIT,
    title: "Available capacity is below the request rate",
    cause:
      "The minimum healthy setting allows the controller to drain more capacity than the service can spare. The request rate exceeds the capacity floor, so the load balancer has too few healthy targets and returns 503 responses.",
    fix:
      "Raise the minimum healthy floor, reduce the batch size, add fleet capacity, or lower the request rate. Plan the rollout against the floor, not against the desired capacity.",
    checkFirst: [
      "Compare the request rate with desired capacity times the minimum healthy share.",
      "Check target health in the load balancer and the number of healthy instances.",
      "Check whether surge is available to start replacements before old instances drain.",
    ],
  },
  {
    id: "service-error-rate",
    metricId: "service-error-rate",
    warn: 1,
    crit: 5,
    title: "The service is returning errors during the rollout",
    cause:
      "A capacity shortfall, failed health checks, or aborted in-flight requests are turning the rollout into user-facing errors. The error rate follows the capacity gap.",
    fix:
      "Pause the rollout, restore capacity, and confirm error rates return to baseline before continuing. If the error budget is at risk, roll back rather than retrying the same step.",
    checkFirst: [
      "Check whether errors are 503 responses from no healthy targets or application failures.",
      "Check health check failures and instance restart counts per version.",
      "Check connection draining and load balancer deregistration delay.",
    ],
  },
  {
    id: "rollout-stall",
    metricId: "rollout-stall",
    warn: 0.5,
    crit: 1,
    title: "The rollout cannot replace an instance",
    cause:
      "Maximum surge is zero and the minimum healthy floor is 100 percent. There is no free slot to start a replacement, and the controller may not stop an old instance, so the deployment makes no progress.",
    fix:
      "Add surge capacity or lower the healthy floor enough to permit one replaceable instance. A rollout that cannot make progress is not zero downtime; it is an unfinished deployment.",
    checkFirst: [
      "Check maximumSurge and minimumHealthyPercent (or maxSurge and maxUnavailable).",
      "Check whether the deployment controller reports a stalled or waiting state.",
      "Check cluster capacity and scheduling failures, which can also block replacement.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "Tail latency is rising with the rollout",
    cause:
      "When healthy capacity falls below demand, requests queue or retry. The tail rises before the average moves, especially when a small number of targets absorb the overflow.",
    fix:
      "Restore capacity before tuning latency. Check the capacity floor, target health, and retry behavior together.",
    checkFirst: [
      "Compare p99 with healthy target count at the same timestamp.",
      "Check retries and timeouts in the caller.",
      "Check whether only one version shows the regression.",
    ],
  },
];

export const rollingDeploymentsModel: SimModel = {
  id: "deployment-rolling",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(values, seed);
    seedSeries(frame, seed);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const next = buildFrame(values, seed);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    next.series = Object.fromEntries(Object.entries(frame.series).map(([seriesKey, valuesAtKey]) => [seriesKey, [...valuesAtKey]]));
    if (frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, seed);
      next.flags.paramsKey = key;
    }
    const jitter = rng.between(-1, 1) * Math.min(1, Math.max(0, dt) * 10) * 4;
    next.metrics = next.metrics.map((item) =>
      item.id === "p99-latency" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    next.summary = `${values.fleetSize} instances · floor ${Math.round(values.availableCapacity).toLocaleString()} rps · demand ${Math.round(values.requestRate).toLocaleString()} rps · errors ${percent(values.errorRate)}`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines: string[] = [];
    lines.push(
      `Desired capacity is ${Math.round(values.desiredCapacity).toLocaleString()} rps across ${values.fleetSize} instances. The minimum healthy floor allows ${Math.round(values.availableCapacity).toLocaleString()} rps to remain available while old instances drain.`,
    );
    if (values.shortfall > 0) {
      lines.push(
        `Demand is ${Math.round(values.requestRate).toLocaleString()} rps, so the floor is short by ${Math.round(values.shortfall).toLocaleString()} rps. Surge does not repair a floor below demand; it only changes how replacements are scheduled.`,
      );
    } else {
      lines.push(
        `Demand is ${Math.round(values.requestRate).toLocaleString()} rps, leaving ${Math.round(values.headroom).toLocaleString()} rps of headroom against the floor.`,
      );
    }
    if (values.stalled) {
      lines.push("Surge is zero and the healthy floor is 100 percent, so no instance can be replaced. The deployment is stuck rather than safe.");
    } else {
      lines.push(
        `The controller can replace ${values.batch} instance${values.batch === 1 ? "" : "s"} per batch, which is an illustrative ${values.rolloutSeconds}s at ${READY_SECONDS}s ready plus ${DRAIN_SECONDS}s drain per batch.`,
      );
    }
    lines.push("Size the rollout against the floor and the request rate. A healthy post-rollout fleet does not prove that the transition has enough capacity.");
    return lines;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 12-instance fleet at 12,000 rps with a 100 percent healthy floor and 25 percent surge.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak traffic",
    description: "17,800 rps with a 95 percent healthy floor. Capacity and errors enter the warning band.",
    tone: "warn",
    params: defaults({ requestRate: 17_800, minHealthyPercent: 95, maxSurgePercent: 20 }),
  },
  {
    id: "failure",
    label: "Low healthy floor",
    description: "16,000 rps with a 50 percent healthy floor. The floor is 9,000 rps and the rest is 503s.",
    tone: "crit",
    params: defaults({ requestRate: 16_000, minHealthyPercent: 50, maxSurgePercent: 25 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The healthy floor is restored to 100 percent and demand is 16,000 rps.",
    tone: "ok",
    params: defaults({ requestRate: 16_000, minHealthyPercent: 100, maxSurgePercent: 10 }),
  },
  {
    id: "no-surge",
    label: "No surge",
    description: "A 100 percent healthy floor with zero surge. Capacity is fine, but the rollout cannot progress.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, minHealthyPercent: 100, maxSurgePercent: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-capacity-floor",
  title: "Predict the capacity floor",
  simId: "rolling-fleet",
  question:
    "A 12-instance fleet serves 16,000 rps. Each instance safely serves 1,500 rps. The rollout uses a 50 percent minimum healthy floor and 25 percent maximum surge. Which capacity should you compare with the request rate?",
  prediction: {
    options: [
      { id: "desired", label: "The full desired capacity, 18,000 rps" },
      { id: "floor", label: "The minimum healthy floor, 9,000 rps" },
      { id: "surge", label: "The surge capacity alone, 4,500 rps" },
      { id: "batch", label: "One replacement batch, 3,000 rps" },
    ],
    correctOptionId: "floor",
    explanation:
      "Desired capacity is what the fleet has after the rollout. During the transition, the controller is allowed to drain down to the minimum healthy share. With 12 instances at 1,500 rps and a 50 percent floor, that is 9,000 rps. Surge changes how replacements are batched; it does not make a floor below demand safe.",
  },
  setup: defaults({ requestRate: 16_000, minHealthyPercent: 50, maxSurgePercent: 25 }),
  runFor: 20,
  observe: [
    "Available capacity is 9,000 rps against 16,000 rps of demand.",
    "The capacity shortfall is 7,000 rps, which crosses the critical threshold.",
    "Service errors rise above 39 percent and p99 exceeds 800ms.",
    "The replacement batch is three instances, so the rollout is progressing while the service is short.",
  ],
  explain:
    "A rolling deploy does not preserve full capacity by default. The configured healthy floor is the amount the controller may leave serving while it replaces old instances. If the request rate is larger than that floor, the load balancer runs out of healthy targets even though the deployment is behaving as configured. The correct capacity comparison is demand against the floor, not demand against the desired count.",
  fix: defaults({ requestRate: 16_000, minHealthyPercent: 100, maxSurgePercent: 25 }),
  debrief:
    "With a 100 percent floor and 25 percent surge, the controller starts replacement capacity before draining old instances. Available capacity is 18,000 rps for 16,000 rps of demand, so the rollout has headroom. The cost is surge capacity and a slower batch cadence. If the cluster cannot supply the surge, the safe alternative is a lower request rate or a larger fleet, not a lower floor.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A rolling deployment replaces instances in batches. The deployment controller starts new instances, waits for readiness, then drains and removes old ones. The service stays available because some old capacity keeps serving throughout the transition. The load balancer, target group, or service mesh decides which instances receive traffic from the set that is healthy.",
  },
  {
    type: "p",
    text: "The safety margin is a capacity decision. The minimum healthy setting is the floor the controller may leave serving while it replaces a batch. The maximum surge setting is how much extra capacity it may start above the desired count. Surge lets the controller add first and remove later; it also determines the batch size. A rollout that only looks at the desired fleet size can still cause 503s, because the fleet is temporarily below that size.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The controller sits above the compute platform and below the load balancer. In AWS Elastic Container Service (ECS), minimumHealthyPercent and maximumPercent bound the task count during a deployment. In Kubernetes, maxUnavailable and maxSurge express the same trade. The controller also depends on readiness probes, deregistration delay, and connection draining: an instance that is removed before in-flight requests finish turns a capacity change into user-visible errors.",
  },
  {
    type: "p",
    text: "This model uses an illustrative 1,500 rps of safe capacity per instance, a 10-second drain, and a 20-second readiness wait. Those are teaching values, not platform defaults. The shape is the lesson: available capacity during the rollout is the minimum healthy share of desired capacity, and the request rate must fit inside it.",
  },
  {
    type: "compare",
    leftTitle: "Minimum healthy floor",
    rightTitle: "Maximum surge",
    rows: [
      { label: "What it controls", left: "How far available capacity may fall", right: "How much extra capacity may start" },
      { label: "Primary risk", left: "503s when demand exceeds the floor", right: "Cost and scheduling pressure" },
      { label: "Deadlock case", left: "A 100 percent floor with no surge cannot drain first", right: "Zero surge with a 100 percent floor cannot add first" },
      { label: "Typical symptom", left: "Load balancer has too few healthy targets", right: "Rollout waits for capacity or never starts" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Available capacity and capacity shortfall: the temporary floor compared with production demand.",
      "Service error rate and 99th-percentile latency (p99): whether the capacity gap is reaching users.",
      "Rollout stalled: a binary signal that no replacement can be scheduled.",
      "Replacement batch: how many instances move at once.",
      "Old version, replacement batch, and post-rollout fleet stages with their capacity.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Low healthy floor. Compare available capacity with demand before reading the error rate. Apply No surge to see the other failure: capacity is fine, but the rollout cannot make progress. Use the experiment to practice the floor calculation, then apply Recovery.",
  },
  {
    type: "table",
    headers: ["Setting", "The model uses it for", "What to compare"],
    rows: [
      ["Fleet size", "Desired instance count times 1,500 rps", "Request rate against desired capacity"],
      ["Minimum healthy", "The capacity floor while old instances drain", "Request rate against the floor"],
      ["Maximum surge", "Extra instances and replacement batch size", "Free capacity and scheduling headroom"],
      ["Request rate", "Demand during the rollout", "Peak and burst rate, not daily average"],
    ],
  },
  {
    type: "p",
    text: "The break condition is available capacity below the request rate. If the floor is 9,000 rps and demand is 16,000 rps, the service is short by 7,000 rps even though the post-rollout fleet would be large enough. That is the capacity math behind a brief 503 spike: the rollout is behaving as configured, and the configuration is unsafe for the current load.",
  },
  { type: "sim", simId: "rolling-fleet" },
  { type: "experiment", experimentId: "predict-capacity-floor" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the 12-instance fleet had 18,000 rps of desired capacity, but the 50 percent healthy floor allowed only 9,000 rps to remain serving. Demand was 16,000 rps, so the capacity shortfall was 7,000 rps. The load balancer ran out of healthy targets and the service error rate rose with the gap. The replacement batch kept moving because the controller was doing exactly what it was told.",
  },
  {
    type: "p",
    text: "The no-surge preset showed a different failure. With a 100 percent healthy floor and zero surge, no replacement could start, so the rollout stalled at zero progress. Capacity was not the problem; the deployment could not make progress without violating its own floor. Both presets are capacity planning problems, but only one of them produces an immediate 503 spike.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Deployment events with desired count, updated count, available count, and unavailable count.",
      "Target group or service health: healthy, draining, and unhealthy targets per version.",
      "HTTP 503 rate, upstream connection errors, and request latency during the transition.",
      "Readiness probe failures, instance start time, and deregistration delay.",
      "Cluster capacity and scheduling failures that prevent surge instances from starting.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the request rate with desired capacity times the minimum healthy share. Then check target health and the number of healthy instances. Finally check whether surge capacity is actually available; a surge setting that cannot be scheduled is not spare capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Pause the rollout and restore capacity. If the error budget is at risk, roll back to the previous version.",
      "Raise the minimum healthy floor so the serving floor covers peak demand.",
      "Add surge capacity or reduce the batch size so replacements start before old instances drain.",
      "Verify readiness probes and connection draining so healthy targets are not removed early.",
      "If the fleet cannot add capacity, reduce the request rate with load shedding or shift traffic to another region.",
      "Re-run the rollout at low traffic before the next peak, and compare the observed floor with the plan.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A 100 percent floor with surge preserves capacity but costs extra instances and takes longer.",
      "A lower floor deploys faster and cheaper but turns the rollout into a capacity risk.",
      "Large surge batches finish faster but require schedulable capacity and can stress shared dependencies.",
      "Aggressive readiness checks catch bad instances sooner but can cause churn and reduce available capacity.",
      "Rolling deployments are simple and reuse the existing fleet, but they mix versions and cannot instantly switch back the way a blue-green cutover can.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rolling-503",
    question:
      "A rolling deploy causes a brief 503 spike. The fleet is sized for peak traffic and the deployment succeeds. What do you check first?",
    difficulty: 2,
    hints: [
      "The fleet is sized after the rollout, not necessarily during it.",
      "Compare the request rate with the minimum healthy floor.",
      "A successful deployment can still be an unsafe one.",
    ],
    answer:
      "I would compare peak request rate with desired capacity multiplied by the minimum healthy percentage. If the floor is below demand, the load balancer will run out of healthy targets during a batch even though the final fleet is large enough. I would also check target health, readiness probe failures, deregistration delay, and whether surge capacity was schedulable. The fix is to raise the floor or add surge capacity, not to wait for the deployment to finish.",
    followUps: [
      "How would the answer change for a stateful service?",
      "What does connection draining change?",
      "When would you choose a lower floor on purpose?",
    ],
    redFlags: [
      "Assumes the desired count is available throughout.",
      "Checks only application logs, not target health.",
      "Raises surge without checking schedulable capacity.",
    ],
    rubric: [
      "Performs the floor calculation.",
      "Checks target health and readiness.",
      "Names a capacity fix.",
      "Mentions draining or scheduling constraints.",
    ],
  },
  {
    id: "zero-surge",
    question:
      "The deployment controller is configured with minimum healthy at 100 percent and maximum surge at zero. The rollout never finishes. Why?",
    difficulty: 2,
    hints: [
      "The controller needs a free slot or permission to remove capacity.",
      "At 100 percent healthy, no old instance may be removed first.",
      "At zero surge, no new instance may be added first.",
    ],
    answer:
      "The configuration creates a deadlock. The controller may not remove an old instance because that would drop below 100 percent healthy, and it may not add a new instance because surge is zero. There is no legal move, so the rollout waits. The fix is to add surge capacity or lower the healthy floor enough to replace at least one instance. This is a liveness failure, not a user-facing outage, but it leaves the release unfinished.",
    followUps: [
      "How would you detect this automatically?",
      "What is the smallest safe change to unblock it?",
      "Why might a team choose this configuration by mistake?",
    ],
    redFlags: [
      "Says the deployment is zero downtime and therefore safe.",
      "Suggests retrying without changing the configuration.",
      "Confuses surge with minimum healthy.",
    ],
    rubric: [
      "Explains the deadlock.",
      "Names both settings.",
      "Proposes a liveness fix.",
      "Distinguishes safety from progress.",
    ],
  },
  {
    id: "choose-rolling-settings",
    question:
      "You have a 20-instance service at 70 percent peak utilization and a change that must ship today. How do you choose rolling settings?",
    difficulty: 3,
    hints: [
      "Start from peak demand and per-instance capacity.",
      "Leave room for the loss of a batch, not just the desired count.",
      "Surge needs schedulable capacity and may affect shared dependencies.",
    ],
    answer:
      "I would compute per-instance safe capacity from peak demand and current utilization, then choose a floor that covers peak plus a margin. If the fleet has 30 percent headroom, a floor of 100 percent with surge is the safest choice, provided the platform can schedule the surge. If it cannot, I would add instances or shift traffic before lowering the floor. I would also check readiness and draining, because a fast controller can still remove capacity before requests finish.",
    followUps: [
      "How does a shared dependency change the surge decision?",
      "What if the cluster has no spare nodes?",
      "How would you validate the choice in staging?",
    ],
    redFlags: [
      "Uses average traffic instead of peak.",
      "Sets a floor without doing the capacity math.",
      "Ignores scheduling limits on surge.",
    ],
    rubric: [
      "Computes a floor from peak demand.",
      "Accounts for per-instance capacity.",
      "Checks surge schedulability.",
      "Includes readiness and draining.",
    ],
  },
  {
    id: "rolling-vs-blue-green",
    question:
      "When would you choose a rolling deployment over blue-green, even though blue-green has a faster rollback?",
    difficulty: 3,
    hints: [
      "Blue-green needs a second complete environment.",
      "Stateful systems and shared databases complicate cutover.",
      "Rolling reuses capacity and works with simpler infrastructure.",
    ],
    answer:
      "I would choose rolling when the service can run two versions side by side safely, the platform cannot afford or provision a duplicate environment, and the change does not require an atomic traffic switch. Rolling is simpler for many stateless services and avoids doubling the fleet. I would choose blue-green when a fast, complete rollback matters more than cost, or when I need to verify the new environment before any user traffic arrives. The deciding constraints are state compatibility and the cost of duplicate capacity.",
    followUps: [
      "What schema rules make rolling safe?",
      "How does a session store affect the choice?",
      "What is the rollback path for each?",
    ],
    redFlags: [
      "Treats blue-green as always better.",
      "Ignores schema compatibility.",
      "Forgets the cost of duplicate capacity.",
    ],
    rubric: [
      "Compares state and cost.",
      "Names compatibility constraints.",
      "Explains rollback differences.",
      "Fits the choice to the service.",
    ],
  },
];

const checklist = [
  {
    title: "Before the rollout",
    items: [
      "Calculate available capacity at the minimum healthy floor using peak demand.",
      "Confirm the platform can schedule the configured surge.",
      "Check readiness probe timing and connection draining.",
      "Define the abort condition and who can trigger it.",
      "Verify the previous version and schema can coexist during the transition.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Watch available targets and 503 rate, not only deployment progress.",
      "Compare per-version errors and latency with the control fleet.",
      "Stop if available capacity approaches the request rate.",
      "Check that surge instances become healthy before old ones drain.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Confirm the final fleet has headroom at peak, not just at current traffic.",
      "Review the observed capacity floor against the plan.",
      "Record the batch size and the time each batch took.",
      "Add any missed capacity signal to the deployment gate.",
    ],
  },
];

const references = [
  {
    title: "Deployments",
    url: "https://kubernetes.io/docs/concepts/workloads/controllers/deployment/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Rolling update strategy, maxSurge, maxUnavailable, and readiness behavior.",
  },
  {
    title: "Deployment configurations",
    url: "https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html",
    publisher: "AWS CodeDeploy",
    kind: "docs" as const,
    note: "Rolling deployment configurations for EC2 and ECS, including healthy and surge bounds.",
  },
  {
    title: "Amazon ECS deployment types",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-type-ecs.html",
    publisher: "Amazon ECS",
    kind: "docs" as const,
    note: "minimumHealthyPercent and maximumPercent behavior during a rolling deployment.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "rolling-fleet": {
      model: rollingDeploymentsModel,
      presets,
      instructions:
        "Start with Healthy, then apply Low healthy floor. Compare available capacity with demand before reading errors. Apply No surge to see a stalled rollout, then Recovery to restore the floor. Run the experiment to practice the calculation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Instance capacity, drain time, readiness time, and thresholds are teaching values, not platform defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-rolling-deployments",
    "deployment-blue-green",
    "deployment-canary",
    "deployment-automated-rollback",
  ],
};
