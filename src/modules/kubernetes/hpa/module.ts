import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const POD_RPS = 300;
const BASE_P99 = 45;

const params: ParamSpec[] = [
  {
    id: "requestRate",
    label: "Incoming requests",
    min: 500,
    max: 12_000,
    step: 100,
    value: 1_200,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving at the service. The HPA can only add pods; it cannot add database capacity or reduce the work per request.",
    format: "rps",
  },
  {
    id: "targetCpu",
    label: "CPU target",
    min: 30,
    max: 90,
    step: 5,
    value: 60,
    unit: "%",
    group: "HPA",
    help: "Target utilization per pod. Lower values keep more headroom but raise the replica count and the cost.",
    format: "percent",
  },
  {
    id: "maxReplicas",
    label: "Maximum replicas",
    min: 2,
    max: 40,
    step: 1,
    value: 10,
    unit: " pods",
    group: "HPA",
    help: "The cap on replicas. A cap that is below the demand turns the HPA into a fixed-size deployment during the peak.",
    format: "count",
  },
  {
    id: "metricMode",
    label: "Scaling metric",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "HPA",
    help: "0 is CPU utilization, 1 is memory utilization, 2 is requests per pod from a custom metric. The metric must track the work that limits the service.",
    format: "count",
  },
  {
    id: "dbCapacity",
    label: "Database request capacity",
    min: 1_000,
    max: 12_000,
    step: 250,
    value: 4_000,
    unit: " rps",
    group: "Downstream",
    help: "Requests per second the shared database can serve before queueing. This is illustrative and independent of the pod count.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  requestRate: number;
  targetCpu: number;
  maxReplicas: number;
  metricMode: number;
  dbCapacity: number;
  desired: number;
  replicas: number;
  appUtil: number;
  appUtilPct: number;
  dbUtil: number;
  overall: number;
  p99: number;
  errors: number;
  perPodRps: number;
}

function targetRate(targetCpu: number): number {
  return POD_RPS * (targetCpu / 100);
}

function compute(p: Params): Computed {
  const requestRate = Math.round(clamp(num(p, "requestRate", 1_200), 500, 12_000));
  const targetCpu = Math.round(clamp(num(p, "targetCpu", 60), 30, 90));
  const maxReplicas = Math.round(clamp(num(p, "maxReplicas", 10), 2, 40));
  const metricMode = Math.round(clamp(num(p, "metricMode", 0), 0, 2));
  const dbCapacity = Math.round(clamp(num(p, "dbCapacity", 4_000), 1_000, 12_000));

  let desired: number;
  if (metricMode === 1) desired = 2;
  else if (metricMode === 2) desired = Math.ceil(requestRate / 150);
  else desired = Math.ceil(requestRate / targetRate(targetCpu));
  const replicas = clamp(desired, 1, maxReplicas);
  const appUtil = requestRate / (replicas * POD_RPS);
  const dbUtil = requestRate / dbCapacity;
  const overall = Math.max(appUtil, dbUtil);
  const p99 =
    overall <= 0.7
      ? BASE_P99 + 25 * overall
      : Math.min(5_000, BASE_P99 + 17.5 + 2_400 * ((overall - 0.7) / 0.3) ** 2);
  return {
    requestRate,
    targetCpu,
    maxReplicas,
    metricMode,
    dbCapacity,
    desired,
    replicas,
    appUtil,
    appUtilPct: appUtil * 100,
    dbUtil: dbUtil * 100,
    overall,
    p99,
    errors: clamp((overall - 0.9) * 25, 0, 100),
    perPodRps: requestRate / replicas,
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

function buildFrame(values: Computed, seed: number, p99: number): SimFrame {
  const appHealth = healthFor(values.appUtilPct, 70, 90);
  const dbHealth = healthFor(values.dbUtil, 75, 90);
  const errorHealth = healthFor(values.errors, 1, 5);
  const workloadHealth = worst([appHealth, dbHealth, errorHealth, healthFor(p99, 300, 800)]);
  const atMax = values.replicas >= values.maxReplicas;
  const nodes: SimNode[] = [
    {
      id: "client",
      label: "Client",
      kind: "client",
      health: "ok",
      throughput: values.requestRate,
      sublabel: `${values.requestRate.toLocaleString()} rps`,
      meta: { view: "flow" },
    },
    {
      id: "service",
      label: "checkout service",
      kind: "service",
      health: workloadHealth,
      utilization: clamp(values.appUtil),
      throughput: values.requestRate,
      sublabel: `${values.replicas} pods · ${Math.round(values.appUtilPct)}% CPU`,
      detail: `The HPA requested ${values.desired} replicas and the deployment is running ${values.replicas}. Each pod serves about ${Math.round(values.perPodRps)} rps.`,
      meta: { view: "flow" },
    },
    {
      id: "hpa",
      label: "HPA controller",
      kind: "service",
      health: atMax && values.overall > 0.9 ? "warn" : "ok",
      sublabel: `${values.replicas}/${values.maxReplicas} replicas${atMax ? " · at max" : ""}`,
      detail: atMax
        ? `The desired count is above the maximum, so the HPA cannot add capacity. The remaining pressure is downstream or the cap is too low.`
        : `The HPA computes a desired count of ${values.desired} from the selected metric and the target.`,
      meta: { view: "flow" },
    },
    {
      id: "metrics",
      label: "metrics server",
      kind: "service",
      health: values.metricMode === 1 ? "warn" : "ok",
      sublabel: values.metricMode === 1 ? "memory metric · does not track load" : "resource and custom metrics",
      detail:
        values.metricMode === 1
          ? "Memory working set stays nearly flat as request rate rises. The HPA sees a satisfied target and keeps the replica count low."
          : "The HPA reads the metric from the metrics API. The metric must move with the work the service must do.",
      meta: { view: "flow" },
    },
    {
      id: "pods",
      label: "pod fleet",
      kind: "service",
      role: "instance",
      health: appHealth,
      utilization: clamp(values.appUtil),
      sublabel: `${values.replicas} replicas · ${Math.round(values.appUtilPct)}% CPU`,
      detail: `Each replica is sized for about ${POD_RPS} rps at full utilization. The HPA target keeps normal utilization near ${values.targetCpu}%.`,
      meta: { view: "flow" },
    },
    {
      id: "database",
      label: "shared database",
      kind: "db",
      health: dbHealth,
      utilization: clamp(values.dbUtil / 100),
      capacity: values.dbCapacity,
      throughput: values.requestRate,
      sublabel: `${Math.round(values.dbUtil)}% of ${values.dbCapacity.toLocaleString()} rps`,
      detail: `The database capacity is shared by every replica. Adding pods increases the request rate it must absorb; it does not increase this ceiling.`,
      meta: { view: "flow" },
    },
  ];
  return {
    t: 0,
    nodes,
    edges: [
      edge("client-service", "client", "service", 0.9),
      edge("service-pods", "service", "pods", clamp(values.appUtil), appHealth),
      edge("pods-database", "pods", "database", clamp(values.dbUtil / 100), dbHealth),
      edge("hpa-pods", "hpa", "pods", atMax ? 0.2 : 0.6, atMax ? "warn" : "ok"),
      edge("metrics-hpa", "metrics", "hpa", 0.5, values.metricMode === 1 ? "warn" : "ok"),
    ],
    metrics: [
      metric("p99", "Request p99", p99, "ms", 300, 800, "ms"),
      metric("app-cpu", "Pod CPU utilization", values.appUtilPct, "%", 70, 90, "percent"),
      metric("db-util", "Database utilization", values.dbUtil, "%", 75, 90, "percent"),
      metric("error-rate", "Request errors", values.errors, "%", 1, 5, "percent"),
      metric("replicas", "Running replicas", values.replicas, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, metricMode: values.metricMode, atMax: atMax ? 1 : 0 },
    summary: `${values.requestRate.toLocaleString()} rps with ${values.replicas} of ${values.maxReplicas} replicas; pod CPU ${values.appUtilPct.toFixed(0)}%, database ${values.dbUtil.toFixed(0)}%, p99 ${p99.toFixed(0)}ms.`,
  };
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 6)) / 2.7);
  const entries: [string, number, number][] = [
    ["p99", values.p99, 3],
    ["app-cpu", values.appUtilPct, 0.4],
    ["db-util", values.dbUtil, 0.3],
    ["error-rate", values.errors, 0.05],
    ["replicas", values.replicas, 0],
  ];
  for (const [id, value, amplitude] of entries) {
    frame.series[id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, value * jitter(index) + Math.sin(index / 2.3) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Latency stays high after the HPA adds pods",
    cause:
      "The replica count is no longer the limiting resource. A shared database, a cache, a queue, or a fixed connection pool saturates while the HPA keeps adding clients. Each new pod increases pressure on the same downstream ceiling.",
    fix:
      "Identify the dependency whose utilization tracks the traffic and stop scaling the front end. Protect the dependency with a pool limit, queue, or request budget, then add capacity or reduce work per request there. Recheck p99 at a fixed replica count before allowing the HPA to scale again.",
    checkFirst: [
      "Compare pod CPU and downstream utilization on the same time axis.",
      "Check whether replicas are at the maximum or still climbing.",
      "Check connection counts, pool wait time, and queue depth at the dependency.",
    ],
  },
  {
    id: "app-cpu",
    metricId: "app-cpu",
    warn: 70,
    crit: 90,
    title: "Pods are running above the HPA target",
    cause:
      "The HPA is capped, the metric is not responsive, or the pods cannot start fast enough. A target is a request for a replica count, not a guarantee that the count is reached.",
    fix:
      "Check the desired replica count against the maximum and the deployment's ability to start pods. If the cap is binding, raise it or reduce the work per request. If the metric is memory, switch to a signal that tracks load.",
    checkFirst: [
      "Check the HPA status for the current, desired, and maximum replica counts.",
      "Check the deployment for unschedulable or unready pods.",
      "Check whether the selected metric is saturated at its target.",
    ],
  },
  {
    id: "db-util",
    metricId: "db-util",
    warn: 75,
    crit: 90,
    title: "The shared dependency is the real bottleneck",
    cause:
      "Every replica calls the same database. The HPA can be at its maximum or still adding pods, but either way each new pod adds sessions and queueing at the database. Pod CPU may be above its target while the dependency is already saturated, so the deciding signal is the shared resource, not the pod tier.",
    fix:
      "Cap the connection pool per pod, add a bounded queue or load shedder, and reduce the work per request. Scale the database or move reads to a replica only after the query pattern is understood. The front end should not scale past the dependency's safe concurrency.",
    checkFirst: [
      "Check database CPU, connections, lock waits, and query latency by statement.",
      "Compare the request rate with the database capacity and the pool size per pod.",
      "Check whether a recent HPA change increased the replica count without a database change.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Requests are failing while the HPA scales",
    cause:
      "A saturated dependency turns queueing into timeouts. The HPA may be adding pods into a system that cannot serve them, which increases retries and makes the failure worse.",
    fix:
      "Stop the scale-up or cap it, shed low-priority work, and protect the dependency with a bounded concurrency limit. Restore the dependency before resuming normal traffic, then verify that errors fall at a stable replica count.",
    checkFirst: [
      "Check whether errors started before or after the replica increase.",
      "Check retry counts and timeout settings on the dependency path.",
      "Check whether new pods are ready but failing their first requests.",
    ],
  },
];

function defaultsFor(id: string): Params {
  if (id === "peak") {
    return defaults({ requestRate: 4_000, targetCpu: 60, maxReplicas: 20, metricMode: 0, dbCapacity: 5_000 });
  }
  if (id === "failure") {
    return defaults({ requestRate: 6_000, targetCpu: 60, maxReplicas: 30, metricMode: 0, dbCapacity: 3_000 });
  }
  if (id === "wrong-metric") {
    return defaults({ requestRate: 3_000, targetCpu: 60, maxReplicas: 20, metricMode: 1, dbCapacity: 4_000 });
  }
  if (id === "recovery") {
    return defaults({ requestRate: 5_000, targetCpu: 60, maxReplicas: 30, metricMode: 0, dbCapacity: 10_000 });
  }
  return defaults();
}

export const hpaModel: SimModel = {
  id: "kubernetes-hpa",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const values = compute(defaults());
    const frame = buildFrame(values, seed, values.p99);
    seedSeries(frame, values, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const sampledP99 = Math.max(1, values.p99 * (1 + rng.between(-0.01, 0.01)));
    const next = buildFrame(values, Number(frame.flags.seed ?? 20261110), sampledP99);
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([key, series]) => [key, [...series]]));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events];
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.summary = `${values.requestRate.toLocaleString()} rps with ${values.replicas} of ${values.maxReplicas} replicas; pod CPU ${values.appUtilPct.toFixed(0)}%, database ${values.dbUtil.toFixed(0)}%, p99 ${sampledP99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `The HPA computes ${values.desired} desired replicas from the selected metric; the cap allows ${values.replicas}. Pod CPU is ${values.appUtilPct.toFixed(0)}%.`,
      `The database is at ${values.dbUtil.toFixed(0)}% of its request capacity. ${values.dbUtil >= 90 ? "It is the bottleneck, and more replicas increase its load." : "It still has headroom for this request rate."}`,
      values.metricMode === 1
        ? "Memory utilization barely moves with request rate. The HPA target can be satisfied while the request path is saturated."
        : "The selected metric moves with the work the service receives, but it only controls the pod tier.",
      values.replicas >= values.maxReplicas
        ? `The replica count is at the maximum of ${values.maxReplicas}. The HPA can no longer add pods, so any remaining saturation is downstream or the cap is binding.`
        : "The replica count is below the maximum; the HPA still has room to add pods if the metric stays above target.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "At target or capped", tone: "warn" },
    { label: "Bottleneck saturated", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Moderate traffic, CPU headroom, and a database above the demand.",
    tone: "ok",
    params: defaultsFor("healthy"),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Traffic reaches the replica cap; the database enters its warning band.",
    tone: "warn",
    params: defaultsFor("peak"),
  },
  {
    id: "failure",
    label: "Saturated database",
    description: "The HPA runs at its maximum while the shared database can serve only half the request rate.",
    tone: "crit",
    params: defaultsFor("failure"),
  },
  {
    id: "wrong-metric",
    label: "Memory metric",
    description: "Traffic rises to 2.5 times the healthy rate while the HPA scales on memory and keeps two replicas.",
    tone: "crit",
    params: defaultsFor("wrong-metric"),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The database capacity is raised and the HPA sizes the pod tier to the load.",
    tone: "ok",
    params: defaultsFor("recovery"),
  },
];

const experiment: Experiment = {
  id: "predict-downstream",
  title: "Predict whether a higher replica cap will fix the latency",
  simId: "hpa",
  question:
    "The HPA wants 34 replicas, is capped at 30, pod CPU is 67% against a 60% target, the database is saturated, and p99 is around five seconds. What actually reduces latency?",
  prediction: {
    options: [
      { id: "max", label: "Raise the maximum replica count above 30" },
      { id: "db", label: "Increase the database request capacity or reduce work per request" },
      { id: "target", label: "Lower the CPU target so the HPA adds pods sooner" },
      { id: "memory", label: "Switch the HPA to memory utilization" },
    ],
    correctOptionId: "db",
    explanation:
      "At 30 pods CPU is 67%, above the 60% target, so the HPA would add four pods if the cap allowed it. But the database is at 200%, and four more pods are four more clients on the same saturated dependency. Raising the cap cannot lower latency until the database has headroom. A lower target or a memory metric changes when the HPA scales, not what limits the request path.",
  },
  setup: defaults({ requestRate: 6_000, targetCpu: 60, maxReplicas: 30, metricMode: 0, dbCapacity: 3_000 }),
  runFor: 20,
  observe: [
    "The HPA wants 34 replicas but the maximum is 30, so pod CPU stays above target at 67%.",
    "Database utilization is 200% while requests fail and p99 sits at the model's ceiling.",
    "The replica cap is binding, but the database is the constraint users feel.",
    "Raising the cap alone adds database clients without adding capacity.",
  ],
  explain:
    "The HPA is a controller for one tier, not a capacity planner for the whole request path. It compares the observed metric with the target and changes the replica count. Here the pod metric is above target and the controller wants more pods, but the bottleneck is below that tier. Scaling out multiplies the load on the shared dependency. The correct move is to find the resource whose utilization tracks the user symptom and scale or protect that resource before relaxing the pod cap.",
  fix: defaults({ requestRate: 6_000, targetCpu: 60, maxReplicas: 30, metricMode: 0, dbCapacity: 10_000 }),
  debrief:
    "At 30 pods CPU was 67%, above the 60% target: the HPA wanted 34 and the cap held it at 30. Raising the cap would have added four pods and four more database clients to a database at 200%, so latency would not improve. Raising database capacity lets the existing 30 pods serve the traffic and returns p99 to a normal range. CPU remains above target, so the next decision is whether to raise the cap once the database has headroom or accept the current target.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Horizontal Pod Autoscaler changes a workload's replica count from an observed metric. It reads the metric through the metrics API, compares the current value with the target, and computes a desired replica count. The formula is proportional: if utilization is twice the target, the desired count roughly doubles. The controller then clamps the result to the minimum and maximum and writes the replica count to the Deployment, ReplicaSet, or StatefulSet.",
  },
  {
    type: "p",
    text: "The metrics server supplies CPU and memory utilization from the kubelet. Custom and external metrics can supply request rate, queue depth, or a business signal. A stabilization window limits how quickly the replica count can change, which prevents flapping when the metric is noisy. None of these controls changes the capacity of a dependency. An HPA can only add or remove pods in the tier it owns.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The HPA sits above a Deployment or StatefulSet and below the metrics pipeline. It is a control loop, not a load balancer and not a scheduler. It reacts after the metric has moved and after a new pod has been created, scheduled, started, and made ready. During that sequence the request path may be saturated. A high target with slow scale-up can produce a latency spike even when the final replica count is correct.",
  },
  {
    type: "table",
    headers: ["Signal", "What it measures", "What it can hide"],
    rows: [
      ["Pod CPU", "Work inside the pod", "Time spent waiting on a dependency"],
      ["Memory", "Working set, which is often flat", "Request rate and queueing"],
      ["Requests per pod", "Load the pod receives", "CPU or connection limits inside the pod"],
      ["Database utilization", "Pressure on the shared tier", "Whether the HPA can relieve it"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Scaling the pod tier",
    rightTitle: "Scaling the bottleneck",
    rows: [
      { label: "Question", left: "Do we need more workers?", right: "Can the shared resource serve more work?" },
      { label: "Signal", left: "Pod CPU or requests per pod", right: "Database, cache, or queue saturation" },
      { label: "Effect", left: "More concurrency and more cost", right: "More capacity or less work per request" },
      { label: "Risk", left: "Adding clients to a saturated dependency", right: "Capacity that sits idle after the spike" },
    ],
  },
  {
    type: "p",
    text: "This module models a service whose pods each serve about 300 requests per second at full utilization, backed by a shared database with an illustrative request ceiling. The numbers are teaching values. The shape is the lesson: the HPA controls the pod count, while the database ceiling is outside its authority.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Running replicas beside the HPA's desired count and maximum.",
      "Pod CPU, database utilization, p99, and request errors on the same frame.",
      "An HPA node that reports when the cap is reached and the dependency is still saturated.",
      "A memory-metric preset where the replica count stays low while the request path fails.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note that pod CPU sits near the target. Apply Saturated database: the HPA reaches its maximum, yet p99 stays high. Before changing the maximum, look at database utilization. Then try Memory metric to see a scale signal that does not follow the load.",
  },
  { type: "sim", simId: "hpa" },
  {
    type: "p",
    text: "The useful diagnostic order is symptom, dependency, then replica count. Find the resource whose utilization rises with the user-visible latency. If it is inside the pod tier, the HPA can help. If it is below the pod tier, more replicas are more clients. A replica cap is a control, not a capacity plan.",
  },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The HPA reached its maximum while the shared database served only half the demand. Pod CPU was 67%, above the 60% target, so the controller wanted four more pods. The cap held the count at 30, but more pods would have added clients to a database already at 200%. Requests queued, p99 rose, and errors followed. The replica count was a symptom of the control loop working, not evidence that the bottleneck had moved.",
  },
  {
    type: "p",
    text: "The memory-metric preset showed a different failure: the controller optimized a signal that barely changes with request rate. Memory looked satisfied at two replicas while CPU and latency were far beyond the target. In both cases the selected metric was the problem, not the arithmetic of the HPA.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "kubectl get hpa: current and desired replicas, the metric value, and the target.",
      "Deployment status: ready replicas, unavailable replicas, and the time since the last scale event.",
      "Database: CPU, connections, lock waits, and query latency grouped by statement.",
      "Queue or pool metrics: wait time and depth at the dependency, which explain why more pod CPU will not relieve the path.",
      "HPA events: SuccessfulRescale, FailedGetResourceMetric, and scale-up or scale-down stabilization messages.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the HPA's desired count with its maximum and with the pods that are actually ready. Then look one tier below the pods. If database or dependency utilization rises with the request rate, capping replicas is safer than adding more. Check the metric you selected against the work the service must do.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the HPA is reading a metric that moves with the user-visible load.",
      "Check whether the replica cap or the deployment's startup time is limiting the count.",
      "Find the shared dependency whose utilization tracks the symptom.",
      "Cap concurrency and connection pools so new pods cannot overwhelm that dependency.",
      "Add capacity or reduce work per request at the bottleneck, then verify p99 at a stable replica count.",
      "Re-enable scale-up and watch both the pod metric and the downstream metric together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A lower CPU target adds headroom but raises the steady-state replica count and cost.",
      "A higher maximum protects against spikes but can multiply load on a shared dependency.",
      "A longer stabilization window reduces flapping but delays the response to a real surge.",
      "Custom metrics can track the right signal but add a pipeline that can fail independently.",
      "Scaling the database may cost more than reducing the queries each request performs.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "hpa-not-helping",
    question:
      "The HPA is at its maximum and p99 is still high. Walk me through your next ten minutes.",
    difficulty: 2,
    hints: [
      "The HPA only controls one tier.",
      "Find the resource whose utilization tracks the latency.",
    ],
    answer:
      "I confirm the HPA is at the maximum and that the pods are ready, not just created. Then I look one tier below: database CPU, connections, lock waits, queue depth, and pool wait time. If those rise with traffic, the pod tier is not the bottleneck and more replicas would add clients. I would cap concurrency or pool size, shed low-priority work, and restore the dependency before resuming scale-up. If the dependency is healthy but the pods are CPU-bound, the cap is too low or the target is unrealistic. I decide from the utilization of the actual constraint, not from the replica count.",
    followUps: [
      "What if pod CPU is low and the dependency looks healthy?",
      "How would you choose a new maximum?",
      "What does the HPA do when the metric API is unavailable?",
    ],
    redFlags: [
      "Raises the cap without checking the dependency.",
      "Treats pod CPU as the only possible constraint.",
      "Ignores readiness during scale-up.",
    ],
    rubric: [
      "Checks the HPA status and readiness.",
      "Inspects the downstream tier.",
      "Protects the dependency before scaling.",
      "Uses the real constraint to decide.",
    ],
  },
  {
    id: "memory-metric",
    question:
      "Why can an HPA on memory utilization fail to protect a request-driven service?",
    difficulty: 2,
    hints: [
      "Memory is a working-set signal, not a request-rate signal.",
      "The target is satisfied when the working set is below the threshold.",
    ],
    answer:
      "Memory working set often stays flat as request rate rises, especially for a service that allocates a fixed heap or buffer. The HPA compares that flat value with the target and concludes that the current replica count is correct, even while CPU, queues, or downstream latency are saturated. Memory can be the right metric for a memory-bound cache or worker, but the metric must be the resource that limits the work. For a request-driven service I would use CPU or requests per pod, and I would validate the metric against a load test before trusting it.",
    followUps: [
      "When is memory the right scaling metric?",
      "How would you test a custom metric before production?",
      "What happens if memory usage is flat but the heap is near its limit?",
    ],
    redFlags: [
      "Assumes any metric works if the target is tuned.",
      "Ignores the request path.",
      "Confuses memory limit with memory utilization.",
    ],
    rubric: [
      "Explains the flat working set.",
      "Names the metric that tracks the constraint.",
      "Mentions validation under load.",
      "Gives a case where memory is appropriate.",
    ],
  },
  {
    id: "target-choice",
    question:
      "How do you choose the CPU target for an HPA, and what does a lower target cost?",
    difficulty: 3,
    hints: [
      "The target controls headroom and replica count together.",
      "Queueing latency rises before 100% utilization.",
    ],
    answer:
      "I start from a load test that measures latency and CPU at several concurrency levels, then pick a target below the point where p99 starts to climb sharply. A lower target keeps more burst headroom and shortens the time a pod spends near saturation, but it raises the steady-state replica count and the cost. I also consider startup time: if pods take a minute to become ready, the target has to leave enough room to absorb the scale-up delay. I would validate the choice against the real traffic mix, not only a synthetic average, and I would watch the HPA's behavior during a ramp.",
    followUps: [
      "How does startup time change the target?",
      "What would make you use a custom request-rate metric instead?",
      "How do you avoid flapping between replica counts?",
    ],
    redFlags: [
      "Picks 80% because it sounds efficient.",
      "Ignores latency and startup time.",
      "Tunes the target without a load test.",
    ],
    rubric: [
      "Ties the target to measured latency.",
      "Explains headroom versus cost.",
      "Accounts for startup time.",
      "Mentions validation and stabilization.",
    ],
  },
  {
    id: "scale-up-delay",
    question:
      "Traffic doubles in thirty seconds. The HPA reacts, but users see a latency spike. What limits the response?",
    difficulty: 3,
    hints: [
      "The control loop observes, decides, creates, schedules, and starts.",
      "A new pod is not useful until it is ready.",
    ],
    answer:
      "The HPA is a delayed control loop. It needs the metric to be scraped, the controller to reconcile, the Deployment to create a pod, the scheduler to place it, the image to pull, and the readiness probe to pass. During that window the existing pods absorb the surge and may queue. The spike can happen even if the final replica count is correct. I would measure the time from scale event to ready pod, pre-pull images or use a warm pool if it is long, and consider a faster metric or a higher steady-state minimum for traffic that ramps faster than the loop. I would not lower the readiness probe just to make the number move.",
    followUps: [
      "Which part of the delay would you measure first?",
      "How can a minimum replica count help?",
      "What is the risk of scaling on a very short metric window?",
    ],
    redFlags: [
      "Assumes the HPA reacts instantly.",
      "Weakens readiness to speed up the count.",
      "Ignores image pull and scheduling time.",
    ],
    rubric: [
      "Describes the control-loop delay.",
      "Names scheduling and readiness.",
      "Proposes measuring scale-to-ready time.",
      "Avoids weakening health checks.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The HPA metric moves with the work the service must do, validated under load.",
      "The maximum replica count is justified against downstream capacity, not only cost.",
      "Each pod has a connection or concurrency limit that bounds its load on shared dependencies.",
      "Scale-to-ready time is measured and the target leaves room for it.",
      "Dashboards place pod metrics and downstream metrics on the same time axis.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the HPA is at its maximum and whether pods are ready.",
      "Look one tier below the pods before raising the cap.",
      "Compare the request rate with the dependency's capacity and pool limits.",
      "Stop or cap scale-up if new pods are increasing downstream pressure.",
      "Record which metric the HPA used and whether it tracked the symptom.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add or adjust the downstream signal that would have found the bottleneck sooner.",
      "Revisit the maximum and target with the measured scale-to-ready time.",
      "Keep connection and concurrency limits aligned with the database capacity.",
      "Run a ramp test that exercises the control loop, not only a steady load.",
    ],
  },
];

const references = [
  {
    title: "Horizontal Pod Autoscaling",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "The algorithm, metrics API, and stabilization behavior.",
  },
  {
    title: "Horizontal Pod Autoscaler Walkthrough",
    url: "https://kubernetes.io/docs/tasks/run-application/horizontal-pod-autoscale-walkthrough/",
    publisher: "Kubernetes",
    kind: "docs" as const,
    note: "A worked example of CPU-based scaling and observed replica counts.",
  },
  {
    title: "metrics-server",
    url: "https://github.com/kubernetes-sigs/metrics-server",
    publisher: "Kubernetes SIGs",
    kind: "docs" as const,
    note: "The resource metrics pipeline behind CPU and memory targets.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    hpa: {
      model: hpaModel,
      presets,
      instructions:
        "Start Healthy, then apply Saturated database. Check database utilization before raising the maximum. Apply Memory metric to see a scaling signal that does not follow request load.",
      experimentIds: [experiment.id],
      alternateVisuals: ["topology"],
      note: "Illustrative model. Pod request capacity, database capacity, and latency are teaching values, not benchmark results.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "kubernetes-requests-limits",
    "kubernetes-scheduling",
    "containers-target-tracking",
    "foundations-capacity-headroom",
  ],
};
