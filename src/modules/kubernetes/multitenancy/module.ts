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

const CLUSTER_CORES = 16;
const TEAM_A_REPLICAS = 6;

const params: ParamSpec[] = [
  {
    id: "teamBReplicas",
    label: "Team B replicas",
    min: 2,
    max: 30,
    step: 1,
    value: 4,
    unit: " pods",
    group: "Team B",
    help: "The noisy team's pod count. Each pod is modeled as one core of demand. Team A is fixed at six pods.",
    format: "count",
  },
  {
    id: "quotaCores",
    label: "ResourceQuota per team",
    min: 0,
    max: 16,
    step: 1,
    value: 6,
    unit: " cores",
    group: "Isolation",
    help: "Aggregate CPU requests each namespace may consume. 0 means no ResourceQuota is applied, so the namespace can claim the whole cluster.",
    format: "count",
  },
  {
    id: "limitRange",
    label: "LimitRange sets defaults",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Isolation",
    help: "1 means admission adds a default CPU request to pods that omit one, so the scheduler can account for them. 0 allows pods with no request to overcommit.",
    format: "count",
  },
  {
    id: "networkPolicy",
    label: "Cross-namespace NetworkPolicy",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Isolation",
    help: "1 applies a default-deny policy and allows only the intended namespace traffic. 0 leaves the default allow behavior in place.",
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
  teamBReplicas: number;
  quotaCores: number;
  limitRangeOn: boolean;
  networkPolicyOn: boolean;
  admittedB: number;
  reservedB: number;
  admittedA: number;
  pendingA: number;
  cpuShareA: number;
  contention: number;
  crossNamespaceRps: number;
  isolationGap: number;
  clusterUtilization: number;
  p99: number;
}

function compute(p: Params): Values {
  const teamBReplicas = Math.round(clamp(num(p, "teamBReplicas", 4), 2, 30));
  const quotaCores = Math.round(clamp(num(p, "quotaCores", 6), 0, 16));
  const limitRangeOn = num(p, "limitRange", 1) >= 1;
  const networkPolicyOn = num(p, "networkPolicy", 1) >= 1;
  const admittedB = Math.min(teamBReplicas, quotaCores > 0 ? quotaCores : CLUSTER_CORES);
  const reservedB = limitRangeOn ? admittedB : 0;
  const admittedA = Math.min(TEAM_A_REPLICAS, Math.max(0, CLUSTER_CORES - reservedB));
  const pendingA = TEAM_A_REPLICAS - admittedA;
  const availableForA = Math.max(0, CLUSTER_CORES - admittedB);
  const cpuShareA = admittedA === 0 ? 0 : clamp(availableForA / TEAM_A_REPLICAS, 0, 1);
  const contention = admittedA === 0 ? 0 : Math.round((1 - cpuShareA) * 100);
  const crossNamespaceRps = networkPolicyOn ? 0 : 400;
  const isolationGap = (quotaCores > 0 ? 0 : 40) + (limitRangeOn ? 0 : 25) + (networkPolicyOn ? 0 : 35);
  const clusterUtilization = (admittedA + admittedB) / CLUSTER_CORES;
  const p99 =
    60 +
    Math.max(0, clusterUtilization - 0.8) * 2_000 +
    pendingA * 100 +
    (limitRangeOn ? 0 : 100);
  return {
    teamBReplicas,
    quotaCores,
    limitRangeOn,
    networkPolicyOn,
    admittedB,
    reservedB,
    admittedA,
    pendingA,
    cpuShareA,
    contention,
    crossNamespaceRps,
    isolationGap,
    clusterUtilization,
    p99,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const teamAHealth: Health =
    values.pendingA > 0 || values.contention >= 50
      ? "crit"
      : values.contention >= 20
        ? "warn"
        : "ok";
  const teamBHealth: Health =
    values.admittedB / CLUSTER_CORES >= 1
      ? "crit"
      : values.admittedB / CLUSTER_CORES >= 0.75
        ? "warn"
        : "ok";
  const clusterHealth = healthFor(values.clusterUtilization * 100, 80, 100);
  const networkHealth: Health =
    values.crossNamespaceRps > 200 ? "crit" : values.crossNamespaceRps > 0 ? "warn" : "ok";
  const nodes: SimNode[] = [
    {
      id: "team-a",
      label: "Team A namespace",
      kind: "service",
      health: teamAHealth,
      utilization: values.admittedA === 0 ? 0 : clamp(1 - values.cpuShareA),
      sublabel: `${values.admittedA} of ${TEAM_A_REPLICAS} pods placed`,
      detail:
        "Team A is the quieter tenant in this model. Its pods need six cores. Without a quota and a default request, the scheduler cannot see how much Team B will consume, so Team A can arrive to find no room.",
      meta: { view: "flow" },
    },
    {
      id: "team-b",
      label: "Team B namespace",
      kind: "service",
      health: teamBHealth,
      utilization: clamp(values.teamBReplicas / CLUSTER_CORES),
      sublabel: `${values.admittedB} pods admitted`,
      detail:
        "Team B is the noisy tenant. A ResourceQuota caps the aggregate requests it can create; without one, its pods can claim the whole cluster. A LimitRange makes sure every pod has a request the scheduler can count.",
      meta: { view: "flow" },
    },
    {
      id: "quota",
      label: "ResourceQuota",
      kind: "service",
      health: values.quotaCores > 0 ? "ok" : "warn",
      utilization: values.quotaCores > 0 ? clamp(values.teamBReplicas / values.quotaCores) : 1,
      sublabel: values.quotaCores > 0 ? `${values.quotaCores} cores per team` : "not applied",
      detail:
        "A ResourceQuota is enforced by admission at create time. It limits the sum of requests in a namespace, not the runtime usage of a pod that already exists. A pod can still use more than its request if the limit allows it.",
      meta: { view: "flow" },
    },
    {
      id: "cluster",
      label: "Cluster capacity",
      kind: "service",
      health: clusterHealth,
      utilization: clamp(values.clusterUtilization),
      sublabel: `${Math.round(values.clusterUtilization * 100)}% of ${CLUSTER_CORES} cores`,
      detail:
        "The cluster is shared. Namespaces do not partition CPU or memory by themselves. Isolation comes from quotas, default requests, limit ranges, and the scheduler's view of reserved capacity.",
      meta: { view: "flow" },
    },
    {
      id: "network",
      label: "NetworkPolicy",
      kind: "mesh",
      health: networkHealth,
      utilization: values.networkPolicyOn ? 0.2 : 1,
      sublabel: values.networkPolicyOn ? "cross-namespace denied" : "cross-namespace allowed",
      detail:
        "A NetworkPolicy selects pods and declares allowed ingress or egress. The default is allow when no policy selects a pod, and a policy only takes effect if the CNI implements it.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("team-a-cluster", "team-a", "cluster", clamp((values.admittedA / CLUSTER_CORES) * 10), teamAHealth, "requests"),
      edge("team-b-cluster", "team-b", "cluster", clamp((values.admittedB / CLUSTER_CORES) * 10), teamBHealth, "requests"),
      edge("quota-team-b", "quota", "team-b", values.quotaCores > 0 ? 1 : 0.3, values.quotaCores > 0 ? "ok" : "warn", "admits"),
      edge("network-team-a", "network", "team-a", values.networkPolicyOn ? 0.1 : 1, networkHealth, "filters"),
    ],
    metrics: [
      metric("team-a-pending", "Team A pods Pending", values.pendingA, " pods", 1, 3, "count"),
      metric("cpu-contention", "Team A CPU contention", values.contention, "%", 20, 50, "percent"),
      metric("cross-namespace-rps", "Cross-namespace traffic", values.crossNamespaceRps, " rps", 1, 100, "rps"),
      metric("isolation-gap", "Isolation gap", values.isolationGap, "", 30, 60, "number"),
      metric("p99", "Team A request p99", values.p99, "ms", 200, 500, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Team A has ${values.admittedA} of ${TEAM_A_REPLICAS} pods placed; Team B requested ${values.teamBReplicas} cores, ${values.admittedB} admitted${
      values.quotaCores > 0 ? ` under a ${values.quotaCores} core quota` : " with no quota"
    }; cross-namespace traffic ${values.crossNamespaceRps} rps.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * 0.02 * Math.sin((index + (seed % 5)) / 3.4);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "team-a-pending",
    metricId: "team-a-pending",
    warn: 1,
    crit: 3,
    title: "One team's pods cannot schedule on the shared cluster",
    cause:
      "Team B consumed the cluster's schedulable capacity first. Without a ResourceQuota, nothing caps the aggregate requests one namespace can create. Without a LimitRange, pods without requests are invisible to the scheduler until they contend at runtime.",
    fix:
      "Apply a ResourceQuota per team, add a LimitRange that sets default requests, and size the quotas so the sum plus headroom fits the cluster. If the teams need hard isolation, move them to separate node pools or clusters.",
    checkFirst: [
      "Check the Pending pod's scheduler event and the node's allocatable resources.",
      "Check the ResourceQuota and LimitRange in the waiting team's namespace.",
      "Check which namespace owns the largest requests and whether they were admitted before the wait.",
    ],
  },
  {
    id: "cpu-contention",
    metricId: "cpu-contention",
    warn: 20,
    crit: 50,
    title: "A team is getting less CPU than its pods need",
    cause:
      "The pods are placed, but the node is oversubscribed. Without requests, the scheduler cannot reserve capacity, and the kernel shares the CPU under contention. This is the noisy-neighbor failure that a namespace alone does not prevent.",
    fix:
      "Set requests and limits, apply a LimitRange so every pod has a default, and use a ResourceQuota to bound the total. For latency-sensitive workloads, add priority or a dedicated node pool.",
    checkFirst: [
      "Compare each team's requested CPU with its actual usage.",
      "Check whether pods have requests or are BestEffort.",
      "Check the node's CPU throttling and the per-pod cgroup stats.",
    ],
  },
  {
    id: "cross-namespace-rps",
    metricId: "cross-namespace-rps",
    warn: 1,
    crit: 100,
    title: "Traffic is crossing a namespace boundary that should be closed",
    cause:
      "No NetworkPolicy selects the destination pods, so the default allow behavior permits traffic from every namespace. A namespace name is not a network boundary, and a policy only works if the CNI enforces it.",
    fix:
      "Apply a default-deny NetworkPolicy in the namespace, then allow only the required sources and ports. Confirm the CNI supports NetworkPolicy and test with a pod in another namespace.",
    checkFirst: [
      "List the NetworkPolicies in the source and destination namespaces.",
      "Check whether any policy selects the destination pods and what it allows.",
      "Verify the CNI implements NetworkPolicy and test the connection.",
    ],
  },
  {
    id: "isolation-gap",
    metricId: "isolation-gap",
    warn: 30,
    crit: 60,
    title: "The namespace lacks the controls that make it a tenant boundary",
    cause:
      "Namespaces organize object names and default service accounts. They do not cap CPU or memory, do not set default requests, and do not block network traffic. Quotas, LimitRanges, NetworkPolicies, and admission fill those gaps.",
    fix:
      "Add the missing controls one at a time: quota, limit range, network policy, and RBAC. For hostile tenants, a namespace is still not a security boundary; use separate clusters or nodes.",
    checkFirst: [
      "Inventory the quota, limit range, and network policy in the namespace.",
      "Check whether the namespace has a default deny policy and a default ServiceAccount with no extra permissions.",
      "Decide whether the tenants are trusted or hostile.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 200,
    crit: 500,
    title: "The noisy neighbor is visible in Team A's latency",
    cause:
      "CPU contention, pending pods, or an unbounded cross-namespace dependency raises Team A's tail latency. The cluster may still look healthy in aggregate because Team B is using the capacity productively.",
    fix:
      "Restore the missing isolation control, then confirm Team A's latency returns to baseline. Reducing Team B's replicas is a temporary mitigation; the quota is the durable fix.",
    checkFirst: [
      "Split latency by namespace and pod.",
      "Correlate the rise with Team B's deployment or a quota change.",
      "Check whether Team A is missing replicas because pods are Pending.",
    ],
  },
];

export const multitenancyModel: SimModel = {
  id: "kubernetes-multitenancy",
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
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * jitter) } : item,
    );
    next.flags = {
      ...frame.flags,
      ...next.flags,
      elapsed: Math.max(0, Number(frame.flags.elapsed ?? 0)) + Math.max(0, dt),
      paramsKey: JSON.stringify(p),
    };
    if (values.pendingA > 0 && frame.flags.pendingEvent !== 1) {
      pushEvent(next, {
        id: "team-a-pending",
        severity: "crit",
        title: "Team A pods are Pending on the shared cluster",
        detail: `${values.admittedA} of ${TEAM_A_REPLICAS} Team A pods are placed. Team B has ${values.admittedB} pods admitted with a ${values.quotaCores} core quota.`,
        nodeId: "team-a",
        metricId: "team-a-pending",
      });
      next.flags.pendingEvent = 1;
    }
    if (values.pendingA === 0) next.flags.pendingEvent = 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines = [
      `Team A is fixed at ${TEAM_A_REPLICAS} pods needing one core each. Team B requests ${values.teamBReplicas} cores; ${values.admittedB} are admitted.`,
      values.quotaCores > 0
        ? `The ${values.quotaCores} core quota caps Team B's aggregate requests. It does not cap Team A unless Team A has its own quota.`
        : "No ResourceQuota is applied, so Team B can claim the whole cluster before Team A schedules.",
      values.limitRangeOn
        ? "A LimitRange supplies default requests, so the scheduler can account for every pod."
        : "Without a LimitRange, pods with no requests are invisible to the scheduler and can overcommit the node at runtime.",
      values.networkPolicyOn
        ? "Cross-namespace traffic is denied by policy. A namespace is still not a security boundary for hostile tenants."
        : "No policy selects the destination pods, so cross-namespace traffic is allowed by default.",
    ];
    return lines;
  },
  legend: [
    { label: "Isolated within the shared cluster", tone: "ok" },
    { label: "Missing one control", tone: "warn" },
    { label: "Contention or cross-tenant traffic", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Each team has a quota, a LimitRange supplies requests, and cross-namespace traffic is denied.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Growing noisy tenant",
    description: "Team B grows to eight pods under no quota; the cluster is busy but Team A still fits.",
    tone: "warn",
    params: defaults({ teamBReplicas: 8, quotaCores: 0, limitRange: 1, networkPolicy: 1 }),
  },
  {
    id: "failure",
    label: "No quota, no network policy",
    description: "Team B takes the cluster, Team A's pods stay Pending, and cross-namespace traffic is open.",
    tone: "crit",
    params: defaults({ teamBReplicas: 18, quotaCores: 0, limitRange: 1, networkPolicy: 0 }),
  },
  {
    id: "recovery",
    label: "Quota applied",
    description: "A six-core quota caps Team B, Team A schedules, and cross-namespace traffic is denied.",
    tone: "ok",
    params: defaults({ teamBReplicas: 18, quotaCores: 6, limitRange: 1, networkPolicy: 1 }),
  },
  {
    id: "noisy-neighbor",
    label: "No limit range",
    description: "Pods have no requests, so both teams schedule and contend for CPU at runtime.",
    tone: "crit",
    params: defaults({ teamBReplicas: 14, quotaCores: 0, limitRange: 0, networkPolicy: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-team-a-pending",
  title: "Predict what happens without a ResourceQuota",
  simId: "multitenancy",
  question:
    "Team B has no ResourceQuota. A LimitRange sets a one-core request on every pod. Team B creates 18 pods on a 16-core cluster, and Team A then needs six one-core pods. What happens to Team A?",
  prediction: {
    options: [
      { id: "fits", label: "Team A fits, because namespaces reserve capacity for each other" },
      { id: "pending", label: "Team A's pods stay Pending because Team B already reserved the cluster" },
      { id: "evict", label: "Team A evicts Team B automatically because it arrived later" },
      { id: "throttle", label: "Both teams run and the kernel shares CPU fairly" },
    ],
    correctOptionId: "pending",
    explanation:
      "The LimitRange gives every Team B pod a one-core request, so the scheduler accounts for 18 cores of demand on a 16-core cluster. The first 16 cores are reserved and additional pods wait. When Team A arrives with six more one-core pods, there is no unreserved capacity, so those pods stay Pending. A namespace name did not reserve anything; a ResourceQuota would have capped Team B before it filled the cluster.",
  },
  setup: defaults({ teamBReplicas: 18, quotaCores: 0, limitRange: 1, networkPolicy: 1 }),
  runFor: 20,
  observe: [
    "Team B admits pods until the cluster's 16 cores are reserved.",
    "Team A places zero of six pods and the pending count crosses critical.",
    "Team A's latency rises because the placed capacity is gone.",
    "Adding a six-core quota to Team B lets Team A's pods schedule.",
  ],
  explain:
    "Scheduling is first come, first served against reserved requests. A namespace does not reserve a share of the cluster, and a quota only limits the namespace it is applied to. Without a quota, the loud team can consume every schedulable core before the quiet team creates its pods.",
  fix: defaults({ teamBReplicas: 18, quotaCores: 6, limitRange: 1, networkPolicy: 1 }),
  debrief:
    "The quota capped Team B at six cores, leaving room for Team A and headroom for the system. The LimitRange made the requests visible, and the network policy closed the cross-namespace path. The tradeoff is that Team B can no longer burst into unused capacity, so the quota has to be reviewed as demand changes.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A namespace is a named scope for Kubernetes objects. It gives teams separate names, default ServiceAccounts, and a target for policy objects. It does not partition CPU, memory, or network by itself. Two namespaces on the same nodes share the same scheduler and the same kernel, so one team can consume capacity the other expected to use.",
  },
  {
    type: "p",
    text: "Isolation comes from controls applied inside the namespace. A ResourceQuota caps aggregate requests and limits. A LimitRange supplies default requests and enforces per-pod minimums or maximums at admission time. A NetworkPolicy selects pods and declares allowed traffic, and it only works if the cluster's CNI enforces it; a CNI without support accepts the object and leaves the default allow behavior. Check the CNI documentation and test the path from another namespace. RBAC limits what the namespace's identities can do to the API. None of these is provided by the namespace object alone.",
  },
  {
    type: "p",
    text: "For trusted teams, these controls prevent accidental contention. For hostile tenants, a namespace is not a security boundary: a shared kernel, shared node, and cluster-scoped resources remain. That case needs separate clusters or dedicated nodes, with the namespace controls still in place.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Control", "What it bounds", "Failure without it"],
    rows: [
      ["Namespace", "Object names and default identity", "No resource or network isolation"],
      ["ResourceQuota", "Aggregate requests and limits per namespace", "One team consumes the cluster"],
      ["LimitRange", "Default and per-pod request and limit bounds", "Pods schedule with no requests and overcommit"],
      ["NetworkPolicy", "Allowed ingress and egress for selected pods", "Every namespace can reach every pod"],
      ["RBAC", "API operations for a subject", "A workload can read or change other objects"],
    ],
  },
  {
    type: "p",
    text: "The model uses a 16-core cluster, six Team A replicas, and 400 rps of illustrative cross-namespace traffic. The exact capacity and traffic values are teaching numbers. The behavior to remember is that scheduling follows reserved requests and that a namespace does not reserve a share of the cluster.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Team A pods Pending and Team A CPU contention, the two ways a noisy neighbor shows up.",
      "Team B's admitted count against the quota, which shows whether the cap is doing anything.",
      "Cross-namespace traffic and the isolation gap, which separate network exposure from capacity.",
      "Team A's p99, which rises when the quiet tenant loses capacity or shares a contended node.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with a quota, a LimitRange, and a network policy. Remove the quota and raise Team B to 18 replicas to see Team A go Pending. Then remove the LimitRange to see overcommit and contention instead. Finish with Quota applied.",
  },
  { type: "sim", simId: "multitenancy" },
  { type: "experiment", experimentId: "predict-team-a-pending" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset let Team B create 18 one-core pods with no quota. The scheduler reserved the cluster's 16 cores, so Team A's six pods had nowhere to go. The same state also allowed cross-namespace traffic because no policy selected the destination pods.",
  },
  {
    type: "p",
    text: "The recovery preset capped Team B at six cores and restored the network policy. Team A scheduled and its latency returned to baseline. The noisy-neighbor preset showed the other mechanism: without a LimitRange, pods had no requests, so both teams scheduled and contended at runtime instead of one team going Pending.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Pending pods and scheduler events that name insufficient CPU or memory.",
      "ResourceQuota status for used and hard limits in each namespace.",
      "LimitRange defaults and whether pods actually carry requests.",
      "NetworkPolicy objects and the CNI's enforcement, tested from another namespace.",
      "Per-namespace latency and CPU throttling, not only cluster-wide averages.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Decide whether the symptom is capacity or network. For capacity, check the quota, the LimitRange, and the Pending pod's scheduler event. For network, check whether any policy selects the destination pod and whether the CNI enforces it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure each team's peak requests, not its average usage.",
      "Set a ResourceQuota per namespace with headroom for legitimate bursts.",
      "Add a LimitRange so every pod has a request the scheduler can count.",
      "Apply a default-deny NetworkPolicy and allow only the required paths.",
      "Test scheduling and cross-namespace traffic from the other team's namespace.",
      "Review quotas as demand changes; a fixed quota eventually becomes a bottleneck.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Quotas prevent one team from taking the cluster and strand capacity when a team is idle.",
      "LimitRanges make scheduling predictable and can reject a pod that omits a required request.",
      "Default-deny NetworkPolicies close exposure and require every legitimate path to be declared.",
      "Dedicated node pools isolate noisy workloads and reduce packing efficiency.",
      "Separate clusters are the strongest boundary and the most expensive to operate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "namespace-boundary",
    question:
      "Two teams share a cluster. One team's batch job doubles the other team's latency. Is a namespace enough to fix it?",
    difficulty: 2,
    hints: [
      "A namespace is an object scope.",
      "The scheduler and the kernel are shared.",
    ],
    answer:
      "No. A namespace gives the teams separate objects and identities, but it does not reserve CPU or memory or block network traffic. I would add a ResourceQuota to cap the batch team's aggregate requests, a LimitRange to make requests explicit, and a NetworkPolicy if the teams should not talk. If the latency is still unacceptable, I would isolate the batch workload on a dedicated node pool or a separate cluster.",
    followUps: [
      "What does a ResourceQuota cap that a LimitRange does not?",
      "How would priority classes change the outcome?",
      "When would you choose a separate cluster?",
    ],
    redFlags: [
      "Treats a namespace as a resource boundary.",
      "Adds a quota without requests.",
      "Ignores network isolation.",
    ],
    rubric: [
      "Separates object scope from isolation.",
      "Names quota and limit range.",
      "Adds a network control.",
      "Escalates to nodes or clusters when needed.",
    ],
  },
  {
    id: "quota-vs-limitrange",
    question:
      "Explain the difference between a ResourceQuota and a LimitRange, and what happens when a pod is created without requests.",
    difficulty: 2,
    hints: [
      "One applies to the namespace total; the other applies to each pod.",
      "Admission can supply a default.",
    ],
    answer:
      "A ResourceQuota caps the aggregate requests, limits, and often object counts in a namespace. A LimitRange applies to individual pods and containers: it can set a default request or limit and enforce minimums and maximums. If a pod is created without requests, a LimitRange can add a default at admission. Without one, the pod may be admitted with no requests, so the scheduler cannot reserve capacity for it and the node can become oversubscribed.",
    followUps: [
      "Which object would you use to cap the number of LoadBalancer Services?",
      "What happens if the default request exceeds the quota?",
      "Can a LimitRange force a QoS class?",
    ],
    redFlags: [
      "Uses the terms interchangeably.",
      "Assumes the scheduler reserves unrequested capacity.",
      "Ignores admission-time defaults.",
    ],
    rubric: [
      "Distinguishes namespace total from per-pod bounds.",
      "Explains default requests.",
      "Notes quota interaction.",
      "Connects to scheduling.",
    ],
  },
  {
    id: "network-policy",
    question:
      "You apply a default-deny NetworkPolicy, but one team still reaches another team's database. What do you check?",
    difficulty: 3,
    hints: [
      "A policy only affects pods it selects.",
      "The CNI must implement the policy.",
    ],
    answer:
      "I would check whether the policy selects the database pods and whether it covers both ingress and egress. A policy that selects the client but not the server does not block the path unless the server also has a policy. I would confirm the CNI enforces NetworkPolicy, because a CNI that ignores it leaves the default allow behavior. Then I would test from a pod in the other namespace and inspect the policy's podSelector, namespaceSelector, and ports.",
    followUps: [
      "What is the default behavior when no policy selects a pod?",
      "How would you allow only one namespace to reach the database?",
      "How does egress policy change the test?",
    ],
    redFlags: [
      "Assumes a policy is cluster-wide because it exists.",
      "Checks only ingress.",
      "Ignores CNI support.",
    ],
    rubric: [
      "Checks the podSelector.",
      "Covers both directions.",
      "Verifies CNI enforcement.",
      "Tests the actual path.",
    ],
  },
];

const checklist = [
  {
    title: "Before onboarding a team",
    items: [
      "The namespace has a ResourceQuota sized from peak requests.",
      "A LimitRange supplies default requests and limits.",
      "A default-deny NetworkPolicy exists, with explicit allowed paths.",
      "The team's ServiceAccounts and RBAC are scoped to the namespace.",
    ],
  },
  {
    title: "During contention",
    items: [
      "Check whether the symptom is Pending pods or runtime throttling.",
      "Read the quota and limit range in both namespaces.",
      "Check which team owns the largest admitted requests.",
      "Check whether cross-namespace traffic is expected or exposed.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Right-size quotas from measured peak demand.",
      "Confirm the CNI enforces every policy you rely on.",
      "Decide whether the tenants are trusted or need separate nodes or clusters.",
      "Test scheduling and network isolation from the other tenant's namespace.",
    ],
  },
];

const references = [
  {
    title: "Multi-tenancy",
    url: "https://kubernetes.io/docs/concepts/security/multi-tenancy/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Tenancy models, namespace isolation, and the limits of a shared cluster.",
  },
  {
    title: "Resource quotas",
    url: "https://kubernetes.io/docs/concepts/policy/resource-quotas/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Aggregate namespace limits, admission behavior, and quota enforcement.",
  },
  {
    title: "Limit Ranges",
    url: "https://kubernetes.io/docs/concepts/policy/limit-range/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Default requests and limits, per-pod bounds, and admission-time enforcement.",
  },
  {
    title: "Network Policies",
    url: "https://kubernetes.io/docs/concepts/services-networking/network-policies/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Pod selection, ingress and egress rules, default allow, and CNI enforcement.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    multitenancy: {
      model: multitenancyModel,
      presets,
      instructions:
        "Start Healthy with a quota, a LimitRange, and a network policy. Remove the quota and grow Team B to see Team A go Pending. Remove the LimitRange to see runtime contention, then restore the controls.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. The 16-core cluster, six Team A replicas, and 400 rps of cross-namespace traffic are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["kubernetes-rbac", "kubernetes-config-secrets", "kubernetes-scheduling"],
};
