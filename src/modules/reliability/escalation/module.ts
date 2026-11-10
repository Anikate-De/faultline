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
    id: "timeTrigger",
    label: "Time-based escalation trigger",
    min: 5,
    max: 60,
    step: 5,
    value: 15,
    unit: " min",
    group: "Triggers",
    help: "Minutes on the incident before the path automatically calls the next level, even without a clear diagnosis.",
    format: "number",
  },
  {
    id: "impactTrigger",
    label: "Impact-based trigger coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Triggers",
    help: "Share of high-impact conditions that shorten the escalation trigger. Full coverage pages backup early; lower coverage blends toward the time trigger.",
    format: "percent",
  },
  {
    id: "authority",
    label: "Explicit authority to escalate",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Authority",
    help: "Share of the response where the on-call has explicit permission to call backup without asking a manager.",
    format: "percent",
  },
  {
    id: "backupDepth",
    label: "Named backup tiers",
    min: 1,
    max: 4,
    step: 1,
    value: 2,
    unit: "",
    group: "Path",
    help: "Number of named escalation levels with a clear owner. More tiers can reach the right expertise but add handoffs.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface EscState {
  stuck: number;
  lastDelay: number;
}

const INITIAL: EscState = { stuck: 0, lastDelay: 0 };

function readState(frame: SimFrame): EscState {
  return {
    stuck: Math.max(0, Number(frame.flags.escStuck ?? 0)),
    lastDelay: Math.max(0, Number(frame.flags.escLastDelay ?? 0)),
  };
}

interface Values {
  timeTrigger: number;
  impactTrigger: number;
  authority: number;
  depth: number;
  impactOn: boolean;
  effectiveTrigger: number;
  gap: number;
  waiting: number;
  backupEngaged: boolean;
  timeToBackup: number;
  resolution: number;
  delayCost: number;
}

function compute(p: Params, state: EscState): Values {
  const timeTrigger = clamp(num(p, "timeTrigger", 15), 5, 60);
  const impactTrigger = clamp(num(p, "impactTrigger", 100), 0, 100);
  const authority = clamp(num(p, "authority", 100), 0, 100);
  const depth = clamp(Math.round(num(p, "backupDepth", 2)), 1, 4);
  const impactOn = impactTrigger > 0;
  const impactDelay = 3 + (1 - impactTrigger / 100) * Math.max(0, timeTrigger - 3);
  const baseTrigger = impactOn ? impactDelay : timeTrigger;
  const effectiveTrigger = baseTrigger + (1 - authority / 100) * 20;
  const coverage = clamp(impactTrigger * 0.4 + authority * 0.4 + (depth / 4) * 20, 0, 100);
  const gap = clamp(100 - coverage, 0, 100);
  const backupEngaged = state.lastDelay > 0;
  const timeToBackup = backupEngaged ? state.lastDelay : state.stuck;
  const resolution = 18 + timeToBackup * 0.3 + gap * 0.35 + (4 - depth) * 2.5;
  const delayCost = Math.max(0, timeToBackup - 3) * 1.4 + gap * 0.15;
  return {
    timeTrigger,
    impactTrigger,
    authority,
    depth,
    impactOn,
    effectiveTrigger,
    gap,
    waiting: state.stuck,
    backupEngaged,
    timeToBackup,
    resolution: clamp(resolution, 0, 180),
    delayCost: clamp(delayCost, 0, 180),
  };
}

function advance(state: EscState, p: Params, dt: number): EscState {
  const values = compute(p, state);
  const step = Math.max(0, dt);
  let stuck = state.stuck + step;
  let lastDelay = state.lastDelay;
  if (stuck >= values.effectiveTrigger) {
    lastDelay = stuck;
    stuck = 0;
  }
  if (values.gap < 25 && values.effectiveTrigger <= 5) {
    lastDelay = Math.max(0, lastDelay - 2 * step);
  }
  return { stuck, lastDelay };
}

