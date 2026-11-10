import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CANDIDATE_CAUSES = 6;

const params = [
  {
    id: "branches",
    label: "Candidate branches",
    min: 1,
    max: 6,
    step: 1,
    value: 4,
    unit: "",
    group: "Framework",
    help: "Plausible cause families the playbook names before the team commits. Fewer branches leave blind spots.",
    format: "count" as const,
  },
  {
    id: "contextQuestions",
    label: "Context questions per branch",
    min: 0,
    max: 8,
    step: 1,
    value: 5,
    unit: "",
    group: "Framework",
    help: "Checks that separate a hypothesis from a guess: scope, timing, recent change, dependency state, and blast radius.",
    format: "count" as const,
  },
  {
    id: "timeboxMinutes",
    label: "Reassessment interval",
    min: 2,
    max: 30,
    step: 1,
    value: 10,
    unit: " min",
    group: "Execution",
    help: "How long the team tests one branch before comparing it with the others. Long intervals hide a wrong branch.",
    format: "number" as const,
  },
  {
    id: "rigidity",
    label: "Script rigidity",
    min: 0,
    max: 100,
    step: 5,
    value: 20,
    unit: "%",
    group: "Execution",
    help: "How literally the team follows the written order. High rigidity turns a framework into a script that ignores new context.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  branches: number;
  contextQuestions: number;
  timebox: number;
  rigidity: number;
  blindSpots: number;
  contextGap: number;
  falseConvergence: number;
  timeToMitigate: number;
  cycle: number;
  progress: number;
}

function compute(p: Params, t: number): Values {
  const branches = clamp(Math.round(num(p, "branches", 4)), 1, 6);
  const contextQuestions = clamp(Math.round(num(p, "contextQuestions", 5)), 0, 8);
  const timebox = clamp(Math.round(num(p, "timeboxMinutes", 10)), 2, 30);
  const rigidity = clamp(num(p, "rigidity", 20), 0, 100);
  const blindSpots = Math.max(0, CANDIDATE_CAUSES - branches);
  const contextCoverage = clamp((contextQuestions / 8) * 100 - rigidity * 0.15, 0, 100);
  const contextGap = clamp(100 - contextCoverage, 0, 100);
  const cycle = clamp(timebox * 0.6 + 2, 3, 20);
  const cycles = Math.floor(Math.max(0, t) / cycle);
  const falseConvergence = contextGap > 45 && rigidity > 50 ? cycles : 0;
  const timeToMitigate = clamp(
    12 + blindSpots * 3.5 + contextGap * 0.22 + falseConvergence * 7 - (100 - rigidity) * 0.02,
    0,
    180,
  );
  return {
    branches,
    contextQuestions,
    timebox,
    rigidity,
    blindSpots,
    contextGap,
    falseConvergence,
    timeToMitigate,
    cycle,
    progress: clamp((Math.max(0, t) / 40) * 100, 0, 100),
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  const incidentHealth = healthOf(v.timeToMitigate, 30, 50);
  const branchHealth = v.falseConvergence >= 2 ? "crit" : v.falseConvergence >= 1 ? "warn" : "ok";
  const contextHealth = healthOf(v.contextGap, 45, 75);
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "incident",
        label: "Unknown-cause incident",
        kind: "client",
        health: incidentHealth,
        utilization: clamp(0.3 + v.timeToMitigate / 120),
        sublabel: `${Math.round(v.timeToMitigate)} min projected`,
        detail: "The alert is real, the cause is not identified, and no runbook matches the symptom. The playbook supplies the decision order.",
        meta: { view: "flow" },
      },
      {
        id: "playbook",
        label: "Playbook",
        kind: "storage",
        health: v.rigidity >= 45 ? "warn" : "ok",
        utilization: clamp(0.25 + v.rigidity / 120),
        sublabel: v.rigidity >= 50 ? "used as a script" : "decision framework",
        detail: "A playbook names decisions and evidence, not a fixed sequence of commands. Rigidity is how much the team treats it as a script.",
        meta: { view: "flow" },
      },
      {
        id: "branch",
        label: "Branch test",
        kind: "service",
        health: branchHealth,
        utilization: clamp(0.3 + v.falseConvergence * 0.2),
        sublabel: v.falseConvergence >= 1 ? `${v.falseConvergence} false convergence` : "evidence first",
        detail: "Each branch is a candidate cause family. A branch closes on evidence, not on the first explanation that sounds plausible.",
        meta: { view: "flow" },
      },
      {
        id: "context",
        label: "Context checks",
        kind: "service",
        health: contextHealth,
        utilization: clamp(0.25 + v.contextGap / 130),
        sublabel: `${Math.round(v.contextGap)}% gap`,
        detail: "Scope, timing, recent change, dependency state, blast radius, and what has already been ruled out.",
        meta: { view: "flow" },
      },
      {
        id: "reassess",
        label: "Reassessment",
        kind: "worker",
        health: v.timebox > 24 ? "crit" : v.timebox > 16 ? "warn" : "ok",
        utilization: clamp(0.3 + v.timebox / 80),
        sublabel: `${v.timebox} min interval`,
        detail: "A timebox forces the team to compare the current branch with the others. Without it, the first plausible branch consumes the incident.",
        meta: { view: "flow" },
      },
      {
        id: "mitigate",
        label: "Mitigation",
        kind: "worker",
        health: incidentHealth,
        utilization: clamp(0.3 + v.timeToMitigate / 140),
        sublabel: v.timeToMitigate >= 50 ? "target at risk" : "within target",
        detail: "Mitigation can start before the root cause is known. Stabilize the customer impact, then keep learning.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("incident-playbook", "incident", "playbook", 0.9, "ok"),
      edge("playbook-branch", "playbook", "branch", 1 - v.rigidity / 160, branchHealth),
      edge("branch-context", "branch", "context", 1 - v.contextGap / 130, contextHealth),
      edge("context-reassess", "context", "reassess", 0.8, "ok"),
      edge("reassess-mitigate", "reassess", "mitigate", 1 - v.timeToMitigate / 200, incidentHealth),
    ],
    metrics: [
      metric("blind-spots", "Uncovered cause families", v.blindSpots, "", 3, 5, "count"),
      metric("context-gap", "Context gap", v.contextGap, "%", 45, 75, "percent"),
      metric("false-convergence", "False convergences", v.falseConvergence, "", 1, 2, "count"),
      metric("time-to-mitigate", "Projected time to mitigate", v.timeToMitigate, " min", 30, 50, "number"),
      metric("framework-progress", "Framework progress", v.progress, "%", undefined, undefined, "percent"),
    ],
    events: [
      {
        id: "pb-incident-declared",
        at: 0,
        severity: "info",
        title: "Unknown-cause incident declared",
        detail: `The symptom does not match a runbook. The playbook names ${v.branches} cause family(ies) and asks ${v.contextQuestions} context questions per branch.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(v.timeToMitigate)} min projected; ${v.blindSpots} uncovered cause family(s); ${v.falseConvergence} false convergence(s).`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 5;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.035 * Math.sin((index + phase) / 2.9))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "time-to-mitigate",
    metricId: "time-to-mitigate",
    warn: 30,
    crit: 50,
    title: "Projected mitigation has moved beyond the incident target",
    cause:
      "The team is testing too few branches, asking too little context, or staying on one branch past its timebox. The playbook is being executed as a script instead of used as a decision framework.",
    fix:
      "Reopen the candidate list, name the evidence that would separate the top two branches, and run the cheapest discriminating test. Set a new reassessment time and stop defending the first explanation.",
    checkFirst: [
      "List the candidate cause families and which one is currently being tested.",
      "Check whether the last branch was closed on evidence or on plausibility.",
      "Check whether new context arrived after the branch was chosen.",
    ],
  },
  {
    id: "false-convergence",
    metricId: "false-convergence",
    warn: 1,
    crit: 2,
    title: "The team is converging on a branch without context",
    cause:
      "A rigid playbook treats its first plausible branch as the answer. Each reassessment repeats the same framing instead of comparing alternatives, so the team converges again on the same weak hypothesis.",
    fix:
      "Force a comparison at the next reassessment: write the strongest evidence for and against the current branch, then test one alternative with a discriminating signal.",
    checkFirst: [
      "Which branch has been tested, and what signal would disprove it?",
      "Which alternative branch has not been tested at all?",
      "Did the reassessment add new context or only restate the plan?",
    ],
  },
  {
    id: "context-gap",
    metricId: "context-gap",
    warn: 45,
    crit: 75,
    title: "The playbook lacks the context to discriminate",
    cause:
      "The framework asks too few questions about scope, timing, recent change, and dependencies. Without that context, every branch looks plausible and the team picks by familiarity.",
    fix:
      "Add the missing context questions to the playbook and ask them before choosing a branch. Keep the list short enough to run under pressure.",
    checkFirst: [
      "What changed shortly before the symptom started?",
      "What is the blast radius, and is it growing?",
      "Which dependency is shared by the affected requests?",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const playbookModel: SimModel = {
  id: "reliability-playbooks",
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
    if (v.falseConvergence >= 1 && frame.flags.pbFalse !== 1) {
      pushEvent(next, {
        id: "pb-false-convergence",
        at: frame.t,
        severity: "warn",
        title: "First branch closed without discriminating evidence",
        detail: `The team spent ${v.cycle.toFixed(0)} simulated minutes on one branch and reassessed with ${Math.round(v.contextGap)}% of the context missing.`,
        nodeId: "branch",
        metricId: "false-convergence",
      });
      next.flags.pbFalse = 1;
    }
    if (v.falseConvergence >= 2 && frame.flags.pbFalseSecond !== 1) {
      pushEvent(next, {
        id: "pb-false-convergence-second",
        at: frame.t,
        severity: "crit",
        title: "A second reassessment converged on the same weak branch",
        detail: "The playbook is being read as a script. Reassessment repeated the plan instead of comparing alternatives, and the unknown cause remains unidentified.",
        nodeId: "reassess",
        metricId: "time-to-mitigate",
      });
      next.flags.pbFalseSecond = 1;
    }
    if (v.contextGap < 20 && v.blindSpots === 0 && frame.flags.pbCovered !== 1) {
      pushEvent(next, {
        id: "pb-covered",
        at: frame.t,
        severity: "info",
        title: "Playbook covers the candidate space",
        detail: "Every cause family has a branch, and each branch has enough context questions to discriminate. The next step is evidence, not more planning.",
        nodeId: "playbook",
      });
      next.flags.pbCovered = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `${v.blindSpots} of ${CANDIDATE_CAUSES} cause families have no branch. An unlisted cause is not ruled out; it is invisible.`,
      `Context gap is ${Math.round(v.contextGap)}%. High rigidity reduces the value of whatever context the playbook asks for.`,
      `${v.falseConvergence} branch reassessment(s) closed without distinguishing evidence. Each one costs about ${v.cycle.toFixed(0)} simulated minutes.`,
      `Projected mitigation is ${v.timeToMitigate.toFixed(0)} minutes. A playbook is working when the next test is chosen for its discriminating power, not its familiarity.`,
    ];
  },
  legend: [
    { label: "Framework in use", tone: "ok" },
    { label: "Context thin", tone: "warn" },
    { label: "Script mode", tone: "crit" },
    { label: "No guidance", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Four cause families, five context questions, and a short reassessment interval.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A busy novel incident with a narrower branch list but the framework still holds.",
    tone: "warn",
    params: defaults({ branches: 3, contextQuestions: 5, timeboxMinutes: 12, rigidity: 35 }),
    elapsed: 30,
  },
  {
    id: "failure",
    label: "Script mode",
    description: "Two branches, three context questions, a long timebox, and a rigid reading of the playbook.",
    tone: "crit",
    params: defaults({ branches: 2, contextQuestions: 3, timeboxMinutes: 20, rigidity: 80 }),
    elapsed: 30,
  },
  {
    id: "recovery",
    label: "Framework restored",
    description: "All six cause families, full context, a short timebox, and low rigidity.",
    tone: "ok",
    params: defaults({ branches: 6, contextQuestions: 8, timeboxMinutes: 6, rigidity: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-guidance",
  title: "Choose the right guidance for an unknown cause",
  simId: "playbooks",
  question:
    "A novel incident has no matching runbook and the cause is still unknown. Which guidance gives the team the best chance of mitigating it?",
  prediction: {
    options: [
      { id: "framework", label: "Use the playbook to bound scope, list causes, and test a discriminating signal" },
      { id: "closest", label: "Apply the closest runbook and adapt it as you go" },
      { id: "wait", label: "Wait for monitoring to identify the cause before acting" },
      { id: "escalate", label: "Escalate without collecting evidence so the next team starts fresh" },
    ],
    correctOptionId: "framework",
    explanation:
      "A runbook encodes one known failure and its assumptions. Applying it to a novel incident imports assumptions that may not hold. Waiting delays mitigation, and escalating without evidence transfers the same uncertainty. The playbook provides an order for reducing uncertainty and stabilizing impact in parallel.",
  },
  setup: defaults({ branches: 2, contextQuestions: 3, timeboxMinutes: 20, rigidity: 80 }),
  runFor: 40,
  observe: [
    "The context gap is visible before the first branch closes.",
    "The first false convergence occurs after one long reassessment interval.",
    "A second false convergence crosses the critical threshold while the cause remains unknown.",
    "Projected mitigation grows with each reassessment that repeats the same framing.",
  ],
  explain:
    "The playbook does not know the cause. It knows what to do when the cause is unknown: stabilize the impact, bound the scope, enumerate plausible cause families, and run the cheapest test that separates them. Rigidity defeats that purpose because it turns the framework into a script, and a script cannot respond to context it was not written for.",
  fix: defaults({ branches: 6, contextQuestions: 8, timeboxMinutes: 6, rigidity: 5 }),
  debrief:
    "With all six branches and the full context list, the team still spends time investigating, but every interval produces a discriminating result. The cost is more explicit questions and more frequent reassessment. That cost is lower than repeating a weak hypothesis until the incident target is gone.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A playbook is a decision framework for an incident whose cause is not yet known. It does not list the commands for one alert. It lists the order in which the team reduces uncertainty and protects the customer: stabilize, bound the scope, enumerate plausible cause families, choose the cheapest discriminating test, reassess on a timebox, and escalate when the evidence or the authority is missing.",
  },
  {
    type: "p",
    text: "A runbook is the opposite trade. It encodes one known failure mode in enough detail that a responder can execute it without rediscovering the system. It is fast because it is narrow. A playbook is slower and broader because it must work when the narrow answer does not exist.",
  },
  {
    type: "p",
    text: "The failure mode of a playbook is not that it is wrong. It is that it gets treated as a script. A rigid reading follows the written order after the context has changed, closes the first plausible branch, and calls the reassessment a formality. The document is still being followed; the thinking is not.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Alerting and observability produce the symptom. Incident command assigns ownership and communication. The playbook sits between command and the runbook: command decides the priority, the playbook decides how to investigate, and a runbook may be invoked once the cause narrows to a known failure.",
  },
  {
    type: "table",
    headers: ["Question", "Runbook", "Playbook"],
    rows: [
      ["What is known?", "One alert and one failure mode", "A symptom with an unknown cause"],
      ["What does it contain?", "Ordered checks, actions, verification", "Decisions, cause families, discriminating tests"],
      ["What is the risk?", "A stale assumption is executed", "The first plausible branch becomes the answer"],
      ["When does it end?", "Recovery is verified", "The cause is understood or the impact is stabilized"],
      ["How is it maintained?", "Rehearsed against the current topology", "Updated with new cause families and better tests"],
    ],
  },
  {
    type: "p",
    text: "This module models a novel checkout incident with six plausible cause families. One simulated second represents one incident minute. The branch count, context gap, and timeboxes are illustrative teaching values, not a standard or a vendor claim.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Uncovered cause families: plausible causes the playbook never asks about.",
      "Context gap: how much scope, timing, change, and dependency evidence is missing.",
      "False convergences: reassessments that close a branch without discriminating evidence.",
      "Projected time to mitigate: the cost of testing the wrong branch for another interval.",
      "A flow view of incident, playbook, branch test, context, reassessment, and mitigation.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Script mode. Watch the context gap before the first false convergence, and the timebox before the projected mitigation. Run the experiment before reading the debrief, then add one branch and one context question at a time.",
  },
  {
    type: "compare",
    leftTitle: "Script reading",
    rightTitle: "Framework reading",
    rows: [
      { label: "First move", left: "Find the matching step and run it", right: "Stabilize impact and bound scope" },
      { label: "Hypothesis", left: "The first plausible cause is the cause", right: "List several and test the discriminator" },
      { label: "Reassessment", left: "Repeat the plan at the next interval", right: "Compare evidence across branches" },
      { label: "New context", left: "Treat it as noise or a distraction", right: "Use it to revise the branch list" },
    ],
  },
  { type: "sim", simId: "playbooks" },
  { type: "experiment", experimentId: "predict-guidance" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The incident did not match a runbook, so the team opened the playbook. The playbook named two cause families and asked three context questions. The first branch was plausible, the timebox was long, and the reassessment repeated the same framing instead of comparing alternatives. The first false convergence was a warning. The second was the cost of treating a framework as a script.",
  },
  {
    type: "p",
    text: "Adding branches did not slow the team down in the way the model first suggests. It reduced the chance that the real cause was invisible. Adding context questions made each branch cheaper to close because the discriminating evidence was already being collected. Shortening the timebox forced a comparison before the first branch consumed the incident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Incident channel: one hypothesis repeated with more confidence but no new evidence, while alternative causes are mentioned once and dropped.",
      "Dashboards: the team is looking at one service or one metric because the playbook's first branch pointed there.",
      "Timeline: reassessment points pass without a written comparison of branches.",
      "Change log: a recent change is dismissed because the current branch predicts a different cause.",
      "Handoff: the next responder receives a plan but not the list of causes already ruled out.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask which cause families are on the list and which one is being tested. Then ask what evidence would disprove the current branch. If the team cannot name a discriminating signal, the playbook is being used as a script.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stabilize the customer impact before the root cause is known. Mitigation and diagnosis can run in parallel.",
      "Write the candidate cause families on one page and mark which are ruled out, being tested, or untouched.",
      "For the current branch, name the signal that would disprove it, then run the cheapest test that produces that signal.",
      "At each timebox, compare at least two branches and record why one is now stronger.",
      "Escalate when the team lacks the access, context, or authority to run the discriminating test.",
      "After the incident, add the new cause family and the test that found it to the playbook.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A broader playbook reduces blind spots but takes longer to read under pressure. Keep the branch list short and the tests concrete.",
      "A short timebox forces comparison but can interrupt a test that is about to produce evidence. Choose the interval from the cost of waiting, not from a default.",
      "A playbook that is too abstract becomes a philosophy document. It needs named signals and concrete tests to change a decision.",
      "Incident command can override the playbook when impact demands action. The override should be recorded, not silent.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-guidance",
    question: "How do you decide whether an incident needs a runbook or a playbook?",
    difficulty: 2,
    hints: [
      "Start from what is known, not from how important the incident is.",
      "A known alert with a known response is a runbook problem.",
    ],
    answer:
      "If the alert maps to a known failure mode and the team has a tested response, use the runbook. If the cause is unknown, the symptom is new, or the known response does not explain what is happening, use the playbook. Many incidents start with a playbook and switch to a runbook once the cause narrows. The distinction is about uncertainty, not severity. A severe incident with a known cause can still use a runbook, and a mild incident with an unknown cause still needs a framework.",
    followUps: [
      "When do you switch from playbook to runbook?",
      "Can a runbook exist for a rare failure?",
      "Who decides which guidance to use?",
    ],
    redFlags: [
      "Chooses by severity alone.",
      "Uses a runbook for every incident.",
      "Treats a playbook as a longer runbook.",
    ],
    rubric: [
      "Bases the choice on uncertainty.",
      "Allows a switch as the cause narrows.",
      "Keeps severity separate from guidance type.",
      "Names who decides.",
    ],
  },
  {
    id: "playbook-contents",
    question: "What makes a playbook useful when the cause is unknown?",
    difficulty: 3,
    hints: [
      "It must reduce uncertainty, not just list tasks.",
      "The next test should be chosen for its discriminating power.",
    ],
    answer:
      "It needs an order for stabilizing impact, bounding scope, enumerating plausible cause families, and choosing a test that separates them. Each branch should name the evidence that would support or disprove it, and the reassessment should force a comparison. It also needs escalation criteria for missing access or authority. A useful playbook changes the next question the team asks. A list of generic tasks does not.",
    followUps: [
      "How many cause families should it list?",
      "What is a discriminating test?",
      "How do you keep it short enough to use?",
    ],
    redFlags: [
      "Lists only generic steps.",
      "Has no reassessment point.",
      "Does not name evidence.",
    ],
    rubric: [
      "Includes stabilization and scope.",
      "Names cause families and discriminating tests.",
      "Forces reassessment.",
      "Includes escalation criteria.",
    ],
  },
  {
    id: "rigid-script",
    question:
      "The playbook says to check recent changes first. The cause turns out to be a dependency failure. What went wrong, and what do you change?",
    difficulty: 3,
    hints: [
      "A first branch is a starting point, not a conclusion.",
      "The reassessment must compare the current branch with alternatives.",
    ],
    answer:
      "The team treated the first branch as the answer instead of the first test. Checking recent changes is a reasonable opening move because it is cheap, but the playbook must force a comparison when that branch does not produce a signal. I would add a dependency branch with its own discriminating test, make the reassessment compare at least two branches, and record which causes have been ruled out. The fix is not to remove the recent-change branch; it is to stop it from consuming the whole investigation.",
    followUps: [
      "How do you decide the order of branches?",
      "What if the recent change is the cause but the signal is weak?",
      "How do you record ruled-out causes?",
    ],
    redFlags: [
      "Removes the recent-change check entirely.",
      "Adds more steps without changing the reassessment.",
      "Blames the responder for following the document.",
    ],
    rubric: [
      "Explains the first-branch trap.",
      "Adds a dependency branch and a test.",
      "Changes reassessment to compare branches.",
      "Records ruled-out causes.",
    ],
  },
  {
    id: "update-playbook",
    question: "How do you update a playbook after an incident that it did not handle well?",
    difficulty: 2,
    hints: [
      "Capture the cause family and the test that found it.",
      "Remove branches that produced no decision.",
    ],
    answer:
      "I add the cause family the incident revealed and the signal that discriminated it. I remove or merge branches that never changed a decision, because length has a cost under pressure. I check whether the reassessment interval was appropriate and whether the escalation criteria fired. Then I rehearse the revised playbook on a tabletop or a game day. The update should change the next investigation, not just record this one.",
    followUps: [
      "Who owns the playbook?",
      "How often should it be reviewed?",
      "How do you avoid adding a branch for every incident?",
    ],
    redFlags: [
      "Only adds text.",
      "Never removes a branch.",
      "Does not rehearse the change.",
    ],
    rubric: [
      "Adds the cause family and the test.",
      "Removes low-value branches.",
      "Reviews timebox and escalation.",
      "Rehearses the revision.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The playbook names the decision order: stabilize, scope, enumerate, test, reassess, escalate.",
      "Each cause family has a discriminating signal and a cheap test.",
      "The reassessment interval is written down and short enough to compare branches.",
      "Runbooks are linked but not reused as playbooks.",
      "The escalation criteria name missing access, missing authority, and missing evidence.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Write the candidate cause families and mark ruled out, testing, or untouched.",
      "Stabilize impact in parallel with diagnosis.",
      "Choose the next test for its discriminating power.",
      "At each timebox, compare at least two branches and record the result.",
      "Escalate when the team cannot run the next test.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the new cause family and the test that found it.",
      "Remove branches that did not change a decision.",
      "Review whether the timebox helped or interrupted useful work.",
      "Rehearse the revised playbook before the next incident.",
    ],
  },
];

const references = [
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident command, roles, and the difference between a known response and an unknown cause.",
  },
  {
    title: "During an Incident",
    url: "https://response.pagerduty.com/during/during_an_incident/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Operational practices for investigating and communicating during an active incident.",
  },
  {
    title: "What is a runbook?",
    url: "https://www.pagerduty.com/resources/learn/what-is-a-runbook/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Runbook structure and scope, useful as the contrast to a playbook.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    playbooks: {
      model: playbookModel,
      presets,
      instructions:
        "Start Healthy, then apply Script mode. Watch the context gap, then the false convergences, then projected mitigation. Add one branch and one context question at a time.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; branch counts and timeboxes are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-runbooks",
    "reliability-incident-command",
    "reliability-checklists",
    "reliability-blameless-postmortems",
  ],
};
