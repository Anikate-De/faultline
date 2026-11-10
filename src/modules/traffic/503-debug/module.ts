import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimNode, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TARGET_COUNT = 3;
const MAX_REQUEST_RATE = 20_000;
const TARGET_RPS = 5_000;
const CPU_AT_FULL_CONCURRENCY = 40;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 200,
    max: MAX_REQUEST_RATE,
    step: 100,
    value: 1_500,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving at the ALB. Requests that cannot be accepted become 503s.",
    format: "rps" as const,
  },
  {
    id: "registeredTargets",
    label: "Registered targets",
    min: 0,
    max: TARGET_COUNT,
    step: 1,
    value: 3,
    unit: " of 3",
    group: "Targets",
    help: "Targets registered and able to receive traffic. Zero means none are registered, which is the ELB-generated 503 case.",
    format: "count" as const,
  },
  {
    id: "targetConcurrency",
    label: "Target concurrency limit",
    min: 10,
    max: 1_000,
    step: 10,
    value: 200,
    unit: " reqs",
    group: "Targets",
    help: "Requests one target allows in flight. When the limit is full, the target rejects excess requests with its own 503.",
    format: "count" as const,
  },
  {
    id: "targetServiceTime",
    label: "Target service time",
    min: 10,
    max: 1_000,
    step: 10,
    value: 100,
    unit: " ms",
    group: "Targets",
    help: "Average time a target holds one in-flight request. Capacity is concurrency divided by service time.",
    format: "ms" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Demand {
  requestRate: number;
  registeredTargets: number;
  targetConcurrency: number;
  targetServiceTime: number;
  capacityPerTarget: number;
  acceptedPerTarget: number;
  acceptedRps: number;
  target503: number;
  elb503: number;
  total503: number;
  rate503: number;
  targetLoad: number;
  cpu: number;
  inFlight: number;
}

function demand(p: Params): Demand {
  const requestRate = Math.max(1, num(p, "requestRate", 1_500));
  const registeredTargets = Math.min(
    TARGET_COUNT,
    Math.max(0, Math.round(num(p, "registeredTargets", 3))),
  );
  const targetConcurrency = Math.max(1, num(p, "targetConcurrency", 200));
  const targetServiceTime = Math.max(1, num(p, "targetServiceTime", 100));
  const capacityPerTarget = targetConcurrency * (1_000 / targetServiceTime);
  const targetDemand = registeredTargets > 0 ? requestRate / registeredTargets : 0;
  const acceptedPerTarget =
    registeredTargets > 0 ? Math.min(targetDemand, capacityPerTarget) : 0;
  const acceptedRps = acceptedPerTarget * registeredTargets;
  const target503 = registeredTargets > 0 ? Math.max(0, requestRate - acceptedRps) : 0;
  const elb503 = registeredTargets === 0 ? requestRate : 0;
  const total503 = elb503 + target503;
  const loadRatio =
    registeredTargets > 0 && capacityPerTarget > 0
      ? targetDemand / capacityPerTarget
      : 0;
  return {
    requestRate,
    registeredTargets,
    targetConcurrency,
    targetServiceTime,
    capacityPerTarget,
    acceptedPerTarget,
    acceptedRps,
    target503,
    elb503,
    total503,
    rate503: (total503 / requestRate) * 100,
    targetLoad: Math.min(100, loadRatio * 100),
    cpu: Math.min(CPU_AT_FULL_CONCURRENCY, loadRatio * CPU_AT_FULL_CONCURRENCY),
    inFlight: Math.min(targetConcurrency, targetDemand * (targetServiceTime / 1_000)),
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const incidentHealth = d.rate503 >= 2 ? "crit" : d.rate503 >= 0.5 ? "warn" : "ok";
  const targets: SimNode[] = Array.from({ length: TARGET_COUNT }, (_, index) => {
    const registered = index < d.registeredTargets;
    if (!registered) {
      return {
        id: `target-${index + 1}`,
        label: `Target ${String.fromCharCode(65 + index)}`,
        kind: "service",
        health: "down",
        throughput: 0,
        sublabel: "not registered",
        detail:
          "This target is not registered or is in an unused state. The ALB cannot route requests to it, so it contributes nothing to capacity.",
        meta: { view: "flow", state: "unregistered" },
      };
    }
    const targetHealth =
      d.inFlight >= d.targetConcurrency * 0.95
        ? "crit"
        : d.inFlight >= d.targetConcurrency * 0.8
          ? "warn"
          : "ok";
    return {
      id: `target-${index + 1}`,
      label: `Target ${String.fromCharCode(65 + index)}`,
      kind: "service",
      health: targetHealth,
      utilization: clamp(d.inFlight / d.targetConcurrency),
      throughput: d.acceptedPerTarget,
      sublabel: `${Math.round(d.inFlight)}/${d.targetConcurrency} in flight · check passing`,
      detail: `The shallow health check passes. ${formatCount(d.acceptedPerTarget)} requests/s are accepted; ${
        d.target503 > 0
          ? "excess requests receive a 503 from the target while CPU is moderate."
          : "no target-generated 503 is occurring."
      }`,
      meta: { view: "flow", state: d.target503 > 0 ? "shedding" : "serving" },
    };
  });

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: incidentHealth,
        throughput: d.requestRate,
        sublabel: `${d.rate503.toFixed(1)}% receive 503`,
        detail: `${formatCount(d.total503)} requests/s receive a 503. The source can be the ALB or a target, and the two have different fixes.`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: incidentHealth,
        utilization: clamp(d.requestRate / MAX_REQUEST_RATE),
        throughput: d.acceptedRps,
        sublabel: `ELB 503 · ${formatCount(d.elb503)}/s`,
        detail:
          d.registeredTargets === 0
            ? "No registered target can receive traffic, so the ALB generates the 503 before a target is chosen. Target CPU is zero because no target receives the request."
            : `The ALB forwards requests to ${d.registeredTargets} registered targets. ${formatCount(d.elb503)} ELB-generated 503s/s and ${formatCount(d.target503)} target-generated 503s/s.`,
        meta: { view: "flow", registered: d.registeredTargets },
      },
      ...targets,
    ],
    edges: [
      edge("client-alb", "client", "alb", d.requestRate / MAX_REQUEST_RATE, incidentHealth),
      ...targets.map((target, index) =>
        edge(
          `alb-${target.id}`,
          "alb",
          target.id,
          index < d.registeredTargets ? d.acceptedPerTarget / TARGET_RPS : 0,
          target.health,
        ),
      ),
    ],
    metrics: [
      metric("rate-503", "503 rate", d.rate503, "%", 0.5, 2, "percent"),
      metric("responses-503", "503 responses", d.total503, " /s", 10, 100, "rps"),
      metric("elb-503", "ELB-generated 503", d.elb503, " /s", undefined, undefined, "rps"),
      metric("target-503", "Target-generated 503", d.target503, " /s", undefined, undefined, "rps"),
      metric("registered-targets", "Registered targets", d.registeredTargets, " targets", undefined, undefined, "count"),
      metric("target-cpu", "Target CPU", d.cpu, "%", undefined, undefined, "percent"),
      metric("target-load", "Target request-path load", d.targetLoad, "%", 80, 95, "percent"),
      metric("in-flight", "In-flight per target", d.inFlight, " reqs", undefined, undefined, "count"),
    ],
    events: [],
    series: {},
    flags: { seed, registered: d.registeredTargets },
    summary: `${d.rate503.toFixed(1)}% 503s (${formatCount(d.total503)}/s): ELB-generated ${formatCount(
      d.elb503,
    )}/s, target-generated ${formatCount(d.target503)}/s; ${d.registeredTargets}/3 targets registered; target CPU ${d.cpu.toFixed(0)}%.`,
  };
  return frame;
}

