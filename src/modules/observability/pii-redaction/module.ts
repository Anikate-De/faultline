import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const EVENTS_PER_DAY = 5_000_000;
const FIELDS_PER_10K = 0.6;

const params = [
  {
    id: "redactionCoverage",
    label: "Emit-time redaction coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rules",
    help: "Share of sensitive values matched by the rules applied inside the logger or SDK before the event leaves the process.",
    format: "percent" as const,
  },
  {
    id: "fieldClasses",
    label: "Sensitive field classes",
    min: 1,
    max: 10,
    step: 1,
    value: 3,
    unit: " classes",
    group: "Payload",
    help: "Kinds of sensitive value in the payload: email, phone, card number, access token, cookie, address, and similar.",
    format: "count" as const,
  },
  {
    id: "retentionDays",
    label: "Retention",
    min: 1,
    max: 365,
    step: 1,
    value: 30,
    unit: " days",
    group: "Copies",
    help: "Days the index keeps the event. Every retained copy extends the exposure window after the leak is found.",
    format: "count" as const,
  },
  {
    id: "auditCoverage",
    label: "Verification coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rules",
    help: "Share of emitted events scanned by a detector that looks for unredacted patterns. Zero means you learn from a user report.",
    format: "percent" as const,
  },
  {
    id: "legacyShare",
    label: "Legacy exposure share",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Copies",
    help: "Share of sensitive values emitted before the current rules that remain in retained copies. This is history, not current coverage.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  coverage: number;
  fieldClasses: number;
  retention: number;
  audit: number;
  legacy: number;
  unredacted: number;
  leaked: number;
  newRetained: number;
  existingStock: number;
  auditGap: number;
}

function compute(p: Params): Computed {
  const coverage = num(p, "redactionCoverage", 100);
  const fieldClasses = Math.round(num(p, "fieldClasses", 3));
  const retention = Math.round(num(p, "retentionDays", 30));
  const audit = num(p, "auditCoverage", 100);
  const legacy = num(p, "legacyShare", 0);
  const unredacted = 100 - coverage;
  const leaked = unredacted * fieldClasses * FIELDS_PER_10K;
  const newRetained = (leaked * (EVENTS_PER_DAY / 10_000)) / 1_000;
  const existingStock = (legacy * fieldClasses * FIELDS_PER_10K * (EVENTS_PER_DAY / 10_000) * retention) / 1_000;
  const auditGap = 100 - audit;
  return {
    coverage,
    fieldClasses,
    retention,
    audit,
    legacy,
    unredacted,
    leaked,
    newRetained,
    existingStock,
    auditGap,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const sourceHealth = healthFor(values.unredacted, 5, 20);
  const collectorHealth = healthFor(values.leaked, 5, 25);
  const storeHealth = healthFor(values.newRetained, 20, 50);
  const auditHealth = healthFor(values.auditGap, 10, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "Application task",
        kind: "service",
        health: "ok",
        utilization: values.unredacted / 100,
        sublabel: `serving · ${values.fieldClasses} sensitive field classes`,
      },
      {
        id: "redactor",
        label: "Emit-time redactor",
        kind: "worker",
        health: sourceHealth,
        utilization: values.unredacted / 100,
        sublabel: `${values.coverage.toFixed(0)}% matched`,
      },
      {
        id: "collector",
        label: "Collector",
        kind: "service",
        health: collectorHealth,
        utilization: clamp(values.leaked / 300),
        sublabel: `${values.leaked.toFixed(0)} leaked per 10k`,
      },
      {
        id: "store",
        label: "Retained store",
        kind: "storage",
        health: storeHealth,
        utilization: clamp(values.newRetained / 200),
        sublabel: `${values.existingStock.toFixed(0)}k existing copies`,
      },
      {
        id: "audit",
        label: "Leak detector",
        kind: "worker",
        health: auditHealth,
        utilization: values.auditGap / 100,
        sublabel: `${values.audit.toFixed(0)}% of events scanned`,
      },
    ],
    edges: [
      edge("app-redactor", "app", "redactor", clamp(values.coverage / 100), sourceHealth),
      edge("redactor-collector", "redactor", "collector", clamp(values.leaked / 300), collectorHealth),
      edge("collector-store", "collector", "store", clamp(values.newRetained / 200), storeHealth),
      edge("store-audit", "store", "audit", clamp(values.existingStock / 2_500), auditHealth),
    ],
    metrics: [
      metric("unredacted-fields", "Unredacted sensitive fields", values.unredacted, "%", 5, 20, "percent"),
      metric("leaked-fields", "Leaked fields", values.leaked, " /10k", 5, 25, "count"),
      metric("retained-fields", "New retained fields", values.newRetained, "k/day", 20, 50, "count"),
      metric("existing-copies", "Existing leaked copies", values.existingStock, "k", undefined, undefined, "count"),
      metric("audit-gap", "Unverified events", values.auditGap, "%", 10, 50, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.unredacted.toFixed(0)}% of sensitive fields are unredacted; ${values.leaked.toFixed(0)} leak per 10,000 events; ${values.newRetained.toFixed(0)}k new fields retained per day; ${values.existingStock.toFixed(0)}k copies already exist.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unredacted-fields",
    metricId: "unredacted-fields",
    warn: 5,
    crit: 20,
    title: "Sensitive fields are leaving the process unredacted",
    cause: "The emit-time rules do not cover every field class, or a new debug payload bypasses the logger's redaction path.",
    fix: "Switch from a denylist to an allowlist of fields, apply redaction before the event is serialized, and fail closed when a field is unknown.",
    checkFirst: [
      "Find the field name and the service that emits it.",
      "Check whether the value comes from a raw request body, headers, or a serialized object.",
      "Confirm the redactor runs before the transport, not inside the collector.",
    ],
  },
  {
    id: "leaked-fields",
    metricId: "leaked-fields",
    warn: 5,
    crit: 25,
    title: "Unredacted values reached the shared collector",
    cause: "Once an event leaves the process, every downstream copy inherits the value: index, archive, dead-letter queue, vendor, and any trace or error payload built from it.",
    fix: "Stop the emitter, add the missing rule, and treat the already-shipped events as exposed. A collector-side filter is a second layer, not the primary control.",
    checkFirst: [
      "Sample the collector input for the pattern that matched.",
      "List every sink that received the same stream.",
      "Check whether the value appears in trace attributes or error payloads as well as logs.",
    ],
  },
  {
    id: "retained-fields",
    metricId: "retained-fields",
    warn: 20,
    crit: 50,
    title: "New leaked fields are still being retained",
    cause: "The emitter is still shipping sensitive values. Every day adds another retained copy, and retention decides how long each copy survives.",
    fix: "Stop the emit path first, then shorten retention or purge the affected range where policy allows. Retention changes do not clean data that already exists.",
    checkFirst: [
      "Identify the index, archive, and vendor retention settings for the stream.",
      "Check whether a legal or audit requirement sets a floor on retention.",
      "Confirm deletion propagates to replicas and backups.",
    ],
  },
  {
    id: "audit-gap",
    metricId: "audit-gap",
    warn: 10,
    crit: 50,
    title: "Most telemetry is not verified for sensitive values",
    cause: "The leak detector samples too little traffic or watches only one field class, so a new payload can ship without being seen.",
    fix: "Scan the emit path or the collector input with pattern detectors, sample enough to catch rare fields, and alert on detector coverage itself.",
    checkFirst: [
      "Check the detector's sample rate and the field classes it covers.",
      "Verify the detector sees the same payload the index receives.",
      "Look for detector errors that silently reduce coverage.",
    ],
  },
];

export const piiRedactionModel: SimModel = {
  id: "observability-pii-redaction",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    if (values.existingStock > 0) {
      const jitter = 1 + rng.between(-0.005, 0.005);
      next.metrics = next.metrics.map((item) =>
        item.id === "existing-copies" ? { ...item, value: item.value * jitter } : item,
      );
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (values.unredacted >= 20 && frame.flags.leakSeen !== 1) {
      pushEvent(next, {
        id: "sensitive-fields-retained",
        at: frame.t,
        severity: "crit",
        title: "Sensitive fields reached retained telemetry",
        detail: `${values.unredacted.toFixed(0)}% of sensitive fields are unredacted. At ${values.leaked.toFixed(0)} fields per 10,000 events, ${values.newRetained.toFixed(0)}k new fields are retained per day; ${values.existingStock.toFixed(0)}k copies already exist.`,
        nodeId: "store",
        metricId: "retained-fields",
      });
      next.flags.leakSeen = 1;
    }
    if (values.unredacted < 20) next.flags.leakSeen = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.unredacted.toFixed(0)}% of sensitive fields are unredacted; ${values.leaked.toFixed(0)} leak per 10,000 events; ${values.newRetained.toFixed(0)}k new fields retained per day; ${values.existingStock.toFixed(0)}k copies already exist.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p);
    const existing = frame.metrics.find((item) => item.id === "existing-copies")?.value ?? 0;
    const items: string[] = [];
    items.push(`Redaction at the emitter removes ${values.coverage.toFixed(0)}% of matches before serialization. Any value that escapes is copied to every downstream sink.`);
    items.push(`At ${values.leaked.toFixed(0)} leaked fields per 10,000 events and 5 million events per day, the model retains ${values.newRetained.toFixed(0)}k new fields per day.`);
    items.push(`${existing.toFixed(0)}k fields from earlier exposure remain in retained copies. Stopping new leaks does not purge them.`);
    if (values.auditGap > 0) {
      items.push(`${values.auditGap.toFixed(0)}% of events are never checked by a detector, so the first signal may be a user or a customer complaint.`);
    } else {
      items.push("Every event is checked, but detection is not prevention: the scan can find a field after it has already been shipped.");
    }
    items.push(`There are ${values.fieldClasses} field classes in the payload. A new class is the most common way a working policy becomes incomplete.`);
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Unverified", tone: "warn" },
    { label: "Exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Emit-time allowlist covers every field class, all events are verified, and retention is 30 days.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "New debug fields",
    description: "Coverage slips to 97% as new fields appear, retention doubles, and verification covers 90% of events.",
    tone: "warn",
    params: defaults({ redactionCoverage: 97, fieldClasses: 4, retentionDays: 60, auditCoverage: 90, legacyShare: 3 }),
  },
  {
    id: "failure",
    label: "Debug payload leak",
    description: "A verbose release emits raw request bodies with tokens and email addresses for 180 days.",
    tone: "crit",
    params: defaults({ redactionCoverage: 35, fieldClasses: 7, retentionDays: 180, auditCoverage: 20, legacyShare: 65 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Emit-time allowlist restored and retention cut, but the copies from the old payload remain.",
    tone: "ok",
    params: defaults({ redactionCoverage: 100, fieldClasses: 7, retentionDays: 30, auditCoverage: 100, legacyShare: 65 }),
  },
];

const experiment: Experiment = {
  id: "predict-pii-path",
  title: "Predict where the leaked value ends up",
  simId: "pii-redaction",
  question:
    "A debug log now includes the raw request body with an email and a bearer token. The collector applies a filter, but the emitter does not. Where does the value exist?",
  prediction: {
    options: [
      { id: "console", label: "Only in the local console; the collector filter removes it before storage" },
      { id: "retained", label: "In the retained index, archives, vendor copies, and any trace or error payload derived from the same event" },
      { id: "metrics", label: "In metric labels, because labels are copied from log fields" },
      { id: "ephemeral", label: "Nowhere after 24 hours; log retention starts at ingest" },
    ],
    correctOptionId: "retained",
    explanation:
      "A collector filter can drop fields it recognizes, but the event has already left the process and may be copied to more than one sink. The durable copies are what turn a logging mistake into a data exposure. Redaction has to happen before serialization, and the retained copies need their own purge plan.",
  },
  setup: defaults({ redactionCoverage: 20, fieldClasses: 8, retentionDays: 180, auditCoverage: 10, legacyShare: 80 }),
  runFor: 20,
  observe: [
    "Unredacted coverage is 80%, crossing the critical threshold at 20%.",
    "About 384 fields leak per 10,000 events, or 192k new retained fields per day.",
    "Existing copies reach roughly 34,560k fields and do not disappear when coverage improves.",
    "The store and collector nodes fail while the application task still serves traffic.",
    "Verification covers only 10% of events, so the leak is detected late.",
  ],
  explain:
    "The leak rate is the share of sensitive values that escape the emitter multiplied by the number of field classes. New retained fields per day multiply that rate by events per day. Existing copies multiply the historical exposure by retention. A collector filter changes the path, not the fact that the process already emitted the value. The only control that prevents new copies is at emit time, backed by a scanner that sees the same payload the store receives.",
  fix: defaults({ redactionCoverage: 100, fieldClasses: 8, retentionDays: 30, auditCoverage: 100, legacyShare: 80 }),
  debrief:
    "The fix stops new leaks and shortens the future exposure, but it does not remove what is already stored. Existing copies fall from about 34,560k to about 5,760k because the retention window shortens, not because the old events were deleted. Containment has to include the index, archive, dead-letter queue, vendor, and any derived trace or error payload. The tradeoff is that aggressive redaction can remove the field that explains a failure, so keep a bounded, access-controlled path for the values responders actually need.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Personally identifiable information (PII) is data that can identify a person directly or in combination with other data: email addresses, phone numbers, names, government identifiers, account IDs, and precise location. Telemetry also carries credentials such as bearer tokens, session cookies, API keys, and passwords. Free-text fields are the hard case because a stack trace, URL, or request body can contain any of these without a field named `email`.",
  },
  {
    type: "p",
    text: "Redaction is the process of removing or replacing sensitive values before they are stored. Tokenization replaces a value with a reference that can be resolved by an authorized system; hashing replaces it with a one-way digest; masking keeps a shape such as the last four digits. The choice depends on whether an authorized responder must recover the value and how long the mapping lives.",
  },
  {
    type: "p",
    text: "The control point matters more than the technique. A rule applied at emit time, inside the logger or SDK, prevents the value from entering the telemetry pipeline. A rule applied at query time only hides it from one viewer; the value is still stored, copied, replicated, and retained. A collector rule sits between those two: it can catch a known field, but the event has already left the process and may have fan-out. This module treats examples as patterns, not legal advice; retention and notification rules come from your organization's policy and counsel.",
  },
  {
    type: "p",
    text: "A metric label is an indexed dimension, not free text. Each unique label value creates another time series and another place the value is stored. Never put an email address, user ID, token, raw URL, or request body in a metric label. Keep high-cardinality identifiers in logs or traces under redaction, or leave them out of telemetry entirely.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is application task, emit-time redactor, collector, retained store, then query or audit. The store is usually not one place. There may be a hot index, a cold archive, a dead-letter queue, a vendor copy, and trace or error payloads that contain the same attributes. Retention is a property of each copy, not a single global setting.",
  },
  {
    type: "compare",
    leftTitle: "Emit-time redaction",
    rightTitle: "Query-time masking",
    rows: [
      { label: "Value in the pipeline", left: "Never leaves the process", right: "Stored, copied, and replicated" },
      { label: "New field class", left: "Fails closed if the allowlist is enforced", right: "Visible to anyone with raw access" },
      { label: "Debugging", left: "Needs an approved path for safe values", right: "Full fidelity, high exposure" },
      { label: "Retention change", left: "Reduces future exposure", right: "Does not remove existing copies" },
      { label: "Operational cost", left: "Rules and tests in every emitter", right: "Central policy, but only at read time" },
    ],
  },
  {
    type: "table",
    headers: ["Copy", "Typical retention", "Why it matters"],
    rows: [
      ["Hot log index", "7 to 30 days", "Fast search and alerting; most incident queries run here"],
      ["Archive or cold storage", "Months to years", "Cheap to keep, expensive to purge and easy to forget"],
      ["Trace attributes and error payloads", "Varies by sampling", "Often duplicates request bodies and headers"],
      ["Dead-letter queue", "Until drained", "A failed pipeline can hold raw events indefinitely"],
      ["Vendor and replica copies", "Contract-dependent", "Deletion must propagate; the vendor is a separate system"],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unredacted sensitive fields: the share of values the emit-time rules did not match.",
      "Leaked fields per 10,000 events: the rate that reaches the collector.",
      "New retained fields per day: the inflow that current rules still allow.",
      "Existing leaked copies: the historical stock that remains until it is purged.",
      "Unverified events: the share the detector never scans, which sets detection delay.",
      "Node health that separates the emitter, collector, store, and detector.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Debug payload leak. Watch new retained fields per day and existing copies separately. Run the experiment before the debrief: after the fix, new retention falls but the existing-copy count remains. The model is illustrative; it does not encode a legal retention requirement.",
  },
  { type: "sim", simId: "pii-redaction" },
  { type: "experiment", experimentId: "predict-pii-path" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "A debug payload carried raw request fields past the emit-time rules. The collector received them, the store retained them, and the detector saw only a fraction of the events. Coverage was the first failure, but retention set the size of the exposure: the same leak rate with a shorter window would have retained far fewer copies. The application kept serving traffic while the telemetry pipeline was exposed, which is why this failure is often found by a person rather than by an alert.",
  },
  {
    type: "p",
    text: "Restoring coverage stopped new leaks. It did not delete the copies that already existed. The recovery preset shortens retention, which reduces the existing-copy estimate, but the historical stock remains visible rather than resetting to zero. That distinction is the operational core of the module: prevention and containment are different work with different owners.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Log explorer: a pattern query for email addresses, bearer tokens, or card-number shapes, run against the raw stream rather than a masked view.",
      "Trace and error payloads: request headers, URLs, and `http.request.body` attributes that duplicate what the log line contained.",
      "Pipeline metrics: detector coverage, parse failures, dead-letter depth, and events routed to an archive with a longer retention.",
      "Access logs: who queried the raw index or exported a range while the leak was present.",
      "Retention configuration: hot, archive, vendor, and backup windows, each with its own deletion path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Stop the emitter before tuning the detector. Identify the field, the service, and the first release that shipped it. Then enumerate every copy and its retention. A purge that misses the archive or the vendor is not containment.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Disable the offending log statement or field and deploy the change; do not rely on a collector filter as the only control.",
      "Rotate any credential that appeared in telemetry. Assume a token in a log is compromised.",
      "Enumerate the copies: hot index, archive, dead-letter queue, trace store, error tracker, vendor, and backups.",
      "Purge or expire the identified range, then verify with a query against each copy.",
      "Scope the exposure: field classes, time range, event count, and who had access.",
      "Follow the organization's privacy and legal process for assessment and any required notification.",
      "Add an emit-time allowlist, a detector that sees the same payload, and a test that fails when a new field is unclassified.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Aggressive redaction can remove the value that explains a production failure; keep an approved, audited path for the few fields responders need.",
      "Tokenization preserves joins but adds a mapping store that becomes its own sensitive asset; hashing is simpler but irreversible.",
      "Pattern detectors produce false positives and miss novel formats; pair them with an allowlist so unknown fields fail closed.",
      "Shorter retention reduces exposure and cost but can conflict with audit or contractual requirements.",
      "Collector-side filtering is useful defense in depth, but it cannot undo the copy the emitter already created.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "containment-plan",
    question:
      "A debug log contains a customer email and a bearer token. Walk me through the first hour.",
    difficulty: 3,
    hints: [
      "Prevention, credential rotation, then scope and copies.",
      "Do not start with a detector tuning exercise.",
    ],
    answer:
      "First I stop the source: disable the log statement or field and deploy. Then I rotate the token, because a credential in telemetry must be treated as compromised. Next I enumerate where the event went: hot index, archive, dead-letter queue, trace and error payloads, vendor, and backups. I purge or expire the identified range and verify with queries against each copy. I scope the time range, field classes, event count, and access history, then hand that to the privacy and legal process for assessment and any required notification. I add an emit-time allowlist rule and a regression test before closing the ticket.",
    followUps: [
      "What if the token was already expired?",
      "How do you prove the purge reached the archive?",
      "Who decides whether notification is required?",
    ],
    redFlags: [
      "Only adds a query-time mask.",
      "Forgets credential rotation.",
      "Assumes deleting from the hot index is enough.",
    ],
    rubric: [
      "Stops the emitter first.",
      "Rotates the credential.",
      "Enumerates copies and verifies deletion.",
      "Routes legal assessment to the right owner.",
    ],
  },
  {
    id: "emit-vs-query",
    question:
      "Why is query-time masking not sufficient for PII in telemetry?",
    difficulty: 2,
    hints: [
      "Think about copies, replication, and who can read raw data.",
      "Masking changes the view, not the stored value.",
    ],
    answer:
      "Query-time masking changes what one query returns. The value is still in the index, the archive, the replicas, the vendor, and any export. Anyone with raw access, a different role, or a backup can still read it, and retention keeps it there. It also does not prevent the value from reaching a downstream system that was not designed for it. Masking is a useful last layer for authorized viewers, but it is not the control that keeps personal data out of telemetry.",
    followUps: [
      "When would query-time masking still be appropriate?",
      "How do replicas and backups change the answer?",
      "What would you measure to prove the control works?",
    ],
    redFlags: [
      "Treats masking as deletion.",
      "Ignores replicas and exports.",
      "Has no access-control model.",
    ],
    rubric: [
      "Separates storage from presentation.",
      "Names copies and access paths.",
      "Assigns masking a defense-in-depth role.",
    ],
  },
  {
    id: "tokenize-or-hash",
    question:
      "When would you tokenize a sensitive identifier instead of hashing it?",
    difficulty: 3,
    hints: [
      "Start from whether an authorized responder must recover the value.",
      "Consider joins and correlation across events.",
    ],
    answer:
      "I tokenize when an authorized system must recover the original value or join events by the same identifier without storing the raw value everywhere. Tokenization keeps a mapping store, which becomes a high-value asset with its own access control and retention. I hash when I only need equality or correlation and never need to recover the value, using a keyed hash if dictionary attacks are a concern. In both cases the mapping or key must not live in the same store as the telemetry.",
    followUps: [
      "What attacks does a keyed hash prevent that a plain hash does not?",
      "Where would the token mapping live?",
      "How do you rotate the key without breaking joins?",
    ],
    redFlags: [
      "Uses a plain hash for low-entropy values without a key.",
      "Stores the mapping beside the logs.",
      "Has no rotation plan.",
    ],
    rubric: [
      "Ties the choice to recovery and joins.",
      "Treats the mapping store as sensitive.",
      "Considers keyed hashing and rotation.",
    ],
  },
  {
    id: "detector-coverage",
    question:
      "Your leak detector covers 10% of events. What does that mean for detection time, and how do you improve it?",
    difficulty: 2,
    hints: [
      "Coverage is not the same as accuracy.",
      "Think about where the detector sits in the path.",
    ],
    answer:
      "At 10% coverage, a leak that affects one in a thousand events may never be sampled, so detection depends on a user report or a separate control. I would move the detector to the emit path or the collector input, scan the same payload the index receives, and cover every field class the allowlist knows about. I would also measure detector errors and parse failures, because a detector that is running but blind is worse than a known gap. The goal is not 100% inspection of every byte; it is enough coverage to catch a new field class before it is retained for the full window.",
    followUps: [
      "How would you test the detector with a synthetic sensitive value?",
      "What false-positive rate would you tolerate?",
      "Should the detector block or only alert?",
    ],
    redFlags: [
      "Assumes sampling is enough for rare fields.",
      "Ignores detector errors.",
      "Blocks production traffic on a noisy pattern.",
    ],
    rubric: [
      "Connects coverage to detection delay.",
      "Moves detection closer to emit time.",
      "Measures detector health and false positives.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The logger uses an allowlist of fields and fails closed for unknown fields.",
      "Request bodies, headers, cookies, and URLs are never logged raw by default.",
      "A detector scans the same payload the index receives and reports its own coverage.",
      "Every telemetry copy has an owner, a retention setting, and a deletion path.",
      "Credentials found in telemetry have a rotation procedure.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Disable the emitter and rotate any exposed credential.",
      "Identify the field, service, release, and time range.",
      "Enumerate hot, archive, vendor, dead-letter, trace, and error copies.",
      "Purge or expire the range, then verify each copy with a query.",
      "Record access history for the exposed window.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a regression test that emits a synthetic sensitive value and asserts it is removed.",
      "Review the field allowlist with the teams that own the emitters.",
      "Reconcile retention with policy and cost, and document the decision.",
      "Walk the containment plan with the privacy and legal owners before the next leak.",
    ],
  },
];

const references = [
  {
    title: "Logging Cheat Sheet",
    url: "https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html",
    publisher: "OWASP",
    kind: "docs" as const,
    note: "What not to log, injection risks, and protection of log data.",
  },
  {
    title: "Regulation (EU) 2016/679 (GDPR)",
    url: "https://eur-lex.europa.eu/eli/reg/2016/679/oj",
    publisher: "EUR-Lex",
    kind: "standard" as const,
    note: "Official text. Retention and notification duties depend on your role and jurisdiction; this module is not legal advice.",
  },
  {
    title: "Logs Data Model",
    url: "https://opentelemetry.io/docs/specs/otel/logs/data-model/",
    publisher: "OpenTelemetry",
    kind: "docs" as const,
    note: "Attribute and body conventions that determine where sensitive values can appear.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "pii-redaction": {
      model: piiRedactionModel,
      presets,
      instructions:
        "Start Healthy, then apply Debug payload leak. Compare coverage, new retained fields per day, and existing copies. Run the experiment, then restore emit-time coverage and observe that existing copies remain.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Event volume, field rate, and retention are teaching values; they do not encode a legal retention requirement.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-structured-logging",
    "observability-log-volume-cost",
    "compliance-phi",
    "observability-error-grouping",
  ],
};
