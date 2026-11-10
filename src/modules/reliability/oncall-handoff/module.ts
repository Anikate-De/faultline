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
    id: "handoffMinutes",
    label: "Handoff time",
    min: 5,
    max: 40,
    step: 5,
    value: 25,
    unit: " min",
    group: "Handoff",
    help: "Time spent writing and discussing the handoff. Very short handoffs save minutes now and hide work from the next shift.",
    format: "number",
  },
  {
    id: "sectionCoverage",
    label: "Required sections covered",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Content",
    help: "Share of the five sections covered: active incidents, recent changes, risky deploys, expiring certificates, and known gaps.",
    format: "percent",
  },
  {
    id: "riskOwnership",
    label: "Risks with an owner",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Content",
    help: "Share of known risks transferred with a named owner, a next check, and a time when the risk expires or escalates.",
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
  minutes: number;
  coverage: number;
  ownership: number;
  sections: number;
  gap: number;
  detection: number;
  unowned: number;
  exposure: number;
}

function compute(p: Params, elapsed: number): Values {
  const minutes = clamp(num(p, "handoffMinutes", 25), 5, 40);
  const coverage = clamp(num(p, "sectionCoverage", 95), 0, 100);
  const ownership = clamp(num(p, "riskOwnership", 95), 0, 100);
  const shortfall = clamp((20 - minutes) * 1.5, 0, 30);
  const gap = clamp((100 - coverage) * 0.45 + (100 - ownership) * 0.35 + shortfall, 0, 100);
  const detection = 5 + gap * 0.55;
  const unowned = Math.round(6 * (1 - ownership / 100));
  const exposure = clamp(
    gap * 0.3 + Math.max(0, elapsed - 10) * (gap / 100) * 1.05,
    0,
    100,
  );
  return {
    minutes,
    coverage,
    ownership,
    sections: Math.round((coverage / 100) * 5),
    gap,
    detection,
    unowned,
    exposure,
  };
}

function initialEvent(values: Values): SimFrame["events"][number] {
  return {
    id: "handoff-complete",
    at: 0,
    severity: "info",
    title: "Shift handoff",
    detail: `${values.sections} of 5 sections covered. ${values.unowned} known risk(s) have no owner. Detection is projected at ${values.detection.toFixed(0)} minutes.`,
  };
}

