import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SCALE_CEILING_K = 1_000;
const SCALE_GROWTH = 1.8;
const RAMP_START = 2;
const RAMP_LENGTH = 38;

const params = [
  {
    id: "usersK",
    label: "Active users",
    min: 1,
    max: 1_000,
    step: 1,
    value: 50,
    unit: " k",
    group: "Scale",
    help: "Paying users at the end of the growth ramp. The model starts at a quarter of this target and grows over about 40 simulated seconds.",
    format: "count" as const,
  },
  {
    id: "pricePerUser",
    label: "Revenue per user",
    min: 1,
    max: 30,
    step: 0.5,
    value: 6,
    unit: " $/month",
    group: "Price",
    help: "Blended monthly revenue per active user before infrastructure cost. Illustrative.",
    format: "number" as const,
  },
  {
    id: "variableCostPerUser",
    label: "Variable cost per user",
    min: 0.5,
    max: 20,
    step: 0.5,
    value: 3,
    unit: " $/month",
    group: "Cost",
    help: "Compute, storage, network, and telemetry at small scale. The model adds a scale penalty as data and support grow. Illustrative.",
    format: "number" as const,
  },
  {
    id: "fixedCostK",
    label: "Fixed monthly cost",
    min: 1,
    max: 200,
    step: 1,
    value: 20,
    unit: " k$",
    group: "Cost",
    help: "Cost that does not move with users in this model: baseline platform, minimum capacity, and standing contracts. Illustrative.",
    format: "number" as const,
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

function currentUsersK(p: Params, t: number): number {
  const target = Math.max(1, num(p, "usersK", 50));
  const progress = smoothstep((t - RAMP_START) / RAMP_LENGTH);
  return target * (0.25 + 0.75 * progress);
}

function scaleFactor(usersK: number): number {
  return 1 + SCALE_GROWTH * Math.pow(clamp(usersK / SCALE_CEILING_K), 2);
}

interface Computed {
  usersK: number;
  price: number;
  baseVariable: number;
  variablePerUser: number;
  fixedCost: number;
  revenue: number;
  variableCost: number;
  totalCost: number;
  profit: number;
  loss: number;
  costToRevenue: number;
  fixedPerUser: number;
  contribution: number;
  contributionShortfall: number;
}

function compute(p: Params, t: number): Computed {
  const usersK = currentUsersK(p, t);
  const price = Math.max(0, num(p, "pricePerUser", 6));
  const baseVariable = Math.max(0, num(p, "variableCostPerUser", 3));
  const fixedCost = Math.max(0, num(p, "fixedCostK", 20)) * 1_000;
  const variablePerUser = baseVariable * scaleFactor(usersK);
  const userCount = usersK * 1_000;
  const revenue = userCount * price;
  const variableCost = userCount * variablePerUser;
  const totalCost = variableCost + fixedCost;
  const profit = revenue - totalCost;
  return {
    usersK,
    price,
    baseVariable,
    variablePerUser,
    fixedCost,
    revenue,
    variableCost,
    totalCost,
    profit,
    loss: Math.max(0, -profit) / 1_000,
    costToRevenue: (totalCost / Math.max(1, revenue)) * 100,
    fixedPerUser: fixedCost / Math.max(1, userCount),
    contribution: price - variablePerUser,
    contributionShortfall: Math.max(0, variablePerUser - price),
  };
}

function economicsHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.costToRevenue >= 100 || values.loss >= 50) return "crit";
  if (values.costToRevenue >= 85 || values.loss >= 10) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["cost-to-revenue", values.costToRevenue, 0.8],
    ["monthly-loss", values.loss, 1.2],
    ["scale", values.usersK, 0.4],
    ["variable-cost-per-user", values.variablePerUser, 0.03],
    ["contribution-shortfall", values.contributionShortfall, 0.02],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + (seed % 13)) / 3.1);
      return Math.max(0, value * (0.98 + 0.02 * wave) + amplitude * Math.sin(index / 2.4));
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  t: number,
  seed: number,
  state: { marginEvent: boolean },
): SimFrame {
  const values = compute(p, t);
  const health = economicsHealth(values);
  return {
    t: 0,
    nodes: [
      {
        id: "users",
        label: "Active users",
        kind: "client",
        health: "ok",
        sublabel: `${values.usersK.toFixed(0)}k users · ${((values.usersK / SCALE_CEILING_K) * 100).toFixed(0)}% of ceiling`,
        meta: { view: "flow" },
      },
      {
        id: "product",
        label: "Product",
        kind: "service",
        role: "instance",
        health,
        sublabel: `${values.price.toFixed(2)}$ revenue/user`,
        detail: `Contribution per user before fixed cost is ${values.contribution.toFixed(2)}$. Total monthly profit is ${(values.profit / 1_000).toFixed(0)}k$. Illustrative figures.`,
        meta: { view: "flow" },
      },
      {
        id: "data",
        label: "Data and compute",
        kind: "db",
        health: values.variablePerUser > values.price ? "crit" : values.variablePerUser > values.price * 0.85 ? "warn" : "ok",
        sublabel: `${values.variablePerUser.toFixed(2)}$ variable/user`,
        detail: "Compute, storage, network, and telemetry. The model raises this per-user cost as stored history and support volume grow.",
        meta: { view: "flow" },
      },
      {
        id: "fixed",
        label: "Fixed base",
        kind: "worker",
        health: "ok",
        sublabel: `${(values.fixedCost / 1_000).toFixed(0)}k$/month`,
        detail: `Fixed cost per user is ${values.fixedPerUser.toFixed(2)}$ at this scale. It falls as users grow, but only if the fixed base does not step up.`,
        meta: { view: "flow" },
      },
      {
        id: "margin",
        label: "Monthly margin",
        kind: "storage",
        health,
        sublabel: values.profit >= 0 ? `${(values.profit / 1_000).toFixed(0)}k$ profit` : `${values.loss.toFixed(0)}k$ loss`,
        detail: values.profit >= 0 ? "Revenue covers variable cost and the fixed base at this scale." : "The contribution per user is negative or the fixed base is not covered at this scale.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("users-product", "users", "product", 1, health),
      edge("product-data", "product", "data", clamp(values.variableCost / Math.max(1, values.revenue)), health),
      edge("product-fixed", "product", "fixed", clamp(values.fixedCost / Math.max(1, values.revenue)), "ok"),
      edge("product-margin", "product", "margin", clamp(Math.abs(values.profit) / Math.max(1, values.revenue)), health),
    ],
    metrics: [
      metric("cost-to-revenue", "Total cost-to-revenue ratio", values.costToRevenue, "%", 85, 100, "percent"),
      metric("monthly-loss", "Monthly loss", values.loss, " k$", 10, 50, "number"),
      metric("scale", "Active users", values.usersK, " k", undefined, undefined, "count"),
      metric("variable-cost-per-user", "Variable cost per user", values.variablePerUser, " $", undefined, undefined, "number"),
      metric("contribution-shortfall", "Contribution shortfall", values.contributionShortfall, " $/user", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      marginEvent: state.marginEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.usersK.toFixed(0)}k users at ${values.price.toFixed(2)}$ revenue and ${values.variablePerUser.toFixed(2)}$ variable cost per user. Cost is ${values.costToRevenue.toFixed(0)}% of revenue; monthly result is ${(values.profit / 1_000).toFixed(0)}k$. Illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, 0, seed, { marginEvent: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cost-to-revenue",
    metricId: "cost-to-revenue",
    warn: 85,
    crit: 100,
    title: "Total cost exceeds revenue",
    cause:
      "The total cost-to-revenue ratio compares all modelled cost, including the fixed base, with revenue. Above 100%, total cost is above total revenue. That can be fixed-cost recovery at low volume even when contribution per user is positive, or it can be a negative contribution at scale. Check the contribution shortfall before choosing a fix.",
    fix:
      "If contribution is negative, reduce variable cost per user or raise the price for the segment that drives it. If contribution is positive, grow volume or reduce the fixed base. Cutting fixed cost cannot rescue a unit sold below variable cost.",
    checkFirst: [
      "Compare revenue per user with variable cost per user, not with total cost per user.",
      "Split variable cost into compute, storage, network, and telemetry per user.",
      "Check whether the scale penalty comes from data growth, support volume, or a shared resource.",
    ],
  },
  {
    id: "monthly-loss",
    metricId: "monthly-loss",
    warn: 10,
    crit: 50,
    title: "The feature is losing money at the current scale",
    cause:
      "Total cost is above total revenue. At low scale the fixed base dominates; at high scale a negative contribution per user dominates. The same loss number can have opposite fixes, so the split matters.",
    fix:
      "Separate fixed-cost recovery from variable-cost contribution. If contribution is positive, grow or reduce the fixed base. If contribution is negative, change the cost structure or the price before adding users.",
    checkFirst: [
      "Check contribution per user before looking at total profit.",
      "Check fixed cost per user and whether a fixed step is due.",
      "Check whether the loss is concentrated in one cohort, plan, or usage pattern.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const unitEconomicsModel: SimModel = {
  id: "capacity-unit-economics",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    let marginEvent = fresh ? false : frame.flags.marginEvent === 1;
    const values = compute(p, t);

    const next = buildFrame(p, t, Number(frame.flags.seed ?? 20261110), { marginEvent });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!marginEvent && values.usersK > 500 && values.contribution <= 0) {
      pushEvent(next, {
        id: "negative-contribution",
        at: t,
        severity: "crit",
        title: "Variable cost has passed revenue per user",
        detail: `At ${values.usersK.toFixed(0)}k users, variable cost is ${values.variablePerUser.toFixed(2)}$ against ${values.price.toFixed(2)}$ of revenue. Growth now increases the loss.`,
        nodeId: "product",
        metricId: "cost-to-revenue",
      });
      marginEvent = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      marginEvent: marginEvent ? 1 : 0,
      paramsKey: key,
      seed: Number(frame.flags.seed ?? 20261110),
    };

    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const users = value("scale");
    const ratio = value("cost-to-revenue");
    const loss = value("monthly-loss");
    const variable = value("variable-cost-per-user");
    const shortfall = value("contribution-shortfall");
    const items: string[] = [
      `${users.toFixed(0)}k users, a ${ratio.toFixed(0)}% total cost-to-revenue ratio, and ${loss.toFixed(0)}k$ of monthly loss. Illustrative figures.`,
      `Variable cost is ${variable.toFixed(2)}$ per user. Compare that with revenue per user before blaming the fixed base.`,
    ];
    if (ratio >= 100 && shortfall > 0.01) {
      items.push("Contribution per user is negative. More users make the total worse, so growth is not the fix; change the variable cost or the price.");
    } else if (ratio >= 100) {
      items.push("Contribution per user is positive, but the fixed base is not covered at this scale. Growth or a smaller fixed base can close the gap.");
    } else if (ratio >= 85) {
      items.push("The unit still contributes, but the total margin is thin enough that a small cost increase or price cut removes it.");
    } else {
      items.push("The unit contributes. The remaining question is whether the fixed base is covered at the scale you can reach.");
    }
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Thin margin", tone: "warn" },
    { label: "Below cost", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "50k users at 6$ revenue and a 3$ base variable cost; the fixed base is covered.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Profitable at scale",
    description: "800k users at 7$ revenue; the scale penalty raises cost but the unit still contributes.",
    tone: "ok",
    params: defaults({ usersK: 800, pricePerUser: 7, variableCostPerUser: 2.5, fixedCostK: 60 }),
  },
  {
    id: "failure",
    label: "Growth turns negative",
    description: "1M users at 6$ revenue and 3$ base cost; storage and support growth push variable cost past the price.",
    tone: "crit",
    params: defaults({ usersK: 1_000, pricePerUser: 6, variableCostPerUser: 3, fixedCostK: 20 }),
  },
  {
    id: "subscale",
    label: "Subscale",
    description: "2k users cannot cover a 8k$ fixed base; the loss is fixed-cost recovery, not negative contribution.",
    tone: "crit",
    params: defaults({ usersK: 2, pricePerUser: 6, variableCostPerUser: 3, fixedCostK: 8 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "300k users at 7$ revenue and a 2$ base cost; contribution and the fixed base both clear.",
    tone: "ok",
    params: defaults({ usersK: 300, pricePerUser: 7, variableCostPerUser: 2, fixedCostK: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-scale-fix",
  title: "Predict which change restores unit margin",
  simId: "unit-economics",
  question:
    "At 1M users, revenue is 6$ per user and variable cost has grown to 8.40$ per user. Fixed cost is 20k$ per month. Which change makes the unit contribute again?",
  prediction: {
    options: [
      { id: "fixed", label: "Cut the fixed monthly cost in half" },
      { id: "price", label: "Raise the price by 30%" },
      { id: "variable", label: "Cut the base variable cost per user by 40%" },
      { id: "users", label: "Add 200k more users to spread the fixed cost" },
    ],
    correctOptionId: "variable",
    explanation:
      "At this scale the scale penalty has made variable cost the dominant term. Cutting fixed cost leaves the negative contribution untouched. A 30% price increase reaches 7.80$, still below the 8.40$ variable cost. Adding users makes the loss larger because each one is sold below cost. Reducing the base variable cost by 40% brings variable cost to about 5.04$, below the 6$ price, so contribution turns positive.",
  },
  setup: defaults({ usersK: 1_000, pricePerUser: 6, variableCostPerUser: 3, fixedCostK: 20 }),
  runFor: 45,
  observe: [
    "Users ramp from 250k to 1M while the fixed base stays at 20k$ per month.",
    "Variable cost per user rises from about 3.34$ to about 8.40$ as the modelled scale penalty grows.",
    "Total cost-to-revenue crosses 100% late in the ramp; monthly loss reaches roughly 2.4M$.",
    "The fixed-cost share of the bill falls even though the loss is growing.",
  ],
  explain:
    "Unit economics separate contribution from fixed-cost recovery. Contribution per user is price minus variable cost. When it is positive, growth spreads the fixed base and improves the result. When it is negative, growth multiplies the loss. Here the variable cost rose because storage, support, and telemetry per user grew with the installed base; the fixed base was never the main problem.",
  fix: defaults({ usersK: 1_000, pricePerUser: 6, variableCostPerUser: 1.8, fixedCostK: 20 }),
  debrief:
    "Cutting the base variable cost to 1.8$ brings cost to about 5.04$ per user and turns the monthly result positive at 1M users. A price increase alone would not close the gap in this model. The tradeoff is real: re-architecting storage and support may add engineering cost, and a price increase may lose users. The numbers are illustrative; the order of operations is the lesson.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Unit economics is the margin on one unit of the product: one user, one order, one job, one tenant. It has two layers. Contribution margin is revenue per unit minus variable cost per unit. It answers whether adding one more unit helps or hurts. Total profit is contribution multiplied by volume, minus fixed cost. It answers whether the business covers its standing costs at the scale it has reached. A feature can look healthy at small scale because the fixed base is small, and fail at large scale because variable cost per unit rose. The reverse also happens: a feature can lose money at small scale because fixed cost is spread over too few units, then become profitable as volume grows.",
  },
  {
    type: "p",
    text: "The costs in the variable layer are not only compute. Storage grows with retained history. Network grows with payloads and cross-zone calls. Observability grows with cardinality, logs, and traces. Support grows with the number of accounts and the complexity of their usage. Some of these grow linearly with users; others grow faster because each user's data accumulates or because a shared resource becomes less efficient near saturation. A unit-economics model has to state which behavior it assumes. This module applies a scale penalty to variable cost per user, which is a teaching device for the common case where storage and support grow faster than the user count. It is not a claim about any specific service.",
  },
  {
    type: "p",
    text: "The model is deliberately simple: users, revenue per user, variable cost per user, and fixed monthly cost. It reports total cost-to-revenue, monthly loss, and variable cost per user. Total cost-to-revenue above 100% means all modelled cost exceeds revenue. That does not by itself tell you whether the unit contributes: compare variable cost per user with revenue per user. A positive contribution with a ratio above 100% is a fixed-cost recovery problem; a negative contribution is a unit problem. The two signals have to be read together.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Unit economics sits above the request path. The product turns users into usage; usage turns into compute, storage, network, and telemetry; those turn into a bill. The bill is then compared with revenue. A capacity decision that lowers cost per request improves the unit only if the saving reaches the unit that generates revenue. A shared platform cost that is allocated by request count can make a low-volume feature look cheap and a high-volume feature look expensive, or the reverse. The allocation rule is part of the model, not an afterthought.",
  },
  {
    type: "table",
    headers: ["Scale", "What dominates", "Symptom", "First check"],
    rows: [
      ["1k users", "Fixed base per user", "Large loss, positive contribution", "Fixed cost and the scale needed to cover it"],
      ["100k users", "Variable cost per user", "Thin or negative margin", "Cost per user by dimension"],
      ["1M users", "Scale penalty and mix", "Contribution turns negative", "Storage, support, and telemetry per user"],
      ["Plateau", "Fixed base and idle capacity", "Margin stops improving with growth", "Utilization and step costs"],
    ],
  },
  {
    type: "p",
    text: "Revenue per user is a modelled input, not a pricing recommendation. The model does not know willingness to pay, churn, or competitor prices. It only shows whether the current price covers the current cost structure. That is enough to reject a launch that cannot work at any plausible scale, and to identify which cost dimension has to change before the price can be defended.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Total cost-to-revenue, with warning at 85% and critical at 100% in this illustrative model.",
      "Monthly loss in thousands of dollars, with its own warning and critical lines.",
      "Variable cost per user, which rises with the modelled scale penalty.",
      "Contribution shortfall, which is positive only when variable cost exceeds revenue per user.",
      "A product flow from users to product, data and compute, fixed base, and monthly margin.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and watch the cost-to-revenue ratio settle below the warning line. Apply Growth turns negative and watch the variable cost per user climb past revenue while the fixed base stays flat. Run the guided experiment before changing sliders. Then compare Subscale with Recovery: the same warning can come from a fixed base that is too large or from a variable cost that exceeds the price. All dollar figures are illustrative.",
  },
  { type: "sim", simId: "unit-economics" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The user base grew from 250k to 1M. Revenue per user stayed at 6$. Variable cost per user rose from about 3.34$ to about 8.40$ because the model applies a scale penalty for storage, support, and telemetry. Contribution per user turned negative, so each additional user increased the loss. Total cost-to-revenue crossed 100% and the monthly loss reached about 2.4M$ at 1M users. All figures in this module are illustrative.",
  },
  {
    type: "p",
    text: "The fixed base was never the driver. It stayed at 20k$ per month, and fixed cost per user fell throughout the run. That is the trap in the production question: a falling fixed share looks like improving efficiency, while the variable layer is quietly turning negative. The order of diagnosis matters. Contribution first, fixed cost second.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Revenue and user counts by plan, cohort, and tenant, not only in aggregate. A blended average hides a segment sold below cost.",
      "Cost per user by dimension: compute, storage, network, and telemetry. The fastest-growing line is the one that will set the margin.",
      "AWS Cost Explorer and the Cost and Usage Report grouped by allocation tags for the feature or tenant.",
      "Storage and retention growth after user growth stops. Data cost often peaks later than compute cost.",
      "Support volume and escalation rate per account. These are real variable costs that infrastructure dashboards miss.",
      "Unit-cost dashboards with a stable denominator and a named owner for each line.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compute contribution per user before total profit. If contribution is negative, the problem is the unit, not the fixed base. If contribution is positive but the total is negative, the problem is scale or fixed-cost recovery. Then split variable cost into its dimensions and find the one that grows faster than users.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Define the unit and the time window: one active user per month, one order, or one tenant. Keep it stable.",
      "Compute contribution margin per unit: revenue minus variable cost. Do not allocate fixed cost into this number.",
      "Find the variable dimension that grows faster than the unit count. Storage retention, telemetry cardinality, and support are common.",
      "Reduce that dimension or change the product so it does not grow with stored history. Tiering, retention limits, sampling, and batching are examples.",
      "If the cost is inherent, change the price or the packaging for the segment that creates it. A single blended price can subsidize the expensive segment.",
      "Recheck the fixed base separately. A subscale loss and a negative-contribution loss need different fixes.",
      "Put the unit margin on the same review as the bill, with a threshold that fires before the total loss does.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Cutting variable cost can reduce quality, latency, or retention. A cost saving that raises churn is not a margin improvement.",
      "Raising price improves contribution only if demand holds. The model does not include churn or willingness to pay.",
      "Cutting the fixed base helps a subscale feature but cannot rescue a unit sold below variable cost.",
      "Growth is not a fix for negative contribution. It is a multiplier on whatever the unit already does.",
      "A scale penalty may be a real property of the workload or a symptom of a shared resource that needs re-architecture. The model cannot tell them apart.",
      "Allocation rules change the answer. A shared cost assigned by request count can make the wrong unit look expensive.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-scale",
    question:
      "A feature is profitable at 1k users and loses money at 1M. Walk me through the diagnosis.",
    difficulty: 3,
    hints: [
      "Start with contribution per user, not total profit.",
      "Look for a cost that grows faster than the user count.",
    ],
    answer:
      "I would compute revenue per user and variable cost per user at both scales, then contribution margin. If contribution is still positive at 1M, the loss is fixed-cost recovery or a step cost. If contribution is negative, the variable layer is the problem. I would split variable cost into compute, storage, network, telemetry, and support, and find the line that grew faster than users. Storage retention, cardinality, and support volume are common. Then I would decide whether to reduce that dimension, change the packaging, or stop serving the segment. I would not cut the fixed base first; it cannot fix a negative unit.",
    followUps: [
      "Which line would you expect to grow superlinearly?",
      "How would you test the hypothesis?",
      "What if the blended average hides two segments?",
    ],
    redFlags: [
      "Starts by cutting the fixed base.",
      "Assumes growth always improves margin.",
      "Uses only the total bill.",
    ],
    rubric: [
      "Separates contribution from fixed cost.",
      "Identifies a superlinear cost dimension.",
      "Proposes a measurement.",
      "Chooses a fix after diagnosis.",
    ],
  },
  {
    id: "contribution-margin",
    question:
      "What is contribution margin, and why should fixed cost stay out of it?",
    difficulty: 2,
    hints: [
      "Contribution answers what one more unit adds.",
      "Fixed cost answers what the whole business must cover.",
    ],
    answer:
      "Contribution margin is revenue per unit minus variable cost per unit. It answers whether adding one more unit improves or worsens the result. Fixed cost is excluded because it does not change with the next unit; including it would make the unit look worse or better depending on volume, which is exactly what the metric is trying to avoid. Total profit is contribution times volume minus fixed cost. Both numbers matter, but they answer different questions. A positive contribution with a loss means the fixed base is not yet covered. A negative contribution means growth cannot fix the loss.",
    followUps: [
      "How do you decide which costs are fixed?",
      "What is a step cost, and where does it belong?",
      "How would you present both numbers to a product team?",
    ],
    redFlags: [
      "Allocates all fixed cost into unit cost.",
      "Confuses gross margin with contribution.",
      "Treats fixed cost as irrelevant to the business.",
    ],
    rubric: [
      "Defines contribution precisely.",
      "Explains why fixed cost is excluded.",
      "Connects it to total profit.",
      "Names a step cost or allocation nuance.",
    ],
  },
  {
    id: "defend-price",
    question:
      "How would you defend a price increase using unit economics without giving financial advice?",
    difficulty: 3,
    hints: [
      "Start from the cost to serve and the value the unit receives.",
      "A price is a product decision, not an infrastructure setting.",
    ],
    answer:
      "I would show the cost to serve one unit and how it changes with usage, then compare that with the value the customer gets and the price today. Unit economics can show that a segment is sold below variable cost, or that a heavy-usage segment is subsidized by a light one. It cannot set the price. I would give the product and finance owners the contribution by segment, the sensitivity to usage, and the cost of the alternatives, then let them decide the packaging. I would avoid presenting a single margin number as a recommendation, and I would not claim a price change is safe without demand data.",
    followUps: [
      "What data would you need beyond cost?",
      "How would you handle a customer with highly variable usage?",
      "What is the risk of a uniform price?",
    ],
    redFlags: [
      "Treats cost plus a fixed markup as the price.",
      "Ignores demand and churn.",
      "Presents the model as financial advice.",
    ],
    rubric: [
      "Separates cost to serve from price.",
      "Uses segment-level contribution.",
      "Names demand and value evidence.",
      "Keeps the decision with product and finance.",
    ],
  },
  {
    id: "model-before-launch",
    question:
      "How would you model unit economics before launching a feature?",
    difficulty: 3,
    hints: [
      "Use ranges, not one forecast.",
      "Include a cost that grows with stored history.",
    ],
    answer:
      "I would define the unit and the expected usage per unit, then build a range for each cost dimension: compute, storage, network, telemetry, and support. I would separate fixed costs that are incurred before the first user from variable costs that scale with usage, and include at least one step cost or superlinear term because those are what break at scale. I would run low, base, and high scenarios, and find the scale at which contribution turns negative or the fixed base is recovered. Then I would instrument the leading indicators, such as bytes per unit or downstream calls per unit, so the model can be corrected before the bill arrives.",
    followUps: [
      "Which input would you stress first?",
      "How do you avoid false precision?",
      "When would you stop the launch?",
    ],
    redFlags: [
      "Uses a single average cost per user.",
      "Omits storage and telemetry.",
      "Has no leading indicator.",
    ],
    rubric: [
      "Defines the unit and usage.",
      "Uses ranges and a superlinear term.",
      "Finds a break-even scale.",
      "Adds instrumentation.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The unit is defined and documented: user, order, job, or tenant, with a fixed time window.",
      "Revenue and variable cost are reported per unit, not only in aggregate.",
      "Variable cost is split into compute, storage, network, telemetry, and support.",
      "At least one cost dimension is modelled as superlinear or as a step.",
      "Contribution margin and fixed-cost recovery are reviewed separately.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compute contribution per unit before cutting the fixed base.",
      "Find the variable dimension that grew faster than the unit count.",
      "Check whether the loss is concentrated in a cohort, plan, or usage pattern.",
      "Check storage retention and telemetry cardinality after user growth stops.",
      "Do not assume more volume fixes a negative unit.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reduce the dominant variable cost or change the packaging for the segment that drives it.",
      "Recompute contribution and fixed-cost recovery at the current scale.",
      "Add a unit-margin alert with a stable denominator.",
      "Document the allocation rule for shared cost and revisit it when the product mix changes.",
    ],
  },
];

const references = [
  {
    title: "Cost Optimization Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Measuring workload efficiency against a business outcome, not only against total spend.",
  },
  {
    title: "Analyzing your costs and usage with AWS Cost Explorer",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/ce-what-is.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Grouping and forecasting cost by service and tag for per-unit analysis.",
  },
  {
    title: "Managing your costs with AWS Budgets",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Budget thresholds and forecast alerts, including coverage and utilization budgets.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "unit-economics": {
      model: unitEconomicsModel,
      presets,
      instructions:
        "Start healthy, then apply Growth turns negative. Watch variable cost per user cross revenue while the fixed base stays flat. Compare Subscale and Recovery to see two different loss shapes.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative business model. Prices, costs, and the scale penalty are teaching values, not AWS prices or financial advice. The model does not include churn, tax, or demand elasticity.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-cost-per-request",
    "capacity-cost-allocation",
    "capacity-reserved-instances",
    "case-composite-cost-surprise",
  ],
};
