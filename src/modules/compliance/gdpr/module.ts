import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "discoveryCoverage",
    label: "Systems that can find the subject",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Data map",
    help: "Share of systems that can locate records for one person, including the primary database, caches, search indexes, logs, analytics copies, and backups. A system that cannot find the subject cannot export or delete the record.",
    format: "percent" as const,
  },
  {
    id: "deletionCoverage",
    label: "Deletion or anonymization coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rights operations",
    help: "Share of discovered stores where the request removes the identifiers or irreversibly anonymizes them. Deleting one row in the primary database does not touch a cache entry, a search document, or an append-only log.",
    format: "percent" as const,
  },
  {
    id: "exportCoverage",
    label: "Portable export coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rights operations",
    help: "Share of located data that can be exported in a structured, commonly used, machine-readable form. Access and portability need the same discovery path as deletion.",
    format: "percent" as const,
  },
  {
    id: "lawfulBasisCoverage",
    label: "Processing with a documented basis",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Accountability",
    help: "Share of processing activities that record a lawful basis, a purpose, and a retention decision. Engineering can enforce this as metadata rather than relying on a document nobody reads during a launch review.",
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
  exportCoverage: number;
  lawfulBasis: number;
  rightsCoverage: number;
  rightsGap: number;
  residual: number;
  lawfulGap: number;
  discoveryGap: number;
  deletionGap: number;
}

