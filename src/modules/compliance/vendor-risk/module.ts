import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "tiering",
    label: "Vendors assigned a criticality tier",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Portfolio",
    help: "Share of vendors whose tier is based on data access, availability dependency, and how replaceable they are. A vendor that can stop revenue or reach regulated data is not a low-risk purchase.",
    format: "percent" as const,
  },
  {
    id: "assessment",
    label: "Critical vendors assessed to tier depth",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Assessment",
    help: "Share of critical vendors with a current review that covers security, availability, data handling, and contract terms. One generic questionnaire is not tier depth.",
    format: "percent" as const,
  },
  {
    id: "subprocessorVisibility",
    label: "Subcontractors disclosed and reviewed",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Chain",
    help: "Share of a vendor's subcontractors that are listed, reviewed, and bound by equivalent obligations. The vendor's vendors are still part of your data path.",
    format: "percent" as const,
  },
  {
    id: "exitReadiness",
    label: "Critical vendors with a tested exit",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Continuity",
    help: "Share of critical vendors with a documented export format, an alternate path, a termination clause, and a test that the data can actually leave. A contract clause is not an exit plan.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tiering: number;
  assessment: number;
  subprocessor: number;
  exit: number;
  tierGap: number;
  assessmentGap: number;
  subprocessorGap: number;
  exitGap: number;
  exposure: number;
}

