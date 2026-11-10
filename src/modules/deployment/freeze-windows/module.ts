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

const THAW_HOURS = 8;

const params: ParamSpec[] = [
  {
    id: "freezeDays",
    label: "Freeze length",
    min: 1,
    max: 14,
    step: 1,
    value: 2,
    unit: " days",
    group: "Freeze",
    help: "How long ordinary changes are blocked. Longer freezes defer more work into the thaw.",
    format: "number",
  },
  {
    id: "dailyChanges",
    label: "Normal change volume",
    min: 5,
    max: 80,
    step: 5,
    value: 20,
    unit: " changes/day",
    group: "Change volume",
    help: "Changes per day the team would normally deploy. This is a rate, not a queue depth.",
    format: "number",
  },
  {
    id: "exceptionMinutes",
    label: "Exception review time",
    min: 15,
    max: 240,
    step: 15,
    value: 30,
    unit: " min",
    group: "Exception path",
    help: "End-to-end time to get an emergency change reviewed, approved, and ready to deploy.",
    format: "number",
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
  days: number;
  daily: number;
  reviewMinutes: number;
  backlog: number;
  thawRate: number;
  leadHours: number;
  bypass: number;
}

function compute(p: Params): Values {
  const days = Math.max(1, num(p, "freezeDays", 2));
  const daily = Math.max(1, num(p, "dailyChanges", 20));
  const reviewMinutes = Math.max(1, num(p, "exceptionMinutes", 30));
  const backlog = days * daily;
  const thawRate = backlog / THAW_HOURS;
  const leadHours = reviewMinutes / 60 + 0.5;
  const bypass = clamp(((leadHours - 1.5) / 3) * 100, 0, 100);
  return { days, daily, reviewMinutes, backlog, thawRate, leadHours, bypass };
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
  const backlogHealth = level(v.backlog, 80, 200);
  const thawHealth = level(v.thawRate, 10, 25);
  const leadHealth = level(v.leadHours, 2, 4);
  const bypassHealth = level(v.bypass, 15, 40);

  const nodes = [
    {
      id: "requests",
      label: "Change requests",
      kind: "client" as const,
      health: "ok" as const,
      sublabel: `${Math.round(v.daily)} changes/day normally`,
      detail: "The normal change pipeline. During a freeze these changes still arrive; they wait instead of disappearing.",
      meta: { view: "flow" },
    },
    {
      id: "calendar",
      label: "Freeze calendar",
      kind: "service" as const,
      health: backlogHealth,
      utilization: clamp(v.days / 14),
      sublabel: `${v.days} days · ${Math.round(v.backlog)} deferred changes`,
      detail: `A ${v.days}-day freeze at ${Math.round(v.daily)} changes per day defers about ${Math.round(v.backlog)} changes. They are not removed from the system; they are concentrated into the thaw.`,
      meta: { view: "flow" },
    },
    {
      id: "review",
      label: "Exception review",
      kind: "service" as const,
      health: worst(leadHealth, bypassHealth),
      utilization: clamp(v.reviewMinutes / 240),
      sublabel: `${v.reviewMinutes} min review · ${v.leadHours.toFixed(1)} h end to end`,
      detail: `The exception path takes ${v.reviewMinutes} minutes of review plus an illustrative 30 minutes to deploy. A slow path does not stop emergencies; it makes bypasses more likely.`,
      meta: { view: "flow" },
    },
    {
      id: "production",
      label: "Production",
      kind: "service" as const,
      health: worst(bypassHealth, thawHealth),
      sublabel: `${v.bypass.toFixed(0)}% bypass risk · thaw ${v.thawRate.toFixed(1)} changes/h`,
      detail: "A freeze changes when risk arrives, not whether it exists. The thaw burst and the unreviewed emergency change are the two ways it comes back.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("requests-calendar", "requests", "calendar", clamp(v.daily / 80), backlogHealth),
      edge("calendar-review", "calendar", "review", clamp(v.backlog / 400), leadHealth),
      edge("review-production", "review", "production", clamp(v.bypass / 100), bypassHealth),
    ],
    metrics: [
      metric("emergency-lead-time", "Emergency change lead time", v.leadHours, " h", 2, 4, "number"),
      metric("deferred-backlog", "Deferred change backlog", v.backlog, " changes", 80, 200, "count"),
      metric("thaw-rate", "Thaw change rate", v.thawRate, " changes/h", 10, 25, "number"),
      metric("bypass-share", "Emergency changes bypassing review", v.bypass, "%", 15, 40, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      backlog: v.backlog,
      thawRate: v.thawRate,
      leadHours: v.leadHours,
      bypass: v.bypass,
    },
    summary: `${v.days}-day freeze · ${Math.round(v.backlog)} deferred · ${v.bypass.toFixed(0)}% bypass risk · thaw ${v.thawRate.toFixed(1)} changes/h`,
  };
}

function seedSeries(frame: SimFrame, v: Values, seed: number): void {
  const jitter = (index: number) => 1 + 0.012 * Math.sin((index + (seed % 7)) / 2.4);
  const series: [string, number][] = [
    ["emergency-lead-time", v.leadHours],
    ["deferred-backlog", v.backlog],
    ["thaw-rate", v.thawRate],
    ["bypass-share", v.bypass],
  ];
  for (const [id, value] of series) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "emergency-lead-time",
    metricId: "emergency-lead-time",
    warn: 2,
    crit: 4,
    title: "The exception path is too slow for an emergency",
    cause:
      "A freeze without a bounded exception path turns a critical fix into a wait. If review takes hours, the people closest to the incident will route around it, and the change happens without review instead of with review.",
    fix:
      "Define a named exception path with a decision deadline, a required rollback plan, one accountable approver, and a follow-up review. If the path cannot meet the deadline, fix the path rather than waiving the freeze verbally.",
    checkFirst: [
      "Measure the end-to-end exception time, not only the review meeting length.",
      "Check how many emergency changes skipped review during the last freeze.",
      "Check who owns the exception decision and whether that person is reachable.",
    ],
  },
  {
    id: "deferred-backlog",
    metricId: "deferred-backlog",
    warn: 80,
    crit: 200,
    title: "The freeze is concentrating change risk",
    cause:
      "Every ordinary change deferred by the freeze still needs to ship. A long freeze at a high change rate accumulates a backlog that returns as one large batch, with more interactions and less review time per change.",
    fix:
      "Shorten the freeze to the period that carries real risk, exempt reversible low-risk changes, and stage the thaw over several days instead of releasing the whole backlog at once.",
    checkFirst: [
      "Compare the deferred backlog with normal weekly change volume.",
      "Check which deferred changes are urgent, coupled, or unsafe to batch.",
      "Check whether the thaw plan has a daily limit and a rollback owner.",
    ],
  },
  {
    id: "thaw-rate",
    metricId: "thaw-rate",
    warn: 10,
    crit: 25,
    title: "The thaw lands as a burst",
    cause:
      "When the freeze lifts, the deferred backlog competes for the same reviewers, deploy windows, and attention. A thaw rate far above normal turns a risk-reduction measure into a high-volume change event.",
    fix:
      "Stage the thaw: cap changes per day, order by risk, keep the normal gates, and hold back low-priority work. Do not treat the freeze end date as a release deadline.",
    checkFirst: [
      "Compare planned thaw volume with normal daily change volume.",
      "Check reviewer and deploy capacity for the first thaw day.",
      "Check whether high-risk changes are spread across the thaw or stacked.",
    ],
  },
  {
    id: "bypass-share",
    metricId: "bypass-share",
    warn: 15,
    crit: 40,
    title: "Emergency changes are bypassing review",
    cause:
      "When the formal exception path is slower than the incident, teams deploy through console access, direct credentials, or an informal approval. The freeze still exists on paper, but the risk control does not.",
    fix:
      "Make the reviewed exception path faster than the bypass, require a rollback plan and owner, and audit every bypass. Treat a high bypass rate as a signal that the freeze process is failing, not that people are careless.",
    checkFirst: [
      "Compare exception lead time with the time a bypass takes.",
      "Check audit logs for changes made outside the pipeline during the freeze.",
      "Check whether bypasses had a rollback plan and a named owner.",
    ],
  },
];

const model: SimModel = {
  id: "deployment-freeze-windows",
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
    const drift = 1 + rng.between(-0.002, 0.002) * Math.min(1, Math.max(0, dt) * 10);
    next.metrics = next.metrics.map((item) =>
      item.id === "thaw-rate" ? { ...item, value: Math.max(0, item.value * drift) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items = [
      `A ${v.days}-day freeze at ${Math.round(v.daily)} changes per day defers about ${Math.round(v.backlog)} changes. The freeze moves that work into the thaw; it does not delete it.`,
      `The first thaw day would see about ${v.thawRate.toFixed(1)} changes per hour over an eight-hour window, against a normal ${(v.daily / 8).toFixed(1)} per hour.`,
      `The exception path takes ${v.leadHours.toFixed(1)} hours end to end. With an illustrative 1.5-hour tolerance, the estimated bypass share is ${v.bypass.toFixed(0)}%.`,
    ];
    if (v.bypass >= 40) {
      items.push("A large bypass share means the formal exception path is slower than the workaround. The control is failing even if the freeze calendar is still active.");
    } else if (v.bypass >= 15) {
      items.push("Some teams are likely to route around a slow exception path. Measure the bypass, not just the approval.");
    } else {
      items.push("The exception path is fast enough that an emergency fix can stay inside the process.");
    }
    items.push("Shorten the freeze to the risky period, keep a fast exception path, and stage the thaw. A freeze is a scheduling control, not a risk removal tool.");
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
    description: "A two-day freeze over a holiday, 20 changes/day, and a 30-minute exception path.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A four-day freeze at 40 changes/day with a 90-minute exception path.",
    tone: "warn",
    params: defaults({ freezeDays: 4, dailyChanges: 40, exceptionMinutes: 90 }),
  },
  {
    id: "failure",
    label: "Long freeze",
    description: "A seven-day freeze at 60 changes/day and a four-hour exception path.",
    tone: "crit",
    params: defaults({ freezeDays: 7, dailyChanges: 60, exceptionMinutes: 240 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A short freeze, normal volume, and a 15-minute exception path with a review deadline.",
    tone: "ok",
    params: defaults({ freezeDays: 2, dailyChanges: 20, exceptionMinutes: 15 }),
  },
];

const experiment: Experiment = {
  id: "predict-freeze-risk",
  title: "Predict where the freeze risk lands",
  simId: "change-freeze",
  question:
    "A seven-day freeze at 60 changes/day starts today. The exception path takes four hours. What is the dominant risk?",
  prediction: {
    options: [
      { id: "bypass", label: "Critical fixes are delayed or bypass review, and the thaw lands as a burst" },
      { id: "disappear", label: "The deferred changes disappear, so total change risk falls" },
      { id: "review", label: "The exception review itself prevents all risky changes" },
      { id: "capacity", label: "The freeze increases reviewer capacity for the thaw" },
    ],
    correctOptionId: "bypass",
    explanation:
      "A freeze does not remove the changes; it reschedules them. A long freeze at high volume creates a 420-change backlog, and a four-hour exception path makes an unreviewed workaround more attractive than the process. The risk returns as a thaw burst and as emergency changes outside review.",
  },
  setup: defaults({ freezeDays: 7, dailyChanges: 60, exceptionMinutes: 240 }),
  runFor: 20,
  observe: [
    "The deferred backlog reaches 420 changes.",
    "The first thaw day would run at about 52.5 changes per hour.",
    "The exception path takes 4.5 hours end to end.",
    "The estimated bypass share reaches 100%, because the formal path is far slower than the incident.",
  ],
  explain:
    "Freezes are a bet that the risk of change during a sensitive period is higher than the risk of waiting. The bet only pays if deferred work is staged and emergency work stays inside a usable process. Otherwise the freeze concentrates risk at the thaw and pushes urgent fixes outside review.",
  fix: defaults({ freezeDays: 2, dailyChanges: 20, exceptionMinutes: 15 }),
  debrief:
    "The fixed setup keeps the freeze short, holds the backlog to 40 changes, and makes the exception path 45 minutes end to end. Bypass risk falls to zero because the reviewed path is faster than the workaround. The tradeoff is that fewer changes are blocked, so the freeze protects a narrower window and relies on normal review outside it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A change freeze blocks ordinary deployments for a period: a holiday, a retail peak, an audit window, or the early hours of a major event. The intent is to keep a known-good system stable while attention is elsewhere. A freeze is a scheduling control, not a risk-removal tool. The changes still exist, the defects still exist, and the urgency of an outage does not pause because the calendar says so.",
  },
  {
    type: "p",
    text: "A freeze has two failure modes. It can block the fix that an incident needs, or it can let a risky change through an informal bypass because the formal exception path is too slow. Both come from the same design gap: a freeze without a fast, accountable exception path and without a staged thaw. The question is not whether to freeze, but what happens to the work that cannot wait.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The freeze sits between the change pipeline and production. The pipeline still accepts commits and builds artifacts; the deploy gate is what pauses. The exception path is a second gate beside the freeze, with its own approver, rollback requirement, and audit trail. The thaw is a third control: the plan for releasing deferred work after the window closes.",
  },
  {
    type: "compare",
    leftTitle: "What a freeze controls",
    rightTitle: "What it does not control",
    rows: [
      { label: "Deploy timing", left: "Ordinary changes wait for the window to close", right: "Urgent fixes still need a path to production" },
      { label: "Change volume", left: "Fewer changes during the freeze", right: "The same work returns at the thaw" },
      { label: "Review", left: "Normal review can be deferred with the change", right: "Emergency review must be faster than a bypass" },
      { label: "Risk", left: "Risk is moved away from the protected period", right: "Risk is not reduced unless the thaw is staged" },
    ],
  },
  {
    type: "p",
    text: "The values in this module are illustrative teaching values. Freeze length, change volume, exception time, backlog thresholds, and the eight-hour thaw window are not industry constants. The shape is the lesson: deferred volume accumulates, exception latency drives bypass, and the thaw is a change event of its own.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Emergency change lead time: the end-to-end time for a fix that cannot wait.",
      "Deferred change backlog: the work the freeze has moved to the thaw.",
      "Thaw change rate: the backlog divided across the first thaw day.",
      "Emergency bypass share: an estimate of urgent changes that skip the formal path.",
      "A flow from change requests through the freeze calendar and exception review to production.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy, then apply Long freeze. Watch the backlog and bypass share rise together. Apply Recovery to see a short freeze with a 15-minute exception path. Run the experiment before revealing its explanation: the point is to predict where the risk goes, not to memorize the numbers.",
  },
  {
    type: "p",
    text: "A good freeze has a narrow scope, a short duration, and a named exception path. The exception path needs a decision deadline, one accountable owner, a rollback plan, and a follow-up review. The thaw needs a daily cap and an order that puts coupled or high-risk changes first. If the exception path cannot beat the workaround, the freeze will be bypassed and the audit trail will be the only thing left.",
  },
  { type: "sim", simId: "change-freeze" },
  { type: "experiment", experimentId: "predict-freeze-risk" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the Long freeze preset, seven days at 60 changes per day deferred 420 changes. The first thaw day would carry about 52.5 changes per hour, and the exception path took 4.5 hours end to end. The model estimated a 100% bypass share: not because engineers are reckless, but because waiting four and a half hours for a critical fix is not a realistic option during an incident.",
  },
  {
    type: "p",
    text: "The Recovery preset keeps a two-day freeze, the normal 20 changes per day, and a 15-minute exception path. The backlog falls to 40 changes, the thaw rate to 5 per hour, and bypass risk to zero. The freeze still protects a window; it no longer creates a second incident at the thaw.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Freeze calendar entries and the change policy attached to each window.",
      "Deferred change tickets, their owners, and the planned thaw date.",
      "Exception requests with decision time, approver, rollback plan, and outcome.",
      "Audit events for changes made outside the pipeline during the freeze.",
      "Thaw-day change volume, incident rate, and rollback rate compared with normal days.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the exception path before the freeze starts: who decides, how fast, and with what rollback plan. Then check the size of the deferred backlog and the first thaw day's planned volume. Finally, check audit logs for bypasses; a freeze with a silent bypass is not a control.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Keep the freeze only for the period that carries real risk; narrow the scope and duration.",
      "Publish a named exception path with a decision deadline and one accountable approver.",
      "Require a rollback plan, a verification step, and a follow-up review for every exception.",
      "Stage the thaw with a daily cap, risk ordering, and the normal gates.",
      "Track bypasses and exception lead time as process health signals.",
      "Review after the window whether the freeze prevented incidents or merely moved them.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A longer freeze protects a longer window but accumulates a larger and riskier thaw.",
      "A strict exception path is safer on paper but can push urgent fixes outside review.",
      "A fast exception path keeps emergencies inside the process but needs a trusted approver on call.",
      "Staging the thaw reduces burst risk but extends the recovery period after the freeze.",
      "Exempting low-risk reversible changes keeps the pipeline moving but requires a reliable risk classification.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "exception-path",
    question:
      "A freeze is active and a critical customer-facing fix is ready. Design the exception path you would use.",
    difficulty: 2,
    hints: [
      "Name the decision maker and the deadline.",
      "A rollback plan is part of the change, not an afterthought.",
      "The path needs an audit trail and a follow-up review.",
    ],
    answer:
      "I would route the fix through a named emergency path with one accountable approver, a stated decision deadline, and a required rollback plan. The approver checks blast radius, reversibility, observability, and the owner on call, not the number of signatures. I would deploy with the normal pipeline if it can meet the deadline, otherwise through a controlled break-glass path that logs the change and the approval. After the fix, I would verify recovery, record the exception, and review it with the freeze owner so the path improves rather than becoming a permanent bypass.",
    followUps: [
      "What would you do if the approver cannot be reached?",
      "How do you verify the fix after the exception deploy?",
      "What makes an exception review meaningful rather than ceremonial?",
    ],
    redFlags: [
      "Waives the freeze with no owner or audit trail.",
      "Accepts a fix with no rollback plan.",
      "Uses the exception path for ordinary changes.",
    ],
    rubric: [
      "Names a decision maker, deadline, and rollback requirement.",
      "Reviews risk rather than signature count.",
      "Keeps an audit trail.",
      "Verifies recovery and follows up.",
    ],
  },
  {
    id: "thaw",
    question:
      "The freeze ends Monday and 300 changes are waiting. How do you plan the thaw?",
    difficulty: 2,
    hints: [
      "Volume is the risk, not the date.",
      "Order by coupling and reversibility, not by ticket age.",
      "The normal gates still apply.",
    ],
    answer:
      "I would not release the backlog as a batch. I would cap changes per day, order by risk and coupling, and keep the normal review and deploy gates. Low-risk reversible changes can move first; high-risk or coupled changes get separate windows and owners. I would reserve capacity for rollback and for the incidents that the thaw itself may cause, and I would compare the thaw week's incident and rollback rates with a normal week.",
    followUps: [
      "Which changes would you defer past the first week?",
      "How would you handle a change that depends on another deferred change?",
      "What signal tells you to slow the thaw?",
    ],
    redFlags: [
      "Releases everything on the first day.",
      "Sorts by age or ticket priority only.",
      "Drops the normal gates to clear the backlog.",
    ],
    rubric: [
      "Caps and stages the thaw.",
      "Orders by risk and coupling.",
      "Keeps normal gates.",
      "Measures thaw incidents and rollbacks.",
    ],
  },
  {
    id: "freeze-value",
    question:
      "How would you decide whether a freeze actually reduced risk?",
    difficulty: 3,
    hints: [
      "Compare the protected period with a baseline.",
      "Look for displaced risk at the thaw and in bypasses.",
      "A freeze that hides changes is not a control.",
    ],
    answer:
      "I would compare incident rate, severity, and change volume during the freeze with comparable periods, and then compare the thaw with normal weeks. I would also measure bypasses, exception lead time, and deferred backlog so displaced risk is visible. If incidents fall during the freeze but rise at the thaw or in unreviewed changes, the freeze moved risk rather than reducing it. The decision should use the whole window, not just the protected days.",
    followUps: [
      "What baseline would you use for a holiday freeze?",
      "How do you attribute an incident to a deferred change?",
      "When would you stop using freezes entirely?",
    ],
    redFlags: [
      "Counts only incidents during the freeze.",
      "Ignores bypasses and thaw volume.",
      "Treats a quiet week as proof of safety.",
    ],
    rubric: [
      "Compares freeze and thaw with baselines.",
      "Measures displaced risk.",
      "Uses bypass and exception data.",
      "Draws a conclusion about the whole window.",
    ],
  },
];

const checklist = [
  {
    title: "Before the freeze",
    items: [
      "State the risk the window is protecting and the smallest scope that covers it.",
      "Publish the exception path with an owner, deadline, rollback requirement, and audit trail.",
      "Estimate the deferred backlog and reserve reviewer and deploy capacity for the thaw.",
      "Identify urgent work that cannot wait and pre-approve a path for it.",
      "Tell teams what happens to changes that miss the freeze cutoff.",
    ],
  },
  {
    title: "During the freeze",
    items: [
      "Track exception lead time and the number of bypasses, not only approvals.",
      "Keep normal review for every exception; do not trade review for speed.",
      "Record the rollback plan and verification for each emergency change.",
      "Watch the backlog and re-scope low-value deferred work.",
      "Escalate a slow or unreachable approver before teams route around the process.",
    ],
  },
  {
    title: "After the freeze",
    items: [
      "Stage the thaw with a daily cap and a risk-ordered queue.",
      "Compare thaw incidents and rollbacks with a normal week.",
      "Review every bypass and every exception for process gaps.",
      "Decide whether the freeze reduced risk or moved it, and adjust the next window.",
    ],
  },
];

const references = [
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Change management, release policy, and the limits of approval-based control.",
  },
  {
    title: "Change management",
    url: "https://www.atlassian.com/itsm/change-management",
    publisher: "Atlassian",
    kind: "docs" as const,
    note: "Change types, freezes, emergency changes, and the exception process.",
  },
];

export const freezeWindowsModel = model;

export const module: Module = {
  meta,
  primer,
  sims: {
    "change-freeze": {
      model,
      presets,
      instructions:
        "Start with Healthy, then apply Long freeze and compare the backlog with the bypass share. Apply Recovery to see a short freeze with a fast exception path. Run the experiment before revealing the explanation.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Freeze lengths, change volumes, exception times, and thresholds are teaching values, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "deployment-change-management",
    "deployment-incident-deploy",
    "deployment-rollback-vs-rollforward",
    "deployment-automated-rollback",
  ],
};
