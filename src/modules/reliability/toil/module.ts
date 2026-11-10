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

const WEEKS_PER_SECOND = 0.2;

const params: ParamSpec[] = [
  {
    id: "manualShare",
    label: "On-call work that is manual",
    min: 0,
    max: 100,
    step: 5,
    value: 30,
    unit: "%",
    group: "Task mix",
    help: "Share of on-call hours spent on repetitive, manual tasks that scale with service size and have no lasting value after completion.",
    format: "percent",
  },
  {
    id: "automationCapacity",
    label: "Automation capacity",
    min: 0,
    max: 40,
    step: 2,
    value: 20,
    unit: " h/wk",
    group: "Investment",
    help: "Engineering hours per week available to automate recurring work. Capacity that is not protected is consumed by the queue.",
    format: "number",
  },
  {
    id: "toilGrowth",
    label: "New manual work",
    min: 0,
    max: 40,
    step: 2,
    value: 8,
    unit: "%/mo",
    group: "Task mix",
    help: "Rate at which new manual procedures appear as the service and team change. Automation that only keeps up does not reduce the share.",
    format: "percent",
  },
  {
    id: "preventionAllocation",
    label: "Time protected for prevention",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Investment",
    help: "Share of engineering time protected from interrupts for fixes that remove failure conditions rather than repeat cleanup.",
    format: "percent",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  week: number;
  toilHours: number;
  capacityDeficit: number;
  recurringTasks: number;
  backlogWeeks: number;
  automationCoverage: number;
  manual: number;
  automation: number;
  growth: number;
  prevention: number;
}

function compute(p: Params, t: number): Values {
  const manual = clamp(num(p, "manualShare", 30), 0, 100);
  const automation = clamp(num(p, "automationCapacity", 20), 0, 40);
  const growth = clamp(num(p, "toilGrowth", 8), 0, 40);
  const prevention = clamp(num(p, "preventionAllocation", 40), 0, 100);
  const week = Math.max(0, t) * WEEKS_PER_SECOND;
  const toilHours = clamp(
    manual * 0.4 * (1 + (growth / 100) * week * 0.5) - automation * 0.15 * week,
    0,
    45,
  );
  const preventionAvailable = 40 * (prevention / 100);
  const capacityDeficit = clamp(
    10 + Math.max(0, toilHours - 18) * 0.6 - Math.max(0, preventionAvailable - Math.max(0, toilHours - 20) * 0.5),
    0,
    40,
  );
  const recurringTasks = clamp(
    manual * 0.08 * (1 + (growth / 100) * week * 0.5) - automation * 0.02 * week,
    0,
    20,
  );
  const backlogWeeks = clamp((recurringTasks * 1.5) / Math.max(1, automation), 0, 20);
  const automationCoverage = clamp((automation / Math.max(1, manual * 0.4)) * 100, 0, 100);
  return {
    week,
    toilHours,
    capacityDeficit,
    recurringTasks,
    backlogWeeks,
    automationCoverage,
    manual,
    automation,
    growth,
    prevention,
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  return {
    t,
    nodes: [
      {
        id: "pager",
        label: "On-call shift",
        kind: "service",
        health: healthOf(v.toilHours, 18, 28),
        utilization: clamp(v.toilHours / 45),
        sublabel: `${v.toilHours.toFixed(1)} h/week manual`,
        detail: "The shift has a fixed number of hours. Every hour spent on repeat cleanup is unavailable for investigation, prevention, or rest.",
        meta: { view: "flow" },
      },
      {
        id: "cleanup",
        label: "Manual cleanup",
        kind: "worker",
        health: healthOf(v.toilHours, 18, 28),
        utilization: clamp(v.toilHours / 40),
        sublabel: `${v.recurringTasks.toFixed(1)} recurring task(s)/wk`,
        detail: "Restarting stuck jobs, clearing disk pressure, rotating credentials, requeueing messages, and rebuilding the same state after each incident.",
        meta: { view: "flow" },
      },
      {
        id: "automation",
        label: "Automation pipeline",
        kind: "worker",
        health: healthOf(v.backlogWeeks, 2, 4),
        utilization: clamp(v.backlogWeeks / 12),
        sublabel: `${v.automationCoverage.toFixed(0)}% covered`,
        detail: "Scripts, operators, and controllers that perform the repeatable step. Coverage falls behind when new manual work arrives faster than automation ships.",
        meta: { view: "flow" },
      },
      {
        id: "prevention",
        label: "Prevention work",
        kind: "worker",
        health: healthOf(v.capacityDeficit, 4, 8),
        utilization: clamp(v.capacityDeficit / 40),
        sublabel: `${v.capacityDeficit.toFixed(1)} h/week short`,
        detail: "Fixes that remove the failure condition: better defaults, bounded retries, capacity headroom, and deletion of the manual step. It is the first work to disappear when cleanup expands.",
        meta: { view: "flow" },
      },
      {
        id: "backlog",
        label: "Automation backlog",
        kind: "storage",
        health: healthOf(v.backlogWeeks, 2, 4),
        utilization: clamp(v.backlogWeeks / 12),
        sublabel: `${v.backlogWeeks.toFixed(1)} week(s) of work`,
        detail: "A backlog measured in weeks of automation capacity, not ticket count. A long backlog means the same manual work will be repeated many times before it is removed.",
        meta: { view: "flow" },
      },
      {
        id: "capacity",
        label: "Team capacity",
        kind: "service",
        health: healthOf(v.capacityDeficit, 4, 8),
        utilization: clamp(0.3 + v.capacityDeficit / 50),
        sublabel: v.capacityDeficit >= 8 ? "prevention starved" : "capacity protected",
        detail: "The team can absorb a bounded amount of interrupt work. Beyond that, prevention and improvement stop, and the next incident is larger.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("pager-cleanup", "pager", "cleanup", clamp(v.toilHours / 45), healthOf(v.toilHours, 18, 28)),
      edge("cleanup-automation", "cleanup", "automation", clamp(1 - v.backlogWeeks / 14), healthOf(v.backlogWeeks, 2, 4)),
      edge("automation-backlog", "automation", "backlog", clamp(v.backlogWeeks / 10), healthOf(v.backlogWeeks, 2, 4)),
      edge("automation-prevention", "automation", "prevention", clamp(v.automationCoverage / 100), "ok"),
      edge("prevention-capacity", "prevention", "capacity", clamp(1 - v.capacityDeficit / 30), healthOf(v.capacityDeficit, 4, 8)),
    ],
    metrics: [
      metric("toil-hours", "Manual toil", v.toilHours, " h/wk", 18, 28, "number"),
      metric("capacity-deficit", "Prevention capacity deficit", v.capacityDeficit, " h/wk", 4, 8, "number"),
      metric("recurring-tasks", "Recurring manual tasks", v.recurringTasks, "/wk", 4, 8, "count"),
      metric("backlog-weeks", "Automation backlog", v.backlogWeeks, " wk", 2, 4, "number"),
      metric("automation-coverage", "Automation coverage", v.automationCoverage, "%", undefined, undefined, "percent"),
    ],
    events: [
      {
        id: "toil-shift-start",
        at: 0,
        severity: "info",
        title: "On-call week begins",
        detail: `${v.manual.toFixed(0)}% of on-call work is manual, with ${v.automation.toFixed(0)} h/week of automation capacity and ${v.prevention.toFixed(0)}% of engineering time protected for prevention.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${v.toilHours.toFixed(1)} h/week of manual toil; prevention deficit ${v.capacityDeficit.toFixed(1)} h/week; automation backlog ${v.backlogWeeks.toFixed(1)} weeks.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 9;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.975 + 0.05 * Math.sin((index + phase) / 3.7))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "toil-hours",
    metricId: "toil-hours",
    warn: 18,
    crit: 28,
    title: "Manual cleanup is consuming the on-call shift",
    cause:
      "The same repetitive tasks absorb a large share of the weekly shift. The work scales with service size and incident count, so adding traffic or customers adds hours without adding reliability.",
    fix:
      "Rank manual tasks by frequency, time per run, and error risk. Automate the top task completely, including the verification and rollback path, then measure whether the hours actually fell.",
    checkFirst: [
      "List the tasks repeated more than once per shift.",
      "Measure time per run and how often the run needs a correction.",
      "Check whether the automation removes the task or only hides it behind another queue.",
    ],
  },
  {
    id: "capacity-deficit",
    metricId: "capacity-deficit",
    warn: 4,
    crit: 8,
    title: "Cleanup is consuming the capacity needed for prevention",
    cause:
      "Interrupt work expands to fill the available engineering time. Prevention work has no immediate deadline, so it is deferred first, and the conditions that create cleanup remain in place.",
    fix:
      "Protect a fixed share of engineering time for prevention, cap interrupt work, and treat the automation backlog as planned work with an owner. Measure completed prevention, not hours spent.",
    checkFirst: [
      "Compare planned prevention hours with hours actually delivered.",
      "Check which prevention item was deferred in the last two weeks.",
      "Check whether the same cleanup task returned after being automated.",
    ],
  },
  {
    id: "recurring-tasks",
    metricId: "recurring-tasks",
    warn: 4,
    crit: 8,
    title: "The number of recurring manual tasks is growing",
    cause:
      "New procedures are added without removing the old ones. Each new service, environment, or compliance step adds a manual runbook that no one owns, and automation coverage falls behind the task mix.",
    fix:
      "Track the recurring task inventory as a product backlog. Remove, combine, or automate each item; refuse new manual steps without an owner and a removal date.",
    checkFirst: [
      "Compare this month's task list with last month's.",
      "Check which tasks exist only because of a missing default.",
      "Check whether new services added a manual step to an existing runbook.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const toilModel: SimModel = {
  id: "reliability-toil",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, frame.t, seed);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.events = frame.events.slice(-60);
    const v = compute(p, frame.t);
    if (v.capacityDeficit >= 8 && frame.flags.toilDeficit !== 1) {
      pushEvent(next, {
        id: "toil-prevention-starved",
        at: frame.t,
        severity: "crit",
        title: "Prevention capacity is exhausted by repeat cleanup",
        detail: "The team is spending the week restoring the same state. No time remains to remove the condition, so the next week starts with the same queue.",
        nodeId: "capacity",
        metricId: "capacity-deficit",
      });
      next.flags.toilDeficit = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `Manual toil is ${v.toilHours.toFixed(1)} hours per week with a prevention deficit of ${v.capacityDeficit.toFixed(1)} hours per week.`,
      `${v.recurringTasks.toFixed(1)} recurring tasks arrive each week; the automation backlog is ${v.backlogWeeks.toFixed(1)} weeks of capacity.`,
      `Automation coverage is ${v.automationCoverage.toFixed(0)}%. Coverage can fall even when automation output is constant if new manual work grows.`,
      "Automate the highest frequency multiplied by time multiplied by error risk first. Automating the most annoying task is not a strategy.",
    ];
  },
  legend: [
    { label: "Capacity protected", tone: "ok" },
    { label: "Toil rising", tone: "warn" },
    { label: "Prevention starved", tone: "crit" },
    { label: "Backlog unmanaged", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A third of on-call is manual, automation capacity is protected, and prevention time is held.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Keeping up",
    description: "Half of on-call is manual and automation only offsets part of the new work. Prevention slips.",
    tone: "warn",
    params: defaults({ manualShare: 50, automationCapacity: 8, toilGrowth: 20, preventionAllocation: 20 }),
  },
  {
    id: "failure",
    label: "Cleanup loop",
    description: "Most on-call work is manual, automation is starved, and new procedures keep arriving.",
    tone: "crit",
    params: defaults({ manualShare: 80, automationCapacity: 2, toilGrowth: 30, preventionAllocation: 5 }),
    elapsed: 10,
  },
  {
    id: "recovery",
    label: "Automation first",
    description: "Most manual work is removed, automation capacity is high, and prevention time is protected.",
    tone: "ok",
    params: defaults({ manualShare: 15, automationCapacity: 35, toilGrowth: 2, preventionAllocation: 70 }),
  },
];

const experiment: Experiment = {
  id: "predict-toil-first",
  title: "Predict which manual task to automate first",
  simId: "toil",
  question:
    "The on-call list has five recurring tasks: a nightly restart, a weekly certificate check, a noisy dashboard review, a quarterly access audit, and a disk cleanup that runs twice per shift. Which one first?",
  prediction: {
    options: [
      {
        id: "ranked",
        label: "The disk cleanup: highest frequency, meaningful time per run, and a manual step with error risk",
      },
      { id: "annoying", label: "The task the team complains about most" },
      { id: "audit", label: "The quarterly access audit because it carries the most compliance risk" },
      { id: "dashboard", label: "The dashboard review because it is visible to leadership" },
    ],
    correctOptionId: "ranked",
    explanation:
      "Automation value is frequency multiplied by time per run multiplied by the cost of a mistake, divided by the effort to automate. The twice-per-shift cleanup scores highest and removes hours every week. Compliance risk matters, but a quarterly task returns little capacity. Visibility and annoyance are not measures of toil.",
  },
  setup: defaults({ manualShare: 75, automationCapacity: 4, toilGrowth: 25, preventionAllocation: 10 }),
  runFor: 40,
  observe: [
    "Manual toil is critical before the first automation ships.",
    "The prevention deficit grows while the backlog waits for capacity.",
    "Recurring tasks keep arriving, so partial automation does not reduce the share.",
    "The team has no protected time to remove the next task.",
  ],
  explain:
    "Toil reduction is a capacity argument, not a tooling argument. The team must first see where the hours go, then remove the highest-value task completely, then protect the time that was recovered so it goes to prevention rather than more cleanup. Automating a low-frequency task produces a visible artifact and no capacity.",
  fix: defaults({ manualShare: 15, automationCapacity: 35, toilGrowth: 2, preventionAllocation: 70 }),
  debrief:
    "Automating the cleanup removes several hours per week immediately. Protecting that time for prevention is what keeps it from being refilled by new manual work. The tradeoff is upfront engineering: automation needs an owner, a verification path, and a plan for the cases the manual step handled implicitly. Automating only the happy path can create a new manual recovery task.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Toil is work that is manual, repetitive, automatable, tactical, and has no lasting value after it is done. Restarting a stuck worker, clearing disk pressure, rotating a credential by hand, and rebuilding a queue after every deploy are toil. Investigating a novel failure is not. Writing the automation that removes the restart is not.",
  },
  {
    type: "p",
    text: "The definition has edges. A task can be manual and valuable, such as a careful database failover during an incident. A task can be repetitive and still require judgment, such as reviewing a risky change. Toil is the subset that scales with service size, follows a procedure, and could be performed by a machine with the same or better reliability. The label matters because it determines whether the fix is automation, a better default, or more people.",
  },
  {
    type: "p",
    text: "Toil is a capacity problem before it is a tooling problem. Every hour spent on repeat cleanup is an hour not spent removing the condition that creates it. When the team is fully consumed, prevention is deferred, the condition remains, and the next incident adds more cleanup. The loop is stable until it is not.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Toil shows up in on-call handoff, incident response, and the weekly operations review. The handoff reveals which tasks recur across shifts. Incident response reveals which manual steps appear under pressure. The operations review is where the task inventory becomes planned work with an owner and a removal date.",
  },
  {
    type: "table",
    headers: ["Work", "Example", "Correct response"],
    rows: [
      ["Toil", "Restart the same stuck worker twice per shift", "Automate the restart and remove the cause"],
      ["Necessary operations", "A planned database failover with verification", "Keep the runbook, improve the tooling"],
      ["Project work", "Build the queue rebalancer", "Plan and staff it like a product"],
      ["Interrupt", "A novel customer-specific failure", "Investigate, then look for a class of failure"],
    ],
  },
  {
    type: "p",
    text: "This module models twelve on-call weeks. Manual share, automation capacity, new manual work, and protected prevention time are illustrative teaching values. The 50% ceiling on operational work discussed in Google SRE guidance is a useful reference, not a universal target.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Manual toil: hours per week spent on repetitive cleanup.",
      "Prevention capacity deficit: prevention hours the team cannot fund.",
      "Recurring manual tasks: the inventory that automation must remove.",
      "Automation backlog: weeks of capacity needed to cover the current task mix.",
      "Automation coverage: the share of recurring work handled without a manual step.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Cleanup loop. Watch manual toil and the prevention deficit move together. Run the experiment before reading the debrief, then automate the top task and protect the recovered time. The values are illustrative; the loop is the lesson.",
  },
  {
    type: "compare",
    leftTitle: "Task-based response",
    rightTitle: "Capacity-based response",
    rows: [
      { label: "Question", left: "Which task is most annoying?", right: "Which task costs the most capacity per week?" },
      { label: "Measure", left: "Ticket count and anecdotes", right: "Frequency, time, error risk, and effort" },
      { label: "Fix", left: "Automate the visible task", right: "Remove the highest-value task completely" },
      { label: "After", left: "Recovered time refills with cleanup", right: "Recovered time is protected for prevention" },
    ],
  },
  { type: "sim", simId: "toil" },
  { type: "experiment", experimentId: "predict-toil-first" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The shift started with a third of on-call work already manual. Within a few weeks the new procedures and the same cleanup pushed that share higher. Automation capacity was too small to keep up, and the hours protected for prevention were consumed by the queue. The team stayed busy and the backlog grew.",
  },
  {
    type: "p",
    text: "The recovery run ranked the recurring tasks by cost and automated the highest one completely. The hours recovered were protected for prevention instead of being refilled by cleanup. Coverage rose because the task inventory stopped growing faster than automation could remove it.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "On-call handoff: the same five cleanup steps described every week with different names.",
      "Runbooks: procedures that say \"restart the worker\" with no check for why it stalled.",
      "Backlog: automation tickets that are always below incident work and never scheduled.",
      "Prevention: the same failure condition documented in three postmortems with no shipped fix.",
      "Team: experienced engineers leave because the shift is mostly maintenance.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "List every task repeated more than once per shift. For each, record frequency, time per run, error risk, and the effort to automate. The top of that list is the next automation, not the loudest complaint.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the task inventory for two weeks: frequency, time, error risk, and who performs it.",
      "Rank by weekly cost and automate the top task end to end, including verification and rollback.",
      "Remove the manual procedure or mark it as a fallback; do not leave both paths active.",
      "Protect the recovered hours for prevention with a named owner and a planned deliverable.",
      "Track new manual work as it appears and require an owner and removal date for each new step.",
      "Review automation coverage quarterly; output without coverage means the task mix is growing.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Automation has an upfront cost and can hide a failure instead of removing it. Automate the verification and the rollback too.",
      "Protecting prevention time reduces short-term interrupt capacity. That is the point; unowned prevention never happens.",
      "Not all manual work should be automated. A rare, high-judgment task may be safer with a checklist and a second person.",
      "Measuring toil takes time. A two-week sample with frequency and duration is enough to rank the top tasks; a perfect taxonomy is not.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "what-is-toil",
    question: "What makes work toil, and what does not?",
    difficulty: 1,
    hints: [
      "Repetitive, manual, automatable, and scaling with the service.",
      "Judgment and lasting value change the answer.",
    ],
    answer:
      "Toil is manual, repetitive, automatable, tactical work that scales with the service and leaves no lasting value after it is done. A novel investigation is not toil because the path is unknown. A planned failover with judgment is not toil even if it is manual, because the judgment is the value. Writing the automation is project work. The classification matters because it tells you whether to automate, improve the default, or staff the work.",
    followUps: [
      "Is writing a runbook toil?",
      "Is a manual code review toil?",
      "How do you handle a task that is 80% repetitive and 20% judgment?",
    ],
    redFlags: [
      "Calls all operational work toil.",
      "Calls all manual work toil.",
      "Uses toil to mean burnout.",
    ],
    rubric: [
      "Lists the defining properties.",
      "Gives a counterexample.",
      "Links the label to a response.",
      "Separates toil from project work.",
    ],
  },
  {
    id: "measure-toil",
    question: "How would you measure toil in a team that has never tracked it?",
    difficulty: 2,
    hints: [
      "Start with a short sample, not a taxonomy.",
      "Frequency and time per run rank the work.",
    ],
    answer:
      "Run a two-week sample and ask each on-call engineer to log recurring tasks with frequency, duration, and whether the run needed a correction. Add the error risk and the effort to automate. That produces a ranked list by weekly cost. Then compare the list across shifts to remove duplicates and confirm which tasks scale with traffic. The goal is a decision about the top three tasks, not a perfect accounting of every minute.",
    followUps: [
      "How do you account for interrupted work?",
      "What if engineers do not log accurately?",
      "How often should the sample be repeated?",
    ],
    redFlags: [
      "Starts with a large taxonomy.",
      "Uses ticket counts alone.",
      "Measures only after an incident.",
    ],
    rubric: [
      "Uses a bounded sample.",
      "Includes frequency and duration.",
      "Includes error risk.",
      "Produces a ranked action.",
    ],
  },
  {
    id: "protect-time",
    question:
      "You automate a task and recover six hours per week. How do you keep those hours from being consumed by new cleanup?",
    difficulty: 3,
    hints: [
      "Recovered time is not automatically prevention time.",
      "Make the allocation visible and owned.",
    ],
    answer:
      "Give the recovered time a named owner and a planned prevention deliverable, and track delivered prevention rather than hours spent. Add the new manual work inventory to the same review so the team can see whether the task mix is growing. If a new manual step appears, require an owner and a removal date. Without an explicit allocation, the queue expands to fill the capacity and the automation becomes invisible.",
    followUps: [
      "Who decides which prevention work gets the time?",
      "What if incident load spikes?",
      "How do you show the benefit to leadership?",
    ],
    redFlags: [
      "Assumes the team will use the time well.",
      "Measures hours instead of delivered work.",
      "Lets new manual steps appear without review.",
    ],
    rubric: [
      "Names an owner and deliverable.",
      "Tracks outcomes.",
      "Controls new manual work.",
      "Acknowledges interrupt pressure.",
    ],
  },
];

const checklist = [
  {
    title: "Measure",
    items: [
      "Sample recurring tasks for two weeks with frequency, duration, and error risk.",
      "Separate toil from necessary operations and project work.",
      "Rank tasks by weekly cost and effort to automate.",
      "Compare the task list across shifts to remove duplicates.",
    ],
  },
  {
    title: "Reduce",
    items: [
      "Automate the highest-cost task end to end, including verification and rollback.",
      "Remove the manual procedure or mark it as an explicit fallback.",
      "Protect the recovered hours for prevention with an owner and a deliverable.",
      "Require an owner and removal date for every new manual step.",
    ],
  },
  {
    title: "Sustain",
    items: [
      "Review automation coverage and the recurring task inventory quarterly.",
      "Check that automation output is reducing hours, not adding another queue.",
      "Keep the toil share visible in the operations review.",
      "Revisit the ranking when traffic, architecture, or the team changes.",
    ],
  },
];

const references = [
  {
    title: "Eliminating Toil",
    url: "https://sre.google/sre-book/eliminating-toil/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Definition of toil, the 50% operational-work ceiling, and automation as a capacity investment.",
  },
  {
    title: "On-Call",
    url: "https://sre.google/workbook/on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "On-call load, operational work, and balancing interrupts with project work.",
  },
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Shift load, pager fatigue, and the conditions for sustainable on-call.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    toil: {
      model: toilModel,
      presets,
      instructions:
        "Start Healthy, then apply Cleanup loop. Watch toil hours and the prevention deficit. Run the experiment, then automate the top task and protect the recovered time.",
      experimentIds: [experiment.id],
      note: "Illustrative model. One simulated second represents one working day; task rates and capacity values are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-oncall-handoff",
    "reliability-paging-fatigue",
    "reliability-action-items",
    "reliability-postmortem-actions",
  ],
};
