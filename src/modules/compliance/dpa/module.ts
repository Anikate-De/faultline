import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "dpaCoverage",
    label: "Processors with a covering DPA",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Agreement",
    help: "Share of processors whose executed agreement covers the legal entity, the specific service, the data categories, and the processing purpose. A corporate master agreement may not cover a new product.",
    format: "percent" as const,
  },
  {
    id: "subprocessorCoverage",
    label: "Subprocessors disclosed and approved",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Chain",
    help: "Share of subcontractors that are disclosed, approved, and bound by equivalent obligations. The processor's own vendors are part of the data path even when they never appear in your contract.",
    format: "percent" as const,
  },
  {
    id: "gateEnforcement",
    label: "Data flows checked at the gate",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Enforcement",
    help: "Share of outbound flows that check the destination against an approved processor, service, and data-flow record before sending. A gate that only warns is not enforcement.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  dpa: number;
  subprocessor: number;
  gate: number;
  uncovered: number;
  subprocessorGap: number;
  bypass: number;
  processingRisk: number;
  dpaGap: number;
}

function compute(p: Params): Computed {
  const dpa = clamp(num(p, "dpaCoverage", 100), 0, 100);
  const subprocessor = clamp(num(p, "subprocessorCoverage", 100), 0, 100);
  const gate = clamp(num(p, "gateEnforcement", 100), 0, 100);
  const uncovered = 100 - dpa;
  const subprocessorGap = 100 - subprocessor;
  const bypass = 100 - gate;
  const dpaShare = dpa / 100;
  return {
    dpa,
    subprocessor,
    gate,
    uncovered,
    subprocessorGap,
    bypass,
    processingRisk: Math.max(uncovered, dpaShare * subprocessorGap, dpaShare * bypass),
    dpaGap: uncovered,
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
  const processingHealth = healthFor(values.processingRisk, 10, 40);
  const agreementHealth = healthFor(values.dpaGap, 5, 40);
  const registryHealth = healthFor(Math.max(values.dpaGap, values.subprocessorGap), 10, 40);
  const gateHealth = healthFor(values.bypass, 5, 40);
  const subprocessorHealth = healthFor(values.subprocessorGap, 10, 40);
  return {
    t: 0,
    nodes: [
      {
        id: "controller",
        label: "Controller service",
        kind: "service",
        health: "ok",
        utilization: 0.5,
        sublabel: "decides purpose and data",
        detail: "The product that decides why the data is processed and what is sent. The controller keeps the accountability for the processing even when a vendor performs it.",
      },
      {
        id: "onboarding",
        label: "Vendor onboarding",
        kind: "service",
        health: agreementHealth,
        utilization: values.dpaGap / 100,
        sublabel: `${values.dpa.toFixed(0)}% have a covering DPA`,
        detail: "The review step that should block a new processor until the agreement covers the entity, service, data, purpose, and duration.",
      },
      {
        id: "registry",
        label: "Agreement registry",
        kind: "storage",
        health: registryHealth,
        utilization: Math.max(values.dpaGap, values.subprocessorGap) / 100,
        sublabel: `${values.subprocessor.toFixed(0)}% of subprocessors approved`,
        detail: "The system of record for the agreement, service scope, data categories, subprocessors, breach contact, and deletion terms.",
      },
      {
        id: "gate",
        label: "Egress gate",
        kind: "service",
        health: gateHealth,
        utilization: values.bypass / 100,
        sublabel: `${values.gate.toFixed(0)}% of flows checked`,
        detail: "The enforcement point that checks the destination and fields against the registry before data leaves. A warning is not a block.",
      },
      {
        id: "processor",
        label: "Processor",
        kind: "external",
        health: processingHealth,
        utilization: values.processingRisk / 100,
        sublabel: `${values.processingRisk.toFixed(0)}% residual processing risk`,
        detail: "The vendor that processes customer data on the controller's instructions. Its security posture matters, but it does not replace the agreement or the scope.",
      },
      {
        id: "subprocessor",
        label: "Subprocessor",
        kind: "external",
        health: subprocessorHealth,
        utilization: values.subprocessorGap / 100,
        sublabel: `${values.subprocessor.toFixed(0)}% disclosed and approved`,
        detail: "The processor's own vendor. It is part of the data path and needs equivalent obligations, disclosure, and a review path when it changes.",
      },
    ],
    edges: [
      edge("controller-onboarding", "controller", "onboarding", 1, agreementHealth),
      edge("onboarding-gate", "onboarding", "gate", clamp(values.dpa / 100), gateHealth),
      edge("registry-gate", "registry", "gate", clamp(values.subprocessor / 100), registryHealth),
      edge("gate-processor", "gate", "processor", clamp(values.gate / 100), processingHealth),
      edge("processor-subprocessor", "processor", "subprocessor", clamp(values.subprocessor / 100), subprocessorHealth),
    ],
    metrics: [
      metric("processing-risk", "Processing under an inadequate agreement", values.processingRisk, "%", 10, 40, "percent"),
      metric("dpa-gap", "Processors without a covering DPA", values.dpaGap, "%", 5, 40, "percent"),
      metric("subprocessor-gap", "Subprocessors not disclosed or approved", values.subprocessorGap, "%", 10, 40, "percent"),
      metric("flow-bypass", "Flows outside the DPA gate", values.bypass, "%", 5, 40, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.processingRisk.toFixed(0)}% residual processing risk; ${values.dpaGap.toFixed(0)}% of processors lack a covering DPA; ${values.subprocessorGap.toFixed(0)}% of subprocessors are unapproved; ${values.bypass.toFixed(0)}% of flows bypass the gate.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "dpa-gap",
    metricId: "dpa-gap",
    warn: 5,
    crit: 40,
    title: "A processor is handling data without a covering agreement",
    cause:
      "A signed master agreement is not the same as coverage for this service. The DPA has to match the legal entity, the product, the data categories, the purpose, and the duration. A new module, a new region, or a new data type can fall outside the paper that already exists.",
    fix:
      "Stop the flow or remove the data until the agreement covers the service and the payload. Record the scope, the data categories, the purpose, the breach contact, and the deletion terms in the registry, then verify that the gate blocks the same destination until the entry is approved.",
    checkFirst: [
      "Does the agreement name the legal entity and the specific service in use?",
      "Does it cover the data categories and purpose actually sent?",
      "Is the agreement current, or has the service changed since it was signed?",
    ],
  },
  {
    id: "subprocessor-gap",
    metricId: "subprocessor-gap",
    warn: 10,
    crit: 40,
    title: "A subprocessor is outside the approved chain",
    cause:
      "The processor may use its own vendors for hosting, analytics, support, or email. If those subprocessors are not disclosed, approved, and bound by equivalent obligations, the data path has a party the controller never reviewed. A change of subprocessor can happen without a change to your application.",
    fix:
      "Maintain a subprocessor list with an owner and a review date, require notice and approval before a change, and flow down the same obligations. Add the list to the registry and alert on a change that has not been reviewed.",
    checkFirst: [
      "Who are the processor's subcontractors, and where do they process data?",
      "Does the agreement require notice and approval before a new subprocessor?",
      "Are equivalent obligations flowed down to each subprocessor?",
    ],
  },
  {
    id: "flow-bypass",
    metricId: "flow-bypass",
    warn: 5,
    crit: 40,
    title: "A data flow can bypass the agreement gate",
    cause:
      "A manual export, a sidecar integration, or a new pipeline can send data without checking the registry. The contract may be perfect and the flow can still skip it. A gate that only logs a warning leaves the decision to the sender.",
    fix:
      "Enforce a default-deny check in the egress path, require an approved processor, service, and data-flow record, and log the destination and fields. Cover batch, manual, and vendor-initiated flows, and test the gate with an unknown destination.",
    checkFirst: [
      "Which egress paths can reach a processor without passing the gate?",
      "Is the gate enforced at the network or proxy layer or only in application code?",
      "Can a new integration ship before it is registered?",
    ],
  },
];

export const dpaModel: SimModel = {
  id: "compliance-dpa",
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
    if (values.dpaGap >= 40 && frame.flags.agreementEvent !== 1) {
      pushEvent(next, {
        id: "processing-without-dpa",
        at: frame.t,
        severity: "crit",
        title: "A processor is handling data without a covering agreement",
        detail: `${values.dpaGap.toFixed(0)}% of processors lack a covering DPA. Residual processing risk is ${values.processingRisk.toFixed(0)}%, with ${values.subprocessorGap.toFixed(0)}% of subprocessors unapproved and ${values.bypass.toFixed(0)}% of flows bypassing the gate.`,
        nodeId: "processor",
        metricId: "dpa-gap",
      });
      next.flags.agreementEvent = 1;
    }
    if (values.dpaGap < 40) next.flags.agreementEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.processingRisk.toFixed(0)}% residual processing risk; ${values.dpaGap.toFixed(0)}% of processors lack a covering DPA; ${values.subprocessorGap.toFixed(0)}% of subprocessors are unapproved; ${values.bypass.toFixed(0)}% of flows bypass the gate.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${values.dpaGap.toFixed(0)}% of processors lack a covering DPA. Coverage means the entity, service, data categories, purpose, and duration match the actual flow, not that a contract exists somewhere.`,
      `${values.subprocessorGap.toFixed(0)}% of subprocessors are not disclosed or approved. The processor's own vendors are part of the path and need equivalent obligations.`,
      `${values.bypass.toFixed(0)}% of flows can bypass the gate. The contract does not enforce the route; the gate does.`,
      `Residual processing risk is ${values.processingRisk.toFixed(0)}%. It is the weakest of agreement coverage, subprocessor coverage, and gate enforcement, so strong paper does not compensate for an unapproved subprocessor or an open flow.`,
      "The percentages and thresholds are illustrative teaching values, not a legal interpretation or a template for a specific agreement.",
    ];
  },
  legend: [
    { label: "Covered", tone: "ok" },
    { label: "Review", tone: "warn" },
    { label: "Uncovered", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every processor has a covering agreement, subprocessors are disclosed and approved, and every flow checks the registry.",
    tone: "ok",
    params: defaults({ dpaCoverage: 100, subprocessorCoverage: 100, gateEnforcement: 100 }),
  },
  {
    id: "peak",
    label: "New module",
    description: "A new service module is added under an existing agreement, one subprocessor is undisclosed, and part of the egress path bypasses the gate.",
    tone: "warn",
    params: defaults({ dpaCoverage: 85, subprocessorCoverage: 70, gateEnforcement: 80 }),
  },
  {
    id: "failure",
    label: "Rollout first",
    description: "The vendor is already processing data, the agreement covers little of the service, subprocessors are unknown, and flows bypass the gate.",
    tone: "crit",
    params: defaults({ dpaCoverage: 20, subprocessorCoverage: 10, gateEnforcement: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The agreement is scoped to the service, the subprocessor list is approved, and the gate enforces the registry.",
    tone: "ok",
    params: defaults({ dpaCoverage: 100, subprocessorCoverage: 100, gateEnforcement: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-before-rollout",
  title: "Predict what must exist before the first record",
  simId: "dpa",
  question:
    "A new SaaS tool will process customer personal data. The vendor accepts your standard terms and has a current SOC 2 report. What must exist before the first record is sent?",
  prediction: {
    options: [
      { id: "nothing", label: "Nothing. The terms and the report are enough" },
      { id: "dpa", label: "A DPA scoped to the service and data, an approved subprocessor list, and an enforced flow" },
      { id: "soc2", label: "Only the SOC 2 report, because it proves the vendor is secure" },
      { id: "policy", label: "Only an internal privacy policy mentioning the vendor" },
    ],
    correctOptionId: "dpa",
    explanation:
      "The agreement defines the processor's scope and obligations for this service and data. The SOC 2 report gives some assurance about controls over a period, but it does not create the processing terms, cover your specific configuration, or disclose every subprocessor. The flow gate makes the agreement operational before the first record leaves.",
  },
  setup: defaults({ dpaCoverage: 0, subprocessorCoverage: 0, gateEnforcement: 0 }),
  runFor: 20,
  observe: [
    "Residual processing risk is 100% because every layer is uncovered.",
    "The processor and subprocessor nodes fail with the onboarding and gate nodes.",
    "The controller node stays healthy: the accountability sits there, but the vendor path is not covered.",
    "The registry is empty, so there is no evidence of scope, subprocessors, or deletion terms.",
  ],
  explain:
    "A DPA is a prerequisite because it defines what the processor may do with the data, which security and confidentiality obligations apply, how subprocessors are handled, how breaches are reported, how data-subject requests are supported, and what happens at the end of the relationship. The controller remains accountable for the processing. Engineering makes the agreement real by requiring an approved registry entry and a destination check before data leaves.",
  fix: defaults({ dpaCoverage: 100, subprocessorCoverage: 100, gateEnforcement: 100 }),
  debrief:
    "With the agreement scoped, the subprocessors approved, and the gate enforcing the registry, the same vendor can process the data under defined obligations. The report and the contract are complementary: one gives assurance, the other defines the relationship. This is engineering education, not legal advice; the terms, the controller and processor roles, and the transfer analysis belong with counsel and your privacy officer.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A data processing agreement (DPA) is the contract between a controller and a processor that governs how the processor handles personal data. The controller decides the purpose and means of processing; the processor acts on the controller's documented instructions. The agreement defines the subject matter, duration, nature and purpose of the processing, the data categories, the categories of data subjects, and the processor's obligations.",
  },
  {
    type: "p",
    text: "Those obligations typically cover processing only on instructions, confidentiality, security, subprocessor approval, assistance with data-subject rights, assistance with breach handling and impact assessments, deletion or return at the end, and audit or information rights. The exact terms depend on the relationship and the law. For engineering, the useful point is that each clause maps to a system behavior: scope maps to the payload, subprocessors map to the vendor chain, breach notice maps to an incident contact and evidence, and deletion maps to an exit path.",
  },
  {
    type: "p",
    text: "A DPA is not a security certification. A vendor can have a strong report and a weak agreement for your service, or a good agreement and a flow that bypasses it. The agreement creates obligations and accountability; the gate and the registry make it operational. That is why the model scores agreement coverage, subprocessor coverage, and gate enforcement together.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The DPA sits at the onboarding boundary. Before a new processor receives data, the team needs an approved agreement that names the entity and service, a data-flow record that names the fields and purpose, a subprocessor list, a breach contact, and an exit path. The registry is the system of record. The egress gate is the enforcement point. Without the gate, the agreement is a document that a new integration can ignore.",
  },
  {
    type: "table",
    headers: ["Agreement element", "Engineering artifact", "Evidence"],
    rows: [
      ["Scope and purpose", "Data-flow record with fields, purpose, and retention", "Approved registry entry and payload schema"],
      ["Security", "Access control, encryption, logging, and vulnerability process", "Configuration export and review record"],
      ["Subprocessors", "Disclosed list with approval and notice path", "Current list and change history"],
      ["Breach notice", "Contact, escalation path, and incident evidence", "Tested contact and timeline"],
      ["Deletion or return", "Exit workflow and deletion evidence", "Deletion result and retention exception"],
      ["Audit rights", "Questionnaire, report review, or assessment", "Reviewed report and open findings"],
    ],
  },
  {
    type: "p",
    text: "The model treats coverage as a floor and separates three failures: no covering agreement, an unapproved subprocessor, and a flow that can skip the gate. A team can fix one and still fail the other two. The percentages are illustrative; the point is the structure of the risk.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Processing under an inadequate agreement: the residual risk across agreement, subprocessor, and gate coverage.",
      "Processors without a covering DPA: the share whose entity or service is outside the signed scope.",
      "Subprocessors not disclosed or approved: the part of the vendor chain that was never reviewed.",
      "Flows outside the DPA gate: the share of egress that can send without checking the registry.",
      "Node states: onboarding, registry, gate, processor, and subprocessor show where the chain broke.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply New module and watch the agreement gap and the gate bypass diverge. Apply Rollout first to see the vendor already processing under an inadequate agreement. Run the experiment before revealing the explanation, then apply Recovery and verify that the same flow is covered by the registry and the gate.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The required terms, the controller and processor roles, international transfers, and the validity of a specific agreement depend on the law and the facts. Have counsel and your privacy officer review the agreement and the relationship before data flows.",
  },
  { type: "sim", simId: "dpa" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The vendor was already processing data before the agreement covered the service. The onboarding and registry nodes failed, the gate let the flow through, and the subprocessor list was unknown. The controller node stayed healthy because the accountability did not move; the processor path was the part without coverage.",
  },
  {
    type: "p",
    text: "Scoping the agreement, approving the subprocessors, and enforcing the gate cleared the risk. The same vendor and the same payload were now covered, not because the vendor changed but because the relationship and the flow were defined. That is the engineering value of a DPA: it turns a legal document into a gate condition and a registry entry.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A vendor registry with entity, service, data categories, purpose, subprocessors, breach contact, and deletion terms.",
      "An onboarding gate that blocks a processor until the agreement and data-flow record are approved.",
      "An egress check that uses the registry as its source of truth and defaults to deny.",
      "A subprocessor change process with notice, review, and an updated list.",
      "Exit evidence: access revoked, data deleted or returned, and the deletion confirmed.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Name the legal entity, service, data categories, and purpose actually in use.",
      "Check that the agreement covers that scope and is current.",
      "List the processor's subprocessors and confirm they are disclosed and approved.",
      "Find every egress path that can reach the processor, including batch and manual flows.",
      "Verify the gate defaults to deny and uses the registry.",
      "Confirm the breach contact and the deletion or return path.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the uncovered flow or remove the data until the agreement is scoped.",
      "Record the entity, service, data categories, purpose, and duration in one registry.",
      "Disclose and approve the subprocessors, with equivalent obligations.",
      "Enforce a default-deny destination check in the egress path.",
      "Test the breach contact and the deletion or return path.",
      "Re-review the agreement when the service, data, or subprocessor list changes.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A strict onboarding gate slows procurement and prevents uncovered processing; a warning-only check is faster and leaves the risk to the sender.",
      "A broad master agreement is quicker to sign and may not cover a new service or data type; service-level scoping is more work and more defensible.",
      "A central registry improves evidence and adds a dependency; a per-team spreadsheet is cheaper until the first audit or incident.",
      "Requiring notice before a subprocessor change reduces surprises and can slow the vendor; retrospective notice is easier and weaker.",
      "Minimizing the payload reduces the agreement scope and can remove useful functionality; field-level review is the tradeoff.",
      "Automated deletion evidence improves exit confidence and takes engineering time; a manual confirmation is cheaper and harder to test.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "dpa-needed",
    question: "A new vendor will process customer data. How do you decide whether a DPA is needed and what it must cover?",
    difficulty: 2,
    hints: [
      "Start with the role and the data, not the vendor's product category.",
      "Coverage means entity, service, data, purpose, and duration.",
    ],
    answer:
      "I would confirm that the vendor processes personal data on our instructions and is therefore acting as a processor for this service. Then I would scope the agreement to the legal entity, the specific service, the data categories, the purpose, the duration, and the subprocessors. I would check the security, confidentiality, breach notice, data-subject assistance, deletion or return, and audit terms, and record the scope in the registry. If the vendor is a controller for part of the processing, or the data crosses a border, the analysis changes and belongs with counsel and privacy.",
    followUps: [
      "What if the vendor only sees encrypted data it cannot read?",
      "How do you handle a vendor that is a controller for some data?",
      "What changes when the vendor adds a new region?",
    ],
    redFlags: [
      "Treats a security report as the agreement.",
      "Assumes the master agreement covers every service.",
      "Ignores subprocessors and data categories.",
    ],
    rubric: [
      "Confirms the processor role.",
      "Scopes entity, service, data, and purpose.",
      "Checks the key obligations.",
      "Escalates role and transfer questions.",
    ],
  },
  {
    id: "paper-vs-flow",
    question: "The DPA is signed. What still has to be true in the system before you call the vendor covered?",
    difficulty: 3,
    hints: [
      "A contract does not enforce a route.",
      "The registry and the egress gate are separate controls.",
    ],
    answer:
      "The agreement has to match the actual flow, and the flow has to pass through a gate that checks the destination against the registry. The registry should hold the entity, service, data categories, purpose, subprocessors, breach contact, and deletion terms. The gate should default to deny, log the destination and fields, and block an unknown or unapproved destination. I would also test the breach contact and the deletion path, because those obligations are easy to sign and hard to operate. A signed document with an open flow is not coverage.",
    followUps: [
      "Where would you enforce the gate?",
      "How do you detect a flow that bypasses it?",
      "What evidence would you keep for the agreement?",
    ],
    redFlags: [
      "Stops at the signature.",
      "Has no registry or gate.",
      "Assumes application code covers every path.",
    ],
    rubric: [
      "Connects the agreement to a flow.",
      "Uses a registry and a gate.",
      "Covers batch and manual paths.",
      "Tests operational obligations.",
    ],
  },
  {
    id: "subprocessor-change",
    question: "A processor adds a new subprocessor without telling you. How do you detect and handle it?",
    difficulty: 3,
    hints: [
      "The change may not touch your application.",
      "Notice, approval, and flow-down are separate checks.",
    ],
    answer:
      "I would start with the agreement's notice requirement and a maintained subprocessor list, then compare the vendor's current list against the approved one on a schedule and on every review. I would also monitor the vendor's trust or status page for changes and require an approval step before a new subprocessor receives data. If one appears without approval, I would assess the data and location, pause the affected flow if needed, and require flow-down obligations and a review. The goal is to make a silent change visible, not to rely on the vendor's good intentions.",
    followUps: [
      "What would you do if the subprocessor is essential to the service?",
      "How do you verify the flow-down terms?",
      "How often would you re-check the list?",
    ],
    redFlags: [
      "Trusts the vendor to disclose every change.",
      "Has no approved list to compare against.",
      "Waits for an incident to review.",
    ],
    rubric: [
      "Uses notice and an approved list.",
      "Checks on a schedule.",
      "Assesses data and location.",
      "Requires flow-down and review.",
    ],
  },
];

const checklist = [
  {
    title: "Before onboarding",
    items: [
      "Confirm the processor role and the data categories, purpose, and duration.",
      "Check that the agreement covers the legal entity and the specific service.",
      "Collect and approve the subprocessor list.",
      "Record the breach contact, deletion terms, and exit path.",
    ],
  },
  {
    title: "At the boundary",
    items: [
      "Add the processor, service, fields, and purpose to the registry.",
      "Enforce a default-deny destination check in the egress path.",
      "Log the destination, fields, and decision for every flow.",
      "Alert on unknown destinations and unapproved subprocessor changes.",
    ],
  },
  {
    title: "After a change",
    items: [
      "Re-scope the agreement when the service, data, or region changes.",
      "Re-approve the subprocessor list and verify flow-down.",
      "Test the breach contact and the deletion or return path.",
      "Remove stale approvals and update the evidence.",
    ],
  },
];

const references = [
  {
    title: "Regulation (EU) 2016/679, Article 28 (Processor)",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    publisher: "Official Journal of the European Union",
    kind: "standard" as const,
    note: "The official text on processors, the required contract terms, and subprocessor obligations.",
  },
  {
    title: "Guidelines 07/2020 on the concepts of controller and processor in the GDPR",
    url: "https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-072020-concepts-controller-and-processor-gdpr_en",
    publisher: "European Data Protection Board",
    kind: "docs" as const,
    note: "Guidance on distinguishing controller and processor roles and applying the processor obligations.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    dpa: {
      model: dpaModel,
      presets,
      instructions:
        "Start Healthy, then apply New module and compare the agreement gap with the gate bypass. Apply Rollout first to see processing under an inadequate agreement. Run the experiment before revealing the explanation, then apply Recovery and confirm that the registry and gate cover the same flow.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 5/40, 10/40, and 5/40 thresholds are teaching values, not legal requirements or a contract template.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-baa", "compliance-vendor-risk", "compliance-subprocessors"],
};
