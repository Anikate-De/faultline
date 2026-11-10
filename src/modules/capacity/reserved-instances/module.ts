import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOURS_PER_MONTH = 730;
const ON_DEMAND_RATE = 0.2;
const COMMITTED_RATE = 0.14;
const MIGRATION_START = 5;
const MIGRATION_LENGTH = 25;

const params = [
  {
    id: "fleetInstances",
    label: "Steady-state fleet",
    min: 20,
    max: 200,
    step: 1,
    value: 100,
    unit: " instances",
    group: "Fleet",
    help: "Instances running at a steady rate through the month. The model treats them as hour-for-hour equivalent.",
    format: "count" as const,
  },
  {
    id: "coveragePct",
    label: "RI coverage purchased",
    min: 0,
    max: 100,
    step: 5,
    value: 80,
    unit: "%",
    group: "Commitment",
    help: "Share of the original fleet covered by reservations when they were bought. This is not necessarily the coverage you have after the fleet changes.",
    format: "percent" as const,
  },
  {
    id: "familyShiftPct",
    label: "Fleet moved to a new family",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Fleet",
    help: "Share of instances migrated to a different instance family over about 25 simulated seconds. Reservations for the old family do not follow.",
    format: "percent" as const,
  },
  {
    id: "termMonths",
    label: "Remaining term",
    min: 12,
    max: 36,
    step: 24,
    value: 36,
    unit: " months",
    group: "Commitment",
    help: "Remaining reservation term: one year or three years, the terms AWS sells. The term changes the stranded total, not the monthly bill.",
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

function shiftAt(p: Params, t: number): number {
  const target = clamp(num(p, "familyShiftPct", 0), 0, 100);
  return target * smoothstep((t - MIGRATION_START) / MIGRATION_LENGTH);
}

interface Computed {
  fleet: number;
  coveragePurchased: number;
  familyShift: number;
  termMonths: number;
  reserved: number;
  moved: number;
  oldFamily: number;
  covered: number;
  unused: number;
  onDemand: number;
  effectiveCoverage: number;
  coverageShortfall: number;
  uncovered: number;
  monthlyCostK: number;
  baselineCostK: number;
  savingsK: number;
  wasteK: number;
  excessK: number;
  strandedK: number;
  weightedRate: number;
}

function compute(p: Params, t: number): Computed {
  const fleet = Math.max(1, Math.round(num(p, "fleetInstances", 100)));
  const coveragePurchased = clamp(num(p, "coveragePct", 80), 0, 100);
  const familyShift = shiftAt(p, t);
  const termMonths = Math.max(12, Math.round(num(p, "termMonths", 36)));
  const reserved = Math.round((fleet * coveragePurchased) / 100);
  const moved = Math.round((fleet * familyShift) / 100);
  const oldFamily = Math.max(0, fleet - moved);
  const covered = Math.min(reserved, oldFamily);
  const unused = Math.max(0, reserved - oldFamily);
  const onDemand = Math.max(0, fleet - covered);
  const monthlyCost = reserved * COMMITTED_RATE * HOURS_PER_MONTH + onDemand * ON_DEMAND_RATE * HOURS_PER_MONTH;
  const baseline = fleet * ON_DEMAND_RATE * HOURS_PER_MONTH;
  const monthlyCostK = monthlyCost / 1_000;
  const baselineCostK = baseline / 1_000;
  const effectiveCoverage = (covered / fleet) * 100;
  return {
    fleet,
    coveragePurchased,
    familyShift,
    termMonths,
    reserved,
    moved,
    oldFamily,
    covered,
    unused,
    onDemand,
    effectiveCoverage,
    coverageShortfall: Math.max(0, coveragePurchased - effectiveCoverage),
    uncovered: 100 - effectiveCoverage,
    monthlyCostK,
    baselineCostK,
    savingsK: Math.max(0, baselineCostK - monthlyCostK),
    wasteK: (unused * COMMITTED_RATE * HOURS_PER_MONTH) / 1_000,
    excessK: Math.max(0, monthlyCostK - baselineCostK),
    strandedK: (unused * COMMITTED_RATE * HOURS_PER_MONTH * termMonths) / 1_000,
    weightedRate: monthlyCost / (fleet * HOURS_PER_MONTH),
  };
}

function commitmentHealth(values: Computed): "ok" | "warn" | "crit" {
  if (values.coverageShortfall >= 30 || values.wasteK >= 5 || values.excessK >= 2) return "crit";
  if (values.coverageShortfall >= 15 || values.wasteK >= 2 || values.excessK >= 0.5) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const metricSeed: [string, number, number][] = [
    ["effective-coverage", values.effectiveCoverage, 0.5],
    ["coverage-shortfall", values.coverageShortfall, 0.5],
    ["waste-cost", values.wasteK, 0.04],
    ["monthly-bill", values.monthlyCostK, 0.04],
    ["stranded-cost", values.strandedK, 0.1],
  ];
  for (const [id, value, amplitude] of metricSeed) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) => {
      const wave = Math.sin((index + (seed % 9)) / 3.2);
      return Math.max(0, value * (0.99 + 0.01 * wave) + amplitude * Math.sin(index / 2.7));
    });
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(
  p: Params,
  t: number,
  seed: number,
  state: { migrationEvent: boolean; mismatchEvent: boolean },
): SimFrame {
  const values = compute(p, t);
  const health = commitmentHealth(values);
  const coverageHealth =
    values.coverageShortfall >= 30 ? "crit" : values.coverageShortfall >= 15 ? "warn" : "ok";
  const wasteHealth = values.wasteK >= 5 ? "crit" : values.wasteK >= 2 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "fleet",
        label: "Steady-state fleet",
        kind: "service",
        role: "instance",
        health: "ok",
        sublabel: `${values.fleet} instances · ${values.familyShift.toFixed(0)}% moved`,
        detail: `${values.covered} instances are covered by a reservation, ${values.onDemand} run on-demand, and ${values.unused} reservations are unused. The model uses illustrative rates.`,
        meta: { view: "flow" },
      },
      {
        id: "reserved",
        label: "Reserved capacity",
        kind: "storage",
        health: wasteHealth,
        utilization: values.reserved > 0 ? clamp(values.covered / values.reserved) : 0,
        sublabel: `${values.reserved} reserved · ${values.covered} used`,
        detail: values.unused > 0 ? `${values.unused} reservations no longer match a running instance but are still billed.` : "Every purchased reservation is matched to eligible usage in the old family.",
        meta: { view: "flow" },
      },
      {
        id: "ondemand",
        label: "New family on-demand",
        kind: "external",
        health: coverageHealth,
        sublabel: `${values.moved} instances outside the reservation`,
        detail: "A reservation applies only to matching attributes. Moving the fleet to another family leaves this usage at the on-demand rate.",
        meta: { view: "flow" },
      },
      {
        id: "bill",
        label: "Monthly bill",
        kind: "storage",
        health,
        sublabel: `${values.monthlyCostK.toFixed(1)}k$ · ${values.effectiveCoverage.toFixed(0)}% effective coverage`,
        detail: `All-on-demand cost would be ${values.baselineCostK.toFixed(1)}k$. The weighted rate is ${values.weightedRate.toFixed(2)}$ per instance-hour. Illustrative figures.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("fleet-reserved", "fleet", "reserved", clamp(values.covered / values.fleet), wasteHealth),
      edge("fleet-ondemand", "fleet", "ondemand", clamp(values.moved / values.fleet), coverageHealth),
      edge("reserved-bill", "reserved", "bill", clamp(values.covered / values.fleet), wasteHealth),
      edge("ondemand-bill", "ondemand", "bill", clamp(values.moved / values.fleet), coverageHealth),
    ],
    metrics: [
      metric("effective-coverage", "Effective coverage", values.effectiveCoverage, "%", undefined, undefined, "percent"),
      metric("coverage-shortfall", "Coverage gap", values.coverageShortfall, "%", 15, 30, "percent"),
      metric("uncovered", "Fleet without reservation", values.uncovered, "%", undefined, undefined, "percent"),
      metric("waste-cost", "Unused commitment", values.wasteK, " k$/month", 2, 5, "number"),
      metric("excess-cost", "Cost above all on-demand", values.excessK, " k$/month", 0.5, 2, "number"),
      metric("monthly-bill", "Monthly bill", values.monthlyCostK, " k$", undefined, undefined, "number"),
      metric("savings", "Savings versus on-demand", values.savingsK, " k$/month", undefined, undefined, "number"),
      metric("stranded-cost", "Stranded cost over term", values.strandedK, " k$", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      migrationEvent: state.migrationEvent ? 1 : 0,
      mismatchEvent: state.mismatchEvent ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.fleet} instances with ${values.reserved} reservations. Effective coverage is ${values.effectiveCoverage.toFixed(0)}%, the bill is ${values.monthlyCostK.toFixed(1)}k$ per month, and ${values.unused} reservations are unused. Illustrative figures.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, 0, seed, { migrationEvent: false, mismatchEvent: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "coverage-shortfall",
    metricId: "coverage-shortfall",
    warn: 15,
    crit: 30,
    title: "Effective coverage is below the purchased level",
    cause:
      "Reservations apply only to matching instance attributes and Region. A fleet that moved to another family, size, platform, or tenancy leaves part of the commitment unused and the new usage on-demand. Headline coverage can stay high while effective coverage falls.",
    fix:
      "Match commitments to the current fleet: exchange convertible reservations, modify what can be modified, sell standard reservations where the Marketplace allows it, and stop buying coverage for the old shape. Do not buy more coverage before the mismatch is measured.",
    checkFirst: [
      "Compare purchased coverage with effective coverage after the fleet change.",
      "Check the instance family, size, Region, platform, and tenancy of the running fleet against the reservations.",
      "Check whether the unused reservations are still being billed and for how long.",
    ],
  },
  {
    id: "waste-cost",
    metricId: "waste-cost",
    warn: 2,
    crit: 5,
    title: "You are paying for reservations nobody uses",
    cause:
      "A reservation is a billing commitment, not a running instance. If the matching usage disappears, the commitment is still billed. The monthly waste is the unused reservation rate times the hours in the month.",
    fix:
      "Restore matching usage, exchange the reservation if the offering class allows it, or sell it on the Reserved Instance Marketplace. For future purchases, prefer flexibility and ladder coverage instead of covering the whole fleet at once.",
    checkFirst: [
      "Check RI utilization by reservation, not only account-level coverage.",
      "Check whether the workload moved, was resized, or changed platform.",
      "Check the remaining term and whether an exchange or sale is possible.",
    ],
  },
  {
    id: "excess-cost",
    metricId: "excess-cost",
    warn: 0.5,
    crit: 2,
    title: "The commitment is costing more than on-demand",
    cause:
      "Unused reservations are still billed while the replacement usage is paid at the on-demand rate. The combination can exceed the cost of running the whole fleet on-demand, even with 80% headline coverage.",
    fix:
      "Align the commitment with the current fleet before adding more coverage. Compare total cost, not coverage percentage. A lower coverage number with matched reservations can be cheaper.",
    checkFirst: [
      "Compare the current bill with an all-on-demand baseline for the same fleet.",
      "Split the bill into covered, unused, and on-demand cost.",
      "Check whether the coverage metric is counting eligible hours or all hours.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const reservedInstancesModel: SimModel = {
  id: "capacity-reserved-instances",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const key = JSON.stringify(p);
    const fresh = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const t = frame.t;
    let migrationEvent = fresh ? false : frame.flags.migrationEvent === 1;
    let mismatchEvent = fresh ? false : frame.flags.mismatchEvent === 1;
    const values = compute(p, t);

    const next = buildFrame(p, t, Number(frame.flags.seed ?? 20261110), {
      migrationEvent,
      mismatchEvent,
    });
    next.t = frame.t;
    if (!fresh) next.series = frame.series;
    next.events = frame.events;

    if (!migrationEvent && values.familyShift > 1) {
      pushEvent(next, {
        id: "family-migration",
        at: t,
        severity: "info",
        title: "The fleet is moving to a new instance family",
        detail: `About ${values.moved} of ${values.fleet} instances are now outside the reserved family. Coverage is a billing match, not a property of the workload.`,
        nodeId: "ondemand",
        metricId: "effective-coverage",
      });
      migrationEvent = true;
    }

    if (!mismatchEvent && values.unused > 0) {
      pushEvent(next, {
        id: "commitment-mismatch",
        at: t,
        severity: "warn",
        title: "Reserved capacity no longer matches the fleet",
        detail: `${values.unused} reservations are unused while ${values.moved} instances run on-demand. The unused reservation is still billed.`,
        nodeId: "reserved",
        metricId: "waste-cost",
      });
      mismatchEvent = true;
    }

    next.flags = {
      ...frame.flags,
      ...next.flags,
      migrationEvent: migrationEvent ? 1 : 0,
      mismatchEvent: mismatchEvent ? 1 : 0,
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
    const coverage = value("effective-coverage");
    const shortfall = value("coverage-shortfall");
    const waste = value("waste-cost");
    const bill = value("monthly-bill");
    const stranded = value("stranded-cost");
    const items: string[] = [
      `Effective coverage is ${coverage.toFixed(0)}%, a ${shortfall.toFixed(0)} point shortfall from full coverage. The monthly bill is ${bill.toFixed(1)}k$ in this illustrative model.`,
    ];
    if (waste > 0) {
      items.push(
        `Unused reservations cost ${waste.toFixed(1)}k$ per month and ${stranded.toFixed(0)}k$ over the remaining term. The commitment outlives the workload it was bought for.`,
      );
    } else {
      items.push("Every reservation is matched to eligible usage. The remaining question is whether the term and the coverage level match the forecast.");
    }
    items.push(
      "Coverage is not a goal on its own. A lower coverage percentage with matched reservations can cost less than 80% coverage that no longer fits the fleet.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Mismatch", tone: "warn" },
    { label: "Wasting commitment", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "100 instances, 80 reservations, no family change; coverage saves money every month.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Growth and partial drift",
    description: "160 instances with 80% coverage and a quarter moved to a new family; coverage thins but the bill still saves.",
    tone: "info",
    params: defaults({ fleetInstances: 160, coveragePct: 80, familyShiftPct: 25, termMonths: 36 }),
  },
  {
    id: "failure",
    label: "Coverage that no longer fits",
    description: "80% coverage, but 70% of the fleet moves to a new family; unused commitments and on-demand usage raise the bill.",
    tone: "crit",
    params: defaults({ fleetInstances: 100, coveragePct: 80, familyShiftPct: 70, termMonths: 36 }),
  },
  {
    id: "term",
    label: "Short remaining term",
    description: "The same mismatch with 12 months left; the monthly waste is identical but the stranded total is smaller.",
    tone: "crit",
    params: defaults({ fleetInstances: 100, coveragePct: 80, familyShiftPct: 70, termMonths: 12 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "95% coverage with only 5% drift; effective coverage and cost both return to a healthy range.",
    tone: "ok",
    params: defaults({ fleetInstances: 100, coveragePct: 95, familyShiftPct: 5, termMonths: 12 }),
  },
];

const experiment: Experiment = {
  id: "predict-ri-mismatch",
  title: "Predict what family drift does to the bill",
  simId: "reserved-instances",
  question:
    "Purchased coverage is 80%, but 70% of the fleet moves to a new instance family. The reservations are standard, three-year, and not convertible. What happens to the bill?",
  prediction: {
    options: [
      { id: "falls", label: "It falls because 80% of the fleet is still reserved" },
      { id: "flat", label: "It stays flat because coverage did not change" },
      { id: "rises", label: "It rises because unused reservations are billed and the new family is on-demand" },
      { id: "auto", label: "It falls because AWS moves the reservation automatically" },
    ],
    correctOptionId: "rises",
    explanation:
      "A reservation is a billing discount tied to matching attributes. When the fleet moves to another family, the old reservations no longer apply to the new usage, but the commitment is still billed. The new family runs at the on-demand rate. Purchased coverage stays at 80%, effective coverage falls to about 30%, and the bill can exceed the all-on-demand cost.",
  },
  setup: defaults({ fleetInstances: 100, coveragePct: 80, familyShiftPct: 70, termMonths: 36 }),
  runFor: 45,
  observe: [
    "The fleet moves from the reserved family toward the new family over about 25 seconds.",
    "Effective coverage falls to about 30% while purchased coverage remains 80%.",
    "About 50 reservations are unused and still billed; the new family runs on-demand.",
    "The monthly bill rises to about 18.4k$ against a 14.6k$ all-on-demand baseline.",
  ],
  explain:
    "Coverage counts the share of eligible usage that a reservation covers. It does not count reservations that no longer have matching usage. The 80% headline is a purchase decision from the past; the effective coverage is what the current fleet actually receives. The gap is the unused commitment, and it is billed every hour of the term.",
  fix: defaults({ fleetInstances: 100, coveragePct: 80, familyShiftPct: 0, termMonths: 36 }),
  debrief:
    "Keeping the fleet on the reserved family restores effective coverage to 80% and the bill to about 11.1k$, roughly 3.5k$ below all-on-demand. If the migration is the right decision, the commitment has to be exchanged or sold, or the next purchase has to cover the new shape. All rates and dollar figures are illustrative.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Reserved Instance (RI) is not a physical server. It is a billing discount that applies to matching on-demand usage for a commitment term. The reservation has attributes: instance family and size, Region, platform, and tenancy. If a running instance matches those attributes, the reservation's rate applies. If nothing matches, the reservation is still billed. That is the whole failure mode in one sentence: the commitment is to a shape, and the workload can change shape. Scope matters as well: a regional reservation applies across Availability Zones in a Region and follows the size-flexibility rules for its platform, while a zonal reservation is tied to one Availability Zone and can provide a capacity reservation. A regional reservation does not reserve capacity by itself.",
  },
  {
    type: "p",
    text: "AWS sells one-year and three-year terms, with all-upfront, partial-upfront, and no-upfront payment options. Standard reservations offer a larger discount but can only be modified; convertible reservations can be exchanged for a different configuration but offer a smaller discount. Reservations do not renew automatically. After purchase they cannot be cancelled, though they may be modified, exchanged, or sold on the Reserved Instance Marketplace depending on the offering class and the remaining term. Those rules matter because they determine what you can do when the fleet drifts.",
  },
  {
    type: "p",
    text: "Two metrics are easy to confuse. Coverage is the share of eligible instance hours that a reservation covers. Utilization is the share of the purchased reservation hours that are actually used. High coverage with low utilization means you bought reservations for usage that is no longer there. High utilization with low coverage means the reservations you have are fully used but a lot of the fleet is still on-demand. The bill responds to both, so a coverage number alone cannot tell you whether the commitment is working.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Reservations sit in the billing layer, under the fleet. The fleet might be steady, growing, or migrating; the reservation does not see any of that. It only sees whether usage matches its attributes in each hour. A capacity decision that changes instance family, size, Region, platform, or tenancy changes the match. So does a migration to containers, a move to another account, or a change from dedicated to shared tenancy. The bill is the first place the mismatch appears, and by then the commitment may have months left.",
  },
  {
    type: "table",
    headers: ["Workload change", "Does the RI follow", "What happens to the bill", "First check"],
    rows: [
      ["Same family, different size", "Regional Linux RIs can apply across sizes in the family", "May continue to apply", "Size flexibility rules for the scope"],
      ["Different instance family", "No", "Old RI unused; new usage on-demand", "Effective coverage and unused hours"],
      ["Different Region", "No", "Old RI billed; new Region on-demand", "Reservation scope and Region"],
      ["Different platform or tenancy", "No", "Old RI billed; new usage at the matching rate", "Platform and tenancy attributes"],
      ["Fleet shrinks", "No automatic release", "Unused commitment remains billed", "Utilization by reservation"],
    ],
  },
  {
    type: "p",
    text: "The model uses an illustrative on-demand rate and an illustrative committed rate, 100 steady-state instances, and a migration that moves a share of the fleet to a new family. The rates are teaching values, not AWS prices. The term slider changes the stranded total, not the monthly bill: the monthly waste is the same, but a three-year commitment has more months left to pay for it.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Effective coverage, the share of the current fleet that actually receives the reserved rate.",
      "Coverage gap, the difference between purchased and effective coverage, with warning at 15 points and critical at 30 points.",
      "Fleet without reservation, so absolute coverage and the mismatch are visible separately.",
      "Unused commitment in k$ per month, with warning at 2k$ and critical at 5k$.",
      "Cost above all-on-demand, which shows when the commitment plus replacement usage costs more than no commitment at all.",
      "Stranded cost over the remaining term, so a one-year and a three-year commitment are visibly different.",
      "A flow from the fleet to reserved capacity, the new family, and the bill.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy and note that 80% purchased coverage is also 80% effective coverage when nothing has moved. Apply Coverage that no longer fits and watch purchased coverage stay at 80% while effective coverage falls to about 30%. Run the guided experiment before changing sliders. Compare Short remaining term with the same mismatch to see why the term changes the exposure, not the monthly waste. All rates are illustrative.",
  },
  { type: "sim", simId: "reserved-instances" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet started at 100 instances with 80 reservations, all matching. The bill was about 11.1k$ per month against a 14.6k$ all-on-demand baseline. Then 70% of the fleet moved to a new instance family. The reservations still had 30 matching instances, so 50 reservations became unused while 70 instances ran on-demand. Effective coverage fell to 30% even though purchased coverage was still 80%. All figures in this module are illustrative.",
  },
  {
    type: "p",
    text: "The bill rose to about 18.4k$ per month, roughly 3.8k$ above the all-on-demand cost for the same fleet. The unused commitment alone was about 5.1k$ per month. Because the term had 36 months left, the stranded total was about 184k$ in this illustrative model. With 12 months left, the monthly waste was the same but the stranded total was about 61k$.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "AWS Cost Explorer RI reports: coverage and utilization by reservation, service, and account. Coverage alone is not enough; read utilization beside it.",
      "Cost and Usage Report: covered and uncovered usage, plus the reservation line items that continue to bill when unused.",
      "AWS Budgets: RI coverage and utilization budgets can alert when coverage falls below a target or utilization drops, but they do not explain the attribute mismatch.",
      "Instance inventory: family, size, Region, platform, and tenancy of the running fleet. Compare the attributes with the reservations before assuming the discount should apply.",
      "Deployment and migration history: a move to a new family, a container platform, or another account is the usual explanation for a sudden effective-coverage drop.",
      "Reservation expiry and modification history: an expired or modified reservation changes both coverage and the rate from that hour.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare purchased coverage with effective coverage. If they differ, list the running instance attributes and the reservation attributes side by side. Then check utilization by reservation and the remaining term. Do not buy more coverage until you know whether the old commitment can be exchanged, modified, or sold.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the mismatch: family, size, Region, platform, tenancy, or account. Effective coverage below purchased coverage is the signal.",
      "Quantify the unused commitment per month and the remaining term. The monthly number drives the bill; the term drives the exposure.",
      "Use the flexibility the offering class allows: modify a standard reservation where permitted, exchange a convertible one, or sell a standard one on the Marketplace.",
      "If the workload change is permanent, stop buying coverage for the old shape and re-plan the commitment around the new fleet.",
      "Prefer flexibility for workloads that may change: Compute Savings Plans cover family, size, Region, OS, and tenancy, at a smaller discount than the least flexible options.",
      "Ladder purchases instead of covering the whole fleet at once, and review coverage and utilization together every month.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More coverage lowers the rate but increases the cost of being wrong. The cheapest commitment is not the cheapest outcome if the workload changes.",
      "Standard reservations discount more but cannot be exchanged; convertible reservations cost more but follow a change.",
      "A longer term lowers the rate and lengthens the exposure. The term is a forecast-confidence decision.",
      "Selling on the Marketplace can recover some value but takes time and may not be available for every offering class.",
      "Coverage targets can become a vanity metric. A lower coverage percentage with matched reservations can cost less than a high headline number.",
      "Savings Plans are often the better default for compute that may change shape, but they still commit spend and still require a forecast.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "coverage-vs-utilization",
    question:
      "Coverage is 80% but the bill is rising. How do you explain the difference between coverage and utilization?",
    difficulty: 2,
    hints: [
      "Coverage is about eligible usage; utilization is about the purchase.",
      "One can be high while the other is low.",
    ],
    answer:
      "Coverage is the share of eligible instance hours that a reservation covers. Utilization is the share of the purchased reservation hours that are actually used. If the fleet moves to another family, the old reservation has no eligible usage, so utilization falls even if the account-level coverage number still counts the old purchase. The new family runs on-demand. I would compare purchased coverage with effective coverage, then read utilization by reservation and the remaining term. The bill rises because unused reservations are still billed and the replacement usage is at the on-demand rate.",
    followUps: [
      "Which number would you alert on?",
      "How does a regional RI's size flexibility change the answer?",
      "What if coverage is low but utilization is high?",
    ],
    redFlags: [
      "Treats coverage as a measure of savings.",
      "Ignores unused reservations.",
      "Assumes coverage follows the fleet automatically.",
    ],
    rubric: [
      "Defines both metrics correctly.",
      "Explains the mismatch.",
      "Connects it to the bill.",
      "Names a diagnostic.",
    ],
  },
  {
    id: "ri-attributes",
    question:
      "Which attributes must match for a Reserved Instance to apply, and what happens when they change?",
    difficulty: 2,
    hints: [
      "Family, size, Region, platform, tenancy.",
      "A reservation is a billing discount, not a running instance.",
    ],
    answer:
      "A reservation applies to usage that matches its instance family and size, Region, platform, and tenancy, subject to the scope and size-flexibility rules of the offering. If the workload moves to another family or Region, the reservation no longer applies to that usage, but it is still billed. The new usage is charged at the on-demand rate or covered by another reservation. I would compare the running fleet's attributes with the reservation attributes, then decide whether to modify, exchange, sell, or re-buy.",
    followUps: [
      "How does a zonal reservation differ from a regional one?",
      "What does size flexibility allow?",
      "What happens at the end of the term?",
    ],
    redFlags: [
      "Says the reservation follows the workload anywhere.",
      "Confuses the reservation with a capacity guarantee in every case.",
      "Ignores platform and tenancy.",
    ],
    rubric: [
      "Names the matching attributes.",
      "Explains the unused commitment.",
      "Distinguishes zonal and regional scope.",
      "Names a remedy.",
    ],
  },
  {
    id: "standard-vs-convertible",
    question:
      "When would you choose a standard reservation, and when would you choose a convertible one?",
    difficulty: 3,
    hints: [
      "The trade is discount versus the ability to change shape.",
      "Forecast confidence is the deciding input.",
    ],
    answer:
      "A standard reservation gives the larger discount but can only be modified, not exchanged, so it fits a workload whose family and Region are stable for the term. A convertible reservation gives a smaller discount but can be exchanged for a different configuration, so it fits a workload that may change family or size. I would also consider a Savings Plan, which commits spend rather than a specific instance shape and is more flexible than a reservation. The decision is a forecast-confidence decision: the less certain the shape, the more flexibility is worth paying for.",
    followUps: [
      "How does a Compute Savings Plan compare?",
      "What does modifying a standard RI allow?",
      "How would you measure whether the flexibility paid off?",
    ],
    redFlags: [
      "Always picks the largest discount.",
      "Assumes a standard RI can be exchanged.",
      "Ignores forecast confidence.",
    ],
    rubric: [
      "States the tradeoff.",
      "Knows what can be modified or exchanged.",
      "Mentions Savings Plans.",
      "Ties the choice to forecast confidence.",
    ],
  },
  {
    id: "commitment-process",
    question:
      "How would you decide how much coverage to buy and how would you monitor it afterward?",
    difficulty: 3,
    hints: [
      "Start from steady-state usage, not peak.",
      "Ladder the purchase and monitor coverage and utilization together.",
    ],
    answer:
      "I would start from the steady-state usage that is likely to persist for the term, not from peak or from the current bill. I would separate predictable baseline from variable and seasonal usage, then ladder commitments across terms instead of covering the whole fleet at once. I would leave the variable layer on-demand or under a more flexible plan. After purchase I would monitor coverage and utilization together, by reservation and by account, and alert when effective coverage falls or utilization drops. I would review the commitment before the next purchase and account for workload changes that are already planned.",
    followUps: [
      "What coverage target would you set?",
      "How do you handle a planned migration?",
      "What is the risk of covering 100% of steady state?",
    ],
    redFlags: [
      "Covers peak usage.",
      "Buys one large commitment for the whole fleet.",
      "Monitors coverage only.",
    ],
    rubric: [
      "Starts from steady-state usage.",
      "Ladders the commitment.",
      "Monitors coverage and utilization.",
      "Accounts for planned change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Coverage and utilization are reported together, by reservation and by account.",
      "The running fleet's family, size, Region, platform, and tenancy are compared with reservation attributes.",
      "Planned migrations are checked against the remaining commitment term.",
      "Commitments are laddered rather than covering the whole fleet at once.",
      "The break-even coverage level is documented, including the cost of unused commitment.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare purchased coverage with effective coverage before buying more.",
      "Quantify unused commitment per month and the remaining term.",
      "Check whether the reservation can be modified, exchanged, or sold.",
      "Check whether the new usage is on-demand or covered by another reservation.",
      "Do not cancel or resize the workload solely to match an old reservation.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-plan coverage around the current fleet, not the fleet the reservation was bought for.",
      "Use the flexibility the offering class allows, and record the outcome.",
      "Add a utilization alert and a coverage alert with an owner.",
      "Update the forecast process to include family and Region changes, not only instance count.",
    ],
  },
];

const references = [
  {
    title: "Reserved Instances for Amazon EC2 overview",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-reserved-instances.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Reservation attributes, terms, payment options, offering classes, modification, exchange, and Marketplace resale.",
  },
  {
    title: "Managing your costs with AWS Budgets",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-managing-costs.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "RI coverage and utilization budgets, including alerts when utilization falls below a target.",
  },
  {
    title: "Cost Optimization Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Commitment-based discounts and the tradeoff between rate and flexibility.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "reserved-instances": {
      model: reservedInstancesModel,
      presets,
      instructions:
        "Start healthy and compare purchased with effective coverage. Apply Coverage that no longer fits and watch effective coverage fall while the bill rises. Compare Short remaining term, then Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative commitment model. The on-demand rate, committed rate, and fleet are teaching values, not AWS prices or financial advice. Real coverage rules depend on scope, size flexibility, platform, and tenancy.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-savings-plans",
    "capacity-committed-use",
    "capacity-cost-allocation",
    "capacity-cost-per-request",
  ],
};
