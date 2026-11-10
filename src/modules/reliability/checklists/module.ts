import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "checklistSteps",
    label: "Checklist length",
    min: 4,
    max: 16,
    step: 1,
    value: 9,
    unit: " steps",
    group: "Checklist",
    help: "Number of steps on the failover checklist. Beyond about nine, completion cost and skipping rise quickly.",
    format: "count" as const,
  },
  {
    id: "stressLoad",
    label: "Stress load",
    min: 0,
    max: 100,
    step: 5,
    value: 25,
    unit: "%",
    group: "Conditions",
    help: "Interruptions, time pressure, and noise in the incident channel. Stress increases omission.",
    format: "percent" as const,
  },
  {
    id: "readBackRate",
    label: "Read-back verification",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Checklist",
    help: "Share of steps where a second person confirms the result or the operator reads the value back.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Values {
  steps: number;
  stress: number;
  readBack: number;
  executed: number;
  speed: number;
  omittedRate: number;
  skipped: number;
  retrySkipped: boolean;
  amplification: number;
  secondOutage: number;
  completion: number;
}

function compute(p: Params, t: number): Values {
  const steps = clamp(Math.round(num(p, "checklistSteps", 9)), 4, 16);
  const stress = clamp(num(p, "stressLoad", 25), 0, 100);
  const readBack = clamp(num(p, "readBackRate", 80), 0, 100);
  const speed = 0.35 + (stress / 100) * 0.65;
  const executed = Math.min(steps, speed * Math.max(0, t));
  const lengthPenalty = Math.max(0, steps - 9) * 0.03;
  const omittedRate = clamp(
    0.02 + (stress / 100) * 0.5 + lengthPenalty - (readBack / 100) * 0.42,
    0,
    0.85,
  );
  const skipped = Math.min(steps, executed * omittedRate);
  const retrySkipped = executed >= 3 && omittedRate > 0.35;
  const retryExposure = retrySkipped ? Math.max(0, t - 3 / speed) : 0;
  const amplification = retrySkipped ? Math.min(3.5, 1 + retryExposure * 0.22) : 1;
  const secondOutage = clamp((amplification - 1) * 55 + skipped * 3, 0, 100);
  return {
    steps,
    stress,
    readBack,
    executed,
    speed,
    omittedRate,
    skipped,
    retrySkipped,
    amplification,
    secondOutage,
    completion: (executed / steps) * 100,
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  const retryHealth: "ok" | "warn" | "crit" =
    v.executed < 3 ? "ok" : v.retrySkipped ? "crit" : v.omittedRate > 0.25 ? "warn" : "ok";
  const verifyHealth: "ok" | "warn" | "crit" =
    v.executed < 7 ? "ok" : v.readBack < 50 ? "crit" : v.readBack < 70 ? "warn" : "ok";
  const reenableHealth = v.executed < 8 ? "ok" : healthOf(v.amplification, 1.5, 2.5);
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "decision",
        label: "Failover decision",
        kind: "service",
        health: "ok",
        utilization: 0.3,
        sublabel: "owner named",
        detail: "The checklist starts with one decision and one owner. A failover that starts without a decision is an improvisation.",
        meta: { view: "flow" },
      },
      {
        id: "freeze",
        label: "Freeze deploys",
        kind: "service",
        health: v.executed >= 1 && v.omittedRate > 0.3 ? "warn" : "ok",
        utilization: clamp(0.3 + v.omittedRate * 0.3),
        sublabel: v.executed >= 1 ? "checked" : "pending",
        detail: "Freezing changes removes one source of confounding evidence and one source of new load.",
        meta: { view: "flow" },
      },
      {
        id: "retries",
        label: "Disable retry storm",
        kind: "service",
        health: retryHealth,
        utilization: clamp(0.3 + v.omittedRate * 0.7),
        sublabel: v.retrySkipped ? "step skipped" : v.omittedRate > 0.25 ? "at risk" : "verified",
        detail: "The retry storm step reduces amplification before the promoted primary receives traffic. It is the step whose omission creates a second outage.",
        meta: { view: "flow" },
      },
      {
        id: "promote",
        label: "Promote replica",
        kind: "service",
        health: "ok",
        utilization: clamp(0.35 + v.executed / 40),
        sublabel: v.executed >= 5 ? "executed" : "waiting",
        detail: "Promotion is the visible action. The steps around it determine whether the new primary is protected.",
        meta: { view: "flow" },
      },
      {
        id: "verify",
        label: "Verify write path",
        kind: "service",
        health: verifyHealth,
        utilization: clamp(0.3 + (1 - v.readBack / 100) * 0.5),
        sublabel: `${Math.round(v.readBack)}% read-back`,
        detail: "A write to the new primary and a read from a replica prove the path end to end. A green process check does not.",
        meta: { view: "flow" },
      },
      {
        id: "reenable",
        label: "Re-enable retries",
        kind: "service",
        health: reenableHealth,
        utilization: clamp(0.25 + v.amplification / 5),
        sublabel: v.amplification >= 1.5 ? `${v.amplification.toFixed(1)}x amplification` : "controlled",
        detail: "Retries are re-enabled gradually after the new primary is stable. Jumping back to full rate hides the missing step.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("decision-freeze", "decision", "freeze", v.executed >= 1 ? 0.9 : 0.3, "ok"),
      edge("freeze-retries", "freeze", "retries", v.executed >= 2 ? 0.9 : 0.25, retryHealth),
      edge("retries-promote", "retries", "promote", v.executed >= 4 ? 0.85 : 0.2, "ok"),
      edge("promote-verify", "promote", "verify", v.executed >= 6 ? 0.85 : 0.2, verifyHealth),
      edge("verify-reenable", "verify", "reenable", v.executed >= 8 ? 0.8 : 0.15, reenableHealth),
    ],
    metrics: [
      metric("skipped-steps", "Skipped steps", v.skipped, "", 2, 4, "count"),
      metric("retry-amplification", "Retry amplification", v.amplification, "x", 1.5, 2.5, "number"),
      metric("second-outage-risk", "Second outage risk", v.secondOutage, "%", 30, 60, "percent"),
      metric("checklist-completion", "Checklist completion", v.completion, "%", undefined, undefined, "percent"),
      metric("omission-rate", "Omission rate", v.omittedRate * 100, "%", undefined, undefined, "percent"),
    ],
    events: [
      {
        id: "ck-failover-started",
        at: 0,
        severity: "info",
        title: "Database failover started",
        detail: `${v.steps} checklist steps under ${Math.round(v.stress)}% stress load. Read-back covers ${Math.round(v.readBack)}% of steps.`,
      },
    ],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(v.completion)}% complete; ${Math.round(v.skipped)} step(s) skipped; retry amplification ${v.amplification.toFixed(1)}x.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 6;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + phase) / 3.3))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "retry-amplification",
    metricId: "retry-amplification",
    warn: 1.5,
    crit: 2.5,
    title: "Retries are amplifying load on the new primary",
    cause:
      "The checklist step to disable or bound retries was skipped or never verified. Clients retry against the promoted primary, and each retry adds load to a system that is still warming up.",
    fix:
      "Disable or bound retries at the client and gateway, confirm the retry rate has fallen, then re-enable gradually after the new primary is stable.",
    checkFirst: [
      "Check whether the retry-storm step was executed and read back.",
      "Compare request rate with retry rate at the gateway.",
      "Check whether client timeouts are shorter than the failover window.",
    ],
  },
  {
    id: "second-outage-risk",
    metricId: "second-outage-risk",
    warn: 30,
    crit: 60,
    title: "A second outage is forming behind the failover",
    cause:
      "The failover itself succeeded, but a skipped protective step left the new primary exposed to retry amplification or unverified writes.",
    fix:
      "Treat the failover as incomplete. Stop new work, run the skipped step with a read-back, and verify the write path before declaring recovery.",
    checkFirst: [
      "Read the checklist step order and mark which steps have evidence.",
      "Check the promoted primary's write latency and error rate.",
      "Check whether retries are still climbing after the promotion.",
    ],
  },
  {
    id: "skipped-steps",
    metricId: "skipped-steps",
    warn: 2,
    crit: 4,
    title: "The checklist is being skipped under stress",
    cause:
      "The list is too long for the available attention, or verification is weak enough that a step can be marked done without evidence.",
    fix:
      "Shorten the checklist to the steps that change the outcome, put the protective steps early, and require a read-back for each one.",
    checkFirst: [
      "Which steps have no recorded result?",
      "Is the list longer than the team can run under pressure?",
      "Does every step have a read-back or a second-person check?",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const checklistModel: SimModel = {
  id: "reliability-checklists",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), 0, seed),
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, frame.t, seed);
    next.t = frame.t;
    next.series = { ...frame.series };
    next.flags = { ...frame.flags, ...next.flags };
    next.events = frame.events.slice(-60);
    const v = compute(p, frame.t);
    if (v.retrySkipped && frame.flags.ckRetrySkip !== 1) {
      pushEvent(next, {
        id: "ck-retry-step-skipped",
        at: frame.t,
        severity: "crit",
        title: "Retry-storm step skipped during failover",
        detail: `The team moved from freezing deploys to promotion with ${Math.round(v.omittedRate * 100)}% omission pressure. No one read back the retry state.`,
        nodeId: "retries",
        metricId: "skipped-steps",
      });
      next.flags.ckRetrySkip = 1;
    }
    if (v.amplification >= 2.5 && frame.flags.ckSecondOutage !== 1) {
      pushEvent(next, {
        id: "ck-second-outage",
        at: frame.t,
        severity: "crit",
        title: "Second outage: retries overload the new primary",
        detail: "The promoted primary is receiving the original traffic plus client retries. The failover succeeded and the service is failing again.",
        nodeId: "reenable",
        metricId: "retry-amplification",
      });
      next.flags.ckSecondOutage = 1;
    }
    if (v.executed >= v.steps && frame.flags.ckCompleted !== 1) {
      pushEvent(next, {
        id: "ck-completed",
        at: frame.t,
        severity: v.retrySkipped ? "warn" : "info",
        title: v.retrySkipped ? "Checklist finished with a protective step missing" : "Checklist completed with verification",
        detail: v.retrySkipped
          ? "Every remaining step was marked done, but the retry step has no evidence. Completion is not the same as recovery."
          : "The checked steps include a read-back of the write path and a controlled retry ramp.",
        nodeId: "verify",
      });
      next.flags.ckCompleted = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    return [
      `${Math.round(v.completion)}% of the checklist has run. ${v.skipped.toFixed(1)} step(s) are estimated as skipped at ${Math.round(v.omittedRate * 100)}% omission pressure.`,
      `Retry amplification is ${v.amplification.toFixed(2)}x. This is the signal that separates a completed failover from a safe one.`,
      `Read-back coverage is ${Math.round(v.readBack)}%. A step without a read-back can be marked done without evidence.`,
      `Second-outage risk is ${v.secondOutage.toFixed(0)}%. The risk comes from what was skipped, not from the failover command itself.`,
    ];
  },
  legend: [
    { label: "Verified", tone: "ok" },
    { label: "At risk", tone: "warn" },
    { label: "Skipped", tone: "crit" },
    { label: "Second outage", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Nine steps, low stress, and read-back after every protective step.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy failover",
    description: "A slightly longer list and a noisy channel. The retry step still has evidence.",
    tone: "warn",
    params: defaults({ checklistSteps: 10, stressLoad: 55, readBackRate: 60 }),
    elapsed: 20,
  },
  {
    id: "failure",
    label: "Skipped step",
    description: "A long list, high stress, and little read-back. The retry step is marked done without evidence.",
    tone: "crit",
    params: defaults({ checklistSteps: 12, stressLoad: 90, readBackRate: 20 }),
    elapsed: 10,
  },
  {
    id: "recovery",
    label: "Short and verified",
    description: "Eight steps, moderate stress, and read-back on every protective step.",
    tone: "ok",
    params: defaults({ checklistSteps: 8, stressLoad: 30, readBackRate: 95 }),
  },
];

