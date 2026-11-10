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

const GATEWAY_ID = "igw-0a1b2c3d4e5f67890";
const VPC_CIDR = "10.0.0.0/16";

const params = [
  {
    id: "gatewayPath",
    label: "Gateway path",
    min: 0,
    max: 2,
    step: 1,
    value: 2,
    unit: "",
    group: "Gateway",
    help: "0 means no internet gateway is attached; the 0.0.0.0/0 entry remains but is blackhole. 1 means the gateway is attached but the route is missing. 2 means both are present and usable.",
    format: "count" as const,
  },
  {
    id: "publicIp",
    label: "Public IPv4 address",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Address",
    help: "0 removes the public IPv4 address. The internet gateway performs one-to-one NAT for IPv4, so an instance without a public address has no internet-routable source.",
    format: "count" as const,
  },
  {
    id: "sgAllows",
    label: "Security group allows traffic",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Filter",
    help: "0 removes the allow rule. Security groups are stateful allow lists; return traffic for an allowed connection is permitted automatically.",
    format: "count" as const,
  },
  {
    id: "requestRate",
    label: "Outbound requests",
    min: 100,
    max: 1_200,
    step: 100,
    value: 300,
    unit: " /s",
    group: "Traffic",
    help: "Illustrative requests per second from the public-subnet instance to an internet host. The internet gateway is horizontally scaled and does not add a bandwidth constraint.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  gatewayPath: number;
  igwAttached: boolean;
  routeEntry: boolean;
  routeUsable: boolean;
  publicIp: boolean;
  sgAllows: boolean;
  reachable: boolean;
  demand: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
  blockedGates: number;
  instanceHealth: Health;
  addressHealth: Health;
  sgHealth: Health;
  routeHealth: Health;
  igwHealth: Health;
  destinationHealth: Health;
}

function compute(p: Params): Computed {
  const gatewayPath = Math.max(0, Math.min(2, Math.round(num(p, "gatewayPath", 2))));
  const igwAttached = gatewayPath >= 1;
  const routeEntry = gatewayPath !== 1;
  const routeUsable = gatewayPath === 2;
  const publicIp = num(p, "publicIp", 1) >= 0.5;
  const sgAllows = num(p, "sgAllows", 1) >= 0.5;
  const demand = Math.max(1, num(p, "requestRate", 300));
  const reachable = igwAttached && routeUsable && publicIp && sgAllows;
  const delivered = reachable ? demand : 0;
  const failed = demand - delivered;
  const blockedGates =
    (igwAttached ? 0 : 1) +
    (routeUsable ? 0 : 1) +
    (publicIp ? 0 : 1) +
    (sgAllows ? 0 : 1);
  return {
    gatewayPath,
    igwAttached,
    routeEntry,
    routeUsable,
    publicIp,
    sgAllows,
    reachable,
    demand,
    delivered,
    failed,
    deliveryRate: reachable ? 100 : 0,
    blockedGates,
    instanceHealth: reachable ? "ok" : "warn",
    addressHealth: publicIp ? "ok" : "crit",
    sgHealth: sgAllows ? "ok" : "crit",
    routeHealth: routeUsable ? "ok" : "crit",
    igwHealth: igwAttached ? "ok" : "down",
    destinationHealth: reachable ? "ok" : "crit",
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
  const gatewayDetail =
    v.gatewayPath === 0
      ? "No internet gateway is attached to the VPC. The route table still has 0.0.0.0/0 pointed at the gateway ID, so the route state is blackhole."
      : v.gatewayPath === 1
        ? "The internet gateway is attached, but the subnet route table has no 0.0.0.0/0 route to it. Attachment alone is not a path."
        : "The internet gateway is attached and 0.0.0.0/0 points at it. The address and the security group still have to allow the flow.";
  const routeDetail =
    v.routeUsable
      ? `The subnet route table sends 0.0.0.0/0 to ${GATEWAY_ID}. A more specific route can still shadow this default.`
      : v.routeEntry
        ? `The subnet route table still lists 0.0.0.0/0 to ${GATEWAY_ID}, but the gateway is not attached, so the route state is blackhole.`
        : "The subnet route table has no 0.0.0.0/0 route to the internet gateway. The local route covers only the VPC CIDR.";
  return {
    t: 0,
    nodes: [
      {
        id: "instance",
        label: "web-1",
        kind: "service",
        health: v.instanceHealth,
        sublabel: `${VPC_CIDR} · ${formatCount(v.demand)} /s`,
        detail:
          "Instance in the public subnet. It is trying to reach an internet host. The instance only knows its private address; the internet gateway translates the public address on its behalf.",
        meta: { view: "flow" },
      },
      {
        id: "address",
        label: "public IPv4",
        kind: "mesh",
        health: v.addressHealth,
        sublabel: v.publicIp ? "assigned" : "none",
        detail: v.publicIp
          ? "A public IPv4 address is associated with the instance. Without a route to an attached internet gateway, the address still cannot carry traffic."
          : "The instance has no public IPv4 address. The internet gateway has no public address to translate for this instance, so outbound IPv4 fails.",
        meta: { view: "flow" },
      },
      {
        id: "security-group",
        label: "security group",
        kind: "mesh",
        health: v.sgHealth,
        sublabel: v.sgAllows ? "outbound allowed" : "blocked",
        detail: v.sgAllows
          ? "The security group allows the outbound flow. It is stateful, so the response is allowed back without a separate inbound rule."
          : "The security group has no rule that allows this flow. The packet is dropped at the network interface before it reaches the route table.",
        meta: { view: "flow" },
      },
      {
        id: "route-table",
        label: "rtb-public",
        kind: "mesh",
        health: v.routeHealth,
        sublabel: v.routeUsable
          ? `0.0.0.0/0 → ${GATEWAY_ID}`
          : v.routeEntry
            ? `0.0.0.0/0 → ${GATEWAY_ID} (blackhole)`
            : "no default route",
        detail: routeDetail,
        meta: { view: "flow" },
      },
      {
        id: "igw",
        label: GATEWAY_ID,
        kind: "external",
        health: v.igwHealth,
        sublabel: v.igwAttached ? "attached to VPC" : "not attached",
        detail: gatewayDetail,
        meta: { view: "flow" },
      },
      {
        id: "internet",
        label: "internet host",
        kind: "external",
        health: v.destinationHealth,
        sublabel: v.reachable ? "reachable" : "unreachable",
        detail: v.reachable
          ? "The request leaves through the internet gateway with the instance's public address as the source. The response is translated back to the private address."
          : "The internet host is healthy, but no complete path reaches it from this instance.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("instance-address", "instance", "address", v.publicIp ? 1 : 0, v.reachable ? "ok" : "crit"),
      edge("address-sg", "address", "security-group", v.publicIp && v.sgAllows ? 1 : 0, v.reachable ? "ok" : "crit"),
      edge(
        "sg-route",
        "security-group",
        "route-table",
        v.publicIp && v.sgAllows && v.routeUsable ? 1 : 0,
        v.reachable ? "ok" : "crit",
      ),
      edge(
        "route-igw",
        "route-table",
        "igw",
        v.publicIp && v.sgAllows && v.routeUsable && v.igwAttached ? 1 : 0,
        v.reachable ? "ok" : "crit",
      ),
      edge("igw-internet", "igw", "internet", v.reachable ? 1 : 0, v.reachable ? "ok" : "crit"),
    ],
    metrics: [
      metric("delivery-rate", "Internet delivery", v.deliveryRate, "%", undefined, undefined, "percent"),
      metric("failed-connections", "Failed requests", v.failed, " /s", 1, 50, "rps"),
      metric("blocked-gates", "Blocked path gates", v.blockedGates, "", 1, 2, "count"),
      metric("offered-requests", "Offered requests", v.demand, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      gatewayPath: v.gatewayPath,
      publicIp: v.publicIp ? 1 : 0,
      sgAllows: v.sgAllows ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} requests/s; ${v.deliveryRate.toFixed(0)}% delivered; gateway ${
      v.igwAttached ? "attached" : "missing"
    }; route ${v.routeUsable ? "active" : v.routeEntry ? "blackhole" : "missing"}; public IP ${v.publicIp ? "present" : "missing"}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failed-connections",
    metricId: "failed-connections",
    warn: 1,
    crit: 50,
    title: "Traffic that should use the internet gateway is failing",
    cause:
      "At least one gate in the public path is closed: the gateway is not attached, the default route is missing, the instance has no public address, or the security group blocks the flow.",
    fix:
      "Walk the path in order: public address, security group, route, gateway attachment. Fix the first gate that is closed, then test a real request and its response.",
    checkFirst: [
      "Check whether the instance has a public IPv4 address or an Elastic IP.",
      "Read the subnet route table for a 0.0.0.0/0 route to an attached internet gateway.",
      "Check the security group and network ACL in the outbound direction.",
    ],
  },
  {
    id: "blocked-gates",
    metricId: "blocked-gates",
    warn: 1,
    crit: 2,
    title: "More than one public-path requirement is missing",
    cause:
      "The public path is a chain. A missing gateway attachment and a missing route are separate gates, and a missing public address or a blocked rule adds more. One missing gate is enough to stop the flow.",
    fix:
      "Do not stop after attaching the gateway. Confirm the route, the public address, and the allow rule as separate checks, then verify the response path.",
    checkFirst: [
      "List each gate and mark it present or missing.",
      "Fix the upstream gate first so later checks are meaningful.",
      "Use flow logs or a packet test to confirm where the packet stops.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const igwModel: SimModel = {
  id: "cloud-networking-igw",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const v = compute(p);
    const prevPath = Number(frame.flags.gatewayPath ?? -1);
    const prevPublic = Number(frame.flags.publicIp ?? -1);
    const prevSg = Number(frame.flags.sgAllows ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    const noise = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "failed-connections" && v.failed > 0
        ? { ...item, value: Math.max(0, item.value + noise) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.gatewayPath = v.gatewayPath;
    next.flags.publicIp = v.publicIp ? 1 : 0;
    next.flags.sgAllows = v.sgAllows ? 1 : 0;
    if (prevPath !== -1 && prevPath !== next.flags.gatewayPath) {
      pushEvent(next, {
        id: "gateway-path-change",
        at: frame.t,
        severity: v.gatewayPath === 2 ? "info" : v.gatewayPath === 1 ? "warn" : "crit",
        title:
          v.gatewayPath === 2
            ? "Internet gateway attached and default route present"
            : v.gatewayPath === 1
              ? "Internet gateway attached without a default route"
              : "No internet gateway attached to the VPC",
        detail: gatewayDetailFor(v),
        nodeId: "igw",
        metricId: "failed-connections",
      });
    }
    if (prevPublic !== -1 && prevPublic !== next.flags.publicIp) {
      pushEvent(next, {
        id: "public-ip-change",
        at: frame.t,
        severity: v.publicIp ? "info" : "warn",
        title: v.publicIp ? "Public IPv4 address assigned" : "Public IPv4 address removed",
        detail: v.publicIp
          ? "The instance now has a public IPv4 address. The route and gateway attachment still have to exist."
          : "Without a public IPv4 address, the internet gateway has no public source to translate for this instance.",
        nodeId: "address",
        metricId: "blocked-gates",
      });
    }
    if (prevSg !== -1 && prevSg !== next.flags.sgAllows) {
      pushEvent(next, {
        id: "sg-change",
        at: frame.t,
        severity: v.sgAllows ? "info" : "warn",
        title: v.sgAllows ? "Security group allows the flow" : "Security group blocks the flow",
        detail: v.sgAllows
          ? "The allow rule is present. Return traffic for an allowed connection is permitted by the stateful rule."
          : "The packet is dropped at the network interface. A route change cannot bypass a security group that has no allow rule.",
        nodeId: "security-group",
        metricId: "failed-connections",
      });
    }
    next.summary = `${formatCount(v.demand)} requests/s; ${v.deliveryRate.toFixed(0)}% delivered; gateway ${
      v.igwAttached ? "attached" : "missing"
    }; route ${v.routeUsable ? "active" : v.routeEntry ? "blackhole" : "missing"}; public IP ${v.publicIp ? "present" : "missing"}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (!v.igwAttached) {
      items.push(
        "The internet gateway is not attached to the VPC. The route table may still contain a default route, but the target cannot forward without an attachment.",
      );
    } else if (!v.routeUsable) {
      items.push(
        "The gateway is attached, but the subnet route table has no 0.0.0.0/0 route to it. Attachment is not routing.",
      );
    } else if (!v.publicIp) {
      items.push(
        "The route and gateway are in place, but the instance has no public IPv4 address. The internet gateway performs one-to-one NAT for IPv4, so there is no public source address.",
      );
    } else if (!v.sgAllows) {
      items.push(
        "The address, route, and gateway are in place, but the security group does not allow the flow. The packet is dropped at the network interface.",
      );
    } else {
      items.push(
        "The public path is complete: the instance has a public address, the security group allows the flow, the route points at the gateway, and the gateway is attached.",
      );
    }
    items.push(
      "A public subnet is defined by a route to an internet gateway, not by its name or its auto-assign public IPv4 setting.",
    );
    items.push(
      "The internet gateway is horizontally scaled and redundant; it does not add a bandwidth constraint. A failure here is usually configuration, not gateway capacity.",
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

function gatewayDetailFor(v: Computed): string {
  if (v.gatewayPath === 0) {
    return "No internet gateway is attached to the VPC. The default route still points at the gateway ID, so its state is blackhole; the route entry cannot forward without the attachment.";
  }
  if (v.gatewayPath === 1) {
    return "The internet gateway is attached, but 0.0.0.0/0 is missing from the subnet route table. The packet has no target for the internet host.";
  }
  return "The internet gateway is attached and the default route points at it. The public address and security group are separate gates.";
}

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Gateway attached, default route present, public IPv4 assigned, and the security group allows the flow.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The same complete public path at the top of the illustrative request range.",
    tone: "ok",
    params: defaults({ requestRate: 1_200 }),
  },
  {
    id: "failure",
    label: "No gateway attached",
    description: "The VPC has no internet gateway attached, while the instance still has a public IPv4 address.",
    tone: "crit",
    params: defaults({ gatewayPath: 0, requestRate: 600 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The gateway is attached, the default route is restored, and the address and allow rule remain in place.",
    tone: "ok",
    params: defaults({ requestRate: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-missing-gateway",
  title: "The route points at a gateway that is not attached",
  simId: "public-path",
  question:
    "The subnet route table has 0.0.0.0/0 to an internet gateway ID, and the instance has a public IPv4 address. The VPC has no internet gateway attached. Does the instance reach the internet?",
  prediction: {
    options: [
      { id: "route-wins", label: "Yes, because the default route selects the gateway." },
      { id: "no-attachment", label: "No, because the route target is not attached to the VPC." },
      { id: "nat-fallback", label: "Yes, the traffic falls back to a NAT gateway." },
      { id: "public-ip-wins", label: "Yes, because the instance has a public IPv4 address." },
    ],
    correctOptionId: "no-attachment",
    explanation:
      "A route selects a target; it does not attach the target. The internet gateway must be attached to the VPC, and the route must point at the attached gateway. A public address alone is not a path, and there is no implicit NAT fallback.",
  },
  setup: defaults({ gatewayPath: 0, publicIp: 1, sgAllows: 1, requestRate: 600 }),
  runFor: 15,
  observe: [
    "The internet gateway node is unavailable and the route node is failing.",
    "The public IPv4 address is still assigned to the instance.",
    "The security group still allows the flow; the drop happens later in the path.",
    "Delivery is 0% and failed requests equal the offered load.",
    "Attaching the gateway and restoring the route returns delivery to 100%.",
  ],
  explain:
    "The public path has four separate gates: a public address, an allow rule, a route, and an attached internet gateway. The route pointed at a gateway ID that was not attached to the VPC, so the target could not forward. The public address and security group were necessary but not sufficient.",
  fix: defaults({ gatewayPath: 2, publicIp: 1, sgAllows: 1, requestRate: 600 }),
  debrief:
    "Delivery returns to 100% only when the gateway is attached and the route points at it. The address and allow rule were already correct. In production, check the attachment state and the route table before assigning another address or widening a security group.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An internet gateway is a horizontally scaled, redundant, and highly available VPC component that connects a VPC to the internet. It supports IPv4 and IPv6, and AWS states that it does not cause availability risks or bandwidth constraints. There is no charge for the gateway itself, although data transfer charges apply.",
  },
  {
    type: "p",
    text: "For IPv4, the internet gateway performs one-to-one network address translation. The instance knows only its private address; the gateway translates the source to the instance's public IPv4 address or Elastic IP and translates the reply back. For IPv6, addresses are globally unique and public by default, so the gateway does not perform NAT. An egress-only internet gateway is the outbound-only option for IPv6.",
  },
  {
    type: "p",
    text: "The gateway must be attached to the VPC, and the subnet's route table must have a route to it, usually 0.0.0.0/0 for IPv4 or ::/0 for IPv6. The resource must have a public address, and security groups and network ACLs must allow the flow. A public subnet is defined by the route to an internet gateway, not by its name or by an auto-assign public IPv4 setting. A VPC can have instances with public addresses and no internet gateway; those addresses are not reachable. AWS also blocks detaching an internet gateway while the VPC has resources with associated public addresses, so removing one is not a safe live workaround.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is instance, public address, security group, subnet route table, internet gateway, internet host. The return path is handled by the gateway's translation and the security group's stateful tracking. Each gate is separate; a correct route cannot bypass a missing address, and an attached gateway cannot bypass a missing route.",
  },
  {
    type: "table",
    headers: ["Gate", "Required state", "If it is missing"],
    rows: [
      ["Public IPv4 address", "Assigned to the instance or an Elastic IP.", "The gateway has no public source to translate; outbound IPv4 fails."],
      ["Security group and network ACL", "Allow the outbound flow and the response.", "The packet is dropped at the ENI or subnet before routing."],
      ["Subnet route table", "0.0.0.0/0 points at the internet gateway.", "No target is selected for the internet host."],
      ["Internet gateway", "Attached to the VPC.", "The route has no working target, even if the entry exists."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Internet gateway",
    rightTitle: "NAT gateway",
    rows: [
      { label: "Direction", left: "Inbound and outbound internet traffic.", right: "Outbound-only for private subnets." },
      { label: "Placement", left: "Attached to the VPC.", right: "Created in a public subnet in one AZ." },
      { label: "Address", left: "The instance needs a public IPv4 or IPv6 address.", right: "The NAT gateway has an Elastic IP." },
      { label: "Scope", left: "VPC-wide and highly available.", right: "Zonal and capacity-bound." },
      { label: "Cost", left: "No gateway charge; data transfer charges apply.", right: "Hourly charge plus data processing charges." },
    ],
  },
  {
    type: "p",
    text: "The most common public-access failure is not the gateway's availability. It is an incomplete chain: a route to a gateway that is not attached, an attached gateway with no route, a public address that was never assigned, or a security group that does not allow the port. The demo separates those gates so the first missing one is visible.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A gateway-path control: not attached, attached without a route, or attached with the default route.",
      "A public-address toggle and a security-group allow toggle, so the address and the filter are separate from routing.",
      "Delivery, failed requests, and a count of blocked gates.",
      "A topology that shows where the path stops: address, security group, route, or gateway.",
      "A request-rate control that shows the gateway is not the bandwidth bottleneck.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read the path from the instance outward. Detach the gateway and watch the route entry stay visible while delivery fails. Then restore the gateway and remove the route, the public address, and the allow rule one at a time. Compare which node fails and which metric moves. Run the guided experiment before revealing its explanation.",
  },
  { type: "sim", simId: "public-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The instance had a public IPv4 address and the security group allowed the flow, but the VPC had no internet gateway attached. The default route still named a gateway ID, so the route looked present, yet the target could not forward. Delivery fell to zero at the first missing gate after the address and allow rule.",
  },
  {
    type: "p",
    text: "Attaching the gateway without restoring the route produced a different failure: the gateway was healthy, but the subnet had no 0.0.0.0/0 entry. The packet never selected the gateway. Removing the public address produced a third failure: the route and gateway were fine, but there was no public source for the gateway to translate.",
  },
  {
    type: "p",
    text: "At peak request rate the delivery stayed at 100% when the path was complete. The internet gateway is horizontally scaled and redundant; the model does not impose a bandwidth limit on it. The failure modes here are configuration, not gateway saturation.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route table: the 0.0.0.0/0 entry is present or missing, and its target is the internet gateway ID.",
      "Gateway attachment: describe-internet-gateways shows the gateway attached to the expected VPC.",
      "Address: the instance has a public IPv4 address or an Elastic IP. A private-only instance cannot use the internet gateway for IPv4.",
      "Security group and network ACL: the outbound flow and the response are allowed. Security groups are stateful; network ACLs are stateless.",
      "VPC Flow Logs: accepted and rejected flows at the ENI. A missing record is evidence about the log point, not proof of the drop location.",
      "Reachability Analyzer: static configuration analysis that returns the blocking component; it does not prove live forwarding.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the instance's public address and the subnet's route table first, then confirm the internet gateway is attached to the same VPC. After that, check the security group and network ACL. A route to an unattached gateway is not a path, and a public address without a route is not a path either.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the instance has a public IPv4 address or an Elastic IP, and that it is in the subnet you expect.",
      "Read the subnet's route table and find the 0.0.0.0/0 entry. Confirm its target is the internet gateway.",
      "Check the internet gateway attachment in the VPC. Attach it if the VPC has none, or if it is attached to the wrong VPC.",
      "Check the security group and network ACL for the outbound flow and the response.",
      "Look for a more specific route that shadows the default, such as a /24 to an appliance.",
      "Test a real request and its response. Use Reachability Analyzer to narrow configuration blockers, not as proof of forwarding.",
      "Add a check that covers the whole chain, not just gateway attachment or route presence.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A public subnet with an internet gateway is simple for inbound services, but every public address is exposed to the internet and must be filtered carefully.",
      "A private subnet with a NAT gateway avoids unsolicited inbound traffic, but adds zonal capacity, cost, and another route to maintain.",
      "An Elastic IP is stable across instance replacement, but it is a scarce resource and adds an inventory item. An auto-assigned public address changes when the instance is replaced.",
      "IPv6 avoids NAT and gives globally unique addresses, but it also means the address is public by default. An egress-only internet gateway is the outbound-only choice.",
      "Reachability Analyzer is safe and fast, but it evaluates configuration rather than live traffic. Pair it with a packet test.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "public-path-chain",
    question:
      "A public subnet has a 0.0.0.0/0 route to an internet gateway, but the instance cannot reach the internet. What do you check, in order?",
    difficulty: 1,
    hints: [
      "The route is only one gate.",
      "Check the address and the allow rule too.",
    ],
    answer:
      "I would check the instance's address first: it needs a public IPv4 address or an Elastic IP for the internet gateway to translate. Then I would check the security group and network ACL for the outbound flow and the response. Next I would confirm the internet gateway is attached to the same VPC, not just that the route names it. Finally I would look for a more specific route that shadows 0.0.0.0/0. A route entry is necessary but not sufficient; the target must be attached, the address must exist, and the filters must allow the packet.",
    followUps: [
      "What makes a subnet public?",
      "Why does the security group not need an inbound rule for the response?",
      "What would a more specific route do to the default?",
    ],
    redFlags: [
      "Checks only the route table.",
      "Assigns another public IP without checking the gateway attachment.",
      "Opens the security group to 0.0.0.0/0 before checking routing.",
    ],
    rubric: [
      "Checks the public address.",
      "Checks the security group and ACL.",
      "Confirms the gateway is attached.",
      "Considers route specificity.",
    ],
  },
  {
    id: "public-ip-private-subnet",
    question:
      "A private subnet has a route table with no route to an internet gateway, but an instance in it has a public IPv4 address. Can it reach the internet?",
    difficulty: 2,
    hints: [
      "A public address is not a route.",
      "The subnet's route table decides.",
    ],
    answer:
      "No. The public IPv4 address does not create a route, and the subnet's route table has no target for internet-bound traffic. AWS documents that an instance in a private subnet cannot communicate with the internet even if it has a public IPv4 address, because there is no route to the internet gateway. The fix is to associate the subnet with a route table that has 0.0.0.0/0 to an attached internet gateway, or to use a NAT gateway for outbound-only access. The address alone is not the path.",
    followUps: [
      "What happens if you attach an internet gateway but do not add the route?",
      "When would a NAT gateway be the better choice?",
      "Why does the internet gateway need a public address at all?",
    ],
    redFlags: [
      "Says the public IP is enough.",
      "Adds a route to a gateway that is not attached.",
      "Confuses a public subnet with a public address.",
    ],
    rubric: [
      "States that the route table decides.",
      "Explains the public address is not a path.",
      "Offers the correct route or NAT alternative.",
      "Distinguishes public subnet from public address.",
    ],
  },
  {
    id: "igw-vs-nat",
    question:
      "When do you use an internet gateway instead of a NAT gateway, and when do you use both?",
    difficulty: 2,
    hints: [
      "One supports inbound and outbound; the other is outbound-only for private subnets.",
      "A NAT gateway itself sits in a public subnet.",
    ],
    answer:
      "An internet gateway connects the VPC to the internet for resources that have public addresses and need inbound or outbound access. A NAT gateway gives private subnets outbound-only access; it sits in a public subnet and uses an Elastic IP. A common design uses both: the public subnet routes 0.0.0.0/0 to the internet gateway, and the private subnet routes 0.0.0.0/0 to the NAT gateway in the same AZ. The NAT gateway's public subnet also needs a route to the internet gateway. Neither device replaces the other; they serve different subnets and directions.",
    followUps: [
      "Why does the NAT gateway's subnet need an internet gateway route?",
      "What is the IPv6 equivalent of outbound-only access?",
      "Which device performs NAT for an instance with a public IPv4 address?",
    ],
    redFlags: [
      "Says a NAT gateway accepts inbound connections.",
      "Puts the NAT gateway in a private subnet.",
      "Uses one device for both public and private subnets without explaining the routes.",
    ],
    rubric: [
      "Separates inbound/outbound from outbound-only.",
      "Places the NAT gateway in a public subnet.",
      "Explains the two route tables.",
      "Mentions IPv6 egress-only.",
    ],
  },
  {
    id: "igw-no-metrics",
    question:
      "The internet gateway has no CloudWatch metrics for errors. How do you prove whether traffic reached it?",
    difficulty: 3,
    hints: [
      "Use flow logs and configuration state.",
      "The gateway is not the only place to observe the path.",
    ],
    answer:
      "I would use VPC Flow Logs at the instance ENI and at the relevant subnet or VPC scope to see whether packets left the instance and whether responses returned. I would also check the route table, the gateway attachment, the public address, and the security group and ACL configuration. Reachability Analyzer can identify a blocking component in the configuration. For a live test, I would send a request from the instance and capture on the instance or use an external target I control. The gateway itself does not expose per-gateway error metrics, so the proof comes from the surrounding path.",
    followUps: [
      "What does an ACCEPT record prove?",
      "What does a missing flow log record prove?",
      "How would you distinguish a security group drop from a missing route?",
    ],
    redFlags: [
      "Waits for an internet gateway error metric.",
      "Treats a missing flow log record as proof the packet never left.",
      "Changes routes without checking the attachment.",
    ],
    rubric: [
      "Uses flow logs at the right scope.",
      "Checks attachment and route configuration.",
      "Uses Reachability Analyzer appropriately.",
      "Distinguishes observation points from proof.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Public subnets have a documented route to an attached internet gateway.",
      "Public addresses and Elastic IPs are inventoried with the resources that use them.",
      "Security groups allow only the intended ports, not the whole range.",
      "Critical public paths have a saved Reachability Analyzer configuration.",
      "Route changes include a rollback and a post-change request test.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the instance's public address before changing routes.",
      "Confirm the internet gateway is attached to the correct VPC.",
      "Read the subnet route table for 0.0.0.0/0 and any more specific route.",
      "Check the security group and network ACL in both directions.",
      "Use flow logs or a packet test to localize the drop.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore the intended route and remove temporary wide-open rules.",
      "Re-test the public path at peak load.",
      "Add a check for gateway attachment and route presence.",
      "Record whether the failure was address, filter, route, or attachment.",
    ],
  },
];

const references = [
  {
    title: "Enable internet access for a VPC using an internet gateway",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Internet_Gateway.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Attachment, routing, public addresses, IPv4 NAT, and the definition of a public subnet.",
  },
  {
    title: "Subnets for your VPC",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Public and private subnet definitions and the route-table association.",
  },
  {
    title: "How route priority works",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/route-tables-priority.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Longest prefix match and the rules that decide which route wins.",
  },
  {
    title: "NAT gateways",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The outbound-only alternative for private subnets and its public-subnet placement.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "public-path": {
      model: igwModel,
      presets,
      instructions:
        "Start healthy, set the gateway path to no attachment, then restore it and remove the route, the public address, and the allow rule one at a time. Watch where the path stops.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Request rates are teaching values; no internet gateway bandwidth limit is modeled.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-vpc",
    "cloud-networking-subnets",
    "cloud-networking-nat-gateway",
    "cloud-networking-security-groups",
    "cloud-networking-route-tables",
  ],
};
