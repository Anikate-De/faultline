import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import {
  clamp,
  edge,
  MAX_EVENTS,
  metric,
  pushEvent,
  recordSeries,
} from "@/simulation/engine/frame";
import { meta } from "./meta";

const NAT_LIMIT = 55_000;
const NAT_WARN = 44_000;
const NAT_CRIT = 52_250;
const AZ_LABELS = ["A", "B", "C"];

const params = [
  {
    id: "natCount",
    label: "NAT gateways",
    min: 1,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "One NAT gateway in each Availability Zone up to this count. A single NAT serves every private subnet that routes to it.",
    format: "count" as const,
  },
  {
    id: "failedAz",
    label: "Failed Availability Zone",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "0 means no AZ failure. 1, 2, or 3 mark AZ A, B, or C as unavailable. A NAT gateway is zonal; there is no automatic cross-AZ failover.",
    format: "count" as const,
  },
  {
    id: "localRouting",
    label: "Local-AZ routing",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Routing",
    help: "1 routes each private subnet to the NAT in its own AZ when one exists. 0 sends every private subnet to the NAT in AZ A, concentrating all egress on one zone.",
    format: "count" as const,
  },
  {
    id: "connections",
    label: "Connections per destination",
    min: 5_000,
    max: 165_000,
    step: 5_000,
    value: 30_000,
    unit: "",
    group: "Traffic",
    help: "Illustrative simultaneous connections to one destination through the NAT path. AWS documents a limit of 55,000 per unique destination per IPv4 address on a NAT gateway.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  natCount: number;
  failedAz: number;
  localRouting: boolean;
  demand: number;
  failed: number;
  success: number;
  shortfall: number;
  successRate: number;
  connPerNat: number;
  natUtilization: number;
  natHealth: Health;
  privateHealth: Health;
  destinationHealth: Health;
}

function compute(p: Params): Computed {
  const natCount = Math.max(1, Math.min(3, Math.round(num(p, "natCount", 3))));
  const failedAz = Math.max(0, Math.min(3, Math.round(num(p, "failedAz", 0))));
  const localRouting = num(p, "localRouting", 1) >= 0.5;
  const demand = Math.max(1, num(p, "connections", 30_000));
  const exists = [true, natCount >= 2, natCount >= 3];
  const share = demand / 3;
  const assigned = [0, 0, 0];
  let failed = 0;
  for (let index = 0; index < 3; index++) {
    if (failedAz > 0 && index === failedAz - 1) {
      failed += share;
      continue;
    }
    const target = localRouting && exists[index] ? index : 0;
    assigned[target] += share;
  }
  let connPerNat = 0;
  for (let index = 0; index < 3; index++) {
    if (!exists[index] || assigned[index] <= 0) continue;
    if (failedAz > 0 && index === failedAz - 1) {
      failed += assigned[index];
      continue;
    }
    connPerNat = Math.max(connPerNat, assigned[index]);
    failed += Math.max(0, assigned[index] - NAT_LIMIT);
  }
  const success = Math.max(0, demand - failed);
  const shortfall = demand > 0 ? (failed / demand) * 100 : 0;
  const successRate = 100 - shortfall;
  const natHealth: Health =
    shortfall >= 99.9
      ? "down"
      : shortfall > 0 || connPerNat >= NAT_LIMIT
        ? "crit"
        : connPerNat >= NAT_WARN
          ? "warn"
          : "ok";
  return {
    natCount,
    failedAz,
    localRouting,
    demand,
    failed,
    success,
    shortfall,
    successRate,
    connPerNat,
    natUtilization: clamp(connPerNat / NAT_LIMIT, 0, 1),
    natHealth,
    privateHealth: shortfall > 0 ? "crit" : "ok",
    destinationHealth: success > 0 ? "ok" : "crit",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * (0.98 + 0.04 * Math.sin((index + (seed % 7)) / 2.3));
      const value = wave + Math.sin(index / 2.1) * Math.max(0.1, item.value * 0.02);
      return item.format === "percent" ? clamp(value, 0, 100) : Math.max(0, value);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const failedLabel = v.failedAz > 0 ? `AZ ${AZ_LABELS[v.failedAz - 1]} failed` : "all AZs available";
  const routingLabel = v.localRouting ? "local-AZ routing" : "shared NAT in AZ A";
  const natDetail = v.failedAz > 0
    ? `AZ ${AZ_LABELS[v.failedAz - 1]} is unavailable. A NAT gateway has no cross-AZ failover: every subnet whose route still points at the failed NAT loses egress until the route changes.`
    : `${v.natCount} zonal NAT gateway${v.natCount === 1 ? "" : "s"}. A public NAT gateway sits in a public subnet with an Elastic IP; the private subnet route sends 0.0.0.0/0 to it.`;
  return {
    t: 0,
    nodes: [
      {
        id: "private",
        label: "private subnets",
        kind: "service",
        health: v.privateHealth,
        sublabel: `3 AZs · ${formatCount(v.demand)} conns`,
        detail: `Three private subnets share the offered connections. ${formatCount(v.failed)} fail and ${formatCount(v.success)} complete. ${
          v.localRouting ? "Each subnet uses the NAT in its own AZ when one exists." : "All three subnets route to the NAT in AZ A."
        }${v.failedAz > 0 ? ` The private subnet in AZ ${AZ_LABELS[v.failedAz - 1]} is also unavailable.` : ""}`,
        meta: { view: "flow" },
      },
      {
        id: "nat",
        label: "NAT gateways",
        kind: "external",
        health: v.natHealth,
        utilization: v.natUtilization,
        sublabel: `${v.natCount} zonal · ${failedLabel}`,
        detail: `${natDetail} The busiest healthy NAT has ${formatCount(v.connPerNat)} connections to the destination; the documented service limit is 55,000 per unique destination per IPv4 address.`,
        meta: { view: "flow", routing: routingLabel },
      },
      {
        id: "igw",
        label: "internet gateway",
        kind: "external",
        health: "ok",
        sublabel: "public subnet route",
        detail:
          "The NAT gateway's public subnet routes 0.0.0.0/0 to the internet gateway. The internet gateway is not the failing component in this scenario; the NAT path is.",
        meta: { view: "flow" },
      },
      {
        id: "destination",
        label: "S3 / internet",
        kind: "external",
        health: v.destinationHealth,
        sublabel: v.success > 0 ? "egress path" : "unreachable",
        detail:
          "An S3 gateway endpoint can carry S3 traffic without NAT. This model shows the internet path, which needs the NAT route, the NAT gateway, and the public subnet's internet route.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("private-nat", "private", "nat", v.demand > 0 ? v.successRate / 100 : 0, v.privateHealth),
      edge("nat-igw", "nat", "igw", v.demand > 0 ? v.successRate / 100 : 0, v.natHealth),
      edge("igw-destination", "igw", "destination", v.demand > 0 ? v.successRate / 100 : 0, v.destinationHealth),
    ],
    metrics: [
      metric("egress-success", "Egress success", v.successRate, "%", undefined, undefined, "percent"),
      metric("failed-connections", "Failed connections", v.failed, "", 100, 5_000, "count"),
      metric("conn-per-nat", "Connections per NAT", v.connPerNat, "", NAT_WARN, NAT_CRIT, "count"),
      metric("egress-shortfall", "Egress shortfall", v.shortfall, "%", 5, 25, "percent"),
      metric("offered-connections", "Offered connections", v.demand, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      natCount: v.natCount,
      failedAz: v.failedAz,
      localRouting: v.localRouting ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} connections; ${v.successRate.toFixed(0)}% egress success; ${v.natCount} NAT gateway${
      v.natCount === 1 ? "" : "s"
    }; ${failedLabel}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "egress-shortfall",
    metricId: "egress-shortfall",
    warn: 5,
    crit: 25,
    title: "Private-subnet egress is failing",
    cause:
      "Traffic is routed to a NAT gateway in a failed Availability Zone, or the NAT path is missing. A NAT gateway is zonal; a shared NAT concentrates every AZ on one failure domain.",
    fix:
      "Create a NAT gateway in each AZ and route each private subnet to the NAT in its own AZ. If the NAT is healthy, check the private route, the public subnet route, and the Elastic IP.",
    checkFirst: [
      "Check the private subnet route table's 0.0.0.0/0 target and the NAT gateway state in that AZ.",
      "Check the public subnet route table's 0.0.0.0/0 target and the internet gateway attachment.",
      "Compare ConnectionAttemptCount with ConnectionEstablishedCount per NAT gateway.",
    ],
  },
  {
    id: "conn-per-nat",
    metricId: "conn-per-nat",
    warn: NAT_WARN,
    crit: NAT_CRIT,
    title: "The NAT gateway is under connection pressure",
    cause:
      "The busiest NAT gateway is approaching the documented 55,000 simultaneous connections to one destination per IPv4 address. A single NAT also concentrates every AZ's traffic.",
    fix:
      "Spread clients across NAT gateways in multiple AZs, add IPv4 addresses to the NAT gateway, or close idle connections. Check ErrorPortAllocation before raising capacity.",
    checkFirst: [
      "Read ErrorPortAllocation and ActiveConnectionCount for each NAT gateway.",
      "Check whether all private subnets route to one NAT instead of their local AZ.",
      "Look for idle connections that can be closed before adding addresses.",
    ],
  },
  {
    id: "failed-connections",
    metricId: "failed-connections",
    warn: 100,
    crit: 5_000,
    title: "A large share of private connections has no egress",
    cause:
      "A zonal NAT failure, a missing route, or port exhaustion is preventing connections from completing. The NAT gateway does not fail over to another AZ by itself.",
    fix:
      "Restore the NAT gateway or route around it, then reduce the blast radius with one NAT per AZ. Confirm the public subnet can reach the internet gateway.",
    checkFirst: [
      "Check the failed AZ and the affected private subnets.",
      "Check the NAT gateway state and the public subnet route.",
      "Check port allocation and idle connection counts.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const natGatewayModel: SimModel = {
  id: "cloud-networking-nat-gateway",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const v = compute(p);
    const prevFailedAz = Number(frame.flags.failedAz ?? -1);
    const prevNatCount = Number(frame.flags.natCount ?? -1);
    const prevRouting = Number(frame.flags.localRouting ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    const noise = rng.between(-2, 2);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "failed-connections" && v.failed > 0) {
        return { ...item, value: Math.max(0, item.value + noise) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.natCount = v.natCount;
    next.flags.failedAz = v.failedAz;
    next.flags.localRouting = v.localRouting ? 1 : 0;
    if (prevFailedAz !== -1 && prevFailedAz !== next.flags.failedAz) {
      pushEvent(next, {
        id: "nat-az-change",
        at: frame.t,
        severity: v.failedAz > 0 ? "crit" : "info",
        title: v.failedAz > 0 ? `NAT gateway unavailable in AZ ${AZ_LABELS[v.failedAz - 1]}` : "NAT gateways available in all AZs",
        detail: v.failedAz > 0
          ? `Subnets whose 0.0.0.0/0 route points at the NAT in AZ ${AZ_LABELS[v.failedAz - 1]} lose egress. A NAT gateway is zonal and does not fail over to another AZ.`
          : "All NAT gateways are available again. Confirm that each private subnet still routes to the NAT in its own AZ.",
        nodeId: "nat",
        metricId: "egress-shortfall",
      });
    }
    if (prevNatCount !== -1 && prevNatCount !== next.flags.natCount) {
      pushEvent(next, {
        id: "nat-count-change",
        at: frame.t,
        severity: v.natCount > 1 ? "info" : "warn",
        title: v.natCount > 1 ? `${v.natCount} NAT gateways in the path` : "A single NAT gateway now serves all private subnets",
        detail: v.natCount > 1
          ? "Additional zonal NAT gateways reduce the blast radius, but each private subnet still has only one route target."
          : "All private subnets route to the NAT in AZ A. If AZ A fails, every subnet loses egress until the route changes.",
        nodeId: "nat",
        metricId: "egress-shortfall",
      });
    }
    if (prevRouting !== -1 && prevRouting !== next.flags.localRouting) {
      pushEvent(next, {
        id: "nat-routing-change",
        at: frame.t,
        severity: v.localRouting ? "info" : "warn",
        title: v.localRouting ? "Private subnets use their local-AZ NAT" : "Private subnets share the AZ A NAT",
        detail: v.localRouting
          ? "Each subnet's 0.0.0.0/0 route points at the NAT gateway in its own Availability Zone."
          : "Every private subnet's 0.0.0.0/0 route points at the NAT gateway in AZ A, concentrating egress and failure on one zone.",
        nodeId: "private",
        metricId: "egress-shortfall",
      });
    }
    next.summary = `${formatCount(v.demand)} connections; ${v.successRate.toFixed(0)}% egress success; ${v.natCount} NAT gateway${
      v.natCount === 1 ? "" : "s"
    }; ${v.failedAz > 0 ? `AZ ${AZ_LABELS[v.failedAz - 1]} failed` : "all AZs available"}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.failedAz > 0) {
      items.push(
        `AZ ${AZ_LABELS[v.failedAz - 1]} is unavailable. The NAT in that AZ is gone, and route tables do not re-point themselves; subnets using it lose egress.`,
      );
    } else if (v.connPerNat >= NAT_LIMIT) {
      items.push(
        `The busiest NAT has ${formatCount(v.connPerNat)} connections to one destination, above the documented 55,000 per IPv4 address. Port allocation and new connections will fail.`,
      );
    } else if (v.connPerNat >= NAT_WARN) {
      items.push(
        `The busiest NAT has ${formatCount(v.connPerNat)} connections to one destination. It is still forwarding, but the 55,000 per-IPv4 limit is close.`,
      );
    } else {
      items.push(
        `The NAT path is healthy. Each private subnet's 0.0.0.0/0 route selects a NAT, and the NAT's public subnet routes to the internet gateway.`,
      );
    }
    items.push(
      "A NAT gateway is stateful: return traffic for an allowed outbound connection is translated back without an inbound NAT rule.",
    );
    items.push(
      "S3 can work through a gateway endpoint while general internet egress fails through NAT. That combination points at the NAT path, not at the task's security group.",
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
    description: "One NAT gateway per AZ, local routing, and connections well below the per-IPv4 limit.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Three zonal NAT gateways, no failure, and connection pressure near the documented 55,000 limit.",
    tone: "warn",
    params: defaults({ connections: 150_000 }),
  },
  {
    id: "failure",
    label: "AZ failure",
    description: "AZ A fails. Each subnet routes locally, so only the AZ A private subnet loses egress.",
    tone: "crit",
    params: defaults({ failedAz: 1, connections: 90_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "AZ A is available again, all three NAT gateways are healthy, and local routing is in place.",
    tone: "ok",
    params: defaults({ connections: 30_000 }),
  },
  {
    id: "shared-nat",
    label: "Shared NAT",
    description: "One NAT in AZ A serves all private subnets. When AZ A fails, every subnet loses egress.",
    tone: "crit",
    params: defaults({ natCount: 1, failedAz: 1, localRouting: 0, connections: 90_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-shared-nat-blast-radius",
  title: "One NAT for three Availability Zones",
  simId: "nat-egress",
  question:
    "Three private subnets in AZ A, B, and C all route 0.0.0.0/0 to a single NAT gateway in AZ A. AZ A fails. What happens to egress from AZ B and C?",
  prediction: {
    options: [
      { id: "automatic-failover", label: "They fail over automatically to a NAT in another AZ." },
      { id: "all-lose", label: "They lose egress because their route still points at the failed zonal NAT." },
      { id: "only-a", label: "Only AZ A loses egress; AZ B and C keep their own NAT path." },
      { id: "igw-direct", label: "They use the internet gateway directly." },
    ],
    correctOptionId: "all-lose",
    explanation:
      "A NAT gateway exists in one Availability Zone. There is no automatic failover to another NAT, and the private subnet route tables still name the failed gateway. All three subnets lose egress until the routes or the NAT are restored.",
  },
  setup: defaults({ natCount: 1, failedAz: 1, localRouting: 0, connections: 90_000 }),
  runFor: 15,
  observe: [
    "The single NAT gateway is unavailable in AZ A.",
    "Egress shortfall is 100%: AZ B and AZ C fail too.",
    "The failed connection count is the full 90,000 connections.",
    "No route table re-points itself to another AZ.",
    "Restoring AZ A or adding per-AZ NAT gateways changes the outcome.",
  ],
  explain:
    "NAT gateways are zonal. A public NAT gateway is created in a public subnet in one AZ and uses an Elastic IP there. If that AZ fails, the NAT fails with it, and the private subnet route tables still target it. The resilient pattern is one NAT gateway per AZ and a private route table per AZ that points at the local NAT; that limits the blast radius to the failed zone.",
  fix: defaults({ natCount: 3, failedAz: 0, localRouting: 1, connections: 90_000 }),
  debrief:
    "Egress returns to 100% when each AZ has its own NAT and each private subnet routes locally. The shared-NAT design was cheaper, but it put every subnet in one failure domain. In production, check the NAT's AZ and the private route table before assuming the internet gateway or the task's security group is at fault.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A NAT gateway is a managed Network Address Translation service for outbound traffic from private subnets. A public NAT gateway sits in a public subnet, has an Elastic IP address, and sends traffic out through the VPC's internet gateway. Private instances can start connections to the internet, but the internet cannot start an unsolicited connection to them.",
  },
  {
    type: "p",
    text: "The gateway is zonal. It is created in one Availability Zone and is redundant within that zone, not across zones. If every private subnet shares one NAT and that NAT's AZ fails, resources in the other AZs lose internet access. AWS recommends a NAT gateway in each AZ and route tables that send each private subnet to the NAT in its own AZ.",
  },
  {
    type: "p",
    text: "NAT gateways are also capacity-bound. AWS documents that a NAT gateway supports 5 Gbps and automatically scales up to 100 Gbps, and that each IPv4 address supports up to 55,000 simultaneous connections to each unique destination. You can associate up to eight IPv4 addresses with a NAT gateway. A NAT gateway is stateful and has no security group of its own; security groups on the instances control what traffic reaches the NAT.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is private instance, private subnet route table, NAT gateway in a public subnet, public subnet route table, internet gateway, destination. The return path is handled by the NAT gateway's translation state. Each hop is a separate requirement; a healthy NAT with no public-subnet route to the internet gateway still cannot deliver traffic.",
  },
  {
    type: "table",
    headers: ["Hop", "Requirement", "Failure signal"],
    rows: [
      ["Private subnet route", "0.0.0.0/0 points at a NAT in the same AZ.", "No route, or a route to a failed NAT."],
      ["NAT gateway", "Available in the AZ, Elastic IP attached, ports available.", "ErrorPortAllocation, ActiveConnectionCount near 55,000 per IPv4."],
      ["Public subnet route", "0.0.0.0/0 points at the internet gateway.", "NAT cannot reach the internet gateway."],
      ["Internet gateway", "Attached to the VPC.", "No internet path at all."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Zonal NAT per AZ",
    rightTitle: "One shared NAT",
    rows: [
      { label: "Failure radius", left: "One AZ's private subnets lose egress.", right: "Every private subnet that routes to the shared NAT loses egress." },
      { label: "Cost", left: "More NAT hours and more Elastic IPs.", right: "Fewer NAT hours, one Elastic IP." },
      { label: "Capacity", left: "Traffic is spread across NAT gateways.", right: "All connections concentrate on one NAT." },
      { label: "Routing", left: "One route table per AZ pointing at the local NAT.", right: "Every private route table points at the same NAT." },
    ],
  },
  {
    type: "p",
    text: "The S3 detail is a useful diagnostic. A gateway endpoint for S3 adds a route for S3 traffic and keeps it off the NAT, so a private task can reach S3 while general internet egress fails. That combination points at the NAT path, not at the task's security group or DNS. Check the private subnet route, the NAT state, the public subnet route, and the Elastic IP in that order.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A NAT count from one to three, with a failed-AZ selector and local or shared routing.",
      "Connections per destination, compared with the documented 55,000 per IPv4 address.",
      "Egress success and a shortfall metric that separates a partial AZ loss from a full outage.",
      "Per-NAT connection pressure and failed connections, not just a generic error rate.",
      "A recovery preset that restores the AZ and the local routing pattern.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy: three NAT gateways, local routing, and low connection pressure. Apply AZ failure and watch only the local AZ lose egress. Then switch to Shared NAT and fail AZ A again; the blast radius covers every subnet. Raise connections until the per-NAT limit becomes the constraint. Run the guided experiment before revealing its explanation.",
  },
  { type: "sim", simId: "nat-egress" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With one NAT per AZ and local routing, an AZ failure removed only that zone's egress. The other two private subnets kept their local NAT paths, so the shortfall was about one third. The failed NAT did not move; route tables kept pointing at it.",
  },
  {
    type: "p",
    text: "With one shared NAT in AZ A, the same AZ failure removed every private subnet's egress. All three route tables pointed at the same zonal gateway, so the blast radius was the whole VPC's private egress, not one zone.",
  },
  {
    type: "p",
    text: "At peak connections, the NAT kept forwarding but the busiest gateway was near the documented 55,000 connections per unique destination per IPv4 address, and its node was in a warning state. That is a different failure mode: the AZ is available, but the next burst can exhaust source ports; allocation failures appear only after the limit is crossed.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "NAT state: the gateway in the failed AZ is unavailable, while the others remain available.",
      "CloudWatch per NAT: ErrorPortAllocation, ActiveConnectionCount, ConnectionAttemptCount, ConnectionEstablishedCount, PacketsDropCount, and IdleTimeoutCount.",
      "Route tables: the private subnet's 0.0.0.0/0 target still names the failed NAT; no automatic cross-AZ failover occurs.",
      "Public subnet route: the NAT's subnet must route 0.0.0.0/0 to an attached internet gateway.",
      "S3 gateway endpoint: S3 traffic can succeed while internet egress fails, which isolates the NAT path.",
      "Idle timeout: a connection idle for 350 seconds can be dropped, and reuse can return a reset. Keepalive below that value avoids stale connections.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the failed AZ and the private subnet's route target before changing security groups. Then check the NAT state, the public subnet route to the internet gateway, and the Elastic IP. If only S3 works, check whether a gateway endpoint is carrying that traffic around the NAT.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify which private subnets route to the failed NAT and which AZ the NAT is in.",
      "Restore the NAT gateway or change the private route to a healthy NAT in another AZ as an emergency measure.",
      "Confirm the NAT's public subnet routes 0.0.0.0/0 to an attached internet gateway and the NAT has its Elastic IP.",
      "For the durable fix, create one NAT gateway per AZ and one private route table per AZ pointing at the local NAT.",
      "If connections are the constraint, add IPv4 addresses to the NAT, spread clients across NATs, or close idle connections.",
      "Re-test from each AZ and confirm S3 gateway-endpoint traffic still takes the endpoint path.",
      "Add per-AZ alarms for ErrorPortAllocation and connection counts, not one VPC-wide average.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "One NAT per AZ costs more in NAT hours and Elastic IPs, but it limits an AZ failure to one zone's egress.",
      "A shared NAT is cheaper and simpler, but it concentrates capacity and failure on one zone.",
      "NAT gateways are managed and scale automatically, but they are zonal and have per-destination connection limits. NAT instances give more control but add patching and failover work.",
      "A gateway endpoint for S3 avoids NAT data processing charges for that traffic, but it does not fix general internet egress.",
      "Adding IPv4 addresses raises the per-destination connection limit, but it does not fix a failed AZ or a missing route.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "s3-works-internet-fails",
    question:
      "Private tasks can reach S3 but cannot reach the public internet. What does that pattern tell you, and what do you check?",
    difficulty: 2,
    hints: [
      "S3 may be using a gateway endpoint that bypasses NAT.",
      "The NAT path has several separate hops.",
    ],
    answer:
      "S3 can succeed through a gateway endpoint even when the NAT path is broken, because the endpoint route keeps S3 traffic off the NAT. I would check the private subnet's 0.0.0.0/0 route first, then the NAT gateway state in that AZ, then the public subnet's route to the internet gateway and the NAT's Elastic IP. I would also check security groups and network ACLs for the private instance, but the S3-only success makes a general security-group outage less likely. Finally I would compare ConnectionAttemptCount with ConnectionEstablishedCount on the NAT to separate a routing failure from a capacity or port-allocation problem.",
    followUps: [
      "Why does a gateway endpoint not need a NAT gateway?",
      "What would you check if S3 also failed?",
      "How would you prove the NAT is translating traffic?",
    ],
    redFlags: [
      "Assumes S3 and the internet use the same path.",
      "Starts by widening the task's security group.",
      "Checks only the NAT state and not the public subnet route.",
    ],
    rubric: [
      "Explains the gateway-endpoint bypass.",
      "Checks the private route, NAT state, public route, and EIP.",
      "Uses NAT connection metrics.",
      "Keeps security groups in scope without blaming them first.",
    ],
  },
  {
    id: "zonal-nat-risk",
    question:
      "Why is a single NAT gateway a zonal risk, and how would you design around it?",
    difficulty: 2,
    hints: [
      "The NAT is created in one AZ.",
      "Route tables do not fail over by themselves.",
    ],
    answer:
      "A NAT gateway is created in a specific Availability Zone and is redundant within that zone, not across zones. If private subnets in other AZs share it, an AZ failure removes their egress too, and their route tables still point at the failed gateway. I would create a NAT gateway in each AZ and a private route table per AZ that points at the local NAT. That limits the blast radius to the failed zone. I would also monitor each NAT separately, because a VPC-wide average can hide one zone's port pressure.",
    followUps: [
      "What changes in the route tables when you add a NAT per AZ?",
      "How would you migrate from a shared NAT without downtime?",
      "What does the NAT gateway do with return traffic?",
    ],
    redFlags: [
      "Says the NAT fails over automatically.",
      "Puts one NAT in a private subnet.",
      "Monitors only aggregate VPC metrics.",
    ],
    rubric: [
      "States that NAT is zonal.",
      "Explains the shared-NAT blast radius.",
      "Designs one NAT per AZ with local routes.",
      "Mentions per-NAT monitoring.",
    ],
  },
  {
    id: "nat-connection-limit",
    question:
      "Users report intermittent connection failures through NAT while the NAT gateway still shows healthy bandwidth. What could be the constraint, and which metrics do you read?",
    difficulty: 3,
    hints: [
      "Bandwidth is not the only NAT limit.",
      "Look at source-port allocation and active connections.",
    ],
    answer:
      "The NAT gateway may be hitting the documented limit of 55,000 simultaneous connections to a unique destination per IPv4 address, or it may be dropping packets for another reason. I would read ErrorPortAllocation first, then ActiveConnectionCount, ConnectionAttemptCount, ConnectionEstablishedCount, and PacketsDropCount per NAT. I would also check IdleTimeoutCount for stale connections. If port allocation is the constraint, I would spread clients across NAT gateways, add IPv4 addresses to the NAT, or close idle connections. Bandwidth being available does not mean the connection table has room.",
    followUps: [
      "Why is the limit per unique destination?",
      "How do multiple IPv4 addresses change the limit?",
      "What would you change in the client to reduce connection churn?",
    ],
    redFlags: [
      "Assumes bandwidth is the only NAT limit.",
      "Adds NAT gateways without changing routes.",
      "Ignores idle connection counts.",
    ],
    rubric: [
      "Names the per-destination connection limit.",
      "Reads ErrorPortAllocation and active connections.",
      "Chooses spreading, extra addresses, or idle cleanup.",
      "Distinguishes bandwidth from connection-table pressure.",
    ],
  },
  {
    id: "nat-idle-timeout",
    question:
      "A long-lived connection through a NAT gateway stops working after a period of inactivity. Why, and what do you change?",
    difficulty: 2,
    hints: [
      "The NAT has an idle timeout.",
      "The client may reuse a connection that the NAT already dropped.",
    ],
    answer:
      "A NAT gateway drops a connection that has been idle for 350 seconds or more. When the client tries to continue, the NAT can return a reset because the translation is gone. I would enable TCP keepalive on the client below 350 seconds, or send periodic application traffic, so the mapping stays active. I would also check IdleTimeoutCount and avoid pooling connections indefinitely without a health check. The fix is at the client or connection-pool layer, not in the NAT route table.",
    followUps: [
      "Why is a reset more likely than a clean close?",
      "How would you detect stale pooled connections?",
      "Does the timeout apply to UDP?",
    ],
    redFlags: [
      "Blames the security group.",
      "Raises the NAT bandwidth.",
      "Ignores connection reuse.",
    ],
    rubric: [
      "Names the 350-second idle timeout.",
      "Explains the stale translation and reset.",
      "Uses keepalive or application traffic.",
      "Points to client or pool configuration.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each private subnet has a documented egress path and a NAT gateway in the same AZ.",
      "NAT gateways have an owner, an Elastic IP inventory, and per-AZ alarms.",
      "Alarms cover ErrorPortAllocation, ActiveConnectionCount, and failed connection attempts.",
      "S3 and DynamoDB gateway endpoints are documented separately from NAT egress.",
      "The runbook includes the public subnet route and internet gateway check.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the private subnet, its AZ, and the NAT gateway its route targets.",
      "Check the NAT state, the public subnet route, and the Elastic IP.",
      "Compare connection attempts with established connections per NAT.",
      "Check whether S3 still works through a gateway endpoint.",
      "Record the route change before applying an emergency cross-AZ target.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore the intended per-AZ routing and remove emergency cross-AZ paths.",
      "Re-test egress from every AZ, not just the recovered one.",
      "Add or tune per-NAT connection and port-allocation alarms.",
      "Record whether the failure was zonal, routing, or port exhaustion.",
    ],
  },
];

const references = [
  {
    title: "NAT gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Public and private NAT gateways, Elastic IP requirement, and outbound-only behavior.",
  },
  {
    title: "NAT gateway basics",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-basics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Zonal design, 5 Gbps to 100 Gbps scaling, 55,000 connections per destination per IPv4, and the no-security-group rule.",
  },
  {
    title: "Monitor NAT gateways with Amazon CloudWatch",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway-cloudwatch.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "NAT metrics including ErrorPortAllocation, ActiveConnectionCount, and PacketsDropCount.",
  },
  {
    title: "Troubleshoot NAT gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/nat-gateway-troubleshooting.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Route checks, the 350-second idle timeout, and simultaneous-connection failures.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "nat-egress": {
      model: natGatewayModel,
      presets,
      instructions:
        "Start healthy, fail one AZ with local routing, then switch to a shared NAT and fail the same AZ. Compare the blast radius and then raise connection pressure.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Connection counts and thresholds are teaching values; the 55,000 per-destination limit is documented by AWS.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-subnets",
    "cloud-networking-igw",
    "cloud-networking-vpc-endpoints",
    "cloud-networking-nat-scaling",
    "cloud-networking-route-tables",
  ],
};
