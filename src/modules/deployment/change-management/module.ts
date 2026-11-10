import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "weeklyChanges",
    label: "Changes per week",
    min: 10,
    max: 200,
    step: 10,
    value: 40,
    unit: " changes/week",
    group: "Volume",
    help: "Change requests arriving per week. Higher volume increases review queueing when capacity is fixed.",
    format: "number",
  },
  {
    id: "approvalSteps",
    label: "Approval steps",
    min: 1,
    max: 8,
    step: 1,
    value: 3,
    unit: " steps",
    group: "Approval",
    help: "Sequential approvals a change must collect. Each step adds wall-clock delay but does not by itself assess blast radius or reversibility.",
    format: "number",
  },
  {
    id: "reviewerCapacity",
    label: "Risk reviews per day",
    min: 5,
    max: 40,
    step: 5,
    value: 20,
    unit: " reviews/day",
    group: "Capacity",
    help: "Risk reviews the team can complete per day. This capacity covers blast radius, reversibility, observability, and ownership checks.",
    format: "number",
  },
  {
    id: "reviewCoverage",
    label: "Risk review coverage",
    min: 10,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Coverage",
    help: "Share of changes the process intends to screen for blast radius, reversibility, observability, and owner. Actual coverage falls when review capacity is short.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  weekly: number;
  approvals: number;
  capacity: number;
  coverage: number;
  arrival: number;
  queueDays: number;
  leadDays: number;
  effectiveCoverage: number;
  escaped: number;
  load: number;
}

