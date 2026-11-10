import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "accessControl",
    label: "Access control coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Technical safeguards",
    help: "Share of the health-data workforce whose production access is role-based, approved, and reviewed. Strong encryption does not compensate for an access gap.",
    format: "percent" as const,
  },
  {
    id: "auditEvidence",
    label: "Audit evidence coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Technical safeguards",
    help: "Share of privileged activity that produces an attributable audit record. Coverage is separate from how old the newest evidence export is; the next parameter measures freshness.",
    format: "percent" as const,
  },
  {
    id: "encryption",
    label: "Encryption or approved equivalent",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Technical safeguards",
    help: "Share of ePHI paths covered by encryption in transit and at rest, or by a documented equivalent that provides reasonable and appropriate protection. Encryption is an addressable specification, not an unconditional mandate for every path.",
    format: "percent" as const,
  },
  {
    id: "integrityAuth",
    label: "Integrity and authentication coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Technical safeguards",
    help: "Share of ePHI paths where integrity is protected against improper alteration and callers are authenticated before access. The Security Rule names both as technical safeguards.",
    format: "percent" as const,
  },
  {
    id: "evidenceAge",
    label: "Age of the oldest evidence",
    min: 1,
    max: 180,
    step: 1,
    value: 2,
    unit: " days",
    group: "Evidence",
    help: "Days since the oldest evidence was captured. Freshness is separate from coverage: a safeguard can cover every action and still have stale proof.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  access: number;
  audit: number;
  encryption: number;
  integrityAuth: number;
  score: number;
  gap: number;
  accessGap: number;
  auditGap: number;
  encryptionGap: number;
  integrityGap: number;
  evidenceAge: number;
}

