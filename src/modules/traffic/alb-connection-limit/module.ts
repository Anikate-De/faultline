import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const NODE_CONNECTION_CAPACITY = 12_000;
const MAX_NODES_PER_ALB = 100;
const NODE_CEILING = NODE_CONNECTION_CAPACITY * MAX_NODES_PER_ALB;
const TARGET_RPS_CAPACITY = 500_000;
const BASE_LATENCY_MS = 12;
const NLB_HOP_MS = 2;
const LCU_NEW_CONNECTIONS = 25;
const LCU_ACTIVE_CONNECTIONS = 3_000;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 5_000,
    max: 500_000,
    step: 5_000,
    value: 60_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second clients attempt. A request on a rejected connection never reaches a target.",
    format: "rps" as const,
  },
  {
    id: "requestsPerConnection",
    label: "Requests per connection",
    min: 1,
    max: 100,
    step: 1,
    value: 10,
    unit: " req",
    group: "Traffic",
    help: "Requests sent on one TCP connection. Higher reuse means fewer new connections for the same request rate.",
    format: "count" as const,
  },
  {
    id: "connectionSeconds",
    label: "Connection lifetime",
    min: 5,
    max: 600,
    step: 5,
    value: 60,
    unit: "s",
    group: "Traffic",
    help: "Average time a client keeps a connection open. Active connections grow with new connections per second times lifetime.",
    format: "number" as const,
  },
  {
    id: "albCount",
    label: "ALB shards",
    min: 1,
    max: 8,
    step: 1,
    value: 1,
    unit: "",
    group: "Topology",
    help: "Load balancers sharing the same targets. Each shard has its own per-ALB limit and 100-node ceiling.",
    format: "count" as const,
  },
  {
    id: "nlbEnabled",
    label: "NLB front door (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Topology",
    help: "0 sends clients to Route 53 weighted records. 1 puts an NLB in front of the ALB shards for static IPs and one endpoint.",
    format: "count" as const,
  },
  {
    id: "quotaPerAlb",
    label: "Illustrative per-ALB connection ceiling",
    min: 100_000,
    max: 5_000_000,
    step: 100_000,
    value: 1_200_000,
    unit: " conns",
    group: "Capacity",
    help: "Teaching ceiling for each ALB. This is not an AWS quota or a Service Quotas value; AWS documents the 100-node maximum, not a per-node connection number.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Demand {
  requestRate: number;
  albCount: number;
  nlb: boolean;
  ceiling: number;
  limit: number;
  newConnections: number;
  demandActivePerAlb: number;
  activePerAlb: number;
  acceptedNew: number;
  rejected: number;
  acceptedRequestRate: number;
  connectionUtil: number;
  nodes: number;
  failedAttempts: number;
  lcu: number;
  p99: number;
  targetLoad: number;
}

