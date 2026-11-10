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
    id: "weeklyPages",
    label: "Pages per week",
    min: 14,
    max: 210,
    step: 7,
    value: 28,
    unit: "",
    group: "Volume",
    help: "Total paging alerts sent to the rotation in one week. This is the input; pages per shift and pages per person are the useful measures.",
    format: "count",
  },
  {
    id: "actionableShare",
    label: "Actionable share",
    min: 5,
    max: 100,
    step: 5,
    value: 90,
    unit: "%",
    group: "Quality",
    help: "Share of pages that require a human action the system cannot take itself. A page that only asks someone to look is noise.",
    format: "percent",
  },
  {
    id: "routingPrecision",
    label: "Routing precision",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Quality",
    help: "Share of pages delivered to the service and person who can act on them. Misroutes add work without adding detection.",
    format: "percent",
  },
  {
    id: "rotationSize",
    label: "Rotation size",
    min: 2,
    max: 12,
    step: 1,
    value: 8,
    unit: "",
    group: "Rotation",
    help: "Engineers sharing the rotation. A larger rotation lowers pages per person and raises recovery time between shifts.",
    format: "count",
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
  weeklyPages: number;
  pagesPerShift: number;
  pagesPerPerson: number;
  actionableShare: number;
  routing: number;
  rotation: number;
  actionablePages: number;
  noisePages: number;
  ack: number;
  fatigue: number;
  fatiguePlateau: number;
  missed: number;
}

function compute(p: Params, elapsed: number): Values {
  const weeklyPages = clamp(num(p, "weeklyPages", 28), 14, 210);
  const actionableShare = clamp(num(p, "actionableShare", 90), 5, 100);
  const routing = clamp(num(p, "routingPrecision", 95), 0, 100);
  const rotation = clamp(Math.round(num(p, "rotationSize", 8)), 2, 12);
  const pagesPerShift = weeklyPages / 14;
  const pagesPerPerson = weeklyPages / rotation;
  const actionablePages = pagesPerShift * (actionableShare / 100);
  const noisePages = pagesPerShift - actionablePages;
  const ack =
    2 +
    Math.max(0, pagesPerShift - 2) * 1.2 +
    Math.max(0, 6 - rotation) * 0.9 +
    (100 - routing) * 0.03;
  const fatiguePlateau = clamp(
    pagesPerPerson * 0.55 +
      noisePages * 6 +
      (100 - actionableShare) * 0.25 +
      Math.max(0, 4 - rotation) * 8,
    0,
    100,
  );
  const fatigue = clamp(fatiguePlateau * (0.55 + 0.45 * Math.min(1, elapsed / 45)), 0, 100);
  const missed = clamp(
    Math.max(0, fatigue - 20) * 0.7 +
      noisePages * 1.8 +
      Math.max(0, ack - 5) * 2 +
      (100 - routing) * 0.15,
    0,
    100,
  );
  return {
    weeklyPages,
    pagesPerShift,
    pagesPerPerson,
    actionableShare,
    routing,
    rotation,
    actionablePages,
    noisePages,
    ack,
    fatigue,
    fatiguePlateau,
    missed,
  };
}

function initialEvent(values: Values): SimFrame["events"][number] {
  return {
    id: "rotation-week-start",
    at: 0,
    severity: "info",
    title: "Rotation week begins",
    detail: `${values.weeklyPages} pages are expected this week: ${values.pagesPerShift.toFixed(1)} per shift and ${values.pagesPerPerson.toFixed(1)} per person. ${values.actionableShare.toFixed(0)}% are modeled as actionable.`,
  };
}

