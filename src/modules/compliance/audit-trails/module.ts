import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "sourceCoverage",
    label: "Relevant systems emitting audit events",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Coverage",
    help: "Share of systems that can change the resource and emit an attributable event: the control plane, identity provider, ticketing system, and deployment pipeline.",
    format: "percent" as const,
  },
  {
    id: "actorCoverage",
    label: "Events with a verified actor",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Coverage",
    help: "Share of events tied to a human, service role, or session that can be verified. A shared administrator account or a missing principal makes an event unattributable.",
    format: "percent" as const,
  },
  {
    id: "clockSync",
    label: "Events with synchronized time",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Ordering",
    help: "Share of events whose timestamps come from a synchronized source with a known offset. Comparing two systems with drifting clocks can invert the order of a change and its approval.",
    format: "percent" as const,
  },
  {
    id: "integrity",
    label: "Events with integrity protection",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Integrity",
    help: "Share of audit records protected against silent modification or deletion, with a verification path. An editable log is a suggestion, not evidence.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  source: number;
  actor: number;
  clock: number;
  integrity: number;
  attributionGap: number;
  orderingGap: number;
  integrityGap: number;
  coverage: number;
}

function compute(p: Params): Computed {
  const source = clamp(num(p, "sourceCoverage", 100), 0, 100);
  const actor = clamp(num(p, "actorCoverage", 100), 0, 100);
  const clock = clamp(num(p, "clockSync", 100), 0, 100);
  const integrity = clamp(num(p, "integrity", 100), 0, 100);
  return {
    source,
    actor,
    clock,
    integrity,
    attributionGap: 100 - Math.min(source, actor),
    orderingGap: 100 - clock,
    integrityGap: 100 - integrity,
    coverage: Math.min(source, actor, clock, integrity),
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
  const attributionHealth = healthFor(values.attributionGap, 10, 25);
  return {
    t: 0,
    nodes: [
      {
        id: "idp",
        label: "Identity provider",
        kind: "service",
        health: healthFor(100 - values.actor, 10, 25),
        utilization: values.attributionGap / 100,
        sublabel: `${values.actor.toFixed(0)}% of events have a verified actor`,
        detail: "The source of human and workload identity. A shared account or an unverified session breaks attribution for every system downstream.",
      },
      {
        id: "control",
        label: "Control-plane log",
        kind: "storage",
        health: healthFor(100 - values.source, 10, 30),
        utilization: (100 - values.source) / 100,
        sublabel: `${values.source.toFixed(0)}% of systems emit events`,
        detail: "Management events from the cloud or platform control plane. They record the API action, the resource, the caller, and the result.",
      },
      {
        id: "approvals",
        label: "Approval records",
        kind: "storage",
        health: healthFor(100 - values.source, 10, 30),
        utilization: (100 - values.source) / 100,
        sublabel: `${values.source.toFixed(0)}% of change paths produce an approval record`,
        detail: "Who approved the change, for what scope, and when. The approval system is often separate from the control plane, so the link has to be explicit.",
      },
      {
        id: "change",
        label: "Change record",
        kind: "db",
        health: attributionHealth,
        utilization: values.attributionGap / 100,
        sublabel: `${values.attributionGap.toFixed(0)}% of events cannot be fully attributed`,
        detail: "The ticket or deployment record that ties intent to the change. It needs the same actor identity and a reference to the control-plane event.",
      },
      {
        id: "archive",
        label: "Audit archive",
        kind: "storage",
        health: healthFor(values.orderingGap, 5, 20),
        utilization: values.orderingGap / 100,
        sublabel: `${values.clock.toFixed(0)}% of events have synchronized time`,
        detail: "The retained, ordered record. Timestamps from drifting hosts can invert the sequence of a change and its approval.",
      },
      {
        id: "evidence",
        label: "Evidence export",
        kind: "storage",
        health: healthFor(values.integrityGap, 5, 20),
        utilization: values.integrityGap / 100,
        sublabel: `${values.integrity.toFixed(0)}% of records are tamper-evident`,
        detail: "The package an auditor samples: complete, readable, linked to the source, and protected against silent edits.",
      },
    ],
    edges: [
      edge("idp-control", "idp", "control", clamp(values.actor / 100), healthFor(100 - values.actor, 10, 25)),
      edge("control-approvals", "control", "approvals", clamp(values.source / 100), healthFor(100 - values.source, 10, 30)),
      edge("approvals-change", "approvals", "change", clamp(values.actor / 100), attributionHealth),
      edge("change-archive", "change", "archive", clamp(values.clock / 100), healthFor(values.orderingGap, 5, 20)),
      edge("archive-evidence", "archive", "evidence", clamp(values.integrity / 100), healthFor(values.integrityGap, 5, 20)),
    ],
    metrics: [
      metric("attribution-gap", "Changes without a verified actor", values.attributionGap, "%", 10, 25, "percent"),
      metric("ordering-gap", "Events without trustworthy ordering", values.orderingGap, "%", 5, 20, "percent"),
      metric("integrity-gap", "Records without integrity protection", values.integrityGap, "%", 5, 20, "percent"),
      metric("trail-coverage", "Reconstructable trail coverage", values.coverage, "%", undefined, undefined, "percent"),
      metric("clock-coverage", "Synchronized clocks", values.clock, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Attribution is missing for ${values.attributionGap.toFixed(0)}% of changes; ${values.orderingGap.toFixed(0)}% of events lack trustworthy ordering; integrity protection covers ${values.integrity.toFixed(0)}%.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "attribution-gap",
    metricId: "attribution-gap",
    warn: 10,
    crit: 25,
    title: "A change cannot be attributed to an actor",
    cause:
      "Attribution needs the emitting system and a verified actor. A shared administrator account, a proxy that strips the caller, or a change path that produces no event leaves the trail without a who. A control-plane log with an anonymous or role-only principal answers what happened but not who did it.",
    fix:
      "Emit an event from every system that can change the resource. Carry the human or workload identity, the session, the source account or address, and the request ID end to end. Remove shared administrative accounts, or bind each session to an individual identity. Join the control-plane event to the approval and change records with a shared identifier.",
    checkFirst: [
      "Which change paths produce no audit event?",
      "Can the actor be resolved to a person or a specific workload identity?",
      "Is there a shared identifier linking the event, approval, and change record?",
    ],
  },
  {
    id: "ordering-gap",
    metricId: "ordering-gap",
    warn: 5,
    crit: 20,
    title: "The sequence of events cannot be trusted",
    cause:
      "Each system writes its own timestamp. If the clocks drift, the order of a change and its approval can invert, or two events can appear simultaneous when they were not. A local timezone or an unsynchronized host compounds the problem because the offset is unknown.",
    fix:
      "Synchronize hosts to a common time source and record the offset. Store UTC with a consistent precision, keep the original timestamp, and include a monotonic sequence or ingest time where available. When the sequence matters, corroborate with the control plane and the approval system rather than trusting one clock.",
    checkFirst: [
      "Do the control plane, approval system, and change record use the same time source?",
      "Is the offset recorded and bounded?",
      "Can two events be ordered by a sequence number instead of wall-clock time?",
    ],
  },
  {
    id: "integrity-gap",
    metricId: "integrity-gap",
    warn: 5,
    crit: 20,
    title: "The audit record can be edited or deleted",
    cause:
      "An audit trail stored in a writable bucket with the same credentials as the workload is not evidence. A compromised principal can delete the event that records its own action. Missing integrity protection also makes it impossible to show that an export was not altered after collection.",
    fix:
      "Write audit records to a separate account or store with restricted write access. Use object lock, retention controls, or hash chaining with periodic verification. Restrict deletion to a break-glass role, alert on changes to the log configuration, and verify a sample export against its digest.",
    checkFirst: [
      "Can the workload delete or modify its own audit records?",
      "Is there an independent verification path for a sampled export?",
      "Who can change the log retention or destination configuration?",
    ],
  },
];

export const auditTrailsModel: SimModel = {
  id: "compliance-audit-trails",
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
    if (values.attributionGap >= 25 && frame.flags.attributionEvent !== 1) {
      pushEvent(next, {
        id: "unattributable-change",
        at: frame.t,
        severity: "crit",
        title: "A production change cannot be attributed",
        detail: `Attribution is missing for ${values.attributionGap.toFixed(0)}% of changes and ${values.orderingGap.toFixed(0)}% of events lack trustworthy ordering. The auditor can see that a role changed but cannot establish who changed it or whether approval came first.`,
        nodeId: "change",
        metricId: "attribution-gap",
      });
      next.flags.attributionEvent = 1;
    }
    if (values.attributionGap < 25) next.flags.attributionEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Attribution is missing for ${values.attributionGap.toFixed(0)}% of changes; ${values.orderingGap.toFixed(0)}% of events lack trustworthy ordering; integrity protection covers ${values.integrity.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The reconstructable trail covers ${values.coverage.toFixed(0)}% of modeled requirements. A trail is only as complete as its weakest property: coverage, actor, time, or integrity.`,
      `Attribution is missing for ${values.attributionGap.toFixed(0)}% of changes. A role name in a log is not an actor; the identity has to resolve to a person or a specific workload.`,
      `Ordering is unreliable for ${values.orderingGap.toFixed(0)}% of events. When the control plane and the approval system disagree, first check the clock offset before concluding that the approval came late.`,
      `Integrity protection covers ${values.integrity.toFixed(0)}%. If the workload can delete its own audit record, the trail cannot prove a negative.`,
      "A defensible trail joins the control-plane event, the approval, and the change record with a shared identifier, then retains the joined evidence for the required period.",
    ];
  },
  legend: [
    { label: "Reconstructable", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Not defensible", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every change path emits an event with a verified actor, synchronized time, and tamper-evident retention.",
    tone: "ok",
    params: defaults({ sourceCoverage: 100, actorCoverage: 100, clockSync: 100, integrity: 100 }),
  },
  {
    id: "peak",
    label: "Coverage gaps",
    description: "Most systems emit events, but some changes lack a verified actor, one clock drifts, and integrity protection is partial.",
    tone: "warn",
    params: defaults({ sourceCoverage: 90, actorCoverage: 80, clockSync: 95, integrity: 90 }),
  },
  {
    id: "failure",
    label: "Shared admin",
    description: "A shared administrator account changes a production role, several systems omit events, clocks drift, and the archive is writable by the workload.",
    tone: "crit",
    params: defaults({ sourceCoverage: 50, actorCoverage: 20, clockSync: 40, integrity: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Every path emits an attributable event, clocks are synchronized, and the archive is tamper-evident and retained.",
    tone: "ok",
    params: defaults({ sourceCoverage: 100, actorCoverage: 100, clockSync: 100, integrity: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-clock-order",
  title: "Predict whether the approval came before the change",
  simId: "audit-trails",
  question:
    "The control plane records a production role change at 14:02. The approval ticket is stamped 14:05, but the ticket server clock is ten minutes behind. Can you conclude the change happened before approval?",
  prediction: {
    options: [
      { id: "before", label: "Yes. 14:02 is earlier than 14:05" },
      { id: "cannot", label: "No. With a ten-minute clock offset, the true approval time may be 13:55, so the order is unknown" },
      { id: "after", label: "Yes, the change must have happened after approval because tickets are reviewed first" },
      { id: "irrelevant", label: "No, but ordering does not matter if the change was legitimate" },
    ],
    correctOptionId: "cannot",
    explanation:
      "Wall-clock timestamps from two systems are only comparable when both clocks are synchronized and the offset is known. A ten-minute lag on the ticket server moves the apparent approval from 14:05 to 13:55, before the change. The trail cannot establish order from these two fields alone; it needs a synchronized source, a sequence number, or an ingest time that preserves causality.",
  },
  setup: defaults({ sourceCoverage: 100, actorCoverage: 100, clockSync: 30, integrity: 100 }),
  runFor: 20,
  observe: [
    "Trustworthy ordering coverage falls to 30% while attribution stays complete.",
    "The audit archive node fails because comparability depends on the clock offset.",
    "The change and approval records exist, but the sequence between them is ambiguous.",
    "Restoring clock synchronization clears the ordering threshold without adding another log source.",
  ],
  explain:
    "An audit trail is a reconstruction, not a transcript from one system. The control plane knows the API call, the ticket system knows the approval, and the change record knows the intent. To order them, the team must control the clocks and preserve a causal reference. When the clocks disagree, the honest answer is that the order is unknown. That is different from concluding misconduct, and it is enough to fail an evidentiary test.",
  fix: defaults({ sourceCoverage: 100, actorCoverage: 100, clockSync: 100, integrity: 100 }),
  debrief:
    "With synchronized time, the same change and approval can be ordered and the archive node recovers. The fix was not more log volume; it was a property of the evidence. A defensible trail needs coverage, a verified actor, comparable time, and integrity together. This module is engineering education, not legal advice; the evidentiary standard and the retention period depend on the matter and the applicable rules.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An audit trail is a reconstruction of who changed what, when, from where, and with what approval. It is not one log file. It combines control-plane events, identity records, approval tickets, and change records, and it depends on synchronized time and integrity protection to make the sequence defensible. An auditor asking for the history of a production role is testing the whole chain.",
  },
  {
    type: "p",
    text: "Control-plane logs are the usual starting point. AWS CloudTrail, for example, records management events for API actions with the caller identity, source, time, and result. That answers part of the question. The approval and the change record usually live in other systems, so the trail has to join them with a shared identifier and a comparable timestamp.",
  },
  {
    type: "p",
    text: "Two properties are easy to miss. First, clocks drift; a local timestamp is not comparable to a control-plane timestamp unless both are synchronized and the offset is known. Second, a log the workload can edit or delete is not evidence. Integrity protection, restricted deletion, and a separate archive turn a record into something an auditor can rely on.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The trail spans the identity provider, the control plane, the approval system, the deployment or change record, and the archive. Each system owns one part of the answer. The engineering job is to preserve the links: the same actor, the same request or change identifier, and a time that can be ordered across systems.",
  },
  {
    type: "table",
    headers: ["Question", "Signal", "Failure mode"],
    rows: [
      ["Who", "Verified principal, session, source account", "Shared admin account or a stripped caller"],
      ["What", "API action, resource, request parameters", "Data-plane change with no management event"],
      ["When", "Synchronized UTC timestamp, sequence, ingest time", "Drifting clocks invert the order"],
      ["From where", "Source address, account, network path", "Proxy or bastion hides the origin"],
      ["Outcome", "Success or error code, affected resource", "Only the request is logged, not the result"],
      ["Approval", "Ticket, approver, scope, decision time", "Ticket cannot be linked to the change"],
    ],
  },
  {
    type: "p",
    text: "The trail is only as strong as its weakest property. Complete coverage with anonymous actors fails attribution. Perfect attribution with drifting clocks fails ordering. A clean sequence stored in a writable bucket fails integrity. The model therefore scores the minimum, not the average.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Changes without a verified actor: the share of events that cannot be tied to a person or specific workload identity.",
      "Events without trustworthy ordering: the share whose timestamps cannot be compared across systems.",
      "Records without integrity protection: the share that a workload or operator could silently modify.",
      "Reconstructable trail coverage: the weakest of coverage, actor, time, and integrity.",
      "Node states: identity provider, control-plane log, approval records, change record, audit archive, and evidence export.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Coverage gaps and compare attribution with ordering. Apply Shared admin and watch the change and archive nodes fail while some logs still exist. Run the experiment before revealing the explanation, then apply Recovery and confirm that synchronized time and integrity, not more log volume, restore the trail.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The required retention, the evidentiary standard, and the response to a dispute depend on the matter and the applicable rules. Use this module to build a trail that can be reconstructed, then involve counsel for a legal decision.",
  },
  { type: "sim", simId: "audit-trails" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The control plane logged a role change, the approval ticket existed, and the change record existed, but the clock offset made the order ambiguous. Attribution was also weak because the actor was a shared administrator, and integrity was partial because the archive was writable by the workload. Coverage was 30%, so the trail could not answer the auditor's question even though three systems had produced records.",
  },
  {
    type: "p",
    text: "Restoring synchronized time and verified actors raised the reconstructable coverage without adding a new log source. The lesson is that a trail is a set of evidence properties, not a volume of events. More logs with the same anonymous actor and drifting clocks do not help.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Control plane: management events with caller, source, request ID, and outcome.",
      "Identity: a principal that resolves to a person or a specific workload, not a shared account.",
      "Approvals: a ticket linked to the change by a shared identifier and a comparable time.",
      "Change record: intent, scope, deployment or configuration result, and rollback.",
      "Archive: tamper-evident storage, restricted deletion, retention, and a verification path.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Name the systems that can change the resource and confirm each emits an event.",
      "Resolve the actor for one change to a person or a specific workload identity.",
      "Compare the control-plane and approval timestamps for a known clock offset.",
      "Check whether the workload can delete or modify its own audit records.",
      "Reconstruct one privileged change end to end before the auditor asks.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Cover every change path, including data-plane and break-glass actions.",
      "Carry a verified actor and a shared request or change identifier end to end.",
      "Synchronize clocks and record the offset; use a sequence where order matters.",
      "Write audit records to a separate, restricted, tamper-evident archive.",
      "Restrict deletion and alert on changes to logging configuration.",
      "Reconstruct a sample change after every material change to the pipeline.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Full data-plane logging improves coverage and produces high volume and cost; management events alone can miss the actual data change.",
      "Immutable archives improve integrity and complicate deletion, correction, and retention changes.",
      "Long retention supports investigations and increases storage and privacy exposure.",
      "Centralizing logs simplifies the join and creates a high-value target that needs its own controls.",
      "Strict clock synchronization is cheap to operate and can fail closed when a source cannot prove its time.",
      "A shared identifier across tools is essential and requires integration work that no single vendor provides.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "reconstruct-change",
    question: "How would you reconstruct the change history of a production role?",
    difficulty: 2,
    hints: [
      "Start from the resource, not from a log file.",
      "Join the control plane, approval, and change record by a shared identifier.",
    ],
    answer:
      "I would start with the resource and the time window, then pull control-plane events for the role and its policy attachments. I would resolve each caller to a person or workload, then join to the approval ticket and the change record by request or change identifier. I would check that the timestamps are comparable and that the archive is intact. The output is a sequence with actor, action, resource, approval, outcome, and source, plus the gaps where a system did not emit an event.",
    followUps: [
      "What if the change was made through a break-glass role?",
      "How do you handle a change made by an automated pipeline?",
      "What would you do if the ticket cannot be linked?",
    ],
    redFlags: [
      "Reads only one log source.",
      "Accepts a role name as the actor.",
      "Ignores timestamp comparability.",
    ],
    rubric: [
      "Starts from the resource.",
      "Joins multiple systems.",
      "Resolves the actor.",
      "Names gaps and evidence properties.",
    ],
  },
  {
    id: "clock-skew",
    question:
      "A control-plane event and an approval ticket disagree by five minutes. How do you decide what happened?",
    difficulty: 3,
    hints: [
      "Do not assume either clock is correct.",
      "Look for a sequence or ingest time.",
    ],
    answer:
      "I would not decide from the wall-clock fields alone. I would check the synchronization source and the recorded offset for both systems, then look for a sequence number, request identifier, or ingest time that preserves causality. If the offset is unknown, the honest conclusion is that the order cannot be established from those records. I would fix the clock source and add a comparable sequence before relying on the trail for future changes.",
    followUps: [
      "What offset would you consider acceptable?",
      "How do you prove the fix works?",
      "When would you escalate instead of reconstructing?",
    ],
    redFlags: [
      "Trusts the control-plane clock by default.",
      "Assumes the approval was late.",
      "Ignores the unknown offset.",
    ],
    rubric: [
      "Checks synchronization and offset.",
      "Seeks a causal sequence.",
      "States when order is unknowable.",
      "Fixes the source.",
    ],
  },
  {
    id: "integrity",
    question: "What makes an audit archive defensible rather than just retained?",
    difficulty: 3,
    hints: [
      "Separation of duties matters.",
      "A record you can edit is not evidence.",
    ],
    answer:
      "I would separate the archive from the workload's credentials, restrict deletion to a break-glass role, and use tamper-evident storage or hash chaining with periodic verification. The archive needs a defined retention period, a readable export, and a way to prove that a sample was not altered after collection. I would also alert on changes to the logging configuration itself, because turning off the source is an easier attack than editing the record.",
    followUps: [
      "How do you verify a sampled export?",
      "Who can delete an audit record?",
      "How do you handle a legal hold on the archive?",
    ],
    redFlags: [
      "Stores logs in the same writable bucket as the workload.",
      "Has no deletion control.",
      "Cannot verify an export.",
    ],
    rubric: [
      "Separates duties.",
      "Restricts deletion.",
      "Uses tamper evidence.",
      "Defines retention and verification.",
    ],
  },
];

const checklist = [
  {
    title: "Build",
    items: [
      "Enumerate every system that can change the resource, including data-plane and break-glass paths.",
      "Carry a verified actor and a shared request or change identifier end to end.",
      "Synchronize clocks and record the offset; add a sequence where order matters.",
      "Write to a separate archive with restricted deletion and tamper evidence.",
    ],
  },
  {
    title: "Verify",
    items: [
      "Reconstruct one privileged change from the control plane to the approval and the result.",
      "Confirm that the actor resolves to a person or a specific workload.",
      "Check that timestamps are comparable across systems.",
      "Verify a sample export against its digest or integrity record.",
    ],
  },
  {
    title: "Operate",
    items: [
      "Alert on changes to logging configuration and retention.",
      "Review coverage after new services and integrations ship.",
      "Test a restore or export from the archive.",
      "Reconstruct a sample after every material change to the pipeline.",
    ],
  },
];

const references = [
  {
    title: "AWS CloudTrail User Guide",
    url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Official documentation for management events, event history, log file integrity validation, and organization trails.",
  },
  {
    title: "NIST SP 800-92 — Guide to Computer Security Log Management",
    url: "https://csrc.nist.gov/pubs/sp/800/92/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Log management guidance covering generation, transmission, storage, analysis, retention, and disposal.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "audit-trails": {
      model: auditTrailsModel,
      presets,
      instructions:
        "Start Healthy, then apply Coverage gaps and Shared admin. Compare the actor, clock, and integrity metrics with the number of records that exist. Run the experiment before revealing the explanation, then apply Recovery and confirm that a defensible trail depends on all four properties, not on log volume.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 5/10/20/25 thresholds are teaching values. A real audit trail depends on the systems in scope, the retention requirement, and the evidentiary standard for the matter.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-audit-logs", "compliance-retention", "compliance-soc2"],
};
