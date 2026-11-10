import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAP_PER_INSTANCE = 2_000;
const TARGET_UTIL = 0.6;
const BASELINE_RPS = 12_000;
const SURGE_START = 8;
const SURGE_FULL = 26;
const SCHEDULE_AT = 30;
const MAX_INSTANCES = 80;
const SCALE_IN_SECONDS = 120;

const params = [
  {
    id: "peakRps",
    label: "Peak organic demand",
    min: 8_000,
    max: 120_000,
    step: 2_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "Demand reached by the surge. The baseline is 12,000 rps.",
    format: "rps" as const,
  },
  {
    id: "scheduledCapacity",
    label: "18:00 scheduled capacity",
    min: 2,
    max: 60,
    step: 1,
    value: 12,
    unit: " instances",
    group: "Schedule",
    help: "Desired instance count the 18:00 scheduled action writes.",
    format: "count" as const,
  },
  {
    id: "scheduleEnabled",
    label: "18:00 action enabled",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Schedule",
    help: "1 runs the scheduled action; 0 models a change freeze that suppresses it.",
    format: "count" as const,
  },
  {
    id: "minCapacity",
    label: "Minimum capacity",
    min: 2,
    max: 60,
    step: 1,
    value: 4,
    unit: " instances",
    group: "Schedule",
    help: "Floor the group will not go below. A scheduled action below this floor is raised to it.",
    format: "count" as const,
  },
  {
    id: "scaleOutDelay",
    label: "Instance warm-up",
    min: 5,
    max: 120,
    step: 5,
    value: 30,
    unit: "s",
    group: "Dynamic scaling",
    help: "Time for new capacity to launch, register, and serve traffic. The model spreads replacement capacity over this period.",
    format: "number" as const,
  },
  {
    id: "cooldown",
    label: "Post-action cooldown",
    min: 0,
    max: 180,
    step: 10,
    value: 30,
    unit: "s",
    group: "Dynamic scaling",
    help: "Time after the scheduled action when the dynamic policy will not change capacity. Some policies use a cooldown; target tracking instead uses instance warm-up.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function numFlag(value: number | string | boolean | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function demandAt(t: number, peakRps: number): number {
  if (t <= SURGE_START) return BASELINE_RPS;
  const progress = clamp((t - SURGE_START) / (SURGE_FULL - SURGE_START));
  const eased = progress * progress * (3 - 2 * progress);
  return BASELINE_RPS + (Math.max(1_000, peakRps) - BASELINE_RPS) * eased;
}

function desiredFor(demand: number): number {
  return Math.max(1, Math.min(MAX_INSTANCES, Math.ceil(demand / (CAP_PER_INSTANCE * TARGET_UTIL))));
}

function initialFor(p: Params): number {
  const min = Math.max(1, Math.round(num(p, "minCapacity", 4)));
  const scheduled = Math.max(1, Math.round(num(p, "scheduledCapacity", 12)));
  return Math.max(min, Math.min(MAX_INSTANCES, scheduled), desiredFor(BASELINE_RPS));
}

interface Computed {
  demand: number;
  instances: number;
  capacity: number;
  served: number;
  utilization: number;
  shed: number;
  errors: number;
  p99: number;
  desired: number;
  cooldownRemaining: number;
}

function compute(p: Params, t: number, instances: number, cooldownUntil: number): Computed {
  const demand = demandAt(t, num(p, "peakRps", 20_000));
  const safeInstances = Math.max(0.1, instances);
  const capacity = safeInstances * CAP_PER_INSTANCE;
  const utilization = demand / Math.max(1, capacity);
  const served = Math.min(demand, capacity);
  const shed = Math.max(0, demand - capacity);
  const errors = shed > 0 ? (shed / demand) * 100 : 0.02;
  const p99 =
    utilization <= 1
      ? 60 + (240 * Math.pow(utilization, 8)) / Math.max(0.05, 1.1 - utilization)
      : Math.min(15_000, 2_500 + (utilization - 1) * 4_000);
  return {
    demand,
    instances: safeInstances,
    capacity,
    served,
    utilization,
    shed,
    errors,
    p99,
    desired: desiredFor(demand),
    cooldownRemaining: Math.max(0, cooldownUntil - t),
  };
}

function serviceHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.errors >= 5 || values.utilization >= 0.9) return "crit";
  if (values.errors >= 1 || values.utilization >= 0.7) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.96 + 0.06 * Math.sin((offset + (seed % 9)) / 2.7);
  const metricSeed: [string, number, number][] = [
    ["fleet-utilization", values.utilization * 100, 2],
    ["error-rate", values.errors, 0.05],
    ["p99-latency", values.p99, 0.4],
    ["shed-rps", values.shed, 20],
    ["capacity-instances", values.instances, 0.1],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  t: number,
  state: { instances: number; cooldownUntil: number; scheduleApplied: boolean; surgeEvent: boolean },
): SimFrame {
  const values = compute(p, t, state.instances, state.cooldownUntil);
  const health = serviceHealth(values);
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
        health: health === "crit" ? "crit" : health === "warn" ? "warn" : "ok",
        utilization: clamp(values.utilization),
        throughput: values.served,
        sublabel: `${Math.round(values.errors).toFixed(0)}% errors`,
        meta: { view: "flow" },
      },
      {
        id: "fleet",
        label: "Web fleet",
        kind: "service",
        role: "instance",
        health,
        utilization: Math.min(1, values.utilization),
        throughput: values.served,
        capacity: values.capacity,
        sublabel: `${Math.round(values.instances)} instances · ${Math.round(values.capacity).toLocaleString("en-US")} rps capacity`,
        detail: `${Math.round(values.instances)} instances serving ${Math.round(values.served).toLocaleString("en-US")} of ${Math.round(values.demand).toLocaleString("en-US")} rps. Shed ${Math.round(values.shed).toLocaleString("en-US")} rps; p99 ${values.p99.toFixed(0)}ms.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Orders database",
        kind: "db",
        health: values.served / 120_000 > 0.9 ? "warn" : "ok",
        utilization: clamp(values.served / 120_000),
        throughput: values.served,
        sublabel: `${Math.round(values.served).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.demand / 120_000), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.demand / 120_000), health),
      edge("fleet-db", "fleet", "db", clamp(values.served / values.demand), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("fleet-utilization", "Fleet utilization", values.utilization * 100, "%", 70, 90, "percent"),
      metric("error-rate", "Error rate", values.errors, "%", 1, 5, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 500, 2_000, "ms"),
      metric("shed-rps", "Shed load", values.shed, " rps", 100, 1_000, "rps"),
      metric("capacity-instances", "In-service capacity", values.instances, " instances", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      instances: values.instances,
      cooldownUntil: state.cooldownUntil,
      scheduleApplied: state.scheduleApplied ? 1 : 0,
      surgeEvent: state.surgeEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.instances)} instances carry ${Math.round(values.capacity).toLocaleString("en-US")} rps of capacity against ${Math.round(values.demand).toLocaleString("en-US")} rps demand; ${values.errors.toFixed(1)}% errors.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const instances = initialFor(p);
  const frame = buildFrame(p, seed, 0, {
    instances,
    cooldownUntil: 0,
    scheduleApplied: false,
    surgeEvent: false,
  });
  seedSeries(frame, compute(p, 0, instances, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The service is shedding load",
    cause:
      "Demand is above the capacity the fleet can serve. A scheduled action, warm-up lag, or an organic surge may explain the gap. Compare desired, in-service, pending, and demand before attributing it to one cause.",
    fix:
      "Raise the scheduled action's minimum capacity above the surge requirement, or freeze the action during the risk window. Do not treat a longer cooldown as a fix; it delays the replacement capacity.",
    checkFirst: [
      "Put scheduled actions and scaling activities on one timeline.",
      "Compare desired, in-service, and pending capacity with demand at 18:00.",
      "Check the group minimum and the minimum the scheduled action wrote.",
    ],
  },
  {
    id: "fleet-utilization",
    metricId: "fleet-utilization",
    warn: 70,
    crit: 90,
    title: "Fleet utilization is above the safe target",
    cause:
      "Capacity is below demand or still warming. A scheduled scale-down, warm-up lag, or both may explain the gap. Compare desired, in-service, pending capacity, and the 18:00 event before attributing it to the schedule.",
    fix:
      "Restore capacity and keep it above the demand floor. A target-tracking policy will add capacity eventually, but only after the metric moves and the new instances warm up.",
    checkFirst: [
      "Compare in-service instances with the count the schedule wrote.",
      "Check whether instances are pending or terminating.",
      "Check whether the load balancer is still sending traffic to draining instances.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 500,
    crit: 2_000,
    title: "Latency is climbing as the fleet saturates",
    cause:
      "Requests are queueing behind a fleet that no longer has enough capacity. Latency rises before errors when the fleet is merely saturated, then jumps when shedding starts.",
    fix:
      "Restore capacity or shed low-priority traffic deliberately. Verify that the load balancer removes terminating instances before the next scheduled action.",
    checkFirst: [
      "Check p99 by target group and by instance, not only the fleet average.",
      "Check for connection draining and deregistration delay during the scale-down.",
      "Check whether retries are multiplying the load.",
    ],
  },
  {
    id: "shed-rps",
    metricId: "shed-rps",
    warn: 100,
    crit: 1_000,
    title: "The fleet is rejecting demand it cannot serve",
    cause:
      "Demand exceeds served capacity. The gap is the load the service is shedding, which is the direct user impact of the race.",
    fix:
      "Close the capacity gap, then add admission control so a future race degrades deliberately instead of failing open.",
    checkFirst: [
      "Check whether the load balancer has healthy targets in every zone.",
      "Check whether the errors are rejections, timeouts, or dependency failures.",
      "Check whether the scheduled action is still the active capacity owner.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const scheduledScalingRaceModel: SimModel = {
  id: "capacity-scheduled-scaling-race",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const stepSeconds = Math.min(1, Math.max(0.01, dt));
    const t = frame.t;
    let instances = fresh ? initialFor(p) : numFlag(frame.flags.instances, initialFor(p));
    let cooldownUntil = fresh ? 0 : numFlag(frame.flags.cooldownUntil, 0);
    let scheduleApplied = fresh ? false : frame.flags.scheduleApplied === 1;
    let surgeEvent = fresh ? false : frame.flags.surgeEvent === 1;
    const wasScheduled = scheduleApplied;
    const demand = demandAt(t, num(p, "peakRps", 20_000));
    let scheduledInstances = instances;

    let scheduledEvent = false;
    let freezeSuppressed = false;
    if (!scheduleApplied && t >= SCHEDULE_AT) {
      const enabled = num(p, "scheduleEnabled", 1) >= 0.5;
      if (enabled) {
        const min = Math.max(1, Math.round(num(p, "minCapacity", 4)));
        const scheduled = Math.max(1, Math.round(num(p, "scheduledCapacity", 12)));
        scheduledInstances = Math.max(min, Math.min(MAX_INSTANCES, scheduled));
        instances = scheduledInstances;
        cooldownUntil = t + Math.max(0, num(p, "cooldown", 30));
        scheduledEvent = true;
      } else {
        freezeSuppressed = true;
      }
      scheduleApplied = true;
    }

    const desired = desiredFor(demand);
    const scaleOutDelay = Math.max(1, num(p, "scaleOutDelay", 30));
    if (t >= cooldownUntil) {
      const gap = desired - instances;
      if (gap > 0) instances += gap * Math.min(1, stepSeconds / scaleOutDelay);
      else if (gap < 0) instances += gap * Math.min(1, stepSeconds / SCALE_IN_SECONDS);
    }
    instances = clamp(instances, 0.1, MAX_INSTANCES);

    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t, {
      instances,
      cooldownUntil,
      scheduleApplied,
      surgeEvent,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (!surgeEvent && demand > BASELINE_RPS * 1.02) {
      pushEvent(next, {
        id: "organic-surge",
        at: t,
        severity: "info",
        title: "Organic demand is rising before the scheduled action",
        detail: `Demand has reached ${Math.round(demand).toLocaleString("en-US")} rps. The 18:00 action is still configured to remove capacity.`,
        nodeId: "fleet",
        metricId: "fleet-utilization",
      });
      surgeEvent = true;
    }

    if (freezeSuppressed) {
      pushEvent(next, {
        id: "freeze-suppressed",
        at: t,
        severity: "info",
        title: "Change freeze suppressed the 18:00 action",
        detail: "The schedule did not write desired capacity. Dynamic scaling owned the fleet through the surge.",
        nodeId: "fleet",
        metricId: "capacity-instances",
      });
    }

    if (!wasScheduled && scheduledEvent) {
      const afterCapacity = scheduledInstances * CAP_PER_INSTANCE;
      const severity = demand > afterCapacity ? "crit" : demand > afterCapacity * 0.9 ? "warn" : "info";
      pushEvent(next, {
        id: "scheduled-scale-down",
        at: t,
        severity,
        title: "18:00 scheduled action changed desired capacity",
        detail: `The action set ${scheduledInstances} instances, ${Math.round(afterCapacity).toLocaleString("en-US")} rps of capacity, against ${Math.round(demand).toLocaleString("en-US")} rps of demand.`,
        nodeId: "fleet",
        metricId: "capacity-instances",
      });
      if (cooldownUntil > t && demand > afterCapacity) {
        pushEvent(next, {
          id: "cooldown-blocks-scale-out",
          at: t,
          severity: "warn",
          title: "Dynamic scale-out is paused after the schedule",
          detail: `The cooldown runs for another ${Math.round(cooldownUntil - t)}s. New instances would still need warm-up after that.`,
          nodeId: "fleet",
          metricId: "error-rate",
        });
      }
    }

    next.flags.instances = instances;
    next.flags.cooldownUntil = cooldownUntil;
    next.flags.scheduleApplied = scheduleApplied ? 1 : 0;
    next.flags.surgeEvent = surgeEvent ? 1 : 0;
    next.flags.paramsKey = key;
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const instances = value("capacity-instances");
    const utilization = value("fleet-utilization");
    const errors = value("error-rate");
    const cooldown = Math.max(0, Number(frame.flags.cooldownUntil ?? 0) - frame.t);
    const items: string[] = [
      `The fleet has ${instances.toFixed(0)} instances against ${utilization.toFixed(0)}% utilization. The target is 60%.`,
    ];
    if (errors >= 1) {
      items.push(
        `The service is shedding ${value("shed-rps").toFixed(0)} rps. The scheduled action removed capacity while demand was rising; the dynamic policy is either cooling down or still warming instances.`,
      );
    }
    if (cooldown > 0) {
      items.push(`The post-action cooldown has ${cooldown.toFixed(0)}s left. No dynamic capacity change will occur until it ends.`);
    }
    items.push(
      "A minimum capacity floor or a frozen scheduled action removes the race. A longer cooldown only moves the recovery later.",
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
    description: "A small demand lift with a schedule that matches it.",
    tone: "ok",
    params: defaults({ peakRps: 14_000 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 36k rps surge meets a schedule that leaves 24 instances; the fleet is saturated but serving.",
    tone: "warn",
    params: defaults({ peakRps: 36_000, scheduledCapacity: 24, scaleOutDelay: 20, cooldown: 30 }),
  },
  {
    id: "failure",
    label: "The race",
    description: "A 48k rps surge at 18:00, a schedule that drops to 5 instances, and a 60s cooldown.",
    tone: "crit",
    params: defaults({ peakRps: 48_000, scheduledCapacity: 5, minCapacity: 3, scaleOutDelay: 5, cooldown: 60 }),
  },
  {
    id: "cooldown",
    label: "Longer cooldown",
    description: "Same race with a two-minute cooldown; recovery is delayed, not prevented.",
    tone: "crit",
    params: defaults({ peakRps: 48_000, scheduledCapacity: 5, minCapacity: 3, scaleOutDelay: 5, cooldown: 120 }),
  },
  {
    id: "freeze",
    label: "Freeze the schedule",
    description: "The 18:00 scale-down is suppressed; the fleet keeps its pre-surge 40-instance size.",
    tone: "ok",
    params: defaults({ peakRps: 48_000, scheduledCapacity: 40, scheduleEnabled: 0, minCapacity: 8, scaleOutDelay: 15, cooldown: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A minimum floor of 40 instances keeps capacity above the surge even if the schedule runs.",
    tone: "ok",
    params: defaults({ peakRps: 48_000, scheduledCapacity: 40, minCapacity: 40, scaleOutDelay: 10, cooldown: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-race-guardrail",
  title: "Predict which guardrail stops the race",
  simId: "scheduled-scaling-race",
  question:
    "Demand is about to reach 48k rps when the 18:00 action drops the fleet to 5 instances. Which change keeps the service serving without relying on a faster reaction?",
  prediction: {
    options: [
      { id: "min", label: "Raise the scheduled minimum capacity to cover the surge" },
      { id: "cooldown", label: "Increase the cooldown so the policy stops flapping" },
      { id: "retry", label: "Add retries in front of the load balancer" },
      { id: "smaller", label: "Move to smaller instances so there are more of them" },
    ],
    correctOptionId: "min",
    explanation:
      "A cooldown only delays the next dynamic change; here it blocks the scale-out that recovery needs. Retries add load to a fleet that is already shedding. A larger count of smaller instances can add parallelism, but the scheduled action still removes most of them at 18:00. A minimum floor keeps the scheduled action from cutting below the demand requirement, so capacity never collapses.",
  },
  setup: defaults({ peakRps: 48_000, scheduledCapacity: 5, minCapacity: 3, scaleOutDelay: 5, cooldown: 60 }),
  runFor: 45,
  observe: [
    "Dynamic scaling adds capacity before 18:00 while the surge ramps.",
    "At 18:00 the scheduled action cuts desired capacity to 5 instances.",
    "Utilization runs far past the critical threshold, the fleet sheds about 38k rps, and errors reach roughly 79%.",
    "The cooldown holds the fleet at 5 instances, so recovery cannot start until it ends.",
  ],
  explain:
    "Scheduled and dynamic scaling are two writers to the same desired-capacity field. The schedule is blind to the surge; the dynamic policy is blind to the schedule. A minimum floor or a frozen schedule prevents the overlap. Faster warm-up and pre-scaling reduce the gap, but they do not stop the scheduled action from removing capacity at the wrong moment.",
  fix: defaults({ peakRps: 48_000, scheduledCapacity: 40, minCapacity: 40, scaleOutDelay: 10, cooldown: 0 }),
  debrief:
    "The floor keeps 40 instances in service, which is 80k rps of capacity at 100% and 60% utilization at the 48k peak. The cost is 40 instances running through the evening even if the surge does not arrive. That is the trade: pay for a floor, or accept a recovery window while capacity is rebuilt.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Scheduled scaling changes capacity at a wall-clock time. Dynamic scaling changes capacity in response to a metric. Both write the same desired-capacity field, and they do not coordinate. A scheduled action that removes capacity at 18:00 can run while organic demand is rising. The dynamic policy may react seconds later, but new instances need time to launch, register, and warm before they serve traffic. During that gap the fleet is below demand and sheds load.",
  },
  {
    type: "p",
    text: "The race is not that the schedule is wrong about the average day. It is that the schedule is blind to the day that is not average. AWS scheduled actions set desired capacity and optionally minimum and maximum capacity at a specific time. They generally run within seconds but can be delayed by up to two minutes. After a scheduled action, scaling policies can continue to make decisions, but capacity must stay within the minimum and maximum the action set. If the action lowers desired capacity while demand is rising, the policy has to replace that capacity, and it cannot do so instantly. Cooldowns and change freezes are the guardrails around that transition: a cooldown can stop the two actors from rapidly undoing each other's decisions, and a freeze keeps the scheduled change from running at all. Neither substitutes for a minimum capacity that covers demand.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, Auto Scaling group, service, and database. The schedule and the dynamic policy both write the group's desired capacity. The load balancer keeps sending traffic; it does not know the group just shrank. The database sees the same request mix, so a capacity collapse is not a database problem until retries and queueing reach it.",
  },
  {
    type: "table",
    headers: ["Actor", "Trigger", "Writes", "Failure mode"],
    rows: [
      ["Scheduled action", "Wall-clock time, 18:00", "Desired, optionally min and max", "Removes capacity without reading current demand"],
      ["Target tracking", "Metric versus target", "Desired within min and max", "Reacts after the metric moves; new instances need warm-up"],
      ["Simple scaling and cooldown", "Alarm breach", "Desired", "Cooldown pauses the next action even when demand is rising"],
      ["Change freeze", "Calendar or policy", "No change", "Prevents the scheduled action from running during a risk window"],
    ],
  },
  {
    type: "p",
    text: "This module models a 12,000 rps baseline, 2,000 rps per instance at 100% utilization, a 60% target, and a surge that starts before the 18:00 action. Those are teaching values, not AWS quotas or instance benchmarks. The cooldown slider represents a simple-scaling pause; set it to zero for target tracking and use the warm-up slider for launch time. The lesson is the interaction: one actor removes capacity, another is slow or paused, and the load balancer keeps sending requests.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Fleet utilization against the 60% target, with warning at 70% and critical at 90%.",
      "Error rate and shed load: the requests the fleet cannot serve.",
      "p99 latency, which rises before errors when the fleet is saturated.",
      "In-service capacity, so you can compare what the schedule wrote with what is actually serving.",
      "A flow view from client to load balancer to fleet to database, plus a timeline of the surge, the schedule, and the cooldown.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply The race. Open Timeline to see the surge and the 18:00 action on one axis. Run the guided experiment before changing sliders: predict which guardrail prevents the collapse, then try Freeze the schedule and Recovery. Watch in-service capacity and error rate together.",
  },
  { type: "sim", simId: "scheduled-scaling-race" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The surge started before 18:00, and dynamic scaling added instances while demand rose. At 18:00 the scheduled action wrote a desired capacity of 5 instances. That removed about 30 instances, and the post-action cooldown blocked the dynamic policy from replacing them. Demand was 48k rps against 10k rps of remaining capacity, so utilization ran far past the critical threshold, the fleet shed roughly 38k rps, and errors reached about 79%.",
  },
  {
    type: "p",
    text: "After the cooldown ended, target tracking asked for 40 instances again. Replacement capacity arrived gradually and the error rate fell, but the outage lasted longer than the scale-out because the schedule had removed capacity that was already serving traffic. The fleet did not lack a scaling policy. It had two policies with different clocks and no floor between them.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "EC2 Auto Scaling: GroupDesiredCapacity, GroupInServiceInstances, GroupPendingInstances, and GroupTerminatingInstances. The gap between desired and in-service is the recovery window.",
      "Load balancer: RequestCount, TargetResponseTime, HTTPCode_Target_5XX_Count, and UnHealthyHostCount. Errors concentrate on the targets that remain after the scale-down.",
      "Activity history: a scheduled action and a scaling activity at the same minute, followed by a terminated-instance count that exceeds the launch count.",
      "CloudTrail: the scheduled action update, plus any manual override or process suspension. The audit trail tells you who last changed the floor.",
      "Logs and traces: instance launch timestamps, readiness probes, and the first 5xx. The gap between launch and readiness is the warm-up cost.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Put scheduled actions and scaling activities on one timeline. Compare desired, in-service, and pending capacity with demand at 18:00. Check the group minimum and the minimum the scheduled action wrote. Then check whether a cooldown or warm-up is delaying replacement capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the overlap: the scheduled action ran while demand was above the post-action capacity, and errors began after it.",
      "Raise the scheduled action's minimum capacity to the surge floor, not just its desired capacity. The minimum is the guardrail that survives a bad desired value.",
      "If demand is unpredictable, suspend scheduled actions during the risk window and let dynamic scaling own capacity. EC2 Auto Scaling can suspend the ScheduledActions process without deleting the actions.",
      "Give one actor ownership. Either the schedule sets a floor that dynamic scaling may exceed, or the schedule is removed for the window.",
      "Reduce time-to-capacity with pre-scaling, a warm pool, faster instance warm-up, or a larger baseline. Do not rely on a longer cooldown.",
      "Load-test with the surge starting before the scheduled action and continuing after it. A test that starts after 18:00 misses the race.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A high minimum capacity costs money through the whole low-traffic window, not only during the surge.",
      "A change freeze protects the window but removes the schedule's cost saving and needs an owner to lift it.",
      "A longer cooldown reduces flapping but delays recovery; it is a stability control, not an availability control.",
      "Pre-scaling is predictable when the pattern holds and wasteful when it does not. Warm pools reduce the gap but still cost idle capacity.",
      "Two scaling mechanisms can coexist only with an explicit owner, a floor, and a test that covers the overlap.",
      "Faster warm-up helps every scale-out, but it does not stop a scheduled action from removing the wrong capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-race",
    question:
      "Walk me through how a scheduled scale-down and a target-tracking policy can fight each other.",
    difficulty: 3,
    hints: [
      "Both mechanisms write desired capacity.",
      "The schedule does not read demand; the policy cannot act instantly.",
    ],
    answer:
      "The scheduled action runs at a fixed time and writes a new desired capacity, optionally with new minimum and maximum values. It does not check whether demand is rising. Target tracking watches a metric and writes its own desired capacity within the current bounds. If the schedule lowers capacity just as demand rises, the policy sees high utilization and asks for more capacity, but the new instances need time to launch and warm. A simple-scaling cooldown pauses further actions; target tracking can initiate a scale-out immediately but still waits for warm-up. The service runs below demand in that gap and sheds load. The race is the overlap between a blind calendar action and a signal-driven action with a delay.",
    followUps: [
      "Which mechanism should own capacity in that window?",
      "What does the group minimum do?",
      "How would you detect the overlap after the fact?",
    ],
    redFlags: [
      "Says the policy will always fix it immediately.",
      "Ignores the shared desired-capacity field.",
      "Treats the schedule as demand-aware.",
    ],
    rubric: [
      "Names both writers and the shared field.",
      "Explains the time gap and warm-up.",
      "Mentions minimum capacity or a freeze.",
      "Describes the user impact.",
    ],
  },
  {
    id: "first-check",
    question:
      "A scheduled action runs at 18:00 and 5xx errors start at 18:01. What do you check first?",
    difficulty: 3,
    hints: [
      "Start with capacity and demand on the same timeline.",
      "Do not start with the application logs.",
    ],
    answer:
      "I would compare desired, in-service, and pending capacity with request rate and error rate around 18:00. I would check the Auto Scaling activity history for the scheduled action and any scale-out activity, then check the group minimum and the minimum the action wrote. If in-service capacity dropped and demand rose, the race is confirmed. Then I would check whether a cooldown, warm-up, or load-balancer deregistration delay extended the gap. Application logs come after that, to confirm the errors are rejections or timeouts rather than a new code defect.",
    followUps: [
      "What if capacity did not drop?",
      "How do you separate this from a bad deploy at 18:00?",
      "Which dashboard would you build for the next occurrence?",
    ],
    redFlags: [
      "Starts by rolling back the deploy.",
      "Looks only at CPU.",
      "Ignores desired versus in-service capacity.",
    ],
    rubric: [
      "Checks capacity and demand together.",
      "Uses activity history and min/max.",
      "Considers cooldown and warm-up.",
      "Separates capacity from code.",
    ],
  },
  {
    id: "why-not-cooldown",
    question:
      "The team proposes increasing the cooldown to prevent this. Why is that not the fix?",
    difficulty: 3,
    hints: [
      "A cooldown is a pause, not a floor.",
      "The cooldown starts after the bad action.",
    ],
    answer:
      "A cooldown prevents rapid repeated scaling actions, but it does not stop the scheduled action from removing capacity in the first place. In this failure, a longer cooldown makes recovery later because it blocks the scale-out that is trying to replace the lost capacity. The fix has to change what the schedule is allowed to do: raise the minimum, freeze the action during the risk window, or remove the schedule and let dynamic scaling own capacity. Cooldowns are useful for flapping, not for protecting a demand floor.",
    followUps: [
      "When is a cooldown still useful?",
      "How does target tracking differ from simple scaling here?",
      "What would you measure to prove the cooldown is harmful?",
    ],
    redFlags: [
      "Treats a longer pause as more safety.",
      "Confuses cooldown with minimum capacity.",
      "Does not name a floor or freeze.",
    ],
    rubric: [
      "Distinguishes cooldown from floor.",
      "Explains the delayed recovery.",
      "Names the correct guardrails.",
    ],
  },
  {
    id: "design-guardrails",
    question:
      "How would you design scheduled scaling so an organic surge cannot collide with a scale-down?",
    difficulty: 4,
    hints: [
      "A schedule should set a floor, not only a desired count.",
      "One actor should own capacity during the risk window.",
    ],
    answer:
      "I would make the schedule conservative and observable. It sets a minimum capacity that covers the peak of the demand pattern, not only a desired count, so a dynamic policy can add capacity above the floor but cannot cut below it. I would freeze scheduled actions during known high-risk windows and require an owner to lift the freeze. I would also align the schedule with the actual time zone, pre-scale before the ramp, and test with a surge that starts before the action and continues after it. Alerts would fire when desired capacity falls below the current demand requirement, not only when errors appear.",
    followUps: [
      "How do you choose the floor?",
      "What is the cost of the floor?",
      "How do you test the freeze path?",
    ],
    redFlags: [
      "Sets only desired capacity.",
      "Has no owner for the freeze.",
      "Tests only after the schedule runs.",
    ],
    rubric: [
      "Sets a minimum floor from peak demand.",
      "Uses a freeze with an owner.",
      "Aligns time zone and ramp.",
      "Tests the overlap explicitly.",
      "States the cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Scheduled actions and dynamic policies are documented with one capacity owner per window.",
      "Each scheduled action has a minimum capacity derived from the demand pattern, not only a desired count.",
      "Dashboards show desired, in-service, pending, and terminating capacity with demand and errors on one timeline.",
      "A change freeze process exists for high-risk windows, with a named owner who can lift it.",
      "Load tests start before the scheduled action and continue after it.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the scheduled action or a dynamic policy last wrote desired capacity.",
      "Raise the floor or suspend the scheduled action before adding retries.",
      "Check warm-up and load-balancer deregistration delay, not only instance count.",
      "Shed low-priority traffic deliberately if capacity cannot be restored in time.",
      "Record timestamps, capacity values, and the action that caused the drop.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify that the floor covers the observed peak and the next failure domain.",
      "Remove or re-scope the scheduled action that collided with the surge.",
      "Add an alert for desired capacity below the demand requirement.",
      "Re-run the overlap test and document the remaining cost.",
    ],
  },
];

const references = [
  {
    title: "Amazon EC2 Auto Scaling: scheduled scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Scheduled actions set desired, minimum, and maximum capacity; policies continue within those bounds.",
  },
  {
    title: "Amazon EC2 Auto Scaling: scaling cooldowns",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cooldowns pause simple scaling; target tracking and scheduled actions behave differently.",
  },
  {
    title: "Google SRE Workbook: Managing Load",
    url: "https://sre.google/workbook/managing-load/",
    publisher: "Google",
    kind: "book" as const,
    note: "Autoscaling constraints, minimum and maximum bounds, warm-up, and conservative scale-down.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "scheduled-scaling-race": {
      model: scheduledScalingRaceModel,
      presets,
      instructions:
        "Start healthy, apply The race, then compare Freeze the schedule and Recovery. Watch in-service capacity, utilization, and error rate around 18:00.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Instance capacity and timings are teaching values, not AWS quotas. The cooldown slider represents a simple-scaling pause; target tracking uses warm-up instead.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-scheduled-scaling",
    "capacity-autoscaling-policies",
    "capacity-warm-pools",
    "capacity-headroom-cost",
    "case-composite-peak-race",
  ],
};