const thresholds: ThresholdSpec[] = [
  {
    id: "rate-503",
    metricId: "rate-503",
    warn: 0.5,
    crit: 2,
    title: "503 rate crossed the threshold",
    cause:
      "Requests are being rejected because no target can receive them or because a target is shedding load. The two cases look identical at the client and need different fixes.",
    fix:
      "Split ELB-generated from target-generated 503s, then check registration and target concurrency before changing CPU or instance size.",
    checkFirst: [
      "Compare HTTPCode_ELB_503_Count with HTTPCode_Target_5XX_Count.",
      "Read target_status_code in the access log: a dash points to the ALB, a 503 points to the target.",
      "Check the target group for registered targets and unused or stopped targets.",
    ],
  },
  {
    id: "responses-503",
    metricId: "responses-503",
    warn: 10,
    crit: 100,
    title: "503 volume is high",
    cause:
      "The absolute rejection count is large enough to consume the error budget and amplify retries, even if the percentage looks small at high traffic.",
    fix:
      "Stop the source, then restore capacity or reduce demand. Bound retries and confirm the remaining targets can absorb the traffic.",
    checkFirst: [
      "Group 503s by target group, Availability Zone, and target.",
      "Check whether retries are increasing the request rate at the same time.",
      "Confirm that the remaining targets have headroom before shifting traffic.",
    ],
  },
  {
    id: "target-load",
    metricId: "target-load",
    warn: 80,
    crit: 95,
    title: "The target request path is at capacity",
    cause:
      "Registered targets are at their concurrency limit. Excess requests are rejected as target-generated 503s while CPU can stay moderate because work is waiting on a pool or downstream call.",
    fix:
      "Add targets, reduce per-request time, or raise concurrency only after confirming the downstream has headroom. Shed low-value load if the bottleneck is behind the target.",
    checkFirst: [
      "Compare in-flight requests with the configured concurrency or connection-pool limit.",
      "Check downstream pool saturation and wait time, not only CPU.",
      "Confirm that the target's health check still passes while the request path sheds load.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const serviceUnavailableModel: SimModel = {
  id: "traffic-503-debug",
  visual: "flow",
  params,
  init: ({ seed }) => buildFrame(defaults(), seed),
  step: (frame, p, _dt, rng) => {
    const d = demand(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags, seed, paramsKey: JSON.stringify(p) };
    next.events = [...frame.events].slice(-60);
    next.series = Object.fromEntries(
      Object.entries(frame.series).map(([seriesKey, values]) => [seriesKey, [...values]]),
    );
    const jitter = 1 + rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "target-cpu" ? { ...item, value: Math.max(0, item.value * jitter) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (d.elb503 > 0 && next.flags.noTarget !== 1) {
      pushEvent(next, {
        id: "no-registered-target",
        at: frame.t,
        severity: "crit",
        title: "No registered target can receive traffic",
        detail: `The ALB generates ${formatCount(d.elb503)} 503s/s before choosing a target. Target CPU is ${d.cpu.toFixed(0)}% because the requests never reach a target.`,
        nodeId: "alb",
        metricId: "elb-503",
      });
      next.flags.noTarget = 1;
    }
    if (d.elb503 === 0) next.flags.noTarget = 0;
    if (d.target503 > 0 && next.flags.targetOverload !== 1) {
      pushEvent(next, {
        id: "target-shedding",
        at: frame.t,
        severity: "crit",
        title: "Targets are rejecting requests with 503",
        detail: `${formatCount(d.target503)} requests/s are rejected by targets at ${formatCount(
          d.inFlight,
        )}/${d.targetConcurrency} in flight. CPU is ${d.cpu.toFixed(
          0,
        )}%, so the limit is concurrency or a downstream pool, not CPU.`,
        nodeId: "target-1",
        metricId: "target-503",
      });
      next.flags.targetOverload = 1;
    }
    if (d.target503 === 0) next.flags.targetOverload = 0;
    next.summary = `${d.rate503.toFixed(1)}% 503s (${formatCount(d.total503)}/s): ELB-generated ${formatCount(
      d.elb503,
    )}/s, target-generated ${formatCount(d.target503)}/s; ${d.registeredTargets}/3 targets registered; target CPU ${d.cpu.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `${formatCount(d.total503)} of ${formatCount(d.requestRate)} requests/s receive a 503 (${d.rate503.toFixed(1)}%). ELB-generated: ${formatCount(d.elb503)}/s; target-generated: ${formatCount(d.target503)}/s.`,
    );
    if (d.registeredTargets === 0) {
      items.push(
        "No target is registered, so the ALB generates the 503 and target CPU is zero. Adding CPU or raising a connection limit cannot help until a target is registered.",
      );
    } else if (d.target503 > 0) {
      items.push(
        `Targets accept ${formatCount(d.acceptedPerTarget)} requests/s each and reject the rest. In-flight is ${formatCount(
          d.inFlight,
        )}/${d.targetConcurrency}, which is the binding limit, not CPU.`,
      );
    } else {
      items.push(
        `Targets are below their concurrency limit: ${formatCount(d.inFlight)}/${d.targetConcurrency} in flight and ${d.targetLoad.toFixed(0)}% request-path load.`,
      );
    }
    items.push(
      "A target-generated 503 is a valid HTTP response from the target and increments target 5xx. An ELB-generated 503 has no target status code.",
    );
    items.push(
      "Current AWS guidance says an ALB fails open when every registered target is unhealthy, so all-red health checks are not the same as an ELB 503. Check registration and unused state.",
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
    description: "Three registered targets at 25% of their request-path capacity.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Traffic reaches 80% of target request-path capacity. No 503s yet.",
    tone: "warn",
    params: defaults({ requestRate: 4_800 }),
  },
  {
    id: "failure",
    label: "All deregistered",
    description: "No targets are registered. The ALB returns 503 while target CPU is idle.",
    tone: "crit",
    params: defaults({ requestRate: 3_000, registeredTargets: 0 }),
  },
  {
    id: "overload",
    label: "Target limit",
    description: "Targets are registered and healthy, but their concurrency limit is full. CPU is about 40%.",
    tone: "crit",
    params: defaults({ requestRate: 9_000, registeredTargets: 3 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Targets are registered again and traffic is below their concurrency limit.",
    tone: "ok",
    params: defaults({ requestRate: 3_000, registeredTargets: 3 }),
  },
];

const experiment: Experiment = {
  id: "explain-503-at-low-cpu",
  title: "Explain a 503 at 40% CPU",
  simId: "503-debug",
  question:
    "The ALB returns 503s while target CPU is about 40% and every target passes its health check. What is the most likely cause?",
  prediction: {
    options: [
      {
        id: "target-limit",
        label:
          "The target's concurrency or connection-pool limit is full; it rejects excess requests with 503 while CPU stays moderate.",
      },
      {
        id: "no-targets",
        label: "No targets are registered, so the ALB generates the 503 with zero target CPU.",
      },
      {
        id: "alb-cpu",
        label: "The ALB is out of CPU; the targets are healthy and only the edge is constrained.",
      },
      {
        id: "dns",
        label: "DNS is returning stale records, so some clients reach the wrong endpoint.",
      },
    ],
    correctOptionId: "target-limit",
    explanation:
      "A target-generated 503 appears in HTTPCode_Target_5XX_Count and has target_status_code 503 in the access log. The target's health check can still pass because it does not use the saturated request path. CPU can be moderate when in-flight requests are waiting on a connection pool or downstream call. No registered targets would show zero target CPU and an ELB-generated 503. The ALB is not a CPU bottleneck in this path.",
  },
  setup: defaults({ requestRate: 9_000, registeredTargets: 3 }),
  runFor: 20,
  observe: [
    "The 503 rate settles near 33%, about 3,000 503s/s.",
    "ELB-generated 503 stays at 0/s; all 3,000 are target-generated.",
    "Each target reports 200/200 requests in flight and 100% request-path load.",
    "Target CPU sits near 40% and the three targets still pass health checks.",
  ],
  explain:
    "The target accepts work until its concurrency limit is full, then rejects the excess immediately with 503. The accepted requests are waiting, not burning CPU, so utilization stays moderate. The health check asks a cheap path and passes. The useful signal is the gap between target-generated 503 and ELB-generated 503, followed by in-flight requests against the concurrency limit.",
  fix: defaults({ requestRate: 9_000, registeredTargets: 3, targetConcurrency: 500 }),
  debrief:
    "Raising the target concurrency limit from 200 to 500 moves capacity from 6,000 to 15,000 requests/s. The 503s stop and CPU falls near 24% because the same traffic is spread across more in-flight slots. That is only safe if the downstream pool has headroom; otherwise the queue moves one layer deeper. Adding targets has the same effect without increasing per-target concurrency.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A 503 Service Unavailable means the server cannot handle the request right now. With an Application Load Balancer (ALB), the status can come from two very different places. The ALB can generate it when no registered target can receive traffic, or a target can generate it when its own concurrency, connection pool, or dependency is exhausted. The client sees the same code, but the fix is different.",
  },
  {
    type: "p",
    text: "AWS documents the ALB-generated case narrowly: the target group has no registered targets, or all registered targets are in an unused state, or an Availability Zone has no targets while cross-zone load balancing is off. Current AWS guidance also says an ALB fails open when every registered target is unhealthy, so a wall of red health checks does not by itself prove an ELB 503. Check registration and target state before you infer a health-check outage.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The request path is client, ALB, target. An ALB 503 is created before a target is chosen, so target CPU, target logs, and target request counts stay quiet. A target 503 is created after the request reaches the application; it is a normal HTTP response that the ALB forwards, and it increments the target 5xx metric. The first diagnostic split is therefore ELB-generated versus target-generated, not CPU high versus CPU low.",
  },
  {
    type: "table",
    headers: ["Code", "What it means", "First split"],
    rows: [
      ["502", "The gateway could not obtain a valid response from the target.", "Compare ELB 502 with target 5xx; read target_status_code."],
      ["503", "No target can receive traffic, or a target is rejecting with 503.", "Compare ELB 503 with target 5xx; check registration and target state."],
      ["504", "A gateway timer expired before the upstream responded.", "Compare elapsed time with the idle timeout; read target_processing_time."],
    ],
  },
  {
    type: "p",
    text: "In CloudWatch, compare HTTPCode_ELB_503_Count with HTTPCode_Target_5XX_Count. In access logs, compare elb_status_code with target_status_code. A dash in target_status_code means the ALB generated the response; a 503 in target_status_code means the target answered. HealthyHostCount tells you about health checks, not whether a target is registered or has capacity.",
  },
  {
    type: "compare",
    leftTitle: "ELB-generated 503",
    rightTitle: "Target-generated 503",
    rows: [
      { label: "Where it starts", left: "Inside the load balancer, before target selection", right: "Inside the application or its connection pool" },
      { label: "Target CPU", left: "Zero or unchanged; requests never arrive", right: "Can be low, moderate, or high depending on the wait" },
      { label: "CloudWatch", left: "HTTPCode_ELB_503_Count rises; target 5xx flat", right: "HTTPCode_Target_5XX_Count rises; ELB 503 flat" },
      { label: "First fix", left: "Register or start targets; check the target group and zone", right: "Relieve the pool or concurrency limit; add targets or shed" },
    ],
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A 503 rate, absolute 503 volume, and the ELB-versus-target source split.",
      "Registered targets, target CPU, request-path load, and in-flight requests per target.",
      "Target cards that can be healthy and still reject requests at their concurrency limit.",
      "An incident event for the no-target case and a separate event for target shedding.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply All deregistered. Note that CPU is zero and the 503 is ELB-generated. Apply Target limit and compare the source counters: CPU is about 40% and every 503 is target-generated. Finish with Recovery, then raise the target concurrency limit to see the capacity change.",
  },
  { type: "sim", simId: "503-debug" },
  { type: "experiment", experimentId: "explain-503-at-low-cpu" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "With no registered targets, the ALB generated every 503 itself. Target CPU was zero because no request reached a target. With three registered targets at a 200-request concurrency limit and 100 ms service time, capacity was 6,000 requests/s. At 9,000 requests/s, each target accepted 2,000 and rejected the remaining 1,000, so 3,000 503s/s were target-generated while CPU sat near 40%.",
  },
  {
    type: "p",
    text: "Both incidents look the same to the client. The source split is what changes the response: registration and target state for the first, target capacity or downstream headroom for the second. Raising the concurrency limit moved capacity to 15,000 requests/s and cleared the 503s, but only because the model assumes the downstream can absorb the additional in-flight work.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch ALB: HTTPCode_ELB_503_Count, HTTPCode_Target_5XX_Count, RequestCount, HealthyHostCount, UnHealthyHostCount, TargetConnectionErrorCount, and TargetResponseTime.",
      "Access logs: elb_status_code, target_status_code, target:port, and request counts. A target-generated 503 has both status fields set to 503; an ELB-generated 503 has no target status.",
      "Target runtime: in-flight requests, worker or connection-pool saturation, queue wait, and downstream latency. CPU alone can stay moderate while every worker waits.",
      "Registration state: describe-target-health, Auto Scaling group attachment, ECS service events, and whether the target group has any registered targets at all.",
      "Zone state: an enabled Availability Zone with no targets can return 503 for requests handled by that zone when cross-zone load balancing is off.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Split ELB 503 from target 5xx. If the ELB count is rising, check registration and unused targets before CPU. If target 5xx is rising, compare in-flight requests with the concurrency or pool limit and check the downstream. A green health check only means the health path passed.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read elb_status_code and target_status_code for the same requests to identify the source.",
      "For an ELB 503, check that targets are registered, running, and not in an unused state; repair the Auto Scaling or ECS registration path.",
      "For an enabled zone with no targets, add targets or enable cross-zone load balancing deliberately.",
      "For a target 503, compare in-flight requests with the concurrency or connection-pool limit and check wait time on the downstream.",
      "Add targets, reduce service time, or raise concurrency only after confirming the downstream has capacity; otherwise shed low-value load.",
      "Bound retries and verify that recovery does not create a second wave against the same pool.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Raising per-target concurrency is fast but can move the queue into a database or downstream pool, where latency and failure are harder to see.",
      "Adding targets adds capacity and cost; it also multiplies connection and health-check load on shared dependencies.",
      "Failing open keeps traffic flowing when health checks are wrong, but it can send requests to targets that cannot serve them, producing 502 or 504 instead of 503.",
      "Aggressive health checks remove targets quickly but can turn a transient blip into a capacity shortage.",
      "Shedding load protects goodput but requires a priority policy; rejecting all excess traffic equally can take down interactive users while batch work continues.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "503-at-40-cpu",
    question:
      "The ALB returns 503s but target CPU is 40%. Walk me through the possible causes and how you separate them.",
    difficulty: 2,
    hints: [
      "The same status code can be generated before or after target selection.",
      "CPU is a utilization signal, not a concurrency or pool signal.",
    ],
    answer:
      "I would split ELB-generated from target-generated 503s first. I compare HTTPCode_ELB_503_Count with HTTPCode_Target_5XX_Count and read elb_status_code versus target_status_code. If the ELB count rises, I check whether the target group has registered targets, whether they are unused or stopped, and whether an enabled zone has no targets with cross-zone off. If target 5xx rises, the application is rejecting, so I compare in-flight requests with its concurrency or connection-pool limit and check downstream wait. CPU at 40% fits a wait-bound pool; it does not rule out a target limit. I would not add CPU before the source split.",
    followUps: [
      "What does HealthyHostCount tell you, and what does it not tell you?",
      "How would cross-zone load balancing change the zone diagnosis?",
      "When would you choose load shedding over adding targets?",
    ],
    redFlags: [
      "Scales CPU because 40% sounds low.",
      "Assumes all 503s are caused by unhealthy targets.",
      "Reads only the client error rate and not the ELB/target split.",
    ],
    rubric: [
      "Names both 503 sources.",
      "Checks registration and unused state.",
      "Checks concurrency or pool saturation.",
      "Avoids a CPU-only diagnosis.",
    ],
  },
  {
    id: "deregistered-targets",
    question:
      "All targets are deregistered, but the tasks are running. How can that happen, and what do you check?",
    difficulty: 2,
    hints: [
      "Running is not the same as registered.",
      "The registration path is separate from the process health path.",
    ],
    answer:
      "Registration is a control-plane action, not a liveness property. The tasks may be in the wrong target group, the Auto Scaling group or ECS service may have lost its target-group attachment, a deploy may have registered a new group while the ALB still points at the old one, or the targets may be in an unused state after being stopped. I would call describe-target-health for the target group the listener actually uses, compare the target IDs with the running tasks, and check the service events and Auto Scaling attachment. The CPU is idle because no request reaches the tasks.",
    followUps: [
      "How would you detect this before users see 503s?",
      "What is the difference between an unused target and an unhealthy target?",
      "Which metric would you alert on for this failure?",
    ],
    redFlags: [
      "Restarts the tasks without checking registration.",
      "Assumes a running process must be in service.",
      "Changes health-check thresholds first.",
    ],
    rubric: [
      "Separates registration from liveness.",
      "Names the correct target group.",
      "Uses describe-target-health or service events.",
      "Explains the idle CPU.",
    ],
  },
  {
    id: "target-shedding",
    question:
      "A target returns 503 at 40% CPU while its health check passes. Do you add CPU, add targets, or raise concurrency?",
    difficulty: 3,
    hints: [
      "The health check and the saturated path are different code paths.",
      "Concurrency times service time gives capacity.",
    ],
    answer:
      "I would add CPU last. The target is likely out of worker, connection, or pool slots while the accepted requests wait, so CPU is not the binding resource. I would compare in-flight requests with the configured limit and check downstream wait and error rate. Adding targets is the safest first move if the downstream has headroom because it adds concurrency without changing per-target behavior. Raising concurrency is faster but can overload the downstream. If neither is safe, I would shed low-priority load. The health check passes because it does not use the saturated path.",
    followUps: [
      "How do you calculate the target's request capacity from concurrency and service time?",
      "What signal tells you the bottleneck moved downstream?",
      "How would retries change the recovery plan?",
    ],
    redFlags: [
      "Adds CPU without checking concurrency or pool wait.",
      "Raises concurrency without a downstream limit.",
      "Treats a passing health check as proof of request-path capacity.",
    ],
    rubric: [
      "Identifies concurrency or pool exhaustion.",
      "Uses Little's Law reasoning.",
      "Weighs adding targets against raising concurrency.",
      "Names a downstream check and a load-shedding fallback.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Dashboards separate HTTPCode_ELB_503_Count from HTTPCode_Target_5XX_Count.",
      "Alerts cover zero registered targets and zero healthy targets, not only error rate.",
      "Target concurrency, connection-pool size, and downstream limits are documented.",
      "Access logging is enabled and includes elb_status_code and target_status_code.",
      "The on-call runbook names the Auto Scaling and ECS registration paths.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Split ELB 503 from target 5xx before changing CPU or instance size.",
      "Check registration, unused state, and the target group used by the listener.",
      "Compare in-flight requests with the concurrency or pool limit on target-generated 503s.",
      "Check downstream wait and error rate before raising concurrency.",
      "Bound retries so rejected requests do not amplify the next attempt.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify 503 rate, ELB and target counts, CPU, in-flight requests, and downstream latency at peak.",
      "Add a synthetic check for registration, not only process liveness.",
      "Record whether the fix added capacity, raised a limit, or shed load, and why.",
      "Load-test the target-limit case so the next capacity review uses measured concurrency.",
    ],
  },
];

const references = [
  {
    title: "How do I troubleshoot 503 Service Unavailable errors from my Application Load Balancer?",
    url: "https://repost.aws/knowledge-center/alb-troubleshoot-503-errors",
    publisher: "AWS re:Post",
    kind: "docs" as const,
    note: "ELB versus target 503, registration and unused targets, cross-zone behavior, and the current fail-open guidance.",
  },
  {
    title: "Troubleshoot your Application Load Balancers: HTTP 503",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html#http-503-issues",
    publisher: "AWS",
    kind: "docs" as const,
    note: "The documented ALB-generated 503 conditions and target optimizer rejection case.",
  },
  {
    title: "CloudWatch metrics for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "HTTPCode_ELB_503_Count, HTTPCode_Target_5XX_Count, HealthyHostCount, and related ALB metrics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "503-debug": {
      model: serviceUnavailableModel,
      presets,
      instructions:
        "Start Healthy, then apply All deregistered. Note that CPU is zero and every 503 is ELB-generated. Apply Target limit and compare target 5xx with ELB 503. Finish with Recovery.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. Target count, concurrency, service time, and the 40% CPU-at-full-concurrency ratio are teaching values, not AWS limits or benchmarks. AWS documents the ELB/target 503 split and the registration conditions, not these exact numbers.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-target-groups",
    "traffic-alb-health-checks",
    "traffic-alb-connection-limit",
    "traffic-502-debug",
  ],
};
