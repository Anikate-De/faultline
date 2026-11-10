import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOURS_PER_MONTH = 730;
const RAMP_START = 5;
const RAMP_LENGTH = 40;

const params = [
  {
    id: "commitmentPerHour",
    label: "Hourly commitment (on-demand eq.)",
    min: 10,
    max: 200,
    step: 5,
    value: 50,
    unit: " $/h",
    group: "Commitment",
    help: "On-demand-equivalent spend committed per hour for the plan term. The plan discount is applied to the covered part; use your own rate from Cost Explorer. Illustrative.",
    format: "number" as const,
  },
  {
    id: "forecastUsagePerHour",
    label: "Forecast usage",
    min: 20,
    max: 250,
    step: 5,
    value: 60,
    unit: " $/h",
    group: "Usage",
    help: "Expected steady-state compute spend per hour at on-demand rates. The model starts here and then applies the forecast miss.",
    format: "number" as const,
  },
  {
    id: "discountPct",
    label: "Plan discount",
    min: 0,
    max: 60,
    step: 1,
    value: 30,
    unit: "%",
    group: "Commitment",
    help: "Effective discount on covered usage in this model. Teaching value, not an AWS quote or a promise of savings.",
    format: "percent" as const,
  },
  {
    id: "usageDriftPct",
    label: "Forecast miss",
    min: -40,
    max: 60,
    step: 5,
    value: 0,
    unit: "%",
    group: "Usage",
    help: "Positive means actual usage falls below forecast; negative means it grows above forecast. Applied over about 40 simulated seconds.",
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

interface Computed {
  commitment: number;
  forecast: number;
  discount: number;
  drift: number;
  usage: number;
  covered: number;
  excess: number;
  unused: number;
  spend: number;
  allOnDemand: number;
  savings: number;
  savingsK: number;
  costRatio: number;
  utilization: number;
  shortfall: number;
  wasteK: number;
  excessK: number;
  monthlyCostK: number;
}

function compute(p: Params, t: number): Computed {
  const commitment = Math.max(0, num(p, "commitmentPerHour", 50));
  const forecast = Math.max(1, num(p, "forecastUsagePerHour", 60));
  const discount = clamp(num(p, "discountPct", 30), 0, 100);
  const drift = clamp(num(p, "usageDriftPct", 0), -40, 60);
  const progress = smoothstep((t - RAMP_START) / RAMP_LENGTH);
  const usage = forecast * (1 - (drift / 100) * progress);
  const covered = Math.min(commitment, usage);
  const excess = Math.max(0, usage - commitment);
  const unused = Math.max(0, commitment - usage);
  const spend = commitment * (1 - discount / 100) + excess;
  const allOnDemand = usage;
  const savings = Math.max(0, allOnDemand - spend);
  return {
    commitment,
    forecast,
    discount,
    drift,
    usage,
    covered,
    excess,
    unused,
    spend,
    allOnDemand,
    savings,
    savingsK: (savings * HOURS_PER_MONTH) / 1_000,
    costRatio: (spend / Math.max(0.01, usage)) * 100,
    utilization: (covered / Math.max(0.01, commitment)) * 100,
    shortfall: 100 - (covered / Math.max(0.01, commitment)) * 100,
    wasteK: (unused * (1 - discount / 100) * HOURS_PER_MONTH) / 1_000,
    excessK: (excess * HOURS_PER_MONTH) / 1_000,
    monthlyCostK: (spend * HOURS_PER_MONTH) / 1_000,
  };
}

function commitmentHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.costRatio >= 130 || values.shortfall >= 40 || values.wasteK >= 20 || values.excessK >= 25) {
    return "crit";
  }
  if (values.costRatio >= 105 || values.shortfall >= 25 || values.wasteK >= 10 || values.excessK >= 12) {
    return "warn";
  }
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["cost-to-ondemand", values.costRatio, 0.5],
    ["commitment-shortfall", values.shortfall, 0.4],
    ["waste-cost", values.wasteK, 0.04],
    ["on-demand-excess", values.excessK, 0.04],
    ["monthly-cost", values.monthlyCostK, 0.04],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + (seed % 10)) / 3.15);
      return Math.max(0, value * (0.99 + 0.01 * wave) + amplitude * Math.sin(index / 2.5));
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  t: number,
  seed: number,
  state: { overCommitEvent: boolean },
): SimFrame {
  const values = compute(p, t);
  const health = commitmentHealth(values);
  const shortfallHealth =
    values.shortfall >= 40 ? "crit" : values.shortfall >= 25 ? "warn" : "ok";
  const excessHealth =
    values.excessK >= 25 ? "crit" : values.excessK >= 12 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "usage",
        label: "Actual compute usage",
        kind: "client",
        health: "ok",
        sublabel: `${values.usage.toFixed(0)}$/h at on-demand rates`,
        detail: `Forecast was ${values.forecast.toFixed(0)}$/h; the forecast miss is ${values.drift.toFixed(0)}%. Positive means usage fell below forecast.`,
        meta: { view: "flow" },
      },
      {
        id: "commitment",
        label: "Savings Plan commitment",
        kind: "service",
        role: "instance",
        health: shortfallHealth,
        utilization: clamp(values.utilization / 100),
        sublabel: `${values.commitment.toFixed(0)}$/h committed · ${values.utilization.toFixed(0)}% used`,
        detail: `Covered usage is ${values.covered.toFixed(0)}$/h on-demand equivalent. Unused commitment is ${values.unused.toFixed(0)}$/h on-demand equivalent, billed at about ${(values.unused * (1 - values.discount / 100)).toFixed(1)}$/h at the plan rate.`,
        meta: { view: "flow" },
      },
      {
        id: "excess",
        label: "On-demand excess",
        kind: "external",
        health: excessHealth,
        sublabel: `${values.excess.toFixed(0)}$/h above commitment`,
        detail: "Usage above the commitment is billed at on-demand rates. It is not covered retroactively by unused commitment in another hour.",
        meta: { view: "flow" },
      },
      {
        id: "bill",
        label: "Monthly compute bill",
        kind: "storage",
        health,
        sublabel: `${values.monthlyCostK.toFixed(1)}k$/month`,
        detail: `All-on-demand would be ${(values.allOnDemand * HOURS_PER_MONTH / 1_000).toFixed(1)}k$/month for actual usage. Model discount is ${values.discount.toFixed(0)}%. Illustrative.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("usage-commitment", "usage", "commitment", clamp(values.covered / Math.max(1, values.usage)), shortfallHealth),
      edge("usage-excess", "usage", "excess", clamp(values.excess / Math.max(1, values.usage)), excessHealth),
      edge("commitment-bill", "commitment", "bill", clamp(values.covered / Math.max(1, values.commitment)), shortfallHealth),
      edge("excess-bill", "excess", "bill", clamp(values.excess / Math.max(1, values.commitment)), excessHealth),
    ],
    metrics: [
      metric("cost-to-ondemand", "Cost versus on-demand", values.costRatio, "%", 105, 130, "percent"),
      metric("commitment-shortfall", "Commitment shortfall", values.shortfall, "%", 25, 40, "percent"),
      metric("waste-cost", "Unused commitment", values.wasteK, " k$/month", 10, 20, "number"),
      metric("on-demand-excess", "On-demand excess", values.excessK, " k$/month", 12, 25, "number"),
      metric("monthly-cost", "Monthly compute bill", values.monthlyCostK, " k$", undefined, undefined, "number"),
      metric("effective-savings", "Savings versus on-demand", values.savingsK, " k$/month", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      overCommitEvent: state.overCommitEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.commitment.toFixed(0)}$/h committed against ${values.usage.toFixed(0)}$/h of usage. Commitment shortfall is ${values.shortfall.toFixed(0)}%, unused commitment ${values.wasteK.toFixed(1)}k$/month. Illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, 0, seed, { overCommitEvent: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "cost-to-ondemand",
    metricId: "cost-to-ondemand",
    warn: 105,
    crit: 130,
    title: "The commitment costs more than on-demand",
    cause:
      "A Savings Plan bills the commitment even when usage falls below it. Unused commitment plus the on-demand price of any usage above the commitment can exceed the cost of paying for actual usage on-demand.",
    fix:
      "Size the commitment from the usage floor, not the forecast peak. Add plans in steps as usage proves durable. A commitment cannot be reduced after purchase, so the only durable fix is a better forecast and a laddered purchase.",
    checkFirst: [
      "Compare the hourly commitment with actual hourly usage, not with the monthly forecast.",
      "Check utilization by plan and by hour, including nights and weekends.",
      "Check whether a workload moved, was resized, or changed deployment model.",
    ],
  },
  {
    id: "commitment-shortfall",
    metricId: "commitment-shortfall",
    warn: 25,
    crit: 40,
    title: "A large share of the commitment is unused",
    cause:
      "Actual usage is below the committed spend. The unused part is still billed at the committed rate, so the effective cost per used unit rises even though the discount on covered usage is unchanged.",
    fix:
      "Reduce exposure by forecasting a floor and buying in increments. If the workload decline is permanent, plan the next commitment around the lower baseline; the current plan cannot be cancelled or downsized.",
    checkFirst: [
      "Check whether the decline is a one-off event or a new baseline.",
      "Check utilization across the full term, not only the current day.",
      "Check whether another eligible service could use the commitment.",
    ],
  },
  {
    id: "waste-cost",
    metricId: "waste-cost",
    warn: 10,
    crit: 20,
    title: "Unused commitment is a recurring bill line",
    cause:
      "Every hour the commitment exceeds usage, the unused share is paid for and produces no benefit. The cost compounds over the term.",
    fix:
      "Treat unused commitment as a forecast error with a monthly price. Re-baseline the commitment before the next purchase and monitor utilization budgets.",
    checkFirst: [
      "Check the monthly trend, not only the current hour.",
      "Check the remaining term and the size of the next purchase.",
      "Check whether the plan covers services you no longer use.",
    ],
  },
  {
    id: "on-demand-excess",
    metricId: "on-demand-excess",
    warn: 12,
    crit: 25,
    title: "Usage above the commitment is paying full price",
    cause:
      "Usage is above the commitment, so the excess is billed on-demand. This is not a failure of the plan; it is unclaimed savings. The risk is chasing peak usage and over-committing later.",
    fix:
      "Increase coverage in increments if the higher usage is durable, and keep variable or seasonal usage on-demand. Do not size the commitment to the peak hour.",
    checkFirst: [
      "Check whether the excess is sustained or a short spike.",
      "Check the hourly shape across the day and week.",
      "Check whether a more flexible plan type would cover the excess at a better rate.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const savingsPlansModel: SimModel = {
  id: "capacity-savings-plans",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    let overCommitEvent = fresh ? false : frame.flags.overCommitEvent === 1;
    const values = compute(p, t);

    const next = buildFrame(p, t, Number(frame.flags.seed ?? 20261110), { overCommitEvent });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!overCommitEvent && values.unused > 0 && values.drift > 0) {
      pushEvent(next, {
        id: "usage-below-commitment",
        at: t,
        severity: "warn",
        title: "Usage is falling below the commitment",
        detail: `The plan commits ${values.commitment.toFixed(0)}$/h on-demand equivalent while usage has fallen to ${values.usage.toFixed(0)}$/h. The unused ${values.unused.toFixed(0)}$/h is billed at the plan rate, about ${(values.unused * (1 - values.discount / 100)).toFixed(1)}$/h.`,
        nodeId: "commitment",
        metricId: "commitment-shortfall",
      });
      overCommitEvent = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      overCommitEvent: overCommitEvent ? 1 : 0,
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
    const ratio = value("cost-to-ondemand");
    const shortfall = value("commitment-shortfall");
    const waste = value("waste-cost");
    const excess = value("on-demand-excess");
    const savings = value("effective-savings");
    const items: string[] = [
      `The bill is ${ratio.toFixed(0)}% of the on-demand cost for actual usage, with ${savings.toFixed(1)}k$ per month of modelled savings. Illustrative figures.`,
    ];
    if (shortfall >= 25) {
      items.push(
        `Commitment shortfall is ${shortfall.toFixed(0)}%, so ${waste.toFixed(1)}k$ per month is paid for unused commitment. The plan is above the usage floor.`,
      );
    } else if (excess > 0) {
      items.push(
        `Usage above the commitment costs ${excess.toFixed(1)}k$ per month on-demand. That is unclaimed savings, not a failure.`,
      );
    } else {
      items.push("The commitment is fully used and the excess is modest. This is the shape a plan is meant to have.");
    }
    items.push("Forecast the floor, ladder the purchase, and monitor utilization and coverage together.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Over-committed", tone: "warn" },
    { label: "Wasting commitment", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "50$/h committed against 60$/h of forecast usage; the plan is fully used and saves money.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Usage grows",
    description: "65$/h committed while usage grows above forecast; the excess is on-demand but the plan still saves.",
    tone: "warn",
    params: defaults({ commitmentPerHour: 65, forecastUsagePerHour: 80, discountPct: 30, usageDriftPct: -15 }),
  },
  {
    id: "failure",
    label: "Over-committed",
    description: "75$/h committed, then usage falls 50%; unused commitment is billed for the rest of the term.",
    tone: "crit",
    params: defaults({ commitmentPerHour: 75, forecastUsagePerHour: 60, discountPct: 30, usageDriftPct: 50 }),
  },
  {
    id: "flexible",
    label: "Flexible plan",
    description: "A lower discount on a smaller commitment; less savings but more room for the workload to change.",
    tone: "info",
    params: defaults({ commitmentPerHour: 48, forecastUsagePerHour: 60, discountPct: 20, usageDriftPct: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "55$/h committed against 60$/h of usage; the commitment is fully used with little waste.",
    tone: "ok",
    params: defaults({ commitmentPerHour: 55, forecastUsagePerHour: 60, discountPct: 30, usageDriftPct: 5 }),
  },
];

const experiment: Experiment = {
  id: "predict-overcommitment",
  title: "Predict what over-commitment costs",
  simId: "savings-plans",
  question:
    "Usage is forecast at 60$/h. You commit to 75$/h for a 30% discount, then usage falls 50% for the rest of the term. What is the result?",
  prediction: {
    options: [
      { id: "falls", label: "The bill falls because the discount still applies" },
      { id: "flat", label: "The bill stays at the forecast level because the commitment is fixed" },
      { id: "rises", label: "The bill exceeds on-demand for actual usage because unused commitment is still billed" },
      { id: "refund", label: "AWS refunds the unused commitment at the end of the term" },
    ],
    correctOptionId: "rises",
    explanation:
      "A Savings Plan bills the hourly commitment for the term. When usage falls below it, the unused part is still paid for and produces no benefit. The cost per unit of actual usage rises, and it can exceed the on-demand cost of the usage that remains. There is no refund for unused commitment, and the term cannot be changed after purchase.",
  },
  setup: defaults({ commitmentPerHour: 75, forecastUsagePerHour: 60, discountPct: 30, usageDriftPct: 50 }),
  runFor: 45,
  observe: [
    "The commitment stays at 75$/h while usage falls from 60$/h to 30$/h.",
    "Commitment shortfall reaches 60%, and unused commitment costs about 23k$ per month.",
    "The monthly bill stays near 38.3k$ while on-demand for actual usage would be about 21.9k$.",
    "The cost-versus-on-demand ratio reaches about 175%.",
  ],
  explain:
    "The commitment is a spend floor, not a usage cap. A 30% discount on 75$/h costs 52.5$/h whether or not the usage exists. The discount is valuable only on the part that is used. The unused part converts the plan into a fixed cost that is higher than the variable cost it replaced.",
  fix: defaults({ commitmentPerHour: 55, forecastUsagePerHour: 60, discountPct: 30, usageDriftPct: 5 }),
  debrief:
    "A 55$/h commitment against 57$/h of usage keeps the plan fully used and the bill near 40.5$/h, or about 29.6k$ per month. That is below the 57$/h on-demand cost of the same usage, and well below the 52.5$/h spend in the over-committed case. The tradeoff is that a larger commitment would have saved more if usage had held. Ladder the commitment and forecast the floor, not the peak. All figures are illustrative.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Savings Plan is a commitment to a consistent amount of compute usage, measured in dollars per hour, for a one-year or three-year term. In exchange, AWS applies a lower rate to eligible usage up to the commitment. Usage above the commitment is billed at on-demand rates. Usage below the commitment is still billed at the commitment rate. The commitment is a spend floor: it does not reserve an instance, a family, or a Region. It reserves an amount of hourly spend.",
  },
  {
    type: "p",
    text: "There are several plan types. A Compute Savings Plan is the most flexible: it applies to EC2 usage regardless of instance family, size, operating system, tenancy, or Region, and it also applies to Fargate and Lambda. An EC2 Instance Savings Plan is tied to a specific instance family in a chosen Region; it is less flexible and is priced lower for that narrower scope. Database Savings Plans and SageMaker AI Savings Plans cover their respective services. The right plan is a question of how much the workload may change, not only of the headline rate.",
  },
  {
    type: "p",
    text: "The commitment is not a reservation of capacity. It is a billing arrangement. That distinction matters twice. First, unused commitment is not refunded or reallocated across hours; an hour with low usage does not earn credit for a later hour with high usage. Second, the plan term cannot be changed after purchase. You can add plans as usage grows, but you cannot reduce or cancel the existing commitment. The planning problem is therefore asymmetric: under-commitment leaves savings on the table, while over-commitment creates a fixed cost that survives the workload.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The plan sits between the workload and the bill. The workload produces hourly compute usage. The plan covers the first slice of that usage at a discount and leaves the rest at on-demand. The bill is the discounted commitment plus any on-demand excess. A capacity change that reduces the fleet changes the usage, not the commitment. A migration to another family or Region barely matters to a Compute Savings Plan and matters a great deal to an EC2 Instance Savings Plan or a Reserved Instance.",
  },
  {
    type: "table",
    headers: ["Option", "Commits to", "Flexibility", "Main risk"],
    rows: [
      ["Compute Savings Plan", "Hourly spend", "Family, size, OS, tenancy, Region; EC2, Fargate, Lambda", "Over-commitment if usage falls"],
      ["EC2 Instance Savings Plan", "Hourly spend in one family and Region", "Size, OS, and tenancy within that family and Region", "Family or Region change strands the value"],
      ["Standard Reserved Instance", "A specific instance configuration", "Modification only; resale possible", "Workload drift wastes coverage"],
      ["Convertible Reserved Instance", "A specific configuration, exchangeable", "Exchange for another convertible configuration", "Smaller discount than standard"],
      ["On-demand", "Nothing", "Full", "No discount; cost follows usage"],
    ],
  },
  {
    type: "p",
    text: "This model uses a single hourly commitment, a forecast usage rate, an effective discount, and a forecast miss. The discount is a teaching input, not a quote. The model assumes the plan covers compute spend and that usage above the commitment is on-demand. It does not model partial-hour coverage, plan-specific service eligibility, or the interaction between multiple plans; those are details to check in Cost Explorer before a real purchase.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Cost versus on-demand, with warning at 105% and critical at 130% in this model.",
      "Commitment shortfall, the share of the plan that is unused.",
      "Unused commitment in k$ per month, the recurring cost of over-forecasting.",
      "On-demand excess in k$ per month, the savings left unclaimed by under-committing.",
      "Monthly compute bill and savings versus on-demand, both illustrative.",
      "A flow from actual usage to the commitment, the on-demand excess, and the bill.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note that the commitment is fully used while savings are positive. Apply Over-committed and watch the commitment stay at 75$/h while usage falls to 30$/h. Run the guided experiment before changing sliders. Then apply Usage grows to see the opposite failure: the plan is fine, but the excess is paying full price. All rates are illustrative, not financial advice.",
  },
  { type: "sim", simId: "savings-plans" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The plan committed 75$ per hour on-demand equivalent for the term. Usage started at the 60$ per hour forecast and then fell by half. The commitment did not move. At the end, 45$ per hour of that commitment was unused; at the 30% plan rate it was billed at 31.5$ per hour, about 23k$ per month. The monthly bill stayed near 38.3k$ while the on-demand cost of the remaining usage would have been about 21.9k$. The cost-versus-on-demand ratio reached 175%. All figures in this module are illustrative.",
  },
  {
    type: "p",
    text: "The discount was real on the covered portion. It was simply too small to compensate for paying for usage that no longer existed. This is the asymmetry of commitments: a plan that is 20% too small leaves some savings unclaimed, while a plan that is 20% too large creates a fixed cost that lasts for the whole term.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "AWS Cost Explorer Savings Plans recommendations and utilization reports: hourly commitment, utilized commitment, and on-demand spend above the plan.",
      "AWS Budgets: Savings Plans utilization and coverage budgets can alert when utilization falls or coverage drops, but they do not explain why usage moved.",
      "Cost and Usage Report: the savings plan line items, covered usage, and uncovered on-demand usage by service and account.",
      "Usage shape: hourly and daily curves. A commitment sized to the peak leaves the overnight and weekend troughs unused.",
      "Deployment and migration history: a move to a different compute service, a Region change, or a workload shutdown changes usage without changing the commitment.",
      "Forecast review: the commitment was bought against a forecast that may have been optimistic, or against usage that was never durable.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the hourly commitment with actual hourly usage, not with the monthly forecast. Check utilization by hour and by plan. If utilization is low, quantify the unused commitment per month and the remaining term before deciding what to do about the next purchase.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the usage floor: the level that persists through nights, weekends, and the slow season. Commit from the floor, not the peak or the average.",
      "If the plan is under-utilized, check whether the decline is temporary. A permanent decline means the next purchase must be smaller; the current plan cannot be reduced.",
      "If the plan is over-utilized, add coverage in increments only for the part of the excess that is durable. Leave seasonal peaks on-demand.",
      "Choose plan flexibility from the workload's expected change: Compute Savings Plans for family and Region mobility, EC2 Instance Savings Plans for a stable family, RIs only when the shape is stable and the extra discount is worth the lock-in.",
      "Ladder purchases across terms and start dates instead of buying one large commitment. Laddering reduces the cost of a bad forecast.",
      "Monitor utilization and coverage together, review the commitment before renewal, and record the forecast assumptions.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Higher commitment usually means a lower rate, but it also means more exposure if usage falls. The cheapest rate is not the cheapest bill.",
      "A flexible Compute Savings Plan accepts a smaller discount in exchange for mobility across family, size, OS, tenancy, and Region.",
      "An EC2 Instance Savings Plan or a standard RI can offer a lower rate for a stable shape, but a migration can strand the value.",
      "Laddering reduces forecast risk but adds administrative overhead and may blend rates across plans.",
      "Under-committing is safer but leaves savings unclaimed; the excess is visible as on-demand spend every month.",
      "Usage that is seasonal or experimental should stay on-demand. A commitment is for the durable floor, not the experiment.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "sp-vs-ri",
    question:
      "You need flexibility across instance families. How do Savings Plans and Reserved Instances compare?",
    difficulty: 2,
    hints: [
      "One commits spend; the other commits a configuration.",
      "Flexibility usually costs some discount.",
    ],
    answer:
      "A Savings Plan commits to an hourly spend and applies a discount to eligible usage up to that commitment. A Compute Savings Plan follows EC2 usage across family, size, OS, tenancy, and Region, and also covers Fargate and Lambda. A Reserved Instance is a billing discount tied to a specific configuration and Region, with standard and convertible offering classes that differ in exchangeability. For a fleet that may change family, the Compute Savings Plan is the more natural fit; an EC2 Instance Savings Plan or an RI can offer a lower rate for a stable shape. I would compare the rate, the term, the expected change, and the cost of being wrong, not only the headline discount.",
    followUps: [
      "When would an EC2 Instance Savings Plan beat a Compute Savings Plan?",
      "What does a convertible RI allow that a standard RI does not?",
      "How would you split coverage between the two?",
    ],
    redFlags: [
      "Treats all commitments as interchangeable.",
      "Picks the largest discount without a forecast.",
      "Ignores the term and the lock-in.",
    ],
    rubric: [
      "Contrasts spend commitment with configuration commitment.",
      "Names the flexibility dimensions.",
      "Includes term and forecast.",
      "Mentions the cost of being wrong.",
    ],
  },
  {
    id: "overcommit",
    question:
      "Utilization on a Savings Plan is 55%. What does that mean, and what do you do?",
    difficulty: 3,
    hints: [
      "Utilization is about the purchase, not the workload.",
      "The current plan cannot be downsized.",
    ],
    answer:
      "It means 45% of the committed hourly spend is not being used, but the commitment is still billed. I would first check whether the decline is temporary, seasonal, or permanent, and whether the unused capacity could be used by another eligible workload. I would quantify the monthly waste and the remaining term. If the decline is permanent, the current plan cannot be reduced, so the fix is on the next purchase: re-baseline to the new floor and ladder the commitment. I would also check whether a different plan type would have followed the usage better. I would not add more coverage to make the utilization number look better.",
    followUps: [
      "How would you distinguish seasonal from permanent?",
      "What if another team could use the commitment?",
      "How do you prevent this at purchase time?",
    ],
    redFlags: [
      "Buys more to raise utilization.",
      "Assumes the plan can be cancelled.",
      "Ignores the remaining term.",
    ],
    rubric: [
      "Explains utilization correctly.",
      "Quantifies waste and term.",
      "Distinguishes temporary from permanent.",
      "Fixes the next purchase, not the current one.",
    ],
  },
  {
    id: "forecast-floor",
    question:
      "How would you forecast the commitment level for a workload with a strong daily peak?",
    difficulty: 3,
    hints: [
      "The commitment should cover the durable floor.",
      "Peaks belong on-demand or under a more flexible layer.",
    ],
    answer:
      "I would plot hourly usage over a full cycle, including nights, weekends, and the slow season, and find the level that is present through all of them. That floor is the candidate commitment. The peak above it stays on-demand or is covered by a smaller, more flexible layer. I would test sensitivity to a 20% forecast miss and compare the savings at the floor with the cost of over-committing to the average or the peak. I would ladder the purchase and review utilization monthly rather than committing the whole floor at once.",
    followUps: [
      "What if the floor is growing quickly?",
      "How does a three-year term change the floor?",
      "What data would you use from Cost Explorer?",
    ],
    redFlags: [
      "Commits the peak.",
      "Uses a monthly average as the hourly commitment.",
      "Ignores seasonality.",
    ],
    rubric: [
      "Uses the hourly floor.",
      "Separates peak from floor.",
      "Tests forecast sensitivity.",
      "Ladders the purchase.",
    ],
  },
  {
    id: "monitor-commitment",
    question:
      "Which metrics and alerts would you put around a Savings Plan commitment?",
    difficulty: 2,
    hints: [
      "Utilization and coverage answer different questions.",
      "Alert before the monthly bill, not after.",
    ],
    answer:
      "I would track commitment utilization, coverage of eligible usage, on-demand spend above the commitment, and the effective cost per unit of usage. Utilization catches over-commitment; coverage and excess catch under-commitment. I would alert on a sustained utilization drop, not a single low hour, and on a sustained excess that looks durable rather than a spike. I would review the hourly shape and the remaining term alongside the alert, and I would put the forecast assumptions in the same place so the next purchase has context.",
    followUps: [
      "What threshold would you set for utilization?",
      "How do you avoid alerting on every nightly trough?",
      "Who owns the commitment review?",
    ],
    redFlags: [
      "Alerts only on the total bill.",
      "Uses a single utilization threshold for every workload.",
      "Has no owner for renewal.",
    ],
    rubric: [
      "Tracks utilization and coverage.",
      "Separates over- and under-commitment.",
      "Uses sustained windows.",
      "Names ownership and forecast context.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Hourly usage is plotted across nights, weekends, and the slow season.",
      "The commitment is sized from the durable floor, not the peak or the monthly average.",
      "The forecast includes a downside case and the cost of unused commitment.",
      "Plan type is chosen from expected workload mobility, not only the headline discount.",
      "Commitments are laddered, with an owner and a renewal review date.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the hourly commitment with actual hourly usage, not the monthly forecast.",
      "Check whether the decline is temporary, seasonal, or permanent.",
      "Quantify unused commitment per month and the remaining term.",
      "Check whether another eligible workload could use the commitment.",
      "Do not add coverage just to improve the utilization percentage.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-baseline the next commitment to the new usage floor.",
      "Keep the variable or seasonal layer on-demand.",
      "Add utilization and coverage alerts with a sustained window.",
      "Record the forecast assumptions and review them before renewal.",
    ],
  },
];

const references = [
  {
    title: "What are Savings Plans?",
    url: "https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Commitment model, one- and three-year terms, payment options, and the relationship to On-Demand pricing.",
  },
  {
    title: "Savings Plans types",
    url: "https://docs.aws.amazon.com/savingsplans/latest/userguide/plan-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Compute, EC2 Instance, Database, and SageMaker AI plan scopes and flexibility.",
  },
  {
    title: "Managing your costs with AWS Budgets",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Savings Plans utilization and coverage budgets for detecting over- and under-commitment.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "savings-plans": {
      model: savingsPlansModel,
      presets,
      instructions:
        "Start healthy, then apply Over-committed. Watch the commitment stay fixed while usage falls and unused commitment grows. Compare Usage grows to see the opposite risk.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative commitment model. Discounts, rates, and usage are teaching values, not AWS quotes or financial advice. Real plans have service-specific eligibility and term rules.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-reserved-instances",
    "capacity-committed-use",
    "capacity-headroom-cost",
    "capacity-cost-per-request",
  ],
};
