import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DAYS_PER_SECOND = 0.5;
const SECONDS_PER_DAY = 86_400;

const params: ParamSpec[] = [
  {
    id: "windowDays",
    label: "Compliance window",
    min: 7,
    max: 90,
    step: 1,
    value: 30,
    unit: " days",
    group: "SLO",
    help: "The period over which the SLO is evaluated. A rolling window moves; a calendar window resets.",
    format: "count",
  },
  {
    id: "sloPercent",
    label: "SLO target",
    min: 99,
    max: 99.99,
    step: 0.01,
    value: 99.9,
    unit: "%",
    group: "SLO",
    help: "The share of valid events that must be good. The gap to 100% is the error budget.",
    format: "percent",
  },
  {
    id: "trafficRps",
    label: "Valid request rate",
    min: 1_000,
    max: 50_000,
    step: 1_000,
    value: 10_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests counted as valid SLI events. Traffic does not change the budget percentage by itself.",
    format: "rps",
  },
  {
    id: "errorRatePct",
    label: "Bad event rate",
    min: 0,
    max: 3,
    step: 0.01,
    value: 0.03,
    unit: "%",
    group: "Traffic",
    help: "Requests that fail the SLI. Compare this with 100% minus the SLO target.",
    format: "percent",
  },
  {
    id: "burnWindowHours",
    label: "Burn-rate lookback",
    min: 1,
    max: 24,
    step: 1,
    value: 6,
    unit: " h",
    group: "Alerting",
    help: "The lookback used to smooth observed burn. Short windows alert fast; long windows suppress spikes.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface BudgetState {
  elapsedDays: number;
  consumedFrac: number;
  observedBurn: number;
}

interface Computed {
  windowDays: number;
  sloPct: number;
  allowedPct: number;
  trafficRps: number;
  errorPct: number;
  burn: number;
  observedBurn: number;
  elapsedDays: number;
  consumedFrac: number;
  remainingPct: number;
  remainingRequests: number;
  projectedBurn: number;
  windowProgress: number;
  burnWindowHours: number;
}

function readState(frame: SimFrame): BudgetState {
  return {
    elapsedDays: Math.max(0, Number(frame.flags.elapsedDays ?? 0)),
    consumedFrac: Math.max(0, Number(frame.flags.consumedFrac ?? 0)),
    observedBurn: Math.max(0, Number(frame.flags.observedBurn ?? 0)),
  };
}

function compute(p: Params, state: BudgetState): Computed {
  const windowDays = Math.round(num(p, "windowDays", 30));
  const sloPct = num(p, "sloPercent", 99.9);
  const allowedPct = Math.max(0.0001, 100 - sloPct);
  const trafficRps = num(p, "trafficRps", 10_000);
  const errorPct = num(p, "errorRatePct", 0.03);
  const burn = errorPct / allowedPct;
  const observedBurn = state.observedBurn > 0 ? state.observedBurn : burn;
  const consumedFrac = Math.min(1.5, state.consumedFrac);
  const remainingPct = clamp(1 - consumedFrac) * 100;
  const allowedPerDay = (allowedPct / 100) * trafficRps * SECONDS_PER_DAY;
  const elapsedDays = Math.min(windowDays, state.elapsedDays);
  const projectedBurn = burn > 0 ? Math.min(999, (Math.max(0, 1 - consumedFrac) * windowDays) / burn) : 999;
  return {
    windowDays,
    sloPct,
    allowedPct,
    trafficRps,
    errorPct,
    burn,
    observedBurn,
    elapsedDays,
    consumedFrac,
    remainingPct,
    remainingRequests: Math.max(0, 1 - consumedFrac) * allowedPerDay * windowDays,
    projectedBurn,
    windowProgress: (elapsedDays / windowDays) * 100,
    burnWindowHours: num(p, "burnWindowHours", 6),
  };
}

function budgetHealth(remainingPct: number): "ok" | "warn" | "crit" {
  if (remainingPct <= 20) return "crit";
  if (remainingPct <= 50) return "warn";
  return "ok";
}

function burnHealth(observedBurn: number): "ok" | "warn" | "crit" {
  if (observedBurn >= 6) return "crit";
  if (observedBurn >= 2) return "warn";
  return "ok";
}

function buildFrame(p: Params, state: BudgetState, seed: number): SimFrame {
  const values = compute(p, state);
  const remainingHealth = budgetHealth(values.remainingPct);
  const observedHealth = burnHealth(values.observedBurn);
  const sliHealth = values.errorPct > values.allowedPct ? (values.errorPct > values.allowedPct * 5 ? "crit" : "warn") : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "callers",
        label: "Callers",
        kind: "client",
        health: "ok",
        throughput: values.trafficRps,
        sublabel: `${Math.round(values.trafficRps).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "sli",
        label: "SLI evaluator",
        kind: "service",
        health: sliHealth,
        utilization: clamp(values.errorPct / 3),
        throughput: values.trafficRps,
        sublabel: `${values.errorPct.toFixed(2)}% bad`,
        meta: { view: "flow" },
      },
      {
        id: "budget",
        label: "Error budget",
        kind: "storage",
        health: remainingHealth,
        utilization: clamp(values.consumedFrac),
        sublabel: `${values.remainingPct.toFixed(0)}% remaining`,
        detail: `Allowed bad rate: ${values.allowedPct.toFixed(3)}%. Budget window: ${values.windowDays} days. Observed burn: ${values.observedBurn.toFixed(1)}x.`,
        meta: { view: "flow" },
      },
      {
        id: "release",
        label: "Release policy",
        kind: "service",
        health: remainingHealth,
        utilization: clamp(values.consumedFrac),
        sublabel: remainingHealth === "crit" ? "freeze reviews" : remainingHealth === "warn" ? "slow releases" : "ship normally",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("callers-sli", "callers", "sli", 0.85, sliHealth),
      edge("sli-budget", "sli", "budget", 0.6, remainingHealth),
      edge("budget-release", "budget", "release", 0.6, observedHealth),
    ],
    metrics: [
      metric("budget-remaining", "Budget remaining", values.remainingPct, "%", undefined, undefined, "percent"),
      metric("budget-spent", "Budget spent", values.consumedFrac * 100, "%", 50, 80, "percent"),
      metric("burn-rate", "Observed burn rate", values.observedBurn, "x", 2, 6, "number"),
      metric("error-rate", "Bad event rate", values.errorPct, "%", undefined, undefined, "percent"),
      metric("window-progress", "Window elapsed", values.windowProgress, "%", undefined, undefined, "percent"),
      metric("projected-exhaustion", "Projected days to exhaustion", values.projectedBurn, " days", undefined, undefined, "number"),
      metric("budget-requests", "Bad requests left", values.remainingRequests, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      elapsedDays: values.elapsedDays,
      consumedFrac: values.consumedFrac,
      observedBurn: values.observedBurn,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.remainingPct.toFixed(0)}% of the ${values.windowDays}-day budget remains; ${values.observedBurn.toFixed(1)}x burn; ${values.windowProgress.toFixed(0)}% of the window elapsed.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 12 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.4) * Math.max(0.5, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "budget-spent",
    metricId: "budget-spent",
    warn: 50,
    crit: 80,
    title: "The error budget is almost exhausted",
    cause:
      "Bad events are consuming the allowed failure quantity faster than the compliance window is elapsing. The budget is a rate problem, not a stock problem: check burn before the balance reaches zero.",
    fix:
      "Apply the error budget policy before the budget is empty. Stop risky releases, reduce change velocity, and spend engineering time on the dominant failure mode rather than on the dashboard.",
    checkFirst: [
      "Compare budget spent with window elapsed. Spending faster than time is the signal.",
      "Split the burn by endpoint, region, and customer tier to find the dominant failure.",
      "Check whether a recent deploy or dependency change altered the bad event rate.",
    ],
  },
  {
    id: "burn-rate",
    metricId: "burn-rate",
    warn: 2,
    crit: 6,
    title: "Burn rate crossed the critical threshold",
    cause:
      "The observed bad event rate is a multiple of the rate the SLO allows. At this burn rate the budget will not last the window even though a healthy balance may remain today.",
    fix:
      "Treat a high burn rate as an incident trigger. Freeze risky changes, mitigate the failure, and re-check the burn over a shorter and a longer lookback before resuming releases.",
    checkFirst: [
      "Confirm the SLI is measuring valid events and good events correctly.",
      "Check whether the burn is broad or isolated to one route or dependency.",
      "Compare a short lookback with a long lookback to separate a spike from a sustained trend.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const sliModel: SimModel = {
  id: "foundations-sli-slo-error-budget",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), { elapsedDays: 0, consumedFrac: 0, observedBurn: 0 }, seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt) => {
    const previous = readState(frame);
    const windowDays = Math.round(num(p, "windowDays", 30));
    const allowedPct = Math.max(0.0001, 100 - num(p, "sloPercent", 99.9));
    const trafficRps = num(p, "trafficRps", 10_000);
    const errorPct = num(p, "errorRatePct", 0.03);
    const burn = errorPct / allowedPct;
    const elapsedDays = Math.min(windowDays, previous.elapsedDays + dt * DAYS_PER_SECOND);
    const totalBudget = (allowedPct / 100) * windowDays * trafficRps * SECONDS_PER_DAY;
    const badRequests = (errorPct / 100) * trafficRps * SECONDS_PER_DAY * (dt * DAYS_PER_SECOND);
    const consumedFrac = Math.min(1.5, previous.consumedFrac + badRequests / Math.max(1, totalBudget));
    const tau = Math.max(0.05, num(p, "burnWindowHours", 6) / 24 / DAYS_PER_SECOND);
    const alpha = 1 - Math.exp(-dt / tau);
    const observedBurn = previous.observedBurn + (burn - previous.observedBurn) * alpha;
    const state: BudgetState = { elapsedDays, consumedFrac, observedBurn };
    const next = buildFrame(p, state, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (consumedFrac >= 1 && frame.flags.budgetExhausted !== 1) {
      pushEvent(next, {
        id: "budget-exhausted",
        at: frame.t,
        severity: "crit",
        title: "Error budget exhausted before the window closed",
        detail: `${windowDays} days of allowed failure were consumed after ${elapsedDays.toFixed(1)} simulated days. At the current burn rate the policy should already have stopped risky releases.`,
        metricId: "budget-spent",
        nodeId: "budget",
      });
      next.flags.budgetExhausted = 1;
    }
    if (consumedFrac < 0.9) next.flags.budgetExhausted = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, { elapsedDays: 0, consumedFrac: 0, observedBurn: num(p, "errorRatePct", 0.03) / Math.max(0.0001, 100 - num(p, "sloPercent", 99.9)) });
    return [
      `The SLO allows ${values.allowedPct.toFixed(3)}% bad events. The current rate is ${values.errorPct.toFixed(2)}%, a ${values.burn.toFixed(1)}x burn.`,
      `At ${values.burn.toFixed(1)}x burn, the ${values.windowDays}-day budget lasts about ${(values.windowDays / Math.max(0.01, values.burn)).toFixed(1)} days if the rate holds.`,
      `A shorter lookback (${values.burnWindowHours}h here) reacts faster but is noisier; a longer lookback smooths spikes but delays the page.`,
      "Traffic volume changes the number of bad requests, but not the budget percentage at a fixed bad event rate.",
      "The budget is spent by the SLI, so an incorrectly classified event quietly changes every decision that follows.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Budget warning", tone: "warn" },
    { label: "Policy freeze", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "0.03% bad events against a 99.9% SLO. The budget barely moves.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak error rate",
    description: "Peak traffic carries 0.12% bad events, a 1.2x burn. Tolerable for a short peak, not for the full window.",
    tone: "warn",
    params: defaults({ trafficRps: 30_000, errorRatePct: 0.12 }),
  },
  {
    id: "failure",
    label: "Bad deploy",
    description: "0.9% bad events against a 99.9% SLO. The budget exhausts in about one ninth of the window.",
    tone: "crit",
    params: defaults({ trafficRps: 30_000, errorRatePct: 0.9, burnWindowHours: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The failure is fixed and the error rate returns below the allowed level.",
    tone: "ok",
    params: defaults({ trafficRps: 10_000, errorRatePct: 0.01, burnWindowHours: 6 }),
  },
];

const experiment: Experiment = {
  id: "predict-budget-exhaustion",
  title: "Predict when the budget runs out",
  simId: "budget",
  question:
    "The SLO is 99.9% over 30 days. Bad events run at 0.9% with 30k requests per second. Does the budget survive the month?",
  prediction: {
    options: [
      { id: "early", label: "No. It exhausts after roughly 3 to 4 days of the 30-day window." },
      { id: "half", label: "It exhausts at about the halfway point." },
      { id: "survives", label: "It survives with about 40% left." },
      { id: "unaffected", label: "The budget is unaffected because traffic is high." },
    ],
    correctOptionId: "early",
    explanation:
      "The SLO allows 0.1% bad events. At 0.9% the burn rate is 9x, so the 30-day budget is consumed in about 30 divided by 9 days, near 3.3 days. The simulation compresses each second to half a day so the exhaustion is visible.",
  },
  setup: defaults({ trafficRps: 30_000, errorRatePct: 0.9, burnWindowHours: 1 }),
  runFor: 12,
  observe: [
    "Budget remaining falls in a straight line because the bad event rate is constant.",
    "Observed burn settles near 9x once the one-hour lookback catches up.",
    "Projected days to exhaustion drops below four days.",
    "The budget reaches zero long before the 30-day window finishes.",
  ],
  explain:
    "Burn rate is bad event rate divided by the allowed bad event rate. It is independent of traffic volume at a fixed percentage. The compliance window sets how much total failure is allowed; burn rate sets how fast that allowance is spent. A high burn rate is visible before the balance reaches zero, which is the point of alerting on it.",
  fix: defaults({ trafficRps: 10_000, errorRatePct: 0.01, burnWindowHours: 6 }),
  debrief:
    "If the reduced rate holds for the full window, a 0.01% bad event rate produces a 0.1x burn, so the budget ends near 90% remaining. The fix is not a bigger budget or more traffic; it is fewer bad events per valid event. The remaining tradeoff is that a 99.9% SLO still allows a large absolute number of failures at high traffic, and the policy must say which failures count.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A service level indicator (SLI) is a measured ratio of good events to valid events: successful requests, requests faster than a threshold, or records processed without error. A service level objective (SLO) is the target for that ratio over a window, such as 99.9% of valid requests over 30 days. A service level agreement (SLA) is a contract with a customer that usually includes consequences. The SLO is an internal engineering target; the SLA is an external promise.",
  },
  {
    type: "p",
    text: "The error budget is the failure the SLO allows. An SLO of 99.9% allows 0.1% bad events. Over a 30-day window at 10k requests per second, that is 0.1% of roughly 25.9 billion valid events, or about 25.9 million bad events. The budget is a quantity, not a feeling: it can be spent, tracked, and exhausted.",
  },
  {
    type: "p",
    text: "Burn rate expresses spending speed. It is the observed bad event rate divided by the allowed bad event rate. A 0.9% bad rate against a 0.1% allowance is a 9x burn. At 9x, a 30-day budget lasts about 3.3 days. This is why burn rate pages earlier than a remaining-balance threshold: the balance can look healthy while the spending rate guarantees it will not last.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The measurement path is load balancer and service telemetry, then an SLI pipeline that classifies each event as good, bad, or invalid, then the SLO evaluator that applies the target and window, then the error budget and the release policy. The policy is the human system that decides what happens when the budget is spent: freeze risky releases, slow changes, or require an explicit exception.",
  },
  {
    type: "table",
    headers: ["Term", "Question it answers", "Typical window", "Consequence"],
    rows: [
      ["SLI", "What fraction of events were good?", "Minutes to days", "Measurement only"],
      ["SLO", "How good must the SLI be?", "Rolling 7, 28, or 30 days", "Error budget and alerts"],
      ["SLA", "What did we promise a customer?", "Contract term", "Credits, penalties, or termination"],
      ["Error budget", "How much failure may we still spend?", "Same as the SLO", "Release policy trigger"],
    ],
  },
  {
    type: "p",
    text: "A rolling window recomputes continuously and does not reset at a month boundary. A calendar window resets, which can hide a bad final week behind a clean first week. The model uses a fixed window that elapses in compressed time: one simulated second is half a day, so a 30-day window finishes in 60 seconds. The numbers are teaching values, not a specific vendor's billing or SLA terms.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Budget remaining: the share of allowed bad events still unspent, with warnings at 50% and 20%.",
      "Observed burn rate: the smoothed multiple of the allowed bad event rate, with warnings at 2x and 6x.",
      "Bad event rate and window progress: the two inputs that explain the balance.",
      "Projected days to exhaustion: what the current rate implies if nothing changes.",
      "A release policy node that changes state with the budget, making the operational consequence visible.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Raise the bad event rate to the Bad deploy preset and watch burn rate cross 6x before the budget balance reaches its critical line. Change the lookback to see detection lag. Then run the experiment and apply the fix. Keep the SLO fixed while you change traffic: the budget percentage should not move just because volume moved.",
  },
  {
    type: "compare",
    leftTitle: "Balance-only alert",
    rightTitle: "Burn-rate alert",
    rows: [
      { label: "Detects", left: "Budget already spent", right: "Budget being spent too fast" },
      { label: "Blind spot", left: "A fast burn with a large starting balance", right: "Short spikes that a long lookback smooths" },
      { label: "Action", left: "React after the damage", right: "Stop the damage while balance remains" },
    ],
  },
  { type: "p", text: "The first question is not whether the budget is low. It is whether the current rate can still fit inside the remaining window. A balance at 60% with 90% of the window gone is healthy; a balance at 60% with 10% of the window gone is not." },
  { type: "sim", simId: "budget" },
  { type: "experiment", experimentId: "predict-budget-exhaustion" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At a 0.9% bad event rate against a 99.9% SLO, every valid event spent nine times the failure the SLO allowed. The budget balance fell in a straight line because the rate was constant, and it reached zero after about 3.3 simulated days of a 30-day window. The balance threshold fired late; the burn-rate threshold fired while there was still time to act.",
  },
  {
    type: "p",
    text: "The lookback changed how quickly the observed burn caught up with the true rate. A one-hour window reacted in a fraction of a simulated second; a 24-hour window took longer and would smooth a short spike. Neither changes the underlying consumption. That separation matters: smoothing is an alerting choice, not a way to make the budget last.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Prometheus and Grafana: an SLI recording rule such as good requests divided by valid requests, a burn-rate rule over multiple windows, and a panel that shows budget spent against window elapsed.",
      "AWS: ALB `RequestCount` and `HTTPCode_Target_5XX_Count`, CloudWatch metrics, and application error counters. The SLO pipeline must define which status codes and latency thresholds count as bad.",
      "Datadog or another SaaS monitor: an SLO widget with error budget remaining, burn rate, and a monitor that pages on burn rather than on a raw error count.",
      "Logs: error classification decisions, excluded events, and the reason a request was marked invalid. Misclassification is a silent SLO bug.",
      "Traces: failures grouped by route, dependency, and customer tier so the burn can be attributed instead of averaged.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the SLI is classified correctly before you react to the number. Then compare budget spent with window elapsed, split burn by route and dependency, and check for a recent deploy. A sudden burn change is more often a change than a gradual capacity problem.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the SLI as a ratio with an explicit valid-event filter, a good-event condition, and a measurement point.",
      "Set the SLO from user pain and history, not from the current average. State the window and whether it rolls.",
      "Alert on burn over a short and a long window. Use the short window for the page and the long window to confirm a trend.",
      "Pre-agree the policy: what freezes, who can grant an exception, and what evidence ends the freeze.",
      "Attribute the burn to a failure mode before changing capacity or adding retries.",
      "Recheck the budget after the fix and record the remaining balance in the incident review.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A tighter SLO buys user trust and costs engineering velocity. A looser SLO is easier to meet and hides pain.",
      "A 100% SLO leaves no budget and no room for change; it is usually the wrong target for a changing system.",
      "Short burn windows detect fast but page on noise. Long windows are stable but can miss a fast, severe failure.",
      "Aggregate SLIs hide the experience of a small or important customer segment; per-tenant SLIs cost cardinality and attention.",
      "The budget only governs what the SLI measures. A green budget can coexist with a broken path that was excluded from the valid events.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "define-sli-slo",
    question:
      "Define an SLI and an SLO for a payments API. What would you measure, and what target would you defend?",
    difficulty: 2,
    hints: [
      "Start from the user-visible outcome, not from CPU.",
      "State the valid events, the good condition, and the window.",
    ],
    answer:
      "I would define the SLI as the ratio of successful payment authorizations to valid authorization attempts, measured at the edge where the client observes the result. A valid attempt excludes client-side validation failures and requests rejected by an explicit rate limit, because those are not server reliability failures. The good condition is a 2xx authorization response within a latency bound the product can tolerate. I would defend an SLO from observed history and user tolerance, for example 99.9% over a rolling 28 days, and state that the remaining 0.1% is the budget for deploys, dependency failures, and experiments. I would validate the SLI against support tickets and provider reconciliation before trusting it.",
    followUps: [
      "Which failures would you exclude, and why?",
      "How would the SLO change for a synchronous checkout versus an asynchronous payout?",
      "What would make you tighten or loosen the target?",
    ],
    redFlags: [
      "Uses CPU or host health as the SLI.",
      "Sets 100% because it sounds safer.",
      "Cannot name the valid-event filter.",
    ],
    rubric: [
      "Defines a ratio with valid and good events.",
      "Chooses a window and a target with a reason.",
      "Connects the target to user impact.",
      "Mentions validation of the measurement.",
    ],
  },
  {
    id: "spend-budget",
    question:
      "The SLO is 99.9% over 30 days. Fifteen days have passed and 80% of the error budget is spent. What do you do?",
    difficulty: 2,
    hints: [
      "Compare spend with elapsed time, then compute the remaining runway.",
      "The policy should already say what happens next.",
    ],
    answer:
      "Half the window has passed but 80% of the budget is gone, so the burn is roughly 1.6 times the sustainable rate for the remaining period. I would treat that as an active budget risk, not a theoretical one: check whether the spend is a recent step change or a steady trend, attribute it to a route or dependency, and apply the pre-agreed policy. That usually means freezing risky releases, prioritizing the dominant failure mode, and setting an explicit review point. I would not wait for the balance to hit zero, because by then the remaining window has no room for ordinary change.",
    followUps: [
      "How would a rolling window change your answer?",
      "What if the spend is concentrated in one customer?",
      "Who can grant an exception, and what would you require?",
    ],
    redFlags: [
      "Waits for the budget to reach zero.",
      "Treats the budget as a dashboard only.",
      "Cuts all releases without finding the failure mode.",
    ],
    rubric: [
      "Compares spend with elapsed time.",
      "Attributes the burn.",
      "Applies a pre-agreed policy.",
      "Names an exception and review path.",
    ],
  },
  {
    id: "sla-vs-slo",
    question:
      "Why can an SLO be stricter than an SLA, and what breaks if the two are treated as the same number?",
    difficulty: 2,
    hints: [
      "The SLA has commercial consequences; the SLO is an internal control.",
      "The budget is meant to be spent before the contract is at risk.",
    ],
    answer:
      "The SLO is the internal target that keeps the service comfortably inside the SLA. It is usually stricter because the SLA includes legal and commercial consequences that the team wants a margin against. If the two numbers are identical, the error budget is spent at the exact point where credits or penalties begin, leaving no room to detect and correct a trend. The SLO should also be defined on a measurement the team controls, while the SLA may use a different calculation, exclusions, and reporting period. Treating them as the same creates a policy that either freezes too late or pages on contract language rather than user pain.",
    followUps: [
      "Who owns the SLA calculation?",
      "How do exclusions in the contract affect the internal SLI?",
      "What would you show a customer during a budget freeze?",
    ],
    redFlags: [
      "Assumes the SLA is the engineering target.",
      "Ignores exclusions and measurement differences.",
      "Has no margin between internal and external promises.",
    ],
    rubric: [
      "Separates internal target from commercial promise.",
      "Explains the margin.",
      "Names measurement and ownership differences.",
      "Connects the policy to customer trust.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every user-facing SLI has a written valid-event filter and a good-event condition.",
      "The SLO window, target, and owner are recorded, including whether the window rolls.",
      "Burn-rate alerts use more than one lookback and are tested against a known bad deploy.",
      "The error budget policy names the freeze trigger, the exception approver, and the review cadence.",
      "Dashboards show budget spent against window elapsed, not only the remaining percentage.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the SLI classification before reacting to a burn alert.",
      "Split the burn by route, region, dependency, and customer tier.",
      "Check recent deploys and dependency changes before assuming a capacity problem.",
      "Apply the policy at the agreed trigger rather than improvising a freeze.",
      "Record the decision, the evidence, and the time in the incident timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Recompute the budget with the corrected SLI and confirm the remaining balance.",
      "Review whether the burn alert fired early enough and whether the lookback was appropriate.",
      "Update the policy if the team hesitated or improvised.",
      "Add a regression check for the failure mode that spent the budget.",
    ],
  },
];

const references = [
  {
    title: "Implementing SLOs",
    url: "https://sre.google/workbook/implementing-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "SLI selection, SLO targets, error budgets, and burn-rate alerting.",
  },
  {
    title: "Service Level Objectives",
    url: "https://sre.google/sre-book/service-level-objectives/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "The distinction between SLI, SLO, and SLA, and why 100% is the wrong target.",
  },
  {
    title: "Reliability Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Reliability targets, monitoring, and failure management in AWS workloads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    budget: {
      model: sliModel,
      presets,
      instructions:
        "Start Healthy, then load Bad deploy. Watch burn rate and budget remaining together. Change the lookback and the SLO target, then run the experiment and apply the fix.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second is half a day; budget math is exact for the parameters shown, not a vendor SLA.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-use-red",
    "foundations-percentiles",
    "reliability-error-budget-policy",
    "foundations-queueing-knee",
  ],
};
