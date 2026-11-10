import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 30_000;

const params = [
  {
    id: "failedZones",
    label: "Failed Availability Zones",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Number of zones that fail, starting with zone A. Zero is no failure. Two out of three leaves one zone carrying the Region.",
    format: "count" as const,
  },
  {
    id: "azCount",
    label: "Availability Zones",
    min: 2,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Topology",
    help: "Zones the stack uses. An Application Load Balancer requires at least two; three is the common production baseline.",
    format: "count" as const,
  },
  {
    id: "headroom",
    label: "Per-zone capacity headroom",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Capacity",
    help: "Extra capacity in each zone above its even share of demand. With three zones, surviving two need at least 50% headroom to carry 100% after one fails.",
    format: "percent" as const,
  },
  {
    id: "sharedDependency",
    label: "Requests pinned to zone A",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Dependency",
    help: "Share of requests that need a component located only in zone A, such as a self-managed cache, queue leader, or egress path. If zone A fails, this share fails regardless of compute capacity.",
    format: "percent" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

interface Demand {
  failedZones: number;
  azCount: number;
  headroom: number;
  sharedDependency: number;
  healthyZones: number;
  perZoneCapacity: number;
  perZoneCapacityRps: number;
  remainingCapacity: number;
  capacityShortfall: number;
  dependencyLoss: number;
  failedDemand: number;
  errorRate: number;
  servedShare: number;
  demandPressure: number;
  servedRps: number;
  perHealthyZoneRps: number;
  servedUtilization: number;
}

function demand(p: Params): Demand {
  const azCount = Math.max(2, Math.round(num(p, "azCount", 3)));
  const failedZones = Math.min(azCount, Math.max(0, Math.round(num(p, "failedZones", 0))));
  const headroom = clamp(num(p, "headroom", 40), 0, 100);
  const sharedDependency = clamp(num(p, "sharedDependency", 0), 0, 100);
  const healthyZones = azCount - failedZones;
  const perZoneCapacity = (100 / azCount) * (1 + headroom / 100);
  const perZoneCapacityRps = (TOTAL_RPS / azCount) * (1 + headroom / 100);
  const remainingCapacity = healthyZones * perZoneCapacity;
  const capacityShortfall = Math.max(0, 100 - remainingCapacity);
  const dependencyLoss = failedZones > 0 ? sharedDependency : 0;
  const failedDemand = Math.min(100, capacityShortfall + dependencyLoss);
  const servedShare = 100 - failedDemand;
  const demandPressure = remainingCapacity > 0 ? (100 / remainingCapacity) * 100 : 200;
  const servedRps = (TOTAL_RPS * servedShare) / 100;
  const perHealthyZoneRps = healthyZones > 0 ? servedRps / healthyZones : 0;
  const servedUtilization =
    perZoneCapacityRps > 0 ? (perHealthyZoneRps / perZoneCapacityRps) * 100 : 0;

  return {
    failedZones,
    azCount,
    headroom,
    sharedDependency,
    healthyZones,
    perZoneCapacity,
    perZoneCapacityRps,
    remainingCapacity,
    capacityShortfall,
    dependencyLoss,
    failedDemand,
    errorRate: failedDemand,
    servedShare,
    demandPressure,
    servedRps,
    perHealthyZoneRps,
    servedUtilization,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function zoneName(index: number): string {
  return `AZ ${String.fromCharCode(65 + index)}`;
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const clientHealth = healthFor(d.errorRate, 0.5, 5);
  const albHealth =
    d.errorRate >= 5 ? "crit" : healthFor(d.servedUtilization, 90, 100);
  const dependencyHealth: "ok" | "warn" | "crit" =
    d.failedZones > 0 && d.sharedDependency >= 10
      ? "crit"
      : d.failedZones > 0 && d.sharedDependency > 0
        ? "warn"
        : "ok";
  const zoneNodes = Array.from({ length: d.azCount }, (_, index) => {
    const failed = index < d.failedZones;
    return {
      id: `az-${index}`,
      label: zoneName(index),
      kind: "service" as const,
      role: "zone" as const,
      health: failed ? ("down" as const) : healthFor(d.servedUtilization, 90, 100),
      utilization: failed ? 0 : clamp(d.servedUtilization / 100),
      throughput: failed ? 0 : d.perHealthyZoneRps,
      capacity: d.perZoneCapacityRps,
      sublabel: failed ? "unavailable" : `${formatCount(d.perHealthyZoneRps)} rps · ${d.servedUtilization.toFixed(0)}% of capacity`,
      detail: failed
        ? "This zone is unavailable. Its load balancer node, targets, and any local dependency are inside the failed boundary."
        : `Serving ${formatCount(d.perHealthyZoneRps)} rps of ${formatCount(d.perZoneCapacityRps)} rps illustrative capacity (${d.servedUtilization.toFixed(0)}% served). Regional demand pressure is ${d.demandPressure.toFixed(0)}%. The other healthy zones are not independent if a shared dependency sits in a failed zone.`,
      meta: { view: "flow" },
    };
  });

  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: TOTAL_RPS,
        sublabel: `${formatCount(TOTAL_RPS)} rps demand`,
        detail: `${d.errorRate.toFixed(1)}% of requests fail. ${d.failedZones === 0 ? "No zone is failed." : `${d.failedZones} zone${d.failedZones === 1 ? "" : "s"} failed.`}`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Regional ALB",
        kind: "lb",
        health: albHealth,
        utilization: clamp(d.servedUtilization / 100),
        throughput: d.servedRps,
        sublabel: `${d.healthyZones} of ${d.azCount} zones serving`,
        detail: `Application Load Balancer nodes are distributed across enabled zones. Cross-zone load balancing is enabled at the load balancer level; remaining targets are pooled. Demand pressure ${d.demandPressure.toFixed(0)}% of surviving capacity; capacity shortfall ${d.capacityShortfall.toFixed(1)}%, dependency loss ${d.dependencyLoss.toFixed(0)}%.`,
        meta: { view: "flow" },
      },
      ...zoneNodes,
      {
        id: "dependency",
        label: "Shared dependency",
        kind: "external",
        health: dependencyHealth,
        utilization: clamp(d.sharedDependency / 100),
        throughput: d.failedZones > 0 ? 0 : (d.servedRps * d.sharedDependency) / 100,
        sublabel: `${d.sharedDependency.toFixed(0)}% of requests`,
        detail:
          "A cache, queue leader, identity store, or egress path pinned to zone A. It is a single failure domain with a Region-wide name unless it is replicated per zone.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", 1, clientHealth),
      ...Array.from({ length: d.azCount }, (_, index) =>
        edge(
          `alb-az-${index}`,
          "alb",
          `az-${index}`,
          d.healthyZones > 0 ? 1 / d.healthyZones : 0,
          index < d.failedZones ? "down" : healthFor(d.servedUtilization, 90, 100),
        ),
      ),
      edge(
        "az-dependency",
        "az-0",
        "dependency",
        d.sharedDependency / 100,
        d.failedZones > 0 ? dependencyHealth : "ok",
      ),
    ],
    metrics: [
      metric("error-rate", "Failed requests", d.errorRate, "%", 1, 5, "percent"),
      metric("zone-demand-pressure", "Surviving-zone demand pressure", d.demandPressure, "%", 90, 100, "percent"),
      metric("capacity-shortfall", "Capacity shortfall", d.capacityShortfall, "%", 1, 10, "percent"),
      metric("dependency-loss", "Dependency loss", d.dependencyLoss, "%", 1, 10, "percent"),
      metric("remaining-capacity", "Remaining capacity", d.remainingCapacity, "%", undefined, undefined, "percent"),
      metric("served-rps", "Served requests", d.servedRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, failed: d.failedZones, zones: d.azCount, dependency: d.sharedDependency, paramsKey: "" },
    summary: `${d.failedZones} of ${d.azCount} zones failed; ${d.errorRate.toFixed(1)}% failed requests; surviving-zone demand pressure ${d.demandPressure.toFixed(0)}%; served utilization ${d.servedUtilization.toFixed(0)}%; capacity shortfall ${d.capacityShortfall.toFixed(1)}%; dependency loss ${d.dependencyLoss.toFixed(0)}%.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.015 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.985 + 0.03 * Math.sin((index + (seed % 6)) / 2.4)) +
          Math.sin(index / 2.1) * amplitude,
      ),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "One zone loss is failing requests",
    cause:
      "The surviving zones cannot serve the remaining demand. The gap can come from capacity sized only for an even share, or from a dependency pinned inside the failed zone. Those are different fixes.",
    fix:
      "Separate capacity shortfall from dependency loss first. Add per-zone headroom for capacity, or replicate the dependency across zones. Test the failure that removes a zone and its dependency, not only the compute.",
    checkFirst: [
      "Compare capacity shortfall with dependency loss; one is a sizing problem, the other is a correlation problem.",
      "Check healthy host count and target utilization per Availability Zone.",
      "List every dependency reachable from the failed zone, including NAT, cache, queue, and identity.",
    ],
  },
  {
    id: "zone-demand-pressure",
    metricId: "zone-demand-pressure",
    warn: 90,
    crit: 100,
    title: "Surviving-zone demand pressure is above safe capacity",
    cause:
      "Each zone was sized for its even share of demand, not for the loss of another zone. With three zones, losing one leaves two zones that need 50% more capacity each than their even share.",
    fix:
      "Size each zone for peak divided by the number of surviving zones, or add autoscaling that can reach that capacity inside each zone. Verify the quota and instance inventory support it.",
    checkFirst: [
      "Calculate peak demand divided by the number of zones that survive the failure.",
      "Check per-zone target count, CPU, and autoscaling headroom.",
      "Check whether cross-zone load balancing is masking stranded capacity in normal operation.",
    ],
  },
  {
    id: "capacity-shortfall",
    metricId: "capacity-shortfall",
    warn: 1,
    crit: 10,
    title: "The surviving zones cannot absorb the failed zone's demand",
    cause:
      "The capacity removed by the failed zone is larger than the headroom in the remaining zones. Cross-zone load balancing redistributes what exists; it does not create capacity.",
    fix:
      "Add per-zone capacity or reduce peak demand. Re-run the failure with the load balancer and the target group in the same state you expect during an incident.",
    checkFirst: [
      "Compare remaining capacity with total demand, not with the pre-failure average.",
      "Check whether autoscaling is configured per zone or only at the fleet level.",
      "Check whether the failed zone was carrying more than its share before it failed.",
    ],
  },
  {
    id: "dependency-loss",
    metricId: "dependency-loss",
    warn: 1,
    crit: 10,
    title: "A shared dependency crossed the zone boundary",
    cause:
      "Requests need a component that exists only in the failed zone. The application instances in the surviving zones are healthy, so the capacity math looks fine while the request path fails.",
    fix:
      "Replicate the dependency per zone, or move it to a regional service with its own multi-AZ design. Keep NAT egress, caches, queue leaders, and identity local or regional, and test the dependency failure explicitly.",
    checkFirst: [
      "Find the dependency called by every zone and check where it runs.",
      "Check NAT gateway, cache, queue, and database endpoints for a zonal resource.",
      "Check whether the last incident's failing component was shared across zones.",
    ],
  },
];

export const zonalIsolationModel: SimModel = {
  id: "zonal-isolation",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: key };
    next.events = [...frame.events].slice(-60);
    if (reset) {
      next.series = {};
      seedSeries(next, seed);
    } else {
      next.series = Object.fromEntries(
        Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
      );
    }
    const noise = rng.between(-0.003, 0.003);
    next.metrics = next.metrics.map((item) =>
      item.id === "served-rps" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (d.failedZones > Number(frame.flags.failed ?? 0)) {
      pushEvent(next, {
        id: "zone-failure",
        at: frame.t,
        severity: "crit",
        title: `${d.failedZones} Availability Zone${d.failedZones === 1 ? "" : "s"} failed`,
        detail: `${d.healthyZones} of ${d.azCount} zones remain. Each surviving zone needs ${(100 / Math.max(1, d.healthyZones)).toFixed(0)}% of total demand; it has ${d.perZoneCapacity.toFixed(0)}% of total capacity.`,
        nodeId: `az-${d.failedZones - 1}`,
        metricId: "error-rate",
      });
    }
    if (d.failedZones === 0 && Number(frame.flags.failed ?? 0) > 0) {
      pushEvent(next, {
        id: "zone-recovery",
        at: frame.t,
        severity: "info",
        title: "All Availability Zones are serving again",
        detail: "Capacity and dependencies are restored. Verify that the recovered zone is taking its share of traffic before closing the incident.",
        nodeId: "alb",
      });
    }
    if (d.failedZones > 0 && d.sharedDependency > 0 && frame.flags.depFailed !== 1) {
      pushEvent(next, {
        id: "dependency-failure",
        at: frame.t,
        severity: "crit",
        title: "The shared dependency is inside the failed zone",
        detail: `${d.sharedDependency.toFixed(0)}% of requests need a component pinned to zone A. The surviving application targets are healthy, but those requests still fail.`,
        nodeId: "dependency",
        metricId: "dependency-loss",
      });
      next.flags.depFailed = 1;
    }
    if (d.failedZones === 0 || d.sharedDependency === 0) next.flags.depFailed = 0;
    if (d.demandPressure >= 100 && frame.flags.overloaded !== 1) {
      pushEvent(next, {
        id: "surviving-zone-overload",
        at: frame.t,
        severity: "crit",
        title: "Surviving zones are over capacity",
        detail: `Surviving-zone demand pressure is ${d.demandPressure.toFixed(0)}% of safe capacity; served utilization is ${d.servedUtilization.toFixed(0)}%. Remaining capacity is ${d.remainingCapacity.toFixed(0)}% of demand.`,
        nodeId: "alb",
        metricId: "zone-demand-pressure",
      });
      next.flags.overloaded = 1;
    }
    if (d.demandPressure < 100) next.flags.overloaded = 0;
    next.flags.failed = d.failedZones;
    next.flags.zones = d.azCount;
    next.flags.dependency = d.sharedDependency;
    next.summary = `${d.failedZones} of ${d.azCount} zones failed; ${d.errorRate.toFixed(1)}% failed requests; surviving-zone demand pressure ${d.demandPressure.toFixed(0)}%; served utilization ${d.servedUtilization.toFixed(0)}%; capacity shortfall ${d.capacityShortfall.toFixed(1)}%; dependency loss ${d.dependencyLoss.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `${d.failedZones} of ${d.azCount} zones failed. Per-zone capacity is ${d.perZoneCapacity.toFixed(1)}% of total demand; surviving capacity is ${d.remainingCapacity.toFixed(1)}%.`,
    );
    items.push(
      `Capacity shortfall is ${d.capacityShortfall.toFixed(1)}% and dependency loss is ${d.dependencyLoss.toFixed(0)}%. The total error rate is their combined effect, capped at 100%.`,
    );
    items.push(
      `Surviving-zone demand pressure is ${d.demandPressure.toFixed(0)}%; served utilization is ${d.servedUtilization.toFixed(0)}% after dependency loss. The node cards show served utilization against per-zone capacity, not the demand multiple.`,
    );
    if (d.failedZones > 0) {
      items.push(
        `With ${d.azCount} zones, surviving ${d.healthyZones} need ${(100 / d.healthyZones).toFixed(0)}% of total demand. Each zone has ${(100 / d.azCount) * (1 + d.headroom / 100)}% of capacity, so ${d.headroom}% headroom ${d.demandPressure <= 100 ? "is enough" : "is not enough"}.`,
      );
    }
    if (d.sharedDependency > 0 && d.failedZones > 0) {
      items.push(
        `${d.sharedDependency.toFixed(0)}% of requests depend on a component in zone A. Cross-zone load balancing cannot route around a dependency that is not replicated.`,
      );
    }
    items.push(
      "Cross-zone load balancing pools targets across healthy zones. It redistributes capacity; it does not create capacity or make a zonal dependency regional.",
    );
    return items;
  },
  legend: [
    { label: "Serving", tone: "ok" },
    { label: "Degraded", tone: "warn" },
    { label: "Failing", tone: "crit" },
    { label: "Unavailable", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Three zones, no failure, 40% per-zone headroom. Surviving capacity is 140% of demand.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak, no failure",
    description: "Three zones at 10% headroom. Surviving-zone capacity is 110%; demand pressure is at the warning band.",
    tone: "warn",
    params: defaults({ failedZones: 0, azCount: 3, headroom: 10, sharedDependency: 0 }),
  },
  {
    id: "failure",
    label: "One zone lost",
    description: "One of three zones fails with no headroom. Demand pressure on the remaining zones reaches 150%.",
    tone: "crit",
    params: defaults({ failedZones: 1, azCount: 3, headroom: 0, sharedDependency: 0 }),
  },
  {
    id: "dependency",
    label: "Shared dependency",
    description: "One zone fails with 60% headroom, but 40% of requests need a component in that zone.",
    tone: "crit",
    params: defaults({ failedZones: 1, azCount: 3, headroom: 60, sharedDependency: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "All three zones are serving again with 75% headroom, enough to absorb the next zone loss.",
    tone: "ok",
    params: defaults({ failedZones: 0, azCount: 3, headroom: 75, sharedDependency: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-zone-loss-gap",
  title: "Predict why a zone loss fails more than the capacity math",
  simId: "zonal-isolation",
  question:
    "Three zones, 20% headroom, one zone fails. Remaining capacity covers 80% of demand, so the capacity shortfall is 20%. But 60% of requests fail. What explains the extra 40%?",
  prediction: {
    options: [
      { id: "dependency", label: "A shared dependency in the failed zone is needed by 40% of requests" },
      { id: "dns", label: "DNS TTL keeps clients on the failed zone for the whole incident" },
      { id: "cross-zone", label: "Cross-zone load balancing is disabled at the target group" },
      { id: "targets", label: "The surviving targets have fewer connections than the failed zone" },
    ],
    correctOptionId: "dependency",
    explanation:
      "Capacity shortfall and dependency loss are separate failures. With 20% headroom and one of three zones lost, remaining capacity is 80% of demand, so 20% fails on capacity. A dependency pinned to the failed zone can remove another 40% of requests even though the surviving application targets are healthy. Cross-zone load balancing moves requests across targets; it cannot move a component that only exists in the failed zone.",
  },
  setup: defaults({ failedZones: 1, azCount: 3, headroom: 20, sharedDependency: 40 }),
  runFor: 20,
  observe: [
    "Capacity shortfall is about 20%: 80% of demand remains.",
    "Dependency loss is 40%: those requests need a component in the failed zone.",
    "Total failed requests are 60%, not 20%.",
    "Surviving zones are at 125% of safe capacity, so they are also under pressure.",
  ],
  explain:
    "The capacity number answers only the compute question. The dependency number answers the request-path question. A zone is a failure domain for everything inside it: load balancer node, targets, NAT egress, cache, queue leader, and any control-plane dependency. Cross-zone load balancing only helps the target pool. It cannot route around a shared component that is not replicated.",
  fix: defaults({ failedZones: 1, azCount: 3, headroom: 60, sharedDependency: 0 }),
  debrief:
    "With 60% headroom and the dependency replicated per zone, one zone loss leaves 106.7% of demand capacity and no dependency loss. Failed requests return to zero. The fix was not one setting; it was per-zone capacity plus a per-zone dependency path. That is what zonal isolation means in practice.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Zonal isolation is the property that one Availability Zone (AZ) can fail without taking the workload with it. An AZ has independent power, cooling, and network connectivity, but a workload is only isolated if its load balancer node, targets, data, and dependencies are also independent inside each zone. A diagram with three zones proves nothing if every zone calls the same cache in zone A.",
  },
  {
    type: "p",
    text: "Two numbers are easy to confuse. Capacity loss is how much compute the failed zone removes. Blast radius is how much demand fails. With three equal zones, one failure removes one third of capacity. If each zone was sized for one third of peak, the surviving two zones cannot carry 100% of demand; they need 50% headroom each. That is the N+1 sizing rule for a one-zone loss.",
  },
  {
    type: "p",
    text: "Cross-zone load balancing is a distribution setting, not a capacity grant. With it enabled, each load balancer node can send traffic to targets in all enabled zones. With it disabled, each node sends only to targets in its own zone, which can strand capacity when demand shifts. Application Load Balancers have cross-zone enabled at the load balancer level and can disable it at the target group level; Network Load Balancers have it disabled by default. Neither setting replicates a dependency.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, Domain Name System (DNS), regional load balancer, per-zone load balancer node, per-zone targets, and dependencies. The load balancer publishes zonal addresses and can remove a failed zone from DNS. Targets in the remaining zones take the traffic if they have capacity. The dependency layer is where isolation usually breaks: a self-managed cache, a queue leader, a NAT gateway, an identity service, or a database primary can live in one zone while every zone calls it.",
  },
  {
    type: "table",
    headers: ["Component", "Zonal or regional", "What isolation requires"],
    rows: [
      ["Load balancer", "Zonal nodes, regional name", "Enable at least two zones; let DNS fail away from an impaired zone"],
      ["Targets", "Zonal", "Register targets in every enabled zone, with enough capacity in each"],
      ["NAT egress", "Zonal", "One NAT gateway per zone, or a regional egress design with no single-zone path"],
      ["Block storage", "Zonal", "Replicate at the application or database layer; do not rely on one zone's volume"],
      ["Cache or queue", "Often zonal", "Replicate per zone or use a regional service with multi-AZ behavior"],
      ["Relational database", "Zonal primary, Multi-AZ option", "Enable Multi-AZ and test failover; a read replica is not a failover plan"],
    ],
  },
  {
    type: "p",
    text: "The dependency table is the actual design review. For each row, ask what happens to a request in zone B when zone A fails. If the answer is a network timeout, a cache miss storm, or an identity lookup failure, the workload is not zonally isolated even if the load balancer and targets are.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A three-zone topology with per-zone health, served utilization, and throughput.",
      "Capacity shortfall and dependency loss as separate metrics, then their combined error rate.",
      "Per-zone headroom and the number of surviving zones after a failure.",
      "A shared dependency node pinned to zone A, with its own health and request share.",
      "Controls for failed zones, zone count, per-zone headroom, and dependency share.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply One zone lost. Read capacity shortfall before you look at errors. Apply Shared dependency and watch errors exceed the capacity shortfall. Use the experiment to separate the two causes, then apply Recovery and check that surviving zones are below their warning line.",
  },
  {
    type: "compare",
    leftTitle: "Even-share sizing",
    rightTitle: "N+1 zonal sizing",
    rows: [
      { label: "Per-zone capacity", left: "One third of peak", right: "One half of peak for a three-zone stack" },
      { label: "One zone lost", left: "Demand pressure at 150% of surviving capacity", right: "Demand pressure at 100% of surviving capacity" },
      { label: "Cost", left: "Lowest steady-state cost", right: "More idle capacity in normal operation" },
      { label: "Failure behavior", left: "Capacity shortfall dominates", right: "Capacity is covered; dependencies become the next limit" },
    ],
  },
  { type: "sim", simId: "zonal-isolation" },
  { type: "experiment", experimentId: "predict-zone-loss-gap" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "One zone failure removed one third of the compute. Because each zone was sized for an even share, demand pressure on the surviving zones reached 150% of their safe capacity, so the capacity shortfall was immediate. Cross-zone load balancing pooled the remaining targets, but pooling could not create capacity that was never provisioned.",
  },
  {
    type: "p",
    text: "The dependency preset showed the second failure. With 60% headroom, capacity was sufficient, but 40% of requests needed a component in the failed zone. The application targets were healthy and the capacity math was green; the request path still failed. The total error rate was the capacity shortfall plus the dependency loss, not either one alone.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer: `HealthyHostCount` and `UnHealthyHostCount` with the Availability Zone dimension, plus `HTTPCode_ELB_5XX_Count` and `TargetResponseTime`.",
      "Targets: per-zone CPU, request count, and latency. A healthy fleet total can hide a saturated zone.",
      "Dependencies: NAT gateway `ErrorPortAllocation` and connection counts, cache hit rate and evictions, queue leader health, and database failover events.",
      "DNS: resolver behavior and the 60-second TTL during zone failaway; clients that cache longer extend the incident.",
      "Application: which dependency call fails, and whether the failure is a timeout, a connection refusal, or a cache miss storm.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare capacity shortfall with dependency loss. If the error rate is close to the capacity shortfall, size the surviving zones. If it is much higher, find the shared dependency inside the failed zone. Check per-zone healthy host count before adding targets; the remaining zones may already be at their limit.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure the error rate and split it into capacity shortfall and dependency loss.",
      "Size each zone for peak divided by the number of surviving zones, not for an even share.",
      "Replicate or regionalize every dependency that a surviving zone still calls.",
      "Verify per-zone autoscaling, quotas, and instance inventory can reach the required capacity.",
      "Test the failure with the dependency, not only the compute: remove the zone's targets, NAT, and cache path.",
      "Confirm the failback path and that the recovered zone takes traffic gradually.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "N+1 sizing leaves capacity idle in normal operation; that is the price of surviving a zone loss.",
      "Cross-zone load balancing pools capacity but can create cross-zone data transfer charges and latency.",
      "Disabling cross-zone can improve zonal independence and latency, but it strands capacity unless every zone is sized for its own peak.",
      "Replicating a cache or queue per zone adds consistency and operational complexity; a regional service may be simpler but has its own failure modes.",
      "Multi-AZ databases fail over with a short interruption; a read replica is not the same as a tested failover.",
      "A dependency that is regional is not automatically isolated; it can still be a single logical failure domain.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "design-az-loss",
    question:
      "Design a three-zone service to survive the loss of one Availability Zone. What do you size, and what do you test?",
    difficulty: 3,
    hints: [
      "One zone loss leaves two zones carrying all demand.",
      "Compute is only one of the failure domains.",
    ],
    answer:
      "I would register targets in all three zones and size each zone for peak divided by two, so the surviving two can carry 100%. I would enable the load balancer in all three zones and rely on zonal DNS failaway. Then I would walk the dependency graph: NAT egress, cache, queue, identity, and database. Each one either runs per zone or is a regional service with a tested multi-AZ behavior. I would test by removing one zone's targets, load balancer node, NAT path, and dependency access, not just by terminating instances. I would verify per-zone autoscaling can reach the target capacity and that the failback is gradual.",
    followUps: [
      "What changes if the workload uses two zones instead of three?",
      "How do you test the dependency failure without causing a real outage?",
      "What capacity do you need if two zones fail?",
    ],
    redFlags: [
      "Sizes each zone for one third of peak.",
      "Tests only instance termination.",
      "Assumes a multi-AZ database is automatically isolated.",
    ],
    rubric: [
      "Sizes for peak divided by surviving zones.",
      "Registers targets in every zone.",
      "Walks the dependency graph.",
      "Tests the real failure path.",
    ],
  },
  {
    id: "cross-zone-role",
    question:
      "Does cross-zone load balancing make a service survive an AZ loss? Explain what it changes.",
    difficulty: 3,
    hints: [
      "It changes where a load balancer node can send traffic.",
      "It does not add targets or replicate dependencies.",
    ],
    answer:
      "It changes distribution, not capacity. With cross-zone enabled, each load balancer node can send traffic to healthy targets in all enabled zones, so spare capacity in another zone can be used. With it disabled, each node sends only to targets in its own zone, which can strand capacity when one zone loses demand or targets. But if the surviving zones do not have enough capacity, cross-zone cannot create it. And if a dependency lives in the failed zone, cross-zone cannot route around it. I would treat it as a distribution choice and still size each zone for the failure.",
    followUps: [
      "Why is NLB cross-zone disabled by default?",
      "When would you disable cross-zone at the target group?",
      "What data transfer cost does cross-zone introduce?",
    ],
    redFlags: [
      "Says cross-zone adds capacity.",
      "Ignores the dependency path.",
      "Confuses load balancer node failure with target failure.",
    ],
    rubric: [
      "Distinguishes distribution from capacity.",
      "Explains the per-node scope.",
      "Names the NLB and ALB defaults.",
      "Keeps dependency isolation separate.",
    ],
  },
  {
    id: "find-shared-dependency",
    question:
      "One AZ fails and the service degrades more than the capacity math predicts. How do you find the shared dependency?",
    difficulty: 4,
    hints: [
      "The surviving targets are healthy; the failing call is somewhere else.",
      "Look for a resource with a zonal endpoint and a regional name.",
    ],
    answer:
      "I would compare the error rate with the capacity shortfall. If errors are much higher, I would trace a failing request from a surviving zone and look at the first dependency that times out or refuses a connection. Then I would map that dependency's endpoint to a zone: NAT gateway, cache node, queue leader, database primary, or an identity service. I would check whether every zone calls the same endpoint and whether it has a multi-AZ or per-zone alternative. The clue is often a healthy target fleet with a dependency error rate that matches the failed zone's share.",
    followUps: [
      "How would a cache miss storm look different from a hard dependency failure?",
      "What if the dependency is regional but has a zonal control plane?",
      "Which metric would you add before the next test?",
    ],
    redFlags: [
      "Adds targets without checking the dependency path.",
      "Assumes a regional name means regional isolation.",
      "Ignores the gap between capacity loss and request failure.",
    ],
    rubric: [
      "Compares blast radius with capacity loss.",
      "Traces from a surviving zone.",
      "Maps the dependency endpoint to a zone.",
      "Names a test that would catch it.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Targets are registered in every enabled Availability Zone.",
      "Each zone is sized for peak divided by the number of surviving zones.",
      "The dependency graph marks every zonal resource: NAT, cache, queue, storage, identity, and database.",
      "Dashboards show healthy host count, errors, and latency by Availability Zone.",
      "A zone-loss game day removes compute, egress, and dependency access, not just instances.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split errors into capacity shortfall and dependency loss.",
      "Check per-zone target health and utilization before adding capacity.",
      "Check the dependency endpoint and whether it is reachable from surviving zones.",
      "Watch DNS failaway and client TTL behavior.",
      "Record which zone failed and which dependency was inside it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Add headroom or autoscaling capacity to the surviving-zone target.",
      "Replicate or regionalize the dependency that failed.",
      "Re-run the zone-loss test with the fixed dependency path.",
      "Verify failback and rebalancing after the zone recovers.",
      "Update the dependency graph with the resource found during the incident.",
    ],
  },
];

const references = [
  {
    title: "REL10-BP01 Deploy the workload to multiple locations",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/rel_fault_isolation_multiaz_region_system.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Multi-AZ compute, data, dependency, and DNS guidance for zone-loss resilience.",
  },
  {
    title: "How Elastic Load Balancing works",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/userguide/how-elastic-load-balancing-works.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Availability Zone nodes, cross-zone load balancing defaults, and zonal DNS behavior.",
  },
  {
    title: "Advanced Multi-AZ Resilience Patterns",
    url: "https://docs.aws.amazon.com/whitepapers/latest/advanced-multi-az-resilience-patterns/advanced-multi-az-resilience-patterns.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Gray failures, correlated dependencies, and patterns beyond a binary zone failure.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "zonal-isolation": {
      model: zonalIsolationModel,
      presets,
      instructions:
        "Start Healthy, then apply One zone lost and read capacity shortfall before errors. Apply Shared dependency and watch errors exceed the capacity gap. Run the experiment, then apply Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Availability Zone independence, load balancer zonal nodes, cross-zone behavior, and the 60-second DNS TTL are AWS-documented. The 30,000 rps demand, per-zone headroom thresholds, and additive capacity-plus-dependency error model are teaching values, not AWS quotas or guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-capacity-headroom",
    "traffic-cross-zone-lb",
    "case-netflix-2012",
  ],
};
