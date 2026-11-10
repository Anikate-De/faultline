import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent } from "@/simulation/engine/frame";
import { meta } from "./meta";

const CLOSE_RACE_MS = 40;
const BASE_MS = 18;
const HANDSHAKE_MS = 25;
const MAX_REQUESTS_PER_CONNECTION = 12;

const params = [
  {
    id: "requestRate",
    label: "Request rate",
    min: 1_000,
    max: 50_000,
    step: 1_000,
    value: 8_000,
    unit: " rps",
    group: "Traffic",
    help: "Requests per second arriving at the load balancer. Each request may reuse a backend connection or open a new one.",
    format: "rps" as const,
  },
  {
    id: "idleGap",
    label: "Idle gap between requests",
    min: 0.5,
    max: 120,
    step: 0.5,
    value: 2,
    unit: " s",
    group: "Traffic",
    help: "Typical time a backend connection sits idle between requests. A gap longer than a peer's idle timeout cannot be reused.",
    format: "number" as const,
  },
  {
    id: "albIdleTimeout",
    label: "Load balancer idle timeout",
    min: 1,
    max: 300,
    step: 1,
    value: 60,
    unit: " s",
    group: "Timeouts",
    help: "How long the load balancer keeps an idle front-end or back-end connection. AWS documents a 60-second default for ALB.",
    format: "number" as const,
  },
  {
    id: "backendKeepalive",
    label: "Backend keep-alive timeout",
    min: 1,
    max: 300,
    step: 1,
    value: 75,
    unit: " s",
    group: "Timeouts",
    help: "How long the application server keeps an idle connection before closing it. It must outlive the load balancer idle timeout.",
    format: "number" as const,
  },
  {
    id: "targetCount",
    label: "Backend targets",
    min: 2,
    max: 50,
    step: 1,
    value: 10,
    unit: " targets",
    group: "Topology",
    help: "Targets behind the load balancer. Each target maintains its own keep-alive behavior and connection table.",
    format: "count" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  requestRate: number;
  idleGap: number;
  albIdleTimeout: number;
  backendKeepalive: number;
  targets: number;
  backendClosesFirst: boolean;
  backendIdlesOut: boolean;
  reuseWindow: number;
  reuseRequests: number;
  newConnections: number;
  mismatch: number;
  failedPercent: number;
  p99: number;
  targetRps: number;
  newPerTarget: number;
}

function compute(p: Params): Computed {
  const requestRate = Math.max(1, num(p, "requestRate", 8_000));
  const idleGap = Math.max(0.1, num(p, "idleGap", 2));
  const albIdleTimeout = Math.max(1, num(p, "albIdleTimeout", 60));
  const backendKeepalive = Math.max(1, num(p, "backendKeepalive", 75));
  const targets = Math.max(1, Math.round(num(p, "targetCount", 10)));

  const backendClosesFirst = backendKeepalive < albIdleTimeout;
  const reuseWindow = Math.min(albIdleTimeout, backendKeepalive);
  const backendIdlesOut = idleGap >= backendKeepalive;
  const reuseRequests = idleGap >= reuseWindow ? 1 : MAX_REQUESTS_PER_CONNECTION;
  const newConnections = requestRate / reuseRequests;
  const mismatch = Math.max(0, albIdleTimeout - backendKeepalive);
  const failedPercent =
    backendClosesFirst && backendIdlesOut
      ? Math.min(25, (CLOSE_RACE_MS / 1_000 / backendKeepalive) * 100)
      : 0;
  const p99 = BASE_MS + HANDSHAKE_MS / reuseRequests + (failedPercent / 100) * 800;
  const targetRps = requestRate / targets;
  const newPerTarget = newConnections / targets;

  return {
    requestRate,
    idleGap,
    albIdleTimeout,
    backendKeepalive,
    targets,
    backendClosesFirst,
    backendIdlesOut,
    reuseWindow,
    reuseRequests,
    newConnections,
    mismatch,
    failedPercent,
    p99,
    targetRps,
    newPerTarget,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = compute(p);
  const clientHealth = healthFor(d.failedPercent, 0.1, 2);
  const albHealth =
    d.mismatch >= 45 || d.newConnections >= 4_000
      ? "crit"
      : d.mismatch >= 10 || d.newConnections >= 1_000
        ? "warn"
        : "ok";
  const backendHealth = "ok";

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "Clients",
        kind: "client",
        health: clientHealth,
        throughput: d.requestRate,
        sublabel: `${d.failedPercent.toFixed(1)}% requests fail`,
        detail: "A 502 is returned by the load balancer when it cannot get a valid response from the target. The client may retry, which adds load to a connection already racing to close.",
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: albHealth,
        utilization: clamp(d.newConnections / 5_000),
        throughput: d.requestRate,
        sublabel: `idle ${d.albIdleTimeout}s · ${Math.round(d.newConnections).toLocaleString()} new conn/s`,
        detail: `Holds front-end and back-end connections. Backend connections survive for the shorter of the load balancer idle timeout and the target keep-alive. ${d.backendClosesFirst ? "The target closes first, so the load balancer can dispatch onto a closing connection." : "The load balancer closes idle connections before the target does."}`,
        meta: { view: "flow" },
      },
      {
        id: "backend",
        label: "Backend fleet",
        kind: "service",
        health: backendHealth,
        utilization: clamp(d.newPerTarget / 500),
        throughput: d.requestRate,
        sublabel: `keep-alive ${d.backendKeepalive}s · ${Math.round(d.newPerTarget).toLocaleString()} new conn/s per target`,
        detail: `${d.targets} targets. Each target closes an idle connection after its keep-alive timeout. A target that closes first forces a new connection for the next request and creates a small race with the load balancer.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", clamp(d.newConnections / 5_000), clientHealth),
      edge("alb-backend", "alb", "backend", clamp(d.requestRate / 50_000), backendHealth),
    ],
    metrics: [
      metric("failed-requests", "Requests failing with 502", d.failedPercent, "%", 1, 2, "percent"),
      metric("new-connections", "New backend connections", d.newConnections, " conn/s", 1_000, 4_000, "rps"),
      metric("reuse-requests", "Requests per connection", d.reuseRequests, " req", undefined, undefined, "number"),
      metric("timeout-mismatch", "Idle timeout mismatch", d.mismatch, " s", 10, 45, "number"),
      metric("p99", "Request p99", d.p99, "ms", 40, 70, "ms"),
      metric("new-per-target", "New connections per target", d.newPerTarget, " conn/s", 100, 500, "rps"),
      metric("target-rps", "Requests per target", d.targetRps, " rps", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      backendClosesFirst: d.backendClosesFirst ? 1 : 0,
      backendKeepalive: d.backendKeepalive,
      mismatch: d.mismatch,
    },
    summary: `${d.newConnections.toFixed(0)} new backend connections/s; ${d.reuseRequests.toFixed(1)} requests per connection; ${d.failedPercent.toFixed(1)}% 502s; mismatch ${d.mismatch.toFixed(0)}s.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 9)) / 2.3)) + Math.sin(index / 2.2) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "failed-requests",
    metricId: "failed-requests",
    warn: 1,
    crit: 2,
    title: "The load balancer is returning 502s on reused backend connections",
    cause:
      "The backend keep-alive timeout is shorter than the load balancer idle timeout, and the idle gap reaches the backend timer. The target closes an idle connection first, and the load balancer can dispatch a request onto that connection before it learns the connection is gone.",
    fix:
      "Set the backend keep-alive timeout above the load balancer idle timeout. If that is impossible, lower the load balancer idle timeout below the backend value and accept more reconnects.",
    checkFirst: [
      "Compare the target keep-alive timeout with the load balancer idle timeout.",
      "Check whether 502s cluster around connection idle periods.",
      "Check target logs for a connection closed or reset at the same timestamp.",
    ],
  },
  {
    id: "new-connections",
    metricId: "new-connections",
    warn: 1_000,
    crit: 4_000,
    title: "Backend connections are being replaced at request rate",
    cause:
      "Reuse collapsed because the effective connection lifetime is shorter than the idle gap between requests. Every request then pays a new TCP and TLS handshake to the backend.",
    fix:
      "Align timeouts above the idle gap, raise the backend keep-alive, and confirm that the target and load balancer both support reuse. Check for a request or stream cap that retires connections early.",
    checkFirst: [
      "Compute requests per connection from request rate and new connections.",
      "Find the shortest idle timeout in the load balancer to target path.",
      "Check whether a deploy or configuration change altered the target keep-alive.",
    ],
  },
  {
    id: "timeout-mismatch",
    metricId: "timeout-mismatch",
    warn: 10,
    crit: 45,
    title: "Idle timeouts disagree across the load balancer and target",
    cause:
      "The load balancer holds an idle connection longer than the target does. When the request gap reaches the target timer, the difference becomes the window in which the load balancer believes a connection is usable after the target has decided to close it.",
    fix:
      "Make the target keep-alive longer than the load balancer idle timeout, then verify reuse and 502s together. Do not raise only one side without checking the other.",
    checkFirst: [
      "Read both configured timeouts, not their defaults.",
      "Check for a proxy or sidecar between the load balancer and target.",
      "Compare the mismatch with the 502 rate before changing either value.",
    ],
  },
  {
    id: "p99",
    metricId: "p99",
    warn: 40,
    crit: 70,
    title: "Connection churn is showing up in the request tail",
    cause:
      "New backend connections add handshake time and occasional retries. The application work is unchanged, but the tail includes connection setup and 502 retries.",
    fix:
      "Restore reuse and remove the race, then compare p99 with target response time. If the tail persists after reuse returns, look at target capacity instead.",
    checkFirst: [
      "Compare p99 with target response time.",
      "Check new connections per second at the same timestamps.",
      "Check whether retries follow the 502s.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const keepaliveModel: SimModel = {
  id: "traffic-keepalive-idle-timeout",
  visual: "flow",
  params,
  init: ({ seed }) => {
    const frame = buildFrame(defaults(), seed);
    seedSeries(frame, seed);
    return frame;
  },
  step: (frame, p, _dt, rng) => {
    const seed = Number(frame.flags.seed ?? 20261110);
    const d = compute(p);
    const next = buildFrame(p, seed);
    next.flags = { ...frame.flags, ...next.flags };
    next.events = [...frame.events].slice(-60);
    const jitter = rng.between(-0.3, 0.3);
    next.metrics = next.metrics.map((item) =>
      item.id === "p99" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    next.series = {};
    for (const item of next.metrics) {
      const previous = frame.series[item.id] ?? [];
      next.series[item.id] = [...previous, item.value].slice(-120);
    }

    if (d.backendClosesFirst && d.backendIdlesOut && next.flags.mismatchWarned !== 1) {
      pushEvent(next, {
        id: "backend-closes-first",
        at: frame.t,
        severity: "warn",
        title: "The backend closes idle connections before the load balancer",
        detail: `Target keep-alive is ${d.backendKeepalive}s and requests are about ${d.idleGap.toFixed(1)}s apart, so the target timer fires first. The load balancer can reuse a connection the target has already decided to close.`,
        nodeId: "alb",
        metricId: "timeout-mismatch",
      });
      next.flags.mismatchWarned = 1;
    }
    if (!(d.backendClosesFirst && d.backendIdlesOut)) next.flags.mismatchWarned = 0;

    if (d.failedPercent > 0 && next.flags.raceWarned !== 1) {
      pushEvent(next, {
        id: "connection-race-502",
        at: frame.t,
        severity: d.failedPercent >= 2 ? "crit" : "warn",
        title: "Requests are racing a closing backend connection",
        detail: `${d.failedPercent.toFixed(1)}% of requests fail with 502. Reuse is ${d.reuseRequests.toFixed(1)} request(s) per connection, and the target idles out before the load balancer.`,
        nodeId: "backend",
        metricId: "failed-requests",
      });
      next.flags.raceWarned = 1;
    }
    if (d.failedPercent === 0) next.flags.raceWarned = 0;

    const previousBackend = Number(frame.flags.backendKeepalive ?? d.backendKeepalive);
    if (d.backendKeepalive !== previousBackend) {
      pushEvent(next, {
        id: "backend-timeout-change",
        at: frame.t,
        severity: "info",
        title: `Backend keep-alive changed to ${d.backendKeepalive}s`,
        detail: `The load balancer idle timeout is ${d.albIdleTimeout}s. ${d.backendClosesFirst ? "The target now has the shorter timeout." : "The load balancer now has the shorter timeout."}`,
        nodeId: "backend",
        metricId: "timeout-mismatch",
      });
    }

    next.summary = `${d.newConnections.toFixed(0)} new backend connections/s; ${d.reuseRequests.toFixed(1)} requests per connection; ${d.failedPercent.toFixed(1)}% 502s; mismatch ${d.mismatch.toFixed(0)}s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `The shorter idle window is ${d.reuseWindow}s. ${d.idleGap >= d.reuseWindow ? `Requests are about ${d.idleGap.toFixed(1)}s apart, so the connection idles out between requests and is reused once.` : `Requests are about ${d.idleGap.toFixed(1)}s apart, so the idle timer never fires; reuse is capped at ${MAX_REQUESTS_PER_CONNECTION} requests per connection.`}`,
    );
    items.push(
      d.backendClosesFirst
        ? d.backendIdlesOut
          ? `The backend timeout is ${d.mismatch.toFixed(0)}s shorter than the load balancer's, and the gap reaches it, so the target closes first.`
          : `The backend timeout is shorter, but requests arrive before it expires; the idle timer never fires in this model.`
        : "The load balancer closes idle connections first, so the backend is not surprised by a reused connection.",
    );
    items.push(
      d.failedPercent > 0
        ? `${d.failedPercent.toFixed(1)}% of requests return 502. The application may never log them because the request can fail before it reaches the target.`
        : "No 502s in this model because the backend is not closed while the load balancer is reusing it.",
    );
    items.push(
      `New backend connections are ${Math.round(d.newConnections).toLocaleString()} per second, about ${Math.round(d.newPerTarget).toLocaleString()} per target across ${d.targets} targets.`,
    );
    items.push(
      "Raising only the load balancer idle timeout makes the mismatch worse; the target must outlive the load balancer, not the other way around.",
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
    description: "Backend keep-alive is longer than the load balancer idle timeout and connections are reused.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "A shorter backend keep-alive creates a 40-second mismatch and more connection churn.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, idleGap: 2, albIdleTimeout: 60, backendKeepalive: 20 }),
  },
  {
    id: "failure",
    label: "Backend closes first",
    description: "A two-second backend keep-alive with requests every five seconds closes every connection and races the load balancer.",
    tone: "crit",
    params: defaults({ requestRate: 10_000, idleGap: 5, albIdleTimeout: 60, backendKeepalive: 2 }),
  },
  {
    id: "alb-short",
    label: "Short load balancer timeout",
    description: "The load balancer closes first, so the race disappears, but short reuse creates churn.",
    tone: "warn",
    params: defaults({ requestRate: 12_000, idleGap: 3, albIdleTimeout: 15, backendKeepalive: 300 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Backend keep-alive outlives the load balancer idle timeout and the traffic rate is lower.",
    tone: "ok",
    params: defaults({ requestRate: 6_000, idleGap: 1, albIdleTimeout: 60, backendKeepalive: 75 }),
  },
];

const experiment: Experiment = {
  id: "predict-which-timeout",
  title: "Predict which timeout causes the 502 race",
  simId: "keepalive",
  question:
    "The ALB idle timeout is 60 seconds and the backend keep-alive is 2 seconds. Clients send a request every five seconds. New backend connections are near request rate and 2% of requests return 502. What fixes it?",
  prediction: {
    options: [
      { id: "raise-backend", label: "Raise the backend keep-alive above the ALB idle timeout." },
      { id: "raise-alb", label: "Raise the ALB idle timeout above 60 seconds." },
      { id: "add-targets", label: "Add more backend targets to absorb the connection churn." },
      { id: "sticky", label: "Enable sticky sessions so each client keeps its backend." },
    ],
    correctOptionId: "raise-backend",
    explanation:
      "The backend closes an idle connection after 2 seconds. The ALB still believes it can reuse that connection and may dispatch a request as the close completes, which produces a 502. Raising the ALB timeout widens the mismatch. Adding targets spreads load but does not change who closes first. The backend keep-alive must outlive the ALB idle timeout.",
  },
  setup: defaults({ requestRate: 10_000, idleGap: 5, albIdleTimeout: 60, backendKeepalive: 2 }),
  runFor: 20,
  observe: [
    "Requests per connection falls to 1 and new backend connections reach 10,000/s.",
    "The timeout mismatch is 58 seconds and 2% of requests return 502.",
    "The targets are up and serving; the 502 is generated at the load balancer's connection reuse.",
  ],
  explain:
    "Reuse requires a request to arrive before the shorter idle timer fires. Here the gap is five seconds and the backend timeout is two, so the target closes the connection between requests. The load balancer decides whether a connection is usable from its own idle timer, not from the target's. It can dispatch onto a connection the target has already closed. The safe direction is target keep-alive greater than load balancer idle timeout, so the load balancer retires the connection first and never dispatches onto a target-closed socket.",
  fix: defaults({ requestRate: 10_000, idleGap: 5, albIdleTimeout: 60, backendKeepalive: 75 }),
  debrief:
    "The fix restores reuse to the 12-request cap and removes the 502s; new connections fall to about 833/s. The tradeoff is that idle backend connections can now sit for up to the 60-second load balancer timeout, and a target restart still needs draining. The alternative, lowering the ALB timeout below the backend, also removes the race but increases reconnect frequency and handshake load.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "Keep-alive lets a load balancer reuse a Transmission Control Protocol (TCP) connection to a backend for more than one request. The connection stays open while both peers agree it is usable. Each peer has an idle timer: the Application Load Balancer (ALB) has an idle timeout, which AWS documents as 60 seconds by default, and the application server has a keep-alive timeout. The shorter timer closes the connection first.",
  },
  {
    type: "p",
    text: "The direction matters. If the backend closes first and requests are sparse enough for its timer to fire, the load balancer can still believe the connection is reusable and dispatch a request just as the backend closes it. The request fails with a 502 Bad Gateway, and the load balancer opens a new connection for the next request. The result is both errors and churn. If the load balancer closes first, it removes the connection from its pool before the backend does, so the next request opens a new connection deliberately. That is still churn, but it is not a race.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, backend. The load balancer usually has two independent connections: a front-end connection to the client and a back-end connection to the target. This module is about the back-end leg. A proxy, service mesh sidecar, or database pool can add another idle timer in the same leg. The effective reuse window is the shortest timeout among the peers that hold the connection, but the safe ordering is specifically target keep-alive longer than load balancer idle timeout.",
  },
  {
    type: "table",
    headers: ["Setting", "Who closes", "Result"],
    rows: [
      ["Backend keep-alive > load balancer idle timeout", "Load balancer", "Safe reuse; the load balancer retires the connection first"],
      ["Backend keep-alive < load balancer idle timeout", "Backend, if the gap reaches its timer", "Race window; possible 502 on a reused connection"],
      ["Both equal", "Either, near the same instant", "Racy at the boundary; avoid equal values"],
      ["Idle gap at or above the shorter timeout", "Whichever is shorter", "No reuse; every request opens a connection"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 1,000–50,000 requests per second, 0.5–120 second idle gaps, and 1–300 second timeouts. When requests arrive before the shorter timer fires, the idle timers never close the connection; reuse is then bounded by an illustrative 12-request connection cap. The 40ms close-race constant and 25ms handshake cost are also teaching values, not an AWS limit or a benchmark. The model's point is the ordering and the idle gap, not the exact percentages.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Requests per connection, which falls to one when the idle gap reaches the shorter timeout.",
      "New backend connections per second, the churn signal at the load balancer.",
      "Requests failing with 502, which appear only when the backend idles out before the load balancer.",
      "The idle timeout mismatch in seconds and the resulting p99.",
      "New connections per target, so a fleet-wide churn spike is not averaged away.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Backend closes first. Watch reuse fall and 502s appear while target health stays normal. Run the guided experiment before reading the explanation, then raise the backend keep-alive above the ALB timeout. Apply Short load balancer timeout to see the safe but churn-heavy alternative.",
  },
  {
    type: "compare",
    leftTitle: "Backend closes first",
    rightTitle: "Load balancer closes first",
    rows: [
      { label: "Connection owner", left: "Target drops a socket the ALB still trusts", right: "ALB removes the socket before reuse" },
      { label: "Error shape", left: "502 and connection reset", right: "New connection, no failed request" },
      { label: "Reuse", left: "One request per connection once the gap reaches the shorter timer", right: "Bounded by the 12-request cap when the gap is shorter than the timer" },
      { label: "Fix", left: "Raise target keep-alive above ALB timeout", right: "Keep ALB below target, or accept churn" },
    ],
  },
  { type: "sim", simId: "keepalive" },
  { type: "experiment", experimentId: "predict-which-timeout" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "The backend closed idle connections after two seconds while clients sent requests every five seconds. The load balancer still had those connections in its pool and reused them near the close, so 2% of requests returned 502. The targets were healthy and the application work was unchanged. Reuse collapsed to one request per connection, new connections rose to request rate, and the mismatch was 58 seconds.",
  },
  {
    type: "p",
    text: "Raising the backend keep-alive above the load balancer idle timeout kept the target timer from firing between requests. Reuse rose to the 12-request cap, new connections fell to about 833/s, and the 502s stopped. Lowering the load balancer timeout below the backend also removes the race, but it shortens the idle window and increases handshakes, which the Short load balancer timeout preset shows.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer: `NewConnectionCount`, `ActiveConnectionCount`, `TargetConnectionErrorCount`, and `HTTPCode_ELB_502_Count`, split by target group.",
      "Target: accepted connections per second, active connections, keep-alive timeout, and connection resets.",
      "Application logs: 502s may be absent at the target because the request can fail before it is processed; compare load balancer access logs with target logs.",
      "Traces: a failed span may show connection reset or no server span at all for the same request ID.",
      "Deploy history: a target keep-alive change or a new sidecar often introduces the mismatch.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the target keep-alive timeout with the load balancer idle timeout. If the target is shorter, you have a race window. Then compare new connections with request rate to see whether reuse collapsed. Do not start by adding targets.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Read the actual timeout values from the load balancer, target, and any proxy or sidecar.",
      "Set the target keep-alive above the load balancer idle timeout, with enough margin for clock and scheduling differences.",
      "If the target cannot outlive the load balancer, lower the load balancer idle timeout below the target and accept more reconnects.",
      "Check for request or stream caps that retire connections before either timeout.",
      "Verify reuse, new connections, 502s, and p99 together after the change.",      "During a deploy, drain connections before removing a target so the fix does not move the race to the rollout.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Longer backend keep-alive lets sparse requests reuse connections, but holds memory and file descriptors for idle connections.",
      "A longer load balancer idle timeout without a longer backend timeout widens the race window.",
      "A shorter load balancer timeout removes the race but increases handshakes and CPU at the target.",
      "Equal timeouts look tidy but are racy at the boundary; use a margin.",
      "Fixing the timeout does not remove the need to drain connections during a deploy.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "diagnose-502-churn",
    question:
      "The ALB opens almost one backend connection per request, and some requests return 502. Target CPU is low and health checks pass. How do you diagnose it?",
    difficulty: 2,
    hints: [
      "The target closes connections on its own timer.",
      "A 502 can happen before the application sees the request.",
    ],
    answer:
      "I would compare request rate with new backend connections and compute requests per connection. If reuse is near one, I would read the target keep-alive and the ALB idle timeout. A target keep-alive shorter than the ALB idle timeout explains both signals: the target closes idle connections first, the ALB reuses a closing connection and returns 502, and the next request opens a new connection. I would check target resets and whether the 502s cluster after idle periods, then verify by raising the target keep-alive above the ALB timeout. Low target CPU and healthy checks make capacity or health-check failure unlikely.",
    followUps: [
      "What if the timeouts match exactly?",
      "How would a sidecar change the diagnosis?",
      "Which metric would you alert on?",
    ],
    redFlags: [
      "Adds targets before checking timeouts.",
      "Blames target CPU.",
      "Assumes a 502 always means the application returned an error.",
    ],
    rubric: [
      "Compares request and connection rates.",
      "Checks both timeouts.",
      "Explains the race.",
      "Verifies with a change.",
    ],
  },
  {
    id: "timeout-direction",
    question:
      "Should the backend keep-alive be longer or shorter than the load balancer idle timeout? Explain why.",
    difficulty: 3,
    hints: [
      "Who removes a connection from the reusable pool?",
      "A peer that closes without the other knowing creates a race.",
    ],
    answer:
      "The backend keep-alive should be longer than the load balancer idle timeout. The load balancer decides whether a pooled connection is usable from its own timer. If the backend closes first, the load balancer can dispatch a request onto a socket the backend has already closed, producing a 502. If the load balancer closes first, it removes the connection from its pool before reuse, and the next request opens a new connection deliberately. The cost is that idle connections stay on the backend longer, so size file descriptors and memory for that.",
    followUps: [
      "What margin would you leave between the values?",
      "What if the backend cannot be reconfigured?",
      "How does HTTP/2 GOAWAY change the picture?",
    ],
    redFlags: [
      "Says shorter is safer because the backend closes sooner.",
      "Sets both equal.",
      "Ignores the idle connection cost.",
    ],
    rubric: [
      "Chooses backend longer.",
      "Explains the race direction.",
      "Names the cost.",
      "Mentions an alternative.",
    ],
  },
  {
    id: "reuse-metrics",
    question:
      "Which signals prove that connection reuse improved after a timeout change, and which signal can mislead you?",
    difficulty: 3,
    hints: [
      "New connections alone do not prove reuse.",
      "Requests per connection is a ratio.",
    ],
    answer:
      "I would use requests per connection at the target and new backend connections per second at the load balancer, then compare both with request rate. A falling new-connection count at flat traffic is the direct evidence. 502 rate and target connection resets show whether the race is gone. Active connection count alone can mislead because it includes idle connections that are not being reused. Target CPU can also stay low while connections churn. I would verify at peak and after a deploy, not only in steady state.",
    followUps: [
      "Why can active connections rise while reuse improves?",
      "How do you separate client churn from backend churn?",
      "What would you graph on the incident dashboard?",
    ],
    redFlags: [
      "Uses active connections as proof of reuse.",
      "Ignores the 502 rate.",
      "Checks only one side of the path.",
    ],
    rubric: [
      "Names requests per connection.",
      "Compares new connections with request rate.",
      "Includes error signal.",
      "Checks peak and deploy.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Target keep-alive is documented and longer than the load balancer idle timeout.",
      "New backend connections and requests per connection are on the same dashboard.",
      "502s are split from target 5xx and from client errors.",
      "Deploy draining is configured so a rollout does not create the same race.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare request rate with new backend connection rate.",
      "Read both timeout values, including proxies and sidecars.",
      "Check target resets and 502 timing against idle periods.",
      "Avoid adding targets until the connection race is ruled out.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify reuse, 502s, and p99 at peak.",
      "Re-check the timeout ordering after every target or proxy change.",
      "Size backend file descriptors and memory for the longer idle window.",
      "Test a rolling deploy to confirm draining still works.",
    ],
  },
];

const references = [
  {
    title: "Application Load Balancers: connection idle timeout",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#connection-idle-timeout",
    publisher: "AWS",
    kind: "docs" as const,
    note: "ALB idle timeout behavior, the 60-second default, and the target keep-alive interaction.",
  },
  {
    title: "RFC 9112: HTTP/1.1",
    url: "https://www.rfc-editor.org/rfc/rfc9112",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Persistent connections, connection management, and message framing.",
  },
  {
    title: "Application Load Balancer target groups",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Target registration, health checks, and deregistration behavior.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    keepalive: {
      model: keepaliveModel,
      presets,
      instructions:
        "Start healthy, then apply Backend closes first. Compare requests per connection with new connections and 502s, then align the timeouts in Recovery. Apply Short load balancer timeout to see the safe alternative and its churn cost.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 40ms close race, 25ms handshake, 12-request connection cap, and 2% failure at a 2s backend timeout are teaching values, not AWS limits or measured guarantees. ALB default idle timeout is documented separately.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: [
    "foundations-http2-keepalive",
    "traffic-websocket-lb",
    "traffic-upstream-connection-reuse",
  ],
};
