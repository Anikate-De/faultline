import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "baaCoverage",
    label: "Vendors with an executed BAA",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Contract",
    help: "Share of vendors that handle PHI for this workload and have a signed business associate agreement covering the service in use.",
    format: "percent" as const,
  },
  {
    id: "phiShare",
    label: "Records containing PHI",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Data",
    help: "Share of the payload sent to vendors that contains health information tied to an individual. A vendor with no PHI is out of this obligation.",
    format: "percent" as const,
  },
  {
    id: "gateEnforcement",
    label: "Egress gate enforcement",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Enforcement",
    help: "Share of outbound paths that check the destination against the approved vendor and BAA registry before data leaves. A gate that only warns is not enforcement.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  baaCoverage: number;
  phiShare: number;
  gateEnforcement: number;
  baaGap: number;
  gateGap: number;
  exposure: number;
  blocked: number;
  bypass: number;
}

function compute(p: Params): Computed {
  const baaCoverage = clamp(num(p, "baaCoverage", 100), 0, 100);
  const phiShare = clamp(num(p, "phiShare", 40), 0, 100);
  const gateEnforcement = clamp(num(p, "gateEnforcement", 100), 0, 100);
  const baaGap = 100 - baaCoverage;
  const gateGap = 100 - gateEnforcement;
  return {
    baaCoverage,
    phiShare,
    gateEnforcement,
    baaGap,
    gateGap,
    exposure: (phiShare * baaGap * gateGap) / 1000,
    blocked: (phiShare * baaGap * gateEnforcement) / 1000,
    bypass: gateGap,
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
  const gateHealth = healthFor(values.bypass, 10, 40);
  const registryHealth = healthFor(values.baaGap, 20, 50);
  const vendorHealth = healthFor(values.exposure, 1, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "phi",
        label: "PHI source",
        kind: "db",
        health: "ok",
        utilization: values.phiShare / 100,
        sublabel: `${values.phiShare.toFixed(0)}% of records contain PHI`,
        detail: "The source is allowed to hold PHI. The question is which destinations are allowed to receive it.",
      },
      {
        id: "app",
        label: "Telemetry producer",
        kind: "service",
        health: "ok",
        utilization: values.phiShare / 100,
        sublabel: "builds the vendor payload",
        detail: "The service that assembles events. It should send the minimum fields needed, not the whole record.",
      },
      {
        id: "gate",
        label: "BAA gate",
        kind: "service",
        health: gateHealth,
        utilization: clamp(values.bypass / 100),
        sublabel: `${values.gateEnforcement.toFixed(0)}% of egress checked`,
        detail: "A destination allowlist that requires an approved vendor and a current BAA before data leaves.",
      },
      {
        id: "registry",
        label: "Vendor and BAA registry",
        kind: "storage",
        health: registryHealth,
        utilization: values.baaGap / 100,
        sublabel: `${values.baaCoverage.toFixed(0)}% covered`,
        detail: "The system of record for vendor approval, the service in scope, the BAA date, and subcontractors.",
      },
      {
        id: "vendor",
        label: "Observability vendor",
        kind: "external",
        health: vendorHealth,
        utilization: clamp(values.exposure / 1000),
        sublabel: `${values.exposure.toFixed(0)} PHI records per 1k`,
        detail: "The external destination. A BAA is required when it handles PHI on your behalf, regardless of its security certifications.",
      },
    ],
    edges: [
      edge("phi-app", "phi", "app", clamp(values.phiShare / 100)),
      edge("app-gate", "app", "gate", clamp(values.gateEnforcement / 100), gateHealth),
      edge("registry-gate", "registry", "gate", clamp(values.baaCoverage / 100), registryHealth),
      edge("gate-vendor", "gate", "vendor", clamp(values.gateEnforcement / 100), vendorHealth),
    ],
    metrics: [
      metric("baa-exposure", "PHI to vendor without a BAA", values.exposure, " /1k records", 1, 50, "count"),
      metric("gate-bypass", "Egress outside the BAA gate", values.bypass, "%", 10, 40, "percent"),
      metric("baa-gap", "Vendors without a BAA", values.baaGap, "%", undefined, undefined, "percent"),
      metric("blocked", "Blocked non-compliant sends", values.blocked, " /1k records", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.exposure.toFixed(0)} PHI records per 1,000 reach a vendor without a BAA; ${values.bypass.toFixed(0)}% of egress can bypass the gate; ${values.baaGap.toFixed(0)}% of vendors lack a BAA.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "baa-exposure",
    metricId: "baa-exposure",
    warn: 1,
    crit: 50,
    title: "PHI reached a vendor without a BAA",
    cause:
      "A vendor that creates, receives, maintains, or transmits PHI on your behalf needs a business associate agreement before the data flows. Encryption, a security certification, and a good questionnaire are safeguards, not a substitute for the agreement.",
    fix:
      "Stop the flow, determine whether the vendor is a business associate for this service, and execute a BAA or remove PHI from the payload. Record the approval and verify that the gate blocks the same path until the agreement is in place.",
    checkFirst: [
      "Which vendor and integration received the data, and what fields did they include?",
      "Does a signed BAA cover that legal entity and the specific service in use?",
      "Was the data de-identified before egress, or did raw PHI leave?",
    ],
  },
  {
    id: "gate-bypass",
    metricId: "gate-bypass",
    warn: 10,
    crit: 40,
    title: "Egress can bypass the BAA gate",
    cause:
      "A manual export, a sidecar integration, or a new pipeline can send data without passing the allowlist. A contract stored in a spreadsheet does not enforce the route, and a gate that only logs a warning is not a gate.",
    fix:
      "Enforce the check in the egress path, default deny, and require an approved destination plus current BAA metadata. Alert on unknown destinations and make a new integration register before it can send.",
    checkFirst: [
      "List every egress path that can reach a vendor, including manual and batch jobs.",
      "Is the gate enforced at the network or proxy layer, or only in application code?",
      "Can a new integration ship without registering its destination?",
    ],
  },
];

