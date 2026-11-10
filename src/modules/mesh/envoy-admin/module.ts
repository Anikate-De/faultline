import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ENDPOINTS = 20;
const DEMAND_RPS = 4_000;
const ENDPOINT_CAPACITY = 500;

const params = [
  {
    id: "failedEndpoints",
    label: "Endpoints failing health checks",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Upstream health",
    help: "Share of the cluster's 20 endpoints that fail active health checks. The endpoint objects still exist in the cluster.",
    format: "percent" as const,
  },
  {
    id: "healthCheckInterval",
    label: "Health-check interval",
    min: 0,
    max: 30,
    step: 1,
    value: 5,
    unit: " s",
    group: "Detection",
    help: "How often active health checks run. Zero disables them, so failed endpoints stay in the load balancer pool.",
    format: "number" as const,
  },
  {
    id: "outlierEjection",
    label: "Outlier ejection",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Protection",
    help: "Share of failing endpoints ejected by passive outlier detection. Ejection stops new traffic but does not restore capacity.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Outcome {
  failedShare: number;
  healthSeconds: number;
  ejection: number;
  failedEndpoints: number;
  healthyEndpoints: number;
  healthyCapacity: number;
  staleFactor: number;
  staleShare: number;
  capacityError: number;
  errorRate: number;
  appRps: number;
  appDrop: number;
  p99: number;
}

function compute(p: Params): Outcome {
  const failedShare = clamp(num(p, "failedEndpoints", 0), 0, 100) / 100;
  const healthSeconds = Math.max(0, num(p, "healthCheckInterval", 5));
  const ejection = clamp(num(p, "outlierEjection", 0), 0, 100) / 100;
  const failedEndpoints = Math.round(failedShare * ENDPOINTS);
  const healthyEndpoints = ENDPOINTS - failedEndpoints;
  const healthyCapacity = healthyEndpoints * ENDPOINT_CAPACITY;
  const staleFactor = healthSeconds === 0 ? 1 : Math.min(1, healthSeconds / 15) * 0.2;
  const unsafeShare = failedShare * (1 - ejection);
  const staleShare = unsafeShare * staleFactor * 100;
  const capacityError = (Math.max(0, DEMAND_RPS - healthyCapacity) / DEMAND_RPS) * 100;
  const errorRate = Math.min(100, staleShare + capacityError);
  const appRps = DEMAND_RPS * (1 - errorRate / 100);
  const utilisation = healthyCapacity > 0 ? DEMAND_RPS / healthyCapacity : 2;
  const p99 = Math.min(5_000, 30 + 400 * Math.max(0, utilisation - 0.9) ** 2 + (healthyCapacity === 0 ? 1_000 : 0));
  return {
    failedShare,
    healthSeconds,
    ejection,
    failedEndpoints,
    healthyEndpoints,
    healthyCapacity,
    staleFactor,
    staleShare,
    capacityError,
    errorRate,
    appRps,
    appDrop: 100 - (appRps / DEMAND_RPS) * 100,
    p99,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(o: Outcome, seed: number): SimFrame {
  const clientHealth = healthFor(o.errorRate, 1, 5);
  const clusterHealth: SimFrame["nodes"][number]["health"] =
    o.healthyEndpoints === 0 ? "down" : healthFor(o.failedEndpoints * 5, 20, 50);
  const appHealth: SimFrame["nodes"][number]["health"] =
    o.appRps <= 0 ? "down" : o.appDrop >= 50 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: DEMAND_RPS,
        sublabel: `${fmt(DEMAND_RPS)} rps · fixed demand`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Envoy sidecar",
        kind: "mesh",
        health: clientHealth,
        utilization: clamp(o.errorRate / 100),
        throughput: DEMAND_RPS,
        sublabel: `${o.healthyEndpoints} of ${ENDPOINTS} endpoints healthy`,
        detail: `The proxy receives ${fmt(DEMAND_RPS)} rps. It owns the upstream cluster, health checks, and stats. Admin is available on 127.0.0.1:9901 in a normal deployment and should not be exposed publicly.`,
        meta: { view: "flow" },
      },
      {
        id: "cluster",
        label: "checkout cluster",
        kind: "service",
        health: clusterHealth,
        utilization: o.healthyCapacity > 0 ? clamp(DEMAND_RPS / o.healthyCapacity) : 1,
        throughput: o.appRps,
        capacity: o.healthyCapacity,
        sublabel:
          o.healthyEndpoints === 0
            ? "no healthy upstream"
            : `${o.healthyEndpoints} healthy · ${fmt(o.healthyCapacity)} rps`,
        detail: `Cluster endpoint health: ${o.healthyEndpoints} healthy, ${o.failedEndpoints} failing, ${Math.round(o.failedEndpoints * o.ejection)} ejected. In /clusters, look for health flags and the no healthy upstream warning.`,
        meta: { view: "flow" },
      },
      {
        id: "app",
        label: "Checkout app",
        kind: "service",
        health: appHealth,
        throughput: o.appRps,
        sublabel: o.appRps <= 0 ? "0 rps received · no error log" : `${fmt(o.appRps)} rps received`,
        detail:
          o.appRps <= 0
            ? "The application receives no requests and writes no error. The failure happened at the proxy, before the application was reached."
            : "The application receives the requests that survive the proxy. It cannot see requests that failed in the upstream cluster.",
        meta: { view: "flow" },
      },
      {
        id: "admin",
        label: "Envoy admin :9901",
        kind: "external",
        health: "ok",
        throughput: 0,
        sublabel: "/clusters · /stats · /ready",
        detail: "/clusters lists endpoints and health flags. /stats?filter=... shows counters. /config_dump shows the loaded config. /ready reports proxy readiness, not upstream health.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-sidecar", "clients", "sidecar", 1, clientHealth),
      edge("sidecar-cluster", "sidecar", "cluster", 1, clusterHealth),
      edge("cluster-app", "cluster", "app", o.appRps / DEMAND_RPS, appHealth),
      edge("sidecar-admin", "sidecar", "admin", 0.1, "ok", "local admin"),
    ],
    metrics: [
      metric("error-rate", "Client error rate", o.errorRate, "%", 1, 5, "percent"),
      metric("unhealthy-endpoints", "Unhealthy endpoints", o.failedEndpoints, " of 20", 2, 5, "count"),
      metric("app-drop", "Requests not reaching the app", o.appDrop, "%", 5, 20, "percent"),
      metric("app-rps", "Requests reaching the app", o.appRps, " rps", undefined, undefined, "rps"),
      metric("p99", "Client p99", o.p99, "ms", 200, 500, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      failed: o.failedEndpoints,
      healthy: o.healthyEndpoints,
      err: o.errorRate,
      appDrop: o.appDrop,
      paramsKey: "",
    },
    summary: `${o.healthyEndpoints} of ${ENDPOINTS} endpoints healthy; ${o.errorRate.toFixed(1)}% client errors; ${fmt(o.appRps)} rps reach the app.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.012 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.99 + 0.02 * Math.sin((index + (seed % 4)) / 2.5)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "The proxy is failing requests before the application",
    cause:
      "The upstream cluster has too few healthy endpoints, or healthy endpoints are saturated. The application sees fewer requests, not more errors, because the failed requests never arrive.",
    fix:
      "Open /clusters and find the failing cluster. Check endpoint health flags, the no healthy upstream message, and upstream failure counters. Fix the endpoints or the health-check configuration before changing the application.",
    checkFirst: [
      "Open /clusters and identify the cluster with unhealthy endpoints.",
      "Open /stats?filter=upstream and compare 5xx, connect failures, and pending overflow.",
      "Confirm that the application received fewer requests rather than logging errors.",
    ],
  },
  {
    id: "unhealthy-endpoints",
    metricId: "unhealthy-endpoints",
    warn: 2,
    crit: 5,
    title: "Too many upstream endpoints are unhealthy",
    cause:
      "Endpoints are failing active health checks or were ejected by outlier detection. The cluster object still exists, so a control-plane check can look healthy while the data plane has little usable capacity.",
    fix:
      "Check the endpoint health flags in /clusters, the health-check interval and threshold, and the outlier-detection settings. Ejection protects the cluster but does not replace the failed capacity.",
    checkFirst: [
      "Read /clusters for the endpoint health flags.",
      "Check whether the health check is too aggressive or the endpoint is genuinely failing.",
      "Check whether outlier detection ejected more capacity than intended.",
    ],
  },
  {
    id: "app-drop",
    metricId: "app-drop",
    warn: 5,
    crit: 20,
    title: "Requests are disappearing before the application",
    cause:
      "A proxy-level failure is dropping or rejecting requests. Application logs show no error because the requests never reached the process, which makes the incident look like a traffic drop rather than a failure.",
    fix:
      "Use Envoy admin to find the proxy-level cause. Check cluster health, upstream connection failures, and readiness. Then fix the upstream or the proxy configuration.",
    checkFirst: [
      "Compare client request rate with application request rate.",
      "Open /clusters and /stats?filter=upstream.",
      "Check /config_dump if a recent config change could have removed the cluster.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 200,
    crit: 500,
    title: "Healthy endpoints are saturated",
    cause:
      "Removing unhealthy endpoints leaves the survivors carrying more load. The cluster is healthy but under-provisioned, so latency rises even though the error rate may be low.",
    fix:
      "Restore endpoint health or add capacity. Ejection and health checks remove bad endpoints; they do not create capacity.",
    checkFirst: [
      "Compare the surviving endpoint count with the original endpoint count.",
      "Check per-endpoint request rate and connection pool saturation.",
      "Check whether the cluster's capacity is sized for the reduced endpoint set.",
    ],
  },
];

export const envoyAdminModel: SimModel = {
  id: "envoy-admin",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const o = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(o, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const jitter = rng.between(-0.008, 0.008);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(1, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const prevFailed = Number(frame.flags.failed ?? 0);
    const prevHealthy = Number(frame.flags.healthy ?? ENDPOINTS);
    const prevAppDrop = Number(frame.flags.appDrop ?? 0);
    const prevErr = Number(frame.flags.err ?? 0);
    if (o.failedEndpoints > 0 && prevFailed === 0) {
      pushEvent(next, {
        id: "endpoints-failing",
        at: frame.t,
        severity: o.failedEndpoints >= 5 ? "crit" : "warn",
        title: "Upstream endpoints are failing health checks",
        detail: `${o.failedEndpoints} of ${ENDPOINTS} endpoints are unhealthy. Check /clusters for health flags before changing the application.`,
        nodeId: "cluster",
        metricId: "unhealthy-endpoints",
      });
    }
    if (o.healthyEndpoints === 0 && prevHealthy > 0) {
      pushEvent(next, {
        id: "no-healthy-upstream",
        at: frame.t,
        severity: "crit",
        title: "No healthy upstream",
        detail: "Every endpoint in the cluster is unhealthy. Envoy rejects the request before it reaches the application, which is why the app has no error log.",
        nodeId: "cluster",
        metricId: "error-rate",
      });
    }
    if (o.appDrop >= 20 && prevAppDrop < 20) {
      pushEvent(next, {
        id: "requests-missing",
        at: frame.t,
        severity: "crit",
        title: "Requests are failing before the application",
        detail: `${o.appDrop.toFixed(1)}% of requests never reach Checkout. Compare /clusters and /stats with the application's request count.`,
        nodeId: "app",
        metricId: "app-drop",
      });
    }
    if (o.errorRate < 1 && prevErr >= 1) {
      pushEvent(next, {
        id: "cluster-recovered",
        at: frame.t,
        severity: "info",
        title: "The upstream cluster is healthy again",
        detail: "Client errors have cleared. Verify that the recovered endpoints are receiving traffic and that the cluster has enough capacity.",
        nodeId: "cluster",
      });
    }
    next.summary = `${o.healthyEndpoints} of ${ENDPOINTS} endpoints healthy; ${o.errorRate.toFixed(1)}% client errors; ${fmt(o.appRps)} rps reach the app.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const o = compute(p);
    return [
      `The cluster has ${o.healthyEndpoints} healthy endpoints and ${o.failedEndpoints} failing. Healthy capacity is ${fmt(o.healthyCapacity)} rps against ${fmt(DEMAND_RPS)} rps of demand.`,
      `${o.errorRate.toFixed(1)}% of client requests fail. The application receives ${fmt(o.appRps)} rps, so ${o.appDrop.toFixed(1)}% of requests never reach it.`,
      "Start with /clusters. It shows each endpoint's health flags, the priority level, and a no healthy upstream warning when the pool is empty.",
      "Use /stats?filter=upstream for counters such as upstream_rq_5xx, upstream_cx_connect_fail, and upstream_rq_pending_overflow. Counters explain what failed; /clusters shows which endpoint set failed.",
      "/ready reports whether the proxy has finished initializing, not whether its upstream clusters are healthy. A ready proxy can still have no healthy upstream.",
    ];
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
    description: "All 20 endpoints pass health checks. The app receives the full 4,000 rps.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Partial health failure",
    description: "Four endpoints fail health checks with a 5s interval. The app sees a small drop and the cluster is at its warning line.",
    tone: "warn",
    params: defaults({ failedEndpoints: 20, healthCheckInterval: 5, outlierEjection: 0 }),
  },
  {
    id: "failure",
    label: "Health checks off",
    description: "Twelve endpoints fail, health checks are disabled, and nothing is ejected. Requests keep going to dead endpoints.",
    tone: "crit",
    params: defaults({ failedEndpoints: 60, healthCheckInterval: 0, outlierEjection: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "All endpoints are healthy again with a 5s check. The app receives the full request rate.",
    tone: "ok",
    params: defaults({ failedEndpoints: 0, healthCheckInterval: 5, outlierEjection: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-no-healthy-upstream",
  title: "Predict why the app has no errors and no traffic",
  simId: "envoy-admin",
  question:
    "Checkout receives zero requests and its logs contain no errors. Envoy returns 503 to every client. All 20 endpoints are marked unhealthy and ejected. Which admin view explains this first?",
  prediction: {
    options: [
      { id: "clusters", label: "/clusters shows no healthy upstream and the endpoint health flags" },
      { id: "config", label: "/config_dump shows the listener was deleted" },
      { id: "ready", label: "/ready returns 503, so the proxy never started" },
      { id: "app", label: "The application log level is too high to show the errors" },
    ],
    correctOptionId: "clusters",
    explanation:
      "The proxy is running and ready, but its upstream cluster has no healthy endpoints. /clusters shows the endpoint health flags and a no healthy upstream warning, which is exactly the state that rejects requests before the application. /config_dump would show the cluster still configured; /ready would not explain an empty upstream pool.",
  },
  setup: defaults({ failedEndpoints: 100, healthCheckInterval: 0, outlierEjection: 100 }),
  runFor: 20,
  observe: [
    "Every endpoint is unhealthy and ejected, so the cluster has no usable upstream.",
    "Client errors reach 100% while application request rate is zero.",
    "The app node is down but has no error log, because no request reached it.",
    "The event feed records no healthy upstream and requests failing before the app.",
  ],
  explain:
    "Envoy rejects the request at the router when no healthy upstream exists. The application never runs, so it cannot log an error. Admin shows the proxy's view: /clusters lists the endpoints and their health, /stats counts the rejected requests, and /ready confirms the proxy itself is initialized. Reading only the application moves the investigation to the wrong layer.",
  fix: defaults({ failedEndpoints: 0, healthCheckInterval: 5, outlierEjection: 0 }),
  debrief:
    "With healthy endpoints and a 5s check, client errors return to zero and the app receives the full request rate. The fix was at the upstream layer, not the application. The production habit is to compare client request rate with application request rate; a gap points at the proxy, and /clusters is the first place to look.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Envoy's admin interface is a local HTTP endpoint that exposes the proxy's own view of the world. It is enabled by default on port 9901, bound to the loopback interface in normal deployments. The interface includes `/clusters` for upstream endpoints and health, `/config_dump` for the configuration the proxy actually loaded, `/stats` for counters and gauges, and `/ready` for initialization state. It is not a control plane and it does not change traffic by itself.",
  },
  {
    type: "p",
    text: "The value is separation of layers. An application can log a clean request while the proxy in front of it rejects the call for lack of a healthy upstream. The application never sees the request, so it cannot report the failure. Admin shows the layer that did see it: the proxy, its cluster, its endpoints, and its counters.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The proxy sits between the client and the application. It receives the downstream request, chooses an upstream cluster and endpoint, applies policy, and returns the response. Admin is a side channel into that process. In Kubernetes, reach it with a port-forward to the pod or through a debug sidecar; do not expose it on a public listener. In a VM or gateway deployment, bind it to a management interface with access control.",
  },
  {
    type: "table",
    headers: ["Admin endpoint", "Question it answers", "What it does not tell you"],
    rows: [
      ["/clusters", "Which upstream endpoints are healthy, drained, or ejected?", "Why the application is slow after the request arrives"],
      ["/stats", "Which counters are moving: 5xx, connect failures, overflow?", "Which specific endpoint caused a given request to fail"],
      ["/config_dump", "What configuration did the proxy actually load?", "Whether that configuration is correct for the service"],
      ["/ready", "Has the proxy finished initializing?", "Whether its upstream clusters are healthy"],
      ["/certs", "Which certificates are loaded and when do they expire?", "Whether every peer trusts the current bundle"],
    ],
  },
  {
    type: "p",
    text: "A useful order is `/clusters`, then `/stats`, then `/config_dump`. Start with the endpoint set because a missing or unhealthy endpoint explains a large class of 503s. Use stats to confirm the failure mode and to distinguish rejection from timeout or connection failure. Use the config dump when the cluster or listener does not look the way you expected.",
  },
  {
    type: "compare",
    leftTitle: "Application telemetry",
    rightTitle: "Envoy admin",
    rows: [
      { label: "Sees", left: "Requests that reached the process", right: "Requests the proxy accepted, rejected, or retried" },
      { label: "Blind spot", left: "Failures before the process", right: "Application logic after the response" },
      { label: "Best for", left: "Business errors and handler latency", right: "Upstream health, config, and proxy-level rejection" },
      { label: "Risk", left: "Looks clean during a proxy outage", right: "Exposes internal state if not access-controlled" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A client, sidecar, upstream cluster, application, and admin endpoint.",
      "Controls for failing endpoints, health-check interval, and outlier ejection.",
      "Client error rate, unhealthy endpoint count, requests that never reach the app, app request rate, and p99.",
      "An app node that goes down with no error log when the proxy has no healthy upstream.",
      "Events for failing endpoints, no healthy upstream, requests disappearing before the app, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Partial health failure and watch the app request rate fall while errors stay small. Apply Health checks off and read the unhealthy endpoint count before the error rate. Then use Recovery and confirm the app receives traffic again.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Teaching values",
    body: "Endpoint counts, capacities, and the error curve are illustrative teaching values. Real Envoy health flags and stat names are stable interfaces; the numeric behavior here is simplified for the lesson.",
  },
  { type: "sim", simId: "envoy-admin" },
  { type: "experiment", experimentId: "predict-no-healthy-upstream" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Endpoints failed health checks, and the proxy stopped using them. With health checks disabled, failed endpoints stayed in the pool and received traffic. With every endpoint unhealthy and ejected, the cluster had no usable upstream, so Envoy rejected requests before Checkout ran. The application looked quiet because it was never called.",
  },
  {
    type: "p",
    text: "The client error rate was the visible symptom, but the useful signal was the gap between client request rate and application request rate. That gap pointed at the proxy. `/clusters` showed the endpoint health flags and the empty pool; `/stats` counted the rejected requests; `/ready` confirmed the proxy itself was initialized. Each endpoint answered a different question.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A client error rate that rises while application request rate falls and application error logs stay empty.",
      "`/clusters` with endpoint health flags, priority levels, and a no healthy upstream warning.",
      "`/stats?filter=upstream` with `upstream_rq_5xx`, `upstream_cx_connect_fail`, `upstream_rq_pending_overflow`, and `upstream_rq_timeout`.",
      "`/ready` returning success while the upstream pool is empty; readiness is not upstream health.",
      "`/config_dump` showing the cluster, listener, and route that the proxy actually loaded, compared with the control plane's intended config.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare client request rate with application request rate. A gap means requests are failing before the app. Open /clusters and find the failing cluster, then use /stats to identify rejection, connect failure, or timeout. Check /ready only to rule out proxy initialization; a ready proxy can still have no healthy upstream.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the failing cluster in /clusters and read its endpoint health flags.",
      "Confirm the failure mode in /stats: rejection, connect failure, timeout, or pending overflow.",
      "Fix the endpoints or the health-check configuration; do not restart the application first.",
      "Check that ejection did not remove more capacity than the service can spare.",
      "Verify /config_dump if a recent change could have altered the cluster or listener.",
      "After recovery, confirm the app receives traffic and that p99 is back inside budget.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Active health checks remove bad endpoints quickly and add probe traffic and configuration surface.",
      "Disabling health checks avoids false positives and lets dead endpoints receive traffic.",
      "Outlier ejection protects the cluster from a failing host and can remove capacity the service still needs.",
      "The admin interface is invaluable during an incident and dangerous if exposed; keep it on the loopback interface or an access-controlled management plane.",
      "Config dump is the source of truth for what the proxy loaded, not proof that the config is correct.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "app-no-error",
    question:
      "A request fails but the application has no error log. How do you use Envoy admin to find the cause?",
    difficulty: 3,
    hints: [
      "The request may never have reached the application.",
      "Start with the upstream cluster, not the config dump.",
    ],
    answer:
      "I would compare client request rate with application request rate. If the app received nothing, the failure happened at the proxy. I would open /clusters and look for the failing cluster, endpoint health flags, and a no healthy upstream warning. Then /stats?filter=upstream would tell me whether the request was rejected, timed out, or failed to connect. /ready would only tell me whether the proxy initialized; it would not explain an empty upstream pool.",
    followUps: [
      "Which stat distinguishes rejection from timeout?",
      "What would you check if /clusters looks healthy?",
      "When would you use /config_dump?",
    ],
    redFlags: [
      "Starts by restarting the application.",
      "Reads only /ready.",
      "Assumes the app log is complete.",
    ],
    rubric: [
      "Compares client and app request rate.",
      "Uses /clusters for endpoint health.",
      "Uses /stats for the failure mode.",
      "Knows /ready is initialization.",
    ],
  },
  {
    id: "no-healthy-upstream",
    question:
      "What does 'no healthy upstream' mean, and what are the first three things you check?",
    difficulty: 2,
    hints: [
      "The cluster exists but has no usable endpoint.",
      "Health checks, ejection, and discovery are separate.",
    ],
    answer:
      "It means the proxy has a cluster but no endpoint it considers healthy enough to receive traffic. I would check the endpoint list and health flags in /clusters, then whether active health checks are failing because the probes are wrong or the endpoints are genuinely down. I would also check outlier ejection, because passive detection can remove endpoints without an active health-check failure. Finally I would check discovery: the endpoints may be missing entirely rather than unhealthy.",
    followUps: [
      "How would you tell ejection from a failed health check?",
      "What if only one proxy sees no healthy upstream?",
      "What would you do if the endpoints are healthy but drained?",
    ],
    redFlags: [
      "Assumes the service is down.",
      "Checks only the application.",
      "Ignores ejection and discovery.",
    ],
    rubric: [
      "Defines the state.",
      "Checks health flags.",
      "Separates active checks, ejection, and discovery.",
      "Names a concrete next step.",
    ],
  },
  {
    id: "admin-safety",
    question:
      "How would you make Envoy admin available for debugging without making it a security hole?",
    difficulty: 3,
    hints: [
      "Admin can change state, not just read it.",
      "Loopback binding is the default for a reason.",
    ],
    answer:
      "I would keep admin bound to the loopback interface or a dedicated management interface, never a public listener. Access would go through a port-forward, a bastion, or an authenticated debug sidecar, with authorization and audit at that layer. I would restrict which operators can reach it, because some admin endpoints can change logging, drain listeners, or quit the process. I would also avoid putting secrets in config dumps and verify that the admin port is excluded from the service's public security group or network policy.",
    followUps: [
      "Which admin endpoints are read-only?",
      "How would you audit admin access?",
      "What would you do if the admin port were already public?",
    ],
    redFlags: [
      "Exposes 9901 on the service load balancer.",
      "Treats admin as read-only.",
      "Has no audit trail.",
    ],
    rubric: [
      "Keeps admin local or management-only.",
      "Uses authenticated access.",
      "Restricts mutating endpoints.",
      "Checks network exposure.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every proxy's admin interface is bound to the loopback interface or a management interface, not a public listener.",
      "Operators know how to reach admin through a port-forward or debug sidecar.",
      "Dashboards compare client request rate with application request rate.",
      "The on-call runbook names /clusters, /stats, /config_dump, and /ready and what each answers.",
      "Health-check and outlier-ejection settings are documented per service.",
      "A config change is verified in /config_dump, not only in the control plane.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare client request rate with application request rate.",
      "Open /clusters and find the failing cluster and endpoint health flags.",
      "Use /stats?filter=upstream to distinguish rejection, timeout, and connect failure.",
      "Check /ready only to rule out proxy initialization.",
      "Check /config_dump if a recent change could have altered the cluster or listener.",
      "Record which endpoint and which stat explained the failure.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the upstream or health-check cause, not the application symptom.",
      "Verify that recovered endpoints receive traffic and that p99 is inside budget.",
      "Review whether ejection removed too much capacity.",
      "Add a dashboard or alert for the client-to-app request gap.",
      "Update the runbook with the admin path that worked.",
    ],
  },
];

const references = [
  {
    title: "Envoy administration interface",
    url: "https://www.envoyproxy.io/docs/envoy/latest/operations/admin",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Admin endpoints including /clusters, /config_dump, /stats, /ready, and /certs.",
  },
  {
    title: "Envoy cluster stats",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/upstream/cluster_manager/cluster_stats",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Upstream request, connection, and overflow counters used to diagnose cluster failures.",
  },
  {
    title: "Envoy health checking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Active health checks, endpoint health flags, and how unhealthy endpoints leave the pool.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "envoy-admin": {
      model: envoyAdminModel,
      presets,
      instructions:
        "Start Healthy, then apply Partial health failure and Health checks off. Compare client errors with the app request rate, then use Recovery.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Endpoint counts, capacities, and the error curve are teaching values; Envoy admin endpoint names and stat families are real.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-envoy-clusters", "mesh-access-logs", "mesh-failover", "mesh-outlier-detection"],
};
