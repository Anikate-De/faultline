import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAP_PER_INSTANCE = 1_200;
const TARGET_UTIL = 0.7;
const BASE_FRACTION = 0.3;
const MAX_INSTANCES = 40;
const SCALE_IN_SECONDS = 120;

const params = [
  {
    id: "peakRps",
    label: "Peak demand",
    min: 8_000,
    max: 40_000,
    step: 1_000,
    value: 16_000,
    unit: " rps",
    group: "Traffic",
    help: "Demand reached after the ramp. The ramp starts at 30% of this value.",
    format: "rps" as const,
  },
  {
    id: "warmPoolSize",
    label: "Warm pool size",
    min: 0,
    max: 30,
    step: 1,
    value: 12,
    unit: " instances",
    group: "Warm pool",
    help: "Pre-initialized instances kept ready to serve. The pool is consumed by scale-out and refilled at the cold-start rate.",
    format: "count" as const,
  },
  {
    id: "coldStartSeconds",
    label: "Cold start",
    min: 30,
    max: 300,
    step: 15,
    value: 60,
    unit: "s",
    group: "Warm pool",
    help: "Time to launch and initialize an instance that is not already warm. This sets both scale-out lag and pool refill speed.",
    format: "number" as const,
  },
  {
    id: "rampSeconds",
    label: "Traffic ramp",
    min: 10,
    max: 120,
    step: 5,
    value: 35,
    unit: "s",
    group: "Traffic",
    help: "Time for demand to reach the peak. A fast ramp consumes the pool before it can refill.",
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

function demandAt(t: number, p: Params): number {
  const peak = Math.max(1_000, num(p, "peakRps", 16_000));
  const base = peak * BASE_FRACTION;
  const ramp = Math.max(1, num(p, "rampSeconds", 35));
  return base + (peak - base) * smoothstep(t / ramp);
}

function desiredFor(demand: number): number {
  return clamp(Math.ceil(demand / (CAP_PER_INSTANCE * TARGET_UTIL)), 1, MAX_INSTANCES);
}

function initialFor(p: Params): number {
  const base = Math.max(1_000, num(p, "peakRps", 16_000)) * BASE_FRACTION;
  return clamp(Math.ceil(base / (CAP_PER_INSTANCE * TARGET_UTIL)) + 1, 2, MAX_INSTANCES);
}

function poolSize(p: Params): number {
  return clamp(Math.round(num(p, "warmPoolSize", 12)), 0, 30);
}

interface Computed {
  demand: number;
  instances: number;
  capacity: number;
  served: number;
  utilization: number;
  errors: number;
  p99: number;
  desired: number;
  deficit: number;
  coldLag: number;
  idleWarm: number;
}

function compute(p: Params, t: number, instances: number, warmReady: number, noise: number): Computed {
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
  const desired = desiredFor(demand);
  const deficit = Math.max(0, desired - safeInstances);
  return {
    demand,
    instances: safeInstances,
    capacity,
    served,
    utilization,
    errors,
    p99: Math.min(9_000, p99Base * noise),
    desired,
    deficit,
    coldLag: deficit > 0 ? num(p, "coldStartSeconds", 60) * clamp(deficit / Math.max(1, desired)) : 0,
    idleWarm: Math.max(0, warmReady),
  };
}

function serviceHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.errors >= 5 || values.utilization >= 0.99 || values.p99 >= 5_000 || values.idleWarm >= 30) {
    return "crit";
  }
  if (values.errors >= 1 || values.utilization >= 0.85 || values.p99 >= 800 || values.idleWarm >= 18) {
    return "warn";
  }
  return "ok";
}

function idleHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.idleWarm >= 30) return "crit";
  if (values.idleWarm >= 18) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["fleet-utilization", values.utilization * 100, 1.5],
    ["error-rate", values.errors, 0.05],
    ["p99-latency", values.p99, 18],
    ["idle-warm", values.idleWarm, 0.2],
    ["warm-ready", values.idleWarm, 0.2],
    ["cold-start-lag", values.coldLag, 1],
    ["capacity-instances", values.instances, 0.1],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * (0.99 + 0.01 * Math.sin((index + (seed % 5)) / 3.1)) + amplitude * Math.sin(index / 2.6)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  seed: number,
  values: Computed,
  state: { poolEmpty: boolean; coldBacklog: boolean; oversized: boolean; shortfall: boolean },
): SimFrame {
  const health = serviceHealth(values);
  const coldHealth: "ok" | "warn" | "crit" =
    values.deficit <= 0 || health === "ok" ? "ok" : health === "crit" ? "crit" : "warn";
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
        sublabel: `${Math.round(values.instances)} serving · ${Math.round(values.idleWarm)} warm`,
        detail: `${Math.round(values.instances)} instances carry ${Math.round(values.capacity).toLocaleString("en-US")} rps against ${Math.round(values.demand).toLocaleString("en-US")} rps. The policy wants ${values.desired}.`,
        meta: { view: "flow" },
      },
      {
        id: "warm",
        label: "Warm pool",
        kind: "service",
        role: "instance",
        health: idleHealth(values),
        utilization: clamp(values.idleWarm / Math.max(1, poolSize(p))),
        sublabel: `${Math.round(values.idleWarm)} ready · pool ${poolSize(p)}`,
        detail: "A running warm instance can serve almost immediately. A stopped warm instance must be started first, and storage for stopped instances can still be billed.",
        meta: { view: "flow" },
      },
      {
        id: "cold",
        label: "Cold launches",
        kind: "external",
        health: coldHealth,
        utilization: values.desired > 0 ? clamp(values.deficit / values.desired) : 0,
        sublabel: `${Math.round(values.deficit)} instances behind · ${Math.round(values.coldLag)}s`,
        detail: "Cold capacity is launched, initialized, and registered before it serves. This is the lag a warm pool is meant to hide.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.demand / 40_000), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.demand / 40_000), health),
      edge("fleet-warm", "fleet", "warm", clamp(values.idleWarm / Math.max(1, poolSize(p))), idleHealth(values)),
      edge("warm-cold", "warm", "cold", clamp(values.deficit / Math.max(1, values.desired)), coldHealth),
    ],
    metrics: [
      metric("fleet-utilization", "Fleet utilization", Math.min(100, values.utilization * 100), "%", 85, 99, "percent"),
      metric("error-rate", "Error rate", values.errors, "%", 1, 5, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 800, 5_000, "ms"),
      metric("idle-warm", "Idle warm capacity", values.idleWarm, " instances", 18, 30, "count"),
      metric("warm-ready", "Warm instances ready", values.idleWarm, " instances", undefined, undefined, "count"),
      metric("cold-start-lag", "Cold-start lag", values.coldLag, "s", undefined, undefined, "number"),
      metric("capacity-instances", "In-service capacity", values.instances, " instances", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      poolEmpty: state.poolEmpty ? 1 : 0,
      coldBacklog: state.coldBacklog ? 1 : 0,
      oversized: state.oversized ? 1 : 0,
      shortfall: state.shortfall ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.instances)} instances serve ${Math.round(values.demand).toLocaleString("en-US")} rps at ${Math.round(values.utilization * 100)}% utilization. ${Math.round(values.idleWarm)} warm instances are idle; cold-start lag is ${Math.round(values.coldLag)}s.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const instances = initialFor(p);
  const warmReady = poolSize(p);
  const values = compute(p, 0, instances, warmReady, 1);
  const frame = buildFrame(p, seed, values, {
    poolEmpty: false,
    coldBacklog: false,
    oversized: false,
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
    title: "Scale-out is behind the traffic ramp",
    cause:
      "Demand rose faster than the fleet could add useful capacity. The warm pool covers only the instances it holds; once it is empty, every additional instance waits for a cold start.",
    fix:
      "Size the pool to the gap between the ramp's start and peak, not to the peak itself. If the ramp is faster than any pool can cover, pre-scale before it starts or slow the ramp with admission control.",
    checkFirst: [
      "Compare demand, in-service capacity, and desired capacity over the ramp.",
      "Check when the warm pool reached zero.",
      "Check whether cold launches were pending or failing health checks.",
    ],
  },
  {
    id: "fleet-utilization",
    metricId: "fleet-utilization",
    warn: 85,
    crit: 99,
    title: "The fleet is saturated while capacity catches up",
    cause:
      "The pool was exhausted and cold instances were still initializing. Utilization rises before errors because requests queue while capacity is missing.",
    fix:
      "Add warm capacity for the ramp gap, or add headroom so the fleet does not need to scale at the first second of the peak.",
    checkFirst: [
      "Check the time from the first scale-out decision to the first served request.",
      "Check whether the pool refilled during the ramp or only after it.",
      "Compare the ramp duration with the cold-start time.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 800,
    crit: 5_000,
    title: "Requests are waiting for capacity",
    cause:
      "The fleet is at or near its service limit while new instances initialize. The queue is visible as latency before it becomes errors.",
    fix:
      "Cover the gap with warm capacity or reduce time-to-capacity. Verify that retries are not multiplying the load while the pool refills.",
    checkFirst: [
      "Split p99 by target group and instance to find the capacity gap.",
      "Check retry volume and client timeouts.",
      "Check whether the load balancer is sending traffic to instances that are not ready.",
    ],
  },
  {
    id: "idle-warm",
    metricId: "idle-warm",
    warn: 18,
    crit: 30,
    title: "The warm pool is holding capacity nobody uses",
    cause:
      "A warm pool is billed capacity. If the pool is sized for the peak rather than for the ramp gap, most of it sits idle outside the ramp and still costs money.",
    fix:
      "Size the pool from the capacity gap at the steepest ramp, then shrink it after the ramp. Use scheduled pool changes for known quiet periods.",
    checkFirst: [
      "Compare pool size with the capacity added during the last ramp.",
      "Check how long the pool stays idle after the peak.",
      "Check whether stopped warm instances still incur storage charges.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const warmPoolsModel: SimModel = {
  id: "capacity-warm-pools",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p, dt, rng) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const stepSeconds = Math.min(1, Math.max(0.01, dt));
    const t = frame.t;
    let instances = fresh ? initialFor(p) : Number(frame.flags.instances ?? initialFor(p));
    let warmReady = fresh ? poolSize(p) : Number(frame.flags.warmReady ?? poolSize(p));
    if (!Number.isFinite(instances)) instances = initialFor(p);
    if (!Number.isFinite(warmReady)) warmReady = poolSize(p);
    let poolEmpty = fresh ? false : frame.flags.poolEmpty === 1;
    let coldBacklog = fresh ? false : frame.flags.coldBacklog === 1;
    let oversized = fresh ? false : frame.flags.oversized === 1;
    let shortfall = fresh ? false : frame.flags.shortfall === 1;
    const noise = 0.98 + 0.04 * rng.next();
    const demand = demandAt(t, p);
    const desired = desiredFor(demand);
    let need = desired - instances;
    if (need > 0) {
      const fromPool = Math.min(need, warmReady);
      instances += fromPool;
      warmReady -= fromPool;
      need -= fromPool;
      if (need > 0) instances += need * Math.min(1, stepSeconds / Math.max(1, num(p, "coldStartSeconds", 60)));
    } else if (need < 0) {
      instances += need * Math.min(1, stepSeconds / SCALE_IN_SECONDS);
    }
    const poolTarget = poolSize(p);
    warmReady += (poolTarget - warmReady) * Math.min(1, stepSeconds / Math.max(1, num(p, "coldStartSeconds", 60)));
    warmReady = clamp(warmReady, 0, poolTarget);
    instances = clamp(instances, 0.1, MAX_INSTANCES);

    const values = compute(p, t, instances, warmReady, noise);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), values, {
      poolEmpty,
      coldBacklog,
      oversized,
      shortfall,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!poolEmpty && poolTarget > 0 && warmReady < 0.5 && desired > instances) {
      pushEvent(next, {
        id: "warm-pool-empty",
        at: t,
        severity: "warn",
        title: "The warm pool is empty",
        detail: `The fleet needs ${desired} instances and has ${Math.round(instances)} in service. Every additional instance now waits for a cold start of about ${Math.round(num(p, "coldStartSeconds", 60))}s.`,
        nodeId: "warm",
        metricId: "cold-start-lag",
      });
      poolEmpty = true;
    }

    if (!coldBacklog && values.deficit > 0) {
      pushEvent(next, {
        id: "cold-start-backlog",
        at: t,
        severity: values.errors >= 5 ? "crit" : "warn",
        title: "Cold capacity is behind demand",
        detail: `${Math.round(values.deficit)} instances are not yet serving. The fleet is short by ${Math.round(values.errors)}% of demand.`,
        nodeId: "cold",
        metricId: "error-rate",
      });
      coldBacklog = true;
    }

    if (!oversized && values.idleWarm >= 18) {
      pushEvent(next, {
        id: "oversized-warm-pool",
        at: t,
        severity: "warn",
        title: "Warm capacity is idle",
        detail: `${Math.round(values.idleWarm)} warm instances are not serving traffic. The pool is sized for a peak that has not arrived.`,
        nodeId: "warm",
        metricId: "idle-warm",
      });
      oversized = true;
    }

    if (!shortfall && values.errors > 0) {
      pushEvent(next, {
        id: "ramp-shortfall",
        at: t,
        severity: values.errors >= 5 ? "crit" : "warn",
        title: "The fleet is serving less than demand",
        detail: `Served ${Math.round(values.served).toLocaleString("en-US")} of ${Math.round(values.demand).toLocaleString("en-US")} rps. The pool and the cold-start path determine how long the gap lasts.`,
        nodeId: "fleet",
        metricId: "error-rate",
      });
      shortfall = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      instances,
      warmReady,
      poolEmpty: poolEmpty ? 1 : 0,
      coldBacklog: coldBacklog ? 1 : 0,
      oversized: oversized ? 1 : 0,
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
      `${Math.round(value("capacity-instances"))} instances serve at ${value("fleet-utilization").toFixed(0)}% utilization; ${Math.round(value("idle-warm"))} warm instances are idle.`,
      `Cold-start lag is ${Math.round(value("cold-start-lag"))}s. A pool covers the ramp only while it holds enough instances for the gap; once empty, every new instance pays that lag.`,
      "Size the pool from the difference between the ramp's starting capacity and its peak, then check what it costs while demand is flat.",
    ];
    if (value("error-rate") >= 1) {
      items.push("The ramp is outrunning the pool: compare the time to peak with the time to add one cold instance.");
    }
    if (value("idle-warm") >= 18) {
      items.push("The pool is larger than the ramp needs; idle warm instances are billed capacity.");
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
    description: "A 16k rps ramp covered by 12 warm instances and 60s cold starts; the pool lasts through the ramp.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak with a slow refill",
    description: "A 27k rps peak and 120s cold starts; the pool empties and the fleet saturates but keeps serving.",
    tone: "warn",
    params: defaults({ peakRps: 27_000, warmPoolSize: 8, coldStartSeconds: 120, rampSeconds: 30 }),
  },
  {
    id: "failure",
    label: "No pool, fast ramp",
    description: "A 30k rps ramp in 15s with no warm pool and 240s cold starts; capacity misses the whole ramp.",
    tone: "crit",
    params: defaults({ peakRps: 30_000, warmPoolSize: 0, coldStartSeconds: 240, rampSeconds: 15 }),
  },
  {
    id: "oversized",
    label: "Pool sized for the peak",
    description: "A 10k rps workload with a 24-instance pool; the service is healthy and the pool is mostly idle.",
    tone: "warn",
    params: defaults({ peakRps: 10_000, warmPoolSize: 24, coldStartSeconds: 60, rampSeconds: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 16-instance pool and 45s cold starts cover a 30k rps ramp in 20s.",
    tone: "ok",
    params: defaults({ peakRps: 30_000, warmPoolSize: 16, coldStartSeconds: 45, rampSeconds: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-warm-pool-size",
  title: "Predict how to cover the ramp",
  simId: "warm-pools",
  question:
    "Demand ramps from 9k to 30k rps in 15 seconds. Cold starts take four minutes. Which pool sizing gives the service the best chance without holding peak capacity all day?",
  prediction: {
    options: [
      { id: "peak", label: "Size the pool to the 30k rps peak" },
      { id: "gap", label: "Size the pool to the capacity gap during the ramp" },
      { id: "zero", label: "Keep no pool and rely on the autoscaler" },
      { id: "small", label: "Keep one warm instance as a seed" },
    ],
    correctOptionId: "gap",
    explanation:
      "The pool only has to cover the capacity that the ramp needs before cold instances can arrive. Sizing it to the full peak keeps the same instances warm all day, including the hours when demand is low. Sizing it to zero leaves the ramp entirely to cold starts. The right size is the difference between the capacity at the start of the ramp and the capacity needed at the end, adjusted for how quickly the pool can refill.",
  },
  setup: defaults({ peakRps: 30_000, warmPoolSize: 0, coldStartSeconds: 240, rampSeconds: 15 }),
  runFor: 45,
  observe: [
    "The fleet starts with capacity for the 9k rps baseline and no warm reserve.",
    "Demand reaches 30k rps in 15 seconds while cold instances are still initializing.",
    "Utilization passes 99%, p99 runs into seconds, and the fleet sheds more than a third of demand.",
    "The pool is not the only lever: the cold-start time sets how long any pool shortfall lasts.",
  ],
  explain:
    "A warm pool is a buffer against the part of the ramp that arrives before cold capacity can. Its useful size is the gap at the steepest part of the ramp, not the peak. If the ramp is faster than the pool can refill, pre-scaling or admission control has to cover the remainder. Adding pool capacity after the ramp starts is too late for that ramp.",
  fix: defaults({ peakRps: 30_000, warmPoolSize: 16, coldStartSeconds: 45, rampSeconds: 20 }),
  debrief:
    "Sixteen warm instances cover the jump from the baseline to most of the 30k peak, and the remaining cold instances arrive before the fleet saturates. The cost is 16 instances held ready through the quiet period. A pool of 24 would cover more of the peak but spend more hours idle; a pool of zero spends the least and misses the ramp. The trade is idle capacity against time-to-capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A warm pool is a set of pre-initialized instances kept outside the serving fleet. When the autoscaling group needs capacity, it takes instances from the pool instead of launching from scratch. The instance still has to be attached and registered, but it skips the slow part: boot, image pull, agent start, and application initialization. EC2 Auto Scaling supports warm pools with a configurable pool size and lifecycle hooks; the pool can hold running or stopped instances depending on how it is configured.",
  },
  {
    type: "p",
    text: "The pool is a time buffer, not extra peak capacity. It helps only while it holds instances. A pool of ten covers the first ten instances of a scale-out; the eleventh waits for a cold start. If demand ramps faster than the pool can refill, the pool empties and the service is back to cold-start latency with less headroom than before. The useful size is set by the gap between the capacity at the start of the ramp and the capacity needed at the peak, divided by how much of that gap the pool can cover before it drains.",
  },
  {
    type: "p",
    text: "Warm capacity is billed capacity. Running warm instances cost the same as running serving instances; stopped warm instances avoid compute charges but can still incur storage charges for their volumes. That is the trade: pay for readiness during quiet periods, or pay with a slower scale-out during the ramp. The pool should shrink when the ramp is over and grow before the next known ramp.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pool sits between the scaling policy and the fleet. The policy decides the desired count; the pool decides how much of the increase is instant and how much is cold. The load balancer sees only the instances that are in service, so a full pool does not help until its instances are attached and healthy. That attachment step belongs in the time-to-capacity measurement.",
  },
  {
    type: "table",
    headers: ["Pool state", "Time to serve", "Cost while idle", "Best use"],
    rows: [
      ["Running and initialized", "Seconds to attach and register", "Full instance cost", "Steep, short ramps"],
      ["Stopped but initialized", "Boot time, no full image pull", "Storage cost for volumes", "Medium ramps with predictable timing"],
      ["No pool", "Full cold start", "No idle cost", "Flat or slowly changing demand"],
      ["Pool larger than the ramp gap", "Instant for the covered part", "Pays for unused instances", "Only when the peak is long and narrow"],
    ],
  },
  {
    type: "p",
    text: "The model uses 1,200 rps per instance, a 70% target, a 30% baseline, and a pool that refills at the cold-start rate. Those are teaching values, not AWS quotas or instance benchmarks. The pool is consumed before cold launches are counted, so the chart separates the instant part of scale-out from the slow part. The pool size is capped at 30 so the idle-cost signal stays visible.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Fleet utilization and error rate through the ramp.",
      "Idle warm capacity and warm instances ready, which show the pool draining and refilling.",
      "Cold-start lag, the time an instance still needs before it can serve.",
      "In-service capacity, so desired capacity and actual capacity stay separate.",
      "p99 latency, which rises while the fleet waits for the next instance.",
      "A flow from client to load balancer to fleet to warm pool to cold launches.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply No pool, fast ramp. Watch the pool drain in Peak with a slow refill and compare it with Recovery. Run the guided experiment before changing sliders. Then apply Pool sized for the peak and watch idle warm capacity rise while the service stays healthy: that is the cost side of the same decision.",
  },
  { type: "sim", simId: "warm-pools" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet started with capacity for the 9k rps baseline and no warm reserve. Demand reached 30k rps in 15 simulated seconds. The autoscaler asked for more instances immediately, but each cold instance needed 240 seconds of launch and initialization before it could serve. Utilization passed 99%, p99 ran into seconds, and the fleet shed about a third of demand. The scaling policy was not late. The capacity was.",
  },
  {
    type: "p",
    text: "In Recovery, sixteen warm instances covered most of the jump and a 45-second cold start handled the remainder. The service stayed inside its target, and the pool was empty by the time the peak arrived. In Pool sized for the peak, the service was also healthy, but roughly 20 warm instances sat idle against a 10k rps workload. Both are valid choices for different traffic shapes; only one matches a flat day.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Auto Scaling activity history: warm pool size, instances taken from the pool, and instances launched cold.",
      "Pool metrics: available warm instances and the age of the oldest warm instance.",
      "Instance lifecycle: launch, initialization hook, in-service, and termination timestamps.",
      "Load balancer: healthy host count during the ramp, plus 5xx and target response time.",
      "Cost: instance-hours for serving and warm capacity, split by pool state.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the ramp duration with the cold-start time and the pool size. If the pool emptied before the peak, the gap is the pool size; if the pool stayed full and the service still failed, the cold-start path or the attachment step is the problem. Then check whether the pool is oversized for the rest of the day.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure time-to-capacity from the scaling decision to the first served request, not from the API call.",
      "Size the pool to the ramp gap: capacity at peak minus capacity at ramp start, minus what cold starts can deliver in time.",
      "Move slow initialization into a lifecycle hook so warm instances are useful when they leave the pool.",
      "Schedule pool growth before known ramps and pool shrinkage after them.",
      "Keep headroom for the loss of one pool instance or one Availability Zone.",
      "Test with the real ramp shape, including a ramp that starts before the pool refills.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger pool shortens scale-out and bills for idle capacity through the quiet period.",
      "A smaller pool saves money and shifts the risk to the steepest ramp.",
      "Running warm instances are ready fastest and cost the most; stopped instances cost less and still need boot time.",
      "A lifecycle hook moves initialization earlier, but a hook that is slow or unreliable makes the pool look warm while instances are not ready.",
      "Pre-scaling is cheaper than a permanent pool when the ramp is predictable, and useless when it is not.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "size-pool",
    question:
      "How would you decide the size of a warm pool for a service with a sharp morning ramp?",
    difficulty: 3,
    hints: [
      "Start from the capacity gap during the ramp, not from peak demand.",
      "The pool refills at the cold-start rate.",
    ],
    answer:
      "I would measure the demand curve, the time from scale-out decision to first served request, and the pool refill rate. The pool has to cover the capacity gap that cold starts cannot close before demand arrives. If the ramp adds 20 instances in two minutes and a cold instance takes four minutes, the pool needs to cover most of those 20, not the whole day's peak. I would add margin for a failed instance or zone, then schedule the pool to shrink after the ramp so it does not sit idle all day.",
    followUps: [
      "How does a stopped pool change the calculation?",
      "What happens if the ramp starts earlier than expected?",
      "How would you measure whether the pool was worth its cost?",
    ],
    redFlags: [
      "Sizes the pool to peak demand.",
      "Ignores cold-start time.",
      "Treats the pool as free capacity.",
    ],
    rubric: [
      "Uses the ramp gap.",
      "Accounts for cold-start and refill time.",
      "Adds failure margin.",
      "Addresses idle cost.",
    ],
  },
  {
    id: "pool-empty",
    question:
      "The warm pool is full before the ramp, yet latency still spikes. What do you check?",
    difficulty: 3,
    hints: [
      "A warm instance is not the same as a serving instance.",
      "The pool can be full and the fleet can still be short.",
    ],
    answer:
      "I would check whether the pool instances were actually attached, registered, and passing health checks before the ramp, and whether the pool was large enough for the gap rather than just full at the start. A full pool of five cannot cover a gap of twenty. I would also check whether the lifecycle hook or initialization step failed, whether the load balancer was slow to register targets, and whether the autoscaler was blocked by a maximum, a cooldown, or a quota. The pool size and the pool readiness are separate signals.",
    followUps: [
      "How do you measure pool readiness?",
      "What if the pool drained and refilled during the ramp?",
      "Which signal tells you the pool was too small?",
    ],
    redFlags: [
      "Assumes a full pool is enough.",
      "Looks only at pool size.",
      "Ignores registration and health checks.",
    ],
    rubric: [
      "Separates pool size from readiness.",
      "Checks attachment and health.",
      "Compares gap with pool size.",
      "Checks autoscaling limits.",
    ],
  },
  {
    id: "idle-cost",
    question:
      "Finance asks why the warm pool runs all night. How do you justify or change it?",
    difficulty: 3,
    hints: [
      "The pool is insurance for a specific ramp, not for the whole day.",
      "Cost should track the ramp schedule.",
    ],
    answer:
      "I would show the ramp timing and the cost of the pool during the hours it is actually needed. If the morning ramp is the only steep one, the pool can be smaller overnight and grown on a schedule before the ramp. I would compare the idle instance-hours with the cost of the last ramp miss and the SLO exposure. If the pool is sized for a peak that only occurs once a quarter, a smaller pool plus pre-scaling may be cheaper. The decision is a trade between idle cost and time-to-capacity, not a choice between free and safe.",
    followUps: [
      "How would you schedule pool growth?",
      "What metric would you show finance?",
      "When would you remove the pool entirely?",
    ],
    redFlags: [
      "Calls the pool free because it is not serving.",
      "Sizes for the annual peak every day.",
      "Has no ramp schedule.",
    ],
    rubric: [
      "Quantifies idle instance-hours.",
      "Ties pool size to ramp timing.",
      "Compares with outage cost.",
      "Proposes scheduling or pre-scaling.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Cold-start time is measured from launch to first served request, including initialization hooks.",
      "The pool size is derived from the ramp gap, not from peak demand.",
      "Pool readiness, not just pool size, is on the dashboard.",
      "Pool growth and shrinkage are scheduled around known ramps.",
      "The autoscaling maximum and quota leave room for the pool to matter.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the pool emptied before the peak or was never ready.",
      "Compare the ramp duration with the cold-start time.",
      "Check target registration and health checks for pool instances.",
      "Add capacity from another path if the cold-start path cannot recover in time.",
      "Record pool size, available warm instances, and time-to-capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Resize the pool to the observed ramp gap and add failure margin.",
      "Fix the slow initialization step or move it into a lifecycle hook.",
      "Shrink the pool outside the ramp window.",
      "Re-test with a ramp that starts before the pool refills.",
    ],
  },
];

const references = [
  {
    title: "Decrease latency for applications with long boot times using warm pools",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-warm-pools.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Warm pools keep pre-initialized instances ready to reduce scale-out latency.",
  },
  {
    title: "Warm pool lifecycle hooks",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/warm-pool-lifecycle-hooks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Lifecycle hooks let instances finish initialization before they leave the pool.",
  },
  {
    title: "Instance reuse policy for warm pools",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/warm-pool-instance-reuse.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The reuse policy controls whether instances return to the pool or are terminated.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "warm-pools": {
      model: warmPoolsModel,
      presets,
      instructions:
        "Start healthy, apply No pool, fast ramp, then compare Peak with a slow refill and Recovery. Watch idle warm capacity, cold-start lag, and error rate together.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Instance throughput, pool sizes, and timings are teaching values, not AWS quotas or benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-fargate-cold-start",
    "capacity-autoscaling-policies",
    "capacity-scheduled-scaling",
    "capacity-headroom-cost",
  ],
};
