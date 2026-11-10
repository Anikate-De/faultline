import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NODE_MEMORY_MIB = 16_384;
const NODE_CPU_UNITS = 8_192;
const TASKS = 4;

const params: ParamSpec[] = [
  {
    id: "taskMemoryMiB",
    label: "Task memory limit",
    min: 512,
    max: 8_192,
    step: 256,
    value: 4_096,
    unit: " MiB",
    group: "Memory",
    help: "The hard memory limit for one task. A task that cannot reclaim memory at this limit is killed by the kernel.",
    format: "number",
  },
  {
    id: "memoryUsageMiB",
    label: "Actual memory usage",
    min: 256,
    max: 10_240,
    step: 256,
    value: 2_600,
    unit: " MiB",
    group: "Memory",
    help: "The task's working set in this model. Usage above the task limit produces an OOM kill, not a slowdown.",
    format: "number",
  },
  {
    id: "cpuReservationUnits",
    label: "CPU reservation",
    min: 256,
    max: 4_096,
    step: 256,
    value: 1_024,
    unit: " units",
    group: "CPU",
    help: "CPU shares reserved for placement. 1,024 units equals one vCPU. A reservation influences scheduling and guarantees a share under contention.",
    format: "number",
  },
  {
    id: "cpuLimitUnits",
    label: "CPU limit",
    min: 256,
    max: 4_096,
    step: 256,
    value: 2_048,
    unit: " units",
    group: "CPU",
    help: "The hard CPU cap enforced by the container runtime. A task that demands more is throttled, not killed.",
    format: "number",
  },
  {
    id: "cpuUsageUnits",
    label: "Actual CPU demand",
    min: 256,
    max: 4_096,
    step: 256,
    value: 1_200,
    unit: " units",
    group: "CPU",
    help: "The CPU the task wants at peak. Demand above the limit is throttled; demand above the reservation can borrow idle capacity.",
    format: "number",
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
  memoryLimit: number;
  memoryUsage: number;
  cpuReservation: number;
  cpuLimit: number;
  cpuUsage: number;
  memoryPressure: number;
  memoryOom: boolean;
  cpuThrottle: number;
  cpuSlots: number;
  memorySlots: number;
  running: number;
  shortfall: number;
  memoryCommit: number;
  cpuCommit: number;
  nodeCpuPressure: number;
}

function compute(p: Params): Values {
  const memoryLimit = clamp(num(p, "taskMemoryMiB", 4_096), 512, 8_192);
  const memoryUsage = clamp(num(p, "memoryUsageMiB", 2_600), 256, 10_240);
  const cpuReservation = clamp(num(p, "cpuReservationUnits", 1_024), 256, 4_096);
  const cpuLimit = clamp(num(p, "cpuLimitUnits", 2_048), 256, 4_096);
  const cpuUsage = clamp(num(p, "cpuUsageUnits", 1_200), 256, 4_096);
  const memoryPressure = (memoryUsage / memoryLimit) * 100;
  const cpuThrottle = cpuUsage > cpuLimit ? ((cpuUsage - cpuLimit) / cpuUsage) * 100 : 0;
  const cpuSlots = Math.floor(NODE_CPU_UNITS / cpuReservation);
  const memorySlots = Math.floor(NODE_MEMORY_MIB / memoryLimit);
  const running = Math.max(0, Math.min(TASKS, cpuSlots, memorySlots));
  return {
    memoryLimit,
    memoryUsage,
    cpuReservation,
    cpuLimit,
    cpuUsage,
    memoryPressure,
    memoryOom: memoryUsage >= memoryLimit,
    cpuThrottle,
    cpuSlots,
    memorySlots,
    running,
    shortfall: TASKS - running,
    memoryCommit: (running * memoryLimit * 100) / NODE_MEMORY_MIB,
    cpuCommit: (running * cpuReservation * 100) / NODE_CPU_UNITS,
    nodeCpuPressure: (running * Math.min(cpuUsage, cpuLimit) * 100) / NODE_CPU_UNITS,
  };
}

function healthOf(values: Values): Health {
  if (values.memoryOom || values.cpuThrottle >= 20 || values.shortfall >= 2) return "crit";
  if (values.memoryPressure >= 80 || values.cpuThrottle >= 5 || values.shortfall >= 1) return "warn";
  return "ok";
}

function buildFrame(seed: number, values: Values): SimFrame {
  const health = healthOf(values);
  const memoryHealth: Health = values.memoryOom
    ? "crit"
    : values.memoryPressure >= 80
      ? "warn"
      : "ok";
  const cpuHealth: Health =
    values.cpuThrottle >= 20 ? "crit" : values.cpuThrottle >= 5 ? "warn" : "ok";
  const placementHealth: Health =
    values.shortfall >= 2 ? "crit" : values.shortfall >= 1 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "task",
      label: "checkout-task",
      kind: "service",
      health,
      utilization: clamp(values.memoryPressure / 100),
      sublabel: `${Math.round(values.memoryUsage)} / ${Math.round(values.memoryLimit)} MiB`,
      detail: `The task is configured with ${Math.round(values.memoryLimit)} MiB of memory and ${Math.round(values.cpuReservation)} CPU units reserved, capped at ${Math.round(values.cpuLimit)} units. Its actual demand is ${Math.round(values.memoryUsage)} MiB and ${Math.round(values.cpuUsage)} units.`,
      meta: { memory: values.memoryUsage, cpu: values.cpuUsage },
    },
    {
      id: "node",
      label: "Container instance",
      kind: "service",
      health: placementHealth,
      utilization: clamp(values.running / TASKS),
      sublabel: `${values.running} of ${TASKS} tasks placed`,
      detail: `The node has ${NODE_MEMORY_MIB} MiB and ${NODE_CPU_UNITS} CPU units in this model. Reservations allow ${values.cpuSlots} task(s) by CPU and ${values.memorySlots} by memory; ${values.running} can run.`,
      meta: { cpuSlots: values.cpuSlots, memorySlots: values.memorySlots },
    },
    {
      id: "memory",
      label: "Memory limit",
      kind: "worker",
      health: memoryHealth,
      utilization: clamp(values.memoryPressure / 100),
      sublabel: `${values.memoryPressure.toFixed(0)}% of limit`,
      detail: values.memoryOom
        ? `Usage is ${Math.round(values.memoryUsage)} MiB against a ${Math.round(values.memoryLimit)} MiB limit. The kernel cannot reclaim enough memory, so the task is killed.`
        : `Usage is ${Math.round(values.memoryUsage)} MiB against a ${Math.round(values.memoryLimit)} MiB limit. The hard limit is the ceiling that protects the node.`,
      meta: { pressure: Number(values.memoryPressure.toFixed(1)) },
    },
    {
      id: "cpu",
      label: "CPU limit",
      kind: "worker",
      health: cpuHealth,
      utilization: clamp(values.cpuUsage / values.cpuLimit),
      sublabel: `${values.cpuThrottle.toFixed(0)}% throttled`,
      detail:
        values.cpuThrottle > 0
          ? `Demand is ${Math.round(values.cpuUsage)} units against a ${Math.round(values.cpuLimit)}-unit cap. The runtime throttles the task; it does not kill it for CPU.`
          : `Demand is ${Math.round(values.cpuUsage)} units against a ${Math.round(values.cpuLimit)}-unit cap. No CPU throttling is active.`,
      meta: { throttle: Number(values.cpuThrottle.toFixed(1)) },
    },
    {
      id: "reserved",
      label: "Reserved capacity",
      kind: "service",
      health: values.cpuCommit >= 100 ? "warn" : "ok",
      utilization: clamp(values.cpuCommit / 100),
      sublabel: `${values.cpuCommit.toFixed(0)}% CPU committed`,
      detail: `Each task reserves ${Math.round(values.cpuReservation)} CPU units. ${values.running} placed task(s) commit ${values.cpuCommit.toFixed(0)}% of node CPU and ${values.memoryCommit.toFixed(0)}% of node memory. Reservations are a placement input, not a usage cap.`,
      meta: { cpuCommit: Number(values.cpuCommit.toFixed(1)), memoryCommit: Number(values.memoryCommit.toFixed(1)) },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("task-memory", "task", "memory", clamp(values.memoryPressure / 100), memoryHealth, "usage"),
      edge("task-cpu", "task", "cpu", clamp(values.cpuUsage / values.cpuLimit), cpuHealth, "demand"),
      edge("node-task", "node", "task", clamp(values.running / TASKS), health, "places"),
      edge("node-reserved", "node", "reserved", clamp(values.cpuCommit / 100), placementHealth, "reserves"),
    ],
    metrics: [
      metric("memory-pressure", "Memory usage against limit", values.memoryPressure, "%", 80, 100, "percent"),
      metric("cpu-throttle", "CPU demand throttled", values.cpuThrottle, "%", 5, 20, "percent"),
      metric("placement-shortfall", "Tasks that cannot be placed", values.shortfall, "", 1, 2, "count"),
      metric("memory-commit", "Node memory committed", values.memoryCommit, "%", undefined, undefined, "percent"),
      metric("cpu-commit", "Node CPU committed", values.cpuCommit, "%", undefined, undefined, "percent"),
      metric("task-memory", "Task memory limit", values.memoryLimit, " MiB", undefined, undefined, "number"),
      metric("task-cpu", "CPU reservation", values.cpuReservation, " units", undefined, undefined, "count"),
      metric("running-tasks", "Placed tasks", values.running, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, running: values.running },
    summary: `Task uses ${Math.round(values.memoryUsage)}/${Math.round(values.memoryLimit)} MiB and ${Math.round(values.cpuUsage)}/${Math.round(values.cpuLimit)} CPU units; ${values.running} of ${TASKS} tasks placed.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 16 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.4) * Math.max(0.2, item.value * 0.02);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "memory-pressure",
    metricId: "memory-pressure",
    warn: 80,
    crit: 100,
    title: "The task exceeded its memory limit",
    cause:
      "Memory is a hard limit. When the task's working set cannot be reclaimed below the limit, the kernel invokes the OOM killer and sends SIGKILL. A reservation does not prevent this; only the limit and the actual usage matter at that moment.",
    fix:
      "Decide whether the limit is wrong or the workload is. If the workload legitimately needs more, raise the task memory limit and verify the node can still place the task. If not, find the allocation or leak that raised the working set. Do not treat a restart as a fix.",
    checkFirst: [
      "Compare the task's memory usage curve with the limit before the kill.",
      "Read the stopped task reason and exit code.",
      "Check whether the task size still fits the node after any increase.",
    ],
  },
  {
    id: "cpu-throttle",
    metricId: "cpu-throttle",
    warn: 5,
    crit: 20,
    title: "The CPU limit is throttling the task",
    cause:
      "The task's demand is above its hard CPU cap, so the runtime gives it less CPU time. The task keeps running; its latency and progress slow down. A reservation gives it a share under contention, but it does not lift the cap.",
    fix:
      "Compare throttling with latency and useful work. If the task is CPU-bound and the node has idle capacity, raise the CPU limit or optimize the hot path. If the node is saturated, adding more tasks will move the problem, not solve it.",
    checkFirst: [
      "Check CPU throttling metrics for the task and container.",
      "Compare CPU demand with the limit and the node's free capacity.",
      "Check whether latency rose at the same time as throttling.",
    ],
  },
  {
    id: "placement-shortfall",
    metricId: "placement-shortfall",
    warn: 1,
    crit: 2,
    title: "Reservations leave no room for every task",
    cause:
      "Every task reserves CPU and memory, and the node can only place tasks while those reservations fit. A large reservation protects the task from contention but reduces the number of neighbors the node can host.",
    fix:
      "Reduce the reservation to the task's realistic steady-state need, or add capacity. A reservation above actual usage buys scheduling priority and costs placement density. Check the node's committed resources before changing the task size.",
    checkFirst: [
      "Compare the task reservation with the node's allocatable CPU and memory.",
      "Check how many tasks the service wants versus how many the node can place.",
      "Check whether a smaller reservation would still meet the latency target.",
    ],
  },
];

export const cpuMemoryModel: SimModel = {
  id: "containers-cpu-memory-limits",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const p = defaults();
    const values = compute(p);
    const frame = buildFrame(seed, values);
    seedSeries(frame);
    frame.flags.paramsKey = JSON.stringify(p);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const seed = Number(frame.flags.seed ?? 1);
    const next = buildFrame(seed, values);
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
      `The task has ${Math.round(values.memoryLimit)} MiB of memory and ${Math.round(values.cpuLimit)} CPU units of hard cap, with a ${Math.round(values.cpuReservation)}-unit reservation.`,
      values.memoryOom
        ? `Memory usage is ${values.memoryPressure.toFixed(0)}% of the limit. This is an OOM kill, not a CPU problem; CPU throttling would slow the task instead of stopping it.`
        : `Memory usage is ${values.memoryPressure.toFixed(0)}% of the limit, leaving ${Math.max(0, Math.round(values.memoryLimit - values.memoryUsage))} MiB of headroom.`,
      values.cpuThrottle > 0
        ? `CPU demand exceeds the limit, so ${values.cpuThrottle.toFixed(0)}% of the requested CPU time is throttled. The task continues at a slower rate.`
        : "CPU demand is under the limit, so the task is not throttled.",
      `The node can place ${values.running} of ${TASKS} tasks from these reservations. ${values.shortfall > 0 ? `${values.shortfall} task(s) have no room.` : "Every task has a placement candidate."}`,
      "A reservation affects placement and contention. A limit affects runtime. They are different controls and should not be set to the same number by habit.",
    ];
  },
  legend: [
    { label: "Within reservation and limit", tone: "ok" },
    { label: "Near a limit", tone: "warn" },
    { label: "Killed, throttled, or unplaced", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A 4,096 MiB task at 2,600 MiB, a 1,024-unit reservation, and a 2,048-unit CPU cap.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Tight limits",
    description: "Memory at 91% of a 3,072 MiB limit and CPU demand just above a 1,536-unit cap.",
    tone: "warn",
    params: defaults({
      taskMemoryMiB: 3_072,
      memoryUsageMiB: 2_800,
      cpuReservationUnits: 2_048,
      cpuLimitUnits: 1_536,
      cpuUsageUnits: 1_600,
    }),
  },
  {
    id: "failure",
    label: "Over limit",
    description: "A 2,048 MiB task uses 3,400 MiB while a 1,024-unit CPU cap throttles and a 3,072-unit reservation blocks placement.",
    tone: "crit",
    params: defaults({
      taskMemoryMiB: 2_048,
      memoryUsageMiB: 3_400,
      cpuReservationUnits: 3_072,
      cpuLimitUnits: 1_024,
      cpuUsageUnits: 2_600,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Memory is back under a 4,096 MiB limit, CPU demand is under the cap, and all four tasks place.",
    tone: "ok",
    params: defaults({
      taskMemoryMiB: 4_096,
      memoryUsageMiB: 3_000,
      cpuReservationUnits: 1_024,
      cpuLimitUnits: 2_048,
      cpuUsageUnits: 1_100,
    }),
  },
  {
    id: "oversubscribed",
    label: "Reserved too high",
    description: "A 6,144 MiB task with a 2,048-unit reservation places only two of four tasks on the node.",
    tone: "crit",
    params: defaults({
      taskMemoryMiB: 6_144,
      memoryUsageMiB: 3_000,
      cpuReservationUnits: 2_048,
      cpuLimitUnits: 2_048,
      cpuUsageUnits: 2_500,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-memory-kill",
  title: "Predict what a memory limit does",
  simId: "cpu-memory-limits",
  question:
    "A task has a 2,048 MiB memory limit, a 3,072 CPU-unit reservation, and a 1,024 CPU-unit limit. It uses 3,400 MiB of memory and demands 2,600 CPU units. The node has free memory. What happens?",
  prediction: {
    options: [
      { id: "limit", label: "The kernel kills the task when it cannot stay under the memory limit" },
      { id: "reservation", label: "The CPU reservation lets it use 3,400 MiB without consequence" },
      { id: "throttle", label: "CPU throttling holds the task until its memory usage falls" },
      { id: "node", label: "The node is killed instead of the task" },
    ],
    correctOptionId: "limit",
    explanation:
      "The memory limit is a hard ceiling for the task, and the CPU reservation has no effect on memory permission. Once the task cannot reclaim enough memory below its limit, the kernel OOM-kills it. Free node memory does not help, because the limit applies to the task. CPU throttling is a separate control and does not stop the process.",
  },
  setup: defaults({
    taskMemoryMiB: 2_048,
    memoryUsageMiB: 3_400,
    cpuReservationUnits: 3_072,
    cpuLimitUnits: 1_024,
    cpuUsageUnits: 2_600,
  }),
  runFor: 15,
  observe: [
    "Memory pressure reaches 166% of the task limit, so the task is killed regardless of node headroom.",
    "CPU demand above the 1,024-unit cap is throttled; throttling slows the task but does not stop it.",
    "The 3,072-unit reservation leaves room for only two tasks on the node, so two more cannot place.",
    "Raising the memory limit, lowering demand, and right-sizing the reservation resolve three separate failures.",
  ],
  explain:
    "Limits and reservations answer different questions. A reservation asks whether the scheduler can place the task and what share it should receive under contention. A limit asks how much the runtime will allow before it throttles CPU or kills the process for memory. Setting a reservation equal to a limit is a common shortcut that can block placement while still allowing an OOM if the workload's real need is higher.",
  fix: defaults(),
  debrief:
    "With a 4,096 MiB limit and 3,000 MiB usage, the task has 1,096 MiB of headroom and is not killed. The 1,024-unit reservation lets all four tasks place, and CPU demand stays under the cap. The tradeoff is cost and density: larger limits and reservations protect the task and reduce how many neighbors fit. Size from measured usage and latency, not from the largest spike you have ever seen.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "CPU and memory limits are runtime controls on a container. A limit is the maximum the container runtime allows. For CPU, exceeding the limit causes throttling: the task gets less CPU time and runs more slowly. For memory, exceeding the hard limit causes the kernel's out-of-memory (OOM) killer to send SIGKILL. The process does not get a warning or a graceful shutdown.",
  },
  {
    type: "p",
    text: "A reservation is a different control. It tells the scheduler how much CPU or memory to set aside for placement and gives the task a guaranteed share when the node is contended. On Amazon Elastic Container Service (ECS), you can set task-level CPU and memory, and container-level CPU and memory settings inside the task definition. A task reservation is not a cap. A container CPU limit is a cap. The exact behavior depends on the launch type and where the limit is declared, which is why reading the task definition matters more than reading the console summary.",
  },
  {
    type: "table",
    headers: ["Setting", "What it controls", "What happens when exceeded"],
    rows: [
      ["CPU reservation", "Placement and share under contention", "The task can borrow idle CPU; the reservation does not cap it"],
      ["CPU limit", "Hard CPU cap enforced by the runtime", "The task is throttled, not killed"],
      ["Memory reservation", "Placement and a memory share", "It does not permit usage above the hard limit"],
      ["Memory limit", "Hard ceiling for the task", "The kernel OOM-kills the task when it cannot reclaim memory"],
      ["Node capacity", "How many reservations fit", "Tasks remain unplaced; the service cannot reach desired count"],
    ],
  },
  {
    type: "p",
    text: "CPU is measured in ECS CPU units, where 1,024 units equals one vCPU. That unit makes small shares expressible: a 256-unit task can request a quarter of a vCPU. Memory is measured in mebibytes (MiB). The model uses four tasks and one node, but the same arithmetic applies to a cluster: sum the reservations that must fit, then compare that with allocatable capacity.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The reservation is read by the scheduler before the task starts. The limit is enforced by the container runtime and the Linux control groups after it starts. That split explains the failure modes. A task with a reservation larger than the node can satisfy never starts, even if its actual usage would have been tiny. A task that starts and then exceeds its memory limit is killed, even if the node has free memory. A task that exceeds its CPU limit keeps running and simply receives less CPU.",
  },
  {
    type: "p",
    text: "Neighbors matter because a node is shared. A hard memory limit prevents one task from consuming memory that another task reserved. A CPU limit prevents one task from consuming the whole node's CPU time. Without limits, a noisy task can starve its neighbors even when every task has a reservation, because reservations guarantee a share only under contention and do not cap the greedy task.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Memory pressure against the task limit, with an OOM kill at 100%.",
      "CPU throttling, which rises when demand exceeds the cap and slows the task instead of stopping it.",
      "Placement shortfall, where reservations leave no room for every desired task.",
      "Node commitment, which shows whether the problem is the task size or the amount of capacity.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Tight limits to see memory and CPU approach their ceilings. Apply Over limit to combine an OOM kill, CPU throttling, and a placement shortfall. Apply Reserved too high to isolate the placement effect, then Recovery to restore headroom. Run the experiment before the debrief.",
  },
  { type: "sim", simId: "cpu-memory-limits" },
  { type: "experiment", experimentId: "predict-memory-kill" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset produced three different outcomes from three different controls. Memory at 3,400 MiB against a 2,048 MiB limit was an OOM kill: the hard ceiling left the kernel no choice. CPU demand at 2,600 units against a 1,024-unit cap was throttling: the task kept running, but slower. A 3,072-unit reservation allowed only two of four tasks to place, so the service could not reach its desired count even though the node had idle capacity for smaller tasks.",
  },
  {
    type: "p",
    text: "The recovery preset raised the memory limit to 4,096 MiB, lowered the reservation to 1,024 units, and kept CPU demand under the cap. Memory pressure fell to 73%, all four tasks placed, and no throttling remained. Nothing about the application changed; the configuration stopped fighting the workload.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A stopped task with exit code 137 and a memory-related stop reason.",
      "CPU throttling metrics for a task that is still running but slow.",
      "A service that cannot reach its desired count while the cluster reports free capacity that does not match the task size.",
      "Container memory and CPU series that spike before a restart or a latency increase.",
      "Task definition changes that alter a limit without changing the image or the code.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the task definition: which value is a reservation and which is a limit, at task level and container level. Then compare actual usage with the limit and actual demand with the cap. If the task never started, check reservations and node capacity before looking at the application.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify whether the symptom is a kill, a slowdown, or a task that never placed.",
      "For a kill, compare memory growth with the hard limit and read the stop reason.",
      "For throttling, compare CPU demand with the cap and check node contention.",
      "For placement, compare the reservation with allocatable node capacity.",
      "Change one control at a time, then re-check both the symptom and the neighbor impact.",
      "Record the measured working set and CPU demand so the next task size is not another guess.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A higher memory limit prevents OOM kills and reduces the number of tasks that fit on a node.",
      "A higher CPU reservation protects latency and can leave capacity unused when the task is idle.",
      "A lower CPU limit protects neighbors and can turn a CPU-bound task into a slow one.",
      "Setting the reservation equal to the limit simplifies reasoning and often wastes capacity or blocks placement.",
      "Sidecars share the task's resources, so their limits reduce what the main container can use.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "reservation-vs-limit",
    question:
      "What is the difference between a CPU reservation and a CPU limit, and when would you set them differently?",
    difficulty: 2,
    hints: [
      "One is used before the task starts; the other is enforced while it runs.",
      "A reservation guarantees a share, not a ceiling.",
    ],
    answer:
      "A reservation is a scheduling input and a guaranteed share under contention. A limit is a hard cap enforced at runtime. I would set the reservation from the task's steady-state need, so the scheduler can place it predictably. I would set the limit higher than the steady state if the task has legitimate bursts, or equal to it if I need strict isolation from neighbors. If I set both to the peak, I reserve capacity that sits idle; if I set both to the average, bursts get throttled. The right pair depends on the latency target and the cost of idle capacity.",
    followUps: [
      "What happens to a task that exceeds its CPU reservation but not its limit?",
      "How does CPU throttling show up in latency?",
      "When is a reservation equal to the limit reasonable?",
    ],
    redFlags: [
      "Treats a reservation as a hard cap.",
      "Sets every value to the peak without measuring.",
      "Ignores neighbor contention.",
    ],
    rubric: [
      "Separates placement from runtime enforcement.",
      "Explains guaranteed share versus cap.",
      "Sizes from measured need.",
      "Names the cost of over-reserving.",
    ],
  },
  {
    id: "oom-vs-throttle",
    question:
      "A task restarts with exit code 137. Another task is slow but never restarts. How do you tell whether each problem is CPU or memory?",
    difficulty: 2,
    hints: [
      "CPU limits throttle; memory limits kill.",
      "The stop reason and the metric shape are different.",
    ],
    answer:
      "For the restart, I would read the stopped task reason and the memory curve before the stop. Exit 137 means SIGKILL, and a memory-related stop reason points to the OOM killer. For the slow task, I would compare CPU throttling with demand and latency; a throttled task keeps running. The shapes differ too: memory pressure climbs until the kill, while CPU throttling follows demand peaks. I would not diagnose the restart from exit code alone, because 137 can have other causes, but it rules out a normal exit.",
    followUps: [
      "What would you check if the stop reason is missing?",
      "How does a memory leak differ from a working-set spike?",
      "Which CloudWatch metrics would you graph first?",
    ],
    redFlags: [
      "Assumes every 137 is OOM.",
      "Raises CPU limits for a memory problem.",
      "Ignores stop reasons.",
    ],
    rubric: [
      "Connects CPU to throttling and memory to kills.",
      "Checks stop reason and memory curve.",
      "Distinguishes leak from spike.",
      "Avoids treating 137 as sufficient proof.",
    ],
  },
  {
    id: "neighbor-starvation",
    question:
      "One task on a node is using far more memory than its share and other tasks are being evicted. How do limits change this?",
    difficulty: 3,
    hints: [
      "A reservation does not cap a greedy task.",
      "A hard memory limit contains the blast radius to one task.",
    ],
    answer:
      "A reservation alone does not stop a task from using more memory when the node has free capacity, so a greedy task can consume the node and force the kernel to reclaim from its neighbors. A hard memory limit on each task caps that task's usage, so the blast radius stays local: the greedy task is OOM-killed instead of the node destabilizing. I would set memory limits from measured working sets, leave headroom for page cache and system processes, and check that the sum of limits does not exceed node memory. CPU limits play the same role for CPU time: they throttle the noisy task rather than letting it starve neighbors.",
    followUps: [
      "What happens if the sum of task limits exceeds node memory?",
      "How do sidecars change the memory budget?",
      "Would you use a soft limit for memory?",
    ],
    redFlags: [
      "Relies on reservations alone for isolation.",
      "Sets limits equal to node capacity for every task.",
      "Ignores system overhead.",
    ],
    rubric: [
      "Explains reservation versus hard limit.",
      "Contains the blast radius to one task.",
      "Sums limits against node memory.",
      "Accounts for sidecars and system overhead.",
    ],
  },
];

const checklist = [
  {
    title: "Before the task ships",
    items: [
      "The task memory limit is based on a measured working set, not the largest spike ever seen.",
      "The CPU reservation reflects steady-state need; the CPU limit reflects an acceptable burst.",
      "The sum of task limits and system overhead fits the node or Fargate task size.",
      "Sidecar reservations and limits are included in the task budget.",
    ],
  },
  {
    title: "During an incident",
    items: [
      "Read the task definition to see which value is a reservation and which is a limit.",
      "Compare memory usage with the hard limit and check the stop reason.",
      "Compare CPU demand with the cap and check throttling metrics.",
      "Check placement and node commitment when a task never starts.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Record the measured memory and CPU demand for the revision.",
      "Change one limit at a time and re-test neighbor impact.",
      "Verify that the service still reaches its desired count.",
      "Review whether a larger task size is cheaper than more tasks.",
    ],
  },
];

const references = [
  {
    title: "Amazon ECS task definition parameters",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Task-level and container-level CPU and memory settings, reservations, and limits.",
  },
  {
    title: "Amazon ECS task size",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/fargate-tasks-services.html",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Task CPU and memory sizing for Fargate and the relationship between task and container resources.",
  },
  {
    title: "Amazon ECS container definitions",
    url: "https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task_definition_parameters.html#container_definitions",
    publisher: "Amazon Web Services",
    kind: "docs" as const,
    note: "Container-level cpu, memory, and memoryReservation fields.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cpu-memory-limits": {
      model: cpuMemoryModel,
      presets,
      instructions:
        "Start Healthy, then apply Tight limits, Over limit, and Reserved too high. Compare the memory kill, the CPU throttle, and the placement shortfall, then apply Recovery. Run the experiment before the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 16,384 MiB node, 8,192 CPU units, four-task layout, and all thresholds are teaching values, not ECS instance sizes or limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "containers-task-definitions",
    "containers-oom-kills",
    "containers-sidecar-patterns",
    "containers-placement",
  ],
};
