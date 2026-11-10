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
    id: "affectedUsers",
    label: "Affected users",
    min: 0,
    max: 100,
    step: 1,
    value: 2,
    unit: "%",
    group: "Impact",
    help: "Share of the user base that cannot complete the core task at normal quality.",
    format: "percent",
  },
  {
    id: "duration",
    label: "Expected duration",
    min: 0,
    max: 120,
    step: 5,
    value: 5,
    unit: " min",
    group: "Impact",
    help: "Expected time under impact if the response continues at its current pace.",
    format: "number",
  },
  {
    id: "criteriaCoverage",
    label: "Written criteria used",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Triage",
    help: "Share of the classification made from written impact criteria instead of gut feel or the suspected cause.",
    format: "percent",
  },
  {
    id: "pagingDelay",
    label: "Paging delay",
    min: 0,
    max: 30,
    step: 1,
    value: 1,
    unit: " min",
    group: "Response",
    help: "Minutes between detection and paging the first responder, before any severity mismatch adds delay.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface SevState {
  exposure: number;
}

const INITIAL: SevState = { exposure: 0 };

function readState(frame: SimFrame): SevState {
  return { exposure: Math.max(0, Number(frame.flags.sevExposure ?? 0)) };
}

interface Values {
  affected: number;
  duration: number;
  coverage: number;
  pagingDelay: number;
  score: number;
  correctLevel: number;
  declaredLevel: number;
  mismatch: number;
  pageMinutes: number;
  responseGap: number;
  exposure: number;
}

function compute(p: Params, state: SevState): Values {
  const affected = clamp(num(p, "affectedUsers", 2), 0, 100);
  const duration = clamp(num(p, "duration", 5), 0, 120);
  const coverage = clamp(num(p, "criteriaCoverage", 100), 0, 100);
  const pagingDelay = clamp(num(p, "pagingDelay", 1), 0, 30);
  const score = affected * Math.max(1, duration);
  const correctLevel = score >= 1000 ? 1 : score >= 300 ? 2 : score >= 60 ? 3 : 4;
  const under = coverage < 40 ? 2 : coverage < 75 ? 1 : 0;
  const declaredLevel = Math.min(4, correctLevel + under);
  const mismatch = declaredLevel - correctLevel;
  const pageMinutes = pagingDelay + mismatch * 7;
  const responseGap = mismatch * 25;
  return {
    affected,
    duration,
    coverage,
    pagingDelay,
    score,
    correctLevel,
    declaredLevel,
    mismatch,
    pageMinutes,
    responseGap,
    exposure: state.exposure,
  };
}

function advance(state: SevState, p: Params, dt: number): SevState {
  const values = compute(p, state);
  const rate = values.affected * (1 + values.mismatch * 0.5);
  return { exposure: clamp(state.exposure + Math.max(0, rate) * Math.max(0, dt), 0, 10000) };
}

function sevLabel(level: number): string {
  return `SEV${level}`;
}

