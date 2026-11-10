import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SLO_TARGET = 99.9;
const ALLOWED_PCT = 100 - SLO_TARGET;
const BUDGET_WINDOW_MIN = 30 * 24 * 60;
const PAGE_BURN = 14.4;
const STATIC_ALERT_PCT = 2;
const SECONDS_PER_MINUTE = 1;

const params: ParamSpec[] = [
  {
    id: "errorRatePct",
    label: "Bad event rate",
    min: 0,
    max: 5,
    step: 0.01,
    value: 0.04,
    unit: "%",
    group: "Traffic",
    help: "Requests that fail the SLI. Compare it with 0.1%, the failure a 99.9% SLO allows.",
    format: "percent",
  },
  {
    id: "fastWindowMin",
    label: "Fast window",
    min: 1,
    max: 60,
    step: 1,
    value: 5,
    unit: " min",
    group: "Windows",
    help: "Short lookback that confirms the burn is happening now. One simulated second is one minute.",
    format: "count",
  },
  {
    id: "slowWindowMin",
    label: "Slow window",
    min: 10,
    max: 180,
    step: 5,
    value: 30,
    unit: " min",
    group: "Windows",
    help: "Long lookback that proves the burn persisted. It is forced to stay longer than the fast window.",
    format: "count",
  },
  {
    id: "budgetConsumedPct",
    label: "Budget already spent",
    min: 0,
    max: 100,
    step: 1,
    value: 12,
    unit: "%",
    group: "SLO",
    help: "Share of the 30-day error budget spent before this incident starts.",
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
    help: "Requests counted by the SLI. Volume changes the number of bad events, not the burn multiple.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface BurnState {
  fastFill: number;
  slowFill: number;
  consumedPct: number;
  pageActive: number;
  pageEpisodes: number;
  staticActive: number;
}

interface Computed {
  errorPct: number;
  instantBurn: number;
  fastBurn: number;
  slowBurn: number;
  fastWindow: number;
  slowWindow: number;
  consumedPct: number;
  remainingPct: number;
  trafficRps: number;
  paging: boolean;
  staticAlert: boolean;
  runwayDays: number;
}

function compute(p: Params, state: BurnState): Computed {
  const errorPct = num(p, "errorRatePct", 0.04);
  const fastWindow = Math.round(num(p, "fastWindowMin", 5));
  const slowWindow = Math.max(fastWindow + 5, Math.round(num(p, "slowWindowMin", 30)));
  const instantBurn = errorPct / ALLOWED_PCT;
  const fastBurn = instantBurn * clamp(state.fastFill);
  const slowBurn = instantBurn * clamp(state.slowFill);
  const consumedPct = clamp(Math.max(state.consumedPct, num(p, "budgetConsumedPct", 12)), 0, 100);
  const trafficRps = num(p, "trafficRps", 10_000);
  return {
    errorPct,
    instantBurn,
    fastBurn,
    slowBurn,
    fastWindow,
    slowWindow,
    consumedPct,
    remainingPct: Math.max(0, 100 - consumedPct),
    trafficRps,
    paging: fastBurn >= PAGE_BURN && slowBurn >= PAGE_BURN,
    staticAlert: errorPct >= STATIC_ALERT_PCT,
    runwayDays: instantBurn > 0 ? Math.min(999, (30 * (1 - consumedPct / 100)) / instantBurn) : 999,
  };
}

function burnHealth(value: number): "ok" | "warn" | "crit" {
  if (value >= PAGE_BURN) return "crit";
  if (value >= 6) return "warn";
  return "ok";
}

function budgetHealth(consumed: number): "ok" | "warn" | "crit" {
  if (consumed >= 85) return "crit";
  if (consumed >= 60) return "warn";
  return "ok";
}

function buildFrame(p: Params, state: BurnState, seed: number): SimFrame {
  const values = compute(p, state);
  const fastHealth = burnHealth(values.fastBurn);
  const slowHealth = burnHealth(values.slowBurn);
  const budget = budgetHealth(values.consumedPct);
  const sliHealth = values.errorPct >= 2 ? "crit" : values.errorPct >= 0.3 ? "warn" : "ok";
  const pagerHealth: "ok" | "warn" | "crit" = values.paging
    ? "crit"
    : values.fastBurn >= 6 || values.slowBurn >= 6
      ? "warn"
      : "ok";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "callers",
        label: "Callers",
        kind: "client",
        health: "ok",
        throughput: values.trafficRps,
        sublabel: `${Math.round(values.trafficRps).toLocaleString()} valid rps`,
        meta: { view: "flow" },
      },
      {
        id: "sli",
        label: "SLI evaluator",
        kind: "service",
        health: sliHealth,
        utilization: clamp(values.errorPct / 5),
        throughput: values.trafficRps,
        sublabel: `${values.errorPct.toFixed(2)}% bad`,
        detail: `A 99.9% SLO allows ${ALLOWED_PCT}% bad events. At ${values.errorPct.toFixed(2)}% the instantaneous burn is ${values.instantBurn.toFixed(1)}x.`,
        meta: { view: "flow" },
      },
      {
        id: "fast-window",
        label: "Fast window",
        kind: "service",
        health: fastHealth,
        utilization: clamp(values.fastBurn / 30),
        sublabel: `${values.fastWindow} min, ${values.fastBurn.toFixed(1)}x`,
        meta: { view: "flow" },
      },
      {
        id: "slow-window",
        label: "Slow window",
        kind: "service",
        health: slowHealth,
        utilization: clamp(values.slowBurn / 30),
        sublabel: `${values.slowWindow} min, ${values.slowBurn.toFixed(1)}x`,
        meta: { view: "flow" },
      },
      {
        id: "pager",
        label: "On-call pager",
        kind: "worker",
        health: pagerHealth,
        sublabel: values.paging ? "paging" : "quiet",
        detail: values.paging
          ? "Both windows are above the page threshold. The alert is confirmed, not a single-window spike."
          : `The page requires both windows above ${PAGE_BURN}x. A static ${STATIC_ALERT_PCT}% error alert is a separate, slower signal.`,
        meta: { view: "flow" },
      },
      {
        id: "budget",
        label: "Error budget",
        kind: "storage",
        health: budget,
        utilization: clamp(values.consumedPct / 100),
        sublabel: `${values.remainingPct.toFixed(0)}% left`,
        detail: `At ${values.instantBurn.toFixed(1)}x burn the remaining 30-day budget lasts about ${values.runwayDays.toFixed(1)} days.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("callers-sli", "callers", "sli", 0.9, sliHealth),
      edge("sli-fast", "sli", "fast-window", 0.8, fastHealth),
      edge("sli-slow", "sli", "slow-window", 0.8, slowHealth),
      edge("fast-pager", "fast-window", "pager", 0.6, pagerHealth),
      edge("slow-pager", "slow-window", "pager", 0.6, pagerHealth),
      edge("sli-budget", "sli", "budget", 0.5, budget),
    ],
    metrics: [
      metric("page-decision", "Multi-window page", values.paging ? 1 : 0, "", 0.5, 0.5, "number"),
      metric("fast-burn", "Fast-window burn", values.fastBurn, "x", 6, PAGE_BURN, "number"),
      metric("slow-burn", "Slow-window burn", values.slowBurn, "x", 6, PAGE_BURN, "number"),
      metric("budget-consumed", "Budget consumed", values.consumedPct, "%", 60, 85, "percent"),
      metric("budget-remaining", "Budget remaining", values.remainingPct, "%", undefined, undefined, "percent"),
      metric(
        "mtd-slo",
        "Month-to-date SLO",
        100 - (ALLOWED_PCT * values.consumedPct) / 100,
        "%",
        undefined,
        undefined,
        "percent",
      ),
      metric("error-rate", "Bad event rate", values.errorPct, "%", STATIC_ALERT_PCT, undefined, "percent"),
      metric("instant-burn", "Instantaneous burn", values.instantBurn, "x", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      fastFill: state.fastFill,
      slowFill: state.slowFill,
      consumedPct: values.consumedPct,
      pageActive: state.pageActive,
      pageEpisodes: state.pageEpisodes,
      staticActive: state.staticActive,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.fastBurn.toFixed(1)}x fast burn and ${values.slowBurn.toFixed(1)}x slow burn; ${values.remainingPct.toFixed(0)}% of the 30-day budget remains.`,
  };
  seedSeries(frame, seed);
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  const offset = seed % 11;
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.94 + 0.08 * Math.sin((index + offset) / 2.4))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "page-decision",
    metricId: "page-decision",
    warn: 0.5,
    crit: 0.5,
    title: "Both burn windows confirm a page",
    cause:
      "The fast and slow windows are both above 14.4x. On a 99.9% SLO that is about 1.44% bad events, so the budget is being spent far faster than the 30-day window allows.",
    fix:
      "Page the on-call engineer. Stop risky changes, find the dominant failure mode, and keep both windows in view until the burn falls below the threshold.",
    checkFirst: [
      "Confirm the SLI counts valid events and bad events correctly.",
      "Compare the fast and slow windows: one alone is a spike, both together are a burn.",
      "Split the bad events by route, region, and dependency before changing capacity.",
    ],
  },
  {
    id: "slow-burn",
    metricId: "slow-burn",
    warn: 6,
    crit: PAGE_BURN,
    title: "The slow window shows a sustained burn",
    cause:
      "A long lookback is above the page threshold. The failure has persisted long enough that smoothing is no longer hiding it, and the remaining budget is at risk even if this minute looks calmer.",
    fix:
      "Treat the slow window as confirmation, not a separate incident. Keep the page open until the long-window burn is back below the sustainable rate.",
    checkFirst: [
      "Check whether the burn started at a deploy, a dependency change, or a traffic shift.",
      "Compare budget spent with the fraction of the 30-day window that has elapsed.",
      "Check whether a partial recovery is masking continuing failures on one route.",
    ],
  },
  {
    id: "budget-consumed",
    metricId: "budget-consumed",
    warn: 60,
    crit: 85,
    title: "The remaining error budget is nearly spent",
    cause:
      "Past failures have consumed most of the 30-day allowance. Even a moderate new burn can exhaust the budget before the window resets.",
    fix:
      "Apply the error budget policy: freeze risky releases, prioritize the dominant failure mode, and set an explicit review point before resuming normal change.",
    checkFirst: [
      "Compare budget consumed with window elapsed.",
      "Check whether the spend is one recent event or a steady trend.",
      "Confirm who can approve an exception and what evidence ends the freeze.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

function initialState(p: Params): BurnState {
  return {
    fastFill: 0,
    slowFill: 0,
    consumedPct: num(p, "budgetConsumedPct", 12),
    pageActive: 0,
    pageEpisodes: 0,
    staticActive: 0,
  };
}

function readState(frame: SimFrame): BurnState {
  return {
    fastFill: clamp(Number(frame.flags.fastFill ?? 0)),
    slowFill: clamp(Number(frame.flags.slowFill ?? 0)),
    consumedPct: clamp(Number(frame.flags.consumedPct ?? 0), 0, 100),
    pageActive: Number(frame.flags.pageActive ?? 0),
    pageEpisodes: Number(frame.flags.pageEpisodes ?? 0),
    staticActive: Number(frame.flags.staticActive ?? 0),
  };
}

export const burnRateModel: SimModel = {
  id: "observability-slo-burn-rate",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), initialState(defaults()), seed),
  step: (frame, p, dt) => {
    const previous = readState(frame);
    const errorPct = num(p, "errorRatePct", 0.04);
    const instantBurn = errorPct / ALLOWED_PCT;
    const fastWindow = Math.round(num(p, "fastWindowMin", 5));
    const slowWindow = Math.max(fastWindow + 5, Math.round(num(p, "slowWindowMin", 30)));
    const fastFill = clamp(previous.fastFill + (dt * SECONDS_PER_MINUTE) / fastWindow);
    const slowFill = clamp(previous.slowFill + (dt * SECONDS_PER_MINUTE) / slowWindow);
    const consumedPct = clamp(
      Math.max(
        previous.consumedPct + (instantBurn * dt) / (BUDGET_WINDOW_MIN / 100),
        num(p, "budgetConsumedPct", 12),
      ),
      0,
      100,
    );
    const state: BurnState = {
      fastFill,
      slowFill,
      consumedPct,
      pageActive: previous.pageActive,
      pageEpisodes: previous.pageEpisodes,
      staticActive: previous.staticActive,
    };
    const values = compute(p, state);
    const next = buildFrame(p, state, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    if (values.paging && previous.pageActive !== 1) {
      pushEvent(next, {
        id: "multi-window-page",
        at: frame.t,
        severity: "crit",
        title: "Multi-window burn alert is paging",
        detail: `Fast ${values.fastBurn.toFixed(1)}x over ${values.fastWindow} min and slow ${values.slowBurn.toFixed(1)}x over ${values.slowWindow} min. At ${values.instantBurn.toFixed(1)}x the remaining budget lasts about ${values.runwayDays.toFixed(1)} days.`,
        metricId: "page-decision",
        nodeId: "pager",
      });
      next.flags.pageEpisodes = previous.pageEpisodes + 1;
    }
    next.flags.pageActive = values.paging ? 1 : 0;
    if (values.staticAlert && previous.staticActive !== 1) {
      pushEvent(next, {
        id: "static-error-alert",
        at: frame.t,
        severity: "warn",
        title: "Static error-rate alert fired",
        detail: `The bad event rate is ${values.errorPct.toFixed(2)}%, above the static ${STATIC_ALERT_PCT}% alert. The burn page uses a lower equivalent rate plus a persistence window; the static alert is a separate, level-only signal.`,
        metricId: "error-rate",
      });
    }
    next.flags.staticActive = values.staticAlert ? 1 : 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.fastBurn.toFixed(1)}x fast burn and ${values.slowBurn.toFixed(1)}x slow burn; ${values.remainingPct.toFixed(0)}% of the 30-day budget remains.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const values = compute(p, readState(frame));
    return [
      `A 99.9% SLO allows ${ALLOWED_PCT}% bad events. The current ${values.errorPct.toFixed(2)}% is a ${values.instantBurn.toFixed(1)}x burn.`,
      `The month-to-date SLO is ${(100 - (ALLOWED_PCT * values.consumedPct) / 100).toFixed(3)}%, still at or above target while the budget is being spent at ${values.instantBurn.toFixed(1)}x.`,
      `At ${PAGE_BURN}x, the page threshold equals ${(PAGE_BURN * ALLOWED_PCT).toFixed(2)}% bad events. A static ${STATIC_ALERT_PCT}% alert sits at ${(STATIC_ALERT_PCT / ALLOWED_PCT).toFixed(1)}x and will miss a smaller but still expensive burn.`,
      `The fast ${values.fastWindow}-minute window reacts in seconds; the slow ${values.slowWindow}-minute window needs the burn to persist before it confirms.`,
      `The remaining 30-day budget lasts about ${values.runwayDays.toFixed(1)} days at this rate. Burn is spending speed, not the balance.`,
      values.paging
        ? "Both windows are above the page threshold, so the alert is confirmed rather than a single-window blip."
        : "A single window above the threshold is not yet a page in this policy; the second window is the confirmation.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Elevated burn", tone: "warn" },
    { label: "Paging", tone: "crit" },
    { label: "Budget spent", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "0.04% bad events against a 99.9% SLO. Both windows settle far below the page threshold.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak error rate",
    description: "0.9% bad events is a 9x burn. It is a warning, not yet the 14.4x page.",
    tone: "warn",
    params: defaults({ errorRatePct: 0.9, trafficRps: 30_000, budgetConsumedPct: 45 }),
  },
  {
    id: "failure",
    label: "Fast burn",
    description: "1.5% bad events is a 15x burn. The static 2% alert stays silent while both windows page.",
    tone: "crit",
    params: defaults({ errorRatePct: 1.5, trafficRps: 30_000, budgetConsumedPct: 70 }),
  },
  {
    id: "slow-burn",
    label: "Slow burn",
    description: "0.6% bad events is a 6x burn: at the warning line, below the 14.4x page, but it still eats the budget.",
    tone: "warn",
    params: defaults({ errorRatePct: 0.6, trafficRps: 20_000, budgetConsumedPct: 55 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The failure is fixed. Both windows fall back below the page threshold and the budget stops draining fast.",
    tone: "ok",
    params: defaults({ errorRatePct: 0.03, trafficRps: 10_000, budgetConsumedPct: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-fast-burn-page",
  title: "Predict which alert fires",
  simId: "burn",
  question:
    "Bad events run at 1.5% against a 99.9% SLO. The static alert is set at 2%. Which alert fires first?",
  prediction: {
    options: [
      { id: "burn", label: "The multi-window burn alert, at about 1.44% bad events" },
      { id: "static", label: "The static 2% error alert, before the burn alert" },
      { id: "both", label: "Both fire at the same time" },
      { id: "neither", label: "Neither fires because the SLO is still met for the month" },
    ],
    correctOptionId: "burn",
    explanation:
      "A 99.9% SLO allows 0.1% bad events. The 14.4x page threshold therefore equals 1.44% bad events, which is below the 2% static alert. The burn page fires while the static alert remains silent. The 30-day SLO can still read 99.9% because only a small part of the month has failed.",
  },
  setup: defaults({ errorRatePct: 1.5, trafficRps: 30_000, budgetConsumedPct: 70 }),
  runFor: 45,
  observe: [
    "The fast window reaches 15x after about five simulated seconds.",
    "The slow window reaches the page threshold after about thirty seconds, then the page fires.",
    "The static 2% error alert never crosses because 1.5% is below it.",
    "Budget consumed rises while budget remaining falls; a 30-day balance can still look large.",
  ],
  explain:
    "Burn rate is the bad rate divided by the allowed rate. The page threshold is therefore a bad-rate threshold in disguise, and a lower one than the static alert. The two windows add persistence: the fast window says the burn is happening, the slow window says it is not a blip. Neither window asks whether the month-to-date SLO has already failed.",
  fix: defaults({ errorRatePct: 0.03, trafficRps: 10_000, budgetConsumedPct: 30 }),
  debrief:
    "The fix lowers the bad rate to 0.03%, a 0.3x burn, so both windows fall below the threshold and the page clears. Budget remains partly spent; recovery does not refill it. The tradeoff is that a very short, severe spike can still be missed if the slow window is long, so the window pair has to match how long the team can wait.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A burn rate is the speed at which a service spends its error budget. It is the observed bad-event rate divided by the bad-event rate the SLO allows. A 99.9% SLO allows 0.1% bad events, so a service failing 0.5% of requests is burning at 5x. At 5x, a 30-day budget lasts about six days if the rate holds.",
  },
  {
    type: "p",
    text: "A static alert asks whether a signal is above a line right now. A burn-rate alert asks how fast the budget is disappearing. Those are different questions. The month-to-date SLO can still read 99.9% after forty minutes of failure because the window is long and the damage is small relative to a month of traffic. A static 2% error alert may also stay silent while a 1.5% failure consumes budget at 15x.",
  },
  {
    type: "p",
    text: "Multi-window alerting pairs a short lookback with a long one. The short window answers whether the burn is happening now. The long window answers whether it persisted. Both must be above the threshold before the page fires. That combination catches a fast burn early and avoids paging on every brief spike that a short window would see.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is request telemetry, then the SLI evaluator that labels each event good, bad, or invalid, then the recording rules that compute burn over each window, then the alert rule that combines the windows, then the pager. The error budget sits beside the alert path because it answers a different question: how much failure is left, not how fast it is being spent.",
  },
  {
    type: "table",
    headers: ["Signal", "Question", "Blind spot"],
    rows: [
      ["Raw error rate", "Is the failure rate high right now?", "A moderate rate can still exhaust the budget"],
      ["Month-to-date SLO", "Has the service already missed its target?", "Long window hides a new, fast burn"],
      ["Fast-window burn", "Is the budget being spent quickly now?", "A brief spike can look like a burn"],
      ["Slow-window burn", "Has the burn persisted?", "A very short, severe failure can be smoothed away"],
      ["Multi-window page", "Is this fast and persistent enough to wake someone?", "Needs both windows tuned to the budget"],
    ],
  },
  {
    type: "p",
    text: "One simulated second represents one minute. The fast window defaults to five minutes and the slow window to thirty. The 30-day budget is compressed only for the run rate: a 15x burn spends about two percent of the budget in an hour, which is visible but does not exhaust the month in a short demo.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Fast and slow burn multiples, each with a warning at 6x and the page threshold at 14.4x.",
      "A page decision that turns on only when both windows are above 14.4x.",
      "Budget consumed and remaining, so a healthy balance cannot hide a high spend rate.",
      "The month-to-date SLO, which can still read 99.9% while the burn page is justified.",
      "The bad event rate with the static 2% alert line drawn separately from the burn page.",
      "A pager node that stays quiet during a single-window warning and changes state when the multi-window page fires.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Fast burn. Watch the fast window cross first and the slow window confirm a few seconds later. Notice that the static 2% line is never reached. Change either window and re-run: the page should arrive later when the slow window is longer. Then apply Recovery and watch both windows fall back.",
  },
  {
    type: "compare",
    leftTitle: "Static threshold",
    rightTitle: "Multi-window burn",
    rows: [
      { label: "Detects", left: "A level above a fixed line", right: "A spending speed above the budget rate" },
      { label: "Misses", left: "A moderate rate that is still too expensive", right: "A short spike that neither window confirms" },
      { label: "Pages on", left: "The line being crossed once", right: "Two windows agreeing on persistence" },
      { label: "Tuning unit", left: "A percentage", right: "A burn multiple and a pair of windows" },
    ],
  },
  { type: "sim", simId: "burn" },
  { type: "experiment", experimentId: "predict-fast-burn-page" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 1.5% bad events the service burned 15 times faster than the 99.9% SLO allowed. The fast window reached 15x within five simulated minutes. The slow window needed thirty minutes to fill, and only then did the page fire. The static 2% alert never crossed because 1.5% is below its line, even though the burn was already above the page threshold.",
  },
  {
    type: "p",
    text: "The budget chart made the distinction visible. The month-to-date balance was still large, so a balance-only view would have called the service healthy. The spending rate was not healthy. The two windows turned a single number into a decision: fast says now, slow says persistent, and both together justify waking someone.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Prometheus: recording rules for `good_events` and `valid_events`, a burn expression such as `1 - good/valid` divided by the allowed bad rate, and alert rules that combine a short and a long range.",
      "Grafana: a burn panel with both windows and the page threshold, plus a budget-remaining panel. The page annotation should appear at the same timestamp as the alert.",
      "Google Cloud Monitoring or Datadog: an SLO widget with burn rate and a monitor that pages on the multi-window condition rather than on a raw error count.",
      "Logs and traces: the failing route, dependency, and status code that explain the burn. A high burn without a dominant failure mode usually means the SLI is too broad.",
      "Alertmanager or PagerDuty: the page payload should include the burn multiple, both windows, the remaining budget, and a link to the runbook.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the SLI is counting the right events before you trust the burn. Then compare both windows and the budget consumed against the fraction of the window elapsed. Split the bad events by route and dependency. A sudden burn is more often a change than a gradual capacity problem.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write the SLI as a ratio of good to valid events, with the valid-event filter and the bad condition stated explicitly.",
      "Set the SLO from user pain and history. Derive the allowed bad rate from it.",
      "Pick a page threshold in burn multiples, then translate it back to a bad-event rate so the team knows what it means.",
      "Pair a short confirmation window with a longer persistence window. Test the pair against a known fast burn and a known blip.",
      "Page only when both windows cross. Keep single-window crossings as warnings or dashboard annotations.",
      "After mitigation, verify both windows and the budget balance before declaring recovery. The budget does not refill when the error rate falls.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A very short fast window catches a spike but is noisy. A long fast window is stable but delays the page.",
      "A long slow window suppresses blips but can smooth a short, severe outage into a smaller number.",
      "A high page threshold protects sleep and risks spending the budget before anyone reacts.",
      "A low threshold pages earlier and trains the team to ignore the alert when the burn is tolerable.",
      "A 99.9% target leaves little room for a fast burn; a looser target changes the arithmetic but not the need for both windows.",
      "Burn alerts depend on the SLI. A misclassified event changes the page, the budget, and every downstream decision.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "compute-burn",
    question:
      "A service has a 99.9% SLO over 30 days. It is failing 1.5% of requests. What is the burn rate, and what does it imply?",
    difficulty: 2,
    hints: ["Divide the observed bad rate by the allowed bad rate.", "Compare the result with the remaining window."],
    answer:
      "The SLO allows 0.1% bad events, so 1.5% is fifteen times the allowed rate. At 15x, the 30-day budget is consumed in about two days if the rate holds. The month-to-date SLO can still look healthy because only a small part of the window has elapsed. The burn rate is the signal that the remaining budget is at risk, which is why it should page before the balance reaches zero.",
    followUps: [
      "What would a 5x burn imply for the remaining runway?",
      "How would a rolling window change the month-to-date number?",
      "What if traffic doubled at the same percentage?",
    ],
    redFlags: [
      "Compares the bad rate with 100% instead of the allowed rate.",
      "Waits for the month-to-date SLO to fail.",
      "Confuses burn rate with the budget balance.",
    ],
    rubric: [
      "Computes 15x correctly.",
      "Translates burn into runway.",
      "Separates balance from speed.",
      "States the assumption about the rate holding.",
    ],
  },
  {
    id: "choose-windows",
    question:
      "How do you choose the short and long windows for a multi-window burn alert?",
    difficulty: 3,
    hints: [
      "Start from how long the team can afford to wait.",
      "Use the short window for confirmation and the long window for persistence.",
    ],
    answer:
      "I start from the budget and the response time. The page threshold sets how much budget a confirmed burn may consume before someone acts. The long window must be long enough that a normal spike does not confirm, but short enough that a real burn still pages within the response budget. The short window should be a fraction of the long window and should clear quickly after mitigation so the alert resolves. I would test the pair against a known fast burn, a brief blip, and a slow burn, then adjust the threshold rather than adding more windows. The tradeoff is detection delay against false pages.",
    followUps: [
      "Why not page on the short window alone?",
      "What happens if the long window is longer than the incident?",
      "How would you tune this for a 99.99% SLO?",
    ],
    redFlags: [
      "Picks windows by convention without a budget reason.",
      "Pages on every short-window crossing.",
      "Uses one window for both speed and persistence.",
    ],
    rubric: [
      "Connects windows to response time and budget.",
      "Explains the confirmation role.",
      "Tests fast burn and blip cases.",
      "Names the detection-delay tradeoff.",
    ],
  },
  {
    id: "static-vs-burn",
    question:
      "Why can a static error-rate alert miss a burn that a multi-window burn alert catches?",
    difficulty: 2,
    hints: [
      "Translate the burn threshold into an error rate.",
      "A month-to-date SLO is a long average.",
    ],
    answer:
      "A burn threshold is an error-rate threshold in disguise. On a 99.9% SLO, 14.4x equals 1.44% bad events. A static alert at 2% sits at 20x and will not fire at 1.5%, even though 1.5% spends the budget fifteen times too fast. The month-to-date SLO also hides it because the window is long. The burn alert compares the observed rate with the allowed rate, so it can page at a lower absolute error rate and while a healthy-looking balance remains.",
    followUps: [
      "When would a static alert still be useful?",
      "What if the SLO is 99%?",
      "How do you explain the difference to a product owner?",
    ],
    redFlags: [
      "Says burn is only a dashboard metric.",
      "Assumes the SLO percentage is the alert threshold.",
      "Ignores the allowed bad rate.",
    ],
    rubric: [
      "Translates burn into an absolute rate.",
      "Explains the long-window blind spot.",
      "Keeps static alerts for appropriate uses.",
    ],
  },
  {
    id: "budget-policy",
    question:
      "The burn alert pages at 3 a.m. and the budget is already 70% spent. What do you do in the first ten minutes?",
    difficulty: 3,
    hints: [
      "Protect the remaining budget before diagnosing everything.",
      "The policy should already name who can freeze changes.",
    ],
    answer:
      "I confirm the page is real by checking the SLI, both windows, and the dominant failing route. Then I protect the remaining budget: stop risky releases, roll back a recent change if the timing matches, and reduce load or shed non-critical traffic if the dependency is saturated. I assign one person to the failure mode and one to communication, and I record the decision times for the timeline. I do not wait for the budget to reach zero, and I do not broaden the SLO or exclude events to make the graph look better. After mitigation I keep watching both windows because the budget does not refill.",
    followUps: [
      "Who can approve an exception?",
      "What evidence ends the freeze?",
      "How do you avoid blaming the last deploy by default?",
    ],
    redFlags: [
      "Waits for the budget balance to hit zero.",
      "Changes the SLO during the incident.",
      "Restarts everything without a hypothesis.",
    ],
    rubric: [
      "Confirms the SLI and windows.",
      "Protects the remaining budget.",
      "Assigns roles and records times.",
      "Names an exit condition.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The SLI has a written valid-event filter and a good-event condition.",
      "The SLO window, target, and owner are recorded, including whether the window rolls.",
      "Burn alerts use at least two windows and a page threshold derived from the budget.",
      "The static alerts that remain are documented as tickets or diagnostics, not pages.",
      "The error budget policy names the freeze trigger, the exception approver, and the review cadence.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the SLI before reacting to the burn number.",
      "Compare fast and slow windows; do not page on a single window.",
      "Split the bad events by route, region, dependency, and customer tier.",
      "Check recent deploys and dependency changes before assuming capacity.",
      "Record the page time, the decision time, and the mitigation time.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Recompute the budget with the corrected SLI and confirm the remaining balance.",
      "Review whether the page fired early enough and whether the slow window delayed it.",
      "Remove temporary exclusions and reconcile the burn rules with the SLI.",
      "Add a regression experiment for the failure mode that spent the budget.",
    ],
  },
];

const references = [
  {
    title: "Alerting on SLOs",
    url: "https://sre.google/workbook/alerting-on-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Multi-window, multi-burn-rate alerting and the reasoning behind window pairs.",
  },
  {
    title: "Implementing SLOs",
    url: "https://sre.google/workbook/implementing-slos/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "SLI selection, error budgets, and the policy that follows a burn.",
  },
  {
    title: "Alerting practices",
    url: "https://prometheus.io/docs/practices/alerting/",
    publisher: "Prometheus",
    kind: "docs" as const,
    note: "Alert rule structure, for clauses, and keeping pages actionable.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    burn: {
      model: burnRateModel,
      presets,
      instructions:
        "Start Healthy, then apply Fast burn. Watch the fast window cross first and the slow window confirm. Change a window, then apply Recovery and watch both fall.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One simulated second is one minute; the 30-day budget is compressed for the run rate, not a vendor SLO.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-sli-slo-error-budget",
    "observability-symptom-alerting",
    "observability-alert-fatigue",
    "foundations-use-red",
  ],
};
