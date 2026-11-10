import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RTT_MS = 40;
const APP_MS = 25;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 100,
    max: 20_000,
    step: 100,
    value: 3_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving from all clients. Concurrency is spread across the active client fleet.",
    format: "rps" as const,
  },
  {
    id: "activeClients",
    label: "Active clients",
    min: 100,
    max: 20_000,
    step: 100,
    value: 2_000,
    unit: " clients",
    group: "Traffic",
    help: "Clients holding a connection. More clients lower the per-connection request rate and expose idle timeouts.",
    format: "count" as const,
  },
  {
    id: "clientIdleTimeout",
    label: "Client idle timeout",
    min: 1,
    max: 300,
    step: 1,
    value: 60,
    unit: " s",
    group: "Timeouts",
    help: "How long the client keeps a connection open with no requests.",
    format: "number" as const,
  },
  {
    id: "lbIdleTimeout",
    label: "Load balancer idle timeout",
    min: 1,
    max: 300,
    step: 1,
    value: 60,
    unit: " s",
    group: "Timeouts",
    help: "How long the load balancer holds an idle connection before closing it.",
    format: "number" as const,
  },
  {
    id: "backendIdleTimeout",
    label: "Backend idle timeout",
    min: 1,
    max: 300,
    step: 1,
    value: 60,
    unit: " s",
    group: "Timeouts",
    help: "How long the application server keeps an idle connection. The shortest timeout in the path closes first.",
    format: "number" as const,
  },
  {
    id: "maxRequestsPerConnection",
    label: "Max requests per connection",
    min: 10,
    max: 5_000,
    step: 10,
    value: 1_000,
    unit: " req",
    group: "Reuse",
    help: "Request or stream cap before the connection is retired, even if it is active. HTTP/2 servers can also send GOAWAY to drain.",
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
  gapSeconds: number;
  effectiveTimeout: number;
  timeoutSpread: number;
  reuseRequests: number;
  maxRequests: number;
  cappedByRequests: boolean;
  newConnections: number;
  requestLatencyEstimate: number;
  shortestPeer: string;
}

