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
    label: "Responders in channel",
    min: 2,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Staffing",
    help: "Engineers actively investigating. More responders add parallel hypotheses and coordination load.",
    format: "count",
  },
  {
    id: "commandCoverage",
    label: "Incident commander coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Roles",
    help: "Share of the incident with one named commander who owns priorities and decisions.",
    format: "percent",
  },
  {
    id: "opsCoverage",
    label: "Operations lead coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Roles",
    help: "Share of technical work routed through one owner who sequences changes.",
    format: "percent",
  },
  {
    id: "commsCoverage",
    label: "Communications owner coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Roles",
    help: "Share of updates written by a named owner instead of borrowed from a responder.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface CmdState {
  sinceUpdate: number;
  conflicts: number;
  unowned: number;
}

const INITIAL: CmdState = { sinceUpdate: 0, conflicts: 0, unowned: 0 };

function readState(frame: SimFrame): CmdState {
  return {
    sinceUpdate: Math.max(0, Number(frame.flags.cmdSinceUpdate ?? 0)),
    conflicts: Math.max(0, Number(frame.flags.cmdConflicts ?? 0)),
    unowned: Math.max(0, Number(frame.flags.cmdUnowned ?? 0)),
  };
}

function stateFlags(state: CmdState): Record<string, number> {
  return {
    cmdSinceUpdate: state.sinceUpdate,
    cmdConflicts: state.conflicts,
    cmdUnowned: state.unowned,
  };
}

function advance(state: CmdState, p: Params, dt: number): CmdState {
  const responders = Math.max(1, Math.round(num(p, "responderCount", 6)));
  const command = num(p, "commandCoverage", 100) / 100;
  const ops = num(p, "opsCoverage", 100) / 100;
  const comms = num(p, "commsCoverage", 100) / 100;

  const cadence = comms <= 0 ? Number.POSITIVE_INFINITY : 8 + (1 - comms) * 12;
  let sinceUpdate = state.sinceUpdate + Math.max(0, dt);
  if (Number.isFinite(cadence) && sinceUpdate >= cadence) sinceUpdate = 0;

  const conflictRate = Math.max(0, 0.02 * responders * (1 - 0.55 * command - 0.45 * ops));
  let conflicts = state.conflicts + conflictRate * Math.max(0, dt);
  if (command > 0.9 && ops > 0.9) {
    conflicts = Math.max(0, conflicts - 0.1 * Math.max(0, dt));
  }

  const unownedRate = Math.max(0, 0.025 * responders * (1 - command));
  let unowned = state.unowned + unownedRate * Math.max(0, dt);
  if (command > 0.9) unowned = Math.max(0, unowned - 0.08 * Math.max(0, dt));

  return { sinceUpdate, conflicts, unowned };
}

interface Values {
  command: number;
  ops: number;
  comms: number;
  responders: number;
  sinceUpdate: number;
  conflicts: number;
  unowned: number;
  roleGap: number;
  projected: number;
}

function compute(p: Params, state: CmdState): Values {
  const command = num(p, "commandCoverage", 100) / 100;
  const ops = num(p, "opsCoverage", 100) / 100;
  const comms = num(p, "commsCoverage", 100) / 100;
  const responders = Math.max(1, Math.round(num(p, "responderCount", 6)));
  const roleGap = clamp(100 - (command * 0.45 + ops * 0.35 + comms * 0.2) * 100, 0, 100);
  const responderLoad = responders * 0.8 * Math.max(0, 1 - command * 0.7 - ops * 0.3);
  const projected =
    16 +
    state.conflicts * 5 +
    state.unowned * 4 +
    (1 - command) * 12 +
    (1 - ops) * 10 +
    (1 - comms) * 8 +
    responderLoad;
  return {
    command,
    ops,
    comms,
    responders,
    sinceUpdate: state.sinceUpdate,
    conflicts: Math.floor(state.conflicts),
    unowned: Math.floor(state.unowned),
    roleGap,
    projected: clamp(projected, 0, 180),
  };
}

