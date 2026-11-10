import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_FACTORS = 8;
const REVIEW_WINDOW = 20;

const params = [
  {
    id: "framing",
    label: "Systemic framing",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Draft",
    help: "Share of causal statements that describe conditions, incentives, and system design rather than an individual's character.",
    format: "percent" as const,
  },
  {
    id: "timelineDetail",
    label: "Timeline detail",
    min: 0,
    max: 100,
    step: 5,
    value: 75,
    unit: "%",
    group: "Draft",
    help: "Share of the incident reconstructed with timestamps, observations, and the information each responder had at the time.",
    format: "percent" as const,
  },
  {
    id: "factorBreadth",
    label: "Contributing factors examined",
    min: 1,
    max: 8,
    step: 1,
    value: 5,
    unit: "",
    group: "Draft",
    help: "Candidate conditions the review is willing to examine. A narrow list turns the first visible action into the whole cause.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  framing: number;
  blame: number;
  timeline: number;
  breadth: number;
  facts: number;
  expected: number;
  gap: number;
  blameIndex: number;
  recurrence: number;
  closed: boolean;
  progress: number;
}

function compute(p: Params, t: number): Values {
  const framing = clamp(num(p, "framing", 90), 0, 100);
  const timeline = clamp(num(p, "timelineDetail", 75), 0, 100);
  const breadth = clamp(Math.round(num(p, "factorBreadth", 5)), 1, 8);
  const blame = 100 - framing;
  const elapsed = Math.max(0, t);
  const decay = 1 - Math.min(1, elapsed / 40) * (blame / 100) * 0.5;
  const baseRate =
    (0.15 + (timeline / 100) * 0.55) *
    (0.45 + (breadth / 8) * 0.55) *
    (1 - (blame / 100) * 0.75) *
    decay;
  const facts = Math.min(TOTAL_FACTORS, Math.floor(baseRate * elapsed));
  const expected = Math.min(TOTAL_FACTORS, Math.floor((TOTAL_FACTORS / REVIEW_WINDOW) * Math.min(elapsed, REVIEW_WINDOW)));
  const gap = Math.max(0, expected - facts);
  const blameIndex = blame * Math.min(1, elapsed / 10);
  const closed = elapsed >= REVIEW_WINDOW;
  const recurrence = clamp(12 + gap * 4 + blame * 0.2 + (closed ? gap * 2 + 8 : 0), 0, 100);
  return {
    framing,
    blame,
    timeline,
    breadth,
    facts,
    expected,
    gap,
    blameIndex,
    recurrence,
    closed,
    progress: Math.round(clamp((elapsed / REVIEW_WINDOW) * 100, 0, 100)),
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  const timelineHealth: "ok" | "warn" | "crit" =
    v.timeline < 35 && t >= 5 ? "crit" : v.timeline < 60 ? "warn" : "ok";
  const factorsHealth: "ok" | "warn" | "crit" =
    t >= 10 && v.gap >= 4 ? "crit" : v.gap >= 2 ? "warn" : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "facts",
        label: "Incident facts",
        kind: "storage",
        health: healthOf(v.gap, 2, 4),
        utilization: clamp(0.3 + v.gap / 12),
        sublabel: `${v.facts} of ${TOTAL_FACTORS} facts shared`,
        detail: "Facts are what responders observed and when. A review that starts from a conclusion collects fewer of them.",
        meta: { view: "flow" },
      },
      {
        id: "timeline",
        label: "Timeline",
        kind: "service",
        health: timelineHealth,
        utilization: clamp(0.3 + (1 - v.timeline / 100) * 0.5),
        sublabel: `${Math.round(v.timeline)}% reconstructed`,
        detail: "The timeline records what each person knew at the time, not only what the system did. It is the difference between hindsight and evidence.",
        meta: { view: "flow" },
      },
      {
        id: "factors",
        label: "Contributing factors",
        kind: "service",
        health: factorsHealth,
        utilization: clamp(0.25 + v.gap / 14),
        sublabel: `${v.breadth} factor(s) in scope`,
        detail: "A contributing factor is a condition that made the outcome more likely. It is not a person and not a single root cause.",
        meta: { view: "flow" },
      },
      {
        id: "language",
        label: "Draft language",
        kind: "service",
        health: healthOf(v.blameIndex, 25, 50),
        utilization: clamp(0.25 + v.blameIndex / 120),
        sublabel: v.blameIndex >= 25 ? "individual blame" : "conditions described",
        detail: "Language shapes what people are willing to disclose. A sentence that names a person as the cause ends the search for conditions.",
        meta: { view: "flow" },
      },
      {
        id: "review",
        label: "Review session",
        kind: "worker",
        health: healthOf(v.recurrence, 35, 55),
        utilization: clamp(0.3 + v.recurrence / 140),
        sublabel: v.closed ? "review closed" : "evidence gathering",
        detail: "The review closes when the timeline and factors are understood, not when a name has been assigned.",
        meta: { view: "flow" },
      },
      {
        id: "actions",
        label: "Action quality",
        kind: "worker",
        health: v.closed && v.gap >= 2 ? "warn" : "ok",
        utilization: clamp(0.3 + v.gap / 16),
        sublabel: v.gap >= 2 ? "evidence missing" : "evidence based",
        detail: "Actions are only as good as the factors they address. An action written before the conditions are understood tends to target a person or a symptom.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("facts-timeline", "facts", "timeline", 1 - v.gap / 10, timelineHealth),
      edge("timeline-factors", "timeline", "factors", 1 - v.gap / 12, factorsHealth),
      edge("factors-language", "factors", "language", 1 - v.blameIndex / 120, healthOf(v.blameIndex, 25, 50)),
      edge("language-review", "language", "review", 1 - v.recurrence / 130, healthOf(v.recurrence, 35, 55)),
      edge("review-actions", "review", "actions", 1 - v.gap / 14, "ok"),
    ],
    metrics: [
      metric("evidence-gap", "Evidence gap", v.gap, " facts", 2, 4, "count"),
      metric("recurrence-risk", "Recurrence risk", v.recurrence, "%", 35, 55, "percent"),
      metric("blame-index", "Blame index", v.blameIndex, "%", 25, 50, "percent"),
      metric("factors-shared", "Factors shared", v.facts, "", undefined, undefined, "count"),
      metric("review-progress", "Review progress", v.progress, "%", undefined, undefined, "percent"),
    ],
    events: [
      {
        id: "pm-draft-opened",
        at: 0,
        severity: "info",
        title: "Postmortem draft opened",
        detail: `The draft has ${Math.round(v.timeline)}% of the timeline and ${v.breadth} contributing factor(s) in scope. The review window is ${REVIEW_WINDOW} simulated minutes.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.facts} of ${TOTAL_FACTORS} facts shared; evidence gap ${v.gap}; blame index ${v.blameIndex.toFixed(0)}%.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 8;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.985 + 0.03 * Math.sin((index + phase) / 3.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blame-index",
    metricId: "blame-index",
    warn: 25,
    crit: 50,
    title: "The draft assigns cause to a person",
    cause:
      "The review is describing an individual's action as the explanation. Once a person is named as the cause, the conditions that made the action seem correct stop being examined, and other responders withhold detail.",
    fix:
      "Rewrite the statement as a sequence of conditions: what the responder knew, what the interface showed, what the process allowed, and what made the action appear correct at the time. Keep accountability for the action; remove the person as the explanation.",
    checkFirst: [
      "Find every sentence that names a person as the cause.",
      "Ask what information the responder had when they acted.",
      "Ask which system condition made the action reasonable or easy.",
    ],
  },
  {
    id: "evidence-gap",
    metricId: "evidence-gap",
    warn: 2,
    crit: 4,
    title: "The review is closing with unexplored evidence",
    cause:
      "The draft stopped collecting facts once it had a plausible explanation. A narrow factor list and a thin timeline leave the conditions that produced the outcome unexamined.",
    fix:
      "Reopen the review, extend the timeline to the information available at each decision, and add the missing contributing factors before writing actions.",
    checkFirst: [
      "Which decisions in the timeline have no recorded context?",
      "Which contributing factor was mentioned and then dropped?",
      "Did the review ask the responders who were closest to the action?",
    ],
  },
  {
    id: "recurrence-risk",
    metricId: "recurrence-risk",
    warn: 35,
    crit: 55,
    title: "The conditions that caused the incident remain unaddressed",
    cause:
      "Blame shortened the investigation. The review closed without identifying the conditions that made the failure likely, so the same conditions are still present.",
    fix:
      "Reopen the analysis, replace individual explanation with contributing conditions, and write actions that change those conditions. Verify each action against the failure scenario.",
    checkFirst: [
      "Which contributing factor has no action against it?",
      "Would the same action still seem correct to a new responder with the same information?",
      "Which action depends only on people being more careful?",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const postmortemModel: SimModel = {
  id: "reliability-blameless-postmortems",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), 0, seed),
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, frame.t, seed);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.events = frame.events.slice(-60);
    const v = compute(p, frame.t);
    if (v.blameIndex >= 25 && frame.flags.pmBlame !== 1) {
      pushEvent(next, {
        id: "pm-blame-language",
        at: frame.t,
        severity: "warn",
        title: "Draft names an individual as the cause",
        detail: "The sentence describes what the engineer did, not the information and conditions that made the action seem correct. Responders begin withholding detail from the review.",
        nodeId: "language",
        metricId: "blame-index",
      });
      next.flags.pmBlame = 1;
    }
    if (v.gap >= 4 && frame.flags.pmGap !== 1) {
      pushEvent(next, {
        id: "pm-evidence-gap",
        at: frame.t,
        severity: "crit",
        title: "Review is closing with unexplained conditions",
        detail: "The draft has a conclusion but the timeline is thin and the contributing factors are unexamined. The same conditions will produce the same failure.",
        nodeId: "factors",
        metricId: "evidence-gap",
      });
      next.flags.pmGap = 1;
    }
    if (v.closed && v.gap < 2 && frame.flags.pmComplete !== 1) {
      pushEvent(next, {
        id: "pm-review-complete",
        at: frame.t,
        severity: "info",
        title: "Review evidence covers the contributing factors",
        detail: "The timeline records what each responder knew, the contributing factors are examined, and the draft describes conditions rather than people.",
        nodeId: "review",
      });
      next.flags.pmComplete = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `${v.facts} of ${TOTAL_FACTORS} contributing facts have been shared. The evidence gap is ${v.gap}.`,
      `The blame index is ${v.blameIndex.toFixed(0)}%. Blame is not a tone problem; it changes what people are willing to say.`,
      `${v.breadth} factor(s) are in scope. A factor that is not on the list cannot be examined, even if a responder mentions it.`,
      `Recurrence risk is ${v.recurrence.toFixed(0)}%. It rises when the review closes over conditions it never examined.`,
    ];
  },
  legend: [
    { label: "Learning", tone: "ok" },
    { label: "Evidence thin", tone: "warn" },
    { label: "Blame", tone: "crit" },
    { label: "Review stopped", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A systemic draft with a detailed timeline and a broad factor list.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Thin draft",
    description: "A plausible conclusion, a partial timeline, and only four factors in scope.",
    tone: "warn",
    params: defaults({ framing: 75, timelineDetail: 65, factorBreadth: 4 }),
    elapsed: 20,
  },
  {
    id: "failure",
    label: "Blameful draft",
    description: "The draft names the engineer, the timeline stops at the command, and only two factors are examined.",
    tone: "crit",
    params: defaults({ framing: 20, timelineDetail: 25, factorBreadth: 2 }),
    elapsed: 8,
  },
  {
    id: "recovery",
    label: "Blameless rewrite",
    description: "Conditions described, timeline reconstructed, and all eight factors examined.",
    tone: "ok",
    params: defaults({ framing: 100, timelineDetail: 100, factorBreadth: 8 }),
  },
];

const experiment: Experiment = {
  id: "predict-rewrite",
  title: "Predict which edit unlocks the most information",
  simId: "postmortems",
  question:
    "The draft says: \"The engineer restarted the wrong node and caused the outage.\" Which edit produces the most useful review?",
  prediction: {
    options: [
      { id: "conditions", label: "Describe the information and conditions that made the restart seem correct" },
      { id: "actions", label: "Add more action items at the end of the draft" },
      { id: "timeline", label: "Shorten the timeline to the restart command" },
      { id: "careful", label: "Ask the engineer to be more careful next time" },
    ],
    correctOptionId: "conditions",
    explanation:
      "A blameful sentence ends the investigation at the person. Describing the conditions reopens it: what the runbook said, what the console showed, what the change process allowed, and what made the action reasonable at the time. Actions written before those conditions are understood tend to target a symptom.",
  },
  setup: defaults({ framing: 20, timelineDetail: 25, factorBreadth: 2 }),
  runFor: 30,
  observe: [
    "The blame index crosses its warning threshold before the evidence gap becomes visible.",
    "Facts stop arriving as the draft names an individual; the evidence gap widens.",
    "The review closes with four or more contributing facts unexplored.",
    "Recurrence risk crosses critical while the draft still looks complete.",
  ],
  explain:
    "Blameless analysis is not a softer tone. It is a method for keeping the information flowing. When a person is named as the cause, the review stops asking why the action seemed correct, and the conditions that will produce the next action remain in place. The draft can be polite and still be blameful if it ends at an individual.",
  fix: defaults({ framing: 100, timelineDetail: 100, factorBreadth: 8 }),
  debrief:
    "The rewritten draft still records who ran the command and what happened. It adds what they knew, what the interface showed, and which process allowed the action. That is what makes the resulting actions target conditions rather than vigilance. The cost is a longer review and more interviews.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A blameless postmortem is a structured review of an incident that explains the outcome through conditions, information, incentives, and system design rather than through the character or carelessness of an individual. It still records who did what. It does not treat the person as the explanation.",
  },
  {
    type: "p",
    text: "Blameless does not mean accountability-free. People remain accountable for their actions, and an organization can still address reckless behavior. What blameless analysis refuses to do is stop at the person. The useful question is not \"who caused this?\" but \"what made this action seem correct, available, or necessary at the time?\"",
  },
  {
    type: "p",
    text: "The reason is informational, not moral. If the review punishes the person who reports a mistake, the next person with a detail decides that silence is safer. The review then writes actions against the facts it has, which are usually the facts that were already visible. Blame feels like accountability and functions as information loss.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The postmortem starts after the incident is mitigated and the timeline is captured. The incident review meeting uses the draft; the action tracker turns its contributing factors into work. Incident command produced the decisions, and the postmortem examines why those decisions were reasonable with the information available.",
  },
  {
    type: "table",
    headers: ["Draft statement", "What it explains", "What it hides"],
    rows: [
      ["The engineer restarted the wrong node", "One visible action", "The runbook, console, and role information that pointed there"],
      ["The team skipped the checklist", "A missing step", "The stress, length, and verification gaps that made skipping likely"],
      ["A bad deploy caused the outage", "A change", "The review, canary, and rollback conditions that let it reach traffic"],
      ["The on-call escalated too late", "A delay", "The authority, trigger, and context that made asking costly"],
    ],
  },
  {
    type: "p",
    text: "This module models a postmortem review as a draft that accumulates facts over a 20-second review window. One simulated second represents one review minute. The evidence rates, factor counts, and thresholds are illustrative teaching values, not a standard for any organization.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Evidence gap: facts a healthy review would have gathered by now but this draft has not.",
      "Blame index: how much of the draft's causal language points at an individual.",
      "Recurrence risk: the chance the same conditions produce the same failure again.",
      "Factors shared: how many contributing facts made it into the review.",
      "A flow view of facts, timeline, contributing factors, draft language, review, and actions.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Blameful draft. Watch the blame index before the evidence gap: the language changes first, then the facts stop arriving. Run the experiment before reading the debrief, then rewrite one sentence at a time and watch the gap close.",
  },
  {
    type: "compare",
    leftTitle: "Blameful conclusion",
    rightTitle: "Blameless analysis",
    rows: [
      { label: "Question", left: "Who did this?", right: "What made this action seem correct?" },
      { label: "Evidence", left: "Stops at the visible action", right: "Includes information, interface, and process" },
      { label: "Participation", left: "Responders withhold detail", right: "Responders can describe what they saw" },
      { label: "Action", left: "Be more careful or add a warning", right: "Change the condition that produced the action" },
    ],
  },
  { type: "sim", simId: "postmortems" },
  { type: "experiment", experimentId: "predict-rewrite" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The draft named the engineer and described the restart as the cause. The first responder supplied the visible facts: the command, the timestamp, the node. The details that mattered were never requested: which node the runbook named, what the console displayed, whether the role had changed, and who had verified the topology. The review closed with a conclusion and an evidence gap.",
  },
  {
    type: "p",
    text: "Rewriting the sentence did not remove accountability. It changed the question from character to conditions. The timeline grew, the factor list expanded, and the actions targeted the runbook and the console rather than the person. Recurrence risk fell because the conditions that produced the action were now visible.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Postmortem document: a timeline that jumps from alert to action with no record of what the responder knew.",
      "Review meeting: one person explains their action defensively while others describe the system in general terms.",
      "Action list: items such as \"be more careful\", \"add a warning\", or \"retrain the team\" with no condition changed.",
      "Incident channel: details offered privately after the review, not in the document.",
      "Recurrence: a similar incident with a different person and the same conditions.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find every sentence that names a person as the cause. For each one, ask what information the person had, what the interface showed, and which process made the action available. If the answer is missing from the draft, the review is not finished.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Separate the timeline from the conclusion. Record observations and decisions before explaining them.",
      "Rewrite individual explanations as conditions: information available, interface behavior, incentives, and process.",
      "Ask the responders closest to the action what they saw and what they expected to happen.",
      "List contributing factors and mark which ones the review has evidence for.",
      "Write actions against conditions, not against vigilance. Each action needs an owner and a verification.",
      "Re-read the draft for sentences that would make the next responder hesitate to share a detail.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Blameless review takes longer because it examines conditions instead of closing on a name. The extra time buys better actions.",
      "Blameless does not mean consequence-free. Severe recklessness still needs a separate accountability process, and mixing it into the learning review suppresses information.",
      "A systemic explanation can become so broad that no one owns anything. Keep specific owners for the actions even when the cause is systemic.",
      "Public postmortems improve learning but raise the cost of candor. Redact customer and personnel details without removing the conditions.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-blameless-means",
    question: "What does blameless mean in a postmortem, and what does it not mean?",
    difficulty: 2,
    hints: [
      "It is about information, not absolution.",
      "Accountability for actions can coexist with systemic analysis.",
    ],
    answer:
      "It means the review explains the outcome through conditions and system design rather than treating an individual as the cause. It does not mean nobody is accountable, and it does not mean the organization ignores recklessness. It means the learning process does not punish the person who shares a mistake, because that punishment removes the information the review needs. A separate accountability process can exist, but it should not contaminate the postmortem.",
    followUps: [
      "How do you handle a genuinely careless action?",
      "Who decides when to involve accountability?",
      "Does blameless apply to contractors and vendors?",
    ],
    redFlags: [
      "Says blameless means no consequences ever.",
      "Uses blameless to avoid naming an owner.",
      "Mixes discipline into the review.",
    ],
    rubric: [
      "Explains the informational purpose.",
      "Keeps accountability separate.",
      "Distinguishes learning from discipline.",
      "States what blameless does not excuse.",
    ],
  },
  {
    id: "rewrite-statement",
    question: "Rewrite this statement: \"The engineer restarted the wrong node.\"",
    difficulty: 2,
    hints: [
      "Keep the action and the outcome.",
      "Add what the person knew and what the system showed.",
    ],
    answer:
      "A good rewrite keeps the action and adds the conditions: \"The responder restarted the node the runbook identified as primary. The console listed it as primary, the runbook had not been updated after the failover pair was introduced, and no step required checking the live role. The restart removed the standby and left the service with reduced capacity.\" It does not remove the person's action or the consequence. It makes the conditions that produced the action visible, which is what an action item can change.",
    followUps: [
      "What if the responder ignored a clear warning?",
      "How much detail belongs in the timeline?",
      "Who should review the rewrite?",
    ],
    redFlags: [
      "Removes the action entirely.",
      "Adds motive or character.",
      "Writes an action before the conditions are clear.",
    ],
    rubric: [
      "Keeps the action and outcome.",
      "Adds information and system conditions.",
      "Avoids motive and character.",
      "Points toward a changeable condition.",
    ],
  },
  {
    id: "blame-suppresses",
    question: "Why does blame reduce the quality of the postmortem, even when the blamed action is real?",
    difficulty: 3,
    hints: [
      "Think about the next person who has a detail.",
      "The review only knows what people are willing to say.",
    ],
    answer:
      "Because the review depends on disclosure. If sharing a detail exposes a colleague or yourself to punishment, the rational move is to share less. The review then gets the visible facts and misses the context: the ambiguous console, the stale runbook, the pressure to restore service. The blamed action may be real, but the explanation stops at it. The conditions remain, and the next responder makes a similar action for similar reasons.",
    followUps: [
      "What signals show that people are withholding detail?",
      "How do you rebuild trust after a blameful review?",
      "Does anonymity help or hurt?",
    ],
    redFlags: [
      "Says people should just be professional.",
      "Treats disclosure as guaranteed.",
      "Focuses on tone instead of information.",
    ],
    rubric: [
      "Links blame to disclosure.",
      "Names the missing context.",
      "Explains recurrence.",
      "Suggests a trust-building step.",
    ],
  },
  {
    id: "severe-outcome",
    question:
      "The incident caused a long customer outage. How do you keep the review blameless without minimizing the impact?",
    difficulty: 3,
    hints: [
      "Blameless is not the same as low severity.",
      "State the impact plainly, then examine the conditions.",
    ],
    answer:
      "I state the impact plainly and keep it in the document. Blameless does not require softening the consequence. Then I separate the learning review from any accountability process. The review examines the decisions, information, and system conditions that produced the outage, including the conditions that made a bad decision likely. If individual conduct needs a separate process, that process runs separately and does not shape what people can say in the review. The severity raises the bar for action quality, not for blame.",
    followUps: [
      "Who communicates the impact externally?",
      "How do you handle legal or regulatory constraints?",
      "What if the team wants a person removed?",
    ],
    redFlags: [
      "Softens the impact to protect feelings.",
      "Lets the accountability process run the review.",
      "Treats blameless as a ban on consequences.",
    ],
    rubric: [
      "States impact plainly.",
      "Separates learning from accountability.",
      "Examines conditions.",
      "Raises action quality with severity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the review",
    items: [
      "The timeline is captured from logs, chat, and responder notes before memories fade.",
      "The review invitation states that the purpose is learning, not discipline.",
      "Responders closest to the action are invited and expected to speak.",
      "The draft separates observations from conclusions.",
    ],
  },
  {
    title: "During the review",
    items: [
      "Ask what each responder knew and expected at the time of the action.",
      "Replace individual explanations with conditions and information.",
      "List contributing factors and mark the evidence for each.",
      "Look for actions that depend only on people being more careful.",
      "Record disagreements and open questions, not only the agreed story.",
    ],
  },
  {
    title: "After the review",
    items: [
      "Re-read the draft for blameful language and unexplained conclusions.",
      "Check that every contributing factor has an action or a stated reason for no action.",
      "Give each action an owner, a due date, and a verification.",
      "Share the postmortem widely enough that other teams can learn from it.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture: Learning from Failure",
    url: "https://sre.google/sre-book/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Blameless postmortem practice, review culture, and the value of written records.",
  },
  {
    title: "Blameless PostMortems and a Just Culture",
    url: "https://www.etsy.com/codeascraft/blameless-postmortems",
    publisher: "Etsy",
    kind: "postmortem" as const,
    note: "The case for blameless analysis and the conditions that make people willing to share details.",
  },
  {
    title: "Postmortem Culture",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Review practices, action quality, and organizational learning from incidents.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    postmortems: {
      model: postmortemModel,
      presets,
      instructions:
        "Start Healthy, then apply Blameful draft. Watch the blame index before the evidence gap, then compare with the blameless rewrite. Change one drafting choice at a time.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one review minute; evidence rates and factor counts are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-action-items",
    "reliability-incident-command",
    "reliability-incident-review",
    "reliability-postmortem-actions",
  ],
};
