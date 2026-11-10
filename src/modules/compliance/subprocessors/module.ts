import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUIRED_NOTICE_DAYS = 30;

const params = [
  {
    id: "inventoryCoverage",
    label: "Subprocessors in the inventory",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Inventory",
    help: "Share of the vendor's subcontractors that are listed with their role, data access, and region. A fourth party that is not in the inventory cannot be approved or found during an incident.",
    format: "percent" as const,
  },
  {
    id: "flowDownCoverage",
    label: "Subprocessors bound by equivalent terms",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Terms",
    help: "Share of subcontractors bound by security, breach notice, deletion, audit, and residency obligations equivalent to the primary contract. A promise from the vendor is not the same as a binding term.",
    format: "percent" as const,
  },
  {
    id: "noticeDays",
    label: "Advance notice before a change",
    min: 0,
    max: 180,
    step: 5,
    value: 60,
    unit: " days",
    group: "Change",
    help: "Days of notice the vendor must give before adding or changing a subprocessor. The demo uses a 30-day teaching minimum; the real period comes from the contract and the regulation.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  inventory: number;
  flowDown: number;
  notice: number;
  inventoryGap: number;
  flowDownGap: number;
  noticeShortfall: number;
  exposure: number;
}

function compute(p: Params): Computed {
  const inventory = clamp(num(p, "inventoryCoverage", 100), 0, 100);
  const flowDown = clamp(num(p, "flowDownCoverage", 100), 0, 100);
  const notice = Math.round(clamp(num(p, "noticeDays", 60), 0, 180));
  const inventoryGap = 100 - inventory;
  const flowDownGap = 100 - flowDown;
  const noticeShortfall = Math.max(0, REQUIRED_NOTICE_DAYS - notice);
  return {
    inventory,
    flowDown,
    notice,
    inventoryGap,
    flowDownGap,
    noticeShortfall,
    exposure: Math.max(inventoryGap, flowDownGap, Math.min(100, noticeShortfall * 4)),
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
  const inventoryHealth = healthFor(values.inventoryGap, 10, 40);
  const termsHealth = healthFor(values.flowDownGap, 10, 40);
  const exposureHealth = healthFor(values.exposure, 15, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "controller",
        label: "Your service",
        kind: "service",
        health: "ok",
        utilization: 0.5,
        sublabel: "decides the purpose and data",
        detail: "The product that sends regulated data to the vendor. It keeps accountability for the processing and for the promises made to customers.",
      },
      {
        id: "processor",
        label: "Primary vendor",
        kind: "external",
        health: exposureHealth,
        utilization: values.exposure / 100,
        sublabel: `${values.inventory.toFixed(0)}% of its chain disclosed`,
        detail: "The direct processor. It may use other companies for infrastructure, support, analytics, or backups without changing your direct contract.",
      },
      {
        id: "register",
        label: "Subprocessor register",
        kind: "storage",
        health: inventoryHealth,
        utilization: values.inventoryGap / 100,
        sublabel: `${values.inventory.toFixed(0)}% listed with region`,
        detail: "The maintained list of fourth parties, their role, data categories, region, and approval state. It is the source of truth during a change or an incident.",
      },
      {
        id: "terms",
        label: "Flow-down terms",
        kind: "storage",
        health: termsHealth,
        utilization: values.flowDownGap / 100,
        sublabel: `${values.flowDown.toFixed(0)}% bound equivalently`,
        detail: "Security, breach notice, deletion, audit, and residency obligations that follow the data into the subcontractor's hands.",
      },
      {
        id: "subprocessor",
        label: "Fourth party",
        kind: "external",
        health: exposureHealth,
        utilization: values.exposure / 100,
        sublabel: "new or changed subcontractor",
        detail: "The subcontractor that actually receives the data. It may sit in a different region, use a different platform, or have a different incident process.",
      },
      {
        id: "region",
        label: "Approved region",
        kind: "mesh",
        health: exposureHealth,
        utilization: values.exposure / 100,
        sublabel: values.exposure > 0 ? "region promise at risk" : "EU processing path intact",
        detail: "The residency boundary promised to the customer. A subcontractor outside the boundary breaks the promise even if the primary vendor is inside it.",
      },
    ],
    edges: [
      edge("controller-processor", "controller", "processor", 1, exposureHealth),
      edge("processor-subprocessor", "processor", "subprocessor", 1, exposureHealth),
      edge("register-processor", "register", "processor", clamp(values.inventory / 100), inventoryHealth),
      edge("processor-terms", "processor", "terms", clamp(values.flowDown / 100), termsHealth),
      edge("terms-subprocessor", "terms", "subprocessor", clamp(values.flowDown / 100), termsHealth),
      edge("subprocessor-region", "subprocessor", "region", clamp(1 - values.exposure / 100), exposureHealth),
    ],
    metrics: [
      metric("inventory-gap", "Subprocessors missing from the inventory", values.inventoryGap, "%", 10, 40, "percent"),
      metric("flow-down-gap", "Subprocessors without equivalent terms", values.flowDownGap, "%", 10, 40, "percent"),
      metric("notice-shortfall", "Notice short of the required window", values.noticeShortfall, " days", 1, 15, "count"),
      metric("unapproved-exposure", "Regulated data at an unreviewed fourth party", values.exposure, "%", 15, 50, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.inventoryGap.toFixed(0)}% of subprocessors are missing from the inventory; ${values.flowDownGap.toFixed(0)}% lack equivalent terms; notice is ${values.noticeShortfall} days short of the ${REQUIRED_NOTICE_DAYS}-day teaching minimum.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "inventory-gap",
    metricId: "inventory-gap",
    warn: 10,
    crit: 40,
    title: "A subprocessor is missing from the inventory",
    cause:
      "A fourth party that nobody recorded can still receive regulated data. The inventory is the only way to answer which region, which controls, and which data categories are involved when the vendor changes its chain or an incident starts.",
    fix:
      "Require disclosure of every subcontractor with its role, data access, region, and approval state. Reconcile the vendor's list against the register on a schedule, and make a missing entry block the vendor change rather than trigger a cleanup later.",
    checkFirst: [
      "Which subprocessors can reach regulated data?",
      "Which regions are recorded, and when was the register last reconciled?",
      "Does the contract require notice before a new subcontractor is used?",
    ],
  },
  {
    id: "flow-down-gap",
    metricId: "flow-down-gap",
    warn: 10,
    crit: 40,
    title: "Equivalent obligations do not follow the data",
    cause:
      "The primary contract can be strong while the subcontractor is bound by weaker security, breach, deletion, or residency terms. The data does not respect the contracting structure; the fourth party's failure is still your incident.",
    fix:
      "Flow down security, breach notice, deletion, audit, and residency obligations to every subcontractor that can reach the data. Verify the clause in the subcontract rather than relying on the vendor's statement, and review the chain when the vendor changes platform or region.",
    checkFirst: [
      "Does the subcontract actually contain the obligations, or only reference them?",
      "Which subcontractors can reach regulated data without equivalent terms?",
      "Who reviews the flow-down when the vendor changes its platform?",
    ],
  },
  {
    id: "notice-shortfall",
    metricId: "notice-shortfall",
    warn: 1,
    crit: 15,
    title: "The vendor can change the chain before review",
    cause:
      "Notice is not approval. A short notice period can leave no time to assess the new region or the new controls before data moves, and an objection right that arrives after the change is not a control.",
    fix:
      "Set a notice period that leaves room for review and objection, make the change require approval before data flows, and record the decision. If the vendor already moved the data, treat it as an incident and check residency and contract exposure.",
    checkFirst: [
      "How many days of notice does the contract require?",
      "Is approval required before the change, or only notification?",
      "Can the team block the flow while the review is open?",
    ],
  },
];

export const subprocessorsModel: SimModel = {
  id: "compliance-subprocessors",
  visual: "topology",
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
    if (values.exposure >= 50 && frame.flags.exposureEvent !== 1) {
      const gaps = [
        { title: "A subprocessor is missing from the inventory", nodeId: "register", metricId: "inventory-gap", value: values.inventoryGap },
        { title: "Equivalent obligations do not follow the data", nodeId: "terms", metricId: "flow-down-gap", value: values.flowDownGap },
        { title: "The vendor can change the chain before review", nodeId: "processor", metricId: "notice-shortfall", value: Math.min(100, values.noticeShortfall * 4) },
      ];
      const gap = gaps.reduce((best, item) => (item.value > best.value ? item : best));
      pushEvent(next, {
        id: "unapproved-subprocessor",
        at: frame.t,
        severity: "crit",
        title: gap.title,
        detail: `Exposure is ${values.exposure.toFixed(0)}%, led by ${gap.metricId}. ${values.inventoryGap.toFixed(0)}% of subprocessors are missing from the inventory, ${values.flowDownGap.toFixed(0)}% lack equivalent terms, and notice is ${values.noticeShortfall} days short of the ${REQUIRED_NOTICE_DAYS}-day minimum.`,
        nodeId: gap.nodeId,
        metricId: gap.metricId,
      });
      next.flags.exposureEvent = 1;
    }
    if (values.exposure < 50) next.flags.exposureEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.inventoryGap.toFixed(0)}% of subprocessors are missing from the inventory; ${values.flowDownGap.toFixed(0)}% lack equivalent terms; notice is ${values.noticeShortfall} days short of the ${REQUIRED_NOTICE_DAYS}-day teaching minimum.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The exposure floor is ${values.exposure.toFixed(0)}%, set by the weakest of inventory, flow-down terms, and notice. A complete inventory does not help if the terms do not follow the data.`,
      `${values.inventoryGap.toFixed(0)}% of subprocessors are missing from the register. Without a region and data category, the team cannot tell whether a residency promise is still true.`,
      `${values.flowDownGap.toFixed(0)}% of subcontractors lack equivalent obligations. The direct contract allocates responsibility, but the fourth party's controls decide what happens to the data.`,
      `Notice is ${values.noticeShortfall} days short of the ${REQUIRED_NOTICE_DAYS}-day teaching minimum. Notice is only useful if it arrives before the data moves and the team can object.`,
      "The percentages, the 30-day notice minimum, and the 10/40 and 1/15 thresholds are illustrative teaching values. Real obligations come from the contract and applicable law.",
    ];
  },
  legend: [
    { label: "Approved", tone: "ok" },
    { label: "In review", tone: "warn" },
    { label: "Unapproved", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every subprocessor is listed with its region, bound by equivalent terms, and the vendor gives 60 days of notice before a change.",
    tone: "ok",
    params: defaults({ inventoryCoverage: 100, flowDownCoverage: 100, noticeDays: 60 }),
  },
  {
    id: "peak",
    label: "Vendor update",
    description: "The register is mostly current, some terms are stale, and the vendor gave 20 days of notice for a new analytics provider.",
    tone: "warn",
    params: defaults({ inventoryCoverage: 85, flowDownCoverage: 80, noticeDays: 20 }),
  },
  {
    id: "failure",
    label: "Undisclosed chain",
    description: "Most subprocessors are absent from the register, the terms did not flow down, and the vendor can change the chain with no notice.",
    tone: "crit",
    params: defaults({ inventoryCoverage: 20, flowDownCoverage: 10, noticeDays: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The register is complete, equivalent terms are verified, and notice leaves time for review before data moves.",
    tone: "ok",
    params: defaults({ inventoryCoverage: 100, flowDownCoverage: 100, noticeDays: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-notice",
  title: "Predict whether notice is enough",
  simId: "subprocessors",
  question:
    "A vendor announces a new subprocessor in another region with 10 days of notice. The contract requires 30 days and an EU-only data path. What is the right response?",
  prediction: {
    options: [
      { id: "accept", label: "Accept. The vendor gave notice, so the change is approved" },
      { id: "review", label: "Treat it as a material change: review the region and terms, object or block the flow, and update the register" },
      { id: "contract", label: "Wait for the next renewal and add the region then" },
      { id: "encrypt", label: "Accept if the new subprocessor encrypts the data at rest" },
    ],
    correctOptionId: "review",
    explanation:
      "Notice starts a review; it does not grant approval. A new region can break the residency promise, and the subcontractor needs equivalent terms before it receives regulated data. The team should use the objection right, block or narrow the flow if it can, and record the decision.",
  },
  setup: defaults({ inventoryCoverage: 90, flowDownCoverage: 60, noticeDays: 10 }),
  runFor: 20,
  observe: [
    "Notice is 20 days short of the minimum and crosses the critical threshold.",
    "The flow-down gap is 40% and the fourth-party node fails.",
    "The approved-region node is marked critical even though the primary vendor is in the EU.",
    "Restoring the inventory alone does not clear the exposure while the terms and notice remain weak.",
  ],
  explain:
    "The data path includes the fourth party. A vendor that is approved in the EU can still send data to a subcontractor elsewhere, and a notice period that ends after the change is not a review gate. The fix is a chain-level control: disclosure, approval before the flow, equivalent terms, and a register that states the region.",
  fix: defaults({ inventoryCoverage: 100, flowDownCoverage: 100, noticeDays: 45 }),
  debrief:
    "With the chain disclosed, the terms flowed down, and enough notice to review, the same vendor change can be approved or rejected before data moves. The lesson is that subprocessor management is change management for the data path, not a static list. The values are illustrative teaching values.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A subprocessor is a company that a vendor uses to process data on your behalf. The vendor signs the direct contract, but the subcontractor may run the infrastructure, provide support, or perform analytics. Under the GDPR, a processor needs authorization for subcontracting, must give notice of changes, and must flow down equivalent data protection obligations. The same pattern appears in other regimes and in customer contracts.",
  },
  {
    type: "p",
    text: "The engineering problem is that the data path is longer than the contract. A vendor can add a subprocessor in another region without changing your integration, your architecture diagram, or your direct relationship. If the register is incomplete, the first signal may be a customer or auditor asking where the data is processed. If the terms did not flow down, the fourth party may have weaker security, breach, or deletion obligations.",
  },
  {
    type: "p",
    text: "Managing the chain has four parts: notice before a change, approval before data moves, flow-down terms that bind the fourth party, and an inventory that records the role, data, and region. Each part can fail independently. A complete inventory with no flow-down terms is a map of a risk you cannot control.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The chain starts inside the product. A service sends regulated data to the primary processor, which may pass it to a subcontractor. The register and the flow-down terms sit beside that path, and the residency boundary sits around it. A new subprocessor is a change to the path even when the product code does not change.",
  },
  {
    type: "table",
    headers: ["Control", "Question it answers", "Evidence"],
    rows: [
      ["Notice", "Will we learn about the change before data moves?", "Contract notice period, change record, vendor communication"],
      ["Approval", "Did we review the new party and region?", "Approval decision, assessment, data-flow record"],
      ["Flow-down", "Are equivalent obligations binding?", "Subcontract clause, security terms, deletion and breach terms"],
      ["Inventory", "Can we find the fourth party later?", "Register with role, data categories, region, and owner"],
    ],
  },
  {
    type: "p",
    text: "Residency is the sharpest example. The primary vendor may be in the approved region while a support tool or a backup subcontractor is elsewhere. The customer promise is about the data, not about the entity named on the invoice.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Subprocessors missing from the inventory: the share not listed with a role and region.",
      "Subprocessors without equivalent terms: the flow-down gap.",
      "Notice short of the required window: how many days late the change arrives for review.",
      "Regulated data at an unreviewed fourth party: the combined exposure.",
      "Node states: your service, primary vendor, register, flow-down terms, fourth party, and approved region.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Vendor update and watch notice and terms move before the inventory does. Apply Undisclosed chain to see the fourth party and region fail together. Run the experiment before revealing the explanation, then apply Recovery and confirm all three controls are needed.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The 30-day notice minimum, percentages, and thresholds are illustrative. Real obligations come from the contract, the applicable law, and the data being processed.",
  },
  {
    type: "p",
    text: "The useful question is not whether the vendor has a subprocessor list. It is whether the list is current, whether the terms follow the data, and whether a change can be stopped before the fourth party receives it.",
  },
  { type: "sim", simId: "subprocessors" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The exposure floor stayed high because three controls failed separately. The register was mostly complete, but the terms covered only 60% of the chain and the notice arrived 20 days short of the review window. The fourth party and the region failed together because the data path, not the direct vendor, was the unit of risk.",
  },
  {
    type: "p",
    text: "Restoring the inventory did not clear the region node. That is the practical lesson: knowing about a subprocessor is not the same as approving it or binding it to the same obligations. The change has to be reviewed before the data moves.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Register: subprocessor, role, data categories, region, approval state, and owner.",
      "Contract: notice period, objection right, flow-down clause, and audit rights.",
      "Change: vendor announcement, review deadline, decision, and data-flow record.",
      "Residency: actual processing regions against the customer promise.",
      "Incident: which fourth parties are in the affected path and who to contact.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Pull the vendor's current subprocessor list and reconcile it with the register.",
      "Check the region and data categories for every fourth party.",
      "Verify the flow-down clause in the subcontract, not only in the master agreement.",
      "Confirm the notice period and whether approval is required before data moves.",
      "Test a recent change: when did notice arrive, and who approved it?",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Require disclosure of every subprocessor with role, data, and region.",
      "Set a notice period that leaves time for review and objection.",
      "Make approval a gate before the data flows, not a notification after it.",
      "Flow down security, breach, deletion, audit, and residency terms.",
      "Reconcile the register on a schedule and after every material change.",
      "Treat an undisclosed or out-of-region change as an incident.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More disclosure improves visibility but adds vendor management work and can slow procurement.",
      "A strict approval gate protects residency and control quality but can delay a vendor's release.",
      "Longer notice protects review time and may be hard to negotiate with large vendors.",
      "A central register simplifies discovery but becomes stale unless reconciliation is automated.",
      "Requiring every subcontractor to accept full flow-down terms can reduce the vendor pool; the alternative is accepting an unreviewed chain.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "subprocessor-basics",
    question: "What is a subprocessor, and why does it need separate controls from the vendor?",
    difficulty: 2,
    hints: [
      "The data goes to a company you did not contract with directly.",
      "The processor needs authorization to subcontract.",
    ],
    answer:
      "A subprocessor is a company the vendor uses to process data on your behalf. It needs separate controls because it receives the data under the vendor's contract, not yours. The processor should have authorization to subcontract, give notice of changes, and flow down equivalent obligations. I would keep it in the inventory with its role, data, and region, and treat a new one as a material change to the data path.",
    followUps: [
      "Does every subcontractor need the same terms?",
      "Who is responsible if the subprocessor breaches?",
      "How does the answer change for a support tool that only sees metadata?",
    ],
    redFlags: [
      "Says the vendor owns all subcontractor risk.",
      "Has no inventory.",
      "Treats notice as approval.",
    ],
    rubric: [
      "Defines the fourth-party relationship.",
      "Requires authorization and flow-down.",
      "Keeps an inventory.",
      "Treats change as material.",
    ],
  },
  {
    id: "notice-change",
    question: "A vendor gives 10 days of notice for a new subprocessor in another region. Walk through your response.",
    difficulty: 3,
    hints: [
      "Check the contract period and the objection right.",
      "The region may break a customer promise.",
    ],
    answer:
      "I would confirm the contractual notice period and whether approval is required before data moves. Then I would identify the data categories, the region, and the systems involved, and review the subprocessor's terms and controls. If the change violates the notice period or the residency promise, I would object through the contract and block or narrow the flow if possible. I would update the register and record the decision. If the data already moved, I would treat it as an incident and assess notification and customer impact.",
    followUps: [
      "What if the vendor says the change is already live?",
      "Who can approve an exception?",
      "What evidence would you keep?",
    ],
    redFlags: [
      "Accepts because notice was given.",
      "Ignores the region.",
      "Has no way to block the flow.",
    ],
    rubric: [
      "Checks notice and approval rights.",
      "Reviews region and terms.",
      "Blocks or escalates.",
      "Records the decision.",
    ],
  },
  {
    id: "flow-down",
    question: "How do you verify that obligations actually flow down to a subcontractor?",
    difficulty: 2,
    hints: [
      "Read the subcontract, not the vendor's summary.",
      "The obligations must be enforceable and current.",
    ],
    answer:
      "I would ask for the relevant subcontract terms or a redacted extract and check that security, breach notice, deletion, audit, and residency obligations are binding on the subcontractor. I would confirm the version is current and covers the service and data in scope. A vendor statement or a trust page is not the same as the clause. If the terms are missing, I would treat the subprocessor as unapproved until they are in place.",
    followUps: [
      "What if the vendor refuses to share the subcontract?",
      "Which obligations matter most for regulated data?",
      "How do you check the terms after a vendor acquisition?",
    ],
    redFlags: [
      "Trusts a trust-center summary.",
      "Checks only the master agreement.",
      "Does not verify the current version.",
    ],
    rubric: [
      "Reads the binding terms.",
      "Covers security, breach, deletion, audit, and residency.",
      "Confirms currency and scope.",
      "Blocks until resolved.",
    ],
  },
  {
    id: "residency-breach",
    question: "A customer says their data was processed outside the promised region by a subcontractor. What now?",
    difficulty: 3,
    hints: [
      "Contain the flow and establish the facts.",
      "The primary vendor's location is not the answer.",
    ],
    answer:
      "I would trace the actual data flow from the service through the primary processor to the subcontractor, identify the data categories and time window, and stop or narrow the flow if possible. Then I would engage legal and the customer process, because the residency promise and the contract may create notification obligations. I would preserve the evidence and check whether other customers or regions are affected. The remediation is to move the processing back in-region or obtain an approved change, then fix the notice and inventory controls that missed it.",
    followUps: [
      "What would you tell the customer first?",
      "How do you find other affected data paths?",
      "Which control failed: notice, approval, flow-down, or inventory?",
    ],
    redFlags: [
      "Relies on the vendor's assurance.",
      "Waits for the renewal.",
      "Does not check other customers.",
    ],
    rubric: [
      "Traces the actual flow.",
      "Contains and preserves evidence.",
      "Engages legal and customer process.",
      "Fixes the chain control.",
    ],
  },
];

const checklist = [
  {
    title: "Inventory",
    items: [
      "List every subprocessor with role, data categories, region, and owner.",
      "Reconcile the vendor's list against the register.",
      "Flag entries with no region or no approval state.",
      "Check for subcontractors added since the last review.",
    ],
  },
  {
    title: "Terms",
    items: [
      "Verify the notice period and objection right.",
      "Confirm security, breach, deletion, audit, and residency terms flow down.",
      "Check the current version and the services it covers.",
      "Treat missing terms as an unapproved subprocessor.",
    ],
  },
  {
    title: "Change",
    items: [
      "Review the region and data before the change goes live.",
      "Record the approval or objection and the reason.",
      "Block or narrow the flow if the change is not approved.",
      "Re-test residency after the change.",
    ],
  },
];

const references = [
  {
    title: "GDPR Article 28, Processor",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    publisher: "European Union",
    kind: "standard" as const,
    note: "Official text covering processor obligations, authorization of subprocessors, and flow-down terms.",
  },
  {
    title: "EDPB Guidelines 07/2020 on controller and processor concepts",
    url: "https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-072020-concepts-controller-and-processor-gdpr_en",
    publisher: "European Data Protection Board",
    kind: "docs" as const,
    note: "Guidance on controller and processor roles, including subprocessor authorization and change notice.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    subprocessors: {
      model: subprocessorsModel,
      presets,
      instructions:
        "Start Healthy, then apply Vendor update and Undisclosed chain. Compare inventory coverage with flow-down terms and notice. Run the experiment before revealing the explanation, then apply Recovery and check that the region node clears only when all three controls are healthy.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages, the 30-day notice minimum, and the 10/40 and 1/15 thresholds are teaching values. Real obligations come from the contract, applicable law, and the data.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-vendor-risk", "compliance-dpa", "compliance-data-residency"],
};