function buildFrame(p: Params, state: SevState, seed: number): SimFrame {
  const values = compute(p, state);
  const triageHealth: "ok" | "warn" | "crit" =
    values.mismatch >= 2 ? "crit" : values.mismatch >= 1 ? "warn" : "ok";
  const pagingHealth: "ok" | "warn" | "crit" =
    values.pageMinutes >= 15 ? "crit" : values.pageMinutes >= 5 ? "warn" : "ok";
  const responseHealth: "ok" | "warn" | "crit" =
    values.responseGap >= 45 ? "crit" : values.responseGap >= 20 ? "warn" : "ok";
  const customerHealth: "ok" | "warn" | "crit" =
    values.exposure >= 4000 ? "crit" : values.exposure >= 1200 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "detection",
        label: "Detection",
        kind: "service",
        health: "ok",
        utilization: 0.35,
        sublabel: "symptom reported",
        detail: "Detection supplies the first symptom. It does not decide severity; impact and scope do.",
        meta: { view: "flow" },
      },
      {
        id: "triage",
        label: "Triage",
        kind: "worker",
        health: triageHealth,
        utilization: clamp(0.3 + values.mismatch * 0.2),
        sublabel: `${sevLabel(values.declaredLevel)} declared`,
        detail: `Impact-derivative severity is ${sevLabel(values.correctLevel)}; declared is ${sevLabel(values.declaredLevel)}. The gap is ${values.mismatch} level(s).`,
        meta: { view: "flow" },
      },
      {
        id: "paging",
        label: "Paging",
        kind: "worker",
        health: pagingHealth,
        utilization: clamp(0.3 + values.pageMinutes / 40),
        sublabel: `${values.pageMinutes.toFixed(0)} min to page`,
        detail: "Severity selects the paging policy. An under-classified incident pages fewer people and waits longer.",
        meta: { view: "flow" },
      },
      {
        id: "response",
        label: "Response",
        kind: "worker",
        health: responseHealth,
        utilization: clamp(0.35 + values.responseGap / 150),
        sublabel: `${values.responseGap.toFixed(0)}% response gap`,
        detail: "Response coverage is the people, authority, and communication the declared severity activates.",
        meta: { view: "flow" },
      },
      {
        id: "customers",
        label: "Customers",
        kind: "external",
        health: customerHealth,
        utilization: clamp(values.exposure / 8000),
        sublabel: `${values.exposure.toFixed(0)} %-min exposure`,
        detail: "Impact exposure accumulates while users cannot complete the core task. Severity is a response decision, not a label for the cause.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("detection-triage", "detection", "triage", 0.9, triageHealth),
      edge("triage-paging", "triage", "paging", 1 - values.mismatch / 3, pagingHealth),
      edge("paging-response", "paging", "response", 1 - values.responseGap / 100, responseHealth),
      edge("response-customers", "response", "customers", 1 - values.responseGap / 100, customerHealth),
    ],
    metrics: [
      metric("severity-mismatch", "Severity mismatch (levels)", values.mismatch, "", 1, 2, "count"),
      metric("time-to-page", "Time to page", values.pageMinutes, " min", 5, 15, "number"),
      metric("response-gap", "Response coverage gap", values.responseGap, "%", 20, 45, "percent"),
      metric("impact-exposure", "Impact exposure", values.exposure, " %-min", 1200, 4000, "number"),
      metric("declared-severity", "Declared severity", values.declaredLevel, "", undefined, undefined, "count"),
      metric("correct-severity", "Impact-derived severity", values.correctLevel, "", undefined, undefined, "count"),
    ],
    events: [
      {
        id: "sev-incident-detected",
        at: 0,
        severity: "info",
        title: "Incident detected",
        detail: `Triage is classifying the incident from impact and scope. Declared severity is ${sevLabel(values.declaredLevel)}; impact-derived severity is ${sevLabel(values.correctLevel)}.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), sevExposure: state.exposure },
    summary: `${sevLabel(values.correctLevel)} impact declared ${sevLabel(values.declaredLevel)}; page in ${values.pageMinutes.toFixed(0)} min; ${values.exposure.toFixed(0)} %-min exposure.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + phase) / 2.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "severity-mismatch",
    metricId: "severity-mismatch",
    warn: 1,
    crit: 2,
    title: "The declared severity is lower than the impact warrants",
    cause:
      "The classification followed the suspected cause instead of user impact and scope. A single failing component can still affect most users, and a dramatic cause can still affect almost no one.",
    fix:
      "Re-classify from the impact matrix: affected users, core capability, scope, and duration. Raise paging and communication to the level the impact requires, then record the change and the evidence.",
    checkFirst: [
      "Compare the affected user share with the written severity criteria.",
      "Check whether the declared severity was based on the cause or the impact.",
      "Check whether a workaround reduces the affected scope.",
    ],
  },
  {
    id: "time-to-page",
    metricId: "time-to-page",
    warn: 5,
    crit: 15,
    title: "Paging is delayed by severity or by the paging path",
    cause:
      "A lower severity can add delay, but a correctly classified incident can still page slowly when the policy has manual steps or the page is not acknowledged. The metric alone does not distinguish the two.",
    fix:
      "If the severity is under-classified, re-classify from impact. If the severity is correct, fix the paging path: page the right responder directly, remove manual steps, and verify acknowledgement.",
    checkFirst: [
      "Check the detection time, page time, and acknowledgement time separately.",
      "Check whether the declared severity matches the impact criteria.",
      "Check whether a manual step or unacknowledged page delayed the path.",
    ],
  },
  {
    id: "response-gap",
    metricId: "response-gap",
    warn: 20,
    crit: 45,
    title: "The response is under-staffed for the declared impact",
    cause:
      "Severity controls how many people, how much authority, and how frequent the communication become. Under-classification leaves the response sized for a smaller incident.",
    fix:
      "Raise the severity to the impact level and activate the corresponding roles, escalation path, and communication cadence. Do not wait for a root cause to justify the response.",
    checkFirst: [
      "List the roles and authority the current severity activated.",
      "Check whether the incident commander has authority to make the needed call.",
      "Check whether communications and support are sized for the customer impact.",
    ],
  },
  {
    id: "impact-exposure",
    metricId: "impact-exposure",
    warn: 1200,
    crit: 4000,
    title: "Customer impact exposure has accumulated",
    cause:
      "Impact exposure is affected users times minutes. It grows while users are affected, even after the response is correctly sized. A severity mismatch doubles the modeled accumulation rate; correcting it halves the rate but does not erase the exposure already incurred.",
    fix:
      "Use exposure to compare incidents and to verify the trend after correction. A high cumulative value is not proof the response is still undersized; check the current rate and the response gap.",
    checkFirst: [
      "Check whether the current rate is falling, not only whether the total is high.",
      "Check whether the workaround is reducing affected users.",
      "Check whether the response gap has closed after re-classification.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const severityLevelsModel: SimModel = {
  id: "reliability-severity-levels",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), INITIAL, seed),
  step: (frame, p, dt, rng) => {
    const state = advance(readState(frame), p, dt);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, state, seed);
    const values = compute(p, state);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.events =
      frame.flags.paramsKey === JSON.stringify(p) ? frame.events.slice(-60) : next.events;
    if (values.mismatch >= 2 && frame.flags.sevMismatchEvent !== 1) {
      pushEvent(next, {
        id: "sev-underclassified",
        at: frame.t,
        severity: "crit",
        title: `${sevLabel(values.correctLevel)} impact classified as ${sevLabel(values.declaredLevel)}`,
        detail: `The declared severity is ${values.mismatch} level(s) below the impact-derived severity. Paging and response are sized for the smaller incident.`,
        nodeId: "triage",
        metricId: "severity-mismatch",
      });
      next.flags.sevMismatchEvent = 1;
    }
    if (values.pageMinutes >= 15 && frame.flags.sevPageEvent !== 1) {
      const mismatchDriven = values.mismatch > 0;
      pushEvent(next, {
        id: "sev-page-delayed",
        at: frame.t,
        severity: "warn",
        title: mismatchDriven
          ? "Paging is delayed by the severity mismatch"
          : "Paging path is slow despite correct severity",
        detail: mismatchDriven
          ? `The first page arrives ${values.pageMinutes.toFixed(0)} minutes after detection. The declared severity is ${sevLabel(values.declaredLevel)}; a higher severity would have selected a faster policy.`
          : `The first page arrives ${values.pageMinutes.toFixed(0)} minutes after detection with ${sevLabel(values.declaredLevel)} correctly classified. The delay is in the paging path or acknowledgement, not the severity decision.`,
        nodeId: "paging",
        metricId: "time-to-page",
      });
      next.flags.sevPageEvent = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.nodes = next.nodes.map((node) => ({
      ...node,
      utilization: clamp((node.utilization ?? 0) + rng.between(-0.004, 0.004)),
    }));
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, readState(frame));
    return [
      `Impact-derived severity is ${sevLabel(values.correctLevel)} (${values.score.toFixed(0)} impact points); declared severity is ${sevLabel(values.declaredLevel)}.`,
      `The mismatch adds ${values.mismatch * 7} minutes to paging and leaves a ${values.responseGap.toFixed(0)}% response coverage gap.`,
      `${values.affected.toFixed(0)}% of users are affected for an expected ${values.duration.toFixed(0)} minutes; impact exposure is ${values.exposure.toFixed(0)} %-min.`,
      `Written criteria are used for ${values.coverage.toFixed(0)}% of the classification. A cause-based call can under-classify a wide-impact failure.`,
    ];
  },
  legend: [
    { label: "Severity fit", tone: "ok" },
    { label: "One level low", tone: "warn" },
    { label: "Under-classified", tone: "crit" },
    { label: "Unclassified", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A narrow, short impact classified from written criteria with a fast page.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A moderate impact with partial criteria use. The severity is one level low and paging is slower.",
    tone: "warn",
    params: defaults({ affectedUsers: 25, duration: 20, criteriaCoverage: 65, pagingDelay: 3 }),
  },
  {
    id: "failure",
    label: "Under-classified",
    description: "Most users are blocked, but the suspected cause sounds small, so the incident is declared SEV3.",
    tone: "crit",
    params: defaults({ affectedUsers: 70, duration: 60, criteriaCoverage: 20, pagingDelay: 2 }),
  },
  {
    id: "late-page",
    label: "SEV1, late page",
    description: "The severity is correct, but the page waits 25 minutes. Correct classification without a fast response is not enough.",
    tone: "crit",
    params: defaults({ affectedUsers: 90, duration: 90, criteriaCoverage: 75, pagingDelay: 25 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Impact is scoped, the written criteria agree, and the page goes out immediately.",
    tone: "ok",
    params: defaults({ affectedUsers: 10, duration: 10, criteriaCoverage: 100, pagingDelay: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-under-classification",
  title: "Predict the cost of a cause-based severity call",
  simId: "severity-levels",
  question:
    "Most users cannot complete the core task, but the suspected cause is a single database replica, so the incident is declared SEV3. What happens next?",
  prediction: {
    options: [
      { id: "slow", label: "Paging and response are sized for a smaller incident and the impact accumulates" },
      { id: "self-correct", label: "The severity corrects itself once the cause is confirmed" },
      { id: "cause", label: "The cause determines severity, so SEV3 is correct" },
      { id: "none", label: "Severity is administrative and does not change the response" },
    ],
    correctOptionId: "slow",
    explanation:
      "Severity selects paging, communication, authority, and escalation. A single component can have a wide blast radius. If the declared severity follows the cause instead of the affected users and scope, the response is too small for the impact, and exposure grows while everyone works hard.",
  },
  setup: defaults({ affectedUsers: 70, duration: 60, criteriaCoverage: 20, pagingDelay: 2 }),
  runFor: 45,
  observe: [
    "The declared severity is two levels below the impact-derived severity.",
    "Time to page crosses its critical threshold because the lower severity selects a slower policy.",
    "The response coverage gap stays critical while the technical team is working.",
    "Impact exposure grows at the affected-user rate even after the response is corrected; it is cumulative, not a live response-size signal.",
  ],
  explain:
    "Severity is a response decision, not a diagnosis. The impact matrix maps affected users, scope, and duration to a response level. The cause can explain the failure later, but it cannot size the page, the communication cadence, or the authority the incident needs now. Under-classification is expensive because it delays all of those at once.",
  fix: defaults({ affectedUsers: 70, duration: 60, criteriaCoverage: 100, pagingDelay: 1 }),
  debrief:
    "With criteria-based classification, the incident is declared at the impact level, the page goes out immediately, and the response gap closes. The exposure already incurred remains visible; its growth rate, not its total, shows whether the corrected response is working. The tradeoff is that a wider response may be activated before the cause is confirmed, and some incidents will be downgraded later. That cost is smaller than discovering the scope after the response has already been sized too small.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Severity is a short label for how much response an incident needs. It is not a measure of how interesting the cause is, how senior the responder is, or how hard the fix will be. The label selects a response: who gets paged, how often the team communicates, who has authority to make decisions, and how far the incident escalates.",
  },
  {
    type: "p",
    text: "Many organizations use levels such as SEV1 through SEV4, but the names and boundaries vary. The useful part is not the number. It is the written criteria that map user impact, scope, duration, and data or security exposure to a response level. A severity matrix should be simple enough to use in the first few minutes, when the team knows the symptom but not the cause.",
  },
  {
    type: "p",
    text: "Two failure directions matter. Under-classification delays paging, communications, and authority, so a wide-impact incident receives a narrow response. Over-classification pages too many people, consumes response capacity, and can make every ambiguous symptom look like a major outage. The goal is not to classify perfectly on the first attempt. It is to classify from impact, state the uncertainty, and re-evaluate when scope changes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Severity sits in triage, after detection and before paging. Detection supplies a symptom. Triage compares the symptom with the impact criteria. Paging, communications, and escalation then use the severity to choose their response. The incident commander can change the severity as evidence arrives, but the change should be announced and recorded so every audience receives the same response level.",
  },
  {
    type: "table",
    headers: ["Level", "Illustrative impact criteria", "Response implication"],
    rows: [
      ["SEV1", "Core capability unavailable for a large share of users, or confirmed data exposure", "Immediate page, command, communications, and leadership involvement"],
      ["SEV2", "Major degradation or a smaller set of users blocked, with no workaround", "Page the on-call and backup, frequent updates, active command"],
      ["SEV3", "Limited scope or a workaround exists", "On-call response, lower update cadence, business-hours escalation if stable"],
      ["SEV4", "Minor or cosmetic impact", "Normal queue, no incident command unless it grows"],
    ],
  },
  {
    type: "p",
    text: "The table is illustrative. The model uses an impact score of affected user share times expected duration, then compares that score with thresholds to derive a severity. The numbers are teaching values, not universal definitions. The important behavior is that the cause is not an input to the severity calculation.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Declared severity and impact-derived severity, shown as numbers where 1 is the highest level.",
      "Severity mismatch: how many levels the declared severity sits below the impact-derived level.",
      "Time to page: detection to the first page, including the delay the severity mismatch adds.",
      "Response coverage gap: people, authority, and communication missing for the declared impact.",
      "Impact exposure: affected users multiplied by minutes. It is cumulative: a correct response lowers the rate, but exposure already incurred remains.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Under-classified. Compare the two severity numbers before the exposure metric. Apply SEV1, late page to separate classification from response speed. Run the experiment before reading the debrief, then raise criteria coverage and watch the mismatch close.",
  },
  {
    type: "compare",
    leftTitle: "Cause-based severity",
    rightTitle: "Impact-based severity",
    rows: [
      { label: "Input", left: "The component that failed", right: "Affected users, scope, duration, data exposure" },
      { label: "Response", left: "Sized for the suspected cause", right: "Sized for the observed impact" },
      { label: "Failure", left: "A small cause with a wide blast radius is under-classified", right: "A wide response may be activated before the cause is known" },
      { label: "Revision", left: "Changes when the diagnosis changes", right: "Changes when the impact is better understood" },
    ],
  },
  { type: "sim", simId: "severity-levels" },
  { type: "experiment", experimentId: "predict-under-classification" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The incident was classified from its suspected cause. A single database replica sounded small, so the response was declared SEV3 while most users could not complete the core task. The smaller severity selected a slower page, a narrower response, and a lower communication cadence. The technical team was busy, but the response was sized for a different incident.",
  },
  {
    type: "p",
    text: "Correcting the classification did not change the underlying failure. It changed who was paged, what authority was active, and how often the team communicated. Correcting the response halved the rate at which impact exposure accumulated, but the exposure already incurred remained on the chart. A high cumulative value after the fix did not mean the response was still undersized. That distinction is the point of severity: it allocates response capacity before the cause is fully understood.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Paging tool: a low-severity policy with a single responder, while support and leadership are already handling a broad outage.",
      "Incident channel: the severity was set from the first hypothesis and has not been revisited after scope data arrived.",
      "Support queue: customers report a core capability failure while the incident is described internally as a minor component issue.",
      "Status page: no customer-facing update because the declared severity did not activate the external cadence.",
      "Leadership: asks for a bridge because the response level does not match the visible business impact.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the declared severity with the written impact criteria: affected users, core capability, scope, duration, and data exposure. Check whether the classification was based on the cause. If the impact is uncertain, page for the worst plausible impact and downgrade after evidence arrives.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Re-classify from the impact matrix using the best current evidence, not the suspected cause.",
      "Raise paging, communications, and authority to the level the impact requires.",
      "Record the old severity, the new severity, the evidence, and the time of the change.",
      "Tell every audience the new level and what changes for them.",
      "Re-evaluate at each scope update; severity can move down as well as up.",
      "After recovery, check whether the first classification was late and which signal would have caught it earlier.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Under-classification delays the response and hides the incident from the people who could help.",
      "Over-classification pages too many people, consumes response capacity, and can make every ambiguous symptom look like a major outage.",
      "A simple matrix is fast to use but may miss edge cases; a detailed matrix is precise but too slow under pressure.",
      "Classifying conservatively and downgrading later is usually safer than waiting for certainty, but it requires a clear downgrade path.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "same-outage",
    question:
      "One team calls an outage SEV1 and another calls the same thing SEV3. What is missing, and how do you fix it?",
    difficulty: 2,
    hints: [
      "The teams are using different criteria, not different facts.",
      "The matrix should map impact to response.",
    ],
    answer:
      "The teams are missing a shared, written impact matrix and a common definition of each severity. I would define severity from affected users, core capability, scope, duration, and data exposure, then map each level to a response: paging, communication cadence, authority, and escalation. I would test the matrix against past incidents and ambiguous examples, name who can re-classify, and review disagreements after the incident. The labels can vary by organization; the mapping from impact to response has to be consistent.",
    followUps: [
      "Who owns the severity definition?",
      "How do you handle an incident that sits between two levels?",
      "What do you do when the cause is known but the scope is not?",
    ],
    redFlags: [
      "Says severity is just a label.",
      "Lets each team keep its own scale.",
      "Uses the cause as the primary criterion.",
    ],
    rubric: [
      "Requires written impact criteria.",
      "Maps severity to response.",
      "Names an owner and a re-evaluation path.",
      "Tests the matrix against examples.",
    ],
  },
  {
    id: "small-cause",
    question:
      "A single database replica failure is affecting most users. Is that a high-severity incident?",
    difficulty: 2,
    hints: [
      "Severity follows impact, not the size of the failed component.",
      "A small cause can have a wide blast radius.",
    ],
    answer:
      "It is a high-severity incident if most users cannot complete the core task and no workaround is available. The failed component is small, but the blast radius is not. I would classify from the affected users, the core capability, the duration, and whether data is at risk. The cause is useful for the technical response and the postmortem, but it should not lower the severity. The label should reflect the response the impact requires.",
    followUps: [
      "What if a workaround restores most users?",
      "When would you downgrade the severity?",
      "How does the cause still matter?",
    ],
    redFlags: [
      "Equates a small component with a small incident.",
      "Waits for root cause before paging.",
      "Ignores the workaround.",
    ],
    rubric: [
      "Classifies by user impact.",
      "Accounts for blast radius and workaround.",
      "Separates severity from cause.",
      "Describes re-evaluation.",
    ],
  },
  {
    id: "unclear-severity",
    question:
      "You do not know the scope yet. How do you classify the incident without stalling?",
    difficulty: 3,
    hints: [
      "Page for the worst plausible impact.",
      "Set a time to re-evaluate.",
    ],
    answer:
      "I would classify conservatively from the worst plausible impact that fits the evidence, page the response for that level, and set a specific time to re-evaluate. I would state the uncertainty in the update and name the evidence that would justify a downgrade. That avoids both a silent under-response and an indefinite high-severity state. The decision should be recorded so the next commander can see why the initial level was chosen.",
    followUps: [
      "How do you avoid over-paging every ambiguous incident?",
      "What evidence justifies a downgrade?",
      "Who makes the re-classification call?",
    ],
    redFlags: [
      "Waits for certainty before paging.",
      "Classifies at the lowest level to avoid noise.",
      "Has no re-evaluation time.",
    ],
    rubric: [
      "Pages conservatively.",
      "Sets a re-evaluation point.",
      "States uncertainty.",
      "Records the decision.",
    ],
  },
  {
    id: "why-not-cause",
    question: "Why should severity not be based on the technical cause?",
    difficulty: 2,
    hints: [
      "The same cause can have different blast radii.",
      "Severity sizes the response before the cause is confirmed.",
    ],
    answer:
      "Because the cause does not determine the impact. The same misconfiguration can affect one internal tool or every customer, and a dramatic-sounding failure can have a narrow blast radius. Severity has to size the response while the cause is still uncertain. If the classification follows the cause, the response is either too small for a wide impact or too large for a narrow one. The cause belongs in the diagnosis and the postmortem, not in the impact criteria.",
    followUps: [
      "What if the cause is known before triage?",
      "How do you keep the cause out of the severity discussion?",
      "Which impact dimensions matter most?",
    ],
    redFlags: [
      "Says a database issue is always severe.",
      "Uses the fix effort as severity.",
      "Waits for diagnosis before sizing the response.",
    ],
    rubric: [
      "Separates cause from impact.",
      "Explains blast radius variation.",
      "Sizes response before certainty.",
      "Keeps cause in diagnosis.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "A written severity matrix maps impact, scope, duration, and data exposure to response levels.",
      "Each severity names its paging policy, communication cadence, and decision authority.",
      "Responders have practiced classifying ambiguous examples.",
      "The paging tool can change severity and policy without a new incident.",
      "The status page and support have a severity-linked communication path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Classify from impact, not from the suspected cause.",
      "State the uncertainty and set a time to re-evaluate.",
      "Raise paging, communications, and authority when the impact level rises.",
      "Record the old severity, new severity, evidence, and time.",
      "Tell every audience what changed when the severity changes.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare the initial severity with the final impact.",
      "Find the signal that would have revealed the scope earlier.",
      "Review disagreements between teams and update the matrix examples.",
      "Check whether over-classification caused unnecessary paging.",
    ],
  },
];

const references = [
  {
    title: "Incident Response: Severity Levels",
    url: "https://response.pagerduty.com/before/severity_levels/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Severity levels, impact criteria, and how severity shapes the response.",
  },
  {
    title: "During an Incident",
    url: "https://response.pagerduty.com/during/during_an_incident/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Response actions and communication during an active incident.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident command, roles, and coordination under pressure.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "severity-levels": {
      model: severityLevelsModel,
      presets,
      instructions:
        "Start Healthy, apply Under-classified, and compare the two severity numbers. Then apply SEV1, late page to separate classification from paging speed. Change criteria coverage and watch the mismatch close.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Severity bands and impact scores are teaching values, not universal incident policy. One simulated second represents one incident minute.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["reliability-incident-command", "reliability-escalation", "reliability-roles"],
};
