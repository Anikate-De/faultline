import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "controlDesign",
    label: "Controls designed for the criteria",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Design",
    help: "Share of in-scope controls that address the selected trust services criteria and the system described in the report. A control that exists but does not map to a criterion is hard to test and hard to explain.",
    format: "percent" as const,
  },
  {
    id: "evidenceAutomation",
    label: "Controls producing evidence continuously",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Evidence",
    help: "Share of controls whose operation is recorded by a system of record, such as a ticket, a log, a policy engine, or a deployment record. Screenshot collections are not continuous evidence.",
    format: "percent" as const,
  },
  {
    id: "evidenceAgeDays",
    label: "Age of the oldest evidence",
    min: 1,
    max: 180,
    step: 1,
    value: 7,
    unit: " days",
    group: "Evidence",
    help: "Days since the oldest evidence sample was captured. Freshness is separate from coverage: a control can run everywhere and still have stale proof.",
    format: "count" as const,
  },
  {
    id: "exceptionClosure",
    label: "Exceptions closed within the window",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Remediation",
    help: "Share of findings and exceptions closed within the remediation window the team committed to. An open exception can appear in the report even when the underlying control mostly works.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  controlDesign: number;
  evidenceAutomation: number;
  evidenceAge: number;
  exceptionClosure: number;
  floor: number;
  evidenceGap: number;
  designGap: number;
  controlGap: number;
  exceptionGap: number;
}

