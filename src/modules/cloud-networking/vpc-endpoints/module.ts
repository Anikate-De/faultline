import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimEdge, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const MODE_LABELS = ["no endpoint", "gateway endpoint", "interface endpoint"];

const params = [
  {
    id: "endpointMode",
    label: "Endpoint type (0 none, 1 gateway, 2 interface)",
    min: 0,
    max: 2,
    step: 1,
    value: 1,
    unit: "",
    group: "Endpoint",
    help: "0 sends service traffic to the NAT gateway. 1 is a gateway endpoint for S3 or DynamoDB. 2 is an interface endpoint, which uses endpoint network interfaces and security groups.",
    format: "count" as const,
  },
  {
    id: "pathConfigured",
    label: "Private path configured",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Path",
    help: "1 associates the private route table with a gateway endpoint, or enables private DNS for an interface endpoint. 0 leaves the service traffic on the NAT path.",
    format: "count" as const,
  },
  {
    id: "policyAllows",
    label: "Endpoint policy allows the action",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Access",
    help: "0 denies the request at the endpoint. The request does not fall back to the NAT gateway; the endpoint policy is evaluated on the private path.",
    format: "count" as const,
  },
  {
    id: "demand",
    label: "Service traffic",
    min: 100,
    max: 5_000,
    step: 100,
    value: 800,
    unit: " GB/day",
    group: "Traffic",
    help: "Illustrative daily volume to the AWS service. The model reports volume, not currency, because prices vary by Region and change over time.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  mode: number;
  modeLabel: string;
  pathConfigured: boolean;
  policyAllows: boolean;
  demand: number;
  endpointPath: boolean;
  privateShare: number;
  natData: number;
  endpointData: number;
  denied: number;
  deniedRate: number;
  delivered: number;
  successRate: number;
  failureRate: number;
  privateHealth: Health;
  endpointHealth: Health;
  natHealth: Health;
  serviceHealth: Health;
}

function compute(p: Params): Computed {
  const mode = Math.max(0, Math.min(2, Math.round(num(p, "endpointMode", 1))));
  const pathConfigured = num(p, "pathConfigured", 1) >= 0.5;
  const policyAllows = num(p, "policyAllows", 1) >= 0.5;
  const demand = Math.max(1, num(p, "demand", 800));
  const endpointPath = mode > 0 && pathConfigured;
  const denied = endpointPath && !policyAllows ? demand : 0;
  const delivered = demand - denied;
  const successRate = clamp((delivered / demand) * 100, 0, 100);
  const endpointHealth: Health =
    mode === 0 ? "down" : endpointPath ? (policyAllows ? "ok" : "crit") : "warn";
  return {
    mode,
    modeLabel: MODE_LABELS[mode],
    pathConfigured,
    policyAllows,
    demand,
    endpointPath,
    privateShare: endpointPath ? 100 : 0,
    natData: endpointPath ? 0 : demand,
    endpointData: endpointPath ? demand : 0,
    denied,
    deniedRate: clamp((denied / demand) * 100, 0, 100),
    delivered,
    successRate,
    failureRate: clamp(100 - successRate, 0, 100),
    privateHealth: successRate >= 95 ? "ok" : "crit",
    endpointHealth,
    natHealth: endpointPath ? "ok" : demand >= 500 ? "crit" : demand >= 100 ? "warn" : "ok",
    serviceHealth: delivered > 0 ? "ok" : "down",
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
  const jitter = (offset: number) => 0.98 + 0.04 * Math.sin((offset + (seed % 5)) / 2.2);
  const rows: [string, number, number][] = [
    ["private-share", values.privateShare, 0],
    ["nat-data", values.natData, 4],
    ["denied", values.deniedRate, 0.8],
    ["success", values.successRate, 0],
    ["failure-rate", values.failureRate, 0],
    ["endpoint-data", values.endpointData, 4],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "private-share" || id === "success" || id === "failure-rate"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.1) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function pathLabel(values: Computed): string {
  if (values.mode === 0) return "no endpoint; all traffic uses NAT";
  if (!values.pathConfigured) return `${values.modeLabel} bypassed; traffic uses NAT`;
  if (!values.policyAllows) return `${values.modeLabel} denies the request`;
  return `${values.modeLabel} carrying traffic`;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const nodes: SimNode[] = [
    {
      id: "private",
      label: "private subnet",
      kind: "service" as const,
      health: v.privateHealth,
      sublabel: `${formatCount(v.demand)} GB/day`,
      detail: `A workload in a private subnet with no internet route of its own. ${formatCount(
        v.delivered,
      )} GB/day complete and ${formatCount(v.denied)} GB/day are denied in this state.`,
      meta: { view: "flow" },
    },
    {
      id: "route",
      label: "route table",
      kind: "mesh" as const,
      health: "ok" as const,
      sublabel: v.endpointPath ? "service prefix → endpoint" : "0.0.0.0/0 → NAT",
      detail: v.endpointPath
        ? "For a gateway endpoint, the service prefix list route targets the endpoint and is more specific than 0.0.0.0/0. For an interface endpoint, DNS resolves the service name to the endpoint network interfaces; the subnet route still carries the packet to that ENI."
        : "The service traffic matches 0.0.0.0/0 and leaves through the NAT gateway, or the interface endpoint is not selected because private DNS is off. The endpoint may exist; it is not in this path.",
      meta: { view: "flow" },
    },
  ];
  const edges: SimEdge[] = [edge("private-route", "private", "route", 1, "ok")];
  if (v.endpointPath) {
    nodes.push({
      id: "endpoint",
      label: v.mode === 1 ? "gateway endpoint" : "interface endpoint",
      kind: "external" as const,
      health: v.endpointHealth,
      sublabel: v.policyAllows ? "policy allows" : "policy denies",
      detail:
        v.mode === 1
          ? "A gateway endpoint is a route-table target for the service prefix list. It has no endpoint network interface and no security group of its own; the instance security group and network ACL must allow the service."
          : "An interface endpoint has an endpoint network interface in each selected subnet. Its security group controls traffic from the VPC, and private DNS makes the service's public name resolve to those interfaces.",
      meta: { view: "flow" },
    });
    nodes.push({
      id: "service",
      label: "AWS service",
      kind: "storage" as const,
      health: v.serviceHealth,
      sublabel: v.policyAllows ? "private path" : "request denied",
      detail:
        v.policyAllows
          ? "The service receives the request over the endpoint. The endpoint policy and the service's resource policy both apply."
          : "The request reached the endpoint and the endpoint policy denied it. It did not fall back to NAT, so the service never sees an allowed request.",
      meta: { view: "flow" },
    });
    edges.push(edge("route-endpoint", "route", "endpoint", 1, v.endpointHealth));
    edges.push(edge("endpoint-service", "endpoint", "service", 1, v.endpointHealth));
  } else {
    nodes.push({
      id: "nat",
      label: "NAT gateway",
      kind: "external" as const,
      health: v.natHealth,
      sublabel: `${formatCount(v.natData)} GB/day`,
      detail:
        "The NAT gateway translates the private subnet's traffic to its public address. It works, but the service traffic still consumes NAT data processing and depends on the NAT's Availability Zone.",
      meta: { view: "flow" },
    });
    nodes.push({
      id: "service",
      label: "AWS service",
      kind: "storage" as const,
      health: v.serviceHealth,
      sublabel: "public service endpoint",
      detail:
        "The request reaches the service's public endpoint through the NAT gateway. The endpoint policy does not apply because the request never used the endpoint.",
      meta: { view: "flow" },
    });
    edges.push(edge("route-nat", "route", "nat", 1, v.natHealth));
    edges.push(edge("nat-service", "nat", "service", 1, v.serviceHealth));
  }
  return {
    t: 0,
    nodes,
    edges,
    metrics: [
      metric("private-share", "Traffic on the private path", v.privateShare, "%", undefined, undefined, "percent"),
      metric("nat-data", "Traffic through NAT", v.natData, " GB/day", 100, 500, "number"),
      metric("denied", "Requests denied by policy", v.deniedRate, "%", 0.1, 5, "percent"),
      metric("success", "Service success", v.successRate, "%", undefined, undefined, "percent"),
      metric("failure-rate", "Service failures", v.failureRate, "%", 0.5, 5, "percent"),
      metric("endpoint-data", "Traffic through endpoint", v.endpointData, " GB/day", undefined, undefined, "number"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      endpointMode: v.mode,
      pathConfigured: v.pathConfigured ? 1 : 0,
      policyAllows: v.policyAllows ? 1 : 0,
    },
    summary: `${formatCount(v.demand)} GB/day; ${formatPercent(v.privateShare)}% on the private path; ${formatCount(
      v.natData,
    )} GB/day through NAT; ${pathLabel(v)}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "nat-data",
    metricId: "nat-data",
    warn: 100,
    crit: 500,
    title: "Service traffic is still using the NAT gateway",
    cause:
      "The subnet's route table is not associated with the gateway endpoint, or the interface endpoint is not selected because private DNS is off or the workload uses a name that still resolves publicly.",
    fix:
      "Associate the route table with the gateway endpoint, or enable private DNS and use the service's Regional name for the interface endpoint. Confirm the endpoint route is more specific than 0.0.0.0/0.",
    checkFirst: [
      "Check whether the private route table has the service prefix-list route to the gateway endpoint.",
      "Check whether private DNS is enabled for the interface endpoint and the VPC has DNS support and hostnames on.",
      "Compare the endpoint's bytes-processed metric with the NAT gateway's data-processed metric.",
    ],
  },
  {
    id: "denied",
    metricId: "denied",
    warn: 0.1,
    crit: 5,
    title: "The endpoint policy is denying requests",
    cause:
      "The endpoint policy does not allow the principal, action, or resource. Traffic still reaches the endpoint, so the request is denied there and does not fall back to the NAT gateway.",
    fix:
      "Update the endpoint policy to allow the required principal and action, or remove the endpoint assignment if the traffic should use another path. Then retry from the workload.",
    checkFirst: [
      "Read the endpoint policy and compare its Principal, Action, and Resource with the request.",
      "Check whether the service's own resource policy also denies the request.",
      "Check the endpoint state before changing the policy.",
    ],
  },
  {
    id: "failure-rate",
    metricId: "failure-rate",
    warn: 99.5,
    crit: 95,
    title: "Requests to the AWS service are failing",
    cause:
      "The endpoint policy denies the request, the endpoint is unavailable, or the security group or network ACL blocks the endpoint path. A missing endpoint is not the only failure mode.",
    fix:
      "Check the endpoint state and policy first, then the security group on the endpoint network interface or the instance. A gateway endpoint has no endpoint security group, so check the instance security group and network ACL.",
    checkFirst: [
      "Check the endpoint state and endpoint policy.",
      "Check the security group and network ACL in the direction of the request.",
      "Check whether the request actually used the endpoint or the NAT path.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const vpcEndpointsModel: SimModel = {
  id: "cloud-networking-vpc-endpoints",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousPath = String(frame.flags.path ?? "");
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    const path = v.endpointPath ? v.modeLabel : "nat";
    if (previousPath && previousPath !== path) {
      pushEvent(next, {
        id: "vpc-endpoint-path-change",
        severity: v.endpointPath ? "info" : "warn",
        title: v.endpointPath ? `Traffic moved to the ${v.modeLabel}` : "Traffic moved to the NAT gateway",
        detail: v.endpointPath
          ? "The service path now uses the endpoint. Verify that the endpoint policy allows the workload and that the service resource policy still permits the request."
          : "The service path no longer uses the endpoint. The endpoint policy cannot deny this traffic because the request never reaches the endpoint; check the route association or private DNS setting.",
        nodeId: "route",
        metricId: v.endpointPath ? "private-share" : "nat-data",
      });
    }
    next.flags.path = path;
    next.summary = `${formatCount(v.demand)} GB/day; ${formatPercent(v.privateShare)}% on the private path; ${formatCount(
      v.natData,
    )} GB/day through NAT; ${pathLabel(v)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.mode === 0) {
      items.push(
        "No endpoint is configured. The workload can still reach the service through NAT if it has a route and the service is public, but the traffic consumes NAT data processing.",
      );
    } else if (!v.pathConfigured) {
      items.push(
        `The ${v.modeLabel} exists but is not in the path. A gateway endpoint needs its route table associated; an interface endpoint needs private DNS (or the endpoint-specific name) to be selected.`,
      );
    } else if (!v.policyAllows) {
      items.push(
        `The request reaches the ${v.modeLabel} and is denied by the endpoint policy. It does not fall back to NAT, so the NAT volume stays at zero while the service success rate collapses.`,
      );
    } else {
      items.push(
        `The ${v.modeLabel} carries ${formatCount(v.endpointData)} GB/day. The endpoint policy and the service's resource policy both apply; an allow at the endpoint is not an allow at the service.`,
      );
    }
    items.push(
      "Gateway endpoints are route-table targets for S3 and DynamoDB and have no additional charge. Interface endpoints use endpoint network interfaces, security groups, and private DNS, and are billed per hour and per GB.",
    );
    items.push(
      "A gateway endpoint cannot be used from on-premises, a peered VPC in another Region, or through a transit gateway. Those paths need an interface endpoint.",
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
    description: "A gateway endpoint is associated with the route table and carries low-volume S3 traffic.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "An interface endpoint carries 4,000 GB/day privately with private DNS and no NAT data processing.",
    tone: "info",
    params: defaults({ endpointMode: 2, demand: 4_000 }),
  },
  {
    id: "failure",
    label: "Bypassed endpoint",
    description: "The gateway endpoint exists, but the route table is not associated. All traffic still goes through NAT.",
    tone: "crit",
    params: defaults({ endpointMode: 1, pathConfigured: 0, policyAllows: 1, demand: 800 }),
  },
  {
    id: "policy-deny",
    label: "Policy denial",
    description: "The endpoint is in the path, but its policy denies the action. Traffic does not fall back to NAT.",
    tone: "crit",
    params: defaults({ endpointMode: 1, pathConfigured: 1, policyAllows: 0, demand: 300 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The route is associated and the endpoint policy allows the workload.",
    tone: "ok",
    params: defaults({ endpointMode: 1, pathConfigured: 1, policyAllows: 1, demand: 300 }),
  },
];

const experiment: Experiment = {
  id: "predict-policy-denial-fallback",
  title: "The backup job that stopped after the policy change",
  simId: "endpoint-path",
  question:
    "A gateway endpoint for S3 is associated with the private route table. Its endpoint policy allows only s3:GetObject, but a backup job calls s3:PutObject. Does the denied request fall back to the NAT gateway?",
  prediction: {
    options: [
      { id: "fallback", label: "Yes. The request falls back to NAT and succeeds." },
      { id: "denied", label: "No. The request is denied at the endpoint and never reaches the NAT path." },
      { id: "retry", label: "The endpoint retries the request over the public S3 endpoint." },
      { id: "queued", label: "The request waits until the policy is updated." },
    ],
    correctOptionId: "denied",
    explanation:
      "The endpoint route is more specific than 0.0.0.0/0, so the request is captured by the endpoint. The endpoint policy denies s3:PutObject there. It does not re-route the packet to NAT, and the service never sees an allowed request.",
  },
  setup: defaults({ endpointMode: 1, pathConfigured: 1, policyAllows: 0, demand: 300 }),
  runFor: 15,
  observe: [
    "Traffic on the private path is 100%; NAT volume stays at zero.",
    "Every request is denied, and service success is 0%.",
    "The endpoint node is failing while the route table stays healthy.",
    "Restoring the endpoint policy fixes the requests without changing the route.",
    "A request that bypasses the endpoint would not be covered by the endpoint policy at all.",
  ],
  explain:
    "An endpoint policy is evaluated only for traffic that uses the endpoint. The gateway endpoint route captures S3 traffic for the associated subnets, so the deny applies before the service. There is no fallback to the NAT gateway, and the NAT's presence is irrelevant. The fix is to allow the backup action in the endpoint policy, or move the backup to a path whose policy permits it.",
  fix: defaults({ endpointMode: 1, pathConfigured: 1, policyAllows: 1, demand: 300 }),
  debrief:
    "The absence of NAT traffic is the clue. A routing problem would show NAT volume; a policy denial shows zero NAT volume and zero success on the private path. Check the endpoint policy before blaming the route.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A virtual private cloud (VPC) endpoint is a private entry point from a VPC to a supported AWS service. It removes the need for an internet gateway or NAT device for that traffic. There are two types you will use most. A gateway endpoint targets Amazon S3 or DynamoDB through a route-table entry for the service's AWS-managed prefix list. An interface endpoint creates an endpoint network interface (ENI) in each selected subnet, with a private IP address, a security group, and optional private DNS.",
  },
  {
    type: "p",
    text: "The types are not interchangeable. Gateway endpoints are route-table targets and have no additional charge. They work only from the VPC subnets whose route tables are associated with the endpoint, and they cannot be used from on-premises, a peered VPC in another Region, or through a transit gateway. Interface endpoints are reachable through DNS and support security groups, which makes them the choice for most other AWS services and for hybrid or cross-network access. S3 and DynamoDB support both types.",
  },
  {
    type: "p",
    text: "An endpoint policy is a resource-based AWS Identity and Access Management (IAM) policy attached to the endpoint. The default allows all actions by all principals. It is evaluated only when traffic uses the endpoint, and it does not override identity policies or the service's own resource policy such as an S3 bucket policy. A request can be allowed by one and denied by another.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The gateway path is private subnet, route table, prefix-list route, gateway endpoint, service. The interface path is private subnet, DNS answer, endpoint ENI, service. In both cases, the VPC does not need a route to the service's public IP range. The difference is how the packet is selected: a route for the gateway endpoint, DNS for the interface endpoint.",
  },
  {
    type: "table",
    headers: ["Decision", "Gateway endpoint", "Interface endpoint"],
    rows: [
      ["Services", "S3 and DynamoDB", "Most AWS services, plus S3 and DynamoDB"],
      ["Selection", "Route table entry for the service prefix list", "DNS name resolves to the endpoint ENI"],
      ["Security group", "No endpoint security group; instance security group applies", "Security group on the endpoint ENI"],
      ["Source networks", "VPC subnets with the associated route table", "VPC, on-premises, peered VPC, transit gateway"],
      ["Charge", "No additional charge", "Per hour per AZ and per GB processed"],
    ],
  },
  {
    type: "compare",
    leftTitle: "Endpoint path",
    rightTitle: "NAT path",
    rows: [
      { label: "Route", left: "Prefix-list route or endpoint DNS answer.", right: "0.0.0.0/0 to a NAT gateway in a public subnet." },
      { label: "Failure domain", left: "Endpoint AZs, policy, and endpoint security group.", right: "NAT's Availability Zone, port allocation, and public subnet route." },
      { label: "Cost driver", left: "Gateway: none. Interface: endpoint hours and GB processed.", right: "NAT hours and data processing per GB." },
      { label: "Policy", left: "Endpoint policy applies, plus the service resource policy.", right: "Endpoint policy does not apply; identity and resource policies still do." },
    ],
  },
  {
    type: "p",
    text: "The diagnostic value is in the split. If S3 traffic is still large on the NAT gateway after a gateway endpoint is created, the route table is probably not associated with the endpoint, or the workload is using an address range that the prefix list does not cover. If NAT volume is zero but requests fail, the endpoint is in the path and the denial is at the endpoint policy, the security group, or the service resource policy.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "An endpoint type selector, a private-path switch, and an endpoint-policy switch.",
      "Traffic split between the private endpoint and the NAT gateway, in GB per day.",
      "Service success and policy-denied requests as separate metrics, because a denial is not a routing failure.",
      "A path that changes between endpoint and NAT as you toggle the private path.",
      "Presets for a healthy gateway endpoint, a bypassed endpoint, a policy denial, peak interface traffic, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy: the gateway endpoint carries the traffic and NAT volume is zero. Apply Bypassed endpoint and notice that service success stays at 100% while NAT volume jumps. Then apply Policy denial: NAT volume is zero and success collapses. That pair separates a path problem from an access problem. Run the experiment before revealing its explanation.",
  },
  {
    type: "p",
    text: "Traffic volumes are illustrative teaching values, not forecasts or prices. The model intentionally reports GB per day instead of currency, because NAT and PrivateLink prices vary by Region and change over time. The routing, policy, and endpoint-type behavior follows the AWS documentation.",
  },
  { type: "sim", simId: "endpoint-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With the gateway endpoint associated and its policy allowing the action, all service traffic used the private path and NAT volume was zero. The endpoint was a route-table target, not a proxy: the route selected it because the service prefix list was more specific than the default route.",
  },
  {
    type: "p",
    text: "When the route table was not associated, the endpoint still existed but the traffic did not use it. Service success stayed at 100% through NAT, while NAT volume rose to the full offered load. That is the expensive failure: nothing is down, but the endpoint is doing no work and the NAT bill grows.",
  },
  {
    type: "p",
    text: "When the endpoint was in the path but the policy denied the action, the opposite signal appeared. NAT volume stayed at zero, private-path share was 100%, and success fell to zero. The traffic was captured by the endpoint and denied there. It did not detour around the policy.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route tables: a gateway endpoint adds a route whose destination is the service prefix list and whose target is the endpoint. The route is managed by the endpoint association.",
      "Endpoint policy: a resource-based policy on the endpoint. The default allows all; a custom policy can deny an action even when the identity policy allows it.",
      "Interface endpoint ENIs: one per selected subnet, with a security group. The endpoint's private DNS name resolves the service name to those addresses when private DNS is enabled.",
      "NAT metrics: data processed per NAT gateway. A high value after an endpoint rollout is evidence that some subnet or address range is still on the NAT path.",
      "Service resource policy: an S3 bucket policy can require a specific endpoint with aws:SourceVpce, which turns a bypassed endpoint into an access denial.",
      "DNS: private DNS requires DNS support and DNS hostnames on the VPC. Without it, the service name can still resolve publicly and the traffic can take the NAT path.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Decide which path the request actually took before changing anything. Compare endpoint bytes processed with NAT data processed. If NAT is high, fix the route association or private DNS. If NAT is zero and requests fail, read the endpoint policy, then the endpoint security group or instance security group, then the service resource policy.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the service, the source subnet, and whether the endpoint is a gateway or interface endpoint.",
      "For a gateway endpoint, confirm the subnet's route table is associated with the endpoint and has the service prefix-list route.",
      "For an interface endpoint, confirm private DNS is enabled and the VPC has DNS support and hostnames on, or use the endpoint-specific DNS name.",
      "If the path is correct but requests fail, read the endpoint policy and the service resource policy. A denial at the endpoint does not fall back to NAT.",
      "Check the security group on the endpoint ENI for an interface endpoint, or the instance security group and network ACL for a gateway endpoint.",
      "Retest from the workload and compare endpoint and NAT volume again.",
      "Add an alarm for NAT data processed by subnet or VPC, and for endpoint policy denials.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Gateway endpoints are free and simple for S3 and DynamoDB inside a VPC, but they do not serve on-premises, cross-Region peering, or transit gateway traffic.",
      "Interface endpoints work for more services and support security groups, but they add per-AZ endpoint hours, per-GB processing, and ENI IP consumption.",
      "Private DNS keeps application code unchanged, but it changes name resolution for the VPC and can surprise a workload that expected the public endpoint.",
      "A strict endpoint policy narrows access, but it can block a legitimate action without any NAT fallback. Test the policy with the real principal and action.",
      "Keeping the NAT path as a fallback sounds safer, but it can hide a bypassed endpoint and preserve the cost you were trying to remove.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-endpoint-type",
    question:
      "A private subnet needs to reach S3 and a second AWS API. Which endpoint types do you choose, and what changes in the subnet?",
    difficulty: 2,
    hints: [
      "S3 has a gateway option that other services do not.",
      "Interface endpoints use DNS and security groups.",
    ],
    answer:
      "I would use a gateway endpoint for S3 if the traffic stays inside the VPC and the subnets can use the associated route tables. That adds a prefix-list route to the gateway endpoint and has no additional charge. For the second AWS API, I would use an interface endpoint unless it also supports a gateway endpoint. The interface endpoint creates an ENI per selected subnet, needs a security group that allows the workload, and needs private DNS if the application should keep using the service's Regional name. If the S3 traffic comes from on-premises or a transit gateway, the gateway endpoint will not work and I would use an interface endpoint for S3 too.",
    followUps: [
      "What route does the gateway endpoint add?",
      "Why would an interface endpoint need a security group?",
      "When would you keep the NAT gateway?",
    ],
    redFlags: [
      "Uses a gateway endpoint for every AWS service.",
      "Forgets the route-table association.",
      "Assumes an interface endpoint needs no security group.",
    ],
    rubric: [
      "Picks gateway for S3 and interface for the general API.",
      "Names the route-table association.",
      "Names ENIs and security groups.",
      "Considers source network and hybrid access.",
    ],
  },
  {
    id: "nat-still-high",
    question:
      "After creating a gateway endpoint, NAT data processed is still high for S3 traffic. What do you check, and what would explain it?",
    difficulty: 2,
    hints: [
      "The endpoint route is added by association, not by creation alone.",
      "Prefix lists are Regional.",
    ],
    answer:
      "I would check whether the private subnet's route table is associated with the gateway endpoint. Creating the endpoint does not automatically add the route to every route table; the association does. I would also check whether the workload is using an S3 endpoint in another Region, because prefix lists are Regional, or an address range that the prefix list does not cover. If the traffic comes from on-premises, a peered VPC in another Region, or a transit gateway, a gateway endpoint cannot carry it. Finally, I would confirm the workload is not using a custom DNS setup that resolves S3 to a public address outside the endpoint path.",
    followUps: [
      "How would you find which subnets still use NAT?",
      "What does a prefix list contain?",
      "Which endpoint type would you use for on-premises S3 access?",
    ],
    redFlags: [
      "Assumes the endpoint route is global.",
      "Checks only the endpoint policy.",
      "Ignores cross-Region or hybrid traffic.",
    ],
    rubric: [
      "Checks route-table association.",
      "Explains Regional prefix lists.",
      "Considers hybrid and cross-Region sources.",
      "Uses NAT metrics to localize the bypass.",
    ],
  },
  {
    id: "policy-denial",
    question:
      "An endpoint policy denies an action. Does the request fail or use the NAT gateway? What does the NAT metric show?",
    difficulty: 3,
    hints: [
      "The endpoint route wins for the service prefix.",
      "The endpoint policy is evaluated only on the endpoint path.",
    ],
    answer:
      "The request fails at the endpoint. The endpoint route is more specific than the default route, so the traffic is captured before it can reach NAT. The endpoint policy then denies the action. The NAT metric shows no increase for that traffic, which is the clue that separates a policy denial from a routing bypass. I would fix the endpoint policy or the service resource policy, not the route. If the request were on the NAT path, the endpoint policy would not apply at all.",
    followUps: [
      "How would you prove the request reached the endpoint?",
      "What if the S3 bucket policy also requires the endpoint?",
      "Would an interface endpoint behave the same way?",
    ],
    redFlags: [
      "Says the request falls back to NAT.",
      "Changes the route before reading the policy.",
      "Confuses the endpoint policy with the bucket policy.",
    ],
    rubric: [
      "States that the request is denied at the endpoint.",
      "Explains the more-specific route.",
      "Uses zero NAT volume as evidence.",
      "Separates endpoint and resource policies.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every private subnet's route table and endpoint associations are inventoried.",
      "Gateway endpoints are associated with the route tables of every subnet that needs the service.",
      "Interface endpoints have private DNS, security groups, and subnets in at least two AZs.",
      "Endpoint policies are scoped and tested with the real principals and actions.",
      "NAT data processed is alarmed by VPC or subnet so a bypass is visible.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare endpoint and NAT volume to decide which path the request used.",
      "Check the route-table association for a gateway endpoint.",
      "Check private DNS, the endpoint ENI security group, and the endpoint policy for an interface endpoint.",
      "Check the service resource policy before changing the endpoint policy.",
      "Record whether the failure is path, policy, or capacity.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Associate the missing route tables or correct private DNS, then re-test from the workload.",
      "Review endpoint policy changes with the service owner.",
      "Confirm the NAT volume fell for the intended traffic and did not rise elsewhere.",
      "Update the runbook with the endpoint type and the path-selection rule.",
    ],
  },
];

const references = [
  {
    title: "Gateway endpoints",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "S3 and DynamoDB gateway endpoints, prefix-list routes, no additional charge, and route precedence.",
  },
  {
    title: "Configure an interface endpoint",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/interface-endpoints.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "One subnet per AZ, endpoint ENIs, security groups, endpoint policies, and private DNS.",
  },
  {
    title: "Control access to VPC endpoints using endpoint policies",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-access.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Endpoint policies are resource-based IAM policies; the default allows all actions.",
  },
  {
    title: "Access AWS services through AWS PrivateLink",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Interface endpoint AZ placement, DNS, private DNS, and per-AZ billing.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "endpoint-path": {
      model: vpcEndpointsModel,
      presets,
      instructions:
        "Start healthy, apply Bypassed endpoint, then Policy denial. Compare NAT volume and service success to tell a path problem from an access problem.",
      experimentIds: [experiment.id],
      note: "Illustrative volume model. GB/day values are teaching inputs; endpoint types, routes, and policy behavior follow AWS documentation.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-nat-gateway",
    "cloud-networking-s3-gateway-endpoint",
    "cloud-networking-privatelink",
    "cloud-networking-route-tables",
    "cloud-networking-security-groups",
  ],
};
