import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent, recordSeries } from "@/simulation/engine/frame";
import { meta } from "./meta";

const TOTAL_RPS = 20_000;
const TARGET_RPS_CAPACITY = 8_000;
const BASE_P99_MS = 40;
const NO_STICKY_SESSION_MISS = 8;

const params = [
  {
    id: "targetCount",
    label: "Targets",
    min: 2,
    max: 5,
    step: 1,
    value: 4,
    unit: "",
    group: "Topology",
    help: "Targets registered in one ALB target group. Sticky sessions are a target-group setting, so affinity stops at this boundary.",
    format: "count" as const,
  },
  {
    id: "hotSessionShare",
    label: "Sessions on the hottest target",
    min: 10,
    max: 80,
    step: 5,
    value: 30,
    unit: "%",
    group: "Traffic",
    help: "Share of requests bound to the hottest target by its cookie. Stickiness lets this share persist; without affinity, the same total load spreads evenly.",
    format: "percent" as const,
  },
  {
    id: "stickyEnabled",
    label: "Sticky sessions (0 off, 1 on)",
    min: 0,
    max: 1,
    step: 1,
    value: 1,
    unit: "",
    group: "Affinity",
    help: "1 enables target-group stickiness. 0 routes every request independently. The model assumes local session state, so turning affinity off has its own session-miss cost unless sessions are shared.",
    format: "count" as const,
  },
  {
    id: "failedTargets",
    label: "Failed or draining targets",
    min: 0,
    max: 2,
    step: 1,
    value: 0,
    unit: "",
    group: "Failure",
    help: "Targets removed from service at the end of the list. Their sessions move to healthy targets; local state on the removed target is what breaks.",
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
  targetCount: number;
  hotSessionShare: number;
  sticky: boolean;
  failedTargets: number;
  healthyTargets: number;
  loads: number[];
  hotTargetLoad: number;
  averageLoad: number;
  hotTargetUtilization: number;
  maxUtilization: number;
  imbalance: number;
  errorRate: number;
  p99: number;
  affinity: number;
  sessionMisses: number;
  allDown: boolean;
}

function demand(p: Params): Demand {
  const targetCount = Math.max(2, Math.round(num(p, "targetCount", 4)));
  const hotSessionShare = clamp(num(p, "hotSessionShare", 30), 10, 80);
  const sticky = num(p, "stickyEnabled", 1) >= 0.5;
  const failedTargets = Math.min(targetCount, Math.max(0, Math.round(num(p, "failedTargets", 0))));
  const healthyTargets = targetCount - failedTargets;
  const allDown = healthyTargets <= 0;
  const loads = Array.from({ length: targetCount }, () => 0);

  if (!allDown) {
    if (sticky) {
      const hotShare = clamp(hotSessionShare / 100, 0.1, 0.8);
      const hotLoad = TOTAL_RPS * hotShare;
      const otherHealthy = Math.max(1, healthyTargets - 1);
      const otherLoad = (TOTAL_RPS - hotLoad) / otherHealthy;
      loads[0] = hotLoad;
      for (let index = 1; index < healthyTargets; index++) loads[index] = otherLoad;
    } else {
      const even = TOTAL_RPS / healthyTargets;
      for (let index = 0; index < healthyTargets; index++) loads[index] = even;
    }
  }

  const hotTargetLoad = loads[0] ?? 0;
  const averageLoad = healthyTargets > 0 ? TOTAL_RPS / healthyTargets : 0;
  const hotTargetUtilization = (hotTargetLoad / TARGET_RPS_CAPACITY) * 100;
  const maxUtilization = loads.reduce(
    (max, load) => Math.max(max, (load / TARGET_RPS_CAPACITY) * 100),
    0,
  );
  const imbalance = averageLoad > 0 ? Math.max(...loads) / averageLoad : 0;
  const errorRate = allDown
    ? 100
    : Math.min(100, Math.max(0, maxUtilization - 100) * 0.8);
  const p99 = Math.min(
    2_000,
    BASE_P99_MS + Math.max(0, maxUtilization - 80) ** 2 * 1.5 + errorRate * 4,
  );
  const failedSessionShare =
    !allDown && sticky && targetCount > 1
      ? (failedTargets / (targetCount - 1)) * (1 - hotSessionShare / 100) * 100
      : 0;
  const sessionMisses = allDown
    ? 100
    : sticky
      ? Math.min(100, failedSessionShare)
      : NO_STICKY_SESSION_MISS;

  return {
    targetCount,
    hotSessionShare,
    sticky,
    failedTargets,
    healthyTargets,
    loads,
    hotTargetLoad,
    averageLoad,
    hotTargetUtilization,
    maxUtilization,
    imbalance,
    errorRate,
    p99,
    affinity: sticky ? 100 : 0,
    sessionMisses,
    allDown,
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
  const nodes = d.loads.map((load, index) => {
    const failed = index >= d.healthyTargets;
    const utilization = (load / TARGET_RPS_CAPACITY) * 100;
    return {
      id: `target-${index}`,
      label: failed ? `Target ${index + 1} · draining` : `Target ${index + 1}`,
      kind: "service" as const,
      role: "instance" as const,
      health: failed ? (d.allDown ? "crit" : "warn") : healthFor(utilization, 80, 95),
      utilization: failed ? 0 : clamp(utilization / 100),
      throughput: failed ? 0 : load,
      capacity: TARGET_RPS_CAPACITY,
      sublabel: failed
        ? "removed from service · sessions moved"
        : `${formatCount(load)} rps · ${utilization.toFixed(0)}% utilized`,
      detail: failed
        ? "The target is removed from service. The ALB stops sending new requests and updates cookies that pointed here; local session state on this target is no longer reachable."
        : `Carries ${formatCount(load)} rps. ${d.sticky ? "Sticky sessions keep this target's clients on it." : "Requests are distributed independently, so a session can land anywhere."} Illustrative capacity is ${formatCount(TARGET_RPS_CAPACITY)} rps.`,
      meta: {
        view: "flow",
        cpu: failed ? 0 : utilization,
        memory: failed ? 0 : 2 + utilization / 60,
        hot: utilization >= 80 ? 1 : 0,
      },
    };
  });

  return {
    t: 0,
    nodes: [
      {
        id: "alb",
        label: "ALB target group",
        kind: "lb" as const,
        health: healthFor(d.errorRate, 0.5, 2),
        utilization: clamp(d.maxUtilization / 100),
        throughput: TOTAL_RPS,
        sublabel: d.sticky ? "sticky · AWSALB cookie" : "no affinity",
        detail: d.sticky
          ? "The target group binds a client to the target that issued its cookie. Affinity is per target group and does not cross ALBs."
          : "Requests are distributed independently. Local session state is not guaranteed to be present on the chosen target.",
        meta: { view: "flow" },
      },
      ...nodes,
    ],
    edges: [
      edge("alb-target-0", "alb", "target-0", 1, nodes[0]?.health ?? "ok"),
      ...nodes.slice(1).map((node, index) =>
        edge(`alb-target-${index + 1}`, "alb", node.id, 0.5, node.health),
      ),
    ],
    metrics: [
      metric("hot-target-utilization", "Hottest target utilization", d.hotTargetUtilization, "%", 80, 95, "percent"),
      metric("imbalance", "Hottest target vs average", d.imbalance, "×", 1.6, 2.2, "number"),
      metric("session-misses", "Sessions losing local state", d.sessionMisses, "%", 1, 10, "percent"),
      metric("error-rate", "Failed requests", d.errorRate, "%", 0.5, 2, "percent"),
      metric("affinity", "Requests with affinity", d.affinity, "%", undefined, undefined, "percent"),
      metric("p99", "p99 latency", d.p99, "ms", 250, 800, "ms"),
    ],
    events: [],
    series: {},
    flags: { seed, sticky: d.sticky ? 1 : 0, failed: d.failedTargets, targets: d.targetCount, paramsKey: "" },
    summary: `${d.targetCount} targets, ${d.healthyTargets} healthy; hottest at ${d.hotTargetUtilization.toFixed(0)}%; ${d.sessionMisses.toFixed(1)}% sessions lose local state; ${d.errorRate.toFixed(1)}% failed requests; affinity ${d.affinity.toFixed(0)}%.`,
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
  for (const node of frame.nodes) {
    if (node.meta?.cpu === undefined) continue;
    const cpu = Number(node.meta?.cpu ?? 0);
    frame.series[`cpu.${node.id}`] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, cpu * (0.98 + 0.04 * Math.sin((index + (seed % 3)) / 2.1))),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "hot-target-utilization",
    metricId: "hot-target-utilization",
    warn: 80,
    crit: 95,
    title: "Sticky traffic is concentrated on one target",
    cause:
      "Affinity keeps sessions on the target that issued the cookie. If a heavy client group or a popular tenant lands there, the target keeps that load while other targets have room. Stickiness is doing what it was asked to do.",
    fix:
      "Reduce affinity duration where the application can tolerate it, move session state to a shared store so requests can spread, or add targets and let new sessions fill them. Resetting stickiness is a correctness change, not just a load-balancing change.",
    checkFirst: [
      "Compare `RequestCountPerTarget` across the target group; the average hides the hot target.",
      "Check the session or cookie distribution from the client side, including NAT groups.",
      "Check whether a recent scale-in moved sessions onto fewer targets.",
    ],
  },
  {
    id: "imbalance",
    metricId: "imbalance",
    warn: 1.6,
    crit: 2.2,
    title: "The target group is out of balance",
    cause:
      "Sticky sessions preserve the mapping between clients and targets, so an uneven starting distribution stays uneven. A draining target shifts its sessions to the remaining targets and can make the imbalance worse.",
    fix:
      "Add targets to absorb new sessions, shorten the stickiness duration if the application supports it, or externalize session state. Do not disable stickiness without checking that sessions are not stored locally.",
    checkFirst: [
      "Check per-target request count and active connections.",
      "Check the stickiness duration and whether the application uses its own session cookie.",
      "Check whether targets were recently added or removed.",
    ],
  },
  {
    id: "session-misses",
    metricId: "session-misses",
    warn: 1,
    crit: 10,
    title: "Sessions are losing local state",
    cause:
      "A sticky session pointed at a target that is now draining or unhealthy. The ALB routes new requests to a healthy target and updates the cookie, but state stored only on the old target is gone. Without affinity, the same local-state design misses on every request.",
    fix:
      "Move session state to a shared store, or ensure the application can rebuild it. Keep the deregistration delay long enough for in-flight requests, and drain one target at a time. Stickiness does not make local state durable.",
    checkFirst: [
      "Check the target that was drained or failed and the session miss rate at the same time.",
      "Check whether the application stores sessions in memory or in a shared cache or database.",
      "Check the deregistration delay and whether the target was removed before requests finished.",
    ],
  },
  {
    id: "error-rate",
    metricId: "error-rate",
    warn: 0.5,
    crit: 2,
    title: "The hot target is failing requests",
    cause:
      "The hottest target is above its illustrative request capacity. Stickiness keeps sending its sessions there, so the overload persists instead of spreading to idle targets.",
    fix:
      "Move sessions off the hot target by shortening affinity or externalizing state, add targets for new sessions, and reduce the load that made the target hot. Adding targets alone does not move existing stickiness.",
    checkFirst: [
      "Check 5XX and latency on the hot target, not only the target-group total.",
      "Check whether the hot target is also the one with the most sessions.",
      "Check whether a scale-in or drain pushed extra sessions onto it.",
    ],
  },
];

export const stickySessionsModel: SimModel = {
  id: "sticky-sessions",
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
      item.id === "p99" ? { ...item, value: Math.max(0, item.value * (1 + noise)) } : item,
    );
    for (const item of next.metrics) recordSeries(next, item.id, item.value);
    for (const node of next.nodes) {
      if (node.meta?.cpu === undefined) continue;
      recordSeries(next, `cpu.${node.id}`, Number(node.meta?.cpu ?? 0));
    }

    if ((d.sticky ? 1 : 0) !== Number(frame.flags.sticky ?? 1)) {
      pushEvent(next, {
        id: "sticky-toggle",
        at: frame.t,
        severity: "info",
        title: d.sticky ? "Sticky sessions enabled" : "Sticky sessions disabled",
        detail: d.sticky
          ? "The target group now binds a client to the target that issued the cookie. Affinity is preserved; load can concentrate."
          : "Requests are distributed independently. Load spreads, but local session state is no longer guaranteed to be present.",
        nodeId: "target-0",
      });
    }
    if (d.failedTargets > Number(frame.flags.failed ?? 0)) {
      pushEvent(next, {
        id: "target-removed",
        at: frame.t,
        severity: "crit",
        title: `${d.failedTargets} target${d.failedTargets === 1 ? "" : "s"} draining or failed`,
        detail: `Healthy targets: ${d.healthyTargets}. ${d.sessionMisses.toFixed(1)}% of sessions lose local state; the hottest remaining target is at ${d.maxUtilization.toFixed(0)}%.`,
        nodeId: `target-${d.healthyTargets}`,
        metricId: "session-misses",
      });
    }
    if (d.failedTargets === 0 && Number(frame.flags.failed ?? 0) > 0) {
      pushEvent(next, {
        id: "target-recovered",
        at: frame.t,
        severity: "info",
        title: "All targets are serving again",
        detail: "New sessions can land on the recovered targets. Existing cookies may still point at the old targets until the ALB updates them.",
        nodeId: "target-0",
      });
    }
    if (d.maxUtilization >= 95 && frame.flags.hotSaturated !== 1) {
      pushEvent(next, {
        id: "hot-target-saturated",
        at: frame.t,
        severity: "crit",
        title: "The hottest target reached its capacity",
        detail: `The hot target carries ${formatCount(Math.max(...d.loads))} rps at ${d.maxUtilization.toFixed(0)}%. Stickiness keeps its sessions there while other targets have headroom.`,
        nodeId: "target-0",
        metricId: "error-rate",
      });
      next.flags.hotSaturated = 1;
    }
    if (d.maxUtilization < 95) next.flags.hotSaturated = 0;
    next.flags.sticky = d.sticky ? 1 : 0;
    next.flags.failed = d.failedTargets;
    next.flags.targets = d.targetCount;
    next.summary = `${d.targetCount} targets, ${d.healthyTargets} healthy; hottest at ${d.hotTargetUtilization.toFixed(0)}%; ${d.sessionMisses.toFixed(1)}% sessions lose local state; ${d.errorRate.toFixed(1)}% failed requests; affinity ${d.affinity.toFixed(0)}%.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = demand(p);
    const items: string[] = [];
    items.push(
      d.sticky
        ? `Sticky sessions are on. The hottest target carries ${formatCount(d.hotTargetLoad)} rps, ${d.imbalance.toFixed(2)}× the healthy-target average.`
        : `Sticky sessions are off. Load is even at ${formatCount(d.averageLoad)} rps per healthy target, but ${d.sessionMisses.toFixed(0)}% of requests miss local session state.`,
    );
    if (d.failedTargets > 0) {
      items.push(
        `${d.failedTargets} target${d.failedTargets === 1 ? "" : "s"} removed. ${d.sessionMisses.toFixed(1)}% of sessions lost the target that held their state; the ALB sends new requests to healthy targets and updates the cookie.`,
      );
    }
    items.push(
      "The ALB cookie maps a session to a target, not to a durable data store. When the target is unhealthy or draining, the ALB selects a new target and updates the cookie; it cannot move state that lived only on the old target.",
    );
    if (d.hotSessionShare >= 40 && d.sticky) {
      items.push(
        `A ${d.hotSessionShare}% concentration is sustained by affinity. Adding targets does not move existing sessions; only expiry, cookie updates, or a shared store do.`,
      );
    }
    items.push(
      "Sticky sessions are not supported when cross-zone load balancing is disabled on the target group. Check that setting before debugging a cookie that never sticks.",
    );
    return items;
  },
  legend: [
    { label: "Balanced", tone: "ok" },
    { label: "Warm target", tone: "warn" },
    { label: "Hot target", tone: "crit" },
    { label: "Draining or removed", tone: "warn" },
  ],
};

const presets: SimPreset[] = [
  {
    id: "healthy",
    label: "Healthy",
    description: "Four targets, 30% of sessions on the hottest one, all healthy. The hot target is at 75%.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "Five targets with a 35% hot-session share. The hot target enters the warning band.",
    tone: "warn",
    params: defaults({ targetCount: 5, hotSessionShare: 35, stickyEnabled: 1, failedTargets: 0 }),
  },
  {
    id: "failure",
    label: "Hot target",
    description: "Four targets, 50% of sessions on the hottest, and one target removed. The hot target overloads.",
    tone: "crit",
    params: defaults({ targetCount: 4, hotSessionShare: 50, stickyEnabled: 1, failedTargets: 1 }),
  },
  {
    id: "drain",
    label: "Drain",
    description: "Five targets, one draining. Load stays below capacity, but sessions on the drained target lose local state.",
    tone: "crit",
    params: defaults({ targetCount: 5, hotSessionShare: 30, stickyEnabled: 1, failedTargets: 1 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Five targets, a 20% hot-session share, and no failures. Affinity is preserved without concentration.",
    tone: "ok",
    params: defaults({ targetCount: 5, hotSessionShare: 20, stickyEnabled: 1, failedTargets: 0 }),
  },
];

const experiment: Experiment = {
  id: "predict-drain-sessions",
  title: "Predict what a draining target does to sticky sessions",
  simId: "sticky-sessions",
  question:
    "A target in a sticky target group is deregistered during a deploy. What happens to the sessions bound to it?",
  prediction: {
    options: [
      {
        id: "move-and-lose",
        label: "New requests go to healthy targets and the cookie is updated; local state on the drained target is lost",
      },
      { id: "expire", label: "The sessions stay on the target until the cookie expires" },
      { id: "502", label: "Every request to the target returns 502 until it is removed" },
      { id: "block", label: "Sticky sessions prevent the target from draining" },
    ],
    correctOptionId: "move-and-lose",
    explanation:
      "The ALB stops routing new requests to a draining target. If a cookie points at a target that is deregistered or unhealthy, the ALB selects a healthy target and updates the cookie. In-flight requests can finish during the deregistration delay. State that lived only in the old target's memory is not moved, so carts and logins can fail even though the new target is healthy.",
  },
  setup: defaults({ targetCount: 4, hotSessionShare: 50, stickyEnabled: 1, failedTargets: 1 }),
  runFor: 20,
  observe: [
    "The hottest remaining target carries 10,000 rps, about 125% of its illustrative capacity.",
    "About 16.7% of sessions lose local state when the target is removed.",
    "Failed requests reach 20% because the hot target is over capacity.",
    "p99 rises sharply while the drained target itself is no longer serving.",
  ],
  explain:
    "Stickiness preserves a mapping, not the data behind it. The ALB can update the cookie when a target is unhealthy or draining, but the application has to rebuild or share the session. A draining target makes the cost visible: the load moves, but the state does not. That is why session-heavy systems usually move state to a shared store before they rely on horizontal scaling.",
  fix: defaults({ targetCount: 5, hotSessionShare: 20, stickyEnabled: 1, failedTargets: 0 }),
  debrief:
    "With five targets and a 20% hot share, the hottest target is at 50% and no session loses state. The affinity is still useful, but it is no longer carrying the design. The durable fix is a shared session store; the operational fix is to drain one target at a time and wait for in-flight requests.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Sticky sessions, also called session affinity, bind a client to the target that served its first request. An Application Load Balancer (ALB) can use a duration-based cookie such as `AWSALB` or an application-based cookie. The setting lives on the target group. The ALB resets the cookie expiry after every request, and if the cookie points at a target that is unhealthy or deregistered, the ALB chooses a healthy target and updates the cookie.",
  },
  {
    type: "p",
    text: "Affinity is useful when the application keeps session state in the target's memory: a cart, a login context, a wizard. It is a liability when the session distribution is uneven, when targets scale in, or when a target fails. Stickiness deliberately reduces load balancing. A target that receives a large share of sessions keeps that share until sessions expire, the cookie is updated, or the target is removed.",
  },
  {
    type: "p",
    text: "The cookie duration is a tradeoff, not a failover timer. When stickiness is enabled, AWS allows a duration from 1 second to 7 days, and the duration attribute defaults to 1 day. A longer duration keeps affinity stable; a shorter duration lets new requests rebalance sooner. Neither makes local state durable, and neither prevents the ALB from moving a request when the target is unhealthy.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, ALB listener, target group, target. The cookie belongs to the target group. It does not cross ALBs, so a shard change or a second load balancer can look like a lost session. Application-based cookies can be used across layers if each target group uses a distinct cookie name; duration-based `AWSALB` is a single name and is meant for one layer.",
  },
  {
    type: "compare",
    leftTitle: "Sticky target group",
    rightTitle: "Shared session store",
    rows: [
      { label: "Where state lives", left: "In the target's memory", right: "In a cache or database reachable from every target" },
      { label: "Load balance", left: "Affinity can concentrate sessions on one target", right: "Requests spread; state is fetched by session ID" },
      { label: "Scale-in or failure", left: "Sessions on the removed target lose state", right: "Another target reads the same session" },
      { label: "Operational cost", left: "One cookie setting and no new service", right: "A shared store with latency, availability, and consistency to manage" },
    ],
  },
  {
    type: "p",
    text: "Sticky sessions also depend on cross-zone load balancing. If cross-zone is disabled on the target group, stickiness is not supported. That is one of the first settings to check when a cookie appears not to stick.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "One node per target with request load, utilization, and the failed target marked.",
      "Hottest-target utilization and the imbalance against the healthy-target average.",
      "Sessions that lose local state when a target drains or fails.",
      "Failed requests and p99 from the overloaded target.",
      "Controls for target count, hot-session share, stickiness, and failed or draining targets.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Hot target and watch the hottest target overload while the others have room. Apply Drain and watch session misses rise even though load is below capacity. Run the experiment, then apply Recovery and compare the hot-target utilization.",
  },
  {
    type: "table",
    headers: ["Lever", "What it changes", "What it does not change"],
    rows: [
      ["Enable stickiness", "Affinity and local-state hit rate", "The target's capacity or the distribution of sessions"],
      ["Shorten the cookie duration", "How long a client stays on one target", "State already stored on a removed target"],
      ["Add targets", "Room for new sessions", "Existing sessions bound to the hot target"],
      ["Move state to a shared store", "Where a session can be served", "The need for a cookie or a session ID"],
      ["Drain one target at a time", "In-flight request loss during a deploy", "Sessions stored only on the drained target"],
    ],
  },
  { type: "sim", simId: "sticky-sessions" },
  { type: "experiment", experimentId: "predict-drain-sessions" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Sticky sessions kept a large share of clients on one target. When a target was removed, its sessions moved to the remaining targets, but the hot target absorbed more load and went over capacity. The session misses were a separate failure: clients whose state lived only on the removed target lost it even when the request reached a healthy target.",
  },
  {
    type: "p",
    text: "Adding targets and lowering the hot-session share brought the hottest target back under its warning line and removed the session misses. Affinity was still on, but it was no longer the constraint. The durable fix is a shared session store; the operational fix is to drain one target at a time and let in-flight requests finish.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Target group: `RequestCountPerTarget`, `ActiveConnectionCount`, `HealthyHostCount`, and `UnHealthyHostCount` by target.",
      "ALB: `HTTPCode_ELB_5XX_Count`, `TargetResponseTime`, and p99 by target group and target.",
      "Stickiness: `NonStickyRequestCount` and `AppCookieNonStickinessCount`; these show requests that could not use an existing sticky session.",
      "Application: cart loss, re-login rate, and session-store latency. HTTP 200 responses can still hide a lost session.",
      "Deploys: deregistration events, target state changes, and the time each target stopped receiving new requests.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Check the hottest target, not the target-group average. Then check whether sessions live in target memory or a shared store. If a target was recently drained, compare the session miss rate with the drain time. If the cookie never sticks, check cross-zone load balancing and the cookie name.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Identify the hot target and the session or client group bound to it.",
      "Check whether session state is local or shared.",
      "If local, move it to a shared store before changing the routing or scaling model.",
      "If shared, shorten the stickiness duration or disable affinity and let requests spread.",
      "Drain one target at a time and keep the deregistration delay longer than in-flight requests.",
      "Watch session misses, not only 5XX, after the change.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Stickiness is simple and avoids a shared store, but it trades load balance for affinity.",
      "A longer cookie duration keeps sessions stable and keeps a hot target hot.",
      "A shared session store improves balance and failure behavior but adds latency, availability, and consistency concerns.",
      "Disabling stickiness without a shared store converts a concentration problem into a session-miss problem.",
      "Draining one target at a time is slower than a parallel deploy but protects in-flight requests.",
      "Sticky sessions do not cross ALBs or target groups; a shard change can still move a client.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "choose-affinity",
    question:
      "A session-heavy application is losing carts during scale-in. Do you enable stickiness, add targets, or change the session model?",
    difficulty: 3,
    hints: [
      "Stickiness preserves a mapping; it does not preserve the data.",
      "Scale-in removes the target that held the state.",
    ],
    answer:
      "I would separate the two failures. If carts are lost because requests land on a target without the state, the durable fix is a shared session store keyed by a session ID. Stickiness can reduce how often that happens, but it does not survive a target removal. If the application cannot change, I would enable stickiness, drain one target at a time, keep the deregistration delay above the in-flight request time, and add targets so new sessions spread. Adding targets alone does not help sessions already bound to a target that is going away.",
    followUps: [
      "What would you measure to prove the fix worked?",
      "How does the cookie duration change the answer?",
      "What happens to sessions during an AZ failure?",
    ],
    redFlags: [
      "Enables stickiness and calls it durable.",
      "Adds targets without draining.",
      "Disables stickiness without checking where state lives.",
    ],
    rubric: [
      "Separates affinity from state durability.",
      "Names a shared store or a drain plan.",
      "Measures session misses.",
      "Explains the scale-in behavior.",
    ],
  },
  {
    id: "drain-sticky",
    question:
      "A target is deregistered from a sticky target group. Walk through what happens to its sessions and in-flight requests.",
    difficulty: 2,
    hints: [
      "New requests stop; existing connections can finish.",
      "The ALB updates a cookie that points at an unavailable target.",
    ],
    answer:
      "The target enters the draining state. The ALB stops sending new requests to it and keeps existing connections open so in-flight requests can finish during the deregistration delay. If a client presents a cookie that points at the draining or unhealthy target, the ALB selects a healthy target and updates the cookie. State stored only on the old target is not moved, so the next request can miss even though it lands on a healthy target. After the delay, the target is removed.",
    followUps: [
      "What happens if the delay is shorter than the request duration?",
      "How do you avoid losing in-flight requests?",
      "Does the client see a 502 during a graceful drain?",
    ],
    redFlags: [
      "Says the cookie keeps the session on the draining target.",
      "Ignores in-flight requests.",
      "Assumes state moves with the cookie.",
    ],
    rubric: [
      "Names the draining state.",
      "Stops new requests and finishes in-flight ones.",
      "Explains cookie rewrite.",
      "Separates state loss from request failure.",
    ],
  },
  {
    id: "measure-stickiness",
    question:
      "How do you tell whether stickiness is helping or hiding a load-balancing problem?",
    difficulty: 3,
    hints: [
      "Compare per-target load, not the fleet total.",
      "A high affinity rate can coexist with a high session-miss rate.",
    ],
    answer:
      "I would compare per-target request count and utilization, the imbalance against the average, `NonStickyRequestCount`, and the application's session-miss or re-login rate. If affinity is high and one target is much hotter than the others, stickiness is concentrating load. If affinity is high and session misses are also high, clients are being moved and losing local state. If affinity is low and misses are high, the application depends on local state and needs a shared store. The fleet average hides all three cases.",
    followUps: [
      "Which metric would you alert on?",
      "How does a NAT group affect the distribution?",
      "What would make you turn stickiness off?",
    ],
    redFlags: [
      "Looks only at the fleet average.",
      "Treats a 200 response as a successful session.",
      "Ignores per-target metrics.",
    ],
    rubric: [
      "Uses per-target load.",
      "Names NonStickyRequestCount and session misses.",
      "Distinguishes concentration from state loss.",
      "States when to externalize state.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "The session model is documented: local memory, shared store, or stateless.",
      "Stickiness, cookie type, and duration are set deliberately on each target group.",
      "Cross-zone load balancing is enabled if stickiness is required.",
      "Per-target request count, errors, and latency are on the dashboard.",
      "The deploy drains one target at a time with a delay longer than in-flight requests.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Find the hot target and the client or tenant group bound to it.",
      "Check session misses separately from HTTP 5XX.",
      "If a target was drained, check the drain time and the sessions that pointed at it.",
      "Add targets for new sessions; do not expect them to move existing affinity.",
      "Record the stickiness and routing changes with timestamps.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify per-target balance and session miss rate.",
      "Decide whether to shorten affinity or externalize session state.",
      "Test a target drain and a target failure with the real session behavior.",
      "Update the runbook with the cookie name and target-group setting.",
    ],
  },
];

const references = [
  {
    title: "Sticky sessions for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/sticky-sessions.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "AWSALB cookies, duration and application-based stickiness, cookie rewrite, and cross-zone requirements.",
  },
  {
    title: "Edit target group attributes for your Application Load Balancer",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-target-group-attributes.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Stickiness attributes, duration range, deregistration delay, and target group behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    "sticky-sessions": {
      model: stickySessionsModel,
      presets,
      instructions:
        "Start Healthy, then apply Hot target and read the hottest target. Apply Drain and watch session misses rise without overload. Run the experiment, then apply Recovery and compare the hot-target utilization.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The ALB cookie behavior, target-group stickiness, duration range, cookie rewrite on unhealthy or deregistered targets, cross-zone requirement, and deregistration delay are AWS-documented. Target capacity, the 8% no-affinity session-miss estimate, and the drain behavior are teaching values, not AWS quotas or guarantees.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "traffic-alb-health-checks",
    "traffic-connection-draining",
    "traffic-alb-sharding",
  ],
};
