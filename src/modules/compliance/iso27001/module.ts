import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "riskCoverage",
    label: "Risks assessed and owned",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Risk process",
    help: "Share of in-scope information risks that have a current assessment, a named owner, and an agreed risk score. An unowned risk cannot be treated or reviewed.",
    format: "percent" as const,
  },
  {
    id: "treatmentCoverage",
    label: "High risks with approved treatment",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Risk process",
    help: "Share of high risks with an approved treatment decision: a control, a transfer, an avoidance, or a documented acceptance with an owner and a review date.",
    format: "percent" as const,
  },
  {
    id: "improvementClosure",
    label: "Findings closed on schedule",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Improvement",
    help: "Share of audit findings and corrective actions closed within the committed window. A management system that does not close findings has no continual improvement.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  risk: number;
  treatment: number;
  closure: number;
  riskGap: number;
  treatmentGap: number;
  closureGap: number;
  floor: number;
  systemGap: number;
}

function compute(p: Params): Computed {
  const risk = clamp(num(p, "riskCoverage", 100), 0, 100);
  const treatment = clamp(num(p, "treatmentCoverage", 100), 0, 100);
  const closure = clamp(num(p, "improvementClosure", 100), 0, 100);
  const riskGap = 100 - risk;
  const treatmentGap = 100 - treatment;
  const closureGap = 100 - closure;
  const floor = Math.min(risk, treatment, closure);
  return {
    risk,
    treatment,
    closure,
    riskGap,
    treatmentGap,
    closureGap,
    floor,
    systemGap: 100 - floor,
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
  return {
    t: 0,
    nodes: [
      {
        id: "scope",
        label: "ISMS scope",
        kind: "service",
        health: healthFor(values.riskGap, 15, 40),
        utilization: values.riskGap / 100,
        sublabel: `${values.risk.toFixed(0)}% of risks assessed and owned`,
        detail: "The systems, locations, and information the management system covers. Scope is a decision, not a diagram label.",
      },
      {
        id: "register",
        label: "Risk register",
        kind: "db",
        health: healthFor(values.riskGap, 15, 40),
        utilization: values.riskGap / 100,
        sublabel: `${values.riskGap.toFixed(0)}% of risks lack an owner or assessment`,
        detail: "Each risk has a scenario, an owner, a score, and a review date. A register without owners is a list, not a process.",
      },
      {
        id: "treatment",
        label: "Treatment plan",
        kind: "mesh",
        health: healthFor(values.treatmentGap, 15, 40),
        utilization: values.treatmentGap / 100,
        sublabel: `${values.treatment.toFixed(0)}% of high risks treated or accepted`,
        detail: "A treatment decision names the chosen option, the control, the residual risk, the approver, and the completion date.",
      },
      {
        id: "owners",
        label: "Control ownership",
        kind: "mesh",
        health: healthFor(values.treatmentGap, 15, 40),
        utilization: values.treatmentGap / 100,
        sublabel: `${values.treatmentGap.toFixed(0)}% of treated risks lack a control owner`,
        detail: "Treatments fail when nobody owns the control that implements them or the evidence that shows it operates.",
      },
      {
        id: "audit",
        label: "Internal audit",
        kind: "storage",
        health: healthFor(values.closureGap, 20, 50),
        utilization: values.closureGap / 100,
        sublabel: `${values.closure.toFixed(0)}% of findings closed on schedule`,
        detail: "An independent check that the management system operates as described, with findings that have owners and dates.",
      },
      {
        id: "review",
        label: "Management review",
        kind: "service",
        health: healthFor(values.closureGap, 20, 50),
        utilization: values.closureGap / 100,
        sublabel: `${values.closureGap.toFixed(0)}% of corrective actions open or late`,
        detail: "A recorded review of risk, performance, incidents, and findings that changes priorities and resources.",
      },
    ],
    edges: [
      edge("scope-register", "scope", "register", clamp(values.risk / 100), healthFor(values.riskGap, 15, 40)),
      edge("register-treatment", "register", "treatment", clamp(values.treatment / 100), healthFor(values.treatmentGap, 15, 40)),
      edge("treatment-owners", "treatment", "owners", clamp(values.treatment / 100), healthFor(values.treatmentGap, 15, 40)),
      edge("owners-audit", "owners", "audit", clamp(values.closure / 100), healthFor(values.closureGap, 20, 50)),
      edge("audit-review", "audit", "review", clamp(values.closure / 100), healthFor(values.closureGap, 20, 50)),
    ],
    metrics: [
      metric("management-gap", "Management-system gap", values.systemGap, "%", 20, 45, "percent"),
      metric("treatment-gap", "High risks without approved treatment", values.treatmentGap, "%", 15, 40, "percent"),
      metric("risk-gap", "Risks without owner or assessment", values.riskGap, "%", 15, 40, "percent"),
      metric("finding-gap", "Findings open or late", values.closureGap, "%", 20, 50, "percent"),
      metric("system-floor", "Management-system floor", values.floor, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `The management-system floor is ${values.floor.toFixed(0)}%; ${values.treatmentGap.toFixed(0)}% of high risks lack an approved treatment and ${values.closureGap.toFixed(0)}% of findings are open or late.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "management-gap",
    metricId: "management-gap",
    warn: 20,
    crit: 45,
    title: "The management system is not covering its risks",
    cause:
      "The floor is the weakest of risk assessment and ownership, approved treatment, and closure of findings. A complete policy library does not compensate for a high risk that has no owner, no treatment decision, and no review. ISO 27001 is a management system: the plan, the operation, the check, and the improvement all have to exist.",
    fix:
      "Start from the highest untreated risk. Assign an owner, record a treatment decision with residual risk and an approver, set a completion date, and track it through internal audit and management review. Repeat until every high risk has an owner and an approved decision.",
    checkFirst: [
      "Which high risk has no named owner or no approved treatment?",
      "Is the treatment recorded in the risk register or only discussed in a meeting?",
      "Who approves residual risk, and when was it last reviewed?",
    ],
  },
  {
    id: "treatment-gap",
    metricId: "treatment-gap",
    warn: 15,
    crit: 40,
    title: "High risks are accepted without a decision",
    cause:
      "A risk that is known but untreated is not managed. Common causes are a register that stopped at assessment, treatment options that were never approved, and controls that were planned but never assigned. The gap grows when findings are not closed, because the same risks keep returning.",
    fix:
      "For each high risk, choose one treatment option and record the control, the residual risk, the approver, and the date. Give the control an owner and an evidence source. Review accepted risks on a fixed cadence and escalate any acceptance that exceeds the stated tolerance.",
    checkFirst: [
      "Does every high risk have a treatment option, not just a score?",
      "Is residual risk approved by someone with authority to accept it?",
      "Do corrective actions from the last audit map back to open risks?",
    ],
  },
];

export const iso27001Model: SimModel = {
  id: "compliance-iso27001",
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
    if (values.systemGap >= 45 && frame.flags.treatmentEvent !== 1) {
      pushEvent(next, {
        id: "untreated-high-risk",
        at: frame.t,
        severity: "crit",
        title: "A high risk has no approved treatment or owner",
        detail: `The management-system floor is ${values.floor.toFixed(0)}%. ${values.treatmentGap.toFixed(0)}% of high risks lack an approved treatment. An audit can sample the register and find a risk that was assessed but never decided.`,
        nodeId: "treatment",
        metricId: "management-gap",
      });
      next.flags.treatmentEvent = 1;
    }
    if (values.systemGap < 45) next.flags.treatmentEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `The management-system floor is ${values.floor.toFixed(0)}%; ${values.treatmentGap.toFixed(0)}% of high risks lack an approved treatment and ${values.closureGap.toFixed(0)}% of findings are open or late.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const axes = [
      { label: "risk assessment and ownership", value: values.risk },
      { label: "approved treatment", value: values.treatment },
      { label: "findings closed on schedule", value: values.closure },
    ].sort((a, b) => a.value - b.value);
    const weakest = axes.filter((axis) => axis.value === values.floor).map((axis) => axis.label);
    return [
      values.systemGap === 0
        ? "Every risk is assessed, owned, and treated, and findings are closed. The management-system floor is 100%."
        : `The floor is ${values.floor.toFixed(0)}% because ${weakest.join(" and ")} ${weakest.length === 1 ? "is" : "are"} weakest. A strong policy library does not raise this floor.`,
      `${values.treatmentGap.toFixed(0)}% of high risks lack an approved treatment. That is the sample an auditor is most likely to pull, because it tests whether risk assessment changes decisions.`,
      `Findings closed on schedule: ${values.closure.toFixed(0)}%. Continual improvement is demonstrated by corrective action records, not by a statement that the team improves.`,
      "The standard requires a management system with a risk process, documented decisions, performance evaluation, and improvement. It does not prescribe a specific product or a fixed control list.",
      "Certification is an assessment outcome. The engineering job is to make the risk register, treatment decisions, and evidence current enough that an auditor can sample them.",
    ];
  },
  legend: [
    { label: "Managed", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Not managed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every risk has an owner, every high risk has an approved treatment, and findings close on schedule.",
    tone: "ok",
    params: defaults({ riskCoverage: 100, treatmentCoverage: 100, improvementClosure: 100 }),
  },
  {
    id: "peak",
    label: "Audit season",
    description: "Assessments and treatments cover most risks, but a fifth of findings are late and the treatment backlog is growing.",
    tone: "warn",
    params: defaults({ riskCoverage: 85, treatmentCoverage: 70, improvementClosure: 70 }),
  },
  {
    id: "failure",
    label: "Policies only",
    description: "Policies are signed and published. Most risks have no owner, high risks have no approved treatment, and findings stay open.",
    tone: "crit",
    params: defaults({ riskCoverage: 40, treatmentCoverage: 10, improvementClosure: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The register is owned, high risks have approved treatments with residual risk, and corrective actions are closing.",
    tone: "ok",
    params: defaults({ riskCoverage: 100, treatmentCoverage: 95, improvementClosure: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-treatment",
  title: "Predict whether a policy library is a management system",
  simId: "iso27001",
  question:
    "An organization has complete policies, an approved scope statement, and a risk register with scores. High risks have no owners and no treatment decisions. Is the management system conforming?",
  prediction: {
    options: [
      { id: "conforming", label: "Yes. The policies and risk register are the required documents" },
      { id: "not-conforming", label: "No. Risk treatment and ownership are part of the management system, not optional paperwork" },
      { id: "certification", label: "Yes. Certification only checks that documents exist" },
      { id: "it-only", label: "No, but only because the IT team has not signed the policies" },
    ],
    correctOptionId: "not-conforming",
    explanation:
      "ISO 27001 requires a risk-based management system: risks are assessed, treatment is chosen, controls are implemented, performance is evaluated, and the system improves. A scored register without owners or treatment decisions stops after assessment, so the organization cannot show that risk changed a decision.",
  },
  setup: defaults({ riskCoverage: 40, treatmentCoverage: 10, improvementClosure: 30 }),
  runFor: 20,
  observe: [
    "The management-system floor falls to 10% because approved treatment is the weakest axis.",
    "The treatment plan and control ownership nodes fail while the risk register still holds scores.",
    "The management-system gap crosses the critical threshold at 90%.",
    "Restoring policy text alone does nothing; the treatment preset is what raises the floor.",
  ],
  explain:
    "The audit question is not whether a risk was written down. It is whether the organization decided what to do about it, assigned someone to do it, and checked that the decision worked. A scored risk with no owner has no path to a control. A treatment without an approver has no accepted residual risk. A finding without a closure date has no improvement. Those are the links an auditor samples, and each one produces a record.",
  fix: defaults({ riskCoverage: 100, treatmentCoverage: 95, improvementClosure: 100 }),
  debrief:
    "With owners and approved treatments, the same risk register now supports a defensible management system: a risk, a decision, a control owner, and a route to review. The fix is not more documents. It is a decision record for every high risk and a closure record for every finding. This module is engineering education, not certification or legal advice; an auditor assesses conformity against the standard and the organization's own scope.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "ISO/IEC 27001 is an international standard for an information security management system (ISMS). An ISMS is the repeatable process an organization uses to identify information risks, decide how to treat them, operate controls, check that the controls work, and improve. The standard is not a fixed checklist of products, and certification is not a statement that a system is secure. It is evidence that a management process exists and operates.",
  },
  {
    type: "p",
    text: "The engineering consequence is that documents alone do not satisfy the system. A risk register with scores but no owners, a treatment plan with no approver, or an internal audit with findings that never close are all broken links. Each link has to produce a record that someone can sample later: who decided, what they decided, which control implements it, and when the decision was reviewed.",
  },
  {
    type: "p",
    text: "ISO/IEC 27002 provides guidance on information security controls and is commonly used to choose them, but the management-system requirements live in ISO/IEC 27001. A control catalog without a risk process is a shopping list. A risk process without controls is a meeting.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The ISMS sits above the controls a service team operates. It sets the scope, the risk method, the acceptance criteria, and the review cadence. The service team contributes the technical evidence: access reviews, change records, encryption state, monitoring coverage, and incident records. The management system decides which risks those controls are supposed to reduce.",
  },
  {
    type: "table",
    headers: ["Artifact", "What it records", "Evidence that it is alive"],
    rows: [
      ["Risk register", "Scenario, owner, score, review date", "An owner changed a score after a new threat or incident"],
      ["Treatment plan", "Option, control, residual risk, approver, due date", "A control shipped and the residual risk was re-scored"],
      ["Statement of Applicability", "Which controls apply and why", "An exclusion has a rationale and an owner"],
      ["Internal audit", "Independent check of the system", "Findings have owners, dates, and closure evidence"],
      ["Management review", "Decisions about risk, performance, and resources", "The review changed a priority or funded a control"],
    ],
  },
  {
    type: "p",
    text: "That layering matters during an audit. The auditor may start with a policy, but will follow it to a risk, then to a treatment, then to the control, then to a sample that the control operated. A team that can only produce the first step has a document pile, not a management system.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Management-system gap: the complement of the weakest of assessment, treatment, and closure.",
      "High risks without approved treatment: the share that has no decision or owner.",
      "Risks without owner or assessment: the share that never entered the process.",
      "Findings open or late: corrective actions that have not closed within the committed window.",
      "Node states: scope, risk register, treatment plan, control ownership, internal audit, and management review.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Audit season and compare the risk and treatment axes. Apply Policies only and watch the floor collapse even though the scope statement still exists. Run the experiment before revealing the explanation, then apply Recovery and notice that the register alone did not change; the treatment decision did.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not certification or legal advice. Conformity depends on the standard edition, the organization's scope, its risk method, and the auditor's judgment. Use the model to find broken links in the process, then work with your compliance owner and certification body.",
  },
  { type: "sim", simId: "iso27001" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The floor fell to approved treatment. Risks were still scored, the scope was still written, and policies were still published, but 10% treatment coverage meant most high risks had no decision and no owner. The treatment plan and control ownership nodes failed first because that is where the process breaks. The management-system gap crossed critical at 90%, and the finding backlog kept the audit and review nodes weak.",
  },
  {
    type: "p",
    text: "Restoring treatment coverage raised the floor without adding a single policy. That is the difference between a document set and a management system: a decision record connects a risk to a control, an owner, and a review date.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Risk register: owner field is populated, scores have dates, and reviews are scheduled.",
      "Treatment: each high risk has an option, a control reference, residual risk, and an approver.",
      "Controls: the named control exists in the system and produces current evidence.",
      "Audit: findings are tracked in the same system as other work, with owners and due dates.",
      "Review: management review minutes show decisions, not only attendance.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Pick the highest-scored risk and trace it to an owner and an approved treatment.",
      "Check whether the treatment names a control that actually exists in production.",
      "Compare the statement of applicability with the controls that produce evidence.",
      "Look for findings older than their committed closure date.",
      "Confirm the last management review changed a priority, a resource, or a risk score.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Assign an owner to every high risk before improving the register format.",
      "Record a treatment decision with residual risk and an approver for each high risk.",
      "Map each treatment to a control and to the evidence that shows it operates.",
      "Close or re-plan overdue findings, and escalate accepted risk above tolerance.",
      "Review the highest risks and the weakest links in management review.",
      "Re-test the chain after material changes to scope, systems, or threats.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A broad scope is more complete but harder to operate; a narrow scope is easier to defend if the boundary is honest and enforced.",
      "Detailed risk scoring feels rigorous but slows decisions; a simpler method with owners and dates often produces more treatment.",
      "Accepting risk is legitimate when the acceptance is explicit, approved, and time-bound; silent acceptance is the failure.",
      "Internal audit independence improves credibility and consumes people who also operate controls.",
      "Automated evidence is more trustworthy and costs engineering time; manual evidence is cheaper until the sample or scope grows.",
      "Centralizing the ISMS improves consistency and can distance it from the teams that actually own the controls.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "isms-vs-policies",
    question: "What makes an ISMS different from a set of security policies?",
    difficulty: 2,
    hints: [
      "A management system has inputs, decisions, checks, and improvement.",
      "Look for a link between a risk and a changed decision.",
    ],
    answer:
      "A policy set states intent. An ISMS turns intent into a repeatable process: it defines scope, assesses risk, chooses treatment, assigns ownership, operates controls, checks performance through audit and review, and improves. The test I use is whether a risk can be traced to an owner, a treatment decision, a control, and a review date. If the trail stops at a document, it is a policy library, not a management system.",
    followUps: [
      "Who approves residual risk, and how is that recorded?",
      "How does management review change priorities?",
      "What would you show an auditor for one high risk?",
    ],
    redFlags: [
      "Equates certification with security.",
      "Lists documents instead of decisions.",
      "Has no owner or review cadence for risk.",
    ],
    rubric: [
      "Describes a repeatable process.",
      "Connects risk to treatment and control.",
      "Names ownership and review.",
      "Separates certification from technical assurance.",
    ],
  },
  {
    id: "untreated-risk",
    question:
      "You find a high risk with no treatment and no owner two weeks before the certification audit. What do you do?",
    difficulty: 3,
    hints: [
      "Do not invent a treatment retroactively.",
      "An honest accepted risk can be a decision; an undocumented one cannot.",
    ],
    answer:
      "I would not backdate a control or a decision. I would assign an owner, document the current state, and bring the risk to the person with authority to accept or fund treatment. If treatment cannot ship before the audit, the record should show an explicit, time-bound acceptance with residual risk and a remediation date. Then I would check whether the same gap exists for other high risks, because one missing treatment usually indicates a broken process rather than a single oversight. The auditor can assess an honest open finding; they cannot assess a fabricated trail.",
    followUps: [
      "What if leadership refuses to accept the risk in writing?",
      "How do you prioritize among several untreated high risks?",
      "What evidence shows the new treatment is operating?",
    ],
    redFlags: [
      "Creates retroactive evidence.",
      "Treats the audit as the deadline instead of the risk.",
      "Accepts risk without authority.",
    ],
    rubric: [
      "Refuses to fabricate evidence.",
      "Assigns ownership and escalates.",
      "Records residual risk and a date.",
      "Checks for systemic recurrence.",
    ],
  },
  {
    id: "evidence-chain",
    question: "How would you prove that a control is operating, not just designed?",
    difficulty: 2,
    hints: [
      "Design evidence is a configuration or a policy.",
      "Operating evidence has a timestamp and a population.",
    ],
    answer:
      "I would define the control's population, the sample, and the system of record before the audit. For access review, that means the full set of accounts, the review record, the reviewer, the date, and the removals that followed. For change control, it means the change record, the approval, the deployment event, and the resulting state. The evidence should come from the system that performs the work, cover the audit period, and be reproducible. A screenshot of a configuration proves design; a dated record tied to the population proves operation.",
    followUps: [
      "How do you handle a control that runs manually?",
      "What if the system of record retains only 30 days?",
      "How do you sample a population that changes daily?",
    ],
    redFlags: [
      "Relies on screenshots without dates or scope.",
      "Samples only friendly cases.",
      "Cannot name the population.",
    ],
    rubric: [
      "Defines population and sample.",
      "Uses the system of record.",
      "Covers the audit period.",
      "Distinguishes design from operation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the audit",
    items: [
      "Confirm the ISMS scope and the systems that fall outside it.",
      "Trace the top risks to owners and approved treatments.",
      "Check that each treatment maps to a control with current evidence.",
      "Review overdue findings and accepted risks above tolerance.",
    ],
  },
  {
    title: "During the audit",
    items: [
      "Sample one risk end to end: assessment, treatment, control, evidence.",
      "Ask who approved residual risk and when it was last reviewed.",
      "Check that internal audit findings have owners and closure dates.",
      "Confirm management review produced decisions, not just minutes.",
    ],
  },
  {
    title: "After the audit",
    items: [
      "Close or re-plan findings in the same tracking system as other work.",
      "Update risk scores after material changes or incidents.",
      "Re-test the weakest link in the chain, not only the failed sample.",
      "Escalate risks that exceed the stated tolerance.",
    ],
  },
];

const references = [
  {
    title: "ISO/IEC 27001:2022 — Information security management systems — Requirements",
    url: "https://www.iso.org/standard/27001",
    publisher: "International Organization for Standardization",
    kind: "standard" as const,
    note: "Official standard page. The requirements define the management system, risk process, and continual improvement.",
  },
  {
    title: "NIST SP 800-39 — Managing Information Security Risk",
    url: "https://csrc.nist.gov/pubs/sp/800/39/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Risk management hierarchy and the connection between organizational risk, mission risk, and system controls.",
  },
  {
    title: "ISO/IEC 27002:2022 — Information security controls",
    url: "https://www.iso.org/standard/75652.html",
    publisher: "International Organization for Standardization",
    kind: "standard" as const,
    note: "Control guidance commonly used to select treatments. It supports ISO/IEC 27001 but does not replace its management-system requirements.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    iso27001: {
      model: iso27001Model,
      presets,
      instructions:
        "Start Healthy, then apply Audit season and Policies only. Compare the risk register with the treatment plan and the finding backlog. Run the experiment before revealing the explanation, then apply Recovery and confirm that treatment coverage, not policy text, raises the floor.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 20/45 thresholds are teaching values, not certification criteria or a guarantee. The model does not determine conformity; an auditor assesses the organization against the standard and its own scope.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-soc2", "compliance-audit-trails", "compliance-data-classification"],
};
