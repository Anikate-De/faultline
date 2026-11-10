import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "coverage",
    label: "Diagnosis coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Runbook",
    help: "Share of the alert's diagnosis path covered by an explicit check. Missing checks become guesses.",
    format: "percent" as const,
  },
  {
    id: "topologyDrift",
    label: "Topology drift",
    min: 0,
    max: 60,
    step: 1,
    value: 5,
    unit: "%",
    group: "Runbook",
    help: "How far the runbook's assumed hosts, roles, and dependencies have moved from production.",
    format: "percent" as const,
  },
  {
    id: "verificationRate",
    label: "Verification coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Runbook",
    help: "Share of actions followed by a check for the expected signal before the next action starts.",
    format: "percent" as const,
  },
  {
    id: "practiceRuns",
    label: "Practice runs",
    min: 0,
    max: 12,
    step: 1,
    value: 6,
    unit: " / quarter",
    group: "Team",
    help: "Rehearsals in the last quarter. Practice changes speed and confidence, not whether an assumption is true.",
    format: "count" as const,
  },
];

const PHASE_END = [2, 3, 6, 10, 14, 18];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function phaseAt(t: number, practice: number): number {
  const speed = 1 + practice * 0.03;
  const scaled = Math.max(0, t) * speed;
  let phase = 0;
  while (phase < PHASE_END.length && scaled >= PHASE_END[phase]) phase++;
  return phase;
}

interface Values {
  coverage: number;
  drift: number;
  verification: number;
  practice: number;
  phase: number;
  mismatch: boolean;
  mismatchDetected: boolean;
  mismatchCaught: boolean;
  misapplied: number;
  checksSkipped: number;
  projected: number;
  progress: number;
  verificationGap: number;
}

function compute(p: Params, t: number): Values {
  const coverage = clamp(num(p, "coverage", 95), 0, 100);
  const drift = clamp(num(p, "topologyDrift", 5), 0, 60);
  const verification = clamp(num(p, "verificationRate", 95), 0, 100);
  const practice = clamp(Math.round(num(p, "practiceRuns", 6)), 0, 12);
  const phase = phaseAt(t, practice);
  const mismatch = drift > 30;
  const mismatchDetected = phase >= 2 && mismatch && coverage >= 50;
  const mismatchCaught = mismatchDetected && verification >= 60;
  const hazard = mismatch && !mismatchCaught;
  const restartHazard = phase >= 3 && hazard;
  const restartCaught = phase >= 4 && verification >= 70;
  const failoverHazard = phase >= 5 && hazard && !restartCaught;
  const misapplied = (restartHazard ? 1 : 0) + (failoverHazard ? 1 : 0);
  const checksSkipped =
    (phase >= 2 && coverage < 50 ? 1 : 0) +
    (phase >= 2 && verification < 60 ? 1 : 0) +
    (phase >= 4 && verification < 70 ? 1 : 0);
  const projected = clamp(
    14 + drift * 0.08 + checksSkipped * 3 + misapplied * 10 + (practice < 2 ? 4 : 0),
    0,
    180,
  );
  const progress = clamp((Math.max(0, t) * (1 + practice * 0.03)) / PHASE_END[PHASE_END.length - 1] * 100, 0, 100);
  return {
    coverage,
    drift,
    verification,
    practice,
    phase,
    mismatch,
    mismatchDetected,
    mismatchCaught,
    misapplied,
    checksSkipped,
    projected,
    progress,
    verificationGap: phase >= 3 ? 100 - verification : 0,
  };
}

