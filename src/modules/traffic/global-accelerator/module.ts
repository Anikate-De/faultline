import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const EDGE_AND_PROCESSING_MS = 15;
const DNS_HEALTH_DETECTION_S = 30;
const GA_FAILOVER_S = 15;
const STALE_LATENCY_MS = 2_000;

const params: ParamSpec[] = [
  {
    id: "acceleratorEnabled",
    label: "Global Accelerator (0 bypassed, 1 in path)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 sends clients to the accelerator's static anycast IPs and then over the AWS backbone. 0 resolves the regional load balancer directly through DNS.",
    format: "count",
  },
  {
    id: "clientRttMs",
    label: "Client RTT to the primary region",
    min: 10,
    max: 300,
    step: 10,
    value: 40,
    unit: " ms",
    group: "Path",
    help: "Illustrative public-internet round-trip time from the client to the primary region. The model reduces the path to an edge plus backbone assumption when the accelerator is in use.",
    format: "ms",
  },
  {
    id: "dnsTtl",
    label: "DNS TTL when bypassed",
    min: 30,
    max: 600,
    step: 30,
    value: 300,
    unit: " s",
    group: "Failover",
    help: "Record TTL for the direct regional name. It applies only when the accelerator is bypassed; endpoint failover behind the accelerator does not wait for it.",
    format: "number",
  },
  {
    id: "primaryHealthy",
    label: "Primary endpoint healthy (0 fail, 1 healthy)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Failover",
    help: "1 keeps the primary endpoint healthy. 0 injects a primary failure so you can compare accelerator failover with DNS failover.",
    format: "count",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

interface Computed {
  ga: boolean;
  clientRtt: number;
  ttl: number;
  healthy: boolean;
  baseP99: number;
  failoverSeconds: number;
  elapsed: number;
  remaining: number;
  stale: boolean;
  failedPercent: number;
  p99: number;
  secondaryUtil: number;
}

function compute(p: Params, t: number, incidentStart: number): Computed {
  const ga = num(p, "acceleratorEnabled", 1) >= 0.5;
  const clientRtt = Math.max(10, num(p, "clientRttMs", 40));
  const ttl = Math.max(30, num(p, "dnsTtl", 300));
  const healthy = num(p, "primaryHealthy", 1) >= 0.5;
  const baseP99 = ga ? clientRtt * 0.45 + EDGE_AND_PROCESSING_MS : clientRtt + EDGE_AND_PROCESSING_MS;
  const failoverSeconds = healthy ? 0 : ga ? GA_FAILOVER_S : ttl + DNS_HEALTH_DETECTION_S;
  const elapsed = healthy ? 0 : Math.max(0, t - incidentStart);
  const remaining = healthy ? 0 : Math.max(0, failoverSeconds - elapsed);
  const stale = !healthy && elapsed < failoverSeconds;
  return {
    ga,
    clientRtt,
    ttl,
    healthy,
    baseP99,
    failoverSeconds,
    elapsed,
    remaining,
    stale,
    failedPercent: stale ? 100 : 0,
    p99: baseP99 + (stale ? STALE_LATENCY_MS : 0),
    secondaryUtil: healthy ? 0 : stale ? 0 : 50,
  };
}

function buildFrame(p: Params, t: number, incidentStart: number, seed: number): SimFrame {
  const c = compute(p, t, incidentStart);
  const clientHealth: Health = c.failedPercent > 5 || c.p99 >= 300 ? "crit" : c.p99 >= 150 ? "warn" : "ok";
  const ingressHealth: Health = c.ga ? "ok" : !c.healthy && c.stale ? "crit" : "ok";
  const primaryHealth: Health = c.healthy ? "ok" : "down";
  return {
    t,
    nodes: [
      {
        id: "clients",
        label: "Global users",
        kind: "client",
        health: clientHealth,
        sublabel: `${c.clientRtt.toFixed(0)} ms RTT to the region`,
        detail:
          "Users connect to either the accelerator's static anycast IPs or the regional load balancer name. The entry point decides whether the path uses the AWS backbone or the public internet.",
        meta: { view: "flow" },
      },
      c.ga
        ? {
            id: "accelerator",
            label: "Global Accelerator",
            kind: "lb",
            health: ingressHealth,
            utilization: 0.2,
            sublabel: "2 static anycast IPv4 addresses",
            detail:
              "The client connects to the nearest AWS edge on a static anycast address. Global Accelerator terminates TCP at the edge and opens a new connection to a healthy endpoint over the AWS backbone. Endpoint failover does not wait for the DNS TTL.",
            meta: { view: "flow" },
          }
        : {
            id: "dns",
            label: "Route 53 DNS",
            kind: "dns",
            health: ingressHealth,
            sublabel: `direct regional record · TTL ${formatCount(c.ttl)}s`,
            detail:
              "Clients resolve the regional load balancer name directly. A failover changes the DNS answer, but clients that cached the old answer wait for the TTL to expire.",
            meta: { view: "flow" },
          },
      {
        id: "primary",
        label: "Primary ALB",
        kind: "lb",
        health: primaryHealth,
        utilization: c.healthy ? 0.5 : 0,
        sublabel: c.healthy ? "serving" : "unhealthy",
        detail: c.healthy
          ? "The primary endpoint is healthy and receives traffic."
          : "The primary endpoint is unhealthy. New connections move to the secondary only after health detection; established connections can remain on the primary until they close or hit the accelerator's idle timeout.",
        meta: { view: "flow" },
      },
      {
        id: "secondary",
        label: "Secondary ALB",
        kind: "lb",
        health: "ok",
        utilization: clamp(c.secondaryUtil / 100),
        sublabel: c.healthy ? "standby" : c.stale ? "waiting for failover" : "receiving new connections",
        detail:
          "The secondary is in another region or endpoint group. With the accelerator, it receives new connections after the endpoint group marks the primary unhealthy; established connections are not migrated.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-ingress", "clients", c.ga ? "accelerator" : "dns", 1, clientHealth),
      edge("ingress-primary", c.ga ? "accelerator" : "dns", "primary", c.healthy ? 1 : c.stale ? 1 : 0, primaryHealth),
      edge("ingress-secondary", c.ga ? "accelerator" : "dns", "secondary", c.healthy ? 0 : c.stale ? 0 : 1, "ok"),
    ],
    metrics: [
      metric("p99", "Client p99", c.p99, "ms", 150, 300, "ms"),
      metric("failed-requests", "Failed new requests", c.failedPercent, "%", 1, 5, "percent"),
      metric("failover-delay", "Failover delay remaining", c.remaining, " s", 30, 120, "number"),
      metric("backbone-share", "Path on AWS backbone", c.ga ? 100 : 0, "%", undefined, undefined, "percent"),
      metric("client-rtt", "Client RTT to region", c.clientRtt, " ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: c.healthy
      ? `${c.ga ? "Accelerator" : "Direct DNS"} path, p99 ${c.p99.toFixed(0)}ms. If the primary failed, failover would take about ${formatCount(c.ga ? GA_FAILOVER_S : c.ttl + DNS_HEALTH_DETECTION_S)}s.`
      : c.stale
        ? `Primary unhealthy; ${c.remaining.toFixed(0)}s of failover delay remain on the ${c.ga ? "accelerator" : "DNS"} path. p99 ${c.p99.toFixed(0)}ms.`
        : `Primary unhealthy; new connections use the secondary. p99 ${c.p99.toFixed(0)}ms, no failed new requests.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "p99",
    metricId: "p99",
    warn: 150,
    crit: 300,
    title: "Client latency breached the objective",
    cause:
      "The path uses the public internet for most of its distance, or requests are failing over and waiting on the unhealthy primary. The accelerator reduces the public-internet portion by entering the AWS backbone at the nearest edge.",
    fix:
      "Put the accelerator in front of the regional endpoints or move the endpoint closer to users. Compare the client p99 with the endpoint response time before adding application capacity.",
    checkFirst: [
      "Confirm clients actually resolve and connect to the accelerator's static IPs.",
      "Compare client p99 with the endpoint's own response time.",
      "Check whether the primary is unhealthy and whether failover is still pending.",
    ],
  },
  {
    id: "failed-requests",
    metricId: "failed-requests",
    warn: 1,
    crit: 5,
    title: "New requests are failing during failover",
    cause:
      "Clients are still sending new connections to the unhealthy primary. On the DNS path, the cached answer has not expired. On the accelerator path, health detection or endpoint group failover has not completed.",
    fix:
      "On the accelerator path, verify endpoint health and the endpoint group configuration. On the DNS path, reduce TTL and detection time, or move the entry point to the accelerator. Check that clients are not bypassing the accelerator.",
    checkFirst: [
      "Check endpoint health and the endpoint group's failover state.",
      "Confirm the client is using the accelerator address, not a cached regional IP.",
      "Check whether established connections are pinning clients to the failed endpoint.",
    ],
  },
  {
    id: "failover-delay",
    metricId: "failover-delay",
    warn: 30,
    crit: 120,
    title: "Failover is slower than the objective",
    cause:
      "The DNS path adds the record TTL plus health-check detection to the failover time. The accelerator replaces that with endpoint health checks and new-connection routing, but only if clients use the accelerator.",
    fix:
      "Move clients to the accelerator's static IPs, or lower the DNS TTL and detection time. Verify the accelerator is in the path from multiple client networks, and account for established connections that are not migrated.",
    checkFirst: [
      "Trace the client's actual connection target, not only the DNS name.",
      "Check endpoint group health and the time the endpoint became unhealthy.",
      "Check for a direct regional record that bypasses the accelerator.",
    ],
  },
];

export const globalAcceleratorModel: SimModel = {
  id: "traffic-global-accelerator",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), 0, 0, seed);
    for (const item of frame.metrics) frame.series[item.id] = [item.value];
    return frame;
  },
  step: (frame, p, dt) => {
    const key = JSON.stringify(p);
    const reset = frame.flags.paramsKey !== key;
    const incidentStart = reset ? frame.t : Number(frame.flags.incidentStart ?? 0);
    const t = frame.t + dt;
    const c = compute(p, t, incidentStart);
    const next = buildFrame(p, t, incidentStart, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([id, values]) => [id, [...values]]));
    next.events = [...frame.events].slice(-60);
    next.flags = reset
      ? { ...next.flags, paramsKey: key, incidentStart, failureLogged: 0, completeLogged: 0 }
      : { ...frame.flags, ...next.flags, paramsKey: key, incidentStart };    if (!c.healthy && frame.flags.failureLogged !== 1) {
      pushEvent(next, {
        id: "endpoint-unhealthy",
        severity: "crit",
        title: "Primary endpoint is unhealthy",
        detail: c.ga
          ? "Global Accelerator health checks will move new connections to a healthy endpoint. The DNS TTL is not in this failover path."
          : "The direct DNS record still points at the primary until its TTL expires. Clients with a cached answer keep failing over.",
        nodeId: "primary",
        metricId: "failed-requests",
      });
      next.flags.failureLogged = 1;
      next.flags.completeLogged = 0;
    }
    if (!c.healthy && !c.stale && frame.flags.completeLogged !== 1) {
      pushEvent(next, {
        id: "failover-complete",
        severity: "info",
        title: "New connections moved to the secondary",
        detail: c.ga
          ? "Endpoint failover completed without waiting for DNS. Existing connections may still be pinned to the primary until they close or hit the idle timeout."
          : `The DNS TTL and health detection completed in about ${formatCount(c.failoverSeconds)}s. Clients that resolved again now use the secondary.`,
        nodeId: "secondary",
        metricId: "failover-delay",
      });
      next.flags.completeLogged = 1;
    }
    if (c.healthy && frame.flags.failureLogged === 1) {
      pushEvent(next, {
        id: "endpoint-restored",
        severity: "info",
        title: "Primary endpoint restored",
        detail: "The primary is healthy again. Traffic returns only after health checks mark it healthy; existing connections are not moved back automatically.",
        nodeId: "primary",
      });
      next.flags.failureLogged = 0;
      next.flags.completeLogged = 0;
    }
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    return next;
  },
  thresholds,
  insights: (frame, p) => {
    const incidentStart = Number(frame.flags.incidentStart ?? 0);
    const c = compute(p, frame.t, incidentStart);
    const items: string[] = [];
    items.push(
      c.ga
        ? "The client connects to a static anycast address at the nearest AWS edge. Traffic then uses the AWS backbone to the endpoint; endpoint failover is handled by health checks, not by DNS TTL."
        : "The client resolves the regional load balancer directly. Every failover includes health detection plus the record TTL, and the client must resolve again.",
    );
    items.push(
      `Modeled p99 is ${c.baseP99.toFixed(0)}ms before any failure. ${c.ga ? "The accelerator assumes 45% of the client RTT remains on the path plus a fixed edge and processing cost; this is illustrative, not a guarantee." : "The direct path uses the full client RTT plus processing."}`,
    );
    items.push(
      c.healthy
        ? `No failure is injected. If the primary failed, failover would be about ${formatCount(c.ga ? GA_FAILOVER_S : c.ttl + DNS_HEALTH_DETECTION_S)}s on this path.`
        : `The primary is unhealthy. ${c.stale ? `${c.remaining.toFixed(0)}s of failover delay remain.` : "New connections now use the secondary."} Established connections are not migrated.`,
    );
    if (!c.ga) {
      items.push("Lowering the TTL helps only if clients resolve the direct name. It does nothing for a client that already has a connection or a cached answer.");
    } else {
      items.push("The accelerator's static IPs are anycast. Verify that the application's DNS name actually resolves to them; a direct regional record bypasses the accelerator entirely.");
    }
    items.push("Global Accelerator is a network-layer service. It does not replace ALB path routing, WAF, or application health; those still live at the endpoint.");
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
    description: "Accelerator in path, 40ms client RTT, primary healthy.",
    tone: "ok",
    params: defaults({ acceleratorEnabled: 1, clientRttMs: 40, dnsTtl: 300, primaryHealthy: 1 }),
  },
  {
    id: "peak",
    label: "Direct DNS",
    description: "A 200ms client RTT over the public internet; the primary is healthy but p99 is elevated.",
    tone: "warn",
    params: defaults({ acceleratorEnabled: 0, clientRttMs: 200, dnsTtl: 60, primaryHealthy: 1 }),
  },
  {
    id: "failure",
    label: "DNS failover",
    description: "The primary fails and clients resolve the regional name directly with a 300s TTL.",
    tone: "crit",
    params: defaults({ acceleratorEnabled: 0, clientRttMs: 120, dnsTtl: 300, primaryHealthy: 0 }),
  },
  {
    id: "accelerated",
    label: "Accelerated failover",
    description: "The primary fails, but clients use the accelerator. New connections move in about 15s.",
    tone: "warn",
    params: defaults({ acceleratorEnabled: 1, clientRttMs: 200, dnsTtl: 300, primaryHealthy: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The accelerator is in path and the primary is healthy again.",
    tone: "ok",
    params: defaults({ acceleratorEnabled: 1, clientRttMs: 120, dnsTtl: 300, primaryHealthy: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-ga-bypass",
  title: "Predict why failover still waits on DNS",
  simId: "global-accelerator",
  question:
    "You add Global Accelerator, but regional failover still takes about five minutes. What is the most likely cause?",
  prediction: {
    options: [
      { id: "bypass", label: "Clients still resolve the regional ALB name instead of using the accelerator's static IPs." },
      { id: "health", label: "Global Accelerator does not perform health checks on endpoints." },
      { id: "ttl", label: "The accelerator caches DNS for five minutes." },
      { id: "ipv6", label: "The accelerator only supports IPv6, so IPv4 clients fall back to DNS." },
    ],
    correctOptionId: "bypass",
    explanation:
      "Global Accelerator removes DNS TTL from the endpoint failover path only when clients are actually using its static anycast IPs. If the application name still points at the regional load balancer, or clients cached the regional address, the accelerator is not in the path. Failover then follows the DNS TTL and health-check timeline.",
  },
  setup: defaults({ acceleratorEnabled: 0, clientRttMs: 120, dnsTtl: 300, primaryHealthy: 0 }),
  runFor: 30,
  observe: [
    "The failover delay starts at about 330s: 300s TTL plus 30s health detection.",
    "Every new request fails during the first 30s while clients keep the cached regional answer.",
    "Client p99 is about 2.1s because requests are waiting on the unhealthy primary.",
    "The DNS path has no accelerator hop; the backbone share is 0%.",
  ],
  explain:
    "The accelerator was provisioned but not on the client's path. The client resolved the regional name, cached the address, and kept connecting to the failed endpoint. Global Accelerator can only fail over the connections that reach its static IPs. Checking the resolved address, not only the accelerator's existence, is the first diagnostic step.",
  fix: defaults({ acceleratorEnabled: 1, clientRttMs: 120, dnsTtl: 300, primaryHealthy: 1 }),
  debrief:
    "With the accelerator in path and the primary healthy, client p99 is about 69ms instead of 135ms and no requests fail. If the primary fails, new connections move in about 15s without waiting for the 300s DNS TTL. Established connections still stay on the old endpoint until they close or hit the idle timeout, so the application needs reconnect logic.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS Global Accelerator provides static anycast IP addresses as a fixed entry point. A client connects to the nearest AWS edge location on one of those addresses. Global Accelerator terminates the TCP connection at the edge and opens a new connection to a healthy endpoint over the AWS global network. Standard accelerators provide two static IPv4 addresses by default; dual-stack accelerators provide two IPv4 and two IPv6 addresses. The addresses remain assigned while the accelerator exists.",
  },
  {
    type: "p",
    text: "Endpoints are regional resources such as Application Load Balancers, Network Load Balancers, EC2 instances, or Elastic IP addresses. They are organized into endpoint groups, usually by Region. Health checks decide which endpoints receive new connections. Traffic dials limit an endpoint group's share, and endpoint weights divide traffic within a group. If no endpoint is healthy, the accelerator routes requests to all endpoints rather than dropping them.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The accelerator sits in front of the regional load balancer. It does not replace the load balancer's path routing, TLS termination, or WAF; those remain at the endpoint. The path is client, nearest AWS edge, AWS backbone, regional endpoint, application. DNS is still used to map a custom domain to the accelerator, but endpoint failover does not wait for the DNS TTL once clients are using the static IPs.",
  },
  {
    type: "compare",
    leftTitle: "Direct DNS failover",
    rightTitle: "Global Accelerator",
    rows: [
      { label: "Client entry", left: "Regional load balancer name", right: "Two static anycast IPv4 addresses" },
      { label: "Path", left: "Public internet for most of the distance", right: "Nearest AWS edge, then the AWS backbone" },
      { label: "Failover trigger", left: "Health check plus DNS TTL plus client refresh", right: "Endpoint health checks move new connections" },
      { label: "Established connections", left: "Pinned until they close or the target drains", right: "Pinned until they close or hit the accelerator idle timeout" },
      { label: "Main cost", left: "DNS caching makes the RTO unpredictable", right: "Another managed dependency and hourly plus data charges" },
    ],
  },
  {
    type: "p",
    text: "The accelerator's TCP idle timeout is 340 seconds for TCP and 30 seconds for UDP, and it is not configurable. Established connections continue to the endpoint even after it is marked unhealthy. Plan reconnect behavior for long-lived connections rather than assuming failover moves everything.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Client p99 with and without the accelerator on the same client RTT.",
      "The failover delay remaining on the DNS path versus the accelerator path.",
      "Failed requests while the primary is unhealthy and failover is incomplete.",
      "The share of the path that uses the AWS backbone, and whether clients actually reach the accelerator.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply Direct DNS and note the p99. Apply DNS failover: the 300s TTL plus 30s detection keeps failures alive. Apply Accelerated failover: new connections move in about 15s. Run the experiment, then apply Recovery.",
  },
  {
    type: "p",
    text: "The latency formula in this lab is illustrative: it assumes the accelerator path keeps 45% of the client RTT plus a fixed edge and processing cost. Real performance depends on the client's network, the edge location, the endpoint Region, and the path AWS selects. Treat the direction, not the exact milliseconds, as the lesson.",
  },
  { type: "sim", simId: "global-accelerator" },
  { type: "experiment", experimentId: "predict-ga-bypass" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "On the direct DNS path, the primary failed and clients kept using the cached regional address until the TTL and health detection completed. With the accelerator in path, new connections moved to the secondary after endpoint health checks, without waiting for DNS. The client latency also fell because traffic entered the AWS backbone at the nearest edge.",
  },
  {
    type: "p",
    text: "The bypass experiment showed the limit of adding the accelerator: if the application name still resolves to the regional load balancer, the accelerator is not on the path. The DNS TTL and the client cache still control failover. Established connections also stayed on the old endpoint until they closed or hit the idle timeout.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Global Accelerator flow and endpoint metrics: new and active flows, processed bytes, endpoint health, and endpoint group health.",
      "The resolved address on real clients, not only the DNS record in the console; a direct regional record bypasses the accelerator.",
      "Endpoint response time, error rate, and healthy host count at the ALB behind each endpoint group.",
      "TCP resets and reconnect rates for long-lived connections around the failover window.",
      "Traffic dial and endpoint weight settings, which can override the expected distribution.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Confirm the client is connecting to the accelerator's static IPs. Then check endpoint health and endpoint group failover. If the client still uses the regional name, the accelerator is not in the path and DNS TTL is still your failover timer.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Trace the client's resolved address and confirm it belongs to the accelerator.",
      "Verify endpoint health checks and endpoint group configuration.",
      "Move the custom domain to the accelerator addresses, with a TTL plan for the cutover.",
      "Test failover from multiple client networks and account for established connections.",
      "Keep the regional load balancer's health checks and capacity correct; the accelerator only routes to healthy endpoints.",
      "Review traffic dials and weights after the migration so the intended distribution is real.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "The accelerator reduces public-internet exposure and removes DNS TTL from endpoint failover, but adds a managed dependency and cost.",
      "It is a network-layer service; path routing, TLS, and WAF still belong at the regional load balancer.",
      "Established TCP connections are not migrated; long-lived protocols need reconnect and drain behavior.",
      "If no endpoint is healthy, the accelerator routes to all endpoints, so health and capacity still matter.",
      "Static anycast IPs simplify allow-listing but make the entry point a shared resource to monitor.",
      "A direct regional record or cached address bypasses the accelerator entirely, so DNS governance is still required.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "how-ga-works",
    question:
      "How does Global Accelerator reduce latency and failover time compared with a regional ALB behind DNS?",
    difficulty: 3,
    hints: [
      "The entry point is anycast.",
      "The accelerator terminates TCP at the edge.",
    ],
    answer:
      "Global Accelerator gives clients two static anycast IPv4 addresses. The client connects to the nearest AWS edge, and the accelerator terminates TCP there, then opens a new connection to a healthy endpoint over the AWS backbone. That avoids multiple public-internet hops and lets AWS choose the path. Endpoint groups have health checks, so new connections move to a healthy endpoint without waiting for a DNS TTL. The tradeoff is another managed component and cost, and established connections are not migrated; they stay until they close or hit the idle timeout.",
    followUps: [
      "What happens if every endpoint is unhealthy?",
      "How do traffic dials differ from endpoint weights?",
      "Where does TLS terminate in this design?",
    ],
    redFlags: [
      "Says the accelerator is a global load balancer with per-request routing.",
      "Claims established connections move instantly.",
      "Forgets the regional load balancer still does path routing.",
    ],
    rubric: [
      "Names static anycast IPs and the AWS backbone.",
      "Explains edge TCP termination and endpoint health.",
      "States the failover benefit over DNS.",
      "Names a tradeoff or limit.",
    ],
  },
  {
    id: "ga-or-dns",
    question:
      "When would you not use Global Accelerator, and what would you use instead?",
    difficulty: 3,
    hints: [
      "Think about single-Region services and L7 routing.",
      "Cost and client IP preservation matter.",
    ],
    answer:
      "I would not add it to a single-Region service with acceptable latency, because it adds cost and another dependency without removing a meaningful failure mode. If the requirement is path routing, host routing, TLS termination, or WAF, those are ALB and edge functions; the accelerator only gets traffic to the endpoint. For a simple multi-Region setup with a tolerant RTO, DNS failover is cheaper and easier to operate. If clients need a fixed address but the application is UDP-heavy or needs custom routing, I would check the accelerator's endpoint and protocol support, including idle timeouts and client IP preservation, before choosing it.",
    followUps: [
      "How does client IP preservation change the design?",
      "What does the accelerator cost include?",
      "When would a CloudFront distribution be a better front door?",
    ],
    redFlags: [
      "Adds the accelerator to every architecture by default.",
      "Expects it to replace ALB routing.",
      "Ignores cost and idle timeout behavior.",
    ],
    rubric: [
      "Names a case where DNS is sufficient.",
      "Separates L3/4 entry from L7 routing.",
      "Mentions cost and another dependency.",
      "Considers client IP and protocol limits.",
    ],
  },
  {
    id: "failover-still-slow",
    question:
      "Global Accelerator is provisioned, but regional failover still takes five minutes. How do you debug it?",
    difficulty: 4,
    hints: [
      "Check the address the client actually uses.",
      "Check endpoint health and established connections.",
    ],
    answer:
      "I would trace the client's resolved address and the connection target. If the application name still points at the regional ALB, or the client cached that address, the accelerator is bypassed and the DNS TTL still controls failover. If the client is on the accelerator, I would check endpoint health and endpoint group state, traffic dials and weights, and whether the endpoint is failing in a way the health check detects. I would also check established connections: the accelerator does not migrate them, so long-lived sessions can keep hitting the old endpoint until they close or hit the idle timeout. Finally, I would confirm the custom domain actually resolves to the accelerator and that no split-horizon or private DNS path overrides it.",
    followUps: [
      "How would you prove the client is on the accelerator?",
      "What if only one client region is slow?",
      "How do you handle a failed endpoint group rather than a failed endpoint?",
    ],
    redFlags: [
      "Assumes provisioning the accelerator is enough.",
      "Looks only at endpoint health.",
      "Ignores DNS and connection pinning.",
    ],
    rubric: [
      "Checks the client's actual address.",
      "Checks endpoint and endpoint group health.",
      "Accounts for established connections.",
      "Checks DNS governance and split horizons.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Confirm the application name resolves to the accelerator's static IPs from real client networks.",
      "Configure endpoint groups, health checks, traffic dials, and weights deliberately.",
      "Test failover with new and established connections.",
      "Document the accelerator idle timeout and the application's reconnect behavior.",
      "Keep the regional load balancers' health checks and capacity correct.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the client's actual connection target before blaming the accelerator.",
      "Check endpoint health and endpoint group failover state.",
      "Watch new-connection success separately from established-connection errors.",
      "Check whether DNS still points at a direct regional record.",
      "Verify traffic dials and weights did not change the expected distribution.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify endpoint health, p99, and failed requests at the client and at the ALB.",
      "Review reconnect behavior for long-lived connections.",
      "Test the failover again from multiple networks.",
      "Update the runbook with the difference between accelerator and DNS failover.",
    ],
  },
];

const references = [
  {
    title: "How AWS Global Accelerator works",
    url: "https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Static anycast IPs, edge TCP termination, AWS backbone, endpoint health checks, traffic dials, weights, and idle timeouts.",
  },
  {
    title: "Active-active and active-passive failover",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The DNS failover baseline that the accelerator replaces for new connections.",
  },
  {
    title: "What is Anycast? How does Anycast work?",
    url: "https://www.cloudflare.com/learning/cdn/glossary/anycast-network/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "The same address advertised from multiple locations and the routing behavior behind it.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "global-accelerator": {
      model: globalAcceleratorModel,
      presets,
      instructions:
        "Start Healthy. Apply Direct DNS and note the p99. Apply DNS failover: the TTL and health detection keep failures alive. Apply Accelerated failover: new connections move in about 15s. Run the experiment, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Global Accelerator's static anycast IPs, edge TCP termination, backbone path, endpoint health checks, and 340s TCP idle timeout are documented. The 45% latency factor, 15s accelerator failover, 30s DNS health detection, and 300s example TTL are teaching values, not guarantees. Failed new requests covers new connections only; established connections are not migrated and are not counted.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-anycast", "traffic-dns-ttl-failover", "traffic-route53-routing", "traffic-alb-connection-limit"],
};
