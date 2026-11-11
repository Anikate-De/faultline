import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimNode,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_PODS = 40;
const CRITICAL_PODS = 4;

const params: ParamSpec[] = [
  {
    id: "memoryUsedPct",
    label: "Node memory used",
    min: 50,
    max: 100,
    step: 1,
    value: 78,
    unit: "%",
    group: "Node",
    help: "Share of node memory in use. The model starts evicting above a 90% teaching threshold; a real kubelet threshold is usually expressed in absolute available memory.",
    format: "percent",
  },
  {
    id: "diskUsedPct",
    label: "Node filesystem used",
    min: 40,
    max: 100,
    step: 1,
    value: 62,
    unit: "%",
    group: "Node",
    help: "Share of the node filesystem used by images, logs, and emptyDir volumes. Disk pressure can evict pods while memory is comfortable.",
    format: "percent",
  },
  {
    id: "bestEffortPct",
    label: "BestEffort pods",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Workloads",
    help: "Share of pods with no CPU or memory requests. BestEffort pods are evicted before Burstable and Guaranteed pods under node pressure.",
    format: "percent",
  },
  {
    id: "criticalPriority",
    label: "Critical workload has PriorityClass",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Workloads",
    help: "1 gives the critical Deployment a high-priority class to influence eviction ordering. It does not make the pod immune to pressure.",
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

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

interface Values {
  memoryUsed: number;
  diskUsed: number;
  bestEffortPct: number;
  priority: boolean;
  memoryAvailable: number;
  diskAvailable: number;
  memoryPressure: boolean;
  diskPressure: boolean;
  pressure: number;
  bestEffortPods: number;
  evictedBestEffort: number;
  burstablePods: number;
  evictedBurstable: number;
  evictedCritical: number;
  evicted: number;
  criticalUnavailable: number;
  cpuUsed: number;
}

function compute(p: Params): Values {
  const memoryUsed = clamp(num(p, "memoryUsedPct", 78), 50, 100);
  const diskUsed = clamp(num(p, "diskUsedPct", 62), 40, 100);
  const bestEffortPct = clamp(num(p, "bestEffortPct", 10), 0, 100);
  const priority = num(p, "criticalPriority", 1) >= 1;
  const memoryAvailable = 100 - memoryUsed;
  const diskAvailable = 100 - diskUsed;
  const memoryPressure = memoryUsed >= 90;
  const diskPressure = diskUsed >= 90;
  const hardMemory = Math.max(0, (memoryUsed - 90) / 10);
  const hardDisk = Math.max(0, (diskUsed - 90) / 10);
  const pressure = Math.max(hardMemory, hardDisk);
  const bestEffortPods = Math.round((TOTAL_PODS * bestEffortPct) / 100);
  const evictedBestEffort = Math.round(bestEffortPods * pressure);
  const burstablePods = Math.max(0, TOTAL_PODS - bestEffortPods - CRITICAL_PODS);
  const evictedBurstable = Math.round(burstablePods * pressure * 0.5);
  const evictedCritical =
    pressure <= 0 || (priority && pressure < 0.8)
      ? 0
      : Math.min(CRITICAL_PODS, Math.max(1, Math.round(CRITICAL_PODS * pressure)));
  return {
    memoryUsed,
    diskUsed,
    bestEffortPct,
    priority,
    memoryAvailable,
    diskAvailable,
    memoryPressure,
    diskPressure,
    pressure,
    bestEffortPods,
    evictedBestEffort,
    burstablePods,
    evictedBurstable,
    evictedCritical,
    evicted: evictedBestEffort + evictedBurstable + evictedCritical,
    criticalUnavailable: (evictedCritical / CRITICAL_PODS) * 100,
    cpuUsed: 32,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const nodeHealth: Health =
    values.memoryPressure || values.diskPressure
      ? "crit"
      : values.memoryAvailable < 15 || values.diskAvailable < 20
        ? "warn"
        : "ok";
  const criticalHealth = healthFor(values.criticalUnavailable, 1, 25);
  const nodes: SimNode[] = [
    {
      id: "node",
      label: "worker-2",
      kind: "service",
      health: nodeHealth,
      utilization: Math.max(values.memoryUsed, values.diskUsed) / 100,
      sublabel: `${values.memoryAvailable}% mem free, ${values.diskAvailable}% disk free`,
      detail:
        "The node reports conditions, not a single health score. Memory pressure, DiskPressure, and PIDPressure can each trigger eviction. CPU is compressible: the scheduler throttles it, but the kubelet does not evict a pod because the CPU is busy.",
      meta: { view: "flow" },
    },
    {
      id: "kubelet",
      label: "kubelet eviction manager",
      kind: "service",
      health: nodeHealth,
      utilization: clamp(values.pressure),
      sublabel: values.memoryPressure
        ? "MemoryPressure active"
        : values.diskPressure
          ? "DiskPressure active"
          : "no pressure condition",
      detail:
        "The eviction manager ranks pods and reclaims node resources when a threshold is crossed. It evicts by QoS class first, then by usage above requests, and uses priority when ranking pods.",
      meta: { view: "flow" },
    },
    {
      id: "best-effort",
      label: "BestEffort pods",
      kind: "worker",
      health: values.evictedBestEffort > 0 ? "crit" : "ok",
      utilization: values.bestEffortPct / 100,
      sublabel: `${values.bestEffortPods} pods, ${values.evictedBestEffort} evicted`,
      detail:
        "Pods without requests have the weakest eviction protection. They are the first candidates because the kubelet cannot reason about their minimum needs.",
      meta: { view: "flow" },
    },
    {
      id: "burstable",
      label: "Burstable above requests",
      kind: "worker",
      health: values.evictedBurstable > 0 ? "crit" : "ok",
      utilization: values.burstablePods / TOTAL_PODS,
      sublabel: `${values.burstablePods} pods, ${values.evictedBurstable} evicted`,
      detail:
        "Burstable pods have requests lower than their limits. The eviction manager ranks those using more than their requests ahead of pods within their requests and Guaranteed pods.",
      meta: { view: "flow" },
    },
    {
      id: "critical",
      label: "Critical workload",
      kind: "service",
      health: criticalHealth,
      utilization: values.criticalUnavailable / 100,
      sublabel: `${values.evictedCritical} of ${CRITICAL_PODS} evicted`,
      detail: values.priority
        ? "A PriorityClass raises the ranking of this workload. It delays eviction and does not prevent it when pressure is extreme."
        : "Without a PriorityClass, the critical workload ranks like any other pod in its QoS class. Replicas can be evicted while less important workloads survive.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("node-kubelet", "node", "kubelet", clamp(values.pressure || 0.2), nodeHealth, "conditions"),
      edge("kubelet-best", "kubelet", "best-effort", values.evictedBestEffort > 0 ? 1 : 0.3, values.evictedBestEffort > 0 ? "crit" : "ok", "evicts first"),
      edge("kubelet-burstable", "kubelet", "burstable", values.evictedBurstable > 0 ? 0.9 : 0.3, values.evictedBurstable > 0 ? "crit" : "ok", "evicts next"),
      edge("kubelet-critical", "kubelet", "critical", values.evictedCritical > 0 ? 0.8 : 0.2, criticalHealth, "evicts last"),
      edge("node-critical", "node", "critical", values.criticalUnavailable / 100, criticalHealth, "hosts"),
    ],
    metrics: [
      metric("memory-used", "Node memory used", values.memoryUsed, "%", 85, 90, "percent"),
      metric("disk-used", "Node filesystem used", values.diskUsed, "%", 80, 90, "percent"),
      metric("evicted-pods", "Evicted pods", values.evicted, " pods", 1, 4, "count"),
      metric("burstable-evicted", "Burstable pods evicted", values.evictedBurstable, " pods", undefined, undefined, "count"),
      metric("critical-unavailable", "Critical replicas evicted", values.criticalUnavailable, "%", 1, 25, "percent"),
      metric("cpu-used", "Node CPU used", values.cpuUsed, "%", undefined, undefined, "percent"),
      metric("best-effort-pods", "BestEffort pods", values.bestEffortPods, " pods", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Memory ${values.memoryAvailable}% free, disk ${values.diskAvailable}% free, CPU ${values.cpuUsed}%; ${values.evicted} evicted (${values.evictedBestEffort} BestEffort, ${values.evictedBurstable} Burstable, ${values.evictedCritical} critical).`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * 0.02 * Math.sin((index + (seed % 4)) / 2.7);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "memory-used",
    metricId: "memory-used",
    warn: 85,
    crit: 90,
    title: "Node memory is below the eviction headroom",
    cause:
      "Memory is approaching or past the kubelet's memory eviction headroom. If the threshold is crossed, the kubelet reclaims memory by evicting pods: BestEffort first, then Burstable pods using more than their requests, then Guaranteed pods, with priority adjusting the ranking. CPU is throttled and does not trigger eviction.",
    fix:
      "Reduce the node's memory demand or add capacity. Set requests and limits so QoS is predictable, give critical workloads a PriorityClass, and move batch or cache-heavy pods to a dedicated node pool.",
    checkFirst: [
      "Read the node's MemoryPressure condition and the kubelet's eviction threshold configuration.",
      "Check which pods were evicted and their QoS class and priority.",
      "Check whether the workload grew, a limit changed, or a new pod landed on the node.",
    ],
  },
  {
    id: "disk-used",
    metricId: "disk-used",
    warn: 80,
    crit: 90,
    title: "Node filesystem pressure is evicting pods",
    cause:
      "The node filesystem is filling with container images, logs, or emptyDir data. DiskPressure can evict pods even when memory and CPU are comfortable. The kubelet may also garbage-collect images before it evicts workloads.",
    fix:
      "Reclaim space from logs and unused images, set ephemeral-storage requests and limits, rotate logs, and move large emptyDir consumers off the node. Adding disk without fixing the growth only delays the next eviction.",
    checkFirst: [
      "Read the node's DiskPressure condition and check nodefs and imagefs usage.",
      "Check the largest directories under the kubelet root and the container log paths.",
      "Check which pods use emptyDir or write large logs.",
    ],
  },
  {
    id: "evicted-pods",
    metricId: "evicted-pods",
    warn: 1,
    crit: 4,
    title: "The kubelet is evicting pods",
    cause:
      "A node condition crossed its threshold and the eviction manager selected victims. The order follows QoS and resource usage above requests; a PriorityClass changes the ranking but does not create capacity.",
    fix:
      "Relieve the node condition first, then replace the lost replicas. Review requests, limits, and QoS so the next pressure event evicts the least important workload, not a critical one.",
    checkFirst: [
      "Check pod status for Evicted and the kubelet's eviction message.",
      "Group the node's pods by QoS class and priority.",
      "Check whether a single workload accounts for most of the memory or disk growth.",
    ],
  },
  {
    id: "critical-unavailable",
    metricId: "critical-unavailable",
    warn: 1,
    crit: 25,
    title: "Critical replicas were evicted",
    cause:
      "The critical workload did not rank high enough in the eviction order, or pressure was extreme enough to reach it. Replicas on the same node share the same fate, so anti-affinity and capacity headroom matter as much as priority.",
    fix:
      "Give the workload a PriorityClass, spread replicas across nodes, and reserve capacity for it. Confirm the new replicas can schedule before declaring recovery.",
    checkFirst: [
      "Check which replicas were evicted and where the survivors run.",
      "Check the PriorityClass and QoS class of the critical pods.",
      "Check whether the remaining nodes have room for replacements.",
    ],
  },
];

export const nodePressureModel: SimModel = {
  id: "kubernetes-node-pressure",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.events = [...frame.events];
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "cpu-used" ? { ...item, value: Math.max(0, item.value * jitter) } : item,
    );
    next.flags = {
      ...frame.flags,
      ...next.flags,
      elapsed: Math.max(0, Number(frame.flags.elapsed ?? 0)) + Math.max(0, dt),
      paramsKey: JSON.stringify(p),
    };
    if (values.evicted > 0 && frame.flags.evictionEvent !== 1) {
      pushEvent(next, {
        id: "node-eviction",
        severity: "crit",
        title: "The kubelet is evicting pods under node pressure",
        detail: `${values.evicted} pods evicted with CPU at ${values.cpuUsed}%: ${values.evictedBestEffort} BestEffort, ${values.evictedBurstable} Burstable above requests, ${values.evictedCritical} critical. Memory available is ${values.memoryAvailable}% and filesystem available is ${values.diskAvailable}%.`,
        nodeId: "kubelet",
        metricId: "evicted-pods",
      });
      next.flags.evictionEvent = 1;
    }
    if (values.evicted === 0) next.flags.evictionEvent = 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines = [
      `Memory is ${values.memoryUsed}% used and the filesystem is ${values.diskUsed}% used. CPU is ${values.cpuUsed}% and is not the eviction signal.`,
      values.memoryPressure
        ? `MemoryPressure is active; ${values.evictedBestEffort} BestEffort, ${values.evictedBurstable} Burstable above requests, and ${values.evictedCritical} critical pods are modeled as evicted.`
        : "MemoryPressure is not active in this state.",
      "Eviction order is a QoS proxy: BestEffort first, then Burstable pods using more than their requests, then Guaranteed or prioritized pods.",
      values.diskPressure
        ? "DiskPressure is active. Images, logs, or emptyDir data can trigger eviction while memory looks healthy."
        : "DiskPressure is not active in this state.",
      values.priority
        ? "The critical workload has a PriorityClass, which improves its eviction ranking but does not make it immune."
        : "The critical workload has no PriorityClass, so it can be evicted alongside ordinary pods.",
    ];
    return lines;
  },
  legend: [
    { label: "Within headroom", tone: "ok" },
    { label: "Approaching eviction", tone: "warn" },
    { label: "Evicting pods", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Memory and disk have headroom, few BestEffort pods, and the critical workload has a PriorityClass.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Memory headroom shrinking",
    description: "Memory is at 89%, below the eviction threshold but with little room for a spike.",
    tone: "warn",
    params: defaults({ memoryUsedPct: 89, diskUsedPct: 68, bestEffortPct: 30, criticalPriority: 1 }),
  },
  {
    id: "failure",
    label: "Memory and disk pressure",
    description: "Memory at 98% and disk at 95% evict BestEffort pods, then Burstable pods above requests, then critical replicas without a PriorityClass.",
    tone: "crit",
    params: defaults({ memoryUsedPct: 98, diskUsedPct: 95, bestEffortPct: 25, criticalPriority: 0 }),
  },
  {
    id: "recovery",
    label: "Pressure relieved",
    description: "Memory and disk return to headroom, leaving room for the evicted replicas to reschedule.",
    tone: "ok",
    params: defaults({ memoryUsedPct: 72, diskUsedPct: 60, bestEffortPct: 10, criticalPriority: 1 }),
  },
  {
    id: "disk-pressure",
    label: "Disk pressure",
    description: "Memory is comfortable but the filesystem is at 96%, so the kubelet evicts BestEffort and Burstable pods.",
    tone: "crit",
    params: defaults({ memoryUsedPct: 68, diskUsedPct: 96, bestEffortPct: 20, criticalPriority: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-eviction-signal",
  title: "Predict what triggers eviction when CPU is low",
  simId: "node-pressure",
  question:
    "A node reports 32% CPU, 98% memory used, and 25% BestEffort pods. The critical Deployment has no PriorityClass. Pods are being evicted. Is CPU the cause?",
  prediction: {
    options: [
      { id: "cpu", label: "Yes. The node is CPU starved even though the average looks low" },
      { id: "memory", label: "No. Memory pressure drives eviction, and BestEffort pods are selected first" },
      { id: "disk", label: "No. Only DiskPressure can evict pods" },
      { id: "priority", label: "No. Eviction is random once any threshold is crossed" },
    ],
    correctOptionId: "memory",
    explanation:
      "CPU is a compressible resource: the scheduler throttles containers, but the kubelet does not evict pods for high CPU use. Memory is not compressible, so the kubelet uses MemoryPressure and an available-memory threshold. It ranks BestEffort pods first, then Burstable pods above their requests, and a PriorityClass changes that ranking. Without a PriorityClass, the critical workload can be reached once the lower-ranked pods are gone.",
  },
  setup: defaults({ memoryUsedPct: 98, diskUsedPct: 95, bestEffortPct: 25, criticalPriority: 0 }),
  runFor: 20,
  observe: [
    "CPU stays at 32% while the eviction count rises.",
    "Memory and filesystem availability cross their critical lines.",
    "BestEffort pods are evicted first, then Burstable pods above their requests, then the unprotected critical replicas.",
    "Freeing memory and adding a PriorityClass stops the eviction and lets replacements schedule.",
  ],
  explain:
    "The kubelet reacts to node conditions, not to a composite health score. MemoryPressure and DiskPressure have separate thresholds and separate reclaim paths. QoS and priority decide who pays first, but the only durable fix is to restore the resource that crossed its threshold.",
  fix: defaults({ memoryUsedPct: 70, diskUsedPct: 58, bestEffortPct: 5, criticalPriority: 1 }),
  debrief:
    "The fixed state leaves headroom, reduces the BestEffort share, and ranks the critical workload higher. The eviction count returns to zero because the condition cleared, not because the ranking changed. Priority only decides the order under pressure; it cannot create memory or disk space.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kubernetes node reports conditions such as MemoryPressure, DiskPressure, and PIDPressure. The kubelet watches those conditions and evicts pods to protect the node. Eviction is local to the node and is different from scheduling: a pod can be running and healthy and still be selected for eviction because another workload consumed the node's memory or disk.",
  },
  {
    type: "p",
    text: "CPU is not one of those eviction conditions. CPU is compressible: the kernel throttles containers that exceed their CPU limits, and the node stays up. Memory and disk are not compressible in the same way. When available memory or filesystem space falls below the kubelet's threshold, the kubelet must free something, so it evicts pods. That is why a node can evict pods at 30% CPU.",
  },
  {
    type: "p",
    text: "The eviction order depends on QoS class. BestEffort pods have no requests or limits and rank first. Burstable pods have requests lower than limits, and those using more than their requests rank next. Guaranteed pods have requests equal to limits and rank last. A PriorityClass changes the ranking among pods, but it does not make a pod immune when pressure is severe. Replicas spread across nodes survive better than replicas stacked on one node.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Signal", "Node condition", "What the kubelet does"],
    rows: [
      ["Available memory", "MemoryPressure", "Evicts pods by QoS and usage above requests"],
      ["Filesystem or image space", "DiskPressure", "Reclaims images and logs, then evicts pods"],
      ["Process count", "PIDPressure", "Evicts pods that consume process IDs"],
      ["CPU utilization", "None", "Throttles containers; does not evict for CPU alone"],
      ["PriorityClass", "Not a condition", "Changes the eviction ranking among pods"],
    ],
  },
  {
    type: "p",
    text: "The model uses a 90% memory and disk teaching threshold, 40 pods, and a 32% CPU baseline as illustrative values. Real kubelet eviction thresholds are configured separately, often in absolute units such as available memory. The teaching point is the direction of the signal and the order of eviction, not the exact percentage at which a particular cluster acts.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Memory and filesystem availability, the two signals that can evict pods here.",
      "Node CPU, which stays low while eviction is active.",
      "Evicted pods and the critical replicas lost, split by QoS and priority.",
      "The node condition and the kubelet's eviction manager state.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then raise memory to 89% and watch headroom turn amber without eviction. Apply Memory and disk pressure to see BestEffort pods go first and the unprioritized critical workload follow. Compare Disk pressure, where memory stays comfortable, and finish with Pressure relieved.",
  },
  { type: "sim", simId: "node-pressure" },
  { type: "experiment", experimentId: "predict-eviction-signal" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset pushed memory and disk past their thresholds. CPU stayed at 32%, so a CPU dashboard would have looked calm. The kubelet evicted BestEffort pods first, then reached the critical replicas because they had no PriorityClass and shared the same node.",
  },
  {
    type: "p",
    text: "The recovery preset restored memory and disk headroom and gave the critical workload a PriorityClass. The eviction count fell to zero because the conditions cleared. The disk-pressure preset showed the other path: memory was healthy, but the filesystem was full, so eviction still happened.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Node conditions from kubectl describe node, especially MemoryPressure and DiskPressure.",
      "Evicted pod status and the kubelet event that names the threshold and the victim.",
      "Pod QoS class and PriorityClass, plus usage relative to requests.",
      "Node filesystem usage for nodefs and imagefs, and the largest emptyDir or log consumers.",
      "Scheduler events for replacement pods that cannot fit on the remaining nodes.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the node condition and the eviction event, not the CPU graph. Then check QoS class and PriorityClass to see why that pod was selected. If memory is healthy, check the filesystem and the process count before assuming the node has enough of everything.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the condition that crossed its threshold: memory, disk, or PID.",
      "Free the resource or add capacity before replacing evicted pods.",
      "Set requests and limits so the workload has a predictable QoS class.",
      "Give critical workloads a PriorityClass and spread replicas across nodes.",
      "Bound ephemeral storage and rotate logs for disk pressure.",
      "Confirm replacements schedule and the node condition returns to healthy.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Guaranteed QoS protects a workload and reserves capacity whether or not it is used.",
      "A high PriorityClass protects critical pods and can evict lower-priority work during contention.",
      "Larger nodes improve packing and increase the blast radius of a single pressure event.",
      "Aggressive eviction thresholds protect the node sooner and can evict pods that would have recovered.",
      "Adding disk or memory buys time and hides growth until the next threshold.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "cpu-low-eviction",
    question:
      "Pods are being evicted from a node whose CPU is at 30%. What do you check, and why is CPU not the answer?",
    difficulty: 2,
    hints: [
      "Eviction is driven by node conditions.",
      "Memory and disk are not compressible.",
    ],
    answer:
      "I would check the node conditions first, especially MemoryPressure and DiskPressure, then the eviction events and the QoS class of the victims. CPU is compressible: the kernel throttles containers and the node does not need to evict pods to protect itself. Memory and disk are not, so the kubelet evicts when available memory or filesystem space crosses a threshold. I would also check whether a single workload grew or wrote a large amount of ephemeral data.",
    followUps: [
      "Which QoS class is evicted first?",
      "How does a PriorityClass change the outcome?",
      "What would you alert on before the first eviction?",
    ],
    redFlags: [
      "Blames CPU because the graph looks low.",
      "Restarts pods without checking the node condition.",
      "Ignores ephemeral storage.",
    ],
    rubric: [
      "Names the node conditions.",
      "Explains CPU compressibility.",
      "Checks QoS and priority.",
      "Proposes a resource-level fix.",
    ],
  },
  {
    id: "qos-order",
    question:
      "A node has BestEffort, Burstable, and Guaranteed pods. Under memory pressure, which are evicted first, and what does a PriorityClass change?",
    difficulty: 3,
    hints: [
      "Requests and limits define the QoS class.",
      "Priority changes ranking, not capacity.",
    ],
    answer:
      "BestEffort pods rank first because they have no requests or limits, so the kubelet has no minimum to honor. Next are Burstable pods, especially those using more than their requests. Guaranteed pods rank last because their requests equal their limits. A PriorityClass changes the ordering among pods, so a high-priority Burstable pod can outrank a lower-priority one. It does not create memory, and extreme pressure can still evict a high-priority pod.",
    followUps: [
      "How does usage above requests affect the ranking?",
      "When would a Guaranteed pod still be evicted?",
      "How would you protect a critical workload across nodes?",
    ],
    redFlags: [
      "Says Guaranteed pods are never evicted.",
      "Treats priority as a capacity guarantee.",
      "Ignores usage above requests.",
    ],
    rubric: [
      "Orders the QoS classes correctly.",
      "Explains the requests-versus-limits basis.",
      "Separates priority from capacity.",
      "Adds a topology or headroom measure.",
    ],
  },
  {
    id: "disk-pressure",
    question:
      "Memory is at 60% but a node reports DiskPressure and pods are evicted. What are the likely causes and the durable fix?",
    difficulty: 3,
    hints: [
      "Container logs and emptyDir live on the node.",
      "Images also consume nodefs or imagefs.",
    ],
    answer:
      "I would check nodefs and imagefs usage, the largest log and emptyDir consumers, and whether image garbage collection is keeping up. Common causes are verbose container logs, an emptyDir used as scratch space, and a large image churn. The durable fix is to bound ephemeral storage with requests and limits, rotate logs, clean up scratch data, and move large temporary workloads to a dedicated node pool. Deleting files once without a bound is only a temporary recovery.",
    followUps: [
      "How does an ephemeral-storage limit affect eviction?",
      "What is the difference between nodefs and imagefs?",
      "Why can a pod be evicted for using more ephemeral storage than its request?",
    ],
    redFlags: [
      "Assumes disk pressure means the application memory is fine so nothing is wrong.",
      "Clears disk without finding the growth.",
      "Ignores log volume.",
    ],
    rubric: [
      "Names nodefs and imagefs.",
      "Finds the growth source.",
      "Bounds ephemeral storage.",
      "Plans a durable fix.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every workload has requests and limits, and critical workloads have a PriorityClass.",
      "Replicas are spread across nodes rather than stacked on one.",
      "Ephemeral storage is bounded and logs are rotated.",
      "Alerts cover MemoryPressure, DiskPressure, and eviction counts, not only CPU.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the node condition and the eviction event first.",
      "Check QoS class, priority, and usage above requests for the victims.",
      "Free the resource or add capacity before replacing pods.",
      "Check that replacements can schedule on the remaining nodes.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Find what grew: memory, logs, images, or scratch data.",
      "Revisit requests, limits, and priority with peak usage in mind.",
      "Move batch or cache-heavy workloads to a dedicated pool.",
      "Test the eviction order with a controlled pressure scenario.",
    ],
  },
];

const references = [
  {
    title: "Node-pressure eviction",
    url: "https://kubernetes.io/docs/concepts/scheduling-eviction/node-pressure-eviction/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Memory, disk, and PID pressure, eviction thresholds, and the eviction order.",
  },
  {
    title: "Pod Quality of Service classes",
    url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Guaranteed, Burstable, and BestEffort classes and how requests and limits define them.",
  },
  {
    title: "Pod priority and preemption",
    url: "https://kubernetes.io/docs/concepts/scheduling-eviction/pod-priority-preemption/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "PriorityClass behavior and how priority influences scheduling and eviction ranking.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "node-pressure": {
      model: nodePressureModel,
      presets,
      instructions:
        "Start Healthy, then raise memory toward the threshold. Apply Memory and disk pressure to see eviction order, compare Disk pressure with healthy memory, and finish with Pressure relieved.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 90% thresholds, 40 pods, and 32% CPU baseline are teaching values; the Burstable share is a QoS proxy for pods using more than their requests, and real kubelet thresholds are configured per cluster.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["foundations-linux-memory", "containers-oom-kills", "kubernetes-incident-debug"],
};
