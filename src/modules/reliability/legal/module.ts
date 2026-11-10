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

const HOURS_PER_SECOND = 1.2;
const DEADLINE_HOURS = 72;

const params: ParamSpec[] = [
  {
    id: "counselDelay",
    label: "Hours to legal engagement",
    min: 0,
    max: 48,
    step: 1,
    value: 2,
    unit: " h",
    group: "Engagement",
    help: "Hours from the first credible suspicion to a named legal and privacy contact joining the incident. The assessment clock starts at awareness, not at legal engagement.",
    format: "count",
  },
  {
    id: "evidencePreservation",
    label: "Evidence preserved",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Record",
    help: "Share of logs, snapshots, access records, and messages retained under a documented hold before rotation or cleanup removes them.",
    format: "percent",
  },
  {
    id: "disclosureControl",
    label: "Disclosure control",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Communications",
    help: "Share of external statements reviewed against known facts and counsel guidance. Uncontrolled disclosure can prejudice the investigation and mislead customers.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  counselDelay: number;
  evidence: number;
  disclosure: number;
  assessmentLag: number;
  deadlineConsumed: number;
  evidenceLoss: number;
  exposure: number;
  openObligations: number;
  hours: number;
}

function compute(p: Params, t: number): Values {
  const counselDelay = clamp(num(p, "counselDelay", 2), 0, 48);
  const evidence = clamp(num(p, "evidencePreservation", 95), 0, 100);
  const disclosure = clamp(num(p, "disclosureControl", 95), 0, 100);
  const hours = Math.max(0, t) * HOURS_PER_SECOND;
  const assessmentLag =
    counselDelay + (100 - evidence) * 0.18 + (100 - disclosure) * 0.12;
  const assessedHours = Math.min(hours, assessmentLag);
  const deadlineConsumed = clamp((assessedHours / DEADLINE_HOURS) * 100, 0, 100);
  const evidenceLoss =
    (100 - evidence) * (0.55 + Math.min(1, hours / 36) * 0.45);
  const exposure = clamp(
    (100 - disclosure) * 0.55 +
      (100 - evidence) * 0.35 +
      Math.max(0, counselDelay - 4) * 0.9 +
      hours * 0.12,
    0,
    100,
  );
  const openObligations = clamp(
    Math.round(
      (100 - disclosure) / 30 +
        (100 - evidence) / 25 +
        Math.max(0, counselDelay - 4) / 8,
    ),
    0,
    12,
  );
  return {
    counselDelay,
    evidence,
    disclosure,
    assessmentLag,
    deadlineConsumed,
    evidenceLoss,
    exposure,
    openObligations,
    hours,
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
  const v = compute(p, t);
  return {
    t,
    nodes: [
      {
        id: "signal",
        label: "Exposure signal",
        kind: "service",
        health: healthOf(v.exposure, 35, 60),
        utilization: clamp(0.3 + v.exposure / 120),
        sublabel: `${v.openObligations} open obligation(s)`,
        detail: "The first credible sign that personal, financial, health, or contractually protected data may be affected. It triggers assessment, not a conclusion.",
        meta: { view: "flow" },
      },
      {
        id: "counsel",
        label: "Legal and privacy counsel",
        kind: "mesh",
        health: healthOf(v.counselDelay, 4, 12),
        utilization: clamp(0.25 + v.counselDelay / 60),
        sublabel: v.counselDelay > 4 ? `engaged at T+${v.counselDelay}h` : "engaged early",
        detail: "Counsel decides whether an obligation is triggered, which jurisdictions apply, what may be said, and which records must be preserved. This is a parallel workstream, not a final approval step.",
        meta: { view: "flow" },
      },
      {
        id: "evidence",
        label: "Evidence hold",
        kind: "storage",
        health: healthOf(v.evidenceLoss, 15, 35),
        utilization: clamp(0.3 + v.evidenceLoss / 90),
        sublabel: `${v.evidenceLoss.toFixed(0)}% at risk`,
        detail: "Logs, snapshots, access records, and responder messages retained under a documented hold. Rotating them out makes the obligation record and the postmortem unverifiable.",
        meta: { view: "flow" },
      },
      {
        id: "register",
        label: "Obligation register",
        kind: "storage",
        health: healthOf(v.deadlineConsumed, 60, 85),
        utilization: clamp(v.deadlineConsumed / 100),
        sublabel: `${v.deadlineConsumed.toFixed(0)}% of window used`,
        detail: `A register of jurisdictions, recipients, decision owners, and dates. The ${DEADLINE_HOURS}-hour figure is a teaching example; real deadlines differ by regulation and jurisdiction.`,
        meta: { view: "flow" },
      },
      {
        id: "communications",
        label: "External communications",
        kind: "service",
        health: coverageHealth(v.disclosure, 80, 50),
        utilization: clamp(0.25 + (100 - v.disclosure) / 100),
        sublabel: v.disclosure >= 80 ? "reviewed against facts" : "speculative or uncontrolled",
        detail: "Support replies, status pages, and public statements. They must state known impact and next update without naming a cause, a person, or a provider before facts support it.",
        meta: { view: "flow" },
      },
      {
        id: "recipients",
        label: "Customers and regulators",
        kind: "external",
        health: v.deadlineConsumed >= 90 ? "crit" : v.deadlineConsumed >= 70 ? "warn" : "ok",
        utilization: clamp(v.deadlineConsumed / 100),
        sublabel: v.deadlineConsumed >= 85 ? "deadline exposure" : "within window",
        detail: "The parties who may need a notification and the regulator that may receive one. A missed deadline is a separate failure from the original incident.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("signal-counsel", "signal", "counsel", 1 - v.exposure / 120, healthOf(v.exposure, 35, 60)),
      edge("counsel-register", "counsel", "register", 1 - v.deadlineConsumed / 130, healthOf(v.deadlineConsumed, 60, 85)),
      edge("signal-evidence", "signal", "evidence", 1 - v.evidenceLoss / 120, healthOf(v.evidenceLoss, 15, 35)),
      edge("register-communications", "register", "communications", v.disclosure / 100, coverageHealth(v.disclosure, 80, 50)),
      edge("communications-recipients", "communications", "recipients", v.disclosure / 100, "ok"),
    ],
    metrics: [
      metric("obligation-exposure", "Obligation exposure", v.exposure, "%", 35, 60, "percent"),
      metric("evidence-loss", "Evidence at risk", v.evidenceLoss, "%", 15, 35, "percent"),
      metric("deadline-consumed", "Notification window used", v.deadlineConsumed, "%", 60, 85, "percent"),
      metric("counsel-delay", "Time to counsel", v.counselDelay, " h", 4, 12, "number"),
      metric("open-obligations", "Open obligations", v.openObligations, "", 3, 6, "count"),
    ],
    events: [
      {
        id: "legal-suspected",
        at: 0,
        severity: "info",
        title: "Possible data exposure declared",
        detail: `Counsel is engaged at T+${v.counselDelay}h. Evidence preservation is ${v.evidence.toFixed(0)}% and external disclosure control is ${v.disclosure.toFixed(0)}%. Assessment takes about ${v.assessmentLag.toFixed(0)} simulator hours.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `Obligation exposure ${v.exposure.toFixed(0)}%; ${v.deadlineConsumed.toFixed(0)}% of the notification window used; evidence at risk ${v.evidenceLoss.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 8;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.985 + 0.03 * Math.sin((index + phase) / 3.1))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "obligation-exposure",
    metricId: "obligation-exposure",
    warn: 35,
    crit: 60,
    title: "Legal exposure is being handled as a technical problem",
    cause:
      "The response is focused on restoring service while the question of data, contracts, and regulated information is unanswered. Every hour without counsel increases the chance that evidence is lost or a statement is made that cannot be defended.",
    fix:
      "Assign a legal and privacy liaison in the incident channel, start the obligation register, and document the facts known at the time. Keep the technical response running in parallel; do not wait for mitigation to begin the assessment.",
    checkFirst: [
      "Ask whether personal, financial, health, or contractually protected data could be involved.",
      "Check whether counsel is in the incident channel and who owns the obligation register.",
      "Check what has already been said to customers or posted publicly.",
    ],
  },
  {
    id: "evidence-loss",
    metricId: "evidence-loss",
    warn: 15,
    crit: 35,
    title: "Evidence needed for the obligation record is disappearing",
    cause:
      "Logs rotate, snapshots expire, and responders edit the systems they are investigating. Without a documented hold, the facts needed to scope the incident and support a notification decision are gone before anyone asks for them.",
    fix:
      "Issue a written preservation hold covering logs, snapshots, access records, deploy history, and incident-channel messages. Record the hold time and scope, and confirm that retention actually stops deletion.",
    checkFirst: [
      "Check the log retention window against the incident start time.",
      "Check whether a deploy or cleanup job has already truncated the relevant records.",
      "Check whether responders are editing evidence instead of copying it.",
    ],
  },
  {
    id: "deadline-consumed",
    metricId: "deadline-consumed",
    warn: 60,
    crit: 85,
    title: "The notification decision window is nearly consumed",
    cause:
      "Assessment waited for a confirmed root cause or a complete population count. The obligation clock runs from awareness of a possible reportable incident, so investigation time spent before counsel is engaged consumes the window.",
    fix:
      "Decide with the facts available, document the basis, and use a phased notification if the scope is still changing. Set a review point before the deadline rather than after it.",
    checkFirst: [
      "Check the timestamp of the first credible suspicion, not the first customer report.",
      "Check which jurisdictions and contract terms may apply.",
      "Check whether the decision owner is named and whether the record states why.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const legalModel: SimModel = {
  id: "reliability-legal",
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
    const v = compute(p, frame.t);
    if (v.hours >= v.counselDelay && frame.flags.legalEngaged !== 1) {
      pushEvent(next, {
        id: "legal-counsel-engaged",
        at: frame.t,
        severity: "info",
        title: "Legal and privacy counsel engaged",
        detail: `Counsel joined at T+${v.counselDelay.toFixed(0)}h. The obligation register and preservation hold are now the record of what was known and decided.`,
        nodeId: "counsel",
      });
      next.flags.legalEngaged = 1;
    }
    if (v.exposure >= 60 && frame.flags.legalExposure !== 1) {
      pushEvent(next, {
        id: "legal-exposure-critical",
        at: frame.t,
        severity: "crit",
        title: "Exposure is not contained by the technical response",
        detail: "Service may recover while the legal and privacy assessment is still absent. Check the obligation register and the preservation hold before closing the incident.",
        nodeId: "signal",
        metricId: "obligation-exposure",
      });
      next.flags.legalExposure = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `Obligation exposure is ${v.exposure.toFixed(0)}%. The technical fix does not answer whether data, contracts, or regulated information are affected.`,
      `Counsel is engaged at T+${v.counselDelay.toFixed(0)}h and assessment takes about ${v.assessmentLag.toFixed(0)}h. The notification window is ${DEADLINE_HOURS}h in this illustrative model.`,
      `${v.deadlineConsumed.toFixed(0)}% of the window is used. ${v.openObligations} obligation(s) remain open in the register.`,
      `Evidence at risk is ${v.evidenceLoss.toFixed(0)}%. Retention jobs do not wait for the investigation to finish.`,
    ];
  },
  legend: [
    { label: "Assessment running", tone: "ok" },
    { label: "Evidence at risk", tone: "warn" },
    { label: "Obligation exposed", tone: "crit" },
    { label: "Window missed", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Counsel is engaged within two hours, evidence is held, and external statements are reviewed.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Late and loose",
    description: "Counsel joins after eight hours, a third of the evidence is outside the hold, and some support replies speculate.",
    tone: "warn",
    params: defaults({ counselDelay: 8, evidencePreservation: 60, disclosureControl: 55 }),
  },
  {
    id: "failure",
    label: "No legal workstream",
    description: "Counsel is not engaged for two days, evidence is already rotating out, and support is improvising public statements.",
    tone: "crit",
    params: defaults({ counselDelay: 48, evidencePreservation: 15, disclosureControl: 10 }),
    elapsed: 12,
  },
  {
    id: "recovery",
    label: "Counsel in parallel",
    description: "A named counsel contact joins immediately, the hold is confirmed, and every external statement is reviewed.",
    tone: "ok",
    params: defaults({ counselDelay: 1, evidencePreservation: 100, disclosureControl: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-legal-first-move",
  title: "Predict the first legal move",
  simId: "legal",
  question:
    "At 02:00 a cache bug may have exposed customer profile data. The cause is not confirmed and the population is unknown. What should happen first?",
  prediction: {
    options: [
      {
        id: "counsel-evidence",
        label: "Engage legal and privacy counsel, start the obligation register, and preserve evidence",
      },
      { id: "root-cause", label: "Wait for the root cause before involving anyone outside engineering" },
      { id: "notify-all", label: "Publish a full breach notification to every customer immediately" },
      { id: "cleanup", label: "Delete suspicious records to reduce the amount of exposed data" },
    ],
    correctOptionId: "counsel-evidence",
    explanation:
      "The trigger is a credible possibility that protected data was affected, not a confirmed cause. Counsel determines which obligations apply and what may be said. A preservation hold keeps the facts needed to scope the incident. Deleting records destroys evidence, and a blanket notification before facts are known can be inaccurate and harmful.",
  },
  setup: defaults({ counselDelay: 30, evidencePreservation: 35, disclosureControl: 30 }),
  runFor: 30,
  observe: [
    "Obligation exposure is critical before the technical mitigation is complete.",
    "The notification window is consumed while the team waits for a confirmed cause.",
    "Evidence at risk rises as the response runs without a hold.",
    "External communications drift because no one owns the reviewed statement.",
  ],
  explain:
    "Legal work is a parallel incident workstream. The technical response restores service; the legal response determines what the organization must do about data, contracts, and regulated information. Waiting for root cause before engaging counsel consumes the window and lets evidence disappear. The two workstreams share facts through the incident channel, but neither blocks the other.",
  fix: defaults({ counselDelay: 1, evidencePreservation: 100, disclosureControl: 100 }),
  debrief:
    "With counsel engaged immediately, exposure falls even though the technical cause is still unknown. A preservation hold protects the facts, and reviewed statements keep the company from speculating. The tradeoff is coordination cost: counsel adds a second workstream, approval latency, and rules about what can be shared. That cost is bounded; a missed deadline or destroyed evidence is not.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Legal and compliance work during an incident is the parallel workstream that answers three questions: what data, contracts, or regulated information may be affected; what the organization must do about it; and what it may say while facts are still moving. It does not replace the technical response. It runs beside it, from the first credible suspicion.",
  },
  {
    type: "p",
    text: "The trigger is suspicion, not proof. A failed access-control change, a misdirected export, a lost laptop, or a logging gap can all require assessment. Counsel decides which jurisdictions and obligations apply, whether a notification is required, and what records must be kept. The incident commander keeps the technical response moving and makes sure the legal workstream has a named owner.",
  },
  {
    type: "p",
    text: "The two most common failures are structural. The first is treating legal as a final approval step, so the assessment starts after mitigation and the notification window has already been partly consumed. The second is treating evidence as ordinary operational data, so retention and cleanup remove exactly the records needed to scope the incident or defend the decision.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "This module sits inside incident command, after customer communications and before the compliance track's notification-timeline module. Incident command assigns the legal liaison. Customer communications controls what is said externally. The compliance module covers jurisdiction-specific deadline math; here the focus is getting counsel into the response early and keeping the record intact.",
  },
  {
    type: "table",
    headers: ["Signal", "Why counsel is needed", "What to do now"],
    rows: [
      ["Personal or health data may be in logs", "Privacy obligations and notification thresholds", "Preserve logs and open an obligation register"],
      ["A contractor system is involved", "Contract notice terms and liability", "Check the contract and name a contact"],
      ["A public statement is being drafted", "Accuracy and privilege risk", "Route it through counsel before posting"],
      ["Evidence is still being written", "Preservation duty and spoliation risk", "Issue a written hold and confirm retention"],
    ],
  },
  {
    type: "p",
    text: "The model compresses the first days of an incident into one minute. One simulated second represents about 1.2 hours. Exposure, evidence loss, and deadline consumption are illustrative teaching values, not a legal standard or advice.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Obligation exposure: how much of the legal assessment is still unanswered.",
      "Evidence at risk: records that retention or cleanup may remove.",
      "Notification window used: progress toward a decision deadline.",
      "Open obligations: jurisdictions and contract notices still unresolved.",
      "A flow view of the exposure signal, counsel, evidence hold, register, communications, and recipients.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply No legal workstream. Watch exposure and evidence risk move before the deadline meter. Run the experiment before reading the debrief, then engage counsel earlier and confirm the hold. The deadline figure is an example; the process is the lesson.",
  },
  {
    type: "compare",
    leftTitle: "Legal as a final gate",
    rightTitle: "Legal as a parallel workstream",
    rows: [
      { label: "Start", left: "After mitigation or a confirmed cause", right: "At the first credible suspicion" },
      { label: "Owner", left: "Whoever remembers to ask", right: "A named liaison in the incident channel" },
      { label: "Evidence", left: "Collected after cleanup", right: "Held under a documented preservation order" },
      { label: "Statements", left: "Improvising while facts change", right: "Reviewed against known facts and next update" },
    ],
  },
  { type: "sim", simId: "legal" },
  { type: "experiment", experimentId: "predict-legal-first-move" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The incident started as a cache bug. The team could see errors and a recovery path, so the technical work moved first. The legal work did not start because no one owned it. By the time counsel was engaged, the notification window was partly consumed, the hold had not been issued, and support had already described a cause to customers. The service recovered; the obligation record did not.",
  },
  {
    type: "p",
    text: "In the recovery run, counsel joined at the start and the register opened with the facts then known. Evidence was held before rotation. External statements were limited to impact and the next update. The technical response was not slower; it simply had a second workstream that prevented the incident from becoming a reporting failure.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Incident channel: engineering-only discussion with no legal or privacy participant.",
      "Obligation register: empty or created after the deadline, with no record of who decided what.",
      "Evidence: log retention already past the incident window; snapshots overwritten by a deploy.",
      "Customer support: agents improvising explanations and promising a root cause.",
      "Postmortem: unable to state the affected data categories or the basis for the notification decision.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask whether protected data could be involved, whether counsel is in the channel, and whether a preservation hold is confirmed. Then check the first credible suspicion time against the obligation register. If the register is empty, the incident is not being managed as a possible legal event.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Add a legal and privacy liaison role to the incident command template and name the person in the channel.",
      "Open an obligation register at declaration with jurisdictions, recipients, decision owner, and dates.",
      "Issue a written preservation hold covering logs, snapshots, access records, deploy history, and messages.",
      "Route every external statement through the communications owner and counsel; state impact and next update only.",
      "Decide with the facts available, document the basis, and schedule a review before the deadline.",
      "After the incident, test the process with a tabletop that includes a late-discovered data category.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Early counsel adds coordination and approval latency. The cost is visible and bounded; a missed deadline is not.",
      "Over-notification can be safer legally but harms customers and trust. Counsel must weigh accuracy and timeliness, not default to either.",
      "Privilege can protect the investigation but conflicts with transparency and customer communication. Decide what can be shared without exposing protected material.",
      "Preservation holds increase storage cost and slow cleanup. Scope them to the incident and lift them deliberately.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "when-legal",
    question: "When does an incident need legal and privacy counsel, and who decides?",
    difficulty: 2,
    hints: [
      "The trigger is suspicion, not confirmation.",
      "The incident commander owns the response; counsel owns the obligation assessment.",
    ],
    answer:
      "Counsel is needed as soon as there is a credible possibility that personal, financial, health, or contractually protected data is affected, or that a contractual or regulatory notice obligation may apply. The incident commander makes sure the liaison is engaged; counsel decides which obligations are triggered and what may be said. The decision to involve counsel should be written into the incident process so it does not depend on an engineer recognizing a legal issue at 03:00.",
    followUps: [
      "What if the data turns out not to be personal data?",
      "How do you handle a vendor that will not share its incident details?",
      "Who can declare that legal is not needed?",
    ],
    redFlags: [
      "Waits for a confirmed breach.",
      "Leaves the decision to whoever is on call.",
      "Treats counsel as a final approval step.",
    ],
    rubric: [
      "States the suspicion trigger.",
      "Names the owner.",
      "Separates technical and legal decisions.",
      "Mentions contracts and regulated data.",
    ],
  },
  {
    id: "preserve-evidence",
    question: "What evidence must be preserved in a possible data incident, and why is ordinary retention not enough?",
    difficulty: 3,
    hints: [
      "Think beyond application logs.",
      "Retention policies are designed to delete.",
    ],
    answer:
      "Preserve application and access logs, database snapshots, object-storage access records, deploy and configuration history, identity-provider events, network flow records where available, and incident-channel messages. Ordinary retention is not enough because it is designed to expire data on a schedule, and responders may deploy or clean up the same systems they are investigating. A written hold with a scope, an owner, and a confirmation that deletion has stopped is what makes the record reliable.",
    followUps: [
      "How do you preserve messages without capturing unrelated personal data?",
      "What do you do if a vendor controls the logs?",
      "When can the hold be lifted?",
    ],
    redFlags: [
      "Says the logs are already retained.",
      "Deletes data to reduce exposure.",
      "Has no confirmation that the hold worked.",
    ],
    rubric: [
      "Lists multiple evidence sources.",
      "Explains retention conflict.",
      "Requires a written hold.",
      "Addresses verification.",
    ],
  },
  {
    id: "missed-deadline",
    question:
      "The team confirms a reportable incident after the notification deadline has passed. What do you do?",
    difficulty: 3,
    hints: [
      "Do not hide the delay.",
      "The record of the decision matters as much as the notification.",
    ],
    answer:
      "Notify as soon as the obligation is confirmed, and document why the decision was late: when the first credible suspicion arose, what was known, who was engaged, and what caused the delay. Counsel decides whether the late notification can be phased and what must be said about the delay. Then fix the process that made awareness and assessment sequential: add the legal liaison to declaration, start the register at suspicion, and test the deadline path before the next incident.",
    followUps: [
      "Who communicates the delay to the regulator?",
      "What if the delay was caused by a vendor?",
      "How do you prevent the same gap next quarter?",
    ],
    redFlags: [
      "Suggests waiting for a complete investigation.",
      "Hides the delay.",
      "Blames an individual without changing the process.",
    ],
    rubric: [
      "Notifies promptly.",
      "Documents the basis.",
      "Separates legal and technical action.",
      "Fixes the process.",
    ],
  },
];

const checklist = [
  {
    title: "At declaration",
    items: [
      "Ask whether personal, financial, health, or contractually protected data could be involved.",
      "Name a legal and privacy liaison in the incident channel.",
      "Open the obligation register with jurisdictions, recipients, and decision owner.",
      "Issue a preservation hold and confirm that retention has stopped.",
    ],
  },
  {
    title: "During the response",
    items: [
      "Record the first credible suspicion time and the facts known at each decision.",
      "Route external statements through the communications owner and counsel.",
      "Track the deadline against the register, not against the mitigation estimate.",
      "Keep the technical response and the legal assessment as separate, parallel workstreams.",
    ],
  },
  {
    title: "At close",
    items: [
      "Confirm every open obligation has a decision and a documented basis.",
      "Verify that the evidence hold captured the systems that mattered.",
      "Review what was said externally against what was known at the time.",
      "Add the legal workstream to the postmortem and test it in the next exercise.",
    ],
  },
];

const references = [
  {
    title: "Article 33: Notification of a personal data breach to the supervisory authority",
    url: "https://gdpr-info.eu/art-33-gdpr/",
    publisher: "GDPR.eu",
    kind: "standard" as const,
    note: "The 72-hour notification expectation and the role of the controller's assessment.",
  },
  {
    title: "Breach Notification Rule",
    url: "https://www.hhs.gov/hipaa/for-professionals/breach-notification/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "standard" as const,
    note: "HIPAA breach notification requirements and the factors used to assess risk.",
  },
  {
    title: "SP 800-61 Rev. 2: Computer Security Incident Handling Guide",
    url: "https://csrc.nist.gov/pubs/sp/800/61/r2/final",
    publisher: "NIST",
    kind: "docs" as const,
    note: "Incident handling phases, evidence handling, and coordination with legal and public affairs.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    legal: {
      model: legalModel,
      presets,
      instructions:
        "Start Healthy, then apply No legal workstream. Watch obligation exposure and evidence risk before the deadline meter. Run the experiment, then engage counsel earlier and confirm the preservation hold.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents about 1.2 hours; exposure, evidence, and deadline values are teaching assumptions, not legal advice.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "compliance-incident-notification",
    "reliability-customer-comms",
    "reliability-incident-command",
    "reliability-decision-logs",
  ],
};
