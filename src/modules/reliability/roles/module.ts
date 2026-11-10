import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "responderCount",
    label: "People available",
    min: 3,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Staffing",
    help: "People who can take a role. Availability is not the same as coverage; a person can hold only so much.",
    format: "count",
  },
  {
    id: "roleCoverage",
    label: "Explicit role coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Roles",
    help: "Share of command, operations, communications, and SME responsibilities assigned to a named person.",
    format: "percent",
  },
  {
    id: "smeUpdateLoad",
    label: "SME pulled into updates",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Roles",
    help: "Share of communications work given to the subject-matter expert instead of a communications owner.",
    format: "percent",
  },
  {
    id: "handoffDiscipline",
    label: "Handoff discipline",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Roles",
    help: "Share of actions handed over with an owner, a next step, and an acknowledgement.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface RoleState {
  missedActions: number;
}

const INITIAL: RoleState = { missedActions: 0 };

function readState(frame: SimFrame): RoleState {
  return { missedActions: Math.max(0, Number(frame.flags.roleMissedActions ?? 0)) };
}

interface Values {
  responders: number;
  coverage: number;
  smeLoad: number;
  handoff: number;
  filledRoles: number;
  overloaded: number;
  roleGap: number;
  missedActions: number;
  smeWait: number;
  projected: number;
}

function compute(p: Params, state: RoleState): Values {
  const responders = Math.max(1, Math.round(num(p, "responderCount", 6)));
  const coverage = clamp(num(p, "roleCoverage", 100), 0, 100);
  const smeLoad = clamp(num(p, "smeUpdateLoad", 0), 0, 100);
  const handoff = clamp(num(p, "handoffDiscipline", 100), 0, 100);
  const filledRoles = clamp(Math.round((4 * coverage) / 100), 0, 4);
  const overloaded = Math.max(0, filledRoles - responders) + (smeLoad > 50 ? 1 : 0);
  const roleGap = clamp(100 - coverage, 0, 100);
  const smeWait = clamp(smeLoad * 0.2 + overloaded * 3, 0, 100);
  const projected =
    16 +
    roleGap * 0.22 +
    overloaded * 6 +
    state.missedActions * 4 +
    smeWait * 1.1 +
    Math.max(0, 4 - responders) * 4 +
    (1 - handoff / 100) * 12;
  return {
    responders,
    coverage,
    smeLoad,
    handoff,
    filledRoles,
    overloaded,
    roleGap,
    missedActions: Math.floor(state.missedActions),
    smeWait,
    projected: clamp(projected, 0, 180),
  };
}

function advance(state: RoleState, p: Params, dt: number): RoleState {
  const values = compute(p, state);
  const missedRate =
    ((4 - values.filledRoles) * 0.045 +
      values.overloaded * 0.06 +
      (values.smeLoad / 100) * 0.03) *
    (1 - (values.handoff / 100) * 0.7);
  let missedActions = state.missedActions + Math.max(0, missedRate) * Math.max(0, dt);
  if (values.roleGap < 10 && values.smeLoad < 10) {
    missedActions = Math.max(0, missedActions - 0.05 * Math.max(0, dt));
  }
  return { missedActions };
}

