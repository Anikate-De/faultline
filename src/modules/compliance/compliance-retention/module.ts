import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "holdActive",
    label: "Legal hold active (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Hold",
    help: "Whether counsel has issued a preservation hold. A hold suspends deletion for the records in scope; it does not decide what the law requires.",
    format: "count" as const,
  },
  {
    id: "holdCoverage",
    label: "Stores honoring the hold",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Hold",
    help: "Share of stores that apply the hold: primary tables, search indexes, caches, exports, and backup restore paths. A hold that reaches only the primary database leaves copies deletable.",
    format: "percent" as const,
  },
  {
    id: "scheduleCoverage",
    label: "Data classes with an enforced schedule",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Retention",
    help: "Share of data classes with an approved retention period and an automated deletion job. A schedule that exists only in a policy is not enforced.",
    format: "percent" as const,
  },
  {
    id: "verification",
    label: "Deletion and preservation verified",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Evidence",
    help: "Share of jobs whose results are verified against every copy, including replicas, indexes, and backups. A deletion report from the primary alone is not proof.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  holdActive: boolean;
  holdCoverage: number;
  schedules: number;
  verification: number;
  holdGap: number;
  scheduleGap: number;
  verificationGap: number;
  preservation: number;
}

function compute(p: Params): Computed {
  const holdActive = num(p, "holdActive", 0) >= 0.5;
  const holdCoverage = clamp(num(p, "holdCoverage", 100), 0, 100);
  const schedules = clamp(num(p, "scheduleCoverage", 100), 0, 100);
  const verification = clamp(num(p, "verification", 100), 0, 100);
  return {
    holdActive,
    holdCoverage,
    schedules,
    verification,
    holdGap: holdActive ? 100 - holdCoverage : 0,
    scheduleGap: 100 - schedules,
    verificationGap: 100 - verification,
    preservation: holdActive ? holdCoverage : 100,
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
  const holdHealth = healthFor(values.holdGap, 1, 25);
  const primaryHealth = healthFor(Math.max(values.holdGap, values.verificationGap), 10, 25);
  const holdLabel = values.holdActive
    ? `${values.holdCoverage.toFixed(0)}% of stores preserve held data`
    : "no active hold";
  return {
    t: 0,
    nodes: [
      {
        id: "register",
        label: "Legal hold register",
        kind: "storage",
        health: holdHealth,
        utilization: values.holdGap / 100,
        sublabel: values.holdActive ? `hold active · ${values.holdCoverage.toFixed(0)}% honored` : "no active hold",
        detail: "The scope of the hold, the records covered, the custodian, and the date. The register is the source of truth the deletion job must consult.",
      },
      {
        id: "job",
        label: "Retention job",
        kind: "service",
        health: healthFor(values.scheduleGap, 15, 40),
        utilization: values.scheduleGap / 100,
        sublabel: `${values.schedules.toFixed(0)}% of data classes enforced`,
        detail: "Deletes records when their approved period ends. It must check the hold register before every destructive action and record the decision.",
      },
      {
        id: "primary",
        label: "Primary database",
        kind: "db",
        health: primaryHealth,
        utilization: Math.max(values.holdGap, values.verificationGap) / 100,
        sublabel: holdLabel,
        detail: "The main store. Deletion here is visible and usually the first thing an operator checks, which makes it the least likely place to find a preservation gap.",
      },
      {
        id: "index",
        label: "Search index",
        kind: "storage",
        health: holdHealth,
        utilization: values.holdGap / 100,
        sublabel: values.holdActive ? `${values.holdCoverage.toFixed(0)}% of stores honor the hold` : "no active hold",
        detail: "A derived copy that often has its own deletion pipeline. A hold that only blocks the primary leaves the index searchable and deletable.",
      },
      {
        id: "backups",
        label: "Backups",
        kind: "storage",
        health: holdHealth,
        utilization: values.holdGap / 100,
        sublabel: values.holdActive ? `${values.holdCoverage.toFixed(0)}% of stores honor the hold` : "no active hold",
        detail: "Backups expire on their own schedule. A hold has to prevent expiry or ensure a preserved copy exists before the backup rotates away.",
      },
      {
        id: "archive",
        label: "Audit archive",
        kind: "storage",
        health: healthFor(values.verificationGap, 10, 30),
        utilization: values.verificationGap / 100,
        sublabel: `${values.verification.toFixed(0)}% of actions verified`,
        detail: "The immutable record of deletions, holds, and preservation actions. Without it, the team cannot show what was deleted or what remains.",
      },
    ],
    edges: [
      edge("register-job", "register", "job", clamp(values.preservation / 100), holdHealth),
      edge("job-primary", "job", "primary", clamp(values.schedules / 100), healthFor(values.scheduleGap, 15, 40)),
      edge("primary-index", "primary", "index", clamp(values.preservation / 100), holdHealth),
      edge("primary-backups", "primary", "backups", clamp(values.preservation / 100), holdHealth),
      edge("primary-archive", "primary", "archive", clamp(values.verification / 100), healthFor(values.verificationGap, 10, 30)),
    ],
    metrics: [
      metric("hold-gap", "Held data not preserved", values.holdGap, "%", 1, 25, "percent"),
      metric("schedule-gap", "Data classes without enforced retention", values.scheduleGap, "%", 15, 40, "percent"),
      metric("verification-gap", "Actions without verified evidence", values.verificationGap, "%", 10, 30, "percent"),
      metric("preservation-coverage", "Preservation coverage", values.preservation, "%", undefined, undefined, "percent"),
      metric("retention-coverage", "Enforced retention coverage", values.schedules, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: values.holdActive
      ? `A legal hold is active and ${values.holdGap.toFixed(0)}% of held data is not covered by it; ${values.verificationGap.toFixed(0)}% of actions lack verified evidence.`
      : `No legal hold is active; ${values.scheduleGap.toFixed(0)}% of data classes lack enforced retention and ${values.verificationGap.toFixed(0)}% of actions lack verified evidence.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hold-gap",
    metricId: "hold-gap",
    warn: 1,
    crit: 25,
    title: "A legal hold is not honored across every copy",
    cause:
      "A hold is only effective if every system that can delete the covered records consults it. Primary databases, search indexes, caches, exports, and backup expiry each have their own deletion path. A hold applied to one path leaves the others free to destroy evidence, and the damage is invisible until someone tries to restore it.",
    fix:
      "Propagate the hold from one register to every deletion job and retention policy, including derived stores and backup expiry. Block destructive actions unless the job proves a hold check. Preserve a copy before rotating backups, verify that it can be read, and record the verification in the audit archive.",
    checkFirst: [
      "Which deletion paths can touch the held records?",
      "Does the hold block both the primary store and every derived copy?",
      "Will a backup expire or rotate before the hold is released?",
    ],
  },
  {
    id: "schedule-gap",
    metricId: "schedule-gap",
    warn: 15,
    crit: 40,
    title: "Retention is a policy, not an enforced schedule",
    cause:
      "A data class without an enforced schedule either keeps data too long or deletes it unpredictably. Both are failures: long retention expands the exposure and discovery surface, while manual deletion destroys records without a record of why. A schedule that the job does not implement is a statement of intent.",
    fix:
      "Assign an approved period and a deletion method to each data class. Encode both in the job, dry-run the selection, and record the count and identifiers before deleting. Require an exception path for holds, and verify that the deletion actually reached every copy.",
    checkFirst: [
      "Which data classes have no approved period?",
      "Does the job act on the period or on an ad hoc request?",
      "Can a record be deleted without an audit entry?",
    ],
  },
  {
    id: "verification-gap",
    metricId: "verification-gap",
    warn: 10,
    crit: 30,
    title: "Deletion and preservation actions lack evidence",
    cause:
      "A job that reports success from the primary store has not proved that replicas, indexes, caches, and backups changed. Preservation has the same problem: copying records is not proof that the copy is complete or readable. Without a verified record, the team cannot answer what was deleted, what was preserved, or when.",
    fix:
      "Verify against each copy, not only the primary. Record the scope, the identifiers or a count, the time, the operator or job, and the result. Test a restore of preserved records. Keep the evidence in a store that the deletion job cannot modify.",
    checkFirst: [
      "Which copies are excluded from the verification?",
      "Can the team restore a preserved record and read it?",
      "Is the evidence store writable by the deletion job?",
    ],
  },
];

export const retentionModel: SimModel = {
  id: "compliance-retention",
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
    if (values.holdGap >= 25 && frame.flags.holdEvent !== 1) {
      pushEvent(next, {
        id: "hold-not-honored",
        at: frame.t,
        severity: "crit",
        title: "A legal hold is not honored across every copy",
        detail: `A hold is active and ${values.holdGap.toFixed(0)}% of held data is not covered. ${values.verificationGap.toFixed(0)}% of actions lack verified evidence. Derived stores and backups can still delete the records.`,
        nodeId: "index",
        metricId: "hold-gap",
      });
      next.flags.holdEvent = 1;
    }
    if (values.holdGap < 25) next.flags.holdEvent = 0;
    next.flags.paramsKey = JSON.stringify(p);
    next.summary = values.holdActive
      ? `A legal hold is active and ${values.holdGap.toFixed(0)}% of held data is not covered by it; ${values.verificationGap.toFixed(0)}% of actions lack verified evidence.`
      : `No legal hold is active; ${values.scheduleGap.toFixed(0)}% of data classes lack enforced retention and ${values.verificationGap.toFixed(0)}% of actions lack verified evidence.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      values.holdActive
        ? `The hold covers ${values.holdCoverage.toFixed(0)}% of stores. A hold that misses an index, cache, export, or backup has not preserved the records.`
        : "No hold is active. The retention schedule is the only thing deciding when data disappears, so its enforcement and verification matter on their own.",
      `Retention coverage is ${values.schedules.toFixed(0)}%. A data class without an enforced period is either kept too long or deleted on an ad hoc request.`,
      `Verification covers ${values.verification.toFixed(0)}% of actions. A success report from the primary does not prove that replicas, indexes, and backups changed or that a preserved copy is readable.`,
      `The preservation coverage is ${values.preservation.toFixed(0)}%. The number is conditional on a hold: without one, preservation is not the active obligation.`,
      "A hold suspends deletion for the records in scope. It does not decide when a hold is required, how long it lasts, or what may be released; those are legal decisions for counsel.",
    ];
  },
  legend: [
    { label: "Preserved", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Deletable", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "No hold is active, every data class has an enforced period, and deletion is verified across copies.",
    tone: "ok",
    params: defaults({ holdActive: 0, holdCoverage: 100, scheduleCoverage: 100, verification: 100 }),
  },
  {
    id: "peak",
    label: "Hold arrives",
    description: "A hold is active and most stores honor it, but one in seven copies is uncovered and verification lags.",
    tone: "warn",
    params: defaults({ holdActive: 1, holdCoverage: 85, scheduleCoverage: 90, verification: 80 }),
  },
  {
    id: "failure",
    label: "Hold missed",
    description: "A hold arrives during deletion. The primary job stops, but the search index and backups keep expiring and preservation is unverified.",
    tone: "crit",
    params: defaults({ holdActive: 1, holdCoverage: 20, scheduleCoverage: 100, verification: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The hold is applied to every store, backup expiry is suspended, preservation is verified, and the evidence is archived.",
    tone: "ok",
    params: defaults({ holdActive: 1, holdCoverage: 100, scheduleCoverage: 100, verification: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-hold-scope",
  title: "Predict whether stopping the primary job preserves the evidence",
  simId: "retention",
  question:
    "A legal hold arrives two hours after the nightly retention job starts. The primary database still has the records, but the search index was rebuilt without them and the oldest backup is about to expire. Is stopping the primary deletion job enough?",
  prediction: {
    options: [
      { id: "enough", label: "Yes. The primary database is the system of record" },
      { id: "all-copies", label: "No. The hold must suspend deletion and expiry across every copy, and preservation must be verified" },
      { id: "backup", label: "Yes, if a backup from last month still exists" },
      { id: "policy", label: "No, but only because the retention policy needs a new signature" },
    ],
    correctOptionId: "all-copies",
    explanation:
      "The obligation is to preserve the records, not to stop one job. Every system that can delete or lose them has to honor the hold: the primary, derived indexes, caches, exports, and backup expiry. A backup that is about to rotate away is a deletion path. Preservation also needs verification, because a copy that cannot be restored is not evidence.",
  },
  setup: defaults({ holdActive: 1, holdCoverage: 20, scheduleCoverage: 100, verification: 40 }),
  runFor: 20,
  observe: [
    "Held data not preserved jumps to 80% and crosses the critical threshold.",
    "The search index and backups fail even though the retention schedule is fully enforced.",
    "The primary database is partially protected, which is exactly the false reassurance in the scenario.",
    "Raising hold coverage and verification, not changing the schedule, clears the incident.",
  ],
  explain:
    "The bug is a narrow hold check. The deletion job knows about the primary table but not about the derived index or the backup lifecycle. A hold has to be a shared control that every destructive path consults, and the preservation action needs its own evidence: which records, which copies, when, and whether a restore succeeds. Stopping one job is an incident response step, not a preservation program.",
  fix: defaults({ holdActive: 1, holdCoverage: 100, scheduleCoverage: 100, verification: 100 }),
  debrief:
    "With the hold propagated to every store and preservation verified, the records are protected and the evidence is defensible. The schedule stayed at 100% throughout, which shows why retention enforcement alone is not enough: a correct schedule still deletes when a hold is missed. This module is engineering education, not legal advice. Whether a hold applies, what it covers, and when it can be released are decisions for counsel.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Retention is the rule that decides how long a class of data is kept and how it is deleted. A legal hold is a separate instruction that suspends deletion for specific records because they may be needed in a dispute or investigation. The two systems interact: the retention job deletes on a schedule, and the hold has to stop it for the covered records without stopping it for everything else.",
  },
  {
    type: "p",
    text: "For engineers, retention is a distributed systems problem. The primary database is one copy. Search indexes, caches, analytics tables, exports, and backups are others, and each may have its own deletion path. A hold that reaches only the primary leaves the derived copies free to disappear. A deletion job that reports success from the primary has not proved that the other copies changed.",
  },
  {
    type: "p",
    text: "The evidence layer is part of the control. A defensible program can answer what was deleted, what was preserved, when, by which job or person, and how the result was verified. A hold register without a preservation record is a claim. A deletion report without an audit entry is unverifiable.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Retention sits below classification and above storage lifecycle. The classification label decides which period applies. The retention job and storage lifecycle rules enforce it. The hold register sits beside the job as an override that every destructive path must consult. Audit records close the loop by recording the decision and the result.",
  },
  {
    type: "table",
    headers: ["Control", "Trigger", "Effect", "Evidence"],
    rows: [
      ["Retention schedule", "Approved period for a data class", "Deletes data when the period ends", "Selection, deletion record, verification"],
      ["Legal hold", "Instruction from counsel", "Suspends deletion for covered records", "Hold scope, propagation, preserved copy"],
      ["Backup expiry", "Lifecycle policy", "Removes old copies automatically", "Expiry rule, suspension, restore test"],
      ["Audit record", "Every deletion or hold action", "Makes the action attributable", "Actor, time, scope, result"],
    ],
  },
  {
    type: "p",
    text: "The interaction is where incidents happen. A hold arrives while a job is running. The job has already selected its batch. The primary stops, but the index rebuild and the backup expiry do not. The team believes the data is preserved because the main job is paused. Weeks later, the copy that would have been produced is gone.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Held data not preserved: the share of held records that a deletion path can still reach. It is zero when no hold is active.",
      "Data classes without enforced retention: the share of schedules that exist only in policy.",
      "Actions without verified evidence: deletion or preservation actions that were not checked across copies.",
      "Preservation coverage: the share of stores that honor an active hold.",
      "Node states: hold register, retention job, primary database, search index, backups, and audit archive.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Hold arrives and compare the primary database with the index and backups. Apply Hold missed and watch the hold gap go critical while the retention schedule stays fully enforced. Run the experiment before revealing the explanation, then apply Recovery and confirm that preservation coverage and verification, not the schedule, close the incident.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Scope",
    body: "This is engineering education, not legal advice. The values, periods, and thresholds are illustrative. Whether a hold applies, which records it covers, and when it may be released are legal decisions. Work with counsel and your records management owner.",
  },
  { type: "sim", simId: "retention" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The hold was active, the retention schedule was fully enforced, and the primary job stopped. None of that preserved the records. Hold coverage was 20%, so the search index and backups still had deletion paths. Preservation verification was 40%, so the team could not show which copies survived or whether they could be read. The hold gap crossed critical at 80%.",
  },
  {
    type: "p",
    text: "Raising hold coverage and verification cleared the incident without changing the schedule. The schedule was never the problem. The problem was that the hold was treated as a property of one job instead of a shared control that every destructive path consults.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Hold register: scope, custodian, start date, covered systems, and release status.",
      "Deletion jobs: a hold check before every destructive action, with the decision recorded.",
      "Derived stores: index rebuilds, cache eviction, and analytics jobs that can drop held records.",
      "Backups: expiry suspended, or a preserved copy created before rotation.",
      "Verification: a restore test that proves the preserved records are complete and readable.",
    ],
  },
  {
    type: "checklist",
    title: "What to check first",
    items: [
      "List every deletion path that can reach the held records, including indexes and backups.",
      "Check whether the hold is enforced by policy at the storage layer or only by the application job.",
      "Confirm backup expiry is suspended or a preserved copy exists.",
      "Test a restore of the preserved records and read a sample.",
      "Check that the audit archive is not writable by the deletion job.",
    ],
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop destructive jobs that can reach the covered records.",
      "Broadcast the hold to every store, index, cache, export, and backup lifecycle.",
      "Preserve a verified copy before any expiry or rotation completes.",
      "Record the scope, identifiers, time, operator, and result in the audit archive.",
      "Test a restore and keep the test result with the hold record.",
      "Review the hold periodically and release it only through the approved process.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer retention supports investigations and disputes and increases storage cost and exposure.",
      "Shorter retention reduces exposure and can destroy records before a hold is issued.",
      "A global hold is easy to enforce and stops unrelated deletions; a scoped hold is precise and harder to propagate.",
      "Immutable archives improve evidence integrity and make correction or deletion harder.",
      "Automated verification is more trustworthy and costs engineering time; manual checks are cheaper and less frequent.",
      "Keeping derived copies improves performance and creates more places where deletion can outrun a hold.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "hold-propagation",
    question: "A legal hold arrives while a retention job is running. What do you do first?",
    difficulty: 3,
    hints: [
      "Preservation is the immediate goal.",
      "The primary database is not the only copy.",
    ],
    answer:
      "I would stop the deletion paths that can reach the covered records, then propagate the hold to every copy: primary, replicas, search indexes, caches, exports, and backup expiry. I would preserve a copy before any rotation completes and verify that it can be restored. Then I would record the scope, the time, the operator, and the result. The retention job is only one actor; the derived stores and backup lifecycle are deletion paths too.",
    followUps: [
      "How do you avoid stopping deletion for unrelated data?",
      "What if the hold scope is ambiguous?",
      "Who confirms that the hold can be released?",
    ],
    redFlags: [
      "Stops only the primary job.",
      "Assumes a backup is safe without checking expiry.",
      "Releases the hold without counsel.",
    ],
    rubric: [
      "Stops all destructive paths.",
      "Propagates to derived stores and backups.",
      "Verifies preservation.",
      "Records evidence and defers release.",
    ],
  },
  {
    id: "retention-enforcement",
    question: "How do you make a retention schedule enforceable rather than aspirational?",
    difficulty: 2,
    hints: [
      "A schedule needs a period, a selection rule, and a deletion method.",
      "The job has to produce evidence.",
    ],
    answer:
      "I would encode the period, the selection rule, and the deletion method per data class, then run the job on a schedule with a dry-run mode. Each run records what it selected and what it deleted, and verification checks every copy. Exceptions go through the hold register, not through manual edits. If a class has no approved period, the job should not guess; it should leave the data in place and raise the gap.",
    followUps: [
      "What do you do with data that has no owner?",
      "How do you handle deletion from backups?",
      "How do you test the job without deleting production data?",
    ],
    redFlags: [
      "Deletes on an ad hoc request.",
      "Has no dry run or verification.",
      "Lets the job guess a period.",
    ],
    rubric: [
      "Encodes period and method.",
      "Uses dry runs and verification.",
      "Routes exceptions through holds.",
      "Produces evidence.",
    ],
  },
  {
    id: "preservation-evidence",
    question: "What evidence would you show that a preserved record is intact and usable?",
    difficulty: 3,
    hints: [
      "A copy is not evidence until it can be read.",
      "The evidence store must be outside the deletion path.",
    ],
    answer:
      "I would show the hold scope, the systems covered, the time preservation started, and a restore test that reads a sample of the preserved records and compares them with the expected content. I would also show that the copy is protected from modification and that the deletion job cannot write to the evidence store. A checksum or immutable storage record helps, but the key test is that the record can be restored and read by someone who is not the job that preserved it.",
    followUps: [
      "How often would you re-test the restore?",
      "What if the preserved format is obsolete?",
      "How do you prove the copy is complete?",
    ],
    redFlags: [
      "Shows a job success message as proof.",
      "Never tests a restore.",
      "Stores evidence where the job can edit it.",
    ],
    rubric: [
      "Defines scope and time.",
      "Tests a restore and reads the record.",
      "Protects integrity.",
      "Separates evidence from the deletion path.",
    ],
  },
];

const checklist = [
  {
    title: "Design",
    items: [
      "Assign an approved period and deletion method to each data class.",
      "Identify every copy and deletion path, including indexes, caches, exports, and backups.",
      "Make the hold register the shared control that every destructive action consults.",
      "Define who can issue, change, and release a hold.",
    ],
  },
  {
    title: "Operate",
    items: [
      "Dry-run the retention selection before the first destructive run.",
      "Record the scope, identifiers, time, operator, and result for each action.",
      "Suspend backup expiry or preserve a copy before rotation.",
      "Test a restore of preserved records and keep the result.",
    ],
  },
  {
    title: "Respond",
    items: [
      "Stop every deletion path that can reach the held records.",
      "Propagate the hold to derived stores and backup lifecycles.",
      "Verify preservation across copies, not only the primary.",
      "Release the hold only through the approved process and record the release.",
    ],
  },
];

const references = [
  {
    title: "NIST SP 800-53 Rev. 5 — Security and Privacy Controls",
    url: "https://csrc.nist.gov/pubs/sp/800/53/r5/upd1/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Control catalog including AU-11 audit record retention and SI-12 information management, which address retention and preservation.",
  },
  {
    title: "NARA Records Management",
    url: "https://www.archives.gov/records-mgmt",
    publisher: "U.S. National Archives and Records Administration",
    kind: "docs" as const,
    note: "Official federal records management guidance on scheduling, retention, and preservation of records.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    retention: {
      model: retentionModel,
      presets,
      instructions:
        "Start Healthy, then apply Hold arrives and Hold missed. Compare the primary database with the search index and backups, and watch the retention schedule stay high while the hold gap fails. Run the experiment before revealing the explanation, then apply Recovery and confirm preservation coverage and verification.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Periods, coverage percentages, and the 1/25 hold thresholds are teaching values. Legal hold scope and release are legal decisions; this model only shows how engineering enforces and evidences a hold.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["compliance-audit-logs", "compliance-data-classification", "compliance-audit-trails"],
};
