import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SERVICE_RPS = 1_200;
const CPU_RPS = 4_000;
const QUEUE_TARGET = 0.75;
const CPU_TARGET = 0.6;
const BASE_FRACTION = 0.35;
const RAMP_SECONDS = 24;
const SCALE_IN_SECONDS = 90;
const MAX_INSTANCES = 60;

const params = [
  {
    id: "peakRps",
    label: "Peak demand",
    min: 8_000,
    max: 40_000,
    step: 1_000,
    value: 9_000,
    unit: " rps",
    group: "Traffic",
    help: "Demand reached after the ramp. The ramp starts at 35% of this value and eases in over 24 simulated seconds.",
    format: "rps" as const,
  },
  {
    id: "policy",
    label: "Policy signal",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "0 scales on CPU utilization. 1 scales on the depth of the downstream queue. Both use a target of 60% CPU or 75% service utilization.",
    format: "count" as const,
  },
  {
    id: "startupSeconds",
    label: "Instance startup",
    min: 15,
    max: 180,
    step: 15,
    value: 15,
    unit: "s",
    group: "Policy",
    help: "Time for new capacity to launch, register, and serve traffic. The model spreads each capacity change over this period.",
    format: "number" as const,
  },
  {
    id: "maxInstances",
    label: "Maximum capacity",
    min: 4,
    max: 60,
    step: 1,
    value: 24,
    unit: " instances",
    group: "Policy",
    help: "Ceiling the policy cannot exceed. A target that needs more than the ceiling saturates the fleet.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function smoothstep(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function demandAt(t: number, peakRps: number): number {
  const peak = Math.max(1_000, peakRps);
  const base = peak * BASE_FRACTION;
  return base + (peak - base) * smoothstep(t / RAMP_SECONDS);
}

function policyUsesQueue(p: Params): boolean {
  return num(p, "policy", 1) >= 0.5;
}

function desiredFor(demand: number, p: Params): number {
  const max = Math.max(1, Math.round(num(p, "maxInstances", 24)));
  const divisor = policyUsesQueue(p) ? SERVICE_RPS * QUEUE_TARGET : CPU_RPS * CPU_TARGET;
  return clamp(Math.ceil(demand / divisor), 1, max);
}

function initialFor(p: Params): number {
  const max = Math.max(1, Math.round(num(p, "maxInstances", 24)));
  const base = Math.max(1_000, num(p, "peakRps", 9_000)) * BASE_FRACTION;
  return clamp(Math.ceil(base / (SERVICE_RPS * QUEUE_TARGET)) + 1, 2, max);
}

interface Computed {
  demand: number;
  instances: number;
  capacity: number;
  served: number;
  utilization: number;
  cpuUtilization: number;
  queueDepth: number;
  errors: number;
  p99: number;
  desired: number;
}

function compute(p: Params, t: number, instances: number, noise: number): Computed {
  const demand = demandAt(t, num(p, "peakRps", 9_000));
  const safeInstances = Math.max(0.1, instances);
  const capacity = safeInstances * SERVICE_RPS;
  const utilization = demand / Math.max(1, capacity);
  const served = Math.min(demand, capacity);
  const shed = Math.max(0, demand - capacity);
  const errors = demand > 0 ? (shed / demand) * 100 : 0;
  const cpuUtilization = Math.min(1.5, demand / Math.max(1, safeInstances * CPU_RPS));
  const backlog = Math.max(0, utilization - 0.85) * demand * 0.2;
  const queueDepth = shed * 1.5 + backlog;
  const p99Base =
    utilization <= 1.08
      ? 40 + (500 * Math.pow(Math.min(utilization, 1.08), 6)) / Math.max(0.05, 1.08 - utilization)
      : 6_000;
  return {
    demand,
    instances: safeInstances,
    capacity,
    served,
    utilization,
    cpuUtilization,
    queueDepth,
    errors,
    p99: Math.min(9_000, p99Base * noise),
    desired: desiredFor(demand, p),
  };
}

function serviceHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.errors >= 5 || values.utilization >= 0.98 || values.p99 >= 5_000 || values.queueDepth >= 2_000) {
    return "crit";
  }
  if (values.errors >= 1 || values.utilization >= 0.85 || values.p99 >= 800 || values.queueDepth >= 500) {
    return "warn";
  }
  return "ok";
}

function queueHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.queueDepth >= 2_000) return "crit";
  if (values.queueDepth >= 500) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["fleet-utilization", values.utilization * 100, 1.5],
    ["cpu-utilization", values.cpuUtilization * 100, 1],
    ["error-rate", values.errors, 0.05],
    ["p99-latency", values.p99, 20],
    ["queue-depth", values.queueDepth, 15],
    ["capacity-instances", values.instances, 0.1],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.99 + 0.01 * Math.sin((index + (seed % 7)) / 2.9)) + amplitude * Math.sin(index / 2.4)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  values: Computed,
  state: { metricMismatch: boolean; limitHit: boolean; shortfall: boolean },
): SimFrame {
  const health = serviceHealth(values);
  const qHealth = queueHealth(values);
  const policyLabel = policyUsesQueue(p) ? "Queue-depth target" : "CPU target";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "requests",
        throughput: values.demand,
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health,
        utilization: clamp(values.utilization),
        throughput: values.served,
        sublabel: `${Math.round(values.errors).toFixed(0)}% errors`,
        meta: { view: "flow" },
      },
      {
        id: "fleet",
        label: "Service fleet",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(values.utilization),
        throughput: values.served,
        capacity: values.capacity,
        sublabel: `${Math.round(values.instances)} instances · ${policyLabel}`,
        detail: `${Math.round(values.instances)} instances serve ${Math.round(values.served).toLocaleString("en-US")} of ${Math.round(values.demand).toLocaleString("en-US")} rps. The policy asks for ${values.desired} instances.`,
        meta: { view: "flow" },
      },
      {
        id: "queue",
        label: "Work queue",
        kind: "queue",
        health: qHealth,
        utilization: clamp(values.queueDepth / 2_000),
        sublabel: `${Math.round(values.queueDepth).toLocaleString("en-US")} waiting · ${Math.round(values.errors).toFixed(0)}% shed`,
        detail: "Depth is the bottleneck signal. CPU can stay below its target while work waits here.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Orders database",
        kind: "db",
        health: values.served / 40_000 > 0.9 ? "warn" : "ok",
        utilization: clamp(values.served / 40_000),
        sublabel: `${Math.round(values.served).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.demand / 40_000), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.demand / 40_000), health),
      edge("fleet-queue", "fleet", "queue", clamp(values.queueDepth / 2_000), qHealth),
      edge("queue-db", "queue", "db", clamp(values.served / 40_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("fleet-utilization", "Fleet utilization", Math.min(100, values.utilization * 100), "%", 85, 98, "percent"),
      metric("cpu-utilization", "CPU utilization", values.cpuUtilization * 100, "%", undefined, undefined, "percent"),
      metric("error-rate", "Error rate", values.errors, "%", 1, 5, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 800, 5_000, "ms"),
      metric("queue-depth", "Queue depth", values.queueDepth, " requests", 500, 2_000, "count"),
      metric("capacity-instances", "In-service capacity", values.instances, " instances", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      metricMismatch: state.metricMismatch ? 1 : 0,
      limitHit: state.limitHit ? 1 : 0,
      shortfall: state.shortfall ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.instances)} instances serve ${Math.round(values.demand).toLocaleString("en-US")} rps at ${Math.round(values.utilization * 100)}% utilization. The ${policyLabel} asks for ${values.desired} instances; ${values.errors.toFixed(1)}% of demand is shed.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const instances = initialFor(p);
  const values = compute(p, 0, instances, 1);
  const frame = buildFrame(p, seed, values, {
    metricMismatch: false,
    limitHit: false,
    shortfall: false,
  });
  seedSeries(frame, values, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The fleet cannot serve the offered load",
    cause:
      "Demand is above the capacity the fleet can serve. A policy that watches a resource metric can keep adding too little capacity, because that metric never reaches its target even while requests queue.",
    fix:
      "Compare the policy's target metric with the queue and error signals. Switch to the signal that actually limits throughput, then raise the ceiling if the desired capacity is clipped.",
    checkFirst: [
      "Compare desired, in-service, and pending capacity with demand.",
      "Check whether the policy metric is the bottleneck or just correlated with it.",
      "Check whether the desired count is pinned at the maximum.",
    ],
  },
  {
    id: "fleet-utilization",
    metricId: "fleet-utilization",
    warn: 85,
    crit: 98,
    title: "The fleet is running out of service capacity",
    cause:
      "Utilization is the ratio of demand to the service capacity of the running instances. It can saturate while CPU stays low if requests wait on I/O or a downstream dependency.",
    fix:
      "Restore capacity with the policy that follows the service bottleneck, not the resource that happens to look busy. If the policy is already correct, raise the maximum or reduce startup time.",
    checkFirst: [
      "Check queue depth and p99 before CPU.",
      "Check whether the fleet is at its maximum size.",
      "Check whether new instances are pending or still warming.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 800,
    crit: 5_000,
    title: "Requests are queueing behind the fleet",
    cause:
      "Latency rises before errors when demand approaches service capacity. At the limit, retries and client timeouts add load and make recovery slower.",
    fix:
      "Close the capacity gap or shed low-priority work deliberately. Verify that retries are bounded while capacity is being added.",
    checkFirst: [
      "Split p99 by endpoint and instance to find the queueing path.",
      "Check retry volume and client timeout settings.",
      "Check whether the load balancer has healthy targets in every zone.",
    ],
  },
  {
    id: "queue-depth",
    metricId: "queue-depth",
    warn: 500,
    crit: 2_000,
    title: "Work is accumulating faster than it drains",
    cause:
      "Arrivals exceed service rate. A CPU target can look satisfied because the workers are waiting on I/O, so the queue grows even though the resource metric is below target.",
    fix:
      "Scale on queue depth or on a saturation signal that tracks the bottleneck. Keep the queue bounded and shed work if the drain rate cannot recover in time.",
    checkFirst: [
      "Compare queue depth with arrival rate and service rate.",
      "Check whether the policy target is measured per instance or per fleet.",
      "Check whether the queue has a maximum depth and an age alarm.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const autoscalingPoliciesModel: SimModel = {
  id: "capacity-autoscaling-policies",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const stepSeconds = Math.min(1, Math.max(0.01, dt));
    const t = frame.t;
    let instances = fresh ? initialFor(p) : Number(frame.flags.instances ?? initialFor(p));
    if (!Number.isFinite(instances)) instances = initialFor(p);
    let metricMismatch = fresh ? false : frame.flags.metricMismatch === 1;
    let limitHit = fresh ? false : frame.flags.limitHit === 1;
    let shortfall = fresh ? false : frame.flags.shortfall === 1;
    const noise = 0.98 + 0.04 * rng.next();
    const demand = demandAt(t, num(p, "peakRps", 9_000));
    const desired = desiredFor(demand, p);
    const startup = Math.max(1, num(p, "startupSeconds", 15));
    const gap = desired - instances;
    if (gap > 0) instances += gap * Math.min(1, stepSeconds / startup);
    else if (gap < 0) instances += gap * Math.min(1, stepSeconds / SCALE_IN_SECONDS);
    instances = clamp(instances, 0.1, MAX_INSTANCES);

    const values = compute(p, t, instances, noise);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values, {
      metricMismatch,
      limitHit,
      shortfall,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!metricMismatch && !policyUsesQueue(p) && values.queueDepth >= 1_000) {
      pushEvent(next, {
        id: "policy-metric-mismatch",
        at: t,
        severity: "crit",
        title: "The policy is watching the wrong signal",
        detail: `CPU is at ${values.cpuUtilization * 100}% while ${Math.round(values.queueDepth).toLocaleString("en-US")} requests wait. The CPU target asks for ${desired} instances; the queue needs far more.`,
        nodeId: "fleet",
        metricId: "queue-depth",
      });
      metricMismatch = true;
    }

    if (!limitHit && values.desired >= Math.round(num(p, "maxInstances", 24)) && values.errors >= 5) {
      pushEvent(next, {
        id: "capacity-limit-hit",
        at: t,
        severity: "crit",
        title: "Desired capacity is pinned at the maximum",
        detail: `The policy wants ${values.desired} instances, but the maximum is ${Math.round(num(p, "maxInstances", 24))}. Demand still exceeds capacity.`,
        nodeId: "fleet",
        metricId: "error-rate",
      });
      limitHit = true;
    }

    if (!shortfall && values.errors > 0) {
      pushEvent(next, {
        id: "service-shortfall",
        at: t,
        severity: values.errors >= 5 ? "crit" : "warn",
        title: "Served capacity is below demand",
        detail: `The fleet serves ${Math.round(values.served).toLocaleString("en-US")} of ${Math.round(values.demand).toLocaleString("en-US")} rps. The gap becomes queue depth and then errors.`,
        nodeId: "lb",
        metricId: "error-rate",
      });
      shortfall = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      instances,
      metricMismatch: metricMismatch ? 1 : 0,
      limitHit: limitHit ? 1 : 0,
      shortfall: shortfall ? 1 : 0,
      paramsKey: key,
      seed: Number(frame.flags.seed ?? 20261110),
    };

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const queue = policyUsesQueue(p);
    const items = [
      `The policy watches ${queue ? "queue depth" : "CPU"} and asks for ${Math.round(value("capacity-instances"))} instances to run. Utilization is ${value("fleet-utilization").toFixed(0)}%.`,
      `CPU is at ${value("cpu-utilization").toFixed(0)}% while queue depth is ${Math.round(value("queue-depth")).toLocaleString("en-US")}. ${
        queue
          ? "The queue signal moves before CPU does when the bottleneck is downstream."
          : "A CPU target below saturation will not add the capacity that the queue requires."
      }`,
      "Startup time sets how long the fleet runs below desired capacity after the metric moves. The maximum sets the highest count the policy can reach.",
    ];
    if (value("error-rate") >= 1) {
      items.push("The service is shedding load: compare desired, in-service, and pending capacity before changing the target.");
    }
    return items;
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
    description: "A queue-depth policy with fast startup and enough maximum capacity absorbs a 9k rps ramp.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with slow startup",
    description: "A 14k rps peak against a 16-instance ceiling; the fleet is saturated but still serving.",
    tone: "warn",
    params: defaults({ peakRps: 14_000, startupSeconds: 45, maxInstances: 16 }),
  },
  {
    id: "failure",
    label: "CPU target on a queue bottleneck",
    description: "A 26k rps ramp, CPU target policy, slow startup, and a 20-instance ceiling; the queue runs away.",
    tone: "crit",
    params: defaults({ peakRps: 26_000, policy: 0, startupSeconds: 90, maxInstances: 20 }),
  },
  {
    id: "limit",
    label: "Correct policy, low ceiling",
    description: "Queue-depth target but a 12-instance maximum; the policy is right and still cannot add enough capacity.",
    tone: "crit",
    params: defaults({ peakRps: 30_000, policy: 1, startupSeconds: 20, maxInstances: 12 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Queue-depth target, 40-instance ceiling, and 20s startup keep the 26k rps ramp inside capacity.",
    tone: "ok",
    params: defaults({ peakRps: 26_000, policy: 1, startupSeconds: 20, maxInstances: 40 }),
  },
];

const experiment: Experiment = {
  id: "predict-policy-metric",
  title: "Predict which policy clears the queue",
  simId: "autoscaling-policies",
  question:
    "Demand ramps to 26k rps. CPU stays near its 60% target because workers wait on a downstream queue, but queue depth and errors climb. Which change adds the capacity the service needs?",
  prediction: {
    options: [
      { id: "cpu", label: "Lower the CPU target so the same policy adds capacity sooner" },
      { id: "queue", label: "Scale on queue depth, with enough maximum capacity and startup time" },
      { id: "cooldown", label: "Add a cooldown so the policy stops changing capacity" },
      { id: "max", label: "Raise the maximum but keep the CPU target" },
    ],
    correctOptionId: "queue",
    explanation:
      "A CPU target can stay satisfied while requests wait on I/O or a downstream dependency. Lowering the target adds some capacity, but it still follows a metric that is not the bottleneck, and the new instances still need startup time. Raising the maximum does nothing while the policy's desired count stays low. Queue depth is the signal that reflects the work waiting to be served, so it asks for the capacity the service actually needs.",
  },
  setup: defaults({ peakRps: 26_000, policy: 0, startupSeconds: 90, maxInstances: 20 }),
  runFor: 45,
  observe: [
    "CPU settles near its 60% target while queue depth passes 20,000 requests.",
    "The CPU policy asks for about 11 instances; the queue needs more than 20.",
    "The fleet sheds nearly half of demand and p99 runs into seconds.",
    "The maximum instance count is not the binding constraint; the metric is.",
  ],
  explain:
    "Target tracking is only as good as its target. A CPU target answers how busy the processor is, not how much work is waiting. When the bottleneck is downstream, CPU can look healthy while the service fails. Follow the metric that limits goodput, then give the policy a ceiling and a startup allowance that can cover the peak.",
  fix: defaults({ peakRps: 26_000, policy: 1, startupSeconds: 20, maxInstances: 40 }),
  debrief:
    "Queue-depth tracking asks for enough instances to drain the queue, and the 40-instance ceiling leaves room to reach it. Startup still takes 20 simulated seconds, so the first part of the ramp is served from headroom. The trade is a larger fleet and more cost during the peak; the alternative is a policy that is cheap and wrong.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An autoscaling policy is a control loop. It reads a metric, compares it with a target, and writes a desired capacity. Target tracking keeps the metric near the target by adding or removing capacity within a minimum and maximum. The loop is only as good as the metric it follows. If the metric is CPU but requests wait in a queue or on a downstream call, CPU can sit below its target while the service sheds work. The policy is not broken; it is answering the wrong question.",
  },
  {
    type: "p",
    text: "Three delays separate a correct signal from capacity. The metric has to move, the policy has to evaluate it, and new instances have to launch, register, and warm before they serve traffic. EC2 Auto Scaling calls that last period the instance warm-up time. Target tracking does not use the simple-scaling cooldown in the same way; it reacts to the metric, but the warm-up still applies. A policy that reacts in ten seconds can still take minutes to add useful capacity, so the target must leave headroom for the ramp.",
  },
  {
    type: "p",
    text: "A maximum capacity is a guardrail, not a target. When desired capacity reaches the maximum, the policy has no more room and the fleet saturates. A policy with the right metric and a ceiling that is too low looks identical to a policy with the wrong metric: errors rise while desired capacity is pinned. Check both before changing the target.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The policy sits beside the fleet, between the load balancer and the capacity provider. The load balancer keeps sending requests; the policy changes how many instances receive them. The downstream queue or database determines how much concurrency each instance can sustain. That is why the bottleneck metric often belongs to the dependency, not the instance: the instance is waiting, not working.",
  },
  {
    type: "table",
    headers: ["Policy", "Signal", "Adds capacity when", "Typical failure"],
    rows: [
      ["CPU target tracking", "Average CPU utilization", "CPU is above the target", "CPU is low because workers wait on I/O"],
      ["Queue-depth target", "Requests waiting to be served", "Depth is above the target", "Queue is unbounded or the target is set too high"],
      ["Request-count target", "Requests per instance", "Requests per target is above the target", "Traffic is cheap and the service is not the bottleneck"],
      ["Simple or step scaling", "Alarm threshold", "The alarm breaches", "Cooldown blocks the next needed change"],
    ],
  },
  {
    type: "p",
    text: "The model uses 1,200 rps of service capacity per instance, 4,000 rps of CPU capacity, a 75% service target, a 60% CPU target, and a 24-second demand ramp. Those are teaching values, not AWS quotas or instance benchmarks. The startup slider is the time to useful capacity, not the API response time for a launch request. The queue is bounded by the model so the chart stays readable; a real queue would keep growing until something sheds or fails.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Fleet utilization, the ratio of demand to the service capacity of running instances.",
      "CPU utilization, which can stay below its target while the queue grows.",
      "Queue depth and error rate, the signals that show work waiting and work rejected.",
      "p99 latency, which rises before errors when the fleet is saturated.",
      "In-service capacity, so desired capacity and actual capacity are separate numbers.",
      "A flow from client to load balancer to fleet to queue to database.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply CPU target on a queue bottleneck. Watch CPU stay near its target while queue depth and errors climb. Run the guided experiment before changing sliders. Then compare Recovery with Correct policy, low ceiling: one fixes the metric, the other fixes the ceiling, and the charts show which constraint is binding.",
  },
  { type: "sim", simId: "autoscaling-policies" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The service started with enough capacity for the 9k rps baseline. Demand ramped to 26k rps over 24 simulated seconds. The CPU policy saw a processor that was busy but not saturated, because workers were waiting on the downstream queue. It asked for about 11 instances, while the service needed more than 20 to serve the offered load at the 75% target. Queue depth passed 20,000 requests, p99 ran into seconds, and the fleet shed nearly half of demand.",
  },
  {
    type: "p",
    text: "The ceiling was 20 instances, so even a correct queue-depth target would have been clipped, but the CPU policy never asked for 20. That distinction matters during an incident: a pinned desired count points to the maximum, while a low desired count points to the metric or the target. The model shows both because the CPU policy asks for less than the ceiling and the fleet still fails.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Auto Scaling activity history: desired, in-service, and pending capacity, plus the policy that changed them.",
      "Target tracking alarms: the metric value and the target, not only the resulting instance count.",
      "Load balancer: RequestCount, TargetResponseTime, HTTPCode_Target_5XX_Count, and UnHealthyHostCount.",
      "Queue metrics: approximate age of the oldest message and visible depth. Depth alone is ambiguous without arrival rate.",
      "Instance launch logs and readiness probes: the gap between launch and first served request is the warm-up cost.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare desired, in-service, and pending capacity with demand. Then compare the policy's target metric with queue depth and error rate. If desired is pinned at the maximum, raise the ceiling; if desired is low while the queue grows, the policy is watching the wrong signal. Check warm-up before assuming the policy is too slow.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the bottleneck: queue depth and p99 rising while CPU is below target means the policy metric is wrong.",
      "Switch the policy to the bottleneck signal, measured per instance or per fleet consistently.",
      "Set the target with enough headroom for the ramp and for the loss of one instance or zone.",
      "Raise the maximum above the peak requirement, and check that the account and Region quota allow it.",
      "Reduce time-to-capacity with a warm pool, a smaller launch footprint, or pre-scaling for known peaks.",
      "Test with a ramp faster than production and verify that errors stay inside the SLO while capacity converges.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A queue-depth target follows the work, but queue depth can be noisy and needs an age signal to distinguish a fast drain from a stalled consumer.",
      "A lower target adds capacity sooner and costs more at every normal peak.",
      "A higher maximum protects the peak and raises the bill only when the policy reaches it, but the quota must exist before the incident.",
      "Faster startup reduces the lag and usually costs more per instance-hour or constrains the instance types you can use.",
      "Pre-scaling is cheap when the pattern is known and wasteful when it is not. Warm pools reduce the gap but still bill for idle capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-metric",
    question:
      "A service scales on CPU, but latency rises while CPU stays at 55%. How do you choose the right policy metric?",
    difficulty: 2,
    hints: [
      "Find the resource or queue that limits goodput.",
      "CPU below target while latency rises means the fleet is waiting, not computing.",
    ],
    answer:
      "I would trace a slow request and measure the time spent waiting versus the time spent on CPU. If requests wait on a downstream queue, a lock, or I/O, CPU is not the bottleneck. I would switch the policy to the signal that tracks that wait, such as queue depth or concurrency, and verify that the signal moves before errors. I would also check whether the current target has headroom, whether desired capacity is pinned at the maximum, and how long new instances take to become useful.",
    followUps: [
      "What would make queue depth a poor target?",
      "How do you avoid scaling on a noisy metric?",
      "Would you scale on latency directly?",
    ],
    redFlags: [
      "Lowering the CPU target without checking the bottleneck.",
      "Treating CPU as a proxy for all saturation.",
      "Ignoring startup time and the maximum.",
    ],
    rubric: [
      "Identifies the real bottleneck.",
      "Names a metric that tracks it.",
      "Checks the ceiling and warm-up.",
      "Validates the signal against errors.",
    ],
  },
  {
    id: "diagnose-pinned",
    question:
      "Desired capacity is 20, the maximum is 20, and errors are rising. What do you check, and what do you change?",
    difficulty: 2,
    hints: [
      "A pinned desired count is a ceiling problem before it is a metric problem.",
      "Check quota and instance availability as well as the configured maximum.",
    ],
    answer:
      "I would confirm that the policy is asking for more than the maximum and that the fleet is actually at the maximum rather than waiting on pending instances. Then I would check the service quota, the instance type availability, and the scale-out velocity. If demand is legitimate and the SLO requires it, I would raise the maximum and the quota before the next peak, add headroom or a warm pool, and re-test the ramp. If demand is not legitimate, I would shed or rate-limit rather than buy capacity for it.",
    followUps: [
      "How do you distinguish a quota limit from a policy limit?",
      "What if the maximum is already high enough but instances are pending?",
      "How would you prove the new ceiling is sufficient?",
    ],
    redFlags: [
      "Raising the target instead of the ceiling.",
      "Assuming the cloud will always have capacity.",
      "Ignoring pending instances.",
    ],
    rubric: [
      "Separates ceiling, quota, and startup.",
      "Checks pending capacity.",
      "Chooses raise, shed, or both deliberately.",
      "Re-tests the ramp.",
    ],
  },
  {
    id: "startup-cooldown",
    question:
      "How do startup time and cooldown change the capacity curve after a sudden spike?",
    difficulty: 3,
    hints: [
      "Startup is the time to useful capacity.",
      "A cooldown delays the next change; it does not make instances ready.",
    ],
    answer:
      "Startup time sets how long the fleet runs below desired capacity after the policy decides to scale. Cooldown, where the policy uses one, sets how long before another scaling action can run. Neither changes the demand curve. A long startup means the target must leave more headroom or the service must pre-scale. A long cooldown can prevent flapping, but after a spike it can also block the second scale-out that recovery needs. Target tracking reacts to the metric but still waits for warm-up, so I would measure time from metric breach to served capacity, not just the policy decision.",
    followUps: [
      "When is a cooldown useful?",
      "How would you measure time-to-capacity?",
      "What is the cost of a shorter startup?",
    ],
    redFlags: [
      "Treats cooldown as a capacity reserve.",
      "Ignores the metric-to-capacity delay.",
      "Adds a longer cooldown during a spike.",
    ],
    rubric: [
      "Separates startup from cooldown.",
      "Connects the delay to headroom.",
      "Mentions pre-scaling or warm pools.",
      "Measures served capacity, not just decisions.",
    ],
  },
  {
    id: "design-policy",
    question:
      "Design an autoscaling policy for a service whose bottleneck moves between CPU and queue depth during the day.",
    difficulty: 4,
    hints: [
      "One policy can follow one primary signal, but you can combine policies and guardrails.",
      "The ceiling and the floor matter as much as the target.",
    ],
    answer:
      "I would start by measuring which signal leads errors in each period. If the bottleneck really moves, I would use the signal that is closest to goodput for each period, or a composite target such as concurrency per instance, rather than averaging CPU and queue depth into a number that means neither. I would keep a minimum capacity that covers the base load, a maximum that covers the peak plus one failure domain, and a warm path for the morning ramp. I would test both regimes with open-loop load, watch desired versus in-service capacity, and add a queue-age alarm that fires before errors. The policy should have one owner and a documented reason for each bound.",
    followUps: [
      "How would you avoid two policies fighting?",
      "What would you measure after the change?",
      "How do you set the minimum?",
    ],
    redFlags: [
      "Averages unrelated metrics.",
      "Sets only a target and no bounds.",
      "Has no test for the moving bottleneck.",
    ],
    rubric: [
      "Measures the leading signal per regime.",
      "Sets floor, ceiling, and warm path.",
      "Assigns one owner.",
      "Tests both regimes.",
      "States cost and risk.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The policy metric is the metric that leads errors, not the easiest resource metric to chart.",
      "Desired, in-service, pending, and maximum capacity are on one dashboard with demand.",
      "The maximum covers peak demand plus the loss of one failure domain, and the quota allows it.",
      "Startup time is measured from launch to first served request.",
      "A load test ramps faster than the real morning peak and records time-to-capacity.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the policy target with queue depth, p99, and errors before changing the target.",
      "Check whether desired capacity is pinned at the maximum or below it.",
      "Check whether instances are pending, warming, or failing health checks.",
      "Shed low-priority work if capacity cannot arrive inside the SLO.",
      "Record the metric values and the policy decision timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the signal, the ceiling, or the startup path based on which one was binding.",
      "Re-run the ramp with the new policy and confirm errors stay inside the SLO.",
      "Add an alarm for desired capacity at the maximum and for queue age.",
      "Document the cost of the new floor, ceiling, and warm capacity.",
    ],
  },
];

const references = [
  {
    title: "Target tracking scaling policies for Amazon EC2 Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target tracking maintains a metric near a target within minimum and maximum capacity.",
  },
  {
    title: "Step and simple scaling policies for Amazon EC2 Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-simple-step.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Step adjustments and cooldowns change capacity in response to alarm breaches.",
  },
  {
    title: "Scaling cooldowns for Amazon EC2 Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cooldowns pause simple scaling; target tracking and warm-up behave differently.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "autoscaling-policies": {
      model: autoscalingPoliciesModel,
      presets,
      instructions:
        "Start healthy, apply CPU target on a queue bottleneck, then compare Recovery with Correct policy, low ceiling. Watch CPU, queue depth, and desired capacity together.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Instance throughput, targets, and timings are teaching values, not AWS quotas or benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-target-tracking",
    "capacity-warm-pools",
    "capacity-scheduled-scaling",
    "capacity-headroom-cost",
    "foundations-queueing-knee",
  ],
};
