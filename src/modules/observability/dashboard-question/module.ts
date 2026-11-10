import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TARGET_DECISION_MIN = 5;

const params: ParamSpec[] = [
  {
    id: "panelCount",
    label: "Panels on the dashboard",
    min: 4,
    max: 60,
    step: 1,
    value: 14,
    unit: "",
    group: "Layout",
    help: "Every panel costs scan time. A panel that does not change the decision is a distractor.",
    format: "count",
  },
  {
    id: "relevantPanelPct",
    label: "Panels relevant to the decision",
    min: 10,
    max: 100,
    step: 1,
    value: 85,
    unit: "%",
    group: "Layout",
    help: "Share of panels that answer the question the on-call engineer is actually asking.",
    format: "percent",
  },
  {
    id: "runbookLinkPct",
    label: "Panels with a next step",
    min: 0,
    max: 100,
    step: 1,
    value: 80,
    unit: "%",
    group: "Action",
    help: "Share of panels that link a runbook, a query, or the next check. A number without a next step is a dead end.",
    format: "percent",
  },
  {
    id: "hierarchyPct",
    label: "Decision hierarchy",
    min: 0,
    max: 100,
    step: 1,
    value: 85,
    unit: "%",
    group: "Layout",
    help: "How clearly the top row states the decision, the middle explains it, and the bottom holds context.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  panels: number;
  relevance: number;
  runbook: number;
  hierarchy: number;
  relevant: number;
  distractors: number;
  decisionMin: number;
  confidence: number;
  confidenceShortfall: number;
  wrongTurnRisk: number;
  targetGapMin: number;
}

function compute(p: Params): Computed {
  const panels = Math.round(num(p, "panelCount", 14));
  const relevance = num(p, "relevantPanelPct", 85);
  const runbook = num(p, "runbookLinkPct", 80);
  const hierarchy = num(p, "hierarchyPct", 85);
  const relevant = (panels * relevance) / 100;
  const distractors = Math.max(0, panels - relevant);
  const decisionMin =
    1 +
    panels * 0.08 * (1 - relevance / 100) +
    panels * 0.06 * (1 - hierarchy / 100) +
    (runbook < 50 ? 3 : 0);
  const confidence = clamp(20 + relevance * 0.5 + runbook * 0.25 - distractors * 0.3, 0, 100);
  return {
    panels,
    relevance,
    runbook,
    hierarchy,
    relevant,
    distractors,
    decisionMin,
    confidence,
    confidenceShortfall: 100 - confidence,
    wrongTurnRisk: clamp(distractors * 0.8 + (100 - runbook) * 0.2 + (100 - hierarchy) * 0.15, 0, 100),
    targetGapMin: Math.max(0, decisionMin - TARGET_DECISION_MIN),
  };
}

function decisionHealth(minutes: number): "ok" | "warn" | "crit" {
  if (minutes >= 10) return "crit";
  if (minutes >= 5) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const decision = decisionHealth(values.decisionMin);
  const panelHealth: "ok" | "warn" | "crit" =
    values.distractors >= 30 ? "crit" : values.distractors >= 12 ? "warn" : "ok";
  const runbookHealth: "ok" | "warn" | "crit" =
    values.runbook >= 50 ? "ok" : values.runbook >= 25 ? "warn" : "crit";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "oncall",
        label: "On-call engineer",
        kind: "client",
        health: decision,
        sublabel: `target ${TARGET_DECISION_MIN} min, now ${values.decisionMin.toFixed(1)} min`,
        meta: { view: "flow" },
      },
      {
        id: "dashboard",
        label: "Incident dashboard",
        kind: "service",
        health: decision,
        utilization: clamp(values.decisionMin / 15),
        sublabel: `${values.panels} panels, ${values.relevant.toFixed(0)} relevant`,
        detail: "The dashboard exists to support one decision at a time. Everything else is context that should be one level down.",
        meta: { view: "flow" },
      },
      {
        id: "panels",
        label: "Panel grid",
        kind: "service",
        health: panelHealth,
        utilization: clamp(values.distractors / 40),
        sublabel: `${values.distractors.toFixed(0)} distractors`,
        detail: `${values.distractors.toFixed(0)} of ${values.panels} panels do not support the current decision. Each one adds scan time and a possible wrong turn.`,
        meta: { view: "flow" },
      },
      {
        id: "decision",
        label: "Decision point",
        kind: "service",
        health: decision,
        utilization: clamp(values.decisionMin / 15),
        sublabel: values.decisionMin >= 10 ? "decision overdue" : values.decisionMin >= 5 ? "slow" : "on time",
        detail: `Time to decision is ${values.decisionMin.toFixed(1)} minutes against a ${TARGET_DECISION_MIN}-minute target. Confidence is ${values.confidence.toFixed(0)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "runbook",
        label: "Runbook links",
        kind: "storage",
        health: runbookHealth,
        utilization: clamp(values.runbook / 100),
        sublabel: `${values.runbook.toFixed(0)}% linked`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("oncall-dashboard", "oncall", "dashboard", 0.9, decision),
      edge("dashboard-panels", "dashboard", "panels", 0.9, panelHealth),
      edge("panels-decision", "panels", "decision", 0.8, decision),
      edge("decision-runbook", "decision", "runbook", 0.7, runbookHealth),
    ],
    metrics: [
      metric("decision-time", "Time to decision", values.decisionMin, " min", 5, 10, "number"),
      metric("distractors", "Distractor panels", values.distractors, "", 12, 30, "count"),
      metric("wrong-turn-risk", "Wrong-turn risk", values.wrongTurnRisk, "%", 25, 50, "percent"),
      metric("confidence-shortfall", "Confidence shortfall", values.confidenceShortfall, "%", 50, 75, "percent"),
      metric("relevant-panels", "Relevant panels", values.relevant, "", undefined, undefined, "count"),
      metric("runbook-coverage", "Runbook coverage", values.runbook, "%", undefined, undefined, "percent"),
      metric("target-gap", "Decision over target", values.targetGapMin, " min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.decisionMin.toFixed(1)} min to decide against a ${TARGET_DECISION_MIN}-min target; ${values.distractors.toFixed(0)} distractor panels; ${values.runbook.toFixed(0)}% of panels link a next step.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const offset = seed % 6;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, item.value * (0.92 + 0.16 * Math.sin((index + offset) / 2.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "decision-time",
    metricId: "decision-time",
    warn: 5,
    crit: 10,
    title: "Time to decision is past the incident target",
    cause:
      "The dashboard carries more panels than the decision needs, the relevant ones are not first, and a missing next step forces the responder to search outside the page. The cost is paid in minutes before mitigation starts.",
    fix:
      "Reduce the top row to the decision and its evidence, move context below, and link the next check from every panel that can change the response.",
    checkFirst: [
      "Ask what decision the page is supposed to support and who owns it.",
      "Find the panels the on-call engineer actually opened in the last incident.",
      "Check whether the next step is visible without leaving the dashboard.",
    ],
  },
  {
    id: "distractors",
    metricId: "distractors",
    warn: 12,
    crit: 30,
    title: "Most panels do not support the current decision",
    cause:
      "A data-dump dashboard treats every metric as equally important. The responder has to separate signal from context under time pressure, and the wrong panel can send them down a path that does not explain the symptom.",
    fix:
      "Remove or demote panels with no decision. Keep one row for the symptom and one for the cause, and move historical context to a linked dashboard.",
    checkFirst: [
      "Label each panel with the decision or question it answers.",
      "Remove panels that no one opened during the last three incidents.",
      "Check whether two panels show the same signal at different resolutions.",
    ],
  },
  {
    id: "wrong-turn-risk",
    metricId: "wrong-turn-risk",
    warn: 25,
    crit: 50,
    title: "The dashboard invites a wrong turn",
    cause:
      "Too many equally weighted panels and too few next steps make a plausible but irrelevant signal look like the cause. The responder spends time on the wrong dependency or the wrong layer.",
    fix:
      "Order by decision, state the current hypothesis, and put the next check beside the panel. Add annotations for deploys and known changes so a recent event is not mistaken for a cause.",
    checkFirst: [
      "Check whether the top panel states the symptom and the current impact.",
      "Check whether a recent deploy or configuration change is annotated.",
      "Check whether the runbook names the first three checks in order.",
    ],
  },
  {
    id: "confidence-shortfall",
    metricId: "confidence-shortfall",
    warn: 50,
    crit: 75,
    title: "The responder cannot decide from this dashboard",
    cause:
      "The panels do not establish whether the service is failing, how badly, or what to check next. Missing links and weak hierarchy turn the dashboard into a data source rather than a decision tool.",
    fix:
      "Write the decision at the top, show the SLO and error budget beside it, and link the runbook and the next query. A dashboard that cannot support a decision should not be the incident entry point.",
    checkFirst: [
      "Ask three responders what decision the dashboard supports.",
      "Check whether the SLO status is visible before the resource panels.",
      "Check whether the runbook link resolves and starts with the symptom.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const dashboardModel: SimModel = {
  id: "observability-dashboard-question",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The dashboard has ${values.panels} panels and ${values.distractors.toFixed(0)} of them do not support the current decision.`,
      `Time to decision is ${values.decisionMin.toFixed(1)} minutes against a ${TARGET_DECISION_MIN}-minute target; the gap is ${values.targetGapMin.toFixed(1)} minutes.`,
      `${values.runbook.toFixed(0)}% of panels link a next step, and the wrong-turn risk is ${values.wrongTurnRisk.toFixed(0)}%.`,
      `The top row should state the symptom and the SLO. Cause panels belong below it, ordered by the check they support.`,
      values.decisionMin <= TARGET_DECISION_MIN
        ? "The dashboard supports a decision inside the target. Keep the context links but do not add panels to the top row."
        : "The dashboard is asking the responder to build the decision from raw data. Remove panels before adding more context.",
    ];
  },
  legend: [
    { label: "Decision ready", tone: "ok" },
    { label: "Slow decision", tone: "warn" },
    { label: "Decision blocked", tone: "crit" },
    { label: "Context only", tone: "info" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Fourteen panels, most of them relevant, with a clear top row and a next step on each decision panel.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy dashboard",
    description: "Thirty-two panels and a weaker hierarchy. The decision is still possible, but it takes longer.",
    tone: "warn",
    params: defaults({ panelCount: 32, relevantPanelPct: 50, runbookLinkPct: 40, hierarchyPct: 40 }),
  },
  {
    id: "failure",
    label: "Data dump",
    description: "Sixty panels, a fifth of them relevant, no links, and no hierarchy. The responder cannot decide.",
    tone: "crit",
    params: defaults({ panelCount: 60, relevantPanelPct: 20, runbookLinkPct: 10, hierarchyPct: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A small top row, relevant cause panels, and a runbook link from every decision panel.",
    tone: "ok",
    params: defaults({ panelCount: 12, relevantPanelPct: 90, runbookLinkPct: 90, hierarchyPct: 88 }),
  },
];

const experiment: Experiment = {
  id: "predict-dashboard-panels",
  title: "Predict what twenty more panels do",
  simId: "dashboard",
  question:
    "The incident dashboard has 30 panels, 40% of them relevant, 30% with a next step, and a weak hierarchy. You add 20 more context panels. What happens to time to decision?",
  prediction: {
    options: [
      { id: "slower", label: "It rises because the responder scans more panels and finds the decision later" },
      { id: "faster", label: "It falls because more context reduces uncertainty" },
      { id: "same", label: "It stays the same because the new panels are below the fold" },
      { id: "zero", label: "It becomes immediate because the dashboard is more complete" },
    ],
    correctOptionId: "slower",
    explanation:
      "Context has a scan cost. Adding panels does not change which panels are relevant, so it adds distractors and delays the decision. A useful dashboard improves time to decision by ordering the relevant signal first and linking the next check, not by increasing coverage.",
  },
  setup: defaults({ panelCount: 50, relevantPanelPct: 40, runbookLinkPct: 30, hierarchyPct: 40 }),
  runFor: 20,
  observe: [
    "Time to decision rises as panel count grows while relevance stays fixed.",
    "Distractor panels increase, and the wrong-turn risk rises with them.",
    "The runbook link percentage does not improve just because more panels exist.",
    "A smaller, ordered dashboard with links reduces decision time more than a complete one.",
  ],
  explain:
    "The dashboard is not a data catalog. It is a decision surface. Every panel competes for attention, and a panel with no next step forces the responder to leave the page. Relevance and ordering determine whether the right panel is found before the target time; total coverage does not.",
  fix: defaults({ panelCount: 12, relevantPanelPct: 90, runbookLinkPct: 90, hierarchyPct: 88 }),
  debrief:
    "The fix cuts the panel count, raises the relevant share, and adds a next step. Time to decision falls well inside the target. The tradeoff is that some context is no longer on the first page. That is intentional: context belongs one click away, and the incident entry point should answer one question first.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An incident dashboard is a decision surface. It should answer three questions in order: is the service failing, how badly, and what should I check next. A data dump answers many questions at once and none of them first. The difference is not aesthetic. It changes how long the responder spends before taking the first useful action.",
  },
  {
    type: "p",
    text: "A decision path has a hierarchy. The top row states the symptom and the SLO impact. The next row shows the few signals that distinguish the likely causes. The bottom holds context, history, and links. Every panel should name the decision or question it supports, and every panel that can change the response should link the next check.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The dashboard sits between the telemetry and the runbook. It is not the source of truth and it is not the incident process. It is the place where the on-call engineer forms the first hypothesis. That makes time to decision the useful quality measure, not the number of metrics on the page.",
  },
  {
    type: "table",
    headers: ["Panel class", "Question", "Placement"],
    rows: [
      ["Symptom", "Are users affected and how badly?", "Top row, always visible"],
      ["Impact", "Which SLO or customer segment is burning?", "Top row beside the symptom"],
      ["Cause", "Which dependency or resource explains it?", "Second row, ordered by likelihood"],
      ["Change", "What deploy or configuration changed?", "Annotation and a linked timeline"],
      ["Context", "What is the longer history?", "Below the fold or a linked dashboard"],
    ],
  },
  {
    type: "p",
    text: "The model compresses the decision into minutes. Panel count, relevance, hierarchy, and runbook coverage are teaching controls; the exact coefficients are illustrative, not a measured study. The shape is what matters: scan cost rises with irrelevant panels, and missing next steps add a search outside the dashboard.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Time to decision against a five-minute target.",
      "Distractor panels: panels that do not support the current decision.",
      "Wrong-turn risk, which rises when equally weighted panels hide the right one.",
      "Confidence shortfall, which captures missing hierarchy and missing next steps.",
      "Runbook coverage, so a complete-looking dashboard cannot hide a dead end.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Data dump. Watch time to decision and wrong-turn risk rise together. Apply Busy dashboard and add panels: the extra context makes the decision slower, not faster. Then run the experiment and apply Recovery.",
  },
  {
    type: "compare",
    leftTitle: "Data dump",
    rightTitle: "Decision path",
    rows: [
      { label: "Starts with", left: "Every metric that exists", right: "The symptom and the SLO" },
      { label: "Order", left: "By service or by data source", right: "By the decision and the next check" },
      { label: "Success", left: "Coverage", right: "Time to a defensible action" },
      { label: "Failure", left: "The responder cannot find the signal", right: "A missing signal is obvious and linked" },
    ],
  },
  { type: "sim", simId: "dashboard" },
  { type: "experiment", experimentId: "predict-dashboard-panels" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Adding panels without changing relevance made the decision slower. The dashboard had more information and less signal. Distractors and wrong-turn risk rose together, and the runbook link percentage stayed low because the new panels did not carry a next step.",
  },
  {
    type: "p",
    text: "The recovery preset cut the panel count, moved the relevant signals to the top, and linked the next check from every decision panel. Time to decision fell inside the target. The remaining context was still available, just not competing with the first question.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Grafana: dashboard links, panel links, annotations for deploys, and variables that keep one dashboard useful across services. Check the dashboard's own load time and the number of panels.",
      "PagerDuty or the incident tool: the page payload links the dashboard and the runbook. If the responder has to search, the dashboard has already failed.",
      "SLO tooling: the top row shows the SLI, burn, and remaining budget, not only CPU and memory.",
      "Change feed: deploy annotations and configuration changes on the same time axis as the symptoms.",
      "Incident review: time from page to first hypothesis and time to first mitigation. These are the outcomes the dashboard is supposed to improve.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask what decision the dashboard supports and who owns it. Find the panel the on-call engineer opened first in the last incident. Check whether the next step is visible without leaving the page. Then remove panels before adding any.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the decision at the top of the dashboard in one sentence.",
      "Put the symptom and SLO impact in the first row; move resource panels below.",
      "Label every panel with the question it answers and delete the ones with no decision.",
      "Link the runbook, the next query, and the ownership from every decision panel.",
      "Annotate deploys and configuration changes on the same time axis.",
      "Measure time to decision in the next incident and remove the panels nobody opened.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A smaller dashboard is faster and less complete; context has to live one click away.",
      "A dashboard optimized for one incident can become a data dump again as new questions are added.",
      "Runbook links decay. A dead link is worse than no link because it costs time and trust.",
      "Annotations require a deploy pipeline that emits them; without that, the timeline is incomplete.",
      "A dashboard is not a substitute for an SLO. A beautiful layout cannot make a missing signal visible.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "redesign-dashboard",
    question:
      "It is 3 a.m. and the dashboard has every metric but no next step. How do you redesign it?",
    difficulty: 2,
    hints: [
      "Start with the decision, not the metrics.",
      "Move context down and link the next check.",
    ],
    answer:
      "I would ask what decision the on-call engineer needs to make in the first five minutes and who owns it. The top row becomes the symptom and the SLO impact, the second row the few signals that distinguish likely causes, and the rest moves to a linked context dashboard. Every panel that can change the response gets a runbook or query link. Deploy annotations go on the same time axis. Then I would measure time to first hypothesis in the next incident and remove panels nobody opened.",
    followUps: [
      "Which panels would you keep for a latency incident?",
      "How do you handle multiple services on one dashboard?",
      "What would you do with a panel that is required by compliance?",
    ],
    redFlags: [
      "Adds more panels to cover every case.",
      "Starts with tooling instead of the decision.",
      "Leaves the runbook outside the page.",
    ],
    rubric: [
      "Starts from the decision.",
      "Orders by symptom, cause, context.",
      "Links the next check.",
      "Measures time to decision.",
    ],
  },
  {
    id: "panel-relevance",
    question:
      "How do you decide whether a panel belongs on the incident dashboard?",
    difficulty: 2,
    hints: [
      "A panel must change a decision or explain one.",
      "Context can live one click away.",
    ],
    answer:
      "I ask which decision the panel supports and what the responder would do differently after seeing it. If the answer is nothing, it is context and belongs below the fold or on a linked dashboard. If it explains a symptom, it belongs in the cause row. If it is required for compliance or a postmortem, it can live in a linked view. The test is not whether the data is interesting; it is whether it changes the next action.",
    followUps: [
      "What if two responders disagree about relevance?",
      "How often would you review the panel set?",
      "How do you handle a panel that is only useful after mitigation?",
    ],
    redFlags: [
      "Keeps a panel because it has always been there.",
      "Confuses coverage with usefulness.",
      "Has no owner for the dashboard.",
    ],
    rubric: [
      "Ties panels to decisions.",
      "Separates context from decision.",
      "Assigns review ownership.",
      "Allows linked detail.",
    ],
  },
  {
    id: "annotation-value",
    question:
      "Why do deploy annotations matter on an incident dashboard, and what can go wrong with them?",
    difficulty: 2,
    hints: [
      "A timeline without changes invites false causality.",
      "An annotation is only useful if its timestamp is trustworthy.",
    ],
    answer:
      "Deploy annotations let the responder see whether a change lines up with the symptom without leaving the dashboard. Without them, the most recent deploy becomes the default suspect even when it happened after the failure. The annotation must carry a trustworthy timestamp and a link to the change, and it must distinguish a deploy from a rollback or a configuration change. If the pipeline emits annotations late or with the wrong clock, the dashboard can create false causality instead of removing it.",
    followUps: [
      "How would you handle a deploy that takes twenty minutes to roll out?",
      "What other changes should be annotated?",
      "How do you verify the annotation clock?",
    ],
    redFlags: [
      "Treats every deploy as the cause.",
      "Ignores timestamp skew.",
      "Annotates only successful deploys.",
    ],
    rubric: [
      "Connects annotations to causality.",
      "Requires trustworthy timestamps.",
      "Includes rollback and config changes.",
      "Names the false-cause risk.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The dashboard names the decision it supports and the team that owns it.",
      "The top row shows the symptom and SLO impact before resource metrics.",
      "Every decision panel links a runbook, query, or next check.",
      "Deploys, rollbacks, and configuration changes are annotated with a trusted timestamp.",
      "A linked context dashboard holds the history that does not belong in the first row.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Start from the symptom and the SLO, not from the resource panel.",
      "Use the cause row to test one hypothesis at a time.",
      "Open the runbook from the panel instead of searching for it.",
      "Record which panels were opened and which were ignored.",
      "Check annotations before blaming the most recent change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Measure time from page to first hypothesis and first mitigation.",
      "Remove panels that no one opened or that did not change a decision.",
      "Fix dead runbook links and stale ownership metadata.",
      "Add one panel only if it supports a decision that was missing.",
    ],
  },
];

const references = [
  {
    title: "Best practices for dashboards",
    url: "https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/",
    publisher: "Grafana",
    kind: "docs" as const,
    note: "Dashboard structure, panel design, links, and annotations.",
  },
  {
    title: "Monitoring Distributed Systems",
    url: "https://sre.google/sre-book/monitoring-distributed-systems/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "Symptoms versus causes and the signals that belong on an incident view.",
  },
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Putting SLO impact at the center of the paging and dashboard path.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    dashboard: {
      model: dashboardModel,
      presets,
      instructions:
        "Start Healthy, then apply Data dump. Watch time to decision and wrong-turn risk rise. Apply Busy dashboard, add panels, then run the experiment and apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Decision-time coefficients and the five-minute target are teaching values, not a measured study.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-grafana-dashboard",
    "observability-symptom-alerting",
    "observability-incident-timeline",
    "foundations-use-red",
  ],
};
