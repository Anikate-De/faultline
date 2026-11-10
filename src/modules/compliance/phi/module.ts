import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "healthShare",
    label: "Records with health data",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data",
    help: "Share of records that contain a diagnosis, medication, lab result, treatment, or payment detail tied to care.",
    format: "percent" as const,
  },
  {
    id: "identifierShare",
    label: "Records with an identifier",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data",
    help: "Share of records that contain a name, medical record number, email, account number, IP address, or another value that can single out a person.",
    format: "percent" as const,
  },
  {
    id: "deidentification",
    label: "Validated de-identification",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Control",
    help: "Share of records processed with a de-identification method that meets the standard: removal of the specified identifiers under Safe Harbor, or expert determination. Hashing alone is not this control.",
    format: "percent" as const,
  },
  {
    id: "logCapture",
    label: "Records copied to logs",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Copies",
    help: "Share of records whose fields are written to the log platform. Logs are a separate system with its own access, retention, and export paths.",
    format: "percent" as const,
  },
  {
    id: "vendorShare",
    label: "Records sent to an unapproved vendor",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Copies",
    help: "Share of records sent to a destination outside the approved data-flow boundary. An approved vendor is in scope of the boundary; an unapproved one is not.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  health: number;
  identifier: number;
  deidentification: number;
  logCapture: number;
  vendorShare: number;
  phiRate: number;
  residual: number;
  logPhi: number;
  vendorPhi: number;
  deidGap: number;
}