function buildFrame(p: Params, state: RoleState, seed: number): SimFrame {
  const values = compute(p, state);
  const commandHealth: "ok" | "warn" | "crit" =
    values.coverage < 50 ? "crit" : values.coverage < 80 ? "warn" : "ok";
  const commsHealth: "ok" | "warn" | "crit" =
    values.smeLoad >= 70 ? "crit" : values.smeLoad >= 40 ? "warn" : "ok";
  const smeHealth: "ok" | "warn" | "crit" =
    values.smeWait >= 15 ? "crit" : values.smeWait >= 8 ? "warn" : "ok";
  const taskHealth: "ok" | "warn" | "crit" =
    values.missedActions >= 3 ? "crit" : values.missedActions >= 1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "commander",
        label: "Incident commander",
        kind: "service",
        health: commandHealth,
        utilization: clamp(0.3 + (1 - values.coverage / 100) * 0.55),
        sublabel: values.coverage >= 80 ? "one plan" : "role unclear",
        detail: `The commander holds the plan and the decisions. Explicit coverage is ${values.coverage.toFixed(0)}% across the four response roles.`,
        meta: { view: "flow" },
      },
      {
        id: "ops",
        label: "Operations lead",
        kind: "worker",
        health: commandHealth,
        utilization: clamp(0.3 + (1 - values.coverage / 100) * 0.45),
        sublabel: values.filledRoles >= 2 ? "work sequenced" : "work unowned",
        detail: "The operations lead sequences changes and owns the technical action list. If this role is empty, actions are mentioned but not owned.",
        meta: { view: "flow" },
      },
      {
        id: "comms",
        label: "Communications",
        kind: "service",
        health: commsHealth,
        utilization: clamp(0.2 + (values.smeLoad / 100) * 0.7),
        sublabel: values.smeLoad > 50 ? "covered by SME" : "owned",
        detail: `A communications owner writes for the audience. When the SME writes updates instead, the expert's attention is split.`,
        meta: { view: "flow" },
      },
      {
        id: "sme",
        label: "Database expert",
        kind: "worker",
        health: smeHealth,
        utilization: clamp(0.3 + values.smeWait / 40),
        sublabel: values.smeWait >= 8 ? `${values.smeWait.toFixed(0)} min unavailable` : "on the fix",
        detail: "The subject-matter expert supplies deep evidence and a recommended fix. Their value is technical depth, not coordination throughput.",
        meta: { view: "flow" },
      },
      {
        id: "actions",
        label: "Action list",
        kind: "storage",
        health: taskHealth,
        utilization: clamp(0.2 + values.missedActions * 0.12),
        sublabel: `${values.missedActions.toFixed(1)} missed`,
        detail: "An action without an owner is a sentence, not a task. Missed actions are the visible cost of role overlap.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("commander-ops", "commander", "ops", values.coverage / 100, commandHealth),
      edge("commander-comms", "commander", "comms", values.coverage / 100, commsHealth),
      edge("ops-sme", "ops", "sme", values.coverage / 100, smeHealth),
      edge("comms-sme", "comms", "sme", values.smeLoad / 100, smeHealth),
      edge("ops-actions", "ops", "actions", values.handoff / 100, taskHealth),
    ],
    metrics: [
      metric("role-gap", "Role coverage gap", values.roleGap, "%", 20, 40, "percent"),
      metric("missed-actions", "Missed action count", values.missedActions, "", 1, 3, "count"),
      metric("sme-wait", "SME unavailable for technical work", values.smeWait, " min", 8, 15, "number"),
      metric("overloaded-responders", "Overloaded responder count", values.overloaded, "", 1, 2, "count"),
      metric("projected-resolution", "Projected time to resolution", values.projected, " min", 40, 70, "number"),
    ],
    events: [
      {
        id: "roles-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared",
        detail: `${values.responders} people are available. The first decision is which four responsibilities have a named owner and which are combined.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), roleMissedActions: state.missedActions },
    summary: `${values.overloaded} overloaded responder(s), ${values.missedActions.toFixed(1)} missed actions, SME unavailable ${values.smeWait.toFixed(0)} min.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.97 + 0.05 * Math.sin((index + phase) / 2.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "role-gap",
    metricId: "role-gap",
    warn: 20,
    crit: 40,
    title: "A response role has no explicit owner",
    cause:
      "Roles are being filled by whoever is closest to the work. Empty roles do not disappear; they are absorbed silently by people who already have a job.",
    fix:
      "Name a person for command, operations, communications, and the SME. If you cannot fill every role, state which one is combined and what will be dropped first.",
    checkFirst: [
      "List the four roles and the name beside each one.",
      "Find the role that is being covered by the busiest person.",
      "Check which action has no owner in the action list.",
    ],
  },
  {
    id: "missed-actions",
    metricId: "missed-actions",
    warn: 1,
    crit: 3,
    title: "A critical action lost its owner",
    cause:
      "Handoffs happen in conversation without a named recipient or acknowledgement. The task is repeated, then dropped when attention moves to the next hypothesis.",
    fix:
      "Write the action with one owner and one next step, read it back, and confirm the owner accepts it. Review open actions at every command update.",
    checkFirst: [
      "Search the channel for the action and see whether it was acknowledged.",
      "Check whether two people thought the other one owned it.",
      "Check whether the action is still relevant or should be closed.",
    ],
  },
  {
    id: "sme-wait",
    metricId: "sme-wait",
    warn: 8,
    crit: 15,
    title: "The subject-matter expert is unavailable for technical work",
    cause:
      "The expert is also writing updates, answering leadership, or coordinating. Each context switch adds queueing time to the technical fix.",
    fix:
      "Move communications and coordination off the SME. Give the expert one technical question at a time with the evidence attached, and let the commander handle status.",
    checkFirst: [
      "Check who is writing the last few stakeholder updates.",
      "Check how many meetings or threads the expert is in.",
      "Check whether the expert's last technical action has a completion time.",
    ],
  },
  {
    id: "overloaded-responders",
    metricId: "overloaded-responders",
    warn: 1,
    crit: 2,
    title: "A responder is holding more than one active role",
    cause:
      "There are fewer people than roles, or the roles were never separated. One person is now the technical expert and the communications owner, and both jobs lose.",
    fix:
      "Decide which role the person keeps. Fill the other with another responder, a deputy, or an escalation. On a small incident, write down the combination and its limit.",
    checkFirst: [
      "Check the role roster against the people actually active.",
      "Check whether the overloaded person is the only one with the technical context.",
      "Check whether the incident has grown beyond the original staffing assumption.",
    ],
  },
  {
    id: "projected-resolution",
    metricId: "projected-resolution",
    warn: 40,
    crit: 70,
    title: "Role overlap is extending the resolution",
    cause:
      "Coordination work is being charged to the technical expert. The fix is understood but not progressing because the person who can validate it is writing updates.",
    fix:
      "Separate the roles before adding more people. In this model, projected resolution is driven by role gap, missed actions, and SME unavailability; a communications owner reduces the SME wait and missed handoffs.",
    checkFirst: [
      "Check whether the critical path is technical or coordination work.",
      "Check whether the expert is waiting on information or on their own availability.",
      "Check whether the action list has owners or only descriptions.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const rolesModel: SimModel = {
  id: "reliability-roles",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), INITIAL, seed),
  step: (frame, p, dt, rng) => {
    const state = advance(readState(frame), p, dt);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, state, seed);
    const values = compute(p, state);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    next.events =
      frame.flags.paramsKey === JSON.stringify(p) ? frame.events.slice(-60) : next.events;
    if (values.smeLoad >= 70 && frame.flags.roleSmeEvent !== 1) {
      pushEvent(next, {
        id: "roles-sme-borrowed",
        at: frame.t,
        severity: "crit",
        title: "The subject-matter expert is also writing updates",
        detail: `The database expert is spending time on communications work. SME availability for the technical fix is ${values.smeWait.toFixed(0)} minutes.`,
        nodeId: "sme",
        metricId: "sme-wait",
      });
      next.flags.roleSmeEvent = 1;
    }
    if (values.missedActions >= 1 && frame.flags.roleMissedEvent !== 1) {
      pushEvent(next, {
        id: "roles-action-dropped",
        at: frame.t,
        severity: "warn",
        title: "An action was mentioned but never owned",
        detail: "The handoff lacked a named recipient or an acknowledgement. The task was repeated and then dropped.",
        nodeId: "actions",
        metricId: "missed-actions",
      });
      next.flags.roleMissedEvent = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.nodes = next.nodes.map((node) => ({
      ...node,
      utilization: clamp((node.utilization ?? 0) + rng.between(-0.004, 0.004)),
    }));
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, readState(frame));
    return [
      `Role coverage gap is ${values.roleGap.toFixed(0)}%; ${values.filledRoles} of 4 roles are explicitly filled by ${values.responders} people.`,
      `${values.overloaded} responder(s) hold more than one active role. The cost appears as ${values.smeWait.toFixed(0)} minutes of SME unavailability.`,
      `${values.missedActions.toFixed(1)} actions have been dropped or left unowned; handoff discipline is ${values.handoff.toFixed(0)}%.`,
      `Projected resolution is ${values.projected.toFixed(0)} minutes. The projection is driven by role coverage, missed actions, and SME availability, not by headcount alone.`,
    ];
  },
  legend: [
    { label: "Roles distinct", tone: "ok" },
    { label: "Role overlap", tone: "warn" },
    { label: "Expert consumed", tone: "crit" },
    { label: "Unowned work", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Six people, four explicit roles, and handoffs that name an owner.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Four people and three of four roles filled. The SME is partly borrowed for updates.",
    tone: "warn",
    params: defaults({ responderCount: 4, roleCoverage: 75, smeUpdateLoad: 50, handoffDiscipline: 70 }),
  },
  {
    id: "failure",
    label: "Expert on comms",
    description: "Five people, but only one of four roles is explicit. The database expert is writing updates and the action list is leaking.",
    tone: "crit",
    params: defaults({ responderCount: 5, roleCoverage: 25, smeUpdateLoad: 90, handoffDiscipline: 20 }),
  },
  {
    id: "combined-roles",
    label: "Two roles, one person",
    description: "Three of four roles are filled, but the expert is also the communications owner.",
    tone: "crit",
    params: defaults({ responderCount: 5, roleCoverage: 75, smeUpdateLoad: 100, handoffDiscipline: 80 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Four distinct roles, six people, and handoffs with an owner and an acknowledgement.",
    tone: "ok",
    params: defaults({ responderCount: 6, roleCoverage: 100, smeUpdateLoad: 0, handoffDiscipline: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-expert-overload",
  title: "Predict the cost of borrowing the expert",
  simId: "roles",
  question:
    "The database expert is the only person who can validate the fix, and the same expert is writing customer updates. What is the first measurable cost?",
  prediction: {
    options: [
      { id: "sme-wait", label: "The expert becomes unavailable for the technical fix" },
      { id: "better-updates", label: "Updates improve because the expert knows the system" },
      { id: "no-cost", label: "Nothing; context switching is cheaper than staffing another role" },
      { id: "database", label: "The database gets faster because fewer people are querying it" },
    ],
    correctOptionId: "sme-wait",
    explanation:
      "Role overlap charges coordination work to the person with the least available attention. The expert's technical queue grows while updates are drafted, so SME unavailability rises before the action list visibly leaks. Updates may also get slower, not better, because the expert is not a trained communications owner.",
  },
  setup: defaults({ responderCount: 5, roleCoverage: 75, smeUpdateLoad: 100, handoffDiscipline: 80 }),
  runFor: 45,
  observe: [
    "SME unavailability crosses its warning threshold while the expert is still writing updates.",
    "Overloaded responders stays above zero because the communications role is being absorbed.",
    "Missed actions accumulate as handoffs happen in conversation without a named owner.",
    "Projected resolution rises even though the technical hypothesis has not changed.",
  ],
  explain:
    "The expert is not slow. The expert is queueing. Every update, leadership question, and coordination request takes the same person away from the technical path. A separate communications owner is not a luxury on a critical incident; it is the mechanism that keeps the expert on the critical path. Handoff discipline decides whether the rest of the action list survives the split.",
  fix: defaults({ responderCount: 6, roleCoverage: 100, smeUpdateLoad: 0, handoffDiscipline: 100 }),
  debrief:
    "With a dedicated communications owner and explicit roles, SME unavailability falls and missed actions stop accumulating. The tradeoff is that another responder is now coordinating instead of debugging, and the communications owner must learn enough context to write accurate updates. That is cheaper than making the critical expert a part-time writer.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An incident role is a responsibility with a decision scope, not a job title. The common set is command, operations, communications, and subject-matter expertise. Command owns the plan and the decisions. Operations owns the sequence of technical work. Communications owns what the rest of the organization and the customer hear. The subject-matter expert (SME) owns deep technical evidence and a recommended fix.",
  },
  {
    type: "p",
    text: "A role can be held by any qualified person, and the person can change during the incident. What must not change silently is the responsibility. When a role has no name, it is absorbed by the nearest person. That person may be the only database expert, the only one with production access, or the only one who understands the customer impact. The incident then queues behind one person's attention.",
  },
  {
    type: "p",
    text: "Combining roles is legitimate on a small incident. One person can coordinate and work the fix when the impact is limited, the expected duration is short, and there is little parallel work. The combination becomes a failure when the incident grows, when the roles compete for the same minutes, or when the combined person is also the critical path. The point is not to fill four seats. The point is to know which responsibility is being traded away.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Roles sit inside incident command. Command decides the priority; roles turn that priority into owned work. They sit above the tools: the pager gets the right people into the channel, dashboards supply evidence, and runbooks supply steps. None of those tools decides who writes the update or who validates the fix.",
  },
  {
    type: "table",
    headers: ["Role", "Question it answers", "Typical failure when empty"],
    rows: [
      ["Command", "What are we protecting first, and who decides?", "Responders pursue competing priorities"],
      ["Operations", "In what order do we change the system?", "Two changes collide or a rollback races a fix"],
      ["Communications", "What do support and customers know, and when?", "Stakeholders escalate or invent updates"],
      ["SME", "What does the evidence actually mean?", "The team fixes symptoms without the critical context"],
    ],
  },
  {
    type: "p",
    text: "This module's numbers are illustrative. The role set is common in incident-response practice, but organizations differ in how they name and combine roles. The model compresses one incident minute into one simulated second so the queueing effect is visible quickly.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Role coverage gap: how much of the four-role set has no explicit owner.",
      "SME unavailable for technical work: the queueing cost of borrowing the expert for updates.",
      "Overloaded responders: people holding more than one active role.",
      "Missed actions: tasks that were mentioned but never assigned and acknowledged.",
      "Projected resolution: the technical path plus the coordination work attached to it.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Expert on comms. Watch SME unavailability before the missed-action count. Apply Combined roles to see the same expert holding two jobs with better handoffs, then compare. Run the experiment before reading the debrief.",
  },
  {
    type: "compare",
    leftTitle: "Role as a title",
    rightTitle: "Role as a responsibility",
    rows: [
      { label: "Assignment", left: "Who is senior or available", right: "Who owns the decision scope" },
      { label: "Overlap", left: "Absorbed silently by the busiest person", right: "Named, limited, and reviewed" },
      { label: "Handoff", left: "Mentioned in the channel", right: "Owner, next step, acknowledgement" },
      { label: "Scaling", left: "Add people and hope", right: "Split roles before attention splits" },
    ],
  },
  { type: "sim", simId: "roles" },
  { type: "experiment", experimentId: "predict-expert-overload" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The database expert was the only person who could validate the fix, and the same expert was writing customer updates. The expert did not fail; the expert queued. Every update and leadership question took the same attention that the technical path needed. SME unavailability rose before the action list visibly leaked, because the queue was hidden inside one person's calendar.",
  },
  {
    type: "p",
    text: "Handoff discipline determined how much of the rest of the work survived. With weak handoffs, actions were mentioned, repeated, and dropped. With explicit roles and a dedicated communications owner, the expert stayed on the critical path and the action list had owners instead of descriptions.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Incident channel: the SME is answering status questions, writing updates, and asking someone else to run the query they wanted to run themselves.",
      "Paging tool: the same person is listed as responder and as the communications contact, or no communications contact exists.",
      "Action list: tasks written as sentences without a name, or tasks assigned to a team rather than a person.",
      "Meeting or call: the expert joins every bridge because no one else can translate the technical state.",
      "Support queue: updates are delayed or inconsistent because the person writing them is also debugging.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the person who is on the critical path and list every other role they hold. If the communications role is one of them, move it first. Then check the action list for tasks without a named owner and confirm the handoff was acknowledged.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Name the four responsibilities and the person holding each one. Write it in the channel.",
      "Move communications off the SME. A communications owner can use a short technical brief from the expert.",
      "Give the SME one question at a time with the evidence attached, and protect their focus from status requests.",
      "Write every handoff with an owner, a next step, and a time; ask the owner to acknowledge it.",
      "If the incident grows, split combined roles before adding more responders.",
      "After recovery, review which role was empty and which handoff was dropped, then add both to the exercise.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A dedicated communications owner costs one responder who is not debugging, but protects the expert and the update cadence.",
      "Combining roles on a small incident is faster than staffing a full structure, as long as the combination is stated and timeboxed.",
      "An SME who writes the update may produce more accurate technical detail, but the update is later and the fix is slower.",
      "More responders do not fix role gaps. The model's projection is driven by ownership and missed actions, not headcount; role overlap still consumes the expert.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "expert-writes-updates",
    question:
      "The database expert is also writing customer updates and misses the fix. How do you staff the incident?",
    difficulty: 2,
    hints: [
      "The expert is queueing, not underperforming.",
      "Move the role, not the person.",
    ],
    answer:
      "I would separate the communications role from the SME. The expert keeps the technical question and the fix validation; a communications owner takes the updates with a short technical brief. I would also name an operations lead to sequence the technical work and confirm the action list has one owner per item. If no one else can write updates, I would reduce the cadence rather than make the expert write every update, and I would escalate for another responder.",
    followUps: [
      "What if the expert is the only one who can explain the impact?",
      "How do you brief the communications owner quickly?",
      "When would you combine the roles anyway?",
    ],
    redFlags: [
      "Tells the expert to work faster.",
      "Adds another meeting for the expert.",
      "Leaves communications with the busiest person.",
    ],
    rubric: [
      "Names the role conflict.",
      "Moves communications off the SME.",
      "Keeps the expert on the critical path.",
      "Defines a handoff or escalation.",
    ],
  },
  {
    id: "combine-roles",
    question:
      "When can one person hold two incident roles, and what has to be true for that to be safe?",
    difficulty: 2,
    hints: [
      "Small incident, short duration, limited parallel work.",
      "The combination must be explicit and reviewable.",
    ],
    answer:
      "One person can hold two roles when the incident is small, the expected duration is short, and there is little parallel technical work. The combination has to be explicit: the person states which role they are acting in at each decision, and someone still owns the next update. It stops being safe when the incident grows, when the two roles compete for the same minutes, or when the person is also the only one who can validate the fix. At that point, split the roles or escalate for another responder.",
    followUps: [
      "Which combinations are safest?",
      "Which combination is most dangerous?",
      "What signal tells you to split?",
    ],
    redFlags: [
      "Says roles are optional on small incidents.",
      "Combines roles without saying so.",
      "Waits for a failure before splitting.",
    ],
    rubric: [
      "Conditions the combination on impact and duration.",
      "Requires explicit ownership.",
      "Names a split trigger.",
      "Preserves communications ownership.",
    ],
  },
  {
    id: "three-people",
    question:
      "Only three people are available for a critical incident. How do you assign roles?",
    difficulty: 3,
    hints: [
      "You cannot fill four roles with three people without a combination.",
      "Protect the critical path and the update cadence first.",
    ],
    answer:
      "I would assign command, operations, and communications to three named people and treat the SME as a consulted role rather than a fourth seat. If one of the three is the only SME, I would keep that person on the technical path and have the commander or communications owner absorb coordination. I would write down the combination, set a review point, and escalate for another responder early. The goal is not to cover every title; it is to make sure the critical path and the update cadence both have an owner.",
    followUps: [
      "Who writes the updates if the communications owner is also the commander?",
      "When do you escalate for more people?",
      "What do you stop doing first?",
    ],
    redFlags: [
      "Assigns all roles to the most senior person.",
      "Leaves the update cadence to chance.",
      "Waits until the incident is already failing.",
    ],
    rubric: [
      "Names three explicit owners.",
      "Protects the SME's technical focus.",
      "States the combination and its limit.",
      "Plans an escalation.",
    ],
  },
  {
    id: "handoff-quality",
    question:
      "What makes an incident handoff reliable, and how do you know it worked?",
    difficulty: 3,
    hints: [
      "A handoff is a transfer of ownership, not a message.",
      "The receiver must restate and accept the responsibility.",
    ],
    answer:
      "A reliable handoff names the owner, the next action, the time, and the context needed to act. The receiver restates the responsibility and accepts it, and the sender confirms that ownership moved. For a role handoff, I add the current plan, decisions made, open risks, and the next update time. I know it worked when the receiver can act without asking the sender for the basic context, and when the action list shows the new owner. A handoff that ends with 'let me know if you need anything' is not a handoff.",
    followUps: [
      "How do you hand off during a fast-moving incident?",
      "What if the receiver disagrees with the plan?",
      "How do you record the handoff?",
    ],
    redFlags: [
      "Treats a channel message as a handoff.",
      "Leaves ownership ambiguous.",
      "Forgets the next update time.",
    ],
    rubric: [
      "Names owner, action, time, and context.",
      "Requires acknowledgement.",
      "Transfers the plan and open risks.",
      "Verifies with the action list.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The four response roles are defined in the on-call playbook.",
      "Responders know which roles can be combined and which cannot.",
      "The incident channel has a place to write the role roster.",
      "Handoffs have a template: owner, next step, time, context.",
      "The paging tool shows who is responding and who is communicating.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Write the role roster and keep it current as people join or leave.",
      "Keep the SME on the technical path; route status requests through communications.",
      "Write every action with one owner and confirm the handoff.",
      "Review combined roles when the incident grows or the critical path moves.",
      "Escalate for another responder before the expert becomes the bottleneck.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Review which role was empty and which action was dropped.",
      "Check whether the expert was also coordinating or communicating.",
      "Add the role gap and the handoff failure to the postmortem.",
      "Exercise the combination and split in the next on-call drill.",
    ],
  },
];

const references = [
  {
    title: "Incident Response: Different roles",
    url: "https://response.pagerduty.com/before/different_roles/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Role definitions for incident commander, deputy, scribe, subject-matter expert, and customer liaison.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Role separation, command, and coordination during incident response.",
  },
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "On-call load, context switching, and the cost of interrupting technical work.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    roles: {
      model: rolesModel,
      presets,
      instructions:
        "Start Healthy, apply Expert on comms, and compare SME unavailability with missed actions. Then apply Combined roles to see the effect of better handoffs without a dedicated communications owner.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; role coverage and timing values are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["reliability-incident-command", "reliability-comms-cadence", "reliability-escalation"],
};
