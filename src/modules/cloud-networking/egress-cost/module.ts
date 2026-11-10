import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const RATE_CROSS_AZ = 20;
const RATE_CROSS_REGION = 20;
const RATE_INTERNET = 90;
const RATE_NAT = 45;

const params = [
  {
    id: "crossAz",
    label: "Cross-AZ transfer",
    min: 0,
    max: 500,
    step: 5,
    value: 20,
    unit: " TB/month",
    group: "Boundaries",
    help: "Traffic crossing an Availability Zone boundary. The model applies an illustrative blended rate in both directions.",
    format: "number" as const,
  },
  {
    id: "crossRegion",
    label: "Cross-region transfer",
    min: 0,
    max: 1_000,
    step: 5,
    value: 5,
    unit: " TB/month",
    group: "Boundaries",
    help: "Traffic crossing a Region boundary. Rates vary by Region pair; this model uses one illustrative rate.",
    format: "number" as const,
  },
  {
    id: "internet",
    label: "Internet egress",
    min: 0,
    max: 1_000,
    step: 5,
    value: 10,
    unit: " TB/month",
    group: "Boundaries",
    help: "Traffic leaving to the public internet. Pricing is tiered; this model uses one illustrative tier.",
    format: "number" as const,
  },
  {
    id: "nat",
    label: "NAT-processed transfer",
    min: 0,
    max: 1_000,
    step: 5,
    value: 10,
    unit: " TB/month",
    group: "Processing",
    help: "Data processed by a NAT gateway. NAT processing is charged in addition to the data-transfer rate of the destination.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  crossAz: number;
  crossRegion: number;
  internet: number;
  nat: number;
  crossAzCost: number;
  crossRegionCost: number;
  internetCost: number;
  natCost: number;
  cost: number;
  regionShare: number;
  natShare: number;
  totalTb: number;
  costPerTb: number;
  peerHealth: Health;
}

function compute(p: Params): Computed {
  const crossAz = Math.max(0, num(p, "crossAz", 20));
  const crossRegion = Math.max(0, num(p, "crossRegion", 5));
  const internet = Math.max(0, num(p, "internet", 10));
  const nat = Math.max(0, num(p, "nat", 10));
  const crossAzCost = crossAz * RATE_CROSS_AZ;
  const crossRegionCost = crossRegion * RATE_CROSS_REGION;
  const internetCost = internet * RATE_INTERNET;
  const natCost = nat * RATE_NAT;
  const cost = crossAzCost + crossRegionCost + internetCost + natCost;
  const regionShare = cost > 0 ? (crossRegionCost / cost) * 100 : 0;
  const natShare = cost > 0 ? (natCost / cost) * 100 : 0;
  const totalTb = crossAz + crossRegion + internet + nat;
  return {
    crossAz,
    crossRegion,
    internet,
    nat,
    crossAzCost,
    crossRegionCost,
    internetCost,
    natCost,
    cost,
    regionShare,
    natShare,
    totalTb,
    costPerTb: totalTb > 0 ? cost / totalTb : 0,
    peerHealth: cost >= 10_000 ? "crit" : cost >= 5_000 ? "warn" : "ok",
  };
}

function formatMoney(value: number): string {
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const rows: [string, number, number][] = [
    ["monthly-cost", values.cost, 40],
    ["region-share", values.regionShare, 0],
    ["nat-share", values.natShare, 0],
    ["nat-tb", values.nat, 2],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length: 20 }, (_, index) => {
      const wave = Math.sin((index + (seed % 7)) / 2.6) * amplitude;
      return Math.max(0, value + wave);
    });
  }
}