function compute(p: Params): Computed {
  const discovery = clamp(num(p, "discoveryCoverage", 100), 0, 100);
  const deletion = clamp(num(p, "deletionCoverage", 100), 0, 100);
  const exportCoverage = clamp(num(p, "exportCoverage", 100), 0, 100);
  const lawfulBasis = clamp(num(p, "lawfulBasisCoverage", 100), 0, 100);
  const discoveryShare = discovery / 100;
  const rightsCoverage = Math.min(discoveryShare * deletion, discoveryShare * exportCoverage);
  const deletionEndToEnd = discoveryShare * deletion;
  return {
    discovery,
    deletion,
    exportCoverage,
    lawfulBasis,
    rightsCoverage,
    rightsGap: 100 - rightsCoverage,
    residual: 100 - deletionEndToEnd,
    lawfulGap: 100 - lawfulBasis,
    discoveryGap: 100 - discovery,
    deletionGap: 100 - deletion,
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
  const requestHealth = healthFor(values.rightsGap, 10, 40);
  const storeHealth = healthFor(values.deletionGap, 10, 40);
  const cacheHealth = healthFor(values.discoveryGap, 5, 20);
  const backupHealth = healthFor(Math.max(values.discoveryGap, values.deletionGap), 10, 40);
  return {
    t: 0,
    nodes: [
      {
        id: "request",
        label: "Rights request",
        kind: "service",
        health: requestHealth,
        utilization: values.rightsGap / 100,
        sublabel: `${values.rightsCoverage.toFixed(0)}% of the path can answer`,
        detail: "The workflow that receives an access, portability, correction, or erasure request and fans it out to every system that holds the person's data.",
      },
      {
        id: "profile",
        label: "Primary profile store",
        kind: "db",
        health: storeHealth,
        utilization: values.deletionGap / 100,
        sublabel: `${values.deletion.toFixed(0)}% deletion or anonymization`,
        detail: "The system of record. It usually answers first, which is why a successful primary deletion is mistaken for a complete request.",
      },
      {
        id: "cache",
        label: "Cache and session store",
        kind: "cache",
        meta: { view: "flow" },
        health: cacheHealth,
        utilization: values.discoveryGap / 100,
        sublabel: `${values.discovery.toFixed(0)}% discoverable`,
        detail: "A cache holds copies with a different key and a different lifetime. If the data map omits it, the request reports success while the cached record keeps serving.",
      },
      {
        id: "search",
        label: "Search and analytics copies",
        kind: "storage",
        health: storeHealth,
        utilization: values.deletionGap / 100,
        sublabel: `${values.deletion.toFixed(0)}% derived data covered`,
        detail: "Indexes, warehouses, and feature stores are derived copies. They need a subject key so a request can find and update them.",
      },
      {
        id: "logs",
        label: "Logs and event streams",
        kind: "storage",
        health: storeHealth,
        utilization: values.deletionGap / 100,
        sublabel: `${values.deletion.toFixed(0)}% deletion or anonymization`,
        detail: "Application logs and event streams often contain identifiers. Append-only storage needs a deletion, redaction, or anonymization path, not only a retention timer.",
      },
      {
        id: "backup",
        label: "Backups and exports",
        kind: "storage",
        health: backupHealth,
        utilization: Math.max(values.discoveryGap, values.deletionGap) / 100,
        sublabel: `${values.discovery.toFixed(0)}% discoverable · policy required`,
        detail: "Backups are copies of personal data. Immediate rewriting may be impractical, so the policy needs a documented handling path and a restore test that does not resurrect the record.",
      },
    ],
    edges: [
      edge("request-profile", "request", "profile", clamp(values.deletion / 100), storeHealth),
      edge("request-cache", "request", "cache", clamp(values.discovery / 100), cacheHealth),
      edge("request-search", "request", "search", clamp(values.deletion / 100), storeHealth),
      edge("request-logs", "request", "logs", clamp(values.deletion / 100), storeHealth),
      edge("request-backup", "request", "backup", clamp(values.discovery / 100), backupHealth),
    ],
    metrics: [
      metric("rights-gap", "Request coverage gap (end-to-end)", values.rightsGap, "%", 10, 40, "percent"),
      metric("residual-copies", "Identifiable copies after the request", values.residual, "%", 5, 25, "percent"),
      metric("lawful-gap", "Processing without a documented basis", values.lawfulGap, "%", 10, 40, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Request coverage is ${values.rightsCoverage.toFixed(0)}%, residual identifiable copies are ${values.residual.toFixed(0)}%, and ${values.lawfulGap.toFixed(0)}% of processing lacks a documented basis.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rights-gap",
    metricId: "rights-gap",
    warn: 10,
    crit: 40,
    title: "A subject request cannot complete across every system",
    cause:
      "End-to-end coverage is discovery multiplied by the weaker of deletion and export. If discovery misses 20% of stores, no deletion in the remaining stores can exceed 80% end-to-end. If deletion reaches only 60% of the stores that were found, the same request still leaves copies behind. A primary database success count measures one layer, not the chain.",
    fix:
      "Build one subject index that maps a person to every store, then implement discover, export, correct, and delete against that map. Include caches, search indexes, logs, analytics copies, and backups. Measure coverage per operation and per end-to-end path, not per ticket, and treat a new store as a regression until it is wired in.",
    checkFirst: [
      "Which layer limits end-to-end coverage: discovery or the weaker of deletion and export?",
      "Which systems are missing from the subject index, and who owns each one?",
      "Does the request report success per system or only for the primary database?",
    ],
  },
  {
    id: "residual-copies",
    metricId: "residual-copies",
    warn: 5,
    crit: 25,
    title: "Identifiable copies remain after the request",
    cause:
      "A delete statement removes a row from the primary store, but caches keep serving it, search indexes keep ranking it, append-only logs still contain it, and backups still hold it. Residual copies are additive: the stores discovery missed plus the discovered stores that were not deleted. Low discovery coverage therefore becomes residual data without an error.",
    fix:
      "Fan out invalidation and deletion to every derived store, use deterministic subject keys, and re-index or redact asynchronously where immediate deletion is impossible. Document the backup handling path, suppress the subject on restore, and prove the path with a synthetic record.",
    checkFirst: [
      "Which copies still contain the identifier: cache, search, logs, warehouse, or backup?",
      "Does the deletion response include evidence from each system, not just a count from the primary?",
      "Can a restored backup bring the record back into service?",
    ],
  },
  {
    id: "lawful-gap",
    metricId: "lawful-gap",
    warn: 10,
    crit: 40,
    title: "Processing has no documented lawful basis or purpose",
    cause:
      "A feature can ship with a data model and no recorded purpose, basis, or retention decision. The gap is not visible at runtime because the system still processes the data; it appears when someone asks why the data exists, how long it is kept, or whether a new use is compatible with the original purpose.",
    fix:
      "Record a basis, purpose, data categories, and retention period per processing activity, and require that metadata before a new dataset or integration is approved. Attach the decision to the service catalog so engineers can see it during design review rather than during an audit.",
    checkFirst: [
      "Which processing activities have no recorded purpose or basis?",
      "Is the basis a decision with an owner, or a sentence copied into a template?",
      "Does a new use of an existing dataset trigger a review?",
    ],
  },
];

export const gdprModel: SimModel = {
  id: "compliance-gdpr",
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
    if (values.rightsGap >= 40 && frame.flags.rightsEvent !== 1) {
      pushEvent(next, {
        id: "request-incomplete",
        at: frame.t,
        severity: "crit",
        title: "A subject request cannot complete across every system",
        detail: `Request coverage is ${values.rightsCoverage.toFixed(0)}% and ${values.residual.toFixed(0)}% of identifiable copies remain reachable. The primary store may have answered while caches, derived data, or backups did not.`,
        nodeId: "request",
        metricId: "rights-gap",
      });
      next.flags.rightsEvent = 1;
    }
    if (values.rightsGap < 40) next.flags.rightsEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `Request coverage is ${values.rightsCoverage.toFixed(0)}%, residual identifiable copies are ${values.residual.toFixed(0)}%, and ${values.lawfulGap.toFixed(0)}% of processing lacks a documented basis.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const weakerOperation = values.deletion <= values.exportCoverage ? "deletion or anonymization" : "portable export";
    return [
      `Request coverage is ${values.rightsCoverage.toFixed(0)}%: ${values.discovery.toFixed(0)}% discovery multiplied by the weaker operation, ${weakerOperation} at ${Math.min(values.deletion, values.exportCoverage).toFixed(0)}%. A rights workflow is end-to-end, not an average of completed tickets.`,
      `${values.residual.toFixed(0)}% of identifiable copies remain after the request. This adds the stores discovery missed to the discovered stores that were not deleted, so the two gaps compound rather than substitute for each other.`,
      `Deletion covers ${values.deletion.toFixed(0)}% of discovered stores and export covers ${values.exportCoverage.toFixed(0)}%. An access request and an erasure request share discovery but need different outputs; both must be measured.`,
      `${values.lawfulGap.toFixed(0)}% of processing lacks a documented basis. That is an accountability gap, not a runtime error: the service still processes data while nobody can state why or for how long.`,
      "The percentages are illustrative teaching values. GDPR obligations depend on the processing, the role of each party, and the facts; this model is engineering education, not legal advice.",
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
    description: "Every store is discoverable, deletion or anonymization reaches each copy, export works, and processing has a documented basis.",
    tone: "ok",
    params: defaults({ discoveryCoverage: 100, deletionCoverage: 100, exportCoverage: 100, lawfulBasisCoverage: 100 }),
  },
  {
    id: "peak",
    label: "Request surge",
    description: "Coverage is high but not complete: a few stores are missing from the subject index and deletion lags behind discovery.",
    tone: "warn",
    params: defaults({ discoveryCoverage: 90, deletionCoverage: 85, exportCoverage: 90, lawfulBasisCoverage: 85 }),
  },
  {
    id: "failure",
    label: "Partial data map",
    description: "The subject index misses most stores, deletion reaches fewer, export is limited, and half of processing has no recorded basis.",
    tone: "crit",
    params: defaults({ discoveryCoverage: 40, deletionCoverage: 30, exportCoverage: 50, lawfulBasisCoverage: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The subject index covers every store, deletion and export run against it, and the processing inventory records a basis.",
    tone: "ok",
    params: defaults({ discoveryCoverage: 100, deletionCoverage: 100, exportCoverage: 100, lawfulBasisCoverage: 100 }),
  },
  {
    id: "new-cache",
    label: "New cache added",
    description: "A cache shipped after the data map was built. The primary path still looks complete while the new copy is not discoverable.",
    tone: "warn",
    params: defaults({ discoveryCoverage: 85, deletionCoverage: 90, exportCoverage: 100, lawfulBasisCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-cache-gap",
  title: "Predict whether the database answer is the whole answer",
  simId: "gdpr",
  question:
    "A deletion request completes in the primary database and the job reports success. The service also uses a cache, a search index, and nightly backups. Is the request complete?",
  prediction: {
    options: [
      { id: "complete", label: "Yes. The system of record deleted the row" },
      { id: "no-cache", label: "No. The cache and other copies were not discovered, so identifiable data remains" },
      { id: "export-only", label: "Yes, as long as the export path works" },
      { id: "retention", label: "No, but only because the retention period is too long" },
    ],
    correctOptionId: "no-cache",
    explanation:
      "A successful primary delete proves one store changed. Discovery covers only part of the path, so the cache, derived copies, and backups were never in scope. The request is complete only when every system that can find the subject has been asked and each one has produced evidence of deletion, anonymization, or a documented backup policy.",
  },
  setup: defaults({ discoveryCoverage: 70, deletionCoverage: 60, exportCoverage: 90, lawfulBasisCoverage: 80 }),
  runFor: 20,
  observe: [
    "Request coverage is 42%: 70% discovery multiplied by 60% deletion coverage.",
    "Residual identifiable copies are 58%: 30% of stores are undiscovered, and 40% of the 70% that can be found are not deleted.",
    "The primary store fails at 60% deletion coverage, and the cache and backup fail because they are not discoverable.",
    "The lawful-basis gap stays separate from the request failure; fixing rights operations does not create a recorded basis.",
  ],
  explain:
    "Rights requests are fan-out problems. The orchestrator needs a subject index that reaches every store, and each store needs an operation it can actually perform: delete, overwrite, redact, invalidate, or anonymize. Backups may not support immediate rewriting, so the documented policy has to say what happens, how a restore avoids resurfacing the record, and how the team proves it. A database row count is not evidence for the cache or the backup.",
  fix: defaults({ discoveryCoverage: 100, deletionCoverage: 100, exportCoverage: 100, lawfulBasisCoverage: 100 }),
  debrief:
    "With full discovery and deletion the residual copies fall to zero, and the same request now has evidence from each system. The lesson is not to delete harder in the primary database. It is to make the subject index and the per-store operations part of the data platform, so a new cache cannot silently reopen the gap. This module is engineering education, not legal advice; a real rights program depends on the processing, the applicable law, and the facts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The General Data Protection Regulation (GDPR) is the European Union regulation that governs the processing of personal data. For engineers, it is a set of operational duties: know where personal data is, know why it is processed, limit what is collected, protect it, retain it only as long as needed, and be able to find, export, correct, restrict, or delete it when a person asks. The regulation also distinguishes the controller, which decides the purposes and means of processing, from the processor, which acts on the controller's instructions.",
  },
  {
    type: "p",
    text: "The rights are the part most visible to a product team: access, rectification, erasure, restriction, portability, and objection. They look like separate workflows, but they share one dependency: discovery. A system that cannot locate a person's records cannot export them, correct them, or delete them. That is why a data map is not architecture documentation. It is the index the rights workflow runs against.",
  },
  {
    type: "p",
    text: "A second duty is accountability. Each processing activity needs a purpose, a lawful basis, a retention decision, and an owner. The basis is not always consent; the regulation provides several. Engineering's job is to make the decision visible and enforceable, for example by requiring dataset metadata at creation and blocking a new use that has no recorded purpose. A policy that exists only in a document does not constrain a new pipeline.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The rights path crosses every system that holds a copy: the primary database, caches and session stores, search indexes, analytics warehouses, application logs, event streams, backups, and vendor exports. Each copy may use a different key, a different lifetime, and a different deletion primitive. A request orchestrator fans out to all of them and collects evidence. The primary database is usually the easiest system to fix and the least likely to be the only one that matters.",
  },
  {
    type: "compare",
    leftTitle: "Access or portability request",
    rightTitle: "Erasure or restriction request",
    rows: [
      { label: "Discovery", left: "Find every record and its source system", right: "Find every record and every derived copy" },
      { label: "Operation", left: "Read and produce a structured export", right: "Delete, overwrite, redact, invalidate, or anonymize" },
      { label: "Hard part", left: "Assembling a coherent record across stores", right: "Reaching caches, logs, indexes, and backups" },
      { label: "Evidence", left: "Export manifest with systems and fields", right: "Per-store completion or documented policy" },
    ],
  },
  {
    type: "p",
    text: "The model multiplies discovery by the weaker of deletion and export to get end-to-end request coverage. Residual copies are additive: the stores discovery never found plus the discovered stores that deletion did not reach. That is why a strong export path cannot compensate for a store that deletion misses, and why a successful primary delete does not appear in the residual count as completion.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Request coverage gap: end-to-end coverage after multiplying discovery by the weaker of deletion or anonymization and portable export.",
      "Residual identifiable copies: the share of copies still reachable after the request, including systems the subject index missed.",
      "Processing without a documented basis: the accountability gap, measured separately from the rights workflow.",
      "Node states: the request orchestrator, primary store, cache, search copies, logs, and backups show which path broke.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Request surge and watch the floor fall to its weakest operation. Apply Partial data map and compare the primary store with the cache and backup nodes. Run the experiment before revealing the explanation, then apply New cache added to see how a single new store reopens a gap, and Recovery to close it.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. Whether a particular processing activity is lawful, which rights apply, and which exceptions exist depend on the facts, the jurisdiction, and the role of each party. Use the model to design better discovery and deletion paths, then involve your privacy officer and counsel for a legal decision.",
  },
  { type: "sim", simId: "gdpr" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The request failed across two layers. The subject index covered only part of the data map, and deletion reached only 60% of the stores it could find. The primary store failed at that deletion coverage, while the cache and backup failed because they were never discovered. Residual copies stayed high even though the database job reported success, which is the central trap in rights engineering.",
  },
  {
    type: "p",
    text: "Restoring discovery and deletion coverage cleared the request and residual thresholds. The lawful-basis metric did not move, because it measures a different duty. That separation matters: a team can run a perfect deletion workflow and still be unable to explain why a dataset exists or how long it is kept.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A subject index with an entry for every store, including caches, search, logs, analytics, and backups.",
      "Per-system completion records, not one aggregate success count from the primary database.",
      "Cache invalidation and search re-index jobs that run as part of the request, with retries and dead-letter handling.",
      "A backup handling policy that covers restore, suppression, and expiry, tested with a synthetic subject.",
      "Dataset metadata that records purpose, basis, retention, and owner before a new pipeline is approved.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List every store that can hold personal data, including copies built by other teams.",
      "Check whether the subject index can locate a person in each store by a stable key.",
      "Compare discovery, deletion, and export coverage, and find the weakest operation.",
      "Test one request end to end with a synthetic subject and collect evidence from every system.",
      "Check the backup restore path to see whether a deleted record can return.",
      "Confirm that new datasets require purpose, basis, retention, and an owner.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop treating the primary database as the scope of the request.",
      "Build a subject index that maps a person to every store and gives each store an owner.",
      "Implement discover, export, correct, and delete operations against that index.",
      "Add cache invalidation, search re-indexing, and log redaction or anonymization.",
      "Write and test a backup policy that prevents a restore from resurrecting the record.",
      "Measure coverage per operation and alert when a new store is added without an entry.",
      "Record purpose, basis, retention, and owner for each processing activity.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A complete subject index improves every rights workflow and adds a dependency that must be updated on every new store.",
      "Synchronous deletion gives immediate evidence and can slow a request or fail when a store is unavailable; asynchronous fan-out needs retries and completion tracking.",
      "Deleting from append-only logs preserves audit value when redaction is precise, but the redaction path is more complex than expiry.",
      "Immediate backup rewriting is usually impractical; suppression, crypto-shredding, or expiry is cheaper but needs a restore test to be credible.",
      "Collecting less data reduces rights work and can remove useful product analytics; minimization is a product decision with an engineering cost.",
      "A strict lawful-basis gate slows launches and prevents orphaned datasets; a lightweight review is faster until the first audit or complaint.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "rights-discovery",
    question: "What does a data-subject access request require from engineering?",
    difficulty: 2,
    hints: [
      "Start with discovery, not with the export format.",
      "An access request and an erasure request share the same index.",
    ],
    answer:
      "It requires a reliable way to find every record tied to one person across the primary store, caches, search indexes, analytics copies, logs, and backups, then assemble those records into a structured export with source and field metadata. The hard part is discovery and identity resolution, not generating a file. I would build one subject index, make each store expose a discover and export operation, and record per-system evidence so a partial result is visible. I would also check that the export does not include another person's data through a shared account or a weak join.",
    followUps: [
      "How do you resolve identities across systems with different keys?",
      "What do you do when a store cannot export in a structured format?",
      "How do you prove the export is complete?",
    ],
    redFlags: [
      "Scopes the request to the primary database.",
      "Treats a CSV dump as a complete answer.",
      "Ignores shared accounts and identity collisions.",
    ],
    rubric: [
      "Starts from discovery.",
      "Covers copies and derived data.",
      "Produces structured, attributable output.",
      "Checks identity and completeness.",
    ],
  },
  {
    id: "delete-success",
    question: "A deletion job reports success on the primary database. Why might the request still be incomplete?",
    difficulty: 3,
    hints: [
      "Success is scoped to the system that reported it.",
      "Caches, indexes, logs, and backups hold copies with different lifetimes.",
    ],
    answer:
      "The success only proves that one store changed. Other stores may not have been discovered, may use a different key, or may not support deletion at all. A cache can keep serving the record, a search index can keep ranking it, an append-only log can retain it, and a backup can restore it later. I would check the subject index, the per-store completion records, and the restore path. I would also verify that the deletion is idempotent and that a retry does not fail silently on an unavailable store.",
    followUps: [
      "How would you detect a cache that still holds the record?",
      "What does completion mean for an append-only log?",
      "How do you test the backup restore path without exposing data?",
    ],
    redFlags: [
      "Accepts the primary job's success count.",
      "Assumes caches expire quickly enough.",
      "Has no plan for backups.",
    ],
    rubric: [
      "Scopes success per system.",
      "Names caches, indexes, logs, and backups.",
      "Verifies with evidence.",
      "Tests restore and retry behavior.",
    ],
  },
  {
    id: "new-store-regression",
    question: "How do you keep rights coverage from regressing when a team adds a new cache or analytics store?",
    difficulty: 3,
    hints: [
      "Make registration part of the platform path, not a review reminder.",
      "Coverage should fail visibly when a store is missing.",
    ],
    answer:
      "I would make the subject index a platform dependency: a new store is not considered ready until it registers an owner, a subject key, and discover, export, and delete operations. I would also add a synthetic subject that exercises every registered store, alert on coverage below the target, and treat an unregistered store as a launch blocker. The data map needs an owner and a review cadence, because a registration that is never rechecked becomes stale. The goal is to make the safe path the default, not to rely on a quarterly spreadsheet review.",
    followUps: [
      "Where would you enforce registration: infrastructure template, CI, or runtime?",
      "How do you handle a vendor store you cannot modify?",
      "What would you measure to show the regression is fixed?",
    ],
    redFlags: [
      "Relies on a wiki page and a reminder.",
      "Waits for a request to discover the gap.",
      "Treats cache expiry as deletion.",
    ],
    rubric: [
      "Embeds registration in the platform.",
      "Defines per-store operations.",
      "Uses synthetic tests and alerts.",
      "Assigns ownership.",
    ],
  },
];

const checklist = [
  {
    title: "Before the request",
    items: [
      "Inventory every store that can hold personal data, including copies owned by other teams.",
      "Record a stable subject key and an owner for each store.",
      "Confirm that discovery, export, correction, and deletion operations exist.",
      "Check the backup policy and the restore path for deleted records.",
    ],
  },
  {
    title: "During the request",
    items: [
      "Fan out to every registered store and track completion per system.",
      "Check cache invalidation, search re-indexing, and log handling separately.",
      "Preserve evidence of what was found, changed, or intentionally retained.",
      "Escalate a store that cannot answer rather than reporting aggregate success.",
    ],
  },
  {
    title: "After the request",
    items: [
      "Run a synthetic subject through the same path and verify residual copies.",
      "Review coverage for each new store added since the last test.",
      "Update the data map, retention decision, and processing record.",
      "Document accepted exceptions and escalate legal questions.",
    ],
  },
];

const references = [
  {
    title: "Regulation (EU) 2016/679 (General Data Protection Regulation)",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    publisher: "Official Journal of the European Union",
    kind: "standard" as const,
    note: "The official text, including data-subject rights, controller and processor roles, and accountability.",
  },
  {
    title: "Guidelines 07/2020 on the concepts of controller and processor in the GDPR",
    url: "https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-072020-concepts-controller-and-processor-gdpr_en",
    publisher: "European Data Protection Board",
    kind: "docs" as const,
    note: "Guidance on the controller and processor roles that determine who must answer a request.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    gdpr: {
      model: gdprModel,
      presets,
      instructions:
        "Start Healthy, then apply Request surge and compare the request gap with residual copies. Apply Partial data map and find the systems the subject index misses. Run the experiment before revealing the explanation, then apply New cache added and Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 10/40 and 5/25 thresholds are teaching values, not legal deadlines or a compliance determination.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-data-classification", "compliance-right-to-erasure", "compliance-dpa"],
};
