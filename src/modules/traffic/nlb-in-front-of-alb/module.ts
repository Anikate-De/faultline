import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CONNECTION_SECONDS = 120;
const ALB_CONNECTION_CEILING = 1_200_000;
const BASE_LATENCY_MS = 9;
const NLB_HOP_MS = 1.5;
const STATIC_IPS = 3;
const HEALTH_CHECK_ERRORS = 35;

const params = [
  {
    id: "albCount",
    label: "ALBs behind the front door",
    min: 1,
    max: 6,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Each ALB has its own NLB target group; an NLB target group can contain only one ALB. The NLB gives clients one endpoint; it does not merge the ALBs' connection tables.",
    format: "count" as const,
  },
  {
    id: "connectionRate",
    label: "New connections",
    min: 1_000,
    max: 100_000,
    step: 1_000,
    value: 20_000,
    unit: " /s",
    group: "Traffic",
    help: "New client connections per second. The model holds each connection for 120 seconds, so active connections are this rate times 120.",
    format: "rps" as const,
  },
  {
    id: "nlbEnabled",
    label: "NLB front door (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "0 sends clients to the ALB DNS names directly. 1 puts an NLB in front with a static IP per Availability Zone and one endpoint.",
    format: "count" as const,
  },
  {
    id: "healthCheckPath",
    label: "NLB health check path (0 app path, 1 wrong path)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "1 models an NLB target group health check pointed at a path the application does not serve. Only applies when the NLB is on.",
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

interface Demand {
  albCount: number;
  connectionRate: number;
  nlb: boolean;
  wrongPath: boolean;
  activeConnections: number;
  activePerAlb: number;
  albUtilization: number;
  healthErrors: number;
  overloadErrors: number;
  errorRate: number;
  p99: number;
  staticIps: number;
  endpoints: number;
  removedAlbs: number;
}

function demand(p: Params): Demand {
  const albCount = Math.max(1, Math.round(num(p, "albCount", 3)));
  const connectionRate = Math.max(1, num(p, "connectionRate", 20_000));
  const nlb = num(p, "nlbEnabled", 1) >= 0.5;
  const wrongPath = nlb && num(p, "healthCheckPath", 0) >= 0.5;
  const activeConnections = connectionRate * CONNECTION_SECONDS;
  const activePerAlb = activeConnections / albCount;
  const albUtilization = (activePerAlb / ALB_CONNECTION_CEILING) * 100;
  const healthErrors = wrongPath ? HEALTH_CHECK_ERRORS : 0;
  const overloadErrors = Math.max(0, albUtilization - 100) * 0.6;
  const errorRate = Math.min(100, healthErrors + overloadErrors);
  const queueing = albUtilization > 85 ? ((albUtilization - 85) / 15) ** 2 * 30 : 0;
  const p99 = BASE_LATENCY_MS + (nlb ? NLB_HOP_MS : 0) + queueing + (wrongPath ? 120 : 0);
  return {
    albCount,
    connectionRate,
    nlb,
    wrongPath,
    activeConnections,
    activePerAlb,
    albUtilization,
    healthErrors,
    overloadErrors,
    errorRate,
    p99,
    staticIps: nlb ? STATIC_IPS : 0,
    endpoints: nlb ? 1 : albCount,
    removedAlbs: wrongPath ? albCount : 0,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const clientHealth = healthFor(d.errorRate, 0.5, 5);
  const albHealth = d.wrongPath
    ? "crit"
    : healthFor(d.albUtilization, 80, 95);
  const targetHealth = healthFor(d.albUtilization, 80, 95);
  const ingressHealth = d.nlb ? (d.wrongPath ? "crit" : "ok") : "ok";
  const ingressId = d.nlb ? "nlb" : "dns";
  const served = Math.max(0, 100 - d.errorRate);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: d.connectionRate,
        sublabel: `${formatCount(d.connectionRate)} new conns/s`,
        detail: `${d.errorRate.toFixed(1)}% of requests fail. Clients ${d.nlb ? "resolve one NLB name with a static IP per Availability Zone" : "resolve the ALB DNS names directly"}.`,
        meta: { view: "flow" },
      },
      {
        id: ingressId,
        label: d.nlb ? "Network Load Balancer" : "Route 53 to ALBs",
        kind: d.nlb ? "lb" : "dns",
        health: ingressHealth,
        utilization: d.nlb ? clamp(d.connectionRate / 100_000) : 0.1,
        throughput: d.connectionRate,
        sublabel: d.nlb ? `${STATIC_IPS} static IPs · 1 endpoint` : `${d.albCount} ALB endpoints`,
        detail: d.nlb
          ? "Layer 4 TCP listener. It forwards each client connection to an ALB target group. It does not merge ALB connection tables or terminate HTTP routing."
          : "Weighted or latency records point clients at each ALB. There is no extra hop and no static IP unless you add one.",
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "ALB fleet",
        kind: "lb",
        health: albHealth,
        utilization: clamp(d.albUtilization / 100),
        throughput: (d.connectionRate * served) / 100,
        sublabel: `${d.albCount} ALB${d.albCount === 1 ? "" : "s"} · ${formatCount(d.activePerAlb)} conns each`,
        detail: d.wrongPath
          ? `Every ALB is marked unhealthy by the NLB health check. ${formatCount(d.removedAlbs)} of ${d.albCount} targets are removed from their NLB target groups.`
          : `Each ALB carries about ${formatCount(d.activePerAlb)} active connections against an illustrative ${formatCount(ALB_CONNECTION_CEILING)} ceiling. The ALB still owns path routing and TLS termination.`,
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Target group",
        kind: "service",
        health: targetHealth,
        utilization: clamp(d.albUtilization / 100),
        throughput: (d.connectionRate * served) / 100,
        sublabel: "path-routed requests",
        detail: "Targets are reachable through the ALBs. The NLB does not route on HTTP host or path.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-ingress", "client", ingressId, 1, clientHealth),
      edge("ingress-alb", ingressId, "alb", served / 100, albHealth),
      edge("alb-targets", "alb", "targets", served / 100, targetHealth),
    ],
    metrics: [
      metric("active-per-alb", "Active connections per ALB", d.activePerAlb, " conns", 960_000, 1_140_000, "number"),
      metric("alb-utilization", "Per-ALB connection utilization", d.albUtilization, "%", 80, 95, "percent"),
      metric("error-rate", "Failed requests", d.errorRate, "%", 0.5, 5, "percent"),
      metric("p99", "End-to-end p99", d.p99, "ms", 250, 800, "ms"),
      metric("static-ips", "Static IPs", d.staticIps, "", undefined, undefined, "count"),
      metric("ingress-endpoints", "Client endpoints", d.endpoints, "", undefined, undefined, "count"),
      metric("hop-latency", "Extra hop", d.nlb ? NLB_HOP_MS : 0, "ms", undefined, undefined, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, nlb: d.nlb ? 1 : 0, healthPath: d.wrongPath ? 1 : 0, paramsKey: "" },
    summary: `${formatCount(d.activePerAlb)} active per ALB (${d.albUtilization.toFixed(0)}%); ${d.errorRate.toFixed(1)}% failed requests; p99 ${d.p99.toFixed(1)} ms; ${d.staticIps} static IPs; ${d.endpoints} client endpoint${d.endpoints === 1 ? "" : "s"}.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.98 + 0.04 * Math.sin((index + (seed % 6)) / 2.5)) +
          Math.sin(index / 2.1) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 5,
    title: "Clients are failing through the NLB front door",
    cause:
      "Every ALB target group failed its health check. The NLB removes unhealthy targets; when all targets fail, it fails open to all targets, but unhealthy-target connection termination can reset established flows during the transition. The ALB itself may still be serving.",
    fix:
      "Fix the NLB target group health check path, port, and protocol first. Point it at a cheap endpoint that proves the whole path works, keep one ALB per target group, and verify target health on both layers before shifting traffic.",
    checkFirst: [
      "Check NLB target health for each ALB target group; look for Target.FailedHealthChecks.",
      "Check the ALB target group's healthy host count and listener response on the health check path.",
      "Check the NLB health check protocol, port, and ping path against the ALB listener and target path.",
    ],
  },
  {
    id: "alb-utilization",
    metricId: "alb-utilization",
    warn: 80,
    crit: 95,
    title: "The ALBs behind the NLB are at their connection ceiling",
    cause:
      "The NLB adds a scalable front door, but it does not add per-ALB connection capacity. It forwards each client connection to an ALB, and each ALB still has its own connection table and node limit.",
    fix:
      "Add ALBs, increase connection reuse, or shorten lifetimes. If clients need one endpoint and static IPs, keep the NLB and add ALBs behind it; the NLB makes the shard fleet usable but does not remove the per-ALB limit.",
    checkFirst: [
      "Compare ActiveConnectionCount per ALB with the per-ALB ceiling and node count.",
      "Check whether new shards were added behind the NLB but clients still resolve one ALB.",
      "Check connection lifetime and reuse on the client side.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 250,
    crit: 800,
    title: "The extra hop is visible in the tail",
    cause:
      "The NLB adds a Layer 4 hop and, when the ALBs are near their connection ceiling, queueing behind it. The hop itself is small; the tail usually comes from the component behind it.",
    fix:
      "Measure the hop separately from ALB target time. Add ALB capacity, keep the NLB and ALBs in the same Availability Zones, and terminate TLS at the ALB rather than inserting an unsupported TLS layer.",
    checkFirst: [
      "Compare NLB flow latency with ALB TargetResponseTime.",
      "Check per-ALB connection utilization and p99 together.",
      "Check whether the NLB and ALBs use the same Availability Zones.",
    ],
  },
];

export const nlbInFrontOfAlbModel: SimModel = {
  id: "nlb-in-front-of-alb",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.003, 0.003);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const nlbFlag = d.nlb ? 1 : 0;
    if (nlbFlag !== Number(frame.flags.nlb ?? 0)) {
      pushEvent(next, {
        id: "nlb-change",
        at: frame.t,
        severity: "info",
        title: nlbFlag === 1 ? "NLB inserted in front of the ALB fleet" : "NLB removed from the path",
        detail:
          nlbFlag === 1
            ? "Clients now use one endpoint with a static IP per Availability Zone. The NLB still forwards TCP to each ALB target group; path routing and TLS stay on the ALBs."
            : "Clients now resolve the ALB DNS names. The extra hop and the static IPs are gone; each ALB keeps its own connection ceiling.",
        nodeId: "alb",
      });
    }
    const healthFlag = d.wrongPath ? 1 : 0;
    if (healthFlag !== Number(frame.flags.healthPath ?? 0)) {
      pushEvent(next, {
        id: "health-path-change",
        at: frame.t,
        severity: healthFlag === 1 ? "crit" : "info",
        title: healthFlag === 1 ? "NLB health check path changed" : "NLB health check path corrected",
        detail:
          healthFlag === 1
            ? "The NLB target groups now check a path the ALB does not serve. The health check is forwarded through the ALB to its targets, so every ALB can fail."
            : "The NLB health check now follows the application path. Target health can recover once the checks pass.",
        nodeId: "nlb",
      });
    }
    if (d.wrongPath && frame.flags.allUnhealthy !== 1) {
      pushEvent(next, {
        id: "all-albs-unhealthy",
        at: frame.t,
        severity: "crit",
        title: "NLB health checks removed every ALB",
        detail: `All ${d.albCount} ALB targets failed the NLB health check. The NLB fails open when every target is unhealthy, but connection termination can reset established flows and some clients still fail.`,
        nodeId: "nlb",
        metricId: "error-rate",
      });
      next.flags.allUnhealthy = 1;
    }
    if (!d.wrongPath) next.flags.allUnhealthy = 0;
    next.flags.nlb = nlbFlag;
    next.flags.healthPath = healthFlag;
    next.summary = `${formatCount(d.activePerAlb)} active per ALB (${d.albUtilization.toFixed(0)}%); ${d.errorRate.toFixed(1)}% failed requests; p99 ${d.p99.toFixed(1)} ms; ${d.staticIps} static IPs; ${d.endpoints} client endpoint${d.endpoints === 1 ? "" : "s"}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      d.nlb
        ? "The NLB gives clients one endpoint and a static IP per Availability Zone. It does not add per-ALB connection capacity."
        : "Clients resolve each ALB directly. There is no extra hop, but there is no single endpoint or static IP either.",
    );
    items.push(
      `Each ALB carries ${formatCount(d.activePerAlb)} active connections (${d.albUtilization.toFixed(0)}% of the illustrative ceiling). The NLB forwards connections; it does not multiplex HTTP requests for the ALB.`,
    );
    items.push(
      d.nlb
        ? "TLS passes through the NLB on a TCP listener and terminates on the ALB. An NLB TLS listener cannot target an ALB target group, which only accepts TCP."
        : "TLS terminates on the ALB. Adding an NLB later does not change the certificate or listener configuration.",
    );
    if (d.wrongPath) {
      items.push(
        `The health check path fails on all ${d.albCount} ALBs. NLB health checks are forwarded to the ALB's targets, so a path or port mismatch can remove the whole fleet.`,
      );
    }
    if (d.errorRate > 0) {
      items.push(
        `${d.errorRate.toFixed(1)}% of requests fail. Separate health-check failures from ALB connection saturation before changing capacity.`,
      );
    }
    if (d.albUtilization >= 80) {
      items.push(
        "The next limit is behind the NLB: per-ALB connection usage. Adding ALBs is the fix; adding another NLB is not.",
      );
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
    description: "Three ALBs behind an NLB, 20k new connections/s, and a health check on the app path.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "35k new connections/s across four ALBs. Per-ALB utilization reaches the warning band.",
    tone: "warn",
    params: defaults({ albCount: 4, connectionRate: 35_000 }),
  },
  {
    id: "failure",
    label: "Health check mismatch",
    description: "The NLB checks a path the app does not serve; every ALB is removed and requests fail.",
    tone: "crit",
    params: defaults({ albCount: 3, connectionRate: 20_000, nlbEnabled: 1, healthCheckPath: 1 }),
  },
  {
    id: "direct",
    label: "ALB direct",
    description: "The same traffic without the NLB: no hop, no static IPs, three client endpoints.",
    tone: "ok",
    params: defaults({ albCount: 3, connectionRate: 20_000, nlbEnabled: 0, healthCheckPath: 0 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Health check corrected, traffic lower, three ALBs behind the NLB.",
    tone: "ok",
    params: defaults({ albCount: 3, connectionRate: 15_000, nlbEnabled: 1, healthCheckPath: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-nlb-health-check",
  title: "Predict what the NLB health check actually tests",
  simId: "nlb-front",
  question:
    "The NLB target group health check uses HTTP and a path that returns 404 from the application. What does the NLB mark unhealthy?",
  prediction: {
    options: [
      { id: "all-albs", label: "Every ALB, because the check is forwarded through the ALB to its targets" },
      { id: "one-alb", label: "Only the first ALB in the target group" },
      { id: "nothing", label: "Nothing; NLB health checks only test the TCP port" },
      { id: "nlb-node", label: "Only the NLB node in the affected Availability Zone" },
    ],
    correctOptionId: "all-albs",
    explanation:
      "For an ALB target group, the NLB health check uses HTTP or HTTPS and is forwarded through the ALB to its targets on the configured path. A 404 fails the check on every ALB. When all targets are unhealthy, the NLB fails open, but established connections can be reset by unhealthy-target connection termination, so clients still see errors.",
  },
  setup: defaults({ albCount: 3, connectionRate: 20_000, nlbEnabled: 1, healthCheckPath: 1 }),
  runFor: 20,
  observe: [
    "All three ALBs are marked unhealthy by their NLB target groups.",
    "Failed requests reach 35% even though per-ALB connection utilization is only 67%.",
    "p99 includes the health-check failure path, not target processing time.",
    "The ALB connection tables are not full; the failure is the health check, not capacity.",
  ],
  explain:
    "The NLB has no HTTP routing of its own. For an ALB target, it sends the health check through the ALB to the target group. A wrong path, port, or protocol fails every ALB at once. Removing every target makes the NLB fail open, but that is a degraded mode, not a clean recovery. The fix is to make the check prove the same path clients use.",
  fix: defaults({ albCount: 3, connectionRate: 20_000, nlbEnabled: 1, healthCheckPath: 0 }),
  debrief:
    "With the path corrected, failed requests return to zero and p99 drops to the base latency plus the NLB hop. The ALB connection utilization did not change, which is the point: the outage was a health-check configuration failure, not a capacity failure.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Network Load Balancer (NLB) is a Layer 4 load balancer. It accepts TCP connections and forwards them to targets using a flow hash. An Application Load Balancer (ALB) is Layer 7: it terminates HTTP or HTTPS, evaluates host and path rules, and chooses a target. Putting an NLB in front of an ALB combines a stable Layer 4 entry point with Layer 7 routing behind it.",
  },
  {
    type: "p",
    text: "The NLB target group has target type `alb`, and only a TCP listener can forward to it. One ALB goes in one target group, and an ALB can be a target of at most two NLBs. The NLB gives one endpoint and a static IP per Availability Zone; you can assign an Elastic IP to each address for a fixed public IP. It does not merge the ALBs' connection tables, and it does not make path-routing decisions.",
  },
  {
    type: "p",
    text: "TLS behavior changes with the layer. On the supported NLB-to-ALB path, the NLB uses a TCP listener and passes encrypted traffic through; the ALB terminates TLS and applies its certificate and security policy. An NLB TLS listener terminates TLS at the NLB and cannot forward to an ALB target group. If you need TLS termination at the NLB, you are no longer using the ALB as a target, and you lose the ALB routing that motivated the layering.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, NLB, ALB target group, ALB listener, ALB target group, targets. Clients resolve one NLB name to one IP per Availability Zone. The NLB chooses an ALB by flow, and the ALB then evaluates host and path rules and chooses a target. The NLB preserves the client IP and sends it to the ALB; the ALB appends the client IP to `X-Forwarded-For` before forwarding to the target.",
  },
  {
    type: "compare",
    leftTitle: "ALB only",
    rightTitle: "NLB in front of ALB",
    rows: [
      { label: "Client entry", left: "ALB DNS name; IPs can change as it scales", right: "One NLB name with a static IP per Availability Zone" },
      { label: "Routing", left: "Host, path, header, method, source IP", right: "NLB flow hash to an ALB; ALB still does the HTTP routing" },
      { label: "TLS", left: "ALB terminates", right: "ALB terminates; NLB TCP listener passes TLS through" },
      { label: "Latency and failure domains", left: "One Layer 7 hop", right: "One extra Layer 4 hop and another component to monitor" },
      { label: "Client IP", left: "ALB appends X-Forwarded-For", right: "NLB preserves the client IP; ALB still appends X-Forwarded-For" },
    ],
  },
  {
    type: "p",
    text: "The NLB's scale benefit is real but narrow. It handles very large connection counts at Layer 4 and gives you one endpoint in front of many ALBs. The ALB still owns every HTTP connection and every per-ALB limit. The NLB is a front door, not extra ALB capacity.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Per-ALB active connections and utilization, with the NLB on or off.",
      "Failed requests and end-to-end p99, including the extra NLB hop.",
      "Static IP count, client endpoint count, and hop latency.",
      "An NLB health check failure that removes every ALB at once.",
      "A direct-ALB preset for comparison, with no hop and no static IPs.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Direct to compare the same traffic without the NLB. Note the endpoint count, static IP count, and p99. Apply Health check mismatch and watch every ALB fail its NLB health check while per-ALB connection utilization stays normal. Correct the path in the experiment fix.",
  },
  {
    type: "table",
    headers: ["What the NLB adds", "What it does not add", "Operational cost"],
    rows: [
      ["Static IP per Availability Zone and one endpoint", "Per-ALB connection capacity", "Another load balancer layer to monitor and pay for"],
      ["Layer 4 scale and flow hashing", "HTTP host or path routing", "One extra hop and more path segments to trace"],
      ["Health-aware failover across ALBs", "A replacement for ALB connection capacity", "Health checks that can remove the whole fleet if misconfigured"],
      ["PrivateLink endpoint services", "A replacement for ALB TLS and routing", "Two target groups and two health-check configurations"],
    ],
  },
  { type: "sim", simId: "nlb-front" },
  { type: "experiment", experimentId: "predict-nlb-health-check" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The NLB added one endpoint and three static IP addresses, at the cost of one more hop and one more component. It did not change per-ALB connection capacity. With a correct health check, the path was healthy. With a wrong path, every ALB failed the NLB check at once, so a configuration change took out the whole front door.",
  },
  {
    type: "p",
    text: "The direct preset showed the same connection load without the NLB: lower latency, no static IPs, and three client-facing DNS endpoints. The NLB is worth it when those static addresses, one endpoint, PrivateLink, or Layer 4 scale matter. It is not worth it when the ALBs are already healthy and clients can use DNS.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "NLB: target health per ALB, `ActiveFlowCount`, `NewFlowCount`, `ProcessedBytes`, and `ConsumedLCUs`, split by Availability Zone.",
      "ALB: `ActiveConnectionCount`, `NewConnectionCount`, `RejectedConnectionCount`, `HTTPCode_ELB_5XX_Count`, and `TargetResponseTime`.",
      "Access logs on both layers: the NLB flow does not carry HTTP details, so the ALB access log is where host, path, and target decisions appear.",
      "Tracing: the extra hop shows as a longer client-to-ALB span. Compare it with the ALB's target response time before blaming the NLB.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check NLB target health and the health check path before you add ALBs or change connection limits. If every ALB is unhealthy at the NLB while the ALBs themselves are healthy, the check is wrong. If the ALBs are healthy but rejecting connections, the per-ALB limit is the constraint and the NLB is not the fix.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm which layer is failing: NLB target health, ALB target health, or ALB connection admission.",
      "For a health check failure, fix the path, port, and protocol on the NLB target group.",
      "Keep one ALB per NLB target group and verify the ALB listener port matches the target group port.",
      "For connection saturation, add ALBs behind the NLB or reduce connection lifetime; do not add a second NLB.",
      "Confirm TLS terminates on the ALB and that the NLB listener is TCP, not TLS.",
      "Verify the client IP arrives in X-Forwarded-For and that the application reads it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "The extra hop is small in steady state but adds a component whose health check can fail the whole fleet.",
      "Static IPs are useful for allow lists and hard-coded clients, but they also make the NLB a fixed target.",
      "NLB TLS termination is not available with ALB targets; choosing it changes the architecture, not just a setting.",
      "On the supported path, client IP is preserved and X-Forwarded-For still matters; applications must read the header, not the socket address.",
      "One ALB per NLB target group means the shard fleet is visible at the NLB; a bad ALB can be removed, but a bad check can remove all of them.",
      "DNS sharding avoids the hop and the second layer, but clients must honor the 60-second TTL and handle multiple endpoints.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "why-nlb-front",
    question:
      "Why would you put an NLB in front of an ALB instead of giving clients the ALB DNS name?",
    difficulty: 3,
    hints: [
      "Think about what clients need at the edge: addresses, protocols, and one name.",
      "The ALB still does the HTTP work.",
    ],
    answer:
      "I would put an NLB in front when clients need a static IP per Availability Zone, a single endpoint, PrivateLink, or Layer 4 scale in front of several ALBs. The NLB accepts TCP and forwards to each ALB target group; the ALB still terminates TLS and does host and path routing. I would not do it to raise per-ALB connection capacity, because the ALB still accepts every connection. The costs are an extra hop, another component with its own health checks, and a second place to look during an incident. If clients can use DNS and tolerate changing ALB addresses, the direct ALB path is simpler.",
    followUps: [
      "When is DNS sharding a better fit?",
      "What does the NLB health check actually test?",
      "How does the client IP reach the application?",
    ],
    redFlags: [
      "Says the NLB removes the ALB connection limit.",
      "Adds an NLB without a static-IP or single-endpoint requirement.",
      "Forgets that the ALB still terminates TLS and routes.",
    ],
    rubric: [
      "Names static IPs, one endpoint, or PrivateLink.",
      "Keeps routing and TLS on the ALB.",
      "States that per-ALB capacity is unchanged.",
      "Names the extra hop and operational cost.",
    ],
  },
  {
    id: "tls-and-source-ip",
    question:
      "Where does TLS terminate in an NLB-to-ALB design, and what happens to the client IP?",
    difficulty: 4,
    hints: [
      "Only a TCP listener can forward to an ALB target group.",
      "The ALB always appends X-Forwarded-For.",
    ],
    answer:
      "TLS terminates on the ALB. The NLB uses a TCP listener and passes the encrypted stream through, which is the only supported listener type for an ALB target group. The NLB preserves the client IP and sends it to the ALB, and the ALB appends the client IP to X-Forwarded-For before forwarding to the target. If I used a TLS listener on the NLB, I would terminate TLS at Layer 4 and could not target an ALB target group; I would also need proxy protocol or another mechanism to preserve the client IP. That is a different architecture with different routing.",
    followUps: [
      "What would you lose by terminating TLS at the NLB?",
      "How do you verify the application is reading X-Forwarded-For?",
      "What happens to the client IP with a proxy in front of the NLB?",
    ],
    redFlags: [
      "Says an NLB TLS listener can forward to an ALB target group.",
      "Says the ALB sees the NLB IP and that is the client IP.",
      "Forgets X-Forwarded-For.",
    ],
    rubric: [
      "Terminates TLS on the ALB.",
      "Explains the TCP listener restriction.",
      "States client IP preservation and X-Forwarded-For.",
      "Names the tradeoff of terminating at the NLB.",
    ],
  },
  {
    id: "nlb-health-failure",
    question:
      "Every ALB behind an NLB is marked unhealthy, but the ALBs report healthy targets. What do you check, and what happens to traffic?",
    difficulty: 4,
    hints: [
      "The NLB health check is forwarded through the ALB.",
      "NLB fails open when every target is unhealthy.",
    ],
    answer:
      "I would check the NLB target group health check first: protocol, port, and ping path must match an endpoint the ALB actually serves. For an ALB target, the check is forwarded through the ALB to its targets, so a path or port mismatch fails every ALB at once. I would also confirm one ALB per target group and that the ALB listener port matches the target group port. When every target fails, the NLB fails open, so new connections may still reach the ALBs, but unhealthy-target connection termination can reset established flows and clients can see errors during the transition. I would correct the check, watch target health recover, and only then investigate capacity.",
    followUps: [
      "Why does the ALB look healthy while the NLB says otherwise?",
      "What does fail-open mean for the client experience?",
      "How would you test this check before a production change?",
    ],
    redFlags: [
      "Starts by adding ALBs.",
      "Assumes the NLB health check only tests the TCP port.",
      "Ignores the fail-open and connection-reset behavior.",
    ],
    rubric: [
      "Checks path, port, and protocol.",
      "Explains the forwarded health check.",
      "Names fail-open and connection termination.",
      "Separates health-check failure from capacity.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The NLB target group has one ALB per group and a health check that proves the client path.",
      "The ALB listener port, protocol, and certificate are documented next to the NLB listener.",
      "Dashboards show NLB target health and per-ALB connection utilization together.",
      "The client IP path is verified end to end, including X-Forwarded-For.",
      "Static IPs are documented and owned; clients that hard-code them have a migration plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check NLB target health before changing ALB capacity.",
      "If every ALB is unhealthy, inspect the health check path and port first.",
      "If the ALBs are healthy but saturated, add ALBs or reduce connection lifetime.",
      "Compare the extra hop with ALB TargetResponseTime before blaming the NLB.",
      "Record the time of any health check or listener change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add a synthetic check that follows the same path as the NLB health check.",
      "Verify failover with one ALB removed and with all ALBs removed.",
      "Review the NLB and ALB target group quotas and target counts.",
      "Document why the NLB exists: static IPs, one endpoint, PrivateLink, or scale.",
    ],
  },
];

const references = [
  {
    title: "Use an Application Load Balancer as a target of a Network Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/network/application-load-balancer-target.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "One ALB per target group, TCP listener requirement, static IPs, and health check behavior.",
  },
  {
    title: "How Elastic Load Balancing works",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Availability Zone nodes, cross-zone behavior, request routing, and the 60-second DNS TTL.",
  },
  {
    title: "Listeners for your Network Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-listeners.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "TCP versus TLS listeners and TLS passthrough behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "nlb-front": {
      model: nlbInFrontOfAlbModel,
      presets,
      instructions:
        "Start Healthy, then apply Direct and compare the endpoint count, static IP count, and p99. Apply Health check mismatch and watch every ALB fail at the NLB while per-ALB utilization stays normal. Run the experiment, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The TCP-only NLB-to-ALB path, one ALB per target group, two-NLB limit, static IP per Availability Zone, client IP preservation, and fail-open behavior are AWS-documented. Per-ALB connection ceiling, the 35% health-check error rate, and latency values are teaching values, not AWS quotas or guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-connection-limit",
    "traffic-alb-sharding",
    "traffic-l4-vs-l7",
  ],
};
