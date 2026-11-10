import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { ParamSpec, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const AZ_COUNT = 3;

const params: ParamSpec[] = [
  {
    id: "peakRps",
    label: "Peak request rate",
    min: 10_000,
    max: 100_000,
    step: 1_000,
    value: 30_000,
    unit: " rps",
    group: "Demand",
    help: "The busiest sustained rate the service must serve, not the daily average.",
    format: "rps",
  },
  {
    id: "fleetInstances",
    label: "Fleet size",
    min: 3,
    max: 60,
    step: 1,
    value: 30,
    unit: " instances",
    group: "Capacity",
    help: "Instances spread as evenly as possible across three availability zones (AZs).",
    format: "count",
  },
  {
    id: "failedAzs",
    label: "Failed AZs",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Availability zones lost at the same time. The largest zones fail first in this worst-case model.",
    format: "count",
  },
  {
    id: "instanceRps",
    label: "Capacity per instance",
    min: 500,
    max: 4_000,
    step: 100,
    value: 2_000,
    unit: " rps",
    group: "Capacity",
    help: "Usable request capacity per instance at the target latency. Illustrative, not an instance-type benchmark.",
    format: "rps",
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function azCapacities(fleet: number): number[] {
  const base = Math.floor(fleet / AZ_COUNT);
  const remainder = fleet % AZ_COUNT;
  return Array.from({ length: AZ_COUNT }, (_, index) => base + (index < remainder ? 1 : 0));
}

function latencyFor(utilizationPct: number): number {
  if (utilizationPct <= 0) return 60;
  if (utilizationPct >= 100) return 5_000;
  const ratio = utilizationPct / (100 - utilizationPct);
  return Math.min(5_000, 80 + 30 * ratio ** 1.5);
}

function errorsFor(utilizationPct: number): number {
  if (utilizationPct <= 95) return 0;
  return Math.min(40, (utilizationPct - 95) * 0.8);
}

interface Computed {
  peakRps: number;
  fleetInstances: number;
  failedAzs: number;
  instanceRps: number;
  azs: number[];
  totalCapacity: number;
  survivingCapacity: number;
  preUtil: number;
  postUtil: number;
  headroomPct: number;
  p99: number;
  errors: number;
  requiredForN1: number;
  capacityShortfall: number;
}

function compute(p: Params, utilOverride?: number): Computed {
  const peakRps = num(p, "peakRps", 30_000);
  const fleetInstances = Math.round(num(p, "fleetInstances", 30));
  const failedAzs = Math.min(2, Math.max(0, Math.round(num(p, "failedAzs", 0))));
  const instanceRps = num(p, "instanceRps", 2_000);
  const azs = azCapacities(fleetInstances);
  const totalCapacity = fleetInstances * instanceRps;
  const lostCapacity = azs.slice(0, failedAzs).reduce((sum, count) => sum + count * instanceRps, 0);
  const survivingCapacity = totalCapacity - lostCapacity;
  const preUtil = (peakRps / Math.max(1, totalCapacity)) * 100;
  const targetPost = survivingCapacity > 0 ? (peakRps / survivingCapacity) * 100 : 999;
  const postUtil = utilOverride === undefined ? targetPost : utilOverride;
  const requiredForN1 = Math.ceil(peakRps / ((AZ_COUNT - 1) / AZ_COUNT) / instanceRps);
  return {
    peakRps,
    fleetInstances,
    failedAzs,
    instanceRps,
    azs,
    totalCapacity,
    survivingCapacity,
    preUtil,
    postUtil,
    headroomPct: (survivingCapacity / Math.max(1, peakRps) - 1) * 100,
    p99: latencyFor(postUtil),
    errors: errorsFor(postUtil),
    requiredForN1,
    capacityShortfall: Math.max(0, peakRps - survivingCapacity),
  };
}

function healthFor(utilizationPct: number): "ok" | "warn" | "crit" {
  if (utilizationPct >= 90) return "crit";
  if (utilizationPct >= 70) return "warn";
  return "ok";
}

function buildFrame(p: Params, state: number | undefined, seed: number): SimFrame {
  const values = compute(p, state);
  const health = healthFor(values.postUtil);
  const zoneHealth = healthFor(values.postUtil);
  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "lb",
        label: "Load balancer",
        kind: "lb",
        health,
        utilization: clamp(values.postUtil / 100),
        throughput: values.peakRps,
        sublabel: `${values.peakRps.toLocaleString()} rps peak`,
        meta: { view: "flow" },
      },
      ...values.azs.map((instances, index) => {
        const failed = index < values.failedAzs;
        return {
          id: `az-${index}`,
          label: `AZ ${String.fromCharCode(65 + index)}`,
          kind: "service" as const,
          role: "zone" as const,
          health: failed ? ("down" as const) : zoneHealth,
          utilization: failed ? 0 : clamp(values.postUtil / 100),
          throughput: failed ? 0 : values.peakRps / Math.max(1, AZ_COUNT - values.failedAzs),
          capacity: instances * values.instanceRps,
          sublabel: failed ? `lost ${instances} instances` : `${instances} instances`,
          detail: failed
            ? `This zone is treated as lost. ${(instances * values.instanceRps).toLocaleString()} rps of capacity left the fleet.`
            : `Surviving zone. Fleet-wide post-failure utilization is ${values.postUtil.toFixed(1)}%.`,
          meta: { view: "flow", instances },
        };
      }),
      {
        id: "autoscaler",
        label: "Capacity control",
        kind: "service",
        health,
        utilization: clamp(Math.abs(values.headroomPct) / 100),
        sublabel: values.capacityShortfall > 0 ? "behind demand" : `${values.headroomPct.toFixed(0)}% margin`,
        meta: { view: "flow" },
      },
    ],
    edges: values.azs.map((_, index) =>
      edge(
        `lb-az-${index}`,
        "lb",
        `az-${index}`,
        index < values.failedAzs ? 0 : 1 / Math.max(1, AZ_COUNT - values.failedAzs),
        index < values.failedAzs ? "down" : zoneHealth,
      ),
    ),
    metrics: [
      metric("post-util", "Post-failure utilization", values.postUtil, "%", 70, 90, "percent"),
      metric("p99", "p99 latency", values.p99, "ms", 300, 800, "ms"),
      metric("errors", "Error rate", values.errors, "%", 0.5, 5, "percent"),
      metric("pre-util", "Pre-failure utilization", values.preUtil, "%", undefined, undefined, "percent"),
      metric("capacity-margin", "Capacity margin over peak", values.headroomPct, "%", undefined, undefined, "percent"),
      metric("capacity-shortfall", "Capacity shortfall", values.capacityShortfall, " rps", undefined, undefined, "rps"),
      metric("n1-needed", "Instances needed for N+1", values.requiredForN1, "", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      postUtil: values.postUtil,
      paramsKey: JSON.stringify(p),
    },
    summary: `${values.preUtil.toFixed(0)}% before failure, ${values.postUtil.toFixed(0)}% after losing ${values.failedAzs} AZ${values.failedAzs === 1 ? "" : "s"}; p99 ${values.p99.toFixed(0)}ms.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame): void {
  const seed = Number(frame.flags.seed ?? 1);
  for (const item of frame.metrics) {
    frame.series[item.id] = Array.from({ length: 12 }, (_, index) => {
      const wave = Math.sin((index + (seed % 5)) / 2.2) * Math.max(0.4, item.value * 0.025);
      return Math.max(0, item.value + wave);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "post-util",
    metricId: "post-util",
    warn: 70,
    crit: 90,
    title: "Post-failure utilization left the safe range",
    cause:
      "The surviving zones must carry the full peak after a failure domain is lost. At high utilization, queueing makes p99 rise faster than load, so an SLO breach can arrive before the fleet is technically full.",
    fix:
      "Add capacity or reduce peak demand until post-failure utilization sits below the target, not merely below 100%. Size from the largest failure domain at peak, then verify with a load test.",
    checkFirst: [
      "Confirm how much capacity the failed zone actually removed, including instances that were not serving.",
      "Compare pre-failure and post-failure utilization; the ratio should match the surviving fleet fraction.",
      "Check whether the autoscaler can add capacity before the peak, not after it.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 300,
    crit: 800,
    title: "Latency crossed the critical threshold after failover",
    cause:
      "The remaining zones are serving peak traffic at a utilization where queueing dominates. The fleet has capacity in aggregate but not enough headroom to absorb bursts.",
    fix:
      "Restore headroom before tuning timeouts. Shift traffic, add instances in surviving zones, or shed low-value work. Confirm that the dependency tier also has capacity after the failure.",
    checkFirst: [
      "Check p99 per zone and per instance, not only the fleet average.",
      "Check queue depth and thread or connection pool saturation at the service.",
      "Check whether a shared dependency lost capacity in the same event.",
    ],
  },
  {
    id: "errors",
    metricId: "errors",
    warn: 0.5,
    crit: 5,
    title: "Failover capacity is insufficient and requests are failing",
    cause:
      "The surviving fleet is beyond usable capacity, so admission, timeouts, or overload responses are rejecting work. This is the point where headroom becomes an outage rather than a cost.",
    fix:
      "Reduce load immediately, add capacity where it can actually help, and confirm that the remaining zones are healthy. Do not assume the cloud autoscaler can recover capacity inside the failure window.",
    checkFirst: [
      "Check whether the errors are local overload responses or dependency failures.",
      "Confirm the failed zone is truly isolated and not a shared-control-plane failure.",
      "Check the capacity of the next shared limit: database connections, NAT ports, or a load balancer.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const headroomModel: SimModel = {
  id: "foundations-capacity-headroom",
  visual: "topology",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), undefined, seed);
    seedSeries(frame);
    return frame;
  },
  step: (frame, p, dt) => {
    const target = compute(p);
    const previous = Number(frame.flags.postUtil ?? target.postUtil);
    const smoothing = Math.min(1, dt / 1.5);
    const util = previous + (target.postUtil - previous) * smoothing;
    const next = buildFrame(p, util, Number(frame.flags.seed ?? 1));
    next.t = frame.t;
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    next.events = [...frame.events, ...next.events].slice(-60);
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const values = compute(p);
    return [
      `At ${values.preUtil.toFixed(0)}% before failure, losing ${values.failedAzs} of ${AZ_COUNT} zones leaves the survivors at ${values.postUtil.toFixed(0)}%.`,
      `Each zone carries about ${(100 / AZ_COUNT).toFixed(1)}% of fleet capacity. The surviving fraction is ${(((AZ_COUNT - values.failedAzs) / AZ_COUNT) * 100).toFixed(0)}%.`,
      `This fleet needs ${values.requiredForN1} instances to keep N+1 at this peak; it has ${values.fleetInstances}.`,
      `Surviving capacity is ${Math.round(values.survivingCapacity).toLocaleString()} rps against a ${Math.round(values.peakRps).toLocaleString()} rps peak.`,
      "Average utilization is not a proxy for headroom. The peak and the largest failure domain set the requirement.",
    ];
  },
  legend: [
    { label: "Healthy", tone: "ok" },
    { label: "Near the knee", tone: "warn" },
    { label: "Overloaded", tone: "crit" },
    { label: "Zone lost", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Three equal zones at 50% pre-failure utilization. Losing one leaves 75%.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak demand",
    description: "Peak rises to 54k rps on 36 instances. No failure yet, but pre-failure headroom is thin.",
    tone: "warn",
    params: defaults({ peakRps: 54_000, fleetInstances: 36 }),
  },
  {
    id: "failure",
    label: "One AZ lost",
    description: "A 40k rps fleet runs at 75% before the loss. The surviving zones go above 100%.",
    tone: "crit",
    params: defaults({ peakRps: 30_000, fleetInstances: 20, failedAzs: 1 }),
  },
  {
    id: "double-failure",
    label: "Two AZs lost",
    description: "An N+1 fleet is not N+2. Two zone losses leave one zone carrying the peak.",
    tone: "crit",
    params: defaults({ peakRps: 30_000, fleetInstances: 36, failedAzs: 2 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "The failure is over. The fleet is sized so a repeat zone loss still leaves headroom.",
    tone: "ok",
    params: defaults({ peakRps: 30_000, fleetInstances: 36, failedAzs: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-post-failure-utilization",
  title: "Predict utilization after one zone fails",
  simId: "headroom",
  question:
    "Three equal zones run at 60% of fleet capacity at peak. One zone is lost. What utilization do the remaining zones carry?",
  prediction: {
    options: [
      { id: "ninety", label: "About 90%" },
      { id: "eighty", label: "About 80%" },
      { id: "sixty", label: "Still about 60%, because traffic drops with the zone" },
      { id: "over", label: "Above 120%" },
    ],
    correctOptionId: "ninety",
    explanation:
      "Two thirds of the fleet now serves the same peak. Utilization is 60% divided by two thirds, which is 90%. The fleet still has capacity, but it is at the queueing knee, where latency rises sharply.",
  },
  setup: defaults({ peakRps: 36_000, fleetInstances: 30, failedAzs: 1 }),
  runFor: 8,
  observe: [
    "Pre-failure utilization is 60%; post-failure utilization settles at 90%.",
    "p99 rises from roughly 110ms to roughly 890ms even though no request is rejected for lack of capacity.",
    "The capacity margin over peak is only about 11%, so a burst can exhaust it.",
    "Error rate begins to rise only when the queue cannot keep up, later than the latency signal.",
  ],
  explain:
    "With N equal zones, losing one leaves (N-1)/N of the capacity. Post-failure utilization is pre-failure utilization times N/(N-1). For three zones that is 1.5x: 60% becomes 90%. The arithmetic is simple; the operational mistake is comparing post-failure utilization with 100% instead of with the latency target.",
  fix: defaults({ peakRps: 36_000, fleetInstances: 45, failedAzs: 0 }),
  debrief:
    "At 45 instances the fleet runs at 40% of capacity with no failure. If one zone is lost, the surviving 60k rps remains above the 36k rps peak, so post-failure utilization is 60% and p99 stays in the healthy range. The cost is 50% more instances than the pre-failure peak needs. That is what N+1 insurance looks like when the target is a latency SLO, not merely a request counter.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Capacity headroom is the gap between the capacity a service needs and the capacity it has. N+1 means the fleet can lose one failure domain, usually one availability zone (AZ), and still serve peak demand. N+2 means it can lose two. The labels describe a failure count, not a percentage, and the correct comparison is against peak demand and the largest failure domain, not against the daily average.",
  },
  {
    type: "p",
    text: "With three equal zones, each zone carries about a third of fleet capacity. Losing one leaves two thirds. Post-failure utilization is therefore pre-failure utilization multiplied by three halves. A fleet at 60% of capacity before the loss runs at 90% after it. A fleet at 75% runs at 112.5%, which is already beyond capacity even though the pre-failure graph looked acceptable.",
  },
  {
    type: "table",
    headers: ["Pre-failure utilization", "Post-failure with 2 of 3 zones", "What the number means"],
    rows: [
      ["40%", "60%", "Comfortable headroom after one zone loss"],
      ["50%", "75%", "Usable, but close to the queueing knee"],
      ["60%", "90%", "Technically serving, latency-sensitive, little burst room"],
      ["75%", "112.5%", "Over capacity; requests queue and fail"],
    ],
  },
  {
    type: "p",
    text: "The queueing knee is why the target is not 100%. Latency rises nonlinearly as utilization approaches saturation, so a fleet at 90% can breach a p99 SLO while still returning successful responses. Headroom is insurance against both the failure and the burst that follows it, including reconnect storms, retries, and the traffic that used to land in the lost zone.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The capacity path is the load balancer, the zones, the instances, and the shared dependencies behind them. The load balancer spreads traffic across healthy targets. The autoscaler adjusts the fleet, but it reacts on a timescale that is often slower than the failure. The database, cache, NAT gateway, and control plane may not lose a third of their capacity when an app zone fails, which means the app can appear to have N+1 while a shared dependency does not.",
  },
  {
    type: "p",
    text: "The model keeps three zones and spreads instances as evenly as integer counts allow. It treats the largest zones as the ones lost, which is the worst case for headroom. Capacity per instance is an illustrative teaching value, not an EC2 or ECS benchmark. Time is simulated: a failure is applied through the preset, and the displayed utilization moves toward its post-failure target over about a second and a half.",
  },
  {
    type: "compare",
    leftTitle: "N+1",
    rightTitle: "N+2",
    rows: [
      { label: "Survives", left: "One failure domain", right: "Two failure domains" },
      { label: "With three zones", left: "Two thirds of capacity remains", right: "One third remains" },
      { label: "Cost", left: "Lower, but a second failure is an outage", right: "Higher, and may still fail on a shared dependency" },
      { label: "Use when", left: "One independent failure is credible and recovery is bounded", right: "Two correlated failures or a long recovery are credible" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Post-failure utilization: the metric that decides whether the fleet can carry peak after the loss.",
      "p99 latency: the first user-visible signal that the remaining zones are near the knee.",
      "Error rate: what happens when utilization is beyond usable capacity, not merely high.",
      "Pre-failure utilization and capacity margin: why the pre-failure graph can look safe.",
      "Instances needed for N+1: the fleet size implied by peak demand and the largest failure domain.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply One AZ lost. Compare post-failure utilization with pre-failure utilization and watch p99 move before errors appear. Apply Two AZs lost to see why N+1 is not N+2. Run the experiment at 60% and then apply the fix to see the fleet size required to keep the post-failure number at 60%.",
  },
  { type: "sim", simId: "headroom" },
  { type: "experiment", experimentId: "predict-post-failure-utilization" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The fleet was serving peak at a comfortable-looking pre-failure utilization. When one zone was treated as lost, the same peak had to fit into the remaining zones. Utilization rose by the ratio of total to surviving capacity, and latency rose faster than utilization because the remaining fleet was near the queueing knee. Errors appeared later, once the surviving fleet could no longer keep up.",
  },
  {
    type: "p",
    text: "Sizing for N+1 at the SLO target, rather than at 100%, required more instances than the pre-failure peak alone. That extra capacity is the cost of surviving the failure without breaching the latency target. The double-failure preset showed the limit of the promise: a fleet sized for one loss is not a fleet sized for two.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "AWS Application Load Balancer: `UnHealthyHostCount`, `HealthyHostCount`, `TargetResponseTime`, `RequestCount`, and `HTTPCode_Target_5XX_Count`, split by target group and zone where available.",
      "EC2 Auto Scaling: `GroupInServiceInstances`, `GroupDesiredCapacity`, and `GroupPendingInstances`. A desired count that is met does not prove the instances are in the right zones.",
      "EC2 and ECS: `CPUUtilization`, `StatusCheckFailed`, task placement across zones, and per-task throttling. Aggregate CPU can hide a zone that is out of capacity.",
      "AWS Health and zone-level events: confirm whether the failure is isolated to one zone or shared by the control plane, load balancer, or a dependency.",
      "Traces: latency by zone and by instance. A post-failure p99 that rises in the surviving zones is the queueing signal, not a network problem.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Calculate surviving capacity as a fraction of fleet capacity, then divide peak demand by it. Check p99 in the surviving zones before errors appear. Confirm that shared dependencies did not lose capacity in the same event. A fleet that is N+1 for compute can still be N+0 for its database or NAT gateway.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the scope of the failure: one zone, multiple zones, or a shared service that looks like a zone failure.",
      "Calculate post-failure utilization from peak demand and surviving capacity, not from the current average.",
      "Shift traffic to healthy zones only if they have room; otherwise reduce demand or shed low-value work first.",
      "Add capacity in the surviving zones and verify that the autoscaler can place it there.",
      "Check the next shared limit: database connections, cache throughput, NAT ports, and load balancer capacity.",
      "After recovery, rebalance instances across zones and re-run a failure test at peak.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Headroom costs money every hour. The right amount is set by the SLO, peak variability, and recovery time, not by an industry percentage.",
      "N+2 is more resilient and more expensive. It also does not protect against a shared dependency or a correlated configuration change.",
      "Larger failure domains are cheaper to operate and remove more capacity at once. Zone count is a design variable, not a constant.",
      "Autoscaling reduces idle cost but adds reaction lag. It cannot replace headroom for a failure that removes capacity faster than the fleet can scale.",
      "Averages hide peaks. Sizing from average utilization is the most common way to discover that N+1 was only N+1 on paper.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "post-failure-math",
    question:
      "A service runs three equal AZs at 60% of peak capacity. One AZ fails. What is the utilization in the remaining zones, and is the service healthy?",
    difficulty: 2,
    hints: [
      "The surviving fleet is two thirds of the original capacity.",
      "Utilization is demand divided by surviving capacity.",
    ],
    answer:
      "The remaining two zones carry the same peak with two thirds of the capacity, so utilization becomes 60% times three halves, or 90%. The service may still return successful responses, but it is near the queueing knee: p99 will rise sharply, burst absorption is small, and a retry or reconnect wave can push it over capacity. I would call that unhealthy for a latency SLO even though it is below 100%, and I would add capacity or reduce demand until post-failure utilization is back in the target range.",
    followUps: [
      "What if the zones are not equal?",
      "How does a 99.9% latency SLO change the target?",
      "What else in the stack might not have N+1?",
    ],
    redFlags: [
      "Says 60% because demand also drops.",
      "Uses 100% as the only threshold.",
      "Ignores queueing and latency.",
    ],
    rubric: [
      "Computes 90% correctly.",
      "Explains the queueing consequence.",
      "Distinguishes capacity from health.",
      "Names the next constraint.",
    ],
  },
  {
    id: "n1-vs-n2",
    question:
      "When would you pay for N+2 instead of N+1, and what has to be true for that spending to help?",
    difficulty: 3,
    hints: [
      "Start from the credible failure combinations, not from a generic best practice.",
      "N+2 only helps if the failures are independent and recovery is bounded.",
    ],
    answer:
      "I would pay for N+2 when two failures can plausibly overlap, when a second failure is likely during recovery, or when the recovery time is long enough that a second event can arrive before the first is repaired. It only helps if the failure domains are actually independent across power, network, deployment, and dependency paths. If two zones share a database, a control plane, or a deployment pipeline, N+2 compute does not buy two independent failures. I would also compare the cost with faster recovery, better isolation, or load shedding. The label is a capacity promise, not a resilience guarantee.",
    followUps: [
      "Which shared dependencies would invalidate N+2?",
      "How does recovery time affect the answer?",
      "What would you test in a game day?",
    ],
    redFlags: [
      "Chooses N+2 without a failure model.",
      "Assumes zones are independent by label.",
      "Ignores recovery time.",
    ],
    rubric: [
      "Names credible overlapping failures.",
      "Checks independence and shared dependencies.",
      "Compares cost with other mitigations.",
      "Mentions testing.",
    ],
  },
  {
    id: "average-vs-peak",
    question:
      "Finance says the fleet averages 35% utilization and asks why you need more capacity. How do you answer?",
    difficulty: 2,
    hints: [
      "Average is not peak, and peak is not post-failure peak.",
      "Show the failure calculation and the SLO consequence.",
    ],
    answer:
      "The average is the wrong denominator because capacity must cover the busiest sustained period and the loss of a failure domain at that period. I would show three numbers: peak demand, fleet capacity, and surviving capacity after the largest zone loss. If peak is 70% of fleet capacity, losing one of three zones pushes the survivors to 105%, which is an outage. The average can be 35% all day and still hide that. I would connect the extra capacity to a specific SLO and a specific failure, then compare it with the cost of the outage and the cost of faster recovery.",
    followUps: [
      "How would you measure peak demand?",
      "What if the peak lasts only ten minutes a day?",
      "How does autoscaling change the calculation?",
    ],
    redFlags: [
      "Accepts average as the sizing input.",
      "Cannot quantify post-failure utilization.",
      "Buys capacity without naming the failure it covers.",
    ],
    rubric: [
      "Uses peak and failure-domain math.",
      "Ties capacity to an SLO.",
      "Compares cost with outage risk.",
      "Accounts for autoscaling lag.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Peak demand is measured over a window that includes the busiest sustained period, not a daily mean.",
      "The largest failure domain is named, including shared dependencies that fail with it.",
      "Post-failure utilization is calculated at peak for one and two domain losses.",
      "The autoscaler can add capacity inside the failure window, or the design does not depend on it.",
      "A zone-loss game day has been run at peak, not only in a tabletop exercise.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Confirm whether the failure is zonal or shared before shifting traffic.",
      "Calculate surviving capacity and post-failure utilization immediately.",
      "Reduce demand or shed low-value work if the surviving zones cannot carry peak.",
      "Check the next shared limit: database, cache, NAT, and load balancer.",
      "Record the capacity decision and the evidence in the incident timeline.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Rebalance instances across zones and confirm the autoscaler is not stuck in one zone.",
      "Re-run the failure test at peak and verify p99 in the surviving zones.",
      "Revisit the N+1 or N+2 promise against the actual failure that occurred.",
      "Update the capacity model with the observed per-instance capacity.",
    ],
  },
];

const references = [
  {
    title: "Static stability using Availability Zones",
    url: "https://aws.amazon.com/builders-library/static-stability-using-availability-zones/",
    publisher: "AWS Builders' Library",
    kind: "docs" as const,
    note: "Designing for zone failure without depending on control-plane reaction.",
  },
  {
    title: "Addressing Cascading Failures",
    url: "https://sre.google/sre-book/addressing-cascading-failures/",
    publisher: "Google SRE Book",
    kind: "book" as const,
    note: "Overload, queueing, and why headroom matters before saturation.",
  },
  {
    title: "Reliability Pillar",
    url: "https://docs.aws.amazon.com/wellarchitected/latest/reliability-pillar/welcome.html",
    publisher: "AWS Well-Architected",
    kind: "docs" as const,
    note: "Failure-domain planning and capacity considerations for reliable workloads.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    headroom: {
      model: headroomModel,
      presets,
      instructions:
        "Start Healthy, apply One AZ lost, and compare pre-failure and post-failure utilization. Then try Two AZs lost and the recovery preset. Watch p99 before the error rate moves.",
      experimentIds: [experiment.id],
      alternateVisuals: ["flow"],
      note: "Illustrative model. Three equal zones, integer instance placement, and 2k rps per instance are teaching assumptions.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-queueing-knee",
    "capacity-headroom-cost",
    "case-composite-az-capacity",
    "foundations-failure-domains",
  ],
};
