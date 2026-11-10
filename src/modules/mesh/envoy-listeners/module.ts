import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CAPACITY = 10_000;
const BASE_LATENCY = 2;
const MAX_RATE = 20_000;

const params = [
  {
    id: "requestRate",
    label: "Requests reaching the proxy",
    min: 100,
    max: MAX_RATE,
    step: 100,
    value: 4_000,
    unit: " rps",
    group: "Traffic",
    help: "Connections per second arriving at the address the client dialed. The service behind the listener has an illustrative capacity of 10,000 rps.",
    format: "rps" as const,
  },
  {
    id: "clientPort",
    label: "Port the client dials",
    min: 8_000,
    max: 9_100,
    step: 1,
    value: 8_080,
    unit: "",
    group: "Client",
    help: "Destination port in the client's connection. A listener must be bound to this exact port and address.",
    format: "count" as const,
  },
  {
    id: "listenerPort",
    label: "Port the listener binds",
    min: 8_000,
    max: 9_100,
    step: 1,
    value: 8_080,
    unit: "",
    group: "Proxy",
    help: "Address and port in the Envoy listener configuration. The demo uses one listener and one filter chain for clarity.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  clientPort: number;
  listenerPort: number;
  accepted: boolean;
  delivered: number;
  overload: number;
  successRate: number;
  failureRate: number;
  utilization: number;
  p99: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(100, Math.round(num(p, "requestRate", 4_000)));
  const clientPort = Math.round(clamp(num(p, "clientPort", 8_080), 8_000, 9_100));
  const listenerPort = Math.round(clamp(num(p, "listenerPort", 8_080), 8_000, 9_100));
  const accepted = clientPort === listenerPort;
  const delivered = accepted ? Math.min(requestRate, CAPACITY) : 0;
  const overload = accepted ? Math.max(0, requestRate - CAPACITY) : 0;
  const successRate = (delivered / requestRate) * 100;
  const failureRate = 100 - successRate;
  const utilization = accepted ? (requestRate / CAPACITY) * 100 : 0;
  const ratio = requestRate / CAPACITY;
  const p99 = accepted ? BASE_LATENCY + 320 * ratio ** 6 : 0;
  return {
    requestRate,
    clientPort,
    listenerPort,
    accepted,
    delivered,
    overload,
    successRate,
    failureRate,
    utilization,
    p99,
  };
}

function healthForErrors(value: number): SimState {
  if (value >= 5) return "crit";
  if (value >= 0.5) return "warn";
  return "ok";
}

function healthForUtil(value: number): SimState {
  if (value >= 95) return "crit";
  if (value >= 80) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const requestHealth = healthForErrors(c.failureRate);
  const listenerHealth: SimState = c.accepted ? healthForUtil(c.utilization) : "down";
  const layerHealth: SimState = c.accepted ? "ok" : "down";
  const serviceHealth: SimState = c.accepted ? (c.overload > 0 ? "warn" : "ok") : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client",
        kind: "client",
        health: requestHealth,
        throughput: c.requestRate,
        sublabel: `dials :${c.clientPort}`,
        detail: `The client opens a TCP connection to the address and port in its target. DNS may resolve, but the port still has to be bound by a listener.`,
        meta: { view: "flow" },
      },
      {
        id: "listener",
        label: `Listener :${c.listenerPort}`,
        kind: "mesh",
        health: listenerHealth,
        utilization: c.accepted ? clamp(c.requestRate / CAPACITY) : 0,
        throughput: c.accepted ? c.requestRate : 0,
        sublabel: c.accepted ? `${c.requestRate.toLocaleString()} rps accepted` : `no socket on :${c.clientPort}`,
        detail: c.accepted
          ? "The listener owns this address and port. It selects a filter chain for each accepted connection."
          : `Envoy is configured on :${c.listenerPort}, but the client dialed :${c.clientPort}. The connection is refused before any HTTP filter runs.`,
        meta: { view: "flow" },
      },
      {
        id: "filter-chain",
        label: "Filter chain",
        kind: "mesh",
        health: layerHealth,
        throughput: c.accepted ? c.requestRate : 0,
        sublabel: c.accepted ? "match: destination port" : "never selected",
        detail: c.accepted
          ? "Filter chain match criteria selected this chain. In a mesh, criteria such as destination port, SNI, and ALPN decide which chain handles the connection."
          : "No connection reached the listener, so no filter chain match was evaluated.",
        meta: { view: "flow" },
      },
      {
        id: "hcm",
        label: "HTTP connection manager",
        kind: "mesh",
        health: c.accepted ? (c.overload > 0 ? "warn" : "ok") : "down",
        throughput: c.accepted ? c.requestRate : 0,
        sublabel: c.accepted ? "HTTP/1.1 and HTTP/2" : "never reached",
        detail: c.accepted
          ? "The HTTP connection manager parses requests and asks the route table where each one should go."
          : "The HTTP connection manager is a network filter inside a filter chain. It is not consulted until a listener and chain accept the connection.",
        meta: { view: "flow" },
      },
      {
        id: "route",
        label: "Route /checkout",
        kind: "mesh",
        health: c.accepted ? "ok" : "down",
        throughput: c.delivered,
        sublabel: c.accepted ? "prefix match" : "no request",
        detail: c.accepted
          ? "The virtual host and route matched. A route miss here would produce a local 404, not a connection refusal."
          : "A route is only evaluated after the HTTP connection manager parses a request.",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: serviceHealth,
        utilization: c.accepted ? clamp(c.requestRate / CAPACITY) : 0,
        throughput: c.delivered,
        sublabel: c.accepted ? `${c.delivered.toLocaleString()} rps delivered` : "idle and healthy",
        detail: c.accepted
          ? `The listener delivered ${c.delivered.toLocaleString()} rps. The remaining ${c.overload.toLocaleString()} rps is rejected above the illustrative 10,000 rps capacity.`
          : "The service is running. It receives no traffic because the connection never entered Envoy.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-listener", "client", "listener", c.accepted ? c.requestRate / MAX_RATE : 0, c.accepted ? listenerHealth : "down"),
      edge("listener-chain", "listener", "filter-chain", c.accepted ? c.requestRate / MAX_RATE : 0, c.accepted ? "ok" : "down"),
      edge("chain-hcm", "filter-chain", "hcm", c.accepted ? c.requestRate / MAX_RATE : 0, c.accepted ? "ok" : "down"),
      edge("hcm-route", "hcm", "route", c.delivered / MAX_RATE, c.accepted ? "ok" : "down"),
      edge("route-service", "route", "service", c.delivered / MAX_RATE, c.accepted ? serviceHealth : "down"),
    ],
    metrics: [
      metric("success-rate", "Delivered requests", c.successRate, "%", undefined, undefined, "percent"),
      metric("failure-rate", "Connection and request failures", c.failureRate, "%", 0.5, 5, "percent"),
      metric("listener-util", "Listener load", c.utilization, "%", 80, 95, "percent"),
      metric("p99", "Service p99", c.p99, "ms", 150, 500, "ms"),
      metric("delivered-rps", "Delivered traffic", c.delivered, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.accepted
      ? `Port :${c.clientPort} accepted; ${c.successRate.toFixed(1)}% delivered; listener at ${Math.round(c.utilization)}% of illustrative capacity.`
      : `No listener on :${c.clientPort}; Envoy listens on :${c.listenerPort}; ${c.requestRate.toLocaleString()} rps refused.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failure-rate",
    metricId: "failure-rate",
    warn: 0.5,
    crit: 5,
    title: "Requests are failing before the service sees them",
    cause:
      "The client destination port does not match a bound listener, or the listener is overloaded. A port mismatch fails at TCP connect; an overloaded service fails after the proxy accepts the request.",
    fix:
      "Compare the client's destination port with the listener's bind port first. If they match, check filter chain match criteria and service capacity.",
    checkFirst: [
      "Compare the dialed port with the listener address and port in the proxy config.",
      "Confirm the listener is active and not draining.",
      "Check whether the failure is a connection refusal or an HTTP response.",
    ],
  },
  {
    id: "listener-util",
    metricId: "listener-util",
    warn: 80,
    crit: 95,
    title: "The listener is near its teaching capacity",
    cause:
      "Accepted traffic is close to the illustrative 10,000 rps capacity used in this demo. A listener can accept connections faster than the service behind it can answer.",
    fix:
      "Reduce offered load, add service capacity, or shed non-critical traffic. Adding another listener on the same port is not possible; the capacity is behind the listener.",
    checkFirst: [
      "Compare request rate with service capacity and concurrency.",
      "Check upstream pending requests and latency, not only listener counters.",
      "Confirm whether a load test or retry policy raised the rate.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 150,
    crit: 500,
    title: "Service latency is rising with accepted load",
    cause:
      "The listener accepted the requests, but the service is queueing. In this model latency grows steeply as load approaches capacity, which is why accepted traffic can still fail.",
    fix:
      "Find the saturated resource behind the listener. Add capacity or reduce load; changing the listener port will not help once requests are being accepted.",
    checkFirst: [
      "Check service latency and queue depth rather than listener connection counts.",
      "Check whether the listener is accepting more than the service can process.",
      "Check for retries from an outer proxy multiplying the accepted rate.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const listenerModel: SimModel = {
  id: "mesh-envoy-listeners",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const computed = compute(p);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    const jittered = { ...computed, p99: computed.p99 > 0 ? Math.max(0, computed.p99 * (1 + rng.between(-0.02, 0.02))) : 0 };
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: jittered.p99 } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (!computed.accepted && frame.flags.noListenerSeen !== 1) {
      pushEvent(next, {
        id: "listener-port-mismatch",
        at: frame.t,
        severity: "crit",
        title: "No listener on the dialed port",
        detail: `The client dialed :${computed.clientPort}; Envoy listens on :${computed.listenerPort}. The TCP connection is refused before HTTP filters or routes are evaluated.`,
        nodeId: "listener",
        metricId: "failure-rate",
      });
      next.flags.noListenerSeen = 1;
    }
    if (computed.accepted && computed.overload > 0 && frame.flags.overloadSeen !== 1) {
      pushEvent(next, {
        id: "listener-capacity",
        at: frame.t,
        severity: "warn",
        title: "Accepted traffic exceeds service capacity",
        detail: `${computed.requestRate.toLocaleString()} rps reached the listener against ${CAPACITY.toLocaleString()} rps of illustrative service capacity. The listener is not the bottleneck; the service behind it is.`,
        nodeId: "service",
        metricId: "listener-util",
      });
      next.flags.overloadSeen = 1;
    }
    if (computed.accepted && computed.failureRate < 0.5 && frame.flags.noListenerSeen === 1 && frame.flags.recoveredSeen !== 1) {
      pushEvent(next, {
        id: "listener-recovered",
        at: frame.t,
        severity: "info",
        title: "Listener path recovered",
        detail: `The client now dials :${computed.clientPort}, which matches the listener. Requests are reaching the HTTP connection manager and route table again.`,
        nodeId: "listener",
      });
      next.flags.recoveredSeen = 1;
    }
    next.summary = computed.accepted
      ? `Port :${computed.clientPort} accepted; ${computed.successRate.toFixed(1)}% delivered; listener at ${Math.round(computed.utilization)}% of illustrative capacity.`
      : `No listener on :${computed.clientPort}; Envoy listens on :${computed.listenerPort}; ${computed.requestRate.toLocaleString()} rps refused.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    if (!c.accepted) {
      items.push(`The client dials :${c.clientPort} but the listener binds :${c.listenerPort}. This fails at TCP connect, before the HTTP connection manager or route table runs.`);
      items.push("A listener mismatch is not an HTTP 404 or 503. There is no access log line because the connection never reaches an HTTP filter.");
    } else {
      items.push(`The listener on :${c.listenerPort} accepted ${c.requestRate.toLocaleString()} rps and delivered ${c.delivered.toLocaleString()} rps to the service.`);
      items.push(`Listener load is ${Math.round(c.utilization)}% of the illustrative 10,000 rps service capacity; p99 is ${Math.round(c.p99)}ms.`);
    }
    items.push("A listener selects a filter chain by match criteria such as destination port, SNI, and ALPN. If the listener accepts but no chain matches, the connection closes without HTTP processing.");
    items.push("The HTTP connection manager owns the route table. A route miss produces a local 404 and is an HTTP-layer failure, not a listener failure.");
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
    description: "Client and listener agree on :8080, with 4,000 rps against 10,000 rps of illustrative service capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "9,000 rps reaches the correct listener. The service is saturated, but the connection path is intact.",
    tone: "warn",
    params: defaults({ requestRate: 9_000 }),
  },
  {
    id: "failure",
    label: "Wrong port",
    description: "The client dials :9090 while Envoy listens on :8080. The connection is refused before any HTTP filter.",
    tone: "crit",
    params: defaults({ requestRate: 4_000, clientPort: 9_090, listenerPort: 8_080 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The client is corrected to :8080. The listener accepts, the route matches, and traffic reaches the service.",
    tone: "ok",
    params: defaults({ requestRate: 4_000, clientPort: 8_080, listenerPort: 8_080 }),
  },
];

const experiment: Experiment = {
  id: "listener-wrong-port",
  title: "Find the layer that refuses the connection",
  simId: "listener",
  question:
    "The client dials :9090. Envoy has a listener on :8080 with a matching route. Where does the request stop?",
  prediction: {
    options: [
      { id: "tcp", label: "At TCP connect: no socket is listening on :9090, so the connection is refused" },
      { id: "hcm", label: "At the HTTP connection manager, which returns 404 because the route is missing" },
      { id: "route", label: "At the route table, which sends the request to the stable cluster" },
      { id: "service", label: "At the checkout service, which returns 503 because it is not ready" },
    ],
    correctOptionId: "tcp",
    explanation:
      "A listener owns an address and port. If nothing is bound to the dialed port, the kernel refuses the connection. The HTTP connection manager, route table, and service are never reached, so no HTTP status code and no Envoy access log line are produced for that request.",
  },
  setup: defaults({ requestRate: 4_000, clientPort: 9_090, listenerPort: 8_080 }),
  runFor: 5,
  observe: [
    "Delivered requests fall to zero and the failure metric reaches 100%.",
    "The listener shows no accepted traffic because the client is dialing a different port.",
    "The listener, filter chain, HTTP connection manager, and route nodes all report unavailable on the request path.",
    "The service stays healthy but receives no traffic.",
    "The event feed names the dialed port and the port Envoy actually binds.",
  ],
  explain:
    "The listener is the first Envoy object in the path. It binds an address and port, accepts TCP connections, and selects a filter chain. A request to an unbound port fails before any network filter runs, so changing routes, clusters, or the service cannot fix it. The fix belongs in the client target, the service port, or the listener bind configuration, not in the route table.",
  fix: defaults({ requestRate: 4_000, clientPort: 8_080, listenerPort: 8_080 }),
  debrief:
    "With both ports at :8080, the listener accepts, the filter chain is selected, the HTTP connection manager parses the request, the route matches, and the service receives traffic. The healthy and peak presets show the same path with different service load. Listener health and HTTP success are separate signals; use both before changing any config.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Envoy listener is a named network location that binds an address and port and accepts TCP or UDP traffic. A TCP listener owns a set of filter chains. Each chain has match criteria such as destination port, server name indication (SNI), application protocol negotiation (ALPN), and source address. When a connection arrives, Envoy selects one matching chain and instantiates its network filters. The HTTP connection manager (HCM) is the filter that parses HTTP and consults the route table. Listener filters, such as the TLS inspector, run before the chain's network filters and can add metadata that affects the match.",
  },
  {
    type: "p",
    text: "A listener is not a route and not a cluster. It is the entry point that makes HTTP processing possible. In a sidecar mesh, a workload's inbound traffic and outbound traffic usually arrive at different listeners, and transparent redirection decides which one sees a given connection. If the listener or filter chain does not match, the request never becomes an HTTP request that Envoy can route.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, kernel socket, listener, filter chain, HTTP connection manager, virtual host and route, cluster, endpoint, service. A failure at each layer looks different. No listener means a refused connection. A listener with no matching filter chain means the connection closes after accept. An HCM with no matching route returns a local 404. A route that names a missing cluster returns 503. A cluster with no healthy endpoint returns 503 with an upstream failure flag.",
  },
  {
    type: "table",
    headers: ["Layer", "Chooses on", "What a failure looks like"],
    rows: [
      ["Listener", "Bind address and port", "Connection refused; no access log"],
      ["Filter chain", "Destination port, SNI, ALPN, source", "Connection accepted, then closed before HTTP"],
      ["HTTP connection manager", "HTTP protocol and route config", "Protocol error or local response"],
      ["Route", "Host, path, header, method", "Local 404 or an unexpected cluster"],
      ["Cluster and endpoint", "Cluster name and endpoint health", "503, timeout, or upstream failure flag"],
    ],
  },
  {
    type: "p",
    text: "In a mesh, the inbound and outbound listeners are often created by the control plane rather than written by hand. That makes the listener configuration easy to forget: the sidecar may be running, the pod may be ready, and the route may be correct while the client dials a port that no listener owns. The first comparison in an incident is therefore the client's destination port against the listener's bound port, then the filter chain match, then the route.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A flow from client to listener, filter chain, HTTP connection manager, route, and service.",
      "Delivered requests, failures, listener load, and service p99 against illustrative thresholds.",
      "A port mismatch that stops the chain at the listener and leaves the service idle and healthy.",
      "A peak preset where the listener accepts correctly but the service is saturated.",
      "Events that name the dialed port and the listener's actual port.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Wrong port. Watch the listener, filter chain, HCM, and route all become unavailable while the service stays healthy. Move the client port back to the listener port to recover. Then apply Peak to see accepted traffic fail on service capacity rather than on the listener.",
  },
  {
    type: "compare",
    leftTitle: "Below HTTP",
    rightTitle: "At or above HTTP",
    rows: [
      { label: "Typical evidence", left: "Connection refused or closed; no access log", right: "HTTP status, response flag, access log line" },
      { label: "First check", left: "Bound port and filter chain match", right: "Virtual host, route, cluster, endpoint" },
      { label: "Wrong fix", left: "Editing routes", right: "Adding another listener" },
      { label: "User symptom", left: "Connection reset or timeout", right: "404, 503, or slow response" },
    ],
  },
  { type: "sim", simId: "listener" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The client dialed :9090 while Envoy bound :8080. The kernel refused the connection because no socket owned that port. Envoy never selected a filter chain, never created an HTTP stream, and never evaluated the route. The service remained healthy and idle. That is why the failure metric reached 100% while the service showed no errors of its own.",
  },
  {
    type: "p",
    text: "In the peak preset the listener accepted 9,000 rps against an illustrative 10,000 rps service capacity. The listener was not the bottleneck; the service queue was. The two failures have different fixes and different evidence. A port mismatch is a configuration error below HTTP. A saturated service is a capacity problem above HTTP.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "`ss -ltnp` or the Envoy config dump shows which address and port each listener actually binds.",
      "`config_dump` shows the listener's `filter_chains` and their `filter_chain_match` criteria.",
      "Listener counters such as `downstream_cx_total` stay flat for the expected listener when traffic is going to the wrong port.",
      "A request refused at TCP connect produces no Envoy access log line. A request that reaches HTTP produces a status code and response flags such as `NR` for no route.",
      "In a sidecar, check the redirection rules and the workload's declared container port against the inbound listener.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the client's destination port with the listener's bind port and address. Then compare the filter chain match criteria. Only after the connection reaches the HTTP connection manager should you inspect routes and clusters.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the client target port and the listener bind port are the same, including the bind address.",
      "If the listener accepts but the connection closes, inspect filter chain match criteria and the TLS inspector.",
      "If HTTP is reached, check the virtual host domain and route order before changing the cluster.",
      "Test from the same network namespace as the client; a local curl may use a different port or proxy setting.",
      "Record the intended port in the service definition and in the mesh config so the next change cannot drift silently.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A single broad listener is simpler to operate but concentrates all protocols and ports behind one filter chain set.",
      "Per-port listeners make mismatches obvious but multiply configuration and firewall rules.",
      "Original destination listeners preserve the client's target but depend on correct redirection and can surprise route authors.",
      "TLS inspector metadata enables SNI-based chain selection but adds a listener filter that must parse the ClientHello.",
      "A local 404 is cheaper than proxying to a wrong cluster, but it hides a route bug from upstream latency and error metrics.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "trace-entry",
    question:
      "A request never reaches the service. Walk me through the Envoy layers you would check, in order, and what evidence would stop you at each one.",
    difficulty: 2,
    hints: [
      "Start below HTTP.",
      "Each layer has a different failure signature.",
    ],
    answer:
      "I would start with the listener: does a listener bind the address and port the client dialed? If not, the connection is refused and there is no access log. If it binds, I would check the filter chain match: destination port, SNI, ALPN, and source. A chain miss accepts the TCP connection and then closes it without HTTP processing. If a chain matches, the HTTP connection manager parses the request; a protocol error appears here. Then I would check the virtual host and route order for a 404 or the wrong cluster, and finally the cluster's endpoint health for a 503. The evidence at each layer tells me whether to keep going up or fix the current layer.",
    followUps: [
      "Which layer produces a local 404?",
      "What does a connection refused tell you that a 503 does not?",
      "How would a sidecar's inbound listener change your check?",
    ],
    redFlags: [
      "Starts by editing routes for a connection refusal.",
      "Treats every failure as an application error.",
      "Ignores the destination port.",
    ],
    rubric: [
      "Orders the layers correctly.",
      "Distinguishes TCP from HTTP evidence.",
      "Names listener and filter chain checks.",
      "Ends at cluster health.",
    ],
  },
  {
    id: "filter-chain",
    question:
      "The listener is bound and accepts the TCP connection, but the client sees the connection close immediately. What could be wrong, and which Envoy object decides?",
    difficulty: 3,
    hints: [
      "Acceptance and filter chain selection are separate steps.",
      "Think about SNI, ALPN, and destination port.",
    ],
    answer:
      "Acceptance only means the listener owns the port. Envoy then selects one filter chain by its match criteria: destination port, destination IP, source address, server names from SNI, or ALPN protocols. If no chain matches, the connection is closed without instantiating the HTTP connection manager. I would inspect the listener's filter chains and compare their match criteria with the actual connection. A common cause is a chain that matches a TLS SNI or ALPN the client is not sending, or a destination port that differs after redirection.",
    followUps: [
      "How does the TLS inspector affect the match?",
      "What happens if two filter chains match?",
      "How would you test the match without changing production?",
    ],
    redFlags: [
      "Assumes the listener is down because the connection closed.",
      "Changes the route table.",
      "Ignores TLS metadata.",
    ],
    rubric: [
      "Separates accept from chain selection.",
      "Names match criteria.",
      "Explains the closed connection.",
      "Proposes a config dump check.",
    ],
  },
  {
    id: "listener-vs-capacity",
    question:
      "The listener shows high accepted connection counts, but users see 503s. Is the listener the problem? How do you decide?",
    difficulty: 2,
    hints: [
      "Accepted is not delivered.",
      "Look behind the listener.",
    ],
    answer:
      "High accepted connections only prove that the listener is doing its job. I would compare the request rate with the service's capacity and concurrency, then check upstream pending requests, latency, and 503 response flags. If the listener is accepting more than the service can process, the fix is capacity or load reduction, not another listener. If the listener is accepting traffic but the route names a missing cluster, the 503 comes from routing, not from listener capacity.",
    followUps: [
      "Which metrics separate listener work from service work?",
      "What does a 503 with no healthy upstream mean?",
      "Would adding a second listener on the same port help?",
    ],
    redFlags: [
      "Equates accepted connections with successful requests.",
      "Adds a listener on the same port.",
      "Ignores upstream latency.",
    ],
    rubric: [
      "Separates accept from delivery.",
      "Uses upstream signals.",
      "Chooses capacity or routing correctly.",
      "Rejects duplicate listeners on one port.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every service port has a named owner and appears in the mesh config.",
      "Listener bind ports and filter chain match criteria are reviewed with the service definition.",
      "Dashboards show listener accept counts separately from HTTP success and upstream health.",
      "A synthetic check dials the same address and port as a real client.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the client destination port with the listener bind port before editing routes.",
      "Check the filter chain match if the connection is accepted and then closed.",
      "Use the config dump and socket listing to confirm what is actually bound.",
      "Check service capacity only after the connection reaches HTTP.",
      "Record which layer refused the request and at what time.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a test that dials every declared service port through the proxy.",
      "Remove unused listeners and document the remaining ones.",
      "Verify that the client target and listener config cannot drift independently.",
      "Review whether a port change bypassed the mesh or the ingress path.",
    ],
  },
];

const references = [
  {
    title: "Envoy listeners",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/listeners/listeners",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Listeners, filter chains, chain match criteria, and listener filters.",
  },
  {
    title: "Envoy listener configuration reference",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/listeners/listeners",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Listener address, filter chains, listener filters, and listener state.",
  },
  {
    title: "Envoy HTTP connection manager overview",
    url: "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_conn_man/overview",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "How the HCM turns an accepted connection into HTTP requests and route lookups.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    listener: {
      model: listenerModel,
      presets,
      instructions:
        "Start Healthy, apply Wrong port, then restore the client port. Compare the listener path with the Peak preset, where the listener accepts but the service is saturated.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 10,000 rps service capacity and latency curve are teaching values, not Envoy defaults or provider limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-l4-vs-l7",
    "mesh-envoy-clusters",
    "mesh-envoy-routes",
    "mesh-envoy-admin",
    "mesh-access-logs",
  ],
};