function buildFrame(p: Params, seed: number): SimFrame {
  const values = compute(p);
  return {
    t: 0,
    nodes: [
      {
        id: "service-a",
        label: "orders · us-east-1",
        kind: "service",
        health: "ok",
        sublabel: `${values.crossAz} TB cross-AZ`,
        detail: "The service writes to a dependency in another Availability Zone. The bill records bytes, not the path that created them.",
        meta: { view: "flow" },
      },
      {
        id: "service-b",
        label: "catalog · eu-west-1",
        kind: "service",
        health: values.peerHealth,
        sublabel: `${values.crossRegion} TB cross-region`,
        detail:
          values.crossRegion > 0
            ? "Chatty calls cross a Region boundary. The path has the same rate as the cross-AZ path in this model, but the volume is often much higher."
            : "No cross-region traffic in this state. The dependency is served from the local Region.",
        meta: { view: "flow" },
      },
      {
        id: "nat",
        label: "NAT gateway",
        kind: "external",
        health: values.natCost >= 5_000 ? "crit" : values.natCost >= 2_000 ? "warn" : "ok",
        sublabel: `${values.nat} TB processed`,
        detail:
          "NAT processing is charged per GB in addition to the destination transfer rate. A service that reaches S3 through NAT pays twice for the same bytes.",
        meta: { view: "flow" },
      },
      {
        id: "s3",
        label: "S3 gateway endpoint",
        kind: "storage",
        health: "ok",
        sublabel: values.nat > 0 ? "available, not used" : "in path",
        detail:
          "A gateway endpoint keeps S3 traffic on the AWS network and avoids NAT processing. The data-transfer rate for the S3 path is separate.",
        meta: { view: "flow" },
      },
      {
        id: "internet",
        label: "internet clients",
        kind: "client",
        health: "ok",
        sublabel: `${values.internet} TB egress`,
        detail: "Internet egress is usually the most expensive per GB. Tiering can reduce the blended rate at high volume.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("a-b", "service-a", "service-b", clamp(values.crossRegion / 1_000), values.peerHealth, "cross-region"),
      edge("a-nat", "service-a", "nat", clamp(values.nat / 1_000), values.natCost >= 5_000 ? "crit" : "ok", "NAT"),
      edge("nat-s3", "nat", "s3", values.nat > 0 ? clamp(values.nat / 1_000) : 0, values.nat > 0 ? "warn" : "ok"),
      edge("a-internet", "service-a", "internet", clamp(values.internet / 1_000), "ok", "internet"),
    ],
    metrics: [
      metric("monthly-cost", "Monthly data transfer", values.cost, " $", 5_000, 10_000, "number"),
      metric("region-share", "Cross-region share", values.regionShare, "%", 35, 50, "percent"),
      metric("nat-tb", "NAT-processed data", values.nat, " TB", undefined, undefined, "number"),
      metric("cost-per-tb", "Blended cost", values.costPerTb, " $/TB", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: { seed },
    summary: `${formatMoney(values.cost)}/month; ${values.totalTb} TB; cross-region ${formatPercent(
      values.regionShare,
    )}% of cost; NAT ${values.nat} TB.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "monthly-cost",
    metricId: "monthly-cost",
    warn: 5_000,
    crit: 10_000,
    title: "Data transfer cost is above the modeled budget",
    cause:
      "The bill follows the path, not the service total. Cross-region chatter, NAT processing, and internet egress have different rates, and a path change can move volume into a more expensive boundary.",
    fix:
      "Attribute the top paths with flow data and cost allocation tags, then move the highest-volume path to the cheapest boundary that still meets latency and resilience requirements.",
    checkFirst: [
      "Rank paths by cost, not by total bytes.",
      "Check whether the traffic crosses an AZ, a Region, the internet, or a NAT gateway.",
      "Check whether a gateway endpoint or same-AZ placement would remove the charge.",
    ],
  },
  {
    id: "region-share",
    metricId: "region-share",
    warn: 35,
    crit: 50,
    title: "One cross-region path dominates the data-transfer bill",
    cause:
      "A service call, replication stream, or backup crosses a Region boundary at high volume. The traffic may be small relative to the application workload but large relative to the cheaper local paths.",
    fix:
      "Move the consumer or the data closer, cache the result, batch the replication, or make the cross-region path asynchronous. Re-measure after the change.",
    checkFirst: [
      "Identify the top source and destination pairs crossing the Region boundary.",
      "Check whether the calls are synchronous and chatty.",
      "Check whether a local read replica or cache would preserve behavior.",
    ],
  },
  {
    id: "nat-tb",
    metricId: "nat-tb",
    warn: 50,
    crit: 200,
    title: "NAT processing is a large part of the network bill",
    cause:
      "Traffic to an AWS service is going through a NAT gateway instead of a gateway or interface endpoint. NAT processing is charged on top of the data-transfer rate.",
    fix:
      "Add a gateway endpoint for S3 or DynamoDB, an interface endpoint for other supported services, and route the private subnets to the endpoint. Keep the NAT for internet egress.",
    checkFirst: [
      "Find the destination service behind the NAT-processed bytes.",
      "Check whether a VPC endpoint exists and is in the route table.",
      "Check whether the workload can use the endpoint without crossing a NAT.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const egressCostModel: SimModel = {
  id: "cloud-networking-egress-cost",
  visual: "topology",
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
    if (values.cost >= 10_000 && frame.flags.costLogged !== 1) {
      pushEvent(next, {
        id: "egress-cost",
        severity: "crit",
        title: "Data-transfer bill crossed the budget",
        detail: `${formatMoney(values.cost)}/month with ${formatPercent(
          values.regionShare,
        )}% from the cross-region path. The volume is on the expensive boundary, not necessarily higher than before.`,
        nodeId: "service-b",
        metricId: "monthly-cost",
      });
    }
    next.flags.costLogged = values.cost >= 10_000 ? 1 : 0;
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    const items: string[] = [];
    items.push(
      `The modeled bill is ${formatMoney(values.cost)}/month for ${values.totalTb} TB. Cross-region is ${formatPercent(
        values.regionShare,
      )}% of cost and NAT processing is ${formatPercent(values.natShare)}%.`,
    );
    items.push(
      values.crossRegion > 0
        ? `Cross-region volume is ${values.crossRegion} TB. The rate is similar to cross-AZ in this model, but the volume usually makes it the dominant line.`
        : "No cross-region traffic is counted. The remaining cost is local boundary and processing.",
    );
    items.push(
      values.nat > 0
        ? `${values.nat} TB is processed by NAT. If that traffic targets S3 or DynamoDB, a gateway endpoint removes the processing charge without changing the application path.`
        : "NAT-processed data is zero in this state. The S3 path stays on the AWS network.",
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
    description: "Modest local and internet egress, with a small cross-region and NAT footprint.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "All boundaries grow with a seasonal peak. Cost is above the warning line but below critical.",
    tone: "warn",
    params: defaults({ crossAz: 40, crossRegion: 30, internet: 30, nat: 30 }),
  },
  {
    id: "failure",
    label: "Cross-region chatter",
    description: "A chatty dependency moves 600 TB/month across Regions and dominates the bill.",
    tone: "crit",
    params: defaults({ crossAz: 120, crossRegion: 600, internet: 20, nat: 80 }),
  },
  {
    id: "nat-heavy",
    label: "NAT processing",
    description: "S3 traffic goes through NAT. The bill rises without any cross-region path.",
    tone: "crit",
    params: defaults({ crossAz: 20, crossRegion: 5, internet: 10, nat: 300 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The cross-region path is reduced and S3 uses a gateway endpoint, removing NAT processing.",
    tone: "ok",
    params: defaults({ crossAz: 20, crossRegion: 5, internet: 10, nat: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-egress-path",
  title: "Predict the cost driver",
  simId: "cost-path",
  question:
    "A service move doubles the network bill while request volume and response size stay flat. What is the most likely change?",
  prediction: {
    options: [
      { id: "volume", label: "The service sends twice as many bytes per request." },
      { id: "boundary", label: "The same bytes now cross a more expensive boundary, such as AZ or Region." },
      { id: "waf", label: "WAF request charges increased because the endpoint is public." },
      { id: "dns", label: "DNS query volume doubled with the move." },
    ],
    correctOptionId: "boundary",
    explanation:
      "Data-transfer cost is a function of the path as well as the volume. Moving a consumer or a dependency can put the same request on a cross-AZ or cross-region path. The bill changes even when request count and payload size do not. Attribution requires the source, destination, and boundary, not just the service total.",
  },
  setup: defaults({ crossAz: 120, crossRegion: 600, internet: 20, nat: 80 }),
  runFor: 12,
  observe: [
    "The monthly cost crosses critical while total traffic is plausible.",
    "The cross-region share is above half of the bill.",
    "NAT processing adds a separate line on top of data transfer.",
    "The cost-per-TB blended rate rises with the path mix.",
  ],
  explain:
    "The bill follows the path. A cross-region call carries a different rate from a same-AZ call, and a NAT-processed byte carries a processing charge in addition to the destination rate. The move changed the boundary, not the request. Flow data plus tags attribute the cost to the service and the path that created it.",
  fix: defaults({ crossAz: 20, crossRegion: 5, internet: 10, nat: 0 }),
  debrief:
    "Attribute first, then optimize. Move the highest-cost path to the cheapest boundary that still meets latency and resilience. A local cache, a read replica, batching, or a gateway endpoint often removes more cost than a broad instance-size change.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Data-transfer cost depends on the boundary a byte crosses. Traffic between Availability Zones, between Regions, to the internet, and through a NAT gateway each has a different rate. The same request can become more expensive without changing its size or frequency if the service moves to a different boundary.",
  },
  {
    type: "p",
    text: "Attribution is the hard part. A cost explorer line item shows the account and the service, not the path. To attribute the bill, combine flow data with resource tags: source, destination, AZ, Region, NAT, and the service owner. Then rank paths by cost, not by bytes. A small cross-region stream can outrank a large same-AZ transfer.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is workload, subnet, NAT or endpoint, destination boundary. Cross-AZ traffic stays inside a Region but crosses a zone boundary. Cross-region traffic crosses a Region boundary. Internet egress leaves the AWS network. NAT processing is a charge on the gateway that handled the bytes, and it can apply on top of the destination rate.",
  },
  {
    type: "table",
    headers: ["Boundary", "Typical driver", "Cheapest alternative", "What it does not fix"],
    rows: [
      ["Cross-AZ", "Chatty service calls, replication", "Same-AZ placement or a local cache", "Regional resilience requirements."],
      ["Cross-region", "Synchronous dependencies, backups", "Local replica, batching, async replication", "Disaster recovery across Regions."],
      ["Internet", "Public downloads, APIs", "CDN, compression, tiering", "The need to serve public users."],
      ["NAT processing", "AWS service traffic routed through NAT", "Gateway or interface endpoint", "Internet egress that still needs NAT."],
    ],
  },
  {
    type: "p",
    text: "The cheapest alternative is not automatically the right one. Same-AZ placement reduces cost and latency but weakens zone resilience. A local replica reduces cross-region reads but adds replication cost and consistency questions. The tradeoff belongs in the design, not only in the bill.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Monthly cost split across cross-AZ, cross-region, internet, and NAT processing.",
      "Cross-region share and NAT share, so the dominant path is visible.",
      "A blended cost per TB that rises when the path mix moves to expensive boundaries.",
      "Five nodes: two services, NAT, S3 endpoint, and internet clients.",
      "A prediction experiment that separates volume growth from a boundary change.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Cross-region chatter and read the cross-region share before the total. Next apply NAT processing: the bill rises without any cross-region path. Run the experiment before revealing the explanation, then apply Recovery to see both changes together.",
  },
  {
    type: "p",
    text: "The per-TB rates and thresholds are illustrative, not a current price quote. The boundary model, the attribution method, and the tradeoffs are the parts to carry into production.",
  },
  { type: "sim", simId: "cost-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The cross-region preset moved 600 TB across a Region boundary and produced most of the bill. The request volume did not have to grow; the path became more expensive. The cross-region share showed that the dominant line was one boundary, not a broad increase across all traffic.",
  },
  {
    type: "p",
    text: "The NAT preset produced a different shape. There was no cross-region traffic, but 300 TB passed through NAT and the processing charge dominated. The same bytes to S3 could have used a gateway endpoint and avoided that processing line entirely.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Cost allocation tags on services, NAT gateways, endpoints, and data-transfer resources.",
      "VPC Flow Logs with source, destination, bytes, and the ENI or NAT that handled the flow.",
      "Cost Explorer filters by usage type, Region, and account; the path is inferred from the usage type.",
      "NAT gateway bytes and endpoint bytes, compared with the service's total transfer.",
      "Application topology: which calls are synchronous, chatty, and cross-boundary.",
      "Latency and resilience requirements, which constrain the cheapest path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Rank paths by cost before changing placement. A service with the largest total bill may not own the expensive path. Check the boundary and the processing charge, then compare the cheapest alternative with the latency and resilience requirement.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Tag services, NAT gateways, and endpoints so cost can be attributed.",
      "Join flow data with tags to rank source-destination pairs by cost.",
      "Identify the boundary for the top paths: AZ, Region, internet, or NAT processing.",
      "For NAT-processed AWS service traffic, add a gateway or interface endpoint and route to it.",
      "For cross-region chatter, cache, batch, or move the consumer closer.",
      "For cross-AZ chatter, consider same-AZ placement only where zone resilience allows it.",
      "Re-measure after the change and check that latency and resilience did not regress.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Same-AZ placement lowers cost and latency but concentrates failure in one zone.",
      "A local read replica lowers cross-region reads but adds replication traffic and consistency work.",
      "Batching and async replication lower cost but change the freshness of the data.",
      "A CDN lowers internet egress and improves latency but adds cache invalidation and a new dependency.",
      "A gateway endpoint removes NAT processing for supported services but does not help internet egress.",
      "Cost optimization that ignores resilience can trade a predictable bill for an unpredictable outage.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "attribute-egress",
    question: "How do you attribute a data-transfer bill to the service and path that created it?",
    difficulty: 3,
    hints: [
      "Cost Explorer shows the account and usage type, not the path.",
      "Flow data plus tags closes the gap.",
    ],
    answer:
      "I would start with cost allocation tags on services, NAT gateways, endpoints, and other transfer resources. Then I would join VPC Flow Logs, including source, destination, bytes, and the ENI or NAT, with those tags. That gives a ranked list of source-destination pairs by cost and boundary. I would compare it with Cost Explorer usage types to validate the model. The output is a path-level attribution, not a service-level total, because a service can own both cheap and expensive paths.",
    followUps: [
      "Which flow fields are essential?",
      "How would you handle shared NAT gateways?",
      "What would you do with untagged resources?",
    ],
    redFlags: [
      "Sorts by total spend only.",
      "Ignores NAT processing.",
      "Has no tag ownership.",
    ],
    rubric: [
      "Uses tags and flow data.",
      "Ranks by path and cost.",
      "Separates boundaries.",
      "Validates against the bill.",
    ],
  },
  {
    id: "boundary-change",
    question:
      "The bill doubles after a service move and traffic volume is unchanged. What do you check?",
    difficulty: 2,
    hints: [
      "The path may have changed boundary.",
      "NAT processing can appear without a volume change.",
    ],
    answer:
      "I would compare the source and destination of the top flows before and after the move. The volume can stay flat while the path crosses a more expensive boundary, such as an AZ or a Region, or starts going through NAT instead of a gateway endpoint. I would check the cost allocation tags and the usage types, then rank the paths by cost. The fix depends on the boundary: local placement, caching, batching, or an endpoint.",
    followUps: [
      "Which boundary is easiest to remove?",
      "How would you prove the move caused it?",
      "What would you monitor after the fix?",
    ],
    redFlags: [
      "Assumes the application is sending more data.",
      "Checks only instance size.",
      "Ignores the topology change.",
    ],
    rubric: [
      "Compares paths before and after.",
      "Names AZ, Region, internet, and NAT.",
      "Uses flow and cost data.",
      "Chooses a boundary-specific fix.",
    ],
  },
  {
    id: "cost-versus-resilience",
    question: "When would you keep a more expensive cross-AZ or cross-region path?",
    difficulty: 3,
    hints: [
      "Cost is not the only requirement.",
      "Zone and Region failure are real.",
    ],
    answer:
      "I would keep the more expensive path when it is required for zone or Region resilience, for a latency target that a local path cannot meet, or for a data-residency or recovery objective. The decision should name the requirement and the cost of the alternative, not just the bill. I would look for a cheaper way to meet the same requirement, such as async replication, caching, or compression, before accepting the higher boundary cost.",
    followUps: [
      "How would you document the exception?",
      "What would trigger a review?",
      "Which workload would you move first?",
    ],
    redFlags: [
      "Cuts cost without checking resilience.",
      "Keeps every path because 'resilience'.",
      "Has no requirement or owner.",
    ],
    rubric: [
      "Names the requirement.",
      "Compares alternatives.",
      "Looks for cheaper resilience.",
      "Documents the exception.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Services, NAT gateways, and endpoints carry cost allocation tags.",
      "Flow logs are enabled for the paths that cross boundaries.",
      "A path-level cost model ranks the top source-destination pairs.",
      "Gateway and interface endpoints are used for supported AWS services.",
      "Latency and resilience requirements are documented per path.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Rank paths by cost, not by total bytes.",
      "Identify the boundary for each top path.",
      "Check NAT processing separately from destination transfer.",
      "Compare the cheapest alternative with the latency and resilience requirement.",
      "Re-measure after the change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add the new path to the cost model.",
      "Review the tag coverage for the service.",
      "Check whether the change shifted traffic to another boundary.",
      "Record the requirement that justified any remaining expensive path.",
    ],
  },
];

const references = [
  {
    title: "AWS data transfer pricing",
    url: "https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Rates for cross-AZ, cross-region, and internet data transfer. Check the current page for exact prices.",
  },
  {
    title: "Amazon VPC pricing",
    url: "https://aws.amazon.com/vpc/pricing/",
    publisher: "AWS",
    kind: "docs" as const,
    note: "NAT gateway processing and endpoint pricing.",
  },
  {
    title: "Gateway endpoints for Amazon S3",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How a gateway endpoint keeps S3 traffic off the NAT path.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "cost-path": {
      model: egressCostModel,
      presets,
      instructions:
        "Start healthy, then compare cross-region chatter with NAT processing. Read the dominant share before the total, and check which boundary the fix would change.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Per-TB rates and thresholds are teaching values, not a price quote.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["cloud-networking-cross-az-region", "cloud-networking-nat-scaling", "cloud-networking-s3-gateway-endpoint"],
};
