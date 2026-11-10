import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUESTS_PER_CONNECTION = 20;
const EDGE_HANDSHAKE_CAPACITY = 12_000;
const LB_HANDSHAKE_CAPACITY = 4_000;
const SERVICE_PODS = 12;
const POD_HANDSHAKE_CAPACITY = 600;
const SERVICE_HANDSHAKE_CAPACITY = SERVICE_PODS * POD_HANDSHAKE_CAPACITY;
const BASE_MS = 25;
const RTT_MS = 30;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 500,
    max: 50_000,
    step: 500,
    value: 5_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second. New connections are a fraction of this, set by the illustrative reuse value.",
    format: "rps" as const,
  },
  {
    id: "terminationLayer",
    label: "Termination layer (0 edge, 1 load balancer, 2 service)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "TLS",
    help: "Where the client-facing TLS session ends. Only a terminator that sees HTTP can route by path or inspect Layer 7.",
    format: "count" as const,
  },
  {
    id: "reencrypt",
    label: "Re-encrypt after termination (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "TLS",
    help: "Open a new TLS session toward the service. Ignored when TLS terminates at the service, where there is no earlier terminator to re-encrypt from.",
    format: "count" as const,
  },
  {
    id: "inspect",
    label: "Layer 7 inspection at load balancer (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Control",
    help: "Inspect HTTP headers and paths at the load balancer. Ignored when TLS terminates at the service: a passthrough balancer never sees HTTP.",
    format: "count" as const,
  },
  {
    id: "mtls",
    label: "mTLS to the service (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Identity",
    help: "Require a client certificate at the service. It needs TLS that reaches the service, either passthrough or re-encryption.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  term: number;
  reencrypt: boolean;
  plaintextHops: number;
  uninspected: number;
  mtlsRequested: boolean;
  mtlsActive: boolean;
  mtlsShortfall: number;
  keyLocations: number;
  newConnections: number;
  edgeUtil: number;
  lbUtil: number;
  serviceUtil: number;
  cpuDemand: number;
  cpuUtil: number;
  p99: number;
  certificateScope: string;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 5_000));
  const term = Math.round(Math.min(2, Math.max(0, num(p, "terminationLayer", 1))));
  const reencrypt = num(p, "reencrypt", 1) >= 0.5;
  const inspect = num(p, "inspect", 1) >= 0.5;
  const mtlsRequested = num(p, "mtls", 0) >= 0.5;
  const newConnections = requestRate / REQUESTS_PER_CONNECTION;

  const plaintextHops = term === 2 ? 0 : term === 1 ? (reencrypt ? 0 : 1) : reencrypt ? 0 : 2;
  const uninspected = inspect && term !== 2 ? 0 : 100;
  const mtlsActive = mtlsRequested && (term === 2 || reencrypt);
  const mtlsShortfall = mtlsRequested && !mtlsActive ? 100 : 0;
  const keyLocations = term === 0 ? (reencrypt ? 3 : 1) : term === 1 ? (reencrypt ? 2 : 1) : 1;

  const edgeHandshakes = term === 0 ? newConnections : 0;
  const lbHandshakes =
    term === 0 ? (reencrypt ? newConnections * 2 : 0) : term === 1 ? newConnections * (reencrypt ? 2 : 1) : 0;
  const serviceHandshakes = term === 2 || reencrypt ? newConnections : 0;

  const edgeUtil = (edgeHandshakes / EDGE_HANDSHAKE_CAPACITY) * 100;
  const lbUtil = (lbHandshakes / LB_HANDSHAKE_CAPACITY) * 100;
  const serviceUtil = (serviceHandshakes / SERVICE_HANDSHAKE_CAPACITY) * 100;
  const cpuDemand = Math.max(edgeUtil, lbUtil, serviceUtil);
  const cpuUtil = Math.min(100, cpuDemand);

  const hopMs = term === 0 ? 9 : term === 1 ? 6 : 3;
  const tlsHops = term === 0 ? (reencrypt ? 3 : 1) : term === 1 ? (reencrypt ? 2 : 1) : 1;
  const amortizedHandshakeMs = tlsHops * (newConnections / requestRate) * 2 * RTT_MS;
  const queueMs = cpuDemand > 100 ? Math.min(1_200, (cpuDemand - 100) * 3) : 0;
  const p99 = BASE_MS + hopMs + amortizedHandshakeMs + queueMs;

  const certificateScope =
    term === 0
      ? "Public certificate at the edge"
      : term === 1
        ? "Public certificate at the load balancer"
        : "Public certificate at the service";

  return {
    requestRate,
    term,
    reencrypt,
    plaintextHops,
    uninspected,
    mtlsRequested,
    mtlsActive,
    mtlsShortfall,
    keyLocations,
    newConnections,
    edgeUtil,
    lbUtil,
    serviceUtil,
    cpuDemand,
    cpuUtil,
    p99,
    certificateScope,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = compute(p);
  const edgeHealth = d.term === 0 ? healthFor(d.edgeUtil, 75, 90) : "ok";
  const lbHealth =
    d.plaintextHops >= 2
      ? "crit"
      : d.plaintextHops === 1
        ? "warn"
        : d.term === 2
          ? "warn"
          : healthFor(d.lbUtil, 75, 90);
  const serviceHealth =
    d.plaintextHops >= 2 ? "crit" : d.plaintextHops === 1 ? "warn" : healthFor(d.serviceUtil, 75, 90);

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: "ok",
        throughput: d.requestRate,
        sublabel: `${Math.round(d.newConnections).toLocaleString()} new TLS conns/s`,
        detail: "Clients validate the certificate presented by the terminator. What happens after that depends on where the terminator sits.",
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "Edge",
        kind: "cdn",
        health: edgeHealth,
        utilization: clamp(d.edgeUtil / 100),
        throughput: d.requestRate,
        sublabel: d.term === 0 ? "TLS terminator" : "TLS passthrough or TLS origin",
        detail:
          d.term === 0
            ? `Terminates client TLS. ${d.reencrypt ? "Re-encrypts toward the load balancer." : "Forwards plaintext HTTP inside the private network."}`
            : "Does not terminate TLS in this configuration. TLS continues to the next terminator.",
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Load balancer",
        kind: "lb",
        health: lbHealth,
        utilization: clamp(d.lbUtil / 100),
        throughput: d.requestRate,
        sublabel: d.term === 1 ? "TLS terminator" : "L7 routing only when it sees HTTP",
        detail: `Routing by path needs HTTP. ${d.term === 2 ? "TLS passthrough means the load balancer cannot read the path or headers." : "TLS ends here, so paths and headers are visible."} ${d.reencrypt ? "A new TLS session is opened to the service." : "Traffic to the service is plaintext in this model."}`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Service",
        kind: "service",
        health: serviceHealth,
        utilization: clamp(d.serviceUtil / 100),
        throughput: d.requestRate,
        sublabel: d.term === 2 ? "TLS terminator" : d.reencrypt ? "TLS origin" : "plaintext listener",
        detail: `Certificate scope: ${d.certificateScope.toLowerCase()}. Private-key locations in this model: ${d.keyLocations}.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", clamp(d.newConnections / 3_000), edgeHealth),
      edge("edge-alb", "edge", "alb", clamp(d.requestRate / 50_000), lbHealth),
      edge("alb-service", "alb", "service", clamp(d.requestRate / 50_000), serviceHealth),
    ],
    metrics: [
      metric("plaintext-hops", "Plaintext internal hops", d.plaintextHops, " hops", 1, 2, "count"),
      metric("uninspected", "Uninspected requests", d.uninspected, "%", 1, 50, "percent"),
      metric("handshake-cpu", "Busiest terminator handshake CPU", d.cpuUtil, "%", 75, 90, "percent"),
      metric("cpu-demand", "Handshake CPU demand", d.cpuDemand, "%", undefined, undefined, "percent"),
      metric("p99", "Request p99", d.p99, "ms", 80, 110, "ms"),
      metric("mtls-shortfall", "Requests missing service mTLS", d.mtlsShortfall, "%", undefined, undefined, "percent"),
      metric("key-locations", "Private-key locations", d.keyLocations, " places", undefined, undefined, "count"),
      metric("new-connections", "New TLS connections", d.newConnections, " conn/s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, paramsKey: JSON.stringify(p), termination: d.term, reencrypt: d.reencrypt ? 1 : 0 },
    summary: `${d.plaintextHops} plaintext internal hop(s); ${d.uninspected}% uninspected; busiest terminator ${d.cpuDemand.toFixed(0)}% handshake CPU; p99 ${d.p99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 7)) / 2.4)) + Math.sin(index / 2.0) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "plaintext-hops",
    metricId: "plaintext-hops",
    warn: 1,
    crit: 2,
    title: "Private traffic is unencrypted past the intended boundary",
    cause:
      "TLS ended at the edge or load balancer and no new TLS session was opened toward the service. The hop that carries request data after the terminator is plaintext.",
    fix:
      "Terminate at the load balancer and re-encrypt to the service, or move termination to the service and route without Layer 7. Choose the boundary first, then prove the hop after it is encrypted.",
    checkFirst: [
      "Trace where the certificate is presented and where the next TLS client starts.",
      "Check the listener protocol on the load balancer and the service, not only the public listener.",
      "Confirm whether path routing and inspection are required; that decides whether passthrough is possible.",
    ],
  },
  {
    id: "uninspected",
    metricId: "uninspected",
    warn: 1,
    crit: 50,
    title: "Requests bypass Layer 7 inspection",
    cause:
      "The load balancer does not see HTTP in this path. TLS passthrough hides paths and headers, and a terminator higher in the path may already have converted the request to plaintext before a second TLS session.",
    fix:
      "Terminate at the load balancer when inspection or path routing is required. If inspection must stay out of the load balancer, move it to a proxy that sees plaintext and document the gap.",
    checkFirst: [
      "Confirm which component terminates the client TLS session.",
      "Check whether the listener is TCP passthrough or HTTP/HTTPS.",
      "Verify that the inspection rule sees the request path, not just the SNI hostname.",
    ],
  },
  {
    id: "handshake-cpu",
    metricId: "handshake-cpu",
    warn: 75,
    crit: 90,
    title: "The terminating tier is spending its CPU on handshakes",
    cause:
      "New TLS connections concentrate on one tier. Re-encryption adds a second handshake for every new connection, and a low reuse rate multiplies both.",
    fix:
      "Reduce new connections with keep-alive and session resumption, spread termination across more capacity, or terminate at the service tier where handshakes distribute across pods.",
    checkFirst: [
      "Compare new connections per second with request rate.",
      "Check whether re-encryption doubled the handshake count at the load balancer.",
      "Check CPU per handshake and the resumed-session share before adding instances.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 80,
    crit: 110,
    title: "Termination and re-encryption are showing up in the tail",
    cause:
      "Each TLS hop adds a handshake to new connections. When handshake demand exceeds the terminator budget, setup work queues ahead of the request.",
    fix:
      "Reduce handshake frequency, add capacity at the busy tier, and check whether the extra hop is buying a control you actually need.",
    checkFirst: [
      "Split p99 into TCP, TLS, and application phases.",
      "Check handshake CPU at the busiest terminator.",
      "Compare the same route with and without re-encryption.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const tlsTerminationModel: SimModel = {
  id: "traffic-tls-termination",
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

    if (d.plaintextHops > 0 && next.flags.plaintextWarned !== 1) {
      pushEvent(next, {
        id: "private-plaintext",
        at: frame.t,
        severity: d.plaintextHops >= 2 ? "crit" : "warn",
        title: d.plaintextHops >= 2 ? "Private traffic is plaintext after termination" : "One private hop is plaintext",
        detail: `TLS terminates at ${d.term === 0 ? "the edge" : "the load balancer"} and is not re-established toward the service. ${d.plaintextHops} internal hop(s) carry plaintext request data.`,
        nodeId: "service",
        metricId: "plaintext-hops",
      });
      next.flags.plaintextWarned = 1;
    }
    if (d.plaintextHops === 0) next.flags.plaintextWarned = 0;

    if (d.uninspected > 0 && next.flags.inspectionWarned !== 1) {
      pushEvent(next, {
        id: "inspection-gap",
        at: frame.t,
        severity: d.uninspected >= 50 ? "crit" : "warn",
        title: "Layer 7 inspection is not covering this traffic",
        detail: `The load balancer cannot see HTTP for ${d.uninspected}% of requests. TLS is terminated at the ${d.term === 2 ? "service" : "edge"} and not re-originated as an inspectable HTTP request at the load balancer.`,
        nodeId: "alb",
        metricId: "uninspected",
      });
      next.flags.inspectionWarned = 1;
    }
    if (d.uninspected === 0) next.flags.inspectionWarned = 0;

    if (d.mtlsShortfall > 0 && next.flags.mtlsWarned !== 1) {
      pushEvent(next, {
        id: "mtls-gap",
        at: frame.t,
        severity: "warn",
        title: "mTLS was requested but cannot reach the service",
        detail:
          "The client certificate ends at the terminator and no TLS session carries it to the service. Terminate at the service or re-encrypt and configure the service to verify the certificate.",
        nodeId: "service",
        metricId: "mtls-shortfall",
      });
      next.flags.mtlsWarned = 1;
    }
    if (d.mtlsShortfall === 0) next.flags.mtlsWarned = 0;

    const previousTermination = Number(frame.flags.termination ?? d.term);
    if (d.term !== previousTermination) {
      pushEvent(next, {
        id: "termination-change",
        at: frame.t,
        severity: "info",
        title: `TLS termination moved to the ${d.term === 0 ? "edge" : d.term === 1 ? "load balancer" : "service"}`,
        detail: `Certificate scope is now: ${d.certificateScope.toLowerCase()}. Private keys live in ${d.keyLocations} place(s) in this model.`,
        nodeId: d.term === 0 ? "edge" : d.term === 1 ? "alb" : "service",
      });
    }

    next.summary = `${d.plaintextHops} plaintext internal hop(s); ${d.uninspected}% uninspected; busiest terminator ${d.cpuDemand.toFixed(0)}% handshake CPU; p99 ${d.p99.toFixed(0)}ms.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `TLS terminates at the ${d.term === 0 ? "edge" : d.term === 1 ? "load balancer" : "service"}; ${d.keyLocations} place(s) hold a private key in this model.`,
    );
    items.push(
      d.plaintextHops === 0
        ? "Every internal hop after the terminator is encrypted."
        : `${d.plaintextHops} internal hop(s) carry plaintext after termination; that is the boundary the model is testing.`,
    );
    items.push(
      d.uninspected === 0
        ? "The load balancer sees HTTP and can apply path rules and Layer 7 inspection."
        : `${d.uninspected}% of requests bypass load balancer inspection because it does not see HTTP for them.`,
    );
    if (d.reencrypt && d.term !== 2) {
      items.push(
        `Re-encryption adds a second TLS handshake per new connection; the load balancer is at ${d.lbUtil.toFixed(0)}% of its illustrative handshake budget.`,
      );
    }
    if (d.mtlsRequested) {
      items.push(
        d.mtlsActive
          ? "mTLS reaches the service, so the service verifies the certificate on that session; forward the original client identity separately when it must survive termination."
          : "mTLS stops at the terminator; the service cannot verify a client certificate in this configuration.",
      );
    }
    if (d.term === 2) {
      items.push("Service termination gives the strongest key boundary but removes path routing and inspection at the load balancer.");
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
    label: "Healthy",
    description: "TLS terminates at the load balancer and is re-encrypted to the service; inspection is on.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High traffic with re-encryption and mTLS. Handshake CPU reaches the warning line.",
    tone: "warn",
    params: defaults({ requestRate: 30_000, terminationLayer: 1, reencrypt: 1, inspect: 1, mtls: 1 }),
  },
  {
    id: "failure",
    label: "Plaintext past the edge",
    description: "The edge terminates TLS and forwards plaintext through the load balancer to the service; inspection is off.",
    tone: "crit",
    params: defaults({ requestRate: 10_000, terminationLayer: 0, reencrypt: 0, inspect: 0, mtls: 0 }),
  },
  {
    id: "edge-reencrypt",
    label: "Edge plus re-encryption",
    description: "The edge terminates and re-encrypts, and the load balancer re-encrypts again. Encrypted, with three key locations.",
    tone: "ok",
    params: defaults({ requestRate: 12_000, terminationLayer: 0, reencrypt: 1, inspect: 1, mtls: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Load balancer termination with re-encryption and mTLS, below the warning lines.",
    tone: "ok",
    params: defaults({ requestRate: 8_000, terminationLayer: 1, reencrypt: 1, inspect: 1, mtls: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-reencrypt-after-alb",
  title: "Predict what re-encryption changes",
  simId: "tls-termination",
  question:
    "The ALB terminates TLS so it can route by path, and mTLS to the service is required. Re-encryption is off. What does the service see?",
  prediction: {
    options: [
      { id: "plaintext", label: "Plaintext HTTP and no client certificate; the service cannot verify mTLS." },
      { id: "passthrough", label: "The original TLS session passes through, so the service sees the client certificate." },
      { id: "double", label: "Two independent TLS sessions, both ending at the service." },
      { id: "none", label: "The ALB refuses to start because path routing and mTLS cannot coexist." },
    ],
    correctOptionId: "plaintext",
    explanation:
      "The ALB must decrypt to read the path. Once decrypted, the client TLS session is over. Without a new TLS session to the service, the service receives plaintext and cannot verify a client certificate. mTLS to the service requires either passthrough at a Layer 4 balancer or re-encryption that carries a client certificate from the ALB.",
  },
  setup: defaults({ requestRate: 10_000, terminationLayer: 1, reencrypt: 0, inspect: 1, mtls: 1 }),
  runFor: 20,
  observe: [
    "Plaintext internal hops is 1: the ALB-to-service hop.",
    "Requests missing service mTLS is 100%, even though the client used TLS to the ALB.",
    "Inspection coverage stays at 100% because the ALB sees HTTP.",
    "The service health shows a warning; the client sees a normal response.",
  ],
  explain:
    "TLS termination is a boundary, not a property of the whole request. The ALB can inspect and route only after it decrypts, so the client-facing key material ends there. Re-encryption starts a new session with the service; the ALB becomes the TLS client and can present a certificate for mTLS. That is an extra handshake and another key to manage, which is why termination choices are a trade between control and key scope.",
  fix: defaults({ requestRate: 10_000, terminationLayer: 1, reencrypt: 1, inspect: 1, mtls: 1 }),
  debrief:
    "With re-encryption on, the plaintext hop and the mTLS gap both fall to zero. The cost is a second handshake per new connection, another certificate to rotate, and one more place where a private key lives. The ALB is still the path-routing and inspection point; the service now authenticates the ALB rather than the original client unless the certificate is forwarded.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Transport Layer Security (TLS) encrypts a connection between two peers. Termination is the point where the encrypted session ends and the endpoint can read the request. A client always starts TLS with the name in its URL, but the server that finishes the handshake can be a content delivery network (CDN), an Application Load Balancer (ALB), or the service itself. That choice decides who holds the private key, who can read headers and paths, and whether a second TLS session is needed behind the terminator.",
  },
  {
    type: "p",
    text: "Terminating at the edge gives the largest certificate scope and the earliest inspection point, but traffic after the edge must be protected again if it crosses an untrusted boundary. Terminating at the ALB allows path routing, host rules, and Layer 7 inspection close to the service. Terminating at the service gives the service the client identity and the strongest key boundary, but a Layer 4 balancer cannot read the path to route it, and a Layer 7 balancer cannot inspect what it cannot decrypt. These are not security slogans; they are consequences of where the plaintext exists.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, edge, load balancer, service. Each arrow can be plaintext or TLS. Re-encryption means the terminator opens a new TLS session to the next hop; mutual TLS (mTLS) means both ends of that session present certificates. Certificate scope is the set of names a certificate covers and the hops where it is presented, not a count of copies. Private-key locations matter because every terminator that decrypts must hold a key for its session, and every key is an operational and security responsibility.",
  },
  {
    type: "table",
    headers: ["Termination point", "Can route by path", "Can inspect L7", "Key locations", "What breaks first"],
    rows: [
      ["Edge CDN", "Yes, at the edge", "Yes, at the edge", "Edge, and more if re-encrypted", "Plaintext after the edge"],
      ["Load balancer", "Yes", "Yes", "Load balancer, plus service if re-encrypted", "Plaintext load balancer to service"],
      ["Service", "No at a Layer 4 balancer", "No at the balancer", "Service", "Lost routing and inspection controls"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 500–50,000 requests per second, 20 requests per connection as an illustrative reuse value, and teaching capacities for the edge, load balancer, and service pods. Those capacities are not AWS quotas or benchmarks. The shape is the lesson: new connections drive handshakes, a second TLS session doubles the handshake work at the terminator, and the plaintext hop is a boundary decision rather than a capacity decision.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Plaintext internal hops: zero, one, or two hops after the terminator.",
      "Uninspected requests: the share that bypasses Layer 7 inspection because the balancer cannot see HTTP.",
      "Busiest terminator handshake CPU, with raw demand shown separately so an overloaded tier is visible.",
      "Request p99 and new TLS connections, which move together when reuse is low.",
      "Private-key locations and the requests missing service mTLS, which show the identity cost of each design.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Plaintext past the edge and note that the client still sees a successful TLS session. Switch termination to the load balancer with re-encryption off, then turn re-encryption on. Run the guided experiment before revealing its explanation. Use Edge plus re-encryption to compare one terminator with three key locations.",
  },
  {
    type: "compare",
    leftTitle: "Terminate early",
    rightTitle: "Terminate late",
    rows: [
      { label: "Certificate scope", left: "One public certificate at the edge or balancer", right: "Certificate per service, closer to the workload" },
      { label: "Inspection", left: "Central and simple", right: "Requires a proxy that terminates or a passthrough gap" },
      { label: "Private-key exposure", left: "Fewer places, broader blast radius", right: "More places, narrower blast radius" },
      { label: "Latency", left: "One handshake at the edge, optional private handshakes", right: "Handshake cost sits with the service" },
    ],
  },
  { type: "sim", simId: "tls-termination" },
  { type: "experiment", experimentId: "predict-reencrypt-after-alb" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "In the failure preset, the edge finished the client TLS session and forwarded plaintext through the load balancer to the service. The client saw a valid certificate and a successful request, while two internal hops carried request data without encryption. Turning off inspection also removed the only Layer 7 control point that could have noticed the path. The model made the boundary visible as a hop count, not as a user-facing error.",
  },
  {
    type: "p",
    text: "Moving termination to the load balancer restored path routing and inspection, but with re-encryption off one internal hop stayed plaintext and mTLS could not reach the service. Re-encryption removed both gaps at the cost of a second handshake and a second private-key location. Terminating at the service removed the internal plaintext entirely, but a Layer 4 balancer could no longer read the path, so the routing control had to move.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer: listener protocol, certificate ARN, `TargetConnectionErrorCount`, TLS negotiation errors, and target response time.",
      "Service: listener protocol and port, certificate subject, client-certificate verification mode, and handshake CPU.",
      "Edge or CDN: origin protocol, origin certificate validation, and whether the origin connection is TLS or HTTP.",
      "Network: flow logs or packet capture showing the port and protocol on each internal hop; a plaintext hop is visible without decrypting payload.",
      "Identity: mTLS subject or SPIFFE identity at the service, and whether it matches the original client or the load balancer.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Find the certificate that the client validated, then the next listener that accepts the request. If the second listener is HTTP, the hop after the terminator is plaintext. Check the service listener and mTLS mode before changing any timeout or capacity setting.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the required controls: path routing, Layer 7 inspection, client identity at the service, and the trust boundary.",
      "Choose the terminator that can provide those controls; do not add re-encryption to compensate for a routing requirement.",
      "If the balancer must route by path and the service must verify the client, enable re-encryption and configure certificate forwarding or a service mesh identity.",
      "If the service must terminate TLS, move routing to a Layer 4 balancer or to a proxy that can route on connection metadata.",
      "Rotate the certificates at every key location and monitor expiry separately from the public certificate.",
      "Verify with a packet capture or flow log that no unintended plaintext hop remains, then test failover with the new certificate path.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Early termination centralizes certificates and inspection but puts more data and key material at the edge.",
      "Late termination narrows the key boundary but removes path routing and inspection from a Layer 4 balancer.",
      "Re-encryption protects the internal hop and enables mTLS, at the cost of another handshake, another certificate, and another failure domain.",
      "Passthrough keeps the client identity intact but makes the balancer blind to paths and headers.",
      "More key locations reduce blast radius per key but multiply rotation work and the chance of an expired certificate.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-termination",
    question:
      "You need path-based routing at the ALB and the service must verify the client certificate. Where does TLS terminate, and what else is required?",
    difficulty: 3,
    hints: [
      "The ALB cannot read a path it cannot decrypt.",
      "The service needs a TLS session of its own to verify a client certificate.",
    ],
    answer:
      "The ALB terminates the client TLS session so it can read the path and apply listener rules. To keep client identity at the service, the ALB then opens a new TLS session to the service and presents a client certificate, or forwards the original certificate in a trusted header only if the service trusts the ALB. mTLS at the service means the service verifies the certificate on its own TLS session, so passthrough at a Layer 4 balancer is the alternative when path routing is not required. The trade is an extra handshake and a second key location.",
    followUps: [
      "What changes if the service only needs to know the original client IP?",
      "How would a service mesh change the identity path?",
      "Where would you terminate if the edge also needs to inspect?",
    ],
    redFlags: [
      "Says the ALB can forward the original TLS session after terminating it.",
      "Adds mTLS at the ALB and calls it end-to-end.",
      "Ignores the routing requirement.",
    ],
    rubric: [
      "Separates routing from identity.",
      "Names re-encryption or passthrough.",
      "Explains the extra key location.",
      "States the tradeoff.",
    ],
  },
  {
    id: "plaintext-boundary",
    question:
      "A security review finds that traffic is plaintext between the ALB and the service. The ALB listener is HTTPS and the service is healthy. How do you explain and fix it?",
    difficulty: 2,
    hints: [
      "The public listener is only one hop.",
      "Look at the target group protocol and the service port.",
    ],
    answer:
      "The client TLS session ends at the ALB because the listener is HTTPS. The target group then forwards to the service using whatever protocol it is configured for. If the target group protocol is HTTP, the ALB-to-service hop is plaintext even though the public listener is HTTPS. I would check the target group protocol, the service listener, and whether a certificate is presented on the service port. The fix is to use HTTPS on the target group with a certificate the ALB trusts, or to terminate at the service through a Layer 4 balancer if path routing is not needed.",
    followUps: [
      "What certificate does the ALB validate on the target group?",
      "How do you test this without capturing sensitive payload?",
      "What happens to mTLS in this design?",
    ],
    redFlags: [
      "Assumes HTTPS on the listener covers every hop.",
      "Checks only the service health check.",
      "Suggests a network ACL as the fix.",
    ],
    rubric: [
      "Identifies the target group protocol.",
      "Checks the service listener.",
      "Names re-encryption.",
      "Distinguishes public and private hops.",
    ],
  },
  {
    id: "key-scope",
    question:
      "Compare terminating TLS at the edge, at the load balancer, and at the service by key scope and operational risk.",
    difficulty: 4,
    hints: [
      "Count who can decrypt.",
      "Consider certificate rotation and blast radius.",
    ],
    answer:
      "Edge termination keeps the public key and certificate in one global place, which simplifies rotation and centralizes inspection, but the edge can read everything and any re-encryption adds another key. Load balancer termination puts the key in each regional balancer, closer to the service and with a smaller blast radius, but still requires a private key per balancer and another certificate if it re-encrypts. Service termination gives each workload its own identity and the narrowest blast radius, but every service must manage certificates, and a Layer 4 balancer cannot route by path. The right choice depends on where inspection, routing, and identity must happen, not on a single security ranking.",
    followUps: [
      "How does certificate rotation differ across the three?",
      "Where would you put a hardware security module?",
      "What happens when one key location is compromised?",
    ],
    redFlags: [
      "Calls one option universally more secure.",
      "Ignores rotation cost.",
      "Forgets that inspection requires plaintext.",
    ],
    rubric: [
      "Compares key scope.",
      "Names rotation and blast radius.",
      "Ties the choice to controls.",
      "States a residual risk.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every hop in the request path is documented as TLS or plaintext.",
      "Certificate owners and rotation schedules are recorded per key location.",
      "Path routing and inspection requirements are written down before choosing a terminator.",
      "mTLS identity at the service is tested, not inferred from the public listener.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the certificate the client validated, then the next listener that accepts the request.",
      "Check target group protocol and service port for a plaintext hop.",
      "Check whether inspection sees the path or only the SNI hostname.",
      "Check handshake CPU at the terminating tier before adding capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Prove the boundary with a flow log or packet capture, not a configuration review alone.",
      "Re-test mTLS after re-encryption and certificate rotation.",
      "Verify that the new terminator still supports path rules and health checks.",
      "Document the extra handshake and key location as accepted cost.",
    ],
  },
];

const references = [
  {
    title: "Create an HTTPS listener for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Listener certificates, security policies, and the HTTPS listener path.",
  },
  {
    title: "Envoy TLS overview",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/security/ssl",
    publisher: "Envoy",
    kind: "docs" as const,
    note: "Downstream and upstream TLS contexts, certificate validation, and mTLS.",
  },
  {
    title: "RFC 8446: The Transport Layer Security (TLS) Protocol Version 1.3",
    url: "https://www.rfc-editor.org/rfc/rfc8446",
    publisher: "IETF",
    kind: "standard" as const,
    note: "TLS 1.3 handshake, certificates, and session resumption.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "tls-termination": {
      model: tlsTerminationModel,
      presets,
      instructions:
        "Start healthy, then move termination to the edge with re-encryption off. Watch plaintext hops and uninspected requests, then return to load balancer termination and turn re-encryption on. Compare p99 and handshake CPU at each step.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Handshake capacities, reuse, and 30ms RTT are teaching values, not AWS quotas or benchmarks. Certificate scope and key-location counts are simplified.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-tls-handshake",
    "traffic-http3-quic",
    "traffic-keepalive-idle-timeout",
  ],
};
