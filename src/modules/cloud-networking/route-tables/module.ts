import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const ROUTE_DESTINATION = "10.20.0.0/16";
const ROUTE_TARGET = "pcx-0a1b2c3d4e5f67890";
const TARGET_CAPACITY = 5_000;

const params = [
  {
    id: "blackhole",
    label: "Blackhole route",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Route",
    help: "0 keeps the peering route active; 1 marks the target unavailable. The route stays in the table with state blackhole.",
    format: "count" as const,
  },
  {
    id: "returnRoute",
    label: "Return route present",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 means the peer VPC has a route back to the source CIDR; 0 drops every response while requests still arrive.",
    format: "count" as const,
  },
  {
    id: "packetRate",
    label: "Offered packets",
    min: 100,
    max: 10_000,
    step: 100,
    value: 800,
    unit: " pps",
    group: "Traffic",
    help: "Requests per second arriving at the subnet route table. Each request expects one response.",
    format: "rps" as const,
  },
  {
    id: "targetCapacity",
    label: "Target capacity",
    min: 500,
    max: 20_000,
    step: 500,
    value: TARGET_CAPACITY,
    unit: " pps",
    group: "Target",
    help: "Illustrative forwarding capacity of the route target. This is a teaching value, not a published VPC peering limit.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  blackhole: boolean;
  returnRoute: boolean;
  demand: number;
  capacity: number;
  forwarded: number;
  dropped: number;
  delivered: number;
  successRate: number;
  targetUtil: number;
  routeHealth: Health;
  targetHealth: Health;
  peerHealth: Health;
}

function compute(p: Params): Computed {
  const blackhole = num(p, "blackhole", 0) >= 0.5;
  const returnRoute = num(p, "returnRoute", 1) >= 0.5;
  const demand = Math.max(1, num(p, "packetRate", 800));
  const capacity = Math.max(1, num(p, "targetCapacity", TARGET_CAPACITY));
  const forwarded = blackhole ? 0 : Math.min(demand, capacity);
  const forwardDrops = demand - forwarded;
  const responseDrops = returnRoute ? 0 : forwarded;
  const dropped = forwardDrops + responseDrops;
  const delivered = returnRoute ? forwarded : 0;
  const successRate = clamp((delivered / demand) * 100, 0, 100);
  const targetUtil = blackhole ? 0 : clamp((forwarded / capacity) * 100, 0, 100);
  const targetHealth: Health = blackhole
    ? "down"
    : targetUtil >= 95
      ? "crit"
      : targetUtil >= 80
        ? "warn"
        : "ok";
  return {
    blackhole,
    returnRoute,
    demand,
    capacity,
    forwarded,
    dropped,
    delivered,
    successRate,
    targetUtil,
    routeHealth: blackhole ? "crit" : "ok",
    targetHealth,
    peerHealth: returnRoute ? "ok" : "crit",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function formatPps(value: number): string {
  return `${formatCount(value)} pps`;
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 20;
  const jitter = (offset: number) => 0.97 + 0.06 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["delivery-rate", values.successRate, 0],
    ["failure-rate", 100 - values.successRate, 0],
    ["dropped-pps", values.dropped, 1.4],
    ["target-utilization", values.targetUtil, 1.2],
    ["forwarded-pps", values.forwarded, 8],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "delivery-rate" || id === "failure-rate"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  const routeState = values.blackhole ? "blackhole" : "active";
  return {
    t: 0,
    nodes: [
      {
        id: "source",
        label: "app-1",
        kind: "service",
        health: values.successRate >= 99.9 ? "ok" : "warn",
        sublabel: `10.0.1.10 · ${formatPps(values.demand)}`,
        detail: `Source instance in private subnet 10.0.1.0/24. The route lookup for ${ROUTE_DESTINATION} selects ${ROUTE_TARGET}.`,
        meta: { view: "flow" },
      },
      {
        id: "route",
        label: "rtb-private-a",
        kind: "mesh",
        health: values.routeHealth,
        sublabel: `${ROUTE_DESTINATION} → ${ROUTE_TARGET}`,
        detail: values.blackhole
          ? "The route is still present with state blackhole. Matching packets are dropped; there is no fallback to the less specific 0.0.0.0/0 route."
          : "The route is active. The target must still forward the packet, and the peer must have a return route.",
        meta: { view: "flow", routeState },
      },
      {
        id: "target",
        label: ROUTE_TARGET,
        kind: "external",
        health: values.targetHealth,
        utilization: values.targetUtil / 100,
        sublabel: `state: ${routeState}`,
        detail: values.blackhole
          ? "The route target is unavailable. The route entry was not deleted; its target state is blackhole."
          : `Illustrative target capacity ${formatPps(values.capacity)}; ${Math.round(values.targetUtil)}% utilized.`,
        meta: { view: "flow", forwarded: values.forwarded, capacity: values.capacity },
      },
      {
        id: "peer",
        label: "svc-b",
        kind: "service",
        health: values.peerHealth,
        sublabel: `10.20.4.10 · return route ${values.returnRoute ? "present" : "missing"}`,
        detail: values.returnRoute
          ? "The peer VPC has a route back to 10.0.0.0/16."
          : "The peer VPC has no route back to 10.0.0.0/16. Requests arrive, but every response is dropped.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("source-route", "source", "route", 1, "ok"),
      edge(
        "route-target",
        "route",
        "target",
        values.demand > 0 ? values.forwarded / values.demand : 0,
        values.blackhole ? "down" : values.targetHealth,
      ),
      edge(
        "target-peer",
        "target",
        "peer",
        values.demand > 0 ? values.forwarded / values.demand : 0,
        values.blackhole ? "down" : "ok",
      ),
    ],
    metrics: [
      metric("delivery-rate", "End-to-end delivery", values.successRate, "%", undefined, undefined, "percent"),
      metric("failure-rate", "End-to-end failures", 100 - values.successRate, "%", 0.1, 5, "percent"),
      metric("dropped-pps", "Dropped packets", values.dropped, " pps", 10, 100, "rps"),
      metric("target-utilization", "Target utilization", values.targetUtil, "%", 80, 95, "percent"),
      metric("forwarded-pps", "Forwarded packets", values.forwarded, " pps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatPps(values.demand)} offered; ${formatPercent(values.successRate)}% delivered; ${
      values.blackhole ? "target blackhole" : values.returnRoute ? "forwarding" : "return path missing"
    }.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failure-rate",
    metricId: "failure-rate",
    warn: 0.1,
    crit: 5,
    title: "End-to-end delivery failed although a route matched",
    cause:
      "The route table selected a target, but the request and response did not complete. The target may be blackholed, saturated, or the peer may not have a return route.",
    fix:
      "Check the matched route's state and target first. Then verify the return path. Adding another route does not repair an unavailable target.",
    checkFirst: [
      "Find the route that wins the longest-prefix match and read its state.",
      "Check the target attachment or gateway state.",
      "Check the peer subnet's route back to the source CIDR.",
    ],
  },
  {
    id: "dropped-pps",
    metricId: "dropped-pps",
    warn: 10,
    crit: 100,
    title: "Packets are being dropped after the route lookup",
    cause:
      "A blackhole route or a saturated target discards packets. The route entry can still look present, so route count is not evidence of forwarding.",
    fix:
      "Restore the target attachment or correct the route target. Add capacity only when the route is active and the target is the bottleneck.",
    checkFirst: [
      "Read the route state, not just the destination and target.",
      "Compare forwarded packets with target capacity.",
      "Use flow logs or captures on both ends to see where packets stop.",
    ],
  },
  {
    id: "target-utilization",
    metricId: "target-utilization",
    warn: 80,
    crit: 95,
    title: "The route target is at its forwarding limit",
    cause:
      "The selected target has finite capacity. Once it is saturated, excess packets are dropped even though the route remains active and matches the destination.",
    fix:
      "Scale the target, spread traffic across targets, or reduce load. A route entry selects a target; it does not add forwarding capacity.",
    checkFirst: [
      "Confirm the target is active before treating this as a capacity problem.",
      "Check whether one target carries traffic that should be spread.",
      "Check for a blackhole route that would make utilization fall to zero.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const routeTableModel: SimModel = {
  id: "cloud-networking-route-tables",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const defaultsValue = defaults();
    const frame = buildFrame(defaultsValue, seed);
    seedSeries(frame, compute(defaultsValue), seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const values = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    const jitter = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) => {
      if (item.id === "dropped-pps" && values.dropped > 0) {
        return { ...item, value: Math.max(0, item.value + jitter) };
      }
      if (item.id === "target-utilization" && values.targetUtil > 0) {
        return { ...item, value: clamp(item.value + jitter, 0, 100) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.events = [];
    if (values.blackhole && frame.flags.blackholeLogged !== 1) {
      pushEvent(next, {
        id: "route-blackhole",
        severity: "crit",
        title: "Route target is blackhole",
        detail: `${ROUTE_DESTINATION} still points to ${ROUTE_TARGET}, but the target is unavailable. The route keeps matching and matching packets are dropped.`,
        nodeId: "route",
        metricId: "failure-rate",
      });
    }
    next.flags.blackholeLogged = values.blackhole ? 1 : 0;
    if (!values.returnRoute && frame.flags.returnLogged !== 1) {
      pushEvent(next, {
        id: "return-route-missing",
        severity: "crit",
        title: "Return route missing",
        detail:
          "Requests reach svc-b, but the peer VPC has no route back to 10.0.0.0/16. End-to-end delivery fails while the forward path remains active.",
        nodeId: "peer",
        metricId: "failure-rate",
      });
    }
    next.flags.returnLogged = values.returnRoute ? 0 : 1;
    next.flags = { ...frame.flags, ...next.flags };
    next.summary = `${formatPps(values.demand)} offered; ${formatPercent(values.successRate)}% delivered; ${
      values.blackhole ? "target blackhole" : values.returnRoute ? "forwarding" : "return path missing"
    }.`;
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    if (values.blackhole) {
      items.push(
        `${ROUTE_DESTINATION} still matches ${ROUTE_TARGET}, but the route state is blackhole. The packet is dropped after the lookup; it does not fall through to 0.0.0.0/0.`,
      );
    } else if (!values.returnRoute) {
      items.push(
        `${formatPps(values.forwarded)} is forwarded to svc-b, but the peer has no route back to 10.0.0.0/16. Every response is dropped, so end-to-end delivery is zero.`,
      );
    } else if (values.targetUtil >= 80) {
      items.push(
        `The route is active and the return path exists. The target is at ${Math.round(values.targetUtil)}% of its illustrative capacity, so only the excess above capacity is dropped.`,
      );
    } else {
      items.push(
        `The route is active and the return path exists. All ${formatPps(values.demand)} complete; the route table selected a usable target.`,
      );
    }
    items.push(
      `Dropped packets are counted after route lookup: ${formatPps(values.dropped)} in this state. Route presence is a match result, not a forwarding guarantee.`,
    );
    items.push(
      `The /16 route is more specific than 0.0.0.0/0, so adding or keeping a default route does not bypass a blackholed target.`,
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
    description: "Active peering route, return path present, target well below capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Traffic reaches 90% of the target's illustrative capacity; delivery still completes.",
    tone: "warn",
    params: defaults({ packetRate: 4_500 }),
  },
  {
    id: "failure",
    label: "Blackhole route",
    description: "The peering target is unavailable. The route remains in the table with state blackhole.",
    tone: "crit",
    params: defaults({ blackhole: 1, packetRate: 5_000 }),
  },
  {
    id: "return-path",
    label: "Missing return route",
    description: "Requests reach the peer, but the peer VPC has no route back to the source subnet.",
    tone: "crit",
    params: defaults({ returnRoute: 0, packetRate: 2_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The target is restored and the return path exists. Delivery completes again.",
    tone: "ok",
    params: defaults({ packetRate: 1_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-route-blackhole",
  title: "Predict where the packets stop",
  simId: "route-path",
  question:
    "The route table still lists 10.20.0.0/16 to pcx-0a1b2c3d4e5f67890, but the peering connection was deleted. What happens to a packet that matches the route?",
  prediction: {
    options: [
      { id: "route-removed", label: "The route is removed and the packet falls through to 0.0.0.0/0." },
      { id: "blackhole-drop", label: "The route stays with state blackhole and the packet is dropped." },
      { id: "forwarded-response", label: "The packet is forwarded, but only the response is dropped." },
      { id: "queued", label: "The packet is queued until the peering connection returns." },
    ],
    correctOptionId: "blackhole-drop",
    explanation:
      "AWS keeps the route entry and marks its state blackhole when the target is unavailable. The route still matches, so there is no fallback to a less specific route. The packet is dropped.",
  },
  setup: defaults({ blackhole: 1, returnRoute: 1, packetRate: 5_000, targetCapacity: 5_000 }),
  runFor: 15,
  observe: [
    "The route table still lists 10.20.0.0/16 to pcx-0a1b2c3d4e5f67890, with state blackhole.",
    "Forwarded packets are zero; dropped packets equal the offered load.",
    "End-to-end delivery is 0% while the route table looks populated.",
    "The target node is unavailable while the route table node is failing.",
    "There is no fallback to 0.0.0.0/0 because the /16 route still matches.",
  ],
  explain:
    "A route is a match rule plus a target. The match succeeded; the target did not forward. A route entry can be present and still be a blackhole. The fix is to restore the target, accept or recreate the peering connection, or replace the route target, then verify both directions.",
  fix: defaults({ blackhole: 0, returnRoute: 1, packetRate: 5_000, targetCapacity: 10_000 }),
  debrief:
    "Delivery returns to 100% only when the target is active. The route entry was never missing. In production, check route state and attachment state before adding routes; a new route to another dead target only widens the outage.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A route table is a set of rules. Each rule pairs a destination Classless Inter-Domain Routing (CIDR) block with a target: an internet gateway, network address translation (NAT) gateway, virtual private cloud (VPC) peering connection, transit gateway, virtual private network (VPN) gateway, network interface, or VPC endpoint. AWS chooses the most specific route that matches the packet's destination. The local route covers the VPC CIDR.",
  },
  {
    type: "p",
    text: "A route can exist and still not forward. Each route has a state. The state is active when the target is usable, and blackhole when the target is not available, for example because a gateway is detached or a NAT instance is terminated. A blackhole route remains in the table and still matches; the packet is not forwarded, and a less specific route is not used.",
  },
  {
    type: "p",
    text: "That distinction is the lesson. The route table answers which target should handle a destination. It does not answer whether that target will deliver the packet. The target's attachment state, its capacity, and the return path decide the rest.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is source instance, subnet route table, target, destination. The lookup is per packet and stateless. The return path is a separate lookup in the destination's route table. A one-way route is not a path.",
  },
  {
    type: "diagram",
    id: "vpc-peering",
    caption:
      "A route in one direction is not a path. The target attachment and the reverse route both have to exist.",
  },
  {
    type: "table",
    headers: ["Destination", "Target", "State", "Result"],
    rows: [
      ["10.0.0.0/16", "local", "active", "Stays inside VPC A."],
      ["10.20.0.0/16", "pcx-0a1b2c3d4e5f67890", "blackhole", "Matches, but the target is unavailable, so packets are dropped."],
      ["0.0.0.0/0", "nat-0a1b2c3d4e5f67890", "active", "Internet traffic leaves through the NAT gateway."],
    ],
  },
  {
    type: "p",
    text: "In this table, the blackhole route is still present. That is the trap. A dashboard that counts routes or checks that a destination has an entry reports success while every packet to 10.20.4.10 disappears. The /16 also wins over the default route, so traffic does not fall back to the NAT gateway.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Route state and target attachment: active or blackhole, plus the target's health.",
      "End-to-end delivery: request and response pairs that complete.",
      "Forwarded and dropped packets: the difference between reaching the target and returning a response.",
      "Target utilization: saturation at the target, which drops packets even when the route is active.",
      "A return-path toggle: requests can arrive while every response is dropped.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy. Apply Blackhole route and read the route table before changing a slider: the route is still there, but its target is unavailable. Then toggle the blackhole off, remove the return route, and raise the packet rate above target capacity. Compare which metric moves first in each case. Run the guided experiment before revealing its explanation.",
  },
  {
    type: "p",
    text: "This model uses an illustrative target capacity of 5,000 packets per second. It is a teaching value, not a published VPC peering limit. The packet counts and thresholds are also illustrative; the route-state semantics are the part to carry into production.",
  },
  { type: "sim", simId: "route-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The route table still matched 10.20.0.0/16. The route was not removed and did not fall through to 0.0.0.0/0. Its target was a blackhole, so packets were dropped after the lookup. Delivery went to zero while the route table looked populated.",
  },
  {
    type: "p",
    text: "The return-path variant produced a different signal. Forwarded packets stayed high and the target looked busy, but end-to-end delivery was zero because the peer VPC had no route back to 10.0.0.0/16. The request path was healthy; the response path was not.",
  },
  {
    type: "p",
    text: "Raising the packet rate above the target's capacity produced a third signal: the route stayed active, target utilization crossed the warning line, and only the excess was dropped. A blackhole drops everything; saturation drops the overflow.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route tables: the matching route's state is blackhole and the target ID is still present. A peering connection in pending-acceptance produces a blackhole route until the accepter approves it.",
      "Target state: the peering connection is active, the transit gateway attachment is available, the NAT gateway is available, or the network interface still exists.",
      "Both directions: the peer VPC's route table needs a route back to the source CIDR. Check the transit gateway route table too when a gateway sits in the path.",
      "VPC Flow Logs: use them to see where traffic was observed. A missing record is evidence about the log point, not proof that the packet never left the instance.",
      "Reachability Analyzer: a static configuration analysis that returns hop-by-hop details or the blocking component. It does not prove live forwarding.",
      "Host evidence: captures or socket state on both ends, connection retransmits, and application timeouts. A silent drop looks like a timeout, not a connection refusal.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the matched route's state and target before changing routes. Then check the reverse route on the peer side. Only then look at capacity, security groups, and network access control lists (ACLs). A blackhole cannot be fixed by adding a more specific route to another dead target.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Find the route that wins the longest-prefix match for the destination. Record its destination, target, and state.",
      "Check the target's state in the owning service: peering connection, transit gateway attachment, NAT gateway, network interface, or VPC endpoint.",
      "Restore the target if possible: accept the peering request, recreate the attachment, or replace the deleted gateway.",
      "If the target cannot be restored, replace the route target with an active path and remove the stale route so it cannot return.",
      "Verify the reverse route in the peer VPC or transit gateway route table. A request that arrives without a return route still fails.",
      "Use Reachability Analyzer to check the configuration, then send a real packet and confirm a response. Re-check at peak load to separate blackhole from saturation.",
      "Record the change and add a check that alerts on target state, not only route presence.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Restoring the old target is usually the fastest fix, but it may bring back a path that was being retired. Replacing the target is cleaner but needs changes on both sides and a rollback plan.",
      "A more specific route can steer around a failure, but it can also shadow the intended route. Longest prefix match means the most specific entry wins, even when it is wrong.",
      "Reachability Analyzer is safe and fast, but it evaluates configuration rather than live traffic. Pair it with a packet test.",
      "Adding target capacity fixes saturation but not a blackhole. Check which failure you have before spending on capacity.",
      "A route change is a control-plane change. It is fast, which is exactly why it needs review and a rollback.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "read-blackhole-state",
    question:
      "A route table shows 10.20.0.0/16 to pcx-0a1b2c3d4e5f67890 with state blackhole. What does that tell you, and what do you check next?",
    difficulty: 3,
    hints: [
      "The route still exists; the target is the problem.",
      "Check both accounts and both directions.",
    ],
    answer:
      "It means the route still matches the destination, but its target is not available, so traffic that matches is dropped. I would check the peering connection's status in both accounts first; pending-acceptance, rejected, or deleted connections produce a route with no effect. Then I would check the peer VPC's route back to the source CIDR and any transit gateway route table in the path. I would confirm the matching route with a longest-prefix check, because a more specific route could be selecting a different target. Finally I would use Reachability Analyzer to narrow the configuration blocker and a real packet test to confirm forwarding.",
    followUps: [
      "What happens to the route if the peering connection is accepted?",
      "Why does the packet not fall through to 0.0.0.0/0?",
      "Which check would you automate?",
    ],
    redFlags: [
      "Says the route is missing.",
      "Deletes and recreates routes before checking the target.",
      "Assumes a default route will take over.",
    ],
    rubric: [
      "Defines blackhole as an unavailable target, not a missing route.",
      "Checks target state in both accounts.",
      "Checks the reverse path.",
      "Distinguishes configuration analysis from live proof.",
    ],
  },
  {
    id: "prove-return-path",
    question:
      "Requests reach the destination service, but responses never arrive. How do you prove the return path is the problem?",
    difficulty: 3,
    hints: [
      "A capture on one end is not enough.",
      "The peer's route table is a separate lookup.",
    ],
    answer:
      "I would capture or count packets on both ends and compare direction. If requests arrive at the destination but no response leaves it, or responses leave but never reach the source, the forward path is not the whole story. I would read the peer subnet's route table for a route back to the source CIDR, and the transit gateway route table if one is in the path. I would also check security groups and network ACLs in the return direction, because a stateful rule can still be wrong for asymmetric traffic. Then I would send a request from the destination back to the source as a separate test; success in that direction is strong evidence the return route exists.",
    followUps: [
      "What does a one-way capture show?",
      "How can a network ACL break the return direction?",
      "When would asymmetric routing make this harder?",
    ],
    redFlags: [
      "Only checks the source route table.",
      "Assumes TCP handshakes prove both directions.",
      "Changes security groups without checking routes.",
    ],
    rubric: [
      "Compares evidence from both ends.",
      "Checks the peer route table and gateway route table.",
      "Considers security groups and ACLs in both directions.",
      "Runs a separate reverse-direction test.",
    ],
  },
  {
    id: "analyzer-limits",
    question:
      "Why is Reachability Analyzer not a substitute for a live ping or curl?",
    difficulty: 2,
    hints: [
      "It analyzes configuration.",
      "It can identify a blocking component without proving the data plane.",
    ],
    answer:
      "Reachability Analyzer evaluates the configured path between a source and destination and returns hop-by-hop details or the component that blocks the path. That is useful for finding a bad route, security group, network ACL, or load balancer configuration. It does not send production traffic, so it cannot prove that the live data plane is forwarding, that a target is healthy, or that an application is listening. A configuration can look correct while a target is saturated or an application is down. I use the analyzer to narrow the search, then confirm with a real packet and a response.",
    followUps: [
      "What would you do if the analyzer says the path is reachable but requests still fail?",
      "Which layer would you check next?",
      "How would you use the analyzer before a change?",
    ],
    redFlags: [
      "Treats the analyzer as a live monitor.",
      "Skips the application and target health checks.",
      "Assumes a reachable configuration is a working service.",
    ],
    rubric: [
      "Describes static configuration analysis.",
      "Names what it cannot prove.",
      "Pairs it with a real traffic test.",
      "Mentions pre-change verification.",
    ],
  },
  {
    id: "shadowed-route",
    question:
      "A /24 route to a NAT gateway shadows the /16 peering route. Why does that break connectivity, and what do you change?",
    difficulty: 3,
    hints: [
      "Longest prefix match wins.",
      "A NAT gateway does not route to a peered VPC.",
    ],
    answer:
      "The route table uses the most specific matching route, so the /24 wins over the /16 even if the /16 is the intended path. The packet goes to the NAT gateway, which is for internet-bound traffic and does not provide a path to the peered VPC, so the connection fails. I would remove or correct the /24 route, or change its target to the peering connection if that is the intent, then verify the peer's return route. I would also search for other more-specific routes that could shadow the intended path, because fixing one does not rule out another.",
    followUps: [
      "How would you find all shadowing routes?",
      "When might a more specific route be correct?",
      "What would you check in the peer VPC?",
    ],
    redFlags: [
      "Adds another default route.",
      "Blames the peering connection without reading the /24.",
      "Ignores route priority.",
    ],
    rubric: [
      "Explains longest-prefix match.",
      "Names the wrong target behavior.",
      "Fixes the specific route.",
      "Checks the return path and other shadowing routes.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Route tables, targets, and attachment owners are inventoried for every shared path.",
      "Alerts cover target state and route state, not only route count.",
      "Both directions of each path have an owner and a documented return route.",
      "Reachability Analyzer paths are saved for critical source and destination pairs.",
      "Route changes have review, rollback, and a post-change packet test.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the winning route and read its state before changing anything.",
      "Check the target attachment in the owning service and account.",
      "Check the return route on the peer side and any transit gateway route table.",
      "Use flow logs or captures to localize the drop; do not guess from one end.",
      "Record the change and keep a rollback path to the previous target.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove stale blackhole routes and update the infrastructure code.",
      "Re-test both directions at peak load.",
      "Add a check for target availability and route state.",
      "Write down which failure mode was present: blackhole, saturation, or return path.",
    ],
  },
];

const references = [
  {
    title: "Amazon EC2 API: Route state",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Route.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines active and blackhole route states and gives target-unavailable examples.",
  },
  {
    title: "Update your route tables for a VPC peering connection",
    url: "https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-routing.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "A route to a pending-acceptance peering connection has state blackhole and no effect.",
  },
  {
    title: "What is Reachability Analyzer?",
    url: "https://docs.aws.amazon.com/vpc/latest/reachability/what-is-reachability-analyzer.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Static configuration analysis that returns hop-by-hop details or the blocking component.",
  },
  {
    title: "Route table concepts",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/RouteTables.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Destinations, targets, associations, and local routes.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "route-path": {
      model: routeTableModel,
      presets,
      instructions:
        "Start healthy, apply Blackhole route, then compare the missing return path and target saturation. Watch route state and end-to-end delivery together.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Target capacity is 5,000 pps in this teaching scenario, not a published VPC peering limit.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-subnets",
    "cloud-networking-nat-gateway",
    "cloud-networking-peering-vs-tgw",
    "cloud-networking-reachability-analyzer",
    "cloud-networking-flow-logs",
  ],
};
