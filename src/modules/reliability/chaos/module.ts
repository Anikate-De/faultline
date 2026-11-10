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

const WINDOW_SECONDS = 60;
const FAULT_START = 10;

const params: ParamSpec[] = [
  {
    id: "blastRadius",
    label: "Blast radius",
    min: 1,
    max: 100,
    step: 1,
    value: 3,
    unit: "% of traffic",
    group: "Scope",
    help: "Share of traffic exposed to the injected fault. Start small; the goal is to learn, not to maximize impact.",
    format: "percent",
  },
  {
    id: "failoverCoverage",
    label: "Failover coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 98,
    unit: "%",
    group: "Assumption",
    help: "Share of affected traffic that actually fails over to a healthy path. Redundant instances do not help if traffic never reaches them.",
    format: "percent",
  },
  {
    id: "observability",
    label: "Observability",
    min: 0,
    max: 100,
    step: 5,
    value: 95,
    unit: "%",
    group: "Safety",
    help: "How well the experiment's effect is visible in metrics, logs, and traces. A stop condition is only as good as the signal behind it.",
    format: "percent",
  },
  {
    id: "stopThreshold",
    label: "Stop threshold",
    min: 1,
    max: 20,
    step: 1,
    value: 2,
    unit: "% errors",
    group: "Safety",
    help: "Error rate at which the experiment should abort. A lower threshold stops sooner; a higher one learns more at greater risk.",
    format: "number",
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
  blast: number;
  failover: number;
  observability: number;
  stopThreshold: number;
  hasStop: boolean;
  abortAfter: number;
  experimentEnd: number;
  active: boolean;
  errorRate: number;
  impactDuration: number;
  unexpected: number;
  detectionGap: number;
}

function compute(p: Params, elapsed: number): Values {
  const blast = clamp(num(p, "blastRadius", 3), 1, 100);
  const failover = clamp(num(p, "failoverCoverage", 98), 0, 100);
  const observability = clamp(num(p, "observability", 95), 0, 100);
  const stopThreshold = clamp(num(p, "stopThreshold", 2), 1, 20);
  const hasStop = observability >= 40;
  const abortAfter = hasStop
    ? 2 + (100 - observability) * 0.08 + (stopThreshold - 1) * 0.3
    : WINDOW_SECONDS - FAULT_START;
  const experimentEnd = FAULT_START + abortAfter;
  const active = elapsed >= FAULT_START && (elapsed < experimentEnd || !hasStop);
  const peakError = blast * (1 - failover / 100);
  const errorRate = active ? peakError : 0;
  const impactDuration = clamp(elapsed - FAULT_START, 0, abortAfter);
  const unexpected = clamp(peakError * impactDuration * 2, 0, 100);
  const detectionGap = 100 - observability;
  return {
    blast,
    failover,
    observability,
    stopThreshold,
    hasStop,
    abortAfter,
    experimentEnd,
    active,
    errorRate,
    impactDuration,
    unexpected,
    detectionGap,
  };
}

function initialEvent(values: Values): SimFrame["events"][number] {
  return {
    id: "chaos-experiment-armed",
    at: 0,
    severity: "info",
    title: "Chaos experiment armed",
    detail: `Scope: ${values.blast.toFixed(0)}% of traffic. Failover coverage: ${values.failover.toFixed(0)}%. The fault is injected after a short baseline. Values are illustrative.`,
  };
}

function buildFrame(p: Params, seed: number, elapsed: number, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, elapsed);
  const errorHealth = status(values.errorRate, 1, 5);
  const fallbackHealth = status(100 - values.failover, 20, 40);
  const stopHealth = status(values.detectionGap, 10, 25);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "service",
        label: "Service",
        kind: "service",
        health: errorHealth,
        utilization: clamp(values.errorRate / 100),
        sublabel: values.active ? `${values.errorRate.toFixed(1)}% errors` : "before fault",
        detail: "The service is the system under test. Its steady state is the baseline the experiment compares against.",
        meta: { view: "flow" },
      },
      {
        id: "dependency",
        label: "Dependency",
        kind: "external",
        health: errorHealth,
        utilization: clamp(values.errorRate / 100),
        sublabel: values.active ? "fault active" : "nominal",
        detail: "The injected fault affects this dependency or the path to it. The experiment is testing what the service does when that path degrades.",
        meta: { view: "flow" },
      },
      {
        id: "injector",
        label: "Fault injector",
        kind: "service",
        health: values.active ? "warn" : "ok",
        utilization: values.active ? clamp(values.blast / 100) : 0,
        sublabel: values.active ? "injecting" : "armed",
        detail: "The injector is a controlled tool with a scope, a duration, and an abort path. It is not an engineer breaking things by hand.",
        meta: { view: "flow" },
      },
      {
        id: "fallback",
        label: "Failover path",
        kind: "service",
        health: fallbackHealth,
        utilization: clamp((100 - values.failover) / 100),
        sublabel: `${values.failover.toFixed(0)}% covered`,
        detail: "Redundancy is an assumption until traffic actually reaches the healthy path. The experiment tests the routing, not the inventory.",
        meta: { view: "flow" },
      },
      {
        id: "stop",
        label: "Stop condition",
        kind: "service",
        health: stopHealth,
        utilization: clamp(values.detectionGap / 100),
        sublabel: values.hasStop ? `abort at ${values.abortAfter.toFixed(1)} min` : "not observable",
        detail: "A stop condition needs a signal, a threshold, and an owner who can abort. If the effect is not observable, the experiment has no effective stop.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("service-dependency", "service", "dependency", 1 - values.errorRate / 100, errorHealth),
      edge("injector-dependency", "injector", "dependency", values.active ? values.blast / 100 : 0, values.active ? "warn" : "ok"),
      edge("service-fallback", "service", "fallback", values.failover / 100, fallbackHealth),
      edge("service-stop", "service", "stop", 1 - values.detectionGap / 100, stopHealth),
    ],
    metrics: [
      metric("blast-radius", "Blast radius", values.blast, "%", 20, 50, "percent"),
      metric("error-rate", "Error rate", values.errorRate, "%", 1, 5, "percent"),
      metric("abort-latency", "Abort latency", values.abortAfter, " min", 4, 8, "number"),
      metric("unexpected-impact", "Unexpected impact", values.unexpected, "%", 10, 30, "percent"),
      metric("detection-gap", "Detection gap", values.detectionGap, "%", 10, 25, "percent"),
    ],
    events: [initialEvent(values)],
    series: {},
    flags: {
      ...flags,
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.blast.toFixed(0)}% blast radius; ${values.errorRate.toFixed(1)}% errors${values.active ? "" : " (fault inactive)"}; unexpected impact ${values.unexpected.toFixed(0)}%.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 12;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.95 + 0.08 * Math.sin((index + phase) / 3.5))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "blast-radius",
    metricId: "blast-radius",
    warn: 20,
    crit: 50,
    title: "The experiment blast radius is too large",
    cause:
      "Too much traffic or too many failure domains are exposed to the injected fault. A large blast radius turns a learning exercise into an outage.",
    fix:
      "Reduce the exposed traffic or the number of targets. Start with a small canary group, one dependency, or a staging environment. Increase only after the hypothesis survives.",
    checkFirst: [
      "Check exactly which traffic and which instances are in scope.",
      "Check whether the fault can affect shared dependencies or data.",
      "Check whether the stop condition covers the whole blast radius.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The injected fault is causing customer errors",
    cause:
      "The service did not absorb the fault as the hypothesis predicted. Either the failover path is not working, or the fault is reaching more traffic than intended.",
    fix:
      "Abort the experiment if the stop condition is met, restore the dependency, and verify recovery. Treat the gap as the finding, then fix the failover before running the experiment again.",
    checkFirst: [
      "Check whether the error rate is above the stop threshold.",
      "Check whether traffic reached the failover path.",
      "Check whether the fault is affecting more than the declared blast radius.",
    ],
  },
  {
    id: "abort-latency",
    metricId: "abort-latency",
    warn: 4,
    crit: 8,
    title: "The experiment would run too long before aborting",
    cause:
      "A weak signal or a loose stop threshold delays the abort. The longer the fault runs, the more traffic is exposed and the harder recovery becomes.",
    fix:
      "Tighten the stop threshold, improve the observability of the effect, and give one person explicit authority to abort. Test the abort path before the experiment.",
    checkFirst: [
      "Check whether the stop signal is visible in real time.",
      "Check who can abort and whether they are watching.",
      "Check whether the threshold is measured on the right metric.",
    ],
  },
  {
    id: "unexpected-impact",
    metricId: "unexpected-impact",
    warn: 10,
    crit: 30,
    title: "The fault found impact the design did not anticipate",
    cause:
      "The service depends on a path that was not covered by the failover assumption. The experiment has found the gap the design missed.",
    fix:
      "Stop, restore, and write the finding as a hypothesis with evidence. Fix the dependency or the fallback, then run a smaller experiment to verify the fix.",
    checkFirst: [
      "Identify which calls or jobs took the unexpected path.",
      "Check whether the failover was tested at this scale and traffic mix.",
      "Check whether a shared resource or retry amplified the impact.",
    ],
  },
  {
    id: "detection-gap",
    metricId: "detection-gap",
    warn: 10,
    crit: 25,
    title: "The experiment's effect is not observable enough",
    cause:
      "If the team cannot see the fault's effect, the stop condition is a guess. Observability is a safety requirement for chaos, not a reporting detail.",
    fix:
      "Add metrics, logs, or traces that show the effect before injecting the fault. Rehearse the stop condition with a dry run and confirm that the signal reaches the person who can abort.",
    checkFirst: [
      "Check whether the effect appears in a dashboard in real time.",
      "Check whether the alert reaches the experiment owner.",
      "Check whether the logs distinguish the injected fault from background errors.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const chaosModel: SimModel = {
  id: "reliability-chaos",
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
    if (frame.t >= FAULT_START && frame.flags.chaosInjected !== 1) {
      pushEvent(next, {
        id: "chaos-fault-injected",
        at: frame.t,
        severity: "warn",
        title: "Fault injected",
        detail: `The dependency fault is active across ${values.blast.toFixed(0)}% of traffic. Expected failover coverage is ${values.failover.toFixed(0)}%.`,
        nodeId: "dependency",
        metricId: "error-rate",
      });
      next.flags.chaosInjected = 1;
    }
    if (
      values.hasStop &&
      values.experimentEnd <= WINDOW_SECONDS &&
      frame.t >= values.experimentEnd &&
      frame.t <= WINDOW_SECONDS &&
      frame.flags.chaosStopped !== 1
    ) {
      pushEvent(next, {
        id: "chaos-stop-condition-met",
        at: frame.t,
        severity: "info",
        title: "Stop condition met",
        detail: `The experiment aborted after ${Math.max(0, frame.t - FAULT_START).toFixed(1)} minutes. The fault is removed and recovery should be verified.`,
        nodeId: "stop",
        metricId: "abort-latency",
      });
      next.flags.chaosStopped = 1;
    }
    if (!values.hasStop && frame.t >= 50 && frame.flags.chaosNoStopEvent !== 1) {
      pushEvent(next, {
        id: "chaos-no-stop",
        at: frame.t,
        severity: "crit",
        title: "The experiment has no effective stop",
        detail: "Observability is too low to see the effect. The stop condition cannot be met reliably, so the fault is still running at the end of the window.",
        nodeId: "stop",
        metricId: "detection-gap",
      });
      next.flags.chaosNoStopEvent = 1;
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
    const peakError = values.blast * (1 - values.failover / 100);
    return [
      `The experiment exposes ${values.blast.toFixed(0)}% of traffic. Failover coverage is ${values.failover.toFixed(0)}%, so the modeled peak error rate while the fault is active is ${peakError.toFixed(1)}%.${values.active ? "" : " The fault is not active at this point."}`,
      `Observability is ${values.observability.toFixed(0)}% and the detection gap is ${values.detectionGap.toFixed(0)}%. ${values.hasStop ? `The modeled abort is after ${values.abortAfter.toFixed(1)} minutes.` : "No reliable stop was observed in the window."}`,
      `Unexpected impact is ${values.unexpected.toFixed(0)}%. It grows with error rate and with the time before abort.`,
      "A chaos experiment tests a hypothesis about behavior. It is not a random failure and it is not a substitute for a game day's rehearsal of the response.",
    ];
  },
  legend: [
    { label: "Within scope", tone: "ok" },
    { label: "Blast radius rising", tone: "warn" },
    { label: "Unexpected impact", tone: "crit" },
    { label: "No stop signal", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 3% canary, almost full failover coverage, strong observability, and a tight stop threshold.",
    tone: "ok",
    params: defaults({ blastRadius: 3, failoverCoverage: 98, observability: 95, stopThreshold: 2 }),
  },
  {
    id: "peak",
    label: "Wide but bounded",
    description: "A 25% blast radius and partial failover. The experiment warns on scope, latency, and impact but stops.",
    tone: "warn",
    params: defaults({ blastRadius: 25, failoverCoverage: 90, observability: 85, stopThreshold: 5 }),
  },
  {
    id: "failure",
    label: "Untested dependency",
    description: "An 80% blast radius, weak failover, and poor observability. The stop condition is never reliably met.",
    tone: "crit",
    params: defaults({ blastRadius: 80, failoverCoverage: 20, observability: 30, stopThreshold: 10 }),
  },
  {
    id: "blind",
    label: "Blind experiment",
    description: "Moderate blast radius but almost no visibility into the effect. The fault runs without an effective stop.",
    tone: "crit",
    params: defaults({ blastRadius: 40, failoverCoverage: 70, observability: 25, stopThreshold: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 2% canary, full failover, complete observability, and an immediate stop threshold.",
    tone: "ok",
    params: defaults({ blastRadius: 2, failoverCoverage: 100, observability: 100, stopThreshold: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-chaos-gap",
  title: "Predict what the experiment finds",
  simId: "chaos",
  question:
    "A dependency failure takes down the service even though three replicas are running. What should the first chaos experiment test?",
  prediction: {
    options: [
      { id: "failover", label: "Whether traffic actually fails over to a healthy path" },
      { id: "instance-type", label: "Whether the replicas use the newest instance type" },
      { id: "restart", label: "Whether the on-call can restart the service by hand" },
      { id: "dashboard", label: "Whether the dashboard shows replica count" },
    ],
    correctOptionId: "failover",
    explanation:
      "Three replicas are an inventory fact, not proof of redundancy. The hypothesis is that the service remains within its steady state when one dependency path fails. The experiment must exercise the routing and failover path with a bounded blast radius, a stop condition, and enough observability to see whether traffic moved.",
  },
  setup: defaults({ blastRadius: 60, failoverCoverage: 50, observability: 50, stopThreshold: 10 }),
  runFor: 45,
  observe: [
    "The blast radius is critical before the fault is injected.",
    "Observability is only 50%, so the abort is delayed and the unexpected impact grows.",
    "The error rate crosses the critical threshold when the fault becomes active.",
    "The finding is the failover gap, not the existence of the replicas.",
  ],
  explain:
    "Chaos engineering tests a specific hypothesis with a controlled fault. A useful experiment names the steady state, the expected behavior, the scope, the stop condition, and the evidence that would confirm or refute the hypothesis. The blast radius limits the cost of being wrong. Observability makes the stop condition real. Without both, the experiment is just an outage with a name.",
  fix: defaults({ blastRadius: 10, failoverCoverage: 95, observability: 95, stopThreshold: 2 }),
  debrief:
    "With a small canary, tested failover, and a tight stop, the same hypothesis is tested at a fraction of the impact. The tradeoff is coverage: a 10% canary may not exercise every path, so the experiment must be repeated or widened after the small run succeeds. That is the disciplined version of learning from failure.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Chaos engineering is the practice of testing a system's behavior under controlled failure. The experiment starts with a hypothesis about steady state: for example, when one dependency path fails, the service keeps serving requests through the healthy path. The team injects a specific fault, observes whether the hypothesis holds, and aborts if the impact exceeds the agreed limit.",
  },
  {
    type: "p",
    text: "The discipline is in the constraints. A chaos experiment has a narrow hypothesis, a bounded blast radius, a stop condition, and observability that shows the effect in real time. It is not random failure injection and it is not a game day. A game day rehearses the human response to a scenario. A chaos experiment tests a technical assumption with evidence.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Chaos sits after the team has incident response, observability, and a way to stop the experiment. It is usually run in staging first, then in production with a small canary and a named abort authority. The prerequisite game day is about people and process. Chaos is about the system's behavior when a dependency, zone, or network path fails.",
  },
  {
    type: "table",
    headers: ["Practice", "Question it answers", "Typical scope"],
    rows: [
      ["Load test", "How does the system behave at this demand?", "A representative traffic profile"],
      ["Game day", "Can the team coordinate a response?", "A scenario with injects and roles"],
      ["Chaos experiment", "Does this specific failure assumption hold?", "One fault, one hypothesis, a bounded scope"],
      ["Disaster recovery drill", "Can we restore service from a major loss?", "A full failover or restore procedure"],
    ],
  },
  {
    type: "p",
    text: "The percentages, timings, and thresholds in this module are illustrative. They are not AWS Fault Injection Service limits or a recommendation for a production experiment. The model compresses the experiment into 60 simulated seconds.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Blast radius: the share of traffic exposed to the fault.",
      "Error rate: the modeled customer impact once the fault is active.",
      "Abort latency: modeled minutes before the stop condition removes the fault.",
      "Unexpected impact: the cumulative effect on paths the design assumed were covered.",
      "Detection gap: how much of the effect is invisible, which limits the stop condition.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note the small blast radius and early abort. Apply Untested dependency, then Blind experiment: the second shows that a stop condition without observability is not a stop. Run the experiment before reading the explanation, then restore the canary and stop threshold.",
  },
  { type: "sim", simId: "chaos" },
  { type: "experiment", experimentId: "predict-chaos-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fault was injected into a path the design assumed was redundant. The service did not fail over as expected, so errors rose and the unexpected-impact metric accumulated. In the failure case, observability was too low to meet the stop condition reliably, so the fault kept running and the experiment became indistinguishable from an incident.",
  },
  {
    type: "p",
    text: "With a small canary and a visible stop signal, the same hypothesis was tested at a fraction of the blast radius. The experiment still found the failover gap, but it stopped before the impact became an outage. That is the point: learn the same lesson with a smaller bill.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "An experiment record with the hypothesis, steady-state metrics, scope, duration, stop condition, and abort owner.",
      "Traffic and error metrics split by the experiment's canary or target group.",
      "Dependency latency and error rates, plus the failover path's request share.",
      "Logs and traces that distinguish the injected fault from background errors.",
      "A rollback or restore step that is tested before the experiment starts.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the blast radius, the stop condition, and whether the effect is visible in real time. If the stop condition depends on a signal nobody is watching, the experiment is not safe yet. Then check whether traffic actually reached the failover path.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the hypothesis and the steady-state signal before choosing a tool.",
      "Start with the smallest blast radius that can test the hypothesis.",
      "Define the stop condition, the abort owner, and the rollback before the experiment.",
      "Verify that the effect is observable in real time and reaches the abort owner.",
      "Run in staging or a canary group first; widen only after the hypothesis survives.",
      "Abort on the stop condition, restore the dependency, and verify recovery.",
      "Write the finding with evidence and turn it into a fix and a follow-up experiment.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A small blast radius is safer but may not exercise every path. Coverage and safety pull in opposite directions.",
      "A tight stop threshold protects customers but can abort before the experiment produces a useful signal.",
      "Production experiments are more realistic but carry real customer risk; staging is safer but may not reproduce production routing.",
      "Observability costs engineering time, but an experiment without it cannot have a real stop condition.",
      "Finding a gap is not the same as fixing it. The experiment is only valuable if the finding becomes a change and a retest.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "chaos-vs-breaking",
    question: "What makes a chaos experiment different from breaking things in production?",
    difficulty: 2,
    hints: [
      "Start with a hypothesis, not a tool.",
      "The constraints are part of the experiment.",
    ],
    answer:
      "A chaos experiment starts with a specific hypothesis about steady-state behavior and a prediction of what should happen under a defined fault. It has a bounded blast radius, a stop condition, observability that shows the effect, and an owner who can abort. Breaking things has none of those. The experiment is designed so that being wrong produces evidence and a bounded cost, not an unplanned outage.",
    followUps: [
      "What is a steady-state metric?",
      "When would you run it in staging instead of production?",
      "What makes an experiment inconclusive?",
    ],
    redFlags: [
      "Starts with a tool.",
      "Has no stop condition.",
      "Treats the outage as the experiment.",
    ],
    rubric: [
      "Requires a hypothesis.",
      "Names blast radius and stop condition.",
      "Includes observability.",
      "Distinguishes evidence from disruption.",
    ],
  },
  {
    id: "blast-and-stop",
    question: "How do you choose a blast radius and a stop condition for a production experiment?",
    difficulty: 3,
    hints: [
      "Start with the smallest scope that can test the hypothesis.",
      "A stop condition needs a signal and an owner.",
    ],
    answer:
      "I choose the smallest scope that can still exercise the behavior: one canary, one dependency, one zone, or a small traffic percentage. The stop condition is a metric threshold that is visible in real time, tied to customer impact, with a named owner and an abort action. I also define a maximum duration and a rollback. Then I verify the signal and the abort path before the experiment. If the signal is not observable, the stop condition is not real.",
    followUps: [
      "What would make you widen the scope?",
      "How do you test the abort path?",
      "What if the experiment owner is also the on-call?",
    ],
    redFlags: [
      "Chooses scope by convenience.",
      "Has a threshold but no owner.",
      "Does not test the abort path.",
    ],
    rubric: [
      "Starts with the smallest scope.",
      "Names a real-time signal.",
      "Assigns an abort owner.",
      "Verifies rollback and duration.",
    ],
  },
  {
    id: "unexpected-dependency",
    question: "The experiment reveals an untested dependency and causes customer errors. What do you do next?",
    difficulty: 3,
    hints: [
      "First stop the experiment and restore service.",
      "Then preserve the evidence and decide whether the fix is the dependency or the fallback.",
    ],
    answer:
      "I abort on the stop condition, restore the dependency, and verify recovery before doing anything else. Then I preserve the timeline and evidence: which calls took the unexpected path, how traffic was routed, and why the failover did not cover them. I write the finding as a hypothesis and decide whether to fix the dependency, add a fallback, or change the routing. I do not rerun the experiment until the fix is deployed and the stop condition is verified.",
    followUps: [
      "Who needs to be told about the finding?",
      "How do you prevent the same experiment from causing the same outage?",
      "When would you decide not to fix the dependency?",
    ],
    redFlags: [
      "Keeps the experiment running to learn more.",
      "Starts a fix before restoring service.",
      "Reruns without verifying the stop condition.",
    ],
    rubric: [
      "Aborts and restores first.",
      "Preserves evidence.",
      "Turns the finding into a hypothesis.",
      "Retests after the fix.",
    ],
  },
  {
    id: "production-or-staging",
    question: "Would you run a chaos experiment in production or staging?",
    difficulty: 2,
    hints: [
      "The answer depends on the hypothesis and the safety controls.",
      "Staging often differs from production in ways that matter.",
    ],
    answer:
      "I start in staging when the hypothesis is new, the blast radius is unclear, or the abort path is untested. I move to production with a small canary when the hypothesis depends on real traffic, real routing, or real dependency behavior that staging cannot reproduce. Production experiments need stronger controls: a narrow scope, a real-time stop signal, an abort owner, and a rollback. Neither environment is automatically correct; the choice follows the hypothesis and the cost of being wrong.",
    followUps: [
      "What can staging never reproduce?",
      "What controls would you require before a production experiment?",
      "How do you communicate a production experiment to support and customers?",
    ],
    redFlags: [
      "Says production is always best.",
      "Says staging is always safe.",
      "Runs without an abort owner.",
    ],
    rubric: [
      "Ties environment to hypothesis.",
      "Names staging limits.",
      "Requires production controls.",
      "Considers communication.",
    ],
  },
];

const checklist = [
  {
    title: "Design",
    items: [
      "The hypothesis names the steady state and the expected behavior.",
      "The experiment targets one fault or one dependency path.",
      "The blast radius is the smallest scope that can test the hypothesis.",
      "The stop condition has a real-time signal, a threshold, and an abort owner.",
      "The rollback or restore step is documented and tested.",
    ],
  },
  {
    title: "Run",
    items: [
      "The experiment owner can abort without asking for permission.",
      "The effect is visible in metrics, logs, or traces in real time.",
      "The actual blast radius matches the declared scope.",
      "Customer impact stays below the stop threshold.",
      "The experiment stops at the maximum duration even if the signal is quiet.",
    ],
  },
  {
    title: "Learn",
    items: [
      "The finding is recorded with evidence, not just a conclusion.",
      "The unexpected dependency or routing gap has an owner.",
      "The fix is deployed before the experiment is repeated.",
      "The follow-up experiment is smaller or more targeted than the first.",
      "The result is shared with the teams that own the affected path.",
    ],
  },
];

const references = [
  {
    title: "Principles of Chaos Engineering",
    url: "https://principlesofchaos.org/",
    publisher: "Chaos Community",
    kind: "docs" as const,
    note: "Steady-state hypothesis, controlled experiments, and minimizing blast radius.",
  },
  {
    title: "What is AWS Fault Injection Service?",
    url: "https://docs.aws.amazon.com/fis/latest/userguide/what-is.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Managed fault injection, experiment templates, stop conditions, and targeting.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    chaos: {
      model: chaosModel,
      presets,
      instructions:
        "Start healthy and note the abort latency. Apply Untested dependency, then Blind experiment. Run the experiment before restoring the canary and stop threshold.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Blast radius, abort timing, and impact values are teaching values, not AWS FIS behavior.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "reliability-game-days",
    "reliability-error-budget-policy",
    "reliability-incident-command",
    "foundations-circuit-breaking",
    "foundations-bulkheads",
  ],
};
