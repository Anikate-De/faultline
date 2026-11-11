import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NODE_CPU = 4_000;
const ZONES = ["A", "B", "C"];

const params: ParamSpec[] = [
  {
    id: "replicas",
    label: "Pods to schedule",
    min: 1,
    max: 20,
    step: 1,
    value: 6,
    unit: " pods",
    group: "Demand",
    help: "Pods the controller wants running. Each pod requests the CPU amount below.",
    format: "count",
  },
  {
    id: "podCpu",
    label: "CPU request per pod",
    min: 250,
    max: 2_000,
    step: 250,
    value: 500,
    unit: "m",
    group: "Demand",
    help: "The scheduler reserves this request, not the pod's peak usage. A larger request reduces the pods a node can hold.",
    format: "count",
  },
  {
    id: "nodeCount",
    label: "Worker nodes",
    min: 2,
    max: 7,
    step: 1,
    value: 4,
    unit: " nodes",
    group: "Cluster",
    help: "Nodes with 4,000 millicores of allocatable CPU each, spread across zones by index. The capacity is illustrative.",
    format: "count",
  },
  {
    id: "constraint",
    label: "Placement rule",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Placement",
    help: "0 is unconstrained, 1 requires zone A, 2 uses a dedicated taint without a toleration, 3 uses the same taint with a toleration.",
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

interface SchedNode {
  index: number;
  zone: string;
  blocked: boolean;
  reason: string;
  pods: number;
  cpu: number;
}

interface Computed {
  replicas: number;
  podCpu: number;
  nodeCount: number;
  constraint: number;
  nodes: SchedNode[];
  placed: number;
  pending: number;
  eligibleCount: number;
  blockedCount: number;
  allocPct: number;
  eligibleFree: number;
  blockedFree: number;
  stranded: number;
}

function place(replicas: number, podCpu: number, nodeCount: number, constraint: number): SchedNode[] {
  const nodes: SchedNode[] = Array.from({ length: nodeCount }, (_, index) => {
    const zone = ZONES[index % ZONES.length];
    const tainted = constraint >= 2 && index % 2 === 1;
    const affinityBlocked = constraint === 1 && zone !== "A";
    const blocked = tainted && constraint === 2 ? true : affinityBlocked;
    const reason = !blocked
      ? tainted && constraint === 3
        ? "taint tolerated"
        : ""
      : affinityBlocked
        ? "zone A required"
        : "NoSchedule taint";
    return { index, zone, blocked, reason, pods: 0, cpu: 0 };
  });
  const eligible = nodes.filter((node) => !node.blocked);
  let remaining = replicas;
  while (remaining > 0) {
    const candidates = eligible.filter((node) => node.cpu + podCpu <= NODE_CPU);
    if (candidates.length === 0) break;
    const chosen = candidates.reduce((best, node) => (node.cpu < best.cpu ? node : best));
    chosen.pods += 1;
    chosen.cpu += podCpu;
    remaining -= 1;
  }
  return nodes;
}

function compute(p: Params): Computed {
  const replicas = Math.round(clamp(num(p, "replicas", 6), 1, 20));
  const podCpu = Math.round(clamp(num(p, "podCpu", 500), 250, 2_000));
  const nodeCount = Math.round(clamp(num(p, "nodeCount", 4), 2, 7));
  const constraint = Math.round(clamp(num(p, "constraint", 0), 0, 3));
  const nodes = place(replicas, podCpu, nodeCount, constraint);
  const placed = nodes.reduce((sum, node) => sum + node.pods, 0);
  const eligible = nodes.filter((node) => !node.blocked);
  const eligibleCapacity = eligible.length * NODE_CPU;
  return {
    replicas,
    podCpu,
    nodeCount,
    constraint,
    nodes,
    placed,
    pending: replicas - placed,
    eligibleCount: eligible.length,
    blockedCount: nodes.length - eligible.length,
    allocPct: eligibleCapacity > 0 ? (placed * podCpu) / eligibleCapacity * 100 : 0,
    eligibleFree: eligibleCapacity - placed * podCpu,
    blockedFree: nodes.filter((node) => node.blocked).length * NODE_CPU,
    stranded: replicas - placed > 0 ? nodes.filter((node) => node.blocked).length * NODE_CPU : 0,
  };
}

function healthFor(value: number, warn: number, crit: number): Health {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function worst(values: Health[]): Health {
  const rank: Record<Health, number> = { ok: 0, warn: 1, crit: 2, down: 3 };
  return values.reduce<Health>((best, value) => (rank[value] > rank[best] ? value : best), "ok");
}

function buildFrame(values: Computed, seed: number): SimFrame {
  const workloadHealth = worst([
    healthFor(values.pending, 1, 3),
    healthFor(values.allocPct, 75, 90),
    healthFor(values.stranded, 1, 4_000),
  ]);
  const nodes: SimNode[] = values.nodes.map((node) => {
    const utilPct = node.cpu / NODE_CPU * 100;
    return {
      id: `node-${node.index}`,
      label: `node-${String.fromCharCode(97 + node.index)}`,
      kind: "service",
      role: "instance",
      health: node.blocked ? "warn" : utilPct >= 75 ? "warn" : "ok",
      utilization: clamp(utilPct / 100),
      capacity: NODE_CPU,
      sublabel: `zone ${node.zone} · ${node.pods} pods · ${Math.round(utilPct)}%`,
      detail: node.blocked
        ? `The scheduler removes this node before scoring: ${node.reason}. Its ${NODE_CPU.toLocaleString()}m of free CPU is not usable by this pod.`
        : `Zone ${node.zone}. ${node.pods} pods are placed, using ${node.cpu.toLocaleString()}m of ${NODE_CPU.toLocaleString()}m.${node.reason ? ` ${node.reason}.` : ""}`,
      meta: { view: "flow", zone: node.zone, pods: node.pods, blocked: node.blocked ? 1 : 0 },
    };
  });
  return {
    t: 0,
    nodes: [
      {
        id: "workload",
        label: "checkout pods",
        kind: "service",
        health: workloadHealth,
        utilization: clamp(values.allocPct / 100),
        sublabel: `${values.placed} of ${values.replicas} placed · ${values.pending} Pending`,
        detail: `The controller wants ${values.replicas} pods at ${values.podCpu}m each. ${values.pending} cannot be placed because no node passes every filter and has enough allocatable CPU.`,
        meta: { view: "flow" },
      },
      ...nodes,
    ],
    edges: values.nodes.map((node) =>
      edge(
        `workload-node-${node.index}`,
        "workload",
        `node-${node.index}`,
        values.replicas > 0 ? node.pods / values.replicas : 0,
        node.blocked ? "warn" : node.cpu / NODE_CPU >= 0.75 ? "warn" : "ok",
      ),
    ),
    metrics: [
      metric("pending", "Pending pods", values.pending, "", 1, 3, "count"),
      metric("alloc-cpu", "Allocatable CPU used", values.allocPct, "%", 75, 90, "percent"),
      metric("blocked-free-cpu", "Free CPU on filtered nodes", values.blockedFree, "m", undefined, undefined, "count"),
      metric("stranded-cpu", "Stranded CPU behind filters", values.stranded, "m", 1, 4_000, "count"),
      metric("eligible-free-cpu", "Free CPU on eligible nodes", values.eligibleFree, "m", undefined, undefined, "count"),
      metric("eligible-nodes", "Eligible nodes", values.eligibleCount, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, constraint: values.constraint, nodeCount: values.nodeCount },
    summary: `${values.placed} of ${values.replicas} pods placed; ${values.pending} Pending; ${values.blockedFree.toLocaleString()}m free on nodes excluded by placement rules.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 5)) / 2.4);
  const entries: [string, number, number][] = [
    ["pending", values.pending, 0],
    ["alloc-cpu", values.allocPct, 0.4],
    ["blocked-free-cpu", values.blockedFree, 0],
    ["stranded-cpu", values.stranded, 0],
    ["eligible-free-cpu", values.eligibleFree, 0],
    ["eligible-nodes", values.eligibleCount, 0],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.5) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pending",
    metricId: "pending",
    warn: 1,
    crit: 3,
    title: "Pods are Pending while capacity exists",
    cause:
      "The scheduler removes nodes that fail a filter before it scores the remaining capacity. A taint without a toleration, a node affinity rule, or a topology constraint can leave fewer valid nodes than the pod count requires.",
    fix:
      "Read the scheduler event for the reason, count the nodes that pass every filter, and compare their free CPU with the pod request. Add capacity in the required zone, add the matching toleration, or relax the rule that the workload does not need.",
    checkFirst: [
      "Describe the pod and read the FailedScheduling event, including the filter that rejected each node.",
      "Compare the pod request with allocatable CPU on nodes that match affinity and taints.",
      "Check whether a topology or pod anti-affinity rule limits how many pods can share a node.",
    ],
  },
  {
    id: "alloc-cpu",
    metricId: "alloc-cpu",
    warn: 75,
    crit: 90,
    title: "Eligible nodes are running out of allocatable CPU",
    cause:
      "Requests, not observed usage, consume allocatable CPU. A fleet can show low real utilization and still be full for scheduling because every pod has reserved the difference.",
    fix:
      "Right-size the requests from measured usage, add nodes in the eligible set, or reduce the pod count. Raising a limit does not create schedulable room; the request is what the scheduler reserves.",
    checkFirst: [
      "Compare requested CPU with actual usage per node.",
      "Check for a DaemonSet or sidecar request that is charged to every pod.",
      "Check whether the node count changed and whether new nodes match the placement rules.",
    ],
  },
  {
    id: "stranded-cpu",
    metricId: "stranded-cpu",
    warn: 1,
    crit: 4_000,
    title: "Pods are Pending while filtered nodes hold free CPU",
    cause:
      "Taints and affinity divide the cluster into pools. When the workload has no toleration for a tainted pool, or requires a label that only some nodes carry, the free capacity in the other pool is invisible to it. The stranded metric is zero unless at least one pod is Pending, so filtered capacity alone does not raise this alert.",
    fix:
      "Decide whether the pool boundary is intentional. If it is, add capacity to the workload's pool. If it is not, add the toleration or remove the affinity rule, then confirm the pod schedules without violating the isolation the pool was built for.",
    checkFirst: [
      "List node labels and taints for every node, including the nodes that look free.",
      "Check the pod tolerations and node affinity, not only its resource requests.",
      "Check whether a recent change added a taint or changed a node pool label.",
    ],
  },
];

function defaultsFor(id: string): Params {
  if (id === "failure") return defaults({ replicas: 12, podCpu: 1_000, nodeCount: 4, constraint: 2 });
  if (id === "peak") return defaults({ replicas: 14, podCpu: 1_000, nodeCount: 4, constraint: 0 });
  if (id === "toleration") return defaults({ replicas: 12, podCpu: 1_000, nodeCount: 4, constraint: 3 });
  if (id === "recovery") return defaults({ replicas: 10, podCpu: 500, nodeCount: 4, constraint: 0 });
  return defaults();
}

export const schedulingModel: SimModel = {
  id: "kubernetes-scheduling",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.summary = `${values.placed} of ${values.replicas} pods placed; ${values.pending} Pending; ${values.blockedFree.toLocaleString()}m free on nodes excluded by placement rules.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const reasons = [...new Set(values.nodes.filter((node) => node.blocked).map((node) => node.reason))];
    return [
      `${values.placed} of ${values.replicas} pods are placed. ${values.pending > 0 ? `${values.pending} stay Pending because no candidate passes every filter and has ${values.podCpu}m free.` : "Every pod found a valid node."}`,
      `${values.eligibleCount} of ${values.nodeCount} nodes pass the placement filters. ${values.blockedCount > 0 ? `The excluded nodes hold ${values.blockedFree.toLocaleString()}m of free CPU.` : "No node is excluded by taints or affinity."}`,
      values.pending > 0 && values.blockedFree > 0
        ? `${values.blockedFree.toLocaleString()}m is stranded behind filters while ${values.pending} pod${values.pending === 1 ? " is" : "s are"} Pending. Filtered capacity without a Pending pod is waste, not an incident.`
        : "Filtered capacity is not by itself an incident. A Pending pod is what turns it into stranded capacity.",
      `Allocatable CPU on eligible nodes is ${values.allocPct.toFixed(1)}% requested. Requested CPU is what scheduling consumes, even when the processes use less.`,
      reasons.length > 0
        ? `Blocking filters in play: ${reasons.join("; ")}. A node can be healthy and still be an invalid candidate.`
        : "The pod has no taint or affinity restriction in this scenario; capacity is the only filter left.",
    ];
  },
  legend: [
    { label: "Schedulable", tone: "ok" },
    { label: "Filtered or full", tone: "warn" },
    { label: "Pods Pending", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Six small pods fit across four unconstrained nodes.",
    tone: "ok",
    params: defaultsFor("healthy"),
  },
  {
    id: "peak",
    label: "High request",
    description: "Large requests fill most of the allocatable CPU but every pod still places.",
    tone: "warn",
    params: defaultsFor("peak"),
  },
  {
    id: "failure",
    label: "Tainted pool",
    description: "Half the nodes carry a taint the pod does not tolerate. Eight pods place; four stay Pending.",
    tone: "crit",
    params: defaultsFor("failure"),
  },
  {
    id: "toleration",
    label: "Toleration added",
    description: "The same tainted nodes become eligible once the pod tolerates the taint.",
    tone: "warn",
    params: defaultsFor("toleration"),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Smaller requests and no placement rule return every pod to a node.",
    tone: "ok",
    params: defaultsFor("recovery"),
  },
];

const experiment: Experiment = {
  id: "predict-affinity",
  title: "Predict what adding nodes does for a zone-pinned workload",
  simId: "scheduling",
  question:
    "Twelve 1,000m pods require zone A. The cluster has four nodes across three zones. Which change actually gives every pod a valid node?",
  prediction: {
    options: [
      { id: "replicas", label: "Increase the replica count so the scheduler has more choices" },
      { id: "rule", label: "Remove the zone A requirement or add zone A nodes" },
      { id: "request", label: "Raise the CPU request so fewer pods share a node" },
      { id: "restart", label: "Restart the scheduler" },
    ],
    correctOptionId: "rule",
    explanation:
      "Zone affinity filters out every node outside zone A before capacity is scored. Two nodes in zone A provide eight slots for twelve pods, so four remain Pending. More replicas or larger requests add pressure; restarting the scheduler changes nothing. The fix is to widen the eligible node set or add capacity inside the required zone.",
  },
  setup: defaults({ replicas: 12, podCpu: 1_000, nodeCount: 4, constraint: 1 }),
  runFor: 20,
  observe: [
    "Two of four nodes are in zone A, so the cluster has two valid candidates with eight total slots.",
    "Four pods stay Pending even though the other zones have idle CPU.",
    "Free CPU on filtered nodes is 8,000m while the eligible nodes are fully requested.",
    "Adding nodes outside zone A does not change the eligible set.",
  ],
  explain:
    "The scheduler runs filters first and scoring second. Node affinity and taints are filters: a node that fails one is removed, and its free CPU never enters the score. Capacity planning that counts every core in the cluster overstates the capacity this pod can use. The correct denominator is the allocatable CPU on nodes that pass every filter.",
  fix: defaults({ replicas: 12, podCpu: 750, nodeCount: 4, constraint: 0 }),
  debrief:
    "Removing the zone restriction and reducing the request lets all twelve pods fit. The cluster did not gain a node; the eligible set grew. That is the distinction to carry into an incident: a Pending pod is a statement about valid candidates, not a statement about total free CPU.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Kubernetes scheduler assigns a pod to a node. It does not run the pod; the kubelet on the chosen node does. For each pod, the scheduler filters the node list with predicates such as resource requests, node affinity, taints and tolerations, and topology rules, then scores the remaining nodes and picks one. A pod that passes no filter stays in the Pending phase and emits a FailedScheduling event.",
  },
  {
    type: "p",
    text: "A resource request is the CPU or memory the scheduler reserves for a container. A node can have idle cores and still reject a pod whose request exceeds its allocatable CPU after other pods have reserved theirs. Taints mark a node as unsuitable unless the pod carries a matching toleration. Node affinity requires a label on the node. Tolerations permit a taint; they do not attract a pod to a node. Those are different controls and they fail differently.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Scheduling sits between the controller that creates pods and the kubelet that starts containers. The Deployment or StatefulSet controller creates the pod and the scheduler decides where it goes. A pod can be Pending because the controller asked for too many replicas, because requests do not fit, because every matching node is tainted, or because a topology rule cannot be satisfied. The event message names the filter; the cluster summary does not.",
  },
  {
    type: "table",
    headers: ["Signal", "What it tells you", "What it cannot tell you"],
    rows: [
      ["Pod phase Pending", "No node has been assigned", "Which filter rejected the candidates"],
      ["FailedScheduling event", "The reason from the last scheduling attempt", "Whether the request is realistic"],
      ["Allocatable CPU", "Capacity the scheduler may reserve", "Whether a taint or label removes the node"],
      ["Node utilization", "CPU currently consumed", "Requests already reserved by other pods"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Free CPU",
    rightTitle: "Schedulable CPU",
    rows: [
      { label: "Question", left: "How much is idle right now?", right: "How much can this pod reserve?" },
      { label: "Counts taints", left: "No", right: "Yes, unless tolerated" },
      { label: "Counts affinity", left: "No", right: "Yes, labels must match" },
      { label: "Counts requests", left: "Only observed usage", right: "Yes, reservations consume capacity" },
    ],
  },
  {
    type: "p",
    text: "This module models seven nodes at most, each with 4,000 millicores of allocatable CPU, spread across three zones by index. The capacity and pod sizes are illustrative teaching values. The lesson is the filter order: a node that fails a taint or affinity check is removed before its free capacity matters.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pending pods and the eligible node count for the current placement rule.",
      "Free CPU on nodes the scheduler accepted, and free CPU on nodes it filtered out.",
      "Each node's zone, pod count, and requested CPU, so a healthy but ineligible node is visible.",
      "Allocatable CPU used on eligible nodes, which can be high while total cluster CPU is low.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that every node is eligible. Apply Tainted pool: half the nodes keep free CPU while pods go Pending. Compare the two free-CPU metrics, then apply Toleration added to see the eligible set grow without adding hardware. Run the experiment before revealing the explanation.",
  },
  { type: "sim", simId: "scheduling" },
  {
    type: "p",
    text: "Read a Pending pod from the bottom up. Start with the event, identify the filter, then count the nodes that pass it and compare their allocatable CPU with the request. Adding replicas or raising limits does not help a pod that has no valid candidate. The useful question is not how much CPU the cluster has, but how much CPU this pod can reach.",
  },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The tainted pool removed half the nodes from consideration. The scheduler placed eight pods on the eligible nodes, filled their allocatable CPU, and left four pods Pending. The filtered nodes still had 8,000 millicores free, so a cluster dashboard that summed all free CPU would report spare capacity that the workload could not use. Adding the toleration made those nodes eligible and the pods placed without any new hardware.",
  },
  {
    type: "p",
    text: "The zone-affinity experiment showed the same mechanism with a different filter. Two zone A nodes provided eight slots, the other zones were filtered out, and four of twelve pods stayed Pending. Removing the rule widened the candidate set. In both cases the incident was a placement mismatch, not a capacity shortage in the ordinary sense.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "kubectl describe pod: a FailedScheduling event naming the filter and the nodes it rejected.",
      "kubectl get nodes with labels, taints, allocatable CPU, and the pods already assigned.",
      "Scheduler metrics: pending pods, scheduling attempts, and latency by result.",
      "Cluster autoscaler events, which can add nodes that still do not match the pod's placement rules.",
      "Deployment status: replicas desired, updated, available, and unavailable, which shows whether the shortfall is placement or readiness.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the FailedScheduling event before changing anything. Then count the nodes that pass the named filter and compare their allocatable CPU with the pod request. Check taints and tolerations together, then node affinity and topology rules. Only after those filters are cleared does total free CPU become a useful number.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Capture the scheduler event and the exact filter that rejected the candidates.",
      "List the nodes that pass every filter, not every node in the cluster.",
      "Compare allocatable CPU on that subset with the number of pods and their requests.",
      "Decide whether the pool boundary is intentional before adding a toleration or removing affinity.",
      "Add capacity inside the required zone or pool, or right-size the request if the reservation is inflated.",
      "Confirm the Deployment or StatefulSet reaches its desired replica count, then remove the temporary workaround.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A toleration is fast but can place a workload on a node the pool owner reserved for another purpose.",
      "Removing affinity improves placement but can move latency-sensitive pods away from their data.",
      "Larger nodes reduce fragmentation but make one pod's request a larger share of the failure domain.",
      "A dedicated node pool protects noisy neighbors but lowers the capacity available to everyone else.",
      "Adding nodes outside the workload's zone does not fix a zone-pinned workload and adds cost.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "pending-free-cpu",
    question:
      "A pod is Pending and the cluster shows 40% free CPU. How do you find the constraint?",
    difficulty: 2,
    hints: [
      "Start with the scheduler event, not the cluster average.",
      "Free CPU is not the same as allocatable CPU on a valid node.",
    ],
    answer:
      "I describe the pod and read the FailedScheduling event to see which filter rejected each node. Then I list the nodes that pass the pod's taints, tolerations, node affinity, and topology rules, and compare their allocatable CPU with the pod request and the existing reservations. The cluster average includes nodes the pod cannot use, so I only trust capacity on the eligible set. If no node passes a filter, I decide whether the rule is intentional before relaxing it.",
    followUps: [
      "What is the difference between a taint and node affinity?",
      "How do requests differ from limits for scheduling?",
      "What would a cluster autoscaler do in this situation?",
    ],
    redFlags: [
      "Adds replicas without reading the event.",
      "Trusts total free CPU.",
      "Removes a taint before asking who owns the pool.",
    ],
    rubric: [
      "Starts from the scheduler event.",
      "Separates eligible capacity from total capacity.",
      "Names the filters correctly.",
      "Checks whether the rule is intentional.",
    ],
  },
  {
    id: "taint-toleration",
    question:
      "A node has a NoSchedule taint and the pod has a matching toleration but still does not land there. Why?",
    difficulty: 2,
    hints: [
      "A toleration permits a taint; it does not select a node.",
      "Look at affinity, capacity, and other filters.",
    ],
    answer:
      "A toleration only makes the node acceptable. It does not attract the pod. The node still has to pass affinity, topology, and resource filters, and the scheduler may prefer another eligible node during scoring. I would check whether the pod has a node affinity or node selector that excludes this node, whether the allocatable CPU after other requests can fit this pod, and whether a topology spread rule prevents another pod from landing there. If the intent is to pin the workload to the tainted pool, add a node affinity or node selector for that pool rather than relying on the toleration.",
    followUps: [
      "How would you express a preference for the dedicated pool?",
      "What happens to a running pod if the taint is added later?",
      "Which taint effect would evict a running pod?",
    ],
    redFlags: [
      "Thinks a toleration is a node selector.",
      "Ignores resource requests.",
      "Suggests removing the taint without understanding the pool.",
    ],
    rubric: [
      "Distinguishes toleration from selection.",
      "Checks affinity and capacity.",
      "Mentions scoring and topology.",
      "Offers a pinning mechanism.",
    ],
  },
  {
    id: "requests-inflated",
    question:
      "Nodes show 30% CPU usage but the scheduler says they are full. What is happening?",
    difficulty: 2,
    hints: [
      "The scheduler reserves requests, not observed usage.",
      "A sidecar or DaemonSet may be charging CPU to every node.",
    ],
    answer:
      "Scheduling capacity is consumed by requests. If the sum of pod requests is near allocatable CPU, the node has no room for another request even when the processes use much less. I would compare requested CPU with actual usage per node, then find the largest requests and any DaemonSet or sidecar that adds a request to every pod. The fix is to right-size requests from measured usage, not to raise limits or add nodes blindly. I would also check whether a recent deployment changed requests and left the old pods terminating.",
    followUps: [
      "How would you measure the right request size?",
      "What is the risk of setting requests too low?",
      "Why do limits not create scheduling room?",
    ],
    redFlags: [
      "Concludes the scheduler is broken.",
      "Confuses usage with reservations.",
      "Raises limits to fix scheduling.",
    ],
    rubric: [
      "Explains request-based accounting.",
      "Proposes comparing requests with usage.",
      "Mentions sidecars or DaemonSets.",
      "Notes the risk of under-requesting.",
    ],
  },
  {
    id: "topology-spread",
    question:
      "You need three replicas spread across zones without pinning them to one zone. Which mechanism do you use?",
    difficulty: 3,
    hints: [
      "Affinity can require or prefer; topology spread controls distribution.",
      "Consider what happens when a zone is lost.",
    ],
    answer:
      "I would use topology spread constraints with the zone topology key and a maxSkew, plus a pod anti-affinity rule if I need to prevent two replicas from sharing a node. Node affinity with a single zone label would pin every replica to that zone, which is the opposite of spreading. I would also make sure the nodes carry the standard zone label and that the scheduler can satisfy maxSkew after a zone failure. If the requirement is only a preference, the scheduler can still place pods when the constraint cannot be met; a hard constraint can leave pods Pending. I would test both the normal case and a zone loss.",
    followUps: [
      "What does maxSkew control?",
      "When would you use required versus preferred affinity?",
      "How does the scheduler treat a missing zone label?",
    ],
    redFlags: [
      "Pins all replicas to one zone.",
      "Uses a toleration as a spreading mechanism.",
      "Ignores what happens after a zone failure.",
    ],
    rubric: [
      "Chooses topology spread.",
      "Explains maxSkew and topology key.",
      "Distinguishes hard and soft rules.",
      "Tests the failure case.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every workload has requests sized from measured usage, not from node capacity.",
      "Taints and tolerations are documented with the pool owner and the workload that needs it.",
      "Affinity and topology rules are tested against a missing zone or label.",
      "Dashboards show allocatable CPU on eligible nodes, not only total cluster free CPU.",
      "Pending pods and FailedScheduling events are part of the first-response dashboard.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Read the scheduler event and name the filter before changing the manifest.",
      "Count valid nodes and compare their allocatable CPU with the request.",
      "Check whether the Pending pods are part of a rollout or a steady-state workload.",
      "Decide whether the pool boundary is intentional before adding a toleration.",
      "Record whether capacity, affinity, or a taint caused the placement failure.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove temporary tolerations or affinity exceptions and document any that remain.",
      "Right-size requests that were inflated, with a measured percentile as evidence.",
      "Add a test that schedules the workload into each supported zone.",
      "Review whether the autoscaler can add nodes that match the placement rules.",
    ],
  },
];

const references = [
  {
    title: "Kubernetes Scheduler",
    url: "https://kubernetes.io/docs/concepts/scheduling-eviction/kube-scheduler/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Filtering and scoring, and how the scheduler selects a node.",
  },
  {
    title: "Assigning Pods to Nodes",
    url: "https://kubernetes.io/docs/concepts/scheduling-eviction/assign-pod-node/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Node affinity, node selectors, and pod affinity rules.",
  },
  {
    title: "Taints and Tolerations",
    url: "https://kubernetes.io/docs/concepts/scheduling-eviction/taint-and-toleration/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Taint effects, tolerations, and dedicated node pools.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    scheduling: {
      model: schedulingModel,
      presets,
      instructions:
        "Start Healthy, then apply Tainted pool. Compare free CPU on eligible nodes with free CPU on filtered nodes. Add the toleration before you try Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 4,000m node size and pod requests are teaching values, not a cluster sizing rule.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-requests-limits",
    "containers-placement",
    "foundations-failure-domains",
    "kubernetes-pdb",
  ],
};