function compute(p: Params): Computed {
  const health = clamp(num(p, "healthShare", 100), 0, 100);
  const identifier = clamp(num(p, "identifierShare", 100), 0, 100);
  const deidentification = clamp(num(p, "deidentification", 100), 0, 100);
  const logCapture = clamp(num(p, "logCapture", 100), 0, 100);
  const vendorShare = clamp(num(p, "vendorShare", 0), 0, 100);
  const phiRate = (health * identifier) / 100;
  const residual = phiRate * (1 - deidentification / 100);
  return {
    health,
    identifier,
    deidentification,
    logCapture,
    vendorShare,
    phiRate,
    residual,
    logPhi: (residual * logCapture) / 10,
    vendorPhi: (residual * vendorShare) / 10,
    deidGap: residual > 0 ? 100 - deidentification : 0,
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
  const logHealth = healthFor(values.logPhi, 10, 100);
  const vendorHealth = healthFor(values.vendorPhi, 1, 10);
  const deidHealth = healthFor(values.deidGap, 20, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "source",
        label: "Clinical record source",
        kind: "db",
        health: "ok",
        utilization: values.phiRate / 100,
        sublabel: `${values.phiRate.toFixed(0)}% of records are PHI`,
        detail: "The primary record. Health data plus an identifier is PHI even before any copy leaves the system.",
      },
      {
        id: "classifier",
        label: "Field classifier",
        kind: "service",
        health: "ok",
        utilization: values.residual / 100,
        sublabel: `${values.residual.toFixed(0)}% remain identifiable`,
        detail: "Tags each field by sensitivity and decides which fields may pass to logs, analytics, or vendors.",
      },
      {
        id: "deid",
        label: "De-identification",
        kind: "worker",
        health: deidHealth,
        utilization: values.deidGap / 100,
        sublabel: `${values.deidentification.toFixed(0)}% validated`,
        detail: "Validated de-identification is a specific standard, not a regex that removes a name.",
      },
      {
        id: "warehouse",
        label: "Approved analytics",
        kind: "storage",
        health: "ok",
        utilization: values.residual / 100,
        sublabel: "inside the approved boundary",
        detail: "An approved system can hold PHI if access, audit, retention, and contract controls cover it.",
      },
      {
        id: "logs",
        label: "Log platform",
        kind: "stream",
        health: logHealth,
        utilization: clamp(values.logPhi / 1000),
        sublabel: `${values.logPhi.toFixed(0)} PHI records per 1k`,
        detail: "A copy of production fields with different access and a longer tail. Logs are a common unplanned PHI store.",
      },
      {
        id: "vendor",
        label: "Unapproved vendor",
        kind: "external",
        health: vendorHealth,
        utilization: clamp(values.vendorPhi / 1000),
        sublabel: `${values.vendorPhi.toFixed(0)} PHI records per 1k`,
        detail: "A destination outside the approved boundary. A signed contract does not make an unapproved data flow safe.",
      },
    ],
    edges: [
      edge("source-classifier", "source", "classifier", 1),
      edge("classifier-deid", "classifier", "deid", 1, deidHealth),
      edge("deid-warehouse", "deid", "warehouse", 1),
      edge("deid-logs", "deid", "logs", clamp(values.logCapture / 100), logHealth),
      edge("deid-vendor", "deid", "vendor", clamp(values.vendorShare / 100), vendorHealth),
    ],
    metrics: [
      metric("log-phi", "PHI in logs", values.logPhi, " /1k records", 10, 100, "count"),
      metric("vendor-phi", "PHI to unapproved vendor", values.vendorPhi, " /1k records", 1, 10, "count"),
      metric("residual-phi", "Identifiable PHI after de-identification", values.residual, "%", undefined, undefined, "percent"),
      metric("deid-gap", "De-identification gap", values.deidGap, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.residual.toFixed(0)}% of records remain identifiable PHI; logs carry ${values.logPhi.toFixed(0)} PHI records per 1,000; an unapproved vendor receives ${values.vendorPhi.toFixed(0)} per 1,000.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "log-phi",
    metricId: "log-phi",
    warn: 10,
    crit: 100,
    title: "PHI is accumulating in the log platform",
    cause:
      "Application logs copy fields from the primary record. When identifiers and health data are written before de-identification, the log platform becomes a second PHI system with broader access, longer retention, and its own export paths.",
    fix:
      "Classify fields at the source, drop or de-identify PHI before the log write, and add a test that fails when a forbidden field appears in a log event. Purging the index does not fix the emitter.",
    checkFirst: [
      "Search a sample log for diagnosis, medication, and identifier field names.",
      "Check the logger middleware for an allowlist, not a denylist of known bad fields.",
      "Check who can query the log platform and how long it retains events.",
    ],
  },
  {
    id: "vendor-phi",
    metricId: "vendor-phi",
    warn: 1,
    crit: 10,
    title: "PHI is reaching an unapproved system",
    cause:
      "An integration can copy PHI outside the approved data-flow boundary. Approval of the vendor, the fields, and the purpose is a separate control from encryption, and a de-identification step that runs after egress does not protect the data in transit.",
    fix:
      "Stop the egress, remove or de-identify the fields before they leave, and require a data-flow review and the appropriate agreement before restoring the integration. Treat already-sent records as exposed until proven otherwise.",
    checkFirst: [
      "Which integration sent the data, and which fields did it include?",
      "Is the destination in the approved data-flow inventory for this purpose?",
      "Does de-identification run before egress, and is the method validated?",
    ],
  },
];

