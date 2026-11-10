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

const LOCAL_CIDR = "10.0.0.0/16";
const PEER_CIDR = "10.20.0.0/16";
const PEERING_ID = "pcx-0a1b2c3d4e5f67890";

const params = [
  {
    id: "peering",
    label: "VPC peering connection",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Boundary",
    help: "0 deletes the peering connection; 1 keeps it active. A deleted connection leaves any routes that point at it in the blackhole state.",
    format: "count" as const,
  },
  {
    id: "routes",
    label: "Peer routes in both tables",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 adds a route for the peer CIDR to the subnet route table in each VPC. Private traffic needs a route in both directions.",
    format: "count" as const,
  },
  {
    id: "requestRate",
    label: "Connection attempts",
    min: 100,
    max: 1_200,
    step: 100,
    value: 300,
    unit: " /s",
    group: "Traffic",
    help: "Illustrative attempts per second from app-a to svc-b over the private address. Public IPs are present on both instances but are not used for this path.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  peering: boolean;
  routes: boolean;
  reachable: boolean;
  demand: number;
  delivered: number;
  failed: number;
  deliveryRate: number;
  blackholed: number;
  routeState: "active" | "blackhole" | "missing";
  appHealth: Health;
  routeHealth: Health;
  peeringHealth: Health;
  peerHealth: Health;
}

function compute(p: Params): Computed {
  const peering = num(p, "peering", 1) >= 0.5;
  const routes = num(p, "routes", 1) >= 0.5;
  const demand = Math.max(1, num(p, "requestRate", 300));
  const reachable = peering && routes;
  const delivered = reachable ? demand : 0;
  const failed = demand - delivered;
  const deliveryRate = reachable ? 100 : 0;
  const blackholed = peering ? 0 : routes ? 2 : 0;
  const routeState = !routes ? "missing" : peering ? "active" : "blackhole";
  return {
    peering,
    routes,
    reachable,
    demand,
    delivered,
    failed,
    deliveryRate,
    blackholed,
    routeState,
    appHealth: reachable ? "ok" : "warn",
    routeHealth: reachable ? "ok" : "crit",
    peeringHealth: peering ? "ok" : "down",
    peerHealth: reachable ? "ok" : "crit",
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
  return {
    t: 0,
    nodes: [
      {
        id: "app",
        label: "app-a",
        kind: "service",
        health: v.appHealth,
        sublabel: `10.0.1.10 · public IPv4`,
        detail:
          "Source instance in VPC A. It has a public IPv4 address, but this request uses svc-b's private address 10.20.4.10. The public address does not create a route between the VPCs.",
        meta: { view: "flow" },
      },
      {
        id: "route-a",
        label: "rtb-private-a",
        kind: "mesh",
        health: v.routeHealth,
        sublabel:
          v.routeState === "missing"
            ? "no peer route"
            : `${PEER_CIDR} → ${PEERING_ID}${v.routeState === "blackhole" ? " (blackhole)" : ""}`,
        detail:
          v.routeState === "missing"
            ? "The subnet route table has no route for 10.20.0.0/16. The packet is dropped at the source lookup; no less specific route is defined for this path."
            : v.routeState === "blackhole"
              ? "The route is still present, but its target is unavailable, so its state is blackhole. The route matches and the packet is dropped."
              : "The route is active. The peer route table must also have a route back to 10.0.0.0/16.",
        meta: { view: "flow", routeState: v.routeState },
      },
      {
        id: "peering",
        label: PEERING_ID,
        kind: "external",
        health: v.peeringHealth,
        sublabel: v.peering ? "peering active" : "peering deleted",
        detail: v.peering
          ? "The peering attachment is active. rtb-private-b must still have a route for 10.0.0.0/16 back to this connection."
          : "The attachment is gone. Routes in both VPCs that point at this ID remain in the tables with state blackhole; the VPC boundary is closed.",
        meta: { view: "flow" },
      },
      {
        id: "peer",
        label: "svc-b",
        kind: "service",
        health: v.peerHealth,
        sublabel: `10.20.4.10 · public IPv4`,
        detail: v.reachable
          ? "The peer has a return route for 10.0.0.0/16. Request and response complete over the private path."
          : "The peer's public address does not help the private request. Without an active peering path and routes both ways, the response has no return path.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("app-route", "app", "route-a", 1, v.appHealth),
      edge(
        "route-peering",
        "route-a",
        "peering",
        v.routes ? (v.peering ? 1 : 0) : 0,
        v.routes ? (v.peering ? "ok" : "down") : "crit",
      ),
      edge("peering-peer", "peering", "peer", v.reachable ? 1 : 0, v.reachable ? "ok" : "crit"),
    ],
    metrics: [
      metric("delivery-rate", "End-to-end delivery", v.deliveryRate, "%", undefined, undefined, "percent"),
      metric("failed-connections", "Failed connections", v.failed, " /s", 1, 50, "rps"),
      metric("blackholed-routes", "Blackholed peer routes", v.blackholed, "", 1, 2, "count"),
      metric("offered-connections", "Offered connections", v.demand, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      peering: v.peering ? 1 : 0,
      routes: v.routes ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} attempts/s; ${v.deliveryRate.toFixed(0)}% delivered; peering ${
      v.peering ? "active" : "deleted"
    }; routes ${v.routes ? "present" : "missing"}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failed-connections",
    metricId: "failed-connections",
    warn: 1,
    crit: 50,
    title: "Private traffic is failing across the VPC boundary",
    cause:
      "The source and destination are in different VPCs. A public IP on either instance does not create a private path; the peering attachment and a route in each direction are separate requirements.",
    fix:
      "Restore or accept the peering connection first, then confirm a route for the peer CIDR in both subnet route tables. A route that points at a deleted attachment is a blackhole.",
    checkFirst: [
      "Confirm both resources are in the VPCs and subnets you expect.",
      "Read the peering connection state and the matching route state in each VPC.",
      "Check the return route on the peer side before changing security groups.",
    ],
  },
  {
    id: "blackholed-routes",
    metricId: "blackholed-routes",
    warn: 1,
    crit: 2,
    title: "A peer route is present but its target is unavailable",
    cause:
      "The peering connection was deleted while the route entries remained. AWS keeps the routes and marks them blackhole, so route presence is not proof of forwarding.",
    fix:
      "Recreate or accept the peering connection, or remove the stale routes and choose a supported path. Verify both route tables after the change.",
    checkFirst: [
      "Open each route table and read the route state, not only the destination.",
      "Check the peering connection status in both accounts.",
      "Confirm the peer route table still has a route back to the source CIDR.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const vpcModel: SimModel = {
  id: "cloud-networking-vpc",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const v = compute(p);
    const prevPeering = Number(frame.flags.peering ?? -1);
    const prevRoutes = Number(frame.flags.routes ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    const noise = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "failed-connections" && v.failed > 0) {
        return { ...item, value: Math.max(0, item.value + noise) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.peering = v.peering ? 1 : 0;
    next.flags.routes = v.routes ? 1 : 0;
    if (prevPeering !== -1 && prevPeering !== next.flags.peering) {
      pushEvent(next, {
        id: "peering-change",
        at: frame.t,
        severity: v.peering ? "info" : "crit",
        title: v.peering ? "VPC peering is active again" : "VPC peering deleted",
        detail: v.peering
          ? "The attachment is active. Both subnet route tables still need a route for the peer CIDR."
          : "Both route tables still point at the deleted attachment. Their peer routes are blackhole and packets matching them are dropped.",
        nodeId: "peering",
        metricId: "blackholed-routes",
      });
    }
    if (prevRoutes !== -1 && prevRoutes !== next.flags.routes) {
      pushEvent(next, {
        id: "peer-routes-change",
        at: frame.t,
        severity: v.routes ? "info" : "warn",
        title: v.routes ? "Peer routes added to both tables" : "Peer routes removed",
        detail: v.routes
          ? "Both route tables now point the peer CIDR at the peering connection. Check that the attachment is active."
          : "The source route lookup has no match for the peer CIDR. The public IPs on the instances do not provide a route.",
        nodeId: "route-a",
        metricId: "failed-connections",
      });
    }
    next.summary = `${formatCount(v.demand)} attempts/s; ${v.deliveryRate.toFixed(0)}% delivered; peering ${
      v.peering ? "active" : "deleted"
    }; routes ${v.routes ? "present" : "missing"}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (!v.peering && v.routes) {
      items.push(
        `${PEER_CIDR} still matches ${PEERING_ID} in both tables, but the attachment is deleted. The route state is blackhole, so the packet is dropped after the lookup.`,
      );
    } else if (!v.routes) {
      items.push(
        `The peering connection is ${v.peering ? "active" : "deleted"}, but the peer CIDR has no route in the subnet table. The packet is dropped at the source lookup.`,
      );
    } else {
      items.push(
        `The private path is complete: the peering connection is active and both route tables have the peer CIDR. The public IPv4 addresses are not used for this request.`,
      );
    }
    items.push(
      `The VPC local route covers ${LOCAL_CIDR}; the peer CIDR is a separate decision. A VPC is an isolation boundary, not a route.`,
    );
    items.push(
      `A public IP is an address, not a path. Internet reachability would also need an internet gateway, a route, and an allow rule, which is a different path from this private request.`,
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
    description: "Peering active, routes in both tables, and steady private traffic.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The same complete private path at the top of the illustrative traffic range.",
    tone: "ok",
    params: defaults({ requestRate: 1_200 }),
  },
  {
    id: "failure",
    label: "Peering deleted",
    description: "The attachment is gone, but both route tables still point at it. The routes are blackhole.",
    tone: "crit",
    params: defaults({ peering: 0, requestRate: 600 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The peering connection is restored and both route tables have the peer CIDR.",
    tone: "ok",
    params: defaults({ requestRate: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-public-ip-path",
  title: "Public IPs do not create a private path",
  simId: "vpc-path",
  question:
    "Both instances have public IPv4 addresses. The peering connection is deleted, but both route tables still list 10.20.0.0/16. What happens to a request to svc-b's private address?",
  prediction: {
    options: [
      { id: "fallback-internet", label: "It falls through to the internet gateway and uses the public addresses." },
      { id: "blackhole-drop", label: "It matches the route, finds a blackhole target, and is dropped." },
      { id: "local-route", label: "It uses the VPC local route and reaches the peer." },
      { id: "queue", label: "It is queued until the peering connection returns." },
    ],
    correctOptionId: "blackhole-drop",
    explanation:
      "The route still matches the destination. Its target is the deleted peering connection, so the route state is blackhole and the packet is dropped. There is no fallback to a less specific route, and the public addresses belong to a different path.",
  },
  setup: defaults({ peering: 0, routes: 1, requestRate: 600 }),
  runFor: 15,
  observe: [
    "The peering node is unavailable while both route tables still list the peer CIDR.",
    "The blackholed peer route count is 2: one route in each VPC.",
    "End-to-end delivery is 0%, and failed connections equal the offered load.",
    "The instance public IPv4 addresses remain assigned and do not change the result.",
    "Restoring the peering attachment alone is not enough unless both route tables still have the peer route.",
  ],
  explain:
    "A route is a match plus a target. The match succeeded; the target did not forward. A peering connection is not a gateway that automatically carries traffic: both VPCs need an active attachment and a route in the direction of the request. A public IP only matters on an internet path that has its own gateway, route, and allow rules.",
  fix: defaults({ peering: 1, routes: 1, requestRate: 600 }),
  debrief:
    "Delivery returns to 100% when the peering connection is active and both route tables have the peer CIDR. The public IPs were never the problem. In production, read the route state and the attachment state before adding routes; a new route to another unavailable target only widens the outage.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Amazon Virtual Private Cloud (VPC) is a logically isolated virtual network in one AWS Region. You define an IPv4 CIDR block, from /16 to /28, and optionally IPv6. The VPC owns an address space, route tables, security groups, network ACLs, and gateways. Subnets carve that address space into ranges that each sit in one Availability Zone; the VPC itself spans Availability Zones in the Region.",
  },
  {
    type: "p",
    text: "Isolation is the first boundary. Two resources can both have public IPv4 addresses and still have no private path between them. A public address is an address; reachability is a route plus a target plus an allow rule. Private traffic between VPCs needs a peering connection or a transit gateway, and the route tables on both sides must point at that attachment.",
  },
  {
    type: "p",
    text: "A VPC peering connection is pairwise and non-transitive. If VPC A peers with B and B peers with C, A does not automatically reach C. Peering also requires non-overlapping CIDR blocks; overlapping address space makes the same prefix mean two different networks and prevents a clean route.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The private path is source instance, source subnet route table, peering attachment, peer subnet route table, destination instance. The lookup happens in each direction. A route in one direction is not a path; the peer needs a route back to the source CIDR.",
  },
  {
    type: "diagram",
    id: "vpc-peering",
    caption:
      "A peering attachment is only the middle of the path. Both route tables need a route, and the attachment must be active.",
  },
  {
    type: "table",
    headers: ["Boundary", "What it decides", "What it does not decide"],
    rows: [
      ["VPC CIDR", "The private address space and which addresses are local.", "Whether another VPC can reach them."],
      ["Subnet route table", "The next hop for a destination by longest prefix match.", "Whether the target is available or will return traffic."],
      ["Peering attachment", "Whether a private path exists between two VPCs.", "Whether either side has a route, or whether security groups allow the flow."],
      ["Security group and network ACL", "Which flows are allowed at the ENI or subnet.", "Routes, public addresses, or gateway attachment state."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Public IP",
    rightTitle: "Private route",
    rows: [
      { label: "What it is", left: "An address that can be translated by an internet gateway.", right: "A destination-to-target entry in a route table." },
      { label: "What it enables", left: "Internet reachability when the gateway, route, and allow rules exist.", right: "Private reachability when the target attachment and return route exist." },
      { label: "What it does not do", left: "Create a path between two VPCs.", right: "Assign a public address or bypass a security group." },
      { label: "Typical failure", left: "A public address with no internet gateway or no route.", right: "A missing route or a route with a blackhole target." },
    ],
  },
  {
    type: "p",
    text: "The table is deliberately separate from the address. A route can match and still fail: if the target is a deleted peering connection, the route state is blackhole. A route can also be absent, in which case nothing matches. Those are different failures with different fixes, and neither is repaired by assigning another public address.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Two VPCs, each with a subnet, an instance, and a public IPv4 address on that instance.",
      "A peering toggle: active or deleted. Deleting it does not remove the route entries.",
      "A route toggle for both subnet tables. Private traffic needs a route in each direction.",
      "Delivery, failed connections, and the count of blackholed peer routes.",
      "A request-rate control so you can see that reachability is binary, not a capacity curve.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read the route table before touching a slider. Then delete the peering connection and watch the route state change to blackhole while the destination and target remain visible. Restore peering, remove the peer routes instead, and compare the two failures. Run the guided experiment before revealing its explanation.",
  },
  { type: "sim", simId: "vpc-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Deleting the peering connection did not delete the routes. Both route tables still matched 10.20.0.0/16 against the peering ID, but the target was unavailable, so the routes became blackhole and every matching packet was dropped. Delivery fell to zero while the route table looked populated.",
  },
  {
    type: "p",
    text: "Removing the routes produced a different signal: no blackhole routes were counted, because no route matched. The packet stopped at the source lookup instead of reaching an unavailable target. The public IPv4 addresses on both instances stayed assigned through both cases.",
  },
  {
    type: "p",
    text: "Raising the request rate changed the number of failed connections but not the delivery percentage. Reachability is a property of the path, not of the load. Capacity would matter only after the path exists.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route tables: the peer CIDR still present, with state blackhole after a peering deletion, or absent when the route was never added.",
      "Peering status: pending-acceptance, rejected, deleted, or active. A route to a pending-acceptance connection is blackhole until the accepter approves it.",
      "Both directions: the peer subnet route table needs a route back to the source CIDR. Check both accounts and both Regions.",
      "VPC Flow Logs: accepted and rejected flows at the ENI. A missing record is evidence about the log point, not proof that the packet never left the instance.",
      "Reachability Analyzer: a static configuration analysis that returns the blocking component. It does not prove live forwarding.",
      "Host evidence: socket state, retransmits, and application timeouts. A silent drop looks like a timeout, not a connection refusal.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the VPC boundary and the route state before changing security groups. Confirm both resources are in the VPCs you think, then read the peering status and the matching route in both tables. A public IP cannot repair a missing private route.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the two VPCs and the exact source and destination addresses. Confirm whether the request uses a private or public address.",
      "Read the source subnet's route table and find the longest prefix that matches the destination. Record the target and the route state.",
      "Check the peering connection state in both accounts. Accept a pending request, recreate a deleted connection, or choose another supported path.",
      "Add or restore a route for the peer CIDR in both subnet route tables. A one-way route will fail on the response.",
      "Check security groups and network ACLs in both directions, especially if the path crosses an appliance or a non-symmetric route.",
      "Use Reachability Analyzer to narrow the configuration blocker, then send a real request and confirm a response.",
      "Remove stale blackhole routes and update the infrastructure code so the next deployment cannot recreate them.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "VPC peering is simple and has no transit hop, but it is pairwise and non-transitive. A transit gateway scales connectivity but adds attachments, route tables, and cost.",
      "A public path can be quick to set up, but it exposes the service to the internet and has different allow rules. A private path is narrower but needs peering or a transit gateway.",
      "Restoring the old peering connection is usually the fastest fix, but it may bring back a path that was being retired. Replacing it is cleaner but needs changes on both sides.",
      "A more specific route can steer around a failure, but longest prefix match means it also shadows the intended route. Review the whole table, not just the new entry.",
      "Reachability Analyzer is safe and fast, but it evaluates configuration rather than live traffic. Pair it with a packet test.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "public-ip-not-path",
    question:
      "Two instances are in different VPCs and both have public IPv4 addresses. They cannot reach each other's private addresses. What is the first boundary you check?",
    difficulty: 2,
    hints: [
      "The request is using a private address, not the public one.",
      "A public address is not a route.",
    ],
    answer:
      "I would first confirm the VPC and subnet of each instance, then check whether a private path exists between those VPCs. A public IPv4 address only helps on an internet path that has an internet gateway, a route, and an allow rule; it does not create a route between VPCs. I would check for an active peering connection or transit gateway attachment, then read both subnet route tables for the peer CIDR. If the route exists but the target is unavailable, its state is blackhole. I would also check security groups and network ACLs in both directions, but only after the path exists.",
    followUps: [
      "What would you check if the instances are in the same VPC?",
      "Why does a route to a pending-acceptance peering connection not work?",
      "When would you choose a transit gateway instead of peering?",
    ],
    redFlags: [
      "Starts by assigning another public IP.",
      "Assumes a public IP creates a private route.",
      "Changes security groups before checking the peering or routes.",
    ],
    rubric: [
      "Names the VPC boundary first.",
      "Separates address assignment from routing.",
      "Checks both route tables and the attachment state.",
      "Mentions the return path and allow rules.",
    ],
  },
  {
    id: "blackhole-vs-missing",
    question:
      "What is the difference between a missing route and a blackhole route, and why does the distinction change your fix?",
    difficulty: 2,
    hints: [
      "One has no match; the other has a match with an unavailable target.",
      "Check the route state column.",
    ],
    answer:
      "A missing route means no entry matches the destination, so the packet is dropped at the lookup or follows a less specific route if one exists. A blackhole route still matches, but its target is unavailable, so the packet is dropped after the lookup and does not fall through to a less specific route. The fix differs: for a missing route I add the correct route to an active target; for a blackhole I restore or replace the target, or remove the stale route. In both cases I verify the return path, because a working forward route alone does not complete the request.",
    followUps: [
      "Which AWS API field tells you the route state?",
      "Why does a blackhole route not fall through to 0.0.0.0/0?",
      "How would you detect stale blackhole routes before an incident?",
    ],
    redFlags: [
      "Treats every route-table entry as forwarding.",
      "Adds a default route to fix a blackhole.",
      "Only checks one direction.",
    ],
    rubric: [
      "Distinguishes no match from an unavailable target.",
      "Explains longest prefix match.",
      "Chooses a fix that matches the failure.",
      "Checks the return path.",
    ],
  },
  {
    id: "peering-nontransitive",
    question:
      "VPC A is peered with B, and B is peered with C. A cannot reach C. Why, and what would you change?",
    difficulty: 2,
    hints: [
      "Peering is pairwise.",
      "A transit gateway is a hub, not a peering shortcut.",
    ],
    answer:
      "VPC peering is non-transitive. A has a path to B and B has a path to C, but A has no attachment or route to C, and B does not forward traffic between its peering connections by default. I would either create a direct peering connection between A and C, if the address spaces do not overlap, or attach all three VPCs to a transit gateway and configure its route tables. I would then check the route tables on each side and the security groups, because a transit gateway adds another routing layer.",
    followUps: [
      "What CIDR constraint applies to a direct peering connection?",
      "Which route tables does a transit gateway evaluate?",
      "How would you avoid a asymmetric return path in the hub?",
    ],
    redFlags: [
      "Assumes B routes between its peers.",
      "Ignores overlapping CIDRs.",
      "Adds a route without an attachment.",
    ],
    rubric: [
      "States that peering is non-transitive.",
      "Offers direct peering or a transit gateway.",
      "Checks CIDR overlap.",
      "Considers route symmetry and security groups.",
    ],
  },
  {
    id: "igw-or-nat",
    question:
      "When would you use an internet gateway, and when would you use a NAT gateway for a subnet?",
    difficulty: 1,
    hints: [
      "One supports inbound and outbound; the other is outbound-only for private subnets.",
      "A public IP is required for the internet gateway path.",
    ],
    answer:
      "An internet gateway connects a VPC to the internet and supports inbound and outbound traffic. A resource uses it when the subnet route table has a route to the gateway and the resource has a public IPv4 or IPv6 address, with security groups and ACLs allowing the flow. A NAT gateway is for private subnets that need outbound internet access without unsolicited inbound connections. The private subnet routes 0.0.0.0/0 to the NAT gateway, which sits in a public subnet with an Elastic IP and routes out through the internet gateway. A NAT gateway is not a substitute for an internet gateway, and it does not make a private resource directly reachable from the internet.",
    followUps: [
      "Why does a private subnet with a public IP still need a route to an internet gateway?",
      "What does the internet gateway do to the source address for IPv4?",
      "When would you use an egress-only internet gateway instead of NAT?",
    ],
    redFlags: [
      "Says a NAT gateway accepts inbound connections.",
      "Confuses a public IP with a route.",
      "Uses an internet gateway for a private subnet without a public address.",
    ],
    rubric: [
      "Separates inbound and outbound use cases.",
      "Names the route and address requirements.",
      "Places the NAT gateway in a public subnet.",
      "Mentions IPv6 egress-only as a different tool.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The VPC and subnet inventory maps every service to its address space and route tables.",
      "Peering and transit gateway attachments have an owner and a documented route on both sides.",
      "Alerts cover route state and attachment state, not only route count.",
      "Reachability Analyzer paths are saved for critical source and destination pairs.",
      "CIDR changes are reviewed against every peered or shared network for overlap.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the failing request uses a private or public address.",
      "Find the winning route in the source table and read its state.",
      "Check the peering or transit gateway attachment in both accounts.",
      "Check the return route on the peer side before changing security groups.",
      "Use flow logs or captures on both ends to localize the drop.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove stale blackhole routes and update the infrastructure code.",
      "Re-test both directions at peak load.",
      "Add a check for route state and attachment state.",
      "Record whether the failure was missing route, blackhole, or return path.",
    ],
  },
];

const references = [
  {
    title: "What is Amazon VPC?",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/what-is-amazon-vpc.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines a VPC as a logically isolated virtual network and lists subnets, routing, and gateways.",
  },
  {
    title: "VPC CIDR blocks",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/vpc-cidr-blocks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Allowed IPv4 block sizes and the local route behavior for VPC address space.",
  },
  {
    title: "Update your route tables for a VPC peering connection",
    url: "https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-routing.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Both VPCs need a route to the peer CIDR, and a pending-acceptance route is blackhole.",
  },
  {
    title: "How route priority works",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/route-tables-priority.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Longest prefix match and the priority rules for static and propagated routes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "vpc-path": {
      model: vpcModel,
      presets,
      instructions:
        "Start healthy, then delete the peering connection and remove the peer routes separately. Watch route state and end-to-end delivery together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. The connection counts and thresholds are teaching values, not AWS quotas or performance guarantees.",
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
    "cloud-networking-nat-gateway",
    "cloud-networking-route-tables",
    "cloud-networking-security-groups",
  ],
};
