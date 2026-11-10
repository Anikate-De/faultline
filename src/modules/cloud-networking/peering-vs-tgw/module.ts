import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, MAX_EVENTS, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TGW_ID = "tgw-0a1b2c3d4e5f67890";

const params = [
  {
    id: "vpcCount",
    label: "VPCs needing connectivity",
    min: 4,
    max: 16,
    step: 1,
    value: 4,
    unit: "",
    group: "Topology",
    help: "Number of VPCs that must reach each other. The required pairs are n × (n − 1) / 2.",
    format: "count" as const,
  },
  {
    id: "topology",
    label: "Transit Gateway",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Topology",
    help: "0 uses VPC peering. 1 uses one transit gateway with a VPC attachment per connected VPC.",
    format: "count" as const,
  },
  {
    id: "peeringLayout",
    label: "Peering layout: chain",
    min: 0,
    max: 1,
    step: 1,
    value: 0,
    unit: "",
    group: "Peering",
    help: "0 builds a full mesh of peering connections. 1 builds a chain (A–B, B–C, C–D). Ignored when the transit gateway is selected.",
    format: "count" as const,
  },
  {
    id: "coverage",
    label: "Connectivity deployed",
    min: 50,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Rollout",
    help: "Illustrative share of required peering links or VPC attachments that are actually deployed. A gap leaves some VPC pairs without a path.",
    format: "percent" as const,
  },
  {
    id: "tgwRouteTables",
    label: "TGW route tables",
    min: 1,
    max: 4,
    step: 1,
    value: 1,
    unit: "",
    group: "Transit Gateway",
    help: "Only used with the transit gateway. In this model, each additional route table creates an isolated segment and attachments are split evenly across the tables. Ignored for peering.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function pairs(n: number): number {
  return (n * (n - 1)) / 2;
}

interface Computed {
  vpcCount: number;
  topology: boolean;
  chain: boolean;
  coverage: number;
  tgwRouteTables: number;
  expectedPairs: number;
  reachablePairs: number;
  unconnectedPairs: number;
  connectivity: number;
  shortfall: number;
  objects: number;
  routeEntries: number;
  vpcHealth: Health;
  hubHealth: Health;
  hubLabel: string;
}

function compute(p: Params): Computed {
  const vpcCount = Math.max(2, Math.round(num(p, "vpcCount", 4)));
  const topology = num(p, "topology", 0) >= 0.5;
  const chain = num(p, "peeringLayout", 0) >= 0.5;
  const coverage = clamp(num(p, "coverage", 100) / 100, 0.5, 1);
  const tgwRouteTables = Math.max(1, Math.round(num(p, "tgwRouteTables", 1)));
  const expectedPairs = pairs(vpcCount);
  let reachablePairs = 0;
  let objects: number;
  let routeEntries: number;

  if (topology) {
    const attached = Math.round(vpcCount * coverage);
    const tables = Math.min(tgwRouteTables, Math.max(1, attached));
    let remaining = attached;
    for (let index = 0; index < tables; index++) {
      const size = Math.ceil(remaining / (tables - index));
      reachablePairs += pairs(size);
      remaining -= size;
    }
    objects = attached;
    routeEntries = attached * 2;
  } else {
    const requiredLinks = chain ? vpcCount - 1 : expectedPairs;
    const links = Math.round(requiredLinks * coverage);
    reachablePairs = links;
    objects = links;
    routeEntries = links * 2;
  }

  reachablePairs = Math.min(reachablePairs, expectedPairs);
  const unconnectedPairs = Math.max(0, expectedPairs - reachablePairs);
  const connectivity = expectedPairs > 0 ? (reachablePairs / expectedPairs) * 100 : 0;
  const shortfall = 100 - connectivity;
  const hubHealth: Health = topology
    ? tgwRouteTables > 1
      ? "warn"
      : coverage < 0.75
        ? "crit"
        : coverage < 1
          ? "warn"
          : "ok"
    : chain
      ? "crit"
      : coverage < 0.75
        ? "crit"
        : coverage < 1
          ? "warn"
          : "ok";
  const vpcHealth: Health =
    coverage < 0.75 ? "crit" : coverage < 1 || (!topology && chain) ? "warn" : "ok";

  return {
    vpcCount,
    topology,
    chain,
    coverage,
    tgwRouteTables,
    expectedPairs,
    reachablePairs,
    unconnectedPairs,
    connectivity,
    shortfall,
    objects,
    routeEntries,
    vpcHealth,
    hubHealth,
    hubLabel: topology ? TGW_ID : chain ? "peering chain" : "peering mesh",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPct(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const wave = item.value * (0.99 + 0.02 * Math.sin((index + (seed % 7)) / 2.6));
      return item.format === "percent" ? clamp(wave, 0, 100) : Math.max(0, wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const extra = Math.max(0, v.vpcCount - 4);
  const vpcs = ["a", "b", "c", "d"].map((suffix, index) => {
    const label =
      suffix === "d" && extra > 0 ? `VPC D + ${extra}` : `VPC ${suffix.toUpperCase()}`;
    return {
      id: `vpc-${suffix}`,
      label,
      kind: "external" as const,
      health: v.vpcHealth,
      sublabel: `10.${index + 1}0.0.0/16`,
      detail: v.topology
        ? `VPC ${suffix.toUpperCase()} reaches the transit gateway through its VPC attachment and a subnet route table entry targeting ${TGW_ID}.`
        : v.chain
          ? `VPC ${suffix.toUpperCase()} is peered only with its immediate neighbor. Peering does not forward traffic for a third VPC.`
          : `VPC ${suffix.toUpperCase()} has a direct peering connection to every other VPC in the mesh.`,
      meta: { view: "flow" },
    };
  });

  const hub = {
    id: "hub",
    label: v.hubLabel,
    kind: "mesh" as const,
    health: v.hubHealth,
    sublabel: v.topology
      ? `${v.tgwRouteTables} route table${v.tgwRouteTables === 1 ? "" : "s"} · ${v.objects} attachments`
      : `${v.objects} connections · ${formatCount(v.expectedPairs)} required pairs`,
    detail: v.topology
      ? `The transit gateway is a regional hub. Each VPC attachment is associated with one route table and propagates its VPC CIDR. Extra route tables segment the hub; attachments in different tables do not share routes unless you configure it. The visual groups VPCs beyond D; the attachment count is the full set.`
      : v.chain
        ? "A chain of peering connections is not a transit network. A packet from VPC A to VPC D has no route through VPC B or C because peering is pairwise and non-transitive. The visual groups VPCs beyond D; the connection count is the full chain."
        : "Each peering connection is a one-to-one path. The mesh works because every pair has its own connection and its own route entries on both sides. The visual groups VPCs beyond D; the object count is the full pair count.",
    meta: { view: "flow" },
  };

  const peeringEdges = v.chain
    ? [
        edge("a-b", "vpc-a", "vpc-b", v.coverage, v.vpcHealth),
        edge("b-c", "vpc-b", "vpc-c", v.coverage, v.vpcHealth),
        edge("c-d", "vpc-c", "vpc-d", v.coverage, v.vpcHealth),
      ]
    : [
        edge("a-b", "vpc-a", "vpc-b", v.coverage, v.vpcHealth),
        edge("a-c", "vpc-a", "vpc-c", v.coverage, v.vpcHealth),
        edge("a-d", "vpc-a", "vpc-d", v.coverage, v.vpcHealth),
        edge("b-c", "vpc-b", "vpc-c", v.coverage, v.vpcHealth),
        edge("b-d", "vpc-b", "vpc-d", v.coverage, v.vpcHealth),
        edge("c-d", "vpc-c", "vpc-d", v.coverage, v.vpcHealth),
      ];
  const tgwEdges = ["a", "b", "c", "d"].map((suffix) =>
    edge(`hub-${suffix}`, "hub", `vpc-${suffix}`, v.coverage, v.vpcHealth, "attachment"),
  );

  return {
    t: 0,
    nodes: [...vpcs, hub],
    edges: v.topology ? tgwEdges : peeringEdges,
    metrics: [
      metric("connectivity", "VPC pairs connected", v.connectivity, "%", undefined, undefined, "percent"),
      metric("unconnected-pairs", "Unconnected VPC pairs", v.unconnectedPairs, "", 1, 2, "count"),
      metric("connectivity-shortfall", "Connectivity shortfall", v.shortfall, "%", 1, 10, "percent"),
      metric("topology-objects", v.topology ? "VPC attachments" : "Peering connections", v.objects, "", undefined, undefined, "count"),
      metric("route-entries", "Route entries (illustrative)", v.routeEntries, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      topology: v.topology ? 1 : 0,
      chain: v.chain ? 1 : 0,
      coverage: v.coverage,
    },
    summary: `${v.vpcCount} VPCs, ${formatCount(v.expectedPairs)} pairs; ${formatPct(v.connectivity)}% connected via ${
      v.topology ? `${v.tgwRouteTables} TGW route table${v.tgwRouteTables === 1 ? "" : "s"}` : v.chain ? "a peering chain" : "a peering mesh"
    }.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "unconnected-pairs",
    metricId: "unconnected-pairs",
    warn: 1,
    crit: 2,
    title: "Some VPC pairs have no network path",
    cause:
      "Peering is one-to-one and non-transitive, so a chain gives only direct neighbors a path. With a transit gateway, a missing attachment or an isolated route table leaves pairs without a route.",
    fix:
      "Deploy the full peering mesh or attach every VPC to the transit gateway and associate the attachments with a route table that contains the other VPC CIDRs. Treat segmentation as a deliberate isolation decision.",
    checkFirst: [
      "Count the VPCs and the pairs that must communicate: n × (n − 1) / 2.",
      "For peering, verify a connection and a route on both sides for every required pair.",
      "For a transit gateway, verify the attachment state, route table association, and propagated routes.",
    ],
  },
  {
    id: "connectivity-shortfall",
    metricId: "connectivity-shortfall",
    warn: 1,
    crit: 10,
    title: "The topology reaches less than the intended VPC set",
    cause:
      "A partial rollout, a chain instead of a mesh, or transit gateway segmentation reduces the share of VPC pairs that can communicate. The missing pairs are not necessarily the ones you tested.",
    fix:
      "Compare the intended pair matrix with the observed paths. Add the missing peering connections or attachments, and verify routes from both ends rather than assuming the hub or peer forwards for a third VPC.",
    checkFirst: [
      "Draw the intended pair matrix and mark each pair that has a route in both directions.",
      "Check whether the topology is transitive by design or only by assumption.",
      "Check whether a route table association isolates an attachment from the CIDRs it needs.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const peeringVsTgwModel: SimModel = {
  id: "cloud-networking-peering-vs-tgw",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousTopology = Number(frame.flags.topology ?? 0);
    const previousChain = Number(frame.flags.chain ?? 0);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-MAX_EVENTS);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([key, values]) => [key, [...values]]),
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));

    if (previousTopology !== (v.topology ? 1 : 0)) {
      pushEvent(next, {
        id: "topology-switch",
        at: frame.t,
        severity: v.topology ? "info" : "warn",
        title: v.topology ? "Switched to a transit gateway" : "Switched to VPC peering",
        detail: v.topology
          ? `Each VPC now needs an attachment to ${TGW_ID}, a VPC route table entry targeting the gateway, and a route table association that contains the other VPC CIDRs.`
          : "Each VPC now needs a direct peering connection and a route on both sides for every peer it must reach.",
        nodeId: "hub",
        metricId: "connectivity",
      });
    }
    if (previousChain !== (v.chain ? 1 : 0) && !v.topology) {
      pushEvent(next, {
        id: "peering-layout-change",
        at: frame.t,
        severity: v.chain ? "crit" : "info",
        title: v.chain ? "Peering chain cannot transit" : "Full peering mesh restored",
        detail: v.chain
          ? "A–B and B–C are separate one-to-one paths. VPC A has no route to VPC C through VPC B, and VPC B does not forward packets for a third VPC."
          : "Every VPC pair now has its own peering connection and a route on both sides.",
        nodeId: "hub",
        metricId: "unconnected-pairs",
      });
    }
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.topology) {
      items.push(
        `${v.objects} VPCs are attached to ${TGW_ID}. With ${v.tgwRouteTables} route table${v.tgwRouteTables === 1 ? "" : "s"}, ${formatPct(v.connectivity)}% of the ${formatCount(v.expectedPairs)} pairs can reach each other.`,
      );
      if (v.tgwRouteTables > 1) {
        items.push(
          "Segmentation is deliberate here: attachments in different route tables do not share routes. Add a shared route table or explicit routes if cross-segment traffic is required.",
        );
      } else {
        items.push(
          "One shared route table lets every attachment reach every other attachment. The hub is transitive by configuration, not because the attachments are special.",
        );
      }
    } else if (v.chain) {
      items.push(
        `The chain has ${v.objects} peering connections but ${formatCount(v.expectedPairs)} required pairs. Only ${formatPct(v.connectivity)}% are connected because peering is pairwise and non-transitive.`,
      );
      items.push(
        "Adding a route in VPC A that points at VPC B does not create a path to VPC C. VPC B is not a router for peered traffic, and the peering connection is not a transit attachment.",
      );
    } else {
      items.push(
        `The full mesh has ${v.objects} peering connections for ${formatCount(v.expectedPairs)} pairs. Each connection needs a route in both VPC route tables.`,
      );
      items.push(
        `At ${v.vpcCount} VPCs the mesh needs ${formatCount(v.objects)} connections. Doubling the VPC count roughly quadruples the connections, which is the operational cost of peering.`,
      );
    }
    items.push(
      `This topology uses ${formatCount(v.routeEntries)} route entries in the model. Route count is illustrative; the pair count and the non-transitive behavior are the durable lessons.`,
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
    label: "Small full mesh",
    description: "Four VPCs, six peering connections, every pair routed in both directions.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Eight-VPC mesh",
    description: "A full mesh at eight VPCs: 28 connections and 56 route entries to own and audit.",
    tone: "info",
    params: defaults({ vpcCount: 8 }),
  },
  {
    id: "failure",
    label: "Peering chain",
    description: "Ten VPCs connected in a chain. Only direct neighbors can communicate.",
    tone: "crit",
    params: defaults({ vpcCount: 10, topology: 0, peeringLayout: 1, coverage: 100 }),
  },
  {
    id: "segmented",
    label: "Segmented TGW",
    description: "Ten VPCs on one transit gateway with three isolated route tables.",
    tone: "crit",
    params: defaults({ vpcCount: 10, topology: 1, coverage: 100, tgwRouteTables: 3 }),
  },
  {
    id: "recovery",
    label: "Shared TGW",
    description: "Ten VPC attachments on one shared transit gateway route table.",
    tone: "ok",
    params: defaults({ vpcCount: 10, topology: 1, coverage: 100, tgwRouteTables: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-peering-transitivity",
  title: "Predict the reachable set",
  simId: "peering-topology",
  question:
    "Ten VPCs are connected in a chain: A–B, B–C, C–D, and so on. Every peering connection is active and both sides have routes for their direct neighbor. How many of the 45 VPC pairs can communicate?",
  prediction: {
    options: [
      { id: "all", label: "All 45 pairs, because every VPC has at least one peering connection." },
      { id: "neighbors", label: "Only the 9 direct neighbor pairs; peering is non-transitive." },
      { id: "half", label: "About half, because traffic alternates through the chain." },
      { id: "none", label: "None, because a chain is not a valid peering topology." },
    ],
    correctOptionId: "neighbors",
    explanation:
      "A VPC peering connection is a one-to-one relationship. VPC B can reach A and C, but it does not route A's traffic to C. Only the directly peered pairs have a path, so 9 of the 45 pairs are connected.",
  },
  setup: defaults({ vpcCount: 10, topology: 0, peeringLayout: 1, coverage: 100, tgwRouteTables: 1 }),
  runFor: 20,
  observe: [
    "There are 9 peering connections for 10 VPCs.",
    "The expected pair count is 45, but only 9 pairs are reachable.",
    "Connectivity is 20% and 36 pairs are unconnected.",
    "Every peering connection is healthy; the topology is the limitation.",
    "The unconnected count stays flat because no peer forwards for a third VPC.",
  ],
  explain:
    "Peering does not provide transitive routing. A route in VPC A that sends C's prefix to the A–B peering connection still needs VPC B to forward the packet to C, and B has no route to C through the A–B connection. Each VPC pair that must communicate needs its own peering connection and a route on both sides. A transit gateway replaces the pairwise mesh with a hub that is explicitly configured to route between attachments.",
  fix: defaults({ vpcCount: 10, topology: 1, peeringLayout: 0, coverage: 100, tgwRouteTables: 1 }),
  debrief:
    "The chain looked connected because every VPC had a peer, but the pair matrix was mostly empty. In production, inventory the pairs that must communicate, not the number of connections. At ten VPCs a full mesh needs 45 connections; a transit gateway needs ten attachments and one shared route table.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "VPC peering is a one-to-one private connection between two VPCs. It works within an account, across accounts, and across Regions. Each side adds a route to the other VPC's CIDR pointing at the peering connection. The connection is not a gateway or a VPN, and it has no transitive property: if A is peered with B and B is peered with C, A cannot reach C through B.",
  },
  {
    type: "p",
    text: "AWS Transit Gateway is a regional hub. VPCs, VPN connections, Direct Connect gateways, Connect attachments, and transit gateway peering attachments attach to it. Each attachment is associated with one transit gateway route table, and it can propagate its routes into one or more tables. The hub routes packets between attachments according to those tables.",
  },
  {
    type: "p",
    text: "The difference is not only scale. Peering distributes routing responsibility to every VPC pair. A transit gateway centralizes the route table and the policy that decides which attachments can reach each other. Peering is simpler at two or three VPCs; a hub is easier to reason about when the pair count grows.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "In a peering path, the VPC route table selects the peering connection, and the peer VPC must have a route back. In a transit gateway path, the VPC route table selects the gateway, the attachment's associated route table selects the next attachment, and the destination VPC's route table selects the destination subnet. Every hop has a route table, and every direction must be configured.",
  },
  {
    type: "table",
    headers: ["Question", "VPC peering", "Transit Gateway"],
    rows: [
      ["Relationship", "One-to-one", "Many attachments to one regional hub"],
      ["Transitive routing", "No", "Yes, between attachments in a shared route table"],
      ["Route ownership", "Every VPC pair, both sides", "VPC route to the gateway plus the gateway route table"],
      ["Segmentation", "Separate peering connections and route tables", "Multiple gateway route tables and associations"],
      ["Cross-Region", "Inter-Region peering", "Transit gateway peering attachment with static routes"],
      ["Typical cost model", "Data transfer", "Attachment-hour plus data processing"],
    ],
  },
  {
    type: "p",
    text: "The full mesh count is n × (n − 1) / 2. Four VPCs need six connections; ten need 45. Each connection needs a route on both sides, so the route work is roughly double the connection count. A transit gateway at ten VPCs needs ten attachments, one route per VPC to the gateway, and one propagated route per attachment in the shared table.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "VPC pair connectivity: the share of required pairs that can actually send packets both ways.",
      "Unconnected pairs: the count that the topology leaves without a path.",
      "Peering layout: a full mesh versus a chain that demonstrates non-transitive routing.",
      "Transit gateway attachments and route tables: how segmentation changes the reachable set.",
      "Topology objects and route entries: the operational surface that grows with the design.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with the four-VPC full mesh and confirm that all six pairs connect. Switch the peering layout to a chain: the connections stay active but connectivity collapses. Then move to the transit gateway and raise the route table count. The comparison is the point: same VPCs, different ownership and reachability.",
  },
  {
    type: "p",
    text: "Rates, route entries, and the 50–100% rollout slider are illustrative teaching values. They are not AWS quotas. The pair arithmetic, non-transitive peering behavior, attachment model, and route table association rules follow AWS documentation.",
  },
  { type: "sim", simId: "peering-topology" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The chain had a peering connection for every adjacent pair, and every connection was active. Connectivity was still 20% because only direct neighbors could communicate. The missing pairs did not need a new route to the neighbor; they needed a path that the topology did not provide.",
  },
  {
    type: "p",
    text: "The transit gateway changed the model. Ten VPC attachments shared one route table and every pair connected. With three route tables, the hub split into isolated segments and connectivity fell again. That second failure was deliberate: segmentation is a policy choice, not a peering limitation.",
  },
  {
    type: "p",
    text: "The full mesh at eight VPCs connected every pair but required 28 peering connections. The connectivity metric stayed at 100% while the object count and route entries grew. The topology was correct and the operational burden was the tradeoff.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "A peering connection can be active while a route is missing on one side. The packet is dropped or takes a different path; connection state alone is not proof of reachability.",
      "VPC route tables show a route to the peer CIDR with target pcx-…. A blackhole state means the connection is not active or the target is unavailable.",
      "On a transit gateway, check the attachment state, the route table association, and the propagated routes. An attachment can be available but associated with a table that lacks the destination.",
      "Segmentation is visible as multiple gateway route tables. A missing association or propagation is a routing change, not a failed attachment.",
      "Reachability Analyzer can evaluate a source and destination across the configured path and name the blocking component. It does not prove throughput or application health.",
      "VPC Flow Logs show whether traffic reached an ENI. A missing record at one log point does not prove the packet never left the source.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Count the VPC pairs that must communicate and mark the ones with a route in both directions. For peering, check the connection and both route tables. For a transit gateway, check the attachment, its associated route table, and the destination CIDR in that table. Do not add a route to a peer that is not allowed to forward.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Write down the intended pair matrix, not just the list of VPCs. The pair count is the requirement.",
      "For peering, create the missing connections and add routes on both sides. A route on one side is not a path.",
      "For a chain, stop trying to route through the middle VPC. Add direct peerings or move the VPCs onto a transit gateway.",
      "For a transit gateway, confirm every VPC attachment is available and associated with the intended route table.",
      "Check that each VPC CIDR is propagated into that table, or add an explicit static route where propagation is not appropriate.",
      "Verify the VPC subnet route table sends the destination CIDR to the gateway, then test from both ends.",
      "Record the topology decision and the pair matrix so the next VPC does not silently create an unreachable island.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Peering has fewer central components and no hub to operate, but the connection and route count grows quadratically. It is a good fit for a small, stable set of VPCs.",
      "A transit gateway centralizes routing and policy, at the cost of an attachment-hour and data-processing bill plus a shared component whose route tables become critical infrastructure.",
      "A full mesh gives every pair a direct path but multiplies change scope. A hub adds a hop and a central policy point but reduces the pair matrix to attachments.",
      "Transit gateway route table segmentation limits blast radius, but an attachment in the wrong table loses connectivity even though the attachment is healthy.",
      "Cross-Region peering is direct; cross-Region transit gateway connectivity uses a peering attachment and static routes. The operational model differs even though both carry private traffic.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "ten-vpc-choice",
    question:
      "Ten VPCs need full connectivity. Compare a peering mesh with a transit gateway, including the numbers you would put in a design review.",
    difficulty: 3,
    hints: [
      "Count the pairs, not the VPCs.",
      "Think about who owns the route table.",
    ],
    answer:
      "A full peering mesh needs 45 connections for ten VPCs, because the count is n × (n − 1) / 2. Each connection needs a route on both sides, so roughly 90 route entries spread across the VPC route tables, and every new VPC requires a connection and routes to all existing VPCs. A transit gateway needs ten VPC attachments, one route per VPC subnet table pointing at the gateway, and one propagated route per attachment in a shared gateway route table. The hub is transitive by configuration and centralizes policy, at the cost of attachment-hour and data-processing charges and a shared component to operate. I would choose the hub for ten VPCs unless the VPCs are stable, few, and independently owned. If the requirement is isolation, I would use separate gateway route tables and accept that segmentation must be designed.",
    followUps: [
      "What changes if the VPCs are in three Regions?",
      "How would you isolate two business units on one gateway?",
      "What would you monitor on the hub?",
    ],
    redFlags: [
      "Says peering is transitive with enough routes.",
      "Counts ten connections for ten VPCs.",
      "Ignores route ownership or cost.",
    ],
    rubric: [
      "Computes 45 pairs.",
      "Explains both sides of each peering route.",
      "Describes TGW attachments and route tables.",
      "States a cost or operational tradeoff.",
    ],
  },
  {
    id: "chain-debug",
    question:
      "VPC A is peered with B, and B is peered with C. A's route table has C's CIDR pointing at the A–B peering connection. Why does traffic still fail?",
    difficulty: 3,
    hints: [
      "The peering connection is not a router.",
      "Check what B does with a packet whose destination is C.",
    ],
    answer:
      "The route in A sends the packet to B, but B receives a packet destined for C and must forward it. B has no route to C through the A–B connection, and even if it had a route, VPC peering does not permit B to transit traffic between two peering connections. The A–B connection is a one-to-one path between A and B, not a gateway. I would remove the misleading route, add a direct A–C peering connection if that pair must communicate, or move the VPCs onto a transit gateway whose route table explicitly routes between attachments. I would verify the route on both sides and test the return path.",
    followUps: [
      "What would a transit gateway route table need?",
      "How would you detect this before the change?",
      "Does a route to a pending peering connection help?",
    ],
    redFlags: [
      "Adds a route in B without checking peering semantics.",
      "Believes the middle VPC can route.",
      "Only checks A's route table.",
    ],
    rubric: [
      "States that peering is non-transitive.",
      "Explains B cannot forward between peerings.",
      "Chooses a direct peering or TGW.",
      "Checks both directions.",
    ],
  },
  {
    id: "tgw-segmentation",
    question:
      "You put development and production VPCs on one transit gateway but in different route tables. Both attachments are available, yet a shared services VPC cannot reach production. What do you check?",
    difficulty: 3,
    hints: [
      "Association decides what the attachment can see.",
      "Propagation decides what the table knows.",
    ],
    answer:
      "The attachments are healthy, so the problem is route visibility. Each attachment is associated with exactly one route table, and that table decides where traffic from the attachment can go. I would check which table the shared services attachment is associated with, whether the production VPC CIDR is propagated or statically present in that table, and whether the production attachment is associated with a table that has a return route to shared services. Segmentation is working as designed if the two attachments are in isolated tables. I would add a shared route table or explicit routes only where cross-segment traffic is intended, then verify both directions.",
    followUps: [
      "Can one attachment propagate to multiple tables?",
      "What happens if a route is blackholed?",
      "How would you keep development isolated but reachable from shared services?",
    ],
    redFlags: [
      "Recreates the attachments first.",
      "Assumes all attachments share the default table.",
      "Adds a VPC route without checking the gateway table.",
    ],
    rubric: [
      "Separates association from propagation.",
      "Checks both directions.",
      "Treats segmentation as intended policy.",
      "Names the concrete table change.",
    ],
  },
];

const checklist = [
  {
    title: "Before the decision",
    items: [
      "The pair matrix of VPCs that must communicate is written down, including future growth.",
      "CIDR ranges do not overlap; peering cannot be created for overlapping VPCs.",
      "Route ownership and the team that operates the hub are agreed.",
      "Cross-Region and on-premises requirements are listed, because they change the attachment model.",
      "The cost model for peering data transfer and transit gateway attachments is understood.",
    ],
  },
  {
    title: "Before the change",
    items: [
      "Every peering connection has a route on both sides, not only the requester.",
      "Every transit gateway attachment is associated with the intended route table.",
      "Each VPC CIDR is propagated or statically routed in that table.",
      "Each VPC subnet route table points the remote CIDR at the gateway or peering connection.",
      "A rollback plan covers both the connection and the routes.",
    ],
  },
  {
    title: "After the change",
    items: [
      "Test every required pair from both directions, not only the new pair.",
      "Check the pair matrix again after adding a VPC or a route table.",
      "Confirm attachment and connection state, then confirm a real packet.",
      "Record the topology, pair matrix, and segmentation intent.",
    ],
  },
];

const references = [
  {
    title: "What is VPC peering?",
    url: "https://docs.aws.amazon.com/vpc/latest/peering/what-is-vpc-peering.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "One-to-one private connections across accounts and Regions.",
  },
  {
    title: "How VPC peering connections work",
    url: "https://docs.aws.amazon.com/vpc/latest/peering/vpc-peering-basics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Lifecycle, route requirements, and the explicit non-transitive limitation.",
  },
  {
    title: "How AWS Transit Gateway works",
    url: "https://docs.aws.amazon.com/vpc/latest/tgw/how-transit-gateways-work.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Attachments, route table association, propagation, and route evaluation.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "peering-topology": {
      model: peeringVsTgwModel,
      presets,
      instructions:
        "Start with the small full mesh, switch the peering layout to a chain, then move the same VPC set onto a transit gateway and add route tables.",
      experimentIds: [experiment.id],
      note: "Illustrative topology model. Route entries and rollout percentages are teaching values, not AWS quotas.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-route-tables",
    "cloud-networking-route-propagation",
    "cloud-networking-cross-account",
    "cloud-networking-ram",
  ],
};