export const phiModel: SimModel = {
  id: "compliance-phi",
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
    if (values.logPhi >= 100 && frame.flags.logEvent !== 1) {
      pushEvent(next, {
        id: "phi-in-logs",
        at: frame.t,
        severity: "crit",
        title: "PHI reached the log platform",
        detail: `${values.logPhi.toFixed(0)} of every 1,000 records are identifiable PHI in logs. The log platform now needs the same access, audit, and retention controls as the clinical record.`,
        nodeId: "logs",
        metricId: "log-phi",
      });
      next.flags.logEvent = 1;
    }
    if (values.logPhi < 100) next.flags.logEvent = 0;
    if (values.vendorPhi >= 10 && frame.flags.vendorEvent !== 1) {
      pushEvent(next, {
        id: "phi-to-unapproved-vendor",
        at: frame.t,
        severity: "crit",
        title: "PHI left the approved boundary",
        detail: `${values.vendorPhi.toFixed(0)} of every 1,000 records reached an unapproved vendor. Stop the egress and treat the destination as a PHI system until the data is contained.`,
        nodeId: "vendor",
        metricId: "vendor-phi",
      });
      next.flags.vendorEvent = 1;
    }
    if (values.vendorPhi < 10) next.flags.vendorEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.residual.toFixed(0)}% of records remain identifiable PHI; logs carry ${values.logPhi.toFixed(0)} PHI records per 1,000; an unapproved vendor receives ${values.vendorPhi.toFixed(0)} per 1,000.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `PHI requires both health information and a way to identify the person. Here ${values.health.toFixed(0)}% of records carry health data and ${values.identifier.toFixed(0)}% carry an identifier, so ${values.phiRate.toFixed(0)}% are PHI before de-identification.`,
      `Validated de-identification covers ${values.deidentification.toFixed(0)}% of records, leaving ${values.residual.toFixed(0)}% identifiable. Hashing a name or masking one field is not automatically de-identification under the standard.`,
      `${values.logPhi.toFixed(0)} PHI records per 1,000 reach logs and ${values.vendorPhi.toFixed(0)} reach an unapproved vendor. Both are copies, and each copy has its own access and retention.`,
      `The primary store can legitimately hold PHI. The failure is not that PHI exists; it is that PHI reached a system that was not designed and approved for it.`,
    ];
  },
  legend: [
    { label: "Contained", tone: "ok" },
    { label: "Copy at risk", tone: "warn" },
    { label: "Unapproved copy", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Validated de-identification covers every record before logs or any external copy. No unapproved vendor receives data.",
    tone: "ok",
    params: defaults({ healthShare: 100, identifierShare: 100, deidentification: 100, logCapture: 100, vendorShare: 0 }),
  },
  {
    id: "peak",
    label: "Coverage slips",
    description: "De-identification falls to 95% and 5% of records reach a vendor outside the approved boundary.",
    tone: "warn",
    params: defaults({ healthShare: 100, identifierShare: 100, deidentification: 95, logCapture: 100, vendorShare: 5 }),
  },
  {
    id: "failure",
    label: "Raw PHI everywhere",
    description: "No de-identification, full log capture, and full vendor egress. Identifiable PHI reaches systems that were never approved for it.",
    tone: "crit",
    params: defaults({ healthShare: 100, identifierShare: 100, deidentification: 0, logCapture: 100, vendorShare: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Validated de-identification runs before both log and vendor paths. The vendor remains unapproved, but it no longer receives PHI.",
    tone: "ok",
    params: defaults({ healthShare: 100, identifierShare: 100, deidentification: 100, logCapture: 100, vendorShare: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-log-phi",
  title: "Predict whether a log line is PHI",
  simId: "phi",
  question:
    "A log line contains a diagnosis code and a patient identifier. The log is an internal debugging system, not the clinical record. Is the line PHI?",
  prediction: {
    options: [
      { id: "no-system", label: "No. It is a log, not a patient record" },
      { id: "yes", label: "Yes. Health information tied to an identifier is PHI regardless of the system that stores it" },
      { id: "retained", label: "Only if the log is retained for more than 30 days" },
      { id: "named", label: "Only if the line contains the patient's full name" },
    ],
    correctOptionId: "yes",
    explanation:
      "PHI is defined by the information and the person it identifies, not by the system of record. A diagnosis code plus a patient identifier in a log is still individually identifiable health information. The log platform inherits the obligation, along with its own access list, retention, and export paths.",
  },
  setup: defaults({ healthShare: 100, identifierShare: 100, deidentification: 0, logCapture: 100, vendorShare: 0 }),
  runFor: 20,
  observe: [
    "Every record contains health data and an identifier, so the PHI rate is 100%.",
    "With no de-identification, the log platform receives 1,000 PHI records per 1,000.",
    "The log node fails while the primary store and approved analytics node stay healthy.",
    "Reducing log capture alone lowers the copy count, but the emitter still writes PHI for every captured event.",
  ],
  explain:
    "The decisive question is not where the data sits. It is whether the data can identify a person and relates to their health, care, or payment. A diagnosis code and an identifier satisfy that test. The correct control is to prevent the fields from entering the log, or to de-identify them with a validated method before the write. Log retention and access are secondary controls; they do not change what the data is.",
  fix: defaults({ healthShare: 100, identifierShare: 100, deidentification: 100, logCapture: 100, vendorShare: 0 }),
  debrief:
    "With validated de-identification before the log write, the same log volume contains no PHI. The approved clinical store still holds PHI, which is expected and allowed when its controls are in place. This is engineering education, not legal advice; whether a particular de-identification method is sufficient is a factual and legal determination that belongs with your privacy officer and counsel.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Protected health information (PHI) is individually identifiable health information held or transmitted by a covered entity or business associate. The definition turns on two things at once: the information relates to a person's health, care, or payment for care, and it identifies that person or could reasonably be used to identify them. A diagnosis code alone may not identify anyone; a patient identifier alone may not reveal health information. Together they are PHI.",
  },
  {
    type: "p",
    text: "The system that stores the data does not change the classification. A log line, a trace attribute, a backup, a support ticket, an analytics table, and a vendor export are all copies. Each copy inherits the obligation and adds its own access list, retention period, and export path. Teams often protect the primary database carefully and then copy the same fields into a log platform that a much larger group can query.",
  },
  {
    type: "p",
    text: "De-identification is a specific control, not a synonym for masking. HIPAA, the Health Insurance Portability and Accountability Act, recognizes two approaches: removal of the specified identifiers under the Safe Harbor method, and a documented expert determination that the risk of re-identification is very small. Hashing an email, replacing a name with a token, or dropping one obvious field may reduce risk without meeting either standard. If the remaining data can still single out a person, treat it as PHI.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "PHI handling sits on every copy path: the clinical source, the classifier that tags fields, the de-identification step, the approved analytics store, the log platform, and any vendor destination. The approved boundary is a data-flow decision, not a network zone alone. A vendor can be approved for one purpose and not another, and a log platform can be approved for operations while still being the wrong place for diagnosis codes.",
  },
  {
    type: "table",
    headers: ["Copy path", "Typical content", "Why it becomes a PHI problem"],
    rows: [
      ["Application log", "Request fields, errors, SQL parameters", "Broad query access and long retention"],
      ["Trace or error payload", "Attributes, headers, captured request body", "Copied to a third-party APM without review"],
      ["Analytics table", "Joined clinical and demographic data", "New access group and no retention limit"],
      ["Backup or archive", "Full record snapshots", "Deletion and access reviews rarely reach it"],
      ["Vendor export", "Reports, events, support bundles", "Destination outside the approved boundary"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative percentages and multiplies the health and identifier shares, which assumes the two overlap independently. Real datasets often correlate them; derive the rate from your own field inventory rather than from this curve. The shape is the lesson: exposure is the product of how much of the data is PHI, how much de-identification misses, and how many copies reach systems that were not approved for it. Reducing any one factor helps; the safest fix is to stop the fields at the emitter.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Identifiable PHI after de-identification: the share of records still tied to a person.",
      "PHI in logs per 1,000 records: the size of the unplanned log copy.",
      "PHI to an unapproved vendor per 1,000 records: the external exposure path.",
      "De-identification gap: the share of records without a validated method.",
      "Node states: the log platform and vendor destination fail while the approved source remains healthy.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Coverage slips and watch the log and vendor paths diverge. Apply Raw PHI everywhere and identify which node is the unapproved system. Run the experiment before revealing the explanation, then apply Recovery and check that the same log volume now carries no PHI.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. Whether data is PHI, whether a de-identification method qualifies, and which agreements are required depend on the facts and the applicable law. Involve your privacy officer and counsel before making a compliance decision.",
  },
  { type: "sim", simId: "phi" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The log path carried identifiable PHI because health data and identifiers were written before any de-identification. The primary store and approved analytics node stayed healthy, which is exactly the trap: the protected system looked fine while a copy with broader access became the exposure. The vendor path added a second failure when records left the approved boundary.",
  },
  {
    type: "p",
    text: "Validated de-identification before the copies are made removed the PHI from the log path and would do the same for a vendor copy. The log volume did not change; the classification of the data did. That is the difference between reducing a copy and controlling a field.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Log and trace payloads containing diagnosis, medication, lab, or identifier fields.",
      "Vendor egress lists that do not match the approved data-flow inventory.",
      "Retention settings on log, analytics, and archive stores.",
      "De-identification jobs with versioned rules and a measured re-identification risk.",
      "Access groups that can query the copies, not only the primary store.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Pick one request and list every system that receives its fields.",
      "Search the log and trace payloads for health and identifier field names.",
      "Check whether de-identification runs before egress or only inside the approved store.",
      "Confirm that each external destination is approved for this data and purpose.",
      "Check retention and query access on every copy, including backups.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the egress or log write that carries the PHI.",
      "Classify the fields at the source and switch to an allowlist for emitted fields.",
      "Apply a validated de-identification method before any copy leaves the approved boundary.",
      "Remove or contain the records that already reached an unapproved system.",
      "Add a test that fails when a forbidden field appears in a log or export.",
      "Re-check the data-flow inventory and retention after the fix.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Dropping fields at the emitter reduces exposure and can make debugging harder; use a redacted correlation ID and controlled re-run instead of raw payloads.",
      "Validated de-identification reduces risk and can remove useful detail for analytics; plan for an approved re-identification path with access controls.",
      "Shorter log retention reduces exposure and limits investigation; separate security audit logs from application debug logs.",
      "A stricter approved boundary reduces vendor exposure and slows integration work; require a data-flow review before launch, not after.",
      "Hashing identifiers is cheap and does not guarantee de-identification; treat it as a risk reduction unless the method has been validated.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "identify-phi",
    question:
      "A log contains a diagnosis code and a patient identifier. Is it PHI, and what do you do next?",
    difficulty: 2,
    hints: [
      "The system of record does not define PHI.",
      "Health data plus an identifier is the test.",
    ],
    answer:
      "Yes. The combination relates to a person's health and identifies them, so it is PHI even though it sits in a log. I would confirm which fields and which log platform are involved, stop or redact the emit path, and treat the retained copies as exposed. Then I would check access and retention on the log platform, remove the fields from the payload, and add a test that fails when a health or identifier field appears in a log event. I would not rely on deleting the index alone, because the emitter would recreate the problem.",
    followUps: [
      "What if the identifier is a hashed medical record number?",
      "Which systems received the same log stream?",
      "How do you prove the field no longer appears?",
    ],
    redFlags: [
      "Says logs are not PHI.",
      "Deletes the index without fixing the emitter.",
      "Assumes hashing is always de-identification.",
    ],
    rubric: [
      "Applies the health-plus-identifier test.",
      "Finds all copies.",
      "Stops the emitter.",
      "Adds a regression test.",
    ],
  },
  {
    id: "deid-method",
    question:
      "How do you decide whether a de-identification method is strong enough to remove PHI obligations?",
    difficulty: 3,
    hints: [
      "There are two recognized approaches, and both need documentation.",
      "Re-identification risk depends on the remaining data and the recipients.",
    ],
    answer:
      "I would start from the standard, not from a library name. The Safe Harbor approach removes the specified identifier categories; expert determination requires a documented analysis that the remaining data carries a very small re-identification risk. I would check which method the pipeline claims, whether it covers every field and every copy, and whether the documentation is current. Hashing or tokenization alone is not enough unless the analysis shows it meets the standard. I would also confirm that the de-identification runs before egress, not after, and that the recipient cannot join the data back to an identity through another dataset.",
    followUps: [
      "What changes if the recipient has the key to the tokens?",
      "How do you handle free-text notes?",
      "Who signs off on expert determination?",
    ],
    redFlags: [
      "Treats masking as de-identification by default.",
      "Ignores free-text fields.",
      "Has no documented method or risk analysis.",
    ],
    rubric: [
      "Names both recognized approaches.",
      "Checks coverage and timing.",
      "Considers re-identification and joins.",
      "Involves privacy or legal review.",
    ],
  },
  {
    id: "contain-copy",
    question:
      "PHI has reached an unapproved vendor. How do you contain it and prevent the next copy?",
    difficulty: 3,
    hints: [
      "Containment comes before root cause.",
      "The contract and the data flow are separate controls.",
    ],
    answer:
      "First I would stop the integration or revoke its credentials so no more records leave. Then I would identify the fields, volume, and time range that were sent, and treat the destination as a PHI system until the data is deleted or a valid agreement and approval cover it. I would preserve the evidence needed for the incident review, then fix the emitter or de-identification step and add a gate that requires an approved destination before egress. Finally I would verify the fix with a canary record and check whether the same pattern exists in other integrations. Legal and privacy teams need to be in the loop early because notification obligations may depend on the facts.",
    followUps: [
      "What evidence do you keep before deleting the vendor copy?",
      "How do you test the egress gate without sending real PHI?",
      "Who decides whether notification is required?",
    ],
    redFlags: [
      "Deletes evidence before scoping the exposure.",
      "Relies on the vendor's assurance alone.",
      "Fixes one integration without checking the pattern.",
    ],
    rubric: [
      "Stops the flow first.",
      "Scopes fields, volume, and time.",
      "Involves legal and privacy.",
      "Adds a preventive gate and verifies it.",
    ],
  },
];

const checklist = [
  {
    title: "Before launch",
    items: [
      "Map every field that leaves the primary store, including logs, traces, and vendor events.",
      "Classify each destination as approved or unapproved for the specific data and purpose.",
      "Run validated de-identification before egress, with a versioned rule set.",
      "Test that forbidden fields cannot appear in a log or export.",
    ],
  },
  {
    title: "During an exposure",
    items: [
      "Stop the egress or log write and preserve the evidence.",
      "Identify the fields, volume, time range, and destinations involved.",
      "Treat each unapproved copy as a PHI system until contained.",
      "Escalate to legal and privacy for notification decisions.",
    ],
  },
  {
    title: "After the fix",
    items: [
      "Verify the same path with a synthetic canary record.",
      "Check retention and access on every copy that received the data.",
      "Search for the same pattern in other services and integrations.",
      "Update the data-flow inventory and the field allowlist.",
    ],
  },
];

const references = [
  {
    title: "Guidance regarding methods for de-identification of protected health information",
    url: "https://www.hhs.gov/hipaa/for-professionals/special-topics/de-identification/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "Safe Harbor and expert determination, with the identifier categories.",
  },
  {
    title: "HIPAA Privacy Rule",
    url: "https://www.hhs.gov/hipaa/for-professionals/privacy/index.html",
    publisher: "U.S. Department of Health and Human Services",
    kind: "docs" as const,
    note: "The definition and permitted uses of PHI.",
  },
  {
    title: "De-Identifying Government Datasets (NIST SP 800-188)",
    url: "https://csrc.nist.gov/pubs/sp/800/188/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "De-identification techniques and re-identification risk, useful for engineering review.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    phi: {
      model: phiModel,
      presets,
      instructions:
        "Start Healthy, then apply Coverage slips and Raw PHI everywhere. Watch the log and vendor copies separately. Run the experiment before revealing the explanation, then apply Recovery and confirm that the log volume stays the same while the PHI count falls to zero.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Field shares and exposure rates are teaching values, not a legal determination or a provider guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-hipaa", "compliance-baa", "observability-pii-redaction"],
};
