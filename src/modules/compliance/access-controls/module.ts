import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "standingAdmin",
    label: "Standing admin access",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Privilege",
    help: "Share of administrative access that is always available instead of granted just in time. Standing admin is the population an attacker inherits without an approval step.",
    format: "percent" as const,
  },
  {
    id: "reviewCoverage",
    label: "Quarterly review coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Review",
    help: "Share of roles reviewed by an owner in the current period, with a dated decision to keep, change, or remove access.",
    format: "percent" as const,
  },
  {
    id: "ownerCoverage",
    label: "Roles with a named owner",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Review",
    help: "Share of roles with a person accountable for membership. A role with no owner cannot be reviewed, and an orphaned role survives every cleanup.",
    format: "percent" as const,
  },
  {
    id: "sharedAccounts",
    label: "Access through shared accounts",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Identity",
    help: "Share of production access performed through an account used by more than one person. The audit log cannot prove which person acted.",
    format: "percent" as const,
  },
  {
    id: "sodConflicts",
    label: "Separation-of-duties conflicts",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Privilege",
    help: "Share of sensitive role pairs held by the same identity, such as the ability to request and approve a production change.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  standing: number;
  review: number;
  owner: number;
  shared: number;
  sod: number;
  findingRate: number;
  timeToAnswer: number;
  unattributable: number;
}