function compute(p: Params): Values {
  const weekly = Math.max(1, num(p, "weeklyChanges", 40));
  const approvals = Math.max(1, num(p, "approvalSteps", 3));
  const capacity = Math.max(1, num(p, "reviewerCapacity", 20));
  const coverage = clamp(num(p, "reviewCoverage", 95), 0, 100);
  const arrival = weekly / 7;
  const load = arrival / capacity;
  const queueDays = Math.max(0.2, (load - 0.8) * 2.5);
  const leadDays = queueDays + approvals * 0.4 + 0.1;
  const capacityFactor = clamp(capacity / arrival, 0.5, 1);
  const effectiveCoverage = clamp(coverage * capacityFactor, 0, 100);
  const escaped = 100 - effectiveCoverage;
  return {
    weekly,
    approvals,
    capacity,
    coverage,
    arrival,
    queueDays,
    leadDays,
    effectiveCoverage,
    escaped,
    load,
  };
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function level(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, v: Values): SimFrame {
  const leadHealth = level(v.leadDays, 2, 5);
  const escapedHealth = level(v.escaped, 12, 25);
  const queueHealth = level(v.queueDays, 1, 3);
  const overall = worst(leadHealth, escapedHealth, queueHealth);

  const nodes = [
    {
      id: "request",
      label: "Change request",
      kind: "client" as const,
      health: "ok" as const,
      sublabel: `${Math.round(v.weekly)} changes/week · ${v.arrival.toFixed(1)} per day`,
      detail: "Requests enter with different risk. The review process decides which risk dimensions get checked, not how many people sign.",
      meta: { view: "flow" },
    },
    {
      id: "risk-review",
      label: "Risk review",
      kind: "service" as const,
      health: escapedHealth,
      utilization: clamp(v.load),
      sublabel: `${v.effectiveCoverage.toFixed(0)}% effective coverage · ${v.arrival.toFixed(1)}/day arrival`,
      detail: `Risk review checks blast radius, reversibility, observability, and ownership. Effective coverage is ${v.effectiveCoverage.toFixed(0)}% after capacity limits, so ${v.escaped.toFixed(0)}% of high-risk changes lack a review.`,
      meta: { view: "flow" },
    },
    {
      id: "approval-chain",
      label: "Approval chain",
      kind: "service" as const,
      health: leadHealth,
      utilization: clamp(v.approvals / 8),
      sublabel: `${v.approvals} sequential steps · ${(v.approvals * 0.4).toFixed(1)} days of waiting`,
      detail: `Each approval step adds about 0.4 illustrative days of waiting. The chain records agreement but does not measure whether the change is reversible or how far its blast radius reaches.`,
      meta: { view: "flow" },
    },
    {
      id: "production",
      label: "Production",
      kind: "service" as const,
      health: overall,
      sublabel: `lead ${v.leadDays.toFixed(1)} days · ${v.escaped.toFixed(0)}% high-risk unreviewed`,
      detail: "A fast approval chain can still release an unreviewed high-risk change. A slow chain can delay a low-risk change for days. Lead time and risk coverage are separate outcomes.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("request-review", "request", "risk-review", clamp(v.load), escapedHealth),
      edge("review-approval", "risk-review", "approval-chain", clamp(v.load), leadHealth),
      edge("approval-production", "approval-chain", "production", clamp(1 - v.escaped / 100), overall),
    ],
    metrics: [
      metric("lead-time", "Change lead time", v.leadDays, " days", 2, 5, "number"),
      metric("escaped-risk", "High-risk changes without review", v.escaped, "%", 12, 25, "percent"),
      metric("queue-age", "Review queue age", v.queueDays, " days", 1, 3, "number"),
      metric("effective-coverage", "Effective risk review coverage", v.effectiveCoverage, "%", undefined, undefined, "percent"),
      metric("approval-steps", "Approval steps", v.approvals, " steps", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      leadDays: v.leadDays,
      escaped: v.escaped,
      queueDays: v.queueDays,
      coverage: v.effectiveCoverage,
    },
    summary: `Lead ${v.leadDays.toFixed(1)} days · ${v.queueDays.toFixed(1)}-day review queue · ${v.escaped.toFixed(0)}% high-risk unreviewed · ${v.approvals} approvals`,
  };
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const jitter = (index: number) => 1 + 0.01 * Math.sin((index + (seed % 8)) / 2.5);
  const series: [string, number][] = [
    ["lead-time", v.leadDays],
    ["escaped-risk", v.escaped],
    ["queue-age", v.queueDays],
    ["effective-coverage", v.effectiveCoverage],
    ["approval-steps", v.approvals],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "escaped-risk",
    metricId: "escaped-risk",
    warn: 12,
    crit: 25,
    title: "High-risk changes are reaching production without review",
    cause:
      "Approval count is not risk coverage. If reviewers are overloaded or the review never checks blast radius, reversibility, observability, and ownership, a change can collect every signature and still be unsafe.",
    fix:
      "Review the risk dimensions explicitly, route high-risk changes to a capable reviewer, and track the share of high-risk changes with a rollback plan and named owner. Add capacity before adding signatures.",
    checkFirst: [
      "Check whether high-risk changes have a rollback plan and an owner.",
      "Check whether review capacity is below arrival rate.",
      "Check whether approvals are sequential or parallel and what each one checks.",
    ],
  },
  {
    id: "lead-time",
    metricId: "lead-time",
    warn: 2,
    crit: 5,
    title: "Change lead time is too long",
    cause:
      "Sequential approvals and a constrained review queue add days before a change reaches production. Long lead time increases batch size and makes rollback harder, which raises risk even when every signature was collected.",
    fix:
      "Remove approvals that do not assess risk, review in parallel where possible, and add review capacity for the queue. Measure lead time by stage so the constraint is visible.",
    checkFirst: [
      "Measure queue time separately from active review time.",
      "Count how many approval steps add information versus only signatures.",
      "Compare lead time for low-risk and high-risk changes.",
    ],
  },
  {
    id: "queue-age",
    metricId: "queue-age",
    warn: 1,
    crit: 3,
    title: "Changes are waiting in the review queue",
    cause:
      "Reviewer capacity is below the arrival rate, so work waits. Queue time grows faster than utilization and becomes the dominant part of lead time long before reviewers are fully busy.",
    fix:
      "Add review capacity, reduce the number of changes that need the same reviewer, or split fast-path review for low-risk changes from deep review for high-risk ones.",
    checkFirst: [
      "Compare reviews per day with changes per day.",
      "Check the age of the oldest waiting change.",
      "Check whether one reviewer or one team is the constraint.",
    ],
  },
];

const model: SimModel = {
  id: "deployment-change-management",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(defaults(), seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.flags.paramsKey = key;
    next.series = reset
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([id, series]) => [id, [...series]]));
    next.events = [...frame.events];
    if (reset) seedSeries(next, values, seed);
    const drift = 1 + rng.between(-0.001, 0.001) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "queue-age" ? { ...item, value: Math.max(0, item.value * drift) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `${v.approvals} sequential approvals add about ${(v.approvals * 0.4).toFixed(1)} days of waiting. The chain does not change how much risk the review actually covers.`,
      `Risk review has ${Math.round(v.capacity)} reviews per day against ${v.arrival.toFixed(1)} changes per day. The queue is ${v.queueDays.toFixed(1)} days and lead time is ${v.leadDays.toFixed(1)} days.`,
      `Effective coverage is ${v.effectiveCoverage.toFixed(0)}%, so about ${v.escaped.toFixed(0)}% of high-risk changes lack a review of blast radius, reversibility, observability, or ownership.`,
    ];
    if (v.load > 1) {
      items.push("Review capacity is below arrival rate. Adding approvals will lengthen the queue; it will not clear the unreviewed risk.");
    } else {
      items.push("Capacity is adequate, so coverage is limited by what the review actually checks, not by queue pressure.");
    }
    items.push("A useful review asks four questions: how far can this break, how fast can we undo it, how will we know, and who owns it. Signature count answers none of them.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "40 changes/week, three approvals, 20 risk reviews/day, and 95% coverage.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "80 changes/week, five approvals, 14 reviews/day, and 85% coverage.",
    tone: "warn",
    params: defaults({ weeklyChanges: 80, approvalSteps: 5, reviewerCapacity: 14, reviewCoverage: 85 }),
  },
  {
    id: "failure",
    label: "Approval theater",
    description: "140 changes/week, six approvals, 10 reviews/day, and 20% coverage.",
    tone: "crit",
    params: defaults({ weeklyChanges: 140, approvalSteps: 6, reviewerCapacity: 10, reviewCoverage: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "60 changes/week, two approvals, 20 reviews/day, and 95% coverage.",
    tone: "ok",
    params: defaults({ weeklyChanges: 60, approvalSteps: 2, reviewerCapacity: 20, reviewCoverage: 95 }),
  },
  {
    id: "signatures",
    label: "More signatures",
    description: "Eight approvals over a 60-change week, with coverage left at 50%.",
    tone: "crit",
    params: defaults({ weeklyChanges: 60, approvalSteps: 8, reviewerCapacity: 30, reviewCoverage: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-approvals",
  title: "Predict what five more approvals change",
  simId: "change-review",
  question:
    "A team adds five approval steps to every change. Review coverage and reviewer capacity stay the same. What improves?",
  prediction: {
    options: [
      { id: "risk", label: "High-risk changes become much safer because more people signed" },
      { id: "lead", label: "Lead time grows and high-risk coverage stays the same" },
      { id: "throughput", label: "Change throughput rises because the process is more rigorous" },
      { id: "queue", label: "The review queue shrinks because approvals are parallel" },
    ],
    correctOptionId: "lead",
    explanation:
      "Approval steps add waiting time. They do not add review capacity and they do not check blast radius, reversibility, observability, or ownership unless the review is designed to do so. The escaped-risk share is unchanged while lead time grows.",
  },
  setup: defaults({ weeklyChanges: 60, approvalSteps: 8, reviewerCapacity: 30, reviewCoverage: 50 }),
  runFor: 20,
  observe: [
    "Lead time is 3.5 days, with 3.2 days spent in sequential approvals.",
    "Half of high-risk changes still lack a risk review.",
    "The review queue is short because capacity is ample; the problem is coverage, not queueing.",
    "Adding signatures did not change the escaped-risk share.",
  ],
  explain:
    "Approval count measures agreement, not risk. A useful review has to examine the four dimensions that predict harm: blast radius, reversibility, observability, and ownership. If those checks are missing, every additional signature is a delay without a control.",
  fix: defaults({ weeklyChanges: 60, approvalSteps: 2, reviewerCapacity: 20, reviewCoverage: 95 }),
  debrief:
    "The fixed process drops to two approvals and raises risk coverage to 95%. Lead time falls to 1.1 days and the unreviewed high-risk share falls to 5%. The tradeoff is that reviewers must be capable of judging the four dimensions and must have the authority to stop a change; a fast review with no authority is just a shorter queue.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Change management is the process that decides how a change is reviewed before it reaches production, and what evidence is kept afterward. It exists because some changes are riskier than others and because an organization needs a record of who approved what. The failure mode is measuring the process by the number of approvals instead of by the risk it actually catches.",
  },
  {
    type: "p",
    text: "Five signatures can coexist with an unreviewed migration, because each approver may be checking ownership or budget rather than blast radius. A single reviewer who asks how far the change reaches, how fast it can be undone, how the team will know it failed, and who owns the outcome is doing more risk control than a long signature chain. Approval count is a coordination cost; risk coverage is the control.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Change review sits between the change request and the deploy pipeline. It should feed the pipeline, not replace it: the pipeline enforces tests, artifact identity, and rollout mechanics, while review decides whether the change is understood well enough to attempt. The reviewer also needs a fast path for low-risk changes and a deeper path for changes with a large blast radius.",
  },
  {
    type: "table",
    headers: ["Review question", "What it catches", "What it does not catch"],
    rows: [
      ["Blast radius", "A change that reaches every tenant or region", "A small change with an unknown dependency"],
      ["Reversibility", "A migration or side effect that rollback cannot undo", "A reversible change that is still wrong"],
      ["Observability", "A change whose failure would be invisible", "A signal that exists but has no alert"],
      ["Ownership", "A change with no one to call at 3 a.m.", "A named owner who is unavailable"],
      ["Approval count", "Organizational agreement", "Any of the four risk dimensions"],
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative teaching values. The 0.4-day cost per approval, 30% high-risk share, capacity model, and thresholds are teaching choices, not industry constants. The shape is the lesson: approvals add latency, capacity constrains coverage, and unreviewed high-risk changes are the risk that matters.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Change lead time: queue time plus sequential approval time.",
      "High-risk changes without review: the share that escaped the risk dimensions.",
      "Review queue age: how long work waits for a reviewer.",
      "Effective risk review coverage: intended coverage after capacity limits.",
      "A flow from change request through risk review and the approval chain to production.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply More signatures. Watch lead time rise while the unreviewed high-risk share stays at 50%. Apply Approval theater to see capacity and coverage fail together, then Recovery to see two approvals with 95% coverage.",
  },
  {
    type: "p",
    text: "A review process should be designed backward from the failure it prevents. If the concern is a bad migration, review the migration and its rollback. If the concern is a broad config change, review the blast radius and the canary. If the concern is a change nobody understands, require an owner and an observability plan. Then remove approvals that do not serve one of those checks, and measure the time each remaining step adds.",
  },
  { type: "sim", simId: "change-review" },
  { type: "experiment", experimentId: "predict-approvals" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the More signatures preset, eight approvals over a 60-change week produced a 3.5-day lead time while half of high-risk changes still lacked a risk review. Capacity was ample, so the queue was short; the problem was that the process checked signatures, not the four risk dimensions. In Approval theater, review capacity also fell below demand, so effective coverage dropped and unreviewed risk rose.",
  },
  {
    type: "p",
    text: "Recovery keeps two approvals, raises coverage to 95%, and brings lead time to about 1.1 days. The review is shorter because it asks four specific questions rather than collecting agreement from eight people.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Change lead time by stage: request, review wait, active review, approval wait, deploy.",
      "The share of high-risk changes with a rollback plan, an owner, and a verification step.",
      "Reviewer utilization and the age of the oldest waiting change.",
      "Changes deployed outside the review process, including emergency exceptions.",
      "Incidents attributed to a change, with the missed risk dimension in the review.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether high-risk changes have a rollback plan and a named owner before counting approvals. Then compare review capacity with arrival rate. If capacity is short, adding approvals makes the queue worse; if coverage is short, adding approvals does not fix it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the four risk questions and require an answer for every high-risk change.",
      "Remove approvals that do not assess risk; keep the ones that add information or authority.",
      "Match review capacity to arrival rate and separate fast-path from deep review.",
      "Make rollback, observability, and ownership explicit artifacts of the change.",
      "Track lead time, queue age, effective coverage, and escaped risk together.",
      "Review incidents for the risk dimension the process missed, not for the missing signature.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Fewer approvals shorten lead time but require reviewers with real authority and judgment.",
      "Deep review catches more risk but consumes scarce senior capacity.",
      "Fast-path review for low-risk changes keeps the pipeline moving but depends on accurate risk classification.",
      "Parallel review shortens the chain but can hide conflicts between reviewers.",
      "Measuring coverage improves visibility but adds process that teams may experience as overhead.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "five-approvals",
    question:
      "Every change needs five approvals, and incidents still happen. How do you redesign the process?",
    difficulty: 2,
    hints: [
      "Ask what each approval actually checks.",
      "Risk dimensions are more useful than signature count.",
      "Measure lead time and escaped risk together.",
    ],
    answer:
      "I would list what each approval checks and remove the ones that only record agreement. Then I would require every high-risk change to answer four questions: blast radius, reversibility, observability, and ownership. I would route high-risk changes to a reviewer with authority and give low-risk reversible changes a fast path. I would measure lead time by stage, review queue age, effective coverage, and the share of high-risk changes without a rollback plan. The target is shorter lead time and lower escaped risk, not fewer or more signatures.",
    followUps: [
      "Which approval would you remove first?",
      "How do you classify a change as high risk?",
      "What would you do if the senior reviewer is the constraint?",
    ],
    redFlags: [
      "Adds another approval step.",
      "Removes review without adding risk coverage.",
      "Measures only incident count.",
    ],
    rubric: [
      "Examines what approvals check.",
      "Names the four risk dimensions.",
      "Separates fast and deep paths.",
      "Measures lead time and coverage.",
    ],
  },
  {
    id: "queue",
    question:
      "Change lead time is nine days and reviewers say they are busy. Where do you look, and what do you change?",
    difficulty: 2,
    hints: [
      "Queue time often dominates active work.",
      "Utilization near capacity makes waits grow nonlinearly.",
      "Not every change needs the same review.",
    ],
    answer:
      "I would split lead time into queue wait, active review, approval wait, and deploy time. If queue wait dominates, I would compare arrival rate with review capacity and look for a single constrained reviewer or team. Then I would add capacity, remove work that does not need that reviewer, or create a fast path for low-risk changes. I would avoid solving a queue problem by asking reviewers to work faster; that hides the mismatch and degrades review quality.",
    followUps: [
      "What utilization target would you set for reviewers?",
      "How would you measure review quality?",
      "What if the queue is caused by one team's changes?",
    ],
    redFlags: [
      "Adds approvals to slow changes down.",
      "Blames reviewers without measuring capacity.",
      "Optimizes deploy time when queue time dominates.",
    ],
    rubric: [
      "Breaks lead time into stages.",
      "Compares arrival and capacity.",
      "Adds capacity or removes low-value work.",
      "Protects review quality.",
    ],
  },
  {
    id: "risk-score",
    question:
      "How would you score a change as high risk without turning the score into another rubber stamp?",
    difficulty: 3,
    hints: [
      "Use observable properties of the change, not a feeling.",
      "The score should route review, not replace it.",
      "Reversibility and blast radius are stronger signals than lines changed.",
    ],
    answer:
      "I would score blast radius, reversibility, observability, and ownership: how many users or regions the change can reach, whether rollback restores the previous state, whether failure would be detected, and whether an owner is on call. I would use the score to route the change to the right review depth and to require specific artifacts such as a rollback plan or a canary. I would keep a human decision for high-risk changes and audit cases where the score was low but the outcome was bad, so the score is calibrated rather than trusted.",
    followUps: [
      "Which dimension is hardest to automate?",
      "How often would you recalibrate the score?",
      "What would make you override a low score?",
    ],
    redFlags: [
      "Uses lines of code as the main risk signal.",
      "Treats the score as an approval.",
      "Never validates the score against incidents.",
    ],
    rubric: [
      "Scores the four risk dimensions.",
      "Uses the score for routing and required artifacts.",
      "Keeps human judgment.",
      "Calibrates against outcomes.",
    ],
  },
  {
    id: "emergency",
    question:
      "A high-risk fix is needed during a freeze. The normal review takes two days. What is the safe path?",
    difficulty: 3,
    hints: [
      "The exception still needs risk review.",
      "A rollback plan is mandatory.",
      "The exception should be audited and reviewed afterward.",
    ],
    answer:
      "I would use a named emergency path with one accountable approver and a decision deadline measured in minutes, not days. The approver checks blast radius, reversibility, observability, and ownership, and the change needs a rollback plan and an owner on call. I would deploy through the pipeline if it can meet the deadline, otherwise through a logged break-glass path. Afterward I would verify recovery, record the exception, and review it with the freeze owner so the path improves.",
    followUps: [
      "Who should be allowed to approve the exception?",
      "What would you do if the approver is unreachable?",
      "How do you prevent the exception from becoming routine?",
    ],
    redFlags: [
      "Suspends review entirely.",
      "Skips the rollback plan.",
      "Leaves no audit trail.",
    ],
    rubric: [
      "Keeps risk review in the exception.",
      "Sets a deadline and an accountable approver.",
      "Requires rollback and verification.",
      "Audits and follows up.",
    ],
  },
];

const checklist = [
  {
    title: "Design the review",
    items: [
      "List what each approval actually checks and remove steps that only record agreement.",
      "Require blast radius, reversibility, observability, and ownership for high-risk changes.",
      "Define a fast path for low-risk reversible changes and a deep path for the rest.",
      "Match review capacity to arrival rate and identify the constrained reviewer.",
      "Publish the emergency path with an owner, deadline, rollback requirement, and audit trail.",
    ],
  },
  {
    title: "Run the process",
    items: [
      "Track lead time by stage, not only the average.",
      "Track effective coverage and the share of high-risk changes without a rollback plan.",
      "Watch queue age; long waits increase batch size and risk.",
      "Record overrides and exceptions with their reason and approver.",
      "Escalate when capacity falls below demand instead of asking for more signatures.",
    ],
  },
  {
    title: "Review outcomes",
    items: [
      "Attribute incidents to the change and the risk dimension the review missed.",
      "Recalibrate risk scoring against real outcomes.",
      "Remove process steps that add delay without adding information.",
      "Report lead time and escaped risk together so speed is not mistaken for safety.",
    ],
  },
];

const references = [
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Change management, approval policy, and the difference between process and risk control.",
  },
  {
    title: "Change management",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/operational-excellence-pillar/change-management.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Change risk, rollback planning, and operational readiness for production changes.",
  },
];

export const changeManagementModel = model;

export const module: Module = {
  meta,
  primer,
  sims: {
    "change-review": {
      model,
      presets,
      instructions:
        "Start with Healthy, then apply More signatures and compare lead time with unreviewed risk. Apply Approval theater to see capacity and coverage fail together, then Recovery. Run the experiment before applying its fix.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Approval cost, review capacity, high-risk share, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-rolling",
    "deployment-freeze-windows",
    "deployment-automated-rollback",
    "deployment-verification",
  ],
};
