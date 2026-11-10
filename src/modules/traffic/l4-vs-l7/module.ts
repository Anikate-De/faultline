import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const L4_ACTIVE_CAPACITY = 250_000;
const L7_ACTIVE_CAPACITY = 180_000;
const L7_REQUEST_CAPACITY = 120_000;
const TARGET_REQUEST_CAPACITY = 90_000;
const CONNECTION_SECONDS = 30;
const BASE_LATENCY_MS = 8;
const CHAIN_HOP_MS = 3;

const params = [
  {
    id: "topology",
    label: "Path (0 NLB only, 1 ALB only, 2 NLB to ALB)",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Path",
    help: "0 forwards TCP through a Network Load Balancer. 1 sends requests to an Application Load Balancer. 2 puts an NLB in front of an ALB so both layers are present.",
    format: "count" as const,
  },
  {
    id: "connectionRate",
    label: "New connections",
    min: 500,
    max: 20_000,
    step: 500,
    value: 2_000,
    unit: " /s",
    group: "Traffic",
    help: "TCP connections opened per second. Each connection stays open for an illustrative 30 seconds.",
    format: "rps" as const,
  },
  {
    id: "requestsPerConnection",
    label: "Requests per connection",
    min: 1,
    max: 50,
    step: 1,
    value: 8,
    unit: " req",
    group: "Traffic",
    help: "HTTP requests sent on one connection. An L7 balancer can move each request; an L4 balancer keeps the whole connection on one target.",
    format: "count" as const,
  },
  {
    id: "pathRouting",
    label: "Path routing required (0 no, 1 yes)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Requirement",
    help: "1 means requests for /api and /app must reach different target groups. Only a request-aware layer can evaluate that rule.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Demand {
  topology: number;
  connectionRate: number;
  requestsPerConnection: number;
  pathRouting: boolean;
  requests: number;
  activeConnections: number;
  connectionCapacity: number;
  connectionUtil: number;
  acceptedConnections: number;
  rejectedConnections: number;
  requestsAccepted: number;
  requestUtil: number;
  routed: number;
  misrouted: number;
  served: number;
  mismatch: number;
  errorRate: number;
  targetLoad: number;
  staticIp: number;
  p99: number;
}

function demand(p: Params): Demand {
  const topology = Math.min(2, Math.max(0, Math.round(num(p, "topology", 2))));
  const connectionRate = Math.max(1, num(p, "connectionRate", 2_000));
  const requestsPerConnection = Math.max(1, num(p, "requestsPerConnection", 8));
  const pathRouting = num(p, "pathRouting", 1) >= 0.5;
  const requests = connectionRate * requestsPerConnection;
  const activeConnections = connectionRate * CONNECTION_SECONDS;
  const l7 = topology === 1 || topology === 2;
  const connectionCapacity = topology === 1 ? L7_ACTIVE_CAPACITY : L4_ACTIVE_CAPACITY;
  const connectionUtil = clamp((activeConnections / connectionCapacity) * 100, 0, 100);
  const acceptedConnections = Math.min(connectionRate, connectionCapacity / CONNECTION_SECONDS);
  const rejectedConnections = Math.max(0, connectionRate - acceptedConnections);
  const requestsAccepted = acceptedConnections * requestsPerConnection;
  const requestUtil = l7 ? clamp((requestsAccepted / L7_REQUEST_CAPACITY) * 100, 0, 100) : 0;
  const routed = Math.min(requestsAccepted, TARGET_REQUEST_CAPACITY);
  const mismatch = pathRouting && topology === 0 ? 100 : 0;
  const misrouted = routed * (mismatch / 100);
  const served = routed - misrouted;
  const errorRate = clamp(((requests - served) / Math.max(1, requests)) * 100, 0, 100);
  const targetLoad = clamp((routed / TARGET_REQUEST_CAPACITY) * 100, 0, 100);
  const staticIp = topology === 1 ? 0 : 100;
  const queueing =
    (connectionUtil > 85 ? (connectionUtil - 85) * 2 : 0) +
    (targetLoad > 85 ? (targetLoad - 85) * 3 : 0);
  const p99 = Math.min(5_000, BASE_LATENCY_MS + (topology === 2 ? CHAIN_HOP_MS : 0) + queueing);
  return {
    topology,
    connectionRate,
    requestsPerConnection,
    pathRouting,
    requests,
    activeConnections,
    connectionCapacity,
    connectionUtil,
    acceptedConnections,
    rejectedConnections,
    requestsAccepted,
    requestUtil,
    routed,
    misrouted,
    served,
    mismatch,
    errorRate,
    targetLoad,
    staticIp,
    p99,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function labelFor(topology: number): string {
  if (topology === 0) return "NLB only";
  if (topology === 1) return "ALB only";
  return "NLB to ALB";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const clientHealth: Health = d.errorRate >= 5 ? "crit" : d.errorRate >= 0.5 ? "warn" : "ok";
  const nlbHealth: Health = d.connectionUtil >= 95 ? "crit" : d.connectionUtil >= 80 ? "warn" : "ok";
  const albHealth: Health = d.mismatch > 0 ? "crit" : d.requestUtil >= 95 ? "crit" : d.requestUtil >= 80 ? "warn" : "ok";
  const targetHealth: Health = d.targetLoad >= 95 ? "crit" : d.targetLoad >= 85 ? "warn" : "ok";
  const nodes: SimFrame["nodes"] = [
    {
      id: "client",
      label: "Clients",
      kind: "client",
      health: clientHealth,
      throughput: d.requests,
      sublabel: `${formatCount(d.connectionRate)} new conns/s`,
      meta: { view: "flow" },
    },
  ];
  if (d.topology === 0 || d.topology === 2) {
    nodes.push({
      id: "nlb",
      label: "Network Load Balancer",
      kind: "lb",
      health: nlbHealth,
      utilization: clamp(d.connectionUtil / 100),
      throughput: d.requestsAccepted,
      sublabel: "Layer 4 · static IP per AZ",
      detail: `Forwards TCP flows with a flow hash. It sees addresses and ports, not HTTP paths. Active connections use an illustrative capacity of ${formatCount(L4_ACTIVE_CAPACITY)}.`,
      meta: { view: "flow" },
    });
  }
  if (d.topology === 1 || d.topology === 2) {
    nodes.push({
      id: "alb",
      label: "Application Load Balancer",
      kind: "lb",
      health: albHealth,
      utilization: clamp(d.requestUtil / 100),
      throughput: d.requestsAccepted,
      sublabel: d.pathRouting ? "Layer 7 · path rules" : "Layer 7 · request routing",
      detail: `Terminates HTTP or HTTPS and evaluates host and path rules per request. Requests use an illustrative capacity of ${formatCount(L7_REQUEST_CAPACITY)} rps.`,
      meta: { view: "flow" },
    });
  }
  nodes.push({
    id: "targets",
    label: "Target groups",
    kind: "service",
    health: targetHealth,
    utilization: clamp(d.targetLoad / 100),
    throughput: d.routed,
    sublabel: d.pathRouting ? "api and app services" : "one service pool",
    detail: `${formatCount(d.routed)} requests/s reach a target group; ${formatCount(d.misrouted)} are sent to the wrong service and count as failed requests. Illustrative target capacity is ${formatCount(TARGET_REQUEST_CAPACITY)} rps.`,
    meta: { view: "flow" },
  });
  const ingress = d.topology === 0 ? "nlb" : d.topology === 2 ? "nlb" : "alb";
  const edges = [edge("client-ingress", "client", ingress, d.requestsAccepted / Math.max(1, d.requests), clientHealth)];
  if (d.topology === 2) {
    edges.push(edge("nlb-alb", "nlb", "alb", d.requestsAccepted / Math.max(1, d.requests), albHealth));
    edges.push(edge("alb-targets", "alb", "targets", d.routed / Math.max(1, d.requestsAccepted), targetHealth));
  } else if (d.topology === 0) {
    edges.push(edge("nlb-targets", "nlb", "targets", d.routed / Math.max(1, d.requestsAccepted), targetHealth));
  } else {
    edges.push(edge("alb-targets", "alb", "targets", d.routed / Math.max(1, d.requestsAccepted), targetHealth));
  }
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("new-connections", "New connections", d.connectionRate, " /s", undefined, undefined, "rps"),
      metric("accepted-connections", "Accepted connections", d.acceptedConnections, " /s", undefined, undefined, "rps"),
      metric("rejected-connections", "Rejected connections", d.rejectedConnections, " /s", undefined, undefined, "rps"),
      metric("active-connections", "Active connections", d.activeConnections, "", undefined, undefined, "count"),
      metric("connection-utilization", "Connection table utilization", d.connectionUtil, "%", 80, 95, "percent"),
      metric("requests", "Requests", d.requests, " rps", undefined, undefined, "rps"),
      metric("routed", "Requests reaching targets", d.routed, " rps", undefined, undefined, "rps"),
      metric("misrouted", "Requests sent to wrong service", d.mismatch, "%", 0.5, 5, "percent"),
      metric("wrong-service-rps", "Wrong-service requests", d.misrouted, " /s", undefined, undefined, "rps"),
      metric("target-load", "Target group load", d.targetLoad, "%", 85, 95, "percent"),
      metric("static-ip", "Static IP coverage", d.staticIp, "%", undefined, undefined, "percent"),
      metric("error-rate", "Failed requests", d.errorRate, "%", 0.5, 5, "percent"),
      metric("p99", "End-to-end p99", d.p99, "ms", 50, 150, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      topology: d.topology,
      pathRouting: d.pathRouting ? 1 : 0,
    },
    summary: `${labelFor(d.topology)}: ${formatCount(d.requests)} req/s offered over ${formatCount(d.connectionRate)} new conns/s; ${formatCount(d.rejectedConnections)} conns/s rejected; ${formatCount(d.misrouted)} wrong-service req/s reach targets; ${d.errorRate.toFixed(0)}% failed requests.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value =
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
        Math.sin(index / 2.1) * amplitude;
      const bounded = item.format === "percent" ? Math.min(100, value) : value;
      return Math.max(0, bounded);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "misrouted",
    metricId: "misrouted",
    warn: 0.5,
    crit: 5,
    title: "The selected layer cannot evaluate the routing rule",
    cause:
      "The path requires HTTP path or host inspection, but the request is being forwarded by a Layer 4 load balancer. A TCP flow carries no parseable request line, so the balancer sends every connection to its target group. Requests are not dropped; they reach the wrong service and return the wrong app or a 404, which counts as a failed request.",
    fix:
      "Terminate HTTP at a Layer 7 load balancer. If static IPs are also required, put an NLB in front of an ALB and forward TCP from the NLB to the ALB, which evaluates the path rules.",
    checkFirst: [
      "Confirm whether the failing route is selected by host or path, not by port.",
      "Check which listener the client reaches and whether that listener is TCP or HTTP.",
      "Read the target group access logs: a request for /api arriving at the /app target group is a routing-layer problem.",
    ],
  },
  {
    id: "target-load",
    metricId: "target-load",
    crit: 95,
    warn: 85,
    title: "Target group capacity is the next limit",
    cause:
      "The selected layer accepted more requests than the target group can serve. Moving to a request-aware load balancer does not add target capacity.",
    fix:
      "Add targets or reduce request rate. Recheck per-target latency and healthy host count before adding another load balancer layer.",
    checkFirst: [
      "Compare target group request count with per-target CPU and latency.",
      "Check whether one target group receives all traffic after a rule change.",
      "Verify the target capacity assumption with a load test.",
    ],
  },
  {
    id: "connection-utilization",
    metricId: "connection-utilization",
    warn: 80,
    crit: 95,
    title: "Connection capacity is binding",
    cause:
      "New connections multiplied by connection lifetime exceeded the illustrative connection table of the selected load balancer. Long-lived connections fill the table even when request rate is modest.",
    fix:
      "Increase connection reuse, shorten idle lifetimes, or add load balancer capacity. For an L7 path, check whether the ALB connection table, not the request rate, is the limit.",
    checkFirst: [
      "Compare NewConnectionCount with ActiveConnectionCount.",
      "Check whether a client change moved to long-lived connections or WebSockets.",
      "Split by Availability Zone to find a single constrained node set.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 5,
    title: "Clients are receiving failed requests",
    cause:
      "Requests were either rejected by capacity or forwarded to a target group that could not serve the requested path. The load balancer can report success while the client receives the wrong application or an error.",
    fix:
      "Fix the routing layer first, then capacity. Confirm the selected listener sees the request fields the rule needs before tuning targets.",
    checkFirst: [
      "Separate load-balancer errors from target errors.",
      "Check whether failures correlate with one host or path.",
      "Compare the request count at the load balancer with the request count at each target group.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const l4VsL7Model: SimModel = {
  id: "traffic-l4-vs-l7",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = demand(p);
    const next = buildFrame(p, seed);
    const previousTopology = Number(frame.flags.topology ?? -1);
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
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (previousTopology >= 0 && d.topology !== previousTopology) {
      pushEvent(next, {
        id: "topology-change",
        at: frame.t,
        severity: "info",
        title: `Traffic path changed to ${labelFor(d.topology)}`,
        detail:
          d.topology === 0
            ? "Clients now reach a TCP listener. Static IPs are available, but HTTP path and host rules are not."
            : d.topology === 1
              ? "Clients now reach an HTTP listener. Path rules work, but the entry point no longer has NLB static IPs."
              : "An NLB forwards TCP to an ALB. The NLB provides static IPs; the ALB terminates HTTP and evaluates path rules.",
        nodeId: d.topology === 2 ? "alb" : d.topology === 1 ? "alb" : "nlb",
      });
    }
    if (d.mismatch > 0 && frame.flags.routingBroken !== 1) {
      pushEvent(next, {
        id: "l4-cannot-route",
        at: frame.t,
        severity: "crit",
        title: "Layer 4 path cannot satisfy a path rule",
        detail: `${formatCount(d.misrouted)} requests/s need an HTTP path decision that the TCP listener cannot make. They reach the default target group and return the wrong app or a 404, so they count as failed requests.`,
        nodeId: "targets",
        metricId: "misrouted",
      });
      next.flags.routingBroken = 1;
    } else if (d.mismatch <= 0) {
      next.flags.routingBroken = 0;
    }
    if (d.connectionUtil >= 95 && frame.flags.connectionWall !== 1) {
      pushEvent(next, {
        id: "connection-wall",
        at: frame.t,
        severity: "crit",
        title: "Connection table is nearly full",
        detail: `Active connections are at ${d.connectionUtil.toFixed(0)}% of the illustrative capacity. New connections will queue or fail before the request is parsed.`,
        nodeId: d.topology === 1 ? "alb" : "nlb",
        metricId: "connection-utilization",
      });
      next.flags.connectionWall = 1;
    } else if (d.connectionUtil < 95) {
      next.flags.connectionWall = 0;
    }
    next.flags.topology = d.topology;
    next.flags.pathRouting = d.pathRouting ? 1 : 0;
    next.summary = `${labelFor(d.topology)}: ${formatCount(d.requests)} req/s offered over ${formatCount(d.connectionRate)} new conns/s; ${formatCount(d.rejectedConnections)} conns/s rejected; ${formatCount(d.misrouted)} wrong-service req/s reach targets; ${d.errorRate.toFixed(0)}% failed requests.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `${labelFor(d.topology)} carries ${formatCount(d.requests)} req/s from ${formatCount(d.connectionRate)} new connections/s.`,
    );
    items.push(
      `The connection table is at ${d.connectionUtil.toFixed(0)}% of the illustrative ${formatCount(d.connectionCapacity)} capacity.`,
    );
    if (d.rejectedConnections > 0) {
      items.push(`${formatCount(d.rejectedConnections)} new connections/s are rejected before a request is accepted; failed-request share includes them.`);
    }
    if (d.pathRouting && d.topology === 0) {
      items.push(
        `A path rule is required, but the TCP listener cannot read the request path. ${formatCount(d.misrouted)} req/s land on the default target group and return the wrong app or a 404.`,
      );
    }
    if (d.topology === 1) {
      items.push("An ALB provides path routing but no NLB static IP per Availability Zone.");
    }
    if (d.topology === 2) {
      items.push("The NLB supplies one endpoint and static IPs per Availability Zone; the ALB still evaluates every HTTP rule.");
    }
    items.push(`Target load is ${d.targetLoad.toFixed(0)}% of the illustrative request capacity.`);
    if (d.topology === 0 && d.misrouted > 0) {
      items.push("Adding targets or raising capacity cannot fix a rule the chosen layer cannot express.");
    }
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
    label: "Healthy chain",
    description: "NLB in front of an ALB, low connection churn, path rules satisfied.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "ALB at peak",
    description: "ALB-only path at high connection churn; the connection table is near its warning line.",
    tone: "warn",
    params: defaults({ topology: 1, connectionRate: 5_000, requestsPerConnection: 12, pathRouting: 1 }),
  },
  {
    id: "failure",
    label: "L4 with path rules",
    description: "NLB-only path with a required path rule and high connection churn.",
    tone: "crit",
    params: defaults({ topology: 0, connectionRate: 8_000, requestsPerConnection: 10, pathRouting: 1 }),
  },
  {
    id: "recovery",
    label: "Layered recovery",
    description: "NLB to ALB chain with moderate load; path rules and static IPs both work.",
    tone: "ok",
    params: defaults({ topology: 2, connectionRate: 3_000, requestsPerConnection: 8, pathRouting: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-l4-path",
  title: "Predict where the path rule can run",
  simId: "l4-vs-l7",
  question:
    "A TCP listener on an NLB receives requests that must be split between /api and /app. What happens to the requests at the NLB?",
  prediction: {
    options: [
      { id: "cannot-inspect", label: "They cannot be split; the NLB sees a TCP flow, not an HTTP path." },
      { id: "path-hash", label: "The NLB reads the path and hashes it to a target." },
      { id: "tls-required", label: "Path rules work only after TLS terminates at the NLB." },
      { id: "target-decides", label: "The target group chooses the path and returns a redirect." },
    ],
    correctOptionId: "cannot-inspect",
    explanation:
      "A Network Load Balancer forwards TCP flows using a flow hash over addresses, ports, and protocol. It does not parse HTTP request lines, so it cannot choose a target group by path. An Application Load Balancer terminates HTTP and evaluates host and path conditions per request. If the design also needs NLB static IPs, the NLB forwards TCP to the ALB, and the ALB makes the routing decision.",
  },
  setup: defaults({ topology: 0, connectionRate: 6_000, requestsPerConnection: 10, pathRouting: 1 }),
  runFor: 10,
  observe: [
    "Wrong-service share is 100% and 60,000 requests/s reach the default target group.",
    "The NLB node is healthy; the connection table is below its warning line.",
    "Static IP coverage is 100%, which is exactly what the L4 path provides.",
    "The target group is healthy at 66.7% load, but it is serving the wrong application.",
  ],
  explain:
    "The NLB is doing its job. It accepts TCP connections, picks a target by flow hash, and forwards bytes. The failure is at the routing layer: a path rule needs a request-aware proxy. The 100% wrong-service share is a property of the selected layer, not of target health or capacity.",
  fix: defaults({ topology: 2, connectionRate: 6_000, requestsPerConnection: 10, pathRouting: 1 }),
  debrief:
    "The chain keeps the NLB static IPs and adds an ALB for HTTP routing. Per-connection and per-request counters now show work happening at both layers. The tradeoff is an extra hop and another component to monitor; the ALB still owns TLS termination and path rules.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Layer 4 load balancer forwards TCP or UDP connections. A Network Load Balancer (NLB) is the AWS Layer 4 service. It selects a target with a flow hash over protocol, addresses, ports, and TCP sequence information, then keeps that connection on the target for its lifetime. It sees connections, not requests. That is why it can offer static IP addresses per Availability Zone, preserve the client source address, and scale to millions of requests per second.",
  },
  {
    type: "p",
    text: "A Layer 7 load balancer forwards HTTP requests. An Application Load Balancer (ALB) is the AWS Layer 7 service. It terminates HTTP or HTTPS, parses the request, evaluates listener rules in priority order, and chooses a target group. Host and path rules, redirects, fixed responses, and per-request balancing require that view. TLS termination is a separate choice: an NLB TLS listener can terminate TLS, or a TCP listener can pass encrypted bytes through to the ALB, which terminates TLS and routes.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The common layered path is client, NLB, ALB, target group. The NLB owns the stable entry point and static addresses. The ALB owns HTTP parsing and path rules. A single ALB has no NLB static IPs; a single NLB has no HTTP path rules. The chain is not free: it adds a hop, another health-check surface, and two sets of metrics, but it is the usual answer when both requirements are real.",
  },
  {
    type: "compare",
    leftTitle: "L4: NLB only",
    rightTitle: "L7: ALB only",
    rows: [
      { label: "Unit of routing", left: "TCP or UDP flow", right: "HTTP request" },
      { label: "Static IPs", left: "One static IP per Availability Zone", right: "DNS name; addresses can change" },
      { label: "Path and host rules", left: "Not available", right: "Host, path, header, method, query, source IP" },
      { label: "TLS", left: "TLS listener or TCP passthrough", right: "Terminates HTTP or HTTPS" },
      { label: "Good fit", left: "Non-HTTP protocols, extreme connection volume, address preservation", right: "HTTP services, multi-service routing, per-request balancing" },
    ],
  },
  {
    type: "p",
    text: "The production question usually contains two requirements, not one. Static IPs and path routing are not competing answers; they are different layers. Put the NLB where the addresses must be stable and the ALB where the HTTP decision must happen. If only one requirement exists, a single layer is cheaper and simpler.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "New-connection and active-connection counters for the selected layer.",
      "Request rate, connection-table utilization, and target group load.",
      "Requests sent to the wrong service when the layer cannot express a path rule.",
      "Static IP coverage, end-to-end p99, and a node for each layer in the path.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with the healthy chain. Switch the path to NLB only while path routing is required and watch wrong-service requests jump to 100%. Restore the chain, then switch to ALB only and watch static IP coverage fall to zero. The point is not that one layer is better; each layer answers a different question.",
  },
  {
    type: "table",
    headers: ["Requirement", "Layer that satisfies it", "What it costs"],
    rows: [
      ["Static IP per Availability Zone", "NLB", "Another component and a hop if an ALB is also needed" ],
      ["HTTP path or host routing", "ALB", "TLS termination at the ALB, or HTTP after an NLB TLS listener" ],
      ["Extreme connection volume", "NLB", "No per-request visibility; targets see whole flows" ],
      ["Per-request balancing and redirects", "ALB", "Request parsing and rule evaluation; no NLB static addresses" ],
    ],
  },
  { type: "sim", simId: "l4-vs-l7" },
  { type: "experiment", experimentId: "predict-l4-path" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With an NLB only and a required path rule, every request that needed /api versus /app was sent to the default target group. The NLB was forwarding connections correctly; the design was asking it to make a decision it cannot see. Those requests reached a target but returned the wrong app or a 404, so they counted as failed. Turning on the NLB-to-ALB chain moved the HTTP decision to the ALB while the NLB kept the static address.",
  },
  {
    type: "p",
    text: "Switching to ALB only restored path routing but dropped static IP coverage to zero. That is the tradeoff in the other direction. The model does not rank the layers; it shows which requirement each one satisfies and what the other requirement costs.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "NLB: `ActiveFlowCount`, `NewFlowCount`, `ProcessedBytes`, `ConsumedLCUs`, and per-Availability-Zone health. A healthy NLB says nothing about HTTP path correctness.",
      "ALB: `RequestCount`, `HTTPCode_ELB_5XX_Count`, `HTTPCode_Target_5XX_Count`, `TargetResponseTime`, `RuleEvaluations`, and `RejectedConnectionCount`.",
      "Access logs: the request path, the chosen target group, and the response code. A path landing on the wrong target group is visible here even when both layers report healthy.",
      "Client behavior: DNS caching, connection reuse, and whether clients honor the load balancer's address changes.",
      "TLS: `ClientTLSNegotiationErrorCount` on the ALB, and target TLS errors when the ALB connects to HTTPS targets.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the listener protocol and the rule that should have matched before you touch target capacity. If the listener is TCP, no path rule exists at that layer. If the listener is HTTP, confirm the host and path conditions and the rule priority. Then compare the request count at the ALB with the request count at each target group.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the requirement: static addresses, HTTP path rules, protocol, TLS termination point, and connection lifetime.",
      "If both static addresses and HTTP routing are required, put an NLB in front of an ALB and use a TCP listener from the NLB to the ALB.",
      "Register the ALB as the NLB target, one ALB per target group, and keep TLS termination and path rules on the ALB.",
      "If only one requirement exists, remove the extra layer and its hop, cost, and health-check surface.",
      "Verify the selected listener sees the fields the rule needs, then check rule priority and target group attachment.",
      "Load-test the chain at peak connection churn and request rate; watch both layers, not only the targets.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "The chain adds a hop and a second failure domain. An NLB or ALB incident can take the path down even when targets are healthy.",
      "NLB static IPs are per Availability Zone; clients that cache DNS can still send traffic to a removed address.",
      "TLS can terminate at the NLB or the ALB, but not both without a deliberate re-encryption design. Terminating at the ALB keeps end-to-end encryption to the application.",
      "NLB flow hashing keeps a connection on one target; long-lived connections can produce uneven target load even when request counts look balanced.",
      "ALB path rules are cheap and centralized, but they add a shared routing dependency and a rule limit to manage.",
      "The correct design is the smallest chain that satisfies the requirements, not the largest chain the team can operate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-static-and-path",
    question:
      "You need static IP addresses and HTTP path routing for the same service. Design the path and name the tradeoffs.",
    difficulty: 2,
    hints: [
      "One layer owns addresses; another owns HTTP parsing.",
      "An ALB can be a target of an NLB.",
    ],
    answer:
      "I would put an NLB at the edge with a TCP listener and one static IP per Availability Zone, then register an ALB as the NLB target in its own target group. The ALB terminates TLS, evaluates host and path rules, and forwards to the service target groups. I would keep one ALB per NLB target group and confirm the NLB health check matches the ALB listener. The tradeoffs are an extra hop, two components to monitor, NLB cross-zone behavior, and the fact that the ALB still has its own connection and request limits. If TLS must terminate at the NLB, the ALB receives HTTP and the design loses end-to-end encryption unless the NLB re-encrypts to the ALB.",
    followUps: [
      "Where does the client IP reach the application?",
      "What happens when the ALB target fails its NLB health check?",
      "How would you prove the path rule is evaluated at the ALB and not the NLB?",
    ],
    redFlags: [
      "Says the NLB can evaluate path rules.",
      "Puts multiple ALBs in one NLB target group.",
      "Terminates TLS twice without explaining certificates or re-encryption.",
    ],
    rubric: [
      "Places static IPs on the NLB and path rules on the ALB.",
      "Names the extra hop and second failure domain.",
      "Keeps TLS termination and certificate ownership explicit.",
      "States how the client IP is preserved.",
    ],
  },
  {
    id: "when-l4-only",
    question:
      "When is an NLB-only design better than adding an ALB, even if the team already knows ALB?",
    difficulty: 2,
    hints: [
      "Not every workload is HTTP.",
      "Consider connection volume and address preservation.",
    ],
    answer:
      "NLB-only is better when the protocol is TCP or UDP, when the application needs the client source address or static addresses, when connection volume is extreme, or when TLS must pass through to the target. It is also the simpler choice when there is no host or path rule to evaluate. Adding an ALB would terminate HTTP, add a hop, and create a second component to operate without buying a routing capability the workload needs. The decision should follow the protocol and the routing requirement, not a preference for one service.",
    followUps: [
      "What health check types would you use on the NLB target group?",
      "How does client IP preservation change the target group configuration?",
      "When would you add an ALB later?",
    ],
    redFlags: [
      "Chooses ALB by default for a non-HTTP protocol.",
      "Adds a layer without naming a requirement it satisfies.",
      "Ignores connection lifetime and target distribution.",
    ],
    rubric: [
      "Names protocol and routing requirements.",
      "Explains static IP and source-address value.",
      "States the cost of the extra layer.",
      "Keeps the design as small as the requirement allows.",
    ],
  },
  {
    id: "tls-placement",
    question:
      "Where should TLS terminate in an NLB-to-ALB chain, and what changes for certificates, client IP, and debugging?",
    difficulty: 3,
    hints: [
      "TLS at the ALB keeps HTTP parsing and certificate ownership together.",
      "A TCP listener passes encrypted bytes through.",
    ],
    answer:
      "I would terminate TLS at the ALB by giving the NLB a TCP listener and letting the ALB present the certificate. That keeps certificate selection and SNI on the ALB, preserves end-to-end encryption from the client to the ALB, and lets the ALB evaluate HTTP rules after decryption. The ALB appends the client IP to X-Forwarded-For. If the NLB terminates TLS instead, the ALB receives HTTP, certificate ownership moves to the NLB, and the link from NLB to ALB must be secured separately if the application needs encryption in transit. Debugging also shifts: TLS errors show up at the NLB, while rule and target errors stay at the ALB.",
    followUps: [
      "How does SNI affect certificate selection at the ALB?",
      "What does the target see as the source address?",
      "How do you prove where a TLS handshake failed?",
    ],
    redFlags: [
      "Terminates TLS at both layers casually.",
      "Forgets certificate ownership after moving termination.",
      "Assumes the target sees the original client IP without a forwarding mechanism.",
    ],
    rubric: [
      "Chooses a termination point deliberately.",
      "Explains certificate and SNI ownership.",
      "Names X-Forwarded-For or proxy protocol as appropriate.",
      "Separates NLB TLS errors from ALB HTTP errors.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The design records which layer owns static addresses, TLS termination, and HTTP routing.",
      "Dashboards show NLB flow metrics and ALB request, error, and latency metrics together.",
      "The NLB target group health check matches the ALB listener port and protocol.",
      "Clients honor DNS TTLs and reuse connections deliberately.",
      "A load test covers peak connection churn, not only peak request rate.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm which listener the client reaches and whether it is TCP or HTTP.",
      "Check wrong-service requests before changing target capacity.",
      "Check connection-table utilization and active connections at both layers.",
      "Verify TLS termination point and certificate errors separately from HTTP errors.",
      "Record the path change and the time it was applied.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run the path test with both requirements enabled.",
      "Compare NLB and ALB request counters to confirm the chain is carrying the expected traffic.",
      "Review whether the extra layer is still justified by a real requirement.",
      "Add a synthetic check for a path that must reach a non-default target group.",
    ],
  },
];

const references = [
  {
    title: "Elastic Load Balancing features",
    url: "https://aws.amazon.com/elasticloadbalancing/features/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Layer 4 and Layer 7 comparison, static IPs, long-lived TCP, TLS offload, and routing features.",
  },
  {
    title: "Listeners for your Network Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "TCP and TLS listeners, TLS termination versus passthrough, and flow behavior.",
  },
  {
    title: "What is an Application Load Balancer?",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/introduction.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Request-level routing, listener rules, target groups, and health checks.",
  },
  {
    title: "Load balancing proxy status",
    url: "https://developers.cloudflare.com/load-balancing/understand-basics/proxy-modes/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "A Cloudflare comparison of Layer 4, Layer 7, and DNS-only load balancing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "l4-vs-l7": {
      model: l4VsL7Model,
      presets,
      instructions:
        "Start with the healthy chain. Switch to NLB only while path routing is required, then restore the chain. Switch to ALB only and compare static IP coverage. Read the node detail to see which layer owns the decision.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Connection capacities, request capacities, response sizes, and latency values are teaching figures, not AWS limits or guarantees. AWS documents NLB static IPs, flow hashing, ALB request routing, and TLS termination behavior; it does not publish the per-layer capacities used here.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-alb-target-groups", "traffic-alb-connection-limit", "traffic-grpc-lb"],
};
