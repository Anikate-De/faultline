import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const WEEK_HOURS = 168;
const MEAN_RPS = 2_400;
const INCIDENT_START = 100;
const INCIDENT_END = 109;
const INCIDENT_MAGNITUDE_PCT = 18;

const params: ParamSpec[] = [
  {
    id: "baselineWindowDays",
    label: "Baseline window",
    min: 1,
    max: 28,
    step: 1,
    value: 14,
    unit: " days",
    group: "Baseline",
    help: "How much history the detector uses. Less than seven days cannot learn a weekly seasonal pattern.",
    format: "count",
  },
  {
    id: "sensitivitySigma",
    label: "Detector sensitivity",
    min: 1,
    max: 6,
    step: 0.5,
    value: 3,
    unit: " sigma",
    group: "Detector",
    help: "Standard deviations from the baseline before an anomaly is called. Lower is more sensitive and noisier.",
    format: "number",
  },
  {
    id: "seasonalAmplitudePct",
    label: "Weekly peak amplitude",
    min: 0,
    max: 80,
    step: 5,
    value: 40,
    unit: "%",
    group: "Workload",
    help: "How much the normal Monday peak rises above the weekly mean. Seasonality is expected, not an incident.",
    format: "percent",
  },
  {
    id: "dataCoveragePct",
    label: "Telemetry coverage",
    min: 50,
    max: 100,
    step: 1,
    value: 98,
    unit: "%",
    group: "Data quality",
    help: "Share of expected samples that arrived. Gaps change the anomaly score and must not be treated as zero traffic.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  baselineDays: number;
  sigma: number;
  amplitude: number;
  coverage: number;
  awareness: number;
  noisePct: number;
  seasonZ: number;
  missingZ: number;
  anomalyZ: number;
  peakSeasonZ: number;
  detectedNow: boolean;
  falsePositives: number;
  seasonPages: number;
  missingPages: number;
  missed: boolean;
  coverageShortfall: number;
  observedRps: number;
  expectedRps: number;
  incidentActive: boolean;
  incidentZ: number;
}

function compute(p: Params, t: number, incidentDetected: boolean): Computed {
  const baselineDays = num(p, "baselineWindowDays", 14);
  const sigma = num(p, "sensitivitySigma", 3);
  const amplitude = num(p, "seasonalAmplitudePct", 40);
  const coverage = num(p, "dataCoveragePct", 98);
  const awareness = clamp(baselineDays / 7);
  const phase = Math.cos((2 * Math.PI * (t % WEEK_HOURS)) / WEEK_HOURS);
  const noisePct = 4 + 2 * (1 - coverage / 100);
  const seasonZ = Math.abs((amplitude * (1 - awareness) * phase) / noisePct);
  const peakSeasonZ = Math.abs((amplitude * (1 - awareness)) / noisePct);
  const missingZ = coverage < 85 ? (85 - coverage) / 8 : 0;
  const incidentActive = t >= INCIDENT_START - 1e-6 && t <= INCIDENT_END;
  const incidentZ = INCIDENT_MAGNITUDE_PCT / noisePct;
  const anomalyZ = Math.max(seasonZ, missingZ, incidentActive ? incidentZ : 0);
  const seasonPages = peakSeasonZ > sigma ? Math.round(peakSeasonZ - sigma) : 0;
  const missingPages = coverage < 85 ? Math.ceil((85 - coverage) / 5) : 0;
  const detectedNow = incidentActive && incidentZ >= sigma && coverage >= 85;
  const observedFactor = 1 + (amplitude / 100) * phase + (incidentActive ? INCIDENT_MAGNITUDE_PCT / 100 : 0);
  const expectedFactor = 1 + (amplitude / 100) * awareness * phase;
  return {
    baselineDays,
    sigma,
    amplitude,
    coverage,
    awareness,
    noisePct,
    seasonZ,
    peakSeasonZ,
    missingZ,
    anomalyZ,
    detectedNow,
    falsePositives: seasonPages + missingPages,
    seasonPages,
    missingPages,
    missed: t > INCIDENT_END && !incidentDetected && !detectedNow,
    coverageShortfall: 100 - coverage,
    observedRps: MEAN_RPS * observedFactor,
    expectedRps: MEAN_RPS * expectedFactor,
    incidentActive,
    incidentZ,
  };
}

function detectorHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.missed || values.falsePositives >= 6) return "crit";
  if (values.falsePositives >= 2) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, incidentDetected: boolean, seed: number): SimFrame {
  const values = compute(p, t, incidentDetected);
  const detector = detectorHealth(values);
  const pagerHealth: "ok" | "warn" | "crit" = values.detectedNow ? "crit" : detector;
  const coverageHealth: "ok" | "warn" | "crit" =
    values.coverageShortfall >= 25 ? "crit" : values.coverageShortfall >= 10 ? "warn" : "ok";
  const baselineHealth: "ok" | "warn" | "crit" =
    values.awareness >= 0.9 ? "ok" : values.awareness >= 0.5 ? "warn" : "crit";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "traffic",
        label: "Service traffic",
        kind: "service",
        health: "ok",
        throughput: values.observedRps,
        sublabel: `${Math.round(values.observedRps).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "telemetry",
        label: "Telemetry pipeline",
        kind: "service",
        health: coverageHealth,
        utilization: clamp(values.coverageShortfall / 50),
        sublabel: `${values.coverage.toFixed(0)}% samples`,
        detail: `${values.coverageShortfall.toFixed(0)}% of expected samples are missing. A gap is not a drop in traffic and should not be scored as one.`,
        meta: { view: "flow" },
      },
      {
        id: "baseline",
        label: "Seasonal baseline",
        kind: "service",
        health: baselineHealth,
        utilization: clamp(values.awareness),
        sublabel: `${values.baselineDays} days, ${(values.awareness * 100).toFixed(0)}% of a week`,
        detail: "A baseline shorter than seven days cannot represent a weekly peak. The detector will call the normal peak anomalous.",
        meta: { view: "flow" },
      },
      {
        id: "detector",
        label: "Anomaly detector",
        kind: "service",
        health: detector,
        utilization: clamp(values.anomalyZ / 10),
        sublabel: `${values.anomalyZ.toFixed(1)} sigma, ${values.sigma.toFixed(1)} limit`,
        detail: `${values.falsePositives.toFixed(0)} false pages per week; ${values.missed ? "a real incident was missed" : values.detectedNow ? "a real anomaly is paging" : "no missed detection"} in this run.`,
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "On-call pager",
        kind: "worker",
        health: pagerHealth,
        sublabel: values.detectedNow ? "real anomaly page" : pagerHealth === "ok" ? "quiet" : pagerHealth === "warn" ? "weekly page" : "noisy or blind",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("traffic-telemetry", "traffic", "telemetry", 0.9, coverageHealth),
      edge("telemetry-baseline", "telemetry", "baseline", 0.8, baselineHealth),
      edge("baseline-detector", "baseline", "detector", 0.8, detector),
      edge("telemetry-detector", "telemetry", "detector", 0.8, detector),
      edge("detector-pager", "detector", "pager", 0.7, pagerHealth),
    ],
    metrics: [
      metric("false-positive-pages", "False-positive pages", values.falsePositives, " / week", 2, 6, "count"),
      metric("missed-detections", "Missed detections", values.missed ? 1 : 0, "", 0.5, 0.5, "number"),
      metric("coverage-shortfall", "Coverage shortfall", values.coverageShortfall, "%", 10, 25, "percent"),
      metric("anomaly-score", "Anomaly score", values.anomalyZ, " sigma", undefined, undefined, "number"),
      metric("real-anomaly-page", "Real anomaly page", values.detectedNow ? 1 : 0, "", 0.5, 0.5, "number"),
      metric("observed-load", "Observed load", values.observedRps, " rps", undefined, undefined, "rps"),
      metric("expected-load", "Expected baseline", values.expectedRps, " rps", undefined, undefined, "rps"),
      metric("detector-pages", "Detector pages", values.falsePositives + (values.detectedNow ? 1 : 0), " / week", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      incidentDetected: incidentDetected ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.falsePositives.toFixed(0)} false pages per week at ${values.anomalyZ.toFixed(1)} sigma; baseline covers ${(values.awareness * 100).toFixed(0)}% of a week; ${values.coverage.toFixed(0)}% telemetry coverage.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const offset = seed % 8;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.92 + 0.16 * Math.sin((index + offset) / 2.2))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "false-positive-pages",
    metricId: "false-positive-pages",
    warn: 2,
    crit: 6,
    title: "The detector pages on normal seasonality",
    cause:
      "The baseline is shorter than the weekly cycle, so Monday's normal peak looks like a deviation. Missing samples can add another false signal when a gap is scored as zero traffic.",
    fix:
      "Use a baseline that covers at least a full week, exclude gaps from scoring, and require a coverage guardrail before the detector is allowed to page.",
    checkFirst: [
      "Plot observed load against the expected baseline for the same hour last week.",
      "Check the baseline window and whether it includes a full weekly cycle.",
      "Check telemetry coverage at the page time; a gap is not a traffic drop.",
    ],
  },
  {
    id: "missed-detections",
    metricId: "missed-detections",
    warn: 0.5,
    crit: 0.5,
    title: "A real anomaly passed without a page",
    cause:
      "The sensitivity or the coverage guardrail suppressed a real deviation. A detector tuned only to reduce false positives can become quiet for the wrong reason.",
    fix:
      "Lower the threshold, add a second signal, or require a coverage-aware fallback. Measure missed incidents against a known list, not against page count.",
    checkFirst: [
      "Compare the incident window with the detector score and the threshold.",
      "Check whether coverage was low enough to suppress evaluation.",
      "Check whether the baseline absorbed the change and treated it as normal.",
    ],
  },
  {
    id: "real-anomaly-page",
    metricId: "real-anomaly-page",
    warn: 0.5,
    crit: 0.5,
    title: "A real deviation is paging",
    cause:
      "The anomaly score includes the current incident deviation and is above the sensitivity limit. A seasonal peak alone would not produce this score at a full-cycle baseline.",
    fix:
      "Keep the page, confirm the deviation against the same hour last week, and check coverage. Do not tune the detector until the real incident is understood.",
    checkFirst: [
      "Compare the observed load with the expected baseline for the same hour last week.",
      "Check telemetry coverage at the page time.",
      "Check whether the deviation persists across the next few samples.",
    ],
  },
  {
    id: "coverage-shortfall",
    metricId: "coverage-shortfall",
    warn: 10,
    crit: 25,
    title: "Telemetry coverage is too low to trust the detector",
    cause:
      "Missing samples change the mean, the variance, and the comparison. A detector that scores a gap as zero will page on the gap; one that silently skips the window will miss a real failure.",
    fix:
      "Repair collection first. Gate the detector on a minimum coverage and emit a separate data-quality alert when coverage is below it.",
    checkFirst: [
      "Check scrape failures, dropped series, and ingestion lag at the source.",
      "Compare the expected sample count with the received count for the window.",
      "Check whether the missing data is random or concentrated on one instance.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function readDetected(frame: SimFrame): boolean {
  return Number(frame.flags.incidentDetected ?? 0) === 1;
}

export const anomalyModel: SimModel = {
  id: "observability-anomaly-detection",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), 0, false, seed),
  step: (frame, p, dt) => {
    const t = frame.t + dt;
    const previousDetected = readDetected(frame);
    const values = compute(p, t, previousDetected);
    const detectedNow = values.detectedNow;
    const detected = previousDetected || detectedNow;
    const next = buildFrame(p, t, detected, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    if (values.falsePositives >= 6 && Number(frame.flags.falsePageLogged ?? 0) !== 1) {
      pushEvent(next, {
        id: "seasonal-false-page",
        at: frame.t,
        severity: "crit",
        title: "Detector pages on the normal weekly peak",
        detail: `The detector calls ${values.seasonPages.toFixed(0)} weekly peak pages and ${values.missingPages.toFixed(0)} gap pages per week. The baseline covers ${(values.awareness * 100).toFixed(0)}% of the weekly cycle and telemetry is at ${values.coverage.toFixed(0)}%.`,
        metricId: "false-positive-pages",
        nodeId: "detector",
      });
      next.flags.falsePageLogged = 1;
    }
    if (detectedNow && Number(frame.flags.detectionLogged ?? 0) !== 1) {
      pushEvent(next, {
        id: "real-anomaly-detected",
        at: frame.t,
        severity: "warn",
        title: "Real anomaly detected",
        detail: `Load deviation reached ${values.incidentZ.toFixed(1)} sigma against a ${values.sigma.toFixed(1)} sigma limit at ${values.coverage.toFixed(0)}% coverage. The page is justified because it is not a seasonal peak.`,
        metricId: "anomaly-score",
      });
      next.flags.detectionLogged = 1;
    }
    if (values.missed && Number(frame.flags.missedLogged ?? 0) !== 1) {
      pushEvent(next, {
        id: "real-anomaly-missed",
        at: frame.t,
        severity: "crit",
        title: "Real anomaly passed below the detector threshold",
        detail: `The incident deviation was ${values.incidentZ.toFixed(1)} sigma but the detector requires ${values.sigma.toFixed(1)} sigma. Reducing pages by raising the threshold also reduced detection.`,
        metricId: "missed-detections",
        nodeId: "detector",
      });
      next.flags.missedLogged = 1;
    }
    next.flags.incidentDetected = detected ? 1 : 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.falsePositives.toFixed(0)} false pages per week at ${values.anomalyZ.toFixed(1)} sigma; ${values.missed ? "a real anomaly was missed" : "no missed detection in this run"}.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, frame.t, readDetected(frame));
    return [
      `The baseline covers ${values.baselineDays} days, or ${(values.awareness * 100).toFixed(0)}% of the weekly cycle. A shorter baseline leaves a seasonal residual the detector scores as anomalous.`,
      `The detector is set at ${values.sigma.toFixed(1)} sigma and the current load is ${values.anomalyZ.toFixed(1)} sigma from the expected baseline.`,
      `Telemetry is at ${values.coverage.toFixed(0)}%, a ${values.coverageShortfall.toFixed(0)}% shortfall. Missing data is a data-quality signal, not a traffic drop.`,
      values.falsePositives > 0
        ? `At the weekly peak, about ${values.seasonPages.toFixed(0)} of the ${values.falsePositives.toFixed(0)} pages per week come from seasonality and ${values.missingPages.toFixed(0)} from gaps.`
        : "No false pages are implied by the current baseline and coverage.",
      `The real incident is ${values.incidentZ.toFixed(1)} sigma. The detector ${values.incidentZ >= values.sigma ? "can see it" : "cannot see it"} at this sensitivity.`,
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Seasonal warning", tone: "warn" },
    { label: "False positive", tone: "crit" },
    { label: "Missed incident", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A two-week baseline covers the weekly shape and telemetry is complete.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Monday peak",
    description: "A three-day baseline sees the normal 55% weekly peak as an anomaly.",
    tone: "warn",
    params: defaults({ baselineWindowDays: 3, sensitivitySigma: 3, seasonalAmplitudePct: 55, dataCoveragePct: 96 }),
  },
  {
    id: "failure",
    label: "Short baseline",
    description: "Two days of history, a noisy detector, and 60% coverage. Every Monday pages.",
    tone: "crit",
    params: defaults({ baselineWindowDays: 2, sensitivitySigma: 2, seasonalAmplitudePct: 60, dataCoveragePct: 60 }),
  },
  {
    id: "numb",
    label: "Numb detector",
    description: "A six-sigma threshold keeps the pager quiet and misses a real deviation.",
    tone: "warn",
    params: defaults({ baselineWindowDays: 14, sensitivitySigma: 6, seasonalAmplitudePct: 40, dataCoveragePct: 98 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A three-week baseline, four-sigma threshold, and near-complete coverage.",
    tone: "ok",
    params: defaults({ baselineWindowDays: 21, sensitivitySigma: 4, seasonalAmplitudePct: 40, dataCoveragePct: 99 }),
  },
];

const experiment: Experiment = {
  id: "predict-monday-page",
  title: "Predict why Monday pages",
  simId: "anomaly",
  question:
    "The detector pages every Monday at 9 a.m. and load looks normal for that hour. The baseline uses three days of history. What is the most likely cause?",
  prediction: {
    options: [
      { id: "seasonality", label: "The baseline is shorter than the weekly cycle, so the normal peak looks anomalous" },
      { id: "traffic", label: "Traffic is genuinely higher and the service is failing" },
      { id: "sensitivity", label: "The detector threshold is too high and it is paging late" },
      { id: "coverage", label: "Coverage is too high, so the detector sees every normal sample" },
    ],
    correctOptionId: "seasonality",
    explanation:
      "A three-day baseline cannot contain a full weekly cycle. Monday's 55% peak is compared with a flat recent average, so it looks like a large deviation. The same load is expected at that hour and should be part of the baseline. A longer window, or an explicit seasonal model, removes the page without lowering the threshold.",
  },
  setup: defaults({ baselineWindowDays: 3, sensitivitySigma: 3, seasonalAmplitudePct: 55, dataCoveragePct: 96 }),
  runFor: 120,
  observe: [
    "The detector score is above the threshold at the Monday peak even though load follows the normal weekly shape.",
    "Several false pages per week come from seasonality, not from a real incident.",
    "At 100 simulated hours a real 18% deviation appears; the detector can still see it.",
    "Extending the baseline to two weeks removes the seasonal pages without changing the real detection.",
  ],
  explain:
    "An anomaly is a deviation from an expectation. If the expectation omits a known weekly pattern, the pattern becomes the anomaly. Sensitivity is not the first control to change; the baseline has to represent the cycle. Missing data adds a second false signal because a gap is not a traffic drop.",
  fix: defaults({ baselineWindowDays: 14, sensitivitySigma: 3, seasonalAmplitudePct: 55, dataCoveragePct: 98 }),
  debrief:
    "The longer baseline removes the Monday page and keeps the real deviation visible. The tradeoff is that a two-week baseline adapts more slowly to a real level shift, so a step change can take longer to separate from normal variation. Coverage still needs its own guardrail: a detector that treats missing data as zero will page on the gap, and one that silently skips the window will miss the incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Anomaly detection compares a time series with an expectation and scores the difference. The expectation can be a moving average, a seasonal model, or a learned baseline. The score is usually expressed in standard deviations, so a three-sigma point is far from the baseline relative to normal variation. The detector is a statistical tool, not a definition of an incident.",
  },
  {
    type: "p",
    text: "The failure mode is easy to predict. Traffic peaks every Monday at 9 a.m. If the baseline uses the last three days, it has never seen a Monday. The peak looks like a deviation. The detector pages, the team investigates, and nothing is wrong. The next Monday it happens again. The page is statistically correct and operationally useless.",
  },
  {
    type: "p",
    text: "Missing data creates a second trap. A gap is not a drop to zero, but a naive detector may score it as one. A cautious detector may skip the window and miss a real failure. Either way, the detector needs a coverage guardrail that is separate from the anomaly threshold.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is the workload, then telemetry collection, then a baseline model, then the anomaly scorer, then the paging rule. The baseline sits between collection and scoring because the same observation can be normal or anomalous depending on what the model expects. Coverage sits beside the path as a data-quality gate; it should be able to stop a page as well as explain one.",
  },
  {
    type: "table",
    headers: ["Input", "What it changes", "Common mistake"],
    rows: [
      ["Baseline window", "What the detector expects", "Shorter than the seasonal period"],
      ["Sensitivity", "How far a point must be to page", "Lowering it to catch a real incident"],
      ["Seasonality", "The shape of normal load", "Treating every peak as an anomaly"],
      ["Coverage", "Whether the window is trustworthy", "Scoring a gap as zero traffic"],
      ["Guardrail", "Whether the detector may page", "Adding more alerts instead of fixing data"],
    ],
  },
  {
    type: "p",
    text: "This module compresses one hour into one simulated second. A week is 168 seconds. The detector starts at the Monday peak so the seasonal error is visible immediately. The load, noise, and incident magnitude are illustrative teaching values, not a vendor model or a claim about a specific service.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Observed load and the expected baseline, so a normal Monday can be compared with what the detector expects.",
      "An anomaly score in sigma against the sensitivity limit.",
      "False-positive pages per week, split into seasonal and missing-data causes in the explanation.",
      "A coverage shortfall metric and a data-quality node.",
      "A missed-detection flag when the detector is too numb to see the real deviation.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Monday peak. Watch the score rise at the weekly peak even though the shape is normal. Shorten the baseline and increase the amplitude to make it worse. Then run the experiment, extend the baseline, and compare the false pages with the real detection at 100 seconds.",
  },
  {
    type: "compare",
    leftTitle: "Statistical anomaly",
    rightTitle: "Incident",
    rows: [
      { label: "Definition", left: "A deviation from the model", right: "A user-visible failure or risk" },
      { label: "Evidence", left: "Distance from the baseline", right: "SLO impact, errors, latency, or loss" },
      { label: "Can be normal", left: "Yes, if the model omits seasonality", right: "No, by definition" },
      { label: "Action", left: "Investigate or add context", right: "Page and mitigate" },
    ],
  },
  { type: "sim", simId: "anomaly" },
  { type: "experiment", experimentId: "predict-monday-page" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The three-day baseline compared the Monday peak with a flat recent average. The peak was a normal part of the weekly cycle, but the model had never seen it, so it scored as an anomaly. The detector paged on schedule. Extending the baseline to two weeks removed the page without changing the real deviation later in the run.",
  },
  {
    type: "p",
    text: "The coverage control showed the second failure mode. At 60% coverage the detector produced gap pages, and the data-quality node turned critical. A detector that treats a gap as zero traffic pages on missing data; one that skips the window can miss a real incident. The guardrail has to be explicit either way.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Datadog anomaly monitors: the monitor graph shows the observed series, the expected range, and the anomaly score. Check the evaluation window and the seasonality setting.",
      "Prometheus and Grafana: `predict_linear` or a seasonal baseline computed from the same time last week, plus a panel that shows observed against expected.",
      "CloudWatch: anomaly detection bands on a metric, with the band width and the alarm threshold visible. A band that is too narrow pages on normal variation.",
      "Telemetry pipeline: sample counts, scrape failures, and ingestion lag. Coverage is a first-class signal, not an assumption.",
      "Incident review: compare detector pages with the incident list. A detector can be quiet and still be wrong.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Plot the observed series against the same hour last week before you change the threshold. Check the baseline length and whether it covers a full cycle. Check coverage at the page time. Then compare the detector's page list with the incident list to see whether sensitivity is buying detection or only quiet.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the anomaly is not a known seasonal peak by comparing with the same hour last week.",
      "Use a baseline that covers at least one full weekly cycle, or add an explicit seasonal term.",
      "Gate the detector on telemetry coverage and emit a separate data-quality alert when coverage is low.",
      "Measure false positives and missed detections together. Tune sensitivity against both.",
      "Attach a second, independent signal to the page when the cost of a miss is high.",
      "Review the detector against the incident log after each change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A longer baseline captures seasonality but adapts slowly to a real level shift.",
      "A shorter baseline adapts quickly and sees normal cycles as anomalies.",
      "Lower sensitivity catches smaller deviations and increases false pages.",
      "Higher sensitivity reduces noise and can hide a real incident without any visible failure.",
      "A coverage guardrail prevents gap pages and can suppress detection during a partial outage.",
      "A statistical anomaly is not an incident. The page still needs an impact signal or a human review path.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "critique-anomaly-alert",
    question:
      "The detector pages every Monday at 9 a.m. and the load is normal for that hour. How do you critique the alert?",
    difficulty: 2,
    hints: [
      "An anomaly is relative to an expectation.",
      "Check whether the baseline contains a full weekly cycle.",
    ],
    answer:
      "The alert is detecting the model's blind spot, not an incident. A three-day baseline cannot represent a weekly peak, so Monday looks like a deviation. I would compare the observed series with the same hour last week, check the baseline window, and add a seasonal term or a longer baseline. I would not raise the threshold first, because that would hide the real deviation too. The page should also carry an impact signal so a statistical outlier does not wake someone by itself.",
    followUps: [
      "What baseline length would you choose?",
      "How would you validate the change?",
      "What would you do if the peak is growing week over week?",
    ],
    redFlags: [
      "Raises the threshold to silence Monday.",
      "Treats the anomaly as an incident without impact.",
      "Ignores the weekly cycle.",
    ],
    rubric: [
      "Identifies the seasonal baseline gap.",
      "Compares with last week.",
      "Avoids threshold-only tuning.",
      "Adds an impact signal.",
    ],
  },
  {
    id: "missing-data",
    question:
      "Telemetry coverage drops to 60% during a partial outage. How should the anomaly detector behave?",
    difficulty: 3,
    hints: [
      "A gap is not a zero.",
      "A detector that skips the window can miss the failure.",
    ],
    answer:
      "The detector should not score a gap as zero traffic. It should require a minimum coverage before evaluating, and it should emit a separate data-quality alert when coverage is below that minimum. If it silently skips the window, it can miss a real failure during the same period. I would also check whether the missing samples are random or concentrated on one instance, because a biased gap changes the baseline. The honest output is an explicit data-quality state, not a confident anomaly score.",
    followUps: [
      "What minimum coverage would you require?",
      "How do you distinguish random from biased missingness?",
      "Should the data-quality alert page?",
    ],
    redFlags: [
      "Fills gaps with zero.",
      "Skips the window silently.",
      "Trusts the anomaly score without coverage.",
    ],
    rubric: [
      "Rejects zero-fill.",
      "Adds a coverage gate.",
      "Emits a data-quality signal.",
      "Checks missingness bias.",
    ],
  },
  {
    id: "sensitivity-tradeoff",
    question:
      "How do you tune anomaly sensitivity without turning the pager into a coin flip?",
    difficulty: 3,
    hints: [
      "Measure false positives and missed detections together.",
      "A known incident list is the counterweight.",
    ],
    answer:
      "I would build a labeled set of known incidents and known normal peaks, replay the detector over that history, and measure both false positives and missed detections at each threshold. Then I would choose a point that meets the response budget, not the quietest point. I would add coverage guardrails and a second signal for high-cost misses, and I would re-run the evaluation after any baseline change. The tradeoff is explicit: lower sensitivity catches more and pages more; higher sensitivity pages less and misses more.",
    followUps: [
      "How large does the labeled set need to be?",
      "What if the incident list is incomplete?",
      "How often would you re-tune?",
    ],
    redFlags: [
      "Tunes only on page count.",
      "Uses production as the test set.",
      "Assumes the incident list is complete.",
    ],
    rubric: [
      "Measures both error types.",
      "Uses a labeled history.",
      "Adds guardrails.",
      "Re-evaluates after changes.",
    ],
  },
  {
    id: "guardrails",
    question:
      "What guardrails would you add before letting an anomaly detector page?",
    difficulty: 3,
    hints: [
      "Start with data quality and seasonality.",
      "A page needs an impact or a clear action.",
    ],
    answer:
      "I would require minimum coverage, a baseline that spans at least one full seasonal cycle, and a check that the deviation is not a known peak. I would attach an impact signal such as an SLO burn or an error-rate condition, or route the anomaly to a review queue rather than the pager. I would also cap page frequency per series and require an owner. The guardrails should suppress a page with a visible reason, not silently drop it.",
    followUps: [
      "Which guardrail would you add first?",
      "When would you allow an anomaly to page alone?",
      "How do you keep the guardrails from hiding a real failure?",
    ],
    redFlags: [
      "Pages on every outlier.",
      "Adds guardrails without visibility.",
      "Has no owner for the detector.",
    ],
    rubric: [
      "Names coverage and seasonality.",
      "Adds impact or review routing.",
      "Keeps suppression visible.",
      "Assigns ownership.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The baseline covers at least one full seasonal cycle for every paging series.",
      "Telemetry coverage has a minimum threshold and its own alert.",
      "The detector has an owner and a documented sensitivity choice.",
      "A labeled history of incidents and normal peaks exists for tuning.",
      "Anomaly pages have an impact signal or a review path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check coverage before trusting or dismissing the anomaly score.",
      "Compare the observed series with the same hour last week.",
      "Check whether the deviation is a known seasonal peak or a real step change.",
      "Do not raise sensitivity during the incident just to clear the pager.",
      "Record the score, threshold, baseline window, and coverage at the page time.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare the detector output with the incident list for the same window.",
      "Repair missing telemetry before re-tuning the detector.",
      "Adjust the baseline or add a seasonal term if the page was a normal peak.",
      "Re-run the labeled history and record the false-positive and miss rates.",
    ],
  },
];

const references = [
  {
    title: "Anomaly monitors",
    url: "https://docs.datadoghq.com/monitors/types/anomaly/",
    publisher: "Datadog",
    kind: "docs" as const,
    note: "Anomaly detection windows, seasonality, and alert conditions.",
  },
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Why statistical deviations are not automatically incidents, and how to page on impact.",
  },
  {
    title: "Alerting practices",
    url: "https://prometheus.io/docs/practices/alerting/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Alert rule design and the cost of noisy conditions.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    anomaly: {
      model: anomalyModel,
      presets,
      instructions:
        "Start Healthy, then apply Monday peak. Watch the score rise at the normal weekly peak. Compare the baseline lengths, then run the experiment and extend the window.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second is one hour; load, noise, and incident magnitude are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-alert-fatigue",
    "observability-symptom-alerting",
    "observability-slo-burn-rate",
    "observability-metrics-types",
  ],
};
