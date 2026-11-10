import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AZ_COUNT = 3;
const INSTANCE_CPU = 6_144;
const TASK_CPU = 600;

const params: ParamSpec[] = [
  {
    id: "taskCount",
    label: "Tasks to place",
    min: 1,
    max: 30,
    step: 1,
    value: 10,
    unit: " tasks",
    group: "Demand",
    help: "Tasks the service scheduler must place on the container instances.",
    format: "count",
  },
  {
    id: "instanceCount",
    label: "Container instances",
    min: 1,
    max: 7,
    step: 1,
    value: 6,
    unit: " instances",
    group: "Cluster",
    help: "Registered EC2 container instances, spread across three Availability Zones by index.",
    format: "count",
  },
  {
    id: "strategy",
    label: "Placement strategy",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Placement",
    help: "0 is spread across Availability Zones, 1 is spread across instances, 2 is binpack by CPU. Strategies are best effort.",
    format: "count",
  },
  {
    id: "constraint",
    label: "Placement constraint",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Placement",
    help: "0 is none, 1 is distinctInstance (one task per instance), 2 restricts placement to Availability Zone A. Constraints are binding.",
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

interface Instance {
  index: number;
  az: number;
  tasks: number;
  cpu: number;
}

interface Computed {
  taskCount: number;
  instanceCount: number;
  strategy: number;
  constraint: number;
  instances: Instance[];
  placedTasks: number;
  unplaced: number;
  hotUtil: number;
  hotTasks: number;
  clusterAverage: number;
  azConcentration: number;
  p99: number;
  errorRate: number;
}

function place(taskCount: number, instanceCount: number, strategy: number, constraint: number): Instance[] {
  const instances: Instance[] = Array.from({ length: instanceCount }, (_, index) => ({
    index,
    az: index % AZ_COUNT,
    tasks: 0,
    cpu: 0,
  }));
  const azTotals = Array.from({ length: AZ_COUNT }, () => 0);

  for (let task = 0; task < taskCount; task++) {
    const candidates = instances.filter((instance) => {
      if (instance.cpu + TASK_CPU > INSTANCE_CPU) return false;
      if (constraint === 1 && instance.tasks >= 1) return false;
      if (constraint === 2 && instance.az !== 0) return false;
      return true;
    });
    if (!candidates.length) break;

    let chosen: Instance;
    if (strategy === 2) {
      chosen = candidates.reduce((best, instance) =>
        INSTANCE_CPU - instance.cpu < INSTANCE_CPU - best.cpu ? instance : best,
      );
    } else if (strategy === 1) {
      chosen = candidates.reduce((best, instance) => (instance.tasks < best.tasks ? instance : best));
    } else {
      const minAz = Math.min(...candidates.map((instance) => azTotals[instance.az]));
      const azCandidates = candidates.filter((instance) => azTotals[instance.az] === minAz);
      chosen = azCandidates.reduce((best, instance) => (instance.tasks < best.tasks ? instance : best));
    }

    chosen.tasks += 1;
    chosen.cpu += TASK_CPU;
    azTotals[chosen.az] += 1;
  }

  return instances;
}

function latencyFor(hotUtil: number): number {
  if (hotUtil <= 0) return 40;
  if (hotUtil >= 100) return 3_000;
  const ratio = hotUtil / (100 - hotUtil);
  return Math.min(3_000, 40 + 55 * ratio ** 1.5);
}

function compute(p: Params): Computed {
  const taskCount = Math.round(clamp(num(p, "taskCount", 10), 1, 30));
  const instanceCount = Math.round(clamp(num(p, "instanceCount", 6), 1, 7));
  const strategy = Math.round(clamp(num(p, "strategy", 0), 0, 2));
  const constraint = Math.round(clamp(num(p, "constraint", 0), 0, 2));
  const instances = place(taskCount, instanceCount, strategy, constraint);
  const placedTasks = instances.reduce((sum, instance) => sum + instance.tasks, 0);
  const totalCpu = instances.reduce((sum, instance) => sum + instance.cpu, 0);
  const hot = instances.reduce(
    (best, instance) => (instance.cpu > best.cpu ? instance : best),
    instances[0],
  );
  const azTotals = Array.from({ length: AZ_COUNT }, (_, az) =>
    instances.filter((instance) => instance.az === az).reduce((sum, instance) => sum + instance.tasks, 0),
  );
  const hotUtil = (hot.cpu / INSTANCE_CPU) * 100;
  return {
    taskCount,
    instanceCount,
    strategy,
    constraint,
    instances,
    placedTasks,
    unplaced: taskCount - placedTasks,
    hotUtil,
    hotTasks: hot.tasks,
    clusterAverage: (totalCpu / (instanceCount * INSTANCE_CPU)) * 100,
    azConcentration: placedTasks > 0 ? (Math.max(...azTotals) / placedTasks) * 100 : 0,
    p99: latencyFor(hotUtil),
    errorRate: Math.min(10, Math.max(0, (hotUtil - 90) * 0.6)),
  };
}

function utilizationHealth(util: number): Health {
  if (util >= 85) return "crit";
  if (util >= 70) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number, values: Computed): SimFrame {
  const worstInstance = values.instances.reduce(
    (worst, instance) => (instance.cpu > worst.cpu ? instance : worst),
    values.instances[0],
  );
  const worstHealth = utilizationHealth((worstInstance.cpu / INSTANCE_CPU) * 100);
  const clusterHealth: Health =
    values.unplaced >= 3 || worstHealth === "crit"
      ? "crit"
      : values.unplaced > 0 || worstHealth === "warn" || (values.constraint === 2 && values.azConcentration >= 100)
        ? "warn"
        : "ok";
  const nodes: SimNode[] = [
    {
      id: "cluster",
      label: "checkout cluster",
      kind: "service",
      health: clusterHealth,
      utilization: clamp(values.clusterAverage / 100),
      sublabel: `${values.placedTasks} placed · ${values.unplaced} unplaced`,
      detail: `The cluster average is ${values.clusterAverage.toFixed(1)}% CPU, but the hottest instance is at ${values.hotUtil.toFixed(1)}%. ${values.azConcentration.toFixed(0)}% of tasks are in one Availability Zone.`,
      meta: { placed: values.placedTasks, unplaced: values.unplaced, hotTasks: values.hotTasks },
    },
    ...values.instances.map((instance) => {
      const util = (instance.cpu / INSTANCE_CPU) * 100;
      return {
        id: `instance-${instance.index}`,
        label: `ctr-${String.fromCharCode(97 + instance.az)}${instance.index}`,
        kind: "service" as const,
        role: "instance" as const,
        health: utilizationHealth(util),
        utilization: clamp(util / 100),
        capacity: INSTANCE_CPU,
        sublabel: `AZ ${String.fromCharCode(65 + instance.az)} · ${instance.tasks} tasks`,
        detail: `This instance holds ${instance.tasks} tasks at ${util.toFixed(1)}% CPU. ${instance.tasks > 0 ? "Placement is per task; the instance has no idea whether its neighbors are idle." : "No tasks were placed here."}`,
        meta: { az: String.fromCharCode(65 + instance.az), tasks: instance.tasks, cpu: util },
      };
    }),
  ];

  return {
    t: 0,
    nodes,
    edges: values.instances.map((instance, index) =>
      edge(
        `cluster-instance-${instance.index}`,
        "cluster",
        `instance-${instance.index}`,
        values.taskCount > 0 ? instance.tasks / values.taskCount : 0,
        utilizationHealth((instance.cpu / INSTANCE_CPU) * 100),
        index === 0 ? "place" : undefined,
      ),
    ),
    metrics: [
      metric("hot-instance-util", "Hottest instance CPU", values.hotUtil, "%", 70, 85, "percent"),
      metric("p99", "Hottest instance p99", values.p99, "ms", 300, 800, "ms"),
      metric("unplaced", "Tasks that cannot be placed", values.unplaced, "", 1, 3, "count"),
      metric("az-concentration", "Tasks in the busiest AZ", values.azConcentration, "%", undefined, undefined, "percent"),
      metric("cluster-average", "Cluster average CPU", values.clusterAverage, "%", undefined, undefined, "percent"),
      metric("placed-tasks", "Tasks placed", values.placedTasks, "", undefined, undefined, "count"),
      metric("hot-instance-tasks", "Tasks on the hottest instance", values.hotTasks, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.placedTasks} of ${values.taskCount} tasks placed; hottest instance ${values.hotUtil.toFixed(0)}%, cluster average ${values.clusterAverage.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 9)) / 2.6) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, Math.min(item.value, item.value + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-instance-util",
    metricId: "hot-instance-util",
    warn: 70,
    crit: 85,
    title: "One container instance is carrying the service",
    cause:
      "The binpack strategy fills the instance with the least remaining CPU that still fits the task. That minimizes the number of instances in use, but it can put every task on one instance while the cluster average stays low.",
    fix:
      "Switch the service to a spread strategy across Availability Zones, or add capacity and rebalance. Confirm the task reservation and the instance CPU so the scheduler has a real choice.",
    checkFirst: [
      "Compare per-instance CPU with the cluster average.",
      "Check the service placement strategy and whether a constraint pins tasks to a subset of instances.",
      "Check the task CPU reservation and the remaining resources reported by the container instance.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "The hot instance is queueing requests",
    cause:
      "A single instance at high CPU has little room for bursts. Requests queue behind the CPU, so tail latency rises even though the cluster has idle capacity on other instances.",
    fix:
      "Spread the tasks before tuning timeouts. Adding instances does not help if placement keeps choosing the same one.",
    checkFirst: [
      "Check p99 per task and per instance, not the cluster aggregate.",
      "Check CPU throttling and run-queue pressure on the hot instance.",
      "Check whether the load balancer is sending traffic evenly across healthy tasks.",
    ],
  },
  {
    id: "unplaced",
    metricId: "unplaced",
    warn: 1,
    crit: 3,
    title: "A binding constraint is blocking placement",
    cause:
      "Strategies are best effort, but constraints are binding. If every task must use a distinct instance, or every task must stay in one Availability Zone, the scheduler can run out of valid candidates even when the cluster has spare CPU.",
    fix:
      "Count the valid candidates implied by the constraint and compare that with the desired task count. Add instances in the required scope, relax the constraint, or reduce the task count.",
    checkFirst: [
      "Read the service event for the unmet placement requirement.",
      "Check distinctInstance and memberOf constraints on the service and task definition.",
      "Check how many instances match the constraint and how much CPU each has left.",
    ],
  },
];

export const placementModel: SimModel = {
  id: "containers-placement",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const frame = buildFrame(p, seed, compute(p));
    seedSeries(frame);
    return frame;
  },
  step: (frame, p) => {
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(p, seed, compute(p));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, values]) => [key, [...values]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `${values.placedTasks} of ${values.taskCount} tasks are placed. ${values.unplaced > 0 ? `${values.unplaced} remain pending because no candidate satisfies the constraint and the task size.` : "No task is blocked by placement."}`,
      `The hottest instance is at ${values.hotUtil.toFixed(0)}% CPU; the cluster average is ${values.clusterAverage.toFixed(0)}%. The average is not a capacity signal when placement is uneven.`,
      `${values.azConcentration.toFixed(0)}% of placed tasks are in one Availability Zone. Binpack and a narrow constraint both concentrate risk.`,
      "Strategies are best effort. ECS still places a task when the optimal candidate is unavailable. Constraints are binding and leave a task pending when no candidate matches.",
      "Fargate does not support placement strategies or constraints. It makes a best-effort spread across Availability Zones, but you cannot choose a container instance.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Near the limit", tone: "warn" },
    { label: "Saturated or unplaced", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Ten tasks spread across three Availability Zones on six instances.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Packed",
    description: "Eight tasks with binpack CPU. The hottest instance enters the warning band.",
    tone: "warn",
    params: defaults({ taskCount: 8, instanceCount: 6, strategy: 2, constraint: 0 }),
  },
  {
    id: "failure",
    label: "One hot instance",
    description: "Ten tasks with binpack CPU. Every task lands on one instance and saturates it.",
    tone: "crit",
    params: defaults({ taskCount: 10, instanceCount: 6, strategy: 2, constraint: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The service spreads tasks across instances, closing the hot spot.",
    tone: "ok",
    params: defaults({ taskCount: 10, instanceCount: 6, strategy: 1, constraint: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-binpack",
  title: "Predict where ten tasks land with binpack",
  simId: "placement",
  question:
    "Ten tasks of equal size run on six instances. The service uses binpack by CPU. How are the tasks placed?",
  prediction: {
    options: [
      { id: "even", label: "Evenly, about two per instance" },
      { id: "one", label: "Filled onto one instance until it cannot fit more" },
      { id: "az", label: "One task per Availability Zone, then random" },
      { id: "pending", label: "All ten remain pending until the cluster is balanced" },
    ],
    correctOptionId: "one",
    explanation:
      "Binpack chooses the candidate with the least remaining CPU that still fits the task. It minimizes the number of instances in use, so it fills one instance before moving to the next. That is efficient and it concentrates load.",
  },
  setup: defaults({ taskCount: 10, instanceCount: 6, strategy: 2, constraint: 0 }),
  runFor: 12,
  observe: [
    "All ten tasks land on one instance at about 98% CPU.",
    "The cluster average is about 16%, so a cluster-level CPU alarm would stay quiet.",
    "Tail latency on the hot instance rises into the critical band.",
    "No task is unplaced; this is a distribution failure, not a capacity shortage.",
  ],
  explain:
    "Binpack is doing what it was asked to do: leave the least unused CPU and use fewer instances. The service has enough aggregate capacity, but the tasks do not share it. The cluster average hides the hot instance, and the load balancer cannot fix a per-task placement decision.",
  fix: defaults({ taskCount: 10, instanceCount: 6, strategy: 0, constraint: 0 }),
  debrief:
    "Spread across Availability Zones puts at most two tasks on each instance, so the hot instance falls to about 20% CPU and tail latency follows. The tradeoff is that spread uses more instances and can fragment capacity when tasks are large. The right choice depends on whether the priority is instance cost or blast radius and latency headroom.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Placement is how Amazon Elastic Container Service (ECS) chooses a container instance for a task. For the EC2 launch type, the scheduler first filters instances by the task's CPU, memory, and port requirements, then applies binding placement constraints, then applies a best-effort placement strategy. A task that matches no constraint candidate stays pending.",
  },
  {
    type: "p",
    text: "The three strategies answer different questions. Spread balances tasks across a field such as an Availability Zone (AZ) or an instance. Binpack chooses the instance with the least remaining CPU or memory that still fits the task, which minimizes the number of instances in use. Random chooses without a balance goal. A service with no explicit strategy uses spread across `attribute:ecs.availability-zone`.",
  },
  {
    type: "table",
    headers: ["Policy", "Goal", "Failure it invites"],
    rows: [
      ["Spread by AZ", "Keep tasks distributed across failure domains", "Large tasks can fragment capacity inside each zone"],
      ["Spread by instance", "Keep per-instance load even", "Does not guarantee AZ balance"],
      ["Binpack by CPU or memory", "Use the fewest instances", "Concentrates load and can put every task in one AZ"],
      ["distinctInstance constraint", "One task per instance", "Runs out of candidates when tasks exceed instances"],
      ["memberOf constraint", "Restrict candidates by attribute", "A narrow expression can leave no valid instance"],
    ],
  },
  {
    type: "p",
    text: "The distinction between a strategy and a constraint is the usual debugging mistake. A strategy is best effort: ECS still places the task when the ideal candidate is unavailable. A constraint is binding: if no instance satisfies it, the task is not placed. A cluster can have plenty of idle CPU and still leave tasks pending because every candidate violates the constraint.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Placement sits between the service scheduler and the container instances. On EC2, the scheduler sees registered instances, their remaining CPU and memory, and their attributes such as AZ and instance type. On Fargate, there are no customer-managed container instances: Fargate does not support task placement strategies or constraints, and it makes a best-effort spread across the Availability Zones you specify in the network configuration.",
  },
  {
    type: "p",
    text: "Capacity providers add another layer. An Auto Scaling group capacity provider supplies instances, and a Fargate capacity provider supplies Fargate capacity. The strategy still decides among the candidates the provider makes available. If the provider cannot supply capacity, no placement strategy can help.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Per-instance CPU: the signal that reveals a hot instance the cluster average hides.",
      "Tasks per instance and per AZ: whether placement is balanced or concentrated.",
      "Unplaced tasks: the binding-constraint failure that leaves work pending.",
      "Tail latency on the hottest instance: the user-visible cost of uneven placement.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Packed and One hot instance to see binpack fill a single instance. Compare the hot instance with the cluster average. Move the constraint slider to 2 to see a binding rule concentrate every task in one zone, then apply Recovery to spread the tasks again.",
  },
  { type: "sim", simId: "placement" },
  { type: "experiment", experimentId: "predict-binpack" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Binpack filled one instance before using the next, because that is how it minimizes the number of instances in use. The cluster had enough total CPU, but the hot instance had almost none left, so its tail latency rose. The cluster average stayed low enough to look healthy on a dashboard that did not break utilization down by instance.",
  },
  {
    type: "p",
    text: "The AZ constraint showed a different failure: placement was blocked or concentrated by a binding rule, not by a lack of aggregate capacity. Changing the strategy would not have fixed a constraint that excluded the idle instances.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Container Insights CPU and memory per task and per instance, not only the service average.",
      "`DescribeTasks` for the container instance ID, and `DescribeContainerInstances` for remaining CPU and memory.",
      "Service events for tasks that cannot be placed, including the unmet requirement.",
      "Application Load Balancer target health and per-target response time.",
      "AZ distribution of running tasks and the service's placement strategy and constraints.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the hottest instance, not the cluster average. Then check the strategy and every constraint on the service and task definition. Count the instances that satisfy the constraint and compare their free CPU with the task size. If tasks are pending, the constraint is the first suspect; if tasks are running but slow, placement concentration is.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the problem is a hot instance, an unplaced task, or both.",
      "Read the service placement strategy and the task definition and service constraints.",
      "If placement is concentrated, move to spread by AZ or spread by instance and let the scheduler rebalance.",
      "If tasks cannot place, add instances inside the constraint scope or relax the constraint.",
      "Verify per-instance utilization and AZ distribution after the change, not only the service average.",
      "Keep the task size small enough that spread has real candidates.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Binpack lowers instance count and cost, but concentrates load and increases blast radius.",
      "Spread improves latency headroom and AZ resilience, but can waste capacity when tasks are large.",
      "A narrow constraint can satisfy compliance or licensing needs while making placement fragile.",
      "Fargate removes instance management but also removes placement control; AZ spread is best effort.",
      "The cluster average is cheap to graph and easy to misread. Per-instance and per-AZ views cost more to build but answer the placement question.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "binpack-vs-spread",
    question:
      "When would you choose binpack over spread for an ECS service, and what would you monitor afterward?",
    difficulty: 2,
    hints: [
      "Binpack optimizes instance count; spread optimizes distribution.",
      "The strategy does not change the task size or the cluster capacity.",
    ],
    answer:
      "I would choose binpack when instance cost or instance count is the constraint and the workload tolerates concentration, such as a batch worker fleet with retries and no single task carrying a large share of traffic. I would monitor per-instance CPU and memory, the hottest instance's tail latency, and the AZ distribution of tasks. For a latency-sensitive service behind a load balancer, I would usually prefer spread across AZ so one instance or zone failure does not take a large share of capacity.",
    followUps: [
      "How does task size affect the value of spread?",
      "What does binpack do on scale-in?",
      "How would you detect a hot instance with only service-level metrics?",
    ],
    redFlags: [
      "Picks binpack only to save money without checking blast radius.",
      "Monitors the cluster average only.",
      "Assumes spread guarantees even load.",
    ],
    rubric: [
      "States the optimization goal of each strategy.",
      "Connects placement to failure domains.",
      "Names per-instance signals.",
      "Acknowledges cost.",
    ],
  },
  {
    id: "one-instance-hot",
    question:
      "All ten tasks of a service are on one container instance, which is at 95% CPU. The other instances are idle. How do you fix it?",
    difficulty: 2,
    hints: [
      "Check the strategy before adding capacity.",
      "A constraint can also pin the service to that instance or zone.",
    ],
    answer:
      "I would check the service's placement strategy first. If it is binpack, the scheduler is doing what it was configured to do, and I would move to spread across AZ or spread across instances. I would also check for a constraint that excludes the idle instances, such as distinctInstance with too few instances or a memberOf expression. Then I would verify that the task size fits the idle instances and let the service redeploy or rebalance. Adding capacity without changing placement may just create more idle instances.",
    followUps: [
      "How does ECS rebalance tasks after a strategy change?",
      "What would you check if the strategy is already spread?",
      "How does the load balancer distribute traffic across tasks?",
    ],
    redFlags: [
      "Adds instances without checking placement.",
      "Assumes the load balancer can move tasks.",
      "Ignores constraints.",
    ],
    rubric: [
      "Checks strategy first.",
      "Checks constraints and task size.",
      "Changes placement deliberately.",
      "Verifies per-instance load.",
    ],
  },
  {
    id: "constraint-blocks",
    question:
      "A service has 20 tasks pending and the cluster has idle CPU. What placement constraint would you check, and why can a strategy not fix it?",
    difficulty: 3,
    hints: [
      "Strategies guide; constraints filter.",
      "Count valid candidates, not total instances.",
    ],
    answer:
      "I would check distinctInstance and every memberOf expression on the service and task definition. A distinctInstance constraint allows at most one task per instance, so twenty tasks need twenty valid instances; idle CPU on six instances does not help. A memberOf expression can restrict candidates by attribute, instance type, or custom attribute, and a narrow expression can leave zero candidates. A strategy only orders the candidates that survive the constraints, so it cannot create a candidate that the constraint excluded.",
    followUps: [
      "How would you confirm the constraint is the cause from service events?",
      "What happens to the task while it is pending?",
      "When is distinctInstance the right choice?",
    ],
    redFlags: [
      "Tries a different strategy first.",
      "Counts total instances instead of valid candidates.",
      "Assumes ECS will relax the constraint.",
    ],
    rubric: [
      "Names the binding constraint types.",
      "Counts valid candidates.",
      "Explains strategy versus constraint.",
      "Names the remedy.",
    ],
  },
  {
    id: "fargate-placement",
    question:
      "A team moving to Fargate asks how to keep their tasks spread across three AZs with a placement strategy. What do you tell them?",
    difficulty: 2,
    hints: [
      "Fargate does not expose container instances.",
      "Network configuration still chooses subnets.",
    ],
    answer:
      "Fargate does not support task placement strategies or constraints. AWS places the tasks and makes a best-effort spread across the Availability Zones represented by the subnets in the service's network configuration. To influence AZ spread, they should include subnets in multiple AZs and give the service enough tasks that spreading is meaningful. They cannot pin a task to a specific instance or use distinctInstance. Capacity is still bounded by the Fargate task size and the service's maximum count.",
    followUps: [
      "What happens if all subnets are in one AZ?",
      "How would you verify AZ spread on Fargate?",
      "Which placement controls disappear when moving from EC2 to Fargate?",
    ],
    redFlags: [
      "Recommends a spread strategy on Fargate.",
      "Assumes Fargate guarantees even AZ distribution.",
      "Ignores subnet selection.",
    ],
    rubric: [
      "States that strategies and constraints are unsupported.",
      "Explains best-effort AZ spread.",
      "Mentions subnets.",
      "Names the loss of instance control.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The service placement strategy matches the goal: cost, latency headroom, or AZ resilience.",
      "Every constraint is intentional and its candidate set is large enough for the desired count.",
      "Task CPU and memory leave room for more than one task per instance when spread is used.",
      "Dashboards show per-instance and per-AZ utilization, not only the cluster average.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the hottest instance with the cluster average.",
      "Check the strategy and every constraint before adding capacity.",
      "Read the service event for pending tasks.",
      "Check whether Fargate or a capacity provider is limiting the candidate set.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify per-instance and per-AZ distribution after the change.",
      "Confirm tail latency improved on the previously hot instance.",
      "Review whether the constraint still matches its original requirement.",
      "Record the placement decision and the failure it prevents.",
    ],
  },
];

const references = [
  {
    title: "Use strategies to define Amazon ECS task placement",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement-strategies.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Spread, binpack, random, the default service strategy, and best-effort behavior.",
  },
  {
    title: "How Amazon ECS places tasks on container instances",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-placement.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "The placement pipeline, binding constraints, and Fargate's lack of placement controls.",
  },
  {
    title: "Amazon ECS service definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service_definition_parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "placementStrategy and placementConstraints fields and their limits.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    placement: {
      model: placementModel,
      presets,
      instructions:
        "Start Healthy, then apply Packed and One hot instance. Compare the hottest instance with the cluster average. Set the constraint slider to 2 to see a binding rule concentrate placement, then apply Recovery to spread the tasks.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Three AZs, six instances, 6,144 CPU units per instance, and 600 units per task are teaching values. The single-AZ constraint stands in for a memberOf expression.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-services",
    "containers-multi-az-scheduling",
    "containers-capacity-providers",
    "containers-cpu-memory-limits",
  ],
};
