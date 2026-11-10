import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const POLICY_RETENTION_DAYS = 180;

const params = [
  {
    id: "actorCoverage",
    label: "Events with a named actor",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Schema",
    help: "Share of privileged events that record the authenticated principal, such as a person, role session, or on-behalf-of subject. A generic service name is not an actor.",
    format: "percent" as const,
  },
  {
    id: "actionCoverage",
    label: "Privileged actions instrumented",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Schema",
    help: "Share of privileged actions that produce an audit event at all. An action that is never emitted cannot be reconstructed later.",
    format: "percent" as const,
  },
  {
    id: "integrity",
    label: "Tamper-evident coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Protection",
    help: "Share of audit records written to append-only storage or covered by integrity validation such as a hash chain or signed digest.",
    format: "percent" as const,
  },
  {
    id: "retentionDays",
    label: "Retention",
    min: 1,
    max: 365,
    step: 1,
    value: 365,
    unit: " days",
    group: "Protection",
    help: "Days the audit trail is retained. The model compares this with a 180-day internal baseline; your policy and contracts may require a different window.",
    format: "count" as const,
  },
  {
    id: "secretRedaction",
    label: "Secret redaction coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Protection",
    help: "Share of secret-bearing fields removed before an audit event is stored. An audit record should describe the action, not capture a token, password, key, or full request body.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  actor: number;
  action: number;
  integrity: number;
  retention: number;
  redaction: number;
  attributable: number;
  attributionGap: number;
  integrityGap: number;
  retentionShortfall: number;
  secretExposure: number;
  protectionGap: number;
}

function compute(p: Params): Computed {
  const actor = clamp(num(p, "actorCoverage", 100), 0, 100);
  const action = clamp(num(p, "actionCoverage", 100), 0, 100);
  const integrity = clamp(num(p, "integrity", 100), 0, 100);
  const retention = Math.round(clamp(num(p, "retentionDays", 365), 1, 365));
  const redaction = clamp(num(p, "secretRedaction", 100), 0, 100);
  const attributable = (actor * action) / 100;
  const attributionGap = 100 - attributable;
  const integrityGap = 100 - integrity;
  const retentionShortfall = Math.max(0, POLICY_RETENTION_DAYS - retention);
  return {
    actor,
    action,
    integrity,
    retention,
    redaction,
    attributable,
    attributionGap,
    integrityGap,
    retentionShortfall,
    secretExposure: 100 - redaction,
    protectionGap: Math.max(integrityGap, retentionShortfall / 1.8),
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

function worstHealth(...states: Array<"ok" | "warn" | "crit">): "ok" | "warn" | "crit" {
  if (states.includes("crit")) return "crit";
  if (states.includes("warn")) return "warn";
  return "ok";
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const storeHealth = worstHealth(
    healthFor(values.integrityGap, 10, 30),
    healthFor(values.retentionShortfall, 30, 90),
  );
  const queryHealth = worstHealth(
    healthFor(values.attributionGap, 5, 20),
    healthFor(values.retentionShortfall, 30, 90),
  );
  return {
    t: 0,
    nodes: [
      {
        id: "action",
        label: "Privileged action",
        kind: "service",
        health: "ok",
        utilization: 1 - values.action / 100,
        sublabel: `${values.action.toFixed(0)}% instrumented`,
        detail: "The change or access that needs a record: role change, key use, data export, or production write.",
      },
      {
        id: "emitter",
        label: "Audit emitter",
        kind: "worker",
        health: healthFor(values.attributionGap, 5, 20),
        utilization: values.attributionGap / 100,
        sublabel: `${values.actor.toFixed(0)}% name an actor`,
        detail: "The library or platform hook that writes the event. It must capture the authenticated principal before the action returns.",
      },
      {
        id: "pipeline",
        label: "Audit pipeline",
        kind: "service",
        health: healthFor(values.secretExposure, 1, 10),
        utilization: values.secretExposure / 100,
        sublabel: `${values.redaction.toFixed(0)}% secret fields removed`,
        detail: "Parsing, enrichment, and redaction. The pipeline must remove secrets before storage, not during an investigation.",
      },
      {
        id: "store",
        label: "Immutable store",
        kind: "storage",
        health: storeHealth,
        utilization: clamp(values.protectionGap / 100),
        sublabel: `${values.integrity.toFixed(0)}% tamper-evident`,
        detail: "Append-only storage with integrity validation and a retention policy. Deletion rights are a control, not an admin convenience.",
      },
      {
        id: "query",
        label: "Investigator query",
        kind: "external",
        health: queryHealth,
        utilization: clamp(Math.max(values.attributionGap, values.retentionShortfall / 1.8) / 100),
        sublabel: `${values.retention} days retained`,
        detail: "The read path used during an audit or incident. If the record is missing, late, or unattributable, the query cannot answer the question.",
      },
    ],
    edges: [
      edge("action-emitter", "action", "emitter", clamp(values.action / 100), healthFor(values.attributionGap, 5, 20)),
      edge("emitter-pipeline", "emitter", "pipeline", clamp(values.actor / 100), healthFor(values.secretExposure, 1, 10)),
      edge("pipeline-store", "pipeline", "store", clamp(values.integrity / 100), storeHealth),
      edge("store-query", "store", "query", clamp(values.retention / POLICY_RETENTION_DAYS), queryHealth),
    ],
    metrics: [
      metric("attribution-gap", "Privileged actions without an attributable actor", values.attributionGap, "%", 5, 20, "percent"),
      metric("integrity-gap", "Audit records without integrity protection", values.integrityGap, "%", 10, 30, "percent"),
      metric("retention-shortfall", "Retention shortfall against baseline", values.retentionShortfall, " days", 30, 90, "count"),
      metric("secret-exposure", "Secret fields retained in audit events", values.secretExposure, "%", 1, 10, "percent"),
      metric("audit-coverage", "Attributable audit coverage", values.attributable, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.attributionGap.toFixed(0)}% of privileged actions lack an attributable actor; ${values.integrityGap.toFixed(0)}% lack integrity protection; retention is ${values.retentionShortfall.toFixed(0)} days short of the ${POLICY_RETENTION_DAYS}-day baseline.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "attribution-gap",
    metricId: "attribution-gap",
    warn: 5,
    crit: 20,
    title: "A privileged action has no attributable actor",
    cause:
      "An event without the authenticated principal, or with a generic service identity, cannot prove who changed the system. The action may be recorded, but the audit trail cannot answer who did it, which is the question an investigation starts with.",
    fix:
      "Emit the principal, role session, identity provider subject, and on-behalf-of subject on every privileged event. Reject events that identify only a service. For federated access, carry the source identity through the role session.",
    checkFirst: [
      "Open one privileged event and identify the human or workload behind it.",
      "Check whether federation or role assumption overwrites the original identity.",
      "Find privileged actions that emit no event at all.",
    ],
  },
  {
    id: "integrity-gap",
    metricId: "integrity-gap",
    warn: 10,
    crit: 30,
    title: "Audit records are not tamper-evident",
    cause:
      "If the log store allows edits or deletion, an attacker with access can remove the evidence of their own action. A hash chain, signed digest, or append-only store makes modification detectable, but only if the coverage is complete.",
    fix:
      "Write to append-only storage, enable log file integrity validation or hash chaining, restrict delete permissions, and copy the trail to a separate account or trust boundary. Test that a modified record is detected.",
    checkFirst: [
      "Can an administrator delete or edit an audit record in place?",
      "Is integrity validation enabled for every trail and region?",
      "Is there a second copy outside the account that produces the logs?",
    ],
  },
  {
    id: "retention-shortfall",
    metricId: "retention-shortfall",
    warn: 30,
    crit: 90,
    title: "Audit retention is shorter than the investigation window",
    cause:
      "The model uses a 180-day internal baseline. If actual retention is shorter, evidence for an incident or audit can expire before anyone asks for it. Retention is set by policy, contract, and legal hold, not by a storage default.",
    fix:
      "Set retention from the applicable policy and contract, apply legal hold when an investigation starts, and verify that deletion jobs honor the hold. Keep the audit trail separate from high-volume application logs.",
    checkFirst: [
      "What retention does the policy or contract require for this trail?",
      "When did the oldest record in the query window expire?",
      "Can a legal hold suspend deletion across every copy?",
    ],
  },
  {
    id: "secret-exposure",
    metricId: "secret-exposure",
    warn: 1,
    crit: 10,
    title: "Audit events are capturing secrets",
    cause:
      "An audit record should describe the action, not preserve the credential or request body. Tokens, passwords, keys, cookies, and full payloads in an audit trail widen the blast radius and turn the evidence store into a secret store.",
    fix:
      "Redact at emit time with an allowlist, never log tokens, passwords, keys, or full request bodies, and test with synthetic canary secrets. Audit the audit pipeline itself for secret patterns.",
    checkFirst: [
      "Search the audit payload for token, authorization, password, and key fields.",
      "Check whether redaction runs before enrichment and storage.",
      "Verify that a canary secret does not appear in the trail.",
    ],
  },
];

export const auditLogsModel: SimModel = {
  id: "compliance-audit-logs",
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
    if (values.attributionGap >= 20 && frame.flags.attributionEvent !== 1) {
      pushEvent(next, {
        id: "privileged-action-unattributed",
        at: frame.t,
        severity: "crit",
        title: "A privileged change has no attributable actor",
        detail: `${values.attributionGap.toFixed(0)}% of privileged actions lack a named actor. The record may show what happened but not who did it.`,
        nodeId: "emitter",
        metricId: "attribution-gap",
      });
      next.flags.attributionEvent = 1;
    }
    if (values.attributionGap < 20) next.flags.attributionEvent = 0;
    if (values.secretExposure >= 10 && frame.flags.secretEvent !== 1) {
      pushEvent(next, {
        id: "secrets-in-audit-log",
        at: frame.t,
        severity: "crit",
        title: "Secrets are being retained in the audit trail",
        detail: `${values.secretExposure.toFixed(0)}% of secret-bearing fields remain in stored audit events. The evidence store is now a credential exposure path.`,
        nodeId: "pipeline",
        metricId: "secret-exposure",
      });
      next.flags.secretEvent = 1;
    }
    if (values.secretExposure < 10) next.flags.secretEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.attributionGap.toFixed(0)}% of privileged actions lack an attributable actor; ${values.integrityGap.toFixed(0)}% lack integrity protection; retention is ${values.retentionShortfall.toFixed(0)} days short of the ${POLICY_RETENTION_DAYS}-day baseline.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `Attributable coverage is ${values.attributable.toFixed(0)}%: ${values.actor.toFixed(0)}% of events name an actor and ${values.action.toFixed(0)}% of privileged actions are instrumented. Both factors are required; either gap loses the action.`,
      `The attribution gap is ${values.attributionGap.toFixed(0)}%. An event with action, target, time, and outcome but no actor can describe a change without proving who made it.`,
      `Integrity protection covers ${values.integrity.toFixed(0)}% of records, leaving an ${values.integrityGap.toFixed(0)}% gap. A log that can be edited is not evidence of what happened, only a record of what remains.`,
      `Retention is ${values.retention} days against the model's ${POLICY_RETENTION_DAYS}-day baseline, a shortfall of ${values.retentionShortfall.toFixed(0)} days. Check the actual policy and contract before choosing a window.`,
      `Secret redaction covers ${values.redaction.toFixed(0)}% of secret-bearing fields. An audit log should capture the action, not the credential used to perform it.`,
    ];
  },
  legend: [
    { label: "Attributable", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Unattributable", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Every privileged action names an actor, is integrity-protected, retained for 365 days, and free of secrets.",
    tone: "ok",
    params: defaults({ actorCoverage: 100, actionCoverage: 100, integrity: 100, retentionDays: 365, secretRedaction: 100 }),
  },
  {
    id: "peak",
    label: "New service",
    description: "A new service emits 95% of privileged actions and names the actor 90% of the time. Integrity and redaction lag.",
    tone: "warn",
    params: defaults({ actorCoverage: 90, actionCoverage: 95, integrity: 90, retentionDays: 120, secretRedaction: 98 }),
  },
  {
    id: "failure",
    label: "Unattributable trail",
    description: "Most privileged actions are uninstrumented, surviving records name only a service, integrity is weak, and secrets remain.",
    tone: "crit",
    params: defaults({ actorCoverage: 20, actionCoverage: 50, integrity: 20, retentionDays: 7, secretRedaction: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The emitter captures the principal, every privileged action is instrumented, the store is tamper-evident, and retention meets policy.",
    tone: "ok",
    params: defaults({ actorCoverage: 100, actionCoverage: 100, integrity: 100, retentionDays: 365, secretRedaction: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-actor",
  title: "Predict whether the record is attributable",
  simId: "audit-logs",
  question:
    "An audit record contains the action, target, timestamp, and outcome, but the actor field is the string system. Can you attribute the privileged change?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. The action and target are enough to identify the change" },
      { id: "no", label: "No. Actor is required, and system is not an identity" },
      { id: "timestamp", label: "Yes, if the timestamp is precise to the second" },
      { id: "immutable", label: "Yes, because the record is immutable" },
    ],
    correctOptionId: "no",
    explanation:
      "The actor is the first field an investigation needs. Action and target say what changed; the actor says who changed it. A generic system value names the component that wrote the event, not the person or workload that authorized the action. Immutability proves the record was not altered; it does not add identity.",
  },
  setup: defaults({ actorCoverage: 0, actionCoverage: 100, integrity: 100, retentionDays: 365, secretRedaction: 100 }),
  runFor: 20,
  observe: [
    "Attributable coverage is 0% because no event names an actor.",
    "The attribution gap is 100%, crossing the critical threshold immediately.",
    "The emitter and query nodes fail while integrity and retention remain healthy.",
    "The action, target, and timestamp are present, but they cannot answer who made the change.",
  ],
  explain:
    "A defensible audit event needs the authenticated principal, the action, the target resource, the time, the outcome, and the source. For a role session, the principal should include the role and the identity that assumed it, plus any on-behalf-of subject. A service name is useful context, not attribution. The fix is to capture identity at the enforcement point and carry it into the event before the action returns.",
  fix: defaults({ actorCoverage: 100, actionCoverage: 100, integrity: 100, retentionDays: 365, secretRedaction: 100 }),
  debrief:
    "With actor coverage restored, the same records become attributable: the investigator can name the principal, follow the action to the target, and see the outcome. The trail still needs integrity, retention, and secret redaction, because attribution alone does not keep evidence trustworthy. This is engineering education, not legal advice; the retention and audit requirements that apply to you depend on policy, contract, and law.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An audit log is a durable record of security-relevant actions: who did what, to which target, when, from where, and with what outcome. It is not the same as an application debug log. A debug log helps a developer reproduce a bug; an audit log helps an investigator or auditor reconstruct a privileged change after the fact. The audience and the retention are different, and so are the integrity requirements.",
  },
  {
    type: "p",
    text: "The core fields are actor, action, target, timestamp, outcome, and source. Actor is the authenticated principal, not the service that wrote the event. Action is a stable verb or event name, not a prose sentence. Target names the resource and its identifier. Timestamp should be synchronized and precise enough to order events across systems. Outcome distinguishes success, failure, and denial. Source adds the network origin, identity provider, request ID, or session context that makes the record investigable.",
  },
  {
    type: "p",
    text: "Integrity and retention turn a collection of events into evidence. Integrity means modifications are detectable, through append-only storage, a hash chain, signed digests, or a separate trust boundary. Retention means the record still exists when the investigation or audit needs it. Secrets are the opposite requirement: the trail must not capture tokens, passwords, keys, cookies, or full request bodies. An audit log should describe the action, not preserve the credential.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The audit path runs from the enforcement point to the investigator. The privileged action calls an emitter, the emitter writes a structured event, the pipeline enriches and redacts it, the store protects and retains it, and the query reads it. A break at any stage changes the answer: no emitter means no record, no actor means no attribution, no integrity means no trust, no retention means no evidence, and no redaction means the evidence store becomes a secret store.",
  },
  {
    type: "table",
    headers: ["Field", "Question it answers", "Failure mode"],
    rows: [
      ["Actor", "Who made the change?", "Generic service name or shared account"],
      ["Action", "What was attempted?", "Free-text message with no stable verb"],
      ["Target", "Which resource changed?", "Missing identifier or ambiguous name"],
      ["Timestamp", "When did it happen?", "Unsynced clocks or second-level collisions"],
      ["Outcome", "Did it succeed?", "Only successes logged, denials invisible"],
      ["Source", "From where and in which session?", "No request ID, IP, or identity provider"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative values and a 180-day internal retention baseline. That number is a teaching device, not a legal requirement. Your policy, contract, and legal hold determine the real window. The important engineering question is whether the trail can answer who did what for the period you promised.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Attributable audit coverage: the product of actor coverage and privileged-action instrumentation.",
      "Integrity gap: records that can be edited or deleted without detection.",
      "Retention shortfall: days missing against the model's internal baseline.",
      "Secret exposure: secret-bearing fields retained in stored audit events.",
      "Node states: emitter, pipeline, store, and query show which stage broke the trail.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply New service and watch attribution and integrity diverge. Apply Unattributable trail to fail several stages at once. Run the experiment before revealing the explanation, then apply Recovery and verify that the same privileged action is attributable from the emitter to the query.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. Audit, retention, and breach-notification obligations depend on the framework, the contract, and the facts. Use this module to design a defensible trail, then confirm the required fields and windows with your security and compliance owners.",
  },
  { type: "sim", simId: "audit-logs" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The trail recorded the action, target, and time but not the actor, so the privileged change could be described but not attributed. Instrumentation coverage and actor coverage are multiplicative: an action that emits no event is lost, and an event that names only a service cannot answer who did it. Integrity and retention were healthy in the experiment, which is the trap: a trustworthy record of the wrong facts is still not evidence.",
  },
  {
    type: "p",
    text: "Restoring actor coverage made the same records investigable. The other controls still matter: an editable record can be changed, a short retention window can delete the evidence, and an unredacted event can expose the credential used to perform the action.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Control-plane audit trails such as AWS CloudTrail for API activity.",
      "Application audit events for business-level privileged actions.",
      "Identity provider logs that connect a federated subject to a role session.",
      "Integrity validation, digest files, or hash-chain verification results.",
      "Retention configuration, legal holds, and deletion job outcomes.",
      "Redaction tests using synthetic canary secrets.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Open one privileged event and name the human or workload behind it.",
      "Check whether every privileged action emits an event at all.",
      "Verify that the store is append-only or integrity-validated.",
      "Compare retention with the policy, contract, and investigation window.",
      "Search the trail for tokens, passwords, keys, and full request bodies.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Capture the authenticated principal at the enforcement point, including role session and on-behalf-of context.",
      "Emit a stable action name, target identifier, timestamp, outcome, and source.",
      "Instrument every privileged action, including failures and denials.",
      "Write to append-only storage with integrity validation and a separate copy.",
      "Set retention from policy and support legal hold.",
      "Redact secrets at emit time and test with a canary value.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More audit detail improves investigation and increases storage and privacy risk; capture identifiers and outcomes, not full payloads.",
      "Longer retention supports audits and costs money; the window should come from policy and contract, not a default.",
      "Append-only storage improves integrity and complicates deletion requests; plan for legal hold and controlled deletion.",
      "Centralizing audit logs improves correlation and creates a high-value target; restrict access and keep a second copy.",
      "Synchronous audit writes improve completeness and add latency; buffer with durable delivery and alert on drops.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "audit-schema",
    question:
      "What fields do you require in an audit event for a privileged production change?",
    difficulty: 2,
    hints: [
      "Start with who, what, when, where, and outcome.",
      "Actor is not the service that wrote the event.",
    ],
    answer:
      "I would require the authenticated actor, including the role session and any on-behalf-of subject; a stable action name; the target resource and identifier; a synchronized timestamp; the outcome, including denial and failure; and the source, such as the identity provider, network origin, and request ID. I would also include a correlation ID and the policy or approval that authorized the action. The event should not include secrets or full request bodies. For a federated role, the actor must preserve the original identity, or the trail will point at a role session with no person behind it.",
    followUps: [
      "How do you record a workload identity without a human actor?",
      "What do you do when the target is a whole resource group?",
      "How do you order events from systems with different clocks?",
    ],
    redFlags: [
      "Accepts a service name as the actor.",
      "Logs the full request body.",
      "Has no outcome or source field.",
    ],
    rubric: [
      "Names the core fields.",
      "Distinguishes actor from emitter.",
      "Includes outcome and source.",
      "Excludes secrets.",
    ],
  },
  {
    id: "integrity",
    question:
      "How do you make an audit trail trustworthy when the same administrators can access the log store?",
    difficulty: 3,
    hints: [
      "Trust requires a boundary the administrator does not control.",
      "Detection is often enough; prevention is stronger.",
    ],
    answer:
      "I would make the trail append-only and enable integrity validation, such as signed digest files or a hash chain. Then I would copy it to a separate account or trust boundary with different administrators and a restricted write path. I would limit delete permissions, require a break-glass approval for any deletion, and alert on changes to the trail configuration. The goal is that an administrator who can change the production system cannot silently change the evidence of their own action. I would test the detection by attempting a modification in a controlled environment.",
    followUps: [
      "What would you do if the second copy is in the same cloud account?",
      "How do you handle a legal hold on an immutable store?",
      "What evidence do you keep that integrity validation actually ran?",
    ],
    redFlags: [
      "Relies on file permissions in the same account.",
      "Enables integrity validation but never checks it.",
      "Lets the same admin delete the trail.",
    ],
    rubric: [
      "Uses append-only or integrity validation.",
      "Separates the trust boundary.",
      "Restricts deletion.",
      "Tests detection.",
    ],
  },
  {
    id: "retention-secrets",
    question:
      "How do you balance audit retention with the requirement to keep secrets out of the trail?",
    difficulty: 3,
    hints: [
      "Retention and redaction are separate controls.",
      "The audit event should describe the action, not the payload.",
    ],
    answer:
      "I would define the event schema first: actor, action, target, time, outcome, and source. That schema does not need the credential or the full request body. I would redact at emit time with an allowlist, test with synthetic canary secrets, and scan the stored trail for secret patterns. Retention should be set from policy and contract, with legal hold and controlled deletion. The two controls interact because a long-retained secret is a long-lived exposure, so the safest design is not to store the secret at all. I would also keep high-volume debug logs separate from the audit trail.",
    followUps: [
      "What if an investigation needs the request body?",
      "How do you prove redaction ran on every event?",
      "Who can approve deletion before the retention window ends?",
    ],
    redFlags: [
      "Stores the full payload for debugging.",
      "Relies on access control instead of redaction.",
      "Has no legal hold process.",
    ],
    rubric: [
      "Designs the schema to avoid secrets.",
      "Redacts at emit time.",
      "Tests and scans.",
      "Separates audit from debug logs.",
    ],
  },
];

const checklist = [
  {
    title: "Before launch",
    items: [
      "Define the audit event schema and the actor model for humans and workloads.",
      "Instrument every privileged action, including denials and failures.",
      "Write to append-only or integrity-validated storage with a separate copy.",
      "Set retention from policy and contract, and support legal hold.",
      "Redact secrets at emit time and test with a canary value.",
    ],
  },
  {
    title: "During an investigation",
    items: [
      "Start from the actor and the action, then follow the target and outcome.",
      "Check whether the event is missing, late, or unattributed.",
      "Verify integrity before relying on the record.",
      "Check the retention window against the incident date.",
      "Preserve the evidence before making changes.",
    ],
  },
  {
    title: "After an incident",
    items: [
      "Close the instrumentation gap that lost the action.",
      "Fix the actor capture at the enforcement point.",
      "Re-test integrity validation and deletion permissions.",
      "Review retention and redaction with the evidence owners.",
    ],
  },
];

const references = [
  {
    title: "AWS CloudTrail User Guide",
    url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-user-guide.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Control-plane audit events, trails, and event history.",
  },
  {
    title: "Validating CloudTrail log file integrity",
    url: "https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Digest files and integrity validation for audit records.",
  },
  {
    title: "Guide to Computer Security Log Management (NIST SP 800-92)",
    url: "https://csrc.nist.gov/pubs/sp/800/92/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Log management, retention, and the operational use of audit records.",
  },
  {
    title: "OWASP Logging Cheat Sheet",
    url: "https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html",
    publisher: "OWASP",
    kind: "docs" as const,
    note: "What to log, what to exclude, and how to avoid sensitive data in logs.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "audit-logs": {
      model: auditLogsModel,
      presets,
      instructions:
        "Start Healthy, then apply New service and compare attribution with integrity. Apply Unattributable trail to fail the emitter, store, and redaction paths. Run the experiment before revealing the explanation, then apply Recovery and follow one privileged action from actor to query.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and the 180-day retention baseline are teaching values, not a legal requirement or a provider guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["observability-structured-logging", "compliance-access-controls", "compliance-hipaa"],
};
