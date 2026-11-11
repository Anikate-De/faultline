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

const TOTAL_NODES = 12;
const SECONDS_PER_BATCH = 10;

const params: ParamSpec[] = [
  {
    id: "controlPlaneMinor",
    label: "Control plane minor version",
    min: 28,
    max: 33,
    step: 1,
    value: 32,
    unit: "",
    group: "Versions",
    help: "The kube-apiserver minor version. The model shows it as 1.x; the exact supported releases depend on the current Kubernetes release cycle.",
    format: "count",
  },
  {
    id: "nodeMinor",
    label: "Node kubelet minor version",
    min: 26,
    max: 33,
    step: 1,
    value: 31,
    unit: "",
    group: "Versions",
    help: "The kubelet minor version on the worker nodes. A kubelet may be older than the API server only within the documented skew bound.",
    format: "count",
  },
  {
    id: "removedApiInUse",
    label: "Workload uses a removed API",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Compatibility",
    help: "1 means a manifest or client still calls an API version that the target release no longer serves. The upgrade can succeed while the workload fails.",
    format: "count",
  },
  {
    id: "drainBatch",
    label: "Nodes drained at once",
    min: 1,
    max: 8,
    step: 1,
    value: 1,
    unit: " nodes",
    group: "Drain",
    help: "Cordoned and drained nodes per batch. A larger batch upgrades faster and removes more serving capacity at the same time.",
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
  if (healths.includes("down")) return "down";
  if (healths.includes("crit")) return "crit";
  if (healths.includes("warn")) return "warn";
  return "ok";
}

interface Values {
  controlPlane: number;
  node: number;
  skew: number;
  nodeNewer: boolean;
  skewViolation: boolean;
  removedApi: boolean;
  drainBatch: number;
  duration: number;
  progress: number;
  draining: boolean;
  drainedNodes: number;
  drainedCapacity: number;
  availableCapacity: number;
  apiErrorRate: number;
  readyNodes: number;
}

function compute(p: Params, elapsed: number): Values {
  const controlPlane = Math.round(clamp(num(p, "controlPlaneMinor", 32), 28, 33));
  const node = Math.round(clamp(num(p, "nodeMinor", 31), 26, 33));
  const rawSkew = controlPlane - node;
  const nodeNewer = rawSkew < 0;
  const skew = Math.abs(rawSkew);
  const skewViolation = skew > 3 || nodeNewer;
  const removedApi = num(p, "removedApiInUse", 0) >= 1;
  const drainBatch = Math.round(clamp(num(p, "drainBatch", 1), 1, 8));
  const duration = Math.max(SECONDS_PER_BATCH, Math.ceil(TOTAL_NODES / drainBatch) * SECONDS_PER_BATCH);
  const progress = Math.min(100, (Math.max(0, elapsed) / duration) * 100);
  const draining = progress < 100;
  const drainedNodes = draining ? Math.min(TOTAL_NODES, drainBatch) : 0;
  const drainedCapacity = (drainedNodes / TOTAL_NODES) * 100;
  return {
    controlPlane,
    node,
    skew,
    nodeNewer,
    skewViolation,
    removedApi,
    drainBatch,
    duration,
    progress,
    draining,
    drainedNodes,
    drainedCapacity,
    availableCapacity: 100 - drainedCapacity,
    apiErrorRate: removedApi ? 100 : 0,
    readyNodes: TOTAL_NODES - drainedNodes,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const versionHealth: Health = values.nodeNewer
    ? "crit"
    : values.skew > 3
      ? "crit"
      : values.skew === 3
        ? "warn"
        : "ok";
  const capacityHealth = healthFor(values.drainedCapacity, 15, 30);
  const workloadHealth = worst(
    values.removedApi ? "crit" : "ok",
    capacityHealth,
  );
  const nodes: SimNode[] = [
    {
      id: "control-plane",
      label: "Control plane",
      kind: "service",
      health: versionHealth,
      utilization: clamp(values.controlPlane / 33),
      sublabel: values.nodeNewer
        ? `v1.${values.controlPlane} · node newer`
        : `v1.${values.controlPlane} · skew ${values.skew}`,
      detail:
        "Upgrade the control plane first. The API server must be at the target version before nodes move, and a kubelet must never be newer than the API server.",
      meta: { stage: "stable" },
    },
    {
      id: "node-pool",
      label: values.draining ? "Node pool (draining)" : "Node pool",
      kind: "worker",
      health: versionHealth,
      utilization: clamp(values.progress / 100),
      sublabel: `kubelet v1.${values.node} · ${values.drainedNodes} draining`,
      detail:
        "Cordon marks a node unschedulable; drain evicts the pods under the PodDisruptionBudget. New pods can only schedule on nodes that are still ready.",
      meta: { stage: "canary" },
    },
    {
      id: "workloads",
      label: "Workloads",
      kind: "service",
      health: workloadHealth,
      utilization: clamp(values.drainedCapacity / 100),
      sublabel: `${Math.round(values.availableCapacity)}% capacity · ${values.apiErrorRate.toFixed(0)}% removed-API errors`,
      detail: values.removedApi
        ? "A client or manifest calls an API version the target release no longer serves. The control plane can be healthy while every call to that endpoint fails."
        : "The workload is compatible with the target API version. Availability now depends on how much capacity the drain removes.",
      meta: { stage: "full" },
    },
  ];

  return {
    t: 0,
    nodes,
    edges: [
      edge("cp-nodes", "control-plane", "node-pool", 1, versionHealth, "version bound"),
      edge("nodes-workloads", "node-pool", "workloads", clamp(values.availableCapacity / 100), workloadHealth, "serving"),
    ],
    metrics: [
      metric("version-skew", "Version skew", values.skew, " minors", 3, 4, "count"),
      metric("skew-direction", "Kubelet newer than API server", values.nodeNewer ? 1 : 0, "", 0.5, 0.5, "count"),
      metric("api-error-rate", "Removed-API request error rate", values.apiErrorRate, "%", 1, 10, "percent"),
      metric("drained-capacity", "Capacity removed by drain", values.drainedCapacity, "%", 15, 30, "percent"),
      metric("upgrade-progress", "Upgrade progress", values.progress, "%", undefined, undefined, "percent"),
      metric("ready-nodes", "Ready nodes", values.readyNodes, " nodes", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `Control plane v1.${values.controlPlane}, kubelet v1.${values.node}, ${
      values.nodeNewer ? "kubelet newer than the API server" : `skew ${values.skew}`
    }; ${values.drainedNodes} nodes draining, ${Math.round(
      values.availableCapacity,
    )}% capacity; removed-API errors ${values.apiErrorRate.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * 0.02 * Math.sin((index + (seed % 6)) / 3.3);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "version-skew",
    metricId: "version-skew",
    warn: 3,
    crit: 4,
    title: "Version skew is at or beyond the supported skew edge",
    cause:
      "Three minor versions is the edge of the supported window; four or more is outside it. At the edge, the kubelet can still run but is the first to lose compatibility coverage as the control plane moves. Beyond the edge, the kubelet can call APIs the control plane no longer serves in the same way. A kubelet newer than the API server is also unsupported.",
    fix:
      "At the edge, finish the node upgrade promptly. Beyond it, pause the node upgrade and bring the lagging nodes to a supported version. Upgrade the control plane first, then move node pools in batches, and upgrade the kubelets before making further API changes.",
    checkFirst: [
      "Compare kube-apiserver and kubelet versions with kubectl version and kubectl get nodes -o wide.",
      "Check kube-proxy and other node components, not just the kubelet.",
      "Read the version skew policy for the target release before planning the next step.",
    ],
  },
  {
    id: "skew-direction",
    metricId: "skew-direction",
    warn: 0.5,
    crit: 0.5,
    title: "The kubelet is newer than the API server",
    cause:
      "Version skew has a direction. The API server is the reference version, and a node component newer than the API server is outside the supported combination. A small absolute gap does not make this safe.",
    fix:
      "Stop upgrading the node pool until the control plane reaches the same or a newer minor version. Bring the kubelet back to a supported version or finish the control plane upgrade first.",
    checkFirst: [
      "Compare the kube-apiserver and kubelet versions, not only the difference between them.",
      "Check whether a node pool was upgraded ahead of the control plane.",
      "Read the version skew policy for the direction of the supported window.",
    ],
  },
  {
    id: "api-error-rate",
    metricId: "api-error-rate",
    warn: 1,
    crit: 10,
    title: "A workload is calling an API version the cluster no longer serves",
    cause:
      "API versions are deprecated and then removed on a release schedule. A manifest, controller, or client that still uses a removed version receives an error even though the control plane is healthy and the nodes are at a supported version.",
    fix:
      "Update the manifest or client to the served API version before the upgrade. Use the API deprecation guide for the target release, check the deprecated API metrics, and re-apply the manifests on a staging cluster before upgrading production.",
    checkFirst: [
      "Check the API server's deprecated API request metrics and the failing client's error message.",
      "Search manifests, Helm charts, and controllers for the removed apiVersion.",
      "Confirm the replacement version is served by the target release.",
    ],
  },
  {
    id: "drained-capacity",
    metricId: "drained-capacity",
    warn: 15,
    crit: 30,
    title: "The drain removed too much serving capacity",
    cause:
      "Cordon and drain remove a node from scheduling and evict its pods. With a large batch, the remaining nodes may not have enough capacity or may not be able to accept the evicted pods. A PodDisruptionBudget can protect availability and can also block the drain.",
    fix:
      "Drain a smaller batch, add capacity before the upgrade, and confirm the remaining nodes can absorb the evicted pods. Set PodDisruptionBudgets for critical workloads and verify the drain completes rather than stalling.",
    checkFirst: [
      "Compare the remaining ready nodes with the workload's peak demand.",
      "Check whether evicted pods rescheduled or stayed Pending.",
      "Check PodDisruptionBudget status and any blocked eviction.",
    ],
  },
];

export const upgradesModel: SimModel = {
  id: "kubernetes-upgrades",
  visual: "deployment",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults(), 0), seed);
    seedSeries(frame);
    pushEvent(frame, {
      id: "upgrade-plan",
      at: 0,
      severity: "info",
      title: "Upgrade plan loaded",
      detail:
        "The control plane moves first. Nodes follow in batches, with the kubelet version and API compatibility checked before each step.",
    });
    return frame;
  },
  step: (frame, p, dt, rng) => {
    const elapsed = Math.max(0, Number(frame.flags.elapsed ?? 0)) + Math.max(0, dt);
    const values = compute(p, elapsed);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = { ...frame.series };
    next.events = [...frame.events];
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "upgrade-progress" ? { ...item, value: Math.min(100, Math.max(0, item.value * jitter)) } : item,
    );
    next.flags = {
      ...frame.flags,
      ...next.flags,
      elapsed,
      paramsKey: JSON.stringify(p),
    };
    if (values.skewViolation && frame.flags.skewEvent !== 1) {
      pushEvent(next, {
        id: "unsupported-skew",
        severity: "crit",
        title: "The node version is outside the supported skew",
        detail: `The control plane is v1.${values.controlPlane} and the kubelet is v1.${values.node}, a skew of ${values.skew} minor versions. The upgrade plan must bring the nodes back into the supported range.`,
        nodeId: "node-pool",
        metricId: "version-skew",
      });
      next.flags.skewEvent = 1;
    }
    if (!values.skewViolation) next.flags.skewEvent = 0;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p, 0);
    const lines = [
      `Control plane v1.${values.controlPlane}, kubelet v1.${values.node}: a difference of ${values.skew} minor versions.`,
      values.nodeNewer
        ? "The kubelet is newer than the API server. That direction is not supported."
        : values.skew > 3
          ? "The kubelet is beyond the supported older-version bound. Upgrade the nodes before relying on the compatibility guarantee."
          : values.skew === 3
            ? "The skew is at the edge of the supported range. This is the moment to finish the node upgrade."
            : "The versions are within the supported skew.",
      values.removedApi
        ? "A client still calls a removed API. A healthy control plane does not protect that request path."
        : "No removed API is modeled for the workload.",
      `Draining ${values.drainBatch} of ${TOTAL_NODES} nodes at once removes ${Math.round(values.drainedCapacity)}% of serving capacity.`,
    ];
    return lines;
  },
  legend: [
    { label: "Supported and within capacity", tone: "ok" },
    { label: "At the skew or capacity edge", tone: "warn" },
    { label: "Unsupported skew or API failure", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "A one-minor skew, a compatible API set, and one node drained at a time.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "At the skew edge",
    description: "The kubelet is three minors behind and two nodes drain at once, leaving less headroom.",
    tone: "warn",
    params: defaults({ controlPlaneMinor: 32, nodeMinor: 29, removedApiInUse: 0, drainBatch: 2 }),
  },
  {
    id: "failure",
    label: "Unsupported skew",
    description: "Four minors of skew, a removed API in use, and six nodes draining at once.",
    tone: "crit",
    params: defaults({ controlPlaneMinor: 33, nodeMinor: 29, removedApiInUse: 1, drainBatch: 6 }),
  },
  {
    id: "recovery",
    label: "Supported and drained safely",
    description: "The nodes are upgraded to a one-minor skew, the removed API is fixed, and drains run one node at a time.",
    tone: "ok",
    params: defaults({ controlPlaneMinor: 32, nodeMinor: 31, removedApiInUse: 0, drainBatch: 1 }),
  },
  {
    id: "removed-api",
    label: "Removed API",
    description: "The versions match, but a workload still calls an API version the release removed.",
    tone: "crit",
    params: defaults({ controlPlaneMinor: 32, nodeMinor: 32, removedApiInUse: 1, drainBatch: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-skew-bound",
  title: "Predict whether a four-minor skew is supported",
  simId: "upgrades",
  question:
    "The control plane runs v1.33 and the worker kubelets run v1.29. No workload uses a removed API. Is this version combination supported?",
  prediction: {
    options: [
      { id: "yes", label: "Yes. Any skew is supported as long as the API server is newer" },
      { id: "no", label: "No. A kubelet may be at most three minor versions older than the API server" },
      { id: "proxy", label: "Yes, but only if kube-proxy is the same version as the kubelet" },
      { id: "api", label: "Yes, because no removed API is in use" },
    ],
    correctOptionId: "no",
    explanation:
      "Kubernetes publishes a version skew policy with a bounded window between the API server and the kubelet. A kubelet more than three minor versions older is outside that window, and a kubelet newer than the API server is also unsupported. The absence of a removed API removes one failure mode, not the version constraint. The fix is to bring the nodes into the supported range before making further control plane changes.",
  },
  setup: defaults({ controlPlaneMinor: 33, nodeMinor: 29, removedApiInUse: 0, drainBatch: 1 }),
  runFor: 20,
  observe: [
    "The skew metric reads four minors and crosses critical.",
    "Removed-API errors stay at zero because no removed API is in use.",
    "The node pool and control plane report a version problem even though the workloads are compatible.",
    "Bringing the kubelet to v1.32 or v1.33 clears the skew and restores a supported combination.",
  ],
  explain:
    "The version bound is about compatibility between components, not about the workload's API calls. A supported skew can still fail on a removed API, and a compatible API set does not make an unsupported skew safe. Check both independently before an upgrade.",
  fix: defaults({ controlPlaneMinor: 33, nodeMinor: 32, removedApiInUse: 0, drainBatch: 1 }),
  debrief:
    "The fixed state has a one-minor skew and no removed API. The control plane stays ahead, and the nodes move in batches. An upgrade plan checks versions, API compatibility, and capacity together because each one fails in a different layer.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Kubernetes cluster upgrade moves the control plane and then the nodes to a new minor version. The components do not have to be identical, but they have a supported version skew. The kube-apiserver is the reference: a kubelet may be older within the published bound, and a kubelet must not be newer than the API server. The skew policy is a compatibility contract, not a suggestion.",
  },
  {
    type: "p",
    text: "A second, independent risk is API removal. Kubernetes deprecates an API version, serves it for a transition period, and then removes it. A workload that still uses the removed version fails after the upgrade even if every component version is supported. The control plane can be healthy and the pods can be running while a controller or manifest cannot read or write the object it needs.",
  },
  {
    type: "p",
    text: "The node upgrade itself changes capacity. Cordon marks a node unschedulable, and drain evicts its pods so the node can be upgraded. PodDisruptionBudgets bound voluntary disruption, but they can also block a drain. The safe batch size is the one whose remaining capacity covers peak demand and can absorb the evicted pods.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "table",
    headers: ["Layer", "Upgrade question", "Failure mode"],
    rows: [
      ["Control plane", "Is the API server at the target version first?", "Nodes ahead of the API server are unsupported"],
      ["Kubelet and node components", "Is the skew inside the published bound?", "Unsupported skew and incompatible node behavior"],
      ["API clients and manifests", "Does anything call a removed version?", "404 or 410 on the removed endpoint"],
      ["Drain and capacity", "Can the remaining nodes carry the load?", "Pending replacements and lost serving capacity"],
      ["PodDisruptionBudget", "Does the drain respect availability?", "The drain stalls or evicts too much"],
    ],
  },
  {
    type: "p",
    text: "The model uses 12 nodes, 10 seconds per drain batch, and a 15% and 30% capacity-loss line as illustrative values. The skew direction and the existence of a supported bound come from the Kubernetes version skew policy; the exact supported window changes across releases, so check it for the version you are moving to.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The control plane and kubelet minor versions, and the resulting skew.",
      "Removed-API errors from a workload that still calls a removed version.",
      "Capacity removed by the current drain batch and the nodes still ready.",
      "Upgrade progress, which shows whether the drain is moving or stalled.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with a one-minor skew. Apply At the skew edge and watch the warning without a critical API failure. Then apply Unsupported skew to combine a four-minor gap, a removed API, and a large drain batch. Compare Removed API, where the versions match but the workload still fails.",
  },
  { type: "sim", simId: "upgrades" },
  { type: "experiment", experimentId: "predict-skew-bound" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The failure preset put the control plane four minors ahead of the kubelets, kept a removed API in use, and drained half the nodes at once. Three independent signals crossed their lines: the version skew, the removed-API request error rate, and the capacity removed by the drain. Fixing only one would still have left the upgrade unsafe.",
  },
  {
    type: "p",
    text: "The recovery preset brought the nodes within one minor, updated the removed API, and drained one node at a time. The Removed API preset showed that matching versions do not protect a client that calls an endpoint the release no longer serves.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "kubectl version and the kubelet version reported by each node in kubectl get nodes -o wide.",
      "API server metrics for deprecated API requests and the client error message for the removed endpoint.",
      "Node status during cordon and drain, plus the PodDisruptionBudget status.",
      "Pods that stay Pending after eviction because the remaining nodes lack capacity.",
      "The upgrade plan's target release and the deprecation guide for every API version in the manifests.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check versions and API compatibility separately before touching capacity. Confirm the kubelet skew is inside the published bound, then search manifests and controllers for removed API versions. Only then choose a drain batch that leaves enough capacity for peak demand.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the target release's version skew policy and upgrade order.",
      "Upgrade the control plane before the nodes.",
      "Update manifests and clients that use a deprecated or removed API version.",
      "Drain one batch at a time and confirm evicted pods reschedule.",
      "Check the PodDisruptionBudget and the remaining capacity before the next batch.",
      "Verify the final skew and run the workload's smoke test against the new version.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A larger drain batch upgrades faster and removes more capacity at once.",
      "A small batch preserves availability and extends the maintenance window.",
      "A PodDisruptionBudget protects availability and can block a drain when replicas are already unhealthy.",
      "Staying on an older supported version buys time and delays the API removal you will eventually have to handle.",
      "Skipping minor versions reduces work per step and is not supported by the project's upgrade guidance.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "skew-direction",
    question:
      "The control plane is v1.32 and a node's kubelet is v1.29. Is that supported, and what would you do next?",
    difficulty: 2,
    hints: [
      "The skew has a direction and a bound.",
      "The API server is the reference version.",
    ],
    answer:
      "I would check the version skew policy for the target release. In general a kubelet may be older than the API server within a published bound and must not be newer. At three minors the node is at the edge of the supported window, so I would finish the node upgrade before making further control plane changes. I would also check kube-proxy and the other node components, then drain one node at a time and confirm the workloads reschedule.",
    followUps: [
      "What changes if the kubelet is newer than the API server?",
      "How does the skew policy differ for kubectl?",
      "Why does the control plane go first?",
    ],
    redFlags: [
      "Treats any skew as supported.",
      "Upgrades nodes before the control plane.",
      "Checks only the kubelet and ignores other node components.",
    ],
    rubric: [
      "Names the direction of the bound.",
      "Checks the target release policy.",
      "Orders the upgrade correctly.",
      "Plans a safe drain.",
    ],
  },
  {
    id: "removed-api",
    question:
      "The upgrade succeeds but a CronJob controller logs errors about a resource it cannot read. The nodes are at a supported version. What do you check?",
    difficulty: 3,
    hints: [
      "Version skew and API availability are separate.",
      "The error may name an apiVersion rather than a resource.",
    ],
    answer:
      "I would check whether the controller or its manifests use an API version that the target release removed. A supported component skew does not keep a removed endpoint alive. I would read the error for the group and version, search the manifests, Helm charts, and controller image, and compare them with the deprecation guide. The fix is to update the client or manifest to the served version and redeploy it, not to change the node version.",
    followUps: [
      "How would you find every manifest that uses the removed version?",
      "What metric shows deprecated API usage before the upgrade?",
      "Can a removed API be re-enabled?",
    ],
    redFlags: [
      "Blaming the kubelet version without reading the error.",
      "Assumes a supported skew means every API is served.",
      "Re-applies the same manifest.",
    ],
    rubric: [
      "Separates skew from API removal.",
      "Reads the group and version in the error.",
      "Searches manifests and clients.",
      "Updates to the served version.",
    ],
  },
  {
    id: "drain-capacity",
    question:
      "You need to upgrade 12 nodes. How do you choose the drain batch size, and what can block the drain?",
    difficulty: 3,
    hints: [
      "The remaining nodes must carry peak demand.",
      "A PodDisruptionBudget can refuse an eviction.",
    ],
    answer:
      "I would size the batch so the remaining ready nodes can carry peak demand with headroom, including the pods that are evicted from the batch. I would check that those pods can schedule elsewhere, then drain one batch and verify before continuing. A PodDisruptionBudget can block evictions when the workload is already below its minimum available replicas. I would also check for local storage or a single-replica workload that cannot move, and pause the upgrade rather than force the drain.",
    followUps: [
      "How would you handle a workload with a single replica?",
      "What does drain do that cordon does not?",
      "How would you prove the remaining capacity is enough?",
    ],
    redFlags: [
      "Drains all nodes at once.",
      "Forces eviction past a PDB without a decision.",
      "Ignores where evicted pods will schedule.",
    ],
    rubric: [
      "Sizes the batch from peak demand.",
      "Checks replacement capacity.",
      "Names PDB and local storage as blockers.",
      "Verifies each batch.",
    ],
  },
];

const checklist = [
  {
    title: "Before the upgrade",
    items: [
      "Read the target release's version skew policy and upgrade order.",
      "Inventory every manifest and client for deprecated or removed API versions.",
      "Confirm the remaining capacity can carry peak demand during a drain.",
      "Review PodDisruptionBudgets and single-replica workloads.",
    ],
  },
  {
    title: "During the upgrade",
    items: [
      "Upgrade the control plane first and verify it is healthy.",
      "Cordon and drain one batch, then confirm evicted pods reschedule.",
      "Watch removed-API request errors and the version skew of the nodes still to upgrade.",
      "Pause on a blocked drain rather than forcing eviction.",
    ],
  },
  {
    title: "After the upgrade",
    items: [
      "Verify the final control plane and kubelet versions.",
      "Run the workload smoke test against the new API version.",
      "Confirm every node is schedulable again.",
      "Record the APIs that were removed and update the next upgrade plan.",
    ],
  },
];

const references = [
  {
    title: "Version skew policy",
    url: "https://kubernetes.io/releases/version-skew-policy/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Supported version differences between the API server, kubelet, kube-proxy, and kubectl.",
  },
  {
    title: "Upgrading a cluster",
    url: "https://kubernetes.io/docs/tasks/administer-cluster/cluster-upgrade/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Control plane and node upgrade order, cordon, and drain.",
  },
  {
    title: "Deprecated API migration guide",
    url: "https://kubernetes.io/docs/reference/using-api/deprecation-guide/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Removed API versions and their replacements by release.",
  },
  {
    title: "Safely drain a node",
    url: "https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/",
    publisher: "Kubernetes documentation",
    kind: "docs" as const,
    note: "Cordon, drain, eviction, and PodDisruptionBudget behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    upgrades: {
      model: upgradesModel,
      presets,
      instructions:
        "Start Healthy with a one-minor skew. Apply At the skew edge to see the warning, then Unsupported skew to combine version, API, and capacity failures. Compare Removed API, where only the client is wrong.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 12 nodes, 10-second drain batches, and 15% and 30% capacity lines are teaching values; verify the supported skew for your target release.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["deployment-canary-capacity", "kubernetes-node-pressure", "kubernetes-incident-debug"],
};
