import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const HOT_SHARE = 0.5;
const COOL_SHARE = 0.25;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 8_000,
    max: 30_000,
    step: 1_000,
    value: 16_000,
    unit: " rps",
    group: "Demand",
    help: "Total requests per second. Zone A receives half because of client affinity; zones B and C receive a quarter each.",
    format: "rps" as const,
  },
  {
    id: "localCapacity",
    label: "Capacity per zone",
    min: 4_000,
    max: 12_000,
    step: 500,
    value: 10_000,
    unit: " rps",
    group: "Capacity",
    help: "Teaching capacity of each zone. All three zones are equal; demand is not.",
    format: "rps" as const,
  },
  {
    id: "crossZoneAllowance",
    label: "Cross-zone allowance",
    min: 0,
    max: 100,
    step: 5,
    value: 100,
    unit: "%",
    group: "Failover",
    help: "Share of Zone A's overflow that may spill to zones B and C. Zero means strict local routing, even when remote capacity exists.",
    format: "percent" as const,
  },
  {
    id: "crossZoneCost",
    label: "Cross-zone transfer cost",
    min: 2,
    max: 40,
    step: 1,
    value: 20,
    unit: " $/M req",
    group: "Cost",
    help: "Illustrative cost per million cross-zone requests. Applied only to the spillover, not to local traffic.",
    format: "number" as const,
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
  requestRate: number;
  capacity: number;
  allowance: number;
  costRate: number;
  aDemand: number;
  bDemand: number;
  cDemand: number;
  aLocal: number;
  overflow: number;
  remoteSpare: number;
  crossServed: number;
  unserved: number;
  errorRate: number;
  crossShare: number;
  cost: number;
  pressure: number;
  bUtil: number;
  cUtil: number;
  p99: number;
}