function compute(p: Params): Computed {
  const requestRate = num(p, "requestRate", 3_000);
  const clients = Math.max(1, num(p, "activeClients", 2_000));
  const clientTimeout = num(p, "clientIdleTimeout", 60);
  const lbTimeout = num(p, "lbIdleTimeout", 60);
  const backendTimeout = num(p, "backendIdleTimeout", 60);
  const maxRequests = Math.max(1, num(p, "maxRequestsPerConnection", 1_000));

  const timeouts = [
    { name: "client", value: clientTimeout },
    { name: "load balancer", value: lbTimeout },
    { name: "backend", value: backendTimeout },
  ].sort((a, b) => a.value - b.value);
  const effectiveTimeout = timeouts[0].value;
  const gapSeconds = clients / requestRate;
  const timeoutReuse = Math.max(1, effectiveTimeout / gapSeconds);
  const reuseRequests = Math.min(maxRequests, timeoutReuse);
  const newConnections = requestRate / reuseRequests;
  const timeoutSpread = timeouts[2].value - timeouts[0].value;
  const handshakeShare = Math.min(1, (newConnections / requestRate) * 4);
  return {
    requestRate,
    clients,
    gapSeconds,
    effectiveTimeout,
    timeoutSpread,
    reuseRequests,
    maxRequests,
    cappedByRequests: maxRequests < timeoutReuse,
    newConnections,
    requestLatencyEstimate: APP_MS + 2 * RTT_MS * handshakeShare,
    shortestPeer: timeouts[0].name,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const connHealth =
    values.newConnections >= 2_000 ? "crit" : values.newConnections >= 500 ? "warn" : "ok";
  const latencyHealth =
    values.requestLatencyEstimate >= 250 ? "crit" : values.requestLatencyEstimate >= 100 ? "warn" : "ok";
  const spreadHealth =
    values.timeoutSpread >= 120 ? "crit" : values.timeoutSpread >= 20 ? "warn" : "ok";
  const health =
    connHealth === "crit" || latencyHealth === "crit" || spreadHealth === "crit"
      ? "crit"
      : connHealth !== "ok"
        ? connHealth
        : latencyHealth !== "ok"
          ? latencyHealth
          : spreadHealth;
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Client fleet",
        kind: "client",
        health: spreadHealth,
        sublabel: `${values.clients.toLocaleString()} clients`,
        detail: `Each client sends a request about every ${values.gapSeconds.toFixed(2)}s. An idle timeout shorter than that gap closes the connection between requests.`,
        meta: { view: "flow" },
      },
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health: connHealth,
        throughput: values.newConnections,
        sublabel: `${Math.round(values.newConnections).toLocaleString()} new conn/s`,
        meta: { view: "flow", timeout: values.effectiveTimeout },
      },
      {
        id: "backend",
        label: "Backend pool",
        kind: "service",
        health,
        utilization: clamp(values.newConnections / 2_000),
        throughput: values.requestRate,
        sublabel: `${values.reuseRequests.toFixed(1)} req/conn`,
        detail: `Closes idle connections after its own timeout. The shortest timeout among client, load balancer, and backend decides how long a connection actually survives.`,
        meta: { view: "flow", timeout: values.effectiveTimeout },
      },
    ],
    edges: [
      edge("client-lb", "client", "lb", clamp(values.newConnections / 2_000), connHealth),
      edge("lb-backend", "lb", "backend", clamp(values.requestRate / 20_000), health),
    ],
    metrics: [
      metric("new-connections", "New connections", values.newConnections, " conn/s", 500, 2_000, "rps"),
      metric("request-latency", "Request latency estimate", values.requestLatencyEstimate, "ms", 100, 250, "ms"),
      metric("timeout-spread", "Timeout spread", values.timeoutSpread, " s", 20, 120, "number"),
      metric("reuse-ratio", "Requests per connection", values.reuseRequests, " req", undefined, undefined, "number"),
      metric("effective-timeout", "Effective idle timeout", values.effectiveTimeout, " s", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${Math.round(values.newConnections).toLocaleString()} new connections/s; ${values.reuseRequests.toFixed(1)} requests per connection; latency estimate ${values.requestLatencyEstimate.toFixed(0)}ms.`,
  };
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 5)) / 2.6);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, item.value * jitter(index + item.id.length)),
    );
  }
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "new-connections",
    metricId: "new-connections",
    warn: 500,
    crit: 2_000,
    title: "The backend sees a new connection per request",
    cause:
      "The effective idle timeout is shorter than the gap between requests on a connection, so one peer closes each connection before the next request. Reuse never happens, and every request pays a handshake.",
    fix:
      "Align idle timeouts across client, load balancer, and backend, then verify reuse with connection counts. Fix the shortest peer rather than raising every timeout blindly.",
    checkFirst: [
      "Compare client, load balancer, and backend idle timeouts.",
      "Compare request rate with new-connection rate.",
      "Check whether the churn started with a configuration or deploy change.",
    ],
  },
  {
    id: "request-latency",
    metricId: "request-latency",
    warn: 100,
    crit: 250,
    title: "Connection churn is showing up in request latency",
    cause:
      "When a connection closes between requests, the next request includes a TCP and TLS handshake. The tail grows even though request processing is unchanged.",
    fix:
      "Restore reuse and confirm that the handshake span disappears for steady traffic. Check that the load balancer's idle timeout is not shorter than the client's think time.",
    checkFirst: [
      "Compare time to first byte with application processing time.",
      "Check new-connection rate at the load balancer and the backend.",
      "Check timeouts on every hop, including sidecars and proxies.",
    ],
  },
  {
    id: "timeout-spread",
    metricId: "timeout-spread",
    warn: 20,
    crit: 120,
    title: "Idle timeouts disagree across the path",
    cause:
      "Different peers close idle connections at different times. The shortest timeout wins, so a long timeout elsewhere does not preserve reuse and a long client timeout can hold a connection the server has already closed.",
    fix:
      "Set the backend and load balancer timeouts to the same value and keep the client at or above it. For HTTP/2, drain with GOAWAY before shutdown and jitter client reconnects.",
    checkFirst: [
      "Read the configured timeout from each peer, not the default.",
      "Check for GOAWAY frames and reconnect bursts around deploys.",
      "Check whether proxies or service mesh sidecars add another idle timeout.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const http2Model: SimModel = {
  id: "foundations-http2-keepalive",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    const values = compute(p);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "new-connections" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.newConnections >= 500 && frame.flags.churnWarned !== 1) {
      pushEvent(next, {
        id: "keepalive-churn",
        at: frame.t,
        severity: "warn",
        title: "Connections are closing between requests",
        detail: `The shortest idle timeout is ${values.effectiveTimeout}s on the ${values.shortestPeer}, but each client waits about ${values.gapSeconds.toFixed(1)}s between requests. New connections reach ${Math.round(values.newConnections).toLocaleString()} per second.`,
        nodeId: "lb",
        metricId: "new-connections",
      });
      next.flags.churnWarned = 1;
    }
    if (values.newConnections < 400) next.flags.churnWarned = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${Math.round(values.newConnections).toLocaleString()} new connections/s; ${values.reuseRequests.toFixed(1)} requests per connection; latency estimate ${values.requestLatencyEstimate.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The shortest timeout is ${values.effectiveTimeout}s on the ${values.shortestPeer}; timeouts differ by ${values.timeoutSpread}s across the path.`,
    );
    items.push(
      `Each client waits about ${values.gapSeconds.toFixed(2)}s between requests, so it can reuse a connection only if every peer keeps it open at least that long.`,
    );
    if (values.newConnections >= 500) {
      items.push(
        `Reuse collapses to ${values.reuseRequests.toFixed(1)} request per connection, producing ${Math.round(values.newConnections).toLocaleString()} new connections per second.`,
      );
    } else {
      items.push(
        `Clients fit about ${values.reuseRequests.toFixed(0)} requests on each connection, so new connections stay low.`,
      );
    }
    if (values.cappedByRequests) {
      items.push(
        `The ${Math.round(values.maxRequests)}-request cap retires connections before the idle timeout would, so reuse is capped even when timeouts are aligned.`,
      );
    }
    items.push(
      "HTTP/2 multiplexes concurrent streams on one connection, so churn costs more than HTTP/1.1: it discards all streams on the connection, not just one request.",
    );
    items.push(
      "During a deploy, GOAWAY lets in-flight streams finish, but clients must reconnect with jitter to avoid a synchronized wave.",
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
    description: "Timeouts agree and clients reuse connections between requests.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High traffic and one short load balancer timeout. Reuse drops but stays above one.",
    tone: "warn",
    params: defaults({ requestRate: 6_000, activeClients: 4_000, lbIdleTimeout: 30 }),
  },
  {
    id: "failure",
    label: "Backend closes first",
    description: "A two-second backend timeout closes every connection between requests.",
    tone: "crit",
    params: defaults({
      requestRate: 4_000,
      activeClients: 8_000,
      clientIdleTimeout: 60,
      lbIdleTimeout: 60,
      backendIdleTimeout: 2,
    }),
  },
  {
    id: "goaway",
    label: "Short backend timeout",
    description: "A short backend timeout closes connections between requests, so the backend sees churn.",
    tone: "warn",
    params: defaults({ requestRate: 4_000, activeClients: 8_000, backendIdleTimeout: 10 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "All three timeouts aligned above the client think time.",
    tone: "ok",
    params: defaults({
      requestRate: 4_000,
      activeClients: 3_000,
      clientIdleTimeout: 65,
      lbIdleTimeout: 65,
      backendIdleTimeout: 65,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-keepalive-timeout",
  title: "Which peer decides connection reuse?",
  simId: "http2",
  question:
    "The client and load balancer both keep idle connections for 60 seconds. The backend closes them after 2 seconds, and each client sends a request every 2 seconds. Which timeout governs reuse?",
  prediction: {
    options: [
      { id: "client", label: "The client timeout, because it initiates the connection" },
      { id: "lb", label: "The load balancer timeout, because it sits in the middle" },
      { id: "backend", label: "The backend timeout, because it closes first" },
      { id: "average", label: "The average of all three" },
    ],
    correctOptionId: "backend",
    explanation:
      "A connection can be reused only while every peer keeps it open. The first peer to close wins, and here the backend closes at 2 seconds, before the next request. The client and load balancer values are irrelevant if they are longer.",
  },
  setup: defaults({
    requestRate: 4_000,
    activeClients: 8_000,
    clientIdleTimeout: 60,
    lbIdleTimeout: 60,
    backendIdleTimeout: 2,
  }),
  runFor: 25,
  observe: [
    "Requests per connection falls to one and new connections rise to the request rate.",
    "The timeout spread is large even though two peers agree.",
    "The latency estimate includes a handshake that the application never sees as work.",
    "Aligning all three timeouts above the two-second gap restores reuse.",
  ],
  explain:
    "Reuse is a conjunction: client, load balancer, backend, and any proxy must all hold the connection across the idle gap. The minimum timeout is the effective lifetime. A mismatch also creates two failure shapes: the client may reuse a connection the server has already closed, or the server may keep a connection the client has abandoned. Both produce errors or churn.",
  fix: defaults({
    requestRate: 4_000,
    activeClients: 8_000,
    clientIdleTimeout: 65,
    lbIdleTimeout: 65,
    backendIdleTimeout: 65,
  }),
  debrief:
    "The aligned run reuses a connection for about 32 requests and drops new connections below the warning threshold. The tradeoff is that idle connections now occupy client, load balancer, and backend resources for 65 seconds; during a deploy, those connections must be drained with GOAWAY and jittered reconnects rather than dropped abruptly.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "The Hypertext Transfer Protocol (HTTP) carries requests over transport connections. Keep-alive is an agreement to reuse a connection for more than one request. HTTP/1.1 sends one request at a time per connection, so reuse amortizes the TCP and TLS handshake. HTTP/2 multiplexes many concurrent streams over one connection, so reuse also avoids head-of-line blocking between requests and reduces handshake cost further. In both cases the connection survives only while every peer is willing to keep it.",
  },
  {
    type: "p",
    text: "Each peer has an idle timeout and often a maximum request or stream count. The client may close after its own idle period, the load balancer after its configured idle timeout, and the backend after its keep-alive timeout or request cap. The shortest value is the effective lifetime. When requests arrive less often than that lifetime, the connection closes between requests and the next request opens a new one. That is connection churn: the service looks healthy, but the backend sees a new connection per request.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, optional CDN, load balancer, service mesh sidecar or proxy, then backend. Each hop can terminate the connection or pass it through. A load balancer typically maintains a front-end connection to the client and a separate back-end connection to the target, so there are two independent timeout decisions. A service mesh adds another. The effective reuse window is the minimum across all of them, not the value configured on the backend alone.",
  },
  {
    type: "table",
    headers: ["Peer", "Typical setting", "What it controls"],
    rows: [
      ["Client", "Keep-alive or idle timeout", "How long the client holds a connection with no requests"],
      ["Load balancer", "Idle timeout, 60s default on Application Load Balancer (ALB)", "How long the front-end and back-end idle connections survive"],
      ["Backend", "Keep-alive timeout", "How long the application server waits before closing an idle connection"],
      ["Protocol", "Max streams or requests", "When the connection is retired even if it is active"],
    ],
  },
  {
    type: "p",
    text: "ALB exposes an idle timeout that defaults to 60 seconds and supports HTTP/2 by default. A backend with a shorter keep-alive timeout will close first; a client with a shorter timeout will also close first from its side. The simulation uses 100–20,000 requests per second across 100–20,000 clients and 1–300 second timeouts. Those values are illustrative, not an ALB limit.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "New connections: the churn rate, with warning at 500/s and critical at 2,000/s.",
      "Request latency estimate: the weighted effect of handshakes on the observed tail.",
      "Timeout spread: the difference between the longest and shortest idle timeout.",
      "Requests per connection: the reuse ratio the client actually achieves.",
      "Effective idle timeout: the shortest peer timeout, which governs the path.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Backend closes first. Compare requests per connection with new connections, then align the timeouts in Recovery. Run the experiment before reading its explanation. The deploy preset shows why draining matters even after timeouts are aligned.",
  },
  {
    type: "compare",
    leftTitle: "Timeout mismatch",
    rightTitle: "Capacity problem",
    rows: [
      { label: "New connections", left: "Near request rate", right: "Scales with traffic, not above it" },
      { label: "Backend CPU", left: "May be low or moderate", right: "High or saturated" },
      { label: "Latency estimate", left: "Handshake-shaped tail", right: "Queue-shaped tail" },
      { label: "Fix", left: "Align timeouts, drain with GOAWAY", right: "Add capacity or reduce work" },
    ],
  },
  { type: "sim", simId: "http2" },
  { type: "experiment", experimentId: "predict-keepalive-timeout" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The backend closed idle connections after two seconds while clients waited about two seconds between requests. Reuse collapsed to one request per connection, so the backend saw roughly 4,000 new connections per second. The request latency estimate rose because each request paid a handshake, even though application processing never changed. The two longer timeouts on the client and load balancer did not help because the shortest peer closed first.",
  },
  {
    type: "p",
    text: "Aligning all three timeouts above the client gap restored reuse and dropped the connection rate. The remaining operational risk is deploy churn: when a backend shuts down, it should send GOAWAY, allow in-flight streams to finish, and let clients reconnect with jitter. Without that, even a correct timeout configuration produces a synchronized reconnect wave.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer: `NewConnectionCount`, `ActiveConnectionCount`, `RejectedConnectionCount`, `TargetConnectionErrorCount`, and `TargetResponseTime`, split by target group.",
      "Backend: accepted connections per second, active connections, keep-alive timeout, and TLS handshakes per second.",
      "HTTP/2: GOAWAY frames, stream resets, and reconnect bursts around deploys.",
      "Clients: connection pool stats, socket errors such as connection reset, and retry counts.",
      "Traces: time to first byte includes a handshake span that the application span does not explain.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare request rate with new-connection rate. If they are close, find the shortest idle timeout across all hops, then check whether a deploy or configuration change introduced it.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure requests per connection at the backend and new connections per second at the load balancer.",
      "Read the idle timeout from every peer, including sidecars and proxies; do not assume the default.",
      "Set backend and load balancer timeouts to the same value above the client think time.",
      "Keep the client timeout at or above the server side so it does not discard a reusable connection.",
      "During deploys, send GOAWAY and drain in-flight streams; jitter client reconnects.",
      "Verify reuse and the latency estimate at peak after the change, and check that idle connections do not exhaust another resource.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer idle timeouts improve reuse but hold memory, file descriptors, and load balancer state.",
      "A very long client timeout can reuse a connection the server has already closed, producing resets.",
      "HTTP/2 reduces handshakes per request but puts all streams on one connection at risk during a close.",
      "Aggressive max-request limits force periodic reconnects and can synchronize clients if not jittered.",
      "Draining with GOAWAY slows deploys slightly but avoids a reconnect storm.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-churn",
    question:
      "The load balancer is healthy, but backends report one new connection per request. How do you find the cause?",
    difficulty: 2,
    hints: [
      "The backend sees churn, not necessarily the client.",
      "The shortest timeout wins.",
    ],
    answer:
      "I would compare request rate with new-connection rate at the backend and load balancer, then check requests per connection. If reuse is near one, I read the idle timeout on every hop: client, load balancer, backend, and any proxy or sidecar. The shortest timeout closes first, so a long backend timeout does not help if the load balancer closes at 30 seconds and clients wait 60. I would also check maximum request limits and whether a deploy or config change introduced the value. Finally, I would verify with a connection-count graph, not just a config diff.",
    followUps: [
      "How would HTTP/2 change the symptoms?",
      "What if timeouts match but churn persists?",
      "Which metric proves reuse improved?",
    ],
    redFlags: [
      "Changes only the backend timeout.",
      "Assumes the load balancer is the cause.",
      "Ignores client think time.",
    ],
    rubric: [
      "Compares request and connection rates.",
      "Checks every hop.",
      "Uses the shortest timeout.",
      "Verifies with a metric.",
    ],
  },
  {
    id: "goaway-drain",
    question:
      "A deploy causes a reconnect storm even though idle timeouts are aligned. What protocol behavior should you use, and how?",
    difficulty: 3,
    hints: [
      "HTTP/2 has an explicit shutdown signal.",
      "Reconnect timing matters as much as the signal.",
    ],
    answer:
      "I would use GOAWAY. The server sends it to tell the client that no new streams will be accepted on that connection and includes the last stream ID it processed, so the client can finish in-flight work and retry only streams that were not processed. The server should keep the connection alive long enough for those streams to complete, then close. Clients should reconnect with jitter and backoff rather than all at once. For HTTP/1.1, the equivalent is to stop accepting new requests, finish the current one, and close with Connection: close.",
    followUps: [
      "What happens to streams above the last stream ID?",
      "How long should the drain window be?",
      "How do you test the reconnect behavior before production?",
    ],
    redFlags: [
      "Closes all connections immediately.",
      "Retries every stream unconditionally.",
      "Ignores client jitter.",
    ],
    rubric: [
      "Names GOAWAY and last stream ID.",
      "Drains in-flight work.",
      "Jitters reconnects.",
      "Mentions HTTP/1.1 equivalent.",
    ],
  },
  {
    id: "timeout-selection",
    question:
      "How do you choose an idle timeout for a service with bursty traffic and long-lived clients?",
    difficulty: 3,
    hints: [
      "Start from the client think time distribution.",
      "Balance reuse against held state.",
    ],
    answer:
      "I would start from the distribution of gaps between requests per client, not the average. The timeout should cover the common gaps so most requests reuse a connection, while not holding idle state for clients that have gone away. Then I would align the backend and load balancer values and keep the client at or above them. I would size the connection table and file descriptors for the resulting idle connection count, and check that a deploy can drain within the timeout. If traffic is very bursty, a shorter timeout with a connection pool may be better than holding thousands of idle connections.",
    followUps: [
      "What percentile of the gap distribution would you use?",
      "How does this interact with NAT or conntrack timeouts?",
      "What would make you choose a shorter timeout?",
    ],
    redFlags: [
      "Picks a round number without measuring gaps.",
      "Sets client shorter than server.",
      "Ignores held connection cost.",
    ],
    rubric: [
      "Uses the gap distribution.",
      "Aligns peers.",
      "Sizes held state.",
      "Considers deploy drain.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Idle timeouts are documented for client, load balancer, backend, and any proxy.",
      "Requests per connection and new connections per second are graphed together.",
      "The backend sends GOAWAY on shutdown and drains in-flight streams.",
      "Client reconnect logic uses jitter and backoff.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare request rate with new-connection rate before changing capacity.",
      "Find the shortest idle timeout in the path.",
      "Check for a recent deploy, config change, or sidecar rollout.",
      "Watch for reconnect waves after the change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify reuse and the latency estimate at peak, not only in a test environment.",
      "Reconcile timeout configuration across all hops.",
      "Load-test a deploy with GOAWAY and jittered reconnects.",
      "Document the chosen timeout and the connection-state cost.",
    ],
  },
];

const references = [
  {
    title: "RFC 9113: HTTP/2",
    url: "https://www.rfc-editor.org/rfc/rfc9113",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Connection reuse, streams, and GOAWAY.",
  },
  {
    title: "Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Idle timeout default, client keepalive, and HTTP/2 listener behavior.",
  },
  {
    title: "RFC 9110: HTTP Semantics",
    url: "https://www.rfc-editor.org/rfc/rfc9110",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Persistent connections and connection management semantics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    http2: {
      model: http2Model,
      presets,
      instructions:
        "Start healthy, shorten one peer's timeout, then align all three. Watch requests per connection and new connections per second, not just request latency.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Timeout values are teaching values, not an ALB configuration.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-tls-handshake",
    "case-composite-http2-goaway",
    "traffic-l4-vs-l7",
  ],
};
