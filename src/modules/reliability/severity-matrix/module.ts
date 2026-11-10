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
    id: "axes",
    label: "Dimensions in the matrix",
    min: 2,
    max: 5,
    step: 1,
    value: 3,
    unit: "",
    group: "Design",
    help: "Number of independent criteria: user impact, scope, duration, data sensitivity, and contractual exposure. More axes cover more cases and take longer to apply.",
    format: "count",
  },
  {
    id: "responseLevels",
    label: "Response levels",
    min: 3,
    max: 5,
    step: 1,
    value: 4,
    unit: "",
    group: "Design",
    help: "Distinct response levels. Each added level needs a definition that responders can apply without comparing it to the others.",
    format: "count",
  },
  {
    id: "definitions",
    label: "Criteria with examples",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Wording",
    help: "Share of criteria that state a measurable threshold and include a worked example. Examples resolve ambiguity faster than longer prose.",
    format: "percent",
  },
  {
    id: "exceptions",
    label: "Named overrides",
    min: 0,
    max: 8,
    step: 1,
    value: 1,
    unit: "",
    group: "Design",
    help: "Special cases that bypass the matrix: a named customer, a regulated flow, or a leadership call. Each override is a path around the written criteria.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  axes: number;
  levels: number;
  definitions: number;
  exceptions: number;
  complexity: number;
  classifyDelay: number;
  disagreement: number;
  underClassification: number;
  responseDelay: number;
}

