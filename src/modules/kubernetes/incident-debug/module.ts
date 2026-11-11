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

const TOTAL_REPLICAS = 24;
const EVICTABLE_PODS = 8;

const params: ParamSpec[] = [
  {
    id: "nodeMemoryUsedPct",
    label: "Node memory used",
    min: 50,
    max: 100,
    step: 1,
    value: 72,
    unit: "%",
    group: "Node",
    help: "Memory used on the affected node. High memory triggers MemoryPressure and eviction; it does not by itself make the kubelet NotReady.",
    format: "percent",
  },
  {
    id: "kubeletNotReady",
    label: "Kubelet reports NotReady",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Node",
    help: "1 marks the node NotReady through the kubelet condition. This is separate from memory pressure: a node can be NotReady for network, certificate, or process reasons while memory is fine.",
    format: "count",
  },
  {
    id: "pendingReplicas",
    label: "Pending replicas",
    min: 0,
    max: 20,
    step: 1,
    value: 0,
    unit: " pods",
    group: "Scheduler",
    help: "Replicas the scheduler cannot place. The pod event names the constraint, and the container has not started, so there are no application logs to read.",
    format: "count",
  },
  {
    id: "crashLoopReplicas",
    label: "CrashLoop replicas",
    min: 0,
    max: 10,
    step: 1,
    value: 0,
    unit: " pods",
    group: "Container",
    help: "Containers that start and exit repeatedly. The previous container log and the exit code are the useful evidence after the pod status is clear.",
    format: "count",
  },
  {
    id: "triagePath",
    label: "Triage path: logs 0, status 1",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Operator",
    help: "0 starts with application logs. 1 starts with node conditions, events, and pod status. The model shows the cost of investigating the wrong layer first.",
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

function worst(...healths: Health[]): Health {
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

interface Values {
  nodeMemory: number;
  pending: number;
  crashLoop: number;
  triagePath: number;
  nodePressure: boolean;
  kubeletNotReady: boolean;
  notReadyNodes: number;
  evicted: number;
  unavailable: number;
  available: number;
  mttr: number;
  wrongLayer: number;
}

function compute(p: Params): Values {
  const nodeMemory = clamp(num(p, "nodeMemoryUsedPct", 72), 50, 100);
  const pending = Math.round(clamp(num(p, "pendingReplicas", 0), 0, 20));
  const crashLoop = Math.round(clamp(num(p, "crashLoopReplicas", 0), 0, 10));
  const triagePath = num(p, "triagePath", 1) >= 1 ? 1 : 0;
  const kubeletNotReady = num(p, "kubeletNotReady", 0) >= 1;
  const nodePressure = nodeMemory >= 90;
  const notReadyNodes = kubeletNotReady ? 1 : 0;
  const evicted = nodePressure ? Math.round(EVICTABLE_PODS * ((nodeMemory - 90) / 10)) : 0;
  const unavailableCount = Math.min(TOTAL_REPLICAS, pending + crashLoop + evicted);
  const unavailable = (unavailableCount / TOTAL_REPLICAS) * 100;
  const mttr =
    8 +
    pending * 1.5 +
    crashLoop * 2 +
    (nodePressure ? 10 : 0) +
    (kubeletNotReady ? 10 : 0) +
    (triagePath === 0 ? 20 : 0);
  const wrongLayer =
    triagePath === 0 && (nodePressure || kubeletNotReady || pending > 0) ? 1 : 0;
  return {
    nodeMemory,
    pending,
    crashLoop,
    triagePath,
    nodePressure,
    kubeletNotReady,
    notReadyNodes,
    evicted,
    unavailable,
    available: 100 - unavailable,
    mttr,
    wrongLayer,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const nodeHealth: Health = values.notReadyNodes
    ? "crit"
    : values.nodePressure
      ? "warn"
      : "ok";
  const pendingHealth = healthFor(values.pending, 1, 4);
  const crashHealth = healthFor(values.crashLoop, 1, 2);
  const workloadHealth = worst(healthFor(values.unavailable, 10, 25), crashHealth);
  const nodes: SimNode[] = [
    {
      id: "node-2",
      label: "node-2",
      kind: "service",
      health: nodeHealth,
      utilization: values.nodeMemory / 100,
      sublabel: `${values.nodeMemory}% memory · ${values.notReadyNodes ? "NotReady" : "Ready"}`,
      detail: values.kubeletNotReady
        ? "The kubelet reports NotReady. Check network, certificate, and kubelet process health before attributing the node state to memory."
        : values.nodePressure
          ? "Memory is high enough to trigger MemoryPressure and eviction, but the kubelet still reports Ready. These are separate signals."
          : "The node is Ready with memory headroom. A node condition is not the same as a busy node.",
      meta: { view: "flow" },
    },
    {
      id: "kubelet",
      label: "kubelet",
      kind: "service",
      health: nodeHealth,
      utilization: values.nodeMemory / 100,
      sublabel: values.notReadyNodes ? "reporting NotReady" : "reporting Ready",
      detail:
        "The kubelet publishes node conditions and evicts pods under pressure. MemoryPressure and NotReady are different conditions; a node can evict pods while still reporting Ready.",
      meta: { view: "flow" },
    },
    {
      id: "scheduler",
      label: "kube-scheduler",
      kind: "service",
      health: pendingHealth,
      utilization: clamp(values.pending / 20),
      sublabel: `${values.pending} replicas Pending`,
      detail:
        "A Pending pod has not been placed. The scheduler event names the constraint: insufficient resources, a taint, affinity, or a volume that cannot attach. Application logs do not exist yet.",
      meta: { view: "flow" },
    },
    {
      id: "workload",
      label: "Workload",
      kind: "service",
      health: workloadHealth,
      utilization: values.unavailable / 100,
      sublabel: `${Math.round(values.unavailable)}% replicas unavailable`,
      detail:
        "The workload view combines missing replicas from scheduling, container exits, and eviction. Split the count by reason before choosing a fix.",
      meta: { view: "flow" },
    },
    {
      id: "events",
      label: "Events and status",
      kind: "service",
      health: "ok",
      utilization: 0.3,
      sublabel: values.wrongLayer ? "logs opened first" : "reviewed first",
      detail:
        "Events, conditions, and pod status describe the layer that failed. Logs describe what the container did after it started; they cannot explain a pod that never scheduled.",
      meta: { view: "flow" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("node-kubelet", "node-2", "kubelet", 1, nodeHealth, "conditions"),
      edge("kubelet-scheduler", "kubelet", "scheduler", clamp(values.pending / 20), pendingHealth, "capacity"),
      edge("scheduler-workload", "scheduler", "workload", clamp(values.pending / 20), pendingHealth, "placements"),
      edge("events-node", "events", "node-2", 0.4, "ok", "evidence"),
    ],
    metrics: [
      metric("pending-pods", "Pending pods", values.pending, " pods", 1, 4, "count"),
      metric("crashloop-pods", "CrashLoop pods", values.crashLoop, " pods", 1, 2, "count"),
      metric("notready-nodes", "NotReady nodes", values.notReadyNodes, " nodes", 1, 1, "count"),
      metric("wrong-layer", "Logs-first investigation", values.wrongLayer, "", 0.5, 0.5, "count"),
      metric("mttr", "Modeled time to root cause", values.mttr, " min", 15, 30, "number"),
      metric("unavailable-pods", "Unavailable replicas", values.unavailable, "%", 10, 25, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `node-2 at ${values.nodeMemory}% memory and ${values.notReadyNodes ? "NotReady" : "Ready"}; ${values.pending} Pending, ${values.crashLoop} CrashLoop, ${values.evicted} evicted; modeled time to root cause ${values.mttr} minutes.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * 0.02 * Math.sin((index + (seed % 6)) / 2.8);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "mttr",
    metricId: "mttr",
    warn: 15,
    crit: 30,
    title: "Time to root cause is too long for the incident",
    cause:
      "The investigation is spending time in a layer that cannot explain the symptom. A Pending pod has no application log, and a NotReady node affects many pods at once. Starting below the symptom is faster than reading logs from a process that never started.",
    fix:
      "Order the evidence: node conditions, then scheduler and pod events, then container status and previous logs, then application logs. Assign one responder to the node and scheduler view while another checks the workload.",
    checkFirst: [
      "Check node conditions and whether more than one workload is affected on the same node.",
      "Check pod status and the scheduler event for Pending replicas.",
      "Check the previous container log and exit code only after the pod has been placed and started.",
    ],
  },
  {
    id: "wrong-layer",
    metricId: "wrong-layer",
    warn: 0.5,
    crit: 0.5,
    title: "The first evidence came from the wrong layer",
    cause:
      "Application logs were opened before node conditions, events, and pod status. Logs describe process behavior after startup; they cannot explain a missing schedule, a node that went NotReady, or a container that never ran.",
    fix:
      "Start from the failing object's status and events. Move down the stack until the layer stops making sense, then read the logs for that layer. Keep the event timeline so the order of symptoms is visible.",
    checkFirst: [
      "Ask which layer produced the first symptom: node, scheduler, pod, container, or application.",
      "Check whether the failing pod ever started; if not, logs are not the first tool.",
      "Check whether several workloads share the same node or dependency.",
    ],
  },
  {
    id: "notready-nodes",
    metricId: "notready-nodes",
    warn: 1,
    crit: 1,
    title: "A node is NotReady",
    cause:
      "The kubelet stopped reporting Ready, or the node lost network or resources. Pods on that node may be evicted or stranded, and new pods cannot schedule there. This is a lower-layer cause that can produce several pod symptoms at once.",
    fix:
      "Check the node conditions and kubelet status, cordon the node if it is unstable, and drain it only after confirming the workloads can reschedule. Replace or repair the node before returning it to service.",
    checkFirst: [
      "Read kubectl describe node and the Ready, MemoryPressure, DiskPressure, and PIDPressure conditions.",
      "Check kubelet logs and whether the node can reach the API server.",
      "Check which pods are on the node and whether replacements can schedule elsewhere.",
    ],
  },
  {
    id: "pending-pods",
    metricId: "pending-pods",
    warn: 1,
    crit: 4,
    title: "Pods are Pending and have never started",
    cause:
      "The scheduler could not place the pod. The event names the constraint: insufficient CPU or memory, a taint without a toleration, an affinity rule, or an unbound volume. A Pending pod has no container log because there is no container.",
    fix:
      "Read the scheduler event, then fix the specific constraint: add capacity, adjust requests, add a toleration, change affinity, or repair the volume. Scaling the Deployment again creates more Pending pods, not more capacity.",
    checkFirst: [
      "Run kubectl describe pod and read the Events section.",
      "Check node allocatable resources and taints.",
      "Check persistent volume claims and topology constraints.",
    ],
  },
  {
    id: "crashloop-pods",
    metricId: "crashloop-pods",
    warn: 1,
    crit: 2,
    title: "Containers are starting and exiting repeatedly",
    cause:
      "The pod was placed and the container started, but the process exited. Common causes are a bad image entrypoint, missing configuration, a failed dependency check, or a liveness probe that kills the container before it becomes healthy.",
    fix:
      "Check the previous container log, the exit code, and the probe configuration. Fix the process or the probe, then confirm the restart count stops increasing.",
    checkFirst: [
      "Run kubectl logs --previous and read the exit code.",
      "Check the pod events for probe failures and image pull errors.",
      "Check whether the failure started with a new image or a configuration change.",
    ],
  },
];

export const incidentDebugModel: SimModel = {
  id: "kubernetes-incident-debug",
  visual: "timeline",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame);
    pushEvent(frame, {
      id: "triage-start",
      at: 0,
      severity: "info",
      title: "Triage started",
      detail:
        "Clusters are read from the node down. Check conditions and events before opening application logs.",
    });
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const elapsed = Math.max(0, Number(frame.flags.elapsed ?? 0)) + Math.max(0, dt);
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.events = [...frame.events];
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "mttr" ? { ...item, value: Math.max(0, item.value * jitter) } : item,
    );
    next.flags = {
      ...frame.flags,
      ...next.flags,
      elapsed,
      paramsKey: JSON.stringify(p),
    };
    if (values.notReadyNodes > 0 && elapsed > 2 && frame.flags.nodeEvent !== 1) {
      pushEvent(next, {
        id: "triage-node-notready",
        at: elapsed,
        severity: "crit",
        title: "node-2 reports NotReady",
        detail: `The kubelet reports NotReady while memory is at ${values.nodeMemory}%. Readiness and memory pressure are separate signals; check kubelet, network, and node health before attributing the state to memory.`,
        nodeId: "node-2",
        metricId: "notready-nodes",
      });
      next.flags.nodeEvent = 1;
    }
    if (values.evicted > 0 && elapsed > 4 && frame.flags.evictionEvent !== 1) {
      pushEvent(next, {
        id: "triage-evictions",
        at: elapsed,
        severity: "crit",
        title: "Pods evicted from node-2 under memory pressure",
        detail: `${values.evicted} pods were evicted. Check which workloads lost replicas before reading their logs.`,
        nodeId: "kubelet",
        metricId: "unavailable-pods",
      });
      next.flags.evictionEvent = 1;
    }
    if (values.pending > 0 && elapsed > 6 && frame.flags.pendingEvent !== 1) {
      pushEvent(next, {
        id: "triage-pending",
        at: elapsed,
        severity: "warn",
        title: "Replacement pods are Pending",
        detail: `${values.pending} replicas have no node. The scheduler event names the constraint; these containers have no logs yet.`,
        nodeId: "scheduler",
        metricId: "pending-pods",
      });
      next.flags.pendingEvent = 1;
    }
    if (values.crashLoop > 0 && elapsed > 8 && frame.flags.crashEvent !== 1) {
      pushEvent(next, {
        id: "triage-crashloop",
        at: elapsed,
        severity: "warn",
        title: "Containers are in CrashLoopBackOff",
        detail: `${values.crashLoop} containers are restarting. Read the previous container log and exit code after confirming the pod was placed.`,
        nodeId: "workload",
        metricId: "crashloop-pods",
      });
      next.flags.crashEvent = 1;
    }
    if (values.notReadyNodes === 0) next.flags.nodeEvent = 0;
    if (values.evicted === 0) next.flags.evictionEvent = 0;
    if (values.pending === 0) next.flags.pendingEvent = 0;
    if (values.crashLoop === 0) next.flags.crashEvent = 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const lines = [
      `The affected node is at ${values.nodeMemory}% memory and the kubelet reports ${
        values.notReadyNodes ? "NotReady" : "Ready"
      }.`,
      values.nodePressure && !values.notReadyNodes
        ? "MemoryPressure is active while the node is Ready. Eviction can happen without a NotReady condition."
        : values.notReadyNodes && !values.nodePressure
          ? "The node is NotReady while memory is within headroom. Investigate kubelet, network, or node health."
          : values.notReadyNodes && values.nodePressure
            ? "Both a readiness failure and memory pressure are active. Treat them as separate causes."
            : "No node pressure or readiness condition is active in this state.",
      values.pending > 0
        ? `${values.pending} replicas are Pending. Read the scheduler event before looking for application logs; the container never started.`
        : "No replicas are waiting on the scheduler in this state.",
      values.crashLoop > 0
        ? `${values.crashLoop} containers are restarting. These are the cases where the previous container log is useful.`
        : "No containers are in CrashLoopBackOff in this state.",
      values.wrongLayer
        ? "The modeled triage path starts with logs, which adds time when the cause is below the container."
        : "The modeled triage path starts with status and events, then moves to logs for the layer that failed.",
    ];
    return lines;
  },
  legend: [
    { label: "Status and events first", tone: "ok" },
    { label: "Symptom layer identified", tone: "warn" },
    { label: "Wrong layer or node failure", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "The node is Ready, all replicas are placed, and no container is restarting.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Pressure and a few Pending",
    description: "Memory is at 91% and one pod is evicted, but the kubelet still reports Ready and two replicas wait for capacity.",
    tone: "warn",
    params: defaults({ nodeMemoryUsedPct: 91, kubeletNotReady: 0, pendingReplicas: 2, crashLoopReplicas: 0, triagePath: 1 }),
  },
  {
    id: "failure",
    label: "Node failure with logs-first triage",
    description: "node-2 is NotReady, memory pressure evicts pods, eight replicas are Pending, and three containers crash while the operator reads logs.",
    tone: "crit",
    params: defaults({ nodeMemoryUsedPct: 97, kubeletNotReady: 1, pendingReplicas: 8, crashLoopReplicas: 3, triagePath: 0 }),
  },
  {
    id: "recovery",
    label: "Recovered",
    description: "The node is back within headroom, the Pending replicas are placed, and the crash loop is fixed.",
    tone: "ok",
    params: defaults({ nodeMemoryUsedPct: 70, pendingReplicas: 0, crashLoopReplicas: 0, triagePath: 1 }),
  },
  {
    id: "crashloop",
    label: "CrashLoop only",
    description: "The node is healthy and every pod is placed, but four containers restart after a bad configuration change.",
    tone: "crit",
    params: defaults({ nodeMemoryUsedPct: 72, pendingReplicas: 0, crashLoopReplicas: 4, triagePath: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-triage-order",
  title: "Predict the first useful check",
  simId: "incident-debug",
  question:
    "Half the pods are Pending, three containers are in CrashLoopBackOff, and one node is NotReady. The Pending pods have never started. What do you check first?",
  prediction: {
    options: [
      { id: "logs", label: "The Pending pods' application logs, because they show why the app is failing" },
      { id: "node", label: "The NotReady node's conditions and the scheduler events for the Pending pods" },
      { id: "restart", label: "Restart every Deployment so the pods reschedule" },
      { id: "scale", label: "Scale the Pending Deployments up so more replicas can start" },
    ],
    correctOptionId: "node",
    explanation:
      "A Pending pod has not been placed, so its container has not run and there are no application logs to read. A NotReady node removes capacity and can cause several workloads to fail at once. The NotReady condition is its own signal; memory pressure is modeled separately and explains the evictions. The node conditions and the scheduler events explain the shared cause; the CrashLoop containers are a separate, lower-layer symptom that should be examined after the node and placement path. Restarting or scaling first creates more work without adding capacity.",
  },
  setup: defaults({ nodeMemoryUsedPct: 97, kubeletNotReady: 1, pendingReplicas: 8, crashLoopReplicas: 3, triagePath: 0 }),
  runFor: 20,
  observe: [
    "The node is NotReady and pods are being evicted under memory pressure.",
    "Eight replacements are Pending because the node lost capacity.",
    "The modeled time to root cause is highest when the investigation starts with logs.",
    "Checking node conditions and scheduler events first lowers the modeled time and points to the shared cause.",
  ],
  explain:
    "Triage follows the dependency direction. A node condition can explain a scheduler shortage, which explains Pending pods, which explains missing replicas. Logs sit at the bottom of that chain and are only diagnostic once a container has started. Reading logs first is not wrong because logs are useless; it is wrong because they answer a different question.",
  fix: defaults({ nodeMemoryUsedPct: 70, pendingReplicas: 0, crashLoopReplicas: 0, triagePath: 1 }),
  debrief:
    "The recovered state has a healthy node, no Pending replicas, and no crash loops. The ordered path was node conditions, scheduler events, pod status, then container logs for the workload that actually started. The tradeoff is that this order requires a responder who can read cluster-level evidence, not only an application log.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Cluster triage is the order in which you collect evidence during a Kubernetes incident. The layers are the node, the scheduler, the pod, the container, and the application. A symptom at one layer is often caused by a layer below it. Half the pods Pending and one node NotReady are not two independent incidents; the node may explain the scheduling shortage.",
  },
  {
    type: "p",
    text: "Events and status come before logs because they describe what the platform did with the object. A Pending pod has no container log: the scheduler never placed it, so there is no process to log. A NotReady node affects every pod on it. MemoryPressure is a separate condition: a node can evict pods while still Ready, and it can be NotReady for network or kubelet reasons while memory is fine. A CrashLoopBackOff container did start, and its previous log and exit code are useful once you know the pod was placed.",
  },
  {
    type: "p",
    text: "The practical order is: node conditions, then scheduler and pod events, then container status, then logs. Read logs for the layer that failed, not for the loudest symptom. Keep the event timeline so the order of symptoms is visible and so a later responder does not repeat the same checks.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "First evidence", "Question it answers"],
    rows: [
      ["Node", "Conditions and kubelet status", "Is the node Ready and does it have pressure?"],
      ["Scheduler", "Pod events and requests", "Why was this pod not placed?"],
      ["Pod", "Phase and container statuses", "Did the container start and is it ready?"],
      ["Container", "Previous log and exit code", "Why did the process exit?"],
      ["Application", "Logs, traces, and metrics", "What did the process do after it started?"],
    ],
  },
  {
    type: "p",
    text: "The model uses 24 replicas, eight evictable pods, and an eight-minute baseline time to root cause as illustrative values. The time is a teaching aid, not a benchmark. The layer order and the meaning of Pending, CrashLoopBackOff, and NotReady are the parts to carry into an incident.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A timeline of node, eviction, scheduling, and container events.",
      "Memory pressure and kubelet readiness as separate node states.",
      "Pending, CrashLoop, and NotReady counts, split by the layer that produces them.",
      "A modeled time to root cause that rises when the investigation starts in the wrong layer.",
      "The unavailable replica share, which combines the three symptoms without explaining them.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Pressure and a few Pending. Compare CrashLoop only, where logs are the right next step after status. Apply Node failure with logs-first triage to see the time cost, then switch the triage path to status and watch the modeled time fall.",
  },
  { type: "sim", simId: "incident-debug" },
  { type: "experiment", experimentId: "predict-triage-order" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset had a NotReady node, evicted pods, eight Pending replacements, and three CrashLoop containers. Reading logs first answered a question about the CrashLoop containers while the node condition and scheduling shortage explained most of the missing replicas. The modeled time to root cause rose because the investigation started at the bottom of the chain.",
  },
  {
    type: "p",
    text: "The recovery preset cleared memory pressure and returned the kubelet to Ready, then placed every replica. The CrashLoop-only preset showed the other direction: with a healthy node and every pod placed, the previous container log is exactly the right evidence. The order is not logs last; it is logs after the layer that failed is identified.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Node conditions from kubectl describe node, including Ready, MemoryPressure, and DiskPressure.",
      "Pod events from kubectl describe pod, including scheduler messages and probe failures.",
      "Pod phase and container statuses, including restart counts and the last termination reason.",
      "Previous container logs and exit codes for containers that started and exited.",
      "A shared event timeline that shows node and workload symptoms in order.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Ask whether the pod ever started. If it did not, read the scheduler event. If several workloads on one node are failing, read the node conditions first. Read application logs only after the pod has been placed and the container has run.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Check node conditions and identify whether more than one workload is affected.",
      "Cordon an unstable node and confirm replacements can schedule elsewhere.",
      "Read the scheduler event for Pending pods and fix the named constraint.",
      "Check container status and previous logs for CrashLoop containers.",
      "Fix the process, configuration, or probe that caused the exit.",
      "Confirm replicas return, restart counts stop rising, and the node is Ready.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Node-first triage finds shared causes quickly and can delay the application fix when the node is unrelated.",
      "Log-first triage is fast for a single crashing container and misleading when the pod never started.",
      "Cordoning a node protects new placements and can strand capacity if replacements have nowhere to go.",
      "Draining a node restores a clean state and temporarily removes capacity.",
      "A shared event timeline improves handoffs and adds work to maintain during the incident.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "pending-vs-crashloop",
    question:
      "What is the difference between a Pending pod and a CrashLoopBackOff container, and which one has useful application logs?",
    difficulty: 2,
    hints: [
      "One has not been scheduled; the other has started.",
      "Logs come from a running process.",
    ],
    answer:
      "A Pending pod has not been placed on a node, so its container has not run and there are no application logs. The useful evidence is the scheduler event and the pod's resource requests and constraints. A CrashLoopBackOff container was placed and started, then exited repeatedly. Its previous log, exit code, and probe configuration are useful. I would not read logs for a Pending pod because there is no process to produce them.",
    followUps: [
      "What scheduler constraints can leave a pod Pending?",
      "How do you read the previous container log?",
      "What does a restart count tell you?",
    ],
    redFlags: [
      "Looks for logs on a Pending pod.",
      "Treats both statuses as the same failure.",
      "Ignores scheduler events.",
    ],
    rubric: [
      "Distinguishes placement from runtime.",
      "Names the right evidence for each.",
      "Reads the scheduler event.",
      "Reads the previous log for the crash.",
    ],
  },
  {
    id: "notready-blast-radius",
    question:
      "One node is NotReady and several unrelated workloads are failing. How do you confirm the node is the shared cause?",
    difficulty: 3,
    hints: [
      "Map the failing pods to nodes.",
      "Check the node conditions and the timing.",
    ],
    answer:
      "I would map the failing pods to nodes and see whether they share the NotReady node. I would compare the start of the failures with the node condition change and check whether the remaining replicas are healthy elsewhere. Then I would read the node conditions and kubelet status. If the failure follows the node rather than the application, the node is the shared cause; if workloads on other nodes fail at the same time, I would look for a shared dependency or control-plane problem.",
    followUps: [
      "How would you prove the timing correlation?",
      "What would you do if the replacements cannot schedule?",
      "When would you replace the node instead of repairing it?",
    ],
    redFlags: [
      "Restarts every workload without mapping pods to nodes.",
      "Assumes the node is the cause because it is NotReady.",
      "Ignores capacity for replacements.",
    ],
    rubric: [
      "Maps pods to nodes.",
      "Checks timing and scope.",
      "Reads node conditions.",
      "Plans replacement capacity.",
    ],
  },
  {
    id: "logs-first",
    question:
      "A responder opens application logs first during a cluster incident. When is that reasonable, and when is it a mistake?",
    difficulty: 3,
    hints: [
      "Logs answer questions about a process that ran.",
      "Pending and NotReady are platform states.",
    ],
    answer:
      "It is reasonable when a single workload is failing, the pod is placed, and the symptom is clearly inside the process, such as a crash or a failed dependency. It is a mistake when pods are Pending, a node is NotReady, or many unrelated workloads fail at once, because those symptoms originate below the container and logs cannot explain them. I would still read logs after identifying the failing layer, so the order matters more than whether logs are used at all.",
    followUps: [
      "How would you split the investigation across responders?",
      "What evidence would make you move from logs to the node?",
      "How do you keep the timeline for the postmortem?",
    ],
    redFlags: [
      "Says logs are always the first step.",
      "Says logs are never useful.",
      "Ignores the scope of the failure.",
    ],
    rubric: [
      "Conditions the choice on the symptom.",
      "Names platform states that predate logs.",
      "Keeps logs in the process.",
      "Preserves the timeline.",
    ],
  },
  {
    id: "triage-checklist",
    question:
      "Write the first five checks you would run for a cluster incident with mixed Pending, CrashLoop, and NotReady symptoms.",
    difficulty: 4,
    hints: [
      "Start with the layer that can affect the most objects.",
      "Separate evidence collection from mitigation.",
    ],
    answer:
      "First, check node conditions and whether the failures concentrate on one node. Second, read the scheduler events for Pending pods and compare requests with allocatable capacity. Third, check pod phase and container statuses to separate never-started from started-and-exited. Fourth, read the previous logs and exit codes for the CrashLoop containers. Fifth, check the shared dependencies and the event timeline for a common trigger. I would assign mitigation separately so cordoning or draining does not erase the evidence before it is captured.",
    followUps: [
      "Which check would you drop under time pressure?",
      "How would you capture evidence before draining?",
      "What would make you escalate to the control plane?",
    ],
    redFlags: [
      "Starts with a restart.",
      "Skips the node layer.",
      "Destroys evidence before capture.",
    ],
    rubric: [
      "Orders checks by blast radius.",
      "Separates placement from runtime.",
      "Captures evidence before mitigation.",
      "Escalates when the control plane is implicated.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show node conditions, Pending pods, restart counts, and unavailable replicas separately.",
      "Responders know how to read events and describe a node or pod without guessing.",
      "A shared event timeline is captured for the postmortem.",
      "Capacity headroom exists for replacements when a node is cordoned.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Ask whether the pod ever started before opening logs.",
      "Check node conditions when several workloads fail at once.",
      "Read the scheduler event for every Pending pod.",
      "Read previous logs and exit codes for CrashLoop containers.",
      "Capture evidence before cordoning, draining, or restarting.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Reconstruct the order of node, scheduler, pod, and container symptoms.",
      "Check whether the first alert pointed at the right layer.",
      "Fix the shared cause, not only the loudest symptom.",
      "Add a check or dashboard for the layer that was missed.",
    ],
  },
];

const references = [
  {
    title: "Troubleshooting clusters",
    url: "https://kubernetes.io/docs/tasks/debug/debug-cluster/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Node and cluster troubleshooting, conditions, and control-plane checks.",
  },
  {
    title: "Debug Pods",
    url: "https://kubernetes.io/docs/tasks/debug/debug-application/debug-pods/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Pod status, describe output, events, and logs for a failing pod.",
  },
  {
    title: "Debug running pods",
    url: "https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Exec, logs, and container status for pods that have started.",
  },
  {
    title: "Incident response",
    url: "https://sre.google/workbook/incident-response/",
    publisher: "Google SRE Workbook",
    kind: "book" as const,
    note: "Incident roles, evidence collection, and structured response.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "incident-debug": {
      model: incidentDebugModel,
      presets,
      instructions:
        "Start Healthy, then apply Pressure and a few Pending. Compare CrashLoop only with Node failure. Switch the triage path between logs-first and status-first and watch the modeled time to root cause.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. The 24 replicas, eight evictable pods, and modeled time to root cause are teaching values, not benchmarks; memory pressure and kubelet readiness are separate inputs.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["kubernetes-node-pressure", "kubernetes-config-secrets", "kubernetes-rbac"],
};
