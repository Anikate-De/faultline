import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "monthlySpendK",
    label: "Monthly cloud spend",
    min: 100,
    max: 1_000,
    step: 25,
    value: 420,
    unit: " k$/month",
    group: "Bill",
    help: "Total monthly bill before allocation. All dollar figures are illustrative, not an AWS quote.",
    format: "number" as const,
  },
  {
    id: "taggedSharePct",
    label: "Tagged direct spend",
    min: 30,
    max: 100,
    step: 1,
    value: 92,
    unit: "%",
    group: "Allocation",
    help: "Share of direct workload spend carrying a valid team or cost-center tag.",
    format: "percent" as const,
  },
  {
    id: "sharedSpendPct",
    label: "Shared platform spend",
    min: 5,
    max: 50,
    step: 5,
    value: 25,
    unit: "% of bill",
    group: "Allocation",
    help: "Spend that cannot be tagged to a single team: network, observability, identity, and shared clusters.",
    format: "percent" as const,
  },
  {
    id: "sharedRulePct",
    label: "Shared cost allocated by rule",
    min: 0,
    max: 100,
    step: 5,
    value: 85,
    unit: "% of shared",
    group: "Allocation",
    help: "Share of shared spend covered by an explicit split rule. The rest remains unowned even if every direct resource is tagged.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  totalK: number;
  directK: number;
  sharedK: number;
  directTaggedK: number;
  directUntaggedK: number;
  sharedAllocatedK: number;
  sharedUnownedK: number;
  allocatedK: number;
  unallocatedK: number;
  unallocatedPct: number;
  ownerCoveragePct: number;
}

function compute(p: Params): Computed {
  const totalK = Math.max(10, num(p, "monthlySpendK", 420));
  const tagged = clamp(num(p, "taggedSharePct", 92) / 100, 0, 1);
  const sharedShare = clamp(num(p, "sharedSpendPct", 25) / 100, 0, 0.8);
  const rule = clamp(num(p, "sharedRulePct", 85) / 100, 0, 1);
  const sharedK = totalK * sharedShare;
  const directK = totalK - sharedK;
  const directTaggedK = directK * tagged;
  const directUntaggedK = directK * (1 - tagged);
  const sharedAllocatedK = sharedK * rule;
  const sharedUnownedK = sharedK * (1 - rule);
  const allocatedK = directTaggedK + sharedAllocatedK;
  const unallocatedK = directUntaggedK + sharedUnownedK;
  return {
    totalK,
    directK,
    sharedK,
    directTaggedK,
    directUntaggedK,
    sharedAllocatedK,
    sharedUnownedK,
    allocatedK,
    unallocatedK,
    unallocatedPct: (unallocatedK / totalK) * 100,
    ownerCoveragePct: (allocatedK / totalK) * 100,
  };
}

