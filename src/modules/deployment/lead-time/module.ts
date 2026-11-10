import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "codingHours",
    label: "Coding time",
    min: 0.5,
    max: 40,
    step: 0.5,
    value: 2,
    unit: "h",
    group: "Work",
    help: "Active engineering time to write and review the change before it enters the delivery pipeline.",
    format: "number",
  },
  {
    id: "pipelineMinutes",
    label: "Pipeline duration",
    min: 5,
    max: 180,
    step: 5,
    value: 20,
    unit: "min",
    group: "Pipeline",
    help: "Total wall-clock time for tests, builds, and deployment steps after the change is submitted.",
    format: "number",
  },
  {
    id: "approvalWaitHours",
    label: "Approval wait",
    min: 0,
    max: 120,
    step: 1,
    value: 2,
    unit: "h",
    group: "Queue",
    help: "Time a change waits for review, change approval, or a deployment window after it is ready.",
    format: "number",
  },
  {
    id: "reworkRounds",
    label: "Rework rounds",
    min: 0,
    max: 5,
    step: 1,
    value: 0,
    unit: " rounds",
    group: "Queue",
    help: "How many times the change returns for fixes and re-review. Each round adds a four-hour illustrative queue.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  coding: number;
  pipeline: number;
  approval: number;
  rework: number;
  queueHours: number;
  leadHours: number;
  queueShare: number;
}

function compute(p: Params): Values {
  const coding = Math.max(0, num(p, "codingHours", 2));
  const pipeline = Math.max(1, num(p, "pipelineMinutes", 20));
  const approval = Math.max(0, num(p, "approvalWaitHours", 2));
  const rework = Math.max(0, Math.round(num(p, "reworkRounds", 0)));

  const queueHours = approval + rework * 4;
  const leadHours = coding + pipeline / 60 + queueHours;
  const queueShare = leadHours > 0 ? (queueHours / leadHours) * 100 : 0;

  return { coding, pipeline, approval, rework, queueHours, leadHours, queueShare };
}

