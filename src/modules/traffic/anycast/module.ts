import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params: ParamSpec[] = [
  {
    id: "advertisedSites",
    label: "Advertising sites",
    min: 2,
    max: 6,
    step: 1,
    value: 4,
    unit: " PoPs",
    group: "Topology",
    help: "Locations that advertise the same anycast prefix. The model spreads traffic evenly across them until a BGP change moves one site's share.",
    format: "count",
  },
  {
    id: "siteCapacity",
    label: "Capacity per site",
    min: 10_000,
    max: 200_000,
    step: 10_000,
    value: 100_000,
    unit: " rps",
    group: "Capacity",
    help: "Illustrative serving capacity of each point of presence. Anycast distributes traffic but does not create capacity at the site BGP chooses.",
    format: "rps",
  },
  {
    id: "bgpShift",
    label: "BGP shift (share of one site's traffic)",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Routing",
    help: "Share of one site's traffic that moves to the next-best site after a BGP path change. It models a withdrawal or a policy change, not a load balancer.",
    format: "percent",
  },
  {
    id: "requestRate",
    label: "Request rate",
    min: 20_000,
    max: 600_000,
    step: 20_000,
    value: 200_000,
    unit: " rps",
    group: "Traffic",
    help: "Total demand across all users. The model assumes an even initial split, then applies the BGP shift.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

interface Site {
  id: string;
  label: string;
  demand: number;
  capacity: number;
  utilization: number;
  dropped: number;
  health: Health;
}

interface Computed {
  sites: Site[];
  capacity: number;
  requestRate: number;
  base: number;
  moved: number;
  reroutedPercent: number;
  hottest: number;
  dropped: number;
  p99: number;
  shift: number;
}

function compute(p: Params): Computed {
  const advertised = Math.round(Math.min(6, Math.max(2, num(p, "advertisedSites", 4))));
  const capacity = Math.max(10_000, num(p, "siteCapacity", 100_000));
  const shift = clamp(num(p, "bgpShift", 0), 0, 100);
  const requestRate = Math.max(20_000, num(p, "requestRate", 200_000));
  const base = requestRate / advertised;
  const moved = (base * shift) / 100;
  const sites: Site[] = Array.from({ length: advertised }, (_, index) => {
    const demand = index === 0 ? base - moved : index === 1 ? base + moved : base;
    const raw = demand / capacity;
    const utilization = Math.min(100, raw * 100);
    const dropped = Math.max(0, demand - capacity);
    const health: Health = dropped > 0 || raw >= 0.95 ? "crit" : raw >= 0.8 ? "warn" : "ok";
    return {
      id: `pop-${index + 1}`,
      label: `PoP ${index + 1}`,
      demand: Math.max(0, demand),
      capacity,
      utilization,
      dropped,
      health,
    };
  });
  const hottest = Math.max(...sites.map((site) => site.utilization / 100));
  const dropped = sites.reduce((sum, site) => sum + site.dropped, 0);
  const queueing = hottest > 0.7 ? 400 * ((hottest - 0.7) / 0.3) ** 2 : 0;
  return {
    sites,
    capacity,
    requestRate,
    base,
    moved,
    reroutedPercent: (moved / requestRate) * 100,
    hottest,
    dropped,
    p99: dropped > 0 ? 800 : 20 + queueing,
    shift,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const c = compute(p);
  const anycastHealth: Health = c.dropped > 0 || c.hottest >= 0.95 ? "crit" : c.hottest >= 0.8 ? "warn" : "ok";
  const clientHealth: Health = c.dropped > 0 ? "crit" : "ok";
  const nodes = [
    {
      id: "clients",
      label: "Global users",
      kind: "client" as const,
      health: clientHealth,
      sublabel: `${formatCount(c.requestRate)} rps · one address`,
      detail:
        "Users connect to the same anycast address. The internet, not DNS or a central load balancer, chooses which site receives each connection.",
      meta: { view: "flow" },
    },
    {
      id: "anycast",
      label: "Anycast prefix",
      kind: "dns" as const,
      health: anycastHealth,
      utilization: clamp(c.hottest),
      sublabel: `same IP at ${c.sites.length} sites`,
      detail:
        c.shift > 0
          ? `A BGP change moved ${c.shift.toFixed(0)}% of PoP 1's traffic. PoP 2 now carries ${formatCount(c.sites[1]?.demand ?? 0)} rps against ${formatCount(c.capacity)} rps of capacity.`
          : `Traffic is spread across ${c.sites.length} sites at about ${formatCount(c.base)} rps each. BGP still chooses the path per client; this is a teaching distribution.`,
      meta: { view: "flow" },
    },
    ...c.sites.map((site) => ({
      id: site.id,
      label: site.label,
      kind: "service" as const,
      health: site.health,
      utilization: clamp(site.utilization / 100),
      throughput: site.demand,
      sublabel: `${formatCount(site.demand)} rps · ${site.utilization.toFixed(0)}%`,
      detail:
        site.dropped > 0
          ? `${site.label} receives ${formatCount(site.demand)} rps against ${formatCount(site.capacity)} rps of illustrative capacity. About ${formatCount(site.dropped)} rps are dropped.`
          : `${site.label} receives ${formatCount(site.demand)} rps against ${formatCount(site.capacity)} rps of illustrative capacity.`,
      meta: { view: "flow" },
    })),
  ];
  return {
    t: 0,
    nodes,
    edges: [
      edge("clients-anycast", "clients", "anycast", 1, clientHealth),
      ...c.sites.map((site) =>
        edge(`anycast-${site.id}`, "anycast", site.id, site.demand / Math.max(1, c.requestRate), site.health),
      ),
    ],
    metrics: [
      metric("hottest-pop-utilization", "Hottest PoP utilization", c.hottest * 100, "%", 80, 95, "percent"),
      metric("dropped-requests", "Dropped requests", c.dropped, " /s", 1_000, 10_000, "rps"),
      metric("rerouted-traffic", "Traffic moved by BGP", c.reroutedPercent, "%", 10, 40, "percent"),
      metric("p99", "PoP p99", c.p99, "ms", 150, 400, "ms"),
      metric("active-sites", "Advertising sites", c.sites.length, " PoPs", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, shift: c.shift },
    summary: `${c.sites.length} sites, ${formatCount(c.base)} rps each; BGP moved ${c.reroutedPercent.toFixed(0)}% of total traffic; hottest PoP ${(c.hottest * 100).toFixed(0)}%; ${formatCount(c.dropped)} rps dropped.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hottest-pop-utilization",
    metricId: "hottest-pop-utilization",
    warn: 80,
    crit: 95,
    title: "One anycast site is carrying most of the load",
    cause:
      "BGP selected the same site for a large share of clients. Anycast spreads traffic only as far as routing spreads it; it is not a global load balancer with per-site weights.",
    fix:
      "Add capacity at the hot site, change the routing policy to steer some prefixes elsewhere, or withdraw the advertisement only when another site can absorb the traffic. Verify the next site has headroom first.",
    checkFirst: [
      "Compare per-site ingress with the BGP path each prefix is using.",
      "Check whether a route withdrawal or policy change preceded the shift.",
      "Confirm the other sites are healthy and have capacity before moving traffic.",
    ],
  },
  {
    id: "dropped-requests",
    metricId: "dropped-requests",
    warn: 1_000,
    crit: 10_000,
    title: "An anycast site is dropping requests",
    cause:
      "The site selected by BGP received more traffic than it can serve. The other sites may be idle because routing did not move their clients.",
    fix:
      "Shift traffic away from the hot site, add capacity, or reduce the request rate. Anycast does not rebalance per request; the path decision is made before the request reaches the site.",
    checkFirst: [
      "Read per-site request rate and capacity, not the global total.",
      "Check for a recent BGP withdrawal or path change.",
      "Check whether the hot site is also the closest site for most users.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 150,
    crit: 400,
    title: "Queueing at the selected PoP",
    cause:
      "The hot site is in the nonlinear part of its capacity curve. Requests may still complete, but the tail grows quickly as utilization approaches the limit.",
    fix:
      "Reduce the load on the site, add capacity, or steer clients elsewhere before the site reaches saturation. Check the next site's capacity as part of the same change.",
    checkFirst: [
      "Compare p99 at each PoP, not only the global p99.",
      "Check whether the tail is isolated to one client region.",
      "Check for retries that amplify the load on the hot site.",
    ],
  },
];

export const anycastModel: SimModel = {
  id: "traffic-anycast",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    for (const item of frame.metrics) frame.series[item.id] = [item.value];
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const c = compute(p);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = Object.fromEntries(Object.entries(frame.series).map(([id, values]) => [id, [...values]]));
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags, paramsKey: key };
    if (c.shift > 0 && frame.flags.shiftLogged !== 1) {
      pushEvent(next, {
        id: "bgp-shift",
        severity: "warn",
        title: "BGP change moved traffic to one site",
        detail: `${c.shift.toFixed(0)}% of PoP 1's share moved to PoP 2. The other sites keep their traffic; anycast does not rebalance the whole network.`,
        nodeId: "anycast",
        metricId: "rerouted-traffic",
      });
      next.flags.shiftLogged = 1;
    }
    if (c.shift === 0) next.flags.shiftLogged = 0;
    if (c.dropped > 0 && frame.flags.dropLogged !== 1) {
      pushEvent(next, {
        id: "pop-overloaded",
        severity: "crit",
        title: "Selected PoP is over capacity",
        detail: `${formatCount(c.dropped)} rps are dropped at the hot site. The capacity exists elsewhere, but BGP did not send those clients there.`,
        nodeId: "anycast",
        metricId: "dropped-requests",
      });
      next.flags.dropLogged = 1;
    }
    if (c.dropped === 0) next.flags.dropLogged = 0;
    next.metrics = next.metrics.map((item) => {
      if (item.id === "dropped-requests" && item.value > 0) {
        return { ...item, value: Math.max(0, item.value * (1 + rng.between(-0.003, 0.003))) };
      }
      if (item.id === "p99" && item.value > 20) {
        return { ...item, value: Math.max(20, item.value * (1 + rng.between(-0.002, 0.002))) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.shift = c.shift;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `The prefix is advertised from ${c.sites.length} sites. Before the BGP change, each would receive about ${formatCount(c.base)} rps; BGP decides the actual path per client, not a central load balancer.`,
    );
    items.push(
      c.shift > 0
        ? `A change covering ${c.shift.toFixed(0)}% of PoP 1's traffic moved ${formatCount(c.moved)} rps, or ${c.reroutedPercent.toFixed(0)}% of total demand, to PoP 2.`
        : "No BGP change is applied. The even split is a teaching baseline; real anycast paths are uneven because routing policy and network topology are uneven.",
    );
    items.push(
      `The hottest site is at ${(c.hottest * 100).toFixed(0)}% utilization. ${c.dropped > 0 ? `${formatCount(c.dropped)} rps are dropped even though other sites may have idle capacity.` : "All demand fits at the selected sites."}`,
    );
    if (c.shift > 0) {
      items.push(
        "Withdrawing the prefix from the hot site would move its clients again. Confirm the next site has capacity before using withdrawal as a mitigation.",
      );
    }
    items.push(
      "Anycast is per direction. The return path can use a different route and a different site, which matters for stateful firewalls and for diagnosing where packets are lost.",
    );
    items.push("BGP path selection is based on route attributes and policy, not on geographic distance alone. The closest site often wins, but it is not guaranteed.");
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
    description: "Four sites advertise the prefix and share 200k rps evenly at 50% capacity.",
    tone: "ok",
    params: defaults({ advertisedSites: 4, siteCapacity: 100_000, bgpShift: 0, requestRate: 200_000 }),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Four sites carry 320k rps at 80% of their illustrative capacity. No BGP change yet.",
    tone: "warn",
    params: defaults({ advertisedSites: 4, siteCapacity: 100_000, bgpShift: 0, requestRate: 320_000 }),
  },
  {
    id: "failure",
    label: "BGP shift",
    description: "Two sites carry 200k rps; all of one site's traffic moves to the other, which has 120k capacity.",
    tone: "crit",
    params: defaults({ advertisedSites: 2, siteCapacity: 120_000, bgpShift: 100, requestRate: 200_000 }),
  },
  {
    id: "partial-withdrawal",
    label: "Partial withdrawal",
    description: "A routing change moves half of one site's traffic to a site with little headroom.",
    tone: "crit",
    params: defaults({ advertisedSites: 3, siteCapacity: 110_000, bgpShift: 50, requestRate: 240_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Four sites with balanced paths and enough capacity for the full request rate.",
    tone: "ok",
    params: defaults({ advertisedSites: 4, siteCapacity: 100_000, bgpShift: 0, requestRate: 200_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-bgp-shift",
  title: "Predict what a BGP change does to the hot site",
  simId: "anycast",
  question:
    "Three sites advertise one anycast prefix. A BGP change withdraws one site, and its traffic moves to the next-best site. What happens to that site?",
  prediction: {
    options: [
      { id: "overload", label: "It can overload; the other sites do not automatically absorb the extra traffic." },
      { id: "rebalance", label: "The anycast network rebalances all traffic evenly across the remaining sites." },
      { id: "drop-prefix", label: "The prefix is withdrawn everywhere and all users lose connectivity." },
      { id: "dns", label: "DNS TTL delays the change until every client cache expires." },
    ],
    correctOptionId: "overload",
    explanation:
      "Anycast routes each client to a site through BGP. When a site stops advertising, the routers that used it choose the next-best path, which is often one specific site. The other sites keep their existing clients. There is no global load balancer to rebalance the whole network.",
  },
  setup: defaults({ advertisedSites: 3, siteCapacity: 100_000, bgpShift: 100, requestRate: 300_000 }),
  runFor: 20,
  observe: [
    "The withdrawn site drops to zero; the next-best site receives its full share.",
    "The hot site carries 200k rps against 100k capacity and drops 100k rps.",
    "The third site remains at 100k rps and does not absorb the difference.",
    "Global p99 reaches the model's 800ms cap while the hot site is over capacity.",
  ],
  explain:
    "BGP chooses a path per destination prefix and per client network. Withdrawing one advertisement moves the affected clients to the best remaining path, not to an even share of every remaining site. If that path lands on a site without headroom, the site drops traffic. The anycast address is still reachable; the problem is capacity at the site the routing chose.",
  fix: defaults({ advertisedSites: 5, siteCapacity: 150_000, bgpShift: 20, requestRate: 300_000 }),
  debrief:
    "Five sites with 150k capacity each absorb 300k rps at 60k per site, and a 20% shift leaves the hot site at 72k, well below capacity. The tradeoff is more sites to run and more advertisements to manage. Anycast improves resilience only when the sites behind the address have enough capacity for the paths that can land on them.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Anycast is an addressing method: the same IP prefix is advertised from multiple locations. A client sends a packet to one address, and the internet's routing system chooses one of those locations. The client does not know which one. The decision is made by Border Gateway Protocol (BGP), which selects a path from the routes it learns, based on attributes and policy rather than a central load balancer.",
  },
  {
    type: "p",
    text: "BGP chooses a path from the routes it learns, using attributes such as AS-path length and local preference. A nearby site often wins because nearby networks tend to offer a shorter path, but proximity is not the rule. A route withdrawal, an AS-path change, or a local-preference change can move a large set of clients from one site to another. The other sites do not automatically absorb the difference; they keep the clients already routed to them.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "Anycast sits below DNS. A name can resolve to the same address for everyone, and the routing system chooses the site. That is different from a DNS policy that returns different addresses by location. It is also different from a load balancer that sees every request and chooses a backend. With anycast, there is no global request counter and no per-request rebalancing.",
  },
  {
    type: "compare",
    leftTitle: "Anycast",
    rightTitle: "Global load balancer or DNS steering",
    rows: [
      { label: "Decision point", left: "BGP route selection before the packet reaches a site", right: "A load balancer or DNS answer before the connection" },
      { label: "Visibility", left: "The site sees only the clients routed to it", right: "The entry point can see the whole fleet" },
      { label: "Rebalance", left: "Only when routing changes", right: "Per request or per DNS answer" },
      { label: "Failure mode", left: "A route change concentrates traffic on one site", right: "The entry point becomes a dependency or a bottleneck" },
    ],
  },
  {
    type: "p",
    text: "Points of presence (PoPs) are the sites that advertise the prefix. A site can be a CDN edge, a scrubbing center, or a regional service. The same address can be served from all of them, but a connection is anchored to the site the route selected; if the path changes mid-connection, TCP may break or retransmit.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A single anycast address with several advertising sites.",
      "Per-site demand and utilization before and after a BGP shift.",
      "Dropped requests at the hot site while other sites have idle capacity.",
      "Global p99 and the share of total traffic moved by the routing change.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and note the per-site split. Apply BGP shift and compare per-site load before and after. Run the experiment before reading its explanation, then apply Recovery and compare the same demand.",
  },
  {
    type: "p",
    text: "The model's even baseline is a teaching simplification. Real anycast traffic is uneven because BGP policy, peering, and network topology are uneven. The failure mode is the same: a routing change moves traffic in bulk, and capacity is per site.",
  },
  { type: "sim", simId: "anycast" },
  { type: "experiment", experimentId: "predict-bgp-shift" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One site stopped advertising, and the clients that used it were routed to the next-best path. That path landed on a single site, which received its existing share plus the withdrawn share. The third site kept its clients and did not help. The anycast address stayed reachable, but the hot site dropped requests.",
  },
  {
    type: "p",
    text: "Adding sites and capacity fixed the immediate problem, and reducing the shift lowered the concentration. The address did not change; the routing and the capacity behind it did. That is the core anycast tradeoff: a simple global entry point with a coarse, path-based distribution.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Per-PoP ingress and egress rates, interface utilization, and drops from flow telemetry or network metrics.",
      "BGP messages and route changes from monitoring (BMP or a looking glass), plus the time of the change.",
      "Synthetic probes from many networks, not one vantage point, to see which site each region reaches.",
      "TCP resets, retransmits, and connection failures during a path change.",
      "DDoS alerts and scrubbing capacity per site; anycast distributes an attack but does not create capacity.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check per-site load, not the global total. Then check whether a BGP change preceded it. If one site is hot while others are idle, the problem is routing and capacity placement, not the anycast address itself.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the hot site and the route change that sent traffic there.",
      "Confirm the other sites are healthy and have headroom before moving traffic.",
      "Add capacity at the hot site or steer specific prefixes with routing policy.",
      "Use a controlled withdrawal only when the next-best site can absorb the share.",
      "Watch for asymmetric return paths and stateful devices that can drop the response.",
      "Test the failover from multiple networks and measure per-site latency, not only the global average.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Anycast gives one address and natural DDoS distribution, but routing changes are coarse and can concentrate traffic.",
      "It avoids a central load balancer, but each site must be sized for the share routing can send it.",
      "It reduces latency for many users, but BGP does not guarantee the closest site.",
      "It supports connectionless and short-lived traffic well; long-lived TCP connections can break when the path changes.",
      "Per-site observability is harder because no single component sees the whole request population.",
      "Route leaks and hijacks are a shared internet risk; monitoring BGP is part of operating anycast.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "explain-anycast",
    question:
      "Users around the world hit one IP address but land in different regions. How does that work, and what makes it fail?",
    difficulty: 3,
    hints: [
      "The address is the same; the route is not.",
      "There is no central load balancer.",
    ],
    answer:
      "The address is advertised from multiple sites with BGP. Each network chooses one route for that prefix, usually a nearby one, so different users reach different sites even though they use the same IP. The client never learns which site it reached. The failure mode is that routing is coarse: a withdrawal or policy change moves a large set of clients to the next-best path, and that site may not have the capacity. There is no global load balancer to rebalance per request, and return traffic can take a different path. I would monitor per-site ingress, BGP changes, and capacity headroom, and test from many networks.",
    followUps: [
      "What happens to an established TCP connection when the route changes?",
      "How is anycast different from DNS round-robin?",
      "Why is per-site capacity planning more important than a global average?",
    ],
    redFlags: [
      "Says anycast is a global load balancer.",
      "Assumes BGP always chooses the geographically closest site.",
      "Ignores per-site capacity and return-path asymmetry.",
    ],
    rubric: [
      "Explains same prefix from multiple sites.",
      "Names BGP path selection.",
      "States the concentration failure mode.",
      "Mentions per-site capacity and monitoring.",
    ],
  },
  {
    id: "bgp-shift-mitigation",
    question:
      "A BGP change sends a large share of users to one PoP and its latency and drops spike. How do you respond?",
    difficulty: 4,
    hints: [
      "First confirm the routing change and the hot site.",
      "Withdrawing the prefix moves traffic again.",
    ],
    answer:
      "I would confirm the hot site from per-PoP ingress and check for a recent BGP withdrawal or policy change. Then I would verify whether the other sites have headroom before moving anything. Immediate options are to add capacity at the hot site, steer some prefixes with routing policy, or rate-limit non-critical traffic. Withdrawing the advertisement is a last resort because it moves the same clients to another site and can repeat the problem. I would watch return-path asymmetry and stateful devices, because the forward and return paths may differ. After stabilization I would add headroom and a routing-change test to the game day.",
    followUps: [
      "How would you steer only one region's traffic?",
      "What would make you prefer a DNS or Global Accelerator front door?",
      "How do you detect asymmetry from telemetry?",
    ],
    redFlags: [
      "Withdraws the prefix without checking the next site.",
      "Looks only at global utilization.",
      "Assumes the forward and return paths are symmetric.",
    ],
    rubric: [
      "Confirms the hot site and the route change.",
      "Checks other-site headroom.",
      "Chooses a controlled steering or capacity fix.",
      "Accounts for asymmetry and follow-up testing.",
    ],
  },
  {
    id: "anycast-ddos",
    question:
      "How does anycast help during a DDoS attack, and what does it not solve?",
    difficulty: 3,
    hints: [
      "Distribution is not the same as filtering.",
      "Capacity still matters at each site.",
    ],
    answer:
      "Anycast spreads the attack across the sites that advertise the prefix, so no single origin receives the whole volume. That gives the network more aggregate surface area and can keep the attack farther from the origin. It does not filter the traffic by itself, and it does not create capacity. If the attack concentrates on one site, or if the aggregate volume exceeds the sites' capacity, users still suffer. I would pair anycast with DDoS mitigation, rate controls, and per-site capacity and monitoring. I would also watch for attacks that target the routing layer or a specific PoP.",
    followUps: [
      "Where does scrubbing fit in an anycast network?",
      "What is the difference between absorbing and filtering an attack?",
      "How would you detect a attack concentrated on one PoP?",
    ],
    redFlags: [
      "Says anycast filters the attack automatically.",
      "Assumes the attack is evenly distributed.",
      "Ignores per-site capacity.",
    ],
    rubric: [
      "Explains distribution across sites.",
      "Separates distribution from filtering.",
      "Names per-site capacity and monitoring.",
      "Adds a mitigation control.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document every site that advertises the prefix and the capacity behind it.",
      "Monitor per-site ingress, egress, utilization, and drops.",
      "Monitor BGP route changes and keep a looking glass or BMP feed.",
      "Test reachability and latency from many networks, not one location.",
      "Plan how to steer or withdraw a prefix without overloading the next site.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Identify the hot site and the route change that sent traffic there.",
      "Check the other sites' headroom before moving traffic.",
      "Add capacity or steer a subset of prefixes; avoid a blind withdrawal.",
      "Watch return-path asymmetry and stateful middleboxes.",
      "Record the time of the BGP change and the per-site impact.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify per-site capacity and headroom at peak.",
      "Review whether the routing policy produced the intended distribution.",
      "Add a game day that withdraws a site and measures the next-best path.",
      "Update the capacity plan for the share each site can receive.",
    ],
  },
];

const references = [
  {
    title: "What is Anycast? How does Anycast work?",
    url: "https://www.cloudflare.com/learning/cdn/glossary/anycast-network/",
    publisher: "Cloudflare",
    kind: "docs" as const,
    note: "Same address from multiple locations, routing to a nearby site, and DDoS distribution.",
  },
  {
    title: "How AWS Global Accelerator works",
    url: "https://docs.aws.amazon.com/global-accelerator/latest/dg/introduction-how-it-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Static IP addresses anycast from the AWS edge network and health-checked regional endpoints.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    anycast: {
      model: anycastModel,
      presets,
      instructions:
        "Start Healthy and note the per-site split. Apply BGP shift: the hot site exceeds capacity while the third site stays idle. Use the experiment, then apply Recovery or add sites and capacity.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Anycast, BGP path selection, and per-site capacity are real concepts; the even baseline split, per-site capacity values, p99 curve, and 800ms cap are teaching values. Real anycast distributions are uneven and depend on routing policy.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-route53-routing",
    "traffic-ddos-shield",
    "traffic-global-accelerator",
    "traffic-dns-ttl-failover",
  ],
};
