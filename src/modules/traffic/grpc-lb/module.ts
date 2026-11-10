import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BASE_MS = 12;
const HEADROOM = 1.8;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 200_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Traffic",
    help: "gRPC calls per second across all clients. Each call is an HTTP/2 stream on a client connection.",
    format: "rps" as const,
  },
  {
    id: "clientCount",
    label: "gRPC clients",
    min: 1,
    max: 500,
    step: 1,
    value: 100,
    unit: " clients",
    group: "Traffic",
    help: "Client processes or pods holding a gRPC channel. Connection-level balancing distributes connections, not calls.",
    format: "count" as const,
  },
  {
    id: "backendCount",
    label: "Backend replicas",
    min: 3,
    max: 50,
    step: 1,
    value: 20,
    unit: " replicas",
    group: "Topology",
    help: "Server replicas behind the balancer. A connection-level balancer can use at most as many as there are client connections.",
    format: "count" as const,
  },
  {
    id: "maxStreams",
    label: "Max concurrent streams per connection",
    min: 10,
    max: 1_000,
    step: 10,
    value: 100,
    unit: " streams",
    group: "Protocol",
    help: "The HTTP/2 setting that caps concurrent streams on one connection. Calls above the cap wait or trigger another connection.",
    format: "count" as const,
  },
  {
    id: "balancingMode",
    label: "Balancing (0 L4, 1 L7 proxy, 2 client-side)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Balancing",
    help: "Connection-level balancing picks a backend per TCP connection; the L7 proxy balances streams; client-side balancing opens a subchannel per backend.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  clients: number;
  backends: number;
  maxStreams: number;
  mode: number;
  activeBackends: number;
  idleBackends: number;
  maxShare: number;
  maxLoad: number;
  connections: number;
  concurrentStreams: number;
  streamsPerConnection: number;
  queuedStreams: number;
  p99: number;
  loadRatio: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const clients = Math.max(1, Math.round(num(p, "clientCount", 100)));
  const backends = Math.max(1, Math.round(num(p, "backendCount", 20)));
  const maxStreams = Math.max(1, Math.round(num(p, "maxStreams", 100)));
  const mode = Math.round(Math.min(2, Math.max(0, num(p, "balancingMode", 1))));

  const activeBackends = mode === 0 ? Math.min(clients, backends) : backends;
  const idleBackends = backends - activeBackends;
  const maxShare =
    mode === 0 ? Math.ceil(clients / Math.max(1, activeBackends)) / clients : 1 / backends;
  const loadRatio = (maxShare * backends) / HEADROOM;
  const maxLoad = loadRatio * 100;

  const connections = mode === 0 ? clients : mode === 1 ? backends : clients * backends;
  const concurrentStreams = requestRate * (BASE_MS / 1_000);
  const streamsPerConnection = concurrentStreams / Math.max(1, connections);
  const queuedStreams = Math.max(0, concurrentStreams - connections * maxStreams);

  const streamQueueMs =
    streamsPerConnection > maxStreams
      ? Math.min(4_000, 120 * (streamsPerConnection / maxStreams - 1) ** 1.2)
      : 0;
  const overloadQueueMs =
    loadRatio > 1 ? Math.min(4_000, 200 * (loadRatio - 1) ** 1.2) : 0;
  const p99 = BASE_MS + streamQueueMs + overloadQueueMs;

  return {
    requestRate,
    clients,
    backends,
    maxStreams,
    mode,
    activeBackends,
    idleBackends,
    maxShare,
    maxLoad,
    connections,
    concurrentStreams,
    streamsPerConnection,
    queuedStreams,
    p99,
    loadRatio,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = compute(p);
  const proxyHealth =
    d.maxLoad >= 95 || d.p99 >= 400
      ? "crit"
      : d.maxLoad >= 85 || d.p99 >= 100 || d.connections >= 5_000
        ? "warn"
        : "ok";
  const backendHealth = healthFor(d.maxLoad, 85, 95);
  const modeLabel =
    d.mode === 0 ? "L4 connection balancing" : d.mode === 1 ? "L7 stream balancing" : "Client-side balancing";
  const balancerLabel =
    d.mode === 0 ? "Layer 4 load balancer" : d.mode === 1 ? "L7 gRPC proxy" : "Client-side resolver";

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "gRPC clients",
        kind: "client",
        health: "ok",
        throughput: d.requestRate,
        sublabel: `${d.clients.toLocaleString()} clients · ${modeLabel.toLowerCase()}`,
        detail: `Each client holds a gRPC channel. ${d.mode === 0 ? "One HTTP/2 connection per client is pinned to one backend." : d.mode === 1 ? "Calls are multiplexed over the proxy's upstream connections and balanced per stream." : `Each client opens ${d.backends} subchannels, one per backend.`}`,
        meta: { view: "flow" },
      },
      {
        id: "balancer",
        label: balancerLabel,
        kind: "lb",
        health: proxyHealth,
        utilization: clamp(d.maxLoad / 100),
        throughput: d.requestRate,
        sublabel: `${d.connections.toLocaleString()} connections · ${d.activeBackends}/${d.backends} backends active`,
        detail: `The balancer chooses a backend per ${d.mode === 0 ? "connection" : "stream"}. ${d.mode === 0 ? "All streams on a client connection share that one choice." : "Each call can land on a different backend, within the stream cap."}`,
        meta: { view: "flow" },
      },
      {
        id: "backends",
        label: "Backend fleet",
        kind: "service",
        health: backendHealth,
        utilization: clamp(d.maxLoad / 100),
        throughput: d.requestRate,
        sublabel: `busiest ${d.maxLoad.toFixed(0)}% · ${d.idleBackends} idle`,
        detail: `${d.activeBackends} of ${d.backends} backends receive traffic. The busiest carries about ${(d.maxShare * 100).toFixed(1)}% of calls, ${(d.maxShare * d.backends).toFixed(1)}x its fair share, or ${d.maxLoad.toFixed(0)}% of modeled capacity.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-balancer", "clients", "balancer", clamp(d.requestRate / 200_000), "ok"),
      edge("balancer-backends", "balancer", "backends", clamp(d.maxLoad / 100), backendHealth),
    ],
    metrics: [
      metric("max-backend-load", "Busiest backend demand vs capacity", d.maxLoad, "%", 85, 95, "percent"),
      metric("idle-backends", "Idle backend replicas", d.idleBackends, " replicas", 10, 25, "count"),
      metric("p99", "gRPC p99", d.p99, "ms", 100, 400, "ms"),
      metric("connections", "Backend-facing connections", d.connections, " conns", 5_000, 20_000, "count"),
      metric("streams-per-connection", "Concurrent streams per connection", d.streamsPerConnection, " streams", undefined, undefined, "number"),
      metric("queued-streams", "Streams above the concurrent cap", d.queuedStreams, " streams", undefined, undefined, "count"),
      metric("active-backends", "Active backends", d.activeBackends, " replicas", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      mode: d.mode,
      maxLoad: d.maxLoad,
    },
    summary: `${d.activeBackends}/${d.backends} backends active; busiest at ${d.maxLoad.toFixed(0)}%; ${d.connections.toLocaleString()} connections; p99 ${d.p99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 6)) / 2.4)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "max-backend-load",
    metricId: "max-backend-load",
    warn: 85,
    crit: 95,
    title: "One backend is carrying an outsized share of gRPC calls",
    cause:
      "The balancer chooses a backend per connection. A client's long-lived HTTP/2 connection keeps sending every stream to that backend, so a few connections can overload a few replicas while the rest stay idle.",
    fix:
      "Balance per request or per stream with an L7 proxy, or use client-side balancing with a subchannel per backend. Check the connection-to-backend mapping before adding replicas.",
    checkFirst: [
      "Compare per-backend request rate and CPU with the fleet average.",
      "Count connections per backend and clients per backend.",
      "Check whether the load balancer is operating at Layer 4 or routing HTTP/2 streams.",
    ],
  },
  {
    id: "idle-backends",
    metricId: "idle-backends",
    warn: 10,
    crit: 25,
    title: "Replicas are idle while other backends are overloaded",
    cause:
      "There are fewer client connections than backend replicas, or connections are unevenly distributed. Connection-level balancing cannot use more backends than it has connections.",
    fix:
      "Add request-level balancing, open more client connections, or scale clients with the backend fleet. Do not add backends without fixing the distribution path.",
    checkFirst: [
      "Compare client count with backend count.",
      "Check connections per backend, not only total connections.",
      "Check whether clients resolve all endpoints or a single service address.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 100,
    crit: 400,
    title: "gRPC calls are queueing behind a hot connection or stream cap",
    cause:
      "A hot backend adds queueing latency, or one HTTP/2 connection carries more concurrent streams than its configured cap. Both look like application latency but happen before the request is served.",
    fix:
      "Balance per stream, raise the stream cap only if the backend can serve it, or add connections. Check the proxy's upstream pool and the backend's concurrent-stream limit.",
    checkFirst: [
      "Compare the slow span's server-side duration with the client-side duration.",
      "Check concurrent streams per connection and the max-streams setting.",
      "Check the busiest backend's queue and CPU.",
    ],
  },
  {
    id: "connections",
    metricId: "connections",
    warn: 5_000,
    crit: 20_000,
    title: "The balancing design is multiplying connections",
    cause:
      "Client-side balancing opens a subchannel per client per backend. Even load distribution is not free: connection count grows with both client and backend count, and every connection consumes file descriptors and memory.",
    fix:
      "Use a proxy pool to multiplex clients, or cap client subchannels and use xDS or a service mesh to manage them. Check connection limits before scaling the fleet.",
    checkFirst: [
      "Multiply client count by backend count and compare with the actual connection count.",
      "Check file descriptors and connection limits on clients and backends.",
      "Check whether the proxy pool has one connection per backend or more.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const grpcModel: SimModel = {
  id: "traffic-grpc-lb",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const d = compute(p);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-60);
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    next.series = {};
    for (const item of next.metrics) {
      const previous = frame.series[item.id] ?? [];
      next.series[item.id] = [...previous, item.value].slice(-120);
    }

    if (d.mode === 0 && d.idleBackends > 0 && next.flags.pinningWarned !== 1) {
      pushEvent(next, {
        id: "grpc-connection-pinning",
        at: frame.t,
        severity: d.maxLoad >= 95 ? "crit" : "warn",
        title: "gRPC connections are pinned to a subset of backends",
        detail: `${d.clients} client connections can use at most ${d.activeBackends} of ${d.backends} backends. The busiest backend carries about ${(d.maxShare * 100).toFixed(1)}% of calls.`,
        nodeId: "balancer",
        metricId: "idle-backends",
      });
      next.flags.pinningWarned = 1;
    }
    if (!(d.mode === 0 && d.idleBackends > 0)) next.flags.pinningWarned = 0;

    if (d.streamsPerConnection > d.maxStreams && next.flags.streamWarned !== 1) {
      pushEvent(next, {
        id: "grpc-stream-cap",
        at: frame.t,
        severity: d.p99 >= 400 ? "crit" : "warn",
        title: "Concurrent streams exceed the per-connection cap",
        detail: `${d.streamsPerConnection.toFixed(1)} concurrent streams per connection against a cap of ${d.maxStreams}. About ${Math.round(d.queuedStreams).toLocaleString()} streams wait or need another connection.`,
        nodeId: "balancer",
        metricId: "queued-streams",
      });
      next.flags.streamWarned = 1;
    }
    if (d.streamsPerConnection <= d.maxStreams) next.flags.streamWarned = 0;

    const previousMode = Number(frame.flags.mode ?? d.mode);
    if (d.mode !== previousMode) {
      pushEvent(next, {
        id: "balancing-mode-change",
        at: frame.t,
        severity: "info",
        title: `Balancing changed to ${d.mode === 0 ? "connection-level" : d.mode === 1 ? "L7 stream" : "client-side"}`,
        detail: `${d.connections.toLocaleString()} connections, ${d.activeBackends} active backends, busiest at ${d.maxLoad.toFixed(0)}%.`,
        nodeId: "balancer",
      });
    }

    next.summary = `${d.activeBackends}/${d.backends} backends active; busiest at ${d.maxLoad.toFixed(0)}%; ${d.connections.toLocaleString()} connections; p99 ${d.p99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      d.mode === 0
        ? `Connection-level balancing uses ${d.activeBackends} of ${d.backends} backends because there are only ${d.clients} client connections.`
        : d.mode === 1
          ? `The L7 proxy balances streams across all ${d.backends} backends using ${d.connections} upstream connections.`
          : `Client-side balancing opens ${d.connections.toLocaleString()} subchannels across ${d.backends} backends.`,
    );
    items.push(
      `The busiest backend carries about ${(d.maxShare * 100).toFixed(1)}% of calls: ${(d.maxShare * d.backends).toFixed(1)}x its fair share, or ${d.maxLoad.toFixed(0)}% of modeled capacity.`,
    );
    items.push(
      d.streamsPerConnection > d.maxStreams
        ? `${d.streamsPerConnection.toFixed(1)} concurrent streams per connection exceed the cap of ${d.maxStreams}; calls queue before the backend sees them.`
        : `${d.streamsPerConnection.toFixed(1)} concurrent streams per connection are within the cap of ${d.maxStreams}.`,
    );
    items.push(
      d.idleBackends > 0
        ? `${d.idleBackends} replicas receive no traffic. Adding more replicas does not help a connection-level balancer with fewer client connections.`
        : "Every backend receives traffic in this configuration.",
    );
    items.push(
      "gRPC clients keep HTTP/2 connections open; a Layer 4 balancer's choice is made once per connection, not once per call.",
    );
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
    description: "An L7 proxy balances streams across every backend with a comfortable stream cap.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High call rate on a proxy with a low stream cap; calls queue on each upstream connection.",
    tone: "warn",
    params: defaults({ requestRate: 200_000, clientCount: 50, backendCount: 20, maxStreams: 50, balancingMode: 1 }),
  },
  {
    id: "failure",
    label: "Pinned to eight backends",
    description: "Eight clients behind a Layer 4 balancer pin to eight of forty backends; the rest sit idle.",
    tone: "crit",
    params: defaults({ requestRate: 40_000, clientCount: 8, backendCount: 40, maxStreams: 1_000, balancingMode: 0 }),
  },
  {
    id: "client-side",
    label: "Client-side",
    description: "Client-side balancing spreads load evenly but opens one subchannel per client per backend.",
    tone: "ok",
    params: defaults({ requestRate: 40_000, clientCount: 8, backendCount: 40, maxStreams: 1_000, balancingMode: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The L7 proxy balances the same eight clients across all forty backends.",
    tone: "ok",
    params: defaults({ requestRate: 40_000, clientCount: 8, backendCount: 40, maxStreams: 1_000, balancingMode: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-grpc-pinning",
  title: "Predict why the backends are idle",
  simId: "grpc",
  question:
    "Eight gRPC clients use one HTTP/2 connection each to a Service in front of forty healthy backends. Thirty-two backends stay idle. Why?",
  prediction: {
    options: [
      { id: "pinned", label: "The Layer 4 balancer chose a backend once per connection; all streams are pinned." },
      { id: "dns", label: "DNS cached only eight backend addresses, so the other replicas were never resolved." },
      { id: "streams", label: "The stream cap is too low, so the other backends reject new streams." },
      { id: "health", label: "Thirty-two backends are failing health checks but still registered." },
    ],
    correctOptionId: "pinned",
    explanation:
      "A Layer 4 balancer chooses a backend when the TCP connection is established. gRPC keeps that HTTP/2 connection open and multiplexes calls on it, so every stream from one client goes to the same backend. With eight clients there can be at most eight backend connections, regardless of how many replicas exist. The fix is request-level or client-side balancing, not more replicas or a larger stream cap.",
  },
  setup: defaults({ requestRate: 40_000, clientCount: 8, backendCount: 40, maxStreams: 1_000, balancingMode: 0 }),
  runFor: 20,
  observe: [
    "Only eight backends are active and thirty-two are idle.",
    "The busiest backend is at about 278% of modeled capacity, five times its fair share, so p99 reaches about 410ms.",
    "Each client connection carries about 60 concurrent streams, below the 1,000 cap; the cap is not the cause.",
  ],
  explain:
    "The connection is the unit of balancing at Layer 4. gRPC's long-lived HTTP/2 channel makes that choice durable, so the number of clients sets the maximum number of backends that can receive traffic. Request-level balancing moves the decision to the proxy, where each stream can choose a backend. Client-side balancing achieves the same distribution by opening a subchannel to every backend, at the cost of more connections and client complexity.",
  fix: defaults({ requestRate: 40_000, clientCount: 8, backendCount: 40, maxStreams: 1_000, balancingMode: 1 }),
  debrief:
    "The proxy activates all forty backends and the busiest load falls to about 56% of modeled capacity. p99 returns to the application baseline. The tradeoff is an extra network hop, a stateful proxy to operate, and an upstream connection pool to size. Client-side balancing avoids the proxy hop but opens 320 subchannels for the same eight clients and forty backends.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "gRPC is a remote procedure call framework that uses HTTP/2. A client opens a channel, the channel establishes a long-lived HTTP/2 connection, and each call becomes a stream on that connection. HTTP/2 multiplexes many concurrent streams, so one connection can carry a lot of call traffic. The transport choice is efficient, but it changes what a load balancer is choosing between.",
  },
  {
    type: "p",
    text: "A Layer 4 load balancer routes a TCP connection to a backend and then forwards bytes. It does not see individual HTTP/2 streams, so every call on a client's connection goes to the backend chosen at connect time. A Layer 7 proxy terminates or routes HTTP/2 and can choose a backend per stream. Client-side balancing moves the choice into the client: it resolves the backend set, opens a subchannel to each, and applies a policy such as round robin. The first design balances connections; the others balance calls.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is gRPC client, name resolution, balancer or proxy, backend. A Kubernetes Service is usually a Layer 4 virtual IP, so a client that connects to the service name gets one backend per connection. A headless Service exposes pod addresses, which lets a client-side resolver open a subchannel per backend. A proxy such as Envoy or a gRPC-aware load balancer keeps its own upstream pool and distributes streams. The number of client connections, backend replicas, and the maximum concurrent streams per connection decide whether the design can use the fleet.",
  },
  {
    type: "compare",
    leftTitle: "Connection-level (L4)",
    rightTitle: "Request-level (L7 or client-side)",
    rows: [
      { label: "Decision unit", left: "One backend per TCP connection", right: "One backend per stream or call" },
      { label: "Backends usable", left: "At most the number of client connections", right: "All healthy backends" },
      { label: "Load skew", left: "Follows connection placement; idle replicas are possible", right: "Even, subject to policy and stream limits" },
      { label: "Connections", left: "Low: one per client", right: "Proxy pool or clients times backends" },
      { label: "Operational cost", left: "Simple, no proxy", right: "Proxy hop or client-side resolver and subchannels" },
    ],
  },
  {
    type: "p",
    text: "The simulation uses 1,000–200,000 calls per second, 1–500 clients, 3–50 backends, and a 10–1,000 stream cap. Each client is treated as one connection in connection-level mode, and the proxy pool as one connection per backend in L7 mode. Those are teaching assumptions, not universal gRPC defaults. The shape is the lesson: connection-level balancing cannot use more backends than it has connections, and a stream cap can add latency even when the load is evenly spread.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Active and idle backend replicas, which expose connection pinning immediately.",
      "Busiest backend demand against modeled capacity, so uneven distribution is visible.",
      "Connections, concurrent streams per connection, and streams above the cap.",
      "gRPC p99, which rises from a hot backend or from stream queueing.",
      "A comparison of connection-level, L7 proxy, and client-side modes at the same traffic.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy with the L7 proxy, then apply Pinned to eight backends and watch idle replicas appear. Run the guided experiment before reading its explanation. Switch to Client-side and compare connection count with load distribution. Change the stream cap last, so pinning and stream queueing are not confused.",
  },
  {
    type: "table",
    headers: ["Symptom", "Likely cause", "First check"],
    rows: [
      ["Many idle backends, few hot", "Connection-level balancing with few clients", "Connections per backend"],
      ["Even load but high p99", "Stream cap or backend capacity", "Concurrent streams and server queue"],
      ["Connection count grows with clients times backends", "Client-side subchannels", "File descriptors and connection limits"],
      ["One backend hot after a client restart", "New connection placement", "Connection-to-backend mapping"],
    ],
  },
  { type: "sim", simId: "grpc" },
  { type: "experiment", experimentId: "predict-grpc-pinning" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Eight gRPC clients opened one long-lived HTTP/2 connection each through a Layer 4 balancer. The balancer chose a backend per connection, so only eight of forty backends received traffic. Those eight carried about 278% of modeled capacity, five times their fair share, and p99 rose above 400ms, while thirty-two replicas stayed idle. The stream cap was not the cause; each connection carried about 60 concurrent streams against a cap of 1,000.",
  },
  {
    type: "p",
    text: "Moving to an L7 proxy let each stream choose a backend. All forty replicas became active, the busiest load fell to about 56% of modeled capacity, and p99 returned to the application baseline. Client-side balancing produced the same distribution with 320 subchannels, trading a proxy hop for more connections and a resolver in the client.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Backend: request rate and CPU per replica, not only the fleet average. A small set of hot replicas with idle peers is the signature.",
      "Connections: connections per backend, client count, and whether the balancer is Layer 4 or Layer 7.",
      "gRPC: concurrent streams per connection, `max_concurrent_streams`, GOAWAY events, and stream reset counts.",
      "Proxy: upstream connection pool size, pending requests, and per-cluster load distribution.",
      "Kubernetes: Service type, headless Service use, and whether clients resolve all pod endpoints or one virtual IP.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare client count with backend count and look at request rate per backend. If only as many backends as clients are active, the balancer is choosing per connection. If all backends are active but p99 is high, check the stream cap and backend capacity instead.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the decision unit: a Layer 4 Service chooses per connection; a proxy or client-side resolver chooses per call.",
      "If the backend fleet is larger than the client count, add request-level balancing or client-side subchannels.",
      "Size the proxy upstream pool and the backend stream cap together; a pool of one connection per backend can still queue.",
      "If using client-side balancing, cap subchannels and monitor file descriptors and connection limits.",
      "Use connection age, GOAWAY, and outlier detection so a bad backend does not stay pinned.",
      "Verify per-backend load and p99 after the change, not just total throughput.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "L7 proxying adds a hop, another stateful component, and an upstream pool to size.",
      "Client-side balancing removes the proxy hop but multiplies connections and puts policy in every client.",
      "More concurrent streams per connection improve efficiency but concentrate the impact of a connection failure.",
      "A low stream cap protects a backend but can queue calls; a high cap can overload it.",
      "Connection-level balancing is simple and cheap when clients outnumber backends and placement is even.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "grpc-pinning",
    question:
      "A gRPC service has forty replicas, but only eight receive traffic. The client deployment has eight pods. What is happening?",
    difficulty: 3,
    hints: [
      "Count connections, not requests.",
      "A Kubernetes Service is usually Layer 4.",
    ],
    answer:
      "Each client pod has a long-lived HTTP/2 connection to one backend through the Layer 4 Service. The balancer chose a backend at connect time, so all streams from that client go to the same backend. Eight clients can use at most eight backends. I would confirm by checking connections per backend and request rate per backend. The fix is request-level balancing through an L7 proxy or client-side balancing with a subchannel per backend. Adding replicas will not help while the connection count is the limit.",
    followUps: [
      "What changes if the clients use a headless Service?",
      "How would you confirm the stream cap is not the cause?",
      "What happens when one of the eight backends fails?",
    ],
    redFlags: [
      "Adds more replicas.",
      "Blames DNS without checking connections.",
      "Confuses streams with connections.",
    ],
    rubric: [
      "Identifies connection pinning.",
      "Checks per-backend load.",
      "Names request-level or client-side balancing.",
      "Explains why replicas do not help.",
    ],
  },
  {
    id: "grpc-balancing-choice",
    question:
      "Compare an L7 proxy and client-side balancing for gRPC. When would you choose each?",
    difficulty: 3,
    hints: [
      "Think about hop count and connection count.",
      "Consider who owns the client and the policy.",
    ],
    answer:
      "An L7 proxy centralizes balancing, keeps client connection counts low, and can apply outlier detection and retries in one place. It adds a network hop and a stateful component whose upstream pool must be sized. Client-side balancing removes the proxy hop and lets the client choose per call, but every client needs a resolver and a subchannel per backend, so connections grow with clients times backends. I would choose the proxy when many clients share a fleet and I want central policy, and client-side when the hop is expensive and the client fleet is small or already uses a mesh or xDS control plane.",
    followUps: [
      "How does max concurrent streams affect the proxy pool?",
      "What does a service mesh add?",
      "Which design is easier to canary?",
    ],
    redFlags: [
      "Calls one option universally better.",
      "Ignores connection multiplication.",
      "Ignores the proxy pool.",
    ],
    rubric: [
      "Names the hop and connection tradeoff.",
      "Explains policy placement.",
      "Sizes the pool or subchannels.",
      "States a selection rule.",
    ],
  },
  {
    id: "grpc-stream-cap",
    question:
      "Load is evenly spread across all backends, but gRPC p99 is high. How do you investigate the stream cap?",
    difficulty: 4,
    hints: [
      "Streams queue before the server sees them.",
      "Compare client and server span durations.",
    ],
    answer:
      "I would compare concurrent streams per connection with the server's advertised max concurrent streams and check whether the proxy has pending requests. If the client span is much longer than the server span, the call waited for a stream slot or a connection. I would raise the cap only if the backend has CPU and memory headroom, or add upstream connections. I would also check for a single hot connection, GOAWAY, and stream resets. The fix is to match the cap to backend capacity, not to raise it blindly.",
    followUps: [
      "How does the proxy decide to open another upstream connection?",
      "What happens when the cap is reached during a burst?",
      "How would you prove the queue is before the application?",
    ],
    redFlags: [
      "Raises the cap without checking backend capacity.",
      "Looks only at CPU.",
      "Ignores pending requests at the proxy.",
    ],
    rubric: [
      "Compares stream count with the cap.",
      "Separates client and server time.",
      "Sizes the pool or cap.",
      "Names a verification.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The balancing decision unit is documented: per connection, per stream, or client-side.",
      "Per-backend request rate and connections are graphed, not only fleet averages.",
      "The proxy upstream pool and backend stream cap are sized together.",
      "Connection age, GOAWAY, and outlier detection are configured.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare active backends with client connection count.",
      "Check request rate per backend before adding replicas.",
      "Compare concurrent streams with the max-streams setting.",
      "Check whether the proxy or client resolver is using all endpoints.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify per-backend load and p99 after the balancing change.",
      "Check client and proxy connection counts against file-descriptor limits.",
      "Test a backend failure and confirm traffic moves.",
      "Document the connection and stream assumptions used for capacity.",
    ],
  },
];

const references = [
  {
    title: "gRPC Load Balancing",
    url: "https://grpc.io/blog/grpc-load-balancing/",
    publisher: "gRPC",
    kind: "docs" as const,
    note: "Connection-level versus request-level balancing and client-side policies.",
  },
  {
    title: "Envoy load balancing",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers",
    publisher: "Envoy",
    kind: "docs" as const,
    note: "Upstream load balancing policies used by gRPC-aware proxies.",
  },
  {
    title: "Envoy connection pooling",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/connection_pooling",
    publisher: "Envoy",
    kind: "docs" as const,
    note: "Upstream connection pools, stream limits, and HTTP/2 connection behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    grpc: {
      model: grpcModel,
      presets,
      instructions:
        "Start healthy, then apply Pinned to eight backends and watch idle replicas. Run the experiment before revealing the answer, then switch to the L7 proxy. Compare Client-side on connection count and load distribution.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. One connection per client at Layer 4, one upstream connection per backend at the proxy with excess streams queued rather than opening more connections, and the 1.8 headroom factor are teaching assumptions, not universal gRPC behavior or vendor limits.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-l4-vs-l7", "traffic-keepalive-idle-timeout", "traffic-502-debug"],
};
