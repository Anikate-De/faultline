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

const INJECTS = [
  {
    at: 5,
    title: "Inject 1: dependency latency",
    detail: "The payment dependency adds 800 ms of latency in the scenario. Values are synthetic and exist only to drive the exercise.",
  },
  {
    at: 15,
    title: "Inject 2: capacity loss",
    detail: "One availability zone loses capacity in the scenario. The team must decide whether to fail over or reduce load.",
  },
  {
    at: 25,
    title: "Inject 3: database failover",
    detail: "The primary database fails over in the scenario. Reads and writes are briefly inconsistent while the new primary is promoted.",
  },
  {
    at: 35,
    title: "Inject 4: cache eviction storm",
    detail: "A large cache flush sends read traffic to the database in the scenario. The team must protect the data tier.",
  },
  {
    at: 45,
    title: "Inject 5: rollback decision",
    detail: "A recent deploy is implicated in the scenario. The team must decide whether to roll back with incomplete evidence.",
  },
  {
    at: 52,
    title: "Inject 6: paging delay",
    detail: "A secondary paging path is slow in the scenario. The team must notice that the escalation did not arrive.",
  },
  {
    at: 57,
    title: "Inject 7: certificate expiry",
    detail: "A certificate expires in the scenario. The team must connect a new symptom to a known maintenance item.",
  },
];

const MAX_INJECTS = INJECTS.length;
const HANDLE_WINDOW = 10;