function compute(p: Params): Values {
  const axes = clamp(Math.round(num(p, "axes", 3)), 2, 5);
  const levels = clamp(Math.round(num(p, "responseLevels", 4)), 3, 5);
  const definitions = clamp(num(p, "definitions", 95), 0, 100);
  const exceptions = clamp(Math.round(num(p, "exceptions", 1)), 0, 8);
  const complexity = axes * levels * 0.55 + exceptions * 1.4;
  const classifyDelay = clamp(
    1 + complexity * 0.35 + (100 - definitions) * 0.03,
    0,
    60,
  );
  const disagreement = clamp(
    (axes - 2) * 6 + exceptions * 4 + (100 - definitions) * 0.45 + (levels - 3) * 2,
    0,
    100,
  );
  const underClassification = clamp(
    disagreement * 0.5 + (5 - axes) * 7 + (100 - definitions) * 0.25 - 10,
    0,
    100,
  );
  return {
    axes,
    levels,
    definitions,
    exceptions,
    complexity,
    classifyDelay,
    disagreement,
    underClassification,
    responseDelay: classifyDelay + underClassification * 0.5,
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
        id: "intake",
        label: "Incident intake",
        kind: "service",
        health: "ok",
        utilization: 0.3,
        sublabel: "impact still uncertain",
        detail: "The first credible report. The responder has partial impact, partial scope, and no confirmed cause. The matrix has to work with that.",
        meta: { view: "flow" },
      },
      {
        id: "matrix",
        label: "Severity matrix",
        kind: "storage",
        health: healthOf(v.classifyDelay, 8, 12),
        utilization: clamp(v.complexity / 30),
        sublabel: `${v.axes} axes, ${v.levels} levels`,
        detail: "The written criteria. It should map observable impact to a response level, not require a diagnosis of the cause.",
        meta: { view: "flow" },
      },
      {
        id: "triage",
        label: "Triage",
        kind: "worker",
        health: healthOf(v.disagreement, 20, 40),
        utilization: clamp(0.25 + v.disagreement / 120),
        sublabel: `${v.disagreement.toFixed(0)}% disagreement`,
        detail: "The people applying the matrix under time pressure. When criteria are ambiguous, they compare the incident to the last one they remember.",
        meta: { view: "flow" },
      },
      {
        id: "paging",
        label: "Paging and escalation",
        kind: "service",
        health: healthOf(v.underClassification, 15, 30),
        utilization: clamp(0.25 + v.underClassification / 110),
        sublabel: v.underClassification >= 30 ? "under-classified" : "matched to impact",
        detail: "The response the severity unlocks: who is paged, how fast, who is informed, and who has authority. A lower level delays all of it.",
        meta: { view: "flow" },
      },
      {
        id: "response",
        label: "Response",
        kind: "worker",
        health: healthOf(v.responseDelay, 15, 30),
        utilization: clamp(v.responseDelay / 50),
        sublabel: `${v.responseDelay.toFixed(0)} min to engaged response`,
        detail: "Time from report to the right responders working with the right authority. Classification delay and under-classification both add to it.",
        meta: { view: "flow" },
      },
      {
        id: "impact",
        label: "Customer impact",
        kind: "external",
        health: healthOf(v.underClassification, 15, 30),
        utilization: clamp(0.3 + v.underClassification / 130),
        sublabel: v.underClassification >= 30 ? "impact grows unchecked" : "contained by response",
        detail: "The failure continues while the response is scoped to the wrong level. The matrix is a control on time to the correct response.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("intake-matrix", "intake", "matrix", 1 - v.disagreement / 130, healthOf(v.disagreement, 20, 40)),
      edge("matrix-triage", "matrix", "triage", 1 - v.classifyDelay / 30, healthOf(v.classifyDelay, 8, 12)),
      edge("triage-paging", "triage", "paging", 1 - v.underClassification / 120, healthOf(v.underClassification, 15, 30)),
      edge("paging-response", "paging", "response", 1 - v.responseDelay / 50, healthOf(v.responseDelay, 15, 30)),
      edge("response-impact", "response", "impact", 1 - v.underClassification / 120, "ok"),
    ],
    metrics: [
      metric("classify-delay", "Time to classify", v.classifyDelay, " min", 8, 12, "number"),
      metric("disagreement", "Severity disagreement", v.disagreement, "%", 20, 40, "percent"),
      metric("under-classification", "Under-classification risk", v.underClassification, "%", 15, 30, "percent"),
      metric("response-delay", "Time to engaged response", v.responseDelay, " min", 15, 30, "number"),
      metric("matrix-complexity", "Matrix complexity", v.complexity, " pts", undefined, undefined, "number"),
    ],
    events: [
      {
        id: "sm-incident-reported",
        at: 0,
        severity: "info",
        title: "Incident reported with partial impact",
        detail: `The matrix has ${v.axes} axes, ${v.levels} levels, ${v.definitions.toFixed(0)}% criteria with examples, and ${v.exceptions} named override(s). Classification takes ${v.classifyDelay.toFixed(1)} minutes.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Classification takes ${v.classifyDelay.toFixed(1)} min with ${v.disagreement.toFixed(0)}% disagreement; under-classification risk ${v.underClassification.toFixed(0)}%; response starts in ${v.responseDelay.toFixed(0)} min.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 5;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + phase) / 2.9))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "classify-delay",
    metricId: "classify-delay",
    warn: 8,
    crit: 12,
    title: "Classification is taking longer than the response can afford",
    cause:
      "The matrix has too many dimensions, levels, or overrides for a responder to apply with partial information. The time is spent comparing criteria, not responding.",
    fix:
      "Reduce the matrix to the two or three dimensions that change the response. Write a measurable threshold and one worked example for each level, then time a classification with a real incident report.",
    checkFirst: [
      "Time how long a responder takes to classify a realistic report.",
      "Check which axes were actually used to make the last ten decisions.",
      "Check whether responders are reading definitions or pattern-matching to the last incident.",
    ],
  },
  {
    id: "disagreement",
    metricId: "disagreement",
    warn: 20,
    crit: 40,
    title: "Two responders classify the same incident differently",
    cause:
      "The criteria require interpretation, the levels overlap, or an override applies to one team and not another. Under pressure, each responder resolves the ambiguity differently.",
    fix:
      "Rewrite overlapping levels as observable thresholds, remove overrides that bypass the matrix, and test the wording with responders from different teams on the same scenarios. Record where they disagree and change the criterion, not the responder.",
    checkFirst: [
      "Ask two responders to classify the same written scenario independently.",
      "Compare the level they chose and the criterion they cited.",
      "Find the level whose definition overlaps with the one next to it.",
    ],
  },
  {
    id: "under-classification",
    metricId: "under-classification",
    warn: 15,
    crit: 30,
    title: "The incident is classified below its user impact",
    cause:
      "A missing axis or an ambiguous definition lets a severe incident look moderate. The response that arrives is scoped to the label, so paging, communication, and authority are all delayed.",
    fix:
      "Anchor the lowest acceptable level to observable impact, add the missing dimension only if it changes the response, and make under-classification a review finding rather than a matter of individual judgment.",
    checkFirst: [
      "Compare the declared level with the observed user impact.",
      "Check whether the matrix omits scope, duration, or data sensitivity.",
      "Check whether an override lowered the level without a written reason.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const severityMatrixModel: SimModel = {
  id: "reliability-severity-matrix",
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
    if (v.underClassification >= 30 && frame.flags.matrixUnder !== 1) {
      pushEvent(next, {
        id: "sm-under-classified",
        at: frame.t,
        severity: "crit",
        title: "The response is scoped below the impact",
        detail: "The matrix produced a lower level than the observed impact. Paging, communication, and authority are all running at the wrong scale.",
        nodeId: "paging",
        metricId: "under-classification",
      });
      next.flags.matrixUnder = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    return [
      `Classification takes ${v.classifyDelay.toFixed(1)} minutes with ${v.disagreement.toFixed(0)}% disagreement across responders.`,
      `${v.underClassification.toFixed(0)}% under-classification risk means the response may unlock less authority and fewer people than the impact requires.`,
      `The matrix has ${v.axes} axes, ${v.levels} levels, and ${v.exceptions} override(s); complexity is ${v.complexity.toFixed(1)} points.`,
      `Time to an engaged response is ${v.responseDelay.toFixed(0)} minutes. That is the number the matrix exists to protect.`,
    ];
  },
  legend: [
    { label: "Consistent response", tone: "ok" },
    { label: "Slow classification", tone: "warn" },
    { label: "Under-classified", tone: "crit" },
    { label: "Gut feel", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Three axes, four levels, written examples, and one documented override.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Too many exceptions",
    description: "Four axes and three overrides, with thinner definitions. Responders start comparing to the last incident.",
    tone: "warn",
    params: defaults({ axes: 4, responseLevels: 4, definitions: 70, exceptions: 3 }),
  },
  {
    id: "failure",
    label: "Classify by gut",
    description: "Five axes, five levels, eight overrides, and vague criteria. Classification takes longer than the response.",
    tone: "crit",
    params: defaults({ axes: 5, responseLevels: 5, definitions: 20, exceptions: 8 }),
    elapsed: 8,
  },
  {
    id: "recovery",
    label: "Small and tested",
    description: "Three dimensions, three levels, and precise examples. The matrix is fast and consistent.",
    tone: "ok",
    params: defaults({ axes: 3, responseLevels: 3, definitions: 100, exceptions: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-matrix-fix",
  title: "Predict what fixes inconsistent severity",
  simId: "severity-matrix",
  question:
    "A matrix has five axes and eight named overrides. Responders take eleven minutes to classify and often disagree. What do you change first?",
  prediction: {
    options: [
      {
        id: "simplify",
        label: "Collapse to the two axes that change the response, remove the overrides, and test the wording on real scenarios",
      },
      { id: "levels", label: "Add a sixth response level so the distinctions are finer" },
      { id: "authority", label: "Let the incident commander override the matrix without documentation" },
      { id: "guide", label: "Publish a longer guidance document with every possible example" },
    ],
    correctOptionId: "simplify",
    explanation:
      "The matrix is a decision tool used under time pressure. Extra axes, levels, and overrides increase the number of comparisons and the number of paths around the written criteria. The fix is to keep the dimensions that actually change paging, communication, and authority, make each level observable, and test whether two responders reach the same answer. A longer guide adds reading time, not consistency.",
  },
  setup: defaults({ axes: 5, responseLevels: 5, definitions: 30, exceptions: 6 }),
  runFor: 30,
  observe: [
    "Classification delay crosses critical before the response is engaged.",
    "Disagreement stays high even when responders use the same document.",
    "Under-classification risk rises because a missing or ambiguous axis hides scope.",
    "The response starts late at the wrong level, so impact grows while the team debates.",
  ],
  explain:
    "A severity matrix is a control on time to the correct response. Its value is consistency, not completeness. If it takes longer to classify than to act, responders will use pattern matching. If it has many overrides, the written criteria stop predicting the response. Keep it small, observable, and tested with the people who use it.",
  fix: defaults({ axes: 3, responseLevels: 4, definitions: 100, exceptions: 0 }),
  debrief:
    "The simplified matrix classifies in seconds and two responders reach the same level on the same scenario. It gives up some precision on unusual incidents; those are handled by a documented escalation path rather than a permanent override. The tradeoff is deliberate: a fast, consistent response for the common cases, and a visible exception process for the rest.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A severity matrix maps observable incident characteristics to a response level. It answers a narrow question: given this user impact, this scope, and this duration, how many people, how fast, and with what authority should respond? The level then unlocks paging, communication cadence, and decision rights.",
  },
  {
    type: "p",
    text: "A good matrix is small. Two or three dimensions that change the response, three to five levels, and a measurable threshold for each level. If an extra axis does not change who is paged or who can decide, it adds classification time without changing the response. If an override bypasses the matrix, the written criteria stop predicting behavior.",
  },
  {
    type: "p",
    text: "The failure mode is not a missing rule. It is a matrix that looks thorough and is unusable under pressure. Responders read for a minute, compare the incident to the last one they remember, and pick the level that feels right. Two teams then classify the same impact differently, and the response becomes a function of who was on call.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "This module follows severity levels. That module covers classifying one incident from impact and duration. This one covers the design of the classification tool itself: how many dimensions, how many levels, how the wording is tested, and how exceptions erode consistency. The response then feeds escalation, communications, and incident command.",
  },
  {
    type: "table",
    headers: ["Impact", "Scope", "Response level"],
    rows: [
      ["Core task unavailable", "Most users, multiple regions", "Highest: full incident response and executive notification"],
      ["Core task degraded", "One region or a large customer segment", "High: page the owning team and open the incident channel"],
      ["Secondary feature unavailable", "Limited segment, workaround exists", "Moderate: on-call investigates during business hours"],
      ["Cosmetic or single-user issue", "One user or a small group", "Low: normal support queue"],
    ],
  },
  {
    type: "p",
    text: "The table is illustrative. Real thresholds depend on the product, the customer promises, and the authority each level unlocks. What matters is that the rows are observable before the cause is known.",
  },
  {
    type: "p",
    text: "This module models classification time, disagreement, under-classification, and response delay. The values are teaching assumptions, not a recommendation for a specific level scheme.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to classify: how long responders spend before choosing a level.",
      "Severity disagreement: how often two responders choose different levels.",
      "Under-classification risk: incidents labeled below their observed impact.",
      "Time to engaged response: the delay the matrix exists to control.",
      "A flow view from intake through the matrix, triage, paging, and response.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Classify by gut. Watch classification time and disagreement rise together. Run the experiment before reading the debrief, then remove axes and overrides and watch the response engage sooner.",
  },
  {
    type: "compare",
    leftTitle: "Thorough-looking matrix",
    rightTitle: "Usable matrix",
    rows: [
      { label: "Dimensions", left: "Five, because each seems relevant", right: "Two or three that change the response" },
      { label: "Levels", left: "Five with overlapping definitions", right: "Three to five with observable thresholds" },
      { label: "Overrides", left: "Eight named exceptions", right: "One documented escalation path" },
      { label: "Test", left: "Reviewed once by leadership", right: "Timed with responders on real scenarios" },
    ],
  },
  { type: "sim", simId: "severity-matrix" },
  { type: "experiment", experimentId: "predict-matrix-fix" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The matrix had five axes and eight overrides because each one had a real case behind it. The result was a document that took eleven minutes to apply. Responders skipped the definitions and matched the incident to a familiar story. Two people classified the same outage differently, and the lower level paged fewer people. The impact grew while the response argued about the label.",
  },
  {
    type: "p",
    text: "The recovery matrix kept the two dimensions that changed paging and authority, removed the overrides, and wrote one observable example per level. Classification took seconds. The unusual cases still had a path: a documented escalation by the incident commander with a written reason. Consistency improved because the common path stopped competing with the exceptions.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Triage: responders asking whether the incident is more like the last SEV2 or the last SEV1.",
      "Paging: a severe incident with a small responder group because the label was moderate.",
      "Communication: updates at the cadence of the declared level, not the observed impact.",
      "Review: two teams defending different levels using the same document.",
      "Overrides: a named customer or a leadership call bypassing the matrix without a record.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask two responders to classify the same written scenario independently. If they disagree, compare the criterion each one cited. The problem is in the wording or the number of dimensions, not in the responders.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "List the axes and mark which ones actually changed paging, communication, or authority in the last ten incidents.",
      "Remove every axis that did not change the response.",
      "Write one observable threshold and one worked example per level.",
      "Remove named overrides; replace them with a documented escalation that records the reason.",
      "Time classification with responders from different teams on the same scenarios.",
      "Review misclassification as a matrix defect, not an individual error.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A simpler matrix loses precision on unusual incidents. Keep an explicit escalation path for them rather than adding permanent axes.",
      "Fewer levels can feel blunt. Blunt and consistent usually beats precise and contested under pressure.",
      "Testing costs responder time. It is the only way to know whether the wording survives a real report.",
      "An override can be legitimate for a regulated flow. Document it, limit it, and review its use.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "matrix-design",
    question: "How do you design a severity matrix that responders will actually use?",
    difficulty: 2,
    hints: [
      "Start from the response each level unlocks.",
      "Keep only dimensions that change that response.",
    ],
    answer:
      "Start from the response: who is paged, how fast, who is informed, and who can decide. Then choose the two or three observable dimensions that change those answers, usually user impact, scope, and duration. Write a measurable threshold and a worked example for each level. Remove named overrides or replace them with a documented escalation. Finally, test it by timing two responders on the same real scenarios and revising the wording where they disagree.",
    followUps: [
      "How many levels are enough?",
      "What if the cause is known and severe but the impact is small?",
      "Who owns changes to the matrix?",
    ],
    redFlags: [
      "Starts with a list of every possible factor.",
      "Adds levels to cover edge cases.",
      "Never tests the wording.",
    ],
    rubric: [
      "Starts from response.",
      "Keeps dimensions minimal.",
      "Uses observable thresholds.",
      "Tests with responders.",
    ],
  },
  {
    id: "disagreement",
    question: "Two responders classify the same incident differently. What do you change?",
    difficulty: 2,
    hints: [
      "The disagreement is evidence about the matrix.",
      "Find the criterion each person cited.",
    ],
    answer:
      "I ask each responder which criterion they used and what they observed. If they observed different facts, the intake is incomplete. If they observed the same facts and chose different levels, the definition is ambiguous or overlapping. I rewrite that level as an observable threshold with an example, then retest. I do not resolve it by declaring one responder right; that teaches the organization to rely on authority instead of the matrix.",
    followUps: [
      "What if the matrix is fine and the incident is genuinely ambiguous?",
      "How do you record the disagreement?",
      "How often should you retest?",
    ],
    redFlags: [
      "Picks the more senior classification.",
      "Adds a new level.",
      "Blames the responder.",
    ],
    rubric: [
      "Separates facts from interpretation.",
      "Fixes the criterion.",
      "Retests.",
      "Avoids authority-based resolution.",
    ],
  },
  {
    id: "under-classification",
    question:
      "An incident was classified one level too low and the response was delayed. What do you examine?",
    difficulty: 3,
    hints: [
      "Compare declared level with observed impact.",
      "Look for a missing axis or an override.",
    ],
    answer:
      "I compare the observed impact, scope, and duration with the criteria for the declared level and the level above. Then I check whether the matrix omits a dimension that mattered, whether an override lowered the level, and whether the intake lacked the facts needed to classify. The finding is a matrix or intake defect. The action changes the criterion, the intake question, or the override process, not the responder's judgment.",
    followUps: [
      "What if the impact was genuinely unknown at the time?",
      "How do you handle a matrix that depends on cause?",
      "When should the incident commander reclassify?",
    ],
    redFlags: [
      "Adds a rule for that one incident.",
      "Disciplines the responder.",
      "Ignores the missing information.",
    ],
    rubric: [
      "Compares against observed impact.",
      "Checks missing axes and overrides.",
      "Treats it as a design defect.",
      "Changes the process.",
    ],
  },
];

const checklist = [
  {
    title: "Design",
    items: [
      "Start from the response each level unlocks: paging, communication, and authority.",
      "Keep two or three dimensions that change that response.",
      "Write a measurable threshold and one worked example per level.",
      "Replace named overrides with a documented escalation path.",
    ],
  },
  {
    title: "Test",
    items: [
      "Ask responders from different teams to classify the same written scenarios.",
      "Time how long classification takes with partial information.",
      "Record disagreements and the criterion each responder cited.",
      "Revise the wording, not the responder, when the same facts produce different levels.",
    ],
  },
  {
    title: "Operate",
    items: [
      "Review misclassification as a matrix defect in the postmortem.",
      "Track override use and remove overrides that become routine.",
      "Recheck the matrix when products, customer promises, or on-call structure change.",
      "Keep the matrix short enough to read during an incident.",
    ],
  },
];

const references = [
  {
    title: "Severity Levels",
    url: "https://response.pagerduty.com/before/severity_levels/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Practical severity definitions and the link between severity and response.",
  },
  {
    title: "Incident Severity Levels",
    url: "https://www.atlassian.com/incident-management/kpis/severity-levels",
    publisher: "Atlassian",
    kind: "docs" as const,
    note: "Impact-based severity examples and the distinction between severity and priority.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident declaration, roles, and the response that severity is meant to unlock.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "severity-matrix": {
      model: severityMatrixModel,
      presets,
      instructions:
        "Start Healthy, then apply Classify by gut. Watch classification time and disagreement rise. Run the experiment, then reduce the axes and overrides and watch the response engage sooner.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Classification times, disagreement rates, and response delays are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-severity-levels",
    "reliability-escalation",
    "reliability-incident-command",
    "reliability-comms-cadence",
  ],
};