function compute(p: Params): Computed {
  const tiering = clamp(num(p, "tiering", 100), 0, 100);
  const assessment = clamp(num(p, "assessment", 100), 0, 100);
  const subprocessor = clamp(num(p, "subprocessorVisibility", 100), 0, 100);
  const exit = clamp(num(p, "exitReadiness", 100), 0, 100);
  const tierGap = 100 - tiering;
  const assessmentGap = 100 - assessment;
  const subprocessorGap = 100 - subprocessor;
  const exitGap = 100 - exit;
  return {
    tiering,
    assessment,
    subprocessor,
    exit,
    tierGap,
    assessmentGap,
    subprocessorGap,
    exitGap,
    exposure: Math.max(tierGap, assessmentGap, subprocessorGap, exitGap),
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

function primaryGap(values: Computed): { title: string; nodeId: string; metricId: string; value: number } {
  const gaps = [
    { title: "A vendor has no criticality tier", nodeId: "tier", metricId: "tier-gap", value: values.tierGap },
    { title: "A critical vendor has no current assessment", nodeId: "assessment", metricId: "unassessed-critical", value: values.assessmentGap },
    { title: "Subcontractors are outside the review", nodeId: "subprocessor", metricId: "subprocessor-gap", value: values.subprocessorGap },
    { title: "A critical vendor has no tested exit", nodeId: "exit", metricId: "exit-gap", value: values.exitGap },
  ];
  return gaps.reduce((best, item) => (item.value > best.value ? item : best));
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const tierHealth = healthFor(values.tierGap, 10, 40);
  const assessmentHealth = healthFor(values.assessmentGap, 10, 40);
  const subprocessorHealth = healthFor(values.subprocessorGap, 10, 40);
  const exitHealth = healthFor(values.exitGap, 15, 50);
  const portfolioHealth = healthFor(values.exposure, 15, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "intake",
        label: "Vendor intake",
        kind: "service",
        health: "ok",
        utilization: 0.5,
        sublabel: "new purchase or renewal",
        detail: "The point where a vendor enters the portfolio. Intake should ask what data, what availability dependency, and what happens if the vendor disappears.",
      },
      {
        id: "tier",
        label: "Criticality register",
        kind: "storage",
        health: tierHealth,
        utilization: values.tierGap / 100,
        sublabel: `${values.tiering.toFixed(0)}% assigned a tier`,
        detail: "The register that records tier, owner, data categories, systems affected, and review date. Without a tier, assessment depth becomes arbitrary.",
      },
      {
        id: "assessment",
        label: "Security assessment",
        kind: "worker",
        health: assessmentHealth,
        utilization: values.assessmentGap / 100,
        sublabel: `${values.assessment.toFixed(0)}% of critical vendors current`,
        detail: "Security, availability, data handling, and contract review at the depth the tier requires. A completed questionnaire is one input, not the whole review.",
      },
      {
        id: "data",
        label: "Customer data path",
        kind: "db",
        health: portfolioHealth,
        utilization: values.exposure / 100,
        sublabel: `${values.exposure.toFixed(0)}% portfolio exposure`,
        detail: "The data and transaction path that depends on the vendor. A vendor outage can interrupt availability even when it never stores customer records.",
      },
      {
        id: "subprocessor",
        label: "Subcontractor inventory",
        kind: "storage",
        health: subprocessorHealth,
        utilization: values.subprocessorGap / 100,
        sublabel: `${values.subprocessor.toFixed(0)}% disclosed and reviewed`,
        detail: "The vendor's own subcontractors, regions, and data flows. An undisclosed fourth party can break a residency promise or inherit weaker controls.",
      },
      {
        id: "exit",
        label: "Tested exit path",
        kind: "storage",
        health: exitHealth,
        utilization: values.exitGap / 100,
        sublabel: `${values.exit.toFixed(0)}% have a tested export`,
        detail: "The export format, alternate provider, termination assistance, and a restore or migration test. The test is what separates a clause from a plan.",
      },
    ],
    edges: [
      edge("intake-tier", "intake", "tier", clamp(values.tiering / 100), tierHealth),
      edge("tier-assessment", "tier", "assessment", clamp(values.assessment / 100), assessmentHealth),
      edge("assessment-data", "assessment", "data", clamp(values.assessment / 100), portfolioHealth),
      edge("data-subprocessor", "data", "subprocessor", clamp(values.subprocessor / 100), subprocessorHealth),
      edge("data-exit", "data", "exit", clamp(values.exit / 100), exitHealth),
    ],
    metrics: [
      metric("tier-gap", "Vendors without a criticality tier", values.tierGap, "%", 10, 40, "percent"),
      metric("unassessed-critical", "Critical vendors without a current assessment", values.assessmentGap, "%", 10, 40, "percent"),
      metric("subprocessor-gap", "Subcontractors not disclosed or reviewed", values.subprocessorGap, "%", 10, 40, "percent"),
      metric("exit-gap", "Critical vendors without a tested exit", values.exitGap, "%", 15, 50, "percent"),
      metric("portfolio-exposure", "Portfolio risk floor", values.exposure, "%", 15, 50, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.tierGap.toFixed(0)}% of vendors have no criticality tier; ${values.assessmentGap.toFixed(0)}% of critical vendors lack a current assessment; ${values.subprocessorGap.toFixed(0)}% of subcontractors are unreviewed; ${values.exitGap.toFixed(0)}% of critical vendors have no tested exit.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "tier-gap",
    metricId: "tier-gap",
    warn: 10,
    crit: 40,
    title: "A vendor has no criticality tier",
    cause:
      "Without a tier, a vendor that can reach regulated data or stop a revenue path may receive the same light intake as a design tool. The register cannot set review depth, ownership, or renewal cadence, so the assessment becomes a judgment call that varies by reviewer.",
    fix:
      "Tier every vendor from data access, availability dependency, and substitutability. Record the tier, owner, dependent systems, and next review date, and use the tier to set the assessment depth.",
    checkFirst: [
      "Which vendors can reach regulated data or stop a critical user journey?",
      "Which vendors have no tier or owner in the register?",
      "Does the tier change when the integration or data access changes?",
    ],
  },
  {
    id: "unassessed-critical",
    metricId: "unassessed-critical",
    warn: 10,
    crit: 40,
    title: "A critical vendor has no current assessment",
    cause:
      "A tier without a current review is only a label. The team cannot show that the vendor's controls still match the data and dependency, especially after the vendor changes its platform, ownership, or subcontractors. The assessment gap is separate from the tier gap and needs its own evidence.",
    fix:
      "For every critical vendor, require a current review covering security, availability, data handling, contract terms, and the systems that depend on it. Record the assessment date, the reviewer, and the next review in the register.",
    checkFirst: [
      "When was each critical vendor last assessed, and against which tier?",
      "Did the vendor or the integration change after the last review?",
      "Which critical vendors have no assessment date in the register?",
    ],
  },
  {
    id: "subprocessor-gap",
    metricId: "subprocessor-gap",
    warn: 10,
    crit: 40,
    title: "Subcontractors are outside the review",
    cause:
      "A vendor can subcontract processing, support, or infrastructure without changing the contract you signed with the vendor. The fourth party may sit in another region, inherit weaker controls, or fall outside the flow-down terms. If it is not in the inventory, it cannot be approved.",
    fix:
      "Require disclosure of subcontractors and material changes, review each one against the same data and residency constraints, and flow down security, breach notice, deletion, and audit obligations. Keep the inventory current and test a vendor change against it.",
    checkFirst: [
      "Does the contract require notice before a new subcontractor is used?",
      "Which subcontractors can reach customer data, and in which regions?",
      "Are equivalent terms actually flowed down, or only promised?",
    ],
  },
  {
    id: "exit-gap",
    metricId: "exit-gap",
    warn: 15,
    crit: 50,
    title: "A critical vendor has no tested exit",
    cause:
      "A termination clause is not an exit. The team may not know the export format, may not have the capacity to absorb the workload, or may discover that the data cannot leave within the contractual window. The failure appears during an outage or a dispute, when leverage is lowest.",
    fix:
      "Document the export format, retention after termination, deletion proof, an alternate path, and the people who run the migration. Test a small export or a restore on a schedule. Record the test result and the remaining gaps with an owner.",
    checkFirst: [
      "Can the data be exported in a usable format, and has anyone tried?",
      "What is the alternate path, and how long would it take to activate?",
      "What happens to copies after termination, and who proves deletion?",
    ],
  },
];

export const vendorRiskModel: SimModel = {
  id: "compliance-vendor-risk",
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
    if (values.exposure >= 50 && frame.flags.portfolioEvent !== 1) {
      const gap = primaryGap(values);
      pushEvent(next, {
        id: "critical-vendor-uncovered",
        at: frame.t,
        severity: "crit",
        title: gap.title,
        detail: `Portfolio exposure is ${values.exposure.toFixed(0)}%, led by ${gap.metricId} at ${gap.value.toFixed(0)}%. ${values.tierGap.toFixed(0)}% of vendors have no tier, ${values.assessmentGap.toFixed(0)}% of critical vendors lack a current assessment, ${values.subprocessorGap.toFixed(0)}% of subcontractors are unreviewed, and ${values.exitGap.toFixed(0)}% have no tested exit.`,
        nodeId: gap.nodeId,
        metricId: gap.metricId,
      });
      next.flags.portfolioEvent = 1;
    }
    if (values.exposure < 50) next.flags.portfolioEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.tierGap.toFixed(0)}% of vendors have no criticality tier; ${values.assessmentGap.toFixed(0)}% of critical vendors lack a current assessment; ${values.subprocessorGap.toFixed(0)}% of subcontractors are unreviewed; ${values.exitGap.toFixed(0)}% of critical vendors have no tested exit.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The portfolio risk floor is ${values.exposure.toFixed(0)}%, set by the weakest of tiering, assessment, subcontractor visibility, and exit readiness. A strong questionnaire does not compensate for an untested exit.`,
      `${values.tierGap.toFixed(0)}% of vendors have no criticality tier, and ${values.assessmentGap.toFixed(0)}% of critical vendors lack a current assessment. Tier first, then review at the depth the tier requires; the two gaps are separate.`,
      `${values.subprocessorGap.toFixed(0)}% of subcontractors are outside the review. The fourth party can change the region, the controls, and the breach path without changing your direct contract.`,
      `${values.exitGap.toFixed(0)}% of critical vendors have no tested exit. Export format, alternate capacity, termination assistance, and deletion proof are the parts an outage actually tests.`,
      "The percentages and the 10/40, 15/50, and 10/40 thresholds are illustrative teaching values. Vendor obligations also depend on the contract, the data, and the applicable regulation.",
    ];
  },
  legend: [
    { label: "Reviewed", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every vendor has a tier, critical vendors have current assessments, subcontractors are reviewed, and exits are tested.",
    tone: "ok",
    params: defaults({ tiering: 100, assessment: 100, subprocessorVisibility: 100, exitReadiness: 100 }),
  },
  {
    id: "peak",
    label: "Review backlog",
    description: "Tiering is current, but some critical reviews are late, several subcontractors are undisclosed, and exit tests are overdue.",
    tone: "warn",
    params: defaults({ tiering: 90, assessment: 75, subprocessorVisibility: 70, exitReadiness: 60 }),
  },
  {
    id: "failure",
    label: "Single critical dependency",
    description: "Criticality is mostly unassigned, most critical vendors are unassessed, subcontractors are invisible, and no critical vendor has a tested exit.",
    tone: "crit",
    params: defaults({ tiering: 40, assessment: 20, subprocessorVisibility: 10, exitReadiness: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The register is current, critical reviews are complete, subcontractors are disclosed, and exits have been tested.",
    tone: "ok",
    params: defaults({ tiering: 100, assessment: 100, subprocessorVisibility: 100, exitReadiness: 100 }),
  },
  {
    id: "concentration",
    label: "Concentration risk",
    description: "Every vendor is tiered and assessed, but half the subcontractor chain is undocumented and the critical exit is untested. A single underlying provider carries two critical functions.",
    tone: "crit",
    params: defaults({ tiering: 100, assessment: 100, subprocessorVisibility: 50, exitReadiness: 20 }),
  },
];

const experiment: Experiment = {
  id: "predict-exit",
  title: "Predict whether a questionnaire completes the review",
  simId: "vendor-risk",
  question:
    "A critical vendor has a completed security questionnaire and a signed DPA. Its subcontractors are undocumented and the exit has never been tested. Is the vendor review complete?",
  prediction: {
    options: [
      { id: "complete", label: "Yes. The questionnaire and the contract cover the risk" },
      { id: "exit", label: "No. Criticality also requires subcontractor visibility and a tested exit" },
      { id: "contract", label: "Yes. The DPA transfers the remaining responsibility to the vendor" },
      { id: "annual", label: "No, but only because the review is more than a year old" },
    ],
    correctOptionId: "exit",
    explanation:
      "The questionnaire and the DPA are inputs. A critical vendor also needs its subcontractors disclosed and reviewed, and an exit path that has been tested with the data. The contract can allocate responsibility, but it cannot restore a service or export data during an outage.",
  },
  setup: defaults({ tiering: 100, assessment: 100, subprocessorVisibility: 20, exitReadiness: 0 }),
  runFor: 20,
  observe: [
    "The exit gap is 100% and the subcontractor gap is 80%; both cross the critical threshold.",
    "The portfolio risk floor is 100% even though tiering and assessment are complete.",
    "The exit and subcontractor nodes fail while the assessment node stays healthy.",
    "The customer data path is marked critical because the weakest vendor control sets the exposure.",
  ],
  explain:
    "Vendor risk is a portfolio property, not a questionnaire score. Criticality sets the required depth, and the depth has to include the parts that fail during an incident: the fourth parties, the data export, and the alternate path. A review that stops at the direct vendor misses the chain and the recovery path.",
  fix: defaults({ tiering: 100, assessment: 100, subprocessorVisibility: 100, exitReadiness: 100 }),
  debrief:
    "With subcontractors reviewed and the exit tested, the same vendor has a defensible review. The lesson is to match depth to criticality and to test the parts that an outage will exercise. The percentages and thresholds are illustrative teaching values.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Vendor risk is the process of deciding how much a third party can hurt the product, the data, or the customer, and then reviewing it to that depth. A vendor that stores regulated data, terminates authentication, or processes payments is not equivalent to a design tool. Criticality should come from data access, availability dependency, and how quickly the vendor can be replaced.",
  },
  {
    type: "p",
    text: "The review has several dimensions that fail separately. Security controls decide whether the vendor protects the data. Availability and concentration decide whether an outage becomes your outage. Data handling covers location, retention, and deletion. Subcontractors extend the chain beyond the entity you signed with. Exit covers whether the data and workload can leave. A questionnaire can be complete while the exit is fiction.",
  },
  {
    type: "p",
    text: "The portfolio view matters because review capacity is finite. A team that applies the same lightweight intake to every vendor will spend the same effort on a critical processor and a stationery supplier, then discover the gap during an incident. Tiering is how the team spends review effort where the failure would matter.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Vendor risk sits between procurement and production. Intake captures the data and dependency, the register records the tier and owner, the assessment reviews the controls and contract, and the exit plan covers the removal path. The customer data path and the systems that depend on the vendor are part of the scope, even when the vendor never stores a record.",
  },
  {
    type: "table",
    headers: ["Tier", "Typical dependency", "Review depth", "Evidence to keep"],
    rows: [
      ["Critical", "Regulated data, authentication, payments, or a revenue-critical path", "Full security and availability review, architecture, subcontractors, tested exit", "Assessment, contract, data-flow record, exit test, named owner"],
      ["High", "Production access or an important internal workflow", "Standard review of access, data handling, and continuity", "Questionnaire, evidence sample, renewal date"],
      ["Low", "No customer data and no production dependency", "Lightweight intake and terms check", "Owner, purpose, contract reference"],
    ],
  },
  {
    type: "p",
    text: "Concentration is a separate axis. Two vendors can each be well assessed while both depend on the same underlying provider or region. The portfolio view should show where a single failure would hit several critical functions at once.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Vendors without a criticality tier: the share whose review depth is not defined.",
      "Critical vendors without a current assessment: the gap between the tier and the completed review.",
      "Subcontractors not disclosed or reviewed: fourth parties outside the direct contract.",
      "Critical vendors without a tested exit: the share with no proven export or alternate path.",
      "Portfolio risk floor: the weakest of tiering, assessment, subcontractor visibility, and exit readiness.",
      "Node states: intake, criticality register, assessment, customer data path, subcontractor inventory, and exit path.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Review backlog and watch the warnings appear across assessment, subcontractors, and exit. Apply Single critical dependency and Concentration risk to compare a broadly weak portfolio with a well-assessed one that still has no exit. Run the experiment before revealing the explanation, then apply Recovery.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal or procurement advice. The percentages and thresholds are illustrative. A real vendor decision also depends on the contract, the data, the jurisdiction, and the risk appetite of the organization.",
  },
  {
    type: "p",
    text: "The useful question is not whether the vendor answered every questionnaire item. It is which critical function depends on the vendor, who else is in the chain, and what the team would actually do if the vendor disappeared tomorrow.",
  },
  { type: "sim", simId: "vendor-risk" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The portfolio risk floor stayed at 100% even though tiering and assessment were complete. Subcontractor visibility and exit readiness were the weakest links, and both are invisible in a questionnaire score. In the concentration preset, the assessment was perfect and the portfolio still failed because the exit had never been tested.",
  },
  {
    type: "p",
    text: "Adding a tested exit and a subcontractor inventory lowered the floor without changing the vendor's security questionnaire. That is the point: the review has to cover the failure paths that the incident will actually exercise, not only the controls the vendor is comfortable describing.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Register: tier, owner, data categories, systems affected, and next review date.",
      "Assessment: open findings, age, evidence, and whether the vendor changed since the review.",
      "Chain: subcontractor names, regions, data access, and notice history.",
      "Continuity: concentration, alternate path, export test date, and termination assistance.",
      "Incident: which critical journeys depend on the vendor and who can invoke the exit.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List vendors that can reach regulated data or stop a critical user journey.",
      "Check whether each one has a current assessment at its assigned tier.",
      "Identify subcontractors and regions that are missing from the inventory.",
      "Test one export or restore instead of reading the termination clause.",
      "Name the alternate path and the person who can activate it.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Tier the portfolio from data access, availability dependency, and substitutability.",
      "Assign an owner and a review date to every critical vendor.",
      "Review security, availability, data handling, and contract terms at tier depth.",
      "Require subcontractor disclosure and flow down equivalent obligations.",
      "Test an export or migration and record the result.",
      "Track concentration and review the portfolio before renewal, not after an outage.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Deep reviews reduce risk but consume security and procurement time; tiering focuses that effort.",
      "A second provider reduces concentration but adds integration, cost, and another vendor to review.",
      "Strict subcontractor approval protects residency and control quality but can slow the vendor's roadmap.",
      "Tested exits are valuable and expensive; a full migration test may be justified only for the most critical vendors.",
      "Longer contracts can improve terms and increase lock-in; the exit plan has to be priced into the decision.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "tier-vendor",
    question: "How do you decide whether a vendor is critical?",
    difficulty: 2,
    hints: [
      "Look at data, dependency, and substitutability.",
      "A vendor can be critical without storing customer data.",
    ],
    answer:
      "I would look at three things: what data or systems the vendor can reach, which user journeys or revenue paths stop if it fails, and how quickly it can be replaced. A vendor that terminates authentication or processes payments is critical even if it stores little data. I would record the tier, the owner, the dependent systems, and the review depth in a register so the decision is consistent and reviewable.",
    followUps: [
      "How does concentration change the answer?",
      "What would make you lower a tier?",
      "Who signs off on a critical vendor?",
    ],
    redFlags: [
      "Tiers by contract size only.",
      "Ignores availability dependency.",
      "Treats all vendors the same.",
    ],
    rubric: [
      "Uses data, availability, and substitutability.",
      "Recognizes non-data dependencies.",
      "Records tier and owner.",
      "Considers concentration.",
    ],
  },
  {
    id: "vendor-incident",
    question: "A critical vendor has an outage and customer data may be exposed. What do you do first?",
    difficulty: 3,
    hints: [
      "Contain the data path before finishing the root-cause analysis.",
      "The contract and the incident process should already name an owner.",
    ],
    answer:
      "I would confirm which data and systems are in the path, stop or narrow the flow if containment is possible, and engage the incident and legal processes. In parallel I would contact the vendor for scope, timeline, and evidence, and check whether the subcontractor chain or another region is involved. I would not wait for a complete root cause to start notification assessment. After containment, I would use the exit plan if the vendor cannot meet the recovery objective and record the decision.",
    followUps: [
      "What would you ask the vendor for in the first hour?",
      "When would you invoke the exit plan?",
      "How do you communicate uncertainty to customers?",
    ],
    redFlags: [
      "Waits for a full root cause before containing.",
      "Has no contact or escalation path.",
      "Improvises an exit during the incident.",
    ],
    rubric: [
      "Contains first.",
      "Engages incident and legal early.",
      "Scopes data and subcontractors.",
      "Uses a pre-tested exit path.",
    ],
  },
  {
    id: "exit-plan",
    question: "What makes a vendor exit plan real rather than a clause in a contract?",
    difficulty: 2,
    hints: [
      "Think about data format, capacity, and time.",
      "A plan that has never been tested is a hypothesis.",
    ],
    answer:
      "A real exit plan names the export format, the retention and deletion process, the alternate capacity, the people who run the migration, and the maximum tolerable time. It has been tested with a sample or a full restore, and the result is recorded. The contract supports the plan with termination assistance and deletion proof, but the operational test is what shows it works. I would also check that the alternate path does not recreate the same concentration.",
    followUps: [
      "How often would you test it?",
      "What if the data cannot be exported in a usable format?",
      "How do you prove deletion after termination?",
    ],
    redFlags: [
      "Points to the termination clause.",
      "Has never tried an export.",
      "Ignores data format and capacity.",
    ],
    rubric: [
      "Names format, capacity, owner, and time.",
      "Requires a test.",
      "Covers deletion.",
      "Checks the alternate path.",
    ],
  },
  {
    id: "subcontractor-change",
    question: "A vendor adds a subcontractor in another region. How should the review process handle it?",
    difficulty: 2,
    hints: [
      "Notice is not approval.",
      "The data path and the residency promise both change.",
    ],
    answer:
      "I would treat it as a material change: confirm the notice period, identify the data and region involved, review the subcontractor against the same requirements, and decide whether to approve, object, or stop the flow. I would update the inventory and the data-flow record and check whether the contract requires flow-down terms. If the change violates residency or an approval right, the team should escalate before data moves, not after.",
    followUps: [
      "What if the vendor says the change is already live?",
      "Who owns the approval decision?",
      "How do you detect a change that was never disclosed?",
    ],
    redFlags: [
      "Treats notice as automatic approval.",
      "Ignores the region.",
      "Does not update the inventory.",
    ],
    rubric: [
      "Treats the change as material.",
      "Checks region and data.",
      "Reviews and records approval.",
      "Escalates a violation.",
    ],
  },
];

const checklist = [
  {
    title: "Portfolio",
    items: [
      "List every vendor that can reach customer data or stop a critical journey.",
      "Assign a tier, owner, and review date from data access, dependency, and substitutability.",
      "Map concentration across critical functions and regions.",
      "Identify vendors whose subcontractors are not disclosed.",
    ],
  },
  {
    title: "Review",
    items: [
      "Confirm the assessment depth matches the tier.",
      "Check security, availability, data handling, and contract terms.",
      "Verify flow-down terms for subcontractors.",
      "Test an export, restore, or migration path.",
    ],
  },
  {
    title: "Before renewal",
    items: [
      "Re-check the data path and the dependent systems.",
      "Review open findings and the vendor's material changes.",
      "Re-test the exit if the integration or data volume changed.",
      "Record the decision, the residual risk, and the owner.",
    ],
  },
];

const references = [
  {
    title: "NIST SP 800-161 Rev. 1, Cybersecurity Supply Chain Risk Management Practices",
    url: "https://csrc.nist.gov/pubs/sp/800/161/r1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Supply chain risk practices covering supplier assessment, flow-down, and continuous monitoring.",
  },
  {
    title: "NIST SP 800-53 Rev. 5, External System Services (SA-9)",
    url: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Control requirements for external providers, including assessment, monitoring, and incident reporting.",
  },
  {
    title: "CISA ICT Supply Chain Risk Management",
    url: "https://www.cisa.gov/topics/information-communications-technology-supply-chain-security",
    publisher: "CISA",
    kind: "docs" as const,
    note: "Official guidance and resources for identifying and managing supplier and supply chain risk.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vendor-risk": {
      model: vendorRiskModel,
      presets,
      instructions:
        "Start Healthy, then apply Review backlog and Single critical dependency. Compare the questionnaire-side gaps with subcontractor visibility and exit readiness. Run the experiment before revealing the explanation, then try Concentration risk and apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 10/40, 15/50, and 10/40 thresholds are teaching values. Real vendor obligations depend on the contract, data, and applicable regulation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-dpa", "compliance-subprocessors", "compliance-baa"],
};