function compute(p: Params): Computed {
  const controlDesign = clamp(num(p, "controlDesign", 100), 0, 100);
  const evidenceAutomation = clamp(num(p, "evidenceAutomation", 100), 0, 100);
  const evidenceAge = Math.round(clamp(num(p, "evidenceAgeDays", 7), 1, 180));
  const exceptionClosure = clamp(num(p, "exceptionClosure", 100), 0, 100);
  const floor = Math.min(controlDesign, evidenceAutomation);
  return {
    controlDesign,
    evidenceAutomation,
    evidenceAge,
    exceptionClosure,
    floor,
    evidenceGap: 100 - evidenceAutomation,
    designGap: 100 - controlDesign,
    controlGap: 100 - controlDesign,
    exceptionGap: 100 - exceptionClosure,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const evidenceHealth = healthFor(values.evidenceGap, 10, 40);
  const controlHealth = healthFor(values.controlGap, 10, 40);
  const sampleHealth = healthFor(values.evidenceAge, 30, 90);
  const exceptionHealth = healthFor(values.exceptionGap, 20, 50);
  const auditorGap = Math.max(values.designGap, values.evidenceGap, values.exceptionGap);
  return {
    t: 0,
    nodes: [
      {
        id: "criteria",
        label: "Trust criteria in scope",
        kind: "service",
        health: "ok",
        utilization: 0.5,
        sublabel: "security plus selected criteria",
        detail: "Security is always in scope. Availability, processing integrity, confidentiality, and privacy are selected based on the system and the customer commitments.",
      },
      {
        id: "control",
        label: "Control design",
        kind: "service",
        health: controlHealth,
        utilization: values.controlGap / 100,
        sublabel: `${values.controlDesign.toFixed(0)}% of criteria covered`,
        detail: "The control has to address the criterion and the system described in the report. A policy statement without an operating mechanism is a design gap.",
      },
      {
        id: "evidence",
        label: "Evidence pipeline",
        kind: "storage",
        health: evidenceHealth,
        utilization: values.evidenceGap / 100,
        sublabel: `${values.evidenceAutomation.toFixed(0)}% captured continuously`,
        detail: "The system of record that proves the control operated: tickets, logs, access reviews, deployment records, and approvals. Evidence should be generated by normal work.",
      },
      {
        id: "sample",
        label: "Auditor sample",
        kind: "worker",
        health: sampleHealth,
        utilization: values.evidenceAge / 180,
        sublabel: `oldest sample ${values.evidenceAge} days old`,
        detail: "The auditor tests a sample across the period. Stale evidence cannot prove that the control operated recently or that it covers a system added after the last export.",
      },
      {
        id: "auditor",
        label: "Independent auditor",
        kind: "external",
        health: healthFor(auditorGap, 10, 40),
        utilization: auditorGap / 100,
        sublabel: "tests controls and reports exceptions",
        detail: "The CPA firm tests the controls and issues the report. The report can include exceptions; an exception is a finding about the period, not proof that every control failed.",
      },
      {
        id: "exception",
        label: "Exception remediation",
        kind: "worker",
        health: exceptionHealth,
        utilization: values.exceptionGap / 100,
        sublabel: `${values.exceptionClosure.toFixed(0)}% closed in window`,
        detail: "The workflow that owns findings, fixes them, and keeps the evidence. An open exception at period end can appear in the report even when the team is working on it.",
      },
    ],
    edges: [
      edge("criteria-control", "criteria", "control", 1, controlHealth),
      edge("control-evidence", "control", "evidence", clamp(values.controlDesign / 100), evidenceHealth),
      edge("evidence-sample", "evidence", "sample", clamp(values.evidenceAutomation / 100), sampleHealth),
      edge("sample-auditor", "sample", "auditor", clamp(values.controlDesign / 100), healthFor(auditorGap, 10, 40)),
      edge("control-exception", "control", "exception", clamp(values.exceptionClosure / 100), exceptionHealth),
    ],
    metrics: [
      metric("evidence-gap", "Controls without operating evidence", values.evidenceGap, "%", 10, 40, "percent"),
      metric("design-gap", "Criteria without a designed control", values.designGap, "%", 10, 40, "percent"),
      metric("evidence-age", "Oldest evidence sample", values.evidenceAge, " days", 30, 90, "count"),
      metric("exception-gap", "Exceptions open past the window", values.exceptionGap, "%", 20, 50, "percent"),
      metric("assurance-floor", "Control and evidence floor", values.floor, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `The control and evidence floor is ${values.floor.toFixed(0)}%; ${values.evidenceGap.toFixed(0)}% of controls lack operating evidence; the oldest sample is ${values.evidenceAge} days old; ${values.exceptionGap.toFixed(0)}% of exceptions are open past the window.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "design-gap",
    metricId: "design-gap",
    warn: 10,
    crit: 40,
    title: "A trust criterion has no designed control",
    cause:
      "A criterion without a designed control has no mechanism to test. The gap is separate from operating evidence: a well-designed control can fail to produce evidence, and a missing control can produce no evidence because there is nothing to run. The assurance floor combines both, but the remediation is different.",
    fix:
      "Map every in-scope criterion to a control, an owner, and a system of record. If no control exists, design one and add it to the control matrix before the period starts. Reconcile the matrix with the system description so a new service does not enter the report without a control.",
    checkFirst: [
      "Which in-scope criterion has no control or no owner?",
      "Is the control missing, or is it present but not mapped to the criterion?",
      "Does the system description include a service that the control matrix omits?",
    ],
  },
  {
    id: "evidence-gap",
    metricId: "evidence-gap",
    warn: 10,
    crit: 40,
    title: "A control exists but has no operating evidence",
    cause:
      "A control described in a policy is a design claim. The audit tests whether it operated during the period, which requires a record from the system that ran it. A control with no evidence is not proven, and a control that covers only part of the system leaves the rest outside the report's description.",
    fix:
      "Map each criterion to a control and a system of record, then generate evidence as a byproduct of the work. Automate the export, assign an owner, and test a sample from the same source the auditor will use. A screenshot is a fallback, not a pipeline.",
    checkFirst: [
      "Which control has no evidence from the audit period?",
      "Does the evidence come from the system that operated the control, or from a later summary?",
      "Does the control cover every system in the report's description?",
    ],
  },
  {
    id: "evidence-age",
    metricId: "evidence-age",
    warn: 30,
    crit: 90,
    title: "The evidence is too old to prove the control operated",
    cause:
      "A sample from last quarter cannot show that access was reviewed this quarter, that changes were approved after a new system was added, or that a backup restore still works. Freshness is a separate property from coverage, and it is the one that fails when evidence is collected manually at audit time.",
    fix:
      "Capture evidence on a schedule from the system of record, timestamp it, and retain it for the audit period. Re-capture after a material change to identity, infrastructure, or the control itself. Test the newest and oldest samples in the period.",
    checkFirst: [
      "When was the oldest sample in the period captured?",
      "Did a material change happen after that sample?",
      "Is the evidence a live export or a manually assembled pack?",
    ],
  },
  {
    id: "exception-gap",
    metricId: "exception-gap",
    warn: 20,
    crit: 50,
    title: "Exceptions are open past the remediation window",
    cause:
      "An exception is a control that did not operate as described for part of the period, or a test that found a deviation. Leaving it open turns a small operational issue into a report finding, and it can change how a customer reads the report even when the rest of the control set is strong.",
    fix:
      "Give every exception an owner, a severity, a due date, and a closure test. Track the aging weekly, escalate when the window is at risk, and keep the remediation evidence with the finding. If the exception cannot close before period end, document the compensating control and the customer impact.",
    checkFirst: [
      "Which exceptions are open past their due date?",
      "Does each one have an owner and a closure test?",
      "Is there a compensating control, and is it evidenced?",
    ],
  },
];

export const soc2Model: SimModel = {
  id: "compliance-soc2",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.evidenceGap >= 40 && frame.flags.evidenceEvent !== 1) {
      pushEvent(next, {
        id: "control-without-evidence",
        at: frame.t,
        severity: "crit",
        title: "A control exists but has no operating evidence",
        detail: `The control and evidence floor is ${values.floor.toFixed(0)}%. ${values.evidenceGap.toFixed(0)}% of controls lack operating evidence, the oldest sample is ${values.evidenceAge} days old, and ${values.exceptionGap.toFixed(0)}% of exceptions are open past the window.`,
        nodeId: "evidence",
        metricId: "evidence-gap",
      });
      next.flags.evidenceEvent = 1;
    }
    if (values.evidenceGap < 40) next.flags.evidenceEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `The control and evidence floor is ${values.floor.toFixed(0)}%; ${values.evidenceGap.toFixed(0)}% of controls lack operating evidence; the oldest sample is ${values.evidenceAge} days old; ${values.exceptionGap.toFixed(0)}% of exceptions are open past the window.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The control and evidence floor is ${values.floor.toFixed(0)}%, the weaker of control design and continuous evidence. It is an assurance summary, not a substitute for the two separate gaps below.`,
      `${values.designGap.toFixed(0)}% of criteria lack a designed control, and ${values.evidenceGap.toFixed(0)}% of controls lack operating evidence. A design gap means there is nothing to run; an evidence gap means the control may have run but cannot be proven.`,
      `The oldest sample is ${values.evidenceAge} days old. Freshness matters because a material change after the sample can leave the newest system outside the evidence.`,
      `${values.exceptionGap.toFixed(0)}% of exceptions are open past the window. An exception can appear in the report; it does not mean every control failed, but it does change how a customer reads the assurance.`,
      "SOC 2 is an attestation report under the AICPA trust services criteria, not a certification. The percentages and the 10/40 design and evidence, 30/90 age, and 20/50 exception thresholds are illustrative teaching values.",
    ];
  },
  legend: [
    { label: "Evidenced", tone: "ok" },
    { label: "Gap", tone: "warn" },
    { label: "Unproven", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Controls cover the selected criteria, evidence is continuous and fresh, and exceptions close inside the remediation window.",
    tone: "ok",
    params: defaults({ controlDesign: 100, evidenceAutomation: 100, evidenceAgeDays: 7, exceptionClosure: 100 }),
  },
  {
    id: "peak",
    label: "Audit season",
    description: "Most controls are designed, some evidence is still manual, one sample is six weeks old, and two exceptions are near their due date.",
    tone: "warn",
    params: defaults({ controlDesign: 95, evidenceAutomation: 85, evidenceAgeDays: 45, exceptionClosure: 80 }),
  },
  {
    id: "failure",
    label: "Policy only",
    description: "The policy is complete, but most controls have no operating evidence, the oldest sample is four months old, and most exceptions are open.",
    tone: "crit",
    params: defaults({ controlDesign: 70, evidenceAutomation: 20, evidenceAgeDays: 120, exceptionClosure: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Controls map to the criteria, evidence is automated and current, and exceptions close within the window.",
    tone: "ok",
    params: defaults({ controlDesign: 100, evidenceAutomation: 100, evidenceAgeDays: 7, exceptionClosure: 100 }),
  },
  {
    id: "paper-control",
    label: "Documented only",
    description: "Every control is written down, but none produces operating evidence and the sample is stale. The policy looks complete and the report is unsupported.",
    tone: "crit",
    params: defaults({ controlDesign: 100, evidenceAutomation: 0, evidenceAgeDays: 120, exceptionClosure: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-policy",
  title: "Predict whether a documented control is evidence",
  simId: "soc2",
  question:
    "A control is fully documented in policy, and the team says it has been followed for years. There are no tickets, logs, or review records showing it operated during the audit period. Will the auditor treat it as an operating control?",
  prediction: {
    options: [
      { id: "yes-policy", label: "Yes. The policy is detailed and the team confirms it" },
      { id: "no-evidence", label: "No. The auditor needs evidence that the control operated during the period" },
      { id: "yes-screenshot", label: "Yes, if someone takes a screenshot of the policy" },
      { id: "no-design", label: "No, but only because the control is poorly designed" },
    ],
    correctOptionId: "no-evidence",
    explanation:
      "A documented control is a design claim. The audit tests operation, which requires evidence from the period: a review record, a ticket, a log, an approval, or a configuration export. A policy screenshot proves that the document exists, not that the control ran. Without evidence the control may be treated as not operating, or the gap may appear as an exception.",
  },
  setup: defaults({ controlDesign: 100, evidenceAutomation: 0, evidenceAgeDays: 120, exceptionClosure: 100 }),
  runFor: 20,
  observe: [
    "The control and evidence floor is 0% because no control produces operating evidence.",
    "The evidence and sample nodes fail while the exception node stays healthy.",
    "The oldest sample is 120 days, crossing the critical freshness threshold.",
    "The auditor node fails on the evidence gap even though every control is documented.",
  ],
  explain:
    "SOC 2 reports on controls over a period. The auditor selects a population, samples it, and tests whether the control operated as described. Evidence has to come from the system that ran the control: an access review export, a change ticket, a deployment record, a log query, or a signed approval. The policy explains the intent; the evidence shows the operation. A team that only has the policy has a design without proof.",
  fix: defaults({ controlDesign: 100, evidenceAutomation: 100, evidenceAgeDays: 7, exceptionClosure: 100 }),
  debrief:
    "With continuous evidence and a current sample, the same controls now support the report. The fix was not more documentation; it was making normal work produce attributable records. This module is engineering education, not audit or legal advice. The scope, the trust criteria, the sampling approach, and the report wording belong with the auditor and the compliance owner.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "SOC 2 is an attestation report about a service organization's controls, issued under the AICPA Trust Services Criteria and prepared by an independent CPA firm. It is not a certification and it is not a security score. The report describes the system, the controls the organization designed, the tests the auditor performed, and the results, including any exceptions. Customers use it to evaluate how a vendor manages risk over a period.",
  },
  {
    type: "p",
    text: "The trust services criteria are security, availability, processing integrity, confidentiality, and privacy. Security is always in scope; the others are selected based on the service and the commitments the organization makes. A Type I report covers the suitability of the design at a point in time. A Type II report covers design and operating effectiveness over a period, which is why evidence from the period matters so much.",
  },
  {
    type: "p",
    text: "For engineers, the practical question is not which framework logo to display. It is which control supports each criterion, which system records that the control ran, and whether the record is fresh enough to sample. A control that exists in policy but leaves no operating evidence is a design without proof. That is the failure this module models.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The audit path runs from the criterion to the control, from the control to its evidence, and from the evidence to the auditor's sample. The system of record is usually a tool the team already uses: an identity provider for access reviews, a ticketing system for change approval, a deployment pipeline for release evidence, a logging platform for monitoring, and a backup system for restore tests. The compliance program should not create a second, manual source of truth at audit time.",
  },
  {
    type: "table",
    headers: ["Criterion", "Example engineering control", "Evidence from the period"],
    rows: [
      ["Security", "Role-based access with periodic review", "Review export, approver, removed accounts"],
      ["Availability", "Capacity monitoring and incident response", "Alert history, incident records, postmortems"],
      ["Processing integrity", "Input validation and reconciliation", "Reconciliation reports, exception logs"],
      ["Confidentiality", "Encryption and data classification", "Configuration export, key policy, access list"],
      ["Privacy", "Retention and consent enforcement", "Deletion records, policy engine logs"],
    ],
  },
  {
    type: "p",
    text: "The model keeps the assurance floor as the weaker of control design and continuous evidence, but it measures the two gaps separately. It also tracks freshness and exception closure. Those are distinct because a control can be missing, can exist without evidence, or can be fully evidenced and still produce a finding if the sample is stale or an exception stays open past the committed window.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Criteria without a designed control: the share of the report scope that has no operating mechanism to test.",
      "Controls without operating evidence: the share of designed controls that cannot be proven for the period.",
      "Oldest evidence sample: the freshness gap, measured in days.",
      "Exceptions open past the window: findings without a closed remediation path.",
      "Control and evidence floor: the weaker of design coverage and continuous evidence.",
      "Node states: criteria, control design, evidence pipeline, sample, auditor, and exception remediation show where the report is unsupported.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Audit season and watch freshness and exception aging diverge from control coverage. Apply Policy only and compare the well-designed control node with the failing evidence and sample nodes. Run the experiment before revealing the explanation, then apply Documented only and Recovery.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not audit or legal advice. The scope, the trust services criteria, the control description, the sampling method, and the report language are decisions for the auditor and the compliance owner. Use the model to design evidence capture, then validate the program with a qualified professional.",
  },
  { type: "sim", simId: "soc2" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The controls were designed, but the evidence pipeline was empty. The floor fell to zero because no control produced operating evidence, and the oldest sample was four months old. The exception node stayed healthy, which is a useful reminder that remediation quality does not compensate for missing proof that the control ran.",
  },
  {
    type: "p",
    text: "Automating evidence and capturing a current sample raised the floor without changing the control design. The same access review, change approval, and monitoring controls were now testable. The lesson is that the audit is a read of normal operations, not a separate project that starts when the auditor arrives.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A control matrix that maps each criterion to a control, an owner, and a system of record.",
      "Evidence exports with timestamps, scope, and the period they cover.",
      "Access reviews, change approvals, and deployment records that are generated by the normal workflow.",
      "A sample test that pulls the same record the auditor will inspect.",
      "An exception register with severity, owner, due date, closure test, and compensating control.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List the trust criteria in scope and the controls that support each one.",
      "Find the system of record for every control and confirm it captures the actor, action, time, and outcome.",
      "Check the oldest sample and whether a material change happened after it.",
      "Review open exceptions, their due dates, and their compensating controls.",
      "Test one control end to end from the system of record to the report sample.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Map each criterion to a control, an owner, and a system of record.",
      "Replace manual screenshot collection with an export from the system that runs the control.",
      "Timestamp evidence and retain it for the audit period.",
      "Re-capture after material changes to identity, infrastructure, or the control.",
      "Track exceptions with an owner, due date, closure test, and compensating control.",
      "Run a dry sample with the same query the auditor will use.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Continuous evidence is more trustworthy and requires engineering time; manual collection is cheaper until the period or scope changes.",
      "A broad control set covers more criteria and increases audit effort; a narrow set is easier to test and may leave a customer commitment unsupported.",
      "Longer evidence retention supports the audit period and costs storage; the right window comes from the report period and the contract.",
      "Strict exception closure protects the report and can slow delivery; accepting an exception is sometimes the honest choice if it is documented.",
      "A central compliance platform improves evidence and adds a dependency; native exports from existing systems are simpler and may be harder to normalize.",
      "A Type II report gives period coverage and takes longer than a Type I; a Type I is faster and does not prove operating effectiveness.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "criteria-map",
    question: "How would you map a service to SOC 2 trust services criteria?",
    difficulty: 2,
    hints: [
      "Security is always in scope.",
      "Start from the customer commitments and the system description.",
    ],
    answer:
      "I would start with the system description and the commitments the service makes: uptime, confidentiality, data handling, and privacy. Security is always in scope; availability, processing integrity, confidentiality, and privacy are selected where the service makes those commitments. Then I would map each criterion to controls that already exist, name the system of record for each, and identify gaps. The output is a control matrix with owners and evidence, not a list of policies. The final scope decision belongs with the auditor and the compliance owner.",
    followUps: [
      "Which criterion is hardest to evidence for a data pipeline?",
      "How do you handle a criterion a customer asks for but the service does not support?",
      "What belongs in the system description?",
    ],
    redFlags: [
      "Treats all five criteria as mandatory for every service.",
      "Starts from a policy template.",
      "Lists controls without evidence sources.",
    ],
    rubric: [
      "Starts from commitments and system description.",
      "Knows security is always in scope.",
      "Maps controls to evidence.",
      "Defers scope to the auditor.",
    ],
  },
  {
    id: "operating-evidence",
    question: "What makes evidence good enough for a SOC 2 Type II audit?",
    difficulty: 3,
    hints: [
      "The evidence must come from the period and the system that ran the control.",
      "Attribution and freshness are part of the test.",
    ],
    answer:
      "Good evidence comes from the system of record, covers the audit period, and shows the actor, action, time, target, and outcome. It should be generated by the normal workflow, not assembled after the fact, and it should be fresh enough to cover the newest system and the latest change. A screenshot can be tampered with or stale; an export with a query, timestamp, and owner is stronger. I would also test the same sample the auditor will use and keep the chain from control to evidence to report.",
    followUps: [
      "How do you prove an export is complete?",
      "What do you do when the system of record only keeps 30 days?",
      "How do you handle evidence for a vendor-controlled control?",
    ],
    redFlags: [
      "Uses screenshots as the primary evidence.",
      "Has no timestamp or owner.",
      "Ignores retention and freshness.",
    ],
    rubric: [
      "Names the system of record.",
      "Covers the period.",
      "Shows attribution and outcome.",
      "Tests the sample chain.",
    ],
  },
  {
    id: "exception-meaning",
    question: "The SOC 2 report has an exception. What does that mean, and what do you do next?",
    difficulty: 3,
    hints: [
      "An exception is about a control or a test, not the whole report.",
      "The customer will read the description and the compensating control.",
    ],
    answer:
      "An exception means the auditor found a deviation from the control description, or the control did not operate as described for some part of the period. It does not automatically mean the service is insecure or that every control failed. I would read the exception, the affected period, the population, and any compensating control, then explain the customer impact honestly. Internally I would assign an owner, fix the control, add evidence, and decide whether the next report needs a revised description. The auditor and compliance owner own the report language; engineering owns the remediation.",
    followUps: [
      "When would you disclose an exception to a customer?",
      "How do you design a compensating control?",
      "What would make you delay the report?",
    ],
    redFlags: [
      "Treats an exception as a failed audit.",
      "Hides it from customers.",
      "Fixes the wording instead of the control.",
    ],
    rubric: [
      "Explains the scope of an exception.",
      "Reads period and population.",
      "Communicates impact.",
      "Remediates with evidence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the period",
    items: [
      "Define the system description and the trust criteria in scope.",
      "Map each criterion to a control, an owner, and a system of record.",
      "Confirm the evidence export covers the period and the full population.",
      "Set the exception remediation window and escalation path.",
    ],
  },
  {
    title: "During the period",
    items: [
      "Generate evidence as a byproduct of access reviews, changes, and operations.",
      "Timestamp every export and retain it for the audit period.",
      "Re-capture after material changes to identity, infrastructure, or controls.",
      "Track exception aging and compensating controls.",
    ],
  },
  {
    title: "Before the report",
    items: [
      "Run a dry sample with the auditor's query.",
      "Check the oldest and newest evidence against the period.",
      "Review open exceptions and their customer impact.",
      "Reconcile the control matrix with the system description.",
    ],
  },
];

const references = [
  {
    title: "SOC suite of services",
    url: "https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services",
    publisher: "AICPA and CIMA",
    kind: "standard" as const,
    note: "Official overview of SOC reports, including SOC 2 and the trust services criteria.",
  },
  {
    title: "2017 Trust Services Criteria for Security, Availability, Processing Integrity, Confidentiality, and Privacy",
    url: "https://www.aicpa-cima.com/resources/download/2017-trust-services-criteria-with-revised-points-of-focus-2022",
    publisher: "AICPA and CIMA",
    kind: "standard" as const,
    note: "The criteria and points of focus that structure a SOC 2 control set.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    soc2: {
      model: soc2Model,
      presets,
      instructions:
        "Start Healthy, then apply Audit season and compare control coverage with evidence freshness and exception aging. Apply Policy only and watch the evidence and sample nodes fail while control design stays high. Run the experiment before revealing the explanation, then apply Documented only and Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages, evidence ages, and the 10/40 design and evidence, 30/90 age, and 20/50 exception thresholds are teaching values, not audit criteria or a guarantee of report outcomes.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-audit-logs", "compliance-evidence", "compliance-iso27001"],
};
