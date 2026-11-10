import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const QPS_PER_IP = 10_000;

const params = [
  {
    id: "inboundAzs",
    label: "Inbound endpoint IPs (0–3)",
    min: 0,
    max: 3,
    step: 1,
    value: 2,
    unit: "",
    group: "Inbound",
    help: "Number of inbound endpoint IP addresses. In this model, one per selected Availability Zone. On-premises DNS forwards private-zone queries to these addresses. 0 means there is no inbound path.",
    format: "count" as const,
  },
  {
    id: "forwardMode",
    label: "On-prem forwarder (0 missing, 1 conditional, 2 loop)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Inbound",
    help: "0 sends private-zone queries to public DNS instead of the inbound endpoint. 1 forwards them to the inbound endpoint IPs. 2 forwards them back into the same resolution path and creates a loop.",
    format: "count" as const,
  },
  {
    id: "zoneAssociated",
    label: "Private zone associated with the VPC",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Zone",
    help: "1 associates the private hosted zone with the VPC that contains the inbound endpoint. 0 lets the Resolver answer from public DNS or return NXDOMAIN.",
    format: "count" as const,
  },
  {
    id: "queryRate",
    label: "On-premises query rate",
    min: 1_000,
    max: 30_000,
    step: 1_000,
    value: 4_000,
    unit: " qps",
    group: "Traffic",
    help: "Illustrative UDP DNS queries per second from the on-premises resolver. AWS documents up to 10,000 UDP queries per second per endpoint IP address.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  inboundAzs: number;
  forwardMode: number;
  zoneAssociated: boolean;
  queryRate: number;
  capacity: number;
  effectiveQueries: number;
  delivered: number;
  resolution: number;
  failureRate: number;
  timeouts: number;
  utilization: number;
  clientHealth: Health;
  onPremHealth: Health;
  inboundHealth: Health;
  resolverHealth: Health;
  zoneHealth: Health;
}

function compute(p: Params): Computed {
  const inboundAzs = Math.max(0, Math.min(3, Math.round(num(p, "inboundAzs", 2))));
  const forwardMode = Math.max(0, Math.min(2, Math.round(num(p, "forwardMode", 1))));
  const zoneAssociated = num(p, "zoneAssociated", 1) >= 0.5;
  const queryRate = Math.max(1, num(p, "queryRate", 4_000));
  const capacity = inboundAzs * QPS_PER_IP;
  const loop = forwardMode === 2;
  const effectiveQueries = loop ? queryRate * 2 : queryRate;
  const forwarding = forwardMode === 1;
  const canAnswer = inboundAzs > 0 && forwarding && zoneAssociated && !loop;
  const delivered = canAnswer ? Math.min(queryRate, capacity) : 0;
  const resolution = canAnswer ? clamp((delivered / queryRate) * 100, 0, 100) : 0;
  const timeouts = loop ? 100 : inboundAzs === 0 || !forwarding ? 100 : queryRate > capacity ? clamp((1 - capacity / queryRate) * 100, 0, 100) : 0;
  const utilization = capacity > 0 ? clamp((effectiveQueries / capacity) * 100, 0, 100) : 0;
  return {
    inboundAzs,
    forwardMode,
    zoneAssociated,
    queryRate,
    capacity,
    effectiveQueries,
    delivered,
    resolution,
    failureRate: clamp(100 - resolution, 0, 100),
    timeouts,
    utilization,
    clientHealth: resolution >= 95 ? "ok" : resolution > 0 ? "warn" : "crit",
    onPremHealth: forwardMode === 0 || loop ? "crit" : "ok",
    inboundHealth: inboundAzs === 0 ? "down" : utilization >= 90 ? "crit" : utilization >= 50 || loop ? "warn" : "ok",
    resolverHealth: loop ? "crit" : "ok",
    zoneHealth: zoneAssociated ? "ok" : "down",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 22;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 7)) / 2.4);
  const rows: [string, number, number][] = [
    ["resolution", values.resolution, 0],
    ["resolution-failure", values.failureRate, 0],
    ["timeouts", values.timeouts, 0],
    ["inbound-utilization", values.utilization, 1.2],
    ["resolver-queries", values.effectiveQueries, 30],
    ["resolver-capacity", values.capacity, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "resolution" || id === "resolution-failure" || id === "timeouts" || id === "resolver-capacity"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function stateLabel(values: Computed): string {
  if (values.inboundAzs === 0) return "no inbound endpoint";
  if (values.forwardMode === 0) return "on-prem forwarder missing";
  if (values.forwardMode === 2) return "forwarding loop";
  if (!values.zoneAssociated) return "private zone not associated";
  if (values.resolution < 99.95) return "inbound endpoint saturated";
  return "hybrid resolution working";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "on-premises client",
        kind: "service",
        health: v.clientHealth,
        sublabel: `${formatCount(v.queryRate)} qps`,
        detail: `The client asks its local DNS server for a name in the private hosted zone. ${formatPercent(
          v.resolution,
        )}% of those queries resolve in this state.`,
        meta: { view: "flow" },
      },
      {
        id: "onprem-dns",
        label: "on-premises DNS",
        kind: "dns",
        health: v.onPremHealth,
        sublabel:
          v.forwardMode === 0
            ? "no forwarder"
            : v.forwardMode === 1
              ? "forward to inbound IPs"
              : "forward loop",
        detail:
          v.forwardMode === 0
            ? "The on-premises server has no conditional forwarder for the private zone. It sends the query to public DNS, which does not know the private records."
            : v.forwardMode === 1
              ? "A conditional forwarder points the private zone at the inbound endpoint IP addresses. The on-premises server must be able to reach those addresses over VPN or Direct Connect."
              : "The on-premises server forwards the private zone back into the same resolution path. The query circulates until it times out instead of reaching a resolver that can answer it.",
        meta: { view: "flow" },
      },
      {
        id: "inbound",
        label: "inbound endpoint",
        kind: "dns",
        health: v.inboundHealth,
        utilization: v.utilization / 100,
        throughput: v.inboundAzs > 0 ? v.effectiveQueries : 0,
        capacity: v.capacity,
        sublabel: v.inboundAzs === 0 ? "not configured" : `${v.inboundAzs} IP${v.inboundAzs === 1 ? "" : "s"} · ${formatCount(v.capacity)} qps`,
        detail:
          v.inboundAzs === 0
            ? "There is no inbound endpoint, so the on-premises network has no private IP address to send queries to. The VPC Resolver at the VPC CIDR plus two address is not reachable from outside the VPC."
            : `Each inbound endpoint IP is backed by an endpoint network interface in one AZ. AWS documents up to 10,000 UDP queries per second per IP address; this endpoint has ${v.inboundAzs} IP${v.inboundAzs === 1 ? "" : "s"}.`,
        meta: { view: "flow" },
      },
      {
        id: "resolver",
        label: "Route 53 Resolver",
        kind: "dns",
        health: v.resolverHealth,
        sublabel: v.forwardMode === 2 ? "loop detected" : "VPC resolution",
        detail:
          v.forwardMode === 2
            ? "The query returns to the same resolution path. A forwarding loop can look like a slow resolver or a timeout; check the rules on both sides for the same domain."
            : "The Resolver answers from the private hosted zone when the zone is associated with this VPC. It also resolves public names and VPC-specific names.",
        meta: { view: "flow" },
      },
      {
        id: "zone",
        label: "private hosted zone",
        kind: "dns",
        health: v.zoneHealth,
        sublabel: v.zoneAssociated ? "associated with VPC" : "not associated",
        detail: v.zoneAssociated
          ? "The private hosted zone is associated with the VPC, so the Resolver can answer for its records. Association is per VPC; another VPC needs its own association or an inbound endpoint."
          : "The private hosted zone is not associated with the VPC that contains the inbound endpoint. The Resolver cannot use it and returns NXDOMAIN or falls back to public DNS.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-dns", "client", "onprem-dns", 1, v.clientHealth),
      edge(
        "dns-inbound",
        "onprem-dns",
        "inbound",
        v.inboundAzs > 0 ? 1 : 0,
        v.onPremHealth === "ok" ? v.inboundHealth : v.onPremHealth,
      ),
      edge("inbound-resolver", "inbound", "resolver", v.inboundAzs > 0 ? 1 : 0, v.inboundHealth),
      edge("resolver-zone", "resolver", "zone", v.zoneAssociated ? 1 : 0, v.zoneHealth),
    ],
    metrics: [
      metric("resolution", "On-premises resolution", v.resolution, "%", undefined, undefined, "percent"),
      metric("resolution-failure", "On-premises resolution failures", v.failureRate, "%", 0.5, 5, "percent"),
      metric("timeouts", "Query timeouts", v.timeouts, "%", 1, 5, "percent"),
      metric("inbound-utilization", "Inbound endpoint utilization", v.utilization, "%", 50, 90, "percent"),
      metric("resolver-queries", "Resolver queries", v.effectiveQueries, " qps", undefined, undefined, "rps"),
      metric("resolver-capacity", "Inbound capacity", v.capacity, " qps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      inboundAzs: v.inboundAzs,
      forwardMode: v.forwardMode,
      zoneAssociated: v.zoneAssociated ? 1 : 0,
    },
    summary: `${formatCount(v.queryRate)} qps from on-premises; ${formatPercent(v.resolution)}% resolved; ${formatCount(
      v.timeouts,
    )}% timeouts; ${stateLabel(v)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "resolution-failure",
    metricId: "resolution-failure",
    warn: 99.5,
    crit: 95,
    title: "On-premises DNS cannot resolve the private hosted zone",
    cause:
      "There is no inbound endpoint, the on-premises forwarder is missing, the private zone is not associated with the VPC, or a forwarding loop prevents an answer.",
    fix:
      "Create an inbound endpoint in the VPC, point the on-premises conditional forwarder at its IP addresses, and associate the private hosted zone with the VPC. Check both sides for a loop before adding more endpoints.",
    checkFirst: [
      "Check whether the on-premises resolver has a conditional forwarder for the zone and which IPs it targets.",
      "Check the inbound endpoint state and its IP addresses.",
      "Check the private hosted zone association with the VPC that holds the inbound endpoint.",
    ],
  },
  {
    id: "timeouts",
    metricId: "timeouts",
    warn: 1,
    crit: 5,
    title: "Hybrid DNS queries are timing out",
    cause:
      "A forwarding loop sends the query back into the same path, or the inbound endpoint has no capacity for the query rate. A missing endpoint or forwarder also produces timeouts or SERVFAIL.",
    fix:
      "Remove the loop by making one side authoritative for the domain, or add inbound endpoint IPs and spread them across AZs. Verify the path with a query from the on-premises resolver.",
    checkFirst: [
      "Check the forwarder rules on the on-premises resolver and the Resolver rules in the VPC for the same domain.",
      "Check the inbound endpoint query volume and the per-IP utilization.",
      "Check the security group and network ACL for UDP and TCP 53 on the endpoint ENIs.",
    ],
  },
  {
    id: "inbound-utilization",
    metricId: "inbound-utilization",
    warn: 50,
    crit: 90,
    title: "The inbound endpoint is approaching its query capacity",
    cause:
      "Each endpoint IP address has a documented ceiling of 10,000 UDP queries per second. The endpoint is above half of that ceiling, where AWS recommends adding network interfaces.",
    fix:
      "Add inbound endpoint IPs in more AZs and update the on-premises forwarder with the new addresses. Watch the per-IP query volume, not only the endpoint total.",
    checkFirst: [
      "Read the per-IP inbound query volume in CloudWatch.",
      "Check whether the on-premises resolver is using every endpoint IP or only one.",
      "Check for a query loop that is multiplying the volume.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const route53ResolverModel: SimModel = {
  id: "cloud-networking-route53-resolver",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousMode = Number(frame.flags.forwardMode ?? -1);
    const previousIps = Number(frame.flags.inboundAzs ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (previousMode !== -1 && previousMode !== v.forwardMode) {
      const loop = v.forwardMode === 2;
      pushEvent(next, {
        id: "resolver-forward-mode-change",
        severity: loop ? "crit" : v.forwardMode === 0 ? "warn" : "info",
        title: loop
          ? "Forwarding loop detected"
          : v.forwardMode === 0
            ? "On-premises forwarder removed"
            : "On-premises forwarder points at the inbound endpoint",
        detail: loop
          ? "The private zone is forwarded back into the same resolution path. Queries time out instead of reaching the private hosted zone."
          : v.forwardMode === 0
            ? "Queries for the private zone go to public DNS, which cannot answer from the private hosted zone."
            : "The conditional forwarder now targets the inbound endpoint IPs. Confirm that the on-premises network can reach every IP over VPN or Direct Connect.",
        nodeId: "onprem-dns",
        metricId: "resolution",
      });
    }
    if (previousIps !== -1 && previousIps !== v.inboundAzs) {
      pushEvent(next, {
        id: "resolver-inbound-ip-change",
        severity: v.inboundAzs === 0 ? "crit" : v.inboundAzs >= 2 ? "info" : "warn",
        title:
          v.inboundAzs === 0
            ? "Inbound endpoint removed"
            : `Inbound endpoint has ${v.inboundAzs} IP${v.inboundAzs === 1 ? "" : "s"}`,
        detail:
          v.inboundAzs === 0
            ? "The on-premises network has no private address to forward queries to. The VPC Resolver address at the VPC CIDR plus two is not reachable from on-premises."
            : `Each IP is an endpoint network interface in one AZ. The endpoint capacity is ${formatCount(
                v.capacity,
              )} UDP qps at the documented 10,000 per IP.`,
        nodeId: "inbound",
        metricId: "inbound-utilization",
      });
    }
    next.summary = `${formatCount(v.queryRate)} qps from on-premises; ${formatPercent(v.resolution)}% resolved; ${formatCount(
      v.timeouts,
    )}% timeouts; ${stateLabel(v)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.inboundAzs === 0) {
      items.push(
        "There is no inbound endpoint. On-premises resolvers cannot use the VPC Resolver address at the VPC CIDR plus two; they need an inbound endpoint's private IP addresses.",
      );
    } else if (v.forwardMode === 0) {
      items.push(
        "The inbound endpoint exists, but the on-premises server has no conditional forwarder for the zone. The query goes to public DNS and never reaches the endpoint.",
      );
    } else if (v.forwardMode === 2) {
      items.push(
        "The query loops between the on-premises forwarder and the Resolver path. A loop consumes capacity and returns no answer; remove one side's forward for the same domain.",
      );
    } else if (!v.zoneAssociated) {
      items.push(
        "The inbound endpoint and forwarder are in place, but the private hosted zone is not associated with the VPC. The Resolver cannot answer from it.",
      );
    } else if (v.resolution < 99.95) {
      items.push(
        `The inbound endpoint is above its capacity: ${formatCount(v.capacity)} qps across ${v.inboundAzs} IP${v.inboundAzs === 1 ? "" : "s"} versus ${formatCount(
          v.queryRate,
        )} qps offered.`,
      );
    } else {
      items.push(
        `The inbound path resolves ${formatCount(v.delivered)} qps. Inbound endpoints serve on-premises-to-VPC queries; outbound endpoints and forwarding rules serve the reverse direction.`,
      );
    }
    items.push(
      "A Resolver rule takes precedence over a private hosted zone for the same domain. If a rule forwards the zone to the network, the private zone records are not used.",
    );
    items.push(
      "Each endpoint IP is an endpoint network interface in one AZ. The documented ceiling is 10,000 UDP queries per second per IP, and AWS recommends adding interfaces above 50% utilization.",
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
    description: "Two inbound endpoint IPs, a conditional forwarder, an associated zone, and 4,000 qps.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "16,000 qps across two inbound IPs, at 80% of the documented per-IP ceiling.",
    tone: "warn",
    params: defaults({ queryRate: 16_000 }),
  },
  {
    id: "failure",
    label: "No inbound endpoint",
    description: "The on-premises forwarder points at an endpoint that does not exist, so every query times out.",
    tone: "crit",
    params: defaults({ inboundAzs: 0, forwardMode: 1, zoneAssociated: 1, queryRate: 4_000 }),
  },
  {
    id: "loop",
    label: "Forwarding loop",
    description: "The on-premises server forwards the zone back into the same path. Queries time out and consume endpoint capacity.",
    tone: "crit",
    params: defaults({ inboundAzs: 2, forwardMode: 2, zoneAssociated: 1, queryRate: 8_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The inbound endpoint is restored and the forwarder points at its IPs again.",
    tone: "ok",
    params: defaults({ inboundAzs: 2, forwardMode: 1, zoneAssociated: 1, queryRate: 4_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-missing-inbound",
  title: "The private zone that stopped answering",
  simId: "hybrid-dns",
  question:
    "The on-premises DNS server has a conditional forwarder for orders.internal pointing at an inbound endpoint's old private IPs. The endpoint was deleted and never recreated. What happens to the queries?",
  prediction: {
    options: [
      { id: "vpc-plus-two", label: "They fall back to the VPC Resolver at the VPC CIDR plus two." },
      { id: "public", label: "They resolve from the public hosted zone automatically." },
      { id: "timeout", label: "They time out or return SERVFAIL because the target IPs no longer answer." },
      { id: "outbound", label: "They use an outbound endpoint instead." },
    ],
    correctOptionId: "timeout",
    explanation:
      "The on-premises resolver sends the query to the old private IPs. Those endpoint network interfaces are gone, so nothing answers. The VPC CIDR plus two address is only reachable inside the VPC, and an outbound endpoint serves the reverse direction. The forwarder must be updated when the inbound endpoint is recreated with new IPs.",
  },
  setup: defaults({ inboundAzs: 0, forwardMode: 1, zoneAssociated: 1, queryRate: 4_000 }),
  runFor: 15,
  observe: [
    "On-premises resolution is 0% and query timeouts are 100%.",
    "The inbound endpoint node is unavailable; the on-premises DNS node is still running but has no target.",
    "The private hosted zone and the VPC association can be healthy without making the query work.",
    "Recreating the inbound endpoint with new IPs requires updating the on-premises forwarder.",
    "An outbound endpoint would not help this direction.",
  ],
  explain:
    "The inbound endpoint is the only private path from the on-premises network into the VPC Resolver. Its IPs belong to endpoint network interfaces, so deleting the endpoint removes them. The on-premises forwarder keeps sending to addresses that no longer exist. The fix is to recreate the inbound endpoint, update the forwarder with the new IPs, and confirm the on-premises network can reach them over VPN or Direct Connect.",
  fix: defaults({ inboundAzs: 2, forwardMode: 1, zoneAssociated: 1, queryRate: 4_000 }),
  debrief:
    "The private hosted zone and the Resolver were both healthy. The missing piece was the inbound endpoint, which is the address on the on-premises side of the hybrid path. In production, treat the endpoint IPs as part of the forwarder configuration and update both together.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Route 53 Resolver, now called Route 53 VPC Resolver, is the Domain Name System (DNS) resolver that every virtual private cloud (VPC) gets by default. It answers queries for public names, VPC-specific names, and records in Route 53 private hosted zones. Inside a VPC, instances reach it at the VPC CIDR plus two address, such as 10.0.0.2. That address is not reachable from outside the VPC, which is why hybrid DNS needs an endpoint.",
  },
  {
    type: "p",
    text: "An inbound Resolver endpoint gives the on-premises network private IP addresses to forward queries to. You create the endpoint in subnets in one or more Availability Zones, and each IP address is backed by an endpoint network interface. An on-premises DNS server then has a conditional forwarder for the private zone that points at those IPs, over virtual private network (VPN) or Direct Connect.",
  },
  {
    type: "p",
    text: "An outbound Resolver endpoint and a forwarding rule serve the other direction: a VPC workload queries an on-premises name, the Resolver matches a rule for that domain, and the query leaves through the outbound endpoint to the on-premises resolver. Inbound and outbound endpoints are separate resources even when they sit in the same VPC. A common design creates both, with separate rules for each direction.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The inbound path is on-premises client, on-premises DNS, conditional forwarder, inbound endpoint IP, VPC Resolver, private hosted zone. The zone must be associated with the VPC that contains the inbound endpoint. The endpoint's security group must allow UDP and TCP 53 from the on-premises network, and the network path over VPN or Direct Connect must be healthy.",
  },
  {
    type: "table",
    headers: ["Direction", "Resource", "What it does", "Typical failure"],
    rows: [
      ["On-premises to VPC", "Inbound endpoint", "Gives on-premises DNS private IPs to forward to.", "No endpoint, stale forwarder IPs, or blocked port 53."],
      ["VPC to on-premises", "Outbound endpoint and rule", "Forwards matching domains to on-premises resolvers.", "Rule missing, not associated, or wrong target IPs."],
      ["Within the VPC", "VPC Resolver", "Answers public, VPC, and private-zone queries.", "Zone not associated with the VPC."],
      ["Any direction", "Forwarding rules", "Choose the most specific matching rule.", "Loop when both sides forward the same domain."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Inbound endpoint",
    rightTitle: "Outbound endpoint",
    rows: [
      { label: "Query direction", left: "On-premises resolver to VPC Resolver.", right: "VPC Resolver to on-premises resolver." },
      { label: "Configured by", left: "Private IPs in VPC subnets; on-premises forwarder targets them.", right: "A Resolver rule with the domain and target IPs." },
      { label: "Typical use", left: "On-premises workloads resolve private hosted zone names.", right: "VPC workloads resolve on-premises names." },
      { label: "Failure clue", left: "Public names work on-premises; private names time out.", right: "VPC names resolve; on-premises names time out or return NXDOMAIN." },
    ],
  },
  {
    type: "p",
    text: "A loop is the failure that looks like a capacity problem. If the on-premises resolver forwards orders.internal to the inbound endpoint and a Resolver rule forwards the same domain back to the on-premises resolver, the query circulates until it times out. Each side sees traffic, so neither looks idle; the query logs show repeated attempts and no answer. Make one side authoritative for the domain and remove the other forward.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Inbound endpoint IP count, the on-premises forwarder mode, and the private zone association.",
      "On-premises resolution and query timeouts, measured from the client's perspective.",
      "Inbound endpoint utilization against the documented 10,000 UDP queries per second per IP.",
      "A forwarding-loop mode that raises query volume and removes the answer.",
      "Presets for a healthy endpoint, peak query rate, a missing endpoint, a loop, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and follow the query from the on-premises client to the private zone. Apply No inbound endpoint: the forwarder still points somewhere, but nothing answers. Then try Forwarding loop and compare the query volume with the healthy case. Raise the query rate at peak to see the per-IP ceiling. Run the experiment before revealing its explanation.",
  },
  {
    type: "p",
    text: "The query rate is an illustrative input. The 10,000 UDP queries per second per endpoint IP is a documented Route 53 Resolver quota, and the 50% utilization guidance for adding interfaces comes from AWS. The private zone, endpoint, and forwarder behavior follows the Route 53 Resolver documentation.",
  },
  { type: "sim", simId: "hybrid-dns" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With an inbound endpoint and a forwarder that pointed at it, the on-premises client resolved the private zone. The Resolver answered because the zone was associated with the VPC, and the endpoint stayed below the per-IP ceiling. Each layer was necessary: endpoint, forwarder, association, and capacity.",
  },
  {
    type: "p",
    text: "Removing the inbound endpoint broke every query even though the forwarder and the private zone were unchanged. The forwarder sent queries to private addresses that no longer existed. The VPC Resolver address at the VPC CIDR plus two did not help, because it is only reachable from inside the VPC.",
  },
  {
    type: "p",
    text: "The loop preset produced a different signal. The endpoint and the zone were healthy, but queries circulated between the two DNS systems. Timeouts rose and the endpoint carried more queries than the client offered. That extra volume is the clue: a forwarding loop consumes capacity without producing answers.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Inbound endpoint state and IPs: each IP is an endpoint network interface in a specific AZ. On-premises forwarders must target those addresses.",
      "Resolver rules: a rule forwards a domain to target IPs and must be associated with the VPC. A rule takes precedence over a private hosted zone for the same domain.",
      "Private hosted zone association: the zone must be associated with the VPC that contains the inbound endpoint. Association is per VPC.",
      "Query logs: Resolver query logging shows the queried name, source, and response. Repeated queries with no answer suggest a loop or a dead forwarder.",
      "CloudWatch: InboundQueryVolume and OutboundQueryVolume, plus per-IP metrics. Compare the per-IP rate with the documented 10,000 UDP qps ceiling.",
      "Security groups: the endpoint network interfaces need UDP and TCP 53 from the on-premises network. A blocked port looks like a timeout, not an NXDOMAIN.",
      "Routing: the on-premises network needs a route to the endpoint IPs over VPN or Direct Connect, and the return path must exist.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the on-premises forwarder and the inbound endpoint IPs together. A forwarder that points at a deleted endpoint is the most common hybrid DNS break. Then check the private zone association and the endpoint security group. Only then look at capacity; a loop can look like capacity because it multiplies the query volume.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the direction of the failing query: on-premises to VPC needs an inbound endpoint, and VPC to on-premises needs an outbound endpoint and a rule.",
      "Recreate or repair the inbound endpoint and record its new IP addresses.",
      "Update the on-premises conditional forwarder to the current endpoint IPs.",
      "Confirm the private hosted zone is associated with the VPC that contains the endpoint.",
      "Check the endpoint security group and the network ACL for UDP and TCP 53 in both directions.",
      "Remove any forwarding loop: one side should be authoritative for the domain.",
      "Add endpoint IPs in more AZs if the per-IP query rate is above 50% of the documented ceiling.",
      "Test with a real query from the on-premises resolver and check the answer source, not only that a response arrived.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A shared inbound endpoint in a central VPC reduces the number of endpoints, but it adds a network dependency for every connected network and concentrates the query load.",
      "Per-VPC endpoints isolate failure domains and keep queries local, but they cost more and multiply the forwarder configuration.",
      "A conditional forwarder is simple, but it hard-codes endpoint IPs. Automate the update when the endpoint changes.",
      "A Resolver rule is more flexible than a private zone for some hybrid names, but it takes precedence over a private zone for the same domain. That can surprise a team that expects the zone record to win.",
      "Adding endpoint IPs raises capacity, but it does not fix a loop or a blocked port. Check the path before adding capacity.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "inbound-vs-outbound",
    question:
      "An on-premises service cannot resolve a private hosted zone, but VPC workloads can resolve on-premises names. Which endpoint is missing, and what else must be true?",
    difficulty: 2,
    hints: [
      "The failing direction is on-premises to VPC.",
      "The zone must be associated with the VPC that holds the endpoint.",
    ],
    answer:
      "The inbound endpoint is missing, or the on-premises forwarder is not pointing at it. The VPC workloads resolving on-premises names shows that the outbound path and its rules are working. I would create or repair the inbound endpoint, then update the on-premises conditional forwarder with its IP addresses. I would also confirm that the private hosted zone is associated with the VPC that contains the inbound endpoint, that the endpoint security group allows UDP and TCP 53, and that the on-premises network can reach the endpoint IPs over VPN or Direct Connect.",
    followUps: [
      "Why not point the on-premises forwarder at the VPC CIDR plus two address?",
      "What would you check if the query returns NXDOMAIN instead of timing out?",
      "How would you make the forwarder update resilient to an endpoint change?",
    ],
    redFlags: [
      "Adds an outbound endpoint for an inbound problem.",
      "Forgets the private zone association.",
      "Uses the VPC CIDR plus two address from on-premises.",
    ],
    rubric: [
      "Chooses the inbound endpoint.",
      "Updates the on-premises forwarder.",
      "Checks zone association and port 53.",
      "Considers the network path over VPN or Direct Connect.",
    ],
  },
  {
    id: "forwarding-loop",
    question:
      "DNS queries for a private zone time out, and the inbound endpoint shows more query volume than the clients generate. What is your hypothesis, and how do you prove it?",
    difficulty: 3,
    hints: [
      "The extra volume has to come from somewhere.",
      "Look at both sides' rules for the same domain.",
    ],
    answer:
      "I suspect a forwarding loop. The on-premises resolver forwards the domain to the inbound endpoint, and a Resolver rule forwards the same domain back to the on-premises resolver. Each pass adds queries and none produces an answer. I would inspect the on-premises conditional forwarder and the Resolver rules for the same domain, then use query logs on both sides to see the query leaving and returning. The fix is to make one side authoritative and remove the other forward. After the fix, the endpoint volume should fall to the client rate.",
    followUps: [
      "How would a loop look in Resolver query logs?",
      "What is the difference between a loop and a slow authoritative server?",
      "Which side would you make authoritative?",
    ],
    redFlags: [
      "Adds endpoint capacity first.",
      "Blames the private zone association.",
      "Ignores the extra query volume.",
    ],
    rubric: [
      "Names the loop.",
      "Checks rules on both sides.",
      "Uses query volume and logs as evidence.",
      "Removes one forward rather than adding capacity.",
    ],
  },
  {
    id: "resolver-scaling",
    question:
      "The inbound endpoint is at 9,000 queries per second per IP. What is the documented ceiling, what does AWS recommend, and what do you change?",
    difficulty: 2,
    hints: [
      "The quota is per IP address, not per endpoint.",
      "AWS recommends acting before the ceiling.",
    ],
    answer:
      "AWS documents up to 10,000 UDP DNS queries per second per endpoint IP address, and recommends adding network interfaces when the maximum rate exceeds 50% of that capacity. At 9,000 per IP the endpoint is close to the ceiling, so I would add IPs in additional AZs and update the on-premises forwarder with the new addresses. I would also check the query type and response size, because the actual capacity varies with query mix and target health. I would verify with the per-IP CloudWatch metrics rather than the endpoint average.",
    followUps: [
      "Why is the limit per IP rather than per endpoint?",
      "What happens if the on-premises resolver uses only one of the endpoint IPs?",
      "How would you test the new capacity safely?",
    ],
    redFlags: [
      "Quotes a per-endpoint limit.",
      "Waits for 100% before adding IPs.",
      "Ignores the on-premises forwarder configuration.",
    ],
    rubric: [
      "Names 10,000 UDP qps per IP.",
      "Names the 50% guidance.",
      "Adds IPs and updates the forwarder.",
      "Uses per-IP metrics.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Inbound and outbound endpoints are inventoried with their IPs, AZs, and owning VPC.",
      "On-premises conditional forwarders are documented and updated when endpoint IPs change.",
      "Private hosted zones are associated with every VPC that must resolve them.",
      "Resolver query logs and per-IP CloudWatch metrics are enabled.",
      "Forwarding rules are reviewed for loops and for precedence over private zones.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the failing direction and whether an inbound or outbound endpoint is required.",
      "Check the on-premises forwarder target IPs against the current endpoint IPs.",
      "Check the private zone association with the endpoint's VPC.",
      "Check the endpoint security group and network ACL for UDP and TCP 53.",
      "Compare per-IP query volume with the documented ceiling and look for a loop.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Update the forwarder and endpoint configuration together.",
      "Re-test from the on-premises resolver and confirm the answer source.",
      "Add or resize endpoint IPs if utilization is above 50%.",
      "Record the loop or missing-rule cause in the runbook.",
    ],
  },
];

const references = [
  {
    title: "What is Route 53 VPC Resolver?",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Default VPC resolution, inbound and outbound endpoints, and forwarding rules.",
  },
  {
    title: "Forwarding inbound DNS queries to your VPCs",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-forwarding-inbound-queries.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Inbound endpoint IPs, on-premises forwarding, and the need for VPN or Direct Connect.",
  },
  {
    title: "Resolving DNS queries between VPCs and your network",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resolver-overview-DSN-queries-to-vpc.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Inbound and outbound endpoint direction, rules, and the warning against using the VPC CIDR plus two from on-premises.",
  },
  {
    title: "Quotas for Route 53 VPC Resolver",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/DNSLimitations.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "10,000 UDP queries per second per endpoint IP and the 50% guidance for adding interfaces.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "hybrid-dns": {
      model: route53ResolverModel,
      presets,
      instructions:
        "Start healthy, remove the inbound endpoint, then apply the forwarding loop. Compare timeouts with query volume, then raise the rate at peak to test the per-IP ceiling.",
      experimentIds: [experiment.id],
      note: "Illustrative query rates. The 10,000 UDP qps per endpoint IP ceiling is documented by AWS; endpoint and forwarder behavior follows the Route 53 Resolver documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-private-hosted-zones",
    "cloud-networking-vpc",
    "cloud-networking-security-groups",
    "cloud-networking-vpc-endpoints",
    "traffic-route53-routing",
  ],
};
