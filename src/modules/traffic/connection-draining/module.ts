import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 20_000;
const REGISTER_AND_HEALTH_SECONDS = 20;

const params = [
  {
    id: "deregistrationDelay",
    label: "Deregistration delay",
    min: 0,
    max: 300,
    step: 5,
    value: 30,
    unit: "s",
    group: "Draining",
    help: "How long the target stays in the draining state before removal. AWS allows 0–3600 seconds; the default is 300. This lab caps the slider at 300.",
    format: "number" as const,
  },
  {
    id: "requestDuration",
    label: "Request duration",
    min: 0.5,
    max: 20,
    step: 0.5,
    value: 2,
    unit: "s",
    group: "Traffic",
    help: "Average time an in-flight request needs to finish. Requests still running when the delay expires are cut.",
    format: "number" as const,
  },
  {
    id: "targetCount",
    label: "Targets in the group",
    min: 2,
    max: 12,
    step: 1,
    value: 6,
    unit: "",
    group: "Rollout",
    help: "Healthy targets in the target group. The deploy removes one batch at a time and keeps the rest serving.",
    format: "count" as const,
  },
  {
    id: "batchSize",
    label: "Targets removed per batch",
    min: 1,
    max: 3,
    step: 1,
    value: 1,
    unit: "",
    group: "Rollout",
    help: "Targets deregistered together. A larger batch finishes the deploy faster but removes more capacity and affects more in-flight requests at once.",
    format: "count" as const,
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
  delay: number;
  duration: number;
  targetCount: number;
  batchSize: number;
  cutFraction: number;
  errorRate: number;
  capacityLoss: number;
  inFlightPerTarget: number;
  cutRequests: number;
  drainCompletion: number;
  rolloutTime: number;
  servedRps: number;
  perTargetRps: number;
}

function demand(p: Params): Demand {
  const delay = clamp(num(p, "deregistrationDelay", 30), 0, 300);
  const duration = Math.max(0.5, num(p, "requestDuration", 2));
  const targetCount = Math.max(2, Math.round(num(p, "targetCount", 6)));
  const batchSize = Math.min(targetCount, Math.max(1, Math.round(num(p, "batchSize", 1))));
  const cutFraction = duration <= delay ? 0 : clamp((duration - delay) / duration, 0, 1);
  const errorRate = clamp(cutFraction * (batchSize / targetCount) * 100, 0, 100);
  const capacityLoss = (batchSize / targetCount) * 100;
  const perTargetRps = TOTAL_RPS / targetCount;
  const inFlightPerTarget = perTargetRps * duration;
  const cutRequests = inFlightPerTarget * cutFraction * batchSize;
  const rolloutTime =
    Math.ceil(targetCount / batchSize) * (delay + REGISTER_AND_HEALTH_SECONDS);

  return {
    delay,
    duration,
    targetCount,
    batchSize,
    cutFraction,
    errorRate,
    capacityLoss,
    inFlightPerTarget,
    cutRequests,
    drainCompletion: 100 - cutFraction * 100,
    rolloutTime,
    servedRps: (TOTAL_RPS * (100 - errorRate)) / 100,
    perTargetRps,
  };
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  if (value >= crit) return "crit";
  if (value >= warn) return "warn";
  return "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = demand(p);
  const clientHealth = healthFor(d.errorRate, 1, 5);
  const albHealth = healthFor(d.errorRate, 1, 5);
  const drainingHealth = healthFor(d.errorRate, 1, 5);
  return {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: TOTAL_RPS,
        sublabel: `${d.errorRate.toFixed(1)}% failed requests`,
        detail: "Clients keep their connections through the deploy. A request fails only when its connection is closed before the response finishes.",
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: albHealth,
        utilization: clamp(d.errorRate / 5),
        throughput: d.servedRps,
        sublabel: `${d.targetCount - d.batchSize} of ${d.targetCount} targets serving`,
        detail: `The ALB stops sending new requests to a deregistered target immediately. In-flight requests get the deregistration delay; then unfinished connections are closed.`,
        meta: { view: "flow" },
      },
      {
        id: "draining",
        label: "Draining target",
        kind: "service",
        health: drainingHealth,
        utilization: clamp(d.cutFraction),
        throughput: 0,
        sublabel: `${d.delay}s delay · ${(d.cutFraction * 100).toFixed(0)}% cut`,
        detail: `${formatCount(d.inFlightPerTarget)} requests are in flight on the target when deregistration starts. With a ${d.delay}s delay and ${d.duration}s requests, ${(d.cutFraction * 100).toFixed(0)}% are still running when the target is removed.`,
        meta: { view: "flow" },
      },
      {
        id: "ready",
        label: "New target",
        kind: "service",
        health: "ok",
        utilization: clamp(d.errorRate / 5 + 0.2),
        throughput: d.targetCount > d.batchSize ? d.servedRps / (d.targetCount - d.batchSize) : 0,
        sublabel: "registered · healthy",
        detail: "The replacement passes its first health check and starts receiving traffic. New capacity does not protect requests already in flight on the draining target.",
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", 1, clientHealth),
      edge("alb-draining", "alb", "draining", clamp(1 - d.cutFraction), drainingHealth),
      edge("alb-ready", "alb", "ready", clamp(d.servedRps / TOTAL_RPS), "ok"),
    ],
    metrics: [
      metric("error-rate", "502 rate", d.errorRate, "%", 1, 5, "percent"),
      metric("capacity-loss", "Capacity removed per batch", d.capacityLoss, "%", 25, 40, "percent"),
      metric("rollout-time", "Rollout time", d.rolloutTime, "s", 400, 900, "number"),
      metric("cut-requests", "Requests cut per rollout", d.cutRequests, "", undefined, undefined, "count"),
      metric("in-flight", "In-flight requests per target", d.inFlightPerTarget, "", undefined, undefined, "count"),
      metric("drain-completion", "Requests completing during drain", d.drainCompletion, "%", undefined, undefined, "percent"),
    ],
    events: [],
    series: {},
    flags: { seed, delay: d.delay, batch: d.batchSize, paramsKey: "" },
    summary: `${d.targetCount} targets, ${d.batchSize} removed per batch; ${d.delay}s delay vs ${d.duration}s requests; ${d.errorRate.toFixed(1)}% 502s; ${formatCount(d.cutRequests)} requests cut per rollout; rollout ${d.rolloutTime.toFixed(0)}s.`,
  };
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = Math.abs(item.value) * 0.015 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(
        0,
        item.value * (0.985 + 0.03 * Math.sin((index + (seed % 5)) / 2.5)) +
          Math.sin(index / 2.0) * amplitude,
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
    title: "Deregistration is cutting in-flight requests",
    cause:
      "The deregistration delay is shorter than the tail of request duration. The load balancer stops sending new requests, waits for the delay, then closes the target's connections while some requests are still running. Clients see 502s even though the replacement targets are healthy.",
    fix:
      "Raise the deregistration delay above the p99 request duration plus margin, or reduce the batch size. For long-lived connections, close them at the application layer or have clients reconnect; connection termination is an NLB target-group feature, not an ALB one. Measure the 502 rate during the next deploy.",
    checkFirst: [
      "Compare `HTTPCode_ELB_502_Count` with the deploy window and the target's deregistration time.",
      "Check request duration p99, not the average, against the deregistration delay.",
      "Check whether the target was removed while requests were still in flight.",
    ],
  },
  {
    id: "capacity-loss",
    metricId: "capacity-loss",
    warn: 25,
    crit: 40,
    title: "The batch removes too much capacity at once",
    cause:
      "Deregistering several targets together removes their share of capacity while the remaining targets absorb the traffic. The deploy is faster, but the remaining fleet can overload and the blast radius of a bad target grows.",
    fix:
      "Reduce the batch size, keep enough headroom for the loss, and let the remaining targets pass health checks before removing the next batch. Draining is a capacity change as well as a connection change.",
    checkFirst: [
      "Compare remaining target capacity with peak demand during the deploy.",
      "Check whether the remaining targets are already near their request or connection limit.",
      "Check whether the deploy removes targets from one Availability Zone at a time.",
    ],
  },
  {
    id: "rollout-time",
    metricId: "rollout-time",
    warn: 400,
    crit: 900,
    title: "Draining is making the rollout too slow",
    cause:
      "A delay longer than request duration adds dead time for every target. With one target at a time, the delay multiplies across the fleet. The default 300 seconds is conservative for short requests.",
    fix:
      "Set the delay from the p99 request duration plus a margin, not from the maximum allowed value. Reduce per-target dead time, close long-lived connections at the application layer or reconnect clients, and batch only within spare capacity.",
    checkFirst: [
      "Measure p99 request duration for the slowest route on the target.",
      "Check the total number of targets and the batch size.",
      "Check whether long-lived connections need an application-level close and client reconnect rather than a longer delay.",
    ],
  },
];

