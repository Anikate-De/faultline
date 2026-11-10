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

const ACTION_COUNT = 6;
const FACTOR_COUNT = 8;

const params: ParamSpec[] = [
  {
    id: "systemicShare",
    label: "Actions that change a system",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Content",
    help: "Share of actions that change a default, guardrail, validation, capacity limit, or process condition rather than asking people to be more careful.",
    format: "percent",
  },
  {
    id: "verificationStrength",
    label: "Actions with verification",
    min: 0,
    max: 100,
    step: 5,
    value: 75,
    unit: "%",
    group: "Verification",
    help: "Share of actions with a test, check, or observable signal that would fail if the condition returned. A closed ticket is not a verification.",
    format: "percent",
  },
  {
    id: "factorCoverage",
    label: "Contributing factors covered",
    min: 0,
    max: 100,
    step: 5,
    value: 70,
    unit: "%",
    group: "Coverage",
    help: "Share of the contributing factors identified in the review that have at least one action against them.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  systemic: number;
  verification: number;
  coverage: number;
  quality: number;
  qualityGap: number;
  recurrence: number;
  vigilance: number;
  unverified: number;
  uncovered: number;
}

function compute(p: Params): Values {
  const systemic = clamp(num(p, "systemicShare", 80), 0, 100);
  const verification = clamp(num(p, "verificationStrength", 75), 0, 100);
  const coverage = clamp(num(p, "factorCoverage", 70), 0, 100);
  const quality = systemic * 0.45 + verification * 0.35 + coverage * 0.2;
  return {
    systemic,
    verification,
    coverage,
    quality,
    qualityGap: clamp(100 - quality, 0, 100),
    recurrence: clamp(70 - quality * 0.65 + (100 - coverage) * 0.2, 0, 100),
    vigilance: clamp(Math.round((ACTION_COUNT * (100 - systemic)) / 100), 0, ACTION_COUNT),
    unverified: clamp(Math.round((ACTION_COUNT * (100 - verification)) / 100), 0, ACTION_COUNT),
    uncovered: clamp(Math.round((FACTOR_COUNT * (100 - coverage)) / 100), 0, FACTOR_COUNT),
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
        id: "factors",
        label: "Contributing factors",
        kind: "storage",
        health: healthOf(v.uncovered, 3, 5),
        utilization: clamp(0.25 + v.uncovered / 12),
        sublabel: `${FACTOR_COUNT - v.uncovered} of ${FACTOR_COUNT} covered`,
        detail: "The conditions the review found. An action that addresses only the visible trigger leaves the other conditions in place.",
        meta: { view: "flow" },
      },
      {
        id: "draft",
        label: "Action drafts",
        kind: "service",
        health: healthOf(v.qualityGap, 30, 50),
        utilization: clamp(0.3 + v.vigilance / 10),
        sublabel: `${v.vigilance} vigilance-only action(s)`,
        detail: "A draft that says be more careful, add a warning, or retrain the team. It names a desired behavior without changing the condition that produced the old one.",
        meta: { view: "flow" },
      },
      {
        id: "change",
        label: "System change",
        kind: "worker",
        health: healthOf(100 - v.systemic, 25, 45),
        utilization: clamp(0.3 + (100 - v.systemic) / 120),
        sublabel: v.systemic >= 70 ? "condition changed" : "behavior requested",
        detail: "A default, guardrail, validation, capacity limit, or removal of a manual step. The change should make the old action impossible or less likely, not merely discouraged.",
        meta: { view: "flow" },
      },
      {
        id: "verification",
        label: "Verification",
        kind: "worker",
        health: healthOf(v.unverified, 3, 5),
        utilization: clamp(0.25 + v.unverified / 12),
        sublabel: `${v.unverified} unverified action(s)`,
        detail: "A test, check, or observable signal that fails if the condition returns. Verification is what distinguishes a shipped action from a completed ticket.",
        meta: { view: "flow" },
      },
      {
        id: "owner",
        label: "Owner and date",
        kind: "service",
        health: "ok",
        utilization: 0.4,
        sublabel: "tracked separately",
        detail: "Ownership and scheduling are necessary but not sufficient. An action can have an owner, ship on time, and still change nothing about the failure condition.",
        meta: { view: "flow" },
      },
      {
        id: "recurrence",
        label: "Recurrence risk",
        kind: "service",
        health: healthOf(v.recurrence, 35, 55),
        utilization: clamp(v.recurrence / 100),
        sublabel: v.recurrence >= 55 ? "same condition remains" : "condition reduced",
        detail: "The probability that the same contributing factors produce a similar incident. It falls when actions change conditions and are verified, not when the list is long.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("factors-draft", "factors", "draft", v.coverage / 100, healthOf(v.uncovered, 3, 5)),
      edge("draft-change", "draft", "change", v.systemic / 100, healthOf(100 - v.systemic, 25, 45)),
      edge("change-verification", "change", "verification", v.verification / 100, healthOf(v.unverified, 3, 5)),
      edge("verification-owner", "verification", "owner", 0.8, "ok"),
      edge("owner-recurrence", "owner", "recurrence", 1 - v.recurrence / 120, healthOf(v.recurrence, 35, 55)),
    ],
    metrics: [
      metric("recurrence-risk", "Recurrence risk", v.recurrence, "%", 35, 55, "percent"),
      metric("quality-gap", "Action quality gap", v.qualityGap, "%", 30, 50, "percent"),
      metric("vigilance-actions", "Vigilance-only actions", v.vigilance, "", 2, 4, "count"),
      metric("unverified-actions", "Unverified actions", v.unverified, "", 3, 5, "count"),
      metric("uncovered-factors", "Uncovered factors", v.uncovered, "", 3, 5, "count"),
    ],
    events: [
      {
        id: "pa-review-closed",
        at: 0,
        severity: "info",
        title: "Postmortem actions drafted",
        detail: `${ACTION_COUNT} actions cover ${FACTOR_COUNT - v.uncovered} of ${FACTOR_COUNT} contributing factors. ${v.vigilance} ask for vigilance and ${v.unverified} have no verification.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Recurrence risk ${v.recurrence.toFixed(0)}%; ${v.vigilance} vigilance-only action(s); ${v.unverified} unverified; ${v.uncovered} factor(s) uncovered.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 8;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.975 + 0.05 * Math.sin((index + phase) / 3.5))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "recurrence-risk",
    metricId: "recurrence-risk",
    warn: 35,
    crit: 55,
    title: "The actions leave the failure condition in place",
    cause:
      "The action list targets the visible trigger or asks people to behave differently. The conditions that produced the incident remain, so the same failure returns with a different person and a similar story.",
    fix:
      "Map each contributing factor to a change in a default, guardrail, validation, capacity limit, or process. Remove or rewrite actions that depend only on vigilance, and verify the change against the original failure scenario.",
    checkFirst: [
      "Find the actions that say be careful, add a warning, or retrain.",
      "Check which contributing factor has no action against it.",
      "Ask what would prevent the same action with a different responder.",
    ],
  },
  {
    id: "unverified-actions",
    metricId: "unverified-actions",
    warn: 3,
    crit: 5,
    title: "Actions are shipping without proof they work",
    cause:
      "The action is tracked as a ticket and closed when the change merges. Nothing tests whether the failure condition is actually gone, so the organization learns that activity equals prevention.",
    fix:
      "Add a test, check, or observable signal that fails if the condition returns. For process changes, run the scenario that produced the incident and confirm the new path blocks it.",
    checkFirst: [
      "Check whether each action has a verification that would fail on regression.",
      "Check whether the verification ran against the original scenario.",
      "Check whether closed actions are being counted as prevention.",
    ],
  },
  {
    id: "quality-gap",
    metricId: "quality-gap",
    warn: 30,
    crit: 50,
    title: "The action set does not match the contributing factors",
    cause:
      "Action quality is low across systemic change, verification, or factor coverage. The list may be long, but it does not address the conditions the review identified.",
    fix:
      "Rewrite the set around the contributing factors: one system change per factor, one verification per change, and a stated reason for any factor left uncovered.",
    checkFirst: [
      "Compare the factor list with the action list.",
      "Check whether one action is being counted against several factors.",
      "Check whether the highest-impact factor has the strongest action.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const postmortemActionModel: SimModel = {
  id: "reliability-postmortem-actions",
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
    if (v.qualityGap >= 50 && frame.flags.actionGap !== 1) {
      pushEvent(next, {
        id: "pa-quality-gap",
        at: frame.t,
        severity: "crit",
        title: "Action set does not address the failure conditions",
        detail: "The review found contributing factors that no system change covers. Completing these actions will not change the probability of recurrence.",
        nodeId: "recurrence",
        metricId: "quality-gap",
      });
      next.flags.actionGap = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    return [
      `Recurrence risk is ${v.recurrence.toFixed(0)}% with a quality gap of ${v.qualityGap.toFixed(0)}%.`,
      `${v.vigilance} of ${ACTION_COUNT} actions ask for vigilance. ${v.unverified} have no verification that would fail on regression.`,
      `${v.uncovered} of ${FACTOR_COUNT} contributing factors have no action. Coverage matters more than the number of actions.`,
      "An action that ships is not the same as an action that works. Verification is the difference.",
    ];
  },
  legend: [
    { label: "Condition changed", tone: "ok" },
    { label: "Thin verification", tone: "warn" },
    { label: "Vigilance only", tone: "crit" },
    { label: "Condition remains", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Most actions change a system, most have verification, and most contributing factors are covered.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Activity without coverage",
    description: "Actions are systemic enough, but verification is thin and several factors have no owner.",
    tone: "warn",
    params: defaults({ systemicShare: 60, verificationStrength: 55, factorCoverage: 55 }),
  },
  {
    id: "failure",
    label: "Be more careful",
    description: "The list asks for vigilance, ships without verification, and leaves most contributing factors untouched.",
    tone: "crit",
    params: defaults({ systemicShare: 20, verificationStrength: 15, factorCoverage: 25 }),
    elapsed: 8,
  },
  {
    id: "recovery",
    label: "Verified system change",
    description: "Every action changes a condition, has a verification, and maps to a contributing factor.",
    tone: "ok",
    params: defaults({ systemicShare: 100, verificationStrength: 100, factorCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-action-that-prevents",
  title: "Predict which action prevents recurrence",
  simId: "postmortem-actions",
  question:
    "A malformed feature flag took down checkout because the deploy accepted an invalid value. Which action best prevents recurrence?",
  prediction: {
    options: [
      {
        id: "validation",
        label: "Reject the invalid flag value at deploy time and add a test that reproduces the incident",
      },
      { id: "training", label: "Retrain the team on the flag format and remind them to double-check" },
      { id: "review", label: "Require a second reviewer to be more careful before every flag change" },
      { id: "runbook", label: "Add a runbook step to inspect the flag after the deploy" },
    ],
    correctOptionId: "validation",
    explanation:
      "The failure condition is that the deploy path accepts an invalid value. A validation changes that condition and a test verifies it. Training, reminders, and a second reviewer ask for vigilance under the same conditions; they may reduce the frequency slightly but do not prevent the failure. A runbook step detects the problem after it reaches production, which is later and less reliable than rejecting it.",
  },
  setup: defaults({ systemicShare: 35, verificationStrength: 30, factorCoverage: 40 }),
  runFor: 40,
  observe: [
    "Recurrence risk is critical before the action list is closed.",
    "Most actions ask for behavior change rather than a system change.",
    "Verification is missing, so shipping and closing look like prevention.",
    "Contributing factors remain uncovered, so the next trigger finds the same conditions.",
  ],
  explain:
    "Action quality is a property of the action, not of the meeting or the tracker. A good action changes the condition that made the failure possible, has a verification that fails if the condition returns, and maps to a contributing factor. Ownership and dates make it happen; they do not make it effective.",
  fix: defaults({ systemicShare: 100, verificationStrength: 100, factorCoverage: 100 }),
  debrief:
    "The validation action changes the deploy path and the test proves the invalid value is rejected. The tradeoff is implementation effort and a possible migration for existing flags. That cost is bounded and visible. Retraining costs less up front and leaves the failure condition exactly where it was.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A postmortem action is a change intended to reduce the probability or impact of recurrence. Its quality depends on three things: whether it changes a system condition, whether it has a verification that would fail if the condition returned, and whether it addresses the contributing factors the review identified.",
  },
  {
    type: "p",
    text: "An action can have an owner, a due date, and a completed ticket and still be ineffective. \"Be more careful\" names a desired behavior but not a condition. \"Add a warning\" adds a signal without changing the default. \"Retrain the team\" assumes the failure came from missing knowledge rather than from a system that made the wrong action easy. These actions feel like progress because they are concrete and finishable.",
  },
  {
    type: "p",
    text: "Verification is the dividing line between activity and prevention. A system change without a test can regress silently. A process change without a scenario test can be bypassed on the first busy day. The verification should fail when the condition returns, which means it has to exercise the condition, not just check that a ticket was closed.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Action items cover ownership, due dates, prioritization, and completion. This module covers the content of the action itself. The blameless postmortem supplies contributing factors; this module turns them into changes and checks. Incident review is where the action set is challenged before it is accepted.",
  },
  {
    type: "table",
    headers: ["Action", "Condition changed", "Verification"],
    rows: [
      ["Reject invalid flag values at deploy", "Deploy validation", "Test with the malformed value"],
      ["Set a connection-pool limit below the database cap", "Capacity default", "Load test that approaches the cap"],
      ["Remove the manual DNS step from failover", "Runbook and automation", "Failover drill with the step omitted"],
      ["Retrain the team on the flag format", "None", "None"],
    ],
  },
  {
    type: "p",
    text: "This module models six actions against eight contributing factors. Systemic share, verification strength, and factor coverage are illustrative teaching values, not a scoring standard.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Recurrence risk: the chance the same conditions produce another incident.",
      "Action quality gap: distance from a set that changes conditions and verifies them.",
      "Vigilance-only actions: items that ask people to behave differently.",
      "Unverified actions: changes with no check that would catch a regression.",
      "Uncovered factors: contributing conditions with no action against them.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Be more careful. Watch recurrence risk and the quality gap. Run the experiment before reading the debrief, then rewrite the vigilance actions as system changes with verification and watch the gap close.",
  },
  {
    type: "compare",
    leftTitle: "Activity",
    rightTitle: "Prevention",
    rows: [
      { label: "Content", left: "Be careful, retrain, add a warning", right: "Change a default, guardrail, or limit" },
      { label: "Verification", left: "Ticket closed", right: "Test fails if the condition returns" },
      { label: "Coverage", left: "Addresses the visible trigger", right: "Maps to contributing factors" },
      { label: "Recurrence", left: "Same condition, different person", right: "Condition removed or bounded" },
    ],
  },
  { type: "sim", simId: "postmortem-actions" },
  { type: "experiment", experimentId: "predict-action-that-prevents" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The review found a malformed flag, a deploy path that accepted it, and a rollback that took too long. The action list asked the team to double-check flags, retrain on the format, and add a second reviewer. Every item had an owner and a date. The deploy path still accepted the same value, and the next malformed flag produced the same outage.",
  },
  {
    type: "p",
    text: "The recovery set changed the deploy validation, added a test with the malformed value, and removed the manual flag check from the runbook. Recurrence risk fell because the condition changed. The actions were harder to write and took longer to ship, but they were verifiable.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Action tracker: a long list of training, reminders, and review steps, all marked complete.",
      "Deploy pipeline: the same invalid value still accepted.",
      "Postmortem: the same contributing factor appears in the next review with a different trigger.",
      "Verification: no test or check references the original failure scenario.",
      "Review: the team debates whether people followed the process instead of whether the process can fail safely.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find every action that depends on a person being more careful. Ask what system change would make the old action impossible, and what check would fail if the condition returned. If neither exists, the action is a wish with a ticket.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Map each contributing factor to at least one action or a written reason for no action.",
      "Rewrite vigilance actions as changes to defaults, guardrails, validation, capacity, or process.",
      "Give every action a verification that exercises the original failure scenario.",
      "Remove actions that only add a warning without changing the decision or the default.",
      "Prioritize the factors with the largest contribution to impact, not the easiest action.",
      "Re-run the verification before closing the action and again after the next related change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "System changes take longer than reminders. The delay is visible; recurrence is not attributed to the missing action.",
      "Verification adds engineering work. A test that exercises the real condition is usually cheaper than the next incident.",
      "Not every factor can be eliminated. Bound the risk with a limit, a fallback, or a detection, and state the residual risk.",
      "A long action list feels thorough. A short list that covers the factors and verifies each change is more likely to prevent recurrence.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "vigilance-action",
    question: "Why is \"be more careful\" a poor action, and what would you replace it with?",
    difficulty: 1,
    hints: [
      "It does not change the condition that made the action easy.",
      "Look for a default, guardrail, or validation.",
    ],
    answer:
      "It asks for a behavior without changing the conditions that produced the old behavior. The responder was already trying to be careful; the system still made the wrong action available. I would replace it with a change that makes the failure harder or impossible: reject the invalid value at deploy time, remove the manual step, set a safer default, or add a limit. Then I would add a verification that reproduces the original scenario.",
    followUps: [
      "When is a reminder still appropriate?",
      "How do you handle a factor that is genuinely about judgment?",
      "What if the system change is too expensive?",
    ],
    redFlags: [
      "Says training is always useless.",
      "Accepts the reminder because it is cheap.",
      "Writes a policy instead of a control.",
    ],
    rubric: [
      "Explains the missing condition change.",
      "Proposes a concrete control.",
      "Adds verification.",
      "Acknowledges judgment cases.",
    ],
  },
  {
    id: "verification",
    question: "What makes a verification strong enough to close an action?",
    difficulty: 2,
    hints: [
      "It must fail when the condition returns.",
      "It must exercise the original scenario, not the ticket.",
    ],
    answer:
      "A strong verification exercises the condition that caused the incident and fails if the condition returns. For a validation, that is a test with the malformed input. For a capacity change, it is a load test that approaches the new limit. For a process change, it is a drill that runs the scenario and confirms the new path blocks the failure. A merged change or a closed ticket is not verification because neither observes the condition.",
    followUps: [
      "How do you verify a process change?",
      "What if the original scenario cannot be reproduced?",
      "Who should own the verification?",
    ],
    redFlags: [
      "Counts a merged change as verification.",
      "Uses a checklist item.",
      "Tests only the happy path.",
    ],
    rubric: [
      "Requires the condition to return.",
      "Exercises the original scenario.",
      "Applies to process changes.",
      "Names an owner.",
    ],
  },
  {
    id: "coverage",
    question:
      "The action list has twenty items and the next incident has the same contributing factors. What went wrong?",
    difficulty: 3,
    hints: [
      "Count is not coverage.",
      "Check whether the actions changed conditions.",
    ],
    answer:
      "The list optimized for activity rather than coverage. Twenty items can still miss the factor that mattered, duplicate the same fix, or ask for vigilance without changing a condition. I would map each contributing factor to an action and a verification, remove duplicates, and check whether the highest-impact factors have systemic changes. The finding is about the action set, not the number of items.",
    followUps: [
      "How do you stop a review from producing twenty items?",
      "Which factors get priority?",
      "What if the team cannot fix the top factor?",
    ],
    redFlags: [
      "Adds more actions.",
      "Blames execution.",
      "Measures completion instead of recurrence.",
    ],
    rubric: [
      "Separates count from coverage.",
      "Maps factors to actions.",
      "Checks systemic content.",
      "Prioritizes impact.",
    ],
  },
];

const checklist = [
  {
    title: "Draft",
    items: [
      "Map every contributing factor to at least one action or a written reason for no action.",
      "Rewrite vigilance requests as changes to defaults, validation, limits, or process.",
      "Remove actions that add a warning without changing a decision.",
      "Prioritize the factors with the largest impact, not the easiest fix.",
    ],
  },
  {
    title: "Verify",
    items: [
      "Give every action a test, check, or observable signal that fails on regression.",
      "Exercise the original failure scenario, not only the happy path.",
      "State the residual risk for factors that cannot be eliminated.",
      "Check that the verification runs before the action is closed.",
    ],
  },
  {
    title: "Review",
    items: [
      "Read the action set against the factor list, not the ticket count.",
      "Check whether actions are being counted against more than one factor.",
      "Revisit the actions when a similar incident occurs.",
      "Report recurrence and verification results, not only completion.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture: How You Can Learn from Failure",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Action quality, review practices, and turning findings into prevention.",
  },
  {
    title: "Postmortem Culture: Learning from Failure",
    url: "https://sre.google/sre-book/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Blameless analysis and the conditions for useful action items.",
  },
  {
    title: "Incident Postmortems",
    url: "https://www.atlassian.com/incident-management/postmortem",
    publisher: "Atlassian",
    kind: "docs" as const,
    note: "Postmortem structure, action tracking, and review practices.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "postmortem-actions": {
      model: postmortemActionModel,
      presets,
      instructions:
        "Start Healthy, then apply Be more careful. Watch recurrence risk and the quality gap. Run the experiment, then rewrite the vigilance actions as system changes with verification.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Action counts and quality weights are teaching assumptions, not a scoring rubric.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-action-items",
    "reliability-blameless-postmortems",
    "reliability-incident-review",
    "reliability-toil",
  ],
};
