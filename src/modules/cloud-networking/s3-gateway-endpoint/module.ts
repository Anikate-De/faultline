import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimEdge, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const params = [
  {
    id: "routeAssociated",
    label: "Private route table associated with the endpoint",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 associates the private subnet's route table with the S3 gateway endpoint, which adds the S3 prefix-list route. 0 leaves S3 traffic on the default route to NAT.",
    format: "count" as const,
  },
  {
    id: "policyMode",
    label: "Bucket policy (0 any source, 1 endpoint only)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Access",
    help: "1 adds a deny unless aws:SourceVpce matches the gateway endpoint. Traffic that bypasses the endpoint is then denied by S3 as well as charged to NAT.",
    format: "count" as const,
  },
  {
    id: "dataVolume",
    label: "S3 data volume",
    min: 1,
    max: 500,
    step: 1,
    value: 60,
    unit: " TB/month",
    group: "Traffic",
    help: "Illustrative monthly S3 volume from the private subnet. The model reports the volume removed from NAT, not a currency amount.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  routeAssociated: boolean;
  endpointOnly: boolean;
  volume: number;
  endpointData: number;
  natData: number;
  denied: number;
  deniedRate: number;
  delivered: number;
  successRate: number;
  failureRate: number;
  endpointShare: number;
  privateHealth: Health;
  routeHealth: Health;
  natHealth: Health;
  s3Health: Health;
}

function compute(p: Params): Computed {
  const routeAssociated = num(p, "routeAssociated", 1) >= 0.5;
  const endpointOnly = num(p, "policyMode", 1) >= 0.5;
  const volume = Math.max(1, num(p, "dataVolume", 60));
  const denied = !routeAssociated && endpointOnly ? volume : 0;
  const delivered = volume - denied;
  const successRate = clamp((delivered / volume) * 100, 0, 100);
  return {
    routeAssociated,
    endpointOnly,
    volume,
    endpointData: routeAssociated ? volume : 0,
    natData: routeAssociated ? 0 : volume,
    denied,
    deniedRate: clamp((denied / volume) * 100, 0, 100),
    delivered,
    successRate,
    failureRate: clamp(100 - successRate, 0, 100),
    endpointShare: routeAssociated ? 100 : 0,
    privateHealth: successRate >= 95 ? "ok" : "crit",
    routeHealth: routeAssociated ? "ok" : "warn",
    natHealth: routeAssociated ? "ok" : volume >= 50 ? "crit" : volume >= 10 ? "warn" : "ok",
    s3Health: delivered > 0 ? "ok" : "down",
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatPercent(value: number): string {
  return value >= 99.95 ? "100" : value.toFixed(1);
}

function seedSeries(frame: SimFrame, values: Computed, seed: number): void {
  const length = 24;
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 6)) / 2.3);
  const rows: [string, number, number][] = [
    ["nat-data", values.natData, 2],
    ["s3-success", values.successRate, 0],
    ["s3-failure", values.failureRate, 0],
    ["denied", values.deniedRate, 0.6],
    ["endpoint-data", values.endpointData, 2],
    ["endpoint-share", values.endpointShare, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "s3-success" || id === "s3-failure" || id === "endpoint-share"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function pathLabel(values: Computed): string {
  if (values.routeAssociated) return "S3 prefix route to gateway endpoint";
  return values.endpointOnly ? "S3 via NAT, denied by bucket policy" : "S3 via NAT, allowed";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const nodes: SimNode[] = [
    {
      id: "private",
      label: "private subnet",
      kind: "service" as const,
      health: v.privateHealth,
      sublabel: `${formatCount(v.volume)} TB/month`,
      detail: `The uploader has no internet route and no public IP. ${formatCount(
        v.delivered,
      )} TB/month complete; ${formatCount(v.denied)} TB/month are denied in this state.`,
      meta: { view: "flow" },
    },
    {
      id: "route",
      label: "route table",
      kind: "mesh" as const,
      health: v.routeHealth,
      sublabel: v.routeAssociated ? "S3 prefix → endpoint" : "0.0.0.0/0 → NAT",
      detail: v.routeAssociated
        ? "The gateway endpoint association added a route for the S3 prefix list. The prefix-list route is more specific than the default route, so S3 traffic uses the endpoint."
        : "The route table is not associated with the gateway endpoint, so S3 traffic matches 0.0.0.0/0 and goes to the NAT gateway. The endpoint exists; it is simply not selected.",
      meta: { view: "flow" },
    },
  ];
  const edges: SimEdge[] = [edge("private-route", "private", "route", 1, "ok")];
  if (v.routeAssociated) {
    nodes.push({
      id: "endpoint",
      label: "S3 gateway endpoint",
      kind: "external" as const,
      health: "ok" as const,
      sublabel: "prefix-list target",
      detail:
        "A gateway endpoint is a target for the S3 prefix-list route. It uses the S3 public IP addresses and the same DNS names as the public S3 endpoint. There is no endpoint network interface and no additional endpoint charge.",
      meta: { view: "flow" },
    });
    nodes.push({
      id: "s3",
      label: "Amazon S3",
      kind: "storage" as const,
      health: v.s3Health,
      sublabel: "private AWS network",
      detail:
        "S3 receives the request over the AWS network. The endpoint policy and the bucket policy both apply. The gateway endpoint route keeps the bytes off the NAT gateway.",
      meta: { view: "flow" },
    });
    edges.push(edge("route-endpoint", "route", "endpoint", 1, "ok"));
    edges.push(edge("endpoint-s3", "endpoint", "s3", 1, v.s3Health));
  } else {
    nodes.push({
      id: "nat",
      label: "NAT gateway",
      kind: "external" as const,
      health: v.natHealth,
      sublabel: `${formatCount(v.natData)} TB/month`,
      detail:
        "The NAT gateway carries the S3 traffic and charges data processing per GB. It is in one Availability Zone, so this path also adds a zonal dependency that the gateway endpoint would not have.",
      meta: { view: "flow" },
    });
    nodes.push({
      id: "s3",
      label: "Amazon S3",
      kind: "storage" as const,
      health: v.s3Health,
      sublabel: v.endpointOnly ? "request denied" : "public endpoint",
      detail: v.endpointOnly
        ? "The bucket policy requires aws:SourceVpce to match the gateway endpoint. The request arrived through NAT, so the condition is absent and S3 denies it. The NAT still processed the bytes."
        : "The bucket policy allows any source, so the request succeeds through the public S3 endpoint. The traffic is billed as NAT data processing even though it stays on the AWS network.",
      meta: { view: "flow" },
    });
    edges.push(edge("route-nat", "route", "nat", 1, v.natHealth));
    edges.push(edge("nat-s3", "nat", "s3", 1, v.s3Health));
  }
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("nat-data", "S3 traffic through NAT", v.natData, " TB/month", 10, 50, "number"),
      metric("s3-success", "S3 success", v.successRate, "%", undefined, undefined, "percent"),
      metric("s3-failure", "S3 failures", v.failureRate, "%", 0.5, 5, "percent"),
      metric("denied", "Denied by bucket policy", v.deniedRate, "%", 0.1, 5, "percent"),
      metric("endpoint-data", "S3 traffic through endpoint", v.endpointData, " TB/month", undefined, undefined, "number"),
      metric("endpoint-share", "S3 traffic on endpoint", v.endpointShare, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, routeAssociated: v.routeAssociated ? 1 : 0, policyMode: v.endpointOnly ? 1 : 0 },
    summary: `${formatCount(v.volume)} TB/month; ${formatCount(v.natData)} TB/month through NAT; ${formatPercent(
      v.successRate,
    )}% S3 success; ${pathLabel(v)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "nat-data",
    metricId: "nat-data",
    warn: 10,
    crit: 50,
    title: "S3 traffic is still using the NAT gateway",
    cause:
      "The private route table is not associated with the gateway endpoint, so the S3 prefix-list route is absent. The endpoint exists, but the default route still selects NAT.",
    fix:
      "Associate the route table with the gateway endpoint, then confirm the S3 prefix-list route is present and more specific than 0.0.0.0/0. Check every subnet that uploads to S3.",
    checkFirst: [
      "Check the subnet's route table association with the gateway endpoint.",
      "Look for the S3 prefix-list route and compare it with 0.0.0.0/0.",
      "Compare NAT data processed with the endpoint's bytes processed.",
    ],
  },
  {
    id: "s3-failure",
    metricId: "s3-failure",
    warn: 99.5,
    crit: 95,
    title: "S3 requests are failing",
    cause:
      "The bucket policy requires the gateway endpoint and the traffic bypassed it, or the endpoint policy denies the action. A bypassed endpoint can succeed only when the bucket policy does not require the endpoint.",
    fix:
      "Restore the route-table association first. If the path is already correct, allow the action in the endpoint policy and confirm the bucket policy condition.",
    checkFirst: [
      "Check whether the request used the endpoint or NAT.",
      "Check the bucket policy for aws:SourceVpce or aws:SourceVpc.",
      "Check the endpoint policy for a denied action or resource.",
    ],
  },
  {
    id: "denied",
    metricId: "denied",
    warn: 0.1,
    crit: 5,
    title: "The bucket policy is denying S3 requests",
    cause:
      "The bucket policy allows access only from the VPC endpoint, but the request used the NAT path. The policy cannot see the endpoint condition, so it denies the request.",
    fix:
      "Associate the route table with the endpoint so the request carries aws:SourceVpce, or relax the bucket policy if access from outside the endpoint is intended.",
    checkFirst: [
      "Check the bucket policy's condition key and value.",
      "Check the route table that the uploader's subnet uses.",
      "Check whether the request came from a different VPC or network.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const s3GatewayEndpointModel: SimModel = {
  id: "cloud-networking-s3-gateway-endpoint",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousRoute = Number(frame.flags.routeAssociated ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (previousRoute !== -1 && previousRoute !== (v.routeAssociated ? 1 : 0)) {
      pushEvent(next, {
        id: "s3-endpoint-route-change",
        severity: v.routeAssociated ? "info" : "warn",
        title: v.routeAssociated ? "S3 traffic moved to the gateway endpoint" : "S3 traffic fell back to the NAT gateway",
        detail: v.routeAssociated
          ? "The route table now carries the S3 prefix-list route. Confirm that every private subnet that uploads to S3 uses an associated route table."
          : "The route-table association was removed, so the S3 route is gone. Bucket policies that require the endpoint will now deny the requests.",
        nodeId: "route",
        metricId: "nat-data",
      });
    }
    next.summary = `${formatCount(v.volume)} TB/month; ${formatCount(v.natData)} TB/month through NAT; ${formatPercent(
      v.successRate,
    )}% S3 success; ${pathLabel(v)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.routeAssociated) {
      items.push(
        `All ${formatCount(v.volume)} TB/month uses the S3 prefix-list route. NAT data processing for this traffic is zero, and the gateway endpoint itself has no additional charge.`,
      );
    } else if (v.endpointOnly) {
      items.push(
        `The route table is not associated, so the request goes through NAT. The bucket policy requires the endpoint, so S3 denies ${formatCount(
          v.denied,
        )} TB/month after the NAT has already processed it.`,
      );
    } else {
      items.push(
        `The route table is not associated, so ${formatCount(
          v.volume,
        )} TB/month goes through NAT. The requests succeed because the bucket policy allows any source, but the NAT data processing charge remains.`,
      );
    }
    items.push(
      "The gateway endpoint uses S3's public IP addresses and the same DNS names. That is why an existing application usually needs no code change, and why the route-table association is the switch that matters.",
    );
    items.push(
      "A gateway endpoint cannot serve on-premises, a VPC in another Region over peering, or a transit gateway. Those paths need an S3 interface endpoint.",
    );
    items.push(
      "An S3 bucket policy can require the endpoint with aws:SourceVpce. If the route is missing, the request is denied at S3 even though the network path through NAT works.",
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
    description: "The route table is associated with the gateway endpoint; 60 TB/month stays off NAT.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "500 TB/month uses the endpoint. High volume, zero NAT data processing for S3.",
    tone: "info",
    params: defaults({ dataVolume: 500 }),
  },
  {
    id: "failure",
    label: "Route missing",
    description: "The endpoint exists but the route table is not associated. S3 denies the request because the bucket policy requires the endpoint.",
    tone: "crit",
    params: defaults({ routeAssociated: 0, policyMode: 1, dataVolume: 60 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The route is associated again and the bucket policy condition is satisfied.",
    tone: "ok",
    params: defaults({ routeAssociated: 1, policyMode: 1, dataVolume: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-bypassed-endpoint-policy",
  title: "The bucket policy that required an endpoint",
  simId: "s3-endpoint-path",
  question:
    "A team creates an S3 gateway endpoint and a bucket policy that denies requests unless aws:SourceVpce matches the endpoint. They forget to associate the private route table. What does the uploader see, and what happens to the NAT bill?",
  prediction: {
    options: [
      { id: "works-free", label: "Uploads succeed and NAT volume stays at zero." },
      { id: "works-nat", label: "Uploads succeed through NAT and the NAT volume increases." },
      { id: "denied-nat", label: "Uploads are denied, but the NAT still processes the bytes." },
      { id: "denied-free", label: "Uploads are denied before any network path is used." },
    ],
    correctOptionId: "denied-nat",
    explanation:
      "Without the route-table association, the S3 prefix-list route is absent. The request follows 0.0.0.0/0 to NAT and reaches S3's public endpoint. The bucket policy requires aws:SourceVpce, which is absent, so S3 denies the request. The NAT gateway has already processed the bytes and bills for them.",
  },
  setup: defaults({ routeAssociated: 0, policyMode: 1, dataVolume: 60 }),
  runFor: 15,
  observe: [
    "NAT volume is the full 60 TB/month; the endpoint carries nothing.",
    "S3 success is 0% and every request is denied by the bucket policy.",
    "The route-table node is in a warning state while the S3 node is unavailable.",
    "Associating the route table moves the traffic to the endpoint and restores success.",
    "Relaxing the bucket policy would restore success but leave the NAT charge in place.",
  ],
  explain:
    "Creating a gateway endpoint does not change every route table. The association adds the S3 prefix-list route to the route tables you select, and only subnets using those tables take the endpoint. Without the route, the traffic takes the default route to NAT. A bucket policy that requires aws:SourceVpce then denies the request at S3, after the NAT data processing has already happened. The fix is the route association, not a wider bucket policy.",
  fix: defaults({ routeAssociated: 1, policyMode: 1, dataVolume: 60 }),
  debrief:
    "The two signals together identify the problem: NAT volume is high and S3 success is zero. A pure policy problem would show zero NAT volume; a pure routing problem with an open bucket policy would show high NAT volume and 100% success. The combination means the request bypassed the endpoint that the policy requires.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An S3 gateway endpoint is a route-table target that keeps S3 traffic on the AWS network without an internet gateway or network address translation (NAT) device. When you associate a route table with the endpoint, AWS adds a route whose destination is the S3 prefix list and whose target is the endpoint. The route is more specific than 0.0.0.0/0, so S3 traffic from subnets that use that route table goes to the endpoint instead of the NAT gateway.",
  },
  {
    type: "p",
    text: "There is no additional charge for a gateway endpoint. The saving is the NAT gateway data processing charge for the traffic you move off the NAT path. The endpoint uses S3's public IP addresses and the same DNS names, so an existing application usually does not need a code change. That is also why the route-table association is the switch that matters: the endpoint can exist and still do nothing if no route table selects it.",
  },
  {
    type: "p",
    text: "A gateway endpoint is not a general-purpose S3 path. It works from the virtual private cloud (VPC) subnets whose route tables are associated with it. It does not allow access from on-premises, from a VPC in another Region over peering, or through a transit gateway. Those cases need an S3 interface endpoint, which uses endpoint network interfaces and private DNS and is billed per hour and per GB.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is private subnet, route table, S3 prefix-list route, gateway endpoint, S3. The endpoint is not a proxy and has no security group of its own. The instance security group and the subnet network ACL must allow traffic to the S3 prefix-list addresses, and the endpoint policy and bucket policy must allow the action.",
  },
  {
    type: "table",
    headers: ["Hop", "Requirement", "Failure signal"],
    rows: [
      ["Route table", "Associated with the gateway endpoint, so the S3 prefix-list route exists.", "S3 traffic still counted on the NAT gateway."],
      ["Security group", "Allows outbound TCP 443 to the S3 prefix list.", "Timeouts before S3 responds."],
      ["Network ACL", "Allows the S3 address ranges and return traffic.", "Intermittent timeouts; prefix lists cannot be used in ACL rules."],
      ["Endpoint policy", "Allows the principal, action, and resource.", "Access denied at the endpoint."],
      ["Bucket policy", "Allows the principal and does not require a missing condition.", "Access denied at S3."],
    ],
  },
  {
    type: "compare",
    leftTitle: "Gateway endpoint",
    rightTitle: "Interface endpoint",
    rows: [
      { label: "Mechanism", left: "Prefix-list route in the subnet route table.", right: "Endpoint ENI and private DNS name." },
      { label: "Source networks", left: "VPC subnets with the associated route table.", right: "VPC, on-premises, peered VPC, transit gateway." },
      { label: "Charge", left: "No additional charge.", right: "Per hour per AZ and per GB processed." },
      { label: "Security group", left: "None on the endpoint; instance and subnet rules apply.", right: "Security group on the endpoint ENI." },
    ],
  },
  {
    type: "p",
    text: "The bucket-policy interaction is the trap worth remembering. A policy can deny access unless aws:SourceVpce matches the gateway endpoint. If the route table is not associated, the request goes through NAT, the condition is absent, and S3 denies the request after the NAT has already processed the bytes. You pay for the failed request and the object is not written.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A route-association switch and an S3 volume input.",
      "Traffic through NAT and traffic through the endpoint, in TB per month, as separate metrics.",
      "S3 success and bucket-policy denials, so a path problem is not confused with an access problem.",
      "A route-table node whose state changes when the endpoint route is missing.",
      "Presets for a healthy endpoint, high volume, a missing association, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and confirm that NAT volume is zero. Apply Route missing: the endpoint still exists, but S3 success falls to zero and NAT volume is the full upload. Then set the bucket policy to any source and watch the uploads succeed through NAT again. The remaining NAT volume is the cost you did not remove. Run the experiment before revealing its explanation.",
  },
  {
    type: "p",
    text: "Volumes are illustrative teaching inputs, not measured bills. The model reports TB per month removed from NAT rather than currency, because NAT data processing prices vary by Region and change over time. The route, prefix-list, and bucket-policy behavior follows the AWS documentation.",
  },
  { type: "sim", simId: "s3-endpoint-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With the route table associated, the S3 prefix-list route selected the gateway endpoint. NAT volume for S3 dropped to zero and the uploads stayed on the AWS network. The endpoint did not need a DNS change, an ENI, or a security group; the route association was the whole switch.",
  },
  {
    type: "p",
    text: "Without the association, the same endpoint existed but the traffic followed the default route to NAT. With a bucket policy that allowed any source, the uploads still succeeded and the only symptom was NAT volume. With a bucket policy that required the endpoint, the uploads failed at S3 while NAT volume stayed high. That combination is the signature of a bypassed endpoint.",
  },
  {
    type: "p",
    text: "The failure was not a network outage. The network path through NAT worked; the access policy rejected the request because it arrived from the wrong path. That is why the NAT metric and the S3 success metric have to be read together.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route tables: the S3 prefix-list route appears only in route tables associated with the gateway endpoint. The route is managed by the association and cannot be edited directly.",
      "NAT gateway metrics: BytesOutToDestination and data processed by the NAT. A high value for S3 traffic after an endpoint rollout means at least one subnet is still on the NAT path.",
      "Endpoint metrics: bytes processed by the gateway endpoint. If it is zero while S3 traffic is high, the endpoint is not in the path.",
      "Bucket policy: an explicit deny with StringNotEquals on aws:SourceVpce. The error is an access denial, not a timeout.",
      "Endpoint policy: a separate resource policy on the endpoint. An allow in the bucket policy does not override an endpoint policy deny.",
      "Subnet coverage: a VPC can have several private route tables. Associating one does not change the others.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check whether the uploading subnet's route table is associated with the gateway endpoint, then compare NAT data processed with endpoint bytes processed. If the endpoint is carrying traffic and requests still fail, read the endpoint policy and the bucket policy. Do not start by widening the bucket policy: that can restore access while leaving the NAT charge in place.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify every private subnet that uploads to S3 and the route table each one uses.",
      "Associate each of those route tables with the gateway endpoint and confirm the S3 prefix-list route appears.",
      "Check the instance security group and network ACL for outbound TCP 443 to the S3 address ranges.",
      "Confirm the endpoint policy allows the action and the bucket policy condition matches the endpoint ID.",
      "Retest the upload and compare NAT and endpoint volume. The NAT volume for S3 should fall to zero.",
      "If traffic comes from on-premises or another Region, add an S3 interface endpoint instead of trying to extend the gateway endpoint.",
      "Add an alarm for S3 traffic through NAT and a check that each private route table is associated.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A gateway endpoint is free and needs no application change, but it is limited to S3 and DynamoDB and to subnets with an associated route table.",
      "An interface endpoint reaches S3 from on-premises and other networks, but it adds per-AZ hours, per-GB processing, and ENI IP consumption.",
      "A bucket policy that requires the endpoint improves security, but it turns a missing route into an access failure. That is easier to detect than silent NAT spend, and harder to diagnose if you only look at the network.",
      "Associating every route table is simpler to operate, but it can route S3 traffic from subnets that were intentionally using a different path. Review the associations against the workload map.",
      "Keeping the NAT gateway for other internet traffic is still necessary. Removing S3 from NAT reduces the data processing charge; it does not remove the NAT itself.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "find-remaining-nat",
    question:
      "A gateway endpoint is in place and the NAT bill for S3 is still large. How do you find the remaining traffic?",
    difficulty: 2,
    hints: [
      "The endpoint route is added per associated route table.",
      "Not all S3 traffic comes from the same subnet.",
    ],
    answer:
      "I would compare the NAT gateway's data processed with the endpoint's bytes processed, then break the NAT traffic down by subnet or VPC Flow Logs. The usual cause is a private route table that was never associated with the endpoint, often in a second AZ or an older subnet. I would also check for traffic from on-premises, a peered VPC in another Region, or a transit gateway, because a gateway endpoint cannot serve those paths. Finally I would check for an S3 endpoint in another Region or an address range outside the local prefix list. The fix is to associate the missing route tables or add an interface endpoint for the paths the gateway endpoint cannot serve.",
    followUps: [
      "Which metric proves the endpoint is carrying traffic?",
      "Why can a gateway endpoint not serve a transit gateway?",
      "How would you handle an S3 bucket in another Region?",
    ],
    redFlags: [
      "Checks only the endpoint policy.",
      "Assumes one route table covers the VPC.",
      "Ignores on-premises or cross-Region sources.",
    ],
    rubric: [
      "Compares NAT and endpoint volume.",
      "Finds unassociated route tables.",
      "Names the gateway endpoint's scope limits.",
      "Chooses interface endpoints where needed.",
    ],
  },
  {
    id: "bucket-policy-denial",
    question:
      "Uploads fail with Access Denied after a gateway endpoint rollout, but the security groups are unchanged. What is the likely cause?",
    difficulty: 3,
    hints: [
      "The bucket policy may require the endpoint.",
      "A bypassed endpoint does not satisfy aws:SourceVpce.",
    ],
    answer:
      "The bucket policy probably denies requests unless aws:SourceVpce matches the gateway endpoint, and the upload is still taking the NAT path because its route table is not associated with the endpoint. The request reaches S3 through NAT, the condition is absent, and S3 denies it. I would check the route table association and the bucket policy condition before changing security groups. If the route is correct, I would check the endpoint policy and the IAM policy. The distinguishing signal is that NAT volume is still high while S3 success is zero.",
    followUps: [
      "What would a timeout instead of Access Denied suggest?",
      "How would you prove the request used the endpoint?",
      "Would an interface endpoint change the condition key?",
    ],
    redFlags: [
      "Widens the security group first.",
      "Assumes the endpoint route is automatic.",
      "Ignores the bucket policy condition.",
    ],
    rubric: [
      "Names aws:SourceVpce.",
      "Checks the route-table association.",
      "Uses NAT volume as evidence.",
      "Separates access denial from network timeout.",
    ],
  },
  {
    id: "gateway-vs-interface-s3",
    question:
      "When would you choose an S3 interface endpoint over a gateway endpoint, and what does it cost you operationally?",
    difficulty: 2,
    hints: [
      "Think about where the request comes from.",
      "Interface endpoints use ENIs and security groups.",
    ],
    answer:
      "I would choose an interface endpoint when the S3 traffic comes from on-premises over Direct Connect or VPN, from a VPC in another Region over peering, or through a transit gateway, because a gateway endpoint cannot serve those paths. I would also choose it when I need private IP addresses or security-group control at the endpoint. Operationally it adds endpoint network interfaces in each AZ, a security group, private DNS or endpoint-specific DNS names, and per-hour and per-GB charges. For in-VPC traffic, a gateway endpoint is still the lower-cost path, so many designs keep both.",
    followUps: [
      "Can a VPC have both endpoint types for S3?",
      "Which DNS name would an on-premises client use?",
      "How does private DNS for inbound-only change the path?",
    ],
    redFlags: [
      "Says a gateway endpoint works from on-premises.",
      "Ignores the per-GB charge.",
      "Forgets the endpoint security group.",
    ],
    rubric: [
      "Names the source-network limitation.",
      "Explains ENIs and security groups.",
      "Names the cost model.",
      "Keeps the gateway endpoint for in-VPC traffic.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every private route table that needs S3 is associated with the gateway endpoint.",
      "The S3 prefix-list route is present and the default route is not the only path.",
      "Bucket policies that require aws:SourceVpce are documented with their endpoint IDs.",
      "NAT data processed is alarmed by subnet or VPC, not only in total.",
      "On-premises and cross-Region S3 paths are identified and use an interface endpoint where needed.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare NAT volume with endpoint bytes processed to see which path is active.",
      "Check the uploading subnet's route table association.",
      "Read the bucket policy condition and the endpoint policy before changing security groups.",
      "Check whether the source is inside the VPC or coming through a gateway endpoint that cannot serve it.",
      "Record the route and policy state before making a change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Associate the missing route tables and re-test the upload.",
      "Confirm NAT volume for S3 fell to zero and endpoint volume rose.",
      "Review bucket policy conditions against the actual endpoint IDs.",
      "Add a recurring check for unassociated private route tables.",
    ],
  },
];

const references = [
  {
    title: "Gateway endpoints",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Prefix-list routes, no additional charge, route precedence, and security-group requirements.",
  },
  {
    title: "Gateway endpoints for Amazon S3",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "S3 gateway endpoint behavior, route-table association, and the limits versus interface endpoints.",
  },
  {
    title: "Controlling access from VPC endpoints with bucket policies",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/example-bucket-policies-vpc-endpoint.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Bucket policies that deny access unless aws:SourceVpce or aws:SourceVpc matches.",
  },
  {
    title: "AWS PrivateLink for Amazon S3",
    url: "https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Gateway versus interface endpoints for S3, including on-premises and cross-Region access.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "s3-endpoint-path": {
      model: s3GatewayEndpointModel,
      presets,
      instructions:
        "Start healthy, apply Route missing, then switch the bucket policy to any source. Compare S3 success and NAT volume to separate a route problem from a policy problem.",
      experimentIds: [experiment.id],
      note: "Illustrative volume model. TB/month values are teaching inputs; gateway endpoint routing and bucket-policy behavior follow AWS documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-vpc-endpoints",
    "cloud-networking-nat-gateway",
    "cloud-networking-route-tables",
    "cloud-networking-privatelink",
    "cloud-networking-iam-roles",
  ],
};
