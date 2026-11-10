import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CORES = 8;
const APP_MS = 25;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 100,
    max: 50_000,
    step: 100,
    value: 5_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second. Connections are opened only when a request does not find a reusable one.",
    format: "rps" as const,
  },
  {
    id: "keepAliveRequests",
    label: "Requests per connection",
    min: 1,
    max: 100,
    step: 1,
    value: 20,
    unit: " req",
    group: "Reuse",
    help: "How many requests a client sends on one connection before closing or reconnecting.",
    format: "count" as const,
  },
  {
    id: "rttMs",
    label: "Round-trip time",
    min: 5,
    max: 200,
    step: 5,
    value: 40,
    unit: " ms",
    group: "Network",
    help: "One network round trip between client and edge. TCP and TLS each add at least one round trip before data.",
    format: "ms" as const,
  },
  {
    id: "resumptionHitRate",
    label: "Session resumption",
    min: 0,
    max: 95,
    step: 5,
    value: 0,
    unit: "%",
    group: "Reuse",
    help: "Share of connections that present a valid session ticket. Resumption saves certificate and key work, not the TCP round trip.",
    format: "percent" as const,
  },
  {
    id: "handshakeCpuMs",
    label: "Handshake CPU",
    min: 0.2,
    max: 5,
    step: 0.2,
    value: 2,
    unit: " ms",
    group: "Capacity",
    help: "CPU time for one full handshake on one core. Resumed handshakes use a fraction of this.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  newConnections: number;
  fullShare: number;
  resumedShare: number;
  fullHandshakeMs: number;
  resumedHandshakeMs: number;
  averageHandshakeMs: number;
  handshakeP99: number;
  cpuUtilization: number;
  cpuDemand: number;
  queueMs: number;
  cpuPerSecond: number;
}

function compute(p: Params): Computed {
  const requestRate = num(p, "requestRate", 5_000);
  const keepAlive = Math.max(1, num(p, "keepAliveRequests", 20));
  const rtt = num(p, "rttMs", 40);
  const resumedShare = Math.min(0.95, Math.max(0, num(p, "resumptionHitRate", 0) / 100));
  const handshakeCpuMs = num(p, "handshakeCpuMs", 2);
  const newConnections = requestRate / keepAlive;

  const fullHandshakeMs = 2 * rtt + 4 * handshakeCpuMs;
  const resumedHandshakeMs = 2 * rtt + 1.5 * handshakeCpuMs;
  const averageHandshakeMs =
    resumedShare * resumedHandshakeMs + (1 - resumedShare) * fullHandshakeMs;
  const cpuPerSecond = newConnections * ((1 - resumedShare) * handshakeCpuMs + resumedShare * handshakeCpuMs * 0.35) / 1_000;
  const cpuDemand = Math.min(1_000, (cpuPerSecond / CORES) * 100);
  const cpuUtilization = Math.min(100, cpuDemand);
  const queueMs = cpuDemand > 100 ? fullHandshakeMs * ((cpuDemand - 100) / 100) * 0.5 : 0;
  return {
    requestRate,
    newConnections,
    fullShare: 1 - resumedShare,
    resumedShare,
    fullHandshakeMs,
    resumedHandshakeMs,
    averageHandshakeMs,
    handshakeP99: fullHandshakeMs + queueMs,
    cpuUtilization,
    cpuDemand,
    queueMs,
    cpuPerSecond,
  };
}

