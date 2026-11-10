import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DUE_DAY = 14;
const ENGINEER_DAYS_PER_ACTION = 3;

const params = [
  {
    id: "actionCount",
    label: "Open action items",
    min: 4,
    max: 24,
    step: 1,
    value: 8,
    unit: "",
    group: "Backlog",
    help: "Items created by the postmortem. A long list competes for the same finite prevention capacity.",
    format: "count" as const,
  },
  {
    id: "capacityDays",
    label: "Prevention capacity",
    min: 2,
    max: 20,
    step: 1,
    value: 8,
    unit: " eng-days / week",
    group: "Capacity",
    help: "Engineer-days per week the team can spend on prevention work without stopping product delivery.",
    format: "number" as const,
  },
  {
    id: "ownerCoverage",
    label: "Owner coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Quality",
    help: "Share of items with one named person accountable for the next step. A team name is not an owner.",
    format: "percent" as const,
  },
  {
    id: "verificationRate",
    label: "Verification coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Quality",
    help: "Share of items with a test, signal, or read-back that proves the change works. Completion without evidence can reopen.",
    format: "percent" as const,
  },
  {
    id: "priorityFocus",
    label: "Risk-weighted priority",
    min: 0,
    max: 100,
    step: 5,
    value: 60,
    unit: "%",
    group: "Capacity",
    help: "How strongly capacity favors the items that prevent recurrence over cleanup and documentation.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  actions: number;
  capacity: number;
  owner: number;
  verify: number;
  focus: number;
  throughput: number;
  done: number;
  queueDepth: number;
  highRisk: number;
  highRiskOpen: number;
  overdue: number;
  unowned: number;
  unverified: number;
  recurrence: number;
}

function compute(p: Params, t: number): Values {
  const actions = clamp(Math.round(num(p, "actionCount", 10)), 4, 24);
  const capacity = clamp(num(p, "capacityDays", 8), 2, 20);
  const owner = clamp(num(p, "ownerCoverage", 90), 0, 100) / 100;
  const verify = clamp(num(p, "verificationRate", 80), 0, 100) / 100;
  const focus = clamp(num(p, "priorityFocus", 60), 0, 100) / 100;
  const elapsed = Math.max(0, t);
  const throughput =
    (capacity / 7 / ENGINEER_DAYS_PER_ACTION) * (0.35 + 0.65 * owner) * (0.5 + 0.5 * verify);
  const done = Math.min(actions, Math.floor(throughput * elapsed));
  const queueDepth = Math.max(0, actions - done);
  const highRisk = Math.max(1, Math.ceil(actions * 0.2));
  const highRiskDone = Math.min(highRisk, Math.floor(throughput * (0.3 + 0.7 * focus) * elapsed));
  const highRiskOpen = Math.max(0, highRisk - highRiskDone);
  const overdue = elapsed > DUE_DAY ? highRiskOpen : 0;
  const unowned = Math.round(actions * (1 - owner));
  const unverified = Math.round(actions * (1 - verify));
  const agePressure = elapsed > DUE_DAY && highRiskOpen > 0 ? Math.min(25, (elapsed - DUE_DAY) * 0.8) : 0;
  const recurrence = clamp(
    8 + highRiskOpen * 9 + (1 - verify) * 12 + (1 - owner) * 6 + agePressure,
    0,
    100,
  );
  return {
    actions,
    capacity,
    owner,
    verify,
    focus,
    throughput,
    done,
    queueDepth,
    highRisk,
    highRiskOpen,
    overdue,
    unowned,
    unverified,
    recurrence,
  };
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  const backlogHealth: "ok" | "warn" | "crit" =
    v.overdue >= 3 || v.recurrence >= 55 ? "crit" : v.overdue >= 1 || v.recurrence >= 35 ? "warn" : "ok";
  const ownerHealth: "ok" | "warn" | "crit" =
    v.unowned >= 12 ? "crit" : v.unowned >= 5 ? "warn" : "ok";
  const verifyHealth: "ok" | "warn" | "crit" =
    v.unverified >= 14 ? "crit" : v.unverified >= 6 ? "warn" : "ok";
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "findings",
        label: "Postmortem findings",
        kind: "service",
        health: "ok",
        utilization: 0.35,
        sublabel: `${v.highRisk} recurrence-critical`,
        detail: "The findings identify the conditions to change. Each action should trace back to a contributing factor.",
        meta: { view: "flow" },
      },
      {
        id: "backlog",
        label: "Actions waiting",
        kind: "queue",
        health: backlogHealth,
        sublabel: "action backlog",
        detail: "The backlog is a queue with finite service capacity. Depth alone is not the risk; age and which items are waiting are.",
        meta: { view: "queue", queueDepth: v.queueDepth },
      },
      {
        id: "owners",
        label: "Named owners",
        kind: "worker",
        health: ownerHealth,
        throughput: v.throughput * 7,
        sublabel: `${v.unowned} unowned`,
        detail: "One named person owns the next step. A team alias distributes attention without assigning it.",
        meta: { view: "flow" },
      },
      {
        id: "verification",
        label: "Verification",
        kind: "worker",
        throughput: Math.max(0, v.done / Math.max(1, t)) * 7,
        health: verifyHealth,
        sublabel: `${v.unverified} unverified`,
        detail: "A test, signal, or read-back proves the condition changed. Closing an item without evidence is a status update, not a fix.",
        meta: { view: "flow" },
      },
      {
        id: "high-risk",
        label: "High-risk track",
        kind: "worker",
        health: v.highRiskOpen >= 3 ? "warn" : "ok",
        throughput: v.throughput * (0.3 + 0.7 * v.focus) * 7,
        sublabel: `${v.highRiskOpen} open`,
        detail: "The item that prevents recurrence is not always the easiest or the most visible. Priority determines whether it ships before the due date.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("findings-backlog", "findings", "backlog", 1, "ok"),
      edge("backlog-owners", "backlog", "owners", clamp(v.throughput * 7), ownerHealth),
      edge("backlog-verify", "backlog", "verification", clamp(v.throughput * 7), verifyHealth),
      edge("owners-high-risk", "owners", "high-risk", v.focus, "ok"),
    ],
    metrics: [
      metric("queueDepth", "Open actions", v.queueDepth, "", undefined, undefined, "count"),
      metric("high-risk-open", "High-risk actions open", v.highRiskOpen, "", undefined, undefined, "count"),
      metric("overdue-actions", "Overdue high-risk actions", v.overdue, "", 1, 3, "count"),
      metric("recurrence-risk", "Recurrence risk", v.recurrence, "%", 35, 55, "percent"),
      metric("unowned-actions", "Unowned actions", v.unowned, "", 5, 12, "count"),
      metric("unverified-actions", "Unverified actions", v.unverified, "", 6, 14, "count"),
    ],
    events: [
      {
        id: "ai-tracker-opened",
        at: 0,
        severity: "info",
        title: "Postmortem action tracker opened",
        detail: `${v.actions} action(s), ${v.highRisk} recurrence-critical, ${v.capacity} engineer-days per week of prevention capacity.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.queueDepth} open action(s); ${v.overdue} overdue high-risk; recurrence risk ${v.recurrence.toFixed(0)}%.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.035 * Math.sin((index + phase) / 3.2))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "overdue-actions",
    metricId: "overdue-actions",
    warn: 1,
    crit: 3,
    title: "A recurrence-critical action missed its due date",
    cause:
      "Capacity is spread across the whole list and the highest-risk item is waiting behind lower-risk work. The condition that caused the incident is still present.",
    fix:
      "Re-sequence the backlog by risk, assign the item to one owner, and set a new date with a verification. Remove or defer work that does not prevent recurrence.",
    checkFirst: [
      "Which action addresses the contributing factor that is still present?",
      "Is that action behind lower-risk items in the queue?",
      "Does the action have one owner and a verification?",
    ],
  },
  {
    id: "recurrence-risk",
    metricId: "recurrence-risk",
    warn: 35,
    crit: 55,
    title: "The same incident is likely to recur",
    cause:
      "The prevention work is not shipping fast enough, or the items that matter are unowned or unverified. The backlog is moving without reducing the original risk.",
    fix:
      "Stop treating the action list as a flat queue. Prioritize the few items that change the failure conditions, give each one owner and a date, and verify the change before closing it.",
    checkFirst: [
      "Which contributing factor has no shipped action?",
      "How many actions are unowned or unverified?",
      "Is the team measuring closure rate or risk reduction?",
    ],
  },
  {
    id: "unowned-actions",
    metricId: "unowned-actions",
    warn: 5,
    crit: 12,
    title: "Action items have no individual owner",
    cause:
      "Items were assigned to a team or left unassigned. Without one accountable person, the next step waits for someone to notice it.",
    fix:
      "Assign every item to one named owner, even if the work is shared. The owner is accountable for the next step and the date, not for doing every hour of the work.",
    checkFirst: [
      "Which items have a team name instead of a person?",
      "Who is expected to start each item next?",
      "Does the owner know the due date and the verification?",
    ],
  },
  {
    id: "unverified-actions",
    metricId: "unverified-actions",
    warn: 6,
    crit: 14,
    title: "Actions are closing without evidence",
    cause:
      "The item has no test, signal, or read-back that proves the condition changed. Closure measures activity, not prevention.",
    fix:
      "Add a verification to each item before work starts: the signal that should change, the test that should pass, or the scenario that should no longer fail. Reopen items that closed without it.",
    checkFirst: [
      "What signal would prove this action worked?",
      "Was that signal observed before the item closed?",
      "Which closed items have no linked evidence?",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const actionItemModel: SimModel = {
  id: "reliability-action-items",
  visual: "queue",
  params,
  init: ({ seed }) => buildFrame(defaults(), 0, seed),
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, frame.t, seed);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.events = frame.events.slice(-60);
    const v = compute(p, frame.t);
    if (v.unowned >= 1 && frame.flags.aiUnowned !== 1) {
      pushEvent(next, {
        id: "ai-unowned",
        at: frame.t,
        severity: "warn",
        title: "Action items without an individual owner",
        detail: `${v.unowned} of ${v.actions} items have no named person accountable for the next step. A team alias is not an owner.`,
        nodeId: "owners",
        metricId: "unowned-actions",
      });
      next.flags.aiUnowned = 1;
    }
    if (v.overdue >= 1 && frame.flags.aiOverdue !== 1) {
      pushEvent(next, {
        id: "ai-overdue",
        at: frame.t,
        severity: "crit",
        title: "High-risk action missed its due date",
        detail: `The prevention item is still waiting behind ${v.queueDepth} open action(s). Capacity is being spent, but not on the condition that caused the incident.`,
        nodeId: "backlog",
        metricId: "overdue-actions",
      });
      next.flags.aiOverdue = 1;
    }
    if (v.queueDepth <= 0 && frame.flags.aiCleared !== 1) {
      pushEvent(next, {
        id: "ai-cleared",
        at: frame.t,
        severity: "info",
        title: "Action backlog cleared",
        detail: "Every item is closed. Check that the high-risk items closed with verification, not only with a status change.",
        nodeId: "verification",
      });
      next.flags.aiCleared = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `${v.queueDepth} of ${v.actions} actions remain open. Capacity is ${v.capacity} engineer-days per week, about ${(v.throughput * 7).toFixed(1)} actions per week.`,
      `${v.highRisk} item(s) prevent recurrence. ${v.highRiskOpen} remain open; risk-weighted priority is ${Math.round(v.focus * 100)}%.`,
      `${v.unowned} item(s) have no individual owner and ${v.unverified} have no verification. Either one turns completion into a status update.`,
      `Recurrence risk is ${v.recurrence.toFixed(0)}%. A flat backlog can show progress while the original condition remains unchanged.`,
    ];
  },
  legend: [
    { label: "On track", tone: "ok" },
    { label: "At risk", tone: "warn" },
    { label: "Overdue", tone: "crit" },
    { label: "Recurred", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A short list, enough capacity, named owners, and verification on most items.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy quarter",
    description: "More actions than capacity, but the high-risk work still gets priority.",
    tone: "warn",
    params: defaults({ actionCount: 14, capacityDays: 8, ownerCoverage: 85, verificationRate: 80, priorityFocus: 60 }),
  },
  {
    id: "failure",
    label: "Flat backlog",
    description: "Twenty actions, little capacity, weak ownership, and no risk weighting.",
    tone: "crit",
    params: defaults({ actionCount: 20, capacityDays: 4, ownerCoverage: 50, verificationRate: 40, priorityFocus: 20 }),
    elapsed: 16,
  },
  {
    id: "recovery",
    label: "Prioritized",
    description: "A trimmed list, named owners, verification, and capacity focused on recurrence.",
    tone: "ok",
    params: defaults({ actionCount: 10, capacityDays: 10, ownerCoverage: 100, verificationRate: 95, priorityFocus: 90 }),
  },
];

const experiment: Experiment = {
  id: "predict-shipped",
  title: "Predict what ships when capacity is shared evenly",
  simId: "action-items",
  question:
    "A postmortem creates 20 actions. The team has four engineer-days per week and works the list in order. Which action is least likely to ship by its due date?",
  prediction: {
    options: [
      { id: "high-risk", label: "The high-risk prevention item waiting behind lower-risk cleanup" },
      { id: "status", label: "The status-page wording update" },
      { id: "dashboard", label: "The dashboard panel addition" },
      { id: "docs", label: "The documentation edit" },
    ],
    correctOptionId: "high-risk",
    explanation:
      "A flat queue serves the items at the front, which are usually the easiest and most visible. The prevention item is rarely at the front unless someone prioritizes it. Capacity is spent, closure rate looks healthy, and the original condition remains.",
  },
  setup: defaults({ actionCount: 20, capacityDays: 4, ownerCoverage: 50, verificationRate: 40, priorityFocus: 20 }),
  runFor: 40,
  observe: [
    "Queue depth falls slowly because capacity is small and weak ownership reduces the rate at which work can start.",
    "Recurrence risk is already elevated at the start because the high-risk items are unowned and unverified.",
    "The high-risk item misses its day-14 due date while lower-risk work closes.",
    "Recurrence risk crosses critical after the due date, even though the tracker shows progress.",
  ],
  explain:
    "An action list is a queue with finite service capacity. Without an owner, an item cannot start. Without verification, a closed item can reopen. Without prioritization, the queue serves whatever is easiest. The original failure condition is not a function of how many items closed; it is a function of whether the few prevention items shipped.",
  fix: defaults({ actionCount: 10, capacityDays: 10, ownerCoverage: 100, verificationRate: 95, priorityFocus: 90 }),
  debrief:
    "The prioritized list ships the high-risk items first because the owner and the verification are explicit and capacity is weighted toward recurrence. The cost is saying no to lower-risk cleanup and documentation. That trade is the point: a short list that lands is worth more than a long list that looks busy.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An action item is a change that reduces the chance or impact of a future incident. A useful item names one owner, a due date, the condition it changes, and the verification that proves the change worked. It is not a wish, a reminder, or a restatement of the incident.",
  },
  {
    type: "p",
    text: "Postmortems often produce too many actions because every participant wants their concern recorded. That is understandable and expensive. Each item consumes review attention and engineering capacity, and a long list competes with itself. The team closes the easy items, reports progress, and leaves the condition that caused the incident untouched.",
  },
  {
    type: "p",
    text: "Prioritization is not a popularity contest. It is a statement about which failure conditions the organization is willing to leave in place. The few actions that change those conditions should be visible, owned, and scheduled before the cleanup work that makes the tracker look healthy.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The postmortem identifies contributing factors. The action item turns one factor into a change. The tracker holds the queue and the evidence. The review meeting checks whether the change actually reduced risk. Incident response is over by this point; the work is prevention, and it competes with product delivery for the same people.",
  },
  {
    type: "table",
    headers: ["Weak action", "Why it fails", "Stronger version"],
    rows: [
      ["Be more careful during failover", "Depends on vigilance, not a condition", "Add a read-back step to the failover checklist"],
      ["Improve monitoring", "No signal, owner, or threshold", "Alert when retry rate exceeds 2x baseline for 5 minutes"],
      ["Team will review the runbook", "No person, date, or change", "Owner updates the topology check by 30 days and rehearses it"],
      ["Add a warning to the console", "The warning may not change the decision", "Test whether the warning changes the action in a rehearsal"],
    ],
  },
  {
    type: "p",
    text: "This module models an action backlog with finite engineer-days, a due date for recurrence-critical items, and a verification requirement. One simulated second represents one day. The capacity, completion rates, and thresholds are illustrative teaching values, not a planning standard.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Open actions: the queue depth, which falls as capacity completes work.",
      "Overdue high-risk actions: prevention items that passed their due date without shipping.",
      "Recurrence risk: the chance the original failure condition is still present.",
      "Unowned and unverified actions: items that cannot start or cannot prove completion.",
      "A queue view of findings, backlog, owners, verification, and the high-risk track.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Flat backlog. Watch the high-risk track before the queue depth: the queue can look busy while the prevention item waits. Run the experiment before reading the debrief, then add capacity, owners, and priority one at a time.",
  },
  {
    type: "compare",
    leftTitle: "Flat tracker",
    rightTitle: "Risk-weighted tracker",
    rows: [
      { label: "Priorities", left: "First in, first out", right: "Recurrence-critical items first" },
      { label: "Ownership", left: "Team alias or blank", right: "One named person per item" },
      { label: "Done", left: "Status changed", right: "Verification observed" },
      { label: "Failure", left: "Closure rate rises while risk stays", right: "Fewer items, lower recurrence" },
    ],
  },
  { type: "sim", simId: "action-items" },
  { type: "experiment", experimentId: "predict-shipped" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The tracker had twenty items and four engineer-days per week. Work started on whatever was at the front of the list, which was the easiest cleanup. Half the items had no individual owner, so work started slowly and ownership was easy to lose. The high-risk prevention item passed its day-14 due date while the queue depth fell and the closure count rose. The original condition was still present.",
  },
  {
    type: "p",
    text: "The prioritized list worked because it changed three things at once: fewer items, named owners, and capacity weighted toward recurrence. Verification kept closed items closed. The remaining cost was explicit: lower-risk cleanup and documentation waited. A team that cannot say no to low-risk work will eventually say no to prevention by accident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Action tracker: many items in progress, few completed, and a long tail with no owner or date.",
      "Sprint board: prevention work competing with feature work under the same capacity, usually losing.",
      "Closed items: a status change with no linked test, dashboard, or read-back.",
      "Recurrence: a similar incident with a different trigger and the same contributing condition.",
      "Review meeting: a discussion about closure percentage rather than whether the failure condition changed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the action that addresses the contributing factor still present in production. Check its owner, due date, and verification. If it is behind lower-risk work or has no individual owner, the tracker is measuring activity, not prevention.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Cut the list to the actions that change a contributing factor. Move the rest to a separate backlog with no prevention capacity reserved.",
      "Give each remaining item one owner, one due date, and one verification.",
      "Reserve capacity for the high-risk items before the team accepts new work.",
      "Close an item only when the verification has been observed and linked.",
      "Review the high-risk items at every planning cycle, not only at the next postmortem.",
      "After the due date, escalate the miss rather than silently extending it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shorter list lands more often but records fewer concerns. Keep the cut items visible so they can be reconsidered.",
      "Reserving capacity for prevention slows feature delivery. The alternative is paying for the incident again with interest.",
      "A due date creates focus and can encourage premature closure. Pair it with verification, not with a status field.",
      "Risk weighting can become a reason to ignore low-risk but real issues. Revisit the weighting when the risk profile changes.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "action-quality",
    question: "What makes an action item likely to ship and actually prevent recurrence?",
    difficulty: 2,
    hints: [
      "An item needs a person, a date, and evidence.",
      "The action should change a condition, not a person's vigilance.",
    ],
    answer:
      "It names one owner, a due date, the contributing condition it changes, and the verification that proves the change worked. It is small enough to finish and specific enough that someone can tell whether it happened. It is prioritized against other prevention work, not left in a flat queue. An item that depends on people being more careful is not a control; it is a hope.",
    followUps: [
      "Who should own an action that crosses teams?",
      "What if the action cannot be verified?",
      "How do you prioritize between two high-risk items?",
    ],
    redFlags: [
      "Writes a vague improvement goal.",
      "Assigns to a team with no person.",
      "Treats a status change as completion.",
    ],
    rubric: [
      "Names owner, date, and verification.",
      "Targets a condition.",
      "Prioritizes the item.",
      "Rejects vigilance as a control.",
    ],
  },
  {
    id: "twenty-actions",
    question: "A postmortem produces twenty action items and the team has limited capacity. What do you do?",
    difficulty: 2,
    hints: [
      "Not every concern deserves prevention capacity.",
      "Separate the few recurrence-critical changes from the rest.",
    ],
    answer:
      "I group the items by the contributing factor they address, then keep the small set that changes the conditions capable of producing the incident. Each kept item gets an owner, a date, and a verification. The rest go to a separate list with a stated reason for deferral, not silently dropped. I reserve capacity for the kept items and review them at planning. The goal is not to close twenty items; it is to change the conditions that matter.",
    followUps: [
      "How do you explain the cut list to the incident responders?",
      "What if a cut item is cheap to do?",
      "Who decides what is recurrence-critical?",
    ],
    redFlags: [
      "Keeps all twenty and hopes.",
      "Cuts without recording the reason.",
      "Prioritizes by ease.",
    ],
    rubric: [
      "Groups by contributing factor.",
      "Keeps a small risk-based set.",
      "Records deferrals.",
      "Reserves capacity.",
    ],
  },
  {
    id: "owner-versus-team",
    question: "Why is a team name not an owner for an action item?",
    difficulty: 2,
    hints: [
      "Ownership is about the next step, not the whole job.",
      "A group can assume someone else will start.",
    ],
    answer:
      "A team name distributes responsibility until no one is accountable for the next step. A named person can be asked what happens next, when, and what evidence will prove it. That person does not have to do every hour of the work; they own the sequence and the date. If the owner changes, the tracker changes with them. Shared ownership is fine for execution, but not for accountability.",
    followUps: [
      "What if the owner leaves the company?",
      "Can a manager be the owner?",
      "How do you handle an action that needs three teams?",
    ],
    redFlags: [
      "Assigns to a team alias.",
      "Confuses ownership with doing all the work.",
      "Leaves ownership implicit.",
    ],
    rubric: [
      "Explains accountability for the next step.",
      "Keeps one named person.",
      "Allows shared execution.",
      "Handles owner changes.",
    ],
  },
  {
    id: "verification",
    question: "How do you verify that an action item actually reduced recurrence risk?",
    difficulty: 3,
    hints: [
      "A merged change is not evidence of effect.",
      "Use a signal that would have caught the original failure.",
    ],
    answer:
      "I define the verification before the work starts: the signal that should change, the test that should pass, or the scenario that should no longer fail. For a runbook change, that might be a rehearsal where the new check catches the stale topology. For an alert, it might be a replay of the original signal. A merged change proves activity. The verification should show that the failure condition is now detected, prevented, or bounded.",
    followUps: [
      "What if the original failure cannot be replayed?",
      "How long do you monitor after closing?",
      "Who reviews the evidence?",
    ],
    redFlags: [
      "Accepts a merged pull request.",
      "Has no pre-defined signal.",
      "Closes on a status update.",
    ],
    rubric: [
      "Defines verification before work.",
      "Links evidence to the failure condition.",
      "Distinguishes activity from effect.",
      "Names a review step.",
    ],
  },
];

const checklist = [
  {
    title: "Before the action is accepted",
    items: [
      "The item names the contributing factor it changes.",
      "One person is accountable for the next step and the date.",
      "The verification is written before the work starts.",
      "The item is prioritized against other prevention work, not appended to a flat list.",
    ],
  },
  {
    title: "During the work",
    items: [
      "The owner reports the next step, not only the status.",
      "Blocked items are escalated before the due date, not after.",
      "Scope changes are recorded with the reason.",
      "The verification is run against the original failure scenario.",
    ],
  },
  {
    title: "After the work",
    items: [
      "The evidence is linked to the item and reviewed by someone else.",
      "The item closes only when the verification has been observed.",
      "The contributing factor is marked as addressed or still open.",
      "The next planning cycle revisits the high-risk items first.",
    ],
  },
];

const references = [
  {
    title: "Postmortem Culture",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Postmortem review practices, action quality, and organizational learning.",
  },
  {
    title: "Postmortem Culture: Learning from Failure",
    url: "https://sre.google/sre-book/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Blameless review and the role of written follow-up in preventing recurrence.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "action-items": {
      model: actionItemModel,
      presets,
      instructions:
        "Start Healthy, then apply Flat backlog. Watch the high-risk track and the due date before the queue depth. Add capacity, owners, and priority one change at a time.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one day; capacity and completion rates are teaching assumptions, not planning guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-blameless-postmortems",
    "reliability-postmortem-actions",
    "reliability-incident-review",
    "reliability-checklists",
  ],
};
