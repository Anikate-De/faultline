import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AZ_LABELS = ["A", "B", "C"];
const ENDPOINT_STATES = "PendingAcceptance, Pending, Available, Rejected, or Expired";

const params = [
  {
    id: "endpointAzs",
    label: "Endpoint Availability Zones",
    min: 1,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Availability Zones where the consumer selects a subnet and the provider publishes the service. One AZ leaves no endpoint path if that AZ is impaired.",
    format: "count" as const,
  },
  {
    id: "failedAz",
    label: "Impaired Availability Zone",
    min: 0,
    max: 3,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "0 means no AZ failure. 1, 2, or 3 marks AZ A, B, or C as impaired. An interface endpoint is zonal: the endpoint network interface in that AZ is lost.",
    format: "count" as const,
  },
  {
    id: "demand",
    label: "Offered requests",
    min: 500,
    max: 30_000,
    step: 500,
    value: 3_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second from consumer workloads to the endpoint service.",
    format: "rps" as const,
  },
  {
    id: "perAzCapacity",
    label: "Capacity per endpoint ENI",
    min: 1_000,
    max: 20_000,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Capacity",
    help: "Illustrative request capacity of one endpoint network interface. This is a teaching value, not a published PrivateLink limit.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  endpointAzs: number;
  failedAz: number;
  demand: number;
  perAzCapacity: number;
  healthyAzs: number;
  capacity: number;
  delivered: number;
  failed: number;
  connectivity: number;
  failureRate: number;
  utilization: number;
  consumerHealth: Health;
  endpointHealth: Health;
  serviceHealth: Health;
  targetHealth: Health;
}

function compute(p: Params): Computed {
  const endpointAzs = Math.max(1, Math.min(3, Math.round(num(p, "endpointAzs", 3))));
  const failedAz = Math.max(0, Math.min(3, Math.round(num(p, "failedAz", 0))));
  const demand = Math.max(1, num(p, "demand", 3_000));
  const perAzCapacity = Math.max(1, num(p, "perAzCapacity", 8_000));
  const lostAz = failedAz > 0 && failedAz <= endpointAzs ? 1 : 0;
  const healthyAzs = endpointAzs - lostAz;
  const capacity = healthyAzs * perAzCapacity;
  const delivered = Math.min(demand, capacity);
  const failed = demand - delivered;
  const connectivity = clamp((delivered / demand) * 100, 0, 100);
  const utilization = capacity > 0 ? clamp((delivered / capacity) * 100, 0, 100) : 0;
  const endpointHealth: Health =
    healthyAzs === 0
      ? "down"
      : utilization >= 95
        ? "crit"
        : utilization >= 80 || healthyAzs < endpointAzs
          ? "warn"
          : "ok";
  return {
    endpointAzs,
    failedAz,
    demand,
    perAzCapacity,
    healthyAzs,
    capacity,
    delivered,
    failed,
    connectivity,
    failureRate: clamp(100 - connectivity, 0, 100),
    utilization,
    consumerHealth: connectivity >= 95 ? "ok" : connectivity > 0 ? "warn" : "crit",
    endpointHealth,
    serviceHealth: healthyAzs === 0 ? "down" : "ok",
    targetHealth: delivered > 0 ? "ok" : "down",
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
    ["connectivity", values.connectivity, 0],
    ["failure-rate", values.failureRate, 0],
    ["failed-requests", values.failed, 1.2],
    ["endpoint-utilization", values.utilization, 1.1],
    ["delivered-requests", values.delivered, 6],
    ["endpoint-capacity", values.capacity, 0],
  ];
  for (const [id, value, amplitude] of rows) {
    frame.series[id] = Array.from({ length }, (_, index) =>
      id === "connectivity" || id === "failure-rate" || id === "endpoint-capacity"
        ? value
        : Math.max(0, value * jitter(index) + Math.sin(index / 2.2) * amplitude),
    );
  }
  frame.flags.seriesSeeded = 1;
}

function pathLabel(values: Computed): string {
  if (values.healthyAzs === 0) return "no endpoint network interface in a healthy AZ";
  if (values.connectivity >= 99.95) return "endpoint path delivering";
  return "endpoint path at capacity";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const v = compute(p);
  const lostLabel = v.failedAz > 0 ? `AZ ${AZ_LABELS[v.failedAz - 1]} impaired` : "all AZs available";
  const endpointDetail =
    v.healthyAzs === 0
      ? "The endpoint has no network interface in a healthy Availability Zone. The endpoint service may still be available in other AZs, but this consumer has no path to it."
      : `The consumer has endpoint network interfaces in ${v.healthyAzs} healthy AZ${v.healthyAzs === 1 ? "" : "s"}. PrivateLink traffic enters there and is forwarded to the provider's Network Load Balancer.`;
  return {
    t: 0,
    nodes: [
      {
        id: "consumer",
        label: "consumer VPC",
        kind: "service",
        health: v.consumerHealth,
        sublabel: `10.0.0.0/16 · ${formatCount(v.demand)} rps`,
        detail: `The consumer initiates every request. PrivateLink does not let the provider initiate a connection back into the consumer VPC. ${formatCount(
          v.failed,
        )} requests per second fail in this state.`,
        meta: { view: "flow" },
      },
      {
        id: "endpoint",
        label: "interface endpoint",
        kind: "external",
        health: v.endpointHealth,
        utilization: v.utilization / 100,
        throughput: v.delivered,
        capacity: v.capacity,
        sublabel: `${v.endpointAzs} AZ${v.endpointAzs === 1 ? "" : "s"} · ${lostLabel}`,
        detail: endpointDetail,
        meta: { view: "flow", healthyAzs: v.healthyAzs, endpointAzs: v.endpointAzs },
      },
      {
        id: "service",
        label: "endpoint service",
        kind: "external",
        health: v.serviceHealth,
        sublabel: "Network Load Balancer",
        detail:
          "The provider owns the endpoint service and backs it with a Network Load Balancer. The service is available only in the AZs where the load balancer has subnets. Consumer and provider AZ names can map to different physical zones, so compare AZ IDs when they differ.",
        meta: { view: "flow" },
      },
      {
        id: "target",
        label: "provider target",
        kind: "service",
        health: v.targetHealth,
        sublabel: v.delivered > 0 ? "receiving traffic" : "no traffic",
        detail:
          "The load balancer forwards to registered targets. PrivateLink changes how the consumer reaches the load balancer; it does not health-check or scale the target for you.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("consumer-endpoint", "consumer", "endpoint", v.demand > 0 ? v.connectivity / 100 : 0, v.consumerHealth),
      edge("endpoint-service", "endpoint", "service", v.demand > 0 ? v.connectivity / 100 : 0, v.endpointHealth),
      edge("service-target", "service", "target", v.demand > 0 ? v.connectivity / 100 : 0, v.serviceHealth),
    ],
    metrics: [
      metric("connectivity", "End-to-end connectivity", v.connectivity, "%", undefined, undefined, "percent"),
      metric("failure-rate", "End-to-end failures", v.failureRate, "%", 0.1, 5, "percent"),
      metric("failed-requests", "Failed requests", v.failed, " rps", 10, 100, "rps"),
      metric("endpoint-utilization", "Endpoint utilization", v.utilization, "%", 80, 95, "percent"),
      metric("delivered-requests", "Delivered requests", v.delivered, " rps", undefined, undefined, "rps"),
      metric("endpoint-capacity", "Healthy endpoint capacity", v.capacity, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, endpointAzs: v.endpointAzs, failedAz: v.failedAz },
    summary: `${formatCount(v.demand)} rps offered; ${formatPercent(v.connectivity)}% delivered; ${pathLabel(v)}; ${
      v.endpointAzs
    } AZ${v.endpointAzs === 1 ? "" : "s"}; ${lostLabel}.`,
  };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failure-rate",
    metricId: "failure-rate",
    warn: 99.9,
    crit: 95,
    title: "The PrivateLink path is not delivering requests",
    cause:
      "The endpoint has no usable network interface, the connection was rejected, or the endpoint policy blocks the request. An endpoint network interface exists only in the AZs where the consumer selected a subnet and the provider publishes the service.",
    fix:
      "Check the endpoint state and the provider's endpoint service first, then the endpoint subnets and their AZs. Add a second AZ before treating a single-AZ design as highly available.",
    checkFirst: [
      "Read the VPC endpoint state: PendingAcceptance, Available, Rejected, or Expired.",
      "Compare the endpoint subnets with the Availability Zones where the endpoint service is available.",
      "Check the endpoint security group and endpoint policy for a denied request.",
    ],
  },
  {
    id: "failed-requests",
    metricId: "failed-requests",
    warn: 10,
    crit: 100,
    title: "Consumer requests have nowhere to go",
    cause:
      "The endpoint lost its only path, or the remaining endpoint interfaces cannot carry the offered load. Provider targets may also be failing behind the load balancer.",
    fix:
      "Restore the missing AZ path or spread the endpoint across at least two AZs. If the path exists, check the load balancer target health and the target capacity.",
    checkFirst: [
      "Confirm the request reaches the endpoint network interface.",
      "Check the endpoint service connection state from the consumer account.",
      "Check target health behind the provider's Network Load Balancer.",
    ],
  },
  {
    id: "endpoint-utilization",
    metricId: "endpoint-utilization",
    warn: 80,
    crit: 95,
    title: "The remaining endpoint interfaces are saturated",
    cause:
      "After an AZ loss, the surviving endpoint interfaces carry the full request rate. Each interface has finite capacity, and the load balancer and targets add their own limits.",
    fix:
      "Add endpoint subnets in more AZs, reduce the request rate, or scale the provider targets. A single endpoint interface is a single zonal path even when the service is regional.",
    checkFirst: [
      "Check whether one AZ failure removed an endpoint interface.",
      "Compare delivered requests with the healthy endpoint capacity.",
      "Check the provider load balancer and target metrics before adding consumer capacity.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const privateLinkModel: SimModel = {
  id: "cloud-networking-privatelink",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, compute(defaults()), seed);
    return frame;
  },
  step: (frame, p) => {
    const v = compute(p);
    const previousAz = Number(frame.flags.failedAz ?? -1);
    const previousCoverage = Number(frame.flags.endpointAzs ?? -1);
    const next = buildFrame(p, Number(frame.flags.seed ?? 20261110));
    next.t = frame.t;
    next.series = frame.series;
    next.events = [...frame.events].slice(-60);
    next.flags = { ...frame.flags, ...next.flags };
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    if (previousAz !== -1 && previousAz !== v.failedAz) {
      pushEvent(next, {
        id: "privatelink-az-change",
        severity: v.failedAz > 0 ? (v.healthyAzs === 0 ? "crit" : "warn") : "info",
        title:
          v.failedAz > 0
            ? `Availability Zone ${AZ_LABELS[v.failedAz - 1]} is impaired`
            : "All Availability Zones are available",
        detail:
          v.failedAz > 0
            ? `An interface endpoint has a network interface in each selected AZ. The interface in AZ ${AZ_LABELS[v.failedAz - 1]} is lost; traffic must use the remaining interfaces or fail.`
            : "Endpoint interfaces are available again. Confirm that the endpoint still spans every AZ where the provider publishes the service.",
        nodeId: "endpoint",
        metricId: "connectivity",
      });
    }
    if (previousCoverage !== -1 && previousCoverage !== v.endpointAzs) {
      pushEvent(next, {
        id: "privatelink-coverage-change",
        severity: v.endpointAzs >= 2 ? "info" : "warn",
        title:
          v.endpointAzs >= 2
            ? `Endpoint now spans ${v.endpointAzs} Availability Zones`
            : "Endpoint is confined to one Availability Zone",
        detail:
          v.endpointAzs >= 2
            ? "A zonal failure leaves at least one endpoint network interface, but the remaining interfaces must absorb the traffic."
            : "A single endpoint interface is a single failure domain. If that AZ is impaired, the consumer has no private path even when the provider's service is healthy elsewhere.",
        nodeId: "endpoint",
        metricId: "endpoint-utilization",
      });
    }
    next.flags.endpointAzs = v.endpointAzs;
    next.flags.failedAz = v.failedAz;
    next.summary = `${formatCount(v.demand)} rps offered; ${formatPercent(v.connectivity)}% delivered; ${pathLabel(v)}; ${
      v.endpointAzs
    } AZ${v.endpointAzs === 1 ? "" : "s"}; ${
      v.failedAz > 0 ? `AZ ${AZ_LABELS[v.failedAz - 1]} impaired` : "all AZs available"
    }.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const v = compute(p);
    const items: string[] = [];
    if (v.healthyAzs === 0) {
      items.push(
        `The endpoint has no network interface in a healthy AZ. The provider may still publish the service, but this consumer selected a subnet only in AZ ${AZ_LABELS[
          v.failedAz - 1
        ]}, which is impaired.`,
      );
    } else if (v.connectivity < 99.95) {
      items.push(
        `Only ${formatCount(v.capacity)} rps fit through the ${v.healthyAzs} healthy endpoint interface${
          v.healthyAzs === 1 ? "" : "s"
        }. The offered load is ${formatCount(v.demand)} rps, so ${formatCount(v.failed)} rps fail.`,
      );
    } else {
      items.push(
        `The endpoint spans ${v.healthyAzs} healthy AZ${v.healthyAzs === 1 ? "" : "s"} and carries ${formatCount(
          v.delivered,
        )} rps. The provider's load balancer and target health still determine whether each request succeeds.`,
      );
    }
    items.push(
      "PrivateLink is one-way: the consumer initiates, and the provider cannot initiate a connection back through the endpoint.",
    );
    items.push(
      "A consumer sees only the AZs it has in common with the provider. AZ names can differ between accounts, so compare AZ IDs when the mapping matters.",
    );
    items.push(
      `The endpoint is billed per hour for each AZ where it is provisioned and per GB processed. Adding AZs improves availability and increases the endpoint footprint. Endpoint states include ${ENDPOINT_STATES}.`,
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
    description: "Three AZs, no failure, and low utilization across three endpoint interfaces.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Three AZs carry 20,000 rps at about 83% of their illustrative capacity.",
    tone: "warn",
    params: defaults({ demand: 20_000 }),
  },
  {
    id: "failure",
    label: "Single-AZ failure",
    description: "The endpoint was created in one AZ, and that AZ is impaired. No endpoint interface remains.",
    tone: "crit",
    params: defaults({ endpointAzs: 1, failedAz: 1, demand: 3_000 }),
  },
  {
    id: "thin",
    label: "Thin path",
    description: "One AZ is healthy but carries 87% of its illustrative capacity. There is no zonal spare.",
    tone: "warn",
    params: defaults({ endpointAzs: 1, demand: 7_000 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The endpoints span three AZs again and utilization is low.",
    tone: "ok",
    params: defaults({ endpointAzs: 3, failedAz: 0, demand: 3_000 }),
  },
];

const experiment: Experiment = {
  id: "predict-single-az-endpoint",
  title: "One AZ, one endpoint interface",
  simId: "privatelink-path",
  question:
    "A consumer creates an interface endpoint in one subnet in AZ A. The endpoint service is available in AZ A, B, and C. AZ A is impaired. What happens to a workload in AZ B that uses the endpoint's Regional DNS name?",
  prediction: {
    options: [
      { id: "automatic-failover", label: "It fails over to an endpoint network interface in AZ B." },
      { id: "cross-az", label: "It reaches the endpoint network interface in AZ A, so it keeps working." },
      { id: "no-path", label: "It loses the private path because the endpoint has no network interface outside AZ A." },
      { id: "public-fallback", label: "It falls back to the public service endpoint automatically." },
    ],
    correctOptionId: "no-path",
    explanation:
      "The endpoint has a network interface only in the subnets the consumer selected. The provider publishing the service in AZ B and C does not create a consumer interface there. Losing AZ A removes the only endpoint path, even for a client in AZ B.",
  },
  setup: defaults({ endpointAzs: 1, failedAz: 1, demand: 3_000, perAzCapacity: 8_000 }),
  runFor: 15,
  observe: [
    "The endpoint has no healthy network interface; its state is unavailable.",
    "End-to-end connectivity is 0%, and every offered request fails.",
    "The provider's endpoint service can still exist in other AZs; the consumer has no path to it.",
    "Adding subnets in AZ B and C before the failure gives the endpoint something to survive on.",
    "PrivateLink does not fall back to the public service endpoint or to VPC peering.",
  ],
  explain:
    "An interface endpoint is built from endpoint network interfaces, one per selected subnet and AZ. The provider's service availability defines where those interfaces can exist, but it does not create them for the consumer. A single-AZ endpoint is a single zonal path. The fix is to select subnets in at least two AZs, ideally three, and to confirm that the provider publishes the service in those AZs.",
  fix: defaults({ endpointAzs: 3, failedAz: 0, demand: 3_000 }),
  debrief:
    "The provider's multi-AZ service did not make the consumer's endpoint multi-AZ. Endpoint coverage is a consumer-side decision. After the fix, one AZ can fail and the remaining endpoint interfaces carry traffic, at the cost of more endpoint hours and more cross-AZ traffic.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "AWS PrivateLink connects a consumer to a service through a private IP address in the consumer virtual private cloud (VPC). It does not need an internet gateway, NAT device, public IP address, virtual private network (VPN) connection, or VPC peering connection. That last point matters: the two VPCs do not need non-overlapping Classless Inter-Domain Routing (CIDR) blocks, because PrivateLink does not route between their address spaces. The consumer reaches an endpoint network interface in its own subnet, and AWS carries the traffic to the provider.",
  },
  {
    type: "p",
    text: "The provider creates an endpoint service backed by a Network Load Balancer (NLB). The consumer creates an interface VPC endpoint for that service. The endpoint has an endpoint network interface in each subnet the consumer selects, with a private IP address from that subnet. The endpoint service is available in the Availability Zones (AZs) where the provider's load balancer has subnets. The consumer can select only AZs that it has in common with the provider, and AZ names can map to different physical zones in different accounts, so compare AZ IDs when that matters.",
  },
  {
    type: "p",
    text: "PrivateLink is directional. The consumer initiates connections; the provider cannot initiate a connection back into the consumer VPC through the endpoint. The provider also does not see the consumer's private IP addresses by default: the source addresses at the target are the load balancer nodes' private addresses. Proxy protocol can carry the original addresses if the provider enables it.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is consumer workload, endpoint network interface, PrivateLink, provider NLB, target. Each step has an owner and a state. The consumer owns the endpoint, its subnets, its security group, and its endpoint policy. The provider owns the endpoint service, its permissions, the load balancer, and the targets. A failure in any of those layers looks similar from the application: a timeout or a refused connection.",
  },
  {
    type: "table",
    headers: ["Layer", "What must be true", "Typical failure signal"],
    rows: [
      ["Endpoint service", "Available, with permissions for the consumer principal.", "Connection request pending, rejected, or expired."],
      ["Endpoint", "Available, with an interface in a healthy AZ.", "No endpoint interface in the client's path; endpoint state not Available."],
      ["Endpoint policy", "Allows the principal, action, and resource.", "Access denied at the endpoint before the provider is reached."],
      ["Provider NLB", "Healthy target in the endpoint's AZ; listener and target group match.", "Target health checks fail; connection resets."],
    ],
  },
  {
    type: "compare",
    leftTitle: "PrivateLink",
    rightTitle: "VPC peering",
    rows: [
      { label: "Address space", left: "No CIDR overlap requirement; the service is reached through an endpoint IP.", right: "CIDRs must not overlap." },
      { label: "Direction", left: "Consumer initiates; the provider cannot initiate back through the endpoint.", right: "Routing is bidirectional once both route tables are correct." },
      { label: "Exposure", left: "Only the published service is reachable, not the provider's whole VPC.", right: "The route exposes address ranges, and security groups and ACLs must narrow access." },
      { label: "Routing", left: "No route to the provider VPC; DNS resolves the endpoint.", right: "Both VPCs need routes to each other's CIDR." },
    ],
  },
  {
    type: "p",
    text: "That comparison is the design test. If the requirement is to expose one service to many consumers, including consumers you do not control, PrivateLink gives a narrow contract and avoids a mesh of routes. If the requirement is broad bidirectional communication between two networks you own, peering or a transit gateway is usually simpler.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Endpoint AZ coverage and an AZ failure selector, showing that zonal endpoint interfaces are the unit of availability.",
      "End-to-end connectivity and failed requests, separate from endpoint utilization.",
      "The endpoint, endpoint service, and provider target as separate nodes, because they fail independently.",
      "A utilization metric that rises when one AZ is lost and the surviving interfaces absorb the load.",
      "Presets for healthy, peak, a single-AZ failure, a thin path, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start with Healthy and read the endpoint node: three AZs, low utilization. Apply Single-AZ failure and watch connectivity go to zero even though the provider's service is regional. Then recover and apply Thin path to see a healthy but fragile single-AZ endpoint. Raise the offered load at peak to separate a coverage failure from a capacity failure. Run the experiment before revealing its explanation.",
  },
  {
    type: "p",
    text: "The capacity per endpoint network interface is an illustrative teaching value, not a published PrivateLink limit. AWS bills interface endpoints per hour for each AZ where they are provisioned and per GB processed; the model does not convert those charges into currency. The endpoint states shown in the interface are the real AWS states.",
  },
  { type: "sim", simId: "privatelink-path" },
  { type: "experiment", experimentId: experiment.id },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With one endpoint AZ, an AZ failure removed the endpoint's only network interface. Connectivity went to zero for every consumer, including clients in the other AZs, because they had no endpoint interface to resolve to. The provider's service could still be healthy in AZ B and C; that did not create a consumer-side path.",
  },
  {
    type: "p",
    text: "With three endpoint AZs, the same failure removed one interface and left two. Connectivity stayed at 100% while the endpoint utilization rose to about one third of its original headroom. That is the resilience difference: endpoint coverage is a consumer decision, and it is separate from the provider's AZ coverage.",
  },
  {
    type: "p",
    text: "The thin-path preset showed a third signal. One endpoint interface was healthy but close to its illustrative capacity, so a burst would fail even without an AZ failure. Coverage and capacity are different risks, and the dashboard needs both the AZ count and the utilization.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "VPC endpoint state: PendingAcceptance means the provider has not accepted the connection; Rejected and Expired are terminal for that request.",
      "Endpoint subnets: one subnet per AZ, with an endpoint network interface in each. A subnet in an AZ where the service is unavailable does not give you a path.",
      "Endpoint service AZs: the provider's NLB subnets define where the service is available. Cross-account AZ names can differ; compare AZ IDs.",
      "Endpoint policy: an IAM resource policy on the endpoint. The default allows all actions by all principals, which is rarely the intent for a shared endpoint.",
      "Security groups: the endpoint network interface's security group controls traffic from the consumer VPC. The provider's NLB security group and target security groups are separate.",
      "DNS: the endpoint has Regional and zonal DNS names. Private DNS, when enabled, points the service's public name at the endpoint interfaces and requires DNS support and hostnames in the VPC.",
      "Provider side: NLB target health, listener rules, and target capacity. A healthy endpoint can still deliver errors if the target is unhealthy.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the endpoint state and whether it has an interface in a healthy AZ. Then check the endpoint service's state and the connection acceptance in the provider account. Only then look at the endpoint policy, security groups, and provider target health. Do not start by widening a security group or adding a route: PrivateLink does not use a route to the provider VPC.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the endpoint state and the AZs where it has network interfaces. Note which AZ the failing clients use.",
      "Confirm the provider publishes the endpoint service in those AZs and that the connection is accepted.",
      "Add endpoint subnets in at least two AZs, ideally three, before the next zonal failure. Verify the subnets have free IP addresses.",
      "If the endpoint is healthy but errors persist, check the endpoint policy for a denied principal or action.",
      "Check the endpoint security group, then the provider's NLB target health and target capacity.",
      "Test with a real request from a workload in each AZ. A DNS answer alone does not prove the path.",
      "Record the endpoint AZ coverage and add an alarm for endpoint state and healthy interface count.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "More endpoint AZs improve availability but add per-AZ endpoint hours and cross-AZ traffic. Two AZs are the usual minimum; three match a typical multi-AZ workload.",
      "PrivateLink keeps the provider's network private and avoids CIDR coordination, but it exposes only the published service and adds endpoint and data-processing charges.",
      "VPC peering is simpler for two networks you own and need broad bidirectional access, but it requires non-overlapping CIDRs and route and security review on both sides.",
      "Private DNS keeps existing SDK calls unchanged, but it changes name resolution for the whole VPC and depends on DNS support and hostnames being enabled.",
      "Accepting connections manually gives the provider control, but it adds an operational step and a PendingAcceptance failure mode. Automatic acceptance is faster and less selective.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "privatelink-vs-peering",
    question:
      "A provider offers a service in its own VPC. Your VPC CIDR overlaps theirs. Do you use VPC peering or PrivateLink, and why?",
    difficulty: 2,
    hints: [
      "Peering routes between address spaces.",
      "PrivateLink exposes a service through an endpoint in your subnet.",
    ],
    answer:
      "I would use PrivateLink. VPC peering requires non-overlapping CIDRs and routes in both VPCs, so an overlap blocks it or forces a re-address. PrivateLink does not route between the VPC address spaces: the consumer creates an interface endpoint with a private IP in its own subnet, and AWS carries traffic to the provider's endpoint service. It also narrows what is reachable to the published service rather than the provider's whole VPC. I would confirm the provider supports PrivateLink, that the service is available in the AZs I need, and that the connection is accepted.",
    followUps: [
      "What does the provider see as the source IP address?",
      "When would peering still be the better choice?",
      "How does PrivateLink handle AZ selection?",
    ],
    redFlags: [
      "Says peering works with overlapping CIDRs.",
      "Treats PrivateLink as a routed network connection.",
      "Ignores endpoint AZ coverage.",
    ],
    rubric: [
      "Names the CIDR-overlap constraint.",
      "Explains the endpoint-in-subnet model.",
      "Mentions the narrow service exposure.",
      "Checks provider support and AZs.",
    ],
  },
  {
    id: "single-az-endpoint",
    question:
      "An interface endpoint is Available and the provider's service is in three AZs, but an AZ failure takes down every consumer request. What did the consumer likely do wrong?",
    difficulty: 3,
    hints: [
      "The endpoint service's AZs are not the endpoint's AZs.",
      "Look at the endpoint subnets.",
    ],
    answer:
      "The consumer probably created the endpoint in only one AZ, or in a subnet in the AZ that failed. The endpoint has an endpoint network interface only in the subnets the consumer selected. The provider publishing the service in three AZs does not create consumer interfaces in the other two. When the selected AZ is impaired, the endpoint has no healthy interface, so every client loses the path even if the provider's load balancer is healthy elsewhere. I would check the endpoint's subnet list and add subnets in at least two AZs, then verify the provider supports those AZs.",
    followUps: [
      "What changes in the endpoint's DNS answers when you add an AZ?",
      "Would a zonal DNS name help here?",
      "How would you test the fix without waiting for a failure?",
    ],
    redFlags: [
      "Assumes the provider's AZ coverage is the consumer's coverage.",
      "Blames the endpoint policy first.",
      "Suggests adding a route to the provider VPC.",
    ],
    rubric: [
      "Separates endpoint AZs from service AZs.",
      "Names the endpoint network interface per subnet.",
      "Adds at least two AZs.",
      "Tests from each AZ.",
    ],
  },
  {
    id: "pending-acceptance",
    question:
      "The endpoint is in PendingAcceptance. What does that mean, who acts, and what would you check before asking them to accept?",
    difficulty: 2,
    hints: [
      "The consumer created the connection request.",
      "The provider principal needs permission on the endpoint service.",
    ],
    answer:
      "PendingAcceptance means the consumer created the interface endpoint and the connection request is waiting for the provider. The provider must accept it, or the endpoint service must be configured to accept automatically. Before asking, I would confirm the consumer principal is allowed by the endpoint service permissions, that the service name and Region are correct, and that the requested AZs are ones the provider supports. If the request is rejected or expires, the consumer has to create a new endpoint rather than wait for the old one.",
    followUps: [
      "Which side owns the endpoint service permissions?",
      "What happens to an existing endpoint if the provider rejects the connection later?",
      "How would you automate acceptance safely?",
    ],
    redFlags: [
      "Says the consumer must accept its own request.",
      "Confuses the endpoint state with the endpoint service state.",
      "Ignores the provider's permissions.",
    ],
    rubric: [
      "Identifies the provider as the acceptor.",
      "Names the endpoint service permissions.",
      "Checks service name, Region, and AZs.",
      "Knows rejection requires a new request.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every interface endpoint has subnets in at least two AZs that the provider supports.",
      "The endpoint service owner, acceptance mode, and permissions are documented.",
      "Alarms cover endpoint state, healthy endpoint interfaces, and endpoint utilization.",
      "Endpoint policies are reviewed and scoped to the principals and actions that need them.",
      "A real request from each AZ is part of the deployment test.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check the endpoint state and its subnet/AZ list before changing security groups.",
      "Confirm the endpoint service is available and the connection is accepted in the provider account.",
      "Compare the failing client's AZ with the AZs where the endpoint has interfaces.",
      "Check the endpoint policy, then the endpoint security group, then the provider's target health.",
      "Record the endpoint and service state before making a change.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Restore endpoint coverage across AZs and re-test from every AZ.",
      "Review whether the failure was coverage, acceptance, policy, or provider capacity.",
      "Add an alarm for the endpoint interface count, not only the endpoint state.",
      "Update the runbook with the provider's escalation path and service name.",
    ],
  },
];

const references = [
  {
    title: "What is AWS PrivateLink?",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/what-is-privatelink.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Private connectivity without an internet gateway, NAT device, public IP, VPN, or peering.",
  },
  {
    title: "AWS PrivateLink concepts",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/concepts.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Endpoint services, endpoint network interfaces, endpoint policies, and connection states.",
  },
  {
    title: "Create a service powered by AWS PrivateLink",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/create-endpoint-service.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "NLB-backed endpoint services, service AZ availability, and acceptance requirements.",
  },
  {
    title: "Access AWS services through AWS PrivateLink",
    url: "https://docs.aws.amazon.com/vpc/latest/privatelink/privatelink-access-aws-services.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "One subnet per AZ, per-AZ endpoint interfaces, and the single-AZ availability warning.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "privatelink-path": {
      model: privateLinkModel,
      presets,
      instructions:
        "Start healthy, apply Single-AZ failure, then recover and apply Thin path. Compare coverage failures with capacity failures before changing the endpoint policy.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Per-interface capacity is a teaching value; endpoint states and AZ behavior are documented by AWS.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "cloud-networking-vpc-endpoints",
    "cloud-networking-peering-vs-tgw",
    "cloud-networking-nat-gateway",
    "cloud-networking-route-tables",
    "cloud-networking-security-groups",
  ],
};