function healthFor(utilization: number): "ok" | "warn" | "crit" {
  if (utilization >= 90) return "crit";
  if (utilization >= 70) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const cpuHealth = healthFor(values.cpuDemand);
  const connHealth = values.newConnections >= 15_000 ? "crit" : values.newConnections >= 5_000 ? "warn" : "ok";
  const latencyHealth = values.handshakeP99 >= 250 ? "crit" : values.handshakeP99 >= 100 ? "warn" : "ok";
  const health = cpuHealth === "crit" || connHealth === "crit" || latencyHealth === "crit" ? "crit" : cpuHealth !== "ok" ? cpuHealth : connHealth !== "ok" ? connHealth : latencyHealth;
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: connHealth,
        sublabel: `${Math.round(values.newConnections).toLocaleString()} handshakes/s`,
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "TLS edge",
        kind: "lb",
        health,
        utilization: clamp(values.cpuUtilization / 100),
        throughput: values.newConnections,
        sublabel: `${values.cpuUtilization.toFixed(0)}% CPU, ${values.cpuDemand.toFixed(0)}% demand`,
        detail: `Terminates TLS. A full TCP and TLS 1.3 handshake before the first request costs two round trips plus asymmetric crypto work. Above 100% CPU demand, handshakes queue before the server can process them.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Origin service",
        kind: "service",
        health: "ok",
        utilization: clamp(values.requestRate / 50_000),
        throughput: values.requestRate,
        sublabel: `${Math.round(values.requestRate).toLocaleString()} rps`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", clamp(values.newConnections / 20_000), connHealth),
      edge("edge-service", "edge", "service", clamp(values.requestRate / 50_000)),
    ],
    metrics: [
      metric("handshake-cpu", "TLS handshake CPU", values.cpuUtilization, "%", 70, 90, "percent"),
      metric("handshake-demand", "Handshake CPU demand", values.cpuDemand, "%", undefined, undefined, "percent"),
      metric("new-connections", "New connections", values.newConnections, " conn/s", 5_000, 15_000, "rps"),
      metric("handshake-p99", "Handshake p99", values.handshakeP99, "ms", 100, 250, "ms"),
      metric("handshake-average", "Average handshake", values.averageHandshakeMs, "ms", undefined, undefined, "ms"),
      metric("resumed-share", "Resumed handshakes", values.resumedShare * 100, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p) },
    summary: `${values.cpuUtilization.toFixed(0)}% handshake CPU (${values.cpuDemand.toFixed(0)}% demand); ${Math.round(values.newConnections).toLocaleString()} new connections/s; p99 ${values.handshakeP99.toFixed(0)}ms.`,
  };
  const jitter = (offset: number) => 0.97 + 0.05 * Math.sin((offset + (seed % 13)) / 3.4);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 20 }, (_, index) =>
      Math.max(0, item.value * jitter(index + item.id.length)),
    );
  }
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "handshake-cpu",
    metricId: "handshake-cpu",
    warn: 70,
    crit: 90,
    title: "TLS handshake CPU is saturating the edge",
    cause:
      "New connections per second multiplied by asymmetric crypto work exceed the CPU budget. Short keep-alive, reconnects, or a client fleet that opens a connection per request all raise the handshake count. Demand above 100% queues handshakes and raises p99.",
    fix:
      "Reduce handshake frequency with connection reuse and session resumption, then add edge capacity. Raising CPU without reducing handshakes moves the cost to the bill.",
    checkFirst: [
      "Graph new connections per second, not total requests.",
      "Check the ratio of full to resumed handshakes.",
      "Check whether a deploy or DNS change moved clients to a new edge.",
    ],
  },
  {
    id: "new-connections",
    metricId: "new-connections",
    warn: 5_000,
    crit: 15_000,
    title: "The client fleet is opening a connection per request",
    cause:
      "Keep-alive is disabled or too short, or the client closes connections after few requests. Each request then pays a TCP and TLS setup before any application work.",
    fix:
      "Enable HTTP keep-alive on clients and load balancers, align idle timeouts, and verify that the protocol supports reuse. Watch the next hop's timeout, which can still close the connection first.",
    checkFirst: [
      "Compare request rate with new-connection rate.",
      "Check client keep-alive settings and the idle timeout on each hop.",
      "Check for connection churn after a deploy or DNS change.",
    ],
  },
  {
    id: "handshake-p99",
    metricId: "handshake-p99",
    warn: 100,
    crit: 250,
    title: "Handshake latency dominates the tail",
    cause:
      "Each full handshake needs one TCP round trip and one TLS 1.3 round trip before the request can start. A larger RTT, a farther edge, or an extra certificate fetch adds directly to p99.",
    fix:
      "Measure TCP, TLS, and application phases separately. Move the edge closer, reuse connections, enable OCSP stapling, and resume sessions where the client supports it.",
    checkFirst: [
      "Check whether p99 is dominated by new connections or by slow requests on reused ones.",
      "Compare RTT from the client region to the edge.",
      "Check certificate chain size, OCSP stapling, and TLS version.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const tlsModel: SimModel = {
  id: "foundations-tls-handshake",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    const values = compute(p);
    next.t = frame.t;
    next.flags = { ...frame.flags, ...next.flags };
    const jitter = rng.between(-0.5, 0.5);
    next.metrics = next.metrics.map((item) =>
      item.id === "handshake-p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (values.newConnections >= 5_000 && frame.flags.churnWarned !== 1) {
      pushEvent(next, {
        id: "tls-connection-churn",
        at: frame.t,
        severity: "warn",
        title: "Handshake rate is high relative to request rate",
        detail: `${Math.round(values.newConnections).toLocaleString()} new connections per second for ${Math.round(values.requestRate).toLocaleString()} requests. Each full handshake adds two round trips before the request.`,
        nodeId: "edge",
        metricId: "new-connections",
      });
      next.flags.churnWarned = 1;
    }
    if (values.newConnections < 4_000) next.flags.churnWarned = 0;
    next.events = [...frame.events, ...next.events].slice(-60);
    next.summary = `${values.cpuUtilization.toFixed(0)}% handshake CPU (${values.cpuDemand.toFixed(0)}% demand); ${Math.round(values.newConnections).toLocaleString()} new connections/s; p99 ${values.handshakeP99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The fleet opens ${Math.round(values.newConnections).toLocaleString()} connections per second, ${(values.requestRate / Math.max(1, values.newConnections)).toFixed(1)} requests per connection.`,
    );
    items.push(
      `A full handshake costs about ${values.fullHandshakeMs.toFixed(0)}ms (TCP plus TLS 1.3 round trips and crypto); the application adds about ${APP_MS}ms after that.`,
    );
    if (values.resumedShare > 0) {
      items.push(
        `${Math.round(values.resumedShare * 100)}% of handshakes resume, cutting certificate and key work but not the TCP round trip.`,
      );
    } else {
      items.push("No sessions are resumed, so every new connection pays full certificate and key work.");
    }
    if (values.cpuUtilization >= 70) {
      items.push(
        `Handshake CPU demand is ${values.cpuDemand.toFixed(0)}%; displayed utilization is capped at ${values.cpuUtilization.toFixed(0)}%, and demand above 100% adds ${values.queueMs.toFixed(0)}ms of queue delay to p99.`,
      );
    }
    items.push(
      "A 0-RTT resumed connection can remove a round trip, but early data has replay risk and is not a default fix.",
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
    description: "Requests reuse connections and handshake CPU is low.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Five requests per connection at high traffic. CPU is the first limit.",
    tone: "warn",
    params: defaults({ requestRate: 15_000, keepAliveRequests: 5 }),
  },
  {
    id: "failure",
    label: "Connection per request",
    description: "Keep-alive is off at 20k rps; every request pays for a full handshake.",
    tone: "crit",
    params: defaults({ requestRate: 20_000, keepAliveRequests: 1, resumptionHitRate: 0 }),
  },
  {
    id: "far-edge",
    label: "Far edge",
    description: "RTT jumps after a DNS change. CPU is fine but handshake p99 breaches the SLO.",
    tone: "crit",
    params: defaults({ requestRate: 5_000, keepAliveRequests: 20, rttMs: 140, resumptionHitRate: 30 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Keep-alive restored, most sessions resumed, and the edge is close again.",
    tone: "ok",
    params: defaults({ requestRate: 8_000, keepAliveRequests: 25, rttMs: 40, resumptionHitRate: 80 }),
  },
];

const experiment: Experiment = {
  id: "predict-handshake-fix",
  title: "Which change removes the most handshake cost?",
  simId: "tls",
  question:
    "At 15,000 requests per second with five requests per connection, handshake CPU is the bottleneck. Which single change reduces total handshake CPU the most?",
  prediction: {
    options: [
      { id: "keepalive", label: "Raise requests per connection from 5 to 40" },
      { id: "resumption", label: "Raise session resumption from 0% to 80%" },
      { id: "rtt", label: "Reduce the network round-trip time" },
      { id: "cpu", label: "Move to a larger edge instance" },
    ],
    correctOptionId: "keepalive",
    explanation:
      "Total handshake CPU is handshakes per second multiplied by CPU per handshake. Raising requests per connection from 5 to 40 cuts the handshake count by eight. Resumption reduces CPU per handshake but leaves the count unchanged, so it helps less. A larger instance adds capacity without changing the work.",
  },
  setup: defaults({ requestRate: 15_000, keepAliveRequests: 5, resumptionHitRate: 0 }),
  runFor: 20,
  observe: [
    "New connections settle at 3,000 per second and handshake CPU sits near 75%.",
    "Raising keep-alive to 40 drops new connections to 375 per second.",
    "Resumption at the original keep-alive lowers CPU per handshake but leaves the count at 3,000.",
    "Handshake p99 stays tied to RTT; reuse reduces how often the tail is paid, not the per-handshake round trips.",
  ],
  explain:
    "The handshake count is the request rate divided by requests per connection. CPU is the count times the work per handshake. Keep-alive attacks the count; resumption attacks the per-handshake work. At five requests per connection, an eightfold reuse improvement is larger than the roughly threefold crypto saving from resumption. The best production answer usually combines both, then checks the next hop's idle timeout.",
  fix: defaults({ requestRate: 15_000, keepAliveRequests: 40, resumptionHitRate: 80 }),
  debrief:
    "The combined fix cuts handshake CPU below 5% while keeping p99 latency unchanged per handshake. The tradeoff is that long-lived connections hold state on the edge and clients, and an idle timeout mismatch can still force reconnects. Resumption also requires ticket key management and a client that supports it.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Transport Layer Security (TLS) handshake establishes keys before the first application byte. With TLS 1.3, the client first completes a Transmission Control Protocol (TCP) handshake, then sends a ClientHello and receives a ServerHello and certificate, then both sides derive traffic keys. That is one TCP round trip plus one TLS round trip before the request can start. The client validates the server certificate chain and signature, while the server performs signing and key-exchange work that costs CPU at the edge. Session resumption uses a pre-shared key from an earlier session, so the server can skip most certificate and key work, but TLS 1.3 resumption still needs a round trip. Only 0-RTT early data removes a round trip, and it introduces replay risk.",
  },
  {
    type: "p",
    text: "The cost therefore has two multipliers: how many handshakes happen and how expensive each one is. Keep-alive controls the first. Resumption controls the second. A service can be healthy on request rate and still saturate its edge if every request opens a connection.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, network, TLS terminator, then origin service. The terminator may be a CDN, an application load balancer, or the service itself. Every new connection pays the handshake on the client side and the crypto cost on the terminator. Requests on a reused connection pay neither. DNS changes matter because they can move clients to a more distant edge or a different terminator with a colder session-ticket cache, raising both RTT and full-handshake share.",
  },
  {
    type: "table",
    headers: ["Mode", "Round trips before data", "Main cost", "When to use"],
    rows: [
      ["TCP + TLS 1.3 full", "Two", "Server signing, key exchange, and client certificate validation", "New client, expired ticket, or key rotation"],
      ["TCP + TLS 1.3 resumed", "Two", "Cheaper key exchange, ticket lookup", "Repeat client with a valid ticket"],
      ["TCP + TLS 1.3 0-RTT", "One", "Replay risk for early data", "Idempotent requests where the risk is accepted"],
      ["Reused connection", "Zero new handshakes", "Connection state held on both sides", "Steady request traffic"],
    ],
  },
  {
    type: "p",
    text: "The simulation models a TLS edge at 100–50,000 requests per second with 1–100 requests per connection. Handshake CPU and latency values are illustrative teaching values, not a benchmark for a particular terminator. The shape is the lesson: connections per second drive CPU, RTT drives per-handshake latency, and reuse removes both from the steady state.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "TLS handshake CPU: displayed utilization capped at 100%, with raw demand shown separately so an overloaded edge is still visible.",
      "New connections: handshakes per second, the multiplier that keep-alive controls.",
      "Handshake p99: the full TCP plus TLS cost for the slowest new connections.",
      "Average handshake: the blend of full and resumed connections.",
      "Resumed share: how much of the handshake work is avoided by session tickets.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Connection per request and watch CPU rise while request rate is unchanged. Apply Far edge to see latency rise without CPU pressure. Run the guided experiment before reading its explanation, then apply Recovery.",
  },
  {
    type: "compare",
    leftTitle: "Handshake problem",
    rightTitle: "Application problem",
    rows: [
      { label: "New connections", left: "Rises with request rate", right: "Normal for the traffic" },
      { label: "CPU", left: "Edge CPU tracks connection rate", right: "Service CPU tracks request work" },
      { label: "Latency", left: "p99 includes TCP and TLS setup", right: "Slow span is inside the service" },
      { label: "Fix", left: "Reuse, resume, move edge closer", right: "Profile the application path" },
    ],
  },
  { type: "sim", simId: "tls" },
  { type: "experiment", experimentId: "predict-handshake-fix" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With one request per connection, every request paid a TCP and TLS handshake before the application saw it. Edge CPU rose with connection count, not with request count, and p99 included two round trips plus certificate work. Session resumption lowered the crypto per handshake, but it did not reduce the number of handshakes, so it could not recover the saturated edge on its own.",
  },
  {
    type: "p",
    text: "The recovery raised requests per connection and enabled resumption. Handshake count fell by an order of magnitude and CPU returned to a small fraction of the edge budget. The per-handshake latency stayed tied to RTT, so the far-edge preset still breached p99 until the edge was closer. That separates the two costs: frequency and distance.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer: `NewConnectionCount`, `ActiveConnectionCount`, `TargetConnectionErrorCount`, and TLS negotiation errors, split by listener.",
      "CDN or edge: TLS handshake time, resumed versus full handshakes, certificate chain size, and OCSP stapling status.",
      "Service: request latency with a separate TLS or connection-setup span; if the span exists before the application span, the handshake is the cost.",
      "Client: connection reuse metrics, DNS resolution time, and reconnect counts after deploys or DNS changes.",
      "Kernel or proxy: SYN backlog, accept queue, and CPU by TLS operation.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare new-connection rate with request rate. If they are close, every request is paying a handshake. Then compare RTT and handshake p99 from the affected region before changing TLS settings.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Split the request into DNS, TCP, TLS, and application phases so you know which one moved.",
      "Enable or extend keep-alive on clients and align idle timeouts across every hop.",
      "Enable session tickets and verify the resumed share rises; rotate ticket keys on a schedule.",
      "Enable Online Certificate Status Protocol (OCSP) stapling and keep the certificate chain short to reduce handshake bytes and extra fetches.",
      "Move the terminator closer or use a regional edge when RTT, not CPU, is the limit.",
      "Re-test at peak and confirm connection count, CPU, and p99 together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Long keep-alive reduces handshakes but holds connection state and can outlive a deploy or a load balancer's idle timeout.",
      "Session resumption reduces CPU but requires ticket key management and weakens forward secrecy if tickets are not rotated.",
      "0-RTT saves a round trip but allows replay of early data; use it only for safe, idempotent requests.",
      "A closer edge reduces RTT but adds points of presence, certificate distribution, and cost.",
      "Disabling older TLS versions improves security but can force some clients into full handshakes or failures.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "separate-tls",
    question:
      "p99 latency rose after a DNS change. How do you determine whether TLS or the application is responsible?",
    difficulty: 2,
    hints: [
      "Compare the phases before the first byte.",
      "New-connection rate tells you whether the tail is paying handshakes.",
    ],
    answer:
      "I would split the request into DNS, TCP connect, TLS handshake, time to first byte, and application time. If TLS handshake time rose while the application span is unchanged, TLS is the cost. I would then compare new-connection rate with request rate: if they are close, clients are not reusing connections and every request pays the handshake. I would also compare RTT from the affected region and check whether the DNS change moved clients to a more distant edge or a terminator with a colder ticket cache. That distinguishes distance from churn.",
    followUps: [
      "What if p99 rose but the mean did not?",
      "How would session resumption change the picture?",
      "Which metric would you put on the incident dashboard?",
    ],
    redFlags: [
      "Blames TLS without phase data.",
      "Looks only at CPU.",
      "Ignores the new-connection rate.",
    ],
    rubric: [
      "Separates handshake from application time.",
      "Checks connection reuse.",
      "Considers RTT and edge placement.",
      "States a falsifying check.",
    ],
  },
  {
    id: "resumption-limits",
    question:
      "Does TLS session resumption remove a round trip? Explain what it saves and what it does not.",
    difficulty: 3,
    hints: [
      "TLS 1.3 resumption still performs a handshake.",
      "0-RTT is a separate mode with its own risk.",
    ],
    answer:
      "With TLS 1.3, resumption still uses a one-round-trip handshake, so it does not remove the TLS round trip. It saves certificate exchange and most asymmetric key work because the client and server use a pre-shared key from an earlier session. 0-RTT early data can remove a round trip, but the server must accept replay risk for that data, so it is appropriate only for idempotent operations. Resumption also depends on ticket lifetime and key rotation, so a client with an expired ticket falls back to a full handshake.",
    followUps: [
      "What happens when the ticket key rotates?",
      "How does resumption affect forward secrecy?",
      "When would you enable 0-RTT?",
    ],
    redFlags: [
      "Says resumption always removes a round trip.",
      "Ignores ticket lifetime.",
      "Treats 0-RTT as free.",
    ],
    rubric: [
      "Distinguishes resumption from 0-RTT.",
      "Names CPU and certificate savings.",
      "Mentions replay and key rotation.",
    ],
  },
  {
    id: "handshake-capacity",
    question:
      "You must support 20,000 requests per second with a 40ms RTT. How do you decide between more edge CPU, keep-alive, and resumption?",
    difficulty: 4,
    hints: [
      "Compute handshakes per second first.",
      "Separate frequency from per-handshake cost.",
    ],
    answer:
      "I would start from connections per second, which is request rate divided by requests per connection. At one request per connection, that is 20,000 handshakes per second; at 20, it is 1,000. Then I estimate CPU as handshakes multiplied by CPU per handshake, and latency as two round trips plus crypto for a full TLS 1.3 handshake. Keep-alive is usually the largest lever because it divides the count. Resumption reduces CPU per handshake by skipping certificate and key work, but it does not change the count or the round trips. More CPU only absorbs the work. I would combine keep-alive and resumption, verify the idle timeout on every hop, and keep 0-RTT for idempotent traffic only.",
    followUps: [
      "What breaks if the load balancer idle timeout is shorter than the client's?",
      "How do you measure CPU per handshake?",
      "What is the risk of very long keep-alive?",
    ],
    redFlags: [
      "Sizes CPU from request rate alone.",
      "Assumes resumption removes the round trip.",
      "Ignores idle timeout alignment.",
    ],
    rubric: [
      "Computes handshake rate.",
      "Separates frequency and per-handshake cost.",
      "Aligns timeouts.",
      "States the remaining tradeoff.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards separate DNS, TCP, TLS, and application latency.",
      "New-connection rate is graphed next to request rate.",
      "Keep-alive and idle timeouts are aligned across client, CDN, load balancer, and service.",
      "Session ticket keys are rotated and the resumed share is monitored.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the tail is paying handshakes or waiting in the application.",
      "Check RTT and edge placement for the affected client regions.",
      "Reduce handshake frequency first, then per-handshake work.",
      "Check certificate chain, OCSP stapling, and TLS version for errors.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify connection rate, CPU, and p99 at peak.",
      "Reconcile keep-alive settings with the shortest idle timeout in the path.",
      "Test resumption after a ticket key rotation.",
      "Document the RTT and region assumptions used for capacity.",
    ],
  },
];

const references = [
  {
    title: "RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3",
    url: "https://www.rfc-editor.org/rfc/rfc8446",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Handshake flows, resumption, and 0-RTT early data.",
  },
  {
    title: "What happens in a TLS handshake?",
    url: "https://www.cloudflare.com/learning/ssl/what-happens-in-a-tls-handshake/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Round trips, certificate validation, and session resumption.",
  },
  {
    title: "SSL/TLS certificate and handshake concepts",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/https-listener-certificates.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Certificate selection and TLS listener behavior on ALB.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    tls: {
      model: tlsModel,
      presets,
      instructions:
        "Start healthy, remove keep-alive, then add resumption. Compare connection count, handshake CPU, and p99 separately; they answer different questions.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Handshake CPU values are teaching values, not a TLS terminator benchmark.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-tls-termination",
    "foundations-http2-keepalive",
    "observability-synthetic-monitoring",
  ],
};
