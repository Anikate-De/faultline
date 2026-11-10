import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AUDIT_WINDOW = 365;

const params = [
  {
    id: "ownershipCoverage",
    label: "Evidence with owner and scope",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Attribution",
    help: "Share of samples that name the control owner, the system and period the sample covers, and the query or source that produced it. Automated collection without attribution still leaves the auditor unable to test the sample.",
    format: "percent" as const,
  },
  {
    id: "evidenceAgeDays",
    label: "Oldest evidence sample",
    min: 1,
    max: 180,
    step: 1,
    value: 2,
    unit: " days",
    group: "Freshness",
    help: "Age of the oldest sample the team would present. Freshness is separate from coverage: a control can run everywhere and still have stale proof for the current period.",
    format: "count" as const,
  },
  {
    id: "retentionDays",
    label: "Evidence retention",
    min: 30,
    max: 365,
    step: 5,
    value: 365,
    unit: " days",
    group: "Retention",
    help: "How long the evidence store keeps a captured sample. The demo compares this against a teaching audit window of 365 days. Deletion before the window ends removes proof the pipeline already captured.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  ownership: number;
  evidenceAge: number;
  retention: number;
  ownershipGap: number;
  retentionShortfall: number;
  floor: number;
  packageHealth: number;
}

function compute(p: Params): Computed {
  const ownership = clamp(num(p, "ownershipCoverage", 100), 0, 100);
  const evidenceAge = Math.round(clamp(num(p, "evidenceAgeDays", 2), 1, 180));
  const retention = Math.round(clamp(num(p, "retentionDays", 365), 30, 365));
  const ownershipGap = 100 - ownership;
  const retentionShortfall = Math.max(0, AUDIT_WINDOW - retention);
  const retentionScore = (retention / AUDIT_WINDOW) * 100;
  const floor = Math.min(ownership, retentionScore);
  return {
    ownership,
    evidenceAge,
    retention,
    ownershipGap,
    retentionShortfall,
    floor,
    packageHealth: Math.max(ownershipGap, Math.max(0, 100 - retentionScore)),
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
  const attributionHealth = healthFor(values.ownershipGap, 15, 40);
  const ageHealth = healthFor(values.evidenceAge, 30, 90);
  const retentionHealth = healthFor(values.retentionShortfall, 1, 90);
  const packageHealth = healthFor(values.packageHealth, 15, 40);
  return {
    t: 0,
    nodes: [
      {
        id: "control",
        label: "Operating control",
        kind: "service",
        health: "ok",
        utilization: 0.5,
        sublabel: "access review, change, or configuration",
        detail: "The control that actually runs. Evidence starts here, not in a document assembled for the auditor.",
      },
      {
        id: "source",
        label: "Attributed evidence",
        kind: "storage",
        health: attributionHealth,
        utilization: values.ownershipGap / 100,
        sublabel: `${values.ownership.toFixed(0)}% have owner and scope`,
        detail: "Each sample names the control owner, the system and period it covers, and the query or source that produced it. Without those attributes the auditor cannot tell what the sample proves or who can explain it.",
      },
      {
        id: "collector",
        label: "Evidence collector",
        kind: "worker",
        health: "ok",
        utilization: 0.5,
        sublabel: "capture pipeline running",
        detail: "The scheduled export or event subscription that captures samples. Automation is the mechanism here; ownership and scope are the properties that make the output usable.",
      },
      {
        id: "store",
        label: "Retained evidence",
        kind: "storage",
        health: retentionHealth,
        utilization: values.retentionShortfall / AUDIT_WINDOW,
        sublabel: `${values.retention}d retained · ${values.retentionShortfall}d short`,
        detail: "The immutable or access-controlled store. A lifecycle rule that deletes before the audit window ends silently removes proof.",
      },
      {
        id: "package",
        label: "Audit package",
        kind: "worker",
        health: packageHealth,
        utilization: values.packageHealth / 100,
        sublabel: `${values.floor.toFixed(0)}% coverage floor`,
        detail: "The set handed to the auditor: samples with scope, timestamp, source, and owner. Missing either ownership/scope or retention caps the package.",
      },
      {
        id: "auditor",
        label: "Auditor sample test",
        kind: "external",
        health: ageHealth,
        utilization: values.evidenceAge / 180,
        sublabel: `oldest sample ${values.evidenceAge} days old`,
        detail: "The auditor tests samples across the period. A stale sample cannot show that the control operated after a material change.",
      },
    ],
    edges: [
      edge("control-source", "control", "source", clamp(values.ownership / 100), attributionHealth),
      edge("source-collector", "source", "collector", clamp(values.ownership / 100), attributionHealth),
      edge("collector-store", "collector", "store", 1, retentionHealth),
      edge("store-package", "store", "package", clamp(values.retention / AUDIT_WINDOW), packageHealth),
      edge("package-auditor", "package", "auditor", clamp(values.floor / 100), ageHealth),
    ],
    metrics: [
      metric("ownership-gap", "Evidence without owner or scope", values.ownershipGap, "%", 15, 40, "percent"),
      metric("evidence-age", "Oldest evidence sample", values.evidenceAge, " days", 30, 90, "count"),
      metric("retention-shortfall", "Retention short of the audit window", values.retentionShortfall, " days", 1, 90, "count"),
      metric("evidence-floor", "Owned and retained coverage floor", values.floor, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.ownership.toFixed(0)}% of evidence has an owner and scope; the oldest sample is ${values.evidenceAge} days old; retention is ${values.retention} days against a ${AUDIT_WINDOW}-day audit window, a shortfall of ${values.retentionShortfall} days.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "ownership-gap",
    metricId: "ownership-gap",
    warn: 15,
    crit: 40,
    title: "Evidence has no owner or scope",
    cause:
      "A sample without a named owner, the system and period it covers, and the query that produced it cannot be defended. The auditor cannot tell whether the evidence applies to the control under test, who can explain it, or whether the sample is complete. Automated collection does not fix missing attribution.",
    fix:
      "Attach the control owner, scope (system, environment, period), source query, and timestamp at capture. Keep the export definition with the sample so it can be reproduced. Review one sample with its owner before the audit.",
    checkFirst: [
      "Which samples lack a named owner or a defined period?",
      "Does each sample state the system and environment it covers?",
      "Can the sample be reproduced from a stored query or export definition?",
    ],
  },
  {
    id: "evidence-age",
    metricId: "evidence-age",
    warn: 30,
    crit: 90,
    title: "The oldest evidence cannot cover the current period",
    cause:
      "Evidence from last quarter does not show that access was reviewed this quarter or that a new store inherited the control. Age is a separate failure from coverage: the pipeline can capture every control and still present a stale sample.",
    fix:
      "Capture on a schedule that matches the control frequency, timestamp every sample, and re-capture after a material change to identity, storage, or network paths. Check both the newest and oldest sample in the audit period.",
    checkFirst: [
      "When was the oldest sample captured relative to the audit period?",
      "Did a material change happen after that sample?",
      "Is the sample a live export or a package assembled for the audit?",
    ],
  },
  {
    id: "retention-shortfall",
    metricId: "retention-shortfall",
    warn: 1,
    crit: 90,
    title: "Evidence retention is shorter than the audit window",
    cause:
      "Automation only helps while the sample still exists. A lifecycle policy that deletes after 90 days cannot answer a question about a 365-day period, and the gap is invisible until someone asks for the deleted quarter.",
    fix:
      "Set retention to cover the audit window plus investigation time, apply it to every evidence bucket and index, and verify the lifecycle rule with an object that is older than the cutoff. Preserve evidence under legal hold when an investigation starts.",
    checkFirst: [
      "What is the actual lifecycle rule on each evidence store?",
      "Has anyone restored an object that is older than the retention cutoff?",
      "Does a legal hold suspend deletion, and who can apply it?",
    ],
  },
];

export const evidenceModel: SimModel = {
  id: "compliance-evidence",
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
    if (values.ownershipGap >= 40 && frame.flags.ownershipEvent !== 1) {
      pushEvent(next, {
        id: "evidence-without-owner",
        at: frame.t,
        severity: "crit",
        title: "Evidence has no owner or scope",
        detail: `${values.ownershipGap.toFixed(0)}% of evidence lacks an owner or scope. The oldest sample is ${values.evidenceAge} days old and retention is ${values.retention} days against a ${AUDIT_WINDOW}-day audit window.`,
        nodeId: "source",
        metricId: "ownership-gap",
      });
      next.flags.ownershipEvent = 1;
    }
    if (values.ownershipGap < 40) next.flags.ownershipEvent = 0;
    if (values.retentionShortfall >= 90 && frame.flags.retentionEvent !== 1) {
      pushEvent(next, {
        id: "retention-shortfall",
        at: frame.t,
        severity: "crit",
        title: "Evidence is deleted before the audit window closes",
        detail: `Retention is ${values.retention} days, ${values.retentionShortfall} days short of the ${AUDIT_WINDOW}-day window. Automation cannot prove a period whose samples were already removed.`,
        nodeId: "store",
        metricId: "retention-shortfall",
      });
      next.flags.retentionEvent = 1;
    }
    if (values.retentionShortfall < 90) next.flags.retentionEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.ownership.toFixed(0)}% of evidence has an owner and scope; the oldest sample is ${values.evidenceAge} days old; retention is ${values.retention} days against a ${AUDIT_WINDOW}-day audit window, a shortfall of ${values.retentionShortfall} days.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The evidence floor is ${values.floor.toFixed(0)}%, limited by owner/scope coverage at ${values.ownership.toFixed(0)}% or retention at ${values.retention} of ${AUDIT_WINDOW} days. The weaker of the two sets the package.`,
      `${values.ownershipGap.toFixed(0)}% of samples lack an owner or scope. A record without those attributes may have been captured automatically and still be unusable as proof.`,
      `The oldest sample is ${values.evidenceAge} days old. A current export proves the control ran now; it does not automatically prove it ran for the whole period.`,
      values.retentionShortfall > 0
        ? `Retention is ${values.retentionShortfall} days short of the audit window. The deleted samples cannot be recovered by improving attribution or adding more automation.`
        : "Retention covers the full teaching audit window. Verify the lifecycle rule rather than assuming it matches the design.",
      "The 365-day window and the 15/40, 30/90, and 1/90 thresholds are illustrative teaching values. Real windows come from the audit scope, regulation, and contract.",
    ];
  },
  legend: [
    { label: "Captured", tone: "ok" },
    { label: "At risk", tone: "warn" },
    { label: "Missing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every sample names its owner and scope, the oldest sample is two days old, and retention covers the full audit window.",
    tone: "ok",
    params: defaults({ ownershipCoverage: 100, evidenceAgeDays: 2, retentionDays: 365 }),
  },
  {
    id: "peak",
    label: "Audit prep",
    description: "Most samples have an owner and scope, the oldest sample is six weeks old, and retention is two months short of the window. The package is possible but weak.",
    tone: "warn",
    params: defaults({ ownershipCoverage: 85, evidenceAgeDays: 45, retentionDays: 300 }),
  },
  {
    id: "failure",
    label: "Screenshot audit",
    description: "A quarter of samples have an owner and scope, the oldest sample is four months old, and the lifecycle policy deletes evidence after 90 days.",
    tone: "crit",
    params: defaults({ ownershipCoverage: 25, evidenceAgeDays: 120, retentionDays: 90 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Every sample has an owner and scope, the newest samples are current, and retention keeps evidence for the full window.",
    tone: "ok",
    params: defaults({ ownershipCoverage: 100, evidenceAgeDays: 2, retentionDays: 365 }),
  },
];

const experiment: Experiment = {
  id: "predict-ownership",
  title: "Predict whether capture alone is enough",
  simId: "evidence",
  question:
    "Evidence is captured automatically every day, but half the samples do not name an owner or the period they cover. The audit starts next week. Is the package sufficient?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. Daily automation is stronger than any manual process" },
      { id: "ownership", label: "No. Without an owner and scope, the auditor cannot tie the sample to the control or the period" },
      { id: "screenshots", label: "Yes, as long as someone keeps quarterly screenshots as a backup" },
      { id: "retention", label: "No, because the evidence is deleted too quickly" },
    ],
    correctOptionId: "ownership",
    explanation:
      "Automation answers how the sample was captured, not what it proves. A sample without an owner and a defined scope cannot be tied to the control under test, and the auditor cannot tell which system or period it covers. Half the package is unattributable even though every record was captured on time.",
  },
  setup: defaults({ ownershipCoverage: 50, evidenceAgeDays: 5, retentionDays: 365 }),
  runFor: 20,
  observe: [
    "The ownership gap is 50% and crosses the critical threshold.",
    "The attribution node fails while retention covers the full audit window.",
    "Perfect retention cannot raise the evidence floor while half the samples lack an owner or scope.",
    "The audit package shows a coverage floor of 50% even though every sample was captured.",
  ],
  explain:
    "The evidence pipeline has three independent properties: capture, attribution, and retention. Capture produces the record. Attribution ties it to a control owner, a system, a period, and a reproducible source. Retention keeps it available for the audit window. A team can automate capture and still hand the auditor a folder of records that cannot be mapped to the controls under test.",
  fix: defaults({ ownershipCoverage: 100, evidenceAgeDays: 2, retentionDays: 365 }),
  debrief:
    "With owner and scope attached, the same captured records become usable evidence. The lesson is to test the whole chain: capture, attribution, timestamp, retention, and retrieval. The percentages and the 365-day window are illustrative teaching values, not a legal retention requirement.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Evidence is proof that a control operated during a defined period. For an engineering team, that means a record from a system of record, not a screenshot of a dashboard. A useful sample identifies the actor, the action, the target, the timestamp, the outcome, the scope it covers, and the owner who can explain it. The same record should be reproducible from the source the auditor will test.",
  },
  {
    type: "p",
    text: "Evidence collection is often treated as an audit-week activity: someone opens consoles, takes screenshots, and assembles a folder. That process fails in three predictable ways. It captures a moment rather than a period, it loses the source and scope, and it cannot keep up when a new system enters the scope. Automating capture turns normal operation into evidence and removes the scramble.",
  },
  {
    type: "p",
    text: "Automation is the mechanism, not the proof. A sample needs an owner and a defined scope, and it needs to survive the retention window. A record can be generated automatically and still be unusable because nobody can say which system or period it covers or who can explain it. The model therefore treats owner/scope coverage and retention against the audit window as separate gates, and the weaker gate sets the evidence floor.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pipeline starts at the system that operates the control and ends at the audit package. Identity, ticketing, deployment, and configuration systems hold the raw facts. A collector exports or subscribes to those facts, a store retains them, and a package assembles samples with their scope. The auditor samples the package and traces a claim back to the source.",
  },
  {
    type: "compare",
    leftTitle: "Manual evidence",
    rightTitle: "Pipeline evidence",
    rows: [
      { label: "Timing", left: "Captured after the audit starts", right: "Captured as the control operates" },
      { label: "Scope", left: "Whatever the screenshot happened to show", right: "Defined query or export with a stable identifier" },
      { label: "Freshness", left: "Usually last quarter", right: "Current and repeatable" },
      { label: "Retention", left: "A folder someone remembers", right: "Lifecycle rule verified against the window" },
      { label: "Failure mode", left: "Missing proof under time pressure", right: "Silent deletion or an uncovered path" },
    ],
  },
  {
    type: "p",
    text: "Ownership sits across the chain. The control owner defines what a good sample looks like, the platform team runs the collector and the store, and the compliance owner maps samples to the audit request. Without a named owner, the pipeline can be technically healthy and still produce a package nobody can defend.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Evidence with owner and scope: the share of samples that name an owner, a system, a period, and a source query.",
      "Oldest evidence sample: freshness, measured in days, separate from coverage.",
      "Retention short of the audit window: how many days of required proof the lifecycle policy deletes.",
      "Evidence floor: the weaker of owner/scope coverage and retention coverage.",
      "Node states: the operating control, systems of record, collector, retained store, audit package, and auditor sample test.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Audit prep and watch freshness and retention move independently. Apply Screenshot audit to see attribution and the store fail for different reasons. Run the experiment before revealing the explanation, then apply Recovery and confirm that owner/scope coverage and retention both need to be healthy.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal or audit advice. The 365-day window, coverage percentages, and thresholds are illustrative values. Real evidence requirements come from the audit scope, applicable regulation, and customer contracts.",
  },
  {
    type: "p",
    text: "The engineering question is not how many screenshots the team can produce by Friday. It is which controls lack a system-of-record source, how quickly a sample is captured, and whether the store will still have that sample when the period is tested.",
  },
  { type: "sim", simId: "evidence" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The attribution node and the retained store failed for different reasons. Owner/scope coverage decided whether a sample could be tied to a control and a period; retention decided whether the sample survived the window. Improving attribution did not fix the deletion gap, and restoring retention did not help a sample that nobody could explain. The evidence floor stayed at the weaker gate.",
  },
  {
    type: "p",
    text: "At the failure preset, the oldest sample was 120 days old and the store kept only 90 days. The package could not answer questions about most of the year, even though the control was running. That is the difference between an operating control and a defensible evidence set.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Collector: export job success, sample count, last run, and the schema of captured fields.",
      "Source: whether identity, change, and configuration systems emit attributable events.",
      "Store: lifecycle rules, object lock or access policy, and the oldest retrievable sample.",
      "Package: coverage by control, owner, period, and the systems included in scope.",
      "Audit request: the exact sample the auditor asked for and how long retrieval took.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List controls that still depend on a person taking a screenshot.",
      "Check the lifecycle rule on each evidence store against the audit window.",
      "Retrieve the oldest sample you intend to present and verify it opens.",
      "Confirm each sample has a source, timestamp, scope, and owner.",
      "Identify systems added after the last capture and confirm they are covered.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Pick the controls with the highest audit exposure and give each a system-of-record source.",
      "Export on a schedule with a stable identifier, timestamp, scope, and owner.",
      "Set retention to cover the audit window plus investigation time.",
      "Test retrieval of an old sample instead of trusting the lifecycle design.",
      "Re-capture after material changes to identity, storage, or network paths.",
      "Keep the query or job definition with the sample so the result is reproducible.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Continuous capture is more trustworthy but adds storage, schema, and pipeline maintenance.",
      "Longer retention supports audits and investigations but increases cost and privacy exposure.",
      "Immutable storage protects integrity but complicates deletion requests and legal holds.",
      "Screenshots are cheap for a one-off question and fragile as a period-wide control.",
      "A single central evidence store simplifies retrieval but becomes a high-value target and a single point of failure.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "defensible-sample",
    question: "What makes a piece of evidence defensible to an auditor?",
    difficulty: 2,
    hints: [
      "Think about who, what, when, and how you know.",
      "A screenshot can be edited; a system export can be reproduced.",
    ],
    answer:
      "A defensible sample comes from the system that operated the control, identifies the actor, action, target, timestamp, outcome, and scope, and has an owner who can explain it. I should be able to reproduce the query or export and get the same result for the same period. The sample also needs to still exist at test time, so retention and retrieval are part of defensibility, not an archive detail.",
    followUps: [
      "How would you prove a sample was not edited after capture?",
      "What do you do when the source system does not log the actor?",
      "How do you cover a control that runs manually?",
    ],
    redFlags: [
      "Says a screenshot is enough because it shows the setting.",
      "Cannot name the source system.",
      "Treats retention as someone else's problem.",
    ],
    rubric: [
      "Names source, timestamp, scope, and owner.",
      "Connects evidence to the operating control.",
      "Includes retention and reproducibility.",
      "Handles manual controls explicitly.",
    ],
  },
  {
    id: "automation-limit",
    question: "The team automates evidence collection. What failure modes remain?",
    difficulty: 2,
    hints: [
      "Automation can capture the wrong scope.",
      "A pipeline can run successfully and still delete its output.",
    ],
    answer:
      "Automation can capture an incomplete scope, miss a new system, emit a record without the actor or target, fail silently, or retain the sample for less time than the audit window. It can also produce a large volume that nobody maps to a control. I would test coverage against the control inventory, validate the schema, alert on collection failure, and retrieve an old sample to prove retention. Automation moves the work earlier; it does not remove the need to verify the result.",
    followUps: [
      "Which alert tells you the collector stopped?",
      "How do you detect a new system that is outside the export?",
      "What sample would you inspect first?",
    ],
    redFlags: [
      "Assumes a green pipeline means complete evidence.",
      "Ignores schema and scope.",
      "Has no retrieval test.",
    ],
    rubric: [
      "Names coverage and schema failures.",
      "Covers retention and retrieval.",
      "Mentions monitoring the collector.",
      "Maps evidence to controls.",
    ],
  },
  {
    id: "retention-window",
    question: "How do you choose an evidence retention period?",
    difficulty: 2,
    hints: [
      "Start from the longest obligation, not the default bucket setting.",
      "Investigation and legal hold can extend the period.",
    ],
    answer:
      "I would start from the audit period, the applicable regulatory or contractual retention requirement, and the investigation window, then keep the longest. I would apply the rule to every store, verify it with an object older than the cutoff, and make sure a legal hold can suspend deletion. I would also account for privacy obligations that argue against keeping personal data longer than necessary, and document the decision.",
    followUps: [
      "What happens when two obligations conflict?",
      "How do you verify the lifecycle rule actually works?",
      "Who can place a legal hold?",
    ],
    redFlags: [
      "Picks a round number without a requirement.",
      "Assumes the bucket default is correct.",
      "Cannot suspend deletion.",
    ],
    rubric: [
      "Starts from the obligation.",
      "Applies and verifies the rule.",
      "Includes legal hold.",
      "Balances privacy and cost.",
    ],
  },
  {
    id: "audit-tomorrow",
    question: "The audit starts tomorrow and most evidence is in screenshots. What do you do first?",
    difficulty: 3,
    hints: [
      "Triage by control criticality and period coverage.",
      "Do not fabricate or backdate anything.",
    ],
    answer:
      "I would triage by the controls the audit is most likely to test and the periods with no system-of-record evidence. For each, I would export what still exists, document the source and retrieval time, and mark the gaps honestly. I would not backdate or recreate a sample to look continuous. Then I would put an owner on each gap and start the automation and retention fixes so the next period is defensible. The immediate goal is an accurate package, not a perfect-looking one.",
    followUps: [
      "How do you explain a gap to the auditor?",
      "Which controls would you prioritize?",
      "What would you fix before the next period starts?",
    ],
    redFlags: [
      "Suggests recreating screenshots.",
      "Hides the gap.",
      "Focuses on volume over coverage.",
    ],
    rubric: [
      "Triages by exposure and period.",
      "Preserves what exists.",
      "Is honest about gaps.",
      "Starts durable fixes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the audit",
    items: [
      "Map every control to a system-of-record evidence source and an owner.",
      "Check owner/scope coverage for new systems and manual controls.",
      "Verify retention and retrieval against the full audit window.",
      "Test one sample end to end: source, timestamp, scope, owner, retrieval.",
    ],
  },
  {
    title: "During the audit",
    items: [
      "Track each request to a sample and the time it took to retrieve.",
      "Mark gaps and explain the control impact instead of filling them with reconstructions.",
      "Confirm the sample period matches the request.",
      "Keep the query or export definition with the sample.",
    ],
  },
  {
    title: "After the audit",
    items: [
      "Automate the controls that still required manual collection.",
      "Fix the lifecycle rule before the next period begins.",
      "Add collection and retention checks to the control review.",
      "Re-test retrieval after any change to the evidence store.",
    ],
  },
];

const references = [
  {
    title: "SOC 2 and trust services criteria",
    url: "https://www.aicpa-cima.com/topic/audit-assurance/audit-and-assurance-greater-than-soc-2",
    publisher: "AICPA",
    kind: "standard" as const,
    note: "Official overview of SOC 2 examinations and the trust services criteria that evidence supports.",
  },
  {
    title: "NIST SP 800-53A Rev. 5, Assessing Security and Privacy Controls",
    url: "https://csrc.nist.gov/pubs/sp/800/53/a/r5/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Assessment procedures for determining whether controls are implemented and operating effectively.",
  },
  {
    title: "NIST SP 800-53 Rev. 5, Audit and Accountability controls",
    url: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Control family covering audit record content, review, retention, and protection.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    evidence: {
      model: evidenceModel,
      presets,
      instructions:
        "Start Healthy, then apply Audit prep and Screenshot audit. Compare owner/scope coverage with the oldest sample and the retention shortfall. Run the experiment before revealing the explanation, then apply Recovery and check the evidence floor.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages, the 365-day audit window, and the 15/40, 30/90, and 1/90 thresholds are teaching values. Real evidence and retention requirements come from the audit scope, regulation, and contract.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-soc2", "compliance-audit-logs", "compliance-retention"],
};
