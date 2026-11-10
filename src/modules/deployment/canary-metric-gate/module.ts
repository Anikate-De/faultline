import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const FLEET_SIZE = 12;
const INSTANCE_CAPACITY = 2_000;
const MIN_GATE_SAMPLES = 50_000;

const params = [
  {
    id: "requestRate",
    label: "Production request rate",
    min: 2_000,
    max: 24_000,
    step: 500,
    value: 12_000,
    unit: " rps",
    group: "Traffic",
    help: "Request rate at 100% production traffic, in requests per second (rps). The canary receives a share of this rate.",
    format: "rps" as const,
  },
  {
    id: "versionOverhead",
    label: "New version dependency overhead",
    min: 0,
    max: 80,
    step: 5,
    value: 10,
    unit: "%",
    group: "Release",
    help: "Extra shared-dependency work per request in the new version, such as an added query or a larger payload.",
    format: "percent" as const,
  },
  {
    id: "dependencyCapacity",
    label: "Shared dependency capacity",
    min: 5_000,
    max: 40_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Capacity",
    help: "Safe request-equivalent capacity of the shared dependency at the latency target, in requests per second (rps).",
    format: "rps" as const,
  },
  {
    id: "rolloutPercent",
    label: "Traffic on new version",
    min: 1,
    max: 100,
    step: 1,
    value: 5,
    unit: "%",
    group: "Rollout",
    help: "Share of production traffic on the new version. Low values are a canary; 100% is full rollout.",
    format: "percent" as const,
  },
  {
    id: "gateSeconds",
    label: "Metric gate window",
    min: 30,
    max: 600,
    step: 30,
    value: 300,
    unit: "s",
    group: "Rollout",
    help: "How long the canary collects samples before the gate decision. Longer windows improve confidence.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  requestRate: number;
  rollout: number;
  overhead: number;
  newInstances: number;
  stableInstances: number;
  newTraffic: number;
  stableTraffic: number;
  newPerInstance: number;
  stablePerInstance: number;
  appUtil: number;
  dependencyLoad: number;
  dependencyUtil: number;
  errorRate: number;
  p99: number;
  canarySamples: number;
  sampleShortfall: number;
  dependencyCapacity: number;
}

function compute(p: Params): Computed {
  const requestRate = num(p, "requestRate", 12_000);
  const rollout = clamp(num(p, "rolloutPercent", 5) / 100, 0.01, 1);
  const overhead = clamp(num(p, "versionOverhead", 10) / 100, 0, 0.8);
  const dependencyCapacity = Math.max(1, num(p, "dependencyCapacity", 20_000));
  const gateSeconds = Math.max(1, num(p, "gateSeconds", 300));

  const newInstances =
    rollout >= 1
      ? FLEET_SIZE
      : Math.max(1, Math.min(FLEET_SIZE - 1, Math.floor(FLEET_SIZE * rollout)));
  const stableInstances = FLEET_SIZE - newInstances;
  const newTraffic = requestRate * rollout;
  const stableTraffic = requestRate * (1 - rollout);
  const newPerInstance = newTraffic / newInstances;
  const stablePerInstance = stableInstances > 0 ? stableTraffic / stableInstances : 0;
  const appUtil = clamp((Math.max(newPerInstance, stablePerInstance) / INSTANCE_CAPACITY) * 100, 0, 160);

  const dependencyLoad = requestRate * (1 + rollout * overhead);
  const dependencyUtil = clamp((dependencyLoad / dependencyCapacity) * 100, 0, 180);

  const depOver = Math.max(0, dependencyUtil / 100 - 0.9);
  const appOver = Math.max(0, appUtil / 100 - 0.9);
  const errorRate = Math.min(8, 0.08 + depOver * 40 + appOver * 25);
  const p99 = Math.min(
    1_500,
    120 +
      8_000 * Math.max(0, dependencyUtil / 100 - 0.9) ** 2 +
      50 * (dependencyUtil / 100) +
      400 * Math.max(0, appUtil / 100 - 0.85),
  );

  const canarySamples = requestRate * rollout * gateSeconds;
  const sampleShortfall = Math.max(0, MIN_GATE_SAMPLES - canarySamples);

  return {
    requestRate,
    rollout,
    overhead,
    newInstances,
    stableInstances,
    newTraffic,
    stableTraffic,
    newPerInstance,
    stablePerInstance,
    appUtil,
    dependencyLoad,
    dependencyUtil,
    errorRate,
    p99,
    canarySamples,
    sampleShortfall,
    dependencyCapacity,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function utilizationHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function formatPercent(value: number): string {
  return `${value.toFixed(value < 1 ? 1 : 0)}%`;
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const appHealth = utilizationHealth(values.appUtil, 75, 90);
  const dependencyHealth = utilizationHealth(values.dependencyUtil, 85, 95);
  const overallHealth = worst(appHealth, dependencyHealth);
  const stageNodes: SimNode[] = [];

  if (values.rollout >= 1) {
    stageNodes.push({
      id: "full",
      label: "Full rollout",
      kind: "service",
      health: overallHealth,
      utilization: clamp(values.appUtil / 100),
      throughput: values.requestRate,
      capacity: FLEET_SIZE * INSTANCE_CAPACITY,
      sublabel: `${FLEET_SIZE} instances · 100% traffic · dep ${formatPercent(values.dependencyUtil)}`,
      detail: `App CPU is ${formatPercent(values.appUtil)}. The shared dependency is at ${formatPercent(values.dependencyUtil)} of its safe capacity, carrying ${Math.round(values.dependencyLoad).toLocaleString()} rps-equivalent.`,
      meta: { stage: "full", view: "deployment" },
    });
  } else {
    stageNodes.push({
      id: "stable",
      label: "Stable v1",
      kind: "service",
      health: overallHealth,
      utilization: clamp(values.stablePerInstance / INSTANCE_CAPACITY),
      throughput: values.stableTraffic,
      capacity: values.stableInstances * INSTANCE_CAPACITY,
      sublabel: `${values.stableInstances} instances · ${formatPercent((1 - values.rollout) * 100)} traffic · dep ${formatPercent(values.dependencyUtil)}`,
      detail: `The control fleet carries ${formatPercent((1 - values.rollout) * 100)} of traffic. Shared dependency utilization includes both versions and is ${formatPercent(values.dependencyUtil)}.`,
      meta: { stage: "stable", view: "deployment" },
    });
    stageNodes.push({
      id: "canary",
      label: "Canary v2",
      kind: "service",
      health: overallHealth,
      utilization: clamp(values.newPerInstance / INSTANCE_CAPACITY),
      throughput: values.newTraffic,
      capacity: values.newInstances * INSTANCE_CAPACITY,
      sublabel: `${values.newInstances} instance${values.newInstances === 1 ? "" : "s"} · ${formatPercent(values.rollout * 100)} traffic · dep ${formatPercent(values.dependencyUtil)}`,
      detail: `The canary carries ${formatPercent(values.rollout * 100)} of traffic on ${values.newInstances} instance${values.newInstances === 1 ? "" : "s"}. The shared dependency sees only this share of the new version's overhead, not the full-rollout load.`,
      meta: { stage: "canary", view: "deployment" },
    });
  }

  const flowNodes: SimNode[] = [
    {
      id: "clients",
      label: "Clients",
      kind: "client",
      health: "ok",
      throughput: values.requestRate,
      sublabel: `${Math.round(values.requestRate).toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "service",
      label: "Checkout service",
      kind: "service",
      health: overallHealth,
      utilization: clamp(values.appUtil / 100),
      throughput: values.requestRate,
      capacity: FLEET_SIZE * INSTANCE_CAPACITY,
      sublabel: `${FLEET_SIZE} instances · ${values.rollout >= 1 ? "full v2" : "v1 + canary"}`,
      meta: { view: "flow" },
    },
    {
      id: "dependency",
      label: "Shared dependency",
      kind: "db",
      health: dependencyHealth,
      utilization: clamp(values.dependencyUtil / 100),
      throughput: values.dependencyLoad,
      capacity: values.dependencyCapacity,
      sublabel: `${formatPercent(values.dependencyUtil)} of safe capacity`,
      detail: `The dependency sees ${Math.round(values.dependencyLoad).toLocaleString()} rps-equivalent against an illustrative safe capacity of ${Math.round(values.dependencyCapacity).toLocaleString()}. The canary only exposes a share of the new version's overhead.`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-service", "clients", "service", values.requestRate / 24_000, overallHealth),
      edge("service-dependency", "service", "dependency", values.dependencyUtil / 100, dependencyHealth),
    ],
    metrics: [
      metric("dependency-utilization", "Dependency utilization", values.dependencyUtil, "%", 85, 95, "percent"),
      metric("app-cpu", "App CPU max", values.appUtil, "%", 75, 90, "percent"),
      metric("error-rate", "New version error rate", values.errorRate, "%", 0.5, 2, "percent"),
      metric("p99-latency", "New version p99", values.p99, "ms", 300, 800, "ms"),
      metric("canary-samples", "Canary samples", values.canarySamples, " req", undefined, undefined, "rps"),
      metric("sample-shortfall", "Sample shortfall", values.sampleShortfall, " req", 10_000, 30_000, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      dependencyUtil: values.dependencyUtil,
      rollout: values.rollout,
    },
    summary: `${values.rollout >= 1 ? "Full rollout 100%" : `Canary ${formatPercent(values.rollout * 100)}`} · dependency ${formatPercent(values.dependencyUtil)} · errors ${formatPercent(values.errorRate)} · p99 ${values.p99.toFixed(0)}ms`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 11)) / 2.7);
  const series: [string, number][] = [
    ["dependency-utilization", values.dependencyUtil],
    ["app-cpu", values.appUtil],
    ["error-rate", values.errorRate],
    ["p99-latency", values.p99],
    ["canary-samples", values.canarySamples],
    ["sample-shortfall", values.sampleShortfall],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * Math.max(1, value * 0.01)),
    );
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "dependency-utilization",
    metricId: "dependency-utilization",
    warn: 85,
    crit: 95,
    title: "The shared dependency is at its capacity limit",
    cause: "The canary exposed only a small share of the new version's per-request overhead. At full rollout, every request carries that overhead, so a dependency that looked comfortable can saturate.",
    fix: "Stop the rollout. Add dependency capacity, reduce the new version's per-request work, or roll back. Gate the next attempt on projected full-load utilization or a load test at the target scale.",
    checkFirst: [
      "Compare dependency load at canary share with the projected load at 100%.",
      "Check connection pool utilization, queue depth, and wait time.",
      "Check whether app CPU stayed healthy while the dependency saturated.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 2,
    title: "Canary error rate is above the gate",
    cause: "The new version is returning more errors than the control, or a saturated dependency is turning into timeouts and 5xx responses.",
    fix: "Fail the gate, stop promotion, and roll back if the error budget is at risk. Compare per-version errors rather than the blended service error rate.",
    checkFirst: [
      "Compare canary and control error rates, not the aggregate.",
      "Check whether errors are new status codes or timeouts.",
      "Check the dependency and downstream health at the same timestamp.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "Canary tail latency is above the gate",
    cause: "A canary can pass on average latency while the tail degrades. Queueing at a shared dependency or a saturated instance shows up in p99 first.",
    fix: "Gate on p99 at the target load, not the average at low load. Fail the gate, find the queue, and add capacity or reduce work before retrying.",
    checkFirst: [
      "Compare p99 by version, not the blended service p99.",
      "Check queue depth and connection pool wait at the dependency.",
      "Check whether the canary window is long enough to include the tail.",
    ],
  },
  {
    id: "sample-shortfall",
    metricId: "sample-shortfall",
    warn: 10_000,
    crit: 30_000,
    title: "The canary gate has too few samples",
    cause: "A small traffic share or a short gate window produces too few requests to distinguish the new version from the control. A clean error rate on a handful of requests is not evidence.",
    fix: "Extend the gate window, raise the canary share, or add a controlled load test. Decide the minimum sample before the rollout, based on the effect size you need to detect.",
    checkFirst: [
      "Check canary request count and the metric aggregation interval.",
      "Check whether the gate window covers a full traffic cycle.",
      "Check whether the decision is based on a confidence interval or only a point estimate.",
    ],
  },
  {
    id: "app-cpu",
    metricId: "app-cpu",
    warn: 75,
    crit: 90,
    title: "The application fleet is saturated",
    cause: "Per-instance request load is above the safe CPU target. This can happen at full rollout if the fleet is undersized or the new version uses more CPU per request.",
    fix: "Add instances, reduce per-request work, or roll back. Do not treat a healthy canary CPU as proof of full-rollout capacity.",
    checkFirst: [
      "Check CPU per instance, not the fleet average.",
      "Check whether the canary instance count matches its traffic share.",
      "Check autoscaling lag and the time to add capacity.",
    ],
  },
];

export const canaryMetricGateModel: SimModel = {
  id: "deployment-canary-metric-gate",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
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
    next.flags.paramsKey = key;
    if (resetSeries) seedSeries(next, values, seed);
    const jitter = rng.between(-0.4, 0.4) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99-latency" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    const p99 = next.metrics.find((item) => item.id === "p99-latency")?.value ?? values.p99;
    next.summary = `${values.rollout >= 1 ? "Full rollout 100%" : `Canary ${formatPercent(values.rollout * 100)}`} · dependency ${formatPercent(values.dependencyUtil)} · errors ${formatPercent(values.errorRate)} · p99 ${p99.toFixed(0)}ms`;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const share = values.rollout < 1 ? `${formatPercent(values.rollout * 100)} of traffic` : "100% of traffic";
    const items: string[] = [];
    if (values.dependencyUtil >= 95) {
      items.push(
        `The shared dependency is at ${formatPercent(values.dependencyUtil)} of its safe capacity with ${share} on the new version. At full rollout every request carries the new version's ${formatPercent(values.overhead * 100)} overhead.`,
      );
    } else if (values.dependencyUtil >= 85) {
      items.push(
        `The shared dependency is at ${formatPercent(values.dependencyUtil)} of its safe capacity. That is inside the warning band, not proof of full-rollout headroom.`,
      );
    } else {
      items.push(
        `The shared dependency is at ${formatPercent(values.dependencyUtil)} of its safe capacity with ${share} on the new version.`,
      );
    }
    items.push(
      `App CPU is ${formatPercent(values.appUtil)}. A healthy application CPU does not prove that a shared dependency can absorb the full rollout.`,
    );
    if (values.sampleShortfall > 0) {
      items.push(
        `The gate collected ${Math.round(values.canarySamples).toLocaleString()} canary requests against an illustrative minimum of ${MIN_GATE_SAMPLES.toLocaleString()}. The shortfall is ${Math.round(values.sampleShortfall).toLocaleString()}.`,
      );
    } else {
      items.push(
        `The gate collected ${Math.round(values.canarySamples).toLocaleString()} canary requests, above the illustrative minimum of ${MIN_GATE_SAMPLES.toLocaleString()}.`,
      );
    }
    items.push(
      `The new version carries ${Math.round(values.newTraffic).toLocaleString()} rps on ${values.newInstances} instance${values.newInstances === 1 ? "" : "s"} now; full rollout would carry ${Math.round(values.requestRate).toLocaleString()} rps on ${FLEET_SIZE}.`,
    );
    items.push(
      `Error rate is ${formatPercent(values.errorRate)} and p99 is ${values.p99.toFixed(0)}ms. Each gate needs its own threshold and enough samples.`,
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
    description: "A 5% canary with modest overhead. All gates are inside budget.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "18k rps and a 25% canary. App CPU enters the warning band and dependency headroom narrows.",
    tone: "warn",
    params: defaults({ requestRate: 18_000, versionOverhead: 20, dependencyCapacity: 24_000, rolloutPercent: 25, gateSeconds: 180 }),
  },
  {
    id: "canary-pass",
    label: "Canary passes",
    description: "A 5% canary with 50% overhead. Error rate and p99 look normal at this share.",
    tone: "ok",
    params: defaults({ requestRate: 12_000, versionOverhead: 50, dependencyCapacity: 15_000, rolloutPercent: 5, gateSeconds: 300 }),
  },
  {
    id: "failure",
    label: "Full rollout",
    description: "The same build at 100% of production traffic.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, versionOverhead: 50, dependencyCapacity: 15_000, rolloutPercent: 100, gateSeconds: 300 }),
  },
  {
    id: "short-gate",
    label: "Short gate",
    description: "A 5% canary with a 30-second gate window.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, versionOverhead: 50, dependencyCapacity: 15_000, rolloutPercent: 5, gateSeconds: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Dependency capacity raised and per-request overhead reduced before full rollout.",
    tone: "ok",
    params: defaults({ requestRate: 12_000, versionOverhead: 20, dependencyCapacity: 24_000, rolloutPercent: 100, gateSeconds: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-full-rollout",
  title: "Predict what full rollout exposes",
  simId: "canary-gate",
  question:
    "The 5% canary shows a normal error rate and p99. You promote the same build to 100%. Which constraint breaks first?",
  prediction: {
    options: [
      { id: "app-cpu", label: "Application CPU on the canary instances" },
      { id: "dependency", label: "The shared dependency's capacity at full request volume" },
      { id: "control", label: "The stable version's error rate" },
      { id: "samples", label: "Canary sample size" },
    ],
    correctOptionId: "dependency",
    explanation:
      "At 5% traffic, only 5% of requests carry the new version's extra dependency work. At 100%, every request does. Application CPU can look normal because instances and traffic scale together, while a shared dependency absorbs the full per-request overhead.",
  },
  setup: defaults({ requestRate: 12_000, versionOverhead: 50, dependencyCapacity: 15_000, rolloutPercent: 100, gateSeconds: 300 }),
  runFor: 20,
  observe: [
    "Dependency utilization is 120% of safe capacity.",
    "New version error rate rises to 8% and p99 reaches 900ms.",
    "App CPU stays near 50%, so an application-CPU-only gate would have passed.",
    "Gate samples are sufficient; this is a capacity failure, not a sample-size failure.",
  ],
  explain:
    "A canary is a sample of traffic, not a sample of full-scale capacity. Error rate and p99 at 5% can be clean while the new version's incremental load on shared dependencies is only a fraction of the full-rollout load. The gate needs a saturation and capacity check at the target scale, not just an error-rate check at the canary share.",
  fix: defaults({ requestRate: 12_000, versionOverhead: 20, dependencyCapacity: 24_000, rolloutPercent: 100, gateSeconds: 300 }),
  debrief:
    "The fixed build keeps dependency utilization at 60% at full traffic. The real cost is that the dependency now has more headroom and the new version does less per-request work; both were deliberate capacity decisions, not canary luck. The next gate should compare projected full-load utilization with the safe capacity before promotion, and it should fail the rollout if the projection has no margin.",
};

const sampleExperiment: Experiment = {
  id: "predict-sample-gate",
  title: "Predict whether the gate has enough samples",
  simId: "canary-gate",
  question:
    "A 5% canary runs for 30 seconds and shows a clean 0.1% error rate. Can you promote on that signal?",
  prediction: {
    options: [
      { id: "yes-clean", label: "Yes. A clean error rate proves the release is safe" },
      { id: "no-samples", label: "No. The sample is too small to distinguish the canary from the control" },
      { id: "yes-slo", label: "Yes. The canary is inside the SLO, so no other gate matters" },
      { id: "no-share", label: "No. The canary traffic share is too high to be safe" },
    ],
    correctOptionId: "no-samples",
    explanation:
      "An observed error rate is an estimate. With few requests, the confidence interval is wide enough that a real regression can hide inside a clean result. The gate needs a sample target based on the smallest effect worth detecting, then enough traffic and time to reach it.",
  },
  setup: defaults({ requestRate: 12_000, versionOverhead: 50, dependencyCapacity: 15_000, rolloutPercent: 5, gateSeconds: 30 }),
  runFor: 30,
  observe: [
    "Canary samples are 18k; the shortfall is 32k against the illustrative 50k minimum.",
    "Error rate is 0.1% and p99 is 161ms.",
    "Dependency utilization is 82%, below the warning threshold.",
    "The gate cannot distinguish a small regression from noise, so the clean rate is not a decision.",
  ],
  explain:
    "Sample size is a gate dimension, not a formality. A clean rate on a small sample is weak evidence because the confidence interval is wide. Size the gate from the effect you need to detect, then extend the window, raise the canary share within the risk budget, or use a controlled load test.",
  fix: defaults({ requestRate: 12_000, versionOverhead: 50, dependencyCapacity: 15_000, rolloutPercent: 5, gateSeconds: 300 }),
  debrief:
    "The five-minute gate collects 180k samples and clears the sample gate. That makes the error-rate comparison credible; it does not prove capacity at full rollout. The capacity experiment covers that separate gate. A production gate needs both: enough samples for the error-rate and latency decision, and a saturation or capacity check at the target scale.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A canary is a partial, time-limited deployment. A small share of production traffic goes to the new version while the control serves the rest. A metric gate compares the canary with the control and decides whether to promote, pause, or roll back. The gate protects the service-level objective (SLO); the traffic split only limits the blast radius.",
  },
  {
    type: "p",
    text: "Error rate alone is not a sufficient gate. A release can return 200s while adding latency, consuming more memory, exhausting a connection pool, or exceeding a shared dependency's capacity. A canary at 5% traffic sends only 5% of requests to the new version, so its incremental load on shared resources, locks, caches, and quotas is a fraction of what full rollout will produce. The gate must cover error rate, latency, saturation, and capacity at the target scale, with enough samples to make the comparison meaningful.",
  },
  { type: "h2", text: "Where it sits" },
  { type: "diagram", id: "canary-stages", caption: "A canary moves through traffic shares with a gate at each step. The full-rollout step is the first time every request carries the new version's cost." },
  {
    type: "p",
    text: "The load balancer or service mesh splits traffic between the stable and canary versions. Both versions usually share downstream dependencies: databases, caches, third-party APIs, and connection pools. The canary's own CPU, memory, error rate, and p99 are measured per version; the shared dependency's utilization is measured globally. That difference is where capacity surprises live.",
  },
  {
    type: "p",
    text: "This module models a 12-instance service with a shared dependency. The dependency capacity, per-request overhead, sample minimum, and thresholds are illustrative teaching values. The shape is the lesson: a canary carries a share of the new version's per-request overhead, while full rollout carries all of it. App CPU can stay flat as instances and traffic scale together, so an app-only gate can pass while a shared dependency saturates.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Dependency utilization: the shared resource's load against its safe capacity.",
      "App CPU max: per-instance application CPU, which can look healthy at every rollout share.",
      "Canary error rate and 99th-percentile latency (p99): the user-facing signals at the current traffic share.",
      "Canary samples and sample shortfall: whether the gate saw enough requests to decide.",
      "A deployment view of stable, canary, and full stages, with traffic share and dependency load.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Canary passes, then apply Full rollout. Watch dependency utilization and error rate rise while app CPU stays near 50%. Apply Short gate to see a different failure: the canary looks clean but the sample is too small. Use the experiments to predict the full-rollout constraint and whether the gate has enough samples.",
  },
  {
    type: "table",
    headers: ["Gate", "What it catches", "What it can miss"],
    rows: [
      ["Error rate", "Crashes, server errors (5xx), timeouts, bad status codes", "Slow requests, saturation, and capacity with no errors yet"],
      ["Latency (p99)", "Queueing and tail regressions", "A dependency that is near its limit but still fast"],
      ["Saturation", "CPU, memory, queue depth, pool utilization", "A shared resource whose load scales with total traffic"],
      ["Capacity at target scale", "Full-rollout demand against safe capacity", "Cost and time to run a representative load test"],
      ["Sample depth", "Too few requests for a confident decision", "A real regression that needs a longer window to appear"],
    ],
  },
  {
    type: "p",
    text: "The canary share and the gate window are a tradeoff. A larger share gives more samples and exercises more of the system, but exposes more users. A longer window gives more samples and covers slow-burning effects, but slows delivery and may cross a traffic cycle. The gate should be sized from the effect you need to detect, not from a fixed habit. If the service is too low-traffic to produce samples, use a longer window or a controlled load test rather than promoting on a handful of requests.",
  },
  { type: "sim", simId: "canary-gate" },
  { type: "experiment", experimentId: "predict-full-rollout" },
  { type: "experiment", experimentId: "predict-sample-gate" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In this model, the 5% canary added only 5% of the new version's dependency overhead. Dependency utilization was 82%, error rate was near baseline, and p99 was normal. At 100%, every request carried the overhead, so the dependency reached 120% of safe capacity. Error rate and p99 followed. App CPU stayed near 50% because the fleet and traffic scaled together, which is why an application-CPU-only gate would have passed.",
  },
  {
    type: "p",
    text: "The short-gate preset shows a second failure: a clean error rate on a small sample is not the same as a clean error rate with enough samples for the decision. The gate window and traffic share set the sample size; the threshold sets what you can detect. Both need to be designed before the rollout, not inferred from a green dashboard.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-version error rate, p99, and request count from the load balancer, service mesh, or deployment controller.",
      "Dependency pool utilization, queue depth, wait time, connection count, and throttling responses.",
      "App CPU, memory, and instance count per version; autoscaling events during promotion.",
      "SLO burn rate and error budget for the service, not only the canary's raw error rate.",
      "Deployment events: traffic shifts, gate decisions, bake time, and rollback.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the canary's traffic share with the load it places on shared dependencies. Project that load to 100% before promoting. Check app CPU and the dependency together; a healthy app CPU does not prove capacity. Check the canary sample count and gate window before trusting a clean error rate.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the rollout and roll back if the error budget is at risk; preserve the canary and control metrics.",
      "Find the shared constraint: dependency utilization, pool wait, queue depth, lock contention, or quota.",
      "Add capacity or reduce the new version's per-request work before retrying.",
      "Gate the next attempt on projected full-load utilization or a load test at the target scale.",
      "Use staged promotion, such as 5%, 25%, 50%, and 100%, with the same gate at each step.",
      "Require enough samples in each stage, and fail closed when the gate cannot decide.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger canary gives more confidence and exercises more shared state, but exposes more users to a bad release.",
      "A longer gate window improves confidence and catches slow burns, but slows delivery and can cross a traffic cycle.",
      "A load test at target scale can reveal capacity, but it costs money and may not reproduce production traffic mix.",
      "Adding dependency capacity is durable but may be slow or expensive; reducing per-request work may be faster but needs a new build.",
      "Rollback is fast only if the artifact and schema are compatible; a data migration can make rollback unsafe.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "canary-passed",
    question:
      "The canary has 5% of traffic and a 0.1% error rate. Can you promote? What else do you need before deciding?",
    difficulty: 4,
    hints: [
      "A clean error rate is one gate, not the whole gate.",
      "Shared resources see the canary's share, not full-rollout load.",
      "A rate without a sample count is weak evidence.",
    ],
    answer:
      "Not yet. I need the canary's request count and gate window, the control's error rate for comparison, p99 and saturation metrics, and the projected load on shared dependencies at 100%. I would check whether the canary's traffic share is representative enough to expose the new code paths, and whether the error rate difference is inside a confidence interval. I would also check app CPU, memory, dependency pool utilization, queue depth, and SLO burn. Promotion is justified only when every gate has enough samples and the full-scale capacity projection has margin.",
    followUps: [
      "What would you do if the service receives too little traffic for a meaningful canary?",
      "Which gate would you trust least at 5% traffic?",
      "How does error budget policy change the answer?",
    ],
    redFlags: [
      "Promotes on error rate alone.",
      "Ignores sample size and the control group.",
      "Assumes the canary represents full-scale capacity.",
    ],
    rubric: [
      "Names multiple gate dimensions.",
      "Checks sample size and control comparison.",
      "Projects shared-dependency load to full scale.",
      "Ties the decision to the error budget.",
    ],
  },
  {
    id: "gate-design",
    question:
      "Design a canary gate for a service that shares a database connection pool with the stable version. What do you measure, and when do you fail the rollout?",
    difficulty: 4,
    hints: [
      "Measure both the application and the shared pool.",
      "A canary at low traffic will not exhaust the pool by itself.",
      "The gate needs a decision rule, not just a dashboard.",
    ],
    answer:
      "I would gate on per-version error rate and p99, app CPU and memory per instance, and pool utilization, wait time, queue depth, and connection count. I would compare the canary with the control at the same timestamps, and I would project pool demand at 100% traffic from the canary's per-request behavior. I would fail the rollout if error rate or p99 exceeds the control by the agreed margin, if the pool crosses its safe utilization or wait threshold, or if the projected full-load demand has no headroom. If the canary cannot generate enough load, I would run a controlled load test at the target scale before promotion.",
    followUps: [
      "What is the difference between pool utilization and pool wait time?",
      "How would you detect a connection leak that only appears over hours?",
      "What would make you stop the rollout automatically?",
    ],
    redFlags: [
      "Measures only HTTP errors.",
      "Assumes the canary exercises the pool at full scale.",
      "Has no fail condition or rollback path.",
    ],
    rubric: [
      "Covers errors, latency, saturation, and capacity.",
      "Names shared-pool signals.",
      "Projects to full scale or load tests.",
      "Defines fail and rollback conditions.",
    ],
  },
  {
    id: "sample-size",
    question:
      "How do you decide how much traffic and time a canary gate needs?",
    difficulty: 4,
    hints: [
      "Start from the smallest effect you care about.",
      "Baseline error rate affects the sample you need.",
      "The gate window must be longer than the metric aggregation interval.",
    ],
    answer:
      "I start from the smallest difference I need to detect, the baseline rate and variance, and the confidence I want. That gives a sample-size estimate, which I convert into a traffic share and duration using the service's request rate. I also make sure the gate window covers a full traffic cycle and is longer than the metric aggregation interval, otherwise the signal is contaminated. If the service is too low-traffic, I extend the window, raise the canary share within the risk budget, or use a controlled load test. I do not promote on a handful of requests just because the error rate is zero.",
    followUps: [
      "What changes if the baseline error rate is very low?",
      "How do you handle a canary that runs over a weekend?",
      "What is wrong with comparing hourly metrics to a 30-minute canary?",
    ],
    redFlags: [
      "Uses a fixed percentage with no sample reasoning.",
      "Ignores baseline rate and variance.",
      "Compares mismatched aggregation windows.",
    ],
    rubric: [
      "Starts from effect size and confidence.",
      "Converts samples to share and duration.",
      "Checks aggregation windows.",
      "Has a low-traffic fallback.",
    ],
  },
  {
    id: "full-rollout-failing",
    question:
      "The canary passed, the full rollout is failing, and the shared dependency is saturated. What do you do in the first ten minutes?",
    difficulty: 4,
    hints: [
      "Stop making the incident larger before diagnosing.",
      "Preserve evidence while you recover.",
      "The gate design is part of the postmortem.",
    ],
    answer:
      "I would stop the rollout or roll back immediately if the error budget is at risk and the artifact is safe to revert. I would confirm whether the failure is capacity, a dependency regression, or a traffic-mix change, and I would preserve the canary and full-rollout metrics, deployment events, and dependency telemetry. I would communicate the rollback and current impact, then add capacity or reduce per-request work before retrying. In the review, I would fix the gate so it projects full-load utilization or runs a target-scale load test, and I would add a fail-closed rule for insufficient samples.",
    followUps: [
      "What would make rollback unsafe?",
      "How would you verify recovery after rollback?",
      "Which gate would you add first?",
    ],
    redFlags: [
      "Keeps promoting while the dependency is saturated.",
      "Diagnoses without preserving canary and control data.",
      "Treats the gate change as optional follow-up.",
    ],
    rubric: [
      "Stops or rolls back first.",
      "Preserves evidence and communicates.",
      "Fixes capacity or per-request work.",
      "Updates the gate and adds a fail-closed rule.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Define gates for error rate, p99 latency, saturation, and capacity at target scale.",
      "Calculate the canary sample size from the smallest effect you need to detect.",
      "Identify shared dependencies and their safe capacity before the rollout.",
      "Write the promotion and rollback conditions, including who can override them.",
      "Confirm the previous artifact and schema support rollback.",
    ],
  },
  {
    title: "During the rollout",
    items: [
      "Compare per-version metrics with the control at the same timestamps.",
      "Watch dependency pool utilization, queue depth, and wait time, not only app CPU.",
      "Fail closed if the gate has too few samples to decide.",
      "Promote in stages and repeat the gate at each traffic share.",
      "Stop and roll back when a gate fails; do not negotiate with a critical threshold.",
    ],
  },
  {
    title: "After the rollout",
    items: [
      "Verify the full fleet at peak traffic, including shared dependencies.",
      "Record the gate decisions, sample counts, and any overrides.",
      "Review whether the canary share exercised the code paths and capacity that mattered.",
      "Add the missed signal to the gate before the next release.",
    ],
  },
];

const references = [
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Canary population, duration, metric selection, and shared failure domains.",
  },
  {
    title: "Automating safe, hands-off deployments",
    url: "https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Staged rollout, one-box alarms, bake time, and metric data-point requirements.",
  },
  {
    title: "Deployment configurations",
    url: "https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html",
    publisher: "AWS CodeDeploy",
    kind: "docs" as const,
    note: "Canary and linear traffic-shifting configurations.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "canary-gate": {
      model: canaryMetricGateModel,
      presets,
      instructions:
        "Start with Canary passes, then apply Full rollout. Compare dependency utilization with app CPU. Apply Short gate to see a sample-size failure, then Recovery to see a capacity fix. Run both experiments.",
      experimentIds: [experiment.id, sampleExperiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Fleet size, instance capacity, sample minimum, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment, sampleExperiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-canary",
    "deployment-canary-capacity",
    "deployment-traffic-shifting",
    "deployment-automated-rollback",
  ],
};
