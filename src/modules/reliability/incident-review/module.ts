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

const FACTOR_COUNT = 8;

const params: ParamSpec[] = [
  {
    id: "facilitation",
    label: "Facilitation coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "%",
    group: "Meeting",
    help: "Share of the review held to an agenda, timeboxes, and a facilitator who redirects blame and keeps the discussion on evidence.",
    format: "percent",
  },
  {
    id: "systemicFraming",
    label: "Systemic framing",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Discussion",
    help: "Share of causal discussion that describes conditions, information, and incentives rather than an individual's character or carelessness.",
    format: "percent",
  },
  {
    id: "reviewCoverage",
    label: "Timeline and factors reviewed",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "%",
    group: "Evidence",
    help: "Share of the timeline and contributing factors the meeting actually examines. A review that only reads the summary cannot challenge it.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  facilitation: number;
  systemic: number;
  coverage: number;
  blame: number;
  unresolved: number;
  actionQuality: number;
  qualityGap: number;
  derailment: number;
  reviewMinutes: number;
}

function compute(p: Params): Values {
  const facilitation = clamp(num(p, "facilitation", 85), 0, 100);
  const systemic = clamp(num(p, "systemicFraming", 80), 0, 100);
  const coverage = clamp(num(p, "reviewCoverage", 85), 0, 100);
  const blame = clamp(100 - systemic * 0.9 - facilitation * 0.2, 0, 100);
  const unresolved = clamp(FACTOR_COUNT - Math.round((FACTOR_COUNT * coverage) / 100), 0, FACTOR_COUNT);
  const actionQuality = clamp(systemic * 0.5 + coverage * 0.3 + facilitation * 0.2, 0, 100);
  const qualityGap = 100 - actionQuality;
  return {
    facilitation,
    systemic,
    coverage,
    blame,
    unresolved,
    actionQuality,
    qualityGap,
    derailment: clamp(blame * 0.6 + (100 - facilitation) * 0.5, 0, 100),
    reviewMinutes: clamp(20 + (100 - facilitation) * 0.4 + unresolved * 4, 0, 120),
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p);
  return {
    t,
    nodes: [
      {
        id: "agenda",
        label: "Agenda and timeboxes",
        kind: "service",
        health: healthOf(100 - v.facilitation, 30, 50),
        utilization: clamp(0.25 + (100 - v.facilitation) / 120),
        sublabel: `${v.reviewMinutes} min planned`,
        detail: "A short agenda: what happened, what contributed, what changes. Timeboxes stop one theory from consuming the session.",
        meta: { view: "flow" },
      },
      {
        id: "timeline",
        label: "Timeline review",
        kind: "storage",
        health: healthOf(100 - v.coverage, 30, 50),
        utilization: clamp(0.3 + (100 - v.coverage) / 130),
        sublabel: `${v.coverage.toFixed(0)}% reviewed`,
        detail: "The meeting walks the chronology before discussing cause. Events that are skipped cannot be challenged and are usually the ones that matter.",
        meta: { view: "flow" },
      },
      {
        id: "factors",
        label: "Contributing factors",
        kind: "storage",
        health: healthOf(v.unresolved, 2, 4),
        utilization: clamp(0.25 + v.unresolved / 14),
        sublabel: `${FACTOR_COUNT - v.unresolved} of ${FACTOR_COUNT} examined`,
        detail: "The conditions the review is willing to examine. The facilitator keeps adding factors until the explanation stops at a person or a single trigger.",
        meta: { view: "flow" },
      },
      {
        id: "discussion",
        label: "Discussion",
        kind: "worker",
        health: healthOf(v.derailment, 30, 60),
        utilization: clamp(0.3 + v.derailment / 130),
        sublabel: v.derailment >= 60 ? "blame spiral" : "evidence-based",
        detail: "The conversation itself. A facilitator redirects motive questions to information and conditions, and records disagreement instead of resolving it by authority.",
        meta: { view: "flow" },
      },
      {
        id: "actions",
        label: "Action quality",
        kind: "worker",
        health: healthOf(v.qualityGap, 30, 50),
        utilization: clamp(0.25 + v.qualityGap / 120),
        sublabel: `${v.actionQuality.toFixed(0)}% quality score`,
        detail: "The action set the review accepts. It is only as good as the factors the meeting examined and the framing it used.",
        meta: { view: "flow" },
      },
      {
        id: "followup",
        label: "Follow-up",
        kind: "service",
        health: healthOf(v.blame, 25, 50),
        utilization: clamp(0.3 + v.blame / 120),
        sublabel: v.blame >= 50 ? "trust damaged" : "learning loop open",
        detail: "The next review and the next responder. A blameful meeting teaches people to bring less information next time.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("agenda-timeline", "agenda", "timeline", v.facilitation / 100, healthOf(100 - v.facilitation, 30, 50)),
      edge("timeline-factors", "timeline", "factors", v.coverage / 100, healthOf(v.unresolved, 2, 4)),
      edge("factors-discussion", "factors", "discussion", 1 - v.blame / 120, healthOf(v.derailment, 30, 60)),
      edge("discussion-actions", "discussion", "actions", v.actionQuality / 100, healthOf(v.qualityGap, 30, 50)),
      edge("actions-followup", "actions", "followup", 1 - v.blame / 120, healthOf(v.blame, 25, 50)),
    ],
    metrics: [
      metric("blame-index", "Blame index", v.blame, "%", 25, 50, "percent"),
      metric("unresolved-factors", "Unexamined factors", v.unresolved, "", 2, 4, "count"),
      metric("action-quality-gap", "Action quality gap", v.qualityGap, "%", 30, 50, "percent"),
      metric("derailment", "Discussion derailment", v.derailment, "%", 30, 60, "percent"),
      metric("review-minutes", "Review duration", v.reviewMinutes, " min", 45, 70, "number"),
    ],
    events: [
      {
        id: "ir-review-opened",
        at: 0,
        severity: "info",
        title: "Incident review opened",
        detail: `Facilitation covers ${v.facilitation.toFixed(0)}% of the meeting, ${v.coverage.toFixed(0)}% of the timeline and factors are reviewed, and systemic framing is ${v.systemic.toFixed(0)}%.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Blame index ${v.blame.toFixed(0)}%; ${v.unresolved} factor(s) unexamined; action quality gap ${v.qualityGap.toFixed(0)}%; review ${v.reviewMinutes} minutes.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.975 + 0.05 * Math.sin((index + phase) / 3.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blame-index",
    metricId: "blame-index",
    warn: 25,
    crit: 50,
    title: "The review is arguing about a person",
    cause:
      "The discussion moved from what happened to who did it. Once a person is the subject, responders defend themselves, details become scarce, and the conditions that made the action seem correct stop being examined.",
    fix:
      "Redirect to the timeline and ask what information the responder had, what the interface showed, and what the process allowed. Keep accountability for the action; remove the person as the explanation. Record the redirect so the meeting has a shared method.",
    checkFirst: [
      "Find the question that turned the discussion toward a person.",
      "Ask what the responder knew at the time.",
      "Ask which system condition made the action reasonable or easy.",
    ],
  },
  {
    id: "unresolved-factors",
    metricId: "unresolved-factors",
    warn: 2,
    crit: 4,
    title: "The review is closing over unexamined conditions",
    cause:
      "The meeting read the summary but skipped parts of the timeline and several contributing factors. The action set is being written against an incomplete explanation.",
    fix:
      "Walk the timeline, list every contributing factor, and mark which ones the meeting has evidence for. Leave the review open for the missing ones or record them as open questions with an owner.",
    checkFirst: [
      "Which timeline events were skipped?",
      "Which factor was mentioned and then dropped?",
      "Which responder has firsthand knowledge the meeting did not ask?",
    ],
  },
  {
    id: "action-quality-gap",
    metricId: "action-quality-gap",
    warn: 30,
    crit: 50,
    title: "The actions do not match what the review examined",
    cause:
      "Low systemic framing or thin coverage produces actions against the visible trigger or an individual. The meeting accepts them because they are concrete and finishable.",
    fix:
      "Reopen the action set against the factor list. Replace vigilance requests with system changes, add verification, and state why any factor is left uncovered.",
    checkFirst: [
      "Compare the action list with the factor list.",
      "Find actions that depend only on people being more careful.",
      "Check whether every action has a verification.",
    ],
  },
  {
    id: "derailment",
    metricId: "derailment",
    warn: 30,
    crit: 60,
    title: "The discussion has lost the evidence",
    cause:
      "Facilitation is weak and the framing is blameful. The meeting revisits the same argument, interrupts the people closest to the action, and spends its time on motive rather than conditions.",
    fix:
      "Pause, restate the agenda and the remaining time, and return to the timeline. Park unresolved disagreements in a written open-question list rather than settling them by repetition or authority.",
    checkFirst: [
      "Check how long the meeting has spent on one event.",
      "Check whether the people closest to the action are speaking.",
      "Check whether the same point has been restated without new evidence.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const incidentReviewModel: SimModel = {
  id: "reliability-incident-review",
  visual: "flow",
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
    if (v.blame >= 50 && frame.flags.reviewBlame !== 1) {
      pushEvent(next, {
        id: "ir-blame-spiral",
        at: frame.t,
        severity: "crit",
        title: "The review has become a blame inquiry",
        detail: "Responders are defending actions instead of explaining conditions. Pause the discussion, return to the timeline, and ask what information was available at the time.",
        nodeId: "discussion",
        metricId: "blame-index",
      });
      next.flags.reviewBlame = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    return [
      `The blame index is ${v.blame.toFixed(0)}% and discussion derailment is ${v.derailment.toFixed(0)}%.`,
      `${v.unresolved} of ${FACTOR_COUNT} contributing factors are unexamined; the action quality gap is ${v.qualityGap.toFixed(0)}%.`,
      `The review takes ${v.reviewMinutes} minutes with ${v.facilitation.toFixed(0)}% facilitation coverage and ${v.coverage.toFixed(0)}% timeline coverage.`,
      "Facilitation is not politeness. It is the control that keeps the meeting on evidence long enough to produce systemic actions.",
    ];
  },
  legend: [
    { label: "Evidence-based", tone: "ok" },
    { label: "Discussion drifting", tone: "warn" },
    { label: "Blame spiral", tone: "crit" },
    { label: "Learning lost", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A facilitated review walks the timeline, examines most factors, and keeps the discussion on conditions.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Thin facilitation",
    description: "The meeting has an agenda but the discussion drifts, skips several factors, and accepts weaker actions.",
    tone: "warn",
    params: defaults({ facilitation: 60, systemicFraming: 55, reviewCoverage: 60 }),
  },
  {
    id: "failure",
    label: "Blame spiral",
    description: "The review is an argument about who ran the command, most factors are skipped, and the actions ask for care.",
    tone: "crit",
    params: defaults({ facilitation: 20, systemicFraming: 20, reviewCoverage: 30 }),
    elapsed: 8,
  },
  {
    id: "recovery",
    label: "Facilitated and complete",
    description: "The facilitator covers the timeline, examines every factor, and holds the discussion at the system level.",
    tone: "ok",
    params: defaults({ facilitation: 100, systemicFraming: 100, reviewCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-review-redirect",
  title: "Predict the facilitator's next move",
  simId: "incident-review",
  question:
    "A review of a failed failover turns into an argument about which engineer ran the wrong command. What should the facilitator do next?",
  prediction: {
    options: [
      {
        id: "redirect",
        label: "Return to the timeline and ask what information and conditions made that command seem correct",
      },
      { id: "vote", label: "Ask the room to vote on whether the engineer was at fault" },
      { id: "end", label: "End the review and let the manager handle the accountability" },
      { id: "policy", label: "Add a policy requiring two approvals before any failover command" },
    ],
    correctOptionId: "redirect",
    explanation:
      "The review needs the conditions behind the action: what the runbook said, what the console showed, what the role assignment was, and who had verified the topology. Returning to the timeline reopens the evidence. A vote turns the meeting into a tribunal, ending the review loses the learning, and a new approval policy may add friction without addressing the condition that pointed at the wrong command.",
  },
  setup: defaults({ facilitation: 25, systemicFraming: 25, reviewCoverage: 35 }),
  runFor: 30,
  observe: [
    "The blame index crosses critical before the factors are examined.",
    "Discussion derailment rises while the timeline sits unread.",
    "Unexamined factors stay high, so the actions target the visible command.",
    "The review closes with a defense and no systemic change.",
  ],
  explain:
    "An incident review is a facilitated evidence process. The timeline supplies sequence, the factors supply conditions, and the facilitator keeps the discussion at that level. When the meeting moves to motive, the people closest to the action stop disclosing detail and the action set loses its target. The facilitator's move is not to suppress disagreement; it is to redirect it to evidence.",
  fix: defaults({ facilitation: 100, systemicFraming: 100, reviewCoverage: 100 }),
  debrief:
    "With the redirect, the review examines the stale runbook, the ambiguous console, and the missing role check. The action set changes those conditions instead of asking for care. The tradeoff is time: facilitation and full timeline coverage make the review longer than a quick argument. The extra time buys actions that can survive contact with the next incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An incident review is the meeting where the written postmortem is examined, challenged, and turned into actions. It is not a reading of the document. It walks the timeline, tests the contributing factors against evidence, hears from the people closest to the action, and agrees what will change.",
  },
  {
    type: "p",
    text: "The review is a facilitated process, not a free discussion. The facilitator keeps time, protects the people closest to the action, redirects motive questions to information and conditions, and records disagreements instead of settling them by seniority. The goal is not consensus on a story. It is a defensible set of conditions and a small set of actions that address them.",
  },
  {
    type: "p",
    text: "The failure mode is a meeting that becomes a tribunal. One question about who ran the command changes the room. Responders defend themselves, the timeline stops being read, and the action list becomes a warning or an approval step. The incident is closed, the conditions remain, and the next review repeats the pattern.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The blameless postmortem produces the draft and the language. This module runs the meeting that challenges it. Action quality determines what leaves the meeting. Incident command, the decision log, and the timeline supply the evidence the review examines.",
  },
  {
    type: "table",
    headers: ["Phase", "Question", "Failure if skipped"],
    rows: [
      ["Timeline", "What happened, in what order, from which source?", "The review argues about facts it never established"],
      ["Factors", "Which conditions made the outcome likely?", "The explanation stops at the visible action"],
      ["Discussion", "What did each responder know at the time?", "The meeting fills gaps with hindsight and motive"],
      ["Actions", "What changes the conditions, and how will we verify it?", "The list asks for care and the incident recurs"],
    ],
  },
  {
    type: "p",
    text: "This module models a review meeting with eight contributing factors. Facilitation, framing, and coverage are illustrative teaching values, not a maturity score.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Blame index: how much of the discussion points at a person.",
      "Unexamined factors: conditions the meeting is closing over.",
      "Action quality gap: distance from a systemic, verified action set.",
      "Discussion derailment: how far the meeting has drifted from evidence.",
      "Review duration: the time cost of facilitation and coverage.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Blame spiral. Watch the blame index and derailment move before the action quality gap. Run the experiment before reading the debrief, then restore facilitation and coverage and watch the factors get examined.",
  },
  {
    type: "compare",
    leftTitle: "Tribunal",
    rightTitle: "Facilitated review",
    rows: [
      { label: "Question", left: "Who ran the command?", right: "What made that action seem correct?" },
      { label: "Evidence", left: "Memory and authority", right: "Timeline and recorded decisions" },
      { label: "Disagreement", left: "Settled by repetition", right: "Recorded as an open question" },
      { label: "Output", left: "A warning or an approval step", right: "A system change with verification" },
    ],
  },
  { type: "sim", simId: "incident-review" },
  { type: "experiment", experimentId: "predict-review-redirect" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The review started with the summary: a failover went to the wrong node. Within minutes the discussion was about the engineer who ran the command. The timeline was not walked, three factors were never mentioned, and the people closest to the action spoke less. The meeting ended with an action to require a second approval before failover commands.",
  },
  {
    type: "p",
    text: "The facilitated run opened the timeline and found that the runbook still named the old primary, the console displayed a stale role, and the change process had no step to verify the live topology. The action set changed the runbook and the console. The approval step disappeared because the condition that made the command reasonable was addressed.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Review meeting: one engineer explaining a command while others look at the floor.",
      "Timeline: skipped because the summary already suggests a cause.",
      "Factors: three conditions mentioned once and never examined.",
      "Actions: an approval step or a reminder added to the runbook.",
      "Next review: a similar incident with a different engineer and the same stale runbook.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the moment the discussion moved from what happened to who did it. Return to the timeline and ask what the responder knew, what the interface showed, and what the process allowed. If the people closest to the action have stopped speaking, the review has already lost evidence.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Send the timeline and factor list before the meeting and ask attendees to bring evidence, not theories.",
      "Open with the sequence and walk it before discussing cause.",
      "Redirect motive questions to information, interface, and process conditions.",
      "Protect the people closest to the action; ask them first and do not interrupt.",
      "Record disagreements and open questions rather than resolving them by authority.",
      "Close only when every factor has an action or a stated reason for no action.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Facilitation and full timeline coverage make the review longer. The time buys actions that target conditions.",
      "Blameless framing can feel like avoiding accountability. Keep a separate accountability process for conduct, and do not let it shape the learning review.",
      "Recording disagreement can look indecisive. An explicit open question with an owner is stronger than a false consensus.",
      "A strict agenda can suppress a real insight. Leave a short open slot after the structured review.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "facilitator-role",
    question: "What does the facilitator of an incident review actually do?",
    difficulty: 1,
    hints: [
      "It is not a neutral note-taker.",
      "The job is to protect evidence and time.",
    ],
    answer:
      "The facilitator owns the process: set the agenda, walk the timeline, keep time, invite the people closest to the action, redirect blame and speculation to evidence, and record disagreements. They do not decide the cause or defend the team. They keep the meeting at the level of conditions long enough for the action set to target something real.",
    followUps: [
      "Should the facilitator be the incident commander?",
      "How do you handle a senior person who dominates?",
      "What does the facilitator write down?",
    ],
    redFlags: [
      "Says the facilitator decides the cause.",
      "Treats facilitation as note-taking.",
      "Lets the loudest person set the agenda.",
    ],
    rubric: [
      "Owns process, not conclusion.",
      "Protects evidence and people.",
      "Manages time and participation.",
      "Records disagreement.",
    ],
  },
  {
    id: "redirect-blame",
    question: "The review turns to who ran the command. What do you say, and what do you ask next?",
    difficulty: 2,
    hints: [
      "Keep the action and the consequence.",
      "Ask what made the action seem correct.",
    ],
    answer:
      "I acknowledge the action and its consequence, then say the review needs the conditions that made it seem correct rather than a verdict on the person. I ask what the responder saw in the console, what the runbook said, what the role assignment was, and who had verified the topology. Then I return to the timeline so the answers are anchored to evidence. The person remains accountable for the action; the review is examining why it was reasonable at the time.",
    followUps: [
      "What if the responder refuses to engage?",
      "How do you handle a genuine conduct issue?",
      "What if the room disagrees with the redirect?",
    ],
    redFlags: [
      "Tells people not to feel bad.",
      "Drops the accountability question entirely.",
      "Lets the argument continue to avoid conflict.",
    ],
    rubric: [
      "Redirects to conditions.",
      "Anchors to evidence.",
      "Keeps accountability separate.",
      "Handles resistance.",
    ],
  },
  {
    id: "close-review",
    question: "When is an incident review finished?",
    difficulty: 3,
    hints: [
      "Not when the document has been read.",
      "Factors, actions, and verification.",
    ],
    answer:
      "It is finished when the timeline has been walked, every contributing factor has an action or a stated reason for no action, and each action has an owner, a verification, and a date. Open disagreements are recorded with an owner. The meeting should also agree on what would count as recurrence and when the actions will be reviewed. Reading the document and agreeing that it sounds right is not a close.",
    followUps: [
      "What if a factor cannot be fixed now?",
      "Who accepts the action set?",
      "How do you follow up without another full review?",
    ],
    redFlags: [
      "Closes when the document is approved.",
      "Accepts unowned actions.",
      "Leaves factors without a decision.",
    ],
    rubric: [
      "Requires timeline coverage.",
      "Requires factor coverage.",
      "Requires owner and verification.",
      "Defines follow-up.",
    ],
  },
];

const checklist = [
  {
    title: "Before",
    items: [
      "Send the timeline, factor list, and draft actions to attendees.",
      "Name a facilitator who is not the incident commander.",
      "Invite the people closest to the decisions and actions.",
      "Set a short agenda with timeboxes for timeline, factors, and actions.",
    ],
  },
  {
    title: "During",
    items: [
      "Walk the timeline before discussing cause.",
      "Ask what each responder knew, saw, and expected at the time.",
      "Redirect motive questions to information, interface, and process conditions.",
      "Record disagreements and open questions with an owner.",
      "Check every action against a factor and a verification.",
    ],
  },
  {
    title: "After",
    items: [
      "Publish the factor-to-action map and the open questions.",
      "Give each action an owner, a date, and a verification.",
      "Schedule a short follow-up on verification results.",
      "Review whether the meeting protected the people closest to the action.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture: Learning from Failure",
    url: "https://sre.google/sre-book/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Review culture, blameless framing, and the conditions for useful discussion.",
  },
  {
    title: "Postmortem Culture: How You Can Learn from Failure",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Review facilitation, action quality, and organizational learning.",
  },
  {
    title: "Postmortem Documentation",
    url: "https://postmortems.pagerduty.com/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Postmortem structure, review process, and action tracking.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "incident-review": {
      model: incidentReviewModel,
      presets,
      instructions:
        "Start Healthy, then apply Blame spiral. Watch the blame index and derailment rise while factors go unexamined. Run the experiment, then restore facilitation and coverage.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Facilitation, framing, and coverage rates are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-blameless-postmortems",
    "reliability-postmortem-actions",
    "reliability-decision-logs",
    "reliability-timeline",
  ],
};