function demand(p: Params): Demand {
  const requestRate = Math.max(1, num(p, "requestRate", 60_000));
  const reqPerConnection = Math.max(1, num(p, "requestsPerConnection", 10));
  const lifetime = Math.max(1, num(p, "connectionSeconds", 60));
  const albCount = Math.max(1, Math.round(num(p, "albCount", 1)));
  const nlb = num(p, "nlbEnabled", 0) >= 0.5;
  const ceiling = Math.max(100_000, num(p, "quotaPerAlb", 1_200_000));
  const limit = Math.min(ceiling, NODE_CEILING);
  const newConnections = requestRate / reqPerConnection;
  const demandActivePerAlb = (newConnections * lifetime) / albCount;
  const activePerAlb = Math.min(demandActivePerAlb, limit);
  const maxNewPerAlb = limit / lifetime;
  const acceptedNewPerAlb = Math.min(newConnections / albCount, maxNewPerAlb);
  const acceptedNew = acceptedNewPerAlb * albCount;
  const rejected = Math.max(0, newConnections - acceptedNew);
  const acceptedRequestRate = requestRate * (acceptedNew / Math.max(1, newConnections));
  const demandRatio = demandActivePerAlb / limit;
  const connectionUtil = Math.min(100, demandRatio * 100);
  const nodes = Math.min(MAX_NODES_PER_ALB, Math.max(1, Math.ceil(activePerAlb / NODE_CONNECTION_CAPACITY)));
  const failedAttempts = clamp(100 * (1 - acceptedNew / Math.max(1, newConnections)), 0, 100);
  const lcu = Math.max(
    acceptedNew / Math.max(1, albCount) / LCU_NEW_CONNECTIONS,
    activePerAlb / LCU_ACTIVE_CONNECTIONS,
  );
  const queueing =
    demandRatio > 0.85
      ? 20 * ((demandRatio - 0.85) / 0.15) ** 2
      : 0;
  const p99 = Math.min(5_000, BASE_LATENCY_MS + (nlb ? NLB_HOP_MS : 0) + queueing);
  const targetLoad = (acceptedRequestRate / TARGET_RPS_CAPACITY) * 100;
  return {
    requestRate,
    albCount,
    nlb,
    ceiling,
    limit,
    newConnections,
    demandActivePerAlb,
    activePerAlb,
    acceptedNew,
    rejected,
    acceptedRequestRate,
    connectionUtil,
    nodes,
    failedAttempts,
    lcu,
    p99,
    targetLoad,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const albHealth =
    d.rejected > 0 || d.connectionUtil >= 95 ? "crit" : d.connectionUtil >= 80 ? "warn" : "ok";
  const targetHealth = d.targetLoad >= 95 ? "crit" : d.targetLoad >= 85 ? "warn" : "ok";
  const clientHealth = d.failedAttempts >= 5 ? "crit" : d.failedAttempts >= 0.5 ? "warn" : "ok";
  const ingressId = d.nlb ? "nlb" : "dns";
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: d.requestRate,
        sublabel: `${formatCount(d.newConnections)} new conns/s`,
        meta: { view: "flow" },
      },
      d.nlb
        ? {
            id: "nlb",
            label: "Network Load Balancer",
            kind: "lb",
            health: "ok",
            utilization: 0.2,
            throughput: d.acceptedRequestRate,
            sublabel: "static IP per AZ",
            detail:
              "Layer 4 front door. It forwards TCP to each ALB target group; the ALB still accepts the connection and enforces its own limit.",
            meta: { view: "flow" },
          }
        : {
            id: "dns",
            label: "Route 53",
            kind: "dns",
            health: "ok",
            utilization: 0.1,
            throughput: d.acceptedRequestRate,
            sublabel: "weighted ALB records",
            detail:
              "Weighted records split clients across ALB shards. Clients must honor the 60-second DNS TTL so they can leave a removed node.",
            meta: { view: "flow" },
          },
      {
        id: "alb",
        label: "ALB fleet",
        kind: "lb",
        health: albHealth,
        utilization: clamp(d.connectionUtil / 100),
        throughput: d.acceptedRequestRate,
        sublabel: `${d.albCount} shard${d.albCount === 1 ? "" : "s"} · ${d.nodes} nodes each`,
        detail: `Illustrative per-node capacity is ${formatCount(NODE_CONNECTION_CAPACITY)} active connections. Illustrative per-ALB ceiling is ${formatCount(d.ceiling)}; the effective limit is ${formatCount(d.limit)}. ${formatCount(d.rejected)} new connections/s are rejected.`,
        meta: { view: "flow", shards: d.albCount, nodes: d.nodes },
      },
      {
        id: "targets",
        label: "Target group",
        kind: "service",
        health: targetHealth,
        utilization: clamp(d.targetLoad / 100),
        throughput: d.acceptedRequestRate,
        sublabel: "healthy targets",
        detail: `${formatCount(d.acceptedRequestRate)} accepted requests/s against an illustrative target capacity of ${formatCount(TARGET_RPS_CAPACITY)} rps.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-ingress", "client", ingressId, d.newConnections / 50_000, clientHealth),
      edge("ingress-alb", ingressId, "alb", d.acceptedNew / Math.max(1, d.newConnections), albHealth),
      edge("alb-targets", "alb", "targets", d.targetLoad / 100, targetHealth),
    ],
    metrics: [
      metric(
        "active-per-alb",
        "Active connections per ALB",
        d.activePerAlb,
        "",
        d.limit * 0.8,
        d.limit * 0.95,
        "rps",
      ),
      metric("connection-utilization", "Per-ALB connection utilization", d.connectionUtil, "%", 80, 95, "percent"),
      metric("rejected", "Rejected connections", d.rejected, " /s", 1, 100, "rps"),
      metric("failed-attempts", "Failed connection attempts", d.failedAttempts, "%", 0.5, 2, "percent"),
      metric("p99", "ALB p99", d.p99, "ms", 250, 800, "ms"),
      metric("lcu", "LCU per ALB", d.lcu, " LCU", undefined, undefined, "number"),
      metric("alb-nodes", "ALB nodes per shard", d.nodes, " nodes", undefined, undefined, "count"),
      metric("target-load", "Target group load", d.targetLoad, "%", 85, 95, "percent"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      nlb: d.nlb ? 1 : 0,
      albs: d.albCount,
      ceiling: d.ceiling,
    },
    summary: `${formatCount(d.activePerAlb)} active per ALB (${d.connectionUtil.toFixed(0)}% of ${formatCount(d.limit)}); Rejected connections ${formatCount(d.rejected)}/s; ${d.failedAttempts.toFixed(0)}% failed connection attempts.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
          Math.sin(index / 2.1) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "connection-utilization",
    metricId: "connection-utilization",
    warn: 80,
    crit: 95,
    title: "Per-ALB connection utilization crossed the limit",
    cause:
      "Active connections approached the lower of the illustrative per-ALB ceiling and the 100-node per-ALB ceiling. New connection churn and long lifetimes filled the connection table.",
    fix:
      "Add ALB shards behind an NLB or DNS-weighted records, reduce connection lifetime, or increase connection reuse. Raising the illustrative ceiling above the node ceiling does not add capacity.",
    checkFirst: [
      "Check ActiveConnectionCount and RejectedConnectionCount per ALB, then split by Availability Zone.",
      "Count the active nodes: run `dig +short all.` with the ALB DNS name and pipe the output to `wc -l`.",
      "Compare the illustrative ceiling with the node ceiling and the current LCU consumption.",
    ],
  },
  {
    id: "rejected",
    metricId: "rejected",
    warn: 1,
    crit: 100,
    title: "The ALB is rejecting new connections",
    cause:
      "The load balancer reached its maximum number of connections, so new TCP connections were rejected before a target could be chosen.",
    fix:
      "Shard across more ALBs and give clients one stable entry point. Bound retries with backoff and jitter so rejected clients do not amplify the next attempt.",
    checkFirst: [
      "Read RejectedConnectionCount, not only RequestCount; rejected connections never become requests.",
      "Separate rejected connections from ELB-generated 5xx and target-generated 5xx.",
      "Check whether the clients open short-lived connections instead of reusing them.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 250,
    crit: 800,
    title: "ALB p99 breached the latency objective",
    cause:
      "Connections are queueing at the load balancer while clients retry. The target may be healthy; the admission path is the constraint.",
    fix:
      "Add shards, reduce connection lifetime, and cap retries. Check TargetResponseTime before adding targets.",
    checkFirst: [
      "Compare ALB latency with TargetResponseTime for the same window.",
      "Check rejected connections and client retry volume.",
      "Check whether one Availability Zone or one shard carries the tail.",
    ],
  },
  {
    id: "failed-attempts",
    metricId: "failed-attempts",
    warn: 0.5,
    crit: 2,
    title: "Connection attempts are failing",
    cause:
      "New TCP connections are rejected before a request reaches the ALB. Clients see connection failures; this is not an HTTP 5xx from the target.",
    fix:
      "Shard the ALB fleet, reduce connection lifetime, and bound retries with backoff and jitter. Do not retry rejected connections without a budget.",
    checkFirst: [
      "Read RejectedConnectionCount at the same timestamps.",
      "Check client-side connection errors separately from HTTPCode_ELB_5XX_Count and HTTPCode_Target_5XX_Count.",
      "Confirm targets are healthy; this is an admission-path failure, not a target 5xx.",
    ],
  },
  {
    id: "target-load",
    metricId: "target-load",
    warn: 85,
    crit: 95,
    title: "Sharding moved the bottleneck to the targets",
    cause:
      "The ALB fleet now accepts more requests than the target group can serve. Adding load balancers does not add target capacity.",
    fix:
      "Add target capacity or reduce accepted request rate. Re-check per-target latency and healthy host count before adding more ALBs.",
    checkFirst: [
      "Check healthy host count and request count per target.",
      "Compare target CPU and latency with the accepted request rate.",
      "Check whether one target group receives all the new shards.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const albConnectionLimitModel: SimModel = {
  id: "traffic-alb-connection-limit",
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
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    const nlbFlag = d.nlb ? 1 : 0;
    const previousNlb = Number(frame.flags.nlb ?? 0);
    const previousAlbs = Number(frame.flags.albs ?? 1);
    const previousCeiling = Number(frame.flags.ceiling ?? 0);
    next.flags = { ...frame.flags, ...next.flags, seed: Number(frame.flags.seed ?? 20261110), paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, Number(frame.flags.seed ?? 20261110));
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (nlbFlag !== previousNlb) {
      pushEvent(next, {
        id: "nlb-change",
        at: frame.t,
        severity: "info",
        title: nlbFlag === 1 ? "NLB inserted in front of the ALB fleet" : "NLB removed from the path",
        detail:
          nlbFlag === 1
            ? "Clients now use one NLB endpoint with a static IP per Availability Zone. Each ALB still enforces its own connection limit."
            : "Clients now resolve Route 53 weighted records directly. The ALB limits are unchanged.",
        nodeId: "alb",
      });
    }
    if (d.albCount !== previousAlbs) {
      pushEvent(next, {
        id: "alb-count-change",
        at: frame.t,
        severity: "info",
        title: `ALB fleet changed to ${d.albCount} shard${d.albCount === 1 ? "" : "s"}`,
        detail: `Each shard now carries about ${formatCount(d.demandActivePerAlb)} active connections against a ${formatCount(d.limit)} limit.`,
        nodeId: "alb",
        metricId: "active-per-alb",
      });
    }
    if (d.ceiling !== previousCeiling) {
      pushEvent(next, {
        id: "ceiling-change",
        at: frame.t,
        severity: "info",
        title: `Illustrative ALB ceiling changed to ${formatCount(d.ceiling)}`,
        detail: `The effective per-ALB limit is the lower of the illustrative ceiling and the ${formatCount(NODE_CEILING)} node ceiling: ${formatCount(d.limit)}.`,
        nodeId: "alb",
        metricId: "active-per-alb",
      });
    }
    if (d.rejected > 0 && frame.flags.saturated !== 1) {
      pushEvent(next, {
        id: "per-alb-saturated",
        at: frame.t,
        severity: "crit",
        title: "Per-ALB connection limit reached",
        detail: `${formatCount(d.rejected)} new connections/s are rejected. Each ALB is using ${d.nodes} of ${MAX_NODES_PER_ALB} nodes; the node ceiling is the binding limit in this model.`,
        nodeId: "alb",
        metricId: "rejected",
      });
      next.flags.saturated = 1;
    }
    if (d.rejected <= 0) next.flags.saturated = 0;
    next.flags.nlb = nlbFlag;
    next.flags.albs = d.albCount;
    next.flags.ceiling = d.ceiling;
    next.summary = `${formatCount(d.activePerAlb)} active per ALB (${d.connectionUtil.toFixed(0)}% of ${formatCount(d.limit)}); Rejected connections ${formatCount(d.rejected)}/s; ${d.failedAttempts.toFixed(0)}% failed connection attempts.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `Per-ALB demand is ${formatCount(d.demandActivePerAlb)} active connections against an effective limit of ${formatCount(d.limit)}.`,
    );
    if (d.ceiling > NODE_CEILING) {
      items.push(
        `The illustrative ceiling of ${formatCount(d.ceiling)} is above the model's ${formatCount(NODE_CEILING)} node ceiling, so the extra ceiling cannot be used by one ALB.`,
      );
    }
    items.push(
      `Each ALB uses ${d.nodes} of ${MAX_NODES_PER_ALB} nodes. The fleet needs ${d.albCount * d.nodes} nodes across ${d.albCount} shard${d.albCount === 1 ? "" : "s"}.`,
    );
    items.push(
      `${formatCount(d.rejected)} new connections/s are rejected, so ${d.failedAttempts.toFixed(0)}% of connection attempts fail before reaching a target.`,
    );
    items.push(
      `LCU per ALB is ${d.lcu.toFixed(0)}; new connections and active connections are the dimensions modeled here.`,
    );
    if (d.nlb) {
      items.push(`The NLB provides static IPs and one endpoint. It adds a hop; it does not add per-ALB capacity.`);
    } else if (d.albCount > 1) {
      items.push(`Route 53 weighted records split clients across shards. Clients must honor the 60-second DNS TTL to leave a removed node.`);
    } else {
      items.push(`One ALB has no shard to absorb a connection spike.`);
    }
    if (d.targetLoad >= 85) {
      items.push(`The target group is at ${d.targetLoad.toFixed(0)}% of its illustrative capacity; the next limit is behind the load balancer.`);
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
    description: "One ALB with short-lived connections and plenty of node headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "High request rate and long connections, still below the per-ALB warning line.",
    tone: "warn",
    params: defaults({ requestRate: 150_000, requestsPerConnection: 10, connectionSeconds: 60 }),
  },
  {
    id: "failure",
    label: "Connection wall",
    description: "Long connections and low reuse fill one ALB; new connections are rejected.",
    tone: "crit",
    params: defaults({
      requestRate: 250_000,
      requestsPerConnection: 5,
      connectionSeconds: 60,
      albCount: 1,
      nlbEnabled: 0,
      quotaPerAlb: 1_200_000,
    }),
  },
  {
    id: "quota-raised",
    label: "Raise ceiling",
    description: "Same load with a 5M illustrative ceiling. The 100-node ceiling still binds and the rejections remain.",
    tone: "crit",
    params: defaults({
      requestRate: 250_000,
      requestsPerConnection: 5,
      connectionSeconds: 60,
      albCount: 1,
      nlbEnabled: 0,
      quotaPerAlb: 5_000_000,
    }),
  },
  {
    id: "sharded",
    label: "Shard + NLB",
    description: "Four ALBs behind an NLB. Per-ALB connections fall; the targets become the next limit.",
    tone: "ok",
    params: defaults({
      requestRate: 250_000,
      requestsPerConnection: 5,
      connectionSeconds: 60,
      albCount: 4,
      nlbEnabled: 1,
      quotaPerAlb: 1_200_000,
    }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Four shards behind an NLB with lower traffic and shorter connections.",
    tone: "ok",
    params: defaults({
      requestRate: 180_000,
      requestsPerConnection: 10,
      connectionSeconds: 45,
      albCount: 4,
      nlbEnabled: 1,
      quotaPerAlb: 1_200_000,
    }),
  },
];

const quotaExperiment: Experiment = {
  id: "predict-quota-ceiling",
  title: "Predict what a ceiling increase buys",
  simId: "alb-connection-limit",
  question:
    "You raise the illustrative per-ALB connection ceiling from 1.2M to 5M. Rejected connections stay at 30,000/s. Why?",
  prediction: {
    options: [
      { id: "node-ceiling", label: "The 100-node ceiling still caps each ALB; the extra ceiling is not usable by one ALB." },
      { id: "redeploy", label: "The ceiling change needs a redeploy before it takes effect." },
      { id: "targets", label: "The targets are rejecting the connections, not the ALB." },
      { id: "nlb", label: "The NLB is the bottleneck." },
    ],
    correctOptionId: "node-ceiling",
    explanation:
      "A teaching ceiling is not a capacity grant. AWS documents a maximum of 100 active ALB nodes across Availability Zones; it does not publish an adjustable per-ALB active-connection quota. In this model each node carries 12,000 active connections, so one ALB tops out at 1.2M no matter how high the illustrative ceiling goes. Sharding adds nodes and limits; a ceiling increase does not.",
  },
  setup: defaults({
    requestRate: 250_000,
    requestsPerConnection: 5,
    connectionSeconds: 60,
    albCount: 1,
    nlbEnabled: 0,
    quotaPerAlb: 5_000_000,
  }),
  runFor: 20,
  observe: [
    "Active connections per ALB pin at 1.2M and the node count reaches 100.",
    "Rejected connections hold at 30,000/s and 60% of connection attempts fail.",
    "The 5M illustrative ceiling produces the same rejection rate as the 1.2M ceiling.",
    "The targets remain healthy; the bottleneck is the ALB admission path.",
  ],
  explain:
    "Each ALB can add nodes only up to the documented 100-node maximum. Once every node is busy, the ALB rejects new connections before it can choose a target. Raising the illustrative connection ceiling changes the number the model allows, but it does not create nodes or target capacity. The fix is to change the topology: more ALBs, each with its own node ceiling, behind one entry point.",
  fix: defaults({
    requestRate: 250_000,
    requestsPerConnection: 5,
    connectionSeconds: 60,
    albCount: 4,
    nlbEnabled: 1,
    quotaPerAlb: 5_000_000,
  }),
  debrief:
    "Four shards bring per-ALB demand to 750,000 active connections, below the 1.2M teaching ceiling, and rejections fall to zero. The target group is now at 50% of its illustrative capacity. That is the next limit to watch; sharding the load balancer does not shard the targets.",
};

const nlbExperiment: Experiment = {
  id: "predict-nlb-role",
  title: "Predict what the NLB changes",
  simId: "alb-connection-limit",
  question:
    "You put an NLB in front of the single ALB. What changes for the rejected connections?",
  prediction: {
    options: [
      { id: "same-limit", label: "Nothing; the ALB's per-node limit is unchanged. The NLB adds static IPs and a hop." },
      { id: "absorbs", label: "They fall to zero because the NLB absorbs the connection churn." },
      { id: "half", label: "They fall by half because the NLB balances across Availability Zones." },
      { id: "worse", label: "They rise because the NLB adds another connection hop." },
    ],
    correctOptionId: "same-limit",
    explanation:
      "The NLB is Layer 4. It accepts client TCP connections and forwards them to the ALB target group; the ALB still accepts the connection and still enforces its own limit. The NLB's value is a static IP per Availability Zone, one endpoint in front of many ALBs, and health-aware failover. It is not extra ALB node capacity.",
  },
  setup: defaults({
    requestRate: 250_000,
    requestsPerConnection: 5,
    connectionSeconds: 60,
    albCount: 1,
    nlbEnabled: 1,
    quotaPerAlb: 1_200_000,
  }),
  runFor: 20,
  observe: [
    "Rejected connections remain at 30,000/s and failed connection attempts stay at 60%.",
    "Active connections per ALB remain pinned at 1.2M with 100 nodes.",
    "The p99 is about 2 ms higher from the extra hop.",
    "The NLB itself looks healthy; the ALB is still the constrained component.",
  ],
  explain:
    "Adding a front door before a single ALB changes the entry point, not the ALB's ceiling. The NLB becomes useful when there are several ALBs to put behind it: clients get one stable endpoint and static IPs, while each ALB keeps its own node pool and limit. The NLB does not replace sharding.",
  fix: defaults({
    requestRate: 250_000,
    requestsPerConnection: 5,
    connectionSeconds: 60,
    albCount: 4,
    nlbEnabled: 1,
    quotaPerAlb: 1_200_000,
  }),
  debrief:
    "With four ALBs behind the NLB, per-ALB demand falls to 750,000 and rejections stop. The NLB now provides the stable entry point and static addresses that make the shard fleet usable by clients. The tradeoff is an extra hop, another component to monitor, and a target group per ALB.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Application Load Balancer (ALB) is a Layer 7 load balancer. It accepts client TCP connections, terminates HTTP or HTTPS, chooses a target, and opens connections to that target. It scales by adding nodes and by making nodes larger. AWS documents a maximum of 100 active ALB nodes across Availability Zones. Each node has finite connection capacity. When the ALB cannot add capacity, new connections are rejected before a target is chosen.",
  },
  {
    type: "p",
    text: "The trap is connection lifetime. Active connections are approximately new connections per second multiplied by connection lifetime. A move to WebSockets, gRPC streams, or long keep-alive can multiply active connections without changing request rate. The ALB can be healthy, the targets can be healthy, and CPU can be low while the connection table is full. The ceiling slider in this lab is an illustrative teaching value; AWS documents the 100-node maximum, not an adjustable per-ALB active-connection quota. The scenario's quota is that illustrative ceiling.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, Domain Name System (DNS) or Network Load Balancer (NLB), ALB fleet, target group. One ALB is one shard. Sharding puts several ALBs behind Route 53 weighted records or an NLB, all pointing at the same targets. The NLB gives a static IP per Availability Zone and one endpoint; it is Layer 4 and forwards TCP to each ALB, so each ALB still enforces its own limit. Sharding is what adds per-ALB capacity.",
  },
  {
    type: "compare",
    leftTitle: "Single ALB",
    rightTitle: "Sharded ALBs behind NLB",
    rows: [
      { label: "Connection ceiling", left: "One node pool, capped at 100 nodes", right: "One node pool per ALB, each with its own 100-node ceiling" },
      { label: "Client entry point", left: "One ALB DNS name", right: "One NLB endpoint with static IPs per Availability Zone" },
      { label: "Failure domain", left: "One ALB limit affects every client", right: "One shard can fail while others keep serving" },
      { label: "Cost and operations", left: "Lowest hourly cost, one metric set", right: "More ALB hours, more health checks, per-shard metrics and logs" },
    ],
  },
  {
    type: "p",
    text: "AWS's sharding guidance is to watch the active node count with a special DNS query and plan to shard as the count approaches 100. Clients must honor the 60-second ELB DNS TTL. In this model each node carries 12,000 active connections, so one ALB tops out at 1.2M; the 100-node maximum is the documented part, and the per-node number is an illustrative teaching value.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Active connections per ALB, shown against the lower of the illustrative ceiling and the node ceiling.",
      "Per-ALB connection utilization, rejected connections per second, and failed connection attempts.",
      "ALB p99, Load Balancer Capacity Unit (LCU) per ALB, the node count each ALB is using, and target group load.",
      "A timeline view of the incident: connection growth, ceiling change, rejection, shard change, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Connection wall. Note the node count before you raise the illustrative ceiling; Raise ceiling changes the number but not the rejection rate. Apply Shard + NLB and watch per-ALB connections fall and target load rise. Switch to Timeline to replay the threshold crossings.",
  },
  {
    type: "table",
    headers: ["Lever", "What it changes", "What it does not change"],
    rows: [
      ["Raise the illustrative ceiling", "The teaching ceiling in this model; not an AWS quota", "The 100-node maximum or the per-node capacity"],
      ["Add ALB shards", "Per-ALB connections and blast radius", "Target capacity or client DNS behavior"],
      ["Put an NLB in front", "Entry point, static IPs, and failover", "Each ALB's connection limit"],
      ["Shorten connections or increase reuse", "Active connections and new-connection churn for the same request rate", "The per-node ceiling; it changes the demand placed on it"],
    ],
  },
  {
    type: "p",
    text: "The first question is which limit binds: the illustrative ceiling, the per-ALB node ceiling, the targets, or the entry point. The simulator lets you move each one and watch the next limit appear.",
  },
  { type: "sim", simId: "alb-connection-limit" },
  { type: "experiment", experimentId: "predict-quota-ceiling" },
  { type: "experiment", experimentId: "predict-nlb-role" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One ALB scaled out until it reached 100 nodes and its effective connection ceiling. New connections were rejected before a target was chosen, so the target group stayed healthy while clients saw connection failures. Raising the illustrative ceiling changed the model's number, but the node ceiling still bound, so the rejection rate did not move.",
  },
  {
    type: "p",
    text: "Sharding to four ALBs divided per-ALB demand by four and removed the rejections. Putting an NLB in front gave clients one endpoint and static IPs, but the NLB alone did nothing for the single ALB's limit. The target group then became the next limit to watch, at 50% of its illustrative capacity.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch ALB: `ActiveConnectionCount`, `NewConnectionCount`, `RejectedConnectionCount`, `ConsumedLCUs`, `HTTPCode_ELB_5XX_Count`, and `TargetResponseTime`, split by load balancer and Availability Zone. Rejected connections are a separate signal from ELB and target 5xx.",
      "Node count: `dig +short all.` with the ALB DNS name, piped to `wc -l`, shows the active nodes; use it for capacity alerting, not for sending traffic.",
      "Access logs: request-level errors, Transport Layer Security (TLS) negotiation failures, and client retry patterns. Rejected connections are counted by RejectedConnectionCount and may never produce a request log line.",
      "Target group: healthy host count, request count per target, target CPU, and target 5xx. Healthy targets during an ALB rejection spike are the clue.",
      "NLB: `ActiveFlowCount`, `NewFlowCount`, `ConsumedLCUs`, and per-AZ health. The NLB can be healthy while the ALB behind it rejects.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check RejectedConnectionCount and the active node count before you raise the illustrative ceiling or add targets. Split ELB 5xx from target 5xx; rejected connections are a separate signal. If the ALB is rejecting while targets are healthy, the constraint is the load balancer's admission path.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the ALB is rejecting connections: RejectedConnectionCount rises while target health and target latency are normal.",
      "Count nodes and compare the illustrative ceiling with the 100-node ceiling.",
      "Reduce connection lifetime or increase reuse where the client supports it.",
      "Add ALB shards, all pointing at the same targets, and split traffic with Route 53 weights or an NLB.",
      "Put an NLB in front when clients need static IPs or one endpoint; keep TLS and path routing on the ALBs.",
      "Shift traffic to the new shards gradually, then verify per-ALB connections, rejections, target load, and LCU together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More ALBs add hourly cost, health checks, and per-shard metrics and logs; they also multiply the target health-check load.",
      "Sticky sessions do not cross ALBs, so a client can land on a different target after a shard change.",
      "An NLB adds a hop and another failure domain. It uses a TCP listener to the ALB, keeps TLS termination on the ALB, and preserves the client IP for the ALB to put in X-Forwarded-For.",
      "DNS-weighted sharding avoids the extra hop but depends on clients honoring the 60-second TTL and refreshing after a failure.",
      "Raising the illustrative ceiling can help below the node ceiling; above it, the extra ceiling is capacity you cannot use on one ALB.",
      "Sharding moves the bottleneck to the target group or the NLB, so verify the next limit before declaring recovery.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "locate-alb-limit",
    question:
      "The ALB is healthy, targets are healthy, CPU is 40%, and clients see 503s at peak. How do you localize the bottleneck?",
    difficulty: 3,
    hints: [
      "Separate load-balancer errors from target errors.",
      "Rejected connections never become requests.",
    ],
    answer:
      "I would start with the ALB metrics, not target CPU. RejectedConnectionCount tells me the load balancer hit its maximum connections; ActiveConnectionCount and NewConnectionCount tell me whether long-lived connections or churn is driving it. I would split by Availability Zone and by load balancer, then count the active nodes with the all-prefixed DNS query. If ELB 5xx is high while target 5xx and target latency are normal, the admission path is a candidate, but rejected connections are counted separately and may not appear as 5xx. I would also check the illustrative ceiling against the node ceiling, LCU consumption, and whether a client change shortened connection reuse.",
    followUps: [
      "What would make you suspect the target group instead?",
      "How does a WebSocket rollout change the diagnosis?",
      "Which metric would you alert on first?",
    ],
    redFlags: [
      "Starts by adding targets or raising CPU.",
      "Uses RequestCount as proof that no connections were rejected.",
      "Ignores the node count and assumes an adjustable active-connection quota exists.",
    ],
    rubric: [
      "Separates ELB and target errors.",
      "Names rejected and active connections.",
      "Checks node count and per-AZ skew.",
      "States what would falsify the diagnosis.",
    ],
  },
  {
    id: "why-shard",
    question:
      "Why shard across ALBs instead of raising an illustrative per-ALB connection ceiling?",
    difficulty: 3,
    hints: [
      "A ceiling is not a node.",
      "AWS documents a maximum node count per ALB.",
    ],
    answer:
      "AWS does not publish an adjustable per-ALB active-connection quota. The documented scale boundary is the 100-node maximum, and LCU dimensions govern capacity and billing. A support case can change some limits, but it does not add nodes. Sharding gives each ALB its own node pool and limit, reduces the blast radius of one shard, and lets me place the fleet behind one NLB or a set of weighted DNS records. The cost is more load balancer hours, more health checks, per-shard observability, and session affinity that does not cross shards.",
    followUps: [
      "When would raising a different limit, such as reserved LCUs, still be the right first move?",
      "How do you split traffic between shards without breaking clients?",
      "What happens to sticky sessions after sharding?",
    ],
    redFlags: [
      "Assumes a per-ALB active-connection quota exists and adds nodes.",
      "Shards without a traffic-splitting plan.",
      "Ignores the target group's capacity.",
    ],
    rubric: [
      "Explains the 100-node ceiling.",
      "Distinguishes an illustrative ceiling from node capacity.",
      "Names the traffic-splitting mechanism.",
      "States the operational cost.",
    ],
  },
  {
    id: "nlb-role",
    question:
      "You put an NLB in front of a fleet of ALBs. What does it buy, and what changes for clients and operators?",
    difficulty: 4,
    hints: [
      "The NLB is Layer 4; the ALB is Layer 7.",
      "One ALB per NLB target group.",
    ],
    answer:
      "The NLB gives one endpoint with a static IP per Availability Zone, health-aware failover, and Layer 4 capacity in front of several ALBs. Each ALB is registered as a target in its own target group; an ALB can be behind at most two NLBs. Clients connect to the NLB, which forwards TCP to an ALB, and the ALB still terminates TLS and makes the path-routing decision. The ALB appends the client IP to X-Forwarded-For. The costs are an extra hop, another component to monitor, and the fact that each ALB still has its own connection limit. The NLB does not replace sharding.",
    followUps: [
      "Where does TLS terminate in this design?",
      "How does the client IP reach the application?",
      "What happens when one ALB target fails health checks?",
    ],
    redFlags: [
      "Says the NLB removes the ALB connection limit.",
      "Terminates TLS twice without explaining the certificate path.",
      "Registers multiple ALBs in one target group.",
    ],
    rubric: [
      "Names static IPs and the extra hop.",
      "Keeps TLS and routing on the ALB.",
      "Explains client IP and X-Forwarded-For.",
      "States that per-ALB limits remain.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards show per-ALB ActiveConnectionCount, NewConnectionCount, RejectedConnectionCount, and LCU.",
      "An alert exists for rejected connections and for the active node count approaching 100.",
      "The client connection lifetime and reuse policy are documented.",
      "Sharding has a traffic-splitting plan: weighted DNS records or an NLB in front of ALBs.",
      "Each ALB has its own target group, and target health checks are sized for the shard count.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the ALB is rejecting connections while targets are healthy.",
      "Count active nodes before raising the illustrative ceiling or adding targets.",
      "Reduce connection lifetime or add shards; do not retry rejected connections without backoff.",
      "Watch the next limit: target load, NLB flows, or DNS behavior.",
      "Record the shard weights and the time of each change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify per-ALB connections, rejected connections, ELB 5xx, target 5xx, target load, and LCU at peak.",
      "Remove temporary shards or rebalance the weights deliberately.",
      "Document the connection-lifetime assumption and the shard count.",
      "Add a load test that drives the fleet to the per-ALB ceiling.",
    ],
  },
];

const references = [
  {
    title: "Scaling strategies for Elastic Load Balancing",
    url: "https://aws.amazon.com/blogs/networking-and-content-delivery/scaling-strategies-for-elastic-load-balancing/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The 100-node ALB ceiling, node counting, DNS TTL, and sharding patterns.",
  },
  {
    title: "Use an Application Load Balancer as a target of a Network Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/network/application-load-balancer-target.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Static IPs, one ALB per target group, and the NLB-to-ALB path.",
  },
  {
    title: "CloudWatch metrics for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "ActiveConnectionCount, NewConnectionCount, RejectedConnectionCount, and ConsumedLCUs.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-connection-limit": {
      model: albConnectionLimitModel,
      presets,
      instructions:
        "Start healthy, apply Connection wall, then Raise ceiling. Watch the node count and rejected connections. Apply Shard + NLB and check target load, the next limit.",
      experimentIds: [quotaExperiment.id, nlbExperiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 100-node per-ALB maximum is AWS-documented; per-node connection capacity, the resulting 1.2M per-ALB ceiling, target capacity, and LCU shaping are teaching values, not AWS-published limits or guarantees. AWS does not publish an adjustable per-ALB active-connection quota. The model assumes an even split across ALB shards.",
    },
  },
  experiments: [quotaExperiment, nlbExperiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-health-checks",
    "traffic-alb-lcu-cost",
    "traffic-nlb-in-front-of-alb",
    "traffic-503-debug",
  ],
};
