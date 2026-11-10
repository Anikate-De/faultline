import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASELINE_RPS = 10_000;
const SEASON_START = 20;
const SEASON_FULL = 50;
const COST_PER_RPS_MONTH = 0.006;

const params = [
  {
    id: "annualGrowthPct",
    label: "Annual trend growth",
    min: 0,
    max: 80,
    step: 5,
    value: 20,
    unit: "%/year",
    group: "Trend",
    help: "Year-over-year growth in the underlying trend. The model reaches 12 months by the end of the run.",
    format: "percent" as const,
  },
  {
    id: "decemberUpliftPct",
    label: "December uplift",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "% above trend",
    group: "Season",
    help: "The real seasonal peak above trend. The forecast may or may not include it.",
    format: "percent" as const,
  },
  {
    id: "seasonalTermPct",
    label: "Seasonal term in forecast",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "% of uplift",
    group: "Forecast",
    help: "How much of the seasonal uplift the capacity plan includes. Zero is a linear forecast.",
    format: "percent" as const,
  },
  {
    id: "planningPercentile",
    label: "Planning percentile",
    min: 50,
    max: 99,
    step: 1,
    value: 95,
    unit: "th",
    group: "Forecast",
    help: "Percentile of the forecast distribution the plan covers. 50 is the point estimate; 99 is a wide band at a higher cost.",
    format: "percent" as const,
  },
  {
    id: "forecastErrorPct",
    label: "Forecast error band",
    min: 5,
    max: 35,
    step: 5,
    value: 15,
    unit: "%",
    group: "Forecast",
    help: "One-sigma error of the forecast, as a share of the trend. Illustrative.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function smoothstep(value: number): number {
  const x = clamp(value);
  return x * x * (3 - 2 * x);
}

function zFor(percentile: number): number {
  const points: [number, number][] = [
    [50, 0],
    [75, 0.67],
    [90, 1.28],
    [95, 1.65],
    [99, 2.33],
  ];
  const value = clamp(percentile, 50, 99);
  for (let index = 1; index < points.length; index++) {
    const [highP, highZ] = points[index];
    const [lowP, lowZ] = points[index - 1];
    if (value <= highP) {
      const share = (value - lowP) / (highP - lowP);
      return lowZ + (highZ - lowZ) * share;
    }
  }
  return 2.33;
}

interface Computed {
  trendRps: number;
  seasonalFactor: number;
  actualRps: number;
  plannedRps: number;
  utilizationPct: number;
  unplannedPct: number;
  shedPct: number;
  headroomPct: number;
  monthlyCostK: number;
  z: number;
  planFactor: number;
}

function compute(p: Params, t: number): Computed {
  const growth = clamp(num(p, "annualGrowthPct", 20), -40, 100) / 100;
  const uplift = clamp(num(p, "decemberUpliftPct", 40), 0, 150) / 100;
  const seasonalTerm = clamp(num(p, "seasonalTermPct", 100) / 100, 0, 1);
  const percentile = clamp(num(p, "planningPercentile", 95), 50, 99);
  const error = clamp(num(p, "forecastErrorPct", 15), 1, 60) / 100;
  const z = zFor(percentile);
  const monthProgress = clamp(t / 60, 0, 1);
  const trendRps = BASELINE_RPS * Math.pow(1 + growth, monthProgress);
  const seasonalFactor = 1 + uplift * smoothstep((t - SEASON_START) / (SEASON_FULL - SEASON_START));
  const actualRps = trendRps * seasonalFactor;
  const planFactor = (1 + uplift * seasonalTerm) * (1 + z * error);
  const plannedRps = BASELINE_RPS * (1 + growth) * planFactor;
  const utilizationPct = (actualRps / Math.max(1, plannedRps)) * 100;
  const unplannedPct = actualRps > plannedRps ? ((actualRps - plannedRps) / actualRps) * 100 : 0;
  const shedPct = actualRps > plannedRps ? unplannedPct : 0.02;
  return {
    trendRps,
    seasonalFactor,
    actualRps,
    plannedRps,
    utilizationPct,
    unplannedPct,
    shedPct,
    headroomPct: Math.max(0, 100 - utilizationPct),
    monthlyCostK: (plannedRps * COST_PER_RPS_MONTH) / 1_000,
    z,
    planFactor,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.utilizationPct >= 100 || values.shedPct >= 5) return "crit";
  if (values.utilizationPct >= 85 || values.unplannedPct >= 5) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.03 * Math.sin((offset + (seed % 7)) / 2.7);
  const entries: [string, number, number][] = [
    ["peak-utilization", values.utilizationPct, 0.5],
    ["unplanned-peak", values.unplannedPct, 0.3],
    ["shed-demand", values.shedPct, 0.08],
    ["planned-capacity", values.plannedRps, 30],
    ["monthly-cost", values.monthlyCostK, 0.2],
    ["seasonal-factor", values.seasonalFactor * 100, 0.4],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4 + value) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number, state: { peakEvent: boolean; shortEvent: boolean }): SimFrame {
  const v = compute(p, t);
  const health = healthFor(v);
  return {
    t: 0,
    nodes: [
      {
        id: "demand",
        label: "Actual demand",
        kind: "service",
        health,
        utilization: clamp(v.utilizationPct / 100),
        throughput: v.actualRps,
        capacity: v.plannedRps,
        sublabel: `${Math.round(v.actualRps).toLocaleString("en-US")} rps`,
        detail: `Trend is ${Math.round(v.trendRps).toLocaleString("en-US")} rps; the seasonal factor is ${v.seasonalFactor.toFixed(2)}x.`,
        meta: { view: "flow" },
      },
      {
        id: "forecast",
        label: "Forecast",
        kind: "service",
        health: v.seasonalFactor > 1.02 && Number(p["seasonalTermPct"] ?? 100) < 50 ? "warn" : "ok",
        utilization: clamp(Number(p["seasonalTermPct"] ?? 100) / 100),
        sublabel: `${Number(p["seasonalTermPct"] ?? 100).toFixed(0)}% of seasonal uplift`,
        detail: `The plan covers the ${(Number(p["planningPercentile"] ?? 95)).toFixed(0)}th percentile with a ${(Number(p["forecastErrorPct"] ?? 15)).toFixed(0)}% error band.`,
        meta: { view: "flow" },
      },
      {
        id: "plan",
        label: "Capacity plan",
        kind: "service",
        role: "instance",
        health,
        utilization: clamp(v.utilizationPct / 100),
        throughput: v.plannedRps,
        capacity: v.plannedRps,
        sublabel: `${Math.round(v.plannedRps).toLocaleString("en-US")} rps planned`,
        detail: `${Math.round(v.plannedRps).toLocaleString("en-US")} rps of planned capacity. At this month the plan is ${v.utilizationPct.toFixed(0)}% utilized.`,
        meta: { view: "flow" },
      },
      {
        id: "peak",
        label: "Peak month",
        kind: "db",
        health,
        utilization: clamp(v.utilizationPct / 100),
        throughput: v.actualRps,
        sublabel: `${v.seasonalFactor.toFixed(2)}x trend`,
        detail: v.unplannedPct > 0
          ? `The peak exceeds the plan by ${v.unplannedPct.toFixed(1)}%. The shortfall is the seasonal term the plan did not cover.`
          : "The plan covers the seasonal peak at the chosen percentile.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("demand-forecast", "demand", "forecast", clamp(v.seasonalFactor / 2), "ok"),
      edge("forecast-plan", "forecast", "plan", clamp(Number(p["seasonalTermPct"] ?? 100) / 100), health),
      edge("plan-peak", "plan", "peak", clamp(v.utilizationPct / 100), health),
    ],
    metrics: [
      metric("peak-utilization", "Peak utilization", v.utilizationPct, "%", 85, 100, "percent"),
      metric("unplanned-peak", "Unplanned peak", v.unplannedPct, "%", 5, 15, "percent"),
      metric("shed-demand", "Demand not served", v.shedPct, "%", 1, 5, "percent"),
      metric("planned-capacity", "Planned capacity", v.plannedRps, " rps", undefined, undefined, "rps"),
      metric("seasonal-factor", "Seasonal factor", v.seasonalFactor * 100, "% of trend", undefined, undefined, "percent"),
      metric("monthly-cost", "Capacity cost", v.monthlyCostK, " k$/month", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      peakEvent: state.peakEvent ? 1 : 0,
      shortEvent: state.shortEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${Math.round(v.actualRps).toLocaleString("en-US")} rps actual against ${Math.round(v.plannedRps).toLocaleString("en-US")} rps planned: ${v.utilizationPct.toFixed(0)}% utilization, ${v.unplannedPct.toFixed(0)}% unplanned. Cost figures illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0, { peakEvent: false, shortEvent: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "peak-utilization",
    metricId: "peak-utilization",
    warn: 85,
    crit: 100,
    title: "The seasonal peak uses all of the planned capacity",
    cause:
      "Actual demand has reached the capacity plan. The plan was built from a trend forecast, a seasonal term that does not cover the real uplift, or a percentile that is too low for the peak month.",
    fix:
      "Add the seasonal term to the forecast and plan the peak month against a high percentile of demand, not the trend line. If capacity cannot be added in time, shed or queue low-priority work deliberately.",
    checkFirst: [
      "Compare actual demand with the trend and the seasonal factor.",
      "Check whether the plan includes a seasonal term and which percentile it uses.",
      "Check when the peak arrives and whether capacity can be added before it.",
    ],
  },
  {
    id: "unplanned-peak",
    metricId: "unplanned-peak",
    warn: 5,
    crit: 15,
    title: "Demand is above the capacity plan",
    cause:
      "The seasonal peak was larger than the plan, or the forecast omitted the season. The gap is the demand the plan did not anticipate, and it grows with every month of trend growth.",
    fix:
      "Re-plan from a seasonal forecast with an uncertainty band. Do not wait for the peak month to autoscale; reserved or purchased capacity may need lead time.",
    checkFirst: [
      "Separate trend growth from the seasonal multiplier.",
      "Compare the plan with the observed peak in prior years.",
      "Check whether the forecast was refreshed after the last peak.",
    ],
  },
  {
    id: "shed-demand",
    metricId: "shed-demand",
    warn: 1,
    crit: 5,
    title: "The peak is bigger than the capacity plan can serve",
    cause:
      "Actual demand exceeds planned capacity, so the fleet must reject or queue work. The unserved share is the direct user impact of planning against a point estimate.",
    fix:
      "Restore capacity first, then fix the forecast. A reactive autoscaler may add capacity after the peak has already arrived; the plan needs to cover the lead time.",
    checkFirst: [
      "Check whether the errors are rejections, timeouts, or queue waits.",
      "Check whether capacity is still launching.",
      "Check the peak's timing against the forecast's seasonal shape.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const seasonalForecastModel: SimModel = {
  id: "capacity-seasonal-forecast",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const values = compute(p, t);
    const peakEvent = frame.flags.peakEvent === 1 || values.seasonalFactor > 1.02;
    const shortEvent = frame.flags.shortEvent === 1 || values.unplannedPct > 0;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t, { peakEvent, shortEvent });
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (peakEvent && frame.flags.peakEvent !== 1) {
      pushEvent(next, {
        id: "seasonal-ramp",
        at: t,
        severity: "info",
        title: "The seasonal ramp has started",
        detail: `The seasonal factor is ${values.seasonalFactor.toFixed(2)}x and rising toward ${(1 + Number(p["decemberUpliftPct"] ?? 40) / 100).toFixed(2)}x. The plan assumes ${(Number(p["seasonalTermPct"] ?? 100)).toFixed(0)}% of the uplift.`,
        nodeId: "demand",
        metricId: "seasonal-factor",
      });
    }
    if (shortEvent && frame.flags.shortEvent !== 1) {
      pushEvent(next, {
        id: "plan-shortfall",
        at: t,
        severity: values.unplannedPct >= 15 ? "crit" : "warn",
        title: "Demand has passed the capacity plan",
        detail: `Actual demand is ${values.unplannedPct.toFixed(1)}% above the plan. Planned capacity is ${Math.round(values.plannedRps).toLocaleString("en-US")} rps against ${Math.round(values.actualRps).toLocaleString("en-US")} rps of demand.`,
        nodeId: "plan",
        metricId: "unplanned-peak",
      });
    }

    next.flags.peakEvent = peakEvent ? 1 : 0;
    next.flags.shortEvent = shortEvent ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `Demand is at ${value("seasonal-factor").toFixed(0)}% of trend and ${value("peak-utilization").toFixed(0)}% of the plan.`,
    ];
    if (value("unplanned-peak") > 0) {
      items.push(
        `${value("unplanned-peak").toFixed(1)}% of demand is above the plan, and ${value("shed-demand").toFixed(1)}% cannot be served. A wider band on a linear forecast does not add the missing season.`,
      );
    }
    items.push(
      "Seasonality sets when the peak arrives; growth sets how high it is; the planning percentile sets the capacity you buy for the uncertainty that remains.",
    );
    return items;
  },
  legend: [
    { label: "Within plan", tone: "ok" },
    { label: "Tight", tone: "warn" },
    { label: "Above plan", tone: "crit" },
    { label: "No data", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 30% seasonal uplift in the forecast, planned at the 95th percentile with a 15% error band.",
    tone: "ok",
    params: defaults({
      annualGrowthPct: 20,
      decemberUpliftPct: 30,
      seasonalTermPct: 100,
      planningPercentile: 95,
      forecastErrorPct: 15,
    }),
  },
  {
    id: "peak",
    label: "Point estimate",
    description: "The season is in the forecast, but the plan is the 50th percentile: it serves the peak with no buffer.",
    tone: "warn",
    params: defaults({
      annualGrowthPct: 20,
      decemberUpliftPct: 40,
      seasonalTermPct: 100,
      planningPercentile: 50,
      forecastErrorPct: 10,
    }),
  },
  {
    id: "failure",
    label: "The linear forecast",
    description: "A 60% December uplift with no seasonal term and a point-estimate plan.",
    tone: "crit",
    params: defaults({
      annualGrowthPct: 20,
      decemberUpliftPct: 60,
      seasonalTermPct: 0,
      planningPercentile: 50,
      forecastErrorPct: 15,
    }),
  },
  {
    id: "hedged-linear",
    label: "Wide band, wrong shape",
    description: "A 99th-percentile band on a linear forecast; it narrows the gap and still misses the peak.",
    tone: "warn",
    params: defaults({
      annualGrowthPct: 20,
      decemberUpliftPct: 40,
      seasonalTermPct: 0,
      planningPercentile: 99,
      forecastErrorPct: 25,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The seasonal term is back and the plan covers the 95th percentile of a 40% uplift.",
    tone: "ok",
    params: defaults({
      annualGrowthPct: 20,
      decemberUpliftPct: 40,
      seasonalTermPct: 100,
      planningPercentile: 95,
      forecastErrorPct: 15,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-seasonal-plan",
  title: "Predict the change that covers the December peak",
  simId: "seasonal-forecast",
  question:
    "Traffic grows 20% over the year and December runs 60% above trend. The plan is a linear forecast at the 50th percentile. Which change covers the peak?",
  prediction: {
    options: [
      { id: "percentile", label: "Keep the linear forecast and plan at the 99th percentile" },
      { id: "seasonal", label: "Add the seasonal term and plan the peak at the 95th percentile" },
      { id: "error", label: "Widen the forecast error band without adding the season" },
      { id: "react", label: "Wait for December and let autoscaling add capacity" },
    ],
    correctOptionId: "seasonal",
    explanation:
      "A 99th-percentile band on a linear forecast still centers on the wrong shape; at a 15% error band it covers about 35% above trend, not 60%. Widening the error band is the same mistake with a larger number. Autoscaling reacts after the peak arrives and cannot cover lead time for reserved or purchased capacity. Adding the seasonal term puts the center of the forecast on the peak, and the 95th percentile covers the remaining error.",
  },
  setup: defaults({
    annualGrowthPct: 20,
    decemberUpliftPct: 60,
    seasonalTermPct: 0,
    planningPercentile: 50,
    forecastErrorPct: 15,
  }),
  runFor: 60,
  observe: [
    "The seasonal ramp starts at 20 seconds and reaches full uplift by 50 seconds.",
    "The plan stays flat at the trend line, so utilization follows the seasonal factor.",
    "Utilization crosses 100% as soon as the ramp begins; the peak is about 60% above trend.",
    "About 37% of December demand is above the plan and cannot be served.",
  ],
  explain:
    "A forecast has a trend, a seasonal shape, and an uncertainty band. The band describes how wrong the forecast might be around its center; it cannot move the center. If the seasonal term is missing, a wider band buys capacity in the wrong month and still underprovisions the peak. The fix is to model the shape first, then choose the percentile for the remaining error.",
  fix: defaults({
    annualGrowthPct: 20,
    decemberUpliftPct: 60,
    seasonalTermPct: 100,
    planningPercentile: 95,
    forecastErrorPct: 15,
  }),
  debrief:
    "With the seasonal term at 100% and the 95th percentile, the plan covers the 60% uplift plus a 24.75% error band. Peak utilization is about 80%, so the plan serves December with room for the forecast error. The cost is capacity that sits idle in the quiet months; that is the price of planning against a percentile rather than a point.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A seasonal forecast separates three things that a single growth line conflates: the trend, the recurring shape, and the uncertainty around both. The trend says the business is larger than last year. The seasonal shape says December is 40% above the trend. The uncertainty band says the forecast is not exact. Capacity planning needs all three, because the peak is set by the shape and the risk is set by the band.",
  },
  {
    type: "p",
    text: "A linear forecast can be accurate on an annual average and wrong in every December. Widening its confidence band does not repair the shape; it buys capacity around a center that is in the wrong place. The planning percentile is the lever for the remaining uncertainty, not a substitute for seasonality.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is demand history, forecast, capacity plan, and procurement or autoscaling. The forecast sets the plan; the plan sets the capacity that must exist before the peak. Autoscaling can cover some of the gap, but only after the load arrives and only within the capacity that can be launched. Reserved or purchased capacity has a lead time that a reactive policy cannot compress.",
  },
  {
    type: "table",
    headers: ["Forecast", "Center", "Band", "December outcome"],
    rows: [
      ["Linear, 50th percentile", "Trend only", "None", "Peak far above plan; shedding"],
      ["Linear, 99th percentile", "Trend only", "Wide", "Better, still short of a large seasonal uplift"],
      ["Seasonal, 50th percentile", "Trend plus season", "None", "Peak served with no buffer"],
      ["Seasonal, 95th percentile", "Trend plus season", "Moderate", "Peak served with room for error"],
    ],
  },
  {
    type: "p",
    text: "The model uses a 10,000 requests-per-second (rps) baseline, a smooth seasonal ramp from 20 to 50 simulated seconds, a normal-style percentile lookup, and an illustrative cost per rps-month. The numbers are teaching values, not a forecast for a real business.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Actual demand, trend, and the seasonal factor across the compressed year.",
      "Peak utilization against the plan, plus the share of demand above the plan.",
      "Demand not served when the plan is short, so the forecast error becomes a user impact.",
      "Planned capacity and its monthly cost, so the percentile has a price.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then apply The linear forecast. Watch utilization follow the seasonal factor after 20 seconds. Compare Wide band, wrong shape with Recovery, then run the guided experiment before changing sliders.",
  },
  { type: "sim", simId: "seasonal-forecast" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The plan was built from the trend line with no seasonal term and no uncertainty. At 20 seconds the seasonal ramp started, and actual demand rose above the flat plan. Utilization followed the seasonal factor exactly: as soon as the ramp began, the plan was short. By the peak, demand was 60% above trend, about 37% of it was above the plan, and that share could not be served.",
  },
  {
    type: "p",
    text: "The wide-band preset raised the percentile to 99 and widened the error assumption. It bought more capacity, but around the wrong center, so the peak still exceeded the plan. The recovery preset added the seasonal term and planned at the 95th percentile. Utilization at the peak fell to about 80%, leaving room for the forecast error.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Demand history by month, with the trend and seasonal index separated. A year-over-year percentage without the seasonal shape hides the peak.",
      "Forecast versus actual: a growing bias in the peak months, not a uniform error across the year.",
      "Capacity lead time: instances, reserved capacity, or commitments that must be purchased before the peak.",
      "Utilization and shed load in the peak month, with the first error timestamp against the forecast date.",
      "Cost: the idle capacity the percentile buys in the quiet months, not only the peak-month bill.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Separate trend from seasonality in the demand history. Check whether the plan includes a seasonal term and which percentile it uses. Compare the plan's lead time with the date the peak arrives. Then check whether the gap is a forecast error or a capacity that never existed.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Plot demand by month with the trend and the seasonal index separately; do not fit a single line through a recurring peak.",
      "Add the seasonal term to the forecast and validate it against at least two prior peaks.",
      "Choose the planning percentile from the cost of being short and the cost of idle capacity, not from a default.",
      "Account for lead time: capacity that must be purchased or reserved has to be ordered before the peak, not after it.",
      "Keep a reactive autoscaling layer for forecast error inside the planned envelope, and alert when demand leaves the band.",
      "Refresh the forecast after each peak and record whether the error was in the trend, the season, or the band.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher percentile covers more of the peak and runs more idle capacity in the quiet months.",
      "A seasonal model is more accurate at the peak and needs more history and more maintenance than a line.",
      "Reactive autoscaling reduces the planning burden for small errors and cannot cover lead time or a step change.",
      "Reserved capacity lowers the unit cost and reduces flexibility if the seasonal shape moves.",
      "Planning to the average is cheap eleven months a year and expensive in the month that matters.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "seasonal-forecast",
    question:
      "Traffic grows 40% every December and the forecast is linear. What do you change?",
    difficulty: 3,
    hints: [
      "A line can fit the annual average and miss every peak.",
      "Separate the trend from the seasonal index before choosing capacity.",
    ],
    answer:
      "I would decompose the history into trend and seasonality instead of fitting one line. The trend sets the base for the year; the seasonal index sets the peak month; the residual sets the uncertainty band. I would plan capacity for the peak month at a high percentile of that distribution, not for the annual average. Then I would check lead time: if capacity or commitments must be purchased, the decision date is before the peak, not in it. Autoscaling covers forecast error inside the envelope, not a missing seasonal term.",
    followUps: [
      "How many years of history would you use?",
      "How would you validate the seasonal index?",
      "What if December moves?",
    ],
    redFlags: [
      "Extends the line and adds a flat buffer.",
      "Uses the annual average.",
      "Relies on autoscaling alone.",
    ],
    rubric: [
      "Separates trend and season.",
      "Plans a percentile.",
      "Accounts for lead time.",
      "Validates against prior peaks.",
    ],
  },
  {
    id: "percentile-choice",
    question:
      "How would you choose the planning percentile for a seasonal peak?",
    difficulty: 3,
    hints: [
      "Compare the cost of being short with the cost of idle capacity.",
      "The percentile is not the same as the forecast's confidence.",
    ],
    answer:
      "I would compare the cost of unserved demand with the cost of idle capacity across the candidate percentiles. A 95th percentile means the plan covers 95% of the forecast distribution; the remaining 5% is the risk we accept. For a peak with inelastic demand and a hard SLO, that risk may be too high. For a batch workload with retries, a lower percentile may be fine. I would also check that the distribution includes the seasonal shape and that the plan can be delivered before the peak.",
    followUps: [
      "What does the 95th percentile mean here?",
      "How would you price the shortfall?",
      "Would you use a different percentile by month?",
    ],
    redFlags: [
      "Picks 95% because it is common.",
      "Treats the percentile as a guarantee.",
      "Ignores lead time.",
    ],
    rubric: [
      "Weighs both costs.",
      "Explains the percentile.",
      "Considers SLO and demand shape.",
      "Checks deliverability.",
    ],
  },
  {
    id: "forecast-miss",
    question:
      "December came in 30% above the plan. Was the forecast wrong, the capacity wrong, or both?",
    difficulty: 3,
    hints: [
      "Separate the forecast error from the delivery of the plan.",
      "Check whether the plan included the season and which percentile it used.",
    ],
    answer:
      "I would separate three questions: did the forecast center include the season, was the chosen percentile high enough, and did the planned capacity actually exist in December? If the plan omitted the seasonal term, the forecast was wrong. If it included the season but planned at the median, the percentile was too low for the risk. If the plan was right but capacity arrived late or was reserved for another workload, the delivery was wrong. The fix differs for each, so I would not call it a forecast problem until I had checked all three.",
    followUps: [
      "Which signal would distinguish them?",
      "What would you change for next December?",
      "How would you test the plan before the peak?",
    ],
    redFlags: [
      "Blames the forecast without checking delivery.",
      "Adds a flat buffer for next year.",
      "Ignores the percentile.",
    ],
    rubric: [
      "Separates forecast, percentile, and delivery.",
      "Uses evidence for each.",
      "Names a specific fix.",
      "Plans a validation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The demand history is decomposed into trend, seasonal index, and residual.",
      "The capacity plan states its seasonal term and planning percentile.",
      "Capacity or commitments are ordered before the peak's lead time, not during it.",
      "A reactive autoscaling layer covers forecast error inside the planned envelope.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether demand is above the plan's center or above its percentile.",
      "Check whether the planned capacity exists and is healthy.",
      "Shed or queue low-priority work deliberately if the peak cannot be served.",
      "Record the first time demand left the band and the forecast date it was based on.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Attribute the miss to trend, season, percentile, or delivery.",
      "Refresh the seasonal index with the new peak.",
      "Re-price the planning percentile against the observed shortfall.",
      "Test the next peak plan against a stress case above the chosen percentile.",
    ],
  },
];

const references = [
  {
    title: "Google SRE Workbook: Managing Load",
    url: "https://sre.google/workbook/managing-load/",
    publisher: "Google",
    kind: "book" as const,
    note: "Capacity planning from demand history, including seasonal peaks and headroom.",
  },
  {
    title: "Amazon EC2 Auto Scaling: predictive scaling",
    url: "https://docs.aws.amazon.com/autoscaling/ec2/userguide/ec2-auto-scaling-predictive-scaling.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Forecast-based scaling for recurring patterns and the limits of reactive capacity.",
  },
  {
    title: "AWS Well-Architected Reliability Pillar: capacity planning",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_planning_capacity_provisioning.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Plan for peak and failure, and validate the plan with testing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "seasonal-forecast": {
      model: seasonalForecastModel,
      presets,
      instructions:
        "Start healthy, then apply The linear forecast. Watch the seasonal ramp after 20 seconds. Compare Wide band, wrong shape with Recovery, then run the guided experiment.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline", "heatmap"],
      note: "Illustrative model. The year is compressed into 60 simulated seconds; baseline, growth, seasonality, error bands, and cost are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-capacity-models",
    "capacity-peak-events",
    "capacity-autoscaling-policies",
    "capacity-headroom-cost",
    "capacity-scheduled-scaling",
  ],
};
