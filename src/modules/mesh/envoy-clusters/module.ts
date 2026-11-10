import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const EJECTION_THRESHOLD = 3;
const DEMAND = 6_000;
const FAULT_RAMP = 6;

const params = [
  {
    id: "endpointCount",
    label: "Pods running",
    min: 2,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Workload",
    help: "Pods that Kubernetes reports as running. Running is not the same as being present in an Envoy cluster.",
    format: "count" as const,
  },
  {
    id: "registeredPercent",
    label: "Endpoints registered",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Discovery",
    help: "Share of running pods that endpoint discovery has placed in the cluster. The rest are missing from the load-balancing set.",
    format: "percent" as const,
  },
  {
    id: "failingPercent",
    label: "Endpoints returning 5xx",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Health",
    help: "Target share of registered endpoints that return 5xx. The demo ramps faults in over six seconds so you can watch ejection.",
    format: "percent" as const,
  },
  {
    id: "maxEjectionPercent",
    label: "Maximum ejection",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
    group: "Outlier detection",
    help: "Cap on the share of the cluster that outlier detection may eject. A lower cap preserves capacity; 100% allows the cluster to eject itself empty.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  pods: number;
  registered: number;
  missing: number;
  failing: number;
  healthy: number;
  ejected: number;
  usable: number;
  successRate: number;
  errorRate: number;
  ejectedPercent: number;
  usableShortfall: number;
}

function compute(p: Params, t: number): Computed {
  const pods = Math.max(2, Math.round(num(p, "endpointCount", 6)));
  const registeredPercent = clamp(num(p, "registeredPercent", 100), 0, 100);
  const failingPercent = clamp(num(p, "failingPercent", 0), 0, 100);
  const maxEjectionPercent = clamp(num(p, "maxEjectionPercent", 50), 0, 100);
  const registered = Math.round(pods * (registeredPercent / 100));
  const ramp = clamp(t / FAULT_RAMP, 0, 1);
  const failing = Math.min(registered, Math.round(registered * (failingPercent / 100) * ramp));
  const ejectionCap = Math.floor(registered * (maxEjectionPercent / 100));
  const ejected = failing >= EJECTION_THRESHOLD ? Math.min(failing, ejectionCap) : 0;
  const usable = Math.max(0, registered - ejected);
  const healthy = Math.max(0, registered - failing);
  const successRate = usable > 0 ? (healthy / usable) * 100 : 0;
  return {
    pods,
    registered,
    missing: Math.max(0, pods - registered),
    failing,
    healthy,
    ejected,
    usable,
    successRate,
    errorRate: 100 - successRate,
    ejectedPercent: registered > 0 ? (ejected / registered) * 100 : 0,
    usableShortfall: Math.max(0, registered - usable),
  };
}

function healthForErrors(value: number): SimState {
  if (value >= 60) return "crit";
  if (value >= 5) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const requestHealth = healthForErrors(c.errorRate);
  const clusterHealth: SimState = c.usable === 0 ? "down" : requestHealth;
  const failingHealth: SimState = c.failing === 0 ? "ok" : c.errorRate >= 60 ? "crit" : "warn";
  const ejectedHealth: SimState = c.ejected === 0 ? "ok" : c.usable === 0 ? "down" : "warn";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: requestHealth,
        throughput: DEMAND,
        sublabel: `${DEMAND.toLocaleString()} requests/s`,
        detail: "The client only sees the result of the proxy's choice. It cannot tell whether an endpoint was missing, unhealthy, or ejected.",
        meta: { view: "flow" },
      },
      {
        id: "envoy",
        label: "Envoy sidecar",
        kind: "mesh",
        health: clusterHealth,
        throughput: c.usable > 0 ? DEMAND : 0,
        sublabel: `${c.usable} usable endpoints`,
        detail: `The cluster has ${c.registered} registered endpoints; ${c.healthy} are healthy and ${c.ejected} are ejected. The load balancer may only choose from ${c.usable} hosts.`,
        meta: { view: "flow" },
      },
      {
        id: "eds",
        label: "Endpoint discovery",
        kind: "mesh",
        health: c.missing > 0 ? "warn" : "ok",
        sublabel: `${c.registered}/${c.pods} registered`,
        detail: c.missing > 0
          ? `${c.missing} running pods are absent from the cluster. Check the discovery source, selector, and readiness before blaming the endpoints' application code.`
          : "Every running pod is present in the cluster's endpoint set.",
        meta: { view: "flow" },
      },
      {
        id: "healthy-pool",
        label: "Healthy endpoints",
        kind: "service",
        health: c.healthy > 0 ? "ok" : "down",
        sublabel: `${c.healthy} of ${c.registered}`,
        detail: `${c.healthy} registered endpoints are not returning 5xx. This is the capacity that survives when ejection does its job.`,
        meta: { view: "flow" },
      },
      {
        id: "failing-pool",
        label: "Failing endpoints",
        kind: "service",
        health: failingHealth,
        sublabel: `${c.failing} returning 5xx`,
        detail: c.failing > 0
          ? `${c.failing} endpoints return 5xx. Outlier detection counts consecutive failures; it does not repair the application.`
          : "No registered endpoint is currently returning 5xx.",
        meta: { view: "flow" },
      },
      {
        id: "ejected-pool",
        label: "Ejected endpoints",
        kind: "service",
        health: ejectedHealth,
        sublabel: `${c.ejected} removed from LB`,
        detail: c.ejected > 0
          ? `Outlier detection removed ${c.ejected} endpoints from the load-balancing set. Ejection is capacity loss, not a fix. Check whether the remaining capacity can carry the load.`
          : "No endpoint is currently ejected. A failure below the ejection threshold still reaches users.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-envoy", "client", "envoy", 1, "ok"),
      edge("eds-envoy", "eds", "envoy", c.pods > 0 ? c.registered / c.pods : 0, c.missing > 0 ? "warn" : "ok", "xDS endpoints"),
      edge("envoy-healthy", "envoy", "healthy-pool", c.registered > 0 ? c.healthy / c.registered : 0, c.healthy > 0 ? "ok" : "down"),
      edge("envoy-failing", "envoy", "failing-pool", c.registered > 0 ? c.failing / c.registered : 0, c.failing > 0 ? "crit" : "ok"),
    ],
    metrics: [
      metric("registered-endpoints", "Registered endpoints", c.registered, "", undefined, undefined, "count"),
      metric("healthy-endpoints", "Healthy endpoints", c.healthy, "", undefined, undefined, "count"),
      metric("ejected-endpoints", "Ejected endpoints", c.ejected, "", undefined, undefined, "count"),
      metric("error-rate", "User error rate", c.errorRate, "%", 5, 60, "percent"),
      metric("ejected-percent", "Ejected share", c.ejectedPercent, "%", 20, 80, "percent"),
      metric("usable-shortfall", "Usable capacity shortfall", c.usableShortfall, "", 1, 3, "count"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.usable === 0
      ? `No usable endpoints: ${c.registered} registered, ${c.ejected} ejected, ${c.pods - c.registered} missing.`
      : `${c.registered} registered, ${c.healthy} healthy, ${c.ejected} ejected, ${c.errorRate.toFixed(1)}% errors.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 5,
    crit: 60,
    title: "The cluster is returning errors to callers",
    cause:
      "Too few healthy endpoints are in the load-balancing set. The cause may be application failures, missing endpoint discovery, or ejection that removed capacity without replacing it.",
    fix:
      "Restore healthy endpoints or fix the application first. Ejection only removes bad hosts; it cannot create capacity. Check whether the ejection cap is hiding or amplifying the outage.",
    checkFirst: [
      "Compare `membership_total` with `membership_healthy` for the cluster.",
      "Check `ejections_active` and `ejections_overflow`.",
      "Check whether endpoint discovery has registered every running pod.",
    ],
  },
  {
    id: "ejected-percent",
    metricId: "ejected-percent",
    warn: 20,
    crit: 80,
    title: "Outlier detection has removed a large share of the cluster",
    cause:
      "Endpoints crossed the consecutive-failure threshold and were ejected. A high ejection share reduces usable capacity; if the cap is too high, the cluster can lose most or all of its hosts.",
    fix:
      "Fix the failing endpoints and confirm the ejection cap leaves enough healthy capacity. Do not raise the cap to mask a failing application.",
    checkFirst: [
      "Read `ejections_total` and `ejections_overflow`.",
      "Check whether the failures are isolated to a few hosts or shared by the fleet.",
      "Check whether active health checks are unejecting hosts prematurely.",
    ],
  },
  {
    id: "usable-shortfall",
    metricId: "usable-shortfall",
    warn: 1,
    crit: 3,
    title: "Registered endpoints are not available for load balancing",
    cause:
      "The gap between registered and usable endpoints is the capacity removed by ejection. When every registered endpoint is ejected, the cluster has no host to select and returns 503 with a no-healthy-upstream response flag.",
    fix:
      "Restore endpoint health and discovery. If the cluster is intentionally drained, move traffic to another cluster or priority level rather than leaving an empty host set.",
    checkFirst: [
      "Check `upstream_cx_none_healthy` and the `UH` response flag.",
      "Check whether endpoint discovery is still pushing the expected hosts.",
      "Check the ejection cap and whether a panic threshold applies.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const clusterModel: SimModel = {
  id: "mesh-envoy-clusters",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults(), 0), seed),
  step: (frame, p, _dt, rng) => {
    const computed = compute(p, frame.t);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.2, 0.2);
    next.metrics = next.metrics.map((item) =>
      item.id === "error-rate" ? { ...item, value: clamp(item.value + (computed.errorRate > 0 ? jitter : 0), 0, 100) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (computed.missing > 0 && frame.flags.missingSeen !== 1) {
      pushEvent(next, {
        id: "endpoints-missing",
        at: frame.t,
        severity: "warn",
        title: "Running pods are missing from the cluster",
        detail: `${computed.missing} of ${computed.pods} running pods are not registered as endpoints. Endpoint discovery or readiness is the first thing to check.`,
        nodeId: "eds",
        metricId: "registered-endpoints",
      });
      next.flags.missingSeen = 1;
    }
    if (computed.ejected > 0 && frame.flags.ejectedSeen !== 1) {
      pushEvent(next, {
        id: "endpoints-ejected",
        at: frame.t,
        severity: computed.usable === 0 ? "crit" : "warn",
        title: "Outlier detection ejected endpoints",
        detail: `${computed.ejected} endpoints were removed from the load-balancing set after consecutive failures. ${computed.usable} usable endpoints remain.`,
        nodeId: "ejected-pool",
        metricId: "ejected-percent",
      });
      next.flags.ejectedSeen = 1;
    }
    if (computed.usable === 0 && computed.registered > 0 && frame.flags.noHealthySeen !== 1) {
      pushEvent(next, {
        id: "no-healthy-upstream",
        at: frame.t,
        severity: "crit",
        title: "No healthy upstream",
        detail: `Every registered endpoint is ejected or failing. Envoy has no host to select and returns 503 with the no-healthy-upstream response flag.`,
        nodeId: "envoy",
        metricId: "usable-shortfall",
      });
      next.flags.noHealthySeen = 1;
    }
    if (computed.errorRate < 5 && computed.usable > 0 && frame.flags.ejectedSeen === 1 && frame.flags.recoveredSeen !== 1) {
      pushEvent(next, {
        id: "cluster-recovered",
        at: frame.t,
        severity: "info",
        title: "Cluster recovered",
        detail: `Endpoints are healthy again and the load-balancing set has usable capacity. The error rate is below 5%.`,
        nodeId: "envoy",
      });
      next.flags.recoveredSeen = 1;
    }
    next.summary = computed.usable === 0
      ? `No usable endpoints: ${computed.registered} registered, ${computed.ejected} ejected, ${computed.missing} missing.`
      : `${computed.registered} registered, ${computed.healthy} healthy, ${computed.ejected} ejected, ${computed.errorRate.toFixed(1)}% errors.`;
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const c = compute(p, frame.t);
    const items: string[] = [];
    items.push(`${c.pods} pods running; ${c.registered} registered as endpoints; ${c.healthy} healthy; ${c.ejected} ejected. Usable capacity is set by the load-balancing set, not by the pod count.`);
    if (c.missing > 0) items.push(`${c.missing} pods are absent from the cluster. Check the discovery source, the service selector, and readiness before inspecting application errors.`);
    if (c.ejected > 0) items.push(`Outlier detection ejected ${c.ejected} endpoints after ${EJECTION_THRESHOLD} consecutive failures. Ejection is passive health checking and removes capacity from the load balancer.`);
    items.push("`membership_total` counts registered endpoints. `membership_healthy` counts those currently considered healthy. Neither one is the same as the number of running pods.");
    items.push("`max_ejection_percent` caps how much of the cluster can be ejected. Envoy's default panic threshold is 50%; when availability falls below it, Envoy may ignore health status and use all hosts, depending on the configured panic mode.");
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Six running pods, all registered, none failing. Every endpoint is available.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "One bad endpoint",
    description: "One endpoint returns 5xx and ejection is disabled. The cluster still serves most requests but errors cross the warning line.",
    tone: "warn",
    params: defaults({ endpointCount: 6, registeredPercent: 100, failingPercent: 17, maxEjectionPercent: 0 }),
  },
  {
    id: "failure",
    label: "Empty host set",
    description: "Two pods were never registered and the remaining three all fail. Every registered endpoint is ejected, leaving no healthy upstream.",
    tone: "crit",
    params: defaults({ endpointCount: 6, registeredPercent: 50, failingPercent: 100, maxEjectionPercent: 100 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "All six pods are registered and healthy. Ejection is available again, but no endpoint is failing.",
    tone: "ok",
    params: defaults({ endpointCount: 6, registeredPercent: 100, failingPercent: 0, maxEjectionPercent: 50 }),
  },
];

const experiment: Experiment = {
  id: "cluster-empty-host-set",
  title: "Explain a cluster with no healthy upstreams",
  simId: "cluster",
  question:
    "Kubernetes shows six Running pods, but Envoy reports no healthy upstreams. What should you inspect first?",
  prediction: {
    options: [
      { id: "ejection", label: "The cluster's registered endpoints and ejection state: only some pods are registered, and every registered endpoint is failing and ejected" },
      { id: "cpu", label: "Pod CPU requests: the pods are running but throttled" },
      { id: "listener", label: "The listener port: Envoy is bound to the wrong port" },
      { id: "route", label: "The route prefix: no route matches the request" },
    ],
    correctOptionId: "ejection",
    explanation:
      "Running pods are not automatically cluster endpoints. Endpoint discovery must register them, and outlier detection can eject registered hosts after consecutive failures. If the remaining registered hosts all fail and the ejection cap allows it, the load-balancing set becomes empty. The client gets a 503 with a no-healthy-upstream flag, while Kubernetes still reports the pods as Running.",
  },
  setup: defaults({ endpointCount: 6, registeredPercent: 50, failingPercent: 100, maxEjectionPercent: 100 }),
  runFor: 15,
  observe: [
    "Registered endpoints are three, not six; the other three pods never entered the cluster.",
    "All three registered endpoints return 5xx and are ejected.",
    "Usable capacity shortfall reaches three and the user error rate reaches 100%.",
    "The event feed records missing endpoints, ejection, and then no healthy upstream.",
    "The client sees a 503 even though every pod is still Running.",
  ],
  explain:
    "The cluster is defined by its endpoint set, not by the pods that exist. Endpoint discovery registered half the pods, and every registered endpoint failed. Outlier detection ejected all of them because the ejection cap allowed it. With no usable host, Envoy cannot select an upstream and returns 503. The pod count is the wrong denominator; `membership_total` and `membership_healthy` are the cluster views that explain the outage.",
  fix: defaults({ endpointCount: 6, registeredPercent: 100, failingPercent: 0, maxEjectionPercent: 50 }),
  debrief:
    "With all six pods registered and healthy, the cluster has capacity and ejection has nothing to remove. A high ejection cap is not a cure: it can empty the host set during a total dependency failure. The cap is a capacity guardrail, while endpoint health and discovery are the actual fix. Check both before adding pods.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Envoy cluster is a named group of upstream endpoints plus the policy Envoy uses to reach them: discovery type, load-balancing algorithm, connection pool, health checks, outlier detection, TLS, and protocol options. An endpoint is a host and port, usually with locality, priority, weight, and health status. A pod can exist in Kubernetes and still be absent from the cluster if endpoint discovery has not registered it, or present and unusable if it fails health checks or is ejected.",
  },
  {
    type: "p",
    text: "Envoy can learn endpoints statically, from DNS, or dynamically through endpoint discovery (EDS) over the xDS API. In a mesh, the control plane normally watches the orchestrator and pushes endpoint updates to each proxy. Health comes from two independent mechanisms. Active health checking probes the endpoint on a schedule. Passive outlier detection watches live request outcomes and ejects hosts that fail repeatedly or statistically. Both can run together, and a successful active health check can uneject a host and clear its outlier counters.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The cluster sits after the route. A route selects a cluster name; the cluster manager selects an endpoint from that cluster's load-balancing set. That set is not the same as the set of running pods. It is the registered endpoints minus hosts removed by active health checking, outlier ejection, or draining. When the set is empty, the proxy returns a local 503 with a no-healthy-upstream response flag rather than sending the request to a pod that Kubernetes still considers Running.",
  },
  {
    type: "table",
    headers: ["View", "Question it answers", "Signal"],
    rows: [
      ["Pod list", "What does the orchestrator think is running?", "Pod phase and readiness"],
      ["Cluster membership", "Which endpoints did discovery register?", "`membership_total`"],
      ["Cluster health", "Which registered endpoints can serve?", "`membership_healthy`"],
      ["Ejection state", "What did outlier detection remove?", "`ejections_active`, `ejections_total`"],
      ["Request outcome", "What did the caller actually get?", "5xx rate and response flags"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Active health check",
    rightTitle: "Passive outlier detection",
    rows: [
      { label: "Input", left: "Synthetic probes on a schedule", right: "Real request failures and latency" },
      { label: "Detects", left: "Process or dependency failure even without traffic", right: "A host that is failing only under real traffic" },
      { label: "Cost", left: "Probe traffic and configuration per endpoint", right: "No probe traffic, but needs enough requests" },
      { label: "Recovery", left: "Successful probes restore health", right: "Ejection time expires, or a successful active check unejects" },
    ],
  },
  {
    type: "p",
    text: "Outlier detection is configured per cluster. Consecutive 5xx, consecutive gateway failures, success rate, and failure percentage are the common detection types. Ejection time grows with repeated ejections and is capped by a maximum. `max_ejection_percent` limits how much of the cluster can be removed at once; when the cap would be exceeded, Envoy skips the ejection and increments an overflow counter. Envoy's default panic threshold is 50%: if available hosts fall below it, Envoy may disregard health status and route to all hosts, depending on the configured panic mode. That can preserve some success during a partial failure, but it also sends traffic to failing hosts.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A flow from client to sidecar, endpoint discovery, healthy endpoints, failing endpoints, and ejected endpoints.",
      "Registered, healthy, ejected, and shortfall counts, plus user error rate and ejected share.",
      "A failure where only some pods are registered and every registered endpoint is ejected.",
      "A peak case where one bad endpoint stays in rotation because ejection is disabled.",
      "Events that distinguish missing endpoints from ejected endpoints and an empty host set.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Empty host set. Watch the registered count fall before ejection starts, then watch all remaining endpoints leave the load-balancing set. Compare One bad endpoint, where the error rate rises but the host set stays non-empty. Recover by registering and healing the endpoints, not by raising the ejection cap.",
  },
  { type: "sim", simId: "cluster" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Six pods were running, but only three were registered as endpoints. All three returned 5xx. Outlier detection counted consecutive failures, ejected each one, and the ejection cap allowed the host set to become empty. The sidecar had no usable endpoint to select, so the client received 503 even though the pod list looked healthy. The pod count was never the cluster's capacity.",
  },
  {
    type: "p",
    text: "In the peak preset, one endpoint failed while ejection was disabled. The cluster stayed non-empty and most requests succeeded, but the error rate crossed the warning line. That is the tradeoff: a high ejection cap removes failing hosts quickly but can empty the cluster; a low cap preserves capacity but keeps bad hosts in rotation. Neither setting repairs the application.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`cluster.CLUSTER.membership_total` and `membership_healthy` show registered versus healthy endpoints.",
      "`ejections_active`, `ejections_total`, and `ejections_overflow` show outlier detection activity and cap pressure.",
      "`upstream_cx_none_healthy` increments when the proxy has no healthy host for a cluster.",
      "A 503 with the `UH` response flag means no healthy upstream host; `UF` means an upstream connection failure.",
      "Endpoint discovery health and the service selector explain why a running pod never appears in the cluster.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare running pods with `membership_total`, then `membership_total` with `membership_healthy`, then check `ejections_active` and `ejections_overflow`. Only after that should you look at the application's 5xx rate.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Fix endpoint discovery first if running pods are missing from the cluster.",
      "Fix the application or dependency if registered endpoints are returning 5xx.",
      "Check whether outlier detection is ejecting hosts faster than they can recover.",
      "Verify that the ejection cap and panic threshold leave enough capacity for the load.",
      "Shift traffic to another cluster or priority level if the host set is intentionally empty.",
      "Restore endpoints gradually and watch the error rate and ejection counters as capacity returns.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A high ejection cap removes bad hosts quickly but can empty the cluster during a fleet-wide failure.",
      "A low cap preserves capacity but keeps failing hosts in the load-balancing rotation.",
      "Active health checks detect failures without traffic but add probe load and can uneject a host that is failing only under real requests.",
      "Passive outlier detection reflects real traffic but needs enough requests to make a decision.",
      "The panic threshold can preserve partial success by ignoring health, at the cost of sending traffic to hosts known to be failing.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-cluster",
    question:
      "A service has six running pods, but callers get 503s and the proxy says no healthy upstream. Which cluster views do you read, and in what order?",
    difficulty: 3,
    hints: [
      "Running pods are not endpoints.",
      "Separate discovery from health and ejection.",
    ],
    answer:
      "I would compare the running pod count with `membership_total` first. If membership is lower, endpoint discovery or readiness is the problem. Then I would compare `membership_total` with `membership_healthy`. If healthy is zero, I would check `ejections_active`, `ejections_total`, and `ejections_overflow` to see whether outlier detection removed the hosts, and check the application's 5xx rate to see why. Finally I would check `upstream_cx_none_healthy` and the `UH` response flag to confirm the proxy had no host to select. The fix depends on which gap is real: discovery, application health, or ejection capacity.",
    followUps: [
      "What does `ejections_overflow` tell you?",
      "How does a panic threshold change the outcome?",
      "When would you disable ejection?",
    ],
    redFlags: [
      "Restarts pods without checking membership.",
      "Treats pod count as endpoint count.",
      "Raises the ejection cap first.",
    ],
    rubric: [
      "Separates membership from health.",
      "Reads ejection counters.",
      "Uses the no-healthy-upstream signal.",
      "Chooses a fix matched to the gap.",
    ],
  },
  {
    id: "ejection-tradeoff",
    question:
      "Why not set `max_ejection_percent` to 100 so bad endpoints are always removed? What can go wrong?",
    difficulty: 3,
    hints: [
      "Ejection removes capacity.",
      "A fleet-wide failure is not an endpoint outlier.",
    ],
    answer:
      "Outlier detection assumes a few hosts are unlike the rest. If the whole fleet fails, ejecting every host removes all capacity and turns a partial outage into a complete one. A cap keeps some hosts available even when the failure is widespread, and the panic threshold can also route to unhealthy hosts as a last resort. I would size the cap so healthy capacity remains for the expected load, and treat a high ejection rate as a signal to fix the dependency, not as a reason to raise the cap.",
    followUps: [
      "How would you choose the cap for a six-host cluster?",
      "What happens when the cap blocks an ejection?",
      "How does active health checking interact with ejection?",
    ],
    redFlags: [
      "Sets 100% unconditionally.",
      "Ignores remaining capacity.",
      "Assumes ejection repairs the application.",
    ],
    rubric: [
      "Explains the outlier assumption.",
      "Names capacity loss.",
      "Mentions the cap and panic behavior.",
      "Chooses a defensible cap.",
    ],
  },
  {
    id: "discovery-vs-health",
    question:
      "How do you tell a missing endpoint from an unhealthy endpoint, and why does the distinction change the fix?",
    difficulty: 2,
    hints: [
      "One is a membership problem.",
      "The other is a request-outcome problem.",
    ],
    answer:
      "A missing endpoint never appears in `membership_total`; the discovery source, selector, or readiness is wrong. An unhealthy endpoint appears in membership but is removed from the healthy set by a health check or outlier detection; the application or its dependency is failing. The first fix is configuration and discovery, the second is application health or capacity. Looking at the wrong one leads to restarts or selector changes that cannot help.",
    followUps: [
      "Which counter shows a host was never registered?",
      "Which counter shows a host was ejected?",
      "Could a pod be Ready but still missing from EDS?",
    ],
    redFlags: [
      "Restarts pods for a selector problem.",
      "Changes selectors for an application failure.",
      "Ignores membership.",
    ],
    rubric: [
      "Distinguishes membership from health.",
      "Names the right counters.",
      "Matches fix to cause.",
      "Explains readiness versus registration.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show `membership_total`, `membership_healthy`, and ejection counters per cluster.",
      "Endpoint discovery and service selectors are covered by a test that asserts the expected endpoint count.",
      "Outlier detection thresholds and the ejection cap are documented with the expected capacity.",
      "The panic threshold and panic mode are intentional, not left unexplained.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare running pods with registered endpoints before restarting anything.",
      "Compare registered endpoints with healthy endpoints before changing the application.",
      "Read `ejections_active` and `ejections_overflow` to see whether ejection is the cause or the symptom.",
      "Check for the `UH` response flag to confirm no healthy upstream.",
      "Protect remaining capacity with load shedding or a traffic shift if the host set is shrinking.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add an alert for a large gap between running pods and registered endpoints.",
      "Review whether the ejection cap left enough capacity for the observed load.",
      "Test a fleet-wide failure to confirm the cluster does not eject itself empty.",
      "Document the discovery path from pod to endpoint to cluster.",
    ],
  },
];

const references = [
  {
    title: "Envoy upstream clusters",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/upstream",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Cluster manager, service discovery, health checking, connection pooling, and load balancing.",
  },
  {
    title: "Envoy outlier detection",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Ejection algorithm, detection types, `max_ejection_percent`, and ejection time behavior.",
  },
  {
    title: "Envoy cluster statistics",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Membership, health, ejection, and upstream request counters used to read cluster state.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    cluster: {
      model: clusterModel,
      presets,
      instructions:
        "Start Healthy, apply Empty host set, and read the registered, healthy, and ejected counts in that order. Compare One bad endpoint to see errors without an empty host set.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The fixed request rate, failure ramp, and ejection threshold are teaching values, not Envoy defaults or provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "mesh-envoy-listeners",
    "mesh-outlier-detection",
    "mesh-failover",
    "mesh-envoy-admin",
    "mesh-circuit-breaking",
  ],
};
