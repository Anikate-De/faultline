import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_RATE = 30_000;
const STABLE_ERROR = 0.2;
const STABLE_LATENCY = 120;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: MAX_RATE,
    step: 500,
    value: 10_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests entering the route. The split applies after host and path matching, so only this route's traffic is weighted.",
    format: "rps" as const,
  },
  {
    id: "canaryWeight",
    label: "Canary weight",
    min: 0,
    max: 100,
    step: 1,
    value: 5,
    unit: "%",
    group: "Split",
    help: "Share of the route sent to the canary cluster. Zero removes it from the route without a deploy.",
    format: "percent" as const,
  },
  {
    id: "canaryErrorRate",
    label: "Canary application errors",
    min: 0,
    max: 20,
    step: 1,
    value: 1,
    unit: "%",
    group: "Canary",
    help: "Errors returned by the canary application itself. Unready endpoints add failures on top of this rate.",
    format: "percent" as const,
  },
  {
    id: "canaryLatency",
    label: "Canary latency",
    min: 50,
    max: 2_000,
    step: 50,
    value: 250,
    unit: " ms",
    group: "Canary",
    help: "Illustrative canary response time. The stable version is modeled at 120 ms.",
    format: "ms" as const,
  },
  {
    id: "canaryReadyPercent",
    label: "Canary endpoints ready",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Canary",
    help: "Share of canary endpoints that pass readiness and health checks. Unready endpoints return errors if the route still sends them traffic.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rate: number;
  weightPct: number;
  weight: number;
  canaryErrorRate: number;
  canaryLatency: number;
  readyPct: number;
  unreadyShare: number;
  canaryFail: number;
  canaryObserved: number;
  overallError: number;
  canaryRps: number;
  stableRps: number;
  p99: number;
  readyEndpoints: number;
}

function compute(p: Params, jitter = 0): Computed {
  const rate = Math.max(1, Math.round(num(p, "requestRate", 10_000)));
  const weightPct = clamp(num(p, "canaryWeight", 5), 0, 100);
  const weight = weightPct / 100;
  const canaryErrorRate = clamp(num(p, "canaryErrorRate", 1), 0, 100);
  const canaryLatency = Math.max(1, num(p, "canaryLatency", 250));
  const readyPct = clamp(num(p, "canaryReadyPercent", 100), 0, 100);
  const unreadyShare = (100 - readyPct) / 100;
  const canaryFail = clamp(canaryErrorRate + ((100 - canaryErrorRate) * unreadyShare), 0, 100);
  const canaryObserved = weight > 0 ? canaryFail : 0;
  const overallError = weight * canaryFail + (1 - weight) * STABLE_ERROR;
  return {
    rate,
    weightPct,
    weight,
    canaryErrorRate,
    canaryLatency,
    readyPct,
    unreadyShare,
    canaryFail,
    canaryObserved,
    overallError,
    canaryRps: rate * weight,
    stableRps: rate * (1 - weight),
    p99: Math.max(1, (weight > 0 ? Math.max(STABLE_LATENCY * 1.2, canaryLatency * 1.4 + unreadyShare * 150) : STABLE_LATENCY * 1.2) + jitter),
    readyEndpoints: readyPct,
  };
}