export const baaModel: SimModel = {
  id: "compliance-baa",
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
    if (values.exposure >= 50 && frame.flags.baaEvent !== 1) {
      pushEvent(next, {
        id: "phi-to-vendor-without-baa",
        at: frame.t,
        severity: "crit",
        title: "PHI was sent to a vendor without a BAA",
        detail: `${values.exposure.toFixed(0)} of every 1,000 records reached a vendor without an executed agreement. The relationship is not covered for this data.`,
        nodeId: "vendor",
        metricId: "baa-exposure",
      });
      next.flags.baaEvent = 1;
    }
    if (values.exposure < 50) next.flags.baaEvent = 0;
    if (values.bypass >= 40 && frame.flags.bypassEvent !== 1) {
      pushEvent(next, {
        id: "baa-gate-bypassed",
        at: frame.t,
        severity: "crit",
        title: "Egress bypassed the BAA gate",
        detail: `${values.bypass.toFixed(0)}% of egress can reach a vendor without passing the destination check. A contract record alone does not enforce the path.`,
        nodeId: "gate",
        metricId: "gate-bypass",
      });
      next.flags.bypassEvent = 1;
    }
    if (values.bypass < 40) next.flags.bypassEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.exposure.toFixed(0)} PHI records per 1,000 reach a vendor without a BAA; ${values.bypass.toFixed(0)}% of egress can bypass the gate; ${values.baaGap.toFixed(0)}% of vendors lack a BAA.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `A vendor that handles PHI on your behalf is a business associate and needs a BAA. Here ${values.baaCoverage.toFixed(0)}% of vendors are covered, leaving a ${values.baaGap.toFixed(0)}% gap.`,
      `Encryption and a SOC 2 report do not replace the agreement. They reduce some risk; they do not authorize the data flow or create the contractual obligations.`,
      `${values.gateEnforcement.toFixed(0)}% of egress is checked, so ${values.bypass.toFixed(0)}% of egress can bypass the destination gate. The gate should default deny and use the registry as its source of truth.`,
      `${values.exposure.toFixed(0)} PHI records per 1,000 reach an uncovered vendor. The number is zero when either the vendor is covered or the payload has no PHI.`,
    ];
  },
  legend: [
    { label: "Covered", tone: "ok" },
    { label: "Review needed", tone: "warn" },
    { label: "Uncovered egress", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every vendor that receives PHI has a BAA, and every egress path checks the registry before sending.",
    tone: "ok",
    params: defaults({ baaCoverage: 100, phiShare: 40, gateEnforcement: 100 }),
  },
  {
    id: "peak",
    label: "New integration",
    description: "A new vendor is added before its BAA is executed and 10% of egress bypasses the gate.",
    tone: "warn",
    params: defaults({ baaCoverage: 80, phiShare: 60, gateEnforcement: 90 }),
  },
  {
    id: "failure",
    label: "No BAA, no gate",
    description: "No vendor is covered and no egress path is checked, so raw PHI reaches the vendor on every send.",
    tone: "crit",
    params: defaults({ baaCoverage: 0, phiShare: 100, gateEnforcement: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The BAA is executed and the gate covers every egress path. PHI can flow under the agreement.",
    tone: "ok",
    params: defaults({ baaCoverage: 100, phiShare: 100, gateEnforcement: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-baa-first",
  title: "Predict what must exist before the first send",
  simId: "baa",
  question:
    "A new observability vendor is SOC 2 Type II certified and encrypts data in transit. You want to send events that contain PHI. What must exist before the first send?",
  prediction: {
    options: [
      { id: "nothing", label: "Nothing beyond the certification and TLS" },
      { id: "baa", label: "A signed BAA covering the vendor and service, plus an approved egress path" },
      { id: "dpa", label: "Only a privacy policy on the vendor's website" },
      { id: "encryption", label: "Customer-managed encryption keys are sufficient" },
    ],
    correctOptionId: "baa",
    explanation:
      "A vendor that creates, receives, maintains, or transmits PHI on your behalf needs a business associate agreement. The certification and encryption are useful safeguards, but they do not authorize the data flow or create the contractual obligations that apply to a business associate.",
  },
  setup: defaults({ baaCoverage: 0, phiShare: 100, gateEnforcement: 0 }),
  runFor: 20,
  observe: [
    "Every record contains PHI, no vendor is covered, and no egress path is checked.",
    "The uncovered vendor receives 1,000 PHI records per 1,000.",
    "The gate and registry nodes fail, and the vendor node fails with them.",
    "Adding encryption would not change the exposure metric while the agreement and gate are missing.",
  ],
  explain:
    "The BAA is a prerequisite, not a security feature you can replace with a stronger cipher. It defines permitted uses, safeguards, subcontractor obligations, breach reporting, and return or destruction. The gate is the engineering control that makes the agreement operational: a destination is allowed only when the vendor and service are in the registry with a current BAA. The two controls answer different questions, and both are needed before PHI leaves.",
  fix: defaults({ baaCoverage: 100, phiShare: 100, gateEnforcement: 100 }),
  debrief:
    "With the agreement and the gate in place, the same PHI-bearing payload can flow to the vendor under a defined scope. A BAA is necessary but not sufficient: the payload should still carry the minimum necessary fields, the vendor should still be reviewed, and subcontractors should still be disclosed. This is engineering education, not legal advice; the entity analysis and contract terms belong with counsel and your privacy officer.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A business associate agreement (BAA) is a contract between a covered entity and a vendor that creates, receives, maintains, or transmits protected health information (PHI) on the covered entity's behalf for a function or activity regulated by HIPAA. It is also used between business associates and their subcontractors. The agreement defines the permitted uses and disclosures, the safeguards the vendor must apply, how breaches are reported, how subcontractors are handled, and what happens to the data at the end of the relationship.",
  },
  {
    type: "p",
    text: "The BAA is not a security certification. A vendor can have a BAA and still have weak access control; a vendor can have strong encryption and still be the wrong destination for PHI. The agreement creates obligations and accountability. The engineering controls decide whether the data actually follows the approved path.",
  },
  {
    type: "p",
    text: "The trigger is the vendor's role and the data, not the vendor's category. A logging platform, an error tracker, a support tool, a managed database, and a analytics vendor can all be business associates if they handle PHI for you. A vendor that never receives PHI, or that only acts as a conduit in a narrow sense, needs a different analysis. Do not assume that a logo on a trust page settles the question.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The BAA sits at the boundary between the approved data flow and the vendor. The engineering side needs three artifacts: a vendor registry that records the legal entity, the service in scope, the BAA date, and subcontractors; a data-flow inventory that lists which fields each integration sends; and an egress gate that checks the destination before data leaves. The contract without the gate is a promise; the gate without the contract is a block.",
  },
  {
    type: "table",
    headers: ["Situation", "Contract question", "Engineering control"],
    rows: [
      ["Vendor receives PHI directly", "Is a BAA executed for this entity and service?", "Destination allowlist and field minimization"],
      ["Vendor receives de-identified data", "Does the method actually remove PHI?", "Validated de-identification before egress"],
      ["Vendor adds a subcontractor", "Does the BAA flow down and is notice required?", "Subprocessor inventory and change review"],
      ["Vendor support accesses production", "Is support access covered and logged?", "Just-in-time access, session audit, approval"],
      ["Vendor relationship ends", "Is data returned or destroyed?", "Deletion evidence and access revocation"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative percentages. Its two failure paths are independent: a vendor without a BAA, and an egress path that does not check the registry. Closing one does not close the other. That is why the break condition can appear even when the contract team believes every vendor is covered.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "PHI to a vendor without a BAA: the volume that reached an uncovered destination.",
      "Egress outside the BAA gate: the share of outbound traffic that can skip the destination check.",
      "Vendors without a BAA: the contract coverage gap in the registry.",
      "Blocked non-compliant sends: the gate working, which is a sign of enforcement rather than failure.",
      "Node states: the gate, registry, and vendor show which control broke.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply New integration. Watch the vendor exposure and the bypass percentage separately. Apply No BAA, no gate to see both controls fail at once. Run the experiment before revealing the explanation, then apply Recovery and confirm that the same PHI-bearing payload is now covered.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. Whether a particular vendor is a business associate, which entity must sign, and what terms are required depend on the facts and the law. Have counsel and your privacy officer review the relationship before PHI flows.",
  },
  { type: "sim", simId: "baa" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The first failure was contractual: PHI reached a vendor with no executed BAA. The second was operational: even if the contract had existed, part of the egress path could bypass the registry and send to a destination the gate never checked. The vendor node failed on exposure, while the gate and registry nodes failed on their own gaps.",
  },
  {
    type: "p",
    text: "Adding a BAA cleared the contractual exposure; enforcing the gate cleared the bypass. The payload still contained PHI, which is allowed when the vendor is covered and the flow is approved. The lesson is that a vendor relationship needs both a valid agreement and an enforced path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A vendor registry with legal entity, service, BAA date, scope, and subcontractors.",
      "Egress logs that name the destination and the fields sent, not only the bytes.",
      "Integrations that can reach a vendor without passing the gate, including manual exports.",
      "Vendor support access, session recording, and approval records.",
      "Deletion or return evidence when a vendor relationship ends.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List every vendor that receives PHI, including logging, error tracking, support, and analytics.",
      "Check that the BAA covers the legal entity and the specific service in use.",
      "Find every egress path that can reach the vendor, including batch and manual jobs.",
      "Verify the gate defaults to deny and uses the registry as its source of truth.",
      "Check subcontractors and support access against the agreement.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the uncovered egress and preserve the evidence of what was sent.",
      "Determine whether the vendor is a business associate for this service and data.",
      "Execute a BAA or remove PHI from the payload before restoring the flow.",
      "Put the destination check in the egress path and default to deny.",
      "Register the vendor, service, BAA date, and subcontractors in one system of record.",
      "Re-test the same path with a synthetic record and verify the gate blocks an unknown destination.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A strict egress gate slows new integrations and prevents accidental PHI flows; a warning-only gate is faster and leaves the decision to the sender.",
      "Minimizing fields reduces vendor exposure and can remove useful diagnostics; use a redacted correlation ID and an approved debug path.",
      "A central vendor registry improves evidence and adds a dependency; a per-team spreadsheet is cheaper until the first audit or incident.",
      "A broad BAA can cover many services quickly and may not match the actual data flow; service-level scoping is more work and more defensible.",
      "De-identifying before egress can avoid a BAA for that payload and may reduce analytical value; validate the method before relying on it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "is-ba",
    question:
      "How do you decide whether a new observability vendor needs a BAA?",
    difficulty: 2,
    hints: [
      "Start with the data and the vendor's role, not the vendor's product category.",
      "A vendor that handles PHI on your behalf is the trigger.",
    ],
    answer:
      "I would trace the payload first: does the integration send PHI, or only de-identified or non-health data? If it sends PHI, I would ask whether the vendor creates, receives, maintains, or transmits that data on our behalf. If so, it is a business associate for this service and needs a BAA before the first send. I would also check subcontractors, support access, and the specific service in scope, because a corporate BAA may not cover a new product. If the data is de-identified, I would validate the method before concluding the obligation is gone. The final entity and contract call belongs with legal and privacy.",
    followUps: [
      "What if the vendor only stores encrypted blobs and cannot read them?",
      "Does a support portal that can view production need coverage?",
      "How do you handle a vendor acquisition or rename?",
    ],
    redFlags: [
      "Uses the vendor's trust page as the decision.",
      "Assumes encryption removes the need for a BAA.",
      "Ignores subcontractors and support access.",
    ],
    rubric: [
      "Starts from the payload.",
      "Applies the business-associate test.",
      "Checks service and subcontractor scope.",
      "Escalates legal judgment.",
    ],
  },
  {
    id: "baa-vs-security",
    question:
      "The vendor has a BAA and a SOC 2 report. What does that prove, and what does it not prove?",
    difficulty: 2,
    hints: [
      "A contract and an audit report answer different questions.",
      "You still need to verify the specific configuration and data flow.",
    ],
    answer:
      "The BAA proves that the relationship has contractual obligations for PHI. The SOC 2 report gives some assurance about the vendor's controls over a period, but it is not a guarantee for our configuration, our data, or the specific service. Neither proves that we send the minimum necessary fields, that our egress gate blocks unknown destinations, or that the vendor's subcontractors are covered. I would verify the service scope, the fields, the access path, the retention, and the subcontractor list, and keep our own evidence for the integration.",
    followUps: [
      "Which SOC 2 trust criteria matter for this vendor?",
      "How do you verify the vendor's configuration rather than its report?",
      "What would make you reject the vendor despite a clean report?",
    ],
    redFlags: [
      "Treats SOC 2 as a compliance certificate for the integration.",
      "Assumes the BAA covers every service.",
      "Does not verify the data flow.",
    ],
    rubric: [
      "Separates contract from assurance.",
      "Checks scope and configuration.",
      "Verifies fields and access.",
      "Keeps own evidence.",
    ],
  },
  {
    id: "gate-design",
    question:
      "How would you enforce a BAA gate so a new integration cannot send PHI to an unapproved vendor?",
    difficulty: 3,
    hints: [
      "Default deny and make the registry the source of truth.",
      "A gate that only warns is not enforcement.",
    ],
    answer:
      "I would put the check in the egress path, not in a review checklist. The default would be deny, and the sender would need a destination that is registered with an approved service, a current BAA, and a data-flow approval for the fields being sent. I would log the decision with the vendor, service, fields, and actor, and alert on unknown destinations. I would also cover manual exports and batch jobs, not only the main application, and test the gate with a synthetic record before relying on it. The registry needs an owner and a review cadence, because a stale approval is its own failure.",
    followUps: [
      "Where would you enforce it: network, proxy, or application?",
      "How do you handle an emergency egress during an incident?",
      "How do you detect a path that bypasses the gate?",
    ],
    redFlags: [
      "Relies on a spreadsheet and a ticket approval.",
      "Logs a warning but sends the data.",
      "Covers only the primary application path.",
    ],
    rubric: [
      "Defaults to deny.",
      "Uses a registry with scope and expiry.",
      "Covers all egress paths.",
      "Logs and tests the decision.",
    ],
  },
];

const checklist = [
  {
    title: "Before onboarding",
    items: [
      "Classify the payload and confirm whether it contains PHI.",
      "Determine whether the vendor is a business associate for the specific service.",
      "Execute a BAA that covers the entity, service, and subcontractors.",
      "Add the destination and fields to the approved data-flow inventory.",
    ],
  },
  {
    title: "At the boundary",
    items: [
      "Enforce a default-deny destination check in the egress path.",
      "Require a current BAA and service approval before sending.",
      "Log the vendor, service, fields, actor, and decision for every send.",
      "Alert on unknown destinations and on registry entries nearing expiry.",
    ],
  },
  {
    title: "After a change",
    items: [
      "Re-check the BAA when the vendor adds a service or subcontractor.",
      "Re-test the gate with a synthetic record and an unknown destination.",
      "Review support access and deletion evidence at offboarding.",
      "Update the inventory and remove stale approvals.",
    ],
  },
];

const references = [
  {
    title: "Business associates",
    url: "https://www.hhs.gov/hipaa/for-professionals/privacy/guidance/business-associates/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "Who is a business associate and what the relationship requires.",
  },
  {
    title: "Sample business associate agreement provisions",
    url: "https://www.hhs.gov/hipaa/for-professionals/covered-entities/sample-business-associate-agreement-provisions/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "Official sample language and the categories of obligations a BAA covers.",
  },
  {
    title: "45 CFR 164.504: Uses and disclosures: Organizational requirements",
    url: "https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-E/section-164.504",
    publisher: "Electronic Code of Federal Regulations",
    kind: "standard" as const,
    note: "The regulatory text for business associate contracts and related requirements.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    baa: {
      model: baaModel,
      presets,
      instructions:
        "Start Healthy, then apply New integration. Compare the vendor exposure with the gate bypass percentage. Apply No BAA, no gate to fail both controls, run the experiment, then apply Recovery and verify that PHI can flow only through the covered, enforced path.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Vendor coverage and exposure rates are teaching values, not a legal conclusion or a vendor guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-phi", "compliance-access-controls", "compliance-audit-logs"],
};
