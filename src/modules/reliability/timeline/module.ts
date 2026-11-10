import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "clockSync",
    label: "Sources with synchronized clocks",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Time",
    help: "Share of hosts and pipelines whose clocks agree with the reference time service. Unsynchronized sources keep a persistent offset.",
    format: "percent",
  },
  {
    id: "sourceCoverage",
    label: "Event sources ingested",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Coverage",
    help: "Share of the sources that matter: metrics, application logs, deploy pipeline, pager, incident channel, and communications. A missing source leaves a gap in the chronology.",
    format: "percent",
  },
  {
    id: "timestampProvenance",
    label: "Timestamps with provenance",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Record",
    help: "Share of entries that record the source clock, the collection time, and whether the time was observed or estimated from memory.",
    format: "percent",
  },
  {
    id: "reconciliation",
    label: "Conflicts reconciled",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "%",
    group: "Record",
    help: "Share of source disagreements that were investigated and explicitly resolved. An unresolved conflict does not disappear; it becomes a confident wrong order.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  skew: number;
  missingSources: number;
  estimatedTimes: number;
  conflicts: number;
  falseCause: number;
  uncertainty: number;
  reconstructMinutes: number;
  completeness: number;
  sources: number[];
}

function compute(p: Params): Values {
  const clockSync = clamp(num(p, "clockSync", 95), 0, 100);
  const coverage = clamp(num(p, "sourceCoverage", 95), 0, 100);
  const provenance = clamp(num(p, "timestampProvenance", 90), 0, 100);
  const reconciliation = clamp(num(p, "reconciliation", 85), 0, 100);
  const skew = (100 - clockSync) * 2.4;
  const missingSources = Math.round(((100 - coverage) / 100) * 6);
  const estimatedTimes = Math.round(((100 - provenance) / 100) * 8);
  const conflicts = clamp(
    Math.round(skew / 55 + estimatedTimes * 0.7 + missingSources * 0.6 - reconciliation / 45),
    0,
    12,
  );
  const falseCause = clamp(
    skew * 0.22 + conflicts * 6 + missingSources * 3 - reconciliation * 0.35,
    0,
    100,
  );
  const uncertainty = clamp(
    100 - (coverage * 0.35 + provenance * 0.3 + clockSync * 0.2 + reconciliation * 0.15),
    0,
    100,
  );
  const reconstructMinutes = Math.round(
    18 + missingSources * 5 + conflicts * 4 + skew * 0.07,
  );
  return {
    skew,
    missingSources,
    estimatedTimes,
    conflicts,
    falseCause,
    uncertainty,
    reconstructMinutes,
    completeness: 100 - uncertainty,
    sources: [clockSync, coverage, provenance, reconciliation],
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function coverageHealth(value: number, warnBelow: number, critBelow: number): "ok" | "warn" | "crit" {
  if (value < critBelow) return "crit";
  if (value < warnBelow) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p);
  return {
    t,
    nodes: [
      {
        id: "metrics",
        label: "Metrics and logs",
        kind: "service",
        health: "ok",
        utilization: 0.35,
        sublabel: "symptom onset and recovery",
        detail: "The reference evidence for when the failure began and ended. Metrics show the shape; logs show the first matching error.",
        meta: { view: "timeline" },
      },
      {
        id: "deploys",
        label: "Deploy pipeline",
        kind: "service",
        health: healthOf(Math.abs(v.skew), 30, 120),
        utilization: clamp(Math.abs(v.skew) / 300),
        sublabel: `${v.skew.toFixed(0)}s offset`,
        detail: "Deploy and rollback markers. A pipeline clock that is ahead moves a real cause after its effect and invites a false conclusion.",
        meta: { view: "timeline" },
      },
      {
        id: "decisions",
        label: "Incident decisions",
        kind: "stream",
        health: healthOf(v.conflicts, 1, 4),
        utilization: clamp(0.25 + v.conflicts / 18),
        sublabel: `${v.conflicts} unresolved conflict(s)`,
        detail: "Failover, disable, rollback, and escalation, with an owner and a time basis. A decision made in the channel is different from a deploy that carried it out.",
        meta: { view: "timeline" },
      },
      {
        id: "comms",
        label: "Communications",
        kind: "service",
        health: coverageHealth(v.completeness, 80, 55),
        utilization: clamp(0.25 + (100 - v.completeness) / 120),
        sublabel: `${v.estimatedTimes} estimated timestamp(s)`,
        detail: "Status updates, support replies, and customer messages. They often carry estimated times, so label them as reported rather than observed.",
        meta: { view: "timeline" },
      },
      {
        id: "reconcile",
        label: "Reconciliation",
        kind: "worker",
        health: healthOf(v.uncertainty, 20, 40),
        utilization: clamp(v.uncertainty / 100),
        sublabel: `${v.completeness.toFixed(0)}% record complete`,
        detail: "The step that compares sources, records offsets, resolves conflicts, and states what remains uncertain. Skipping it turns several partial records into one confident wrong story.",
        meta: { view: "timeline" },
      },
      {
        id: "record",
        label: "Review record",
        kind: "storage",
        health: healthOf(v.reconstructMinutes, 45, 70),
        utilization: clamp(v.reconstructMinutes / 110),
        sublabel: `${v.reconstructMinutes} min to assemble`,
        detail: "The single chronology used by the review, with source labels and confidence. It is an argument about evidence, not a transcript.",
        meta: { view: "timeline" },
      },
    ],
    edges: [
      edge("metrics-deploys", "metrics", "deploys", 0.9, "ok"),
      edge("deploys-decisions", "deploys", "decisions", 0.8, healthOf(v.conflicts, 1, 4)),
      edge("decisions-comms", "decisions", "comms", 0.8, coverageHealth(v.completeness, 80, 55)),
      edge("comms-reconcile", "comms", "reconcile", 0.8, healthOf(v.uncertainty, 20, 40)),
      edge("reconcile-record", "reconcile", "record", 1 - v.uncertainty / 120, healthOf(v.reconstructMinutes, 45, 70)),
    ],
    metrics: [
      metric("false-cause", "False-cause risk", v.falseCause, "%", 25, 55, "percent"),
      metric("order-uncertainty", "Order uncertainty", v.uncertainty, "%", 20, 40, "percent"),
      metric("unresolved-conflicts", "Unresolved conflicts", v.conflicts, "", 1, 4, "count"),
      metric("reconstruct-minutes", "Timeline assembly time", v.reconstructMinutes, " min", 45, 70, "number"),
      metric("record-completeness", "Record completeness", v.completeness, "%", undefined, undefined, "percent"),
    ],
    events: [
      {
        id: "tl-metrics",
        at: 0,
        severity: "info",
        title: "Symptom onset recorded in metrics",
        detail: `The metric source is treated as the reference clock. Clock disagreement across sources is ${v.skew.toFixed(0)} seconds.`,
        nodeId: "metrics",
      },
      {
        id: "tl-deploy",
        at: 2,
        severity: v.skew >= 120 ? "crit" : "info",
        title: "Deploy marker arrives",
        detail: v.skew >= 120
          ? `The pipeline clock is ${v.skew.toFixed(0)} seconds ahead. The deploy can appear after the first errors even if it began before them.`
          : "The deploy marker is within the clock tolerance and can be ordered against the symptom onset.",
        nodeId: "deploys",
      },
      {
        id: "tl-decision",
        at: 4,
        severity: "info",
        title: "Rollback ordered in the incident channel",
        detail: "A decision timestamp is not a deploy timestamp. The record must say who decided and when, then link the pipeline event that carried it out.",
        nodeId: "decisions",
      },
      {
        id: "tl-comms",
        at: 7,
        severity: v.estimatedTimes >= 4 ? "warn" : "info",
        title: "Customer update published",
        detail: `The support message reports a rollback time that is ${v.estimatedTimes >= 4 ? "estimated from memory" : "backed by a recorded source"}. Reported times are evidence, but they are not the reference clock.`,
        nodeId: "comms",
      },
      {
        id: "tl-conflict",
        at: 9,
        severity: v.conflicts >= 4 ? "crit" : v.conflicts >= 1 ? "warn" : "info",
        title: v.conflicts >= 1 ? "Two sources disagree on rollback time" : "Sources agree on rollback time",
        detail: v.conflicts >= 1
          ? `${v.conflicts} conflict(s) remain after reconciliation. Each one needs an explicit resolution or an uncertainty note; otherwise the review will pick the version that fits its theory.`
          : "The rollback decision, pipeline completion, and recovery times agree within the recorded clock tolerance. Keep the source labels in the record.",
        nodeId: "reconcile",
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.conflicts} unresolved conflict(s), ${v.uncertainty.toFixed(0)}% order uncertainty, ${v.reconstructMinutes} minutes to assemble; false-cause risk ${v.falseCause.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 6;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.06 * Math.sin((index + phase) / 3.2))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "false-cause",
    metricId: "false-cause",
    warn: 25,
    crit: 55,
    title: "The timeline is about to record a false cause",
    cause:
      "A source clock is ahead or an estimated timestamp is treated as observed. The deploy or rollback appears on the wrong side of the symptom onset, and the reviewer mistakes sequence for causation.",
    fix:
      "Correct or label the clock, compare the event with an independent source, and record the real order plus the remaining uncertainty. A deploy that began before the failure can still be a cause; the timeline must show that before anyone argues it.",
    checkFirst: [
      "Compare the deploy start with the first sustained error, not the annotation time.",
      "Check whether the source has a known clock offset.",
      "Check whether the event time was observed or estimated from memory.",
    ],
  },
  {
    id: "order-uncertainty",
    metricId: "order-uncertainty",
    warn: 20,
    crit: 40,
    title: "The chronology cannot support a causal claim",
    cause:
      "Sources are missing, timestamps lack provenance, or conflicts were never reconciled. The record contains events but not enough evidence to order them.",
    fix:
      "Add the missing sources, label every timestamp with its basis, and resolve or explicitly mark each conflict. State confidence in the timeline rather than presenting a partial record as complete.",
    checkFirst: [
      "List the sources that contributed to the timeline.",
      "Find entries with no source or no time basis.",
      "Find two events whose order matters but whose times are estimated.",
    ],
  },
  {
    id: "unresolved-conflicts",
    metricId: "unresolved-conflicts",
    warn: 1,
    crit: 4,
    title: "Sources disagree and nobody has reconciled them",
    cause:
      "The metrics, deploy pipeline, incident channel, and support messages use different clocks and different definitions of the same event. Each source is locally consistent, so the disagreement is invisible until the records are placed side by side.",
    fix:
      "Pick a reference clock, record each source's offset, and reconcile the events by definition as well as time. Mark what cannot be resolved and why. Keep the source labels in the review record.",
    checkFirst: [
      "Check which clock the metric store uses.",
      "Check whether the deploy event is the start, the rollout, or the completion.",
      "Check whether the incident channel time is when the decision was typed or when it was made.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const incidentTimelineModel: SimModel = {
  id: "reliability-timeline",
  visual: "timeline",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, frame.t, seed);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.events = frame.events.slice(-60);
    const v = compute(p);
    if (v.falseCause >= 55 && frame.flags.timelineFalseCause !== 1) {
      pushEvent(next, {
        id: "tl-false-cause",
        at: frame.t,
        severity: "crit",
        title: "Chronology now supports the wrong conclusion",
        detail: "The record orders a cause after its effect. Before the review uses this timeline, reconcile the clocks and label the estimated times.",
        nodeId: "record",
        metricId: "false-cause",
      });
      next.flags.timelineFalseCause = 1;
    }
    next.events = [...next.events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    return [
      `The timeline has ${v.missingSources} source group(s) missing; ${v.conflicts} conflict(s) remain unresolved and ${v.estimatedTimes} timestamp(s) are estimated.`,
      `Clock disagreement is ${v.skew.toFixed(0)} seconds and false-cause risk is ${v.falseCause.toFixed(0)}%.`,
      `Order uncertainty is ${v.uncertainty.toFixed(0)}% and the review record is ${v.completeness.toFixed(0)}% complete.`,
      `Assembly takes about ${v.reconstructMinutes} minutes. Skipping reconciliation does not save that time; it moves the cost into the review.`,
    ];
  },
  legend: [
    { label: "Reconciled", tone: "ok" },
    { label: "Uncertain order", tone: "warn" },
    { label: "False cause", tone: "crit" },
    { label: "Record incomplete", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Clocks agree, every source contributes, timestamps carry provenance, and conflicts are reconciled.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial record",
    description: "One source is missing and several times are estimated, but the main order is still defensible.",
    tone: "warn",
    params: defaults({ clockSync: 80, sourceCoverage: 80, timestampProvenance: 65, reconciliation: 55 }),
  },
  {
    id: "failure",
    label: "Skewed and selective",
    description: "The pipeline clock is three minutes ahead, two source groups are missing, and most times are reconstructed from memory.",
    tone: "crit",
    params: defaults({ clockSync: 20, sourceCoverage: 45, timestampProvenance: 30, reconciliation: 15 }),
    elapsed: 8,
  },
  {
    id: "recovery",
    label: "Reconciled record",
    description: "All sources are ingested, every timestamp is sourced, and disagreements are resolved with confidence notes.",
    tone: "ok",
    params: defaults({ clockSync: 100, sourceCoverage: 100, timestampProvenance: 100, reconciliation: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-timeline-disagreement",
  title: "Predict how to settle the rollback time",
  simId: "timeline",
  question:
    "Metrics show recovery at 14:26. The deploy pipeline says the rollback completed at 14:19, and support told customers it happened at 14:33. Which approach settles the timeline?",
  prediction: {
    options: [
      {
        id: "reconcile",
        label: "Compare source clocks, define what each event means, and record the reconciled order with confidence",
      },
      { id: "fastest", label: "Use the earliest timestamp because rollback usually starts before recovery" },
      { id: "support", label: "Use the customer-facing time because that is what people remember" },
      { id: "average", label: "Average the three times so no source is favored" },
    ],
    correctOptionId: "reconcile",
    explanation:
      "The three records may describe different events. The pipeline may record completion, metrics may record the end of user impact, and support may report when the message was sent. They also use different clocks. Reconciliation means checking the source clock, defining the event, and recording the remaining uncertainty. Averaging timestamps invents a time that no system observed.",
  },
  setup: defaults({ clockSync: 25, sourceCoverage: 55, timestampProvenance: 40, reconciliation: 20 }),
  runFor: 30,
  observe: [
    "False-cause risk is critical before the review agrees on a sequence.",
    "Unresolved conflicts remain even though every source looks internally consistent.",
    "Order uncertainty stays high because several timestamps are estimated.",
    "The record can still be assembled, but it cannot support the causal claim the review wants.",
  ],
  explain:
    "An incident timeline is an evidence product, not a merged log. Each entry needs a source, a definition of the event, and a time basis. When sources disagree, the reconciliation step decides which clock is the reference and whether the disagreement is a clock offset or a different definition. The output is a chronology with confidence, not a single authoritative time.",
  fix: defaults({ clockSync: 100, sourceCoverage: 100, timestampProvenance: 100, reconciliation: 100 }),
  debrief:
    "The reconciled record shows the decision, the deploy, the completion, and the recovery as separate events on a common clock. It also states that one support timestamp was estimated. The tradeoff is assembly time: reconciling sources takes longer than pasting the first log export. That time is repaid in a review that does not argue about basic facts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An incident timeline is the single chronology of what happened, when, and according to which source. It combines alerts and metrics, deploys and rollbacks, decisions made in the incident channel, and communications sent to customers or stakeholders. Each entry carries a source and a time basis, so the review can tell what was observed from what was estimated.",
  },
  {
    type: "p",
    text: "The timeline is not a merged log file. Logs record machine events with their own clocks. A decision is recorded when someone types it, not necessarily when it was made. A customer update may report a rollback with an approximate time. The reconstruction has to compare those records, define what each event means, and state where the order is uncertain.",
  },
  {
    type: "p",
    text: "The common failure is not a missing log. It is a confident wrong order. A pipeline clock that is three minutes ahead moves a deploy after the first errors. A support message with an estimated time becomes the version everyone remembers. The review then debates a cause that the evidence never established.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The observability track covers the instrumentation problem: clock synchronization, deploy markers, and correlation windows. This module covers the incident record: assembling sources, labeling provenance, reconciling conflicts, and handing the review a chronology it can defend. The decision log adds intent to the consequential points in this chronology.",
  },
  {
    type: "table",
    headers: ["Source", "What it establishes", "Typical weakness"],
    rows: [
      ["Metrics", "Symptom onset, magnitude, recovery", "Aggregation delay and missing labels"],
      ["Deploy pipeline", "Change start, rollout, rollback", "Host clock offset; start versus completion"],
      ["Incident channel", "Decision and owner", "Typed time is not decision time"],
      ["Support or status page", "What customers were told", "Estimated or rounded times"],
      ["Application logs", "First matching error and request path", "Sampling, retention, and host clocks"],
    ],
  },
  {
    type: "p",
    text: "This module models the assembly of one incident record. Clock offset, source coverage, provenance, and reconciliation rates are illustrative teaching values, not a standard for any tool.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "False-cause risk: how likely the record is to put a cause after its effect.",
      "Order uncertainty: how much of the chronology cannot support a causal claim.",
      "Unresolved conflicts: source disagreements with no recorded resolution.",
      "Timeline assembly time: the review cost of missing provenance.",
      "A replay of the incident with source-labeled entries.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Skewed and selective. Watch false-cause risk and unresolved conflicts. Run the experiment before reading the debrief, then synchronize the clocks and reconcile the entries. The replay shows how the same events can produce a different story.",
  },
  {
    type: "compare",
    leftTitle: "Merged log export",
    rightTitle: "Reconciled timeline",
    rows: [
      { label: "Entry", left: "Timestamp and message", right: "Event, source, time basis, confidence" },
      { label: "Conflict", left: "Both rows remain", right: "Offset or definition resolved and recorded" },
      { label: "Order", left: "Whatever the sort returns", right: "Reference clock with uncertainty noted" },
      { label: "Review", left: "Argues about basic facts", right: "Argues about conditions and actions" },
    ],
  },
  { type: "sim", simId: "timeline" },
  { type: "experiment", experimentId: "predict-timeline-disagreement" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The deploy pipeline was three minutes ahead. The first errors appeared in metrics at 14:12, but the deploy annotation landed at 14:14. The timeline therefore showed the deploy after the errors and the review treated it as the cause. The real deploy had started at 14:09. The annotation was late, not the change.",
  },
  {
    type: "p",
    text: "The support update made it worse. It reported a rollback at 14:33 from memory, while the pipeline recorded completion at 14:29 and metrics recorded recovery at 14:31. Three records described three different events on three different clocks. Reconciliation separated them and recorded the remaining uncertainty.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Review document: one timeline with no source column and no statement of confidence.",
      "Deploy annotation: a marker time that no one compared with the pipeline start.",
      "Incident channel: decisions recorded after the fact, without a time basis.",
      "Support: customer-facing times that do not match the internal record.",
      "Disagreement: two teams defending different sequences from the same evidence.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Pick the event the argument depends on. Find its source clock and ask whether the recorded time is the start, the completion, or a person's estimate. Compare it with one independent source before accepting the order.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Choose a reference clock for the record and document it.",
      "Add a source and time-basis column to every entry: observed, reported, or estimated.",
      "Define the event: deploy start, rollout complete, rollback ordered, rollback complete, or recovery.",
      "Record each source's known offset and correct the displayed time without hiding the original.",
      "Reconcile conflicts explicitly and mark what remains uncertain.",
      "Use the reconciled record in the review, and keep the source evidence linked.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Reconciliation takes longer than merging logs. It prevents a review from arguing about facts it cannot settle.",
      "Correcting a timestamp can hide the original evidence. Keep the raw time and the correction together.",
      "A confidence label can be ignored under pressure. Put the uncertainty next to the claim it affects.",
      "Not every event needs the same rigor. Spend reconciliation effort on the events that change the causal argument.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "build-timeline",
    question: "How do you build one incident timeline from several disagreeing sources?",
    difficulty: 2,
    hints: [
      "Choose a reference clock.",
      "Record source, event definition, and time basis.",
    ],
    answer:
      "I choose a reference clock, usually the metric store or a synchronized log source, and record every entry with its source, the event it represents, and whether the time was observed, reported, or estimated. Then I reconcile conflicts by checking offsets and definitions before ordering events. Where the evidence cannot settle the order, I state the uncertainty instead of picking a time. The output is one chronology with confidence notes and links back to the raw evidence.",
    followUps: [
      "Which source do you trust for recovery?",
      "How do you handle a vendor's timeline?",
      "What belongs in the appendix rather than the main record?",
    ],
    redFlags: [
      "Merges logs and calls it a timeline.",
      "Picks the earliest time.",
      "Hides uncertainty.",
    ],
    rubric: [
      "Names a reference clock.",
      "Records provenance.",
      "Reconciles definitions and offsets.",
      "States uncertainty.",
    ],
  },
  {
    id: "skew-false-cause",
    question: "How can clock skew make a cause look like an effect?",
    difficulty: 2,
    hints: [
      "A clock that is ahead moves an event later in the record.",
      "The real order can be the opposite of the displayed order.",
    ],
    answer:
      "If the deploy pipeline clock is ahead of the metric clock, the deploy annotation appears later than it really happened. It can land after the first errors and inside whatever correlation window the reviewer uses. The reviewer then sees a change followed by failure and calls the change the cause, when the change actually began first. Correcting the offset or comparing the deploy start with the symptom onset restores the real order. A deploy that began before the failure can still be a cause, but the timeline has to show that.",
    followUps: [
      "How do you detect the offset?",
      "What if only some hosts are skewed?",
      "How do you present a corrected time without losing the original?",
    ],
    redFlags: [
      "Assumes timestamps are comparable.",
      "Blames the deploy from the annotation alone.",
      "Deletes the original time.",
    ],
    rubric: [
      "Explains the offset direction.",
      "Links to false causality.",
      "Corrects with evidence.",
      "Preserves the original.",
    ],
  },
  {
    id: "disagreement-review",
    question:
      "Two teams insist on different rollback times in the review. How do you handle the disagreement?",
    difficulty: 3,
    hints: [
      "They may be describing different events.",
      "The goal is a defensible record, not a winner.",
    ],
    answer:
      "I put both claims next to the source evidence and ask what event each one means: rollback ordered, rollback started, rollout complete, or user impact ended. Then I compare clocks and record the offset. If the evidence still cannot settle it, I record both with a confidence note and explain what would resolve it. The review can proceed on the parts that are settled. The facilitator should not let the disagreement become a test of authority.",
    followUps: [
      "What if one team controls the only source?",
      "How much time should the review spend on this?",
      "When do you escalate to a separate investigation?",
    ],
    redFlags: [
      "Picks the senior person's version.",
      "Averages the times.",
      "Spends the whole review on one timestamp.",
    ],
    rubric: [
      "Separates event definitions.",
      "Compares clocks.",
      "Records uncertainty.",
      "Keeps the review moving.",
    ],
  },
];

const checklist = [
  {
    title: "Assemble",
    items: [
      "Choose a reference clock and record it in the document.",
      "List every source that contributed and every source that is missing.",
      "Label each entry with source, event definition, and time basis.",
      "Keep raw timestamps alongside any correction.",
    ],
  },
  {
    title: "Reconcile",
    items: [
      "Compare deploy start and completion with symptom onset and recovery.",
      "Record known offsets for pipelines, hosts, and vendor systems.",
      "Resolve conflicts by definition first, then by clock.",
      "Mark unresolved order and state what evidence would settle it.",
    ],
  },
  {
    title: "Publish",
    items: [
      "Separate observed events from reported or estimated ones.",
      "Put confidence notes next to the claims they affect.",
      "Link the review record to the raw evidence.",
      "Revisit the timeline if a new source arrives during the review.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture: How You Can Learn from Failure",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Timeline reconstruction, evidence quality, and review records.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Live incident state, decision records, and communication during response.",
  },
  {
    title: "NTP Documentation",
    url: "https://www.ntp.org/documentation/4.2.8-series/",
    publisher: "Network Time Foundation",
    kind: "docs" as const,
    note: "How time synchronization works and why unsynchronized hosts drift.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    timeline: {
      model: incidentTimelineModel,
      presets,
      instructions:
        "Start Healthy, then apply Skewed and selective. Watch false-cause risk and unresolved conflicts. Run the experiment, then synchronize the clocks and reconcile the entries.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Clock offsets, source coverage, and reconciliation rates are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-incident-timeline",
    "reliability-decision-logs",
    "reliability-incident-review",
    "reliability-blameless-postmortems",
  ],
};
