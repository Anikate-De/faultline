import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 24_000;

const params = [
  {
    id: "failedZones",
    label: "Failed zones",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Zones that become unavailable, starting with Zone A. Zero is a healthy run; two leaves one zone carrying the service.",
    format: "count" as const,
  },
  {
    id: "priorityLevels",
    label: "Priority groups",
    min: 1,
    max: 3,
    step: 1,
    value: 3,
    unit: "",
    group: "Failover policy",
    help: "One shared priority leaves no lower level to fail over to. Two groups make Zone A primary; three give each zone its own level.",
    format: "count" as const,
  },
  {
    id: "healthCheckSeconds",
    label: "Health-check interval",
    min: 0,
    max: 30,
    step: 1,
    value: 5,
    unit: " s",
    group: "Detection",
    help: "How long a failed endpoint stays in the pool before active health checks remove it. Zero means checks are disabled.",
    format: "number" as const,
  },
  {
    id: "headroom",
    label: "Headroom per surviving zone",
    min: 0,
    max: 100,
    step: 5,
    value: 50,
    unit: "%",
    group: "Capacity",
    help: "Capacity above each zone's even share. With three zones, two survivors need 50% headroom to carry all demand after one fails.",
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

interface Outcome {
  failed: number;
  priorities: number;
  healthSeconds: number;
  headroom: number;
  healthyZones: number;
  zoneCapacity: number;
  survivingCapacity: number;
  capacityGap: number;
  staleFactor: number;
  staleShare: number;
  errorRate: number;
  failoverTime: number;
  perZoneDemand: number;
  zoneUtil: number;
  p99: number;
}

function compute(p: Params): Outcome {
  const failed = Math.min(2, Math.max(0, Math.round(num(p, "failedZones", 0))));
  const priorities = Math.min(3, Math.max(1, Math.round(num(p, "priorityLevels", 3))));
  const healthSeconds = Math.max(0, num(p, "healthCheckSeconds", 5));
  const headroom = clamp(num(p, "headroom", 50), 0, 100);
  const healthyZones = 3 - failed;
  const zoneCapacity = (TOTAL_RPS / 3) * (1 + headroom / 100);
  const survivingCapacity = healthyZones * zoneCapacity;
  const capacityGap = (Math.max(0, TOTAL_RPS - survivingCapacity) / TOTAL_RPS) * 100;
  const staleFactor = Math.min(1, healthSeconds / 30) * (priorities === 1 ? 1 : 0.35);
  const staleShare = (failed / 3) * staleFactor * 100;
  const errorRate = Math.min(100, capacityGap + staleShare);
  const failoverTime = failed === 0 ? 0 : priorities === 1 ? Math.max(1, healthSeconds) : Math.min(healthSeconds, 2);
  const perZoneDemand = healthyZones > 0 ? TOTAL_RPS / healthyZones : 0;
  const zoneUtil = zoneCapacity > 0 ? perZoneDemand / zoneCapacity : 0;
  const p99 = Math.min(
    5_000,
    40 + 600 * (capacityGap / 100) + staleShare * 2 + (priorities === 1 ? 30 : 0),
  );
  return {
    failed,
    priorities,
    healthSeconds,
    headroom,
    healthyZones,
    zoneCapacity,
    survivingCapacity,
    capacityGap,
    staleFactor,
    staleShare,
    errorRate,
    failoverTime,
    perZoneDemand,
    zoneUtil,
    p99,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function fmt(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function priorityFor(index: number, levels: number): number {
  if (levels === 1) return 0;
  if (levels === 2) return index === 0 ? 0 : 1;
  return index;
}

function buildFrame(o: Outcome, seed: number): SimFrame {
  const clientHealth = healthFor(o.errorRate, 1, 5);
  const proxyHealth = healthFor(o.errorRate, 1, 5);
  const zoneNodes = Array.from({ length: 3 }, (_, index) => {
    const failed = index < o.failed;
    const priority = priorityFor(index, o.priorities);
    return {
      id: `zone-${index}`,
      label: `Zone ${String.fromCharCode(65 + index)}`,
      kind: "mesh" as const,
      role: "zone" as const,
      health: failed ? ("down" as const) : healthFor(o.zoneUtil * 100, 90, 100),
      utilization: failed ? 0 : clamp(o.zoneUtil),
      throughput: failed ? 0 : o.perZoneDemand,
      capacity: o.zoneCapacity,
      sublabel: failed
        ? `unavailable · P${priority}`
        : `P${priority} · ${Math.round(o.zoneUtil * 100)}% load`,
      detail: failed
        ? `This zone is unavailable. Its endpoints remain in the cluster until health checks or endpoint discovery remove them. Priority ${priority} determines whether Envoy has a lower level to use.`
        : `Serving ${fmt(o.perZoneDemand)} rps of ${fmt(o.zoneCapacity)} rps teaching capacity. Priority ${priority}. Active health checks run every ${o.healthSeconds}s.`,
      meta: { view: "flow" },
    };
  });
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: TOTAL_RPS,
        sublabel: `${fmt(TOTAL_RPS)} rps · fixed demand`,
        meta: { view: "flow" },
      },
      {
        id: "proxy",
        label: "Envoy · priority LB",
        kind: "mesh",
        health: proxyHealth,
        utilization: clamp(o.zoneUtil),
        throughput: TOTAL_RPS * (1 - o.errorRate / 100),
        sublabel: `${o.priorities} priority group${o.priorities === 1 ? "" : "s"}`,
        detail: `Envoy generally sends traffic only to the highest healthy priority level. The overprovisioning factor defaults to 1.4, so a level can be partly unhealthy and still receive all traffic until its health score falls below 100.`,
        meta: { view: "flow" },
      },
      ...zoneNodes,
      {
        id: "stale",
        label: "Unhealthy endpoints",
        kind: "external",
        health: o.staleShare >= 10 ? "crit" : o.staleShare >= 1 ? "warn" : "ok",
        throughput: (TOTAL_RPS * o.staleShare) / 100,
        sublabel: `${o.staleShare.toFixed(1)}% of requests`,
        detail: "Requests still sent to endpoints that have failed but have not been removed from the pool. The share depends on health-check timing and on whether a lower priority level exists.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-proxy", "clients", "proxy", 1, clientHealth),
      ...Array.from({ length: 3 }, (_, index) =>
        edge(
          `proxy-zone-${index}`,
          "proxy",
          `zone-${index}`,
          o.healthyZones > 0 ? 1 / o.healthyZones : 0,
          index < o.failed ? "down" : healthFor(o.zoneUtil * 100, 90, 100),
        ),
      ),
      edge("proxy-stale", "proxy", "stale", o.staleShare / 100, o.staleShare >= 10 ? "crit" : "warn"),
    ],
    metrics: [
      metric("error-rate", "Failed requests", o.errorRate, "%", 1, 5, "percent"),
      metric("capacity-gap", "Surviving capacity gap", o.capacityGap, "%", 5, 20, "percent"),
      metric("stale-share", "Traffic to unhealthy endpoints", o.staleShare, "%", 1, 10, "percent"),
      metric("failover-time", "Failover time", o.failoverTime, " s", 10, 20, "number"),
      metric("p99", "End-to-end p99", o.p99, "ms", 250, 600, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      failed: o.failed,
      priorities: o.priorities,
      health: o.healthSeconds,
      gap: o.capacityGap,
      stale: o.staleShare,
      err: o.errorRate,
      paramsKey: "",
    },
    summary: `${o.failed} zone${o.failed === 1 ? "" : "s"} failed; ${o.capacityGap.toFixed(1)}% capacity gap; ${o.staleShare.toFixed(1)}% stale traffic; ${o.errorRate.toFixed(1)}% errors.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.01 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.99 + 0.02 * Math.sin((index + (seed % 6)) / 2.4)) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Failover is not keeping requests successful",
    cause:
      "Either the surviving zones do not have enough capacity, or traffic is still being sent to endpoints that have failed. Priority configuration and health-check timing decide which of the two dominates.",
    fix:
      "Separate the capacity gap from stale traffic. Add surviving headroom for the capacity gap; fix priority groups or health checks for stale traffic. Do not add capacity to hide a detection problem.",
    checkFirst: [
      "Compare failed requests with the surviving capacity gap.",
      "Check whether the failed zone's endpoints are still in the cluster.",
      "Check whether a lower priority level exists and is healthy.",
    ],
  },
  {
    id: "capacity-gap",
    metricId: "capacity-gap",
    warn: 5,
    crit: 20,
    title: "Surviving zones cannot carry the full demand",
    cause:
      "Each zone was sized for its even share, not for the loss of another zone. With three equal zones, two survivors need 50% headroom each to carry 100% of demand.",
    fix:
      "Size each zone for peak divided by the number of surviving zones, or add autoscaling that can reach that capacity inside the surviving zones. Verify that quota and instance inventory support it.",
    checkFirst: [
      "Compare total demand with surviving capacity after the failure.",
      "Check per-zone headroom, not only fleet total.",
      "Check whether autoscaling can reach the required capacity fast enough.",
    ],
  },
  {
    id: "stale-share",
    metricId: "stale-share",
    warn: 1,
    crit: 10,
    title: "Traffic is still reaching unhealthy endpoints",
    cause:
      "Failed endpoints remain in the load balancer pool until active health checks or endpoint discovery remove them. If all zones share one priority, there is no lower level to fail over to while detection is slow.",
    fix:
      "Enable active health checks with an interval that matches the failure budget, use distinct priority levels for zones that should fail over, and verify endpoint removal in the cluster view.",
    checkFirst: [
      "Inspect the cluster's endpoint health flags and priority levels.",
      "Check the health-check interval and failure threshold.",
      "Check whether endpoint discovery is still advertising the failed zone.",
    ],
  },
  {
    id: "failover-time",
    metricId: "failover-time",
    warn: 10,
    crit: 20,
    title: "Traffic takes too long to move",
    cause:
      "Failover waits for health checks to mark the failed endpoints unhealthy, or for a lower priority level to become eligible. A long interval protects against flapping but extends the error window.",
    fix:
      "Tune the health-check interval and failure threshold to the service's error budget. Keep a lower priority level available, and test the time from zone loss to recovery.",
    checkFirst: [
      "Measure time from failure to the first request served by another zone.",
      "Check health-check interval, timeout, and unhealthy threshold.",
      "Check whether priority levels are configured as intended.",
    ],
  },
];

export const failoverModel: SimModel = {
  id: "failover",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(compute(defaults()), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const o = compute(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(o, seed);
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
    const jitter = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(1, item.value * (1 + jitter)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    const prevFailed = Number(frame.flags.failed ?? 0);
    const prevErr = Number(frame.flags.err ?? 0);
    const prevStale = Number(frame.flags.stale ?? 0);
    if (o.failed > prevFailed) {
      pushEvent(next, {
        id: "zone-failure",
        at: frame.t,
        severity: "crit",
        title: `${o.failed} zone${o.failed === 1 ? "" : "s"} failed`,
        detail: `${o.healthyZones} zone${o.healthyZones === 1 ? "" : "s"} remain. Each survivor must carry ${fmt(o.perZoneDemand)} rps against ${fmt(o.zoneCapacity)} rps of teaching capacity.`,
        nodeId: `zone-${o.failed - 1}`,
        metricId: "error-rate",
      });
    }
    if (o.staleShare >= 1 && prevStale < 1) {
      pushEvent(next, {
        id: "stale-endpoints",
        at: frame.t,
        severity: o.staleShare >= 10 ? "crit" : "warn",
        title: "Traffic is still reaching failed endpoints",
        detail: `${o.staleShare.toFixed(1)}% of requests target endpoints that have failed but remain in the pool. Priority groups: ${o.priorities}. Health-check interval: ${o.healthSeconds}s.`,
        nodeId: "stale",
        metricId: "stale-share",
      });
    }
    if (o.errorRate >= 5 && prevErr < 5) {
      pushEvent(next, {
        id: "failover-errors",
        at: frame.t,
        severity: "crit",
        title: "Failover is failing requests",
        detail: `${o.capacityGap.toFixed(1)}% capacity gap and ${o.staleShare.toFixed(1)}% stale traffic combine to ${o.errorRate.toFixed(1)}% failed requests.`,
        nodeId: "clients",
        metricId: "error-rate",
      });
    }
    if (o.errorRate < 1 && prevErr >= 1) {
      pushEvent(next, {
        id: "failover-recovered",
        at: frame.t,
        severity: "info",
        title: "Failover is serving requests again",
        detail: "Failed endpoints are out of the pool and the surviving zones have enough capacity. Verify the return path before closing.",
        nodeId: "clients",
      });
    }
    next.summary = `${o.failed} zone${o.failed === 1 ? "" : "s"} failed; ${o.capacityGap.toFixed(1)}% capacity gap; ${o.staleShare.toFixed(1)}% stale traffic; ${o.errorRate.toFixed(1)}% errors.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const o = compute(p);
    return [
      `${o.failed} of 3 zones failed. Surviving capacity is ${fmt(o.survivingCapacity)} rps against ${fmt(TOTAL_RPS)} rps of demand, a ${o.capacityGap.toFixed(1)}% gap.`,
      `Each healthy zone carries ${fmt(o.perZoneDemand)} rps against ${fmt(o.zoneCapacity)} rps. Per-zone utilization is ${Math.round(o.zoneUtil * 100)}%.`,
      `Traffic to unhealthy endpoints is ${o.staleShare.toFixed(1)}%. It depends on the health-check interval (${o.healthSeconds}s) and on whether priority levels exist below the failed endpoints.`,
      "Envoy generally sends traffic only to the highest healthy priority level. The 1.4 overprovisioning factor means a level can be partly unhealthy and still receive all traffic until its health score drops below 100.",
      "Health checks and priority groups solve different problems: health checks remove bad endpoints, priorities decide which zone is tried first. A failover design needs both.",
    ];
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
    description: "No zone failed, three priority groups, 50% headroom. All three zones serve their share.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "One zone down",
    description: "One zone fails with 50% headroom and distinct priorities. Capacity is sufficient; a short detection window leaves about 2% stale traffic.",
    tone: "warn",
    params: defaults({ failedZones: 1, priorityLevels: 3, healthCheckSeconds: 5, headroom: 50 }),
  },
  {
    id: "failure",
    label: "Shared priority",
    description: "One zone fails, all zones share priority 0, health checks take 30s, and survivors have 20% headroom. Capacity and stale traffic both fail.",
    tone: "crit",
    params: defaults({ failedZones: 1, priorityLevels: 1, healthCheckSeconds: 30, headroom: 20 }),
  },
  {
    id: "priorities",
    label: "Correct priorities",
    description: "Same failure with two priority groups and a 10s check. Capacity is covered and stale traffic falls to about 4%.",
    tone: "warn",
    params: defaults({ failedZones: 1, priorityLevels: 2, healthCheckSeconds: 10, headroom: 50 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "All three zones are healthy again with distinct priorities and 50% headroom.",
    tone: "ok",
    params: defaults({ failedZones: 0, priorityLevels: 3, healthCheckSeconds: 5, headroom: 50 }),
  },
];

const experiment: Experiment = {
  id: "predict-priority-failover",
  title: "Predict why traffic stays on the failed zone",
  simId: "failover",
  question:
    "One of three zones fails. All three zones are configured in the same priority group, active health checks run every 30 seconds, and the surviving zones have 20% headroom. Why do requests keep going to the failed zone?",
  prediction: {
    options: [
      { id: "no-lower", label: "There is no lower priority group to move to, and slow health checks leave failed endpoints in the pool" },
      { id: "dns", label: "DNS still resolves the failed zone, so Envoy cannot remove it" },
      { id: "capacity", label: "The surviving zones have 20% headroom, so Envoy considers them unhealthy" },
      { id: "mesh", label: "Kuma does not support priority-based failover in a multi-zone mesh" },
    ],
    correctOptionId: "no-lower",
    explanation:
      "Priority failover needs a lower level to use. When every zone shares priority 0, Envoy has one pool; it can remove unhealthy endpoints, but it has no second priority to prefer. With a 30-second health-check interval, failed endpoints stay in that pool long enough to receive traffic. The 20% headroom also leaves a capacity gap, so even perfect detection would not cover all demand.",
  },
  setup: defaults({ failedZones: 1, priorityLevels: 1, healthCheckSeconds: 30, headroom: 20 }),
  runFor: 45,
  observe: [
    "One zone is unavailable, but its endpoints remain in the priority-0 pool.",
    "Traffic to unhealthy endpoints is above 30% for the whole run.",
    "Surviving capacity is 20% short, so capacity failures appear on top of stale traffic.",
    "The failover time metric stays at the health-check interval, not at a fast priority switch.",
  ],
  explain:
    "Priority levels are the failover structure. Envoy generally sends traffic only to the highest healthy priority level. If all zones are at priority 0, there is no lower level, and the only way to stop using a failed endpoint is to remove it from the pool. That depends on health checks or endpoint discovery, both of which take time. The overprovisioning factor adds another delay: a level can be partly unhealthy and still be treated as fully healthy until its health score falls below 100.",
  fix: defaults({ failedZones: 1, priorityLevels: 3, healthCheckSeconds: 5, headroom: 50 }),
  debrief:
    "With three priority groups, a 5-second check, and 50% headroom, the failed zone is removed quickly, the survivors have enough capacity, and errors fall below 1%. The fix has three parts: a priority structure that can fail over, health checks fast enough for the error budget, and capacity sized for the loss. Removing any one of them brings the failure back.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Mesh failover is the set of decisions that move traffic away from an unhealthy zone, cluster, or endpoint. Envoy does it with priority levels and health. Each endpoint belongs to a priority, and Envoy generally sends traffic only to the highest healthy priority. As endpoints in that level become unhealthy, traffic trickles to lower levels. A separate health-check system decides when an endpoint is unhealthy in the first place.",
  },
  {
    type: "p",
    text: "The two mechanisms are easy to conflate. Priority groups are a routing preference: they say which zone should be used first. Health checks are a detection mechanism: they say whether an endpoint is usable at all. A failed zone with slow health checks is still a member of its priority pool. If there is no lower priority, or if the lower level is also unhealthy, Envoy has nowhere better to send the request.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The client-side Envoy owns the decision. It receives endpoints from the control plane, groups them by priority, and tracks health per endpoint. Kuma's locality-aware load balancing is built on this mechanism. The control plane can distribute remote endpoints and assign locality, but the proxy still decides which priority level serves the request. That is why a correct control-plane policy can produce incorrect traffic if priorities or health checks are wrong.",
  },
  {
    type: "table",
    headers: ["Signal", "What it means", "What it does not mean"],
    rows: [
      ["Priority 0 is highest", "Try this level first", "It has enough capacity for all demand"],
      ["Health score below 100", "Some endpoints in the level are unhealthy", "All traffic has moved to the next level"],
      ["Endpoint removed from cluster", "The proxy will not route to it", "The zone's capacity has been replaced"],
      ["Lower priority is healthy", "Traffic can move there", "The lower level can absorb the full load"],
    ],
  },
  {
    type: "p",
    text: "Envoy's overprovisioning factor, 1.4 by default, changes the timing. A priority level is considered fully healthy while its health score is at least 100, which happens when roughly 71.4% or more of its endpoints are healthy. With three equal zones, losing one leaves 66.7% healthy, so the level is no longer fully healthy and traffic begins to spill. Losing a smaller share can leave the level fully healthy and keep all traffic on it.",
  },
  {
    type: "compare",
    leftTitle: "Priority failover",
    rightTitle: "Health-check removal",
    rows: [
      { label: "Question answered", left: "Which zone should be tried first?", right: "Is this endpoint usable?" },
      { label: "Speed", left: "Immediate when a lower level is eligible", right: "Interval plus failure threshold" },
      { label: "Failure mode", left: "No lower level, or lower level is also full", right: "Stale endpoints keep receiving traffic" },
      { label: "Capacity effect", left: "Moves demand to another zone", right: "Removes demand from a bad endpoint" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Three zones with priority labels and per-zone utilization.",
      "The number of failed zones, the priority-group layout, the health-check interval, and per-zone headroom.",
      "Failed requests, surviving capacity gap, traffic to unhealthy endpoints, failover time, and p99.",
      "A separate node for requests still sent to failed endpoints.",
      "Events for zone failure, stale endpoints, failover errors, and recovery.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Apply One zone down and check that errors stay near 2% even though failover works. Apply Shared priority and compare the capacity gap with stale traffic. Then apply Correct priorities and Recovery. Run the experiment before opening the debrief.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Teaching values",
    body: "Zone capacities, detection timing, and the error curve are illustrative teaching values. Envoy's actual priority math uses health scores and integer percentages; this model simplifies it so the two failure causes stay separable.",
  },
  { type: "sim", simId: "failover" },
  { type: "experiment", experimentId: "predict-priority-failover" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Zone A failed. With all zones in one priority group and a 30-second health check, Zone A's endpoints stayed in the pool and kept receiving traffic. The surviving zones also had only 20% headroom, so even perfect detection would have left a capacity gap. The error rate was the sum of two different failures: requests sent to dead endpoints, and demand that the survivors could not carry.",
  },
  {
    type: "p",
    text: "With three priority groups, a 5-second check, and 50% headroom, the failed zone was removed quickly, the survivors had enough capacity, and errors fell below 1%. The priority structure made failover possible; the health check made it timely; the headroom made it sufficient. Each control addressed a different part of the failure.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy cluster stats: `upstream_rq_total`, `upstream_rq_5xx`, `upstream_cx_connect_fail`, and `upstream_rq_pending_overflow` for each zone or priority.",
      "Cluster endpoint health flags such as `health_flags::/failed_active_hc` and the priority level for each endpoint.",
      "Kuma data plane and service inventory showing which zone owns each endpoint and whether it is still advertised.",
      "Per-zone request rate and capacity; a healthy fleet total can hide a single overloaded survivor.",
      "Time from zone loss to the first successful request in another zone, measured rather than assumed.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Separate the capacity gap from stale traffic. Compare surviving capacity with total demand, then check whether failed endpoints are still in the cluster. Check the priority layout: if every zone shares one priority, there is no lower level to fail over to. Only then tune the health-check interval.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Give zones distinct priority levels where failover is intended, and verify the lower level is healthy.",
      "Size each surviving zone for the demand it must carry after the largest expected failure.",
      "Tune health checks to the error budget: interval, timeout, and unhealthy threshold together.",
      "Remove stale endpoints from discovery as well as from the proxy, so new proxies do not learn them.",
      "Test the failover at peak with the same priority, health-check, and autoscaling settings as production.",
      "Test the return path: recovered zones must take traffic back without a second overload.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Distinct priorities make failover fast but concentrate traffic on the preferred zone during normal operation.",
      "Aggressive health checks detect failures quickly and can eject healthy endpoints during a transient blip.",
      "Per-zone headroom is the most reliable capacity fix and the most expensive, because it sits idle most of the time.",
      "Stale endpoints are safer than ejecting too much capacity at once, but they spend the error budget while detection catches up.",
      "A lower priority level that is also full is not a failover target; capacity and priority must be designed together.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "stale-endpoints",
    question:
      "A zone fails and Envoy keeps sending traffic to its endpoints. What do you check, and what would you change?",
    difficulty: 3,
    hints: [
      "Separate detection from routing preference.",
      "Check whether a lower priority exists.",
    ],
    answer:
      "I would inspect the cluster's endpoint list and health flags, then the priority levels. If the failed endpoints are still in the pool, health checks or endpoint discovery are slow. If every zone shares one priority, there is no lower level to fail over to even after detection. I would enable or tune active health checks, give zones distinct priorities where appropriate, and verify that the surviving zone has enough capacity. Then I would measure time from failure to the first successful request elsewhere.",
    followUps: [
      "Which Envoy stats show requests still going to the failed zone?",
      "How does the overprovisioning factor change the timing?",
      "What would you do if health checks were already fast?",
    ],
    redFlags: [
      "Adds capacity without checking endpoint removal.",
      "Assumes priority failover is automatic.",
      "Tunes health checks without a capacity plan.",
    ],
    rubric: [
      "Checks endpoint health flags.",
      "Checks priority layout.",
      "Names detection and capacity separately.",
      "Measures failover time.",
    ],
  },
  {
    id: "priority-math",
    question:
      "How do Envoy priority levels and the default overprovisioning factor decide when traffic moves to a lower zone?",
    difficulty: 4,
    hints: [
      "A level can be partly unhealthy and still fully serve.",
      "The factor is 1.4.",
    ],
    answer:
      "Envoy generally sends traffic only to the highest healthy priority level. It computes a health score for the level as the percentage of healthy hosts times the overprovisioning factor, capped at 100. With the default 1.4, a level is fully healthy while at least about 71.4% of its hosts are healthy. Below that, the score falls below 100 and traffic begins to flow to the next level. If the lower level is not healthy or not large enough, the normalized total health drops below 100 and the remaining traffic is distributed across whatever capacity exists.",
    followUps: [
      "What happens if the lower priority level is half the size?",
      "How would you change the factor, and why?",
      "What does normalized total health tell you?",
    ],
    redFlags: [
      "Assumes any unhealthy host triggers failover.",
      "Ignores the lower level's capacity.",
      "Treats the factor as a percentage.",
    ],
    rubric: [
      "Explains the health score.",
      "Uses 1.4 correctly.",
      "Mentions normalized total health.",
      "Connects to lower-level capacity.",
    ],
  },
  {
    id: "failover-test",
    question:
      "How would you test mesh failover before relying on it?",
    difficulty: 3,
    hints: [
      "Test at peak, not average.",
      "Include detection, capacity, and return traffic.",
    ],
    answer:
      "I would fail one zone at peak demand with production priority, health-check, and autoscaling settings. I would measure the surviving zones' utilization, error rate, p99, and the time until traffic actually moved. I would verify that failed endpoints leave the pool and that the lower priority level has enough capacity. I would also test two simultaneous failures if the design claims to survive them, and the return path when the zone recovers. A failover test that only checks that endpoints exist has not tested failover.",
    followUps: [
      "What would you assert about stale traffic?",
      "How would you test the return path?",
      "What if the test passes but production still fails?",
    ],
    redFlags: [
      "Tests only at average load.",
      "Checks reachability, not capacity.",
      "Ignores the return path.",
    ],
    rubric: [
      "Tests at peak.",
      "Measures detection and capacity.",
      "Checks stale endpoints.",
      "Includes return traffic.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Zones that should fail over have distinct priority levels and a healthy lower level.",
      "Each surviving zone has enough capacity for the largest expected failure at peak.",
      "Active health checks are configured with an interval, timeout, and unhealthy threshold tied to the error budget.",
      "Endpoint discovery removes failed zones, and new proxies do not learn stale endpoints.",
      "Dashboards show per-zone request rate, capacity, and endpoint health, not only fleet totals.",
      "A failover test exists at peak with production settings.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Separate the capacity gap from traffic to unhealthy endpoints.",
      "Inspect endpoint health flags and priority levels.",
      "Check whether the lower priority level is healthy and large enough.",
      "Reduce the health-check interval only after confirming the capacity plan.",
      "Watch p99 and pending requests on the surviving zones.",
      "Record the time from failure to the first successful request elsewhere.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Test the return path and verify traffic moves back without a second overload.",
      "Review whether health-check timing matches the observed error window.",
      "Confirm that autoscaling can reach the required capacity inside each zone.",
      "Remove any stale endpoints from discovery and from the proxy.",
      "Update the failover runbook with the measured time to recover.",
    ],
  },
];

const references = [
  {
    title: "Envoy priority levels",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/priority",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Priority levels, health scores, the 1.4 overprovisioning factor, and normalized total health.",
  },
  {
    title: "Envoy health checking",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Active health checks, intervals, unhealthy thresholds, and how endpoints leave the pool.",
  },
  {
    title: "Kuma locality-aware load balancing",
    url: "https://kuma.io/docs/latest/policies/locality-aware/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Kuma's zone-local preference, implemented with Envoy priorities and spillover as health degrades.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    failover: {
      model: failoverModel,
      presets,
      instructions:
        "Start Healthy, then apply Shared priority and Correct priorities. Compare the capacity gap with traffic to unhealthy endpoints before changing anything.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Zone capacities, detection timing, and the error curve are teaching values, not Envoy guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-locality", "mesh-cross-cluster", "mesh-outlier-detection", "mesh-envoy-clusters"],
};
