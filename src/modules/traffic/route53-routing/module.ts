import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Health, ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const POLICY_NAMES = ["Failover", "Weighted", "Latency", "Geolocation", "Multivalue"] as const;
const REGION_A_CAPACITY = 150;

const params: ParamSpec[] = [
  {
    id: "policy",
    label: "Routing policy (0 failover, 1 weighted, 2 latency, 3 geo, 4 multivalue)",
    min: 0,
    max: 4,
    step: 1,
    value: 1,
    unit: "",
    group: "Policy",
    help: "0 failover is active-passive. 1 weighted uses relative weights. 2 latency follows measured latency. 3 geolocation follows the user's configured location. 4 multivalue returns up to eight healthy records at random.",
    format: "count",
  },
  {
    id: "desiredTrafficB",
    label: "Desired traffic to region B",
    min: 0,
    max: 100,
    step: 5,
    value: 0,
    unit: "%",
    group: "Migration",
    help: "The migration target. Weighted routing can express it directly; the other policies may not be able to reach it.",
    format: "percent",
  },
  {
    id: "newRegionCapacity",
    label: "Region B capacity",
    min: 10,
    max: 150,
    step: 5,
    value: 100,
    unit: "% of full traffic",
    group: "Migration",
    help: "Illustrative serving capacity relative to current full production traffic. A region at 100% has no headroom; 150% leaves room for a full migration.",
    format: "percent",
  },
  {
    id: "euShare",
    label: "Users in Europe",
    min: 0,
    max: 100,
    step: 5,
    value: 40,
    unit: "%",
    group: "Users",
    help: "Share of users whose location maps to region B under latency or geolocation routing. Region A serves the rest.",
    format: "percent",
  },
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 100_000,
    step: 1_000,
    value: 20_000,
    unit: " rps",
    group: "Users",
    help: "Total request rate. Failed requests are the share routed to region B above its capacity.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function policyIndex(p: Params): number {
  return Math.min(4, Math.max(0, Math.round(num(p, "policy", 1))));
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

interface Computed {
  policy: number;
  policyName: string;
  desired: number;
  achieved: number;
  gap: number;
  capacity: number;
  utilization: number;
  overload: number;
  failedPercent: number;
  failedRps: number;
  trafficA: number;
  requestRate: number;
  euShare: number;
}

function compute(p: Params): Computed {
  const policy = policyIndex(p);
  const desired = clamp(num(p, "desiredTrafficB", 0), 0, 100);
  const capacity = Math.max(10, num(p, "newRegionCapacity", 100));
  const euShare = clamp(num(p, "euShare", 40), 0, 100);
  const requestRate = Math.max(1, num(p, "requestRate", 20_000));
  const achieved =
    policy === 0 ? 0 : policy === 1 ? desired : policy === 2 || policy === 3 ? euShare : 50;
  const gap = Math.abs(achieved - desired);
  const utilization = achieved > 0 ? Math.min(100, (achieved / capacity) * 100) : 0;
  const overload = Math.max(0, achieved - capacity);
  const failedPercent = Math.min(100, overload);
  return {
    policy,
    policyName: POLICY_NAMES[policy],
    desired,
    achieved,
    gap,
    capacity,
    utilization,
    overload,
    failedPercent,
    failedRps: (requestRate * failedPercent) / 100,
    trafficA: 100 - achieved,
    requestRate,
    euShare,
  };
}

function buildFrame(p: Params, seed: number): SimFrame {
  const c = compute(p);
  const clientHealth: Health = c.failedPercent > 5 ? "crit" : c.gap >= 50 ? "warn" : "ok";
  const dnsHealth: Health = c.gap >= 50 ? "crit" : c.gap >= 10 ? "warn" : "ok";
  const regionAHealth: Health =
    (c.trafficA / REGION_A_CAPACITY) * 100 >= 95 ? "crit" : (c.trafficA / REGION_A_CAPACITY) * 100 >= 80 ? "warn" : "ok";
  const regionBHealth: Health =
    c.failedPercent > 0 || c.utilization >= 95 ? "crit" : c.utilization >= 80 ? "warn" : "ok";
  return {
    t: 0,
    nodes: [
      {
        id: "clients",
        label: "Users",
        kind: "client",
        health: clientHealth,
        sublabel: `${formatCount(c.requestRate)} rps · ${c.euShare.toFixed(0)}% in Europe`,
        detail:
          "Users resolve the same name but may receive different regional answers. The answer depends on the routing policy, health checks, and the resolver's location.",
        meta: { view: "flow" },
      },
      {
        id: "dns",
        label: "Route 53",
        kind: "dns",
        health: dnsHealth,
        utilization: clamp(c.gap / 100),
        sublabel: `${c.policyName} policy · ${c.achieved.toFixed(0)}% to B`,
        detail:
          c.gap >= 10
            ? `The policy reaches ${c.achieved.toFixed(0)}% of traffic to region B, but the migration target is ${c.desired.toFixed(0)}%. The gap is ${c.gap.toFixed(0)} points.`
            : `The policy reaches ${c.achieved.toFixed(0)}% of traffic to region B, matching the ${c.desired.toFixed(0)}% target.`,
        meta: { view: "flow" },
      },
      {
        id: "region-a",
        label: "Region A",
        kind: "service",
        health: regionAHealth,
        utilization: clamp(c.trafficA / REGION_A_CAPACITY),
        throughput: (c.requestRate * c.trafficA) / 100,
        sublabel: `${c.trafficA.toFixed(0)}% of traffic`,
        detail: `Region A is the incumbent. It serves ${formatCount((c.requestRate * c.trafficA) / 100)} rps in this model against an illustrative capacity of ${REGION_A_CAPACITY}% of full traffic.`,
        meta: { view: "flow" },
      },
      {
        id: "region-b",
        label: "Region B",
        kind: "service",
        health: regionBHealth,
        utilization: clamp(c.utilization / 100),
        throughput: (c.requestRate * c.achieved) / 100,
        sublabel: `${c.achieved.toFixed(0)}% of traffic · ${c.utilization.toFixed(0)}% capacity`,
        detail:
          c.overload > 0
            ? `Region B receives ${c.achieved.toFixed(0)}% of traffic against ${c.capacity.toFixed(0)}% capacity. About ${c.failedPercent.toFixed(0)}% of all requests exceed its capacity and fail.`
            : `Region B receives ${c.achieved.toFixed(0)}% of traffic against ${c.capacity.toFixed(0)}% capacity. It has ${Math.max(0, c.capacity - c.achieved).toFixed(0)} points of headroom.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("clients-dns", "clients", "dns", 1, clientHealth),
      edge("dns-a", "dns", "region-a", c.trafficA / 100, regionAHealth),
      edge("dns-b", "dns", "region-b", c.achieved / 100, regionBHealth),
    ],
    metrics: [
      metric("traffic-to-b", "Traffic routed to region B", c.achieved, "%", undefined, undefined, "percent"),
      metric("migration-gap", "Migration gap", c.gap, " pts", 10, 50, "number"),
      metric("failed-requests", "Failed requests", c.failedPercent, "%", 1, 5, "percent"),
      metric("new-region-utilization", "Region B utilization", c.utilization, "%", 80, 95, "percent"),
      metric("failed-rps", "Failed request rate", c.failedRps, " /s", 100, 1_000, "rps"),
    ],
    events: [],
    series: {},
    flags: { seed, policy: c.policy },
    summary: `${c.policyName} sends ${c.achieved.toFixed(0)}% to region B against a ${c.desired.toFixed(0)}% target; gap ${c.gap.toFixed(0)} points; ${c.failedPercent.toFixed(0)}% failed requests.`,
  };
}

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

const thresholds: ThresholdSpec[] = [
  {
    id: "migration-gap",
    metricId: "migration-gap",
    warn: 10,
    crit: 50,
    title: "The routing policy cannot express the migration target",
    cause:
      "The selected policy does not have a control that produces the desired split. Failover is binary, latency and geolocation follow user location, and multivalue returns healthy records at random.",
    fix:
      "Use weighted records for an explicit migration percentage. Keep the target within the new region's capacity, move in steps, and roll back by setting the weight to zero.",
    checkFirst: [
      "Read the routing policy on the record, not only the record value.",
      "Compare the desired share with the share the policy can actually produce.",
      "Check whether a health check is removing a record from the answer.",
    ],
  },
  {
    id: "failed-requests",
    metricId: "failed-requests",
    warn: 1,
    crit: 5,
    title: "The new region is above its capacity",
    cause:
      "The policy sent more traffic to region B than it can serve. A migration control is not a capacity grant; the new region must be sized for the share it receives.",
    fix:
      "Reduce the weight or traffic dial, add capacity, or pause the migration. Verify healthy targets and per-region latency before increasing the share again.",
    checkFirst: [
      "Compare region B request rate with its provisioned capacity.",
      "Check region B healthy host count and latency.",
      "Confirm the weight change actually took effect in DNS answers.",
    ],
  },
  {
    id: "new-region-utilization",
    metricId: "new-region-utilization",
    warn: 80,
    crit: 95,
    title: "Region B has little headroom",
    cause:
      "The migration target consumes most of region B's capacity. The next traffic increase or a zone failure can push it into errors.",
    fix:
      "Leave headroom, add capacity, or stop the migration at a lower share. A region that is merely alive at 100% is not ready for a zone failure.",
    checkFirst: [
      "Check region B utilization by Availability Zone.",
      "Check whether the capacity number includes N+1 headroom.",
      "Compare the migration step with the next planned traffic change.",
    ],
  },
];

export const route53RoutingModel: SimModel = {
  id: "traffic-route53-routing",
  visual: "flow",
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
    if (frame.flags.policy !== undefined && frame.flags.policy !== c.policy) {
      pushEvent(next, {
        id: "policy-changed",
        severity: "info",
        title: `Routing policy changed to ${c.policyName}`,
        detail: "Existing DNS answers remain cached until their TTL expires. The new policy applies to answers Route 53 returns from now on.",
        nodeId: "dns",
      });
    }
    if (c.gap >= 50 && frame.flags.gapLogged !== 1) {
      pushEvent(next, {
        id: "migration-blocked",
        severity: "crit",
        title: "Routing policy cannot reach the migration target",
        detail: `${c.policyName} reaches ${c.achieved.toFixed(0)}% of traffic to region B; the target is ${c.desired.toFixed(0)}%. The gap is a control-plane limitation, not a capacity problem.`,
        nodeId: "dns",
        metricId: "migration-gap",
      });
      next.flags.gapLogged = 1;
    }
    if (c.gap < 50) next.flags.gapLogged = 0;
    if (c.failedPercent > 0 && frame.flags.overloadLogged !== 1) {
      pushEvent(next, {
        id: "new-region-overloaded",
        severity: "crit",
        title: "Region B is over capacity",
        detail: `${c.achieved.toFixed(0)}% of traffic is routed to a region with ${c.capacity.toFixed(0)}% capacity. About ${c.failedPercent.toFixed(0)}% of all requests fail.`,
        nodeId: "region-b",
        metricId: "failed-requests",
      });
      next.flags.overloadLogged = 1;
    }
    if (c.failedPercent === 0) next.flags.overloadLogged = 0;
    if (c.gap <= 5 && c.desired > 0 && c.failedPercent === 0 && frame.flags.completeLogged !== 1) {
      pushEvent(next, {
        id: "migration-step-complete",
        severity: "info",
        title: `Migration step at ${c.achieved.toFixed(0)}% is healthy`,
        detail: "The requested share is served by region B and the failure rate is zero. Verify latency and headroom before the next step.",
        nodeId: "region-b",
      });
      next.flags.completeLogged = 1;
    }
    if (c.gap > 5 || c.failedPercent > 0) next.flags.completeLogged = 0;
    next.metrics = next.metrics.map((item) => {
      if (item.id === "failed-rps" && item.value > 0) {
        return { ...item, value: Math.max(0, item.value * (1 + rng.between(-0.004, 0.004))) };
      }
      return item;
    });
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.metrics = next.metrics.map((item) => ({ ...item, trend: next.series[item.id] ?? [] }));
    next.flags.policy = c.policy;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const c = compute(p);
    const items: string[] = [];
    items.push(
      `${c.policyName} routing sends ${c.achieved.toFixed(0)}% of traffic to region B against a ${c.desired.toFixed(0)}% target. The gap is ${c.gap.toFixed(0)} points.`,
    );
    if (c.policy === 0) {
      items.push("Failover routing is active-passive: it sends all traffic to the healthy primary and switches only when the primary is unhealthy. It cannot express a gradual share.");
    } else if (c.policy === 1) {
      items.push("Weighted records use relative weights (0 to 255). Changing a weight changes the share for new answers; cached answers change only when their TTL expires.");
    } else if (c.policy === 2) {
      items.push("Latency routing uses measured latency between resolver locations and AWS Regions. With this topology it sends the European share to region B, the same split as geolocation.");
    } else if (c.policy === 3) {
      items.push("Geolocation routing follows the user's configured continent, country, or subdivision. It enforces locality even when another region would be faster, and it needs a default record.");
    } else {
      items.push("Multivalue routing returns up to eight healthy records at random. The 50/50 split here is illustrative; it is not a weighted migration control.");
    }
    items.push(
      `Region B is at ${c.utilization.toFixed(0)}% of its ${c.capacity.toFixed(0)}% capacity. ${c.failedPercent > 0 ? `${c.failedPercent.toFixed(0)}% of all requests fail.` : "All routed requests fit."}`,
    );
    if (c.policy === 2 || c.policy === 3) {
      items.push("Latency and geolocation agree when the nearest region is also the configured region. They diverge when the user's location and the fastest path disagree.");
    }
    items.push("Every policy is still bounded by DNS TTL on the client and resolver side. A weight change is not visible to a client with a cached answer.");
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
    description: "Weighted routing at 0% to region B. All traffic stays on the incumbent.",
    tone: "ok",
    params: defaults({ policy: 1, desiredTrafficB: 0, newRegionCapacity: 100 }),
  },
  {
    id: "peak",
    label: "Random split",
    description: "Multivalue returns both healthy records at random; the 50% split is 10 points above the 40% target.",
    tone: "warn",
    params: defaults({ policy: 4, desiredTrafficB: 40, newRegionCapacity: 100, euShare: 40 }),
  },
  {
    id: "failure",
    label: "Binary policy",
    description: "Failover routing cannot send a gradual 80% to region B while the primary is healthy.",
    tone: "crit",
    params: defaults({ policy: 0, desiredTrafficB: 80, newRegionCapacity: 100 }),
  },
  {
    id: "overload",
    label: "Migration too fast",
    description: "Weighted routing sends 90% to a region sized for 40%. The policy works; the capacity does not.",
    tone: "crit",
    params: defaults({ policy: 1, desiredTrafficB: 90, newRegionCapacity: 40 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Weighted routing moves 30% to a region with 120% capacity and no failures.",
    tone: "ok",
    params: defaults({ policy: 1, desiredTrafficB: 30, newRegionCapacity: 120 }),
  },
];

const experiment: Experiment = {
  id: "predict-migration-policy",
  title: "Predict which policy can move in steps",
  simId: "route53-routing",
  question:
    "You need 10%, then 50%, then 100% of traffic on a new region, with a fast rollback at each step. Which routing policy can express that?",
  prediction: {
    options: [
      { id: "weighted", label: "Weighted routing with relative weights for each region." },
      { id: "failover", label: "Failover routing with a primary and secondary record." },
      { id: "latency", label: "Latency routing, because it follows the fastest region." },
      { id: "geo", label: "Geolocation routing, because it controls where users land." },
    ],
    correctOptionId: "weighted",
    explanation:
      "Weighted records assign a relative weight to each record. You can move from 10 to 50 to 100 by changing weights and roll back by returning the new region's weight to zero. Failover is binary, latency follows measured latency, and geolocation follows user location; none of them gives you an explicit migration percentage.",
  },
  setup: defaults({ policy: 1, desiredTrafficB: 30, newRegionCapacity: 80, euShare: 40 }),
  runFor: 20,
  observe: [
    "The weighted policy sends 30% of traffic to region B, matching the target.",
    "The migration gap is zero and no requests fail.",
    "Region B is at about 38% of its capacity.",
    "The other policies would produce a different share or a gap, regardless of the target.",
  ],
  explain:
    "A weighted record is a traffic control. The weight is relative to the sum of weights in the group, so you can shift traffic in small steps. The health check still removes an unhealthy record, and the TTL still bounds how fast clients see the change. Capacity is separate: a 30% weight sent to a region with 20% capacity would still fail.",
  fix: defaults({ policy: 1, desiredTrafficB: 100, newRegionCapacity: 150, euShare: 40 }),
  debrief:
    "At 100% weight, region B serves the full request rate against 150% capacity, leaving headroom for a zone failure. Rollback is a weight change back to zero, bounded by TTL and by the capacity of the region that takes the traffic back. Weighted routing gives control; it does not replace readiness checks.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A Route 53 routing policy decides which record values Route 53 includes in a DNS answer. Failover routing is active-passive: it returns the healthy primary and switches to the secondary only when the primary is unhealthy. Weighted routing assigns each record a relative weight and returns records in proportion to those weights. Latency routing uses measured latency between resolver locations and AWS Regions. Geolocation routing uses the user's continent, country, or subdivision, with a default record for unmatched users. Multivalue answer routing returns up to eight healthy records at random.",
  },
  {
    type: "p",
    text: "The policies answer different questions. Failover asks whether the primary is healthy. Weighted asks for an explicit proportion. Latency asks which region is faster for this resolver. Geolocation asks where the user is. Multivalue asks which healthy records can be returned, not how much traffic each should receive. Choosing the wrong question produces a healthy record set that cannot express the migration.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The policy is evaluated by Route 53 when it answers a query. It sits above the regional endpoints and below the resolver. Health checks can remove an unhealthy record before the policy is applied. The client and resolver caches still decide when a new answer is used. A weight change or a policy change is not a traffic switch until clients resolve again.",
  },
  {
    type: "table",
    headers: ["Policy", "Control", "Migration fit", "Main limit"],
    rows: [
      ["Failover", "Primary or secondary", "Binary cutover, fast rollback", "Cannot express a gradual share"],
      ["Weighted", "Relative weight per record", "Gradual steps and explicit rollback", "TTL bounds how fast clients move"],
      ["Latency", "Measured resolver-to-region latency", "Performance, not migration control", "Share depends on where users are"],
      ["Geolocation", "Continent, country, or subdivision", "Locality and data residency", "Share is fixed by user location"],
      ["Multivalue", "Healthy records at random", "Availability, not load balancing", "No weight control"],
    ],
  },
  {
    type: "p",
    text: "Route 53 also offers geoproximity, IP-based, and simple routing. Geoproximity can bias traffic between locations, but it is still a proximity control. This module focuses on the five policies in the simulator.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "The selected policy and the share of traffic it actually sends to region B.",
      "The migration gap between the target and the achieved share.",
      "Region B utilization and failed requests when the migration outruns capacity.",
      "Controls for the policy, target share, new-region capacity, European user share, and request rate.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy. Set a migration target and cycle through the policies; note which ones can reach it. Lower region B capacity and watch the policy succeed while the region fails. Run the experiment before reading its explanation, then finish with Recovery.",
  },
  {
    type: "p",
    text: "The migration target is not a capacity plan. A weighted record can send 100% of traffic to a region that is only ready for 20%. The simulator keeps those two decisions separate so you can see which one is failing.",
  },
  { type: "sim", simId: "route53-routing" },
  { type: "experiment", experimentId: "predict-migration-policy" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Failover routing was healthy but could not produce an 80% share: it returned the primary while the primary was healthy, so the migration gap stayed critical. Weighted routing produced the target share exactly. When region B's capacity was lower than the share it received, the policy still worked and the region failed.",
  },
  {
    type: "p",
    text: "Latency and geolocation produced a share determined by where users are, not by a migration target. Multivalue produced a random split among healthy records. Each policy was doing its job; the mismatch was between the question the operator asked and the question the policy answers.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Route 53 query logs and answers from multiple resolver locations, not only from your laptop.",
      "Per-region request rate, latency, error rate, and healthy host count after each weight change.",
      "The record's routing policy and weight set, plus the health check status for each record.",
      "Resolver and client cache behavior after the change; a weight change is invisible until the TTL expires.",
      "Region B headroom by Availability Zone, not only the aggregate utilization.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Read the routing policy before the traffic graph. If the target share is not appearing, ask whether the policy has a control that can produce it. If the share is correct but requests fail, check the new region's capacity and health.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the migration target and the policy's control model.",
      "Use weighted records for gradual steps; keep failover for binary active-passive.",
      "Verify region B capacity and headroom for the next step.",
      "Change the weight in small increments and watch error rate, latency, and saturation.",
      "Wait for the TTL to expire before judging the new share.",
      "Roll back by returning the new region's weight to zero, then drain and fix it.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Weighted routing gives precise control but depends on TTL for every client to see the change.",
      "Failover is simple and fast to reason about but cannot split traffic or support a gradual migration.",
      "Latency routing improves performance but makes the traffic share a function of user location and network conditions.",
      "Geolocation enforces locality and data-residency rules but can send users to a slower region and needs a default record.",
      "Multivalue improves availability by returning healthy records but is not a weighted load balancer.",
      "All policies depend on accurate health checks; a false unhealthy record removes capacity from the pool.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "migration-policy",
    question:
      "You need to migrate traffic between regions over two weeks with a fast rollback at every step. Which Route 53 policy do you choose, and what else has to be true?",
    difficulty: 3,
    hints: [
      "The policy needs an explicit proportion.",
      "A weight change is not visible until caches expire.",
    ],
    answer:
      "I would use weighted records. Each region gets a relative weight, and I can move from a small share to 50% to 100% in steps, then roll back by setting the new region's weight to zero. Failover is binary and cannot express the intermediate steps; latency and geolocation produce shares based on user location, not a target. I would also require the new region to have capacity and health headroom for each step, a health check on both records, a TTL low enough for the change cadence, and a way to measure the real share from multiple resolver locations. The rollback is a weight change, but it is still bounded by DNS caching, so I would not promise an instant cutover.",
    followUps: [
      "How do you choose the weight increment?",
      "What happens if the new region fails health checks at 50% weight?",
      "How would you verify the split from outside AWS?",
    ],
    redFlags: [
      "Chooses failover for a gradual migration.",
      "Changes weights without checking new-region capacity.",
      "Promises instant rollback without accounting for TTL.",
    ],
    rubric: [
      "Chooses weighted routing.",
      "Explains the weight and rollback model.",
      "Covers capacity and health checks.",
      "Accounts for DNS caching.",
    ],
  },
  {
    id: "latency-vs-geo",
    question:
      "When would you choose latency routing over geolocation, and when is geolocation the better choice?",
    difficulty: 3,
    hints: [
      "One follows measured network latency; the other follows user location.",
      "Think about data residency and default records.",
    ],
    answer:
      "Latency routing is better when the goal is performance: Route 53 uses measured latency between resolver locations and AWS Regions, so the answer can change as the network changes. Geolocation is better when the goal is locality or a policy requirement, such as keeping users in a country or sending them to a region with locally compliant data. Geolocation can send a user to a farther region, and it needs a default record for users who do not match a location. Latency can shift traffic unexpectedly when a path changes, which is good for performance but bad for a stable migration. In both cases I would keep health checks and a TTL plan.",
    followUps: [
      "What does a geolocation default record do?",
      "How would you handle a country that has users near two regions?",
      "When would geoproximity be a better fit?",
    ],
    redFlags: [
      "Treats latency and geolocation as interchangeable.",
      "Ignores the default record.",
      "Forgets health checks and TTL.",
    ],
    rubric: [
      "Contrasts measured latency with configured location.",
      "Names a compliance or locality use case.",
      "Mentions the default record.",
      "Keeps health checks and TTL in the design.",
    ],
  },
  {
    id: "multivalue-rollback",
    question:
      "Could you use multivalue routing for a gradual migration and rollback? Why or why not?",
    difficulty: 2,
    hints: [
      "Multivalue selects healthy records at random.",
      "The operator needs an explicit share.",
    ],
    answer:
      "No. Multivalue answer routing returns up to eight healthy records selected at random, so it is an availability mechanism, not a traffic control. I cannot set a target share of 10% or 50%, and I cannot roll back to an exact previous proportion. Weighted routing is the right tool because its relative weights give me an explicit share and a direct rollback to zero. I could use multivalue for a simple active-active pool where any healthy record is acceptable, but I would not use it to manage a controlled migration.",
    followUps: [
      "What does multivalue do when one record is unhealthy?",
      "How many records can a multivalue answer return?",
      "When would random selection be acceptable?",
    ],
    redFlags: [
      "Treats multivalue as a weighted load balancer.",
      "Promises an exact rollback share.",
      "Ignores health checks.",
    ],
    rubric: [
      "States the random selection behavior.",
      "Separates availability from traffic control.",
      "Chooses weighted for an explicit share.",
      "Mentions the healthy-record limit or health checks.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Document the routing policy and the traffic control it provides.",
      "Size the new region for the target share plus headroom.",
      "Attach health checks to every record that can receive traffic.",
      "Set a TTL that matches the migration cadence and the rollback objective.",
      "Measure the real split from multiple resolver locations before the change.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm the policy can express the target share.",
      "Compare the achieved share with the intended weight or location rule.",
      "Watch the new region for errors and saturation after each step.",
      "Do not increase weight until the current step is healthy.",
      "Record the time of each change and wait for the TTL before judging it.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify the final share and the per-region error rate.",
      "Restore a normal TTL and remove temporary weights deliberately.",
      "Check that the old region can absorb a rollback.",
      "Update the runbook with the measured time for a weight change to take effect.",
    ],
  },
];

const references = [
  {
    title: "Choosing a routing policy",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The full policy list and the question each policy answers.",
  },
  {
    title: "Weighted routing",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/routing-policy-weighted.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Relative weights, the 0 to 255 range, gradual changes, and zero-weight behavior with health checks.",
  },
  {
    title: "Active-active and active-passive failover",
    url: "https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-types.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "How failover records choose primary and secondary resources, and how weighted records behave as active-active.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "route53-routing": {
      model: route53RoutingModel,
      presets,
      instructions:
        "Start Healthy. Set the target to 80% and choose Failover: the migration gap goes critical. Switch to Weighted: the gap closes. Lower region B capacity to 40% and watch requests fail. Finish with Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Route 53 policies, relative weights, and health-check behavior are real; the traffic split, 150% region A capacity, 50/50 multivalue split, and capacity percentages are teaching values. DNS caching still bounds every policy change.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-route53-health-checks",
    "traffic-dns-ttl-failover",
    "traffic-anycast",
    "traffic-global-accelerator",
  ],
};
