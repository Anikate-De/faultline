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

const INCIDENT_MINUTES = 30;

const params: ParamSpec[] = [
  {
    id: "decisionsLogged",
    label: "Decisions recorded",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Coverage",
    help: "Share of consequential incident decisions entered in the log: failover, traffic shift, feature disable, rollback, and data changes.",
    format: "percent",
  },
  {
    id: "rationaleDepth",
    label: "Rationale depth",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "%",
    group: "Content",
    help: "Share of entries that record the options considered, the evidence used, the expected effect, and the accepted risk.",
    format: "percent",
  },
  {
    id: "writeDelay",
    label: "Delay before writing",
    min: 0,
    max: 60,
    step: 5,
    value: 5,
    unit: " min",
    group: "Timing",
    help: "Minutes between the decision and the log entry. Memory reconstructs a cleaner story than the one that actually happened.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  total: number;
  documented: number;
  unexplained: number;
  gap: number;
  confidence: number;
  reviewMinutes: number;
  logged: number;
  depth: number;
  delay: number;
}

function compute(p: Params, t: number): Values {
  const logged = clamp(num(p, "decisionsLogged", 90), 0, 100);
  const depth = clamp(num(p, "rationaleDepth", 85), 0, 100);
  const delay = clamp(num(p, "writeDelay", 5), 0, 60);
  const elapsed = Math.min(INCIDENT_MINUTES, Math.max(0, t));
  const total = Math.max(1, Math.floor(2 + elapsed / 6));
  const quality = (depth / 100) * (1 - delay / 120);
  const documented = Math.min(total, (total * logged) / 100 * quality);
  const confidence = clamp((documented / total) * 100, 0, 100);
  const gap = 100 - confidence;
  return {
    total,
    documented,
    unexplained: clamp(Math.round(total - documented), 0, total),
    gap,
    confidence,
    reviewMinutes: Math.round(15 + (total - documented) * 8 + (100 - depth) * 0.2),
    logged,
    depth,
    delay,
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  return {
    t,
    nodes: [
      {
        id: "feed",
        label: "Decision feed",
        kind: "stream",
        health: healthOf(v.gap, 35, 60),
        utilization: clamp(0.3 + v.gap / 130),
        sublabel: `${v.total} consequential decision(s)`,
        detail: "The decisions that changed the system or the response: failover, traffic shift, feature disable, rollback, and data repair.",
        meta: { view: "timeline" },
      },
      {
        id: "options",
        label: "Options considered",
        kind: "service",
        health: healthOf(100 - v.depth, 20, 45),
        utilization: clamp(0.25 + (100 - v.depth) / 120),
        sublabel: v.depth >= 70 ? "alternatives recorded" : "action only",
        detail: "A decision log records what else was possible. Without alternatives, the review cannot tell whether the chosen action was reasonable.",
        meta: { view: "timeline" },
      },
      {
        id: "rationale",
        label: "Rationale and evidence",
        kind: "storage",
        health: healthOf(v.gap, 35, 60),
        utilization: clamp(0.3 + v.gap / 140),
        sublabel: v.gap >= 60 ? "why is missing" : "why is recorded",
        detail: "The evidence available at the time, the expected effect, and the risk the owner accepted. This is the part a timestamp cannot reconstruct.",
        meta: { view: "timeline" },
      },
      {
        id: "owner",
        label: "Decision owner",
        kind: "worker",
        health: healthOf(100 - v.logged, 25, 55),
        utilization: clamp(0.25 + (100 - v.logged) / 130),
        sublabel: v.logged >= 80 ? "named at decision time" : "assigned later",
        detail: "One person who made the call and can answer for it. The owner is not the person who typed the command if someone else chose the action.",
        meta: { view: "timeline" },
      },
      {
        id: "timeline",
        label: "Incident timeline",
        kind: "service",
        health: "ok",
        utilization: clamp(0.3 + v.total / 20),
        sublabel: `${v.total} timestamped events`,
        detail: "The timeline records that the breaker was disabled at 02:14. The log records why, what else was considered, and what the team expected.",
        meta: { view: "timeline" },
      },
      {
        id: "review",
        label: "Review reconstruction",
        kind: "worker",
        health: healthOf(v.reviewMinutes, 45, 75),
        utilization: clamp(v.reviewMinutes / 120),
        sublabel: `${v.reviewMinutes} min to reconstruct`,
        detail: "The review has to rebuild intent from evidence. Missing entries turn reconstruction into speculation and make the action look arbitrary.",
        meta: { view: "timeline" },
      },
    ],
    edges: [
      edge("feed-options", "feed", "options", 1 - v.gap / 140, healthOf(v.gap, 35, 60)),
      edge("options-rationale", "options", "rationale", v.depth / 100, healthOf(100 - v.depth, 20, 45)),
      edge("rationale-owner", "rationale", "owner", v.logged / 100, "ok"),
      edge("owner-timeline", "owner", "timeline", 1, "ok"),
      edge("timeline-review", "timeline", "review", 1 - v.gap / 130, healthOf(v.reviewMinutes, 45, 75)),
    ],
    metrics: [
      metric("reconstruction-gap", "Reconstruction gap", v.gap, "%", 35, 60, "percent"),
      metric("unexplained-decisions", "Unexplained decisions", v.unexplained, "", 2, 4, "count"),
      metric("review-minutes", "Review reconstruction time", v.reviewMinutes, " min", 45, 75, "number"),
      metric("documented-decisions", "Decisions with rationale", Math.floor(v.documented), "", undefined, undefined, "count"),
    ],
    events: [
      {
        id: "dl-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared",
        detail: `The response begins with ${v.total} consequential decision(s) ahead. ${v.logged.toFixed(0)}% are expected to be recorded with ${v.depth.toFixed(0)}% rationale depth after a ${v.delay.toFixed(0)} minute delay.`,
      },
      {
        id: "dl-failover",
        at: 4,
        severity: "info",
        title: "Failover selected over read-only mode",
        detail: "The team chose a regional failover. The log should state the expected recovery time, the replication lag accepted, and the owner who made the call.",
      },
      {
        id: "dl-breaker-disabled",
        at: 9,
        severity: "warn",
        title: "Circuit breaker disabled",
        detail: "A risky action that will be questioned in review. Without the options and rationale, the entry reads as an unexplained change.",
      },
      {
        id: "dl-rollback",
        at: 18,
        severity: "info",
        title: "Rollback started",
        detail: "The log should link the rollback to the decision that preceded it and record whether the earlier choice was reversed or completed.",
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.unexplained} of ${v.total} decisions lack usable rationale; reconstruction gap ${v.gap.toFixed(0)}%; review takes about ${v.reviewMinutes} minutes.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + phase) / 3.3))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "reconstruction-gap",
    metricId: "reconstruction-gap",
    warn: 35,
    crit: 60,
    title: "The review cannot reconstruct why a decision was made",
    cause:
      "The log records actions but not options, evidence, or expected effect. The timeline can say that the breaker was disabled at 02:14; it cannot say what the team was trying to prevent or what else it considered.",
    fix:
      "Reopen the log while responders still remember, and record the options, the evidence used, the expected effect, the accepted risk, and the owner for each consequential decision. Mark entries that are reconstructed from memory rather than written at the time.",
    checkFirst: [
      "List the decisions that changed production state during the incident.",
      "Check whether each entry names an owner and a timestamp.",
      "Check whether the entry records alternatives, not just the chosen action.",
    ],
  },
  {
    id: "unexplained-decisions",
    metricId: "unexplained-decisions",
    warn: 2,
    crit: 4,
    title: "Consequential decisions have no usable rationale",
    cause:
      "The team logged the action after the fact or skipped the entry because the incident was moving. The most consequential decisions are usually the hardest to reconstruct later.",
    fix:
      "Adopt a three-line format at decision time: what was decided, what was rejected, and what would make the team reverse it. Assign one scribe in the incident channel and review the log at each command update.",
    checkFirst: [
      "Find the decision that changed the most systems.",
      "Ask the owner what they expected to happen.",
      "Ask what evidence would have changed the choice.",
    ],
  },
  {
    id: "review-minutes",
    metricId: "review-minutes",
    warn: 45,
    crit: 75,
    title: "Reconstruction is consuming the review",
    cause:
      "Missing rationale turns the review into an investigation of intent. Time that should go to contributing factors and actions is spent asking who knew what and why a change was made.",
    fix:
      "Capture decisions during the incident, then spend the review on systemic conditions and action quality. If the log is incomplete, timebox reconstruction and record what remains unknown.",
    checkFirst: [
      "Check how much of the review is spent establishing basic facts.",
      "Check whether the timeline and decision log disagree.",
      "Check whether the same question is being asked in several ways.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const decisionLogModel: SimModel = {
  id: "reliability-decision-logs",
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
    const v = compute(p, frame.t);
    if (v.gap >= 60 && frame.flags.decisionGap !== 1) {
      pushEvent(next, {
        id: "dl-gap-critical",
        at: frame.t,
        severity: "crit",
        title: "The log cannot explain the riskiest action",
        detail: "The postmortem has timestamps but no options, evidence, or expected effect. The review will argue about intent instead of fixing the condition.",
        nodeId: "rationale",
        metricId: "reconstruction-gap",
      });
      next.flags.decisionGap = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `${v.unexplained} of ${v.total} consequential decisions lack usable rationale. The reconstruction gap is ${v.gap.toFixed(0)}%.`,
      `The log records ${v.logged.toFixed(0)}% of decisions with ${v.depth.toFixed(0)}% rationale depth after a ${v.delay.toFixed(0)} minute delay.`,
      `Reconstruction takes about ${v.reviewMinutes} minutes. That time comes out of contributing-factor analysis.`,
      "A timeline proves sequence. A decision log proves intent, alternatives, and accepted risk. The review needs both.",
    ];
  },
  legend: [
    { label: "Reconstructable", tone: "ok" },
    { label: "Thin rationale", tone: "warn" },
    { label: "Unexplained action", tone: "crit" },
    { label: "Review blocked", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Most decisions are logged at the time with options, evidence, owner, and expected effect.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Action-only log",
    description: "Decisions are recorded, but the alternatives and the expected effect are thin.",
    tone: "warn",
    params: defaults({ decisionsLogged: 80, rationaleDepth: 55, writeDelay: 25 }),
  },
  {
    id: "failure",
    label: "No rationale",
    description: "A quarter of decisions are logged hours later and almost none record why the risky action was chosen.",
    tone: "crit",
    params: defaults({ decisionsLogged: 25, rationaleDepth: 15, writeDelay: 50 }),
    elapsed: 12,
  },
  {
    id: "recovery",
    label: "Decisions at the time",
    description: "Every consequential decision is recorded immediately with alternatives, evidence, owner, and a reversal condition.",
    tone: "ok",
    params: defaults({ decisionsLogged: 100, rationaleDepth: 100, writeDelay: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-breaker-entry",
  title: "Predict the entry that makes the review possible",
  simId: "decision-logs",
  question:
    "At 02:14 the team disabled a circuit breaker to restore checkout. Six weeks later the review asks why. Which log entry answers the question?",
  prediction: {
    options: [
      {
        id: "full",
        label: "Breaker disabled at 02:14. Chosen over queue drain and rate limiting. Owner, evidence, expected effect, rollback, and reversal condition recorded.",
      },
      { id: "action", label: "Breaker disabled at 02:14." },
      { id: "owner", label: "Breaker disabled. Owner: the on-call engineer." },
      { id: "outcome", label: "Breaker disabled and checkout recovered at 02:21." },
    ],
    correctOptionId: "full",
    explanation:
      "The action and timestamp are already in the timeline. The review needs the alternatives, the evidence that made the action seem correct, the expected effect, the risk accepted, and what would have caused a reversal. The owner matters, but a name without rationale does not explain the decision.",
  },
  setup: defaults({ decisionsLogged: 30, rationaleDepth: 20, writeDelay: 45 }),
  runFor: 30,
  observe: [
    "The reconstruction gap is critical before the review starts.",
    "Unexplained decisions accumulate as the incident adds consequential changes.",
    "Review time is consumed establishing facts rather than examining conditions.",
    "The timeline stays complete; the missing information is intent, not sequence.",
  ],
  explain:
    "A timeline and a decision log answer different questions. The timeline answers when something happened and in what order. The decision log answers what else was possible, what evidence was used, who chose, and what outcome was expected. Without the second, a reasonable action looks arbitrary in review and the team writes an action against the person rather than the condition.",
  fix: defaults({ decisionsLogged: 100, rationaleDepth: 100, writeDelay: 0 }),
  debrief:
    "With the full entry, the review can evaluate the choice on its merits: the evidence was ambiguous, the alternative carried a larger outage risk, and the owner named a reversal condition. The action may still be wrong, but it is reviewable. The tradeoff is that logging adds work during the incident. A three-line format and one scribe keep that cost small.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A decision log is a running record of the consequential choices made during an incident: what was decided, what else was considered, what evidence was used, who owned the choice, when it was made, and what would cause the team to reverse it. It is written during the response, not reconstructed afterward.",
  },
  {
    type: "p",
    text: "The log is not a transcript and not a chat export. It is a small set of entries around the decisions that changed production state or changed the direction of the response: failover, traffic shift, feature disable, rollback, data repair, escalation, and public communication. A useful entry is short enough to write at 03:00 and specific enough to answer a review six weeks later.",
  },
  {
    type: "p",
    text: "The reason to keep it is that incident evidence naturally records actions and timestamps. Systems emit events; people remember outcomes. The reasoning that connected the evidence to the action is the part that disappears first. When it disappears, the review fills the gap with hindsight and the organization learns the wrong lesson.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The decision log sits beside the incident timeline. The timeline is the chronology assembled from alerts, deploys, messages, and responder notes. The decision log is the intent layer attached to the consequential points in that chronology. Incident command owns when decisions are made; the scribe or a rotating responder owns recording them.",
  },
  {
    type: "table",
    headers: ["Question", "Timeline", "Decision log"],
    rows: [
      ["When did it happen?", "Timestamped event", "Timestamp on the entry"],
      ["What changed?", "Deploy, config, or traffic event", "The action and its scope"],
      ["Why this action?", "Not answered", "Options, evidence, expected effect"],
      ["Who chose?", "Sometimes an operator name", "Named decision owner"],
      ["What would reverse it?", "Not answered", "Explicit reversal condition"],
    ],
  },
  {
    type: "p",
    text: "This module models a 30-minute incident with two to seven consequential decisions. Logging coverage, rationale depth, and write delay are illustrative teaching values, not a benchmark.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Reconstruction gap: the share of decision intent the review cannot recover.",
      "Unexplained decisions: consequential actions with no usable rationale.",
      "Review minutes: time spent rebuilding facts instead of examining conditions.",
      "Decisions with rationale: entries that record options, evidence, owner, and expected effect.",
      "A timeline replay of the incident with the risky decisions marked.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No rationale. Watch the reconstruction gap and the unexplained-decision count. Run the experiment before reading the debrief, then add a three-line entry for the breaker decision and watch the review time fall.",
  },
  {
    type: "compare",
    leftTitle: "Action-only entry",
    rightTitle: "Decision entry",
    rows: [
      { label: "Content", left: "Breaker disabled at 02:14", right: "What was chosen, rejected, expected, and reversible" },
      { label: "Owner", left: "Whoever touched the console", right: "The person who made the call" },
      { label: "Review use", left: "Establishes sequence", right: "Evaluates judgment with the evidence available" },
      { label: "Failure mode", left: "Looks arbitrary in hindsight", right: "Can be challenged on its merits" },
    ],
  },
  { type: "sim", simId: "decision-logs" },
  { type: "experiment", experimentId: "predict-breaker-entry" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The incident produced a clean timeline: failover at 02:04, breaker disabled at 02:14, rollback at 02:18, recovery at 02:21. What it did not produce was a reason. The breaker entry said only that it was disabled. In review, one team argued it was reckless and another argued it was the only option. Both were reconstructing intent from an outcome.",
  },
  {
    type: "p",
    text: "The recovery run logged the choice as it happened. The entry named the queue-drain alternative that was rejected, the error rate that triggered the action, the expected recovery time, the owner, and the condition that would have caused a reversal. The review could disagree with the choice without inventing a motive.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Incident channel: a risky change announced in one line with no alternatives.",
      "Timeline: complete sequence of actions, no statement of intent.",
      "Postmortem: a debate about whether the action was reasonable, resolved by seniority.",
      "Action items: a new approval step rather than a fix for the condition that made the action attractive.",
      "Recurrence: the same decision made by a different responder with the same missing context.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the decision that changed the most systems. Ask the owner what they expected, what they rejected, and what evidence would have changed their mind. If those answers are not in the log, the review is working from memory.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define which decisions require an entry: production state changes, traffic shifts, data repair, and public statements.",
      "Use a three-line format: chosen action, rejected alternative, evidence and expected effect.",
      "Name one scribe and one decision owner per entry; review the log at each command update.",
      "Add the reversal condition so the next responder knows when to revisit the choice.",
      "Mark entries reconstructed after the fact and record the uncertainty.",
      "In review, evaluate the decision against the evidence available at the time, not the outcome.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Logging adds work during the incident. A short format and a dedicated scribe keep it from competing with mitigation.",
      "A detailed log can become a narrative that justifies the chosen action. Record rejected options and uncertainty to keep it honest.",
      "Decision logs can contain customer or personnel detail. Keep them internal and redact before sharing.",
      "Not every decision needs an entry. Logging too much hides the consequential ones; define the threshold in advance.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "log-vs-timeline",
    question: "What does a decision log add that an incident timeline does not?",
    difficulty: 1,
    hints: [
      "The timeline answers when and what.",
      "The log answers why and what else.",
    ],
    answer:
      "The timeline establishes sequence: what happened, when, and from which source. The decision log records intent: the options considered, the evidence used, the expected effect, the owner, and the reversal condition. A timeline can show that a breaker was disabled; only the log can show whether that was a considered tradeoff or an accident. Review needs both, because a correct sequence with missing intent invites hindsight.",
    followUps: [
      "Which decisions belong in the log?",
      "How do you keep the log from becoming a justification narrative?",
      "Who should write the entries?",
    ],
    redFlags: [
      "Treats chat history as a decision log.",
      "Records only the chosen action.",
      "Says the timeline is enough.",
    ],
    rubric: [
      "Distinguishes sequence from intent.",
      "Names options and rationale.",
      "Mentions owner and time.",
      "Explains review value.",
    ],
  },
  {
    id: "write-at-time",
    question: "Why write the decision entry during the incident instead of reconstructing it afterward?",
    difficulty: 2,
    hints: [
      "Memory favors a coherent story.",
      "The review needs the uncertainty, not the cleaned-up version.",
    ],
    answer:
      "Because memory reconstructs a coherent story after the outcome is known. The responder remembers the evidence that supports the choice and forgets the ambiguity, the alternatives that were dismissed, and the pressure at the time. Writing during the incident captures uncertainty and the actual reason. A later entry can still be useful, but it must be marked as reconstructed and treated as weaker evidence.",
    followUps: [
      "What if nobody has time during the incident?",
      "How much detail is enough?",
      "How do you handle a decision that was never explicitly made?",
    ],
    redFlags: [
      "Says memory is reliable under stress.",
      "Waits for the postmortem.",
      "Writes a polished narrative afterward.",
    ],
    rubric: [
      "Explains memory bias.",
      "Preserves uncertainty.",
      "Marks reconstructed entries.",
      "Keeps the cost low.",
    ],
  },
  {
    id: "review-risky",
    question:
      "A review finds a risky action with no rationale. How do you handle it without turning the session into blame?",
    difficulty: 3,
    hints: [
      "The missing entry is a process condition, not a character flaw.",
      "Ask what the responder knew at the time.",
    ],
    answer:
      "I ask the owner to describe the evidence and alternatives they remember, mark the account as reconstructed, and separate the missing log from the decision itself. The missing entry is a process gap: the incident did not have a scribe, a format, or a command update that reviewed the log. The decision is evaluated on the evidence available then. Actions address both the decision condition and the logging gap, without treating either as a personal failure.",
    followUps: [
      "What if the owner cannot remember?",
      "How do you record disagreement in the review?",
      "Which action comes first, the log process or the technical fix?",
    ],
    redFlags: [
      "Treats the missing entry as dishonesty.",
      "Presses for a motive.",
      "Skips the decision because the record is thin.",
    ],
    rubric: [
      "Separates process from person.",
      "Marks reconstructed evidence.",
      "Evaluates against contemporaneous evidence.",
      "Writes actions for both gaps.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Define which decisions require a log entry and where the log lives.",
      "Agree on a three-line format: action, alternative, evidence and expected effect.",
      "Name a scribe role in the incident command template.",
      "Decide how entries are linked to the timeline and the deploy record.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Log decisions at the time, not after mitigation.",
      "Record the owner, the rejected option, and the reversal condition.",
      "Review open entries at each command update.",
      "Mark reconstructed entries and the uncertainty behind them.",
    ],
  },
  {
    title: "In review",
    items: [
      "Read the decision log before debating whether an action was reasonable.",
      "Evaluate the choice against the evidence available at the time.",
      "Identify decisions that have no entry and ask why the process missed them.",
      "Feed logging gaps into the action list alongside technical fixes.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture: How You Can Learn from Failure",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Timeline reconstruction, decision context, and review practices.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident roles, live state, and the value of a shared record during response.",
  },
  {
    title: "Incident Response",
    url: "https://sre.google/workbook/incident-response/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Command, communication, and record-keeping during an active incident.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "decision-logs": {
      model: decisionLogModel,
      presets,
      instructions:
        "Start Healthy, then apply No rationale. Watch the reconstruction gap and unexplained decisions. Run the experiment, then add the missing entry and watch review time fall.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Decision counts, rationale rates, and review times are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-timeline",
    "reliability-incident-review",
    "reliability-incident-command",
    "reliability-blameless-postmortems",
  ],
};
