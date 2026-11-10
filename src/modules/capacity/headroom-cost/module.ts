import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AZ_COUNT = 3;
const INSTANCE_RPS = 2_000;
const HOURS_PER_MONTH = 730;
const FAILURE_AT = 25;
const TARGET_UTIL = 70;

const params = [
  {
    id: "fleetInstances",
    label: "Fleet size",
    min: 12,
    max: 96,
    step: 1,
    value: 60,
    unit: " instances",
    group: "Capacity",
    help: "Instances spread as evenly as possible across three availability zones (AZs).",
    format: "count" as const,
  },
  {
    id: "peakRps",
    label: "Peak request rate",
    min: 10_000,
    max: 100_000,
    step: 1_000,
    value: 60_000,
    unit: " rps",
    group: "Demand",
    help: "The busiest sustained rate, not the daily average. Demand is held flat at this rate; the post-failure target is where variability is priced.",
    format: "rps" as const,
  },
  {
    id: "instanceCostPerHour",
    label: "Instance cost",
    min: 0.05,
    max: 1,
    step: 0.01,
    value: 0.2,
    unit: " $/h",
    group: "Cost",
    help: "Illustrative blended cost per instance-hour. Replace it with your own rate; it is not an AWS price.",
    format: "number" as const,
  },
  {
    id: "azFailure",
    label: "Lose one AZ at 25s",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 removes the largest availability zone at 25 simulated seconds. 0 keeps all three zones serving.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function azCapacities(fleet: number): number[] {
  const base = Math.floor(fleet / AZ_COUNT);
  const remainder = fleet % AZ_COUNT;
  return Array.from({ length: AZ_COUNT }, (_, index) => base + (index < remainder ? 1 : 0));
}

function demandAt(peakRps: number): number {
  return Math.max(1, peakRps);
}

function latencyFor(utilizationPct: number): number {
  if (utilizationPct >= 100) return Math.min(15_000, 2_500 + (utilizationPct - 100) * 50);
  const ratio = utilizationPct / 100;
  return Math.min(2_500, 60 + (240 * Math.pow(ratio, 8)) / Math.max(0.05, 1.1 - ratio));
}

function errorsFor(utilizationPct: number): number {
  if (utilizationPct <= 95) return 0;
  return Math.min(60, (utilizationPct - 95) * 1.2);
}

interface Computed {
  fleet: number;
  peakRps: number;
  demand: number;
  zoneCapacities: number[];
  totalCapacity: number;
  survivingCapacity: number;
  activeCapacity: number;
  utilization: number;
  n1Utilization: number;
  errors: number;
  p99: number;
  monthlyCostK: number;
  idleCostK: number;
  headroomPct: number;
  capacityShortfall: number;
  azFailed: boolean;
}

function compute(p: Params, azFailed: boolean): Computed {
  const fleet = Math.max(3, Math.round(num(p, "fleetInstances", 60)));
  const peakRps = Math.max(1_000, num(p, "peakRps", 60_000));
  const rate = Math.max(0, num(p, "instanceCostPerHour", 0.2));
  const demand = demandAt(peakRps);
  const zones = azCapacities(fleet);
  const totalCapacity = fleet * INSTANCE_RPS;
  const lost = Math.max(...zones) * INSTANCE_RPS;
  const survivingCapacity = totalCapacity - lost;
  const activeCapacity = azFailed ? survivingCapacity : totalCapacity;
  const utilization = (demand / Math.max(1, activeCapacity)) * 100;
  const n1Utilization = (demand / Math.max(1, survivingCapacity)) * 100;
  const monthlyCostK = (fleet * rate * HOURS_PER_MONTH) / 1_000;
  const idleInstances = Math.max(0, (totalCapacity - peakRps) / INSTANCE_RPS);
  return {
    fleet,
    peakRps,
    demand,
    zoneCapacities: zones,
    totalCapacity,
    survivingCapacity,
    activeCapacity,
    utilization,
    n1Utilization,
    errors: errorsFor(utilization),
    p99: latencyFor(utilization),
    monthlyCostK,
    idleCostK: (idleInstances * rate * HOURS_PER_MONTH) / 1_000,
    headroomPct: Math.max(0, ((activeCapacity - demand) / Math.max(1, activeCapacity)) * 100),
    capacityShortfall: Math.max(0, demand - activeCapacity),
    azFailed,
  };
}

function capacityHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.errors >= 5 || values.utilization >= 95) return "crit";
  if (values.errors >= 1 || values.utilization >= 80 || values.n1Utilization >= 100) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["fleet-utilization", values.utilization, 0.5],
    ["error-rate", values.errors, 0.04],
    ["n1-utilization", values.n1Utilization, 0.5],
    ["monthly-cost", values.monthlyCostK, 0.03],
    ["idle-cost", values.idleCostK, 0.02],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 3.4);
      return Math.max(0, value * (0.99 + 0.01 * wave) + amplitude * Math.sin(index / 2.6));
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  state: { azFailed: boolean; n1RiskEvent: boolean; azEvent: boolean },
): SimFrame {
  const values = compute(p, state.azFailed);
  const health = capacityHealth(values);
  const zoneLabel = values.zoneCapacities
    .map((count, index) => {
      const name = ["AZ A", "AZ B", "AZ C"][index] ?? `AZ ${index}`;
      return `${name} ${state.azFailed && index === 0 ? "lost" : `${count}`}`;
    })
    .join(" · ");
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: "ok",
        throughput: values.demand,
        sublabel: `${Math.round(values.demand).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: health === "crit" ? "crit" : health === "warn" ? "warn" : "ok",
        utilization: clamp(values.utilization / 100),
        throughput: Math.min(values.demand, values.activeCapacity),
        sublabel: `${Math.round(values.errors).toFixed(0)}% errors`,
        meta: { view: "flow" },
      },
      {
        id: "fleet",
        label: "Three-AZ fleet",
        kind: "service",
        role: "zone",
        health,
        utilization: clamp(values.utilization / 100),
        throughput: Math.min(values.demand, values.activeCapacity),
        capacity: values.activeCapacity,
        sublabel: `${values.fleet} instances · ${Math.round(values.utilization)}% utilized`,
        detail: `${zoneLabel}. Surviving capacity after one AZ loss is ${Math.round(values.survivingCapacity).toLocaleString("en-US")} rps, or ${Math.round(values.n1Utilization)}% utilization at this demand.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Database",
        kind: "db",
        health: values.utilization > 100 ? "warn" : "ok",
        utilization: clamp(Math.min(values.demand, values.activeCapacity) / 120_000),
        throughput: Math.min(values.demand, values.activeCapacity),
        sublabel: "shared by the surviving zones",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.demand / 100_000), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.utilization / 100), health),
      edge("fleet-db", "fleet", "db", clamp(Math.min(values.demand, values.activeCapacity) / 120_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("fleet-utilization", "Fleet utilization", values.utilization, "%", 80, 95, "percent"),
      metric("error-rate", "Error rate", values.errors, "%", 1, 5, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 300, 1_000, "ms"),
      metric("n1-utilization", "Post-failure utilization (one AZ)", values.n1Utilization, "%", undefined, undefined, "percent"),
      metric("monthly-cost", "Monthly capacity cost", values.monthlyCostK, " k$", undefined, undefined, "number"),
      metric("idle-cost", "Cost above peak demand", values.idleCostK, " k$", undefined, undefined, "number"),
      metric("headroom", "Headroom above peak", values.headroomPct, "%", undefined, undefined, "percent"),
      metric("capacity-shortfall", "Unserved demand", values.capacityShortfall, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      azFailed: state.azFailed ? 1 : 0,
      n1RiskEvent: state.n1RiskEvent ? 1 : 0,
      azEvent: state.azEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.fleet} instances across three AZs cost ${values.monthlyCostK.toFixed(1)}k$/month. At ${Math.round(values.demand).toLocaleString("en-US")} rps, utilization is ${values.utilization.toFixed(0)}% and one-AZ-loss utilization would be ${values.n1Utilization.toFixed(0)}%. Illustrative cost.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, { azFailed: false, n1RiskEvent: false, azEvent: false });
  seedSeries(frame, compute(p, false), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "fleet-utilization",
    metricId: "fleet-utilization",
    warn: 80,
    crit: 95,
    title: "The surviving fleet is saturated",
    cause:
      "Demand is close to or above the capacity still serving after a failure. Headroom that looked adequate at average load is gone when one failure domain is removed.",
    fix:
      "Add capacity until post-failure utilization meets the SLO target, or reduce the failure domain so one loss removes less capacity. Do not count on failover to create capacity that was never provisioned.",
    checkFirst: [
      "Compare peak demand with capacity after the largest zone is removed.",
      "Check whether the fleet is evenly spread across zones.",
      "Check whether the SLO target is defined for pre-failure or post-failure utilization.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Requests are failing after capacity loss",
    cause:
      "The surviving fleet cannot serve demand at the target latency, so requests are rejected or time out. This is the SLO breach that the headroom was meant to prevent.",
    fix:
      "Restore capacity first, then re-size the fleet so one failure domain can be lost at peak without breaching the SLO. Add admission control only as a deliberate degradation, not as a substitute for capacity.",
    checkFirst: [
      "Check errors by zone and target group after the failure.",
      "Check whether latency rose before errors, which indicates saturation rather than a code defect.",
      "Check whether the load balancer still sends traffic to the failed zone.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 1_000,
    title: "Latency is climbing past the SLO",
    cause:
      "Queueing rises nonlinearly as the surviving fleet approaches saturation. A fleet at 100% utilization has no spare service time for variability or retries.",
    fix:
      "Restore headroom or shed low-priority traffic. Size for the post-failure target, not for exactly 100% of peak.",
    checkFirst: [
      "Compare p99 at peak before and after the failure.",
      "Check retry volume, which adds load to an already saturated fleet.",
      "Check whether the database is now the bottleneck rather than the fleet.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const headroomCostModel: SimModel = {
  id: "capacity-headroom-cost",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    let azFailed = fresh ? false : frame.flags.azFailed === 1;
    let n1RiskEvent = fresh ? false : frame.flags.n1RiskEvent === 1;
    let azEvent = fresh ? false : frame.flags.azEvent === 1;
    const wantsFailure = num(p, "azFailure", 0) >= 0.5;
    if (wantsFailure && t >= FAILURE_AT) azFailed = true;
    else if (!wantsFailure) azFailed = false;

    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), {
      azFailed,
      n1RiskEvent,
      azEvent,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    const values = compute(p, azFailed);
    if (!n1RiskEvent && values.n1Utilization >= 99.5) {
      pushEvent(next, {
        id: "n1-risk",
        at: t,
        severity: "warn",
        title: "One AZ loss would exhaust the fleet",
        detail: `At ${Math.round(values.demand).toLocaleString("en-US")} rps, the surviving zones would run at ${values.n1Utilization.toFixed(0)}% utilization. There would be no room for variability or retries.`,
        nodeId: "fleet",
        metricId: "n1-utilization",
      });
      n1RiskEvent = true;
    }

    if (azFailed && !azEvent) {
      pushEvent(next, {
        id: "az-failure",
        at: t,
        severity: values.utilization >= 95 ? "crit" : values.utilization >= 80 ? "warn" : "info",
        title: "One availability zone is lost",
        detail: `The fleet lost ${(values.totalCapacity - values.survivingCapacity).toLocaleString("en-US")} rps of capacity. Surviving utilization is ${values.utilization.toFixed(0)}%, with ${Math.round(values.capacityShortfall).toLocaleString("en-US")} rps unserved.`,
        nodeId: "fleet",
        metricId: "fleet-utilization",
      });
      azEvent = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      azFailed: azFailed ? 1 : 0,
      n1RiskEvent: n1RiskEvent ? 1 : 0,
      azEvent: azEvent ? 1 : 0,
      paramsKey: key,
      seed: Number(frame.flags.seed ?? 20261110),
    };

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const util = value("fleet-utilization");
    const n1 = value("n1-utilization");
    const cost = value("monthly-cost");
    const idle = value("idle-cost");
    const items: string[] = [
      `Capacity costs ${cost.toFixed(1)}k$ per month in this illustrative model; ${idle.toFixed(1)}k$ of that is capacity above peak demand.`,
      `Current utilization is ${util.toFixed(0)}%. After losing the largest AZ it would be ${n1.toFixed(0)}%.`,
    ];
    if (n1 >= 95) {
      items.push("Exact N+1 is not headroom: the surviving fleet has no operating margin for variability, failover, or retries.");
    } else if (n1 > TARGET_UTIL) {
      items.push(`Post-failure utilization is above the ${TARGET_UTIL}% target. The fleet survives one loss but not with the SLO margin you designed for.`);
    } else {
      items.push("Post-failure utilization is inside the target. The remaining question is whether the monthly cost is acceptable for the SLO.");
    }
    items.push("Compare the headroom cost with the cost of the SLO breach, not with a zero-cost baseline.");
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
    description: "60 instances cost 8.8k$ per month, with 50% headroom above the 60k rps peak.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak demand",
    description: "80k rps needs a larger fleet; 78 instances keep post-failure utilization at about 77%, above the 70% target but below the warning line.",
    tone: "info",
    params: defaults({ peakRps: 80_000, fleetInstances: 78 }),
  },
  {
    id: "failure",
    label: "Headroom cut",
    description: "42 instances look adequate at peak, then one AZ loss removes a third of capacity.",
    tone: "crit",
    params: defaults({ peakRps: 60_000, fleetInstances: 42, azFailure: 1 }),
  },
  {
    id: "n-plus-one",
    label: "Exact N+1",
    description: "45 instances survive one AZ loss at exactly 100% utilization; there is no margin for variability.",
    tone: "crit",
    params: defaults({ peakRps: 60_000, fleetInstances: 45, azFailure: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "66 instances keep post-failure utilization near 68% and stay inside the SLO.",
    tone: "ok",
    params: defaults({ peakRps: 60_000, fleetInstances: 66, azFailure: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-exact-n1",
  title: "Predict what exact N+1 buys",
  simId: "headroom-cost",
  question:
    "Finance proposes 45 instances for a 60k rps peak. That is exactly enough for two of three AZs to carry peak at 100% utilization. What happens when one AZ fails at peak?",
  prediction: {
    options: [
      { id: "holds", label: "The SLO holds because the surviving zones carry exactly peak" },
      { id: "breach", label: "Utilization reaches 100% and latency and errors breach the SLO" },
      { id: "two", label: "Nothing happens unless a second AZ also fails" },
      { id: "cost", label: "The fleet saves money and utilization falls" },
    ],
    correctOptionId: "breach",
    explanation:
      "Exact N+1 leaves zero operating margin. A fleet at 100% utilization has no service time for traffic variability, retries, or failover transients, and queueing latency rises sharply as utilization approaches one. The model reports latency in the seconds and errors above the critical line. N+1 is a capacity floor, not a target.",
  },
  setup: defaults({ peakRps: 60_000, fleetInstances: 45, azFailure: 1 }),
  runFor: 40,
  observe: [
    "Before 25 seconds the 45-instance fleet runs at about 67% utilization and looks fine.",
    "At 25 seconds the largest AZ is removed, leaving 60k rps of capacity for about 60k rps of demand.",
    "Utilization reaches 100%, p99 rises to seconds, and the error rate crosses the critical line.",
    "The monthly cost is about 6.6k$, roughly 3.1k$ less than the 66-instance recovery fleet.",
  ],
  explain:
    "The fleet survives the loss in the arithmetic sense: surviving capacity equals peak demand. It does not survive in the SLO sense. At 100% utilization, queueing delay grows without bound and any variability or retry pushes requests over the edge. The target should be set on post-failure utilization, not on pre-failure cost.",
  fix: defaults({ peakRps: 60_000, fleetInstances: 66, azFailure: 1 }),
  debrief:
    "66 instances keep post-failure utilization near 68% and hold the SLO. The extra 21 instances cost about 3.1k$ per month in this illustrative model. That is the price of the insurance. The trade is explicit: pay for headroom every month, or accept a breach when the failure domain is lost. A cheaper option is to shrink the failure domain, not to assume failover creates capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Headroom is capacity you have provisioned but are not using at peak. It is not waste by definition. It is the margin that absorbs traffic variability, failover transients, retries, and the loss of a failure domain. N+1 means the system survives the loss of one failure domain, usually one availability zone (AZ). N+2 means it survives two. The arithmetic is simple: if peak demand is D and one AZ holds a share s of capacity, the surviving capacity must serve D at or below the service-level objective (SLO) target utilization. For three equal zones, s is one third, so the fleet must be larger than D divided by two thirds, and larger still if the post-failure target is below 100%.",
  },
  {
    type: "p",
    text: "The cost of headroom is the part of the bill that buys no throughput at peak. It is real money, and it should be defended as insurance rather than hidden as an accounting accident. The right amount depends on three things: the SLO, the size of the failure domain, and the variability of demand. A service with a tight latency SLO and bursty traffic needs more post-failure margin than a batch service that can queue. A fleet spread across three zones loses a third of its capacity when one fails; a fleet spread across two loses half. The same N+1 arithmetic produces a very different bill.",
  },
  {
    type: "p",
    text: "This model uses 2,000 requests per second (rps) of usable capacity per instance, three equal AZs, a 70% post-failure utilization target, and an illustrative instance rate. The 2,000 rps figure is a teaching value, not an instance benchmark. Demand is held flat at peak so the post-failure arithmetic is visible; the target utilization is where variability is priced. The point is not the exact number of instances; it is the relationship between peak, failure-domain size, target utilization, and cost.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Headroom sits between the SLO and the bill. Above it, the reliability target says how much capacity must survive a failure. Below it, the cost model prices the instances that provide that capacity. The load balancer and the Auto Scaling group are the mechanisms that spread traffic and replace capacity, but they cannot manufacture capacity that was never provisioned. A fleet that is exactly N+1 at 100% utilization has no room for the time it takes to detect a failure, remove a zone, and rebalance.",
  },
  {
    type: "table",
    headers: ["Fleet", "Post-failure utilization at 60k rps", "Monthly cost (illustrative)", "What it buys"],
    rows: [
      ["45 instances", "100%", "6.6k$", "Exact N+1; no operating margin"],
      ["60 instances", "75%", "8.8k$", "One-AZ survival with some variability margin"],
      ["66 instances", "68%", "9.6k$", "Meets a 70% post-failure target"],
      ["78 instances", "58%", "11.4k$", "Room for larger peaks and slower failover"],
    ],
  },
  {
    type: "p",
    text: "The table uses the same illustrative rate for every row. In production the rate changes with instance family, commitments, and region, and the capacity per instance changes with the workload. The shape of the tradeoff is what transfers: below the N+1 floor the SLO is not protected, and above the target you are buying margin that may not be needed. The useful question is not whether 40% looks idle; it is what failure or peak that 40% is sized to absorb.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Fleet utilization, with warning at 80% and critical at 95% in this model.",
      "Post-failure utilization, the what-if number that shows whether one AZ loss fits inside the target.",
      "Error rate and p99 latency, which rise together once the surviving fleet saturates.",
      "Monthly capacity cost and the cost of capacity above peak demand, both illustrative.",
      "Unserved demand, the rps the surviving fleet cannot carry.",
      "A three-AZ flow with a failure preset that removes the largest zone at 25 seconds.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note that post-failure utilization is already 75%, even though current utilization is about 50%. Apply Headroom cut and watch the fleet look adequate until 25 seconds, then fail. Run the guided experiment before changing sliders. Compare Exact N+1 with Recovery and read the monthly cost difference against the SLO. All costs are illustrative.",
  },
  { type: "sim", simId: "headroom-cost" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Before the failure, 42 instances carried 60k rps at roughly 71% utilization. The fleet looked healthy by the current-utilization threshold. At 25 seconds the largest AZ was removed, taking 28k rps of capacity with it. The surviving 56k rps could not serve the demand, so utilization crossed 107%, latency rose to seconds, and the error rate crossed the critical line. The incident was not caused by a traffic surge. It was caused by a fleet that had no margin for the failure it was supposed to survive. All figures in this module are illustrative.",
  },
  {
    type: "p",
    text: "The cost of the missing headroom was invisible until the failure. The 42-instance fleet cost about 6.1k$ per month, roughly 2.6k$ less than the 60-instance healthy fleet. That saving was the premium the team chose not to pay. The 66-instance recovery fleet costs about 9.6k$ per month and keeps post-failure utilization near 68%, inside the 70% target.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "EC2 Auto Scaling: GroupInServiceInstances by AZ, plus the group's desired and maximum capacity. The per-zone view is what shows whether the fleet is evenly spread.",
      "Load balancer: HealthyHostCount and UnHealthyHostCount by availability zone, plus target response time and 5xx counts. Errors concentrated in the surviving zones point to saturation.",
      "CloudWatch or your metrics store: utilization and p99 by zone, not only the fleet average. An average can hide one zone carrying more than its share.",
      "Capacity and cost: instance hours by AZ, plus the cost of capacity above peak. This is the number that makes the headroom conversation concrete.",
      "Failure injection: an AZ evacuation or zone-failure game day, run at peak, is the only way to prove the headroom before it is needed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute post-failure utilization at peak, not average utilization. Compare the largest failure domain with the capacity that survives it. Check whether the SLO target is defined for normal operation or for the degraded state. If the answer is normal operation, the fleet has no agreed post-failure target at all.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the SLO in the degraded state: what latency and error rate must hold after one AZ is lost.",
      "Size the fleet from peak demand, the largest failure domain, and the post-failure target utilization.",
      "Check that capacity is evenly spread across zones. An uneven spread makes the largest domain larger than one third.",
      "Test the actual failure at peak. A tabletop calculation does not exercise failover, DNS, or load-balancer rebalancing.",
      "Price the headroom explicitly and compare it with the cost of the SLO breach and the risk appetite.",
      "If the cost is unacceptable, reduce the failure domain or the peak, not the post-failure target.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Headroom costs money every month and may never be used. That is what insurance looks like; the alternative is a breach with a larger, less predictable cost.",
      "Exact N+1 protects the arithmetic and not the SLO. Variability, failover time, and retries all consume the margin.",
      "A larger number of smaller instances can reduce the failure-domain share, but it adds operational overhead and per-instance limits.",
      "Over-provisioning hides inefficient code and slow failover. Headroom is not a substitute for fixing either.",
      "A tight post-failure target is expensive. A loose one is cheaper but changes the user experience precisely when the system is already degraded.",
      "The cheapest option is sometimes to reduce peak demand through admission control or queueing, but that is a product decision, not a capacity one.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "justify-headroom",
    question:
      "Finance says 40% of your capacity is idle. How do you justify or challenge that number?",
    difficulty: 2,
    hints: [
      "Idle at average load is not the same as idle at peak.",
      "Start from the failure domain and the SLO.",
    ],
    answer:
      "I would translate the percentage into the capacity that must survive a failure. First, peak demand and the largest failure domain: with three equal zones, one loss removes a third of the fleet. Second, the post-failure target utilization: if the SLO needs 70%, the fleet must be larger than peak divided by two thirds divided by 0.7. Third, variability and failover time. The idle percentage at average load is not the relevant number; post-failure utilization at peak is. If the fleet is above that requirement, I would show the excess and consider reducing it. If it is at or below, the idle capacity is the insurance premium.",
    followUps: [
      "What if the traffic is bursty rather than flat?",
      "How do you price the SLO breach?",
      "What would make you reduce the headroom?",
    ],
    redFlags: [
      "Defends headroom without a number.",
      "Uses average utilization.",
      "Confuses N+1 with N+2.",
    ],
    rubric: [
      "Uses peak, not average.",
      "Computes post-failure utilization.",
      "Names the SLO target.",
      "Distinguishes required from excess capacity.",
    ],
  },
  {
    id: "exact-n1",
    question:
      "Is a fleet that can survive one AZ loss at exactly 100% utilization correctly sized?",
    difficulty: 3,
    hints: [
      "Queueing latency is nonlinear near 100%.",
      "Failover takes time and traffic varies.",
    ],
    answer:
      "No. Exact N+1 satisfies the arithmetic and not the SLO. At 100% utilization there is no service time for variability, retries, or the transient while the load balancer removes the failed zone. Queueing delay rises sharply as utilization approaches one, so p99 can breach long before the fleet is technically unable to serve. I would size for a post-failure target below 100%, typically set from the latency SLO, and test the real failure at peak. The target is a reliability decision, not a rounding choice.",
    followUps: [
      "What target would you pick, and why?",
      "How does the answer change for a batch workload?",
      "What does a load balancer do during the transition?",
    ],
    redFlags: [
      "Treats 100% as safe because capacity equals demand.",
      "Ignores queueing.",
      "Assumes instant failover.",
    ],
    rubric: [
      "Rejects exact N+1 as insufficient.",
      "Explains the nonlinear latency.",
      "Names variability and failover transients.",
      "Sets a post-failure target.",
    ],
  },
  {
    id: "failure-domain",
    question:
      "How does the size of the failure domain change the cost of N+1?",
    difficulty: 3,
    hints: [
      "Three equal zones lose one third; two lose one half.",
      "The surviving capacity must still meet peak at the target.",
    ],
    answer:
      "The larger the share of capacity in one failure domain, the more total capacity must exist for the survivors to carry peak. With three equal zones, each loss removes a third, so the fleet must be at least 1.5 times peak before the post-failure target is applied. With two zones, a loss removes half, so the fleet must be at least twice peak. A smaller failure domain, such as more zones or smaller cells, reduces the premium but adds complexity and may reduce per-zone efficiency. The cost comparison has to include both the capacity and the operational overhead.",
    followUps: [
      "What is a cell-based architecture?",
      "How would you model a rack or host failure?",
      "When is N+2 worth the cost?",
    ],
    redFlags: [
      "Assumes every failure domain is the same size.",
      "Ignores the post-failure target.",
      "Treats more zones as free.",
    ],
    rubric: [
      "Relates domain share to total capacity.",
      "Applies the target utilization.",
      "Mentions smaller failure domains.",
      "Includes operational cost.",
    ],
  },
  {
    id: "headroom-vs-cost",
    question:
      "How would you present the headroom tradeoff to a product owner who owns both the SLO and the budget?",
    difficulty: 3,
    hints: [
      "Show the SLO breach scenario, not only the bill.",
      "Give a range of options with different risk.",
    ],
    answer:
      "I would present three or four fleet sizes with the same peak and failure assumptions: post-failure utilization, expected SLO impact if one AZ fails, and monthly cost. I would make the target explicit and show what each option buys. Then I would show the cost of the breach in user impact and engineering response, without pretending it is a precise dollar figure. The decision is a risk appetite decision, not a purely technical one. I would also show the cheaper structural options, such as reducing the failure domain or the peak, so the choice is not framed as headroom versus no headroom.",
    followUps: [
      "What if the product owner chooses the cheapest option?",
      "How do you revisit the decision after a failure?",
      "Which assumption would you test first?",
    ],
    redFlags: [
      "Presents a single number as the answer.",
      "Uses only the monthly bill.",
      "Refuses to consider reducing headroom.",
    ],
    rubric: [
      "Shows options with cost and risk.",
      "Defines the post-failure target.",
      "Includes structural alternatives.",
      "Leaves the risk decision with the owner.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Peak demand and the largest failure domain are documented for each service.",
      "The post-failure SLO target is explicit and different from the normal-state target.",
      "Fleet size is derived from peak, domain share, and target utilization, not from average load.",
      "Capacity is evenly spread across zones, and a zone loss has been tested at peak.",
      "The monthly cost of headroom is reported next to the SLO it protects.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check utilization by zone and post-failure utilization, not only the fleet average.",
      "Check whether the failure removed more capacity than the largest modelled domain.",
      "Restore capacity before tuning timeouts or retries.",
      "Shed low-priority traffic deliberately if capacity cannot be restored in time.",
      "Record the actual surviving capacity and the error onset for the post-incident review.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Recompute the N+1 requirement with the observed peak and failure-domain size.",
      "Decide whether to add headroom, reduce the failure domain, or accept the risk explicitly.",
      "Update the game-day scenario to include the failure at peak.",
      "Revisit the cost of headroom with finance using the actual incident impact.",
    ],
  },
];

const references = [
  {
    title: "Reliability Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Failure-domain planning, static stability, and capacity requirements for reliable workloads.",
  },
  {
    title: "Static stability using Availability Zones",
    url: "https://aws.amazon.com/builders-library/static-stability-using-availability-zones/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Designing for zone failure without depending on control-plane reaction, which is what headroom must cover.",
  },
  {
    title: "Cost Optimization Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Balancing cost with reliability requirements and measuring the cost of over-provisioning.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "headroom-cost": {
      model: headroomCostModel,
      presets,
      instructions:
        "Start healthy and compare current utilization with post-failure utilization. Apply Headroom cut, watch the fleet until 25 seconds, then compare Exact N+1 with Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative capacity and cost model. Two thousand rps per instance and the blended instance rate are teaching values, not AWS benchmarks or prices.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-capacity-headroom",
    "foundations-failure-domains",
    "capacity-unit-economics",
    "capacity-peak-events",
  ],
};
