import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SERVICE_MS = 25;
const PER_SERVER_RPS = 1_000 / SERVICE_MS;
const PRICE_PER_SERVER_HOUR = 0.09;
const HOURS_PER_MONTH = 730;
const FAILURE_AT = 30;
const ZONE_LOSS = 1 / 3;

const params = [
  {
    id: "peakRps",
    label: "Peak arrival rate",
    min: 1_000,
    max: 30_000,
    step: 500,
    value: 12_000,
    unit: " rps",
    group: "Demand",
    help: "Requests per second at the peak of the day. The model holds the fleet at this peak for the whole run.",
    format: "rps" as const,
  },
  {
    id: "targetUtilization",
    label: "Utilization target",
    min: 55,
    max: 95,
    step: 1,
    value: 85,
    unit: "%",
    group: "Target",
    help: "Utilization the autoscaler aims for before any failure. A target alone is not a headroom policy.",
    format: "percent" as const,
  },
  {
    id: "variabilityCv",
    label: "Arrival variability",
    min: 0.3,
    max: 2,
    step: 0.1,
    value: 1.2,
    unit: " CV",
    group: "Demand",
    help: "Coefficient of variation of inter-arrival time. Higher values mean burstier traffic and a sharper queueing knee at the same average load.",
    format: "number" as const,
  },
  {
    id: "reservedForFailure",
    label: "Reserved for zone failure",
    min: 0,
    max: 50,
    step: 5,
    value: 20,
    unit: "%",
    group: "Headroom",
    help: "Share of provisioned capacity set aside so one of three zones can fail without breaching the target. Illustrative.",
    format: "percent" as const,
  },
  {
    id: "zoneFailure",
    label: "Zone failure at 30s",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Headroom",
    help: "1 takes one of the three zones out of service at 30 simulated seconds. 0 models a steady state with all zones healthy.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  arrival: number;
  target: number;
  cv: number;
  reserved: number;
  zoneLost: boolean;
  zoneFactor: number;
  fleetCapacity: number;
  usableCapacity: number;
  servers: number;
  utilization: number;
  served: number;
  shed: number;
  errors: number;
  waitMs: number;
  p99: number;
  queueDepth: number;
  monthlyCostK: number;
}

function compute(p: Params, t: number): Computed {
  const arrival = Math.max(100, num(p, "peakRps", 12_000));
  const target = clamp(num(p, "targetUtilization", 85) / 100, 0.3, 0.98);
  const cv = clamp(num(p, "variabilityCv", 1.2), 0.1, 3);
  const reserved = clamp(num(p, "reservedForFailure", 20) / 100, 0, 0.6);
  const zoneLost = t >= FAILURE_AT && num(p, "zoneFailure", 0) >= 0.5;
  const zoneFactor = zoneLost ? 1 - ZONE_LOSS : 1;
  const fleetCapacity = arrival / Math.max(0.1, target * (1 - reserved));
  const usableCapacity = Math.max(1, fleetCapacity * zoneFactor);
  const utilization = arrival / usableCapacity;
  const served = Math.min(arrival, usableCapacity);
  const shed = Math.max(0, arrival - usableCapacity);
  const errors = shed > 0 ? (shed / arrival) * 100 : 0.02;
  const bounded = Math.min(utilization, 1);
  const waitMs =
    utilization <= 1
      ? ((cv * cv + 1) / 2) * (bounded / Math.max(0.02, 1 - bounded)) * SERVICE_MS
      : ((cv * cv + 1) / 2) * 49 * SERVICE_MS + (utilization - 1) * 5_000;
  const p99 = utilization <= 1 ? SERVICE_MS + waitMs * 2.2 : Math.min(20_000, 3_000 + (utilization - 1) * 6_000);
  const servers = Math.ceil(fleetCapacity / PER_SERVER_RPS);
  return {
    arrival,
    target,
    cv,
    reserved,
    zoneLost,
    zoneFactor,
    fleetCapacity,
    usableCapacity,
    servers,
    utilization,
    served,
    shed,
    errors,
    waitMs,
    p99,
    queueDepth: Math.min(150_000, arrival * (p99 / 1_000)),
    monthlyCostK: (servers * PRICE_PER_SERVER_HOUR * HOURS_PER_MONTH) / 1_000,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.p99 >= 800 || values.errors >= 5 || values.utilization >= 1) return "crit";
  if (values.p99 >= 300 || values.utilization >= 0.75) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 8)) / 2.4);
  const entries: [string, number, number][] = [
    ["p99", values.p99, 6],
    ["utilization", values.utilization * 100, 0.8],
    ["error-rate", values.errors, 0.06],
    ["queueDepth", values.queueDepth, 40],
    ["fleet-cost", values.monthlyCostK, 0.1],
    ["shed-rps", values.shed, 30],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.2 + value) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number, state: { zoneEvent: boolean }): SimFrame {
  const v = compute(p, t);
  const health = healthFor(v);
  const workerLoad = clamp(v.utilization);
  return {
    t: 0,
    nodes: [
      {
        id: "producer",
        label: "Client traffic",
        kind: "service",
        health: "ok",
        throughput: v.arrival,
        sublabel: `${Math.round(v.arrival).toLocaleString("en-US")} rps`,
        meta: { view: "queue" },
      },
      {
        id: "queue",
        label: "Request queue",
        kind: "queue",
        health,
        utilization: clamp(v.utilization),
        throughput: v.served,
        capacity: v.usableCapacity,
        sublabel: `${Math.round(v.queueDepth).toLocaleString("en-US")} waiting`,
        detail: `Mean wait is ${v.waitMs.toFixed(0)}ms and p99 is ${v.p99.toFixed(0)}ms. The queue absorbs bursts until the target leaves no slack.`,
        meta: { view: "queue", depth: Math.round(v.queueDepth) },
      },
      ...["Zone A", "Zone B", "Zone C"].map((label, index) => {
        const lost = v.zoneLost && index === 2;
        return {
          id: `worker-${index + 1}`,
          label: lost ? `${label} (lost)` : label,
          kind: "worker" as const,
          health: lost ? ("down" as const) : health === "crit" ? ("crit" as const) : health === "warn" ? ("warn" as const) : ("ok" as const),
          utilization: lost ? 0 : workerLoad,
          throughput: lost ? 0 : v.served / 3,
          capacity: v.usableCapacity / 3,
          sublabel: lost ? "zone unavailable" : `${Math.round(workerLoad * 100)}% busy`,
          meta: { view: "queue" },
        };
      }),
    ],
    edges: [
      edge("producer-queue", "producer", "queue", clamp(v.arrival / Math.max(1, v.fleetCapacity)), health),
      edge("queue-worker-1", "queue", "worker-1", clamp(v.utilization), health),
      edge("queue-worker-2", "queue", "worker-2", clamp(v.utilization), health),
      edge("queue-worker-3", "queue", "worker-3", v.zoneLost ? 0 : clamp(v.utilization), v.zoneLost ? "down" : health),
    ],
    metrics: [
      metric("p99", "p99 latency", v.p99, " ms", 300, 800, "ms"),
      metric("utilization", "Usable-capacity utilization", v.utilization * 100, "%", 75, 90, "percent"),
      metric("error-rate", "Error rate", v.errors, "%", 1, 5, "percent"),
      metric("queueDepth", "Requests waiting", v.queueDepth, " req", undefined, undefined, "count"),
      metric("shed-rps", "Load shed", v.shed, " rps", undefined, undefined, "rps"),
      metric("fleet-cost", "Fleet cost", v.monthlyCostK, " k$/month", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      zoneEvent: state.zoneEvent ? 1 : 0,
      zoneLost: v.zoneLost ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(v.arrival).toLocaleString("en-US")} rps at ${(v.utilization * 100).toFixed(0)}% of usable capacity. p99 ${v.p99.toFixed(0)}ms, ${Math.round(v.queueDepth).toLocaleString("en-US")} waiting, ${Math.round(v.servers)} servers. Cost figures illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0, { zoneEvent: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "The latency budget is gone at the queue",
    cause:
      "The fleet is serving close enough to its limit that arrivals wait behind each other. The target left too little slack for the traffic's variability or for the capacity a zone failure removes.",
    fix:
      "Lower the target or reserve headroom for the failure domain. The correct target is the one that keeps p99 under its SLO after the largest expected failure, not the one that maximizes average utilization.",
    checkFirst: [
      "Compare p99 with utilization and queue depth, not with average CPU alone.",
      "Check whether a zone, node, or dependency is unavailable.",
      "Check the arrival variability over the same window, not the monthly average.",
    ],
  },
  {
    id: "utilization",
    metricId: "utilization",
    warn: 75,
    crit: 92,
    title: "Usable capacity is nearly exhausted",
    cause:
      "The autoscaler has sized the fleet to the target, but the usable capacity is lower than the target assumes, or demand has moved above the planned peak. The queue has little room to absorb a burst.",
    fix:
      "Raise the provisioned capacity or lower the target. If a failure domain is missing, restore it before adding load. Utilization above 90% is a warning about the next burst, not a target to maintain.",
    checkFirst: [
      "Check capacity per zone and whether one zone is out of service.",
      "Check whether the autoscaler is using the same target as the capacity plan.",
      "Check whether traffic is above the peak the fleet was sized for.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The queue is no longer absorbing the load",
    cause:
      "Arrivals exceed the capacity the remaining zones can serve. Once the queue saturates, retries and timeouts add more work to a system that is already past its limit.",
    fix:
      "Restore capacity or shed low-priority traffic deliberately. Do not add retries in front of a saturated queue; they amplify the arrival rate that caused the saturation.",
    checkFirst: [
      "Check whether errors are rejections, timeouts, or dependency failures.",
      "Check whether retries are arriving as new work.",
      "Check the healthy target count in each zone.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const queueingHeadroomModel: SimModel = {
  id: "capacity-queueing-headroom",
  visual: "queue",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const values = compute(p, t);
    const zoneEvent = frame.flags.zoneEvent === 1 || values.zoneLost;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t, { zoneEvent });
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (values.zoneLost && frame.flags.zoneEvent !== 1) {
      pushEvent(next, {
        id: "zone-failure",
        at: t,
        severity: values.utilization >= 1 ? "crit" : values.utilization >= 0.9 ? "warn" : "info",
        title: "One of three zones is unavailable",
        detail: `Usable capacity fell by one third. The fleet is now at ${(values.utilization * 100).toFixed(0)}% utilization against a ${(values.target * 100).toFixed(0)}% target with ${(values.reserved * 100).toFixed(0)}% reserved.`,
        nodeId: "worker-3",
        metricId: "utilization",
      });
    }
    if (values.errors >= 1 && frame.flags.shedEvent !== 1) {
      pushEvent(next, {
        id: "shed-begins",
        at: t,
        severity: "warn",
        title: "The queue cannot serve every arrival",
        detail: `The fleet is shedding ${Math.round(values.shed).toLocaleString("en-US")} rps. Retries would add to the ${Math.round(values.arrival).toLocaleString("en-US")} rps already arriving.`,
        nodeId: "queue",
        metricId: "shed-rps",
      });
    }

    next.flags.zoneEvent = zoneEvent ? 1 : 0;
    next.flags.shedEvent = values.errors >= 1 ? 1 : frame.flags.shedEvent === 1 ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `Usable capacity is ${value("utilization").toFixed(0)}% utilized with ${Math.round(value("queueDepth")).toLocaleString("en-US")} requests waiting.`,
    ];
    if (value("p99") >= 300) {
      items.push(
        `p99 is ${value("p99").toFixed(0)}ms. Queueing delay, not service time, is the gap: ${value("shed-rps").toFixed(0)} rps are being shed.`,
      );
    }
    items.push(
      "The safe target is the one that holds the latency SLO after the largest failure domain is lost. A higher target buys servers and spends the queue's slack.",
    );
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
    description: "A 65% target, 35% reserved for a zone failure, and calm arrivals.",
    tone: "ok",
    params: defaults({ peakRps: 12_000, targetUtilization: 65, variabilityCv: 0.8, reservedForFailure: 35, zoneFailure: 0 }),
  },
  {
    id: "peak",
    label: "Busy but stable",
    description: "An 88% target with 10% reserved; p99 and utilization sit above the warning line with all zones healthy.",
    tone: "warn",
    params: defaults({ peakRps: 12_000, targetUtilization: 88, variabilityCv: 1.5, reservedForFailure: 10, zoneFailure: 0 }),
  },
  {
    id: "failure",
    label: "No headroom",
    description: "A 90% target with nothing reserved; losing one zone pushes utilization past 100%.",
    tone: "crit",
    params: defaults({ peakRps: 12_000, targetUtilization: 90, variabilityCv: 1.3, reservedForFailure: 0, zoneFailure: 1 }),
  },
  {
    id: "variability",
    label: "Bursty at 80%",
    description: "The same 80% target serves calm traffic and turns bursty traffic into a warning at the same average rate.",
    tone: "warn",
    params: defaults({ peakRps: 12_000, targetUtilization: 80, variabilityCv: 1.9, reservedForFailure: 10, zoneFailure: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 60% target with 40% reserved keeps p99 low with all zones healthy, at a higher server count. Enable the zone failure to test it.",
    tone: "ok",
    params: defaults({ peakRps: 12_000, targetUtilization: 60, variabilityCv: 0.8, reservedForFailure: 40, zoneFailure: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-target-after-failure",
  title: "Predict the target that survives a zone loss",
  simId: "queueing-headroom",
  question:
    "The fleet is sized to 85% utilization with three equal zones and no reserved headroom. A zone fails. What change protects the latency SLO?",
  prediction: {
    options: [
      { id: "raise", label: "Raise the target to 95% so autoscaling adds capacity sooner" },
      { id: "retry", label: "Add retries so requests wait for a healthy zone" },
      { id: "reserve", label: "Lower the target and reserve capacity for one zone failure" },
      { id: "queue", label: "Add a second queue in front of the fleet" },
    ],
    correctOptionId: "reserve",
    explanation:
      "A zone loss removes a third of capacity. If the fleet was sized to 85% of the full three-zone capacity, it is at 128% of the remaining capacity. Raising the target makes that worse. Retries add demand, and a second queue only adds another place to wait. Sizing the fleet so that two zones at the chosen target still cover peak demand is the headroom policy.",
  },
  setup: defaults({ peakRps: 12_000, targetUtilization: 85, variabilityCv: 1.3, reservedForFailure: 0, zoneFailure: 1 }),
  runFor: 45,
  observe: [
    "Before 30 seconds the fleet is at 85% utilization and p99 is already above 300ms.",
    "At 30 seconds one zone is lost and usable capacity drops by a third.",
    "Utilization jumps past 100%, the queue sheds traffic, and p99 crosses the critical threshold.",
    "The fleet cost is lower in the failing configuration; headroom is what the extra spend buys.",
  ],
  explain:
    "The utilization target only describes the average steady state. The queueing curve converts the remaining slack into latency, and a failure domain converts the target into an overload. The correct calculation starts from peak demand, multiplies by the failure factor, and then divides by the latency-safe utilization. The output is a server count, not a percentage copied from a dashboard.",
  fix: defaults({ peakRps: 12_000, targetUtilization: 65, variabilityCv: 1.3, reservedForFailure: 35, zoneFailure: 1 }),
  debrief:
    "With 35% reserved, the fleet can lose a third of its capacity and still sit near the 65% target. p99 stays below the warning line and no load is shed. The cost is roughly twice as many servers as the 90% configuration. That is the trade: headroom is paid every hour, while the SLO breach is paid during the failure.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Queueing headroom is the gap between the load a fleet normally carries and the load at which its latency budget runs out. A utilization target is a proxy for that gap, but it is not the gap itself. At low utilization the queue is almost always empty; as utilization approaches 100%, arrivals increasingly wait behind work already in service. The tail latency at the 99th percentile (p99) is where that wait becomes visible. The curve is nonlinear, so the last few points of utilization consume most of the latency budget.",
  },
  {
    type: "p",
    text: "Variability moves the curve. Two services at the same average CPU can have very different tails if one receives smooth traffic and the other receives bursts. A failure domain moves the curve too: a three-zone fleet sized for 85% of total capacity is at 128% of capacity after one zone is lost. A safe target is therefore a statement about the worst case you intend to survive, not a universal percentage. The service-level objective (SLO) sets the latency budget; the target is one input into meeting it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, request queue, and a fleet split across zones. The autoscaler sizes the fleet from the target. The queue absorbs short bursts and converts sustained overload into latency, then into errors. The load balancer removes a failed zone from rotation, but it cannot create capacity; the remaining zones must already have enough headroom to carry the load.",
  },
  {
    type: "table",
    headers: ["Situation", "Utilization against usable capacity", "What the queue does"],
    rows: [
      ["Calm traffic at 60%", "40% slack", "Short waits, stable p99"],
      ["Calm traffic at 85%", "15% slack", "Waits rise; a small burst matters"],
      ["Bursty traffic at 85%", "15% slack, uneven arrivals", "Long runs of waiting; p99 unstable"],
      ["One zone lost at 85% planned", "About 128% of remaining capacity", "Shedding; latency no longer bounded"],
      ["One zone lost, 65% target with 35% reserved", "About 63% of remaining capacity", "Waits remain inside the budget"],
    ],
  },
  {
    type: "p",
    text: "This model uses 25ms of service time per request, 40 requests per second per server, three equal zones, and a queueing approximation driven by utilization and arrival variability. Server prices and monthly costs are illustrative teaching values, not an AWS quote.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "p99 latency, utilization against usable capacity, and queue depth on one screen.",
      "Load shed in requests per second when arrivals exceed what the remaining zones can serve.",
      "A queue view with three zone workers; one goes unavailable at 30 simulated seconds.",
      "A fleet cost that rises with reserved headroom, so the tradeoff is visible rather than rhetorical.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply 85% and no headroom. Watch the zone loss at 30 seconds. Compare Bursty at 80% with Healthy to see variability at work, then run Recovery. The guided experiment asks you to choose the target before you move any slider.",
  },
  { type: "sim", simId: "queueing-headroom" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet was sized to a 90% target with no reserved headroom. Before the failure, the queue was already spending most of its slack: p99 sat above the warning line while average utilization looked like a number the team had chosen on purpose. At 30 seconds one zone disappeared. Usable capacity fell by a third, utilization went past 100%, the queue shed traffic, and p99 crossed the critical threshold.",
  },
  {
    type: "p",
    text: "The recovery preset did not make the failure cheaper. It made the fleet larger so that the same failure would leave enough capacity. With 35% reserved, losing a third still leaves the fleet near its target, and p99 stays inside the budget. The preset keeps all zones healthy so the capacity plan is visible; enable the zone failure toggle to watch the reserve absorb the loss.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Auto Scaling: GroupInServiceInstances, GroupPendingInstances, and per-zone capacity. The target is only real if the zones are balanced.",
      "Load balancer: TargetResponseTime, RequestCountPerTarget, HTTPCode_Target_5XX_Count, and UnHealthyHostCount. Per-target latency shows the queue; fleet averages hide it.",
      "Queueing signals: concurrency, wait time, and run-queue length. A CPU average near the target with rising wait time is the knee.",
      "SLO burn: p99 against the latency SLO and the error budget. The target should be chosen from the budget, not from a dashboard convention.",
      "Cost: server count and monthly run rate. Headroom has a line item, and the incident has one too.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check utilization against usable capacity, not against total capacity. Check whether a zone or node is missing. Check arrival variability over the same window. Then look at queue depth and p99 together: if both are rising at a stable request rate, the target has eaten the slack.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the missing capacity: a zone, a node group, or a dependency that the target assumed was healthy.",
      "Lower the target or reserve a share for the largest failure domain. Do the arithmetic with peak demand, not the monthly average.",
      "Recompute the server count from the latency-safe target and the failure factor. Treat the result as a floor, not a suggestion.",
      "Keep the autoscaler's target aligned with the plan. A policy that scales to 90% will undo a 65% capacity plan.",
      "Add a per-zone capacity signal and an SLO burn alert. Do not wait for the fleet-wide CPU average to move.",
      "Load-test with one zone removed and bursty arrivals. A test at the average arrival rate and full capacity proves nothing about the failure.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Every point of reserved headroom is servers running below their capacity; the bill is continuous and visible.",
      "A lower target protects the tail but reduces the work each server does, which can dominate cost at scale.",
      "Smoothing traffic is cheaper than headroom when the bursts are avoidable, but it changes product behavior and may not be possible.",
      "N+1 (one spare failure domain) protects against one failure; N+2 costs more and protects against a correlated pair. Choose the failure you intend to survive.",
      "A target copied from another service ignores that service's variability, service time, and failure domains.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-target",
    question:
      "Your fleet runs at 85% CPU and p99 is unstable. How do you choose a utilization target?",
    difficulty: 3,
    hints: [
      "Start from the latency SLO and the failure you must survive.",
      "Treat the target as an output of peak demand, variability, and failure headroom.",
    ],
    answer:
      "I would not choose a percentage from the current dashboard. I would start from peak demand, divide by the capacity that remains after the largest failure domain is lost, and find the utilization that keeps p99 inside its SLO given the observed arrival variability. That gives a server count and a target. If the target is 85% with three zones and no reserve, a zone loss puts the fleet above 100%, so the target is unsafe regardless of how stable the average looks. I would also check whether the autoscaler uses the same target, because a policy that scales to 90% will erase the plan.",
    followUps: [
      "What if traffic is smooth and predictable?",
      "How does N+2 change the calculation?",
      "How would you validate the target after a month?",
    ],
    redFlags: [
      "Picks a target because it is common.",
      "Ignores failure domains.",
      "Uses average CPU instead of the SLO.",
    ],
    rubric: [
      "Starts from the SLO.",
      "Accounts for variability.",
      "Accounts for a failure domain.",
      "Aligns the autoscaler with the plan.",
    ],
  },
  {
    id: "variability",
    question:
      "Two services both run at 70% CPU. One has stable p99 and the other has a fat tail. What explains the difference?",
    difficulty: 3,
    hints: [
      "The queueing curve depends on arrival and service variability, not only average load.",
      "Look at burst size and service-time distribution.",
    ],
    answer:
      "The average utilization is the same, but the queueing delay depends on variability. A service with bursty arrivals or a long-tailed service-time distribution spends more time with a non-empty queue, so its p99 rises at a lower average utilization. The stable service has arrivals that smooth out and a tight service-time distribution. I would compare coefficient of variation, queue depth, and concurrency at the same request rate, then either reduce variability or lower the target for the bursty service.",
    followUps: [
      "How would you measure variability?",
      "Can you fix it with more servers?",
      "What if the bursts are caused by retries?",
    ],
    redFlags: [
      "Assumes utilization alone determines latency.",
      "Blames the code without looking at arrivals.",
      "Suggests a longer timeout.",
    ],
    rubric: [
      "Names variability.",
      "Uses queue depth or concurrency.",
      "Separates arrival from service variability.",
      "Chooses a target or smoothing fix.",
    ],
  },
  {
    id: "headroom-cost",
    question:
      "Finance asks why the fleet runs at 60% instead of 85%. How do you justify the cost?",
    difficulty: 3,
    hints: [
      "Compare the cost of headroom with the cost of the SLO breach and the failure it covers.",
      "Use a concrete failure domain and peak, not a generic safety margin.",
    ],
    answer:
      "I would show the arithmetic for the failure the headroom covers: peak demand, the capacity lost when one zone fails, and the utilization that remains. At 85% with three zones, a zone loss leaves the fleet above 100% and the SLO is breached. The extra servers keep the remaining zones inside the latency budget. Then I would compare the monthly cost of those servers with the error-budget burn, incident cost, and recovery time of the breach. If the business accepts the risk, the target can be raised deliberately; it should not drift there because a dashboard called 85% normal.",
    followUps: [
      "What if the workload is internal and the SLO is loose?",
      "How would you reduce the cost without losing the guarantee?",
      "Which failure domain would you cover first?",
    ],
    redFlags: [
      "Calls the headroom waste without a failure calculation.",
      "Uses an SLO breach as acceptable without an owner.",
      "Ignores the cost of the incident.",
    ],
    rubric: [
      "Quantifies the failure.",
      "Compares both costs.",
      "Names the SLO owner.",
      "Offers a way to reduce cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The utilization target is derived from peak demand, arrival variability, and the largest failure domain.",
      "The autoscaler target and the capacity plan use the same number.",
      "Dashboards show utilization against usable capacity, per zone, with queue depth and p99.",
      "A load test removes one zone at peak and measures p99 and errors.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether a zone, node, or dependency is missing before raising the target.",
      "Compare p99, queue depth, and utilization on the same timeline.",
      "Shed low-priority traffic deliberately if the queue is already saturated.",
      "Do not add retries until the arrival rate is back inside capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Recompute the safe target from the observed peak and the failure that occurred.",
      "Size the fleet for the next failure domain, not only the one that just failed.",
      "Review whether variability changed because of a release or a traffic shift.",
      "Record the cost of the headroom and the cost of the breach.",
    ],
  },
];

const references = [
  {
    title: "Google SRE Workbook: Managing Load",
    url: "https://sre.google/workbook/managing-load/",
    publisher: "Google",
    kind: "book" as const,
    note: "Capacity planning, utilization targets, and the cost of running close to saturation.",
  },
  {
    title: "Amazon EC2 Auto Scaling: target tracking scaling policies",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How a target value drives desired capacity; the target itself does not reserve failure headroom.",
  },
  {
    title: "AWS Well-Architected Reliability Pillar: capacity planning",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_capacity_provisioning.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Provision capacity for peak and failure, and validate it with testing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "queueing-headroom": {
      model: queueingHeadroomModel,
      presets,
      instructions:
        "Start healthy, then apply 85% and no headroom. Watch the zone loss at 30 seconds, compare Bursty at 80%, and finish with Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow", "timeline"],
      note: "Illustrative model. Service time, per-server throughput, prices, and the queueing approximation are teaching values, not AWS quotas or benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-queueing-knee",
    "foundations-capacity-headroom",
    "capacity-autoscaling-policies",
    "capacity-warm-pools",
    "capacity-rightsizing",
  ],
};
