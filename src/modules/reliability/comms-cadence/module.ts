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
    id: "internalCadence",
    label: "Internal update cadence",
    min: 2,
    max: 60,
    step: 1,
    value: 15,
    unit: " min",
    group: "Cadence",
    help: "Promised minutes between updates for responders, support, and leadership.",
    format: "number",
  },
  {
    id: "externalCadence",
    label: "External update cadence",
    min: 5,
    max: 120,
    step: 5,
    value: 25,
    unit: " min",
    group: "Cadence",
    help: "Promised minutes between customer-facing updates. Longer intervals reduce certainty.",
    format: "number",
  },
  {
    id: "draftingCost",
    label: "Minutes to draft an update",
    min: 1,
    max: 20,
    step: 1,
    value: 3,
    unit: " min",
    group: "Cost",
    help: "Time the communications owner spends per update. Too-frequent updates consume response capacity.",
    format: "number",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface CommsState {
  sinceInternal: number;
  sinceExternal: number;
  escalations: number;
}

const INITIAL: CommsState = { sinceInternal: 0, sinceExternal: 0, escalations: 0 };

function readState(frame: SimFrame): CommsState {
  return {
    sinceInternal: Math.max(0, Number(frame.flags.commsSinceInternal ?? 0)),
    sinceExternal: Math.max(0, Number(frame.flags.commsSinceExternal ?? 0)),
    escalations: Math.max(0, Number(frame.flags.commsEscalations ?? 0)),
  };
}

interface Values {
  internalCadence: number;
  externalCadence: number;
  draftingCost: number;
  sinceInternal: number;
  sinceExternal: number;
  trustGap: number;
  escalations: number;
  commsLoad: number;
}

function compute(p: Params, state: CommsState): Values {
  const internalCadence = clamp(num(p, "internalCadence", 15), 2, 60);
  const externalCadence = clamp(num(p, "externalCadence", 25), 5, 120);
  const draftingCost = clamp(num(p, "draftingCost", 3), 1, 20);
  const trustGap = clamp(
    Math.max(0, internalCadence - 10) * 1.2 +
      Math.max(0, externalCadence - 20) * 0.7 +
      Math.max(0, state.sinceInternal - 10) * 0.8 +
      Math.max(0, state.sinceExternal - 20) * 0.5,
    0,
    100,
  );
  const commsLoad = clamp(
    (60 / internalCadence) * draftingCost + (60 / externalCadence) * draftingCost,
    0,
    60,
  );
  return {
    internalCadence,
    externalCadence,
    draftingCost,
    sinceInternal: state.sinceInternal,
    sinceExternal: state.sinceExternal,
    trustGap,
    escalations: Math.floor(state.escalations),
    commsLoad,
  };
}

function advance(state: CommsState, p: Params, dt: number): CommsState {
  const internalCadence = clamp(num(p, "internalCadence", 15), 2, 60);
  const externalCadence = clamp(num(p, "externalCadence", 25), 5, 120);
  const step = Math.max(0, dt);
  let sinceInternal = state.sinceInternal + step;
  let sinceExternal = state.sinceExternal + step;
  if (sinceInternal >= internalCadence) sinceInternal = 0;
  if (sinceExternal >= externalCadence) sinceExternal = 0;
  const values = compute(p, { ...state, sinceInternal, sinceExternal });
  const escalationRate = values.trustGap > 20 ? ((values.trustGap - 20) / 100) * 0.18 : 0;
  let escalations = state.escalations + escalationRate * step;
  if (values.trustGap < 20) escalations = Math.max(0, escalations - 0.05 * step);
  return { sinceInternal, sinceExternal, escalations };
}

function buildFrame(p: Params, state: CommsState, seed: number): SimFrame {
  const values = compute(p, state);
  const trustHealth: "ok" | "warn" | "crit" =
    values.trustGap >= 40 ? "crit" : values.trustGap >= 20 ? "warn" : "ok";
  const loadHealth: "ok" | "warn" | "crit" =
    values.commsLoad >= 60 ? "crit" : values.commsLoad >= 30 ? "warn" : "ok";
  const escalationHealth: "ok" | "warn" | "crit" =
    values.escalations >= 3 ? "crit" : values.escalations >= 1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "channel",
        label: "Incident channel",
        kind: "service",
        health: trustHealth,
        utilization: clamp(values.trustGap / 100),
        sublabel: `${values.sinceInternal.toFixed(0)} min since internal update`,
        detail: "The channel holds the technical detail. It is not the customer-facing record, and it is not a substitute for an update.",
        meta: { view: "flow" },
      },
      {
        id: "comms",
        label: "Communications owner",
        kind: "worker",
        health: loadHealth === "ok" ? trustHealth : loadHealth,
        utilization: clamp(0.2 + values.commsLoad / 100),
        sublabel: `${values.commsLoad.toFixed(0)} min per hour`,
        detail: `One owner turns current state into updates. Drafting cost is ${values.draftingCost} minutes per update.`,
        meta: { view: "flow" },
      },
      {
        id: "support",
        label: "Support",
        kind: "service",
        health: escalationHealth,
        utilization: clamp(0.25 + values.escalations * 0.12),
        sublabel: values.escalations >= 1 ? `${values.escalations.toFixed(1)} escalations` : "informed",
        detail: "Support repeats what it is told. When updates stop, support fills the gap with guesses or escalates to find a human.",
        meta: { view: "flow" },
      },
      {
        id: "customers",
        label: "Customers",
        kind: "external",
        health: trustHealth,
        utilization: clamp(values.trustGap / 100),
        sublabel: `${values.sinceExternal.toFixed(0)} min since external update`,
        detail: "Customers see impact, workaround, and the next update time. They do not see hypotheses, internal names, or speculation.",
        meta: { view: "flow" },
      },
      {
        id: "engineering",
        label: "Engineering",
        kind: "worker",
        health: loadHealth,
        utilization: clamp(0.4 + values.commsLoad / 200),
        sublabel: values.commsLoad >= 30 ? "comms load high" : "protected focus",
        detail: "Every update costs minutes. A cadence that is too tight can pull the communications owner and responders away from the fix.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("channel-comms", "channel", "comms", values.trustGap / 100, trustHealth),
      edge("comms-support", "comms", "support", 1 - values.trustGap / 100, escalationHealth),
      edge("comms-customers", "comms", "customers", 1 - values.trustGap / 100, trustHealth),
      edge("comms-engineering", "comms", "engineering", values.commsLoad / 100, loadHealth),
    ],
    metrics: [
      metric("trust-gap", "Stakeholder trust gap", values.trustGap, "%", 20, 40, "percent"),
      metric("internal-age", "Minutes since internal update", values.sinceInternal, " min", 20, 40, "number"),
      metric("external-age", "Minutes since external update", values.sinceExternal, " min", 30, 60, "number"),
      metric("support-escalations", "Support escalation count", values.escalations, "", 1, 3, "count"),
      metric("comms-load", "Communications load", values.commsLoad, " min/h", 30, 55, "number"),
    ],
    events: [
      {
        id: "comms-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared",
        detail: `The internal cadence is ${values.internalCadence} minutes and the external cadence is ${values.externalCadence} minutes. The next update times should be announced now.`,
      },
    ],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      commsSinceInternal: state.sinceInternal,
      commsSinceExternal: state.sinceExternal,
      commsEscalations: state.escalations,
    },
    summary: `${values.trustGap.toFixed(0)}% trust gap, ${values.sinceInternal.toFixed(0)} min since internal update, ${values.escalations.toFixed(1)} support escalations.`,
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
    id: "trust-gap",
    metricId: "trust-gap",
    warn: 20,
    crit: 40,
    title: "The stakeholder trust gap is widening",
    cause:
      "The promised cadence is too long, or the team has missed it. Uncertainty fills the gap, and support starts inventing explanations or escalating for a human.",
    fix:
      "Shorten the promised interval, name a communications owner, and publish at the promised time. If there is no new information, say that and give the next update time.",
    checkFirst: [
      "Compare the last update time with the promised cadence.",
      "Ask support what they are telling customers right now.",
      "Check whether the external update contains impact, workaround, and next update time.",
    ],
  },
  {
    id: "internal-age",
    metricId: "internal-age",
    warn: 20,
    crit: 40,
    title: "The internal update is overdue",
    cause:
      "The communications owner is also responding, or the team is waiting for certainty before writing anything. Silence is read as either no progress or no one in charge.",
    fix:
      "Publish a short internal update with known impact, current action, open questions, and the next update time. Do not wait for a complete picture.",
    checkFirst: [
      "Check whether the communications owner is on the debugging call.",
      "Check the last message in the stakeholder channel and its timestamp.",
      "Check whether responders are waiting for a decision before updating.",
    ],
  },
  {
    id: "external-age",
    metricId: "external-age",
    warn: 30,
    crit: 60,
    title: "Customer updates are overdue",
    cause:
      "External communication is waiting on internal certainty. The result is a longer silence than the customer-facing impact justifies.",
    fix:
      "Publish what is known: affected capability, current workaround, and the next update time. Keep internal hypotheses and speculation out of the customer message.",
    checkFirst: [
      "Check the status page and the last customer message.",
      "Check whether support has a workaround to share.",
      "Check whether the external cadence is longer than the impact warrants.",
    ],
  },
  {
    id: "support-escalations",
    metricId: "support-escalations",
    warn: 1,
    crit: 3,
    title: "Support is escalating for a current update",
    cause:
      "Support cannot answer customers from the information it has. Each escalation consumes a responder or a leader who should be working the incident.",
    fix:
      "Give support a current statement and a next-update time. Route support questions to the communications owner instead of the technical responders.",
    checkFirst: [
      "Read the last few support escalations and look for repeated questions.",
      "Check whether support has the same update the customer channel has.",
      "Check whether the communications owner is reachable.",
    ],
  },
  {
    id: "comms-load",
    metricId: "comms-load",
    warn: 30,
    crit: 55,
    title: "Update production is consuming response capacity",
    cause:
      "The cadence is tighter than the audience needs, the drafting cost is high, or one person is writing every version for every audience.",
    fix:
      "Use one internal update with audience-specific summaries, template the external message, and set a cadence the team can sustain. Lower frequency is better than missed commitments.",
    checkFirst: [
      "Compare minutes spent on updates with minutes spent on the fix.",
      "Check whether internal and external updates are being written from scratch.",
      "Check whether the cadence was chosen for the audience or for anxiety.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const commsCadenceModel: SimModel = {
  id: "reliability-comms-cadence",
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
    if (values.sinceInternal >= 20 && frame.flags.commsSilenceEvent !== 1) {
      pushEvent(next, {
        id: "comms-silence",
        at: frame.t,
        severity: "warn",
        title: "Internal update cadence missed",
        detail: `The last internal update was ${values.sinceInternal.toFixed(0)} minutes ago. Support and leadership are filling the gap themselves.`,
        nodeId: "channel",
        metricId: "internal-age",
      });
      next.flags.commsSilenceEvent = 1;
    }
    if (values.escalations >= 1 && frame.flags.commsEscalationEvent !== 1) {
      pushEvent(next, {
        id: "comms-support-escalation",
        at: frame.t,
        severity: "warn",
        title: "Support escalated to find an update",
        detail: "Support did not have a current statement. The escalation now competes with the technical response for attention.",
        nodeId: "support",
        metricId: "support-escalations",
      });
      next.flags.commsEscalationEvent = 1;
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
      `Stakeholder trust gap is ${values.trustGap.toFixed(0)}%. The promised internal cadence is ${values.internalCadence} minutes and the external cadence is ${values.externalCadence} minutes.`,
      `The last internal update was ${values.sinceInternal.toFixed(0)} minutes ago; the last external update was ${values.sinceExternal.toFixed(0)} minutes ago.`,
      `${values.escalations.toFixed(1)} support escalations have been created by missing information, not by the technical failure alone.`,
      `Update production costs ${values.commsLoad.toFixed(0)} minutes per hour. A tighter cadence raises the cost and can pull the owner away from the response.`,
    ];
  },
  legend: [
    { label: "Cadence held", tone: "ok" },
    { label: "Update late", tone: "warn" },
    { label: "Trust gap", tone: "crit" },
    { label: "Support guessing", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Internal updates every 15 minutes and customer updates every 25, with a sustainable drafting cost.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A busy incident with a 20-minute internal cadence and 35-minute external updates. The team is near its limit.",
    tone: "warn",
    params: defaults({ internalCadence: 20, externalCadence: 35, draftingCost: 5 }),
  },
  {
    id: "failure",
    label: "Silent channel",
    description: "The channel goes quiet for an hour while support invents updates from old information.",
    tone: "crit",
    params: defaults({ internalCadence: 60, externalCadence: 120, draftingCost: 6 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A short internal cadence, a separate external cadence, and a drafting cost the team can sustain.",
    tone: "ok",
    params: defaults({ internalCadence: 8, externalCadence: 15, draftingCost: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-silent-channel",
  title: "Predict the cost of a silent channel",
  simId: "comms-cadence",
  question:
    "The incident channel is silent for 40 minutes and support starts inventing updates. Which signal shows the damage first?",
  prediction: {
    options: [
      { id: "trust", label: "The stakeholder trust gap rises before support escalates" },
      { id: "load", label: "Communications load rises because updates are late" },
      { id: "throughput", label: "Engineering throughput rises because no one is writing updates" },
      { id: "database", label: "Database latency rises because support is querying it" },
    ],
    correctOptionId: "trust",
    explanation:
      "Trust erodes as the promised interval passes. Support escalations follow because support cannot answer customers from a stale statement. Communications load is not the problem in this scenario; the absence of updates is.",
  },
  setup: defaults({ internalCadence: 60, externalCadence: 120, draftingCost: 6 }),
  runFor: 45,
  observe: [
    "The trust gap is critical from the first minute because the promised cadence is already too long.",
    "Internal and external update ages keep rising because the cadence has not arrived.",
    "Support escalations accumulate as support tries to find a current statement.",
    "Communications load stays low; silence is cheap for the team and expensive for everyone else.",
  ],
  explain:
    "A cadence is a promise about when the next information arrives. When the promise is too long or missed, stakeholders do not wait passively. Support guesses, leadership asks for a bridge, and customers receive inconsistent messages. A fixed cadence with a named owner replaces that uncertainty with a predictable next update, even when the technical picture has not changed.",
  fix: defaults({ internalCadence: 8, externalCadence: 15, draftingCost: 2 }),
  debrief:
    "With a short, sustainable cadence, trust recovers and support stops escalating. The tradeoff is that the communications owner now spends more time writing, and the team must hold the cadence even when there is nothing new. A missed update is worse than a short one.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Communication cadence is the promised interval between incident updates. It is not a schedule for when perfect information will exist. It is a commitment that at a known time, each audience will receive what is currently known: impact, current action, workaround if one exists, and the time of the next update. The cadence creates predictability while the technical picture is still moving.",
  },
  {
    type: "p",
    text: "Internal and external audiences need different detail. Responders, support, and leadership need enough technical context to make decisions: which capability is affected, what has been tried, what is blocked, and who owns the next action. Customers and public channels need impact, workaround, and next update time. Internal hypotheses, blame, unverified causes, and names do not belong in the customer message.",
  },
  {
    type: "p",
    text: "Cadence is a tradeoff. Too long, and uncertainty grows until support invents an answer. Too short, and the communications owner spends the incident writing instead of helping the response. The right interval depends on impact and on how fast the situation is changing, but the team must be able to sustain it. A missed promise damages trust more than a slightly longer interval that is always met.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Cadence sits between the incident response and everyone who is not in the response. It consumes the current technical state and produces an audience-specific statement. It depends on the communications role from incident command, and it feeds support, leadership, the status page, and customer channels. It does not replace the incident channel, and the incident channel should not be pasted into a customer message.",
  },
  {
    type: "table",
    headers: ["Audience", "Needs", "Does not need"],
    rows: [
      ["Responders", "Current impact, hypotheses, blocked work, owners", "Polished customer language"],
      ["Support", "What to tell customers, known workaround, next update time", "Internal speculation or unverified cause"],
      ["Leadership", "Impact, trajectory, decisions needed, next update", "Raw debug logs or every hypothesis"],
      ["Customers", "Affected capability, workaround, next update time", "Internal names, blame, or guesses"],
    ],
  },
  {
    type: "p",
    text: "The intervals in this module are illustrative. The model uses fifteen and twenty-five minutes as teaching values, with a separate external cadence, but the correct number depends on impact, audience, and the team's capacity. The model compresses one incident minute into one simulated second.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Stakeholder trust gap: how far the promised cadence and the current silence are from what the audience expects.",
      "Minutes since the internal and external updates, tracked separately.",
      "Support escalations created by missing information rather than the technical failure.",
      "Communications load: minutes per hour spent producing updates, which competes with response work.",
      "A flow view of the channel, the communications owner, support, customers, and engineering.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Silent channel. Watch the trust gap before the support escalations. Apply Recovery and compare the update ages with the communications load. Run the experiment before reading the debrief, then raise the drafting cost to see why a tighter cadence is not always better.",
  },
  {
    type: "compare",
    leftTitle: "Silence",
    rightTitle: "Fixed cadence",
    rows: [
      { label: "Audience state", left: "Uncertainty grows between messages", right: "Next information time is known" },
      { label: "Support", left: "Invents or escalates to find an answer", right: "Repeats a current, approved statement" },
      { label: "Technical team", left: "Interrupted by questions and escalations", right: "Protected by one communications owner" },
      { label: "Failure mode", left: "Rumors and inconsistent customer messages", right: "Update production consumes response time" },
    ],
  },
  { type: "sim", simId: "comms-cadence" },
  { type: "experiment", experimentId: "predict-silent-channel" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The channel went silent because the promised cadence was longer than the audience could tolerate and no one owned the next update. Support did not wait passively. It filled the gap with guesses and escalations, which then competed with the technical response for attention. The trust gap rose before the escalation count because the promise itself was the first failure.",
  },
  {
    type: "p",
    text: "Shortening the cadence and separating internal from external detail restored predictability. The team still had to write updates when there was no new technical information. That is the point of a cadence: it carries the absence of news as a deliberate message instead of leaving the audience to invent one.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Support queue: repeated questions that all ask for the same current status, or tickets quoting an old public message.",
      "Incident channel: the last stakeholder update is older than the promised cadence, and no next-update time is visible.",
      "Status page: an update that describes internal work instead of customer impact, or a page that has not changed while the incident continues.",
      "Leadership chat: requests for a bridge or a private briefing because the written update stopped.",
      "Communications owner: writing every update from scratch for every audience and falling behind the fix.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the last update for each audience and compare it with the promised time. Ask support what they are telling customers right now. Check whether one person owns the next update and whether the message contains impact, workaround, and the next update time.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Set one internal cadence and one external cadence that the team can sustain for the expected duration.",
      "Name a communications owner and give them a short technical brief at each command update.",
      "Publish on time even when nothing has changed; state the known impact and the next update time.",
      "Use one internal note and derive audience-specific summaries instead of writing each message from scratch.",
      "Route support questions to the communications owner, not to the technical responders.",
      "After recovery, compare the promised cadence with the actual timestamps and remove the causes of missed updates.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short cadence reduces uncertainty but consumes communications and response time, especially when every audience needs a different message.",
      "A long cadence protects the technical team but invites support and leadership to fill the gap with guesses.",
      "Internal detail helps responders and support but must not leak into customer messages as speculation or blame.",
      "A single communications owner keeps the message consistent but becomes a bottleneck if the cadence is tighter than one person can sustain.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-cadence",
    question: "How do you choose an update cadence for an active incident?",
    difficulty: 2,
    hints: [
      "Start with impact and how fast the situation is changing.",
      "The cadence must be sustainable, not aspirational.",
    ],
    answer:
      "I start with customer impact and the rate of change. A high-impact incident with a moving workaround needs a shorter internal cadence and a separate external cadence for customers. I choose an interval the communications owner can sustain, state the next update time, and keep it even when there is no new information. I also separate internal technical detail from external impact and workaround. If the cadence is missed, I would shorten it or add a second writer rather than let the promise slide silently.",
    followUps: [
      "What changes the cadence during the incident?",
      "How do you handle multiple audiences?",
      "What do you do when there is nothing new?",
    ],
    redFlags: [
      "Chooses a cadence without asking who writes the updates.",
      "Waits for complete information before publishing.",
      "Uses the same message for every audience.",
    ],
    rubric: [
      "Ties cadence to impact and rate of change.",
      "Requires a named owner and sustainable cost.",
      "Separates internal and external detail.",
      "Commits to a next update time.",
    ],
  },
  {
    id: "nothing-new",
    question:
      "The team has no new information since the last update. What do you publish, and why publish at all?",
    difficulty: 2,
    hints: [
      "Silence is interpreted as either no progress or no one in charge.",
      "State what is known, what is not, and the next time.",
    ],
    answer:
      "I publish a short update that states the impact is unchanged, the current action is still in progress, what has been ruled out if anything, and the next update time. Publishing at the promised time shows that someone is still tracking the incident and prevents support from inventing a story. The update does not need to contain a new cause or a new estimate. It needs to be accurate about the absence of change.",
    followUps: [
      "What if the team is embarrassed that nothing changed?",
      "How do you avoid repeating the same message word for word?",
      "When do you change the cadence instead?",
    ],
    redFlags: [
      "Skips the update because there is no news.",
      "Invents progress to fill the message.",
      "Leaves the next update time vague.",
    ],
    rubric: [
      "Publishes on time.",
      "States known and unknown accurately.",
      "Gives the next update time.",
      "Explains why silence is costly.",
    ],
  },
  {
    id: "raw-channel",
    question:
      "Support is pasting raw incident channel messages to customers. What do you change?",
    difficulty: 3,
    hints: [
      "The incident channel is not written for customers.",
      "Give support an approved statement and a route for questions.",
    ],
    answer:
      "I would separate the channels and give support a customer-facing statement approved by the communications owner. The statement contains impact, workaround, and the next update time, with no internal names, hypotheses, or unverified cause. I would route support questions to the communications owner instead of the responders, and I would explain why raw channel messages are harmful: they are incomplete, change quickly, and often contain speculation. If support needs more detail to answer a specific case, that detail should come through a controlled briefing.",
    followUps: [
      "How do you keep the approved statement current?",
      "What if support needs technical detail for a specific customer?",
      "Who approves an external message during a fast incident?",
    ],
    redFlags: [
      "Lets support use the raw channel because it is faster.",
      "Adds more people to the incident channel.",
      "Writes a customer message with internal hypotheses.",
    ],
    rubric: [
      "Separates internal and external channels.",
      "Defines the customer message contents.",
      "Routes support questions to communications.",
      "Explains the harm of raw messages.",
    ],
  },
  {
    id: "comms-cost",
    question:
      "How do you reduce the time the team spends on updates without returning to silence?",
    difficulty: 3,
    hints: [
      "One internal note can feed several audiences.",
      "Templates and batching reduce drafting cost.",
    ],
    answer:
      "I would keep one internal update as the source of truth and derive short audience-specific summaries from it. I would use a template with impact, workaround, and next update time, batch questions from support, and have the communications owner write at fixed times instead of answering every request as it arrives. If the cadence is still too expensive, I would lengthen it deliberately and announce the new commitment rather than miss the old one. The goal is a predictable message with less duplicated work, not fewer audiences.",
    followUps: [
      "What belongs in the source-of-truth update?",
      "How do you batch support questions?",
      "When is it appropriate to reduce frequency?",
    ],
    redFlags: [
      "Stops updating to save time.",
      "Writes a separate long message for every audience.",
      "Lets responders handle support questions directly.",
    ],
    rubric: [
      "Uses one source and derived summaries.",
      "Templates the message.",
      "Batches or routes questions.",
      "Changes the promise explicitly if needed.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The internal and external update cadences are written down with owners.",
      "An update template covers impact, current action, workaround, and next update time.",
      "Support knows where to get the approved customer statement.",
      "The communications owner is separate from the technical responders.",
      "The status page has a draft or template ready before an incident.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Publish at the promised time, even when there is no new information.",
      "Separate internal technical detail from customer-facing impact.",
      "Give support a current statement and a route for questions.",
      "Track the next update time visibly in the incident channel.",
      "Adjust the cadence explicitly if the team cannot sustain it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare promised update times with actual timestamps.",
      "Review support escalations that were caused by missing information.",
      "Check whether internal detail leaked into customer messages.",
      "Update the template and the cadence for the next exercise.",
    ],
  },
];

const references = [
  {
    title: "External Communication Guidelines",
    url: "https://response.pagerduty.com/during/external_communication_guidelines/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Customer-facing communication guidance during an incident.",
  },
  {
    title: "During an Incident",
    url: "https://response.pagerduty.com/during/during_an_incident/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Incident communication practices and stakeholder updates.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Communication roles and coordination during incident response.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "comms-cadence": {
      model: commsCadenceModel,
      presets,
      instructions:
        "Start Healthy, apply Silent channel, and compare the trust gap with the update ages. Then apply Recovery, change the drafting cost, and observe when a tighter cadence becomes too expensive.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; cadence values are teaching examples, not organizational policy.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["reliability-roles", "reliability-incident-command", "reliability-escalation"],
};
