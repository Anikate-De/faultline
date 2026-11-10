import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const REQUESTS_PER_MIN = 3_000;

const params = [
  {
    id: "tlsMode",
    label: "Service transport",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "In transit",
    help: "0 is plaintext HTTP, 1 is TLS with server authentication, 2 is mutual TLS with workload identity on both ends.",
    format: "count" as const,
  },
  {
    id: "atRest",
    label: "Encryption at rest",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "At rest",
    help: "1 encrypts stored objects and database pages with a managed key. It does not encrypt traffic between services.",
    format: "count" as const,
  },
  {
    id: "sensitiveShare",
    label: "Sensitive requests",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Traffic",
    help: "Share of requests that carry regulated or personal data. Only this share is counted as exposed when transport is plaintext.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  tlsMode: number;
  atRest: boolean;
  sensitiveShare: number;
  sensitiveRequests: number;
  exposed: number;
  atRestGap: number;
  protectedShare: number;
  identityCoverage: number;
  edgeHealth: Health;
  storeHealth: Health;
}

function compute(p: Params): Computed {
  const tlsMode = clamp(Math.round(num(p, "tlsMode", 1)), 0, 2);
  const atRest = num(p, "atRest", 1) >= 0.5;
  const sensitiveShare = clamp(num(p, "sensitiveShare", 40), 0, 100);
  const sensitiveRequests = (REQUESTS_PER_MIN * sensitiveShare) / 100;
  const exposed = tlsMode === 0 ? sensitiveRequests : 0;
  const atRestGap = atRest ? 0 : 100;
  const protectedShare = tlsMode >= 1 ? 100 : 100 - sensitiveShare;
  const identityCoverage = tlsMode === 2 ? 100 : 0;
  return {
    tlsMode,
    atRest,
    sensitiveShare,
    sensitiveRequests,
    exposed,
    atRestGap,
    protectedShare,
    identityCoverage,
    edgeHealth: tlsMode === 0 ? "crit" : "ok",
    storeHealth: atRest ? "ok" : "crit",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["exposed", values.exposed, 0],
    ["at-rest-gap", values.atRestGap, 0],
    ["protected-share", values.protectedShare, 0.2],
    ["identity-coverage", values.identityCoverage, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 4)) / 2.9) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function transportLabel(mode: number): string {
  return mode === 0 ? "HTTP" : mode === 1 ? "TLS" : "mTLS";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const inTransit = values.tlsMode >= 1;
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "web client",
        kind: "client",
        health: "ok",
        sublabel: `${formatCount(REQUESTS_PER_MIN)} req/min`,
        detail: "The client has no visibility into the encryption used on internal hops. It only knows whether the edge connection succeeds.",
        meta: { view: "flow" },
      },
      {
        id: "edge",
        label: "edge load balancer",
        kind: "lb",
        health: values.edgeHealth,
        sublabel: `${transportLabel(values.tlsMode)} · ${values.tlsMode === 2 ? "client cert" : "server cert"}`,
        detail: inTransit
          ? "The transport is encrypted. TLS protects the connection and authenticates the server; mutual TLS also requires a client identity."
          : "The edge accepts plaintext HTTP. Any request body, header, or cookie that carries sensitive data is readable on the path.",
        meta: { view: "flow", transport: transportLabel(values.tlsMode) },
      },
      {
        id: "service",
        label: "orders-api",
        kind: "service",
        health: values.edgeHealth,
        sublabel: values.exposed > 0 ? `${formatCount(values.exposed)} sensitive/min exposed` : "sensitive data protected",
        detail:
          values.exposed > 0
            ? "The service receives sensitive fields over an unencrypted connection. Storage encryption does not protect this hop."
            : "The service receives data over an encrypted connection. Authorization and field-level handling are separate controls.",
        meta: { view: "flow" },
      },
      {
        id: "db",
        label: "orders database",
        kind: "db",
        health: values.storeHealth,
        sublabel: values.atRest ? "storage encrypted" : "storage unencrypted",
        detail: values.atRest
          ? "Data pages and backups are encrypted with a managed key. This protects the volume, not the network hop that delivered the query."
          : "The database stores data without encryption at rest. A snapshot, backup, or disk copy exposes the contents.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-edge", "client", "edge", 1, "ok"),
      edge("edge-service", "edge", "service", 1, inTransit ? "ok" : "crit", transportLabel(values.tlsMode)),
      edge("service-db", "service", "db", 1, values.atRest ? "ok" : "crit"),
    ],
    metrics: [
      metric("exposed", "Sensitive requests exposed", values.exposed, "/min", 0.1, 1, "rps"),
      metric("at-rest-gap", "Storage unprotected", values.atRestGap, "%", 0.5, 5, "percent"),
      metric("protected-share", "Transport protected", values.protectedShare, "%", undefined, undefined, "percent"),
      metric("identity-coverage", "Workload identity", values.identityCoverage, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${transportLabel(values.tlsMode)} in transit; storage ${
      values.atRest ? "encrypted" : "unencrypted"
    }; ${formatCount(values.exposed)} sensitive requests/min exposed.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "exposed",
    metricId: "exposed",
    warn: 0.1,
    crit: 1,
    title: "Sensitive data is crossing a trust boundary unencrypted",
    cause:
      "The service-to-service transport is plaintext. Encryption at rest protects stored copies, not the request in flight, so this control is missing at the transport layer.",
    fix:
      "Terminate TLS at the edge and require TLS on internal service calls. Use mutual TLS where the caller identity must be verified, and keep certificate validation enabled on the client.",
    checkFirst: [
      "Identify the hop that carries sensitive fields and the protocol it uses.",
      "Check whether TLS is terminated at the edge and re-established to the service.",
      "Check certificate validation on the client; encryption without validation does not authenticate the server.",
    ],
  },
  {
    id: "at-rest-gap",
    metricId: "at-rest-gap",
    warn: 0.5,
    crit: 5,
    title: "Stored data is not encrypted at rest",
    cause:
      "A volume, database, backup, or object store is missing encryption. This is a separate control from transport encryption and can be missing while every request is protected.",
    fix:
      "Enable encryption with a managed key, migrate existing data or restore into an encrypted target, and include backups and snapshots in the same control.",
    checkFirst: [
      "List every copy of the data: primary volume, replicas, snapshots, backups, exports, and analytics copies.",
      "Check the key policy and the service role that performs the encryption.",
      "Confirm that restore paths also produce encrypted copies.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const encryptionModel: SimModel = {
  id: "cloud-networking-encryption",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    const jitter = rng.between(-0.2, 0.2);
    next.metrics = next.metrics.map((item) =>
      item.id === "protected-share" ? { ...item, value: clamp(item.value + jitter, 0, 100) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.exposed > 0 && frame.flags.exposedLogged !== 1) {
      pushEvent(next, {
        id: "plaintext-sensitive",
        severity: "crit",
        title: "Sensitive request in plaintext",
        detail: `${formatCount(values.exposed)} sensitive requests/min cross the service hop over ${transportLabel(
          values.tlsMode,
        )}. Encryption at rest does not cover this path.`,
        nodeId: "service",
        metricId: "exposed",
      });
    }
    next.flags.exposedLogged = values.exposed > 0 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      values.exposed > 0
        ? `${formatCount(values.exposed)} sensitive requests/min cross an unencrypted service hop. Storage encryption does not cover this path.`
        : `The service hop is encrypted with ${transportLabel(values.tlsMode)}; no sensitive request is counted as exposed in transit.`,
    );
    items.push(
      values.atRest
        ? "Storage is encrypted. This protects data at rest, including backups only if they inherit the same key and policy."
        : "Storage is unencrypted. A snapshot or disk copy exposes the data even if every request used TLS.",
    );
    items.push(
      values.tlsMode === 2
        ? "Mutual TLS adds a client identity. It does not replace authorization; the service still decides which caller may perform which action."
        : "Server-authenticated TLS encrypts the hop and authenticates the server. It does not prove the client is an approved workload.",
    );
    return items;
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Saturated", tone: "warn" },
    { label: "Failing", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "TLS on the service hop and encryption at rest. Sensitive data is protected at both layers.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Sensitive traffic rises to 90% of requests; mTLS and storage encryption still cover the path.",
    tone: "warn",
    params: defaults({ tlsMode: 2, sensitiveShare: 90 }),
  },
  {
    id: "failure",
    label: "Plaintext and unencrypted",
    description: "The service hop is HTTP and the database is unencrypted. Both controls are missing.",
    tone: "crit",
    params: defaults({ tlsMode: 0, atRest: 0, sensitiveShare: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Mutual TLS is enforced and storage encryption is restored.",
    tone: "ok",
    params: defaults({ tlsMode: 2, atRest: 1, sensitiveShare: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-missing-layer",
  title: "Find the missing layer",
  simId: "encryption-path",
  question:
    "The database and S3 bucket are encrypted at rest. orders-api calls the pricing service over HTTP inside the VPC, and requests carry customer email and order value. Which control is missing?",
  prediction: {
    options: [
      { id: "at-rest", label: "Encryption at rest, because the database key is not attached." },
      { id: "in-transit", label: "Encryption in transit, because the internal service hop is plaintext." },
      { id: "kms", label: "A KMS grant, because the service cannot read its own key." },
      { id: "backup", label: "Backup encryption, because snapshots are not listed." },
    ],
    correctOptionId: "in-transit",
    explanation:
      "Encryption at rest protects stored copies. The service-to-service HTTP request is a separate path, and sensitive fields are readable while the request is in flight. TLS on that hop protects it. Mutual TLS would additionally authenticate the caller, but TLS is the missing control here.",
  },
  setup: defaults({ tlsMode: 0, atRest: 1, sensitiveShare: 60 }),
  runFor: 12,
  observe: [
    "The exposed-request rate follows the sensitive share, not the total request rate.",
    "The database node is healthy because storage encryption is on.",
    "The service hop is the only failing segment.",
    "Storage encryption does not reduce the exposed count.",
  ],
  explain:
    "At-rest and in-transit encryption answer different questions. At rest: can someone with a disk or snapshot read the data? In transit: can someone on the network path read the request? The database being encrypted says nothing about the HTTP hop. The fix is to encrypt that hop and verify the client validates the server certificate.",
  fix: defaults({ tlsMode: 2, atRest: 1, sensitiveShare: 60 }),
  debrief:
    "An encryption audit is a list of data paths, not a single checkbox. Walk each copy and each hop, name the control, and test it. The service hop was the gap even though the storage layer looked complete.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Encryption converts readable data into ciphertext that only a holder of the right key can reverse. Encryption at rest protects stored data: volumes, databases, object stores, snapshots, and backups. Encryption in transit protects data while it moves between systems. The two controls use different keys, different enforcement points, and different failure modes.",
  },
  {
    type: "p",
    text: "Transport Layer Security (TLS) encrypts a connection and authenticates the server with a certificate. Mutual TLS (mTLS) also requires the client to present a certificate, so the server can authenticate the workload. Neither one authorizes a specific action. Authorization still belongs in the service or an identity-aware proxy.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "A request path may terminate TLS at the load balancer and then re-originate plaintext to the service. That is a common gap: the edge is encrypted, but the internal hop is not. A storage layer can be encrypted and still receive plaintext queries. Auditing one layer does not prove the other.",
  },
  {
    type: "table",
    headers: ["Layer", "Protects", "Does not protect", "Evidence"],
    rows: [
      ["At rest", "Volumes, objects, snapshots, backups", "The network hop or a running process", "Key ID, bucket default encryption, volume encryption state."],
      ["TLS", "The connection between two endpoints", "Data after it is decrypted or stored", "Certificate chain, protocol version, listener policy."],
      ["mTLS", "The connection plus client identity", "Authorization or data handling after the request", "Client certificate, trust bundle, peer identity."],
    ],
  },
  {
    type: "p",
    text: "The table also shows why a single checkbox is not an audit. A bucket can be encrypted at rest while an application copies its contents to a plaintext HTTP endpoint. A service can use mTLS and still let any authenticated workload read every tenant. Each row needs its own evidence.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Sensitive requests exposed per minute, based only on the transport state and the sensitive share.",
      "Storage unprotected percentage, which moves independently of the transport.",
      "Transport protected share and workload identity coverage.",
      "Four nodes: client, edge, service, and database, so the unprotected hop is visible.",
      "A prediction experiment that separates at-rest from in-transit protection.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then switch the service transport to HTTP while leaving storage encryption on. The exposed count rises and the database stays healthy. Next turn storage encryption off with TLS on, and compare which metric moves. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The request rate, sensitive share, and thresholds are illustrative. The separation between at-rest and in-transit controls, the TLS and mTLS behavior, and the evidence each layer leaves are the parts to carry into production.",
  },
  { type: "sim", simId: "encryption-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With HTTP on the service hop and encryption at rest on, the exposed count followed the sensitive share of traffic. The database node stayed healthy because the storage control was intact. The missing control was the transport, not the key store.",
  },
  {
    type: "p",
    text: "Turning storage encryption off moved a different metric. The transport stayed protected, but every stored copy became readable. The two failures produced different evidence, which is the point: an audit has to name the layer before it names the fix.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer listeners and target groups: TLS termination at the edge and the protocol to the target.",
      "Service mesh or application configuration: whether internal calls use TLS and whether the client validates the certificate.",
      "Storage configuration: bucket default encryption, database encryption, volume encryption, and snapshot encryption.",
      "Key policies: who may use the key and whether the service role still has the needed grant.",
      "Certificate expiry and trust bundle state: an expired certificate is an availability incident, not just a compliance finding.",
      "Backups and exports: a copy can leave the encrypted boundary even when the primary store is protected.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Draw the request path and mark the protocol on every hop. Then list every stored copy and its key. Do not accept the storage encryption state as evidence for the network path, and do not accept TLS as evidence that stored data is protected.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory each data path: client to edge, edge to service, service to dependency, and service to storage.",
      "Require TLS on every hop that carries sensitive data, including internal service calls.",
      "Enable certificate validation on clients. Encryption without validation does not authenticate the server.",
      "Add mutual TLS where the caller identity must be proven before authorization.",
      "Enable encryption at rest on primary storage, replicas, snapshots, backups, and exports.",
      "Use a key policy that grants the smallest set of principals and operations.",
      "Test the failure path: expired certificate, missing key grant, and a restore from an encrypted backup.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "TLS adds handshake and certificate-management work. Session resumption and a controlled trust bundle keep the cost bounded.",
      "mTLS improves caller authentication but complicates onboarding and rotation. It also adds a dependency on the identity provider.",
      "Encryption at rest is inexpensive for managed services but does not protect a live request or a misconfigured export.",
      "Field-level encryption protects specific columns even from the database operator, but it breaks queries and indexing that expect plaintext.",
      "Terminating TLS at the edge is simpler, but the internal hop is still plaintext unless it is re-encrypted.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "separate-layers",
    question:
      "A team says its data is encrypted because the database and S3 bucket use KMS. What is missing from that claim?",
    difficulty: 2,
    hints: [
      "At rest and in transit are different controls.",
      "Ask for the request path, not the storage list.",
    ],
    answer:
      "The claim covers encryption at rest only. It says nothing about the network hops between the client, edge, services, and dependencies, or about copies such as exports and analytics extracts. I would ask for the request path and the protocol on each hop, then check TLS and certificate validation on the hops that carry sensitive data. I would also list every stored copy and its key. The evidence for each control is different: key and bucket configuration for at rest, listener and client configuration for in transit.",
    followUps: [
      "Which hop is most often missed?",
      "What does mTLS add?",
      "How would you test the transport claim?",
    ],
    redFlags: [
      "Treats KMS as a complete encryption answer.",
      "Ignores internal service hops.",
      "Forgets backups and exports.",
    ],
    rubric: [
      "Separates at rest from in transit.",
      "Asks for the path and every copy.",
      "Names TLS and certificate validation.",
      "Distinguishes evidence per layer.",
    ],
  },
  {
    id: "tls-versus-mtls",
    question: "When would you choose mutual TLS over server-authenticated TLS?",
    difficulty: 3,
    hints: [
      "Server TLS authenticates one end.",
      "Authorization is still separate.",
    ],
    answer:
      "I would choose mutual TLS when the server must prove the identity of the client workload before making an authorization decision, for example between services in a zero-trust network or when a shared internal endpoint must reject unknown callers. Server TLS only proves the server's identity to the client; any client can connect. Mutual TLS adds a client certificate and a trust bundle, so the server can authenticate the workload. It does not replace authorization: the service still needs a policy that maps the identity to allowed actions.",
    followUps: [
      "How do you rotate client certificates without downtime?",
      "What happens if the trust bundle is stale?",
      "Would you use mTLS at the edge or between services?",
    ],
    redFlags: [
      "Says mTLS replaces authorization.",
      "Uses mTLS everywhere without a rotation plan.",
      "Confuses a shared secret with a certificate identity.",
    ],
    rubric: [
      "Explains server versus client authentication.",
      "Names a concrete use case.",
      "Keeps authorization separate.",
      "Considers certificate rotation.",
    ],
  },
  {
    id: "audit-encryption",
    question: "How do you audit encryption for a new service in one afternoon?",
    difficulty: 3,
    hints: [
      "Start with the data path and the copies.",
      "Name the evidence for each control.",
    ],
    answer:
      "I would draw the request path and mark each hop with its protocol, then list every stored copy: primary database, replicas, snapshots, backups, object storage, exports, and analytics copies. For each hop I would check the listener, the client configuration, certificate validation, and expiry. For each copy I would check the key, the key policy, and whether restores stay encrypted. I would record the evidence and the owner for each row. The output is a gap list, not a yes or no answer.",
    followUps: [
      "Which gap would you fix first?",
      "How do you verify a backup is encrypted?",
      "What would you automate?",
    ],
    redFlags: [
      "Checks only the primary database.",
      "Accepts a screenshot of a setting as proof.",
      "Ignores certificate expiry.",
    ],
    rubric: [
      "Maps hops and copies.",
      "Names evidence per control.",
      "Checks key policy and restores.",
      "Produces an owned gap list.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every sensitive data path has a documented protocol per hop.",
      "Internal service calls use TLS, not only the public edge.",
      "Clients validate server certificates and trust bundles are current.",
      "Primary storage, replicas, snapshots, backups, and exports are encrypted.",
      "Key policies grant the smallest principal set and are reviewed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the exact hop or copy that is unprotected.",
      "Separate a transport gap from an at-rest gap before changing controls.",
      "Check certificate expiry and trust bundle state for availability failures.",
      "Check key policy and grants for authorization failures.",
      "Record the evidence and the change owner.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a test for the unprotected hop or copy.",
      "Automate certificate expiry and key-policy drift alerts.",
      "Verify that restore paths produce encrypted copies.",
      "Update the data-path inventory with the new service.",
    ],
  },
];

const references = [
  {
    title: "AWS Well-Architected: Data protection",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/security-pillar/data-protection.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Best-practice guidance for protecting data at rest and in transit.",
  },
  {
    title: "Transport Layer Security on Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/create-https-listener.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "HTTPS listeners, certificate selection, and security policies.",
  },
  {
    title: "AWS KMS concepts",
    url: "https://docs.aws.amazon.com/kms/latest/developerguide/concepts.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Keys, key policies, and the difference between protecting keys and bulk data.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "encryption-path": {
      model: encryptionModel,
      presets,
      instructions:
        "Start healthy, then remove transport encryption while keeping storage encryption. Compare that with removing storage encryption while TLS stays on.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Request volume, sensitive share, and thresholds are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-kms", "cloud-networking-zero-trust", "cloud-networking-secrets"],
};