function compute(p: Params): Computed {
  const access = clamp(num(p, "accessControl", 100), 0, 100);
  const audit = clamp(num(p, "auditEvidence", 100), 0, 100);
  const encryption = clamp(num(p, "encryption", 100), 0, 100);
  const integrityAuth = clamp(num(p, "integrityAuth", 100), 0, 100);
  const evidenceAge = Math.round(clamp(num(p, "evidenceAge", 2), 1, 180));
  const score = Math.min(access, audit, encryption, integrityAuth);
  return {
    access,
    audit,
    encryption,
    integrityAuth,
    score,
    gap: 100 - score,
    accessGap: 100 - access,
    auditGap: 100 - audit,
    encryptionGap: 100 - encryption,
    integrityGap: 100 - integrityAuth,
    evidenceAge,
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
  const scoreHealth = healthFor(values.gap, 20, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "identity",
        label: "Identity and access",
        kind: "service",
        health: healthFor(values.accessGap, 20, 50),
        utilization: values.accessGap / 100,
        sublabel: `${values.access.toFixed(0)}% role-based and reviewed`,
        detail: "Role assignments, approval records, and periodic reviews for everyone who can reach ePHI.",
      },
      {
        id: "api",
        label: "Health API",
        kind: "service",
        health: scoreHealth,
        utilization: values.gap / 100,
        sublabel: `${values.score.toFixed(0)}% readiness floor`,
        detail: "The request path. It inherits the weakest safeguard, not the average of the checklist.",
      },
      {
        id: "integrity",
        label: "Integrity and authentication",
        kind: "mesh",
        health: healthFor(values.integrityGap, 20, 50),
        utilization: values.integrityGap / 100,
        sublabel: `${values.integrityAuth.toFixed(0)}% protected and authenticated`,
        detail: "Integrity protection against improper alteration, plus authentication of the person or entity before access.",
      },
      {
        id: "phi",
        label: "ePHI data store",
        kind: "db",
        health: healthFor(values.encryptionGap, 20, 50),
        utilization: values.encryptionGap / 100,
        sublabel: `${values.encryption.toFixed(0)}% encryption or approved equivalent`,
        detail: "Encryption in transit and at rest, or a documented equivalent, plus key access and an inventory of every store that holds ePHI.",
      },
      {
        id: "audit",
        label: "Audit trail",
        kind: "storage",
        health: healthFor(values.auditGap, 20, 50),
        utilization: values.auditGap / 100,
        sublabel: `${values.audit.toFixed(0)}% audited · ${values.evidenceAge.toFixed(0)}d evidence`,
        detail: "Attributable records of access and privileged change, plus the evidence export that proves the review happened.",
      },
      {
        id: "backup",
        label: "Protected backups",
        kind: "storage",
        health: healthFor(values.encryptionGap, 20, 50),
        utilization: values.encryptionGap / 100,
        sublabel: `${values.encryption.toFixed(0)}% encryption or approved equivalent`,
        detail: "Backups are copies of ePHI. Their protection, access, and retention need the same evidence as the primary store.",
      },
    ],
    edges: [
      edge("identity-api", "identity", "api", clamp(values.access / 100), healthFor(values.accessGap, 20, 50)),
      edge("api-integrity", "api", "integrity", clamp(values.integrityAuth / 100), healthFor(values.integrityGap, 20, 50)),
      edge("integrity-phi", "integrity", "phi", clamp(values.encryption / 100), healthFor(values.encryptionGap, 20, 50)),
      edge("phi-audit", "phi", "audit", clamp(values.audit / 100), healthFor(values.auditGap, 20, 50)),
      edge("phi-backup", "phi", "backup", clamp(values.encryption / 100), healthFor(values.encryptionGap, 20, 50)),
    ],
    metrics: [
      metric("compliance-score", "Readiness floor (weakest safeguard)", values.score, "%", undefined, undefined, "percent"),
      metric("safeguard-gap", "Safeguard gap", values.gap, "%", 20, 50, "percent"),
      metric("evidence-age", "Oldest audit evidence", values.evidenceAge, " days", 30, 90, "count"),
      metric("audit-gap", "Audit coverage gap", values.auditGap, "%", undefined, undefined, "percent"),
      metric("integrity-gap", "Integrity and authentication gap", values.integrityGap, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Readiness is capped at ${values.score.toFixed(0)}% by the weakest safeguard; the gap is ${values.gap.toFixed(0)}%; audit evidence is ${values.evidenceAge.toFixed(0)} days old.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "safeguard-gap",
    metricId: "safeguard-gap",
    warn: 20,
    crit: 50,
    title: "A technical safeguard has no adequate coverage",
    cause:
      "The readiness floor is the weakest of access control, audit evidence, encryption or an approved equivalent, and integrity/authentication. A long checklist does not help when one safeguard covers only part of the ePHI path, because the unprotected path sets the risk for the workload.",
    fix:
      "Name the weakest safeguard and the systems it misses. Close it, or document the approved equivalent where the specification is addressable, then produce current evidence that the control operates across every store and transmission path. Do not average the gap away with stronger controls elsewhere.",
    checkFirst: [
      "Which of access, audit, encryption or equivalent, and integrity/authentication has the lowest coverage?",
      "Which ePHI systems are missing from that safeguard?",
      "Is the safeguard absent, or is it present without a testable evidence trail?",
    ],
  },
  {
    id: "evidence-age",
    metricId: "evidence-age",
    warn: 30,
    crit: 90,
    title: "Audit evidence is too old to prove the control operates",
    cause:
      "A control configured once is a claim. Evidence that is older than the review or audit period cannot show that access was actually reviewed, that privileged changes were actually logged, or that encryption still covers a new store added last month.",
    fix:
      "Automate evidence capture from the system of record on a schedule, timestamp it, and retain it for the audit window. Re-run the export after every material change to identity, storage, or network paths.",
    checkFirst: [
      "When was the last successful access review, and where is its export?",
      "Is the evidence a live system export or a screenshot from an earlier quarter?",
      "Does the evidence cover the full audit period, including new systems?",
    ],
  },
];

export const hipaaModel: SimModel = {
  id: "compliance-hipaa",
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
    if (values.gap >= 50 && frame.flags.safeguardEvent !== 1) {
      pushEvent(next, {
        id: "safeguard-without-evidence",
        at: frame.t,
        severity: "crit",
        title: "A technical safeguard has no adequate coverage",
        detail: `Readiness is capped at ${values.score.toFixed(0)}% by a safeguard gap of ${values.gap.toFixed(0)}%. The oldest audit evidence is ${values.evidenceAge.toFixed(0)} days old. The control set cannot be demonstrated across the ePHI path at this coverage.`,
        nodeId: "audit",
        metricId: "safeguard-gap",
      });
      next.flags.safeguardEvent = 1;
    }
    if (values.gap < 50) next.flags.safeguardEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Readiness is capped at ${values.score.toFixed(0)}% by the weakest safeguard; the gap is ${values.gap.toFixed(0)}%; audit evidence is ${values.evidenceAge.toFixed(0)} days old.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const axes = [
      { label: "access control", value: values.access },
      { label: "audit evidence", value: values.audit },
      { label: "encryption or an approved equivalent", value: values.encryption },
      { label: "integrity and authentication", value: values.integrityAuth },
    ].sort((a, b) => a.value - b.value);
    const weakest = axes.filter((axis) => axis.value === values.score).map((axis) => axis.label);
    return [
      values.score === 100
        ? "All four safeguards are at full coverage; the readiness floor is 100%."
        : `The readiness floor is ${values.score.toFixed(0)}% because ${weakest.join(" and ")} ${weakest.length === 1 ? "has" : "have"} the lowest coverage. Averaging the four safeguards would hide the path that is actually exposed.`,
      `Access is ${values.access.toFixed(0)}%, audit evidence is ${values.audit.toFixed(0)}%, encryption or an approved equivalent is ${values.encryption.toFixed(0)}%, and integrity/authentication is ${values.integrityAuth.toFixed(0)}%. A gap in any one caps the control set.`,
      `Encryption is an addressable specification. A documented equivalent can satisfy it when the entity has a reasonable and appropriate basis; a low value is a gap to explain and evidence, not an automatic violation.`,
      `The oldest evidence is ${values.evidenceAge.toFixed(0)} days old. Evidence age matters because a safeguard that operated last quarter may not cover a store or identity added this quarter.`,
      `HIPAA names safeguard categories, not a specific product or log format. The engineering job is to implement a reasonable control, scope it to every ePHI path, and keep evidence that it operates.`,
    ];
  },
  legend: [
    { label: "Covered", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Gap", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Access, audit evidence, encryption or an approved equivalent, and integrity/authentication cover the full ePHI path. Evidence is two days old.",
    tone: "ok",
    params: defaults({ accessControl: 100, auditEvidence: 100, encryption: 100, integrityAuth: 100, evidenceAge: 2 }),
  },
  {
    id: "peak",
    label: "Review slipped",
    description: "Access falls to 90%, audit evidence to 80%, and integrity/authentication to 85%. Evidence is 20 days old; the weakest safeguard is already partial.",
    tone: "warn",
    params: defaults({ accessControl: 90, auditEvidence: 80, encryption: 95, integrityAuth: 85, evidenceAge: 20 }),
  },
  {
    id: "failure",
    label: "Evidence gap",
    description: "Access is weak, audit evidence is absent, integrity/authentication is partial, and encryption or an equivalent covers only part of the path.",
    tone: "crit",
    params: defaults({ accessControl: 20, auditEvidence: 0, encryption: 60, integrityAuth: 30, evidenceAge: 120 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Access, integrity/authentication, and encryption or an equivalent are restored, and audit evidence is current.",
    tone: "ok",
    params: defaults({ accessControl: 95, auditEvidence: 100, encryption: 100, integrityAuth: 100, evidenceAge: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-evidence",
  title: "Predict whether a configured control is enough",
  simId: "hipaa",
  question:
    "Access control and encryption are fully in place. The team has no current audit evidence for privileged activity. Is the workload ready for a HIPAA review?",
  prediction: {
    options: [
      { id: "ready", label: "Yes. The two hardest controls are already implemented" },
      { id: "not-ready", label: "No. Audit controls are a technical safeguard category, and without evidence the team cannot show they operate" },
      { id: "encryption", label: "Yes. Strong encryption makes audit evidence optional" },
      { id: "policy", label: "No, but only because the written policy is missing" },
    ],
    correctOptionId: "not-ready",
    explanation:
      "The Security Rule names audit controls as a technical safeguard category. A team that cannot produce attributable audit records, or evidence that it reviewed them, has an unproven control. Encryption protects confidentiality; it does not show who accessed ePHI or who changed a privileged role.",
  },
  setup: defaults({ accessControl: 100, auditEvidence: 0, encryption: 100, integrityAuth: 100, evidenceAge: 120 }),
  runFor: 20,
  observe: [
    "The readiness floor is 0% because audit evidence has the lowest coverage.",
    "The oldest evidence is 120 days, crossing the critical evidence-age threshold.",
    "The API and audit nodes fail while the encryption node stays healthy.",
    "Adding access reviews or stronger encryption does not raise the floor while audit evidence is absent.",
  ],
  explain:
    "A HIPAA review asks two questions about each safeguard: is it implemented, and can you show that it operated during the period? Access control and encryption or an approved equivalent answer the first question. Audit records and evidence exports answer the second. Missing evidence is not a paperwork problem at the end; it is a missing control in the system of record. The fix is to emit attributable events, retain them, and generate a current export from the same source.",
  fix: defaults({ accessControl: 100, auditEvidence: 100, encryption: 100, integrityAuth: 100, evidenceAge: 2 }),
  debrief:
    "With current audit evidence the same access, encryption or equivalent, and integrity/authentication controls now support a defensible story: who can reach ePHI, who did reach it, and how the path is protected. The lesson is not to collect more screenshots. It is to make each safeguard produce evidence as a byproduct of normal operation. This module is engineering education, not legal advice; the scope of a real HIPAA program depends on the entity, the data, and the facts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Health Insurance Portability and Accountability Act (HIPAA) is a federal law that sets privacy and security requirements for health information. For engineers, the relevant part is the Security Rule, which protects electronic protected health information (ePHI): health data that identifies a person and is created, received, maintained, or transmitted electronically. The rule groups safeguards into administrative, physical, and technical categories. Administrative safeguards cover risk analysis, workforce policy, and training. Physical safeguards cover facilities and devices. Technical safeguards cover access control, audit controls, integrity, person or entity authentication, and transmission security.",
  },
  {
    type: "p",
    text: "The rule does not prescribe a product, a log format, or a single architecture. It requires safeguards that are reasonable and appropriate for the risk, and it requires documentation of policies, risk decisions, and activity. That distinction matters: a control configured once and never reviewed is a claim, while a control that produces current evidence is a defensible position. A long checklist can look complete while one path remains unprotected.",
  },
  {
    type: "p",
    text: "Readiness therefore behaves like a floor, not an average. If access control covers 100% of the workforce but audit evidence covers none of the privileged actions, the audit gap is the story an auditor will test. Strong encryption elsewhere does not raise that floor. The model scores the weakest safeguard and the age of the evidence behind it.",
  },
  {
    type: "p",
    text: "Encryption is an addressable implementation specification in the Security Rule, not an unconditional mandate for every path. An entity can document why encryption is not reasonable and appropriate and implement an equivalent safeguard that provides reasonable and appropriate protection. The model's encryption axis therefore means encryption or an approved documented equivalent; a low value is a gap to explain and evidence, not an automatic violation. The 30- and 90-day evidence thresholds and the 180-day scale are teaching values, not legal deadlines.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The controls sit around the whole ePHI path, not only the database. Identity decides who can reach the data, the API enforces access, the store and backups protect it at rest, the network protects it in transit, and the audit trail records who did what. A new analytics copy, a support tool, or a vendor integration adds another path that must inherit the same controls.",
  },
  {
    type: "table",
    headers: ["Safeguard family", "Engineering artifact", "Evidence an auditor can test"],
    rows: [
      ["Administrative", "Risk analysis, access policy, workforce process", "Review exports, approval records, dated risk decisions"],
      ["Physical", "Facility access, device inventory, disposal", "Badge logs, asset records, destruction certificates"],
      ["Technical", "IAM, audit configuration, TLS or an approved equivalent, integrity, authentication", "Policy exports, log samples, configuration snapshots"],
    ],
  },
  {
    type: "p",
    text: "Engineering owns the technical safeguards directly and produces most of the evidence for the other two. A platform team may not own the training program, but it owns the access review export that shows the program ran. That is why access, audit, integrity, authentication, and transmission are the controls a service team should be able to explain without calling legal.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Readiness floor: the weakest of access control, audit evidence, encryption or an approved equivalent, and integrity/authentication.",
      "Safeguard gap: the complement of that floor, with warning and critical thresholds.",
      "Oldest audit evidence: how stale the proof is, measured in days.",
      "Audit coverage gap: the share of privileged activity without attributable evidence.",
      "Integrity and authentication gap: the share of ePHI paths without protected integrity or caller authentication.",
      "Node states: identity, API, integrity/authentication, ePHI store, audit trail, and backups show which path broke.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Review slipped and watch the floor fall to the weakest safeguard. Apply Evidence gap and notice that the API, audit, and integrity/authentication nodes fail while encryption or an approved equivalent may still look adequate. Run the experiment before revealing the explanation, then apply Recovery and compare the same access and encryption values with current audit evidence.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. HIPAA obligations depend on the covered entity or business associate, the data, the contracts, and the facts. Use this module to ask better engineering questions, then involve your privacy officer and counsel for a compliance decision.",
  },
  {
    type: "p",
    text: "The useful engineering question is not whether the team has a HIPAA certificate. It is which safeguard is weakest, which ePHI path that safeguard misses, and what current evidence proves the control operated during the period under review.",
  },
  { type: "sim", simId: "hipaa" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The readiness floor dropped to the weakest safeguard. Access and encryption could both be strong while audit evidence was absent, and the workload still failed because the missing audit control left no way to show who accessed ePHI or changed a privileged role. The evidence age also crossed its threshold because the oldest proof was 120 days old, turning a configuration gap into an audit-period problem.",
  },
  {
    type: "p",
    text: "Restoring audit evidence and capturing current proof did not change the access or encryption numbers, but it raised the floor and cleared both thresholds. The same pattern applies to any of the four safeguards: the score is set by the path that is least covered, not by the average of the checklist.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Identity: role assignments, approval tickets, review completion, and orphaned accounts.",
      "Data path: ePHI store inventory, TLS termination, KMS key policies, and backup encryption.",
      "Audit: privileged-event coverage, actor attribution, retention, and the latest evidence export.",
      "Change: new stores, new integrations, and new admin roles that were added after the last review.",
      "Evidence: timestamps, owners, and the audit period each export actually covers.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Name the weakest of access, audit, encryption or an approved equivalent, and integrity/authentication, plus the ePHI path it misses.",
      "Pull the latest access review export and check its date and scope.",
      "Trace one privileged action from the identity provider to the audit record and the evidence export.",
      "List every store and backup that holds ePHI, including analytics copies and vendor exports.",
      "Check whether the last material change to the data path was followed by a new evidence capture.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Close the weakest safeguard across every ePHI path, or document the approved equivalent where the specification is addressable.",
      "Make the control produce attributable evidence as part of normal operation.",
      "Automate a dated export from the system of record and assign an owner.",
      "Re-run the evidence capture after new stores, identities, or integrations are added.",
      "Test one privileged action end to end: actor, action, target, time, outcome, and source.",
      "Review the floor and the evidence age before the audit, not during it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Standing admin access is convenient but hard to defend; just-in-time access reduces the standing population and adds approval friction.",
      "Longer audit retention supports investigations and costs storage; the right window comes from policy and contract, not from a default.",
      "Customer-managed keys improve control and add operational work for rotation, availability, and break-glass access.",
      "Automated evidence is more trustworthy and requires engineering time; manual screenshots are cheaper until the audit period or scope changes.",
      "A strict readiness floor is honest about the weakest path, but it can obscure progress in the safeguards that are already strong. Report both the floor and the individual coverage.",
      "Encryption is addressable. A documented equivalent can satisfy the specification, but the risk rationale and the evidence still need an owner and a review date.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "safeguard-ownership",
    question:
      "Which HIPAA safeguards does an engineering team own directly, and which does it only support?",
    difficulty: 2,
    hints: [
      "The Security Rule groups safeguards into administrative, physical, and technical categories.",
      "Engineering produces evidence for controls it does not own.",
    ],
    answer:
      "Engineering owns the technical safeguards directly: access control, audit controls, integrity, person or entity authentication, and transmission security. It supports administrative safeguards by producing access reviews, change approvals, and risk evidence, and it supports physical safeguards through device inventory, disposal, and facility access data. The team rarely owns the full administrative program, but it owns the systems that make the program testable. I would map each safeguard category to a named control, an owner, and a current evidence source before calling the workload ready.",
    followUps: [
      "Who owns the risk analysis, and what does engineering contribute to it?",
      "How would you prove that a control covers a new analytics copy?",
      "What would you escalate to the privacy officer?",
    ],
    redFlags: [
      "Treats HIPAA as a product certificate.",
      "Claims engineering owns the entire program.",
      "Lists controls without evidence owners.",
    ],
    rubric: [
      "Separates the three safeguard families.",
      "Names the technical safeguards accurately.",
      "Connects each family to evidence.",
      "Escalates legal and privacy judgment.",
    ],
  },
  {
    id: "evidence-gap",
    question:
      "A control is configured, but you cannot produce evidence that it operated during the audit period. Is the workload ready?",
    difficulty: 2,
    hints: [
      "An auditor tests operation, not only configuration.",
      "Evidence has a date, a scope, and an owner.",
    ],
    answer:
      "I would not call it ready. A configured control is an implementation claim; evidence shows that it operated across the period and the systems in scope. I would identify the missing evidence, check whether the control actually ran, and capture a current export from the system of record. If the gap covers a safeguard, I would treat it as an open finding until the control and the evidence both cover every ePHI path. A screenshot from last quarter does not answer a question about this quarter.",
    followUps: [
      "What would you do if the control ran but the evidence was never retained?",
      "How do you prove coverage after a new store is added?",
      "When would you escalate instead of remediating?",
    ],
    redFlags: [
      "Accepts a configuration screenshot as proof.",
      "Assumes the control covers systems added later.",
      "Waits for the auditor to find the gap.",
    ],
    rubric: [
      "Distinguishes configuration from operation.",
      "Checks scope and date.",
      "Captures evidence from the system of record.",
      "Treats a safeguard gap as a finding.",
    ],
  },
  {
    id: "scope-review",
    question:
      "How do you scope a HIPAA readiness review for a new health-data service?",
    difficulty: 3,
    hints: [
      "Start with the data flow, not the architecture diagram.",
      "Include copies, backups, support access, and vendors.",
    ],
    answer:
      "I would start with the data flow: where ePHI is created, received, stored, processed, and transmitted, including logs, analytics copies, backups, and vendor integrations. Then I would map each safeguard to those paths and identify the weakest coverage. I would check identity and access, audit attribution and retention, encryption or an approved equivalent, integrity, authentication, and the evidence source for each. I would also confirm which entity is the covered entity or business associate and which contracts apply, because that scope decision is not an engineering call alone. The output is a list of gaps with owners and evidence, not a yes-or-no certificate.",
    followUps: [
      "How do you handle a vendor that only sees de-identified data?",
      "What changes if the service is multi-region?",
      "Which gaps would block launch?",
    ],
    redFlags: [
      "Scopes only the primary database.",
      "Ignores logs, backups, and support access.",
      "Promises compliance without privacy or legal review.",
    ],
    rubric: [
      "Starts from the data flow.",
      "Includes copies and vendors.",
      "Maps safeguards to evidence.",
      "Defers entity and contract decisions.",
    ],
  },
];

const checklist = [
  {
    title: "Before the review",
    items: [
      "Inventory every system, copy, backup, and vendor that can hold or transmit ePHI.",
      "Map access control, audit, integrity, and transmission controls to each path.",
      "Name an owner and an evidence source for every safeguard.",
      "Check the date and scope of the latest access and audit evidence.",
    ],
  },
  {
    title: "During the review",
    items: [
      "Find the weakest safeguard and the path it misses.",
      "Trace one privileged action from identity to audit record.",
      "Check whether new systems were added after the last evidence capture.",
      "Separate a missing control from missing evidence for an operating control.",
    ],
  },
  {
    title: "After the review",
    items: [
      "Close the weakest control across the full ePHI path.",
      "Automate evidence capture and assign a review owner.",
      "Re-test after material changes to identity, storage, or network paths.",
      "Document accepted risks and escalate legal or privacy questions.",
    ],
  },
];

const references = [
  {
    title: "HIPAA Security Rule",
    url: "https://www.hhs.gov/hipaa/for-professionals/security/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "Security Rule overview and the administrative, physical, and technical safeguard categories.",
  },
  {
    title: "Implementing the HIPAA Security Rule (NIST SP 800-66 Rev. 2)",
    url: "https://csrc.nist.gov/pubs/sp/800/66/r2/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Implementation guidance that maps the Security Rule to security controls and evidence.",
  },
  {
    title: "HIPAA Security Rule guidance material",
    url: "https://www.hhs.gov/hipaa/for-professionals/security/guidance/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "Official guidance on risk analysis and Security Rule implementation.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    hipaa: {
      model: hipaaModel,
      presets,
      instructions:
        "Start Healthy, then apply Review slipped and Evidence gap. Compare the readiness floor with the three individual controls and the evidence age. Run the experiment before revealing the explanation, then apply Recovery and confirm the floor returns to the weakest remaining control.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Control coverage percentages and the 30/90-day evidence thresholds plus the 180-day scale are teaching values, not a legal requirement or a guarantee. Encryption is modeled as encryption or a documented equivalent; the model does not decide whether an equivalent is sufficient.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-least-privilege", "compliance-phi", "compliance-access-controls"],
};