function coverageHealth(value: number, warnBelow: number, critBelow: number): "ok" | "warn" | "crit" {
  if (value < critBelow) return "crit";
  if (value < warnBelow) return "warn";
  return "ok";
}

function ageHealth(age: number, warnAt: number, critAt: number): "ok" | "warn" | "crit" {
  if (age >= critAt) return "crit";
  if (age >= warnAt) return "warn";
  return "ok";
}

function buildFrame(p: Params, state: CmdState, seed: number): SimFrame {
  const values = compute(p, state);
  const commanderHealth = coverageHealth(values.command, 0.8, 0.5);
  const opsHealth = coverageHealth(values.ops, 0.8, 0.5);
  const commsHealth = ageHealth(values.sinceUpdate, 10, 20);
  const commsCoverageHealth = coverageHealth(values.comms, 0.8, 0.5);
  const responderHealth: "ok" | "warn" | "crit" =
    values.conflicts >= 3 ? "crit" : values.conflicts >= 1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "commander",
        label: "Incident commander",
        kind: "service",
        health: commanderHealth,
        utilization: clamp(0.35 + (1 - values.command) * 0.55),
        sublabel: values.command >= 0.8 ? "direction owned" : "direction unclear",
        detail: `The commander owns priorities, decisions, and the shared plan. Command coverage is ${Math.round(values.command * 100)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "ops",
        label: "Operations lead",
        kind: "worker",
        health: opsHealth,
        utilization: clamp(0.3 + (1 - values.ops) * 0.5),
        sublabel: values.ops >= 0.8 ? "changes sequenced" : "changes unowned",
        detail: `The operations lead sequences technical work so two responders do not change the same system at once. Coverage is ${Math.round(values.ops * 100)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "comms",
        label: "Communications owner",
        kind: "service",
        health: commsHealth === "ok" ? commsCoverageHealth : commsHealth,
        utilization: clamp(0.25 + (1 - values.comms) * 0.5 + values.sinceUpdate / 80),
        sublabel: `${values.sinceUpdate.toFixed(0)} min since update`,
        detail: `A communications owner turns technical state into an update on a fixed cadence. Coverage is ${Math.round(values.comms * 100)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "responders",
        label: "Responders",
        kind: "worker",
        health: responderHealth,
        utilization: clamp(0.45 + values.conflicts * 0.12),
        sublabel: `${values.responders} investigating`,
        detail: `${values.responders} responders are active. Without sequencing, their changes overlap and the incident accumulates conflicting state.`,
        meta: { view: "flow" },
      },
      {
        id: "stakeholders",
        label: "Stakeholders",
        kind: "external",
        health: ageHealth(values.sinceUpdate, 10, 20),
        utilization: clamp(values.sinceUpdate / 40),
        sublabel: values.sinceUpdate >= 20 ? "escalating" : "waiting",
        detail: "Support, leadership, and customers do not see the incident channel. They see the updates they receive.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("commander-ops", "commander", "ops", values.command, commanderHealth),
      edge("commander-comms", "commander", "comms", values.command, commanderHealth),
      edge("ops-responders", "ops", "responders", values.ops, opsHealth),
      edge("comms-stakeholders", "comms", "stakeholders", values.comms, commsHealth),
    ],
    metrics: [
      metric("role-gap", "Role coverage gap", values.roleGap, "%", 30, 50, "percent"),
      metric("minutes-since-update", "Minutes since last update", values.sinceUpdate, " min", 10, 20, "number"),
      metric("conflicting-changes", "Conflicting change count", values.conflicts, "", 1, 3, "count"),
      metric("unowned-actions", "Unowned action count", values.unowned, "", 2, 4, "count"),
      metric("projected-mitigation", "Projected time to mitigate", values.projected, " min", 40, 70, "number"),
    ],
    events: [
      {
        id: "cmd-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared",
        detail: `${values.responders} responders are active. The first decision is who commands, who sequences changes, and who owns the next update.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), ...stateFlags(state) },
    summary: `${values.roleGap.toFixed(0)}% role gap, ${values.conflicts.toFixed(1)} conflicting changes, ${values.sinceUpdate.toFixed(0)} min since the last update.`,
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
    warn: 30,
    crit: 50,
    title: "Command, operations, or communications coverage is missing",
    cause:
      "No one is assigned to coordinate the response, sequence technical changes, or own updates. Capable responders then optimize their own hypotheses in parallel.",
    fix:
      "Name one incident commander, one operations lead, and one communications owner. The commander sets priorities and decisions; the operations lead sequences changes; the communications owner publishes updates.",
    checkFirst: [
      "List the three roles and the person currently holding each one.",
      "Check whether the commander is also the only person debugging.",
      "Check who wrote the last stakeholder update and when.",
    ],
  },
  {
    id: "minutes-since-update",
    metricId: "minutes-since-update",
    warn: 10,
    crit: 20,
    title: "Stakeholders have gone too long without an update",
    cause:
      "No communications owner is assigned, or the owner is also doing technical work. Updates stop when the person is pulled into debugging.",
    fix:
      "Move update ownership off the responders, set a fixed cadence, and publish even when the news is that nothing changed. Include impact, current action, and the next update time.",
    checkFirst: [
      "Check the last message to stakeholders and its timestamp.",
      "Check whether support has started inventing updates.",
      "Check whether the communications owner is also on the debugging call.",
    ],
  },
  {
    id: "conflicting-changes",
    metricId: "conflicting-changes",
    warn: 1,
    crit: 3,
    title: "Parallel changes are colliding",
    cause:
      "Multiple responders are changing the same service without a shared plan or a single operations owner. Each change is locally reasonable and globally conflicting.",
    fix:
      "Pause non-essential changes, route all changes through the operations lead, and record what changed and why. Keep one hypothesis and one change in flight at a time.",
    checkFirst: [
      "Compare the change log with the incident start time.",
      "Ask each responder what they changed in the last ten minutes.",
      "Check whether a rollback and a forward fix are running at the same time.",
    ],
  },
  {
    id: "unowned-actions",
    metricId: "unowned-actions",
    warn: 2,
    crit: 4,
    title: "Actions have no named owner",
    cause:
      "The commander is tracking work in conversation instead of assigning it. Tasks are mentioned, repeated, and then dropped when attention moves.",
    fix:
      "Write each action with one owner, one next step, and a time. Review the list at each command update and close or reassign items explicitly.",
    checkFirst: [
      "Ask who owns each open action, not which team owns it.",
      "Check whether the same task appears twice with different owners.",
      "Check whether an action has been waiting since before the last update.",
    ],
  },
  {
    id: "projected-mitigation",
    metricId: "projected-mitigation",
    warn: 40,
    crit: 70,
    title: "Projected time to mitigate is growing",
    cause:
      "Coordinating through ad hoc conversation costs more than the technical work. Conflicting changes and unowned actions extend the incident even when the fix is understood.",
    fix:
      "Stabilize the response before adding more investigators: assign roles, cap parallel changes, and timebox hypotheses. Then re-estimate mitigation from the current plan.",
    checkFirst: [
      "Check whether the team has one plan or several competing plans.",
      "Check how many changes are in flight.",
      "Check whether the last estimate was based on evidence or optimism.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const incidentCommandModel: SimModel = {
  id: "reliability-incident-command",
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
    if (values.command < 0.5 && frame.flags.cmdRoleEvent !== 1) {
      pushEvent(next, {
        id: "cmd-role-gap",
        at: frame.t,
        severity: "crit",
        title: "No incident commander assigned",
        detail: `${values.responders} responders are investigating without one coordinator. Conflicting changes and stale updates follow.`,
        nodeId: "commander",
        metricId: "role-gap",
      });
      next.flags.cmdRoleEvent = 1;
    }
    if (values.conflicts >= 1 && frame.flags.cmdConflictEvent !== 1) {
      pushEvent(next, {
        id: "cmd-conflicting-change",
        at: frame.t,
        severity: "warn",
        title: "Two responders changed the same service",
        detail: "An operations owner would have sequenced the work. The second change was reasonable on its own and conflicting in combination.",
        nodeId: "responders",
        metricId: "conflicting-changes",
      });
      next.flags.cmdConflictEvent = 1;
    }
    if (values.sinceUpdate >= 20 && frame.flags.cmdUpdateEvent !== 1) {
      pushEvent(next, {
        id: "cmd-update-overdue",
        at: frame.t,
        severity: "warn",
        title: "Stakeholder update is overdue",
        detail: "Support has no current statement to give customers. A communications owner with a fixed cadence prevents this gap.",
        nodeId: "stakeholders",
        metricId: "minutes-since-update",
      });
      next.flags.cmdUpdateEvent = 1;
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
      `Role coverage gap is ${values.roleGap.toFixed(0)}%. The gap is a coordination signal, not a headcount signal.`,
      `${values.responders} responders have produced ${values.conflicts.toFixed(1)} conflicting changes and ${values.unowned.toFixed(1)} unowned actions.`,
      `The last stakeholder update was ${values.sinceUpdate.toFixed(0)} minutes ago. A named communications owner resets this timer without pulling a responder off the fix.`,
      `Projected mitigation is ${values.projected.toFixed(0)} minutes. The projection includes coordination cost, so adding responders without roles can make it worse.`,
    ];
  },
  legend: [
    { label: "Coordinated", tone: "ok" },
    { label: "Degrading", tone: "warn" },
    { label: "Uncoordinated", tone: "crit" },
    { label: "No owner", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "One commander, one operations lead, one communications owner, and six responders.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Six responders with partial role coverage. The incident is busy but still coordinated.",
    tone: "warn",
    params: defaults({ responderCount: 6, commandCoverage: 70, opsCoverage: 70, commsCoverage: 60 }),
  },
  {
    id: "failure",
    label: "Parallel debugging",
    description: "Five engineers investigate with no commander, weak operations ownership, and no communications owner.",
    tone: "crit",
    params: defaults({ responderCount: 5, commandCoverage: 0, opsCoverage: 20, commsCoverage: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Name a commander, an operations lead, and a communications owner, then hold one plan.",
    tone: "ok",
    params: defaults({ responderCount: 5, commandCoverage: 100, opsCoverage: 100, commsCoverage: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-parallel-debugging",
  title: "Predict what parallel debugging costs",
  simId: "incident-command",
  question:
    "Five capable engineers are investigating with no incident commander, no operations lead, and no communications owner. Which failure appears first?",
  prediction: {
    options: [
      { id: "coordination", label: "Coordination degrades before the technical fix is understood" },
      { id: "capacity", label: "The database saturates because of the extra investigators" },
      { id: "self-organize", label: "Nothing changes; experienced engineers self-organize" },
      { id: "customers", label: "Customers notice before anyone inside the incident" },
    ],
    correctOptionId: "coordination",
    explanation:
      "Capability does not create a shared plan. Without one coordinator, each responder optimizes a local hypothesis. Changes collide and updates stop while everyone is technically busy. The model shows the coordination gap first, then accumulating conflicts and stale updates.",
  },
  setup: defaults({ responderCount: 5, commandCoverage: 0, opsCoverage: 20, commsCoverage: 0 }),
  runFor: 45,
  observe: [
    "The role coverage gap is critical from the first minute; the missing structure is visible before the technical cost.",
    "Conflicting changes pass the warning threshold within the first half of the run.",
    "Minutes since the last update pass the critical threshold while responders are still debugging.",
    "Projected mitigation time rises above the critical threshold even though no individual change is unreasonable.",
  ],
  explain:
    "An incident commander does not debug faster than five engineers. The commander maintains one plan, assigns actions, and decides what not to do. The operations lead sequences changes so two people do not alter the same system in opposite directions. The communications owner protects the update cadence. Remove those roles and the response spends its capacity on coordination it never assigned.",
  fix: defaults({ responderCount: 5, commandCoverage: 100, opsCoverage: 100, commsCoverage: 100 }),
  debrief:
    "With the three roles filled, the role gap closes, conflicts stop accumulating, and the update timer stays inside its cadence. The cost is real: one engineer is coordinating instead of debugging, and the commander must resist taking over the technical work. That cost is smaller than an unmanaged collision late in the incident.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Incident command is a temporary coordination structure for an active incident. It gives one person responsibility for the shared plan and the decisions, one person responsibility for sequencing technical work, and one person responsibility for communicating with everyone outside the response. The structure comes from emergency management and is used in software operations because fast-moving incidents create the same problem: many capable people, no single picture.",
  },
  {
    type: "p",
    text: "The incident commander (IC) is not the best debugger and does not own the root cause. The IC owns direction: what the team is trying to restore first, which hypothesis is being tested, which change is allowed, and when the team stops and reassesses. The operations lead turns that direction into ordered technical actions and keeps two changes from colliding. The communications owner turns the current state into updates for support, leadership, and customers.",
  },
  {
    type: "p",
    text: "Command is not the same as control. Responders still investigate, challenge assumptions, and propose fixes. What changes is that changes go through one sequence and one shared plan. A commander who suppresses technical debate creates a different failure; a commander who lets every responder act independently has no command at all.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Command starts after an incident is declared and before mitigation work fans out. It sits above observability, runbooks, and the paging tool rather than replacing them. Detection still comes from metrics, logs, and traces. The runbook still supplies known steps. Command decides who is doing what, in which order, and what the team is telling everyone else.",
  },
  {
    type: "table",
    headers: ["Role", "Owns", "Does not own"],
    rows: [
      ["Incident commander", "Priorities, decisions, shared plan, stopping bad changes", "Root cause, every technical action, every update draft"],
      ["Operations lead", "Sequence of technical work, change ownership, execution", "Stakeholder messaging, final severity call"],
      ["Communications owner", "Update cadence, audience-appropriate detail, status page", "Technical diagnosis, change approval"],
      ["Subject-matter expert", "Deep technical evidence and recommended fixes", "Coordination, updates, or the whole incident"],
    ],
  },
  {
    type: "p",
    text: "The demo is a teaching model, not a prescription for every organization. It compresses one incident minute into one simulated second so a long coordination failure is visible in under a minute. The role names are common in incident-response practice; the thresholds and timings are illustrative.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Role coverage gap: how much of command, operations, and communications ownership is missing.",
      "Minutes since the last stakeholder update, which rises when no one owns communications.",
      "Conflicting changes and unowned actions, which accumulate when changes and tasks have no single owner.",
      "Projected time to mitigate, which includes coordination cost rather than only technical difficulty.",
      "A flow view of the commander, operations lead, communications owner, responders, and stakeholders.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Parallel debugging. Watch the role gap and the update timer before the conflict count. Apply Recovery to see the same incident with the three roles filled. Run the experiment before reading the debrief, then change one role at a time and observe which metric responds.",
  },
  {
    type: "compare",
    leftTitle: "Debugging in parallel",
    rightTitle: "Incident command",
    rows: [
      { label: "Plan", left: "Every responder has a private hypothesis", right: "One shared plan, stated by the commander" },
      { label: "Changes", left: "Whoever gets there first", right: "Sequenced by the operations lead" },
      { label: "Updates", left: "Whoever is free, usually no one", right: "Named owner on a fixed cadence" },
      { label: "Failure mode", left: "Conflicting changes and silent stakeholders", right: "Command overhead and slower individual action" },
    ],
  },
  { type: "sim", simId: "incident-command" },
  { type: "experiment", experimentId: "predict-parallel-debugging" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Five engineers were investigating the same incident from five private models of the system. Each change was locally sensible. Together they collided, because no operations lead owned the sequence. The update timer kept climbing because no communications owner existed, and the responders were too busy to notice. The role coverage gap exposed the missing structure before the conflict count exposed its cost.",
  },
  {
    type: "p",
    text: "Adding command did not make the technical problem disappear. It changed who held the plan and who could authorize a change. Projected mitigation fell because the team stopped paying for coordination it had never assigned. The remaining time was technical work, not conflict repair.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Incident channel: several threads with competing hypotheses, repeated questions, and changes announced after they were made.",
      "Paging tool: one incident with many responders but no explicit commander, operations, or communications assignment.",
      "Change and deploy logs: two changes to the same service inside a short window, sometimes a rollback and a forward fix together.",
      "Support queue: tickets that repeat the last public statement, or support staff asking the incident channel for something they can tell customers.",
      "Status page and customer channels: an update older than the stated cadence, or no next-update time at all.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask who is commanding, who owns the change sequence, and who owns the next update. If the same person answers all three, the incident is one deep breath away from losing two of them. Then check the change log for overlapping changes.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Declare the incident and name one commander. The commander states the current priority and the next decision point.",
      "Name an operations lead and route every change through that person. Pause changes that are not protecting the customer.",
      "Name a communications owner and set the next update time. The owner writes for the audience, not from the raw channel.",
      "Write actions with one owner each, then review the list at every command update.",
      "Keep responders investigating, but require them to bring evidence and proposed changes to the commander and operations lead.",
      "After recovery, review which decisions lacked an owner and add those roles to the on-call playbook.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Command costs one experienced responder who is not debugging. On a small, short incident that cost may exceed the coordination benefit.",
      "A single commander can become a bottleneck if every decision must pass through them. Delegate technical sequencing to the operations lead.",
      "A communications owner can over-summarize and lose useful uncertainty. Updates should state what is known, what is not, and when the next update arrives.",
      "Too much structure on a small incident feels bureaucratic; too little on a large one creates conflicting changes. Match the structure to impact and expected duration.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "missing-role",
    question:
      "Five engineers are debugging and no one is communicating. Which role is missing, and what does that role do first?",
    difficulty: 2,
    hints: [
      "The missing role is not another debugger.",
      "Start with who owns the plan and the next update.",
    ],
    answer:
      "The incident commander role is missing, and usually the communications owner is missing with it. The commander first states the current customer impact, the priority, and the next decision point, then assigns an operations lead to sequence changes and a communications owner to publish on a cadence. The commander does not take over the debugging. The immediate value is one shared plan and one person allowed to say stop.",
    followUps: [
      "What if the most senior engineer is the best debugger?",
      "How does the commander avoid becoming a bottleneck?",
      "Who decides to roll back?",
    ],
    redFlags: [
      "Says the team needs another senior engineer.",
      "Treats command as the person who fixes the bug.",
      "Leaves communications with the responders.",
    ],
    rubric: [
      "Names incident command and communications ownership.",
      "Separates direction from technical execution.",
      "Assigns one owner for the change sequence.",
      "States what the commander does first.",
    ],
  },
  {
    id: "commander-versus-ops",
    question:
      "The operations lead recommends a rollback, but the commander is not sure. Who decides, and how do you keep the decision from stalling?",
    difficulty: 3,
    hints: [
      "The commander owns the decision, not the diagnosis.",
      "A decision needs a timebox and a fallback.",
    ],
    answer:
      "The commander decides. The operations lead supplies the technical recommendation, the evidence, and the risk of each option. The commander chooses the option that best protects the current priority, sets a time to reassess, and records the decision. If the commander cannot decide, that is a signal to narrow the options or set a decision deadline, not to let both changes run. The commander should not overrule technical evidence without naming the reason.",
    followUps: [
      "What if the commander lacks the technical context?",
      "How do you record a decision that is later reversed?",
      "When should the commander defer to the operations lead?",
    ],
    redFlags: [
      "Lets both options proceed in parallel.",
      "Says the most senior technical person always decides.",
      "Has no reassessment point.",
    ],
    rubric: [
      "Places decision authority with the commander.",
      "Keeps technical recommendation with operations.",
      "Timeboxes the decision and records it.",
      "Explains how to handle missing context.",
    ],
  },
  {
    id: "small-incident",
    question:
      "When can one person hold both the commander and operations roles, and what must still be explicit?",
    difficulty: 2,
    hints: [
      "Scale the structure to impact and expected duration.",
      "Even a combined role needs a named owner and an update time.",
    ],
    answer:
      "One person can hold both roles on a small incident with limited impact, a short expected duration, and little parallel work. Even then, the combined role must be explicit, the person must state which hat they are wearing at each decision, and someone must own the next stakeholder update. If the incident grows, split the roles before the change volume makes the combination unsafe. The rule is not a headcount threshold; it is whether coordination and technical work are competing for the same attention.",
    followUps: [
      "What signal tells you to split the roles?",
      "Can the commander also be the communications owner?",
      "How do you hand off when the incident grows?",
    ],
    redFlags: [
      "Says roles only matter for large incidents.",
      "Combines every role silently.",
      "Has no trigger for splitting.",
    ],
    rubric: [
      "Conditions the combination on impact and duration.",
      "Keeps ownership explicit.",
      "Names a split trigger.",
      "Preserves update ownership.",
    ],
  },
  {
    id: "handoff",
    question:
      "The commander has been awake for eighteen hours. How do you hand off command without losing the plan?",
    difficulty: 3,
    hints: [
      "A handoff is a structured transfer, not a greeting.",
      "Write down impact, decisions, actions, risks, and the next update.",
    ],
    answer:
      "I would run a short, structured handoff: current customer impact, the priority, what has been ruled out, decisions already made, changes in flight and their owners, open actions, known risks, and the next update time. The outgoing commander introduces the incoming one in the channel, the incoming one restates the plan and asks questions, and the channel acknowledges the change. The outgoing commander stays available for questions but stops making decisions. The record matters more than the ceremony.",
    followUps: [
      "What do you do if the incoming commander disagrees with the plan?",
      "How long should the handoff take?",
      "Who owns the update during the handoff?",
    ],
    redFlags: [
      "Leaves the plan in the outgoing commander's head.",
      "Lets both commanders decide at once.",
      "Forgets the next update time.",
    ],
    rubric: [
      "Transfers impact, decisions, actions, and risks.",
      "Makes the authority change explicit.",
      "Keeps one commander at a time.",
      "Preserves the update cadence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The on-call playbook names the commander, operations lead, and communications owner roles.",
      "Responders know where the incident channel is and who declares command.",
      "There is one change log location and a rule for routing changes through operations.",
      "There is an update template with impact, current action, and next update time.",
      "The paging tool shows who has acknowledged and who is responding.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Name the commander and state the current priority and next decision point.",
      "Name an operations lead and sequence changes; pause non-essential changes.",
      "Name a communications owner and set the next update time.",
      "Write every action with one owner and review the list at each command update.",
      "Record decisions, reversals, and the evidence behind them.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Review whether the three roles were filled for the whole incident.",
      "Look for overlapping changes and the time they cost.",
      "Compare the promised update cadence with the actual updates.",
      "Add the missing role to the next on-call exercise and the postmortem actions.",
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
    note: "Incident command principles, role separation, and coordination during an active incident.",
  },
  {
    title: "During an Incident",
    url: "https://response.pagerduty.com/during/during_an_incident/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Operational practices for running an incident and keeping communication moving.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "incident-command": {
      model: incidentCommandModel,
      presets,
      instructions:
        "Start Healthy, apply Parallel debugging, and watch which metric moves first. Change one role at a time and observe the effect on conflicts, updates, and projected mitigation.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; role and timing values are teaching assumptions, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["reliability-roles", "reliability-comms-cadence", "reliability-escalation"],
};
