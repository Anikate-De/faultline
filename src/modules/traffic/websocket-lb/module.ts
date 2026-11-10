import type { Block, Experiment, InterviewQuestion, Module } from "@/content/types";
import type { Params, SimFrame, SimModel, SimPreset, ThresholdSpec } from "@/simulation/engine/types";
import { clamp, edge, metric, pushEvent } from "@/simulation/engine/frame";
import { meta } from "./meta";

const DEPLOY_SHARE_PER_MIN = 0.02;
const GRACEFUL_DRAIN_S = 30;

const params = [
  {
    id: "connectedClients",
    label: "Connected clients",
    min: 1_000,
    max: 100_000,
    step: 1_000,
    value: 20_000,
    unit: " clients",
    group: "Traffic",
    help: "Concurrent WebSocket clients. Each one holds a long-lived connection after the upgrade.",
    format: "count" as const,
  },
  {
    id: "messageInterval",
    label: "Client message interval",
    min: 5,
    max: 120,
    step: 5,
    value: 30,
    unit: " s",
    group: "Traffic",
    help: "Average time between application messages from one client. A silent connection can still be idle from the load balancer's point of view.",
    format: "number" as const,
  },
  {
    id: "heartbeatInterval",
    label: "Heartbeat interval (0 off)",
    min: 0,
    max: 60,
    step: 5,
    value: 20,
    unit: " s",
    group: "Keep-alive",
    help: "Ping or application heartbeat cadence. Any frame resets the idle timer; zero means no keepalive traffic.",
    format: "number" as const,
  },
  {
    id: "albIdleTimeout",
    label: "Load balancer idle timeout",
    min: 10,
    max: 300,
    step: 10,
    value: 120,
    unit: " s",
    group: "Timeouts",
    help: "How long the load balancer allows a connection with no data in either direction. AWS documents a 60-second ALB default.",
    format: "number" as const,
  },
  {
    id: "drainWindow",
    label: "Deregistration drain window",
    min: 0,
    max: 120,
    step: 5,
    value: 60,
    unit: " s",
    group: "Deploy",
    help: "Time a deregistered target keeps serving before connections are closed. AWS documents a 300-second default deregistration delay for target groups.",
    format: "number" as const,
  },
];

