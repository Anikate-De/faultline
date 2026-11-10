import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MAX_RATE = 20_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: MAX_RATE,
    step: 500,
    value: 6_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests entering the mesh. Every hop between sidecars can apply its own mTLS policy.",
    format: "rps" as const,
  },
  {
    id: "strictShare",
    label: "Strict mTLS coverage",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Policy",
    help: "Share of sidecar hops configured for STRICT mode. The remainder is PERMISSIVE and accepts plaintext inbound connections.",
    format: "percent" as const,
  },
  {
    id: "plaintextShare",
    label: "Plaintext callers",
    min: 0,
    max: 100,
    step: 1,
    value: 0,
    unit: "%",
    group: "Traffic",
    help: "Share of requests whose client does not present a mesh certificate. These are the callers strict mode rejects.",
    format: "percent" as const,
  },
  {
    id: "meshHops",
    label: "Sidecar hops per request",
    min: 1,
    max: 4,
    step: 1,
    value: 2,
    unit: "",
    group: "Topology",
    help: "Number of sidecar-to-sidecar hops. A request is authenticated end to end only if every hop is strict.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  rate: number;
  strictPct: number;
  plaintextPct: number;
  hops: number;
  admittedPct: number;
  rejectedPct: number;
  authenticatedPct: number;
  identityGapPct: number;
  errorRate: number;
  p99: number;
  mode: "strict" | "permissive" | "mixed";
}

function compute(p: Params, rngJitter = 0): Computed {
  const rate = Math.max(1, Math.round(num(p, "requestRate", 6_000)));
  const strictPct = clamp(num(p, "strictShare", 100), 0, 100);
  const plaintextPct = clamp(num(p, "plaintextShare", 0), 0, 100);
  const hops = Math.max(1, Math.round(num(p, "meshHops", 2)));
  const strict = strictPct / 100;
  const permissivePath = 1 - strict ** hops;
  const admittedPct = plaintextPct * permissivePath;
  const rejectedPct = plaintextPct - admittedPct;
  const authenticatedPct = 100 - plaintextPct;
  const mode: Computed["mode"] = strictPct >= 100 ? "strict" : strictPct <= 0 ? "permissive" : "mixed";
  return {
    rate,
    strictPct,
    plaintextPct,
    hops,
    admittedPct,
    rejectedPct,
    authenticatedPct,
    identityGapPct: plaintextPct,
    errorRate: rejectedPct,
    p99: Math.max(1, 120 + hops * 6 + (rate / MAX_RATE) * 20 + rngJitter),
    mode,
  };
}

function healthFor(pct: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (pct >= crit) return "crit";
  if (pct >= warn) return "warn";
  return "ok";
}