function healthFor(values: Computed): "ok" | "warn" | "crit" {
  if (values.unallocatedPct >= 25 || values.unallocatedK >= 150) return "crit";
  if (values.unallocatedPct >= 10 || values.unallocatedK >= 60) return "warn";
  return "ok";
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.03 * Math.sin((offset + (seed % 6)) / 2.8);
  const entries: [string, number, number][] = [
    ["allocated-cost", values.allocatedK, 0.8],
    ["unallocated-cost", values.unallocatedK, 0.6],
    ["unallocated-share", values.unallocatedPct, 0.3],
    ["shared-unallocated", values.sharedUnownedK, 0.4],
    ["shared-cost", values.sharedK, 0.4],
    ["owner-coverage", values.ownerCoveragePct, 0.3],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.5 + value) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number, state: { announced: boolean }): SimFrame {
  const v = compute(p);
  const health = healthFor(v);
  return {
    t: 0,
    nodes: [
      {
        id: "teams",
        label: "Engineering teams",
        kind: "service",
        health: "ok",
        sublabel: `${v.directTaggedK.toFixed(0)}k$ tagged directly`,
        detail: "Teams control the resources they tag. Direct allocation is the part of the bill with a clear owner.",
        meta: { view: "flow" },
      },
      {
        id: "shared",
        label: "Shared platform",
        kind: "service",
        health: v.sharedUnownedK >= 90 ? "crit" : v.sharedUnownedK >= 30 ? "warn" : "ok",
        utilization: clamp(v.sharedAllocatedK / Math.max(1, v.sharedK)),
        sublabel: `${v.sharedUnownedK.toFixed(0)}k$ unallocated`,
        detail: `${v.sharedK.toFixed(0)}k$ is shared. ${v.sharedAllocatedK.toFixed(0)}k$ is covered by a split rule; the rest has no owner.`,
        meta: { view: "flow" },
      },
      {
        id: "bill",
        label: "Monthly bill",
        kind: "storage",
        health,
        sublabel: `${v.totalK.toFixed(0)}k$ total`,
        detail: `${v.allocatedK.toFixed(0)}k$ allocated and ${v.unallocatedK.toFixed(0)}k$ unowned. Every figure is illustrative.`,
        meta: { view: "flow" },
      },
      {
        id: "report",
        label: "Showback report",
        kind: "db",
        health,
        utilization: clamp(v.ownerCoveragePct / 100),
        sublabel: `${v.ownerCoveragePct.toFixed(0)}% owned`,
        detail: "The report is only as complete as the rules behind it. A large unowned line is a rule gap, not a rounding error.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("teams-bill", "teams", "bill", clamp(v.directTaggedK / v.totalK), health === "crit" ? "warn" : health),
      edge("shared-bill", "shared", "bill", clamp(v.sharedK / v.totalK), v.sharedUnownedK > 0 ? "warn" : "ok"),
      edge("bill-report", "bill", "report", clamp(v.ownerCoveragePct / 100), health),
    ],
    metrics: [
      metric("unallocated-cost", "Unowned spend", v.unallocatedK, " k$/month", 60, 150, "number"),
      metric("unallocated-share", "Unowned share", v.unallocatedPct, "%", 10, 25, "percent"),
      metric("shared-unallocated", "Shared spend without a rule", v.sharedUnownedK, " k$/month", 30, 90, "number"),
      metric("allocated-cost", "Allocated spend", v.allocatedK, " k$/month", undefined, undefined, "number"),
      metric("owner-coverage", "Owner coverage", v.ownerCoveragePct, "%", undefined, undefined, "percent"),
      metric("shared-cost", "Shared platform spend", v.sharedK, " k$/month", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      announced: state.announced ? 1 : 0,
      paramsKey: JSON.stringify(p),
    },
    summary: `${v.totalK.toFixed(0)}k$/month: ${v.allocatedK.toFixed(0)}k$ allocated, ${v.unallocatedK.toFixed(0)}k$ unowned (${v.unallocatedPct.toFixed(1)}%). ${v.sharedUnownedK.toFixed(0)}k$ of the gap is shared spend without a rule. Illustrative.`,
  };
}

function seedFrame(p: Params, seed: number): SimFrame {
  const frame = buildFrame(p, seed, { announced: false });
  seedSeries(frame, compute(p), seed);
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unallocated-cost",
    metricId: "unallocated-cost",
    warn: 60,
    crit: 150,
    title: "A large cost line has no owner",
    cause:
      "Spend is either untagged or shared without a rule. At this size the gap is not a few stray resources; it is a missing allocation path that the bill will keep producing every month.",
    fix:
      "Find the largest unowned line first, tag or re-home the resources that can be attributed, and write an explicit rule for the shared remainder. A percentage split without a named owner only moves the ambiguity.",
    checkFirst: [
      "Group the bill by tag key and by untagged cost, then sort by spend.",
      "Separate direct untagged spend from shared spend without a rule.",
      "Check whether the resource is new, or whether its tag was removed or never applied.",
    ],
  },
  {
    id: "unallocated-share",
    metricId: "unallocated-share",
    warn: 10,
    crit: 25,
    title: "Too much of the bill is unowned",
    cause:
      "The allocation rules cover the majority of spend but not enough of it. A small unowned share can still be a large absolute number on a big bill, so the percentage and the dollars must be read together.",
    fix:
      "Raise tag coverage for direct resources and add a shared-cost split. Set a coverage target with the finance owner and review the largest unowned line each month.",
    checkFirst: [
      "Compare the unowned share with the unowned dollars and the total bill.",
      "Check tag coverage by service and by account.",
      "Check whether shared spend is growing faster than direct spend.",
    ],
  },
  {
    id: "shared-unallocated",
    metricId: "shared-unallocated",
    warn: 30,
    crit: 90,
    title: "Shared spend has no allocation rule",
    cause:
      "Tags cannot attribute a shared platform by themselves. Without a rule, the cost stays in a central line and no team has an incentive to use it efficiently.",
    fix:
      "Choose a split that follows the driver: usage, requests, seats, or a fixed share. Document the rule, review it when the platform changes, and keep the residual visible instead of hiding it in a percentage.",
    checkFirst: [
      "Identify the largest shared line and its actual driver.",
      "Check whether the split rule still matches how teams use the platform.",
      "Check whether the rule is visible to the teams that pay it.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const costAllocationModel: SimModel = {
  id: "capacity-cost-allocation",
  visual: "flow",
  params,
  init: ({ seed }) => seedFrame(defaults(), seed),
  step: (frame, p) => {
    const t = frame.t;
    const values = compute(p);
    const announced = frame.flags.announced === 1;
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110), { announced });
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (!announced) {
      pushEvent(next, {
        id: "allocation-close",
        at: t,
        severity: values.unallocatedPct >= 25 ? "crit" : values.unallocatedPct >= 10 ? "warn" : "info",
        title: "The month closes with an unowned balance",
        detail: `${values.unallocatedK.toFixed(0)}k$ of ${values.totalK.toFixed(0)}k$ has no owner: ${values.directUntaggedK.toFixed(0)}k$ direct untagged and ${values.sharedUnownedK.toFixed(0)}k$ shared without a rule.`,
        nodeId: "bill",
        metricId: "unallocated-cost",
      });
    }

    next.flags.announced = 1;
    next.flags.paramsKey = JSON.stringify(p);
    return next;
  },
  thresholds,
  insights: (frame) => {
    const value = (id: string) => frame.metrics.find((item) => item.id === id)?.value ?? 0;
    const items = [
      `${value("allocated-cost").toFixed(0)}k$ of the bill is allocated and ${value("unallocated-cost").toFixed(0)}k$ is not.`,
    ];
    if (value("shared-unallocated") >= 1) {
      items.push(
        `${value("shared-unallocated").toFixed(0)}k$ of the gap is shared spend without a rule. Tagging every direct resource will not close it.`,
      );
    }
    items.push(
      "Tags allocate what a team controls. Shared-cost rules allocate what no single team controls. A complete report needs both, plus a visible residual.",
    );
    return items;
  },
  legend: [
    { label: "Allocated", tone: "ok" },
    { label: "Partly owned", tone: "warn" },
    { label: "Unowned", tone: "crit" },
    { label: "No data", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "High tag coverage and an explicit rule for most shared spend.",
    tone: "ok",
    params: defaults({ monthlySpendK: 420, taggedSharePct: 92, sharedSpendPct: 25, sharedRulePct: 85 }),
  },
  {
    id: "peak",
    label: "Growth without tags",
    description: "Spend grows while tag coverage slips and shared spend outruns its rule.",
    tone: "warn",
    params: defaults({ monthlySpendK: 520, taggedSharePct: 88, sharedSpendPct: 30, sharedRulePct: 70 }),
  },
  {
    id: "failure",
    label: "The unowned bill",
    description: "Most direct spend is untagged and 85% of a large shared platform has no rule.",
    tone: "crit",
    params: defaults({ monthlySpendK: 480, taggedSharePct: 55, sharedSpendPct: 45, sharedRulePct: 15 }),
  },
  {
    id: "shared-platform",
    label: "Fully allocated, still unclear",
    description: "Every direct resource is tagged and the shared platform is fully split; allocation is complete, but the shared driver is hidden.",
    tone: "ok",
    params: defaults({ monthlySpendK: 600, taggedSharePct: 100, sharedSpendPct: 50, sharedRulePct: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Tags cover 98% of direct spend and 95% of shared spend follows a rule.",
    tone: "ok",
    params: defaults({ monthlySpendK: 480, taggedSharePct: 98, sharedSpendPct: 35, sharedRulePct: 95 }),
  },
];

const experiment: Experiment = {
  id: "predict-largest-unowned-line",
  title: "Predict which lever closes the largest unowned line",
  simId: "cost-allocation",
  question:
    "A 420k$ bill has 55% direct tag coverage, 20% shared platform spend, and a rule covering only 15% of that shared spend. Which single change closes the largest unowned line?",
  prediction: {
    options: [
      { id: "tags", label: "Raise direct tag coverage to 95%" },
      { id: "shared", label: "Raise the shared rule to 100%" },
      { id: "equal", label: "Split the shared platform evenly across all teams" },
      { id: "review", label: "Review the bill monthly with finance" },
    ],
    correctOptionId: "tags",
    explanation:
      "Direct untagged spend is 45% of 336k$, or 151k$. Shared spend without a rule is 85% of 84k$, or 71k$. Tagging direct resources removes the larger line. A perfect shared rule still leaves 151k$ unowned, an even split is a rule but not a driver, and a review does not create an owner.",
  },
  setup: defaults({ monthlySpendK: 420, taggedSharePct: 55, sharedSpendPct: 20, sharedRulePct: 15 }),
  runFor: 20,
  observe: [
    "The unowned balance is about 223k$, or 53% of the bill.",
    "Direct untagged spend is about 151k$; shared spend without a rule is about 71k$.",
    "Raising tag coverage to 95% leaves the shared line visible but reduces the unowned total to about 88k$.",
    "Raising the shared rule to 100% still leaves about 151k$ unowned, because tags were the bigger gap.",
  ],
  explain:
    "Allocation starts with the resources a team controls. Tags are the cheapest way to attach those resources to an owner, and untagged direct spend is usually the largest single gap. Shared platforms need a second mechanism because no team owns them individually. The order matters: fix the large direct gap first, then decide how the shared remainder follows its driver.",
  fix: defaults({ monthlySpendK: 420, taggedSharePct: 95, sharedSpendPct: 20, sharedRulePct: 90 }),
  debrief:
    "With direct tags at 95% and a shared rule at 90%, the unowned balance falls to about 25k$, or 6% of the bill. The remaining shared residual is visible and small enough to review. Allocation is not the same as accountability: every allocated line still needs a team that can act on it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cost allocation is the set of rules that turns one cloud bill into lines a team can recognize. Three kinds of spend need different treatment. Direct spend belongs to a workload and can be tagged. Shared spend belongs to a platform that many teams use, so it needs a split rule. Untagged spend belongs to no one until someone finds it. A bill can be mostly allocated and still have a large line with no owner.",
  },
  {
    type: "p",
    text: "Tags answer who controls a resource. Accounts answer which business unit owns a boundary. Cost categories group either of those into reporting lines. None of them assigns a shared platform by itself. A shared-cost rule has to name the driver: usage, requests, seats, storage, or a fixed share. The rule is a policy decision, not a property of the bill.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is workload, resource tags or account, cost allocation report, and team budget. The billing pipeline reads tags and accounts, applies shared-cost rules, and produces showback or chargeback. A missing tag is invisible at the resource level and obvious at the report level, which is why the largest unowned line is usually found by sorting the bill rather than by inspecting one service.",
  },
  {
    type: "table",
    headers: ["Mechanism", "Answers", "Typical gap", "Failure mode"],
    rows: [
      ["Resource tag", "Which team controls this resource", "Untagged or misspelled keys", "A large line with no owner"],
      ["Account boundary", "Which unit owns this spend", "Shared services in a central account", "Cost sits outside team budgets"],
      ["Cost category", "How spend is grouped for reporting", "Rules not updated after a reorg", "Report looks complete but maps to old owners"],
      ["Shared-cost rule", "How a platform is divided", "No driver or no review", "Allocation without accountability"],
    ],
  },
  {
    type: "p",
    text: "The model uses a fixed monthly bill, a direct and shared split, tag coverage, and a shared-rule coverage. Dollar amounts and percentages are illustrative. It does not model credits, refunds, amortization, or multi-account consolidation; those change the arithmetic but not the ownership question.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Allocated and unowned spend in dollars and as a share of the bill.",
      "Shared spend without a rule, separated from direct untagged spend.",
      "Owner coverage, so the report shows how much of the bill has a team behind it.",
      "A flow view from teams and the shared platform to the bill and the showback report.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy, then open The unowned bill. Compare the unowned dollars with the unowned share; a small percentage on a large bill can still be a large line. Run the guided experiment before changing sliders. Then try Fully allocated, still unclear and explain why a complete report is not the same as an accountable one.",
  },
  { type: "sim", simId: "cost-allocation" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, 45% of direct spend was untagged and 85% of a large shared platform had no rule. Together they left about 302k$ of a 480k$ bill unowned. The largest single line was direct untagged spend, not the shared platform. Raising tag coverage removed more unowned dollars than perfecting the shared rule would have.",
  },
  {
    type: "p",
    text: "The recovery preset combined both mechanisms: 98% tag coverage and a rule for 95% of shared spend. The unowned balance fell to about 15k$. The fully allocated preset reached zero unowned spend while half the bill was a shared platform. It answered the allocation question and left the accountability question open, because a usage-based split still needs someone to own the platform's growth.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cost Explorer or Data Exports grouped by tag key, with an untagged group sorted by spend. The untagged group is often the largest single line.",
      "Tag policies and cost allocation tags: a tag that is not activated for cost allocation does not appear in the report.",
      "AWS Organizations consolidated billing: a central account can hide spend from the team that controls the workload.",
      "Cost categories: the mapping from accounts and tags to reporting owners, including the rules that were never updated after a reorg.",
      "Budget alerts per owner: an alert that fires on the central account has no team to act on it.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Sort the bill by untagged spend and by shared platform. Compare the two lines in dollars, not percentages. Check whether the tag is missing, misspelled, or simply not activated for cost allocation. Then check whether a shared-cost rule exists and whether it still follows the platform's driver.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the largest unowned line and classify it as direct untagged or shared without a rule.",
      "Tag or re-home the direct resources; make the tag mandatory at provisioning, not a monthly cleanup.",
      "Write a shared-cost rule with a named driver and a review owner. Publish the rule to the teams that pay it.",
      "Keep the residual visible. A report that hides the unowned remainder cannot be audited or improved.",
      "Set coverage targets for both mechanisms and review the largest line each month.",
      "Separate showback from chargeback. A number that affects a budget needs an owner who can change the resource.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Enforcing tags at provisioning improves coverage and slows teams down; retrofitting tags misses the resources that already exist.",
      "A usage-based shared split is fairer and more complex than an equal split; an equal split is simple and hides the driver.",
      "Chargeback creates a stronger incentive than showback and more disputes, especially when the shared rule changes.",
      "More accounts improve ownership boundaries and multiply consolidated-billing and reporting work.",
      "A perfect allocation report still does not prove that a team can change the cost it is assigned.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "allocate-bill",
    question:
      "The bill arrives as one number. How would you allocate it to teams?",
    difficulty: 2,
    hints: [
      "Separate direct, shared, and untagged spend.",
      "A tag is only useful if it is activated and maps to an owner.",
    ],
    answer:
      "I would split the bill into direct workload spend, shared platform spend, and untagged spend. Direct spend gets a mandatory team or cost-center tag, enforced at provisioning. Shared spend gets an explicit rule tied to its driver, such as usage or requests. Untagged spend is reported as a residual with a named owner and a plan to reduce it. I would also separate accounts where ownership boundaries are clear, activate the cost allocation tags, and publish showback before moving to chargeback.",
    followUps: [
      "What if a team reorg changes the mapping?",
      "How do you handle credits and refunds?",
      "Which mechanism would you build first?",
    ],
    redFlags: [
      "Splits everything equally.",
      "Assumes tags exist and are active.",
      "Ignores the unowned residual.",
    ],
    rubric: [
      "Separates the three kinds of spend.",
      "Names tags and accounts.",
      "Writes a shared rule with a driver.",
      "Keeps the residual visible.",
    ],
  },
  {
    id: "shared-cost",
    question:
      "How would you allocate a shared observability platform that every team uses but no team owns?",
    difficulty: 3,
    hints: [
      "Pick a driver that reflects consumption and is hard to game.",
      "Decide who owns the platform's growth, not only its bill.",
    ],
    answer:
      "I would pick a driver that reflects consumption, such as ingested bytes, active series, or requests, and allocate the platform cost in proportion to it. If the driver is easy to game, I would use a combination or a fixed share with a review. The platform team owns the unit cost and the capacity plan; the consuming teams see their share in showback. I would keep an unallocated residual for idle or shared baseline capacity and review the rule when the platform changes.",
    followUps: [
      "What if a team's usage is bursty?",
      "Who owns the platform's baseline capacity?",
      "How do you prevent the rule from becoming a subsidy?",
    ],
    redFlags: [
      "Splits equally without discussing the driver.",
      "Gives the platform no owner.",
      "Hides the residual in a percentage.",
    ],
    rubric: [
      "Chooses a consumption driver.",
      "Names platform ownership.",
      "Keeps a visible residual.",
      "Plans a review.",
    ],
  },
  {
    id: "tag-coverage",
    question:
      "Tag coverage is 95% but 30% of the bill is still unowned. What is the likely explanation?",
    difficulty: 2,
    hints: [
      "Tag coverage is usually measured on resources, not dollars.",
      "Shared spend cannot be tagged to one team.",
    ],
    answer:
      "Tag coverage is probably measured as a count of resources or as direct spend, while the bill includes a large shared platform or a few untagged high-cost resources. A 95% count can hide a small number of expensive untagged instances, and shared spend needs a separate rule regardless of tag coverage. I would sort the unowned line by dollars, split it into direct untagged and shared without a rule, and check whether the tag is activated for cost allocation.",
    followUps: [
      "How would you measure coverage by dollars?",
      "What if the untagged resource is a managed service?",
      "How would you close the shared gap?",
    ],
    redFlags: [
      "Assumes resource count equals spend.",
      "Ignores shared spend.",
      "Blames finance.",
    ],
    rubric: [
      "Distinguishes count from dollars.",
      "Identifies shared spend.",
      "Checks tag activation.",
      "Proposes a rule.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every direct workload has a mandatory team tag or a dedicated account, enforced at provisioning.",
      "Cost allocation tags are activated and appear in the billing report.",
      "Every shared platform has a written split rule, a driver, and an owner.",
      "The unowned residual is visible in showback with a named owner.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Sort the bill by untagged and shared spend in dollars, not by percentage alone.",
      "Check whether the tag is missing, misspelled, or inactive for cost allocation.",
      "Identify the platform owner for shared spend before proposing a split.",
      "Keep credits and refunds out of the ownership comparison.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Raise coverage on the largest unowned line first.",
      "Revisit the shared rule when the platform's usage mix changes.",
      "Publish the rule and the residual to the teams that pay it.",
      "Decide whether showback should become chargeback and who owns that decision.",
    ],
  },
];

const references = [
  {
    title: "AWS: Using AWS cost allocation tags",
    url: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-alloc-tags.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How tags become cost allocation tags and why activation is a separate step.",
  },
  {
    title: "AWS: Creating cost categories",
    url: "https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/cost-categories-creating.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rules that map accounts and tags to reporting groups, including shared-cost handling.",
  },
  {
    title: "AWS: Cost and Usage Reports",
    url: "https://docs.aws.amazon.com/cur/latest/userguide/what-is-cur.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Line-item billing data with resource IDs and tags for allocation analysis.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cost-allocation": {
      model: costAllocationModel,
      presets,
      instructions:
        "Start healthy, then apply The unowned bill. Compare the unowned dollars and share, then run Recovery. Open Fully allocated, still unclear to see why coverage is not accountability.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Dollar amounts, tag coverage, and shared splits are teaching values, not a bill or an AWS quote.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "capacity-unit-economics",
    "capacity-cost-per-request",
    "capacity-committed-use",
    "capacity-observability-cost",
    "capacity-rightsizing",
  ],
};