const experiment: Experiment = {
  id: "predict-second-outage",
  title: "Predict which skipped step causes the second outage",
  simId: "checklists",
  question:
    "The failover checklist has twelve steps, the channel is loud, and the team is moving fast. Which omission turns one outage into two?",
  prediction: {
    options: [
      { id: "retries", label: "Not disabling or bounding the retry storm before promotion" },
      { id: "freeze", label: "Not freezing deploys before the failover" },
      { id: "status", label: "Not updating the status page after the failover" },
      { id: "promote", label: "Not promoting the replica" },
    ],
    correctOptionId: "retries",
    explanation:
      "Freezing deploys removes a confounder. The status page changes communication, not load. Promotion is the visible action. Disabling retries protects the new primary from the original clients plus their retries. Skip that step and the failover succeeds into a second overload.",
  },
  setup: defaults({ checklistSteps: 12, stressLoad: 90, readBackRate: 20 }),
  runFor: 20,
  observe: [
    "The retry step is skipped at about the third executed step, while promotion continues.",
    "Skipped steps then cross the warning threshold as the list continues.",
    "Retry amplification crosses warning and then critical as the new primary receives traffic.",
    "Second-outage risk reaches critical while the checklist itself is nearly complete.",
  ],
  explain:
    "A checklist reduces omission by making the order visible and by requiring evidence for each step. Length and stress raise the chance that a step is marked done without a read-back. The protective steps must be early, short, and verified, because the cost of their omission appears after the failover looks successful.",
  fix: defaults({ checklistSteps: 8, stressLoad: 30, readBackRate: 95 }),
  debrief:
    "The short, verified checklist keeps retry amplification at 1x because the retry step is executed and read back before promotion. The cost is that the list covers less ground. That is the right trade for the steps whose omission creates a second outage; everything else can live in a link or a follow-up.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An incident checklist is a short, ordered list of steps that must be completed and verified during a known procedure such as a failover, a restore, or a key rotation. It is not a tutorial and not a runbook. The runbook explains the procedure and its decisions; the checklist is the small set of steps the team must not omit while executing it under stress.",
  },
  {
    type: "p",
    text: "Checklists work because human memory fails predictably under load. The pilot's checklist does not teach the pilot to fly. It catches the steps that are easy to skip when attention is split between a failing system, a loud channel, and a customer update. The same logic applies to a failover: the command is usually not the hard part. Remembering to protect the new primary before it takes traffic is.",
  },
  {
    type: "p",
    text: "A checklist can also cause harm. A long list creates its own omission pressure, because people skip to the end when the list outruns their attention. A step without a read-back can be marked done without evidence. A list that mixes critical protections with nice-to-have communication steps hides the difference. Short, ordered, and verified are not style preferences; they are the properties that make the list work.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The checklist sits inside a runbook or a failover procedure, at the point where the team is executing rather than deciding. The playbook decides how to investigate an unknown cause. Incident command owns priorities and communication. The checklist owns the order and evidence for one known sequence.",
  },
  {
    type: "table",
    headers: ["Checklist property", "Why it matters", "Failure when missing"],
    rows: [
      ["Short", "Fits the attention available under stress", "Steps are skipped to reach the end"],
      ["Ordered", "Protective steps run before irreversible ones", "A promotion exposes an unprotected primary"],
      ["Observable", "Each step has a signal the team can see", "A step is marked done from memory"],
      ["Verified", "A read-back proves the result", "The next step compounds a silent failure"],
      ["Owned", "One person is accountable for the sequence", "Everyone assumes someone else ran it"],
    ],
  },
  {
    type: "p",
    text: "This module models a database failover checklist. One simulated second represents roughly one minute of procedure time. The omission rates, step counts, and amplification values are illustrative teaching values, not a claim about a specific database or provider.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Skipped steps: the estimated count of steps executed without evidence.",
      "Retry amplification: how much extra load the new primary receives from retries.",
      "Second-outage risk: the combined risk from skipped protective steps and amplification.",
      "Checklist completion: how far through the sequence the team has moved.",
      "A flow view of decision, freeze, retry control, promotion, verification, and re-enable.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Skipped step. Watch the retry node before the promotion node, and the amplification before the second-outage risk. Run the experiment before reading the debrief, then shorten the list and raise read-back one change at a time.",
  },
  {
    type: "compare",
    leftTitle: "Long procedure",
    rightTitle: "Short verified checklist",
    rows: [
      { label: "Length", left: "Fifteen steps with no priority", right: "Eight steps that change the outcome" },
      { label: "Order", left: "Communication mixed with protection", right: "Protective steps first" },
      { label: "Evidence", left: "Checkbox after each command", right: "Read-back of the expected signal" },
      { label: "Failure", left: "Quiet omission near the end", right: "A skipped step is visible and stops the sequence" },
    ],
  },
  { type: "sim", simId: "checklists" },
  { type: "experiment", experimentId: "predict-second-outage" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failover command worked. The checklist did not. Twelve steps, a loud channel, and almost no read-back meant the team moved from freezing deploys to promoting the replica without confirming that retries were bounded. The new primary received the original traffic plus the retries that had accumulated during the failover. The second outage began after the first one looked resolved.",
  },
  {
    type: "p",
    text: "The checklist was not ignored. It was too long for the attention available and too weakly verified to catch a step that was marked done from memory. Shortening it to eight steps and adding read-back did not make the team less thorough. It made the protective steps visible early, where they could still change the outcome.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Failover log: promotion recorded, but no entry for retry state or write-path verification.",
      "Gateway metrics: request rate steady, retry rate climbing after the promotion.",
      "Database metrics: new primary CPU and write latency rising while replication looks healthy.",
      "Checklist artifact: every checkbox marked complete, with no recorded value or second-person confirmation.",
      "Incident channel: \"Failover done\" followed by a second alert for the same service minutes later.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the retry-storm step has evidence, not whether it has a checkmark. Then compare the gateway retry rate with the request rate. If retries are climbing after promotion, the failover is not complete.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the checklist and treat the failover as incomplete.",
      "Bound or disable retries at the client and gateway, then confirm the retry rate fell.",
      "Verify the write path end to end with a write and a read from a replica.",
      "Re-enable retries gradually and watch the new primary's latency and error rate.",
      "Shorten the checklist to the steps that change the outcome, with protective steps first.",
      "Add a read-back or second-person confirmation to every protective step.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shorter checklist is easier to complete but covers less. Cut communication and record-keeping steps before cutting protections.",
      "Read-back costs a second person or a second look. It is the cheapest defense against a silent omission.",
      "A checklist that is too detailed becomes a runbook and loses the speed advantage. Keep the decisions in the runbook and the must-not-omit steps in the checklist.",
      "Rehearsal improves completion but cannot make a bloated list short. Design the list for the attention available, not for the attention you wish you had.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "checklist-design",
    question: "What makes an incident checklist usable under stress?",
    difficulty: 1,
    hints: [
      "Think about attention, not knowledge.",
      "The order and the evidence matter as much as the steps.",
    ],
    answer:
      "It is short enough to finish, ordered so protective steps run before irreversible ones, observable so each step has a signal, and verified so a read-back proves the result. It also has one owner for the sequence. A checklist is not a place for background explanation or for every possible task. It is the small set of steps whose omission would change the outcome.",
    followUps: [
      "How short is short enough?",
      "Who should own the checklist?",
      "What do you cut first when the list is too long?",
    ],
    redFlags: [
      "Makes it comprehensive.",
      "Puts communication before protection.",
      "Accepts a checkbox as evidence.",
    ],
    rubric: [
      "Names brevity, order, observability, verification.",
      "Assigns an owner.",
      "Explains what to cut.",
      "Distinguishes checklist from runbook.",
    ],
  },
  {
    id: "second-outage",
    question:
      "A failover completes and a second outage starts minutes later. How do you find the skipped step?",
    difficulty: 2,
    hints: [
      "Compare the checklist's evidence with the metrics that moved.",
      "Look for the protection that should have run before promotion.",
    ],
    answer:
      "I compare the checklist's recorded evidence with the timeline of the second failure. The signal usually points to a protective step that should have run before promotion: retry control, connection draining, write-path verification, or a dependent service that was not checked. I look for a checkbox without a value or a read-back, then confirm the hypothesis in the gateway and database metrics. The fix is to restore the protection and add evidence to that step, not to add another step at the end.",
    followUps: [
      "What if the skipped step is not on the checklist?",
      "How do you prevent the same omission next time?",
      "Who reviews the checklist after the incident?",
    ],
    redFlags: [
      "Adds more steps without finding the omission.",
      "Blames the responder.",
      "Checks only the failover command.",
    ],
    rubric: [
      "Uses evidence and timeline.",
      "Looks before promotion.",
      "Restores the protection.",
      "Adds verification to the step.",
    ],
  },
  {
    id: "length-tradeoff",
    question: "When is a longer checklist the right choice, and when is it a liability?",
    difficulty: 2,
    hints: [
      "Length is a cost paid under stress.",
      "Some procedures have more irreversible steps.",
    ],
    answer:
      "A longer checklist can be right when the procedure has many irreversible steps, a high cost of omission, and enough people to divide the work. It becomes a liability when the same small team must complete it under time pressure, because length increases skipping and turns verification into a formality. The test is not the step count. It is whether the team can run every step with evidence at the attention available. If not, cut the low-consequence steps and keep the protections.",
    followUps: [
      "How do you split a long checklist across roles?",
      "Should critical steps be repeated?",
      "How do you test whether a list is too long?",
    ],
    redFlags: [
      "Assumes shorter is always safer.",
      "Adds steps to fix skipping.",
      "Ignores staffing.",
    ],
    rubric: [
      "Conditions length on irreversibility and staffing.",
      "Treats verification as the constraint.",
      "Cuts low-consequence steps.",
      "Names a test for usability.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The checklist covers one procedure, not every failover task.",
      "Protective steps run before irreversible steps.",
      "Every protective step has a read-back or second-person confirmation.",
      "The list has been timed in a rehearsal under realistic interruptions.",
      "One owner is named for the sequence and one for the verification.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the next step aloud and confirm the expected signal.",
      "Record the observed value, not only a checkmark.",
      "Do not promote or re-enable traffic until the protective steps have evidence.",
      "Stop the sequence when a read-back does not match.",
      "Record timestamps for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare the checklist evidence with the incident timeline.",
      "Find every step that was marked done without a value.",
      "Cut or merge steps that did not change a decision.",
      "Rehearse the revised list and record the new completion time.",
    ],
  },
];

const references = [
  {
    title: "The Checklist Manifesto",
    url: "https://atulgawande.com/book/the-checklist-manifesto/",
    publisher: "Atul Gawande",
    kind: "book" as const,
    note: "Checklist design under complexity and stress, including the case for short, focused lists.",
  },
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Operational load, procedures, and the conditions that make response error-prone.",
  },
  {
    title: "Managing Incidents",
    url: "https://sre.google/sre-book/managing-incidents/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Incident roles and coordination during procedures that cross team boundaries.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    checklists: {
      model: checklistModel,
      presets,
      instructions:
        "Start Healthy, then apply Skipped step. Watch the retry node before promotion, then the amplification and second-outage metrics. Shorten the list and raise read-back one change at a time.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents about one minute of procedure time; omission and amplification values are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-runbooks",
    "reliability-playbooks",
    "reliability-incident-command",
    "reliability-action-items",
  ],
};