function modeLabel(c: Computed): string {
  if (c.mode === "strict") return "STRICT on every hop";
  if (c.mode === "permissive") return "PERMISSIVE, plaintext accepted";
  return `${c.strictPct}% of hops strict`;
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const rejectedHealth = healthFor(c.rejectedPct, 1, 5);
  const admittedHealth = healthFor(c.admittedPct, 0.1, 1);
  const sidecarHealth = c.admittedPct > 0 ? admittedHealth : rejectedHealth === "ok" ? "ok" : "warn";
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: "ok",
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: `${c.rate.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "gateway",
        label: "Mesh gateway",
        kind: "mesh",
        health: rejectedHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: "TLS or plaintext",
        meta: { view: "flow" },
      },
      {
        id: "checkout",
        label: "Checkout service",
        kind: "service",
        health: rejectedHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate,
        sublabel: c.rejectedPct > 0 ? `${c.rejectedPct.toFixed(1)}% handshakes rejected` : "all callers authenticated",
        detail: `${c.plaintextPct.toFixed(1)}% of callers arrive without a mesh certificate. ${c.rejectedPct.toFixed(1)}% are rejected at a strict hop.`,
        meta: { view: "flow" },
      },
      {
        id: "sidecar",
        label: "Destination sidecar",
        kind: "mesh",
        health: sidecarHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate * (1 - c.rejectedPct / 100),
        sublabel: modeLabel(c),
        detail: `${c.admittedPct.toFixed(1)}% of requests are admitted without a verified identity. Strict mode would reject the same connections.`,
        meta: { view: "flow" },
      },
      {
        id: "payments",
        label: "Payments service",
        kind: "service",
        health: c.admittedPct > 0 ? "crit" : rejectedHealth,
        utilization: clamp(c.rate / MAX_RATE),
        throughput: c.rate * (1 - c.rejectedPct / 100),
        sublabel: c.admittedPct > 0 ? "plaintext reached the workload" : "identity verified",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-gateway", "clients", "gateway", c.rate / MAX_RATE, "ok"),
      edge("gateway-checkout", "gateway", "checkout", c.rate / MAX_RATE, rejectedHealth),
      edge("checkout-sidecar", "checkout", "sidecar", c.rate / MAX_RATE, sidecarHealth),
      edge("sidecar-payments", "sidecar", "payments", c.rate / MAX_RATE, c.admittedPct > 0 ? "crit" : rejectedHealth),
    ],
    metrics: [
      metric("plaintext-admitted", "Plaintext admitted", c.admittedPct, "%", 0.1, 1, "percent"),
      metric("handshake-rejected", "Handshakes rejected", c.rejectedPct, "%", 1, 5, "percent"),
      metric("identity-gap", "Traffic without an identity", c.identityGapPct, "%", 1, 5, "percent"),
      metric("error-rate", "User error rate", c.errorRate, "%", 1, 5, "percent"),
      metric("p99", "Request p99", c.p99, "ms", 250, 400, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, mode: c.mode, strict: c.strictPct, admitted: c.admittedPct, rejected: c.rejectedPct },
    summary: `${c.mode} mTLS across ${c.hops} hop(s): ${c.admittedPct.toFixed(1)}% plaintext admitted, ${c.rejectedPct.toFixed(1)}% rejected, ${c.errorRate.toFixed(1)}% errors.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  if (c.admittedPct > 0) {
    items.push(`${c.admittedPct.toFixed(1)}% of requests reach a workload without a verified certificate identity. Success responses do not prove that mTLS is enforced.`);
  }
  if (c.rejectedPct > 0) {
    items.push(`${c.rejectedPct.toFixed(1)}% of plaintext callers hit a strict hop and fail the handshake. That is the availability cost of enforcement.`);
  }
  if (c.mode === "mixed") {
    items.push(`Only ${(100 * (c.strictPct / 100) ** c.hops).toFixed(1)}% of paths are strict at every hop. One permissive hop is enough to admit plaintext.`);
  }
  items.push("mTLS proves who the peer is. It does not decide which method or path that identity may use; that is an authorization policy.");
  items.push("Kuma issues a SPIFFE-compatible certificate per data plane proxy and extracts the identity from the certificate SAN when authorization policy is evaluated.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "plaintext-admitted",
    metricId: "plaintext-admitted",
    warn: 0.1,
    crit: 1,
    title: "Plaintext traffic is reaching a workload",
    cause: "At least one sidecar on the path is in PERMISSIVE mode, or the plaintext connection bypasses the mesh entirely. Permissive mode accepts both TLS and plaintext inbound connections.",
    fix: "Find the permissive scope, inventory the callers that still send plaintext, and move that scope to STRICT after the callers are migrated. Keep permissive only as a time-boxed migration state.",
    checkFirst: [
      "Check the mTLS mode on each hop, not just the mesh-wide default.",
      "Check whether the caller connects to the workload directly instead of the service name or gateway.",
      "Check the destination proxy config dump for the inbound TLS context.",
    ],
  },
  {
    id: "handshake-rejected",
    metricId: "handshake-rejected",
    warn: 1,
    crit: 5,
    title: "Strict mTLS is rejecting callers",
    cause: "A caller does not present a trusted certificate. Common causes are a workload outside the mesh, a legacy client, a missing sidecar, or a certificate signed by a trust bundle the destination does not accept.",
    fix: "Do not turn strict mode off to clear the alert. Identify the caller identity, enroll it in the mesh or route it through a gateway, and verify that both sides share the expected trust bundle.",
    checkFirst: [
      "Which source workloads are producing the handshake failures?",
      "Is the caller inside the mesh, or does it reach the pod directly?",
      "Do the client and server trust the same root?",
    ],
  },
  {
    id: "identity-gap",
    metricId: "identity-gap",
    warn: 1,
    crit: 5,
    title: "Traffic is arriving without a mesh identity",
    cause: "The client is not presenting a certificate. This is the precondition for both a rejected handshake and an admitted plaintext request, so it is the earliest signal of a coverage gap.",
    fix: "Close the identity gap at the source: enroll the workload, attach the sidecar, or move the legacy integration behind an ingress gateway that terminates TLS and re-originates mTLS.",
    checkFirst: [
      "Compare the set of workloads sending traffic with the set enrolled in the mesh.",
      "Check for direct pod addresses or bypass annotations.",
      "Check whether the client uses a protocol the proxy cannot intercept.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const mtlsModel: SimModel = {
  id: "mesh-mtls",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const jitter = frame.t === 0 ? 0 : rng.between(-1.5, 1.5);
    const computed = compute(p, jitter);
    const next = buildFrame(computed, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    for (const node of next.nodes) recordSeries(next, `load.${node.id}`, (node.utilization ?? 0) * 100);
    if (computed.admittedPct > 0 && frame.flags.admittedSeen !== 1) {
      pushEvent(next, {
        id: "plaintext-admitted",
        at: frame.t,
        severity: "crit",
        title: "Plaintext connection admitted",
        detail: `${computed.admittedPct.toFixed(1)}% of requests reached a workload without a verified certificate. The request succeeded, so success metrics alone will not show this.`,
        nodeId: "sidecar",
        metricId: "plaintext-admitted",
      });
      next.flags.admittedSeen = 1;
    }
    if (computed.rejectedPct > 0 && frame.flags.rejectedSeen !== 1) {
      pushEvent(next, {
        id: "handshake-rejected",
        at: frame.t,
        severity: "warn",
        title: "Strict hop rejected plaintext callers",
        detail: `${computed.rejectedPct.toFixed(1)}% of requests failed before reaching the service because the caller did not present a trusted certificate.`,
        nodeId: "checkout",
        metricId: "handshake-rejected",
      });
      next.flags.rejectedSeen = 1;
    }
    next.summary = `${computed.mode} mTLS across ${computed.hops} hop(s): ${computed.admittedPct.toFixed(1)}% plaintext admitted, ${computed.rejectedPct.toFixed(1)}% rejected, ${computed.errorRate.toFixed(1)}% errors.`;
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
    description: "Every hop is strict, every caller has a certificate, and no traffic is admitted without an identity.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, strictShare: 100, plaintextShare: 0, meshHops: 2 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Twice the traffic with 2% legacy callers. Strict mode rejects them, so the error budget takes the hit.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, strictShare: 100, plaintextShare: 2, meshHops: 2 }),
  },
  {
    id: "failure",
    label: "Permissive mesh",
    description: "The mesh is permissive and 40% of callers send plaintext. Every request succeeds, and 40% arrive without an identity.",
    tone: "crit",
    params: defaults({ requestRate: 6_000, strictShare: 0, plaintextShare: 40, meshHops: 2 }),
  },
  {
    id: "recovery",
    label: "Strict after migration",
    description: "Callers were migrated, then the mesh moved to strict. No plaintext is admitted and no handshake is rejected.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, strictShare: 100, plaintextShare: 0, meshHops: 2 }),
  },
  {
    id: "mixed",
    label: "Half migrated",
    description: "Half the hops are strict and 10% of callers still send plaintext. The gap is both a security signal and an error signal.",
    tone: "warn",
    params: defaults({ requestRate: 8_000, strictShare: 50, plaintextShare: 10, meshHops: 2 }),
  },
];

const experiment: Experiment = {
  id: "predict-permissive",
  title: "Predict the permissive dashboard",
  simId: "mtls",
  question:
    "A namespace switches to PERMISSIVE mTLS. Forty percent of its callers still send plaintext. What does the mesh report?",
  prediction: {
    options: [
      { id: "errors", label: "Requests fail the handshake and the user error rate rises" },
      { id: "flat", label: "Requests succeed and the error rate stays flat; a plaintext-admitted signal moves" },
      { id: "upgrade", label: "The proxy upgrades plaintext connections to mTLS automatically" },
      { id: "authz", label: "Only unauthenticated write methods are rejected" },
    ],
    correctOptionId: "flat",
    explanation:
      "PERMISSIVE mode encrypts outbound connections but accepts both TLS and plaintext on the inbound side. The plaintext calls succeed, so request success and latency stay healthy. The only signal is that traffic reached the workload without a verified identity. That is why permissive mode is a migration aid, not a security end state.",
  },
  setup: defaults({ requestRate: 6_000, strictShare: 0, plaintextShare: 40, meshHops: 2 }),
  runFor: 20,
  observe: [
    "Plaintext admitted is 40% while handshakes rejected stays at zero.",
    "The user error rate stays at zero and the p99 does not move.",
    "The destination sidecar is marked critical, but the service response metrics look normal.",
    "The event feed records a plaintext connection admitted, not a failed request.",
  ],
  explain:
    "Permissive mode accepts two inbound paths. A caller with a certificate gets mTLS; a caller without one gets plaintext. Both produce successful responses, so the availability dashboard is green. The identity gap is the incident: 40% of requests have no authenticated peer identity, and any authorization policy that depends on that identity cannot distinguish them.",
  fix: defaults({ requestRate: 6_000, strictShare: 100, plaintextShare: 0, meshHops: 2 }),
  debrief:
    "A strict policy converts the hidden gap into visible handshake failures until the callers are migrated. That is the intended trade: fail the unmigrated caller now, or accept unidentified traffic indefinitely. In practice, inventory the callers first, migrate them namespace by namespace, and keep permissive mode time-boxed.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Mutual TLS (mTLS) is TLS where both peers present a certificate. The client proves its identity to the server and the server proves its identity to the client. A service mesh issues a short-lived certificate to each data plane proxy, so the identity is tied to the workload rather than to an IP address. Kuma issues SPIFFE-compatible certificates whose subject alternative name is `spiffe://MESH/SERVICE` and extracts that identity when authorization policy is evaluated.",
  },
  {
    type: "p",
    text: "mTLS is configured at two levels. The mesh enables a certificate authority backend; a per-workload policy chooses STRICT or PERMISSIVE mode. Strict mode accepts only TLS with a trusted client certificate. Permissive mode accepts both TLS and plaintext inbound connections so existing callers keep working during a migration. Kuma documents permissive mode as a temporary migration utility, not a secure end state.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The usual path is client, ingress or mesh gateway, source sidecar, destination sidecar, workload. Each sidecar-to-sidecar hop has its own TLS context. A request that traverses four hops is authenticated only if every hop validates the peer; one permissive destination is enough to admit plaintext for that segment. mTLS is also separate from authorization: Kuma denies traffic by default after mTLS is enabled unless an authorization policy such as MeshTrafficPermission allows it.",
  },
  {
    type: "compare",
    leftTitle: "STRICT",
    rightTitle: "PERMISSIVE",
    rows: [
      { label: "Inbound plaintext", left: "Rejected at the proxy", right: "Accepted and forwarded" },
      { label: "Caller without a certificate", left: "Handshake failure, no request", right: "Request succeeds without an identity" },
      { label: "Dashboard signal", left: "Errors and handshake failures are visible", right: "Success metrics stay green" },
      { label: "Best use", left: "The steady state after migration", right: "A time-boxed migration window" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Plaintext admitted: the share of requests that reach a workload without a verified certificate, with a critical threshold at 1%.",
      "Handshakes rejected: the share of callers that strict mode turns away, with a critical threshold at 5%.",
      "Traffic without an identity: the coverage gap before enforcement decides whether to reject or admit it.",
      "A flow view of clients, the mesh gateway, the source service, the destination sidecar, and the workload.",
      "Mode labels on the destination sidecar and events when plaintext is admitted or a strict hop rejects a caller.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and confirm that all hops are strict. Apply Permissive mesh: plaintext admitted rises to 40% while the error rate stays at zero. Then apply Strict after migration to see the same callers rejected instead. Run the experiment before opening the debrief.",
  },
  {
    type: "table",
    headers: ["Signal", "Healthy", "Failure"],
    rows: [
      ["Plaintext admitted", "0%", "40% with permissive mode"],
      ["Handshake rejected", "0%", "Rises only after strict mode is enforced"],
      ["User error rate", "Low", "Zero in the permissive failure, because the requests succeed"],
      ["Identity coverage", "100% of callers", "60% of callers in the failure preset"],
    ],
  },
  { type: "sim", simId: "mtls" },
  { type: "experiment", experimentId: "predict-permissive" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The permissive failure preset admitted 40% of requests without a certificate and still returned successful responses. Nothing in the request rate, error rate, or latency showed the gap. The destination sidecar and the plaintext-admitted metric carried the only warning. When the same traffic met a strict hop, those callers failed the handshake and the error rate moved instead.",
  },
  {
    type: "p",
    text: "The half-migrated preset shows the compounding rule: a two-hop path with 50% strict coverage authenticates only 25% of paths end to end. Plaintext is admitted if any hop on the path is permissive. Coverage is a property of the whole path, not of the mesh default.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Proxy TLS counters on the destination listener, including handshake successes, certificate verification failures, and connection errors.",
      "Envoy config dump on the affected sidecar: the inbound TLS context and the transport socket tell you whether the listener asks for a client certificate.",
      "Kuma inspection output for the proxy: matched mTLS policy, certificate issuance, and the last certificate regeneration time.",
      "Access logs that show whether a request arrived over TLS, plus the source identity when it did.",
      "A control-plane view of which workloads match the strict policy and which still fall back to the mesh default.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the mode on the destination hop before checking the application. Confirm that the client is inside the mesh and reaches the service name rather than a pod address. Then compare the client and server trust bundles. A valid certificate from the wrong root fails exactly like no certificate at all.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Inventory every caller and every hop. Map which workload pairs are still plaintext and which policy scope covers them.",
      "Add the authorization policy before enforcing mTLS, so enabling strict mode does not also remove legitimate access.",
      "Move one namespace or service to strict, watch handshake failures, and keep a documented rollback path for the migration window.",
      "Enroll legacy workloads in the mesh, or route them through a gateway that terminates TLS and re-originates mTLS.",
      "Alert on plaintext admitted as a security signal and on handshake failures as an availability signal. They have different owners.",
      "Remove permissive mode when the migration is complete, and record the date and the remaining exceptions.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Permissive mode shortens a migration but hides the security gap. The longer it stays on, the less anyone trusts the identity signal.",
      "Strict mode is honest but breaks unmigrated callers immediately. The failure is visible, which is the point, but it is still an outage for them.",
      "mTLS adds handshakes, certificate rotation, and CPU cost on every hop. The cost is small per request and compounds with hop count.",
      "Authentication is not authorization. A valid certificate proves the peer, not that the peer should call this method.",
      "A mesh-wide default is easier to reason about than per-workload exceptions, but exceptions are where plaintext survives.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "green-dashboard",
    question:
      "The service dashboard is green, but a compliance check finds plaintext traffic inside the mesh. How do you find it?",
    difficulty: 3,
    hints: [
      "Success metrics cannot distinguish an authenticated request from an admitted one.",
      "Think per hop, not mesh-wide.",
    ],
    answer:
      "I would start with the mTLS mode on the destination hop and the policy scope that selects it. A permissive destination accepts both TLS and plaintext, so the request succeeds and the error rate stays flat. I would inspect the sidecar's inbound TLS context, check whether the client is enrolled in the mesh, and confirm that the client reaches the service name rather than a pod address. Then I would compare the plaintext connection count with the total request count to size the gap. The fix is to migrate the callers and move that scope to strict, not to leave permissive mode on because the dashboard looks healthy.",
    followUps: [
      "Which metric would you alert on?",
      "How would you prove the fix without reading application code?",
      "What if the caller is a managed service outside the mesh?",
    ],
    redFlags: [
      "Checks only the mesh-wide default.",
      "Treats a successful response as proof of mTLS.",
      "Disables strict mode to clear errors.",
    ],
    rubric: [
      "Checks per-hop mode and scope.",
      "Separates success from identity.",
      "Inspects proxy config or certificates.",
      "Names a migration action.",
    ],
  },
  {
    id: "strict-rollout",
    question:
      "How would you move a production mesh from permissive to strict mTLS without taking down a legacy caller?",
    difficulty: 3,
    hints: [
      "You need both a caller inventory and an authorization policy.",
      "Make the change observable before you make it global.",
    ],
    answer:
      "I would inventory the callers and the policy scope first, then add the authorization policy that legitimate traffic needs. I would move one namespace or service to strict, watch handshake failures and request errors, and keep permissive mode on the remaining scopes for a bounded window. Legacy callers get enrolled or routed through a gateway that terminates TLS and re-originates mTLS. I would alert on both plaintext admitted and handshake failures, because one is a security gap and the other is an availability regression. Once the failure count is zero and the inventory is closed, I would remove permissive mode and record any permanent exceptions.",
    followUps: [
      "What would make you pause the rollout?",
      "How long is too long for a permissive window?",
      "Who owns the legacy caller?",
    ],
    redFlags: [
      "Flips the whole mesh at once.",
      "Enables mTLS before authorization policy exists.",
      "Keeps permissive mode indefinitely.",
    ],
    rubric: [
      "Inventories callers and scope.",
      "Sequences authorization before enforcement.",
      "Uses a canary and a rollback.",
      "Defines an exit from permissive.",
    ],
  },
  {
    id: "mtls-vs-authz",
    question:
      "A team says mTLS is their authorization control. What is missing from that statement, and what would you add?",
    difficulty: 2,
    hints: [
      "Identity answers who, not what.",
      "Think about method, path, and tenant.",
    ],
    answer:
      "mTLS authenticates the peer and encrypts the connection. It does not decide whether that peer may call a specific method, path, or tenant. A workload with a valid certificate can still call an endpoint it should not. I would add an authorization policy that matches the verified identity and the request attributes, deny by default, and keep the certificate lifecycle healthy. Network policy is also not a substitute: it controls reachability at L3 and L4, while authorization decides at the application protocol layer.",
    followUps: [
      "Where would you enforce the policy: proxy or application?",
      "How do you handle a shared service identity?",
      "What happens when a certificate is valid but the workload is compromised?",
    ],
    redFlags: [
      "Treats encryption as authorization.",
      "Uses IP allowlists as the only control.",
      "Has no deny-by-default posture.",
    ],
    rubric: [
      "Separates authentication from authorization.",
      "Names request attributes.",
      "Mentions deny by default.",
      "Recognizes compromised-identity limits.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every workload has an owner, a mesh enrollment, and a documented mTLS mode.",
      "Authorization policy exists before strict mTLS is enforced.",
      "Dashboards show plaintext admitted and handshake failures, not just request success.",
      "Certificate expiry and rotation are monitored per data plane proxy.",
      "Legacy callers have a documented path into the mesh or through a gateway.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the mode and trust bundle on the destination hop before changing the application.",
      "Separate plaintext admitted from handshake rejected; they have different causes.",
      "Confirm whether the caller reaches the service name or a pod address.",
      "If strict mode is breaking a caller, enroll or route the caller instead of disabling strict globally.",
      "Record which policy scope changed and when the proxies received it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Close the identity gap at the source and remove the temporary permissive scope.",
      "Add a synthetic plaintext probe that should fail in strict mode.",
      "Review certificate rotation and trust-bundle expiry dates.",
      "Verify that authorization policy still matches the intended identities.",
      "Document the migration window and any permanent exceptions.",
    ],
  },
];

const references = [
  {
    title: "Kuma mutual TLS",
    url: "https://kuma.io/docs/latest/policies/mutual-tls/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Certificate backends, SPIFFE-compatible identities, permissive mode, and certificate rotation.",
  },
  {
    title: "Kuma MeshTLS",
    url: "https://kuma.io/docs/latest/policies/meshtls/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Per-service STRICT and PERMISSIVE modes and the policy that selects them.",
  },
  {
    title: "SPIFFE concepts",
    url: "https://spiffe.io/docs/latest/spiffe-about/spiffe-concepts/",
    publisher: "SPIFFE",
    kind: "docs" as const,
    note: "Workload identity, trust domains, and the SPIFFE ID used in certificate identities.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    mtls: {
      model: mtlsModel,
      presets,
      instructions:
        "Start Healthy, apply Permissive mesh, then Strict after migration. Compare plaintext admitted with handshake rejected and watch the user error rate.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Plaintext shares, hop counts, and the relationship between strict coverage and admission are teaching values, not Kuma or Envoy defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-kuma-control-plane", "mesh-cert-rotation", "cloud-networking-zero-trust", "mesh-ingress"],
};
