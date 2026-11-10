import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 20_000;

const params: ParamSpec[] = [
  {
    id: "canaryWeightPercent",
    label: "Canary traffic share",
    min: 1,
    max: 100,
    step: 1,
    value: 5,
    unit: "%",
    group: "Traffic",
    help: "Share of production traffic sent to the new version. The rest goes to the control version.",
    format: "percent",
  },
  {
    id: "canaryErrorPercent",
    label: "Canary error rate",
    min: 0,
    max: 20,
    step: 0.1,
    value: 0.1,
    unit: "%",
    group: "Release",
    help: "Requests sent to the canary that return an error. This is the per-version signal the gate should compare with its threshold.",
    format: "percent",
  },
  {
    id: "controlErrorPercent",
    label: "Control error rate",
    min: 0,
    max: 5,
    step: 0.1,
    value: 0.1,
    unit: "%",
    group: "Baseline",
    help: "Requests on the stable version that return an error. This is the baseline the canary should be compared against.",
    format: "percent",
  },
  {
    id: "gateThresholdPercent",
    label: "Error gate threshold",
    min: 0.1,
    max: 5,
    step: 0.1,
    value: 1,
    unit: "%",
    group: "Gate",
    help: "Blended service error rate the gate allows before it blocks promotion. The model deliberately makes this gate blind to per-version errors.",
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
  weight: number;
  canaryError: number;
  controlError: number;
  gateThreshold: number;
  blendedError: number;
  userImpact: number;
  gatePass: boolean;
  blindSpot: boolean;
  canaryTraffic: number;
  controlTraffic: number;
  p99: number;
}

function compute(p: Params): Values {
  const weight = clamp(num(p, "canaryWeightPercent", 5) / 100, 0.01, 1);
  const canaryError = clamp(num(p, "canaryErrorPercent", 0.1), 0, 100);
  const controlError = clamp(num(p, "controlErrorPercent", 0.1), 0, 100);
  const gateThreshold = Math.max(0.1, num(p, "gateThresholdPercent", 1));
  const blendedError = weight * canaryError + (1 - weight) * controlError;
  const userImpact = weight * canaryError;
  const gatePass = blendedError <= gateThreshold;
  const blindSpot = gatePass && canaryError > gateThreshold;
  const p99 = Math.min(5_000, 120 + canaryError * 90 + weight * 40);

  return {
    weight,
    canaryError,
    controlError,
    gateThreshold,
    blendedError,
    userImpact,
    gatePass,
    blindSpot,
    canaryTraffic: weight * TOTAL_RPS,
    controlTraffic: (1 - weight) * TOTAL_RPS,
    p99,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function errorHealth(value: number): Health {
  if (value >= 5) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function controlHealth(value: number): Health {
  if (value >= 3) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 2 : 1)}%`;
}

function buildFrame(values: Values, seed: number): SimFrame {
  const control = controlHealth(values.controlError);
  const canary = errorHealth(values.canaryError);
  const gate: Health = values.gatePass
    ? values.blindSpot
      ? values.canaryError >= 5
        ? "crit"
        : "warn"
      : "ok"
    : "warn";
  const promoted: Health = values.gatePass ? canary : "warn";
  const overall = worst(control, canary, gate, promoted);
  const gateLabel = values.gatePass ? (values.blindSpot ? "PASS (blind)" : "PASS") : "BLOCKED";

  const stageNodes = [
    {
      id: "control",
      label: "Control version",
      kind: "service" as const,
      health: control,
      utilization: clamp((1 - values.weight) * 0.7),
      throughput: values.controlTraffic,
      capacity: TOTAL_RPS,
      sublabel: `${percent((1 - values.weight) * 100)} of traffic · ${percent(values.controlError)} errors`,
      detail: `The control serves ${Math.round(values.controlTraffic).toLocaleString()} rps. Its error rate is the baseline for the canary comparison. A blended service rate mixes this traffic with the canary and can hide either side.`,
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "canary",
      label: "Canary version",
      kind: "service" as const,
      health: canary,
      utilization: clamp(values.weight * 0.7),
      throughput: values.canaryTraffic,
      capacity: TOTAL_RPS,
      sublabel: `${percent(values.weight * 100)} of traffic · ${percent(values.canaryError)} errors`,
      detail: `The canary serves ${Math.round(values.canaryTraffic).toLocaleString()} rps and has a ${percent(values.canaryError)} error rate. The user-facing error share across all traffic is ${percent(values.userImpact)}.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "gate",
      label: `Promotion gate: ${gateLabel}`,
      kind: "service" as const,
      health: gate,
      sublabel: `Blended ${percent(values.blendedError)} vs ${percent(values.gateThreshold)} threshold`,
      detail: values.gatePass
        ? values.blindSpot
          ? `The gate passes because the blended rate is ${percent(values.blendedError)}, below its ${percent(values.gateThreshold)} threshold. The canary itself is at ${percent(values.canaryError)}, so the decision is blind to the version that is failing.`
          : `The gate passes on a blended rate of ${percent(values.blendedError)} and the canary is below the threshold. That is necessary, not sufficient: sample size and latency still matter.`
        : `The gate blocks promotion because the blended rate is ${percent(values.blendedError)}, above its ${percent(values.gateThreshold)} threshold. The blast radius stays limited to the canary share.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    {
      id: "clients",
      label: "Clients",
      kind: "client" as const,
      health: "ok" as const,
      throughput: TOTAL_RPS,
      sublabel: `${TOTAL_RPS.toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "router",
      label: "Traffic splitter",
      kind: "lb" as const,
      health: overall,
      utilization: clamp(values.weight),
      throughput: TOTAL_RPS,
      capacity: TOTAL_RPS,
      sublabel: `${percent(values.weight * 100)} to canary`,
      meta: { view: "flow" },
    },
    {
      id: "flow-control",
      label: "Control",
      kind: "service" as const,
      health: control,
      throughput: values.controlTraffic,
      capacity: TOTAL_RPS,
      sublabel: "stable version",
      meta: { view: "flow" },
    },
    {
      id: "flow-canary",
      label: "Canary",
      kind: "service" as const,
      health: canary,
      throughput: values.canaryTraffic,
      capacity: TOTAL_RPS,
      sublabel: "new version",
      meta: { view: "flow" },
    },
    {
      id: "flow-gate",
      label: "Metric gate",
      kind: "service" as const,
      health: gate,
      sublabel: gateLabel.toLowerCase(),
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("clients-router", "clients", "router", 1, overall),
      edge("router-control", "router", "flow-control", clamp(1 - values.weight), control),
      edge("router-canary", "router", "flow-canary", clamp(values.weight), canary),
      edge("canary-gate", "flow-canary", "flow-gate", clamp(values.weight), gate),
    ],
    metrics: [
      metric("canary-error-rate", "Canary error rate", values.canaryError, "%", 1, 5, "percent"),
      metric("blended-error-rate", "Blended service error", values.blendedError, "%", 1, 3, "percent"),
      metric("control-error-rate", "Control error rate", values.controlError, "%", 1, 3, "percent"),
      metric("user-impact", "User-facing error share", values.userImpact, "%", 0.5, 2, "percent"),
      metric("canary-requests", "Canary requests", values.canaryTraffic, " rps", undefined, undefined, "rps"),
      metric("p99-latency", "Canary p99", values.p99, "ms", 300, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, gatePass: values.gatePass ? 1 : 0 },
    summary: `${percent(values.weight * 100)} canary · canary errors ${percent(values.canaryError)} · blended ${percent(values.blendedError)} · gate ${gateLabel.toLowerCase()}`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const ids = ["canary-error-rate", "blended-error-rate", "control-error-rate", "user-impact", "canary-requests", "p99-latency"];
  for (const id of ids) {
    const item = frame.metrics.find((entry) => entry.id === id);
    if (!item) continue;
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      if (item.value === 0) return 0;
      return Math.max(0, item.value * (0.97 + 0.03 * Math.sin((index + (seed % 5)) / 2.7)));
    });
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "canary-error-rate",
    metricId: "canary-error-rate",
    warn: 1,
    crit: 5,
    title: "The canary is failing its own error gate",
    cause:
      "The new version is returning more errors than the gate allows. If the promotion decision uses a blended service rate, stable traffic can dilute this signal and make the canary look healthy.",
    fix:
      "Stop promotion and compare canary errors with control errors directly. Roll back if the canary is worse by the agreed margin, and fix the defect before retrying.",
    checkFirst: [
      "Compare canary and control error rates at the same timestamps.",
      "Check whether the blended rate is hiding the per-version rate.",
      "Check the canary request count, because a rate without samples is weak evidence.",
    ],
  },
  {
    id: "blended-error-rate",
    metricId: "blended-error-rate",
    warn: 1,
    crit: 3,
    title: "The blended service error rate is above its gate",
    cause:
      "The canary error rate is high enough that it has moved the whole service beyond the gate, or the control version is already failing. A large canary share makes the blend more sensitive; a small share makes it less sensitive.",
    fix:
      "Stop promotion and separate the two versions. If the canary is the cause, roll back. If the control is the cause, the canary may be exposing an existing problem and the baseline is wrong.",
    checkFirst: [
      "Split the error rate by version.",
      "Check whether the failure exists on the control before the canary started.",
      "Check the canary traffic share used in the blend.",
    ],
  },
  {
    id: "control-error-rate",
    metricId: "control-error-rate",
    warn: 1,
    crit: 3,
    title: "The control version is not a healthy baseline",
    cause:
      "The control is returning errors, so a comparison between canary and control is contaminated. A canary cannot prove a regression against a baseline that is already sick.",
    fix:
      "Fix or stabilize the control before evaluating the canary. If the service is already in an incident, stop the rollout and treat the incident separately.",
    checkFirst: [
      "Check control errors before the canary started.",
      "Check whether both versions share the failing dependency.",
      "Check whether the SLO is already burning.",
    ],
  },
  {
    id: "user-impact",
    metricId: "user-impact",
    warn: 0.5,
    crit: 2,
    title: "Canary errors are a material share of user requests",
    cause:
      "The canary error rate multiplied by the canary traffic share is high enough to affect the whole user base. A small slice of a very bad release can still be a large absolute error count.",
    fix:
      "Reduce the canary share or stop the rollout. Blast radius is a product of error rate and exposure, not error rate alone.",
    checkFirst: [
      "Multiply canary error rate by canary traffic share.",
      "Check absolute error count, not only percentage.",
      "Check whether a larger canary would cross the blended gate.",
    ],
  },
  {
    id: "p99-latency",
    metricId: "p99-latency",
    warn: 300,
    crit: 800,
    title: "The canary tail is above its latency gate",
    cause:
      "The new version is slower, or errors and retries are adding time. A canary can pass an error gate while its tail is outside the SLO.",
    fix:
      "Gate on per-version p99 as well as error rate. Stop promotion and investigate the slow path before retrying.",
    checkFirst: [
      "Compare canary p99 with control p99.",
      "Check whether retries are amplifying latency.",
      "Check whether the gate window includes enough slow requests.",
    ],
  },
];

export const canaryDeploymentsModel: SimModel = {
  id: "deployment-canary",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(values, seed);
    seedSeries(frame, seed);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const next = buildFrame(values, seed);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    next.series = Object.fromEntries(Object.entries(frame.series).map(([seriesKey, valuesAtKey]) => [seriesKey, [...valuesAtKey]]));
    if (frame.flags.paramsKey !== key) {
      next.series = {};
      seedSeries(next, seed);
      next.flags.paramsKey = key;
    }
    const jitter = rng.between(-1, 1) * Math.min(1, Math.max(0, dt) * 10) * 4;
    next.metrics = next.metrics.map((item) =>
      item.id === "p99-latency" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines: string[] = [];
    lines.push(
      `The canary carries ${percent(values.weight * 100)} of ${TOTAL_RPS.toLocaleString()} rps. Its error rate is ${percent(values.canaryError)}; the control is ${percent(values.controlError)}.`,
    );
    lines.push(
      `The blended service rate is ${percent(values.blendedError)} because ${percent((1 - values.weight) * 100)} of traffic still goes to the control. A blended gate can pass while the canary is far above the same threshold.`,
    );
    if (values.blindSpot) {
      lines.push(
        `The gate passes at ${percent(values.blendedError)}, but the canary is ${percent(values.canaryError)}. This is the dilution failure: the gate is measuring the average of two populations, not the release.`,
      );
    } else if (!values.gatePass) {
      lines.push("The gate blocks promotion and the blast radius stays at the canary share. A blocked promotion is a successful gate, not an incident.");
    } else {
      lines.push("The gate passes, but promotion still needs enough samples, a latency gate, and a capacity check at the target scale.");
    }
    lines.push(
      `User-facing errors caused by the canary are ${percent(values.userImpact)} of all requests. Small shares reduce blast radius but also reduce the sample available for a decision.`,
    );
    return lines;
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
    description: "A 5 percent canary at 0.1 percent errors against a 0.1 percent control.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak slice",
    description: "A 25 percent canary at 2 percent errors. The canary and gate enter the warning band.",
    tone: "warn",
    params: defaults({ canaryWeightPercent: 25, canaryErrorPercent: 2 }),
  },
  {
    id: "failure",
    label: "Diluted gate",
    description: "A 5 percent canary at 8 percent errors. The blended rate is below the gate, so promotion passes.",
    tone: "crit",
    params: defaults({ canaryWeightPercent: 5, canaryErrorPercent: 8, gateThresholdPercent: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The canary defect is fixed and the release is back at baseline.",
    tone: "ok",
    params: defaults({ canaryWeightPercent: 5, canaryErrorPercent: 0.1, gateThresholdPercent: 1 }),
  },
  {
    id: "large-slice",
    label: "Large slice",
    description: "A 50 percent canary at 8 percent errors. The blended rate crosses the gate and promotion is blocked.",
    tone: "crit",
    params: defaults({ canaryWeightPercent: 50, canaryErrorPercent: 8, gateThresholdPercent: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-diluted-gate",
  title: "Predict what the gate decides",
  simId: "canary-release",
  question:
    "A 5 percent canary reports an 8 percent error rate. The control reports 0.1 percent. The promotion gate compares the blended service error rate with a 1 percent threshold. Does the gate pass?",
  prediction: {
    options: [
      { id: "pass", label: "Pass. The blended rate is about 0.5 percent, below the 1 percent gate" },
      { id: "block", label: "Block. Eight percent is above the gate regardless of traffic share" },
      { id: "pass-sample", label: "Pass only if the canary has enough samples" },
      { id: "block-control", label: "Block because the control is above the gate" },
    ],
    correctOptionId: "pass",
    explanation:
      "The blended rate is 5 percent of 8 percent plus 95 percent of 0.1 percent, which is about 0.5 percent. That is below the 1 percent gate. The per-version rate is 8 percent, so the gate is passing a canary that is failing badly. This is dilution, not a good release.",
  },
  setup: defaults({ canaryWeightPercent: 5, canaryErrorPercent: 8, gateThresholdPercent: 1 }),
  runFor: 20,
  observe: [
    "Canary error rate is 8 percent and the blended rate is about 0.5 percent.",
    "The promotion gate shows PASS because it compares the blended rate.",
    "User-facing errors from the canary are about 0.4 percent of all requests.",
    "The canary p99 is above the latency gate, so a second gate would already object.",
  ],
  explain:
    "A gate that measures the whole service is answering a different question from a gate that measures the release. When the canary share is small, stable traffic dominates the blend and a severe canary regression becomes a small average. The fix is to compare per-version rates with the control and to require enough canary requests for the comparison to mean something. A small slice limits blast radius; it does not make the decision more sensitive.",
  fix: defaults({ canaryWeightPercent: 5, canaryErrorPercent: 0.1, gateThresholdPercent: 1 }),
  debrief:
    "With the defect fixed, the canary and control both sit near 0.1 percent and the gate passes for the right reason. The cost is that a 5 percent slice gives fewer samples than a larger slice; for a low-traffic service, the gate may need a longer window or a controlled load test. The gate design should be fixed before the next release, because a clean run does not prove the gate would catch a bad one.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A canary deployment sends a small share of production traffic to the new version while the control version serves the rest. The team compares signals from both versions and decides whether to promote the canary, hold it, or roll it back. The traffic slice limits how many users can be affected, so a bad release produces a smaller incident than a full rollout.",
  },
  {
    type: "p",
    text: "The gate is the decision. It must compare the canary with the control on the signal that matters, with enough samples to distinguish a real regression from noise. A gate that looks at the blended service error rate is measuring the average of two populations. When the canary share is small, stable traffic can dilute a severe canary failure until the average looks acceptable.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The traffic splitter sits at the load balancer, service mesh, or gateway. It routes requests by weight, header, cookie, or another stable key. The deployment controller manages the canary instances; the metrics pipeline tags per-version signals. Shared dependencies, caches, and databases see both versions at once, so a canary is not isolated from the system it is testing.",
  },
  {
    type: "p",
    text: "This model uses an illustrative 20,000 rps service and a gate that compares the blended error rate. The error rates, gate threshold, and latency curve are teaching values. The shape is the lesson: per-version signals answer whether the release is healthy; blended signals answer how much of the whole service is affected. Those are different questions.",
  },
  {
    type: "table",
    headers: ["Signal", "Question it answers", "What it can hide"],
    rows: [
      ["Canary error rate", "Is the new version failing its own requests?", "Absolute user impact when the slice is small"],
      ["Control error rate", "Is the baseline healthy enough to compare?", "A pre-existing incident"],
      ["Blended error rate", "How much of all traffic is failing?", "A severe regression on a small canary share"],
      ["Canary request count", "Is the sample large enough to decide?", "Nothing by itself, but it bounds confidence"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Canary traffic share and the resulting request rate.",
      "Canary, control, and blended error rates side by side.",
      "The promotion gate verdict and the signal it used.",
      "User-facing error share: canary error rate times canary traffic share.",
      "Canary 99th-percentile latency (p99) as a second gate dimension.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Diluted gate. Read the canary error rate before the blended rate: the gate says PASS while the canary is failing. Apply Large slice to see the same defect cross the blended gate. Use the experiment to predict the verdict, then apply Recovery.",
  },
  {
    type: "p",
    text: "The break condition is canary errors diluted by stable traffic. A 5 percent canary at 8 percent errors produces a blended rate near 0.5 percent: the canary is ten times worse than the gate, but the average passes. The gate has not protected the release; it has averaged the release with the control. A per-version comparison, a larger sample, or both would catch it.",
  },
  { type: "sim", simId: "canary-release" },
  { type: "experiment", experimentId: "predict-diluted-gate" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the diluted-gate preset, the canary served 5 percent of traffic with an 8 percent error rate. The control served 95 percent at 0.1 percent. The blended rate was about 0.5 percent, below the 1 percent gate, so promotion passed. The canary was failing badly and the gate could not see it, because the gate was measuring the whole service rather than the release.",
  },
  {
    type: "p",
    text: "The large-slice preset showed the other side of the same trade. At 50 percent, the same 8 percent canary error rate produced a blended rate above 4 percent, so the gate blocked promotion. The gate became sensitive because the canary was a larger share of the average, not because the release changed. Slice size changes the decision even when the defect does not.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-version request count, error rate, and latency from the load balancer or mesh.",
      "The gate's actual query and threshold, including whether it filters by version.",
      "The canary deployment event and the traffic weight at each step.",
      "SLO burn and absolute error count, not only percentages.",
      "Shared dependency health while both versions run.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the canary error rate with the control before reading the blended rate. Check the canary request count and the gate query. If the gate uses a service-wide average, fix the gate before trusting a pass. A small slice limits blast radius; it does not make a diluted signal trustworthy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop promotion and compare per-version signals at the same timestamps.",
      "If the canary is worse than the control by the agreed margin, roll back.",
      "Rewrite the gate to filter by version and to require a minimum sample.",
      "Add a latency gate and a capacity check at the target scale.",
      "Choose a slice large enough for the effect you need to detect, within the blast-radius budget.",
      "For low-traffic services, extend the window or use a controlled load test instead of promoting on a handful of requests.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A small canary limits blast radius but produces a small sample and a diluted blended rate.",
      "A large canary improves sensitivity but exposes more users to a bad release.",
      "A longer gate window improves confidence but slows delivery and may cross a traffic cycle.",
      "Per-version metrics require consistent tagging and enough cardinality; a blended dashboard is easier but answers a different question.",
      "Rollback is fast only while the previous version and schema remain compatible.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "canary-gate-design",
    question:
      "A release has a bug that affects 1 percent of requests. How does a canary help, and what gate would you use?",
    difficulty: 2,
    hints: [
      "Blast radius and detection are different properties.",
      "A gate on the whole service can average away a small canary.",
      "A rate needs a sample count.",
    ],
    answer:
      "The canary limits exposure to a small traffic share, so the bug affects fewer users while I measure it. I would gate on the canary error rate and latency compared with the control, not on the blended service rate, and I would require enough canary requests to detect a one percentage point difference. I would also check absolute error count and SLO burn, because a small percentage on a high-traffic service can still be many users. Promotion happens only when the per-version signals are within the agreed margin.",
    followUps: [
      "How large would you make the canary?",
      "What if the service receives only 100 requests per minute?",
      "Which signal would you trust least?",
    ],
    redFlags: [
      "Uses a service-wide error rate as the only gate.",
      "Promotes on a percentage without a sample count.",
      "Ignores latency and saturation.",
    ],
    rubric: [
      "Separates blast radius from detection.",
      "Gates on per-version signals.",
      "Requires a sample.",
      "Includes absolute impact.",
    ],
  },
  {
    id: "dilution",
    question:
      "The canary has 5 percent of traffic and an 8 percent error rate. The service error rate is 0.5 percent and the gate passes. What went wrong?",
    difficulty: 2,
    hints: [
      "The gate is averaging two populations.",
      "Stable traffic dominates the blend at a 5 percent share.",
      "Per-version queries fix the measurement, not the release.",
    ],
    answer:
      "The gate is measuring the blended service error rate, so 95 percent of healthy control traffic dilutes the canary's 8 percent. The gate proves that most traffic is healthy, not that the release is healthy. I would compare the canary with the control directly, add a per-version filter to the gate query, and require a minimum sample. The release still needs to be rolled back or fixed.",
    followUps: [
      "Would a 25 percent canary have caught it?",
      "How do you express this as a confidence interval?",
      "What would you change in the dashboard?",
    ],
    redFlags: [
      "Concludes the release is safe because the average is low.",
      "Raises the gate threshold instead of filtering by version.",
      "Ignores the canary sample.",
    ],
    rubric: [
      "Explains dilution.",
      "Names the per-version fix.",
      "Keeps the release decision separate.",
      "Mentions sample size.",
    ],
  },
  {
    id: "slice-size",
    question:
      "How do you choose the canary traffic share and duration?",
    difficulty: 3,
    hints: [
      "Start from the smallest effect you need to detect.",
      "Baseline error rate and traffic rate determine the sample.",
      "The blast-radius budget caps the share.",
    ],
    answer:
      "I start with the smallest difference that matters, the baseline error rate, and the confidence I need. That gives a sample size, which I convert to a duration using the canary request rate. I cap the share by the blast-radius budget: how many users may be exposed to a bad release. If the service is too low-traffic to reach the sample in a reasonable window, I extend the window or use a controlled load test rather than promoting on noise.",
    followUps: [
      "How does a low baseline error rate change the sample?",
      "What if the canary runs over a traffic peak?",
      "When would you use a fixed-duration canary instead?",
    ],
    redFlags: [
      "Picks 5 percent because it is conventional.",
      "Ignores baseline variance.",
      "Does not connect the share to a sample.",
    ],
    rubric: [
      "Starts from effect size.",
      "Converts sample to duration.",
      "Respects blast-radius limits.",
      "Has a low-traffic fallback.",
    ],
  },
  {
    id: "failed-canary-response",
    question:
      "The canary crosses its error gate at 2 a.m. What do you do, and what do you preserve?",
    difficulty: 3,
    hints: [
      "Stop exposure first.",
      "The canary is also evidence.",
      "Check whether the control is healthy before blaming the release.",
    ],
    answer:
      "I would stop promotion and roll the canary back if the error budget is at risk. I would preserve the per-version error rate, latency, request count, deployment events, and the gate query, so the review can tell whether the gate caught the regression or the alert did. I would compare the control at the same timestamps and check shared dependencies. Then I would fix the defect and verify the gate would have caught it before the next attempt.",
    followUps: [
      "When would you hold instead of roll back?",
      "What if the control is also failing?",
      "Which signal do you put in the postmortem first?",
    ],
    redFlags: [
      "Keeps the canary at the same share while debugging.",
      "Deletes the canary before collecting evidence.",
      "Blaming the release without checking the control.",
    ],
    rubric: [
      "Stops exposure.",
      "Preserves per-version evidence.",
      "Checks the control.",
      "Feeds the result back into the gate.",
    ],
  },
];

const checklist = [
  {
    title: "Before the release",
    items: [
      "Write the gate query so it filters by version, not by the whole service.",
      "Calculate the canary sample needed for the smallest effect that matters.",
      "Set the slice size within the blast-radius budget.",
      "Add latency and saturation gates, not only errors.",
      "Confirm rollback compatibility and the previous artifact.",
    ],
  },
  {
    title: "During the canary",
    items: [
      "Compare canary and control at the same timestamps.",
      "Watch absolute error count and user-facing error share.",
      "Stop if the canary crosses the gate or the sample is too small to decide.",
      "Check shared dependencies for effects that appear only with both versions running.",
    ],
  },
  {
    title: "Before promotion",
    items: [
      "Confirm the gate used per-version data and enough samples.",
      "Check p99 and saturation at the target scale.",
      "Record the gate decision and the traffic share.",
      "Promote in steps and repeat the gate at each step.",
    ],
  },
];

const references = [
  {
    title: "Canarying Releases",
    url: "https://sre.google/workbook/canarying-releases/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Canary population, duration, metric selection, and comparison with a control.",
  },
  {
    title: "Deployment configurations",
    url: "https://docs.aws.amazon.com/codedeploy/latest/userguide/deployment-configurations.html",
    publisher: "AWS CodeDeploy",
    kind: "docs" as const,
    note: "Canary and linear traffic-shifting configurations for deployments.",
  },
  {
    title: "Automating safe, hands-off deployments",
    url: "https://aws.amazon.com/builders-library/automating-safe-hands-off-deployments/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Staged rollout, bake time, and metric gates for automated promotion.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "canary-release": {
      model: canaryDeploymentsModel,
      presets,
      instructions:
        "Start with Healthy, then apply Diluted gate. Compare the canary rate with the blended rate before trusting the gate verdict. Apply Large slice to see the same defect cross the gate. Run the experiment, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Traffic rate, gate threshold, and latency values are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-rolling",
    "deployment-canary-metric-gate",
    "deployment-traffic-shifting",
    "deployment-canary-capacity",
  ],
};