function compute(p: Params): Outcome {
  const requestRate = Math.max(1, num(p, "requestRate", 16_000));
  const capacity = Math.max(1, num(p, "localCapacity", 10_000));
  const allowance = clamp(num(p, "crossZoneAllowance", 100), 0, 100);
  const costRate = Math.max(0, num(p, "crossZoneCost", 20));
  const aDemand = requestRate * HOT_SHARE;
  const bDemand = requestRate * COOL_SHARE;
  const cDemand = requestRate * COOL_SHARE;
  const aLocal = Math.min(aDemand, capacity);
  const overflow = Math.max(0, aDemand - capacity);
  const sparePerZone = Math.max(0, capacity - bDemand);
  const remoteSpare = sparePerZone * 2;
  const crossServed = Math.min((overflow * allowance) / 100, remoteSpare);
  const unserved = overflow - crossServed + Math.max(0, bDemand - capacity) * 2;
  const crossShare = (crossServed / requestRate) * 100;
  const cost = (crossServed * 3_600 * costRate) / 1_000_000;
  const bUtil = (bDemand + crossServed / 2) / capacity;
  const cUtil = (cDemand + crossServed / 2) / capacity;
  const pressure = (aDemand / capacity) * 100;
  const maxUtil = Math.max(aDemand / capacity, bUtil, cUtil);
  const p99 = Math.min(5_000, 25 + 45 * (crossShare / 100) + 700 * Math.max(0, maxUtil - 0.9) ** 2);
  return {
    requestRate,
    capacity,
    allowance,
    costRate,
    aDemand,
    bDemand,
    cDemand,
    aLocal,
    overflow,
    remoteSpare,
    crossServed,
    unserved,
    errorRate: (unserved / requestRate) * 100,
    crossShare,
    cost,
    pressure,
    bUtil,
    cUtil,
    p99,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function fmt(value: number, digits = 0): string {
  return value.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function buildFrame(o: Outcome, seed: number): SimFrame {
  const clientHealth = healthFor(o.errorRate, 1, 5);
  const aHealth = o.overflow > 0 ? "crit" : healthFor(o.pressure, 90, 100);
  const bHealth = healthFor(o.bUtil * 100, 90, 100);
  const cHealth = healthFor(o.cUtil * 100, 90, 100);
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: o.requestRate,
        sublabel: `${fmt(o.requestRate)} rps · zone-affine`,
        meta: { view: "flow" },
      },
      {
        id: "zone-a",
        label: "Zone A · hot",
        kind: "mesh",
        role: "zone",
        health: aHealth,
        utilization: clamp(o.aLocal / o.capacity),
        throughput: o.aLocal,
        capacity: o.capacity,
        sublabel: `${fmt(o.aDemand)} rps demand · ${Math.round(o.pressure)}% of capacity`,
        detail: `Zone A receives half of total demand. Local capacity is ${fmt(o.capacity)} rps. It serves ${fmt(o.aLocal)} rps locally; ${fmt(o.overflow)} rps needs another zone. Pressure is ${Math.round(o.pressure)}% of local capacity, so the zone itself is hot even when spillover hides the error.`,
        meta: { view: "flow" },
      },
      {
        id: "zone-b",
        label: "Zone B",
        kind: "mesh",
        role: "zone",
        health: bHealth,
        utilization: clamp(o.bUtil),
        throughput: o.bDemand + o.crossServed / 2,
        capacity: o.capacity,
        sublabel: `${Math.round(o.bUtil * 100)}% load${o.crossServed > 0 ? " · receives spillover" : ""}`,
        detail: `Zone B receives a quarter of total demand plus half of any spillover. Utilization includes the spillover requests.`,
        meta: { view: "flow" },
      },
      {
        id: "zone-c",
        label: "Zone C",
        kind: "mesh",
        role: "zone",
        health: cHealth,
        utilization: clamp(o.cUtil),
        throughput: o.cDemand + o.crossServed / 2,
        capacity: o.capacity,
        sublabel: `${Math.round(o.cUtil * 100)}% load${o.crossServed > 0 ? " · receives spillover" : ""}`,
        detail: `Zone C receives a quarter of total demand plus half of any spillover.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-a", "clients", "zone-a", HOT_SHARE, clientHealth),
      edge("clients-b", "clients", "zone-b", COOL_SHARE, clientHealth),
      edge("clients-c", "clients", "zone-c", COOL_SHARE, clientHealth),
      edge("a-b", "zone-a", "zone-b", o.crossServed / 2 / o.requestRate, o.crossServed > 0 ? "warn" : "ok", "spillover"),
      edge("a-c", "zone-a", "zone-c", o.crossServed / 2 / o.requestRate, o.crossServed > 0 ? "warn" : "ok", "spillover"),
    ],
    metrics: [
      metric("error-rate", "Failed requests", o.errorRate, "%", 1, 5, "percent"),
      metric("local-pressure", "Zone A demand / capacity", o.pressure, "%", 90, 100, "percent"),
      metric("cross-share", "Cross-zone traffic", o.crossShare, "%", 15, 30, "percent"),
      metric("cost", "Cross-zone cost", o.cost, " $/hr", 100, 300, "number"),
      metric("p99", "End-to-end p99", o.p99, "ms", 100, 250, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      pressure: o.pressure,
      overflow: o.overflow,
      cross: o.crossServed,
      unserved: o.unserved,
      cost: o.cost,
      paramsKey: "",
    },
    summary: `${Math.round(o.pressure)}% local pressure; ${Math.round(o.crossShare)}% cross-zone; ${o.errorRate.toFixed(1)}% errors; ${fmt(o.cost, 0)} $/hr.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.012 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.99 + 0.02 * Math.sin((index + (seed % 4)) / 2.5)) + Math.sin(index / 2.3) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "local-pressure",
    metricId: "local-pressure",
    warn: 90,
    crit: 100,
    title: "Zone A demand is above its local capacity",
    cause:
      "Demand is not evenly distributed across zones. Client affinity, a single ingress, or a hot key can put more than a zone's share on one zone. Locality preference does not create capacity; it only decides where the overflow goes.",
    fix:
      "Add capacity to the hot zone, rebalance the demand source, or allow cross-zone spillover. Choose deliberately: spillover protects availability but adds latency and cost.",
    checkFirst: [
      "Compare each zone's request rate with its own capacity, not the fleet average.",
      "Check for client affinity, ingress pinning, or a hot key that concentrates traffic.",
      "Check whether autoscaling is configured per zone.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 1,
    crit: 5,
    title: "Requests fail even though remote capacity exists",
    cause:
      "Local overflow is not allowed to leave the zone, so requests fail at the hot zone while other zones have spare capacity. Strict locality turns a local sizing problem into an availability problem.",
    fix:
      "Enable cross-zone spillover, or add local capacity. If strict locality is required for data residency or latency, size every zone for the hottest demand it can receive.",
    checkFirst: [
      "Compare failed requests with the hot zone's overflow.",
      "Check the cross-zone allowance and the load balancing policy.",
      "Check whether remote zones actually have free capacity.",
    ],
  },
  {
    id: "cross-share",
    metricId: "cross-share",
    warn: 15,
    crit: 30,
    title: "Cross-zone traffic is above the expected share",
    cause:
      "Spillover is serving demand that could have been served locally, or the hot zone is short by more capacity than expected. Every cross-zone request pays an extra round trip.",
    fix:
      "Reduce the hot zone's overflow by rebalancing demand or adding local capacity. If spillover is intentional, budget for its latency and cost rather than treating it as free failover.",
    checkFirst: [
      "Split cross-zone traffic by source and destination zone.",
      "Check whether local endpoints are healthy and under capacity.",
      "Check whether a demand shift, rather than a capacity loss, caused the spillover.",
    ],
  },
  {
    id: "cost",
    metricId: "cost",
    warn: 100,
    crit: 300,
    title: "Cross-zone spillover is above the cost budget",
    cause:
      "Cross-zone requests are billed and add latency. A spillover that fixes availability can still breach the operating budget, especially when the hot zone is much hotter than the others.",
    fix:
      "Reduce spillover at the source: capacity, demand distribution, or a local degraded response. Compare the cost of headroom with the cost of cross-zone traffic before choosing.",
    checkFirst: [
      "Convert cross-zone request rate into the provider's data transfer charge.",
      "Compare the cost of spillover with the cost of local headroom.",
      "Check whether the spillover is steady or only during a peak.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 100,
    crit: 250,
    title: "Latency rose with cross-zone spillover",
    cause:
      "A request served in another zone pays the inter-zone round trip and any queueing at the remote zone. The hot zone's own queue also grows before the overflow is recognized.",
    fix:
      "Keep traffic local while local capacity is healthy, shift only the overflow, and leave enough remote headroom to avoid queueing on top of the network cost.",
    checkFirst: [
      "Split p99 by local and cross-zone requests.",
      "Compare the cross-zone share with the latency change.",
      "Check the hot zone's queue depth and the remote zones' utilization.",
    ],
  },
];

export const localityModel: SimModel = {
  id: "locality",
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

    const prevOverflow = Number(frame.flags.overflow ?? 0);
    const prevCross = Number(frame.flags.cross ?? 0);
    const prevUnserved = Number(frame.flags.unserved ?? 0);
    if (o.overflow > 0 && prevOverflow === 0) {
      pushEvent(next, {
        id: "local-pressure",
        at: frame.t,
        severity: o.pressure >= 120 ? "crit" : "warn",
        title: "Zone A demand exceeds local capacity",
        detail: `Zone A receives ${fmt(o.aDemand)} rps against ${fmt(o.capacity)} rps of local capacity. Overflow is ${fmt(o.overflow)} rps.`,
        nodeId: "zone-a",
        metricId: "local-pressure",
      });
    }
    if (o.crossServed > 0 && prevCross === 0) {
      pushEvent(next, {
        id: "spillover",
        at: frame.t,
        severity: "warn",
        title: "Traffic spilled to remote zones",
        detail: `${fmt(o.crossServed)} rps now leaves Zone A. Cross-zone share is ${o.crossShare.toFixed(1)}% and illustrative cost is ${fmt(o.cost)} $/hr.`,
        nodeId: "zone-b",
        metricId: "cross-share",
      });
    }
    if (o.unserved > 0 && prevUnserved === 0) {
      pushEvent(next, {
        id: "strict-locality-errors",
        at: frame.t,
        severity: "crit",
        title: "Requests fail while remote zones have spare capacity",
        detail: `${fmt(o.unserved)} rps fail in Zone A. Remote zones have ${fmt(o.remoteSpare)} rps of spare capacity that the current allowance does not use.`,
        nodeId: "clients",
        metricId: "error-rate",
      });
    }
    if (o.unserved === 0 && prevUnserved > 0) {
      pushEvent(next, {
        id: "spillover-recovery",
        at: frame.t,
        severity: "info",
        title: "All requests are served again",
        detail: "Overflow is no longer failing. Check whether it is served locally, through spillover, or by restored capacity, and verify cost and latency before closing.",
        nodeId: "clients",
      });
    }
    next.summary = `${Math.round(o.pressure)}% local pressure; ${Math.round(o.crossShare)}% cross-zone; ${o.errorRate.toFixed(1)}% errors; ${fmt(o.cost, 0)} $/hr.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const o = compute(p);
    return [
      `Zone A receives ${fmt(o.aDemand)} rps against ${fmt(o.capacity)} rps, so local pressure is ${Math.round(o.pressure)}%. Zones B and C receive ${fmt(o.bDemand)} rps each before spillover.`,
      `Overflow is ${fmt(o.overflow)} rps. Remote spare capacity is ${fmt(o.remoteSpare)} rps, so the global fleet can serve the demand even when Zone A cannot.`,
      `The current allowance sends ${fmt(o.crossServed)} rps cross-zone (${o.crossShare.toFixed(1)}%) at an illustrative ${fmt(o.cost)} $/hr.`,
      "Locality preference is not a hard pin. Kuma's locality-aware load balancing uses Envoy priorities: traffic stays local while local endpoints are healthy, then spills as health or capacity degrades.",
      "A hot zone is a demand-distribution problem first and a capacity problem second. Adding capacity everywhere is usually more expensive than fixing the distribution or allowing bounded spillover.",
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
    description: "16,000 rps, 10,000 rps per zone. Zone A is at 80% and all traffic stays local.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak, still local",
    description: "18,000 rps. Zone A reaches 90% of capacity; no spillover and no errors.",
    tone: "warn",
    params: defaults({ requestRate: 18_000, localCapacity: 10_000, crossZoneAllowance: 100 }),
  },
  {
    id: "failure",
    label: "Strict locality",
    description: "24,000 rps against 8,000 rps zones with no cross-zone allowance. Zone A fails 4,000 rps while remote zones have spare.",
    tone: "crit",
    params: defaults({ requestRate: 24_000, localCapacity: 8_000, crossZoneAllowance: 0, crossZoneCost: 20 }),
  },
  {
    id: "spillover",
    label: "Spillover",
    description: "Same demand, with full cross-zone allowance. Errors disappear, but Zone A is still hot and cross-zone cost is high.",
    tone: "warn",
    params: defaults({ requestRate: 24_000, localCapacity: 8_000, crossZoneAllowance: 100, crossZoneCost: 20 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "14,000 rps with 10,000 rps per zone. Zone A is back under 75% and no traffic leaves its zone.",
    tone: "ok",
    params: defaults({ requestRate: 14_000, localCapacity: 10_000, crossZoneAllowance: 100 }),
  },
];

const experiment: Experiment = {
  id: "predict-strict-locality",
  title: "Predict why strict locality fails with spare capacity",
  simId: "locality",
  question:
    "Three zones each have 8,000 rps of capacity. Total demand is 24,000 rps, but Zone A receives half of it. Cross-zone allowance is zero. What happens?",
  prediction: {
    options: [
      { id: "balanced", label: "All zones are at one third of capacity, so every request succeeds" },
      { id: "hot", label: "Zone A is over capacity and 4,000 rps fails, while zones B and C have 4,000 rps spare" },
      { id: "remote", label: "The mesh automatically moves the overflow to B and C because total capacity is sufficient" },
      { id: "capacity", label: "All 24,000 rps fails because total demand equals total capacity" },
    ],
    correctOptionId: "hot",
    explanation:
      "Zone A receives 12,000 rps against 8,000 rps of local capacity, so 4,000 rps overflows. Zones B and C receive 6,000 rps each and have 2,000 rps spare each. With a zero cross-zone allowance, the overflow fails. The fleet has enough capacity; the hot zone does not, and strict locality prevents the request from using the spare.",
  },
  setup: defaults({ requestRate: 24_000, localCapacity: 8_000, crossZoneAllowance: 0, crossZoneCost: 20 }),
  runFor: 30,
  observe: [
    "Zone A shows 150% demand against capacity and 4,000 rps of overflow.",
    "Failed requests settle at about 16.7% of total demand.",
    "Zones B and C sit at 75% with 2,000 rps of spare capacity each.",
    "No cross-zone traffic appears, and the cost metric stays at zero.",
  ],
  explain:
    "Locality is a preference, not a capacity plan. The fleet total is 24,000 rps of demand against 24,000 rps of capacity, but the demand is not where the capacity is. A zero allowance makes the hot zone fail locally instead of using the spare. Enabling spillover would serve the demand, but it would also raise latency and cost and leave Zone A dependent on its neighbors.",
  fix: defaults({ requestRate: 24_000, localCapacity: 8_000, crossZoneAllowance: 100, crossZoneCost: 20 }),
  debrief:
    "With full spillover, the 4,000 rps overflow is served by zones B and C. Errors drop to zero, cross-zone traffic is about 16.7%, and illustrative cost is about 288 $/hr. Zone A is still at 150% of local capacity, so this is availability through dependency, not a fixed hot zone. The durable fixes are rebalancing demand or adding local capacity.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Locality-aware load balancing keeps a request in its own zone while the local endpoints can serve it. A proxy prefers endpoints in the same zone, then a nearby zone, then a farther one. Kuma enables this at the mesh level, and the behavior is implemented with Envoy priorities. When local endpoints are healthy, remote endpoints are a fallback rather than an equal member of the pool.",
  },
  {
    type: "p",
    text: "The word aware matters. Locality is a preference, not a hard pin. As local endpoints become unhealthy or the local priority level cannot carry the load, Envoy sends a growing share to the next level. That is what makes the policy useful for failover. It is also what makes the cost and latency visible: the request did not fail, it left the zone.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The decision happens in the client-side Envoy, after service discovery has produced endpoints for the service. Each endpoint carries locality metadata, usually region and zone. Envoy groups endpoints by priority, and locality weighting decides how traffic is distributed within and across those groups. The application sees only the result: a request that succeeded, with a latency that may include an inter-zone round trip.",
  },
  {
    type: "table",
    headers: ["Control", "What it does", "What it does not do"],
    rows: [
      ["Locality preference", "Keeps traffic local while local endpoints are healthy", "Create capacity in the local zone"],
      ["Priority levels", "Defines which endpoints are tried first", "Guarantee that the next level has headroom"],
      ["Cross-zone allowance", "Lets overflow leave the zone", "Remove the latency or the transfer cost"],
      ["Per-zone capacity", "Determines how much local demand fits", "Fix an unbalanced demand source"],
    ],
  },
  {
    type: "p",
    text: "Demand is often not balanced. A client affinity rule, a single ingress, a hot tenant, or a cache key can send half of the traffic to one zone while the others sit idle. Locality preference then keeps the hot zone hot: it will serve as much as it can locally and spill only the rest. The fleet can look healthy in aggregate while one zone is saturated.",
  },
  {
    type: "compare",
    leftTitle: "Strict locality",
    rightTitle: "Local-first with spillover",
    rows: [
      { label: "Failure mode", left: "Hot zone fails while remote capacity is idle", right: "Hot zone depends on its neighbors" },
      { label: "Latency", left: "Local for served requests; failures are fast", right: "Local for most; remote round trip for overflow" },
      { label: "Cost", left: "No cross-zone transfer", right: "Cross-zone transfer for the overflow" },
      { label: "Best fit", left: "Data residency or latency-critical traffic", right: "General availability with a cost budget" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Three zones with equal capacity and uneven demand: Zone A receives half, zones B and C receive a quarter each.",
      "Zone A demand pressure, failed requests, cross-zone share, cross-zone cost, and p99.",
      "A cross-zone allowance that controls how much of Zone A's overflow can leave the zone.",
      "Spillover edges from Zone A to zones B and C when the allowance is above zero.",
      "Events for local pressure, spillover, and requests failing while remote capacity exists.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy and confirm that no traffic leaves Zone A. Apply Strict locality and read failed requests before changing the allowance. Then apply Spillover and watch errors fall while cross-zone cost and latency rise. Run the experiment before opening the debrief; the explanation stays hidden until you predict.",
  },
  {
    type: "callout",
    tone: "warn",
    title: "Teaching values",
    body: "Zone capacities, cost per million requests, and the latency curve are illustrative teaching values. Kuma and Envoy expose real locality and priority controls; the arithmetic here is simplified so the tradeoff stays visible.",
  },
  { type: "sim", simId: "locality" },
  { type: "experiment", experimentId: "predict-strict-locality" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Demand was concentrated in Zone A. With a zero cross-zone allowance, Zone A served its local capacity and failed the rest, even though zones B and C had spare capacity. The fleet total looked sufficient, which is exactly why the failure was easy to miss: the capacity existed, but the routing policy did not let the request use it.",
  },
  {
    type: "p",
    text: "With spillover enabled, the overflow moved to zones B and C. Errors fell to zero, but Zone A remained at 150% of its local capacity and the cross-zone share carried a latency and cost penalty. Spillover restored availability without fixing the hot zone. That distinction matters when you decide whether the incident is over.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Envoy cluster stats per locality or priority: `upstream_rq_total`, `upstream_cx_active`, and `upstream_rq_pending_overflow`.",
      "Mesh or service dashboards split by zone, with per-zone request rate and capacity rather than only a fleet average.",
      "Cross-zone request counts and latency, separated from local requests. A rising cross-zone share is the first cost signal.",
      "Cloud data transfer charges by zone pair, plus any egress or inter-zone charge that applies.",
      "The mesh load balancing policy and its locality settings, compared with the last known good configuration.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare per-zone demand with per-zone capacity. If one zone is hot and the others are not, the problem is distribution before it is total capacity. Then check whether locality preference or a priority change is keeping traffic local or sending it away. Only after that should you add capacity.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Measure per-zone demand and capacity, not just the fleet total.",
      "If the hot zone is over capacity, enable bounded spillover or add local capacity. Choose based on latency and cost.",
      "Fix the demand source: client affinity, ingress pinning, or a hot key that sends too much traffic to one zone.",
      "Keep remote headroom for the spillover; a remote zone that is also at its limit cannot absorb the overflow.",
      "Set alerts on per-zone pressure and cross-zone share, not only on fleet errors.",
      "Re-test the policy with the real demand distribution; an even split in a load test hides the hot zone.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Strict locality protects latency and data placement but fails a hot zone while remote capacity is idle.",
      "Spillover protects availability but adds latency, transfer cost, and a dependency on another zone.",
      "Per-zone headroom is the cleanest fix and the most expensive, because every zone must be sized for the demand it might receive.",
      "A non-uniform demand distribution is a design constraint. If you cannot change it, size the hot zone for its own peak rather than the average.",
      "Cross-zone failover can hide a capacity problem until the remote zone is also full.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "locality-cost",
    question:
      "Cross-zone traffic and cost rise after a mesh rollout, but errors are flat. What changed, and how do you confirm it?",
    difficulty: 3,
    hints: [
      "Flat errors do not mean flat routing.",
      "Compare local and remote endpoint selection by zone.",
    ],
    answer:
      "The mesh is probably sending more requests to remote endpoints, either because locality preference changed or because local endpoints were marked unhealthy or over capacity. I would split request rate by source zone and upstream zone, then compare the cross-zone share with the rollout time. I would check the mesh load balancing policy, locality-aware settings, and local endpoint health. If local endpoints are healthy and under capacity, restoring local preference should reduce the share without changing errors.",
    followUps: [
      "What would make local endpoints look unhealthy?",
      "How would you attribute cost to a zone pair?",
      "When is cross-zone traffic the right choice?",
    ],
    redFlags: [
      "Assumes flat errors prove routing is unchanged.",
      "Adds capacity before checking locality.",
      "Ignores zone tags on metrics.",
    ],
    rubric: [
      "Names locality preference or priority.",
      "Splits traffic by zone pair.",
      "Checks local endpoint health.",
      "Connects routing to cost.",
    ],
  },
  {
    id: "hot-zone",
    question:
      "One zone is at 150% of its capacity while the other two are at 70%. What are the possible causes, and which fix would you choose?",
    difficulty: 3,
    hints: [
      "Capacity is equal but demand is not.",
      "Spillover treats the symptom; distribution treats the cause.",
    ],
    answer:
      "The causes are uneven demand or uneven capacity. Uneven demand can come from client affinity, a single ingress, a hot tenant, or a hot key; uneven capacity from a failed rollout, a smaller instance type, or autoscaling that did not scale that zone. I would first confirm the per-zone request rate and capacity, then check whether spillover is allowed. If the other zones have headroom, enabling bounded spillover restores availability quickly. The durable fix is to rebalance the demand source or size the hot zone for its peak, because spillover leaves the system dependent on its neighbors.",
    followUps: [
      "How would you find the source of the affinity?",
      "What would you do if all three zones were at 90%?",
      "How would you test the fix without moving production traffic?",
    ],
    redFlags: [
      "Adds capacity to all zones without finding the hot source.",
      "Disables locality entirely.",
      "Treats spillover as a permanent fix.",
    ],
    rubric: [
      "Separates demand distribution from capacity.",
      "Names a fast mitigation and a durable fix.",
      "Checks remote headroom.",
      "Tests the change.",
    ],
  },
  {
    id: "locality-policy",
    question:
      "When would you choose strict locality over local-first with spillover, and what must be true for strict locality to be safe?",
    difficulty: 4,
    hints: [
      "Strict locality is a constraint, not just a preference.",
      "The hot zone still receives the demand.",
    ],
    answer:
      "I would choose strict locality when latency, data residency, or transfer cost makes a cross-zone request unacceptable, or when the remote zone is not a trustworthy failure domain. For it to be safe, every zone must be sized for the hottest demand it can receive, not for an even share, and the demand distribution must be understood and monitored. I would also need a local degraded response, because strict locality converts a capacity shortfall directly into failed requests. If those conditions are not true, local-first with bounded spillover is the safer default.",
    followUps: [
      "How would you size a zone for the hottest demand it can receive?",
      "What is the degraded response for a read versus a write?",
      "How would you detect a demand shift before it causes errors?",
    ],
    redFlags: [
      "Chooses strict locality without per-zone sizing.",
      "Assumes demand is evenly distributed.",
      "Has no plan for the hot zone.",
    ],
    rubric: [
      "Names a real constraint that justifies strict locality.",
      "Requires per-zone sizing.",
      "Includes a degraded response.",
      "Compares with spillover.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Each zone has a measured capacity and a known peak demand, not just a fleet average.",
      "Locality preference is enabled and its spillover behavior is tested.",
      "Cross-zone latency and transfer cost are included in the service budget.",
      "A hot-zone alert exists on per-zone pressure and cross-zone share.",
      "Remote zones have enough headroom to absorb the intended spillover.",
      "A degraded response exists for traffic that cannot be served locally or remotely.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare per-zone demand with per-zone capacity before changing policy.",
      "Check whether local endpoints are healthy and under capacity.",
      "Check whether spillover is allowed and whether remote zones have room.",
      "Reduce the hot zone's demand or add local capacity before widening spillover permanently.",
      "Watch cross-zone cost and p99 as the share changes.",
      "Record the policy change and the time it took effect.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Fix the demand distribution or size the hot zone for its peak.",
      "Re-test with the production demand distribution, not an even split.",
      "Review whether cross-zone cost is inside the operating budget.",
      "Check that remote headroom still covers the intended spillover.",
      "Document the latency, cost, and availability tradeoff that was accepted.",
    ],
  },
];

const references = [
  {
    title: "Envoy locality weighted load balancing",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/locality_weight",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "Locality weights and how local endpoints are preferred while they are healthy.",
  },
  {
    title: "Kuma locality-aware load balancing",
    url: "https://kuma.io/docs/latest/policies/locality-aware/",
    publisher: "Kuma Project",
    kind: "docs" as const,
    note: "Zone-local preference in a multi-zone mesh, with spillover as endpoint health degrades.",
  },
  {
    title: "Envoy priority levels",
    url: "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/priority",
    publisher: "Envoy Project",
    kind: "docs" as const,
    note: "The priority mechanism Kuma uses to keep traffic local and fail over when local capacity is insufficient.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    locality: {
      model: localityModel,
      presets,
      instructions:
        "Start Healthy, then apply Strict locality and Spillover. Read failed requests before cross-zone cost. Run the experiment before opening the debrief.",
      experimentIds: [experiment.id],
      note: "Illustrative model. Zone capacities, transfer cost, and latency are teaching values, not Kuma defaults or cloud pricing.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["mesh-cross-cluster", "mesh-failover", "traffic-zonal-isolation", "mesh-traffic-splitting"],
};