function buildFrame(p: Params, seed: number, elapsed: number, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, elapsed);
  const actionableHealth = status(100 - values.actionableShare, 20, 40);
  const routingHealth = status(100 - values.routing, 20, 40);
  const fatigueHealth = status(values.fatigue, 40, 70);
  const missedHealth = status(values.missed, 10, 25);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "signal",
        label: "Monitoring signals",
        kind: "service",
        health: "ok",
        utilization: clamp(values.weeklyPages / 210),
        sublabel: `${values.weeklyPages} alerts/week`,
        detail: "The signal layer is not the problem by itself. The question is how many of its alerts deserve a human interruption.",
        meta: { view: "flow" },
      },
      {
        id: "rules",
        label: "Alert rules",
        kind: "service",
        health: actionableHealth,
        utilization: clamp((100 - values.actionableShare) / 100),
        sublabel: `${values.actionableShare.toFixed(0)}% actionable`,
        detail: "Every paging rule should describe an action the system cannot take itself. A page that only asks someone to look is a ticket or a dashboard.",
        meta: { view: "flow" },
      },
      {
        id: "routing",
        label: "Routing",
        kind: "service",
        health: routingHealth,
        utilization: clamp((100 - values.routing) / 100),
        sublabel: `${values.routing.toFixed(0)}% to the right owner`,
        detail: "Misrouted pages add a lookup and a handoff before any work starts. They consume attention without improving detection.",
        meta: { view: "flow" },
      },
      {
        id: "oncall",
        label: "On-call engineer",
        kind: "worker",
        health: fatigueHealth,
        utilization: clamp(values.fatigue / 100),
        sublabel: `${values.pagesPerPerson.toFixed(1)} pages/person/week`,
        detail: `The model estimates ${values.ack.toFixed(1)} minutes to acknowledge at the current load. The values are illustrative, not a vendor benchmark.`,
        meta: { view: "flow" },
      },
      {
        id: "missed",
        label: "Missed critical alert",
        kind: "service",
        health: missedHealth,
        utilization: clamp(values.missed / 100),
        sublabel: `${values.missed.toFixed(0)}% modeled risk`,
        detail: "Detection loss is the cost that matters. A quieter pager that also misses the real page has not fixed anything.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("signal-rules", "signal", "rules", 1, actionableHealth),
      edge("rules-routing", "rules", "routing", values.actionableShare / 100, routingHealth),
      edge("routing-oncall", "routing", "oncall", values.routing / 100, fatigueHealth),
      edge("oncall-missed", "oncall", "missed", 1 - values.missed / 100, missedHealth),
    ],
    metrics: [
      metric("pages-per-shift", "Pages per shift", values.pagesPerShift, "", 4, 8, "count"),
      metric("ack-latency", "Acknowledgement latency", values.ack, " min", 5, 10, "number"),
      metric("fatigue-index", "Fatigue index", values.fatigue, "%", 40, 70, "percent"),
      metric("missed-critical", "Missed critical risk", values.missed, "%", 10, 25, "percent"),
    ],
    events: [initialEvent(values)],
    series: {},
    flags: {
      ...flags,
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.pagesPerShift.toFixed(1)} pages/shift; ${values.fatigue.toFixed(0)}% fatigue; ${values.missed.toFixed(0)}% missed-critical risk.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 9;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.94 + 0.09 * Math.sin((index + phase) / 2.8))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pages-per-shift",
    metricId: "pages-per-shift",
    warn: 4,
    crit: 8,
    title: "Page load is above a sustainable shift",
    cause:
      "The rotation is receiving more pages than one engineer can triage and follow up. Volume alone is not the whole diagnosis, but it sets the ceiling on everything else.",
    fix:
      "Measure pages per shift and per person, then remove pages that do not require an immediate human action. Route low-urgency signals to tickets and keep paging for SLO-threatening symptoms.",
    checkFirst: [
      "Split pages per shift by service and by alert rule.",
      "Count how many pages required a human action within five minutes.",
      "Check whether a single noisy rule explains most of the volume.",
    ],
  },
  {
    id: "ack-latency",
    metricId: "ack-latency",
    warn: 5,
    crit: 10,
    title: "Pages are waiting too long for acknowledgement",
    cause:
      "A tired or overloaded engineer cannot triage every page immediately. The delay shows up first on the low-priority pages, then on the one that matters.",
    fix:
      "Reduce the number of interruptions before adding more people to the rotation. A larger rotation spreads the load but does not make a noisy rule quieter.",
    checkFirst: [
      "Compare acknowledgement time for the noisiest rules and the critical ones.",
      "Check whether pages arrive in clusters that exceed one person's capacity.",
      "Check whether the rotation has enough recovery time between shifts.",
    ],
  },
  {
    id: "fatigue-index",
    metricId: "fatigue-index",
    warn: 40,
    crit: 70,
    title: "On-call fatigue is now a reliability risk",
    cause:
      "Sustained page volume, low actionability, and short recovery time reduce attention. Fatigue is not a personal failing; it is a property of the rotation and the alert set.",
    fix:
      "Bound the page load, remove non-actionable alerts, and protect recovery time. Review the rotation as a system, not as an individual's resilience.",
    checkFirst: [
      "Check pages per person per week and the gap between shifts.",
      "Check the actionable share of pages, not only the total.",
      "Ask the rotation which pages they ignore and why.",
    ],
  },
  {
    id: "missed-critical",
    metricId: "missed-critical",
    warn: 10,
    crit: 25,
    title: "A critical page is at risk of being missed",
    cause:
      "High noise and long acknowledgement delay make every page look like the last one. The real incident arrives in the same channel as the alerts people have learned to dismiss.",
    fix:
      "Restore signal-to-noise first: remove non-actionable pages, aggregate related alerts, and keep a separate path for critical pages. Then verify detection on a known critical signal.",
    checkFirst: [
      "Check whether the missed page was delivered and acknowledged.",
      "Compare the critical alert's routing with the noisy rules.",
      "Check whether suppression or grouping hid the critical event.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const pagingModel: SimModel = {
  id: "reliability-paging-fatigue",
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
    if (values.noisePages >= 3 && frame.t >= 20 && frame.flags.pagingNoiseEvent !== 1) {
      pushEvent(next, {
        id: "paging-noise-crowds",
        at: frame.t,
        severity: "warn",
        title: "Alert noise is crowding the pager",
        detail: `${values.noisePages.toFixed(1)} of ${values.pagesPerShift.toFixed(1)} pages per shift are not modeled as actionable. The critical page shares the same attention budget.`,
        nodeId: "rules",
        metricId: "missed-critical",
      });
      next.flags.pagingNoiseEvent = 1;
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
      `${values.pagesPerShift.toFixed(1)} pages per shift and ${values.pagesPerPerson.toFixed(1)} per person per week. Raw weekly volume hides both numbers.`,
      `${values.actionableShare.toFixed(0)}% of pages are modeled as actionable; ${values.noisePages.toFixed(1)} pages per shift are not.`,
      `Acknowledgement is projected at ${values.ack.toFixed(1)} minutes, with a ${values.missed.toFixed(0)}% modeled risk of missing a critical page.`,
      `A rotation of ${values.rotation} people changes who absorbs the load, not how much load the alert set creates.`,
    ];
  },
  legend: [
    { label: "Sustainable", tone: "ok" },
    { label: "Load rising", tone: "warn" },
    { label: "Fatigued", tone: "crit" },
    { label: "Detection lost", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "28 pages a week, 90% actionable, precise routing, and eight engineers in the rotation.",
    tone: "ok",
    params: defaults({ weeklyPages: 28, actionableShare: 90, routingPrecision: 95, rotationSize: 8 }),
  },
  {
    id: "peak",
    label: "Busy week",
    description: "70 pages a week and a six-person rotation. Page load and acknowledgement time are above target.",
    tone: "warn",
    params: defaults({ weeklyPages: 70, actionableShare: 75, routingPrecision: 85, rotationSize: 6 }),
  },
  {
    id: "failure",
    label: "Pager overload",
    description: "180 pages a week, most not actionable, poor routing, and three engineers sharing the rotation.",
    tone: "crit",
    params: defaults({ weeklyPages: 180, actionableShare: 25, routingPrecision: 45, rotationSize: 3 }),
  },
  {
    id: "noisy",
    label: "Noisy alerts",
    description: "The volume is moderate, but only 30% of pages require action. Noise still buries the critical page.",
    tone: "crit",
    params: defaults({ weeklyPages: 90, actionableShare: 30, routingPrecision: 70, rotationSize: 6 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Low volume, high actionability, precise routing, and a healthy eight-person rotation.",
    tone: "ok",
    params: defaults({ weeklyPages: 30, actionableShare: 95, routingPrecision: 98, rotationSize: 8 }),
  },
];

const experiment: Experiment = {
  id: "predict-paging-fix",
  title: "Predict what lowers missed critical pages",
  simId: "paging",
  question:
    "The rotation receives 80 pages a week and missed a critical page. Which change most directly reduces the risk?",
  prediction: {
    options: [
      { id: "remove-noise", label: "Remove non-actionable pages and route low-urgency signals to tickets" },
      { id: "bigger-rotation", label: "Add four more engineers to the rotation" },
      { id: "more-dashboards", label: "Add dashboards so each page can be diagnosed faster" },
      { id: "longer-ack", label: "Increase the acknowledgement timeout so pages stop escalating" },
    ],
    correctOptionId: "remove-noise",
    explanation:
      "A larger rotation spreads the same pages across more people, and dashboards help after a page is noticed. Neither reduces the attention consumed by pages that did not need a human. Removing non-actionable pages lowers the load and raises the signal-to-noise ratio of the critical page.",
  },
  setup: defaults({ weeklyPages: 80, actionableShare: 30, routingPrecision: 70, rotationSize: 4 }),
  runFor: 60,
  observe: [
    "Pages per shift is above four from the first shift of the week.",
    "Fatigue climbs through the week and crosses the critical threshold before the week ends.",
    "Missed critical risk rises while acknowledgement latency grows.",
    "A larger rotation would change the per-person number, not the total page load or the noise.",
  ],
  explain:
    "Paging fatigue is a load and quality problem. The useful measures are pages per shift, pages per person, the fraction that lead to action, acknowledgement latency, and missed critical pages. Raw alert count is an input, not a diagnosis. Reducing volume without measuring detection can hide the real page; increasing headcount without fixing the alert set moves the same noise to more people.",
  fix: defaults({ weeklyPages: 28, actionableShare: 95, routingPrecision: 98, rotationSize: 8 }),
  debrief:
    "With a quieter, more actionable pager, fatigue and missed-critical risk fall together. The tradeoff is that filtering requires judgment: suppress too aggressively and a real page disappears. Keep a review path for suppressed alerts, measure detection on a known critical signal, and treat the rotation's recovery time as part of the design.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Paging fatigue is the loss of attention and judgment that follows too many interruptions. It is not a character flaw and it is not solved by telling the rotation to be more careful. A page is an interrupt that asks a person to act now. If most pages do not need action now, the person learns to treat all of them the same way, including the one that matters.",
  },
  {
    type: "p",
    text: "The useful unit is the shift, not the week. Pages per week hide how the load lands: fourteen pages spread evenly are different from fourteen pages in one night. Pages per person per week and recovery time between shifts describe the human load. The actionable share describes the quality of the interruption. Missed critical pages describe whether detection survived the change.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Paging sits between alerting and response. The alerting layer decides which events deserve a page; the rotation decides who receives them; escalation decides what happens when they are not acknowledged. Paging fatigue is the feedback loop between those layers. A noisy alert set creates a tired rotation, and a tired rotation acknowledges the next page more slowly.",
  },
  {
    type: "table",
    headers: ["Measure", "What it answers", "Why the raw count is not enough"],
    rows: [
      ["Pages per shift", "Can one person triage this load?", "A weekly total can hide a single overloaded night"],
      ["Pages per person per week", "How often does one engineer lose recovery time?", "The total is spread unevenly across the rotation"],
      ["Actionable share", "Did the page require a human now?", "A page that only asks someone to look still interrupts"],
      ["Acknowledgement latency", "Is the rotation keeping up?", "A fast acknowledgement can still be a tired one"],
      ["Missed critical risk", "Did detection survive the change?", "A quiet pager can be quiet because it stopped working"],
    ],
  },
  {
    type: "p",
    text: "Google's SRE Workbook describes a target of at most two incidents per on-call shift, and the SRE Book gives fewer than two paging events per shift as an example target. That guidance is a starting point, not a universal service-level target. The values in this simulation are illustrative teaching values and do not represent a specific paging vendor's limits. The model compresses a week of rotation into 60 simulated seconds.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pages per shift: the weekly volume divided into the shifts that actually receive it.",
      "Acknowledgement latency: a modeled delay that grows with load, misroutes, and a smaller rotation.",
      "Fatigue index: a composite of pages per person, noise, actionability, and recovery time.",
      "Missed critical risk: the modeled chance that the important page is lost in the same attention budget.",
      "A flow from monitoring signals through alert rules and routing to the on-call engineer.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note pages per shift and actionable share. Apply Pager overload, then Noisy alerts: the second has less volume but still fails on quality. Run the experiment and predict which change reduces missed critical risk before you read the explanation.",
  },
  { type: "sim", simId: "paging" },
  { type: "experiment", experimentId: "predict-paging-fix" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The rotation absorbed 80 pages in a week, but many of them did not need a human action. Fatigue accumulated across shifts, acknowledgement slowed, and the critical page competed with noise for the same attention. Adding engineers would have lowered pages per person; it would not have made the pages worth reading.",
  },
  {
    type: "p",
    text: "Removing non-actionable pages lowered the load and raised the actionable share. The critical page became a larger fraction of what the rotation saw, and missed-critical risk fell. The model is deterministic and illustrative: it shows the direction and the tradeoff, not a forecast for a real rotation.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Paging tool analytics: pages per shift, per user, per service, and per alert rule.",
      "Acknowledgement and escalation timestamps, split by alert rule and time of day.",
      "Alert rules that fire on causes rather than symptoms, or that fire without a documented action.",
      "Incident records for pages that led to no action, and for critical incidents that were detected late.",
      "Rotation schedules that show recovery time between shifts and the distribution of weekend load.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count pages per shift, then count how many required a human action within five minutes. If the second number is much smaller, the problem is quality before quantity. If both are high, check whether one rule or one service owns most of the volume.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure pages per shift, pages per person, actionable share, acknowledgement latency, and missed critical pages.",
      "Find the top rules by page volume and ask what action each page expects.",
      "Convert non-actionable pages to tickets, dashboards, or batch reviews.",
      "Group related alerts and deduplicate pages that describe one incident.",
      "Keep paging for symptoms that threaten an SLO and require action now.",
      "Protect recovery time and review the rotation after the alert set changes.",
      "Verify detection with a known critical signal before declaring the pager healthier.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Filtering reduces noise but can suppress a real page. Keep a review path and measure missed detections.",
      "A larger rotation spreads load but increases the number of people who need context for each incident.",
      "Grouping related pages reduces interruptions but can hide the first symptom of a larger failure.",
      "Moving low-urgency alerts to tickets protects attention but adds a queue that someone must still review.",
      "A pager that is quiet because detection is broken is worse than a noisy one.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "measure-paging",
    question: "The rotation receives 80 pages a week. What do you measure before changing anything?",
    difficulty: 2,
    hints: [
      "A weekly count hides how the load lands.",
      "Separate volume, quality, and detection.",
    ],
    answer:
      "I would measure pages per shift and pages per person per week, the actionable share, acknowledgement and escalation latency, and the rate of missed or late critical pages. I would also split the volume by alert rule, service, and time of day. That tells me whether the problem is total load, one noisy rule, poor routing, or a rotation that is too small for the load.",
    followUps: [
      "What if the total is low but one night is overloaded?",
      "How would you measure the actionable share without asking engineers to tag every page?",
      "Which metric would you put on a dashboard first?",
    ],
    redFlags: [
      "Uses only the weekly total.",
      "Assumes a larger rotation is the fix.",
      "Does not measure detection.",
    ],
    rubric: [
      "Names per-shift load.",
      "Separates actionable from noise.",
      "Includes acknowledgement and detection.",
      "Segments by rule or service.",
    ],
  },
  {
    id: "reduce-without-detection-loss",
    question: "How do you reduce page volume without reducing detection?",
    difficulty: 3,
    hints: [
      "Remove pages that do not require an action now.",
      "Verify detection with a known critical signal.",
    ],
    answer:
      "I would remove or downgrade pages that do not require an immediate human action, group alerts that describe the same incident, and route low-urgency signals to tickets or dashboards. I would keep paging for symptoms that threaten an SLO. Then I would test detection by injecting or replaying a known critical condition and confirming that it still pages the right person. The change is only successful if both the page count and the missed-critical rate move in the right direction.",
    followUps: [
      "How do you decide whether an alert is actionable?",
      "What would you do with an alert that is important but not urgent?",
      "How do you test detection after suppression changes?",
    ],
    redFlags: [
      "Raises thresholds without checking detection.",
      "Mutes a whole service to reduce noise.",
      "Treats every alert as equally important.",
    ],
    rubric: [
      "Removes non-actionable pages.",
      "Keeps SLO-threatening pages.",
      "Groups related alerts.",
      "Verifies detection explicitly.",
    ],
  },
  {
    id: "rotation-size",
    question: "Does doubling the rotation size fix paging fatigue?",
    difficulty: 2,
    hints: [
      "Separate total load from per-person load.",
      "Recovery time matters, but the pages still exist.",
    ],
    answer:
      "It can reduce pages per person and increase recovery time, which helps. But it does not reduce the total page load or improve the actionable share, and it increases the number of people who need context for each incident. If the alert set is noisy, a larger rotation distributes the noise. I would fix the alert quality first, then size the rotation for the remaining load and the required recovery time.",
    followUps: [
      "When would a larger rotation be the right first move?",
      "What is the cost of a larger rotation?",
      "How do you measure recovery time?",
    ],
    redFlags: [
      "Treats headcount as a substitute for alert quality.",
      "Ignores context sharing.",
      "Assumes fatigue is evenly distributed.",
    ],
    rubric: [
      "Distinguishes total from per-person load.",
      "Names the context cost.",
      "Prioritizes alert quality.",
      "Considers recovery time.",
    ],
  },
  {
    id: "missed-critical",
    question: "A critical page was missed during a noisy week. How do you investigate it without blaming the engineer?",
    difficulty: 3,
    hints: [
      "Look at the system that delivered and prioritized the page.",
      "Compare the critical page with the noise around it.",
    ],
    answer:
      "I would reconstruct the page timeline: when it was delivered, how it was routed, whether it was grouped or suppressed, and what else arrived in the same window. I would compare its signal with the noisy rules and check whether the rotation had a reasonable chance to distinguish it. Then I would fix the alert set, routing, or grouping, and add a detection test. The engineer's response is part of the timeline, but the actionable cause is usually the system that made the page indistinguishable.",
    followUps: [
      "What if the page was never delivered?",
      "How do you review suppression rules after the fact?",
      "What would you change first if the same rule caused the noise?",
    ],
    redFlags: [
      "Starts with individual performance.",
      "Ignores grouping and suppression.",
      "Adds another alert instead of fixing the noisy one.",
    ],
    rubric: [
      "Reconstructs delivery and routing.",
      "Checks grouping and suppression.",
      "Blames the system, not the person.",
      "Adds a detection test.",
    ],
  },
];

const checklist = [
  {
    title: "Measure",
    items: [
      "Pages per shift and pages per person per week are visible.",
      "Actionable share is measured or sampled by rule.",
      "Acknowledgement and escalation latency are recorded.",
      "Missed and late critical pages are tracked separately from total volume.",
    ],
  },
  {
    title: "Reduce",
    items: [
      "Every paging rule names the action it expects and why it cannot wait.",
      "Low-urgency signals route to tickets or dashboards, not the pager.",
      "Related alerts are grouped without hiding the first symptom.",
      "Suppression and grouping changes are reviewed against a known critical signal.",
    ],
  },
  {
    title: "Protect",
    items: [
      "The rotation has enough recovery time between shifts.",
      "Pages that arrive in clusters have an escalation path.",
      "The team reviews the noisiest rules on a regular cadence.",
      "A quiet pager is verified with a detection test, not assumed healthy.",
    ],
  },
];

const references = [
  {
    title: "On-Call",
    url: "https://sre.google/workbook/on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Pager load, actionable pages, rotation design, and a target of at most two incidents per shift.",
  },
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Sustainable on-call load, actionable alerts, and the cost of operational overload.",
  },
  {
    title: "On-call schedules",
    url: "https://support.pagerduty.com/docs/schedules",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Shift schedules, rotation layers, and handoff boundaries.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    paging: {
      model: pagingModel,
      presets,
      instructions:
        "Start healthy, then apply Pager overload and Noisy alerts. Compare pages per shift with actionable share. Run the experiment before restoring the quieter pager.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Page-load targets vary by service and rotation; the thresholds here are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-alert-fatigue",
    "reliability-escalation",
    "reliability-oncall-handoff",
    "observability-symptom-alerting",
    "reliability-toil",
  ],
};
