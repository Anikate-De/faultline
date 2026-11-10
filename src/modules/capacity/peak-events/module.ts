import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const EVENT_AT = 30;
const RAMP_SECONDS = 12;
const BASELINE_RPS = 5_000;
const CAP_PER_INSTANCE = 300;
const TARGET_UTIL = 0.6;
const INITIAL_INSTANCES = 24;
const WARMUP_SECONDS = 6;
const REACT_DELAY = 10;
const REACT_RATE = 4;
const CHANGE_DERATE = 0.85;
const HOURS_PER_MONTH = 730;
const COST_PER_INSTANCE_HOUR = 0.042;

const params = [
  {
    id: "forecastMultiplier",
    label: "Forecast peak",
    min: 2,
    max: 15,
    step: 0.5,
    value: 8,
    unit: "× baseline",
    group: "Forecast",
    help: "Event peak as a multiple of the 5,000 rps baseline. The forecast is the input to every capacity decision.",
    format: "number" as const,
  },
  {
    id: "preScaleLeadMin",
    label: "Pre-scale lead",
    min: 0,
    max: 60,
    step: 5,
    value: 20,
    unit: " min",
    group: "Plan",
    help: "Minutes before the event when pre-scaling starts. Zero means reactive scaling only. New capacity needs six minutes to warm.",
    format: "number" as const,
  },
  {
    id: "loadTestCoveragePct",
    label: "Load test coverage",
    min: 0,
    max: 100,
    step: 10,
    value: 100,
    unit: "%",
    group: "Plan",
    help: "Share of the forecast peak the test actually exercised. Untested limits can reduce usable capacity above that level.",
    format: "percent" as const,
  },
  {
    id: "changeFreeze",
    label: "Change freeze",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Plan",
    help: "1 freezes risky changes before the event. 0 models a last-minute change that removes 15% of usable capacity.",
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
  desiredInstances: number;
  instances: number;
  capacity: number;
  utilization: number;
  errors: number;
  p99: number;
  coverageDerate: number;
  freezeDerate: number;
  monthlyCost: number;
}

function compute(p: Params, t: number): Computed {
  const multiplier = Math.max(1, num(p, "forecastMultiplier", 8));
  const peakRps = BASELINE_RPS * multiplier;
  const progress = t <= EVENT_AT ? 0 : smoothstep((t - EVENT_AT) / RAMP_SECONDS);
  const demand = BASELINE_RPS + (peakRps - BASELINE_RPS) * progress;
  const desiredInstances = Math.ceil(peakRps / (CAP_PER_INSTANCE * TARGET_UTIL));
  const lead = Math.max(0, num(p, "preScaleLeadMin", 20));
  const coverage = clamp(num(p, "loadTestCoveragePct", 100), 0, 100);
  const coverageDerate = coverage < 100 && demand > peakRps * (coverage / 100)
    ? 0.75 + 0.25 * (coverage / 100)
    : 1;
  const freezeDerate = num(p, "changeFreeze", 1) >= 0.5 || t < EVENT_AT - 4 ? 1 : CHANGE_DERATE;
  let instances = INITIAL_INSTANCES;
  if (lead > 0) {
    const readyAt = Math.max(0, EVENT_AT - lead) + WARMUP_SECONDS;
    if (t >= readyAt) instances = desiredInstances;
  } else {
    const reactiveStart = EVENT_AT + REACT_DELAY;
    instances = Math.min(desiredInstances, INITIAL_INSTANCES + Math.max(0, t - reactiveStart) * REACT_RATE);
  }
  const capacity = instances * CAP_PER_INSTANCE * coverageDerate * freezeDerate;
  const utilization = demand / Math.max(1, capacity);
  const errors = Math.max(0, ((demand - capacity) / Math.max(1, demand)) * 100);
  const p99 =
    utilization <= 1
      ? 60 * (1 + (3 * Math.pow(utilization, 8)) / Math.max(0.15, 1.05 - utilization))
      : Math.min(15_000, 60 * 21 + (utilization - 1) * 4_000);
  return {
    peakRps,
    demand,
    desiredInstances,
    instances,
    capacity,
    utilization,
    errors,
    p99,
    coverageDerate,
    freezeDerate,
    monthlyCost: instances * HOURS_PER_MONTH * COST_PER_INSTANCE_HOUR,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.errors >= 5 || values.utilization >= 0.9 || values.p99 >= 800) return "crit";
  if (values.errors >= 1 || values.utilization >= 0.7 || values.p99 >= 300) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, t: number): SimFrame {
  const values = compute(p, t);
  const health = healthFor(values);
  return {
    t: 0,
    nodes: [
      {
        id: "event",
        label: "Event traffic",
        kind: "client",
        health: "ok",
        utilization: clamp(values.demand / values.peakRps),
        sublabel: `${Math.round(values.demand).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: health === "crit" ? "crit" : health === "warn" ? "warn" : "ok",
        utilization: clamp(values.utilization),
        sublabel: `${values.errors.toFixed(0)}% errors`,
        meta: { view: "flow" },
      },
      {
        id: "fleet",
        label: "Event fleet",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(values.utilization),
        throughput: Math.min(values.demand, values.capacity),
        capacity: values.capacity,
        sublabel: `${Math.round(values.instances)} instances · ${values.desiredInstances} planned`,
        detail: `${Math.round(values.instances)} instances carry ${Math.round(values.capacity).toLocaleString("en-US")} rps against ${Math.round(values.demand).toLocaleString("en-US")} rps demand. Forecast peak is ${Math.round(values.peakRps).toLocaleString("en-US")} rps; test coverage is ${num(p, "loadTestCoveragePct", 100)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "Shared database",
        kind: "db",
        health: clamp(values.demand / 60_000) >= 0.9 ? "warn" : "ok",
        utilization: clamp(values.demand / 60_000),
        throughput: Math.min(values.demand, values.capacity),
        sublabel: `${Math.round(values.demand).toLocaleString("en-US")} rps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("event-lb", "event", "lb", clamp(values.demand / values.peakRps), "ok"),
      edge("lb-fleet", "lb", "fleet", clamp(values.demand / values.peakRps), health),
      edge("fleet-db", "fleet", "db", clamp(values.demand / 60_000), health === "crit" ? "warn" : health),
    ],
    metrics: [
      metric("error-rate", "Error rate", values.errors, "%", 1, 5, "percent"),
      metric("utilization", "Peak utilization", values.utilization * 100, "%", 70, 90, "percent"),
      metric("p99-latency", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("capacity-instances", "In-service instances", values.instances, " instances", undefined, undefined, "count"),
      metric("test-coverage", "Load test coverage", num(p, "loadTestCoveragePct", 100), "%", undefined, undefined, "percent"),
      metric("monthly-cost", "Event-month compute", values.monthlyCost / 1_000, " k$", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      eventStart: 0,
      preScaleEvent: 0,
      freezeEvent: 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(values.instances)} instances carry ${Math.round(values.capacity).toLocaleString("en-US")} rps against a ${Math.round(values.peakRps).toLocaleString("en-US")} rps forecast; ${values.errors.toFixed(1)}% errors.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 6)) / 2.8))),
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
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The event traffic exceeds available capacity",
    cause:
      "Demand arrived before enough capacity was warm, or untested limits reduced the usable capacity. Reactive scaling cannot close the gap fast enough when the ramp is shorter than the launch and warm-up time.",
    fix:
      "Restore capacity or shed low-value traffic deliberately. For the next event, pre-scale from the tested requirement and keep reactive policies as a backstop, not as the primary plan.",
    checkFirst: [
      "Compare event demand with in-service capacity and the plan.",
      "Check whether pre-scaling ran and when new instances became healthy.",
      "Check whether a change or an untested limit reduced capacity.",
    ],
  },
  {
    id: "utilization",
    metricId: "utilization",
    warn: 70,
    crit: 90,
    title: "Event capacity is running at the queueing knee",
    cause:
      "The fleet is close to its tested capacity, or a derate removed headroom. Latency rises nonlinearly here, so a small additional burst can turn saturation into errors.",
    fix:
      "Pre-scale above the forecast with the failure-domain reserve, and keep a tested load-shedding policy for the remaining gap.",
    checkFirst: [
      "Check forecast versus tested capacity.",
      "Check whether the change freeze held.",
      "Check the dependency headroom behind the fleet.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "Event latency is breaching the SLO",
    cause:
      "Requests are queueing behind a fleet that is below demand or still warming. The tail rises before the error rate when the fleet is merely saturated.",
    fix:
      "Add capacity or shed load, then verify the dependency is not the next bottleneck. Do not rely on retries; they add load to an already saturated path.",
    checkFirst: [
      "Check p99 by target group and by dependency.",
      "Check instance launch and readiness times.",
      "Check whether retries are amplifying the load.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const peakEventsModel: SimModel = {
  id: "capacity-peak-events",
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
    let eventStart = frame.flags.eventStart === 1;
    let preScaleEvent = frame.flags.preScaleEvent === 1;
    let freezeEvent = frame.flags.freezeEvent === 1;

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    const lead = Math.max(0, num(p, "preScaleLeadMin", 20));
    const readyAt = Math.max(0, EVENT_AT - lead) + WARMUP_SECONDS;
    if (lead > 0 && t >= readyAt && !preScaleEvent) {
      pushEvent(next, {
        id: "prescale-ready",
        at: t,
        severity: "info",
        title: "Pre-scaled capacity is warm",
        detail: `${values.desiredInstances} instances are in service, ${Math.round(readyAt)} simulated minutes after the pre-scale started. The event begins at ${EVENT_AT}.`,
        nodeId: "fleet",
        metricId: "capacity-instances",
      });
      preScaleEvent = true;
    }

    if (num(p, "changeFreeze", 1) < 0.5 && t >= EVENT_AT - 4 && !freezeEvent) {
      pushEvent(next, {
        id: "freeze-broken",
        at: t,
        severity: "warn",
        title: "A last-minute change reduced usable capacity",
        detail: `The change freeze was not in effect. Usable capacity is ${Math.round(values.capacity).toLocaleString("en-US")} rps after the change, against ${Math.round(values.demand).toLocaleString("en-US")} rps of demand.`,
        nodeId: "fleet",
        metricId: "utilization",
      });
      freezeEvent = true;
    }

    if (t >= EVENT_AT && !eventStart) {
      const gap = Math.max(0, ((values.peakRps - values.capacity) / Math.max(1, values.peakRps)) * 100);
      pushEvent(next, {
        id: "event-start",
        at: t,
        severity: gap >= 25 ? "crit" : gap >= 10 ? "warn" : "info",
        title: "The peak event has started",
        detail: `Forecast peak is ${Math.round(values.peakRps).toLocaleString("en-US")} rps. Current capacity is ${Math.round(values.capacity).toLocaleString("en-US")} rps, a ${gap.toFixed(0)}% gap against the forecast.`,
        nodeId: "fleet",
        metricId: "error-rate",
      });
      eventStart = true;
    }

    next.flags.eventStart = eventStart ? 1 : 0;
    next.flags.preScaleEvent = preScaleEvent ? 1 : 0;
    next.flags.freezeEvent = freezeEvent ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `The event fleet has ${value("capacity-instances").toFixed(0)} instances at ${value("utilization").toFixed(0)}% utilization; errors are ${value("error-rate").toFixed(1)}%.`,
    ];
    if (value("error-rate") >= 1) {
      items.push(
        "Capacity arrived after demand. Pre-scale from the tested requirement, then keep reactive scaling as a backstop rather than the plan.",
      );
    }
    if (value("test-coverage") < 100) {
      items.push(
        `The load test covered ${value("test-coverage").toFixed(0)}% of the forecast. The untested remainder is where limits and derates hide.`,
      );
    }
    items.push("The event plan is a sequence: forecast, test, pre-scale, freeze, staff, and a rollback path.");
    return items;
  },
  legend: [
    { label: "Ready", tone: "ok" },
    { label: "Tight", tone: "warn" },
    { label: "Shedding", tone: "crit" },
    { label: "No capacity", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 6× event, fully tested, pre-scaled 20 minutes ahead, with a change freeze.",
    tone: "ok",
    params: defaults({ forecastMultiplier: 6, preScaleLeadMin: 20, loadTestCoveragePct: 100, changeFreeze: 1 }),
  },
  {
    id: "peak",
    label: "Tight",
    description: "An 8× event with 40% test coverage and 15 minutes of lead; capacity is tight but still serving.",
    tone: "warn",
    params: defaults({ forecastMultiplier: 8, preScaleLeadMin: 15, loadTestCoveragePct: 40, changeFreeze: 1 }),
  },
  {
    id: "failure",
    label: "Reactive plan",
    description: "No pre-scale, 40% test coverage, and no freeze; reactive capacity arrives after the event ramp.",
    tone: "crit",
    params: defaults({ forecastMultiplier: 8, preScaleLeadMin: 0, loadTestCoveragePct: 40, changeFreeze: 0 }),
  },
  {
    id: "recovery",
    label: "Planned event",
    description: "A 10× event, fully tested, pre-scaled 30 minutes ahead, with the freeze in place.",
    tone: "ok",
    params: defaults({ forecastMultiplier: 10, preScaleLeadMin: 30, loadTestCoveragePct: 100, changeFreeze: 1 }),
  },
  {
    id: "tested-only",
    label: "Tested, not pre-scaled",
    description: "The test covered the full forecast, but reactive scaling still arrives after the event begins.",
    tone: "crit",
    params: defaults({ forecastMultiplier: 8, preScaleLeadMin: 0, loadTestCoveragePct: 100, changeFreeze: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-event-readiness",
  title: "Predict the highest-value action before the event",
  simId: "peak-events",
  question:
    "The event is in 14 days. The load test reached 40% of the forecast and passed. What should you do first?",
  prediction: {
    options: [
      { id: "forecast", label: "Raise the forecast by another 20%" },
      { id: "test", label: "Complete a full-scale test, fix the limits it finds, then pre-scale" },
      { id: "oncall", label: "Add more on-call engineers for the event" },
      { id: "freeze", label: "Enable the change freeze" },
    ],
    correctOptionId: "test",
    explanation:
      "A test at 40% of the forecast never exercises the limits that appear above that level: connection pools, quotas, cache behavior, and dependency saturation. Completing the test is the action that turns the forecast into a measured capacity number. The freeze and the on-call staff are still needed, but they do not create capacity. Raising the forecast without testing only widens the unknown.",
  },
  setup: defaults({ forecastMultiplier: 8, preScaleLeadMin: 0, loadTestCoveragePct: 40, changeFreeze: 0 }),
  runFor: 75,
  observe: [
    "No pre-scale is running, so the event starts with 24 instances against a 40,000 rps forecast.",
    "Errors cross the critical threshold during the ramp, before reactive capacity catches up.",
    "At 60 seconds the reactive fleet is still below demand; the 40% test never proved the rest.",
  ],
  explain:
    "Reactive scaling waits for utilization to rise, then waits for the reaction delay and warm-up. The event ramp is shorter than that chain, so the fleet is always behind. A partial test leaves the upper 60% of the forecast unmeasured, and an unfrozen change can remove capacity at the worst moment. The fix is to finish the test, pre-scale from the measured requirement, and freeze changes.",
  fix: defaults({ forecastMultiplier: 8, preScaleLeadMin: 30, loadTestCoveragePct: 100, changeFreeze: 1 }),
  debrief:
    "The forecast peak is 40,000 rps. At 300 rps per instance and a 60% target, the plan needs 223 instances, or about 66,900 rps of capacity. Pre-scaling 30 minutes ahead makes that capacity warm before the event, so the event runs at 60% utilization. The test at 40% only proved 16,000 rps. The difference is the unknown that becomes an incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Peak event planning is capacity work with a deadline. A marketing launch, a sale, a live stream, or a migration cutover gives you a date and an estimated demand multiple. The plan works backward from that date: forecast the peak, model the capacity, test at the scale you intend to serve against the service-level objective (SLO), pre-scale before the ramp, freeze risky changes, staff the response, and agree on a rollback and load-shedding path.",
  },
  {
    type: "p",
    text: "The central mistake is treating reactive autoscaling as the plan. Reactive scaling has a chain of delays: the metric must move, the alarm must fire, the instances must launch, and the new capacity must warm before it serves. A short event ramp can be over before that chain completes. Pre-scaling moves the capacity into place before the demand arrives. The test is what tells you how much capacity is actually usable, because untested limits and dependencies can derate the fleet at the worst moment.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is event traffic, load balancer, event fleet, and shared dependencies. The fleet has a tested capacity per instance and a warm-up time. The load balancer can only send traffic to healthy targets. The database and other dependencies see the same peak and may saturate before the fleet does. The plan has to cover the whole path, not only the instance count.",
  },
  {
    type: "table",
    headers: ["When", "Action", "Evidence it produces", "What it prevents"],
    rows: [
      ["Two weeks out", "Forecast and capacity model", "Peak rps, instance count, dependency headroom", "Planning from a guess"],
      ["One to two weeks out", "Full-scale load test", "Measured knee, limits, warm-up time", "Discovering the limit on event day"],
      ["Days out", "Pre-scale and reserve dependencies", "Warm capacity before the ramp", "Reactive scaling arriving late"],
      ["Day before", "Change freeze and rollback check", "Stable configuration, known rollback", "A last-minute change removing capacity"],
      ["Event day", "Staff, watch, and shed if needed", "Fast detection and a deliberate degradation", "Panic changes during the peak"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Reactive plan and watch the event ramp outrun the autoscaler. Compare Tested, not pre-scaled to see why a test alone is not enough. Run the experiment before changing sliders. Each simulated second represents one minute; capacity, warm-up, and prices are illustrative.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Error rate, peak utilization, and p99 latency (the 99th-percentile response time) as the event ramp arrives.",
      "In-service instances against the planned count, so the pre-scale gap is visible.",
      "Load test coverage, which shows how much of the forecast was actually exercised.",
      "A flow view from event traffic to load balancer, fleet, and shared database.",
    ],
  },
  { type: "sim", simId: "peak-events" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The reactive plan started the event with 24 instances, or 7,200 rps of capacity, against a 40,000 rps forecast. The event ramp was shorter than the autoscaler's reaction delay plus warm-up, so capacity arrived after demand. The 40% test had only proved 16,000 rps, and the missing change freeze removed another 15% of usable capacity. Errors crossed the critical threshold during the ramp and were still elevated at 60 seconds.",
  },
  {
    type: "p",
    text: "The planned event shows the opposite sequence. The full test measured the requirement, pre-scaling put 223 instances in service before the event, and the freeze kept the configuration stable. The event ran at about 60% utilization instead of shedding traffic. The capacity cost is real, but it is bounded and known before the event instead of discovered during it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "In-service capacity below the plan at the moment the event starts, with instances still pending or warming.",
      "Error rate and p99 rising together during the ramp, before the autoscaler's next action.",
      "Connection pool, quota, or dependency limits appearing only above the level the test reached.",
      "A deploy or configuration change in the event window that reduces capacity or changes behavior.",
      "On-call load rising because the response plan depends on manual changes during the peak.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare event demand with in-service capacity and the plan. Check whether pre-scaling ran and when instances became healthy. Then check whether the test covered the forecast and whether a change slipped into the window.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Finish the load test to the forecast peak, including dependencies and the production traffic mix.",
      "Fix the limits the test finds before the event, then re-test the changed path.",
      "Pre-scale from the measured requirement with enough lead for warm-up, and keep reactive scaling as a backstop.",
      "Freeze risky changes before the event and confirm the rollback path works.",
      "Staff the event with a named incident commander, a capacity owner, and a communications path.",
      "Agree on load shedding and a rollback trigger before the peak, not during it.",
      "Scale down after the event with the same care; a fast scale-down can cause a second incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Pre-scaling costs money before the event and removes the race between demand and warm-up.",
      "A full-scale test is the strongest evidence and carries the largest blast radius if the environment is shared.",
      "A change freeze reduces risk and blocks urgent fixes; it needs an owner who can make an exception.",
      "Extra on-call staff improve response but cannot substitute for capacity or a rollback path.",
      "Aggressive load shedding protects the core path and rejects some legitimate traffic.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "plan-event",
    question: "A marketing event will send 10× traffic in two weeks. How do you plan for it?",
    difficulty: 3,
    hints: [
      "Work backward from the event date.",
      "The test is what turns the forecast into a capacity number.",
    ],
    answer:
      "I would start with the forecast and a capacity model: peak rps, service time, dependency headroom, and the failure domain. Then I would run a full-scale load test at the forecast with a production-like mix, fix the limits it finds, and re-test. I would pre-scale with enough lead for warm-up, freeze risky changes, and staff the event with an incident commander and a capacity owner. Before the event I would confirm the rollback path and the load-shedding policy, and after the event I would scale down carefully.",
    followUps: [
      "What would you do if the test cannot reach 10×?",
      "Which dependency would you check first?",
      "How would you decide to abort the event?",
    ],
    redFlags: [
      "Relies on reactive autoscaling.",
      "Tests only the happy path.",
      "Has no rollback or shedding plan.",
    ],
    rubric: [
      "Forecasts and models capacity.",
      "Tests at the forecast scale.",
      "Pre-scales and freezes.",
      "Plans staffing, rollback, and shedding.",
    ],
  },
  {
    id: "partial-test",
    question: "The load test passed at 40% of the forecast. Do you proceed with the event?",
    difficulty: 3,
    hints: [
      "The untested range is where new limits appear.",
      "A forecast without evidence is still a guess.",
    ],
    answer:
      "Not as the primary evidence. A test at 40% proves the service at 40%; it does not exercise the connection pools, quotas, cache behavior, or dependency saturation that appear above that level. I would either complete the test to the forecast or cap the event traffic at the tested level, then pre-scale and freeze. If neither is possible, I would treat the event as an experiment with a lower traffic cap and a rollback trigger, not as a capacity-certified launch.",
    followUps: [
      "How would you cap the traffic?",
      "What would you monitor during the event?",
      "When would you stop the event?",
    ],
    redFlags: [
      "Treats 40% as representative.",
      "Ignores the untested limits.",
      "Has no traffic cap or rollback.",
    ],
    rubric: [
      "Explains what the partial test missed.",
      "Proposes a full test or a cap.",
      "Includes pre-scale and freeze.",
      "Defines a rollback trigger.",
    ],
  },
  {
    id: "sequence",
    question: "What has to happen in the last 48 hours before a peak event?",
    difficulty: 2,
    hints: [
      "The capacity should already be tested by then.",
      "The last 48 hours are about stability, not new capacity.",
    ],
    answer:
      "By the last 48 hours the capacity should already be tested and the plan agreed. I would pre-scale or confirm the scheduled scaling, reserve dependency capacity, freeze risky changes, verify the rollback path, and brief the on-call team on the incident commander, capacity owner, and load-shedding triggers. I would also check that dashboards and alerts show event demand, in-service capacity, errors, and dependency saturation. The last 48 hours are for stability and readiness, not for discovering a new bottleneck.",
    followUps: [
      "What would make you delay the event?",
      "How do you handle an urgent security fix during the freeze?",
      "When do you scale back down?",
    ],
    redFlags: [
      "Starts the load test in the last 48 hours.",
      "Makes a large change right before the event.",
      "Has no named owner.",
    ],
    rubric: [
      "Pre-scale and freeze.",
      "Verifies rollback and staffing.",
      "Checks dashboards and alerts.",
      "Keeps the window stable.",
    ],
  },
];

const checklist = [
  {
    title: "Two weeks before",
    items: [
      "The forecast peak and the demand shape are agreed with the event owner.",
      "A capacity model covers the fleet, dependencies, and the largest failure domain.",
      "A full-scale load test is scheduled with a production-like mix.",
      "Pre-scaling, freeze, staffing, rollback, and load-shedding owners are named.",
    ],
  },
  {
    title: "Before the event",
    items: [
      "The load test reached the forecast and the limits it found are fixed.",
      "Pre-scaling is scheduled with enough lead for warm-up.",
      "The change freeze is in effect and the rollback path is verified.",
      "Dashboards show event demand, in-service capacity, errors, and dependency saturation.",
    ],
  },
  {
    title: "During and after",
    items: [
      "Watch in-service capacity against the plan at the start of the ramp.",
      "Use the agreed shedding policy before retries amplify the load.",
      "Record the peak, the first bottleneck, and the decisions taken.",
      "Scale down gradually and review the plan against what actually happened.",
    ],
  },
];

const references = [
  {
    title: "Google SRE Workbook: Managing Load",
    url: "https://sre.google/workbook/managing-load/",
    publisher: "Google",
    kind: "book" as const,
    note: "Capacity planning, load testing, and the limits of reactive autoscaling.",
  },
  {
    title: "Amazon EC2 Auto Scaling: scheduled scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-scheduled-scaling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Scheduled actions set capacity at a known time; useful for pre-scaling before an event.",
  },
  {
    title: "AWS Well-Architected: Reliability Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Failure-domain capacity, static stability, and operating readiness for planned peaks.",
  },
  {
    title: "AWS Builders' Library: Ensuring rollback safety during deployments",
    url: "https://aws.amazon.com/builders-library/ensuring-rollback-safety-during-deployments/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Why a rollback path must be tested before the window where it is needed.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "peak-events": {
      model: peakEventsModel,
      presets,
      instructions:
        "Start Healthy, then apply Reactive plan and watch the event ramp outrun the autoscaler. Compare Tested, not pre-scaled, then Recovery. Run the experiment before changing sliders.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Each simulated second represents one minute of event planning. Instance capacity, warm-up, derates, and prices are teaching values, not AWS quotas or benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-capacity-models",
    "capacity-scheduled-scaling",
    "capacity-warm-pools",
    "case-composite-peak-race",
  ],
};
