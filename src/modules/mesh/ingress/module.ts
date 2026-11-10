import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, SimState, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const GATEWAY_CAPACITY_PER_REPLICA = 8_000;

const params = [
  {
    id: "requestRate",
    label: "External request rate",
    min: 1_000,
    max: 30_000,
    step: 1_000,
    value: 10_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests arriving from outside the mesh. The share that bypasses the gateway is removed from gateway load.",
    format: "rps" as const,
  },
  {
    id: "bypassShare",
    label: "Traffic bypassing the gateway",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Exposure",
    help: "Share of external requests that reach a pod IP directly instead of entering through the gateway.",
    format: "percent" as const,
  },
  {
    id: "tlsMode",
    label: "Gateway TLS mode",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Gateway",
    help: "0 accepts plaintext, 1 allows TLS or plaintext, 2 requires TLS on the gateway listener. Bypass traffic is unaffected.",
    format: "number" as const,
  },
  {
    id: "gatewayReplicas",
    label: "Gateway replicas",
    min: 1,
    max: 6,
    step: 1,
    value: 3,
    unit: " pods",
    group: "Capacity",
    help: "Gateway pods, each with an illustrative capacity of 8,000 rps at the latency target.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Computed {
  requestRate: number;
  bypass: number;
  tlsMode: number;
  replicas: number;
  gatewayRps: number;
  gatewayUtil: number;
  p99: number;
  coverage: number;
  gap: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 12_000));
  const bypass = clamp(num(p, "bypassShare", 20), 0, 100) / 100;
  const tlsMode = Math.round(clamp(num(p, "tlsMode", 2), 0, 2));
  const replicas = Math.max(1, Math.round(num(p, "gatewayReplicas", 2)));
  const gatewayRps = requestRate * (1 - bypass);
  const gatewayUtil = (gatewayRps / (replicas * GATEWAY_CAPACITY_PER_REPLICA)) * 100;
  const p99 = Math.min(5_000, 12 + Math.max(0, gatewayUtil - 60) ** 2 * 0.08);
  const tlsCoverage = tlsMode === 2 ? 1 : tlsMode === 1 ? 0.5 : 0;
  const coverage = (1 - bypass) * tlsCoverage * 100;
  return {
    requestRate,
    bypass,
    tlsMode,
    replicas,
    gatewayRps,
    gatewayUtil,
    p99,
    coverage,
    gap: 100 - coverage,
  };
}

function gatewayHealth(c: Computed): SimState {
  if (c.gatewayUtil >= 90 || c.p99 >= 150) return "crit";
  if (c.gatewayUtil >= 75 || c.p99 >= 50) return "warn";
  return "ok";
}

function policyHealth(gap: number): SimState {
  if (gap >= 30) return "crit";
  if (gap >= 10) return "warn";
  return "ok";
}

function bypassHealth(bypass: number): SimState {
  if (bypass >= 0.15) return "crit";
  if (bypass >= 0.05) return "warn";
  return "ok";
}