function healthOf(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, t: number, seed: number): SimFrame {
  const v = compute(p, t);
  const topologyHealth: "ok" | "warn" | "crit" =
    v.phase < 2 ? "ok" : v.drift > 45 && v.coverage < 50 ? "crit" : v.drift > 30 ? "warn" : "ok";
  const actionHealth = v.phase < 3 ? "ok" : healthOf(v.misapplied, 1, 2);
  const verifyHealth: "ok" | "warn" | "crit" =
    v.phase < 4 ? "ok" : v.verification < 50 ? "crit" : v.verification < 70 ? "warn" : "ok";
  const escalationHealth = v.phase < 2 ? "ok" : healthOf(v.checksSkipped, 1, 2);
  const frame: SimFrame = {
    t,
    nodes: [
      {
        id: "alert",
        label: "Alert",
        kind: "client",
        health: "ok",
        utilization: 0.25,
        sublabel: "checkout latency",
        detail: "One alert, one known failure mode. The runbook exists because this alert has been seen before.",
        meta: { view: "flow" },
      },
      {
        id: "triage",
        label: "Triage checks",
        kind: "service",
        health: v.phase >= 1 && v.coverage < 50 ? "warn" : "ok",
        utilization: clamp(0.3 + (1 - v.coverage / 100) * 0.4),
        sublabel: `${Math.round(v.coverage)}% covered`,
        detail: "Ordered checks narrow the cause. A check without an expected signal is a question with no answer.",
        meta: { view: "flow" },
      },
      {
        id: "topology",
        label: "Topology check",
        kind: "service",
        health: topologyHealth,
        utilization: clamp(0.3 + v.drift / 100),
        sublabel: v.mismatch ? `${Math.round(v.drift)}% drift` : "matches production",
        detail:
          v.coverage < 50
            ? `The runbook has no topology check. It still assumes a single primary while production runs an active-passive pair; drift is ${Math.round(v.drift)}%, and the action proceeds without comparing the assumed role with the live role.`
            : `The topology check compares the runbook's assumed role with production. Drift is ${Math.round(v.drift)}%.`,
        meta: { view: "flow" },
      },
      {
        id: "action",
        label: "Safe action",
        kind: "worker",
        health: actionHealth,
        utilization: clamp(0.35 + v.misapplied * 0.2),
        sublabel: v.misapplied >= 1 ? `${v.misapplied} misapplied` : "bounded action",
        detail: "A safe action says what to change, what not to touch, and what signal proves it worked.",
        meta: { view: "flow" },
      },
      {
        id: "verify",
        label: "Verification",
        kind: "service",
        health: verifyHealth,
        utilization: clamp(0.3 + (1 - v.verification / 100) * 0.5),
        sublabel: `${Math.round(v.verification)}% verified`,
        detail: "Verification is the step that catches a wrong assumption before the next action compounds it.",
        meta: { view: "flow" },
      },
      {
        id: "escalate",
        label: "Escalation point",
        kind: "worker",
        health: escalationHealth,
        utilization: clamp(0.25 + v.checksSkipped * 0.12),
        sublabel: v.checksSkipped >= 1 ? `${v.checksSkipped} checks skipped` : "named owner",
        detail: "The runbook names when to stop and who to call. Continuing without evidence is not persistence.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("alert-triage", "alert", "triage", v.phase >= 1 ? 0.9 : 0.35, "ok"),
      edge("triage-topology", "triage", "topology", v.phase >= 2 ? 0.85 : 0.3, topologyHealth),
      edge("topology-action", "topology", "action", v.phase >= 3 ? 0.9 : 0.25, actionHealth),
      edge("action-verify", "action", "verify", v.phase >= 4 ? 0.9 : 0.2, verifyHealth),
      edge("verify-escalate", "verify", "escalate", v.phase >= 5 ? 0.8 : 0.2, escalationHealth),
    ],
    metrics: [
      metric("projected-mitigation", "Projected time to mitigate", v.projected, " min", 25, 40, "number"),
      metric("misapplied-actions", "Misapplied actions", v.misapplied, "", 1, 2, "count"),
      metric("checks-skipped", "Checks skipped", v.checksSkipped, "", 1, 2, "count"),
      metric("verification-gap", "Verification gap", v.verificationGap, "%", undefined, undefined, "percent"),
      metric("runbook-progress", "Runbook progress", v.progress, "%", undefined, undefined, "percent"),
    ],
    events: [
      {
        id: "rb-alert",
        at: 0,
        severity: "info",
        title: "Checkout latency alert opened the runbook",
        detail: `The alert matches one known failure mode. The runbook covers ${Math.round(v.coverage)}% of the diagnosis path; topology drift is ${Math.round(v.drift)}%.`,
      },
    ],
    series: {},
    flags: { seed, phase: v.phase, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(v.progress)}% through the runbook; ${v.checksSkipped} check(s) skipped; projected mitigation ${v.projected.toFixed(0)} min.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 7;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.985 + 0.03 * Math.sin((index + phase) / 3.1))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "projected-mitigation",
    metricId: "projected-mitigation",
    warn: 25,
    crit: 40,
    title: "Time to mitigate is growing past the incident target",
    cause:
      "The runbook is spending the incident on assumptions that no longer match production. Each skipped check or misapplied action adds a recovery cycle.",
    fix:
      "Stop executing and re-verify the topology before the next action. Correct the runbook's host and role assumptions, then resume from the last verified check.",
    checkFirst: [
      "Compare the runbook's named hosts and roles with the current service topology.",
      "Check which actions were applied without an expected-signal confirmation.",
      "Check the timestamp of the last verified runbook review.",
    ],
  },
  {
    id: "misapplied-actions",
    metricId: "misapplied-actions",
    warn: 1,
    crit: 2,
    title: "A runbook action was applied against the wrong topology",
    cause:
      "The runbook assumes a different node role or dependency path than production. Without a verification step, the action looks successful until the next signal disproves it.",
    fix:
      "Revert the action if it is reversible, restore the affected capacity, and add a topology pre-check with an expected signal before the action. Rehearse the corrected path.",
    checkFirst: [
      "Which node actually serves traffic right now, and which node did the runbook name?",
      "Did the action have a read-back or expected-signal check?",
      "Is the service still serving from the intended primary?",
    ],
  },
  {
    id: "checks-skipped",
    metricId: "checks-skipped",
    warn: 1,
    crit: 2,
    title: "The runbook is being executed without its checks",
    cause:
      "Coverage is thin or verification is missing, so the responder moves from alert to action on memory. A skipped check removes the evidence that would stop a bad action.",
    fix:
      "Pause, run the missing check, and record its result. If the check cannot be run, escalate to someone who can name the current topology rather than guessing.",
    checkFirst: [
      "Which checks are missing from the runbook, and which were skipped in this run?",
      "Does each action name the signal that proves it worked?",
      "Can the on-call reach a service owner who knows the current topology?",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const runbookModel: SimModel = {
  id: "reliability-runbooks",
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
    if (v.mismatchDetected && frame.flags.rbMismatch !== 1) {
      pushEvent(next, {
        id: "rb-topology-mismatch",
        at: frame.t,
        severity: "warn",
        title: "Topology check does not match the runbook",
        detail: `The runbook assumes a single primary. Production is an active-passive pair with ${Math.round(v.drift)}% drift. The check found the gap; verification decides whether the action stops.`,
        nodeId: "topology",
        metricId: "checks-skipped",
      });
      next.flags.rbMismatch = 1;
    }
    if (v.misapplied >= 1 && frame.flags.rbMisapplied !== 1) {
      pushEvent(next, {
        id: "rb-misapplied-action",
        at: frame.t,
        severity: "crit",
        title: "Restart applied to the wrong node",
        detail: "The runbook drained and restarted the instance it believed was primary. The actual primary stayed in service, and the healthy standby lost capacity.",
        nodeId: "action",
        metricId: "misapplied-actions",
      });
      next.flags.rbMisapplied = 1;
    }
    if (v.misapplied >= 2 && frame.flags.rbMisappliedSecond !== 1) {
      pushEvent(next, {
        id: "rb-misapplied-second",
        at: frame.t,
        severity: "crit",
        title: "Failover repeated the same assumption",
        detail: "The verification step did not compare the symptom with the expected signal, so the next action repeated the stale topology assumption.",
        nodeId: "verify",
        metricId: "misapplied-actions",
      });
      next.flags.rbMisappliedSecond = 1;
    }
    if (v.phase >= 6 && v.misapplied === 0 && frame.flags.rbCompleted !== 1) {
      pushEvent(next, {
        id: "rb-completed",
        at: frame.t,
        severity: "info",
        title: "Runbook completed with verified signals",
        detail: "Every action was followed by its expected signal. The runbook can be closed and its timings reviewed.",
        nodeId: "escalate",
      });
      next.flags.rbCompleted = 1;
    }
    if (v.phase >= 6 && v.misapplied > 0 && frame.flags.rbIncomplete !== 1) {
      pushEvent(next, {
        id: "rb-incomplete",
        at: frame.t,
        severity: "warn",
        title: "Runbook ended without a verified recovery",
        detail: "The procedure ran to the end but the expected signal never arrived. Escalation should have happened before the second action.",
        nodeId: "escalate",
        metricId: "projected-mitigation",
      });
      next.flags.rbIncomplete = 1;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const v = compute(p, frame.t);
    const items = [
      `The runbook is ${Math.round(v.progress)}% complete. Coverage is ${Math.round(v.coverage)}% and verification is ${Math.round(v.verification)}%.`,
      v.mismatch
        ? `The runbook assumes a topology with ${Math.round(v.drift)}% drift. A check is only useful if it compares that assumption with the live role of each node.`
        : "The runbook's topology assumptions match the current service. That is a property of maintenance, not a one-time review.",
      v.misapplied > 0
        ? `${v.misapplied} action(s) were applied without the expected signal. The next action compounds the first unless verification stops it.`
        : "No action has been applied against a stale assumption in this run.",
      `Projected mitigation is ${v.projected.toFixed(0)} minutes. Practice changes execution speed; it does not make a stale step safe.`,
    ];
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A maintained runbook, low drift, and verification after every action.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Busy shift",
    description: "Coverage is thinner and the topology has moved. The runbook still holds.",
    tone: "warn",
    params: defaults({ coverage: 80, topologyDrift: 22, verificationRate: 70, practiceRuns: 3 }),
  },
  {
    id: "failure",
    label: "Stale runbook",
    description: "The runbook assumes a retired topology, has thin checks, and skips verification.",
    tone: "crit",
    params: defaults({ coverage: 30, topologyDrift: 55, verificationRate: 25, practiceRuns: 1 }),
    elapsed: 6.2,
  },
  {
    id: "recovery",
    label: "Corrected runbook",
    description: "Re-verified topology, full checks, and a read-back after every action.",
    tone: "ok",
    params: defaults({ coverage: 100, topologyDrift: 5, verificationRate: 100, practiceRuns: 8 }),
  },
];

const experiment: Experiment = {
  id: "predict-stale-step",
  title: "Predict which step turns a slowdown into harm",
  simId: "runbooks",
  question:
    "The runbook was written for a single primary. Production now runs an active-passive pair, and the on-call has little time. Which step causes the harm?",
  prediction: {
    options: [
      { id: "topology", label: "The restart action, because it targets the node the runbook believes is primary" },
      { id: "alert", label: "The alert threshold, because it fires too late" },
      { id: "practice", label: "The lack of practice, because the on-call is slow" },
      { id: "escalation", label: "The escalation point, because it is reached too early" },
    ],
    correctOptionId: "topology",
    explanation:
      "Practice changes how fast the steps run. The alert changes when the runbook starts. The harm comes from a step that names a role the topology no longer has, applied without a read-back that would catch the mismatch.",
  },
  setup: defaults({ coverage: 30, topologyDrift: 55, verificationRate: 25, practiceRuns: 1 }),
  runFor: 25,
  observe: [
    "The runbook skips the topology check, so the drift is not detected before the first action.",
    "The first action is applied against the stale role and is recorded as misapplied.",
    "Skipped checks cross the critical threshold before the projected mitigation time does.",
    "The projected time to mitigate keeps rising because each unverified action adds a recovery cycle.",
  ],
  explain:
    "A runbook is a set of assumptions executed under time pressure. When the topology changes, the assumptions become unsafe even if every sentence is still readable. The defense is not more practice; it is a topology check with an expected signal, and a verification step that stops the sequence when the signal does not match.",
  fix: defaults({ coverage: 100, topologyDrift: 5, verificationRate: 100, practiceRuns: 8 }),
  debrief:
    "The corrected runbook completes without a misapplied action because it checks the live role before acting and reads back the expected signal afterward. The remaining cost is maintenance: the topology check must be reviewed whenever the service changes, or it becomes the next stale assumption.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A runbook is a short, tested procedure for one alert or one known failure mode. It names the trigger, the checks to run in order, the signal each check should show, the actions that are safe to take, the point to stop and escalate, and the verification that proves recovery. It is scoped to a known problem, not to an entire service and not to an unknown cause.",
  },
  {
    type: "p",
    text: "The value is not that the runbook teaches an expert something new. The value is that a tired on-call engineer follows the same safe order at 03:00 as at 15:00, and that the assumptions behind each action are written down where they can be reviewed. A runbook that says \"restart the primary\" without checking which node is primary is a loaded instruction.",
  },
  {
    type: "p",
    text: "Runbooks drift. Hosts are renamed, a single primary becomes a failover pair, a queue is replaced by a stream, and the readable sentence stays the same. The dangerous failure is not an outdated command that errors. It is an outdated command that succeeds against the wrong component.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is alert, triage, ordered checks, safe action, verification, then escalation or closure. A playbook sits above this path and tells the responder which kind of guidance to use when the cause is unknown. Incident command sits above both and decides who owns the response. The runbook does not decide whether to declare an incident; it executes one known response.",
  },
  {
    type: "table",
    headers: ["Part", "Question it answers", "What fails without it"],
    rows: [
      ["Trigger and scope", "Which alert, which service, what is out of scope?", "The runbook is applied to the wrong failure"],
      ["Ordered checks", "What do I verify first, second, third?", "Responders skip to an action on memory"],
      ["Expected signal", "What should each check show?", "A check passes without meaning anything"],
      ["Safe action", "What may I change, and what must I not touch?", "A local fix creates a wider outage"],
      ["Escalation point", "When do I stop and who do I call?", "The on-call keeps going without evidence"],
      ["Verification", "What proves the system recovered?", "A failed action is followed by another"],
    ],
  },
  {
    type: "p",
    text: "This module models a checkout latency alert with a six-stage runbook. One simulated second represents one minute of incident time. The drift, timings, and thresholds are illustrative teaching values, not a claim about any provider or service.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Projected time to mitigate: how long the current path will take if the next actions behave like the last ones.",
      "Misapplied actions: steps applied against a topology that no longer exists.",
      "Checks skipped: evidence the responder never collected before acting.",
      "Verification gap: the share of actions with no expected-signal check.",
      "A flow view of alert, triage, topology check, action, verification, and escalation.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Stale runbook. Watch the checks-skipped metric and the topology node before the action node. Open Timeline to replay the sequence. Run the experiment before reading the debrief, then correct one parameter at a time and watch which metric moves first.",
  },
  {
    type: "compare",
    leftTitle: "Runbook as a script",
    rightTitle: "Runbook as a tested procedure",
    rows: [
      { label: "Assumption", left: "The topology is whatever the document says", right: "The live role of each node is checked first" },
      { label: "Action", left: "Run the command and continue", right: "Apply the smallest change, then read back the signal" },
      { label: "Failure", left: "The next step compounds the first", right: "Verification stops the sequence and escalates" },
      { label: "Maintenance", left: "Reviewed after an incident, if at all", right: "Re-verified whenever the service topology changes" },
    ],
  },
  { type: "sim", simId: "runbooks" },
  { type: "experiment", experimentId: "predict-stale-step" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The alert was real and the runbook was readable. The failure was in the assumptions: the document named a single primary, while production served traffic from a failover pair. The runbook had no topology check, so the drift was never detected. Without a verification step, the responder applied the restart to the standby. The action succeeded at the command level and failed at the system level.",
  },
  {
    type: "p",
    text: "The second action repeated the same assumption because the first action's result was never compared with the expected signal. That is how a stale runbook causes harm: not one dramatic mistake, but a sequence in which every step is locally reasonable and the sequence is globally wrong. The projected mitigation time rose with each unverified action.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Alert payload and runbook link: the alert names a service the runbook last verified against a different host set.",
      "Change log: a restart or failover on a node that was not serving traffic, followed by a capacity complaint from the remaining node.",
      "Health checks: one node reports healthy while the service-level error rate rises, because the check verifies process liveness, not traffic.",
      "On-call notes: \"Ran the runbook\" with no recorded output for the topology or verification steps.",
      "Incident timeline: the first mitigation attempt and the second attempt use the same stale role assumption.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the live role of every node the runbook names before running the next action. Then check whether the last action was followed by a read-back of the expected signal. If neither is recorded, stop and escalate rather than continue the sequence.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Stop the runbook at the first unexpected signal. A successful command is not a successful action.",
      "Name the current topology from the source of truth: which node serves traffic, which is standby, and which dependencies are active.",
      "Restore any capacity lost by the misapplied action, then verify the service-level signal rather than the process status.",
      "Add a topology pre-check with an explicit expected result to the runbook, and place it before the first action.",
      "Add a read-back after every action and a stop condition when the signal does not match.",
      "Rehearse the corrected runbook against the current topology, including the escalation path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A runbook with more checks is safer but slower. The checks must be short enough to run under pressure and specific enough to change a decision.",
      "Verification costs a read-back and can feel redundant when the action usually works. Its value appears on the day the action targets the wrong node.",
      "A runbook that covers every branch becomes a playbook and loses the speed of a known procedure. Keep it scoped to the alert it was written for.",
      "A topology check is only as current as its last review. Automating it against the service registry reduces drift but adds a dependency on that registry.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "runbook-contents",
    question: "What belongs in a runbook for a known alert, and what does not?",
    difficulty: 2,
    hints: [
      "Start from the decision the responder must make, not from the command they must run.",
      "Scope it to one alert and one known failure mode.",
    ],
    answer:
      "It needs the trigger and scope, ordered checks with expected signals, the safe actions and their limits, the escalation point, and the verification that proves recovery. It should also name the owner and the last review date. It does not need a general architecture essay, a full service history, or branches for unknown causes. Those belong in service documentation and in a playbook. The test is whether a tired responder can use it to make a decision, not whether it describes everything the author knows.",
    followUps: [
      "How short should a runbook be?",
      "Who owns the runbook after the incident closes?",
      "What do you do with steps that cannot be verified?",
    ],
    redFlags: [
      "Writes a general troubleshooting guide.",
      "Omits expected signals.",
      "Includes actions without limits or rollback.",
    ],
    rubric: [
      "Names trigger, checks, actions, escalation, and verification.",
      "Keeps the scope to one known failure mode.",
      "Assigns an owner and review date.",
      "Distinguishes runbook from playbook.",
    ],
  },
  {
    id: "test-runbook",
    question: "How do you test a runbook without waiting for the next real incident?",
    difficulty: 3,
    hints: [
      "Rehearse the decision path, not only the commands.",
      "Use a non-production environment that matches the current topology.",
    ],
    answer:
      "I rehearse it in a safe environment against the current topology, with the same alert payload and the same access path the on-call will use. The rehearsal checks whether each expected signal is observable, whether each action is reversible, and whether the escalation contact answers. I also run a tabletop for the decision points: what does the responder do when the first check fails or the signal is ambiguous. After the rehearsal, I record the actual timings and update the runbook. A runbook that has never been executed is a hypothesis.",
    followUps: [
      "What if the safe environment cannot reproduce the failure?",
      "How often should you rehearse?",
      "How do you test the escalation path?",
    ],
    redFlags: [
      "Tests only by reading the document.",
      "Uses production for the first execution.",
      "Never checks the expected signals.",
    ],
    rubric: [
      "Rehearses against the current topology.",
      "Checks observability of expected signals.",
      "Tests reversibility and escalation.",
      "Feeds timings back into the document.",
    ],
  },
  {
    id: "topology-drift",
    question:
      "The runbook says to restart the primary. The service is now an active-passive pair. What do you change before the next incident?",
    difficulty: 3,
    hints: [
      "A role name is an assumption, not a hostname.",
      "Put the check before the action, not after it.",
    ],
    answer:
      "I replace the role assumption with a check that reads the live topology from the source of truth and asserts which node is active. The action becomes \"restart the standby\" or \"fail over under the documented condition\", with a read-back of the service-level signal. I add a stop condition if the live role does not match the runbook, and I make the topology check the first action rather than a note. Then I rehearse the pair, including the case where the standby is the node that is actually serving.",
    followUps: [
      "What if the source of truth is wrong?",
      "How do you handle a partial failover?",
      "Who approves a change to a runbook during an incident?",
    ],
    redFlags: [
      "Renames the host and leaves the assumption.",
      "Adds a warning note instead of a check.",
      "Lets the responder decide the role from memory.",
    ],
    rubric: [
      "Replaces the role assumption with a live check.",
      "Adds a stop condition and read-back.",
      "Rehearses the failover pair.",
      "Names the source of truth.",
    ],
  },
  {
    id: "escalation-point",
    question: "When should a runbook stop and escalate instead of continuing?",
    difficulty: 2,
    hints: [
      "Escalation is triggered by missing evidence, not only by elapsed time.",
      "Name the condition before the incident.",
    ],
    answer:
      "The runbook should stop when an expected signal does not match, when a required check cannot be run, when an action is not reversible, or when the responder cannot name the current topology. A time trigger is also useful, but time alone is a weak signal. The stop condition should name who to call and what context to pass: impact, checks already run, actions applied, and the specific question. Continuing without evidence turns a known procedure into an improvised one.",
    followUps: [
      "What if the escalation contact does not answer?",
      "How do you keep the stop condition from firing too often?",
      "Who can authorize continuing past the stop condition?",
    ],
    redFlags: [
      "Escalates only on elapsed time.",
      "Continues because the action usually works.",
      "Has no named escalation contact.",
    ],
    rubric: [
      "Names evidence-based and time-based triggers.",
      "Includes a context handoff.",
      "Makes the stop condition explicit.",
      "Keeps authority to continue clear.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each alert links to a runbook with an owner and a last-reviewed date.",
      "Every check names the signal it expects, not only the command it runs.",
      "Every action names its limit, rollback, and read-back.",
      "The escalation point names a person or rotation and the context to pass.",
      "The runbook has been rehearsed against the current topology in the last quarter.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the live role of every node before changing it.",
      "Run the checks in order and record the observed signal.",
      "Apply one action at a time and verify before the next.",
      "Stop and escalate when an expected signal does not match.",
      "Record timestamps, commands, and outputs for the postmortem.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Compare the actual timeline with the runbook's expected timings.",
      "Update every step that assumed a topology that no longer exists.",
      "Add the missing check or verification that would have caught the harm.",
      "Rehearse the corrected runbook and record the new timings.",
    ],
  },
];

const references = [
  {
    title: "Being On-Call",
    url: "https://sre.google/sre-book/being-on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "On-call responsibilities, operational load, and the role of documented procedures.",
  },
  {
    title: "What is a runbook?",
    url: "https://www.pagerduty.com/resources/learn/what-is-a-runbook/",
    publisher: "PagerDuty",
    kind: "docs" as const,
    note: "Runbook structure, ownership, and the difference from general documentation.",
  },
  {
    title: "On-Call",
    url: "https://sre.google/workbook/on-call/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "On-call practices, playbooks, and the operational cost of undocumented response.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    runbooks: {
      model: runbookModel,
      presets,
      instructions:
        "Start Healthy, then apply Stale runbook. Watch the topology check before the action, and the action before the verification. Correct one parameter at a time and re-run.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second represents one incident minute; drift and timing values are teaching assumptions, not provider guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-playbooks",
    "reliability-checklists",
    "reliability-oncall-handoff",
    "reliability-escalation",
  ],
};