function highHealth(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(...healths: Health[]): Health {
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

function percent(value: number): string {
  return `${value.toFixed(value < 10 ? 1 : 0)}%`;
}

function buildFrame(p: Params, seed: number, values: Values): SimFrame {
  const leadHealth = highHealth(values.leadHours, 24, 72);
  const approvalHealth = highHealth(values.approval, 12, 48);
  const queueHealth = highHealth(values.queueShare, 70, 95);

  const stageNodes = [
    {
      id: "commit",
      label: "Change submitted",
      kind: "client" as const,
      health: "ok" as Health,
      utilization: 0.2,
      sublabel: `${values.coding.toFixed(1)}h coding`,
      detail: "The change is written and reviewed. Coding time is usually a small part of total lead time.",
      meta: { stage: "stable", view: "deployment" },
    },
    {
      id: "queue",
      label: "Approval queue",
      kind: "service" as const,
      health: worst(approvalHealth, queueHealth),
      utilization: clamp(values.queueShare / 100),
      sublabel: `${values.queueHours.toFixed(1)}h waiting · ${percent(values.queueShare)} of lead time`,
      detail: `The change waits ${values.queueHours.toFixed(1)} hours for approval, a window, or rework. Queue time is ${percent(values.queueShare)} of the total.`,
      meta: { stage: "canary", view: "deployment" },
    },
    {
      id: "production",
      label: "Production",
      kind: "service" as const,
      health: leadHealth,
      utilization: clamp(values.leadHours / 120),
      sublabel: `${values.leadHours.toFixed(1)}h total lead time`,
      detail: `From submission to production takes ${values.leadHours.toFixed(1)} hours. The pipeline contributes ${(values.pipeline / 60).toFixed(2)} hours.`,
      meta: { stage: "full", view: "deployment" },
    },
  ];

  const flowNodes = [
    { id: "dev", label: "Commit", kind: "worker" as const, health: "ok" as Health, meta: { view: "flow" } },
    {
      id: "ci",
      label: "Pipeline",
      kind: "worker" as const,
      health: highHealth(values.pipeline, 45, 120),
      sublabel: `${values.pipeline.toFixed(0)} min`,
      meta: { view: "flow" },
    },
    {
      id: "approval",
      label: "Approval",
      kind: "service" as const,
      health: approvalHealth,
      sublabel: `${values.approval.toFixed(1)}h wait`,
      meta: { view: "flow" },
    },
    {
      id: "prod",
      label: "Production",
      kind: "service" as const,
      health: leadHealth,
      sublabel: `${values.leadHours.toFixed(1)}h lead time`,
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes: [...stageNodes, ...flowNodes],
    edges: [
      edge("dev-ci", "dev", "ci", clamp(values.pipeline / 180), highHealth(values.pipeline, 45, 120)),
      edge("ci-approval", "ci", "approval", clamp(values.queueShare / 100), approvalHealth),
      edge("approval-prod", "approval", "prod", clamp(values.leadHours / 120), leadHealth),
    ],
    metrics: [
      metric("lead-time", "Lead time for changes", values.leadHours, "h", 24, 72, "number"),
      metric("approval-wait", "Approval wait", values.approval, "h", 12, 48, "number"),
      metric("queue-share", "Queue share of lead time", values.queueShare, "%", 70, 95, "percent"),
      metric("pipeline-duration", "Pipeline duration", values.pipeline, "min", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), leadHours: values.leadHours },
    summary: `${values.leadHours.toFixed(1)}h lead time · ${percent(values.queueShare)} queue · ${values.pipeline.toFixed(0)} min pipeline`,
  };
}

function seedSeries(frame: SimFrame, values: Values, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 4)) / 2.1);
  for (const [id, value] of [
    ["lead-time", values.leadHours],
    ["approval-wait", values.approval],
    ["queue-share", values.queueShare],
    ["pipeline-duration", values.pipeline],
  ] as [string, number][]) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => Math.max(0, value * jitter(index)));
  }
  frame.flags.seriesSeeded = 1;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "lead-time",
    metricId: "lead-time",
    warn: 24,
    crit: 72,
    title: "Lead time is too long for the change rate",
    cause: "The change spends most of its life waiting: approval, rework, or a deployment window. Coding and pipeline time are usually smaller than the queue, but teams often optimize the parts they can see.",
    fix: "Measure time in each stage, find the largest queue, and reduce it. Shorten approval latency, batch approvals less, or remove rework by fixing the review input. Treat the constraint, not the average.",
    checkFirst: [
      "Break lead time into coding, pipeline, approval, and rework.",
      "Check how long the change waited at each stage.",
      "Check whether a queue appears at a specific approver or window.",
    ],
  },
  {
    id: "approval-wait",
    metricId: "approval-wait",
    warn: 12,
    crit: 48,
    title: "Approval is the constraint",
    cause: "A small number of approvers, a fixed change window, or a manual review step holds changes after they are ready. The work is done, but the queue dominates lead time.",
    fix: "Reduce approval latency: add approvers, define risk-based auto-approval, or move the review earlier. Keep the safety decision, remove the waiting.",
    checkFirst: [
      "Measure the time from ready-for-review to approval.",
      "Check approver availability and time zones.",
      "Check whether the change waits for a window after approval.",
    ],
  },
  {
    id: "queue-share",
    metricId: "queue-share",
    warn: 70,
    crit: 95,
    title: "Most of the lead time is queue, not work",
    cause: "The change is waiting far longer than it is being written or tested. Shortening the pipeline or asking engineers to code faster will not move the total much.",
    fix: "Optimize the queue that dominates. If approval is the constraint, fix approval; if rework is the constraint, fix the input quality or the review criteria.",
    checkFirst: [
      "Compare queue hours with coding and pipeline hours.",
      "Check whether waits are concentrated at one stage.",
      "Check whether the queue changes with the day or the release calendar.",
    ],
  },
];

