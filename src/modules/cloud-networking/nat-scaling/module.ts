import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const BANDWIDTH_PER_NAT = 5;
const PORTS_PER_DESTINATION = 55_000;
const CONNECTION_HOLD = 60;

const params = [
  {
    id: "egress",
    label: "Egress bandwidth",
    min: 1,
    max: 30,
    step: 1,
    value: 4,
    unit: " Gbps",
    group: "Traffic",
    help: "Total outbound bandwidth from the private subnets. AWS NAT gateways start at 5 Gbps and scale automatically; this model treats 5 Gbps per gateway as a teaching allocation.",
    format: "number" as const,
  },
  {
    id: "gateways",
    label: "NAT gateways",
    min: 1,
    max: 6,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Number of NAT gateways in the egress path. One gateway shared across Availability Zones concentrates traffic and failure.",
    format: "count" as const,
  },
  {
    id: "share",
    label: "One-destination share",
    min: 0,
    max: 100,
    step: 5,
    value: 30,
    unit: "%",
    group: "Connections",
    help: "Share of new connections going to a single destination IP, port, and protocol. The per-destination port allocation is the limit that catches chatty clients.",
    format: "percent" as const,
  },
  {
    id: "connections",
    label: "New connections",
    min: 100,
    max: 5_000,
    step: 100,
    value: 800,
    unit: " /s",
    group: "Connections",
    help: "New connections per second. With a 60-second hold, the concurrent connection count is roughly the rate times 60.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  egress: number;
  gateways: number;
  share: number;
  connections: number;
  capacity: number;
  bandwidthUtil: number;
  portsUsed: number;
  portUtil: number;
  latency: number;
  errorRate: number;
  natHealth: Health;
}

function compute(p: Params): Computed {
  const egress = Math.max(1, num(p, "egress", 4));
  const gateways = clamp(Math.round(num(p, "gateways", 3)), 1, 6);
  const share = clamp(num(p, "share", 30), 0, 100);
  const connections = Math.max(1, num(p, "connections", 800));
  const capacity = gateways * BANDWIDTH_PER_NAT;
  const bandwidthUtil = (egress / capacity) * 100;
  const portsUsed = connections * CONNECTION_HOLD * (share / 100);
  const portUtil = (portsUsed / PORTS_PER_DESTINATION) * 100;
  const latency = 18 + Math.max(0, bandwidthUtil - 80) * 5 + Math.max(0, portUtil - 80) * 3;
  const errorRate = clamp(Math.max(0, Math.max(bandwidthUtil, portUtil) - 100), 0, 100);
  const worst = Math.max(bandwidthUtil, portUtil);
  const natHealth: Health = worst >= 95 || errorRate >= 5 ? "crit" : worst >= 80 ? "warn" : "ok";
  return {
    egress,
    gateways,
    share,
    connections,
    capacity,
    bandwidthUtil,
    portsUsed,
    portUtil,
    latency,
    errorRate,
    natHealth,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["bandwidth", values.bandwidthUtil, 0],
    ["ports", values.portUtil, 0],
    ["latency", values.latency, 1],
    ["errors", values.errorRate, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 6)) / 2.5) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const overloaded = values.errorRate > 0;
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "private workloads",
        kind: "service",
        health: overloaded ? "crit" : values.natHealth === "warn" ? "warn" : "ok",
        sublabel: `${formatCount(values.connections)} conn/s · ${values.egress} Gbps`,
        detail: overloaded
          ? "Connections time out or reset at the NAT. The workloads are healthy; the shared egress path is not."
          : "Workloads open outbound connections through the NAT gateway. The return path is stateful.",
        meta: { view: "flow" },
      },
      {
        id: "nat",
        label: `NAT × ${values.gateways}`,
        kind: "mesh",
        health: values.natHealth,
        utilization: clamp(Math.max(values.bandwidthUtil, values.portUtil) / 100),
        sublabel: `${Math.round(values.bandwidthUtil)}% BW · ${Math.round(values.portUtil)}% ports`,
        detail: `Modeled allocation ${values.capacity} Gbps across ${values.gateways} gateways. Port usage is ${formatCount(
          values.portsUsed,
        )} of the ${formatCount(PORTS_PER_DESTINATION)} per-destination connections for one IPv4 address.`,
        meta: { view: "flow", ports: Math.round(values.portsUsed) },
      },
      {
        id: "igw",
        label: "internet gateway",
        kind: "external",
        health: "ok",
        sublabel: "public subnet path",
        detail: "The internet gateway is not the bottleneck in this model. The NAT translation and port allocation are.",
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "remote endpoint",
        kind: "external",
        health: "ok",
        sublabel: "single destination",
        detail:
          "When many connections target one destination, the per-destination port allocation fills before total bandwidth. The remote endpoint sees connection failures, not a bandwidth graph.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-nat", "app", "nat", clamp(Math.max(values.bandwidthUtil, values.portUtil) / 100), values.natHealth),
      edge("nat-igw", "nat", "igw", clamp(values.bandwidthUtil / 100), values.natHealth),
      edge("igw-backend", "igw", "backend", overloaded ? 0.3 : 1, overloaded ? "crit" : "ok"),
    ],
    metrics: [
      metric("bandwidth", "Bandwidth utilization", values.bandwidthUtil, "%", 80, 95, "percent"),
      metric("ports", "Port allocation", values.portUtil, "%", 80, 95, "percent"),
      metric("latency", "Egress latency", values.latency, " ms", 100, 300, "ms"),
      metric("errors", "Connection errors", values.errorRate, "%", 1, 5, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${values.egress} Gbps over ${values.gateways} NAT; ${Math.round(
      values.bandwidthUtil,
    )}% bandwidth; ${Math.round(values.portUtil)}% ports; ${formatPercent(values.errorRate)}% errors.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "bandwidth",
    metricId: "bandwidth",
    warn: 80,
    crit: 95,
    title: "NAT bandwidth is the egress bottleneck",
    cause:
      "The total egress bandwidth is above the modeled allocation for the number of gateways. NAT gateways scale, but a single shared gateway concentrates traffic and can lag the demand.",
    fix:
      "Add a NAT gateway in each Availability Zone, route each private subnet to the local NAT, and split high-volume workloads across gateways. Then review the bandwidth allocation.",
    checkFirst: [
      "Check whether all private subnets route to one NAT gateway.",
      "Compare per-AZ egress with the gateway placement.",
      "Check NAT CloudWatch metrics and the internet gateway path.",
    ],
  },
  {
    id: "ports",
    metricId: "ports",
    warn: 80,
    crit: 95,
    title: "NAT port allocation is exhausted for one destination",
    cause:
      "A NAT gateway supports about 55,000 simultaneous connections to one destination per IPv4 address. Chatty clients or a single hot endpoint can fill that allocation while total bandwidth stays low.",
    fix:
      "Add NAT gateways or secondary IPv4 addresses, spread clients across gateways, limit connection creation, and use connection pooling. Monitor idle connections, not only bytes.",
    checkFirst: [
      "Count concurrent connections to the single destination, not just new connections per second.",
      "Check IdleTimeoutCount and connection churn for the NAT.",
      "Check whether clients use a pool or open a connection per request.",
    ],
  },
  {
    id: "latency",
    metricId: "latency",
    warn: 100,
    crit: 300,
    title: "Egress latency is rising at the shared NAT",
    cause:
      "Bandwidth or port pressure is adding queueing and retransmits at the NAT. The application sees slow outbound calls, and the common component is the gateway.",
    fix:
      "Resolve the bandwidth or port limit first, then re-measure. Adding application replicas does not add NAT capacity.",
    checkFirst: [
      "Compare egress latency with NAT bandwidth and port utilization.",
      "Check whether the latency is limited to one destination or one AZ.",
      "Check retransmits and connection resets at the client.",
    ],
  },
  {
    id: "errors",
    metricId: "errors",
    warn: 1,
    crit: 5,
    title: "NAT egress is dropping or resetting connections",
    cause:
      "Bandwidth or per-destination port allocation is exhausted. New connections fail while existing connections may still work, which points at connection churn and the shared gateway.",
    fix:
      "Reduce the pressure that matches the crossed limit: add gateways or addresses for ports, spread routes for bandwidth, and pool connections to lower churn.",
    checkFirst: [
      "Check whether errors are isolated to one destination or spread across many.",
      "Compare active connections with the per-destination allocation.",
      "Check the client connection rate and pooling behavior.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const natScalingModel: SimModel = {
  id: "cloud-networking-nat-scaling",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.errorRate >= 5 && frame.flags.egressLogged !== 1) {
      pushEvent(next, {
        id: "nat-exhausted",
        severity: "crit",
        title: "NAT egress is dropping connections",
        detail: `${Math.round(values.bandwidthUtil)}% bandwidth and ${Math.round(
          values.portUtil,
        )}% per-destination ports. ${formatPercent(values.errorRate)}% of connections fail at the shared gateway.`,
        nodeId: "nat",
        metricId: "errors",
      });
    }
    next.flags.egressLogged = values.errorRate >= 5 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.portUtil >= 80) {
      items.push(
        `The per-destination port allocation is at ${Math.round(values.portUtil)}% with ${formatCount(
          values.portsUsed,
        )} concurrent connections. The limit is per NAT IPv4 address and destination, not just per gateway.`,
      );
    } else {
      items.push(
        `Port allocation is ${Math.round(values.portUtil)}% for the busiest destination. This limit can move independently of bandwidth.`,
      );
    }
    if (values.bandwidthUtil >= 80) {
      items.push(
        `Bandwidth is at ${Math.round(values.bandwidthUtil)}% of the modeled ${values.capacity} Gbps allocation across ${
          values.gateways
        } gateways. One shared gateway is both a capacity and a failure-domain decision.`,
      );
    } else {
      items.push(
        `Bandwidth is at ${Math.round(values.bandwidthUtil)}% of the modeled allocation. The gateway has headroom on this axis.`,
      );
    }
    items.push(
      `A single NAT for multiple Availability Zones concentrates traffic and creates a zonal dependency. Per-AZ gateways reduce both the bandwidth pressure and the blast radius.`,
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
    description: "Three gateways carry 4 Gbps with a 30% single-destination share. Bandwidth and ports both have headroom.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Egress reaches 13 Gbps across three gateways. Bandwidth is above the warning line but below critical.",
    tone: "warn",
    params: defaults({ egress: 13, gateways: 3, share: 50, connections: 1_200 }),
  },
  {
    id: "failure",
    label: "Shared NAT",
    description: "One gateway carries 12 Gbps and 3,000 new connections/s to one destination. Both limits are exceeded.",
    tone: "crit",
    params: defaults({ egress: 12, gateways: 1, share: 100, connections: 3_000 }),
  },
  {
    id: "port-exhaustion",
    label: "Port exhaustion",
    description: "Bandwidth is low, but one destination fills the per-NAT port allocation.",
    tone: "crit",
    params: defaults({ egress: 3, gateways: 3, share: 100, connections: 2_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Per-AZ gateways and connection pooling restore bandwidth and port headroom.",
    tone: "ok",
    params: defaults({ egress: 4, gateways: 3, share: 30, connections: 800 }),
  },
];

const experiment: Experiment = {
  id: "predict-port-limit",
  title: "Predict the first exhaustion",
  simId: "egress-path",
  question:
    "One NAT gateway serves three Availability Zones. Clients open 2,000 new connections per second to a single endpoint and hold each connection for 60 seconds. Bandwidth is only 3 Gbps. What limit is reached first?",
  prediction: {
    options: [
      { id: "bandwidth", label: "Bandwidth, because 3 Gbps is the NAT ceiling." },
      { id: "ports", label: "Per-destination port allocation, because 2,000 times 60 is 120,000 concurrent connections." },
      { id: "az", label: "Availability Zone latency, because the gateway is in another zone." },
      { id: "dns", label: "DNS resolution, because each connection needs a lookup." },
    ],
    correctOptionId: "ports",
    explanation:
      "The NAT supports about 55,000 simultaneous connections to one destination per IPv4 address. At 2,000 new connections per second with a 60-second hold, the steady-state count is about 120,000, which exceeds the allocation even though bandwidth is low. Spreading clients across gateways, adding addresses, or pooling connections addresses the port limit.",
  },
  setup: defaults({ egress: 3, gateways: 1, share: 100, connections: 2_000 }),
  runFor: 15,
  observe: [
    "Bandwidth utilization stays below 100 percent.",
    "Port allocation crosses critical and connection errors rise.",
    "The workload node fails while the internet gateway stays healthy.",
    "The single gateway concentrates both the connection count and the failure domain.",
  ],
  explain:
    "NAT has more than one limit. Bandwidth is the obvious one; the per-destination connection allocation is the one that appears with chatty clients and connection-per-request code. The count is per NAT IPv4 address and per unique destination, so one hot endpoint can exhaust it while the rest of the traffic looks fine.",
  fix: defaults({ egress: 3, gateways: 3, share: 35, connections: 800 }),
  debrief:
    "Add gateways and spread clients, add secondary IPv4 addresses, or reduce connection churn with pooling. A bigger bandwidth allocation does not fix a port limit, and another application replica does not add NAT capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A NAT gateway translates outbound traffic from private subnets to a public address so it can reach the internet or another network. It is zonal: it lives in one Availability Zone and is implemented with redundancy inside that zone. If resources in several zones share one gateway, all of their egress depends on that zone and that gateway.",
  },
  {
    type: "p",
    text: "NAT has several capacity limits that move independently. Bandwidth is the most visible; AWS NAT gateways start at 5 Gbps and scale automatically toward 100 Gbps. Packet rate and per-destination connection allocation are separate. Each IPv4 address supports about 55,000 simultaneous connections to each unique destination, identified by destination IP, port, and protocol. A chatty client can exhaust that allocation while bandwidth is low.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is private workload, subnet route table, NAT gateway in a public subnet, internet gateway, remote endpoint. The return traffic is stateful through the NAT. The NAT is also a failure domain: if its zone is unavailable, every subnet routed through it loses egress.",
  },
  {
    type: "table",
    headers: ["Limit", "What it counts", "Symptom", "First fix"],
    rows: [
      ["Bandwidth", "Gbps through the gateway", "Latency and packet loss across many destinations", "Add gateways per AZ and spread routes."],
      ["Per-destination ports", "Concurrent connections to one IP, port, protocol", "Connection failures to one hot endpoint while others work", "Add addresses or gateways, pool connections."],
      ["Packet rate", "Packets per second", "Drops at high packet volume with small payloads", "Split traffic or reduce packet overhead."],
      ["Zone failure", "One gateway in one AZ", "All shared egress fails at once", "Create a gateway in each AZ."],
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Bandwidth utilization against a modeled per-gateway allocation.",
      "Per-destination port allocation against the 55,000-connection limit.",
      "Egress latency and connection errors, which rise when either limit is crossed.",
      "The NAT, internet gateway, and remote endpoint as separate nodes.",
      "A prediction experiment that separates bandwidth from port exhaustion.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Port exhaustion and note that bandwidth stays low while connections fail. Compare that with Shared NAT, where both bandwidth and ports are over the line. Run the experiment before revealing the explanation.",
  },
  {
    type: "p",
    text: "The 5 Gbps per-gateway allocation, 60-second hold, and thresholds are illustrative teaching values. The per-destination 55,000-connection limit and the zonal failure model are the parts to carry into production. AWS NAT gateways scale above the modeled baseline automatically.",
  },
  { type: "sim", simId: "egress-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The port-exhaustion state failed connections while bandwidth stayed at 20 percent. The per-destination allocation filled because 2,000 new connections per second with a 60-second hold produced about 120,000 concurrent connections. The gateway had bandwidth headroom and no port headroom.",
  },
  {
    type: "p",
    text: "The shared-NAT state failed on both axes. One gateway carried 12 Gbps and all connections to one destination, so bandwidth and port allocation crossed critical together. The single gateway was also the failure domain for three zones.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "NAT CloudWatch metrics: bytes, packets, active connections, connection attempts, and idle timeouts.",
      "Connection errors at the client: timeouts or resets to one destination while other destinations work.",
      "Route tables: which private subnets route to which NAT gateway and Availability Zone.",
      "NAT gateway state and zone: a zonal failure removes egress for every subnet that depends on it.",
      "Client connection behavior: pooling, keepalive, and connection-per-request patterns.",
      "Remote endpoint health: a single hot destination concentrates the port allocation.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare bandwidth utilization with per-destination port usage before adding capacity. If bandwidth is low and connections fail to one endpoint, the port allocation is the limit. If many destinations slow down together, bandwidth or the gateway itself is the limit.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Map each private subnet to its NAT gateway and Availability Zone.",
      "Compare per-destination connection counts with the 55,000 limit.",
      "Add a NAT gateway in each AZ and route each subnet to the local gateway.",
      "Add secondary IPv4 addresses or gateways for a hot destination.",
      "Reduce connection churn with pooling, keepalive, and idle timeout tuning.",
      "Scale bandwidth only after the port and packet limits are understood.",
      "Test a zonal failure and confirm the remaining zones keep egress.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A NAT gateway per AZ improves resilience and capacity but increases fixed cost.",
      "A shared NAT is cheaper and simpler, but it concentrates traffic and failure in one zone.",
      "Connection pooling lowers port pressure but can create stale connections and idle timeouts.",
      "More gateways spread load but multiply route-table and monitoring work.",
      "AWS NAT gateways scale automatically, but a sudden burst can still outrun the scaling and the port allocation.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "nat-limits",
    question: "What limits does a NAT gateway have beyond bandwidth, and how would you detect them?",
    difficulty: 3,
    hints: [
      "One limit is per destination, not global.",
      "Look at connection counts and idle timeouts.",
    ],
    answer:
      "Beyond bandwidth, a NAT gateway has packet-rate limits and a per-destination connection allocation. Each IPv4 address supports about 55,000 simultaneous connections to one unique destination, identified by destination IP, port, and protocol. I would monitor active connections, connection attempts, idle timeouts, and errors per destination, not just bytes. I would also check whether clients pool connections or open one per request. A hot endpoint can exhaust the port allocation while total bandwidth stays low.",
    followUps: [
      "How do secondary IPv4 addresses change the limit?",
      "Why is the limit per destination?",
      "What would you change in the client?",
    ],
    redFlags: [
      "Only checks bandwidth.",
      "Adds application replicas.",
      "Ignores connection pooling.",
    ],
    rubric: [
      "Names bandwidth, packet rate, and ports.",
      "Explains per-destination scope.",
      "Monitors connections and idle timeouts.",
      "Considers client pooling.",
    ],
  },
  {
    id: "shared-nat",
    question: "Why is one NAT gateway for three Availability Zones a resilience problem, not just a cost choice?",
    difficulty: 2,
    hints: [
      "NAT is zonal.",
      "All routed subnets depend on the same zone.",
    ],
    answer:
      "The NAT gateway lives in one Availability Zone. If that zone or gateway is unavailable, every private subnet routed through it loses egress, including subnets in the other zones. A per-AZ NAT keeps the failure local and lets the other zones continue. The cost saving from one shared gateway is a bet that the zone never fails and that the shared capacity is enough.",
    followUps: [
      "How would you migrate without downtime?",
      "What would you test after the change?",
      "Which workloads could still share a gateway?",
    ],
    redFlags: [
      "Says NAT is regional.",
      "Ignores the route tables.",
      "Optimizes only cost.",
    ],
    rubric: [
      "States that NAT is zonal.",
      "Explains the shared failure domain.",
      "Proposes per-AZ gateways.",
      "Plans migration and testing.",
    ],
  },
  {
    id: "diagnose-egress",
    question:
      "Egress latency rises across all private subnets and NAT is the common component. What do you check first?",
    difficulty: 3,
    hints: [
      "Check both bandwidth and per-destination ports.",
      "Compare one destination with many.",
    ],
    answer:
      "I would check NAT bandwidth, active connections, per-destination connection counts, idle timeouts, and errors. If latency is isolated to one destination while others are fine, the per-destination port allocation is the likely limit. If many destinations slow down together, bandwidth, packet rate, or the gateway's zone is the likely cause. I would also check whether all subnets route to one gateway, and whether a recent deployment changed connection churn. The fix follows the limit that is actually crossed.",
    followUps: [
      "Which metric distinguishes the two limits?",
      "How would you confirm the gateway zone?",
      "What would you do before adding gateways?",
    ],
    redFlags: [
      "Scales the application.",
      "Adds bandwidth without checking ports.",
      "Ignores route-table topology.",
    ],
    rubric: [
      "Separates bandwidth from ports.",
      "Uses per-destination evidence.",
      "Checks route topology and zone.",
      "Chooses a fix that matches the limit.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every private subnet routes to a NAT gateway in its own AZ.",
      "NAT bandwidth, active connections, and idle timeouts are monitored.",
      "High-churn clients use connection pooling and keepalive.",
      "Per-destination connection concentration is reviewed for hot endpoints.",
      "A zonal NAT failure has been tested.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare bandwidth with per-destination port usage.",
      "Check whether failures are isolated to one destination or spread.",
      "Check the NAT gateway state and its Availability Zone.",
      "Check route tables for subnets sharing the affected gateway.",
      "Apply the fix that matches the crossed limit.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add per-AZ egress where the shared gateway caused the outage.",
      "Tune pooling and idle timeouts.",
      "Add an alert on port allocation and connection errors.",
      "Document the bandwidth and port limits with the route topology.",
    ],
  },
];

const references = [
  {
    title: "NAT gateway basics",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-basics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Bandwidth, packet rate, 55,000 connections per destination, and zonal design.",
  },
  {
    title: "Troubleshoot NAT gateways: cannot initiate more connections",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Explains the per-destination connection limit and remedies.",
  },
  {
    title: "CloudWatch metrics for NAT gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway-cloudwatch.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Active connections, connection attempts, bytes, packets, and idle timeouts.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "egress-path": {
      model: natScalingModel,
      presets,
      instructions:
        "Start healthy, then apply Port exhaustion and compare bandwidth with port allocation. Then apply Shared NAT to see both limits fail together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The 5 Gbps allocation and thresholds are teaching values; the per-destination port limit and zonal behavior are documented.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-nat-gateway", "cloud-networking-egress-cost", "cloud-networking-subnets"],
};
