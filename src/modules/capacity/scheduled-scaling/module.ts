import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAP_PER_INSTANCE = 2_000;
const TARGET_UTIL = 0.75;
const BASE_FRACTION = 0.3;
const WINDOW_START = 7;
const WINDOW_END = 10;
const SECONDS_PER_HOUR = 20;
const MIN_INSTANCES = 6;
const MAX_INSTANCES = 60;
const STARTUP_SECONDS = 40;
const SCALE_IN_SECONDS = 90;

const params = [
  {
    id: "peakRps",
    label: "Peak demand",
    min: 10_000,
    max: 40_000,
    step: 1_000,
    value: 16_000,
    unit: " rps",
    group: "Traffic",
    help: "Demand at the 9 a.m. plateau. The morning starts at 30% of this value.",
    format: "rps" as const,
  },
  {
    id: "scheduledCapacity",
    label: "Scheduled capacity",
    min: 2,
    max: 40,
    step: 1,
    value: 16,
    unit: " instances",
    group: "Schedule",
    help: "Instance count the scheduled action writes when it fires.",
    format: "count" as const,
  },
  {
    id: "scheduleUtcHour",
    label: "Schedule hour (UTC)",
    min: 0,
    max: 23,
    step: 1,
    value: 2,
    unit: ":00 UTC",
    group: "Schedule",
    help: "Hour written in the scheduled action. AWS evaluates scheduled actions in UTC.",
    format: "count" as const,
  },
  {
    id: "utcOffsetHours",
    label: "Region UTC offset",
    min: -8,
    max: 8,
    step: 1,
    value: 6,
    unit: " h",
    group: "Schedule",
    help: "Local time equals the UTC schedule hour plus this offset. A region at UTC+06:00 sees 02:00 UTC as 08:00 local.",
    format: "number" as const,
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

function localHour(t: number): number {
  return WINDOW_START + t / SECONDS_PER_HOUR;
}

function effectiveLocalHour(p: Params): number {
  const utc = num(p, "scheduleUtcHour", 2);
  const offset = num(p, "utcOffsetHours", 6);
  return (((utc + offset) % 24) + 24) % 24;
}

function demandAt(t: number, p: Params): number {
  const peak = Math.max(1_000, num(p, "peakRps", 16_000));
  const base = peak * BASE_FRACTION;
  const hour = localHour(t);
  if (hour >= 9) return peak;
  return base + (peak - base) * smoothstep((hour - WINDOW_START) / 2);
}

function desiredFor(demand: number): number {
  return clamp(Math.ceil(demand / (CAP_PER_INSTANCE * TARGET_UTIL)), MIN_INSTANCES, MAX_INSTANCES);
}

interface Computed {
  demand: number;
  instances: number;
  capacity: number;
  served: number;
  utilization: number;
  errors: number;
  p99: number;
  reactiveTarget: number;
  target: number;
  localHour: number;
  effectiveHour: number;
  actionAt: number;
  outsideWindow: boolean;
}

function compute(
  p: Params,
  t: number,
  instances: number,
  scheduledApplied: boolean,
  noise: number,
): Computed {
  const demand = demandAt(t, p);
  const safeInstances = Math.max(0.1, instances);
  const capacity = safeInstances * CAP_PER_INSTANCE;
  const utilization = demand / Math.max(1, capacity);
  const served = Math.min(demand, capacity);
  const shed = Math.max(0, demand - capacity);
  const errors = demand > 0 ? (shed / demand) * 100 : 0;
  const p99Base =
    utilization <= 1.08
      ? 40 + (500 * Math.pow(Math.min(utilization, 1.08), 6)) / Math.max(0.05, 1.08 - utilization)
      : 6_000;
  const reactiveTarget = desiredFor(demand);
  const scheduledTarget = scheduledApplied
    ? clamp(Math.round(num(p, "scheduledCapacity", 16)), MIN_INSTANCES, MAX_INSTANCES)
    : MIN_INSTANCES;
  const effectiveHour = effectiveLocalHour(p);
  return {
    demand,
    instances: safeInstances,
    capacity,
    served,
    utilization,
    errors,
    p99: Math.min(9_000, p99Base * noise),
    reactiveTarget,
    target: clamp(Math.max(reactiveTarget, scheduledTarget, MIN_INSTANCES), MIN_INSTANCES, MAX_INSTANCES),
    localHour: localHour(t),
    effectiveHour,
    actionAt: (effectiveHour - WINDOW_START) * SECONDS_PER_HOUR,
    outsideWindow: effectiveHour > WINDOW_END,
  };
}

function serviceHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.errors >= 5 || values.utilization >= 0.99 || values.p99 >= 5_000) return "crit";
  if (values.errors >= 1 || values.utilization >= 0.88 || values.p99 >= 800) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["fleet-utilization", values.utilization * 100, 1.5],
    ["error-rate", values.errors, 0.05],
    ["p99-latency", values.p99, 18],
    ["capacity-instances", values.instances, 0.1],
    ["scheduled-target", values.target, 0.1],
    ["demand-rps", values.demand, 40],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.99 + 0.01 * Math.sin((index + (seed % 6)) / 2.8)) + amplitude * Math.sin(index / 2.5)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  values: Computed,
  scheduledApplied: boolean,
  state: { outsideWarned: boolean; reactiveOnly: boolean; shortfall: boolean },
): SimFrame {
  const health = serviceHealth(values);
  const scheduleHealth: "ok" | "warn" =
    (values.outsideWindow || (!scheduledApplied && values.localHour >= values.actionAt)) && health !== "ok"
      ? "warn"
      : "ok";
  const effectiveHour = Math.round(values.effectiveHour);
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
        label: "Web fleet",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(values.utilization),
        throughput: values.served,
        capacity: values.capacity,
        sublabel: `${Math.round(values.instances)} serving · target ${values.target}`,
        detail: `${Math.round(values.instances)} instances carry ${Math.round(values.capacity).toLocaleString("en-US")} rps against ${Math.round(values.demand).toLocaleString("en-US")} rps. The reactive policy asks for ${values.reactiveTarget}.`,
        meta: { view: "flow" },
      },
      {
        id: "scheduler",
        label: "Scheduled scaling",
        kind: "service",
        health: scheduleHealth,
        sublabel: scheduledApplied
          ? `applied at ${effectiveHour}:00 local`
          : values.outsideWindow
            ? `outside window (${effectiveHour}:00 local)`
            : `waiting for ${effectiveHour}:00 local`,
        detail: `The action is written in UTC and lands at ${effectiveHour}:00 local time. The observed window is 07:00 to 10:00 local.`,
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
      edge("fleet-scheduler", "fleet", "scheduler", scheduledApplied ? 1 : 0.2, scheduleHealth),
      edge("fleet-db", "fleet", "db", clamp(values.served / 40_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("fleet-utilization", "Fleet utilization", Math.min(100, values.utilization * 100), "%", 88, 99, "percent"),
      metric("error-rate", "Error rate", values.errors, "%", 1, 5, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 800, 5_000, "ms"),
      metric("capacity-instances", "In-service capacity", values.instances, " instances", undefined, undefined, "count"),
      metric("scheduled-target", "Scheduled or reactive target", values.target, " instances", undefined, undefined, "count"),
      metric("demand-rps", "Demand", values.demand, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      scheduledApplied: scheduledApplied ? 1 : 0,
      outsideWarned: state.outsideWarned ? 1 : 0,
      reactiveOnly: state.reactiveOnly ? 1 : 0,
      shortfall: state.shortfall ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.instances)} instances serve ${Math.round(values.demand).toLocaleString("en-US")} rps at ${Math.round(values.utilization * 100)}% utilization. Local time is ${values.localHour.toFixed(1)}; the schedule lands at ${effectiveHour}:00 local.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const values = compute(p, 0, MIN_INSTANCES, false, 1);
  const frame = buildFrame(p, seed, values, false, {
    outsideWarned: false,
    reactiveOnly: false,
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
    title: "Demand arrived before capacity",
    cause:
      "The morning ramp added load before enough instances were serving. A scheduled action that fires late, or in the wrong time zone, leaves the reactive policy to close a gap that it cannot close instantly.",
    fix:
      "Align the schedule with the local traffic pattern and move it earlier. Keep a reactive policy as the backstop for demand that is higher or earlier than the pattern predicts.",
    checkFirst: [
      "Compare the scheduled action's local time with the first minute of the ramp.",
      "Compare desired, in-service, and pending capacity at the ramp.",
      "Check whether the reactive policy was blocked by a cooldown or a maximum.",
    ],
  },
  {
    id: "fleet-utilization",
    metricId: "fleet-utilization",
    warn: 88,
    crit: 99,
    title: "The fleet is saturated by the known peak",
    cause:
      "The scheduled capacity is below the peak requirement, or the action has not run yet. Utilization rises before errors because the fleet can still serve at the limit for a short time.",
    fix:
      "Set scheduled capacity from the peak requirement, not from the overnight baseline. Add headroom for the loss of one instance or zone and keep the schedule earlier than the ramp.",
    checkFirst: [
      "Compare scheduled capacity with demand at the peak.",
      "Check whether the schedule targets the right day and time zone.",
      "Check whether reactive scaling can exceed the scheduled count.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 800,
    crit: 5_000,
    title: "Requests are queueing during the morning ramp",
    cause:
      "The fleet is at or near its service limit while the schedule waits or the new capacity warms. Latency rises before errors and then accelerates when clients retry.",
    fix:
      "Move the schedule ahead of the ramp, increase the scheduled count, or add a warm pool so the scheduled capacity is useful sooner.",
    checkFirst: [
      "Check p99 by target group and instance.",
      "Check retry volume and client timeouts.",
      "Check whether the schedule fired in UTC at the expected local time.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const scheduledScalingModel: SimModel = {
  id: "capacity-scheduled-scaling",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const stepSeconds = Math.min(1, Math.max(0.01, dt));
    const t = frame.t;
    let instances = fresh ? MIN_INSTANCES : Number(frame.flags.instances ?? MIN_INSTANCES);
    if (!Number.isFinite(instances)) instances = MIN_INSTANCES;
    let scheduledApplied = fresh ? false : frame.flags.scheduledApplied === 1;
    let outsideWarned = fresh ? false : frame.flags.outsideWarned === 1;
    let reactiveOnly = fresh ? false : frame.flags.reactiveOnly === 1;
    let reactiveWarned = fresh ? false : frame.flags.reactiveWarned === 1;
    let shortfall = fresh ? false : frame.flags.shortfall === 1;
    const noise = 0.98 + 0.04 * rng.next();
    const hour = localHour(t);
    const effective = effectiveLocalHour(p);

    if (!scheduledApplied && effective < WINDOW_START) {
      scheduledApplied = true;
    }
    if (!scheduledApplied && effective >= WINDOW_START && effective <= WINDOW_END && hour >= effective) {
      scheduledApplied = true;
    }

    const demand = demandAt(t, p);
    const reactiveTarget = desiredFor(demand);
    const scheduledTarget = scheduledApplied
      ? clamp(Math.round(num(p, "scheduledCapacity", 16)), MIN_INSTANCES, MAX_INSTANCES)
      : MIN_INSTANCES;
    const target = clamp(Math.max(reactiveTarget, scheduledTarget, MIN_INSTANCES), MIN_INSTANCES, MAX_INSTANCES);
    const gap = target - instances;
    if (gap > 0) instances += gap * Math.min(1, stepSeconds / STARTUP_SECONDS);
    else if (gap < 0) instances += gap * Math.min(1, stepSeconds / SCALE_IN_SECONDS);
    instances = clamp(instances, 0.1, MAX_INSTANCES);

    const values = compute(p, t, instances, scheduledApplied, noise);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values, scheduledApplied, {
      outsideWarned,
      reactiveOnly,
      shortfall,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!outsideWarned && (effective > WINDOW_END || effective < WINDOW_START)) {
      pushEvent(next, {
        id: "schedule-outside-window",
        at: t,
        severity: "warn",
        title: "The scheduled action lands outside the traffic window",
        detail: `The action evaluates to ${Math.round(effective)}:00 local, while the ramp runs from 07:00 to 10:00. It will not add capacity when the pattern needs it.`,
        nodeId: "scheduler",
        metricId: "error-rate",
      });
      outsideWarned = true;
    }

    if (scheduledApplied && !reactiveOnly) {
      pushEvent(next, {
        id: "scheduled-action-applied",
        at: t,
        severity: "info",
        title: "The scheduled action wrote desired capacity",
        detail: `The action set a target of ${Math.round(num(p, "scheduledCapacity", 16))} instances at ${Math.round(effective)}:00 local.`,
        nodeId: "fleet",
        metricId: "scheduled-target",
      });
      reactiveOnly = true;
    }

    if (!reactiveWarned && !scheduledApplied && values.utilization >= 0.88) {
      pushEvent(next, {
        id: "reactive-carrying-the-ramp",
        at: t,
        severity: "warn",
        title: "Reactive scaling is carrying the ramp alone",
        detail: `No scheduled capacity is in effect. The reactive policy asks for ${reactiveTarget} instances, but new instances still need startup time.`,
        nodeId: "fleet",
        metricId: "fleet-utilization",
      });
      reactiveWarned = true;
    }

    if (!shortfall && values.errors > 0) {
      pushEvent(next, {
        id: "scheduled-capacity-shortfall",
        at: t,
        severity: values.errors >= 5 ? "crit" : "warn",
        title: "Served capacity is below the morning demand",
        detail: `Served ${Math.round(values.served).toLocaleString("en-US")} of ${Math.round(values.demand).toLocaleString("en-US")} rps. The schedule and the reactive policy together determine the gap.`,
        nodeId: "lb",
        metricId: "error-rate",
      });
      shortfall = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      instances,
      scheduledApplied: scheduledApplied ? 1 : 0,
      outsideWarned: outsideWarned ? 1 : 0,
      reactiveOnly: reactiveOnly ? 1 : 0,
      reactiveWarned: reactiveWarned ? 1 : 0,
      shortfall: shortfall ? 1 : 0,
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
    const items = [
      `${Math.round(value("capacity-instances"))} instances serve at ${value("fleet-utilization").toFixed(0)}% utilization. The target is ${Math.round(value("scheduled-target"))} instances.`,
      `Demand is ${Math.round(value("demand-rps")).toLocaleString("en-US")} rps. The schedule is written in UTC; check the local hour before assuming it fired at the right time.`,
      "A schedule changes capacity at one point in time. The reactive policy covers the demand that arrives earlier, higher, or later than the pattern.",
    ];
    if (value("error-rate") >= 1) {
      items.push("The ramp outran the scheduled capacity: compare the action's local hour with the time demand crossed the fleet limit.");
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
    description: "A 16k rps peak and a 16-instance action at 08:00 local, one hour before the peak.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with a thin schedule",
    description: "A 20k rps peak and 14 scheduled instances; the fleet is saturated but serves the peak.",
    tone: "warn",
    params: defaults({ peakRps: 20_000, scheduledCapacity: 14, scheduleUtcHour: 3, utcOffsetHours: 5 }),
  },
  {
    id: "failure",
    label: "Wrong time zone",
    description: "The action is written for 08:00 UTC in a UTC+06:00 region, so it lands at 14:00 local, after the 34k rps peak.",
    tone: "crit",
    params: defaults({ peakRps: 34_000, scheduledCapacity: 20, scheduleUtcHour: 8, utcOffsetHours: 6 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The same 34k rps peak with the action at 02:00 UTC, which is 08:00 local, and 30 scheduled instances.",
    tone: "ok",
    params: defaults({ peakRps: 34_000, scheduledCapacity: 30, scheduleUtcHour: 2, utcOffsetHours: 6 }),
  },
];

const experiment: Experiment = {
  id: "predict-timezone",
  title: "Predict when the scheduled action fires",
  simId: "scheduled-scaling",
  question:
    "The traffic peak is at 09:00 local. The scheduled action says 08:00 UTC, and the region is UTC+06:00. What happens?",
  prediction: {
    options: [
      { id: "early", label: "It fires six hours early and adds capacity overnight" },
      { id: "right", label: "It fires at 08:00 local, one hour before the peak" },
      { id: "late", label: "It fires at 14:00 local, after the peak has already arrived" },
      { id: "none", label: "It has no effect because scheduled actions use local time" },
    ],
    correctOptionId: "late",
    explanation:
      "Scheduled actions are evaluated in UTC. 08:00 UTC in a UTC+06:00 region is 14:00 local. The morning peak at 09:00 local has already happened, so the action adds capacity after the demand has passed. The reactive policy has to carry the ramp, and its startup time leaves a gap. Writing 02:00 UTC puts the action at 08:00 local.",
  },
  setup: defaults({ peakRps: 34_000, scheduledCapacity: 20, scheduleUtcHour: 8, utcOffsetHours: 6 }),
  runFor: 45,
  observe: [
    "The fleet starts at the overnight floor of six instances.",
    "Demand passes the fleet's capacity before 09:00 local.",
    "The scheduled action is reported outside the 07:00 to 10:00 window.",
    "Errors rise while the reactive policy adds capacity one startup period at a time.",
  ],
  explain:
    "The schedule is not wrong about the count; it is wrong about the clock. A scheduled action has no idea what the local traffic pattern looks like. It writes capacity at the UTC time it was given. If that lands after the ramp, the service pays for the reactive policy's lag. Aligning the UTC time with the local pattern is a one-line fix that changes the whole morning.",
  fix: defaults({ peakRps: 34_000, scheduledCapacity: 30, scheduleUtcHour: 2, utcOffsetHours: 6 }),
  debrief:
    "At 02:00 UTC, which is 08:00 local, the action writes 30 instances an hour before the peak. The fleet is already serving when demand arrives at 09:00. The cost is 30 instances through the early morning, including the hour before the ramp. That is cheaper than losing the peak, and the reactive policy still covers a day that runs hotter than the pattern.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Scheduled scaling changes capacity at a wall-clock time. It is a calendar action, not a reaction to a metric. You use it when demand follows a known pattern: a weekday morning ramp, a batch window, a marketing event with a fixed start. The action writes a desired capacity and can also set minimum and maximum capacity. It runs whether or not the pattern shows up, so it is only appropriate for demand you can predict with reasonable confidence.",
  },
  {
    type: "p",
    text: "AWS scheduled actions are specified in UTC. The traffic pattern is local to the users. A schedule written for 08:00 UTC in a region at UTC+06:00 fires at 14:00 local. That is the most common way a correct-looking schedule misses the peak: the count is right, the clock is wrong. Convert the local ramp to UTC before writing the action, and check the local hour in the console rather than assuming the schedule knows the region.",
  },
  {
    type: "p",
    text: "Scheduled scaling is not a replacement for reactive scaling. It handles the predictable part of the demand; the reactive policy handles the surprise. If the two disagree, one of them writes the same desired-capacity field and the result depends on which one ran last and what bounds it left behind. Give the schedule a floor that the reactive policy may exceed, and keep the reactive policy able to add capacity when the day runs hotter than the pattern.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The schedule sits above the Auto Scaling group. It writes desired capacity at a time; the group launches instances, registers them with the load balancer, and waits for health checks. The load balancer does not know why the group changed size. The reactive policy sits beside the schedule and watches a metric. During the ramp, both may be trying to add capacity; outside the ramp, the schedule may try to remove capacity that the reactive policy still needs.",
  },
  {
    type: "table",
    headers: ["Schedule timing", "What happens", "Signal", "Fix"],
    rows: [
      ["One hour early", "Capacity is ready before the ramp", "Utilization stays low", "Keep it, but watch idle cost"],
      ["At the ramp start", "Capacity warms while demand rises", "Latency spike at the start", "Move it earlier or add a warm pool"],
      ["After the peak", "Reactive policy carries the whole ramp", "Errors before the action", "Correct the UTC-to-local conversion"],
      ["Wrong day or no action", "No scheduled capacity at all", "Desired stays at the floor", "Check the recurrence and the action status"],
    ],
  },
  {
    type: "p",
    text: "The model compresses 07:00 to 10:00 local into 60 simulated seconds, with one simulated hour every 20 seconds. It uses 2,000 rps per instance, a 75% target, six instances at the overnight floor, and a 40-second startup. Those are teaching values, not AWS quotas or instance benchmarks. The action writes a desired count; the model still applies startup time before the instances serve.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Fleet utilization and error rate through the morning ramp.",
      "In-service capacity and the scheduled or reactive target, so the action and the fleet are separate.",
      "Demand in rps, which makes the size of the gap visible.",
      "p99 latency, which rises before errors while the fleet is short.",
      "A scheduler node that reports the local hour the UTC action lands on.",
      "A flow from client to load balancer to fleet, scheduler, and database.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note that 02:00 UTC is 08:00 local. Then apply Wrong time zone: the same count lands at 14:00 local and misses the peak. Run the guided experiment before changing sliders. Compare Recovery with Healthy to see the difference between fixing the clock and only raising the count.",
  },
  { type: "sim", simId: "scheduled-scaling" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet started at six instances, enough for the overnight baseline. Demand began to climb at 07:00 local and reached 34k rps at 09:00. The scheduled action was written for 08:00 UTC in a UTC+06:00 region, which is 14:00 local. It never fired inside the observed window. The reactive policy saw utilization rise and asked for more capacity, but each new instance took 40 simulated seconds to serve. The fleet shed demand through the ramp and errors crossed the critical threshold before the peak.",
  },
  {
    type: "p",
    text: "In Recovery, the action was written for 02:00 UTC, which is 08:00 local, and it asked for 30 instances. The fleet had an hour of local time to add capacity before the 09:00 peak. Utilization stayed below the critical band and the service served the full ramp. The only change was the clock and the count, not a new autoscaling algorithm.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Auto Scaling scheduled action status and the timestamp of the last execution, converted to local time.",
      "Group desired, in-service, and pending capacity around the action, not only after the peak.",
      "Load balancer request count, target response time, and 5xx rate by minute through the ramp.",
      "Reactive policy alarms: the metric, the target, and the desired count the policy wrote.",
      "CloudTrail: who last changed the schedule, its recurrence, and its time zone assumptions.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Convert the scheduled action to local time and compare it with the first minute of the ramp. Then compare scheduled capacity with peak demand. If the action fired on time and the fleet is still short, the count or the startup path is the problem. If it fired late or not at all, the clock or the recurrence is.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Convert the local ramp time to UTC and confirm the action's next execution in local time.",
      "Set the scheduled count from the peak requirement plus failure headroom, not from the overnight baseline.",
      "Move the action earlier than the ramp so startup finishes before demand arrives.",
      "Keep a reactive policy as a backstop, and make sure it can exceed the scheduled floor.",
      "Add a warm pool or pre-scale path if the schedule cannot start early enough.",
      "Test a day that ramps earlier and higher than the pattern, not only the average day.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "An early schedule protects the ramp and holds capacity idle before demand arrives.",
      "A late schedule saves idle time and risks the peak if reactive scaling cannot close the gap.",
      "A large scheduled count is simple and expensive on days when the pattern does not arrive.",
      "A reactive-only policy is flexible and always pays the startup lag at the start of a ramp.",
      "A schedule and a reactive policy together need an explicit floor and owner, or they can fight over the same desired-capacity field.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "schedule-timezone",
    question:
      "A scheduled scale-up for the 9 a.m. peak is not helping. How do you debug it?",
    difficulty: 2,
    hints: [
      "Scheduled actions are evaluated in UTC.",
      "Compare the action's local execution time with the ramp.",
    ],
    answer:
      "I would convert the action's UTC time to the local time of the workload and compare it with the first minute of the ramp. Then I would check the action's status and recurrence, the group's desired capacity around the action, and whether the action writes the count we expect. If the action fires after the peak, the time zone is the bug. If it fires on time but capacity is still short, the count, the startup path, or the reactive policy is the problem.",
    followUps: [
      "How would you verify the next execution time?",
      "What if the action fires on time and capacity is still short?",
      "How do you handle a region that observes daylight saving time?",
    ],
    redFlags: [
      "Assumes the console shows local time.",
      "Checks only the instance count.",
      "Blames the autoscaler before checking the schedule.",
    ],
    rubric: [
      "Converts UTC to local.",
      "Checks action status and recurrence.",
      "Separates timing from count.",
      "Mentions daylight saving or offset changes.",
    ],
  },
  {
    id: "schedule-vs-reactive",
    question:
      "Why keep a reactive policy if the traffic pattern is known?",
    difficulty: 2,
    hints: [
      "The pattern is an average, not a guarantee.",
      "Reactive capacity still needs startup time.",
    ],
    answer:
      "The schedule handles the predictable part, and the reactive policy handles the day that does not match the pattern: a marketing spike, a late batch, a holiday, or a regional event. Without the reactive policy, any demand above the scheduled count is unserved. With it, the schedule gives the reactive policy a head start and the reactive policy covers the surprise. The two need a floor and an owner so the schedule does not remove capacity the reactive policy needs.",
    followUps: [
      "Which one should own capacity during the ramp?",
      "How do you prevent the schedule from scaling in during a spike?",
      "What is the cost of keeping both?",
    ],
    redFlags: [
      "Treats the pattern as exact.",
      "Removes the reactive policy to save cost.",
      "Lets both write capacity with no bounds.",
    ],
    rubric: [
      "Names the predictable and unpredictable parts.",
      "Explains the backstop role.",
      "Mentions a floor or owner.",
      "States the cost.",
    ],
  },
  {
    id: "design-schedule",
    question:
      "Design scheduled scaling for a weekday morning ramp without wasting capacity all night.",
    difficulty: 3,
    hints: [
      "The action should finish before the ramp, not at its start.",
      "The overnight floor can be lower than the peak count.",
    ],
    answer:
      "I would set a low overnight floor, a scheduled action an hour or so before the ramp that raises the count to the peak requirement plus headroom, and a second action after the peak that lowers it. I would convert both to UTC and verify them in local time, including daylight saving changes. I would keep a reactive policy above the scheduled floor for days that run hotter, and a warm pool if startup cannot finish inside the lead time. I would test the schedule on a holiday and on a day with an early spike, not only on the average weekday.",
    followUps: [
      "How do you choose the lead time?",
      "What happens on a holiday?",
      "How do you avoid paying for the peak count all night?",
    ],
    redFlags: [
      "Sets the peak count permanently.",
      "Schedules the action at the peak time.",
      "Ignores holidays and time zone changes.",
    ],
    rubric: [
      "Uses a lead time before the ramp.",
      "Sets a low off-peak floor.",
      "Handles time zones and exceptions.",
      "Keeps a reactive backstop.",
      "States idle cost.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every scheduled action is documented in both UTC and local time.",
      "The action fires before the ramp, with enough lead time for startup.",
      "The scheduled count covers the peak plus failure headroom.",
      "A reactive policy can exceed the scheduled floor.",
      "The recurrence is tested across holidays and daylight saving changes.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Convert the action time to local and compare it with the first minute of the ramp.",
      "Check whether the action fired, its status, and the desired count it wrote.",
      "Compare scheduled capacity with demand at the peak.",
      "Check whether reactive scaling is blocked by a cooldown or a maximum.",
      "Record the local time, the UTC time, and the capacity gap.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Correct the UTC schedule or the recurrence.",
      "Raise the scheduled count or move the action earlier.",
      "Add a reactive backstop if the schedule is the only mechanism.",
      "Re-test with an earlier, higher ramp and a holiday.",
    ],
  },
];

const references = [
  {
    title: "Scheduled scaling for Amazon EC2 Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Scheduled actions change desired, minimum, or maximum capacity at a specified time.",
  },
  {
    title: "Target tracking scaling policies for Amazon EC2 Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/as-scaling-target-tracking.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Reactive target tracking keeps a metric near a target and can act as the backstop for a schedule.",
  },
  {
    title: "Scaling cooldowns for Amazon EC2 Auto Scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scaling-cooldowns.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Cooldowns pause simple scaling and can delay a step-based response after a scheduled change.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "scheduled-scaling": {
      model: scheduledScalingModel,
      presets,
      instructions:
        "Start healthy, apply Wrong time zone, then compare Recovery. Watch the scheduler's local hour, in-service capacity, and error rate through the 09:00 ramp.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 07:00–10:00 window is compressed into 60 simulated seconds; throughput and timings are teaching values, not AWS quotas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-autoscaling-policies",
    "capacity-scheduled-scaling-race",
    "capacity-warm-pools",
    "capacity-headroom-cost",
  ],
};