export const connectionDrainingModel: SimModel = {
  id: "connection-draining",
  visual: "flow",
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
      item.id === "in-flight" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);

    if (frame.flags.deployStarted !== 1) {
      pushEvent(next, {
        id: "deploy-start",
        at: frame.t,
        severity: "info",
        title: "Rolling deploy started",
        detail: `${d.batchSize} of ${d.targetCount} targets deregistered per batch with a ${d.delay}s deregistration delay. ${formatCount(d.inFlightPerTarget)} requests are in flight per target.`,
        nodeId: "alb",
      });
      next.flags.deployStarted = 1;
    }
    if (d.cutFraction > 0 && frame.flags.drainTooShort !== 1) {
      pushEvent(next, {
        id: "drain-too-short",
        at: frame.t,
        severity: d.cutFraction >= 0.5 ? "crit" : "warn",
        title: "Deregistration delay is shorter than request duration",
        detail: `${d.delay}s delay against ${d.duration}s requests cuts ${(d.cutFraction * 100).toFixed(0)}% of in-flight requests and produces ${d.errorRate.toFixed(1)}% 502s across the fleet.`,
        nodeId: "draining",
        metricId: "error-rate",
      });
      next.flags.drainTooShort = 1;
    }
    if (d.cutFraction === 0) next.flags.drainTooShort = 0;
    if (d.batchSize !== Number(frame.flags.batch ?? 1)) {
      pushEvent(next, {
        id: "batch-change",
        at: frame.t,
        severity: "info",
        title: `Deploy batch changed to ${d.batchSize}`,
        detail: `The batch removes ${d.capacityLoss.toFixed(1)}% of target capacity and affects ${formatCount(d.cutRequests)} in-flight requests per rollout.`,
        nodeId: "alb",
        metricId: "capacity-loss",
      });
    }
    next.flags.delay = d.delay;
    next.flags.batch = d.batchSize;
    next.summary = `${d.targetCount} targets, ${d.batchSize} removed per batch; ${d.delay}s delay vs ${d.duration}s requests; ${d.errorRate.toFixed(1)}% 502s; ${formatCount(d.cutRequests)} requests cut per rollout; rollout ${d.rolloutTime.toFixed(0)}s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      `A ${d.delay}s deregistration delay against ${d.duration}s requests leaves ${(d.cutFraction * 100).toFixed(0)}% of in-flight requests unfinished when the target is removed.`,
    );
    items.push(
      `${formatCount(d.inFlightPerTarget)} requests are in flight per target at removal; ${formatCount(d.cutRequests)} are cut across the batch.`,
    );
    items.push(
      `The batch removes ${d.capacityLoss.toFixed(1)}% of target capacity. The remaining targets must absorb that load during the deploy.`,
    );
    if (d.cutFraction === 0) {
      items.push(
        "The delay covers the request duration. The remaining tradeoff is rollout time: every batch waits the full delay.",
      );
    }
    if (d.delay >= d.duration * 5 && d.duration > 0) {
      items.push(
        "The delay is much longer than the request duration. Most of the drain window is dead time, and the rollout slows without protecting more requests.",
      );
    }
    items.push(
      "The deregistration delay is per target group. A target that fails health checks is removed on the health-check path, not the graceful drain path.",
    );
    return items;
  },
  legend: [
    { label: "Serving", tone: "ok" },
    { label: "Draining", tone: "warn" },
    { label: "Cutting requests", tone: "crit" },
    { label: "Removed", tone: "down" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Six targets, one removed per batch, 30s delay against 2s requests. No requests are cut.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Eight targets with a 3s delay against 3.5s requests. The 502 rate enters the warning band.",
    tone: "warn",
    params: defaults({ deregistrationDelay: 3, requestDuration: 3.5, targetCount: 8, batchSize: 1 }),
  },
  {
    id: "failure",
    label: "Short delay",
    description: "One second of drain against 5s requests. Most in-flight requests are cut during every batch.",
    tone: "crit",
    params: defaults({ deregistrationDelay: 1, requestDuration: 5, targetCount: 6, batchSize: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "30s delay against 3s requests, one target at a time. No 502s, and the rollout completes in 300s.",
    tone: "ok",
    params: defaults({ deregistrationDelay: 30, requestDuration: 3, targetCount: 6, batchSize: 1 }),
  },
];

const experiment: Experiment = {
  id: "predict-zero-drain",
  title: "Predict what a zero-second deregistration delay does",
  simId: "connection-draining",
  question:
    "A team sets the deregistration delay to 0 to speed up deploys. The new targets are healthy. What happens to requests already in flight on the old target?",
  prediction: {
    options: [
      { id: "cut", label: "They are cut when the target is removed, so 502s spike for that target's share" },
      { id: "finish", label: "They finish normally because the ALB waits for active requests" },
      { id: "retry", label: "The ALB retries every request on a healthy target with no client impact" },
      { id: "new-only", label: "Only new connections fail; in-flight requests are unaffected" },
    ],
    correctOptionId: "cut",
    explanation:
      "A zero delay means the target is removed without a draining window. The ALB stops sending new requests, but requests already running on the target lose their connection when it is removed. The 502 rate is limited to that target's share of fleet traffic, which is why one target of six produces about 16.7% errors rather than 100%.",
  },
  setup: defaults({ deregistrationDelay: 0, requestDuration: 5, targetCount: 6, batchSize: 1 }),
  runFor: 20,
  observe: [
    "The draining target completes 0% of its in-flight requests.",
    "About 16,667 requests are cut in the batch, producing a 16.7% fleet 502 rate.",
    "The rollout is faster: 120 seconds for six targets.",
    "The replacement targets are healthy; they cannot rescue requests that were already running elsewhere.",
  ],
  explain:
    "The deregistration delay is a wait, not a retry. It gives in-flight requests time to finish before the target is removed. Setting it to zero removes that time. The load balancer can move new requests to healthy targets, but a request that already started on the old target still needs its connection. If the connection closes first, the client sees a 502.",
  fix: defaults({ deregistrationDelay: 30, requestDuration: 5, targetCount: 6, batchSize: 1 }),
  debrief:
    "With a 30-second delay, every 5-second request finishes and the 502 rate returns to zero. The rollout takes 300 seconds instead of 120. That is the trade: drain time protects in-flight work, and the right value is the p99 request duration plus margin, not the maximum setting and not zero.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Connection draining is the graceful removal of a target. On an Application Load Balancer (ALB), the setting is the deregistration delay on the target group. When a target is deregistered, the ALB stops sending new requests to it immediately. The target enters the draining state, and existing connections get a window to finish. When the delay expires, the target is removed and any unfinished connections are closed.",
  },
  {
    type: "p",
    text: "AWS allows a deregistration delay from 0 to 3600 seconds; the ALB default is 300 seconds. Zero is valid but means no graceful window. The delay is per target group, not per target, so every target removed from that group follows the same rule. The target enters draining, then becomes unused. A target that fails health checks follows the health-check path instead, which is a different failure mode.",
  },
  {
    type: "table",
    headers: ["Setting", "Behavior", "Risk"],
    rows: [
      ["0 seconds", "Target removed immediately; no drain window", "In-flight requests are cut; 502s for that target's share"],
      ["Shorter than request duration", "Some requests finish; the rest are cut", "Intermittent 502s that look like a bad deploy"],
      ["Longer than p99 request duration", "In-flight requests finish; target removed", "Deploy time grows by the delay for every batch"],
      ["300 seconds (default)", "Conservative drain for most HTTP requests", "Slow rollouts for short requests and many targets"],
    ],
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ALB, target group, target. The target group owns the deregistration delay. During a deploy, a target is removed from the group while a replacement registers and passes its first health check. The ALB sends new requests only to healthy, non-draining targets. The old target keeps its existing connections until they finish or the delay expires.",
  },
  {
    type: "compare",
    leftTitle: "Graceful drain",
    rightTitle: "Abrupt removal",
    rows: [
      { label: "New requests", left: "Sent to healthy targets", right: "Sent to healthy targets" },
      { label: "In-flight requests", left: "Allowed to finish within the delay", right: "Connection closed; client sees 502" },
      { label: "Deploy speed", left: "Slower by the delay per batch", right: "Fastest" },
      { label: "User impact", left: "Usually none", right: "Errors proportional to the removed target's share of traffic" },
    ],
  },
  {
    type: "p",
    text: "The delay is not a retry and not a health check. It does not make a failed target healthy, and it does not move a request to another target. It only buys time for the request that is already running. For WebSockets or long-lived streams, a delay alone may not be enough; the application has to close the connection or the client has to reconnect. Connection termination on deregistration is an NLB target-group feature, not an ALB one.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "A draining target and a healthy replacement in the request path.",
      "The 502 rate as a share of fleet traffic, not just the removed target's traffic.",
      "Requests cut per rollout and the share that completes during the drain.",
      "Capacity removed per batch and the total rollout time.",
      "Controls for deregistration delay, request duration, target count, and batch size.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Short delay and watch the 502 rate. Compare the in-flight count with the delay. Run the zero-delay experiment, then apply Recovery. Finally, raise the delay above request duration and watch the 502s disappear while rollout time grows.",
  },
  {
    type: "table",
    headers: ["Symptom", "Likely cause", "First check"],
    rows: [
      ["502s only during deploys", "Deregistration delay shorter than request duration", "Compare p99 request duration with the delay"],
      ["502s on one target, not the fleet", "That target was removed with in-flight requests", "Check target state and deregistration events"],
      ["Deploy takes much longer than expected", "Delay is much larger than request duration", "Compare delay with p99 and count the batches"],
      ["New targets healthy but users still fail", "Old target removal is cutting requests", "Check 502 timing against target removal, not target health"],
    ],
  },
  { type: "sim", simId: "connection-draining" },
  { type: "experiment", experimentId: "predict-zero-drain" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The ALB stopped sending new requests to the target as soon as it was deregistered. The target entered draining, but the delay was shorter than the request duration, so some requests were still running when it was removed. Their connections closed and the clients saw 502s. The replacement target was healthy the whole time, which is why the error looked unrelated to capacity.",
  },
  {
    type: "p",
    text: "The zero-delay experiment made the mechanism visible: every in-flight request on the target was cut, but the fleet error rate was only that target's share of traffic. Raising the delay above the request duration removed the 502s and increased rollout time. The tradeoff is time, not correctness.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "ALB: `HTTPCode_ELB_502_Count` during the deploy window, plus `TargetResponseTime` p99 for the slowest route.",
      "Target health: the target state moves to `draining`, then `unused`; a deregistration event marks the start.",
      "Access logs: 502s from the load balancer with the target's connection closing before the response finished.",
      "Deploy telemetry: batch size, target count, delay, and the time between deregistration and removal.",
      "Capacity: remaining healthy targets and their utilization during the batch, not only after the deploy.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the 502 timestamps with the target's deregistration time, not with the new target's health. Then compare the deregistration delay with the p99 request duration. A healthy replacement and 502s can coexist; the old target is the one that matters.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm the 502s line up with target deregistration, not target health checks or capacity.",
      "Measure p99 request duration for the slowest route on the target.",
      "Set the deregistration delay above that p99 plus a margin.",
      "Drain one target or a small batch at a time, with enough remaining capacity.",
      "For long-lived connections, close them at the application layer or have clients reconnect. Connection termination is an NLB-only target-group setting.",
      "Re-run the deploy and compare the 502 rate and rollout time.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "A longer delay protects in-flight requests but adds dead time to every batch.",
      "A larger batch speeds the rollout but removes more capacity and affects more requests at once.",
      "Zero delay is appropriate only for stateless, short requests or a hard incident response.",
      "A delay longer than the longest request does not make long-lived WebSocket connections graceful; they need an application-level close or client reconnect logic. ALB has no connection-termination setting.",
      "The default 300 seconds is conservative; it is a safe starting point, not a universal target.",
      "Draining protects the old target's requests; it does not protect against a bad new version, which needs a canary or rollback.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-deploy-502",
    question:
      "A rolling deploy produces 502s even though the new tasks are healthy. How do you confirm deregistration is the cause?",
    difficulty: 2,
    hints: [
      "The 502s line up with target removal, not target health.",
      "Compare p99 request duration with the deregistration delay.",
    ],
    answer:
      "I would put the 502 timestamps next to the target deregistration events. If the errors cluster when an old target leaves the group, and the new target is healthy before and after, draining is the likely cause. Then I would compare the deregistration delay with the p99 request duration. If the delay is shorter, requests are still running when the target is removed. I would also check whether the batch removes several targets at once and whether the remaining targets have capacity. I would not start with target health, because a healthy replacement does not protect a request already running on the old target.",
    followUps: [
      "What would make you suspect a target health check instead?",
      "How does a WebSocket change the diagnosis?",
      "Which metric would you alert on during deploys?",
    ],
    redFlags: [
      "Starts by rolling back the new version without checking timing.",
      "Looks only at new-target health.",
      "Assumes a 502 is always a target application error.",
    ],
    rubric: [
      "Correlates 502s with deregistration.",
      "Compares delay with p99 request duration.",
      "Checks batch size and remaining capacity.",
      "Separates draining from health checks.",
    ],
  },
  {
    id: "tune-delay",
    question:
      "How do you choose a deregistration delay? Why is the default 300 seconds not always right?",
    difficulty: 2,
    hints: [
      "The delay is a wait for in-flight requests.",
      "Rollout time grows with the delay and the number of batches.",
    ],
    answer:
      "I would start from the p99 request duration for the slowest route on the target, add a margin for variance, and verify that the value covers normal traffic. The default 300 seconds is conservative for short HTTP requests and can make a large fleet deploy very slowly. I would not set zero unless the workload is stateless and short-lived. For long-lived connections, I would close them at the application layer or make the client reconnect. Connection termination is an NLB target-group feature, not ALB. I would test the value in a canary deploy and measure 502s and total rollout time.",
    followUps: [
      "What if p99 is 2 seconds but one route takes 45 seconds?",
      "How does batch size interact with the delay?",
      "How would you handle long-lived connections on an ALB?",
    ],
    redFlags: [
      "Picks the maximum value for safety.",
      "Picks zero to make deploys fast.",
      "Uses average request duration instead of p99.",
    ],
    rubric: [
      "Starts from p99 plus margin.",
      "Names rollout-time cost.",
      "Handles long-lived connections separately.",
      "Tests the value.",
    ],
  },
  {
    id: "drain-vs-health",
    question:
      "What is the difference between a target in the draining state and a target that fails health checks?",
    difficulty: 2,
    hints: [
      "One is deliberate; the other is a detection outcome.",
      "Both stop new traffic, but the in-flight behavior differs.",
    ],
    answer:
      "A draining target was deliberately deregistered. The load balancer stops sending new requests and keeps existing connections for the deregistration delay, so in-flight requests can finish. A target that fails health checks is considered unhealthy; the load balancer stops sending new requests, and the target may be removed on the health-check path without the graceful drain window. The operational responses differ: a draining target is a deploy event, while an unhealthy target is an application, network, or health-check configuration problem. I would check target state and the timing before assuming capacity.",
    followUps: [
      "Which one produces 502s during a deploy?",
      "How does the load balancer treat established connections on an unhealthy target?",
      "What would you check if both states appear at once?",
    ],
    redFlags: [
      "Treats draining as a failure.",
      "Assumes health-check removal waits for in-flight requests.",
      "Ignores the deploy timeline.",
    ],
    rubric: [
      "Separates deliberate drain from health failure.",
      "Explains in-flight behavior.",
      "Names the different operational response.",
      "Checks target state and timing.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The deregistration delay is set from p99 request duration, not from the default alone.",
      "Deploys drain one target or a small batch at a time.",
      "Remaining targets have capacity for the batch loss.",
      "502 rate and p99 request duration are on the deploy dashboard.",
      "Long-lived connections have an application-level close or client reconnect plan.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Correlate 502s with target deregistration timestamps.",
      "Compare the delay with p99 request duration before changing capacity.",
      "Check whether the batch removed too much capacity at once.",
      "Do not roll back the new version until the old target's removal is ruled out.",
      "Record the delay, batch size, and target count at the time of the deploy.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Set the delay above the slowest route's p99 plus margin.",
      "Test a canary deploy with the real request duration.",
      "Add a deploy-window alert for 502s.",
      "Document the batch size and the capacity headroom it requires.",
    ],
  },
];

const references = [
  {
    title: "Target groups for your Application Load Balancers",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Deregistration, the draining state, and the 0–3600 second deregistration delay with a 300-second default.",
  },
  {
    title: "Edit target group attributes for your Network Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/network/edit-target-group-attributes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "NLB deregistration behavior, the 120-second recommendation, and NLB-only connection termination for long-lived flows.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "connection-draining": {
      model: connectionDrainingModel,
      presets,
      instructions:
        "Start Healthy, then apply Short delay and compare the 502 rate with the in-flight count. Run the zero-delay experiment, then apply Recovery. Raise the delay above request duration and watch rollout time grow.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The draining state, 0–3600 second range, 300-second ALB default, and connection behavior are AWS-documented; the NLB guide recommends at least 120 seconds. The 20,000 rps demand, capacity thresholds, and uniform request-start assumption are teaching values, not AWS quotas or guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-target-groups",
    "traffic-sticky-sessions",
    "containers-draining",
  ],
};