function buildFrame(p: Params, state: EscState, seed: number): SimFrame {
  const values = compute(p, state);
  const timeHealth: "ok" | "warn" | "crit" =
    values.timeToBackup >= 25 ? "crit" : values.timeToBackup >= 10 ? "warn" : "ok";
  const gapHealth: "ok" | "warn" | "crit" =
    values.gap >= 50 ? "crit" : values.gap >= 25 ? "warn" : "ok";
  const backupHealth: "ok" | "warn" | "crit" = values.backupEngaged
    ? values.timeToBackup >= 10
      ? "warn"
      : "ok"
    : values.waiting >= 10
      ? "crit"
      : "ok";
  const authorityHealth: "ok" | "warn" | "crit" =
    values.authority < 50 ? "crit" : values.authority < 80 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "oncall",
        label: "On-call engineer",
        kind: "worker",
        health: timeHealth,
        utilization: clamp(0.3 + values.timeToBackup / 60),
        sublabel: values.backupEngaged
          ? `latest backup at ${values.timeToBackup.toFixed(0)} min`
          : `${values.waiting.toFixed(0)} min without backup`,
        detail: "The on-call owns the first response. Escalation is not a failure of that ownership; it is part of it.",
        meta: { view: "flow" },
      },
      {
        id: "runbook",
        label: "Runbook and context",
        kind: "storage",
        health: gapHealth,
        utilization: clamp(0.2 + values.gap / 140),
        sublabel: values.gap >= 25 ? "guidance thin" : "handoff ready",
        detail: "The escalation path should carry context: impact, actions tried, evidence, and the specific question for the next level.",
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "Paging policy",
        kind: "service",
        health: gapHealth,
        utilization: clamp(0.25 + values.gap / 130),
        sublabel: values.impactOn
          ? values.impactTrigger >= 100
            ? "impact trigger active"
            : "partial impact trigger"
          : "waiting on time",
        detail: `The paging policy escalates automatically after ${values.effectiveTrigger.toFixed(0)} minutes in this model. Impact-based coverage is ${values.impactTrigger.toFixed(0)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "backup",
        label: "Backup on-call",
        kind: "worker",
        health: backupHealth,
        utilization: clamp(0.2 + values.timeToBackup / 80),
        sublabel: values.backupEngaged
          ? values.timeToBackup >= 10
            ? "engaged late"
            : "engaged"
          : values.waiting >= 10
            ? "not engaged"
            : "reachable",
        detail: "The backup is a named person with the authority and context to help. A path that ends in a group alias is not an escalation path.",
        meta: { view: "flow" },
      },
      {
        id: "commander",
        label: "Incident commander",
        kind: "service",
        health: authorityHealth,
        utilization: clamp(0.25 + (1 - values.authority / 100) * 0.6),
        sublabel: values.authority >= 80 ? "authority explicit" : "permission unclear",
        detail: "Explicit authority removes the social cost of asking. The on-call should not need a manager's permission to call for help.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("oncall-runbook", "oncall", "runbook", 1 - values.gap / 100, gapHealth),
      edge("runbook-pager", "runbook", "pager", 1 - values.gap / 100, gapHealth),
      edge("pager-backup", "pager", "backup", 1 - values.gap / 100, timeHealth),
      edge("backup-commander", "backup", "commander", values.authority / 100, authorityHealth),
    ],
    metrics: [
      metric("escalation-gap", "Escalation coverage gap", values.gap, "%", 25, 50, "percent"),
      metric("time-to-backup", "Time to backup", values.timeToBackup, " min", 10, 25, "number"),
      metric("resolution-time", "Projected resolution", values.resolution, " min", 30, 60, "number"),
      metric("delay-cost", "Delay cost", values.delayCost, " min", 15, 35, "number"),
    ],
    events: [
      {
        id: "esc-incident-declared",
        at: 0,
        severity: "info",
        title: "Incident declared",
        detail: `The on-call owns the first response. The effective escalation trigger is ${values.effectiveTrigger.toFixed(0)} minutes and there are ${values.depth} named backup tier(s).`,
      },
    ],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      escStuck: state.stuck,
      escLastDelay: state.lastDelay,
    },
    summary: `${values.gap.toFixed(0)}% escalation gap, ${values.timeToBackup.toFixed(0)} min to backup, projected resolution ${values.resolution.toFixed(0)} min.`,
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
    id: "escalation-gap",
    metricId: "escalation-gap",
    warn: 25,
    crit: 50,
    title: "The escalation path is missing a trigger, authority, or named backup",
    cause:
      "Escalation depends on the on-call deciding to ask, knowing whom to call, and believing they are allowed to call. Any missing piece turns help into a judgment call under stress.",
    fix:
      "Add a time-based trigger, an impact-based trigger, explicit authority, and a named backup. The on-call should be able to escalate by following the path, not by negotiating for permission.",
    checkFirst: [
      "Check whether the paging policy escalates automatically after a fixed time.",
      "Check whether a high-impact condition pages backup immediately.",
      "Check whether the on-call has explicit authority to escalate.",
    ],
  },
  {
    id: "time-to-backup",
    metricId: "time-to-backup",
    warn: 10,
    crit: 25,
    title: "Time to backup exceeds the escalation budget",
    cause:
      "The on-call is waiting for certainty, for permission, or for the time trigger. The incident keeps consuming the first responder while help sits one page away.",
    fix:
      "Shorten the time trigger, add an impact trigger, and make the backup a named person. If the on-call is stuck, the path should call help before the on-call is certain.",
    checkFirst: [
      "Check the time between detection and the first backup page.",
      "Check whether the on-call was waiting for a diagnosis or for permission.",
      "Check whether the backup acknowledged and joined.",
    ],
  },
  {
    id: "resolution-time",
    metricId: "resolution-time",
    warn: 30,
    crit: 60,
    title: "Escalation delay is extending the resolution",
    cause:
      "The first responder is the only one working the problem, and the people with the missing context are not engaged. The technical path is blocked on a conversation that never happened.",
    fix:
      "Escalate on time or impact, hand over the context, and give the backup a specific question. More people is not the goal; the right context at the right time is.",
    checkFirst: [
      "Check whether the critical path is waiting on a decision or on missing expertise.",
      "Check whether the backup has the context to act.",
      "Check whether the escalation path reaches the person with the needed authority.",
    ],
  },
  {
    id: "delay-cost",
    metricId: "delay-cost",
    warn: 15,
    crit: 35,
    title: "The delay is now a material part of the incident",
    cause:
      "Every minute without backup adds to the incident duration and to the customer impact. The cost is not only the page; it is the work that could not start.",
    fix:
      "Treat the delayed escalation as an incident action: page backup now, state the question, and record what was tried. Review the trigger after recovery.",
    checkFirst: [
      "Compare the incident start with the first backup page.",
      "Check what work waited for the backup.",
      "Check whether the delay came from the trigger, the path, or the on-call's judgment.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const escalationModel: SimModel = {
  id: "reliability-escalation",
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
    if (!values.impactOn && values.timeTrigger > 30 && frame.flags.escTriggerEvent !== 1) {
      pushEvent(next, {
        id: "esc-no-impact-trigger",
        at: frame.t,
        severity: "warn",
        title: "No impact-based escalation trigger",
        detail: `A high-impact condition waits for the ${values.timeTrigger}-minute time trigger. Impact-based coverage is ${values.impactTrigger.toFixed(0)}%.`,
        nodeId: "pager",
        metricId: "escalation-gap",
      });
      next.flags.escTriggerEvent = 1;
    }
    if (values.authority < 50 && frame.flags.escAuthorityEvent !== 1) {
      pushEvent(next, {
        id: "esc-authority-gap",
        at: frame.t,
        severity: "crit",
        title: "The on-call lacks explicit authority to escalate",
        detail: "Asking for permission adds delay at the moment the on-call is least certain. Authority should be part of the role, not a separate negotiation.",
        nodeId: "commander",
        metricId: "escalation-gap",
      });
      next.flags.escAuthorityEvent = 1;
    }
    if (!values.backupEngaged && values.waiting >= 10 && frame.flags.escBackupEvent !== 1) {
      pushEvent(next, {
        id: "esc-backup-late",
        at: frame.t,
        severity: "warn",
        title: "Backup is not engaged",
        detail: `The on-call has been working ${values.waiting.toFixed(0)} minutes without backup. The path should have called help by now.`,
        nodeId: "backup",
        metricId: "time-to-backup",
      });
      next.flags.escBackupEvent = 1;
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
      `Escalation coverage gap is ${values.gap.toFixed(0)}%. The effective trigger is ${values.effectiveTrigger.toFixed(0)} minutes; the configured time trigger is ${values.timeTrigger} minutes.`,
      `Time to backup is ${values.timeToBackup.toFixed(0)} minutes. Impact-based coverage is ${values.impactTrigger.toFixed(0)}% and explicit authority is ${values.authority.toFixed(0)}%.`,
      `The path has ${values.depth} named backup tier(s). Projected resolution is ${values.resolution.toFixed(0)} minutes, with ${values.delayCost.toFixed(0)} minutes of delay cost.`,
      `Escalation is not a failure of the on-call. A path that requires certainty or permission converts a normal request for help into a late decision.`,
    ];
  },
  legend: [
    { label: "Path ready", tone: "ok" },
    { label: "Slow trigger", tone: "warn" },
    { label: "Backup late", tone: "crit" },
    { label: "No authority", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 15-minute time trigger, full impact coverage, explicit authority, and two named backup tiers.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Impact coverage is partial and authority is unclear enough to add a few minutes.",
    tone: "warn",
    params: defaults({ timeTrigger: 30, impactTrigger: 50, authority: 80, backupDepth: 2 }),
  },
  {
    id: "failure",
    label: "Stuck on-call",
    description: "No impact trigger, weak authority, one backup tier, and a 45-minute time trigger. The on-call works alone.",
    tone: "crit",
    params: defaults({ timeTrigger: 45, impactTrigger: 0, authority: 20, backupDepth: 1 }),
  },
  {
    id: "no-authority",
    label: "No authority",
    description: "The triggers exist, but the on-call believes escalation needs approval. The path waits on a conversation.",
    tone: "crit",
    params: defaults({ timeTrigger: 10, impactTrigger: 100, authority: 0, backupDepth: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A short time trigger, full impact coverage, explicit authority, and a deeper named path.",
    tone: "ok",
    params: defaults({ timeTrigger: 10, impactTrigger: 100, authority: 100, backupDepth: 3 }),
  },
];

const experiment: Experiment = {
  id: "predict-escalation-delay",
  title: "Predict what shortens time to backup",
  simId: "escalation",
  question:
    "The on-call engineer has been stuck for 30 minutes and has not called backup. Which change reduces time to backup most reliably?",
  prediction: {
    options: [
      { id: "trigger-authority", label: "A pre-agreed time trigger plus explicit authority to escalate" },
      { id: "wait", label: "Wait for the on-call to ask when they are ready" },
      { id: "dashboards", label: "Add more dashboards so the on-call can diagnose faster" },
      { id: "volume", label: "Page the on-call more often until they respond" },
    ],
    correctOptionId: "trigger-authority",
    explanation:
      "The delay is not only a knowledge problem. It is a decision problem: the on-call must recognize that they are stuck, decide that asking is allowed, and know whom to call. A time trigger removes the recognition delay; explicit authority removes the permission delay; a named backup removes the search delay.",
  },
  setup: defaults({ timeTrigger: 45, impactTrigger: 0, authority: 20, backupDepth: 1 }),
  runFor: 45,
  observe: [
    "The escalation coverage gap is critical from the first minute.",
    "Time to backup climbs past its warning threshold while the on-call is still working alone.",
    "Projected resolution and delay cost rise with the time without backup.",
    "No impact-based trigger fires because coverage is zero; the path waits for the long time trigger.",
  ],
  explain:
    "Escalation paths and triggers remove the social cost of asking. A time-based trigger makes help automatic after a fixed interval. An impact-based trigger calls help early when the customer impact is high. Authority makes the call legitimate without a manager's approval, and a named backup gives the on-call a person rather than a queue. The triggers work together: impact catches the severe case early, time catches the ambiguous case before it consumes the on-call.",
  fix: defaults({ timeTrigger: 10, impactTrigger: 100, authority: 100, backupDepth: 3 }),
  debrief:
    "With a short time trigger, full impact coverage, and explicit authority, backup engages early and the projected resolution falls. The tradeoff is more pages and more handoffs, including some that turn out not to need a second person. That cost is visible and bounded; the cost of a late escalation is hidden until the incident is already long.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Escalation is the planned process for bringing additional help, authority, or expertise into an incident. It is not an admission that the on-call failed. It is a normal part of owning the response, in the same way that a runbook step or a diagnostic query is. The question is not whether the on-call is good enough. The question is whether the path makes help arrive at the right time.",
  },
  {
    type: "p",
    text: "Two kinds of triggers matter. A time-based trigger escalates after a fixed interval, even when the diagnosis is unclear. An impact-based trigger escalates on a condition such as high-severity customer impact or a safety issue, without waiting for the full time trigger. The time trigger catches the ambiguous incident that quietly consumes the on-call. The impact trigger catches the severe incident earlier. Used together, they cover both uncertainty and severity.",
  },
  {
    type: "p",
    text: "Authority and path are the other half. Explicit authority means the on-call does not need a manager's permission to call backup. A named path means the next level is a person or a small group with a clear owner, not an alias that everyone assumes someone else monitors. The handoff should carry context: current impact, actions tried, evidence, the specific question, and what the next person is expected to do.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Escalation sits after severity and before the incident is fully staffed. Severity decides how wide the response should be; escalation is the mechanism that actually brings those people in. A severe incident with no escalation path is still under-responded. A well-staffed incident with no trigger still depends on one person noticing that they are stuck.",
  },
  {
    type: "table",
    headers: ["Trigger", "Best for", "Failure when missing"],
    rows: [
      ["Time-based", "Ambiguous incidents and slow diagnoses", "The on-call works alone until the incident is already long"],
      ["Impact-based", "High-severity customer or safety impact", "The response waits for a clock despite obvious impact"],
      ["Explicit authority", "Removing the social cost of asking", "The on-call waits for permission that was never required"],
      ["Named backup path", "Reaching a person with context", "The page lands in an alias and no one joins"],
    ],
  },
  {
    type: "p",
    text: "The timings in this module are illustrative. Many paging tools support multi-level escalation policies with timeouts, but the specific intervals and levels are organizational choices. The model compresses one incident minute into one simulated second.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Escalation coverage gap: missing impact trigger, authority, or named backup depth.",
      "Time to backup: minutes the on-call works before the next level is engaged.",
      "Projected resolution: the technical path plus the delay from missing help.",
      "Delay cost: the part of the incident duration attributable to the late escalation.",
      "A flow view from the on-call through the runbook, paging policy, backup, and commander.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Stuck on-call. Watch the coverage gap before time to backup. Apply No authority to isolate the permission problem, then Recovery to see the combined fix. Run the experiment before reading the debrief.",
  },
  {
    type: "compare",
    leftTitle: "Ask when ready",
    rightTitle: "Triggered escalation",
    rows: [
      { label: "Decision", left: "On-call must recognize they are stuck", right: "Path acts after a fixed interval or impact signal" },
      { label: "Permission", left: "On-call hopes asking is acceptable", right: "Authority is explicit in the role" },
      { label: "Path", left: "Search for a person or page an alias", right: "Named backup with a defined handoff" },
      { label: "Failure mode", left: "Help arrives after the incident has grown", right: "Extra pages and handoffs that may not be needed" },
    ],
  },
  { type: "sim", simId: "escalation" },
  { type: "experiment", experimentId: "predict-escalation-delay" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The on-call was capable and still did not call backup. The path had no impact trigger, weak authority, one backup tier, and a long time trigger. The on-call kept working because asking required a judgment about being stuck, a belief that asking was allowed, and a search for the right person. Each of those is a delay that has nothing to do with technical skill.",
  },
  {
    type: "p",
    text: "Adding a short time trigger and full impact coverage made help automatic. Explicit authority removed the permission question, and a deeper named path gave the on-call a person to call. Time to backup fell, and the projected resolution fell with it. The model shows the delay cost separately because it is easy to attribute the whole incident to the technical cause.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Paging tool: no automatic escalation after the first acknowledgement, or a policy that ends at the on-call.",
      "Incident channel: the on-call is asking questions that a backup or specialist could answer, but no one has been paged.",
      "Runbook: the escalation section says 'ask for help if needed' without a time, a person, or a trigger.",
      "Leadership: learns about the incident late because the on-call was waiting to have a clearer picture.",
      "Postmortem: the timeline shows a long gap between detection and the first additional responder.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the time between detection and the first backup page. Check whether the path has a time trigger, an impact trigger, and a named next level. Ask the on-call whether they believed they needed permission. Then check whether the backup who was paged actually had the context to help.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Add a time-based trigger that escalates after a fixed interval, independent of diagnosis.",
      "Add an impact-based trigger for high-severity customer, safety, or data conditions.",
      "State explicit authority: the on-call can escalate without asking a manager.",
      "Name each backup level and the person or small group that owns it.",
      "Give the handoff a template: impact, actions tried, evidence, specific question, next update.",
      "After recovery, measure the gap between detection and the first backup page and adjust the trigger.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A short time trigger pages backup earlier, including some incidents that would have resolved without help.",
      "An impact trigger catches severe incidents quickly but needs a reliable impact signal and a clear threshold.",
      "A deep escalation path reaches the right expertise but adds handoffs and coordination cost.",
      "Explicit authority can increase pages; the alternative is an on-call who waits for permission while the incident grows.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stuck-oncall",
    question:
      "The on-call engineer has been stuck for 30 minutes and has not called backup. What do you change?",
    difficulty: 2,
    hints: [
      "The delay is a decision problem as much as a knowledge problem.",
      "Remove the need to recognize, decide, and search.",
    ],
    answer:
      "I would change the path, not blame the on-call. Add a time-based trigger that escalates after a fixed interval, add an impact-based trigger for high-severity conditions, state that the on-call has explicit authority to escalate without approval, and name the backup. I would also give the handoff a template so the backup arrives with context. The on-call should be able to follow the path rather than negotiate it under stress.",
    followUps: [
      "What interval would you start with?",
      "How do you avoid escalating every ambiguous incident?",
      "What context should the handoff carry?",
    ],
    redFlags: [
      "Tells the on-call to ask sooner.",
      "Adds more dashboards.",
      "Waits for the postmortem to change the path.",
    ],
    rubric: [
      "Adds a time or impact trigger.",
      "Makes authority explicit.",
      "Names the backup.",
      "Defines the handoff context.",
    ],
  },
  {
    id: "time-versus-impact",
    question:
      "When would you use a time-based escalation trigger, and when would you use an impact-based one?",
    difficulty: 3,
    hints: [
      "Time covers uncertainty; impact covers severity.",
      "The two triggers complement each other.",
    ],
    answer:
      "A time-based trigger is for the ambiguous incident where the on-call may not realize how long they have been stuck. It guarantees that help arrives after a fixed interval even without a clear diagnosis. An impact-based trigger is for a known high-severity condition, such as a broad customer outage or a safety issue; it pages backup immediately instead of waiting for the clock. I would use both: impact catches the severe case early, time catches the slow case before it consumes the on-call.",
    followUps: [
      "Which trigger should fire first for a SEV1?",
      "How do you set the time interval?",
      "What if the impact signal is noisy?",
    ],
    redFlags: [
      "Uses only one trigger for every incident.",
      "Sets the time trigger so long it never fires.",
      "Waits for a diagnosis before escalating on impact.",
    ],
    rubric: [
      "Explains the purpose of each trigger.",
      "Combines them.",
      "Ties the interval to impact and uncertainty.",
      "Accounts for noisy signals.",
    ],
  },
  {
    id: "social-cost",
    question:
      "How do you remove the social cost of asking for help during an incident?",
    difficulty: 2,
    hints: [
      "Make escalation a normal step, not a judgment.",
      "Authority and triggers do the asking.",
    ],
    answer:
      "I make escalation part of the role: explicit authority, a time trigger, and an impact trigger that page backup without the on-call having to decide whether they are worthy of help. I also have leaders say plainly that escalating is expected and that a false alarm is cheaper than a late one. The handoff should be short and structured so asking does not feel like writing a report. The goal is to make the path do the work that currently depends on the on-call's confidence.",
    followUps: [
      "What do you say when someone escalates unnecessarily?",
      "How do you measure whether the social cost fell?",
      "Who models the behavior?",
    ],
    redFlags: [
      "Says 'just ask' without changing the path.",
      "Punishes false escalations.",
      "Makes the handoff long and formal.",
    ],
    rubric: [
      "Makes escalation explicit and expected.",
      "Uses triggers and authority.",
      "Keeps the handoff light.",
      "Measures the behavior.",
    ],
  },
  {
    id: "escalation-handoff",
    question: "What makes an escalation handoff useful to the person receiving it?",
    difficulty: 3,
    hints: [
      "The receiver needs a question, not a transcript.",
      "Context should let them act without replaying the channel.",
    ],
    answer:
      "A useful handoff states the current impact, what has been tried, the evidence that matters, the specific question or decision the next person is being asked to handle, and the next update time. It also names the current owner and what they will keep doing while the backup works. The receiver should be able to act without reading the entire channel. The handoff is not a status report; it is a transfer of a specific responsibility.",
    followUps: [
      "How do you keep the handoff short during a fast incident?",
      "What if the receiver needs more context?",
      "Who owns the update during the handoff?",
    ],
    redFlags: [
      "Pastes the whole channel.",
      "Has no specific question.",
      "Leaves ownership ambiguous.",
    ],
    rubric: [
      "States impact and evidence.",
      "Names a specific question.",
      "Transfers ownership.",
      "Preserves the update cadence.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The paging policy has a time-based escalation step after the first level.",
      "High-impact conditions have an impact-based escalation path.",
      "The on-call role includes explicit authority to escalate.",
      "Every escalation level names a person or a small owned group.",
      "The handoff template covers impact, actions, evidence, question, and next update.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Escalate when the time or impact trigger fires, not only when the on-call feels ready.",
      "State the specific question for the next level.",
      "Keep the current owner and the backup owner explicit during the handoff.",
      "Record the time of the first backup page and the acknowledgement.",
      "Re-evaluate whether the path reached the right expertise, not just another person.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Measure detection to first backup page and first acknowledgement.",
      "Review escalations that were late, unnecessary, or sent to an alias.",
      "Check whether authority or social pressure delayed the call.",
      "Adjust the trigger interval and the named path for the next exercise.",
    ],
  },
];

const references = [
  {
    title: "Escalation Policies",
    url: "https://support.pagerduty.com/docs/escalation-policies",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Time-based escalation levels, targets, and repeat behavior in a paging policy.",
  },
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "On-call load, escalation, and the operational cost of interrupting responders.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident roles, command, and coordination during an active response.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    escalation: {
      model: escalationModel,
      presets,
      instructions:
        "Start Healthy, apply Stuck on-call, and compare the coverage gap with time to backup. Apply No authority to isolate the permission problem, then Recovery to see the combined fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; trigger intervals and path depth are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["reliability-severity-levels", "reliability-incident-command", "reliability-roles"],
};
