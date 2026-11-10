import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "inventory",
    label: "Data stores inventoried",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Discovery",
    help: "Share of stores, buckets, topics, indexes, and exports in the data catalog. A store that is not inventoried cannot be classified or controlled.",
    format: "percent" as const,
  },
  {
    id: "labels",
    label: "Datasets with an assigned label",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Classification",
    help: "Share of inventoried datasets with an owner and an explicit sensitivity label. A label inherited from a folder name is a guess, not a classification.",
    format: "percent" as const,
  },
  {
    id: "mixedHandling",
    label: "Mixed datasets classified at highest sensitivity",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Classification",
    help: "Share of mixed datasets labeled for their most sensitive content. A bucket with public pages and customer records is not public because most objects are public.",
    format: "percent" as const,
  },
  {
    id: "controlMatch",
    label: "Datasets with controls matching the label",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Enforcement",
    help: "Share of classified datasets whose access, encryption, retention, and logging match the label. A label that does not change a control is documentation.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  inventory: number;
  labels: number;
  mixed: number;
  controlMatch: number;
  inventoryGap: number;
  labelGap: number;
  mixedGap: number;
  controlGap: number;
  exposure: number;
  readiness: number;
}

function compute(p: Params): Computed {
  const inventory = clamp(num(p, "inventory", 100), 0, 100);
  const labels = clamp(num(p, "labels", 100), 0, 100);
  const mixed = clamp(num(p, "mixedHandling", 100), 0, 100);
  const controlMatch = clamp(num(p, "controlMatch", 100), 0, 100);
  const inventoryGap = 100 - inventory;
  const labelGap = 100 - labels;
  const mixedGap = 100 - mixed;
  const controlGap = 100 - controlMatch;
  const readiness = Math.min(inventory, labels, mixed, controlMatch);
  return {
    inventory,
    labels,
    mixed,
    controlMatch,
    inventoryGap,
    labelGap,
    mixedGap,
    controlGap,
    exposure: 100 - Math.min(labels, mixed, controlMatch),
    readiness,
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
        id: "catalog",
        label: "Data catalog",
        kind: "storage",
        health: healthFor(values.inventoryGap, 15, 40),
        utilization: values.inventoryGap / 100,
        sublabel: `${values.inventory.toFixed(0)}% of stores inventoried`,
        detail: "The inventory of stores, owners, and data types. Discovery has to include object buckets, topics, indexes, caches, and exports.",
      },
      {
        id: "bucket",
        label: "Shared bucket",
        kind: "storage",
        health: healthFor(values.mixedGap, 10, 35),
        utilization: values.mixedGap / 100,
        sublabel: `${values.mixed.toFixed(0)}% of mixed data labeled at the highest sensitivity`,
        detail: "A multi-tenant bucket holding public assets and customer records. The dataset inherits the controls of its most sensitive object.",
      },
      {
        id: "warehouse",
        label: "Warehouse table",
        kind: "db",
        health: healthFor(values.labelGap, 10, 35),
        utilization: values.labelGap / 100,
        sublabel: `${values.labels.toFixed(0)}% of datasets labeled`,
        detail: "Tables joined from multiple sources often contain more sensitive data than any single source. Column-level labels matter when access is column-level.",
      },
      {
        id: "logs",
        label: "Log pipeline",
        kind: "storage",
        health: healthFor(values.controlGap, 10, 35),
        utilization: values.controlGap / 100,
        sublabel: `${values.controlMatch.toFixed(0)}% of controls match the label`,
        detail: "Request logs, traces, and error reports can capture identifiers, tokens, and payload fields. A debug log is a data store with a retention period.",
      },
      {
        id: "export",
        label: "Support export",
        kind: "service",
        health: healthFor(values.controlGap, 10, 35),
        utilization: values.controlGap / 100,
        sublabel: `${values.controlMatch.toFixed(0)}% of controls match the label`,
        detail: "Exports, vendor feeds, and support attachments leave the primary system. Their classification follows the content, not the destination.",
      },
      {
        id: "public",
        label: "Public site",
        kind: "service",
        health: "ok",
        utilization: 0.2,
        sublabel: "public by design",
        detail: "The contrast case. Public content still has integrity and retention requirements, but it does not need the same confidentiality controls as restricted data.",
      },
    ],
    edges: [
      edge("catalog-bucket", "catalog", "bucket", clamp(values.inventory / 100), healthFor(values.inventoryGap, 15, 40)),
      edge("bucket-warehouse", "bucket", "warehouse", clamp(values.mixed / 100), healthFor(values.mixedGap, 10, 35)),
      edge("warehouse-logs", "warehouse", "logs", clamp(values.controlMatch / 100), healthFor(values.controlGap, 10, 35)),
      edge("warehouse-export", "warehouse", "export", clamp(values.controlMatch / 100), healthFor(values.controlGap, 10, 35)),
      edge("catalog-public", "catalog", "public", 1),
    ],
    metrics: [
      metric("sensitive-exposure", "Sensitive data under weak controls", values.exposure, "%", 10, 35, "percent"),
      metric("inventory-gap", "Stores missing from the catalog", values.inventoryGap, "%", 15, 40, "percent"),
      metric("control-mismatch", "Controls weaker than the label", values.controlGap, "%", 10, 30, "percent"),
      metric("classified-share", "Datasets with a label", values.labels, "%", undefined, undefined, "percent"),
      metric("readiness-floor", "Classification readiness floor", values.readiness, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Sensitive data sits under weaker controls on ${values.exposure.toFixed(0)}% of modeled paths; ${values.inventoryGap.toFixed(0)}% of stores are missing from the catalog; the readiness floor is ${values.readiness.toFixed(0)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "sensitive-exposure",
    metricId: "sensitive-exposure",
    warn: 10,
    crit: 35,
    title: "Sensitive data is stored under public controls",
    cause:
      "The exposure metric is set by the weakest of labeling, mixed-data handling, and control matching. A dataset can have a label and still sit in a bucket with public access. A mixed dataset labeled from its majority content hides the sensitive objects inside it. A label that does not change access, encryption, retention, or logging is not enforced.",
    fix:
      "Classify the dataset by its most sensitive content, not its majority or its location. Move sensitive objects into a store with matching controls, or apply object-level policy and encryption. Enforce access from the label, verify it with a real read attempt, and treat mixed datasets as restricted until the data is separated.",
    checkFirst: [
      "What is the most sensitive field or object in the dataset?",
      "Can a public or internal principal read the sensitive objects?",
      "Does the label change access, encryption, retention, and logging?",
    ],
  },
  {
    id: "inventory-gap",
    metricId: "inventory-gap",
    warn: 15,
    crit: 40,
    title: "Unknown stores escape classification entirely",
    cause:
      "A store that is missing from the catalog never receives a label or a control review. Copies created by analytics, debugging, support, and vendor exports are common blind spots because they are created by teams outside the primary data path.",
    fix:
      "Discover stores from cloud APIs, data-plane traffic, and application manifests rather than asking teams to self-report. Assign an owner to every store, classify its contents, and add creation of new stores to review. Re-run discovery after new integrations and batch jobs.",
    checkFirst: [
      "Which stores were created outside the provisioning pipeline?",
      "Do analytics, logs, and support exports appear in the catalog?",
      "Who owns a store with no recorded owner?",
    ],
  },
];

export const dataClassificationModel: SimModel = {
  id: "compliance-data-classification",
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
    if (values.exposure >= 35 && frame.flags.exposureEvent !== 1) {
      pushEvent(next, {
        id: "sensitive-under-public-controls",
        at: frame.t,
        severity: "crit",
        title: "Sensitive data is stored under weaker controls",
        detail: `Sensitive data sits under weaker controls on ${values.exposure.toFixed(0)}% of modeled paths. The readiness floor is ${values.readiness.toFixed(0)}%, and ${values.inventoryGap.toFixed(0)}% of stores are missing from the catalog.`,
        nodeId: "bucket",
        metricId: "sensitive-exposure",
      });
      next.flags.exposureEvent = 1;
    }
    if (values.exposure < 35) next.flags.exposureEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Sensitive data sits under weaker controls on ${values.exposure.toFixed(0)}% of modeled paths; ${values.inventoryGap.toFixed(0)}% of stores are missing from the catalog; the readiness floor is ${values.readiness.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const axes = [
      { label: "inventory", value: values.inventory },
      { label: "labeling", value: values.labels },
      { label: "mixed-data handling", value: values.mixed },
      { label: "control matching", value: values.controlMatch },
    ].sort((a, b) => a.value - b.value);
    return [
      `The weakest axis is ${axes[0].label} at ${axes[0].value.toFixed(0)}%. Classification readiness is a floor: one unclassified path carries the risk of everything it contains.`,
      `Sensitive exposure is ${values.exposure.toFixed(0)}%. A mixed bucket labeled by its majority content can look public while holding customer records. The highest sensitivity in the dataset sets the label.`,
      `Controls match the label for ${values.controlMatch.toFixed(0)}% of datasets. A label that does not change access, encryption, retention, or logging is a comment, not a control.`,
      `The catalog covers ${values.inventory.toFixed(0)}% of stores. Unknown stores are outside every classification and control decision, including incident response.`,
      `The readiness floor is ${values.readiness.toFixed(0)}%. Labels are illustrative; an organization can use its own scheme, but the mapping from label to control has to be explicit and testable.`,
    ];
  },
  legend: [
    { label: "Control matches", tone: "ok" },
    { label: "Partial match", tone: "warn" },
    { label: "Exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every store is inventoried, labeled, mixed datasets inherit the highest sensitivity, and controls match the label.",
    tone: "ok",
    params: defaults({ inventory: 100, labels: 100, mixedHandling: 100, controlMatch: 100 }),
  },
  {
    id: "peak",
    label: "Label rollout",
    description: "Most stores are inventoried and labeled, but mixed datasets and control enforcement lag behind the rollout.",
    tone: "warn",
    params: defaults({ inventory: 90, labels: 80, mixedHandling: 70, controlMatch: 80 }),
  },
  {
    id: "failure",
    label: "Public bucket",
    description: "A shared bucket is treated as public, most stores are uninventoried, labels are sparse, and controls do not follow the data.",
    tone: "crit",
    params: defaults({ inventory: 40, labels: 30, mixedHandling: 10, controlMatch: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The catalog is complete, mixed data is restricted, labels are explicit, and access and encryption follow the label.",
    tone: "ok",
    params: defaults({ inventory: 100, labels: 100, mixedHandling: 100, controlMatch: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-mixed-bucket",
  title: "Predict the classification of a mixed bucket",
  simId: "data-classification",
  question:
    "A bucket holds public marketing images, internal runbooks, and customer account exports with email addresses and order history. What classification should the bucket carry, and what controls follow?",
  prediction: {
    options: [
      { id: "public", label: "Public, because most objects are marketing assets" },
      { id: "internal", label: "Internal, because it is not customer-facing" },
      { id: "highest", label: "The highest sensitivity present, with controls applied to the sensitive objects or the dataset split" },
      { id: "owner", label: "Whatever the owning team chooses in the tag" },
    ],
    correctOptionId: "highest",
    explanation:
      "Classification follows the most sensitive content in the dataset. A mixed bucket inherits restricted controls unless the sensitive objects are separated or object-level policy enforces the higher label. Labeling it public or internal because most objects are harmless leaves the customer exports readable under the weaker policy.",
  },
  setup: defaults({ inventory: 100, labels: 100, mixedHandling: 0, controlMatch: 100 }),
  runFor: 20,
  observe: [
    "Sensitive exposure jumps to 100% because mixed-data handling is the weakest axis.",
    "The shared bucket node fails while the catalog and public site stay healthy.",
    "The control match is perfect, but it is proving the wrong label.",
    "Raising mixed-data handling, not adding more labels, clears the threshold.",
  ],
  explain:
    "A label is a claim about the contents. If the claim is wrong, every control downstream is wrong with it. The bucket's access policy, encryption, retention, and incident handling all follow the label, so labeling a mixed dataset by its majority content understates the impact of a leak. The safe default is the highest sensitivity present, then separate the data so each store can carry a narrower label and cheaper controls.",
  fix: defaults({ inventory: 100, labels: 100, mixedHandling: 100, controlMatch: 100 }),
  debrief:
    "With mixed data handled at the highest sensitivity, the bucket no longer exposes customer exports under public controls. The tradeoff is real: a stricter label raises cost and friction for the public assets too. The better long-term fix is to split the stores so public content keeps public controls and sensitive content gets the restricted path. This module is engineering education, not legal advice; classification schemes and required controls depend on the organization's data and obligations.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Data classification is the practice of assigning a sensitivity label to a dataset so the same label can drive access, encryption, retention, logging, and incident handling. The label is not the goal. The goal is that a person or an automated policy can answer one question consistently: who may read this, and what must happen when it changes or leaks.",
  },
  {
    type: "p",
    text: "Organizations choose their own schemes. A common one is public, internal, confidential, and restricted, but those names are illustrative, not a legal standard. Some organizations map labels to a formal security categorization process, such as the one described in NIST SP 800-60, which considers confidentiality, integrity, and availability. Others use regulatory categories directly. What matters is that the label has a definition, an owner, and a control mapping.",
  },
  {
    type: "p",
    text: "The hard case is mixed data. A bucket, table, or index often holds content from several sources at different sensitivities. The dataset inherits the highest sensitivity present, because a read of the store can return the most sensitive object. Splitting the store is usually cheaper than applying the most expensive controls to everything forever.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Classification sits between discovery and enforcement. Discovery finds the stores. Classification assigns a label and an owner. Enforcement turns the label into policy: access control, encryption, retention, logging, and handling during an incident. A classification program that stops at a spreadsheet has produced a vocabulary, not a control.",
  },
  {
    type: "table",
    headers: ["Illustrative label", "Example content", "Controls that should follow"],
    rows: [
      ["Public", "Marketing pages, open documentation", "Integrity protection, retention, and change control"],
      ["Internal", "Runbooks, internal dashboards", "Authenticated access, standard logging, backup"],
      ["Confidential", "Customer records, contracts, support tickets", "Least privilege, encryption, limited export, incident notice"],
      ["Restricted", "Credentials, health data, card data, precise location", "Strong isolation, field-level access, audited reads, short retention"],
    ],
  },
  {
    type: "p",
    text: "The mapping is where engineering lives. If the restricted row only says strong isolation and the system has no way to enforce field-level access, the label is aspirational. The control has to be testable: a principal without the right role should fail a read, and the attempt should appear in the audit trail.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Sensitive data under weak controls: the share of modeled paths where the content is more sensitive than the policy.",
      "Stores missing from the catalog: the discovery gap, which puts a store outside every classification decision.",
      "Controls weaker than the label: the share of datasets whose enforcement does not match their label.",
      "Datasets with a label: coverage, which is necessary but not sufficient.",
      "Node states: catalog, shared bucket, warehouse table, log pipeline, support export, and a public site for contrast.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Label rollout and watch coverage look reasonable while mixed-data handling and enforcement lag. Apply Public bucket and compare the labeled warehouse with the failing shared bucket. Run the experiment before revealing the explanation, then apply Recovery and confirm that splitting or restricting the mixed data, not adding labels, closes the gap.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The labels in this module are illustrative. Your organization's classification scheme, required controls, and retention rules depend on its data, contracts, and regulatory obligations.",
  },
  { type: "sim", simId: "data-classification" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Every dataset had a label and the controls matched the labels, but the mixed bucket was classified from its majority content. The sensitive customer exports were therefore readable under public controls. Exposure rose to 100% because mixed-data handling was the weakest axis, and the shared bucket node failed while the catalog and public site stayed healthy.",
  },
  {
    type: "p",
    text: "Raising mixed-data handling closed the gap without changing the label coverage. The label was the problem, not the number of labels. When the fix works, the sensitive objects either move to a store with stronger controls or the dataset is labeled at the highest sensitivity and enforced object by object.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Catalog: store owner, data types, label, and the time of the last review.",
      "Access: can an internal principal read the sensitive objects in a mixed store?",
      "Encryption: is the sensitive data encrypted with the expected key scope?",
      "Retention: does the deletion schedule match the label, or does it keep everything forever?",
      "Logs: are sensitive identifiers and payload fields redacted before storage?",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Find the most sensitive field or object in the dataset, not the most common one.",
      "Test a read with a principal that should be denied by the label.",
      "Check whether the label changes access, encryption, retention, and logging.",
      "Look for stores created outside the provisioning pipeline.",
      "Trace one export to a support tool or vendor and check its label.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory the store and assign an owner before debating the label.",
      "Classify by the highest sensitivity present, then split the data where practical.",
      "Move sensitive objects to a store with matching access and encryption controls.",
      "Enforce the label through policy, not through documentation.",
      "Redact or drop sensitive fields from logs, traces, and error reports.",
      "Re-test a denied read and confirm the attempt is audited.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Fine-grained labels improve control precision and increase the number of policies and reviews.",
      "A small label set is easier to operate and can force expensive controls onto low-risk data.",
      "Splitting mixed stores reduces blast radius and adds pipelines, copies, and migration work.",
      "Field-level access is precise and adds query complexity and performance cost.",
      "Automatic classification scales and can mislabel ambiguous data; human review is slower and more accurate.",
      "Keeping data for analytics creates value and expands the classification and retention surface.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "mixed-dataset",
    question: "How do you classify a dataset that contains public, internal, and customer data?",
    difficulty: 2,
    hints: [
      "Start from the most sensitive object or field.",
      "A label is a claim about what a read can return.",
    ],
    answer:
      "I classify it at the highest sensitivity present unless the sensitive content is separated or enforced at object or field level. I would identify the most sensitive field, check whether a read of the dataset can return it, and examine the controls that the label would drive. If the store is mostly public content, the safer and often cheaper fix is to split it so public assets keep public controls and customer data gets the restricted path.",
    followUps: [
      "What if the sensitive data is only in historical objects?",
      "How do you handle a label that changes over time?",
      "Who owns the decision when two teams disagree?",
    ],
    redFlags: [
      "Uses the majority content to set the label.",
      "Assumes a folder name is a classification.",
      "Ignores historical or derived copies.",
    ],
    rubric: [
      "Uses highest sensitivity.",
      "Checks what a read can return.",
      "Considers splitting or field-level policy.",
      "Assigns an owner.",
    ],
  },
  {
    id: "label-enforcement",
    question: "How do you prove that a classification label actually changes system behavior?",
    difficulty: 3,
    hints: [
      "Test a read that should fail.",
      "Look for the label in policy, key scope, retention, and logs.",
    ],
    answer:
      "I would trace the label into at least one enforced policy and test it. For access, a principal without the required role should be denied, and the denial should be logged. For encryption, the data should use the key scope the label requires. For retention, the deletion schedule should differ by label. For incident handling, the label should determine the escalation path. If none of those change, the label is metadata without a control.",
    followUps: [
      "Which control would you test first?",
      "How do you detect drift after a policy change?",
      "What evidence would you show an auditor?",
    ],
    redFlags: [
      "Points to a tag without a policy.",
      "Tests only the happy path.",
      "Has no audit record of access decisions.",
    ],
    rubric: [
      "Traces label to policy.",
      "Tests a denied read.",
      "Covers more than access.",
      "Checks evidence and drift.",
    ],
  },
  {
    id: "discovery",
    question: "A team creates an analytics copy outside the provisioning pipeline. How do you find it and what do you do?",
    difficulty: 3,
    hints: [
      "Discovery has to come from the platform, not self-reporting.",
      "The copy inherits the source's sensitivity.",
    ],
    answer:
      "I would detect it from cloud or data-plane telemetry, not from a survey. Once found, I would identify the owner and the source data, classify it at the source's sensitivity, and check whether its access and retention match. Then I would either bring it into the provisioning path or remove it. The systemic fix is to make store creation emit an inventory record and to review new stores automatically, because one manual catch does not prevent the next copy.",
    followUps: [
      "How do you avoid breaking a legitimate analytics job?",
      "What if the copy has no owner?",
      "How often should discovery run?",
    ],
    redFlags: [
      "Relies on teams to report their own copies.",
      "Deletes data without checking retention or legal hold.",
      "Fixes the instance and not the process.",
    ],
    rubric: [
      "Uses platform discovery.",
      "Classifies from the source.",
      "Assigns ownership.",
      "Fixes the creation path.",
    ],
  },
];

const checklist = [
  {
    title: "Discovery",
    items: [
      "Inventory stores from cloud APIs, data-plane traffic, and application manifests.",
      "Include logs, caches, topics, search indexes, backups, and support exports.",
      "Assign an owner to every store, including stores with no application owner.",
      "Record the last review date and the data types found.",
    ],
  },
  {
    title: "Classification",
    items: [
      "Define the label set and what each label means for access, encryption, retention, and logging.",
      "Classify mixed datasets at the highest sensitivity present.",
      "Split stores where the cost of the stronger control outweighs the separation work.",
      "Document the rationale for any label that is not obvious.",
    ],
  },
  {
    title: "Enforcement",
    items: [
      "Map each label to enforceable policy, not only to a tag.",
      "Test a denied read and confirm the attempt is logged.",
      "Redact sensitive fields from logs and error reports.",
      "Re-run discovery and label review after new integrations.",
    ],
  },
];

const references = [
  {
    title: "NIST SP 800-60 Vol. 1 Rev. 1 — Guide for Mapping Types of Information and Information Systems to Security Categories",
    url: "https://csrc.nist.gov/pubs/sp/800/60/v1/r1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Formal approach to security categorization across confidentiality, integrity, and availability. Useful when a label needs a defensible definition.",
  },
  {
    title: "NIST SP 800-53 Rev. 5 — Security and Privacy Controls",
    url: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Control catalog with access, audit, media protection, and data retention controls that a classification scheme can map to.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "data-classification": {
      model: dataClassificationModel,
      presets,
      instructions:
        "Start Healthy, then apply Label rollout and Public bucket. Compare label coverage with mixed-data handling and control matching. Run the experiment before revealing the explanation, then apply Recovery and confirm that the mixed bucket, not the label count, was the exposure.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Labels, coverage percentages, and the 10/35 thresholds are teaching values. Real classification schemes and required controls depend on the organization's data and obligations.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-phi", "compliance-pci-dss", "compliance-retention"],
};
