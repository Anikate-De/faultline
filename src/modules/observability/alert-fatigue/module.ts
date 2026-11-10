import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SHIFTS_PER_WEEK = 21;

const params: ParamSpec[] = [
  {
    id: "incidentsPerWeek",
    label: "Real incidents",
    min: 2,
    max: 20,
    step: 1,
    value: 6,
    unit: " / week",
    group: "Demand",
    help: "Incidents that actually need a human. This is the denominator for detection and missed-incident measures.",
    format: "count",
  },
  {
    id: "rulesCount",
    label: "Paging rules",
    min: 5,
    max: 80,
    step: 1,
    value: 10,
    unit: "",
    group: "Supply",
    help: "Rules routed to the pager. Each rule adds page volume whether or not it finds a real incident.",
    format: "count",
  },
  {
    id: "thresholdPct",
    label: "Alert threshold",
    min: 50,
    max: 100,
    step: 1,
    value: 62,
    unit: "%",
    group: "Supply",
    help: "A higher threshold suppresses low-level alerts and also reduces detection. It does not remove the tradeoff.",
    format: "percent",
  },
  {
    id: "dedupeWindowMin",
    label: "Dedupe window",
    min: 0,
    max: 60,
    step: 5,
    value: 20,
    unit: " min",
    group: "Supply",
    help: "Repeated alerts for the same object inside this window are grouped. It reduces volume but does not fix a bad rule.",
    format: "count",
  },
  {
    id: "ownershipPct",
    label: "Correct ownership",
    min: 20,
    max: 100,
    step: 1,
    value: 92,
    unit: "%",
    group: "Routing",
    help: "Alerts that reach the team that can act. Misrouted pages add delay even when the signal is real.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  incidents: number;
  rules: number;
  threshold: number;
  dedupe: number;
  ownership: number;
  volume: number;
  detected: number;
  actionable: number;
  noise: number;
  missed: number;
  actionability: number;
  ackMin: number;
  misrouted: number;
  pagesPerShift: number;
  detectionPct: number;
}

function compute(p: Params): Computed {
  const incidents = num(p, "incidentsPerWeek", 6);
  const rules = num(p, "rulesCount", 10);
  const threshold = num(p, "thresholdPct", 62);
  const dedupe = num(p, "dedupeWindowMin", 20);
  const ownership = num(p, "ownershipPct", 92);
  const sensitivity = Math.max(0, (100 - threshold) / 45);
  const pagesPerRule = 1.6 * sensitivity * sensitivity;
  const dedupeFactor = 1 - clamp(dedupe / 120, 0, 0.5);
  const volume = rules * pagesPerRule * dedupeFactor;
  const detectionPct = clamp(100 - Math.max(0, threshold - 50), 40, 100);
  const detected = (incidents * detectionPct) / 100;
  const actionable = Math.min(volume, detected);
  const noise = Math.max(0, volume - actionable);
  const missed = Math.max(0, incidents - actionable);
  const misrouted = detected * (1 - ownership / 100);
  const ackMin = 3 + volume * 0.35 + (100 - ownership) * 0.12;
  return {
    incidents,
    rules,
    threshold,
    dedupe,
    ownership,
    volume,
    detected,
    actionable,
    noise,
    missed,
    actionability: volume > 0 ? (actionable / volume) * 100 : 100,
    ackMin,
    misrouted,
    pagesPerShift: volume / SHIFTS_PER_WEEK,
    detectionPct,
  };
}

function volumeHealth(volume: number): "ok" | "warn" | "crit" {
  if (volume >= 35) return "crit";
  if (volume >= 20) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const load = volumeHealth(values.volume);
  const noiseHealth: "ok" | "warn" | "crit" =
    values.noise >= 30 ? "crit" : values.noise >= 15 ? "warn" : "ok";
  const ackHealth: "ok" | "warn" | "crit" =
    values.ackMin >= 25 ? "crit" : values.ackMin >= 10 ? "warn" : "ok";
  const missedHealth: "ok" | "warn" | "crit" =
    values.missed >= 3 ? "crit" : values.missed >= 1 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "incidents",
        label: "Real incidents",
        kind: "external",
        health: "ok",
        throughput: values.incidents,
        sublabel: `${values.incidents} per week`,
        meta: { view: "flow" },
      },
      {
        id: "rules",
        label: "Alert rules",
        kind: "service",
        health: load,
        utilization: clamp(values.volume / 50),
        throughput: values.volume,
        sublabel: `${values.rules} rules, ${values.volume.toFixed(0)} pages/week`,
        detail: `${values.volume.toFixed(1)} pages per week come from ${values.rules} rules. Only ${values.actionable.toFixed(1)} line up with a real incident.`,
        meta: { view: "flow" },
      },
      {
        id: "dedupe",
        label: "Dedupe and group",
        kind: "service",
        health: "ok",
        utilization: clamp(values.dedupe / 60),
        sublabel: `${values.dedupe} min window`,
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "Pager queue",
        kind: "worker",
        health: noiseHealth,
        utilization: clamp(values.noise / 50),
        sublabel: `${values.noise.toFixed(0)} noise pages/week`,
        detail: "A page queue is judged by how many entries need action, not by how quickly it is emptied.",
        meta: { view: "flow" },
      },
      {
        id: "oncall",
        label: "On-call engineer",
        kind: "client",
        health: ackHealth,
        sublabel: `${values.ackMin.toFixed(0)} min to acknowledge`,
        detail: `At this volume the responder takes ${values.ackMin.toFixed(0)} minutes to acknowledge and still has ${values.misrouted.toFixed(1)} misrouted incidents per week.`,
        meta: { view: "flow" },
      },
      {
        id: "backlog",
        label: "Missed incidents",
        kind: "storage",
        health: missedHealth,
        utilization: clamp(values.missed / 5),
        sublabel: `${values.missed.toFixed(1)} per week`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("incidents-rules", "incidents", "rules", 0.7, load),
      edge("rules-dedupe", "rules", "dedupe", 0.8, load),
      edge("dedupe-pager", "dedupe", "pager", 0.8, noiseHealth),
      edge("pager-oncall", "pager", "oncall", 0.9, ackHealth),
      edge("incidents-backlog", "incidents", "backlog", 0.3, missedHealth),
    ],
    metrics: [
      metric("page-volume", "Pages per week", values.volume, "", 20, 35, "count"),
      metric("actionable-pages", "Actionable pages", values.actionable, " / week", undefined, undefined, "count"),
      metric("noise-pages", "Noise pages", values.noise, " / week", 15, 30, "count"),
      metric("ack-latency", "Time to acknowledge", values.ackMin, " min", 10, 25, "number"),
      metric("missed-incidents", "Missed incidents", values.missed, " / week", 1, 3, "count"),
      metric("actionability", "Actionable share", values.actionability, "%", undefined, undefined, "percent"),
      metric("pages-per-shift", "Pages per shift", values.pagesPerShift, "", undefined, undefined, "number"),
      metric("misrouted", "Misrouted incidents", values.misrouted, " / week", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.volume.toFixed(0)} pages per week, ${values.actionability.toFixed(0)}% actionable, ${values.missed.toFixed(1)} incidents missed, ${values.ackMin.toFixed(0)} min to acknowledge.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const offset = seed % 9;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.92 + 0.16 * Math.sin((index + offset) / 2.6))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "noise-pages",
    metricId: "noise-pages",
    warn: 15,
    crit: 30,
    title: "Noise pages dominate the pager",
    cause:
      "Most pages do not correspond to an actionable incident. A noisy queue teaches the responder to skim, and the next real page competes with the habit of ignoring.",
    fix:
      "Delete or demote rules that never produce an action. Group duplicates, then re-measure actionable pages rather than total page count.",
    checkFirst: [
      "Count the last twenty pages that led to a change, rollback, or escalation.",
      "Find the rules that fire most often without a state change.",
      "Check whether a rule pages for a condition another team owns.",
    ],
  },
  {
    id: "page-volume",
    metricId: "page-volume",
    warn: 20,
    crit: 35,
    title: "Page volume exceeds what the shift can triage",
    cause:
      "The queue is large enough that acknowledgement becomes a batch process. Volume is not the only quality measure, but past this point the responder cannot investigate each page before the next arrives.",
    fix:
      "Rank rules by actionability, remove duplicates, and move diagnostic signals to a ticket queue. Keep a small set of pages tied to user impact.",
    checkFirst: [
      "Split volume by rule, service, and owning team.",
      "Compare page volume with the number of real incidents.",
      "Check the pages that arrive during handoff or outside working hours.",
    ],
  },
  {
    id: "ack-latency",
    metricId: "ack-latency",
    warn: 10,
    crit: 25,
    title: "Acknowledgement time is rising with queue load",
    cause:
      "The responder is spending time sorting and dismissing pages before reaching the one that matters. Misrouting adds a handoff, which adds more delay than the alert itself.",
    fix:
      "Reduce the number of paging rules, fix ownership metadata, and route each page directly to the team that can act. Measure time to acknowledge after the change.",
    checkFirst: [
      "Check whether pages are reaching the correct team on the first attempt.",
      "Look for pages that wait on a handoff or an escalation policy.",
      "Check whether the same object pages repeatedly during one shift.",
    ],
  },
  {
    id: "missed-incidents",
    metricId: "missed-incidents",
    warn: 1,
    crit: 3,
    title: "Incidents are being missed without an actionable page",
    cause:
      "Some real incidents never produce a page a responder can act on. The threshold may be too high to see them, or the page volume may be too low to cover the incident count. A quiet pager is not evidence of coverage.",
    fix:
      "Measure detection against a known incident list, not against page count. Restore coverage with a small number of symptom alerts and remove the rules that only add noise.",
    checkFirst: [
      "Compare the incident log with the pages that fired for the same window.",
      "Check whether a threshold increase suppressed a real signal.",
      "Check whether a rule was routed to a team that no longer owns the service.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const fatigueModel: SimModel = {
  id: "observability-alert-fatigue",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${values.rules} rules produce ${values.volume.toFixed(0)} pages per week, but only ${values.actionable.toFixed(1)} are tied to an incident.`,
      `${values.detectionPct.toFixed(0)}% of the ${values.incidents} real incidents are within the threshold's reach, but only ${values.actionable.toFixed(1)} actionable pages exist, so ${values.missed.toFixed(1)} are missed.`,
      `${values.noise.toFixed(0)} pages are noise and ${values.misrouted.toFixed(1)} incidents reach the wrong team; both add to the ${values.ackMin.toFixed(0)}-minute acknowledgement time.`,
      `The queue is ${values.pagesPerShift.toFixed(1)} pages per responder shift. A page that cannot be acted on is a tax on the next real page.`,
      values.actionability >= 60
        ? "Most pages carry an action. Reduce volume only where a rule has no owner or no decision."
        : "Most pages do not carry an action. Removing rules is safer than raising thresholds until the pager is quiet.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Load warning", tone: "warn" },
    { label: "Pager overload", tone: "crit" },
    { label: "Missed incident", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Ten owned rules, moderate volume, and 88% detection. Most pages lead to an action.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy week",
    description: "Thirty rules and eight incidents. Volume, acknowledgement time, and missed incidents all rise.",
    tone: "warn",
    params: defaults({ incidentsPerWeek: 8, rulesCount: 30, thresholdPct: 65, dedupeWindowMin: 5, ownershipPct: 70 }),
  },
  {
    id: "failure",
    label: "Rule sprawl",
    description: "Eighty rules and a higher threshold. Page volume rises about fourfold while detection falls.",
    tone: "crit",
    params: defaults({ incidentsPerWeek: 10, rulesCount: 80, thresholdPct: 75, dedupeWindowMin: 0, ownershipPct: 45 }),
  },
  {
    id: "quiet-miss",
    label: "Quiet but blind",
    description: "The threshold is raised until the pager is quiet. Volume falls, but detection falls with it.",
    tone: "warn",
    params: defaults({ incidentsPerWeek: 8, rulesCount: 20, thresholdPct: 92, dedupeWindowMin: 15, ownershipPct: 85 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Fewer rules, clear ownership, and a dedupe window. Volume falls without losing detection.",
    tone: "ok",
    params: defaults({ incidentsPerWeek: 6, rulesCount: 8, thresholdPct: 60, dedupeWindowMin: 25, ownershipPct: 95 }),
  },
];

const experiment: Experiment = {
  id: "predict-rule-sprawl",
  title: "Predict what twenty more rules do",
  simId: "fatigue",
  question:
    "The team adds twenty rules without changing the threshold. What happens to page volume, actionable pages, and incident detection?",
  prediction: {
    options: [
      { id: "volume-up", label: "Volume rises, actionable pages stay flat, detection stays flat" },
      { id: "detection-up", label: "Volume rises and detection rises with it" },
      { id: "volume-flat", label: "Volume stays flat because dedupe absorbs the new rules" },
      { id: "volume-down", label: "Volume falls because more rules share the incidents" },
    ],
    correctOptionId: "volume-up",
    explanation:
      "Detection in this model is set by the threshold, not by rule count. More rules add page volume and noise; they do not find incidents that the existing threshold cannot see. Actionable pages are capped by the real incidents, so the actionable share falls while detection stays flat.",
  },
  setup: defaults({ incidentsPerWeek: 6, rulesCount: 30, thresholdPct: 62, dedupeWindowMin: 20, ownershipPct: 92 }),
  runFor: 20,
  observe: [
    "Page volume rises sharply as rule count increases.",
    "Actionable pages stay near the number of detected incidents.",
    "The actionable share falls because the denominator grew.",
    "Detected incidents do not increase, so the extra rules bought noise rather than coverage.",
  ],
  explain:
    "Page volume is a supply measure; incidents are demand. A rule can only add a page, not create an incident. Detection depends on whether a signal is covered and whether its threshold is low enough to catch the failure. Adding rules without a coverage gap to close raises load and lowers the signal-to-noise ratio.",
  fix: defaults({ incidentsPerWeek: 6, rulesCount: 8, thresholdPct: 60, dedupeWindowMin: 25, ownershipPct: 95 }),
  debrief:
    "The fix cuts rules, adds deduplication, and fixes ownership. Volume falls, actionable pages remain close to the incident count, and detection stays high. The tradeoff is that removing a rule removes a possible early warning. The test is whether that rule ever produced an action; if it did not, it was consuming attention without buying coverage.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Alert fatigue is the loss of response that follows too many low-value pages. It is not a feeling about the pager. It is a measurable change in behavior: slower acknowledgement, more pages dismissed without investigation, and a real incident that sits in a queue because it looks like the last twenty.",
  },
  {
    type: "p",
    text: "The useful measures are pages per shift, the share of pages that lead to an action, the time to acknowledge, and the number of real incidents that were missed. Page count alone is a poor target. A team can cut volume by raising every threshold and become less reliable. A team can also add rules and look busy without detecting more incidents.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is signal sources, alert rules, deduplication and grouping, routing, and the on-call rotation. Rules decide what becomes a page. Dedupe decides how many copies arrive. Ownership decides whether the page reaches someone who can act. The rotation experiences the sum of those choices, so an alert audit has to look at all three.",
  },
  {
    type: "table",
    headers: ["Measure", "Question", "Failure if ignored"],
    rows: [
      ["Pages per shift", "Can one person triage this?", "Batch acknowledgement and skim-reading"],
      ["Actionable share", "Did the page lead to a change?", "Noise is treated as normal"],
      ["Time to acknowledge", "How long before a human engages?", "The real page waits behind the queue"],
      ["Missed incidents", "What did the pager not catch?", "Quiet is mistaken for healthy"],
      ["Correct ownership", "Did it reach the right team?", "Handoffs add delay and blame"],
    ],
  },
  {
    type: "p",
    text: "This is an illustrative queue model. It compresses a week into a static view so the tradeoffs are visible without waiting for a real rotation. The page counts and thresholds are teaching values, not a claim about a specific pager vendor or team size.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pages per week and pages per responder shift.",
      "Noise pages, actionable pages, and the actionable share.",
      "Time to acknowledge, which rises with volume and misrouting.",
      "Missed incidents, which can rise even when the pager looks quieter.",
      "A rule count and threshold control that make the volume-versus-detection tradeoff explicit.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Rule sprawl. Watch volume rise while detection falls. Compare that with Quiet but blind, where the pager is quieter but incidents are still missed. Then run the experiment, add twenty rules, and apply Recovery to see what an owned, deduplicated queue looks like.",
  },
  {
    type: "compare",
    leftTitle: "Optimize page count",
    rightTitle: "Optimize actionability",
    rows: [
      { label: "Goal", left: "Fewer pages", right: "More of the right pages" },
      { label: "Method", left: "Raise thresholds and disable rules", right: "Measure actions and coverage, then prune" },
      { label: "Risk", left: "Detection falls silently", right: "Requires incident review and ownership work" },
      { label: "Success signal", left: "A quiet pager", right: "Fewer pages and no missed incidents" },
    ],
  },
  { type: "sim", simId: "fatigue" },
  { type: "experiment", experimentId: "predict-rule-sprawl" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Rule sprawl added pages without adding detection. The queue grew, the actionable share fell, and the acknowledgement time rose. When the threshold was raised to quiet the pager, detection fell with the volume. Neither direction fixed the underlying problem: many rules had no owner and no action.",
  },
  {
    type: "p",
    text: "The recovery preset cut the rule count, added deduplication, and fixed ownership. Volume fell, but the actionable pages stayed close to the incident count. The lesson is that page load and detection have to be measured together. A quiet pager is not a success if incidents are being missed.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "PagerDuty or Opsgenie: pages per user per week, acknowledgement time, escalation rate, and the percentage of incidents resolved without a page.",
      "Prometheus and Alertmanager: rules without an `owner` label, rules that fire repeatedly with no state change, and routes that send to a catch-all team.",
      "Grafana: page volume against incident count, plus a table of the top rules by volume and by dismissal.",
      "Ticketing: alerts that were moved to a ticket and never reviewed. A silent backlog is a hidden coverage gap.",
      "Postmortems: incidents where the first page was late or absent. These are the counterweight to a volume-only target.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Pull the last twenty pages and mark which led to an action. Find the rules that fire most often with no state change. Check who owns each rule and whether the page reaches that team on the first attempt. Then compare the incident log with the pages for the same window.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory every paging rule with its owner, signal, and expected action.",
      "Measure pages per shift, actionable share, acknowledgement time, and missed incidents for two weeks.",
      "Delete or demote rules that never produce an action. Add deduplication for repeated object alerts.",
      "Fix ownership and routing so each page reaches the team that can change the system.",
      "Restore coverage with a small number of symptom alerts tied to user impact.",
      "Re-measure after the change. Keep the incident log as the check on a quieter pager.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Fewer rules reduce load but can remove an early warning that had not yet produced an action.",
      "Higher thresholds reduce noise and also reduce detection, often without a visible signal until an incident is missed.",
      "Deduplication hides duplicate pages, not a bad rule; the underlying signal still fires.",
      "Correct ownership reduces delay but requires maintained service metadata and team boundaries.",
      "A pager metric can be gamed. Pair it with incident review, or the team will optimize the number and lose coverage.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "measure-alert-quality",
    question:
      "How do you measure whether an alert set is good, beyond the number of pages per week?",
    difficulty: 2,
    hints: [
      "Start with what a page is supposed to cause.",
      "A quiet pager can be a coverage failure.",
    ],
    answer:
      "I measure whether pages lead to action, whether they reach the right owner, how long acknowledgement takes, and whether real incidents were missed. Page volume is an input, not the outcome. I would sample recent pages, mark each as actionable or not, and compare that list with the incident log for the same period. I would also look at repeat pages for the same object and at rules that have no owner. The target is fewer pages with the same or better detection, not a quiet pager.",
    followUps: [
      "What counts as an action?",
      "How would you measure missed incidents?",
      "Which metric would you show the team every week?",
    ],
    redFlags: [
      "Optimizes only page count.",
      "Assumes every page is valuable.",
      "Has no incident log to compare against.",
    ],
    rubric: [
      "Names actionability and detection.",
      "Uses the incident log.",
      "Includes ownership and acknowledgement.",
      "Rejects volume as the only target.",
    ],
  },
  {
    id: "prune-rules",
    question:
      "You have 60 paging rules and 60 pages a week. How do you decide which rules to remove?",
    difficulty: 3,
    hints: [
      "Rank by action and coverage, not by how loud the rule is.",
      "Some rules should become tickets, not disappear.",
    ],
    answer:
      "I would build a table of every rule with its owner, the signal it watches, the last time it fired, and the action it produced. Rules that never produced an action and have no user-impact path are candidates to delete. Rules that carry useful diagnosis move to a ticket or dashboard. Rules that cover a real incident but page too often get grouped or get a better condition. I would keep a small set of symptom pages and verify after pruning that the known incident list is still covered. The tradeoff is that a rare early warning may be lost; the decision should be recorded so it can be revisited.",
    followUps: [
      "How do you handle a rule owned by another team?",
      "What if a rule has never fired but covers a severe failure?",
      "How do you test coverage after pruning?",
    ],
    redFlags: [
      "Deletes by volume alone.",
      "Removes all cause signals.",
      "Does not verify detection after pruning.",
    ],
    rubric: [
      "Uses action and coverage.",
      "Separates delete from demote.",
      "Assigns ownership.",
      "Tests detection after the change.",
    ],
  },
  {
    id: "quiet-pager",
    question:
      "The pager is finally quiet, but a customer reports an outage that no alert caught. What went wrong?",
    difficulty: 3,
    hints: [
      "The alert set may have optimized volume instead of coverage.",
      "The missing signal might be outside the SLI or the threshold.",
    ],
    answer:
      "The team optimized the supply of pages without checking demand. Raising thresholds or deleting rules reduced volume, but it also removed coverage for a path that was not represented in the incident history. I would check whether the failure was visible in any signal, whether the SLI included that user journey, and whether a rule existed but was routed elsewhere. Then I would add a symptom alert for the missing journey and re-measure detection against a broader incident list. A quiet pager is only good if the incident log agrees.",
    followUps: [
      "How do you find other unmeasured journeys?",
      "What is the role of synthetic probes?",
      "How do you avoid overcorrecting with too many new rules?",
    ],
    redFlags: [
      "Adds many rules at once.",
      "Blames the customer for an unusual path.",
      "Treats the quiet pager as proof of health.",
    ],
    rubric: [
      "Connects quiet pager to coverage loss.",
      "Checks the SLI and routing.",
      "Adds a targeted symptom.",
      "Re-measures detection.",
    ],
  },
  {
    id: "ownership",
    question:
      "Why does ownership matter for alert fatigue, and what happens when a rule has no owner?",
    difficulty: 2,
    hints: [
      "An unowned page still has to be triaged by someone.",
      "Handoffs and guessing add delay.",
    ],
    answer:
      "An alert without an owner becomes everyone's problem, which usually means the on-call engineer who received it by default. That person may not have the context or the permission to fix the cause, so the page turns into a handoff, a ticket, or a dismissal. Repeated dismissals teach the rotation that pages are not actionable. Ownership makes the expected action explicit and gives the team a reason to prune the rule when it no longer matches the system.",
    followUps: [
      "How do you assign ownership for a shared dependency?",
      "What if the owner team no longer exists?",
      "How do you keep metadata current?",
    ],
    redFlags: [
      "Sends everything to one on-call team.",
      "Treats ownership as a label without an action.",
      "Ignores stale service metadata.",
    ],
    rubric: [
      "Connects ownership to action.",
      "Names the handoff cost.",
      "Keeps metadata maintained.",
      "Uses ownership to prune rules.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every paging rule has an owner, a signal, and an expected action.",
      "Pages per shift, actionable share, acknowledgement time, and missed incidents are reported together.",
      "Deduplication groups repeated alerts by object and service.",
      "Rules that only provide diagnosis are routed to tickets or dashboards.",
      "The rotation has a documented escalation path for a page that reaches the wrong team.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Acknowledge the real page and record the others as noise candidates.",
      "Do not raise thresholds during the incident to clear the queue.",
      "Route misrouted pages to the correct owner without losing the signal.",
      "Record which pages led to a decision and which were dismissed.",
      "Check the incident log for failures that produced no page.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Review the page list against the incident list for the same window.",
      "Delete or demote rules that produced no action.",
      "Fix ownership and routing metadata while the incident is fresh.",
      "Re-measure volume and detection after the next full week.",
    ],
  },
];

const references = [
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Actionable paging, symptom-based alerting, and page load.",
  },
  {
    title: "Incident Response Documentation",
    url: "https://response.pagerduty.com/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "On-call roles, escalation, and incident response practice.",
  },
  {
    title: "Alerting practices",
    url: "https://prometheus.io/docs/practices/alerting/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Alert rule structure and keeping pages actionable.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    fatigue: {
      model: fatigueModel,
      presets,
      instructions:
        "Start Healthy, then apply Rule sprawl and compare page volume with missed incidents. Apply Quiet but blind, then run the experiment and apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Page counts are weekly teaching values; they are not a vendor limit or a staffing formula.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "observability-symptom-alerting",
    "observability-slo-burn-rate",
    "reliability-paging-fatigue",
    "observability-anomaly-detection",
  ],
};
