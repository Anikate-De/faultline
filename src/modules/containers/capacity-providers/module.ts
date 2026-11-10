import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DESIRED = 12;

const FAMILY_NAMES = [
  { primary: "FARGATE", secondary: "FARGATE_SPOT", primaryCost: 1, secondaryCost: 0.35 },
  { primary: "on-demand ASG", secondary: "Spot ASG", primaryCost: 0.6, secondaryCost: 0.25 },
];

const params: ParamSpec[] = [
  {
    id: "providerFamily",
    label: "Provider family",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Strategy",
    help: "0 uses the Fargate pair FARGATE and FARGATE_SPOT. 1 uses an Auto Scaling group capacity provider for on-demand and one for Spot. A single strategy cannot mix the two families.",
    format: "count",
  },
  {
    id: "baseOnPrimary",
    label: "Base on primary",
    min: 0,
    max: 8,
    step: 1,
    value: 2,
    unit: " tasks",
    group: "Strategy",
    help: "Tasks guaranteed to the primary provider before weights are applied. Base is satisfied first and only one provider in a strategy can define it.",
    format: "count",
  },
  {
    id: "primaryWeight",
    label: "Primary weight",
    min: 0,
    max: 10,
    step: 1,
    value: 5,
    unit: "",
    group: "Strategy",
    help: "Relative share of the tasks left after base. The secondary provider gets the rest. Weight is a distribution rule, not a fallback rule.",
    format: "count",
  },
  {
    id: "secondaryCapacity",
    label: "Secondary capacity",
    min: 0,
    max: 20,
    step: 1,
    value: 8,
    unit: " tasks",
    group: "Capacity",
    help: "Tasks the secondary provider can actually place. For an Auto Scaling group this is bounded by group maximum and instance size; for Fargate Spot it is spare capacity.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Values {
  family: number;
  primaryName: string;
  secondaryName: string;
  base: number;
  weight: number;
  capacity: number;
  remaining: number;
  primaryExtra: number;
  primaryPlaced: number;
  secondaryWanted: number;
  secondaryPlaced: number;
  unplaced: number;
  secondaryUtil: number;
  costIndex: number;
}

function compute(p: Params): Values {
  const family = Math.round(clamp(num(p, "providerFamily", 0), 0, 1));
  const names = FAMILY_NAMES[family];
  const base = Math.min(DESIRED, Math.round(clamp(num(p, "baseOnPrimary", 2), 0, 8)));
  const weight = Math.round(clamp(num(p, "primaryWeight", 5), 0, 10));
  const capacity = Math.round(clamp(num(p, "secondaryCapacity", 8), 0, 20));
  const remaining = DESIRED - base;
  const primaryExtra = Math.round((remaining * weight) / 10);
  const primaryPlaced = base + primaryExtra;
  const secondaryWanted = remaining - primaryExtra;
  const secondaryPlaced = Math.min(secondaryWanted, capacity);
  const unplaced = DESIRED - primaryPlaced - secondaryPlaced;
  const secondaryUtil = capacity > 0 ? (secondaryPlaced / capacity) * 100 : 0;
  const cost = primaryPlaced * names.primaryCost + secondaryPlaced * names.secondaryCost;
  return {
    family,
    primaryName: names.primary,
    secondaryName: names.secondary,
    base,
    weight,
    capacity,
    remaining,
    primaryExtra,
    primaryPlaced,
    secondaryWanted,
    secondaryPlaced,
    unplaced,
    secondaryUtil,
    costIndex: (cost / (DESIRED * names.primaryCost)) * 100,
  };
}

function healthOf(values: Values): Health {
  if (values.unplaced >= 3) return "crit";
  if (values.unplaced > 0 || values.secondaryUtil >= 80) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const secondaryHealth: Health =
    values.secondaryWanted === 0 ? "ok" : values.secondaryUtil >= 95 ? "crit" : values.secondaryUtil >= 80 ? "warn" : "ok";
  const pendingHealth: Health = values.unplaced > 0 ? "crit" : "ok";
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.unplaced / DESIRED),
      sublabel: `desired ${DESIRED} · ${values.unplaced} unplaced`,
      detail: `The service uses a ${values.family === 0 ? "Fargate" : "Auto Scaling group"} strategy. It asks for ${DESIRED} tasks, and ${DESIRED - values.unplaced} have a provider. ${
        values.unplaced > 0
          ? "The scheduler cannot move a task outside the share defined by the strategy. Unplaced tasks wait for capacity or a strategy change."
          : "Every task has a provider."
      }`,
      meta: { unplaced: values.unplaced, family: values.family },
    },
    {
      id: "primary",
      label: values.primaryName,
      kind: "service",
      health: "ok",
      utilization: clamp(values.primaryPlaced / DESIRED),
      sublabel: `${values.primaryPlaced} tasks · base ${values.base}`,
      detail: `The primary provider receives the base first, then its weighted share of the remaining tasks. It is ${values.family === 0 ? "Fargate capacity" : "an Auto Scaling group capacity provider with instance types that must fit the task"}.`,
      meta: { tasks: values.primaryPlaced, base: values.base },
    },
    {
      id: "secondary",
      label: values.secondaryName,
      kind: "service",
      health: secondaryHealth,
      utilization: clamp(values.secondaryUtil / 100),
      sublabel:
        values.secondaryWanted === 0
          ? "no weighted share"
          : `${values.secondaryPlaced} of ${values.secondaryWanted} wanted · ${values.secondaryUtil.toFixed(0)}% of capacity`,
      detail:
        values.secondaryWanted === 0
          ? "The primary weight is 10, so the secondary provider has no share of the remaining tasks. It is not used by this service."
          : values.secondaryPlaced < values.secondaryWanted
            ? `The provider can place only ${values.secondaryPlaced} of the ${values.secondaryWanted} tasks assigned by weight. The shortfall becomes unplaced tasks, not a larger share on the primary provider.`
            : `The provider can place its full weighted share. Utilization is measured against the capacity available to this provider.`,
      meta: { placed: values.secondaryPlaced, wanted: values.secondaryWanted, capacity: values.capacity },
    },
    {
      id: "pending",
      label: "Tasks without a provider",
      kind: "external",
      health: pendingHealth,
      utilization: clamp(values.unplaced / DESIRED),
      sublabel: `${values.unplaced} tasks waiting`,
      detail:
        values.unplaced > 0
          ? "These tasks remain unplaced. The service keeps trying, and the service event stream reports placement failure. Raising the base or choosing a provider with capacity is the fix; the weights alone do not create capacity."
          : "Every task has a provider, so nothing is waiting on placement.",
      meta: { unplaced: values.unplaced },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("primary-service", "primary", "service", values.primaryPlaced / DESIRED, "ok", "places"),
      edge(
        "secondary-service",
        "secondary",
        "service",
        values.secondaryPlaced / DESIRED,
        secondaryHealth,
        "places",
      ),
      edge("pending-service", "pending", "service", values.unplaced / DESIRED, pendingHealth, "waiting"),
    ],
    metrics: [
      metric("unplaced-tasks", "Tasks without a provider", values.unplaced, " tasks", 1, 3, "count"),
      metric("secondary-utilization", "Secondary provider utilization", values.secondaryUtil, "%", 80, 95, "percent"),
      metric("placed-tasks", "Tasks with a provider", DESIRED - values.unplaced, " tasks", undefined, undefined, "count"),
      metric("primary-tasks", "Tasks on primary", values.primaryPlaced, " tasks", undefined, undefined, "count"),
      metric("secondary-tasks", "Tasks on secondary", values.secondaryPlaced, " tasks", undefined, undefined, "count"),
      metric("relative-cost", "Relative cost vs all primary", values.costIndex, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, family: values.family, unplaced: values.unplaced },
    summary: `${values.primaryName} and ${values.secondaryName}; ${values.primaryPlaced} primary, ${values.secondaryPlaced} secondary, ${values.unplaced} unplaced; secondary utilization ${values.secondaryUtil.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin((index + (seed % 8)) / 2.5) * Math.max(0.1, item.value * 0.015);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unplaced-tasks",
    metricId: "unplaced-tasks",
    warn: 1,
    crit: 3,
    title: "Tasks cannot be placed by their capacity provider",
    cause:
      "The strategy assigns tasks to a provider that cannot run them. Base and weight distribute demand, but neither creates capacity. A Fargate Spot shortage, an Auto Scaling group at maximum, or an instance type that cannot fit the task leaves tasks waiting.",
    fix:
      "Check which provider the strategy selected and whether it has capacity. For an Auto Scaling group, raise the group maximum or add a compatible instance type. For Fargate Spot, move more of the share to FARGATE or reduce the desired count. Change the strategy deliberately; do not expect a weight to act as an overflow rule.",
    checkFirst: [
      "Read the service event for a capacity provider placement failure.",
      "Compare the strategy's base and weights with the tasks actually running per provider.",
      "Check Auto Scaling group activity and maximum size, or Fargate Spot capacity for the Region.",
    ],
  },
  {
    id: "secondary-utilization",
    metricId: "secondary-utilization",
    warn: 80,
    crit: 95,
    title: "The secondary capacity provider is nearly exhausted",
    cause:
      "The weighted share is consuming almost all the capacity available to the secondary provider. The next deployment, scale-out, or interruption has nowhere to go because the strategy's share is fixed before capacity is considered.",
    fix:
      "Leave headroom on the secondary provider or move part of the weight to the primary. If the secondary is Spot, keep a primary base for the minimum healthy floor. Review the capacity provider's maximum and the task size together so one task does not exhaust the remaining space.",
    checkFirst: [
      "Compare running tasks with the provider's maximum capacity.",
      "Check recent scale-out and deployment events for placement failures.",
      "Check whether a task size change reduced the number of tasks that fit.",
    ],
  },
];

export const capacityProviderModel: SimModel = {
  id: "containers-capacity-providers",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(seed, compute(p));
    seedSeries(frame);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, compute(p));
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags, paramsKey: JSON.stringify(p) };
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, points]) => [key, [...points]]));
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The strategy uses ${values.primaryName} and ${values.secondaryName}. Base sends ${values.base} tasks to the primary before weight applies.`,
      `After base, the primary weight is ${values.weight} of 10, so the remaining ${values.remaining} tasks split ${values.primaryExtra} primary and ${values.secondaryWanted} secondary.`,
      values.unplaced > 0
        ? `${values.unplaced} tasks are unplaced because the secondary provider can run only ${values.secondaryPlaced} of the ${values.secondaryWanted} assigned to it. ECS does not convert that share into primary capacity automatically.`
        : "Every task has a provider. The mix still has a cost and interruption profile to review.",
      values.family === 0
        ? "FARGATE and FARGATE_SPOT are both Fargate providers. Fargate Spot is cheaper and interruptible, so the primary base is the availability floor."
        : "An Auto Scaling group provider depends on the group's instance types and maximum size. A task that does not fit any instance stays unplaced even when the group has free vCPU.",
      `The illustrative relative cost is ${values.costIndex.toFixed(0)}% of an all-primary fleet. Lower cost comes from a larger secondary share and a larger interruption surface.`,
      "A single capacity provider strategy cannot mix Auto Scaling group providers with Fargate providers. A cluster can contain both families, but each service strategy uses one family.",
    ];
  },
  legend: [
    { label: "Placed within capacity", tone: "ok" },
    { label: "Provider near capacity", tone: "warn" },
    { label: "Tasks unplaced", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Two Fargate providers, a small primary base, an even weight split, and enough Spot capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Spot near capacity",
    description: "An EC2 strategy sends 40% of the flexible tasks to Spot, and the Spot group is at 80% of its limit.",
    tone: "warn",
    params: defaults({ providerFamily: 1, baseOnPrimary: 2, primaryWeight: 6, secondaryCapacity: 5 }),
  },
  {
    id: "failure",
    label: "Spot capacity gone",
    description: "A Fargate strategy assigns seven tasks to FARGATE_SPOT, but only one can be placed.",
    tone: "crit",
    params: defaults({ providerFamily: 0, baseOnPrimary: 2, primaryWeight: 3, secondaryCapacity: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "An EC2 strategy keeps four tasks on on-demand, spreads the rest, and leaves room in the Spot group.",
    tone: "ok",
    params: defaults({ providerFamily: 1, baseOnPrimary: 4, primaryWeight: 6, secondaryCapacity: 8 }),
  },
  {
    id: "all-primary",
    label: "All primary",
    description: "The primary weight is 10, so every task lands on FARGATE and the secondary provider is unused.",
    tone: "ok",
    params: defaults({ providerFamily: 0, baseOnPrimary: 0, primaryWeight: 10, secondaryCapacity: 0 }),
  },
];

const experiment: Experiment = {
  id: "weight-is-not-fallback",
  title: "Predict the unplaced tasks",
  simId: "capacity-providers",
  question:
    "A service has base 2 on FARGATE and weight 5 on FARGATE and 5 on FARGATE_SPOT. Desired count is 12. FARGATE_SPOT has no capacity. How many tasks fail to place?",
  prediction: {
    options: [
      { id: "zero", label: "Zero, because the Fargate share absorbs the Spot tasks" },
      { id: "five", label: "Five, because half of the ten flexible tasks are assigned to Spot" },
      { id: "ten", label: "Ten, because all flexible tasks need Spot" },
      { id: "two", label: "Two, because only the base is guaranteed" },
    ],
    correctOptionId: "five",
    explanation:
      "Base places two tasks on FARGATE. The remaining ten split evenly by weight: five on FARGATE and five on FARGATE_SPOT. The Spot provider has no capacity, so those five tasks remain unplaced. Weight distributes demand; it does not overflow to the other provider when capacity is missing.",
  },
  setup: defaults({ providerFamily: 0, baseOnPrimary: 2, primaryWeight: 5, secondaryCapacity: 0 }),
  runFor: 20,
  observe: [
    "FARGATE runs seven tasks: the base of two plus five from its weighted share.",
    "FARGATE_SPOT is assigned five tasks and can place none.",
    "The service reports five unplaced tasks, not a larger Fargate fleet.",
    "Raising the primary weight to 10 moves all flexible tasks to FARGATE, at a higher relative cost.",
  ],
  explain:
    "A capacity provider strategy is a distribution plan, not a queue with fallback. Base is satisfied first, then weights divide the remaining tasks. Each provider then has to place its share. If it cannot, the service keeps retrying that share and reports a placement failure. The fix is to change the strategy or add capacity, not to wait for a different provider to absorb the work.",
  fix: defaults({ providerFamily: 0, baseOnPrimary: 2, primaryWeight: 10, secondaryCapacity: 0 }),
  debrief:
    "With the primary weight at 10, all twelve tasks run on FARGATE. Placement is healthy, but the illustrative cost rises to the all-primary baseline and the Spot discount is gone. The tradeoff is explicit: a larger Spot share lowers cost and increases the chance that a capacity shortage leaves tasks waiting. A base on the primary provider protects the minimum healthy floor; it does not make the secondary share elastic.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A capacity provider is the bridge between an Amazon Elastic Container Service (ECS) service and the compute that runs its tasks. Fargate has two managed providers, FARGATE and FARGATE_SPOT. On EC2, a capacity provider wraps an Auto Scaling group and adds managed scaling and instance protection. A cluster can contain both families, but a single service strategy uses one family at a time.",
  },
  {
    type: "p",
    text: "A capacity provider strategy is a list of providers with two numbers each. Base is the minimum number of tasks assigned to one provider before anything else. Weight is the relative share of the tasks left after base. Only one provider can define a base. A provider with weight 0 is not used. If every provider has weight 0, the service cannot place tasks at all.",
  },
  {
    type: "table",
    headers: ["Strategy field", "What it does", "What it does not do"],
    rows: [
      ["base", "Places a minimum number of tasks on one provider first", "Guarantee that the provider has capacity for those tasks"],
      ["weight", "Divides the remaining tasks by relative share", "Overflow a failed share onto another provider"],
      ["provider family", "Chooses Fargate or Auto Scaling group capacity", "Mix both families in one strategy"],
      ["capacity", "Bounds what a provider can actually run", "Grow because the service wants more tasks"],
    ],
  },
  {
    type: "p",
    text: "The common surprise is treating weight as a fallback. A service with weight 5 on FARGATE and 5 on FARGATE_SPOT does not run half on each and then shift the Spot half to Fargate when Spot is short. It assigns each share, tries to place it, and leaves the shortfall waiting. The service event stream reports the placement failure. Base is the tool that protects a minimum floor, and capacity is the tool that makes the share real.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The service scheduler reads the strategy, applies base and weight, and asks the chosen capacity provider for capacity. A Fargate provider supplies managed compute in the subnets the service names. An Auto Scaling group provider asks the group to scale, then places tasks on instances that fit the task CPU and memory. The group maximum, the instance types, and the task size all bound placement. Managed termination protection keeps instances that still run tasks from being scaled in prematurely.",
  },
  {
    type: "p",
    text: "Cost follows the same split. Fargate bills per task size and runtime. An Auto Scaling group bills the instances whether or not tasks fill them, so bin packing and instance size matter. Fargate Spot and EC2 Spot trade price for interruption. A lower-cost share is not free capacity; it is capacity with a different failure mode.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unplaced tasks: the count the strategy could not place, which is the direct symptom.",
      "Secondary provider utilization: how close the weighted share is to exhausting its capacity.",
      "Tasks per provider: the base-plus-weight split that actually ran.",
      "Relative cost: an illustrative comparison with an all-primary fleet, not an AWS price.",
      "Service, primary, secondary, and pending tasks as separate nodes, so a capacity shortage is not hidden inside an aggregate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Spot near capacity to see the secondary provider approach its limit. Apply Spot capacity gone to see the weighted share leave tasks unplaced, then Recovery. Apply All primary to compare guaranteed placement with cost. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "capacity-providers" },
  { type: "experiment", experimentId: "weight-is-not-fallback" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset kept the base on FARGATE, then assigned most of the flexible tasks to FARGATE_SPOT. Only one Spot task could be placed, so six tasks had no provider. The primary provider did not take them, because the strategy had already divided the demand. The service stayed at its desired count on paper while six tasks waited.",
  },
  {
    type: "p",
    text: "The recovery preset moved to an Auto Scaling group strategy with a larger on-demand base and enough Spot capacity. Every task had a provider, and the Spot group still had room. The cost was higher than the aggressive Spot split, which is the trade the strategy is making.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Service events with a capacity provider placement failure or a task that cannot be placed.",
      "`DescribeServices` showing desired count above running count and a deployment that is not progressing.",
      "Tasks stuck in PROVISIONING while the scheduler retries the same provider share.",
      "Auto Scaling group activity that stops at maximum size, or instances that are too small for the task.",
      "Fargate Spot capacity shortages in the Region, which the service cannot fix by changing weights alone.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the service event before changing the strategy. Confirm which provider the scheduler selected, then compare the provider's capacity with the assigned share. Do not raise the desired count or add weight until you know whether the missing capacity is in the group maximum, the instance type, or the managed provider.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the provider that cannot place the task and the share assigned to it.",
      "For an Auto Scaling group, check the maximum size, the instance types, and whether the task fits.",
      "For Fargate Spot, move part of the share to FARGATE or wait for capacity; do not assume overflow.",
      "Keep a base on the primary provider for the minimum healthy floor.",
      "Scale the service only after the provider can place the current desired count.",
      "Record the strategy, provider capacities, and cost change in the release notes.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger secondary share lowers cost and increases exposure to capacity shortages and interruptions.",
      "A larger base on the primary provider protects availability and reduces the benefit of cheaper capacity.",
      "Fargate removes instance management and limits tuning to task size and provider choice.",
      "Auto Scaling group providers allow instance-type and bin-packing control, with group and instance lifecycle work.",
      "A service-specific strategy is more precise than a cluster default, and it must be maintained for every service.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "base-vs-weight",
    question:
      "Explain base and weight in an ECS capacity provider strategy, and what happens when the weighted provider runs out of capacity.",
    difficulty: 2,
    hints: [
      "Base is satisfied before weights apply.",
      "Weight distributes demand; it does not create capacity.",
    ],
    answer:
      "Base places a minimum number of tasks on one provider before any weight is considered. Weight then divides the remaining tasks by relative share. If a provider cannot place its share, those tasks stay unplaced and the service reports a placement failure; ECS does not automatically move the share to another provider. I would keep a primary base for the minimum healthy floor, then check the provider's capacity and adjust the strategy or the capacity rather than assuming overflow.",
    followUps: [
      "Why can only one provider define a base?",
      "What happens if every provider has weight 0?",
      "How would you protect a minimum healthy count during a Spot shortage?",
    ],
    redFlags: [
      "Treats weight as a fallback rule.",
      "Assumes base guarantees capacity rather than intent.",
      "Raises desired count to fix a placement failure.",
    ],
    rubric: [
      "Defines base and weight correctly.",
      "Explains the unplaced share.",
      "Keeps a primary floor.",
      "Changes capacity or strategy deliberately.",
    ],
  },
  {
    id: "placement-failure",
    question:
      "A service moved from a launch type to a capacity provider strategy and tasks now fail to place. What do you check, in order?",
    difficulty: 3,
    hints: [
      "Start with the service event and the strategy.",
      "Then check capacity and task fit.",
    ],
    answer:
      "I would read the service event to see which provider and which task size failed. Then I would compare the strategy's base and weights with the running count per provider. For an Auto Scaling group, I would check the group maximum, the available instance types, and whether the task CPU and memory fit. For Fargate Spot, I would check capacity in the Region and whether the share can move to FARGATE. I would not change the desired count until the provider can place the current one.",
    followUps: [
      "Which service event names a capacity provider failure?",
      "How does managed termination protection affect scale-in?",
      "What changes if the task size was increased in the same release?",
    ],
    redFlags: [
      "Changes weights before reading the error.",
      "Raises the group maximum without checking instance fit.",
      "Mixes Fargate and Auto Scaling group providers in one strategy.",
    ],
    rubric: [
      "Reads the placement failure first.",
      "Checks strategy and per-provider counts.",
      "Checks group maximum and task fit.",
      "Avoids unrelated changes.",
    ],
  },
  {
    id: "choose-family",
    question:
      "You need a cheap service with a guaranteed minimum and burst capacity. Would you use a Fargate strategy, an Auto Scaling group strategy, or both?",
    difficulty: 3,
    hints: [
      "A cluster can host both families; a strategy cannot mix them.",
      "The minimum floor belongs on the more predictable provider.",
    ],
    answer:
      "I would choose one family per service strategy. If the team does not want to manage instances, I would use FARGATE for the base and FARGATE_SPOT for the flexible share. If the workload needs specific instance types, GPU, or tighter bin packing, I would use an Auto Scaling group capacity provider for on-demand and a second one for Spot, with a base on on-demand and weights for the rest. I would not try to mix Fargate and Auto Scaling group providers in one strategy, because ECS does not allow it. The choice is about operational ownership and capacity predictability, not only price.",
    followUps: [
      "What does a cluster default strategy change for new services?",
      "How would you compare the cost of the two designs without inventing prices?",
      "What happens to a service when the Spot provider is interrupted?",
    ],
    redFlags: [
      "Tries to mix both families in one strategy.",
      "Puts the entire minimum floor on Spot.",
      "Chooses on price alone without capacity ownership.",
    ],
    rubric: [
      "Keeps one family per strategy.",
      "Puts the floor on predictable capacity.",
      "Explains the operational tradeoff.",
      "Connects cost to interruption risk.",
    ],
  },
];

const checklist = [
  {
    title: "Before the service ships",
    items: [
      "The strategy uses one provider family and the intended base and weights.",
      "The primary base covers the minimum healthy count.",
      "The secondary provider has capacity for its weighted share plus headroom.",
      "The Auto Scaling group maximum and instance types can fit the task size.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Read the service event and identify the provider that failed to place.",
      "Compare desired, running, and per-provider task counts.",
      "Check group maximum, instance fit, and managed provider capacity.",
      "Decide whether to add capacity or change the strategy, not both at once.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Confirm every task has a provider and the deployment reaches a steady state.",
      "Review the new relative cost and interruption exposure.",
      "Update the runbook with the provider limits and the fallback decision.",
      "Remove any unused capacity provider from the strategy.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS capacity providers",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/cluster-capacity-providers.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Capacity provider associations, strategies, base and weight, and cluster defaults.",
  },
  {
    title: "Amazon ECS capacity providers for EC2 workloads",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/asg-capacity-providers.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Auto Scaling group capacity providers, managed scaling, and instance protection.",
  },
  {
    title: "Amazon ECS clusters for Fargate",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-capacity-providers.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "FARGATE and FARGATE_SPOT providers and the limits of a Fargate strategy.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "capacity-providers": {
      model: capacityProviderModel,
      presets,
      instructions:
        "Start Healthy, then apply Spot near capacity. Apply Spot capacity gone to see unplaced tasks, then Recovery. Apply All primary to compare guaranteed placement with cost. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Twelve desired tasks, the relative cost weights, and the capacity ranges are teaching values, not AWS quotas or prices.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-placement",
    "containers-fargate-spot",
    "containers-services",
    "capacity-spot-interruptions",
  ],
};
