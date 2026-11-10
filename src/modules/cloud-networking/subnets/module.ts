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

const VPC_CIDR = "10.0.0.0/16";
const SUBNET_CIDR = "10.0.1.0/24";
const PARTNER_CIDR = "198.51.100.0/24";
const PARTNER_HOST = "198.51.100.20";
const APPLIANCE_ID = "eni-0a1b2c3d4e5f67890";

const params = [
  {
    id: "routeTable",
    label: "Subnet route table",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Association",
    help: "0 uses the VPC main route table. 1 explicitly associates the subnet with rtb-public. A subnet uses one table at a time, so routes in the other table do not apply.",
    format: "count" as const,
  },
  {
    id: "defaultRoute",
    label: "Default route in rtb-public",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Routes",
    help: "1 adds 0.0.0.0/0 to the internet gateway in rtb-public. It only helps if the subnet is associated with that table.",
    format: "count" as const,
  },
  {
    id: "partnerRoute",
    label: "Partner /24 route",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Routes",
    help: "1 adds 198.51.100.0/24 to an appliance network interface in rtb-public. The appliance is unavailable here, so the route state becomes blackhole.",
    format: "count" as const,
  },
  {
    id: "packetRate",
    label: "Offered packets",
    min: 100,
    max: 2_000,
    step: 100,
    value: 400,
    unit: " pps",
    group: "Traffic",
    help: "Illustrative packets per second from the instance to the partner host. Dropped packets scale with this value; route selection does not.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  custom: boolean;
  defaultOn: boolean;
  partnerOn: boolean;
  hasDefault: boolean;
  hasPartner: boolean;
  demand: number;
  delivered: number;
  dropped: number;
  shortfall: number;
  blackholed: number;
  matched: string;
  instanceHealth: Health;
  routeHealth: Health;
  targetHealth: Health;
}

function compute(p: Params): Computed {
  const custom = num(p, "routeTable", 1) >= 0.5;
  const defaultOn = num(p, "defaultRoute", 1) >= 0.5;
  const partnerOn = num(p, "partnerRoute", 0) >= 0.5;
  const hasDefault = custom && defaultOn;
  const hasPartner = custom && partnerOn;
  const demand = Math.max(1, num(p, "packetRate", 400));
  const delivered = hasPartner ? 0 : hasDefault ? demand : 0;
  const dropped = demand - delivered;
  const shortfall = demand > 0 ? (dropped / demand) * 100 : 0;
  const blackholed = hasPartner ? 1 : 0;
  const matched = hasPartner ? PARTNER_CIDR : hasDefault ? "0.0.0.0/0" : "none";
  return {
    custom,
    defaultOn,
    partnerOn,
    hasDefault,
    hasPartner,
    demand,
    delivered,
    dropped,
    shortfall,
    blackholed,
    matched,
    instanceHealth: delivered > 0 ? "ok" : "warn",
    routeHealth: hasPartner ? "crit" : hasDefault ? "ok" : "crit",
    targetHealth: delivered > 0 ? "ok" : "crit",
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
  const routeDetail = !v.custom
    ? "The subnet is implicitly associated with the main route table. In this scenario the main table has only the local route, so the default route in rtb-public is not consulted."
    : v.hasPartner
      ? `The subnet uses rtb-public. ${PARTNER_CIDR} points at ${APPLIANCE_ID}, whose appliance is unavailable, so the route state is blackhole. The /24 is more specific than 0.0.0.0/0 and wins; the packet does not fall back to the default route.`
      : v.hasDefault
        ? "The subnet uses rtb-public. 0.0.0.0/0 points at the internet gateway, and no more specific route matches the partner host."
        : "The subnet uses rtb-public, but that table has no 0.0.0.0/0 route. The local route covers only 10.0.0.0/16.";
  return {
    t: 0,
    nodes: [
      {
        id: "instance",
        label: "app-1",
        kind: "service",
        health: v.instanceHealth,
        sublabel: `${SUBNET_CIDR} · ${formatCount(v.demand)} pps`,
        detail: `Instance in ${SUBNET_CIDR}. It is trying to reach the partner host ${PARTNER_HOST}. The subnet's association decides which route table is consulted.`,
        meta: { view: "flow" },
      },
      {
        id: "subnet",
        label: "subnet-app-a",
        kind: "mesh",
        health: "ok",
        sublabel: v.custom ? "associated: rtb-public" : "implicit: main route table",
        detail: v.custom
          ? "The subnet is explicitly associated with rtb-public. A subnet can be associated with only one route table at a time."
          : "The subnet has no explicit association, so it uses the VPC main route table. Routes in rtb-public do not apply to this subnet.",
        meta: { view: "flow" },
      },
      {
        id: "route-table",
        label: v.custom ? "rtb-public" : "rtb-main",
        kind: "mesh",
        health: v.routeHealth,
        sublabel: `match: ${v.matched}`,
        detail: routeDetail,
        meta: { view: "flow", matched: v.matched, blackholed: v.blackholed },
      },
      {
        id: "target",
        label: PARTNER_HOST,
        kind: "external",
        health: v.targetHealth,
        sublabel: v.hasPartner ? "matched /24 · blackhole" : "partner API",
        detail:
          v.hasPartner
            ? `${PARTNER_CIDR} selects the unavailable appliance. The destination is never reached, and the default route is shadowed.`
            : v.hasDefault
              ? `The default route sends the packet to the internet gateway. Reaching ${PARTNER_HOST} still depends on the target and the return path.`
              : "No route matches the partner host, so the packet is dropped at the source route lookup.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("instance-subnet", "instance", "subnet", 1, v.instanceHealth),
      edge("subnet-route", "subnet", "route-table", 1, v.custom ? "ok" : "warn"),
      edge(
        "route-target",
        "route-table",
        "target",
        v.demand > 0 ? v.delivered / v.demand : 0,
        v.targetHealth,
      ),
    ],
    metrics: [
      metric("delivery-rate", "End-to-end delivery", v.demand > 0 ? (v.delivered / v.demand) * 100 : 0, "%", undefined, undefined, "percent"),
      metric("dropped-pps", "Dropped packets", v.dropped, " pps", 10, 100, "rps"),
      metric("delivery-shortfall", "Delivery shortfall", v.shortfall, "%", 1, 50, "percent"),
      metric("blackholed-route", "Blackholed route in path", v.blackholed, "", 1, 1, "count"),
      metric("offered-pps", "Offered packets", v.demand, " pps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      routeTable: v.custom ? 1 : 0,
      defaultRoute: v.defaultOn ? 1 : 0,
      partnerRoute: v.partnerOn ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} pps offered; ${v.matched} matched; ${formatCount(v.dropped)} pps dropped; subnet uses ${
      v.custom ? "rtb-public" : "rtb-main"
    }.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "dropped-pps",
    metricId: "dropped-pps",
    warn: 10,
    crit: 100,
    title: "The subnet has a route table, but packets are being dropped",
    cause:
      "The packet matched a route whose target cannot forward it, or the subnet's associated table has no matching route. Association and route state both decide the outcome.",
    fix:
      "Read the table associated with this subnet, not a table that merely contains the route you expected. Then restore the selected target or correct the association.",
    checkFirst: [
      "Check which route table the subnet is actually associated with.",
      "Find the longest prefix that matches the destination and read its state.",
      "Confirm the target exists and is available before adding another route.",
    ],
  },
  {
    id: "delivery-shortfall",
    metricId: "delivery-shortfall",
    warn: 1,
    crit: 50,
    title: "Most or all packets never reach the destination",
    cause:
      "The subnet is using the main table without a default route, or a more specific blackhole route is shadowing the default route. Route presence in a different table is not enough.",
    fix:
      "Associate the subnet with the intended table, add the missing default route, or remove the blackhole route after restoring its target. Verify the longest-prefix result.",
    checkFirst: [
      "Check the subnet association before editing routes.",
      "Compare the destination against every route, not just the default.",
      "Use flow logs or a packet test to confirm the drop point.",
    ],
  },
  {
    id: "blackholed-route",
    metricId: "blackholed-route",
    warn: 1,
    crit: 1,
    title: "A more specific route points at an unavailable target",
    cause:
      "The /24 route matches the partner host and wins over 0.0.0.0/0. Its target appliance is unavailable, so AWS marks the route blackhole and drops the packet.",
    fix:
      "Restore the appliance or change the route target to an active path. Removing the /24 route is also valid if the partner host should use the default route.",
    checkFirst: [
      "Read the route state and the target in the matching table.",
      "Confirm the target network interface or appliance still exists.",
      "Check whether another more specific route also matches the destination.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const subnetsModel: SimModel = {
  id: "cloud-networking-subnets",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const v = compute(p);
    const prevTable = Number(frame.flags.routeTable ?? -1);
    const prevDefault = Number(frame.flags.defaultRoute ?? -1);
    const prevPartner = Number(frame.flags.partnerRoute ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    const noise = rng.between(-0.4, 0.4);
    next.metrics = next.metrics.map((item) =>
      item.id === "dropped-pps" && v.dropped > 0
        ? { ...item, value: Math.max(0, item.value + noise) }
        : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.routeTable = v.custom ? 1 : 0;
    next.flags.defaultRoute = v.defaultOn ? 1 : 0;
    next.flags.partnerRoute = v.partnerOn ? 1 : 0;
    if (prevTable !== -1 && prevTable !== next.flags.routeTable) {
      pushEvent(next, {
        id: "route-table-association",
        at: frame.t,
        severity: v.custom ? "info" : "warn",
        title: v.custom ? "Subnet associated with rtb-public" : "Subnet moved to the main route table",
        detail: v.custom
          ? "The subnet now consults rtb-public. Confirm that the table has a route for the destination."
          : "The subnet now uses the main route table. The internet route in rtb-public no longer applies to this subnet.",
        nodeId: "subnet",
        metricId: "delivery-shortfall",
      });
    }
    if (prevDefault !== -1 && prevDefault !== next.flags.defaultRoute) {
      pushEvent(next, {
        id: "default-route-change",
        at: frame.t,
        severity: v.defaultOn ? "info" : "warn",
        title: v.defaultOn ? "Default route added to rtb-public" : "Default route removed from rtb-public",
        detail: v.defaultOn
          ? "0.0.0.0/0 now points at the internet gateway in rtb-public. It applies to subnets associated with that table; more specific routes still take priority."
          : "rtb-public no longer has a default route. The table keeps its local route and any more specific entries.",
        nodeId: "route-table",
        metricId: "dropped-pps",
      });
    }
    if (prevPartner !== -1 && prevPartner !== next.flags.partnerRoute) {
      pushEvent(next, {
        id: "partner-route-change",
        at: frame.t,
        severity: v.partnerOn ? "crit" : "info",
        title: v.partnerOn ? "Partner /24 route added with an unavailable target" : "Partner /24 route removed",
        detail: v.partnerOn
          ? `${PARTNER_CIDR} is now in rtb-public and points at ${APPLIANCE_ID}. For a subnet associated with that table, the route wins over 0.0.0.0/0 and its state is blackhole.`
          : `${PARTNER_CIDR} is no longer in rtb-public. If the subnet uses that table, the default route now handles the partner host.`,
        nodeId: "route-table",
        metricId: "blackholed-route",
      });
    }
    next.summary = `${formatCount(v.demand)} pps offered; ${v.matched} matched; ${formatCount(v.dropped)} pps dropped; subnet uses ${
      v.custom ? "rtb-public" : "rtb-main"
    }.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (!v.custom) {
      items.push(
        "The subnet is implicitly using the main route table. The default route exists in rtb-public, but a route table only applies to the subnets associated with it.",
      );
    } else if (v.hasPartner) {
      items.push(
        `${PARTNER_CIDR} matches before 0.0.0.0/0 and points at ${APPLIANCE_ID}. The route state is blackhole, so the packet is dropped and never falls through to the internet gateway.`,
      );
    } else if (!v.hasDefault) {
      items.push(
        "The subnet is associated with rtb-public, but the table has no 0.0.0.0/0 route. The local route covers the VPC CIDR only.",
      );
    } else {
      items.push(
        `${PARTNER_HOST} matches 0.0.0.0/0 and is sent to the internet gateway. No more specific route shadows the default.`,
      );
    }
    items.push(
      `The local route for ${VPC_CIDR} is always present. A route table chooses a target; it does not guarantee that the target is available or that the return path exists.`,
    );
    items.push(
      "Longest prefix match is decided before target health. A /24 blackhole route beats a healthy default route for every address inside that /24.",
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
    description: "Subnet associated with rtb-public, default route present, and no shadowing /24.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "The same correct route at the top of the illustrative packet range.",
    tone: "ok",
    params: defaults({ packetRate: 2_000 }),
  },
  {
    id: "failure",
    label: "Blackhole /24",
    description: "A more specific partner route points at an unavailable appliance and shadows the default route.",
    tone: "crit",
    params: defaults({ partnerRoute: 1, packetRate: 800 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The blackhole /24 is removed and the default route carries the partner traffic again.",
    tone: "ok",
    params: defaults({ packetRate: 400 }),
  },
];

const experiment: Experiment = {
  id: "predict-more-specific-route",
  title: "Predict which route wins",
  simId: "subnet-path",
  question:
    "The subnet uses rtb-public. The table has 0.0.0.0/0 to an internet gateway and 198.51.100.0/24 to an appliance network interface whose appliance is gone. A packet goes to 198.51.100.20. What happens?",
  prediction: {
    options: [
      { id: "default-wins", label: "The default route wins because the /24 target is unavailable." },
      { id: "specific-drops", label: "The /24 route wins and the packet is dropped as a blackhole." },
      { id: "ecmp", label: "Traffic is split across both routes." },
      { id: "local", label: "The local route sends the packet inside the VPC." },
    ],
    correctOptionId: "specific-drops",
    explanation:
      "AWS selects the most specific matching route before considering the target's health. The /24 wins, its target is unavailable, and the route state is blackhole. The packet is dropped; it does not fall back to 0.0.0.0/0.",
  },
  setup: defaults({ routeTable: 1, defaultRoute: 1, partnerRoute: 1, packetRate: 800 }),
  runFor: 15,
  observe: [
    "The matched route is 198.51.100.0/24, not 0.0.0.0/0.",
    "The blackholed /24 route count is 1 and the route-table node is failing.",
    "Dropped packets equal the offered load, and delivery is 0%.",
    "The default route is still present and active, but it is not selected.",
    "Removing the /24 route restores delivery through the default route.",
  ],
  explain:
    "Longest prefix match is a match rule, not a health check. A /24 route is more specific than 0.0.0.0/0, so it wins for every address in that /24 even when its target is unavailable. The route remains in the table with state blackhole and the packet is dropped. The fix is to restore the target or remove the route, not to add another default route.",
  fix: defaults({ routeTable: 1, defaultRoute: 1, partnerRoute: 0, packetRate: 800 }),
  debrief:
    "Delivery returns to 100% when the /24 blackhole is removed and the default route is selected. The default route was healthy the whole time; it simply was not the longest match. In production, search the table for more specific routes before blaming the default route or the internet gateway.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A subnet is a range of IP addresses inside one VPC and one Availability Zone. It cannot span zones. Every subnet is associated with exactly one route table, either explicitly or implicitly through the VPC's main route table. That association is the first thing to check when a host has an address but no path.",
  },
  {
    type: "p",
    text: "A route table is a list of destination prefixes and targets. AWS uses the most specific prefix that matches the packet's destination, known as longest prefix match. The local route covers the VPC CIDR, a default route covers 0.0.0.0/0, and a more specific route can point at a NAT gateway, network interface, gateway load balancer endpoint, peering connection, or internet gateway. Adding a route to a table does not change which subnets use that table.",
  },
  {
    type: "p",
    text: "A route can also fail after it matches. If the target is unavailable, the route state is blackhole. The entry remains visible and still wins the prefix match; the packet is dropped rather than falling through to a less specific route. That is why counting routes or checking that a destination has an entry is not enough.",
  },
  {
    type: "p",
    text: "One AWS constraint matters for prefixes inside the VPC. A route more specific than the local route must match an entire subnet CIDR and target a NAT gateway, network interface, or Gateway Load Balancer endpoint. The partner prefix in this demo is outside the VPC, so a normal target route applies.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is instance network interface, subnet, associated route table, selected target, destination. The table lookup is stateless and per packet. The return path is a separate lookup in the destination's network, so a one-way route is not a working path.",
  },
  {
    type: "table",
    headers: ["Destination", "Target", "State", "Result for 198.51.100.20"],
    rows: [
      ["10.0.0.0/16", "local", "active", "Does not match the partner host."],
      ["198.51.100.0/24", "eni-0a1b2c3d4e5f67890", "blackhole", "Matches, wins over the default, and is dropped."],
      ["0.0.0.0/0", "igw-0a1b2c3d4e5f67890", "active", "Does not win while the /24 route exists."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Main route table",
    rightTitle: "Custom route table",
    rows: [
      { label: "Association", left: "Implicit for subnets without an explicit association.", right: "Explicitly associated with one or more subnets." },
      { label: "Routes", left: "Can be edited, but starts with the local route in a nondefault VPC.", right: "Starts with the local route and can hold internet, partner, or appliance routes." },
      { label: "Deletion", left: "Cannot be deleted.", right: "Can be deleted when it has no associations." },
      { label: "Common mistake", left: "Adding 0.0.0.0/0 here and expecting a custom-table subnet to use it.", right: "Adding a route here and forgetting to associate the subnet." },
    ],
  },
  {
    type: "p",
    text: "The primary failure this module targets is a more specific /24 route to a dead appliance. The subnet has the right table and a healthy default route, but the winning route points at an unavailable target and the packet is dropped. The second failure is an association mistake: the custom table contains the internet route while the subnet uses the main table, so the route exists somewhere but not in the table the subnet consults.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A subnet association toggle: main table or rtb-public.",
      "A default-route toggle in rtb-public and a partner /24 route to an appliance.",
      "The matched prefix and the route state, not just whether a route exists.",
      "Delivery, dropped packets, and a delivery shortfall that separates a partial drop from a full outage.",
      "A packet-rate control that changes the number of drops but not which route wins.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read which table the subnet uses. Then add the partner /24 route and watch the match change from 0.0.0.0/0 to the /24 while the default route stays active. Remove the subnet association and compare a missing route with a blackhole route. Run the guided experiment before revealing its explanation.",
  },
  { type: "sim", simId: "subnet-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Adding the partner /24 route changed the winning match. The /24 is more specific than 0.0.0.0/0, so every packet to 198.51.100.20 selected the appliance target. The appliance was unavailable, the route state was blackhole, and the packet was dropped without falling back to the healthy default route.",
  },
  {
    type: "p",
    text: "The subnet also had a default route in rtb-public, but the table only applies when the subnet is associated with it. Moving the subnet to the main table removed the internet path even though the route was still visible in the custom table. The packet had no matching route at the source lookup.",
  },
  {
    type: "p",
    text: "With the blackhole route in place, raising the packet rate increased the drop count, but the matched prefix and the route state did not change. Route selection is a control-plane decision; load changes the volume of packets that hit the decision, not the decision itself.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Subnet association: describe-subnets shows the route table ID, or the subnet is implicitly using the main table.",
      "Route state: the matching route is blackhole while the destination and target remain visible.",
      "More specific routes: a /24 or /32 route to an appliance, NAT instance, or middlebox can shadow the default route.",
      "VPC Flow Logs: rejected flows show where the packet was observed; a missing record is evidence about the log point, not proof of the drop location.",
      "Reachability Analyzer: static configuration analysis that returns the blocking component; it does not prove live forwarding.",
      "Host evidence: socket state, retransmits, and timeouts. A silent drop looks like a timeout, not a connection refusal.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the subnet's route table association first, then find the longest prefix that matches the destination in that table. Read the route state and target before editing the default route. A route in a different table, or a more specific blackhole, explains most 'the route exists but nothing works' cases.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the subnet and the destination address. Confirm which route table the subnet actually uses.",
      "List every route that matches the destination and choose the longest prefix. Record its target and state.",
      "If the subnet is on the wrong table, change the association. Do not add a duplicate route to the wrong table.",
      "If the winning route is blackhole, restore the target or replace the route target. Remove the stale route if the path is being retired.",
      "If no route matches, add the correct destination and target, then confirm the return path.",
      "Test with a real packet and check both directions. Use Reachability Analyzer to narrow configuration blockers, not as proof of forwarding.",
      "Add a check for route state and for more-specific routes that shadow the default.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A single main route table is simple, but every subnet inherits it. Explicit custom tables give control but add associations to manage.",
      "A specific route to an appliance enables inspection or segmentation, but it can shadow the default route and add a failure domain.",
      "Restoring the appliance keeps the intended architecture; removing the route is faster but may bypass a security control.",
      "Longest prefix match is predictable, but it means a small, specific route can override a carefully managed default. Review the whole table.",
      "Reachability Analyzer is safe and fast, but it evaluates configuration rather than live traffic. Pair it with a packet test.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "new-subnet-no-internet",
    question:
      "A new subnet has running instances and an internet gateway is attached to the VPC, but the instances cannot reach the internet. Which route is missing?",
    difficulty: 1,
    hints: [
      "A route table only applies to the subnets associated with it.",
      "The instance also needs a public address and an allow rule.",
    ],
    answer:
      "I would first check which route table the subnet is associated with. A new subnet is implicitly associated with the main route table, and the 0.0.0.0/0 route to the internet gateway may exist only in a custom table. If so, the fix is to associate the subnet with the custom table, not to add another gateway. I would then confirm the instance has a public IPv4 or IPv6 address, the security group and network ACL allow the traffic, and the route target is an attached internet gateway.",
    followUps: [
      "What makes a subnet public?",
      "Why does a public IP alone not provide internet access?",
      "How would you check the association with the AWS CLI?",
    ],
    redFlags: [
      "Adds another internet gateway.",
      "Assumes the route applies to every subnet in the VPC.",
      "Ignores the public address or security group.",
    ],
    rubric: [
      "Checks the subnet association first.",
      "Names the 0.0.0.0/0 route to the internet gateway.",
      "Mentions the public address and allow rules.",
      "Distinguishes a route in a table from an associated route.",
    ],
  },
  {
    id: "specific-blackhole",
    question:
      "A /24 route to an appliance shadows the default route, and the appliance is down. Why does traffic not fall back to the default route, and what do you change?",
    difficulty: 2,
    hints: [
      "Longest prefix match happens before target health.",
      "A blackhole route still matches.",
    ],
    answer:
      "The route table selects the most specific matching prefix. The /24 is more specific than 0.0.0.0/0, so it wins for every address in that range. When the appliance target is unavailable, the route state is blackhole and the packet is dropped. AWS does not fall through to the less specific default route. I would restore the appliance or change the /24 target to an active path, or remove the /24 route if the partner host should use the default. Then I would verify the return path and test a real packet.",
    followUps: [
      "How would you find every route that could shadow the default?",
      "When is a specific route the correct design?",
      "What does the route state column tell you?",
    ],
    redFlags: [
      "Adds another default route.",
      "Assumes the default route takes over automatically.",
      "Deletes the route without checking the target.",
    ],
    rubric: [
      "Explains longest prefix match.",
      "Defines blackhole accurately.",
      "Chooses restore, replace, or remove based on intent.",
      "Checks the return path and tests traffic.",
    ],
  },
  {
    id: "one-table-per-subnet",
    question:
      "How many route tables can a subnet be associated with, and what happens to a subnet with no explicit association?",
    difficulty: 1,
    hints: [
      "One association at a time.",
      "The main table is the default.",
    ],
    answer:
      "A subnet can be associated with one route table at a time, but many subnets can share the same table. A subnet with no explicit association is implicitly associated with the VPC main route table. If you change which table is the main table, subnets without an explicit association follow the new main table. That is why an explicit association is safer for subnets with distinct routing needs.",
    followUps: [
      "Can you delete a custom table that still has associations?",
      "What happens when you replace the main route table?",
      "How would you migrate a subnet between tables safely?",
    ],
    redFlags: [
      "Says a subnet can use multiple tables at once.",
      "Confuses the main table with the default route.",
      "Deletes a table without checking associations.",
    ],
    rubric: [
      "States one table per subnet.",
      "Explains implicit main-table association.",
      "Mentions shared tables across subnets.",
      "Describes safe migration or deletion constraints.",
    ],
  },
  {
    id: "route-priority",
    question:
      "A route table has a static route and a propagated route for the same prefix. Which one wins, and how does that affect troubleshooting?",
    difficulty: 3,
    hints: [
      "The route priority order puts static routes above propagated routes.",
      "Longest prefix still comes first.",
    ],
    answer:
      "Longest prefix match comes first. If two routes have the same destination prefix, a static route takes priority over a propagated route. The static targets include internet gateways, NAT gateways, network interfaces, transit gateways, VPC peering connections, and gateway endpoints. That matters in troubleshooting because a propagated route that looks correct can be overridden by a static route with the same prefix. I would list both, compare their targets and states, and use Reachability Analyzer to confirm which path the configuration selects.",
    followUps: [
      "Where do VPN propagated routes fit in the order?",
      "Can two static routes have the same destination in one table?",
      "How would you detect an unintended static override?",
    ],
    redFlags: [
      "Assumes the propagated route always wins.",
      "Ignores longest prefix match.",
      "Changes routes without recording the previous target.",
    ],
    rubric: [
      "Puts longest prefix first.",
      "States static over propagated for equal prefixes.",
      "Names common static target types.",
      "Connects the rule to a troubleshooting step.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every subnet has a documented route-table association and an owner.",
      "Custom tables are used for subnets with distinct internet, partner, or inspection paths.",
      "Alerts cover route state and more-specific routes, not only the default route.",
      "Critical destinations have a saved Reachability Analyzer path.",
      "Route changes include a rollback target and a post-change packet test.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the subnet association before reading routes.",
      "Find the longest prefix that matches the destination.",
      "Read the route state and target, not just the destination.",
      "Check the return path and the security groups in both directions.",
      "Use flow logs or captures to localize the drop.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Remove stale blackhole routes and update the infrastructure code.",
      "Re-test the path at peak load.",
      "Add a check for shadowing routes and association drift.",
      "Record whether the failure was association, missing route, blackhole, or return path.",
    ],
  },
];

const references = [
  {
    title: "Subnets for your VPC",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/configure-subnets.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Each subnet sits in one Availability Zone and is associated with a route table.",
  },
  {
    title: "Subnet route tables",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/subnet-route-tables.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "One route table per subnet, implicit main-table association, and longest prefix match.",
  },
  {
    title: "How route priority works",
    url: "https://docs.aws.amazon.com/vpc/latest/userguide/route-tables-priority.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Longest prefix first, then static routes over propagated routes for equal prefixes.",
  },
  {
    title: "Amazon EC2 API: Route state",
    url: "https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Route.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defines active and blackhole route states and target-unavailable examples.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "subnet-path": {
      model: subnetsModel,
      presets,
      instructions:
        "Start healthy, then add the partner /24 route and move the subnet to the main table. Compare a blackhole route with a missing association.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Packet rates are teaching values; route matching and route-state behavior follow AWS semantics.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-vpc",
    "cloud-networking-route-tables",
    "cloud-networking-igw",
    "cloud-networking-nat-gateway",
    "cloud-networking-security-groups",
  ],
};
