import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Production request rate",
    min: 4_000,
    max: 40_000,
    step: 1_000,
    value: 12_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second at full production traffic. The canary receives only its share of this rate.",
    format: "rps",
  },
  {
    id: "canaryShare",
    label: "Canary traffic share",
    min: 1,
    max: 20,
    step: 1,
    value: 5,
    unit: "%",
    group: "Rollout",
    help: "Share of production traffic sent to the canary. The full rollout sends 100%.",
    format: "percent",
  },
  {
    id: "sharedCapacity",
    label: "Shared resource capacity",
    min: 2_000,
    max: 40_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Capacity",
    help: "Safe request-equivalent capacity of the resource that scales with total traffic, such as a connection pool, cache, or downstream quota.",
    format: "rps",
  },
  {
    id: "scalePenalty",
    label: "Extra work at full scale",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Capacity",
    help: "Additional per-request work that appears only at high scale, such as cache misses, lock contention, or a larger working set.",
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
  canaryLoad: number;
  canaryUtil: number;
  fullLoad: number;
  fullUtil: number;
  errorRate: number;
  p99: number;
}

function compute(p: Params): Values {
  const requestRate = Math.max(1, num(p, "requestRate", 12_000));
  const share = clamp(num(p, "canaryShare", 5) / 100, 0.01, 1);
  const capacity = Math.max(1, num(p, "sharedCapacity", 20_000));
  const penalty = clamp(num(p, "scalePenalty", 10) / 100, 0, 1);

  const canaryLoad = requestRate * share;
  const canaryUtil = (canaryLoad / capacity) * 100;
  const fullLoad = requestRate * (1 + penalty);
  const fullUtil = (fullLoad / capacity) * 100;
  const errorRate = Math.min(
    30,
    Math.max(0, fullUtil / 100 - 0.9) * 30 + Math.max(0, canaryUtil / 100 - 0.9) * 10,
  );
  const p99 = Math.min(
    6_000,
    120 + Math.max(0, fullUtil / 100 - 0.7) ** 2 * 4_000 + Math.max(0, canaryUtil / 100 - 0.8) ** 2 * 1_000,
  );

  return { canaryLoad, canaryUtil, fullLoad, fullUtil, errorRate, p99 };
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 0)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const canaryHealth = highHealth(values.canaryUtil, 85, 95);
  const fullHealth = worst(
    highHealth(values.fullUtil, 85, 100),
    highHealth(values.errorRate, 0.5, 2),
    highHealth(values.p99, 300, 800),
  );

  const stageNodes = [
    {
      id: "canary",
      label: "5% canary",
      kind: "service" as const,
      health: canaryHealth,
      utilization: clamp(values.canaryUtil / 100),
      throughput: values.canaryLoad,
      capacity: Math.max(1, num(p, "sharedCapacity", 20_000)),
      sublabel: `${percent(values.canaryUtil)} of shared capacity · ${Math.round(values.canaryLoad).toLocaleString()} rps`,
      detail: `The canary carries ${percent(num(p, "canaryShare", 5))} of traffic, so it touches the shared resource at only a fraction of its full-scale demand.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "full",
      label: "Full rollout projection",
      kind: "service" as const,
      health: fullHealth,
      utilization: clamp(values.fullUtil / 100),
      throughput: values.fullLoad,
      capacity: Math.max(1, num(p, "sharedCapacity", 20_000)),
      sublabel: `${percent(values.fullUtil)} projected · ${percent(values.errorRate)} errors`,
      detail: `At 100%, every request carries the extra scale work. Projected utilization is ${percent(values.fullUtil)} of safe capacity, and modeled errors are ${percent(values.errorRate)}.`,
      meta: { stage: "full", view: "deployment" },
    },
    {
      id: "stable",
      label: "Stable",
      kind: "service" as const,
      health: "ok" as Health,
      utilization: 0.3,
      sublabel: "control group",
      detail: "The stable version is the comparison. It does not carry the new version's scale penalty.",
      meta: { stage: "stable", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "clients", label: "Clients", kind: "client" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "service",
      label: "Service fleet",
      kind: "service" as const,
      health: worst(canaryHealth, fullHealth),
      sublabel: `${Math.round(num(p, "requestRate", 12_000)).toLocaleString()} rps at full`,
      meta: { view: "flow" },
    },
    {
      id: "shared",
      label: "Shared resource",
      kind: "db" as const,
      health: worst(canaryHealth, highHealth(values.fullUtil, 85, 100)),
      utilization: clamp(values.fullUtil / 100),
      sublabel: `canary ${percent(values.canaryUtil)} · full ${percent(values.fullUtil)}`,
      detail: "The shared resource sees the canary share now. The projection is what every request would do at 100%.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-service", "clients", "service", clamp(num(p, "requestRate", 12_000) / 40_000), worst(canaryHealth, fullHealth)),
      edge("service-shared", "service", "shared", clamp(values.fullUtil / 200), highHealth(values.fullUtil, 85, 100)),
    ],
    metrics: [
      metric("canary-utilization", "Canary utilization", values.canaryUtil, "%", undefined, undefined, "percent"),
      metric("full-utilization", "Projected full utilization", values.fullUtil, "%", 85, 100, "percent"),
      metric("error-rate", "New version error rate", values.errorRate, "%", 0.5, 2, "percent"),
      metric("p99-latency", "New version p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), fullUtil: values.fullUtil },
    summary: `Canary ${percent(values.canaryUtil)} · projected full ${percent(values.fullUtil)} · ${percent(values.errorRate)} errors · p99 ${values.p99.toFixed(0)}ms`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 5)) / 2.4);
  for (const [id, value] of [
    ["canary-utilization", values.canaryUtil],
    ["full-utilization", values.fullUtil],
    ["error-rate", values.errorRate],
    ["p99-latency", values.p99],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "full-utilization",
    metricId: "full-utilization",
    warn: 85,
    crit: 100,
    title: "The full rollout would exceed safe capacity",
    cause: "The canary's small traffic share never exercised the shared resource at full demand. A cache working set, connection pool, lock, or downstream quota scales with total traffic, not with the canary share.",
    fix: "Stop promotion. Reduce the per-request work at scale, add capacity, or redesign the shared resource. Gate the next attempt on a load test or a projection at 100% with margin.",
    checkFirst: [
      "Project per-request resource demand onto 100% traffic.",
      "Check cache hit rate, pool utilization, lock waits, and downstream quotas.",
      "Compare canary utilization with projected full utilization, not with the canary's own CPU.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 2,
    title: "The new version is failing under full load",
    cause: "A saturated shared resource is returning timeouts and 5xx responses. The failure appears only when every request carries the new version's work.",
    fix: "Roll back or stop the rollout. Find the resource that saturates first and reduce its load or increase its capacity. Do not infer full-scale behavior from a small-share error rate.",
    checkFirst: [
      "Compare per-version errors at the same timestamp.",
      "Check shared-resource saturation and wait time.",
      "Check whether errors began at the traffic step, not at deploy time.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "Tail latency breaks at full scale",
    cause: "Queueing at the shared resource appears in the tail before the average. At a small share, the queue is short, so the canary looks fast.",
    fix: "Gate on p99 at target load. Reduce the queue or add capacity before promoting; a low-traffic canary p99 is not evidence of full-scale latency.",
    checkFirst: [
      "Check p99 by version at the current traffic share.",
      "Check queue depth and wait time on the shared resource.",
      "Check whether p99 rises with the traffic step.",
    ],
  },
];

export const canaryCapacityModel: SimModel = {
  id: "deployment-canary-capacity",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const resetSeries = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.series = resetSeries
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([seriesKey, value]) => [seriesKey, [...value]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (resetSeries) seedSeries(next, values, seed);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `At ${percent(num(p, "canaryShare", 5))} traffic, the canary uses ${percent(values.canaryUtil)} of shared capacity. At 100%, the projection is ${percent(values.fullUtil)}.`,
    );
    items.push(
      `The full rollout carries ${Math.round(values.fullLoad).toLocaleString()} rps-equivalent, including the ${percent(num(p, "scalePenalty", 10))} extra work that appears at scale.`,
    );
    items.push(
      `Error rate is ${percent(values.errorRate)} and p99 is ${values.p99.toFixed(0)}ms. The canary's own numbers can stay clean while the projection fails.`,
    );
    items.push(
      "A canary is a sample of traffic, not a sample of full-scale capacity. Test the resource that scales with total traffic.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Near capacity", tone: "warn" },
    { label: "Over capacity", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 5% canary with ample shared capacity and a modest scale penalty.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Traffic rises and the full-scale projection enters the warning band while the canary stays quiet.",
    tone: "warn",
    params: defaults({ requestRate: 16_000, canaryShare: 10, sharedCapacity: 20_000, scalePenalty: 10 }),
  },
  {
    id: "failure",
    label: "Full rollout",
    description: "The same build at 100% traffic, where scale work and demand exceed shared capacity.",
    tone: "crit",
    params: defaults({ requestRate: 30_000, canaryShare: 5, sharedCapacity: 20_000, scalePenalty: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Capacity is raised and the scale penalty is reduced before full rollout.",
    tone: "ok",
    params: defaults({ requestRate: 24_000, canaryShare: 5, sharedCapacity: 36_000, scalePenalty: 10 }),
  },
  {
    id: "full-scale-test",
    label: "Full-scale test",
    description: "A 100% canary reveals the capacity failure before users are exposed.",
    tone: "crit",
    params: defaults({ requestRate: 30_000, canaryShare: 100, sharedCapacity: 20_000, scalePenalty: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-canary-capacity",
  title: "Predict why the canary passed at 5%",
  simId: "canary-capacity",
  question:
    "A 5% canary shows normal errors and p99. The full rollout saturates a shared resource. What did the canary fail to exercise?",
  prediction: {
    options: [
      { id: "capacity", label: "The shared resource at full-scale demand" },
      { id: "errors", label: "The new version's error handling" },
      { id: "artifact", label: "The artifact's identity" },
      { id: "samples", label: "The canary's sample size" },
    ],
    correctOptionId: "capacity",
    explanation:
      "At 5% traffic, the canary sends only 5% of requests into caches, connection pools, locks, and downstream quotas. Those resources see the full load only after promotion. The error rate and sample size can be fine while the capacity projection has no margin.",
  },
  setup: defaults({ requestRate: 30_000, canaryShare: 5, sharedCapacity: 20_000, scalePenalty: 60 }),
  runFor: 30,
  observe: [
    "Canary utilization is 7.5% of shared capacity and looks healthy.",
    "Projected full utilization is 240% of safe capacity.",
    "Error rate reaches 30% and p99 reaches 6,000ms at full load.",
    "The failure is visible only in the projection, not in the canary's own metrics.",
  ],
  explain:
    "The canary is a traffic sample, not a capacity sample. Resources that scale with total traffic, or that degrade nonlinearly because of cache misses and lock contention, need a target-scale test or an explicit projection before promotion.",
  fix: defaults({ requestRate: 24_000, canaryShare: 5, sharedCapacity: 36_000, scalePenalty: 10 }),
  debrief:
    "The fix raises shared capacity and reduces the per-request work that appears at scale. Full utilization falls to 73% and the error rate returns to zero. The tradeoff is cost and engineering effort; the cheaper alternative is a load test at the projected rate before the rollout starts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The canary capacity fallacy is treating a small traffic share as a small version of full production. A 5% canary sends 5% of requests to the new version. That is enough to compare error rates and latency for the requests it sees, but it is not enough to fill a connection pool, evict a cache, create lock contention, or reach a downstream quota. Those resources scale with total traffic and can behave nonlinearly near their limit.",
  },
  {
    type: "p",
    text: "The canary can therefore be green while the full rollout is already doomed. The missing gate is not another error-rate check on the same traffic. It is a capacity check at the target scale: a load test, a projection from per-request demand, or a traffic step large enough to exercise the resource that will break.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A canary sits behind a traffic split and is measured per version. The shared resource sits beneath both versions and sees aggregate load. The canary's CPU may scale with its own traffic share, while a shared cache, database pool, or third-party quota scales with everything. The gate must distinguish per-instance signals from shared-resource signals and project the shared ones to 100%.",
  },
  {
    type: "p",
    text: "The rates, capacities, and scale penalty in this model are illustrative. The structure is the lesson: the canary projection uses the canary's share, while the full projection uses every request plus the extra work that appears only at scale.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Canary utilization: the shared resource at the current traffic share.",
      "Projected full utilization: the same resource at 100% with the scale penalty.",
      "Error rate and p99: user-facing signals that can stay clean at the canary share.",
      "Shared-resource capacity and the extra work that appears at full scale.",
      "A deployment view comparing the canary, the full projection, and the stable control.",
    ],
  },
  {
    type: "table",
    headers: ["Resource", "Scales with", "Canary sees", "Full rollout sees"],
    rows: [
      ["Application CPU", "Its own traffic share", "Proportional load", "Proportional load"],
      ["Connection pool", "Total concurrent requests", "A fraction", "Every request"],
      ["Cache working set", "Distinct keys and churn", "A subset", "The full set, with more misses"],
      ["Lock or queue", "Contention and arrival rate", "Low contention", "Queueing and tail latency"],
      ["Downstream quota", "Aggregate calls", "A fraction", "The full call volume"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and compare canary utilization with the full projection. Apply Peak to see the projection enter the warning band while the canary stays quiet. Apply Full rollout to see the failure, then Full-scale test to see the same build revealed before exposure. Run the experiment and apply its fix.",
  },
  { type: "sim", simId: "canary-capacity" },
  { type: "experiment", experimentId: "predict-canary-capacity" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the 5% canary used 7.5% of shared capacity. The full rollout carried 48k rps-equivalent against 20k of safe capacity, reaching 240% utilization. Errors hit 30% and p99 reached 6,000ms. The canary's own metrics were clean because the resource it needed to break was never loaded.",
  },
  {
    type: "p",
    text: "The full-scale test preset shows the alternative: run the new version at 100% in an isolated environment or with a controlled load. The same failure appears before users see it. The cost is the capacity to run the test, which is usually less than the cost of a bad rollout.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Canary error rate and p99 that look normal while shared-resource utilization is already high.",
      "Connection-pool wait, queue depth, lock contention, or cache miss rate rising only at full traffic.",
      "A downstream dependency returning throttling responses after promotion.",
      "A traffic step that produces a sudden error spike rather than a gradual one.",
      "Autoscaling that cannot add capacity before the queue grows.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Project per-request shared-resource demand onto 100% traffic before promotion. Compare canary utilization with the projection, not with the canary's own CPU. Check caches, pools, locks, and downstream quotas. If the projection has no margin, run a target-scale test instead of promoting.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the resource that scales with total traffic, not just the canary share.",
      "Project its demand at 100%, including cache misses and scale penalties.",
      "Run a controlled load test at the target rate if the projection is uncertain.",
      "Add capacity or reduce per-request work before retrying.",
      "Promote in traffic steps that exercise the resource, with the same gate at each step.",
      "Fail closed when the projection has no headroom, even if the canary is green.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A target-scale load test finds capacity failures but costs money and may not reproduce production traffic mix.",
      "A larger canary exercises more shared state but exposes more users to the new version.",
      "A projection is cheap but depends on assumptions about cache, lock, and downstream behavior at scale.",
      "Adding capacity is durable but expensive; reducing per-request work is faster but needs another build.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-passed",
    question:
      "The canary passed at 5% and the full rollout is failing. How do you explain the difference?",
    difficulty: 3,
    hints: [
      "Distinguish traffic share from capacity.",
      "Look for shared resources.",
      "Check nonlinear behavior such as cache misses and locks.",
    ],
    answer:
      "The canary exercised only 5% of requests, so shared resources saw a fraction of full demand. The full rollout can saturate a connection pool, cache, lock, or downstream quota that was never stressed. It can also change behavior nonlinearly: the cache hit rate falls as the working set grows, or lock contention appears as arrival rate rises. I would compare per-request demand with the resource's safe capacity and run a target-scale test before the next promotion.",
    followUps: [
      "Which resource would you check first?",
      "How do you tell a capacity failure from a code defect?",
      "What would you change in the gate?",
    ],
    redFlags: ["Assumes the canary is representative.", "Only checks error rate.", "Promotes again without a scale test."],
    rubric: ["Separates share from capacity.", "Names shared resources.", "Mentions nonlinear effects.", "Adds a scale gate."],
  },
  {
    id: "scale-test",
    question: "How would you design a load test for the resource the canary cannot exercise?",
    difficulty: 3,
    hints: [
      "Start from the production request mix.",
      "Include the scale penalty.",
      "Measure the resource, not only the endpoint.",
    ],
    answer:
      "I would reproduce the production request mix and rate, including the traffic that creates cache churn, lock contention, and downstream calls. I would ramp to the target rate and hold it long enough to reach steady state, then measure pool utilization, queue depth, lock waits, cache hit rate, and downstream quotas as well as errors and p99. I would run it in an isolated environment or with a kill switch, and I would compare the result with the projection.",
    followUps: [
      "How long should the test hold at peak?",
      "What if the test environment has different capacity?",
      "How do you avoid testing only the happy path?",
    ],
    redFlags: ["Tests only average traffic.", "Measures only HTTP errors.", "No isolation or kill switch."],
    rubric: ["Reproduces mix and rate.", "Holds at steady state.", "Measures shared resources.", "Has isolation."],
  },
  {
    id: "projection",
    question: "How do you project full-scale demand from canary measurements?",
    difficulty: 3,
    hints: [
      "Use per-request work, not the canary total.",
      "Account for cache and lock behavior.",
      "Leave margin for uncertainty.",
    ],
    answer:
      "I would measure the new version's per-request consumption of the shared resource, multiply by the full request rate, and add the extra work that appears at scale. For caches, I would estimate the working-set size and miss rate at full key cardinality. For pools and locks, I would model concurrency and arrival rate. I would treat the result as an estimate with a margin, and I would validate it with a load test when the margin is thin.",
    followUps: [
      "What makes the projection unreliable?",
      "How much margin would you require?",
      "When would you skip the projection and test directly?",
    ],
    redFlags: ["Multiplies canary utilization by 20.", "Ignores cache and lock effects.", "No margin."],
    rubric: ["Uses per-request work.", "Accounts for nonlinear effects.", "Adds margin.", "Validates with a test."],
  },
  {
    id: "traffic-step",
    question: "Can a larger traffic step replace a load test?",
    difficulty: 2,
    hints: [
      "A step exercises real traffic.",
      "It also exposes real users.",
      "Some resources need sustained load.",
    ],
    answer:
      "Sometimes. A larger step exercises real request mix and real dependencies, which a synthetic test may miss. But it exposes users, and a short step may not sustain enough load to fill a cache or build a queue. I would use a step with a gate for resources that respond quickly, and a target-scale test for resources that need sustained pressure or carry high user risk. In both cases the gate and rollback must be ready before the step.",
    followUps: [
      "What step size would you choose?",
      "Which failure modes only appear over time?",
      "How do you bound the blast radius of the step?",
    ],
    redFlags: ["Treats a step as risk-free.", "Skips the gate.", "Assumes short peaks are representative."],
    rubric: ["Names step benefits.", "Names exposure cost.", "Matches method to resource.", "Keeps a gate."],
  },
];

const checklist = [
  {
    title: "Before the rollout",
    items: [
      "List resources that scale with total traffic rather than canary share.",
      "Project full-scale demand from per-request measurements.",
      "Include cache churn, lock contention, and downstream quotas in the projection.",
      "Run a target-scale test when the projection has no margin.",
      "Define the gate at each traffic step.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Compare canary utilization with the full projection, not with canary CPU.",
      "Watch pool wait, queue depth, cache miss rate, and lock contention.",
      "Stop the rollout if a shared resource approaches its safe limit.",
      "Do not treat a clean canary error rate as proof of full-scale capacity.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Verify shared-resource behavior at peak traffic.",
      "Compare the projection with observed full-scale demand.",
      "Add the missed resource to the gate.",
      "Record the scale test or traffic step that validated the change.",
    ],
  },
];

const references = [
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Canary population, shared failure domains, and metric selection.",
  },
  {
    title: "Automating safe, hands-off deployments",
    url: "https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Staged rollout, bake time, and metric requirements before promotion.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "canary-capacity": {
      model: canaryCapacityModel,
      presets,
      instructions:
        "Start with Healthy and compare the canary with the full projection. Apply Peak, then Full rollout. Apply Full-scale test to see the failure before exposure. Run the experiment and apply its fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Request rates, capacities, and the scale penalty are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-canary-metric-gate", "deployment-canary", "deployment-traffic-shifting", "deployment-verification"],
};