function buildFrame(c: Computed, seed: number): SimFrame {
  const gateway = gatewayHealth(c);
  const policy = policyHealth(c.gap);
  const direct = bypassHealth(c.bypass);
  return {
    t: 0,
    nodes: [
      {
        id: "external",
        label: "External client",
        kind: "client",
        health: "ok",
        utilization: clamp(c.requestRate / 30_000),
        throughput: c.requestRate,
        sublabel: `${c.requestRate.toLocaleString()} rps`,
        meta: { view: "flow" },
      },
      {
        id: "gateway",
        label: "Ingress gateway",
        kind: "mesh",
        health: gateway,
        utilization: clamp(c.gatewayUtil / 100),
        throughput: c.gatewayRps,
        sublabel: `${c.replicas} pods · TLS ${c.tlsMode === 2 ? "required" : c.tlsMode === 1 ? "optional" : "off"}`,
        detail: `Illustrative model: ${Math.round(c.gatewayRps).toLocaleString()} rps through ${c.replicas} gateway pods. Each pod is sized for 8,000 rps.`,
        meta: { view: "flow" },
      },
      {
        id: "service",
        label: "Checkout service",
        kind: "service",
        health: policy,
        utilization: clamp(c.coverage / 100),
        throughput: c.gatewayRps,
        sublabel: `${Math.round(c.coverage)}% policy coverage`,
        detail: `Coverage counts gateway traffic that is both routed through the gateway and protected by required TLS. Bypass traffic is outside this number.`,
        meta: { view: "flow" },
      },
      {
        id: "pod-ip",
        label: "Pod IP path",
        kind: "service",
        health: direct,
        utilization: clamp(c.bypass),
        throughput: c.requestRate * c.bypass,
        sublabel: c.bypass > 0 ? `${Math.round(c.bypass * 100)}% bypass` : "closed",
        detail: c.bypass > 0
          ? `${Math.round(c.requestRate * c.bypass).toLocaleString()} rps reach pods without the gateway, its TLS terminator, or its policy checks.`
          : "No external traffic reaches pod IPs in this view.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("external-gateway", "external", "gateway", clamp(c.gatewayRps / 30_000), gateway),
      edge("gateway-service", "gateway", "service", clamp(c.gatewayRps / 30_000), policy),
      edge("external-pod", "external", "pod-ip", clamp(c.requestRate * c.bypass / 30_000), direct),
    ],
    metrics: [
      metric("gap", "Policy coverage gap", c.gap, "%", 10, 30, "percent"),
      metric("bypass", "Requests bypassing gateway", c.bypass * 100, "%", 5, 15, "percent"),
      metric("gateway-util", "Gateway capacity use", c.gatewayUtil, "%", 75, 90, "percent"),
      metric("gateway-p99", "Gateway p99", c.p99, "ms", 50, 150, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      bypass: c.bypass,
      tls: c.tlsMode,
      coverage: c.coverage,
    },
    summary: `${Math.round(c.gatewayRps).toLocaleString()} rps through the gateway, ${Math.round(c.bypass * 100)}% bypassing it. Policy coverage ${Math.round(c.coverage)}%, gateway ${Math.round(c.gatewayUtil)}% utilized.`,
  };
}

function insightsFor(c: Computed): string[] {
  const items: string[] = [];
  items.push(`${Math.round(c.gatewayRps).toLocaleString()} rps enter through the gateway; ${Math.round(c.requestRate * c.bypass).toLocaleString()} rps reach pod IPs directly. The direct path never sees the gateway's TLS or policy.`);
  items.push(`Policy coverage is ${Math.round(c.coverage)}%. Bypass and optional TLS both create gaps: required TLS covers gateway traffic, but nothing covers traffic that skips the gateway.`);
  items.push(`Gateway load is ${Math.round(c.gatewayUtil)}% across ${c.replicas} pods. A bypass reduces gateway load, which can make the gateway look healthier while more traffic escapes policy.`);
  items.push("An ingress gateway is not only a load balancer. It terminates external TLS, applies host and path routing, and gives you one place to enforce authentication and rate limits.");
  items.push("A NetworkPolicy or an equivalent firewall rule must block pod IPs from outside the mesh. Without it, a Service type or a routable pod network creates a second front door.");
  items.push("Kuma ingress and Envoy Gateway both program a data-plane proxy from gateway resources. The policy is only as strong as the set of paths that reach the proxy.");
  return items;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "gap",
    metricId: "gap",
    warn: 10,
    crit: 30,
    title: "Policy coverage is incomplete",
    cause: "Some external traffic bypasses the gateway or is accepted without required TLS. The mesh policy never sees those requests.",
    fix: "Close bypass paths with network policy and expose only the gateway. Require TLS on the gateway listener and redirect or reject plaintext.",
    checkFirst: [
      "List every external entry point: gateway, Service type, node port, direct pod IP.",
      "Check whether pods are reachable from outside the mesh network.",
      "Check the gateway listener's TLS requirement and redirect policy.",
    ],
  },
  {
    id: "bypass",
    metricId: "bypass",
    warn: 5,
    crit: 15,
    title: "Traffic is reaching pods directly",
    cause: "A bypass path exists, such as a direct pod IP, a node port, or a service that is exposed outside the gateway. It defeats gateway TLS, routing, and observability.",
    fix: "Block direct external access to pod IPs and close the alternate entry point. Route all external traffic through the gateway.",
    checkFirst: [
      "Check whether the pod network is routable from outside.",
      "Check Service types and node ports for the workload.",
      "Check whether a legacy or debug path is still exposed.",
    ],
  },
  {
    id: "gateway-util",
    metricId: "gateway-util",
    warn: 75,
    crit: 90,
    title: "Gateway demand exceeds its capacity",
    cause: "Gateway replicas are sized for less traffic than they receive, or a replica was lost. TLS handshakes and policy checks add CPU cost.",
    fix: "Add gateway replicas or reduce per-replica load. Check whether a replica is unhealthy before scaling.",
    checkFirst: [
      "Compare gateway rps per replica with capacity.",
      "Check replica readiness and restarts.",
      "Check TLS handshake rate and connection churn.",
    ],
  },
  {
    id: "gateway-p99",
    metricId: "gateway-p99",
    warn: 50,
    crit: 150,
    title: "Gateway latency breached the edge budget",
    cause: "Queueing at the gateway adds to every request before it reaches the mesh. The cause can be CPU, TLS handshakes, or upstream slowness.",
    fix: "Scale the gateway or reduce handshake and connection churn. Check whether the tail comes from the gateway or the upstream.",
    checkFirst: [
      "Compare gateway duration with upstream duration.",
      "Check CPU and connection counts per replica.",
      "Check TLS session reuse and handshake rate.",
    ],
  },
];

export const meshIngressModel: SimModel = {
  id: "mesh-ingress",
  visual: "topology",
  params,
  init: ({ seed }) => buildFrame(compute(defaults()), seed),
  step: (frame, p, _dt, rng) => {
    const c = compute(p);
    const jittered = { ...c, p99: Math.max(1, c.p99 * (1 + rng.between(-0.01, 0.01))) };
    const next = buildFrame(jittered, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = frame.events;
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (c.bypass >= 0.15 && frame.flags.bypassSeen !== 1) {
      pushEvent(next, {
        id: "ingress-bypass",
        at: frame.t,
        severity: "crit",
        title: "External traffic is bypassing the gateway",
        detail: `${Math.round(c.bypass * 100)}% of requests reach pod IPs directly. They skip TLS, routing, rate limits, and the mesh policy at the edge.`,
        nodeId: "pod-ip",
        metricId: "gap",
      });
      next.flags.bypassSeen = 1;
    }
    if (c.tlsMode === 0 && frame.flags.tlsSeen !== 1) {
      pushEvent(next, {
        id: "ingress-plaintext",
        at: frame.t,
        severity: "warn",
        title: "Gateway accepts plaintext",
        detail: "The listener does not require TLS. Credentials and request data can cross the network in clear text.",
        nodeId: "gateway",
        metricId: "gap",
      });
      next.flags.tlsSeen = 1;
    }
    if (c.gatewayUtil >= 90 && frame.flags.capacitySeen !== 1) {
      pushEvent(next, {
        id: "ingress-capacity",
        at: frame.t,
        severity: "warn",
        title: "Gateway is above 90% capacity",
        detail: `${Math.round(c.gatewayRps).toLocaleString()} rps across ${c.replicas} replicas. Add capacity or reduce per-replica load.`,
        nodeId: "gateway",
        metricId: "gateway-util",
      });
      next.flags.capacitySeen = 1;
    }
    next.summary = `${Math.round(c.gatewayRps).toLocaleString()} rps through the gateway, ${Math.round(c.bypass * 100)}% bypassing it. Policy coverage ${Math.round(c.coverage)}%, gateway ${Math.round(c.gatewayUtil)}% utilized.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => insightsFor(compute(p)),
  legend: [
    { label: "Covered", tone: "ok" },
    { label: "Partial", tone: "warn" },
    { label: "Exposed", tone: "crit" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "All external traffic enters through the gateway, TLS is required, and three replicas have headroom.",
    tone: "ok",
    params: defaults({ requestRate: 10_000, bypassShare: 0, tlsMode: 2, gatewayReplicas: 3 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Twenty-two thousand rps at the edge. Three gateways are near the warning line but still serving.",
    tone: "warn",
    params: defaults({ requestRate: 22_000, bypassShare: 5, tlsMode: 2, gatewayReplicas: 3 }),
  },
  {
    id: "failure",
    label: "Bypassed edge",
    description: "Most external traffic reaches pod IPs directly, and the gateway accepts plaintext. Policy sees a small slice.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, bypassShare: 60, tlsMode: 0, gatewayReplicas: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The bypass is closed, TLS is required, and gateway capacity is restored.",
    tone: "ok",
    params: defaults({ requestRate: 12_000, bypassShare: 0, tlsMode: 2, gatewayReplicas: 3 }),
  },
  {
    id: "plaintext",
    label: "Plaintext gateway",
    description: "Every request uses the gateway, but the listener does not require TLS. Coverage is still zero.",
    tone: "crit",
    params: defaults({ requestRate: 12_000, bypassShare: 0, tlsMode: 0, gatewayReplicas: 3 }),
  },
];

const experiment: Experiment = {
  id: "scanner-reaches-pod-ip",
  title: "The second front door",
  simId: "mesh-ingress",
  question:
    "Strict mTLS is enabled for the mesh. An external scanner still reaches a checkout pod IP on port 8080 and gets a 200 response. The gateway requires TLS and reports no errors. What explains the result?",
  prediction: {
    options: [
      { id: "cert", label: "The pod's certificate expired, so mTLS fell back to plaintext" },
      { id: "bypass", label: "The scanner used a direct pod path that never passed through the gateway or mesh policy" },
      { id: "dns", label: "The scanner resolved the gateway name to the wrong IP" },
      { id: "mtls", label: "Strict mTLS does not cover HTTP ports, so port 8080 is expected to be open" },
    ],
    correctOptionId: "bypass",
    explanation:
      "The scanner reached a direct pod path. That traffic never entered the gateway or the mesh proxy, so neither TLS policy nor mTLS could apply.",
  },
  setup: defaults({ requestRate: 12_000, bypassShare: 50, tlsMode: 2, gatewayReplicas: 2 }),
  runFor: 20,
  observe: [
    "Half of external traffic reaches the pod IP path and never enters the gateway.",
    "Gateway error rate and latency stay healthy because the bypass traffic is invisible there.",
    "Policy coverage falls to 50% even though the gateway requires TLS.",
    "The exposure is a path problem, not a certificate problem.",
  ],
  explain:
    "mTLS protects connections that go through the mesh data plane. A request sent directly to a pod IP, or to a port excluded from proxy interception, does not traverse the gateway or the sidecar policy. The gateway can be perfectly configured and still see only half the traffic. Closing the gap requires a network control that blocks external access to pod IPs, plus exposing only the gateway.",
  fix: defaults({ requestRate: 12_000, bypassShare: 0, tlsMode: 2, gatewayReplicas: 3 }),
  debrief:
    "Enumerate every external path before trusting a policy. A gateway, a load balancer, a node port, and a routable pod network can all be front doors. mTLS authenticates mesh peers; it does not close a path that never reaches the mesh proxy. Combine the gateway with NetworkPolicy or an equivalent firewall rule, and test from outside the cluster.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An ingress gateway is the controlled entry point for traffic entering a service mesh from outside. It terminates external TLS, matches host and path, applies authentication and rate limits, and forwards the request into the mesh. Kuma can run a built-in gateway or a delegated gateway, and Envoy Gateway programs an Envoy data plane from Gateway API resources. The gateway is a proxy with an edge policy, not just a load balancer.",
  },
  {
    type: "p",
    text: "The security value comes from covering every external path. A gateway can require TLS and enforce policy on the traffic it sees, while a direct pod IP, a node port, or an exposed Service quietly serves the same workload without those checks. The gateway's dashboards then look healthy because the risky traffic never reaches them.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The intended path is external client, DNS or load balancer, ingress gateway, mesh service, pod. The bypass path is external client to pod IP or node port, skipping the gateway and often the sidecar. Mesh mTLS protects service-to-service connections that pass through the proxy; it does not protect a port that is reached outside the proxy's interception.",
  },
  {
    type: "compare",
    leftTitle: "Through the gateway",
    rightTitle: "Direct to a pod",
    rows: [
      { label: "TLS", left: "Terminated at a controlled listener", right: "Whatever the pod port exposes" },
      { label: "Policy", left: "Authentication, rate limit, routing", right: "None at the edge" },
      { label: "Observability", left: "Gateway access logs and metrics", right: "Invisible to the gateway" },
      { label: "Failure", left: "Gateway capacity and config", right: "Pod exposure and network reachability" },
    ],
  },
  {
    type: "p",
    text: "TLS mode matters. A listener that accepts plaintext or makes TLS optional still leaves a gap, even when every request uses the gateway. Requiring TLS and redirecting or rejecting plaintext closes that part of the path. After that, the remaining question is whether any traffic can reach the workload without passing the listener.",
  },
  {
    type: "p",
    text: "Gateway capacity is a separate concern. TLS handshakes, header parsing, and policy checks make the gateway a real compute tier. A bypass can make the gateway look underutilized while exposing the workload; closing the bypass can suddenly add load. Size the gateway for the traffic it should carry, not for the traffic it currently sees.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A topology view with an external client, gateway, service, and direct pod path.",
      "Policy coverage gap and bypass percentage as separate signals.",
      "Gateway CPU utilization and p99 latency with warning and critical thresholds.",
      "A bypass node that shows how much traffic never reaches the gateway.",
      "Events when a bypass or plaintext listener is detected.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and trace the external request through the gateway. Apply Bypassed edge and compare the gateway's healthy local view with the policy coverage gap. Then apply Plaintext gateway to isolate the TLS control. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "table",
    headers: ["Control", "What it covers", "What it does not cover"],
    rows: [
      ["Gateway TLS", "Traffic through the gateway listener", "Direct pod or node-port paths"],
      ["Mesh mTLS", "Service-to-service connections through sidecars", "Ports that bypass proxy interception" ],
      ["NetworkPolicy", "Which pods and ports can be reached", "Application-layer authentication" ],
      ["Gateway routing", "Host, path, and header matching", "Traffic that never reaches it" ],
    ],
  },
  { type: "sim", simId: "mesh-ingress" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "A large share of external traffic reached pod IPs directly, so the gateway's TLS and policy covered only the remainder. The gateway looked healthy because the bypass traffic never entered it. Policy coverage fell with the bypass share, and the direct path stayed open regardless of how strict the mesh mTLS mode was.",
  },
  {
    type: "p",
    text: "With the bypass closed and TLS required, all external traffic passed through the gateway and coverage returned to 100%. Gateway load rose because it now carried the traffic it was supposed to carry. That is the expected tradeoff: a controlled edge is visible, policy-enforced, and sized for the whole path.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Gateway request rate that is lower than the service's total request rate, with no obvious internal source.",
      "Pod or node IPs reachable from outside the cluster network.",
      "A Service type of NodePort or LoadBalancer that exposes the workload without the gateway.",
      "Gateway TLS listener configuration and redirect behavior for plaintext requests.",
      "Policy coverage dashboards that count gateway traffic and silently exclude bypass traffic.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Enumerate external entry points before tuning the gateway. Compare total service request rate with gateway request rate. If the service sees more, find the path that did not go through the gateway. Then check the listener TLS requirement.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Block external access to pod IPs and node ports with NetworkPolicy or the cloud firewall.",
      "Expose the workload only through the gateway and remove alternate Service types.",
      "Require TLS on the gateway listener and reject or redirect plaintext.",
      "Add authentication and rate limits at the gateway, where every external request passes.",
      "Size gateway replicas for total external traffic, including traffic that previously bypassed it.",
      "Test the controls from outside the cluster, not from another pod.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A gateway adds a hop and a compute tier. It also gives you one place to enforce policy and observe external traffic.",
      "Strict TLS can break old clients that cannot negotiate modern protocols. A staged redirect is safer than an abrupt reject.",
      "NetworkPolicy is necessary and can be operationally complex in large clusters with many namespaces.",
      "Closing a bypass can reveal gateway capacity problems that the bypass was hiding.",
      "Mesh mTLS and gateway TLS serve different boundaries; neither replaces the other.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-bypass",
    question:
      "The service receives 20,000 rps but the ingress gateway reports 12,000. What are the possible paths for the missing traffic, and how do you find them?",
    difficulty: 3,
    hints: [
      "Start from the network path, not the gateway config.",
      "The missing traffic may never touch the mesh.",
    ],
    answer:
      "The missing 8,000 rps could be reaching pods through a node port, a LoadBalancer Service, a direct pod IP, or an internal caller that is not external traffic. I would compare the service's request rate with gateway and mesh telemetry, then enumerate Service types, node ports, and firewall rules. I would test from outside the cluster to each path and check whether the pod network is routable. The gateway config is probably fine; the coverage is not.",
    followUps: [
      "How would NetworkPolicy change the result?",
      "What if the missing traffic is east-west, not external?",
      "Which log would show the direct requests?",
    ],
    redFlags: [
      "Only reads gateway logs.",
      "Assumes the service metric is wrong.",
      "Scales the gateway first.",
    ],
    rubric: [
      "Enumerates alternate paths.",
      "Compares service and gateway rates.",
      "Tests from outside.",
      "Separates east-west from external.",
    ],
  },
  {
    id: "tls-vs-mtls",
    question:
      "What does gateway TLS protect that mesh mTLS does not, and what remains unprotected after both are enabled?",
    difficulty: 3,
    hints: [
      "They terminate at different boundaries.",
      "One can be bypassed by a path that skips the proxy.",
    ],
    answer:
      "Gateway TLS protects the connection from the external client to the edge listener. Mesh mTLS protects service-to-service connections through the sidecars and authenticates workload identity. Neither protects a request that reaches a pod port outside proxy interception. After both, I would still check for direct pod access, node ports, and ports excluded from the sidecar, and add network policy plus application authentication where needed.",
    followUps: [
      "Where does the client certificate terminate?",
      "How would you prove a port bypasses the sidecar?",
      "Is network location an identity?",
    ],
    redFlags: [
      "Treats mTLS as a complete edge control.",
      "Confuses encryption with authentication.",
      "Ignores non-mesh ports.",
    ],
    rubric: [
      "Separates the two boundaries.",
      "Names identity vs transport.",
      "Identifies bypass paths.",
      "Adds network policy.",
    ],
  },
  {
    id: "gateway-capacity",
    question:
      "After closing a bypass, the gateway p99 crosses its SLO. What do you check, and how do you size it?",
    difficulty: 4,
    hints: [
      "The gateway now carries traffic it never saw.",
      "TLS handshakes are part of the cost.",
    ],
    answer:
      "The first check is whether the added traffic was expected and whether the gateway has enough replicas. I would compare per-replica rps with measured capacity, check CPU, TLS handshake rate, and connection churn, and see whether the tail is at the gateway or upstream. I would size for total external peak plus headroom for one replica loss, then load-test the gateway with realistic TLS and policy. Scaling before checking the listener and handshake behavior can hide a configuration problem.",
    followUps: [
      "How does TLS session reuse change capacity?",
      "What headroom would you keep for a replica loss?",
      "How would you test the gateway without production traffic?",
    ],
    redFlags: [
      "Sizes for the old bypassed rate.",
      "Ignores TLS cost.",
      "Scales without a per-replica measurement.",
    ],
    rubric: [
      "Accounts for newly visible traffic.",
      "Measures per-replica capacity.",
      "Includes TLS cost.",
      "Plans for replica loss.",
    ],
  },
];

const checklist = [
  {
    title: "Before exposure",
    items: [
      "Enumerate every external entry point: gateway, Service type, node port, direct pod IP.",
      "Require TLS on the gateway listener and define plaintext behavior.",
      "Block external access to pod IPs and node ports with network policy.",
      "Add authentication and rate limits at the gateway.",
      "Size gateway replicas for total external peak plus one-replica headroom.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare total service request rate with gateway request rate.",
      "Find the path that bypasses the gateway before changing gateway config.",
      "Check listener TLS mode and redirect behavior.",
      "Check gateway CPU, p99, and TLS handshake rate.",
      "Test the suspect path from outside the cluster.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Close the alternate path and verify coverage from outside.",
      "Add a coverage metric that counts bypass traffic, not only gateway traffic.",
      "Re-size the gateway for the traffic it now carries.",
      "Document every approved external entry point.",
      "Re-test after new Services or debug ports are added.",
    ],
  },
];

const references = [
  {
    title: "Kuma ingress",
    url: "https://kuma.io/docs/latest/using-mesh/managing-ingress-traffic/overview/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Built-in and delegated ingress options for traffic entering the mesh.",
  },
  {
    title: "Envoy Gateway documentation",
    url: "https://gateway.envoyproxy.io/docs/",
    publisher: "Envoy Gateway",
    kind: "docs" as const,
    note: "Gateway API resources and the Envoy data plane at the edge.",
  },
  {
    title: "Kuma mutual TLS",
    url: "https://kuma.io/docs/latest/policies/mutual-tls/",
    publisher: "Kuma",
    kind: "docs" as const,
    note: "Mesh mTLS modes and what they protect between workloads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "mesh-ingress": {
      model: meshIngressModel,
      presets,
      instructions:
        "Start Healthy and trace the external request through the gateway. Apply Bypassed edge and compare gateway health with policy coverage. Apply Plaintext gateway to isolate TLS.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Gateway capacity, TLS behavior, and coverage are teaching values, not Kuma or Envoy defaults.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-mtls", "mesh-envoy-listeners", "mesh-envoy-routes", "cloud-networking-zero-trust", "mesh-access-logs"],
};