function buildFrame(p: Params, seed: number, elapsed: number, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, elapsed);
  const gapHealth = status(values.gap, 25, 50);
  const detectionHealth = status(values.detection, 15, 30);
  const ownershipHealth = status(100 - values.ownership, 20, 40);
  const exposureHealth = status(values.exposure, 30, 55);
  const sections = [
    "active incidents",
    "recent changes",
    "risky deploys",
    "expiring certificates",
    "known gaps",
  ];
  const missing = clamp(5 - values.sections, 0, 5);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "outgoing",
        label: "Outgoing on-call",
        kind: "worker",
        health: "ok",
        utilization: clamp(0.3 + values.gap / 240),
        sublabel: `${values.minutes} min handoff`,
        detail: "The outgoing engineer knows what changed. Writing it down is not a formality; it is the only way the knowledge survives the shift boundary.",
        meta: { view: "flow" },
      },
      {
        id: "record",
        label: "Handoff record",
        kind: "storage",
        health: gapHealth,
        utilization: clamp(values.gap / 100),
        sublabel: `${values.sections} of 5 sections`,
        detail: `Sections: ${sections.join(", ")}. Missing about ${missing} section(s) at the current coverage.`,
        meta: { view: "flow" },
      },
      {
        id: "incoming",
        label: "Incoming on-call",
        kind: "worker",
        health: detectionHealth,
        utilization: clamp(values.detection / 90),
        sublabel: `detect in ~${values.detection.toFixed(0)} min`,
        detail: "The incoming engineer can only act on context they can find. A risk without an owner becomes a question at 03:00.",
        meta: { view: "flow" },
      },
      {
        id: "risks",
        label: "Known risks",
        kind: "service",
        health: ownershipHealth,
        utilization: clamp((100 - values.ownership) / 100),
        sublabel: `${values.unowned} without an owner`,
        detail: "A risk belongs in the handoff with an owner, a next check, and an expiry. A risk list without owners is a list of things everyone assumes someone else is watching.",
        meta: { view: "flow" },
      },
      {
        id: "detection",
        label: "Incident detection",
        kind: "service",
        health: exposureHealth,
        utilization: clamp(values.exposure / 100),
        sublabel: `${values.exposure.toFixed(0)}% exposure`,
        detail: "Missing context delays detection. The metric models a known risk that surfaces after the shift starts; the values are illustrative.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("outgoing-record", "outgoing", "record", 1 - values.gap / 100, gapHealth),
      edge("record-incoming", "record", "incoming", 1 - values.gap / 100, gapHealth),
      edge("record-risks", "record", "risks", values.ownership / 100, ownershipHealth),
      edge("risks-detection", "risks", "detection", 1 - values.exposure / 100, exposureHealth),
    ],
    metrics: [
      metric("handoff-gap", "Handoff context gap", values.gap, "%", 25, 50, "percent"),
      metric("detection-delay", "Detection delay", values.detection, " min", 15, 30, "number"),
      metric("unowned-risks", "Risks without an owner", values.unowned, "", 2, 4, "count"),
      metric("risk-exposure", "Undetected risk exposure", values.exposure, "%", 30, 55, "percent"),
      metric("sections-covered", "Sections covered", values.sections, " of 5", undefined, undefined, "count"),
    ],
    events: [initialEvent(values)],
    series: {},
    flags: {
      ...flags,
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.gap.toFixed(0)}% context gap; ${values.unowned} unowned risk(s); detection projected at ${values.detection.toFixed(0)} min.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 11;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.95 + 0.07 * Math.sin((index + phase) / 3.1))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "handoff-gap",
    metricId: "handoff-gap",
    warn: 25,
    crit: 50,
    title: "The handoff is missing context the next shift needs",
    cause:
      "A short handoff, partial section coverage, or a risk list without owners leaves the incoming engineer to reconstruct state from dashboards and memory.",
    fix:
      "Use a fixed handoff template, cover all five sections, and require an owner and next check for every known risk. Spend the time before the shift ends, not after it starts.",
    checkFirst: [
      "Compare the handoff against the five required sections.",
      "Find every known risk that has no owner or next check.",
      "Check whether the incoming shift had to re-open a recently closed incident.",
    ],
  },
  {
    id: "detection-delay",
    metricId: "detection-delay",
    warn: 15,
    crit: 30,
    title: "Missing context is delaying detection",
    cause:
      "The incoming shift does not know which signals are already explained, so it spends time rediscovering changes and risks instead of acting on the new symptom.",
    fix:
      "Put the current hypothesis, next check, and expected signal in the handoff. Link the change or deploy that explains the current state, and say what would make it worse.",
    checkFirst: [
      "Check whether the incident was already known at handoff.",
      "Compare the time the signal appeared with the time someone acted.",
      "Check whether the handoff named the next check and its expected result.",
    ],
  },
  {
    id: "unowned-risks",
    metricId: "unowned-risks",
    warn: 2,
    crit: 4,
    title: "Known risks have no owner",
    cause:
      "A risk that is listed but not assigned looks handled in the handoff document. Ownership is the part that makes someone check it.",
    fix:
      "Assign each risk to a person, state the next check, and set an expiry or escalation point. Remove risks that are no longer real; do not carry a stale list.",
    checkFirst: [
      "Read the risk list and ask who owns each item.",
      "Check whether the owner knows they own it.",
      "Check whether each risk has a next check and a deadline.",
    ],
  },
  {
    id: "risk-exposure",
    metricId: "risk-exposure",
    warn: 30,
    crit: 55,
    title: "The unowned risk is now an incident",
    cause:
      "The risk surfaced after the shift started. Without an owner and a pre-agreed check, it grew until a customer symptom made it visible.",
    fix:
      "Treat the missed risk as a handoff defect in the review. Add the missing owner and check to the template, and verify the incoming shift can act on it without asking the outgoing engineer.",
    checkFirst: [
      "Identify the risk that surfaced and where it was recorded.",
      "Check who was supposed to watch it and when.",
      "Check whether the handoff named the expected symptom.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const handoffModel: SimModel = {
  id: "reliability-oncall-handoff",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed, 0, {}),
  step: (frame, p, _dt, rng) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const values = compute(p, frame.t);
    const next = buildFrame(p, seed, frame.t, frame.flags);
    next.t = frame.t;
    next.events = frame.events.slice(-60);
    if (frame.t === 0) {
      const seedEvent = initialEvent(values);
      next.events = next.events.map((event) => (event.id === seedEvent.id ? seedEvent : event));
    }
    if (values.gap >= 25 && values.unowned > 0 && frame.t >= 10 && frame.flags.handoffRiskEvent !== 1) {
      pushEvent(next, {
        id: "handoff-risk-surfaced",
        at: frame.t,
        severity: "warn",
        title: "A known risk surfaces on the new shift",
        detail: `The risk was listed in the handoff but has no owner and no next check. The incoming engineer is seeing it for the first time as a live symptom.`,
        nodeId: "risks",
        metricId: "unowned-risks",
      });
      next.flags.handoffRiskEvent = 1;
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
    const values = compute(p, frame.t);
    return [
      `The handoff covers ${values.sections} of 5 sections and leaves ${values.unowned} known risk(s) without an owner.`,
      `Detection is projected at ${values.detection.toFixed(0)} minutes. The context gap is ${values.gap.toFixed(0)}%.`,
      `Spending ${values.minutes} minutes on the handoff is not a cost center; it is the transfer of operational state.`,
      "An active incident is visible in every dashboard. An unowned risk is visible only to the person who forgot to hand it over.",
    ];
  },
  legend: [
    { label: "Context complete", tone: "ok" },
    { label: "Gaps present", tone: "warn" },
    { label: "Risk unowned", tone: "crit" },
    { label: "Detection lost", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 25-minute handoff with all five sections and an owner for every known risk.",
    tone: "ok",
    params: defaults({ handoffMinutes: 25, sectionCoverage: 100, riskOwnership: 95 }),
  },
  {
    id: "peak",
    label: "Busy shift",
    description: "The handoff is shortened to 15 minutes. Coverage and ownership slip, but the shift is still workable.",
    tone: "warn",
    params: defaults({ handoffMinutes: 15, sectionCoverage: 80, riskOwnership: 70 }),
  },
  {
    id: "failure",
    label: "Rushed handoff",
    description: "Five minutes, partial sections, and most risks have no owner. The new shift starts without context.",
    tone: "crit",
    params: defaults({ handoffMinutes: 5, sectionCoverage: 45, riskOwnership: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A written template, a 30-minute handoff, full section coverage, and explicit risk owners.",
    tone: "ok",
    params: defaults({ handoffMinutes: 30, sectionCoverage: 100, riskOwnership: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-missed-handoff",
  title: "Predict what the incoming shift misses",
  simId: "handoff",
  question:
    "A handoff lists the open incident and the latest deploy, but known risks have no owners. What fails first?",
  prediction: {
    options: [
      { id: "unowned-risk", label: "A known risk with no owner surfaces unnoticed" },
      { id: "incident-count", label: "The open incident count is wrong" },
      { id: "alert-route", label: "The paging route is misconfigured" },
      { id: "capacity", label: "The service runs out of capacity" },
    ],
    correctOptionId: "unowned-risk",
    explanation:
      "The open incident is visible and the deploy is in the change log. The risk is the item that depends on a person watching it. Listing a risk without an owner transfers the words but not the responsibility, so the next shift learns about it from a symptom.",
  },
  setup: defaults({ handoffMinutes: 10, sectionCoverage: 60, riskOwnership: 10 }),
  runFor: 45,
  observe: [
    "The context gap is critical before the shift is an hour old.",
    "Five known risks have no owner, so no one has a next check.",
    "Detection delay rises above 30 minutes and exposure climbs after the risk surfaces.",
    "The active incident is still visible; the failure came from the risk that was not assigned.",
  ],
  explain:
    "A handoff is not a status readout. It is a transfer of state: what is broken, what changed, what is risky, what expires, and what is still unknown. Each item needs the same three things to survive the shift boundary: an owner, a next check, and a condition that ends the watch. Without them, the incoming engineer can read the list and still not know what to do.",
  fix: defaults({ handoffMinutes: 30, sectionCoverage: 100, riskOwnership: 100 }),
  debrief:
    "With a full template and explicit owners, detection returns to a normal baseline and no risk is orphaned. The tradeoff is real: a thorough handoff costs 20 to 30 minutes per shift and can become a ritual if the template is not kept short. The alternative is paying for the missing context at the worst possible time.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An on-call handoff is the transfer of operational state from one shift to the next. It is not a status meeting and it is not a copy of the dashboard. The outgoing engineer knows which alerts are already explained, which change is still rolling out, which certificate expires this week, and which risk has no owner. The incoming engineer knows none of that until it is written down or said out loud.",
  },
  {
    type: "p",
    text: "A useful handoff covers five kinds of context: active incidents, recent changes, risky deploys, expiring certificates or credentials, and known gaps. Each item needs an owner, a next check, and a condition that ends the watch. A list of open incidents without that structure is a summary. It tells the next shift what happened, not what to do next.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The handoff sits between shifts, after runbooks and before the next incident. Runbooks explain how to handle a known failure. The handoff explains which failure is already in progress and which one is likely next. It is also where the previous shift's unfinished work becomes visible: an open action, a partial rollback, a risk accepted for the weekend.",
  },
  {
    type: "table",
    headers: ["Handoff item", "What a complete record contains", "What fails when it is missing"],
    rows: [
      ["Active incidents", "Severity, owner, current hypothesis, next update time", "The new shift re-investigates from zero or duplicates work"],
      ["Recent changes", "Deploys, config changes, feature flags, who and why", "A new symptom is blamed on the wrong cause"],
      ["Risky deploys", "Rollout stage, canary result, rollback trigger", "A partial rollout is mistaken for a stable release"],
      ["Expiring certificates", "Expiry date, rotation owner, next check", "A known deadline becomes an outage"],
      ["Known gaps", "Untested failover, missing dashboard, open action, owner", "Everyone assumes someone else is watching it"],
    ],
  },
  {
    type: "p",
    text: "The timings and percentages in this module are illustrative teaching values. The model compresses one shift into 60 simulated seconds and does not represent a real paging vendor or a specific company's handoff policy.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Handoff context gap: the weighted share of missing sections, unowned risks, and a rushed handoff.",
      "Detection delay: projected minutes before the incoming shift recognizes a risk that is already present.",
      "Risks without an owner: the count that survives the handoff as words but not as responsibility.",
      "Undetected risk exposure: a modeled index that grows after a known risk surfaces on the new shift.",
      "A flow from the outgoing engineer through the handoff record to the incoming engineer and the risk register.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read the five-section table. Apply Rushed handoff, then watch the risk list and detection delay. Run the experiment before reading the explanation: decide which item the new shift is most likely to miss, then restore the owners and re-run.",
  },
  { type: "sim", simId: "handoff" },
  { type: "experiment", experimentId: "predict-missed-handoff" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The rushed handoff transferred the visible incident and the latest change, but not the risks. The incoming engineer could see the service was unhealthy; what they could not see was which known weakness was about to become the next symptom. Detection delay rose, and the exposure metric climbed once the risk surfaced.",
  },
  {
    type: "p",
    text: "Restoring the template and the owners changed the outcome without changing the system. The incident did not disappear. The difference was that someone knew it was there, knew what to check, and knew when to escalate. That is the operational value of a handoff.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Handoff notes or a shift log with fields for incidents, changes, deploy state, certificate expiry, and open risks.",
      "The deploy pipeline and change log, which show what moved during the previous shift and whether the rollout is complete.",
      "Certificate and credential expiry dashboards, or the inventory that feeds them.",
      "The incident tracker, where an active incident's owner and next update should match the handoff.",
      "Open action items with owners and due dates, especially risks accepted temporarily.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask the incoming engineer to name the next check for every risk in the handoff. If they cannot, the handoff transferred a list, not responsibility. Then compare the handoff against the change log and the open incident queue.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Use one template with the five sections. Keep it short enough that it is completed every shift.",
      "For every active incident, record severity, owner, current hypothesis, and next update time.",
      "List recent changes and risky deploys with rollout state and the rollback trigger.",
      "List expiring certificates and credentials with the rotation owner and the next check.",
      "Give every known gap an owner, a next check, and an expiry or escalation point.",
      "Read the handoff aloud on the boundary and let the incoming engineer ask questions before the outgoing engineer disconnects.",
      "Review missed or late risks after the shift and change the template, not just the individual behavior.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A thorough handoff costs 20 to 30 minutes per shift. A template that is too long gets skipped, which is worse than a short one that is completed.",
      "Written handoffs are searchable but stale; verbal handoffs are current but leave no record. Use both, with the written record as the source of truth.",
      "Listing every risk creates noise. Keep the list to risks with a plausible path to customer impact and a named owner.",
      "A handoff cannot compensate for a missing runbook or an unowned system. It can make the gap visible, which is the first step to fixing it.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "handoff-contents",
    question: "What belongs in an on-call handoff, and what does not?",
    difficulty: 1,
    hints: [
      "Think about what the next shift cannot reconstruct from dashboards.",
      "Separate state from status.",
    ],
    answer:
      "A handoff should carry active incidents with severity, owner, hypothesis, and next update; recent changes and deploys with rollout state and rollback trigger; expiring certificates and credentials; and known gaps with an owner and next check. It should not carry a full dashboard readout, a narrative of everything that happened, or risks without owners. The test is whether the incoming engineer can act without calling the outgoing engineer.",
    followUps: [
      "Which item is most often missing?",
      "How do you keep the handoff under 30 minutes?",
      "What would you remove from a handoff that has grown too long?",
    ],
    redFlags: [
      "Reads the dashboard aloud.",
      "Lists incidents without owners.",
      "Treats the handoff as a status report rather than a transfer of responsibility.",
    ],
    rubric: [
      "Names the five content areas.",
      "Requires owners and next checks.",
      "Excludes status noise.",
      "Defines a test for a complete handoff.",
    ],
  },
  {
    id: "mid-incident-handoff",
    question: "An incident is still active when the shift ends. How do you hand it off without losing momentum?",
    difficulty: 2,
    hints: [
      "The incident owner should not change silently.",
      "The next action matters more than the full history.",
    ],
    answer:
      "I would keep the incident commander or owner stable if possible, and hand off the working state explicitly: current impact, what has been tried, what was ruled out, the current hypothesis, the next action, and the time of the next update. I would introduce the incoming engineer in the incident channel, transfer the action items, and keep the outgoing engineer available for a short overlap. The handoff should end with the incoming owner stating the next action back, so ambiguity is visible before the outgoing engineer leaves.",
    followUps: [
      "When would you delay the handoff instead?",
      "How do you avoid two people giving orders?",
      "What belongs in the incident channel versus the handoff note?",
    ],
    redFlags: [
      "Drops the incident into a channel with no owner.",
      "Transfers the whole history instead of the working state.",
      "Leaves the next action implicit.",
    ],
    rubric: [
      "Preserves a single owner.",
      "Transfers hypothesis and next action.",
      "Uses a read-back or explicit confirmation.",
      "Keeps overlap bounded.",
    ],
  },
  {
    id: "handoff-ritual",
    question: "Your handoff has become a 45-minute ritual that people skip. What do you change?",
    difficulty: 3,
    hints: [
      "The template may be optimized for completeness rather than decisions.",
      "Measure whether the next shift had to ask for missing context.",
    ],
    answer:
      "I would measure the handoff by the questions it prevents, not by its length. Cut the template to the five sections and require only the fields that change the next action: owner, next check, and expiry. Move stable context into links or the runbook. Timebox the verbal part and start with items that are still moving. Then track how often the incoming shift has to ask the outgoing engineer for context after the handoff, and remove fields that never change a decision.",
    followUps: [
      "Which metrics would tell you the handoff is working?",
      "How do you handle a shift with nothing to hand off?",
      "What is the risk of making the template too short?",
    ],
    redFlags: [
      "Adds more fields to fix a long handoff.",
      "Measures attendance instead of outcomes.",
      "Removes ownership fields to save time.",
    ],
    rubric: [
      "Measures missing-context questions.",
      "Trims to decision-relevant fields.",
      "Keeps owner and next check.",
      "States the risk of over-trimming.",
    ],
  },
  {
    id: "unowned-risk",
    question: "A known risk is listed in the handoff but has no owner. What do you do before the outgoing engineer leaves?",
    difficulty: 2,
    hints: [
      "A risk without an owner is not transferred.",
      "The owner needs a next check, not just a name.",
    ],
    answer:
      "I would not accept the handoff as complete. I would assign the risk to a named person, agree on the next check and its expected result, and set a time when the risk either expires or escalates. If no one can own it, I would escalate it to the person who can accept the risk explicitly, or remove it from the list with a reason. The point is to make the ownership decision visible before the shift boundary, not to leave a name in a document.",
    followUps: [
      "What if the risk owner is not on call?",
      "How do you record an accepted risk?",
      "When should a risk expire?",
    ],
    redFlags: [
      "Assigns the risk to a team alias.",
      "Accepts a name without a next check.",
      "Leaves the risk on the list indefinitely.",
    ],
    rubric: [
      "Requires a named owner.",
      "Defines next check and expected result.",
      "Has an expiry or escalation.",
      "Makes accepted risk explicit.",
    ],
  },
];

const checklist = [
  {
    title: "Before the shift",
    items: [
      "The handoff template has fields for all five sections.",
      "Active incidents have an owner, hypothesis, and next update time.",
      "Recent changes and risky deploys include rollout state and rollback trigger.",
      "Certificate and credential expiries are visible with rotation owners.",
      "Every known risk has an owner, next check, and expiry.",
    ],
  },
  {
    title: "At the boundary",
    items: [
      "Read the handoff in a shared channel with both shifts present.",
      "Start with items that are still moving, not with a full history.",
      "Ask the incoming engineer to restate the next action for each active item.",
      "Introduce the incoming owner in every active incident channel.",
      "Record any question that required the outgoing engineer's memory.",
    ],
  },
  {
    title: "After the shift",
    items: [
      "Review risks that surfaced without an owner and fix the template.",
      "Close or re-own items that were carried without progress.",
      "Check whether the incoming shift had to rediscover a known change.",
      "Remove stale items instead of carrying them forward.",
    ],
  },
];

const references = [
  {
    title: "On-Call",
    url: "https://sre.google/workbook/on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Pager load, rotation design, and the daily on-call handoff.",
  },
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "On-call workload balance, actionable pages, and operational overload.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    handoff: {
      model: handoffModel,
      presets,
      instructions:
        "Start healthy, then apply Rushed handoff. Watch the risk list and detection delay. Restore owners and sections, then re-run the experiment.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The five sections are a teaching checklist, not a mandated company policy.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-runbooks",
    "reliability-escalation",
    "reliability-incident-command",
    "reliability-comms-cadence",
    "reliability-severity-levels",
  ],
};
