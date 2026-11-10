import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "discoveryCoverage",
    label: "Stores that can find the subject",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Discovery",
    help: "Share of stores that can locate a person's records by a stable key. A copy that is never found cannot be deleted, anonymized, or suppressed.",
    format: "percent" as const,
  },
  {
    id: "deletionCoverage",
    label: "Primary and derived deletion coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Execution",
    help: "Share of discovered stores where a delete or overwrite actually removes the record. This includes the primary database, search indexes, warehouses, and feature stores.",
    format: "percent" as const,
  },
  {
    id: "anonymizationCoverage",
    label: "Log and event anonymization coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Execution",
    help: "Share of append-only data where identifiers are irreversibly removed or replaced. Redaction that can be reversed or re-joined is not anonymization.",
    format: "percent" as const,
  },
  {
    id: "backupControlCoverage",
    label: "Backups under an erasure policy",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Retention",
    help: "Share of backups covered by a documented handling path: suppression on restore, crypto-shredding, or expiry inside the committed window. The model rewards a tested policy, not an assumption that backups expire.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  discovery: number;
  deletion: number;
  anonymization: number;
  backupControl: number;
  residual: number;
  completeness: number;
  undiscovered: number;
  primaryGap: number;
  derivedGap: number;
  logsGap: number;
  backupGap: number;
}

