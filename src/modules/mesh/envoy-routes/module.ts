import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAPACITY = 10_000;
const MAX_RATE = 20_000;

const params = [
  {
    id: "requestRate",
    label: "Requests per second",
    min: 500,
    max: MAX_RATE,
    step: 100,
    value: 6_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests entering the HTTP connection manager. Each cluster has an illustrative capacity of 10,000 rps.",
    format: "rps" as const,
  },
  {
    id: "canaryWeight",
    label: "Canary weight",
    min: 0,
    max: 100,
    step: 5,
    value: 10,
    unit: "%",
    group: "Route action",
    help: "Weight of the canary cluster inside the header route's weighted cluster action. Weight only matters after that route matches.",
    format: "percent" as const,
  },
  {
    id: "headerShare",
    label: "Traffic with x-canary",
    min: 0,
    max: 100,
    step: 5,
    value: 5,
    unit: "%",
    group: "Traffic",
    help: "Share of requests carrying the header that the canary route matches. In the demo the only header route keys on `x-canary: true`.",
    format: "percent" as const,
  },
  {
    id: "catchAllFirst",
    label: "Catch-all route first",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Route order",
    help: "0 places the header route first; 1 places the prefix `/` route first. Envoy uses the first matching route, so order changes the outcome.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  canaryWeight: number;
  headerShare: number;
  catchAllFirst: boolean;
  headerRate: number;
  matched: number;
  canary: number;
  stable: number;
  stableFromHeader: number;
  stableFromCatchAll: number;
  intended: number;
  shortfall: number;
  stableUtil: number;
  canaryUtil: number;
  errorRate: number;
  shadowed: boolean;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(500, Math.round(num(p, "requestRate", 6_000)));
  const canaryWeight = clamp(Math.round(num(p, "canaryWeight", 10)), 0, 100);
  const headerShare = clamp(Math.round(num(p, "headerShare", 5)), 0, 100);
  const catchAllFirst = num(p, "catchAllFirst", 0) >= 0.5;
  const headerRate = requestRate * (headerShare / 100);
  const matched = catchAllFirst ? 0 : headerRate;
  const canary = matched * (canaryWeight / 100);
  const stableFromHeader = matched - canary;
  const stableFromCatchAll = requestRate - matched;
  const stable = stableFromHeader + stableFromCatchAll;
  const intended = headerRate * (canaryWeight / 100);
  const shortfall = Math.max(0, intended - canary);
  const stableUtil = (stable / CAPACITY) * 100;
  const canaryUtil = (canary / CAPACITY) * 100;
  const overflow = Math.max(0, stable - CAPACITY) + Math.max(0, canary - CAPACITY);
  return {
    requestRate,
    canaryWeight,
    headerShare,
    catchAllFirst,
    headerRate,
    matched,
    canary,
    stable,
    stableFromHeader,
    stableFromCatchAll,
    intended,
    shortfall,
    stableUtil,
    canaryUtil,
    errorRate: (overflow / requestRate) * 100,
    shadowed: catchAllFirst && intended > 0,
  };
}

function healthForErrors(value: number): SimState {
  if (value >= 5) return "crit";
  if (value >= 1) return "warn";
  return "ok";
}

function healthForUtil(value: number): SimState {
  if (value >= 95) return "crit";
  if (value >= 80) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const requestHealth = healthForErrors(c.errorRate);
  const stableHealth = healthForUtil(c.stableUtil);
  const canaryHealth = healthForUtil(c.canaryUtil);
  const routeHealth: SimState = c.shadowed ? "down" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: requestHealth,
        throughput: c.requestRate,
        sublabel: `${c.headerShare}% send x-canary`,
        detail: "The client does not know which route will match. It only sends the host, path, headers, and method that the route table evaluates.",
        meta: { view: "flow" },
      },
      {
        id: "envoy",
        label: "Envoy HTTP connection manager",
        kind: "mesh",
        health: requestHealth,
        throughput: c.requestRate,
        sublabel: "virtual host → routes in order",
        detail: "The host or :authority header selects a virtual host. Envoy then checks that virtual host's routes in order and uses the first match.",
        meta: { view: "flow" },
      },
      {
        id: "route-canary",
        label: "Route: x-canary true",
        kind: "mesh",
        health: routeHealth,
        throughput: c.matched,
        sublabel: c.shadowed ? "shadowed by earlier route" : `header match → ${c.canaryWeight}% canary`,
        detail: c.shadowed
          ? "The catch-all route earlier in the list matches first, so this route is never evaluated. Its weight and header predicate cannot take effect."
          : "This route matches only requests with `x-canary: true`. Its weighted cluster action splits those requests between stable and canary.",
        meta: { view: "flow" },
      },
      {
        id: "route-catchall",
        label: "Route: prefix /",
        kind: "mesh",
        health: "ok",
        throughput: c.requestRate - c.matched,
        sublabel: "catch-all → stable",
        detail: "The prefix `/` route matches every request on the virtual host. If it appears before the header route, it shadows that route completely.",
        meta: { view: "flow" },
      },
      {
        id: "stable",
        label: "checkout-stable",
        kind: "service",
        health: stableHealth,
        utilization: clamp(c.stable / CAPACITY),
        throughput: c.stable,
        sublabel: `${Math.round(c.stable).toLocaleString()} rps`,
        detail: `The stable cluster receives ${Math.round(c.stable).toLocaleString()} rps, or ${c.stableUtil.toFixed(1)}% of its illustrative capacity.`,
        meta: { view: "flow" },
      },
      {
        id: "canary",
        label: "checkout-canary",
        kind: "service",
        health: c.shadowed ? "down" : canaryHealth,
        utilization: clamp(c.canary / CAPACITY),
        throughput: c.canary,
        sublabel: `${Math.round(c.canary).toLocaleString()} rps`,
        detail: c.shadowed
          ? "The canary cluster receives no traffic because the header route was never reached."
          : `The canary cluster receives ${Math.round(c.canary).toLocaleString()} rps, or ${c.canaryUtil.toFixed(1)}% of its illustrative capacity.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-envoy", "client", "envoy", c.requestRate / MAX_RATE, requestHealth),
      edge("envoy-canary-route", "envoy", "route-canary", c.matched / MAX_RATE, c.shadowed ? "down" : "ok"),
      edge("envoy-catchall-route", "envoy", "route-catchall", (c.requestRate - c.matched) / MAX_RATE, "ok"),
      edge("canary-route-stable", "route-canary", "stable", c.stableFromHeader / MAX_RATE, c.shadowed ? "down" : "ok"),
      edge("canary-route-canary", "route-canary", "canary", c.canary / MAX_RATE, c.shadowed ? "down" : canaryHealth),
      edge("catchall-route-stable", "route-catchall", "stable", c.stableFromCatchAll / MAX_RATE, stableHealth),
    ],
    metrics: [
      metric("stable-rps", "Stable traffic", c.stable, " rps", undefined, undefined, "rps"),
      metric("canary-rps", "Canary traffic", c.canary, " rps", undefined, undefined, "rps"),
      metric("canary-shortfall", "Canary traffic shortfall", c.shortfall, " rps", 100, 500, "rps"),
      metric("stable-util", "Stable cluster load", c.stableUtil, "%", 80, 95, "percent"),
      metric("canary-util", "Canary cluster load", c.canaryUtil, "%", 80, 95, "percent"),
      metric("error-rate", "Overflow errors", c.errorRate, "%", 1, 5, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.shadowed
      ? `Catch-all matched first; canary gets 0 rps; ${Math.round(c.shortfall).toLocaleString()} rps of intended canary traffic is missing.`
      : `${Math.round(c.canary).toLocaleString()} rps to canary; ${Math.round(c.stable).toLocaleString()} rps to stable; shortfall ${Math.round(c.shortfall).toLocaleString()} rps.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "canary-shortfall",
    metricId: "canary-shortfall",
    warn: 100,
    crit: 500,
    title: "Intended canary traffic is not reaching the canary cluster",
    cause:
      "A route earlier in the list matched the request first, so the header route was never evaluated. Alternatively, the header is absent from the traffic the route expects, or the weighted cluster sends all of its share to stable.",
    fix:
      "Read the route table in evaluation order. Put the specific header route before the broad prefix route, or give the broad route a narrower match. Then verify the weighted cluster split.",
    checkFirst: [
      "Read the virtual host's routes in order and find the first match for the request.",
      "Compare the header predicate with the actual request headers.",
      "Check the weighted cluster weights inside the matching route.",
    ],
  },
  {
    id: "stable-util",
    metricId: "stable-util",
    warn: 80,
    crit: 95,
    title: "The stable cluster is carrying too much traffic",
    cause:
      "A broad route or a high stable weight sends most traffic to the stable cluster. The canary may be healthy and unused while stable approaches its capacity.",
    fix:
      "Fix route order or adjust weights so the intended share reaches the canary. Add capacity only after the split is verified; a routing bug will consume any capacity you add.",
    checkFirst: [
      "Compare the route table's match order with the intended split.",
      "Check the weighted cluster weights and total weight.",
      "Compare each cluster's request rate with its capacity.",
    ],
  },
  {
    id: "canary-util",
    metricId: "canary-util",
    warn: 80,
    crit: 95,
    title: "The canary cluster is saturating",
    cause:
      "The weighted split sends more traffic to the canary than its capacity supports, or a route change increased the canary share without a capacity check.",
    fix:
      "Reduce the canary weight, add capacity, or gate promotion on the canary's latency and error signals. A canary at 100% weight is a full production deployment.",
    checkFirst: [
      "Compare the canary's request rate with its capacity and concurrency.",
      "Check whether the weight changed recently.",
      "Check the canary's error rate and latency, not only its CPU.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const routeModel: SimModel = {
  id: "mesh-envoy-routes",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p) => {
    const computed = compute(p);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (computed.shadowed && frame.flags.shadowedSeen !== 1) {
      pushEvent(next, {
        id: "route-shadowed",
        at: frame.t,
        severity: "crit",
        title: "Catch-all route shadows the canary route",
        detail: `The prefix \`/\` route appears first and matches every request, so the header route is never evaluated. ${Math.round(computed.intended).toLocaleString()} rps of intended canary traffic goes to stable.`,
        nodeId: "route-canary",
        metricId: "canary-shortfall",
      });
      next.flags.shadowedSeen = 1;
    }
    if (!computed.catchAllFirst && computed.shortfall < 1 && frame.flags.shadowedSeen === 1 && frame.flags.restoredSeen !== 1) {
      pushEvent(next, {
        id: "route-restored",
        at: frame.t,
        severity: "info",
        title: "Canary route is reachable again",
        detail: "The header route now appears before the catch-all and the intended canary share is reaching its cluster.",
        nodeId: "route-canary",
      });
      next.flags.restoredSeen = 1;
    }
    if (computed.stableUtil >= 80 && frame.flags.stableSeen !== 1) {
      pushEvent(next, {
        id: "stable-saturated",
        at: frame.t,
        severity: computed.stableUtil >= 95 ? "crit" : "warn",
        title: "Stable cluster is near capacity",
        detail: `The stable cluster receives ${Math.round(computed.stable).toLocaleString()} rps, or ${computed.stableUtil.toFixed(1)}% of its illustrative capacity.`,
        nodeId: "stable",
        metricId: "stable-util",
      });
      next.flags.stableSeen = 1;
    }
    if (computed.canaryUtil >= 80 && frame.flags.canarySeen !== 1) {
      pushEvent(next, {
        id: "canary-saturated",
        at: frame.t,
        severity: computed.canaryUtil >= 95 ? "crit" : "warn",
        title: "Canary cluster is near capacity",
        detail: `The canary cluster receives ${Math.round(computed.canary).toLocaleString()} rps, or ${computed.canaryUtil.toFixed(1)}% of its illustrative capacity.`,
        nodeId: "canary",
        metricId: "canary-util",
      });
      next.flags.canarySeen = 1;
    }
    next.summary = computed.shadowed
      ? `Catch-all matched first; canary gets 0 rps; ${Math.round(computed.shortfall).toLocaleString()} rps of intended canary traffic is missing.`
      : `${Math.round(computed.canary).toLocaleString()} rps to canary; ${Math.round(computed.stable).toLocaleString()} rps to stable; shortfall ${Math.round(computed.shortfall).toLocaleString()} rps.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(`The request rate is ${c.requestRate.toLocaleString()} rps; ${c.headerRate.toLocaleString()} rps carry the header. The header route receives ${Math.round(c.matched).toLocaleString()} rps and the catch-all receives ${Math.round(c.requestRate - c.matched).toLocaleString()} rps.`);
    if (c.shadowed) items.push("The catch-all route is earlier in the list, so the header route is never evaluated. This is a match-order problem, not a weight problem.");
    items.push("Envoy matches the host or :authority to a virtual host, then checks that virtual host's routes in order. The first matching route wins; later routes are not considered.");
    items.push("A weighted cluster action is inside one route. Its weights split traffic only after that route matches, so changing weight cannot rescue a route that never matches.");
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
    description: "Header route first, 5% of requests carry the header, and 10% of those go to canary. Stable carries almost everything.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "12,000 rps, every request carries the header, and 25% goes to canary. Stable is near its illustrative capacity.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, canaryWeight: 25, headerShare: 100, catchAllFirst: 0 }),
  },
  {
    id: "failure",
    label: "Shadowed",
    description: "The catch-all route is first. Every request matches it, so the header route and its canary weight never run.",
    tone: "crit",
    params: defaults({ requestRate: 6_000, canaryWeight: 100, headerShare: 20, catchAllFirst: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The header route is moved before the catch-all. The intended 20% canary share reaches the canary cluster.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, canaryWeight: 100, headerShare: 20, catchAllFirst: 0 }),
  },
  {
    id: "split",
    label: "Even split",
    description: "Every request carries the header and the weighted action sends 50% to each cluster.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, canaryWeight: 50, headerShare: 100, catchAllFirst: 0 }),
  },
];

const experiment: Experiment = {
  id: "route-order-shadow",
  title: "Find why the canary route never matches",
  simId: "route",
  question:
    "The canary route matches `x-canary: true` and its weight is 100%, but all traffic reaches stable. What should you inspect first?",
  prediction: {
    options: [
      { id: "order", label: "The route order: an earlier prefix route matches first and shadows the header route" },
      { id: "weight", label: "The canary weight: it is too low, so stable receives the traffic" },
      { id: "pods", label: "The canary pods: they are not Ready" },
      { id: "dns", label: "DNS: the canary hostname does not resolve" },
    ],
    correctOptionId: "order",
    explanation:
      "Envoy checks routes in order and uses the first match. A prefix `/` route placed before a header route matches every request, so the header route is never evaluated. The canary weight is irrelevant until the header route matches. Read the route table top to bottom and find the first route that matches the request.",
  },
  setup: defaults({ requestRate: 6_000, canaryWeight: 100, headerShare: 20, catchAllFirst: 1 }),
  runFor: 10,
  observe: [
    "The header route receives no traffic while the catch-all receives all 6,000 rps.",
    "Canary traffic is zero and the shortfall reaches 1,200 rps.",
    "The stable cluster is healthy and carries the full load.",
    "The event feed names the catch-all route as the first match.",
    "Moving the header route first restores the intended canary share.",
  ],
  explain:
    "A route's match and its action are separate. The header predicate describes when the route can match; the weighted cluster describes where traffic goes after it matches. If an earlier route also matches, the later route is never consulted, so neither the header predicate nor the weight has any effect. Route order is part of the routing semantics, not a formatting detail.",
  fix: defaults({ requestRate: 6_000, canaryWeight: 100, headerShare: 20, catchAllFirst: 0 }),
  debrief:
    "With the header route first, 20% of requests match it and all of that share goes to canary because the weight is 100%. The remaining 80% hits the catch-all and goes to stable. The fix is to make the specific route win the first-match check, either by moving it earlier or by narrowing the broad route's match.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Envoy route is a rule inside a virtual host. It combines a match predicate with an action. The match can inspect the path, prefix, header, query parameter, method, or gRPC service. The action can send traffic to one cluster, split it across weighted clusters, redirect it, or return a direct response. Envoy first selects a virtual host by the request's host or `:authority` header, then checks that virtual host's routes in order and uses the first one that matches. Route configuration can be inline or delivered dynamically through the route discovery service (RDS).",
  },
  {
    type: "p",
    text: "A weighted cluster is an action, not a match. It appears inside a route and assigns relative weights to two or more clusters. The weights determine the share only after that route has matched. This separation is the source of a common production bug: an operator raises the canary weight and sees no change because the canary route itself is never reached.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The route sits between the HTTP connection manager and the cluster. The listener and filter chain decide whether the connection becomes HTTP at all. The virtual host decides which route list applies. The route decides the cluster. The cluster decides the endpoint. A failure at the route layer is usually an HTTP status: 404 for no route, 503 for a missing or unhealthy cluster, or a redirect. It is not a connection refusal.",
  },
  {
    type: "table",
    headers: ["Route", "Match", "Action", "Effect"],
    rows: [
      ["Header canary", "path `/` and header `x-canary: true`", "weighted: stable 90, canary 10", "Header traffic splits 90/10"],
      ["Catch-all", "prefix `/`", "cluster: stable", "Everything else goes to stable"],
      ["Catch-all first", "prefix `/`", "cluster: stable", "Header route is shadowed"],
    ],
  },
  {
    type: "p",
    text: "Order matters because Envoy stops at the first match. A specific route should normally appear before a broad route, or the broad route should be narrowed so it cannot match the specific route's traffic. Host matching is a separate step: an exact domain, a suffix wildcard such as `*.internal`, and a prefix wildcard are evaluated when Envoy chooses the virtual host. A route that looks correct under one host may never be consulted under another.",
  },
  {
    type: "compare",
    leftTitle: "Specific route first",
    rightTitle: "Catch-all first",
    rows: [
      { label: "Header request", left: "Matches the header route and uses its weight", right: "Matches the catch-all and ignores the header route" },
      { label: "Canary traffic", left: "Equal to header share multiplied by canary weight", right: "Zero" },
      { label: "Stable traffic", left: "The remainder", right: "All of it" },
      { label: "Symptom", left: "Expected split", right: "Canary healthy but unused" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A flow from client to HTTP connection manager, header route, catch-all route, stable cluster, and canary cluster.",
      "Stable and canary request rates, each cluster's load, and the intended canary shortfall.",
      "A failure where the catch-all is first and the canary receives zero traffic.",
      "A peak case where stable is saturated because the split sends too much traffic there.",
      "An even-split preset where the weighted action sends half the traffic to each cluster.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Shadowed. Watch the header route throughput fall to zero while the catch-all receives everything. Move the header route first to recover. Then try Even split to see that weight only changes the split after a route matches.",
  },
  { type: "sim", simId: "route" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The catch-all route was earlier in the virtual host's route list. Every request matched its prefix `/` predicate, so Envoy never evaluated the header route. The canary weight stayed at 100%, but it had no effect because weight belongs to an action that only runs after a match. The canary cluster was healthy and idle while stable carried all 6,000 rps.",
  },
  {
    type: "p",
    text: "Moving the header route first restored the intended split: 20% of requests carried the header, matched the specific route, and went to canary. The remaining 80% fell through to the catch-all. The route table, not the canary deployment, was the thing that changed the outcome.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "The Envoy config dump shows the virtual host's routes in evaluation order. Read them top to bottom.",
      "`upstream_rq_total` per cluster shows where traffic actually went, independent of what the route table intended.",
      "Access logs can record the matched route, the request header, and the upstream cluster, which lets you prove which route won.",
      "A canary that is healthy but receives no requests is a routing symptom, not a canary symptom.",
      "RDS version and last-updated time tell you whether the proxy has the route table you think it has.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the first route that matches the request. Compare its match predicate and position with the route you expected to win. Only then check the weighted cluster action and the canary's health.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the virtual host's routes in order and identify the first match for a real request.",
      "Move the specific header or path route before the broad route, or narrow the broad route's match.",
      "Confirm the request actually carries the header the route expects, including case and value.",
      "Verify the weighted cluster weights and the total weight inside the matching route.",
      "Check the canary's capacity before raising its weight to 100%.",
      "Add a route-order test that sends a representative request and asserts the upstream cluster.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A specific-first order is predictable but grows into a long list that is harder to review.",
      "A broad catch-all is a useful default but silently shadows every later route that it also matches.",
      "Weighted clusters make gradual shifts easy but hide the split inside one route; dashboards must show per-cluster traffic.",
      "Header-based canaries are precise but depend on clients or gateways consistently setting the header.",
      "Runtime fraction shifting avoids editing routes for every step but adds another control plane to reason about.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "route-order",
    question:
      "A canary route exists with a header match and a 100% canary weight, but production sends all traffic to stable. How do you debug it?",
    difficulty: 2,
    hints: [
      "Match happens before action.",
      "Read the route list in order.",
    ],
    answer:
      "I would first prove whether the header route is being reached. I would read the virtual host's routes in order and find the first route that matches a real request. If a prefix `/` catch-all appears earlier, it wins and the header route is never evaluated, so its weight cannot matter. I would also confirm the request actually carries the header and that the host selects the expected virtual host. Then I would check the weighted cluster action itself. The fix is usually to move the specific route earlier or narrow the broad route, not to raise the canary weight.",
    followUps: [
      "How would you prove which route matched in production?",
      "What if the header is present but the values differ?",
      "How does host matching change the route list?",
    ],
    redFlags: [
      "Raises the canary weight first.",
      "Checks canary pods before route order.",
      "Assumes the header route is reached.",
    ],
    rubric: [
      "Separates match from action.",
      "Reads routes in order.",
      "Checks header and host.",
      "Names a route-order fix.",
    ],
  },
  {
    id: "weighted-clusters",
    question:
      "How do weighted clusters decide traffic, and what happens if the weights do not sum to 100?",
    difficulty: 2,
    hints: [
      "Weights are relative, not absolute percentages.",
      "The sum must be greater than zero.",
    ],
    answer:
      "A weighted cluster action assigns a weight to each cluster and selects one based on their relative values. The weights do not have to sum to 100; Envoy compares each cluster's weight with the sum of all weights. The sum must be greater than zero. If one weight is 10 and another is 90, the split is 10/90. If they are 1 and 9, the split is still 10/90. The weight is only consulted after the route matches, so route order remains the first thing to verify.",
    followUps: [
      "What does a zero total weight do?",
      "How would you shift traffic with runtime fractions instead?",
      "Why can a 100% canary weight still send no traffic to canary?",
    ],
    redFlags: [
      "Treats weights as absolute percentages.",
      "Forgets the route match.",
      "Assumes the total must equal 100.",
    ],
    rubric: [
      "Explains relative weights.",
      "Requires a positive sum.",
      "Separates match from action.",
      "Connects to route order.",
    ],
  },
  {
    id: "route-evidence",
    question:
      "Which evidence would you collect to prove that a request matched the wrong route, rather than that the cluster was unhealthy?",
    difficulty: 3,
    hints: [
      "One is a routing decision.",
      "The other is an upstream outcome.",
    ],
    answer:
      "I would use the config dump to read the virtual host and route order, then an access log or trace that records the matched route and upstream cluster for a representative request. I would compare per-cluster upstream request counts: if the wrong cluster received the traffic, the route matched there. If the right cluster received the traffic but returned errors, the route was correct and the cluster or endpoint was unhealthy. A 404 means no route matched; a 503 can mean a missing cluster or no healthy upstream, so the response flag matters.",
    followUps: [
      "What does a 404 tell you that a 503 does not?",
      "How would you reproduce the match locally?",
      "What if the config dump differs between proxies?",
    ],
    redFlags: [
      "Uses only application logs.",
      "Confuses 404 with 503.",
      "Ignores per-cluster traffic.",
    ],
    rubric: [
      "Uses config and request evidence.",
      "Distinguishes routing from upstream health.",
      "Reads response flags.",
      "Checks proxy consistency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The route table is reviewed in evaluation order, not as an unordered set.",
      "Specific header and path routes appear before broad catch-alls.",
      "Every weighted cluster action has a documented split and an owner.",
      "Dashboards show per-cluster request rate, errors, and latency.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the first route that matches a real request.",
      "Confirm the request carries the header or path the route expects.",
      "Compare per-cluster upstream request counts with the intended split.",
      "Check the canary's capacity before increasing its weight.",
      "Record the route table version and the time it changed.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a test that asserts the upstream cluster for a representative request.",
      "Remove or narrow catch-all routes that can shadow specific routes.",
      "Alert on canary traffic falling to zero while the canary is healthy.",
      "Document the intended order and the reason for each route.",
    ],
  },
];

const references = [
  {
    title: "Envoy route matching",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/route_matching",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Virtual host selection and first-match route evaluation.",
  },
  {
    title: "Envoy traffic shifting and splitting",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/traffic_splitting",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Weighted clusters, relative weights, and runtime traffic shifting.",
  },
  {
    title: "Envoy route configuration",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/route_specifiers",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Route match and action specifiers, including weighted cluster actions.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    route: {
      model: routeModel,
      presets,
      instructions:
        "Start Healthy, apply Shadowed, then move the header route first. Compare Even split to see the weighted action change the split without changing route order.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Cluster capacities and request rates are teaching values, not Envoy defaults or provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "mesh-envoy-listeners",
    "mesh-traffic-splitting",
    "mesh-canary",
    "mesh-access-logs",
    "mesh-policy-conflict",
  ],
};
