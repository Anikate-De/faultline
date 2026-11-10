import type { Block, Experiment, InterviewQuestion, Module, Reference } from "@/content/types";
import type { Health, Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TARGETS = 6;
const TARGET_CAPACITY_RPS = 2_000;
const HEALTH_CHECK_TIMEOUT_SECONDS = 5;
const SECOND_WINDOW_GAP_SECONDS = 15;

const params = [
  {
    id: "intervalSeconds",
    label: "Health check interval",
    min: 5,
    max: 60,
    step: 5,
    value: 10,
    unit: "s",
    group: "Timing",
    help: "How often the ALB checks each target. AWS allows 5–300 seconds; this demo uses 5–60 to keep the timeline readable.",
    format: "number" as const,
  },
  {
    id: "unhealthyThreshold",
    label: "Unhealthy threshold",
    min: 2,
    max: 10,
    step: 1,
    value: 2,
    unit: " checks",
    group: "Thresholds",
    help: "Consecutive failed checks before a target is removed from service. AWS allows 2–10; the default is 2.",
    format: "count" as const,
  },
  {
    id: "healthyThreshold",
    label: "Healthy threshold",
    min: 2,
    max: 10,
    step: 1,
    value: 3,
    unit: " checks",
    group: "Thresholds",
    help: "Consecutive successful checks before a target returns to service. AWS allows 2–10; the default is 5.",
    format: "count" as const,
  },
  {
    id: "blipSeconds",
    label: "Failure window",
    min: 0,
    max: 60,
    step: 5,
    value: 0,
    unit: "s",
    group: "Incident",
    help: "Duration of each failure window. The flapping preset models a second window after an illustrative 15-second false recovery.",
    format: "number" as const,
  },
  {
    id: "requestRate",
    label: "Client requests",
    min: 2_000,
    max: 24_000,
    step: 500,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving at the ALB. Six targets have an illustrative capacity of 2,000 rps each.",
    format: "rps" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface State {
  interval: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
  blip: number;
  requestRate: number;
  failedChecks: number;
  unhealthy: boolean;
  healthyTargets: number;
  capacityOut: number;
  errorRate: number;
  detection: number;
  recovery: number;
  flapIndex: number;
  targetUtil: number;
  p99: number;
}

function compute(p: Params): State {
  const interval = Math.max(1, num(p, "intervalSeconds", 10));
  const unhealthyThreshold = Math.min(10, Math.max(2, Math.round(num(p, "unhealthyThreshold", 2))));
  const healthyThreshold = Math.min(10, Math.max(2, Math.round(num(p, "healthyThreshold", 3))));
  const blip = Math.max(0, num(p, "blipSeconds", 0));
  const requestRate = Math.max(1, num(p, "requestRate", 8_000));
  const failedChecks = blip <= 0 ? 0 : Math.floor(blip / interval) + 1;
  const unhealthy = failedChecks >= unhealthyThreshold;
  const healthyTargets = unhealthy ? 0 : TARGETS;
  const capacityOut = unhealthy ? 100 : 0;
  const errorRate = unhealthy ? 100 : 0;
  const detection = (unhealthyThreshold - 1) * interval + HEALTH_CHECK_TIMEOUT_SECONDS;
  const recovery = healthyThreshold * interval;
  const flapIndex =
    unhealthy && detection <= blip && recovery < SECOND_WINDOW_GAP_SECONDS ? 100 : 0;
  const targetUtil =
    healthyTargets > 0 ? clamp((requestRate / (TARGETS * TARGET_CAPACITY_RPS)) * 100, 0, 100) : 0;
  const queueing = targetUtil > 85 ? (targetUtil - 85) * 10 : 0;
  const p99 = Math.min(10_000, 20 + queueing + (unhealthy ? 700 : 0));
  return {
    interval,
    unhealthyThreshold,
    healthyThreshold,
    blip,
    requestRate,
    failedChecks,
    unhealthy,
    healthyTargets,
    capacityOut,
    errorRate,
    detection,
    recovery,
    flapIndex,
    targetUtil,
    p99,
  };
}

function formatSeconds(value: number): string {
  return `${value.toFixed(0)}s`;
}

function buildFrame(p: Params, seed: number): SimFrame {
  const s = compute(p);
  const clientHealth: Health = s.errorRate >= 5 ? "crit" : s.errorRate >= 0.5 ? "warn" : "ok";
  const albHealth: Health =
    s.unhealthy ? "crit" : s.targetUtil >= 95 ? "crit" : s.targetUtil >= 85 ? "warn" : "ok";
  const targetHealth: Health = s.unhealthy ? "crit" : s.targetUtil >= 95 ? "crit" : s.targetUtil >= 85 ? "warn" : "ok";
  const checkDetail = `${s.failedChecks} failed check${s.failedChecks === 1 ? "" : "s"} fit in a ${s.blip.toFixed(0)}s failure window at a ${s.interval.toFixed(0)}s interval. Threshold is ${s.unhealthyThreshold}. Detection takes ${formatSeconds(s.detection)}; recovery takes ${formatSeconds(s.recovery)}.${s.flapIndex >= 100 ? ` A second failure window follows a ${SECOND_WINDOW_GAP_SECONDS}s false recovery; recovery fits inside that gap, so targets can re-enter and fail again.` : ""}`;
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: s.requestRate,
        sublabel: `${s.errorRate.toFixed(0)}% failed`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: albHealth,
        utilization: clamp(s.targetUtil / 100),
        throughput: s.unhealthy ? 0 : s.requestRate,
        sublabel: `${s.healthyTargets}/${TARGETS} healthy`,
        detail: s.unhealthy
          ? "Every target is unhealthy. The ALB fails open and sends traffic to all registered targets anyway."
          : "The ALB routes only to targets that pass their checks.",
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Target group",
        kind: "service",
        health: targetHealth,
        utilization: clamp(s.targetUtil / 100),
        throughput: s.unhealthy ? 0 : s.requestRate,
        sublabel: `${s.healthyTargets}/${TARGETS} in service`,
        detail: checkDetail,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", s.unhealthy ? 0 : 1, clientHealth),
      edge("alb-targets", "alb", "targets", s.healthyTargets / TARGETS, targetHealth),
    ],
    metrics: [
      metric("healthy-targets", "Healthy targets", s.healthyTargets, "", undefined, undefined, "count"),
      metric("capacity-out", "Capacity out of service", s.capacityOut, "%", 1, 100, "percent"),
      metric("error-rate", "Failed requests", s.errorRate, "%", 0.5, 5, "percent"),
      metric("detection-seconds", "Time to detect", s.detection, "s", 30, 60, "number"),
      metric("recovery-seconds", "Time to recover", s.recovery, "s", 45, 90, "number"),
      metric("flap-index", "Flap risk index", s.flapIndex, "", 50, 100, "number"),
      metric("target-utilization", "Target utilization", s.targetUtil, "%", 85, 95, "percent"),
      metric("stall-seconds", "Failure window", s.blip, "s", undefined, undefined, "number"),
      metric("p99", "ALB p99", s.p99, "ms", 500, 2_000, "ms"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      interval: s.interval,
      unhealthyThreshold: s.unhealthyThreshold,
      blip: s.blip,
    },
    summary: `${s.healthyTargets}/${TARGETS} healthy; detection ${formatSeconds(s.detection)}; recovery ${formatSeconds(s.recovery)}; ${s.errorRate.toFixed(0)}% failed requests; flap risk ${s.flapIndex.toFixed(0)}.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) => {
      const value =
        item.value * (0.97 + 0.05 * Math.sin((index + (seed % 7)) / 2.3)) +
        Math.sin(index / 2.1) * amplitude;
      const bounded = item.format === "percent" ? Math.min(100, value) : value;
      return Math.max(0, bounded);
    });
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 5,
    title: "Requests are failing while targets are out of service",
    cause:
      "Every target failed health checks at once, so the ALB has no healthy target. A shared dependency, a bad health-check path, or a security-group change can fail the whole fleet in one interval.",
    fix:
      "Restore the shared dependency or the check configuration. If the application is still serving traffic, the ALB fail-open may mask the outage; fix the health signal before trusting it again.",
    checkFirst: [
      "Compare healthy host count with target health reason codes.",
      "Check whether all targets failed in the same interval, which points to a shared dependency.",
      "Verify the health-check path and port still return the expected success code.",
    ],
  },
  {
    id: "capacity-out",
    metricId: "capacity-out",
    warn: 1,
    crit: 100,
    title: "The target group lost all serving capacity",
    cause:
      "The unhealthy threshold was reached on every target. With a short interval and a low threshold, a stall shorter than the application's recovery time removes the entire fleet.",
    fix:
      "Raise the interval or the unhealthy threshold so a transient stall does not reach the threshold. Keep the check path shallow enough to measure the target, not every downstream dependency.",
    checkFirst: [
      "Compare the stall duration with interval times threshold.",
      "Check whether one dependency is shared by every target.",
      "Review the last deployment or configuration change.",
    ],
  },
  {
    id: "target-utilization",
    metricId: "target-utilization",
    warn: 85,
    crit: 95,
    title: "The surviving fleet is near capacity",
    cause:
      "Targets were removed or traffic increased while the remaining targets still carry the same request rate. Health-check tuning cannot add capacity.",
    fix:
      "Restore healthy targets or reduce the request rate. During a health incident, confirm that fail-open traffic is not overloading the targets that remain.",
    checkFirst: [
      "Compare healthy target count with the request rate.",
      "Check per-target CPU and latency while targets are out of service.",
      "Verify the remaining targets are not receiving fail-open traffic beyond their capacity.",
    ],
  },
  {
    id: "flap-index",
    metricId: "flap-index",
    warn: 50,
    crit: 100,
    title: "Targets are flapping in and out of service",
    cause:
      "A second failure window follows a short false recovery. Detection fits the first window, and recovery fits the gap, so the target is removed, re-added before the dependency is stable, and removed again.",
    fix:
      "Make the detection window longer than each transient failure, or add a readiness signal that stays false until the dependency is actually usable. Do not fix flapping by only lowering the healthy threshold.",
    checkFirst: [
      "Compare detection and recovery with the two failure windows and the gap between them.",
      "Look for repeated healthy/unhealthy transitions in target health history.",
      "Check whether the check endpoint depends on a flaky downstream.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const albHealthChecksModel: SimModel = {
  id: "traffic-alb-health-checks",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const key = JSON.stringify(p);
    const seed = Number(frame.flags.seed ?? 20261110);
    const reset = frame.t <= 0.11 && frame.flags.paramsKey !== key;
    const s = compute(p);
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
    const noise = rng.between(-0.01, 0.01);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    if (s.unhealthy && frame.flags.allRemoved !== 1) {
      pushEvent(next, {
        id: "all-targets-removed",
        at: frame.t,
        severity: "crit",
        title: "Every target was removed by health checks",
        detail: `A ${s.blip.toFixed(0)}s stall produced ${s.failedChecks} consecutive failed checks at a ${s.interval.toFixed(0)}s interval; the threshold is ${s.unhealthyThreshold}. The ALB now fails open.`,
        nodeId: "targets",
        metricId: "capacity-out",
      });
      next.flags.allRemoved = 1;
    } else if (!s.unhealthy) {
      next.flags.allRemoved = 0;
    }
    if (s.flapIndex >= 100 && frame.flags.flapping !== 1) {
      pushEvent(next, {
        id: "target-flapping",
        at: frame.t,
        severity: "crit",
        title: "Targets are flapping in and out of service",
        detail: `Detection (${formatSeconds(s.detection)}) fits the ${s.blip.toFixed(0)}s failure window, and recovery (${formatSeconds(s.recovery)}) fits the ${SECOND_WINDOW_GAP_SECONDS}s false recovery before the second window. The target will be removed, re-added, and removed again.`,
        nodeId: "targets",
        metricId: "flap-index",
      });
      next.flags.flapping = 1;
    } else if (s.flapIndex < 100) {
      next.flags.flapping = 0;
    }
    next.flags.interval = s.interval;
    next.flags.unhealthyThreshold = s.unhealthyThreshold;
    next.flags.blip = s.blip;
    next.summary = `${s.healthyTargets}/${TARGETS} healthy; detection ${formatSeconds(s.detection)}; recovery ${formatSeconds(s.recovery)}; ${s.errorRate.toFixed(0)}% failed requests; flap risk ${s.flapIndex.toFixed(0)}.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const s = compute(p);
    const items: string[] = [];
    items.push(
      `A ${s.blip.toFixed(0)}s failure window fits ${s.failedChecks} failed check${s.failedChecks === 1 ? "" : "s"} at a ${s.interval.toFixed(0)}s interval against a threshold of ${s.unhealthyThreshold}.`,
    );
    items.push(
      `Detection is (threshold - 1) × interval + timeout: ${formatSeconds(s.detection)}. Recovery is healthy threshold × interval: ${formatSeconds(s.recovery)}.`,
    );
    if (s.unhealthy) {
      items.push(
        "Every target is out of service. The ALB fails open, so errors depend on whether the application is actually stalled, not only on health status.",
      );
    }
    if (s.flapIndex >= 100) {
      items.push(
        `A second failure window follows a ${SECOND_WINDOW_GAP_SECONDS}s false recovery. Recovery fits the gap, so the target re-enters service and fails again.`,
      );
    }
    if (s.healthyTargets > 0 && s.targetUtil >= 85) {
      items.push(`Target utilization is ${s.targetUtil.toFixed(0)}%; the fleet has little spare capacity while targets are removed.`);
    }
    items.push("The grace period belongs to the orchestrator (ECS or Auto Scaling), not to the target group.");
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
    label: "Steady checks",
    description: "No stall, ten-second interval, two failures to remove, three successes to restore.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak load",
    description: "All targets healthy and near the capacity warning line with a higher unhealthy threshold.",
    tone: "warn",
    params: defaults({ unhealthyThreshold: 3, requestRate: 11_000 }),
  },
  {
    id: "failure",
    label: "Fast check, slow recovery",
    description: "A 25-second stall with a ten-second interval removes every target; recovery takes 100 seconds.",
    tone: "crit",
    params: defaults({
      intervalSeconds: 10,
      unhealthyThreshold: 2,
      healthyThreshold: 10,
      blipSeconds: 25,
      requestRate: 8_000,
    }),
  },
  {
    id: "flapping",
    label: "Flapping",
    description: "Two 25-second failure windows with a 15-second false recovery; targets re-enter between them and are removed again.",
    tone: "crit",
    params: defaults({
      intervalSeconds: 5,
      unhealthyThreshold: 2,
      healthyThreshold: 2,
      blipSeconds: 25,
      requestRate: 8_000,
    }),
  },
  {
    id: "recovery",
    label: "Tolerant recovery",
    description: "A longer interval and threshold survive the stall; healthy threshold returns targets quickly.",
    tone: "ok",
    params: defaults({
      intervalSeconds: 30,
      unhealthyThreshold: 3,
      healthyThreshold: 2,
      blipSeconds: 25,
      requestRate: 7_000,
    }),
  },
];

const experiment: Experiment = {
  id: "predict-blip-blast-radius",
  title: "Predict the blast radius of a 25-second failure window",
  simId: "alb-health-checks",
  question:
    "Every target shares one slow dependency. The failure window lasts 25 seconds. The health check interval is 5 seconds and the unhealthy threshold is 2. How many targets are removed?",
  prediction: {
    options: [
      { id: "none", label: "None; a 25-second failure window is shorter than the check window." },
      { id: "one", label: "Only the target that happens to be checked first." },
      { id: "all", label: "All six; every target accumulates enough consecutive failures." },
      { id: "half", label: "About half, because checks are staggered across targets." },
    ],
    correctOptionId: "all",
    explanation:
      "Each target is checked independently, but they all depend on the same stalled component. At a 5-second interval, a 25-second stall produces about six consecutive failures per target. The unhealthy threshold is 2, so every target crosses it and is removed. A 30-second interval produces only about one failed check in the same stall, below a threshold of 3.",
  },
  setup: defaults({
    intervalSeconds: 5,
    unhealthyThreshold: 2,
    healthyThreshold: 5,
    blipSeconds: 25,
    requestRate: 8_000,
  }),
  runFor: 10,
  observe: [
    "Healthy targets drop to zero and capacity out of service reaches 100%.",
    "Detection takes 10 seconds; the 25-second failure window is long enough for six failed checks.",
    "The ALB fails open, but the application is stalled, so failed requests reach 100%.",
    "Shortening the healthy threshold would re-add targets between two failure windows, which is how flapping starts.",
  ],
  explain:
    "The check interval is shorter than the stall, so each target accumulates more consecutive failures than the threshold. The shared dependency makes the failures correlated: one stall removes the whole fleet. The fix is to make the detection window longer than the transient event, or to make the readiness signal reflect real serving ability rather than raw dependency reachability.",
  fix: defaults({
    intervalSeconds: 30,
    unhealthyThreshold: 3,
    healthyThreshold: 2,
    blipSeconds: 25,
    requestRate: 8_000,
  }),
  debrief:
    "A 30-second interval yields about one failed check during the 25-second stall, below the threshold of 3, so all six targets stay in service. Detection is slower, which is the tradeoff. If the stall were a real outage, the fleet would keep serving errors for up to 65 seconds before removal.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "An Application Load Balancer (ALB) health check is a periodic request to each registered target. The target group owns the path, port, protocol, success codes, interval, timeout, healthy threshold, and unhealthy threshold. The ALB removes a target after a number of consecutive failed checks and returns it after a number of consecutive successful checks. AWS defaults for instance and IP targets are a 30-second interval, a 5-second timeout, five successes to become healthy, and two failures to become unhealthy.",
  },
  {
    type: "p",
    text: "The check is independent of the user request path. A target can serve users and fail its check, or pass its check and fail real requests. That gap is why a 503, a 502, and an unhealthy host count are different signals. The grace period is also separate: it belongs to the orchestrator, such as an ECS service or an Auto Scaling group, and tells the orchestrator not to act on health failures while a new task is starting. It is not a target group setting.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ALB, target group health check, target. The check runs on a schedule, not per user request. If a dependency shared by every target stalls, all targets can fail in the same interval. When every registered target is unhealthy, the ALB fails open and routes to all of them, so the user impact depends on whether the application is actually broken or only the check is wrong.",
  },
  {
    type: "table",
    headers: ["Setting", "What it controls", "Failure if set wrong"],
    rows: [
      ["Interval", "How often each target is checked", "Too long: slow detection. Too short: more check load and faster removal during a blip" ],
      ["Timeout", "How long one check waits for a response", "Too short: false failures under load. Too long: slow detection" ],
      ["Unhealthy threshold", "Consecutive failures before removal", "Too low: flapping. Too high: traffic reaches a failing target" ],
      ["Healthy threshold", "Consecutive successes before return", "Too high: slow recovery. Too low: re-entry before the app is ready" ],
      ["Grace period", "Orchestrator delay before health actions on a new task", "Too short: new tasks are killed or removed during startup" ],
    ],
  },
  {
    type: "p",
    text: "A useful approximation is detection = (unhealthy threshold − 1) × interval + timeout, and recovery = healthy threshold × interval. The formula is a planning tool, not a guarantee: checks are independent, results last for the interval, and a timeout longer than the interval can overlap. Keep the timeout below the interval unless you have a measured reason not to.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Healthy targets, capacity out of service, and the failed-request rate.",
      "Time to detect and time to recover, calculated from the current settings.",
      "A flap-risk index that rises when detection fits a failure window and recovery fits the false recovery before the second window.",
      "Target utilization, the stall duration, and the ALB p99.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start healthy with no stall. Apply Flapping and watch the target group lose all six targets, then see the flap index across the second failure window. Apply Recovery and compare detection and recovery times. Change only the interval first; explain why it moves both detection and recovery.",
  },
  { type: "sim", simId: "alb-health-checks" },
  { type: "experiment", experimentId: "predict-blip-blast-radius" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "A 25-second failure window hit every target because they shared one dependency. At a 5-second interval, each target accumulated about six failed checks; a threshold of 2 removed all six. The ALB failed open, but the application was stalled, so users still saw errors. In the flapping preset, a 15-second false recovery let a short healthy threshold put targets back in service before the second failure window, so they were removed again.",
  },
  {
    type: "p",
    text: "The recovery preset used a 30-second interval. The same 25-second stall produced about one failed check, below the threshold of 3, so the fleet stayed in service. The cost is slower detection for a real outage. The settings encode a bet about how long a transient event lasts.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "CloudWatch: `HealthyHostCount`, `UnHealthyHostCount`, `UnhealthyRoutingRequestCount`, `RequestCountPerTarget`, and target response time, split by target group and Availability Zone.",
      "Target health: `describe-target-health` shows `healthy`, `unhealthy`, `initial`, `draining`, or `unused`, plus reason codes such as `Target.Timeout` and `Target.ResponseCodeMismatch`.",
      "Health check logs: ALB health check logs can be delivered to Amazon S3 for per-check troubleshooting.",
      "Orchestrator: ECS service events or Auto Scaling activity show whether tasks were replaced because of health checks, and whether the grace period expired too early.",
      "Deployments: a rolling deploy that removes every old target before new targets pass their checks produces a capacity dip that looks like a health-check problem.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the stall duration with interval × threshold before changing anything. If all targets failed together, look for a shared dependency or a shared configuration change. If only new targets fail, look at the orchestrator grace period and startup time.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm whether the application is actually failing or only the health check is failing.",
      "Compute detection and recovery from the current settings and compare them with the incident timeline.",
      "Make the health endpoint answer a cheap readiness question that reflects the target's ability to serve.",
      "Raise the interval or unhealthy threshold so a known transient stall does not cross the threshold.",
      "Lower the healthy threshold or interval so recovery does not strand capacity.",
      "Set the ECS or Auto Scaling grace period longer than the application's real startup time.",
      "During deploys, verify new targets pass checks before old targets are removed.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Fast detection removes bad targets quickly but turns a transient blip into a fleet-wide outage when every target shares the dependency.",
      "Slow detection keeps capacity stable but sends user traffic to a failing target for longer.",
      "A deep health check catches dependency failures but couples the fleet's health to that dependency; a shallow check can keep traffic on a target that cannot serve.",
      "A short healthy threshold recovers capacity quickly but can re-add a target before it is ready, which causes flapping.",
      "The orchestrator grace period protects startup but can delay removal of a genuinely bad new task.",
      "Fail-open keeps traffic flowing when all targets are unhealthy, but it hides the health signal and can overload a failing fleet.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "one-blip-removed-all",
    question:
      "A single slow dependency caused every task to be removed from the target group at once. What settings and design choices produced that?",
    difficulty: 3,
    hints: [
      "Health checks run per target, but the targets share the dependency.",
      "Detection is roughly threshold × interval.",
    ],
    answer:
      "Every target was checking the same dependency, so the failures were correlated rather than independent. If the check interval was 5 seconds and the unhealthy threshold was 2, a 25-second stall produced enough consecutive failures on every target to remove all of them. A deep health check that calls the dependency made the whole fleet fail together. The fix is to make the check reflect the target's ability to serve without turning a downstream blip into a fleet-wide removal, and to set interval and threshold so the detection window is longer than the known transient. The orchestrator grace period matters for new tasks, but it does not protect steady-state targets from a shared dependency.",
    followUps: [
      "How would you measure the right detection window?",
      "What would you change if the dependency is required for every request?",
      "How does fail-open change the user impact?",
    ],
    redFlags: [
      "Only lowers the healthy threshold.",
      "Blaming the ALB for failing targets it was told to check.",
      "Ignores the shared dependency.",
    ],
    rubric: [
      "Explains correlated failures.",
      "Calculates detection time.",
      "Distinguishes health check from real serving ability.",
      "Names the grace period's correct scope.",
    ],
  },
  {
    id: "choose-timing",
    question:
      "How do you choose health-check interval, timeout, unhealthy threshold, and healthy threshold for a service with a 10-second p99 and a 45-second startup?",
    difficulty: 3,
    hints: [
      "Start from detection and recovery objectives.",
      "Startup belongs to the orchestrator.",
    ],
    answer:
      "I would start from the detection objective and the known transient duration. Detection is about (unhealthy threshold − 1) × interval + timeout, and recovery is healthy threshold × interval. I would keep the timeout above the observed p99 with margin but below the interval, and choose an interval and threshold that do not remove the fleet during a normal transient. For a 45-second startup, I would set the ECS or Auto Scaling grace period above 45 seconds so new tasks are not killed before they can pass. I would then test a rolling deploy and a dependency blip, and tune based on the observed false-positive and recovery times.",
    followUps: [
      "What would make you choose a 5-second interval?",
      "How do you avoid overlapping checks when the timeout is long?",
      "Which signal tells you the grace period is too short?",
    ],
    redFlags: [
      "Sets the interval below the timeout without explaining overlap.",
      "Uses the target group as a grace period.",
      "Tunes only for fast detection.",
    ],
    rubric: [
      "Uses the detection and recovery formulas.",
      "Separates timeout from interval.",
      "Places grace at the orchestrator.",
      "Validates with a deploy and a blip.",
    ],
  },
  {
    id: "fail-open-health",
    question:
      "HealthyHostCount is zero but users are not reporting errors. What is happening, and what do you do next?",
    difficulty: 3,
    hints: [
      "The ALB fails open when every target is unhealthy.",
      "A health check can be wrong while user traffic is fine.",
    ],
    answer:
      "When every registered target is unhealthy, the ALB fails open and routes to all of them regardless of health. If the check path, port, or success code is wrong but the user path is fine, traffic continues while the target group reports zero healthy hosts. I would verify the check against the application, fix the check configuration, and confirm healthy host count returns. I would not ignore it: the fleet has no health protection, so a real failure will not remove a target, and deployments or autoscaling decisions based on healthy host count will be wrong.",
    followUps: [
      "How would you distinguish a wrong check from a failing app?",
      "What happens to a rolling deploy while every target is unhealthy?",
      "Would you alert on zero healthy hosts or on unhealthy host count?",
    ],
    redFlags: [
      "Assumes the ALB stops routing.",
      "Ignores the false signal because users are happy.",
      "Changes the app before validating the check.",
    ],
    rubric: [
      "Explains fail-open.",
      "Names a check mismatch.",
      "States the operational risk.",
      "Verifies the fix with healthy host count.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Detection and recovery objectives are written down, not implied by default settings.",
      "The health check uses a cheap readiness endpoint that reflects the target's ability to serve.",
      "The timeout is below the interval, and the check budget is known.",
      "The ECS or Auto Scaling grace period is longer than the application startup time.",
      "Dashboards show healthy and unhealthy host counts by target group and Availability Zone.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Check whether all targets failed together or only new targets failed.",
      "Compare the stall duration with interval × threshold.",
      "Read target health reason codes before changing the check.",
      "Check fail-open behavior and whether user traffic is actually failing.",
      "Record the settings change and the detection time it produces.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Re-run a dependency blip and a rolling deploy with the new settings.",
      "Confirm the fleet survives the known transient without flapping.",
      "Verify recovery time is within the capacity objective.",
      "Document the shared dependency and the health-check design decision.",
    ],
  },
];

const references: Reference[] = [
  {
    title: "Health checks for Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Defaults, ranges, target states, reason codes, and fail-open behavior.",
  },
  {
    title: "Target groups for your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target group health settings and the relationship between health checks and routing.",
  },
  {
    title: "CloudWatch metrics for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-cloudwatch-metrics.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "HealthyHostCount, UnHealthyHostCount, UnhealthyRoutingRequestCount, and target metrics.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "alb-health-checks": {
      model: albHealthChecksModel,
      presets,
      instructions:
        "Start with no stall. Apply Flapping to see every target removed, then Recovery to see the same stall survive. Change the interval and threshold one at a time and read detection, recovery, and flap risk.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The six-target fleet, 2,000 rps per-target capacity, 5-second check timeout, and 15-second false-recovery gap are teaching values. AWS documents the health-check ranges, defaults, and fail-open behavior; the exact timings depend on the application and the check configuration.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-alb-target-groups", "traffic-sticky-sessions", "traffic-connection-draining"],
};