const params: ParamSpec[] = [
  {
    id: "scenarioComplexity",
    label: "Scenario complexity",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Scenario",
    help: "How many injects and dependencies the scenario contains. More complexity tests coordination, not just technical skill.",
    format: "percent",
  },
  {
    id: "roleCoverage",
    label: "Role coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Response",
    help: "Share of the key roles assigned before the exercise: incident commander, operations lead, communications lead, and scribe.",
    format: "percent",
  },
  {
    id: "commsCadence",
    label: "Update cadence",
    min: 5,
    max: 45,
    step: 5,
    value: 10,
    unit: " min",
    group: "Response",
    help: "Promised minutes between internal updates during the exercise. Longer intervals make it harder to keep responders aligned.",
    format: "number",
  },
  {
    id: "debriefDepth",
    label: "Debrief depth",
    min: 0,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Learning",
    help: "How much of the timeline, decisions, coordination gaps, and action items the debrief captures with owners.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

type Health = "ok" | "warn" | "crit";

function status(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Values {
  complexity: number;
  roles: number;
  cadence: number;
  debriefDepth: number;
  commsScore: number;
  gap: number;
  injects: number;
  unhandled: number;
  ack: number;
  debriefGaps: number;
}

function compute(p: Params, pending: number): Values {
  const complexity = clamp(num(p, "scenarioComplexity", 40), 0, 100);
  const roles = clamp(num(p, "roleCoverage", 100), 0, 100);
  const cadence = clamp(num(p, "commsCadence", 10), 5, 45);
  const debriefDepth = clamp(num(p, "debriefDepth", 90), 0, 100);
  const injects = 3 + Math.round(complexity / 25);
  const commsScore = clamp(100 - Math.max(0, cadence - 5) * 2.5, 0, 100);
  const gap = clamp(
    100 - (roles * 0.4 + commsScore * 0.35 + (100 - complexity) * 0.25),
    0,
    100,
  );
  const unhandled = Math.min(MAX_INJECTS, Math.round(pending));
  const ack = 2 + gap * 0.15 + complexity * 0.02;
  const debriefGaps = Math.min(4, Math.round((100 - debriefDepth) / 25));
  return {
    complexity,
    roles,
    cadence,
    debriefDepth,
    commsScore,
    gap,
    injects,
    unhandled,
    ack,
    debriefGaps,
  };
}

function advanceQueue(p: Params, pending: number, at: number, dt: number): number {
  const values = compute(p, pending);
  const step = Math.max(0, dt);
  const arrivals = INJECTS.slice(0, values.injects).filter(
    (inject) => inject.at > at && inject.at <= at + step,
  ).length;
  const capacity = clamp(1 - values.gap / 100, 0, 1);
  const handled = Math.min(pending, (capacity / HANDLE_WINDOW) * step);
  return clamp(pending + arrivals - handled, 0, MAX_INJECTS);
}

function initialEvent(values: Values): SimFrame["events"][number] {
  return {
    id: "game-day-brief",
    at: 0,
    severity: "info",
    title: "Game day begins",
    detail: `${values.injects} injects are planned. Role coverage is ${values.roles.toFixed(0)}% and the update cadence is ${values.cadence} minutes. The scenario is synthetic.`,
  };
}

function buildFrame(p: Params, seed: number, pending: number, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, pending);
  const gapHealth = status(values.gap, 30, 55);
  const roleHealth = status(100 - values.roles, 20, 40);
  const commsHealth = status(100 - values.commsScore, 20, 40);
  const debriefHealth = status(values.debriefGaps, 2, 3);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "scenario",
        label: "Scenario",
        kind: "service",
        health: "ok",
        utilization: values.complexity / 100,
        sublabel: `${values.injects} planned injects`,
        detail: "A game day scenario should be realistic enough to require decisions and bounded enough to stay safe. Complexity is a scope input, not a health state. The injects are synthetic.",
        meta: { view: "flow" },
      },
      {
        id: "team",
        label: "Response team",
        kind: "worker",
        health: roleHealth,
        utilization: clamp((100 - values.roles) / 100),
        sublabel: `${values.roles.toFixed(0)}% roles covered`,
        detail: "Command, operations, communications, and record-keeping are separate jobs. One person can hold two only when the incident is small.",
        meta: { view: "flow" },
      },
      {
        id: "comms",
        label: "Communications",
        kind: "service",
        health: commsHealth,
        utilization: clamp((100 - values.commsScore) / 100),
        sublabel: `update every ${values.cadence} min`,
        detail: "A regular update cadence keeps responders, support, and leadership on the same picture. Silence is interpreted as either control or collapse.",
        meta: { view: "flow" },
      },
      {
        id: "debrief",
        label: "Debrief",
        kind: "storage",
        health: debriefHealth,
        utilization: clamp(values.debriefGaps / 4),
        sublabel: `${values.debriefGaps} gap(s) uncaptured`,
        detail: "The debrief turns the exercise into changes. A debrief that records only the technical cause misses the coordination gap the game day was designed to find.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("scenario-team", "scenario", "team", 1 - values.gap / 100, gapHealth),
      edge("team-comms", "team", "comms", values.roles / 100, commsHealth),
      edge("comms-debrief", "comms", "debrief", values.commsScore / 100, debriefHealth),
    ],
    metrics: [
      metric("coordination-gap", "Coordination gap", values.gap, "%", 30, 55, "percent"),
      metric("unhandled-injects", "Unhandled injects", values.unhandled, "", 2, 4, "count"),
      metric("ack-latency", "Decision latency", values.ack, " min", 8, 12, "number"),
      metric("debrief-gaps", "Debrief gaps", values.debriefGaps, "", 2, 3, "count"),
    ],
    events: [initialEvent(values)],
    series: {},
    flags: {
      ...flags,
      seed,
      paramsKey: JSON.stringify(p),
      gameDayPending: pending,
    },
    summary: `${values.gap.toFixed(0)}% coordination gap; ${values.unhandled} unhandled inject(s); ${values.injects} planned; decision latency ${values.ack.toFixed(0)} min.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 10;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.93 + 0.09 * Math.sin((index + phase) / 3.2))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "coordination-gap",
    metricId: "coordination-gap",
    warn: 30,
    crit: 55,
    title: "The response has a coordination gap",
    cause:
      "A role is unassigned, updates are too infrequent, or the scenario is complex enough that responders cannot keep a shared picture without explicit coordination.",
    fix:
      "Assign the incident commander, operations lead, communications lead, and scribe before the exercise. Set an update cadence and keep it even when there is nothing new.",
    checkFirst: [
      "Check which roles were unassigned at the start.",
      "Check whether the communications lead was also doing technical work.",
      "Check whether responders had a shared place to see the current state.",
    ],
  },
  {
    id: "unhandled-injects",
    metricId: "unhandled-injects",
    warn: 2,
    crit: 4,
    title: "Injects are accumulating without a response",
    cause:
      "The team is busy with the first failure and has no one tracking new information. The scenario is testing whether coordination survives the second and third surprise.",
    fix:
      "Give one person the timeline and the inject queue. The incident commander should decide what to defer, not every responder independently.",
    checkFirst: [
      "Check which injects arrived after the first failure.",
      "Check whether anyone was tracking the queue.",
      "Check whether the team explicitly deferred work instead of dropping it.",
    ],
  },
  {
    id: "ack-latency",
    metricId: "ack-latency",
    warn: 8,
    crit: 12,
    title: "Decisions are taking too long",
    cause:
      "Unclear roles or missing information make every decision a group decision. The team is spending time reconstructing state instead of choosing an action.",
    fix:
      "Name the decision owner, state the decision to be made, and set a time by which it will be made. An explicit wrong decision that can be reversed beats an implicit delay.",
    checkFirst: [
      "Check who owned the last decision.",
      "Check whether the team was waiting for information or for permission.",
      "Check whether the decision was recorded with its rationale.",
    ],
  },
  {
    id: "debrief-gaps",
    metricId: "debrief-gaps",
    warn: 2,
    crit: 3,
    title: "The debrief is not capturing the coordination gaps",
    cause:
      "A debrief that records only the technical timeline misses the roles, communications, and decision points the game day was designed to test.",
    fix:
      "Use a debrief template with timeline, decisions, coordination gaps, and action items with owners. Ask each role what information they lacked at the time.",
    checkFirst: [
      "Check whether the timeline includes decisions, not just events.",
      "Check whether each role contributed to the debrief.",
      "Check whether the action items have owners and dates.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const gameDayModel: SimModel = {
  id: "reliability-game-days",
  visual: "timeline",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed, 0, {}),
  step: (frame, p, dt, rng) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const pending = advanceQueue(p, Number(frame.flags.gameDayPending ?? 0), frame.t, dt);
    const values = compute(p, pending);
    const next = buildFrame(p, seed, pending, frame.flags);
    next.t = frame.t;
    next.events = frame.events.slice(-60);
    if (frame.t === 0) {
      const seedEvent = initialEvent(values);
      next.events = next.events.map((event) => (event.id === seedEvent.id ? seedEvent : event));
    }
    for (const [index, inject] of INJECTS.slice(0, values.injects).entries()) {
      const flag = `gameDayInject${index}`;
      if (
        inject.at > frame.t - dt &&
        inject.at <= frame.t + dt &&
        next.flags[flag] !== 1
      ) {
        pushEvent(next, {
          id: `game-day-inject-${index + 1}`,
          at: inject.at,
          severity: "info",
          title: inject.title,
          detail: inject.detail,
          nodeId: "scenario",
        });
        next.flags[flag] = 1;
      }
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.nodes = next.nodes.map((node) => ({
      ...node,
      utilization: clamp((node.utilization ?? 0) + rng.between(-0.003, 0.003)),
    }));
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, Number(frame.flags.gameDayPending ?? 0));
    return [
      `The scenario has ${values.injects} injects and a coordination gap of ${values.gap.toFixed(0)}%.`,
      `${values.unhandled} inject(s) are modeled as unhandled by this point. Decision latency is ${values.ack.toFixed(0)} minutes.`,
      `Role coverage is ${values.roles.toFixed(0)}% and the update cadence is ${values.cadence} minutes.`,
      `The debrief leaves ${values.debriefGaps} gap(s) uncaptured; those are the lessons that will not become changes.`,
    ];
  },
  legend: [
    { label: "Exercise healthy", tone: "ok" },
    { label: "Coordination strain", tone: "warn" },
    { label: "Response gap", tone: "crit" },
    { label: "Learning lost", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A moderate scenario, all roles assigned, a ten-minute update cadence, and a thorough debrief.",
    tone: "ok",
    params: defaults({ scenarioComplexity: 40, roleCoverage: 100, commsCadence: 10, debriefDepth: 90 }),
  },
  {
    id: "peak",
    label: "Stretched",
    description: "A more complex scenario and partial role coverage. The team keeps up, but the debrief and updates slip.",
    tone: "warn",
    params: defaults({ scenarioComplexity: 70, roleCoverage: 80, commsCadence: 20, debriefDepth: 50 }),
  },
  {
    id: "failure",
    label: "Unstaffed response",
    description: "A complex scenario with weak role coverage, slow updates, and almost no debrief.",
    tone: "crit",
    params: defaults({ scenarioComplexity: 100, roleCoverage: 20, commsCadence: 45, debriefDepth: 10 }),
  },
  {
    id: "no-debrief",
    label: "No debrief",
    description: "The response is adequate, but the team skips the debrief. The exercise produces no lasting change.",
    tone: "crit",
    params: defaults({ scenarioComplexity: 50, roleCoverage: 100, commsCadence: 15, debriefDepth: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Full roles, frequent updates, and a thorough debrief in a moderately complex scenario.",
    tone: "ok",
    params: defaults({ scenarioComplexity: 60, roleCoverage: 100, commsCadence: 10, debriefDepth: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-game-day-gap",
  title: "Predict what the game day exposes",
  simId: "game-days",
  question:
    "The team handles the technical failure but never assigns a communications lead and skips the debrief. What did the game day fail to test?",
  prediction: {
    options: [
      { id: "coordination", label: "Coordination, communication, and the learning loop" },
      { id: "capacity", label: "Whether the infrastructure has enough capacity" },
      { id: "code", label: "Whether the application code is correct" },
      { id: "alerts", label: "Whether the alert thresholds are configured" },
    ],
    correctOptionId: "coordination",
    explanation:
      "The technical failure is only the stimulus. A game day tests whether people can establish command, share a picture, make decisions under uncertainty, and turn the exercise into changes. Without a communications role and a debrief, those parts of the response are never exercised.",
  },
  setup: defaults({ scenarioComplexity: 80, roleCoverage: 50, commsCadence: 30, debriefDepth: 10 }),
  runFor: 50,
  observe: [
    "The coordination gap is critical before the first inject arrives.",
    "Unhandled injects accumulate because no one owns the queue.",
    "Decision latency rises while responders reconstruct state.",
    "The debrief leaves most gaps uncaptured, so the exercise changes nothing.",
  ],
  explain:
    "A game day is a rehearsal of the response, not a test of the system alone. The scenario supplies the failure; roles supply the structure; communications keep the picture shared; the debrief converts experience into changes. If any of those is missing, the team can still fix the technical problem and learn nothing about how it works together.",
  fix: defaults({ scenarioComplexity: 80, roleCoverage: 100, commsCadence: 10, debriefDepth: 90 }),
  debrief:
    "With every role assigned, a steady update cadence, and a real debrief, the same scenario produces a smaller coordination gap and a usable set of action items. The tradeoff is staff time: a game day removes several engineers from delivery for preparation, execution, and follow-up. That cost is bounded and visible; the cost of discovering the same gap during a customer incident is not.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A game day is a planned rehearsal of an incident response. The team runs a realistic scenario with a sequence of injected failures, assigns the roles it would use in a real incident, communicates as it would in production, and then debriefs what happened. The point is not to prove the system can fail. The point is to find the coordination gaps before a customer does.",
  },
  {
    type: "p",
    text: "A game day tests people and process as much as technology. The scenario supplies the technical stimulus: a dependency slows down, a zone loses capacity, a database fails over. The response supplies the rest: who commands, who works the system, who communicates, who records decisions, and how the team decides what to defer. A technically successful response with no communications lead and no debrief has tested only part of the response.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Game days sit after the basics of incident response and before chaos engineering. Incident command and severity levels define the structure. The error budget policy defines when reliability work takes priority. A game day exercises that structure with a scenario that is realistic enough to require judgment and controlled enough to stop. Chaos engineering injects a specific fault to test a technical hypothesis; a game day rehearses the human response to a larger scenario.",
  },
  {
    type: "table",
    headers: ["Role", "Owns", "What the game day reveals"],
    rows: [
      ["Incident commander", "Priorities, decisions, coordination", "Whether anyone is actually deciding, or everyone is debugging"],
      ["Operations lead", "Technical work and safe changes", "Whether the people touching the system have a shared plan"],
      ["Communications lead", "Updates and stakeholder cadence", "Whether silence is hiding uncertainty or lost ownership"],
      ["Scribe", "Timeline, decisions, action items", "Whether the team can reconstruct what happened and why"],
    ],
  },
  {
    type: "p",
    text: "The scenario, inject schedule, and timing values in this module are illustrative. They are not a template for a specific company's exercise. The model compresses the exercise into 60 simulated seconds and labels every inject as synthetic.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Coordination gap: the combined effect of unassigned roles, slow updates, scenario complexity, and a weak debrief.",
      "Unhandled injects: how many scenario events have no owner or decision as the exercise progresses.",
      "Decision latency: modeled minutes to make and communicate a decision under the current role and communications structure.",
      "Debrief gaps: the parts of the exercise the debrief does not capture, which are the lessons that will not become changes.",
      "A replay timeline of the injects and threshold events.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and read the role table. Apply Unstaffed response, then No debrief: the second shows a technically adequate response that still fails the learning goal. Run the experiment before reading the explanation, then restore roles and debrief depth.",
  },
  { type: "sim", simId: "game-days" },
  { type: "experiment", experimentId: "predict-game-day-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The scenario delivered its injects, but the response structure did not keep up. With weak role coverage and slow updates, each new inject arrived before the team had a shared picture of the last one. The unhandled queue grew, decisions took longer, and the debrief captured little of what went wrong.",
  },
  {
    type: "p",
    text: "Restoring the roles and the debrief did not change the scenario. It changed the team's ability to absorb it. The communications lead kept a shared picture, the scribe preserved decisions, and the debrief produced action items with owners. That is the outcome a game day is for.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "An exercise plan with scope, scenario, inject schedule, safety constraints, and participants.",
      "A response channel with named roles and a visible incident commander.",
      "Timestamps for detection, first decision, first update, and each inject.",
      "A debrief document with timeline, decisions, coordination gaps, and action items.",
      "Follow-up work with owners, dates, and a review at the next exercise.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether every role was assigned before the first inject, whether the communications lead was free to communicate, and whether the debrief produced action items with owners. Those three checks find most of the coordination value.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the scenario and the specific questions the exercise should answer.",
      "Assign the incident commander, operations lead, communications lead, and scribe before the start.",
      "Set an update cadence and keep it, even when there is nothing new.",
      "Track injects in one place and let the commander decide what to defer.",
      "Record decisions and their rationale as they happen, not only at the end.",
      "Run a blame-free debrief that covers the timeline, decisions, coordination gaps, and what each role lacked.",
      "Turn the gaps into action items with owners and dates, and review them at the next exercise.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A game day removes several engineers from delivery for preparation, execution, and follow-up. Keep the scope small enough to repeat.",
      "A controlled scenario is safer but less realistic. Use it to test coordination, not to prove production behavior.",
      "A debrief that is too broad produces a long list nobody owns. Limit action items to the gaps the exercise actually exposed.",
      "A game day can become a performance review if leaders treat it as a pass/fail exam. That suppresses the honesty the debrief needs.",
      "Practicing the same scenario repeatedly builds competence but can hide new failure modes. Rotate scenarios over time.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "game-day-purpose",
    question: "What does a game day test that a postmortem does not?",
    difficulty: 2,
    hints: [
      "A postmortem looks backward at one incident.",
      "A game day puts the team in a response structure before the incident is real.",
    ],
    answer:
      "A postmortem reconstructs what happened and why after an incident. A game day rehearses the response before the incident: whether the team can establish command, assign roles, share a picture, make decisions under uncertainty, and communicate on a cadence. It also tests whether the debrief and follow-up process produces changes. The technical scenario is the stimulus; the coordination and decision-making are the subject.",
    followUps: [
      "When would you choose a game day over a postmortem review?",
      "How do you keep the exercise from becoming theater?",
      "What should the game day not try to test?",
    ],
    redFlags: [
      "Treats it as a load test.",
      "Focuses only on the technical fix.",
      "Runs it without a debrief.",
    ],
    rubric: [
      "Contrasts rehearsal with retrospective.",
      "Names roles and communications.",
      "Includes debrief and follow-up.",
      "States the limits of the exercise.",
    ],
  },
  {
    id: "scenario-design",
    question: "How do you design a game day scenario and its injects?",
    difficulty: 3,
    hints: [
      "Start from a question the team needs answered.",
      "Bound the scenario so it can be stopped safely.",
    ],
    answer:
      "I start with the question: which coordination or technical assumption are we testing? Then I build a scenario that requires the team to make decisions, not just follow a script. The injects arrive in a sequence that creates uncertainty and forces prioritization. I define the scope, the safety constraints, the stop conditions, and who can halt the exercise. The scenario should be realistic enough that the team behaves as it would in production, but controlled enough that a mistake does not become a real incident. The injects in the simulation are illustrative and synthetic.",
    followUps: [
      "How many injects are too many?",
      "How do you decide the order of injects?",
      "What do you do if the exercise exposes a real vulnerability?",
    ],
    redFlags: [
      "Starts with a tool instead of a question.",
      "Has no stop condition.",
      "Makes the scenario so complex that the team cannot finish.",
    ],
    rubric: [
      "Starts from a testable question.",
      "Sequences injects for decisions.",
      "Defines scope and stop conditions.",
      "Keeps the exercise safe.",
    ],
  },
  {
    id: "roles-and-comms",
    question: "Why assign a communications lead and a scribe in a game day?",
    difficulty: 2,
    hints: [
      "The incident commander cannot also be the only communicator.",
      "The debrief needs a record that is not reconstructed from memory.",
    ],
    answer:
      "The communications lead keeps responders, support, and leadership on the same picture and protects the incident commander from constant status requests. The scribe records the timeline, decisions, and action items while they are happening, which makes the debrief accurate and lets the team see where time went. Without those roles, the commander becomes the bottleneck and the debrief becomes a memory exercise. The game day is the safest place to discover that.",
    followUps: [
      "Can one person hold both roles in a small incident?",
      "What should the communications lead include in an update?",
      "How do you keep the scribe from becoming a court reporter?",
    ],
    redFlags: [
      "Assumes the commander can do everything.",
      "Treats communications as optional.",
      "Has no record of decisions.",
    ],
    rubric: [
      "Separates communications from command.",
      "Explains the scribe's value to the debrief.",
      "Names the cost of missing roles.",
      "Keeps the roles practical.",
    ],
  },
  {
    id: "debrief-actions",
    question: "How do you run a debrief that produces changes instead of a list of observations?",
    difficulty: 3,
    hints: [
      "Blame-free does not mean conclusion-free.",
      "Every action needs an owner and a date.",
    ],
    answer:
      "I start with the timeline and ask each role what information they had, what they lacked, and what they decided. I separate technical causes from coordination causes. Then I turn the gaps into a small number of action items with owners and dates, and I assign a review at the next exercise or a fixed date. I avoid naming individuals as the cause; I look for the system condition that made the action reasonable at the time. The debrief is successful when the next game day can show that the action changed behavior.",
    followUps: [
      "How do you prioritize the action items?",
      "What if the same gap appears in the next exercise?",
      "How do you keep the debrief blame-free without avoiding accountability?",
    ],
    redFlags: [
      "Produces observations with no owners.",
      "Names individuals as the root cause.",
      "Closes the exercise without a follow-up date.",
    ],
    rubric: [
      "Separates technical and coordination causes.",
      "Assigns owners and dates.",
      "Keeps the review blame-free.",
      "Verifies the change at the next exercise.",
    ],
  },
];

const checklist = [
  {
    title: "Prepare",
    items: [
      "The exercise has a written question and scope.",
      "The scenario and inject schedule are documented.",
      "Roles are assigned before the start.",
      "Safety constraints and a stop authority are explicit.",
      "Participants know this is an exercise, not a real incident.",
    ],
  },
  {
    title: "Run",
    items: [
      "The incident commander states priorities and decisions.",
      "The communications lead keeps a regular update cadence.",
      "The scribe records the timeline, decisions, and action items.",
      "Injects are tracked in one place and deferred explicitly.",
      "The exercise stops if it creates real customer impact or exceeds its scope.",
    ],
  },
  {
    title: "Learn",
    items: [
      "The debrief covers the timeline, decisions, coordination gaps, and role experience.",
      "Action items have owners and dates.",
      "The team reviews the actions at the next exercise or a fixed date.",
      "The scenario is rotated so the same path is not rehearsed forever.",
    ],
  },
];

const references = [
  {
    title: "Incident Response",
    url: "https://sre.google/workbook/incident-response/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Practicing incident response with exercises, roles, communications, and drills.",
  },
  {
    title: "Postmortem Culture: Learning from Failure",
    url: "https://sre.google/workbook/postmortem-culture/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Blame-free debriefs, learning, and training exercises such as Wheel of Misfortune.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "game-days": {
      model: gameDayModel,
      presets,
      instructions:
        "Start healthy and read the role table. Apply Unstaffed response, then No debrief. Run the experiment before restoring roles and debrief depth.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The scenario, injects, and timings are synthetic teaching values, not a real incident.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-error-budget-policy",
    "reliability-chaos",
    "reliability-incident-command",
    "reliability-roles",
    "reliability-comms-cadence",
  ],
};
