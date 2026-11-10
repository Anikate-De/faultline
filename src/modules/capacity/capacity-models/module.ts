import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CONCURRENCY_PER_INSTANCE = 64;
const FAILURE_AT = 20;
const RAMP_SECONDS = 16;
const BASELINE_SHARE = 0.4;
const AVERAGE_SHARE = 0.45;

const params = [
  {
    id: "peakRps",
    label: "Peak arrival rate",
    min: 2_000,
    max: 50_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Demand",
    help: "Peak requests per second the model must serve. Demand ramps from 40% of peak over sixteen simulated seconds.",
    format: "rps" as const,
  },
  {
    id: "serviceTimeMs",
    label: "Mean service time",
    min: 20,
    max: 300,
    step: 10,
    value: 120,
    unit: " ms",
    group: "Demand",
    help: "Time one request occupies a worker, including dependency time. Queueing is not included; the model sizes for it through the utilization target.",
    format: "ms" as const,
  },
  {
    id: "targetUtilPct",
    label: "Utilization target",
    min: 40,
    max: 80,
    step: 5,
    value: 60,
    unit: "%",
    group: "Model",
    help: "Utilization the model plans to run at, leaving room for queueing and variability.",
    format: "percent" as const,
  },
  {
    id: "failureDomainPct",
    label: "Largest failure domain",
    min: 0,
    max: 50,
    step: 5,
    value: 34,
    unit: "%",
    group: "Model",
    help: "Share of capacity removed by the largest failure the design must survive. A service spread evenly across three zones uses about 33%.",
    format: "percent" as const,
  },
  {
    id: "provisionedInstances",
    label: "Provisioned instances",
    min: 20,
    max: 200,
    step: 1,
    value: 100,
    unit: " instances",
    group: "Plan",
    help: "Instances in the plan. Compare this with the model's requirement, not with last quarter's count.",
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

interface Computed {
  peakRps: number;
  demand: number;
  serviceMs: number;
  targetUtil: number;
  failureDomain: number;
  provisioned: number;
  required: number;
  failureAdjusted: number;
  capacity: number;
  effectiveCapacity: number;
  utilization: number;
  averageUtilization: number;
  p99: number;
  planGap: number;
}

function compute(p: Params, t: number): Computed {
  const peakRps = Math.max(1, num(p, "peakRps", 20_000));
  const demandFactor = BASELINE_SHARE + (1 - BASELINE_SHARE) * smoothstep(t / RAMP_SECONDS);
  const demand = peakRps * demandFactor;
  const serviceMs = Math.max(1, num(p, "serviceTimeMs", 120));
  const serviceSec = serviceMs / 1000;
  const targetUtil = clamp(num(p, "targetUtilPct", 60), 1, 100) / 100;
  const failureDomain = clamp(num(p, "failureDomainPct", 34), 0, 90) / 100;
  const provisioned = Math.max(1, num(p, "provisionedInstances", 100));
  const requiredConcurrency = peakRps * serviceSec;
  const required = requiredConcurrency / Math.max(1, CONCURRENCY_PER_INSTANCE * targetUtil);
  const failureAdjusted = required / Math.max(0.05, 1 - failureDomain);
  const capacity = provisioned * (CONCURRENCY_PER_INSTANCE / serviceSec);
  const effectiveInstances = t >= FAILURE_AT ? provisioned * (1 - failureDomain) : provisioned;
  const effectiveCapacity = effectiveInstances * (CONCURRENCY_PER_INSTANCE / serviceSec);
  const utilization = demand / Math.max(1, effectiveCapacity);
  const p99 =
    utilization <= 1
      ? serviceMs * (1 + (3 * Math.pow(utilization, 6)) / Math.max(0.15, 1.05 - utilization))
      : Math.min(15_000, serviceMs * 21 + (utilization - 1) * 6_000);
  return {
    peakRps,
    demand,
    serviceMs,
    targetUtil,
    failureDomain,
    provisioned,
    required,
    failureAdjusted,
    capacity,
    effectiveCapacity,
    utilization,
    averageUtilization: (peakRps * AVERAGE_SHARE) / Math.max(1, capacity),
    p99,
    planGap: Math.max(0, ((failureAdjusted - provisioned) / Math.max(1, failureAdjusted)) * 100),
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.utilization >= 0.85 || values.p99 >= 800 || values.planGap >= 20) return "crit";
  if (values.utilization >= 0.7 || values.p99 >= 300 || values.planGap >= 8) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const health = healthFor(values);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        sublabel: "requests",
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: health === "crit" ? "warn" : "ok",
        utilization: clamp(values.utilization),
        sublabel: `${Math.round(values.demand).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
      {
        id: "fleet",
        label: "Service fleet",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(values.utilization),
        throughput: Math.min(values.demand, values.effectiveCapacity),
        capacity: values.effectiveCapacity,
        sublabel: `${values.provisioned} instances · ${Math.ceil(values.failureAdjusted)} required`,
        detail: `Peak ${Math.round(values.peakRps).toLocaleString("en-US")} rps at ${values.serviceMs}ms needs ${values.required.toFixed(1)} instances at ${(values.targetUtil * 100).toFixed(0)}% utilization, or ${values.failureAdjusted.toFixed(1)} after a ${(values.failureDomain * 100).toFixed(0)}% failure domain. The plan has ${values.provisioned}.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Shared database",
        kind: "db",
        health: clamp(values.demand / 50_000) >= 0.9 ? "warn" : "ok",
        utilization: clamp(values.demand / 50_000),
        throughput: Math.min(values.demand, values.effectiveCapacity),
        sublabel: `${Math.round(values.demand).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.demand / 50_000), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.demand / 50_000), health),
      edge("fleet-db", "fleet", "db", clamp(values.demand / 50_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("peak-utilization", "Current utilization", values.utilization * 100, "%", 70, 85, "percent"),
      metric("average-utilization", "Average utilization", values.averageUtilization * 100, "%", undefined, undefined, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("model-gap", "Plan shortfall", values.planGap, "%", 8, 20, "percent"),
      metric("required-instances", "Required after failure", values.failureAdjusted, " instances", undefined, undefined, "count"),
      metric("provisioned-instances", "Provisioned instances", values.provisioned, " instances", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      failureEvent: 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `Peak ${Math.round(values.peakRps).toLocaleString("en-US")} rps at ${values.serviceMs}ms needs ${Math.ceil(values.failureAdjusted)} instances after a ${(values.failureDomain * 100).toFixed(0)}% failure domain. The plan has ${values.provisioned}, a ${values.planGap.toFixed(0)}% shortfall.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 10)) / 2.5))),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0);
  seedSeries(frame, seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "peak-utilization",
    metricId: "peak-utilization",
    warn: 70,
    crit: 85,
    title: "The plan runs past the safe utilization target",
    cause:
      "The provisioned count is below the model requirement at the current demand, or a failure domain has removed capacity. Queueing rises nonlinearly near saturation, so p99 rises before the average looks alarming.",
    fix:
      "Provision to the model requirement after the largest failure, or reduce demand with admission control. Do not raise the utilization target to make the plan fit.",
    checkFirst: [
      "Compare provisioned instances with the model requirement.",
      "Check whether a failure domain is currently lost.",
      "Check peak arrival and service time against the model inputs.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "Latency is breaching the SLO at the planned capacity",
    cause:
      "Utilization is high enough that queueing dominates. The model may have used an average arrival rate, an optimistic service time, or no failure-domain reserve.",
    fix:
      "Correct the input that is wrong, then re-provision. If the service time changed, fix the dependency or the query before adding instances.",
    checkFirst: [
      "Check whether service time changed since the model was written.",
      "Check arrival rate at the peak, not the monthly average.",
      "Check whether a failure domain or deployment removed capacity.",
    ],
  },
  {
    id: "model-gap",
    metricId: "model-gap",
    warn: 8,
    crit: 20,
    title: "The plan is short of the failure-adjusted requirement",
    cause:
      "The plan was built from average demand, ignored the largest failure domain, or used a utilization target that is too aggressive. The shortfall is visible before the failure happens.",
    fix:
      "Add the missing headroom. The requirement is peak concurrency divided by the target utilization, then divided by the surviving fraction after the largest failure.",
    checkFirst: [
      "Recompute concurrency from peak rps and service time.",
      "Check the failure-domain percentage used in the plan.",
      "Check whether the utilization target is a policy or a hope.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const capacityModelsModel: SimModel = {
  id: "capacity-capacity-models",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t);
    next.t = frame.t;
    next.events = frame.events;
    next.series = frame.series;
    const values = compute(p, t);
    let failureEvent = frame.flags.failureEvent === 1;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (t >= FAILURE_AT && values.failureDomain > 0 && !failureEvent) {
      pushEvent(next, {
        id: "failure-domain",
        at: t,
        severity: values.utilization >= 0.85 ? "crit" : "warn",
        title: "Largest failure domain removed capacity",
        detail: `${(values.failureDomain * 100).toFixed(0)}% of the fleet is gone. The plan has ${values.provisioned} instances against a failure-adjusted requirement of ${values.failureAdjusted.toFixed(1)}.`,
        nodeId: "fleet",
        metricId: "peak-utilization",
      });
      failureEvent = true;
    }

    next.flags.failureEvent = failureEvent ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `The plan has ${value("provisioned-instances").toFixed(0)} instances; the failure-adjusted model requires about ${Math.ceil(value("required-instances"))}.`,
    ];
    if (value("model-gap") >= 8) {
      items.push(
        `The plan is ${value("model-gap").toFixed(0)}% short before any failure. Average demand and a point forecast cannot produce this number; peak concurrency and the failure domain do.`,
      );
    }
    if (value("peak-utilization") >= 85) {
      items.push(
        `Current utilization is ${value("peak-utilization").toFixed(0)}% and p99 is ${value("p99-latency").toFixed(0)}ms. Queueing, not raw CPU, is the failure mode.`,
      );
    }
    items.push("Recompute the model when service time, peak shape, or the failure domain changes.");
    return items;
  },
  legend: [
    { label: "Inside the model", tone: "ok" },
    { label: "Short of target", tone: "warn" },
    { label: "Breaching SLO", tone: "crit" },
    { label: "Domain lost", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "100 instances against a 94.7-instance failure-adjusted requirement; a domain loss still leaves headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Tight plan",
    description: "80 instances leave a 15% shortfall; the plan survives a normal peak but not a domain loss.",
    tone: "warn",
    params: defaults({ provisionedInstances: 80 }),
  },
  {
    id: "failure",
    label: "Spreadsheet plan",
    description: "60 instances are enough at a 60% target before the failure, then a 34% domain loss pushes utilization past critical.",
    tone: "crit",
    params: defaults({ provisionedInstances: 60 }),
  },
  {
    id: "recovery",
    label: "Failure-adjusted",
    description: "110 instances cover the peak after the largest failure with reserve left for the ramp.",
    tone: "ok",
    params: defaults({ provisionedInstances: 110 }),
  },
  {
    id: "n-plus-zero",
    label: "N+0",
    description: "65 instances with no failure-domain reserve; it looks fine on a normal day.",
    tone: "warn",
    params: defaults({ provisionedInstances: 65, failureDomainPct: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-missing-headroom",
  title: "Predict what the spreadsheet missed",
  simId: "capacity-models",
  question:
    "The quarterly plan has 60 instances for a 20,000 rps peak at 120ms service time and a 60% target. It looks fine until one zone fails. What is missing?",
  prediction: {
    options: [
      { id: "growth", label: "Next quarter's traffic growth" },
      { id: "domain", label: "The capacity removed by the largest failure domain" },
      { id: "tls", label: "TLS handshake overhead" },
      { id: "discount", label: "The reserved-instance discount" },
    ],
    correctOptionId: "domain",
    explanation:
      "Peak concurrency is 20,000 rps times 0.12 seconds, or 2,400 requests in flight. At 64 workers per instance and a 60% target, that needs 62.5 instances. Surviving a 34% failure domain needs 62.5 divided by 0.66, or about 94.7 instances. The plan has 60, so the normal day looks acceptable but the failure day cannot be served. Growth matters, but it does not explain a plan that is already short after the failure.",
  },
  setup: defaults({ provisionedInstances: 60 }),
  runFor: 45,
  observe: [
    "Before the failure, utilization reaches about 63% and the plan looks close to the target.",
    "At 20 seconds the largest failure domain is removed, and utilization jumps past 90%.",
    "p99 breaches the SLO and the plan shortfall shows 36% before the failure even happens.",
  ],
  explain:
    "The model converts peak arrival rate and service time into concurrency with Little's law: concurrency equals arrival rate times time in system. It then divides by workers per instance and by the utilization target, and finally by the surviving fraction after the largest failure. The spreadsheet used a point estimate for demand and forgot the last division. The shortfall is visible before the failure, which is the point of building the model.",
  fix: defaults({ provisionedInstances: 100 }),
  debrief:
    "At 100 instances the plan still has 66 instances after a 34% domain loss, which carries the 20,000 rps peak at about 57% utilization. That is the headroom the model asks for: 62.5 instances at the target, 94.7 after the failure, rounded up with a small reserve. The cost is paying for roughly 40 more instances than the spreadsheet. That is the price of surviving the failure without a latency breach.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A capacity model turns demand into a resource requirement. The core is Little's law: the number of requests in flight equals the arrival rate multiplied by the time each request spends in the system. If a service receives 20,000 requests per second and each one occupies a worker for 120ms, then 2,400 requests are in flight on average. Divide by the workers each instance can run and by the utilization target, and you have an instance count. Then add the reserve for the largest failure domain. The utilization target is a service-level objective (SLO) decision, not a universal constant.",
  },
  {
    type: "p",
    text: "The model is not a forecast. It is a set of assumptions that can be tested. Peak arrival rate, service time, worker concurrency, utilization target, and failure-domain size each move the answer. A spreadsheet that multiplies average traffic by a growth rate and divides by a cost per instance is not a capacity model, because it has no concurrency, no queueing, and no failure reserve. It can be close on a normal day and wrong on the day that matters.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, service fleet, and shared dependency. The service fleet holds the workers and the queue. The load balancer spreads arrivals; it cannot create concurrency. The dependency contributes to service time, so a slower dependency raises the required concurrency without any traffic growth. The failure domain removes a share of the fleet, which is why the requirement is divided by the surviving fraction rather than multiplied by a generic headroom percentage.",
  },
  {
    type: "table",
    headers: ["Input", "What it answers", "Common mistake", "Effect on the plan"],
    rows: [
      ["Peak arrival rate", "How much demand at the worst hour", "Using the monthly average", "Underprovisions the peak"],
      ["Service time", "How long a request holds a worker", "Using a cached or best-case path", "Underprovisions concurrency"],
      ["Utilization target", "How much queueing the SLO allows", "Setting 90% because CPU looks idle", "Moves the knee too close"],
      ["Failure domain", "What survives the largest loss", "Ignoring it or using one zone", "Plan fails on the failure day"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and read the required instance count. Apply Spreadsheet plan, then watch the domain loss at 20 seconds. Compare N+0, which looks fine on a normal day. Run the experiment before changing sliders. Workers per instance, the demand ramp, and the failure-domain share are illustrative.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Current and average utilization, so the peak is not hidden by the average.",
      "p99 latency, the 99th-percentile response time, against the plan shortfall and the failure-adjusted requirement.",
      "Required and provisioned instance counts side by side.",
      "A flow view with the fleet marked when the failure domain is removed.",
    ],
  },
  { type: "sim", simId: "capacity-models" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The spreadsheet plan had 60 instances. At 20,000 rps and 120ms service time the model needs 62.5 instances at a 60% target, so the plan was already marginal before any failure. A 34% failure domain left about 40 instances, utilization jumped past 90%, and p99 crossed the critical threshold. The plan shortfall metric showed 36% before the failure, which is the value of modeling the requirement instead of waiting for the incident.",
  },
  {
    type: "p",
    text: "The N+0 preset is the trap that looks healthy. With no failure domain, 65 instances carry the peak at about 60% utilization and nothing breaches. The same plan fails as soon as a zone is lost. A capacity plan has to name the failure it is designed to survive, or it is only a normal-day plan.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Peak utilization is close to the target on a normal day, then jumps when a zone or deployment removes capacity.",
      "p99 rises before the average CPU chart looks alarming.",
      "The plan count matches last quarter's instance count, not a recomputed concurrency requirement.",
      "Service time increased after a dependency or query change, but the instance count did not move.",
      "The failure-domain reserve is a percentage in a document, not a number in the plan.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Recompute concurrency from peak rps and service time. Divide by workers and the utilization target. Then divide by the surviving fraction after the largest failure. Compare that number with the plan.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Replace the average arrival rate with a peak rate that matches the SLO window.",
      "Measure service time on the slow path, including dependencies, not on a cache hit.",
      "Choose a utilization target from the queueing behavior the SLO can tolerate.",
      "Compute the failure-adjusted requirement and provision to it.",
      "Validate the model against a real peak or a load test, then update the inputs when they change.",
      "Keep the model and the plan in the same review so the count cannot drift away from the assumptions.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A peak-based model costs more than an average-based plan and fails less often on the day that matters.",
      "A lower utilization target buys queueing headroom and pays for capacity that sits idle at normal load.",
      "A larger failure-domain reserve protects against zone loss and increases the steady-state bill.",
      "A more detailed model is harder to maintain; a simpler model with explicit assumptions is easier to challenge.",
      "Provisioning to the model is not free, but the alternative is discovering the shortfall during the failure.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "build-model",
    question: "How would you build a capacity model for a service?",
    difficulty: 3,
    hints: [
      "Start with concurrency, not instance count.",
      "The failure domain is a separate division.",
    ],
    answer:
      "I would start from peak arrival rate and service time, then use Little's law to get the concurrency in flight. I would divide by the workers per instance and by the utilization target the SLO can tolerate, which gives the instance count for a normal peak. Then I would divide by the surviving fraction after the largest failure domain and add a small reserve for the ramp. I would validate the inputs against a real peak or a load test and state the assumptions explicitly, because the model is only as good as its peak, service time, and target.",
    followUps: [
      "Which input is usually the most wrong?",
      "How would you handle a service with multiple request classes?",
      "What would you do if the plan cannot afford the result?",
    ],
    redFlags: [
      "Starts from the current instance count.",
      "Uses average traffic.",
      "Adds a generic 20% headroom instead of a failure domain.",
    ],
    rubric: [
      "Uses Little's law or equivalent concurrency math.",
      "Names peak, service time, and target.",
      "Applies a failure-domain reserve.",
      "Validates assumptions.",
    ],
  },
  {
    id: "spreadsheet",
    question: "Why does a spreadsheet forecast underprovision a service even when the growth rate is right?",
    difficulty: 3,
    hints: [
      "A growth rate is not a queueing model.",
      "The failure day is part of the requirement.",
    ],
    answer:
      "A growth forecast can get the average demand right and still miss the requirement because it has no concurrency, no service time, and no utilization target. It also tends to use a point estimate instead of a peak percentile and to ignore the largest failure domain. The service can be fine at the average and queue at the peak, or fine before a zone loss and short after it. The growth rate is only one input; the model needs the shape of demand and the capacity that must survive.",
    followUps: [
      "How would you test the forecast against reality?",
      "Which is worse: overprovisioning or underprovisioning?",
      "How often would you recompute?",
    ],
    redFlags: [
      "Believes a growth rate is sufficient.",
      "Ignores service time.",
      "Treats the failure domain as a fixed percentage of cost.",
    ],
    rubric: [
      "Names missing queueing and concurrency.",
      "Mentions peak versus average.",
      "Includes failure headroom.",
      "Proposes validation.",
    ],
  },
  {
    id: "assumptions",
    question: "Which assumptions in a capacity model would you challenge first?",
    difficulty: 2,
    hints: [
      "The answer should name the inputs that move the number most.",
      "Some inputs are measured; some are policy.",
    ],
    answer:
      "I would challenge the peak arrival rate and the service time first, because both multiply directly into concurrency. I would ask whether the peak is a real percentile, whether service time includes the slow dependency path, and whether the traffic mix changed. Then I would challenge the utilization target, because it is a policy choice that determines how close the service runs to the queueing knee. Finally I would check the failure-domain assumption against the actual architecture. The output is a product of those choices, so a confident number without them is not useful.",
    followUps: [
      "How would you measure service time?",
      "What utilization target would you start with?",
      "How would you communicate uncertainty?",
    ],
    redFlags: [
      "Accepts the peak without a source.",
      "Uses a best-case service time.",
      "Treats the target as a universal constant.",
    ],
    rubric: [
      "Challenges peak and service time.",
      "Treats utilization as a policy.",
      "Checks the failure domain.",
      "Communicates uncertainty.",
    ],
  },
];

const checklist = [
  {
    title: "Before the plan",
    items: [
      "Peak arrival rate is a defined percentile, not a monthly average.",
      "Service time includes the slow dependency path and the request mix.",
      "Workers per instance and the utilization target are measured or agreed.",
      "The largest failure domain is named, not assumed away.",
      "The model output is compared with a real peak or load test.",
    ],
  },
  {
    title: "During the review",
    items: [
      "Show the concurrency math, not only the final instance count.",
      "Separate the normal-peak requirement from the failure-adjusted requirement.",
      "State what would have to be true for the plan to be wrong.",
      "Include the cost of the reserve in the decision.",
    ],
  },
  {
    title: "After the plan",
    items: [
      "Recompute when service time, mix, or failure domain changes.",
      "Compare actual peak utilization with the model's target.",
      "Record the assumptions and the date they were measured.",
      "Test the failure case before it happens.",
    ],
  },
];

const references = [
  {
    title: "Google SRE Book: Handling Overload",
    url: "https://sre.google/sre-book/handling-overload/",
    publisher: "Google",
    kind: "book" as const,
    note: "Capacity, load, and the behavior of services near saturation.",
  },
  {
    title: "AWS Well-Architected: Reliability Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Designing for failure, static stability, and capacity that survives a loss of a zone or component.",
  },
  {
    title: "Amazon EC2 Auto Scaling: dynamic scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-dynamic-scaling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How scaling policies respond to metrics; a model still has to set the floor and the failure reserve.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "capacity-models": {
      model: capacityModelsModel,
      presets,
      instructions:
        "Start Healthy and read the required count. Apply Spreadsheet plan, watch the domain loss at 20 seconds, then compare Failure-adjusted and N+0. Run the experiment before changing sliders.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Workers per instance, the 40% baseline, service-time shape, and the failure-domain percentage are teaching values, not benchmarks for a specific service.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-littles-law",
    "capacity-peak-events",
    "capacity-headroom-cost",
    "capacity-queueing-headroom",
  ],
};
