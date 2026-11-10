import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const SIM_SECONDS = 60;

const params = [
  {
    id: "baselineSpendK",
    label: "On-demand baseline",
    min: 40,
    max: 300,
    step: 10,
    value: 100,
    unit: " k$/month",
    group: "Workload",
    help: "Monthly compute spend at on-demand rates before any commitment. Illustrative, not an AWS quote.",
    format: "number" as const,
  },
  {
    id: "coveragePct",
    label: "Committed coverage",
    min: 20,
    max: 100,
    step: 5,
    value: 55,
    unit: "% of baseline",
    group: "Commitment",
    help: "Share of the current baseline you commit to spend. The commitment is a monthly spend, not a promise that the workload stays.",
    format: "percent" as const,
  },
  {
    id: "termYears",
    label: "Commitment term",
    min: 1,
    max: 3,
    step: 1,
    value: 2,
    unit: " years",
    group: "Commitment",
    help: "Contract length. The model compresses the term into 60 simulated seconds.",
    format: "count" as const,
  },
  {
    id: "discountPct",
    label: "Discount on committed spend",
    min: 20,
    max: 50,
    step: 5,
    value: 30,
    unit: "%",
    group: "Commitment",
    help: "Illustrative discount. Real rates vary by service, term, payment option, and region.",
    format: "percent" as const,
  },
  {
    id: "annualDemandChangePct",
    label: "Annual demand change",
    min: -40,
    max: 40,
    step: 5,
    value: 5,
    unit: "%/year",
    group: "Workload",
    help: "How the workload changes after the commitment is signed. Negative values model a migration, a shutdown, or a move to a cheaper architecture.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function usageAt(baselineK: number, annualChangePct: number, month: number): number {
  const monthlyGrowth = Math.pow(1 + annualChangePct / 100, (month - 1) / 12);
  return Math.max(0, baselineK * monthlyGrowth);
}

interface MonthResult {
  month: number;
  usageK: number;
  billK: number;
  savingsK: number;
  unusedK: number;
}

function monthResult(
  baselineK: number,
  committedK: number,
  discount: number,
  annualChangePct: number,
  month: number,
): MonthResult {
  const usageK = usageAt(baselineK, annualChangePct, month);
  const unusedK = Math.max(0, committedK - usageK);
  const billK = committedK * (1 - discount) + Math.max(0, usageK - committedK);
  const savingsK = usageK - billK;
  return { month, usageK, billK, savingsK, unusedK };
}

interface Computed extends MonthResult {
  committedK: number;
  termMonths: number;
  cumulativeSavingsK: number;
  cumulativeOnDemandK: number;
  wastedToDateK: number;
  coveragePct: number;
  strandedPct: number;
  effectiveDiscountPct: number;
}

function compute(p: Params, t: number): Computed {
  const baselineK = Math.max(10, num(p, "baselineSpendK", 100));
  const coverage = clamp(num(p, "coveragePct", 55) / 100, 0.05, 1);
  const termYears = clamp(Math.round(num(p, "termYears", 2)), 1, 3);
  const termMonths = termYears * 12;
  const discount = clamp(num(p, "discountPct", 30) / 100, 0.05, 0.8);
  const annualChange = clamp(num(p, "annualDemandChangePct", 5), -60, 60);
  const committedK = baselineK * coverage;
  const elapsed = clamp(t / SIM_SECONDS, 0, 0.9999);
  const month = Math.min(termMonths, 1 + Math.floor(elapsed * termMonths));
  const current = monthResult(baselineK, committedK, discount, annualChange, month);
  let cumulativeSavingsK = 0;
  let cumulativeOnDemandK = 0;
  let wastedToDateK = 0;
  for (let index = 1; index <= month; index++) {
    const row = monthResult(baselineK, committedK, discount, annualChange, index);
    cumulativeSavingsK += row.savingsK;
    cumulativeOnDemandK += row.usageK;
    wastedToDateK += row.unusedK;
  }
  const coveragePct = (Math.min(committedK, current.usageK) / Math.max(0.01, current.usageK)) * 100;
  return {
    ...current,
    committedK,
    termMonths,
    cumulativeSavingsK,
    cumulativeOnDemandK,
    wastedToDateK,
    coveragePct,
    strandedPct: (current.unusedK / Math.max(0.01, committedK)) * 100,
    effectiveDiscountPct: Math.max(0, (cumulativeSavingsK / Math.max(0.01, cumulativeOnDemandK)) * 100),
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.unusedK >= 30 || values.strandedPct >= 40) return "crit";
  if (values.unusedK >= 10 || values.strandedPct >= 20) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.03 * Math.sin((offset + (seed % 5)) / 2.7);
  const entries: [string, number, number][] = [
    ["unused-commitment", values.unusedK, 0.4],
    ["stranded-share", values.strandedPct, 0.3],
    ["wasted-to-date", values.wastedToDateK, 0.8],
    ["monthly-bill", values.billK, 0.5],
    ["coverage", values.coveragePct, 0.1],
    ["effective-discount", values.effectiveDiscountPct, 0.2],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.4 + value) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, t: number, state: { underused: boolean }): SimFrame {
  const v = compute(p, t);
  const health = healthFor(v);
  return {
    t: 0,
    nodes: [
      {
        id: "workload",
        label: "Workload demand",
        kind: "service",
        health: "ok",
        sublabel: `${v.usageK.toFixed(0)}k$/month usage`,
        detail: `At month ${v.month} of ${v.termMonths}, the workload uses ${v.usageK.toFixed(1)}k$ per month against a ${v.committedK.toFixed(1)}k$ commitment.`,
        meta: { view: "flow" },
      },
      {
        id: "commitment",
        label: "Committed spend",
        kind: "service",
        health,
        utilization: clamp(Math.min(v.committedK, v.usageK) / Math.max(0.01, v.committedK)),
        sublabel: `${v.committedK.toFixed(0)}k$/month · ${v.termMonths} months`,
        detail: `${v.coveragePct.toFixed(0)}% of current usage is covered. ${v.unusedK.toFixed(1)}k$ of the commitment is unused this month.`,
        meta: { view: "flow" },
      },
      {
        id: "bill",
        label: "Monthly bill",
        kind: "storage",
        health,
        sublabel: `${v.billK.toFixed(0)}k$/month`,
        detail: `The commitment bills whether or not the workload uses it. On-demand equivalent this month is ${v.usageK.toFixed(1)}k$. Illustrative.`,
        meta: { view: "flow" },
      },
      {
        id: "plan",
        label: "Finance plan",
        kind: "db",
        health,
        utilization: clamp(v.effectiveDiscountPct / 100),
        sublabel: `${v.effectiveDiscountPct.toFixed(1)}% effective discount`,
        detail: `Cumulative savings are ${Math.max(0, v.cumulativeSavingsK).toFixed(1)}k$; ${v.wastedToDateK.toFixed(1)}k$ of committed spend has gone unused.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("workload-bill", "workload", "bill", clamp(v.usageK / Math.max(1, v.committedK)), health),
      edge("commitment-bill", "commitment", "bill", clamp(v.committedK / Math.max(1, v.usageK)), health),
      edge("bill-plan", "bill", "plan", clamp(v.coveragePct / 100), health),
    ],
    metrics: [
      metric("unused-commitment", "Unused commitment this month", v.unusedK, " k$", 10, 30, "number"),
      metric("stranded-share", "Stranded commitment", v.strandedPct, "%", 20, 40, "percent"),
      metric("wasted-to-date", "Committed spend unused to date", v.wastedToDateK, " k$", undefined, undefined, "number"),
      metric("monthly-bill", "Monthly bill", v.billK, " k$", undefined, undefined, "number"),
      metric("coverage", "Usage covered", v.coveragePct, "%", undefined, undefined, "percent"),
      metric("effective-discount", "Effective discount to date", v.effectiveDiscountPct, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      underused: state.underused ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `Month ${v.month} of ${v.termMonths}: ${v.coveragePct.toFixed(0)}% of usage covered, ${v.unusedK.toFixed(0)}k$ unused, ${v.wastedToDateK.toFixed(0)}k$ wasted to date. Effective discount ${v.effectiveDiscountPct.toFixed(1)}%. Illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, 0, { underused: false });
  seedSeries(frame, compute(p, 0), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unused-commitment",
    metricId: "unused-commitment",
    warn: 10,
    crit: 30,
    title: "The commitment outlived the workload",
    cause:
      "The workload now uses less than the committed amount. The commitment still bills at the discounted rate, so the unused share is paid for without producing value. A short forecast error becomes a multi-year liability.",
    fix:
      "Reduce coverage before the next term and shorten the term. When the workload has already changed, model the remaining payments against the on-demand alternative and decide whether to absorb the waste or change the architecture around the commitment.",
    checkFirst: [
      "Compare monthly usage with committed spend and with coverage.",
      "Check whether the change is a migration, a shutdown, or a cheaper instance mix.",
      "Check how many months remain on the commitment and whether it can be resold or exchanged.",
    ],
  },
  {
    id: "stranded-share",
    metricId: "stranded-share",
    warn: 20,
    crit: 40,
    title: "A large share of the commitment is stranded",
    cause:
      "Coverage was set from an optimistic baseline and the workload moved away from the committed service, family, or region. The discount on the used portion no longer pays for the unused portion.",
    fix:
      "Cover only the demand you are confident about, and keep the rest on-demand or on a shorter term. Prefer a commitment that follows the workload, such as a compute commitment that is not tied to one instance family.",
    checkFirst: [
      "Check utilization and coverage separately; a high utilization can still hide low coverage.",
      "Check whether the commitment is tied to a family, region, or service the workload is leaving.",
      "Compare the remaining term with the forecast for the workload.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const committedUseModel: SimModel = {
  id: "capacity-committed-use",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const values = compute(p, t);
    const underused = frame.flags.underused === 1 || values.unusedK >= 1;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), t, { underused });
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (underused && frame.flags.underused !== 1) {
      pushEvent(next, {
        id: "commitment-underused",
        at: t,
        severity: values.strandedPct >= 40 ? "crit" : values.strandedPct >= 20 ? "warn" : "info",
        title: "Usage has fallen below the commitment",
        detail: `The workload uses ${values.usageK.toFixed(1)}k$ per month against a ${values.committedK.toFixed(1)}k$ commitment. ${values.unusedK.toFixed(1)}k$ is stranded with ${values.termMonths - values.month} months left.`,
        nodeId: "commitment",
        metricId: "unused-commitment",
      });
    }

    next.flags.underused = underused ? 1 : 0;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `${value("coverage").toFixed(0)}% of current usage is covered and ${value("unused-commitment").toFixed(0)}k$ of the commitment is unused this month.`,
    ];
    if (value("unused-commitment") >= 1) {
      items.push(
        `${value("wasted-to-date").toFixed(0)}k$ of committed spend has gone unused. The effective discount is ${value("effective-discount").toFixed(1)}%, not the headline rate.`,
      );
    }
    items.push(
      "Coverage times remaining demand is the commitment you can use. Discount times that coverage is the saving; unused coverage times the term is the risk.",
    );
    return items;
  },
  legend: [
    { label: "Covered", tone: "ok" },
    { label: "Partly stranded", tone: "warn" },
    { label: "Stranded", tone: "crit" },
    { label: "No data", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "55% coverage over two years with demand growing; the commitment stays used.",
    tone: "ok",
    params: defaults({ baselineSpendK: 100, coveragePct: 55, termYears: 2, discountPct: 30, annualDemandChangePct: 5 }),
  },
  {
    id: "peak",
    label: "Optimistic coverage",
    description: "90% coverage for three years while demand falls 15% a year; the last year is mostly stranded.",
    tone: "warn",
    params: defaults({ baselineSpendK: 100, coveragePct: 90, termYears: 3, discountPct: 40, annualDemandChangePct: -15 }),
  },
  {
    id: "failure",
    label: "The workload moved",
    description: "95% coverage for three years, then demand falls 35% a year after a migration.",
    tone: "crit",
    params: defaults({ baselineSpendK: 100, coveragePct: 95, termYears: 3, discountPct: 30, annualDemandChangePct: -35 }),
  },
  {
    id: "flexible",
    label: "Short and partial",
    description: "30% coverage for one year; less discount, almost no stranded spend.",
    tone: "ok",
    params: defaults({ baselineSpendK: 100, coveragePct: 30, termYears: 1, discountPct: 25, annualDemandChangePct: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "45% coverage for one year with a mild decline; the commitment stays used through the term.",
    tone: "ok",
    params: defaults({ baselineSpendK: 100, coveragePct: 45, termYears: 1, discountPct: 35, annualDemandChangePct: -5 }),
  },
];

const experiment: Experiment = {
  id: "predict-commitment-shape",
  title: "Predict the commitment that survives a workload change",
  simId: "committed-use",
  question:
    "A team expects a 25% annual decline after a migration, but the vendor offers 40% off for three years. What commitment shape preserves the most value?",
  prediction: {
    options: [
      { id: "max", label: "Take the 40% discount at 100% coverage for three years" },
      { id: "partial", label: "Commit 50% of the baseline for one year and re-evaluate" },
      { id: "none", label: "Avoid commitments entirely and stay on-demand" },
      { id: "floor", label: "Commit 100% for one year to get the discount without a long term" },
    ],
    correctOptionId: "partial",
    explanation:
      "A three-year commitment to a declining workload leaves the later years stranded, and a one-year 100% commitment still overcommits against a 25% decline. Partial coverage keeps the discount on the demand that is likely to remain while leaving the rest flexible. Avoiding commitments loses the discount on stable usage. The right coverage is the part of the forecast you would defend in the second year.",
  },
  setup: defaults({ baselineSpendK: 100, coveragePct: 95, termYears: 3, discountPct: 40, annualDemandChangePct: -25 }),
  runFor: 60,
  observe: [
    "In the first months the discount produces a visible saving.",
    "As usage falls below the commitment, the unused line grows and the effective discount falls.",
    "By the end of the term, unused commitment is a large monthly line and the headline discount no longer describes the outcome.",
    "The short, partial commitment keeps most of the discount on the usage that remains.",
  ],
  explain:
    "The break-even is not the discount rate. It is the point where cumulative savings from the used commitment exceed the cumulative cost of the unused commitment. Forecast confidence sets coverage, and the term sets how long a forecast error compounds. A shorter term reduces the error window; partial coverage reduces the size of each error.",
  fix: defaults({ baselineSpendK: 100, coveragePct: 50, termYears: 1, discountPct: 30, annualDemandChangePct: -25 }),
  debrief:
    "At 50% coverage for one year, the team still discounts the stable half of the workload and absorbs only one year of forecast error. The saving is smaller than the headline offer, and the downside is bounded. That is the trade a commitment asks for: a known discount in exchange for a forecast the business can defend.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A commitment is a promise to spend a fixed amount on compute for a term in exchange for a discount. AWS Savings Plans and Reserved Instances are the common forms. The commitment bills whether or not the workload uses it. That makes the decision a bet on future demand, not a coupon: the discount is certain, the usage is not, and the term controls how long a forecast error can compound.",
  },
  {
    type: "p",
    text: "Two numbers describe a commitment. Coverage is the share of current usage the commitment pays for. Utilization is the share of the commitment that is used. High utilization with low coverage means the commitment is safely used but leaves most spend undiscounted. High coverage with falling utilization means the discount is being eaten by stranded spend. The second case is the one that produces a multi-year liability.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is workload, commitment, bill, and finance plan. The commitment applies to eligible usage, and the billing system applies the discounted rate to that usage first. Unused commitment does not roll over. The finance plan sees the discount and the unused line together only if both are reported; a dashboard that shows only the effective rate hides the stranded spend.",
  },
  {
    type: "table",
    headers: ["Choice", "Discount", "Flexibility", "Main risk"],
    rows: [
      ["One-year, partial coverage", "Lower", "Re-evaluate every year", "Leaves some savings on the table"],
      ["Three-year, partial coverage", "Higher", "Limited to the committed share", "A long error window on that share"],
      ["Three-year, full coverage", "Highest", "Little; the workload must stay", "Stranded spend after a migration"],
      ["No commitment", "None", "Full", "Pays on-demand for stable usage"],
    ],
  },
  {
    type: "p",
    text: "This model compresses a one-to-three-year term into 60 simulated seconds. It uses a monthly spend commitment, a constant annual demand change, and an illustrative discount. It does not model upfront payments, partial upfront, service-specific eligibility, or resale. Those details change the cash flow, not the coverage-versus-flexibility trade.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unused commitment and stranded share as the term progresses.",
      "Coverage and effective discount, which diverge from the headline rate when usage falls.",
      "Committed spend unused to date, so the cumulative cost of a bad forecast is visible.",
      "A flow view from workload and commitment to the bill and the finance plan.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then run The workload moved. Watch the unused line grow as the simulated term advances. Compare Short and partial with Optimistic coverage. Run the guided experiment before changing sliders: the headline discount is the least important number in the decision.",
  },
  { type: "sim", simId: "committed-use" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The team committed to 95% of a 100k$ monthly baseline for three years at a 30% discount. Demand then fell 35% a year. In the first months the discount looked like a clear win. As usage dropped below the commitment, the unused line appeared, then grew. By the end of the term the workload used about 29k$ a month against a 95k$ commitment, and most of the commitment was stranded.",
  },
  {
    type: "p",
    text: "The effective discount told the same story from the other side: it fell as the unused share grew, because the discount on the used portion no longer covered the unused commitment. The short, partial preset kept the commitment close to the demand that remained. It gave up headline rate and kept the downside small.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Savings Plans: utilization and coverage in Cost Explorer. Utilization near 100% with coverage near 40% is a different risk than coverage near 95% with falling utilization.",
      "Cost and Usage Reports: the commitment fee, the discounted usage, and the unused commitment as separate line items.",
      "Reserved Instances: unused reservations and the instance families they are tied to. A family change can strand a reservation that was fully utilized last quarter.",
      "Budgets and forecasts: a plan that still assumes the old baseline after a migration. The commitment line is fixed while the workload line moves.",
      "Architecture changes: a move to Graviton, containers, or serverless can change which commitment applies and how much usage is eligible.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare coverage with utilization, not the headline discount. Check the remaining term against the forecast for the workload. Check whether the commitment follows the service, family, and region the workload is moving to. Then compare the remaining payments with the on-demand alternative.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure coverage and utilization separately, by commitment and by account.",
      "Set coverage from the demand you can defend for the whole term, not from the peak month.",
      "Shorten the term when forecast confidence is low; the discount is smaller and so is the error window.",
      "Prefer a commitment that follows the workload across families and regions when the architecture is changing.",
      "Model the remaining payments against on-demand before adding more coverage. Sunk cost is not a reason to commit again.",
      "Review coverage at every architecture change, not only at renewal.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer terms buy a larger discount and a longer window for the forecast to be wrong.",
      "Higher coverage increases savings on stable usage and the size of the stranded line if usage falls.",
      "Partial coverage leaves some spend at on-demand rates; that is the price of flexibility, not a failure.",
      "A commitment tied to a specific family or region can save more and strand faster when the workload moves.",
      "Avoiding commitments entirely is a valid choice for a workload whose architecture or ownership is about to change.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "evaluate-commitment",
    question:
      "A three-year commitment saves 40% and the workload may change. How do you decide?",
    difficulty: 3,
    hints: [
      "Start from the demand you can defend for the whole term.",
      "Compare the discount with the cost of unused commitment, not with the on-demand bill alone.",
    ],
    answer:
      "I would separate the demand I am confident about from the demand that may move. I would cover the confident portion, choose a term I can defend, and leave the rest on-demand or on a shorter commitment. Then I would compute the break-even: the discount on used commitment minus the unused commitment over the term. A 40% discount on a workload that halves in year two is worse than a 25% discount on the half that remains. I would also check whether the commitment follows the planned architecture, and who owns the unused line if the forecast is wrong.",
    followUps: [
      "How would you split coverage across two commitments?",
      "What if the workload is growing quickly?",
      "Who should own the forecast?",
    ],
    redFlags: [
      "Takes the largest discount automatically.",
      "Ignores the remaining term.",
      "Assumes usage cannot change.",
    ],
    rubric: [
      "Separates confident demand.",
      "Computes break-even.",
      "Considers term and flexibility.",
      "Names an owner for the risk.",
    ],
  },
  {
    id: "coverage-utilization",
    question:
      "Utilization is 98% and coverage is 35%. Is the commitment healthy?",
    difficulty: 2,
    hints: [
      "Utilization describes the commitment; coverage describes the bill.",
      "A fully used commitment can still leave most spend undiscounted.",
    ],
    answer:
      "The commitment is being used, so there is little stranded spend. But 35% coverage means most of the eligible usage is still on-demand, so the team is leaving savings on the table. I would check whether the workload is stable enough to add coverage, and whether a second commitment would follow the same service and region. I would not call it unhealthy; I would call it under-covered.",
    followUps: [
      "What would you do next?",
      "How would you choose the additional coverage?",
      "What could make coverage fall?",
    ],
    redFlags: [
      "Confuses utilization with coverage.",
      "Says the commitment is wasted.",
      "Ignores the remaining on-demand spend.",
    ],
    rubric: [
      "Defines both terms.",
      "Recognizes under-coverage.",
      "Suggests a measured increase.",
      "Notes the risk of overcommitting.",
    ],
  },
  {
    id: "stranded-recovery",
    question:
      "The workload has moved and half the commitment is stranded with 18 months left. What do you do?",
    difficulty: 3,
    hints: [
      "Separate the sunk cost from the remaining decision.",
      "Check whether the commitment can be exchanged, resold, or used by another workload.",
    ],
    answer:
      "I would first quantify the remaining payments and the on-demand alternative, then look for ways to use the commitment: move an eligible workload onto it, exchange or resell it if the product allows, or change the instance mix within its scope. If none of that works, I would absorb the remaining cost, stop adding coverage, and change the planning rule that produced the overcommitment. I would not add more commitment just to make the utilization metric look better.",
    followUps: [
      "How do you avoid this next time?",
      "What does the finance owner need to see?",
      "When would you break the contract?",
    ],
    redFlags: [
      "Ignores the remaining term.",
      "Adds coverage to improve utilization.",
      "Treats the sunk cost as a reason to continue.",
    ],
    rubric: [
      "Quantifies remaining exposure.",
      "Looks for eligible usage or exchange.",
      "Stops adding coverage.",
      "Fixes the planning rule.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Coverage is set from demand the team can defend for the full term, not from the current peak.",
      "Utilization and coverage are reported separately for every commitment.",
      "The commitment's service, family, and region scope match the architecture plan.",
      "A named owner reviews coverage at every architecture change and renewal.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare current usage with committed spend and the remaining term.",
      "Check whether the commitment can be exchanged, resold, or used by another workload.",
      "Stop adding coverage until the forecast is corrected.",
      "Quantify the unused line against the on-demand alternative.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Adjust coverage and term for the next purchase.",
      "Prefer commitments that follow the workload when the architecture is moving.",
      "Report the effective discount, not only the headline rate.",
      "Document the forecast error and the decision that produced it.",
    ],
  },
];

const references = [
  {
    title: "AWS Savings Plans: what they are",
    url: "https://docs.aws.amazon.com/savingsplans/latest/userguide/what-is-savings-plans.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Commitment model, term options, and the difference between Compute and EC2 Instance Savings Plans.",
  },
  {
    title: "AWS Cost Management: Savings Plans utilization and coverage",
    url: "https://docs.aws.amazon.com/cost-management/latest/userguide/sp-utilization.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How AWS reports Savings Plans utilization against the purchased commitment.",
  },
  {
    title: "AWS: Reserved Instances",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-reserved-instances.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Term, payment options, and the scope limits that can strand a reservation after an architecture change.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "committed-use": {
      model: committedUseModel,
      presets,
      instructions:
        "Start healthy, then run The workload moved. Watch unused commitment grow across the term. Compare Short and partial and Recovery, then run the guided experiment.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The term is compressed into 60 simulated seconds; discounts, spend, and demand changes are teaching values, not AWS pricing.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-savings-plans",
    "capacity-reserved-instances",
    "capacity-unit-economics",
    "capacity-cost-allocation",
    "capacity-rightsizing",
  ],
};