function compute(p: Params): Computed {
  const discovery = clamp(num(p, "discoveryCoverage", 100), 0, 100);
  const deletion = clamp(num(p, "deletionCoverage", 100), 0, 100);
  const anonymization = clamp(num(p, "anonymizationCoverage", 100), 0, 100);
  const backupControl = clamp(num(p, "backupControlCoverage", 100), 0, 100);
  const discoveryShare = discovery / 100;
  const pathGap = Math.max(100 - deletion, 100 - anonymization, 100 - backupControl);
  const residual = Math.min(100, 100 - discovery + discoveryShare * pathGap);
  return {
    discovery,
    deletion,
    anonymization,
    backupControl,
    residual,
    completeness: 100 - residual,
    undiscovered: 100 - discovery,
    primaryGap: 100 - deletion,
    derivedGap: Math.max(100 - deletion, 100 - anonymization),
    logsGap: 100 - anonymization,
    backupGap: 100 - backupControl,
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
  const requestHealth = healthFor(values.residual, 5, 20);
  const primaryHealth = healthFor(values.primaryGap, 10, 40);
  const derivedHealth = healthFor(values.derivedGap, 10, 40);
  const logsHealth = healthFor(values.logsGap, 10, 40);
  const backupHealth = healthFor(values.backupGap, 10, 40);
  const verifyHealth = healthFor(values.undiscovered, 10, 30);
  return {
    t: 0,
    nodes: [
      {
        id: "request",
        label: "Erasure request",
        kind: "service",
        health: requestHealth,
        utilization: values.residual / 100,
        sublabel: `${values.completeness.toFixed(0)}% complete`,
        detail: "The deletion workflow. Completion means every store has either removed the identifiers or applied a documented, irreversible alternative.",
      },
      {
        id: "primary",
        label: "Primary database",
        kind: "db",
        health: primaryHealth,
        utilization: values.primaryGap / 100,
        sublabel: `${values.deletion.toFixed(0)}% deleted or overwritten`,
        detail: "The system of record. It is usually the first system to succeed, and the least likely to be the only copy.",
      },
      {
        id: "derived",
        label: "Derived stores",
        kind: "storage",
        health: derivedHealth,
        utilization: values.derivedGap / 100,
        sublabel: `${values.deletion.toFixed(0)}% deletion · ${values.anonymization.toFixed(0)}% anonymized`,
        detail: "Search indexes, warehouses, feature stores, and materialized views. They need a subject key and a rebuild or update path, or they retain a copy the primary store already deleted.",
      },
      {
        id: "logs",
        label: "Logs and event streams",
        kind: "storage",
        health: logsHealth,
        utilization: values.logsGap / 100,
        sublabel: `${values.anonymization.toFixed(0)}% identifiers removed`,
        detail: "Append-only data where deletion may be impractical. Irreversible anonymization, field removal at ingestion, or a documented suppression path can be the right control.",
      },
      {
        id: "backup",
        label: "Backups",
        kind: "storage",
        health: backupHealth,
        utilization: values.backupGap / 100,
        sublabel: `${values.backupControl.toFixed(0)}% under an erasure policy`,
        detail: "Backups are copies. Immediate rewriting may be impossible, so the policy has to cover suppression, key destruction, or expiry, plus a restore test that proves the record does not come back.",
      },
      {
        id: "verify",
        label: "Completion check",
        kind: "worker",
        health: verifyHealth,
        utilization: values.undiscovered / 100,
        sublabel: `${values.discovery.toFixed(0)}% of stores reachable`,
        detail: "The verification step. It must query every registered store for the subject key, not trust the primary job's success count.",
      },
    ],
    edges: [
      edge("request-primary", "request", "primary", clamp(values.deletion / 100), primaryHealth),
      edge("request-derived", "request", "derived", clamp(values.deletion / 100), derivedHealth),
      edge("request-logs", "request", "logs", clamp(values.anonymization / 100), logsHealth),
      edge("request-backup", "request", "backup", clamp(values.backupControl / 100), backupHealth),
      edge("derived-verify", "derived", "verify", clamp(values.discovery / 100), verifyHealth),
    ],
    metrics: [
      metric("residual-copies", "Residual identifiable copies after erasure", values.residual, "%", 5, 20, "percent"),
      metric("undiscovered", "Stores that cannot find the subject", values.undiscovered, "%", 10, 30, "percent"),
      metric("backup-gap", "Backups without an erasure policy", values.backupGap, "%", 10, 40, "percent"),
      metric("completeness", "Erasure completeness", values.completeness, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Erasure is ${values.completeness.toFixed(0)}% complete; ${values.residual.toFixed(0)}% of identifiable copies remain; ${values.undiscovered.toFixed(0)}% of stores cannot find the subject and ${values.backupGap.toFixed(0)}% of backups lack an erasure policy.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "residual-copies",
    metricId: "residual-copies",
    warn: 5,
    crit: 20,
    title: "Identifiable copies remain after the erasure request",
    cause:
      "The request is a fan-out across primary data, derived stores, logs, and backups. A successful delete in the primary database leaves the search index, warehouse, event stream, and backup copies untouched. The residual adds the stores discovery never reached to the discovered share still exposed by the weakest path, so both gaps count at once.",
    fix:
      "Delete or overwrite in every primary and derived store, anonymize or redact append-only data, and apply the backup policy. Verify each store with the subject key, and keep the per-system result as evidence. Do not close the request on the primary row count.",
    checkFirst: [
      "Which stores still return the subject key after the job completes?",
      "Was the store discovered, and does it have a deletion primitive?",
      "Is the remaining copy in a log, a derived store, or a backup?",
    ],
  },
  {
    id: "undiscovered",
    metricId: "undiscovered",
    warn: 10,
    crit: 30,
    title: "A store cannot find the subject at all",
    cause:
      "Discovery depends on a stable key and a complete inventory. A new cache, a team-owned warehouse, a vendor export, or a store with no subject index is invisible to the request. The system does not fail; it simply never receives the request.",
    fix:
      "Register every store with an owner and a subject key, and make registration part of the platform path. Run a synthetic subject through discovery on a schedule, and treat an unreachable store as an open finding rather than an accepted gap.",
    checkFirst: [
      "Which stores are missing from the erasure inventory?",
      "Can each store resolve the same person across different identifiers?",
      "Did a new store ship after the last inventory review?",
    ],
  },
  {
    id: "backup-gap",
    metricId: "backup-gap",
    warn: 10,
    crit: 40,
    title: "Backups have no tested erasure path",
    cause:
      "Backups are retained copies by design. If the policy has no suppression, key destruction, or expiry path, a restore can bring an erased record back into production. An untested assumption that backups will age out is not a control.",
    fix:
      "Document how backups are handled, implement suppression on restore or crypto-shredding where appropriate, and test a restore with a synthetic erased subject. Keep the evidence with the request and revisit the policy when the retention window changes.",
    checkFirst: [
      "What happens to an erased subject when a backup is restored?",
      "Is there a suppression list, key-destruction path, or expiry guarantee?",
      "Has the restore test been run against the current backup format?",
    ],
  },
];

export const erasureModel: SimModel = {
  id: "compliance-right-to-erasure",
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
    if (values.residual >= 20 && frame.flags.residualEvent !== 1) {
      pushEvent(next, {
        id: "erasure-residual",
        at: frame.t,
        severity: "crit",
        title: "Identifiable copies remain after the erasure request",
        detail: `Erasure is ${values.completeness.toFixed(0)}% complete. ${values.residual.toFixed(0)}% of identifiable copies remain, ${values.undiscovered.toFixed(0)}% of stores cannot find the subject, and ${values.backupGap.toFixed(0)}% of backups lack an erasure policy.`,
        nodeId: "request",
        metricId: "residual-copies",
      });
      next.flags.residualEvent = 1;
    }
    if (values.residual < 20) next.flags.residualEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Erasure is ${values.completeness.toFixed(0)}% complete; ${values.residual.toFixed(0)}% of identifiable copies remain; ${values.undiscovered.toFixed(0)}% of stores cannot find the subject and ${values.backupGap.toFixed(0)}% of backups lack an erasure policy.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `Erasure is ${values.completeness.toFixed(0)}% complete, with ${values.residual.toFixed(0)}% of identifiable copies still reachable. The residual adds the undiscovered stores to the discovered share exposed by the weakest of deletion, anonymization, and backup control.`,
      `Primary and derived deletion covers ${values.deletion.toFixed(0)}%, and log anonymization covers ${values.anonymization.toFixed(0)}%. Append-only data usually needs a different technique from a row delete.`,
      `${values.backupGap.toFixed(0)}% of backups have no erasure policy. A backup is a retained copy; the question is what happens on restore, not whether the backup exists.`,
      `${values.undiscovered.toFixed(0)}% of stores cannot find the subject. That is the most dangerous gap because it produces no error at request time.`,
      "The percentages and thresholds are illustrative teaching values, not statutory deadlines or a legal determination. The right to erasure is not absolute, and exceptions depend on the facts.",
    ];
  },
  legend: [
    { label: "Erased", tone: "ok" },
    { label: "Policy review", tone: "warn" },
    { label: "Residual data", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every store is discoverable, primary and derived deletion is complete, logs are anonymized, and backups have a tested erasure policy.",
    tone: "ok",
    params: defaults({ discoveryCoverage: 100, deletionCoverage: 100, anonymizationCoverage: 100, backupControlCoverage: 100 }),
  },
  {
    id: "peak",
    label: "Partial coverage",
    description: "Most stores are covered, but some derived data and logs still hold identifiers and one backup class has no policy.",
    tone: "warn",
    params: defaults({ discoveryCoverage: 95, deletionCoverage: 90, anonymizationCoverage: 85, backupControlCoverage: 85 }),
  },
  {
    id: "failure",
    label: "Primary only",
    description: "The primary database deletes the row, but discovery, derived data, logs, and backups leave most copies behind.",
    tone: "crit",
    params: defaults({ discoveryCoverage: 70, deletionCoverage: 50, anonymizationCoverage: 20, backupControlCoverage: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Discovery reaches every store, deletion and anonymization run, and the backup policy is implemented and tested.",
    tone: "ok",
    params: defaults({ discoveryCoverage: 100, deletionCoverage: 100, anonymizationCoverage: 100, backupControlCoverage: 100 }),
  },
  {
    id: "expiry-only",
    label: "Backup expiry only",
    description: "Primary data, derived data, and logs are handled, but backups rely on an untested expiry assumption rather than an erasure policy.",
    tone: "warn",
    params: defaults({ discoveryCoverage: 100, deletionCoverage: 100, anonymizationCoverage: 100, backupControlCoverage: 85 }),
  },
];

const experiment: Experiment = {
  id: "predict-primary-delete",
  title: "Predict whether the primary delete finished the request",
  simId: "erasure",
  question:
    "An erasure request deletes the customer row from the primary database and the job reports success. The service has a search index, an event stream, and nightly backups. Is the request complete?",
  prediction: {
    options: [
      { id: "complete", label: "Yes. The primary record is gone and the job succeeded" },
      { id: "no-copies", label: "No. Derived data, logs, and backups still hold identifiable copies" },
      { id: "yes-anon", label: "Yes, because the logs will expire on their retention schedule" },
      { id: "backup-exempt", label: "Yes, because backups are never part of erasure" },
    ],
    correctOptionId: "no-copies",
    explanation:
      "The primary row is one copy. The search index, event stream, and backups also contain the identifiers, and none of them received the delete. Retention expiry is a future event, not evidence that the request is complete now. The request needs a per-store operation and a per-store result.",
  },
  setup: defaults({ discoveryCoverage: 100, deletionCoverage: 100, anonymizationCoverage: 20, backupControlCoverage: 10 }),
  runFor: 20,
  observe: [
    "Erasure completeness is 10% because backup control and log anonymization leave most copies behind.",
    "The primary node stays healthy while the derived, logs, and backup nodes fail.",
    "Residual copies are 90% even though the database job reported success.",
    "The completion check finds every store, so the problem is execution and backup policy, not discovery.",
  ],
  explain:
    "Erasure is a set of per-store operations, not one delete. A search index can be updated or rebuilt; an event stream may need field removal or irreversible anonymization; a backup may need suppression on restore, crypto-shredding, or expiry inside the committed window. The team has to choose the technique that fits each store, prove it, and record the result. A backup that still contains the record is a residual copy even if the primary database is clean.",
  fix: defaults({ discoveryCoverage: 100, deletionCoverage: 100, anonymizationCoverage: 100, backupControlCoverage: 100 }),
  debrief:
    "With derived data and logs handled and the backup policy implemented, the same request is complete. The primary delete did not change; the rest of the path caught up. This module is engineering education, not legal advice. The right to erasure has exceptions and depends on the facts, the jurisdiction, and the controller's obligations, so document the decision and involve counsel where it matters.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The right to erasure, often called the right to be forgotten, lets a person ask for their personal data to be erased in defined circumstances. It is not an absolute right: the law provides exceptions, and other obligations can require retention. For engineers, the useful framing is narrower. When erasure applies, the team must be able to find every copy, remove or irreversibly anonymize the identifiers, and explain what happens to copies that cannot be rewritten immediately.",
  },
  {
    type: "p",
    text: "Deletion, anonymization, and suppression are different tools. Deletion removes the record. Anonymization removes the ability to link the data back to a person, and it must be irreversible; redaction that can be reversed or re-joined is not anonymization. Suppression keeps a minimal marker so the record is not recreated or restored into service, without retaining the original data. A mature erasure path uses all three where each fits.",
  },
  {
    type: "p",
    text: "Backups are the hard case. An immutable backup may not support a row delete, and rewriting every backup for every request can be impractical. The engineering answer is a documented policy: suppress the subject on restore, destroy the key that makes the backup readable, or let the backup expire inside a committed window. The policy is only credible if a restore test shows the erased record does not come back.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Erasure sits at the end of the data lifecycle and touches every store that ever received a copy. The request workflow fans out to the primary database, derived stores such as search and analytics, append-only logs and event streams, and backups. Each system needs a stable subject key, an operation it can perform, and a way to report the result. The verification step then queries every registered store rather than trusting the primary job.",
  },
  {
    type: "table",
    headers: ["Store type", "Usual technique", "Evidence to keep"],
    rows: [
      ["Primary database", "Delete or overwrite the row", "Row count and per-subject result"],
      ["Search index", "Delete the document or rebuild the index", "Index query for the subject key"],
      ["Warehouse or feature store", "Delete partitions or rewrite affected rows", "Job output and post-delete query"],
      ["Logs and event streams", "Irreversible anonymization or field removal", "Schema and sample after redaction"],
      ["Backups", "Suppression, crypto-shredding, or bounded expiry", "Restore test and policy reference"],
    ],
  },
  {
    type: "p",
    text: "The model computes a residual share additively: the stores discovery never reached plus the discovered share still exposed by the weakest of deletion, anonymization, and backup control. That structure matters: a team that deletes perfectly from the primary database but has no log or backup path still has residual data, and it may never see an error. The failure is invisible unless the request is measured per store.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Residual identifiable copies: the share of copies still reachable after the request.",
      "Stores that cannot find the subject: the discovery gap that produces no runtime error.",
      "Backups without an erasure policy: the retained copies that can return on restore.",
      "Erasure completeness: the complement of residual data, used as the node summary.",
      "Node states: the request, primary store, derived stores, logs, backups, and completion check show which path failed.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Partial coverage and watch residual copies rise before the primary store looks bad. Apply Primary only and compare the healthy primary node with the failing derived, log, and backup nodes. Run the experiment before revealing the explanation, then apply Backup expiry only and Recovery.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The right to erasure is not absolute, and whether it applies, which exceptions exist, and how long data may be retained depend on the law and the facts. Use this model to design deletion and backup handling, then involve your privacy officer and counsel for a legal decision.",
  },
  { type: "sim", simId: "erasure" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The primary database reported success while the request stayed incomplete. The search index and event stream still held identifiers, and the backups had no tested policy, so residual copies remained high. The primary node was healthy because deletion coverage was complete; the failure lived in the stores that the primary job never owned.",
  },
  {
    type: "p",
    text: "Handling derived data and logs and implementing a backup policy cleared the residual threshold without changing the primary delete. The completion check passed because discovery already reached every store. The lesson is that erasure is a per-store operation with per-store evidence, not a database feature.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A deletion fan-out with one result per store, including derived and append-only systems.",
      "Subject-key lookups after the job, not only a count of deleted rows.",
      "A backup policy that names suppression, key destruction, or expiry, plus a restore test.",
      "Log and event schemas that allow identifiers to be removed without breaking the pipeline.",
      "A suppression or tombstone record that prevents a deleted profile from being recreated by a later sync.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List every store that received the subject's data, including derived and vendor copies.",
      "Check whether each store can find the subject and which operation it supports.",
      "Run the request and query each store for the subject key afterward.",
      "Check logs and event streams for identifiers that redaction or expiry has not removed.",
      "Check the backup policy and run a restore test with a synthetic erased subject.",
      "Confirm the suppression path so a later import does not recreate the record.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop closing the request when the primary database reports success.",
      "Register every store with a subject key, an owner, and a deletion or anonymization primitive.",
      "Fan out the request and collect a result from each store.",
      "Anonymize or redact append-only data where deletion is not practical.",
      "Implement the backup handling path and test a restore.",
      "Add suppression so a sync or import cannot resurrect the record.",
      "Verify with a post-request query and keep the evidence with the request.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Immediate deletion is easy to explain and can break referential integrity; tombstones and suppression preserve consistency but retain a marker.",
      "Rewriting backups gives strong assurance and is expensive; suppression or crypto-shredding is cheaper and depends on a tested restore process.",
      "Aggressive log redaction reduces residual data and can remove debugging context; structured events with a subject token can preserve operability.",
      "Deleting from derived stores keeps them consistent and may require a full rebuild; a periodic rebuild is simpler but leaves a window.",
      "A central deletion service improves evidence and adds a dependency and a new failure domain.",
      "Retaining a minimal suppression record is useful for preventing recreation and is itself personal data that needs a policy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "not-one-delete",
    question: "Why is an erasure request more than a delete statement?",
    difficulty: 2,
    hints: [
      "Count the copies, not the tables.",
      "Different stores need different operations.",
    ],
    answer:
      "The person's data is spread across the primary database, derived stores, logs, event streams, backups, and possibly vendors. Each copy may use a different key and support a different operation: delete, overwrite, re-index, anonymize, or suppress. A delete statement in the primary database only changes one copy. I would build a per-store fan-out, choose the technique that fits each store, and verify the subject key is gone or irreversibly anonymized everywhere. The request is complete when the evidence says so, not when one job exits zero.",
    followUps: [
      "Which store is usually missed first?",
      "What does completion mean for an append-only log?",
      "How do you handle a vendor that cannot delete on demand?",
    ],
    redFlags: [
      "Treats the primary database as the whole scope.",
      "Confuses redaction with anonymization.",
      "Accepts a job status as evidence.",
    ],
    rubric: [
      "Enumerates copies.",
      "Chooses per-store techniques.",
      "Verifies with evidence.",
      "Handles vendors and append-only data.",
    ],
  },
  {
    id: "backup-policy",
    question: "How do you handle backups when a customer asks for erasure?",
    difficulty: 3,
    hints: [
      "Immediate rewriting may not be possible.",
      "The restore path is the real test.",
    ],
    answer:
      "I would start with the retention and restore design, not with a promise to rewrite every backup. The policy can use suppression on restore, crypto-shredding where the backup is encrypted with a per-subject or per-tenant key, or expiry inside a committed window. I would document which path applies, implement it, and test a restore with a synthetic erased subject to prove the record does not return to service. I would also make sure a later import or sync cannot recreate the profile from another source.",
    followUps: [
      "When is crypto-shredding a good fit?",
      "How do you prove suppression survived a restore?",
      "What if the backup vendor controls the retention?",
    ],
    redFlags: [
      "Claims backups will simply expire.",
      "Promises immediate rewriting of immutable backups.",
      "Has no restore test.",
    ],
    rubric: [
      "Names a concrete backup policy.",
      "Considers key destruction and suppression.",
      "Tests restore.",
      "Addresses recreation.",
    ],
  },
  {
    id: "residual-proof",
    question: "How do you prove that an erasure request left no identifiable copies?",
    difficulty: 3,
    hints: [
      "Use the subject key, not a row count.",
      "A sample is weaker than a query across every registered store.",
    ],
    answer:
      "I would query every registered store with the subject key after the fan-out, including derived stores, logs, and the backup suppression path. For each store I would record the operation, the time, the actor, and the result. For append-only data I would check that the identifiers are irreversibly removed, not just masked. For backups I would rely on the tested restore path and the policy reference. I would also run a synthetic subject on a schedule so the proof is repeatable, and treat any store that cannot answer as an open gap.",
    followUps: [
      "How do you handle probabilistic matching across identifiers?",
      "What evidence would you give an auditor?",
      "How often would you re-run the synthetic test?",
    ],
    redFlags: [
      "Relies on a deleted-row count.",
      "Samples one store and generalizes.",
      "Cannot show the backup path.",
    ],
    rubric: [
      "Queries every store.",
      "Records per-store evidence.",
      "Checks irreversibility.",
      "Makes the test repeatable.",
    ],
  },
];

const checklist = [
  {
    title: "Before the request",
    items: [
      "Inventory every store and vendor that received the data, including derived copies.",
      "Confirm a stable subject key and a deletion or anonymization primitive per store.",
      "Document the backup handling path and the restore behavior.",
      "Define what suppression or tombstone remains after erasure.",
    ],
  },
  {
    title: "During the request",
    items: [
      "Fan out to every registered store and record a per-store result.",
      "Anonymize or redact append-only data where deletion is not practical.",
      "Apply the backup policy and note the path used.",
      "Do not close the request on the primary database's success.",
    ],
  },
  {
    title: "After the request",
    items: [
      "Query every store for the subject key and review the results.",
      "Run a restore test with a synthetic erased subject.",
      "Check that imports and syncs cannot recreate the record.",
      "Keep the evidence and revisit the policy when retention changes.",
    ],
  },
];

const references = [
  {
    title: "Regulation (EU) 2016/679, Article 17 (Right to erasure)",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    publisher: "Official Journal of the European Union",
    kind: "standard" as const,
    note: "The official text of the right to erasure and its exceptions.",
  },
  {
    title: "Guidelines for Media Sanitization (NIST SP 800-88 Rev. 1)",
    url: "https://csrc.nist.gov/pubs/sp/800/88/r1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Practical guidance on sanitization and verification, useful for designing irreversible deletion.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    erasure: {
      model: erasureModel,
      presets,
      instructions:
        "Start Healthy, then apply Partial coverage and watch residual copies rise. Apply Primary only and compare the healthy primary node with derived, log, and backup nodes. Run the experiment before revealing the explanation, then apply Backup expiry only and Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 5/20, 10/30, and 10/40 thresholds are teaching values, not statutory deadlines or a legal determination.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-gdpr", "compliance-retention", "case-composite-erasure-backups"],
};