function num(p: Params, id: string, fallback: number): number {
  const value = p[id];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

interface Computed {
  clients: number;
  messageInterval: number;
  heartbeat: number;
  idleTimeout: number;
  drainWindow: number;
  effectiveGap: number;
  idleDisconnects: number;
  drainDisconnects: number;
  failedReconnects: number;
  disconnects: number;
  reconnectsPerSecond: number;
  messagesPerSecond: number;
}

function compute(p: Params): Computed {
  const clients = Math.max(1, num(p, "connectedClients", 20_000));
  const messageInterval = Math.max(1, num(p, "messageInterval", 30));
  const heartbeat = Math.max(0, num(p, "heartbeatInterval", 20));
  const idleTimeout = Math.max(1, num(p, "albIdleTimeout", 120));
  const drainWindow = Math.max(0, num(p, "drainWindow", 60));

  const effectiveGap = heartbeat > 0 ? Math.min(messageInterval, heartbeat) : messageInterval;
  const idleCloses =
    effectiveGap >= idleTimeout
      ? Math.max(1, Math.floor((effectiveGap - 1e-9) / idleTimeout))
      : 0;
  const idleDisconnects = effectiveGap > 0 ? (clients * 60 * idleCloses) / effectiveGap : 0;
  const drainDisconnects = clients * DEPLOY_SHARE_PER_MIN;
  const failedReconnects =
    drainDisconnects * Math.max(0, 1 - Math.min(1, drainWindow / GRACEFUL_DRAIN_S));
  const disconnects = idleDisconnects + drainDisconnects;
  const reconnectsPerSecond = disconnects / 60;
  const messagesPerSecond =
    clients / messageInterval + (heartbeat > 0 ? clients / heartbeat : 0);

  return {
    clients,
    messageInterval,
    heartbeat,
    idleTimeout,
    drainWindow,
    effectiveGap,
    idleDisconnects,
    drainDisconnects,
    failedReconnects,
    disconnects,
    reconnectsPerSecond,
    messagesPerSecond,
  };
}

function healthFor(value: number, warn: number, crit: number): "ok" | "warn" | "crit" {
  return value >= crit ? "crit" : value >= warn ? "warn" : "ok";
}

function buildFrame(p: Params, seed: number): SimFrame {
  const d = compute(p);
  const clientHealth =
    d.idleDisconnects >= 5_000 || d.failedReconnects >= 500
      ? "crit"
      : d.failedReconnects >= 100
        ? "warn"
        : "ok";
  const albHealth = healthFor(d.disconnects, 5_000, 20_000);
  const targetHealth = healthFor(d.reconnectsPerSecond, 100, 500);

  const frame: SimFrame = {
    t: 0,
    nodes: [
      {
        id: "client",
        label: "WebSocket clients",
        kind: "client",
        health: clientHealth,
        sublabel: `${Math.round(d.clients).toLocaleString()} connections`,
        detail: `After the HTTP Upgrade and a 101 response, the connection carries framed messages. A client that sends every ${d.messageInterval.toFixed(0)}s and heartbeats every ${d.heartbeat > 0 ? d.heartbeat.toFixed(0) : "never"}s has an effective idle gap of ${d.effectiveGap.toFixed(0)}s.`,
        meta: { view: "flow" },
      },
      {
        id: "alb",
        label: "Application Load Balancer",
        kind: "lb",
        health: albHealth,
        utilization: clamp(d.disconnects / 50_000),
        sublabel: `idle ${d.idleTimeout}s · drain ${d.drainWindow}s`,
        detail: `The load balancer keeps a WebSocket on one target after the upgrade. It closes the connection when no data crosses in either direction for ${d.idleTimeout}s, even if the application considers the session active.`,
        meta: { view: "flow" },
      },
      {
        id: "targets",
        label: "Target fleet",
        kind: "service",
        health: targetHealth,
        utilization: clamp(d.reconnectsPerSecond / 1_000),
        sublabel: `${Math.round(d.reconnectsPerSecond).toLocaleString()} reconnects/s`,
        detail: `A rolling deploy deregisters targets. Connections are closed when the drain window expires, so clients must reconnect and resubscribe. A window shorter than the reconnect budget produces failed reconnects.`,
        meta: { view: "flow" },
      },
    ],
    edges: [
      edge("client-alb", "client", "alb", clamp(d.messagesPerSecond / 5_000), clientHealth),
      edge("alb-targets", "alb", "targets", clamp(d.messagesPerSecond / 5_000), targetHealth),
    ],
    metrics: [
      metric("disconnects", "Connection disconnects", d.disconnects, " /min", 5_000, 20_000, "number"),
      metric("idle-disconnects", "Idle-timeout disconnects", d.idleDisconnects, " /min", 1_000, 5_000, "number"),
      metric("failed-reconnects", "Failed reconnects during drain", d.failedReconnects, " /min", 100, 500, "number"),
      metric("reconnects", "Reconnects", d.reconnectsPerSecond, " /s", 100, 500, "rps"),
      metric("effective-gap", "Effective idle gap", d.effectiveGap, " s", undefined, undefined, "number"),
      metric("messages", "Messages and heartbeats", d.messagesPerSecond, " /s", undefined, undefined, "rps"),
    ],
    events: [],
    series: {},
    flags: {
      seed,
      paramsKey: JSON.stringify(p),
      idleTimeout: d.idleTimeout,
      drainWindow: d.drainWindow,
      heartbeat: d.heartbeat,
    },
    summary: `${Math.round(d.disconnects).toLocaleString()} disconnects/min; ${Math.round(d.idleDisconnects).toLocaleString()} from idle timeout; ${Math.round(d.failedReconnects).toLocaleString()} failed reconnects/min; gap ${d.effectiveGap.toFixed(0)}s.`,
  };
  return frame;
}

function seedSeries(frame: SimFrame, seed: number): void {
  for (const item of frame.metrics) {
    const amplitude = item.value * 0.02 + 0.1;
    frame.series[item.id] = Array.from({ length: 24 }, (_, index) =>
      Math.max(0, item.value * (0.98 + 0.04 * Math.sin((index + (seed % 8)) / 2.5)) + Math.sin(index / 2.1) * amplitude),
    );
  }
}

const thresholds: ThresholdSpec[] = [
  {
    id: "disconnects",
    metricId: "disconnects",
    warn: 5_000,
    crit: 20_000,
    title: "The WebSocket fleet is recycling connections",
    cause:
      "Either the load balancer idle timeout is shorter than the time between frames, or a rolling deploy is closing connections faster than clients can reconnect. Both look like disconnects but need different fixes.",
    fix:
      "Separate idle disconnects from deploy disconnects. Add heartbeat traffic below the idle timeout, and size the drain window so clients can reconnect before targets are removed.",
    checkFirst: [
      "Compare the idle timeout with the message and heartbeat interval.",
      "Check whether the disconnects align with a deploy or target deregistration.",
      "Split disconnects by target and by close code.",
    ],
  },
  {
    id: "idle-disconnects",
    metricId: "idle-disconnects",
    warn: 1_000,
    crit: 5_000,
    title: "The idle timeout is closing sessions that look active",
    cause:
      "The application has a session open, but no frame has crossed the connection within the load balancer idle timeout. An application-level session is not the same as transport activity.",
    fix:
      "Send a ping or heartbeat below the idle timeout, or raise the timeout above the real message gap. Heartbeats are cheaper than reconnecting every client.",
    checkFirst: [
      "Compare the effective idle gap with the load balancer idle timeout.",
      "Check whether ping/pong frames are actually sent and answered.",
      "Check the close code and whether the client or the load balancer initiated it.",
    ],
  },
  {
    id: "failed-reconnects",
    metricId: "failed-reconnects",
    warn: 100,
    crit: 500,
    title: "Draining is cutting connections before clients recover",
    cause:
      "A target is deregistered and the drain window is too short for the client to receive the close, reconnect to another target, and resubscribe. The connection is not gracefully migrated; it is replaced under load.",
    fix:
      "Raise the deregistration delay, send a close frame before removal, and make clients reconnect with jitter and exponential backoff. Move session state out of the target so a reconnect is cheap.",
    checkFirst: [
      "Check the deregistration delay on the target group.",
      "Check client reconnect timing and whether reconnects are synchronized.",
      "Check whether the new target accepts the connection before the old one is removed.",
    ],
  },
  {
    id: "reconnects",
    metricId: "reconnects",
    warn: 100,
    crit: 500,
    title: "Reconnect load is approaching the target's accept capacity",
    cause:
      "Disconnects produce a reconnect and often a resubscribe. When many clients reconnect together, the target fleet sees a burst of TCP accepts, TLS handshakes, and subscription work.",
    fix:
      "Reduce the disconnect source, add jitter to client reconnects, and pre-warm targets before sending reconnects to them. Check file descriptors and accept queue depth as well as CPU.",
    checkFirst: [
      "Check reconnects per second and per target.",
      "Check accept queue and file descriptor usage on the targets.",
      "Check whether reconnects are synchronized by a deploy or a timeout.",
    ],
  },
];

function defaults(overrides: Params = {}): Params {
  return { ...Object.fromEntries(params.map((param) => [param.id, param.value])), ...overrides };
}

export const websocketModel: SimModel = {
  id: "traffic-websocket-lb",
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
    const jitter = rng.between(-0.2, 0.2);
    next.metrics = next.metrics.map((item) =>
      item.id === "reconnects" ? { ...item, value: Math.max(0, item.value + jitter) } : item,
    );
    next.series = {};
    for (const item of next.metrics) {
      const previous = frame.series[item.id] ?? [];
      next.series[item.id] = [...previous, item.value].slice(-120);
    }

    if (d.idleDisconnects > 0 && next.flags.idleWarned !== 1) {
      pushEvent(next, {
        id: "idle-timeout-close",
        at: frame.t,
        severity: d.idleDisconnects >= 5_000 ? "crit" : "warn",
        title: "The load balancer idle timeout is closing WebSockets",
        detail: `Frames arrive every ${d.effectiveGap.toFixed(0)}s but the idle timeout is ${d.idleTimeout.toFixed(0)}s. Each silent connection is closed and must reconnect; ${Math.round(d.idleDisconnects).toLocaleString()} disconnects/min come from this cause.`,
        nodeId: "alb",
        metricId: "idle-disconnects",
      });
      next.flags.idleWarned = 1;
    }
    if (d.idleDisconnects === 0) next.flags.idleWarned = 0;

    if (d.failedReconnects > 0 && next.flags.drainWarned !== 1) {
      pushEvent(next, {
        id: "drain-cut",
        at: frame.t,
        severity: d.failedReconnects >= 500 ? "crit" : "warn",
        title: "Draining is cutting WebSocket connections",
        detail: `The drain window is ${d.drainWindow.toFixed(0)}s against an illustrative ${GRACEFUL_DRAIN_S}s reconnect budget. ${Math.round(d.failedReconnects).toLocaleString()} reconnects/min fail during target replacement.`,
        nodeId: "targets",
        metricId: "failed-reconnects",
      });
      next.flags.drainWarned = 1;
    }
    if (d.failedReconnects === 0) next.flags.drainWarned = 0;

    const previousHeartbeat = Number(frame.flags.heartbeat ?? d.heartbeat);
    if (d.heartbeat !== previousHeartbeat) {
      pushEvent(next, {
        id: "heartbeat-change",
        at: frame.t,
        severity: "info",
        title: d.heartbeat > 0 ? `Heartbeat set to ${d.heartbeat}s` : "Heartbeat disabled",
        detail:
          d.heartbeat > 0
            ? `Application messages every ${d.messageInterval.toFixed(0)}s and heartbeats every ${d.heartbeat.toFixed(0)}s give an effective idle gap of ${d.effectiveGap.toFixed(0)}s.`
            : "No keepalive frames are sent, so the idle gap is the application message interval.",
        nodeId: "client",
        metricId: "effective-gap",
      });
    }

    next.summary = `${Math.round(d.disconnects).toLocaleString()} disconnects/min; ${Math.round(d.idleDisconnects).toLocaleString()} from idle timeout; ${Math.round(d.failedReconnects).toLocaleString()} failed reconnects/min; gap ${d.effectiveGap.toFixed(0)}s.`;
    return next;
  },
  thresholds,
  insights: (_frame, p) => {
    const d = compute(p);
    const items: string[] = [];
    items.push(
      `The effective idle gap is ${d.effectiveGap.toFixed(0)}s against a ${d.idleTimeout.toFixed(0)}s load balancer idle timeout. ${d.idleDisconnects > 0 ? "The timeout closes the connection between frames." : "The connection sees data before the timeout."}`,
    );
    items.push(
      "A WebSocket is pinned to one target after the upgrade. Balancing happens when the connection is established, not per message.",
    );
    items.push(
      d.heartbeat > 0
        ? `Heartbeats add ${Math.round(d.clients / d.heartbeat).toLocaleString()} frames per second across the fleet; that is the cost of keeping idle sessions open.`
        : "With no heartbeat, a quiet client is indistinguishable from a dead one until the timeout closes it.",
    );
    items.push(
      d.failedReconnects > 0
        ? `${Math.round(d.failedReconnects).toLocaleString()} reconnects/min fail because the ${d.drainWindow.toFixed(0)}s drain window is shorter than the illustrative reconnect budget.`
        : "The drain window is long enough for the illustrative reconnect budget, so deregistration does not fail reconnects in this model.",
    );
    items.push(
      "Connection draining closes the connection at the end of the delay; it does not migrate the session. Clients must reconnect and resubscribe.",
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
    description: "Heartbeats sit well below the idle timeout, and draining leaves time to reconnect.",
    tone: "ok",
    params: defaults(),
  },
  {
    id: "peak",
    label: "Peak",
    description: "More clients and a shorter drain window; some reconnects fail during deploys.",
    tone: "warn",
    params: defaults({ connectedClients: 60_000, messageInterval: 60, heartbeatInterval: 45, albIdleTimeout: 60, drainWindow: 20 }),
  },
  {
    id: "failure",
    label: "Silent sockets, short drain",
    description: "Clients send every two minutes with no heartbeat, and the drain window cuts reconnects.",
    tone: "crit",
    params: defaults({ connectedClients: 50_000, messageInterval: 120, heartbeatInterval: 0, albIdleTimeout: 30, drainWindow: 5 }),
  },
  {
    id: "recovery",
    label: "Recovery",
    description: "Heartbeats keep every connection alive and the drain window covers reconnect and resubscribe.",
    tone: "ok",
    params: defaults({ connectedClients: 20_000, messageInterval: 30, heartbeatInterval: 20, albIdleTimeout: 120, drainWindow: 60 }),
  },
];

const experiment: Experiment = {
  id: "predict-idle-websocket",
  title: "Predict why a quiet WebSocket closes",
  simId: "websocket",
  question:
    "Clients send an application message every 90 seconds, there is no heartbeat, and the ALB idle timeout is 60 seconds. What happens?",
  prediction: {
    options: [
      { id: "every-60", label: "The ALB closes each connection after 60 seconds of no data; clients reconnect and repeat." },
      { id: "every-90", label: "Nothing; the next message at 90 seconds resets the timer before any close." },
      { id: "never", label: "WebSockets are exempt from the idle timeout once upgraded." },
      { id: "target", label: "The target closes at 90 seconds because the application session expired." },
    ],
    correctOptionId: "every-60",
    explanation:
      "The idle timeout is about data on the connection, not about whether the application considers the session active. With no frame for 60 seconds, the load balancer closes the WebSocket. A ping or application heartbeat below 60 seconds resets the timer. Raising the idle timeout above 90 seconds also works, but it delays detection of dead peers and holds connection state longer.",
  },
  setup: defaults({ connectedClients: 40_000, messageInterval: 90, heartbeatInterval: 0, albIdleTimeout: 60, drainWindow: 60 }),
  runFor: 20,
  observe: [
    "Idle-timeout disconnects reach about 26,667/min: every client's 90-second gap contains one 60-second timeout.",
    "Reconnects rise to about 458/s, below the 500/s critical line but above the 100/s warning line.",
    "Failed reconnects stay at zero because the drain window is long enough in this setup.",
  ],
  explain:
    "The load balancer cannot tell a quiet client from a dead one, so it applies the idle timeout to the transport. The application's session state does not keep the socket alive. A heartbeat is a small frame that resets the timer and also gives the client a way to detect a dead connection. The heartbeat interval must be below the shortest idle timeout in the path, and the reconnect path must still be designed for the deploy case.",
  fix: defaults({ connectedClients: 40_000, messageInterval: 90, heartbeatInterval: 20, albIdleTimeout: 60, drainWindow: 60 }),
  debrief:
    "With a 20-second heartbeat, the effective idle gap is 20 seconds and the idle timeout never fires. Reconnects fall from about 458/s to about 13/s, all from the illustrative rolling deploy. The tradeoff is continuous heartbeat traffic and more frames to process; the benefit is stable sessions and faster detection of a dead peer. Draining is a separate control and still needs a window long enough for reconnect and resubscribe.",
};

const primer: Block[] = [
  { type: "h2", text: "What it is" },
  {
    type: "p",
    text: "A WebSocket is a long-lived, bidirectional connection between a client and a server. It starts as an HTTP/1.1 request with an Upgrade header and a Sec-WebSocket-Key. If the server accepts, it returns 101 Switching Protocols and the connection stops being HTTP request-response; both sides exchange framed messages until one closes. The Transmission Control Protocol (TCP) connection underneath can stay open for hours, which is the opposite of the short requests a load balancer usually sees.",
  },
  {
    type: "p",
    text: "Two load balancer behaviors matter after the upgrade. First, the idle timeout still applies: if no data crosses the connection within the timeout, the load balancer closes it. A ping or pong frame is data, so a heartbeat resets the timer. Second, the connection is pinned to one target. Balancing happened when the connection was established; a message does not get re-balanced. That makes draining, connection limits, and per-target connection counts different from request-based traffic.",
  },
  { type: "h2", text: "Where it sits" },
  {
    type: "p",
    text: "The path is client, load balancer, target. The load balancer must support the Upgrade handshake and must not buffer the connection as an ordinary request. After the 101 response, it proxies bytes. A content delivery network or reverse proxy in front of the load balancer must also allow the upgrade and must not impose a shorter idle timeout. The effective idle window is the shortest timeout among all proxies in the path, not just the ALB setting.",
  },
  {
    type: "table",
    headers: ["Phase", "What happens", "What to check"],
    rows: [
      ["Upgrade", "HTTP request with Upgrade and Sec-WebSocket-Key; server returns 101", "Proxy supports Upgrade and forwards the headers"],
      ["Steady state", "Framed messages over one TCP connection", "Idle timeout, heartbeat interval, per-target connection count"],
      ["Deploy", "Target deregistered; connections close when the drain window expires", "Deregistration delay, close frame, reconnect jitter"],
      ["Failure", "Target or network disappears; client reconnects", "Reconnect budget, resubscribe cost, stampede control"],
    ],
  },
  {
    type: "p",
    text: "The simulation uses 1,000–100,000 clients, 5–120 second message intervals, 0–60 second heartbeats, and 10–300 second timeouts. The 2% per-minute deploy share and 30-second reconnect budget are illustrative teaching values, not AWS limits. AWS documents a 60-second default ALB idle timeout and a 300-second default deregistration delay for target groups; the sliders are narrower than the service limits so the failure is visible in a short run.",
  },
  { type: "h2", text: "What you'll see" },
  {
    type: "list",
    items: [
      "Idle-timeout disconnects per minute, separate from deploy-driven disconnects.",
      "Failed reconnects when the drain window is shorter than the time clients need to reconnect and resubscribe.",
      "Reconnects per second, the load that the target fleet must accept.",
      "The effective idle gap after combining application messages and heartbeats.",
      "Messages and heartbeats per second, so keepalive cost is visible rather than free.",
    ],
  },
  {
    type: "callout",
    tone: "info",
    title: "How to use the demo",
    body: "Start Healthy, then apply Silent sockets, short drain. Watch idle disconnects and failed reconnects separately. Run the guided experiment before reading its explanation, then add a heartbeat below the idle timeout. Raise the drain window and confirm that deploy reconnects still happen but stop failing.",
  },
  {
    type: "compare",
    leftTitle: "Short HTTP requests",
    rightTitle: "WebSocket connections",
    rows: [
      { label: "Load balancing", left: "Per request", right: "Per connection, once after upgrade" },
      { label: "Idle timeout", left: "Between requests", right: "Between frames in either direction" },
      { label: "Draining", left: "Finish the in-flight request", right: "Close at drain expiry; client must reconnect" },
      { label: "Capacity", left: "Requests per second", right: "Concurrent connections and reconnect rate" },
      { label: "Keepalive", left: "Optional reuse hint", right: "Required if messages are sparse" },
    ],
  },
  { type: "sim", simId: "websocket" },
  { type: "experiment", experimentId: "predict-idle-websocket" },
];

const debrief: Block[] = [
  { type: "h2", text: "What just happened" },
  {
    type: "p",
    text: "Clients sent an application message every two minutes and no heartbeat. The load balancer saw 30 seconds of silence and closed each connection, even though the application still considered the session alive. Every client reconnected about three times per two-minute gap, and the target fleet saw about 1,267 reconnects per second. A short drain window added failed reconnects during target replacement.",
  },
  {
    type: "p",
    text: "Adding a 20-second heartbeat changed the effective idle gap to 20 seconds, below every timeout. Idle disconnects stopped and the reconnect rate fell to the deploy-driven remainder. Raising the drain window let clients reconnect and resubscribe before the old target was removed, so deploy reconnects no longer failed. The tradeoff is continuous heartbeat traffic and longer target removal.",
  },
  { type: "h2", text: "What you'd see in production" },
  {
    type: "list",
    items: [
      "Load balancer: `ActiveConnectionCount`, `NewConnectionCount`, `RejectedConnectionCount`, and target connection errors, split by target group.",
      "Targets: accepted WebSocket connections, close codes, ping/pong handling, and per-target connection count.",
      "Clients: reconnect counts, time to resubscribe, close code, and whether reconnects are synchronized.",
      "Target group: deregistration delay and the time between deregistration and connection close.",
      "File descriptors, accept queue depth, and memory per connection on the target, not only CPU.",
    ],
  },
  {
    type: "callout",
    tone: "warn",
    title: "What to check first",
    body: "Compare the time between frames with the shortest idle timeout in the path. If sessions close while the application says they are active, look for a missing heartbeat. If disconnects cluster around a deploy, look at the deregistration delay and client reconnect behavior.",
  },
  { type: "h2", text: "How to fix it" },
  {
    type: "list",
    ordered: true,
    items: [
      "Confirm that every proxy in the path supports the Upgrade handshake and has a compatible idle timeout.",
      "Send a ping or application heartbeat below the shortest idle timeout.",
      "Make the client reconnect with jitter and exponential backoff, then resubscribe.",
      "Set the deregistration delay long enough for reconnect and resubscribe, and send a close frame before removal.",
      "Move session state out of the target so a reconnect does not depend on the old instance.",
      "Pre-warm new targets and watch accept queue, file descriptors, and reconnect rate together.",
    ],
  },
  { type: "h2", text: "Tradeoffs" },
  {
    type: "list",
    items: [
      "Heartbeats keep sessions alive and detect dead peers, but add frames and wake-ups across the whole fleet.",
      "A longer idle timeout reduces idle closes but holds connection state and delays detection of dead clients.",
      "A longer drain window protects reconnects but slows deploys and keeps old targets around.",
      "Reconnect jitter avoids a synchronized wave but makes recovery less immediate for some clients.",
      "Pinning to one target simplifies the session but concentrates connection count and blast radius.",
    ],
  },
];

const interview: InterviewQuestion[] = [
  {
    id: "debug-websocket-disconnects",
    question:
      "WebSocket clients disconnect every 60 seconds behind the ALB even though the application says the session is active. How do you diagnose it?",
    difficulty: 2,
    hints: [
      "The application session is not the same as transport activity.",
      "Look for frames crossing the connection.",
    ],
    answer:
      "I would compare the time between frames on the connection with the ALB idle timeout. If the client sends an application message every 90 seconds and there is no heartbeat, the ALB sees 60 seconds of silence and closes the socket. I would check the close code and whether the client or the load balancer initiated it, then verify with a ping or heartbeat below the timeout. I would also check every proxy in the path, because the shortest timeout wins. Raising the timeout is a fix, but a heartbeat also detects dead peers.",
    followUps: [
      "What if the client sends every 30 seconds and still disconnects?",
      "How does a CDN in front of the ALB change the diagnosis?",
      "Which metric proves the fix?",
    ],
    redFlags: [
      "Assumes WebSockets are exempt from idle timeouts.",
      "Checks only the target application logs.",
      "Raises every timeout without measuring frames.",
    ],
    rubric: [
      "Compares frame gap with timeout.",
      "Checks close direction.",
      "Names heartbeat or timeout.",
      "Checks every proxy.",
    ],
  },
  {
    id: "drain-websockets",
    question:
      "A rolling deploy causes a WebSocket reconnect wave. What does deregistration delay do, and what does it not do?",
    difficulty: 3,
    hints: [
      "Draining is time, not migration.",
      "Clients still need to reconnect.",
    ],
    answer:
      "Deregistration delay, also called connection draining, keeps a target registered for a configured period after it is deregistered so existing connections can finish. For WebSockets, it delays when the long-lived connections are closed, and the client must still reconnect to another target and resubscribe. It does not migrate the session or preserve in-memory state. If the window is too short, connections are cut before clients recover; if it is too long, deploys take longer and old targets hold capacity. Clients should also jitter reconnects and back off.",
    followUps: [
      "What close code should the target send?",
      "How would you move session state out of the target?",
      "How do you test the drain window before production?",
    ],
    redFlags: [
      "Says draining migrates the WebSocket.",
      "Sets the delay to zero to speed deploys.",
      "Ignores resubscribe cost.",
    ],
    rubric: [
      "Defines deregistration delay.",
      "Separates close from migration.",
      "Names reconnect and resubscribe.",
      "States the tradeoff.",
    ],
  },
  {
    id: "capacity-websockets",
    question:
      "How do you capacity-plan a WebSocket fleet differently from an HTTP API fleet?",
    difficulty: 3,
    hints: [
      "Concurrent connections are the base load.",
      "Reconnects are a burst multiplier.",
    ],
    answer:
      "I would size for concurrent connections, memory per connection, file descriptors, and the reconnect burst, not only requests per second. Each connection holds socket buffers and application state, and a deploy or timeout can make every client reconnect at once. I would measure accept queue depth, TLS handshakes per second, and time to resubscribe. A target that handles high request throughput may still fail at connection accept or memory. I would also leave headroom for one target loss, because its connections must land somewhere.",
    followUps: [
      "Which resource usually runs out first?",
      "How does heartbeat traffic change capacity?",
      "What happens when one target is lost at peak?",
    ],
    redFlags: [
      "Sizes only from requests per second.",
      "Ignores reconnect bursts.",
      "Ignores memory per connection.",
    ],
    rubric: [
      "Names concurrent connections.",
      "Includes reconnect burst.",
      "Checks memory and file descriptors.",
      "Plans for target loss.",
    ],
  },
];

const checklist = [
  {
    title: "Before the incident",
    items: [
      "Every proxy in the WebSocket path supports Upgrade and has a compatible idle timeout.",
      "Heartbeat interval is below the shortest idle timeout.",
      "Deregistration delay covers reconnect and resubscribe with margin.",
      "Clients reconnect with jitter and exponential backoff.",
    ],
  },
  {
    title: "During the incident",
    items: [
      "Compare the frame gap with the idle timeout.",
      "Separate idle closes from deploy closes.",
      "Check close codes and which side initiated the close.",
      "Check accept queue, file descriptors, and reconnect rate at the targets.",
    ],
  },
  {
    title: "After the incident",
    items: [
      "Verify idle disconnects and failed reconnects are both near zero.",
      "Test a rolling deploy with the real reconnect and resubscribe path.",
      "Re-check the shortest timeout after adding a proxy or CDN.",
      "Document the connection-state cost of the chosen timeout.",
    ],
  },
];

const references = [
  {
    title: "Application Load Balancers: WebSockets",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#websockets",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Upgrade support, idle timeout behavior, and long-lived connection handling.",
  },
  {
    title: "RFC 6455: The WebSocket Protocol",
    url: "https://www.rfc-editor.org/rfc/rfc6455",
    publisher: "IETF",
    kind: "standard" as const,
    note: "Opening handshake, 101 response, framing, ping/pong, and close codes.",
  },
  {
    title: "Application Load Balancer target groups: deregistration delay",
    url: "https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-target-groups.html",
    publisher: "AWS",
    kind: "docs" as const,
    note: "Deregistration delay and connection draining behavior for target groups.",
  },
];

export const module: Module = {
  meta,
  primer,
  sims: {
    websocket: {
      model: websocketModel,
      presets,
      instructions:
        "Start healthy, then apply Silent sockets, short drain and compare idle disconnects with failed reconnects. Run the experiment before revealing the answer, then add a heartbeat and raise the drain window.",
      experimentIds: [experiment.id],
      alternateVisuals: ["timeline"],
      note: "Illustrative model. The 2% per-minute deploy share and 30-second reconnect budget are teaching values, not AWS limits. AWS documents a 60-second default ALB idle timeout and a 300-second default deregistration delay.",
    },
  },
  experiments: [experiment],
  debrief,
  interview,
  checklist,
  references,
  related: ["traffic-keepalive-idle-timeout", "traffic-grpc-lb", "traffic-504-debug"],
};
