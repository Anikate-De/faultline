import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AZS = ["AZ-a", "AZ-b", "AZ-c"];

const params: ParamSpec[] = [
  {
    id: "spreadMode",
    label: "Placement mode",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Placement",
    help: "0 fills the first zone with capacity, like a binpack strategy. 1 places each task in the zone with the fewest tasks, like a spread strategy. Both are bounded by capacity.",
    format: "count",
  },
  {
    id: "capacityPerAz",
    label: "Capacity per zone",
    min: 2,
    max: 10,
    step: 1,
    value: 6,
    unit: " tasks",
    group: "Capacity",
    help: "Tasks each availability zone can hold. On EC2 this is bounded by instances and task size; on Fargate it is bounded by subnets and available addresses.",
    format: "count",
  },
  {
    id: "desiredTasks",
    label: "Desired tasks",
    min: 6,
    max: 24,
    step: 1,
    value: 12,
    unit: " tasks",
    group: "Service",
    help: "The service's desired count. ECS keeps trying to reach it, but it cannot exceed the capacity left in the healthy zones.",
    format: "count",
  },
  {
    id: "failedAz",
    label: "Failed zone",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "0 means no zone is lost. 1, 2, and 3 remove AZ-a, AZ-b, or AZ-c. The remaining zones are used for rescheduling.",
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

function distribute(desired: number, capacity: number, mode: number, skip: number): number[] {
  const counts = [0, 0, 0];
  for (let index = 0; index < desired; index++) {
    const candidates = [0, 1, 2].filter((zone) => zone !== skip && counts[zone] < capacity);
    if (candidates.length === 0) break;
    const chosen =
      mode === 1
        ? candidates.reduce((best, zone) => (counts[zone] < counts[best] ? zone : best), candidates[0])
        : candidates[0];
    counts[chosen] += 1;
  }
  return counts;
}

interface Values {
  mode: number;
  capacity: number;
  desired: number;
  failedAz: number;
  failedIndex: number;
  before: number[];
  after: number[];
  running: number;
  shortfall: number;
  shortfallPct: number;
  largest: number;
  largestShare: number;
  busiestUtil: number;
}

function compute(p: Params): Values {
  const mode = Math.round(clamp(num(p, "spreadMode", 1), 0, 1));
  const capacity = Math.round(clamp(num(p, "capacityPerAz", 6), 2, 10));
  const desired = Math.round(clamp(num(p, "desiredTasks", 12), 6, 24));
  const failedAz = Math.round(clamp(num(p, "failedAz", 0), 0, 3));
  const failedIndex = failedAz === 0 ? -1 : failedAz - 1;
  const before = distribute(desired, capacity, mode, -1);
  const after = distribute(desired, capacity, mode, failedIndex);
  const running = after.reduce((sum, count) => sum + count, 0);
  const shortfall = desired - running;
  const largest = Math.max(...after);
  return {
    mode,
    capacity,
    desired,
    failedAz,
    failedIndex,
    before,
    after,
    running,
    shortfall,
    shortfallPct: (shortfall / desired) * 100,
    largest,
    largestShare: running > 0 ? (largest / running) * 100 : 0,
    busiestUtil: capacity > 0 ? (largest / capacity) * 100 : 0,
  };
}

function healthOf(values: Values): Health {
  if (values.shortfallPct >= 20 || values.running === 0) return "crit";
  if (values.shortfall > 0 || values.largestShare >= 50 || values.failedAz > 0) return "warn";
  return "ok";
}

function zoneHealth(values: Values, zone: number): Health {
  if (zone === values.failedIndex) return "down";
  const util = values.capacity > 0 ? values.after[zone] / values.capacity : 0;
  if (util >= 0.85) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const nodes: SimNode[] = [
    {
      id: "service",
      label: "checkout-service",
      kind: "service",
      health,
      utilization: clamp(values.running / values.desired),
      sublabel: `desired ${values.desired} · running ${values.running}`,
      detail: `The service wants ${values.desired} tasks. Placement can use three zones with ${values.capacity} task slots each. ${
        values.failedAz > 0
          ? `${AZS[values.failedIndex]} is unavailable, and the scheduler has to fit the service into the remaining zones.`
          : "No zone is currently failed."
      }`,
      meta: { desired: values.desired, running: values.running },
    },
    ...AZS.map((label, zone): SimNode => ({
      id: `az-${zone}`,
      label,
      kind: "service",
      role: "zone",
      health: zoneHealth(values, zone),
      utilization: clamp(values.after[zone] / values.capacity),
      sublabel:
        zone === values.failedIndex
          ? "zone unavailable"
          : `${values.after[zone]} of ${values.capacity} slots · ${((values.after[zone] / values.capacity) * 100).toFixed(0)}%`,
      detail:
        zone === values.failedIndex
          ? `${label} is unavailable. Tasks that were placed there are lost, and rescheduling is bounded by the capacity in the other two zones.`
          : `${label} runs ${values.after[zone]} tasks after rescheduling. ${
              values.after[zone] >= values.capacity
                ? "The zone is at its capacity, so it cannot absorb more work."
                : `It has room for ${values.capacity - values.after[zone]} more tasks.`
            }`,
      meta: { tasks: values.after[zone], capacity: values.capacity, failed: zone === values.failedIndex ? 1 : 0 },
    })),
  ];

  return {
    t: 0,
    nodes,
    edges: AZS.map((_, zone) =>
      edge(`az-${zone}-service`, `az-${zone}`, "service", values.after[zone] / values.desired, zoneHealth(values, zone), "serves"),
    ),
    metrics: [
      metric("shortfall", "Desired tasks missing after zone loss", values.shortfallPct, "%", 1, 20, "percent"),
      metric("largest-az-share", "Largest zone share of running tasks", values.largestShare, "%", 50, 70, "percent"),
      metric("running-tasks", "Running tasks", values.running, " tasks", undefined, undefined, "count"),
      metric("desired-tasks", "Desired tasks", values.desired, " tasks", undefined, undefined, "count"),
      metric("capacity-per-az", "Capacity per zone", values.capacity, " tasks", undefined, undefined, "count"),
      metric("failed-zones", "Failed zones", values.failedAz === 0 ? 0 : 1, "", undefined, undefined, "count"),
      metric("available-room", "Room in available zones", (values.failedAz === 0 ? 3 : 2) * values.capacity - values.running, " tasks", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, mode: values.mode, failedAz: values.failedAz },
    summary: `${values.mode === 1 ? "Spread" : "Binpack"} placement across three zones; ${values.running} of ${values.desired} tasks running; largest zone share ${values.largestShare.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 18 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.3) * Math.max(0.1, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "shortfall",
    metricId: "shortfall",
    warn: 1,
    crit: 20,
    title: "The service cannot reach its desired count after a zone loss",
    cause:
      "The surviving zones do not have enough capacity for the tasks that were running in the failed zone. ECS can reschedule, but it cannot place tasks where no capacity exists. A layout that was balanced before the failure can still be short after it.",
    fix:
      "Add capacity to the surviving zones, reduce the desired count, or spread the service across more zones with N+1 headroom. Do not only rebalance the pre-failure placement; check the capacity that remains after the largest zone is removed.",
    checkFirst: [
      "Compare the desired count with the total capacity of the surviving zones.",
      "Check whether the failed zone held more than its share of tasks.",
      "Check subnet free addresses, instance capacity, and service placement constraints.",
    ],
  },
  {
    id: "largest-az-share",
    metricId: "largest-az-share",
    warn: 50,
    crit: 70,
    title: "One zone carries most of the service",
    cause:
      "A binpack strategy, a placement constraint, or uneven capacity concentrated tasks in one zone. The service may be healthy now, but the next zone failure removes a disproportionate share of its capacity.",
    fix:
      "Use a spread placement strategy across availability zones and make capacity even enough for it to work. Check constraints that pin tasks to one zone, and verify that each subnet has enough addresses for its share. Rebalance deliberately before the failure, not during it.",
    checkFirst: [
      "Compare per-zone task counts with per-zone capacity.",
      "Check the service placement strategy and any attribute constraints.",
      "Check whether one subnet or instance group is smaller than the others.",
    ],
  },
];

export const multiAzModel: SimModel = {
  id: "containers-multi-az-scheduling",
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
      `Placement uses ${values.mode === 1 ? "spread" : "binpack"} across three zones with ${values.capacity} task slots each.`,
      values.failedAz > 0
        ? `${AZS[values.failedIndex]} is lost. The other zones can run ${values.running} of ${values.desired} tasks, a shortfall of ${values.shortfallPct.toFixed(0)}%.`
        : `No zone is failed. The largest zone holds ${values.largestShare.toFixed(0)}% of the running tasks.`,
      values.largestShare >= 50
        ? "A single zone carrying half or more of the service is a latent capacity failure. The current health does not measure what happens when that zone disappears."
        : "The layout is reasonably even, but even a balanced layout needs capacity headroom after one zone is removed.",
      values.mode === 1
        ? "Spread is best effort. It cannot place a task in a zone that has no capacity, so uneven capacity still produces an uneven layout."
        : "Binpack fills zones to use capacity efficiently, which is exactly what concentrates the blast radius when one zone fails.",
      "N+1 means the surviving zones can carry the peak desired count after the largest zone is lost. Count capacity after the failure, not before it.",
    ];
  },
  legend: [
    { label: "Spread with headroom", tone: "ok" },
    { label: "Concentrated or degraded", tone: "warn" },
    { label: "Desired count unreachable", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Spread placement puts 12 tasks evenly across three zones with six slots each.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Concentrated under load",
    description: "Binpack fills AZ-a and part of AZ-b with nine tasks, so two thirds of the service sit in one zone.",
    tone: "warn",
    params: defaults({ spreadMode: 0, capacityPerAz: 6, desiredTasks: 9, failedAz: 0 }),
  },
  {
    id: "failure",
    label: "Binpack plus zone loss",
    description: "Binpack fills AZ-a and AZ-b, then AZ-a fails. Only 12 of 18 tasks fit in the survivors.",
    tone: "crit",
    params: defaults({ spreadMode: 0, capacityPerAz: 6, desiredTasks: 18, failedAz: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Spread placement and balanced capacity run 12 tasks with room in every zone.",
    tone: "ok",
    params: defaults({ spreadMode: 1, capacityPerAz: 6, desiredTasks: 12, failedAz: 0 }),
  },
  {
    id: "az-loss",
    label: "AZ loss with headroom",
    description: "Spread placement loses AZ-b but the two survivors still run all 12 tasks.",
    tone: "warn",
    params: defaults({ spreadMode: 1, capacityPerAz: 6, desiredTasks: 12, failedAz: 2 }),
  },
];

const experiment: Experiment = {
  id: "surviving-capacity",
  title: "Predict the surviving count",
  simId: "multi-az",
  question:
    "A service uses binpack placement, has 15 desired tasks, and each availability zone can hold 6 tasks. AZ-a fails. After ECS reschedules, how many tasks can run?",
  prediction: {
    options: [
      { id: "fifteen", label: "15, because the service keeps its desired count" },
      { id: "twelve", label: "12, because the two surviving zones can hold 6 each" },
      { id: "nine", label: "9, because one third of the tasks are in each zone" },
      { id: "six", label: "6, because only the first surviving zone is used" },
    ],
    correctOptionId: "twelve",
    explanation:
      "The pre-failure layout filled AZ-a and AZ-b with six tasks each and placed three in AZ-c. After AZ-a fails, ECS can reschedule into the survivors, but AZ-b and AZ-c can hold only six each. The service runs 12 of 15 tasks; the missing three are a capacity shortfall, not a scheduler delay.",
  },
  setup: defaults({ spreadMode: 0, capacityPerAz: 6, desiredTasks: 15, failedAz: 1 }),
  runFor: 20,
  observe: [
    "The largest-zone share warns before the shortfall does, because the layout is concentrated.",
    "AZ-a is unavailable and its tasks cannot be served.",
    "AZ-b and AZ-c both reach their six-task capacity, so three tasks have nowhere to go.",
    "Raising capacity per zone or reducing the desired count closes the gap; changing only the strategy does not add slots.",
  ],
  explain:
    "ECS can reschedule tasks after a zone failure, but placement is bounded by the capacity that remains. A binpack layout concentrates tasks in the early zones, so the failed zone can hold more than one third of the service. Spread reduces that concentration, but it does not create headroom. N+1 requires enough capacity in the surviving zones to carry the peak desired count after the largest zone is removed.",
  fix: defaults({ spreadMode: 1, capacityPerAz: 8, desiredTasks: 15, failedAz: 1 }),
  debrief:
    "With spread placement and eight slots per zone, the service places five tasks in each zone. When AZ-a fails, the survivors have sixteen slots and can absorb all fifteen tasks. The tradeoff is that each zone runs below its capacity in normal operation. That idle headroom is the price of surviving a zone loss without reducing the desired count.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Multi-AZ scheduling is the placement of an Amazon Elastic Container Service (ECS) service across more than one availability zone (AZ). An AZ is an isolated group of data centers inside a Region. For a service to survive an AZ loss, its tasks must be distributed across zones and the surviving zones must have enough capacity for the remaining work.",
  },
  {
    type: "p",
    text: "ECS treats availability zone as a placement attribute. A spread strategy tries to place tasks evenly across the zones, while a binpack strategy fills the zones with the most available resources first. On EC2, the scheduler also has to find a container instance with enough CPU, memory, and ports. On Fargate, it chooses a subnet in each zone, so subnet address space and service quotas matter. In both cases, placement is best effort: a zone without capacity does not receive tasks just because the strategy prefers it.",
  },
  {
    type: "table",
    headers: ["Layout", "Normal operation", "After one zone fails", "Main risk"],
    rows: [
      ["Spread, even capacity", "Tasks balanced across zones", "Survivors absorb the load if they have headroom", "Idle capacity in every zone"],
      ["Spread, uneven capacity", "Balanced only where capacity exists", "Smaller zones cannot take their share", "A balanced look hides a capacity gap"],
      ["Binpack", "Zones filled in order", "The fullest zone takes the largest loss", "Blast radius concentrated in one zone"],
      ["Single zone", "Simple placement", "The service loses everything in that zone", "No zonal redundancy at all"],
    ],
  },
  {
    type: "p",
    text: "The capacity math is separate from the placement preference. If each of three zones can run six tasks and the service wants eighteen, the pre-failure layout is full everywhere. Lose one zone and the service has twelve slots, even if the survivors are perfectly balanced. N+1 means the two survivors can carry the peak desired count after the largest zone is removed, not that the normal layout looks even.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The service scheduler reads the desired count, the placement strategy, and the constraints, then asks the capacity provider for capacity. On EC2, the capacity provider scales an Auto Scaling group, and the scheduler places tasks on instances that fit. The group should have instances in each zone, and the instance types and task sizes must leave room for the surviving zones to absorb the displaced tasks. On Fargate, the service configuration lists subnets; if one subnet is small or exhausted, that zone effectively has less capacity.",
  },
  {
    type: "p",
    text: "A zone failure is not a single node failure. Every task in the failed zone is lost at once, and the replacement tasks compete for the remaining capacity. ECS keeps trying to reach the desired count, but it cannot exceed the slots that remain. Capacity reservations, placement constraints, and a maximum task count per instance can all prevent the survivors from taking the displaced work.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Shortfall: desired tasks minus the tasks that can run in the surviving zones.",
      "Largest zone share: how concentrated the service is before or after a failure.",
      "Per-zone task counts and utilization, so a single hot zone is visible.",
      "Recoverable room: how many more tasks the survivors could take.",
      "A service node plus three zone nodes, so the failure is tied to a zone rather than an aggregate count.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Concentrated under load to see the concentration warning. Apply Binpack plus zone loss to see capacity run out, then Recovery. Apply AZ loss with headroom to see a spread service survive. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "multi-az" },
  { type: "experiment", experimentId: "surviving-capacity" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset filled AZ-a and AZ-b before placing anything in AZ-c. When AZ-a failed, the survivors were already near their limits. ECS rescheduled what it could, but the total number of slots in the two healthy zones was twelve, so three of the eighteen desired tasks had nowhere to go. The service stayed at its desired count in the control plane while the data plane ran short.",
  },
  {
    type: "p",
    text: "The recovery preset spread the tasks and added capacity per zone. The normal layout used less than full zones, which looked wasteful until one zone was removed. After the failure, the survivors still had enough slots for every task. The headroom was the design, not an accident.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`DescribeServices` showing desired count above running count after a zone event.",
      "Service events that report placement failures or an inability to satisfy constraints.",
      "Per-zone task counts from the service or from CloudWatch metrics grouped by zone.",
      "Auto Scaling group activity in the surviving zones, often capped at maximum size.",
      "Subnet address exhaustion or instance capacity limits that prevent rescheduling.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the desired count with the total capacity of the zones that are still healthy. Then check whether the failed zone held more than its share. Do not restart tasks or raise the desired count until you know whether the survivors have slots.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the failed zone and the number of tasks that were placed there.",
      "Calculate the capacity left in the surviving zones, including instance and subnet limits.",
      "Add capacity or reduce the desired count to fit the survivors for the immediate incident.",
      "Switch to a spread strategy across zones and even out per-zone capacity for the next failure.",
      "Verify that the peak desired count fits in the survivors with the largest zone removed.",
      "Record the capacity math and the zone layout in the service runbook.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Spread placement reduces blast radius and leaves capacity idle in normal operation.",
      "Binpack uses capacity efficiently and concentrates the loss when a zone fails.",
      "A larger desired count improves throughput and raises the headroom needed in the survivors.",
      "N+2 headroom covers two zone failures and costs more than N+1 for the same peak.",
      "Fargate removes instance management but still depends on subnet capacity and service quotas.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "balanced-not-enough",
    question:
      "A service is perfectly balanced across three AZs and each zone is at 80% utilization. Is it ready for an AZ failure?",
    difficulty: 2,
    hints: [
      "Calculate the load on the survivors, not the pre-failure balance.",
      "Eighty percent of three zones is more than the capacity of two.",
    ],
    answer:
      "Not necessarily. If each zone is at 80% and one zone is lost, the survivors have to absorb the failed zone's tasks. Their combined headroom is 40% of one zone, which is less than the 80% that needs to move. The service would exceed capacity unless it can scale or shed load. I would calculate the post-failure utilization and keep enough headroom for the peak desired count, not judge the layout only by how even it looks.",
    followUps: [
      "What headroom would you need at peak for N+1?",
      "How does autoscaling change the answer?",
      "What if the failed zone was the smallest?",
    ],
    redFlags: [
      "Assumes balance equals resilience.",
      "Ignores the capacity of the survivors.",
      "Uses average utilization instead of peak.",
    ],
    rubric: [
      "Computes post-failure load.",
      "Distinguishes balance from headroom.",
      "Uses peak, not average.",
      "Considers scaling and load shedding.",
    ],
  },
  {
    id: "spread-vs-binpack",
    question:
      "When would you choose binpack placement over spread placement for an ECS service?",
    difficulty: 3,
    hints: [
      "Binpack is about using capacity efficiently.",
      "Spread is about limiting the blast radius.",
    ],
    answer:
      "I would choose binpack when capacity is scarce or expensive and the workload can tolerate a larger blast radius, such as a batch or interruption-tolerant service. It reduces the number of instances needed and can make scale-in easier. I would choose spread for a latency-sensitive or stateful service where one zone failure must not remove a large share of capacity. In practice I would still verify the post-failure capacity, because binpack can fill one zone completely even when other zones have room.",
    followUps: [
      "How does binpack interact with instance types?",
      "What does spread do when zones have unequal capacity?",
      "How would you measure whether the strategy is working?",
    ],
    redFlags: [
      "Treats spread as a guarantee.",
      "Chooses binpack without considering blast radius.",
      "Ignores per-zone capacity.",
    ],
    rubric: [
      "States the efficiency tradeoff.",
      "States the blast-radius tradeoff.",
      "Matches strategy to workload.",
      "Verifies capacity after failure.",
    ],
  },
  {
    id: "n-plus-one",
    question:
      "How would you design N+1 capacity for a service that peaks at 30 tasks across three AZs?",
    difficulty: 3,
    hints: [
      "The survivors must carry 30 tasks after the largest zone is lost.",
      "Per-zone capacity must be at least 15 if the load is even.",
    ],
    answer:
      "If the peak is 30 tasks and the service is spread evenly, each zone normally runs 10. After one zone is lost, the survivors must carry 30, so each needs at least 15 slots. That means each zone is provisioned for 15, not 10, and the normal utilization is about 67%. I would also check the instance type, subnet addresses, and service quotas, because the slot count is only real if the capacity provider can place the tasks. Then I would test the failure in a game day rather than trusting the arithmetic alone.",
    followUps: [
      "How does an uneven task size change the slot math?",
      "What is the cost tradeoff between N+1 and N+2?",
      "How would autoscaling affect the required headroom?",
    ],
    redFlags: [
      "Provisions only for the normal per-zone share.",
      "Ignores instance and subnet limits.",
      "Never tests the failure.",
    ],
    rubric: [
      "Computes survivor capacity.",
      "Provisions every zone for the post-failure share.",
      "Checks provider limits.",
      "Tests the failure.",
    ],
  },
];

const checklist = [
  {
    title: "Before the service ships",
    items: [
      "The service uses a spread placement strategy across availability zones.",
      "Each zone has enough capacity for its post-failure share, not only its normal share.",
      "Subnets have enough free addresses for the peak task count.",
      "The Auto Scaling group maximum or Fargate quota can cover the displaced tasks.",
    ],
  },
  {
    title: "During a zone event",
    items: [
      "Compare desired count with the capacity of the surviving zones.",
      "Check whether the failed zone held a disproportionate share of tasks.",
      "Look for placement constraints or instance limits blocking rescheduling.",
      "Decide whether to add capacity, reduce the desired count, or shed load.",
    ],
  },
  {
    title: "After the event",
    items: [
      "Verify that the service returned to its desired count in the survivors.",
      "Recalculate the N+1 headroom with the new peak.",
      "Remove constraints that pinned tasks to the failed zone.",
      "Run a game day that removes the busiest zone, not only an idle one.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS task placement",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Placement strategies, constraints, and availability zone as a task attribute.",
  },
  {
    title: "Amazon ECS task networking for Fargate",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-task-networking.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Subnet selection, task IP addresses, and the zonal capacity that Fargate tasks depend on.",
  },
  {
    title: "Amazon ECS capacity providers for EC2 workloads",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/asg-capacity-providers.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Auto Scaling group capacity, instance types, and managed scaling for EC2 tasks.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "multi-az": {
      model: multiAzModel,
      presets,
      instructions:
        "Start Healthy, then apply Concentrated under load. Apply Binpack plus zone loss to see the shortfall, then Recovery. Apply AZ loss with headroom to see a spread service survive. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Three zones, equal per-zone slot counts, and the 6–24 task range are teaching values, not AWS quotas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-placement",
    "containers-capacity-providers",
    "foundations-capacity-headroom",
    "traffic-zonal-isolation",
  ],
};
