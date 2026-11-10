import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimEvent, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

interface TimelinePoint {
  id: string;
  trueAt: number;
  observe: boolean;
}

const TRUE_ORDER: TimelinePoint[] = [
  { id: "deploy", trueAt: 120, observe: true },
  { id: "error", trueAt: 180, observe: true },
  { id: "alert", trueAt: 270, observe: true },
  { id: "decision", trueAt: 720, observe: true },
  { id: "rollback", trueAt: 840, observe: true },
  { id: "recovery", trueAt: 900, observe: true },
];

const params: ParamSpec[] = [
  {
    id: "clockSkewSec",
    label: "CI host clock skew",
    min: -300,
    max: 300,
    step: 15,
    value: 5,
    unit: " s",
    group: "Clocks",
    help: "Offset between the deploy pipeline clock and the metric reference clock. Positive means the CI clock is ahead.",
    format: "count",
  },
  {
    id: "ntpSyncPct",
    label: "Hosts synced by NTP",
    min: 0,
    max: 100,
    step: 5,
    value: 98,
    unit: "%",
    group: "Clocks",
    help: "Share of hosts with working time synchronization. Unsynced hosts keep more of the skew.",
    format: "percent",
  },
  {
    id: "deployMarkerCoveragePct",
    label: "Deploy marker coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Annotations",
    help: "Share of deploy and rollback events that carry an annotation. A missing marker leaves the change invisible.",
    format: "percent",
  },
  {
    id: "correlationWindowSec",
    label: "Correlation window",
    min: 10,
    max: 300,
    step: 10,
    value: 60,
    unit: " s",
    group: "Causality",
    help: "How close two events must be before a reviewer calls one the cause. A wide window invites false causality.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  skewSec: number;
  syncPct: number;
  markerPct: number;
  windowSec: number;
  effectiveSkew: number;
  markerPresent: boolean;
  observed: Record<string, number>;
  misordered: number;
  blamedDeploy: boolean;
  unattributed: boolean;
  evidenceCoverage: number;
  reconstructMin: number;
  orderConfidence: number;
}

function compute(p: Params): Computed {
  const skewSec = num(p, "clockSkewSec", 5);
  const syncPct = num(p, "ntpSyncPct", 98);
  const markerPct = num(p, "deployMarkerCoveragePct", 100);
  const windowSec = num(p, "correlationWindowSec", 60);
  const effectiveSkew = Math.round(skewSec * (1 - syncPct / 100) * 100) / 100;
  const markerPresent = markerPct >= 50;
  const observed: Record<string, number> = {};
  for (const point of TRUE_ORDER) {
    const shifted = point.id === "deploy" || point.id === "rollback";
    observed[point.id] = point.trueAt + (shifted ? effectiveSkew : 0);
  }
  let misordered = 0;
  for (let i = 0; i < TRUE_ORDER.length; i++) {
    for (let j = i + 1; j < TRUE_ORDER.length; j++) {
      const a = TRUE_ORDER[i];
      const b = TRUE_ORDER[j];
      if (!a.observe || !b.observe) continue;
      if (!markerPresent && (a.id === "deploy" || b.id === "deploy" || a.id === "rollback" || b.id === "rollback")) continue;
      if (observed[a.id] > observed[b.id]) misordered += 1;
    }
  }
  const blamedDeploy =
    markerPresent &&
    observed.deploy > observed.error &&
    observed.deploy - observed.error <= windowSec;
  return {
    skewSec,
    syncPct,
    markerPct,
    windowSec,
    effectiveSkew,
    markerPresent,
    observed,
    misordered,
    blamedDeploy,
    unattributed: !markerPresent,
    evidenceCoverage: markerPresent ? 100 : 75,
    reconstructMin: 4 + Math.abs(effectiveSkew) / 60 + misordered * 3 + (markerPresent ? 0 : 8),
    orderConfidence: Math.max(0, 100 - misordered * 20 - (markerPresent ? 0 : 20)),
  };
}

function wall(seconds: number): string {
  const total = 14 * 3_600 + Math.round(seconds);
  const hh = Math.floor(total / 3_600) % 24;
  const mm = Math.floor((total % 3_600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

function timelineEvents(values: Computed): SimEvent[] {
  const events: SimEvent[] = [
    {
      id: "tl-error",
      at: values.observed.error,
      severity: "warn",
      title: "Error rate rises",
      detail: `Metric source records the first sustained errors at ${wall(values.observed.error)}. This is the reference clock for the reconstruction.`,
      nodeId: "metrics",
    },
    {
      id: "tl-alert",
      at: values.observed.alert,
      severity: "warn",
      title: "SLO burn alert fires",
      detail: `The pager records the alert at ${wall(values.observed.alert)}. The multipath alert was delivered after the error onset.`,
      nodeId: "pager",
    },
    {
      id: "tl-decision",
      at: values.observed.decision,
      severity: "info",
      title: "Incident commander orders rollback",
      detail: `The incident channel records the decision at ${wall(values.observed.decision)}. A decision is not the same as a deploy or a recovery.`,
      nodeId: "logs",
    },
    {
      id: "tl-recovery",
      at: values.observed.recovery,
      severity: "info",
      title: "Error rate returns to baseline",
      detail: `Metrics record recovery at ${wall(values.observed.recovery)}. The graph is the strongest evidence that the failure ended.`,
      nodeId: "metrics",
    },
  ];
  if (values.markerPresent) {
    events.push({
      id: "tl-deploy",
      at: values.observed.deploy,
      severity: values.blamedDeploy ? "crit" : "info",
      title: values.blamedDeploy ? "Deploy annotated after the error onset" : "Deploy started",
      detail: `The CI annotation is recorded at ${wall(values.observed.deploy)}. The deploy actually began at ${wall(120)}; the CI clock is offset by ${values.effectiveSkew.toFixed(0)}s.`,
      nodeId: "ci",
    });
    events.push({
      id: "tl-rollback",
      at: values.observed.rollback,
      severity: values.misordered >= 2 ? "crit" : "info",
      title: "Rollback recorded by CI",
      detail: `The rollback annotation is recorded at ${wall(values.observed.rollback)}. The true rollback began at ${wall(840)}. With the CI clock offset, it can appear after recovery.`,
      nodeId: "ci",
    });
  } else {
    events.push({
      id: "tl-missing-deploy",
      at: values.observed.error,
      severity: "warn",
      title: "No deploy annotation",
      detail: `No deploy or rollback marker exists for this window. The change is invisible, so the timeline cannot rule it in or out.`,
      nodeId: "ci",
    });
  }
  if (values.blamedDeploy) {
    events.push({
      id: "tl-blame",
      at: values.observed.deploy + 1,
      severity: "crit",
      title: "Timeline blames the deploy",
      detail: `The annotated deploy is ${(values.observed.deploy - values.observed.error).toFixed(0)}s after the error onset and inside the ${values.windowSec}s correlation window. That ordering is false; the deploy began before the failure.`,
      nodeId: "timeline",
    });
  }
  return events.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const clockHealth: "ok" | "warn" | "crit" =
    Math.abs(values.effectiveSkew) >= 120 ? "crit" : Math.abs(values.effectiveSkew) >= 30 ? "warn" : "ok";
  const timelineHealth: "ok" | "warn" | "crit" =
    values.blamedDeploy || values.unattributed
      ? "crit"
      : values.misordered > 0
        ? "warn"
        : "ok";
  const cbHealth: "ok" | "warn" | "crit" = timelineHealth;
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "metrics",
        label: "Metric store",
        kind: "service",
        health: "ok",
        utilization: 0.4,
        sublabel: "reference clock",
        detail: "Metrics establish the symptom onset and recovery. Use them as the reference when another source disagrees.",
        meta: { view: "flow" },
      },
      {
        id: "logs",
        label: "Incident log",
        kind: "service",
        health: "ok",
        utilization: 0.3,
        sublabel: "decisions and actions",
        meta: { view: "flow" },
      },
      {
        id: "ci",
        label: "Deploy pipeline",
        kind: "service",
        health: clockHealth,
        utilization: clamp(Math.abs(values.effectiveSkew) / 300),
        sublabel: `${values.effectiveSkew.toFixed(0)}s offset`,
        detail: `The CI clock is ${values.effectiveSkew >= 0 ? "ahead of" : "behind"} the metric clock by ${Math.abs(values.effectiveSkew).toFixed(0)}s after NTP sync. Deploy and rollback markers move together.`,
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "Pager",
        kind: "worker",
        health: "ok",
        sublabel: "alert delivery",
        meta: { view: "flow" },
      },
      {
        id: "timeline",
        label: "Reconstructed timeline",
        kind: "storage",
        health: timelineHealth,
        utilization: clamp(values.misordered / 5),
        sublabel: values.blamedDeploy ? "wrong cause" : `${values.misordered} misordered pairs`,
        detail: `Evidence coverage is ${values.evidenceCoverage}%. Order confidence is ${values.orderConfidence.toFixed(0)}%.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("metrics-timeline", "metrics", "timeline", 0.9, timelineHealth),
      edge("logs-timeline", "logs", "timeline", 0.8, timelineHealth),
      edge("ci-timeline", "ci", "timeline", 0.7, clockHealth),
      edge("pager-timeline", "pager", "timeline", 0.7, "ok"),
      edge("ci-pager", "ci", "pager", 0.3, cbHealth),
    ],
    metrics: [
      metric("clock-offset", "Effective clock offset", Math.abs(values.effectiveSkew), " s", 30, 120, "number"),
      metric("misordered-pairs", "Misordered pairs", values.misordered, "", 1, 2, "count"),
      metric("blamed-deploy", "Deploy blamed", values.blamedDeploy ? 1 : 0, "", 0.5, 0.5, "number"),
      metric("unattributed-change", "Unattributed change", values.unattributed ? 1 : 0, "", 0.5, 0.5, "number"),
      metric("evidence-coverage", "Evidence coverage", values.evidenceCoverage, "%", undefined, undefined, "percent"),
      metric("order-confidence", "Order confidence", values.orderConfidence, "%", undefined, undefined, "percent"),
      metric("reconstruct-time", "Reconstruction time", values.reconstructMin, " min", 8, 15, "number"),
    ],
    events: timelineEvents(values),
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${Math.abs(values.effectiveSkew).toFixed(0)}s clock offset, ${values.misordered} misordered pairs, ${values.blamedDeploy ? "deploy wrongly blamed" : "no deploy blame"}.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const offset = seed % 5;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.9 + 0.2 * Math.sin((index + offset) / 2.5))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blamed-deploy",
    metricId: "blamed-deploy",
    warn: 0.5,
    crit: 0.5,
    title: "The timeline blames a deploy that started before the failure",
    cause:
      "The deploy annotation appears after the error onset because its clock is ahead. It falls inside the correlation window, so the reviewer mistakes sequence for cause.",
    fix:
      "Correct the clock, compare the deploy start and the symptom onset, and record both times in the postmortem. A deploy that began before the failure can still be a cause, but the timeline must show the real order before anyone argues it.",
    checkFirst: [
      "Find the deploy start, not only the annotation time.",
      "Compare the symptom onset with the deploy and its rollout stages.",
      "Check whether the failure moved with the deploy across instances.",
    ],
  },
  {
    id: "clock-offset",
    metricId: "clock-offset",
    warn: 30,
    crit: 120,
    title: "Clock offset needs a timeline note",
    cause:
      "The deploy pipeline clock is not fully synchronized with the metric reference. A 30-second offset can still leave the order correct, but it is enough to make a close call wrong once the correlation window is narrow or the deploy and error times are close. At larger offsets the order can flip outright.",
    fix:
      "Synchronize the hosts with NTP, record the offset, and prefer the metric clock for symptom onset and recovery. Treat a disagreeing source as uncertain, not as a second truth.",
    checkFirst: [
      "Compare the CI timestamp with the metric timestamp for the same deploy.",
      "Check NTP sync and the offset on the hosts that emit annotations.",
      "Compare the event order before and after correcting the clock.",
    ],
  },
  {
    id: "misordered-pairs",
    metricId: "misordered-pairs",
    warn: 1,
    crit: 2,
    title: "Recorded event order disagrees with the causal order",
    cause:
      "Two sources with different clocks are being merged without normalization. The reconstruction shows a deploy after the error even though the deploy began first, or a rollback after recovery.",
    fix:
      "Normalize every source to one reference clock, mark the untrusted timestamps, and rebuild the order. If the true order cannot be recovered, state the uncertainty instead of inventing a cause.",
    checkFirst: [
      "List each event with its source and clock offset.",
      "Identify which pairs flipped and by how much.",
      "Check whether the deploy duration explains the disagreement rather than the clock.",
    ],
  },
  {
    id: "unattributed-change",
    metricId: "unattributed-change",
    warn: 0.5,
    crit: 0.5,
    title: "A change happened without a timeline annotation",
    cause:
      "Deploy or rollback events were not emitted, or the annotation coverage is too low. The timeline cannot rule the change in or out, so the reviewer fills the gap with a guess.",
    fix:
      "Emit deploy markers from the pipeline, include rollbacks and configuration changes, and link each annotation to the change record. Treat missing markers as an evidence gap in the postmortem.",
    checkFirst: [
      "Check the pipeline event stream for the deploy and rollback.",
      "Check whether the annotation was emitted but filtered out.",
      "Compare the change record with the timeline window.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const timelineModel: SimModel = {
  id: "observability-incident-timeline",
  visual: "timeline",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = next.events
      .filter((event) => event.id.startsWith("tl-"))
      .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
      .slice(-20);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The CI clock is ${values.effectiveSkew >= 0 ? "ahead" : "behind"} the metric clock by ${Math.abs(values.effectiveSkew).toFixed(0)}s after NTP sync.`,
      `${values.markerPresent ? "Deploy markers are present" : "Deploy markers are missing"}, so evidence coverage is ${values.evidenceCoverage}%.`,
      `${values.misordered} pairs are out of order. The timeline ${values.blamedDeploy ? "blames the deploy" : "does not blame the deploy"}.`,
      `The correlation window is ${values.windowSec}s. A wider window makes a late annotation look causal; a narrower one can hide a real relationship.`,
      `Reconstruction takes about ${values.reconstructMin.toFixed(0)} minutes and leaves ${values.orderConfidence.toFixed(0)}% order confidence.`,
    ];
  },
  legend: [
    { label: "Consistent order", tone: "ok" },
    { label: "Clock warning", tone: "warn" },
    { label: "False cause", tone: "crit" },
    { label: "Missing evidence", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Clocks are synchronized, deploy markers are present, and the order matches the reference.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Small skew",
    description: "A 30-second effective offset. The order is still right, but the timeline needs a note.",
    tone: "warn",
    params: defaults({ clockSkewSec: 150, ntpSyncPct: 80, deployMarkerCoveragePct: 100, correlationWindowSec: 30 }),
  },
  {
    id: "failure",
    label: "Skewed deploy",
    description: "The CI clock is three minutes ahead. The deploy appears after the error and is blamed.",
    tone: "crit",
    params: defaults({ clockSkewSec: 240, ntpSyncPct: 25, deployMarkerCoveragePct: 100, correlationWindowSec: 180 }),
  },
  {
    id: "missing-marker",
    label: "Missing marker",
    description: "The clocks agree, but only a fifth of deploy events are annotated. The change is invisible.",
    tone: "crit",
    params: defaults({ clockSkewSec: 0, ntpSyncPct: 100, deployMarkerCoveragePct: 20, correlationWindowSec: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Synchronized clocks, near-complete markers, and a narrow correlation window.",
    tone: "ok",
    params: defaults({ clockSkewSec: 8, ntpSyncPct: 95, deployMarkerCoveragePct: 95, correlationWindowSec: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-skewed-deploy",
  title: "Predict the order the timeline shows",
  simId: "timeline",
  question:
    "The deploy pipeline clock is three minutes ahead of the metric clock. The deploy began before the errors. What order will the reconstructed timeline show?",
  prediction: {
    options: [
      { id: "after", label: "The deploy appears after the error onset and looks causal" },
      { id: "before", label: "The deploy appears before the error because the real time is preserved" },
      { id: "same", label: "The deploy and the error will share a timestamp and cancel out" },
      { id: "missing", label: "The deploy annotation will be dropped because the clocks disagree" },
    ],
    correctOptionId: "after",
    explanation:
      "The annotation carries the CI clock, which is three minutes ahead. The deploy began at 14:02 but is recorded at 14:05, after the 14:03 error onset. If the correlation window is wide enough, the reviewer calls the deploy the cause even though its real start preceded the failure.",
  },
  setup: defaults({ clockSkewSec: 240, ntpSyncPct: 25, deployMarkerCoveragePct: 100, correlationWindowSec: 180 }),
  runFor: 20,
  observe: [
    "The deploy marker appears after the error onset in the reconstructed timeline.",
    "The rollback marker also shifts late and can appear after recovery.",
    "Misordered pairs and the clock offset both cross their thresholds.",
    "The postmortem's cause is plausible by sequence but false by the true start time.",
  ],
  explain:
    "A timeline is an argument about order. Every source carries its own clock, and merging them without normalization creates a new sequence that may never have existed. The metric source is a better reference for symptom onset and recovery because it is continuous; the deploy source is better for the change start if its clock is trustworthy. When the two disagree, state the offset and the uncertainty rather than choosing the story that fits.",
  fix: defaults({ clockSkewSec: 0, ntpSyncPct: 98, deployMarkerCoveragePct: 95, correlationWindowSec: 60 }),
  debrief:
    "With synchronized clocks the deploy appears before the error, and the reviewer has to argue causation instead of assuming it from order. The tradeoff is that synchronization and annotations cost pipeline work, and a corrected clock can still leave a real deploy as the cause. The timeline should show the evidence, not decide the blame.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An incident timeline is a sequence of events with sources, timestamps, and enough context to support a causal claim. It is not a chat log and it is not a graph. It combines metric onset, alert delivery, deploy and rollback markers, human decisions, and recovery into one order that a reviewer can defend.",
  },
  {
    type: "p",
    text: "The hard part is that each source has its own clock. Metrics may arrive with a scrape timestamp, logs with a host clock, the deploy pipeline with a CI runner clock, and the pager with its own delivery time. If those clocks disagree, merging the events can reverse cause and effect. A deploy that began before the failure can appear after it and take the blame.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The timeline sits after detection and before the postmortem. It consumes the same signals the incident response used, plus the change feed and the decision log. Its output is an ordered evidence table with a confidence note, not a single narrative. The postmortem can then argue about causes without arguing about which event came first. The replay scrubber counts from 14:00, so 03:00 on the scrubber is 14:03 in the example.",
  },
  {
    type: "table",
    headers: ["Source", "Best for", "Clock risk"],
    rows: [
      ["Metrics", "Symptom onset and recovery", "Scrape and ingestion delay"],
      ["Logs", "Application events and errors", "Host clock skew"],
      ["Deploy pipeline", "Change and rollback start", "CI runner clock skew"],
      ["Pager", "Alert delivery and acknowledgement", "Provider delivery delay"],
      ["Incident channel", "Human decisions and actions", "Manual timestamps"],
    ],
  },
  {
    type: "p",
    text: "The scenario in this module is simulated. The times, the offset, and the change are illustrative so the ordering problem is visible. They are not a claim about a real incident, company, or postmortem. The lesson is the method: normalize, mark uncertainty, and compare the real start with the symptom onset.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A replay timeline with error onset, alert, decision, rollback, recovery, and deploy annotations.",
      "Effective clock offset after NTP sync, and the number of misordered pairs.",
      "A deploy-blame flag when the annotation falls after the error and inside the correlation window.",
      "An unattributed-change flag when deploy markers are missing.",
      "Evidence coverage and order confidence, so a clean-looking timeline can still be weak.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Skewed deploy. Scrub the timeline and compare the deploy annotation with the error onset. Apply Missing marker to see a different evidence gap. Then run the experiment and synchronize the clocks.",
  },
  {
    type: "compare",
    leftTitle: "Wall-clock merge",
    rightTitle: "Normalized timeline",
    rows: [
      { label: "Input", left: "Raw timestamps from every source", right: "Timestamps mapped to one reference" },
      { label: "Order", left: "Whatever the clocks say", right: "Corrected order plus stated uncertainty" },
      { label: "Failure", left: "Skew reverses cause and effect", right: "A gap is visible as a gap" },
      { label: "Postmortem", left: "Argues about the timeline", right: "Argues about the cause" },
    ],
  },
  { type: "sim", simId: "timeline" },
  { type: "experiment", experimentId: "predict-skewed-deploy" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The deploy began before the errors, but its clock was three minutes ahead. The reconstructed timeline placed the deploy after the error onset and inside the correlation window, so it looked causal. The rollback marker shifted too, and could appear after recovery. The evidence was real; the order was not.",
  },
  {
    type: "p",
    text: "Correcting the clock restored the true order, but it did not prove the deploy was innocent. It only removed a false sequence. That is the point of the reconstruction: it should make the causal question answerable, not answer it by itself.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Prometheus and Grafana: metric timestamps and annotations on the same axis, with the dashboard time zone and the data source offset visible.",
      "CI/CD: deploy and rollback events with a start time, an end time, and the runner host clock. The start time is more useful than the completion notification.",
      "NTP or chrony: offset and synchronization status for the hosts that emit logs and annotations. An unsynchronized host is an evidence risk.",
      "PagerDuty: alert creation, delivery, acknowledgement, and escalation timestamps. These are separate from the metric onset.",
      "Incident channel: decision times written by a human. They are evidence of a decision, not of the system state.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the real deploy start, not only the annotation. Compare it with the symptom onset on the metric clock. Check NTP status on the hosts that emitted the annotation. Then check whether the rollback and recovery order still makes sense.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List every event with its source, raw timestamp, and clock offset.",
      "Choose one reference clock for symptom onset and recovery, usually the metric source.",
      "Normalize the deploy and rollback markers and record the correction in the timeline.",
      "Mark missing markers and uncertain timestamps instead of filling them with a guess.",
      "Rebuild the order and check whether the causal claim still holds.",
      "Add NTP monitoring and pipeline annotations so the next timeline needs less reconstruction.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A single reference clock is easier to defend but may hide a source-specific delay.",
      "Correcting timestamps improves order and can obscure the raw evidence; keep both.",
      "A narrow correlation window reduces false causality and can miss a real slow-burn relationship.",
      "A wide window catches real relationships and invites blame by proximity.",
      "More annotations improve coverage and add pipeline work; missing annotations are worse than a visible gap.",
      "A timeline can establish order, not causation. The postmortem still needs a mechanism.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "which-clock",
    question:
      "The postmortem says the rollback started at 14:20, but the graphs show recovery at 14:16. Which clock do you trust?",
    difficulty: 2,
    hints: [
      "Ask what each source measures, not which one is louder.",
      "A rollback decision, a rollback start, and a recovery are different events.",
    ],
    answer:
      "I would not choose a clock by authority. I would list the events: decision, rollback start, recovery, and the source for each. The metric graph is strong evidence for symptom onset and recovery because it is continuous. The rollback start should come from the deploy pipeline or the change record, with its own timestamp. If the graph says recovery at 14:16 and the rollback start is 14:20, one of three things is true: the recovery has a different cause, the rollback clock is ahead, or the rollback began earlier than the recorded start. I would compare the raw timestamps, check NTP, and state the uncertainty in the timeline before drawing a causal conclusion.",
    followUps: [
      "What if the rollback was recorded by a human?",
      "How would you present the uncertainty in the postmortem?",
      "Which event would you use as the reference?",
    ],
    redFlags: [
      "Trusts the written postmortem over the telemetry.",
      "Assumes recovery proves the rollback worked.",
      "Ignores the difference between decision and start.",
    ],
    rubric: [
      "Separates the event types.",
      "Uses source strengths.",
      "Checks clock offsets.",
      "States uncertainty.",
    ],
  },
  {
    id: "clock-skew",
    question:
      "How does clock skew create a false cause in an incident timeline?",
    difficulty: 2,
    hints: [
      "A merge of raw timestamps is an ordering claim.",
      "A late annotation can land inside a correlation window.",
    ],
    answer:
      "Each source stamps an event with its own clock. If the deploy pipeline is ahead, a deploy that began before the failure is recorded after it. When the reviewer merges raw timestamps and applies a correlation window, the deploy now sits close to the symptom onset and looks causal. The real start time may be earlier, but it is not in the merged view. The fix is to normalize to one reference, keep the raw timestamps, and check the offset before arguing about cause.",
    followUps: [
      "Which sources are most likely to be skewed?",
      "How do you detect skew after the fact?",
      "What if only some hosts are unsynchronized?",
    ],
    redFlags: [
      "Treats timestamps as exact.",
      "Sorts by arrival time instead of event time.",
      "Blames the most recent change without a start time.",
    ],
    rubric: [
      "Explains the merge error.",
      "Names the correlation-window effect.",
      "Uses normalization and raw evidence.",
      "Checks partial synchronization.",
    ],
  },
  {
    id: "missing-markers",
    question:
      "A deploy has no annotation in the timeline. How do you handle the gap?",
    difficulty: 2,
    hints: [
      "A missing marker is evidence about the process, not proof of innocence.",
      "The change record may still exist elsewhere.",
    ],
    answer:
      "I would mark the gap explicitly and look for the change in the pipeline, the container image, or the configuration record. Absence of an annotation is not evidence that no change happened; it is evidence that the timeline is incomplete. I would reconstruct the change from the best available source, state the confidence, and add a pipeline annotation so the next incident does not have the same gap. If the change cannot be reconstructed, the postmortem should say so rather than inventing a cause.",
    followUps: [
      "What other sources can identify a change?",
      "Should a missing marker block the postmortem?",
      "How would you measure annotation coverage?",
    ],
    redFlags: [
      "Assumes no deploy because no marker exists.",
      "Fills the gap with the most recent known change.",
      "Ignores the pipeline record.",
    ],
    rubric: [
      "Marks the gap.",
      "Searches other change sources.",
      "States confidence.",
      "Improves annotation coverage.",
    ],
  },
  {
    id: "causality",
    question:
      "The timeline is correct and the deploy is still the cause. What else do you need before you blame it?",
    difficulty: 3,
    hints: [
      "Order is necessary, not sufficient.",
      "Look for a mechanism and a dose-response.",
    ],
    answer:
      "I need a mechanism and evidence that the failure moves with the change. I would check whether the error starts on the instances that received the deploy, whether it stops or changes after rollback, and whether a canary or a second environment reproduces it. I would also check whether another change or a dependency shift happened at the same time. A correct timeline removes a false sequence; it does not establish causation by itself.",
    followUps: [
      "What would a dose-response look like?",
      "How do you rule out a coincident dependency change?",
      "What if the rollback also changed the traffic pattern?",
    ],
    redFlags: [
      "Stops at correlation.",
      "Ignores instance-level evidence.",
      "Assumes rollback success proves cause.",
    ],
    rubric: [
      "Requires a mechanism.",
      "Uses instance and rollout evidence.",
      "Checks coincidence.",
      "Separates order from cause.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Deploy and rollback events emit annotations with a start time and a change link.",
      "Hosts that emit logs and annotations are monitored for NTP offset.",
      "The incident process records decision times separately from action times.",
      "The timeline template names each source and its reference clock.",
      "Evidence coverage and missing markers are reported, not silently filled.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Record the symptom onset from the metric source.",
      "Record the deploy start, not only the completion notification.",
      "Record decisions and actions as separate events.",
      "Note any source whose clock is known to be off.",
      "Do not declare a cause from sequence alone.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Normalize the timestamps and keep the raw values.",
      "List the misordered pairs and the correction applied.",
      "Mark missing annotations as evidence gaps.",
      "Check the mechanism against instance, canary, and rollback evidence.",
      "Add the missing annotation or NTP check before the next review.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture: Learning from Failure",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Timeline reconstruction, evidence, and blame-free causal analysis.",
  },
  {
    title: "RFC 5905: Network Time Protocol Version 4",
    url: "https://www.rfc-editor.org/rfc/rfc5905",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Clock synchronization, offset, and the limits of distributed time.",
  },
  {
    title: "Monitoring Distributed Systems",
    url: "https://sre.google/sre-book/monitoring-distributed-systems/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "Symptom versus cause and the evidence used in an incident review.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    timeline: {
      model: timelineModel,
      presets,
      instructions:
        "Start Healthy, then apply Skewed deploy. Scrub the replay and compare the deploy annotation with the error onset. Apply Missing marker, then run the experiment and synchronize the clocks.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative reconstruction. Times, offsets, and the change are simulated, not a real incident or postmortem.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-dashboard-question",
    "observability-distributed-tracing",
    "reliability-timeline",
    "case-composite-clock-skew",
  ],
};