export const leadTimeModel: SimModel = {
  id: "deployment-lead-time",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(p, seed, values);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const key = JSON.stringify(p);
    const resetSeries = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const next = buildFrame(p, seed, values);
    next.t = frame.t;
    next.series = resetSeries
      ? {}
      : Object.fromEntries(Object.entries(frame.series).map(([seriesKey, value]) => [seriesKey, [...value]]));
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (resetSeries) seedSeries(next, values, seed);
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `Lead time is ${values.leadHours.toFixed(1)} hours: ${values.coding.toFixed(1)} coding, ${(values.pipeline / 60).toFixed(2)} pipeline, and ${values.queueHours.toFixed(1)} waiting.`,
    );
    items.push(
      `The queue is ${percent(values.queueShare)} of lead time. If this is high, optimizing the pipeline or coding speed barely moves the total.`,
    );
    items.push(
      `Approval wait is ${values.approval.toFixed(1)} hours and rework adds ${(values.rework * 4).toFixed(0)} hours.`,
    );
    items.push(
      "Optimize the constraint. A faster test suite does not help when the change is waiting for an approver.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Queue building", tone: "warn" },
    { label: "Stalled", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Two hours of coding, a twenty-minute pipeline, and a two-hour approval wait.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Daily approval",
    description: "A one-day approval wait pushes lead time past a day while the pipeline stays fast.",
    tone: "warn",
    params: defaults({ codingHours: 2, pipelineMinutes: 30, approvalWaitHours: 24, reworkRounds: 0 }),
  },
  {
    id: "failure",
    label: "Two-week queue",
    description: "Eighty hours of approval and one rework round dominate a small code change.",
    tone: "crit",
    params: defaults({ codingHours: 2, pipelineMinutes: 20, approvalWaitHours: 80, reworkRounds: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Fast approval, a short pipeline, and no rework.",
    tone: "ok",
    params: defaults({ codingHours: 2, pipelineMinutes: 10, approvalWaitHours: 1, reworkRounds: 0 }),
  },
  {
    id: "approval-queue",
    label: "Approval queue",
    description: "A one-hour change waits three days for approval and a deployment window.",
    tone: "crit",
    params: defaults({ codingHours: 1, pipelineMinutes: 15, approvalWaitHours: 72, reworkRounds: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-lead-time",
  title: "Predict where a two-week lead time goes",
  simId: "lead-time",
  question:
    "A one-line fix takes two weeks to reach production. The pipeline takes twenty minutes. Where should you look first?",
  prediction: {
    options: [
      { id: "queue", label: "The approval and deployment queue" },
      { id: "coding", label: "The engineer's coding speed" },
      { id: "tests", label: "The twenty-minute test suite" },
      { id: "deploy", label: "The production deploy command" },
    ],
    correctOptionId: "queue",
    explanation:
      "If the pipeline is twenty minutes and the change takes two weeks, the time is waiting, not working. Approval, rework, and deployment windows are the likely constraint. Optimizing coding or tests cannot recover two weeks that were spent in a queue.",
  },
  setup: defaults({ codingHours: 1, pipelineMinutes: 15, approvalWaitHours: 72, reworkRounds: 1 }),
  runFor: 30,
  observe: [
    "Lead time is 77.25 hours: one hour of coding and three days of approval plus rework.",
    "The queue is 98.4% of lead time.",
    "The pipeline contributes only 15 minutes to the total.",
    "Approval wait alone is above the critical threshold.",
  ],
  explain:
    "Lead time is dominated by the largest queue. A twenty-minute pipeline is irrelevant when approval takes days. The useful measure is time in each stage, and the useful action is the one that shortens the constraint.",
  fix: defaults({ codingHours: 2, pipelineMinutes: 10, approvalWaitHours: 1, reworkRounds: 0 }),
  debrief:
    "The fixed state has a 3.2-hour lead time and a 32% queue share. The pipeline was already fast; the change was in approval latency and rework. The tradeoff is that faster approval may reduce the depth of review, so the team should replace waiting with earlier, risk-based review rather than remove the review.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Lead time for changes is the elapsed time from a change being committed or requested to it running in production. It includes coding, review, waiting for approval, test duration, deployment, and any rework. It is not the same as engineering effort: a one-line change can have a two-week lead time if it waits thirteen days for approval.",
  },
  {
    type: "p",
    text: "Lead time is usually dominated by queues. Work spends time waiting for a person, a window, a test slot, or another team. The average can hide this: a fast path and a slow approval path average into a number that looks acceptable while most changes are stuck. The useful analysis breaks the total into stages and finds the largest wait.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The pipeline measures time from commit to production. Change approval, review, and deployment windows are part of the path even when they live outside the CI system. Test duration and rework loops sit inside it. A dashboard that shows only pipeline duration will miss the constraint if most of the delay happens before the pipeline starts.",
  },
  {
    type: "p",
    text: "The hours and queue values in this model are illustrative. The structural rule is that total lead time is the sum of work and waiting, and the largest term is the one worth changing. Optimizing a small term feels productive but rarely moves the total.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Lead time in hours, split into coding, pipeline, approval, and rework.",
      "Approval wait: the queue outside the pipeline.",
      "Queue share: how much of the total is waiting rather than work.",
      "Pipeline duration: often smaller than teams expect.",
      "A deployment view from commit to approval to production.",
    ],
  },
  {
    type: "table",
    headers: ["Stage", "Typical question", "Lever"],
    rows: [
      ["Coding", "Is the work understood?", "Smaller scope, clearer requirements"],
      ["Pipeline", "Are tests slow or flaky?", "Parallelism, caching, fewer stages"],
      ["Approval", "Who is available and what are they deciding?", "Risk-based review, more approvers"],
      ["Rework", "Why did it come back?", "Better input, clearer criteria"],
      ["Deploy window", "Why can it only ship on Tuesday?", "Continuous deployment with a gate"],
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read the stage split. Apply Daily approval to see lead time rise while the pipeline stays fast. Apply Two-week queue to see approval dominate. Apply Recovery, then run the experiment and its fix.",
  },
  { type: "sim", simId: "lead-time" },
  { type: "experiment", experimentId: "predict-lead-time" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, a two-hour code change took 86.3 hours to reach production. Approval was 80 hours, one rework round added four, and the pipeline contributed twenty minutes. The queue was 97.3% of lead time. The engineers were not slow; the change was waiting.",
  },
  {
    type: "p",
    text: "The approval-queue preset isolates the same constraint: a one-hour change with a three-day approval wait. Lead time crossed the critical threshold even though coding and tests were fast. The constraint was a queue outside the pipeline.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Changes that are code-complete but wait days for review or a deployment window.",
      "A pipeline that is fast when it runs, but starts late.",
      "Rework loops caused by unclear review criteria or missing context.",
      "Lead-time averages that hide a long tail of stalled changes.",
      "A deploy calendar with few, fixed windows.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Break lead time into stages and find the largest queue. Check time from ready-for-review to approval, rework counts, and deployment-window waits. Compare queue time with coding and pipeline time before optimizing the pipeline.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Instrument time in each stage, not only pipeline duration.",
      "Identify the largest queue and its owner.",
      "Reduce approval latency with risk-based review and more available approvers.",
      "Reduce rework with clearer criteria and earlier review.",
      "Remove fixed deployment windows where a gate can provide the same safety.",
      "Re-measure after the change to confirm the constraint moved.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Faster approval reduces lead time but may reduce review depth.",
      "A shorter pipeline can skip checks that catch defects later.",
      "Removing deployment windows improves flow but requires a trustworthy gate and rollback.",
      "Optimizing coding speed may help individuals but rarely moves a queue-dominated lead time.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "two-weeks",
    question:
      "A one-line fix takes two weeks to reach production. How do you find the constraint?",
    difficulty: 2,
    hints: [
      "Measure time in each stage.",
      "Look for waiting, not effort.",
      "Use percentiles, not only the average.",
    ],
    answer:
      "I would timestamp the change at each transition: committed, review requested, approved, pipeline started, tests passed, deployment started, and live. That shows where the elapsed time went. I would look at the distribution, not only the average, because a few stalled changes can dominate. If approval or a deployment window is the largest wait, that is the constraint; shortening the pipeline will not fix it.",
    followUps: [
      "Which timestamp is usually missing?",
      "How do you measure rework?",
      "What would you do if the queue is outside your team?",
    ],
    redFlags: ["Assumes coding is the delay.", "Measures only pipeline duration.", "Uses an average."],
    rubric: ["Measures stage transitions.", "Looks for queues.", "Uses percentiles.", "Targets the largest wait."],
  },
  {
    id: "optimize",
    question:
      "The pipeline is already twenty minutes and lead time is two weeks. Why is optimizing the pipeline not the answer?",
    difficulty: 2,
    hints: [
      "Twenty minutes is small relative to two weeks.",
      "The constraint is elsewhere.",
      "Local optimization can make the queue worse.",
    ],
    answer:
      "Because the pipeline is not the constraint. If the change waits days for approval or a deployment window, saving ten minutes in the pipeline changes the total by less than a percent. It may still be worth doing for feedback speed, but it will not reduce lead time. The team should find the largest queue and reduce it instead.",
    followUps: [
      "When would pipeline time matter?",
      "How do you avoid optimizing what is easy to measure?",
      "What is the risk of shortening the wrong stage?",
    ],
    redFlags: ["Optimizes the most visible stage.", "Ignores queue time.", "Claims pipeline speed is irrelevant always."],
    rubric: ["Identifies the constraint.", "Quantifies impact.", "Distinguishes feedback from lead time.", "Targets the queue."],
  },
  {
    id: "approval",
    question:
      "How would you reduce approval latency without removing the safety review?",
    difficulty: 3,
    hints: [
      "Move review earlier.",
      "Use risk to choose the path.",
      "Measure the decision, not the ceremony.",
    ],
    answer:
      "I would move review earlier so questions are resolved before the change is ready, define risk-based paths so low-risk changes need less approval, and increase the number of people who can approve the common cases. I would keep the high-risk path intact and measure the time from ready to decision. The goal is to remove waiting, not to remove the judgment.",
    followUps: [
      "Which changes could be auto-approved?",
      "How do you prevent rubber-stamping?",
      "What would you measure after the change?",
    ],
    redFlags: ["Removes review entirely.", "Adds more approvers without a risk model.", "Does not measure latency."],
    rubric: ["Moves review earlier.", "Uses risk-based paths.", "Keeps high-risk review.", "Measures decision time."],
  },
];

const checklist = [
  {
    title: "Measure",
    items: [
      "Timestamp commit, review request, approval, pipeline start, deploy start, and live.",
      "Break lead time into coding, pipeline, approval, and rework.",
      "Report percentiles as well as the average.",
      "Identify the largest queue and its owner.",
    ],
  },
  {
    title: "Improve",
    items: [
      "Reduce the largest queue before optimizing smaller stages.",
      "Move review earlier and use risk-based approval paths.",
      "Remove fixed deploy windows where a gate and rollback provide safety.",
      "Reduce rework with clearer criteria and context.",
    ],
  },
  {
    title: "Verify",
    items: [
      "Re-measure the stage split after the change.",
      "Check that the queue moved rather than disappeared into another stage.",
      "Confirm safety gates still catch the defects they were designed for.",
      "Report lead time with failure rate and recovery time.",
    ],
  },
];

const references = [
  {
    title: "DORA metrics: the four keys",
    url: "https://dora.dev/guides/dora-metrics-four-keys/",
    publisher: "DORA",
    kind: "docs" as const,
    note: "Lead time for changes and its relationship to delivery performance.",
  },
  {
    title: "Release Engineering",
    url: "https://sre.google/sre-book/release-engineering/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Release flow, approval, and the cost of queues in the delivery path.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "lead-time": {
      model: leadTimeModel,
      presets,
      instructions:
        "Start with Healthy and read the stage split. Apply Daily approval, then Two-week queue. Apply Recovery, then run the experiment and its fix. Watch the queue share, not only total lead time.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Durations and queue shares are teaching values, not DORA benchmarks.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-cicd", "deployment-frequency", "deployment-change-management", "deployment-rolling"],
};