function compute(p: Params): Computed {
  const standing = clamp(num(p, "standingAdmin", 0), 0, 100);
  const review = clamp(num(p, "reviewCoverage", 100), 0, 100);
  const owner = clamp(num(p, "ownerCoverage", 100), 0, 100);
  const shared = clamp(num(p, "sharedAccounts", 0), 0, 100);
  const sod = clamp(num(p, "sodConflicts", 0), 0, 100);
  const clean =
    (review / 100) *
    (owner / 100) *
    (1 - shared / 100) *
    (1 - 0.5 * (standing / 100)) *
    (1 - 0.5 * (sod / 100));
  return {
    standing,
    review,
    owner,
    shared,
    sod,
    findingRate: 100 * (1 - clean),
    timeToAnswer:
      2 + 0.5 * (100 - review) + 0.3 * (100 - owner) + 0.2 * shared + 0.1 * standing + 0.1 * sod,
    unattributable: shared,
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
  const findingHealth = healthFor(values.findingRate, 20, 50);
  return {
    t: 0,
    nodes: [
      {
        id: "identity",
        label: "Identity provider",
        kind: "service",
        health: healthFor(values.shared, 5, 20),
        utilization: values.shared / 100,
        sublabel: `${values.shared.toFixed(0)}% shared-account access`,
        detail: "The source of truth for a named principal. A shared login breaks attribution before the request reaches production.",
      },
      {
        id: "request",
        label: "Access request",
        kind: "service",
        health: healthFor(values.standing, 20, 50),
        utilization: values.standing / 100,
        sublabel: `${values.standing.toFixed(0)}% standing admin`,
        detail: "A request should carry a reason, a scope, and an expiry. Standing admin skips the request after the first grant.",
      },
      {
        id: "approval",
        label: "Approval and owner",
        kind: "service",
        health: healthFor(Math.max(100 - values.review, 100 - values.owner), 20, 50),
        utilization: Math.max(100 - values.review, 100 - values.owner) / 100,
        sublabel: `${values.owner.toFixed(0)}% owned, ${values.review.toFixed(0)}% reviewed`,
        detail: "An owner approves membership and a reviewer confirms it is still needed. Both create dated evidence.",
      },
      {
        id: "role",
        label: "Production role",
        kind: "db",
        health: findingHealth,
        utilization: values.findingRate / 100,
        sublabel: `${values.findingRate.toFixed(0)}% of roles with findings`,
        detail: "The role binding is the thing an auditor tests. It should name a principal, a scope, an approver, and a review date.",
      },
      {
        id: "data",
        label: "Production data",
        kind: "db",
        health: findingHealth,
        utilization: values.findingRate / 100,
        sublabel: "read and write scope",
        detail: "The data an identity can reach. Least privilege means the smallest scope that still does the job.",
      },
      {
        id: "review",
        label: "Review evidence",
        kind: "storage",
        health: healthFor(values.timeToAnswer, 15, 45),
        utilization: clamp(values.timeToAnswer / 120),
        sublabel: `${values.timeToAnswer.toFixed(0)} min to answer`,
        detail: "The export that answers who can read production data. If it takes hours to assemble, it is not operational evidence.",
      },
    ],
    edges: [
      edge("identity-request", "identity", "request", clamp(values.review / 100)),
      edge("request-approval", "request", "approval", clamp(values.owner / 100)),
      edge("approval-role", "approval", "role", clamp(values.owner / 100)),
      edge("role-data", "role", "data", clamp(1 - values.findingRate / 100)),
      edge("role-review", "role", "review", clamp(1 - values.timeToAnswer / 120)),
    ],
    metrics: [
      metric("finding-rate", "Roles with access findings", values.findingRate, "%", 20, 50, "percent"),
      metric("time-to-answer", "Time to answer an access query", values.timeToAnswer, " min", 15, 45, "number"),
      metric("unattributable", "Access through shared accounts", values.unattributable, "%", 5, 20, "percent"),
      metric("sod-risk", "Separation-of-duties conflicts", values.sod, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.findingRate.toFixed(0)}% of roles have access findings; an auditor query takes ${values.timeToAnswer.toFixed(0)} minutes; ${values.unattributable.toFixed(0)}% of access goes through shared accounts.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "finding-rate",
    metricId: "finding-rate",
    warn: 20,
    crit: 50,
    title: "Access findings exceed the review threshold",
    cause:
      "Standing admin, missing owners, missed reviews, shared accounts, and conflicting duties each leave roles that cannot be defended. The finding rate compounds these gaps, so a small problem in several areas becomes a large population of unreviewed access.",
    fix:
      "Remove standing admin in favor of just-in-time grants, assign an owner to every role, complete the current review, eliminate shared accounts, and split conflicting duties. Re-run the review and export the result.",
    checkFirst: [
      "Which roles have no owner, and who can grant them?",
      "When was the last review, and which roles were skipped?",
      "Where does one identity hold both request and approval rights?",
    ],
  },
  {
    id: "time-to-answer",
    metricId: "time-to-answer",
    warn: 15,
    crit: 45,
    title: "Access evidence cannot answer the auditor's question",
    cause:
      "When the inventory is spread across consoles, tickets, and screenshots, reconstructing who can read production data takes hours. That delay is itself a finding because the team cannot demonstrate control over the population.",
    fix:
      "Generate one entitlement report from the identity system with principal, role, scope, approver, grant date, review date, and data classification. Make the report queryable by role and by data store, and retain each export.",
    checkFirst: [
      "Which systems must be joined to answer the question?",
      "Is the report generated from the identity provider or assembled by hand?",
      "Does the export include the data scope, not only the role name?",
    ],
  },
  {
    id: "unattributable",
    metricId: "unattributable",
    warn: 5,
    crit: 20,
    title: "Shared accounts make actions unattributable",
    cause:
      "An account used by several people cannot prove which person performed an action. The audit log records the account, not the human, and the access review cannot remove one person without disrupting the others.",
    fix:
      "Replace shared accounts with named identities and role assumption. Rotate the shared credential, add break-glass approval for emergencies, and verify that every production action maps to one principal.",
    checkFirst: [
      "Which accounts are used by more than one person?",
      "Do the audit logs show a person or only a service account?",
      "Is there an approved break-glass path for emergency access?",
    ],
  },
];

export const accessControlsModel: SimModel = {
  id: "compliance-access-controls",
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
    if (values.findingRate >= 50 && frame.flags.findingEvent !== 1) {
      pushEvent(next, {
        id: "access-findings",
        at: frame.t,
        severity: "crit",
        title: "At least half of production roles have access findings",
        detail: `${values.findingRate.toFixed(0)}% of roles have at least one finding. The population cannot be defended without a current review and an owner.`,
        nodeId: "role",
        metricId: "finding-rate",
      });
      next.flags.findingEvent = 1;
    }
    if (values.findingRate < 50) next.flags.findingEvent = 0;
    if (values.timeToAnswer >= 45 && frame.flags.answerEvent !== 1) {
      pushEvent(next, {
        id: "access-evidence-slow",
        at: frame.t,
        severity: "crit",
        title: "An access query takes too long to answer",
        detail: `Reconstructing who can read production data takes ${values.timeToAnswer.toFixed(0)} minutes. The evidence is not available when the auditor asks.`,
        nodeId: "review",
        metricId: "time-to-answer",
      });
      next.flags.answerEvent = 1;
    }
    if (values.timeToAnswer < 45) next.flags.answerEvent = 0;
    if (values.shared >= 20 && frame.flags.sharedEvent !== 1) {
      pushEvent(next, {
        id: "shared-account-access",
        at: frame.t,
        severity: "crit",
        title: "Shared accounts prevent attribution",
        detail: `${values.shared.toFixed(0)}% of production access uses a shared account. The audit record cannot identify the person behind the action.`,
        nodeId: "identity",
        metricId: "unattributable",
      });
      next.flags.sharedEvent = 1;
    }
    if (values.shared < 20) next.flags.sharedEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = `${values.findingRate.toFixed(0)}% of roles have access findings; an auditor query takes ${values.timeToAnswer.toFixed(0)} minutes; ${values.unattributable.toFixed(0)}% of access goes through shared accounts.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The finding rate is ${values.findingRate.toFixed(0)}%. It combines review coverage, ownership, shared accounts, standing admin, and conflicting duties, because an auditor tests the population rather than one role at a time.`,
      `An access query takes ${values.timeToAnswer.toFixed(0)} minutes. That number is a design property: it measures how many systems must be joined to reconstruct who can read production data.`,
      `${values.unattributable.toFixed(0)}% of access uses a shared account. A shared credential turns a who-did-it question into an account-did-it question, and the access review cannot cleanly remove one person.`,
      `Standing admin is ${values.standing.toFixed(0)}% and separation-of-duties conflicts are ${values.sod.toFixed(0)}%. Just-in-time access and split approvals shrink both without removing the ability to operate.`,
    ];
  },
  legend: [
    { label: "Evidenced", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Unattributable", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "No standing admin, full owner and review coverage, no shared accounts or conflicting duties.",
    tone: "ok",
    params: defaults({ standingAdmin: 0, reviewCoverage: 100, ownerCoverage: 100, sharedAccounts: 0, sodConflicts: 0 }),
  },
  {
    id: "peak",
    label: "Review backlog",
    description: "A fifth of admin access is standing, 10% of roles missed review, and 5% of access is shared.",
    tone: "warn",
    params: defaults({ standingAdmin: 20, reviewCoverage: 90, ownerCoverage: 95, sharedAccounts: 5, sodConflicts: 10 }),
  },
  {
    id: "failure",
    label: "No defensible story",
    description: "All admin access is standing, no role is reviewed or owned, and every action uses a shared account.",
    tone: "crit",
    params: defaults({ standingAdmin: 100, reviewCoverage: 0, ownerCoverage: 0, sharedAccounts: 100, sodConflicts: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Access is just in time, every role has an owner and a current review, and all actions map to a named identity.",
    tone: "ok",
    params: defaults({ standingAdmin: 0, reviewCoverage: 100, ownerCoverage: 100, sharedAccounts: 0, sodConflicts: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-access-answer",
  title: "Predict whether an inventory is enough",
  simId: "access-controls",
  question:
    "The team has a role inventory with owners, but no review records and 40% of production access goes through shared accounts. Can they answer the auditor in minutes?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. The inventory lists every role and owner" },
      { id: "no", label: "No. Ownership without review and attribution is not evidence of who can read production data" },
      { id: "iam", label: "Yes, but only if the auditor accepts an identity console screenshot" },
      { id: "shared", label: "Yes, because shared accounts reduce the number of identities to review" },
    ],
    correctOptionId: "no",
    explanation:
      "An inventory answers what roles exist. The auditor asks who holds them, who approved the access, whether it is still needed, and which person performed an action. Without review records, the inventory is unverified; without named identities, the shared-account population cannot be attributed or safely removed.",
  },
  setup: defaults({ standingAdmin: 40, reviewCoverage: 0, ownerCoverage: 100, sharedAccounts: 40, sodConflicts: 20 }),
  runFor: 20,
  observe: [
    "Every role has a finding because none was reviewed in the current period.",
    "The access query takes 66 minutes, crossing the critical threshold.",
    "Forty percent of access is unattributable, so an action cannot be tied to a person.",
    "The role, review, and identity nodes fail while the ownership field remains at 100%.",
  ],
  explain:
    "Access evidence is a chain: a named identity holds a role, an owner approved it, a reviewer confirmed it is still needed, and the system can show the grant and the review date. An inventory covers one link. Shared accounts break the first link, missing reviews break the last, and the auditor's question cannot be answered from a partial chain. The fix is to generate the chain from the identity system and make the review a recurring control, not a one-time cleanup.",
  fix: defaults({ standingAdmin: 0, reviewCoverage: 100, ownerCoverage: 100, sharedAccounts: 0, sodConflicts: 0 }),
  debrief:
    "With named identities, owners, current reviews, and just-in-time admin, the same access question resolves in two minutes from one export. The team can show who holds the role, who approved it, when it was last reviewed, and what data it reaches. This is engineering education, not legal advice; the specific access-control requirements and audit expectations depend on the framework, contract, and facts.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Access control is the set of decisions that determine which identity can perform which action on which resource. Least privilege means granting the smallest scope that still does the job. Separation of duties means no single identity can both request and approve a sensitive action. Review means an owner periodically confirms that each grant is still needed. Evidence is the dated export that shows all of this happened.",
  },
  {
    type: "p",
    text: "These are different controls with different failure modes. Least privilege limits what a compromised identity can do. Separation of duties limits what an insider can do alone. Review removes access that has outlived its purpose. Evidence lets someone outside the team verify the population without trusting a screenshot. A team can be strong in one and weak in another.",
  },
  {
    type: "p",
    text: "The auditor's question, who can read production data, is a population query. It needs a named principal, the role and scope, the approver, the grant date, and the last review decision. If the answer requires joining an IAM console, a ticketing system, a spreadsheet, and three screenshots, the team does not have operational evidence even if every individual grant was once approved.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Access control sits between the identity provider and the data. The identity provider authenticates a person; the role binding grants a scope; the approval records why; the review records whether it is still needed; the audit log records what happened. A break anywhere in that chain weakens the story. Shared accounts break the identity link. Standing admin breaks the approval link. Orphaned roles break the review link.",
  },
  {
    type: "table",
    headers: ["Question", "Artifact", "Common failure"],
    rows: [
      ["Who is this?", "Named identity, federation, MFA", "Shared account or generic service login"],
      ["What can they do?", "Role and scope binding", "Wildcard admin or inherited broad role"],
      ["Who approved it?", "Ticket, owner, expiry", "Standing grant with no expiry"],
      ["Is it still needed?", "Dated review decision", "Review skipped or rubber-stamped"],
      ["What did they do?", "Attributable audit event", "Account-level log with no person"],
    ],
  },
  {
    type: "p",
    text: "The model uses illustrative percentages. Its central measure is the finding rate across the role population, plus the time to answer an access query. The time metric matters because an auditor does not wait while you join four systems by hand. The shared-account metric matters because it makes every other control harder to prove.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Roles with access findings: the share of the population with at least one control gap.",
      "Time to answer an access query: how long it takes to reconstruct who can read production data.",
      "Access through shared accounts: the share that cannot be attributed to a person.",
      "Separation-of-duties conflicts: identities that can both request and approve a sensitive action.",
      "Node states: identity, request, approval, role, data, and review show where the chain broke.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Review backlog. Watch the finding rate rise before the query time becomes critical. Apply No defensible story to see every link fail. Run the experiment before revealing the explanation, then apply Recovery and compare the same role population with current reviews and named identities.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The access-control requirements that apply to you depend on the framework, the contract, and the data. Use this module to build evidence that matches your obligations, then confirm the obligations with your security and compliance owners.",
  },
  { type: "sim", simId: "access-controls" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The role inventory was complete enough to name owners, but it could not answer the auditor's question. No role had a current review, so every role carried a finding, and shared accounts made 40% of access unattributable. The query time rose to 66 minutes because the evidence had to be reconstructed by hand. The ownership field stayed at 100%, which is the trap: a single green metric hid the broken chain.",
  },
  {
    type: "p",
    text: "Restoring named identities, reviews, and just-in-time access reduced the finding rate to zero and the query time to two minutes from the same system of record. The role population did not shrink; the evidence became current and attributable.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Identity provider exports with principal, role, scope, and last authentication.",
      "Approval tickets linked to the role binding, with an expiry or review date.",
      "Review campaigns with per-role decisions, not a single sign-off.",
      "Audit events that name a person, not only an account or service.",
      "Access query time measured from the tool the auditor would actually use.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "Run the auditor's query yourself: who can read production data, by role and data scope?",
      "Find the roles with no owner or no review in the current period.",
      "List every shared account and who uses it.",
      "Check whether standing admin can be replaced by just-in-time access.",
      "Look for identities that can both request and approve a sensitive change.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Generate one entitlement export from the identity system, including scope and data classification.",
      "Assign an owner to every role and add an expiry to temporary grants.",
      "Replace shared accounts with named identities and role assumption.",
      "Move standing admin to just-in-time approval with a break-glass path.",
      "Split conflicting duties so one identity cannot request and approve the same action.",
      "Run the review on a schedule and keep each dated export.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Just-in-time access reduces standing privilege and adds approval latency during incidents; a rehearsed break-glass path keeps response fast.",
      "More roles improve least privilege and increase review work; fewer, broader roles are easier to manage and harder to defend.",
      "Quarterly reviews create current evidence and consume owner time; continuous review is more current and needs better automation.",
      "Removing shared accounts improves attribution and may require new tooling or per-person credentials for legacy systems.",
      "A single entitlement report is easier to audit and becomes a critical dependency; keep its source and refresh time visible.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "answer-in-minutes",
    question:
      "An auditor asks who can read production data. How do you answer in minutes?",
    difficulty: 2,
    hints: [
      "The answer is a population query, not a screenshot.",
      "The identity system should be the source of truth.",
    ],
    answer:
      "I would run a query against the identity and entitlement system that returns every principal with a role that grants read access to the production data scope, along with the role, approver, grant date, and last review. If the data scope is not in the identity model, I would join it from the resource inventory rather than rebuilding it by hand. I would also state the refresh time and any systems not covered, because an incomplete answer presented as complete is worse than a known gap. If the query takes hours, that is the finding to fix.",
    followUps: [
      "What if the access is granted through a group nested several levels deep?",
      "How do you cover access through a vendor or support tool?",
      "What do you do when a system has no API for entitlements?",
    ],
    redFlags: [
      "Searches for old screenshots.",
      "Lists role names without principals or scope.",
      "Claims completeness without checking coverage.",
    ],
    rubric: [
      "Uses a population query.",
      "Includes principal, role, scope, and review.",
      "States coverage and freshness.",
      "Treats slow evidence as a finding.",
    ],
  },
  {
    id: "sod-review",
    question:
      "How do you design a review that catches standing admin and separation-of-duties problems without rubber-stamping?",
    difficulty: 3,
    hints: [
      "A review needs a decision, not a reminder.",
      "Make the reviewer see the risk, not only the role name.",
    ],
    answer:
      "I would give each owner a review packet that shows the principal, the role, the data scope, the last time the access was used, the approval, and any conflicting role held by the same identity. The decision should be keep, reduce, or remove, with a date and a reason. I would sample the reviews for evidence of actual judgment and compare the decisions with usage data. Standing admin should appear as a distinct queue with an expiry, not be mixed into a generic role list. The review cadence should match the risk, and the export should be retained.",
    followUps: [
      "How do you review service accounts that have no human owner?",
      "What usage signal would make you remove access?",
      "How do you handle a role that is needed only during incidents?",
    ],
    redFlags: [
      "Sends a spreadsheet and counts replies.",
      "Reviews role names without principals or usage.",
      "Lets owners approve their own access.",
    ],
    rubric: [
      "Shows scope, usage, and conflicts.",
      "Requires an explicit decision.",
      "Separates standing admin.",
      "Samples for real judgment.",
    ],
  },
  {
    id: "shared-accounts",
    question:
      "A legacy system only supports a shared login. How do you reduce the access-control risk?",
    difficulty: 3,
    hints: [
      "You may not be able to remove the shared credential immediately.",
      "Compensating controls need to make attribution possible.",
    ],
    answer:
      "I would treat the shared credential as a known exception with an owner and an expiry, not as normal access. I would put it behind a privileged access manager or a jump host that authenticates the person first, record the session, and require approval for use. I would rotate the credential, restrict who can retrieve it, and alert on use outside the approved window. Then I would plan a replacement or isolation of the legacy system. The goal is to restore attribution and reduce the population that can use the shared login, even before the system is replaced.",
    followUps: [
      "What evidence would you keep for a session on the shared account?",
      "How do you handle a vendor that also uses the shared login?",
      "When would you accept the exception permanently?",
    ],
    redFlags: [
      "Accepts the shared login as unavoidable.",
      "Adds a password vault without session attribution.",
      "Has no owner or expiry for the exception.",
    ],
    rubric: [
      "Treats it as a time-bound exception.",
      "Adds person-level authentication and session recording.",
      "Restricts and rotates the credential.",
      "Plans a permanent removal.",
    ],
  },
];

const checklist = [
  {
    title: "Before the audit",
    items: [
      "Generate the entitlement report from the identity system and include data scope.",
      "Assign an owner and a review date to every role.",
      "List shared accounts, standing admin, and conflicting duties.",
      "Measure how long the auditor's query actually takes.",
    ],
  },
  {
    title: "During the review",
    items: [
      "Review principals and scope, not only role names.",
      "Show usage and last authentication for each grant.",
      "Record keep, reduce, or remove with a date and reason.",
      "Escalate roles with no owner or no reviewer.",
    ],
  },
  {
    title: "After the review",
    items: [
      "Remove access that was not renewed.",
      "Replace shared accounts with named identities.",
      "Move standing admin to just-in-time approval.",
      "Keep the dated export and re-test the query.",
    ],
  },
];

const references = [
  {
    title: "Security and Privacy Controls for Information Systems and Organizations (NIST SP 800-53 Rev. 5)",
    url: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "The access control family, including least privilege, separation of duties, and review.",
  },
  {
    title: "Assessing Security and Privacy Controls in Information Systems and Organizations (NIST SP 800-53A Rev. 5)",
    url: "https://csrc.nist.gov/pubs/sp/800/53/a/r5/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Assessment procedures and the evidence an assessor expects.",
  },
  {
    title: "AWS Identity and Access Management best practices",
    url: "https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Practical guidance on least privilege, roles, and avoiding shared credentials.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "access-controls": {
      model: accessControlsModel,
      presets,
      instructions:
        "Start Healthy, then apply Review backlog. Watch the finding rate and the query time separately. Apply No defensible story to fail every link, run the experiment, then apply Recovery and confirm the same population is now attributable and reviewed.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Coverage percentages and query times are teaching values, not an audit standard or a provider guarantee.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-least-privilege", "compliance-audit-logs", "compliance-hipaa"],
};
