import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type {
  Health,
  ParamSpec,
  Params,
  SimFrame,
  SimModel,
  SimPreset,
  ThresholdSpec,
} from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NODE_MEMORY_MIB = 8_192;
const OTHER_MEMORY_MIB = 4_096;
const OTHER_CPU_MILLI = 2_000;
const CPU_USAGE_MILLI = 1_200;
const MEMORY_USAGE_MIB = 1_800;

const params: ParamSpec[] = [
  {
    id: "nodeCpuCores",
    label: "Node CPU capacity",
    min: 2,
    max: 16,
    step: 1,
    value: 4,
    unit: " cores",
    group: "Node",
    help: "Allocatable CPU on the node. Other workloads already request 2,000 millicores in this illustrative model.",
    format: "count",
  },
  {
    id: "cpuRequest",
    label: "Pod CPU request",
    min: 0,
    max: 4_000,
    step: 100,
    value: 500,
    unit: " m",
    group: "Pod",
    help: "CPU the scheduler reserves for this pod. Zero means no request; if a CPU limit is set, Kubernetes copies that limit into the request. The request is used for placement, not as a runtime ceiling.",
    format: "count",
  },
  {
    id: "cpuLimit",
    label: "Pod CPU limit",
    min: 0,
    max: 8_000,
    step: 100,
    value: 2_000,
    unit: " m",
    group: "Pod",
    help: "CPU ceiling enforced by the cgroup. Zero means no limit. A limit below actual CPU use causes throttling, not termination.",
    format: "count",
  },
  {
    id: "memoryRequest",
    label: "Pod memory request",
    min: 0,
    max: 4_096,
    step: 128,
    value: 512,
    unit: " MiB",
    group: "Pod",
    help: "Memory the scheduler reserves. Zero means no request; if a memory limit is set, Kubernetes copies that limit into the request. The node has 4,096 MiB of unreserved memory in this model.",
    format: "count",
  },
  {
    id: "memoryLimit",
    label: "Pod memory limit",
    min: 0,
    max: 8_192,
    step: 128,
    value: 2_048,
    unit: " MiB",
    group: "Pod",
    help: "Memory ceiling enforced per container. Zero means no limit. Exceeding it causes an OOM kill even when the node has free memory.",
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

type Qos = "Guaranteed" | "Burstable" | "BestEffort";

interface Values {
  nodeCpu: number;
  cpuRequest: number;
  cpuLimit: number;
  memoryRequest: number;
  memoryLimit: number;
  effectiveCpuRequest: number;
  effectiveMemoryRequest: number;
  cpuRequestDefaulted: boolean;
  memoryRequestDefaulted: boolean;
  qos: Qos;
  freeCpu: number;
  freeMemory: number;
  scheduled: boolean;
  invalid: boolean;
  oom: boolean;
  throttle: number;
  cpuUsed: number;
  nodeCpuUtil: number;
  nodeMemoryFree: number;
  restarts: number;
  ready: boolean;
}

function qosFor(
  cpuRequest: number,
  cpuLimit: number,
  memoryRequest: number,
  memoryLimit: number,
): Qos {
  const hasRequest = cpuRequest > 0 || memoryRequest > 0;
  const hasLimit = cpuLimit > 0 || memoryLimit > 0;
  if (!hasRequest && !hasLimit) return "BestEffort";
  if (
    cpuRequest > 0 &&
    memoryRequest > 0 &&
    cpuLimit === cpuRequest &&
    memoryLimit === memoryRequest
  ) {
    return "Guaranteed";
  }
  return "Burstable";
}

function compute(p: Params): Values {
  const cores = Math.round(clamp(num(p, "nodeCpuCores", 4), 2, 16));
  const cpuRequest = clamp(num(p, "cpuRequest", 500), 0, 4_000);
  const cpuLimit = clamp(num(p, "cpuLimit", 2_000), 0, 8_000);
  const memoryRequest = clamp(num(p, "memoryRequest", 512), 0, 4_096);
  const memoryLimit = clamp(num(p, "memoryLimit", 2_048), 0, 8_192);
  const cpuRequestDefaulted = cpuRequest === 0 && cpuLimit > 0;
  const memoryRequestDefaulted = memoryRequest === 0 && memoryLimit > 0;
  const effectiveCpuRequest = cpuRequestDefaulted ? cpuLimit : cpuRequest;
  const effectiveMemoryRequest = memoryRequestDefaulted ? memoryLimit : memoryRequest;
  const nodeCpu = cores * 1_000;
  const freeCpu = Math.max(0, nodeCpu - OTHER_CPU_MILLI);
  const freeMemory = Math.max(0, NODE_MEMORY_MIB - OTHER_MEMORY_MIB);
  const invalid =
    (cpuLimit > 0 && cpuRequest > 0 && cpuLimit < cpuRequest) ||
    (memoryLimit > 0 && memoryRequest > 0 && memoryLimit < memoryRequest);
  const scheduled =
    !invalid && effectiveCpuRequest <= freeCpu && effectiveMemoryRequest <= freeMemory;
  const oom = scheduled && memoryLimit > 0 && MEMORY_USAGE_MIB > memoryLimit;
  const throttled = scheduled && cpuLimit > 0 && CPU_USAGE_MILLI > cpuLimit;
  const cpuUsed =
    scheduled && !oom ? Math.min(CPU_USAGE_MILLI, cpuLimit > 0 ? cpuLimit : CPU_USAGE_MILLI) : 0;
  const throttle = throttled ? (1 - cpuLimit / CPU_USAGE_MILLI) * 100 : 0;
  const nodeCpuUtil = Math.min(100, ((OTHER_CPU_MILLI + cpuUsed) / nodeCpu) * 100);
  const nodeMemoryFree = Math.max(0, freeMemory - (scheduled ? effectiveMemoryRequest : 0));
  return {
    nodeCpu,
    cpuRequest,
    cpuLimit,
    memoryRequest,
    memoryLimit,
    effectiveCpuRequest,
    effectiveMemoryRequest,
    cpuRequestDefaulted,
    memoryRequestDefaulted,
    qos: qosFor(effectiveCpuRequest, cpuLimit, effectiveMemoryRequest, memoryLimit),
    freeCpu,
    freeMemory,
    scheduled,
    invalid,
    oom,
    throttle,
    cpuUsed,
    nodeCpuUtil,
    nodeMemoryFree,
    restarts: oom ? 3 : 0,
    ready: scheduled && !oom,
  };
}

function buildFrame(values: Values, seed: number): SimFrame {
  const scheduler: Health = values.scheduled ? "ok" : "crit";
  const node: Health = values.scheduled ? (values.nodeCpuUtil >= 90 ? "warn" : "ok") : "warn";
  const pod: Health = !values.scheduled
    ? "down"
    : values.oom
      ? "crit"
      : values.throttle > 0
        ? "warn"
        : "ok";
  const cgroup: Health = values.oom ? "crit" : values.throttle > 0 ? "warn" : "ok";
  const cpuRequestText = values.cpuRequestDefaulted
    ? `${values.effectiveCpuRequest.toLocaleString()}m (copied from limit)`
    : `${values.effectiveCpuRequest.toLocaleString()}m`;
  const memoryRequestText = values.memoryRequestDefaulted
    ? `${values.effectiveMemoryRequest} MiB (copied from limit)`
    : `${values.effectiveMemoryRequest} MiB`;
  const reason = !values.scheduled
    ? values.invalid
      ? "Rejected: request or limit is invalid"
      : "Pending: request does not fit"
    : values.oom
      ? "OOMKilled by the container memory limit"
      : values.throttle > 0
        ? "Running but CPU throttled"
        : "Running within requests and limits";
  return {
    t: 0,
    nodes: [
      {
        id: "scheduler",
        label: "kube-scheduler",
        kind: "service",
        health: scheduler,
        utilization: clamp(values.effectiveCpuRequest / Math.max(1, values.freeCpu)),
        sublabel: values.scheduled ? "request fits node headroom" : "no node fits the request",
        detail: `The scheduler uses requests, not limits. This node has ${values.freeCpu.toLocaleString()}m of unreserved CPU and the pod schedules with ${cpuRequestText}.`,
        meta: { view: "flow" },
      },
      {
        id: "node",
        label: "Node",
        kind: "service",
        health: node,
        utilization: clamp(values.nodeCpuUtil / 100),
        sublabel: `${values.nodeMemoryFree.toLocaleString()} MiB unreserved · ${Math.round(values.nodeCpuUtil)}% CPU`,
        detail: `The node has ${values.nodeCpu.toLocaleString()}m of CPU and 8,192 MiB of memory in this model. ${values.freeMemory.toLocaleString()} MiB is unreserved before this pod's effective request.`,
        meta: { view: "flow" },
      },
      {
        id: "pod",
        label: "Pod: api",
        kind: "service",
        health: pod,
        utilization: clamp(values.ready ? 1 : 0),
        sublabel: `${values.qos} · ${values.oom ? `${values.restarts} restarts` : values.scheduled ? "scheduled" : "not scheduled"}`,
        detail: `${reason}. Effective requests: ${cpuRequestText} CPU, ${memoryRequestText} memory. Limits: ${values.cpuLimit > 0 ? `${values.cpuLimit}m CPU` : "no CPU limit"}, ${values.memoryLimit > 0 ? `${values.memoryLimit} MiB memory` : "no memory limit"}.`,
        meta: { view: "flow" },
      },
      {
        id: "cgroup",
        label: "Container cgroup",
        kind: "service",
        health: cgroup,
        utilization: clamp(
          values.cpuUsed / Math.max(1, values.cpuLimit > 0 ? values.cpuLimit : values.nodeCpu),
        ),
        sublabel: values.oom
          ? `memory ${MEMORY_USAGE_MIB} / ${values.memoryLimit} MiB`
          : values.throttle > 0
            ? `CPU throttled ${Math.round(values.throttle)}%`
            : "within limits",
        detail:
          "The kubelet configures cgroup limits. CPU is compressible and is throttled; memory is not compressible and an over-limit container is OOM-killed.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge(
        "scheduler-node",
        "scheduler",
        "node",
        clamp(values.effectiveCpuRequest / Math.max(1, values.freeCpu)),
        scheduler,
        "bind",
      ),
      edge("node-pod", "node", "pod", clamp(values.ready ? 1 : 0), node, "run"),
      edge("pod-cgroup", "pod", "cgroup", clamp(values.scheduled ? 1 : 0), pod, "limits"),
    ],
    metrics: [
      metric("pending-pods", "Pending pods", values.scheduled ? 0 : 1, " pods", 0.5, 1, "count"),
      metric("oom-kills", "OOM kills", values.oom ? 3 : 0, " restarts", 0.5, 1, "count"),
      metric("cpu-throttle", "CPU throttled", values.throttle, "%", 10, 50, "percent"),
      metric(
        "pod-ready",
        "Pod Ready",
        values.ready ? 1 : 0,
        " pods",
        undefined,
        undefined,
        "count",
      ),
      metric(
        "node-memory-free",
        "Node memory unreserved",
        values.nodeMemoryFree,
        " MiB",
        undefined,
        undefined,
        "number",
      ),
      metric(
        "node-cpu-util",
        "Node CPU use",
        values.nodeCpuUtil,
        "%",
        undefined,
        undefined,
        "percent",
      ),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      qos: values.qos,
      ready: values.ready,
      oom: values.oom,
      throttle: values.throttle,
      scheduled: values.scheduled,
    },
    summary: `${reason}. QoS ${values.qos}; ${values.nodeMemoryFree.toLocaleString()} MiB free on the node.`,
  };
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = 0.02 * Math.sin((index + (seed % 6)) / 3.6);
      return Math.max(0, item.value * (1 + wave));
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "pending-pods",
    metricId: "pending-pods",
    warn: 0.5,
    crit: 1,
    title: "The pod cannot be scheduled",
    cause:
      "The CPU or memory request is larger than the unreserved capacity on every eligible node, or the request and limit form an invalid spec. The scheduler uses requests; a generous limit does not help a pod with an unschedulable request.",
    fix: "Lower the request, add capacity, or remove a placement constraint. Check that the limit is greater than or equal to the request. Do not raise the limit to fix a scheduling failure.",
    checkFirst: [
      "Read FailedScheduling events from kubectl describe pod.",
      "Compare requests with node allocatable and existing requests.",
      "Check taints, affinity, and whether the limit is below the request.",
    ],
  },
  {
    id: "oom-kills",
    metricId: "oom-kills",
    warn: 0.5,
    crit: 1,
    title: "The container exceeded its memory limit",
    cause:
      "The container's working set is above its cgroup memory limit. The kernel kills the process even when the node has free memory, because the limit is enforced inside the container's cgroup, not at the node level.",
    fix: "Raise the memory limit or reduce the working set. Check for a leak before raising the limit indefinitely. A memory request lower than the limit does not protect the container from its own limit.",
    checkFirst: [
      "Check the pod's last state for OOMKilled and the container memory limit.",
      "Compare the working set with the limit over time, not at one sample.",
      "Check node memory headroom to confirm the kill is local to the container.",
    ],
  },
  {
    id: "cpu-throttle",
    metricId: "cpu-throttle",
    warn: 10,
    crit: 50,
    title: "CPU throttling is adding latency",
    cause:
      "The CPU limit is below the container's demand. The kernel throttles the cgroup for the rest of each scheduling period, so requests queue while the node may still have idle CPU.",
    fix: "Raise or remove the CPU limit if the node has headroom, or reduce CPU work. Check the throttled-period ratio before changing requests; requests affect placement, limits affect runtime.",
    checkFirst: [
      "Check the container CPU throttled periods and throttled seconds metrics.",
      "Compare CPU usage with the limit and the node's free capacity.",
      "Check whether the latency increase tracks throttling or downstream load.",
    ],
  },
];

export const requestsLimitsModel: SimModel = {
  id: "requests-limits",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(values, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, points]) => [key, [...points]]),
    );
    next.events = [...frame.events];
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items = [
      `The scheduler reserves effective requests of ${values.effectiveCpuRequest.toLocaleString()}m CPU and ${values.effectiveMemoryRequest} MiB. The node has ${values.freeCpu.toLocaleString()}m CPU and ${values.freeMemory.toLocaleString()} MiB unreserved in this model.`,
      `The container uses ${CPU_USAGE_MILLI.toLocaleString()}m CPU and ${MEMORY_USAGE_MIB} MiB memory. Its limits are ${values.cpuLimit > 0 ? `${values.cpuLimit}m CPU` : "unset for CPU"} and ${values.memoryLimit > 0 ? `${values.memoryLimit} MiB memory` : "unset for memory"}.`,
    ];
    if (values.cpuRequestDefaulted || values.memoryRequestDefaulted) {
      items.push(
        "An omitted request was copied from its limit. Kubernetes does this defaulting before scheduling, so a pod with only limits is scheduled and classified using those limits as requests.",
      );
    }
    if (values.invalid) {
      items.push(
        "The spec is invalid because a limit is below its request. Kubernetes rejects the pod before scheduling, so neither throttling nor OOM is the cause.",
      );
    } else if (!values.scheduled) {
      items.push(
        "The pod is Pending because the request does not fit the node's unreserved capacity. Limits are irrelevant to this failure; the scheduler only sees requests.",
      );
    } else if (values.oom) {
      items.push(
        `The container is OOM-killed at ${values.memoryLimit} MiB while the node still has free memory. The cgroup limit is the boundary, not the node's total memory.`,
      );
    } else if (values.throttle > 0) {
      items.push(
        `The container is throttled by ${Math.round(values.throttle)}% because its CPU limit is below demand. The pod can stay Ready while latency climbs, which makes this a tail-latency failure rather than a restart.`,
      );
    } else {
      items.push(
        "The container is inside both limits. Requests reserve capacity, limits cap usage, and the QoS class reflects how the two compare.",
      );
    }
    items.push(
      `QoS is ${values.qos}. Guaranteed requires requests equal to limits for CPU and memory; BestEffort has neither; Burstable is everything in between. QoS affects eviction order under node pressure, not cgroup enforcement.`,
    );
    return items;
  },
  legend: [
    { label: "Within limits", tone: "ok" },
    { label: "Throttled", tone: "warn" },
    { label: "OOM or pending", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description:
      "Requests fit the node, the CPU limit is above demand, and the memory limit leaves room for the working set.",
    tone: "ok",
    params: defaults({
      nodeCpuCores: 4,
      cpuRequest: 500,
      cpuLimit: 2_000,
      memoryRequest: 512,
      memoryLimit: 2_048,
    }),
  },
  {
    id: "peak",
    label: "CPU limit pressure",
    description:
      "A 1,000m CPU limit is below the 1,200m demand. The pod stays Ready while throttling adds latency.",
    tone: "warn",
    params: defaults({
      nodeCpuCores: 4,
      cpuRequest: 500,
      cpuLimit: 1_000,
      memoryRequest: 512,
      memoryLimit: 2_048,
    }),
  },
  {
    id: "failure",
    label: "OOMKilled with node headroom",
    description:
      "The memory limit is 1,024 MiB, the working set is 1,800 MiB, and the node still has free memory.",
    tone: "crit",
    params: defaults({
      nodeCpuCores: 4,
      cpuRequest: 500,
      cpuLimit: 2_000,
      memoryRequest: 512,
      memoryLimit: 1_024,
    }),
  },
  {
    id: "throttled",
    label: "Severe CPU throttling",
    description:
      "A 400m CPU limit against 1,200m of demand throttles most of each period and raises p99.",
    tone: "crit",
    params: defaults({
      nodeCpuCores: 4,
      cpuRequest: 400,
      cpuLimit: 400,
      memoryRequest: 512,
      memoryLimit: 2_048,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description:
      "The memory limit is raised above the working set and the pod stays Ready with node headroom.",
    tone: "ok",
    params: defaults({
      nodeCpuCores: 4,
      cpuRequest: 1_024,
      cpuLimit: 2_000,
      memoryRequest: 1_024,
      memoryLimit: 2_560,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-container-oom",
  title: "Predict why the pod is OOMKilled",
  simId: "requests-limits",
  question:
    "A pod is OOMKilled while its node has 3,500 MiB of free memory. The container memory limit is 1,024 MiB and its working set is about 1,800 MiB. What killed it?",
  prediction: {
    options: [
      { id: "limit", label: "The container memory limit is below its working set" },
      { id: "node", label: "The node ran out of memory" },
      { id: "request", label: "The memory request is larger than the limit" },
      { id: "cpu", label: "The CPU limit is throttling the OOM killer" },
    ],
    correctOptionId: "limit",
    explanation:
      "Memory limits are enforced per container cgroup. The working set exceeds the 1,024 MiB limit, so the kernel kills the container process regardless of free memory on the node. A request above the limit would be rejected as an invalid spec, not run and then OOM.",
  },
  setup: defaults({
    nodeCpuCores: 4,
    cpuRequest: 500,
    cpuLimit: 2_000,
    memoryRequest: 512,
    memoryLimit: 1_024,
  }),
  runFor: 20,
  observe: [
    "The pod restarts and reports OOMKilled with the memory limit as the boundary.",
    "The node still reports thousands of MiB free; node capacity is not the limit that fired.",
    "The memory request is below the limit, so the spec is valid.",
    "Raising the limit above the working set stops the restarts.",
  ],
  explain:
    "A request is a scheduling reservation. A limit is a runtime ceiling enforced by the kubelet through cgroups. CPU is compressible, so exceeding its limit causes throttling. Memory is not compressible, so exceeding its limit causes an OOM kill inside the container's cgroup. The node can be nearly idle and the container can still be killed by its own limit.",
  fix: defaults({
    nodeCpuCores: 4,
    cpuRequest: 512,
    cpuLimit: 2_000,
    memoryRequest: 512,
    memoryLimit: 2_560,
  }),
  debrief:
    "The fix raised the container limit above the working set, not the node size. The distinction matters because adding nodes does nothing for a per-container OOM. If the working set keeps growing, the limit is a symptom; find the leak before raising it again.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A request is the CPU or memory the scheduler reserves for a pod. A limit is the runtime ceiling the kubelet enforces through the container's cgroup. They answer different questions. The request asks whether the pod fits on a node. The limit asks how much the container may consume once it runs. If you set a limit and omit the request, Kubernetes copies the limit into the request for that resource; setting a request explicitly still controls scheduling separately from the limit.",
  },
  {
    type: "p",
    text: "CPU is compressible: when a container reaches its CPU limit, the kernel throttles it for the rest of the scheduling period. The process continues, but it runs slower. Memory is not compressible: when a container reaches its memory limit, the kernel OOM-kills the process inside that cgroup. The node may have free memory and the pod can still be killed. A node-level OOM is a separate event; confirm the node itself was under memory pressure before blaming the container limit.",
  },
  {
    type: "table",
    headers: ["Setting", "Used by", "Failure when wrong", "First signal"],
    rows: [
      [
        "CPU request",
        "Scheduler placement",
        "Pod stays Pending if no node fits",
        "FailedScheduling event",
      ],
      [
        "CPU limit",
        "cgroup runtime ceiling",
        "Throttling and higher latency",
        "Throttled periods and p99",
      ],
      [
        "Memory request",
        "Scheduler placement",
        "Pod stays Pending if no node fits",
        "FailedScheduling event",
      ],
      [
        "Memory limit",
        "cgroup runtime ceiling",
        "OOMKilled despite node headroom",
        "Last state and restart count",
      ],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The scheduler reads requests and node allocatable capacity. The kubelet reads limits and configures cgroups for each container. A pod can be scheduled on a node with plenty of free memory and then be killed by its own limit. That is why node-level dashboards can look healthy while one container restarts: the limit is inside the pod, not at the node boundary.",
  },
  {
    type: "p",
    text: "Requests and limits also determine QoS. Guaranteed means requests equal limits for CPU and memory on every container. BestEffort means no requests or limits. Burstable is everything else. QoS affects which pods are evicted first when the node itself comes under pressure: BestEffort first, then Burstable, with Guaranteed protected longest. It does not change cgroup enforcement of a container limit.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Pending pods: whether requests fit the node's unreserved CPU and memory.",
      "OOM kills: restarts caused by a container memory limit below its working set.",
      "CPU throttled: the share of CPU demand refused by the limit.",
      "Node memory unreserved: headroom that does not protect a container from its own limit.",
      "QoS class: how requests and limits compare across the pod's containers.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply CPU limit pressure to see throttling without a restart. Apply OOMKilled with node headroom and compare the pod state with the node's free memory. Apply Severe CPU throttling, run the experiment before revealing the explanation, then apply Recovery.",
  },
  {
    type: "p",
    text: "Read the failure before changing a number. Pending means requests do not fit. OOMKilled means the memory limit is below the working set. Throttling means the CPU limit is below demand. Raising a limit fixes a runtime ceiling and does nothing for scheduling; lowering a request fixes scheduling and does nothing for a limit.",
  },
  { type: "sim", simId: "requests-limits" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The OOM preset set a 1,024 MiB memory limit while the container's working set was 1,800 MiB. The kernel killed the process inside the container cgroup, and the pod restarted. The node still had thousands of MiB free, because the node's memory and the container's memory limit are different boundaries. The request stayed below the limit, so the pod was scheduled normally.",
  },
  {
    type: "p",
    text: "The CPU-throttle preset showed the other limit behavior: the pod stayed Ready while its CPU was capped, so the symptom was latency rather than restarts. Recovery raised the memory limit above the working set and the pod stayed up. In both cases the request controlled placement; the limit controlled runtime behavior.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Pod last state and restart reason, including OOMKilled.",
      "Container memory working set and limit over time, not a single sample.",
      "CPU throttled periods and throttled seconds per container.",
      "Node allocatable, requested, and free CPU and memory.",
      "FailedScheduling events when a request does not fit any node.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the pod's state before changing any number. OOMKilled points at the memory limit. Pending points at the request and node capacity. Throttling points at the CPU limit. Check that the limit is at least the request; an invalid pair is rejected before any of these runtime failures.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read pod events and last state to classify the failure.",
      "For Pending, lower the request, add capacity, or fix placement constraints.",
      "For OOMKilled, raise the memory limit or reduce the working set.",
      "For throttling, raise or remove the CPU limit if the node has headroom.",
      "Verify that every limit is greater than or equal to its request.",
      "Recheck QoS and eviction behavior after changing the pair.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Lower requests improve scheduling density and increase the risk of node-level contention.",
      "Higher limits reduce throttling and OOM risk and allow one workload to consume more node capacity.",
      "Guaranteed QoS protects against eviction and reduces scheduling flexibility.",
      "BestEffort maximizes density and is evicted first under node pressure.",
      "A memory limit protects the node from a runaway container and can kill a container that would have fit in free node memory.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "oom-node-free",
    question:
      "A pod is OOMKilled while the node has free memory. How do you explain that and what do you change?",
    difficulty: 2,
    hints: [
      "The node boundary and the container cgroup boundary are different.",
      "Check the last state and the container memory limit.",
    ],
    answer:
      "I would check the pod's last state for OOMKilled and compare the container working set with its memory limit. A per-container limit is enforced by the cgroup, so the kernel can kill the process even when the node has free memory. I would confirm the request is below the limit and then raise the limit or reduce the working set. Adding nodes would not fix a container limit, and raising the request alone would not change runtime enforcement.",
    followUps: [
      "What would a node-level OOM look like instead?",
      "How would you distinguish a leak from a working set that is simply larger than the limit?",
      "When would you remove the memory limit?",
    ],
    redFlags: [
      "Adds nodes for a container limit.",
      "Raises the request instead of the limit.",
      "Ignores the last state.",
    ],
    rubric: [
      "Names the cgroup boundary.",
      "Checks last state and limit.",
      "Separates request from limit.",
      "Chooses limit or working-set fix.",
    ],
  },
  {
    id: "throttle-vs-latency",
    question:
      "The CPU limit is 500m and the service is at 80% node utilization. p99 doubled but there are no restarts. What is your hypothesis?",
    difficulty: 2,
    hints: ["CPU is compressible.", "Throttling can happen while the node has idle capacity."],
    answer:
      "My first hypothesis is CPU throttling. The container limit is below its demand, so the kernel throttles it each period even if the node has idle CPU. I would check throttled periods and throttled seconds per container, then compare the latency increase with the throttle ratio. If throttling tracks the latency, I would raise or remove the limit when the node has headroom, or reduce CPU work. Node utilization alone does not rule out a container limit.",
    followUps: [
      "How would you prove the node is not the bottleneck?",
      "What does a CPU request change here?",
      "When would you lower the limit instead?",
    ],
    redFlags: [
      "Assumes node CPU utilization explains everything.",
      "Restarts the pod without checking throttling.",
      "Raises the request to fix a limit.",
    ],
    rubric: [
      "Identifies throttling.",
      "Cites throttled-period metrics.",
      "Separates limit from node capacity.",
      "Chooses a targeted fix.",
    ],
  },
  {
    id: "qos-design",
    question:
      "How do requests and limits determine QoS, and when does QoS matter during an incident?",
    difficulty: 3,
    hints: [
      "Guaranteed requires requests equal to limits for CPU and memory.",
      "QoS affects eviction order, not cgroup enforcement.",
    ],
    answer:
      "Guaranteed requires every container to set CPU and memory requests equal to their limits. BestEffort has neither. Burstable is everything between. QoS matters when the node itself comes under memory pressure: BestEffort pods are evicted first, then Burstable pods that exceed their requests, while Guaranteed pods are the most protected. QoS does not stop a container from hitting its own memory limit, and it does not change CPU throttling inside a cgroup.",
    followUps: [
      "How would you choose QoS for a latency-critical API?",
      "What happens to a Burstable pod above its request under node pressure?",
      "Can a pod be Guaranteed with multiple containers?",
    ],
    redFlags: [
      "Thinks QoS prevents OOM kills.",
      "Confuses requests with limits.",
      "Says Guaranteed means unlimited.",
    ],
    rubric: [
      "Defines all three classes.",
      "Separates eviction from cgroup limits.",
      "Connects QoS to node pressure.",
      "Applies it to a workload choice.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every container has a request that reflects observed usage and a limit that is at least the request.",
      "QoS class is chosen deliberately for the workload's criticality.",
      "CPU throttling and memory working set are monitored per container.",
      "Node allocatable and requested capacity have enough headroom for peak.",
      "OOMKilled and FailedScheduling alerts are routed to the owning team.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Classify the failure: Pending, OOMKilled, throttled, or node pressure.",
      "Read pod events and last state before changing limits.",
      "Compare the container limit with its working set or CPU demand.",
      "Check node headroom to separate a local limit from node exhaustion.",
      "Check whether a recent deploy changed requests, limits, or actual usage.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Raise or remove the limit that fired, or reduce the workload's demand.",
      "Verify restarts and throttling return to baseline.",
      "Review whether the request still reflects real usage.",
      "Revisit QoS and eviction behavior under node pressure.",
    ],
  },
];

const references = [
  {
    title: "Resource management for pods and containers",
    url: "https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Requests, limits, scheduling behavior, and runtime enforcement.",
  },
  {
    title: "Pod Quality of Service classes",
    url: "https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "Guaranteed, Burstable, BestEffort, and eviction behavior.",
  },
  {
    title: "About cgroups",
    url: "https://kubernetes.io/docs/concepts/architecture/cgroups/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "How the kubelet uses Linux cgroups to enforce container resources.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "requests-limits": {
      model: requestsLimitsModel,
      presets,
      instructions:
        "Start Healthy, then apply CPU limit pressure and Severe CPU throttling to compare latency with restarts. Apply OOMKilled with node headroom and compare the pod state with node memory unreserved. Run the experiment before revealing the explanation, then apply Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Node size, other workload reservations, and container usage are fixed teaching values; request, limit, QoS, throttling, and OOM behavior follow the Kubernetes documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-pods-deployments",
    "kubernetes-probes",
    "containers-cpu-memory-limits",
    "containers-oom-kills",
  ],
};
