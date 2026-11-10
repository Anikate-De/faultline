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

const params: ParamSpec[] = [
  {
    id: "slo",
    label: "SLO target",
    min: 99,
    max: 99.99,
    step: 0.01,
    value: 99.9,
    unit: "%",
    group: "Objective",
    help: "The reliability target for the window. The error budget is the complement: 100 minus the SLO.",
    format: "number",
  },
  {
    id: "badEventsPer10k",
    label: "Bad events per 10,000",
    min: 1,
    max: 200,
    step: 1,
    value: 3,
    unit: " / 10k",
    group: "Burn",
    help: "Requests failing the SLI per 10,000. Three per 10,000 is 0.03%; 100 per 10,000 is 1%.",
    format: "count",
  },
  {
    id: "policyTrigger",
    label: "Policy trigger",
    min: 50,
    max: 100,
    step: 5,
    value: 75,
    unit: "% of budget",
    group: "Policy",
    help: "Budget consumed at which the pre-agreed consequence takes effect. A trigger at 100% acts only after the budget is gone.",
    format: "number",
  },
  {
    id: "exceptionRate",
    label: "Exception rate",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Policy",
    help: "Share of releases that continue after the trigger through an exception. Exceptions without an owner and expiry turn the policy into a suggestion.",
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
  slo: number;
  allowance: number;
  errorRate: number;
  burn: number;
  consumed: number;
  rawConsumed: number;
  shortfall: number;
  policyTrigger: number;
  exceptionRate: number;
  policyGap: number;
  elapsed: number;
}

function compute(p: Params, elapsed: number): Values {
  const slo = clamp(num(p, "slo", 99.9), 99, 99.99);
  const allowance = Math.max(0.01, 100 - slo);
  const badEvents = clamp(num(p, "badEventsPer10k", 3), 1, 200);
  const errorRate = badEvents / 100;
  const policyTrigger = clamp(num(p, "policyTrigger", 75), 50, 100);
  const exceptionRate = clamp(num(p, "exceptionRate", 10), 0, 100);
  const burn = errorRate / allowance;
  const progress = clamp(elapsed / WINDOW_SECONDS, 0, 1);
  const rawConsumed = burn * progress * 100;
  const consumed = clamp(rawConsumed, 0, 100);
  const shortfall = clamp(rawConsumed - 100, 0, 100);
  const policyGap = clamp(
    Math.max(0, rawConsumed - policyTrigger) * (exceptionRate / 100),
    0,
    100,
  );
  return {
    slo,
    allowance,
    errorRate,
    burn,
    consumed,
    rawConsumed,
    shortfall,
    policyTrigger,
    exceptionRate,
    policyGap,
    elapsed,
  };
}

function initialEvent(values: Values): SimFrame["events"][number] {
  return {
    id: "budget-window-open",
    at: 0,
    severity: "info",
    title: "Error budget window opens",
    detail: `SLO ${values.slo.toFixed(2)}%; allowance ${values.allowance.toFixed(2)} percentage points; policy trigger at ${values.policyTrigger.toFixed(0)}% of budget. The window is compressed to 60 simulated seconds.`,
  };
}

function buildFrame(p: Params, seed: number, elapsed: number, flags: SimFrame["flags"]): SimFrame {
  const values = compute(p, elapsed);
  const burnHealth = status(values.burn, 1, 2);
  const budgetHealth = status(values.consumed, 75, 100);
  const policyHealth = status(values.policyGap, 10, 25);
  const releaseHealth = values.policyGap >= 25 ? "crit" : values.policyGap >= 10 ? "warn" : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "sli",
        label: "SLI and error rate",
        kind: "service",
        health: burnHealth,
        utilization: clamp(values.burn / 4),
        sublabel: `${values.errorRate.toFixed(2)}% errors`,
        detail: `The SLO is ${values.slo.toFixed(2)}%, so the allowance is ${values.allowance.toFixed(2)} percentage points of failure. The current burn is ${values.burn.toFixed(1)} times the sustainable rate.`,
        meta: { view: "flow" },
      },
      {
        id: "budget",
        label: "Error budget",
        kind: "service",
        health: budgetHealth,
        utilization: values.consumed / 100,
        sublabel: `${values.consumed.toFixed(0)}% consumed`,
        detail: "The budget is a quantity, not a decision. It becomes useful when a policy says what happens at a given level of consumption.",
        meta: { view: "flow" },
      },
      {
        id: "policy",
        label: "Policy gate",
        kind: "service",
        health: policyHealth,
        utilization: clamp(values.policyGap / 100),
        sublabel: `trigger at ${values.policyTrigger.toFixed(0)}%`,
        detail: "The policy gate is the pre-agreed line. A gate that is crossed without a consequence is a dashboard, not a policy.",
        meta: { view: "flow" },
      },
      {
        id: "release",
        label: "Release train",
        kind: "service",
        health: releaseHealth,
        utilization: clamp(values.policyGap / 100),
        sublabel: `${values.exceptionRate.toFixed(0)}% exception rate`,
        detail: "An exception can be legitimate. It needs an approver, a reason, a time limit, and a record. An unrecorded exception is indistinguishable from ignoring the policy.",
        meta: { view: "flow" },
      },
      {
        id: "consequence",
        label: "Consequence",
        kind: "worker",
        health: policyHealth,
        utilization: clamp(values.policyGap / 100),
        sublabel: values.policyGap >= 10 ? "policy overrun" : "holding",
        detail: "The consequence is usually a freeze on non-essential changes, a reliability work period, or an escalation. It should be agreed before the budget is exhausted.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("sli-budget", "sli", "budget", values.burn / 4, burnHealth),
      edge("budget-policy", "budget", "policy", values.consumed / 100, budgetHealth),
      edge("policy-release", "policy", "release", 1 - values.policyGap / 100, policyHealth),
      edge("release-consequence", "release", "consequence", values.exceptionRate / 100, releaseHealth),
    ],
    metrics: [
      metric("budget-consumed", "Budget consumed", values.consumed, "%", 75, 100, "percent"),
      metric("burn-rate", "Burn rate", values.burn, "x", 1, 2, "number"),
      metric("budget-shortfall", "Budget shortfall", values.shortfall, "%", 10, 50, "percent"),
      metric("policy-gap", "Unenforced overrun", values.policyGap, "%", 10, 25, "percent"),
    ],
    events: [initialEvent(values)],
    series: {},
    flags: {
      ...flags,
      seed,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.consumed.toFixed(0)}% of budget consumed; burn ${values.burn.toFixed(1)}x; ${values.policyGap.toFixed(0)}% unenforced overrun.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const phase = seed % 8;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.92 + 0.1 * Math.sin((index + phase) / 3.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "budget-consumed",
    metricId: "budget-consumed",
    warn: 75,
    crit: 100,
    title: "The error budget is nearly or fully consumed",
    cause:
      "The service is failing more requests than the SLO allows. At the current rate, the budget will not last the window.",
    fix:
      "Apply the policy at its trigger: slow or stop non-essential changes, prioritize reliability work, and review the burn with the service owner. Do not wait for the last percent.",
    checkFirst: [
      "Check which errors dominate the SLI and when they started.",
      "Compare the current burn with the policy trigger.",
      "Check whether a recent change explains the burn.",
    ],
  },
  {
    id: "burn-rate",
    metricId: "burn-rate",
    warn: 1,
    crit: 2,
    title: "The service is burning budget faster than it earns it",
    cause:
      "A burn rate above 1 means the current error rate would exhaust the budget before the window closes. A burn above 2 doubles the sustainable rate.",
    fix:
      "Treat the burn as an early warning. Investigate the error source and apply the policy consequence before the budget is exhausted, not after.",
    checkFirst: [
      "Split burn rate by endpoint, dependency, and release.",
      "Check whether the burn is a short spike or a sustained rate.",
      "Check whether the policy has an early trigger below 100%.",
    ],
  },
  {
    id: "budget-shortfall",
    metricId: "budget-shortfall",
    warn: 10,
    crit: 50,
    title: "The budget is overspent",
    cause:
      "Consumption passed 100% of the allowance. The service has spent more failure than the SLO permits for this window.",
    fix:
      "Freeze non-essential changes, assign reliability work, and record the overrun. If the policy allows an exception, make it explicit and time-bound.",
    checkFirst: [
      "Check how far past 100% the budget is.",
      "Check whether the overrun came from one incident or sustained errors.",
      "Check whether the policy consequence was applied at the trigger.",
    ],
  },
  {
    id: "policy-gap",
    metricId: "policy-gap",
    warn: 10,
    crit: 25,
    title: "The policy trigger was crossed without a consequence",
    cause:
      "Budget consumed passed the policy trigger, but releases continued through exceptions or inaction. The policy exists on paper but is not changing decisions.",
    fix:
      "Either apply the consequence or record a real exception with an approver, a reason, and an expiry. A policy that is routinely waived is a signal that the trigger, the consequence, or the ownership is wrong.",
    checkFirst: [
      "Check which releases continued after the trigger and who approved them.",
      "Check whether the exception has an expiry and a follow-up.",
      "Check whether the policy owner has the authority to enforce the consequence.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const errorBudgetModel: SimModel = {
  id: "reliability-error-budget-policy",
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
    if (
      values.rawConsumed >= values.policyTrigger &&
      values.exceptionRate >= 50 &&
      frame.flags.budgetExceptionEvent !== 1
    ) {
      pushEvent(next, {
        id: "budget-exception-crossed",
        at: frame.t,
        severity: "crit",
        title: "Policy trigger crossed; releases continue",
        detail: `${values.rawConsumed.toFixed(0)}% of the budget is consumed against a ${values.policyTrigger.toFixed(0)}% trigger. ${values.exceptionRate.toFixed(0)}% of releases are modeled as continuing through an exception.`,
        nodeId: "release",
        metricId: "policy-gap",
      });
      next.flags.budgetExceptionEvent = 1;
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
      `Burn rate is ${values.burn.toFixed(1)}x against a ${values.slo.toFixed(2)}% SLO. The allowance is ${values.allowance.toFixed(2)} percentage points.`,
      `${values.consumed.toFixed(0)}% of the budget is consumed at ${(values.elapsed / WINDOW_SECONDS * 100).toFixed(0)}% through the window.`,
      `The policy trigger is ${values.policyTrigger.toFixed(0)}%; the unenforced overrun is ${values.policyGap.toFixed(0)}% at a ${values.exceptionRate.toFixed(0)}% exception rate.`,
      "A budget without a consequence is a measurement. A policy without an exception path is a ban that will be broken informally.",
    ];
  },
  legend: [
    { label: "Within budget", tone: "ok" },
    { label: "Trigger near", tone: "warn" },
    { label: "Budget spent", tone: "crit" },
    { label: "Policy ignored", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 99.9% SLO and a 0.03% error rate. The budget burns slowly and stays within policy.",
    tone: "ok",
    params: defaults({ slo: 99.9, badEventsPer10k: 3, policyTrigger: 75, exceptionRate: 10 }),
  },
  {
    id: "peak",
    label: "Burning",
    description: "A 0.09% error rate burns the budget faster than the window earns it. The trigger is close.",
    tone: "warn",
    params: defaults({ slo: 99.9, badEventsPer10k: 9, policyTrigger: 75, exceptionRate: 40 }),
  },
  {
    id: "failure",
    label: "Exhausted, no consequence",
    description: "A 1% error rate exhausts the budget. The trigger is at 100% and 90% of releases continue anyway.",
    tone: "crit",
    params: defaults({ slo: 99.9, badEventsPer10k: 100, policyTrigger: 100, exceptionRate: 90 }),
  },
  {
    id: "late-policy",
    label: "Late trigger",
    description: "The trigger exists but only at 100%. The service is already over budget before the policy applies.",
    tone: "crit",
    params: defaults({ slo: 99.9, badEventsPer10k: 20, policyTrigger: 100, exceptionRate: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "A 0.01% error rate, an early trigger, and almost no exceptions. The policy has room to act.",
    tone: "ok",
    params: defaults({ slo: 99.9, badEventsPer10k: 1, policyTrigger: 75, exceptionRate: 10 }),
  },
];

const experiment: Experiment = {
  id: "predict-policy-decision",
  title: "Predict what happens when the budget is gone",
  simId: "budget",
  question:
    "The budget crosses its policy trigger with a quarter of the window left. The roadmap says ship. What should the policy do?",
  prediction: {
    options: [
      { id: "pre-agreed", label: "Apply the pre-agreed consequence, with a named escalation for disagreement" },
      { id: "ship", label: "Ship, because the budget is advisory" },
      { id: "raise-slo", label: "Raise the SLO so the budget looks healthier" },
      { id: "ban", label: "Stop all releases indefinitely" },
    ],
    correctOptionId: "pre-agreed",
    explanation:
      "The value of a policy is that the decision was made before the pressure arrived. The trigger should name a consequence, and the policy should name who can grant a time-bound exception and who resolves disagreement. Shipping without a decision, or changing the target to create room, turns the budget back into a dashboard.",
  },
  setup: defaults({ slo: 99.9, badEventsPer10k: 20, policyTrigger: 75, exceptionRate: 80 }),
  runFor: 45,
  observe: [
    "Burn rate is 2x from the start, so the budget is spent well before the window closes.",
    "Budget consumed crosses the trigger and then 100% while releases continue.",
    "Unenforced overrun rises with the exception rate, not with the error rate alone.",
    "The policy gate is only as strong as the consequence and the escalation path behind it.",
  ],
  explain:
    "An error budget policy is a pre-agreed decision procedure: a trigger, a consequence, an exception path, an owner, and a review date. The trigger turns a number into an action. The exception path keeps the policy from becoming an absolute ban. The owner gives disagreement a place to resolve. Without all four, the budget can be measured perfectly and still change nothing.",
  fix: defaults({ slo: 99.9, badEventsPer10k: 3, policyTrigger: 75, exceptionRate: 10 }),
  debrief:
    "With an early trigger and rare exceptions, the budget stays within policy and the release train has a clear rule. The tradeoff is that a freeze delays roadmap work, and an exception process can become a rubber stamp if it has no owner or expiry. The policy is working when the hard conversation happens before the outage, not during it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An error budget is the amount of failure an SLO allows in a window. If the SLO is 99.9%, the budget is 0.1% of requests, or about 43 minutes of complete outage in a 30-day window. The budget makes reliability measurable, but it does not decide anything by itself.",
  },
  {
    type: "p",
    text: "An error budget policy is the pre-agreed answer to what happens when the budget is spent or burning too fast. It names a trigger, a consequence, an exception path, an owner, and a review date. The consequence is often a freeze on non-essential changes and a period of reliability work. The exception path matters because real businesses have deadlines; without it, the policy is either ignored or treated as an absolute ban.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The policy sits after the SLO and before release management. The SLI defines what is measured, the SLO sets the target, and the budget says how much failure is allowed. The policy connects that number to the release process, the incident review, and the planning cycle. It is the difference between knowing the budget is gone and changing what the team does next.",
  },
  {
    type: "table",
    headers: ["Without a policy", "With a policy"],
    rows: [
      ["The budget is a dashboard nobody owns", "A named owner reviews it on a cadence"],
      ["The freeze decision is made under pressure", "The trigger and consequence were agreed in advance"],
      ["Exceptions are informal and invisible", "Exceptions have an approver, a reason, and an expiry"],
      ["Disagreement escalates to whoever is loudest", "Disagreement follows a named escalation path"],
      ["The SLO is quietly relaxed after a bad month", "Changing the target requires the same review as the policy"],
    ],
  },
  {
    type: "p",
    text: "The 30-day window, 99.9% target, and budget percentages in this module are illustrative teaching values. They are not a recommendation for a particular service. The model compresses the window into 60 simulated seconds so the burn is visible.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Budget consumed: the share of the allowance spent so far in the window.",
      "Burn rate: how fast the budget is being spent relative to the sustainable rate. Above 1x, the budget will not last the window.",
      "Budget shortfall: how far past 100% the spend has gone.",
      "Unenforced overrun: the part of the overrun that crossed the policy trigger but continued through exceptions.",
      "A flow from the SLI through the budget and policy gate to the release train and its consequence.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and watch the budget accumulate. Apply Exhausted, no consequence, then compare it with Late trigger. Run the experiment before reading the explanation: decide what the policy should do when the roadmap disagrees, then restore the early trigger and low exception rate.",
  },
  { type: "sim", simId: "budget" },
  { type: "experiment", experimentId: "predict-policy-decision" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The service burned its budget faster than the window could earn it. The budget number crossed 100%, but the release train kept moving because the policy trigger was late and most releases had an exception. The failure was not arithmetic; it was the absence of a consequence that someone owned.",
  },
  {
    type: "p",
    text: "With an earlier trigger and a low exception rate, the policy had room to act before the budget was gone. The release train slowed, reliability work got priority, and the remaining budget became a planning input rather than a postmortem exhibit. The model is illustrative and deterministic; it shows the decision structure, not a forecast.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "SLI dashboards with the error budget and burn rate over the compliance window.",
      "Release records that show which changes shipped after the policy trigger.",
      "Exception tickets with an approver, a reason, a scope, and an expiry.",
      "A policy document with a named owner, a review date, and an escalation path for disagreement.",
      "Planning artifacts that reserve reliability work when the budget is exhausted.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the policy trigger and the last few releases that crossed it. If the releases continued, check whether a real exception was recorded or whether the policy was simply ignored. Then check who owns the decision and whether they have the authority to enforce it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the policy down: trigger, consequence, exception path, owner, and review date.",
      "Set the trigger before 100% of budget. A trigger at exhaustion leaves no room to act.",
      "Define the consequence as a specific change to the release process, not a vague warning.",
      "Define who can grant an exception, what evidence they need, and when it expires.",
      "Record every exception and review it at the next policy review.",
      "Name the escalation path for disagreement, including who decides if the product and reliability owners disagree.",
      "Revisit the SLO and the policy together; changing the target to avoid the consequence defeats the policy.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A freeze protects reliability but delays roadmap work. The policy should make that cost visible, not pretend it is free.",
      "An exception path prevents the policy from becoming an absolute ban, but a permissive exception process turns it into a rubber stamp.",
      "An early trigger preserves more budget but may slow releases that would not have caused harm.",
      "A strict policy can discourage teams from reporting errors accurately. The measure must not punish honesty.",
      "Every policy needs a review date; a target that never changes is as suspect as one that changes after every bad month.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "policy-contents",
    question: "What must an error budget policy contain to be useful?",
    difficulty: 2,
    hints: [
      "A number alone does not decide anything.",
      "Think about disagreement and exceptions before they happen.",
    ],
    answer:
      "It needs a trigger, a consequence, an exception path, a named owner, and a review date. The trigger says when the policy applies. The consequence says what changes, such as a freeze on non-essential releases and a reliability work period. The exception path says who can grant one, with what evidence, and for how long. The owner has the authority to enforce it, and the review date keeps the policy from going stale. The document should also name the escalation path if stakeholders disagree about whether the consequence applies.",
    followUps: [
      "Where should the trigger sit?",
      "Who should own the policy?",
      "How do you handle an exception that outlives its expiry?",
    ],
    redFlags: [
      "Describes only the budget calculation.",
      "Has no exception path.",
      "Names no owner or escalation.",
    ],
    rubric: [
      "Names trigger and consequence.",
      "Includes exception and expiry.",
      "Names owner and escalation.",
      "Includes a review cadence.",
    ],
  },
  {
    id: "ship-vs-freeze",
    question: "The budget is exhausted and the roadmap says ship. Who decides, and how?",
    difficulty: 3,
    hints: [
      "The decision should have been made before the pressure arrived.",
      "An exception is a decision with a record, not a silent override.",
    ],
    answer:
      "The policy owner decides under the pre-agreed rule, not whoever is loudest in the release meeting. If the policy says freeze, the default is freeze. If the product owner believes an exception is warranted, they take it to the named approver with the reason, the scope, the risk, and an expiry. The decision is recorded and reviewed. If the policy itself is wrong, that is a separate conversation after the release, not a reason to ignore it in the moment.",
    followUps: [
      "What if the policy owner is unavailable?",
      "What evidence should an exception require?",
      "How do you avoid a freeze that lasts forever?",
    ],
    redFlags: [
      "Lets the loudest stakeholder decide.",
      "Treats the budget as advisory.",
      "Grants an exception with no expiry.",
    ],
    rubric: [
      "Names the pre-agreed owner.",
      "Keeps freeze as the default.",
      "Requires a recorded exception.",
      "Separates policy review from the release decision.",
    ],
  },
  {
    id: "legitimate-exception",
    question: "When is an error budget exception legitimate?",
    difficulty: 3,
    hints: [
      "Legitimacy comes from the process, not the urgency.",
      "An exception should be bounded and visible.",
    ],
    answer:
      "An exception is legitimate when it is made by the person the policy names, for a specific release or scope, with the risk stated, a time limit, and a follow-up. It is not legitimate when it is granted silently, extended indefinitely, or used to avoid the reliability work the budget was meant to fund. A good exception also names what would make the team stop, and it is reviewed like any other risk decision.",
    followUps: [
      "What makes an exception a rubber stamp?",
      "Should exceptions count against the next window?",
      "How do you communicate an exception to customers or support?",
    ],
    redFlags: [
      "Any exception is fine if the deadline is important.",
      "The exception has no owner or expiry.",
      "The exception is not recorded.",
    ],
    rubric: [
      "Names approver and scope.",
      "Requires risk and expiry.",
      "Has a follow-up.",
      "Distinguishes exception from policy change.",
    ],
  },
  {
    id: "burn-alert",
    question: "How do burn-rate alerts relate to the policy trigger?",
    difficulty: 3,
    hints: [
      "A burn alert is an early signal, not the consequence.",
      "Multiple windows catch different shapes of failure.",
    ],
    answer:
      "Burn-rate alerts tell the team that the budget is being consumed faster than the window can sustain. They should fire before the policy trigger so the team has time to investigate and act. The policy trigger is the point where the pre-agreed consequence applies. A fast burn over a short window catches a sharp incident; a slow burn over a long window catches sustained errors that a short window would miss. The policy should say which alert leads to which action, so the team is not deciding under pressure.",
    followUps: [
      "Why use more than one burn window?",
      "What should happen when a fast burn resolves before the policy trigger?",
      "How do you avoid alerting on every minor burn?",
    ],
    redFlags: [
      "Treats the burn alert as the consequence.",
      "Uses one window for every failure shape.",
      "Waits for 100% budget before acting.",
    ],
    rubric: [
      "Separates alert from consequence.",
      "Explains multiple windows.",
      "Acts before exhaustion.",
      "Connects alert to policy action.",
    ],
  },
];

const checklist = [
  {
    title: "Write the policy",
    items: [
      "The trigger is a specific budget percentage below 100%.",
      "The consequence names what changes in the release process.",
      "An exception has an approver, a reason, a scope, and an expiry.",
      "The policy names an owner and an escalation path for disagreement.",
      "The policy has a review date and a place to record changes.",
    ],
  },
  {
    title: "Operate it",
    items: [
      "Burn-rate alerts fire before the policy trigger.",
      "The budget and burn rate are visible to product and engineering together.",
      "Exceptions are recorded and reviewed on a cadence.",
      "Reliability work is planned when the budget is exhausted, not after the next incident.",
      "The team can explain the consequence without rereading the document.",
    ],
  },
  {
    title: "Review it",
    items: [
      "Check whether the trigger gave enough time to act.",
      "Check whether exceptions were real decisions or rubber stamps.",
      "Check whether the SLO still matches user expectations.",
      "Change the policy in a review, not in the middle of a release dispute.",
    ],
  },
];

const references = [
  {
    title: "Implementing SLOs",
    url: "https://sre.google/workbook/implementing-slos/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Error budget policy contents, freeze, exceptions, and the escalation path for disagreement.",
  },
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE",
    kind: "book" as const,
    note: "Burn-rate windows, precision and recall, and paging on significant budget consumption.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    budget: {
      model: errorBudgetModel,
      presets,
      instructions:
        "Start healthy and watch the budget accumulate. Compare Exhausted, no consequence with Late trigger, then restore an early trigger and a low exception rate.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 30-day window and budget thresholds are teaching values, not a recommended SLO.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-sli-slo-error-budget",
    "reliability-game-days",
    "reliability-severity-levels",
    "deployment-canary",
    "reliability-incident-command",
  ],
};