function healthFor(pct: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (pct >= crit) return "crit";
  if (pct >= warn) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const overallHealth = healthFor(c.overallError, 1, 5);
  const canaryHealth = healthFor(c.canaryObserved, 5, 20);
  const routeHealth = overallHealth === "ok" && canaryHealth !== "ok" ? "warn" : overallHealth;
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: overallHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `${c.rate.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "gateway",
        label: "Mesh gateway",
        kind: "mesh",
        health: overallHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: "weighted route",
        meta: { view: "flow" },
      },
      {
        id: "route",
        label: "Route weights",
        kind: "mesh",
        health: routeHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `${(100 - c.weightPct).toFixed(0)} stable · ${c.weightPct.toFixed(0)} canary`,
        detail: `The route sends ${c.weightPct}% of ${c.rate.toLocaleString()} rps to the canary. Weights are relative; they do not change client configuration.`,
        meta: { view: "flow" },
      },
      {
        id: "stable",
        label: "Stable version",
        kind: "service",
        health: overallHealth,
        utilization: clamp(c.stableRps / MAX_RATE),
        throughput: c.stableRps,
        sublabel: `${Math.round(c.stableRps).toLocaleString()} rps · 0.2% errors`,
        meta: { view: "flow" },
      },
      {
        id: "canary",
        label: "Canary version",
        kind: "service",
        health: canaryHealth,
        utilization: clamp(c.canaryRps / MAX_RATE),
        throughput: c.canaryRps,
        sublabel: `${Math.round(c.canaryRps).toLocaleString()} rps · ${c.canaryObserved.toFixed(1)}% errors`,
        detail: `${c.readyPct}% of canary endpoints are ready. Unready endpoints add failures when the route still sends them traffic.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-gateway", "clients", "gateway", c.rate / MAX_RATE, overallHealth),
      edge("gateway-route", "gateway", "route", c.rate / MAX_RATE, routeHealth),
      edge("route-stable", "route", "stable", c.stableRps / MAX_RATE, overallHealth),
      edge("route-canary", "route", "canary", c.canaryRps / MAX_RATE, canaryHealth),
    ],
    metrics: [
      metric("error-rate", "Overall error rate", c.overallError, "%", 1, 5, "percent"),
      metric("canary-error", "Canary mesh error rate", c.canaryObserved, "%", 5, 20, "percent"),
      metric("p99", "Blended p99", c.p99, "ms", 500, 1_500, "ms"),
      metric("canary-rps", "Canary traffic", c.canaryRps, " rps", undefined, undefined, "rps"),
      metric("ready", "Canary endpoints ready", c.readyPct, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      weight: c.weightPct,
      canaryFail: c.canaryFail,
      overallError: c.overallError,
      unready: c.unreadyShare,
    },
    summary: `${c.weightPct.toFixed(0)}% canary: ${c.overallError.toFixed(1)}% overall errors, ${c.canaryObserved.toFixed(1)}% on canary, p99 ${Math.round(c.p99)} ms.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  items.push(`${c.weightPct.toFixed(0)}% of ${c.rate.toLocaleString()} rps goes to the canary, so a canary error rate of ${c.canaryFail.toFixed(1)}% becomes ${(c.weight * c.canaryFail).toFixed(2)} percentage points of the overall rate.`);
  if (c.unreadyShare > 0 && c.weight > 0) {
    items.push(`${(c.unreadyShare * 100).toFixed(0)}% of canary endpoints are unready. The route does not fix readiness; if traffic reaches them, it fails regardless of the application's own error rate.`);
  }
  if (c.weight === 0) {
    items.push("The canary weight is zero, so the canary is outside the request path. Rollback does not require a deployment.");
  }
  items.push("Weights are relative, not a promise of capacity. Check that the canary has enough ready endpoints for the share before shifting traffic.");
  items.push("Per-version observability is part of the split. A single aggregate error rate can dilute a failing canary until the weight is high enough to dominate.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Overall errors are above the SLO",
    cause: "One weighted version is failing, or both versions are failing. The overall rate is the weighted sum, so a broken canary can hide behind a small weight until the weight rises.",
    fix: "Split the error rate by version before changing the weight. Roll the weight to zero if the canary is responsible, then fix readiness or the application and retry from a small share.",
    checkFirst: [
      "Compare the stable and canary error rates separately.",
      "Check whether the canary endpoints are ready and passing health checks.",
      "Check whether the route change reached every proxy.",
    ],
  },
  {
    id: "canary-error",
    metricId: "canary-error",
    warn: 5,
    crit: 20,
    title: "The canary's mesh error rate is high",
    cause: "The canary application is returning errors, or a share of its endpoints is unready and still receiving traffic. The mesh sees both as failed requests.",
    fix: "Roll the weight to zero first. Then separate application errors from readiness failures, fix the canary, and shift traffic back in small steps.",
    checkFirst: [
      "Are the failures application responses or proxy-generated rejections?",
      "What share of canary endpoints is ready?",
      "Did the canary pass its health check before the weight changed?",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 500,
    crit: 1_500,
    title: "The blended p99 exceeds the user budget",
    cause: "The canary is slower than the stable version. A weighted split sends a share of users to that tail, and the aggregate p99 reflects the slower path as soon as any traffic reaches it.",
    fix: "Roll back if the tail breaches the objective, or keep the weight small until the canary latency is understood. Do not average the two versions and call it healthy.",
    checkFirst: [
      "Compare stable and canary latency distributions, not just their means.",
      "Check whether the canary is CPU or connection constrained at its current share.",
      "Check whether retries are magnifying the slow path.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const trafficSplittingModel: SimModel = {
  id: "mesh-traffic-splitting",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const jitter = frame.t === 0 ? 0 : rng.between(-2, 2);
    const computed = compute(p, jitter);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) recordSeries(next, `load.${node.id}`, (node.utilization ?? 0) * 100);
    if (computed.weight > 0 && computed.unreadyShare > 0 && frame.flags.unreadySeen !== 1) {
      pushEvent(next, {
        id: "unready-canary",
        at: frame.t,
        severity: "crit",
        title: "Weighted traffic reaches unready canary endpoints",
        detail: `${(computed.unreadyShare * 100).toFixed(0)}% of canary endpoints are not ready, and the route sends ${computed.weightPct.toFixed(0)}% of traffic to that cluster.`,
        nodeId: "canary",
        metricId: "canary-error",
      });
      next.flags.unreadySeen = 1;
    }
    if (computed.overallError > 5 && frame.flags.errorSeen !== 1) {
      pushEvent(next, {
        id: "split-error",
        at: frame.t,
        severity: "crit",
        title: "Weighted route is failing users",
        detail: `The overall error rate is ${computed.overallError.toFixed(1)}%, with ${computed.canaryObserved.toFixed(1)}% on the canary at a ${computed.weightPct.toFixed(0)}% weight.`,
        nodeId: "route",
        metricId: "error-rate",
      });
      next.flags.errorSeen = 1;
    }
    next.summary = `${computed.weightPct.toFixed(0)}% canary: ${computed.overallError.toFixed(1)}% overall errors, ${computed.canaryObserved.toFixed(1)}% on canary, p99 ${Math.round(computed.p99)} ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => insightsFor(compute(p)),
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
    description: "5% of traffic goes to a ready canary with a 1% application error rate. The stable version carries the rest.",
    tone: "ok",
    params: defaults({ requestRate: 10_000, canaryWeight: 5, canaryErrorRate: 1, canaryLatency: 250, canaryReadyPercent: 100 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A 25% split to a slower canary at 20,000 rps. Errors stay bounded, but the blended p99 crosses its warning threshold.",
    tone: "warn",
    params: defaults({ requestRate: 20_000, canaryWeight: 25, canaryErrorRate: 2, canaryLatency: 700, canaryReadyPercent: 100 }),
  },
  {
    id: "failure",
    label: "Unready canary",
    description: "All traffic goes to a canary whose endpoints are not ready. Every request fails at the proxy, not in the application.",
    tone: "crit",
    params: defaults({ requestRate: 10_000, canaryWeight: 100, canaryErrorRate: 2, canaryLatency: 300, canaryReadyPercent: 0 }),
  },
  {
    id: "recovery",
    label: "Rolled back",
    description: "The canary weight is zero. The stable version serves everything and the canary is out of the request path.",
    tone: "ok",
    params: defaults({ requestRate: 10_000, canaryWeight: 0, canaryErrorRate: 10, canaryLatency: 300, canaryReadyPercent: 50 }),
  },
  {
    id: "half",
    label: "Half rollout",
    description: "Half the traffic goes to a canary with 70% unready endpoints. The diluted error rate is no longer small.",
    tone: "crit",
    params: defaults({ requestRate: 10_000, canaryWeight: 50, canaryErrorRate: 2, canaryLatency: 400, canaryReadyPercent: 30 }),
  },
];

const experiment: Experiment = {
  id: "predict-unready-weight",
  title: "Predict the full-weight canary",
  simId: "traffic-splitting",
  question:
    "A canary has 30% unready endpoints and a 1% application error rate. At 5% weight the overall error rate looks tolerable. You raise the weight to 100%. What do users see?",
  prediction: {
    options: [
      { id: "one", label: "About 1%, because the application error rate has not changed" },
      { id: "thirty", label: "About 31%, because unready endpoints fail for their share of canary requests" },
      { id: "zero", label: "Zero, because the route removes unready endpoints automatically" },
      { id: "five", label: "About 5%, because weight only changes routing, not failures" },
    ],
    correctOptionId: "thirty",
    explanation:
      "The weight sends requests to the canary cluster. If readiness or health checking has not removed the unready endpoints, they return proxy errors, and those failures add to the application's 1%. At full weight the canary is the dominant path, so its 30% unready share becomes roughly 30% of all requests. A small weight diluted the same failure; it did not fix it.",
  },
  setup: defaults({ requestRate: 10_000, canaryWeight: 100, canaryErrorRate: 1, canaryLatency: 300, canaryReadyPercent: 70 }),
  runFor: 20,
  observe: [
    "The overall error rate lands near 31%, not near 1%.",
    "The canary mesh error rate is high while the application's own error rate stays at 1%.",
    "The stable version is healthy but receives no traffic at 100% weight.",
    "The event feed reports weighted traffic reaching unready endpoints before the threshold fires.",
  ],
  explain:
    "Two failure sources are added together. The application returns 1% errors. Separately, 30% of the canary endpoints are unready, and the route still sends traffic to the cluster. Those requests fail before the application can return a response. At 5% weight the same failures existed but were diluted in the aggregate; at 100% they are the aggregate. Weight changes exposure, not readiness.",
  fix: defaults({ requestRate: 10_000, canaryWeight: 0, canaryErrorRate: 1, canaryLatency: 300, canaryReadyPercent: 100 }),
  debrief:
    "The first action is rollback: set the weight to zero, which removes the canary from the path without a deployment. Then fix readiness, confirm that the canary cluster has ready endpoints, and shift a small share back. A canary gate that only reads application errors misses the proxy failures entirely, which is why readiness and mesh-level per-version errors belong in the gate.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Traffic splitting sends a share of a route's requests to one cluster and the rest to another. In Envoy, a route action can name weighted clusters instead of a single cluster. In Kuma, a TrafficRoute uses positive weights for each destination; the weights are relative and do not have to sum to 100. Setting a destination's weight to zero removes it from the route without changing the client.",
  },
  {
    type: "p",
    text: "The split is a routing decision, not a deployment and not a canary analysis. It changes where requests go. Whether those requests succeed depends on the destination's readiness, health checks, capacity, and application behavior. A weight change can be instant; the state of the destination is not.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The route is evaluated inside each source sidecar after host, path, and header matching. That makes the change fast and client-agnostic, but it also means every proxy must receive the new route before the split is real. Traffic that bypasses the mesh, such as a direct pod address or an external client that terminates elsewhere, does not see the weight at all.",
  },
  {
    type: "compare",
    leftTitle: "Weighted split in the mesh",
    rightTitle: "Client-side or DNS split",
    rows: [
      { label: "Change speed", left: "Config push to proxies", right: "Client deploy, DNS TTL, or cache expiry" },
      { label: "Client changes", left: "None", right: "Often required" },
      { label: "Granularity", left: "Per route, host, path, or header", right: "Coarse or dependent on client logic" },
      { label: "Blind spot", left: "Traffic that bypasses the mesh", right: "Traffic that ignores the client or DNS record" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The canary weight and the request rate each version receives.",
      "Overall error rate, canary mesh error rate, and the blended p99.",
      "Ready canary endpoints: the health signal that the weight does not control.",
      "A flow view of clients, the gateway, the weighted route, the stable version, and the canary.",
      "Events when weighted traffic reaches unready endpoints and when the split starts failing users.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Unready canary to see all traffic fail at the proxy. Apply Rolled back to confirm that weight zero restores service without a deploy. Run the experiment before opening the debrief: the question is what the weight exposes, not what it changes.",
  },
  {
    type: "table",
    headers: ["Control", "Changes", "Does not change"],
    rows: [
      ["Canary weight", "Share of route traffic sent to the canary", "Readiness, capacity, or application behavior"],
      ["Readiness gate", "Whether an endpoint can receive traffic", "The route weight"],
      ["Per-version metrics", "Visibility into each destination", "The split itself"],
      ["Rollback to zero", "Removes the canary from the path", "The canary's deployment or bugs"],
    ],
  },
  { type: "sim", simId: "traffic-splitting" },
  { type: "experiment", experimentId: "predict-unready-weight" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "At 5% weight, the canary's 30% unready share produced about 1.7% overall errors, which looked survivable. At 100% weight the same canary produced about 31% errors. The application error rate never changed; the route simply sent every request to a cluster where 30% of the endpoints were not ready. The rollback preset set the weight to zero and restored the stable path immediately.",
  },
  {
    type: "p",
    text: "The half-rollout preset shows the arithmetic between those extremes: 50% weight to a canary with 70% unready endpoints produced about 35% overall errors. The weight scales exposure. It does not scale readiness, capacity, or the application's own failure rate.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Request rate, error rate, and latency split by version, not only aggregated for the service.",
      "Canary endpoint readiness and health-check status, compared with the weight.",
      "The route configuration in the proxy config dump: weighted clusters and their current weights.",
      "Proxy-generated failures such as no healthy upstream, separated from application 5xx responses.",
      "The time each proxy received the route update, because a partial rollout produces a mixed split.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check readiness before weight. Confirm that the canary has enough ready endpoints for the share and that every proxy has the new route. Then compare per-version error and latency. If the canary is failing, roll the weight to zero before debugging the application.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Roll back first: set the canary weight to zero. It is fast, reversible, and does not require a deployment.",
      "Fix readiness or health checks so unready endpoints are removed from the canary cluster before traffic returns.",
      "Confirm that the canary has capacity for the intended share at peak, not just at the current traffic level.",
      "Add per-version error and latency signals to the canary gate. An aggregate rate can dilute a failing canary.",
      "Shift traffic in small steps, verify the gate at each step, and keep the stable version warm for rollback.",
      "Record the weight change, the time it reached each proxy, and the signal that justified the next step.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A weighted route is fast to change and easy to roll back, but it cannot make an unready or undersized canary safe.",
      "Small weights limit blast radius and hide tail failures. The canary needs enough traffic for its signals to be meaningful.",
      "Per-version observability adds cost and configuration, but an aggregate rate is not a canary gate.",
      "Weights are relative and need not sum to 100 in Kuma. Treat them as proportions, not as a guarantee that traffic will be evenly divided by endpoint count.",
      "Mesh splitting only covers traffic that goes through the mesh. Direct pod access and external paths need their own control.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "where-split",
    question:
      "You need 5% canary traffic and instant rollback. Where do you implement the split, and what must be true before it is useful?",
    difficulty: 2,
    hints: [
      "Avoid changing every client.",
      "The split is only as good as the signal that gates it.",
    ],
    answer:
      "I would implement it as a weighted route in the mesh, at the sidecar or gateway that sees the traffic. That avoids client changes and makes rollback a weight change to zero. Before it is useful, the canary needs ready endpoints, enough capacity for its share, and per-version error and latency metrics. The gate must read the canary's own signals, not just the aggregate, because a small weight dilutes failures. I would also confirm that the traffic actually traverses the mesh; a direct pod path bypasses the weight entirely.",
    followUps: [
      "What would you set the first weight to and why?",
      "How do you know every proxy received the change?",
      "What signal would trigger rollback?",
    ],
    redFlags: [
      "Changes client configuration for every rollout.",
      "Splits traffic without per-version metrics.",
      "Assumes the canary is ready because the deployment completed.",
    ],
    rubric: [
      "Places the split at the route.",
      "Requires readiness and capacity.",
      "Uses per-version signals.",
      "Defines rollback to zero.",
    ],
  },
  {
    id: "debug-split",
    question:
      "A weight change to 50% causes errors to jump. How do you find out whether the canary or the route is responsible?",
    difficulty: 3,
    hints: [
      "Compare versions before comparing the service.",
      "Separate proxy failures from application responses.",
    ],
    answer:
      "I would split the error rate by version and compare it with the pre-change baseline. If the canary's error rate is high and the stable version is unchanged, the canary is responsible. I would then check readiness, health checks, and capacity for the canary, and separate proxy-generated failures from application 5xx. I would also confirm that the route reached every proxy and that the actual weights match the intended split. If the route is correct and the canary is failing, roll the weight to zero first, then debug the canary.",
    followUps: [
      "What would a mixed split across proxies look like?",
      "How do you tell a no-healthy-upstream failure from an application error?",
      "What if both versions show the same error rate?",
    ],
    redFlags: [
      "Looks only at the aggregate error rate.",
      "Raises the weight to gather more data.",
      "Blames the mesh without checking readiness.",
    ],
    rubric: [
      "Splits metrics by version.",
      "Checks readiness and capacity.",
      "Separates proxy and application errors.",
      "Rolls back before debugging.",
    ],
  },
  {
    id: "weight-math",
    question:
      "A canary has a 10% error rate and receives 5% of traffic. What overall error rate do you expect, and why is that number dangerous?",
    difficulty: 2,
    hints: [
      "Weight the failure rate by the traffic share.",
      "A small number can still hide a large problem.",
    ],
    answer:
      "If the stable version is near zero, the overall rate is roughly 5% of 10%, or 0.5%. That looks healthy against a 1% objective. The danger is that the canary's own error rate is ten times the stable baseline and may be concentrated in a route, tenant, or endpoint set. A small weight dilutes the signal and can let a bad canary sit in production. I would gate on the canary's per-version rate and enough request volume, not only the aggregate.",
    followUps: [
      "How much traffic does the canary need for a reliable signal?",
      "What if the canary error is concentrated in one endpoint?",
      "Would you increase the weight to learn more?",
    ],
    redFlags: [
      "Uses only the aggregate rate.",
      "Ignores sample size.",
      "Treats a small weight as proof of safety.",
    ],
    rubric: [
      "Computes the weighted rate.",
      "Names the dilution risk.",
      "Uses per-version signals.",
      "Considers volume.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every weighted route has an owner, a stable destination, and a documented rollback weight.",
      "The canary has ready endpoints and capacity for its intended share at peak.",
      "Per-version error and latency metrics feed the canary gate.",
      "The route change reaches every proxy, and the actual weights are visible in config.",
      "Traffic that bypasses the mesh is known and excluded from the canary claim.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Roll the canary weight to zero before debugging the application.",
      "Check readiness and health before changing the weight again.",
      "Compare per-version errors and latency, not just the aggregate.",
      "Separate proxy-generated failures from application responses.",
      "Confirm the route update reached each proxy and the weights match the intent.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the readiness or health check that allowed unready endpoints into the split.",
      "Add the missed signal to the canary gate.",
      "Re-test the split at a small weight with enough traffic for the signal.",
      "Verify that rollback to zero works without a deployment.",
      "Document the weight steps and the evidence required for each one.",
    ],
  },
];

const references = [
  {
    title: "Kuma TrafficRoute",
    url: "https://kuma.io/docs/latest/policies/traffic-route/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Weighted routing, relative weights, zero-weight removal, and L4 versus L7 splits.",
  },
  {
    title: "Envoy route components: weighted clusters",
    url: "https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/route/v3/route_components.proto",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Weighted cluster configuration on a route action and the total weight field.",
  },
  {
    title: "Envoy health checking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Active health checking and endpoint removal, which determine whether a weighted cluster can serve its share.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "traffic-splitting": {
      model: trafficSplittingModel,
      presets,
      instructions:
        "Start Healthy, apply Unready canary, then Rolled back. Compare the overall error rate with the per-version rate at each weight.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Stable error rate, latency, readiness behavior, and traffic shares are teaching values, not Envoy or Kuma defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-envoy-routes", "mesh-canary", "mesh-mtls", "deployment-canary-metric-gate"],
};
