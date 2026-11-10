import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const COMPROMISED_SHARE = 0.08;

const params = [
  {
    id: "identity",
    label: "Workload identity",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Identity",
    help: "1 requires each workload to present a verifiable identity, for example a mutual TLS certificate or a SPIFFE ID. 0 trusts the network location.",
    format: "count" as const,
  },
  {
    id: "policy",
    label: "Per-request authorization",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Authorization",
    help: "1 evaluates a policy for the caller, target service, action, and context. Identity without authorization still lets a compromised workload act.",
    format: "count" as const,
  },
  {
    id: "exposed",
    label: "Reachable services",
    min: 1,
    max: 20,
    step: 1,
    value: 4,
    unit: " services",
    group: "Blast radius",
    help: "Services a host can reach on the internal network. A flat network exposes the full set; segmentation and policy reduce it.",
    format: "count" as const,
  },
  {
    id: "requests",
    label: "Internal request rate",
    min: 100,
    max: 5_000,
    step: 100,
    value: 1_200,
    unit: " req/min",
    group: "Traffic",
    help: "Requests per minute from internal workloads. Eight percent come from a compromised host in this model.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  identity: boolean;
  policy: boolean;
  exposed: number;
  requests: number;
  attempts: number;
  unauthorized: number;
  authLatency: number;
  coverage: number;
  appHealth: Health;
  hostHealth: Health;
}

function compute(p: Params): Computed {
  const identity = num(p, "identity", 1) >= 0.5;
  const policy = num(p, "policy", 1) >= 0.5;
  const exposed = clamp(Math.round(num(p, "exposed", 4)), 1, 20);
  const requests = Math.max(1, num(p, "requests", 1_200));
  const attempts = requests * COMPROMISED_SHARE * exposed;
  const enforced = identity && policy;
  const unauthorized = enforced ? 0 : attempts;
  const authLatency = enforced ? 8 : 2;
  const coverage = identity ? (policy ? 100 : 60) : 0;
  const appHealth: Health = unauthorized >= 1 || exposed >= 16 ? "crit" : exposed >= 10 ? "warn" : "ok";
  return {
    identity,
    policy,
    exposed,
    requests,
    attempts,
    unauthorized,
    authLatency,
    coverage,
    appHealth,
    hostHealth: unauthorized >= 1 ? "crit" : "ok",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["unauthorized", values.unauthorized, 0],
    ["auth-latency", values.authLatency, 0.1],
    ["exposed", values.exposed, 0],
    ["coverage", values.coverage, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 9)) / 3) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const enforced = values.identity && values.policy;
  return {
    t: 0,
    nodes: [
      {
        id: "host",
        label: "internal host",
        kind: "worker",
        health: values.hostHealth,
        sublabel: values.unauthorized > 0 ? "compromised · unrestricted" : "compromised · denied",
        detail:
          values.unauthorized > 0
            ? "The host is inside the network and can reach services without proving who it is. Network location is being treated as authorization."
            : "The host is inside the network, but each request must still present a workload identity and pass an authorization policy.",
        meta: { view: "flow" },
      },
      {
        id: "identity",
        label: "workload identity",
        kind: "mesh",
        health: values.identity ? "ok" : "down",
        sublabel: values.identity ? "mTLS / SPIFFE" : "network location only",
        detail:
          values.identity
            ? "A mutual TLS certificate or SPIFFE identity proves which workload is calling. It does not prove the workload is allowed to perform the action."
            : "No workload identity is checked. Any host that can route to the service is treated as trusted.",
        meta: { view: "flow" },
      },
      {
        id: "policy",
        label: "authorization policy",
        kind: "mesh",
        health: values.policy ? "ok" : "down",
        sublabel: values.policy ? "per request" : "not evaluated",
        detail: values.policy
          ? "The policy evaluates the caller identity, target service, action, and context. A valid identity with no matching grant is denied."
          : "Authorization is skipped. A compromised workload with a valid identity can still call every service it can reach.",
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "service fleet",
        kind: "service",
        health: values.appHealth,
        sublabel: `${values.exposed} reachable · ${formatCount(values.requests)} req/min`,
        detail:
          values.unauthorized > 0
            ? `${formatCount(values.unauthorized)} unauthorized requests/min succeed. The compromised host can move laterally across ${values.exposed} services.`
            : "Unauthorized requests are denied. The fleet still serves legitimate traffic within the latency cost of the identity and policy checks.",
        meta: { view: "flow", exposed: values.exposed },
      },
    ],
    edges: [
      edge("host-identity", "host", "identity", values.identity ? 1 : 0, values.identity ? "ok" : "down"),
      edge("identity-policy", "identity", "policy", values.identity && values.policy ? 1 : 0, values.policy ? "ok" : "down"),
      edge(
        "policy-service",
        "policy",
        "service",
        values.unauthorized > 0 ? 0.5 : 1,
        values.unauthorized > 0 ? "crit" : "ok",
      ),
    ],
    metrics: [
      metric("unauthorized", "Unauthorized requests", values.unauthorized, "/min", 0.1, 1, "rps"),
      metric("auth-latency", "Auth latency", values.authLatency, " ms", 12, 30, "ms"),
      metric("exposed", "Reachable services", values.exposed, " services", 10, 16, "count"),
      metric("coverage", "Identity coverage", values.coverage, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatCount(values.unauthorized)} unauthorized req/min; ${values.exposed} reachable services; ${
      enforced ? "identity + policy" : values.identity ? "identity only" : "network only"
    }; ${values.authLatency} ms auth.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unauthorized",
    metricId: "unauthorized",
    warn: 0.1,
    crit: 1,
    title: "An internal host is reaching services without authorization",
    cause:
      "The path trusts network location. A host inside the VPC, subnet, or security group can call services without proving its workload identity or passing an authorization policy. A compromised host inherits that trust.",
    fix:
      "Require a workload identity on each request, evaluate an authorization policy for the caller and action, and segment the network so a compromised host cannot reach every service.",
    checkFirst: [
      "Check whether the caller presents a workload identity or only a routable IP.",
      "Check whether the target service evaluates an authorization policy or only a network allow list.",
      "Map the reachable services from the compromised host to size the blast radius.",
    ],
  },
  {
    id: "exposed",
    metricId: "exposed",
    warn: 10,
    crit: 16,
    title: "One host can reach most of the service fleet",
    cause:
      "The network is flat or the allow lists are broad. Even with identity checks, a large reachable set increases the number of targets an attacker can probe and the policy surface that must be correct.",
    fix:
      "Segment by service and environment, deny east-west traffic by default, and require an explicit authorization grant for each service-to-service path.",
    checkFirst: [
      "List the services reachable from a single workload and the ports they expose.",
      "Find allow rules that use a wide CIDR or a shared security group.",
      "Check whether the identity policy grants every service or only the intended dependencies.",
    ],
  },
  {
    id: "auth-latency",
    metricId: "auth-latency",
    warn: 12,
    crit: 30,
    title: "Identity and policy checks are adding request latency",
    cause:
      "Every request now performs a token or certificate check and a policy decision. A cold cache, a remote policy engine, or a synchronous call to an identity provider adds latency to the hot path.",
    fix:
      "Cache verified identities and policy decisions within their validity window, keep the policy engine local to the data path, and measure the latency budget before enforcing on every route.",
    checkFirst: [
      "Break down the latency into identity verification and policy evaluation.",
      "Check cache hit rate and certificate or token validation cost.",
      "Check whether the policy engine is a remote call on the request path.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const zeroTrustModel: SimModel = {
  id: "cloud-networking-zero-trust",
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
    const jitter = rng.between(-0.1, 0.1);
    next.metrics = next.metrics.map((item) =>
      item.id === "auth-latency" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.unauthorized >= 1 && frame.flags.lateralLogged !== 1) {
      pushEvent(next, {
        id: "lateral-movement",
        severity: "crit",
        title: "Internal host moving laterally",
        detail: `${formatCount(values.unauthorized)} unauthorized requests/min succeed across ${values.exposed} reachable services. The host is trusted because it is inside the network.`,
        nodeId: "host",
        metricId: "unauthorized",
      });
    }
    next.flags.lateralLogged = values.unauthorized >= 1 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.unauthorized > 0) {
      items.push(
        `${formatCount(values.unauthorized)} unauthorized requests/min succeed. The compromised host reaches ${values.exposed} services because network location is the only check.`,
      );
    } else {
      items.push(
        "Every request presents a workload identity and passes an authorization policy. A compromised host can still send traffic, but the requests are denied.",
      );
    }
    items.push(
      values.identity && !values.policy
        ? "Identity is verified but authorization is not. A compromised workload with a valid certificate can still call every service it can reach."
        : values.identity && values.policy
          ? `Identity and policy are both enforced at ${values.authLatency} ms per request. That is the latency cost of the control, and it belongs in the service budget.`
          : "Neither workload identity nor per-request authorization is enforced. The security group is the only boundary.",
    );
    items.push(
      `Reachable services: ${values.exposed}. Zero trust does not require removing the network, but it does require that reachability is not the same as permission.`,
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
    description: "Workload identity and per-request authorization are enforced; four services are reachable.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Internal traffic reaches 5,000 req/min and eight services are reachable; every request is authorized.",
    tone: "warn",
    params: defaults({ requests: 5_000, exposed: 8 }),
  },
  {
    id: "failure",
    label: "Network trust",
    description: "No identity or policy check. A compromised host reaches 18 services without authorization.",
    tone: "crit",
    params: defaults({ identity: 0, policy: 0, exposed: 18, requests: 3_000 }),
  },
  {
    id: "identity-only",
    label: "Identity only",
    description: "Certificates are verified, but authorization is skipped. A compromised workload still moves laterally.",
    tone: "crit",
    params: defaults({ identity: 1, policy: 0, exposed: 12, requests: 2_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Per-request authorization is restored and the reachable set is reduced.",
    tone: "ok",
    params: defaults({ identity: 1, policy: 1, exposed: 4, requests: 2_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-inside-network",
  title: "Predict the authorization result",
  simId: "identity-path",
  question:
    "A host inside the VPC passes the security group and reaches the orders service. The service has no workload identity check and no authorization policy. What happens to a request from a compromised host?",
  prediction: {
    options: [
      { id: "allowed", label: "Allowed, because the host is inside the VPC and the security group permits it." },
      { id: "denied-ip", label: "Denied, because the host IP is not in the allow list." },
      { id: "denied-mtls", label: "Denied, because mutual TLS is required by the load balancer." },
      { id: "allowed-auth", label: "Allowed only if the host has a valid IAM role." },
    ],
    correctOptionId: "allowed",
    explanation:
      "The security group controls whether packets can reach the service; it does not decide which caller may perform an action. With no workload identity and no authorization policy, the service treats network reachability as trust. A compromised host inherits that trust and can call the service.",
  },
  setup: defaults({ identity: 0, policy: 0, exposed: 18, requests: 3_000 }),
  runFor: 12,
  observe: [
    "Unauthorized requests succeed at the internal request rate.",
    "The identity and policy nodes are unavailable.",
    "The service fleet is failing while the network path is healthy.",
    "The reachable-service count is the blast radius, not the number of legitimate calls.",
  ],
  explain:
    "Zero trust changes the question from where the request came from to who is calling and what they are allowed to do. Authentication proves the workload identity; authorization maps that identity to an action on a target. Both are needed. A security group is a network control, not an identity control.",
  fix: defaults({ identity: 1, policy: 1, exposed: 4, requests: 3_000 }),
  debrief:
    "The request was allowed because the path had no identity or policy check. The fix is not a narrower IP range alone; it is a workload identity plus an authorization decision, with segmentation to limit what a compromised host can reach. The latency cost is real and belongs in the budget.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Zero trust is a security model that stops treating network location as proof of trust. Every request is authenticated and authorized based on the workload identity, the target, the action, and the context. Being inside the VPC, the subnet, or a security group is not an authorization decision.",
  },
  {
    type: "p",
    text: "Workload identity can come from mutual TLS certificates, SPIFFE IDs, or a cloud identity. Authorization is a separate decision: a policy maps that identity to allowed actions on a target. Authentication without authorization is not enough, because a compromised workload still has a valid identity.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is caller, identity check, policy decision, target service. A service mesh can provide the identity and enforce policy at the sidecar. An identity-aware proxy can do the same at the edge. The application can also enforce policy itself. The control belongs where the request is authorized, not only where the packet is routed.",
  },
  {
    type: "table",
    headers: ["Control", "Question it answers", "What it does not answer", "Failure mode"],
    rows: [
      ["Security group", "Can this packet reach the port?", "Who is the caller and what may they do?", "Any host in the allowed CIDR is trusted."],
      ["Workload identity", "Which workload is calling?", "Is this action allowed for that workload?", "A compromised workload with a valid identity still passes."],
      ["Authorization policy", "May this identity do this action on this target?", "Is the identity itself compromised?", "A valid but over-privileged identity can do too much."],
      ["Segmentation", "Which services can be reached at all?", "May the caller perform the action?", "Reduces blast radius but does not authorize."],
    ],
  },
  {
    type: "p",
    text: "The table is the argument for layering. A security group without identity trusts the network. Identity without authorization trusts any valid certificate. Authorization without segmentation still exposes a large attack surface. Zero trust combines them and keeps the network as a boundary, not as the identity.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Unauthorized requests per minute from a compromised internal host.",
      "Reachable services, which is the blast radius of a flat network.",
      "Workload identity and per-request authorization as separate nodes.",
      "Auth latency, the cost of adding checks to the hot path.",
      "A prediction experiment that asks why a request inside the VPC should still be denied.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then remove both identity and authorization. The service fails even though the network path is fine. Next enable identity only and note that unauthorized requests still succeed; a valid certificate is not an authorization decision. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The request rate, compromised share, reachable-service count, and latency are illustrative. The separation of authentication, authorization, and network reachability is the part to carry into production.",
  },
  { type: "sim", simId: "identity-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With no identity or policy check, the compromised host reached 18 services at thousands of requests per minute. The network path was healthy, which is exactly why the incident looked like a normal internal workload. The security group could not distinguish the compromised host from any other host in the CIDR.",
  },
  {
    type: "p",
    text: "Identity alone did not fix it. The host presented a valid certificate and still reached every service because no authorization policy evaluated the action. The identity check answered who was calling, not what it was allowed to do.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Mesh or proxy telemetry: source identity, destination identity, policy decision, and denial reason.",
      "Authentication failures: missing certificate, expired certificate, or untrusted trust bundle.",
      "Authorization failures: a valid identity denied by policy, which is the signal that the control is working.",
      "Network flow logs: east-west traffic that should not exist between services.",
      "Latency breakdown: identity verification and policy evaluation on the request path.",
      "Reachable-service inventory: the blast radius of one compromised workload.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the caller presents a workload identity and whether the target evaluates an authorization policy. If both are present, read the denial reason before widening the policy. If either is missing, the network is the only control, and reachability is being mistaken for permission.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory service-to-service calls and the identity each caller can present.",
      "Issue workload identities and distribute trust bundles before enforcing.",
      "Write authorization policies for each caller, target, and action; start in monitor mode.",
      "Enforce policy on the highest-risk paths first and keep a rollback to monitor mode.",
      "Segment east-west traffic so a compromised host cannot reach every service.",
      "Cache identity and policy decisions within their validity window to control latency.",
      "Alert on denials and on east-west flows that have no policy owner.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Identity and policy checks add latency. Caching and local policy engines keep the cost bounded, but the budget is real.",
      "Certificate rotation and trust-bundle distribution become critical dependencies. An expired certificate is an outage.",
      "Monitor mode is safe for rollout but does not protect anything until enforcement is on.",
      "Segmentation reduces blast radius but adds network and policy complexity; it does not replace authorization.",
      "A central policy engine is easier to audit but can become a shared failure domain on the request path.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "network-is-not-identity",
    question: "Why is a security group or an internal IP address not sufficient authorization for a service call?",
    difficulty: 2,
    hints: [
      "A packet carries an address, not a workload identity.",
      "A compromised host inherits the network position.",
    ],
    answer:
      "A security group answers whether a packet can reach a port. It does not prove which workload sent it or what that workload is allowed to do. Any host in the allowed CIDR, including a compromised one, inherits the same reachability. Zero trust adds a workload identity and an authorization policy so the target can decide whether this caller may perform this action. The network remains a boundary, but it is not the identity.",
    followUps: [
      "What does mutual TLS add?",
      "What does SPIFFE provide?",
      "How would you limit the blast radius further?",
    ],
    redFlags: [
      "Treats the VPC as a trusted zone.",
      "Believes a private IP is authentication.",
      "Confuses encryption with authorization.",
    ],
    rubric: [
      "Separates reachability from identity.",
      "Names authentication and authorization.",
      "Explains the compromised-host case.",
      "Adds segmentation.",
    ],
  },
  {
    id: "mtls-not-enough",
    question: "The mesh enforces mutual TLS, but a compromised workload can still call every service. Why?",
    difficulty: 3,
    hints: [
      "mTLS authenticates the caller.",
      "Authorization is a separate decision.",
    ],
    answer:
      "Mutual TLS proves the caller's workload identity, but it does not decide which actions that identity may perform. If every authenticated workload is allowed to call every service, a compromised workload with a valid certificate still moves laterally. I would add per-request authorization policies that map the caller identity to specific targets and actions, start in monitor mode, then enforce. I would also segment the network so the reachable set is smaller even before policy.",
    followUps: [
      "Where would the policy be enforced?",
      "How do you avoid breaking legitimate calls during rollout?",
      "What would you monitor in monitor mode?",
    ],
    redFlags: [
      "Believes mTLS is authorization.",
      "Enforces a broad allow policy.",
      "Skips monitor mode.",
    ],
    rubric: [
      "Separates authentication from authorization.",
      "Adds per-request policy.",
      "Rolls out in monitor mode.",
      "Reduces reachability.",
    ],
  },
  {
    id: "zero-trust-cost",
    question: "What does a zero-trust rollout cost, and how do you keep it from becoming a latency incident?",
    difficulty: 3,
    hints: [
      "Identity verification and policy evaluation both take time.",
      "Cache within validity windows.",
    ],
    answer:
      "The costs are operational and technical: workload identity issuance, certificate rotation, trust-bundle distribution, policy authoring, and a policy decision on the request path. The latency cost comes from certificate or token validation and a policy call. I would measure the budget, keep the policy engine local to the data path, cache verified identities and decisions within their validity window, and roll out in monitor mode before enforcement. I would also make certificate expiry and policy-engine availability explicit alerts, because both become availability dependencies.",
    followUps: [
      "Which calls would you enforce first?",
      "How long may a policy decision be cached?",
      "What is the rollback path?",
    ],
    redFlags: [
      "Ignores latency.",
      "Enforces everywhere at once.",
      "Has no certificate rotation plan.",
    ],
    rubric: [
      "Names operational and latency costs.",
      "Caches within validity.",
      "Rolls out incrementally.",
      "Treats identity as an availability dependency.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every service has a workload identity and a documented owner.",
      "Authorization policies cover caller, target, and action.",
      "Policies run in monitor mode before enforcement.",
      "East-west traffic is segmented by service and environment.",
      "Certificate expiry and trust-bundle drift are alerted.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether the caller presents a workload identity.",
      "Check whether the target evaluates an authorization policy.",
      "Read the denial reason before widening a policy.",
      "Map the reachable services from the compromised host.",
      "Preserve monitor-mode evidence and the policy version.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the missing identity or policy to the affected path.",
      "Reduce the reachable set for the compromised workload class.",
      "Add a denial-rate alert and a policy regression test.",
      "Review the latency budget and cache behavior.",
    ],
  },
];

const references = [
  {
    title: "NIST SP 800-207: Zero Trust Architecture",
    url: "https://csrc.nist.gov/pubs/sp/800/207/final",
    publisher: "NIST",
    kind: "standard" as const,
    note: "Defines zero trust principles, policy decision points, and enforcement points.",
  },
  {
    title: "SPIFFE concepts",
    url: "https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/",
    publisher: "SPIFFE",
    kind: "docs" as const,
    note: "Workload identity, SPIFFE IDs, and trust domains.",
  },
  {
    title: "AWS Verified Access",
    url: "https://docs.aws.amazon.com/verified-access/latest/ug/what-is-verified-access.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "An AWS service that evaluates identity and device context per request.",
  },
  {
    title: "IAM Roles Anywhere",
    url: "https://docs.aws.amazon.com/rolesanywhere/latest/userguide/introduction.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Grants AWS credentials to workloads based on X.509 certificates.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "identity-path": {
      model: zeroTrustModel,
      presets,
      instructions:
        "Start healthy, then remove identity and authorization. Compare that with identity only: authentication alone does not stop lateral movement.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Request rates, compromised share, and latency are teaching values.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-mtls", "cloud-networking-least-privilege", "cloud-networking-encryption"],
};
